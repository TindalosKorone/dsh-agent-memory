// 用例 11：I4a.1 注入松耦合 —— 「缺 systemPrompt 时工具面仍然可用」。
//
// 为什么单独立一个文件：这条契约讲的是**插件级的可用性边界**，必须用**裸 cordis**跑，
// 才能判出 cordis 的「必需依赖」语义（桩 ctx 复刻不了 fiber 的 PENDING 门禁）：
//  1) 绿：inject = ['tools']，环境里**只有 tools、没有 systemPrompt** ⇒
//     插件照常 apply、4 个工具全部注册、注入子 fiber 安静地停在 PENDING（不抛错、不注册任何 context）；
//  2) 红：把 inject 改回 ['tools','systemPrompt'] 的**同一份构建产物副本**（源码级改回旧声明）⇒
//     同一个探针 + 同一条断言必须变红（插件 fiber 停在 PENDING、工具数 0）—— 这正是本次修掉的旧行为；
//  3) 反向：有 systemPrompt（真引擎服务）时注入**确实注册成功**（context 项存在、文本非空、<= 240），
//     防止我们把「功能」当成「耦合」一起改坏。
//
// 说明：必须提供 tools 服务，否则连底线依赖都缺，插件当然不 apply，那就证明不了「只有 systemPrompt 缺」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as realPlugin from '../lib/index.js'
import { apply } from '../lib/index.js'
import { DEFAULT_INJECTION_MAX_CHARS, INJECTION_CONTEXT_NAME, INJECTION_CONTEXT_ORDER } from '../lib/inject.js'
import { serialize } from '../lib/store.js'
import { PLUGIN_DIR, TMP_ROOT, freshHome, makeCtx, memFile, record } from './helpers.mjs'

// 依赖面：cordis 是插件的 peerDependency（devDependencies 里也锁了 4.0.4），
// dsh-system-prompt 用来做「反向断言」那一半（真引擎服务，不是桩）。
let CORDIS = null
let SP = null
try { CORDIS = await import('@deepseek-ai/cordis') } catch { CORDIS = null }
try { SP = await import('@deepseek-ai/dsh-system-prompt') } catch { SP = null }

const TOOL_NAMES = ['memory_expand', 'memory_prune', 'memory_recall', 'memory_remember']
// cordis FiberState（lib/types/fiber.d.ts，declare const enum 运行时不导出，所以按数值用并在此注明）：
// PENDING=0 LOADING=1 ACTIVE=2 FAILED=3 DISPOSED=4 UNLOADING=5
const FIBER_PENDING = 0
const FIBER_ACTIVE = 2
const FIBER_FAILED = 3

const DAY = 86_400_000
const T0 = 1_700_000_000_000

/** 宏任务：cordis 的 fiber 迁状态是异步的，plugin() 之后必须让出一轮再读状态。 */
function tick() {
  return new Promise((r) => setTimeout(r, 20))
}

/** 直接写盘造库（只用于造「库里有 N 条」的形状）。 */
function seed(home, records) {
  const p = memFile(home)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, serialize(records), 'utf8')
  return p
}

/** 观测一张裸 cordis ctx 上所有 fiber 的 (名字, 状态, 注入面)；不猜内部字段以外的任何东西。 */
function fiberSnapshot(root) {
  const out = []
  for (const [, runtime] of root.registry.entries()) {
    for (const fiber of runtime.fibers) {
      out.push({ name: runtime.name, state: fiber.state, inject: Object.keys(fiber.inject) })
    }
  }
  return out
}

/**
 * 共用探针：裸 cordis + 只提供 tools、**不提供** systemPrompt，然后加载给定插件模块。
 * 绿/红两次跑的是同一个函数、同一批断言 —— 唯一的变量就是插件的 inject 声明。
 */
async function probeWithoutSystemPrompt(pluginModule, home) {
  assert.ok(CORDIS !== null, '本探针需要真 cordis（插件 node_modules 里就有）')
  const root = new CORDIS.Context()
  const defs = new Map()
  root.plugin({
    name: 'probe-tools',
    apply: (c) => {
      c.provide('tools', {
        register: (def) => { defs.set(def.name, def); return { dispose: () => defs.delete(def.name) } },
      })
    },
  })
  await tick()
  assert.ok(root.get('tools') !== undefined, '前置：tools 服务必须已经可用（这是插件唯一的必需依赖）')

  let loadError = null
  let fiber = null
  try {
    fiber = root.plugin(pluginModule, { home })
  } catch (err) {
    loadError = err
  }
  await tick()
  return {
    root,
    defs,
    fiber,
    loadError,
    fibers: fiberSnapshot(root),
    systemPromptPresent: root.get('systemPrompt') !== undefined,
  }
}

/**
 * 红证用的构建产物副本：整份 lib/*.js 拷进 .tmp-test，只把 inject 那一行改回旧声明。
 * 这样做是「源码级改回」，比在测试里另造一个 { inject } 对象更接近真实回归：
 * 跑的是同一份编译产物，唯一差异就是那一行。
 */
function buildHardInjectCopy() {
  const dir = join(TMP_ROOT, 'hard-inject')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const file of ['index.js', 'inject.js', 'json.js', 'protocol.js', 'pure.js', 'store.js']) {
    cpSync(join(PLUGIN_DIR, 'lib', file), join(dir, file))
  }
  const entry = join(dir, 'index.js')
  const src = readFileSync(entry, 'utf8')
  const needle = "export const inject = ['tools'];"
  const patched = src.replace(needle, "export const inject = ['tools', 'systemPrompt'];")
  if (patched === src) {
    // 找不到锚点就必须炸：否则红证会「静默变成绿」，那就等于没有红证。
    throw new Error(`红证副本构建失败：lib/index.js 里没有找到 ${needle}`)
  }
  writeFileSync(entry, patched, 'utf8')
  return entry
}

/** 绿环境必须通过的断言（同一条断言会拿去砸红环境，必须砸出红来）。 */
function assertToolsAlive(res) {
  assert.equal(res.loadError, null, '插件加载不得抛错')
  assert.equal(res.fiber?.state, FIBER_ACTIVE, '插件 fiber 必须是 ACTIVE（apply 真的跑了）')
  assert.deepEqual([...res.defs.keys()].sort(), TOOL_NAMES, '4 个工具必须全部注册')
}

// ── 1. 绿：缺 systemPrompt，工具面照常 ─────────────────────────────────────
test('I4a.1 松耦合：没有 systemPrompt 的裸 cordis 环境 ⇒ 插件 apply、4 个工具全在、注入安静降级', async () => {
  const home = freshHome('i4a1-loose')
  const green = await probeWithoutSystemPrompt(realPlugin, home)

  assert.equal(green.systemPromptPresent, false, '前置：这个环境确实没有 systemPrompt 服务')
  assert.deepEqual([...realPlugin.inject], ['tools'], 'inject 只声明底线工具面')
  assertToolsAlive(green)

  // (c) 没有注入注册、不抛错、安静降级：只有一个「等 systemPrompt」的子 fiber，停在 PENDING。
  // 它一旦解析到 systemPrompt 才会执行回调去注册 context；现在没有 ⇒ 一个 context 都没注册。
  const waiting = green.fibers.filter((f) => f.inject.join(',') === 'systemPrompt')
  assert.equal(waiting.length, 1, '必须恰好有一个等待 systemPrompt 的注入子 fiber')
  assert.equal(waiting[0].state, FIBER_PENDING, '注入子 fiber 必须安静停在 PENDING（不是 FAILED）')
  assert.ok(green.fibers.every((f) => f.state !== FIBER_FAILED), '不得有任何 fiber 进 FAILED（安静降级，不是报错）')
  assert.equal(green.root.get('systemPrompt'), undefined, '注入面缺席：没有任何可注册的地方')

  // 桩层再确认一次同一契约（不依赖真 cordis）：拿掉 systemPrompt 桩 ⇒ 工具面在、注入注册数 0。
  const { ctx, defs, contexts } = makeCtx()
  delete ctx.systemPrompt
  assert.doesNotThrow(() => apply(ctx, { home }))
  assert.deepEqual([...defs.keys()].sort(), TOOL_NAMES)
  assert.equal(contexts.size, 0, '没有 systemPrompt 时不得注册任何 context')
})

// ── 2. 红证：把 inject 改回旧声明 ⇒ 同一断言必须变红 ────────────────────────
test('I4a.1 红证：inject 改回 [tools, systemPrompt] 的同一份构建副本 ⇒ 插件不 apply、工具数 0', async () => {
  const hardEntry = buildHardInjectCopy()
  const hard = await import(pathToFileURL(hardEntry).href)
  assert.deepEqual([...hard.inject], ['tools', 'systemPrompt'], '红证副本必须真的声明了旧的硬依赖')

  const redHome = freshHome('i4a1-red')
  const red = await probeWithoutSystemPrompt(hard, redHome)

  // 同一条断言，绿环境不抛……
  const green = await probeWithoutSystemPrompt(realPlugin, freshHome('i4a1-red-green'))
  assertToolsAlive(green)
  // ……砸到红环境必须抛：这就是「红证真的红」。
  let redError = null
  try {
    assertToolsAlive(red)
  } catch (err) {
    redError = err
  }
  assert.ok(redError !== null, '红证必须真的红：同一条断言在旧声明下必须失败（否则是假绿）')
  assert.ok(redError instanceof assert.AssertionError, `红证失败的应当是断言失败，实测 ${redError?.name}`)

  // 红的具体形态：fiber 停在 PENDING（apply 根本没跑）、一个工具都没注册。
  assert.equal(red.loadError, null, 'cordis 不会抛：它只是把 fiber 停在 PENDING（这更隐蔽）')
  assert.equal(red.fiber.state, FIBER_PENDING, '缺 systemPrompt ⇒ 整个插件（含工具）都不 apply')
  assert.equal(red.defs.size, 0, '旧写法下 4 个能用的工具一个都不会注册')
  assert.ok(!red.fibers.some((f) => f.inject.join(',') === 'tools'), '红环境连 tools 依赖都没被解析（fiber 没启动）')
})

// ── 3. 反向断言：有 systemPrompt 时注入确实注册成功 ────────────────────────
test('I4a.1 反向断言：有 systemPrompt 时注入确实注册（context 存在、文本非空、<= 240）', async () => {
  assert.ok(CORDIS !== null && SP !== null, '反向断言需要真 cordis + 真 dsh-system-prompt')
  const root = new CORDIS.Context()
  const defs = new Map()
  root.plugin({
    name: 'probe-tools',
    apply: (c) => {
      c.provide('tools', {
        register: (def) => { defs.set(def.name, def); return { dispose: () => defs.delete(def.name) } },
      })
    },
  })
  root.plugin(SP.default)
  await tick()

  const service = root.get('systemPrompt')
  assert.ok(service, '真引擎 SystemPrompt 服务必须可用')

  // 另注册一个 order 很小的对照 context：用来在真 assemble() 里验证我们的 order=200 确实排在后面
  // （AssembledContext 只暴露 {name,text}，order 字段本身落在注册面上，见 inject.test.mjs 的桩路径断言）。
  root.plugin({
    name: 'probe-low-context',
    inject: ['systemPrompt'],
    apply: (c) => { c.systemPrompt.context({ name: 'probe:low', order: 10, text: () => '低优先对照' }) },
  })

  const home = freshHome('i4a1-reverse')
  // 【I4a.2 契约变更】原来只有 1 条记录，任何标签的出现率都是 100% ⇒ 会被锚点资格过滤掉，
  // 那一行会退化成「无可区分锚点」（文本仍非空，但本用例要断言带锚点的完整行）。
  // 这里补 9 条共用一个超频标签的记录（9/10 = 0.9 > 0.3 ⇒ 该标签被剔除，不抢锚点），
  // 于是 `松耦合`（1/10 = 0.1）如实成为唯一锚点；降级口径由 test/anchor.test.mjs 覆盖。
  const filler = []
  for (let i = 0; i < 9; i += 1) filler.push(record(`mem_f${i}`, T0 + (i + 1) * DAY, { tags: ['调试填充'] }))
  seed(home, [record('mem_r1', T0, { tags: ['松耦合'] }), ...filler])

  const fiber = root.plugin(realPlugin, { home })
  await tick()
  assert.equal(fiber.state, FIBER_ACTIVE, '有 systemPrompt 时插件同样必须 ACTIVE')
  assert.deepEqual([...defs.keys()].sort(), TOOL_NAMES, '工具面照旧 4 个')

  const assembly = await service.assemble({})
  const mine = assembly.contexts.filter((c) => c.name === INJECTION_CONTEXT_NAME)
  assert.equal(mine.length, 1, `必须恰好注册一个名为 ${INJECTION_CONTEXT_NAME} 的 context`)
  assert.equal(INJECTION_CONTEXT_ORDER, 200, 'order 原样保留（200 = 尾部块，未变）')
  assert.ok(INJECTION_CONTEXT_ORDER > 120, 'order 必须仍大于 CONTEXT_ORDERS 里最大的 120')
  assert.ok(
    assembly.contexts.findIndex((c) => c.name === INJECTION_CONTEXT_NAME) > assembly.contexts.findIndex((c) => c.name === 'probe:low'),
    '真 assemble() 里我们的 context 必须排在 order=10 的对照之后（order 真的生效）',
  )
  assert.ok(mine[0].text.length > 0, '文本必须非空（功能没被改坏）')
  assert.ok(mine[0].text.length <= DEFAULT_INJECTION_MAX_CHARS, `文本长度 ${mine[0].text.length} 必须 <= 240`)
  assert.ok(mine[0].text.includes('memory_recall'), '查询工具指路照旧在（只是换了句式）')
  assert.ok(mine[0].text.includes('先 memory_recall 查库'), 'I4a.3：真引擎路径上那行同样必须是条件规则')
  assert.equal(mine[0].text, '记忆 10 条（跨会话经验教训）｜排查·为什么·复现·以前是否踩过 这类问题，先 memory_recall 查库｜标签锚点：松耦合')
  // I4a.3：稳定段也必须经真引擎注册成功（section 与 context 是两张表）
  const mySections = assembly.sections.filter((s) => s.name === 'agent-memory-habit')
  assert.equal(mySections.length, 1, '真引擎 assemble 的 sections 里必须有 agent-memory-habit')
  assert.ok(mySections[0].text.includes('先用 memory_recall 查记忆库'), `段文本必须含触发条件，实测 ${mySections[0].text}`)
})

// ── 4. 迟到依赖：加载顺序不再决定注入生死 ─────────────────────────────────
test('I4a.1 迟到依赖：systemPrompt 后到（插件先加载）也能注册（不靠加载顺序）', async () => {
  assert.ok(CORDIS !== null && SP !== null, '本用例需要真 cordis + 真 dsh-system-prompt')
  const root = new CORDIS.Context()
  const defs = new Map()
  root.plugin({
    name: 'probe-tools',
    apply: (c) => {
      c.provide('tools', {
        register: (def) => { defs.set(def.name, def); return { dispose: () => defs.delete(def.name) } },
      })
    },
  })
  await tick()

  const home = freshHome('i4a1-late')
  seed(home, [record('mem_late', T0, { tags: ['迟到'] })])
  const fiber = root.plugin(realPlugin, { home })
  await tick()

  // systemPrompt 还没到：工具面已经活，注入面安静等在 PENDING（不是整插件停在 PENDING）
  assert.equal(root.get('systemPrompt'), undefined)
  assert.equal(fiber.state, FIBER_ACTIVE, '缺注入能力不妨碍插件先跑起来')
  assert.deepEqual([...defs.keys()].sort(), TOOL_NAMES)
  const waiting = fiberSnapshot(root).filter((f) => f.inject.join(',') === 'systemPrompt')
  assert.equal(waiting.length, 1)
  assert.equal(waiting[0].state, FIBER_PENDING)

  // systemPrompt 到位 ⇒ 条件注册的回调真的执行，注入自己接上（不需要重载插件）
  root.plugin(SP.default)
  await tick()
  const service = root.get('systemPrompt')
  assert.ok(service, 'systemPrompt 后到也必须可用')
  const assembly = await service.assemble({})
  const mine = assembly.contexts.filter((c) => c.name === INJECTION_CONTEXT_NAME)
  assert.equal(mine.length, 1, 'systemPrompt 到位后注入必须自己接上')
  assert.ok(mine[0].text.length > 0 && mine[0].text.length <= DEFAULT_INJECTION_MAX_CHARS)
  assert.equal(fiber.state, FIBER_ACTIVE)
  assert.deepEqual([...defs.keys()].sort(), TOOL_NAMES, '工具面全程不受影响')
})
