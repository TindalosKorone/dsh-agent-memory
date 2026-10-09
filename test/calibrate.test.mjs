// 用例 15：I2.2 离线标定的**负样本扩容与敏感性对照**（只读脚本；本文件绝不碰真实记忆库）。
//
// 契约（全部可判红）：
//  1) 负样本 ≥200 个，且**确定性**：同一份库两次运行 stdout 逐字节一致；
//  2) 构词与语料无关：查询串只能由冻结的跨域词表 + 固定连接词组合而成（生成器零入参、零 IO），
//     头部 12 个就是旧脚本原样的那 12 个（否则「只取前 12 个」的对照就不是旧口径了）；
//  3) 报告必须给出负样本条数与分位数，并**并列**打印两套建议（前 12 个 vs 全部）；
//  4) 只打印、不改写：跑完库文件字节不变、DSH_HOME 目录里不多任何文件；
//  5) 空库 ⇒ 可读提示 + 退出码 0；
//  6) 边界说明照旧：分诊阈值（novelty）与图系数不由本脚本标定。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONNECTORS, CROSS_DOMAIN_VOCAB, NEGATIVE_HEAD, NEGATIVE_QUERY_TARGET,
  buildNegativeQueries, vocabularyTerms,
} from '../scripts/negative-samples.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = dirname(HERE)
const TMP_ROOT = join(PLUGIN_DIR, '.tmp-test')
const SCRIPT = join(PLUGIN_DIR, 'scripts', 'calibrate.mjs')

/** 建一个干净的临时 DSH_HOME（只写插件目录下的 .tmp-test）。 */
function freshDir(name) {
  const dir = join(TMP_ROOT, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 造一份小型合成库（与标定脚本的读法一致：NDJSON + 必需字段）。 */
function seedLibrary(home, count = 5) {
  const rows = []
  const topics = [
    ['render 是 defineTool 的死字段', '渲染属性放在 output 之外会被静默忽略，只有真正调用才抛', ['渲染', '死字段']],
    ['门禁失败关闭', '授权不足时必须拒写而不是静默降级成空值', ['门禁', '失败关闭']],
    ['改配置前先取快照', '快照能在改坏之后回滚，撤不掉的是聊天记录', ['快照', '回滚']],
    ['断言必须能判红', '不能判红的断言是假绿，绿灯没有证据力', ['假绿', '断言']],
    ['编译产物不入库', 'lib 由 tsc 生成，.gitignore 已排除', ['编译', '入库']],
  ]
  for (let i = 0; i < count; i += 1) {
    const t = topics[i % topics.length]
    rows.push({
      id: `mem_cal_${i}`, ts: 1_700_000_000_000 + i * 86_400_000, kind: 'lesson',
      title: `${t[0]} ${i}`, body: t[1], tags: t[2], source: 'test:calibrate', hits: 0,
    })
  }
  const file = join(home, 'agent-memory', 'memory.ndjson')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
  return file
}

/** 跑标定脚本（node 用 process.argv0：本机 execPath 是 linker64，不是 node）。 */
function runCalibrate(home, extraArgs = []) {
  const res = spawnSync(process.argv0, [SCRIPT, '--home', home, ...extraArgs], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home },
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

/** 目录指纹：相对路径 + 字节数 + 内容 sha256（用来证明「一个字节都没改、也没多写文件」）。 */
function dirFingerprint(dir) {
  const out = []
  const walk = (cur) => {
    for (const name of readdirSync(cur, { recursive: true })) {
      const abs = join(cur, name)
      let st
      try { st = statSync(abs) } catch { continue }
      if (!st.isFile()) continue
      out.push(`${relative(dir, abs)}:${st.size}:${createHash('sha256').update(readFileSync(abs)).digest('hex')}`)
    }
  }
  if (existsSync(dir)) walk(dir)
  return out.sort()
}

// ── 1. 生成器：确定性、词表闭包、零入参 ────────────────────────────────────
test('I2.2 负样本生成器：≥200 个、零入参（不读库）、两次调用逐字节一致、词表闭包', () => {
  const a = buildNegativeQueries()
  const b = buildNegativeQueries()
  assert.equal(buildNegativeQueries.length, 0, '生成器不得有任何入参（否则可能把库内容喂进来）')
  assert.deepEqual(a, b, '两次调用必须逐字节一致（无随机数/无时间）')
  assert.ok(a.length >= 200, `负样本必须 ≥200，实测 ${a.length}`)
  assert.equal(a.length, NEGATIVE_QUERY_TARGET)
  assert.equal(new Set(a).size, a.length, '不得有重复查询（去重按首次出现，仍是确定序列）')
  assert.deepEqual(a.slice(0, NEGATIVE_HEAD.length), [...NEGATIVE_HEAD], '头部 12 个必须原样保留（= 旧脚本口径）')
  assert.equal(NEGATIVE_HEAD.length, 12)
  assert.ok(Object.keys(CROSS_DOMAIN_VOCAB).length >= 8, '跨域词表要覆盖多个无关域')

  // 词表闭包：每个生成出来的查询都必须能拆成「词表词 + 固定连接词 + 词表词」；
  // 反过来说，库里的任何词都不可能出现在查询里（生成器根本拿不到库内容）。
  const terms = new Set(vocabularyTerms().map((t) => t.text))
  const decompose = (q) => {
    for (const c of CONNECTORS) {
      const idx = q.indexOf(c)
      if (idx <= 0) continue
      const left = q.slice(0, idx)
      const right = q.slice(idx + c.length)
      if (terms.has(left) && terms.has(right)) return { left, right, connector: c }
    }
    return null
  }
  const generated = a.slice(NEGATIVE_HEAD.length)
  for (const q of generated) {
    const parts = decompose(q)
    assert.ok(parts, `生成的查询必须由跨域词表拼成，实测 ${JSON.stringify(q)}`)
  }
  // 阴性对照：库里出现的主题词不在词表里（否则「与库主题无关」是空话）
  for (const word of ['render', '门禁', '快照', '假绿', '编译', '注入', '内存']) {
    assert.equal(terms.has(word), false, `跨域词表不得收录库主题词：${word}`)
  }
})

// ── 2. 脚本：样本量、敏感性对照、两套建议 ─────────────────────────────────
test('I2.2 标定报告：负样本 ≥200、分位数齐全、敏感性对照与两套建议并列且互相自洽', () => {
  const home = freshDir('calibrate-report')
  seedLibrary(home, 5)
  const { code, out } = runCalibrate(home)
  assert.equal(code, 0, `退出码必须是 0，实测 ${code}\n${out}`)

  const negLine = /- 负样本 (\d+) 个（每个无关查询取库内最高分/.exec(out)
  assert.ok(negLine, `必须报告负样本条数，实测输出不含该行\n${out}`)
  const negCount = Number(negLine[1])
  assert.ok(negCount >= 200, `负样本必须 ≥200，实测 ${negCount}`)
  assert.ok(/- 负样本 \d+ 个[\s\S]*?p10=[\d.]+ p50=[\d.]+ p90=[\d.]+ p95=[\d.]+ p99=[\d.]+ max=[\d.]+/.test(out),
    '负样本分位数必须齐全（p10/p50/p90/p95/p99/max）')

  // 敏感性对照：两行样本量、两条差值
  const rows = [...out.matchAll(/样本量 (\d+) 个：p50=([\d.]+)\s+p95=([\d.]+)\s+max=([\d.]+)/g)]
    .map((m) => ({ n: Number(m[1]), p50: Number(m[2]), p95: Number(m[3]) }))
  assert.equal(rows.length, 2, `敏感性对照必须有两行，实测 ${rows.length}`)
  assert.equal(rows[0].n, NEGATIVE_HEAD.length, 'A 行必须是 12 个样本')
  assert.equal(rows[1].n, negCount, 'B 行必须是全部负样本')
  assert.ok(/差值：p50 [\d.]+ -> [\d.]+（SCALE_A），p95 [\d.]+ -> [\d.]+（WEAK）/.test(out),
    '必须打印 A→B 的差值（让读者看到 12 个样本时估计有多飘）')

  // 两套建议并列，且与敏感性表逐值自洽（防止「表是新的、建议还是旧的」）
  const idxA = out.indexOf('敏感性对照 A：')
  const idxB = out.indexOf('建议 B（本脚本采用：')
  assert.ok(idxA > 0 && idxB > idxA, '两套建议必须并列打印（A 在前、B 在后）')
  const blockA = out.slice(idxA, idxB)
  const blockB = out.slice(idxB)
  const pick = (block, key) => Number(new RegExp(`- ${key}\\s*=\\s*([\\d.]+)`).exec(block)?.[1])
  assert.equal(pick(blockA, 'SCALE_A'), rows[0].p50, 'A 的 SCALE_A 必须等于 A 行 p50(负样本)')
  assert.equal(pick(blockB, 'SCALE_A'), rows[1].p50, 'B 的 SCALE_A 必须等于 B 行 p50(负样本)')
  assert.equal(pick(blockA, 'WEAK'), rows[0].p95, 'A 的 WEAK 必须等于 A 行 p95(负样本)')
  assert.equal(pick(blockB, 'WEAK'), rows[1].p95, 'B 的 WEAK 必须等于 B 行 p95(负样本)')
  // 两侧 SCALE_B / STRONG 都来自正样本，必须完全相同
  assert.equal(pick(blockA, 'SCALE_B'), pick(blockB, 'SCALE_B'))
  assert.equal(pick(blockA, 'STRONG'), pick(blockB, 'STRONG'))

  // 边界说明照旧
  assert.ok(out.includes('分诊阈值（novelty）与图系数不由本脚本标定'), '必须保留分诊/图系数的边界说明')
  // 全域泄漏明细 + 只打印声明
  assert.ok(out.includes('全域噪音泄漏最重的前 10 个'), '必须给出泄漏最重的明细（只打印，不影响统计）')
  assert.ok(out.includes('本脚本只打印，不会改写'))
  assert.ok(!out.includes('个负样本明细（--dump-negatives'), '默认运行不逐条打印全部明细（要 --dump-negatives）')
})

test('I2.2 --dump-negatives：逐条打印全部负样本，顺序与生成器一致', () => {
  const home = freshDir('calibrate-dump')
  seedLibrary(home, 3)
  const { code, out } = runCalibrate(home, ['--dump-negatives'])
  assert.equal(code, 0)
  const quoted = [...out.matchAll(/    [\d.]+  <=  ("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]))
  const all = buildNegativeQueries()
  // 明细 = 头部 12（旧口径逐条对照） + 泄漏前 10 + 全部 240（--dump-negatives）
  assert.equal(quoted.length, NEGATIVE_HEAD.length + 10 + all.length,
    '明细条数 = 头部 12 + 泄漏前 10 + 全部 240')
  assert.deepEqual(quoted.slice(-all.length), all, '最后 240 条必须与生成器顺序一致')
})

// ── 3. 确定性：两次运行逐字节一致 ─────────────────────────────────────────
test('I2.2 确定性：同一份库两次运行 stdout 逐字节一致', () => {
  const home = freshDir('calibrate-det')
  seedLibrary(home, 4)
  const first = runCalibrate(home)
  const second = runCalibrate(home)
  assert.equal(first.code, 0)
  assert.equal(second.code, 0)
  assert.equal(second.out, first.out, '两次运行必须逐字节一致（无时间戳/随机数/库内容漂移）')
})

// ── 4. 只打印不改写 ───────────────────────────────────────────────────────
test('I2.2 只读：跑完之后库文件字节不变、DSH_HOME 里不多任何文件', () => {
  const home = freshDir('calibrate-readonly')
  const file = seedLibrary(home, 6)
  const before = dirFingerprint(home)
  const beforeBytes = readFileSync(file)
  const { code, out } = runCalibrate(home, ['--dump-negatives'])
  assert.equal(code, 0, out)
  assert.deepEqual(dirFingerprint(home), before, '标定脚本不得写入/删除/改动任何文件')
  assert.deepEqual(readFileSync(file), beforeBytes, '库文件必须逐字节不变')
  assert.ok(!existsSync(join(PLUGIN_DIR, 'calibrate-output.json')), '不得产出任何中间文件')
})

// ── 5. 空库：可读提示 + 退出码 0 ──────────────────────────────────────────
test('I2.2 空库：可读提示 + 退出码 0（且不抛）', () => {
  const home = freshDir('calibrate-empty')
  assert.ok(!existsSync(join(home, 'agent-memory', 'memory.ndjson')))
  const { code, out } = runCalibrate(home)
  assert.equal(code, 0, `空库必须退出码 0，实测 ${code}\n${out}`)
  assert.ok(out.includes('该文件不存在：当前没有可标定的记忆库'), out)
  assert.ok(out.includes('样本不足，无法给出建议'), out)
  assert.ok(out.includes('分诊阈值（novelty）与图系数不由本脚本标定'), '空库也要打印边界说明')

  // 「文件存在但一条可用记录都没有」是另一种空：同样可读、同样退出码 0
  const home2 = freshDir('calibrate-emptyfile')
  const file2 = join(home2, 'agent-memory', 'memory.ndjson')
  mkdirSync(dirname(file2), { recursive: true })
  writeFileSync(file2, '{坏行\n\n', 'utf8')
  const second = runCalibrate(home2)
  assert.equal(second.code, 0)
  assert.ok(second.out.includes('记忆库为空'), second.out)
})
