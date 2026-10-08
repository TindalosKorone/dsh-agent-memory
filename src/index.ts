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
import { cmpId, decay, diversify, absoluteDisp, lexicalScore, matchLevel, rrf, corpusStats, tagCoverage, resolveScoreOptions, resolveTriageOptions, residualPyramid, type MatchLevel } from './pure.js'

export const name = '@dsh-agent/dsh-agent-memory'

/** 只声明必需服务 tools（`ctx.tools` 是属性访问，未 inject 时 cordis 取值直接抛错 ⇒ 引擎启动即死）。 */
export const inject = ['tools']

/** recall 的 L1 输出总长硬上限（字符）。 */
export const RECALL_MAX_CHARS = 2000
/** recall 单次取回条数上限。 */
export const RECALL_LIMIT_MAX = 50
/**
 * 候选数 <= 该值时跳过多样性重排（第三方做法：小候选集只重排、拿不到多样性收益、纯添乱）。
 * 与 pure.ts 的 diversify.minCandidates 对应；召回层显式传 5。
 */
export const DIVERSITY_MIN_CANDIDATES = 5

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

/**
 * 一条 L1 的打分视图。**注意是两种标度，表头必须写清**：
 *  - `rel`   = BM25 **原始相关度**（绝对标度，不随批次归一化），`match` 就是拿它与阈值比出来的
 *              ⇒ 读者可用打印的 rel 自行验算 match（I1.3 自证要求）；
 *  - `score` = `disp(final)` 映射到 0..1 的**展示分**（仅用于排序展示，与 rel 不同标度）。
 * 列序固定为 `rel | cov | match | score`，见 formatL1。
 */
export interface L1ScoreView {
  /** 含多样性惩罚的最终展示分 disp(final)；列表按它降序 ⇒ 打印天然单调不增。 */
  score: number
  /** 惩罚前的 BM25 原始相关度（**判定 match 所依据的量**；与 score 不同标度）。 */
  rel: number
  /** VCP 式标签覆盖率（I1.2 仅诊断，不门控）。 */
  cov: number
  /** 绝对判定：raw 与 WEAK_THRESHOLD / STRONG_THRESHOLD 比较。 */
  match: MatchLevel
}

/** 召回的结构化行（与 lines 一一对应，便于消费方不用解析字符串）。 */
export interface L1Row {
  id: string
  kind: string
  title: string
  tags: string[]
  rel: number
  cov: number
  match: MatchLevel
  score: number
}

/**
 * 每条 L1 行：`id | kind | title | tags | rel | cov | match | score`。**不含 body**。
 *
 * 约定：
 *  - **score 恒为最后一个字段**（4 位小数），既有「行尾是分数」的格式契约继续成立；
 *  - 表头（单一表头行）必须如实说明这四列的含义与绝对标度常数；
 *  - score = disp(rel × (1 − β·maxSim)) 展示分；rel = **BM25 原始相关度**（match 依据它）；cov = 覆盖率；match = 绝对判定。
 */
export function formatL1(rec: MemoryRecord, view: L1ScoreView): string {
  return `${rec.id} | ${rec.kind} | ${rec.title} | ${rec.tags.join(',')} | `
    + `${view.rel.toFixed(4)} | ${view.cov.toFixed(4)} | ${view.match} | ${view.score.toFixed(4)}`
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
    description: '按查询召回记忆索引（L1）。每条一行：'
      + 'id | kind | title | tags | rel | cov | match | score。'
      + '**绝不返回 body**：要正文请拿 id 调 memory_expand。'
      + 'score 是含多样性惩罚的最终分（按它降序，映射到 0..1 的展示标度，不随批次归一化）；'
      + 'rel 是 BM25 原始相关度（**阈值直接作用于它**，可据此自行验算 match）；'
      + 'cov 是标签覆盖率（仅诊断）；match 是绝对判定 none/weak/strong（由 rel 与绝对阈值比较得出）。'
      + '与库无关的查询不会拿到满分：无证据候选 rel/score 均为 0.0000、match=none（只奖不罚，不整批否决）。'
      + 'I2 分诊：以候选标签向量为基、在标签 idf 词法空间里做 Gram-Schmidt 残差金字塔，'
      + '得到 novelty（0.7×残差能量比 + 0.3×方向一致性）并据此决定是否扩检索。'
      + '**limit 是硬显示上限**：返回行数恒为 min(limit, 可用候选数)，扩检索只放大**内部**召回预算 '
      + 'kBase -> kUsed（给金字塔取基、给多样性更大的候选池），**不增加返回行数**。'
      + '查询无词元能量（‖q‖²≈0）时**不做分诊**：novelty=0、expanded=false、kUsed=kBase，'
      + 'explainedRatio/residualRatio 如实回显 0/0（未定义）。'
      + '另给 explainedRatio/residualRatio/'
      + 'basisSize/layers/logicalDepth 与 lowConfidence（低置信只是**如实报告**，绝不返回空、绝不整批否决）。'
      + `总输出超过 ${RECALL_MAX_CHARS} 字符会截断并如实说明。`,
    parameters: {
      query: { type: 'string', required: true, description: '查询串（中文/英文均可；空串/纯空白表示无词元能量、不分诊，只按新鲜度排）' },
      limit: { type: 'integer', description: `显示条数**硬上限**，默认 5，最大 ${RECALL_LIMIT_MAX}（返回行数恒为 min(limit, 可用候选数)；扩检索只放大内部候选池 kUsed，不增加返回行数）` },
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
          /** 绝对标度常数与阈值：如实回报本次使用的口径（不随批次变化）。 */
          scaleA: { type: 'number', required: true },
          scaleB: { type: 'number', required: true },
          weakThreshold: { type: 'number', required: true },
          strongThreshold: { type: 'number', required: true },
          diversityBeta: { type: 'number', required: true },
          diversityApplied: { type: 'boolean', required: true },
          /**
           * I2 分诊（残差金字塔）：全部是本查询自己的结论（请求级隔离，不跨请求复用）。
           * kBase/kUsed 是**内部召回预算**（不是显示承诺）：kUsed = expanded ? min(max(kBase, 2×kBase), 库内条数) : kBase。
           * 显示行数恒为 min(limit, 可用候选数) —— 扩检索只放大内部候选池，不改变返回行数（I2.1 修 1）。
           */
          expanded: { type: 'boolean', required: true },
          kBase: { type: 'integer', required: true },
          kUsed: { type: 'integer', required: true },
          novelty: { type: 'number', required: true },
          explainedRatio: { type: 'number', required: true },
          residualRatio: { type: 'number', required: true },
          basisSize: { type: 'integer', required: true },
          layers: { type: 'integer', required: true },
          logicalDepth: { type: 'number', required: true },
          lowConfidence: { type: 'boolean', required: true },
          /**
           * 查询无词元能量（‖q‖²≈0）⇒ 未分诊：novelty=0、expanded=false、kUsed=kBase，
           * explainedRatio/residualRatio 回显 0/0（0/0 未定义）。表头会如实写明「未分诊」。
           */
          noQueryEnergy: { type: 'boolean', required: true },
          /**
           * 口径回显（I1.3 可复算铁律）：没有这三个数，读者拿到的 expanded/lowConfidence 复算不出来。
           * 有词元能量时：expanded ⟺ novelty >= noveltyThreshold；
           * 无词元能量时（noQueryEnergy=true）**不做分诊**：expanded=false 与阈值无关（表头写明「未分诊」）；
           * lowConfidence ⟺ covMax < activationThreshold（两种情形都成立）。
           */
          noveltyThreshold: { type: 'number', required: true },
          activationThreshold: { type: 'number', required: true },
          covMax: { type: 'number', required: true },
          lines: { type: 'array', items: { type: 'string' }, required: true },
          rows: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                title: { type: 'string', required: true },
                tags: { type: 'array', items: { type: 'string' }, required: true },
                rel: { type: 'number', required: true },
                cov: { type: 'number', required: true },
                match: { type: 'string', required: true },
                score: { type: 'number', required: true },
              },
            },
          },
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
      // 打分口径：模块级绝对常数（可经 cfg.score 覆盖），**没有任何批次相关量**。
      const scoreCfg = resolveScoreOptions(cfg.score)
      // 语料统计（N / avgdl / df）每次调用现算：第三方明确记录过「模块级可变全局与并发不兼容」。
      const stats = corpusStats(records)

      // 相关度主分：BM25（字段内部各自统计）+ 字段权重，落在 0..1 绝对标度。
      const relById = new Map<string, number>()
      for (const r of records) relById.set(r.id, lexicalScore(query, r, stats))

      // 路 1：词法相关度（只保留正分）
      const lexical = records
        .map((r) => ({ id: r.id, s: relById.get(r.id) ?? 0 }))
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

      // 候选：排序层用原始相关度 rel 与融合秩 rank；展示层再用绝对映射 disp（两层解耦）。
      // 只奖不罚：无任何词法证据的候选 rel 就是 0，不做统一扣分、也不整批否决。
      const candidates = fused.map((e, idx) => {
        const rec = byId.get(e.id)
        const tags = Array.isArray(rec?.tags) ? (rec?.tags ?? []) : []
        return {
          id: e.id,
          score: relById.get(e.id) ?? 0,
          tags,
          rank: idx,
          cov: tagCoverage(query, tags, stats),
        }
      })

      // 候选 <= 5 时跳过多样性（小候选集拿不到多样性收益，纯添乱）。
      const beta = candidates.length <= DIVERSITY_MIN_CANDIDATES ? 0 : scoreCfg.beta

      // ── I2 分诊：残差金字塔（Gram-Schmidt）→ 是否扩检索 ────────────────────
      // 分诊口径：模块级默认常数（可经 cfg.triage 覆盖），**没有任何批次相关量**。
      const triageCfg = resolveTriageOptions(cfg.triage)
      // kBase = **内部**召回预算基线（= limit，仅决定候选池规模，**不承诺显示行数**）；
      // 扩检索预算 = min(2×kBase, 库内条数)
      // （规格：kExpanded = max(limit, 2×limit) 且**不超过库内条数** —— 库容小于 kBase 时
      //  kUsed 因此可能小于 kBase，但行为上不会少取候选：候选总数本身就 <= 库容，两种预算
      //  下 diversify 都只会取到库里全部候选）。
      const kBase = limit
      const kExpanded = Math.min(Math.max(kBase, kBase * 2), records.length)
      // 探测集：按（rel 降序 / 融合秩 / id 决胜）取前 kBase 个 —— 分诊只看「本来就会取的那些候选」。
      // 全部是本次调用的局部量；**绝不**把基/能量场缓存到模块级（见 pure.ts 顶部隔离红线）。
      const probe = [...candidates]
        .sort((a, b) => (b.score - a.score) || (a.rank - b.rank) || cmpId(a.id, b.id))
        .slice(0, kBase)
      const triage = residualPyramid(query, probe, stats, triageCfg)
      const expanded = triage.expanded
      const kUsed = expanded ? kExpanded : kBase

      // 多样性乘进同一个分数：final = rel × (1 − β·maxSim)；列表按 final 降序 ⇒ 打印天然单调。
      // ── I2.1 修 1：limit 是**硬显示上限** ─────────────────────────────────
      // 显示行数恒为 min(limit, 可用候选数)。扩检索只放大**内部**预算 kUsed（给金字塔取基、
      // 给多样性一个更大的候选池），**绝不**改变返回行数：旧实现把 limit 直接换成 kUsed 交给
      // diversify ⇒ limit=3 也能吐 6 行（实测 rows=6），调用方无法依赖 limit，契约被泄漏破坏。
      // 内部先按 kUsed 选（保持「扩检索=更大候选池」的语义），再按硬上限截断显示。
      const shownCap = Math.min(limit, candidates.length)
      const picked = diversify(candidates, { beta, limit: kUsed }).slice(0, shownCap)

      // 低置信：cov_max < activationThreshold。**低置信只影响如实报告**：
      // 不否决任何候选、不返回空（第三方明确回退过这种门控）。
      let covMax = 0
      for (const item of picked) if (Number.isFinite(item.cov) && item.cov > covMax) covMax = item.cov
      const lowConfidence = covMax < triageCfg.activationThreshold

      const lines: string[] = []
      const rows: L1Row[] = []
      for (const item of picked) {
        const rec = byId.get(item.id)
        if (rec === undefined) continue
        const raw = item.score
        // I1.3 自证修正：`rel` 直接打印**判定所用的同一个量**（BM25 原始分 raw），
        // 因为 `match` 就是 matchLevel(raw, weak, strong)。上一版把 rel 映射成 disp 再打印，
        // 阈值却仍作用于 raw ⇒ 读者拿打印值复现不出 match（自证断裂，实测 rel=0.3440 却判 weak）。
        // `score` 保留为映射到 0..1 的展示分 disp(final)，与 rel 不同标度，表头已如实说明。
        const view: L1ScoreView = {
          score: absoluteDisp(item.final, scoreCfg.scaleA, scoreCfg.scaleB),
          rel: raw,
          cov: item.cov,
          match: matchLevel(raw, scoreCfg.weak, scoreCfg.strong),
        }
        lines.push(formatL1(rec, view))
        rows.push({
          id: rec.id,
          kind: rec.kind,
          title: rec.title,
          tags: [...rec.tags],
          rel: view.rel,
          cov: view.cov,
          match: view.match,
          score: view.score,
        })
      }

      // 表头必须如实说明四列含义与两种标度（单行：recall 用例按 split('\n') 切片核对行）。
      // I2 追加一段**分诊自证**：novelty 与阈值、kBase/kUsed、explainedRatio/residualRatio、
      // cov_max 与 activationThreshold 全部打印 ⇒ 读者能用打印的数自行复算 expanded 与 lowConfidence。
      // I2.1 修 1：写明 limit 是硬显示上限、扩检索只放大内部候选池；
      // I2.1 修 2：无词元能量时**如实写明「未分诊」**（不假装算过：两个比值回显 0/0）。
      const triageSeg = triage.noQueryEnergy
        ? `I2 分诊（词法空间残差金字塔）：novelty=0.0000（查询无词元能量 ‖q‖²≈0 ⇒ 未分诊，`
          + `阈值 ${triageCfg.noveltyThreshold} 不参与门控）⇒ expanded=false；`
          + `kBase=${kBase} -> kUsed=${kUsed}（未分诊 ⇒ 不扩检索，kUsed=kBase）；`
          + 'explainedRatio=0.0000 residualRatio=0.0000（0/0 未定义：无词元能量可解释）；'
        : `I2 分诊（词法空间残差金字塔）：novelty=${triage.novelty.toFixed(4)} ${expanded ? '>=' : '<'} 阈值 ${triageCfg.noveltyThreshold} ⇒ expanded=${expanded}；`
          + `kBase=${kBase} -> kUsed=${kUsed}（分诊判定${expanded ? '扩检索' : '不扩检索'}：kUsed 是内部候选池预算，显示行数仍受硬上限 limit=${limit} 约束）；`
          + `explainedRatio=${triage.explainedRatio.toFixed(4)} + residualRatio=${triage.residualRatio.toFixed(4)} = 1；`
      const header = `记忆召回（L1 索引，不含正文）：query=${JSON.stringify(query)} | 库内 ${records.length} 条 | `
        + `融合候选 ${fused.length} 条 | 本次显示 ${lines.length} 条（limit=${limit} 是硬显示上限：`
        + '返回行数恒为 min(limit,可用候选数)，扩检索只放大内部候选池、不增加返回行数）| '
        + '列序：id | kind | title | tags | rel(惩罚前相关度) | cov(标签覆盖率,仅诊断) | match(绝对判定) | score(含多样性惩罚的最终分,按此降序) | '
        + 'rel=BM25 原始相关度（绝对标度，不随批次归一化）——阈值直接作用于它，可据此自行验算 match；'
        + `score=disp(final)=clip((final-${scoreCfg.scaleA})/(${scoreCfg.scaleB}-${scoreCfg.scaleA})) 映射到 0..1 的展示分（与 rel 不同标度，仅用于排序展示）；`
        + `阈值 match：rel>=${scoreCfg.weak} 为 weak、>=${scoreCfg.strong} 为 strong，无证据为 none（不扣分）；`
        + `多样性 beta=${beta}${beta === 0 ? '（候选<=5，已跳过）' : ''} | `
        + triageSeg
        + `basisSize=${triage.basisSize} layers=${triage.layers} logicalDepth=${triage.logicalDepth.toFixed(4)}；`
        + (lowConfidence
          ? `低置信：cov_max=${covMax.toFixed(4)} < ${triageCfg.activationThreshold}（仅如实报告：不否决任何候选、不返回空）`
          : `非低置信：cov_max=${covMax.toFixed(4)} >= ${triageCfg.activationThreshold}`)
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
        scaleA: scoreCfg.scaleA,
        scaleB: scoreCfg.scaleB,
        weakThreshold: scoreCfg.weak,
        strongThreshold: scoreCfg.strong,
        diversityBeta: beta,
        diversityApplied: beta > 0,
        // I2 分诊字段（全部是本次调用的局部结论；rows 之外的返回体，schema 已同步声明）
        expanded,
        noQueryEnergy: triage.noQueryEnergy,
        kBase,
        kUsed,
        novelty: triage.novelty,
        explainedRatio: triage.explainedRatio,
        residualRatio: triage.residualRatio,
        basisSize: triage.basisSize,
        layers: triage.layers,
        logicalDepth: triage.logicalDepth,
        lowConfidence,
        // 口径回显：读者据此可自行复算 expanded 与 lowConfidence（I1.3 可复算铁律的延续）
        noveltyThreshold: triageCfg.noveltyThreshold,
        activationThreshold: triageCfg.activationThreshold,
        covMax,
        lines: fitted.lines,
        // rows 与真正打印出来的 lines 一一对应（截断时同步裁剪，不给出没打印的行）。
        rows: rows.slice(0, fitted.lines.length),
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
