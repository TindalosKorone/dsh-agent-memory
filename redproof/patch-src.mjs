// 红证辅助（非测试）：对 src/index.ts 做一次精确子串替换（找不到 / 多处命中即失败），
// 让「关掉某个机制」这一步可复现、可核对。用法：
//   node redproof/patch-src.mjs "<原串>" "<新串>"
import { readFileSync, writeFileSync } from 'node:fs'

const [from, to] = process.argv.slice(2)
if (typeof from !== 'string' || typeof to !== 'string' || from === '') {
  console.error('用法：node redproof/patch-src.mjs "<原串>" "<新串>"')
  process.exit(2)
}
const p = 'src/index.ts'
const src = readFileSync(p, 'utf8')
const hits = src.split(from).length - 1
if (hits !== 1) {
  console.error(`原串命中 ${hits} 处（必须恰好 1 处）：${from.slice(0, 80)}`)
  process.exit(3)
}
writeFileSync(p, src.replace(from, to))
console.log(`已替换 1 处：${from.slice(0, 60)} -> ${to.slice(0, 60)}`)
