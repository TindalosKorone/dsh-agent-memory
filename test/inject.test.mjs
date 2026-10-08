// 用例 10：I4a 稳定记忆索引注入（systemPrompt 尾部动态块 / context 贡献）。
//
// 契约（与任务规格一一对应，全部可判红）：
//  1) 注册面：name 固定、order 是**显式数字且大于 120**、text 是函数（引擎每次 assemble 现算）；
//  2) 开关：injection.enabled=false ⇒ **不注册**（contexts 里没有）且不输出任何字符；
//  3) 内容：**一行**、与查询无关、低频变化（条数 + 词频锚点 + 工具指路），不含 `{` `}`（引擎插值会抛）；
//  4) 硬上限：任何输入下注入文本长度 <= maxChars，超限必须带如实省略标记；
//  5) 稳定性：库不变 ⇒ 逐字节相同（含不同 assemble 参数、不同缓存实例）；库变了才变；
//  6) fail-open：读库/解析/注册任何异常都**不抛**，注入空串或最小占位；
//  7) 缓存：只读、幂等，键严格是 {path, size, mtimeMs}（与库自身的外部改动守卫同口径）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { apply } from '../lib/index.js'
import {
  DEFAULT_INJECTION_MAX_CHARS, DEFAULT_INJECTION_TOP_TAGS, HARD_MARK,
  INJECTION_CONTEXT_NAME, INJECTION_CONTEXT_ORDER,
  buildInjectionIndex, createInjectionCache, planInjectionLine, resolveInjectionOptions,
  sanitizeForPrompt, stableAnchors,
} from '../lib/inject.js'
import { resolveMaxRecords, serialize } from '../lib/store.js'
import { appliedContexts, freshHome, makeCtx, memFile, record, tools } from './helpers.mjs'

const DAY = 86_400_000
const T0 = 1_700_000_000_000

/** 直接写盘造库（绕过写入协议的既有契约，只用于造「库里有 N 条」的形状）。 */
function seed(home, records) {
  const p = memFile(home)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, serialize(records), 'utf8')
  return p
}

/** 3 条固定记忆：锚点频次 失败关闭:2 / render:1 / 协议:1 ⇒ 锚点 = 失败关闭 / render / 协议（码元升序决胜）。 */
function smallLibrary() {
  return [
    record('mem_a', T0, { tags: ['失败关闭', 'render'] }),
    record('mem_b', T0 + DAY, { tags: ['失败关闭', '协议'] }),
    record('mem_c', T0 + 2 * DAY, { tags: ['测试'] }),
  ]
}

const SMALL_EXPECT = '记忆 3 条（上限 2000）｜标签锚点：失败关闭 / render / 协议｜细则用 memory_recall'

/** 2000 条 + 12 个 32 字符长标签 ⇒ 默认预算下就超限（用 topTags=64 让超限更明确）。 */
function bigLibrary(n) {
  const out = []
  for (let i = 0; i < n; i += 1) {
    const tags = []
    for (let k = 0; k < 12; k += 1) tags.push(`长标签${String(k).padStart(2, '0')}-${'z'.repeat(22)}`)
    out.push({
      id: `mem_big_${String(i).padStart(4, '0')}`,
      ts: T0 + i,
      kind: 'fact',
      title: `压测标题 ${i} 用于验证超限截断`,
      body: `正文 ${i}`,
      tags,
      source: 'test:big',
      hits: 0,
    })
  }
  return out
}

/** 取某配置下 apply() 注册的注入函数，并断言「注册成功」。 */
function registeredText(config) {
  const contexts = appliedContexts(config)
  const contribution = contexts.get(INJECTION_CONTEXT_NAME)
  assert.ok(contribution, `必须注册名为 ${INJECTION_CONTEXT_NAME} 的 context 贡献`)
  assert.equal(typeof contribution.text, 'function', 'text 必须是函数（引擎每次 assemble 现算）')
  return { contribution, text: contribution.text() }
}

/** 真实 fs 的可注入包装（与 storage.test.mjs 同风格）。 */
function injectedFs(overrides = {}) {
  return {
    existsSync: () => false,
    mkdirSync: () => {},
    readFileSync: () => '',
    writeFileSync: () => {},
    renameSync: () => {},
    unlinkSync: () => {},
    statSync: () => { throw new Error('not-found') },
    ...overrides,
  }
}

// ── 1. 注册面：字段与顺序 ────────────────────────────────────────────────
test('I4a：注册面是 context() 的 {name, order, text}，order 是显式数字且大于 120（尾部）', () => {
  const home = freshHome('i4a-fields')
  seed(home, smallLibrary())
  const { contribution, text } = registeredText({ home })
  assert.equal(contribution.name, INJECTION_CONTEXT_NAME)
  assert.equal(INJECTION_CONTEXT_NAME, 'agent-memory')
  assert.equal(contribution.order, INJECTION_CONTEXT_ORDER)
  assert.ok(Number.isFinite(contribution.order), 'order 必须是有限数字（引擎非有限即抛）')
  assert.ok(contribution.order > 120, 'order 必须大于 CONTEXT_ORDERS 里最大的 120（SUBAGENT_DELEGATION）')
  assert.equal(text, SMALL_EXPECT)
})

// ── 2. 内容：一行、无花括号、无换行、与查询无关 ─────────────────────────
test('I4a：注入文本是单行、无 { }、与请求无关（换参数/换缓存实例同字节）', () => {
  const home = freshHome('i4a-oneline')
  seed(home, smallLibrary())
  const { contribution } = registeredText({ home })
  const a = contribution.text({ scope: {}, agent: { id: 'x' } })
  const b = contribution.text({})
  const c = contribution.text({ scope: { isolate: 'y' }, signal: 'z' })
  assert.equal(a, b)
  assert.equal(b, c)
  assert.equal(a, SMALL_EXPECT)
  assert.ok(!a.includes('\n') && !a.includes('\r'), '必须是一行')
  assert.ok(!a.includes('{') && !a.includes('}'), '不得含花括号：引擎 interpolate() 遇到 {{name}} 会抛')
  assert.equal(sanitizeForPrompt('a{{b}}\nc\td\u2028e'), 'abcde')
  assert.equal(sanitizeForPrompt('  多   空格  '), '多 空格')
})

// ── 3. 开关：关掉就不注册、不输出 ────────────────────────────────────────
test('I4a：injection.enabled=false ⇒ 一个 context 都不注册、文本为空串（零字符）', () => {
  const home = freshHome('i4a-off')
  seed(home, smallLibrary())
  const contexts = appliedContexts({ home, injection: { enabled: false } })
  assert.equal(contexts.size, 0, '关掉注入时注册数必须是 0')
  const r = buildInjectionIndex({ home, injection: { enabled: false } })
  assert.equal(r.text, '')
  assert.equal(r.diag.code, 'disabled')
  assert.equal(r.diag.chars, 0)
  assert.equal(r.diag.enabled, false)
})

// ── 4. 工具面不受影响（4 个工具照旧） ────────────────────────────────────
test('I4a：工具面照旧是 4 个（inject 增加 systemPrompt 不改既有工具契约）', () => {
  const home = freshHome('i4a-tools')
  seed(home, smallLibrary())
  const defs = tools({ home })
  assert.deepEqual([...defs.keys()].sort(), ['memory_expand', 'memory_prune', 'memory_recall', 'memory_remember'])
  const { ctx } = makeCtx()
  apply(ctx, { home })
  assert.ok(ctx.systemPrompt !== undefined)
})

// ── 5. 口径解析：默认 / 越界夹取 / 非法回落 ──────────────────────────────
test('I4a：口径解析有默认值、越界夹到天花板、非法类型回落（解析本身不抛）', () => {
  assert.deepEqual(resolveInjectionOptions(undefined), {
    enabled: true, maxChars: DEFAULT_INJECTION_MAX_CHARS, topTags: DEFAULT_INJECTION_TOP_TAGS,
  })
  assert.deepEqual(resolveInjectionOptions(null), {
    enabled: true, maxChars: DEFAULT_INJECTION_MAX_CHARS, topTags: DEFAULT_INJECTION_TOP_TAGS,
  })
  assert.deepEqual(resolveInjectionOptions({ enabled: 'no', maxChars: 100000, topTags: 9999 }), {
    enabled: true, maxChars: 4000, topTags: 64,
  })
  assert.deepEqual(resolveInjectionOptions({ enabled: false, maxChars: -5, topTags: -1 }), {
    enabled: false, maxChars: 0, topTags: 0,
  })
  assert.equal(resolveInjectionOptions({ maxChars: '120' }).maxChars, 120)
})

// ── 6. 空库：不炸、给最小占位、不写「标签锚点」空段 ──────────────────────
test('I4a：空库 ⇒ 注册成功、给最小占位（记忆 0 条），不抛、不注入垃圾', () => {
  const home = freshHome('i4a-empty')
  const { text } = registeredText({ home })
  assert.equal(text, '记忆 0 条（上限 2000）｜细则用 memory_recall')
  assert.ok(text.length <= DEFAULT_INJECTION_MAX_CHARS)
  const r = buildInjectionIndex({ home })
  assert.equal(r.diag.code, 'empty-store')
  assert.equal(r.diag.count, 0)
  assert.deepEqual(r.diag.anchors, [])
  assert.equal(r.diag.truncated, false)
  // 空库也绝不出现「标签锚点：」后面跟空串这种半句
  assert.ok(!text.includes('标签锚点'))
})

// ── 7. 硬上限：2000 条 + 长标签 ⇒ 截断且带省略标记 ────────────────────────
test('I4a：2000 条 + 长标签 ⇒ 注入文本长度 <= maxChars 且带如实省略标记', () => {
  const home = freshHome('i4a-cap')
  seed(home, bigLibrary(2000))
  const maxChars = 240
  const r = buildInjectionIndex({ home, injection: { maxChars, topTags: 64 } })
  assert.ok(r.text.length <= maxChars, `注入长度 ${r.text.length} 必须 <= ${maxChars}`)
  assert.equal(r.diag.truncated, true)
  assert.ok(r.diag.omitted > 0, '必须如实报告省略了几个锚点')
  assert.ok(r.text.includes('已省略'), '必须带省略标记')
  assert.ok(r.text.startsWith('记忆 2000 条'), '条数必须如实')
  assert.ok(r.text.length > 200, '截断后仍应尽量装满预算（不是一句话了事）')
  // 走 apply() 注册的同一条路径，结论一致
  const { text } = registeredText({ home, injection: { maxChars, topTags: 64 } })
  assert.equal(text, r.text)
  assert.ok(text.length <= maxChars)
})

test('I4a：手工改库塞进 300 字符超长标签 ⇒ 仍 <= maxChars（阶梯最后一级硬截断）', () => {
  const home = freshHome('i4a-huge-tag')
  seed(home, [record('mem_huge', T0, { tags: ['h'.repeat(300), '正常标签'] })])
  const r = buildInjectionIndex({ home })
  assert.ok(r.text.length <= DEFAULT_INJECTION_MAX_CHARS, `长度 ${r.text.length} 必须 <= ${DEFAULT_INJECTION_MAX_CHARS}`)
  assert.equal(r.diag.truncated, true)
  assert.equal(r.diag.omitted > 0, true)
})

test('I4a：maxChars 极小/为 0 时也绝不超限（装不下标记就给空串）', () => {
  const anchors = ['aaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccc']
  assert.ok(planInjectionLine(9, 2000, anchors, 8).text.length <= 8)
  assert.ok(planInjectionLine(9, 2000, anchors, 8).text.includes(HARD_MARK))
  assert.equal(planInjectionLine(9, 2000, anchors, HARD_MARK.length).text, '')
  assert.equal(planInjectionLine(9, 2000, anchors, 0).text, '')
  assert.equal(planInjectionLine(9, 2000, [], 0).text, '')
  // 完整行装得下 ⇒ 不标截断
  const okPlan = planInjectionLine(9, 2000, anchors, 999)
  assert.equal(okPlan.truncated, false)
  assert.equal(okPlan.omitted, 0)
})

test('I4a：锚点排序是确定口径（频次降序 → 码元升序），净化后相同的标签合并计数', () => {
  const recs = [
    record('mem_1', T0, { tags: ['b', 'a'] }),
    record('mem_2', T0, { tags: ['a', 'c'] }),
    record('mem_3', T0, { tags: ['c', '{d}'] }),
  ]
  // 频次：a=2 c=2 b=1 d=1（'{d}' 被净化成 'd'）⇒ 先按频次降序，再按码元升序决胜
  assert.deepEqual(stableAnchors(recs, 3), ['a', 'c', 'b'])
  assert.deepEqual(stableAnchors(recs, 10), ['a', 'c', 'b', 'd'])
  assert.deepEqual(stableAnchors(recs, 0), [])
  assert.deepEqual(stableAnchors([], 3), [])
})

// ── 8. 稳定性：库不变 ⇒ 逐字节相同 ───────────────────────────────────────
test('I4a：库不变时连续多次 assemble（多次取文本）逐字节完全相同', async () => {
  const home = freshHome('i4a-stable')
  seed(home, smallLibrary())
  const contexts = appliedContexts({ home })
  const contribution = contexts.get(INJECTION_CONTEXT_NAME)
  const got = []
  for (let i = 0; i < 5; i += 1) {
    got.push(contribution.text({ step: i }))
    await new Promise((r) => setTimeout(r, 1)) // 跨过时间片：文本里若含时间戳/随机数必然变
  }
  assert.equal(new Set(got).size, 1, `5 次取文本必须逐字节相同，实测 ${new Set(got).size} 种`)
  assert.equal(got[0], SMALL_EXPECT)
  // 不同缓存实例（一个都不用）也必须给出同一字节
  const bare = buildInjectionIndex({ home })
  const cached = buildInjectionIndex({ home }, createInjectionCache())
  assert.equal(bare.text, got[0])
  assert.equal(cached.text, got[0])
})

test('I4a：库内容变了（条数/锚点变）⇒ 文本才跟着变（不是冻结在 boot 时刻）', () => {
  const home = freshHome('i4a-change')
  seed(home, smallLibrary())
  assert.equal(buildInjectionIndex({ home }).text, SMALL_EXPECT)
  seed(home, [...smallLibrary(), record('mem_d', T0 + 3 * DAY, { tags: ['失败关闭'] })])
  const after = buildInjectionIndex({ home }).text
  assert.notEqual(after, SMALL_EXPECT)
  assert.ok(after.startsWith('记忆 4 条'))
})

// ── 9. 只读缓存：键 = {path,size,mtimeMs}，同键必同值 ──────────────────────
test('I4a：缓存键严格是 {path,size,mtimeMs}：命中同值、文件改动后失效重读', () => {
  const home = freshHome('i4a-cache')
  seed(home, smallLibrary())
  const cache = createInjectionCache()
  const first = buildInjectionIndex({ home }, cache)
  assert.equal(first.diag.cached, false)
  // 键的形状就是 {path, size, mtimeMs} 三元组（\u0000 连接），没有任何其他维度
  const st = statSync(memFile(home))
  assert.equal(cache.key, `${memFile(home)}\u0000${st.size}\u0000${st.mtimeMs}`)
  assert.equal(cache.count, 3)
  const second = buildInjectionIndex({ home }, cache)
  assert.equal(second.diag.cached, true, '同键必须命中缓存')
  assert.equal(second.text, first.text)
  // 同键同值 + 命中时根本不读文件：把 readFileSync 换成一个会计数的真 fs 包装
  const spy = { reads: 0 }
  const cfg = {
    home,
    fs: injectedFs({
      existsSync: (p) => existsSync(p),
      statSync: (p) => { const s = statSync(p); return { size: s.size, mtimeMs: s.mtimeMs } },
      readFileSync: (p) => { spy.reads += 1; return readFileSync(p, 'utf8') },
    }),
  }
  assert.equal(buildInjectionIndex(cfg, cache).diag.cached, true)
  assert.equal(spy.reads, 0, '命中缓存时不得再读文件')
  // 阴性对照：换个空缓存 ⇒ 同一个 fs 包装必须真的读一次（否则上面的 0 是假绿）
  assert.equal(buildInjectionIndex(cfg, createInjectionCache()).diag.cached, false)
  assert.equal(spy.reads, 1)
  // 库改动 ⇒ 身份三元组变 ⇒ 缓存失效并重读
  seed(home, [...smallLibrary(), record('mem_d', T0 + 3 * DAY, { tags: ['测试'] })])
  const third = buildInjectionIndex({ home }, cache)
  assert.equal(third.diag.cached, false)
  assert.equal(third.diag.count, 4)
  assert.ok(third.text.startsWith('记忆 4 条'))
})

// ── 10. fail-open：读库抛 / 解析坏 / 注册抛，全都不许抛 ────────────────────
test('I4a fail-open：读库抛异常 ⇒ 注入空串、绝不抛（注册也成功）', () => {
  const home = freshHome('i4a-failread')
  seed(home, smallLibrary())
  const throwing = {
    home,
    fs: injectedFs({
      existsSync: () => true,
      statSync: () => ({ size: 1, mtimeMs: 1 }),
      readFileSync: () => { throw new Error('注入的读故障') },
    }),
  }
  let result
  assert.doesNotThrow(() => { result = buildInjectionIndex(throwing, createInjectionCache()) })
  assert.equal(result.text, '', '读失败必须注入空串（不撒谎说 0 条）')
  assert.equal(result.diag.ok, false)
  assert.equal(result.diag.code, 'read-failed')
  assert.ok(result.diag.detail.includes('注入的读故障'), `detail 要能看出原因，实测 ${result.diag.detail}`)
  // 走 apply() 注册的路径也一样：注册成功 + 取文本不抛 + 空串
  const { text, contribution } = registeredText(throwing)
  assert.equal(text, '')
  assert.equal(contribution.name, INJECTION_CONTEXT_NAME)
})

test('I4a fail-open：stat 抛 / exists 抛 / 目录路径 ⇒ 都不抛且仍给出结论', () => {
  const home = freshHome('i4a-failstat')
  seed(home, smallLibrary())
  const badStat = { home, fs: injectedFs({ existsSync: () => true, readFileSync: () => serialize(smallLibrary()), statSync: () => { throw new Error('stat 炸') } }) }
  assert.doesNotThrow(() => buildInjectionIndex(badStat, createInjectionCache()))
  const badExists = { home, fs: injectedFs({ existsSync: () => { throw new Error('exists 炸') } }) }
  let r
  assert.doesNotThrow(() => { r = buildInjectionIndex(badExists, createInjectionCache()) })
  assert.equal(r.text, '')
  assert.equal(r.diag.ok, false)
})

test('I4a fail-open：NDJSON 坏行/空行/非对象行 ⇒ 跳过坏行、不抛、计数只算好行', () => {
  const home = freshHome('i4a-badlines')
  const p = seed(home, smallLibrary())
  writeFileSync(p, `${serialize(smallLibrary())}{坏行不是 JSON\n\n[1,2,3]\nnull\n`, 'utf8')
  const r = buildInjectionIndex({ home })
  assert.equal(r.text, SMALL_EXPECT)
  assert.equal(r.diag.count, 3)
})

test('I4a fail-open：systemPrompt.context 注册时抛 ⇒ apply 不抛、4 个工具照常注册', () => {
  const home = freshHome('i4a-failreg')
  seed(home, smallLibrary())
  const { ctx, defs } = makeCtx()
  ctx.systemPrompt.context = () => { throw new Error('注册面炸了') }
  assert.doesNotThrow(() => apply(ctx, { home }))
  assert.deepEqual([...defs.keys()].sort(), ['memory_expand', 'memory_prune', 'memory_recall', 'memory_remember'])
})

// ── 11. 真引擎 assemble（不可用时如实降级，见测试尾部说明）────────────────
const ENGINE_BASE = '/data/data/com.dsharnessmobile.shell/files/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const ENGINE_SP = `${ENGINE_BASE}/dsh-system-prompt/lib/index.js`
const ENGINE_CORDIS = `${ENGINE_BASE}/cordis/lib/index.js`

test('I4a：真引擎 SystemPrompt.context 注册 + assemble：落在 contexts 里、快照含本行、5 次逐字节相同', async () => {
  if (!existsSync(ENGINE_SP) || !existsSync(ENGINE_CORDIS)) {
    // 换环境时如实降级：本机（引擎在）走真路径，别处至少验证桩路径的形状
    const home = freshHome('i4a-engine-absent')
    seed(home, smallLibrary())
    const { text } = registeredText({ home })
    assert.equal(text, SMALL_EXPECT)
    return
  }
  const { Context } = await import(ENGINE_CORDIS)
  const sp = await import(ENGINE_SP)
  const home = freshHome('i4a-engine')
  seed(home, smallLibrary())

  const rootCtx = new Context()
  const root = rootCtx.plugin(sp.default)
  await new Promise((r) => setTimeout(r, 20))
  const service = rootCtx.get('systemPrompt')
  assert.ok(service, '真引擎必须提供 systemPrompt 服务')

  const defs = new Map()
  apply({
    tools: { register: (d) => { defs.set(d.name, d); return { dispose: () => defs.delete(d.name) } } },
    effect: (cb) => cb(),
    systemPrompt: service,
  }, { home })
  assert.equal(defs.size, 4)

  const snapshots = []
  for (let i = 0; i < 5; i += 1) {
    const assembly = await service.assemble({})
    const mine = assembly.contexts.filter((c) => c.name === INJECTION_CONTEXT_NAME)
    assert.equal(mine.length, 1, '我们的 context 必须恰好贡献一次')
    assert.equal(mine[0].text, SMALL_EXPECT)
    snapshots.push(sp.renderContextSnapshot(assembly))
    await new Promise((r) => setTimeout(r, 1))
  }
  assert.equal(new Set(snapshots).size, 1, '库不变时快照必须逐字节相同')
  assert.ok(snapshots[0].includes(SMALL_EXPECT), '快照里必须含我们那一行')
  assert.ok(snapshots[0].startsWith('Current runtime context.'), '快照头是引擎统一加的（我们不拥有它）')
  await root.dispose?.()
})

test('I4a：库的硬上限（maxRecords）与注入行里的「上限」一致（不各说各话）', () => {
  const home = freshHome('i4a-limit')
  seed(home, smallLibrary())
  const r = buildInjectionIndex({ home, maxRecords: 7 })
  assert.equal(resolveMaxRecords({ home, maxRecords: 7 }), 7)
  assert.ok(r.text.includes('（上限 7）'), `注入行必须回显实际上限，实测 ${r.text}`)
})
