// 用例 I7：memory_recall 工具描述的「描述与实现对账」收尾（#1 graph/via 语义 / #2 无词法证据 /
// #3 score 公式漏了多样性）。
//
// 为什么要单独钉描述：描述是模型理解输出格式与打分口径的依据，说错了模型就会按错的公式读列。
// 三条病（本次修）：
//   #3 旧描述：`score 是含多样性惩罚的最终分` —— 听着像"总是乘多样性"，且完全没写
//      `final=(rel+graph)×多样性因子`、没写"只在候选 > 5 时施加"、也没写"因此多样性开时
//      score 无法仅由打印的 rel/graph 复算"（β 与 maxSim 都不在打印列里）。
//   #2 旧描述：`与库无关的查询不会拿到满分：无证据候选 rel/score 均为 0.0000` —— 实测反例：
//      只由标签图到达的记录会被返回，rel=0 但 graph=0.018、via=tag:<标签>；它的 score 打印成
//      0.0000 **仅因为** SCALE_A=0.0187 > GRAPH_BONUS_CAP=0.018（余量 0.0007）。
//   #1 旧描述：`graph` / `via` 两列的语义一个字都没写（列清单里有，含义靠猜）。
//
// 每条都配反向断言（旧的不成立表述不得再出现），否则"把描述改回旧那句"时不判红。
// 数值口径与实现常数的对齐也在这里钉住（β 默认值 / 候选数阈值直接引用模块级常数）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DIVERSITY_MIN_CANDIDATES } from '../lib/index.js'
import { DEFAULT_DIVERSITY_BETA } from '../lib/pure.js'
import { freshHome, tools } from './helpers.mjs'

/** 取一次 memory_recall 的工具描述（每个用例一个干净 DSH_HOME）。 */
function recallDescription(tag) {
  freshHome(`description-${tag}`)
  const recall = tools().get('memory_recall')
  assert.ok(recall !== undefined, 'memory_recall 必须注册')
  assert.equal(typeof recall.description, 'string')
  return recall.description
}

test('#3 描述：score 公式必须写清 (rel+graph)×多样性因子、只在候选>5时施加、且如实说明"开时不可复算"（判红点：改回「score 是含多样性惩罚的最终分」⇒ 本条变红）', () => {
  const d = recallDescription('score')
  // 正向：写清 final 的构成（rel+graph 与多样性因子）与施加条件
  assert.ok(d.includes('final=(rel+graph)×多样性因子'),
    `描述必须写明 final=(rel+graph)×多样性因子：${d}`)
  assert.ok(d.includes(`β 默认 ${DEFAULT_DIVERSITY_BETA}`),
    `描述里的 β 默认值必须是 ${DEFAULT_DIVERSITY_BETA}（与 DEFAULT_DIVERSITY_BETA 同源）：${d}`)
  assert.ok(d.includes(`仅当候选数 > ${DIVERSITY_MIN_CANDIDATES} 时施加`),
    `描述必须写明多样性只在候选数 > ${DIVERSITY_MIN_CANDIDATES} 时施加（与 DIVERSITY_MIN_CANDIDATES 同源）：${d}`)
  // 正向：如实说明"因此多样性开时不可复算"，且 match 始终可复算
  assert.ok(d.includes('无法仅由打印出的 rel/graph 精确复算'),
    `描述必须如实说明"多样性开时 score 无法仅由打印的 rel/graph 精确复算"：${d}`)
  assert.ok(d.includes('始终可由打印的 rel + 表头阈值复算'),
    `描述必须说明 match 始终可由打印的 rel + 表头阈值复算：${d}`)
  assert.ok(d.includes('diversityApplied'),
    `描述必须指向结构化字段 diversityApplied（读者据此判断本次是否施加了多样性）：${d}`)
  // 反向（区分力）：旧那句既不说施加条件、也不说不可复算，必须消失
  assert.ok(!d.includes('score 是含多样性惩罚的最终分'),
    `描述不得再出现旧的不成立表述「score 是含多样性惩罚的最终分」：${d}`)
})

test('#2 描述：无词法证据时 rel=0；仅图到达的记录 graph>0 / via=tag:<标签>；score 取决于标度常数（判红点：改回「无证据候选 rel/score 均为 0.0000」⇒ 本条变红）', () => {
  const d = recallDescription('graph-arrival')
  // 正向：把"无证据"限定到**词法**证据，并写清图到达那一行的三列实情
  assert.ok(d.includes('无**词法**证据时 rel=0'),
    `描述必须把"无证据"限定为无**词法**证据（图证据是另一种证据）：${d}`)
  assert.ok(d.includes('仅由标签图到达的记录 graph>0、via=tag:<标签>'),
    `描述必须写明仅由标签图到达的记录 graph>0、via=tag:<标签>：${d}`)
  assert.ok(d.includes('其 score 取决于标度常数（可能为 0 也可能 >0）'),
    `描述必须写明这种记录的 score 取决于标度常数（默认标度下为 0，但可能 >0）：${d}`)
  assert.ok(d.includes('match=none'),
    `描述必须写明无词法证据时 match=none：${d}`)
  // 反向（区分力）：旧那句宣称这种候选 rel/score **均为** 0.0000，与实测反例冲突，必须消失
  assert.ok(!d.includes('无证据候选 rel/score 均为 0.0000'),
    `描述不得再出现旧的不成立表述「无证据候选 rel/score 均为 0.0000」：${d}`)
})

test('#1 描述：graph / via 的列语义必须写明（判红点：删掉 graph/via 的解释 ⇒ 本条变红）', () => {
  const d = recallDescription('graph-via')
  // graph：辅助奖励 + 有硬上限 + 不压过词法相关度
  assert.ok(d.includes('graph 是标签图传播给的**辅助**奖励'),
    `描述必须写明 graph 是标签图传播给的辅助奖励：${d}`)
  assert.ok(d.includes('有硬上限 graphBonusCap'),
    `描述必须写明 graph 有硬上限（graphBonusCap）：${d}`)
  assert.ok(d.includes('不会压过词法相关度'),
    `描述必须写明 graph 不会压过词法相关度：${d}`)
  // via：direct 或 tag:<标签>
  assert.ok(d.includes('via 是该行来源：direct（词法直接命中）或 tag:<标签>（由该标签的图传播到达）'),
    `描述必须写明 via 的两种取值及含义：${d}`)
})
