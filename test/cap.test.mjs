// 用例 2：硬上限——超限必须走淘汰（绝不无限增长），且被淘汰的必须是 score = recency*(1+hits) 最低者。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendRecord, byteLength, enforceCaps, evictionScore, loadRecords, saveRecords, serialize } from '../lib/store.js'
import { diskLines, freshHome, record, tools } from './helpers.mjs'

const DAY = 86_400_000
const T0 = 1_700_000_000_000

test('store 层：条数上限触发淘汰，淘汰的正是 recency*(1+hits) 最低者', () => {
  const home = freshHome('cap-records')
  const cfg = { home, maxRecords: 3, maxBytes: 4 * 1024 * 1024, now: () => T0 }

  // 三条种子：a 很旧且 hits=0（分数最低）; b 很新且 hits=5; c 最新且 hits=2
  const seed = [
    record('rec-a', T0 - 900 * DAY, { hits: 0 }),
    record('rec-b', T0 - 30 * DAY, { hits: 5 }),
    record('rec-c', T0 - 1 * DAY, { hits: 2 }),
  ]
  saveRecords(seed, cfg)
  assert.equal(loadRecords(cfg).length, 3)

  const draft = { kind: 'fact', title: '第四条记录用于触发上限', body: '正文', tags: ['cap'], source: 'test:cap' }
  const r = appendRecord(draft, cfg)

  // 淘汰后条数不得超过上限
  assert.equal(r.countAfter, 3)
  assert.equal(r.kept.length, 3)
  assert.equal(r.maxRecords, 3)
  assert.equal(r.evicted.length, 1)
  // 被淘汰者必须是四条里 evictionScore 最低的那条
  const all = [...seed, r.record]
  const lowest = [...all].sort((x, y) => (evictionScore(x, T0) - evictionScore(y, T0)))[0]
  assert.equal(r.evicted[0].id, lowest.id, '被淘汰者必须是 recency*(1+hits) 最低者')
  assert.equal(r.evicted[0].id, 'rec-a')

  // 磁盘上恰好 3 行，且被淘汰者不在其中
  const rows = diskLines(home)
  assert.equal(rows.length, 3)
  const ids = rows.map((l) => JSON.parse(l).id)
  assert.ok(!ids.includes('rec-a'), '被淘汰者不得残留')
  assert.ok(ids.includes(r.record.id))
})

test('store 层：字节上限触发淘汰，淘汰后占用不超过 maxBytes', () => {
  const home = freshHome('cap-bytes')
  const now = () => T0
  const seed = [
    record('rec-a', T0 - 900 * DAY, { hits: 0 }),
    record('rec-b', T0 - 1 * DAY, { hits: 9 }),
    record('rec-c', T0 - 30 * DAY, { hits: 2 }),
  ]
  // 上限恰好只装得下分数最高的那一条
  const top = [...seed].sort((x, y) => evictionScore(y, T0) - evictionScore(x, T0))[0]
  const maxBytes = byteLength(serialize([top]))
  const cfg = { home, maxRecords: 2000, maxBytes, now }
  saveRecords(seed, cfg)

  const capped = enforceCaps(seed, cfg, T0)
  assert.equal(capped.records.length, 1)
  assert.equal(capped.records[0].id, top.id)
  assert.equal(capped.maxBytes, maxBytes)
  assert.ok(byteLength(serialize(capped.records)) <= maxBytes)
})

test('工具层：环境变量收紧上限后，超限写入被淘汰且返回值如实报数', async () => {
  const home = freshHome('cap-tool')
  process.env.DSH_AGENT_MEMORY_MAX_RECORDS = '3'

  const defs = tools()
  const remember = defs.get('memory_remember')

  // 先种 3 条「高 hits」记录（分数 ≈ 100+，远高于任何新写入的 hits=0 记录）
  const now = Date.now()
  saveRecords([
    record('seed-a', now - 3 * DAY, { hits: 100 }),
    record('seed-b', now - 2 * DAY, { hits: 100 }),
    record('seed-c', now - 1 * DAY, { hits: 100 }),
  ], { home })

  const r = await remember.execute({ kind: 'fact', title: '第四条会被自己挤掉', body: '正文', tags: ['cap'], source: 'test:cap' })
  assert.equal(r.ok, true)
  assert.equal(r.maxRecords, 3, '上限必须能在返回值里看到')
  assert.equal(r.total, 3, '淘汰后条数必须能在返回值里看到')
  assert.equal(r.evicted, 1)
  assert.deepEqual(r.evictedIds, [r.id], '被淘汰的应是分数最低的新记录（hits=0）')

  const ids = diskLines(home).map((l) => JSON.parse(l).id)
  assert.equal(ids.length, 3)
  assert.ok(!ids.includes(r.id), '被淘汰的记录不得残留')
  assert.deepEqual(ids.sort(), ['seed-a', 'seed-b', 'seed-c'])

  // 继续写：条数永远不超过上限（绝不无限增长）
  for (let i = 0; i < 6; i += 1) {
    const w = await remember.execute({ kind: 'lesson', title: `压力写入第 ${i} 条记录`, body: `正文 ${i}`, tags: ['cap', 'stress'], source: 'test:cap' })
    assert.equal(w.ok, true)
    assert.ok(w.total <= 3, `第 ${i} 次写入后条数 ${w.total} 超过上限 3`)
  }
  assert.ok(diskLines(home).length <= 3)

  delete process.env.DSH_AGENT_MEMORY_MAX_RECORDS
})

test('上限参数本身非法时回落到默认值（不会被 0 或负数搞成清库）', () => {
  const home = freshHome('cap-default')
  const records = [record('rec-a', T0), record('rec-b', T0 - DAY)]
  saveRecords(records, { home })
  const cfg = { home, maxRecords: 0, maxBytes: -1, now: () => T0 }
  const capped = enforceCaps(records, cfg, T0)
  assert.equal(capped.maxRecords, 2000)
  assert.equal(capped.maxBytes, 4 * 1024 * 1024)
  assert.equal(capped.records.length, 2)
})
