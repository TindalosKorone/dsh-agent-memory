// 用例 I5：memory_recall 的 L1 表头「减肥」与一条结构性断言。
//
// 背景（本次要修的病）：旧表头 1049~1066 字符（本机实测，随查询与条数变化），而 RECALL_MAX_CHARS=2000
// ⇒ 每次实际只能显示 7~9 行；更糟的是旧表头把标度常数**本身**回显了两遍
// （score 公式里三处 + match 阈值两处），于是改 SCALE_A/SCALE_B/WEAK/STRONG 会连带改掉
// 「能显示几行」——上一次标定落地时 6 个既有测试红，
// 其中 5 个就是这个原因（被迫把「8 行」改成「6 行」、把夹具标题压短）。
//
// 本文件钉住三件事：
//   ① 表头只留「可复算所必需」的信息，且**常配短查询**下 <= 400 字符 —— 防减肥**减过头**（把复算依据删了）。
//      收尾对账后这一条还包含 ⑨ 多样性口径：final=(rel+graph)×多样性因子、因子只在候选 > 5 时
//      施加、且如实说明「开时 score 无法仅由打印的 rel/graph 复算」（旧表头只写 final=rel+graph，
//      等于向读者承诺 score 恒等于 disp(rel+graph)）；
//   ② 显示行数只由 limit 与行长决定，与标度常数（连它们的小数位长度）无关 —— 防表头**长回去**；
//   ③ （修正 1）表头的**总量上界** `HEADER_MAX_CHARS` 必须对**任意查询串**成立 —— 旧用例只覆盖
//      3 个短查询夹具（388~399），所以「<= 400」是一句**从未被最坏情况验过**的声明：表头回显
//      `query=` 时长随查询串线性增长（200 字符含边界字符实测 742、360 字符 932），而标度常数回显
//      宽度由配置决定（22 位小数就把固定部分顶到 413）。现在两条路径分别由 `formatHeaderQuery`
//      （按现算预算截断 + 如实标注）与 `formatHeaderConstant`（定宽回显，超宽 `≈` 标注近似）堵死，
//      由下面「最坏情况」两条用例钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HEADER_MAX_CHARS, HEADER_QUERY_TRUNCATION_MARK } from '../lib/index.js'
import { freshHome, tools } from './helpers.mjs'

test('I5 表头自检：单行、<= 400 字符，且可复算信息一个都不少', async () => {
  const home = freshHome('header-selfcheck')
  const defs = tools()
  const remember = defs.get('memory_remember')
  const recall = defs.get('memory_recall')
  for (let i = 0; i < 3; i += 1) {
    const w = await remember.execute({
      kind: 'fact', title: `alpha beta note ${i}`, body: `alpha beta details ${i}`,
      tags: ['alpha', 'beta'], source: 'test:header',
    })
    assert.equal(w.ok, true)
  }

  const r = await recall.execute({ query: 'alpha', limit: 5 })
  const header = r.text.split('\n')[0]
  assert.ok(r.shown > 0, '至少召回一条，否则表头断言没有说服力')
  assert.ok(!header.includes('\n'), '表头必须单行（分诊/I3 字段不得换行）')
  assert.ok(header.length <= 400, `表头必须 <= 400 字符（旧表头实测 1049~1066），实际 ${header.length}：${header}`)

  // ① 列序：10 列的名字与顺序（行按 " | " 切片读列，列序本身就是契约）
  assert.ok(header.includes('列序:id|kind|title|tags|graph|via|rel|cov|match|score'),
    `表头必须写明 10 列的名字与顺序：${header}`)
  // ② rel = BM25 原始相关度，且是 match 的判定依据
  assert.ok(header.includes('rel=BM25原始相关度'), `表头必须写明 rel 的语义：${header}`)
  assert.ok(header.includes('match 依据'), `表头必须写明 rel 是 match 的判定依据：${header}`)
  // ③ match 的两个阈值数字
  assert.ok(header.includes(String(r.weakThreshold)) && header.includes(String(r.strongThreshold)),
    `表头必须回显两个 match 阈值（weak=${r.weakThreshold} strong=${r.strongThreshold}）：${header}`)
  assert.match(header, /rel>=[0-9.]+ weak、>=[0-9.]+ strong/, '表头必须写明阈值与判定的对应关系')
  // ④ score=disp(final) 的公式与两个标度常数
  assert.ok(header.includes('score=disp(final)=clip((final-'), `表头必须写明展示分公式：${header}`)
  assert.ok(header.includes(String(r.scaleA)) && header.includes(String(r.scaleB)),
    `表头必须回显两个标度常数（scaleA=${r.scaleA} scaleB=${r.scaleB}）：${header}`)
  // ⑤ limit 是硬显示上限
  assert.ok(header.includes(`limit=${r.limit} 是硬显示上限`), `表头必须写明 limit 是硬显示上限：${header}`)
  // ⑥ I2 分诊的结论性数字：novelty、阈值、expanded、kBase->kUsed
  assert.match(header, /I2:novelty=[0-9]+\.[0-9]{4} (<|>=) 阈值 [0-9.]+/, `表头必须回显 novelty 与阈值：${header}`)
  assert.ok(header.includes(`expanded=${r.expanded}`), `表头必须回显 expanded=${r.expanded}：${header}`)
  assert.ok(header.includes(`kBase=${r.kBase} -> kUsed=${r.kUsed}`),
    `表头必须回显 kBase/kUsed（${r.kBase} -> ${r.kUsed}）：${header}`)
  // ⑦ 低置信标记：cov_max 与激活阈值
  assert.match(header, /低置信:cov_max=[0-9]+\.[0-9]{4} (<|>=) [0-9.]+/, `表头必须回显 cov_max 与激活阈值：${header}`)
  assert.ok(header.includes(String(r.activationThreshold)), `激活阈值 ${r.activationThreshold} 必须在表头里`)
  // ⑧ I3 图的结论性数字：final=rel+graph、graph 硬上限、图规模、枢纽被压数量、reachable
  assert.ok(header.includes('I3:final=rel+graph'), `表头必须写明 final=rel+graph：${header}`)
  assert.ok(header.includes(`graph硬上限<=${r.graphBonusCap}`),
    `表头必须写明 graph 硬上限 ${r.graphBonusCap}：${header}`)
  assert.match(header, /图[0-9]+节点\/[0-9]+边/, `表头必须回显图规模：${header}`)
  assert.ok(header.includes('枢纽被压'), `表头必须回显枢纽被压数量：${header}`)
  assert.ok(header.includes(`reachable=${r.reachable}`), `表头必须回显 reachable：${header}`)
  // ⑨ 多样性（本次对账补上）：final=(rel+graph)×多样性因子、因子只在候选 > 5 时施加，
  //    且必须如实说明「多样性开时 score 无法仅由打印的 rel/graph 复算」——旧表头只写
  //    final=rel+graph，等于向读者承诺 score 恒等于 disp(rel+graph)（判红点：改回旧句 ⇒ 本条变红）。
  assert.ok(header.includes('final=rel+graph×多样性'),
    `表头必须写明 final=(rel+graph)×多样性因子：${header}`)
  assert.ok(header.includes('候选>5时启用'),
    `表头必须写明多样性只在候选 > 5 时施加：${header}`)
  assert.ok(header.includes('开时不可由 rel/graph 复算'),
    `表头必须如实说明"多样性开时 score 不能仅由 rel/graph 复算"：${header}`)
  // match 的恒可复算同样必须在表头（判红点：删掉 (恒可复算) ⇒ 本条变红）
  assert.ok(header.includes('否则 none(恒可复算)'),
    `表头必须写明 match 恒可由 rel + 阈值复算：${header}`)

  // 反向（防回涨）：非结论性诊断不得再占表头字符预算——它们仍逐字在结构化返回字段/rows 里。
  for (const gone of ['basisSize=', 'layers=', 'logicalDepth=', 'explainedRatio=', 'residualRatio=',
    'maxHops=', 'maxStates=', 'maxFieldNeighbors=', 'gamma=', 'rho=', 'beta=']) {
    assert.ok(!header.includes(gone), `表头不该再出现「${gone}」（应只在结构化字段里）：${header}`)
  }

  // 无词元能量分支（‖q‖²≈0）同样要如实、同样要短
  const e = await recall.execute({ query: '   ', limit: 5 })
  const eh = e.text.split('\n')[0]
  assert.ok(eh.length <= 400, `未分诊分支的表头也必须 <= 400 字符，实际 ${eh.length}：${eh}`)
  assert.ok(eh.includes('未分诊'), `未分诊分支必须如实写明：${eh}`)
  assert.ok(eh.includes('expanded=false'), `未分诊分支必须回显 expanded=false：${eh}`)
  assert.ok(eh.includes('0/0'), `未分诊分支必须如实说明比值未定义（0/0）：${eh}`)
  assert.match(eh, /kBase=[0-9]+ -> kUsed=[0-9]+/, '未分诊分支仍须打印 kBase/kUsed')
})

test('I5 结构性断言：标度常数不得影响显示行数（判红点：表头回显常数的长度会改行数）', async () => {
  const home = freshHome('header-scale')
  const defs = tools()
  const remember = defs.get('memory_remember')

  // 夹具：24 条**同形**记录（同标题、同正文、同标签）⇒ 每一行打印长度完全相同；
  // 查询命中标题与正文 ⇒ 每行 rel 相同、match 同级、score 同宽度。
  // 标题长度 50（行长 = 143）是**量出来的**：一行占 144 个字符，表头差一个字符就可能跨过行边界，
  // 所以夹具既要给新短表头留足余量，又要让旧长表头下的常数差正好跨过行边界（判红点才看得见）。
  // 本次实测：新表头四组 398/387/399/412 字符 ⇒ 都恰好 10 行（余量 86~111、距下一行 33~58）；
  // 旧长表头四组 1077/1066/1078/1091 字符 ⇒ 5/6/5/5 行（两组标准标度配置差 11 个字符就少一行）。
  const TITLE = `alpha dark theme note ${'q'.repeat(28)}`
  assert.equal(TITLE.length, 50)
  for (let i = 0; i < 24; i += 1) {
    const w = await remember.execute({
      kind: 'fact', title: TITLE, body: 'alpha dark theme body', tags: ['k1', 'k2'], source: 'test:header',
    })
    assert.equal(w.ok, true)
  }

  // 关掉图传播：图到达的行 via 是 `tag:x`（比 `direct` 长），会让行长不齐——本用例比的是「能放几行」。
  const base = { graph: { maxHops: 0 } }
  const CONFIGS = [
    ['默认标度 0.0187/0.342/0.0363/0.1476', base],
    ['scaleA=0/scaleB=0.45/weak=0.06/strong=0.16', { ...base, score: { scaleA: 0, scaleB: 0.45, weak: 0.06, strong: 0.16 } }],
    ['scaleB=1.2345', { ...base, score: { scaleA: 0.0187, scaleB: 1.2345, weak: 0.0363, strong: 0.1476 } }],
    ['scaleB 回显 17 位小数', { ...base, score: { scaleA: 0.0187, scaleB: 0.12345678901234568, weak: 0.0363, strong: 0.1476 } }],
  ]

  const runs = []
  for (const [label, cfg] of CONFIGS) {
    const r = await tools(cfg).get('memory_recall').execute({ query: 'alpha dark theme', limit: 20 })
    // 夹具自检：必须真的撞上字符预算，否则「行数相等」是空转（20 条候选全放得下就没有区分力）
    assert.equal(r.truncated, true, `${label}: 夹具必须真的撞上 RECALL_MAX_CHARS 字符预算`)
    assert.ok(r.shown < 20, `${label}: 必须真的发生了截断`)
    // 夹具自检：每行等长，否则「行数」由行长序列决定，量出来的差不能归因于表头
    const lineLens = new Set(r.lines.map((line) => line.length))
    assert.equal(lineLens.size, 1, `${label}: 夹具每行必须等长，实际 ${[...lineLens].join(',')}`)
    assert.equal(r.rows.length, r.shown)
    runs.push({ label, scaleA: r.scaleA, scaleB: r.scaleB, shown: r.shown, truncated: r.truncated, rowLen: r.lines[0].length, header: r.text.split('\n')[0], last: r.lines[r.lines.length - 1] })
  }

  // 区分力自检（防假绿）：标度配置必须真的被吃进去，并且真的打印出不同的 score 列。
  // 若配置没生效，两次运行的行文本会逐字相同，「shown 相等」就变成了废话。
  assert.equal(runs[0].scaleA, 0.0187)
  assert.equal(runs[1].scaleA, 0)
  assert.equal(runs[3].scaleB, 0.12345678901234568)
  assert.notEqual(runs[0].last, runs[1].last, '两组标度必须真的打印出不同的 score 列（配置得生效）')

  // 表头确实回显了宽度不同的常数（长度差存在）——否则本断言失去意义（等于在比同一个表头）
  const headerLens = new Set(runs.map((x) => x.header.length))
  assert.ok(headerLens.size > 1,
    `四组表头长度本应随常数回显宽度而不同，实际 ${[...headerLens].join(',')}；若全相同说明表头不再回显常数`)

  // 判据本体：显示行数与 truncated 状态**完全相等**，与标度常数无关。
  const showns = runs.map((x) => x.shown)
  assert.equal(new Set(showns).size, 1,
    `显示行数必须与标度常数无关：${runs.map((x) => `${x.label} => shown=${x.shown}`).join(' / ')}`)
  assert.equal(new Set(runs.map((x) => x.truncated)).size, 1, 'truncated 状态必须一致')
  assert.equal(new Set(runs.map((x) => x.rowLen)).size, 1, '四组的行长必须相同（夹具等长）')

  // 行预算守卫：表头减肥后本夹具能放 10 行（旧长表头下只有 5~6 行）。
  // 表头一旦长回去（例如又把 basisSize/守恒式/图上限塞回来），这条会先红。
  assert.ok(runs[0].shown >= 10, `表头 <= 400 字符时本夹具必须至少放得下 10 行，实际 ${runs[0].shown}`)
})

// ── 修正 1：总量上界必须对**任意查询串**成立 ─────────────────────────────────────
//
// 旧用例的病根：只量了 3 个短查询（388~399）就宣称「<= 400」。这是「用方便的夹具证明一个界」，
// 而表头的长度输入里恰恰有一个**无界**的量 —— 回显的查询串本身。
// 本条用例把那个无界量拉到最坏：>=200 字符、且每类边界字符都命中（引号 / 反斜杠 / 换行 / 制表 / NUL）。
// 判红点：把 `formatHeaderQuery` 里的截断去掉（直接 `JSON.stringify(query)`）⇒ 下面前两条断言变红。

test('修正 1 最坏情况：>=200 字符且含换行/引号/反斜杠/控制字符的查询下，表头仍 <= HEADER_MAX_CHARS、单行、且截断被如实标注', async () => {
  freshHome('header-worst-query')
  const defs = tools()
  const remember = defs.get('memory_remember')
  const recall = defs.get('memory_recall')
  for (let i = 0; i < 3; i += 1) {
    const w = await remember.execute({
      kind: 'fact', title: `alpha beta note ${i}`, body: `alpha beta details ${i}`,
      tags: ['alpha', 'beta'], source: 'test:header',
    })
    assert.equal(w.ok, true)
  }

  // 每段 6 个字符：`x` `"` `\` 换行 制表 NUL —— 转义后分别是 1/2/2/2/2/6 个字符，
  // 既覆盖「两字符转义」也覆盖「`\u00XX` 六字符转义」（后者是最坏膨胀来源）。
  const LONG = 'x"\\\n\t\u0000'.repeat(40)
  assert.equal(LONG.length, 240, '夹具必须是 240 字符（>=200）')
  assert.ok(LONG.length >= 200, '夹具查询必须 >= 200 字符，否则不算最坏情况')

  const r = await recall.execute({ query: LONG, limit: 5 })
  const header = r.text.split('\n')[0]

  // ① 总量上界（判红点：去掉截断 ⇒ 这里从 447 涨到 ~1500 变红）
  assert.ok(header.length <= HEADER_MAX_CHARS,
    `表头必须 <= HEADER_MAX_CHARS=${HEADER_MAX_CHARS}，实际 ${header.length}：${header}`)
  // ② 单行（换行/回车都被 JSON 转义，不可能留下裸换行）
  assert.ok(!header.includes('\n'), `表头必须单行：${JSON.stringify(header)}`)
  assert.ok(!header.includes('\r'), `表头不得含回车：${JSON.stringify(header)}`)
  // ③ 截断必须被**如实标注**（不能悄悄截了不吭声）
  assert.ok(header.includes(HEADER_QUERY_TRUNCATION_MARK),
    `超长查询被截断时必须打印 ${HEADER_QUERY_TRUNCATION_MARK}：${header}`)

  // ④ 转义序列没有被切断：回显必须是**合法**的 JSON 字符串字面量（切断了 JSON.parse 会抛），
  //    且解码后确实是「原查询的一个前缀 + 截断标记」（语义没被改、没有半截 `\u00` 之类）。
  const m = /^L1:query=("(?:[^"\\]|\\.)*")/.exec(header)
  assert.ok(m !== null, `表头必须以合法的 JSON 字符串字面量回显 query：${header}`)
  const decoded = JSON.parse(m[1])
  assert.ok(decoded.endsWith(HEADER_QUERY_TRUNCATION_MARK),
    `被截断的回显必须以截断标记结尾：${JSON.stringify(decoded)}`)
  const prefix = decoded.slice(0, decoded.length - HEADER_QUERY_TRUNCATION_MARK.length)
  assert.ok(LONG.startsWith(prefix),
    `回显必须是原查询的真前缀（先截断原始串再转义 ⇒ 绝不切断转义序列）：${JSON.stringify(prefix)}`)
  // ⑤ 完整查询串一个字符都没丢：仍在结构化字段上
  assert.equal(r.query, LONG, '完整查询串必须原样在结构化字段 query 上')

  // ⑥ 短查询不该被无谓地截断（只有超长才标注）
  const short = await recall.execute({ query: 'alpha', limit: 5 })
  const shortHeader = short.text.split('\n')[0]
  assert.ok(!shortHeader.includes(HEADER_QUERY_TRUNCATION_MARK),
    `短查询不应出现截断标记：${shortHeader}`)
  assert.ok(shortHeader.includes('L1:query="alpha"'), `短查询应被完整回显：${shortHeader}`)
})

test('修正 1 最坏情况（固定部分）：标度常数回显宽度与库规模统计不能把表头顶过 HEADER_MAX_CHARS', async () => {
  freshHome('header-worst-fixed')
  const defs = tools()
  const remember = defs.get('memory_remember')
  // 60 条同形记录 ⇒ 让「候选/图规模/reachable/枢纽被压」这些统计位宽>1，
  // 固定部分不是最窄的那种夹具（避免又用方便夹具证明一个界）。
  for (let i = 0; i < 60; i += 1) {
    const w = await remember.execute({
      kind: 'fact', title: `alpha dark theme note ${i}`, body: 'alpha dark theme body',
      tags: ['alpha', 'beta'], source: 'test:header',
    })
    assert.equal(w.ok, true)
  }
  // 常数配置取到**最宽的可能**：22 位小数（旧用例的宽度探针）与 Number.MAX_VALUE（JS 数字的最长形态）。
  const CONFIGS = [
    ['默认标度', {}],
    ['22 位小数 scaleB', { score: { scaleA: 0.0187, scaleB: 0.12345678901234568, weak: 0.0363, strong: 0.1476 } }],
    ['scaleA/scaleB = Number.MAX_VALUE', { score: { scaleA: Number.MAX_VALUE, scaleB: Number.MAX_VALUE, weak: 0.12345678901234568, strong: 0.1476 } }],
    ['负数极值', { score: { scaleA: -Number.MAX_VALUE, scaleB: -Number.MAX_VALUE, weak: 0.0363, strong: 0.1476 } }],
  ]
  const queries = [
    ['短查询 alpha', 'alpha'],
    ['超长边界查询', 'x"\\\n\t\u0000'.repeat(40)],
  ]
  for (const [label, cfg] of CONFIGS) {
    const recall = tools(cfg).get('memory_recall')
    for (const [qlabel, q] of queries) {
      const r = await recall.execute({ query: q, limit: 5 })
      const header = r.text.split('\n')[0]
      assert.ok(header.length <= HEADER_MAX_CHARS,
        `${label} / ${qlabel}：表头必须 <= ${HEADER_MAX_CHARS}，实际 ${header.length}：${header}`)
      assert.ok(!header.includes('\n'), `${label} / ${qlabel}：表头必须单行`)
    }
    // 结构化的常数始终是**精确值**（定宽回显只影响表头文字，精确值没有丢）。
    const r0 = await tools(cfg).get('memory_recall').execute({ query: 'alpha', limit: 5 })
    assert.equal(r0.scaleB, cfg.score?.scaleB ?? r0.scaleB, `${label}：结构化 scaleB 必须是精确值`)
  }
})

