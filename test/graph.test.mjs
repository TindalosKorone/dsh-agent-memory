// I3 用例：有序双向标签共现图 + 有界脉冲传播（浪潮）。
//
// 覆盖：
//  A. 图构建（纯函数层）：有序边方向、log 压缩（禁止线性累加）、出流预算、枢纽校正、
//     对称视图与方向分别可取的原始计数；
//  B. 传播（纯函数层）：跳数 / 状态数 / 每节点最强出边三条上限、衰减 γ、立即回流抑制 ρ、
//     确定性（同输入逐字节同输出）；
//  C. 图奖励（纯函数层）：硬上限、"无证据恰好为 0"、max 不取和（标签多不得白拿）；
//  D. 工具层：行内 graph/via 与结构化字段一致、final=rel+graph 可复算、limit 仍是硬上限、
//     空查询图面全静默、2000 条规模下工作量有界（不许 O(n²) 爆炸）；
//  E. 五条红证（判红点写在用例名里，见文件末尾）；
//  F. 请求级隔离（与「单独只跑第二次」逐字段比对，探针 test/isolation-probe.mjs）。
//
// 教训延续（I1.3 / I2）：新增的每条断言都必须能判红；凡是在夹具下恒真的判据，
// 都在用例里补一条「区分力自检」把它钉住（本文件里以「区分力自检」字样标出）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GRAPH_ACTIVATION_MIN, GRAPH_BACKFLOW_RHO, GRAPH_BONUS_CAP, GRAPH_BONUS_SCALE, GRAPH_DECAY,
  GRAPH_HUB_ETA, GRAPH_LAMBDA, GRAPH_MAX_FIELD_NEIGHBORS, GRAPH_MAX_HOPS, GRAPH_MAX_STATES,
  GRAPH_OUT_BUDGET, SCALE_A, absoluteDisp, cmpId, matchLevel, memoryGraphRewards, propagateTags, resolveGraphOptions,
  tagGraphIndex, tagGraphSize,
} from '../lib/pure.js'
import { assertLossless, freshHome, memFile, tools } from './helpers.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROBE = join(HERE, 'isolation-probe.mjs')
// 【本机坑】Android/Termux 上 process.execPath 是 linker64（/apex/com.android.runtime/bin/runtime），
// 拿它当 node 去 spawn 会报 bad ELF magic；process.argv0 才是真正的 node 路径。
const NODE_BIN = process.argv0 !== '' && existsSync(process.argv0) ? process.argv0 : process.execPath

const SPLIT = ' | '
const idOfLine = (line) => line.split(SPLIT)[0]
/** 行格式：id | kind | title | tags | graph | via | rel | cov | match | score（score 仍在行尾）。 */
const LINE_RE = /^mem_[a-z0-9_]+ \| (fact|lesson|preference|pointer) \| .+ \| .* \| \d+\.\d{4} \| \S+ \| \d+\.\d{4} \| \d+\.\d{4} \| (none|weak|strong) \| \d+\.\d{4}$/

/** 造一条 seeds 记录（纯函数层夹具用，不走落盘）。 */
const rec = (id, tags) => ({ id, tags })

/** tagGraphIndex 里找节点（找不到返回 undefined，让断言自己报错）。 */
const nodeOf = (g, tag) => g.nodes[g.index.get(tag) ?? -1]

/** 出边权查表（对称视图）。 */
const weightOf = (g, from, to) => {
  const n = nodeOf(g, from)
  if (n === undefined) return undefined
  return n.outEdges.find((e) => e.to === to)?.weight
}

// ── A. 图构建（纯函数层）────────────────────────────────────────────────────

test('I3 图：有序双向边（(A->B) 与 (B->A) 分别计数，绝不合成一个数；对称视图可另行取到）', () => {
  // 3 条 [a,b]（顺序 a→b）+ 1 条 [b,a]（顺序 b→a）
  const g = tagGraphIndex([rec('r1', ['a', 'b']), rec('r2', ['a', 'b']), rec('r3', ['a', 'b']), rec('r4', ['b', 'a'])])

  const ab = nodeOf(g, 'a')?.outEdges.find((e) => e.to === 'b')
  const ba = nodeOf(g, 'b')?.outEdges.find((e) => e.to === 'a')
  assert.ok(ab !== undefined && ba !== undefined, '两个方向都必须各有一条出边')
  assert.equal(ab.outRaw, 3, 'a→b 的 forward 计数必须是 3')
  assert.equal(ab.inRaw, 1, 'a→b 的 backward 计数必须是 1（不合成，分别可取）')
  assert.equal(ba.outRaw, 1, 'b→a 的 forward 计数必须是 1')
  assert.equal(ba.inRaw, 3, 'b→a 的 backward 计数必须是 3')
  // 对称视图两侧一致（对称压缩权）
  assert.equal(ab.compressed, ba.compressed, '对称视图里同一条边的压缩权必须一致')
  // 有向边数 = 2（两个方向分别计数），标签对数（对称边数）= 1
  assert.equal(g.directedEdges, 2, '有向边数必须两个方向分别计数')
  assert.equal(g.symmetricEdges, 1, '对称视图只有 1 条边')
  // 自环跳过、非相邻标签不成边
  const g2 = tagGraphIndex([rec('r', ['a', 'a', 'b', 'c'])])
  assert.equal(g2.directedEdges, 2, 'a→a 自环必须跳过，只剩 a→b 与 b→c 各一个方向')
  assert.equal(nodeOf(g2, 'a')?.outEdges.some((e) => e.to === 'a'), false, '不得有自环')
  assert.equal(weightOf(g2, 'a', 'c'), undefined, '非相邻标签不得直接成边')
})

test('I3 图：边权 log(1+λW) 压缩（禁止线性累加），且两个方向各自压缩后再相加', () => {
  // W=3 与 W=1 两条边的对称压缩权必须是 log(1+λ3) 与 log(1+λ1)
  const g = tagGraphIndex([rec('r1', ['a', 'b']), rec('r2', ['a', 'b']), rec('r3', ['a', 'b']), rec('r4', ['a', 'c'])])
  const ab = nodeOf(g, 'a')?.outEdges.find((e) => e.to === 'b')
  assert.ok(ab !== undefined)
  assert.equal(ab.compressed, Math.log(1 + GRAPH_LAMBDA * 3), '一次出现 3 次的边必须取 log(1+λ·3)')
  const ac = nodeOf(g, 'a')?.outEdges.find((e) => e.to === 'c')
  assert.equal(ac?.compressed, Math.log(1 + GRAPH_LAMBDA * 1))
  // 禁止线性累加的直接判据：W 翻倍不等于权翻倍，且压缩权小于原始计数
  assert.ok(ab.compressed < ab.outRaw, `压缩后必须小于原始计数（log 压缩）：${ab.compressed} vs ${ab.outRaw}`)
  const g100 = tagGraphIndex(Array.from({ length: 100 }, (_, i) => rec(`r${i}`, ['a', 'b'])))
  const w100 = weightOf(g100, 'a', 'b')
  const g10 = tagGraphIndex(Array.from({ length: 10 }, (_, i) => rec(`r${i}`, ['a', 'b'])))
  const w10 = weightOf(g10, 'a', 'b')
  assert.ok(w100 === 1 && w10 === 1, '单出边时归一化后预算全给这条边（W 只进 log，不进线性权重）')
  assert.ok(Math.log(1 + 100) / Math.log(1 + 10) < 2, 'log 压缩使 10 倍频次远不到 10 倍权重（线性累加会到 10 倍）')
})

test('I3 图：出流预算（每节点 Σ出边权 <= m_out）与枢纽校正 (频次/中位数)^-η', () => {
  // hub 在 5 条记录里都当**后继**出现（入度 5），同时自己在 r5 里当**前驱**（有出边）；
  // 配对的 x* 各只出现一次（入度 1） ⇒ 入度中位数 = 1，hub 的入度 5 >= 中位数+1 ⇒ 判定为枢纽。
  // （纯扇出节点没有入边，不会被判成枢纽 —— 枢纽的语义就是"被很多记录指向的万能标签"。）
  const seeds = [
    rec('r0', ['x0', 'hub']), rec('r1', ['x1', 'hub']), rec('r2', ['x2', 'hub']),
    rec('r3', ['x3', 'hub']), rec('r4', ['x4', 'hub']), rec('r5', ['hub', 'sink']),
  ]
  const g = tagGraphIndex(seeds)
  const hub = nodeOf(g, 'hub')
  assert.ok(hub !== undefined)
  assert.equal(g.medianIn, 1)
  assert.ok(hub.outFlow <= GRAPH_OUT_BUDGET + 1e-12, `出流总预算必须 <= m_out：${hub.outFlow}`)
  // 出流 = m_out × 校正因子（先归一化到预算、再乘枢纽校正）
  assert.ok(Math.abs(hub.outFlow - GRAPH_OUT_BUDGET * hub.hubFactor) < 1e-12,
    `枢纽出流必须 = m_out × 校正因子：${hub.outFlow} vs ${GRAPH_OUT_BUDGET * hub.hubFactor}`)
  assert.equal(nodeOf(g, 'x0')?.outFlow, GRAPH_OUT_BUDGET, 'x* 只有一条出边且不是枢纽 ⇒ 出流应是整个预算')
  assert.equal(nodeOf(g, 'x0')?.hubFactor, 1, 'x* 不是枢纽 ⇒ 不得被压')
  for (const n of g.nodes) {
    assert.ok(n.outFlow <= GRAPH_OUT_BUDGET + 1e-12, `${n.tag} 的出流超预算：${n.outFlow}`)
    for (const e of n.outEdges) assert.ok(e.weight > 0, `${n.tag}->${e.to} 的权必须为正（低权不消失）`)
  }
  // 枢纽因子：clip((频次/中位数)^-η)
  // hub 的频次 = 6（5 条当后继 + 1 条当前驱），中位数 = 1
  assert.equal(hub.hubFactor, (6 / 1) ** -GRAPH_HUB_ETA)
  assert.ok(hub.hubFactor < 1, '枢纽必须被压（alpha < 1）')
  assert.ok(g.hubSuppressed.includes('hub'), 'hubSuppressed 必须列出被压的万能标签')
  assert.ok(g.hubSuppressedCount >= 1)
  // 非枢纽恰好为 1
  assert.equal(nodeOf(g, 'x0')?.hubFactor, 1, '非枢纽的校正因子必须恰好为 1（不该被误压）')
  // 区分力自检：把 η 关成 0（等价于「去掉枢纽校正」）后，hub 的因子必须变成 1、且它不再是枢纽
  const g0 = tagGraphIndex(seeds, { hubEta: 0 })
  assert.equal(nodeOf(g0, 'hub')?.hubFactor, 1, '去掉枢纽校正后因子必须是 1（否则本用例对「校正」没有区分力）')
  assert.deepEqual(g0.hubSuppressed, [], 'η=0 时不应再压任何标签')
  assert.ok((nodeOf(g0, 'hub')?.outFlow ?? 0) > (nodeOf(g, 'hub')?.outFlow ?? 0),
    '枢纽校正必须让 hub 的出流严格变小（判红点：去掉校正后这里相等）')
  // 没有任何边（单标签记录）时不得误压任何标签。
  // 注意口径：medIn 数的是「被指向的次数」——一条单标签记录里没有任何指向边，
  // 但该标签自身出现 1 次 ⇒ 中位数是 1 而不是 0；枢纽判定要求 inDeg >= median+1，
  // 所以边集为空时**不可能**判出枢纽（这是这条断言真正要钉的东西）。
  const gEmpty = tagGraphIndex([rec('r', ['only'])])
  assert.equal(gEmpty.medianIn, 1, '中位数按「标签出现次数」取，单标签记录给出 1')
  assert.deepEqual(gEmpty.hubSuppressed, [], '没有边时不许判出枢纽')
  assert.equal(gEmpty.directedEdges, 0)
  assert.equal(gEmpty.symmetricEdges, 0)
  assert.equal(nodeOf(gEmpty, 'only')?.outDeg, 0)
  assert.equal(nodeOf(gEmpty, 'only')?.outFlow, 0)
})

test('I3 图：入度与全局频次都能取到；出边按（权降序 → 码元升序）稳定排序', () => {
  const g = tagGraphIndex([
    rec('r1', ['a', 'b']), rec('r2', ['a', 'b']), rec('r3', ['a', 'c']),
    rec('r4', ['d', 'a']), rec('r5', ['e', 'a']),
  ])
  const a = nodeOf(g, 'a')
  assert.ok(a !== undefined)
  assert.equal(a.outDeg, 2, 'a 的后继是 b/c')
  assert.equal(a.inDeg, 2, 'a 的前驱是 b/d（不同前驱个数；同一条记录里重复出现只算一个前驱）')
  assert.equal(a.inCount, 5, 'a 的全局出现频次是 5（出现在 5 条记录里）')
  // 权降序
  assert.ok(a.outEdges[0].weight >= a.outEdges[1].weight, '出边必须按权降序')
  // 同权时按目标码元升序（构造两条同权边）
  const g2 = tagGraphIndex([rec('r', ['s', 'y']), rec('r2', ['s', 'z'])])
  const s = nodeOf(g2, 's')
  assert.deepEqual(s?.outEdges.map((e) => e.to), ['y', 'z'], '同权时必须按码元升序')
  // inNeighbors 也确定有序
  assert.deepEqual(a.inNeighbors, [...a.inNeighbors].sort(cmpId), '前驱列表必须码元升序')
})

// ── B. 传播（纯函数层）─────────────────────────────────────────────────────

test('I3 传播：跳数上限 / 每节点最强出边上限 / 立即回流抑制（不许沿刚来的那条边原路返回）', () => {
  // 一条链 s → a → b → c，外加 s 的 6 条出边用来验证 maxFieldNeighbors
  const g = tagGraphIndex([rec('r1', ['s', 'a']), rec('r2', ['a', 'b']), rec('r3', ['b', 'c'])])
  const two = propagateTags(['s'], g)
  assert.equal(two.hops, 2, '默认 maxHops=2 ⇒ 只能走 2 跳')
  assert.deepEqual(two.propagated.map((p) => p.tag), ['s', 'a', 'b'], 's 的 2 跳内必须恰好到 a、b（c 在第 3 跳）')
  const three = propagateTags(['s'], g, { maxHops: 3 })
  assert.equal(three.hops, 3)
  assert.ok(three.propagated.some((p) => p.tag === 'c'), '把 maxHops 放开到 3 后第 3 跳必须到达 c')
  assert.equal(propagateTags(['s'], g, { maxHops: 0 }).propagated.length, 0, 'maxHops=0 ⇒ 完全关断传播')
  assert.equal(propagateTags([], g).propagated.length, 0, '空种子 ⇒ 不传播')

  // 回流抑制：只有一条边 s→a，a 的唯一出边指回 s 且链很短 ⇒ a 不得把能量送回 s
  const back = tagGraphIndex([rec('r1', ['s', 'a'])])
  const p = propagateTags(['s'], back, { maxHops: 3 })
  assert.equal(p.propagated.find((x) => x.tag === 's')?.weight, 1, '种子激活必须仍是 1（不许被回流抬高）')
  assert.ok(!p.propagated.some((x) => x.tag === 'a' && x.weight > GRAPH_DECAY + 1e-12),
    'a 的激活必须只来自 s→a 这一跳（不许循环回流放大）')

  // 每节点最强出边：hub 有 6 条出边，只允许走最强的 4 条
  const six = tagGraphIndex([['n0', 'n1', 'n2', 'n3', 'n4', 'n5'].map((x) => rec(`m${x}`, ['root', x]))].flat())
  const lim = propagateTags(['root'], six, { maxHops: 1, maxFieldNeighbors: 4 })
  assert.equal(lim.propagated.filter((x) => x.tag !== 'root').length, 4, 'maxFieldNeighbors=4 ⇒ 只能扩散到 4 个后继')
  const all = propagateTags(['root'], six, { maxHops: 1, maxFieldNeighbors: 64 })
  assert.equal(all.propagated.filter((x) => x.tag !== 'root').length, 6, '放开限制后 6 个后继都要到（证明上一条真的被上限截了）')
  // 衰减 γ：第一跳的激活必须 <= γ（不可能凭空变大）
  for (const x of lim.propagated) if (x.tag !== 'root') assert.ok(x.weight <= GRAPH_DECAY + 1e-12, `每跳必须乘 γ=${GRAPH_DECAY}`)
})

test('I3 传播：maxStates 硬上限（状态数绝不超限，撞上时如实标记）', () => {
  // 200 个种子标签，每个只出 1 条边到自己的伙伴；没被展开的种子不会到达伙伴
  // ⇒ 状态数与到达标签数都会被 maxStates=64 卡住（这是能同时判红的干净夹具）。
  const records = []
  const seedTags = []
  for (let i = 0; i < 200; i += 1) {
    const t = `s${String(i).padStart(3, '0')}`
    seedTags.push(t)
    records.push(rec(`seed${i}`, [t, `p${String(i).padStart(3, '0')}`]))
  }
  const g = tagGraphIndex(records)
  const capped = propagateTags(seedTags, g)
  assert.equal(capped.statesUsed, GRAPH_MAX_STATES, `状态数必须恰好停在上限 ${GRAPH_MAX_STATES}（说明夹具真的撞上了）`)
  assert.ok(capped.statesUsed <= GRAPH_MAX_STATES, '状态数绝不超限')
  assert.equal(capped.statesTruncated, true, '撞上上限必须如实标记 statesTruncated')
  assert.ok(capped.hops <= GRAPH_MAX_HOPS, `跳数绝不超限：${capped.hops}`)
  // 到达标签 = nodesMap 里激活过下限的项（含「已入队但没轮到展开」的伙伴），
  // 所以它会比 statesUsed 多；能判红的是 statesUsed 恰等于上限 + 截断标记。
  assert.equal(capped.propagated.length, 263, '截断这一刻：64 个已展开种子 + 199 个已入队伙伴')
  assert.ok(capped.propagated.some((x) => x.tag.startsWith('p')), '伙伴已经入队（权重过下限）就算「到达」')
  // 区分力自检：把上限放开 ⇒ 状态数与到达标签数都必须变多（证明上面那条不是"夹具本来就到不了"）
  const open = propagateTags(seedTags, g, { maxStates: 4096 })
  assert.equal(open.statesUsed, 400, '放开后 200 个种子 + 200 个伙伴全部展开')
  assert.ok(open.propagated.length > capped.propagated.length,
    `放开上限后到达标签必须更多（${capped.propagated.length} -> ${open.propagated.length}）`)
  assert.equal(open.statesTruncated, false)
  // 状态数恰好为 0 的极端配置也不许出 NaN（resolve 会把非法值夹回合法区间）
  assert.equal(propagateTags(seedTags, g, { maxStates: 0 }).statesUsed, 0)
  assert.equal(resolveGraphOptions({ maxStates: -5 }).maxStates, 0)
})

test('I3 传播：确定性（同一图 + 同一批种子重复调用，逐字段完全相同）', () => {
  const records = [
    rec('r1', ['a', 'b']), rec('r2', ['a', 'c']), rec('r3', ['b', 'd']), rec('r4', ['c', 'd']),
    rec('r5', ['d', 'e']), rec('r6', ['e', 'f']), rec('r7', ['f', 'g']),
  ]
  const g = tagGraphIndex(records)
  const first = propagateTags(['a', 'c'], g)
  for (let i = 0; i < 5; i += 1) {
    const again = propagateTags(['a', 'c'], g)
    assert.deepEqual(again, first, '同一输入必须给出完全相同的传播结果（第 ' + i + ' 次比对）')
  }
  // 种子顺序反过来，结果也必须一致（种子先排序）
  assert.deepEqual(propagateTags(['c', 'a'], g), first, '种子顺序不得影响结果（必须按码元排序）')
  // 图本身重算也必须一致
  assert.deepEqual(tagGraphIndex(records), g, '同一记录集的图必须逐字段一致')
})

// ── C. 图奖励（纯函数层）───────────────────────────────────────────────────

test('I3 奖励：硬上限 GRAPH_BONUS_CAP；无证据恰好为 0；取 max 不取和', () => {
  const records = [rec('r1', ['a', 'b']), rec('r2', ['a', 'c']), rec('r3', ['b', 'c'])]
  const g = tagGraphIndex(records)
  const p = propagateTags(['a'], g)
  const candidates = [
    { id: 'withB', tags: ['b'] },
    { id: 'withBC', tags: ['b', 'c'] },
    { id: 'none', tags: ['zzz'] },
    { id: 'empty', tags: [] },
  ]
  const rewards = memoryGraphRewards(candidates, p.propagated, g)
  const byId = new Map(rewards.map((x) => [x.id, x]))
  for (const r of rewards) {
    assert.ok(r.bonus >= 0 && r.bonus <= GRAPH_BONUS_CAP + 1e-12, `${r.id} 的图奖励必须落在 [0, ${GRAPH_BONUS_CAP}]：${r.bonus}`)
    assert.ok(Number.isFinite(r.bonus) && Number.isFinite(r.activation))
  }
  // 无证据恰好 0（不是"很小"，是恰好 0）
  assert.equal(byId.get('none')?.bonus, 0, '标签没有激活 ⇒ 图奖励必须恰好为 0')
  assert.equal(byId.get('empty')?.bonus, 0, '没有标签 ⇒ 图奖励必须恰好为 0')
  assert.equal(byId.get('none')?.viaTag, '', '无证据不得给 via 标签')
  // 有证据必须 > 0 且 via 标出最强来源标签
  assert.ok((byId.get('withB')?.bonus ?? 0) > 0, '命中激活标签的记录必须拿到正奖励')
  assert.equal(byId.get('withB')?.viaTag, 'b')
  // max 不取和：标签更多的记录不得因为"标签多"就拿更多
  assert.equal(byId.get('withBC')?.bonus, byId.get('withB')?.bonus,
    'withB 与 withBC 的最强证据都来自 b ⇒ 奖励必须相同（若实现改成求和，这里会更大）')
  // 区分力自检：activation 用「激活」而非「频次」，把 activationMin 抬高到 1（只有种子能过）后，
  // 非种子证据的奖励必须归零 —— 证明奖励确实由激活驱动，而不是某个与传播无关的量
  const strict = memoryGraphRewards(candidates, p.propagated, g, { activationMin: 1 })
  assert.equal(strict.find((x) => x.id === 'withB')?.bonus, 0, 'activationMin=1 时第一跳证据必须被排除')
  // 硬上限确实在起作用：把 bonusCap 调到极小后单条奖励必须跟着变小
  const tiny = memoryGraphRewards(candidates, p.propagated, g, { bonusCap: 1e-6 })
  assert.ok((tiny.find((x) => x.id === 'withB')?.bonus ?? 1) <= 1e-6, 'bonusCap 必须真的截断')
  // 传播关断 ⇒ 所有奖励恰好 0
  const off = memoryGraphRewards(candidates, propagateTags(['a'], g, { maxHops: 0 }).propagated, g)
  assert.ok(off.every((x) => x.bonus === 0), '没有传播 ⇒ 所有图奖励恰好为 0')
})

// ── D. 工具层 ───────────────────────────────────────────────────────────────

/** 红线 1 的夹具：A/B 词法命中 alpha，T 只共享 beta（与 alpha 无任何词法重合），另有 6 条隔离 filler。 */
async function seedGraphRecall(home, defs) {
  const rem = defs.get('memory_remember')
  const a = await rem.execute({ kind: 'fact', title: 'alpha focused note', body: 'alpha evidence here', tags: ['alpha'], source: 'test:graph' })
  const b = await rem.execute({ kind: 'fact', title: 'alpha secondary', body: 'unrelated text content', tags: ['alpha', 'beta'], source: 'test:graph' })
  const t = await rem.execute({ kind: 'fact', title: 'plain beta record', body: 'nothing to match here', tags: ['beta'], source: 'test:graph' })
  for (let i = 0; i < 6; i += 1) {
    await rem.execute({ kind: 'fact', title: `x filler item ${i}`, body: `plain filler body ${i}`, tags: ['x'], source: 'test:graph' })
  }
  return { a: a.id, b: b.id, t: t.id }
}

test('I3 工具层：行内 graph/via 与结构化行一致，final=rel+graph 可用打印值复算，score 仍在行尾', async () => {
  freshHome('graph-row')
  const defs = tools()
  const ids = await seedGraphRecall(null, defs)
  const r = await defs.get('memory_recall').execute({ query: 'alpha', limit: 3 })

  assert.equal(r.ok, true)
  assert.equal(r.lines.length, r.rows.length)
  for (let i = 0; i < r.rows.length; i += 1) {
    const line = r.lines[i]
    const row = r.rows[i]
    assert.match(line, LINE_RE, `行格式必须是 id|kind|title|tags|graph|via|rel|cov|match|score：${line}`)
    const f = line.split(SPLIT)
    // 行尾仍是 score；rel/cov/match 的行尾相对下标逐字未变
    assert.equal(Number(f.at(-1)), Number(row.score.toFixed(4)), '行尾必须仍是 score')
    assert.equal(Number(f.at(-4)), Number(row.rel.toFixed(4)), 'rel 必须在倒数第 4 位（既有相对下标不变）')
    assert.equal(Number(f.at(-3)), Number(row.cov.toFixed(4)), 'cov 必须在倒数第 3 位')
    assert.equal(f.at(-2), row.match, 'match 必须在倒数第 2 位')
    assert.equal(Number(f[4]), Number(row.graph.toFixed(4)), 'graph 必须在第 5 列')
    assert.equal(f[5], row.via, 'via 必须在第 6 列')
    assert.equal(idOfLine(line), row.id)
    assert.ok(row.graph >= 0 && row.graph <= r.graphBonusCap, `每行 graph 必须 <= graphBonusCap：${row.graph}`)
    // match 仍可由打印的 rel 复算（图奖励不参与 match）
    const rel = Number(f.at(-4))
    const expect = rel >= r.strongThreshold ? 'strong' : rel >= r.weakThreshold ? 'weak' : 'none'
    assert.equal(row.match, expect, 'match 必须能由打印的 rel + 表头阈值复算')
    // via 的语义：有词法证据 direct；否则必须标出 tag:<标签>
    if (row.rel > 0) assert.equal(row.via, 'direct')
    else {
      assert.match(row.via, /^tag:.+$/, `无词法证据的行必须标出图来源标签：${row.via}`)
      assert.ok(row.graph > 0, '标了 tag: 的行必须有正图奖励')
    }
  }
  assert.ok(r.rows.some((row) => row.id === ids.t), '共享标签的记忆必须出现在候选里（I3 的召回目标）')
  const tRow = r.rows.find((row) => row.id === ids.t)
  assert.equal(tRow.rel, 0, '这条记忆与查询没有任何词法重合')
  assert.ok(tRow.graph > 0 && tRow.via === 'tag:beta', `它必须由图传播到达：graph=${tRow.graph} via=${tRow.via}`)
  // 排序可复算：final = rel + graph，表头有公式与上限
  assert.ok(r.text.split('\n')[0].includes('final=rel+graph'), '表头必须写明 final=rel+graph 与硬上限')
  assert.ok(r.text.split('\n')[0].includes(String(GRAPH_BONUS_CAP)), '表头必须写明图奖励硬上限')
  assertLossless('I3 行', r)
})

test('I3 工具层：limit 仍是硬显示上限；空查询图面全静默；无词法证据也不整批否决', async () => {
  freshHome('graph-hardcap')
  const defs = tools()
  await seedGraphRecall(null, defs)
  const recall = defs.get('memory_recall')

  for (const limit of [1, 2, 3, 9]) {
    const r = await recall.execute({ query: 'alpha', limit })
    // limit 是硬显示上限。I5 表头减肥后（<= 400 字符）行预算回来了：本夹具在 limit<=9 时
    // 不再撞 RECALL_MAX_CHARS=2000，所以恢复旧口径的**精确等式**（不放松成不等式）：
    // 行数恒为 min(limit, 可用候选数)。原先把期望改成 `truncated ? shown : cap` 是为了绕开长表头。
    assert.equal(r.rows.length, Math.min(limit, r.matched + r.reachable), `limit=${limit} 必须仍是硬显示上限`)
    assert.equal(r.truncated, false, `表头减肥后 limit=${limit} 不该再撞字符预算（撞了说明表头又长回去了）`)
    assert.ok(r.rows.length <= limit, `行数绝不超过 limit=${limit}`)
    assert.equal(r.lines.length, r.rows.length)
    assert.equal(r.shown, r.lines.length, 'shown 必须等于真正打印的行数')
  }
  // 无词法证据的候选（rel=0）也必须如实返回，不许整批否决
  const r = await recall.execute({ query: 'alpha', limit: 9 })
  assert.ok(r.rows.some((row) => row.rel === 0), 'rel=0 的候选不得被整批否决')

  // 空查询：没有种子 ⇒ 图面全静默（不假装有图证据）
  for (const q of ['', '   ']) {
    const e = await recall.execute({ query: q, limit: 4 })
    assert.deepEqual(e.propagatedTags, [], '空查询不得有传播标签')
    assert.equal(e.graphSeedCount, 0, '空查询不得有种子')
    assert.equal(e.graphStatesUsed, 0, '空查询不得展开任何状态')
    assert.equal(e.reachable, 0, '空查询不得有图新增可达')
    assert.ok(Array.isArray(e.hubSuppressed), 'hubSuppressed 必须是数组（可为空）')
    for (const row of e.rows) {
      assert.equal(row.graph, 0, '空查询每行图奖励必须恰好为 0')
      assert.equal(row.via, 'direct', '空查询不得出现 tag: 来源')
    }
    assertLossless('I3 空查询', e)
  }
})

test('I3 图到达不变量（判红点：关掉传播 maxHops=0 ⇒ (a) 变红；把 via/graph 的产出清掉 ⇒ (c)(d) 变红）：仅由标签图到达的行 rel=0/graph>0/via=tag:/match=none，且 score 与 absoluteDisp(rel+graph) 一致', async () => {
  freshHome('graph-arrival-invariant')
  const defs = tools()
  const remember = defs.get('memory_remember')
  // 夹具：全库 5 条 ⇒ 词法融合候选 = 5 <= DIVERSITY_MIN_CANDIDATES ⇒ 多样性**不**施加
  //（这是 #3 里那条"score 恒可由 rel+graph 复算"成立的分支；> 5 时它就不成立了）。
  const a = await remember.execute({ kind: 'fact', title: 'alpha focused note', body: 'alpha evidence here', tags: ['alpha'], source: 'test:graph' })
  const b = await remember.execute({ kind: 'fact', title: 'alpha secondary', body: 'unrelated text content', tags: ['alpha', 'beta'], source: 'test:graph' })
  const t = await remember.execute({ kind: 'fact', title: 'plain beta record', body: 'nothing to match here', tags: ['beta'], source: 'test:graph' })
  for (let i = 0; i < 2; i += 1) {
    await remember.execute({ kind: 'fact', title: `x filler item ${i}`, body: `plain filler body ${i}`, tags: ['x'], source: 'test:graph' })
  }
  for (const w of [a, b, t]) assert.equal(w.ok, true)
  const ids = { t: t.id }
  const recall = defs.get('memory_recall')
  const r = await recall.execute({ query: 'alpha', limit: 3 })

  // 夹具自检（区分力）：词法融合候选 <= 5 ⇒ 多样性不施加，
  // 因此 score 必须能由打印的 rel+graph 精确复算（多样性一开这条等式就不成立 —— 见 #3）。
  assert.equal(r.diversityApplied, false, `夹具必须落在多样性不施加的分支（matched=${r.matched} 必须 <= 5）`)
  assert.ok(r.matched <= 5, `词法融合候选必须 <= 5，实际 ${r.matched}`)

  // (a) 只共享标签、与查询无任何词法重合的记录必须被返回
  const row = r.rows.find((x) => x.id === ids.t)
  assert.ok(row !== undefined, `仅由标签图到达的记录必须被返回：${r.rows.map((x) => x.id).join('>')}`)
  // (b) 无**词法**证据 ⇒ rel 恰好为 0（不是"很小"，也不做统一扣分）
  assert.equal(row.rel, 0, '无词法证据 ⇒ rel 必须恰好为 0')
  // (c) 但图有证据 ⇒ graph > 0 且在硬上限内
  assert.ok(row.graph > 0 && row.graph <= r.graphBonusCap, `图到达必须 graph>0 且 <= graphBonusCap：${row.graph}`)
  // (d) via 必须如实标出图来源标签（旧描述宣称这种行"rel/score 均为 0.0000、无证据"，是错的）
  assert.ok(row.via.startsWith('tag:'), `图到达的 via 必须以 tag: 开头：${row.via}`)
  assert.equal(row.via, 'tag:beta', `最强来源标签必须如实打印：${row.via}`)
  // (e) match 是绝对判定：无词法证据 ⇒ none（且可由 rel + 阈值复算）
  assert.equal(row.match, 'none', '无词法证据 ⇒ match 必须为 none')
  assert.equal(row.match, matchLevel(row.rel, r.weakThreshold, r.strongThreshold), 'match 必须能由打印的 rel + 阈值复算')
  // (f) score 必须是有限数，且**与 absoluteDisp(rel+graph) 一致**（0 或 >0 都允许，
  //     但不允许出现"打印的 rel/graph 复算不出来的第三个值"）。
  //     默认标度下它打印成 0.0000 —— 那只是因为 SCALE_A > GRAPH_BONUS_CAP（余量 0.0007），
  //     不是这条记录没有图奖励；下面的区分力自检把这一点钉住。
  assert.ok(Number.isFinite(row.score), `score 必须是有限数：${row.score}`)
  assert.equal(row.score, absoluteDisp(row.rel + row.graph, r.scaleA, r.scaleB),
    `score 必须 = absoluteDisp(rel+graph)（多样性不施加时）：rel=${row.rel} graph=${row.graph}`)
  assert.equal(r.scaleA, SCALE_A, '夹具前提：默认标度 A')
  assert.ok(r.scaleA > r.graphBonusCap, `夹具前提：默认标度地板高于图奖励上限（余量 ${r.scaleA - r.graphBonusCap}）`)
  assert.equal(row.score, 0, `默认标度下这条记录打印 0.0000（因为 scaleA 高于 graph 上限）：${row.score}`)

  // 打印列必须与结构化行逐字一致（行尾仍是 score）
  const line = r.lines.find((l) => idOfLine(l) === ids.t)
  assert.ok(line !== undefined, '这条记录必须真的被打印出来')
  const f = line.split(SPLIT)
  assert.equal(Number(f[4]), Number(row.graph.toFixed(4)), 'graph 必须打印在第 5 列')
  assert.equal(f[5], row.via, 'via 必须打印在第 6 列')
  assert.equal(Number(f.at(-1)), Number(row.score.toFixed(4)), 'score 必须仍在行尾')

  // 区分力自检（证明"0.0000 由标度常数造成"）：把标度地板压到 0，
  // 同一条记录（rel 仍为 0、graph 仍 >0）的 score 必须 > 0。
  const r2 = await tools({ score: { scaleA: 0 } }).get('memory_recall').execute({ query: 'alpha', limit: 3 })
  const row2 = r2.rows.find((x) => x.id === ids.t)
  assert.ok(row2 !== undefined, '换标度后这条记录仍必须被返回')
  assert.equal(row2.rel, 0, '换标度不得改变 rel')
  assert.ok(row2.graph > 0, '换标度不得改变 graph')
  assert.ok(row2.score > 0, `标度地板压到 0 后 score 必须 > 0：${row2.score}`)
  assert.equal(row2.score, absoluteDisp(row2.rel + row2.graph, r2.scaleA, r2.scaleB),
    '换标度后 score 仍必须 = absoluteDisp(rel+graph)')
})

test('I3 工具层：2000 条规模下工作量有界（图与传播都是线性量级，不许 O(n²) 爆炸）', async () => {
  const home = freshHome('graph-scale')
  // 直接落盘造 2000 条（走 remember 要 2000 次串行写，太慢；这里只考召回侧的工作量）
  const lines = []
  for (let i = 0; i < 2000; i += 1) {
    const ts = Date.now() - (2000 - i) * 1000
    lines.push(JSON.stringify({
      id: `mem_scale_${String(i).padStart(5, '0')}`,
      ts, kind: 'fact', title: `规模条目编号 ${i}`, body: `规模正文 alpha 内容 ${i}`,
      tags: [`g${i % 40}`, `t${i % 97}`], source: 'test:scale', hits: 0,
    }))
  }
  mkdirSync(dirname(memFile(home)), { recursive: true })
  writeFileSync(memFile(home), lines.join('\n') + '\n', 'utf8')

  const defs = tools()
  const t0 = Date.now()
  const r = await defs.get('memory_recall').execute({ query: 'alpha 内容', limit: 20 })
  const elapsed = Date.now() - t0
  assert.equal(r.total, 2000, '库内必须真的有 2000 条')
  // 图规模有界：节点 <= 不同标签数（40+97），有向边 <= 2 × 节点对上限
  assert.ok(r.graphNodes <= 40 + 97, `节点数必须 <= 不同标签数：${r.graphNodes}`)
  assert.ok(r.graphEdges <= r.graphNodes * (r.graphNodes - 1), `边数必须有界：${r.graphEdges}`)
  assert.ok(Number.isFinite(r.graphNodes) && Number.isFinite(r.graphEdges))
  // 传播边界：三条上限逐条成立
  assert.ok(r.graphStatesUsed <= r.maxStates, `状态数必须 <= maxStates：${r.graphStatesUsed}`)
  assert.ok(r.graphHops <= r.maxHops, `跳数必须 <= maxHops：${r.graphHops}`)
  assert.ok(r.propagatedTags.length <= r.graphNodes, '传播标签数不得超过节点数')
  assert.equal(r.limit, 20)
  assert.ok(r.rows.length <= 20)
  // 工作量有界：O(n²) 的实现在 2000 条上会明显更慢；这里给一个宽松但能判红的上限。
  assert.ok(elapsed < 5000, `2000 条召回必须远快于 O(n²) 爆炸：实测 ${elapsed}ms`)
  assertLossless('I3 规模', r)
})

// ── E. 五条红证 ─────────────────────────────────────────────────────────────

test('红证 1（判红点：关掉传播 maxHops=0 或跳过图奖励 ⇒ 本条变红）：与查询无词法重合、但共享标签的记忆必须被召回', async () => {
  freshHome('graph-red1')
  const defs = tools()
  const ids = await seedGraphRecall(null, defs)
  const recall = defs.get('memory_recall')

  // 夹具自检：目标记录在任何词法证据之外
  const r = await recall.execute({ query: 'alpha', limit: 3 })
  const rows = r.rows
  const target = rows.find((x) => x.id === ids.t)
  assert.ok(target !== undefined, `共享 beta 的记忆必须被召回：实际行 ${rows.map((x) => x.id.slice(-6)).join('>')}`)
  assert.equal(target.rel, 0, '夹具前提：这条记忆与查询没有任何词法重合（rel 必须是 0）')
  assert.ok(target.graph > 0, '它必须拿到正图奖励')
  assert.equal(target.via, 'tag:beta', '来源必须标出最强来源标签')
  assert.ok(r.reachable >= 1, 'reachable（图新增可达）必须至少 1')

  // 判红点：关掉传播 ⇒ 这条记忆必须消失
  const off = tools({ graph: { maxHops: 0 } })
  const r0 = await off.get('memory_recall').execute({ query: 'alpha', limit: 3 })
  assert.ok(!r0.rows.some((x) => x.id === ids.t), '关掉传播后这条记忆必须消失（判红点：图召回没接上）')
  assert.equal(r0.reachable, 0, '关掉传播后 reachable 必须是 0')
  assert.equal(r0.propagatedTags.length, 0, '关掉传播后不得有传播标签')
  // 词法部分必须照旧（关图不该影响 rel/顺序）
  assert.deepEqual(r0.rows.map((x) => x.rel).slice(0, 2), rows.map((x) => x.rel).slice(0, 2), '关图不得改变词法相关度')
  assert.equal(r0.rows[0].id, rows[0].id, '关图不得改变词法排序')
})

test('红证 2（判红点：去掉枢纽校正 hubEta=0 ⇒ 判据变红）：万能标签被压住，不许淹没词法最强那条', async () => {
  freshHome('graph-red2')
  const defs = tools()
  const rem = defs.get('memory_remember')
  // I5 表头减肥后行预算回来了：夹具恢复成旧口径的正常长度（原先为绕开长表头的 2000 字符预算，
  // 标题/正文/标签名被刻意压短：'alpha focused note'→'alpha a0'、decoy0→d0 等）。
  // A：查询词法最强（alpha 同时出现在 tags 与 title/body）
  const a = await rem.execute({ kind: 'fact', title: 'alpha focused note', body: 'alpha evidence here', tags: ['alpha', 'gamma'], source: 'test:graph' })
  const hub = await rem.execute({ kind: 'fact', title: 'alpha hub record', body: 'alpha something else', tags: ['alpha', '万能'], source: 'test:graph' })
  // 万能标签横跨 7 条记录（入度 6 >> 中位数 1）⇒ 必须被判成枢纽并压制。
  // decoy 只放 4 个：每个顶点都要吃一个 maxStates 名额，太多会把名额用光，
  // 万能标签（码元排在 ASCII 之后）展开时名额已尽 ⇒ zeta 一个都传不到（夹具失真，不是机制）。
  for (let i = 0; i < 4; i += 1) {
    await rem.execute({ kind: 'fact', title: `d${i} note title`, body: `d${i} body text`, tags: [`decoy${i}`, '万能'], source: 'test:graph' })
  }
  // z / z2：与 alpha 无任何词法重合，只能经万能标签到达（万能 -> zeta）
  const z = await rem.execute({ kind: 'fact', title: 'zeta target title', body: 'zeta body', tags: ['万能', 'zeta'], source: 'test:graph' })
  const z2 = await rem.execute({ kind: 'fact', title: 'zeta extra title', body: 'zeta extra body', tags: ['万能', 'zeta'], source: 'test:graph' })
  await rem.execute({ kind: 'fact', title: 'filler body item', body: 'plain jane text', tags: ['x'], source: 'test:graph' })
  assert.equal(hub.ok, true)
  assert.equal(z.ok, true)
  assert.equal(z2.ok, true)

  const recall = defs.get('memory_recall')
  const r = await recall.execute({ query: 'alpha', limit: 30 })
  const header = r.text.split('\n')[0]

  // (a) 万能标签必须被识别并压住（枢纽校正生效）
  assert.ok(r.hubSuppressed.includes('万能'), `hubSuppressed 必须列出万能标签：${JSON.stringify(r.hubSuppressed)}`)
  assert.ok(header.includes('枢纽被压'), '表头必须如实回报枢纽被压的数量/名单')
  // (b) 图奖励的硬上限对**每一行**都成立；默认上限就是 GRAPH_BONUS_CAP
  assert.equal(r.graphBonusCap, GRAPH_BONUS_CAP)
  for (const row of r.rows) {
    assert.ok(row.graph >= 0 && row.graph <= r.graphBonusCap + 1e-12, `每行图奖励必须 <= 上限：${row.graph}`)
  }
  // (c) 没有淹没结果：词法最强那条仍是第一名（图奖励被硬上限截住，压不过 rel）
  assert.equal(r.rows[0].id, a.id, '图奖励 Top1 必须仍是词法最强那条（判红点：去掉枢纽校正后万能标签会接管第一名）')
  assert.ok(r.rows[0].rel > 0, '第一名必须有词法证据（图奖励不得单独决定名次）')

  // 判红点（区分力自检）：枢纽校正必须真的在压「万能」这条通路。
  // 默认上限 0.018 太小、会把所有图奖励一起截到同一个数（量不出差别），所以把上限放开量原始量。
  const loose = tools({ graph: { bonusCap: 0.5 } })
  const rl = await loose.get('memory_recall').execute({ query: 'alpha', limit: 30 })
  const hubLoose = rl.rows.find((x) => x.id === hub.id)
  assert.ok(hubLoose !== undefined, '放开上限后万能标签记录必须在候选里')
  assert.ok(hubLoose.graph > r.graphBonusCap,
    `放开硬上限后万能标签记录的原始奖励必须超过默认上限（证明默认上限真的在截断）：${hubLoose.graph}`)
  assert.equal(rl.rows[0].id, a.id, '放开上限后词法最强那条仍应是第一名（它还带着自己的 rel）')

  // 判红点：hubEta=0 等价于「去掉枢纽校正」⇒ 万能标签的**下游**（zeta）才能被真正点亮。
  // 默认配置下 zeta 的激活 = 0.255 × 0.378 × γ × (1−ρ) ≈ 0.049 < activationMin(0.05)，
  // 也就是说：**校正把它压到了"有证据"的门槛之下**；去掉校正后它 = 0.13 > 0.05 才成立。
  const propagatedTags = (res) => res.propagatedTags.map((x) => x.tag)
  assert.ok(!propagatedTags(rl).includes('zeta'), '默认（有枢纽校正）时下游标签 zeta 达不到激活下限')
  const noHub = tools({ graph: { bonusCap: 0.5, hubEta: 0 } })
  const r0 = await noHub.get('memory_recall').execute({ query: 'alpha', limit: 30 })
  assert.deepEqual(r0.hubSuppressed, [], 'hubEta=0 时不得再压任何标签（等价于去掉枢纽校正）')
  assert.ok(propagatedTags(r0).includes('zeta'),
    `去掉枢纽校正后 zeta 必须达到激活下限（判红点：校正没生效时它也做得到）：${JSON.stringify(r0.propagatedTags)}`)
  const z0 = r0.rows.find((x) => x.id === z.id)
  assert.ok(z0 !== undefined, '去掉枢纽校正后这条记录必须出现')
  // 注意：z 的记录里同时有「万能」和「zeta」，而奖励取 max ⇒ 1 跳的万能(0.255)恒大于
  // 2 跳的 zeta，所以 z 那一行的 graph 在校正前后都是 0.06375（这是 max 语义的必然结果，
  // 不是机制没生效）。能判红的量是**下游标签本身能否达到激活下限**，见上面那条断言。
  assert.ok(z0.graph <= 0.5 + 1e-12, '即便放开上限，也不得超过本次配置的上限')
})

test('红证 3（判红点：放开某个上限 ⇒ 本条变红）：maxStates / maxHops / maxFieldNeighbors 逐条断言', async () => {
  freshHome('graph-red3')
  const defs = tools()
  const rem = defs.get('memory_remember')
  // 20 个种子标签，各自 1 个 hub，每个 hub 4 个后继：
  //   邻居激活 = 1 × 0.51 × γ × (1−ρ) / 4 ≈ 0.0765 > activationMin(0.05)，邻居能真的被到达；
  //   总状态数 = 20 + 20 + 80 = 120，远超默认 maxStates=64。
  const seedTags = []
  for (let i = 0; i < 20; i += 1) {
    const sv = `s${String(i).padStart(2, '0')}`
    const hv = `h${String(i).padStart(2, '0')}`
    seedTags.push(sv)
    await rem.execute({ kind: 'fact', title: `seed record ${i}`, body: `seed body ${i}`, tags: [sv, hv], source: 'test:graph' })
    for (let j = 0; j < 4; j += 1) {
      await rem.execute({ kind: 'fact', title: `neighbor record ${i} ${j}`, body: `neighbor body ${i} ${j}`, tags: [hv, `n${i}_${j}`], source: 'test:graph' })
    }
  }
  const recall = defs.get('memory_recall')
  const r = await recall.execute({ query: seedTags.join(' '), limit: 5 })
  const nTags = (res) => res.propagatedTags.filter((p) => /^n\d+_\d+$/.test(p.tag)).length

  assert.equal(r.maxStates, GRAPH_MAX_STATES)
  assert.equal(r.maxHops, GRAPH_MAX_HOPS)
  assert.equal(r.maxFieldNeighbors, GRAPH_MAX_FIELD_NEIGHBORS)
  assert.ok(r.graphStatesUsed <= r.maxStates, `状态数 <= maxStates：${r.graphStatesUsed}`)
  assert.ok(r.graphHops <= r.maxHops, `跳数 <= maxHops：${r.graphHops}`)
  assert.equal(r.graphStatesTruncated, true, '本夹具必须撞上 maxStates（否则这条断言没有说服力）')
  assert.equal(r.graphStatesUsed, GRAPH_MAX_STATES, '撞上后状态数必须恰好等于上限（不多走一步）')
  assert.ok(r.propagatedTags.length <= r.graphNodes, '传播标签数不得超过图节点数')
  assert.ok(nTags(r) > 0, `默认配置下第 2 跳的后继必须出现（否则后面的上限断言看不出差别）：${nTags(r)}`)

  // 判红点 1：把 maxStates 放开 ⇒ 状态数必须变多（上限真的在截断）
  const open = tools({ graph: { maxStates: 4096 } })
  const rOpen = await open.get('memory_recall').execute({ query: seedTags.join(' '), limit: 5 })
  assert.ok(rOpen.graphStatesUsed > r.graphStatesUsed,
    `放开 maxStates ⇒ 状态数必须更多（判红点：上限没生效）：${r.graphStatesUsed} -> ${rOpen.graphStatesUsed}`)
  assert.equal(rOpen.graphStatesTruncated, false, '放开上限后不得再标记截断')
  assert.ok(rOpen.propagatedTags.length >= r.propagatedTags.length, '放开上限后到达标签数不得变少')

  // 判红点 2：把 maxFieldNeighbors 放到 1 ⇒ 每个 hub 只能沿 1 条最强出边走
  const one = tools({ graph: { maxFieldNeighbors: 1 } })
  const rOne = await one.get('memory_recall').execute({ query: seedTags.join(' '), limit: 5 })
  assert.equal(rOne.maxFieldNeighbors, 1)
  assert.ok(nTags(rOne) <= 20, `每 hub 只走 1 条出边 ⇒ 后继标签最多 20 个（= hub 数）：${nTags(rOne)}`)
  assert.ok(nTags(rOne) < nTags(r), `maxFieldNeighbors=1 必须让后继标签变少（判红点：上限没生效）：${nTags(rOne)} vs ${nTags(r)}`)

  // 判红点 3：把 maxHops 放到 1 ⇒ hub 的后继（第 2 跳）一个都不该出现
  const hop1 = tools({ graph: { maxHops: 1 } })
  const rHop1 = await hop1.get('memory_recall').execute({ query: seedTags.join(' '), limit: 5 })
  assert.equal(rHop1.maxHops, 1)
  assert.equal(rHop1.graphHops, 1)
  assert.equal(nTags(rHop1), 0, 'maxHops=1 ⇒ 第 2 跳的后继标签一个都不该出现')
})

test('红证 4（判红点：邻居遍历改成非确定序 ⇒ 本条变红）：同一库 + 同一查询两次调用，行文本逐字节相同', async () => {
  freshHome('graph-red4')
  const defs = tools()
  await seedGraphRecall(null, defs)
  const recall = defs.get('memory_recall')

  const r1 = await recall.execute({ query: 'alpha', limit: 5 })
  const r2 = await recall.execute({ query: 'alpha', limit: 5 })
  assert.deepEqual(r1.lines, r2.lines, '同一库同一查询两次调用，行文本必须逐字节相同')
  assert.deepEqual(r1.rows, r2.rows, '结构化行也必须逐字段相同（含 via 与 graph）')
  assert.deepEqual(r1.propagatedTags, r2.propagatedTags, '传播标签与激活必须逐字段相同')
  assert.deepEqual(r1.hubSuppressed, r2.hubSuppressed)
  assert.ok(r1.rows.some((x) => x.graph > 0), '夹具里必须有图证据，否则「逐字节相同」是空判据')
  assert.ok(r1.rows.some((x) => x.via.startsWith('tag:')), '夹具里必须有图来源行')

  // 夹具自检（区分力）：图/传播的排序键若要「确定」，就必须与 Map 插入顺序无关。
  // 直接把同一批边以**两种插入顺序**喂给 tagGraphIndex，结果必须逐字段相同。
  const tagsA = [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['d', 'e']]
  const g1 = tagGraphIndex(tagsA.map((t, i) => rec(`r${i}`, t)))
  const g2 = tagGraphIndex([...tagsA].reverse().map((t, i) => rec(`r${i}`, t)))
  assert.deepEqual(
    g1.nodes.map((n) => [n.tag, n.outEdges.map((e) => [e.to, Number(e.weight.toFixed(12))])]),
    g2.nodes.map((n) => [n.tag, n.outEdges.map((e) => [e.to, Number(e.weight.toFixed(12))])]),
    '同一批边以不同插入顺序构出的图必须一致（否则「确定序」是假判据）',
  )
  assert.deepEqual(propagateTags(['a'], g1), propagateTags(['a'], g2), '不同插入顺序不得改变传播结果')
})

test('红证 5（判红点：把图/传播状态提到模块级复用 ⇒ 本条变红）：请求级隔离', async () => {
  const home = freshHome('graph-red5')
  const defs = tools()
  const rem = defs.get('memory_remember')
  // 两组标签完全不相交的记录：A 组标签空间 aa/ab/ac，B 组空间 ba/bb/bc
  const seeds = [
    ['note aa one record', 'body for aa record', ['aa']],
    ['note ab two record', 'body for ab record', ['ab']],
    ['note ac three record', 'body for ac record', ['ac']],
    ['note ba one record', 'body for ba record', ['ba']],
    ['note bb two record', 'body for bb record', ['bb']],
    ['note bc three record', 'body for bc record', ['bc']],
  ]
  for (const [title, body, tags] of seeds) {
    const w = await rem.execute({ kind: 'fact', title, body, tags, source: 'test:graph' })
    assert.equal(w.ok, true)
  }

  // ① 「单独只跑第二次」：新进程 + 干净模块状态（同进程里先前的调用会把模块级状态喂饱 ⇒ 假绿）
  const alone = JSON.parse(execFileSync(NODE_BIN, [PROBE, 'ba bb', '3', 'graph'], {
    env: { ...process.env, DSH_HOME: home }, encoding: 'utf8',
  }))

  // ② 同进程：先跑第一次（另一组标签方向），让出一次事件循环，再跑第二次
  const recall = defs.get('memory_recall')
  const first = await recall.execute({ query: 'aa ab ac', limit: 10 })
  assert.ok(first.shown > 0, '第一次召回必须真的取到候选（否则没有"上一次状态"可复用）')
  await new Promise((resolve) => { setImmediate(resolve) })
  const second = await recall.execute({ query: 'ba bb', limit: 3 })

  // 比对字段与 test/isolation-probe.mjs 的输出**逐字段对齐**（探针里多一个字段、这里少一个，
  // deepEqual 就会因"多了键"失败 —— 那也是假红）。
  const seq = {
    expanded: second.expanded,
    kBase: second.kBase,
    kUsed: second.kUsed,
    novelty: second.novelty,
    explainedRatio: second.explainedRatio,
    residualRatio: second.residualRatio,
    basisSize: second.basisSize,
    layers: second.layers,
    logicalDepth: second.logicalDepth,
    lowConfidence: second.lowConfidence,
    covMax: second.covMax,
    shown: second.shown,
    graphNodes: second.graphNodes,
    graphEdges: second.graphEdges,
    propagatedTags: second.propagatedTags,
    maxHops: second.maxHops,
    maxStates: second.maxStates,
    maxFieldNeighbors: second.maxFieldNeighbors,
    graphBonusCap: second.graphBonusCap,
    hubSuppressed: second.hubSuppressed,
    reachable: second.reachable,
    graphSeedCount: second.graphSeedCount,
    graphStatesUsed: second.graphStatesUsed,
    graphHops: second.graphHops,
    graphStatesTruncated: second.graphStatesTruncated,
    graphEvidence: second.graphEvidence,
    rowIds: second.rows.map((row) => row.id),
    rowGraph: second.rows.map((row) => row.graph),
    rowVia: second.rows.map((row) => row.via),
  }
  assert.deepEqual(Object.keys(seq).sort(), Object.keys(alone).sort(), '比对字段集必须与探针输出逐字段对齐')
  assert.deepEqual(seq, alone,
    '第二次的图/传播字段必须与「单独只跑第二次」逐字段一致（判红点：把状态提到模块级复用就不同）')
  assert.ok(seq.rowIds.length > 0)

  // 夹具自检（区分力）：污染模型必须真的能改变结论，否则上面那条比对是假判据。
  // 用纯函数层复算「干净场」与「被 A 组种子污染后的场」。
  const clean = propagateTags(['ba', 'bb', 'bc'], tagGraphIndex(seeds.map(([t, b, tags], i) => ({ id: `r${i}`, title: t, body: b, tags }))), resolveGraphOptions())
  const polluted = propagateTags(['aa', 'ab', 'ac', 'ba', 'bb', 'bc'], tagGraphIndex(seeds.map(([t, b, tags], i) => ({ id: `r${i}`, title: t, body: b, tags }))), resolveGraphOptions())
  const slim = (p) => p.propagated.map((x) => [x.tag, Number(x.weight.toFixed(9))])
  assert.notDeepEqual(slim(clean), slim(polluted), '夹具必须对「种子/状态被跨请求污染」有区分力')
})

// ── F. 纯函数层的边界（常数与口径）──────────────────────────────────────────

test('I3 口径：模块级默认常数、可配置覆盖、非法值回落（解析本身不抛）', () => {
  const cfg = resolveGraphOptions()
  assert.equal(cfg.lambda, GRAPH_LAMBDA)
  assert.equal(cfg.outBudget, GRAPH_OUT_BUDGET)
  assert.equal(cfg.hubEta, GRAPH_HUB_ETA)
  assert.equal(cfg.maxHops, GRAPH_MAX_HOPS)
  assert.equal(cfg.maxStates, GRAPH_MAX_STATES)
  assert.equal(cfg.maxFieldNeighbors, GRAPH_MAX_FIELD_NEIGHBORS)
  assert.equal(cfg.decay, GRAPH_DECAY)
  assert.equal(cfg.backflowRho, GRAPH_BACKFLOW_RHO)
  assert.equal(cfg.bonusCap, GRAPH_BONUS_CAP)
  assert.equal(cfg.bonusScale, GRAPH_BONUS_SCALE)
  assert.equal(cfg.activationMin, GRAPH_ACTIVATION_MIN)
  // 起点值必须落在契约要求的量级上
  assert.equal(GRAPH_BONUS_CAP, 0.018)
  assert.ok(GRAPH_DECAY > 0 && GRAPH_DECAY < 1)
  assert.ok(GRAPH_BACKFLOW_RHO >= 0 && GRAPH_BACKFLOW_RHO < 1)
  // 覆盖生效
  const custom = resolveGraphOptions({ maxHops: 1, maxStates: 7, maxFieldNeighbors: 2, bonusCap: 0.5, decay: 0.9 })
  assert.deepEqual([custom.maxHops, custom.maxStates, custom.maxFieldNeighbors, custom.bonusCap, custom.decay], [1, 7, 2, 0.5, 0.9])
  // 非法值回落、绝不出 NaN
  const bad = resolveGraphOptions({ maxHops: Number.NaN, maxStates: -3, maxFieldNeighbors: 1e9, lambda: 0, outBudget: -1, decay: 5, backflowRho: -2, hubEta: Number.NaN })
  for (const v of Object.values(bad)) assert.ok(Number.isFinite(v), `解析结果必须有限：${JSON.stringify(bad)}`)
  assert.equal(bad.maxStates, 0, '负数夹到 0（= 关断）')
  assert.equal(bad.maxFieldNeighbors, 64, '过大值夹到上界')
  assert.equal(bad.lambda, GRAPH_LAMBDA, '非正 λ 回落默认')
  assert.equal(bad.decay, 1, '越小越衰减：大于 1 的 γ 被夹到 1（不放大）')
  assert.equal(bad.backflowRho, 0)
  // tagGraphSize 便捷包装与 tagGraphIndex 一致
  const recs = [rec('r1', ['a', 'b']), rec('r2', ['b', 'c'])]
  const size = tagGraphSize(recs)
  assert.equal(size.nodes, 3)
  assert.equal(size.edges, 2)
})
