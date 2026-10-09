// 交付证据（非测试）：按分支回显后重测表头最坏长度（上界 HEADER_MAX_CHARS = 448）。
// 用法：node redproof/i10-header-measure.mjs
//
// 复刻 test/header.test.mjs 的两条最坏情况用例：
//   ① 240 字符边界查询（含 " / \ / 换行 / 制表 / NUL）—— 回显预算被撑满；
//   ② Number.MAX_VALUE / 负数极值常数 + 60 条库（库规模统计位宽 > 1）。
// 并额外量「不封顶支」的长查询（qTok >= 2 ⇒ 回显更短、echoBudget 更大，看总长是否仍 <= 448）。
import { HEADER_MAX_CHARS } from '../lib/index.js'
import { freshHome, tools } from '../test/helpers.mjs'

const LONG = 'x"\\\n\t\u0000'.repeat(40)
if (LONG.length !== 240) throw new Error(`夹具必须 240 字符，实际 ${LONG.length}`)

const results = []
function measure(label, header, branch) {
  results.push({ label, branch, len: header.length })
  console.log(`${label} [${branch}] 长度=${header.length} 单行=${!header.includes('\n')}`)
  console.log(`    ${header}`)
}

// ── 夹具①：3 条 alpha/beta 记录（与 header.test.mjs 最坏情况同形）──────────────
freshHome('i10-measure-worst-query')
{
  const defs = tools()
  const rem = defs.get('memory_remember')
  for (let i = 0; i < 3; i += 1) {
    await rem.execute({ kind: 'fact', title: `alpha beta note ${i}`, body: `alpha beta details ${i}`, tags: ['alpha', 'beta'], source: 'test:header' })
  }
  const r = await defs.get('memory_recall').execute({ query: LONG, limit: 5 })
  const h = r.text.split('\n')[0]
  const branch = r.contentTokens < r.contentTokenMin ? '封顶支' : '不封顶支'
  measure('① 240 字符边界查询 / 默认标度', h, `${branch} qTok=${r.contentTokens}`)
}

// ── 夹具②：60 条库 + 极值常数（与 header.test.mjs「固定部分」用例同形）──────────
freshHome('i10-measure-worst-fixed')
{
  const defs = tools()
  const rem = defs.get('memory_remember')
  for (let i = 0; i < 60; i += 1) {
    await rem.execute({ kind: 'fact', title: `alpha dark theme note ${i}`, body: 'alpha dark theme body', tags: ['alpha', 'beta'], source: 'test:header' })
  }
  const CONFIGS = [
    ['默认标度', {}],
    ['22 位小数 scaleB', { score: { scaleA: 0.0187, scaleB: 0.12345678901234568, weak: 0.0363, strong: 0.1476 } }],
    ['scaleA/scaleB = Number.MAX_VALUE', { score: { scaleA: Number.MAX_VALUE, scaleB: Number.MAX_VALUE, weak: 0.12345678901234568, strong: 0.1476 } }],
    ['负数极值', { score: { scaleA: -Number.MAX_VALUE, scaleB: -Number.MAX_VALUE, weak: 0.0363, strong: 0.1476 } }],
  ]
  // 不封顶支的长查询：alpha/beta 都在库内（qTok=2），再拼上 20 组边界字符把查询撑长。
  const LONG_FREE = 'alpha beta x"\\\n\t\u0000'.repeat(20)
  const queries = [
    ['240 字符边界查询(alpha 不在内 ⇒ 封顶支)', LONG],
    ['长边界查询 + alpha/beta(⇒ 不封顶支)', LONG_FREE],
    ['短查询 alpha(封顶支)', 'alpha'],
  ]
  for (const [label, cfg] of CONFIGS) {
    const recall = tools(cfg).get('memory_recall')
    for (const [qlabel, q] of queries) {
      const r = await recall.execute({ query: q, limit: 5 })
      const h = r.text.split('\n')[0]
      const branch = r.contentTokens < r.contentTokenMin ? '封顶支' : '不封顶支'
      measure(`② ${label} / ${qlabel}`, h, `${branch} qTok=${r.contentTokens}`)
    }
  }
}

const worst = results.reduce((a, b) => (b.len > a.len ? b : a))
const worstFree = results.filter((x) => x.branch.startsWith('不封顶支')).reduce((a, b) => (b.len > a.len ? b : a))
console.log('')
console.log(`HEADER_MAX_CHARS=${HEADER_MAX_CHARS}`)
console.log(`最坏情况实测（全部样本）: ${worst.len}  ← ${worst.label} [${worst.branch}]`)
console.log(`最坏情况实测（不封顶支）: ${worstFree.len}  ← ${worstFree.label} [${worstFree.branch}]`)
console.log(`结论: 最坏 ${worst.len} <= ${HEADER_MAX_CHARS} -> ${worst.len <= HEADER_MAX_CHARS ? 'PASS' : 'FAIL'}`)
if (worst.len > HEADER_MAX_CHARS) process.exitCode = 1
