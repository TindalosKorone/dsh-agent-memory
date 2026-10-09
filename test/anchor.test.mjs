// 用例 14：I4a.2 注入锚点的**区分力资格过滤**（本增量新增，专测锚点选择与降级）。
//
// 背景（真机现象）：导入 185 条坑位语料后，注入那行的锚点从 `失败关闭 / 假绿 / 区分力`
// 退化成 `坑位 / 判据 / 快照` —— `坑位` 覆盖率 182/194 ≈ 94%，区分不了任何两条记忆，
// 等于往每一步的上下文里塞噪音。根因：原规则「按全局词频取 top-N」把「最高频」当成了「最有区分力」。
//
// 契约（全部可判红）：
//  1) 资格过滤：出现率（含该标签的记录数 / 总记录数）**严格大于** maxDfRatio 的标签不得成为锚点；
//     df 口径是「记录数」：一条记录内重复写同一个标签只计一次；
//  2) 合格集合内排序确定：df 降序 → 标签码元升序决胜（与记录书写顺序、Map 迭代顺序无关）；
//  3) 合格锚点不足 N 个 ⇒ 如实少给（不补位、**绝不回落到全库最高频标签**）；
//  4) 一个合格锚点都没有（但库里有标签）⇒ 那行写「无可区分锚点」；库内根本没有标签则不写这一段；
//  5) 那行整体仍 ≤ maxChars；库不变（含命中缓存）时逐字节稳定。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  ANCHOR_MAX_DF_RATIO, ANCHOR_NONE_MARK, DEFAULT_INJECTION_MAX_CHARS, HARD_MARK,
  INJECTION_CONTEXT_NAME, buildInjectionIndex, createInjectionCache, planAnchors,
  planInjectionLine, resolveInjectionOptions, stableAnchors,
} from '../lib/inject.js'
import { serialize } from '../lib/store.js'
import { appliedContexts, freshHome, memFile, record } from './helpers.mjs'

const DAY = 86_400_000
const T0 = 1_700_000_000_000

/** 直接写盘造库（与 inject.test.mjs 同风格，只造形状）。 */
function seed(home, records) {
  const p = memFile(home)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, serialize(records), 'utf8')
  return p
}

/**
 * 覆盖全库形状的夹具：120 条记录，`坑位` 覆盖 115/120 ≈ 0.9583（> 0.3，必须被剔除），
 * 合格集合 = 判据 12 / 快照 11 / 测试 10 / 构建 9（都 ≤ 120×0.3 = 36）⇒ top-3 = 判据/快照/测试。
 */
function coverAllLibrary(total = 120, cover = 115) {
  const out = []
  for (let i = 0; i < total; i += 1) {
    const tags = []
    if (i < cover) tags.push('坑位')
    if (i < 12) tags.push('判据')
    if (i < 11) tags.push('快照')
    if (i < 10) tags.push('测试')
    if (i < 9) tags.push('构建')
    out.push(record(`mem_cov_${String(i).padStart(3, '0')}`, T0 + i * DAY, { tags }))
  }
  return out
}

const COVER_ALL_LINE = '记忆 120 条（上限 2000）｜标签锚点：判据 / 快照 / 测试｜细则用 memory_recall'

// ── 1. 资格过滤：覆盖全库的标签不得成为锚点 ─────────────────────────────
test('I4a.2 资格过滤：覆盖率 95.8% 的标签被剔除，合格集合里 df 最高的三个才是锚点', () => {
  const home = freshHome('i4a2-filter')
  const recs = coverAllLibrary()
  seed(home, recs)

  const plan = planAnchors(recs, 3, ANCHOR_MAX_DF_RATIO)
  assert.deepEqual(plan.anchors, ['判据', '快照', '测试'], '必须是合格集合里 df 最高的三个')
  assert.ok(!plan.anchors.includes('坑位'), '覆盖 115/120 的标签绝不能成为锚点')
  assert.equal(plan.distinctTags, 5)
  assert.equal(plan.qualifiedTags, 4)
  assert.equal(ANCHOR_MAX_DF_RATIO, 0.3)
  assert.deepEqual(stableAnchors(recs, 3), ['判据', '快照', '测试'], 'stableAnchors 默认口径必须就是过滤口径')

  const r = buildInjectionIndex({ home })
  assert.equal(r.text, COVER_ALL_LINE)
  assert.ok(!r.text.includes('坑位'), `注入行不得出现覆盖全库的标签，实测 ${r.text}`)
  assert.deepEqual(r.diag.anchors, ['判据', '快照', '测试'])
  assert.equal(r.diag.anchorMaxDfRatio, 0.3)
  assert.equal(r.diag.qualifiedTags, 4)
  assert.ok(r.text.length <= DEFAULT_INJECTION_MAX_CHARS)
})

test('I4a.2 红证形态（双侧钉死）：同一份库把 maxDfRatio 放到 1（=关掉过滤）⇒ 最高频标签立刻被选中', () => {
  const recs = coverAllLibrary()
  // 这一侧就是「去掉资格过滤」的判据：过滤一旦失效，默认口径会返回与 ratio=1 相同的结果，
  // 上面那条 `!plan.anchors.includes('坑位')` 随即变红。
  assert.deepEqual(planAnchors(recs, 3, 1).anchors, ['坑位', '判据', '快照'])
  assert.equal(stableAnchors(recs, 3, 1)[0], '坑位')
  assert.notDeepEqual(stableAnchors(recs, 3), stableAnchors(recs, 3, 1))
})

test('I4a.2 边界：出现率恰好等于上限的标签**保留**（剔除条件是严格大于）', () => {
  // 10 条记录、`边界` 恰好 3 条 = 0.3，不 > 0.3 ⇒ 合格；`超界` 4 条 = 0.4 ⇒ 剔除。
  const recs = []
  for (let i = 0; i < 10; i += 1) {
    const tags = []
    if (i < 3) tags.push('边界')
    if (i < 4) tags.push('超界')
    recs.push(record(`mem_edge_${i}`, T0 + i * DAY, { tags }))
  }
  assert.deepEqual(stableAnchors(recs, 5), ['边界'])
  assert.deepEqual(planAnchors(recs, 5, 0.4).anchors, ['超界', '边界'])
})

test('I4a.2 df 口径是「记录数」：一条记录内重复写同一标签只计一次', () => {
  const recs = []
  for (let i = 0; i < 5; i += 1) {
    recs.push(record(`mem_dup_${i}`, T0 + i * DAY, { tags: i === 0 ? ['重复', '重复', '重复'] : [] }))
  }
  // 记录数口径：df=1/5 = 0.2 ≤ 0.3 ⇒ 合格；若按「词次」算会是 3/5 = 0.6 ⇒ 被误剔除。
  assert.deepEqual(stableAnchors(recs, 3), ['重复'])
  assert.equal(planAnchors(recs, 3).distinctTags, 1)
  assert.equal(planAnchors(recs, 3).qualifiedTags, 1)
})

// ── 2. 合格锚点不足 / 一个都没有 ⇒ 如实降级 ──────────────────────────────
test('I4a.2 合格锚点不足 N 个 ⇒ 如实少给，绝不补位、绝不回落到超频标签', () => {
  const home = freshHome('i4a2-fewer')
  const recs = []
  for (let i = 0; i < 20; i += 1) {
    const tags = []
    if (i < 18) tags.push('宽标签')
    if (i < 3) tags.push('窄甲')
    if (i < 2) tags.push('窄乙')
    recs.push(record(`mem_few_${String(i).padStart(2, '0')}`, T0 + i * DAY, { tags }))
  }
  seed(home, recs)
  const r = buildInjectionIndex({ home, injection: { topTags: 3 } })
  assert.deepEqual(r.diag.anchors, ['窄甲', '窄乙'], '只有 2 个合格 ⇒ 如实少给')
  assert.deepEqual(r.diag.distinctTags, 3)
  assert.deepEqual(r.diag.qualifiedTags, 2)
  assert.equal(r.text, '记忆 20 条（上限 2000）｜标签锚点：窄甲 / 窄乙｜细则用 memory_recall')
  assert.ok(!r.text.includes('宽标签'))
})

test('I4a.2 一个合格锚点都没有 ⇒ 那行如实写「无可区分锚点」，绝不回落到最高频标签', () => {
  const home = freshHome('i4a2-none')
  const recs = []
  for (let i = 0; i < 5; i += 1) recs.push(record(`mem_only_${i}`, T0 + i * DAY, { tags: ['坑位'] }))
  seed(home, recs)

  const r = buildInjectionIndex({ home })
  assert.deepEqual(r.diag.anchors, [])
  assert.deepEqual(r.diag.qualifiedTags, 0)
  assert.equal(r.diag.distinctTags, 1)
  assert.equal(r.text, `记忆 5 条（上限 2000）${ANCHOR_NONE_MARK}｜细则用 memory_recall`)
  assert.ok(r.text.includes('无可区分锚点'), `必须如实说明降级，实测 ${r.text}`)
  assert.ok(!r.text.includes('坑位'), '降级行绝不能拿覆盖全库的标签当锚点')
  assert.ok(r.text.length <= DEFAULT_INJECTION_MAX_CHARS)
  assert.equal(r.diag.truncated, false)

  // 红证形态：加一个「回落取最高频」的兜底 ⇒ 这一侧会包含 `坑位`，上面两条断言立刻变红。
  assert.equal(buildInjectionIndex({ home, injection: { anchorMaxDfRatio: 1 } }).text.includes('坑位'), true)
  // 「库里根本没有标签」与「有标签但都超频」是两回事：前者不写这一段。
  seed(home, [record('mem_untagged', T0, { tags: [] })])
  const bare = buildInjectionIndex({ home })
  assert.equal(bare.text, '记忆 1 条（上限 2000）｜细则用 memory_recall')
  assert.equal(bare.diag.distinctTags, 0)
  assert.ok(!bare.text.includes('无可区分锚点'))
})

// ── 3. 确定性 ────────────────────────────────────────────────────────────
test('I4a.2 确定性：记录顺序打乱、重复取值、换缓存实例，锚点与那一行逐字节相同', () => {
  const home = freshHome('i4a2-det')
  const recs = coverAllLibrary()
  seed(home, recs)
  const shuffled = [...recs].reverse()
  const rotated = [...recs.slice(37), ...recs.slice(0, 37)]
  assert.deepEqual(stableAnchors(shuffled, 3), ['判据', '快照', '测试'], '锚点不得依赖记录书写顺序')
  assert.deepEqual(stableAnchors(rotated, 3), ['判据', '快照', '测试'])

  const first = buildInjectionIndex({ home })
  const second = buildInjectionIndex({ home })
  const cached = buildInjectionIndex({ home }, createInjectionCache())
  const cache = createInjectionCache()
  const cold = buildInjectionIndex({ home }, cache)
  const warm = buildInjectionIndex({ home }, cache)
  assert.equal(first.text, COVER_ALL_LINE)
  assert.equal(second.text, first.text)
  assert.equal(cached.text, first.text)
  assert.equal(cold.text, first.text)
  assert.equal(warm.text, first.text)
  assert.equal(warm.diag.cached, true)
  assert.deepEqual(warm.diag.anchors, first.diag.anchors, '命中缓存时锚点必须同值')
  assert.equal(warm.diag.distinctTags, first.diag.distinctTags, '命中缓存时判据留痕也必须同值')
  assert.equal(warm.diag.qualifiedTags, first.diag.qualifiedTags)
})

// ── 4. 长度上限：带锚点行与降级行都必须守住 ─────────────────────────────
test('I4a.2 长度上限：带锚点行与「无可区分锚点」降级行在任意 maxChars 下都 ≤ 上限', () => {
  const home = freshHome('i4a2-cap')
  const recs = coverAllLibrary()
  seed(home, recs)
  const onlyCovered = []
  for (let i = 0; i < 30; i += 1) onlyCovered.push(record(`mem_ov_${i}`, T0 + i * DAY, { tags: ['坑位'] }))

  for (const maxChars of [DEFAULT_INJECTION_MAX_CHARS, 120, 60, 40, 30, 20, 12, HARD_MARK.length, 1, 0]) {
    const withAnchors = buildInjectionIndex({ home, injection: { maxChars, topTags: 64 } })
    assert.ok(withAnchors.text.length <= maxChars, `锚点行 ${withAnchors.text.length} 必须 <= ${maxChars}`)
    const degraded = buildInjectionIndex({ home, injection: { maxChars, topTags: 64 } })
    assert.ok(degraded.text.length <= maxChars)
    // 直接走纯函数路径：带锚点 / 降级 / 库内无标签 三种形状都不许越界
    for (const text of [
      planInjectionLine(120, 2000, ['判据', '快照', '测试'], maxChars).text,
      planInjectionLine(5, 2000, [], maxChars, true).text,
      planInjectionLine(5, 2000, [], maxChars, false).text,
    ]) assert.ok(text.length <= maxChars, `纯函数输出 ${JSON.stringify(text)} 必须 <= ${maxChars}`)
  }
  // 降级行塞不下「无可区分锚点」时：丢掉这一段，但 truncated 必须为 true（确实丢了一句如实说明）
  const minimal = `${'记忆 5 条（上限 2000）'}｜细则用 memory_recall`
  assert.equal(minimal.length, 33)
  const tightNoMark = planInjectionLine(5, 2000, [], 36, true)
  assert.equal(tightNoMark.text, minimal, '上限装得下最小行但装不下「无可区分锚点」⇒ 丢掉那一段')
  assert.equal(tightNoMark.truncated, true, '丢掉如实说明也必须标为截断（不许假装完整）')
  // 连硬截断标记之前的 base 都塞不下 ⇒ 只给 base 的头部 + 标记（不带任何假信息）
  const tiny = planInjectionLine(30, 2000, [], 12, true)
  assert.equal(tiny.text.length, 12)
  assert.ok(tiny.text.endsWith(HARD_MARK))
  assert.equal(tiny.truncated, true)
  assert.equal(planInjectionLine(30, 2000, [], HARD_MARK.length, true).text, '')
  assert.equal(planInjectionLine(30, 2000, [], 0, true).text, '')
})

// ── 5. 口径解析与可配置 ─────────────────────────────────────────────────
test('I4a.2 口径解析：anchorMaxDfRatio 夹到 0..1、非有限值回落默认（绝不静默变成「不过滤」）', () => {
  assert.equal(resolveInjectionOptions(undefined).anchorMaxDfRatio, ANCHOR_MAX_DF_RATIO)
  assert.equal(resolveInjectionOptions({ anchorMaxDfRatio: 5 }).anchorMaxDfRatio, 1)
  assert.equal(resolveInjectionOptions({ anchorMaxDfRatio: -1 }).anchorMaxDfRatio, 0)
  assert.equal(resolveInjectionOptions({ anchorMaxDfRatio: 0.25 }).anchorMaxDfRatio, 0.25)
  assert.equal(resolveInjectionOptions({ anchorMaxDfRatio: '0.1' }).anchorMaxDfRatio, 0.1)
  assert.equal(resolveInjectionOptions({ anchorMaxDfRatio: Number.NaN }).anchorMaxDfRatio, ANCHOR_MAX_DF_RATIO)
  assert.equal(resolveInjectionOptions({ anchorMaxDfRatio: Number.POSITIVE_INFINITY }).anchorMaxDfRatio, ANCHOR_MAX_DF_RATIO)
  assert.equal(resolveInjectionOptions({ anchorMaxDfRatio: 'abc' }).anchorMaxDfRatio, ANCHOR_MAX_DF_RATIO)
})

test('I4a.2 可配置：放宽到 0.1 会换掉锚点集合；收紧到 0 等于「不要锚点」', () => {
  const home = freshHome('i4a2-knob')
  const recs = coverAllLibrary()
  seed(home, recs)
  // 0.1 ⇒ 合格集合只剩 df ≤ 12 的标签（判据 12 恰好 = 0.1 不算超）⇒ 判据/快照/测试 仍在
  const strict = buildInjectionIndex({ home, injection: { anchorMaxDfRatio: 0.1 } })
  assert.deepEqual(strict.diag.anchors, ['判据', '快照', '测试'])
  // 0 ⇒ 任何出现过的标签都超限 ⇒ 如实降级（等于「不要锚点」），但绝不许回落到最高频
  const zero = buildInjectionIndex({ home, injection: { anchorMaxDfRatio: 0 } })
  assert.deepEqual(zero.diag.anchors, [])
  assert.equal(zero.diag.qualifiedTags, 0)
  assert.ok(zero.text.includes('无可区分锚点'))
  assert.ok(!zero.text.includes('坑位'))
})

// ── 6. 端到端：apply 注册的那一行就是同一行 ──────────────────────────────
test('I4a.2 端到端：apply 注册的 agent-memory 那行与 buildInjectionIndex 完全一致（含降级形状）', () => {
  const home = freshHome('i4a2-apply')
  const recs = coverAllLibrary()
  seed(home, recs)
  const contribution = appliedContexts({ home }).get(INJECTION_CONTEXT_NAME)
  assert.ok(contribution)
  assert.equal(contribution.text(), COVER_ALL_LINE)
  assert.equal(contribution.text(), buildInjectionIndex({ home }).text)

  const home2 = freshHome('i4a2-apply-degraded')
  seed(home2, [record('mem_d1', T0, { tags: ['坑位'] }), record('mem_d2', T0 + DAY, { tags: ['坑位'] })])
  const degraded = appliedContexts({ home: home2 }).get(INJECTION_CONTEXT_NAME)
  const line = degraded.text()
  assert.equal(line, `记忆 2 条（上限 2000）${ANCHOR_NONE_MARK}｜细则用 memory_recall`)
  assert.equal(line, buildInjectionIndex({ home: home2 }).text)
})
