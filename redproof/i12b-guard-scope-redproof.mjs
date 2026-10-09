/**
 * 用例 I12b 红证：`test/release.test.mjs` 第 ③ 条（入库面文件不得含机器前缀）的**口径红证**。
 *
 * 为什么要有这个脚本：该守卫原来是 `git ls-files`（只扫**已跟踪**集）⇒ 红证刚生成、还没
 * `git add` 时跑守卫是**绿的**；`git add` 之后同一条内容才变红。i8 → i10 → i12 三次都栽在
 * 这个时序陷阱上（红证天生会抄 AssertionError 的堆栈，堆栈里必然带本仓绝对路径）。
 * 口径已改成 `git ls-files --cached --others --exclude-standard`（已跟踪 ∪ 未跟踪但不被忽略）。
 *
 * 本脚本给两条红证，且都可重放（跑完自动恢复原状，不留脏工作区）：
 *   A. **未跟踪**（未被忽略）的文件里写一条机器前缀 ⇒ 守卫必须判红（新口径新增的能力）；
 *   B. **已跟踪**的文件里写一条机器前缀 ⇒ 守卫必须仍然判红（原有能力，不许丢）。
 * 另外校验：跑完 A/B 后工作区恢复原样（A 的探针文件已删、B 的文件 sha256 与备份一致）。
 *
 * 用法：node redproof/i12b-guard-scope-redproof.mjs
 * 退出码：0 = 两条红证都成立且已恢复；1 = 有断言不成立（会打印明细）。
 *
 * 自指注意：本文件自己就在扫描集里，所以机器前缀**拆字构造**，源码里不出现完整前缀。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const GUARD = 'test/release.test.mjs'

// 机器前缀拆字构造（本文件不会命中守卫的扫描针）
const SL = '/'
const MACHINE = `${SL}storage${SL}emulated${SL}0${SL}deepseek${SL}dsh-agent-memory${SL}test${SL}probe`

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

/** 跑守卫，返回 { code, out }；用逐文件直跑（本机 `node --test` 坏了）。
 *  两个本机坑：① 必须给**绝对路径**（相对路径报 `error: expected absolute path`）；
 *  ② 不能用 `process.execPath` —— 本机（Android）它指向 `/apex/com.android.runtime/bin/linker64`，
 *  拿它跑脚本会报 `bad ELF magic`；真实解释器路径在 `process.argv0`。 */
function runGuard() {
  const NODE = process.argv0 && process.argv0 !== '' ? process.argv0 : 'node'
  try {
    const out = execFileSync(NODE, [join(REPO, GUARD)], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/** 跑一条命令，返回 stdout（失败也把 stdout/stderr 拼回来，便于如实打印）。 */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
}

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` | ${detail}` : ''}`)
}

// ---------------------------------------------------------------- 基线：守卫当前是绿的
const base = runGuard()
console.log(`基线：${GUARD} exit=${base.code}（期望 0）`)
record('基线 守卫为绿', base.code === 0, `exit=${base.code}`)
if (base.code !== 0) console.log(base.out)

// ---------------------------------------------------------------- A. 未跟踪（未被忽略）文件必须判红
const probe = join(REPO, 'redproof', 'i12b-untracked-probe.tmp')
let probeSha = null
try {
  writeFileSync(probe, `未跟踪探针：${MACHINE}\n`, 'utf8')
  // 自证「未跟踪且未被忽略」：git 的入库面清单必须列到它，且索引里没有它
  const others = git(['ls-files', '--cached', '--others', '--exclude-standard', '--', 'redproof/i12b-untracked-probe.tmp'])
  const cached = git(['ls-files', '--cached', '--', 'redproof/i12b-untracked-probe.tmp'])
  const ignored = git(['check-ignore', '--', 'redproof/i12b-untracked-probe.tmp'])
  record('A0 探针确为「未跟踪且未被忽略」', others.includes('i12b-untracked-probe.tmp') && cached.trim() === '' && ignored.trim() === '',
    `入库面清单命中=${others.includes('i12b-untracked-probe.tmp')} 索引命中=${cached.trim() !== ''} 被忽略=${ignored.trim() !== ''}`)

  const a = runGuard()
  probeSha = sha256(probe)
  record('A 未跟踪文件必须判红', a.code !== 0, `exit=${a.code} 探针=${MACHINE}`)
  if (a.code === 0) console.log(a.out)
  else {
    const line = a.out.split('\n').find((l) => l.includes('i12b-untracked-probe.tmp'))
    console.log(`  守卫命中行：${line ?? '(未在输出里找到，仅凭退出码判定)'}`)
  }
} finally {
  if (existsSync(probe)) rmSync(probe)
}
record('A1 探针已删除（工作区恢复）', !existsSync(probe), `probeSha256=${probeSha ?? 'n/a'}`)

// ---------------------------------------------------------------- B. 已跟踪文件仍必须判红
const tracked = join(REPO, 'redproof', 'i12-measure.txt')
// 备份放系统临时目录：放仓内会成为「未跟踪且未被忽略」的第二个探针，污染那次判红的归因。
const backup = join(tmpdir(), 'i12b-i12-measure.txt.bak')
const beforeSha = sha256(tracked)
let redBSha = null
try {
  copyFileSync(tracked, backup)
  writeFileSync(tracked, `${readFileSync(tracked, 'utf8')}\n已跟踪探针：${MACHINE}\n`, 'utf8')
  redBSha = sha256(tracked)

  const b = runGuard()
  record('B 已跟踪文件仍必须判红', b.code !== 0, `exit=${b.code} 文件=redproof/i12-measure.txt`)
  if (b.code === 0) console.log(b.out)
} finally {
  if (existsSync(backup)) {
    copyFileSync(backup, tracked)
    rmSync(backup)
  }
}
const afterSha = sha256(tracked)
const diff = git(['diff', '--exit-code', '--', 'redproof/i12-measure.txt'])
record('B1 已跟踪文件已还原（sha256 一致）', beforeSha === afterSha && diff.trim() === '',
  `before=${beforeSha} after=${afterSha} git-diff=${diff.trim() === '' ? 'clean' : 'DIRTY'}`)

// ---------------------------------------------------------------- 尾声：守卫回到绿
const final = runGuard()
record('尾声 守卫恢复为绿', final.code === 0, `exit=${final.code}`)
if (final.code !== 0) console.log(final.out)

console.log('')
console.log(`恢复后哈希 | redproof/i12-measure.txt sha256=${afterSha}`)
console.log(`恢复后哈希 | 未跟踪探针已删除（sha256=${probeSha ?? 'n/a'}，作废）`)
console.log(`红证 B 探针写入时的 sha256=${redBSha ?? 'n/a'}（仅记录，已还原）`)

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`RESULT | cases=${results.length} | fail=${failed.length}`)
process.exit(failed.length === 0 ? 0 : 1)
