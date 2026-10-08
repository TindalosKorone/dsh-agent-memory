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
 * 展示分绝对区间映射的下界，默认 0。
 * 与 SCALE_B 一起构成「固定绝对区间」：不依赖任何候选的得分。
 */
export const SCALE_A = 0

/**
 * 展示分绝对区间映射的上界（raw 达到它即展示 1.0000）。
 *
 * 【临时默认值，待真实语料标定】依据（offline 夹具，见 test/scoring.test.mjs）：
 * 单条自语料下「query 词元在三字段各命中一次」的强正样本
 *   raw = Σ w·idf·sat / Σ w·idf·(k1+1) = (3+2+1)·idf·1 / ((3+2+1)·idf·2.2) = 1/2.2 ≈ 0.4545
 * 取 0.45 令其映射到 1.0000（clip），同时让「只命中 body 一次」的弱证据落在 ~0.17。
 * 真实语料（N/df/avgdl 分布）标定后应重新取值 —— 这只是自洽的临时默认。
 */
export const SCALE_B = 0.45

/**
 * 绝对判定阈值：raw ≥ WEAK_THRESHOLD 记 weak，raw ≥ STRONG_THRESHOLD 记 strong。
 * 【临时默认值，待真实语料标定】量级来自第三方审计（0.06 / 0.16）。
 */
export const WEAK_THRESHOLD = 0.06
/** 见 WEAK_THRESHOLD。 */
export const STRONG_THRESHOLD = 0.16

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
