#!/usr/bin/env node
/**
 * I2 附带：离线标定脚本（**只打印建议，绝不改写任何配置/源码**）。
 *
 * 它读**真实记忆库**（`${DSH_HOME ?? 默认}/agent-memory/memory.ndjson`），用
 *   正样本查询 = 每条记录自己的标题 / 前 3 个标签（命中已知记录）
 *   负样本查询 = 一组与库无关的查询（中英混排的**冻结跨域词表**组合而成，见 scripts/negative-samples.mjs），
 *                每个取「该查询在库内的最高分」
 * 分别算分位数，然后打印建议的绝对标度与判定阈值：
 *   SCALE_A = p50(负样本)          —— 噪声地板（低于它展示分为 0）
 *   SCALE_B = p95(正样本)          —— 真命中的高分位（映射到 1.0000）
 *   WEAK    = p95(负样本)          —— 噪声上界（弱证据应从噪声之上开始）
 *   STRONG  = p10(正样本)          —— 真命中的低分位（九成真命中应判 strong）
 *
 * 为什么这么取分位数：SCALE_A / SCALE_B 是**绝对区间**（disp = clip((raw−A)/(B−A))），
 * 只有让「无关查询」整体落在 A 附近、让「真命中」接近 B，展示分才有绝对含义
 * （I1.2 第三方审计：任何批内归一化都会让无关查询的 Top1 变成 1.0000）。
 *
 * I2.2（本增量）负样本扩容与敏感性对照：
 *  - 旧版只有 12 个手写负样本，而 SCALE_A（p50 负样本）与 WEAK（p95 负样本）**完全**建立在这 12 个上，
 *    分位数在 12 个样本上不可信。现在负样本扩到 ≥200 个，构词来自冻结的跨域词表（与库内主题无关、
 *    不取库内容、无随机数 ⇒ 同一份库两次运行逐字节一致）。
 *  - 报告里**并列**打印两套建议：「只取前 12 个」（= 旧脚本口径，12 个就是旧脚本那 12 个）与
 *    「全部 ≥200 个」，让读者直接看到小样本估计有多飘。
 *
 * 用法：
 *   node scripts/calibrate.mjs                    # 用 DSH_HOME（未设则回落默认 home）
 *   node scripts/calibrate.mjs --home /path       # 显式指定 home
 *   node scripts/calibrate.mjs --dump-negatives   # 额外逐条打印全部负样本查询与其最高分
 *
 * 退出码：0 = 正常（含「库为空」这种可读提示）；1 = 前置条件不满足（lib 未构建 / 文件不可读）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NEGATIVE_HEAD, buildNegativeQueries } from './negative-samples.mjs'

const ARGV = process.argv.slice(2)
const homeFlagIdx = ARGV.indexOf('--home')
const HOME = homeFlagIdx >= 0 && ARGV[homeFlagIdx + 1] !== undefined
  ? ARGV[homeFlagIdx + 1]
  : (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : undefined)
const DUMP_NEGATIVES = ARGV.includes('--dump-negatives')

/** 敏感性对照的头部样本量：固定 12 = 旧脚本的样本量（NEGATIVE_HEAD 的长度）。 */
const SENSITIVITY_HEAD = NEGATIVE_HEAD.length
/** 全域「噪音泄漏最重」的明细条数（只打印，不影响任何统计）。 */
const LEAK_TOP = 10

// ── 读库 ────────────────────────────────────────────────────────────────────

let pure
let store
let protocol
try {
  pure = await import('../lib/pure.js')
  store = await import('../lib/store.js')
  protocol = await import('../lib/protocol.js')
} catch (err) {
  console.error('无法加载 lib/：请先在插件目录执行 `node node_modules/typescript/bin/tsc -p .`。')
  console.error(`- 原始错误：${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

const resolvedHome = HOME ?? store.resolveHome()
const file = join(resolvedHome, store.MEMORY_SUBDIR, store.MEMORY_FILE)

console.log('I2 离线标定（残差金字塔分诊的附带工具；本脚本只打印建议，不写任何文件）')
console.log(`- 记忆库：${file}`)
console.log(`- DSH_HOME：${HOME === undefined ? '(未显式指定，用默认/环境变量)' : HOME}`)

if (!existsSync(file)) {
  console.log('\n[提示] 该文件不存在：当前没有可标定的记忆库。')
  console.log('- 这不算错误：先用 memory_remember 写入一些记忆，再重跑本脚本。')
  printCurrentDefaults()
  printSuggestion(undefined, '建议')
  process.exit(0)
}

const raw = readFileSync(file, 'utf8')
const records = []
let badLines = 0
for (const line of raw.split('\n')) {
  if (line.trim() === '') continue
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    badLines += 1
    continue
  }
  const rec = protocol.normalizeStoredRecord(parsed)
  if (rec === undefined) badLines += 1
  else records.push(rec)
}
console.log(`- 库内有效记录：${records.length} 条${badLines > 0 ? `（另有 ${badLines} 行不可用，已跳过）` : ''}`)

if (records.length === 0) {
  console.log('\n[提示] 记忆库为空：没有任何可用的正样本查询，无法标定。')
  console.log('- 这不算错误：先写入若干条记忆（memory_remember）再重跑本脚本。')
  printCurrentDefaults()
  printSuggestion(undefined, '建议')
  process.exit(0)
}

// ── 采样 ────────────────────────────────────────────────────────────────────

const stats = pure.corpusStats(records)

/** 线性插值分位数（numpy 口径）；样本为空返回 undefined。 */
function percentile(sorted, q) {
  if (sorted.length === 0) return undefined
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

const fmt = (v) => (v === undefined ? 'n/a' : v.toFixed(4))
const asc = (a, b) => a - b

// 正样本：标题 + 前 3 个标签各作一次查询，取「这条记录自己」的 BM25 原始分
const positives = []
for (const rec of records) {
  const probes = [rec.title]
  const tags = pure.normalizedTags(rec.tags)
  if (tags.length > 0) probes.push(tags.slice(0, 3).join(' '))
  for (const probe of probes) {
    const score = pure.bm25Relevance(probe, rec, stats)
    if (Number.isFinite(score)) positives.push(score)
  }
}

// 负样本：与库无关的查询（头部 12 个 = 旧脚本原样保留，其余由冻结跨域词表确定性组合），
// 每个取「该查询在库内的最高分」（= 误伤的危险水位）。
const negativeQueries = buildNegativeQueries()
const negativeDetail = []
for (const query of negativeQueries) {
  let max = 0
  for (const rec of records) {
    const score = pure.bm25Relevance(query, rec, stats)
    if (Number.isFinite(score) && score > max) max = score
  }
  negativeDetail.push({ query, max })
}

positives.sort(asc)
const negatives = negativeDetail.map((d) => d.max).sort(asc)
/** 敏感性对照 A：前 12 个查询（= 旧脚本口径）的分数，独立排序。 */
const headNegatives = negativeDetail.slice(0, SENSITIVITY_HEAD).map((d) => d.max).sort(asc)

console.log('\n样本：')
console.log(`- 正样本 ${positives.length} 个（每条记录的标题 + 前 3 个标签各一次查询，对自身打分）`)
console.log(`  p10=${fmt(percentile(positives, 0.1))} p50=${fmt(percentile(positives, 0.5))} `
  + `p90=${fmt(percentile(positives, 0.9))} p95=${fmt(percentile(positives, 0.95))} max=${fmt(positives[positives.length - 1])}`)
console.log(`- 负样本 ${negatives.length} 个（每个无关查询取库内最高分；中英混排，来自冻结跨域词表，与库内容无关）`)
console.log(`  p10=${fmt(percentile(negatives, 0.1))} p50=${fmt(percentile(negatives, 0.5))} `
  + `p90=${fmt(percentile(negatives, 0.9))} p95=${fmt(percentile(negatives, 0.95))} `
  + `p99=${fmt(percentile(negatives, 0.99))} max=${fmt(negatives[negatives.length - 1])}`)
console.log(`- 负样本子集 A（前 ${SENSITIVITY_HEAD} 个 = 旧脚本口径）${headNegatives.length} 个`)
console.log(`  p10=${fmt(percentile(headNegatives, 0.1))} p50=${fmt(percentile(headNegatives, 0.5))} `
  + `p90=${fmt(percentile(headNegatives, 0.9))} p95=${fmt(percentile(headNegatives, 0.95))} max=${fmt(headNegatives[headNegatives.length - 1])}`)
console.log(`- 负样本构词：${negativeQueries.length} 个查询 = ${SENSITIVITY_HEAD} 个固定头部`
  + ` + ${negativeQueries.length - SENSITIVITY_HEAD} 个跨域词表组合（确定性；两次运行逐字节一致）`)

// 敏感性对照：同一批查询只换样本量 ⇒ SCALE_A / WEAK 会飘多少
const p50Head = percentile(headNegatives, 0.5)
const p95Head = percentile(headNegatives, 0.95)
const p50All = percentile(negatives, 0.5)
const p95All = percentile(negatives, 0.95)
console.log('\n敏感性对照（同一批查询，只换样本量；漂移只出现在负样本侧 ⇒ SCALE_A / WEAK）：')
console.log(`  样本量 ${SENSITIVITY_HEAD} 个：p50=${fmt(p50Head)}  p95=${fmt(p95Head)}  max=${fmt(headNegatives[headNegatives.length - 1])}`)
console.log(`  样本量 ${negatives.length} 个：p50=${fmt(p50All)}  p95=${fmt(p95All)}  max=${fmt(negatives[negatives.length - 1])}`)
console.log(`  差值：p50 ${fmt(p50Head)} -> ${fmt(p50All)}（SCALE_A），p95 ${fmt(p95Head)} -> ${fmt(p95All)}（WEAK）`)

console.log(`- 负样本明细 A（前 ${SENSITIVITY_HEAD} 个，与旧脚本逐条可比）：`)
for (const d of negativeDetail.slice(0, SENSITIVITY_HEAD)) console.log(`    ${fmt(d.max)}  <=  ${JSON.stringify(d.query)}`)
const leaks = [...negativeDetail].sort((a, b) => (b.max - a.max) || (a.query < b.query ? -1 : a.query > b.query ? 1 : 0)).slice(0, LEAK_TOP)
console.log(`- 全域噪音泄漏最重的前 ${leaks.length} 个（库内最高分降序 → 查询码元升序决胜）：`)
for (const d of leaks) console.log(`    ${fmt(d.max)}  <=  ${JSON.stringify(d.query)}`)
if (DUMP_NEGATIVES) {
  console.log(`- 全部 ${negativeDetail.length} 个负样本明细（--dump-negatives；顺序 = 生成顺序，确定性）：`)
  for (const d of negativeDetail) console.log(`    ${fmt(d.max)}  <=  ${JSON.stringify(d.query)}`)
}

printCurrentDefaults()
// 两套建议并列：A = 只取前 12 个（旧口径），B = 全部负样本（本脚本采用）
printSuggestion({
  scaleA: p50Head,
  scaleB: percentile(positives, 0.95),
  weak: p95Head,
  strong: percentile(positives, 0.1),
}, `敏感性对照 A：只取前 ${SENSITIVITY_HEAD} 个负样本（= 旧脚本口径，样本量太小，仅作对照）`)
printSuggestion({
  scaleA: p50All,
  scaleB: percentile(positives, 0.95),
  weak: p95All,
  strong: percentile(positives, 0.1),
}, `建议 B（本脚本采用：全部 ${negatives.length} 个负样本）`)

function printCurrentDefaults() {
  console.log('\n当前口径（src/pure.ts 的模块级默认常数）：')
  console.log(`- SCALE_A = ${pure.SCALE_A}`)
  console.log(`- SCALE_B = ${pure.SCALE_B}`)
  console.log(`- WEAK_THRESHOLD = ${pure.WEAK_THRESHOLD}`)
  console.log(`- STRONG_THRESHOLD = ${pure.STRONG_THRESHOLD}`)
  console.log('- 边界说明：**分诊阈值（novelty）与图系数不由本脚本标定** —— '
    + `NOVELTY_THRESHOLD=${pure.DEFAULT_NOVELTY_THRESHOLD}、ACTIVATION_THRESHOLD=${pure.DEFAULT_ACTIVATION_THRESHOLD} `
    + '是门控行为量不是分数标度，I3 的 lambda/outBudget/hubEta/decay 等图系数同理；本脚本只给 BM25 标度与判定阈值。')
}

function printSuggestion(s, title) {
  console.log(`\n${title}（本脚本只打印，不会改写任何配置或源码）：`)
  if (s === undefined) {
    console.log('- 样本不足，无法给出建议：请先让库里至少有若干条记忆，或稍后重跑。')
    return
  }
  const scaleA = s.scaleA ?? 0
  let scaleB = s.scaleB ?? pure.SCALE_B
  if (!(scaleB > scaleA)) {
    console.log(`- [警告] p95(正样本)=${fmt(scaleB)} 不大于 p50(负样本)=${fmt(scaleA)}：`
      + `区间退化，改用 SCALE_B = SCALE_A + ${pure.SCALE_B}；样本区分度不足，建议先补更多正样本。`)
    scaleB = scaleA + pure.SCALE_B
  }
  let weak = s.weak ?? pure.WEAK_THRESHOLD
  let strong = s.strong ?? pure.STRONG_THRESHOLD
  if (!(weak < strong)) {
    console.log(`- [警告] p95(负样本)=${fmt(weak)} 不小于 p10(正样本)=${fmt(strong)}：弱/强阈值倒挂，`
      + '建议保留当前默认阈值，或补充区分度更好的样本（正样本本身要更像真实查询）。')
    weak = pure.WEAK_THRESHOLD
    strong = pure.STRONG_THRESHOLD
  }
  console.log(`- SCALE_A = ${scaleA.toFixed(4)}   （p50(负样本)：噪声地板）`)
  console.log(`- SCALE_B = ${scaleB.toFixed(4)}   （p95(正样本)：真命中高分位）`)
  console.log(`- WEAK    = ${weak.toFixed(4)}   （p95(负样本)：噪声上界）`)
  console.log(`- STRONG  = ${strong.toFixed(4)}   （p10(正样本)：真命中低分位）`)
  console.log('- 落地位置：src/pure.ts 的 SCALE_A / SCALE_B / WEAK_THRESHOLD / STRONG_THRESHOLD'
    + '（或经工具配置 score.{scaleA,scaleB,weakThreshold,strongThreshold} 覆盖）。')
  console.log('- 注意：本脚本不替你改这些常数；改之前请先取 undo 快照。')
}
