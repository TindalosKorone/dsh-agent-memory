/**
 * dsh-agent-memory — 面向 agent 的记忆层（I1 地基版本）。
 *
 * 设计取舍：
 *  - **只做工具面**：不做每轮自动注入、不注册 systemPrompt、不引 embedding、零运行时依赖；
 *  - **窄**：恰好 4 个工具（remember / recall / expand / prune），分层披露 L1 索引与 L2 正文，
 *    recall 绝不返回 body（省 token，也逼模型显式 expand）；
 *  - **失败关闭**：写入协议任一不满足即拒收且**不落盘**，并给出可照抄的修复指引；
 *  - **不无限增长**：maxRecords / maxBytes 硬上限 + 按 recency*(1+hits) 淘汰；
 *  - **输出无损 JSON**：返回值过 prune()；`render` 写在 `output` 内部（同级写等于没给）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { RENDER, prune } from './json.js'
import { KINDS, validateDraft, type MemoryRecord } from './protocol.js'
import {
  appendRecord, bumpHits, byteLength, createQueue, loadRecords, memoryPath, nowMs, planPrune,
  resolveMaxBytes, resolveMaxRecords, saveRecords, serialize,
  RecordTooLargeError, StoreChangedExternallyError,
  type MemoryConfig,
} from './store.js'
import { cmpId, decay, diversify, lexicalScore, rrf } from './pure.js'

export const name = '@dsh-agent/dsh-agent-memory'

/** 只声明必需服务 tools（`ctx.tools` 是属性访问，未 inject 时 cordis 取值直接抛错 ⇒ 引擎启动即死）。 */
export const inject = ['tools']

/** recall 的 L1 输出总长硬上限（字符）。 */
export const RECALL_MAX_CHARS = 2000
/** recall 单次取回条数上限。 */
export const RECALL_LIMIT_MAX = 50

const KIND_ENUM = [...KINDS]

/** memory_expand 的一条 L2 结果（含 body）。 */
export interface ExpandedRecord {
  id: string
  kind: string
  title: string
  body: string
  tags: string[]
  source: string
  ts: number
  hits: number
}

/** 每条 L1 行：`id | kind | title | tags | score`。**不含 body**。 */
export function formatL1(rec: MemoryRecord, score: number): string {
  return `${rec.id} | ${rec.kind} | ${rec.title} | ${rec.tags.join(',')} | ${score.toFixed(4)}`
}

/**
 * 按字符上限裁剪 L1 行；被截断时追加如实说明（且说明本身也算进上限 ⇒ 总长不会超）。
 */
export function fitLines(header: string, lines: ReadonlyArray<string>, limit: number): { lines: string[]; text: string; truncated: boolean } {
  const body = (n: number): { kept: string[]; text: string } => {
    const kept: string[] = []
    let size = header.length
    for (const line of lines) {
      if (size + 1 + line.length > n) break
      kept.push(line)
      size += 1 + line.length
    }
    return { kept, text: header + (kept.length > 0 ? '\n' + kept.join('\n') : '') }
  }
  const full = body(limit)
  if (full.kept.length === lines.length) return { lines: full.kept, text: full.text, truncated: false }
  const note = `\n...(已截断：命中 ${lines.length} 条，本次仅显示前 ${full.kept.length} 条；要更多请提高 limit，要正文请用 memory_expand)`
  const clipped = body(Math.max(0, limit - note.length))
  const text = clipped.text + note
  return { lines: clipped.kept, text, truncated: true }
}

/**
 * 「单条过大」的失败指引：给出当前上限、这条多少字节、以及可照做的两种做法。
 * 失败关闭 —— 本次不落盘，也不触发任何淘汰。
 */
export function tooLargeText(err: RecordTooLargeError): string {
  return '写入被拒（失败关闭，未落盘，也未触发任何淘汰）。\n'
    + `- 违规项：本条记录序列化后 ${err.bytes} 字节，超过单条上限 ${err.limit} 字节\n`
    + `- 规则：单条上限默认为 maxBytes 的 10%（当前 maxBytes=${err.maxBytes} 字节，可用 DSH_AGENT_MEMORY_MAX_RECORD_BYTES 覆盖）；`
    + '因为淘汰按字节数进行，放一条超大记录进来会把整库挤空，所以直接拒收\n'
    + `- 修复（任选其一）：① 拆成多条更小的记忆分次写入（每条 <= ${err.limit} 字节；先精简 body 或分段）；`
    + `② 确实需要更大的单条时显式提高上限后重试：DSH_AGENT_MEMORY_MAX_RECORD_BYTES=${err.bytes}\n`
    + '- 本次未写入任何内容，库内记录保持原样'
}

/** 「库被外部改动」的失败指引：给出加载时/落盘前两边的身份，并指向「重新读取后再写」。 */
export function externalChangeText(err: StoreChangedExternallyError): string {
  const actual = err.actual === undefined
    ? '文件已消失'
    : `size=${err.actual.size}, mtimeMs=${err.actual.mtimeMs}`
  return '写入被拒（失败关闭，未落盘）：库文件在你加载之后被其他进程/工具改过，'
    + '为避免覆盖对方的写入，本次不覆盖、直接拒写。\n'
    + `- 文件：${err.path}\n`
    + `- 加载时：size=${err.expected.size}, mtimeMs=${err.expected.mtimeMs}\n`
    + `- 落盘前：${actual}\n`
    + '- 修复：重新读取后再写（先调 memory_recall 或再调一次本工具拿到最新库况，然后重试）；本次拒写对库没有任何影响'
}

export function apply(ctx: Context, config: MemoryConfig = {}): void {
  const host = ctx as unknown as {
    tools: { register: (def: unknown) => { dispose?: () => void } | void }
    effect?: (cb: () => (() => void) | void, label?: string) => unknown
  }

  // 配置注入（测试用它把 FsOps 接缝塞进来做并发度观测 / 故障注入）；默认全走真 fs 与真时钟。
  const cfg: MemoryConfig = { ...config }
  const queue = createQueue()

  // 副作用清理：串行队列持有 promise 链与闭包引用，dispose 时清空（不残留）。
  if (typeof host.effect === 'function') {
    host.effect(() => () => { queue.reset() }, `${name}:serial-queue`)
  }

  /** 失败时的库况回执（不含 body）。 */
  const stats = (): { total: number; bytes: number } => {
    const records = loadRecords(cfg)
    return { total: records.length, bytes: byteLength(serialize(records)) }
  }

  // ── 工具 1：写入 ─────────────────────────────────────────────────────────
  host.tools.register(defineTool({
    name: 'memory_remember',
    description: '写入一条长期记忆并落盘。写入协议失败关闭：kind 必须是 fact/lesson/preference/pointer；'
      + 'title 单行且去空白后 8..120 字符；body 非空；tags 有序不重复 1..12 个、每个 1..32 字符；source 非空。'
      + '任何一项不满足会返回 ok=false + 可直接照做的修复指引，且不落盘。返回新 id、当前总数与占用字节。',
    parameters: {
      kind: { type: 'string', enum: KIND_ENUM, required: true, description: '记忆类型：fact 事实 / lesson 教训 / preference 偏好 / pointer 指针（指路到文件或 URL）' },
      title: { type: 'string', required: true, description: '单行标题，去首尾空白后 8..120 字符，不得含换行' },
      body: { type: 'string', required: true, description: '正文（L2，只有 memory_expand 才取回），非空' },
      tags: { type: 'array', items: { type: 'string' }, required: true, description: '有序标签，1..12 个，每个 1..32 字符，不得重复（全库稳定复用，只做 trim + 小写化）' },
      source: { type: 'string', required: true, description: '出处，非空：session:xxx / file:path / url:https://...' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          code: { type: 'string', required: true },
          id: { type: 'string' },
          total: { type: 'integer', required: true },
          bytes: { type: 'integer', required: true },
          maxRecords: { type: 'integer', required: true },
          maxBytes: { type: 'integer', required: true },
          evicted: { type: 'integer', required: true },
          evictedIds: { type: 'array', items: { type: 'string' }, required: true },
          text: { type: 'string', required: true },
        },
      },
      render: RENDER,
    },
    execute: async (rawArgs: unknown) => queue.run(() => {
      const args = (rawArgs ?? {}) as Record<string, unknown>
      const maxRecords = resolveMaxRecords(cfg)
      const maxBytes = resolveMaxBytes(cfg)
      const check = validateDraft({ kind: args.kind, title: args.title, body: args.body, tags: args.tags, source: args.source })
      if (!check.ok) {
        const s = stats()
        return prune({
          ok: false,
          code: check.code,
          id: undefined,
          total: s.total,
          bytes: s.bytes,
          maxRecords,
          maxBytes,
          evicted: 0,
          evictedIds: [] as string[],
          text: check.text,
        })
      }
      // 两道失败关闭闸门（单条过大 / 库被外部改动）：都不落盘、都不触发淘汰。
      const failBox = (code: string, text: string) => {
        const s = stats()
        return prune({
          ok: false,
          code,
          id: undefined,
          total: s.total,
          bytes: s.bytes,
          maxRecords,
          maxBytes,
          evicted: 0,
          evictedIds: [] as string[],
          text,
        })
      }
      let result: ReturnType<typeof appendRecord>
      try {
        result = appendRecord(check.value, cfg)
      } catch (err) {
        if (err instanceof RecordTooLargeError) return failBox('record-too-large', tooLargeText(err))
        if (err instanceof StoreChangedExternallyError) return failBox('store-changed-externally', externalChangeText(err))
        throw err
      }
      const evictedIds = result.evicted.map((r) => r.id)
      const text = `已落盘：id=${result.record.id}（${result.record.kind}）\n`
        + `- 库内：${result.countBefore} -> ${result.countAfter} 条，占用 ${result.bytes} / ${result.maxBytes} 字节（条数上限 ${result.maxRecords}）\n`
        + `- 落盘文件：${result.path}\n`
        + (evictedIds.length > 0
          ? `- 触发上限淘汰 ${evictedIds.length} 条（按 score=recency*(1+hits) 最低者）：${evictedIds.join(', ')}`
          : '- 未触发上限淘汰')
      return prune({
        ok: true,
        code: 'ok',
        id: result.record.id,
        total: result.countAfter,
        bytes: result.bytes,
        maxRecords: result.maxRecords,
        maxBytes: result.maxBytes,
        evicted: evictedIds.length,
        evictedIds,
        text,
      })
    }),
  }))

  // ── 工具 2：召回（只给 L1 索引，绝不返回 body）──────────────────────────
  host.tools.register(defineTool({
    name: 'memory_recall',
    description: '按查询召回记忆索引（L1）。每条一行：id | kind | title | tags | score。'
      + '**绝不返回 body**：要正文请拿 id 调 memory_expand。score 是词法相关度与新鲜度两路 RRF 融合后按最高分归一化到 0..1 的相对分。'
      + `总输出超过 ${RECALL_MAX_CHARS} 字符会截断并如实说明。`,
    parameters: {
      query: { type: 'string', required: true, description: '查询串（中文/英文均可；空串表示只按新鲜度排）' },
      limit: { type: 'integer', description: `返回条数，默认 5，最大 ${RECALL_LIMIT_MAX}` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          code: { type: 'string', required: true },
          query: { type: 'string', required: true },
          limit: { type: 'integer', required: true },
          total: { type: 'integer', required: true },
          matched: { type: 'integer', required: true },
          shown: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          lines: { type: 'array', items: { type: 'string' }, required: true },
          text: { type: 'string', required: true },
        },
      },
      render: RENDER,
    },
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs ?? {}) as Record<string, unknown>
      const query = typeof args.query === 'string' ? args.query : ''
      const rawLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : 5
      const limit = rawLimit < 1 ? 1 : rawLimit > RECALL_LIMIT_MAX ? RECALL_LIMIT_MAX : rawLimit

      const records = loadRecords(cfg)
      const now = nowMs(cfg)

      // 路 1：词法相关度（只保留正分）
      const lexical = records
        .map((r) => ({ id: r.id, s: lexicalScore(query, r) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => (b.s - a.s) || cmpId(a.id, b.id))
        .map((x) => x.id)
      // 路 2：新鲜度
      const freshness = records
        .map((r) => ({ id: r.id, s: decay(r.ts, now) }))
        .sort((a, b) => (b.s - a.s) || cmpId(a.id, b.id))
        .map((x) => x.id)

      const fused = rrf([lexical, freshness], { k: 60, alpha: 0.6 })
      const byId = new Map(records.map((r) => [r.id, r]))
      const top = fused.length > 0 ? fused[0]?.score ?? 0 : 0
      const candidates = fused
        .map((e) => ({ id: e.id, score: top > 0 ? e.score / top : 0, tags: byId.get(e.id)?.tags ?? [] }))
      const picked = diversify(candidates, { lambda: 0.7, limit })

      const lines: string[] = []
      for (const item of picked) {
        const rec = byId.get(item.id)
        if (rec === undefined) continue
        lines.push(formatL1(rec, item.score))
      }

      const header = `记忆召回（L1 索引，不含正文）：query=${JSON.stringify(query)} | 库内 ${records.length} 条 | `
        + `融合候选 ${fused.length} 条 | 本次显示 ${lines.length} 条（limit=${limit}）`
      const fitted = fitLines(header, lines, RECALL_MAX_CHARS)
      const text = records.length === 0
        ? `${header}\n(记忆库为空：请先用 memory_remember 写入)`
        : fitted.text

      return prune({
        ok: true,
        code: 'ok',
        query,
        limit,
        total: records.length,
        matched: fused.length,
        shown: fitted.lines.length,
        truncated: fitted.truncated,
        lines: fitted.lines,
        text,
      })
    },
  }))

  // ── 工具 3：展开（L2，取回正文）─────────────────────────────────────────
  host.tools.register(defineTool({
    name: 'memory_expand',
    description: '按 id 取回记忆正文（L2）。找不到的 id 会如实列在 missing 里。取回成功会给这些记录累加 hits（影响将来的淘汰优先级）。',
    parameters: {
      ids: { type: 'array', items: { type: 'string' }, required: true, description: '要展开的记录 id 列表（去重后按给出顺序返回）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          code: { type: 'string', required: true },
          requested: { type: 'integer', required: true },
          found: { type: 'integer', required: true },
          missing: { type: 'array', items: { type: 'string' }, required: true },
          records: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                title: { type: 'string', required: true },
                body: { type: 'string', required: true },
                tags: { type: 'array', items: { type: 'string' }, required: true },
                source: { type: 'string', required: true },
                ts: { type: 'integer', required: true },
                hits: { type: 'integer', required: true },
              },
            },
          },
          text: { type: 'string', required: true },
        },
      },
      render: RENDER,
    },
    execute: async (rawArgs: unknown) => queue.run(() => {
      const args = (rawArgs ?? {}) as Record<string, unknown>
      const MAX_IDS = 50
      const rawIds = Array.isArray(args.ids) ? args.ids : []
      const ids: string[] = []
      const seen = new Set<string>()
      for (const raw of rawIds) {
        if (typeof raw !== 'string') continue
        const id = raw.trim()
        if (id === '' || seen.has(id)) continue
        seen.add(id)
        ids.push(id)
      }
      const clipped = ids.slice(0, MAX_IDS)

      if (clipped.length === 0) {
        return prune({
          ok: false,
          code: 'empty-ids',
          requested: 0,
          found: 0,
          missing: [] as string[],
          records: [] as ExpandedRecord[],
          text: '未提供任何有效 id（失败关闭）。修复：先调 memory_recall 拿到 L1 行首的 id，再把 id 放进 ids 数组重试，例如 {"ids":["mem_xxx"]}。',
        })
      }

      const records = loadRecords(cfg)
      const byId = new Map(records.map((r) => [r.id, r]))
      const missing = clipped.filter((id) => !byId.has(id))
      const foundIds = clipped.filter((id) => byId.has(id))

      // hits 累加要落盘 ⇒ 同样受「外部改动」守卫约束：被拒时不落盘，但正文照常如实返回。
      let writeError: StoreChangedExternallyError | undefined
      let bump: { hits: Record<string, number>; count: number; bytes: number; evicted: MemoryRecord[] }
      try {
        bump = foundIds.length > 0
          ? bumpHits(foundIds, cfg)
          : { hits: {} as Record<string, number>, count: records.length, bytes: 0, evicted: [] as MemoryRecord[] }
      } catch (err) {
        if (!(err instanceof StoreChangedExternallyError)) throw err
        writeError = err
        bump = { hits: {} as Record<string, number>, count: records.length, bytes: 0, evicted: [] as MemoryRecord[] }
      }

      const out: ExpandedRecord[] = foundIds.map((id) => {
        const rec = byId.get(id) as MemoryRecord
        return {
          id: rec.id,
          kind: rec.kind,
          title: rec.title,
          body: rec.body,
          tags: [...rec.tags],
          source: rec.source,
          ts: rec.ts,
          hits: bump.hits[id] ?? rec.hits,
        }
      })

      const parts: string[] = []
      parts.push(`展开 ${foundIds.length}/${clipped.length} 条（L2 正文）`)
      if (writeError !== undefined) {
        parts.push(externalChangeText(writeError))
        parts.push('- 说明：上面这些正文已如实返回，但 hits 未累加、库文件未被改动')
      }
      if (missing.length > 0) parts.push(`- 未找到（如实报告）：${missing.join(', ')}`)
      if (ids.length > MAX_IDS) parts.push(`- 一次最多展开 ${MAX_IDS} 个 id，本次已忽略后 ${ids.length - MAX_IDS} 个`)
      if (bump.evicted.length > 0) parts.push(`- 本次写入触发上限淘汰 ${bump.evicted.length} 条：${bump.evicted.map((r) => r.id).join(', ')}`)
      for (const rec of out) {
        parts.push(`\n【${rec.id}】${rec.kind} | ${rec.title} | tags=${rec.tags.join(',')} | source=${rec.source} | hits=${rec.hits}\n${rec.body}`)
      }

      return prune({
        ok: writeError === undefined,
        code: writeError === undefined ? 'ok' : 'store-changed-externally',
        requested: clipped.length,
        found: out.length,
        missing,
        records: out,
        text: parts.join('\n'),
      })
    }),
  }))

  // ── 工具 4：清理（默认 dry-run）──────────────────────────────────────────
  host.tools.register(defineTool({
    name: 'memory_prune',
    description: `按规则淘汰/合并记忆：同 kind 同标题者合并（保留最新，累加 hits，标签取有序并集），`
      + `再按 score=recency*(1+hits) 从低到高淘汰至上限内。dryRun 默认 true（只报告将要删什么，不动磁盘），显式传 false 才真删。`,
    parameters: {
      dryRun: { type: 'boolean', default: true, description: '默认 true：只报告将要删/合并什么；传 false 才真正落盘' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          code: { type: 'string', required: true },
          dryRun: { type: 'boolean', required: true },
          before: { type: 'integer', required: true },
          after: { type: 'integer', required: true },
          merged: { type: 'integer', required: true },
          mergedGroups: { type: 'array', items: { type: 'string' }, required: true },
          evicted: { type: 'integer', required: true },
          evictedIds: { type: 'array', items: { type: 'string' }, required: true },
          bytesBefore: { type: 'integer', required: true },
          bytesAfter: { type: 'integer', required: true },
          maxRecords: { type: 'integer', required: true },
          maxBytes: { type: 'integer', required: true },
          changed: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: RENDER,
    },
    execute: async (rawArgs: unknown) => queue.run(() => {
      const args = (rawArgs ?? {}) as Record<string, unknown>
      const dryRun = args.dryRun !== false
      const plan = planPrune(cfg)
      const evictedIds = plan.evicted.map((r) => r.id)
      const mergedGroups = plan.merged.map((g) => `${g.keep} <- [${g.dropped.join(', ')}]`)
      const changed = plan.countBefore !== plan.countAfter || mergedGroups.length > 0 || plan.bytesBefore !== plan.bytesAfter

      // 真删落盘同样受「外部改动」守卫约束：被拒时不落盘、不覆盖对方内容。
      let writeError: StoreChangedExternallyError | undefined
      if (!dryRun) {
        try {
          saveRecords(plan.records, cfg, plan.stamp)
        } catch (err) {
          if (!(err instanceof StoreChangedExternallyError)) throw err
          writeError = err
        }
      }

      const head = dryRun ? 'dry-run（未改动磁盘）' : (writeError === undefined ? '已执行并落盘' : '未落盘（失败关闭：库被外部改动）')
      const text = `${head}\n`
        + `- 条数：${plan.countBefore} -> ${plan.countAfter}（上限 ${plan.maxRecords}）\n`
        + `- 占用：${plan.bytesBefore} -> ${plan.bytesAfter} / ${plan.maxBytes} 字节\n`
        + `- 合并 ${mergedGroups.length} 组${mergedGroups.length > 0 ? '：' + mergedGroups.join(' ; ') : ''}\n`
        + `- 淘汰 ${evictedIds.length} 条（score=recency*(1+hits) 最低者）${evictedIds.length > 0 ? '：' + evictedIds.join(', ') : ''}\n`
        + (writeError !== undefined ? `${externalChangeText(writeError)}\n` : '')
        + (dryRun && changed ? '- 确认无误后请以 dryRun=false 重试以真正执行' : '- 无需进一步动作')
      void memoryPath(cfg)

      return prune({
        ok: writeError === undefined,
        code: writeError === undefined ? 'ok' : 'store-changed-externally',
        dryRun,
        before: plan.countBefore,
        after: plan.countAfter,
        merged: mergedGroups.length,
        mergedGroups,
        evicted: evictedIds.length,
        evictedIds,
        bytesBefore: plan.bytesBefore,
        bytesAfter: plan.bytesAfter,
        maxRecords: plan.maxRecords,
        maxBytes: plan.maxBytes,
        changed,
        text,
      })
    }),
  }))
}
