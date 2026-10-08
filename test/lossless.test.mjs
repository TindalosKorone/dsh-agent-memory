// 用例 6：输出无损 + 工具定义形状（render 必须挂在 output 内部）+ 声明式 schema 自检。
//
// 两个真机坑钉死在这里：
//  1) 返回值含 undefined ⇒ 宿主报 value is not lossless JSON，整值拒收；
//  2) render 写成 output 的同级兄弟属性 ⇒ 运行时报 output.render failed: userRender is not a function
//     （execute 层测试全绿也照样漏，所以必须检查**工具定义形状**）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertLossless, freshHome, makeCtx, tools } from './helpers.mjs'
import { apply, name, inject } from '../lib/index.js'

const TOOL_NAMES = ['memory_expand', 'memory_prune', 'memory_recall', 'memory_remember']

/** 按声明式 schema 自检返回值（等价于宿主会做的那一层校验）。 */
function schemaViolations(spec, value, path = '$') {
  const out = []
  if (spec === null || typeof spec !== 'object') return out
  const t = spec.type
  if (t === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`${path}: 期望 object，实际 ${Array.isArray(value) ? 'array' : typeof value}`]
    const props = spec.properties ?? {}
    for (const [k, ps] of Object.entries(props)) if (ps.required === true && !(k in value)) out.push(`${path}.${k}: 缺必填字段`)
    if (spec.additionalProperties === false) {
      for (const k of Object.keys(value)) if (!(k in props)) out.push(`${path}.${k}: 出现未声明的额外字段（宿主会拒收）`)
    }
    for (const [k, ps] of Object.entries(props)) if (k in value && value[k] !== undefined) out.push(...schemaViolations(ps, value[k], `${path}.${k}`))
    return out
  }
  if (t === 'array') {
    if (!Array.isArray(value)) return [`${path}: 期望 array，实际 ${typeof value}`]
    if (spec.items) value.forEach((v, i) => out.push(...schemaViolations(spec.items, v, `${path}[${i}]`)))
    return out
  }
  if (t === 'string') { if (typeof value !== 'string') out.push(`${path}: 期望 string，实际 ${typeof value}`); return out }
  if (t === 'integer') { if (typeof value !== 'number' || !Number.isInteger(value)) out.push(`${path}: 期望 integer，实际 ${typeof value}=${value}`); return out }
  if (t === 'number') { if (typeof value !== 'number' || !Number.isFinite(value)) out.push(`${path}: 期望 number`); return out }
  if (t === 'boolean') { if (typeof value !== 'boolean') out.push(`${path}: 期望 boolean，实际 ${typeof value}`); return out }
  return out
}

test('插件契约：name/inject 正确，恰好注册 4 个工具', () => {
  assert.equal(name, '@dsh-agent/dsh-agent-memory')
  assert.deepEqual(inject, ['tools'])
  const { ctx, defs, effects } = makeCtx()
  apply(ctx)
  assert.deepEqual([...defs.keys()].sort(), TOOL_NAMES)
  assert.equal(effects.length, 1, '必须用 ctx.effect 注册副作用清理')
  assert.equal(typeof effects[0], 'function', 'effect 回调必须返回清理函数')
})

test('工具定义形状：render 必须挂在 output 内部且可用', () => {
  const defs = tools()
  for (const [toolName, def] of defs) {
    assert.ok(def.output && typeof def.output === 'object', `${toolName}: 缺 output`)
    assert.equal(typeof def.output.render, 'function', `${toolName}: 缺 output.render（宿主会报 userRender is not a function）`)
    assert.equal(def.render, undefined, `${toolName}: render 不得写成 output 的同级兄弟属性`)
    const parts = def.output.render({}, { text: '摘要' })
    assert.ok(Array.isArray(parts) && parts.length > 0, `${toolName}: render 必须返回非空数组`)
    assert.equal(parts[0].type, 'text')
    assert.equal(parts[0].text, '摘要')
    assert.equal(typeof def.execute, 'function', `${toolName}: 缺 execute`)
    assert.equal(def.name, toolName)
  }
})

test('输出无损 + 符合声明 schema：全部分支逐一过一遍', async () => {
  const home = freshHome('lossless')
  const defs = tools()
  const remember = defs.get('memory_remember')
  const recall = defs.get('memory_recall')
  const expand = defs.get('memory_expand')
  const prune = defs.get('memory_prune')

  const results = []
  const push = (label, def, value) => results.push([label, def, value])

  // 空库
  push('recall 空库', recall, await recall.execute({ query: '' }))
  push('prune 空库 dryRun', prune, await prune.execute({}))
  push('prune 空库 真删', prune, await prune.execute({ dryRun: false }))
  push('expand 空 ids', expand, await expand.execute({ ids: [] }))
  push('expand 全未命中', expand, await expand.execute({ ids: ['mem_nope'] }))

  // 库内有一条
  const w = await remember.execute({
    kind: 'lesson', title: '工具返回必须无损', body: '含 undefined 会被宿主拒收。', tags: ['output', 'host'], source: 'test:lossless',
  })
  assert.equal(w.ok, true)
  push('remember 成功', remember, w)
  push('remember 协议拒收', remember, await remember.execute({
    kind: 'fact', title: '太短', body: 'x', tags: ['a'], source: 's',
  }))
  // 补 1 的新失败分支（单条过大）也要过同一套「无损 + 声明 schema」自检
  process.env.DSH_AGENT_MEMORY_MAX_RECORD_BYTES = '128'
  push('remember 单条过大', remember, await remember.execute({
    kind: 'fact', title: '单条上限失败分支的无损自检', body: 'x'.repeat(400), tags: ['big'], source: 'test:lossless',
  }))
  delete process.env.DSH_AGENT_MEMORY_MAX_RECORD_BYTES
  push('recall 有数据', recall, await recall.execute({ query: '无双关语标题' }))
  push('expand 命中', expand, await expand.execute({ ids: [w.id] }))
  push('expand 命中+未命中', expand, await expand.execute({ ids: [w.id, 'mem_missing'] }))
  push('prune dryRun 有数据', prune, await prune.execute({ dryRun: true }))
  push('prune 真删有数据', prune, await prune.execute({ dryRun: false }))

  // 截断路径
  for (let i = 0; i < 60; i += 1) {
    await remember.execute({ kind: 'fact', title: `无损压测第 ${i} 号记录`, body: `正文 ${i}`, tags: ['bulk'], source: 'test:lossless' })
  }
  push('recall 截断路径', recall, await recall.execute({ query: '无损压测', limit: 50 }))

  assert.ok(results.length >= 13)
  for (const [label, def, value] of results) {
    assertLossless(label, value)
    assert.deepEqual(schemaViolations(def.output.schema, value), [], `${label}: 返回值不符合声明 schema`)
    // 模型面渲染必须能拿到文本
    const parts = def.output.render({}, value)
    assert.equal(parts[0].type, 'text')
    assert.equal(typeof parts[0].text, 'string')
    assert.ok(parts[0].text.length > 0, `${label}: render 文本不得为空`)
  }
})

test('每个工具在失败分支上也不含 undefined（逐键扫描）', async () => {
  const home = freshHome('lossless-keys')
  const defs = tools()
  const r = await defs.get('memory_remember').execute({ kind: 'fact', title: '   ', body: '', tags: [], source: '' })
  assert.equal(r.ok, false)
  for (const [k, v] of Object.entries(r)) assert.notEqual(v, undefined, `字段 ${k} 是 undefined`)
  assert.equal('id' in r, false, '失败时 id 必须整键省略（而不是留 undefined）')
  assertLossless('remember 多重违规', r)
})
