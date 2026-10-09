// I1.2 打分口径用例：BM25（长度惩罚 / idf）、VCP 覆盖率 cov、绝对映射与 match 判定、
// 多样性并入分数、候选 <= 5 跳过多样性。
//
// 口径来源：第三方设计审计（修 A/B/C）。三条红证（无关查询不得满分 / 短相关胜过长无关 /
// 打印分数单调）放在 test/recall.test.mjs，因为它们断言的是「工具打印出来的那一列」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  BM25_B, BM25_K1, CALIBRATION_DATE, CALIBRATION_DRIFT_ABS, CALIBRATION_DRIFT_REL, CALIBRATION_RECORDS,
  CONTENT_TOKEN_MIN, DEFAULT_DIVERSITY_BETA, FIELD_WEIGHTS, GATE_MARGIN, SCALE_A, SCALE_B, STRONG_THRESHOLD, WEAK_THRESHOLD,
  absoluteDisp, bm25Relevance, calibrationDrift, clamp01, corpusStats, diversify, fieldSat, idf, lexicalScore, logCompress,
  matchLevel, matchLevelGated, queryContentTokens, resolveScoreOptions, tagCoverage, tagWeight,
} from '../lib/pure.js'
import { freshHome, memFile, tools, appliedContexts } from './helpers.mjs'
import { INJECTION_CONTEXT_NAME } from '../lib/inject.js'

const SPLIT = ' | '
const scoreOfLine = (line) => Number(line.split(SPLIT).at(-1))
const fieldOfLine = (line, k) => line.split(SPLIT).at(k)

/**
 * 用**打印出来的量**复算 match（I1.3 铁律）：rel + 两个阈值 + 内容量闸门输入（qTok/阈值/例外倍数 M）。
 * 规则与表头逐字一致：
 *   match = qTok=0 ? none
 *         : qTok < contentTokenMin ? (base=strong 且 rel < gateMargin × strong ? weak : base)
 *         : matchLevel(rel, weak, strong)
 * 这个函数故意**不**import matchLevelGated —— 复算必须是「读者看着输出就能做」的独立算式。
 */
function expectMatch(reply, rel) {
  if (reply.contentTokens === 0) return 'none'
  const base = matchLevel(rel, reply.weakThreshold, reply.strongThreshold)
  if (reply.contentTokens >= reply.contentTokenMin || base !== 'strong') return base
  return rel < reply.gateMargin * reply.strongThreshold ? 'weak' : 'strong'
}

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
  // 标定后 SCALE_A != 0（0.0199 = p50 负样本，噪声地板）⇒ 区间中点不再是固定的 0.225，
  // 而是 (SCALE_A + SCALE_B) / 2；下界本身映射到 0、下界以下一律 0（这两条是新标度下的强断言）。
  // 这两个数是**写死的锚点**（不是从常量读回来的）：标定改了就必须有人来改这一行，否则「常数被悄悄改小」
  // 不会变红。与 src/pure.ts 注释里「落地值：」那一行的逐字一致由本文件末尾的用例另行钉住。
  assert.equal(SCALE_A, 0.0199)
  assert.equal(SCALE_B, 0.3666)
  assert.equal(absoluteDisp(SCALE_A), 0, '下界本身必须映射到 0')
  assert.equal(absoluteDisp(SCALE_A / 2), 0, '噪声地板以下一律 0（不再线性外推到负分）')
  assert.equal(absoluteDisp(SCALE_B), 1)
  assert.equal(absoluteDisp(SCALE_B * 2), 1, '超出上界必须 clip 到 1（不是 2）')
  assert.equal(absoluteDisp(-1), 0, '低于下界必须 clip 到 0')
  assert.ok(Math.abs(absoluteDisp((SCALE_A + SCALE_B) / 2) - 0.5) < 1e-12, '线性映射（区间中点恒为 0.5）')
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
  // I1.3 自证修正：rel 是判定所依据的 BM25 原始分，score 是映射到 0..1 的展示分（两种标度，
  // 表头已声明）。可验算的是「用打印的 rel + 阈值 + 内容量闸门输入复现 match」，而不是两列相等。
  assert.equal(r.rows[0].match, expectMatch(r, r.rows[0].rel),
    '用打印的 rel 与表头阈值必须能复现 match')
  assert.ok(r.rows[0].score >= 0 && r.rows[0].score <= 1, `score 必须落在 0..1：${r.rows[0].score}`)
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

  // 8 条候选（> 5 ⇒ 开多样性）。I5 表头减肥后行预算回来了：表头 <= 400 字符 ⇒
  // 8 行（每行约 112 字符）离 RECALL_MAX_CHARS=2000 还很远，本用例重新回到旧口径
  // 「rows.length 恰好等于候选数」（原先为绕开长表头的字符预算被压成 6/limit=6）。
  for (let i = 0; i < 8; i += 1) {
    const r = await remember.execute({
      kind: 'fact', title: `theme note number ${i}`, body: `dark theme details ${i}`,
      tags: ['theme', 'shared'], source: 'test:scoring',
    })
    assert.equal(r.ok, true)
  }
  const r = await recall.execute({ query: 'dark theme', limit: 8 })
  assert.equal(r.rows.length, 8, '候选 > 5 ⇒ 走多样性分支，且 8 行都在字符预算内')
  assert.equal(r.truncated, false, '夹具必须留在字符预算内，否则下面的多样性断言会被截断干扰')
  assert.equal(r.diversityApplied, true)
  assert.equal(r.diversityBeta, DEFAULT_DIVERSITY_BETA)
  const finals = r.lines.map(scoreOfLine)
  for (let i = 1; i < finals.length; i += 1) {
    assert.ok(finals[i] <= finals[i - 1], `打印分必须单调不增：${finals.join(',')}`)
  }
  assert.equal(scoreOfLine(r.lines[0]), Number(r.rows[0].score.toFixed(4)))
  for (const row of r.rows) {
    assert.ok(row.cov >= 0 && row.cov <= 1, `cov 必须落在 0..1：${row.cov}`)
    // I1.3：rel 与 score 是两种标度（rel=BM25 原始分，score=disp(final)），不再有 score<=rel
    // 的跨标度关系；改为断言「match 可由打印的 rel + 阈值 + 内容量闸门输入复现」。
    assert.equal(row.match, expectMatch(r, row.rel),
      '用打印的 rel 与表头阈值必须能复现 match')
    assert.ok(row.score >= 0 && row.score <= 1, `score 必须落在 0..1：${row.score}`)
  }

  // 覆盖率极低（只命中一个外围标签）也不得整批否决 / 返回空
  const low = await recall.execute({ query: 'shared', limit: 8 })
  assert.equal(low.ok, true)
  assert.ok(low.rows.length > 0, '低覆盖不得返回空（第三方明确回退过这种门控）')
  assert.ok(low.rows.every((row) => row.cov >= 0 && row.cov <= 1))
  assert.ok(low.rows.some((row) => row.match === 'none' || row.match === 'weak'), '低覆盖不该被抬成 strong')
})

// ── I1.3：自证（打印的数必须能自行复现判定）────────────────────────────────

test('I1.3 自证：每一行都可用打印的 rel 与表头阈值复现 match（两种标度不混用）', async () => {
  freshHome('scoring-selfproof')
  const defs = tools()
  const remember = defs.get('memory_remember')
  const recall = defs.get('memory_recall')

  // 造出多种判定的样本。**关键靶子**：正文里恰好 4 个查询词元、且正文很短（dl=4）的记录，
  // 实测 rel≈0.0736（判 weak），而 disp(rel)≈0.1548（会被判 strong）——
  // 只有落在「两种基准判定分歧」区间内的行，才能让本用例真正有区分力。
  // 沿革：2026-10-09 第一次标定（0.0187/0.3420/0.0363/0.1476）时，正文 3 个词元（dl=3）就够
  // （rel≈0.0715 判 weak、disp≈0.1632 判 strong）。第二次标定（0.0199/0.3666/0.0382/0.1507）
  // 把 SCALE_B 抬高后，同一条 dig 的 disp 掉到 ≈0.1487 < 0.1507 ⇒ 两侧都判 weak，本判据退化成空转
  // （bandRows=0）。所以这里把靶子正文加到 4 个词元，让它重新落进分歧区（rel 判 weak、disp 判 strong）。
  await remember.execute({
    kind: 'fact', title: 'alpha beta gamma delta', body: 'alpha beta gamma delta epsilon',
    tags: ['alpha', 'beta'], source: 'test:selfproof',
  })
  await remember.execute({
    kind: 'fact', title: 'zeta appears once', body: 'unrelated filler words here',
    tags: ['zeta'], source: 'test:selfproof',
  })
  await remember.execute({
    kind: 'fact', title: 'omega standalone note', body: 'nothing shared at all',
    tags: ['omega'], source: 'test:selfproof',
  })
  await remember.execute({
    kind: 'fact', title: 'band probe note',
    body: 'bandword bandword bandword bandword',
    tags: ['band'], source: 'test:selfproof',
  })

  let bandRows = 0
  for (const query of ['alpha beta', 'zeta', 'bandword', 'nonexistent-token-xyz']) {
    const r = await recall.execute({ query, limit: 3 })
    assert.equal(r.ok, true)
    for (const row of r.rows) {
      // 判据：打印的 rel（= BM25 原始分）、打印的阈值与打印的闸门输入 must 复现打印的 match。
      assert.equal(row.match, expectMatch(r, row.rel),
        `query=${query} 行 ${row.id}：rel=${row.rel} 阈值=${r.weakThreshold}/${r.strongThreshold} qTok=${r.contentTokens}/${r.contentTokenMin} 却判 ${row.match}`)
      // rel 是绝对标度、不随批次归一化 ⇒ 无关查询不得出现满分。
      assert.ok(Number.isFinite(row.rel) && row.rel >= 0, `rel 必须是非负有限数：${row.rel}`)
      // score 是映射后的展示分，必须落在 0..1。
      assert.ok(row.score >= 0 && row.score <= 1, `score 必须落在 0..1：${row.score}`)
      // 记录「两种基准判定分歧」的行数——它是本用例区分力的来源。
      const relAsDisp = absoluteDisp(row.rel, r.scaleA, r.scaleB)
      if (matchLevel(relAsDisp, r.weakThreshold, r.strongThreshold) !== row.match) bandRows += 1
    }
  }

  // 夹具自检：若一条分歧行都没有，本用例对「把 rel 换成 disp」这种回归**没有区分力**
  //（这正是第一版红证没变红的原因：夹具全落在两种基准判定相同的区间）。
  assert.ok(bandRows > 0,
    `夹具必须覆盖「两种基准判定分歧」的区间，否则本判据是死的（实测 bandRows=${bandRows}）`)

  // 无关查询：Top1 必须不是 strong（且不应是 1.0 满分）。
  const r0 = await recall.execute({ query: 'nonexistent-token-xyz', limit: 3 })
  if (r0.rows.length > 0) {
    assert.notEqual(r0.rows[0].match, 'strong', '无关查询不得判 strong')
    assert.ok(r0.rows[0].rel < r0.strongThreshold, `无关查询的 rel 必须低于 strong 阈值：${r0.rows[0].rel}`)
  }
})

// ── 2026-10-09 真实语料标定：边界红证 + 注释/常数一致性 ──────────────────────

test('边界红证（判红点：WEAK_THRESHOLD 改回 0.06 即变红）：噪声上界 0.06 -> 0.0363 后，rel 落在该区间的真相关记录必须由 none 变 weak', async () => {
  const home = freshHome('scoring-band-redproof')
  // 出处（只读测量真实库，2026-10-09）：195 条真实库上以**标签「坑位」**为查询时，只共享该标签的
  // 记录 rel 落在 (0.0363, 0.06)（最高 0.052397，记录 mem_mv0btnuq_4a8d731f50，其后 0.0494/0.0436/…），
  // 旧 WEAK=0.06 判 none、新 0.0363 判 weak —— 这正是本次标定的实际意义（噪声上界下调）。
  // 真实 rel 依赖全库 195 条的 N/df/avgdl，无法把整库搬进夹具；这里按同一语义合成一个 100 条语料：
  // 每条都带同一个高频标签「bandprobe」（df=N ⇒ idf 极小，相当于那条「万能标签」），
  // 只有目标记录在正文里再出现它一次（真相关、但证据弱），实测目标行 rel = 0.047384。
  const N = 100
  const lines = []
  for (let i = 0; i < N; i += 1) {
    const target = i === 0
    lines.push(JSON.stringify({
      id: target ? 'mem_band_target' : `mem_band_f${String(i).padStart(3, '0')}`,
      ts: 1_700_000_000_000 + i,
      kind: 'fact',
      title: `bandprobe t${i}`,
      tags: ['bandprobe'],
      body: target
        ? ['bandprobe', ...Array.from({ length: 29 }, (_, j) => `pad${j}`)].join(' ')
        : `bfiller${i}`,
      source: 'test:bandprobe',
      hits: 0,
    }))
  }
  mkdirSync(dirname(memFile(home)), { recursive: true })
  writeFileSync(memFile(home), lines.join('\n') + '\n', 'utf8')

  const r = await tools().get('memory_recall').execute({ query: 'bandprobe', limit: 5 })
  const row = r.rows.find((x) => x.id === 'mem_band_target')
  assert.ok(row !== undefined, '目标记录必须在结果里')
  // 夹具自检：rel 必须**严格**落在两把噪声上界之间（0.0363 = 标定后 p95(负样本)、0.06 = 旧值）。
  // 这两个数是夹具锚点（写死才判得动红），**不是**从常量读回来的 —— 从常量读会让断言跟着常量漂移成假绿。
  assert.ok(row.rel > 0.0363 && row.rel < 0.06, `夹具 rel 必须严格落在 (0.0363, 0.06)：${row.rel}`)
  // 核心断言：只断言**标签**（不回显常量值）⇒ 把 WEAK_THRESHOLD 临时改回 0.06，该行变 none，此条必红。
  assert.equal(row.match, 'weak',
    `rel 在噪声上界之下的真相关记录必须判 weak（实测 rel=${row.rel} 判 ${row.match}）`)
})

test('标定一致性：4 个默认常数必须与 src/pure.ts 注释里「落地值：」那一行的数字逐字一致', () => {
  const src = readFileSync(new URL('../src/pure.ts', import.meta.url), 'utf8')
  const line = src.split('\n').find((l) => l.includes('落地值：'))
  assert.ok(line !== undefined, 'src/pure.ts 必须保留「落地值：」这一行（标定注释里放数字的机器可读行）')
  const pick = (name) => {
    const m = new RegExp(`${name} = ([0-9]+(?:\\.[0-9]+)?)`).exec(line)
    assert.ok(m !== null, `「落地值：」行里缺少 ${name} = <数字>：${line.trim()}`)
    return Number(m[1])
  }
  // 双向钉住：常量改了注释没改、或注释改了常量没改，两边都会红。
  assert.equal(SCALE_A, pick('SCALE_A'))
  assert.equal(SCALE_B, pick('SCALE_B'))
  assert.equal(WEAK_THRESHOLD, pick('WEAK_THRESHOLD'))
  assert.equal(STRONG_THRESHOLD, pick('STRONG_THRESHOLD'))
  // ③ 标定元数据的机器可读行必须与导出常量双向一致（库规模 + 日期）。
  const calLine = src.split('\n').find((l) => l.includes('标定规模：'))
  assert.ok(calLine !== undefined, 'src/pure.ts 必须保留「标定规模：」这一机器可读行')
  const calPick = (name) => {
    const m = new RegExp(`${name} = ([0-9-]+)`).exec(calLine)
    assert.ok(m !== null, `「标定规模：」行里缺少 ${name}：${calLine.trim()}`)
    return m[1]
  }
  assert.equal(String(CALIBRATION_RECORDS), calPick('CALIBRATION_RECORDS'))
  assert.equal(CALIBRATION_DATE, calPick('CALIBRATION_DATE'))
  assert.match(CALIBRATION_DATE, /^\d{4}-\d{2}-\d{2}$/, 'CALIBRATION_DATE 必须是 ISO 日期')
  // 注释还必须写出「哪个量取哪个分位数」与语料出处（防「只改数字、不留出处」）。
  for (const frag of ['p50(负样本)', 'p95(正样本)', 'p95(负样本)', 'p10(正样本)', '195 条', '388', '240', '2026-10-09', 'gotchas.md']) {
    assert.ok(src.includes(frag), `标定注释必须保留可核对的出处片段：${frag}`)
  }
  assert.ok(
    src.includes('该语料有偏（单一项目、单一种文风），语料明显增长后必须用 `scripts/calibrate.mjs` 重新标定并同步更新本注释。'),
    '标定注释里这句（有偏语料 + 重新标定要求）必须逐字保留',
  )
})

// ── 第二次标定（2026-10-09）：四个常数**各自**的边界红证 ───────────────────────
//
// 第二次落地把四个常数改到 0.0199 / 0.3666 / 0.0382 / 0.1507，与旧值的差分别是
// +0.0012 / +0.0246 / +0.0019 / +0.0031（四个量出自**同一次确定性运行**；按「差异 ≥ 0.005 视为显著」
// 只有 SCALE_B 单独显著，整组落地的理由见 src/pure.ts 注释）。
// 这里给四个常数各配一条**夹具 rel 落在该常数新旧值之间**的用例，断言只写在「标签 / 展示分」上
//（**不回显常量**）⇒ 把该常数改回旧值，对应那条必红。这就是「配能判红的边界用例」。
//
// 夹具的 rel 是**实测锚点**（写死才判得动红）：字符串里写死的两个数是新旧常数，不是从常量读回来的 ——
// 从常量读会让断言跟着常量漂移成假绿。

/** 合成一份「目标记录 rel 恰好夹在某个常数新旧值之间」的语料（与既有边界用例同构）。 */
function seedSecondBandCorpus(home, { N, df, fields, tf, pad }) {
  const lines = []
  for (let i = 0; i < N; i += 1) {
    const isTarget = i === 0
    const hasQ = i < df
    const body = []
    if (hasQ && fields.body) for (let t = 0; t < (isTarget ? tf : 1); t += 1) body.push('zzqterm')
    for (let j = 0; j < pad; j += 1) body.push(`pad${j}`)
    lines.push(JSON.stringify({
      id: isTarget ? 'mem_band_target' : `mem_band_f${String(i).padStart(3, '0')}`,
      ts: 1_700_000_000_000 + i,
      kind: 'fact',
      title: hasQ && fields.title ? `zzqterm t${i}` : `t${i}`,
      body: body.join(' '),
      tags: hasQ && fields.tags ? ['zzqterm', 'zzcommon'] : ['zzcommon'],
      source: 'test:band2',
      hits: 0,
    }))
  }
  mkdirSync(dirname(memFile(home)), { recursive: true })
  writeFileSync(memFile(home), `${lines.join('\n')}\n`, 'utf8')
}

/** 关掉多样性与图传播 ⇒ 打印的 score 恰好 = disp(rel)，让「标度」边界不被别的机制搅浑。 */
const PURE_SCALE = { score: { diversityBeta: 0 }, graph: { maxHops: 0 } }

test('边界红证（判红点：WEAK_THRESHOLD 改回 0.0363 即变红）：rel 落在 (0.0363, 0.0382) 的记录必须由 weak 落回 none', async () => {
  const home = freshHome('scoring-band2-weak')
  seedSecondBandCorpus(home, { N: 6, df: 3, fields: { body: true }, tf: 12, pad: 1 })
  const r = await tools().get('memory_recall').execute({ query: 'zzqterm', limit: 5 })
  const row = r.rows.find((x) => x.id === 'mem_band_target')
  assert.ok(row !== undefined, '目标记录必须在结果里')
  assert.ok(row.rel > 0.0363 && row.rel < 0.0382,
    `夹具 rel 必须严格落在 (0.0363, 0.0382)（= WEAK 的新旧值）：${row.rel}`)
  assert.equal(row.match, 'none',
    `rel 落在新噪声上界之下的记录必须判 none（实测 rel=${row.rel} 判 ${row.match}）`)
})

test('边界红证（判红点：STRONG_THRESHOLD 改回 0.1476 即变红）：rel 落在 (0.1476, 0.1507) 的记录必须由 strong 降为 weak', async () => {
  const home = freshHome('scoring-band2-strong')
  seedSecondBandCorpus(home, { N: 6, df: 2, fields: { title: true, body: true }, tf: 8, pad: 16 })
  const r = await tools().get('memory_recall').execute({ query: 'zzqterm', limit: 5 })
  const row = r.rows.find((x) => x.id === 'mem_band_target')
  assert.ok(row !== undefined, '目标记录必须在结果里')
  assert.ok(row.rel > 0.1476 && row.rel < 0.1507,
    `夹具 rel 必须严格落在 (0.1476, 0.1507)（= STRONG 的新旧值）：${row.rel}`)
  assert.equal(row.match, 'weak',
    `rel 落在新 strong 阈值之下的记录必须判 weak（实测 rel=${row.rel} 判 ${row.match}）`)
})

test('边界红证（判红点：SCALE_B 改回 0.3420 即变红）：rel 落在 (0.3420, 0.3666) 的记录展示分不再顶到 1.0000', async () => {
  const home = freshHome('scoring-band2-scaleb')
  seedSecondBandCorpus(home, { N: 6, df: 1, fields: { tags: true, title: true, body: true }, tf: 1, pad: 4 })
  const r = await tools(PURE_SCALE).get('memory_recall').execute({ query: 'zzqterm', limit: 5 })
  const row = r.rows.find((x) => x.id === 'mem_band_target')
  assert.ok(row !== undefined, '目标记录必须在结果里')
  assert.ok(row.rel > 0.342 && row.rel < 0.3666,
    `夹具 rel 必须严格落在 (0.3420, 0.3666)（= SCALE_B 的新旧值）：${row.rel}`)
  assert.ok(row.score < 1,
    `rel 低于新区间上界的记录展示分必须**严格小于** 1（旧 SCALE_B 会把它顶到 1.0000）：${row.score}`)
})

test('边界红证（判红点：SCALE_A 改回 0.0187 即变红）：rel 落在 (0.0187, 0.0199) 的记录展示分被新噪声地板压到 0', async () => {
  const home = freshHome('scoring-band2-scalea')
  seedSecondBandCorpus(home, { N: 6, df: 5, fields: { title: true }, tf: 1, pad: 1 })
  const r = await tools(PURE_SCALE).get('memory_recall').execute({ query: 'zzqterm', limit: 5 })
  const row = r.rows.find((x) => x.id === 'mem_band_target')
  assert.ok(row !== undefined, '目标记录必须在结果里')
  assert.ok(row.rel > 0.0187 && row.rel < 0.0199,
    `夹具 rel 必须严格落在 (0.0187, 0.0199)（= SCALE_A 的新旧值）：${row.rel}`)
  assert.equal(row.score, 0,
    `rel 落在新噪声地板之下的记录展示分必须是 0（旧 SCALE_A 会给出一个小正数）：${row.score}`)
})

// ── 内容量闸门（本次新增；病灶与标定见 src/pure.ts 的 CONTENT_TOKEN_MIN 注释）──────────
//
// 病：`rel` 的分母是「查询自身的理论 BM25 上界」，**单内容词元**的查询几乎能独自顶到那个上界
// ⇒ 比值虚高。真实 204 条库实测：`ok`/`做`/`b` 三条完全无关的记忆都判 strong（rel 0.187/0.183/0.171，
// 阈值 0.1507）。修法**不动 rel、不动四个已标定常数**，只给判定加一层内容量闸门（封顶）。
//
// 这里用**合成语料**钉住机制（真实 4 例 + 虚拟屏两侧由 redproof/i9-short-query-gate.mjs 在真库上固化成用例）：
// 200 条语料里只有 rec0 的标题与正文含 `zzgate` ⇒ 单内容词元查询实测 rel≈0.2176（>= strong 阈值），
// 修前必判 strong、修后必须判 weak；同一条记录用两个内容词元查询（`zzgate note`，rel≈0.1740）仍判 strong。

test('内容量闸门（纯函数）：queryContentTokens 口径 + matchLevelGated 三层规则 + 配置回落', () => {
  // 语料：rec0 标题含 zzgate，rec1 正文含 shared，其余是填充
  const docs = [
    { title: 'zzgate note', body: 'pad0 pad1', tags: ['topic'] },
    { title: 'filler one', body: 'shared pad0', tags: ['topic'] },
    { title: 'filler two', body: 'pad0 pad1', tags: ['topic'] },
    { title: 'filler three', body: 'pad0 pad1', tags: ['topic'] },
  ]
  const stats = corpusStats(docs)
  // qTok = 去重查询词元里「在库内任一分词字段出现过」的个数（库内一次都没出现过的不计）
  assert.equal(queryContentTokens('zzgate', stats), 1)
  assert.equal(queryContentTokens('zzgate shared', stats), 2)
  assert.equal(queryContentTokens('zzgate zzgate', stats), 1, '去重后仍只有 1 个内容词元')
  assert.equal(queryContentTokens('zzq-nonexistent', stats), 0, '库内没出现过的词元不算内容量')
  assert.equal(queryContentTokens('zzq-nonexistent2 也不存在', stats), 0)
  assert.equal(queryContentTokens('', stats), 0)
  assert.equal(queryContentTokens('   ', stats), 0)
  assert.equal(queryContentTokens('pad0', stats), 1)

  // 四层：无内容量⇒none；贴线的 strong 封顶 weak；离阈值够远的 strong 例外放行；否则原样
  assert.equal(CONTENT_TOKEN_MIN, 2, '闸门默认阈值 2（标定见 src/pure.ts）')
  assert.equal(GATE_MARGIN, 2.0, '闸门例外倍数默认 2.0（标定见 src/pure.ts 的 GATE_MARGIN）')
  assert.equal(matchLevelGated(0.9, WEAK_THRESHOLD, STRONG_THRESHOLD, 0), 'none')
  // ★ 本次修的真回归：raw=0.9 是 strong 阈值的 5.97 倍（远超 M=2），单个内容词元也**不该**被压 ——
  //   旧实现（纯 qTok 封顶）在这里判 weak，把真话题误杀。判红点：删掉 margin 例外 ⇒ 本条变红。
  assert.equal(matchLevelGated(0.9, WEAK_THRESHOLD, STRONG_THRESHOLD, 1), 'strong',
    '离 strong 阈值远超 M 倍的单内容词元必须判 strong（不许误杀真话题）')
  assert.equal(matchLevelGated(0.9, WEAK_THRESHOLD, STRONG_THRESHOLD, 2), 'strong')
  assert.equal(matchLevelGated(0.9, WEAK_THRESHOLD, STRONG_THRESHOLD, 99), 'strong')
  // ★ 贴线的噪声仍必须封顶：真实库 `ok`/`做`/`b` 实测 1.13~1.23 倍。
  //   判红点：把 M 调成 0（永不封顶）⇒ 下面三条变红。
  assert.equal(matchLevelGated(STRONG_THRESHOLD * 1.23, WEAK_THRESHOLD, STRONG_THRESHOLD, 1), 'weak',
    '贴线（1.23×strong）的单内容词元必须仍封顶 weak')
  assert.equal(matchLevelGated(STRONG_THRESHOLD * 1.13, WEAK_THRESHOLD, STRONG_THRESHOLD, 1), 'weak')
  // 边界：恰好 = M×strong 不封顶（条件是严格小于），差一个 ulp 就封顶
  assert.equal(matchLevelGated(STRONG_THRESHOLD * GATE_MARGIN, WEAK_THRESHOLD, STRONG_THRESHOLD, 1), 'strong')
  assert.equal(matchLevelGated(STRONG_THRESHOLD * GATE_MARGIN - 1e-12, WEAK_THRESHOLD, STRONG_THRESHOLD, 1), 'weak')
  // 只封顶 strong：weak / none 两档逐字不变（短查询照样返回、照样能判 weak）
  assert.equal(matchLevelGated(STRONG_THRESHOLD, WEAK_THRESHOLD, STRONG_THRESHOLD, 5), 'strong')
  assert.equal(matchLevelGated(STRONG_THRESHOLD, WEAK_THRESHOLD, STRONG_THRESHOLD, 1), 'weak')
  assert.equal(matchLevelGated(WEAK_THRESHOLD, WEAK_THRESHOLD, STRONG_THRESHOLD, 1), 'weak')
  assert.equal(matchLevelGated(WEAK_THRESHOLD - 1e-9, WEAK_THRESHOLD, STRONG_THRESHOLD, 1), 'none')
  assert.equal(matchLevelGated(0, WEAK_THRESHOLD, STRONG_THRESHOLD, 1), 'none')
  // qTok 非有限：保守（当 0）⇒ 不给 strong
  assert.equal(matchLevelGated(0.9, WEAK_THRESHOLD, STRONG_THRESHOLD, Number.NaN), 'none')
  // M 的可覆盖性与回落：0 = **永不封顶**（红证用，合法值）；负数/非有限一律回落默认 2.0。
  assert.equal(matchLevelGated(0.9, WEAK_THRESHOLD, STRONG_THRESHOLD, 1, CONTENT_TOKEN_MIN, 0), 'strong',
    'M=0 表示永不封顶（判红用）')
  assert.equal(matchLevelGated(STRONG_THRESHOLD * 1.01, WEAK_THRESHOLD, STRONG_THRESHOLD, 1, CONTENT_TOKEN_MIN, 0), 'strong',
    'M=0 时连贴线的 strong 也不封')
  assert.equal(matchLevelGated(0.9, WEAK_THRESHOLD, STRONG_THRESHOLD, 1, CONTENT_TOKEN_MIN, -1), 'strong',
    '负 M 回落默认 2.0 ⇒ 0.9 仍例外放行')
  assert.equal(matchLevelGated(0.2, WEAK_THRESHOLD, STRONG_THRESHOLD, 1, CONTENT_TOKEN_MIN, Number.NaN), 'weak',
    '非有限 M 回落默认 2.0 ⇒ 0.2 < 0.3014 仍封顶')
  // 阈值非法一律回落默认（绝不因为坏配置静默关掉闸门）
  assert.equal(matchLevelGated(0.9, WEAK_THRESHOLD, STRONG_THRESHOLD, 1, 0), 'strong',
    '坏 contentTokenMin 回落 2；0.9 远超 M×strong ⇒ strong')
  assert.equal(matchLevelGated(0.2, WEAK_THRESHOLD, STRONG_THRESHOLD, 1, -3), 'weak',
    '坏 contentTokenMin 回落 2；0.2 贴线 ⇒ weak')
  assert.equal(matchLevelGated(0.2, WEAK_THRESHOLD, STRONG_THRESHOLD, 1, Number.NaN), 'weak')
  // 与 matchLevel 的关系：base 不是 strong 时两者恒等
  for (const raw of [0, 0.01, WEAK_THRESHOLD, 0.1, STRONG_THRESHOLD - 1e-9]) {
    assert.equal(matchLevelGated(raw, WEAK_THRESHOLD, STRONG_THRESHOLD, 1), matchLevel(raw, WEAK_THRESHOLD, STRONG_THRESHOLD))
  }

  // resolveScoreOptions：默认 2 / 2.0、显式 1 可关闸门、M=0 合法、非法回落
  assert.equal(resolveScoreOptions().contentTokenMin, CONTENT_TOKEN_MIN)
  assert.equal(resolveScoreOptions().gateMargin, GATE_MARGIN)
  assert.equal(resolveScoreOptions({ contentTokenMin: 1 }).contentTokenMin, 1, '阈值 1 = 关闸门（红证用）')
  assert.equal(resolveScoreOptions({ contentTokenMin: 3.9 }).contentTokenMin, 3, '取整')
  assert.equal(resolveScoreOptions({ contentTokenMin: 0 }).contentTokenMin, CONTENT_TOKEN_MIN)
  assert.equal(resolveScoreOptions({ contentTokenMin: -3 }).contentTokenMin, CONTENT_TOKEN_MIN)
  assert.equal(resolveScoreOptions({ contentTokenMin: Number.NaN }).contentTokenMin, CONTENT_TOKEN_MIN)
  assert.equal(resolveScoreOptions({ gateMargin: 0 }).gateMargin, 0, 'M=0 合法（永不封顶）')
  assert.equal(resolveScoreOptions({ gateMargin: 3.5 }).gateMargin, 3.5)
  assert.equal(resolveScoreOptions({ gateMargin: -1 }).gateMargin, GATE_MARGIN, '负 M 回落默认')
  assert.equal(resolveScoreOptions({ gateMargin: Number.NaN }).gateMargin, GATE_MARGIN, '非有限 M 回落默认')
  // ③ 标定漂移阈值：默认 + 覆盖 + 非法回落
  assert.equal(resolveScoreOptions().calibrationDriftRel, CALIBRATION_DRIFT_REL)
  assert.equal(resolveScoreOptions().calibrationDriftAbs, CALIBRATION_DRIFT_ABS)
  assert.equal(resolveScoreOptions({ calibrationDriftRel: 0.5 }).calibrationDriftRel, 0.5)
  assert.equal(resolveScoreOptions({ calibrationDriftAbs: 7 }).calibrationDriftAbs, 7)
  assert.equal(resolveScoreOptions({ calibrationDriftRel: -1 }).calibrationDriftRel, CALIBRATION_DRIFT_REL)
  assert.equal(resolveScoreOptions({ calibrationDriftAbs: Number.NaN }).calibrationDriftAbs, CALIBRATION_DRIFT_ABS)
  // 加一个字段不得动四个已标定常数
  assert.equal(resolveScoreOptions().scaleA, SCALE_A)
  assert.equal(resolveScoreOptions().scaleB, SCALE_B)
  assert.equal(resolveScoreOptions().weak, WEAK_THRESHOLD)
  assert.equal(resolveScoreOptions().strong, STRONG_THRESHOLD)
})

/** 内容量闸门夹具：200 条，仅目标记录标题+正文含 zzgate（单内容词元、真命中、rel >= strong）。 */
function seedContentGateCorpus(home) {
  const lines = []
  for (let i = 0; i < 200; i += 1) {
    const isTarget = i === 0
    lines.push(JSON.stringify({
      id: isTarget ? 'mem_gate_target' : `mem_gate_f${String(i).padStart(3, '0')}`,
      ts: 1_700_000_000_000 + i,
      kind: 'fact',
      title: isTarget ? 'zzgate note' : `zzcommon filler${i}`,
      body: isTarget ? 'zzgate pad0 pad1' : `zzcommon body pad0 pad1 filler${i}`,
      tags: ['zzcommon'],
      source: 'test:content-gate',
      hits: 0,
    }))
  }
  mkdirSync(dirname(memFile(home)), { recursive: true })
  writeFileSync(memFile(home), lines.join('\n') + '\n', 'utf8')
}

test('内容量闸门（工具层）：单内容词元查询 rel>=strong 也只判 weak，行照样返回；关闸门即回到 strong；回显按分支给（不封顶支不得照抄封顶样板）', async () => {
  const home = freshHome('scoring-content-gate')
  seedContentGateCorpus(home)
  const r = await tools().get('memory_recall').execute({ query: 'zzgate', limit: 3 })
  const row = r.rows.find((x) => x.id === 'mem_gate_target')
  assert.ok(row !== undefined, '目标记录必须在结果里（低内容量不整批否决）')
  assert.equal(r.contentTokens, 1, `夹具前提：单内容词元（实测 qTok=${r.contentTokens}）`)
  assert.equal(r.contentTokenMin, 2)
  // 夹具自检：rel 必须真的 >= strong 阈值，否则本用例没有区分力（封顶根本没触发）
  assert.ok(row.rel >= r.strongThreshold,
    `夹具自检：目标行 rel 必须 >= strong 阈值，否则闸门没被触发：rel=${row.rel} 阈值=${r.strongThreshold}`)
  // 核心断言：单内容词元 ⇒ 最高只到 weak
  assert.equal(row.match, 'weak', `单内容词元查询不得判 strong（rel=${row.rel}）`)
  assert.equal(row.match, expectMatch(r, row.rel), '打印量（rel+阈值+qTok）必须复现 match')
  assert.ok(r.rows.length > 0, '低内容量不得返回空（不整批否决）')

  // 表头必须逐字回显闸门的三个输入与规则（否则 match 复算不出来）。
  // ★ 本支 = **贴线封顶支**（qTok=1 < min=2 且确有 strong 行落在 M×strong 之下）：
  //   回显必须写全条件（qTok/min/M），且该行判 weak（上面已断言）。
  const header = r.text.split('\n')[0]
  assert.ok(header.includes(`内容量qTok=1<${r.contentTokenMin}且rel<${r.gateMargin}×strong⇒strong封顶weak`),
    `贴线封顶支表头必须回显内容量闸门的三个输入与规则：${header}`)
  assert.ok(header.includes('封顶'), `封顶支必须出现「封顶」字样：${header}`)

  // 判红点：把阈值设成 1（等价关掉闸门）⇒ 同一行必须回到 strong
  const off = await tools({ score: { contentTokenMin: 1 } }).get('memory_recall').execute({ query: 'zzgate', limit: 3 })
  assert.equal(off.contentTokenMin, 1)
  const offRow = off.rows.find((x) => x.id === 'mem_gate_target')
  assert.equal(offRow.rel, row.rel, '关闸门绝不该改 rel（只改判定）')
  assert.equal(offRow.match, 'strong', '关掉闸门后必须回到 strong —— 这正是本用例的判红点')
  // ★ 本支 = **不封顶支**（阈值 1 ⇒ qTok<1 恒不成立，闸门对本次查询没生效）。
  //   旧实现在这一支照抄封顶样板，打出 `qTok=1<1⇒strong封顶weak`：不等式假、且与 match=strong 自相矛盾。
  //   判红点：把回显改回无条件样板 ⇒ 下面的 `!includes('封顶')` 与 `≥` 断言立刻变红。
  const offHeader = off.text.split('\n')[0]
  assert.ok(!offHeader.includes('封顶'),
    `不封顶支的回显不得出现「封顶」字样（无条件样板在此支是假的）：${offHeader}`)
  assert.ok(offHeader.includes('内容量qTok=1≥1⇒闸门未生效'),
    `不封顶支表头必须按分支回显「未封顶/闸门未生效」且逐字回显两个闸门输入：${offHeader}`)

  // 话题侧防误伤：两个内容词元的查询（阈值 2）不被封顶
  const two = await tools().get('memory_recall').execute({ query: 'zzgate note', limit: 3 })
  const twoRow = two.rows.find((x) => x.id === 'mem_gate_target')
  assert.equal(two.contentTokens, 2, `夹具前提：两个内容词元（实测 ${two.contentTokens}）`)
  assert.ok(twoRow.rel >= two.strongThreshold, `夹具自检：两词元查询 rel 必须 >= strong：${twoRow.rel}`)
  assert.equal(twoRow.match, 'strong', '内容量达标（qTok>=阈值）的查询不得被封顶')
  assert.equal(twoRow.match, expectMatch(two, twoRow.rel), '打印量必须复现 match')
  // ★ 本支同样 = **不封顶支**（qTok=2 >= min=2，真机 query=`虚拟屏` 的同类情形）：回显必须准确。
  const twoHeader = two.text.split('\n')[0]
  assert.ok(!twoHeader.includes('封顶'),
    `qTok>=阈值时回显不得出现「封顶」字样：${twoHeader}`)
  assert.ok(twoHeader.includes('内容量qTok=2≥2⇒闸门未生效'),
    `qTok>=阈值时必须回显「未封顶」，不得照抄封顶样板：${twoHeader}`)
})

/**
 * 闸门例外夹具（本次修的真回归）：200 条，目标记录带标签 `zzrare` ⇒ 单内容词元查询
 * `zzrare` 实测 rel≈0.4084 = strong 阈值的 **2.71 倍**（>= M=2）。
 * 形态对齐真实库的 `adb`（qTok=1、rel=0.6557 = 4.35×strong，见 redproof/i11-*.txt）。
 */
function seedGateFarCorpus(home) {
  const lines = []
  for (let i = 0; i < 200; i += 1) {
    const isTarget = i === 0
    lines.push(JSON.stringify({
      id: isTarget ? 'mem_gate_far' : `mem_gate_x${String(i).padStart(3, '0')}`,
      ts: 1_700_000_000_000 + i,
      kind: 'fact',
      title: isTarget ? 'zzrare note' : `zzcommon filler${i}`,
      body: isTarget ? 'zzrare pad0 pad1' : `zzcommon body pad0 pad1 filler${i}`,
      tags: isTarget ? ['zzrare', 'zzcommon'] : ['zzcommon'],
      source: 'test:gate-far',
      hits: 0,
    }))
  }
  mkdirSync(dirname(memFile(home)), { recursive: true })
  writeFileSync(memFile(home), lines.join('\n') + '\n', 'utf8')
}

test('内容量闸门例外（工具层，真回归）：单内容词元但 rel 远超 M×strong 必须判 strong；退回纯 qTok 封顶即变红', async () => {
  const home = freshHome('scoring-gate-far')
  seedGateFarCorpus(home)
  const r = await tools().get('memory_recall').execute({ query: 'zzrare', limit: 3 })
  const row = r.rows.find((x) => x.id === 'mem_gate_far')
  assert.ok(row !== undefined, '目标记录必须在结果里')
  assert.equal(r.contentTokens, 1, `夹具前提：单内容词元（实测 qTok=${r.contentTokens}）`)
  assert.equal(r.contentTokenMin, 2)
  assert.equal(r.gateMargin, 2)
  // 夹具自检：rel 必须真的 >= M×strong，否则本用例没有区分力（例外根本没触发）
  assert.ok(row.rel >= r.gateMargin * r.strongThreshold,
    `夹具自检：目标行 rel 必须 >= M×strong：rel=${row.rel} M×strong=${r.gateMargin * r.strongThreshold}`)
  // ★ 核心断言（本次要修的真回归）：单个高专有词元 = 真话题，**不得**被内容量闸门误杀。
  //   判红点：删掉 matchLevelGated 里的 margin 例外（退回纯 qTok 封顶）⇒ 这里变成 weak。
  assert.equal(row.match, 'strong', `单内容词元但 rel 远超 M×strong 必须判 strong（rel=${row.rel}）`)
  assert.equal(row.match, expectMatch(r, row.rel), '打印量（rel+阈值+qTok+M）必须复现 match')
  const header = r.text.split('\n')[0]
  // ★ 例外放行支的回显：必须含「不压级」且**不得**含「封顶」（本支没有一行被压）。
  assert.ok(header.includes(`内容量qTok=1<${r.contentTokenMin}但rel≥${r.gateMargin}×strong⇒不压级`),
    `例外放行支表头必须逐字回显闸门三输入：${header}`)
  assert.ok(!header.includes('封顶'), `例外放行支不得出现「封顶」字样：${header}`)

  // 反向对照（判红点：把 M 抬到极大 = 退回纯 qTok 封顶）⇒ 同一行必须变回 weak。
  const capped = await tools({ score: { gateMargin: 1e9 } }).get('memory_recall').execute({ query: 'zzrare', limit: 3 })
  const cappedRow = capped.rows.find((x) => x.id === 'mem_gate_far')
  assert.equal(cappedRow.rel, row.rel, '改 M 绝不该改 rel（只改判定）')
  assert.equal(cappedRow.match, 'weak', '把 M 抬到极大（等价退回纯 qTok 封顶）后必须变红为 weak')
})

/** 标定漂移夹具：直接写 N 条同形记录（比 remember 循环快，也便于精确控制库规模）。 */
function seedPlainCorpus(home, n) {
  const lines = []
  for (let i = 0; i < n; i += 1) {
    lines.push(JSON.stringify({
      id: `mem_drift_${String(i).padStart(4, '0')}`,
      ts: 1_700_000_000_000 + i,
      kind: 'fact',
      title: `zzdrift note ${i}`,
      body: `zzdrift body pad ${i}`,
      tags: ['zzdrift'],
      source: 'test:drift',
      hits: 0,
    }))
  }
  mkdirSync(dirname(memFile(home)), { recursive: true })
  writeFileSync(memFile(home), lines.join('\n') + '\n', 'utf8')
}

test('标定漂移（纯函数）：相对/绝对阈值取先到者 + 非法回落', () => {
  // 标定点与阈值都是机器可读的模块级常数
  assert.equal(CALIBRATION_RECORDS, 204)
  assert.equal(CALIBRATION_DATE, '2026-10-09')
  assert.equal(CALIBRATION_DRIFT_REL, 0.2)
  assert.equal(CALIBRATION_DRIFT_ABS, 100)
  const at = (cur) => calibrationDrift(cur)
  assert.equal(at(204).exceeded, false, '正好在标定点 ⇒ 不报漂移')
  assert.equal(at(204).delta, 0)
  assert.equal(at(200).exceeded, false, '|−4|/204≈2% 且 4<=100 ⇒ 不报')
  assert.equal(at(250).relative, 46 / 204)
  assert.equal(at(250).exceeded, true, '204->250 是 +22.5% > 20% ⇒ 报（相对阈值先到）')
  assert.equal(at(160).exceeded, true, '204->160 是 −21.6% > 20% ⇒ 报')
  assert.equal(at(104).exceeded, true, '−49% 超相对阈值（虽然绝对差只有 100，不 >100）')
  assert.equal(at(103).exceeded, true, '绝对差 101 > 100 ⇒ 报（绝对阈值先到）')
  // 自定义阈值：相对不超但绝对超 ⇒ 仍报（取先到者）
  assert.equal(calibrationDrift(300, 204, 1.0, 10).exceeded, true, '相对 47% <= 100%，但绝对 96 > 10 ⇒ 报')
  assert.equal(calibrationDrift(300, 204, 1.0, 1000).exceeded, false, '两个阈值都放宽 ⇒ 不报')
  assert.equal(calibrationDrift(300, 204, 0.4, 1000).exceeded, true, '相对 47% > 40% ⇒ 报')
  // 非法/退化：非有限 current 当 0；calibratedRecords<=0 回落默认 204
  assert.equal(calibrationDrift(Number.NaN).currentRecords, 0)
  assert.equal(calibrationDrift(0).exceeded, true, '库被清空 ⇒ 100% 偏差 ⇒ 报')
  assert.equal(calibrationDrift(300, 0).calibratedRecords, CALIBRATION_RECORDS, 'calibratedRecords<=0 回落默认')
  assert.equal(calibrationDrift(300, 204, -1, -1).driftRel, CALIBRATION_DRIFT_REL, '负阈值回落默认')
})

test('标定漂移（工具层，双侧）：库规模远离标定点 ⇒ 表头必现提示；接近 ⇒ 必不出现（判红点：去掉该分支 ⇒ 前侧变红）', async () => {
  // ── 侧 A：20 条（|20−204|=184 > 100）⇒ 必现 ──────────────────────────────
  const homeA = freshHome('drift-far')
  seedPlainCorpus(homeA, 20)
  const rA = await tools().get('memory_recall').execute({ query: 'zzdrift', limit: 3 })
  assert.equal(rA.total, 20)
  assert.equal(rA.calibratedAt, CALIBRATION_DATE)
  assert.equal(rA.calibrationRecords, CALIBRATION_RECORDS)
  assert.equal(rA.calibrationDrift, 20 - CALIBRATION_RECORDS)
  assert.equal(rA.calibrationDriftExceeded, true)
  // 可复算：exceeded ⟺ 相对偏差 > driftRel 或 |drift| > driftAbs（取先到者）
  const recompute = (r) => Math.abs(r.calibrationDrift) / r.calibrationRecords > r.calibrationDriftRel
    || Math.abs(r.calibrationDrift) > r.calibrationDriftAbs
  assert.equal(rA.calibrationDriftExceeded, recompute(rA), '漂移判定必须能由结构化字段复算')
  const hA = rA.text.split('\n')[0]
  assert.ok(hA.includes(`标定${CALIBRATION_RECORDS}条@${CALIBRATION_DATE}`),
    `远离标定点时表头必须回显标定点：${hA}`)
  assert.ok(hA.includes(`现值${rA.total}条`), `表头必须回显现值：${hA}`)
  assert.ok(hA.includes('建议重跑calibrate --write'), `表头必须给出重标建议：${hA}`)

  // ── 侧 B：200 条（|200−204|=4，相对 1.96%）⇒ 必不出现（避免「永远在喊」）──
  const homeB = freshHome('drift-near')
  seedPlainCorpus(homeB, 200)
  const rB = await tools().get('memory_recall').execute({ query: 'zzdrift', limit: 3 })
  assert.equal(rB.total, 200)
  assert.equal(rB.calibrationDriftExceeded, false)
  assert.equal(rB.calibrationDrift, 200 - CALIBRATION_RECORDS)
  const hB = rB.text.split('\n')[0]
  assert.ok(!hB.includes('建议重跑calibrate'), `接近标定点时表头不得出现重标建议：${hB}`)
  assert.ok(!hB.includes('现值'), `接近标定点时表头不得出现漂移段：${hB}`)
  assert.ok(hB.includes('L1:query='), '基表头仍在')

  // ── 反向：把阈值收紧到 0 ⇒ 侧 B 也必须报（证明阈值真的被读）────────────────
  const strict = await tools({ score: { calibrationDriftRel: 0, calibrationDriftAbs: 0 } })
    .get('memory_recall').execute({ query: 'zzdrift', limit: 3 })
  assert.equal(strict.calibrationDriftExceeded, true, '阈值 0 ⇒ 任何偏差都报（阈值确实生效）')
  assert.ok(strict.text.split('\n')[0].includes('建议重跑calibrate'), '阈值收紧后表头必须出现提示')

  // ── 注入行稳定性：漂移提示**只进 recall 表头，绝不进自动注入那行** ──────────
  const contexts = appliedContexts({ home: homeA })
  const contribution = contexts.get(INJECTION_CONTEXT_NAME)
  assert.ok(contribution !== undefined, '注入块必须仍注册')
  const injectText = typeof contribution.text === 'function' ? contribution.text({}) : contribution.text
  for (const bad of ['标定', '现值', '重跑calibrate', String(CALIBRATION_RECORDS) + '条@']) {
    assert.ok(!injectText.includes(bad), `注入行不得出现漂移提示片段「${bad}」：${injectText}`)
  }
})

test('内容量闸门：标定一致性（CONTENT_TOKEN_MIN=2 + GATE_MARGIN=2.0 + 标定注释可核对）', () => {
  assert.equal(CONTENT_TOKEN_MIN, 2)
  assert.equal(GATE_MARGIN, 2.0)
  const src = readFileSync(new URL('../src/pure.ts', import.meta.url), 'utf8')
  // 机器可读的落地行（格式别改）：与常数双向钉住
  const m = /CONTENT_TOKEN_MIN = (\d+)/.exec(src)
  assert.ok(m !== null, 'src/pure.ts 必须保留 CONTENT_TOKEN_MIN = <数字> 这一行')
  assert.equal(Number(m[1]), CONTENT_TOKEN_MIN)
  // 闸门例外倍数的机器可读锚点（本次新增）：改动必须与常数同源
  const gm = /闸门余量 GATE_MARGIN = ([0-9.]+)/.exec(src)
  assert.ok(gm !== null, 'src/pure.ts 必须保留「闸门余量 GATE_MARGIN = <数字>」这一机器可读行')
  assert.equal(Number(gm[1]), GATE_MARGIN)
  // 标定出处与反例必须留在注释里（防「只改数字、不留证据」）
  for (const frag of ['ok', '做', 'b', '虚拟屏', '快照', '好的', 'qTok', '204 条']) {
    assert.ok(src.includes(frag), `内容量闸门的标定注释必须保留可核对片段：${frag}`)
  }
  // 例外的标定依据必须写明两侧倍率（噪声贴线 / 真话题远超）
  for (const frag of ['adb', '4.35', '1.23', '待真实语料标定']) {
    assert.ok(src.includes(frag), `闸门例外的标定注释必须保留可核对片段：${frag}`)
  }
  assert.ok(src.includes('绝不整批否决'), '必须写明低内容量只封顶、不否决')
  assert.ok(src.includes('idf 阈值会**先误伤真话题再压噪声**') || src.includes('先误伤真话题再压噪声'),
    '必须写明为什么不用 idf 当闸门（否则后人会改回去）')
})
