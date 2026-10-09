// 量 4 个工具描述的长度（修正 2 的前后对照）。
import { freshHome, tools } from '../test/helpers.mjs'
freshHome('i7c-desc-lengths')
const defs = tools()
for (const name of ['memory_remember', 'memory_recall', 'memory_expand', 'memory_prune']) {
  const d = defs.get(name)
  console.log(`${name}: ${d.description.length} 字符`)
}
const r = defs.get('memory_recall')
console.log('---')
console.log(`memory_recall 描述全文（${r.description.length} 字符）：`)
console.log(r.description)
