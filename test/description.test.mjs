// 用例 I7：memory_recall 工具描述的「描述与实现对账」+ 修正 2 的「描述瘦身但情报不丢」。
//
// 为什么要单独钉描述：描述是模型理解输出格式与打分口径的依据，说错了模型就会按错的公式读列。
// 历史上这里的病（已修，反向断言仍留着防回退）：
//   #3 旧描述：`score 是含多样性惩罚的最终分` —— 听着像"总是乘多样性"，且完全没写
//      `final=(rel+graph)×多样性因子`、"只在候选 > 5 时施加"、"因此多样性开时 score 无法仅由
//      打印的 rel/graph 复算"。
//   #2 旧描述：`无证据候选 rel/score 均为 0.0000` —— 实测反例：只由标签图到达的记录会被返回，
//      rel=0 但 graph=0.018、via=tag:<标签>；它的 score 打印成 0.0000 **仅因为**
//      SCALE_A=0.0187 > GRAPH_BONUS_CAP=0.018（余量 0.0007）。
//   #1 旧描述：`graph` / `via` 两列的语义一个字都没写。
//
// ── 修正 2 改变了本文件的**形状**（不是放松）──────────────────────────────────
// 旧描述 1182 字符，与表头回显大量重复。现在描述压到 <= 300 字符，只留模型每次调用都要用的五件事：
//   ① 10 列清单（**仍由 RECALL_COLUMNS 派生**，列序是契约，不许手抄第二遍）；
//   ② 一句 `rel`/`match`/`score` 语义；③ `limit` 是硬显示上限；④ 绝不返回 body；⑤ 指向契约文档。
// 删掉的细则**一条都没丢**，全部逐字搬进 `docs/recall-contract.md`（§10），本文件把断言**改钉到文档上**。
// 这不是放松：描述既然把口径指向那份文档，文档就必须真的载着情报 —— 下面每一条都在文档里逐字可查，
// 把文档里任何一条删掉都会红。空断言（`includes('')` 之类）一条都没有。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DIVERSITY_MIN_CANDIDATES, RECALL_COLUMNS } from '../lib/index.js'
import { DEFAULT_DIVERSITY_BETA } from '../lib/pure.js'
import { freshHome, tools } from './helpers.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 描述指向的契约文档 —— 描述里删掉的细则必须逐字在这里。 */
const CONTRACT = readFileSync(join(HERE, '..', 'docs', 'recall-contract.md'), 'utf8')

/** 取一次 memory_recall 的工具描述（每个用例一个干净 DSH_HOME）。 */
function recallDescription(tag) {
  freshHome(`description-${tag}`)
  const recall = tools().get('memory_recall')
  assert.ok(recall !== undefined, 'memory_recall 必须注册')
  assert.equal(typeof recall.description, 'string')
  return recall.description
}

/** 描述里必须逐字出现的契约文档指针（唯一允许的细节出处）。 */
const DOC_POINTER = 'docs/recall-contract.md'

test('修正 2：描述 <= 300 字符，且五件必备情报一个都不少（判红点：把细则塞回描述 ⇒ 长度断言变红）', () => {
  const d = recallDescription('slim')
  // ① 长度上限（修正 2 的目标值；旧描述 1182 字符）
  assert.ok(d.length <= 300, `memory_recall 描述必须 <= 300 字符，实际 ${d.length}：${d}`)
  // ② 10 列清单必须**由 RECALL_COLUMNS 派生**（不是手抄的十列）
  assert.ok(d.includes(RECALL_COLUMNS.join(' | ')),
    `描述必须含由 RECALL_COLUMNS 派生的 10 列清单（${RECALL_COLUMNS.join(' | ')}）：${d}`)
  assert.ok(RECALL_COLUMNS.length === 10, `列清单必须是 10 列，实际 ${RECALL_COLUMNS.length}`)
  // ③ 一句 rel/match/score 语义
  assert.ok(d.includes('rel=BM25 原始相关度') || d.includes('rel=BM25原始相关度'),
    `描述必须写明 rel 是 BM25 原始相关度：${d}`)
  assert.ok(d.includes('match'), `描述必须提到 match 的判定：${d}`)
  assert.ok(d.includes('score=disp(final)'), `描述必须写明 score=disp(final)：${d}`)
  // ④ limit 是硬显示上限
  assert.ok(d.includes('limit 是硬显示上限') || d.includes('limit** 是硬显示上限') || d.includes('**limit 是硬显示上限'),
    `描述必须写明 limit 是硬显示上限：${d}`)
  // ⑤ 绝不返回 body
  assert.ok(d.includes('绝不返回 body'), `描述必须写明绝不返回 body：${d}`)
  // ⑥ 指向契约文档
  assert.ok(d.includes(DOC_POINTER), `描述必须指向 ${DOC_POINTER}：${d}`)
})

test('修正 2：描述里删掉的细则必须逐字在 docs/recall-contract.md 上（判红点：删掉文档里任一条 ⇒ 本条变红）', () => {
  // 每一条都是旧描述里逐字存在的断言，现在改钉到文档 —— 情报一条没丢，只是换了住处。
  const must = [
    'score=disp(final)',
    'final=(rel+graph)×多样性因子',
    `β 默认 ${DEFAULT_DIVERSITY_BETA}`,
    `仅当候选数 > ${DIVERSITY_MIN_CANDIDATES} 时施加`,
    'diversityApplied',
    '无法仅由打印出的 rel/graph 精确复算',
    '始终可由打印的 rel + 表头阈值复算',
    '是标签图传播给的**辅助**奖励',
    'graphBonusCap',
    '不会压过词法相关度',
    'via` 是该行来源',
    '由该标签的图传播到达',
    '是标签覆盖率',
    '仅诊断',
    '无词法证据时',
    'rel=0',
    '仅由标签图到达的记录',
    'graph>0',
    'via=tag:<标签>',
    '取决于标度常数（可能为 0 也可能 >0）',
    'match=none',
    '只奖不罚，不整批否决',
    '不增加返回行数',
    '不做分诊',
    '0/0',
    '绝不返回空、绝不整批否决',
  ]
  for (const phrase of must) {
    assert.ok(CONTRACT.includes(phrase),
      `契约文档（描述指向它）必须逐字含「${phrase}」——否则描述那个指针就是谎`)
  }
  // 反向：文档必须真的被描述指到（两颗钉子互为反向）
  const d = recallDescription('doc-pointer')
  assert.ok(d.includes(DOC_POINTER), `描述必须指向 ${DOC_POINTER}：${d}`)
})

test('反向：旧的不成立表述不得再出现在描述里（判红点：把描述改回旧那句 ⇒ 本条变红）', () => {
  const d = recallDescription('negative')
  assert.ok(!d.includes('score 是含多样性惩罚的最终分'),
    `描述不得再出现旧的不成立表述「score 是含多样性惩罚的最终分」：${d}`)
  assert.ok(!d.includes('无证据候选 rel/score 均为 0.0000'),
    `描述不得再出现旧的不成立表述「无证据候选 rel/score 均为 0.0000」：${d}`)
})
