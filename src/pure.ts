/**
 * 纯函数层：时间衰减、RRF 多路融合、词法打分、MMR 式去重。
 *
 * 约束：不碰 IO、不 import 任何运行时依赖、给定同一输入必然给出同一输出
 * （排序一律带 id 字典序做最终决胜，杜绝 V8 排序实现差异带来的不确定性）。
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

/** 词法打分的输入（只需标题/正文/标签）。 */
export interface LexicalRecord {
  title?: unknown
  body?: unknown
  tags?: unknown
}

/**
 * 词法重合度打分，归一化到 0..1。
 *
 * 做法：查询词元集合 Q 分别对 tags / title / body 求命中覆盖率，权重 3 / 2 / 1，
 * 再除以权重和 6 ⇒ 天然落在 0..1（tags 权重最高，title 次之，body 最低）。
 */
export function lexicalScore(query: unknown, record: LexicalRecord | null | undefined): number {
  const q = new Set(tokenize(query))
  if (q.size === 0) return 0
  const cover = (text: unknown): number => {
    const toks = new Set(tokenize(text))
    if (toks.size === 0) return 0
    let hit = 0
    for (const t of q) if (toks.has(t)) hit += 1
    return hit / q.size
  }
  const tags = Array.isArray(record?.tags)
    ? (record?.tags as unknown[]).filter((t): t is string => typeof t === 'string').join(' ')
    : ''
  const raw = 3 * cover(tags) + 2 * cover(record?.title) + 1 * cover(record?.body)
  const norm = raw / 6
  return norm < 0 ? 0 : norm > 1 ? 1 : norm
}

export interface DiversifyRecord {
  id: string
  score: number
  tags?: readonly string[]
}

export interface DiversifyOptions {
  /** 相关度与多样性的折中，默认 0.7（1 = 纯按分数，0 = 纯去重）。 */
  lambda?: number
  /** 取回条数上限。 */
  limit?: number
}

/** 标签集合的 Jaccard 相似度；两侧都为空时视为不相似（0），避免惩罚无标签记录。 */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter += 1
  return inter / (a.size + b.size - inter)
}

/**
 * MMR 式去重：`lambda * score - (1 - lambda) * 已选集合最大相似度`。
 * 同标签堆叠会被打散；候选先按 score 降序、id 升序排定，平局保留先出现者 ⇒ 确定性。
 */
export function diversify(records: ReadonlyArray<DiversifyRecord>, opts: DiversifyOptions = {}): DiversifyRecord[] {
  const rawLambda = typeof opts.lambda === 'number' && Number.isFinite(opts.lambda) ? opts.lambda : 0.7
  const lambda = rawLambda < 0 ? 0 : rawLambda > 1 ? 1 : rawLambda
  const limit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0
    ? Math.floor(opts.limit)
    : records.length

  const pool = records.map((rec) => ({
    rec,
    tags: new Set((rec.tags ?? []).map((t) => String(t).trim().toLowerCase()).filter((t) => t !== '')),
  }))
  pool.sort((a, b) => (b.rec.score - a.rec.score) || cmpId(a.rec.id, b.rec.id))

  const picked: typeof pool = []
  const rest = pool.slice()
  while (picked.length < limit && rest.length > 0) {
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
      const mmr = lambda * cand.rec.score - (1 - lambda) * maxSim
      if (mmr > bestVal) { bestVal = mmr; bestIdx = i }
    }
    const chosen = rest[bestIdx]
    if (chosen === undefined) break
    picked.push(chosen)
    rest.splice(bestIdx, 1)
  }
  return picked.map((p) => p.rec)
}
