// 用例 5：memory_recall 是 L1 —— 任何情况下都不得泄漏 body；正文只能经 memory_expand（L2）取回。
// 另附 I1.2 打分口径的三条红证（判红点就写在用例名里）：
//  A) 无关查询不得是满分（批内归一化会把它打成 1.0000）
//  B) 短而相关必须赢过长而无关（关掉 BM25 的 b 就反超）
//  C) 候选 <= 5 且 limit >= 候选数时，打印的 score 序列必须单调不增（多样性不并入分数就倒挂）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freshHome, tools } from './helpers.mjs'

const SPLIT = ' | '
const scoreOfLine = (line) => Number(line.split(SPLIT).at(-1))
const idOfLine = (line) => line.split(SPLIT)[0]

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

// ── I1.2 打分口径三条红证 ────────────────────────────────────────────────────

test('打分红证 1（判红点）：无关查询不得是满分 ⇒ Top1 match !== strong 且 disp < 0.5', async () => {
  const home = freshHome('recall-unrelated')
  const defs = tools()
  const remember = defs.get('memory_remember')
  const recall = defs.get('memory_recall')

  for (const [title, body] of [
    ['dark theme css variables', 'the dark theme uses css variables'],
    ['index rebuild steps', 'rebuild the search index nightly'],
  ]) {
    const w = await remember.execute({ kind: 'fact', title, body, tags: ['ui', 'ops'], source: 'test:recall' })
    assert.equal(w.ok, true)
  }

  // 与库完全无关的查询（库内全是 ASCII，查询是中文）
  const r = await recall.execute({ query: '今天天气怎么样', limit: 5 })
  assert.equal(r.ok, true)
  assert.ok(r.rows.length > 0, '无关查询也必须如实返回候选：不得整批否决、不得返回空')

  const top = r.rows[0]
  assert.notEqual(top.match, 'strong', `Top1 不得判成 strong：${JSON.stringify(top)}`)
  assert.ok(top.score < 0.5, `Top1 展示分必须 < 0.5，实际 ${top.score}`)
  assert.equal(top.rel, 0, '无任何证据 ⇒ 相关度为 0（只奖不罚，不统一扣分）')

  // 打印列（最后一列）必须和结构化行一致 —— 判红（换回批内归一化）时这里会变成 1.0000
  const printed = scoreOfLine(r.lines[0])
  assert.ok(printed < 0.5, `打印分不得是 1.0000，实际 ${printed}`)
  assert.equal(printed, 0)
  assert.equal(r.diversityApplied, false)
})

test('打分红证 2（判红点）：短而相关必须赢过长而无关（BM25 长度归一）', async () => {
  const home = freshHome('recall-length')
  const defs = tools()
  const remember = defs.get('memory_remember')
  const recall = defs.get('memory_recall')

  // 8 条短填充，把 body 的 avgdl 拉回正常量级（否则长文档自己就能抬高 avgdl）
  const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '
  for (let i = 0; i < 8; i += 1) {
    const w = await remember.execute({
      kind: 'fact', title: `filler note number ${i}`, body: `plain filler text number ${i} with noise`,
      tags: ['filler'], source: 'test:recall',
    })
    assert.equal(w.ok, true)
  }
  // 长而噪声：约 3000 字，把查询词反复堆了 5 次（词频高、内容无关）
  const longBody = filler.repeat(40) + ' zetaword zetaword zetaword zetaword zetaword'
  assert.ok(longBody.length >= 3000, `长文档必须 >= 3000 字，实际 ${longBody.length}`)
  const long = await remember.execute({
    kind: 'fact', title: 'long noise document', body: longBody, tags: ['noise'], source: 'test:recall',
  })
  // 短而相关：正文只有一个词元，就是查询词
  const short = await remember.execute({
    kind: 'fact', title: 'short focused note', body: 'zetaword', tags: ['zeta'], source: 'test:recall',
  })
  assert.equal(long.ok, true)
  assert.equal(short.ok, true)

  const r = await recall.execute({ query: 'zetaword', limit: 50 })
  const ids = r.rows.map((row) => row.id)
  assert.ok(ids.includes(short.id) && ids.includes(long.id), `两条都必须在候选里：${ids.join(',')}`)
  // 失败信息给可读名次（红证时必须一眼看出是谁反超了谁）
  const order = r.rows
    .map((row) => (row.id === short.id ? 'SHORT-RELEVANT' : row.id === long.id ? 'LONG-NOISE' : 'other'))
    .join(' > ')
  assert.ok(
    ids.indexOf(short.id) < ids.indexOf(long.id),
    `短而相关必须排在长而噪声之前（判红点：把 BM25 的 b 设为 0 后长的那条会反超）：${order}`,
  )
  const printedIds = r.lines.map(idOfLine)
  assert.ok(printedIds.indexOf(short.id) < printedIds.indexOf(long.id), '打印顺序必须一致')

  // 只奖不罚：长噪声只是被长度归一稀释，不是被清零
  const longRow = r.rows.find((row) => row.id === long.id)
  assert.ok(longRow.rel > 0, '长文档应保留非零相关度（只稀释、不清零）')
})

test('打分红证 3（判红点）：候选 <= 5 时打印的 score 序列单调不增', async () => {
  const home = freshHome('recall-monotone')
  const defs = tools()
  const remember = defs.get('memory_remember')
  const recall = defs.get('memory_recall')

  const pad = (n) => Array.from({ length: n }, (_, i) => `pad${i}`).join(' ')
  // 3 条候选（<= 5）：A 命中 title+body、B/C 只命中 body（B 与 A 同标签、C 不同标签）
  const seeds = [
    { title: 'zetaword note a', body: `zetaword ${pad(4)}`, tags: ['x'] },
    { title: 'plain note b', body: `zetaword zetaword zetaword ${pad(3)}`, tags: ['x'] },
    { title: 'plain note c', body: `zetaword zetaword ${pad(4)}`, tags: ['y'] },
  ]
  for (const s of seeds) {
    const w = await remember.execute({ kind: 'fact', ...s, source: 'test:recall' })
    assert.equal(w.ok, true)
  }

  const r = await recall.execute({ query: 'zetaword', limit: 5 })
  assert.equal(r.rows.length, 3)

  const printed = r.lines.map(scoreOfLine)
  // 防断言空转：分数必须有区分度，否则「单调」没有说服力
  assert.ok(new Set(printed).size >= 3, `分数必须有区分度：${printed.join(',')}`)
  for (let i = 1; i < printed.length; i += 1) {
    assert.ok(
      printed[i] <= printed[i - 1],
      `打印的 score 必须单调不增（判红点：强制开启多样性重排就会倒挂）：${printed.join(',')}`,
    )
  }
  // 单调由两件事共同保证：候选 <= 5 跳过多样性 + 打印的是含惩罚的最终分。
  assert.equal(r.diversityApplied, false, '候选 <= 5 必须跳过多样性')
  assert.equal(r.diversityBeta, 0)
  assert.ok(r.rows[0].rel > r.rows[1].rel && r.rows[1].rel > r.rows[2].rel, '相关度本身应严格递减')
})
