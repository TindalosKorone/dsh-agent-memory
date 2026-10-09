// 交付证据（非测试）：量两处夹具的表头长度，用于确认「单行且 <= 400 字符」。
// 用法：node redproof/measure-header.mjs
import { freshHome, tools } from '../test/helpers.mjs'

// 夹具 A：header.test.mjs 第一段的 3 条记录 + query=alpha/limit=5
freshHome('measure-header-a')
{
  const defs = tools()
  const rem = defs.get('memory_remember')
  for (let i = 0; i < 3; i += 1) {
    await rem.execute({ kind: 'fact', title: `alpha beta note ${i}`, body: `alpha beta details ${i}`, tags: ['alpha', 'beta'], source: 'test:header' })
  }
  const r = await defs.get('memory_recall').execute({ query: 'alpha', limit: 5 })
  const h = r.text.split('\n')[0]
  console.log(`夹具A 表头长度=${h.length} 单行=${!h.includes('\n')}`)
  console.log(h)
  // 同一个夹具的未分诊分支（query 为纯空白，header.test 也盯着它 <= 400）
  const e = await defs.get('memory_recall').execute({ query: '   ', limit: 5 })
  const eh = e.text.split('\n')[0]
  console.log(`夹具A[未分诊] 表头长度=${eh.length} 单行=${!eh.includes('\n')}`)
  console.log(eh)
}

// 夹具 B：header.test.mjs 结构性断言的四组标度配置（记录 24 条、limit=20、maxHops=0）
freshHome('measure-header-b')
{
  const defs = tools()
  const rem = defs.get('memory_remember')
  const TITLE = `alpha dark theme note ${'q'.repeat(28)}`
  for (let i = 0; i < 24; i += 1) {
    await rem.execute({ kind: 'fact', title: TITLE, body: 'alpha dark theme body', tags: ['k1', 'k2'], source: 'test:header' })
  }
  const base = { graph: { maxHops: 0 } }
  const CONFIGS = [
    ['默认', base],
    ['scaleA=0/scaleB=0.45', { ...base, score: { scaleA: 0, scaleB: 0.45, weak: 0.06, strong: 0.16 } }],
    ['scaleB=1.2345', { ...base, score: { scaleA: 0.0187, scaleB: 1.2345, weak: 0.0363, strong: 0.1476 } }],
    ['scaleB 17 位小数', { ...base, score: { scaleA: 0.0187, scaleB: 0.12345678901234568, weak: 0.0363, strong: 0.1476 } }],
  ]
  for (const [label, cfg] of CONFIGS) {
    const r = await tools(cfg).get('memory_recall').execute({ query: 'alpha dark theme', limit: 20 })
    const h = r.text.split('\n')[0]
    console.log(`夹具B[${label}] 表头长度=${h.length} shown=${r.shown} truncated=${r.truncated}`)
  }
  const r = await tools(base).get('memory_recall').execute({ query: 'alpha dark theme', limit: 20 })
  console.log(r.text.split('\n')[0])
}
