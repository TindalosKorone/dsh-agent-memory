#!/usr/bin/env node
/**
 * I2 附带：离线标定脚本（**只打印建议，绝不改写任何配置/源码**）。
 *
 * 它读**真实记忆库**（`${DSH_HOME ?? 默认}/agent-memory/memory.ndjson`），用
 *   正样本查询 = 每条记录自己的标题 / 前 3 个标签（命中已知记录）
 *   负样本查询 = 一组与库无关的查询（含中文与英文），每个取「该查询在库内的最高分」
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
 * 用法：
 *   node scripts/calibrate.mjs                 # 用 DSH_HOME（未设则回落默认 home）
 *   node scripts/calibrate.mjs --home /path     # 显式指定 home
 *
 * 退出码：0 = 正常（含「库为空」这种可读提示）；1 = 前置条件不满足（lib 未构建 / 文件不可读）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ARGV = process.argv.slice(2)
const homeFlagIdx = ARGV.indexOf('--home')
const HOME = homeFlagIdx >= 0 && ARGV[homeFlagIdx + 1] !== undefined
  ? ARGV[homeFlagIdx + 1]
  : (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : undefined)

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
  printSuggestion(undefined)
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
  printSuggestion(undefined)
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

// 负样本：与库无关的查询，每个取「该查询在库内的最高分」（= 误伤的危险水位）
const negatives = []
const negativeQueries = [
  '今天天气怎么样',
  '今晚吃什么比较好',
  'quantum chromodynamics lecture notes',
  'how to bake sourdough bread',
  'unrelated filler words only',
  'zzqq xxvv nonexistent-token',
]
for (let i = 0; i < 6; i += 1) negativeQueries.push(`zz${i}q-nonexistent-token-${i}`)
const negativeDetail = []
for (const query of negativeQueries) {
  let max = 0
  for (const rec of records) {
    const score = pure.bm25Relevance(query, rec, stats)
    if (Number.isFinite(score) && score > max) max = score
  }
  negatives.push(max)
  negativeDetail.push({ query, max })
}

positives.sort((a, b) => a - b)
negatives.sort((a, b) => a - b)

console.log('\n样本：')
console.log(`- 正样本 ${positives.length} 个（每条记录的标题 + 前 3 个标签各一次查询，对自身打分）`)
console.log(`  p10=${fmt(percentile(positives, 0.1))} p50=${fmt(percentile(positives, 0.5))} `
  + `p90=${fmt(percentile(positives, 0.9))} p95=${fmt(percentile(positives, 0.95))} max=${fmt(positives[positives.length - 1])}`)
console.log(`- 负样本 ${negatives.length} 个（每个无关查询取库内最高分）`)
console.log(`  p10=${fmt(percentile(negatives, 0.1))} p50=${fmt(percentile(negatives, 0.5))} `
  + `p90=${fmt(percentile(negatives, 0.9))} p95=${fmt(percentile(negatives, 0.95))} max=${fmt(negatives[negatives.length - 1])}`)
console.log('- 负样本明细（该查询在库内的最高分）：')
for (const d of negativeDetail) console.log(`    ${fmt(d.max)}  <=  ${JSON.stringify(d.query)}`)

const p50neg = percentile(negatives, 0.5)
const p95neg = percentile(negatives, 0.95)
const p95pos = percentile(positives, 0.95)
const p10pos = percentile(positives, 0.1)

printCurrentDefaults()
printSuggestion({
  scaleA: p50neg,
  scaleB: p95pos,
  weak: p95neg,
  strong: p10pos,
})

function printCurrentDefaults() {
  console.log('\n当前口径（src/pure.ts 的模块级默认常数）：')
  console.log(`- SCALE_A = ${pure.SCALE_A}`)
  console.log(`- SCALE_B = ${pure.SCALE_B}`)
  console.log(`- WEAK_THRESHOLD = ${pure.WEAK_THRESHOLD}`)
  console.log(`- STRONG_THRESHOLD = ${pure.STRONG_THRESHOLD}`)
  console.log(`- （分诊阈值不由本脚本标定：NOVELTY_THRESHOLD=${pure.DEFAULT_NOVELTY_THRESHOLD}、`
    + `ACTIVATION_THRESHOLD=${pure.DEFAULT_ACTIVATION_THRESHOLD} 是门控行为量，不是分数标度）`)
}

function printSuggestion(s, note) {
  console.log('\n建议（本脚本只打印，不会改写任何配置或源码）：')
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
