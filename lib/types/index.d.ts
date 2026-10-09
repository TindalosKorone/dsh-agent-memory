/**
 * dsh-agent-memory — 面向 agent 的记忆层（I1 地基 + I2 分诊 + I4a 稳定索引注入）。
 *
 * 设计取舍：
 *  - **只做工具面 + 一条条件规则 + 一行稳定索引**：工具面仍是 4 个（remember / recall / expand / prune）；
 *    I4a 往 systemPrompt 的**尾部动态块**（runtime context，落点是本轮消息列表尾部的一条 user 消息）
 *    注入**一行**与查询无关、低频变化的记忆索引（条数 + 这是什么 + 什么时候该用 + 锚点）；
 *    I4a.3 把同一条「条件规则」另外注册成 prompt 的**稳定段**（section，见下）；两条贡献见 src/inject.ts；
 *  - **窄**：分层披露 L1 索引与 L2 正文，recall 绝不返回 body（省 token，也逼模型显式 expand）；
 *  - **失败关闭**：写入协议任一不满足即拒收且**不落盘**，并给出可照抄的修复指引；
 *  - **注入失败则开放（fail-open）**：读库/解析/注册任何异常都只降级成空串，**绝不抛**——
 *    一个抛异常的注入会毁掉每一步（引擎 assemble() 会跟着抛）；
 *  - **注入松耦合（I4a.1）**：`inject` 只声明 `tools`；`systemPrompt` 走
 *    `ctx.inject(['systemPrompt'], (scope) => ...)` 条件注册 ⇒ 缺 systemPrompt 时
 *    「只少一块注入」，而不是整个插件（含 4 个工具）都不 apply；
 *  - **不无限增长**：maxRecords / maxBytes 硬上限 + 按 recency*(1+hits) 淘汰；
 *  - **输出无损 JSON**：返回值过 prune()；`render` 写在 `output` 内部（同级写等于没给）。
 */
import type { Context } from '@deepseek-ai/cordis';
import { type MemoryRecord } from './protocol.js';
import { RecordTooLargeError, StoreChangedExternallyError, type MemoryConfig } from './store.js';
import { type MatchLevel } from './pure.js';
export declare const name = "@dsh-agent/dsh-agent-memory";
/**
 * 必需服务：**只有 `tools`**（4 个工具的注册面）。工具面是底线。
 *
 * I4a.1（本次改动）：注入面从「硬依赖」改成「松耦合」。
 *  - 旧写法是 `inject = ['tools', 'systemPrompt']`。cordis 的 `inject` 是**必需依赖**：
 *    fiber 只有在每个名字都解析到实现后才从 PENDING 迁出并执行 apply()
 *    （cordis/lib/index.js:1317-1330 `_refresh()`）⇒ 只要 `systemPrompt` 缺席，
 *    **整个插件（包含 4 个本来能用的工具）都不会 apply**。一个**可选**的注入能力
 *    就这样把**工具面的可用性**一起拖下水 —— 这是本次要修的问题。
 *  - 这不是假想风险：我们刚被同类问题咬过 —— `ctx.shell.run` 在引擎 0.1.7 里改名，
 *    结果依赖它的那条通道**从装上那天起就是死的**（依赖面漂移是静默的：没有报错，
 *    只是能力永远不生效，直到有人专门去查）。
 *  - 现在 `systemPrompt` 改走官方惯例的条件注册 `ctx.inject(['systemPrompt'], (scope) => {...})`：
 *    缺席时回调永不执行，插件照常 apply、4 个工具照常可用，代价仅仅是「少一块注入」。
 */
export declare const inject: string[];
/** recall 的 L1 输出总长硬上限（字符）。 */
export declare const RECALL_MAX_CHARS = 2000;
/** recall 单次取回条数上限。 */
export declare const RECALL_LIMIT_MAX = 50;
/**
 * L1 行的列清单 —— **唯一来源**（列名 + 列序都在这里，别再抄第二遍）。
 *
 * 四处都从它派生（或按它的顺序对齐），因此结构上不可能互相漂移：
 *  - 渲染：`recallCells` 用 `Record<RecallColumn, string>` 的取值表 + `formatL1` 的
 *    `RECALL_COLUMNS.map(...)` 拼接 ⇒ 列数恒 == RECALL_COLUMNS.length，列序恒 == 数组顺序；
 *    少给一列 tsc 直接报错，往数组里加一列而取值表没跟上也直接报错；
 *  - 取值表键序：`recallCells` 的字面量键序（由 test/columns.test.mjs 运行时断言钉住）；
 *  - 结构化行：`L1Row` 的字段序与输出 schema 里 `rows.properties` 的键序（同样由该用例钉住）；
 *  - 工具描述：memory_recall 的 description 里那串列清单是 `${RECALL_COLUMNS.join(' | ')}`；
 *  - 表头：`列序:${RECALL_COLUMNS.join('|')}`。
 *
 * 列序不可随手挪（I3 的三步试错结论）：
 *  - `score` **恒在末位**（既有读者按 `-1` 取分数）；
 *  - rel/cov/match 仍在最后四列里 ⇒ 它们的行尾相对下标 -4/-3/-2 不变；
 *  - 前三列 id/kind/title/tags 不动 ⇒ 行首解析不变。
 *  因此 I3 的两列 `graph | via` 只能插在 tags 与 rel 之间。
 */
export declare const RECALL_COLUMNS: readonly ["id", "kind", "title", "tags", "graph", "via", "rel", "cov", "match", "score"];
/** L1 行的列分隔符（` | `，竖线两侧各一个空格）。 */
export declare const RECALL_COLUMN_SEP = " | ";
/** 列名联合类型（由 RECALL_COLUMNS 派生）：formatL1 的取值表用它做穷尽性检查。 */
export type RecallColumn = (typeof RECALL_COLUMNS)[number];
/**
 * 候选数 <= 该值时跳过多样性重排（第三方做法：小候选集只重排、拿不到多样性收益、纯添乱）。
 * 与 pure.ts 的 diversify.minCandidates 对应；召回层显式传 5。
 */
export declare const DIVERSITY_MIN_CANDIDATES = 5;
/** memory_expand 的一条 L2 结果（含 body）。 */
export interface ExpandedRecord {
    id: string;
    kind: string;
    title: string;
    body: string;
    tags: string[];
    source: string;
    ts: number;
    hits: number;
}
/**
 * 一条 L1 的打分视图。**注意是两种标度，表头必须写清**：
 *  - `rel`   = BM25 **原始相关度**（绝对标度，不随批次归一化），`match` 就是拿它与阈值比出来的
 *              ⇒ 读者可用打印的 rel 自行验算 match（I1.3 自证要求）；
 *  - `score` = `disp(final)` 映射到 0..1 的**展示分**（仅用于排序展示，与 rel 不同标度），
 *              其中 `final = (rel + graph) × 多样性因子`。多样性因子 = `1 − β·maxSim`
 *              （β 默认 0.3、maxSim = 与已选行的最大标签 Jaccard），**只在候选数 > 5 时施加**
 *              （否则恒为 1）⇒ 多样性启用时 `score` 无法仅由打印的 rel/graph 精确复算。
 * I3 追加两列诊断：`graph`（图奖励，已应用硬上限）与 `via`（来源：direct / tag:<标签>）。
 * 列序**不在这里重复**：唯一来源是 `RECALL_COLUMNS`（`RECALL_COLUMNS.join(' | ')`），
 * 渲染见 formatL1、工具文案见 memory_recall 的 description、表头见下面构造处的「列序:」段。
 */
export interface L1ScoreView {
    /** 最终展示分 disp(final)（final=(rel+graph)×多样性因子；按它降序 ⇒ 打印天然单调不增）。 */
    score: number;
    /** 惩罚前的 BM25 原始相关度（**判定 match 所依据的量**；与 score 不同标度）。 */
    rel: number;
    /** VCP 式标签覆盖率（I1.2 仅诊断，不门控）。 */
    cov: number;
    /** 绝对判定：raw 与 WEAK_THRESHOLD / STRONG_THRESHOLD 比较。 */
    match: MatchLevel;
    /** I3 图奖励（已应用硬上限 GRAPH_BONUS_CAP；无图证据恰好为 0）。 */
    graph: number;
    /** I3 来源标记：`direct`（词法直接命中）或 `tag:<标签>`（由标签图传播到达）。 */
    via: string;
}
/**
 * 召回的结构化行（与 lines 一一对应，便于消费方不用解析字符串）。
 *
 * 字段序**必须**与 `RECALL_COLUMNS` 一致（同一份列清单不养第二个顺序）：本次对账把 I3 遗留的
 * 旧序（`… rel, cov, match, graph, via, score`）对齐到打印列序。纯顺序调整 —— 字段名/类型/
 * 必填性一个字不改；由 test/columns.test.mjs 的 `Object.keys(rows.properties)` 断言钉住。
 */
export interface L1Row {
    id: string;
    kind: string;
    title: string;
    tags: string[];
    graph: number;
    via: string;
    rel: number;
    cov: number;
    match: MatchLevel;
    score: number;
}
/**
 * 每条 L1 行：`RECALL_COLUMNS.join(' | ')`（列名与列序的唯一来源就是 RECALL_COLUMNS，本注释不再抄一遍）。**不含 body**。
 *
 * 约定（列序是三步试出来的，别随手挪）：
 *  - 既有 8 列的名称/含义/相对位置**一个字不改**（rel 仍是 BM25 原始相关度、cov 仍是覆盖率、
 *    match 仍是绝对判定、score 仍是展示分），且 **score 仍在行尾**；
 *  - I3 的两列 `graph | via` 插在 tags 与 rel 之间，理由：
 *    ① 行尾仍是 score ⇒ 「行尾是分数」的既有契约与既有读者按 `-1` 取分数的用法逐字不变；
 *    ② rel/cov/match 的行尾相对下标（-4/-3/-2）也逐字不变（它们仍在最后四列里）；
 *    ③ 前三列（id/kind/title/tags）不动 ⇒ 行首解析不变。
 *    如果把新列插在 match 与 score 之间或追加在尾部，①②必坏其一（要么行尾不再是分数，
 *    要么既有列的整体下标位移，既有读者会静默读错列）。
 *  - 表头（单一表头行）必须写明列序与绝对标度常数；I5 减肥后它只保留**可复算所必需**的信息
 *    （列序 / rel 语义与 match 依据 / 两个阈值 / disp(final) 公式与两个标度常数 / limit 是硬显示
 *    上限 / I2 结论 novelty·阈值·expanded·kBase->kUsed / 低置信 cov_max·激活阈值 / I3 结论
 *    final=rel+graph·graph 硬上限·图规模·枢纽被压数·reachable），详见下面构造处的注释；
 *  - final = (rel + graph) × 多样性因子：多样性因子只在候选数 > 5 时施加（否则恒为 1），
 *    因此**多样性启用时 score 无法仅由打印的 rel/graph 精确复算**；rel = BM25 原始相关度
 *    （match 只依据它，恒可由 rel + 表头阈值复算）。
 */
export declare function formatL1(rec: MemoryRecord, view: L1ScoreView): string;
/**
 * L1 行的**取值表**（列名 → 打印文本）。抽成独立函数是为了让「键序」也能被运行时断言：
 * `Object.keys(recallCells(...))` 必须逐项等于 `RECALL_COLUMNS`（test/columns.test.mjs）。
 *
 * 取值表按**列名**给全：`Record<RecallColumn, string>` 是穷尽性检查 ——
 * RECALL_COLUMNS 少改/多加一列而这里没跟着改，tsc 立刻报错（不是运行时静默漂移）。
 */
export declare function recallCells(rec: MemoryRecord, view: L1ScoreView): Record<RecallColumn, string>;
/**
 * 按字符上限裁剪 L1 行；被截断时追加如实说明（且说明本身也算进上限 ⇒ 总长不会超）。
 */
export declare function fitLines(header: string, lines: ReadonlyArray<string>, limit: number): {
    lines: string[];
    text: string;
    truncated: boolean;
};
/**
 * 「单条过大」的失败指引：给出当前上限、这条多少字节、以及可照做的两种做法。
 * 失败关闭 —— 本次不落盘，也不触发任何淘汰。
 */
export declare function tooLargeText(err: RecordTooLargeError): string;
/** 「库被外部改动」的失败指引：给出加载时/落盘前两边的身份，并指向「重新读取后再写」。 */
export declare function externalChangeText(err: StoreChangedExternallyError): string;
export declare function apply(ctx: Context, config?: MemoryConfig): void;
