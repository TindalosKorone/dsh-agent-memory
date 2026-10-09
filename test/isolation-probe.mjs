// 请求级隔离红证的「单独只跑第二次」基线（**不是 .test.mjs**，所以不会被逐文件测试命令当成用例）。
//
// 用法：node test/isolation-probe.mjs "<query>" <limit> [graph]
//   - 不带第三个参数：只输出分诊字段 + 行 id（I2 红证 3 用的**原始字段集**，
//     多一个键都会让那边的 deepEqual 变红，所以这里是默认口径）；
//   - 第三个参数为 graph：追加 I3 的图/传播字段（graph 红证用的扩展字段集）。
// DSH_HOME 由调用方经 env 传入。
//
// 为什么要另起进程：请求级隔离的红证补丁是「把金字塔/图的中间状态提到模块级并在两次调用间复用」，
// 那种补丁一旦生效，同进程里**先前任何一次查询**都会污染后续查询 —— 在同一进程内比较
// 「先跑 A 再跑 B」与「只跑 B」会双双被污染而看不出差别（假绿）。只有新进程的模块初始
// 状态才是真正干净的，这才是需求里说的「单独只跑第二次」。
import { tools } from './helpers.mjs'

const query = process.argv[2] ?? ''
const limit = Number(process.argv[3] ?? '3')
const wantGraph = process.argv[4] === 'graph'
const defs = tools()
const r = await defs.get('memory_recall').execute({ query, limit })
const out = {
  expanded: r.expanded,
  kBase: r.kBase,
  kUsed: r.kUsed,
  novelty: r.novelty,
  explainedRatio: r.explainedRatio,
  residualRatio: r.residualRatio,
  basisSize: r.basisSize,
  layers: r.layers,
  logicalDepth: r.logicalDepth,
  lowConfidence: r.lowConfidence,
  covMax: r.covMax,
  shown: r.shown,
  rowIds: r.rows.map((row) => row.id),
}
if (wantGraph) {
  // I3：图/传播的请求级字段（同样必须与「单独只跑第二次」逐字段一致）。
  // 少了这些字段，I3 的图字段就算被提到模块级复用，本探针也看不出来（那会是假绿）。
  out.graphNodes = r.graphNodes
  out.graphEdges = r.graphEdges
  out.propagatedTags = r.propagatedTags
  out.maxHops = r.maxHops
  out.maxStates = r.maxStates
  out.maxFieldNeighbors = r.maxFieldNeighbors
  out.graphBonusCap = r.graphBonusCap
  out.hubSuppressed = r.hubSuppressed
  out.reachable = r.reachable
  out.graphSeedCount = r.graphSeedCount
  out.graphStatesUsed = r.graphStatesUsed
  out.graphHops = r.graphHops
  out.graphStatesTruncated = r.graphStatesTruncated
  out.graphEvidence = r.graphEvidence
  out.rowGraph = r.rows.map((row) => row.graph)
  out.rowVia = r.rows.map((row) => row.via)
}
process.stdout.write(JSON.stringify(out))
