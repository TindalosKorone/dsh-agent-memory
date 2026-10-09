/**
 * I4a：把一行「稳定记忆索引」注入系统提示词的**尾部动态块**（engine 的 runtime context）。
 *
 * 一、机制（已核实的源码事实，不是猜的）
 *  - 注册入口是 `ctx.systemPrompt.context({ name, order, text })`（dsh-system-prompt/lib/index.js:266-268）。
 *    `order` 必须是有限数字（否则抛 TypeError）；`name` 在同一 scope 内不得重复；`text` 可以是字符串
 *    或 `(assemblyContext) => string`（assemble() 里 `typeof entry.text === "function" ? entry.text(context) : entry.text`）。
 *  - 顺序表是 **CONTEXT_ORDERS**（SANDBOX_POLICY:110 / APPROVAL_POLICY:115 / SUBAGENT_DELEGATION:120），
 *    `getContextOrder()` 对未列名返回 undefined ⇒ 必须自己传显式数字；本插件取 200（落在 120 之后 = 尾部）。
 *  - `text` 会被 `interpolate()` 扫描 `{{name}}` 引用：**未知/畸形引用会抛错**（同文件 interpolate()），
 *    而 inject 函数一旦抛错，整个 `assemble()` 就炸 ⇒ **每一步**都完蛋。所以这里所有动态文本都要过
 *    sanitizeForPrompt()（去掉 `{` `}`），并且整个构建过程 fail-open（catch 里绝不再抛）。
 *  - 落点（dsh-agent-loop/lib/index.js:909-917）：`assemble()` → `renderContextSections(assembly)` →
 *    `joinContextSections(...)` → `this.runtimeContext.project(...)`，project 返回的是**一条 user 消息**
 *    （RuntimeContextProjection.project，同文件 334-346：334 起 project()，337 文本相同即 return，338 起 createUserMessage(source.kind = "runtime-context")），由
 *    `agent/pre-step` 的默认分支 `messages: [...claimed, context]` 追加到本轮消息列表**尾部**，
 *    再由 `this.session.append("user/message", message, ...)`（同文件 1061）落库。**它不改 system prompt 正文**。
 *
 * 二、为什么必须「与查询无关、低频变化」
 *  - project() 只在快照文本与上一份**不同**时才产出消息（`if (this.retained?.text === snapshot) return`），
 *    也就是说：库不变 ⇒ 文本逐字节相同 ⇒ 后续每一步零新增消息、零 prompt 变化（缓存友好）。
 *    一旦把「最近写入的标题」「时间戳」这类每次都在变的实时列表塞进来，就会**每一步都追加一条消息**，
 *    既污染上下文历史，也把前缀缓存打断。
 *  - 所以这里只放：条数 + 全局**有区分力的**标签锚点 + 工具指路。
 *
 * 二点五、I4a.2：锚点为什么必须先做「出现率资格过滤」（本文件的重点修正）
 *  - 现象（真机可见）：导入 185 条坑位语料后，那一行从 `失败关闭 / 假绿 / 区分力` 退化成
 *    `坑位 / 判据 / 快照` —— `坑位` 出现在 94% 的记录上，对读者零信息量，等于给每一步的上下文塞噪音。
 *  - 根因：锚点原规则是「按全局词频取 top-N」，而长尾分布下**「最高频」与「最有区分力」是两回事**：
 *    越接近 100% 的标签越像「整个语料的公共前缀」，它区分不了任何两条记忆。
 *  - 修法：先做**资格过滤**（该标签的记录数 / 总记录数 > ANCHOR_MAX_DF_RATIO 的标签一律不参与），
 *    再在合格集合里按 记录频次降序 → 标签码元升序决胜 取 top-N（全确定）。
 *  - 为什么用「df 上限」而不是 idf 式排序：df 上限卡的是**上端**（覆盖全库的公共标签），这正是
 *    真机上观察到的失效模式；而 idf 单调排序会一路把 df=1 的**一次性标签**（错别字、临时记号）
 *    顶到最前面 —— 那些同样不是「锚点」，只是另一种噪音。两者可以叠加，但本增量只做**有红证的**
 *    那一半：上限。上限口径本身也是 idf 的粗糙形式（df 越小 idf 越大），只是只掐上端、不改排序主键。
 *  - 阈值可配置（injection.anchorMaxDfRatio）；默认 0.3 是**待真实语料标定的起点**（见常数注释）。
 *  - 合格锚点不足 N 个 ⇒ 如实少给；一个都没有 ⇒ 那行写「无可区分锚点」并**绝不回落到全库最高频标签**。
 *
 * 三、关于「缓存」与 I2 红线的边界
 *  - I2 禁止的是**请求级**可变状态（同一个键必须同值：所以这里严禁放进查询、agent、scope、时间）。
 *  - 这里允许的是**幂等的只读缓存**：键严格是文件身份三元组 `{path, size, mtimeMs}`，
 *    同键必同值（纯函数：内容 → 条数 + 锚点）。它与库自身的「外部改动守卫」用的是同一套身份口径
 *    （store.ts 的 StoreStamp），所以不会比库自己更乐观。
 *  - 缓存实例由 apply() 的闭包持有（模块级没有任何可变状态），可注入、可不用（不传就每次真读）。
 */

import { loadSnapshot, memoryPath, resolveMaxRecords, statStamp, type MemoryConfig, type StoreStamp } from './store.js'
import type { MemoryRecord } from './protocol.js'

/** I4a 注入开关与预算（挂在 MemoryConfig.injection 上）。 */
export interface InjectionConfig {
  /** false = 完全不注册、不输出任何字符（默认 true）。 */
  enabled?: boolean
  /** 注入行的**硬字符上限**（默认 240；超过天花板 4000 按 4000 处理）。 */
  maxChars?: number
  /** 标签锚点个数（默认 3；超过天花板 64 按 64 处理）。 */
  topTags?: number
  /**
   * I4a.2 锚点资格过滤的出现率上限（该标签的记录数 / 总记录数，默认 0.3，夹到 0..1）。
   * 严格大于它的标签**不得参与锚点**（覆盖全库的公共标签就此被剔除）。
   * 0 ⇒ 任何出现过的标签都超限（等于「不要锚点」，那行会如实写「无可区分锚点」）；
   * 1 ⇒ 过滤实际关闭（只作对照用，生产不建议）。
   */
  anchorMaxDfRatio?: number
}

/** 解析后的注入口径（解析过程本身绝不抛：字段类型不对就回落默认值）。 */
export interface InjectionOptions {
  enabled: boolean
  maxChars: number
  topTags: number
  anchorMaxDfRatio: number
}

/**
 * 注入贡献的固定名字。引擎侧 context 名在同一 scope 内重复注册会抛错，
 * 所以固定名 + 「注册失败也不抛」的兜底是必需的。
 */
export const INJECTION_CONTEXT_NAME = 'agent-memory'
/**
 * 显式顺序号：CONTEXT_ORDERS 里最大的既有值是 120（SUBAGENT_DELEGATION），
 * 取 200  ⇒ 排在所有既有 context 之后（尾部块）。未列名时 getContextOrder 返回 undefined，
 * 所以这里传显式数字而不是去查表。
 */
export const INJECTION_CONTEXT_ORDER = 200

export const DEFAULT_INJECTION_ENABLED = true
export const DEFAULT_INJECTION_MAX_CHARS = 240
export const DEFAULT_INJECTION_TOP_TAGS = 3
/**
 * I4a.2 锚点资格过滤的出现率上限起点：出现率（含该标签的记录数 / 总记录数）**严格大于**它的标签
 * 一律不参与锚点。**待真实语料标定**：0.3 是「先把覆盖全库的公共标签掐掉」的保守起点
 * （本机 194 条真实库上，`坑位` = 182/194 = 0.938 被剔除，合格集合里最高的是 `判据` 34/194 = 0.175）；
 * 想更严（只留真正稀疏的标签）可下调，例如 0.1；调到 1 等于关掉过滤（只作对照用）。
 */
export const ANCHOR_MAX_DF_RATIO = 0.3
/** 天花板的理由：这一行会进每一步的上下文，配置写错（比如 100000）不能变成一次 prompt 爆炸。 */
export const INJECTION_MAX_CHARS_CEILING = 4000
/** 同上：锚点数有上限，避免在一个手改过的巨大标签空间上做无界排序输出。 */
export const INJECTION_TOP_TAGS_CEILING = 64

/** 锚点分隔符（固定常量，便于目视与断言）。 */
export const ANCHOR_SEP = ' / '
/**
 * 「库里有标签，但一个都没通过资格过滤」时那行的如实说明段。
 * 注意：**库内一条标签都没有**（空库 / 全部无标签）时**不写这一段**（沿用旧的最小行），
 * 两种情形是两回事：前者是「标签区分不了」，后者是「根本没有标签」。
 */
export const ANCHOR_NONE_MARK = '｜无可区分锚点'
/** 尾段：指路到查询工具（记忆正文永远不进 prompt，省 token）。 */
export const INJECTION_TAIL = '｜细则用 memory_recall'
/** 极端超限时的硬截断标记（本身也算进上限）。 */
export const HARD_MARK = '（截断）'

/** 一行注入文本的构建计划（truncated/omitted 用于如实报告，不是装饰）。 */
export interface LinePlan {
  text: string
  truncated: boolean
  omitted: number
}

/** 只读缓存的三元组内容：同键必同值（纯函数：文件内容 → 条数 + 锚点 + 判据留痕）。 */
export interface InjectionCache {
  key: string | undefined
  count: number | undefined
  anchors: string[] | undefined
  /** 库里有标签但一个都没通过资格过滤（决定那行是否写「无可区分锚点」）。 */
  noAnchor: boolean | undefined
  /** 判据留痕（命中缓存时 diag 也必须如实，不能靠锚点数反推）。 */
  distinctTags: number | undefined
  qualifiedTags: number | undefined
}

/** 建一个空缓存；不传缓存给 buildInjectionIndex 就是「每次都真读」（纯函数路径）。 */
export function createInjectionCache(): InjectionCache {
  return {
    key: undefined, count: undefined, anchors: undefined,
    noAnchor: undefined, distinctTags: undefined, qualifiedTags: undefined,
  }
}

/** 诊断字段：fail-open 时也要能看出「为什么没注入」。 */
export interface InjectionDiagnostics {
  ok: boolean
  enabled: boolean
  /** ok | empty-store（库空，给最小占位）| disabled（开关关掉）| read-failed（读/算失败，注入空串）。 */
  code: 'ok' | 'empty-store' | 'disabled' | 'read-failed'
  count: number
  anchors: string[]
  maxChars: number
  chars: number
  truncated: boolean
  omitted: number
  /** 本次是否命中只读缓存（键 = {path,size,mtimeMs}）。 */
  cached: boolean
  /** 失败原因（成功时为空串；绝不参与 prompt）。 */
  detail: string
  /** I4a.2 本次用的锚点资格过滤上限（判据留痕：同一个库换个 ratio 会有不同的 anchors）。 */
  anchorMaxDfRatio: number
  /** 库内出现过的可净化标签总数（去重）；0 = 库里根本没有标签。 */
  distinctTags: number
  /** 通过资格过滤的标签数；distinctTags > 0 而它是 0 ⇒ 那行写「无可区分锚点」。 */
  qualifiedTags: number
}

export interface InjectionResult {
  /** 要注入的一行文本；失败/关掉时是空串（绝不抛）。 */
  text: string
  diag: InjectionDiagnostics
}

function boolOr(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback
}

/** 整数解析：数字/数字串都收，越界夹到 [min,max]，其余回落 fallback。 */
function intOr(raw: unknown, fallback: number, min: number, max: number): number {
  let value = fallback
  if (typeof raw === 'number' && Number.isFinite(raw)) value = Math.floor(raw)
  else if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed)) value = parsed
  }
  if (value < min) return min
  if (value > max) return max
  return value
}

/**
 * 比例解析（0..1）：数字/数字串都收，越界夹到 [0,1]，其余（含 NaN/Infinity/空串）回落 fallback。
 * 注意 Infinity 必须回落而不是夹成 1：它多半意味着调用方算错了，静默夹成「关掉过滤」更危险。
 */
function ratioOr(raw: unknown, fallback: number): number {
  let value: number | undefined
  if (typeof raw === 'number' && Number.isFinite(raw)) value = raw
  else if (typeof raw === 'string') {
    const parsed = Number.parseFloat(raw)
    if (Number.isFinite(parsed)) value = parsed
  }
  if (value === undefined) return fallback
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * 解析注入口径（解析本身绝不抛：配置写错只降级，不炸每一步）。
 * 上限型字段一律夹到天花板；enabled 只认显式 boolean；anchorMaxDfRatio 夹到 0..1。
 */
export function resolveInjectionOptions(cfg?: InjectionConfig | null): InjectionOptions {
  const src = (cfg ?? {}) as InjectionConfig
  return {
    enabled: boolOr(src.enabled, DEFAULT_INJECTION_ENABLED),
    maxChars: intOr(src.maxChars, DEFAULT_INJECTION_MAX_CHARS, 0, INJECTION_MAX_CHARS_CEILING),
    topTags: intOr(src.topTags, DEFAULT_INJECTION_TOP_TAGS, 0, INJECTION_TOP_TAGS_CEILING),
    anchorMaxDfRatio: ratioOr(src.anchorMaxDfRatio, ANCHOR_MAX_DF_RATIO),
  }
}

/**
 * 把任意文本净化成「可安全插值 + 单行」的形式：
 *  - 去掉 `{` `}`：引擎的 interpolate() 会把 `{{name}}` 当变量引用，未注册就**抛错**，
 *    而抛错点在整个 assemble() 里 ⇒ 会在每一步炸掉。锚点来自库（可能被手改成任意字符串），
 *    所以不能只在写入侧信任标签。
 *  - 去掉 C0/C1 控制字符与 Unicode 行分隔符 ⇒ 保证「一行」。
 * 返回长度**永不增长**（只删字符 + 折叠空格），所以先净化后计量即可保证 ≤ maxChars。
 */
export function sanitizeForPrompt(text: string): string {
  let out = ''
  for (const ch of text) {
    if (ch === '{' || ch === '}') continue
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) continue
    if (code === 0x2028 || code === 0x2029) continue
    out += ch
  }
  return out.replace(/ {2,}/g, ' ').trim()
}

/** 码元序比较（与引擎 compareNames 同口径）：全机器一致，不依赖 locale。 */
function cmpCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 锚点选择的中间结果（anchors 之外还带上资格过滤的判据留痕，供 diag 与红证用）。 */
export interface AnchorPlan {
  /** 最终锚点（≤ topTags 个；可能为空 = 如实少给）。 */
  anchors: string[]
  /** 库内出现过的可净化标签总数（去重）；0 = 库里根本没有标签。 */
  distinctTags: number
  /** 通过资格过滤（df 占比 <= maxDfRatio）的标签数。 */
  qualifiedTags: number
}

/**
 * I4a.2 锚点选择：**先资格过滤，再排序取 top-N**。
 *
 * 1) 记录频次 df：每条记录内同名标签只计一次（口径就是「含该标签的记录数」，
 *    与出现率 df/总记录数 同一把尺子，避免「词次」与「记录数」两套口径各说各话）。
 * 2) 资格过滤：df / 总记录数 **严格大于** maxDfRatio 的标签一律剔除 —— 覆盖全库的标签
 *    区分不了任何两条记忆，进 prompt 就是纯噪音。**绝不因为过滤后为空而回落**。
 * 3) 排序：df 降序 → 标签码元升序（决胜确定，不依赖 Map 迭代顺序与 locale）。
 *
 * maxDfRatio 只认有限数字（越界夹到 0..1，非有限值回落默认）；NaN 之类的脏输入不会
 * 变成「不过滤」（那是最危险的静默失效方向）。
 */
export function planAnchors(
  records: ReadonlyArray<MemoryRecord>,
  topTags: number,
  maxDfRatio: number = ANCHOR_MAX_DF_RATIO,
): AnchorPlan {
  const limit = ratioOr(maxDfRatio, ANCHOR_MAX_DF_RATIO)
  const total = Array.isArray(records) ? records.length : 0
  const freq = new Map<string, number>()
  for (const rec of records) {
    const tags = Array.isArray(rec?.tags) ? rec.tags : []
    const seen = new Set<string>()
    for (const raw of tags) {
      if (typeof raw !== 'string') continue
      const tag = sanitizeForPrompt(raw)
      if (tag === '' || seen.has(tag)) continue
      seen.add(tag)
      freq.set(tag, (freq.get(tag) ?? 0) + 1)
    }
  }
  const distinctTags = freq.size
  const qualified: Array<[string, number]> = []
  for (const entry of freq) {
    if (total <= 0) break
    if (entry[1] / total > limit) continue // 资格过滤：覆盖全库的公共标签淘汰
    qualified.push(entry)
  }
  qualified.sort((a, b) => (b[1] - a[1]) || cmpCodeUnit(a[0], b[0]))
  const keep = topTags > 0 ? qualified.slice(0, topTags) : []
  return { anchors: keep.map(([tag]) => tag), distinctTags, qualifiedTags: qualified.length }
}

/**
 * 全局标签锚点（**与查询无关**、只由库内容决定 ⇒ 库不变时逐字节稳定）。
 * 排序：记录频次降序 → 标签码元升序（决胜确定）；资格过滤见 planAnchors。
 * 第三参数默认就是生产口径 ANCHOR_MAX_DF_RATIO（**默认安全**：忘记传参也不会退化成「最高频」）。
 */
export function stableAnchors(
  records: ReadonlyArray<MemoryRecord>,
  topTags: number,
  maxDfRatio: number = ANCHOR_MAX_DF_RATIO,
): string[] {
  return planAnchors(records, topTags, maxDfRatio).anchors
}

/** 文件身份三元组的键：`{path, size, mtimeMs}`；文件不存在时用 -1/-1 表示「没有 size/mtime 可言」。 */
function stampKey(path: string, stamp: StoreStamp | undefined): string {
  return stamp === undefined ? `${path}\u0000-1\u0000-1` : `${path}\u0000${stamp.size}\u0000${stamp.mtimeMs}`
}

/**
 * 一行注入文本的构建阶梯（每一步都保证 ≤ maxChars；优先信息量，最后才硬截断）：
 *  1. 完整行（条数 + 上限 + 全部锚点 + 指路），装得下 ⇒ truncated=false；
 *  2/3. 逐个丢弃尾部锚点并**如实标注**省略了几个（标记本身也算进上限）；
 *  4. 只留「条数 + 上限 + 指路」的最小行（仍如实标注省略了几个锚点，装得下就带上）；
 *  5. 连最小行都装不下（maxChars 极小）⇒ 硬截断并带 `（截断）` 标记；
 *  6. 连标记都装不下 ⇒ 空串（**绝不超限**，也绝不硬塞半句假信息）。
 *
 * @param noDiscriminatingAnchors - 库里有标签、但一个都没通过资格过滤（I4a.2）：
 *   这时那行写「无可区分锚点」而不是假装没有标签；**绝不回落到全库最高频标签**。
 *   库内一条标签都没有（空库/无标签）时传 false ⇒ 沿用旧的最小行（不写这一段）。
 */
export function planInjectionLine(
  count: number,
  maxRecords: number,
  anchors: ReadonlyArray<string>,
  maxChars: number,
  noDiscriminatingAnchors = false,
): LinePlan {
  const base = `记忆 ${count} 条（上限 ${maxRecords}）`
  const label = '｜标签锚点：'
  const full = anchors.length > 0
    ? `${base}${label}${anchors.join(ANCHOR_SEP)}${INJECTION_TAIL}`
    : (noDiscriminatingAnchors ? `${base}${ANCHOR_NONE_MARK}${INJECTION_TAIL}` : `${base}${INJECTION_TAIL}`)
  if (full.length <= maxChars) return { text: full, truncated: false, omitted: 0 }

  for (let keep = anchors.length - 1; keep >= 1; keep -= 1) {
    const omitted = anchors.length - keep
    const cand = `${base}${label}${anchors.slice(0, keep).join(ANCHOR_SEP)}（已省略 ${omitted} 个锚点）${INJECTION_TAIL}`
    if (cand.length <= maxChars) return { text: cand, truncated: true, omitted }
  }

  const minimal = `${base}${INJECTION_TAIL}`
  const marked = `${base}${label}（已省略 ${anchors.length} 个锚点）${INJECTION_TAIL}`
  if (anchors.length > 0 && marked.length <= maxChars) return { text: marked, truncated: true, omitted: anchors.length }
  // 连「无可区分锚点」这段都塞不下 ⇒ 丢掉它，truncated 仍需为 true（我们确实丢了一句如实说明）。
  const minimalTruncated = anchors.length > 0 || noDiscriminatingAnchors
  if (minimal.length <= maxChars) return { text: minimal, truncated: minimalTruncated, omitted: anchors.length }

  if (maxChars <= HARD_MARK.length) return { text: '', truncated: true, omitted: anchors.length }
  return { text: `${base.slice(0, maxChars - HARD_MARK.length)}${HARD_MARK}`, truncated: true, omitted: anchors.length }
}

/** 常量 diag：catch 里的兜底返回值（构造它本身不读任何外部状态，绝不再抛）。 */
function constantDiag(detail: string, maxChars: number): InjectionDiagnostics {
  return {
    ok: false, enabled: true, code: 'read-failed', count: 0, anchors: [], maxChars,
    chars: 0, truncated: false, omitted: 0, cached: false, detail,
    anchorMaxDfRatio: ANCHOR_MAX_DF_RATIO, distinctTags: 0, qualifiedTags: 0,
  }
}

/** 安全的错误文本化：`String(Object.create(null))` 之类会抛 ⇒ 这里自己兜住。 */
function safeErrorText(err: unknown): string {
  try {
    if (err instanceof Error) return `${err.name}: ${err.message}`
    if (typeof err === 'string') return err
    return Object.prototype.toString.call(err)
  } catch {
    return 'unknown-error'
  }
}

/**
 * 构建要注入的那一行。**绝不出异常**（读库失败 / 解析失败 / 字段缺失都只降级成空串 + diag）。
 *
 * @param cfg - 与工具面共用同一份 MemoryConfig（照旧走可注入的 FsOps 接缝）。
 * @param cache - 可选只读缓存（键严格是 {path,size,mtimeMs}；不传就是每次都真读）。
 */
export function buildInjectionIndex(cfg: MemoryConfig = {}, cache?: InjectionCache): InjectionResult {
  try {
    const opt = resolveInjectionOptions(cfg.injection)
    if (!opt.enabled) {
      return {
        text: '',
        diag: {
          ok: true, enabled: false, code: 'disabled', count: 0, anchors: [], maxChars: opt.maxChars,
          chars: 0, truncated: false, omitted: 0, cached: false, detail: '',
          anchorMaxDfRatio: opt.anchorMaxDfRatio, distinctTags: 0, qualifiedTags: 0,
        },
      }
    }

    const maxRecords = resolveMaxRecords(cfg)
    const path = memoryPath(cfg)
    const before = statStamp(cfg)
    const key = stampKey(path, before)

    let count: number
    let anchors: string[]
    let noAnchor: boolean
    let distinctTags: number
    let qualifiedTags: number
    let cached = false
    if (cache !== undefined && cache.key === key && typeof cache.count === 'number'
      && Array.isArray(cache.anchors) && typeof cache.noAnchor === 'boolean'
      && typeof cache.distinctTags === 'number' && typeof cache.qualifiedTags === 'number') {
      count = cache.count
      anchors = [...cache.anchors]
      noAnchor = cache.noAnchor
      distinctTags = cache.distinctTags
      qualifiedTags = cache.qualifiedTags
      cached = true
    } else {
      const snap = loadSnapshot(cfg)
      count = snap.records.length
      const anchorPlan = planAnchors(snap.records, opt.topTags, opt.anchorMaxDfRatio)
      anchors = anchorPlan.anchors
      distinctTags = anchorPlan.distinctTags
      qualifiedTags = anchorPlan.qualifiedTags
      // 只有「库里有标签」且「一个都没通过资格过滤」才写「无可区分锚点」；
      // 库里根本没有标签（空库/全部无标签）走旧的最小行。
      noAnchor = distinctTags > 0 && qualifiedTags === 0
      if (cache !== undefined) {
        // 只有「探测到的身份」与「读到的身份」一致时才写缓存：否则可能是读的瞬间被改过，
        // 把旧身份配上新内容就是「同键不同值」，违反缓存的幂等前提（下次身份一变就会重读）。
        const readKey = stampKey(path, snap.stamp)
        const sameIdentity = before === undefined ? snap.stamp === undefined : (snap.stamp !== undefined && readKey === key)
        if (sameIdentity) {
          cache.key = readKey
          cache.count = count
          cache.anchors = [...anchors]
          cache.noAnchor = noAnchor
          cache.distinctTags = distinctTags
          cache.qualifiedTags = qualifiedTags
        } else {
          cache.key = undefined
          cache.count = undefined
          cache.anchors = undefined
          cache.noAnchor = undefined
          cache.distinctTags = undefined
          cache.qualifiedTags = undefined
        }
      }
    }

    const plan = planInjectionLine(count, maxRecords, anchors, opt.maxChars, noAnchor)
    let text = sanitizeForPrompt(plan.text)
    // 防御性兜底：净化只会变短，这里再钉一次「绝不超限」。
    if (text.length > opt.maxChars) text = text.slice(0, opt.maxChars)
    return {
      text,
      diag: {
        ok: true,
        enabled: true,
        code: count === 0 ? 'empty-store' : 'ok',
        count,
        anchors,
        maxChars: opt.maxChars,
        chars: text.length,
        truncated: plan.truncated,
        omitted: plan.omitted,
        cached,
        detail: '',
        anchorMaxDfRatio: opt.anchorMaxDfRatio,
        distinctTags,
        qualifiedTags,
      },
    }
  } catch (err) {
    // fail-open：读库/解析/字段缺失都不许抛。catch 内部也绝不再抛（两层兜底）。
    const detail = safeErrorText(err)
    try {
      return { text: '', diag: constantDiag(detail, resolveInjectionOptions(cfg?.injection).maxChars) }
    } catch {
      return { text: '', diag: constantDiag('inject-failed', DEFAULT_INJECTION_MAX_CHARS) }
    }
  }
}
