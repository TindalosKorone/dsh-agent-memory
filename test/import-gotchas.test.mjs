// 语料导入器 scripts/import-gotchas.mjs 的用例（全部写入 .tmp-test/，绝不碰真实记忆库）。
// 覆盖：条目解析（含标题内含 **加粗**、超长标题断句、尾部括号两种形态、无子块、缺号、
//       正文里的列表项不误判）、真实协议失败关闭（短标题被拒且不改写）、dry-run 零副作用、
//       写入 + 备份 + 幂等、同一输入 tags 确定性（两次 dry-run 输出逐字节一致）、异常输入非 0 退出。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_DIR } from './helpers.mjs'

// 本机 process.execPath 是 linker64（坑 248）：spawn node 一律用 process.argv0。
const NODE_BIN = process.argv0 !== '' && existsSync(process.argv0) ? process.argv0 : process.execPath
const SCRIPT = join(PLUGIN_DIR, 'scripts', 'import-gotchas.mjs')
const TMP = join(PLUGIN_DIR, '.tmp-test', 'import-gotchas')
const SRC = join(TMP, 'fixture-gotchas.md')
const HOME = join(TMP, 'home')

/** 超长标题（>120 字符）且带 `⇒` 分隔符：派生规则应在分隔符处断句。 */
const LONG_PREFIX = '超长标题前缀用于检验断句规则是否恰好在分隔符处截断并且整条标题的字符数必须越过一百二十的上限这条要求不能省'
const LONG_TAIL = '这一段是标题的后半段它必须足够长才能确保整条标题越过上限从而强制派生规则截断同时它又必须原样出现在 body 的标题原文首行里一个字都不能丢'
const LONG = `${LONG_PREFIX}⇒${LONG_TAIL}`
assert.ok(LONG.length > 120, 'fixture 自检：超长标题必须真的超过 120 字符，否则本用例测不到断句')

const FIXTURE = [
  '# fixture：语料导入器测试',
  '',
  '1. **realpath 前缀混用（B7）**：正文一。',
  '    **现象**：子块一。',
  '',
  '    定位方法论：',
  '    1. `Runtime.consoleAPICalled` 事件**必须先发 `Runtime.enable`** 才投递。',
  '    2. 设备侧 python 插桩。',
  '',
  '2. **标题内部有**加粗**的条目**：正文二，收尾标记必须取外层那一个。',
  '',
  `3. **${LONG}**：正文三。`,
  '',
  '4. **尾部括号无冒号的标题**（2026-01-01，已修）',
  '    续行正文四。',
  '',
  '5. **签名一致性**：标题只有 5 个字符，必须被真实协议拒（失败关闭）。',
  '',
  '6. **重复标题条目用于去重**：第一次出现。',
  '',
  '7. **重复标题条目用于去重**：第二次出现，应计入「跳过（本批重复）」。',
  '',
  '8. **尾部括号后跟冒号的标题**（2026-01-02）：正文五。',
  '',
  '99. **无子块的条目也要够长**：只有一行正文，中间编号 9..98 缺失不是错误。',
  '',
].join('\n')

const SEED = `${JSON.stringify({
  id: 'mem_seed_import', ts: 1, kind: 'lesson', title: '播种记录用于备份与总数断言',
  body: '播种正文', tags: ['seed'], source: 'file:dsh-mobile-apk/docs/AGENTS/gotchas.md#1', hits: 0,
})}\n`

/** seed=false：home 目录存在但没有库（拿来验证 dry-run 零副作用 / 异常输入不建库）。 */
function reset(seed) {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true })
  writeFileSync(SRC, FIXTURE, 'utf8')
  if (seed) {
    mkdirSync(join(HOME, 'agent-memory'), { recursive: true })
    writeFileSync(memFile(), SEED, 'utf8')
  }
}

const memFile = () => join(HOME, 'agent-memory', 'memory.ndjson')

/** 跑导入器（DSH_HOME 与 --home 同时指向临时 home，双重保证不会碰真实库）。 */
function runCli(args) {
  try {
    const stdout = execFileSync(NODE_BIN, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: HOME },
    })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    return { status: err.status ?? -1, stdout: `${err.stdout ?? ''}`, stderr: `${err.stderr ?? ''}` }
  }
}

const dry = () => runCli(['--source', SRC, '--home', HOME])
const write = () => runCli(['--source', SRC, '--home', HOME, '--write'])

test('解析：识别全部 9 条（含内部加粗/超长/尾部括号两种/无子块/缺号），正文里的列表项不算条目', () => {
  reset(false)
  const r = dry()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /解析到条目：9 条（编号范围 1\.\.99/)
  // 正文里的 `1. \`Runtime...\`` 若被误判成条目，条数会变成 11、判据分布也会变
  assert.match(r.stdout, /标题收尾判据：A（紧跟冒号）7 条 \/ B（括号说明后跟冒号）1 条 \/ F（取最后一个标记：整行标题或尾部括号）1 条/)
  // 正文覆盖自证：fixture 里标题行之后的行不许丢
  assert.match(r.stdout, /正文覆盖自证：标题行之后的源文件行 \d+ 行，全部原样进入 body（缺失 0 行）/)
})

test('映射：被拒清单给可读原因（短标题失败关闭，绝不静默改写）', () => {
  reset(false)
  const r = dry()
  assert.match(r.stdout, /- 被拒：1 条/)
  assert.match(r.stdout, /- #5 \[title-too-short\]/)
  assert.match(r.stdout, /- 跳过：1 条（已存在 0 \/ 已存在出处 0 \/ 本批重复 1）/)
  assert.match(r.stdout, /- #7 \[本批重复\] 重复标题条目用于去重/)
  assert.match(r.stdout, /- 接受：7 条/)
})

test('dry-run 零副作用：库文件与 agent-memory 目录都不被创建', () => {
  reset(false)
  dry()
  assert.equal(existsSync(memFile()), false, 'dry-run 不得创建记忆库')
  assert.equal(existsSync(join(HOME, 'agent-memory')), false, 'dry-run 不得创建 agent-memory 目录')
})

test('同一输入两次 dry-run 输出逐字节一致（tags 确定性，不许随机/依赖插入序）', () => {
  reset(false)
  const a = dry().stdout
  const b = dry().stdout
  assert.equal(a, b)
})

test('--write：先备份、逐条合规、幂等（第二次跑全部跳过且库内容不变）', () => {
  reset(true)
  const seedBytes = statSync(memFile()).size
  const r = write()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /- 写入成功：7 条；写入失败：0 条/)
  assert.match(r.stdout, /- 写入后库内总数：8 条/)
  // 备份：同目录、带时间戳后缀、字节数 = 写入前的库大小
  const backups = readdirSync(join(HOME, 'agent-memory')).filter((f) => f.startsWith('memory.ndjson.bak-'))
  assert.equal(backups.length, 1, '必须正好留一份备份')
  assert.equal(statSync(join(HOME, 'agent-memory', backups[0])).size, seedBytes)
  assert.match(r.stdout, new RegExp(`- 备份：.*${backups[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}（${seedBytes} 字节）`))
  // 逐条合规（真实协议 + store 单条上限的口径）
  const recs = readFileSync(memFile(), 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
  assert.equal(recs.length, 8)
  // 播种那条不算（它是 fixture 之外的库内既有记录），其余 7 条都要过真实协议的口径
  for (const rec of recs.slice(1)) {
    assert.equal(rec.kind, 'lesson')
    assert.ok(rec.title.length >= 8 && rec.title.length <= 120, `title 越界：${rec.title.length}`)
    assert.ok(rec.title.trim() === rec.title && !/[\n\r\u2028\u2029]/.test(rec.title))
    assert.ok(rec.body.trim() !== '')
    assert.ok(rec.tags.length >= 1 && rec.tags.length <= 6, 'tags = 基础标签 + 最多 5 个话题标签')
    assert.equal(rec.tags[0], '坑位')
    assert.equal(new Set(rec.tags).size, rec.tags.length, 'tags 不得重复')
    assert.ok(rec.tags.every((t) => t === t.trim().toLowerCase() && t.length >= 1 && t.length <= 32))
    assert.ok(rec.body.startsWith('原标题：'), 'body 首行必须是原标题原文')
    assert.match(rec.source, /^file:dsh-mobile-apk\/docs\/AGENTS\/gotchas\.md#\d+$/)
  }
  // 超长标题那条：title 截到 ≤120，原标题全文留在 body 首行
  const long = recs.find((x) => x.body.includes(LONG))
  assert.ok(long !== undefined, '超长标题条目的原标题必须原样进 body')
  assert.ok(long.title.length <= 120 && long.title.length >= 8)
  assert.ok(long.title.startsWith(LONG_PREFIX.slice(0, 20)))
  assert.ok(!long.title.includes(LONG_TAIL.slice(-10)), '断句后不得带进后半段')
  // 幂等：第二次跑接受 0 条、非 0 退出且库字节不变
  const bytesBefore = statSync(memFile()).size
  const again = write()
  assert.equal(again.status, 1, '全部已存在时应以非 0 退出并说明未写盘')
  assert.match(again.stdout + again.stderr, /没有可写入的条目（全部被拒或已存在）；未写盘/)
  assert.equal(statSync(memFile()).size, bytesBefore)
})

test('--skip-existing-source：可选择按出处去重（默认仍严格按 kind+title）', () => {
  reset(true)
  const def = dry()
  assert.match(def.stdout, /- 接受：7 条/)
  assert.match(def.stdout, /- 出处重复提示：1 条条目的 source 与库内既有记录相同但标题不同（规格去重键是 kind\+title ⇒ 默认仍会写入/)
  const on = runCli(['--source', SRC, '--home', HOME, '--skip-existing-source'])
  assert.equal(on.status, 0, on.stdout + on.stderr)
  assert.match(on.stdout, /- 接受：6 条/)
  assert.match(on.stdout, /- 跳过：2 条（已存在 0 \/ 已存在出处 1 \/ 本批重复 1）/)
})

test('异常输入：源文件不存在/为空/无条目一律非 0 退出，且不碰记忆库', () => {
  reset(false)
  const missing = runCli(['--source', join(TMP, 'nope.md'), '--home', HOME])
  assert.notEqual(missing.status, 0)
  assert.match(missing.stdout + missing.stderr, /语料源不存在/)
  const empty = join(TMP, 'empty.md')
  writeFileSync(empty, '   \n\n', 'utf8')
  const e = runCli(['--source', empty, '--home', HOME])
  assert.notEqual(e.status, 0)
  assert.match(e.stdout + e.stderr, /语料源是空文件/)
  const prose = join(TMP, 'prose.md')
  writeFileSync(prose, '只有散文，没有任何条目。\n', 'utf8')
  const p = runCli(['--source', prose, '--home', HOME])
  assert.notEqual(p.status, 0)
  assert.match(p.stdout + p.stderr, /一条条目都没解析到/)
  assert.equal(existsSync(memFile()), false, '异常输入下不得创建记忆库')
  // 库不存在时 --write 也不得凭空建库（应先备份，备份对象不存在即失败关闭）
  const noLib = runCli(['--source', SRC, '--home', HOME, '--write'])
  assert.equal(noLib.status, 1)
  assert.match(noLib.stdout + noLib.stderr, /记忆库不存在/)
  assert.equal(existsSync(memFile()), false)
})
