// 行格式逐字节对照探针（非测试）：用**同一份固定语料 + 同一批查询**分别跑"改动前/改动后"的
// lib/index.js，只比较 L1 的 `lines`（formatL1 的输出）与 rows 的取值（键序另行说明）。
// 用法：node redproof/lineformat-probe.mjs <lib/index.js 路径> <home 子目录名>
//
// 固定语料直接落盘（固定 id/ts），避免 remember 生成的随机 id 干扰逐字节比较。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = dirname(HERE)
const LIB = resolve(process.argv[2] ?? join(PLUGIN, 'lib', 'index.js'))
const TAG = process.argv[3] ?? 'current'
const HOME = join(PLUGIN, '.tmp-test', `lineformat-home-${TAG}`)

rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, 'agent-memory'), { recursive: true })
process.env.DSH_HOME = HOME
delete process.env.DSH_AGENT_MEMORY_MAX_RECORDS
delete process.env.DSH_AGENT_MEMORY_MAX_BYTES
delete process.env.DSH_AGENT_MEMORY_MAX_RECORD_BYTES

/** 固定语料：含"仅由标签图到达"的记录、共享标签、噪声与长文（覆盖三种 match + 行尾分数）。 */
const RECORDS = [
  { id: 'mem_ff01', ts: 1700000000000, kind: 'fact', title: 'alpha focused note', body: 'alpha evidence here', tags: ['alpha'], source: 'probe:first', hits: 0 },
  { id: 'mem_ff02', ts: 1700000001000, kind: 'lesson', title: 'alpha secondary note', body: 'unrelated text content', tags: ['alpha', 'beta'], source: 'probe:second', hits: 2 },
  { id: 'mem_ff03', ts: 1700000002000, kind: 'preference', title: 'plain beta record', body: 'nothing to match here', tags: ['beta'], source: 'probe:third', hits: 0 },
  { id: 'mem_ff04', ts: 1700000003000, kind: 'pointer', title: 'long alpha body note', body: `alpha ${'filler '.repeat(40)}`, tags: ['alpha', 'gamma'], source: 'probe:fourth', hits: 1 },
  { id: 'mem_ff05', ts: 1700000004000, kind: 'fact', title: 'delta standalone', body: 'delta only body', tags: ['delta'], source: 'probe:fifth', hits: 0 },
  { id: 'mem_ff06', ts: 1700000005000, kind: 'fact', title: 'omega noise item', body: 'omega noise body', tags: ['omega'], source: 'probe:sixth', hits: 0 },
  { id: 'mem_ff07', ts: 1700000006000, kind: 'lesson', title: 'gamma bridge note', body: 'gamma bridge body', tags: ['gamma', 'delta'], source: 'probe:seventh', hits: 3 },
]
writeFileSync(join(HOME, 'agent-memory', 'memory.ndjson'), RECORDS.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

/** 桩 ctx（与 test/helpers.mjs 同形，但工具定义从这个 LIB 里来）。 */
function makeCtx() {
  const defs = new Map()
  const ctx = {
    tools: { register: (d) => { defs.set(d.name, d); return { dispose: () => defs.delete(d.name) } } },
    effect: (cb) => { cb() },
    systemPrompt: { context: () => ({ dispose: () => {} }) },
    inject: (deps, cb) => { cb({ systemPrompt: ctx.systemPrompt }); return { dispose: () => {} } },
  }
  return { ctx, defs }
}

const { apply } = await import(LIB)
const { ctx, defs } = makeCtx()
apply(ctx, {})
const recall = defs.get('memory_recall')

const CASES = [
  { query: 'alpha', limit: 5 },
  { query: 'alpha', limit: 2 },
  { query: 'delta gamma', limit: 7 },
  { query: 'zeta 无关查询', limit: 5 },
  { query: '   ', limit: 5 },
  { query: 'alpha', limit: 5, cfg: { graph: { maxHops: 0 } } },
  { query: 'alpha', limit: 5, cfg: { score: { scaleA: 0 } } },
]

const out = []
for (const [i, c] of CASES.entries()) {
  const rd = c.cfg === undefined ? recall : makeCtxWith(c.cfg).get('memory_recall')
  const r = await rd.execute({ query: c.query, limit: c.limit })
  out.push({
    case: i,
    query: c.query,
    limit: c.limit,
    shown: r.shown,
    truncated: r.truncated,
    diversityApplied: r.diversityApplied,
    header: r.text.split('\n')[0],
    lines: r.lines,
    // rows 取值的规范串（键序**排除**在比较之外：本次对账正是要改键序）
    rowsCanonical: JSON.stringify(r.rows.map((row) => Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))),
    rowKeyOrder: r.rows.length > 0 ? Object.keys(r.rows[0]).join('|') : '',
  })
}

function makeCtxWith(cfg) {
  const { ctx: c, defs: d } = makeCtx()
  apply(c, cfg)
  return d
}

process.stdout.write(JSON.stringify(out, null, 1))
