// 用例 3 + 4：衰减单调性与半衰期精度；RRF 确定性与同分字典序决胜。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DAY_MS, decay, diversify, lexicalScore, rrf, tokenize } from '../lib/pure.js'

const T0 = 1_700_000_000_000

test('用例 3：decay 对更老的记录严格更小（单调不增）', () => {
  const now = T0
  const ages = [0, 1, 30, 180, 365, 3650]
  const scores = ages.map((d) => decay(now - d * DAY_MS, now))
  for (let i = 1; i < scores.length; i += 1) {
    assert.ok(scores[i] < scores[i - 1], `${ages[i]} 天前的分数必须比 ${ages[i - 1]} 天前更小`)
  }
  assert.equal(decay(now, now), 1, '刚发生的记录 decay = 1')
})

test('用例 3：固定时间戳下，恰好一个半衰期衰减到 0.5', () => {
  const now = 1_800_000_000_000
  assert.equal(decay(now - 180 * DAY_MS, now, 180), 0.5)
  assert.equal(decay(now - 90 * DAY_MS, now, 180), 0.5 ** 0.5)
  assert.equal(decay(now - 360 * DAY_MS, now, 180), 0.25)
  // 自定义半衰期
  assert.equal(decay(now - 7 * DAY_MS, now, 7), 0.5)
  // 未来时间戳按「刚发生」处理，decay 不得超过 1（保证单调不增）
  assert.equal(decay(now + 5 * DAY_MS, now), 1)
  // 非法半衰期回落到 180
  assert.equal(decay(now - 180 * DAY_MS, now, 0), 0.5)
})

test('用例 4：rrf 同一输入跑两次结果完全一致', () => {
  const lists = [
    ['c', 'a', 'b', 'd'],
    ['b', 'a', 'e'],
    ['a', 'c'],
  ]
  const first = rrf(lists, { k: 60, alpha: 0.6 })
  const second = rrf(lists, { k: 60, alpha: 0.6 })
  assert.deepEqual(second, first)
  // 逐字段再钉一遍（防止 deepEqual 掩盖 NaN）
  assert.deepEqual(first.map((e) => e.id), second.map((e) => e.id))
  assert.deepEqual(first.map((e) => e.score), second.map((e) => e.score))
  assert.deepEqual(first.map((e) => e.ranks), second.map((e) => e.ranks))
  assert.ok(first.every((e) => Number.isFinite(e.score)))
  // 多路命中的 a 必须排在只在一路出现的 e 前面
  const order = first.map((e) => e.id)
  assert.ok(order.indexOf('a') < order.indexOf('e'))
})

test('用例 4：RRF 同分时按 id 字典序稳定决胜', () => {
  // alpha=1 ⇒ 两路等权；'a' 与 'b' 各只在第 1 名出现一次 ⇒ 分数完全相同
  const one = rrf([['a'], ['b']], { k: 60, alpha: 1 })
  const two = rrf([['b'], ['a']], { k: 60, alpha: 1 })
  assert.equal(one[0].score, one[1].score, '构造前提：两者同分')
  assert.equal(two[0].score, two[1].score)
  assert.deepEqual(one.map((e) => e.id), ['a', 'b'])
  assert.deepEqual(two.map((e) => e.id), ['a', 'b'], '输入顺序反转后仍按 id 字典序决胜')
  // 三路同分
  const three = rrf([['zz'], ['mm'], ['aa']], { k: 60, alpha: 1 })
  assert.deepEqual(three.map((e) => e.id), ['aa', 'mm', 'zz'])
})

test('用例 4：rrf 同路重复 id 只记首次名次，且空/非法输入不炸', () => {
  const r = rrf([['a', 'a', 'b'], []], {})
  assert.deepEqual(r.map((e) => e.id), ['a', 'b'])
  assert.deepEqual(r[0].ranks, [1])
  assert.deepEqual(rrf([]), [])
  assert.deepEqual(rrf([[]]), [])
})

test('lexicalScore 归一化到 0..1，且 tags 权重 > title > body', () => {
  // 契约：score = Σ(字段权重 * 该字段命中查询词元数) / (6 * 查询词元数)
  // ⇒ 单条命中：tags 3/6、title 2/6、body 1/6；只有每个字段都覆盖整个查询才可能到 1。
  const rec = { title: 'alphaword', body: 'betaword', tags: ['gammaword'] }
  const sTag = lexicalScore('gammaword', rec)
  const sTitle = lexicalScore('alphaword', rec)
  const sBody = lexicalScore('betaword', rec)
  assert.equal(sTag, 3 / 6)
  assert.equal(sTitle, 2 / 6)
  assert.equal(sBody, 1 / 6)
  assert.ok(sTag > sTitle, 'tags 权重必须高于 title')
  assert.ok(sTitle > sBody, 'title 权重必须高于 body')

  // 覆盖越多分越高（单调）
  const spread = { title: 'alphaword', body: 'betaword', tags: ['gammaword'] }
  const partial = { title: 'alphaword', body: '无关正文', tags: ['无关标签'] }
  assert.ok(lexicalScore('alphaword gammaword', spread) > lexicalScore('alphaword', partial))

  // 每个字段都覆盖整个查询 ⇒ 恰好满分 1
  const perfect = { title: 'alphaword', body: 'alphaword', tags: ['alphaword'] }
  assert.equal(lexicalScore('alphaword', perfect), 1)

  // 全域 0..1 与边界
  const probes = ['gammaword', 'alphaword betaword gammaword', '', '完全不相干的查询词', '深色主题']
  for (const q of probes) {
    const s = lexicalScore(q, rec)
    assert.ok(s >= 0 && s <= 1, `分数必须落在 0..1：${q} -> ${s}`)
  }
  assert.equal(lexicalScore('', rec), 0)
  assert.equal(lexicalScore('完全不相干的查询词', rec), 0)
  assert.equal(lexicalScore('anything', null), 0)
  assert.equal(lexicalScore(undefined, rec), 0)
  assert.ok(lexicalScore('深色主题', { body: '用户选择了深色主题方案' }) > 0, '中文应能命中')
  assert.deepEqual(tokenize('深色主题'), ['深', '深色', '色', '色主', '主', '主题', '题'])
})

test('diversify：同标签堆叠被打散，且结果确定性', () => {
  const records = [
    { id: 'aaa', score: 1.0, tags: ['x'] },
    { id: 'bbb', score: 0.99, tags: ['x'] },
    { id: 'ccc', score: 0.98, tags: ['x'] },
    { id: 'ddd', score: 0.9, tags: ['y'] },
  ]
  const first = diversify(records, { lambda: 0.7, limit: 2 })
  const second = diversify([...records].reverse(), { lambda: 0.7, limit: 2 })
  assert.deepEqual(first.map((r) => r.id), ['aaa', 'ddd'], '第二名必须换成不同标签的记录（堆叠被打散）')
  assert.deepEqual(second.map((r) => r.id), first.map((r) => r.id), '输入顺序变化不影响结果（确定性）')
  // lambda=1 退化为纯按分数
  assert.deepEqual(diversify(records, { lambda: 1, limit: 2 }).map((r) => r.id), ['aaa', 'bbb'])
  // limit 超界与空输入
  assert.equal(diversify(records, { limit: 99 }).length, 4)
  assert.deepEqual(diversify([], { limit: 3 }), [])
})
