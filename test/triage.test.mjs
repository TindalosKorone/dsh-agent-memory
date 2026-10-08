// I2 用例：残差金字塔式分诊（词法空间 Gram-Schmidt）+ 请求级隔离 + 三条红证 + 边界。
//
// 三条红证（判红点写在用例名与断言消息里，关机制后必须变红）：
//  1) 低覆盖必须扩检索、且不得返回空 —— 判红点：把 expanded 强制为 false
//  2) 高覆盖不得无缘无故扩检索     —— 判红点：把 expanded 强制为 true
//  3) 请求级隔离                    —— 判红点：把金字塔状态提到模块级并在两次调用间复用
//
// I2.1 两处修（用户拍板）：
//  - 修 1「limit 是硬显示上限」：返回行数恒为 min(limit, 可用候选数)；扩检索只放大内部预算
//    kBase->kUsed，不再增加显示行数。判红点：去掉显示截断（按 kUsed 显示）⇒ rows=kUsed>limit。
//  - 修 2「空查询不做分诊」：‖q‖²≈0 ⇒ novelty=0、expanded=false、kUsed=kBase、比值回显 0/0。
//    判红点：关掉「无词元能量 ⇒ 未分诊」分支走旧公式 ⇒ novelty=0.7、expanded=true。
//    契约因此被改的旧断言已在原处标注「I2.1 修 1/修 2 契约更新」（不放松判据，只改口径）。
//
// 教训延续（I1.3）：新增的每条断言都必须能判红；凡是在夹具下恒真的判据，都补一条
// 「区分力自检」把它钉住（参考 test/scoring.test.mjs 的 bandRows 写法）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_ACTIVATION_THRESHOLD, DEFAULT_NOVELTY_THRESHOLD, MAX_BASIS, MAX_LAYERS,
  NOVELTY_DIRECTION_WEIGHT, NOVELTY_RESIDUAL_WEIGHT, RESIDUAL_STOP,
  corpusStats, gramSchmidt, normalizedTags, projectionEntropy, residualPyramid,
  resolveTriageOptions, sparseDot, sparseNorm2, tagVector, tokenize,
} from '../lib/pure.js'
import { assertLossless, freshHome, tools } from './helpers.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROBE = join(HERE, 'isolation-probe.mjs')
// 【本机坑】Android/Termux 上 process.execPath 是 linker64（/apex/com.android.runtime/bin/linker64），
// 拿它当 node 去 spawn 会报 `bad ELF magic`；process.argv0 才是真正的 node 路径。
const NODE_BIN = process.argv0 !== '' && existsSync(process.argv0) ? process.argv0 : process.execPath

const SPLIT = ' | '
const idOfLine = (line) => line.split(SPLIT)[0]

/** 语料统计夹具：tagN=1，aa..ff 的 df=1；qq/zz 等不在标签里 ⇒ df=0 ⇒ 取 idf 上界。 */
const STATS = corpusStats([{ title: 'seed record body', body: 'seed body text', tags: ['aa', 'bb', 'cc', 'dd', 'ee', 'ff'] }])

/** 分诊字段的有限性/区间检查（任一字段泄漏 NaN/Infinity 都要在这里爆掉）。 */
function checkTriageFields(label, r) {
  for (const key of ['novelty', 'explainedRatio', 'residualRatio', 'logicalDepth', 'covMax', 'noveltyThreshold', 'activationThreshold']) {
    assert.ok(Number.isFinite(r[key]), `${label}: ${key} 必须有限，实际 ${r[key]}`)
  }
  for (const key of ['kBase', 'kUsed', 'basisSize', 'layers']) {
    assert.ok(Number.isInteger(r[key]) && r[key] >= 0, `${label}: ${key} 必须是非负整数，实际 ${r[key]}`)
  }
  assert.equal(typeof r.expanded, 'boolean')
  assert.equal(typeof r.lowConfidence, 'boolean')
  for (const key of ['novelty', 'explainedRatio', 'residualRatio', 'logicalDepth', 'covMax']) {
    assert.ok(r[key] >= 0 && r[key] <= 1, `${label}: ${key} 必须落在 0..1，实际 ${r[key]}`)
  }
  // I2.1 修 2 契约更新（用户拍板）：查询无词元能量（noQueryEnergy=true）时**未做分诊**：
  //  - explainedRatio/residualRatio 如实回显 0/0（0/0 未定义，不假造 1 去凑守恒式）；
  //  - expanded 被显式钉为 false（与阈值无关）。
  // 因此「和=1」与「expanded ⟺ novelty>=threshold」这两条只在**有词元能量**时成立。
  assert.equal(typeof r.noQueryEnergy, 'boolean')
  if (!r.noQueryEnergy) {
    assert.ok(Math.abs((r.explainedRatio + r.residualRatio) - 1) < 1e-12, `${label}: 两者必须守恒（和=1）`)
    assert.equal(r.expanded, r.novelty >= r.noveltyThreshold, `${label}: expanded 必须等于 novelty >= noveltyThreshold`)
  } else {
    assert.equal(r.novelty, 0, `${label}: 无词元能量 ⇒ novelty 必须为 0（旧公式会给 0.7）`)
    assert.equal(r.expanded, false, `${label}: 无词元能量 ⇒ expanded 必须为 false（未分诊，与阈值无关）`)
    assert.equal(r.kUsed, r.kBase, `${label}: 无词元能量 ⇒ 不扩检索，kUsed=kBase`)
    assert.equal(r.explainedRatio, 0, `${label}: 无词元能量 ⇒ explainedRatio 回显 0（0/0 未定义）`)
    assert.equal(r.residualRatio, 0, `${label}: 无词元能量 ⇒ residualRatio 回显 0（0/0 未定义）`)
  }
  assert.equal(r.lowConfidence, r.covMax < r.activationThreshold, `${label}: lowConfidence 必须等于 covMax < activationThreshold`)
  // 注意：kUsed 是「本次取回预算」；库容小于 kBase 时会被库容截断（规格：kExpanded 不超过库内条数），
  // 所以这里**不**断言 kUsed >= kBase，具体口径在「红证 1/2」与边界用例里逐条钉死。
  assert.ok(r.kUsed <= Math.max(r.kBase * 2, r.kBase), `${label}: kUsed 不得超过扩检索上限`)
  assert.ok(r.basisSize <= MAX_BASIS, `${label}: basisSize 不得超过 maxBasis`)
  assert.ok(r.layers <= MAX_LAYERS, `${label}: layers 不得超过 maxLayers`)
}

/** 给纯函数层的结果补上「工具层才有的字段」（保持一致，好复用同一套字段检查）。 */
function withToolFields(r, extra = {}) {
  const covMax = extra.covMax ?? 0
  const activationThreshold = extra.activationThreshold ?? DEFAULT_ACTIVATION_THRESHOLD
  return {
    ...r, kBase: 0, kUsed: 0, covMax, activationThreshold,
    lowConfidence: covMax < activationThreshold, ...extra,
  }
}

/** 只取分诊量（用于「污染模型 vs 干净模型」的逐字段比对）。 */
function pyramidFields(r) {
  return {
    novelty: r.novelty,
    explainedRatio: r.explainedRatio,
    residualRatio: r.residualRatio,
    directionConsistency: r.directionConsistency,
    basisSize: r.basisSize,
    layers: r.layers,
    logicalDepth: r.logicalDepth,
    expanded: r.expanded,
  }
}

// ── 纯函数层：Gram-Schmidt ──────────────────────────────────────────────────

test('Gram-Schmidt：正交归一、跳过线性相关向量、保持张成（判红点：只归一化不正交化，两两内积就不为 0）', () => {
  const v1 = new Map([['a', 1], ['b', 2]])
  const v2 = new Map([['b', 1], ['c', 3]])
  const v3 = new Map([['a', 2], ['b', 4]]) // = 2 × v1 ⇒ 线性相关，必须被丢掉
  const v4 = new Map([['d', 1]])
  const basis = gramSchmidt([v1, v2, v3, v4])

  assert.equal(basis.length, 3, `线性相关向量必须被丢弃（期望 3 个基，实际 ${basis.length}）`)
  for (const u of basis) {
    assert.ok(Math.abs(sparseNorm2(u) - 1) < 1e-12, `基向量必须是单位向量：‖u‖²=${sparseNorm2(u)}`)
  }
  for (let i = 0; i < basis.length; i += 1) {
    for (let j = i + 1; j < basis.length; j += 1) {
      assert.ok(Math.abs(sparseDot(basis[i], basis[j])) < 1e-12, `基必须两两正交：i=${i} j=${j}`)
    }
  }

  // 保持张成：把任一原始向量减掉它在基上的投影，残差必须是零向量（v3 也在张成里）。
  const residualOf = (v) => {
    const r = new Map(v)
    for (const u of basis) {
      const c = sparseDot(r, u)
      for (const [k, w] of u) r.set(k, (r.get(k) ?? 0) - c * w)
    }
    return r
  }
  for (const [name, v] of [['v1', v1], ['v2', v2], ['v3', v3], ['v4', v4]]) {
    assert.ok(sparseNorm2(residualOf(v)) < 1e-20, `${name} 必须落在基的张成里（残差应为 0）`)
  }
  // 区分力自检：不在张成里的向量，残差必须不为 0（否则上面那条「保持张成」是假绿）
  assert.ok(sparseNorm2(residualOf(new Map([['z', 1]]))) > 0.9, '张成外的向量残差必须非零')

  // 区分力自检：只做归一化、不做正交化时，v1/v2 的内积远不为 0 ⇒ 上面「两两正交」有区分力
  const unit = (v) => {
    const inv = 1 / Math.sqrt(sparseNorm2(v))
    const out = new Map()
    for (const [k, w] of v) out.set(k, w * inv)
    return out
  }
  assert.ok(Math.abs(sparseDot(unit(v1), unit(v2))) > 0.1,
    '夹具必须让「只归一化」的正交性判据失败，否则本判据没有区分力')

  // 确定性：同输入必然同输出（浮点求和顺序固定）
  assert.deepEqual(gramSchmidt([v1, v2, v3, v4]).map((m) => [...m]), basis.map((m) => [...m]))
  // 退化输入：零向量 / 非有限权重不得泄 NaN
  assert.deepEqual(gramSchmidt([new Map(), new Map([['a', Number.NaN]]), new Map([['a', -1]])]), [])
})

// ── 纯函数层：能量守恒与逐层复算 ─────────────────────────────────────────────

test('能量守恒：explainedRatio 由独立的 gramSchmidt 复算得出，且 explained+residual=1（判红点：跳过正交化就对不上）', () => {
  const docs = [
    { title: 'alpha beta gamma', body: 'alpha beta gamma details', tags: ['alpha', 'gamma'] },
    { title: 'beta only', body: 'beta appears here', tags: ['beta'] },
    { title: 'delta note', body: 'delta unrelated', tags: ['delta'] },
    { title: 'zeta note', body: 'zeta unrelated', tags: ['zeta'] },
  ]
  const stats = corpusStats(docs)
  const cases = [
    { query: 'alpha beta', tagSets: [['alpha', 'gamma'], ['beta'], ['delta']] },
    { query: 'alpha beta gamma', tagSets: [['alpha'], ['beta'], ['gamma'], ['delta']] },
    { query: 'zeta', tagSets: [['alpha', 'beta'], ['delta']] },
    { query: '完全无关的查询词', tagSets: [['alpha'], ['beta'], ['delta']] },
  ]
  let sawPartial = 0
  for (const c of cases) {
    const cands = c.tagSets.map((tags, i) => ({ id: `c${i}`, tags }))
    const r = residualPyramid(c.query, cands, stats)

    // 独立复算：query 向量 + 候选标签向量 + 正交化 + 逐层投影（含停止规则与层数上限）
    const q = tagVector(tokenize(c.query), stats)
    const raw = []
    for (const cand of cands) {
      const v = tagVector(tokenize(normalizedTags(cand.tags).join(' ')), stats)
      if (v.size > 0) raw.push(v)
    }
    const ortho = gramSchmidt(raw)
    const qE = sparseNorm2(q)
    let proj = 0
    let layers = 0
    if (qE > 0) {
      for (const u of ortho) {
        if (layers >= MAX_LAYERS) break
        const cc = sparseDot(q, u)
        layers += 1
        proj += cc * cc
        if (qE - proj < RESIDUAL_STOP * qE) break
      }
    }
    const expected = qE > 0 ? proj / qE : 0

    assert.equal(r.basisSize, ortho.length, `basisSize 必须等于正交基规模（query=${c.query}）`)
    assert.equal(r.layers, layers, `layers 必须由停止规则逐层复算得出（query=${c.query}）`)
    assert.ok(Math.abs(r.explainedRatio - expected) < 1e-12,
      `explainedRatio 必须等于独立复算的 ‖P‖²/‖q‖²：上报 ${r.explainedRatio}，复算 ${expected}`)
    assert.ok(Math.abs((r.explainedRatio + r.residualRatio) - 1) < 1e-12,
      `能量守恒：${r.explainedRatio} + ${r.residualRatio} != 1`)
    assert.ok(r.projectedBasis === ortho.slice(0, layers).map((u) => sparseDot(q, u) ** 2).filter((e) => e > 1e-12).length,
      'projectedBasis(K) 必须等于能量 > 0 的层数')
    checkTriageFields(`纯函数 query=${c.query}`, withToolFields(r))

    // 停止规则必须「不多做一层」：layers-1 层的残差还不满足停止条件
    if (layers > 0 && layers > 1) {
      let prev = 0
      for (let i = 0; i < layers - 1; i += 1) prev += sparseDot(q, ortho[i]) ** 2
      const capped = layers === Math.min(MAX_LAYERS, ortho.length)
      assert.ok(capped || !(qE - prev < RESIDUAL_STOP * qE), '停止规则必须最早触发，不能白做一层')
    }
    if (r.explainedRatio > 0 && r.explainedRatio < 1) sawPartial += 1
  }
  // 区分力自检：必须有「部分被解释」的样本，否则守恒/复算这两条对中间态毫无说服力
  assert.ok(sawPartial > 0, `夹具必须覆盖部分被解释的中间态（实测 ${sawPartial} 条）`)
})

// ── 纯函数层：投影熵 / 逻辑深度边界 ──────────────────────────────────────────

test('投影熵 → logicalDepth：K=0/1 边界不出 NaN，均摊 → 0、集中 → 1（区分力自检：两者必须不同）', () => {
  assert.deepEqual(projectionEntropy([]), { entropy: 0, k: 0, logicalDepth: 0 }, 'K=0 边界')
  const single = projectionEntropy([5])
  assert.equal(single.k, 1)
  assert.equal(single.entropy, 0)
  assert.equal(single.logicalDepth, 0, 'K=1 边界：log2(1)=0，1−0/0 必须显式定义成 0 而不是 NaN')
  assert.ok(Number.isFinite(single.logicalDepth))
  assert.equal(projectionEntropy([1, 0, 0]).k, 1, '零能量层不参与 K')
  assert.equal(projectionEntropy([1, 0, 0]).logicalDepth, 0)

  const even2 = projectionEntropy([1, 1])
  assert.ok(Math.abs(even2.entropy - 1) < 1e-12, '两个方向均摊 ⇒ H=1 bit')
  assert.equal(even2.logicalDepth, 0, '均摊 ⇒ 逻辑深度 0')
  assert.equal(projectionEntropy([1, 1, 1, 1]).logicalDepth, 0)
  assert.ok(Math.abs(projectionEntropy([1, 1, 1, 1]).entropy - 2) < 1e-12)

  const concentrated = projectionEntropy([1, 0.0001, 0.0001])
  assert.ok(concentrated.logicalDepth > 0.9, `集中 ⇒ 逻辑深度接近 1，实际 ${concentrated.logicalDepth}`)
  // 区分力自检：均摊与集中必须给出不同的 logicalDepth，否则这个量是常数（假判据）
  assert.ok(projectionEntropy([1, 1, 1]).logicalDepth < concentrated.logicalDepth,
    'logicalDepth 必须能区分均摊与集中')

  const weird = projectionEntropy([Number.NaN, Number.POSITIVE_INFINITY, -1, 2])
  assert.equal(weird.k, 1, '非有限/负能量必须被忽略')
  assert.ok(Number.isFinite(weird.entropy) && Number.isFinite(weird.logicalDepth))
  assert.equal(weird.logicalDepth, 0)

  // 纯函数链路：分诊结果里的 logicalDepth 也必须有限且落在 0..1
  const r = residualPyramid('qq zz', [{ id: 'x', tags: ['qq'] }], STATS)
  assert.ok(Number.isFinite(r.logicalDepth) && r.logicalDepth >= 0 && r.logicalDepth <= 1)
  assert.ok(Number.isFinite(r.projectionEntropy))
})

// ── 纯函数层：novelty 定义与 directionConsistency 三个边界 ───────────────────

test('novelty 定义：0.7×残差 + 0.3×方向一致性；方向一致性的三个边界都可判（判红点：字面 1−|cos(R,u1)| 恒为 1）', () => {
  // 情形 1：查询完全被基解释 ⇒ R=0 ⇒ dc 定义 0 ⇒ novelty=0（不会因为余项白拿分）
  const full = residualPyramid('aa', [{ id: 'x', tags: ['aa'] }], STATS)
  assert.ok(Math.abs(full.explainedRatio - 1) < 1e-12)
  assert.equal(full.residualRatio, 0)
  assert.equal(full.directionConsistency, 0, 'R=0 时残差方向不存在 ⇒ 定义 0')
  assert.equal(full.novelty, 0)
  assert.equal(full.expanded, false)

  // 情形 2：layers = basisSize 且 R≠0 ⇒ 未投影基为空 ⇒ dc=1（残差与本基子空间正交 = 新方向）
  const newDir = residualPyramid('qq zz', [{ id: 'x', tags: ['qq'] }], STATS)
  assert.equal(newDir.basisSize, 1)
  assert.equal(newDir.layers, 1)
  assert.ok(Math.abs(newDir.residualRatio - 0.5) < 1e-12, `qq/zz 权重相同 ⇒ 各一半，实际 ${newDir.residualRatio}`)
  assert.equal(newDir.directionConsistency, 1)
  assert.ok(Math.abs(newDir.novelty - (NOVELTY_RESIDUAL_WEIGHT * 0.5 + NOVELTY_DIRECTION_WEIGHT * 1)) < 1e-12,
    `novelty 必须是 0.7×残差 + 0.3×方向一致性，实际 ${newDir.novelty}`)
  assert.equal(newDir.expanded, true)

  // 情形 3：残差落在「没参与投影的基向量」上 ⇒ dc=0（maxLayers=1 制造未投影基）
  const onLater = residualPyramid('qq', [{ id: 'x', tags: ['aa'] }, { id: 'y', tags: ['qq'] }], STATS, { maxLayers: 1 })
  assert.equal(onLater.basisSize, 2)
  assert.equal(onLater.layers, 1, 'maxLayers=1 ⇒ 只做一层')
  assert.equal(onLater.explainedRatio, 0, '第一层与 q 正交 ⇒ 什么都没解释')
  assert.equal(onLater.residualRatio, 1)
  assert.equal(onLater.directionConsistency, 0, '残差仍落在基留着的那条方向上 ⇒ 不是新方向')
  assert.ok(Math.abs(onLater.novelty - NOVELTY_RESIDUAL_WEIGHT) < 1e-12)

  // 区分力自检：这个夹具里字面定义 1−|cos(R,u1)| 恒为 1（正交投影的结构性后果），
  // 所以「上报 dc=0」这条断言真的能分辨两种定义；若 dc 被写成字面定义，这里会变成 1 ⇒ 判红。
  const q = tagVector(['qq'], STATS)
  const ortho = gramSchmidt([tagVector(['aa'], STATS), tagVector(['qq'], STATS)])
  const literal = 1 - Math.abs(sparseDot(q, ortho[0]) / Math.sqrt(sparseNorm2(q)))
  assert.ok(Math.abs(literal - 1) < 1e-12, '夹具必须让字面定义恒为 1，否则本判据没有区分力')
  assert.equal(onLater.directionConsistency, 0)

  // 阈值就是门控：同一份分诊结果，阈值 0.5 扩、0.7 不扩
  const gate5 = residualPyramid('qq zz', [{ id: 'x', tags: ['qq'] }], STATS, { noveltyThreshold: 0.5 })
  const gate7 = residualPyramid('qq zz', [{ id: 'x', tags: ['qq'] }], STATS, { noveltyThreshold: 0.7 })
  assert.ok(Math.abs(gate5.novelty - 0.65) < 1e-12)
  assert.equal(gate5.expanded, true)
  assert.equal(gate7.expanded, false)
  assert.equal(gate7.noveltyThreshold, 0.7)

  // 三个边界的 dc 必须同时出现 0 与 1（否则「边界可判」是空话）
  assert.equal(new Set([full.directionConsistency, newDir.directionConsistency, onLater.directionConsistency]).size, 2)
})

test('分诊口径解析：非法输入回落默认常数，层数/基规模被夹紧（不引入批次相关量）', () => {
  const def = resolveTriageOptions()
  assert.equal(def.noveltyThreshold, DEFAULT_NOVELTY_THRESHOLD)
  assert.equal(def.activationThreshold, DEFAULT_ACTIVATION_THRESHOLD)
  assert.equal(def.maxBasis, MAX_BASIS)
  assert.equal(def.maxLayers, MAX_LAYERS)
  assert.equal(def.residualStop, RESIDUAL_STOP)

  assert.equal(resolveTriageOptions({ noveltyThreshold: Number.NaN }).noveltyThreshold, DEFAULT_NOVELTY_THRESHOLD)
  assert.equal(resolveTriageOptions({ noveltyThreshold: 9 }).noveltyThreshold, 1)
  assert.equal(resolveTriageOptions({ noveltyThreshold: -9 }).noveltyThreshold, 0)
  assert.equal(resolveTriageOptions({ activationThreshold: 9 }).activationThreshold, 1)
  assert.equal(resolveTriageOptions({ maxBasis: 0 }).maxBasis, 1)
  assert.equal(resolveTriageOptions({ maxBasis: 999 }).maxBasis, 32)
  assert.equal(resolveTriageOptions({ maxBasis: 2.7 }).maxBasis, 2)
  assert.equal(resolveTriageOptions({ maxLayers: 0 }).maxLayers, 1)
  assert.equal(resolveTriageOptions({ maxLayers: -3 }).maxLayers, 1)
  assert.equal(resolveTriageOptions({ residualStop: 2 }).residualStop, 1)
  assert.equal(resolveTriageOptions({ residualStop: Number.NaN }).residualStop, RESIDUAL_STOP)
})

// ── 红证 1：低覆盖（几乎无重合）必须扩检索、且不得返回空 ──────────────────────

test('红证 1（判红点：把 expanded 强制为 false ⇒ 本条变红）：与库几乎无重合的查询必须扩检索且不返回空', async () => {
  const home = freshHome('triage-expand')
  const defs = tools()
  const remember = defs.get('memory_remember')
  const recall = defs.get('memory_recall')
  for (let i = 0; i < 12; i += 1) {
    const w = await remember.execute({
      kind: 'fact', title: `alpha beta numbered note ${i}`, body: `alpha beta details ${i}`,
      tags: ['alpha', 'beta'], source: 'test:triage',
    })
    assert.equal(w.ok, true)
  }

  // 与库几乎无重合：库内标签全是 ASCII，查询是中文（中文按字/二字组切词）
  const r = await recall.execute({ query: '今天天气怎么样', limit: 3 })
  assert.equal(r.ok, true)
  assert.equal(r.expanded, true, '与库几乎无重合的查询必须判 expanded=true（判红点：强制 false）')
  assert.ok(r.kUsed > r.kBase, `扩检索必须真的提高取回条数：kBase=${r.kBase} kUsed=${r.kUsed}`)
  assert.ok(r.rows.length > 0, '低覆盖绝不返回空（第三方明确回退过这种门控）')
  // I2.1 修 1 契约更新（用户拍板选 B）：limit 是**硬显示上限**，扩检索不再增加显示行数。
  // （旧断言是 `r.rows.length > r.kBase`，即「扩检索必须在行数上可见」——本次被改为硬上限。）
  assert.equal(r.rows.length, 3, `limit=3 是硬显示上限：rows 必须恰好 3 条，实际 ${r.rows.length}`)
  assert.equal(r.rows.length, r.shown, 'shown 必须等于实际显示行数')
  assert.equal(r.lines.length, r.shown, 'lines 与 shown 必须一致')
  assert.ok(r.kUsed > 3, `扩检索只在**内部预算**上可见：kUsed=${r.kUsed} 必须 > limit=3`)
  assert.ok(r.novelty >= r.noveltyThreshold, `novelty=${r.novelty} 阈值=${r.noveltyThreshold}`)
  assert.equal(r.explainedRatio, 0, '标签空间完全解释不了这个查询 ⇒ 被解释能量为 0')
  assert.equal(r.residualRatio, 1)
  assert.equal(r.lowConfidence, true, '这个查询的 cov_max 为 0 ⇒ 必须如实标记低置信')
  assert.ok(r.rows.every((row) => row.rel === 0), '无证据候选 rel 仍然是 0（只奖不罚）')
  checkTriageFields('红证 1', r)
  assertLossless('红证 1', r)

  // 表头自证：打印的 novelty/阈值/条数必须复现结构化字段
  const headerLine = r.text.split('\n')[0]
  assert.ok(!r.text.split('\n')[1].includes('novelty='), '表头必须仍是单行（分诊信息不得换行）')
  assert.ok(headerLine.includes('expanded=true'), `表头必须如实说明扩检索结论：${headerLine}`)
  assert.ok(headerLine.includes('低置信'), '低置信必须如实提示')
})

// ── 红证 2：高覆盖不得无缘无故扩检索 ─────────────────────────────────────────

test('红证 2（判红点：把 expanded 强制为 true ⇒ 本条变红）：与某条记录高度重合的查询不得扩检索', async () => {
  const home = freshHome('triage-noexpand')
  const defs = tools()
  const remember = defs.get('memory_remember')
  const recall = defs.get('memory_recall')
  const w1 = await remember.execute({
    kind: 'fact', title: 'zetaword focused note', body: 'zetaword appears in this body',
    tags: ['zetaword'], source: 'test:triage',
  })
  for (const [title, body, tags] of [
    ['plain unrelated note', 'nothing shared here', ['misc']],
    ['another plain note', 'also unrelated content', ['other']],
  ]) {
    const w = await remember.execute({ kind: 'fact', title, body, tags, source: 'test:triage' })
    assert.equal(w.ok, true)
  }
  assert.equal(w1.ok, true)

  // 查询与第一条的标签完全重合 ⇒ 基能把它整个解释掉
  const r = await recall.execute({ query: 'zetaword', limit: 3 })
  assert.equal(r.ok, true)
  assert.equal(r.expanded, false, '高覆盖查询不得扩检索（判红点：强制 true）')
  assert.equal(r.kUsed, r.kBase, '不扩检索 ⇒ kUsed === kBase')
  assert.ok(r.novelty < r.noveltyThreshold, `novelty=${r.novelty} 必须低于阈值 ${r.noveltyThreshold}`)
  assert.ok(Math.abs(r.explainedRatio - 1) < 1e-12, `被基完全解释 ⇒ explainedRatio=1，实际 ${r.explainedRatio}`)
  assert.ok(Math.abs(r.residualRatio) < 1e-12)
  assert.ok(Math.abs(r.novelty) < 1e-12, '完全被解释 ⇒ novelty=0（残差方向不存在）')
  assert.ok(r.rows.length > 0, '不扩检索也必须正常返回候选（不得返回空）')
  assert.equal(r.covMax, 1, '标签完全命中 ⇒ cov_max=1')
  assert.equal(r.lowConfidence, false)
  checkTriageFields('红证 2', r)
  assertLossless('红证 2', r)

  const headerLine = r.text.split('\n')[0]
  assert.ok(headerLine.includes('expanded=false'), `表头必须如实说明不扩检索：${headerLine}`)
  assert.ok(headerLine.includes('非低置信'), '非低置信也必须如实标注')
})

// ── 红证 3：请求级隔离（与「单独只跑第二次」逐字段比对）─────────────────────

test('红证 3（判红点：把金字塔状态提到模块级并在两次调用间复用 ⇒ 本条变红）：请求级隔离', async () => {
  const home = freshHome('triage-isolation')
  const defs = tools()
  const remember = defs.get('memory_remember')
  const recall = defs.get('memory_recall')

  // 两组标签完全不相交的记录：A 组 tokens = aa/ab/ac，B 组 tokens = ba/bb/bc
  const seeds = [
    ['note aa one record', 'body for aa record', ['aa']],
    ['note ab two record', 'body for ab record', ['ab']],
    ['note ac three record', 'body for ac record', ['ac']],
    ['note ba one record', 'body for ba record', ['ba']],
    ['note bb two record', 'body for bb record', ['bb']],
    ['note bc three record', 'body for bc record', ['bc']],
  ]
  for (const [title, body, tags] of seeds) {
    const w = await remember.execute({ kind: 'fact', title, body, tags, source: 'test:triage' })
    assert.equal(w.ok, true)
  }

  // ① 「单独只跑第二次」：新进程 + 干净模块状态（同进程里先前的调用会把模块级缓存喂饱 ⇒ 假绿）
  const aloneRaw = execFileSync(NODE_BIN, [PROBE, 'ba bb', '3'], {
    env: { ...process.env, DSH_HOME: home }, encoding: 'utf8',
  })
  const alone = JSON.parse(aloneRaw)

  // ② 同进程：先跑第一次（标签空间里的另一组方向），注入一次事件循环让出，再跑第二次
  const first = await recall.execute({ query: 'aa ab ac', limit: 10 })
  assert.ok(first.shown > 0, '第一次召回必须真的取到候选（否则本用例没有「上一次状态」可复用）')
  await new Promise((resolve) => { setImmediate(resolve) })
  const second = await recall.execute({ query: 'ba bb', limit: 3 })

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
    rowIds: second.rows.map((row) => row.id),
  }
  assert.deepEqual(seq, alone,
    `第二次的分诊字段必须与「单独只跑第二次」逐字段一致（判红点：模块级复用状态就不同）\n`
    + `顺序=${JSON.stringify(seq)}\n单独=${JSON.stringify(alone)}`)
  assert.ok(seq.rowIds.length > 0)
  checkTriageFields('红证 3 第二次', second)

  // 夹具自检（区分力）：同一查询，基被 A 组方向污染后分诊字段必须变化。
  // 这里直接在纯函数层把「污染模型」（A 的基 + 本次的基）复算出来 —— 若二者无差别，
  // 上面那条逐字段比对对「跨请求复用状态」这个回归就是假绿。
  const stats = corpusStats(seeds.map(([title, body, tags]) => ({ title, body, tags })))
  const basisClean = [{ id: 'c1', tags: ['ba'] }, { id: 'c2', tags: ['bb'] }]
  const basisPolluted = [
    { id: 'a1', tags: ['aa'] }, { id: 'a2', tags: ['ab'] }, { id: 'a3', tags: ['ac'] },
    ...basisClean,
  ]
  const clean = residualPyramid('ba bb', basisClean, stats)
  const polluted = residualPyramid('ba bb', basisPolluted, stats)
  assert.ok(Math.abs(clean.explainedRatio - 1) < 1e-12, '干净基必须能完全解释 ba bb')
  assert.ok(polluted.explainedRatio < 0.5, `被污染后前 3 层被 A 组方向吃掉（实测 ${polluted.explainedRatio}）`)
  assert.notDeepEqual(pyramidFields(clean), pyramidFields(polluted),
    '夹具必须对「基被跨请求污染」有区分力，否则逐字段比对是假判据')
  assert.ok(polluted.layers > clean.layers || polluted.basisSize > clean.basisSize)
})

// ── 表头自证（I1.3 铁律的延续）──────────────────────────────────────────────

test('I2 自证：表头打印的 novelty/kBase/cov_max 与阈值必须能复算 expanded/lowConfidence（单行表头）', async () => {
  const home = freshHome('triage-selfproof')
  const defs = tools()
  const remember = defs.get('memory_remember')
  const recall = defs.get('memory_recall')
  for (let i = 0; i < 12; i += 1) {
    await remember.execute({
      kind: 'fact', title: `alpha beta numbered note ${i}`, body: `alpha beta details ${i}`,
      tags: ['alpha', 'beta'], source: 'test:triage',
    })
  }

  const r = await recall.execute({ query: '今天天气怎么样', limit: 3 })
  const lines = r.text.split('\n')
  const header = lines[0]
  assert.equal(lines.length - 1, r.shown + (r.truncated ? 1 : 0), '表头必须单行（分诊字段不得换行）')
  assert.deepEqual(r.lines, lines.slice(1, 1 + r.shown))

  const novelty = /novelty=([0-9]+\.[0-9]+) (<|>=) 阈值 ([0-9.]+)/.exec(header)
  assert.ok(novelty, `表头必须打印 novelty / 阈值 / 比较符：${header}`)
  assert.equal(Number(novelty[1]), Number(r.novelty.toFixed(4)))
  assert.equal(Number(novelty[3]), r.noveltyThreshold)
  assert.equal(r.expanded, Number(novelty[1]) >= Number(novelty[3]),
    '用打印的 novelty 与阈值必须复现 expanded（判红点：表头与实际结论不一致）')
  assert.equal(novelty[2] === '>=', r.expanded, '打印的比较符必须与实际结论一致')

  const kk = /kBase=(\d+) -> kUsed=(\d+)/.exec(header)
  assert.ok(kk)
  assert.equal(Number(kk[1]), r.kBase)
  assert.equal(Number(kk[2]), r.kUsed)

  const ratios = /explainedRatio=([0-9]+\.[0-9]+) \+ residualRatio=([0-9]+\.[0-9]+) = 1/.exec(header)
  assert.ok(ratios, '表头必须如实打印守恒关系')
  assert.ok(Math.abs((Number(ratios[1]) + Number(ratios[2])) - 1) < 1e-9)

  const bg = /basisSize=(\d+) layers=(\d+) logicalDepth=([0-9]+\.[0-9]+)/.exec(header)
  assert.ok(bg)
  assert.equal(Number(bg[1]), r.basisSize)
  assert.equal(Number(bg[2]), r.layers)
  assert.equal(Number(bg[3]), Number(r.logicalDepth.toFixed(4)))

  const cov = /cov_max=([0-9]+\.[0-9]+) (<|>=) ([0-9.]+)/.exec(header)
  assert.ok(cov, `表头必须打印 cov_max 与激活阈值：${header}`)
  assert.equal(Number(cov[1]), Number(r.covMax.toFixed(4)))
  assert.equal(Number(cov[3]), r.activationThreshold)
  assert.equal(cov[2] === '<', r.lowConfidence, '打印的比较符必须与实际 lowConfidence 一致')
  assert.equal(r.lowConfidence, Number(cov[1]) < Number(cov[3]),
    '用打印的 cov_max 与阈值必须复现 lowConfidence')

  // 可配置：两个阈值都必须真的被用上（同一查询只改 activationThreshold 就能翻转 lowConfidence）
  const strict = tools({ triage: { noveltyThreshold: 1, activationThreshold: 0.9 } })
  const rStrict = await strict.get('memory_recall').execute({ query: '今天天气怎么样', limit: 3 })
  assert.equal(rStrict.noveltyThreshold, 1, '工具必须回显 cfg.triage 覆盖后的阈值')
  assert.equal(rStrict.activationThreshold, 0.9)
  assert.equal(rStrict.covMax, 0)
  assert.equal(rStrict.lowConfidence, true, 'cov_max=0 < 0.9 ⇒ 低置信（阈值确实生效）')
  assert.equal(rStrict.expanded, rStrict.novelty >= 1)
  const loose = tools({ triage: { activationThreshold: 0 } })
  const rLoose = await loose.get('memory_recall').execute({ query: '今天天气怎么样', limit: 3 })
  assert.equal(rLoose.covMax, 0)
  assert.equal(rLoose.lowConfidence, false, 'cov_max=0 不小于阈值 0 ⇒ 同一查询翻转成非低置信（区分力）')
  assert.notEqual(rStrict.lowConfidence, rLoose.lowConfidence)
})

test('工具层：分诊口径可配置（maxLayers=1 让「三层才解释完」的查询变成扩检索，且行数真的变多）', async () => {
  const home = freshHome('triage-config')
  const seed = async (defs) => {
    const remember = defs.get('memory_remember')
    for (const [title, body, tags] of [
      ['note aa one record', 'body for aa record', ['aa']],
      ['note ab two record', 'body for ab record', ['ab']],
      ['note ac three record', 'body for ac record', ['ac']],
      ['plain filler note zero', 'plain filler body zero', ['filler0']],
      ['plain filler note one', 'plain filler body one', ['filler1']],
      ['plain filler note two', 'plain filler body two', ['filler2']],
      ['plain filler note three', 'plain filler body three', ['filler3']],
      ['plain filler note four', 'plain filler body four', ['filler4']],
    ]) {
      const w = await remember.execute({ kind: 'fact', title, body, tags, source: 'test:triage' })
      assert.equal(w.ok, true)
    }
  }

  // 默认口径：三层把 aa/ab/ac 三个方向全部解释掉 ⇒ 不扩检索、只取 kBase 条
  const dflt = tools()
  await seed(dflt)
  const rDefault = await dflt.get('memory_recall').execute({ query: 'aa ab ac', limit: 3 })
  assert.equal(rDefault.layers, 3, '默认最多三层，三个方向正好用完')
  assert.ok(Math.abs(rDefault.explainedRatio - 1) < 1e-12, `三层解释完 ⇒ explainedRatio=1，实际 ${rDefault.explainedRatio}`)
  assert.equal(rDefault.expanded, false)
  assert.equal(rDefault.kBase, 3)
  assert.equal(rDefault.kUsed, 3)
  assert.equal(rDefault.shown, 3)

  // 口径覆盖 maxLayers=1：只解释 1/3，残差落在没投影的基方向上 ⇒ novelty=0.7×(2/3)+0.3×(1−1/√2)
  const oneLayer = tools({ triage: { maxLayers: 1 } })
  const rOne = await oneLayer.get('memory_recall').execute({ query: 'aa ab ac', limit: 3 })
  assert.equal(rOne.layers, 1, '口径覆盖后只做一层')
  assert.ok(Math.abs(rOne.explainedRatio - 1 / 3) < 1e-12, `只解释三分之一，实际 ${rOne.explainedRatio}`)
  const expectedNovelty = NOVELTY_RESIDUAL_WEIGHT * (2 / 3) + NOVELTY_DIRECTION_WEIGHT * (1 - 1 / Math.sqrt(2))
  assert.ok(Math.abs(rOne.novelty - expectedNovelty) < 1e-9,
    `工具层的 novelty 也必须符合 0.7×残差+0.3×方向一致性：实际上报 ${rOne.novelty}，期望 ${expectedNovelty}`)
  assert.equal(rOne.expanded, true, 'novelty≈0.5545 >= 0.5 ⇒ 扩检索')
  assert.equal(rOne.kBase, 3)
  assert.ok(rOne.kUsed > rOne.kBase, `扩检索必须提高预算：kBase=${rOne.kBase} kUsed=${rOne.kUsed}`)
  // I2.1 修 1 契约更新（用户拍板选 B）：扩检索只在**内部预算**上可见，显示行数被 limit 硬钉死。
  // （旧断言是 `rOne.shown > rDefault.shown`，即「扩检索必须在行数上可见」——本次被改为硬上限。）
  assert.equal(rOne.shown, 3, 'limit=3 是硬显示上限：扩检索也不许多显示一行')
  assert.equal(rOne.shown, rDefault.shown, '扩检索不改变显示行数（两者 limit 都是 3）')
  assert.equal(rOne.rows.length, 3)
  assert.ok(rOne.kUsed > rDefault.kUsed,
    `扩检索必须在内部预算上可见：kUsed ${rOne.kUsed} vs 不扩检索的 ${rDefault.kUsed}`)
  checkTriageFields('口径覆盖', rOne)
})

// ── 边界：空库 / 空查询 / 单条库 ────────────────────────────────────────────

test('边界：空库/空查询/单条库的分诊字段全部有限（不许 NaN/Infinity/undefined 泄漏）', async () => {
  // 空库：没有任何候选、没有语料统计
  freshHome('triage-edge-empty')
  const empty = await tools().get('memory_recall').execute({ query: '任意查询词' })
  checkTriageFields('空库', empty)
  assert.equal(empty.total, 0)
  assert.equal(empty.basisSize, 0)
  assert.equal(empty.layers, 0)
  assert.equal(empty.shown, 0)
  assert.equal(empty.kBase, 5)
  // I2.1 修 2 契约更新（用户拍板）：空语料里 tagWeight 的 idf 上界也是 0（idf(0,0)=0）
  // ⇒ ‖q‖²=0 ⇒ 走「无词元能量 ⇒ 未分诊」分支 ⇒ kUsed=kBase（不再有"扩检索预算被库容截断为 0"）。
  // （旧断言是 `empty.kUsed === 0`，理由是"扩检索预算被库容截断"——现在根本不分诊、不扩检索。）
  assert.equal(empty.noQueryEnergy, true, '空语料 ⇒ 任何词元权重为 0 ⇒ 查询无词元能量')
  assert.equal(empty.expanded, false, '空语料 ⇒ 未分诊 ⇒ 不扩检索')
  assert.equal(empty.kUsed, empty.kBase, '无词元能量 ⇒ kUsed=kBase（未分诊，不扩检索）')
  assert.deepEqual(empty.rows, [])
  assert.ok(!JSON.stringify(empty).includes('null'), 'NaN 会在 JSON 里变 null —— 一个都不许有')
  assertLossless('空库', empty)

  // 单条库 + 空查询 / 无关查询
  freshHome('triage-edge-single')
  const defs = tools()
  const w = await defs.get('memory_remember').execute({
    kind: 'fact', title: 'only one record here', body: 'single body', tags: ['only'], source: 'test:triage',
  })
  assert.equal(w.ok, true)
  const recall = defs.get('memory_recall')
  const single = await recall.execute({ query: 'zzz 完全无关', limit: 5 })
  checkTriageFields('单条库无关查询', single)
  assert.equal(single.shown, 1)
  assert.equal(single.kBase, 5)
  assert.equal(single.kUsed, 1, '库容 1 < kBase 5 ⇒ kUsed 被库容截断（行为上仍是取到库里全部候选）')
  const noQuery = await recall.execute({ query: '' })
  checkTriageFields('空查询', noQuery)
  assert.ok(noQuery.shown > 0, '空查询也必须按新鲜度召回（不得返回空）')
  assert.ok(!JSON.stringify(noQuery).includes('null'))
  assertLossless('空查询', noQuery)

  // 纯函数层边界：空语料 / 空查询 / 空基
  const st = corpusStats([])
  const noCorpus = residualPyramid('x', [], st)
  checkTriageFields('空语料', withToolFields(noCorpus))
  assert.equal(noCorpus.basisSize, 0)
  // I2.1 修 2 契约更新（用户拍板）：空语料下 tagWeight 的 idf 上界为 0 ⇒ ‖q‖²=0
  // ⇒ 未分诊：novelty=0（旧断言是 novelty===NOVELTY_RESIDUAL_WEIGHT=0.7）。
  assert.equal(noCorpus.noQueryEnergy, true, '空语料里任何词元权重都是 0 ⇒ 查询无词元能量')
  assert.equal(noCorpus.novelty, 0, '未分诊 ⇒ novelty=0（不是旧公式的 0.7）')
  assert.equal(noCorpus.expanded, false, '未分诊 ⇒ 不扩检索')

  // 保留原断言的覆盖意图的一半（有词元能量但**没有基** ⇒ 残差全留），换一个「语料非空、
  // 查询词不在标签里」的夹具来钉住它（空语料现在走未分诊分支，钉不住这条）。
  // 注意 dc 的边界定义：basisSize=0 且 R≠0 ⇒ 没有任何方向能解释它 ⇒ dc=1（不是 0）
  // ⇒ novelty = 0.7×1 + 0.3×1 = 1。旧断言写 dc=0 只因为当时走的是「无能量」路径（‖R‖=0）。
  const statsBasisless = corpusStats([{ title: 't t t', body: 'b b', tags: ['aa'] }])
  const noBasis = residualPyramid('zz', [], statsBasisless)
  assert.equal(noBasis.noQueryEnergy, false, '语料非空 ⇒ df=0 的词元取 idf 上界 ⇒ 有词元能量')
  assert.equal(noBasis.basisSize, 0)
  assert.equal(noBasis.explainedRatio, 0)
  assert.equal(noBasis.residualRatio, 1)
  assert.equal(noBasis.directionConsistency, 1, '没有基 ⇒ 残差没有任何方向能解释 ⇒ dc 按定义 1')
  assert.equal(noBasis.novelty, NOVELTY_RESIDUAL_WEIGHT + NOVELTY_DIRECTION_WEIGHT,
    '没有基但有词元能量 ⇒ novelty = 0.7×1 + 0.3×1 = 1')
  checkTriageFields('无基（有能量）', withToolFields(noBasis))

  const stats = corpusStats([{ title: 't t t t t t', body: 'b b b', tags: ['aa'] }])
  const emptyQuery = residualPyramid('', [{ id: 'x', tags: ['aa'] }], stats)
  checkTriageFields('空查询（纯函数层）', withToolFields(emptyQuery))
  assert.equal(emptyQuery.layers, 0, '空查询没有词元能量 ⇒ 不做投影')
  assert.equal(emptyQuery.noQueryEnergy, true, '空查询必须标记为未分诊')
  assert.equal(emptyQuery.novelty, 0, '未分诊 ⇒ novelty=0')
  assert.equal(emptyQuery.expanded, false, '未分诊 ⇒ 不扩检索')
  // I2.1 修 2 契约更新（用户拍板）：0/0 未定义 ⇒ 如实回显 0/0。
  // （旧断言是 `explainedRatio=0` + `residualRatio=1`，用假造的 1 去凑守恒式。）
  assert.equal(emptyQuery.explainedRatio, 0)
  assert.equal(emptyQuery.residualRatio, 0, '0/0 未定义 ⇒ 回显 0，不假造 1')
  assert.equal(emptyQuery.basisSize, 1)
  assert.ok(Number.isFinite(emptyQuery.novelty))
  const nullBasis = residualPyramid('aa', [null, undefined, { id: 'x' }, { id: 'y', tags: [] }], stats)
  checkTriageFields('退化基项', withToolFields(nullBasis))
  assert.equal(nullBasis.basisSize, 0, '空标签候选不得进基')
})

test('I2 无损：低置信路径不得整批否决（行数、match、score 都照常给出）', async () => {
  const home = freshHome('triage-noveto')
  const defs = tools()
  const remember = defs.get('memory_remember')
  const recall = defs.get('memory_recall')
  for (let i = 0; i < 8; i += 1) {
    await remember.execute({
      kind: 'fact', title: `theme note number ${i}`, body: `dark theme details ${i}`,
      tags: ['theme', 'shared'], source: 'test:triage',
    })
  }
  // cov 极低（命中的都是外围低权重标签）+ novelty 高 ⇒ expanded 与 lowConfidence 同时成立
  const r = await recall.execute({ query: '完全无关的中文查询', limit: 8 })
  checkTriageFields('低置信', r)
  assert.equal(r.lowConfidence, true)
  assert.equal(r.expanded, true)
  assert.ok(r.rows.length > 0, '低置信绝不返回空')
  assert.ok(r.rows.every((row) => row.match === 'none'), '无证据候选 match=none，但照样如实返回')
  assert.ok(r.rows.every((row) => Number.isFinite(row.score) && row.score >= 0 && row.score <= 1))
  for (const line of r.lines) assert.match(line, / \| \d+\.\d{4}$/, '行尾仍是展示分')
  assertLossless('低置信', r)
})

// ── I2.1 修 1/修 2：limit 硬显示上限 + 空查询不做分诊 ────────────────────────

test('I2.1 修 2：空查询/纯空白查询不做分诊（novelty=0、expanded=false、kUsed=kBase；判红点：关掉未分诊分支 ⇒ novelty=0.7/expanded=true）', async () => {
  freshHome('i21-noquery')
  const defs = tools()
  const remember = defs.get('memory_remember')
  const recall = defs.get('memory_recall')
  for (let i = 0; i < 12; i += 1) {
    const w = await remember.execute({
      kind: 'fact', title: `alpha beta numbered note ${i}`, body: `alpha beta details ${i}`,
      tags: ['alpha', 'beta'], source: 'test:i21',
    })
    assert.equal(w.ok, true)
  }

  for (const q of ['', '   ', '\t\n ']) {
    const r = await recall.execute({ query: q, limit: 4 })
    assert.equal(r.noQueryEnergy, true, `query=${JSON.stringify(q)} 必须标记为无词元能量`)
    assert.equal(r.novelty, 0, `query=${JSON.stringify(q)} 未分诊 ⇒ novelty=0（判红点：旧公式给 0.7）`)
    assert.equal(r.expanded, false, `query=${JSON.stringify(q)} 未分诊 ⇒ expanded=false（判红点：旧公式给 true）`)
    assert.equal(r.kUsed, r.kBase, `query=${JSON.stringify(q)} 未分诊 ⇒ kUsed=kBase`)
    assert.equal(r.explainedRatio, 0, `query=${JSON.stringify(q)} 0/0 未定义 ⇒ 回显 0`)
    assert.equal(r.residualRatio, 0, `query=${JSON.stringify(q)} 0/0 未定义 ⇒ 回显 0（不假造 1）`)
    assert.equal(r.shown, Math.min(4, r.matched), '未分诊不等于返回空：仍按新鲜度取满 limit')
    assert.equal(r.rows.length, r.shown, 'shown 必须等于实际显示行数')
    assert.equal(r.lines.length, r.shown)
    checkTriageFields(`空查询 ${JSON.stringify(q)}`, r)
    assert.ok(!JSON.stringify(r).includes('null'), '退化情形不许出 NaN（NaN 在 JSON 里会变 null）')
    assertLossless(`空查询 ${JSON.stringify(q)}`, r)
  }

  // 表头自证：必须如实写明「未分诊」，且不得再出现旧公式的 0.7000
  const r = await recall.execute({ query: '   ', limit: 4 })
  const header = r.text.split('\n')[0]
  assert.ok(header.includes('未分诊'), `表头必须如实写明未分诊：${header}`)
  assert.ok(header.includes('expanded=false'), `表头必须回显 expanded=false：${header}`)
  assert.ok(!header.includes('novelty=0.7000'), `表头不得出现旧公式的 novelty=0.7000：${header}`)
  assert.ok(header.includes('0/0'), `表头必须如实说明比值未定义（0/0）：${header}`)
  const kk = /kBase=(\d+) -> kUsed=(\d+)/.exec(header)
  assert.ok(kk, '表头仍须打印 kBase/kUsed')
  assert.equal(Number(kk[1]), r.kBase)
  assert.equal(Number(kk[2]), r.kUsed)

  // 区分力自检：同一夹具 + 有词元能量的查询仍然会判 expanded=true（否则「空查询不扩」是假绿）
  const pos = await recall.execute({ query: '今天天气怎么样', limit: 4 })
  assert.equal(pos.noQueryEnergy, false, '非空查询必须有词元能量')
  assert.equal(pos.expanded, true, '夹具必须让非空查询能扩检索，否则上面对空查询的断言没有区分力')

  // 纯函数层：同一契约（空查询无词元能量 ⇒ 未分诊）
  const stats = corpusStats([{ title: 't t', body: 'b', tags: ['aa'] }])
  const pureEmpty = residualPyramid('  ', [{ id: 'x', tags: ['aa'] }], stats)
  assert.equal(pureEmpty.noQueryEnergy, true)
  assert.equal(pureEmpty.novelty, 0)
  assert.equal(pureEmpty.expanded, false)
  checkTriageFields('纯函数空查询', withToolFields(pureEmpty))
})

test('I2.1 修 1：limit 是硬显示上限（扩检索分支 rows===limit；不扩分支 rows===min(limit,候选数)；判红点：去掉显示截断 ⇒ rows=kUsed>limit）', async () => {
  // 分支 1（扩检索）：与库几乎无重合的查询 ⇒ expanded=true、kUsed>kBase，但显示仍恰好 limit 条
  freshHome('i21-hardcap-expand')
  const defs = tools()
  const remember = defs.get('memory_remember')
  for (let i = 0; i < 12; i += 1) {
    const w = await remember.execute({
      kind: 'fact', title: `alpha beta numbered note ${i}`, body: `alpha beta details ${i}`,
      tags: ['alpha', 'beta'], source: 'test:i21',
    })
    assert.equal(w.ok, true)
  }
  const recall = defs.get('memory_recall')
  const rExp = await recall.execute({ query: '今天天气怎么样', limit: 3 })
  assert.equal(rExp.expanded, true, '本分支夹具前提：查询必须判扩检索')
  assert.ok(rExp.kUsed > rExp.kBase, `扩检索必须提高内部预算：kBase=${rExp.kBase} kUsed=${rExp.kUsed}`)
  assert.ok(rExp.kUsed > rExp.limit,
    `夹具必须让扩检索预算超过 limit，否则「截断」这条断言没有区分力：kUsed=${rExp.kUsed} limit=${rExp.limit}`)
  assert.equal(rExp.rows.length, 3, `limit 是硬上限：rows 必须严格等于 limit=3，实际 ${rExp.rows.length}`)
  assert.equal(rExp.shown, 3, 'shown 必须等于实际显示行数')
  assert.equal(rExp.rows.length, rExp.shown, 'rows 与 shown 必须一致')
  assert.equal(rExp.lines.length, rExp.shown, 'lines 与 shown 必须一致')
  checkTriageFields('扩检索+硬上限', rExp)

  // 分支 2（不扩检索）：候选数 > limit ⇒ rows.length === min(limit, 候选数) === limit
  freshHome('i21-hardcap-noexpand')
  const dflt = tools()
  const rem2 = dflt.get('memory_remember')
  for (const [title, body, tags] of [
    ['note aa one record', 'body for aa record', ['aa']],
    ['note ab two record', 'body for ab record', ['ab']],
    ['note ac three record', 'body for ac record', ['ac']],
    ['plain filler note zero', 'plain filler body zero', ['filler0']],
    ['plain filler note one', 'plain filler body one', ['filler1']],
    ['plain filler note two', 'plain filler body two', ['filler2']],
    ['plain filler note three', 'plain filler body three', ['filler3']],
    ['plain filler note four', 'plain filler body four', ['filler4']],
  ]) {
    const w = await rem2.execute({ kind: 'fact', title, body, tags, source: 'test:i21' })
    assert.equal(w.ok, true)
  }
  const rNo = await dflt.get('memory_recall').execute({ query: 'aa ab ac', limit: 3 })
  assert.equal(rNo.expanded, false, '本分支夹具前提：三层把 aa/ab/ac 解释完 ⇒ 不扩检索')
  assert.equal(rNo.kUsed, rNo.kBase)
  assert.ok(rNo.matched > 3, `候选数必须多于 limit，否则本断言没有区分力：matched=${rNo.matched}`)
  assert.equal(rNo.rows.length, Math.min(3, rNo.matched), '不扩检索 ⇒ rows.length === min(limit, 候选数)')
  assert.equal(rNo.rows.length, 3)
  assert.equal(rNo.rows.length, rNo.shown)
  checkTriageFields('不扩检索+硬上限', rNo)

  // 反向断言（用户点名保留）：expanded===false ⇒ rows.length === min(limit, 候选数)
  for (const r of [rNo]) {
    assert.equal(r.expanded, false)
    assert.equal(r.rows.length, Math.min(r.limit, r.matched),
      `expanded=false ⇒ rows.length 必须恰好 min(limit, 候选数)：rows=${r.rows.length}`)
  }
  // 正向：expanded===true ⇒ rows.length === limit（硬上限，不是 kUsed）
  assert.equal(rExp.rows.length, rExp.limit, 'expanded=true ⇒ rows.length 必须恰好 limit')
})

test('I2.1 修 2：退化情形（空库/空语料/空查询）分诊字段全部有限、不出 NaN，比值如实回显 0/0', async () => {
  freshHome('i21-degenerate')
  const r = await tools().get('memory_recall').execute({ query: '任意查询词', limit: 5 })
  checkTriageFields('空库未分诊', r)
  assert.equal(r.noQueryEnergy, true)
  assert.equal(r.expanded, false)
  assert.equal(r.kUsed, r.kBase)
  for (const k of ['novelty', 'explainedRatio', 'residualRatio', 'logicalDepth', 'covMax', 'noveltyThreshold', 'activationThreshold']) {
    assert.ok(Number.isFinite(r[k]), `${k} 必须有限，实际 ${r[k]}`)
    assert.ok(!Number.isNaN(r[k]), `${k} 不许是 NaN`)
  }
  assert.equal(r.explainedRatio + r.residualRatio, 0, '0/0 未定义 ⇒ 如实回显 0/0（不是假造出来的 1）')
  assert.ok(!JSON.stringify(r).includes('null'), 'NaN 在 JSON 里会变 null —— 一个都不许有')
  assertLossless('空库未分诊', r)

  const st = corpusStats([])
  const pureEmpty = residualPyramid('', [], st)
  assert.equal(pureEmpty.noQueryEnergy, true)
  assert.equal(pureEmpty.explainedRatio, 0)
  assert.equal(pureEmpty.residualRatio, 0)
  assert.ok(Number.isFinite(pureEmpty.novelty) && Number.isFinite(pureEmpty.directionConsistency))
  assert.ok(!Number.isNaN(pureEmpty.novelty + pureEmpty.explainedRatio + pureEmpty.residualRatio))
  checkTriageFields('空库空语料', withToolFields(pureEmpty))
})
