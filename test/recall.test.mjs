// 用例 5：memory_recall 是 L1 —— 任何情况下都不得泄漏 body；正文只能经 memory_expand（L2）取回。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freshHome, tools } from './helpers.mjs'

const SENTINEL = (i) => `BODYONLY-SENTINEL-${i}-zzq`

async function seed(remember, n, tag = 'leak') {
  const ids = []
  for (let i = 0; i < n; i += 1) {
    const r = await remember.execute({
      kind: 'fact',
      title: `泄漏探针第 ${i} 号标题条目`,
      body: `这条正文只应出现在 expand 里：${SENTINEL(i)}`,
      tags: [tag, `t${i}`],
      source: 'test:leak',
    })
    assert.equal(r.ok, true)
    ids.push(r.id)
  }
  return ids
}

test('memory_recall 绝不返回 body（文本、行、整个返回值三处都查）', async () => {
  const home = freshHome('recall-leak')
  const defs = tools()
  const remember = defs.get('memory_remember')
  const recall = defs.get('memory_recall')

  const ids = await seed(remember, 3)
  const r = await recall.execute({ query: '泄漏探针', limit: 5 })

  assert.equal(r.ok, true)
  assert.equal(r.total, 3)
  assert.ok(r.shown > 0, '至少要召回一条，否则本用例没有说服力')

  const dump = JSON.stringify(r)
  for (let i = 0; i < 3; i += 1) {
    assert.ok(!r.text.includes(SENTINEL(i)), `text 泄漏了第 ${i} 条 body`)
    assert.ok(!dump.includes(SENTINEL(i)), `整个返回值泄漏了第 ${i} 条 body`)
  }
  for (const line of r.lines) {
    assert.ok(!line.includes('BODYONLY-SENTINEL'), `L1 行泄漏了 body：${line}`)
    // 行格式：id | kind | title | tags | score
    assert.match(line, /^mem_[a-z0-9_]+ \| (fact|lesson|preference|pointer) \| .+ \| .* \| \d+\.\d{4}$/)
  }

  // 反向对照：body 确实躺在库里，且 expand（L2）能取回 —— 证明上面不是「库里本来就没有」
  const ex = await defs.get('memory_expand').execute({ ids: [ids[0]] })
  assert.equal(ex.found, 1)
  assert.ok(ex.records[0].body.includes(SENTINEL(0)), 'expand 必须能取回正文')
  assert.ok(ex.text.includes(SENTINEL(0)))
})

test('memory_recall 空查询与空库也不泄漏、不炸', async () => {
  const home = freshHome('recall-empty')
  const defs = tools()
  const recall = defs.get('memory_recall')

  const empty = await recall.execute({ query: '' })
  assert.equal(empty.ok, true)
  assert.equal(empty.total, 0)
  assert.deepEqual(empty.lines, [])
  assert.match(empty.text, /记忆库为空/)

  const remember = defs.get('memory_remember')
  await seed(remember, 2)
  const noQuery = await recall.execute({ query: '', limit: 5 })
  assert.equal(noQuery.ok, true)
  assert.ok(noQuery.shown > 0, '空查询也必须能按新鲜度召回')
  for (const line of noQuery.lines) assert.ok(!line.includes('BODYONLY-SENTINEL'))
})

test('memory_recall 输出超 2000 字符必须截断并如实说明', async () => {
  const home = freshHome('recall-truncate')
  const defs = tools()
  const remember = defs.get('memory_remember')
  const recall = defs.get('memory_recall')

  await seed(remember, 60, 'bulk')
  const r = await recall.execute({ query: '泄漏探针', limit: 50 })

  assert.equal(r.total, 60)
  assert.equal(r.limit, 50)
  assert.equal(r.truncated, true, '50 条 L1 行必然超过 2000 字符，必须如实报告截断')
  assert.ok(r.text.length <= 2000, `截断后总长必须 <= 2000，实际 ${r.text.length}`)
  assert.ok(r.shown < 50, `截断后 shown 必须小于 50，实际 ${r.shown}`)
  assert.match(r.text, /已截断/)
  assert.ok(!r.text.includes('BODYONLY-SENTINEL'), '截断路径同样不得泄漏 body')
  assert.deepEqual(r.lines, r.text.split('\n').slice(1, 1 + r.shown))
})

test('memory_recall 的 limit 参数被夹到 1..50', async () => {
  const home = freshHome('recall-limit')
  const defs = tools()
  await seed(defs.get('memory_remember'), 3)
  const recall = defs.get('memory_recall')

  assert.equal((await recall.execute({ query: 'x', limit: 0 })).limit, 1)
  assert.equal((await recall.execute({ query: 'x', limit: 9999 })).limit, 50)
  assert.equal((await recall.execute({ query: 'x' })).limit, 5)
})
