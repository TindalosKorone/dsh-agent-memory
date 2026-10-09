/**
 * 存储层：NDJSON 落盘（人类可读、可 grep）、原子写、硬上限淘汰、进程内串行队列。
 *
 * 位置：`${DSH_HOME ?? 默认}/agent-memory/memory.ndjson`
 *   DSH_HOME 未设或为空白 ⇒ 默认 `$HOME/.dsh`（见 DEFAULT_HOME，可移植，不硬编码本机路径）
 * 上限：默认 maxRecords = 2000 条 / maxBytes = 4 MiB；可用配置或环境变量收紧：
 *   DSH_AGENT_MEMORY_MAX_RECORDS / DSH_AGENT_MEMORY_MAX_BYTES
 * 淘汰：超限时按 score = decay(ts) * (1 + hits) 从低到高淘汰，**绝不无限增长**。
 *
 * I1.1 小修补的三道失败关闭闸门（都可判红）：
 *  1) 单条上限（record-too-large）：淘汰是按字节数做的，允许一条超大记录进来会把**整库挤空**；
 *     所以写入前先量这一条序列化后的字节数，超过上限（默认 maxBytes 的 10%）即拒收且不落盘。
 *  2) 外部改动守卫（store-changed-externally）：只有进程内串行队列、没有跨进程写锁，
 *     两个进程同写会互相覆盖；所以加载时记下 {size, mtimeMs}，rename 前重新 stat，不一致即拒写。
 *  3) 并发度可观测：FsOps 接缝可注入，测试据此断言写事务的最大并发度恒为 1（队列真的在串行化）。
 */
import { existsSync as fsExists, mkdirSync as fsMkdir, readFileSync as fsRead, renameSync as fsRename, statSync as fsStat, unlinkSync as fsUnlink, writeFileSync as fsWrite } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { decay, cmpId } from './pure.js';
import { normalizeStoredRecord } from './protocol.js';
/**
 * `DSH_HOME` 未设或为空白时的默认 home —— **可移植，不硬编码本机绝对路径**。
 *
 * 这里曾经写死本机的应用私有 home（形如 `$APP_DATA/files/home/.dsh`）。那是两件坏事：
 *  1. 公开仓里带着**机器相关**的应用私有目录字样（见 docs/limitations.md 的路径规范化说明）；
 *  2. 对**任何别的机器**它都是错的（就算同为 Android，包名也未必一样）。
 * 现在按 POSIX 惯例取 `$HOME/.dsh`，`$HOME` 缺失时退回 `os.homedir()`。
 * 本机上 `$HOME` = `$APP_DATA/files/home`，与历史默认值指向**同一个目录**
 * （Android 的 `/data/user/0` 与 `/data/data` 互为别名），因此行为不变；换机器则自动跟着 `$HOME` 走。
 */
export const DEFAULT_HOME = join(typeof process.env.HOME === 'string' && process.env.HOME.trim() !== '' ? process.env.HOME.trim() : homedir(), '.dsh');
export const DEFAULT_MAX_RECORDS = 2000;
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
/** 单条记录的默认上限比例：maxBytes 的 10%（见 resolveMaxRecordBytes）。 */
export const DEFAULT_MAX_RECORD_RATIO = 0.1;
export const MEMORY_SUBDIR = 'agent-memory';
export const MEMORY_FILE = 'memory.ndjson';
const DEFAULT_FS = {
    existsSync: (p) => fsExists(p),
    mkdirSync: (p) => { fsMkdir(p, { recursive: true }); },
    readFileSync: (p) => fsRead(p, 'utf8'),
    writeFileSync: (p, data) => { fsWrite(p, data, 'utf8'); },
    renameSync: (from, to) => { fsRename(from, to); },
    unlinkSync: (p) => { fsUnlink(p); },
    statSync: (p) => {
        const st = fsStat(p);
        return { size: st.size, mtimeMs: st.mtimeMs };
    },
};
function ops(cfg) {
    return cfg?.fs ?? DEFAULT_FS;
}
function positiveInt(raw, fallback) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1)
        return Math.floor(raw);
    if (typeof raw === 'string') {
        const n = Number.parseInt(raw, 10);
        if (Number.isFinite(n) && n >= 1)
            return n;
    }
    return fallback;
}
/** DSH_HOME 解析：显式配置 > 环境变量 > 默认（空串/空白一律视为未设）。 */
export function resolveHome(cfg) {
    const explicit = typeof cfg?.home === 'string' ? cfg.home.trim() : '';
    if (explicit !== '')
        return explicit;
    const env = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
    return env !== '' ? env : DEFAULT_HOME;
}
export function memoryDir(cfg) {
    return join(resolveHome(cfg), MEMORY_SUBDIR);
}
export function memoryPath(cfg) {
    return join(memoryDir(cfg), MEMORY_FILE);
}
export function resolveMaxRecords(cfg) {
    if (cfg?.maxRecords !== undefined)
        return positiveInt(cfg.maxRecords, DEFAULT_MAX_RECORDS);
    return positiveInt(process.env.DSH_AGENT_MEMORY_MAX_RECORDS, DEFAULT_MAX_RECORDS);
}
export function resolveMaxBytes(cfg) {
    if (cfg?.maxBytes !== undefined)
        return positiveInt(cfg.maxBytes, DEFAULT_MAX_BYTES);
    return positiveInt(process.env.DSH_AGENT_MEMORY_MAX_BYTES, DEFAULT_MAX_BYTES);
}
/**
 * 单条记录上限（字节）：显式配置 > 环境变量 DSH_AGENT_MEMORY_MAX_RECORD_BYTES > maxBytes 的 10%。
 * 存在的理由：淘汰是按**字节数**做的，若允许一条超大记录进来，淘汰会把整库挤空来给它腾地方。
 * 至少为 1 字节（maxBytes 极小时也不会退化成「什么都写不进去」之外的行为）。
 */
export function resolveMaxRecordBytes(cfg) {
    const fallback = Math.max(1, Math.floor(resolveMaxBytes(cfg) * DEFAULT_MAX_RECORD_RATIO));
    if (cfg?.maxRecordBytes !== undefined)
        return positiveInt(cfg.maxRecordBytes, fallback);
    return positiveInt(process.env.DSH_AGENT_MEMORY_MAX_RECORD_BYTES, fallback);
}
export function nowMs(cfg) {
    return cfg?.now !== undefined ? cfg.now() : Date.now();
}
export function newRecordId(cfg, now) {
    if (cfg?.newId !== undefined)
        return cfg.newId(now);
    return `mem_${now.toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}
/** NDJSON 序列化：一行一条 JSON，末行带换行；空库为 0 字节。 */
export function serialize(records) {
    if (records.length === 0)
        return '';
    return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}
export function byteLength(text) {
    return Buffer.byteLength(text, 'utf8');
}
/** 单条记录序列化后的真实字节数（NDJSON 一行，不含行尾换行）。 */
export function recordBytes(rec) {
    return byteLength(JSON.stringify(rec));
}
/**
 * 单条上限检查（纯计算，不落盘）：
 * 超过上限即失败关闭 —— 调用方必须直接拒收，**不得落盘、不得触发任何淘汰**。
 */
export function checkRecordSize(rec, cfg = {}) {
    const limit = resolveMaxRecordBytes(cfg);
    const bytes = recordBytes(rec);
    return bytes > limit ? { ok: false, bytes, limit } : { ok: true, bytes, limit };
}
/** 单条记录超过上限：失败关闭，不落盘、不触发任何淘汰。 */
export class RecordTooLargeError extends Error {
    code = 'record-too-large';
    bytes;
    limit;
    maxBytes;
    constructor(bytes, limit, maxBytes) {
        super(`单条记录序列化后 ${bytes} 字节，超过单条上限 ${limit} 字节（失败关闭，未落盘）`);
        this.name = 'RecordTooLargeError';
        this.bytes = bytes;
        this.limit = limit;
        this.maxBytes = maxBytes;
    }
}
/** 库文件在「加载 → 落盘」之间被外部改动：失败关闭，绝不覆盖对方的内容。 */
export class StoreChangedExternallyError extends Error {
    code = 'store-changed-externally';
    path;
    expected;
    actual;
    constructor(path, expected, actual) {
        super(`库文件在加载后被外部改动（失败关闭，未覆盖）：${path}`);
        this.name = 'StoreChangedExternallyError';
        this.path = path;
        this.expected = expected;
        this.actual = actual;
    }
}
/**
 * 读全库并记下文件身份快照；文件不存在返回空数组 + 无 stamp（首次写入不算「外部改动」）。
 * 坏行跳过并保留其余（不因一行损坏丢整库）。
 */
export function loadSnapshot(cfg = {}) {
    const path = memoryPath(cfg);
    const fs = ops(cfg);
    if (!fs.existsSync(path))
        return { records: [] };
    const text = fs.readFileSync(path);
    const stamp = fs.statSync(path);
    const out = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '')
            continue;
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch {
            continue;
        }
        const rec = normalizeStoredRecord(parsed);
        if (rec !== undefined)
            out.push(rec);
    }
    return { records: out, stamp };
}
/** 读全库（不关心文件身份时的便捷入口）。 */
export function loadRecords(cfg = {}) {
    return loadSnapshot(cfg).records;
}
/**
 * 便宜的文件身份探测（只 stat、**不读内容**）：文件不存在或无法 stat 时返回 undefined。
 * I4a 的只读缓存用它做 `{path, size, mtimeMs}` 的命中判定 —— 与上面的外部改动守卫
 * 共用同一套身份口径（StoreStamp），所以缓存不会比库自己的判据更乐观。
 */
export function statStamp(cfg = {}) {
    const path = memoryPath(cfg);
    const fs = ops(cfg);
    try {
        if (!fs.existsSync(path))
            return undefined;
        return fs.statSync(path);
    }
    catch {
        return undefined;
    }
}
let tmpSeq = 0;
/**
 * 原子写：先写同目录临时文件，再 rename 覆盖正式文件。
 * 任一步抛错 ⇒ 清掉临时文件并向上抛；正式文件保持旧内容（绝不半写覆盖）。
 *
 * 外部改动守卫（补 3）：调用方传了加载时的 stamp 时，rename 之前先重新 stat，
 * 与加载时不一致（size 或 mtimeMs 变了，或文件竟已消失）⇒ 抛 StoreChangedExternallyError，
 * **绝不覆盖**对方写进去的内容。expect 为 undefined 表示「加载时文件不存在」（首次写入）⇒ 不做判定。
 */
export function saveRecords(records, cfg = {}, expect) {
    const path = memoryPath(cfg);
    const fs = ops(cfg);
    const dir = dirname(path);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir);
    if (expect !== undefined) {
        let actual;
        try {
            actual = fs.statSync(path);
        }
        catch {
            actual = undefined;
        }
        if (actual === undefined || actual.size !== expect.size || actual.mtimeMs !== expect.mtimeMs) {
            throw new StoreChangedExternallyError(path, expect, actual);
        }
    }
    const data = serialize(records);
    tmpSeq += 1;
    const tmp = `${path}.tmp-${process.pid}-${tmpSeq}`;
    try {
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, path);
    }
    catch (err) {
        try {
            fs.unlinkSync(tmp);
        }
        catch { /* 临时文件清不掉就留着，绝不能污染正式文件 */ }
        throw err;
    }
    return { path, count: records.length, bytes: byteLength(data) };
}
/** 淘汰分：recency * (1 + hits)，越小越先被淘汰。 */
export function evictionScore(rec, now, halfLifeDays = 180) {
    const hits = Number.isFinite(rec.hits) && rec.hits > 0 ? rec.hits : 0;
    return decay(rec.ts, now, halfLifeDays) * (1 + hits);
}
/**
 * 上限执行：先按条数、再按字节数淘汰，淘汰顺序一律由 evictionScore 升序决定
 * （同分按 id 字典序 ⇒ 确定性）。字节判定用序列化后真实字节数。
 */
export function enforceCaps(records, cfg = {}, now = nowMs(cfg)) {
    const maxRecords = resolveMaxRecords(cfg);
    const maxBytes = resolveMaxBytes(cfg);
    const order = [...records].sort((a, b) => (evictionScore(a, now) - evictionScore(b, now)) || cmpId(a.id, b.id));
    const dropped = new Set();
    let kept = [...records];
    const dropNext = () => {
        for (const victim of order) {
            if (dropped.has(victim.id))
                continue;
            dropped.add(victim.id);
            kept = kept.filter((r) => r.id !== victim.id);
            return true;
        }
        return false;
    };
    while (kept.length > maxRecords)
        if (!dropNext())
            break;
    while (byteLength(serialize(kept)) > maxBytes)
        if (!dropNext())
            break;
    const evicted = order.filter((r) => dropped.has(r.id));
    return { records: kept, evicted, maxRecords, maxBytes };
}
/**
 * 追加一条（读-改-写整体串行由调用方的队列保证）并立刻执行上限淘汰，最后原子落盘。
 *
 * 单条上限（补 1）：淘汰是按字节数做的，一条超大记录进来会导致**整库被挤空**；
 * 所以这里在淘汰之前先量这一条的字节数，超限立即抛 RecordTooLargeError
 * ⇒ 不落盘、不触发任何淘汰、库保持原样。
 */
export function appendRecord(draft, cfg = {}) {
    const now = nowMs(cfg);
    const snapshot = loadSnapshot(cfg);
    const before = snapshot.records;
    const record = {
        id: newRecordId(cfg, now),
        ts: now,
        kind: draft.kind,
        title: draft.title,
        body: draft.body,
        tags: [...draft.tags],
        source: draft.source,
        hits: 0,
    };
    const size = checkRecordSize(record, cfg);
    if (!size.ok)
        throw new RecordTooLargeError(size.bytes, size.limit, resolveMaxBytes(cfg));
    const capped = enforceCaps([...before, record], cfg, now);
    const saved = saveRecords(capped.records, cfg, snapshot.stamp);
    return {
        record,
        kept: capped.records,
        evicted: capped.evicted,
        countBefore: before.length,
        countAfter: capped.records.length,
        bytes: saved.bytes,
        path: saved.path,
        maxRecords: capped.maxRecords,
        maxBytes: capped.maxBytes,
    };
}
/** 给被 expand 取回的记录累加 hits 并落盘（hits 是淘汰分的因子，必须持久化）。 */
export function bumpHits(ids, cfg = {}) {
    const now = nowMs(cfg);
    const wanted = new Set(ids);
    const hits = {};
    const snapshot = loadSnapshot(cfg);
    const records = snapshot.records.map((rec) => {
        if (!wanted.has(rec.id))
            return rec;
        const next = rec.hits + 1;
        hits[rec.id] = next;
        return { ...rec, hits: next };
    });
    const capped = enforceCaps(records, cfg, now);
    const saved = saveRecords(capped.records, cfg, snapshot.stamp);
    return { hits, count: capped.records.length, bytes: saved.bytes, evicted: capped.evicted };
}
/** 合并键：kind + 归一化标题完全一致视为同一条。 */
export function mergeKey(rec) {
    return `${rec.kind}\u0000${rec.title.trim().toLowerCase()}`;
}
/** 标签有序并集（保留先出现顺序，最多 12 个，去重按归一化后比较）。 */
function unionTags(lists) {
    const out = [];
    const seen = new Set();
    for (const list of lists) {
        for (const tag of list) {
            const t = tag.trim().toLowerCase();
            if (t === '' || seen.has(t))
                continue;
            seen.add(t);
            if (out.length < 12)
                out.push(t);
        }
    }
    return out;
}
/**
 * 淘汰 + 合并计划（纯计算，不落盘）。
 * 合并：同 kind 同标题的一组，保留 ts 最新者（同 ts 取 hits 多者，再同取 id 字典序小者），
 * 其余并入并丢弃，保留者累加 hits、标签取有序并集。
 */
export function planPrune(cfg = {}) {
    const now = nowMs(cfg);
    const snapshot = loadSnapshot(cfg);
    const input = snapshot.records;
    const bytesBefore = byteLength(serialize(input));
    const groups = new Map();
    for (const rec of input) {
        const key = mergeKey(rec);
        const list = groups.get(key);
        if (list === undefined)
            groups.set(key, [rec]);
        else
            list.push(rec);
    }
    const merged = [];
    const survivors = [];
    for (const list of groups.values()) {
        if (list.length === 1) {
            survivors.push(list[0]);
            continue;
        }
        const sorted = [...list].sort((a, b) => (b.ts - a.ts) || (b.hits - a.hits) || cmpId(a.id, b.id));
        const keeper = sorted[0];
        const others = sorted.slice(1);
        const hits = list.reduce((sum, r) => sum + (Number.isFinite(r.hits) ? r.hits : 0), 0);
        const tags = unionTags(sorted.map((r) => r.tags));
        survivors.push({ ...keeper, hits, tags: tags.length > 0 ? tags : keeper.tags });
        merged.push({ keep: keeper.id, dropped: others.map((r) => r.id) });
    }
    const capped = enforceCaps(survivors, cfg, now);
    return {
        records: capped.records,
        merged,
        evicted: capped.evicted,
        countBefore: input.length,
        countAfter: capped.records.length,
        bytesBefore,
        bytesAfter: byteLength(serialize(capped.records)),
        maxRecords: capped.maxRecords,
        maxBytes: capped.maxBytes,
        stamp: snapshot.stamp,
    };
}
export function createQueue() {
    let tail = Promise.resolve();
    let pending = 0;
    return {
        run(task) {
            pending += 1;
            const next = tail.then(task, task);
            tail = next.then(() => undefined, () => undefined);
            void tail.then(() => { pending -= 1; });
            return next;
        },
        idle() { return pending === 0; },
        reset() {
            pending = 0;
            tail = Promise.resolve();
        },
    };
}
