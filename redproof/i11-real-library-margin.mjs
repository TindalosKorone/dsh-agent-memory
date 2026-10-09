// 交付证据（非测试，**只读**）：在真机真实记忆库上量「闸门例外」两侧的倍率。
// 用法：DSH_AGENT_MEMORY_REAL_HOME=<真库 DSH_HOME> node redproof/i11-real-library-margin.mjs
//
// 本次（⑤ 真回归）的病灶：纯 `qTok` 封顶会误杀「单个高专有词元」的真话题 ——
// 单内容词元也能把 rel 顶到远超 strong 阈值。本脚本对同一真库跑一组查询，打印
//   qTok / rel / rel÷strong / base(阈值判定) / gated(闸门判定)，并在前后各算一次库文件 sha256，
// 证明本次探针**没有写**真库。
//
// 注意（如实声明）：任务书点名的 `OpenSCAD` 在当前 205 条真库里 **0 命中**（grep 全库无该串），
// 所以这里改用同形态的真实词元 `adb`（qTok=1、rel=0.6557 = 4.35×strong）；
// 「单内容词元 + 远超阈值」这条形态在 test/scoring.test.mjs 里另有合成语料钉死。
//
// 输出脱敏：只打印 `$DSH_HOME` 占位符，不打印任何机器私有前缀（release.test 会扫描被跟踪文件）。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tools } from '../test/helpers.mjs'
import { STRONG_THRESHOLD } from '../lib/pure.js'

const HOME = process.env.DSH_AGENT_MEMORY_REAL_HOME && process.env.DSH_AGENT_MEMORY_REAL_HOME.trim() !== ''
  ? process.env.DSH_AGENT_MEMORY_REAL_HOME
  : join(homedir(), '.dsh')

const FILE = join(HOME, 'agent-memory', 'memory.ndjson')
const sha = () => createHash('sha256').update(readFileSync(FILE)).digest('hex')

const before = sha()
console.log('真库: $DSH_HOME/agent-memory/memory.ndjson（占位符，不打印机器路径）')
console.log(`写前 sha256: ${before}`)

const recall = tools({ home: HOME }).get('memory_recall')
// 真话题侧（单内容词元、远超阈值）+ 噪声侧（贴线）+ 多内容词元对照 + 库外词元
const QUERIES = ['adb', 'ok', '做', 'b', 'ci', 'OpenSCAD', '虚拟屏']
for (const query of QUERIES) {
  const r = await recall.execute({ query, limit: 3 })
  const header = r.text.split('\n')[0]
  const gate = /内容量[^;]*/.exec(header)?.[0] ?? '(none)'
  const top = r.rows[0]
  const rel = top === undefined ? 0 : top.rel
  console.log(`query=${JSON.stringify(query)} qTok=${r.contentTokens}/${r.contentTokenMin} rel=${rel.toFixed(4)} `
    + `倍率=${(rel / STRONG_THRESHOLD).toFixed(2)}x base=${rel >= r.strongThreshold ? 'strong' : rel >= r.weakThreshold ? 'weak' : 'none'} `
    + `gated=${top === undefined ? 'none' : top.match}`)
  console.log(`  表头闸门回显: ${gate}`)
}

const after = sha()
console.log(`写后 sha256: ${after}`)
console.log(`真库未被改动: ${before === after ? 'YES' : 'NO'}`)
