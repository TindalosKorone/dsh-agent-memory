// I4a.1 红证探针：裸 cordis（真依赖注入语义）+ 只提供 tools、不提供 systemPrompt。
//
// 用法：
//   node scripts/i4a1-loose-probe.mjs real   # 真实构建产物（inject = ['tools']，松耦合）⇒ 工具面必须活
//   node scripts/i4a1-loose-probe.mjs hard   # 把 inject 改回 ['tools','systemPrompt'] 的构建副本 ⇒ 工具面必须死
//
// 为什么要用裸 cordis：cordis 的 inject 是**必需依赖**，fiber 只有每个名字都解析到实现才执行 apply()。
// 桩 ctx 复刻不了这个门禁，只有真 cordis 才能判出「缺 systemPrompt ⇒ 整个插件（含 4 个工具）都不 apply」。
// 本脚本只读构建产物 + 在 .tmp-test 下复制一份改一行的副本，绝不改 src/ 与 lib/。
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = dirname(HERE)
const TMP = join(PLUGIN_DIR, '.tmp-test', 'i4a1-probe')
const LIB_FILES = ['index.js', 'inject.js', 'json.js', 'protocol.js', 'pure.js', 'store.js']

const mode = process.argv[2] === 'hard' ? 'hard' : 'real'

function sha8(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 8)
}

/** 把 lib/*.js 拷到 .tmp-test 并只改 inject 那一行（红证要的「改回旧声明」）。 */
function buildHardCopy() {
  const dir = join(TMP, 'hard-inject')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const f of LIB_FILES) cpSync(join(PLUGIN_DIR, 'lib', f), join(dir, f))
  const entry = join(dir, 'index.js')
  const src = readFileSync(entry, 'utf8')
  const needle = "export const inject = ['tools'];"
  const patched = src.replace(needle, "export const inject = ['tools', 'systemPrompt'];")
  if (patched === src) throw new Error(`副本构建失败：lib/index.js 里没有找到 ${needle}`)
  writeFileSync(entry, patched, 'utf8')
  return entry
}

/** 造一个确定的小库（2 条），让注入文本可复现。 */
function seedHome(serialize) {
  const home = join(TMP, 'home')
  rmSync(home, { recursive: true, force: true })
  mkdirSync(join(home, 'agent-memory'), { recursive: true })
  const file = join(home, 'agent-memory', 'memory.ndjson')
  writeFileSync(file, serialize([
    { id: 'mem_a', ts: 1_700_000_000_000, kind: 'fact', title: '第一条记忆用于探针', body: '正文 a', tags: ['松耦合', '注入'], source: 'probe:seed', hits: 0 },
    { id: 'mem_b', ts: 1_700_086_400_000, kind: 'lesson', title: '第二条记忆用于探针', body: '正文 b', tags: ['松耦合'], source: 'probe:seed', hits: 0 },
  ]), 'utf8')
  return { home, file }
}

const tick = () => new Promise((r) => setTimeout(r, 20))

const store = await import(join(PLUGIN_DIR, 'lib', 'store.js'))
const cordis = await import('@deepseek-ai/cordis')

const entry = mode === 'hard' ? buildHardCopy() : join(PLUGIN_DIR, 'lib', 'index.js')
const plugin = await import(entry)
const { home, file } = seedHome(store.serialize)
const source = readFileSync(entry, 'utf8')

console.log(`=== I4a.1 红证探针（mode=${mode}）===`)
console.log(`cordis: ${cordis.Context ? '已加载' : '缺失'} | FiberState: PENDING=0 LOADING=1 ACTIVE=2 FAILED=3 DISPOSED=4 UNLOADING=5`)
console.log(`插件模块: ${entry}`)
console.log(`声明的 inject: ${JSON.stringify(plugin.inject)}`)
console.log(`源码里 inject 那一行: ${source.split('\n').find((l) => l.startsWith('export const inject'))}`)
console.log(`探针库: ${home} （2 条，${file}）`)
console.log('')

// ── 环境 A：只有 tools、没有 systemPrompt ─────────────────────────────────
const rootA = new cordis.Context()
const defs = new Map()
rootA.plugin({
  name: 'probe-tools',
  apply: (c) => {
    c.provide('tools', {
      register: (d) => { defs.set(d.name, d); return { dispose: () => defs.delete(d.name) } },
    })
  },
})
await tick()
console.log('=== A. 环境：有 tools、没有 systemPrompt（这就是「缺一块」的环境）===')
console.log(`  tools 服务就位: ${rootA.get('tools') !== undefined} | systemPrompt 服务: ${rootA.get('systemPrompt') !== undefined}`)
let fiberA = null
let thrownA = null
try {
  fiberA = rootA.plugin(plugin, { home })
} catch (err) {
  thrownA = err
}
await tick()
console.log(`  加载时是否抛错: ${thrownA === null ? '否' : `是（${thrownA.message}）`}`)
console.log(`  插件 fiber 状态: ${fiberA?.state}（0=PENDING 2=ACTIVE 3=FAILED）`)
console.log(`  注册的工具数: ${defs.size} | ${[...defs.keys()].sort().join(', ') || '(无)'}`)
for (const [, rt] of rootA.registry.entries()) {
  for (const f of rt.fibers) {
    console.log(`  fiber: name=${JSON.stringify(rt.name)} state=${f.state} inject=${JSON.stringify(Object.keys(f.inject))}`)
  }
}
const waiting = [...rootA.registry.entries()].flatMap(([, rt]) => [...rt.fibers].map((f) => ({ state: f.state, inject: Object.keys(f.inject) })))
  .filter((f) => f.inject.join(',') === 'systemPrompt')
console.log(`  等待 systemPrompt 的注入子 fiber: ${waiting.length} 个，状态 ${JSON.stringify(waiting.map((f) => f.state))}（0=PENDING ⇒ 回调没跑 ⇒ 一个 context 都没注册）`)
const alive = fiberA?.state === 2 && defs.size === 4
console.log(`  契约判定「工具面活着」: ${alive}`)

// ── 环境 B：有 systemPrompt（真引擎服务）⇒ 注入必须照旧注册 ────────────────
console.log('')
console.log('=== B. 环境：systemPrompt 也在（真 dsh-system-prompt 服务）===')
let sp = null
try { sp = await import('@deepseek-ai/dsh-system-prompt') } catch { sp = null }
if (sp === null) {
  console.log('  dsh-system-prompt 不可用：如实降级，跳过 B（不做任何猜测）')
} else {
  const rootB = new cordis.Context()
  const defsB = new Map()
  rootB.plugin({
    name: 'probe-tools',
    apply: (c) => {
      c.provide('tools', {
        register: (d) => { defsB.set(d.name, d); return { dispose: () => defsB.delete(d.name) } },
      })
    },
  })
  rootB.plugin(sp.default)
  await tick()
  // order=10 的对照 context：用来验证我们的 order=200 在真 assemble() 里确实排在后面
  rootB.plugin({
    name: 'probe-low-context',
    inject: ['systemPrompt'],
    apply: (c) => { c.systemPrompt.context({ name: 'probe:low', order: 10, text: () => '低优先对照' }) },
  })
  await tick()
  const service = rootB.get('systemPrompt')
  const fiberB = rootB.plugin(plugin, { home })
  await tick()
  const assembly = await service.assemble({})
  const mine = assembly.contexts.filter((c) => c.name === 'agent-memory')
  console.log(`  systemPrompt 服务就位: ${service !== undefined} | 插件 fiber 状态: ${fiberB.state} | 工具数: ${defsB.size}`)
  console.log(`  注入 context 命中数: ${mine.length} | name: ${mine.map((c) => c.name).join(',') || '(无)'}`)
  console.log(`  注入行: ${JSON.stringify(mine[0]?.text ?? '')} （字符数 ${mine[0]?.text.length ?? 0}，上限 240）`)
  console.log(`  注入行 sha256[0:8]: ${mine[0] ? sha8(mine[0].text) : '(无)'}`)
  console.log(`  contexts 顺序（order=10 对照在前、200 在后）: ${assembly.contexts.map((c) => c.name).join(' -> ')}`)
}

console.log('')
console.log('=== 结论 ===')
if (mode === 'real') {
  console.log(`A 环境（缺 systemPrompt）: 工具面 ${alive ? '活' : '死'}；注入面安静降级（子 fiber 停在 PENDING）`)
  console.log('预期（松耦合）: 工具面活 ⇒ 本文件是「恢复后绿」的那一份。')
} else {
  console.log(`A 环境（缺 systemPrompt）: 工具面 ${alive ? '活' : '死'}；插件 fiber state=${fiberA?.state}`)
  console.log('预期（旧硬依赖）: 工具面死（fiber 停在 PENDING、工具数 0）⇒ 本文件是「红」的那一份。')
}
console.log(`红/绿判定: ${mode === 'real' ? (alive ? '绿（符合预期）' : '意外红') : (alive ? '意外绿（红证失败）' : '红（符合预期）')}`)
