// 用例 7：落盘格式（NDJSON 每行可 JSON.parse）+ 原子写（写坏不影响旧文件）+ 串行队列
//        + I1.1 三道失败关闭闸门（单条过大 / 并发度可观测 / 外部改动守卫），三条都可判红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import {
  StoreChangedExternallyError, appendRecord, checkRecordSize, createQueue, loadRecords, loadSnapshot,
  memoryPath, recordBytes, resolveMaxRecordBytes, saveRecords,
} from '../lib/store.js'
import { diskLines, diskText, freshHome, record, tools } from './helpers.mjs'

const DAY = 86_400_000
const T0 = 1_700_000_000_000

const DRAFT = { kind: 'fact', title: '原子写测试用的一条记录', body: '正文', tags: ['atomic'], source: 'test:atomic' }

/** 真实 fs 的可注入包装：默认全走真 fs，按需覆盖某一步以注入故障。 */
function injectedFs(overrides = {}) {
  return {
    existsSync: (p) => existsSync(p),
    mkdirSync: (p) => { mkdirSync(p, { recursive: true }) },
    readFileSync: (p) => readFileSync(p, 'utf8'),
    writeFileSync: (p, d) => { writeFileSync(p, d, 'utf8') },
    renameSync: (a, b) => { renameSync(a, b) },
    unlinkSync: (p) => { unlinkSync(p) },
    statSync: (p) => { const st = statSync(p); return { size: st.size, mtimeMs: st.mtimeMs } },
    ...overrides,
  }
}

const tmpLeftovers = (home) => {
  const dir = memoryPath({ home }).replace(/\/memory\.ndjson$/, '')
  try {
    return readdirSync(dir).filter((f) => f.includes('.tmp-'))
  } catch { return [] }
}

/**
 * 判红开关（补 2 的红证点）：默认走串行队列。
 * 红证做法：把这一行临时改成 `(q, task) => task()`（绕过队列）⇒ 并发度断言必须变红。
 */
const viaQueue = (q, task) => q.run(task)

/**
 * 可观测并发度的包装（利用 FsOps 接缝）：
 *  - fsMax：单次 fs 调用同时在飞的个数；
 *  - txnMax：同时在「一次写事务（读-改-写）」里的写者个数 —— 这才是队列要串行化的东西。
 * 注意：本插件的 FsOps 是**同步**签名，同步调用之间不会自然交错，这正是原用例「永远绿」的根因；
 * 所以用 io() 在观测窗口内显式让出一次事件循环，模拟真实磁盘 I/O 的等待（真实 I/O 本来就是异步的）。
 */
function concurrencyProbe() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const st = { txnActive: 0, txnMax: 0, txnTotal: 0, fsActive: 0, fsMax: 0, fsCalls: 0 }
  const base = injectedFs()
  const wrap = (name) => (...args) => {
    st.fsActive += 1
    st.fsCalls += 1
    if (st.fsActive > st.fsMax) st.fsMax = st.fsActive
    try { return base[name](...args) } finally { st.fsActive -= 1 }
  }
  return {
    fs: {
      existsSync: wrap('existsSync'),
      mkdirSync: wrap('mkdirSync'),
      readFileSync: wrap('readFileSync'),
      writeFileSync: wrap('writeFileSync'),
      renameSync: wrap('renameSync'),
      unlinkSync: wrap('unlinkSync'),
      statSync: wrap('statSync'),
    },
    /** 让出一次事件循环：模拟真实 fs I/O 的等待窗口。 */
    io: () => sleep(5),
    /** 包一次写事务（读-改-写），统计同时在事务里的写者数。 */
    txn: async (fn) => {
      st.txnActive += 1
      st.txnTotal += 1
      if (st.txnActive > st.txnMax) st.txnMax = st.txnActive
      try { return await fn() } finally { st.txnActive -= 1 }
    },
    stats: () => ({ ...st }),
  }
}

test('落盘格式：NDJSON 一行一条，每行都能 JSON.parse，且人类可读可 grep', () => {
  const home = freshHome('storage-ndjson')
  const cfg = { home, now: () => T0 }
  saveRecords([
    record('rec-a', T0 - DAY, { tags: ['x', 'y'] }),
    record('rec-b', T0, { kind: 'lesson', hits: 3 }),
  ], cfg)

  const text = diskText(home)
  assert.ok(text.endsWith('\n'), 'NDJSON 末行必须有换行')
  const rows = text.split('\n').filter((l) => l !== '')
  assert.equal(rows.length, 2)
  for (const line of rows) {
    assert.equal(line.includes('\n'), false, '一行一条，行内不得再有换行')
    const rec = JSON.parse(line)
    assert.equal(typeof rec.id, 'string')
    assert.equal(typeof rec.ts, 'number')
    assert.ok(Array.isArray(rec.tags))
  }
  // 人类可读 / 可 grep：键名原样出现在文本里
  assert.match(text, /"title":/)
  assert.match(text, /"source":/)
  assert.match(text, /"tags":\["x","y"\]/)

  const back = loadRecords(cfg)
  assert.deepEqual(back.map((r) => r.id), ['rec-a', 'rec-b'])
  assert.equal(back[1].hits, 3)
})

test('原子写：写临时文件时抛错 ⇒ 旧文件完好，临时文件被清掉', () => {
  const home = freshHome('storage-atomic-write')
  saveRecords([record('rec-old', T0)], { home })
  const before = diskText(home)
  assert.ok(before.length > 0)

  // 故障注入：临时文件写了一半就抛错
  const fs = injectedFs({
    writeFileSync: (p, d) => {
      writeFileSync(p, d.slice(0, 20), 'utf8')
      throw new Error('注入故障：写临时文件失败')
    },
  })
  assert.throws(() => appendRecord(DRAFT, { home, fs, now: () => T0 }), /注入故障/)
  assert.equal(diskText(home), before, '正式文件必须保持旧内容（绝不被半写覆盖）')
  assert.deepEqual(tmpLeftovers(home), [], '失败后不得残留临时文件')
  assert.deepEqual(loadRecords({ home }).map((r) => r.id), ['rec-old'])

  // 故障恢复后仍能正常落盘
  appendRecord(DRAFT, { home, now: () => T0 })
  assert.equal(loadRecords({ home }).length, 2)
})

test('原子写：rename 抛错 ⇒ 旧文件完好，临时文件被清掉', () => {
  const home = freshHome('storage-atomic-rename')
  saveRecords([record('rec-old', T0)], { home })
  const before = diskText(home)

  const fs = injectedFs({ renameSync: () => { throw new Error('注入故障：rename 失败') } })
  assert.throws(() => appendRecord(DRAFT, { home, fs, now: () => T0 }), /注入故障/)
  assert.equal(diskText(home), before, 'rename 失败必须由旧文件兜底')
  assert.deepEqual(tmpLeftovers(home), [])
})

test('读盘健壮性：坏行被跳过，好行照常读出（不因一行损坏丢整库）', () => {
  const home = freshHome('storage-corrupt')
  saveRecords([record('rec-a', T0), record('rec-b', T0 - DAY)], { home })
  const p = memoryPath({ home })
  const good = diskText(home).split('\n').filter((l) => l !== '')
  // 插一行坏 JSON、一行合法 JSON 但字段不全（缺 tags）、一行空行
  writeFileSync(p, `${good[0]}\n{不是 JSON\n{"id":"rec-bad","ts":1,"kind":"fact","title":"t","body":"b","source":"s"}\n\n${good[1]}\n`, 'utf8')

  const rows = loadRecords({ home })
  assert.deepEqual(rows.map((r) => r.id), ['rec-a', 'rec-b'])
})

test('串行队列：先提交者整体跑完才轮到下一个（读-改-写不互相覆盖）', async () => {
  const q = createQueue()
  const order = []
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const a = q.run(async () => { order.push('a1'); await sleep(20); order.push('a2'); return 'A' })
  const b = q.run(async () => { order.push('b1'); await sleep(1); order.push('b2'); return 'B' })
  const results = await Promise.all([a, b])

  assert.deepEqual(order, ['a1', 'a2', 'b1', 'b2'])
  assert.deepEqual(results, ['A', 'B'])
  assert.equal(q.idle(), true)
})

test('串行队列：任务抛错不阻塞后续，reset 后仍可用', async () => {
  const q = createQueue()
  const failed = q.run(() => { throw new Error('任务自身失败') })
  await assert.rejects(failed, /任务自身失败/)
  assert.equal(await q.run(() => 'ok'), 'ok')
  q.reset()
  assert.equal(q.idle(), true)
  assert.equal(await q.run(() => 'after-reset'), 'after-reset')
})

// ── 补 2：并发写入判据（可判红）─────────────────────────────────────────────
test('并发写入：4 个 remember 并发提交后 4 条都在，且写事务最大并发度恒为 1（判红点）', async () => {
  const home = freshHome('storage-concurrent')
  const g = concurrencyProbe()
  // 通过 FsOps 接缝把可观测包装注入**真实工具路径**
  const defs = tools({ home, fs: g.fs, now: () => T0 })
  const remember = defs.get('memory_remember')

  // A) 真实工具路径：4 个并发提交不得丢记录（原断言保留）
  const rs = await Promise.all([0, 1, 2, 3].map((i) => remember.execute({
    kind: 'fact', title: `并发写入第 ${i} 号记录`, body: `正文 ${i}`, tags: ['concurrent'], source: 'test:concurrent',
  })))
  for (const r of rs) assert.equal(r.ok, true)
  assert.equal(new Set(rs.map((r) => r.id)).size, 4, 'id 必须互不相同')
  assert.equal(diskLines(home).length, 4, '并发写入不得丢记录')

  // B) 串行化判据：4 个写事务（读-改-写）并发提交，最大并发度必须恒为 1
  const q = createQueue()
  const cfg = { home, fs: g.fs, now: () => T0 }
  const writeOnce = (i) => viaQueue(q, () => g.txn(async () => {
    const before = loadRecords(cfg)
    await g.io() // 让出：真实磁盘 I/O 的等待窗口（同步 fs 调用之间不会自然交错，见 probe 注释）
    saveRecords([...before, record(`con-${i}`, T0)], cfg)
  }))
  await Promise.all([0, 1, 2, 3].map(writeOnce))

  const st = g.stats()
  assert.equal(st.txnMax, 1, `写事务最大并发度必须恒为 1，实际 ${st.txnMax}（队列没有串行化 ⇒ 读-改-写会互相覆盖）`)
  assert.equal(st.fsMax, 1, `单次 fs 调用最大并发度必须恒为 1，实际 ${st.fsMax}`)
  assert.equal(st.txnTotal, 4, '4 个写事务都必须真的跑过')
  assert.equal(loadRecords(cfg).length, 8, '4 条工具写入 + 4 条事务写入，一条都不能丢')
})

// ── 补 1：单条过大必须拒收（可判红）─────────────────────────────────────────
test('单条上限：默认取 maxBytes 的 10%，可用环境变量或配置覆盖', () => {
  const home = freshHome('storage-record-cap-config')
  assert.equal(resolveMaxRecordBytes(), Math.floor(4 * 1024 * 1024 * 0.1), '默认 = maxBytes 的 10%')
  assert.equal(resolveMaxRecordBytes({ maxBytes: 10_000 }), 1000, '默认随 maxBytes 走')
  assert.equal(resolveMaxRecordBytes({ maxRecordBytes: 512 }), 512, '配置注入优先')
  process.env.DSH_AGENT_MEMORY_MAX_RECORD_BYTES = '200'
  assert.equal(resolveMaxRecordBytes(), 200, '环境变量生效')
  delete process.env.DSH_AGENT_MEMORY_MAX_RECORD_BYTES
  void home
})

test('单条上限：checkRecordSize 按序列化后的真实字节数判定，超限即 ok=false', () => {
  const home = freshHome('storage-record-cap-check')
  const rec = record('rec-size', T0, { body: 'x'.repeat(500) })
  const bytes = recordBytes(rec)
  assert.equal(checkRecordSize(rec, { home, maxRecordBytes: bytes }).ok, true, '恰好等于上限必须放行')
  assert.deepEqual(checkRecordSize(rec, { home, maxRecordBytes: bytes - 1 }), { ok: false, bytes, limit: bytes - 1 })
})

test('单条过大必须拒收：不得落盘，更不得触发全库淘汰（判红点）', async () => {
  const home = freshHome('storage-record-too-large')
  const seed = [0, 1, 2, 3, 4].map((i) => record(`seed-${i}`, T0 - i * DAY))
  saveRecords(seed, { home, now: () => T0 })
  assert.equal(diskLines(home).length, 5)

  // maxBytes = 64 KiB ⇒ 单条上限默认 6553 字节；正文给 80 KiB（本身就大过 maxBytes）
  const defs = tools({ home, maxBytes: 64 * 1024, now: () => T0 })
  const r = await defs.get('memory_remember').execute({
    kind: 'fact', title: '一条超大记录用来验证拒收', body: 'x'.repeat(80 * 1024), tags: ['huge'], source: 'test:huge',
  })

  // 第一条断言就对准「库有没有被清空」：判红（关掉单条上限）时这里会变成空库，一眼可见
  assert.deepEqual(
    diskLines(home).map((l) => JSON.parse(l).id),
    seed.map((x) => x.id),
    '超大记录被拒后整库 5 条必须原样保留（判红点：关掉单条上限后这里会变成空库/大量淘汰）',
  )
  assert.equal(r.ok, false)
  assert.equal(r.code, 'record-too-large')
  assert.equal(r.evicted, 0, '拒收不得触发任何淘汰')
  assert.equal(r.total, 5, '拒收后条数不变')
  assert.match(r.text, /单条上限/, 'text 必须给出当前上限')
  assert.match(r.text, /DSH_AGENT_MEMORY_MAX_RECORD_BYTES/, 'text 必须给出可照做的修复方式')
  // 返回形状必须与声明 schema 一致（宿主会按 additionalProperties=false 整值校验）
  for (const k of ['ok', 'code', 'total', 'bytes', 'maxRecords', 'maxBytes', 'evicted', 'evictedIds', 'text']) {
    assert.ok(k in r, `缺必填字段 ${k}`)
  }
  assert.equal('id' in r, false, '失败时 id 必须整键省略')
})

// ── 补 3：外部改动失败关闭（可判红）─────────────────────────────────────────
test('外部改动守卫：加载后被外部追加一行 ⇒ 写入被拒且外部那行仍在（判红点）', () => {
  const home = freshHome('storage-external')
  const p = memoryPath({ home })
  const cfg = { home, now: () => T0 }
  saveRecords([record('rec-a', T0)], cfg)

  const snap = loadSnapshot(cfg)
  assert.ok(snap.stamp !== undefined, '文件存在时必须有 stamp')

  // 模拟另一个进程追加了一行
  const external = JSON.stringify(record('rec-external', T0, { body: '外部进程追加的一行' }))
  appendFileSync(p, `${external}\n`, 'utf8')
  const beforeText = diskText(home)
  assert.ok(beforeText.includes('rec-external'))

  // 守卫必须拒写
  let refused = false
  try {
    saveRecords([...snap.records, record('rec-local', T0)], cfg, snap.stamp)
  } catch (err) {
    if (!(err instanceof StoreChangedExternallyError)) throw err
    refused = true
  }

  // 判红点：关掉守卫后这里会变成「只剩本地那条」，外部那行被覆盖 ⇒ 一眼可见
  assert.equal(diskText(home), beforeText, '外部写入的内容必须仍在（不得被覆盖）')
  assert.ok(!diskText(home).includes('rec-local'), '本地那条不得落盘')
  assert.equal(refused, true, '加载后被外部改动 ⇒ 必须失败关闭（store-changed-externally）')
})

test('外部改动守卫：工具层 remember 返回 ok=false + code=store-changed-externally', async () => {
  const home = freshHome('storage-external-tool')
  const p = memoryPath({ home })
  saveRecords([record('rec-a', T0)], { home })
  const external = JSON.stringify(record('rec-external', T0, { body: '外部进程追加的一行' }))

  // 通过 FsOps 接缝注入：loadSnapshot 记完 stamp 之后，立刻模拟外部进程追加一行
  let injected = false
  const fs = injectedFs({
    statSync: (target) => {
      const st = statSync(target)
      if (!injected && target === p) {
        injected = true
        appendFileSync(p, `${external}\n`, 'utf8')
      }
      return { size: st.size, mtimeMs: st.mtimeMs }
    },
  })

  const defs = tools({ home, fs, now: () => T0 })
  const r = await defs.get('memory_remember').execute({ ...DRAFT })

  assert.equal(r.ok, false)
  assert.equal(r.code, 'store-changed-externally')
  assert.match(r.text, /加载之后被/)
  assert.match(r.text, /重新读取后再写/)
  for (const k of ['ok', 'code', 'total', 'bytes', 'maxRecords', 'maxBytes', 'evicted', 'evictedIds', 'text']) {
    assert.ok(k in r, `缺必填字段 ${k}`)
  }
  assert.equal('id' in r, false)
  assert.deepEqual(diskLines(home).map((l) => JSON.parse(l).id).sort(), ['rec-a', 'rec-external'], '外部那行必须仍在')
  assert.ok(diskText(home).includes('外部进程追加的一行'), '外部写入的内容不得被覆盖')
})

test('外部改动守卫：加载时文件不存在（首次写入）不算外部改动', () => {
  const home = freshHome('storage-external-first')
  const cfg = { home, now: () => T0 }
  const snap = loadSnapshot(cfg)
  assert.equal(snap.stamp, undefined, '首次写入没有 stamp')
  const saved = saveRecords([record('rec-first', T0)], cfg, snap.stamp)
  assert.equal(saved.count, 1)
  assert.equal(diskLines(home).length, 1)
})
