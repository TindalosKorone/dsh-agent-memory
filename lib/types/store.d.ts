import { type GraphOptions, type ScoreOptions, type TriageOptions } from './pure.js';
import { type MemoryDraft, type MemoryRecord } from './protocol.js';
import type { InjectionConfig } from './inject.js';
export declare const DEFAULT_HOME = "/data/user/0/com.dsharnessmobile.shell/files/home/.dsh";
export declare const DEFAULT_MAX_RECORDS = 2000;
export declare const DEFAULT_MAX_BYTES: number;
/** 单条记录的默认上限比例：maxBytes 的 10%（见 resolveMaxRecordBytes）。 */
export declare const DEFAULT_MAX_RECORD_RATIO = 0.1;
export declare const MEMORY_SUBDIR = "agent-memory";
export declare const MEMORY_FILE = "memory.ndjson";
/** 目标文件的身份快照：size + mtimeMs。用于失败关闭地发现「加载之后被外部改过」。 */
export interface StoreStamp {
    size: number;
    mtimeMs: number;
}
/** 文件系统接缝：默认走 node:fs，测试可注入以做故障注入（红证 / 原子写断言 / 并发度观测）。 */
export interface FsOps {
    existsSync(path: string): boolean;
    mkdirSync(path: string): void;
    readFileSync(path: string): string;
    writeFileSync(path: string, data: string): void;
    renameSync(from: string, to: string): void;
    unlinkSync(path: string): void;
    /** 取 {size, mtimeMs}；文件不存在时抛错（与 node:fs 原语一致）。 */
    statSync(path: string): StoreStamp;
}
export interface MemoryConfig {
    /** 覆盖 DSH_HOME（通常只在测试里用）。 */
    home?: string;
    maxRecords?: number;
    maxBytes?: number;
    /**
     * 单条记录序列化后的字节上限（默认取 maxBytes 的 10%）。
     * 超限的写入直接拒收（record-too-large），不落盘、不触发淘汰。
     */
    maxRecordBytes?: number;
    fs?: FsOps;
    /** 时间源注入（测试用固定时间戳）。 */
    now?: () => number;
    /** id 生成器注入（测试用确定性 id）。 */
    newId?: (now: number) => string;
    /**
     * 打分口径覆盖（I1.2）：展示分绝对标度常数 SCALE_A / SCALE_B、绝对阈值 WEAK / STRONG、
     * 多样性惩罚系数 β。缺省一律用 pure.ts 里的模块级默认常数（见 resolveScoreOptions）。
     * 注意：这里只放常数，**没有任何批次相关量**——展示分禁用批内归一化。
     */
    score?: ScoreOptions;
    /**
     * 分诊口径覆盖（I2）：noveltyThreshold（默认 0.5，novelty >= 它 ⇒ 扩检索）、
     * activationThreshold（默认 0.05，cov_max < 它 ⇒ lowConfidence，**只如实报告不否决**）、
     * maxBasis（默认 6）、maxLayers（默认 3）、residualStop（默认 0.1）。
     * 缺省一律用 pure.ts 的模块级默认常数（见 resolveTriageOptions）。
     * 注意：这些常数只决定「取多少候选」与「是否如实标记低置信」，
     * **不参与候选展示分**（展示分仍只走绝对区间映射，绝不批内归一化）。
     */
    triage?: TriageOptions;
    /**
     * I3 图与传播口径覆盖：lambda（log 压缩 λ，默认 1）、outBudget（出流预算 m_out，默认 1）、
     * hubEta（枢纽抑制指数 η，默认 0.5）、maxHops（默认 2；0 = 关掉传播）、
     * maxStates（默认 64；0 = 关掉传播）、maxFieldNeighbors（默认 4）、decay（γ，默认 0.6）、
     * backflowRho（ρ，默认 0.15）、bonusCap（图奖励硬上限，默认 0.018）、
     * bonusScale（标签激活 → 记忆奖励的 K，默认 1）、activationMin（默认 0.05）。
     * 缺省一律用 pure.ts 的模块级默认常数（见 resolveGraphOptions）。
     * 注意：图奖励只是**辅助**，有硬上限、只奖不罚；rel 仍是词法 BM25 分，不受图影响。
     */
    graph?: GraphOptions;
    /**
     * I4a：稳定记忆索引注入开关与预算
     * （默认 enabled=true / maxChars=240 / topTags=3 / anchorMaxDfRatio=0.3）。
     * I4a.2 起锚点先过**出现率资格过滤**（含该标签的记录数 / 总记录数 > anchorMaxDfRatio 的标签
     * 不参与），避免覆盖全库的公共标签（例如「坑位」）霸占每一步的上下文；
     * 合格锚点不足就如实少给，一个都没有就写「无可区分锚点」，**绝不回落到全库最高频标签**。
     * 只影响「往 prompt 尾部动态块注入的那一行」，**不改变任何写入/召回契约**。
     * 关掉（enabled:false）时不注册、不输出任何字符。
     */
    injection?: InjectionConfig;
}
/** DSH_HOME 解析：显式配置 > 环境变量 > 默认（空串/空白一律视为未设）。 */
export declare function resolveHome(cfg?: MemoryConfig): string;
export declare function memoryDir(cfg?: MemoryConfig): string;
export declare function memoryPath(cfg?: MemoryConfig): string;
export declare function resolveMaxRecords(cfg?: MemoryConfig): number;
export declare function resolveMaxBytes(cfg?: MemoryConfig): number;
/**
 * 单条记录上限（字节）：显式配置 > 环境变量 DSH_AGENT_MEMORY_MAX_RECORD_BYTES > maxBytes 的 10%。
 * 存在的理由：淘汰是按**字节数**做的，若允许一条超大记录进来，淘汰会把整库挤空来给它腾地方。
 * 至少为 1 字节（maxBytes 极小时也不会退化成「什么都写不进去」之外的行为）。
 */
export declare function resolveMaxRecordBytes(cfg?: MemoryConfig): number;
export declare function nowMs(cfg?: MemoryConfig): number;
export declare function newRecordId(cfg: MemoryConfig | undefined, now: number): string;
/** NDJSON 序列化：一行一条 JSON，末行带换行；空库为 0 字节。 */
export declare function serialize(records: ReadonlyArray<MemoryRecord>): string;
export declare function byteLength(text: string): number;
/** 单条记录序列化后的真实字节数（NDJSON 一行，不含行尾换行）。 */
export declare function recordBytes(rec: MemoryRecord): number;
export type RecordSizeCheck = {
    ok: true;
    bytes: number;
    limit: number;
} | {
    ok: false;
    bytes: number;
    limit: number;
};
/**
 * 单条上限检查（纯计算，不落盘）：
 * 超过上限即失败关闭 —— 调用方必须直接拒收，**不得落盘、不得触发任何淘汰**。
 */
export declare function checkRecordSize(rec: MemoryRecord, cfg?: MemoryConfig): RecordSizeCheck;
/** 单条记录超过上限：失败关闭，不落盘、不触发任何淘汰。 */
export declare class RecordTooLargeError extends Error {
    readonly code = "record-too-large";
    readonly bytes: number;
    readonly limit: number;
    readonly maxBytes: number;
    constructor(bytes: number, limit: number, maxBytes: number);
}
/** 库文件在「加载 → 落盘」之间被外部改动：失败关闭，绝不覆盖对方的内容。 */
export declare class StoreChangedExternallyError extends Error {
    readonly code = "store-changed-externally";
    readonly path: string;
    readonly expected: StoreStamp;
    readonly actual: StoreStamp | undefined;
    constructor(path: string, expected: StoreStamp, actual: StoreStamp | undefined);
}
/** 一次完整读盘：记录 + 文件身份快照（文件不存在时 stamp 为 undefined）。 */
export interface LoadSnapshot {
    records: MemoryRecord[];
    stamp?: StoreStamp;
}
/**
 * 读全库并记下文件身份快照；文件不存在返回空数组 + 无 stamp（首次写入不算「外部改动」）。
 * 坏行跳过并保留其余（不因一行损坏丢整库）。
 */
export declare function loadSnapshot(cfg?: MemoryConfig): LoadSnapshot;
/** 读全库（不关心文件身份时的便捷入口）。 */
export declare function loadRecords(cfg?: MemoryConfig): MemoryRecord[];
/**
 * 便宜的文件身份探测（只 stat、**不读内容**）：文件不存在或无法 stat 时返回 undefined。
 * I4a 的只读缓存用它做 `{path, size, mtimeMs}` 的命中判定 —— 与上面的外部改动守卫
 * 共用同一套身份口径（StoreStamp），所以缓存不会比库自己的判据更乐观。
 */
export declare function statStamp(cfg?: MemoryConfig): StoreStamp | undefined;
export interface SaveResult {
    path: string;
    count: number;
    bytes: number;
}
/**
 * 原子写：先写同目录临时文件，再 rename 覆盖正式文件。
 * 任一步抛错 ⇒ 清掉临时文件并向上抛；正式文件保持旧内容（绝不半写覆盖）。
 *
 * 外部改动守卫（补 3）：调用方传了加载时的 stamp 时，rename 之前先重新 stat，
 * 与加载时不一致（size 或 mtimeMs 变了，或文件竟已消失）⇒ 抛 StoreChangedExternallyError，
 * **绝不覆盖**对方写进去的内容。expect 为 undefined 表示「加载时文件不存在」（首次写入）⇒ 不做判定。
 */
export declare function saveRecords(records: ReadonlyArray<MemoryRecord>, cfg?: MemoryConfig, expect?: StoreStamp): SaveResult;
/** 淘汰分：recency * (1 + hits)，越小越先被淘汰。 */
export declare function evictionScore(rec: MemoryRecord, now: number, halfLifeDays?: number): number;
export interface CapResult {
    records: MemoryRecord[];
    evicted: MemoryRecord[];
    maxRecords: number;
    maxBytes: number;
}
/**
 * 上限执行：先按条数、再按字节数淘汰，淘汰顺序一律由 evictionScore 升序决定
 * （同分按 id 字典序 ⇒ 确定性）。字节判定用序列化后真实字节数。
 */
export declare function enforceCaps(records: ReadonlyArray<MemoryRecord>, cfg?: MemoryConfig, now?: number): CapResult;
export interface AppendResult {
    record: MemoryRecord;
    kept: MemoryRecord[];
    evicted: MemoryRecord[];
    countBefore: number;
    countAfter: number;
    bytes: number;
    path: string;
    maxRecords: number;
    maxBytes: number;
}
/**
 * 追加一条（读-改-写整体串行由调用方的队列保证）并立刻执行上限淘汰，最后原子落盘。
 *
 * 单条上限（补 1）：淘汰是按字节数做的，一条超大记录进来会导致**整库被挤空**；
 * 所以这里在淘汰之前先量这一条的字节数，超限立即抛 RecordTooLargeError
 * ⇒ 不落盘、不触发任何淘汰、库保持原样。
 */
export declare function appendRecord(draft: MemoryDraft, cfg?: MemoryConfig): AppendResult;
export interface BumpResult {
    hits: Record<string, number>;
    count: number;
    bytes: number;
    evicted: MemoryRecord[];
}
/** 给被 expand 取回的记录累加 hits 并落盘（hits 是淘汰分的因子，必须持久化）。 */
export declare function bumpHits(ids: ReadonlyArray<string>, cfg?: MemoryConfig): BumpResult;
export interface MergeGroup {
    keep: string;
    dropped: string[];
}
export interface PrunePlan {
    records: MemoryRecord[];
    merged: MergeGroup[];
    evicted: MemoryRecord[];
    countBefore: number;
    countAfter: number;
    bytesBefore: number;
    bytesAfter: number;
    maxRecords: number;
    maxBytes: number;
    /** 加载时的文件身份快照；真删落盘时回传给 saveRecords 做外部改动守卫。 */
    stamp?: StoreStamp;
}
/** 合并键：kind + 归一化标题完全一致视为同一条。 */
export declare function mergeKey(rec: MemoryRecord): string;
/**
 * 淘汰 + 合并计划（纯计算，不落盘）。
 * 合并：同 kind 同标题的一组，保留 ts 最新者（同 ts 取 hits 多者，再同取 id 字典序小者），
 * 其余并入并丢弃，保留者累加 hits、标签取有序并集。
 */
export declare function planPrune(cfg?: MemoryConfig): PrunePlan;
/**
 * 进程内串行队列：remember / expand / prune 都是「读-改-写」，并发进来会互相覆盖（丢记录）。
 * 先提交者整体跑完才轮到下一个；dispose 时清空链，不保留闭包引用。
 */
export interface SerialQueue {
    run<T>(task: () => T | Promise<T>): Promise<T>;
    /** 当前队列是否空闲（测试用）。 */
    idle(): boolean;
    /** 丢弃队列引用（dispose 时调用）。 */
    reset(): void;
}
export declare function createQueue(): SerialQueue;
