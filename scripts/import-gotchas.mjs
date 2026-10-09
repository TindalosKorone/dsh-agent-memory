#!/usr/bin/env node
/**
 * gotchas.md 语料导入器：把坑位库（dsh-mobile-apk/docs/AGENTS/gotchas.md）导进记忆库
 * （`${DSH_HOME}/agent-memory/memory.ndjson`），攒语料供后续标定。
 *
 * 用法：
 *   node scripts/import-gotchas.mjs                 # 默认 dry-run：只报告，不写任何文件
 *   node scripts/import-gotchas.mjs --write         # 真写：先备份记忆库，再逐条经 store 原子写追加
 * 可选参数：
 *   --source <path>   语料源（默认 = 插件目录同级的 dsh-mobile-apk/docs/AGENTS/gotchas.md）
 *   --home <path>     覆盖 DSH_HOME（默认取环境变量 DSH_HOME，再默认内置 home）
 *   --stats           额外打印词表覆盖统计（每个话题命中多少条、哪些条目只有基础标签）
 *   --skip-existing-source
 *                     额外按 source 绝对去重：库内已有同一 source 的条目一律跳过（默认关闭，
 *                     因为规格的去重键是 kind+title；开启后对「同一坑位的人工改写版」也生效）
 *
 * 退出码：
 *   0  正常（含 dry-run 报告）
 *   1  前置条件不满足：lib/ 未构建、源文件不存在或为空、一条条目都没解析到、接受数为 0
 *   2  写盘过程有失败（失败关闭：逐条如实上报，已写入的部分不回滚，用备份恢复）
 *
 * 设计要点（与规格一一对应）：
 *  1. 解析：只认「行首编号 + 紧跟粗体标题」的行（`^(\d+)\.\s+\*\*`）为条目起点；
 *     标题的收尾 `**` 用「紧跟冒号 / 括号说明后跟冒号 / 退化取最后一个标记」三级判据定位
 *     （见 findTitleClose），因此标题内部还有 `**加粗**` 的条目（如 #145/#152/#240）也能取全；
 *     标题跨行时向后并接续行（上限见常量）。
 *     条目的「全部正文」= 标题收尾标记之后的同段文字 + 直到下一条目起点之前的全部行，原样保留。
 *     只按行边界归属，不做摘要、不丢行；解析到的条目数 = 源文件里所有 `^NNN. **` 行数。
 *  2. 映射：每条一份 lesson。title 派生规则见 deriveTitle（合规前缀，原始标题全文进 body 首行）。
 *     tags 用固定词表（VOCAB，40 项 ≤ 40）按正文是否出现来打标，最多 5 个 + 基础标签「坑位」。
 *  3. 校验：每条都过 lib/protocol.js 的真实 validateDraft，并用 lib/store.js 的 checkRecordSize
 *     复核单条字节上限（maxBytes 的 10%）。**失败关闭：不合规的条目绝不改写、绝不落盘**，
 *     一律进「被拒」清单并附可读原因（validateDraft 的 code + 修复指引原文）。
 *  4. 去重：库里已有（kind + 归一化 title 相同，用 store.mergeKey 的口径）⇒ 计入「跳过（已存在）」，
 *     本批内出现同键的后一条也计入跳过（并在报告里分开计数），绝不重复写入。
 *     报告另有一条「出处重复提示」：source 与库内既有记录相同但标题不同的条目（典型场景 = 同一坑位
 *     先有人工改写版、此处再导原文）默认仍会写入（遵守规格的去重键）；要按出处一并跳过就加
 *     --skip-existing-source，此时它们计入「跳过（已存在出处）」。
 *  5. 安全：默认 dry-run；`--write` 前先把记忆库复制成 `memory.ndjson.bak-<时间戳>` 并打印绝对路径与
 *     字节数；写盘一律走 store.appendRecord（内部 = loadSnapshot + enforceCaps + saveRecords，
 *     即临时文件 + rename 的原子写），本脚本手搓的只有「备份」这一步（它天然是只读源 + 新文件）。
 *  6. 报告：解析/接受/被拒（逐条原因）/跳过/写入后总数与字节/备份路径，另打印前 3 条与被拒第一条的
 *     完整 JSON；空文件、文件不存在、一条都没解析到时给可读提示并非 0 退出（不崩栈）。
 */
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = dirname(HERE)

// ── 参数 ────────────────────────────────────────────────────────────────────

const ARGV = process.argv.slice(2)
const flagValue = (name) => {
  const i = ARGV.indexOf(name)
  return i >= 0 && ARGV[i + 1] !== undefined ? ARGV[i + 1] : undefined
}
const WRITE = ARGV.includes('--write')
const STATS = ARGV.includes('--stats')
const SKIP_EXISTING_SOURCE = ARGV.includes('--skip-existing-source')
const SOURCE = resolve(flagValue('--source') ?? join(PLUGIN_DIR, '..', 'dsh-mobile-apk', 'docs', 'AGENTS', 'gotchas.md'))
const HOME_OVERRIDE = flagValue('--home')
/** 记忆记录的 source 前缀（实际写 `前缀#<编号>`）。 */
const SOURCE_REF = 'file:dsh-mobile-apk/docs/AGENTS/gotchas.md'

// ── 复用插件自身的协议与存储层 ────────────────────────────────────────────────

let protocol
let store
try {
  protocol = await import('../lib/protocol.js')
  store = await import('../lib/store.js')
} catch (err) {
  console.error('无法加载 lib/：请先在插件目录执行 `node node_modules/typescript/bin/tsc -p .`。')
  console.error(`- 原始错误：${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

const CFG = HOME_OVERRIDE !== undefined && HOME_OVERRIDE.trim() !== '' ? { home: HOME_OVERRIDE } : {}
const MEM_PATH = store.memoryPath(CFG)
const MAX_BYTES = store.resolveMaxBytes(CFG)
const MAX_RECORD_BYTES = store.resolveMaxRecordBytes(CFG)

// ── 词表（确定性打标；顺序 = 优先级，稀有话题在前）─────────────────────────────
// 每个话题的 keys 只要有一个出现在条目文本里即命中；tags 按本数组顺序取前 5 个匹配项
// （顺序固定 ⇒ 同一输入恒定同一 tags；不依赖 Map 插入序、不用随机）。
// 顺序 = 在本语料上实测的命中条数升序（稀有优先）：越靠前的话题区分力越强，
// 一条记忆最多带 5 个话题标签时，先留住最说明问题的那几个。可用 --stats 复核。
// 词表规模上限 40（规格要求 ≤ 40），当前 40。
const BASE_TAG = '坑位'
const MAX_TOPIC_TAGS = 5
const VOCAB = [
  { tag: '协议v2', keys: ['协议 v2', 'ControlProtocolV2', '载荷 v2', 'v2 载荷'] },
  { tag: '红证', keys: ['红证'] },
  { tag: '引擎api', keys: ['ctx.shell', 'execute(spec)', 'ctx.settings', 'describe(options)', 'ctx.subprocess', '上游 api', '0.1.7 之前'] },
  { tag: '文档', keys: ['gotchas', 'agents/', 'known-gaps'] },
  { tag: '插件契约', keys: ['插件契约', '契约漂移', 'tool-contract', 'output.render', 'userrender', 'definetool', '注册数组', '工具声明', 'lossless', 'undefined 成员'] },
  { tag: '工具面', keys: ['工具面', 'tools()', '渐进披露', 'capability gate', '掩蔽'] },
  { tag: 'ksu', keys: ['ksum', 'ksu', 'root 通道', 'su 起', 'su 授权', 'chown', 'app_process'] },
  { tag: '通知', keys: ['通知', 'notify'] },
  { tag: '文件打开', keys: ['打开方式', 'pathopen', 'fileincoming', 'contentresolver', 'saf', 'openchooser'] },
  { tag: '几何', keys: ['inset', 'bounds', '像素', '屏幕尺寸', '宽度'] },
  { tag: 'node运行时', keys: ['node --', 'node v', 'execpath', 'openssl_conf'] },
  { tag: 'cdp', keys: ['cdp', 'consoleapicalled', 'runtime.enable', '插桩', 'getscriptsources'] },
  { tag: '截图', keys: ['截图', 'screencap', 'screen_read'] },
  { tag: '配对', keys: ['配对', 'pair'] },
  { tag: 'shizuku', keys: ['shizuku', 'userservice'] },
  { tag: '超时', keys: ['超时', 'timeout'] },
  { tag: '无障碍', keys: ['无障碍', 'a11y', 'accessibilityservice'] },
  { tag: '权限', keys: ['eacces', 'permission denied', 'appops', 'manage_external_storage'] },
  { tag: '签名', keys: ['签名', 'keystore', 'apksigner', '证书', 'signer'] },
  { tag: '页面注入', keys: ['页面注入', 'template 字符串', 'polyfill', '注入层', 'assets/patched', '反斜杠', 'index-'] },
  { tag: '虚拟屏', keys: ['虚拟屏', 'virtual-', 'vdisplay', 'virtualdisplay', 'displayid', 'display token', 'flag_own_content_only'] },
  { tag: '模型供应', keys: ['providers', 'reasoningefforts', 'llm-pi-ai', '模型'] },
  { tag: '注入', keys: ['注入器', 'inject-snapshot', 'applyruntimepatches', '补丁'] },
  { tag: 'ci', keys: ['远程 run', 'run 36', 'actions'] },
  { tag: 'adb', keys: ['adb', 'adbd'] },
  { tag: '存储挂载', keys: ['9p', 'fuse', '/storage/emulated', '/mnt/d', 'realpath', 'symlink', '符号链接', 'sanitizename'] },
  { tag: '假绿', keys: ['假绿', '假红', '假阳性', '静默全灭', '误报', '空过'] },
  { tag: 'termux', keys: ['termux', 'prefix', 'dpkg', 'apt-get', 'apt '] },
  { tag: '进程', keys: ['force-stop', '孤儿', 'linker64', '进程'] },
  { tag: '构建', keys: ['构建器', 'build-', 'gradlew', 'assembledebug', '打包链', 'build-apk'] },
  { tag: '发布', keys: ['发布', 'release', 'workflow run', '.github/workflows'] },
  { tag: '门禁', keys: ['门禁'] },
  { tag: '壳桥', keys: ['bridge', '壳侧', '桥'] },
  { tag: '测试', keys: ['单测', '测试', 'node --test'] },
  { tag: '快照', keys: ['快照'] },
  { tag: '会话', keys: ['session', '会话', 'surface 事件', 'subagent', 'surfaceop'] },
  { tag: 'ui渲染', keys: ['白屏', '渲染', '面板', 'webview', 'ui-layout', '悬浮窗', 'flashstatus'] },
  { tag: '判据', keys: ['判据'] },
  { tag: '编译', keys: ['kotlin', 'javac', 'd8 ', 'gradle', '编译', 'jar cf'] },
  { tag: '依赖', keys: ['npm', 'pnpm', 'registry', 'semver', 'lockfile', 'arborist', 'peer', 'overlay 登记', 'engine-overlay'] },
]

// ── 解析 gotchas.md ─────────────────────────────────────────────────────────

/** 条目起点：行首编号 + 紧跟粗体标记。列表项（`1. \`xxx\``）与续写行（`61 续：`）天然不匹配。 */
const ENTRY_START = /^(\d+)\.\s+\*\*/
/** 标题跨行时最多向后并接续行数与字符数（防御性上限，正常语料用不到）。 */
const TITLE_CONT_MAX_LINES = 20
const TITLE_CONT_MAX_CHARS = 2000

/**
 * 在「标题块文本」里找外层粗体的收尾 `**` 下标（不含该标记），找不到返回 -1。
 *
 * 注意：调用方传入的 text 已经吃掉行首的 `NNN. ` **与开头的 `**`**，所以 text[0] 就是标题正文。
 * 判据 = 从左到右扫每个 `**`，第一个满足下面任一条件的即外层收尾（先左后右保证不会吃进正文）：
 *   A：标记之后紧跟冒号（`：` 或 `:`），即 `**标题**：正文`；
 *   B：标记之后紧跟一个「不含冒号/粗体标记的短括号说明」再跟冒号，
 *      即 `**标题**（说明）：正文`（#152 是这种形态）。
 * 找不到 A/B 时退化为 F：取该块最后一个标记 —— 覆盖「整行就是标题」或「标题后是 `（…）` 无冒号」
 * 这类形态（本语料里 21 条），此时标题仍取全，残余文字照原样进正文。
 * 标题内部还有成对 `**加粗**` 的条目（#145/#157/#240 等）：内部标记既不紧跟冒号也不匹配 B，
 * 因此会被跳过；扫到真正的收尾标记才返回。
 */
function findTitleClose(text) {
  const marks = []
  let i = 0
  for (;;) {
    const k = text.indexOf('**', i)
    if (k < 0) break
    marks.push(k)
    i = k + 2
  }
  if (marks.length === 0) return { close: -1, rule: 'none' }
  for (const p of marks) {
    const rest = text.slice(p + 2)
    if (/^\s*[：:]/.test(rest)) return { close: p, rule: 'A' }
    if (/^\s*（[^：:**]{0,80}）\s*[：:]/.test(rest)) return { close: p, rule: 'B' }
  }
  return { close: marks[marks.length - 1], rule: 'F' }
}

/**
 * 解析全部条目。返回 { entries, warnings, rules }，entries 按源文件出现顺序。
 * 每条：{ num, titleRaw, bodyRaw, titleLine }
 * 不丢条目：凡匹配 ENTRY_START 的行必产出一条；正文一律取到「下一条目起点行」为止。
 */
function parseGotchas(text) {
  const lines = text.split(/\r?\n/)
  const starts = []
  for (let i = 0; i < lines.length; i += 1) {
    const m = ENTRY_START.exec(lines[i])
    if (m !== null) starts.push({ num: Number(m[1]), line: i, leadLen: m[0].length })
  }
  const warnings = []
  const rules = { A: 0, B: 0, F: 0, none: 0 }
  const entries = []
  for (let s = 0; s < starts.length; s += 1) {
    const cur = starts[s]
    const nextLine = s + 1 < starts.length ? starts[s + 1].line : lines.length
    let block = lines[cur.line].slice(cur.leadLen)
    let consumed = 1
    let res = findTitleClose(block)
    // 标题跨行（本语料没有，防御性支持）：首行判不出收尾标记就向后并接续行再判。
    while (res.rule === 'none' && consumed < TITLE_CONT_MAX_LINES && cur.line + consumed < nextLine) {
      block += ` ${lines[cur.line + consumed].trim()}`
      consumed += 1
      if (block.length > TITLE_CONT_MAX_CHARS) break
      res = findTitleClose(block)
    }
    rules[res.rule] += 1
    const titleRaw = (res.close >= 0 ? block.slice(0, res.close) : block).trim()
    if (titleRaw === '') {
      warnings.push(`第 ${cur.num} 条（源文件第 ${cur.line + 1} 行）：标题解析为空，已如实上报（不会被静默丢弃）`)
    }
    // 标题收尾标记之后的同段残余（去掉紧跟的冒号）算正文第一段；再拼后续全部行。
    let rest = res.close >= 0 ? block.slice(res.close + 2) : ''
    rest = rest.replace(/^\s*[：:]\s*/, '')
    const bodyStart = cur.line + consumed // 已并入标题块的首行之后
    const bodyLines = []
    if (rest.trim() !== '') bodyLines.push(rest)
    for (let i = bodyStart; i < nextLine; i += 1) bodyLines.push(lines[i])
    // 去掉首尾空行（内容原样，只裁边界空白）
    while (bodyLines.length > 0 && bodyLines[0].trim() === '') bodyLines.shift()
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop()
    entries.push({
      num: cur.num,
      titleRaw,
      bodyRaw: bodyLines.join('\n'),
      titleLine: cur.line + 1,
      // 该条目在源文件里「标题行之后」的全部原始行（用于正文覆盖自证：不许有行被静默丢弃）。
      sourceLines: lines.slice(cur.line + 1, nextLine),
    })
  }
  return { entries, warnings, rules }
}

// ── 映射：条目 → 记忆草稿 ─────────────────────────────────────────────────────

/** 单行化：换行与连续空白压成一个空格并去首尾空白（title 必须单行）。 */
function oneLine(text) {
  return text.replace(/\s+/g, ' ').trim()
}

/** 断句分隔符（按「从上一次出现处继续找」的方式取全部出现位置）。 */
const CUT_MARKS = ['⇒', '：', '（', '→', '——', '；', '。']

/**
 * title 派生规则（必须与注释、汇报一致）：
 *   1) 去掉粗体标记 `**`、把全部空白（含换行）压成单空格、去首尾空白；
 *   2) 若长度 ≤ 120（protocol.TITLE_MAX）⇒ 原样作为 title；
 *   3) 否则在分隔符 `⇒ / ： / （ / → / —— / ； / 。` **处断句**：取「不越过 120 的最靠后的
 *      分隔符位置」作为截点（截点必须在正文之前 ⇒ 结果仍是原标题的合规前缀）；
 *   4) 断不出（或断出的前缀短于 8 字符）⇒ 硬截到 120；
 *   5) 长度 < 8（极端畸形）**不修**，交给 validateDraft 拒收（失败关闭，见报告）。
 * 原标题的完整原文（含内部 `**` 标记、压平为单行）另存 body 首行，信息不丢。
 */
function deriveTitle(rawTitle) {
  const flat = oneLine(rawTitle).replace(/\*\*/g, ' ').replace(/\s+/g, ' ').trim()
  if (flat.length <= protocol.TITLE_MAX) return flat
  let cut = -1
  for (const mark of CUT_MARKS) {
    let from = 0
    for (;;) {
      const k = flat.indexOf(mark, from)
      if (k < 0) break
      if (k <= protocol.TITLE_MAX && k > cut) cut = k
      from = k + mark.length
    }
  }
  if (cut >= protocol.TITLE_MIN) return flat.slice(0, cut).trim()
  return flat.slice(0, protocol.TITLE_MAX).trim()
}

/** 词表打标：命中项按 VOCAB 顺序取前 5，基础标签恒在最前；归一化去重兜底。 */
function deriveTags(text) {
  const low = text.toLowerCase()
  const tags = [BASE_TAG]
  const seen = new Set([BASE_TAG])
  for (const item of VOCAB) {
    if (tags.length > MAX_TOPIC_TAGS) break
    let hit = false
    for (const key of item.keys) {
      if (low.includes(key.toLowerCase())) { hit = true; break }
    }
    if (!hit) continue
    const tag = protocol.normalizeTag(item.tag)
    if (seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
  }
  return tags
}

/** 条目 → 草稿（未校验）。 */
function toDraft(entry) {
  const rawTitleOneLine = oneLine(entry.titleRaw)
  return {
    kind: 'lesson',
    title: deriveTitle(entry.titleRaw),
    body: `原标题：${rawTitleOneLine}\n${entry.bodyRaw}`,
    tags: deriveTags(`${entry.titleRaw}\n${entry.bodyRaw}`),
    source: `${SOURCE_REF}#${entry.num}`,
  }
}

// ── 读库、去重、校验 ──────────────────────────────────────────────────────────

function loadExisting() {
  if (!existsSync(MEM_PATH)) return { records: [], bytes: 0 }
  const text = readFileSync(MEM_PATH, 'utf8')
  const recs = []
  let badLines = 0
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    let parsed
    try { parsed = JSON.parse(t) } catch { badLines += 1; continue }
    const rec = protocol.normalizeStoredRecord(parsed)
    if (rec === undefined) badLines += 1
    else recs.push(rec)
  }
  return { records: recs, bytes: Buffer.byteLength(text, 'utf8'), badLines }
}

/** 去重键：与 store.mergeKey 同口径（kind + trim+小写化后的 title）。 */
const dedupKey = (rec) => store.mergeKey(rec)

// ── 主流程 ──────────────────────────────────────────────────────────────────

console.log('gotchas.md 语料导入器（dsh-agent-memory）')
console.log(`- 模式：${WRITE ? '--write（会先备份再写盘）' : 'dry-run（只报告，不写任何文件）'}`)
console.log(`- 语料源：${SOURCE}`)
console.log(`- 记忆库：${MEM_PATH}`)
console.log(`- 上限：maxBytes=${MAX_BYTES} 单条上限=${MAX_RECORD_BYTES}（maxBytes 的 10%）`)

if (!existsSync(SOURCE)) {
  console.error(`\n[失败] 语料源不存在：${SOURCE}`)
  console.error('- 可用 `--source <path>` 指定 gotchas.md；本脚本不会创建该文件。')
  process.exit(1)
}
const sourceStat = statSync(SOURCE)
const sourceText = readFileSync(SOURCE, 'utf8')
if (sourceText.trim() === '') {
  console.error(`\n[失败] 语料源是空文件（0 字节 / 全空白）：${SOURCE}`)
  process.exit(1)
}

const { entries, warnings, rules } = parseGotchas(sourceText)
console.log(`- 源文件：${sourceStat.size} 字节，${sourceText.split('\n').length} 行`)
console.log(`- 解析到条目：${entries.length} 条`
  + `（编号范围 ${entries.length > 0 ? `${Math.min(...entries.map((e) => e.num))}..${Math.max(...entries.map((e) => e.num))}` : 'n/a'}，`
  + '编号有缺失属上游文件的正常形态，按实际解析为准）')
console.log(`- 标题收尾判据：A（紧跟冒号）${rules.A} 条 / B（括号说明后跟冒号）${rules.B} 条 / `
  + `F（取最后一个标记：整行标题或尾部括号）${rules.F} 条${rules.none > 0 ? ` / 未判出 ${rules.none} 条` : ''}`)
for (const w of warnings) console.log(`  [警告] ${w}`)

if (entries.length === 0) {
  console.error('\n[失败] 一条条目都没解析到（期望行首形如 `NNN. **标题**：正文`）。')
  console.error('- 若源文件格式变了，请先核对；本脚本不猜测、不静默返回空结果。')
  process.exit(1)
}

const existing = loadExisting()
console.log(`- 库内现有：${existing.records.length} 条，${existing.bytes} 字节`
  + `${existing.badLines !== undefined && existing.badLines > 0 ? `（另有 ${existing.badLines} 行不可用）` : ''}`)

const existingKeys = new Set(existing.records.map(dedupKey))
const existingSources = new Set(existing.records.map((r) => r.source))
const batchKeys = new Set()
const accepted = []
const rejected = []
const skipped = []

/** 先做完整的「条目 → 草稿」映射（--stats 与主流程共用同一批草稿，保证口径一致）。 */
const mapped = entries.map((entry) => ({ num: entry.num, draft: toDraft(entry) }))

for (const { num, draft } of mapped) {
  // 1) 真实协议校验（失败关闭：不合规绝不改写，直接进被拒清单）
  const v = protocol.validateDraft(draft)
  if (!v.ok) {
    rejected.push({ num, code: v.code, text: v.text, draft })
    continue
  }
  // 2) 单条字节上限（store 的真实判据；超限同样失败关闭）
  const skeleton = { id: 'mem_size_probe', ts: 0, ...v.value, hits: 0 }
  const size = store.checkRecordSize(skeleton, CFG)
  if (!size.ok) {
    rejected.push({
      num,
      code: 'record-too-large',
      text: `写入被拒（失败关闭，未落盘）。\n- 违规项：单条序列化 ${size.bytes} 字节，超过单条上限 ${size.limit} 字节\n`
        + `- 规则：单条不得超过 maxBytes(${MAX_BYTES}) 的 10%\n- 修复：把该条正文拆成多条后重试。`,
      draft,
    })
    continue
  }
  // 3) 去重（库里已有 + 可选按出处去重 + 本批内重复，三处分开计数）
  const key = dedupKey(v.value)
  if (existingKeys.has(key)) {
    skipped.push({ num, where: '已存在', title: v.value.title })
    continue
  }
  if (SKIP_EXISTING_SOURCE && existingSources.has(v.value.source)) {
    skipped.push({ num, where: '已存在出处', title: v.value.title })
    continue
  }
  if (batchKeys.has(key)) {
    skipped.push({ num, where: '本批重复', title: v.value.title })
    continue
  }
  batchKeys.add(key)
  accepted.push({ num, draft: v.value, bytes: size.bytes })
}

// ── 派生规则自证（证明「不派生就会被真实协议拒」，即失败关闭链路是活的）────────
let selfCheck
for (const entry of entries) {
  const raw = oneLine(entry.titleRaw)
  if (raw.length > protocol.TITLE_MAX) {
    const probe = protocol.validateDraft({
      kind: 'lesson', title: raw, body: '自证探针', tags: [BASE_TAG], source: `${SOURCE_REF}#${entry.num}`,
    })
    selfCheck = { num: entry.num, rawLen: raw.length, derivedLen: deriveTitle(entry.titleRaw).length, ok: probe.ok, code: probe.ok ? 'ok' : probe.code }
    break
  }
}

// ── 报告：解析与映射 ─────────────────────────────────────────────────────────

console.log('\n== 映射结果 ==')
console.log(`- 接受：${accepted.length} 条`)
console.log(`- 被拒：${rejected.length} 条`)
const skipExisting = skipped.filter((s) => s.where === '已存在').length
const skipSource = skipped.filter((s) => s.where === '已存在出处').length
const skipBatch = skipped.filter((s) => s.where === '本批重复').length
console.log(`- 跳过：${skipped.length} 条（已存在 ${skipExisting} / 已存在出处 ${skipSource} / 本批重复 ${skipBatch}）`)
const sameSource = mapped.filter((m) => existingSources.has(m.draft.source)).length
if (sameSource > 0) {
  console.log(`- 出处重复提示：${sameSource} 条条目的 source 与库内既有记录相同但标题不同`
    + `（规格去重键是 kind+title ⇒ ${SKIP_EXISTING_SOURCE ? '本次按出处跳过' : '默认仍会写入'}；`
    + `${SKIP_EXISTING_SOURCE ? '如需写入可去掉 --skip-existing-source' : '如需按出处跳过就加 --skip-existing-source'}）`)
}

if (selfCheck !== undefined) {
  console.log('\n== title 派生自证 ==')
  console.log(`- 原标题超限的条目：#${selfCheck.num}（原标题 ${selfCheck.rawLen} 字符 > ${protocol.TITLE_MAX}）`)
  console.log(`- 按派生规则截到 ${selfCheck.derivedLen} 字符；`)
  console.log(`- 同一标题若不派生直接过 validateDraft：ok=${selfCheck.ok} code=${selfCheck.code}`
    + `（${selfCheck.ok ? '未被拒，自证失败' : '被拒 ⇒ 失败关闭链路有效'}）`)
  if (selfCheck.ok) process.exitCode = 1
}
const rawOver = entries.filter((e) => oneLine(e.titleRaw).length > protocol.TITLE_MAX).map((e) => e.num)
console.log(`- 源文件里原标题超过 ${protocol.TITLE_MAX} 字符的条目：${rawOver.length} 条`
  + `${rawOver.length > 0 ? `（#${rawOver.join(', #')}）` : ''}`)

// 正文覆盖自证：源文件里「标题行之后」的每一行都必须原样出现在对应草稿的 body 里。
// 这条断言独立于解析逻辑，用来证明「不丢正文行」（标题行的正文残余已并入 body 首段）。
let coverTotal = 0
const coverMissing = []
for (let i = 0; i < entries.length; i += 1) {
  const srcLines = entries[i].sourceLines
  const body = mapped[i].draft.body
  for (const ln of srcLines) {
    if (ln.trim() === '') continue
    coverTotal += 1
    if (!body.includes(ln)) coverMissing.push(`#${entries[i].num}：${ln.trim().slice(0, 60)}`)
  }
}
console.log(`- 正文覆盖自证：标题行之后的源文件行 ${coverTotal} 行，全部原样进入 body`
  + `（缺失 ${coverMissing.length} 行${coverMissing.length > 0 ? ` ⇒ ${coverMissing.slice(0, 5).join(' / ')}` : ''}）`)

// 词表覆盖统计（--stats）：每个话题命中多少条、有多少条目拿不到任何话题标签（只有基础标签）。
if (STATS) {
  const counts = new Map(VOCAB.map((v) => [v.tag, 0]))
  let noTopic = 0
  const noTopicList = []
  for (const m of mapped) {
    const topic = m.draft.tags.filter((t) => t !== BASE_TAG)
    if (topic.length === 0) { noTopic += 1; noTopicList.push(m.num); continue }
    for (const t of topic) counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  console.log('\n== 词表覆盖统计（--stats）==')
  console.log(`- 话题标签 ${VOCAB.length} 个（上限 40）；每条最多取 ${MAX_TOPIC_TAGS} 个 + 基础标签「${BASE_TAG}」`)
  const rows = [...counts.entries()].sort((a, b) => a[1] - b[1])
  for (const [tag, n] of rows) console.log(`  ${String(n).padStart(3)} 条  ${tag}`)
  console.log(`- 只有基础标签的条目：${noTopic} 条`
    + `${noTopicList.length > 0 ? `（#${noTopicList.slice(0, 40).join(', #')}${noTopicList.length > 40 ? ' …' : ''}）` : ''}`)
}

if (rejected.length > 0) {
  console.log('\n== 被拒清单（逐条原因；失败关闭，一律未落盘）==')
  for (const r of rejected) {
    const first = r.text.split('\n')[1] ?? ''
    console.log(`- #${r.num} [${r.code}] ${first}`)
  }
}

if (skipped.length > 0) {
  console.log('\n== 跳过清单（不重复写入）==')
  for (const s of skipped) console.log(`- #${s.num} [${s.where}] ${s.title}`)
}

console.log('\n== 前 3 条（完整 JSON，供人工核对）==')
for (const a of accepted.slice(0, 3)) {
  console.log(`--- #${a.num}（草稿 ${a.bytes} 字节）---`)
  console.log(JSON.stringify(a.draft, null, 2))
}
if (accepted.length === 0) console.log('(无接受条目)')

console.log('\n== 被拒的第一条（完整 JSON）==')
if (rejected.length > 0) {
  const r = rejected[0]
  console.log(JSON.stringify({ num: r.num, code: r.code, reason: r.text, draft: r.draft }, null, 2))
} else {
  console.log('(无被拒条目)')
}
// ── 写盘 ────────────────────────────────────────────────────────────────────

if (!WRITE) {
  console.log('\n== dry-run 结束：未写任何文件 ==')
  console.log(`- 若确认无误，重跑并加 --write：node scripts/import-gotchas.mjs --write`)
  process.exit(accepted.length === 0 ? 1 : (selfCheck !== undefined && selfCheck.ok ? 1 : 0))
}

if (accepted.length === 0) {
  console.error('\n[失败] 没有可写入的条目（全部被拒或已存在）；未写盘。')
  process.exit(1)
}

const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
const backupPath = `${MEM_PATH}.bak-${stamp}`
let backupBytes = 0
if (existsSync(MEM_PATH)) {
  copyFileSync(MEM_PATH, backupPath)
  backupBytes = statSync(backupPath).size
} else {
  console.error(`\n[失败] 记忆库不存在：${MEM_PATH}（先跑一次 memory_remember 让插件建库，或核对 --home）`)
  process.exit(1)
}

console.log('\n== 写盘 ==')
console.log(`- 备份：${backupPath}（${backupBytes} 字节）`)

let written = 0
const writeFailures = []
const evictedAll = []
for (const a of accepted) {
  try {
    const res = store.appendRecord(a.draft, CFG)
    written += 1
    for (const e of res.evicted) evictedAll.push(e.id)
  } catch (err) {
    writeFailures.push({ num: a.num, title: a.draft.title, message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) })
  }
}

const after = loadExisting()
console.log(`- 写入成功：${written} 条；写入失败：${writeFailures.length} 条`)
if (evictedAll.length > 0) console.log(`- 触发淘汰：${evictedAll.length} 条（库达到上限；按 score 从低到高淘汰）`)
if (writeFailures.length > 0) {
  console.log('- 写入失败明细（失败关闭，逐条如实上报）：')
  for (const f of writeFailures) console.log(`  #${f.num} ${f.title}：${f.message}`)
}
console.log(`- 写入后库内总数：${after.records.length} 条`)
console.log(`- 写入后占用：${after.bytes} 字节（上限 ${MAX_BYTES}）`)
if (after.badLines !== undefined && after.badLines > 0) {
  console.log(`- [失败] 写入后发现 ${after.badLines} 行不可用（JSON 坏行 / 形状不合）⇒ 立即用备份恢复：cp "${backupPath}" "${MEM_PATH}"`)
  process.exit(2)
}
console.log(`- 复查方式：node scripts/calibrate.mjs（只打印建议）`)
console.log(`- 恢复方式（如需）：cp "${backupPath}" "${MEM_PATH}"`)

process.exit(writeFailures.length > 0 ? 2 : 0)
