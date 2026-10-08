// 请求级隔离红证的「单独只跑第二次」基线（**不是 .test.mjs**，所以不会被逐文件测试命令当成用例）。
//
// 用法：node test/isolation-probe.mjs "<query>" <limit>      DSH_HOME 由调用方经 env 传入。
// 作用：在一个**全新进程**里只调用一次 memory_recall，把分诊字段与行 id 打成一行 JSON。
//
// 为什么要另起进程：请求级隔离的红证补丁是「把金字塔状态提到模块级并在两次调用间复用」，
// 那种补丁一旦生效，同进程里**先前任何一次查询**都会污染后续查询 —— 在同一进程内比较
// 「先跑 A 再跑 B」与「只跑 B」会双双被污染而看不出差别（假绿）。只有新进程的模块初始
// 状态才是真正干净的，这才是需求里说的「单独只跑第二次」。
import { tools } from './helpers.mjs'

const query = process.argv[2] ?? ''
const limit = Number(process.argv[3] ?? '3')
const defs = tools()
const r = await defs.get('memory_recall').execute({ query, limit })
process.stdout.write(JSON.stringify({
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
}))
