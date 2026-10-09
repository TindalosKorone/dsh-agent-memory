/**
 * 写入协议校验（失败关闭）。
 *
 * 任何一项不满足 ⇒ 返回 { ok:false, code, text }，**绝不落盘**。
 * text 必须是「模型能照着改」的修复指引：给出违规字段、约束原文、以及一个可用的最小示例。
 */
export declare const KINDS: readonly ["fact", "lesson", "preference", "pointer"];
export type Kind = (typeof KINDS)[number];
/** 一条记忆记录（落盘形状；键序固定，便于人类阅读与 grep）。 */
export interface MemoryRecord {
    id: string;
    ts: number;
    kind: Kind;
    title: string;
    body: string;
    tags: string[];
    source: string;
    /** 被 expand 取回的次数，参与淘汰分 recency * (1 + hits)。 */
    hits: number;
    /**
     * 作用域（本次新增，向后兼容）：约定 `project:<名>`，缺省/旧记录一律视为 `global`。
     * recall 传了 scope 时，只返回 `scope === 该值` **或** `scope === global` 的记录。
     */
    scope: string;
}
/** 通过校验后的待落盘草稿（id/ts/hits 由存储层补）。 */
export interface MemoryDraft {
    kind: Kind;
    title: string;
    body: string;
    tags: string[];
    source: string;
    scope: string;
}
export interface DraftInput {
    kind?: unknown;
    title?: unknown;
    body?: unknown;
    tags?: unknown;
    source?: unknown;
    scope?: unknown;
}
export type Validation = {
    ok: true;
    value: MemoryDraft;
} | {
    ok: false;
    code: string;
    text: string;
};
export declare const TITLE_MIN = 8;
export declare const TITLE_MAX = 120;
export declare const TAG_MIN = 1;
export declare const TAG_MAX = 12;
export declare const TAG_LEN_MAX = 32;
/** scope 的缺省值：不传 scope 就落在这个作用域；recall 传了 scope 时它**永远**被包含。 */
export declare const DEFAULT_SCOPE = "global";
/** scope 长度上限（去空白、净化之后按码元计）。 */
export declare const SCOPE_MAX = 64;
/** 标签归一化：只做 trim + 小写化（不做同义词归一，保证全库稳定复用）。 */
export declare function normalizeTag(tag: string): string;
/**
 * scope 净化（它会被回显到 L1 表头，必须单行、无模板占位）：
 * 去首尾空白，并把 `{{` / `}}` 降级成单个花括号（`{{`/`}}` 在提示词模板里有特殊含义）。
 * 换行由写入校验**拒绝**（fail-closed）；只读路径（recall 的筛选参数）另有 sanitizeScopeArg。
 */
export declare function normalizeScope(raw: string): string;
/**
 * 只读路径（recall 的 scope 筛选参数）的宽松净化：不失败关闭，只保证**永远不会**把
 * 换行/超长串带进表头 —— 剥掉行分隔符、净化占位、截断到 SCOPE_MAX。空串表示「未提供」。
 */
export declare function sanitizeScopeArg(raw: string): string;
/** 可照抄的最小可用调用示例（每个失败指引都带上它）。 */
export declare const EXAMPLE_CALL = "{\"kind\":\"fact\",\"title\":\"\u7528\u6237\u504F\u597D\u6DF1\u8272\u4E3B\u9898\",\"body\":\"\u7528\u6237\u5728\u8BBE\u7F6E\u91CC\u9009\u62E9\u4E86\u6DF1\u8272\u4E3B\u9898\u3002\",\"tags\":[\"preference\",\"ui\"],\"source\":\"session:demo\"}";
/**
 * 校验一条待写入记录。
 * 顺序：kind → title → body → tags → source（先报最靠前的错，指引不互相干扰）。
 */
export declare function validateDraft(input: DraftInput | null | undefined): Validation;
/** 从 NDJSON 单行还原记录；不可用的行返回 undefined（坏行不该拖垮整库）。 */
export declare function normalizeStoredRecord(value: unknown): MemoryRecord | undefined;
