#!/usr/bin/env node
/**
 * I8 取证脚本：**离线模拟「按话题自动召回」**，量它在真实会话里会触发多少次、
 * 触发时命中什么级别、若要注入 top-3 标题会把上下文改动多频繁。
 *
 * 只读：本脚本不调用 memory_remember / memory_prune / memory_expand，只调 memory_recall；
 * 运行前后对真实记忆库做 sha256+字节数+mtimeMs 三重守卫并打印（见 §0/§7）。
 * 不碰 profile、不碰 dsh-mobile-apk、不 push、不重启、不联网。
 *
 * 可复跑（无随机、无 Date.now 依赖）：recall 的 `now` 经 cfg.now 冻结为**库内最大 ts**，
 * 于是「同一份库 + 同一批会话」任意两次运行逐字节一致。注意 `rel`（BM25）本来就与时间无关，
 * 冻结只影响 final 排序里 freshness 那一支的极小项。
 *
 * ── 偏差声明（必须随数字一起读）────────────────────────────────────────────
 * 本机这条库的主体是**本项目自己的教训**（Android 壳 / 插件 / 注入 / 门禁 / 记忆系统），
 * 而这个工作区的会话**也主要在做这个项目** ⇒ 真实会话侧的触发率**天然偏高**。
 * 因此 §4 的「240 条跨域无关查询」双侧对照才是判据；单侧数字不能单独下结论。
 * 另外一条实测出来的偏差方向**与直觉相反**（见 §6c）：抬高触发率的不是长任务书，而是**很短的口语消息**
 * （本机 112 轮里有 95 轮 <=50 码点，宽松触发率 70.5%；而 200 码点以上的 3 轮全部 0%）——
 * 因为「ok / 好的 / 已重启」这类确认语没有话题内容，命中的是库里无处不在的通用词元。
 * §6d 的「截断到前 200 码点」因此对结论几乎无影响（98% 的轮次本来就短于 200）。
 *
 * 用法：
 *   node redproof/i8-autorecall-fire-rate.mjs                 # 默认：全部会话 + 240 负样本
 *   DSH_HOME=/path/to/.dsh node redproof/i8-autorecall-fire-rate.mjs
 *   node redproof/i8-autorecall-fire-rate.mjs --limit-sessions 3   # 冒烟跑
 *
 * 环境：Node >= 20（zstd 解压优先用 node:zlib.zstdDecompressSync，失败回落 zstd CLI）。
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

// ── 0. 路径与常量：全部显式解析，不依赖调用者的 shell 环境 ──────────────────────
const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = dirname(HERE)

/** 真实 DSH_HOME。默认写死本机路径，允许 env 覆盖（重置/迁移后可用）。 */
const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME
  : '/data/user/0/com.dsharnessmobile.shell/files/home/.dsh'
// 必须在任何插件调用之前落定：store 在**调用时**读 env（src/store.ts memoryPath）。
process.env.DSH_HOME = DSH_HOME

const MEMORY_FILE = join(DSH_HOME, 'agent-memory', 'memory.ndjson')
const SESSIONS_DIR = join(DSH_HOME, 'sessions')

const argv = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}
const LIMIT_SESSIONS = Number(argOf('--limit-sessions', '0')) || 0
/**
 * 会话目录覆盖。默认走真实 DSH_HOME/sessions；
 * 要**逐字节复现**就把会话树先冻结成一份拷贝再指过来：
 *   cp -r "$DSH_HOME/sessions" .tmp-test/i8/sessions-frozen
 *   node redproof/i8-autorecall-fire-rate.mjs --sessions-dir .tmp-test/i8/sessions-frozen
 * 原因是本机有**活的**会话在跑（我自己的父会话就在追加），事件数会变 —— 那是输入在变，不是脚本不确定。
 */
const SESSIONS_DIR_OVERRIDE = argOf('--sessions-dir', '')
const SESSIONS_DIR_USED = SESSIONS_DIR_OVERRIDE === '' ? SESSIONS_DIR : (SESSIONS_DIR_OVERRIDE.startsWith('/') ? SESSIONS_DIR_OVERRIDE : join(process.cwd(), SESSIONS_DIR_OVERRIDE))
const RECALL_LIMIT = 5
const TOP_N = 3
/** 长查询敏感性：截断到前 N 码点后重新跑一遍。 */
const TRUNC_POINTS = 200

// 阈值/标度**从构建产物 import**，不在脚本里抄数字 ⇒ 脚本不可能与实现漂移。
const { WEAK_THRESHOLD, STRONG_THRESHOLD, SCALE_A, SCALE_B, tokenize } =
  await import(join(PLUGIN_DIR, 'lib', 'pure.js'))
const { apply } = await import(join(PLUGIN_DIR, 'lib', 'index.js'))
const { buildNegativeQueries } = await import(join(PLUGIN_DIR, 'scripts', 'negative-samples.mjs'))

const out = []
const say = (s = '') => { out.push(s); console.log(s) }
const pct = (a, b) => (b === 0 ? 'n/a' : `${((a / b) * 100).toFixed(1)}%`)
const fx = (x, n = 4) => (Number.isFinite(x) ? x.toFixed(n) : String(x))

// ── 只读守卫 ────────────────────────────────────────────────────────────────
function storeGuard() {
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

// ── 会话日志读取 ────────────────────────────────────────────────────────────
function walk(root) {
  const acc = []
  if (!existsSync(root)) return acc
  const stack = [root]
  while (stack.length) {
    const d = stack.pop()
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (/^session.*\.jsonl\.zstd$/.test(e.name)) acc.push(p)
    }
  }
  return acc.sort()
}

/**
 * 解压会话日志。
 *
 * ★ 新环境坑（实测，2026-10-09）：这些 session*.jsonl.zstd 是**多帧**布局
 *   （第 1 帧 = {"type":"session",...} 头，其后每个事件一帧）。Node 的
 *   zlib.zstdDecompressSync **只解第一帧**，返回一个 200 字节左右的 session 头就停 ——
 *   静默地让每个会话只剩 1 个事件、human 轮次全变 0，**不报错**。
 *   所以这里 CLI 优先（zstd -dc 会拼接所有帧），并加「多帧完整性」自检。
 */
function decompress(path) {
  let text = null
  let via = null
  try {
    text = execFileSync('zstd', ['-dc', path], { maxBuffer: 1 << 30 }).toString('utf8')
    via = 'cli'
  } catch (e1) {
    try {
      text = zlib.zstdDecompressSync(readFileSync(path)).toString('utf8')
      via = 'zlib(单帧!)'
    } catch (e2) {
      throw new Error(`zstd 解压失败（cli: ${e1.message} / zlib: ${e2.message}）`)
    }
  }
  return { text, via }
}

/** 从一条消息里取纯文本（content 可能是字符串或 part 数组）。 */
function textOf(message) {
  const c = message?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n')
}

/**
 * 判据（写死、可核对）——「人类用户消息」的定义：
 *   event.type === 'user/message'
 *   且 data.source.kind === 'user'
 *   且 data.source.rpcId 是非空字符串          ← 客户端来源标记（GUI 发送的才带）
 *   且 data.source.clientTimeZone 存在          ← 同源佐证
 *   且 会话 delegationDepth === 0               ← 非子代理会话
 * 四条同时成立才计入真实用户轮次。
 *
 * 反向证据（本机实测，见 §1 分类表）：
 *   子代理会话（depth=1）里那条 user 消息的 source 只有 {"kind":"user"}，**没有 rpcId** ——
 *   它是父代理注入的委派提示词，不是人的话题信号。
 *   runtime-context 的 source.kind === 'runtime-context'（form: 'snapshot'），是我们自己注入的快照。
 */
function classifyUserMessage(message, depth) {
  const src = message?.source ?? {}
  const kind = typeof src.kind === 'string' ? src.kind : '(no-kind)'
  const hasRpc = typeof src.rpcId === 'string' && src.rpcId !== ''
  if (kind === 'runtime-context') return 'runtime-context'
  if (kind === 'user') {
    if (depth === 0 && hasRpc) return 'human'
    if (depth !== 0) return 'subagent-prompt'
    if (!hasRpc) return 'other-unclassified'
    return 'other-unclassified'
  }
  return `other:${kind}`
}

function readSessions() {
  const files = walk(SESSIONS_DIR_USED)
  const sessions = []
  const anomalies = []
  for (const f of files.slice(0, LIMIT_SESSIONS > 0 ? LIMIT_SESSIONS : undefined)) {
    let text
    let via
    try {
      ({ text, via } = decompress(f))
    } catch (e) {
      anomalies.push({ file: f, reason: `解压失败: ${e.message}` })
      continue
    }
    const events = []
    let badLines = 0
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let ev
      try {
        ev = JSON.parse(line)
      } catch {
        badLines += 1
        continue
      }
      events.push(ev)
    }
    // 多帧完整性自检：头帧 + 事件帧 ⇒ 正常会话至少数条事件；文件 >64KB 却只有 1 条事件
    // 一定是「只解了第一帧」（Node zlib 的静默截断），必须如实报异常而不是当成空会话。
    if (events.length <= 1 && statSync(f).size > 64 * 1024) {
      anomalies.push({ file: f, reason: `只解出 ${events.length} 个事件（疑似单帧截断，via=${via}），已跳过` })
      continue
    }
    const meta = events.find((e) => e?.type === 'session') ?? {}
    const id = meta.id ?? basename(dirname(f))
    const depth = Number.isInteger(meta.delegationDepth) ? meta.delegationDepth : null
    if (depth === null) anomalies.push({ file: f, reason: 'session 头缺 delegationDepth（按 depth=null 处理，其 user 消息不会计入 human）' })
    const counts = new Map()
    const humans = []
    const splicedUserIds = new Set()
    const allUserMsgIds = new Set()
    for (const ev of events) {
      if (ev?.type === 'agent/inbox/spliced') {
        for (const m of (ev.data?.inserted ?? [])) {
          if (m?.source?.kind === 'user' && typeof m.id === 'string') splicedUserIds.add(m.id)
        }
        continue
      }
      if (ev?.type !== 'user/message') continue
      const cls = classifyUserMessage(ev.data, depth)
      counts.set(cls, (counts.get(cls) ?? 0) + 1)
      if (typeof ev.data?.id === 'string') allUserMsgIds.add(ev.data.id)
      if (cls !== 'human') continue
      const text2 = textOf(ev.data).trim()
      if (text2 === '') { counts.set('human-but-empty', (counts.get('human-but-empty') ?? 0) + 1); continue }
      humans.push({
        sessionId: id,
        depth,
        cwd: meta.cwd ?? '',
        seq: typeof ev.seq === 'number' ? ev.seq : null,
        time: typeof ev.time === 'number' ? ev.time : null,
        msgId: ev.data?.id ?? null,
        text: text2,
      })
    }
    // 交付对账：spliced 里出现过、但任何类别的 user/message 流里都没有的（用户取消 / 编辑 / 未落账）。
    // 必须用 allUserMsgIds（含子代理提示词与 runtime-context），只拿 human 比会把子代理会话全判成未落账。
    const undelivered = [...splicedUserIds].filter((x) => !allUserMsgIds.has(x)).length
    sessions.push({
      file: f, id, depth, cwd: meta.cwd ?? '', events: events.length,
      badLines, counts, humans, splicedUserIds: splicedUserIds.size, undelivered,
    })
  }
  return { files, sessions, anomalies }
}

// ── 打分（真实库，只读）────────────────────────────────────────────────────
const guardBefore = storeGuard()
if (guardBefore.missing) {
  console.error(`找不到记忆库：${MEMORY_FILE}`)
  process.exit(2)
}

// 冻结时钟：库内最大 ts（确定性；rel 与时间无关，冻结只让排序可复现）。
const storeRecords = readFileSync(MEMORY_FILE, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
const FROZEN_NOW = storeRecords.reduce((m, r) => (Number.isFinite(r.ts) && r.ts > m ? r.ts : m), 0)

// 桩 ctx：与 test/helpers.mjs 的 makeCtx 同形（此处内联，脚本不 import test/ 以免耦合测试内部结构）。
function makeHost() {
  const defs = new Map()
  const ctx = {
    tools: { register: (d) => { defs.set(d.name, d); return { dispose: () => {} } } },
    effect: () => ({ dispose: () => {} }),
    systemPrompt: {
      context: () => ({ dispose: () => {} }),
      section: () => ({ dispose: () => {} }),
      getSectionOrder: () => undefined,
    },
    inject: (deps, callback) => {
      const names = Array.isArray(deps) ? deps : Object.keys(deps ?? {})
      const scope = {}
      for (const dep of names) {
        if (ctx[dep] === undefined) return { dispose: () => {} }
        scope[dep] = ctx[dep]
      }
      callback(scope, undefined)
      return { dispose: () => {} }
    },
  }
  return { ctx, defs }
}
const host = makeHost()
apply(host.ctx, { now: () => FROZEN_NOW })
const recall = host.defs.get('memory_recall')
if (!recall) {
  console.error('memory_recall 未注册（apply 失败？）')
  process.exit(2)
}

/** 跑一轮 recall，返回判定所需的最小结构。 */
async function probe(query) {
  const r = await recall.execute({ query, limit: RECALL_LIMIT })
  const rows = Array.isArray(r.rows) ? r.rows : []
  const rels = rows.map((x) => (Number.isFinite(x.rel) ? x.rel : 0))
  const maxRel = rels.length ? Math.max(...rels) : 0
  const top = rows[0] ?? null
  const topN = rows.slice(0, TOP_N).map((x) => x.title)
  const qTokens = new Set(tokenize(query))
  // 「表面证据」机械判定：top-1 的**标签**在查询里直接出现，或 top-1 **标题**的词元与查询词元有交集。
  // 都没有 ⇒ rel 只能来自 body（本脚本看不到 body）⇒ 标为 no-surface-overlap，供人核对。
  let surface = false
  if (top) {
    for (const t of (top.tags ?? [])) if (qTokens.has(t)) surface = true
    for (const tk of tokenize(String(top.title ?? ''))) if (qTokens.has(tk)) surface = true
  }
  return {
    ok: r.ok !== false,
    total: r.total,
    matched: r.matched,
    shown: rows.length,
    rels,
    maxRel,
    nWeak: rels.filter((x) => x >= WEAK_THRESHOLD).length,
    nStrong: rels.filter((x) => x >= STRONG_THRESHOLD).length,
    top: top ? { title: top.title, rel: top.rel, match: top.match, kind: top.kind, via: top.via } : null,
    topRowRel: top ? top.rel : 0,
    topN,
    surface,
  }
}

// ── §1 抽取会话 + 分类 ─────────────────────────────────────────────────────
const { files, sessions, anomalies } = readSessions()

/**
 * 输入指纹：把所有会话文件的 (相对路径, 字节数, mtimeMs) 拼起来取 sha256。
 * 两次运行的这一行不同 ⇒ **是输入在变**（本机有活会话在追加），不是脚本不确定；
 * 想逐字节复现就先冻结一份副本再 `--sessions-dir` 指过来。
 */
function inputFingerprint(fs_) {
  const h = createHash('sha256')
  for (const f of fs_) {
    const st = statSync(f)
    h.update(`${f.replace(SESSIONS_DIR_USED, '')}\u0000${st.size}\u0000${Math.round(st.mtimeMs)}\n`)
  }
  return h.digest('hex')
}
const inputFp = inputFingerprint(files)

say('='.repeat(78))
say('I8 自动召回触发率实测（只读；不改插件行为）')
say('='.repeat(78))
say(`DSH_HOME      = ${DSH_HOME}`)
say(`记忆库        = ${guardBefore.path}`)
say(`  sha256      = ${guardBefore.sha256}`)
say(`  字节/条数   = ${guardBefore.bytes} / ${guardBefore.lines}`)
say(`  mtimeMs     = ${guardBefore.mtimeMs}`)
say(`会话文件      = ${files.length} 个（${SESSIONS_DIR_USED}${SESSIONS_DIR_USED === SESSIONS_DIR ? '' : ' ← 冻结副本'}）`)
say(`输入指纹      = ${inputFp}  ← 两次运行这行不同即「输入在变」，不是脚本不确定`)
say(`冻结时钟 now  = ${FROZEN_NOW}（= 库内最大 ts；为可复跑而固定，rel 与时间无关）`)
say(`阈值（import 自 lib/pure.js）: WEAK=${WEAK_THRESHOLD} STRONG=${STRONG_THRESHOLD} SCALE_A=${SCALE_A} SCALE_B=${SCALE_B}`)
say(`recall 参数   = limit:${RECALL_LIMIT}；注入体量按 top-${TOP_N} 标题计`)
say('')
say('§1 消息分类计数（判据见脚本 classifyUserMessage 注释）')
say('-'.repeat(78))
const clsTotals = new Map()
for (const s of sessions) {
  for (const [k, v] of s.counts) clsTotals.set(k, (clsTotals.get(k) ?? 0) + v)
}
const humanTurns = sessions.flatMap((s) => s.humans)
say(`真实用户轮次(human)       ${String(humanTurns.length).padStart(5)}   ← 唯一计入触发率的分母`)
for (const [k, v] of [...clsTotals].sort((a, b) => b[1] - a[1])) {
  if (k === 'human') continue
  const note = k === 'runtime-context' ? '  ← 我们自己注入的快照，不是话题信号'
    : k === 'subagent-prompt' ? '  ← 父代理注入的子代理提示词，不是人的话题信号'
      : k === 'skill-catalog' ? '  ← 技能目录注入'
        : k === 'agent-message' ? '  ← 子代理回传'
          : k === 'subagent-settled' ? '  ← 子代理完成通知'
            : k === 'goal' || k === 'tool-goal' ? '  ← 目标系统注入'
              : k === 'user-approval' ? '  ← 审批策略变更通知'
                : k === 'tool-jobs' ? '  ← 后台任务通知'
                  : k === 'compact-checkpoint' ? '  ← 压缩检查点'
                    : k === 'model-selection' ? '  ← 模型切换通知'
                      : k === 'agent-instructions' ? '  ← 代理指令注入'
                        : ''
  say(`  ${k.padEnd(24)} ${String(v).padStart(5)}${note}`)
}
say('')
say('按会话明细（depth=delegationDepth；只列有 user 消息的会话）:')
say('  session(前缀)          depth  human  runtime-ctx  subagent  其他  events  交付对账')
for (const s of sessions) {
  if (s.counts.size === 0) continue
  const c = (k) => s.counts.get(k) ?? 0
  const other = [...s.counts].filter(([k]) => !['human', 'runtime-context', 'subagent-prompt'].includes(k)).reduce((a, [, v]) => a + v, 0)
  say(`  ${s.id.slice(0, 22).padEnd(22)} ${String(s.depth).padStart(5)} ${String(c('human')).padStart(6)} ${String(c('runtime-context')).padStart(12)} ${String(c('subagent-prompt')).padStart(9)} ${String(other).padStart(5)} ${String(s.events).padStart(7)}  spliced=${s.splicedUserIds} 未落账=${s.undelivered}`)
}
const emptySessions = sessions.filter((s) => s.counts.size === 0)
say('')
say(`结构异常/跳过：`)
say(`  - 无任何 user/message 的会话 ${emptySessions.length} 个（已空跑或只有策略事件，如实跳过，不计入分母）`)
for (const s of emptySessions) say(`      ${s.id}  cwd=${s.cwd || '(无)'}  events=${s.events}`)
for (const a of anomalies) say(`  - ${basename(dirname(a.file))}: ${a.reason}`)
say(`  - 解不开的 JSON 行合计 ${sessions.reduce((a, s) => a + s.badLines, 0)} 行（已跳过）`)
const depth0HumanSessions = new Set(humanTurns.map((h) => h.sessionId)).size
say(`  - 真实用户轮次分布在 ${depth0HumanSessions} 个 depth=0 会话里`)

// ── §2/§3 每一轮真实用户消息模拟自动召回 ───────────────────────────────────
say('')
say('§2 逐轮模拟自动召回（真实库，limit:5）')
say('-'.repeat(78))
const realResults = []
for (let i = 0; i < humanTurns.length; i += 1) {
  const h = humanTurns[i]
  const p = await probe(h.text)
  realResults.push({ ...h, chars: Array.from(h.text).length, ...p })
}
const realLoose = realResults.filter((r) => r.nWeak > 0)
const realStrict = realResults.filter((r) => r.maxRel >= STRONG_THRESHOLD)
say(`总轮次                          ${realResults.length}`)
say(`宽松门槛（存在任一 rel>=weak）  ${realLoose.length}  → 触发率 ${pct(realLoose.length, realResults.length)}`)
say(`严格门槛（最高 rel>=strong）    ${realStrict.length}  → 触发率 ${pct(realStrict.length, realResults.length)}`)
const allNone = realResults.filter((r) => r.nWeak === 0)
say(`一个 weak 都没命中（全 none）   ${allNone.length}  → ${pct(allNone.length, realResults.length)}`)
say(`最高行 rel 与 max(rel) 不一致的轮次: ${realResults.filter((r) => Math.abs(r.topRowRel - r.maxRel) > 1e-12).length}（排序按 final 而非 rel）`)
say('')
say('逐会话明细（★必须拆开看：31 个会话里只有 5 个含人的轮次，其中一个开发会话独占 81/112 轮，能代表全机）:')
say('  session(前缀)          轮次   宽松触发        严格触发')
const perSession = new Map()
for (const r of realResults) {
  if (!perSession.has(r.sessionId)) perSession.set(r.sessionId, [])
  perSession.get(r.sessionId).push(r)
}
for (const [sid, rows] of [...perSession].sort((a, b) => b[1].length - a[1].length)) {
  const l = rows.filter((r) => r.nWeak > 0).length
  const s = rows.filter((r) => r.maxRel >= STRONG_THRESHOLD).length
  say(`  ${sid.slice(0, 22).padEnd(22)} ${String(rows.length).padStart(6)} ${(pct(l, rows.length) + ` (${l}/${rows.length})`).padStart(14)} ${(pct(s, rows.length) + ` (${s}/${rows.length})`).padStart(14)}`)
}
say('')
say('命中级别分布（按 max(rel) 判定的那一行）:')
const lvl = (r) => (r.maxRel >= STRONG_THRESHOLD ? 'strong' : r.maxRel >= WEAK_THRESHOLD ? 'weak' : 'none')
const lvlCount = new Map()
for (const r of realResults) lvlCount.set(lvl(r), (lvlCount.get(lvl(r)) ?? 0) + 1)
for (const k of ['strong', 'weak', 'none']) say(`  ${k.padEnd(7)} ${String(lvlCount.get(k) ?? 0).padStart(4)}  ${pct(lvlCount.get(k) ?? 0, realResults.length)}`)
say('')
say('边缘触发（触发但很勉强：max rel < 1.5×weak 门槛）:')
const marginal = realLoose.filter((r) => r.maxRel < WEAK_THRESHOLD * 1.5)
say(`  ${marginal.length} / ${realLoose.length} 个触发轮次 (${pct(marginal.length, realLoose.length)})  阈值 1.5×weak=${fx(WEAK_THRESHOLD * 1.5)}`)
const noSurface = realLoose.filter((r) => r.surface === false)
say(`触发但 top-1 与查询**零表面重叠**（标签/标题都没有共同词元，rel 只能来自 body）: ${noSurface.length} / ${realLoose.length} (${pct(noSurface.length, realLoose.length)})`)
say('  注意：这个机械判据**不能**当相关性判据。反过来不成立 —— 有表面重叠也常常毫不相关（见 §5 短消息清单：')
say('  「ok」与标题里的 `ok` 有表面重叠，却是典型的假命中）。它只用来说明「连表面词元都没有」的极端一类。')

// ── §3 变频率 + 注入体量 ───────────────────────────────────────────────────
say('')
say('§3 变频率（相邻两轮之间 top-3 标题集合是否变化）与注入体量')
say('-'.repeat(78))
const bySession = new Map()
for (const r of realResults) {
  if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, [])
  bySession.get(r.sessionId).push(r)
}
function changeStats(rows) {
  let pairs = 0
  let changed = 0
  let firstCount = 0
  for (const [, list] of bySession) {
    const ordered = list.slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    if (ordered.length === 0) continue
    firstCount += 1
    for (let i = 1; i < ordered.length; i += 1) {
      pairs += 1
      const A = new Set(ordered[i - 1].topN)
      const B = new Set(ordered[i].topN)
      const same = A.size === B.size && [...A].every((x) => B.has(x))
      if (!same) changed += 1
    }
  }
  return { pairs, changed, firstCount }
}
const chAll = changeStats(realResults)
say(`相邻轮次对（同会话内）        ${chAll.pairs}`)
say(`其中 top-3 集合发生变化        ${chAll.changed}  → 变频率 ${pct(chAll.changed, chAll.pairs)}`)
say(`含真实用户轮次的会话数         ${chAll.firstCount}`)
say('')
const injectedLoose = realLoose
const injectedStrict = realStrict
function shapeTable(triggered, label) {
  const rows = triggered
  const byS = new Map()
  for (const r of rows) {
    if (!byS.has(r.sessionId)) byS.set(r.sessionId, [])
    byS.get(r.sessionId).push(r)
  }
  let everyTurn = rows.length
  let changeOnly = 0
  for (const [, list] of byS) {
    const ordered = list.slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    changeOnly += 1 // 首轮
    for (let i = 1; i < ordered.length; i += 1) {
      const A = new Set(ordered[i - 1].topN)
      const B = new Set(ordered[i].topN)
      const same = A.size === B.size && [...A].every((x) => B.has(x))
      if (!same) changeOnly += 1
    }
  }
  say(`  ${label}: 每轮都注入 ${everyTurn} 次 | 只在变化时注入 ${changeOnly} 次 | 只在首轮注入 ${byS.size} 次`)
  return { everyTurn, changeOnly, firstOnly: byS.size }
}
say('形态对照（会追加多少条快照消息 / 缓存断点）:')
const shapeNone = shapeTable(realResults, '无门槛(每轮)')
const shapeLoose = shapeTable(injectedLoose, '宽松门槛  ')
const shapeStrict = shapeTable(injectedStrict, '严格门槛  ')
say('  ↑「只在变化时」= 首次注入 + 相邻两个**触发轮**之间 top-3 集合发生变化时才注入。')
say('  ★ 读法：宽松门槛下「每轮都注入 69」→「只在变化时注入 67」，只省下 2 次 ——')
say('    「只在文本变化时触发」这个优化在本机几乎不起作用，因为相邻两轮的 top-3 几乎总会变。')
say('')
const budget = injectedLoose.map((r) => r.topN.join(' | ')).map((s) => Array.from(s).length)
const budgetStrict = injectedStrict.map((r) => r.topN.join(' | ')).map((s) => Array.from(s).length)
const budgetNone = realResults.map((r) => r.topN.join(' | ')).map((s) => Array.from(s).length)
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
say('平均注入体量（触发时 top-3 标题拼接的字符数，文本预算）:')
say(`  宽松门槛 n=${budget.length}  均值 ${mean(budget).toFixed(1)}  中位 ${median(budget).toFixed(1)}  最小 ${Math.min(...budget, 0)}  最大 ${Math.max(...budget, 0)}`)
say(`  严格门槛 n=${budgetStrict.length}  均值 ${mean(budgetStrict).toFixed(1)}  中位 ${median(budgetStrict).toFixed(1)}  最小 ${Math.min(...budgetStrict, 0)}  最大 ${Math.max(...budgetStrict, 0)}`)
say(`  无门槛   n=${budgetNone.length}  均值 ${mean(budgetNone).toFixed(1)}  中位 ${median(budgetNone).toFixed(1)}  最小 ${Math.min(...budgetNone, 0)}  最大 ${Math.max(...budgetNone, 0)}`)

// ── §4 双侧对照：240 条跨域无关查询 ────────────────────────────────────────
say('')
say('§4 双侧对照：scripts/negative-samples.mjs 的跨域无关查询（确定性生成，与库内容无关）')
say('-'.repeat(78))
const negQueries = buildNegativeQueries()
const negResults = []
for (const q of negQueries) {
  const p = await probe(q)
  negResults.push({ query: q, ...p })
}
const negLoose = negResults.filter((r) => r.nWeak > 0)
const negStrict = negResults.filter((r) => r.maxRel >= STRONG_THRESHOLD)
say(`负样本条数                        ${negResults.length}`)
say(`宽松门槛触发                      ${negLoose.length}  → 触发率 ${pct(negLoose.length, negResults.length)}`)
say(`严格门槛触发                      ${negStrict.length}  → 触发率 ${pct(negStrict.length, negResults.length)}`)
say(`（构建器声明目标 ${240}；实际 ${negQueries.length}）`)
say('')
say('双侧触发率表:')
say(`  门槛        真实用户轮次(n=${realResults.length})      240 无关查询(n=${negResults.length})`)
say(`  宽松 weak   ${pct(realLoose.length, realResults.length).padStart(14)} (${realLoose.length}/${realResults.length})${pct(negLoose.length, negResults.length).padStart(14)} (${negLoose.length}/${negResults.length})`)
say(`  严格 strong ${pct(realStrict.length, realResults.length).padStart(14)} (${realStrict.length}/${realResults.length})${pct(negStrict.length, negResults.length).padStart(14)} (${negStrict.length}/${negResults.length})`)
say('')
say('无关查询里触发的那几条（必须如实列出，不许为了好看删掉）:')
for (const r of negLoose.slice(0, 10)) {
  say(`  query="${r.query}"  maxRel=${fx(r.maxRel)} nWeak=${r.nWeak} top="${String(r.top?.title ?? '').slice(0, 40)}" (${fx(r.top?.rel ?? 0)})`)
}
if (negLoose.length > 10) say(`  ...（共 ${negLoose.length} 条，此处只列前 10）`)

// ── §5 抽样：触发 vs 未触发 ────────────────────────────────────────────────
say('')
say('§5 抽样对比（触发 / 未触发，各取若干，含命中标题与 rel）')
say('-'.repeat(78))
const pickSpread = (arr, n) => {
  if (arr.length <= n) return arr
  const step = arr.length / n
  return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)])
}
say('')
say('【触发·严格门槛命中（全部列出，不抽样）】')
for (const r of realStrict.slice().sort((a, b) => b.maxRel - a.maxRel)) {
  say(`  rel=${fx(r.maxRel)} chars=${r.chars} session=${r.sessionId.slice(0, 12)}`)
  say(`    Q: ${r.text.replace(/\s+/g, ' ').slice(0, 110)}`)
  say(`    top: "${String(r.top?.title ?? '').slice(0, 70)}"`)
}
if (realStrict.length === 0) say('  （零条）')
say('')
say('【触发·短消息清单（<=20 码点，全部列出按 rel 降序）——这是最需要人眼核对相关性的一类】')
const shortTrig = realLoose.filter((r) => r.chars <= 20).sort((a, b) => b.maxRel - a.maxRel)
say(`  短消息触发 ${shortTrig.length} / ${realLoose.length} 个触发轮次；短消息总共 ${realResults.filter((r) => r.chars <= 20).length} 轮`)
for (const r of shortTrig) {
  say(`  rel=${fx(r.maxRel)}/weak=${r.nWeak} Q="${r.text.replace(/\s+/g, ' ').slice(0, 30)}" → "${String(r.top?.title ?? '').slice(0, 46)}"`)
}
say('  判读提示：上面这些短消息多为「ok / 好的 / 已重启」这类确认语，它们没有话题内容；')
say('  命中的是库里无处不在的通用词元（如标题里出现的 `ok`、`重启`）。这不是「话题相关」。')
say('')
say('【触发·抽样（按 max rel 降序取 4 条，看命中的确像同一话题）】')
for (const r of pickSpread(realLoose.slice().sort((a, b) => b.maxRel - a.maxRel), 4)) {
  say(`  rel=${fx(r.maxRel)} match=${lvl(r)} chars=${r.chars} session=${r.sessionId.slice(0, 12)}`)
  say(`    Q: ${r.text.replace(/\s+/g, ' ').slice(0, 110)}`)
  for (let i = 0; i < Math.min(3, r.rels.length); i += 1) {
    say(`    #${i + 1} rel=${fx(r.rels[i])}  ${String(r.topN[i] ?? '').slice(0, 56)}`)
  }
}
say('')
say('【边缘触发 / 零表面重叠（噪声嫌疑最大，如实列出）】')
const flagged = [...new Set([...marginal, ...noSurface])].slice(0, 4)
for (const r of flagged) {
  say(`  rel=${fx(r.maxRel)} surface=${r.surface} chars=${r.chars} session=${r.sessionId.slice(0, 12)}`)
  say(`    Q: ${r.text.replace(/\s+/g, ' ').slice(0, 110)}`)
  say(`    top: "${String(r.top?.title ?? '').slice(0, 60)}" rel=${fx(r.top?.rel ?? 0)}`)
}
say('')
say('【未触发（一个 weak 都没有）】')
for (const r of pickSpread(allNone, 4)) {
  say(`  maxRel=${fx(r.maxRel)} chars=${r.chars} session=${r.sessionId.slice(0, 12)}`)
  say(`    Q: ${r.text.replace(/\s+/g, ' ').slice(0, 110)}`)
  say(`    top: "${String(r.top?.title ?? '').slice(0, 60)}" rel=${fx(r.top?.rel ?? 0)}`)
}
if (allNone.length === 0) say('  （无——真实会话侧没有任何一轮是完全不触发的）')

// ── §6 敏感性：查询长度分桶 + 截断 ─────────────────────────────────────────
say('')
say('§6 敏感性对照（都只为说明「真实侧数字受什么影响」，不改变主结论口径）')
say('-'.repeat(78))
say('6a 加一条「最短查询长度」闸门后的触发率（1~2 个字符的查询是假命中主源）:')
say('  最短长度   保留轮次   宽松触发            严格触发')
for (const minChars of [1, 4, 8, 12, 20]) {
  const rows = realResults.filter((r) => r.chars >= minChars)
  const l = rows.filter((r) => r.nWeak > 0).length
  const s = rows.filter((r) => r.maxRel >= STRONG_THRESHOLD).length
  say(`  >=${String(minChars).padEnd(8)} ${String(rows.length).padStart(7)}   ${(pct(l, rows.length) + ` (${l}/${rows.length})`).padEnd(18)} ${pct(s, rows.length)} (${s}/${rows.length})`)
}
say('  （对照：240 条无关查询全部 >=4 码点，其宽松触发率 5.0% 不受这道闸门影响）')
say('')
const distinctQ = new Set(realResults.map((r) => r.text)).size
say(`6b 轮次文本重复度：${realResults.length} 轮里只有 ${distinctQ} 条不同文本（去重率 ${pct(realResults.length - distinctQ, realResults.length)}）`)
say('  最高频的几条（同一个查询会反复触发同一批记忆）:')
const qFreq = new Map()
for (const r of realResults) qFreq.set(r.text, (qFreq.get(r.text) ?? 0) + 1)
for (const [q, n] of [...qFreq].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
  say(`    x${String(n).padStart(2)}  "${q.replace(/\s+/g, ' ').slice(0, 40)}"`)
}
const buckets = [
  { name: '<50 码点', lo: 0, hi: 50 },
  { name: '50-199', lo: 50, hi: 200 },
  { name: '200-999', lo: 200, hi: 1000 },
  { name: '>=1000', lo: 1000, hi: Infinity },
]
say('6c 按查询长度分桶的触发率（★实测与直觉相反：抬高的不是长文，是短口语消息）:')
say('  桶            轮次   宽松触发   严格触发')
for (const b of buckets) {
  const rows = realResults.filter((r) => r.chars >= b.lo && r.chars < b.hi)
  if (!rows.length) { say(`  ${b.name.padEnd(12)} ${String(0).padStart(5)}`); continue }
  const l = rows.filter((r) => r.nWeak > 0).length
  const s = rows.filter((r) => r.maxRel >= STRONG_THRESHOLD).length
  say(`  ${b.name.padEnd(12)} ${String(rows.length).padStart(5)} ${pct(l, rows.length).padStart(9)} ${pct(s, rows.length).padStart(9)}`)
}
const truncReal = []
for (const r of realResults) {
  const q = Array.from(r.text).slice(0, TRUNC_POINTS).join('')
  const p = await probe(q)
  truncReal.push({ ...r, ...p })
}
const truncLoose = truncReal.filter((r) => r.nWeak > 0)
const truncStrict = truncReal.filter((r) => r.maxRel >= STRONG_THRESHOLD)
say('')
say(`6d 查询截断到前 ${TRUNC_POINTS} 码点后重跑（同一批轮次）:`)
say(`  宽松 ${pct(truncLoose.length, truncReal.length)} (${truncLoose.length}/${truncReal.length})   严格 ${pct(truncStrict.length, truncReal.length)} (${truncStrict.length}/${truncReal.length})`)
const truncNeg = []
for (const q of negQueries) {
  const p = await probe(Array.from(q).slice(0, TRUNC_POINTS).join(''))
  truncNeg.push({ query: q, ...p })
}
say(`  同一截断下 240 无关查询: 宽松 ${pct(truncNeg.filter((r) => r.nWeak > 0).length, truncNeg.length)}   严格 ${pct(truncNeg.filter((r) => r.maxRel >= STRONG_THRESHOLD).length, truncNeg.length)}`)
say('')
// 次要口径：若把 24 条**子代理提示词**也当查询（它们同样是 user 角色、也会进模型上下文）。
const subRate = { n: 0, loose: 0, strict: 0 }
for (const s of sessions) {
  if (s.depth === 0) continue
  let text
  try {
    ({ text } = decompress(s.file))
  } catch {
    continue
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev?.type !== 'user/message') continue
    if (ev.data?.source?.kind !== 'user') continue
    if (typeof ev.data?.source?.rpcId === 'string' && ev.data.source.rpcId !== '') continue // 那是人
    const t = textOf(ev.data).trim()
    if (t === '') continue
    const p = await probe(t)
    subRate.n += 1
    if (p.nWeak > 0) subRate.loose += 1
    if (p.maxRel >= STRONG_THRESHOLD) subRate.strict += 1
  }
}
say(`6e 次要口径：把 ${subRate.n} 条**子代理委派提示词**也当查询（它们同样是 user 角色进上下文）:`)
say(`  宽松 ${pct(subRate.loose, subRate.n)} (${subRate.loose}/${subRate.n})   严格 ${pct(subRate.strict, subRate.n)} (${subRate.strict}/${subRate.n})`)
say('  注意：这不是「人的话题信号」，列为次要口径只是说明「若自动召回不看 source，会连子代理提示词一起算」。')
say('')
say('6f 阈值敏感性（本机**在装**的构建与仓库 HEAD 标定值不同；用装机值重算真实侧触发率）:')
const LIVE = { weak: 0.0363, strong: 0.1476 } // 由本机在装构建的 memory_recall 表头实测回显：match:rel>=0.0363 weak、>=0.1476 strong；score=disp 用 0.0187/0.342
const liveLoose = realResults.filter((r) => r.rels.some((x) => x >= LIVE.weak))
const liveStrict = realResults.filter((r) => r.maxRel >= LIVE.strong)
const negLiveLoose = negResults.filter((r) => r.rels.some((x) => x >= LIVE.weak))
const negLiveStrict = negResults.filter((r) => r.maxRel >= LIVE.strong)
say(`  装机阈值 weak=${LIVE.weak} strong=${LIVE.strong}`)
say(`  真实侧 宽松 ${pct(liveLoose.length, realResults.length)}  严格 ${pct(liveStrict.length, realResults.length)}`)
say(`  无关侧 宽松 ${pct(negLiveLoose.length, negResults.length)}  严格 ${pct(negLiveStrict.length, negResults.length)}`)

// ── §8 判读（脚本自己给结论，数字全部从上文算出，不手抄）────────────────────
say('')
say('§8 判读（本工作区口径；数字均由上文算出）')
say('-'.repeat(78))
const liftLoose = (realLoose.length / realResults.length) / (negLoose.length / negResults.length)
say(`1) 宽松门槛把真实侧抬到 ${pct(realLoose.length, realResults.length)}（无关侧 ${pct(negLoose.length, negResults.length)}，倍数 ${liftLoose.toFixed(1)}x）——`)
say(`   倍数看着高，但无关侧自己就有 ${pct(negLoose.length, negResults.length)} 的触发率，说明「过弱门槛」在**完全无关**的文本上也会发生，`)
say(`   弱门槛本身不是相关性判据。`)
say(`2) 严格门槛真实侧只剩 ${realStrict.length} 轮 (${pct(realStrict.length, realResults.length)})，其中 ${realStrict.filter((r) => r.chars <= 3).length} 轮是 1~3 个字符的会话性短消息`)
say(`   （${realStrict.filter((r) => r.chars <= 3).map((r) => `"${r.text.replace(/\s+/g, ' ')}"`).join(' / ')}）——`)
say(`   严格门槛**不是**相关性保证：单字查询也能拿 strong。`)
const min12 = realResults.filter((x) => x.chars >= 12)
say(`3) 「首轮+文本变化时」在本机省不下东西：宽松门槛下每轮注入 ${shapeLoose.everyTurn} 次 vs 变化时注入 ${shapeLoose.changeOnly} 次`)
say(`   （变频率 ${pct(chAll.changed, chAll.pairs)}，相邻两轮 top-3 几乎总会变）。真正的省法是加闸门：最短长度 >=12 码点 ⇒ 宽松降到 ${pct(min12.filter((x) => x.nWeak > 0).length, min12.length)}；`)
say(`   或只做「首轮一次」= 全机 ${shapeLoose.firstOnly} 次注入 / ${realResults.length} 轮。`)
say(`4) 事实核对：短消息(<=20 码点) ${realResults.filter((r) => r.chars <= 20).length} 轮触发 ${shortTrig.length} 轮；长消息(>=200 码点) ${realResults.filter((r) => r.chars >= 200).length} 轮触发 ${realResults.filter((r) => r.chars >= 200 && r.nWeak > 0).length} 轮。`)

// ── §9 只读守卫（after）────────────────────────────────────────────────────
const guardAfter = storeGuard()
say('')
say('§9 只读守卫（运行后复核）')
say('-'.repeat(78))
say(`  sha256   ${guardAfter.sha256}`)
say(`  字节/条数 ${guardAfter.bytes} / ${guardAfter.lines}`)
say(`  mtimeMs  ${guardAfter.mtimeMs}`)
const unchanged = guardAfter.sha256 === guardBefore.sha256 && guardAfter.bytes === guardBefore.bytes
say(`  结论: ${unchanged ? '未变（只读成立）' : '★ 变了！本脚本动了记忆库，必须排查'}`)

// ── 落盘证据 ───────────────────────────────────────────────────────────────
const txtPath = join(HERE, 'i8-autorecall-fire-rate.txt')
const jsonPath = join(HERE, 'i8-autorecall-fire-rate.json')
writeFileSync(txtPath, out.join('\n') + '\n')
writeFileSync(jsonPath, JSON.stringify({
  generatedBy: 'redproof/i8-autorecall-fire-rate.mjs',
  store: { path: guardBefore.path, sha256: guardBefore.sha256, bytes: guardBefore.bytes, lines: guardBefore.lines },
  inputFingerprint: inputFp,
  sessionsDirUsed: SESSIONS_DIR_USED,
  thresholds: { weak: WEAK_THRESHOLD, strong: STRONG_THRESHOLD, scaleA: SCALE_A, scaleB: SCALE_B },
  liveThresholds: LIVE,
  frozenNow: FROZEN_NOW,
  classification: Object.fromEntries(clsTotals),
  sessions: sessions.map((s) => ({ id: s.id, depth: s.depth, counts: Object.fromEntries(s.counts), humans: s.humans.length, events: s.events, undelivered: s.undelivered })),
  real: {
    turns: realResults.map((r) => ({ session: r.sessionId, chars: r.chars, maxRel: r.maxRel, nWeak: r.nWeak, nStrong: r.nStrong, topTitle: r.top?.title ?? null, topRel: r.top?.rel ?? null, surface: r.surface, topN: r.topN, q: r.text.replace(/\s+/g, ' ').slice(0, 200) })),
    looseRate: realLoose.length / realResults.length,
    strictRate: realStrict.length / realResults.length,
    changePairs: chAll.pairs, changeCount: chAll.changed,
    shapes: { none: shapeNone, loose: shapeLoose, strict: shapeStrict },
    budget: { loose: { mean: mean(budget), median: median(budget), n: budget.length }, strict: { mean: mean(budgetStrict), median: median(budgetStrict), n: budgetStrict.length }, none: { mean: mean(budgetNone), median: median(budgetNone), n: budgetNone.length } },
    perSession: [...perSession].map(([sid, rows]) => ({ session: sid, turns: rows.length, loose: rows.filter((r) => r.nWeak > 0).length, strict: rows.filter((r) => r.maxRel >= STRONG_THRESHOLD).length })),
    strictHits: realStrict.map((r) => ({ session: r.sessionId, q: r.text.replace(/\s+/g, ' ').slice(0, 120), maxRel: r.maxRel, top: r.top?.title ?? null })),
    shortTriggered: shortTrig.map((r) => ({ q: r.text.replace(/\s+/g, ' ').slice(0, 60), maxRel: r.maxRel, nWeak: r.nWeak, top: r.top?.title ?? null })),
  },
  negative: {
    n: negResults.length,
    looseRate: negLoose.length / negResults.length,
    strictRate: negStrict.length / negResults.length,
    looseHits: negLoose.map((r) => ({ q: r.query, maxRel: r.maxRel, top: r.top?.title ?? null })),
  },
  truncation: {
    points: TRUNC_POINTS,
    realLooseRate: truncLoose.length / truncReal.length,
    realStrictRate: truncStrict.length / truncReal.length,
    negLooseRate: truncNeg.filter((r) => r.nWeak > 0).length / truncNeg.length,
    negStrictRate: truncNeg.filter((r) => r.maxRel >= STRONG_THRESHOLD).length / truncNeg.length,
  },
  minQueryLength: [1, 4, 8, 12, 20].map((minChars) => {
    const rows = realResults.filter((r) => r.chars >= minChars)
    return {
      minChars, turns: rows.length,
      loose: rows.filter((r) => r.nWeak > 0).length,
      strict: rows.filter((r) => r.maxRel >= STRONG_THRESHOLD).length,
    }
  }),
  subagentPrompts: subRate,
  distinctQueries: distinctQ,
  readOnly: { before: guardBefore.sha256, after: guardAfter.sha256, unchanged },
}, null, 1))
console.log(`\n[证据] ${txtPath}\n[证据] ${jsonPath}`)
