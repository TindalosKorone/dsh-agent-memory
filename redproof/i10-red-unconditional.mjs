// 红证（可重放）：把表头回显改回**无条件样板**，验证「不封顶支」的断言真的变红，然后恢复。
// 用法：node redproof/i10-red-unconditional.mjs
//
// 关掉的东西：src/index.ts 里按分支给的 gateEcho ⇒ 改回修复前的无条件样板
//   `内容量qTok=<N><<min>⇒strong封顶weak`
// 期望：封顶支断言仍绿，**不封顶支**断言红（# 1：表头不含「封顶」字样）。
// 恢复后打印 src/index.ts 与 lib/index.js 的 sha256，供与修复版对照。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = join(ROOT, 'src', 'index.ts')
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

const FIXED = [
  '      const gateEcho = contentTokens < scoreCfg.contentTokenMin',
  '        ? `内容量qTok=${contentTokens}<${scoreCfg.contentTokenMin}⇒strong封顶weak`',
  '        : `内容量qTok=${contentTokens}≥${scoreCfg.contentTokenMin}⇒闸门未生效`',
].join('\n')
const BROKEN = '      const gateEcho = `内容量qTok=${contentTokens}<${scoreCfg.contentTokenMin}⇒strong封顶weak`'

const original = readFileSync(SRC, 'utf8')
if (!original.includes(FIXED)) throw new Error('src/index.ts 里找不到修复版的两分支 gateEcho，红证中止')

const build = () => execFileSync('node', ['node_modules/typescript/bin/tsc', '-p', '.'], { cwd: ROOT, stdio: 'pipe' })
const run = (file) => {
  try {
    const out = execFileSync('node', [file], { cwd: ROOT, stdio: 'pipe' }).toString()
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}
const summary = (out) => {
  const fails = out.split('\n').filter((l) => l.trim().startsWith('✖'))
  const counts = out.split('\n').filter((l) => /^ℹ (pass|fail) /.test(l))
  return { fails, counts }
}

try {
  console.log('== 修复版哈希（红证前）==')
  console.log(`src/index.ts  ${sha(SRC)}`)
  console.log(`lib/index.js   ${sha(join(ROOT, 'lib', 'index.js'))}`)

  console.log('')
  console.log('== 关掉按分支回显（改回无条件样板）并重建 ==')
  writeFileSync(SRC, original.replace(FIXED, BROKEN), 'utf8')
  build()
  console.log(`已关；lib/index.js ${sha(join(ROOT, 'lib', 'index.js'))}`)

  console.log('')
  console.log('== 判红实测 ==')
  for (const f of ['test/scoring.test.mjs', 'test/header.test.mjs']) {
    const r = run(f)
    const s = summary(r.out)
    console.log(`--- ${f} exit=${r.code}`)
    console.log(s.counts.join(' | '))
    for (const line of s.fails) console.log(line.slice(0, 200))
    const detail = r.out.split('\n').filter((l) => /内容量qTok|不封顶支|闸门未生效/.test(l))
    for (const line of detail.slice(0, 8)) console.log(`    ${line.trim().slice(0, 200)}`)
  }
} finally {
  console.log('')
  console.log('== 恢复修复版并重建 ==')
  writeFileSync(SRC, original, 'utf8')
  build()
  console.log(`src/index.ts  ${sha(SRC)}`)
  console.log(`lib/index.js   ${sha(join(ROOT, 'lib', 'index.js'))}`)
}
