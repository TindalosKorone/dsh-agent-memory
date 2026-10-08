/**
 * I4a 测量脚本（先量再定）：用**真引擎**跑一遍注册 → assemble → 快照，并给出数字。
 *
 * 本脚本只读：默认 DSH_HOME 下那份真实记忆库（9 条），不写任何文件、不启动 DSH。
 * 运行：node scripts/i4a-measure.mjs
 *
 * 分三块，实测与「源码依据」严格分开写：
 *  1) 落点：真引擎 SystemPrompt.context 注册 → assemble().contexts → renderContextSnapshot()；
 *  2) 成本：字符数 / UTF-8 字节数 / dsh-token-meter 的固定启发式 token 估算（**不是**供应商计费 token）；
 *  3) 稳定性：连续 5 次 assemble 的快照逐字节比较（给出 SHA-256 前 16 位与首次差异位置）。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { apply } from '../lib/index.js'
import { INJECTION_CONTEXT_NAME, INJECTION_CONTEXT_ORDER, buildInjectionIndex } from '../lib/inject.js'
import { memoryPath } from '../lib/store.js'

const ENGINE_BASE = '/data/data/com.dsharnessmobile.shell/files/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const { Context } = await import(`${ENGINE_BASE}/cordis/lib/index.js`)
const sp = await import(`${ENGINE_BASE}/dsh-system-prompt/lib/index.js`)
// token-meter 的服务本体需要 sessionProjections（本脚本没有会话，服务不会激活），
// 所以直接用它 package.json 里公开的 `/estimate` 子路径（引擎自己的纯估算实现）。
const { estimateMessage } = await import(`${ENGINE_BASE}/dsh-token-meter/lib/types/estimate.js`)

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const line = (label) => console.log(`\n=== ${label} ===`)

// ── 0. 库况（只读）────────────────────────────────────────────────────────
line('0. 真实记忆库（只读）')
const storePath = memoryPath({})
console.log('库文件:', storePath)
console.log('存在:', existsSync(storePath))
const direct = buildInjectionIndex({})
console.log('条数:', direct.diag.count, '| 锚点:', JSON.stringify(direct.diag.anchors), '| 命中缓存:', direct.diag.cached)

// ── 1. 真引擎：注册 + assemble + 快照 ─────────────────────────────────────
line('1. 真引擎注册与 assemble（落点）')
const root = new Context()
const spRoot = root.plugin(sp.default)
await new Promise((r) => setTimeout(r, 20))
const service = root.get('systemPrompt')
console.log('systemPrompt 服务:', service !== undefined)

const defs = new Map()
apply({
  tools: { register: (d) => { defs.set(d.name, d) ; return { dispose: () => defs.delete(d.name) } } },
  effect: (cb) => cb(),
  systemPrompt: service,
}, {})
console.log('本插件注册的工具数:', defs.size)

const snapshots = []
const ourTexts = []
for (let i = 0; i < 5; i += 1) {
  const assembly = await service.assemble({})
  const mine = assembly.contexts.filter((c) => c.name === INJECTION_CONTEXT_NAME)
  const snapshot = sp.renderContextSnapshot(assembly)
  snapshots.push(snapshot)
  ourTexts.push(mine[0]?.text ?? '')
  if (i === 0) {
    console.log('contexts 顺序表（name @ order）:', assembly.contexts.map((c) => c.name).join(' -> '))
    console.log('我们的 context 名/顺序:', mine[0]?.name, '@', INJECTION_CONTEXT_ORDER)
    console.log('sections 段数（prompt 正文，未受影响）:', assembly.sections.length)
  }
  await new Promise((r) => setTimeout(r, 2))
}
const injected = ourTexts[0]
const snapshot = snapshots[0]
console.log('注入行:', JSON.stringify(injected))
console.log('完整快照:', JSON.stringify(snapshot))

// ── 2. 成本 ───────────────────────────────────────────────────────────────
line('2. 成本（字符 / 字节 / 引擎启发式 token）')
console.log('注入行 字符数:', injected.length, '| UTF-8 字节:', Buffer.byteLength(injected, 'utf8'))
console.log('快照总长 字符数:', snapshot.length, '（其中引擎自带表头', 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'.length, '字符）')
const msg = { role: 'user', content: [{ type: 'text', text: snapshot }] }
const lineMsg = { role: 'user', content: [{ type: 'text', text: injected }] }
console.log('token 估算（dsh-token-meter 固定启发式 CHARS_PER_TOKEN=4 + 块开销 4 + 角色帧 4）：')
console.log('  整份快照作为一条 user 消息:', estimateMessage(msg), 'token')
console.log('  仅注入行作为一条 user 消息:', estimateMessage(lineMsg), 'token')
console.log('  （这是启发式估算，不是供应商计费 token；本插件内部观测不到真实计费）')
console.log('  上限回显：maxChars=240 ⇒ 启发式 token 上限约', Math.ceil(240 / 4) + 8)

// ── 3. 稳定性 ─────────────────────────────────────────────────────────────
line('3. 稳定性（库不变 → 逐字节相同）')
const hashes = snapshots.map((s) => sha(s).slice(0, 16))
const lineHashes = ourTexts.map((s) => sha(s).slice(0, 16))
console.log('5 次快照 sha256[0:16]:', hashes.join(' '))
console.log('5 次注入行 sha256[0:16]:', lineHashes.join(' '))
console.log('快照全同:', new Set(snapshots).size === 1, '| 注入行全同:', new Set(ourTexts).size === 1)
console.log('注入行字节数:', ourTexts.map((s) => Buffer.byteLength(s, 'utf8')).join('/'))
console.log('（对照：库文件身份三元组 {path,size,mtimeMs} 不变时只读缓存命中，见 test/inject.test.mjs 用例）')

// ── 4. 落点的源码依据（不是实测，是引用）──────────────────────────────────
line('4. 落点源码依据（引用，非本脚本实测）')
console.log('dsh-agent-loop/lib/index.js:909-910  assemble -> renderContextSections -> joinContextSections -> runtimeContext.project')
console.log('  同文件 334-346  project() 返回 createUserMessage(source.kind="runtime-context")；337 文本未变即 return（不发消息）')
console.log('  同文件 1061 firstAttempt 时逐条 session.append("user/message", message) ⇒ 追加到本轮消息列表尾部（系统提示另走 1056 的 system/message）')
console.log('  dsh-system-prompt/lib/index.js:134  joinContextSections: body 为空 ⇒ 返回 ""（未注册/空文本时零影响）')

// ── 5. 无法从插件内部观测的部分（如实声明）───────────────────────────────
line('5. 无法从插件内部观测（不许写成实测）')
console.log('- 供应商 prompt 缓存命中率 / 缓存读写计费：本插件没有任何通道读请求头或使用量回执')
console.log('- 缓存收益是否成立取决于路由把「尾部追加的 user 消息」算不算可复用前缀：这属于供应商与路由侧行为')
console.log('- 本脚本能证明的最强命题：库不变时快照逐字节相同（引擎自己会因此不再发新消息）')

await spRoot.dispose?.()
