// 修正 4 辅助（非测试，可复跑）：在合成语料里搜「目标记录的 rel 恰好落在某个常数新旧值之间」的夹具参数。
// 用途：为四个常数各找一条**能判红的边界夹具**（夹具 rel 落点写进 test/scoring.test.mjs）。
// 用法：node redproof/i7e-band-search.mjs
// 说明：rel = num/den，den 把**所有字段**（tags:3 / title:2 / body:1）的理论上界都算进去，
// 所以「查询词出现在哪些字段」是 rel 数量级的主控旋钮；字段组合 + df + tf + 正文长度一起扫。
import { corpusStats, lexicalScore } from '../lib/pure.js'

/** 目标记录把查询词放进 fields 子集；填充记录只带一个公共标签，保证 df 可控。 */
function build(N, df, fields, tf, pad, q = 'zzqterm') {
  const recs = []
  for (let i = 0; i < N; i += 1) {
    const isTarget = i === 0
    const hasQ = i < df
    const body = []
    if (hasQ && fields.body) for (let t = 0; t < (isTarget ? tf : 1); t += 1) body.push(q)
    for (let j = 0; j < pad; j += 1) body.push(`pad${j}`)
    recs.push({
      id: `r${i}`,
      title: hasQ && fields.title ? `${q} t${i}` : `t${i}`,
      body: body.join(' '),
      tags: hasQ && fields.tags ? [q, 'zzcommon'] : ['zzcommon'],
    })
  }
  return recs
}

// 四个常数的「新旧值之间」区间（旧值 -> 新值，2026-10-09 第二次标定）
const BANDS = {
  SCALE_A: [0.0187, 0.0199],
  SCALE_B: [0.3420, 0.3666],
  WEAK_THRESHOLD: [0.0363, 0.0382],
  STRONG_THRESHOLD: [0.1476, 0.1507],
}
const FIELDS = [
  { body: true },
  { title: true },
  { title: true, body: true },
  { tags: true },
  { tags: true, body: true },
  { tags: true, title: true, body: true },
]
const found = Object.fromEntries(Object.keys(BANDS).map((k) => [k, []]))
for (const N of [6, 8, 10, 12, 16, 20, 25, 30, 40, 50, 70, 100, 150, 200]) {
  for (const df of [1, 2, 3, 5, 8, 12, 20]) {
    if (df > N) continue
    for (const fields of FIELDS) {
      for (const tf of [1, 2, 3, 5, 8, 12]) {
        for (const pad of [0, 1, 2, 4, 8, 16, 32]) {
          const recs = build(N, df, fields, tf, pad)
          const rel = lexicalScore('zzqterm', recs[0], corpusStats(recs))
          for (const [name, [lo, hi]] of Object.entries(BANDS)) {
            if (rel > lo && rel < hi && found[name].length < 5) {
              found[name].push({
                N, df, tf, pad,
                fields: Object.keys(fields).filter((k) => fields[k]).join('+'),
                rel: Number(rel.toFixed(6)),
              })
            }
          }
        }
      }
    }
  }
}
for (const [k, v] of Object.entries(found)) {
  console.log(`--- ${k} (${BANDS[k].join(' , ')}) ---`)
  if (v.length === 0) console.log('  (未找到)')
  for (const x of v) console.log(`  N=${x.N} df=${x.df} fields=${x.fields} tf=${x.tf} pad=${x.pad} rel=${x.rel}`)
}
