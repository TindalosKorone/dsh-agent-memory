// 表头草稿长度试算（非测试）：在同一批常数下试不同措辞，找 <= 400 的最短可行组合。
const RECALL_COLUMNS = ['id', 'kind', 'title', 'tags', 'graph', 'via', 'rel', 'cov', 'match', 'score']
const C = {
  scaleA: 0.0187, scaleB: 0.342, weak: 0.0363, strong: 0.1476,
  noveltyThreshold: 0.5, activationThreshold: 0.05, bonusCap: 0.018,
  nodes: 2, edges: 1, hub: 0, reachable: 0, records: 3, fused: 3, limit: 5,
}

// 候选变体（每段给几个版本，打印总长）
const segs = {
  headA: [`记忆召回L1:query="alpha" 库3 候选3;`, `记忆召回L1:query="alpha" 候选3;`, `L1:query="alpha" 候选3;`, `L1:query="alpha";`],
  limit: [`limit=5 是硬显示上限;`],
  cols: [`列序:${RECALL_COLUMNS.join('|')};`],
  rel: [`rel=BM25原始相关度,match 依据;`, `rel=BM25原始相关度,match 依据(恒可复算);`, `rel=BM25原始相关度,match 依据(恒可由 rel+阈值复算);`, `rel=BM25原始相关度,match 恒可复算;`],
  score: [`score=disp(final)=clip((final-0.0187)/(0.342-0.0187));`],
  match: [`match:rel>=0.0363 weak、>=0.1476 strong、否则 none;`, `rel>=0.0363 weak、>=0.1476 strong、否则 none;`],
  i2: [`I2:novelty=0.6500 >= 阈值 0.5,expanded=true，kBase=5 -> kUsed=3`],
  i2no: [`I2:未分诊(‖q‖²≈0):novelty=0.0000,阈值 0.5 不门控,expanded=false,kBase=5 -> kUsed=3,0/0`,
    `I2:未分诊:novelty=0,阈值不门控,expanded=false,kBase=5 -> kUsed=3,0/0`,
    `I2:未分诊(‖q‖²≈0):novelty=0,阈值 0.5不门控,expanded=false,kBase=5 -> kUsed=3,0/0`],
  low: [`非低置信:cov_max=0.5000 >= 0.05;`],
  i3: [
    `I3:final=rel+graph，graph硬上限<=0.018，图2节点/1边，枢纽被压0，reachable=0`,
    `I3:final=rel+graph×多样性(候选>5时启用;开时 score 不可由 rel/graph 复算)，graph硬上限<=0.018，图2节点/1边，枢纽被压0，reachable=0`,
    `I3:final=rel+graph×多样性(候选>5时启用,开时 score 不可由 rel/graph 复算)，graph硬上限<=0.018，图2节点/1边，枢纽被压0，reachable=0`,
    `I3:final=rel+graph×多样性(候选>5时启用,开时不可由 rel/graph 复算)，graph硬上限<=0.018，图2节点/1边，枢纽被压0，reachable=0`,
    `I3:final=rel+graph×多样性(仅候选>5,开时不可由 rel/graph 复算)，graph硬上限<=0.018，图2节点/1边，枢纽被压0，reachable=0`,
  ],
}
for (const k of Object.keys(segs)) segs[k].forEach((s, i) => console.log(`${k}[${i}] len=${s.length}  ${s}`))
console.log('--- 组合试算 ---')
const build = (h, r, m, i2, i2no, i3) => ({
  normal: [h, segs.limit[0], segs.cols[0], r, segs.score[0], m, i2 + ';', segs.low[0], i3].join('').length,
  noQuery: [h, segs.limit[0], segs.cols[0], r, segs.score[0], m, i2no + ';', segs.low[0], i3].join('').length,
})
const combos = [
  ['A: 全保留(记忆召回/库/候选) + match: + desc/恒可复算 + i3[2]',
    build(segs.headA[0], segs.rel[1], segs.match[0], segs.i2[0], segs.i2no[0], segs.i3[2])],
  ['B: 去库 + rel(恒可由 rel+阈值复算) + match: + i3[3](无 score 字)',
    build(segs.headA[1], segs.rel[2], segs.match[0], segs.i2[0], segs.i2no[1], segs.i3[3])],
  ['C: 去记忆召回前缀与库 + rel(恒可由) + 去 match: + i3[2]',
    build(segs.headA[2], segs.rel[2], segs.match[1], segs.i2[0], segs.i2no[1], segs.i3[2])],
  ['D: C 且 i3[3]',
    build(segs.headA[2], segs.rel[2], segs.match[1], segs.i2[0], segs.i2no[1], segs.i3[3])],
  ['E: D 且 headA[3](连候选也去)',
    build(segs.headA[3], segs.rel[2], segs.match[1], segs.i2[0], segs.i2no[1], segs.i3[3])],
  ['F: C 但 rel 用 i1(恒可复算) 且保留库/候选? -> headA[1]',
    build(segs.headA[1], segs.rel[1], segs.match[1], segs.i2[0], segs.i2no[2], segs.i3[3])],
]
for (const [label, x] of combos) console.log(`${label}\n   normal=${x.normal} noQuery=${x.noQuery}  ${x.normal <= 400 && x.noQuery <= 400 ? 'OK' : '超'}`)
