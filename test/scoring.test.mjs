// I1.2 打分口径用例：BM25（长度惩罚 / idf）、VCP 覆盖率 cov、绝对映射与 match 判定、
// 多样性并入分数、候选 <= 5 跳过多样性。
//
// 口径来源：第三方设计审计（修 A/B/C）。三条红证（无关查询不得满分 / 短相关胜过长无关 /
// 打印分数单调）放在 test/recall.test.mjs，因为它们断言的是「工具打印出来的那一列」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BM25_B, BM25_K1, DEFAULT_DIVERSITY_BETA, FIELD_WEIGHTS, SCALE_A, SCALE_B, STRONG_THRESHOLD, WEAK_THRESHOLD,
  absoluteDisp, bm25Relevance, clamp01, corpusStats, diversify, fieldSat, idf, lexicalScore, logCompress,
  matchLevel, resolveScoreOptions, tagCoverage, tagWeight,
} from '../lib/pure.js'
import { freshHome, tools } from './helpers.mjs'

const SPLIT = ' | '
const scoreOfLine = (line) => Number(line.split(SPLIT).at(-1))
const fieldOfLine = (line, k) => line.split(SPLIT).at(k)

// ── 修 B：BM25 ───────────────────────────────────────────────────────────────

test('BM25：idf 口径正确（稀有 > 常见，df=0 取上界，N=0 为 0）', () => {
  // idf(w) = log(1 + (N − df + 0.5)/(df + 0.5))
  assert.equal(idf(1, 100), Math.log(1 + (100 - 1 + 0.5) / (1 + 0.5)))
  assert.equal(idf(5, 5), Math.log(1 + 0.5 / 5.5))
  assert.ok(idf(1, 100) > idf(50, 100), '词越稀有 idf 越大')
  assert.ok(idf(50, 100) > idf(100, 100), 'idf 对 df 单调递减')
  assert.ok(idf(0, 100) > idf(1, 100), '语料里没有的词取到 idf 上界')
  assert.equal(idf(1, 0), 0, 'N=0（空字段）时为 0，不出 NaN')
  assert.ok(Number.isFinite(idf(0, 0)))

  // 同一 tf / 同一字段长度下，稀有词的相关度必须高于常见词
  const docs = Array.from({ length: 10 }, (_, i) => ({
    title: `note ${i}`, body: 'common word here', tags: ['t'],
  }))
  docs[0] = { title: 'target note', body: 'common rareword here', tags: ['t'] }
  const stats = corpusStats(docs)
  const relRare = bm25Relevance('rareword', docs[0], stats)
  const relCommon = bm25Relevance('common', docs[0], stats)
  assert.ok(relRare > relCommon, `稀有词必须更高：rare=${relRare} common=${relCommon}`)
})

test('BM25：长度惩罚（b=0.75 压低长文档；b=0 关掉长度归一后同 tf 完全相等）', () => {
  // fieldSat 直接钉公式：tf·(k1+1) / (tf + k1·(1 − b + b·|D|/avgdl))
  assert.equal(fieldSat(1, 10, 10, BM25_K1, BM25_B), (1 * (BM25_K1 + 1)) / (1 + BM25_K1 * 1))
  assert.ok(fieldSat(1, 100, 10) < fieldSat(1, 10, 10), '同一 tf：正文越长分越低')
  assert.ok(fieldSat(5, 10, 10) > fieldSat(1, 10, 10), '同一长度：tf 越大分越高（有界饱和）')
  assert.ok(fieldSat(10_000, 10, 10) < BM25_K1 + 1, '饱和上界是 k1+1')

  const filler = Array.from({ length: 6 }, (_, i) => ({
    title: `filler ${i}`, body: 'alpha beta gamma delta epsilon', tags: ['t'],
  }))
  const shortRec = { title: 'same title', body: 'zetaword', tags: ['t'] }
  const longRec = { title: 'same title', body: 'zetaword ' + 'padword '.repeat(120), tags: ['t'] }
  const stats = corpusStats([...filler, shortRec, longRec])

  const bShort = bm25Relevance('zetaword', shortRec, stats)
  const bLong = bm25Relevance('zetaword', longRec, stats)
  assert.ok(bShort > bLong, `短文档必须赢：short=${bShort} long=${bLong}`)
  assert.ok(bLong > 0, '长文档不是 0 分（只被稀释，不被清零）')

  // b=0 ⇒ 长度归一关闭 ⇒ 同一 tf 下两条完全相等（红证 2 的判红点就是关掉这里）
  const zShort = bm25Relevance('zetaword', shortRec, stats, { b: 0 })
  const zLong = bm25Relevance('zetaword', longRec, stats, { b: 0 })
  assert.equal(zShort, zLong, 'b=0 时长度信息被彻底丢弃 ⇒ 只按 tf 打平')
  assert.ok(zShort > bLong, 'b=0 会把被长度压住的长文档抬起来')
})

test('BM25：字段权重保留（tags > title > body），长文档靠噪声拿不到高分', () => {
  const rec = { title: 'alphaword', body: 'betaword', tags: ['gammaword'] }
  const sTag = lexicalScore('gammaword', rec)
  const sTitle = lexicalScore('alphaword', rec)
  const sBody = lexicalScore('betaword', rec)
  assert.ok(sTag > sTitle && sTitle > sBody, `字段权重必须 tags>title>body：${sTag}/${sTitle}/${sBody}`)
  assert.equal(FIELD_WEIGHTS.tags, 3)
  assert.equal(FIELD_WEIGHTS.title, 2)
  assert.equal(FIELD_WEIGHTS.body, 1)

  // 噪声：长正文把查询词反复堆起来，也不该赢过三字段各命中一次的精炼记录
  const noise = {
    title: 'noise note',
    body: 'zetaword '.repeat(300) + 'unrelated '.repeat(100),
    tags: ['noise'],
  }
  const focused = { title: 'zetaword', body: 'zetaword', tags: ['zetaword'] }
  const stats = corpusStats([noise, focused, { title: 'x note', body: 'y', tags: ['t'] }])
  assert.ok(
    bm25Relevance('zetaword', focused, stats) > bm25Relevance('zetaword', noise, stats),
    '反复堆词频的长噪声不得反超精炼短记录',
  )
})

// ── 修 B：VCP 覆盖率 cov（仅诊断）────────────────────────────────────────────

test('cov：命中标签权重占总权重的比例；外围非命中标签只能稀释', () => {
  const docs = [
    { title: 'a', body: 'b', tags: ['shared', 'rare'] },
    { title: 'a', body: 'b', tags: ['shared'] },
  ]
  const stats = corpusStats(docs)
  const wShared = idf(2, 2)
  const wRare = idf(1, 2)
  const covShared = tagCoverage('shared', ['shared', 'rare'], stats)
  assert.ok(Math.abs(covShared - wShared / (wShared + wRare)) < 1e-12, `cov 定义不符：${covShared}`)
  assert.ok(tagCoverage('rare', ['shared', 'rare'], stats) > covShared, '更稀有的标签权重更大')
  assert.equal(tagCoverage('rare', ['rare'], stats), 1, '全部标签都命中 ⇒ 1')
  assert.ok(tagCoverage('rare', ['rare', 'shared', 'extra'], stats) < 1, '非命中标签只进分母（稀释）')
  assert.equal(tagCoverage('zzz', ['shared', 'rare'], stats), 0, '无命中 ⇒ 0')
  assert.equal(tagCoverage('rare', [], stats), 0)
  assert.equal(tagCoverage('', ['rare'], stats), 0, '空查询没有覆盖率')

  // logfreq 口径：1/log(1+λ(df+1))，递减且分母恒 > 0
  assert.ok(tagWeight('rare', stats, { weighting: 'logfreq' }) > tagWeight('shared', stats, { weighting: 'logfreq' }))
  assert.equal(tagCoverage('rare', ['rare'], stats, { weighting: 'logfreq' }), 1)

  // 频次 / 边权必须 log 压缩，禁止线性累加
  assert.equal(logCompress(0), 0)
  assert.equal(logCompress(3), Math.log(4))
  assert.ok(logCompress(1000) < 1000)
  assert.ok(logCompress(1 + 1) < logCompress(1) + logCompress(1), 'log(1+a+b) < log(1+a)+log(1+b)')
})

// ── 修 A：绝对映射与绝对判定 ─────────────────────────────────────────────────

test('绝对映射：disp=clip((raw−A)/(B−A))，常数固定、不看批次', () => {
  assert.equal(SCALE_A, 0)
  assert.equal(SCALE_B, 0.45)
  assert.equal(absoluteDisp(0), 0)
  assert.equal(absoluteDisp(SCALE_B), 1)
  assert.equal(absoluteDisp(SCALE_B * 2), 1, '超出上界必须 clip 到 1（不是 2）')
  assert.equal(absoluteDisp(-1), 0, '低于下界必须 clip 到 0')
  assert.ok(Math.abs(absoluteDisp(0.225) - 0.5) < 1e-12, '线性映射')
  assert.ok(absoluteDisp(0.1) < absoluteDisp(0.2), '单调不减')
  assert.equal(absoluteDisp(Number.NaN), 0)
  assert.equal(absoluteDisp(Number.POSITIVE_INFINITY), 0, '非有限值一律 0，不泄 NaN/Infinity')
  assert.ok(Math.abs(absoluteDisp(0.3, 0.2, 0.2) - 0.1) < 1e-12, '退化区间兜底为 a+1，不是除零')
  assert.equal(clamp01(5), 1)
  assert.equal(clamp01(-5), 0)
  // 映射函数签名里没有「本批候选」这一入参 ⇒ 同一 raw 在任何批次里 disp 恒等（结构性保证）。
  assert.equal(absoluteDisp.length >= 1 && absoluteDisp.length <= 3, true)
})

test('match：由 raw 与两个绝对阈值比较得出（none/weak/strong），阈值可配置', () => {
  assert.equal(matchLevel(0), 'none')
  assert.equal(matchLevel(WEAK_THRESHOLD - 1e-9), 'none')
  assert.equal(matchLevel(WEAK_THRESHOLD), 'weak')
  assert.equal(matchLevel(STRONG_THRESHOLD - 1e-9), 'weak')
  assert.equal(matchLevel(STRONG_THRESHOLD), 'strong')
  assert.equal(matchLevel(1), 'strong')
  assert.equal(matchLevel(Number.NaN), 'none')

  const def = resolveScoreOptions()
  assert.equal(def.scaleA, SCALE_A)
  assert.equal(def.scaleB, SCALE_B)
  assert.equal(def.weak, WEAK_THRESHOLD)
  assert.equal(def.strong, STRONG_THRESHOLD)
  assert.equal(def.beta, DEFAULT_DIVERSITY_BETA)

  const custom = resolveScoreOptions({ scaleB: 0.9, weakThreshold: 0.3, strongThreshold: 0.2, diversityBeta: 0.5 })
  assert.equal(custom.scaleB, 0.9)
  assert.equal(custom.weak, 0.2, 'weak > strong 时交换，保证 match 单调')
  assert.equal(custom.strong, 0.3)
  assert.equal(custom.beta, 0.5)
  assert.equal(matchLevel(0.25, custom.weak, custom.strong), 'weak')

  // 非法输入不得污染口径
  assert.equal(resolveScoreOptions({ scaleB: Number.NaN }).scaleB, SCALE_B)
  assert.equal(resolveScoreOptions({ scaleA: 1, scaleB: 0.5 }).scaleB, 2, 'scaleB <= scaleA ⇒ 兜底 scaleA+1')
  assert.equal(resolveScoreOptions({ diversityBeta: 9 }).beta, 1)
  assert.equal(resolveScoreOptions({ diversityBeta: -9 }).beta, 0)
})

// ── 修 C：多样性并入同一个分数 ───────────────────────────────────────────────

const DIV_RECORDS = [
  { id: 'aaa', score: 1.0, tags: ['x'] },
  { id: 'bbb', score: 0.99, tags: ['x'] },
  { id: 'ccc', score: 0.98, tags: ['x'] },
  { id: 'ddd', score: 0.9, tags: ['y'] },
]

test('多样性并入分数：final = rel × (1 − β·maxSim)，序列本身单调不增', () => {
  const out = diversify(DIV_RECORDS, { beta: 0.3, limit: 4 })
  assert.deepEqual(out.map((r) => r.id), ['aaa', 'ddd', 'bbb', 'ccc'], '同标签堆叠被打散')
  const bbb = out.find((r) => r.id === 'bbb')
  assert.ok(bbb !== undefined)
  assert.ok(Math.abs(bbb.final - 0.99 * (1 - 0.3 * 1)) < 1e-12, `final 公式不符：${bbb.final}`)
  const ccc = out.find((r) => r.id === 'ccc')
  assert.ok(ccc !== undefined)
  assert.ok(Math.abs(ccc.final - 0.98 * (1 - 0.3 * 1)) < 1e-12)
  const ddd = out.find((r) => r.id === 'ddd')
  assert.ok(ddd !== undefined)
  assert.ok(Math.abs(ddd.final - 0.9) < 1e-12, '不同标签 ⇒ 无惩罚')

  const finals = out.map((r) => r.final)
  for (let i = 1; i < finals.length; i += 1) {
    assert.ok(finals[i] <= finals[i - 1], `final 序列必须单调不增：${finals.join(',')}`)
  }
  // 旧口径（打印惩罚前的分）必然倒挂 —— 这正是 I1.2 修 C 的病根。
  const printedRel = out.map((r) => r.score)
  assert.ok(printedRel.some((v, i) => i > 0 && v > printedRel[i - 1]), `打印 rel 会倒挂：${printedRel.join(',')}`)

  // lambda 旧口径兼容：lambda = 1 − β
  assert.deepEqual(diversify(DIV_RECORDS, { lambda: 0.7, limit: 4 }).map((r) => r.id), out.map((r) => r.id))
  assert.deepEqual(diversify(DIV_RECORDS, { lambda: 1, limit: 4 }).map((r) => r.id), ['aaa', 'bbb', 'ccc', 'ddd'])
})

test('候选 <= minCandidates 时跳过多样性（final 恒等于 rel）', () => {
  const skipped = diversify(DIV_RECORDS, { beta: 0.3, limit: 4, minCandidates: 5 })
  assert.deepEqual(skipped.map((r) => r.id), ['aaa', 'bbb', 'ccc', 'ddd'], '跳过 ⇒ 不重排')
  assert.deepEqual(skipped.map((r) => r.final), DIV_RECORDS.map((r) => r.score), '跳过 ⇒ final === rel')

  const applied = diversify(DIV_RECORDS, { beta: 0.3, limit: 4, minCandidates: 3 })
  assert.deepEqual(applied.map((r) => r.id), ['aaa', 'ddd', 'bbb', 'ccc'], '候选数 > 阈值才重排')
  // 默认 minCandidates = 0（纯函数层不预设策略，召回层显式传 5）
  assert.deepEqual(
    diversify(DIV_RECORDS, { beta: 0.3, limit: 4 }).map((r) => r.id),
    applied.map((r) => r.id),
  )
  // 同分时按 rank（融合秩）决胜，再按 id 字典序 ⇒ 确定性
  const tied = [
    { id: 'zzz', score: 0, tags: [], rank: 1 },
    { id: 'aaa', score: 0, tags: [], rank: 0 },
  ]
  assert.deepEqual(diversify(tied, { beta: 0.3, limit: 2 }).map((r) => r.id), ['aaa', 'zzz'])
})

// ── 工具层：修 A 的「不随批次归一化」与 cov 不门控 ───────────────────────────

test('工具层：Top1 不再恒为 1.0000（绝对映射），且 rel/score 同标度可比', async () => {
  freshHome('scoring-top')
  const defs = tools()
  const remember = defs.get('memory_remember')
  const recall = defs.get('memory_recall')

  // 只有正文命中（弱证据）：批次里最好的候选就该是「弱」，绝不可能是满分。
  const w = await remember.execute({
    kind: 'fact', title: 'dark theme css variables', body: 'zetaword is mentioned only here',
    tags: ['ui'], source: 'test:scoring',
  })
  assert.equal(w.ok, true)
  const r = await recall.execute({ query: 'zetaword', limit: 5 })
  assert.equal(r.ok, true)
  assert.ok(r.rows.length > 0, '低相关也要如实返回，不得整批否决')
  assert.equal(r.rows[0].id, w.id)
  assert.ok(r.rows[0].score < 0.5, `Top1 不得是满分：${r.rows[0].score}`)
  assert.ok(r.rows[0].score < 1)
  assert.equal(r.rows[0].score, r.rows[0].rel, '候选 <= 5 跳过多样性 ⇒ score === rel')
  assert.equal(r.scaleA, SCALE_A)
  assert.equal(r.scaleB, SCALE_B)
  assert.equal(r.weakThreshold, WEAK_THRESHOLD)
  assert.equal(r.strongThreshold, STRONG_THRESHOLD)
  assert.equal(r.diversityApplied, false)
  assert.equal(r.diversityBeta, 0)
  // 打印列与结构化行一致（打印列是 4 位小数，所以按 toFixed(4) 对齐），
  // 且最后一列是 score（既有「行尾分数」契约）。
  for (let i = 0; i < r.rows.length; i += 1) {
    assert.equal(scoreOfLine(r.lines[i]), Number(r.rows[i].score.toFixed(4)))
    assert.equal(Number(fieldOfLine(r.lines[i], -4)), Number(r.rows[i].rel.toFixed(4)))
    assert.equal(Number(fieldOfLine(r.lines[i], -3)), Number(r.rows[i].cov.toFixed(4)))
    assert.equal(fieldOfLine(r.lines[i], -2), r.rows[i].match)
  }
})

test('工具层：候选 > 5 才启用多样性；cov 作为诊断列不门控（低覆盖不返回空）', async () => {
  freshHome('scoring-diversity')
  const defs = tools()
  const remember = defs.get('memory_remember')
  const recall = defs.get('memory_recall')

  for (let i = 0; i < 8; i += 1) {
    const r = await remember.execute({
      kind: 'fact', title: `theme note number ${i}`, body: `dark theme details ${i}`,
      tags: ['theme', 'shared'], source: 'test:scoring',
    })
    assert.equal(r.ok, true)
  }
  const r = await recall.execute({ query: 'dark theme', limit: 8 })
  assert.equal(r.rows.length, 8, '候选 > 5 ⇒ 走多样性分支')
  assert.equal(r.diversityApplied, true)
  assert.equal(r.diversityBeta, DEFAULT_DIVERSITY_BETA)
  const finals = r.lines.map(scoreOfLine)
  for (let i = 1; i < finals.length; i += 1) {
    assert.ok(finals[i] <= finals[i - 1], `打印分必须单调不增：${finals.join(',')}`)
  }
  assert.equal(scoreOfLine(r.lines[0]), Number(r.rows[0].score.toFixed(4)))
  for (const row of r.rows) {
    assert.ok(row.cov >= 0 && row.cov <= 1, `cov 必须落在 0..1：${row.cov}`)
    assert.ok(row.score <= row.rel + 1e-12, 'score 含惩罚 ⇒ 恒 <= rel')
  }

  // 覆盖率极低（只命中一个外围标签）也不得整批否决 / 返回空
  const low = await recall.execute({ query: 'shared', limit: 8 })
  assert.equal(low.ok, true)
  assert.ok(low.rows.length > 0, '低覆盖不得返回空（第三方明确回退过这种门控）')
  assert.ok(low.rows.every((row) => row.cov >= 0 && row.cov <= 1))
  assert.ok(low.rows.some((row) => row.match === 'none' || row.match === 'weak'), '低覆盖不该被抬成 strong')
})
