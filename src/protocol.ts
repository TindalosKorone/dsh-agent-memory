/**
 * 写入协议校验（失败关闭）。
 *
 * 任何一项不满足 ⇒ 返回 { ok:false, code, text }，**绝不落盘**。
 * text 必须是「模型能照着改」的修复指引：给出违规字段、约束原文、以及一个可用的最小示例。
 */

export const KINDS = ['fact', 'lesson', 'preference', 'pointer'] as const
export type Kind = (typeof KINDS)[number]

/** 一条记忆记录（落盘形状；键序固定，便于人类阅读与 grep）。 */
export interface MemoryRecord {
  id: string
  ts: number
  kind: Kind
  title: string
  body: string
  tags: string[]
  source: string
  /** 被 expand 取回的次数，参与淘汰分 recency * (1 + hits)。 */
  hits: number
  /**
   * 作用域（本次新增，向后兼容）：约定 `project:<名>`，缺省/旧记录一律视为 `global`。
   * recall 传了 scope 时，只返回 `scope === 该值` **或** `scope === global` 的记录。
   */
  scope: string
}

/** 通过校验后的待落盘草稿（id/ts/hits 由存储层补）。 */
export interface MemoryDraft {
  kind: Kind
  title: string
  body: string
  tags: string[]
  source: string
  scope: string
}

export interface DraftInput {
  kind?: unknown
  title?: unknown
  body?: unknown
  tags?: unknown
  source?: unknown
  scope?: unknown
}

export type Validation =
  | { ok: true; value: MemoryDraft }
  | { ok: false; code: string; text: string }

export const TITLE_MIN = 8
export const TITLE_MAX = 120
export const TAG_MIN = 1
export const TAG_MAX = 12
export const TAG_LEN_MAX = 32
/** scope 的缺省值：不传 scope 就落在这个作用域；recall 传了 scope 时它**永远**被包含。 */
export const DEFAULT_SCOPE = 'global'
/** scope 长度上限（去空白、净化之后按码元计）。 */
export const SCOPE_MAX = 64

/** 标签归一化：只做 trim + 小写化（不做同义词归一，保证全库稳定复用）。 */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase()
}

/**
 * scope 净化（它会被回显到 L1 表头，必须单行、无模板占位）：
 * 去首尾空白，并把 `{{` / `}}` 降级成单个花括号（`{{`/`}}` 在提示词模板里有特殊含义）。
 * 换行由写入校验**拒绝**（fail-closed）；只读路径（recall 的筛选参数）另有 sanitizeScopeArg。
 */
export function normalizeScope(raw: string): string {
  return raw.trim().split('{{').join('{').split('}}').join('}')
}

/**
 * 只读路径（recall 的 scope 筛选参数）的宽松净化：不失败关闭，只保证**永远不会**把
 * 换行/超长串带进表头 —— 剥掉行分隔符、净化占位、截断到 SCOPE_MAX。空串表示「未提供」。
 */
export function sanitizeScopeArg(raw: string): string {
  const oneLine = raw.replace(/[\n\r\u2028\u2029]/g, ' ')
  return normalizeScope(oneLine).slice(0, SCOPE_MAX)
}

/** title 必须是单行：除 \n / \r 外，也把 Unicode 行分隔符一并拒绝。 */
const LINE_BREAK = /[\n\r\u2028\u2029]/

/** 可照抄的最小可用调用示例（每个失败指引都带上它）。 */
export const EXAMPLE_CALL = '{"kind":"fact","title":"用户偏好深色主题","body":"用户在设置里选择了深色主题。","tags":["preference","ui"],"source":"session:demo"}'

function fail(code: string, detail: string, hint: string): Validation {
  return {
    ok: false,
    code,
    text: `写入被拒（失败关闭，未落盘）。\n- 违规项：${detail}\n- 规则：${hint}\n- 修复后重试，可照抄的最小示例：${EXAMPLE_CALL}`,
  }
}

/**
 * 校验一条待写入记录。
 * 顺序：kind → title → body → tags → source（先报最靠前的错，指引不互相干扰）。
 */
export function validateDraft(input: DraftInput | null | undefined): Validation {
  const src = input ?? {}

  // kind：四选一
  if (typeof src.kind !== 'string' || !(KINDS as readonly string[]).includes(src.kind)) {
    return fail(
      'bad-kind',
      `kind = ${typeof src.kind === 'string' ? JSON.stringify(src.kind) : String(src.kind)}`,
      `kind 必须恰好是这四个之一：${KINDS.join(' | ')}`,
    )
  }
  const kind = src.kind as Kind

  // title：字符串，去首尾空白后 8..120 字符，且不得含换行
  if (typeof src.title !== 'string') {
    return fail('bad-title', `title 类型是 ${typeof src.title}，不是 string`, 'title 必须是 string')
  }
  if (LINE_BREAK.test(src.title)) {
    return fail('title-multiline', 'title 含换行符（\\n / \\r / U+2028 / U+2029）', 'title 必须是单行；需要写细节请放进 body')
  }
  const title = src.title.trim()
  if (title.length < TITLE_MIN) {
    return fail('title-too-short', `title 去空白后只有 ${title.length} 个字符：${JSON.stringify(title)}`, `title 去首尾空白后长度必须 >= ${TITLE_MIN}`)
  }
  if (title.length > TITLE_MAX) {
    return fail('title-too-long', `title 去空白后有 ${title.length} 个字符`, `title 去首尾空白后长度必须 <= ${TITLE_MAX}（超出部分请移到 body）`)
  }

  // body：非空
  if (typeof src.body !== 'string') {
    return fail('bad-body', `body 类型是 ${typeof src.body}，不是 string`, 'body 必须是 string')
  }
  const body = src.body.trim()
  if (body === '') {
    return fail('empty-body', 'body 去首尾空白后为空', 'body 必须非空；请把这条记忆的实际内容写进去')
  }

  // tags：有序数组，1..12 个，每个 1..32 字符，不得重复（按归一化后比较）
  if (!Array.isArray(src.tags)) {
    return fail('bad-tags', `tags 类型是 ${typeof src.tags}，不是数组`, `tags 必须是字符串数组，长度 ${TAG_MIN}..${TAG_MAX}，例如 ["preference","ui"]`)
  }
  if (src.tags.length < TAG_MIN) {
    return fail('tags-too-few', 'tags 为空数组', `tags 至少 ${TAG_MIN} 个（顺序有意义，按语义重要性排列）`)
  }
  if (src.tags.length > TAG_MAX) {
    return fail('tags-too-many', `tags 有 ${src.tags.length} 个`, `tags 最多 ${TAG_MAX} 个`)
  }
  const tags: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < src.tags.length; i += 1) {
    const raw = src.tags[i]
    if (typeof raw !== 'string') {
      return fail('bad-tag', `tags[${i}] 类型是 ${typeof raw}，不是 string`, `tags 每一项都必须是 string，单个长度 1..${TAG_LEN_MAX}`)
    }
    const tag = normalizeTag(raw)
    if (tag === '' || tag.length > TAG_LEN_MAX) {
      return fail('bad-tag', `tags[${i}] 归一化后长度为 ${tag.length}：${JSON.stringify(tag)}`, `每个 tag 去空白并小写化后长度必须 1..${TAG_LEN_MAX}`)
    }
    if (seen.has(tag)) {
      return fail('duplicate-tags', `tags 里 ${JSON.stringify(tag)} 重复出现（归一化后比较）`, 'tags 不得重复；重复项请合并，只保留一个')
    }
    seen.add(tag)
    tags.push(tag)
  }

  // source：非空字符串
  if (typeof src.source !== 'string') {
    return fail('bad-source', `source 类型是 ${typeof src.source}，不是 string`, 'source 必须是 string（出处：会话 / 文件 / URL）')
  }
  const source = src.source.trim()
  if (source === '') {
    return fail('empty-source', 'source 去首尾空白后为空', 'source 必须非空，写明出处，例如 session:abc123 或 file:src/index.ts')
  }

  // scope（本次新增，**可选**）：不传 ⇒ 落 DEFAULT_SCOPE=global（默认行为与过去完全一致）。
  // 传了就必须校验（它会被回显到 L1 表头）：string、单行、净化后非空、长度 <= SCOPE_MAX。
  let scope = DEFAULT_SCOPE
  if (src.scope !== undefined) {
    if (typeof src.scope !== 'string') {
      return fail('bad-scope', `scope 类型是 ${typeof src.scope}，不是 string`, 'scope 必须是 string（可省略；省略即视为 global）')
    }
    if (LINE_BREAK.test(src.scope)) {
      return fail('scope-multiline', 'scope 含换行符（\\n / \\r / U+2028 / U+2029）', 'scope 必须单行；建议用 project:<名> 这种短标识')
    }
    const normalized = normalizeScope(src.scope)
    if (normalized === '') {
      return fail('empty-scope', 'scope 去首尾空白后为空', `scope 要么省略（视为 ${DEFAULT_SCOPE}），要么给一个非空字符串，例如 project:demo`)
    }
    if (normalized.length > SCOPE_MAX) {
      return fail('scope-too-long', `scope 归一化后有 ${normalized.length} 个字符`, `scope 长度必须 <= ${SCOPE_MAX}，建议 project:<名> 这种短标识`)
    }
    scope = normalized
  }

  return { ok: true, value: { kind, title, body, tags, source, scope } }
}

/** 从 NDJSON 单行还原记录；不可用的行返回 undefined（坏行不该拖垮整库）。 */
export function normalizeStoredRecord(value: unknown): MemoryRecord | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const r = value as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id === '') return undefined
  if (typeof r.ts !== 'number' || !Number.isFinite(r.ts)) return undefined
  if (typeof r.kind !== 'string' || !(KINDS as readonly string[]).includes(r.kind)) return undefined
  if (typeof r.title !== 'string' || typeof r.body !== 'string' || typeof r.source !== 'string') return undefined
  if (!Array.isArray(r.tags)) return undefined
  const tags = r.tags.filter((t): t is string => typeof t === 'string')
  const hits = typeof r.hits === 'number' && Number.isFinite(r.hits) && r.hits > 0 ? Math.floor(r.hits) : 0
  // 向后兼容：旧记录没有 scope 字段（或为空/非法）⇒ 一律视为 DEFAULT_SCOPE=global。
  const rawScope = typeof r.scope === 'string' ? sanitizeScopeArg(r.scope) : ''
  const scope = rawScope === '' ? DEFAULT_SCOPE : rawScope
  // 重建为固定键序，保证落盘字节数稳定
  return { id: r.id, ts: r.ts, kind: r.kind as Kind, title: r.title, body: r.body, tags: [...tags], source: r.source, hits, scope }
}
