import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { freshHome, memFile, tools } from '../test/helpers.mjs'
import { SCALE_A, SCALE_B, WEAK_THRESHOLD, STRONG_THRESHOLD } from '../lib/pure.js'

function seed(tag, N, df, fields, tf, pad) {
  const home = freshHome(`i7e-${tag}`)
  const lines = []
  for (let i = 0; i < N; i += 1) {
    const isTarget = i === 0
    const hasQ = i < df
    const bt = []
    if (hasQ && fields.body) for (let t = 0; t < (isTarget ? tf : 1); t += 1) bt.push('zzqterm')
    for (let j = 0; j < pad; j += 1) bt.push(`pad${j}`)
    lines.push(JSON.stringify({
      id: isTarget ? 'mem_band_target' : `mem_band_f${i}`,
      ts: 1_700_000_000_000 + i, kind: 'fact',
      title: hasQ && fields.title ? `zzqterm t${i}` : `t${i}`,
      body: bt.join(' '),
      tags: hasQ && fields.tags ? ['zzqterm', 'zzcommon'] : ['zzcommon'],
      source: 'test:i7e', hits: 0,
    }))
  }
  mkdirSync(dirname(memFile(home)), { recursive: true })
  writeFileSync(memFile(home), lines.join('\n') + '\n', 'utf8')
  return home
}
console.log(`现用: SCALE_A=${SCALE_A} SCALE_B=${SCALE_B} WEAK=${WEAK_THRESHOLD} STRONG=${STRONG_THRESHOLD}`)
const CASES = [
  ['SCALEA', 6, 5, { title: true }, 1, 1, [0.0187, 0.0199]],
  ['WEAK', 6, 3, { body: true }, 12, 1, [0.0363, 0.0382]],
  ['STRONG', 6, 2, { title: true, body: true }, 8, 16, [0.1476, 0.1507]],
  ['SCALEB', 6, 1, { tags: true, title: true, body: true }, 1, 4, [0.3420, 0.3666]],
]
for (const [tag, N, df, fields, tf, pad, band] of CASES) {
  seed(tag, N, df, fields, tf, pad)
  const r = await tools({ score: { diversityBeta: 0 }, graph: { maxHops: 0 } }).get('memory_recall').execute({ query: 'zzqterm', limit: 5 })
  const row = r.rows.find((x) => x.id === 'mem_band_target')
  console.log(`${tag}: rel=${row.rel} 在(${band[0]},${band[1]})=${row.rel > band[0] && row.rel < band[1]} match=${row.match} score=${row.score} shown=${r.shown}`)
}
