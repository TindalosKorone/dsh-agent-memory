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
 *  - 所以这里只放：条数 + 全局**词频**锚点（按 频次降序 / 码元升序 决胜 ⇒ 全确定）+ 工具指路。
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
}

/** 解析后的注入口径（解析过程本身绝不抛：字段类型不对就回落默认值）。 */
export interface InjectionOptions {
  enabled: boolean
  maxChars: number
  topTags: number
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
/** 天花板的理由：这一行会进每一步的上下文，配置写错（比如 100000）不能变成一次 prompt 爆炸。 */
export const INJECTION_MAX_CHARS_CEILING = 4000
/** 同上：锚点数有上限，避免在一个手改过的巨大标签空间上做无界排序输出。 */
export const INJECTION_TOP_TAGS_CEILING = 64

/** 锚点分隔符（固定常量，便于目视与断言）。 */
export const ANCHOR_SEP = ' / '
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

/** 只读缓存的三元组内容：同键必同值（纯函数：文件内容 → 条数 + 锚点）。 */
export interface InjectionCache {
  key: string | undefined
  count: number | undefined
  anchors: string[] | undefined
}

/** 建一个空缓存；不传缓存给 buildInjectionIndex 就是「每次都真读」（纯函数路径）。 */
export function createInjectionCache(): InjectionCache {
  return { key: undefined, count: undefined, anchors: undefined }
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
 * 解析注入口径（解析本身绝不抛：配置写错只降级，不炸每一步）。
 * 上限型字段一律夹到天花板；enabled 只认显式 boolean。
 */
export function resolveInjectionOptions(cfg?: InjectionConfig | null): InjectionOptions {
  const src = (cfg ?? {}) as InjectionConfig
  return {
    enabled: boolOr(src.enabled, DEFAULT_INJECTION_ENABLED),
    maxChars: intOr(src.maxChars, DEFAULT_INJECTION_MAX_CHARS, 0, INJECTION_MAX_CHARS_CEILING),
    topTags: intOr(src.topTags, DEFAULT_INJECTION_TOP_TAGS, 0, INJECTION_TOP_TAGS_CEILING),
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

/**
 * 全局标签词频锚点：**与查询无关**、只由库内容决定，所以库不变时逐字节稳定。
 * 排序：频次降序 → 标签码元升序（决胜确定，避免 Map 迭代顺序带来的不确定性）。
 * 每个标签先过 sanitizeForPrompt（单行 + 去花括号）；净化后相同的标签自然合并计数。
 */
export function stableAnchors(records: ReadonlyArray<MemoryRecord>, topTags: number): string[] {
  if (!(topTags > 0)) return []
  const freq = new Map<string, number>()
  for (const rec of records) {
    const tags = Array.isArray(rec?.tags) ? rec.tags : []
    for (const raw of tags) {
      if (typeof raw !== 'string') continue
      const tag = sanitizeForPrompt(raw)
      if (tag === '') continue
      freq.set(tag, (freq.get(tag) ?? 0) + 1)
    }
  }
  const sorted = [...freq.entries()].sort((a, b) => (b[1] - a[1]) || cmpCodeUnit(a[0], b[0]))
  return sorted.slice(0, topTags).map(([tag]) => tag)
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
 */
export function planInjectionLine(count: number, maxRecords: number, anchors: ReadonlyArray<string>, maxChars: number): LinePlan {
  const base = `记忆 ${count} 条（上限 ${maxRecords}）`
  const label = '｜标签锚点：'
  const full = anchors.length > 0 ? `${base}${label}${anchors.join(ANCHOR_SEP)}${INJECTION_TAIL}` : `${base}${INJECTION_TAIL}`
  if (full.length <= maxChars) return { text: full, truncated: false, omitted: 0 }

  for (let keep = anchors.length - 1; keep >= 1; keep -= 1) {
    const omitted = anchors.length - keep
    const cand = `${base}${label}${anchors.slice(0, keep).join(ANCHOR_SEP)}（已省略 ${omitted} 个锚点）${INJECTION_TAIL}`
    if (cand.length <= maxChars) return { text: cand, truncated: true, omitted }
  }

  const minimal = `${base}${INJECTION_TAIL}`
  const marked = `${base}${label}（已省略 ${anchors.length} 个锚点）${INJECTION_TAIL}`
  if (anchors.length > 0 && marked.length <= maxChars) return { text: marked, truncated: true, omitted: anchors.length }
  if (minimal.length <= maxChars) return { text: minimal, truncated: anchors.length > 0, omitted: anchors.length }

  if (maxChars <= HARD_MARK.length) return { text: '', truncated: true, omitted: anchors.length }
  return { text: `${base.slice(0, maxChars - HARD_MARK.length)}${HARD_MARK}`, truncated: true, omitted: anchors.length }
}

/** 常量 diag：catch 里的兜底返回值（构造它本身不读任何外部状态，绝不再抛）。 */
function constantDiag(detail: string, maxChars: number): InjectionDiagnostics {
  return {
    ok: false, enabled: true, code: 'read-failed', count: 0, anchors: [], maxChars,
    chars: 0, truncated: false, omitted: 0, cached: false, detail,
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
        },
      }
    }

    const maxRecords = resolveMaxRecords(cfg)
    const path = memoryPath(cfg)
    const before = statStamp(cfg)
    const key = stampKey(path, before)

    let count: number
    let anchors: string[]
    let cached = false
    if (cache !== undefined && cache.key === key && typeof cache.count === 'number' && Array.isArray(cache.anchors)) {
      count = cache.count
      anchors = [...cache.anchors]
      cached = true
    } else {
      const snap = loadSnapshot(cfg)
      count = snap.records.length
      anchors = stableAnchors(snap.records, opt.topTags)
      if (cache !== undefined) {
        // 只有「探测到的身份」与「读到的身份」一致时才写缓存：否则可能是读的瞬间被改过，
        // 把旧身份配上新内容就是「同键不同值」，违反缓存的幂等前提（下次身份一变就会重读）。
        const readKey = stampKey(path, snap.stamp)
        const sameIdentity = before === undefined ? snap.stamp === undefined : (snap.stamp !== undefined && readKey === key)
        if (sameIdentity) {
          cache.key = readKey
          cache.count = count
          cache.anchors = [...anchors]
        } else {
          cache.key = undefined
          cache.count = undefined
          cache.anchors = undefined
        }
      }
    }

    const plan = planInjectionLine(count, maxRecords, anchors, opt.maxChars)
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
