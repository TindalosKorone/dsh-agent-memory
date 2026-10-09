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
  BM25_B, BM25_K1, DEFAULT_DIVERSITY_BETA, FIELD_WEIGHTS, SCALE_A, SCALE_B, STRONG_THRESHOLD, WEAK_THRESHOLD,
  absoluteDisp, bm25Relevance, clamp01, corpusStats, diversify, fieldSat, idf, lexicalScore, logCompress,
  matchLevel, resolveScoreOptions, tagCoverage, tagWeight,
} from '../lib/pure.js'
import { freshHome, memFile, tools } from './helpers.mjs'

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
  // 表头已声明）。可验算的是「用打印的 rel 复现 match」，而不是两列相等。
  assert.equal(r.rows[0].match, matchLevel(r.rows[0].rel, r.weakThreshold, r.strongThreshold),
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
    // 的跨标度关系；改为断言「match 可由打印的 rel 复现」。
    assert.equal(row.match, matchLevel(row.rel, r.weakThreshold, r.strongThreshold),
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
      // 判据：打印的 rel（= BM25 原始分）与打印的阈值 must 复现打印的 match。
      assert.equal(row.match, matchLevel(row.rel, r.weakThreshold, r.strongThreshold),
        `query=${query} 行 ${row.id}：rel=${row.rel} 阈值=${r.weakThreshold}/${r.strongThreshold} 却判 ${row.match}`)
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
