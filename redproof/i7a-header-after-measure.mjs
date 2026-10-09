import { freshHome, tools } from '../test/helpers.mjs'
import { HEADER_MAX_CHARS } from '../lib/index.js'
freshHome('i7b-probe')
const defs = tools()
const rem = defs.get('memory_remember')
for (let i = 0; i < 3; i += 1) {
  await rem.execute({ kind: 'fact', title: `alpha beta note ${i}`, body: `alpha beta details ${i}`, tags: ['alpha', 'beta'], source: 'test:header' })
}
const recall = defs.get('memory_recall')
const cases = [
  ['短 alpha', 'alpha'],
  ['恰好 12', 'a'.repeat(12)],
  ['200 含边界', 'x"\\\n'.repeat(50)],
  ['500 含控制字符/CJK/emoji', ('中"\\\n\t\u0000q😀'.repeat(60)).slice(0, 500)],
]
for (const [label, q] of cases) {
  const r = await recall.execute({ query: q, limit: 5 })
  const h = r.text.split('\n')[0]
  console.log(`${label}: q.len=${q.length} header.len=${h.length} <=${HEADER_MAX_CHARS}=${h.length <= HEADER_MAX_CHARS} 单行=${!h.includes('\n')} 截断标记=${h.includes('…(截断)')}`)
}
// 宽常数配置
const CONFIGS = [
  ['17位scaleB', { score: { scaleA: 0.0187, scaleB: 0.12345678901234568, weak: 0.0363, strong: 0.1476 } }],
  ['MAX_VALUE', { score: { scaleA: Number.MAX_VALUE, scaleB: Number.MAX_VALUE, weak: 0.12345678901234568, strong: 0.1476 } }],
  ['负数极值', { score: { scaleA: -Number.MAX_VALUE, scaleB: -Number.MAX_VALUE, weak: 0.0363, strong: 0.1476 } }],
]
for (const [label, cfg] of CONFIGS) {
  const rc = tools(cfg).get('memory_recall')
  for (const q of ['alpha', 'x"\\\n'.repeat(50)]) {
    const r = await rc.execute({ query: q, limit: 5 })
    const h = r.text.split('\n')[0]
    console.log(`${label} q.len=${q.length}: header.len=${h.length} <=${HEADER_MAX_CHARS}=${h.length <= HEADER_MAX_CHARS} 单行=${!h.includes('\n')}`)
  }
  const r0 = await rc.execute({ query: 'alpha', limit: 5 })
  console.log(`  ${label} 常数段: ${r0.text.split('\n')[0].slice(0, 200)}`)
}
