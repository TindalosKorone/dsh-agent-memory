// 交付证据（非测试）：I4a.4 只改了稳定段文案，这里量三处**不该被它影响**的数：
//   ① memory_recall 工具描述字符数（硬上限 300；改动前 266）；
//   ② L1 表头最坏长度（硬上界 HEADER_MAX_CHARS=448；两条最坏情况夹具取最大值）；
//   ③ 稳定段文案字符数（改动前 56，改动后见输出）。
// 用法：node redproof/i12-measure.mjs
import { HEADER_MAX_CHARS } from '../lib/index.js'
import { INJECTION_HABIT_TEXT } from '../lib/inject.js'
import { freshHome, tools } from '../test/helpers.mjs'

console.log(`稳定段文案字符数 = ${INJECTION_HABIT_TEXT.length}（改动前 56）`)
console.log(`稳定段文案 = ${INJECTION_HABIT_TEXT}`)

// ① 描述：与 test/description.test.mjs 同一取法
freshHome('i12-measure-desc')
const desc = tools().get('memory_recall').description
console.log(`memory_recall 描述字符数 = ${desc.length}（硬上限 300，改动前 266）`)
console.log(`memory_recall 描述 = ${desc}`)

// ② 表头最坏长度：两条最坏情况夹具，取全场景最大值（两条都由 test/header.test.mjs 钉 <= HEADER_MAX_CHARS）
let worst = 0
let worstLabel = ''
function note(label, header) {
  if (header.length > worst) { worst = header.length; worstLabel = label }
}

// 夹具 A：>=200 字符且含引号/反斜杠/换行/制表/NUL 的查询（转义膨胀最坏）
{
  freshHome('i12-measure-worst-query')
  const defs = tools()
  const rem = defs.get('memory_remember')
  for (let i = 0; i < 3; i += 1) {
    await rem.execute({ kind: 'fact', title: `alpha beta note ${i}`, body: `alpha beta details ${i}`, tags: ['alpha', 'beta'], source: 'test:header' })
  }
  const LONG = 'x"\\\n\t\u0000'.repeat(40)
  const r = await defs.get('memory_recall').execute({ query: LONG, limit: 5 })
  const h = r.text.split('\n')[0]
  console.log(`夹具A[最坏查询 ${LONG.length} 字符] 表头长度=${h.length}`)
  note('最坏查询', h)
}

// 夹具 B：60 条同形记录 + 最宽常数回显（22 位小数 / Number.MAX_VALUE / 负数极值）
{
  freshHome('i12-measure-worst-fixed')
  const rem = tools().get('memory_remember')
  for (let i = 0; i < 60; i += 1) {
    await rem.execute({ kind: 'fact', title: `alpha dark theme note ${i}`, body: 'alpha dark theme body', tags: ['alpha', 'beta'], source: 'test:header' })
  }
  const CONFIGS = [
    ['默认标度', {}],
    ['22 位小数 scaleB', { score: { scaleA: 0.0187, scaleB: 0.12345678901234568, weak: 0.0363, strong: 0.1476 } }],
    ['scaleA/scaleB = Number.MAX_VALUE', { score: { scaleA: Number.MAX_VALUE, scaleB: Number.MAX_VALUE, weak: 0.12345678901234568, strong: 0.1476 } }],
    ['负数极值', { score: { scaleA: -Number.MAX_VALUE, scaleB: -Number.MAX_VALUE, weak: 0.0363, strong: 0.1476 } }],
  ]
  const queries = [['短查询 alpha', 'alpha'], ['超长边界查询', 'x"\\\n\t\u0000'.repeat(40)]]
  for (const [label, cfg] of CONFIGS) {
    for (const [qlabel, q] of queries) {
      const r = await tools(cfg).get('memory_recall').execute({ query: q, limit: 5 })
      const h = r.text.split('\n')[0]
      console.log(`夹具B[${label} / ${qlabel}] 表头长度=${h.length}`)
      note(`${label} / ${qlabel}`, h)
    }
  }
}

console.log(`表头最坏长度 = ${worst}（场景：${worstLabel}；硬上界 HEADER_MAX_CHARS=${HEADER_MAX_CHARS}）`)
console.log(worst <= HEADER_MAX_CHARS ? `结论：${worst} <= ${HEADER_MAX_CHARS}，未被本次改动影响` : `结论：超界！`)
