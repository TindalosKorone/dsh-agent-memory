// 红证辅助（非测试）：把 src/pure.ts 里某一个常数改回旧值 —— **同时**改声明行与「落地值：」行，
// 好让「注释 ↔ 常数一致性」用例保持绿，从而**孤立**出该常数的边界红证是否真的判红。
// 用法：node redproof/i7e-revert-const.mjs <NAME> <旧值>      回退
//       node redproof/i7e-revert-const.mjs <NAME> <新值> --restore
import { readFileSync, writeFileSync } from 'node:fs'
const [name, value, mode] = process.argv.slice(2)
if (!name || !value) { console.error('用法：node redproof/i7e-revert-const.mjs <NAME> <value> [--restore]'); process.exit(2) }
const p = 'src/pure.ts'
let s = readFileSync(p, 'utf8')
const decl = new RegExp(`(export const ${name} = )[0-9.]+`)
const land = new RegExp(`(${name} = )[0-9.]+`)
if (!decl.test(s) || !land.test(s)) { console.error(`锚点缺失：${name}`); process.exit(3) }
s = s.replace(decl, `$1${value}`).replace(land, `$1${value}`)
writeFileSync(p, s)
console.log(`${mode === '--restore' ? '已恢复' : '已回退'} ${name} = ${value}`)
