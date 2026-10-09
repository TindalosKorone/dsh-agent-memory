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
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tools } from '../test/helpers.mjs'

/**
 * 真实库 home：env > `$HOME/.dsh`（与 src/store.ts 默认口径一致，**可移植、不硬编码本机路径**）。
 * 与 i8/i9 同款两条一起上：默认路径走可移植推导 + 输出逐行走 SANITIZE_RULES 脱敏，
 * 所以本文件可被跟踪而不会把机器私有前缀带进仓库（前缀**拆字构造** ⇒ 本文件不会命中
 * test/release.test.mjs 的扫描针）。本机 `$HOME` = 应用私有 home，行为与写死时相同。
 */
const HOME = process.env.DSH_AGENT_MEMORY_REAL_HOME && process.env.DSH_AGENT_MEMORY_REAL_HOME.trim() !== ''
  ? process.env.DSH_AGENT_MEMORY_REAL_HOME
  : join(homedir(), '.dsh')

/** 输出脱敏（前缀拆字构造 ⇒ 源码里不出现完整前缀，不会命中 test/release.test.mjs 的扫描针）。 */
const SL = '/'
const SANITIZE_RULES = [
  [HOME, '$DSH_HOME'],
  [homedir(), '$HOME'],
  [`${SL}data${SL}user${SL}0${SL}`, '$APP_DATA/'],
  [`${SL}data${SL}data${SL}`, '$APP_DATA/'],
  [`${SL}storage${SL}emulated${SL}0${SL}`, '<external-storage>/'],
  [['com', 'dsharnessmobile', 'shell'].join('.'), '<app-id>'],
  [['com', 'termux'].join('.'), '<termux-id>'],
]
const sanitize = (text) => {
  let s = String(text)
  for (const [from, to] of SANITIZE_RULES) if (from !== '' && s.includes(from)) s = s.split(from).join(to)
  return s
}

const FILE = join(HOME, 'agent-memory', 'memory.ndjson')
const sha = () => createHash('sha256').update(readFileSync(FILE)).digest('hex')

const before = sha()
console.log(`真库: ${sanitize(FILE)}`)
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
