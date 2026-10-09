// 测试公共桩：全部测试只写插件目录下的 .tmp-test（绝不碰真实记忆库）。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PLUGIN_DIR = dirname(HERE)
export const TMP_ROOT = join(PLUGIN_DIR, '.tmp-test')

/** 建一个干净的临时 DSH_HOME，并把上限环境变量清掉（避免上一个用例污染）。 */
export function freshHome(name) {
  const dir = join(TMP_ROOT, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  process.env.DSH_HOME = dir
  delete process.env.DSH_AGENT_MEMORY_MAX_RECORDS
  delete process.env.DSH_AGENT_MEMORY_MAX_BYTES
  delete process.env.DSH_AGENT_MEMORY_MAX_RECORD_BYTES
  return dir
}

export function memFile(home) {
  return join(home, 'agent-memory', 'memory.ndjson')
}

/** 读回落盘的 NDJSON 行（文件不存在返回空数组）。 */
export function diskLines(home) {
  const p = memFile(home)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '')
}

export function diskText(home) {
  const p = memFile(home)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

/** 桩 ctx：收集工具定义、effect 清理函数、以及 I4a/I4a.3 的 systemPrompt 贡献（context + section）。 */
export function makeCtx() {
  const defs = new Map()
  const effects = []
  const contexts = new Map()
  const sections = new Map()
  const ctx = {
    tools: { register: (d) => { defs.set(d.name, d); return { dispose: () => defs.delete(d.name) } } },
    effect: (cb) => { effects.push(cb()) },
    // 桩 systemPrompt：形状与真引擎一致（贡献对象只用 name/order/text；order 必须是有限数字）。
    systemPrompt: {
      context: (contribution) => {
        if (!Number.isFinite(contribution?.order)) throw new TypeError('prompt context order must be a finite number')
        if (typeof contribution?.name !== 'string' || contribution.name === '') throw new TypeError('prompt context name must be a non-empty string')
        contexts.set(contribution.name, contribution)
        return { dispose: () => contexts.delete(contribution.name) }
      },
      // I4a.3：section 与 context 是**两张不同的注册表**（真引擎里分别是 layers.sections / layers.contexts）。
      // 校验口径照抄真实现：order 必须有限（否则 TypeError），name 非空。
      section: (contribution) => {
        if (!Number.isFinite(contribution?.order)) throw new TypeError('prompt section order must be a finite number')
        if (typeof contribution?.name !== 'string' || contribution.name === '') throw new TypeError('prompt section name must be a non-empty string')
        sections.set(contribution.name, contribution)
        return { dispose: () => sections.delete(contribution.name) }
      },
      // 与真引擎一致：**未列名返回 undefined**（dsh-system-prompt/lib/index.js:249-251）。
      // 桩刻意如实返回 undefined 而不是编一个默认值：插件若偷懒用它当 order，
      // section() 就会因「order 非有限」抛错 ⇒ 段注册不上 ⇒ 判红。这样「必须传显式数字」是自然判红的。
      getSectionOrder: () => undefined,
    },
    // 桩 ctx.inject：与 cordis 同语义 —— **任一**必需服务缺席 ⇒ 回调永不执行（fiber 停在 PENDING），
    // 齐全则把 scope（挂上这些服务的子 ctx）交给回调。插件已改成用这条路径条件注册注入面。
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
  return { ctx, defs, effects, contexts, sections }
}

/** apply 之后拿到 4 个工具定义（可传 MemoryConfig，把 FsOps 接缝注入进来做并发度观测/故障注入）。 */
export function tools(config = {}) {
  const { ctx, defs } = makeCtx()
  apply(ctx, config)
  return defs
}

/** apply 之后拿到 I4a 注册的 systemPrompt context 贡献（键 = context 名）。 */
export function appliedContexts(config = {}) {
  const { ctx, contexts } = makeCtx()
  apply(ctx, config)
  return contexts
}

/** apply 之后拿到 I4a.3 注册的 systemPrompt **section**（稳定段）贡献（键 = section 名）。 */
export function appliedSections(config = {}) {
  const { ctx, sections } = makeCtx()
  apply(ctx, config)
  return sections
}

/** 递归找出所有 undefined 值的路径（宿主按无损 JSON 整值校验，undefined 会整值拒收）。 */
export function findUndefined(value, path = '$') {
  const hits = []
  if (value === undefined) { hits.push(path); return hits }
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...findUndefined(v, `${path}[${i}]`)))
    return hits
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) hits.push(...findUndefined(v, `${path}.${k}`))
  }
  return hits
}

/** 输出无损断言：无 undefined + JSON 往返相等。 */
export function assertLossless(label, result) {
  assert.deepEqual(findUndefined(result), [], `${label}: 返回值含 undefined（宿主会整值拒收）`)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result, `${label}: JSON 往返不等价`)
}

/** 构造一条落盘记录（store 层测试用）。 */
export function record(id, ts, over = {}) {
  return {
    id,
    ts,
    kind: 'fact',
    title: `标题 ${id} 用于测试`,
    body: `正文 ${id}`,
    tags: ['test'],
    source: 'test:seed',
    hits: 0,
    ...over,
  }
}
