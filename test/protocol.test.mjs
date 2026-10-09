// 用例 1：写入协议失败关闭——任一约束不满足都必须拒收、不落盘、且给出可照做的修复指引。
//
// 本机实测事实：defineTool 会先用声明式 parameters schema 校验实参，**不合规的实参根本进不到 execute**
// （抛 ToolArgsError，violations 里逐条列出违规字段）。所以拒收有两道独立闸门：
//   闸门 A（宿主 schema）：类型错 / 缺必填 / kind 不在 enum → ToolArgsError；
//   闸门 B（本插件协议 validateDraft）：能过 schema 但违反语义约束（长度、单行、去重、全空白）→ {ok:false,code,text}。
// 两道闸门都必须「拒收 + 给出可照做的指引 + 一个字节都不落盘」，下面分别钉死。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diskLines, diskText, freshHome, tools } from './helpers.mjs'
import { validateDraft } from '../lib/protocol.js'

const VALID = {
  kind: 'fact',
  title: '用户偏好深色主题',
  body: '用户在设置里选择了深色主题，后续不要默认浅色。',
  tags: ['preference', 'ui'],
  source: 'session:demo',
}

// ── 闸门 A：宿主 schema 层拒收（进不到 execute）───────────────────────────
const hostRejects = [
  ['无 tags（缺必填）', { ...VALID, tags: undefined }, 'tags'],
  ['无 source（缺必填）', { ...VALID, source: undefined }, 'source'],
  ['kind 非法（不在 enum）', { ...VALID, kind: 'REMEMBER' }, 'kind'],
  ['kind 缺失', { ...VALID, kind: undefined }, 'kind'],
  ['title 类型错', { ...VALID, title: 42 }, 'title'],
  ['body 类型错', { ...VALID, body: null }, 'body'],
  ['tags 类型错', { ...VALID, tags: 'preference' }, 'tags'],
  ['tag 项类型错', { ...VALID, tags: ['ui', 7] }, 'tags'],
  ['source 类型错', { ...VALID, source: 123 }, 'source'],
  ['scope 类型错', { ...VALID, scope: 123 }, 'scope'],
]

for (const [i, [label, input, field]] of hostRejects.entries()) {
  test(`闸门 A（宿主 schema）拒收：${label}`, async () => {
    const home = freshHome(`protocol-host-${i}`)
    const defs = tools()
    let caught
    try {
      await defs.get('memory_remember').execute(input)
    } catch (err) {
      caught = err
    }
    assert.ok(caught !== undefined, `${label}: 必须失败关闭（不能静默通过）`)
    // 可照做的指引：违规清单必须点名出问题的字段
    const detail = `${caught.message} ${JSON.stringify(caught.violations ?? [])}`
    assert.match(detail, new RegExp(field), `${label}: 指引必须点名违规字段 ${field}`)
    assert.deepEqual(diskLines(home), [], `${label}: 被拒却落了盘`)
  })
}

// ── 闸门 B：本插件写入协议拒收（能过 schema，但违反语义约束）──────────────
const protoRejects = [
  ['title 含换行', { ...VALID, title: '第一行标题\n第二行' }, 'title-multiline'],
  ['title 含回车', { ...VALID, title: '第一行标题\r\n第二行' }, 'title-multiline'],
  ['title 含 Unicode 行分隔符', { ...VALID, title: '第一行标题\u2028第二行' }, 'title-multiline'],
  ['title 太短', { ...VALID, title: '太短' }, 'title-too-short'],
  ['title 太长', { ...VALID, title: '标'.repeat(121) }, 'title-too-long'],
  ['body 全空白', { ...VALID, body: '   ' }, 'empty-body'],
  ['tags 空数组', { ...VALID, tags: [] }, 'tags-too-few'],
  ['tags 过多', { ...VALID, tags: Array.from({ length: 13 }, (_, i) => `t${i}`) }, 'tags-too-many'],
  ['tags 重复（归一化后）', { ...VALID, tags: ['ui', 'UI'] }, 'duplicate-tags'],
  ['tag 超长', { ...VALID, tags: ['x'.repeat(33)] }, 'bad-tag'],
  ['tag 全空白', { ...VALID, tags: ['   '] }, 'bad-tag'],
  ['source 全空白', { ...VALID, source: '   ' }, 'empty-source'],
  // ② scope（可选，但给了就必须校验；它会被回显到表头）
  ['scope 含换行', { ...VALID, scope: 'project:a\nproject:b' }, 'scope-multiline'],
  ['scope 全空白', { ...VALID, scope: '   ' }, 'empty-scope'],
  ['scope 超长', { ...VALID, scope: 'p'.repeat(65) }, 'scope-too-long'],
]

for (const [i, [label, input, code]] of protoRejects.entries()) {
  test(`闸门 B（写入协议）拒收：${label}`, async () => {
    const home = freshHome(`protocol-proto-${i}`)
    const defs = tools()
    const r = await defs.get('memory_remember').execute(input)

    assert.equal(r.ok, false, `${label}: 必须失败关闭`)
    assert.equal(r.code, code, `${label}: code 不符（实际 ${r.code}）`)
    assert.equal(r.total, 0, `${label}: 拒收时不应有任何记录`)
    // 可照做的修复指引：含「修复」动作词 + 一条能直接照抄的 JSON 示例
    assert.match(r.text, /修复/, `${label}: 指引必须说明怎么改`)
    assert.match(r.text, /"kind"/, `${label}: 指引必须带可照抄的最小示例`)
    assert.deepEqual(diskLines(home), [], `${label}: 失败却落了盘`)
  })
}

test('写入协议通过：合法记录落盘且 tags 归一化为 trim + 小写（保序）', async () => {
  const home = freshHome('protocol-ok')
  const defs = tools()
  const r = await defs.get('memory_remember').execute({ ...VALID, tags: ['  Preference ', 'UI'] })

  assert.equal(r.ok, true)
  assert.equal(r.code, 'ok')
  assert.equal(typeof r.id, 'string')
  assert.equal(r.total, 1)
  assert.ok(r.bytes > 0)
  assert.equal(r.maxRecords, 2000)
  assert.equal(r.maxBytes, 4 * 1024 * 1024)
  assert.equal(r.evicted, 0)

  const rows = diskLines(home)
  assert.equal(rows.length, 1)
  const rec = JSON.parse(rows[0])
  assert.deepEqual(rec.tags, ['preference', 'ui'], 'tags 必须保序且只做 trim + 小写化')
  assert.equal(rec.title, VALID.title.trim())
  assert.equal(rec.hits, 0)
  // ② 不传 scope ⇒ 落 DEFAULT_SCOPE=global（默认行为与过去完全一致）
  assert.equal(rec.scope, 'global', '省略 scope 必须落 global')
})

test('② scope 写入协议：合法 scope 归一化落盘（trim + {{}} 净化 + 单行），缺省视为 global', async () => {
  const home = freshHome('protocol-scope')
  const defs = tools()
  const remember = defs.get('memory_remember')
  // 缺省
  const g = await remember.execute({ ...VALID, title: '缺省作用域的记录' })
  assert.equal(g.ok, true)
  // 显式 project:a（带首尾空白 + {{}} 占位）
  const a = await remember.execute({ ...VALID, title: '项目甲的记录条目', scope: '  project:a  ' })
  assert.equal(a.ok, true)
  const p = await remember.execute({ ...VALID, title: '花括号净化的记录', scope: 'project:{{x}}' })
  assert.equal(p.ok, true)
  const recs = diskLines(home).map((l) => JSON.parse(l))
  assert.equal(recs.length, 3)
  assert.equal(recs[0].scope, 'global')
  assert.equal(recs[1].scope, 'project:a', '首尾空白必须去掉')
  assert.equal(recs[2].scope, 'project:{x}', '{{}} 必须净化为单花括号（它会回显到表头）')
  // 长度恰好 64 必须放行（边界）
  const home64 = freshHome('protocol-scope-64')
  const ok64 = await tools().get('memory_remember').execute({ ...VALID, title: '六十四字符作用域记录', scope: 'p'.repeat(64) })
  assert.equal(ok64.ok, true, '恰好 64 字符必须放行')
  const too65 = await tools().get('memory_remember').execute({ ...VALID, title: '六十五字符作用域记录', scope: 'p'.repeat(65) })
  assert.equal(too65.ok, false)
  assert.equal(too65.code, 'scope-too-long')
  // 直接单测 validateDraft 的 bad-scope 分支：工具层会被闸门 A（宿主 schema）提前拦下，
  // 但协议层这一支仍必须失败关闭（纵深防御；不会因为宿主版本差异而漏过去）。
  const bad = validateDraft({ ...VALID, scope: 123 })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'bad-scope')
})

test('写入协议：title 先裁首尾空白再判长度（8 字符可过，7 字符被拒）', async () => {
  const home = freshHome('protocol-trim')
  const defs = tools()
  const ok = await defs.get('memory_remember').execute({ ...VALID, title: '  八个字正好标题啊  ' })
  assert.equal(ok.ok, true)
  const rec = JSON.parse(diskText(home).trim())
  assert.equal(rec.title, '八个字正好标题啊')

  const home2 = freshHome('protocol-trim-2')
  const defs2 = tools()
  const tooShort = await defs2.get('memory_remember').execute({ ...VALID, title: '  七个字的标题啊  ' })
  assert.equal(tooShort.ok, false)
  assert.equal(tooShort.code, 'title-too-short')
  assert.deepEqual(diskLines(home2), [])
})
