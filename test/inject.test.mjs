// 用例 10：I4a / I4a.3 记忆注入（systemPrompt 尾部动态块 + 稳定段）。
//
// 契约（与任务规格一一对应，全部可判红）：
//  1) 注册面：name 固定、order 是**显式数字且大于 120**、text 是函数（引擎每次 assemble 现算）；
//  2) 开关：injection.enabled=false ⇒ **不注册**（contexts 里没有）且不输出任何字符；
//  3) 内容：**一行**、与查询无关、低频变化（条数 + 这是什么 + 什么时候该用 + 锚点），
//     不含 `{` `}`（引擎插值会抛）；
//  4) 硬上限：任何输入下注入文本长度 <= maxChars，超限必须带如实省略标记；
//  5) 稳定性：库不变 ⇒ 逐字节相同（含不同 assemble 参数、不同缓存实例）；库变了才变；
//  6) fail-open：读库/解析/注册任何异常都**不抛**，注入空串或最小占位；
//  7) 缓存：只读、幂等，键严格是 {path, size, mtimeMs}（与库自身的外部改动守卫同口径）。
//
// I4a.1：注入面从「必需依赖」改为条件注册 `ctx.inject(['systemPrompt'], scope => ...)`。
// 本文件覆盖「有 systemPrompt」这一半（注册面/内容/上限/稳定性/fail-open）；「缺 systemPrompt 时
// 工具面仍可用」的红绿证在 test/loose-inject.test.mjs（用裸 cordis 才能判出必需依赖的 PENDING 门禁）。
//
// I4a.3（本次改动，见第 12 节）：
//  8) 尾部那行的**语法**从陈述句改成**条件规则**：必须含触发条件（这类问题 ⇒ 先 memory_recall 查库），
//     而不是「库里有这么个东西」的陈述；「上限 M」这类无关信息不得回堆；
//  9) 同一条规则**另注册为稳定段**（`section`，不是 `context`）：name=agent-memory-habit、
//     order 是**显式数字**（getSectionOrder 对外部名字返回 undefined，不能照抄 persona 的写法）、
//     段文本极短且含触发条件；
// 10) **两条贡献共用同一个 enabled 开关**：关掉时尾部块与稳定段都不注册（不许半开）；
// 11) 两条贡献各自 fail-open：任一侧注册抛都只意味着「少一块」，另一侧与 4 个工具照常。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { apply } from '../lib/index.js'
import * as pluginModule from '../lib/index.js'
import {
  ANCHOR_MAX_DF_RATIO, DEFAULT_INJECTION_MAX_CHARS, DEFAULT_INJECTION_TOP_TAGS, HARD_MARK,
  INJECTION_CONTEXT_NAME, INJECTION_CONTEXT_ORDER, INJECTION_HABIT_TEXT, INJECTION_SECTION_NAME,
  INJECTION_SECTION_ORDER,
  buildInjectionIndex, createInjectionCache, planInjectionLine, resolveInjectionOptions,
  sanitizeForPrompt, stableAnchors,
} from '../lib/inject.js'
import { resolveMaxRecords, serialize } from '../lib/store.js'
import { appliedContexts, appliedSections, freshHome, makeCtx, memFile, record, tools } from './helpers.mjs'

const DAY = 86_400_000
const T0 = 1_700_000_000_000

/** 直接写盘造库（绕过写入协议的既有契约，只用于造「库里有 N 条」的形状）。 */
function seed(home, records) {
  const p = memFile(home)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, serialize(records), 'utf8')
  return p
}

/**
 * 7 条固定记忆。锚点口径（I4a.2 起先做出现率资格过滤，总记录数 7）：
 *   失败关闭 2/7 ≈ 0.2857（≤ 0.3，合格）；render / 协议 / 测试 / 填充1..4 各 1/7（合格）
 *   ⇒ 合格集合排序 = 失败关闭(2) → render(1，ASCII 码元最小) → 协议(1) → 填充1..4 → 测试
 *   ⇒ 锚点 = 失败关闭 / render / 协议。
 * 【I4a.2 契约变更】原来只有 3 条记录，任何标签的出现率都 ≥ 1/3 > 0.3，默认口径下会**全部被过滤**，
 * 那一行会退化成「无可区分锚点」——本文件要测的是「带锚点的完整行」，所以夹具扩到 7 条
 * （每个新增记录的标签唯一 ⇒ 不抢前三名）。降级口径本身由 test/anchor.test.mjs 覆盖。
 */
function smallLibrary() {
  return [
    record('mem_a', T0, { tags: ['失败关闭', 'render'] }),
    record('mem_b', T0 + DAY, { tags: ['失败关闭', '协议'] }),
    record('mem_c', T0 + 2 * DAY, { tags: ['测试'] }),
    record('mem_f1', T0 + 3 * DAY, { tags: ['填充1'] }),
    record('mem_f2', T0 + 4 * DAY, { tags: ['填充2'] }),
    record('mem_f3', T0 + 5 * DAY, { tags: ['填充3'] }),
    record('mem_f4', T0 + 6 * DAY, { tags: ['填充4'] }),
  ]
}

/**
 * 【I4a.3 文案契约】尾部那行（逐字固定夹具）。
 * 结构 = 条数 + 这是什么（跨会话经验教训）+ **条件规则**（这种情况 ⇒ 先 memory_recall 查库）+ 锚点。
 * 与改动前的旧句 `记忆 7 条（上限 2000）｜标签锚点：…｜细则用 memory_recall` 相比：
 * 去掉了「上限」与陈述式的「细则用…」，换成了带触发条件的行动规则。
 */
const SMALL_EXPECT = '记忆 7 条（跨会话经验教训）｜排查·为什么·复现·以前是否踩过 这类问题，先 memory_recall 查库｜标签锚点：失败关闭 / render / 协议'

/** 取 section 贡献的文本（注册时是字符串；若将来改成函数形式也照样取得到）。 */
function sectionText(contribution) {
  return typeof contribution.text === 'function' ? contribution.text({}) : contribution.text
}

/**
 * 2000 条 + 每条 12 个 ~27 字符长标签 ⇒ 默认预算下就超限（用 topTags=64 让超限更明确）。
 * 【I4a.2】标签按记录索引取唯一名（df = 1/2000 ⇒ 全部合格）：否则 12 个标签在每条记录上
 * 都出现（出现率 100%）会被资格过滤全部剔除，超限阶梯就永远走不到了。
 */
function bigLibrary(n) {
  const out = []
  for (let i = 0; i < n; i += 1) {
    const tags = []
    for (let k = 0; k < 12; k += 1) {
      tags.push(`长标签${String(i).padStart(4, '0')}-${String(k).padStart(2, '0')}-${'z'.repeat(16)}`)
    }
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
test('I4a.1：工具面照旧 4 个；注入面是条件注册，不再进 inject 必需依赖', () => {
  const home = freshHome('i4a-tools')
  seed(home, smallLibrary())
  const defs = tools({ home })
  assert.deepEqual([...defs.keys()].sort(), ['memory_expand', 'memory_prune', 'memory_recall', 'memory_remember'])
  const { ctx, contexts } = makeCtx()
  apply(ctx, { home })
  assert.ok(ctx.systemPrompt !== undefined, '桩里 systemPrompt 在（有它时注入应注册）')
  assert.equal(contexts.size, 1, '有 systemPrompt ⇒ 注入照旧注册')
  assert.ok(contexts.has(INJECTION_CONTEXT_NAME))
})

// ── 5. 口径解析：默认 / 越界夹取 / 非法回落 ──────────────────────────────
test('I4a：口径解析有默认值、越界夹到天花板、非法类型回落（解析本身不抛）', () => {
  assert.deepEqual(resolveInjectionOptions(undefined), {
    enabled: true, maxChars: DEFAULT_INJECTION_MAX_CHARS, topTags: DEFAULT_INJECTION_TOP_TAGS,
    anchorMaxDfRatio: ANCHOR_MAX_DF_RATIO,
  })
  assert.deepEqual(resolveInjectionOptions(null), {
    enabled: true, maxChars: DEFAULT_INJECTION_MAX_CHARS, topTags: DEFAULT_INJECTION_TOP_TAGS,
    anchorMaxDfRatio: ANCHOR_MAX_DF_RATIO,
  })
  assert.deepEqual(resolveInjectionOptions({ enabled: 'no', maxChars: 100000, topTags: 9999 }), {
    enabled: true, maxChars: 4000, topTags: 64, anchorMaxDfRatio: ANCHOR_MAX_DF_RATIO,
  })
  assert.deepEqual(resolveInjectionOptions({ enabled: false, maxChars: -5, topTags: -1 }), {
    enabled: false, maxChars: 0, topTags: 0, anchorMaxDfRatio: ANCHOR_MAX_DF_RATIO,
  })
  assert.equal(resolveInjectionOptions({ maxChars: '120' }).maxChars, 120)
  // I4a.2：锚点资格过滤上限也在同一解析面里（越界夹到 0..1，非有限值回落默认）
  assert.equal(ANCHOR_MAX_DF_RATIO, 0.3)
  assert.equal(resolveInjectionOptions({ anchorMaxDfRatio: 9 }).anchorMaxDfRatio, 1)
  assert.equal(resolveInjectionOptions({ anchorMaxDfRatio: Number.NaN }).anchorMaxDfRatio, ANCHOR_MAX_DF_RATIO)
})

// ── 6. 空库：不炸、给最小占位、不写「标签锚点」空段 ──────────────────────
test('I4a：空库 ⇒ 注册成功、给最小占位（记忆 0 条），不抛、不注入垃圾', () => {
  const home = freshHome('i4a-empty')
  const { text } = registeredText({ home })
  assert.equal(text, '记忆 0 条（跨会话经验教训）｜排查·为什么·复现·以前是否踩过 这类问题，先 memory_recall 查库')
  assert.ok(text.length <= DEFAULT_INJECTION_MAX_CHARS)
  const r = buildInjectionIndex({ home })
  assert.equal(r.diag.code, 'empty-store')
  assert.equal(r.diag.count, 0)
  assert.deepEqual(r.diag.anchors, [])
  assert.equal(r.diag.truncated, false)
  // 空库也绝不出现「标签锚点：」后面跟空串这种半句
  assert.ok(!text.includes('标签锚点'))
  // I4a.3：**条件规则段不受「没有锚点」影响** —— 规则是承重墙，绝不能因为压预算/无锚点就消失
  assert.ok(text.includes('先 memory_recall 查库'), '空库那行同样必须带触发条件')
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
  // 【I4a.2】1 条记录时任何标签的出现率都是 100% ⇒ 会被资格过滤掉，超长标签根本进不了锚点。
  // 这里补 9 条标签唯一的记录（超长标签出现率 1/10 = 0.1 ⇒ 合格，且 ASCII 码元最小 ⇒ 排第一），
  // 本用例要测的仍是「超长锚点撑爆预算时的截断阶梯」。
  const fillers = []
  for (let i = 0; i < 9; i += 1) fillers.push(record(`mem_fill_${i}`, T0 + (i + 1) * DAY, { tags: [`填充${i}`] }))
  seed(home, [record('mem_huge', T0, { tags: ['h'.repeat(300), '正常标签'] }), ...fillers])
  const r = buildInjectionIndex({ home })
  assert.equal(r.diag.distinctTags, 11)
  assert.equal(r.diag.qualifiedTags, 11)
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
  // 频次：a=2 c=2 b=1 d=1（'{d}' 被净化成 'd'）⇒ 先按频次降序，再按码元升序决胜。
  // 【I4a.2 契约变更】stableAnchors 增加第三参数 maxDfRatio（默认 0.3 资格过滤）：本用例的
  // 三条记录里每个标签的出现率都 ≥ 1/3 > 0.3，默认口径下会全被过滤掉，无法再验证「纯排序」。
  // 所以这里**显式传 1**（= 关掉过滤）来保留本用例原本的语义；过滤语义由 test/anchor.test.mjs 覆盖。
  assert.deepEqual(stableAnchors(recs, 3, 1), ['a', 'c', 'b'])
  assert.deepEqual(stableAnchors(recs, 10, 1), ['a', 'c', 'b', 'd'])
  assert.deepEqual(stableAnchors(recs, 0, 1), [])
  assert.deepEqual(stableAnchors([], 3, 1), [])
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
  assert.ok(after.startsWith('记忆 8 条'))
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
  assert.equal(cache.count, 7)
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
  assert.equal(third.diag.count, 8)
  assert.ok(third.text.startsWith('记忆 8 条'))
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
  assert.equal(r.diag.count, 7)
})

test('I4a fail-open：systemPrompt.context 注册时抛 ⇒ apply 不抛、4 个工具照常注册', () => {
  const home = freshHome('i4a-failreg')
  seed(home, smallLibrary())
  const { ctx, defs } = makeCtx()
  ctx.systemPrompt.context = () => { throw new Error('注册面炸了') }
  assert.doesNotThrow(() => apply(ctx, { home }))
  assert.deepEqual([...defs.keys()].sort(), ['memory_expand', 'memory_prune', 'memory_recall', 'memory_remember'])
})

test('I4a.1 fail-open：宿主连 ctx.inject 都没有 ⇒ 不抛、4 个工具照常注册（只有注入面缺席）', () => {
  const home = freshHome('i4a-noinject')
  seed(home, smallLibrary())
  const { ctx, defs } = makeCtx()
  delete ctx.inject
  delete ctx.systemPrompt
  assert.doesNotThrow(() => apply(ctx, { home }))
  assert.deepEqual([...defs.keys()].sort(), ['memory_expand', 'memory_prune', 'memory_recall', 'memory_remember'])
})

// ── 11. 真引擎 assemble（不可用时如实降级，见测试尾部说明）────────────────
const ENGINE_BASE = '/data/data/com.dsharnessmobile.shell/files/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const ENGINE_SP = `${ENGINE_BASE}/dsh-system-prompt/lib/index.js`
const ENGINE_CORDIS = `${ENGINE_BASE}/cordis/lib/index.js`

test('I4a / I4a.3：真引擎注册 + assemble：context 落在 contexts、段落在 sections、5 次逐字节相同', async () => {
  if (!existsSync(ENGINE_SP) || !existsSync(ENGINE_CORDIS)) {
    // 换环境时如实降级：本机（引擎在）走真路径，别处至少验证桩路径的形状
    const home = freshHome('i4a-engine-absent')
    seed(home, smallLibrary())
    const { text } = registeredText({ home })
    assert.equal(text, SMALL_EXPECT)
    assert.equal(sectionText(appliedSections({ home }).get(INJECTION_SECTION_NAME)), INJECTION_HABIT_TEXT)
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

  // I4a.1：注入面改走 ctx.inject(['systemPrompt']) ⇒ 必须真 cordis 才能跑通（旧的裸对象桩没有 inject，
  // 插件会 fail-open 地跳过注入注册）。所以这里补一个 tools 服务，然后把**插件模块本身**按官方方式加载。
  const defs = new Map()
  rootCtx.plugin({
    name: 'i4a-engine-tools',
    apply: (c) => {
      c.provide('tools', { register: (d) => { defs.set(d.name, d); return { dispose: () => defs.delete(d.name) } } })
    },
  })
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(rootCtx.get('tools'), 'tools 服务必须先就位')
  const fiber = rootCtx.plugin(pluginModule, { home })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(fiber.state, 2, '真 cordis 下插件 fiber 必须是 ACTIVE（2）')
  assert.equal(defs.size, 4)
  assert.deepEqual([...pluginModule.inject], ['tools'])

  const snapshots = []
  const promptTails = []
  for (let i = 0; i < 5; i += 1) {
    const assembly = await service.assemble({})
    const mine = assembly.contexts.filter((c) => c.name === INJECTION_CONTEXT_NAME)
    assert.equal(mine.length, 1, '我们的 context 必须恰好贡献一次')
    assert.equal(mine[0].text, SMALL_EXPECT)
    // I4a.3：真引擎的 sections 里必须有稳定段，且文本含触发条件
    const mySections = assembly.sections.filter((s) => s.name === INJECTION_SECTION_NAME)
    assert.equal(mySections.length, 1, `真引擎 sections 里必须恰好有一条 ${INJECTION_SECTION_NAME}`)
    assert.equal(mySections[0].text, INJECTION_HABIT_TEXT, '段文本必须逐字就是那条规则')
    assert.ok(mySections[0].text.includes('先用 memory_recall 查记忆库'), `段必须含触发条件，实测 ${mySections[0].text}`)
    snapshots.push(sp.renderContextSnapshot(assembly))
    // 段进的是 prompt 正文：用真引擎自己的 joinContextSections 之外的渲染面（renderPrompt）复核它确实在正文里
    promptTails.push(sp.renderPrompt(assembly).includes(INJECTION_HABIT_TEXT))
    await new Promise((r) => setTimeout(r, 1))
  }
  assert.equal(new Set(snapshots).size, 1, '库不变时快照必须逐字节相同')
  assert.ok(snapshots[0].includes(SMALL_EXPECT), '快照里必须含我们那一行')
  assert.ok(snapshots[0].startsWith('Current runtime context.'), '快照头是引擎统一加的（我们不拥有它）')
  assert.deepEqual([...new Set(promptTails)], [true], '稳定段必须出现在真引擎渲染出的 prompt 正文里')
  await root.dispose?.()
})

// ── 12. I4a.3：条件规则（尾部块）+ 稳定段（section）───────────────────────
//
// 背景：真机观察到旧那行是**陈述句**（「库里有 200 条…细则用 memory_recall」），不触发行为——
// 上线以来模型一次都不是被它提醒去召回的。所以本次把它改成**条件规则**（这种情况 ⇒ 做这个），
// 并把同一条规则另注册成**稳定段**（规则属于稳定前缀，索引属于易变尾部，两者用不同机制承载）。

test('I4a.3 条件规则：尾部那行含明确的触发条件与行动（不是「有这个东西」的陈述）', () => {
  const home = freshHome('i4a3-rule')
  seed(home, smallLibrary())
  const { text } = registeredText({ home })

  // 【红证 1】先断言**含行动规则**（触发条件 ⇒ 动作）——这是本次改动的要害，
  // 放在最前面：改回旧的陈述句（`…｜细则用 memory_recall`）时，**这一条自己就是红的**
  // （不会像「整行逐字相等」那样先兜住失败，让人误以为要害断言没被测到）。
  assert.ok(text.includes('先 memory_recall 查库'), `必须含行动规则「触发条件 ⇒ 动作」，实测 ${text}`)
  assert.ok(text.includes('这类问题'), '必须含触发条件的类别限定（什么时候该用）')
  assert.ok(text.includes('（跨会话经验教训）'), '必须说明这是什么')
  // 再逐字断言整行
  assert.equal(text, SMALL_EXPECT)

  // 结构顺序固定：条数 → 这是什么 → 什么时候该用 → 锚点（顺序即语义）
  const iCount = text.indexOf('记忆 7 条')
  const iWhat = text.indexOf('（跨会话经验教训）')
  const iRule = text.indexOf('这类问题，先 memory_recall 查库')
  const iAnchor = text.indexOf('标签锚点')
  assert.ok(
    iCount === 0 && iWhat > iCount && iRule > iWhat && iAnchor > iRule,
    `四段顺序必须是 条数→这是什么→什么时候该用→锚点，实测 ${text}`,
  )

  // 「上限 M」这类与「这是什么 / 什么时候该用」无关的容量参数不得回堆
  assert.ok(!text.includes('上限'), `注入行不得再回显上限，实测 ${text}`)
  assert.ok(text.length <= DEFAULT_INJECTION_MAX_CHARS, `长度 ${text.length} 必须 <= ${DEFAULT_INJECTION_MAX_CHARS}`)
})

test('I4a.3 条件规则：压缩阶梯只丢锚点、绝不丢条件规则（预算再紧也保得住触发条件）', () => {
  const anchors = ['aaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccc']
  // 从紧到松扫一遍：只要那行非空，就**必须**含条件规则（除非已退化到硬截断标记）
  for (const maxChars of [30, 40, 50, 56, 57, 60, 80, 120, 240]) {
    const t = planInjectionLine(9, 2000, anchors, maxChars).text
    if (t === '' || t.endsWith(HARD_MARK)) continue
    assert.ok(t.includes('先 memory_recall 查库'), `maxChars=${maxChars} 时那行丢了触发条件：${JSON.stringify(t)}`)
  }
  // 最小行（无锚点）就是「条数 + 这是什么 + 条件规则」，这一点逐字固定。
  // 该行 56 字符、三个 20 字符锚点的完整行 128 字符 ⇒ 预算 60 时锚点全丢、最小行仍在。
  const tight = planInjectionLine(9, 2000, anchors, 60)
  assert.equal(tight.text.includes('标签锚点'), false, `预算 60 装不下锚点 ⇒ 退到不含锚点的最小行，实测 ${tight.text}`)
  assert.equal(tight.text, '记忆 9 条（跨会话经验教训）｜排查·为什么·复现·以前是否踩过 这类问题，先 memory_recall 查库')
  assert.equal(tight.truncated, true, '丢了锚点就必须如实标为截断')
  assert.ok(tight.text.includes('先 memory_recall 查库'), '最小行里条件规则必须还在')
})

test('I4a.3 稳定段：注册 agent-memory-habit（section），含触发条件，order 是显式数字且落在空档', () => {
  const home = freshHome('i4a3-section')
  seed(home, smallLibrary())
  const sections = appliedSections({ home })

  // 【红证 2】去掉 index.ts 里的 section 注册 ⇒ 这条必红。
  const contribution = sections.get(INJECTION_SECTION_NAME)
  assert.ok(contribution, `必须注册名为 ${INJECTION_SECTION_NAME} 的 section 贡献`)
  assert.equal(INJECTION_SECTION_NAME, 'agent-memory-habit')
  const text = sectionText(contribution)
  assert.equal(text, INJECTION_HABIT_TEXT, '段文本必须就是那一条逐字固定的规则')
  assert.ok(text.includes('先用 memory_recall 查记忆库'), `段文本必须含触发条件 + 行动，实测 ${text}`)
  assert.ok(text.includes('这类问题'), '段文本必须含触发条件的类别限定')
  assert.ok(!text.includes('\n') && !text.includes('\r'), '段文本必须是一行')
  assert.ok(!text.includes('{') && !text.includes('}'), '不得含花括号：引擎 interpolate() 遇到 {{name}} 会抛')
  assert.equal(sanitizeForPrompt(text), text, '段文本本来就不该含需要净化的字符（净化对它应为恒等）')

  // order：**必须自己传显式数字**（getSectionOrder 对外部名字返回 undefined）。
  assert.equal(INJECTION_SECTION_ORDER, 3200)
  assert.equal(contribution.order, INJECTION_SECTION_ORDER)
  assert.ok(Number.isFinite(contribution.order), 'order 必须是有限数字（引擎非有限即抛 TypeError）')
  assert.ok(contribution.order > 3100, '必须排在 MCP_SERVERS(3100) 之后（工具说明带的末尾）')
  assert.ok(contribution.order < 5000, '必须排在 TOOLS_SDK(5000) 之前（落在引擎空档里，不挤占既有槽位）')

  // section 与 context 是两张不同的注册表、两条不同贡献（规则 vs 索引，别混）
  const contexts = appliedContexts({ home })
  assert.equal(sections.size, 1, 'section 只注册本插件这一条')
  assert.equal(contexts.size, 1, 'context 只注册本插件那一条')
  assert.ok(!contexts.has(INJECTION_SECTION_NAME), '稳定段不得跑进 contexts 表')
  assert.ok(!sections.has(INJECTION_CONTEXT_NAME), '尾部块不得跑进 sections 表')
})

test('I4a.3 稳定段是常量：与库内容无关（库变了段逐字节不变，尾部行才跟着变）', () => {
  const home = freshHome('i4a3-section-const')
  seed(home, smallLibrary())
  const before = sectionText(appliedSections({ home }).get(INJECTION_SECTION_NAME))
  const lineBefore = buildInjectionIndex({ home }).text
  seed(home, [...smallLibrary(), record('mem_d', T0 + 3 * DAY, { tags: ['失败关闭'] })])
  const after = sectionText(appliedSections({ home }).get(INJECTION_SECTION_NAME))
  const lineAfter = buildInjectionIndex({ home }).text
  assert.equal(after, before, '规则属于稳定前缀：库怎么变都不该动它')
  assert.notEqual(lineAfter, lineBefore, '索引属于易变尾部：库变了就该跟着变（阴性对照，证明上面那条不是假绿）')
})

test('I4a.3 开关：enabled=false ⇒ 尾部块与稳定段**都不注册**（共用同一个开关，不许半开）', () => {
  const home = freshHome('i4a3-off')
  seed(home, smallLibrary())
  const cfg = { home, injection: { enabled: false } }
  // 【红证 3】把 section 注册挪到 enabled 判断之外 ⇒ 第二条断言变红。
  assert.equal(appliedContexts(cfg).size, 0, '关掉时尾部块不得注册')
  assert.equal(appliedSections(cfg).size, 0, '关掉时稳定段同样不得注册')
  // 阴性对照：同一条桩、同一个库，开关打开时两条都必须在（否则上面的 0 是假绿）
  const on = { home }
  assert.equal(appliedContexts(on).size, 1)
  assert.equal(appliedSections(on).size, 1)
})

test('I4a.3 fail-open：section 注册抛 ⇒ apply 不抛，尾部块与 4 个工具照常', () => {
  const home = freshHome('i4a3-failsec')
  seed(home, smallLibrary())
  const { ctx, defs, contexts, sections } = makeCtx()
  ctx.systemPrompt.section = () => { throw new Error('段注册面炸了') }
  assert.doesNotThrow(() => apply(ctx, { home }))
  assert.deepEqual([...defs.keys()].sort(), ['memory_expand', 'memory_prune', 'memory_recall', 'memory_remember'])
  assert.equal(sections.size, 0, '段没注册上就是没有')
  assert.equal(contexts.size, 1, '段注册失败不得把同一回调里的尾部块一起拖下水')
  assert.equal(contexts.get(INJECTION_CONTEXT_NAME).text(), SMALL_EXPECT)
})

test('I4a.3 fail-open：宿主连 section 面都没有（旧宿主桩）⇒ 不抛、尾部块照常注册', () => {
  const home = freshHome('i4a3-nosection')
  seed(home, smallLibrary())
  const { ctx, contexts } = makeCtx()
  delete ctx.systemPrompt.section
  assert.doesNotThrow(() => apply(ctx, { home }))
  assert.equal(contexts.get(INJECTION_CONTEXT_NAME).text(), SMALL_EXPECT)
})

test('I4a.3：库的硬上限（maxRecords）不再进注入行，且换上限不改变那一行', () => {
  const home = freshHome('i4a-limit')
  seed(home, smallLibrary())
  const r = buildInjectionIndex({ home, maxRecords: 7 })
  assert.equal(resolveMaxRecords({ home, maxRecords: 7 }), 7, '容量口径本身照旧可解析')
  assert.equal(r.text, SMALL_EXPECT)
  assert.ok(!r.text.includes('上限'), `注入行不得回显上限（那是库的容量参数，不属于「这是什么/什么时候该用」），实测 ${r.text}`)
  // 旧实现里这行会跟着 maxRecords 变 ⇒ 这条断言在旧实现上是红的（契约变更的留痕）
  assert.equal(buildInjectionIndex({ home, maxRecords: 1234 }).text, r.text, '上限不参与那一行的内容')
})
