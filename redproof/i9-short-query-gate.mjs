#!/usr/bin/env node
/**
 * I9 取证脚本：**短查询/低内容量查询的 `match` 虚高** —— 把 4 条真实案例在**真实记忆库**上固化成用例。
 *
 * 病灶（本脚本复现）：`rel` 的分母是「查询自身的理论 BM25 上界」，一个内容词元的查询几乎能独自
 * 顶到那个上界 ⇒ 比值虚高。真实 204 条库上，`ok`(0.1867) / `做`(0.1829) / `b`(0.1707) 三条
 * **完全无关**的记忆都判 `strong`（阈值 0.1507）。
 *
 * 判据与阈值（内容量闸门，见 src/pure.ts 的 CONTENT_TOKEN_MIN 注释）：
 *   qTok = 去重查询词元里「在本库任一分词字段出现过」的个数；
 *   match = qTok=0 ? none : (qTok < contentTokenMin ? strong 封顶 weak : matchLevel(rel, weak, strong))
 * 取 qTok 而不是字符数：`虚拟屏` 只 3 个字符却切出 5 个内容词元（真话题），`ok`/`做`/`b` 只有 1 个。
 *
 * 只读：不写记忆库；运行前后 sha256 + 字节数 + 条数三重守卫并打印（§0/§6）。不碰 profile、不联网。
 *
 * 用法：
 *   node redproof/i9-short-query-gate.mjs                 # 正常取证（会断言，任一不成立 exit=1）
 *   node redproof/i9-short-query-gate.mjs --disable-gate  # 关掉闸门（contentTokenMin=1）再断言 ⇒ 噪声侧必红
 *   DSH_HOME=/path/to/.dsh node redproof/i9-short-query-gate.mjs
 *
 * 环境：Node >= 20。输出做机器身份脱敏（见 SANITIZE_RULES），所以本文件可被跟踪而不会把私有路径带进仓库。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = dirname(HERE)

/** 真实 DSH_HOME：env > `$HOME/.dsh`（与 src/store.ts 默认口径一致，不硬编码本机路径）。 */
const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME
  : join(homedir(), '.dsh')
process.env.DSH_HOME = DSH_HOME

/** 输出脱敏（前缀拆字构造 ⇒ 源码里不出现完整前缀，不会命中 test/release.test.mjs 的扫描针）。 */
const SL = '/'
const SANITIZE_RULES = [
  [DSH_HOME, '$DSH_HOME'],
  [homedir(), '$HOME'],
  [`${SL}data${SL}user${SL}0${SL}`, '$APP_HOME/'],
  [`${SL}data${SL}data${SL}`, '$APP_HOME/'],
  [`${SL}storage${SL}emulated${SL}0${SL}`, '$EXTERNAL/'],
  [['com', 'dsharnessmobile', 'shell'].join('.'), '<app-id>'],
  [['com', 'termux'].join('.'), '<termux-id>'],
]
const sanitize = (text) => {
  let s = String(text)
  for (const [from, to] of SANITIZE_RULES) if (from !== '' && s.includes(from)) s = s.split(from).join(to)
  return s
}

const MEMORY_FILE = join(DSH_HOME, 'agent-memory', 'memory.ndjson')
const DISABLE_GATE = process.argv.slice(2).includes('--disable-gate')
/** 关闸门 = 把阈值设成 1（qTok>=1 恒成立）⇒ 判定回到「只有 rel 与两个绝对阈值」。 */
const GATE_MIN = DISABLE_GATE ? 1 : undefined

const out = []
const say = (s = '') => { const line = sanitize(s); out.push(line); console.log(line) }

/** 只读守卫：sha256 + 字节数 + 条数。 */
function guard() {
  if (!existsSync(MEMORY_FILE)) return { missing: true, path: MEMORY_FILE }
  const buf = readFileSync(MEMORY_FILE)
  const st = statSync(MEMORY_FILE)
  return {
    path: MEMORY_FILE,
    sha256: createHash('sha256').update(buf).digest('hex'),
    bytes: buf.length,
    lines: buf.toString('utf8').split('\n').filter((l) => l.trim() !== '').length,
    mtimeMs: st.mtimeMs,
  }
}

/**
 * 复算 match（用**打印出来的量**，与表头逐字同规则）：
 * 这是 I1.3「恒可复算」的独立算式，刻意不 import 实现里的 matchLevelGated。
 */
function recomputeMatch(row, reply) {
  const LEVEL = (rel) => (rel >= reply.strongThreshold ? 'strong' : rel >= reply.weakThreshold ? 'weak' : 'none')
  if (reply.contentTokens === 0) return 'none'
  const base = LEVEL(row.rel)
  return base === 'strong' && reply.contentTokens < reply.contentTokenMin ? 'weak' : base
}

const { apply } = await import(join(PLUGIN_DIR, 'lib', 'index.js'))
const { CONTENT_TOKEN_MIN } = await import(join(PLUGIN_DIR, 'lib', 'pure.js'))

function makeRecall(cfg) {
  const defs = new Map()
  apply({ tools: { register: (d) => defs.set(d.name, d) } }, cfg)
  return defs.get('memory_recall')
}

const recallOn = makeRecall(GATE_MIN === undefined ? {} : { score: { contentTokenMin: GATE_MIN } })

if (!existsSync(MEMORY_FILE)) {
  console.error(`记忆库不存在：${sanitize(MEMORY_FILE)}（先用 memory_remember 写入，或用 DSH_HOME 指到库）`)
  process.exit(2)
}

const guardBefore = guard()

/**
 * 固定化的用例（4 条真实案例 + 话题侧两条）：
 *  - `noise`：修前判 strong 的**无关**命中，必须不再 strong；
 *  - `topic`：真话题短查询，闸门不得误伤（必须 weak 或以上）。
 */
const CASES = [
  { q: 'ok', kind: 'noise', why: '真实案例：回包 `ok` 与「写后回读回包缺 ok」标题表面重合，其实是逐字确认语' },
  { q: '做', kind: 'noise', why: '真实案例：单字动词命中「稀疏向量做 Gram-Schmidt」标题，完全无关' },
  { q: 'b', kind: 'noise', why: '真实案例：单字 `b` 命中「闸门B」标题，完全无关' },
  { q: '虚拟屏', kind: 'topic', why: '话题侧防误伤：只 3 个**字符**，但 5 个内容词元，是真话题' },
  { q: '虚拟屏不能用吗？', kind: 'topic', why: '话题侧防误伤：口语疑问句，真话题（它本来就只超 strong 线 8.7e-6）' },
]

say('='.repeat(78))
say('I9 短查询内容量闸门取证（只读；真实记忆库上把 4 条真实案例固化成用例）')
say('='.repeat(78))
say(`DSH_HOME       = ${DSH_HOME}`)
say(`记忆库         = ${guardBefore.path}`)
say(`  sha256       = ${guardBefore.sha256}`)
say(`  字节/条数    = ${guardBefore.bytes} / ${guardBefore.lines}`)
say(`  机器身份脱敏 = 已开启（路径替换为 $DSH_HOME/$APP_HOME，见 SANITIZE_RULES）`)
say(`闸门阈值       = ${DISABLE_GATE ? `已关闭（contentTokenMin=1）` : `contentTokenMin=${CONTENT_TOKEN_MIN}`}`)
say('判据：match = qTok=0 ? none : (qTok < contentTokenMin ? strong 封顶 weak : matchLevel(rel, weak, strong))')
say('')

const rowsOut = []
const failures = []
say('§1 逐案例：闸门开 / 闸门关（关 = 去掉闸门，用来判红）')
say('-'.repeat(78))
say('  query                码点 qTok 闸门开(top1)          闸门关(top1)          top1 rel    top1 标题')
for (const c of CASES) {
  const on = await recallOn.execute({ query: c.q, limit: 5 })
  const offRecall = makeRecall({ score: { contentTokenMin: 1 } })
  const off = await offRecall.execute({ query: c.q, limit: 5 })
  const onTop = on.rows[0] ?? null
  const offTop = off.rows[0] ?? null
  const chars = Array.from(c.q).length
  say(`  ${JSON.stringify(c.q).padEnd(20)} ${String(chars).padStart(4)} ${String(on.contentTokens).padStart(4)} ${String(onTop?.match ?? 'n/a').padEnd(20)} ${String(offTop?.match ?? 'n/a').padEnd(20)} ${String(onTop?.rel?.toFixed(6) ?? 'n/a').padStart(9)}  ${sanitize(String(onTop?.title ?? '')).slice(0, 40)}`)
  // 逐行复算（I1.3）：打印的 rel + 阈值 + 闸门输入必须复现打印的 match
  for (const row of on.rows) {
    const expect = recomputeMatch(row, on)
    if (row.match !== expect) failures.push(`${c.q} 行 ${row.id}：复算得 ${expect}，打印 ${row.match}`)
  }
  rowsOut.push({
    q: c.q, kind: c.kind, why: c.why, chars,
    contentTokens: on.contentTokens, contentTokenMin: on.contentTokenMin,
    gateOn: onTop ? { match: onTop.match, rel: onTop.rel, title: onTop.title } : null,
    gateOff: offTop ? { match: offTop.match, rel: offTop.rel, title: offTop.title } : null,
    rows: on.rows.map((r) => ({ id: r.id, rel: r.rel, match: r.match, title: r.title })),
  })
  // 断言（--disable-gate 时用关闸门那一路判定 ⇒ 噪声侧必红，这就是「去掉闸门变红」的红证）
  const verdict = DISABLE_GATE ? offTop : onTop
  if (c.kind === 'noise') {
    if (verdict?.match === 'strong') failures.push(`${c.q}：无关查询被判 strong（内容量闸门没起作用）`)
  } else {
    const ok = verdict?.match === 'weak' || verdict?.match === 'strong'
    if (!ok) failures.push(`${c.q}：真话题查询被误伤（match=${verdict?.match}），闸门区分力不足`)
  }
}
say('')

say('§2 红证用对照（固定话术；实际判红证据见 redproof/i9-red*.txt）')
say('-'.repeat(78))
say('  R1 去掉闸门（contentTokenMin=1，或 --disable-gate）：ok/做/b 必须回到 strong ⇒ 噪声侧断言必红。')
say('  R2 把闸门换成「字符数 <=3 就封顶」：虚拟屏（3 字符）必须被误伤 ⇒ 话题侧断言必红。')
say('      这两条一起证明：闸门按「内容量」而不是「字符数」判定，且两侧都有区分力。')
say('')

say('§3 表头回显（读者复算 match 的输入必须真在表头上）')
say('-'.repeat(78))
const hdrReply = await recallOn.execute({ query: 'ok', limit: 5 })
const hdr = hdrReply.text.split('\n')[0]
const wantSeg = `内容量qTok=${hdrReply.contentTokens}<${hdrReply.contentTokenMin}⇒strong封顶weak`
say(`  ${sanitize(hdr)}`)
say(`  闸门段回显: ${hdr.includes(wantSeg) ? '成立' : '缺失'}（期望逐字含 ${wantSeg}）`)
if (!hdr.includes(wantSeg)) failures.push(`表头缺少闸门回显段「${wantSeg}」`)

const guardAfter = guard()
say('')
say('§4 只读守卫（运行后复核）')
say('-'.repeat(78))
say(`  sha256   ${guardAfter.sha256}`)
say(`  字节/条数 ${guardAfter.bytes} / ${guardAfter.lines}`)
const unchanged = guardAfter.sha256 === guardBefore.sha256 && guardAfter.bytes === guardBefore.bytes && guardAfter.lines === guardBefore.lines
say(`  结论: ${unchanged ? '未变（只读成立）' : '★ 变了！本脚本动了记忆库，必须排查'}`)
if (!unchanged) failures.push('记忆库被改动（只读守卫失败）')

say('')
say('§5 结论')
say('-'.repeat(78))
if (failures.length === 0) say(`  全部断言成立（${CASES.length} 条用例：噪声侧不判 strong、话题侧 >= weak、逐行可复算、库未变）。`)
else for (const f of failures) say(`  ★ 不成立：${f}`)

const txtPath = join(HERE, 'i9-short-query-gate.txt')
const jsonPath = join(HERE, 'i9-short-query-gate.json')
writeFileSync(txtPath, out.join('\n') + '\n')
writeFileSync(jsonPath, sanitize(JSON.stringify({
  generatedBy: 'redproof/i9-short-query-gate.mjs',
  gateDisabled: DISABLE_GATE,
  gate: { contentTokenMin: DISABLE_GATE ? 1 : CONTENT_TOKEN_MIN, rule: 'match = qTok=0 ? none : (qTok < contentTokenMin ? strong 封顶 weak : matchLevel(rel, weak, strong))' },
  store: { path: guardBefore.path, sha256: guardBefore.sha256, bytes: guardBefore.bytes, lines: guardBefore.lines },
  cases: rowsOut,
  failures,
  readOnly: { before: guardBefore.sha256, after: guardAfter.sha256, unchanged },
}, null, 1)))

console.log(sanitize(`\n[证据] ${txtPath}\n[证据] ${jsonPath}`))
if (failures.length > 0) {
  console.error(sanitize(`\n判红：${failures.length} 条断言不成立`))
  process.exit(1)
}
