// 用例 I6：memory_recall 的「列清单」单点真相对账（防漂断言，必须能判红）。
//
// 背景（本次要修的病）：memory_recall 的工具描述里那串列清单是**旧的 8 列**
//   id | kind | title | tags | rel | cov | match | score
// 而 I3 之后 formatL1 实际输出的是 **10 列**（tags 与 rel 之间多了 graph | via）。
// 这**不是纯文案问题**：工具描述是模型理解输出格式的依据 —— 描述说 8 列、实际给 10 列，
// 模型按描述切列时就得猜。
//
// 修法是抽单点真相：src/index.ts 的 RECALL_COLUMNS 是列名与列序的**唯一来源**，
// 渲染（formatL1 的 Record 取值表 + map 拼接）、工具描述、表头「列序:」段全部由它派生。
//
// 本文件钉住三件事（互相独立，都能单独判红）：
//   ① 描述与实现一致：description 必须含 RECALL_COLUMNS.join(' | ')；
//   ② 渲染行与列清单一致：真跑一次召回，每行按 RECALL_COLUMN_SEP 切出的字段数
//      必须 === RECALL_COLUMNS.length，第 1 个字段是 id、最后 1 个字段是 4 位小数的 score；
//   ③ 同一份列清单不得养出第二个顺序：schema rows.properties 的键序、formatL1 取值表
//      （recallCells）的键序、以及真实 rows 的键序都必须逐项等于 RECALL_COLUMNS。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RECALL_COLUMNS, RECALL_COLUMN_SEP, recallCells } from '../lib/index.js'
import { freshHome, tools } from './helpers.mjs'

test('I6 单点真相：列清单自身的形状（首列 id、末列 score、无重复、分隔符带空格）', () => {
  assert.ok(Array.isArray(RECALL_COLUMNS) && RECALL_COLUMNS.length > 0, 'RECALL_COLUMNS 必须是非空数组')
  assert.equal(RECALL_COLUMNS[0], 'id', '首列必须是 id（行首解析契约）')
  assert.equal(RECALL_COLUMNS[RECALL_COLUMNS.length - 1], 'score', '列清单末位必须是 score（按 -1 取分数的契约）')
  assert.equal(new Set(RECALL_COLUMNS).size, RECALL_COLUMNS.length, '列名不得重复')
  assert.equal(RECALL_COLUMN_SEP, ' | ', '列分隔符必须是「空格竖线空格」，否则既有读者切不出列')
})

test('I6 防漂 1（判红点：把描述里的列清单改回旧的 8 列硬编码串 ⇒ 本条变红）：描述与列清单同源', async () => {
  freshHome('columns-desc')
  const defs = tools()
  const recall = defs.get('memory_recall')
  assert.ok(recall !== undefined, 'memory_recall 必须注册')

  // ① 描述必须含**由 RECALL_COLUMNS 生成**的那串列清单（不是另一个手写副本）。
  const listText = RECALL_COLUMNS.join(' | ')
  assert.ok(recall.description.includes(listText),
    `description 必须含列清单「${listText}」，实际描述：${recall.description}`)
  // 反向：旧的 8 列串（缺 graph | via）不得作为「列清单」出现在描述里。
  // 注意 include 判定：8 列串不是 10 列串的子串，所以上面那条与这条互为反向。
  const oldEight = 'id | kind | title | tags | rel | cov | match | score'
  assert.ok(!recall.description.includes(oldEight),
    `description 不得再出现旧的 8 列串「${oldEight}」：${recall.description}`)
})

test('I6 防漂 2（判红点：让 formatL1 少渲染一列 / 调换列序 ⇒ 本条变红）：渲染行与列清单一致', async () => {
  freshHome('columns-render')
  const defs = tools()
  const remember = defs.get('memory_remember')
  const recall = defs.get('memory_recall')
  for (let i = 0; i < 3; i += 1) {
    const w = await remember.execute({
      kind: 'fact', title: `alpha beta note ${i}`, body: `alpha beta details ${i}`,
      tags: ['alpha', 'beta'], source: 'test:columns',
    })
    assert.equal(w.ok, true)
  }

  const r = await recall.execute({ query: 'alpha', limit: 5 })
  assert.ok(r.shown > 0, '至少召回一条，否则本断言没有说服力')
  assert.equal(r.lines.length, r.shown, 'lines 必须等于 shown')
  assert.equal(r.lines.length, r.rows.length, 'lines 与 rows 必须一一对应')

  for (let i = 0; i < r.lines.length; i += 1) {
    const line = r.lines[i]
    const fields = line.split(RECALL_COLUMN_SEP)
    // ② 字段数 === 列清单长度（8 列实现会在这里得到 8 != 10 ⇒ 红）
    assert.equal(fields.length, RECALL_COLUMNS.length,
      `第 ${i} 行字段数必须等于列清单长度 ${RECALL_COLUMNS.length}，实际 ${fields.length}：${line}`)
    // ③ 第 1 个字段是 id（且与结构化 rows 逐字一致）
    assert.equal(fields[0], r.rows[i].id, `第 ${i} 行首字段必须是 id：${line}`)
    assert.match(fields[0], /^mem_[a-z0-9_]+$/, `第 ${i} 行首字段必须是 id 形态：${line}`)
    // ④ 最后 1 个字段是 score：4 位小数数字，且与 rows 里的 score 一致（score 恒在末位）
    const last = fields[fields.length - 1]
    assert.match(last, /^\d+\.\d{4}$/, `第 ${i} 行末字段必须是 4 位小数的 score：${line}`)
    assert.equal(last, r.rows[i].score.toFixed(4),
      `第 ${i} 行末字段必须等于 rows[${i}].score=${r.rows[i].score}（score 在行尾）：${line}`)
  }

  // 反向凭证：表头「列序:」段同样由单点真相派生（同序、同长度），不是另一份手写副本。
  const header = r.text.split('\n')[0]
  assert.ok(header.includes(`列序:${RECALL_COLUMNS.join('|')}`),
    `表头「列序:」段必须等于 RECALL_COLUMNS.join('|')：${header}`)
})

// ── 同一份列清单不得养出第二个顺序（本次对账：L1Row / schema / 取值表 / 真实 rows 四处同序）──
//
// 背景（本次要修的病）：I3 之后打印列序是 `… tags | graph | via | rel | cov | match | score`，
// 但 `L1Row` 接口字段序与输出 schema 的 `rows.properties` 键序仍是 I3 之前的旧序
// （`… rel, cov, match, graph, via, score`）——同一份列清单有两个顺序，和 I6 那条列数漂移同类。
// 修法是纯顺序对齐（字段名/类型/必填性一个字不改），并把键序也钉成断言。

test('I6 防漂 3（判红点：把 schema 里 rel/cov 两个键换回 tags 之后（旧序）⇒ 本条变红）：rows.properties 键序 === RECALL_COLUMNS', () => {
  freshHome('columns-schema-order')
  const recall = tools().get('memory_recall')
  assert.ok(recall !== undefined, 'memory_recall 必须注册')
  const props = recall.output?.schema?.properties?.rows?.items?.properties
  assert.ok(props !== undefined && props !== null && typeof props === 'object',
    'schema 里必须有 rows.items.properties（列清单的可机读副本）')
  const keys = Object.keys(props)
  assert.equal(keys.length, RECALL_COLUMNS.length,
    `rows.properties 的键数必须等于列数 ${RECALL_COLUMNS.length}，实际 ${keys.length}：${keys.join('|')}`)
  assert.deepEqual(keys, [...RECALL_COLUMNS],
    `rows.properties 的键序必须逐项等于 RECALL_COLUMNS（旧序 rel,cov,match,graph,via 会在这里判红）：${keys.join('|')}`)
})

test('I6 防漂 4（判红点：把 recallCells 字面量里两个键换位 ⇒ 本条变红）：取值表键序与真实 rows 键序都必须 === RECALL_COLUMNS', async () => {
  freshHome('columns-cells-order')
  // ① formatL1 的取值表（recallCells）字面量键序：同一份列清单不养第二个顺序。
  const rec = { id: 'mem_probe', kind: 'fact', title: '探针', tags: ['a', 'b'], ts: 0, body: 'x', source: 's', hits: 0 }
  const view = { score: 0, rel: 0, cov: 0, match: 'none', graph: 0, via: 'direct' }
  const cells = recallCells(rec, view)
  assert.deepEqual(Object.keys(cells), [...RECALL_COLUMNS],
    `recallCells 的键序必须等于 RECALL_COLUMNS：${Object.keys(cells).join('|')}`)
  // 取值表的值也必须逐列可用（否则「键序对」可能是空转：键对但取值 undefined 会打印成 "undefined"）。
  for (const col of RECALL_COLUMNS) assert.equal(typeof cells[col], 'string', `第 ${col} 列必须有字符串取值`)

  // ② 真实返回的 rows 对象键序（= JSON 序列化顺序，消费方直接看到的东西）也必须一致。
  const defs = tools()
  const remember = defs.get('memory_remember')
  for (let i = 0; i < 3; i += 1) {
    const w = await remember.execute({
      kind: 'fact', title: `alpha beta note ${i}`, body: `alpha beta details ${i}`,
      tags: ['alpha', 'beta'], source: 'test:columns',
    })
    assert.equal(w.ok, true)
  }
  const r = await defs.get('memory_recall').execute({ query: 'alpha', limit: 5 })
  assert.ok(r.rows.length > 0, '至少召回一条，否则本断言没有说服力')
  for (const row of r.rows) {
    assert.deepEqual(Object.keys(row), [...RECALL_COLUMNS],
      `真实 rows 的键序（JSON 顺序）必须等于 RECALL_COLUMNS：${Object.keys(row).join('|')}`)
  }
})
