// 附加用例：memory_prune —— 默认 dry-run 不动盘；真删时按「合并 + 淘汰」规则执行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadRecords, saveRecords } from '../lib/store.js'
import { diskLines, diskText, freshHome, record, tools } from './helpers.mjs'

const DAY = 86_400_000
const T0 = 1_700_000_000_000

test('memory_prune 默认 dryRun=true：只报告，不动磁盘', async () => {
  const home = freshHome('prune-dry')
  saveRecords([
    record('rec-1', T0 - 2 * DAY, { title: '同一条记忆标题', tags: ['a', 'b'], hits: 1 }),
    record('rec-2', T0 - 1 * DAY, { title: '同一条记忆标题', tags: ['b', 'c'], hits: 4 }),
    record('rec-3', T0 - 3 * DAY, { title: '另一条完全不同的记忆', tags: ['z'] }),
  ], { home })
  const before = diskText(home)

  const defs = tools()
  const r = await defs.get('memory_prune').execute({})

  assert.equal(r.ok, true)
  assert.equal(r.dryRun, true, 'dryRun 默认必须是 true')
  assert.equal(r.before, 3)
  assert.equal(r.after, 2)
  assert.equal(r.merged, 1)
  assert.deepEqual(r.mergedGroups, ['rec-2 <- [rec-1]'])
  assert.equal(r.evicted, 0)
  assert.equal(r.changed, true)
  assert.match(r.text, /dry-run/)
  assert.match(r.text, /dryRun=false/)
  assert.equal(diskText(home), before, 'dry-run 不得改动磁盘')
})

test('memory_prune 传 dryRun=false 才真删：合并保留最新、hits 累加、标签取有序并集', async () => {
  const home = freshHome('prune-apply')
  saveRecords([
    record('rec-1', T0 - 2 * DAY, { title: '同一条记忆标题', tags: ['a', 'b'], hits: 1 }),
    record('rec-2', T0 - 1 * DAY, { title: '同一条记忆标题', tags: ['b', 'c'], hits: 4 }),
    record('rec-3', T0 - 3 * DAY, { title: '另一条完全不同的记忆', tags: ['z'] }),
  ], { home })

  const defs = tools()
  const r = await defs.get('memory_prune').execute({ dryRun: false })

  assert.equal(r.dryRun, false)
  assert.equal(r.after, 2)
  assert.equal(r.merged, 1)
  assert.equal(r.evicted, 0)
  assert.match(r.text, /已执行并落盘/)

  const rows = loadRecords({ home })
  assert.deepEqual(rows.map((x) => x.id).sort(), ['rec-2', 'rec-3'])
  const kept = rows.find((x) => x.id === 'rec-2')
  assert.equal(kept.hits, 5, 'hits 必须累加')
  assert.deepEqual(kept.tags, ['b', 'c', 'a'], '标签取有序并集（保留者在前）')
  assert.equal(diskLines(home).length, 2)

  // 再跑一次：已无可合并项，changed 必须为 false
  const again = await defs.get('memory_prune').execute({ dryRun: true })
  assert.equal(again.changed, false)
  assert.equal(again.merged, 0)
})

test('memory_prune 真删时同时执行上限淘汰，并回收字节', async () => {
  const home = freshHome('prune-cap')
  process.env.DSH_AGENT_MEMORY_MAX_RECORDS = '1'
  saveRecords([
    record('rec-old', T0 - 900 * DAY, { title: '最旧最低分的记录', hits: 0 }),
    record('rec-mid', T0 - 100 * DAY, { title: '中间分的记录条目', hits: 1 }),
    record('rec-new', T0 - 1 * DAY, { title: '最新最高分的记录', hits: 3 }),
  ], { home })

  const defs = tools()
  const dry = await defs.get('memory_prune').execute({ dryRun: true })
  assert.equal(dry.after, 1)
  assert.equal(dry.evicted, 2)
  assert.deepEqual(dry.evictedIds.slice().sort(), ['rec-mid', 'rec-old'])
  assert.ok(dry.bytesAfter < dry.bytesBefore, '淘汰必须真的回收字节')
  assert.equal(loadRecords({ home }).length, 3, 'dry-run 不得动盘')

  const applied = await defs.get('memory_prune').execute({ dryRun: false })
  assert.equal(applied.after, 1)
  const rows = loadRecords({ home })
  assert.deepEqual(rows.map((x) => x.id), ['rec-new'])
  assert.equal(applied.maxRecords, 1)

  delete process.env.DSH_AGENT_MEMORY_MAX_RECORDS
})
