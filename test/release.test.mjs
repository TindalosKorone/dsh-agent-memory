// 用例 I7d：发布面回归（修正 3）。
//
// 三件事必须一直成立，否则这个仓要么发不出去、要么又把本机路径漏进公开仓：
//  ① `package.json` 不得有 `"private": true`；scoped 包还要 `publishConfig.access = "public"`
//     （否则 `npm publish` 会以 402 被拒 —— 发不出去）。
//  ② `peerDependencies` 必须是**语义化范围**而不是精确版本：精确版本会把宿主的 minor 升级挡在门外。
//  ③ 入库面文件（**已跟踪 + 未跟踪但不被忽略**）里不得再出现机器相关的应用私有前缀（清洗后为 0）。
//
// 判红点（都实测过）：
//  - 把 `"private": true` 加回去 ⇒ ① 变红；
//  - 把 cordis 的 peer 改回 `"4.0.4"` ⇒ ② 变红；
//  - 往任一入库面文件里写回一条机器路径 ⇒ ③ 变红（**未跟踪的新文件也算**，见下）。
//
// ③ 的扫描集为什么不是 `git ls-files`（**时序陷阱**，i8 → i10 → i12 复发三次）：
//  `git ls-files` 只列**已跟踪**文件 ⇒ 红证刚生成、还没 `git add` 时跑守卫是**绿的**；
//  一旦 `git add` 变成被跟踪，同一条内容立刻变红。而**红证天生会抄 AssertionError 的堆栈**，
//  堆栈里必然带本仓绝对路径 —— 于是「先跑绿、后 add 变红」反复漏检。
//  现口径改用 `git ls-files --cached --others --exclude-standard`：已跟踪 ∪ 未跟踪且未被忽略，
//  新文件**当场**就判红，不必等 `git add`。被忽略的 `.tmp-test/`、`node_modules/`、`*.log` 不进来。
//
// 关于**自指**：本文件要检查「有没有机器路径」，如果它自己原样写下那些前缀，它就会命中自己。
// 所以下面所有针（prefixes / app id）都是**拆字拼出来**的，源码里不含任何完整前缀。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))

test('修正 3：package.json 的发布面（private / peerDependencies 范围 / publishConfig / files）', () => {
  // ① 不再 private
  assert.notEqual(pkg.private, true,
    'package.json 不得是 private:true —— 那样 npm 渠道永远发不出去（误发风险见 docs/limitations.md）')
  // scoped 包（@scope/name）默认是受限访问，发布必须显式声明 public
  assert.equal(pkg.publishConfig?.access, 'public',
    'scoped 包的 publishConfig.access 必须是 "public"，否则 npm publish 以 402 被拒')

  // ② peerDependencies 必须是范围，不是精确版本
  const EXACT = /^=?v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
  const peers = Object.entries(pkg.peerDependencies ?? {})
  assert.ok(peers.length > 0, 'peerDependencies 不得为空（cordis / dsh-tools 是宿主提供的）')
  for (const [name, range] of peers) {
    assert.equal(typeof range, 'string', `peerDependencies.${name} 必须是字符串`)
    assert.ok(range.trim() !== '', `peerDependencies.${name} 不得为空串`)
    assert.ok(!EXACT.test(range.trim()),
      `peerDependencies.${name} 不得是精确版本（宿主会被挡在门外）：${range}`)
  }

  // 零运行时依赖是设计主张，别被顺手加回来的 dependencies 破坏
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [],
    '运行时依赖必须为空（零依赖是设计主张）')

  // ③ 工具描述把口径指向 docs/recall-contract.md ⇒ 发布出去的包里必须有它，否则指针指向空气
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes('docs/recall-contract.md'),
    'files 必须包含 docs/recall-contract.md（memory_recall 的描述指向它）')
})

test('修正 3：入库面文件（已跟踪 + 未跟踪但不被忽略）里不得再有机器相关的应用私有前缀（判红点：往任一入库面文件写回一条路径 ⇒ 本条变红）', () => {
  // 拆字构造：源码里不出现完整前缀，所以本文件不会命中自己。
  const S = '/'
  const D = `${S}data`
  const ST = `${S}storage`
  const PREFIXES = [
    `${D}${S}user${S}0${S}`,
    `${D}${S}data${S}`,
    `${ST}${S}emulated${S}0${S}`,
  ]
  // 机器相关的应用 id 也一并扫（前缀可能被别的写法绕过，id 不会）
  const APP_ID = ['com', 'dsharnessmobile', 'shell'].join('.')
  const TERMUX_ID = ['com', 'termux'].join('.')
  const NEEDLES = [...PREFIXES, APP_ID, TERMUX_ID]

  let files
  try {
    // `--cached` = 已跟踪；`--others --exclude-standard` = 未跟踪但不被忽略。
    // 两者取并集：新生成、还没 `git add` 的文件**当场**就进扫描集（时序陷阱的治本点）。
    files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: REPO, encoding: 'utf8' })
      .split('\n').filter((x) => x !== '')
  } catch {
    // 非 git 检出（例如从 npm tarball 里跑测试）⇒ 如实降级：跳过扫描，不假装扫过。
    console.log('release.test: 无 git 检出处，跳过「入库面文件路径扫描」这一半（如实降级）')
    return
  }
  assert.ok(files.length > 100, `入库面（已跟踪 ∪ 未跟踪但不被忽略）至少应列出上百个文件，实际 ${files.length}`)

  const hits = []
  for (const f of files) {
    let text
    try {
      const buf = readFileSync(join(REPO, f))
      if (buf.includes(0)) continue // 二进制跳过
      text = buf.toString('utf8')
    } catch {
      continue
    }
    for (const needle of NEEDLES) {
      if (text.includes(needle)) {
        const n = text.split(needle).length - 1
        hits.push(`${f}: 含机器相关字样 ${n} 处`)
        break
      }
    }
  }
  assert.deepEqual(hits, [],
    `入库面文件（已跟踪 + 未跟踪但不被忽略）里不得再有机器相关前缀/应用 id（规范化后应为 0 个文件）：\n${hits.join('\n')}`)
})
