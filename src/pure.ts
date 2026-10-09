/**
 * 纯函数层：时间衰减、RRF 多路融合、BM25 词法相关度、绝对标度展示、多样性并入分数。
 *
 * 约束：不碰 IO、不 import 任何运行时依赖、给定同一输入必然给出同一输出
 * （排序一律带 id 字典序做最终决胜，杜绝 V8 排序实现差异带来的不确定性）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 【纪律（I1.2 第三方设计审计点名，后人不要误改回去）】
 *
 * 「按批内极值归一化」在「查询场能量 / 传播预算」这类**作用对象**上是被允许的：
 * 那类量的语义本来就是「相对本次查询的预算分配」，归一化后比较才有意义。
 *
 * 但在**候选展示分**上它是被禁止的。一旦写成 `disp = raw / max(raw over 本批)`：
 * 无论候选多不相关，本批第一名恒等于 1.0000 —— 实测「今天天气怎么样」这种与库
 * 完全无关的查询，Top1 也照样打 1.0000，展示分彻底丧失绝对含义（第三方实测记录）。
 *
 * 两者作用对象不同，不要互相套用：
 *   - 允许：查询内部的预算 / 能量分配（作用对象 = 查询场本身）；
 *   - 禁止：候选展示分（作用对象 = 候选集合；一除就把无关候选抬成满分）。
 *
 * 展示分只走**固定绝对区间映射**：
 *   disp = clip((raw − SCALE_A) / (SCALE_B − SCALE_A), 0, 1)
 * SCALE_A / SCALE_B 是模块级常数（默认值见下，可用配置覆盖），**绝不随批次变化**。
 * 排序层与展示层解耦：排序用原始分 / 融合秩，展示用绝对映射后的 disp。
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const DAY_MS = 86_400_000

/** 时间衰减：越新越接近 1，越旧越接近 0；未来时间戳按「刚发生」处理（decay = 1，保证单调不增）。 */
export function decay(ts: number, now: number, halfLifeDays = 180): number {
  const half = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : 180
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return 0
  const days = Math.max(0, (now - ts) / DAY_MS)
  return 0.5 ** (days / half)
}

/** 融合输入：字符串 id，或带 id 字段的对象。 */
export type RrfItem = string | { id: string }

export interface RrfOptions {
  /** RRF 平滑常数，默认 60。 */
  k?: number
  /** 后续各路相对前一路的权重衰减系数，默认 0.6（榜首路权重 1）。 */
  alpha?: number
}

export interface RrfEntry {
  id: string
  /** 融合分（各路 weight / (k + rank) 求和）。 */
  score: number
  /** 该 id 在各路中的名次（1 起，按路序）。 */
  ranks: number[]
}

/**
 * 多路有序列表融合（Reciprocal Rank Fusion 的加权变体）。
 *
 * - 第 i 路权重 = alpha ** i（i 从 0 起）⇒ 榜首路权重 1，越靠后的路越轻；
 * - 同一路内重复出现的 id 只记首次名次（确定性）；
 * - 排序：score 降序，同分按 id 字典序升序（稳定决胜）。
 */
export function rrf(rankLists: ReadonlyArray<ReadonlyArray<RrfItem>>, opts: RrfOptions = {}): RrfEntry[] {
  const k = typeof opts.k === 'number' && Number.isFinite(opts.k) && opts.k > 0 ? opts.k : 60
  const alpha = typeof opts.alpha === 'number' && Number.isFinite(opts.alpha) ? opts.alpha : 0.6

  const acc = new Map<string, RrfEntry>()
  for (let li = 0; li < rankLists.length; li += 1) {
    const list = rankLists[li]
    if (!Array.isArray(list)) continue
    const weight = alpha ** li
    const seen = new Set<string>()
    for (let idx = 0; idx < list.length; idx += 1) {
      const raw = list[idx]
      const id = typeof raw === 'string' ? raw : (raw !== null && typeof raw === 'object' ? raw.id : undefined)
      if (typeof id !== 'string' || id === '' || seen.has(id)) continue
      seen.add(id)
      const rank = idx + 1
      const gain = weight / (k + rank)
      const cur = acc.get(id)
      if (cur === undefined) acc.set(id, { id, score: gain, ranks: [rank] })
      else {
        cur.score += gain
        cur.ranks.push(rank)
      }
    }
  }

  return [...acc.values()].sort((a, b) => (b.score - a.score) || cmpId(a.id, b.id))
}

/** 字典序升序比较（显式实现，不依赖 locale）。 */
export function cmpId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/**
 * 极简分词（不引依赖）：拉丁/数字连续串按整词切；汉字逐字切，并额外产出相邻二字组。
 * 中文没有空格，单靠整句匹配会大量漏召回，二字组是成本最低的补救。
 */
export function tokenize(text: unknown): string[] {
  if (typeof text !== 'string' || text === '') return []
  const s = text.toLowerCase()
  const out: string[] = []
  let buf = ''
  for (let i = 0; i < s.length; i += 1) {
    const ch = s.charAt(i)
    if (ch >= 'a' && ch <= 'z') { buf += ch; continue }
    if (ch >= '0' && ch <= '9') { buf += ch; continue }
    if (ch === '_') { buf += ch; continue }
    if (buf !== '') { out.push(buf); buf = '' }
    if (CJK.test(ch)) {
      out.push(ch)
      const next = s.charAt(i + 1)
      if (next !== '' && CJK.test(next)) out.push(ch + next)
    }
  }
  if (buf !== '') out.push(buf)
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 绝对标度常数（模块级、只读；可用配置覆盖；**绝不随批次变化**）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ── 真实语料标定（2026-10-09，第二次落地）──────────────────────────────────
 *
 * 标定工具：`node scripts/calibrate.mjs`（**默认只打印建议，绝不自动改写源码/配置**；
 * `--write` 是唯一的落地路径，且必须**显式请求**：写前备份成 `<target>.bak-<时间戳>`、打印逐行 diff、
 * 锚点缺失即失败关闭。本次运行的证据存档 `redproof/i7-calibrate-real-library.txt`）。
 *
 * 本次（第二次）标定语料：真实记忆库 **204 条**有效记录、正样本 **408** 个
 * （每条记录的标题 + 前 3 个标签各作一次查询、对自身打分）、负样本 **240** 个
 * （与库无关的冻结跨域词表查询，每个取库内最高分）；语料来源：`gotchas.md` 导入 + 手工教训记录。
 * 建议值 0.0199 / 0.3666 / 0.0382 / 0.1507，与落地前旧值的差为 +0.0012 / **+0.0246** / +0.0019 / +0.0031。
 * 按判据（差异 ≥ 0.005 视为显著）**只有 SCALE_B 单独显著**；但这四个量出自**同一次确定性运行**，
 * 跨运行混搭常数比整组落地更难解释，所以按整组落地，并在上句逐项写明各差多少。
 *
 * 上一次（第一次）落地的语料快照留档：库内 195 条、正样本 388 个、负样本 240 个，当时建议
 * 0.0188 / 0.3482 / 0.0364 / 0.1478（证据 redproof/i2.2-calibrate-real-library.txt）。
 * 2026-10-09 之后库长到 203/204 条，SCALE_B 的建议值随之抬到 0.3621 / 0.3666 ——
 * 这正是第一段那句「语料增长必须重标」的实例化。
 *
 * 四个常数各自取哪个分位数（脚本口径，不要顺手互换）：
 *   SCALE_A          = p50(负样本)   —— 噪声地板（无关查询的展示分压在 0 附近）
 *   SCALE_B          = p95(正样本)   —— 正样本高分位（真命中映射到 1.0000）
 *   WEAK_THRESHOLD   = p95(负样本)   —— 噪声上界（弱证据从噪声之上开始）
 *   STRONG_THRESHOLD = p10(正样本)   —— 正样本低分位（九成以上真命中判 strong）
 * 这四个量**只影响标签与展示**：WEAK/STRONG 决定 match 的 none/weak/strong，SCALE_A/SCALE_B
 * 只进展示分 disp；BM25、排序、召回集合、上限、分诊一概不读它们。
 *
 * 该语料有偏（单一项目、单一种文风），语料明显增长后必须用 `scripts/calibrate.mjs` 重新标定并同步更新本注释。
 *
 * 落地值（本行是 test/scoring.test.mjs 的「注释 ↔ 常数一致性」断言所锚定的机器可读行，格式别改）：
 * 落地值：SCALE_A = 0.0199  SCALE_B = 0.3666  WEAK_THRESHOLD = 0.0382  STRONG_THRESHOLD = 0.1507
 */

/**
 * 展示分绝对区间映射的下界，默认 0.0199 = 噪声地板 p50(负样本)。
 * 与 SCALE_B 一起构成「固定绝对区间」：不依赖任何候选的得分。
 */
export const SCALE_A = 0.0199

/**
 * 展示分绝对区间映射的上界（raw 达到它即展示 1.0000），默认 0.3666 = p95(正样本)。
 * 旧值 0.45 是 offline 自语料夹具推出来的临时值（(3+2+1)·idf·sat 恒等式），已按真实语料替换；
 * 标定出处与分位数语义见上方「真实语料标定（2026-10-09，第二次落地）」块。
 */
export const SCALE_B = 0.3666

/**
 * 绝对判定阈值（默认 0.0382 = p95(负样本)，噪声上界）：
 * raw ≥ WEAK_THRESHOLD 记 weak，raw ≥ STRONG_THRESHOLD 记 strong。
 * 更早的 0.06 只来自第三方审计的量级；在 240 个负样本上 p95 实测 0.0363 ⇒ 噪声上界下调，
 * 落在 (0.0363, 0.06) 的真相关记录从 none 变成 weak。本次（204 条库）再抬到 0.0382，
 * 于是又有一批 rel 落在 (0.0363, 0.0382) 的记录从 weak 落回 none ——
 * 两条边界红证都见 test/scoring.test.mjs（两条都能判红：改回旧值即红）。
 */
export const WEAK_THRESHOLD = 0.0382
/** 见 WEAK_THRESHOLD。默认 0.1507 = p10(正样本)，正样本低分位。 */
export const STRONG_THRESHOLD = 0.1507

/**
 * 多样性惩罚系数 β 默认值：`final = rel × (1 − β·maxSimToSelected)`。
 * 只作用于同一分数（不再做「先重排、后打印」的两段式）⇒ 列表按 final 降序，打印天然单调。
 */
export const DEFAULT_DIVERSITY_BETA = 0.3

/** BM25 词频饱和参数（第三方给定口径，不要手改）。 */
export const BM25_K1 = 1.2
/** BM25 文档长度归一参数（第三方给定口径）；b=0 即关掉长度归一（红证用）。 */
export const BM25_B = 0.75

/** 打分字段（标签 / 标题 / 正文）。 */
export type ScoreField = 'tags' | 'title' | 'body'

/** 字段遍历顺序（固定，保证求和顺序确定 ⇒ 浮点结果可复现）。 */
export const SCORE_FIELDS: readonly ScoreField[] = ['tags', 'title', 'body']

/** 字段权重：tags 高于 title 高于 body。 */
export const FIELD_WEIGHTS: Readonly<Record<ScoreField, number>> = { tags: 3, title: 2, body: 1 }

/** 绝对判定三档。 */
export type MatchLevel = 'none' | 'weak' | 'strong'

/** 打分口径的可覆盖项（配置来自工具 config，见 resolveScoreOptions）。 */
export interface ScoreOptions {
  scaleA?: number
  scaleB?: number
  weakThreshold?: number
  strongThreshold?: number
  diversityBeta?: number
}

/** 已解析（always 有值）的打分口径。 */
export interface ResolvedScoreOptions {
  scaleA: number
  scaleB: number
  weak: number
  strong: number
  beta: number
}

function finiteOr(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

/** 夹到 0..1；非有限值一律夹成 0。 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/**
 * 解析打分配置：显式配置 > 模块级常数默认。
 * 非法输入（非有限数）一律回落默认；SCALE_B 必须严格大于 SCALE_A（否则回落 SCALE_A + 1）；
 * weak > strong 时交换（保证 match 单调）。**任何一支都不引入批次相关量。**
 */
export function resolveScoreOptions(opts?: ScoreOptions): ResolvedScoreOptions {
  const o = opts ?? {}
  const scaleA = finiteOr(o.scaleA, SCALE_A)
  let scaleB = finiteOr(o.scaleB, SCALE_B)
  if (!(scaleB > scaleA)) scaleB = scaleA + 1
  const weak = clamp01(finiteOr(o.weakThreshold, WEAK_THRESHOLD))
  const strong = clamp01(finiteOr(o.strongThreshold, STRONG_THRESHOLD))
  const beta = clamp01(finiteOr(o.diversityBeta, DEFAULT_DIVERSITY_BETA))
  return weak > strong
    ? { scaleA, scaleB, weak: strong, strong: weak, beta }
    : { scaleA, scaleB, weak, strong, beta }
}

/**
 * 固定绝对区间映射：disp = clip((raw − scaleA) / (scaleB − scaleA), 0, 1)。
 *
 * **绝不使用批内极值**（见本文件顶部纪律注释）：函数签名里根本没有「本批候选」这个入参，
 * 所以同一 raw 在任何批次里都得到同一个 disp，不存在「第一名恒为 1.0000」。
 */
export function absoluteDisp(raw: number, scaleA: number = SCALE_A, scaleB: number = SCALE_B): number {
  if (!Number.isFinite(raw)) return 0
  const a = Number.isFinite(scaleA) ? scaleA : SCALE_A
  let b = Number.isFinite(scaleB) ? scaleB : SCALE_B
  if (!(b > a)) b = a + 1
  return clamp01((raw - a) / (b - a))
}

/** 绝对判定：raw 与两个绝对阈值比较（不涉及任何批次统计）。 */
export function matchLevel(raw: number, weak: number = WEAK_THRESHOLD, strong: number = STRONG_THRESHOLD): MatchLevel {
  const r = Number.isFinite(raw) ? raw : 0
  const w = finiteOr(weak, WEAK_THRESHOLD)
  const s = finiteOr(strong, STRONG_THRESHOLD)
  if (r >= s) return 'strong'
  if (r >= w) return 'weak'
  return 'none'
}

/**
 * 频次 / 边权类量一律先做 log(1 + λW) 压缩，**禁止线性累加**（第三方审计点名）。
 * 说明：BM25 内部对 tf 的压缩由 (k1+1) 饱和完成（有界，非线性）；本函数用于
 * 「全局频次 / 共现边权」这类会被直接当权重的量（见 tagCoverage 的 logfreq 口径）。
 */
export function logCompress(weight: number, lambda = 1): number {
  if (!Number.isFinite(weight) || weight <= 0) return 0
  const l = Number.isFinite(lambda) && lambda > 0 ? lambda : 1
  return Math.log(1 + l * weight)
}

/** BM25 的 idf：log(1 + (N − df + 0.5) / (df + 0.5))。df=0（语料里没有该词）时取到最大值。 */
export function idf(df: number, n: number): number {
  const d = Number.isFinite(df) && df > 0 ? df : 0
  const total = Number.isFinite(n) && n > 0 ? n : 0
  if (total <= 0) return 0
  return Math.log(1 + (total - d + 0.5) / (d + 0.5))
}

/**
 * BM25 的单词语义饱和项：tf·(k1+1) / (tf + k1·(1 − b + b·|D|/avgdl))。
 * 上界为 (k1+1)（tf→∞），随 |D|/avgdl 增大而下降 ⇒ 长文档不靠堆词频白拿分。
 */
export function fieldSat(tf: number, dl: number, avgdl: number, k1: number = BM25_K1, b: number = BM25_B): number {
  if (!Number.isFinite(tf) || tf <= 0) return 0
  const kk = Number.isFinite(k1) && k1 >= 0 ? k1 : BM25_K1
  const bb = Number.isFinite(b) && b >= 0 ? b : BM25_B
  const avg = Number.isFinite(avgdl) && avgdl > 0 ? avgdl : dl > 0 ? dl : 1
  const denorm = 1 - bb + bb * (dl / avg)
  return (tf * (kk + 1)) / (tf + kk * denorm)
}

/** 单个字段的语料统计（该字段自己的 N / avgdl / df）。 */
export interface FieldStats {
  /** 该字段非空的记录数。 */
  n: number
  /** 该字段的平均词元数（仅对该字段非空的记录求平均）。 */
  avgdl: number
  /** 词元 → 含该词元的记录数。 */
  df: Map<string, number>
}

/** 一次召回用到的全部语料统计（**每次调用现算**，绝不放模块级可变全局）。 */
export interface CorpusStats {
  /** 记录总数。 */
  total: number
  /** 按字段各自的统计。 */
  fields: Record<ScoreField, FieldStats>
  /** 标签字符串（trim + 小写）→ 含该标签的记录数（供 cov 用）。 */
  tagDf: Map<string, number>
  /** 至少有一个标签的记录数。 */
  tagN: number
}

/** 词法打分的输入（只需标题/正文/标签）。 */
export interface LexicalRecord {
  title?: unknown
  body?: unknown
  tags?: unknown
}

/** 取某字段的规范化标签串（trim + 小写 + 去空 + 去重，保持出现顺序）。 */
export function normalizedTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of tags) {
    if (typeof raw !== 'string') continue
    const t = raw.trim().toLowerCase()
    if (t === '' || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/** 取某字段的词元序列（tags 以空格连接后分词）。 */
export function fieldTokens(record: LexicalRecord | null | undefined, field: ScoreField): string[] {
  if (record === null || record === undefined) return []
  if (field === 'tags') return tokenize(normalizedTags(record.tags).join(' '))
  return tokenize(field === 'title' ? record.title : record.body)
}

function emptyFieldStats(): FieldStats {
  return { n: 0, avgdl: 0, df: new Map<string, number>() }
}

/**
 * 现算语料统计：N / avgdl / df 全部按字段各自统计（字段内部的 df/avgdl 用该字段自己的统计）。
 * 刻意**不做**模块级缓存：第三方明确记录过「全局单例与并发不兼容」，一次召回一个快照最稳。
 */
export function corpusStats(records: ReadonlyArray<LexicalRecord | null | undefined>): CorpusStats {
  const fields: Record<ScoreField, FieldStats> = {
    tags: emptyFieldStats(),
    title: emptyFieldStats(),
    body: emptyFieldStats(),
  }
  const lenSum: Record<ScoreField, number> = { tags: 0, title: 0, body: 0 }
  const tagDf = new Map<string, number>()
  let total = 0
  let tagN = 0

  for (const rec of records) {
    if (rec === null || rec === undefined) continue
    total += 1
    for (const field of SCORE_FIELDS) {
      const toks = fieldTokens(rec, field)
      if (toks.length === 0) continue
      const fs = fields[field]
      fs.n += 1
      lenSum[field] += toks.length
      for (const t of new Set(toks)) fs.df.set(t, (fs.df.get(t) ?? 0) + 1)
    }
    const tags = normalizedTags(rec.tags)
    if (tags.length > 0) {
      tagN += 1
      for (const t of tags) tagDf.set(t, (tagDf.get(t) ?? 0) + 1)
    }
  }

  for (const field of SCORE_FIELDS) {
    const fs = fields[field]
    fs.avgdl = fs.n > 0 ? lenSum[field] / fs.n : 0
  }
  return { total, fields, tagDf, tagN }
}

/** BM25 单次打分的可覆盖参数（红证用 b=0 关掉长度归一）。 */
export interface Bm25Options {
  k1?: number
  b?: number
}

function termCounts(tokens: ReadonlyArray<string>): Map<string, number> {
  const acc = new Map<string, number>()
  for (const t of tokens) acc.set(t, (acc.get(t) ?? 0) + 1)
  return acc
}

/**
 * BM25 相关度，归一化到 0..1。
 *
 * 做法（第三方给定口径）：查询词元去重后，**按字段各算 BM25 再加权求和**（字段内部用该字段
 * 自己的 df/avgdl）。再除以**查询在语料统计下的理论上界** Σ_w Σ_f w_f·idf_f(w)·(k1+1)：
 *
 *   rel = Σ_f w_f · Σ_w idf_f(w)·sat_f(w,D)   ÷   Σ_f w_f · Σ_w idf_f(w)·(k1+1)
 *
 * 因为 sat 的上界就是 (k1+1)，所以 rel 天然落在 0..1（浮点误差用 clamp 兜底）。
 *
 * 这个分母**不是批内归一化**，不要混淆（见文件顶部纪律注释）：
 *  - 它只依赖「查询词 + 语料统计（N/df/avgdl）」，**不依赖任何候选的得分**，更不是本批最大值；
 *  - 因此无关候选照样可以是 0（不会因为「本批第一名」被抬成 1.0000）；
 *  - 它的作用是给「不同查询」一个可比的绝对标度，让 WEAK/STRONG 两个绝对阈值有意义。
 */
export function bm25Relevance(
  query: unknown,
  record: LexicalRecord | null | undefined,
  stats: CorpusStats,
  opts: Bm25Options = {},
): number {
  if (record === null || record === undefined) return 0
  const q = [...new Set(tokenize(query))]
  if (q.length === 0) return 0
  const k1 = finiteOr(opts.k1, BM25_K1)
  const b = finiteOr(opts.b, BM25_B)

  let num = 0
  let den = 0
  for (const field of SCORE_FIELDS) {
    const fs = stats.fields[field]
    if (fs.n <= 0 || fs.avgdl <= 0) continue
    const toks = fieldTokens(record, field)
    const tf = termCounts(toks)
    const dl = toks.length
    const w = FIELD_WEIGHTS[field]
    for (const term of q) {
      const i = idf(fs.df.get(term) ?? 0, fs.n)
      if (i <= 0) continue
      den += w * i * (k1 + 1)
      const f = tf.get(term) ?? 0
      if (f > 0) num += w * i * fieldSat(f, dl, fs.avgdl, k1, b)
    }
  }
  if (den <= 0 || num <= 0) return 0
  return clamp01(num / den)
}

/**
 * 词法相关度（主分）：BM25 + 字段权重 + 0..1 绝对标度。
 *
 * 契约（I1.2 起，与 I1.1 的「Σ(字段权重×命中词元数)/(6×查询词元数)」不同，已在用例里同步更新）：
 *   rel = Σ_f w_f · Σ_w idf_f(w)·sat_f(w,D) / Σ_f w_f · Σ_w idf_f(w)·(k1+1)，w = tags:3 / title:2 / body:1
 * 性质：tags > title > body（同 tf 时严格按 3:2:1）；长文档被长度归一压低；无关查询为 0。
 *
 * 省略 stats 时用「自语料」（只含这一条记录）现算 —— 仅供单条调用/夹具使用；
 * 召回路径必须传入整库 corpusStats（否则 df/avgdl 退化为单条，失去 idf 与长度归一的意义）。
 */
export function lexicalScore(
  query: unknown,
  record: LexicalRecord | null | undefined,
  stats?: CorpusStats,
  opts: Bm25Options = {},
): number {
  const corpus = stats ?? corpusStats([record])
  return bm25Relevance(query, record, corpus, opts)
}

/** cov 的标签权重口径。 */
export type TagWeighting = 'idf' | 'logfreq'

export interface CoverageOptions {
  /** 标签权重口径，默认 'idf'（idf 自身即对数压缩）；'logfreq' 用 1/log(1+λ(df+1))。 */
  weighting?: TagWeighting
  /** log 压缩系数 λ，默认 1。 */
  lambda?: number
}

/** 标签权重：idf，或 1/log(1+λ(df+1))（分母恒 > 0；都随全局频次单调递减）。 */
export function tagWeight(tag: string, stats: CorpusStats, opts: CoverageOptions = {}): number {
  const df = stats.tagDf.get(tag) ?? 0
  if (opts.weighting === 'logfreq') {
    return 1 / logCompress(df + 1, finiteOr(opts.lambda, 1))
  }
  return idf(df, stats.tagN)
}

/** 标签是否被查询命中：标签串本身命中，或它的任一词元被查询命中（中文二字组友好）。 */
export function tagHitsQuery(tag: string, queryTokens: ReadonlySet<string>): boolean {
  if (queryTokens.has(tag)) return true
  for (const t of tokenize(tag)) if (queryTokens.has(t)) return true
  return false
}

/**
 * VCP 式覆盖率：cov = Σ(命中标签的权重) / Σ(候选全部标签的权重)。
 *
 * 作用：长文档的外围公共标签只能**稀释**（进分母）不能加分 —— 权重低 + 不算命中。
 * I1.2 里 cov **只作诊断列，不做门控**（低覆盖不得否决整批、不得返回空，第三方回退过这种做法）。
 */
export function tagCoverage(
  query: unknown,
  tags: unknown,
  stats: CorpusStats,
  opts: CoverageOptions = {},
): number {
  const list = normalizedTags(tags)
  if (list.length === 0) return 0
  const qset = new Set(tokenize(query))
  if (qset.size === 0) return 0
  let hit = 0
  let all = 0
  for (const tag of list) {
    const w = tagWeight(tag, stats, opts)
    if (!Number.isFinite(w) || w <= 0) continue
    all += w
    if (tagHitsQuery(tag, qset)) hit += w
  }
  return all > 0 ? clamp01(hit / all) : 0
}

/** 多样性重排的输入：相关度分 + 标签（+ 融合秩，用于同分决胜）。 */
export interface DiversifyRecord {
  id: string
  /** 相关度分（惩罚前）。 */
  score: number
  tags?: readonly string[]
  /** 融合名次（越小越靠前）；缺省 0。同分时先按它、再按 id 字典序决胜 ⇒ 确定性。 */
  rank?: number
}

/** 多样性重排的输出：原记录 + 选中时刻的最终分。 */
export type DiversifiedRecord<T extends DiversifyRecord> = T & {
  /**
   * 选中时刻的最终分：final = score × (1 − β·maxSimToSelected)。
   * 列表就是按它降序的 ⇒ 打印这一列天然单调不增（I1.2 修 C 的要害）。
   */
  final: number
}

export interface DiversifyOptions {
  /** 多样性惩罚系数 β（优先于 lambda）。默认 DEFAULT_DIVERSITY_BETA = 0.3。 */
  beta?: number
  /** I1.1 旧口径兼容：λ = 1 − β（lambda=1 ⇒ β=0 退化为纯按分数）。 */
  lambda?: number
  /** 取回条数上限。 */
  limit?: number
  /** 候选数 <= 该值时跳过多样性（小候选集拿不到多样性收益，纯添乱）。默认 0 = 不跳过。 */
  minCandidates?: number
}

/** 标签集合的 Jaccard 相似度；两侧都为空时视为不相似（0），避免惩罚无标签记录。 */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter += 1
  return inter / (a.size + b.size - inter)
}

function resolveBeta(opts: DiversifyOptions): number {
  if (typeof opts.beta === 'number' && Number.isFinite(opts.beta)) return clamp01(opts.beta)
  if (typeof opts.lambda === 'number' && Number.isFinite(opts.lambda)) return clamp01(1 - opts.lambda)
  return DEFAULT_DIVERSITY_BETA
}

/**
 * 把多样性**乘进同一个分数**后按该分数降序输出（I1.2 修 C）。
 *
 *   final = rel × (1 − β·maxSimToSelected)，β 默认 0.3。
 *
 * 为什么这样就不会再出现「0.9763 排在 0.9785 前面」：I1.1 是「先归一化 → MMR 只改顺序 →
 * 仍打印归一化分」，于是打印列与列表顺序脱钩。现在顺序与打印列是同一个数（final），
 * 且贪心选择序列本身单调不增（每选一个，剩余候选的 maxSim 只增不减）⇒ 打印天然单调。
 *
 * `候选数 <= minCandidates` 时跳过多样性（第三方做法：小候选集只重排、拿不到多样性收益、纯添乱）。
 * 注意：minCandidates 默认 0（纯函数层不预设策略），召回层显式传 5。
 */
export function diversify<T extends DiversifyRecord>(
  records: ReadonlyArray<T>,
  opts: DiversifyOptions = {},
): Array<DiversifiedRecord<T>> {
  const beta = resolveBeta(opts)
  const limit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0
    ? Math.floor(opts.limit)
    : records.length
  const minCandidates = typeof opts.minCandidates === 'number' && Number.isFinite(opts.minCandidates)
    ? Math.max(0, Math.floor(opts.minCandidates))
    : 0

  const pool = records.map((rec) => ({
    rec,
    tags: new Set((rec.tags ?? []).map((t) => String(t).trim().toLowerCase()).filter((t) => t !== '')),
  }))
  pool.sort((a, b) => (b.rec.score - a.rec.score)
    || ((a.rec.rank ?? 0) - (b.rec.rank ?? 0))
    || cmpId(a.rec.id, b.rec.id))

  const out: Array<DiversifiedRecord<T>> = []
  const head = Math.max(0, limit)

  // 关闭多样性（beta=0）或候选太少：直接按 score/rank 顺序取前 limit 条。
  if (beta === 0 || pool.length <= minCandidates) {
    for (let i = 0; i < pool.length && out.length < head; i += 1) {
      const item = pool[i]
      if (item === undefined) continue
      out.push({ ...item.rec, final: item.rec.score })
    }
    return out
  }

  const picked: typeof pool = []
  const rest = pool.slice()
  while (out.length < head && rest.length > 0) {
    let bestIdx = 0
    let bestVal = -Infinity
    for (let i = 0; i < rest.length; i += 1) {
      const cand = rest[i]
      if (cand === undefined) continue
      let maxSim = 0
      for (const sel of picked) {
        const sim = jaccard(cand.tags, sel.tags)
        if (sim > maxSim) maxSim = sim
      }
      const val = cand.rec.score * (1 - beta * maxSim)
      if (val > bestVal) { bestVal = val; bestIdx = i }
    }
    const chosen = rest[bestIdx]
    if (chosen === undefined) break
    picked.push(chosen)
    rest.splice(bestIdx, 1)
    // bestVal 恒有限（首轮至少有一个候选，val >= 0）；兜底防 -Infinity 泄进输出。
    out.push({ ...chosen.rec, final: Number.isFinite(bestVal) ? bestVal : chosen.rec.score })
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// I2：残差金字塔式分诊（词法空间里的 Gram-Schmidt）
//
// 没有 embedding，就用**词法向量空间**：维度 = 标签语料里的词元，权重 = 标签 idf
// （走 tagWeight 的 idf 口径）。df=0 的词元取 idf 上界 ⇒ 与库完全无关的查询词也有非零能量，
// 于是「无关查询」和「高度重合查询」在同一套算术下有可比的行为。查询向量与候选标签向量
// 都在这个空间里 ⇒ 可以做真正的投影、残差与能量守恒。
//
// 【允许的批内归一化】：本节的归一化只作用在**查询场自身的能量分布**上
// （explainedRatio / residualRatio / 投影熵的 p_i = e_i / Σe）。作用对象是查询场，
// 不是候选集合 —— 与文件顶部纪律一致。**绝不**把这里的任何归一化用到候选展示分上：
// 展示分只走 absoluteDisp 的固定绝对区间，（禁止 `disp = raw / max(raw over 本批)`）。
//
// 【I2 红线：请求级隔离 —— 后人不要为了「性能」把状态提到模块级】
// 第三方先判「JS 单线程 ⇒ 无竞态」，后被推翻。一次召回是 async 的（要读文件、宿主会在
// await 点让出）；只要有**任何模块级的**「最近一次的能量场 / 基 / 残差 / 上一次查询」，
// 第二个请求的分诊结论就取决于第一个请求有没有刚好插在中间 —— 这是真竞态，不是理论问题。
// 因此 residualPyramid 与调用它的召回路径**只使用函数内的局部变量**：基、正交化结果、
// 投影系数、残差、能量累计全是本地量；不写模块级可变状态、不缓存「上一次查询」；
// 语料统计 corpusStats 每次调用现算（本来就是这样，保持一致）。
// 想优化就优化单次调用的常数因子（比如下面的稀疏点积只遍历较短的一侧），**不要**把状态
// 提到模块级：test/triage.test.mjs 的「请求级隔离」用例会在两次不同查询之间注入一次事件
// 循环让出，并与「单独只跑第二次（全新进程）」的结果逐字段比对；提回模块级必然判红。
// ─────────────────────────────────────────────────────────────────────────────

/** 基的规模上限（参与 Gram-Schmidt 的候选标签向量个数）。 */
export const MAX_BASIS = 6
/** 投影层数上限。 */
export const MAX_LAYERS = 3
/** 提前停止的残差能量比例：残差 < 该比例 × 原始能量就停。 */
export const RESIDUAL_STOP = 0.1
/** novelty 里残差项的权重。 */
export const NOVELTY_RESIDUAL_WEIGHT = 0.7
/** novelty 里方向一致性项的权重（两项权重和 = 1 ⇒ novelty 天然落在 0..1）。 */
export const NOVELTY_DIRECTION_WEIGHT = 0.3
/** 分诊门控默认阈值：novelty >= 它 ⇒ 扩检索。 */
export const DEFAULT_NOVELTY_THRESHOLD = 0.5
/** 低置信默认阈值：cov_max < 它 ⇒ lowConfidence（**只如实报告，绝不否决/返回空**）。 */
export const DEFAULT_ACTIVATION_THRESHOLD = 0.05
/** 稀疏算术的零判定阈值（能量量级，1e-12 足够小且不吞掉真实的微小能量）。 */
export const PYRAMID_EPS = 1e-12

/** 分诊口径（全部有模块级默认常数，可经工具配置覆盖）。 */
export interface TriageOptions {
  noveltyThreshold?: number
  activationThreshold?: number
  maxBasis?: number
  maxLayers?: number
  residualStop?: number
}

/** 已解析（always 有值）的分诊口径。 */
export interface ResolvedTriageOptions {
  noveltyThreshold: number
  activationThreshold: number
  maxBasis: number
  maxLayers: number
  residualStop: number
}

function clampInt(raw: unknown, fallback: number, lo: number, hi: number): number {
  const v = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : fallback
  return v < lo ? lo : v > hi ? hi : v
}

/** 解析分诊配置：显式配置 > 模块级默认；非法值一律回落，绝不接受 NaN/负层数。 */
export function resolveTriageOptions(opts?: TriageOptions): ResolvedTriageOptions {
  const o = opts ?? {}
  return {
    noveltyThreshold: clamp01(finiteOr(o.noveltyThreshold, DEFAULT_NOVELTY_THRESHOLD)),
    activationThreshold: clamp01(finiteOr(o.activationThreshold, DEFAULT_ACTIVATION_THRESHOLD)),
    maxBasis: clampInt(o.maxBasis, MAX_BASIS, 1, 32),
    maxLayers: clampInt(o.maxLayers, MAX_LAYERS, 1, 8),
    residualStop: clamp01(finiteOr(o.residualStop, RESIDUAL_STOP)),
  }
}

/** 稀疏向量：词元 → 权重（只存非零项，未出现的词元视为 0）。 */
export type SparseVector = ReadonlyMap<string, number>

/** 丢掉落不到词法空间里的项（键非字符串、权重非有限正数）。 */
function sanitizeVector(v: SparseVector): Map<string, number> {
  const out = new Map<string, number>()
  for (const [k, w] of v) {
    if (typeof k !== 'string' || k === '') continue
    if (!Number.isFinite(w) || w <= 0) continue
    out.set(k, w)
  }
  return out
}

/**
 * 稀疏点积。只遍历较短的一侧（常数因子优化），且按该侧的插入顺序累加
 * ⇒ 同一输入必然同一浮点结果（不依赖 Map 大小差异带来的遍历顺序漂移）。
 */
export function sparseDot(a: SparseVector, b: SparseVector): number {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  let sum = 0
  for (const [k, w] of small) {
    const other = big.get(k)
    if (other !== undefined) sum += w * other
  }
  return Number.isFinite(sum) ? sum : 0
}

/** ‖v‖²。 */
export function sparseNorm2(v: SparseVector): number {
  let sum = 0
  for (const w of v.values()) if (Number.isFinite(w)) sum += w * w
  return Number.isFinite(sum) ? sum : 0
}

function sparseScale(v: SparseVector, k: number): Map<string, number> {
  const out = new Map<string, number>()
  if (!Number.isFinite(k) || k === 0) return out
  for (const [key, w] of v) {
    const val = w * k
    if (val !== 0) out.set(key, val)
  }
  return out
}

function sparseSub(a: SparseVector, b: SparseVector): Map<string, number> {
  const out = new Map<string, number>()
  for (const [k, w] of a) if (w !== 0) out.set(k, w)
  for (const [k, w] of b) {
    const val = (out.get(k) ?? 0) - w
    if (val === 0) out.delete(k)
    else out.set(k, val)
  }
  return out
}

/**
 * 标签 idf 加权的词元向量：`tokenize(tokens)` 去重后逐项取 tagWeight(t) = idf(df, tagN)。
 * 词元按首次出现顺序入表 ⇒ 同输入同顺序（浮点求和顺序固定）。
 */
export function tagVector(tokens: ReadonlyArray<string>, stats: CorpusStats): Map<string, number> {
  const out = new Map<string, number>()
  for (const t of tokens) {
    if (typeof t !== 'string' || t === '' || out.has(t)) continue
    const w = tagWeight(t, stats)
    if (!Number.isFinite(w) || w <= 0) continue
    out.set(t, w)
  }
  return out
}

/**
 * 经典 Gram-Schmidt 正交化（返回**正交归一**基）：
 * 逐个减掉与已接受单位基向量的投影，再归一化；范数 <= PYRAMID_EPS 的向量
 * （零向量，或与已有基线性相关）直接丢弃 —— 这正是「基的规模」只增不虚的原因。
 *
 * 数值说明：维度很小（词元数 + 最多 maxBasis 个基），一次正交化足够稳定，
 * 仍显式跳过退化向量，保证输出里不出现 NaN/Infinity。
 */
export function gramSchmidt(vectors: ReadonlyArray<SparseVector>): Array<Map<string, number>> {
  const basis: Array<Map<string, number>> = []
  for (const rawVec of vectors) {
    let v = sanitizeVector(rawVec)
    if (sparseNorm2(v) <= PYRAMID_EPS) continue
    for (const u of basis) {
      const proj = sparseDot(v, u)
      if (proj === 0) continue
      // 注意：必须按 u 的全部词元做减法（v 里没有的维度要补上 −proj·u_k），
      // 只遍历 v 自己的键会漏掉 u 独有的维度 ⇒ 残差不再与 u 正交（实测内积 0.0595）。
      v = sparseSub(v, sparseScale(u, proj))
    }
    const n2 = sparseNorm2(v)
    if (n2 <= PYRAMID_EPS) continue
    const inv = 1 / Math.sqrt(n2)
    const unit = new Map<string, number>()
    for (const [k, w] of v) unit.set(k, w * inv)
    basis.push(unit)
  }
  return basis
}

/** 投影能量分布 → 熵与逻辑深度。 */
export interface ProjectionEntropy {
  /** 香农熵（bit），落在 [0, log2(K)]。 */
  entropy: number
  /** K = 参与投影且能量 > 0 的基个数。 */
  k: number
  /** 逻辑深度 = 1 − H / log2(K)，落在 [0,1]。 */
  logicalDepth: number
}

/**
 * 投影熵 → 逻辑深度。
 *
 * p_i = e_i / Σe（e_i 是第 i 层的投影能量 c_i²，**这是查询场自身的归一化，不是候选展示分**），
 * H = −Σ p_i·log2 p_i，logicalDepth = 1 − H / log2(K)，K = 能量 > 0 的层数：
 *   - 能量集中在一个方向（K=1，或某一层独占）⇒ H=0 ⇒ logicalDepth=1；
 *   - 能量在 K 个方向上均摊 ⇒ H=log2(K) ⇒ logicalDepth=0。
 * 边界（不许 NaN）：K=0（没有基/没有投影）⇒ {0,0,0}；K=1 ⇒ H=0 且 log2(1)=0，
 * `1 − 0/0` 会出 NaN，所以**显式定义 logicalDepth = 0**（只有一个方向承载全部能量时
 * 没有「分布」可言，逻辑深度无信息，取 0 而不是 NaN）。
 */
export function projectionEntropy(energies: ReadonlyArray<number>): ProjectionEntropy {
  const positive: number[] = []
  let total = 0
  for (const e of energies) {
    if (typeof e === 'number' && Number.isFinite(e) && e > PYRAMID_EPS) {
      positive.push(e)
      total += e
    }
  }
  if (positive.length === 0 || !(total > 0)) return { entropy: 0, k: 0, logicalDepth: 0 }
  let h = 0
  for (const e of positive) {
    const p = e / total
    h -= p * Math.log2(p)
  }
  if (!Number.isFinite(h) || h < 0) h = 0
  const maxH = Math.log2(positive.length)
  const logicalDepth = positive.length <= 1 || !(maxH > 0) ? 0 : clamp01(1 - h / maxH)
  return { entropy: h, k: positive.length, logicalDepth }
}

/** 一个基候选（召回路径传的是「按分数排好序的前 kBase 个候选」）。 */
export interface PyramidBasisItem {
  id?: string
  tags?: unknown
}

/** 残差金字塔的分诊结果（全部落在 [0,1]，除 basisSize/layers/projectedBasis 是计数）。 */
export interface PyramidResult {
  /** 新颖度 = 0.7 × residualRatio + 0.3 × directionConsistency。 */
  novelty: number
  /** ‖P‖²/‖q‖²：被基解释掉的能量比例。 */
  explainedRatio: number
  /** ‖R‖²/‖q‖²：剩下的能量比例（实现上取 1 − explainedRatio ⇒ 两者和恒为 1）。 */
  residualRatio: number
  /** 见下方长注释里的定义。 */
  directionConsistency: number
  /** 投影熵（bit）。 */
  projectionEntropy: number
  /** 逻辑深度。 */
  logicalDepth: number
  /** 正交归一基的规模（≤ maxBasis，已丢弃线性相关向量）。 */
  basisSize: number
  /** 实际投影的层数（≤ maxLayers；提前满足停止条件会更少）。 */
  layers: number
  /** K = 参与投影且能量 > 0 的基个数。 */
  projectedBasis: number
  /** 本次使用的 novelty 阈值（打印出来，读者才能自行复算 expanded）。 */
  noveltyThreshold: number
  /** 是否扩检索：novelty >= noveltyThreshold。**与 lowConfidence 无关**（低置信不否决）。 */
  expanded: boolean
  /**
   * 查询是否**没有**词元能量（‖q‖² ≈ 0，I2.1 修 2）。
   * true ⇒ 本查询**未做分诊**：novelty=0、expanded=false、explainedRatio/residualRatio
   * 回显 0/0（未定义）。上层必须在表头如实写明「无词元能量，未分诊」，不许假装算过。
   */
  noQueryEnergy: boolean
}

/**
 * 残差金字塔：在词法向量空间里对基做 Gram-Schmidt 正交化，逐层投影查询向量，
 * 用「被解释的能量比例 / 残差方向是否是新方向 / 投影熵」三件事给查询分诊。
 *
 * 分工：本函数只算分诊量（纯函数，无 IO、无全局状态）；扩检索与低置信报告在召回层做，
 * 因为那要碰候选集与展示分。
 *
 * directionConsistency（**我的定义，必须写清，因为字面写法是退化量**）：
 * 先记一个结构性事实：基做过 Gram-Schmidt，投影是**正交投影**，于是
 * R = q − Σ_{i≤layers} c_i·u_i 必然与**所有已参与投影的基向量**正交，特别地 ⟨R, u_1⟩ ≡ 0。
 * 所以「残差方向与第一层投影方向的余弦」的字面写法 1 − |cos(R, u_1)| 恒等于 1
 * （只要 layers ≥ 1 且 R ≠ 0）—— 它不携带任何信息，还会给每个有残差的查询白送 0.3 分。
 * 这个量的本意是「残差是不是一个新方向」，所以我把定义挪到**尚未参与投影的基向量**上：
 *
 *   directionConsistency = 1 − max_{j > layers} |cos(R, u_j)|      （u_j 是单位基向量）
 *
 * 语义：残差若仍落在「基里还留着、这几层没用上」的方向上 ⇒ 不是新方向（→0）；
 * 残差若与所有未投影基向量都正交 ⇒ 基给不出这个方向（→1）。
 * 边界（都不许出 NaN）：
 *   - ‖R‖² ≈ 0（查询被基完全解释）⇒ 没有残差方向 ⇒ 定义 0
 *     （于是「完全被解释 ⇒ novelty = 0」，不会因为余项白拿分）；
 *   - 未投影基为空（layers = basisSize）而 R ≠ 0 ⇒ max 取 0 ⇒ 定义 1
 *     （残差按构造与本基子空间正交，确实是新方向）；
 *   - 一个基向量都没有（basisSize = 0）而 R ≠ 0 ⇒ 同样 1（没有任何方向能解释它）。
 *
 * I2.1 修 2（空查询不做分诊）：‖q‖² ≈ 0 时**直接短路返回**（见函数体），
 * novelty=0、expanded=false、explainedRatio=residualRatio=0（0/0 未定义，见那里的长注释）。
 */
export function residualPyramid(
  query: unknown,
  basisCandidates: ReadonlyArray<PyramidBasisItem | null | undefined>,
  stats: CorpusStats,
  opts: TriageOptions = {},
): PyramidResult {
  // ★ 请求级隔离：以下全部是局部变量。这里没有、也不许有模块级缓存（见本文件顶部红线）。
  const cfg = resolveTriageOptions(opts)
  const q = tagVector(tokenize(query), stats)
  const qEnergy = sparseNorm2(q)

  // 基：从高分候选里取前 maxBasis 个（调用方已按 rel 降序 / 融合秩 / id 排好）。
  const raw: Array<Map<string, number>> = []
  for (const cand of basisCandidates) {
    if (raw.length >= cfg.maxBasis) break
    if (cand === null || cand === undefined) continue
    const v = tagVector(tokenize(normalizedTags(cand.tags).join(' ')), stats)
    if (v.size === 0) continue
    raw.push(v)
  }
  const ortho = gramSchmidt(raw)

  // ── I2.1 修 2：查询无词元能量 ⇒ **不做分诊**（显式短路）────────────────────
  // ‖q‖² ≈ 0 时投影、残差、explained/residual 全是 0/0，没有「能量」可分：
  // 旧实现按公式走 explained=0、residual=1 ⇒ novelty = 0.7×1 + 0.3×0 = 0.7
  // ⇒ expanded=true，语义荒谬（「什么都没问」≙「最新颖」，实测 novelty=0.7）。
  // 现在显式短路：novelty=0、expanded=false；两个比值**如实回显 0/0**
  // （0/0 未定义，不假造一个 1 去凑守恒式）；noQueryEnergy=true 让上层写明「未分诊」。
  // basisSize 仍如实回显（基池确实算过），layers/projectedBasis=0（没做任何投影）。
  // 注意：**不是**把它们塞进公式再钳位 —— 那样 reader 仍会拿 0.7 去复现 expanded。
  if (!(qEnergy > PYRAMID_EPS)) {
    return {
      novelty: 0,
      explainedRatio: 0,
      residualRatio: 0,
      directionConsistency: 0,
      projectionEntropy: 0,
      logicalDepth: 0,
      basisSize: ortho.length,
      layers: 0,
      projectedBasis: 0,
      noveltyThreshold: cfg.noveltyThreshold,
      expanded: false,
      noQueryEnergy: true,
    }
  }

  // 逐层投影：最多 maxLayers 层；每层后残差能量 < residualStop × 原始能量就停。
  const energies: number[] = []
  let residualVec = new Map<string, number>(q)
  let projEnergy = 0
  for (const u of ortho) {
    if (energies.length >= cfg.maxLayers) break
    const c = sparseDot(q, u)
    const e = c * c
    energies.push(e)
    projEnergy += e
    if (c !== 0) residualVec = sparseSub(residualVec, sparseScale(u, c))
    if (qEnergy - projEnergy < cfg.residualStop * qEnergy) break
  }

  // 走到这里保证 qEnergy > PYRAMID_EPS ⇒ 比值有限（不会 0/0 泄 NaN）。
  const explainedRatio = clamp01(projEnergy / qEnergy)
  // 守恒：residualRatio 直接取 1 − explainedRatio（代数上等于 ‖R‖²/‖q‖²，
  // 且天然有限、和恒为 1，不会因为浮点除零泄 NaN）。
  // 空查询（无词元能量）已在上面短路 ⇒ 本式子只在 qEnergy > PYRAMID_EPS 时执行。
  const residualRatio = clamp01(1 - explainedRatio)

  const rEnergy = sparseNorm2(residualVec)
  let directionConsistency = 0
  if (rEnergy > PYRAMID_EPS) {
    let maxCos = 0
    for (let j = energies.length; j < ortho.length; j += 1) {
      const u = ortho[j]
      if (u === undefined) continue
      const cos = Math.abs(sparseDot(residualVec, u) / Math.sqrt(rEnergy))
      if (Number.isFinite(cos) && cos > maxCos) maxCos = cos
    }
    directionConsistency = clamp01(1 - maxCos)
  }

  const ent = projectionEntropy(energies)
  const novelty = clamp01(NOVELTY_RESIDUAL_WEIGHT * residualRatio + NOVELTY_DIRECTION_WEIGHT * directionConsistency)
  return {
    novelty,
    explainedRatio,
    residualRatio,
    directionConsistency,
    projectionEntropy: ent.entropy,
    logicalDepth: ent.logicalDepth,
    basisSize: ortho.length,
    layers: energies.length,
    projectedBasis: ent.k,
    noveltyThreshold: cfg.noveltyThreshold,
    expanded: novelty >= cfg.noveltyThreshold,
    noQueryEnergy: false,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// I3：有序双向标签共现图 + 有界脉冲传播（浪潮）
//
// 目标：让「与查询无任何词法重合、但与某条命中记录共享标签」的记忆也能被召回，
// 同时**绝不让高频「万能标签」把候选边界污染掉**。
//
// 【纪律 1：禁止线性累加 —— 第三方已回退过「累计边权 + 枢纽吸积 + 循环回流」】
//   - 边权一律先 log(1 + λW) 压缩（λ = GRAPH_LAMBDA），不做 ΣW 线性累加；
//   - 每个节点的出边总权重归一化到固定预算 GRAPH_OUT_BUDGET（默认 1）——
//     「一个节点最多只能把这么多能量分出去」，高频标签因此无法靠频次无限放大；
//   - 枢纽（出现频次显著高于全库中位数的标签）额外乘一个抑制因子
//     α = clip((s_in / median)^(−η))，η = GRAPH_HUB_ETA（默认 0.5）：越像万能标签越被压。
//   - 综合效果：每个节点的出流总预算恒 <= GRAPH_OUT_BUDGET，且枢纽节点被压得更低
//     ⇒ 既不会「枢纽吸积」，也不会有「循环回流放大」。
//
// 【纪律 2：图是「当前记忆库」的纯函数】
//   每次调用从 records 现建，**没有任何模块级可变状态**。
//   如果将来为了性能想缓存它，缓存键必须严格是 {path, size, mtimeMs}（幂等只读），
//   与 I4a 注入缓存同类；**禁止**像 I2 残差金字塔那样把「请求级中间状态」提到模块级
//   （见本文件顶部 I2 红线）：那是跨请求污染，这里说的是「同一份文件内容的纯函数结果」，
//   两者不是一类东西，不要互相套用。
//
// 【纪律 3：传播必须有界且确定】
//   maxHops（跳数上限）/ maxStates（状态数上限）/ maxFieldNeighbors（每节点最强出边条数）
//   三条硬上限；邻居排序用确定的多级键（权重降序 → 标签码元升序），同输入必同输出。
//   立即回流抑制 ρ：不许沿刚来的那条边原路返回（去环、防「循环回流」）。
//
// 【纪律 4：图奖励只奖不罚，且有硬上限】
//   无任何图证据的记忆奖励**恰好为 0**；单条记忆的图奖励**绝不允许**超过
//   GRAPH_BONUS_CAP（默认 0.018，第三方「辅助奖励硬上限」的量级）。
//   图奖励只是**辅助**：它不能压过词法相关度，更不许整批否决或返回空。
// ─────────────────────────────────────────────────────────────────────────────

/** 边权 / 频次的 log 压缩系数 λ（起点 1，**待真实语料标定**）。 */
export const GRAPH_LAMBDA = 1
/** 每个节点的出边总权重预算上限 m_out（起点 1，**待真实语料标定**）。 */
export const GRAPH_OUT_BUDGET = 1
/** 枢纽校正指数 η（起点 0.5，**待真实语料标定**）。 */
export const GRAPH_HUB_ETA = 0.5
/** 传播跳数上限（起点 2，**待真实语料标定**）。 */
export const GRAPH_MAX_HOPS = 2
/** 传播状态数上限（起点 64，**待真实语料标定**）。 */
export const GRAPH_MAX_STATES = 64
/** 每个节点最多沿多少条最强出边扩散（起点 4，**待真实语料标定**）。 */
export const GRAPH_MAX_FIELD_NEIGHBORS = 4
/** 每跳衰减 γ（起点 0.60，**待真实语料标定**）。 */
export const GRAPH_DECAY = 0.6
/** 立即回流抑制 ρ（起点 0.15）：不许沿刚来的那条边原路返回。 */
export const GRAPH_BACKFLOW_RHO = 0.15
/** 图奖励硬上限（起点 0.018，**待真实语料标定**）：第三方「辅助奖励硬上限」的量级。 */
export const GRAPH_BONUS_CAP = 0.018
/**
 * 「标签激活 → 记忆图奖励」的折算系数 K（**待真实语料标定**）：
 *
 *   graph(记录) = min(GRAPH_BONUS_CAP, K × graphBonusRaw(记录))
 *   graphBonusRaw(记录) = max_{t ∈ 记录标签, t 有激活} activation(t)
 *
 * 其中 activation(t) ∈ (0,1] 是本次传播得到的归一化标签激活（activationMin 以下不算证据）。
 * 说明：**只用激活、不再乘「标签出边权」**。理由：出边权已经在传播里用过一次了
 * （每跳 gain = 出边权 × 上游激活 × γ × (1−ρ)），再乘一次等于把同一个结构因子平方计入；
 * 更要紧的是「终端标签」（只有入边、没有出边的收敛点）会让加权版恒为 0 —— 而它恰恰是
 * 波浪走到终点时最该被标记的那类证据。传播本身已经同时体现「log 压缩 + 出流预算 + 枢纽抑制」
 * 三个约束，激活值就是它们的合成结果，直接取用即可。
 *
 *   - 取 **max** 不取和：标签多的记录 / 万能标签不得白拿加成 —— 那正是本机制要防的污染路径；
 *   - activation <= 1 ⇒ graphBonusRaw <= 1 ⇒ `min(bonusCap, K × ...)` 的硬上限恒成立；
 *   - **没有任何图证据 ⇒ 恰好 0**（只奖不罚，绝不因此整批否决或返回空）。
 *
 * K 越小 ⇒ 硬上限越少被触发、图奖励越平缓（**K 是「标定旋钮」，先用留有余量的起点值**）。
 */
export const GRAPH_BONUS_SCALE = 0.25
/** 标签激活的下限：低于它不算「有图证据」（也就不会给任何记忆加奖励）。 */
export const GRAPH_ACTIVATION_MIN = 0.05
/** 传播/图算术的零判定阈值。 */
export const GRAPH_EPS = 1e-12

/** I3 图与传播口径（全部有模块级默认常数，可经工具配置覆盖）。 */
export interface GraphOptions {
  /** log 压缩系数 λ。 */
  lambda?: number
  /** 每个节点的出流总预算 m_out。 */
  outBudget?: number
  /** 枢纽校正指数 η。 */
  hubEta?: number
  /** 传播跳数上限（0 = 关掉传播：所有图奖励恒为 0）。 */
  maxHops?: number
  /** 传播状态数上限（0 = 关掉传播）。 */
  maxStates?: number
  /** 每节点最强出边条数。 */
  maxFieldNeighbors?: number
  /** 每跳衰减 γ。 */
  decay?: number
  /** 立即回流抑制 ρ。 */
  backflowRho?: number
  /** 图奖励硬上限。 */
  bonusCap?: number
  /** 「标签激活 → 记忆奖励」折算系数 K。 */
  bonusScale?: number
  /** 标签激活下限。 */
  activationMin?: number
}

/** 已解析（always 有值）的图口径。 */
export interface ResolvedGraphOptions {
  lambda: number
  outBudget: number
  hubEta: number
  maxHops: number
  maxStates: number
  maxFieldNeighbors: number
  decay: number
  backflowRho: number
  bonusCap: number
  bonusScale: number
  activationMin: number
}

/** 有界解析：非法值一律回落模块级默认；maxHops/maxStates 允许取 0（= 关掉传播）。 */
export function resolveGraphOptions(opts?: GraphOptions): ResolvedGraphOptions {
  const o = opts ?? {}
  return {
    lambda: finiteOr(o.lambda, GRAPH_LAMBDA) > 0 ? finiteOr(o.lambda, GRAPH_LAMBDA) : GRAPH_LAMBDA,
    outBudget: finiteOr(o.outBudget, GRAPH_OUT_BUDGET) > 0 ? finiteOr(o.outBudget, GRAPH_OUT_BUDGET) : GRAPH_OUT_BUDGET,
    hubEta: Math.max(0, finiteOr(o.hubEta, GRAPH_HUB_ETA)),
    maxHops: clampInt(o.maxHops, GRAPH_MAX_HOPS, 0, 8),
    maxStates: clampInt(o.maxStates, GRAPH_MAX_STATES, 0, 4096),
    maxFieldNeighbors: clampInt(o.maxFieldNeighbors, GRAPH_MAX_FIELD_NEIGHBORS, 0, 64),
    decay: clamp01(finiteOr(o.decay, GRAPH_DECAY)),
    backflowRho: clamp01(finiteOr(o.backflowRho, GRAPH_BACKFLOW_RHO)),
    bonusCap: Math.max(0, finiteOr(o.bonusCap, GRAPH_BONUS_CAP)),
    bonusScale: Math.max(0, finiteOr(o.bonusScale, GRAPH_BONUS_SCALE)),
    activationMin: Math.max(0, finiteOr(o.activationMin, GRAPH_ACTIVATION_MIN)),
  }
}

/** 有向边 (from -> to) 的原始计数与 log 压缩权（方向**分开记**，不合成一个数）。 */
export interface DirectedEdgeWeight {
  from: string
  to: string
  /** 原始计数 W。 */
  w: number
  /** log(1 + λW) —— 压缩后的权。 */
  compressed: number
}

/**
 * 某个标签的出边（**双向对称视图**，用于扩散与预算）：
 * 两个方向各自压缩后再相加，且 **两个方向的原始计数分别保留**（forward/backward），
 * 读者可以分别取到方向信息，也可以只看对称聚合。
 */
export interface OutEdge extends DirectedEdgeWeight {
  /** outRaw = 该标签在记录里紧跟着 to 出现的次数。 */
  outRaw: number
  /** inRaw = to 在记录里紧跟着该标签出现的次数。 */
  inRaw: number
  /** 最终权重（两次归一化 + 枢纽校正之后）；同一 from 的出边权重和 <= m_out。 */
  weight: number
}

/** 图里一个标签节点。 */
export interface GraphTagNode {
  /** 归一化后的标签串（trim + 小写，与 store 落盘口径一致）。 */
  tag: string
  /** 出度（不同后继标签个数）。 */
  outDeg: number
  /** 入度（不同前驱标签个数）。 */
  inDeg: number
  /** 全库出现频次（出现该标签的记录数）。 */
  inCount: number
  /** 出流总权重（= Σ 出边最终 weight，恒 <= m_out）。 */
  outFlow: number
  /** 枢纽校正因子 α ∈ (0,1]；非枢纽恰好为 1；被压过（α<1）即计入 hubSuppressed。 */
  hubFactor: number
  /** 该标签的**对称**出边（已归一化 + 已枢纽校正），按 weight 降序 → 码元升序。 */
  outEdges: OutEdge[]
  /** 该标签的**前驱**标签（对称口径），按压缩权降序 → 码元升序。 */
  inNeighbors: string[]
}

/** 标签共现索引（当前记忆库的纯函数结果）。 */
export interface TagGraphIndex {
  nodes: GraphTagNode[]
  /** 标签 → 节点下标。 */
  index: Map<string, number>
  /** 有向边数（**两个方向分别计数**）。 */
  directedEdges: number
  /** 两个方向原始计数之和 > 0 的标签对个数（对称视图的边数）。 */
  symmetricEdges: number
  /** 入度中位数（枢纽判定的基准）。 */
  medianIn: number
  /** 被枢纽校正压过的标签（α < 1），按码元升序；对应「全部去重」口径。 */
  hubSuppressed: string[]
  /** 全库出现频次严格大于中位数、因而被判定为枢纽的标签数。 */
  hubSuppressedCount: number
  /** 所有出边 weight 之和（<= 节点数 × m_out）。 */
  totalOutWeight: number
}

/** 有序对键：`长度:标签` 拼接，避免 'a|b' 与 'a|b|c' 之类的歧义。 */
function pairKey(a: string, b: string): string {
  return `${a.length}:${a}${b.length}:${b}`
}

/**
 * 从记录集构建**有序双向**标签共现图（纯函数；每次现建，无模块级状态）。
 *
 * 边定义：对每条记录的规范化标签序列 t0..t_{k-1}，为每个 i 记一条有向边
 * `(t_i -> t_{i+1})`（相邻对；自环跳过）。同一对标签的两个方向**分别计数**：
 * `(A -> B)` 记 forward、`(B -> A)` 记 backward，绝不合成一个数。
 *
 * 权重（禁止线性累加）：
 *   1. 对称压缩权 `c(u,v) = log(1 + λ·(forward + backward))`；
 *   2. 每个节点的出边按 c 归一化到总预算 `m_out`：`p(u->v) = m_out · c / Σc`；
 *      （按 c 归一化、再按 c 分配 ⇒ 低权出边被压到接近 0，但**不会整条消失**；
 *        若出现「Σc 里有零权项」的退化输入，则对正权项按权重分配、零权项给 0。）
 *   3. 枢纽校正：**枢纽判定 = 入度 >= 中位数 + 1**（「显著高于中位数」的可操作定义；
 *      median = 0 时**没有任何枢纽**，避免空库/单标签库上误压），
 *      `α(u) = clip((inDeg(u) / max(1, median))^(-η))`（非枢纽恒为 1），
 *      `weight(u->v) = p(u->v) · α(u)`（先预算、后枢纽 ⇒ 预算恒成立，枢纽只在其内再分配）。
 *      【为什么不用「入度 > 中位数」】：标签少的小库常常 median = 1，那时任何入度 2 的普通
 *      标签都会被误判成枢纽并被压到 0.7 倍 —— 实测这会连带压低「普通节点」的传播
 *      （calib4 夹具里 alpha 被误压，万能标签的激活反而更小）。加 1 的门槛把「比多数标签
 *      都更常见」和「稍微常见一点」分开，只有真正的万能标签才落入抑制区间。
 *
 * memo 是**调用级**（构建过程中）的临时缓存，直接建在节点对象上；它不跨调用存活，
 * 也不依赖任何模块级变量 —— 与 I2 禁止的「请求级状态提模块级」不是一回事。
 */
export function tagGraphIndex(records: ReadonlyArray<{ tags?: unknown } | null | undefined>, opts?: GraphOptions): TagGraphIndex {
  const cfg = resolveGraphOptions(opts)

  // ── 1. 计数（方向分开；顺序只在记录内体现，跨记录不合成）──────────────
  const ordered = new Map<string, { from: string; to: string; w: number }>()
  const inCountMap = new Map<string, number>()
  const outCount = new Map<string, Set<string>>()
  const inCount = new Map<string, Set<string>>()
  for (const rec of records) {
    if (rec === null || rec === undefined) continue
    const tags = normalizedTags(rec.tags)
    for (const t of tags) inCountMap.set(t, (inCountMap.get(t) ?? 0) + 1)
    for (let i = 0; i + 1 < tags.length; i += 1) {
      const from = tags[i]
      const to = tags[i + 1]
      if (from === undefined || to === undefined || from === to) continue
      const key = pairKey(from, to)
      const cur = ordered.get(key)
      if (cur === undefined) ordered.set(key, { from, to, w: 1 })
      else cur.w += 1
      let os = outCount.get(from)
      if (os === undefined) { os = new Set(); outCount.set(from, os) }
      os.add(to)
      let is = inCount.get(to)
      if (is === undefined) { is = new Set(); inCount.set(to, is) }
      is.add(from)
    }
  }

  // ── 2. 对称压缩权（两个方向各自 log 压缩后相加；**两个方向的压缩权都写进表**，
  //      这样从任一端出发都能取到同一条对称边的权）────────────────────────
  const compressed = new Map<string, number>()
  /** 每条有向边自己方向的出现次数（forward）。 */
  const forwardCount = new Map<string, number>()
  /** 每条有向边反方向的出现次数（backward）。 */
  const backwardCount = new Map<string, number>()
  /** 已处理过的有向边（两个方向都登记，避免同一条对称边被算两次）。 */
  const symmetricSeen = new Set<string>()
  /** 对称视图的边（无序标签对）集合，用来数 symmetricEdges。 */
  const pairSeen = new Set<string>()
  for (const e of ordered.values()) {
    const k = pairKey(e.from, e.to)
    if (symmetricSeen.has(k)) continue
    // 反向那条边（to -> from）的原始计数：这才是 e 这条边的 backward 计数。
    const rev = ordered.get(pairKey(e.to, e.from))?.w ?? 0
    const fwd = e.w
    const c = logCompress(fwd + rev, cfg.lambda)
    symmetricSeen.add(k)
    symmetricSeen.add(pairKey(e.to, e.from))
    // 无序标签对只登记一次（symmetricEdges = 对称视图的边数）。
    const lo = e.from < e.to ? e.from : e.to
    const hi = e.from < e.to ? e.to : e.from
    pairSeen.add(`${lo.length}:${lo}${hi.length}:${hi}`)
    compressed.set(k, c)
    compressed.set(pairKey(e.to, e.from), c)
    // 两个方向的原始计数分开存（不合成一个数）：
    // forwardCount = 该方向出现的次数，backwardCount = 反方向出现的次数。
    forwardCount.set(k, fwd)
    backwardCount.set(k, rev)
    forwardCount.set(pairKey(e.to, e.from), rev)
    backwardCount.set(pairKey(e.to, e.from), fwd)
  }

  // ── 3. 入度中位数（枢纽基准，上中位以避免浮点平均）──────────────────
  const sortedIn = [...inCountMap.values()].sort((a, b) => a - b)
  const medianIn = sortedIn.length === 0 ? 0 : (sortedIn[Math.floor((sortedIn.length - 1) / 2)] ?? 0)

  // ── 4. 节点 + 出边（预算归一 → 枢纽校正）────────────────────────────
  const nodes: GraphTagNode[] = []
  const index = new Map<string, number>()
  const hubSuppressed: string[] = []
  let hubSuppressedCount = 0
  let totalOutWeight = 0
  let directedEdges = 0
  const allTags = [...inCountMap.keys()].sort((a, b) => cmpId(a, b))
  for (const tag of allTags) {
    const raw: OutEdge[] = []
    for (const [key, cw] of compressed) {
      const e = ordered.get(key)
      if (e === undefined || e.from !== tag) continue
      // 两个方向的原始计数分别保留（forward = 本方向，backward = 反方向）。
      raw.push({
        from: tag,
        to: e.to,
        w: cw,
        compressed: cw,
        outRaw: forwardCount.get(key) ?? e.w,
        inRaw: backwardCount.get(key) ?? 0,
        weight: 0,
      })
      directedEdges += 1
    }
    raw.sort((a, b) => (b.compressed - a.compressed) || cmpId(a.to, b.to))

    const sum = raw.reduce((acc, e) => acc + e.compressed, 0)
    const scale = sum > 0 ? cfg.outBudget / sum : 0
    // 枢纽判定：入度 >= 中位数 + 1（且 median > 0）；抑制因子用全局出现频次算
    // （频次比入度更能反映「万能标签」的广覆盖，且天然 >= 入度）。
    const deg = (inCount.get(tag) ?? new Set<string>()).size
    const freq = inCountMap.get(tag) ?? 0
    const isHub = medianIn > 0 && deg >= medianIn + 1
    const hubFactor = isHub ? clamp01((freq / medianIn) ** -cfg.hubEta) : 1
    let outFlow = 0
    for (const e of raw) {
      const w = (Number.isFinite(e.compressed) ? e.compressed : 0) * scale * hubFactor
      e.weight = Number.isFinite(w) && w > 0 ? w : 0
      outFlow += e.weight
    }
    if (hubFactor < 1) { hubSuppressed.push(tag); hubSuppressedCount += 1 }
    totalOutWeight += outFlow
    index.set(tag, nodes.length)
    nodes.push({
      tag,
      outDeg: raw.length,
      inDeg: (inCount.get(tag) ?? new Set<string>()).size,
      inCount: inCountMap.get(tag) ?? 0,
      outFlow,
      hubFactor,
      outEdges: raw,
      inNeighbors: [...new Set((inCount.get(tag) ?? new Set<string>()))].sort((a, b) => cmpId(a, b)),
    })
  }

  return {
    nodes,
    index,
    directedEdges,
    symmetricEdges: pairSeen.size,
    medianIn,
    hubSuppressed,
    hubSuppressedCount,
    totalOutWeight,
  }
}

/** 便捷包装：只要「节点数 / 有向边数」（召回层报告用）。 */
export function tagGraphSize(records: ReadonlyArray<{ tags?: unknown } | null | undefined>, opts?: GraphOptions): { nodes: number; edges: number } {
  const g = tagGraphIndex(records, opts)
  return { nodes: g.nodes.length, edges: g.directedEdges }
}

/** 一条候选记忆的图奖励（graph 字段）。 */
export interface MemoryGraphReward {
  id: string
  /** 已应用硬上限的图奖励（[0, graphBonusCap]，4 位小数打印）。 */
  bonus: number
  /** 最强证据标签（激活 × 权最大者；码元升序决胜），无证据为 ''。 */
  viaTag: string
  /** 该标签的激活值。 */
  activation: number
}

/** 传播结果（全部是本次调用的局部量）。 */
export interface TagPropagation {
  /** 所有到达状态的标签 → 激活值（降序）。 */
  nodes: Array<{ tag: string; weight: number }>
  /** 通过 activationMin 的标签（降序）。 */
  propagated: Array<{ tag: string; weight: number }>
  /** 新达到标签的跳数（1 = 直接邻居）。 */
  hops: number
  /** 实际展开的状态数（<= maxStates）。 */
  statesUsed: number
  /** 是否撞上状态数上限。 */
  statesTruncated: boolean
  /** 种子标签（本次直接命中的标签，码元升序）。 */
  seeds: string[]
}

/**
 * 有界脉冲传播（浪潮）：从本次直接命中的标签出发沿出边扩散。
 *
 * 规则（全部显式有上限，见 GraphOptions）：
 *  - 种子激活 = 1；
 *  - 每跳衰减 γ，立即回流抑制 ρ（不许沿刚来的那条边原路返回）；
 *  - 每个节点最多取 maxFieldNeighbors 条最强出边（权重降序 → 目标标签码元升序）；
 *  - maxHops 跳内结束；状态总数 <= maxStates；
 *  - 一个标签被多次到达时取**最大**激活（重新入队），保证结果与到达顺序无关；
 *  - 「状态」= 展开一个节点一次，总数 <= maxStates（这条在 for 条件里硬保证）。
 *
 * 确定性：邻居排序用确定的多级键；优先队列的比较器是全序；同输入必同输出。
 */
export function propagateTags(
  seeds: Iterable<string>,
  graph: TagGraphIndex,
  opts?: GraphOptions,
): TagPropagation {
  // ★ 请求级隔离：以下全部是本次调用的局部量（没有模块级缓存、没有跨请求复用）。
  const cfg = resolveGraphOptions(opts)
  const seedList = [...new Set(seeds)].filter((s) => typeof s === 'string' && s !== '').sort((a, b) => cmpId(a, b))
  const nodesMap = new Map<string, { tag: string; weight: number; hop: number }>()
  const propagated: Array<{ tag: string; weight: number }> = []
  // 空种子 / maxHops=0 / maxStates=0 ⇒ 不传播（图奖励恒为 0，是显式的关断点）。
  if (seedList.length === 0 || cfg.maxHops <= 0 || cfg.maxStates <= 0) {
    return { nodes: propagated, propagated, hops: 0, statesUsed: 0, statesTruncated: false, seeds: seedList }
  }

  const queue: Array<{ tag: string; weight: number; hop: number }> = []
  const prev = new Map<string, string>()
  /** 优先队列插队：全序比较器 ⇒ 与插入顺序无关。 */
  const push = (item: { tag: string; weight: number; hop: number }): void => {
    let lo = 0
    let hi = queue.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const at = queue[mid]
      if (at === undefined) break
      const better = item.weight > at.weight
        || (item.weight === at.weight && (item.hop < at.hop || (item.hop === at.hop && cmpId(item.tag, at.tag) < 0)))
      if (better) hi = mid
      else lo = mid + 1
    }
    queue.splice(lo, 0, item)
  }

  for (const s of seedList) {
    if (nodesMap.has(s)) continue
    nodesMap.set(s, { tag: s, weight: 1, hop: 0 })
    push({ tag: s, weight: 1, hop: 0 })
  }

  let statesUsed = 0
  let statesTruncated = false
  let maxHopReached = 0
  // 状态数与 re-activation 次数都受 maxStates 约束 ⇒ 工作量有界（不会 O(n²) 爆炸）。
  const maxAttempts = cfg.maxStates * 4
  for (let attempt = 0; attempt < maxAttempts && statesUsed < cfg.maxStates && queue.length > 0; attempt += 1) {
    const cur = queue.shift()
    if (cur === undefined) break
    statesUsed += 1
    const ni = graph.index.get(cur.tag)
    const node = (ni === undefined ? undefined : graph.nodes[ni]) as GraphTagNode | undefined
    if (node === undefined || cur.hop >= cfg.maxHops) continue
    const from = prev.get(cur.tag)
    const budget = cfg.maxFieldNeighbors
    let taken = 0
    for (const e of node.outEdges) {
      if (taken >= budget) break
      if (e.weight <= 0) continue
      if (from !== undefined && e.to === from) continue // 立即回流抑制 ρ
      taken += 1
      const gain = e.weight * cur.weight * cfg.decay * (1 - cfg.backflowRho)
      if (!Number.isFinite(gain) || gain <= 0) continue
      const hop = cur.hop + 1
      if (hop > maxHopReached) maxHopReached = hop
      const existing = nodesMap.get(e.to)
      if (existing !== undefined) {
        if (hop < existing.hop || gain > existing.weight) {
          if (statesUsed >= cfg.maxStates) { statesTruncated = true; break }
          existing.weight = gain
          existing.hop = hop
          prev.set(e.to, cur.tag)
          push({ tag: e.to, weight: gain, hop })
        }
        continue
      }
      // 新状态必须占用一个名额：名额用完就**如实标记截断**（绝不悄悄多走一步）。
      if (statesUsed >= cfg.maxStates) { statesTruncated = true; break }
      nodesMap.set(e.to, { tag: e.to, weight: gain, hop })
      prev.set(e.to, cur.tag)
      push({ tag: e.to, weight: gain, hop })
    }
  }

  for (const item of nodesMap.values()) {
    if (!(item.weight >= cfg.activationMin)) continue
    propagated.push({ tag: item.tag, weight: item.weight })
  }
  propagated.sort((a, b) => (b.weight - a.weight) || cmpId(a.tag, b.tag))
  // 还有未展开的节点，或状态名额已用尽 ⇒ 传播被上限如实截断。
  // （循环条件在「名额用尽」时会直接退出，不经过循环体内的赋值点，所以这里必须补判一次。）
  if (queue.length > 0 || statesUsed >= cfg.maxStates) statesTruncated = true
  return { nodes: propagated, propagated, hops: maxHopReached, statesUsed, statesTruncated, seeds: seedList }
}

/**
 * 「标签激活 → 每条记忆的图奖励」折算（**本机制的公式，必须写清**）：
 *
 *   对记录 r：graph(r) = min(bonusCap, K × max_{t ∈ tags(r), t 有激活} activation(t))
 *
 *   - activation(t) ∈ (0,1] 是传播值（activationMin 以下的标签不参与，等价于「无证据」）；
 *   - 取 **max** 不取和：标签个数多 / 万能标签不得白拿加成（求和会让标签多的记录恒占便宜）；
 *   - activation <= 1 ⇒ graphBonusRaw <= 1 ⇒ graph(r) <= bonusCap 恒成立；
 *   - 无任何图证据 ⇒ **恰好 0**（只奖不罚，绝不因此整批否决或返回空）。
 *
 * 返回数组与 candidates 一一对应（同分时按标签码元升序决定 viaTag，保证确定性）。
 */
export function memoryGraphRewards(
  candidates: ReadonlyArray<{ id: string; tags?: readonly string[] }>,
  propagated: ReadonlyArray<{ tag: string; weight: number }>,
  graph: TagGraphIndex,
  opts?: GraphOptions,
): MemoryGraphReward[] {
  const cfg = resolveGraphOptions(opts)
  const activation = new Map<string, number>()
  for (const p of propagated) {
    if (typeof p.tag !== 'string' || p.tag === '') continue
    if (!Number.isFinite(p.weight) || p.weight <= 0) continue
    // 激活下限也在这里再筛一次：reward 层不假设调用方已经按 activationMin 过滤过
    // （纯函数层各自守自己的契约；否则 activationMin 只在传播里生效，这里是静默漏筛）。
    if (p.weight < cfg.activationMin) continue
    activation.set(p.tag, p.weight)
  }
  const out: MemoryGraphReward[] = []
  for (const cand of candidates) {
    let best = 0
    let bestTag = ''
    let bestActivation = 0
    for (const rawTag of cand.tags ?? []) {
      const tag = typeof rawTag === 'string' ? rawTag.trim().toLowerCase() : ''
      if (tag === '') continue
      const act = activation.get(tag)
      if (act === undefined) continue
      const value = act * cfg.bonusScale
      if (value > best || (value === best && value > 0 && cmpId(tag, bestTag) < 0)) {
        best = value
        bestTag = tag
        bestActivation = act
      }
    }
    const capped = best > cfg.bonusCap ? cfg.bonusCap : best
    out.push({ id: cand.id, bonus: capped > 0 ? capped : 0, viaTag: capped > 0 ? bestTag : '', activation: bestActivation })
  }
  return out
}
