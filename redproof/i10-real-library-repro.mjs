// 交付证据（非测试，**只读**）：在真机真实记忆库上复现本次缺陷的两支回显。
// 用法：DSH_AGENT_MEMORY_REAL_HOME=<真库 DSH_HOME> node redproof/i10-real-library-repro.mjs
//
// 真机缺陷（修复前）：`memory_recall` 的表头**无条件**打印
//   `内容量qTok=<N><2⇒strong封顶weak`
// 于是 query=`虚拟屏`（qTok=5）打出 `qTok=5<2` 这种假不等式，且该行判的是 strong（根本没封顶）。
// 本脚本对同一真库跑 `ok`（qTok=1，封顶支）与 `虚拟屏`（qTok=5，不封顶支），只打印表头首行，
// 并在前后各算一次库文件 sha256，证明本次探针**没有写**真库。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tools } from '../test/helpers.mjs'

const HOME = process.env.DSH_AGENT_MEMORY_REAL_HOME ?? '/data/data/com.dsharnessmobile.shell/files/home/.dsh'
const FILE = join(HOME, 'agent-memory', 'memory.ndjson')
const sha = () => createHash('sha256').update(readFileSync(FILE)).digest('hex')

const before = sha()
console.log(`真库: ${FILE}`)
console.log(`写前 sha256: ${before}`)

const recall = tools({ home: HOME }).get('memory_recall')
for (const query of ['ok', '虚拟屏']) {
  const r = await recall.execute({ query, limit: 5 })
  const header = r.text.split('\n')[0]
  const branch = r.contentTokens < r.contentTokenMin ? '封顶支' : '不封顶支'
  const strong = r.rows.filter((row) => row.match === 'strong').length
  console.log('')
  console.log(`query=${query} 库容=${r.total} qTok=${r.contentTokens}/${r.contentTokenMin} => ${branch}，strong 行数=${strong}`)
  console.log(`表头: ${header}`)
}

const after = sha()
console.log('')
console.log(`写后 sha256: ${after}`)
console.log(`真库未被改动: ${before === after ? 'YES' : 'NO'}`)
if (before !== after) process.exitCode = 1
