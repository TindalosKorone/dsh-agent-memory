import { defineTool } from '@deepseek-ai/dsh-tools';
import { RENDER, prune } from './json.js';
import { KINDS, validateDraft } from './protocol.js';
import { appendRecord, bumpHits, byteLength, createQueue, loadRecords, memoryPath, nowMs, planPrune, resolveMaxBytes, resolveMaxRecords, saveRecords, serialize, RecordTooLargeError, StoreChangedExternallyError, } from './store.js';
import { cmpId, decay, diversify, absoluteDisp, lexicalScore, matchLevel, matchLevelGated, rrf, corpusStats, tagCoverage, resolveScoreOptions, resolveTriageOptions, residualPyramid, resolveGraphOptions, tagGraphIndex, propagateTags, memoryGraphRewards, tokenize, queryContentTokens, calibrationDrift, CALIBRATION_RECORDS, CALIBRATION_DATE } from './pure.js';
import { INJECTION_CONTEXT_NAME, INJECTION_CONTEXT_ORDER, INJECTION_HABIT_TEXT, INJECTION_SECTION_NAME, INJECTION_SECTION_ORDER, buildInjectionIndex, createInjectionCache, sanitizeForPrompt, resolveInjectionOptions, } from './inject.js';
export const name = '@dsh-agent/dsh-agent-memory';
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
export const inject = ['tools'];
/** recall 的 L1 输出总长硬上限（字符）。 */
export const RECALL_MAX_CHARS = 2000;
/** recall 单次取回条数上限。 */
export const RECALL_LIMIT_MAX = 50;
/**
 * L1 表头的**总长硬上限（字符）** —— 这个界必须对**任意查询串**成立（修正 1）。
 *
 * 旧声明是「<= 400」，但表头里回显 `query=`，长度**随查询串增长**：
 *  - 短查询（`alpha`）+ 默认标度 = 399 字符；换一组标度常数（回显宽度变大）就到 405~413；
 *  - 长查询（200 个含 `"`/`\`/换行的字符）实测 742 字符，500 字符查询 932 字符 ——
 *    即「<= 400」从未被最坏情况验过，是一句没成立的旧声明。
 * 现在表头 = **固定部分**（与查询无关；长度由库规模与标度常数的回显宽度决定）
 *          + **有界的 query 回显**（先按码点截断原始 query，再 JSON 转义，并标注已截断）。
 * 回显的预算由 `HEADER_MAX_CHARS` 减去固定部分**现算**（不是常数），因此
 * 「表头总长 <= HEADER_MAX_CHARS」是由构造保证的，与查询长度无关。
 *
 * 取值依据（本机实测，2026-10-09 标定漂移提示落地后重测）：固定部分在「默认标度 + 3 条库」下，
 * 关掉标定漂移段是 **372 字符**、含漂移段是 **419**（漂移段约 47：`标定204条@2026-10-09,现值N条,建议重跑calibrate --write`）。
 * 固定部分的最坏观测是「`Number.MAX_VALUE` 极值常数 + 两位数库规模 + 漂移段」下的 **434**。
 * 于是表头 = 9（`L1:query=`）+ 查询回显 + 1（分隔）+ 固定部分 <= 9 + 2 + 1 + 434 = 446（预算被现算夹到下限 2）；
 * 实测最坏 **448**（MAX_VALUE 常数 + 240 字符边界查询 + 60 条库，漂移段必现）。
 * 余量只有 0~1 个字符，**往表头加文本前必须先跑 test/header.test.mjs 的最坏情况两条用例**。
 * 覆盖最坏情况的用例见 test/header.test.mjs 的「长查询/边界字符」段与「固定部分」段。
 */
export const HEADER_MAX_CHARS = 448;
/**
 * 表头里**标度常数回显**的宽度上限（字符）。
 *
 * 四个常数（scaleA/scaleB/weak/strong）在表头里共出现 5 次，它们的十进制宽度由**配置**决定，
 * 不是常数：`0.0187` 是 6 字符，而 `0.12345678901234568` 是 19 字符、`Number.MAX_VALUE` 是 23 字符。
 * 22 位小数的标度配置就能把固定部分从 382 顶到 413（本机实测）——这正是「<= 400」失效的第二条路径。
 * 因此这里给回显**定宽**：`String(n)` 放得下就精确回显；放不下就用 `≈` 标注为**近似值**并降精度
 * （精确值一个都没丢，仍逐字在结构化字段 scaleA/scaleB/weakThreshold/strongThreshold 上）。
 */
export const HEADER_CONST_MAX_CHARS = 9;
/** query 回显被截断时的标记（单行、如实标注「已截断」）。 */
export const HEADER_QUERY_TRUNCATION_MARK = '…(截断)';
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
export const RECALL_COLUMNS = ['id', 'kind', 'title', 'tags', 'graph', 'via', 'rel', 'cov', 'match', 'score'];
/** L1 行的列分隔符（` | `，竖线两侧各一个空格）。 */
export const RECALL_COLUMN_SEP = ' | ';
/**
 * 候选数 <= 该值时跳过多样性重排（第三方做法：小候选集只重排、拿不到多样性收益、纯添乱）。
 * 与 pure.ts 的 diversify.minCandidates 对应；召回层显式传 5。
 */
export const DIVERSITY_MIN_CANDIDATES = 5;
const KIND_ENUM = [...KINDS];
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
 *    （列序 / rel 语义与 match 依据 / 两个阈值 / **内容量闸门的两个输入** / disp(final) 公式与两个标度常数
 *    / limit 是硬显示上限 / I2 结论 novelty·阈值·expanded·kBase->kUsed / 低置信 cov_max·激活阈值 / I3 结论
 *    final=rel+graph·graph 硬上限·图规模·枢纽被压数·reachable），详见下面构造处的注释；
 *  - final = (rel + graph) × 多样性因子：多样性因子只在候选数 > 5 时施加（否则恒为 1），
 *    因此**多样性启用时 score 无法仅由打印的 rel/graph 精确复算**；rel = BM25 原始相关度，
 *    match 由 rel + 两个阈值 + **内容量闸门**共同判定（三者都在表头/结构化字段上 ⇒ 恒可复算）。
 */
export function formatL1(rec, view) {
    const cells = recallCells(rec, view);
    // 列数与列序**只**由 RECALL_COLUMNS 决定（含「score 恒在末位」）。
    return RECALL_COLUMNS.map((col) => cells[col]).join(RECALL_COLUMN_SEP);
}
/**
 * L1 行的**取值表**（列名 → 打印文本）。抽成独立函数是为了让「键序」也能被运行时断言：
 * `Object.keys(recallCells(...))` 必须逐项等于 `RECALL_COLUMNS`（test/columns.test.mjs）。
 *
 * 取值表按**列名**给全：`Record<RecallColumn, string>` 是穷尽性检查 ——
 * RECALL_COLUMNS 少改/多加一列而这里没跟着改，tsc 立刻报错（不是运行时静默漂移）。
 */
export function recallCells(rec, view) {
    return {
        id: rec.id,
        kind: rec.kind,
        title: rec.title,
        tags: rec.tags.join(','),
        graph: view.graph.toFixed(4),
        via: view.via,
        rel: view.rel.toFixed(4),
        cov: view.cov.toFixed(4),
        match: view.match,
        score: view.score.toFixed(4),
    };
}
/**
 * 按字符上限裁剪 L1 行；被截断时追加如实说明（且说明本身也算进上限 ⇒ 总长不会超）。
 */
export function fitLines(header, lines, limit) {
    const body = (n) => {
        const kept = [];
        let size = header.length;
        for (const line of lines) {
            if (size + 1 + line.length > n)
                break;
            kept.push(line);
            size += 1 + line.length;
        }
        return { kept, text: header + (kept.length > 0 ? '\n' + kept.join('\n') : '') };
    };
    const full = body(limit);
    if (full.kept.length === lines.length)
        return { lines: full.kept, text: full.text, truncated: false };
    const note = `\n...(已截断：命中 ${lines.length} 条，本次仅显示前 ${full.kept.length} 条；要更多请提高 limit，要正文请用 memory_expand)`;
    const clipped = body(Math.max(0, limit - note.length));
    const text = clipped.text + note;
    return { lines: clipped.kept, text, truncated: true };
}
/**
 * 把表头里的标度常数回显成**宽度有界**的片段（修正 1）。
 *
 * 为什么不直接 `String(n)`：那正是「<= 400」失效的第二条路径 —— 常数的十进制宽度由配置决定，
 * 一个 22 位小数的 scaleB 就能把固定部分顶过 400。这里保证 `返回值.length <= maxChars`：
 *  - `String(n)` 放得下 ⇒ 原样返回（**精确**，可复算）；
 *  - 放不下 ⇒ 以 `≈` 开头、逐级降精度（toExponential(3..0)）取第一个放得下的形式 ⇒ 明确标注为**近似值**。
 * 精确值仍逐字在结构化字段上（scaleA/scaleB/weakThreshold/strongThreshold），没有丢。
 * 最坏情况（`Number.MAX_VALUE`、负数）在 toExponential(0) 处一定放得下（`≈-2e+308` = 8 字符）。
 */
export function formatHeaderConstant(n, maxChars = HEADER_CONST_MAX_CHARS) {
    const exact = String(n);
    if (exact.length <= maxChars)
        return exact;
    for (let precision = 3; precision >= 0; precision -= 1) {
        const approx = `≈${n.toExponential(precision)}`;
        if (approx.length <= maxChars)
            return approx;
    }
    // toExponential(0) 的理论上界是 8 字符（`≈-2e+308`）；真到这里说明 maxChars 被配得过小。
    return `≈${n.toExponential(0)}`.slice(0, Math.max(1, maxChars));
}
/**
 * 把原始查询串格式化进表头的 `query=` 回显槽（修正 1）。
 *
 * 纪律（顺序不能反）：
 *  1. **先按码点截断原始 query**（用 `Array.from`，绝不在 UTF-16 代理对中间切，否则会造出孤立代理）；
 *  2. **再对截断后的串做 `JSON.stringify` 转义** —— 绝不先转义再切，那会切断 `\"`、`\\`、`\n`、`\u00XX`
 *     这类转义序列，产生非法文本或改变语义；
 *  3. 转义后长度超过 `budget` 就继续缩短（逐码点回退），直到放得下，并如实标注 `…(截断)`。
 *
 * 因此 `返回值.text.length <= budget` **恒成立**（与查询长度无关），且结果永远单行
 * （换行/回车等控制字符都被 JSON 转义成两字符或 `\u00XX`，不可能留下裸换行）。
 * 完整查询串仍在结构化字段 `query` 上，一个字符都没丢。
 */
export function formatHeaderQuery(query, budget) {
    const points = Array.from(query);
    let text = JSON.stringify(query);
    if (text.length <= budget)
        return { text, truncated: false };
    // 每个码点转义后**至少**占 1 个字符 ⇒ 放得下的前缀绝不可能长过 budget；据此设起点，
    // 既拿到「最大的放得下的前缀」，又把回退次数钉在 O(budget)（不会因超长查询变成平方复杂度）。
    let keep = Math.min(points.length, Math.max(0, budget));
    while (keep > 0) {
        keep -= 1;
        text = JSON.stringify(points.slice(0, keep).join('') + HEADER_QUERY_TRUNCATION_MARK);
        if (text.length <= budget)
            return { text, truncated: true };
    }
    // 连「只剩标记」都放不下（预算极小）时，退化为空串回显 —— 仍是合法的 JSON 字符串字面量。
    return { text: JSON.stringify(''), truncated: true };
}
/**
 * 「单条过大」的失败指引：给出当前上限、这条多少字节、以及可照做的两种做法。
 * 失败关闭 —— 本次不落盘，也不触发任何淘汰。
 */
export function tooLargeText(err) {
    return '写入被拒（失败关闭，未落盘，也未触发任何淘汰）。\n'
        + `- 违规项：本条记录序列化后 ${err.bytes} 字节，超过单条上限 ${err.limit} 字节\n`
        + `- 规则：单条上限默认为 maxBytes 的 10%（当前 maxBytes=${err.maxBytes} 字节，可用 DSH_AGENT_MEMORY_MAX_RECORD_BYTES 覆盖）；`
        + '因为淘汰按字节数进行，放一条超大记录进来会把整库挤空，所以直接拒收\n'
        + `- 修复（任选其一）：① 拆成多条更小的记忆分次写入（每条 <= ${err.limit} 字节；先精简 body 或分段）；`
        + `② 确实需要更大的单条时显式提高上限后重试：DSH_AGENT_MEMORY_MAX_RECORD_BYTES=${err.bytes}\n`
        + '- 本次未写入任何内容，库内记录保持原样';
}
/** 「库被外部改动」的失败指引：给出加载时/落盘前两边的身份，并指向「重新读取后再写」。 */
export function externalChangeText(err) {
    const actual = err.actual === undefined
        ? '文件已消失'
        : `size=${err.actual.size}, mtimeMs=${err.actual.mtimeMs}`;
    return '写入被拒（失败关闭，未落盘）：库文件在你加载之后被其他进程/工具改过，'
        + '为避免覆盖对方的写入，本次不覆盖、直接拒写。\n'
        + `- 文件：${err.path}\n`
        + `- 加载时：size=${err.expected.size}, mtimeMs=${err.expected.mtimeMs}\n`
        + `- 落盘前：${actual}\n`
        + '- 修复：重新读取后再写（先调 memory_recall 或再调一次本工具拿到最新库况，然后重试）；本次拒写对库没有任何影响';
}
export function apply(ctx, config = {}) {
    const host = ctx;
    // 配置注入（测试用它把 FsOps 接缝塞进来做并发度观测 / 故障注入）；默认全走真 fs 与真时钟。
    const cfg = { ...config };
    const queue = createQueue();
    // 副作用清理：串行队列持有 promise 链与闭包引用，dispose 时清空（不残留）。
    if (typeof host.effect === 'function') {
        host.effect(() => () => { queue.reset(); }, `${name}:serial-queue`);
    }
    /** 失败时的库况回执（不含 body）。 */
    const stats = () => {
        const records = loadRecords(cfg);
        return { total: records.length, bytes: byteLength(serialize(records)) };
    };
    // ── 工具 1：写入 ─────────────────────────────────────────────────────────
    host.tools.register(defineTool({
        name: 'memory_remember',
        description: '写入一条长期记忆并落盘。写入协议失败关闭：kind 必须是 fact/lesson/preference/pointer；'
            + 'title 单行且去空白后 8..120 字符；body 非空；tags 有序不重复 1..12 个、每个 1..32 字符；source 非空。'
            + '任何一项不满足会返回 ok=false + 可直接照做的修复指引，且不落盘。返回新 id、当前总数与占用字节。',
        parameters: {
            kind: { type: 'string', enum: KIND_ENUM, required: true, description: '记忆类型：fact 事实 / lesson 教训 / preference 偏好 / pointer 指针（指路到文件或 URL）' },
            title: { type: 'string', required: true, description: '单行标题，去首尾空白后 8..120 字符，不得含换行' },
            body: { type: 'string', required: true, description: '正文（L2，只有 memory_expand 才取回），非空' },
            tags: { type: 'array', items: { type: 'string' }, required: true, description: '有序标签，1..12 个，每个 1..32 字符，不得重复（全库稳定复用，只做 trim + 小写化）' },
            source: { type: 'string', required: true, description: '出处，非空：session:xxx / file:path / url:https://...' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    code: { type: 'string', required: true },
                    id: { type: 'string' },
                    total: { type: 'integer', required: true },
                    bytes: { type: 'integer', required: true },
                    maxRecords: { type: 'integer', required: true },
                    maxBytes: { type: 'integer', required: true },
                    evicted: { type: 'integer', required: true },
                    evictedIds: { type: 'array', items: { type: 'string' }, required: true },
                    text: { type: 'string', required: true },
                },
            },
            render: RENDER,
        },
        execute: async (rawArgs) => queue.run(() => {
            const args = (rawArgs ?? {});
            const maxRecords = resolveMaxRecords(cfg);
            const maxBytes = resolveMaxBytes(cfg);
            const check = validateDraft({ kind: args.kind, title: args.title, body: args.body, tags: args.tags, source: args.source });
            if (!check.ok) {
                const s = stats();
                return prune({
                    ok: false,
                    code: check.code,
                    id: undefined,
                    total: s.total,
                    bytes: s.bytes,
                    maxRecords,
                    maxBytes,
                    evicted: 0,
                    evictedIds: [],
                    text: check.text,
                });
            }
            // 两道失败关闭闸门（单条过大 / 库被外部改动）：都不落盘、都不触发淘汰。
            const failBox = (code, text) => {
                const s = stats();
                return prune({
                    ok: false,
                    code,
                    id: undefined,
                    total: s.total,
                    bytes: s.bytes,
                    maxRecords,
                    maxBytes,
                    evicted: 0,
                    evictedIds: [],
                    text,
                });
            };
            let result;
            try {
                result = appendRecord(check.value, cfg);
            }
            catch (err) {
                if (err instanceof RecordTooLargeError)
                    return failBox('record-too-large', tooLargeText(err));
                if (err instanceof StoreChangedExternallyError)
                    return failBox('store-changed-externally', externalChangeText(err));
                throw err;
            }
            const evictedIds = result.evicted.map((r) => r.id);
            const text = `已落盘：id=${result.record.id}（${result.record.kind}）\n`
                + `- 库内：${result.countBefore} -> ${result.countAfter} 条，占用 ${result.bytes} / ${result.maxBytes} 字节（条数上限 ${result.maxRecords}）\n`
                + `- 落盘文件：${result.path}\n`
                + (evictedIds.length > 0
                    ? `- 触发上限淘汰 ${evictedIds.length} 条（按 score=recency*(1+hits) 最低者）：${evictedIds.join(', ')}`
                    : '- 未触发上限淘汰');
            return prune({
                ok: true,
                code: 'ok',
                id: result.record.id,
                total: result.countAfter,
                bytes: result.bytes,
                maxRecords: result.maxRecords,
                maxBytes: result.maxBytes,
                evicted: evictedIds.length,
                evictedIds,
                text,
            });
        }),
    }));
    // ── 工具 2：召回（只给 L1 索引，绝不返回 body）──────────────────────────
    // 修正 2：描述从 1182 字符压到 <= 300。做法不是「删情报」，而是**把情报移交给契约文档**：
    // 描述只留模型**每次调用都要用**的五件事（列清单 / rel-match-score 语义 / limit 是硬显示上限 /
    // 绝不返回 body / 契约文档指针），其余细则（final=(rel+graph)×多样性因子、施加条件、
    // graph/via 列语义、无词法证据时 rel=0、I2 分诊、低置信语义）逐字留在 docs/recall-contract.md，
    // 由 test/description.test.mjs 对**文档**继续逐条钉住 —— 指针指向的文档必须真的载着这些情报，
    // 否则「指向 docs」本身就是一句谎。
    // 列清单必须仍由 RECALL_COLUMNS 派生（列序是契约，不能在这里手抄第二遍）。
    host.tools.register(defineTool({
        name: 'memory_recall',
        description: '按查询召回记忆索引（L1），**绝不返回 body**（要正文请拿 id 调 memory_expand）。每条一行：'
            + `${RECALL_COLUMNS.join(' | ')}。`
            + 'rel=BM25 原始相关度（match 由 rel、绝对阈值与内容量闸门判定）；score=disp(final)，仅用于排序展示。'
            + '**limit 是硬显示上限**（返回行数恒为 min(limit, 可用候选数)）。完整口径见 docs/recall-contract.md。',
        parameters: {
            query: { type: 'string', required: true, description: '查询串（中文/英文均可；空串/纯空白表示无词元能量、不分诊，只按新鲜度排）' },
            limit: { type: 'integer', description: `显示条数**硬上限**，默认 5，最大 ${RECALL_LIMIT_MAX}（返回行数恒为 min(limit, 可用候选数)）` },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    code: { type: 'string', required: true },
                    query: { type: 'string', required: true },
                    limit: { type: 'integer', required: true },
                    total: { type: 'integer', required: true },
                    matched: { type: 'integer', required: true },
                    shown: { type: 'integer', required: true },
                    truncated: { type: 'boolean', required: true },
                    /** 绝对标度常数与阈值：如实回报本次使用的口径（不随批次变化）。 */
                    scaleA: { type: 'number', required: true },
                    scaleB: { type: 'number', required: true },
                    weakThreshold: { type: 'number', required: true },
                    strongThreshold: { type: 'number', required: true },
                    /**
                     * 内容量闸门（本次新增）：`contentTokens` = 查询里在库内出现过的去重词元数（qTok）；
                     * `contentTokenMin` = 封顶阈值（默认 2）；`gateMargin` = 例外倍数 M（默认 2.0）。
                     * 规则：
                     *   match = qTok=0 ? none
                     *         : qTok < contentTokenMin ? (base=strong 且 rel < gateMargin×strong ? weak : base)
                     *         : matchLevel(rel, weak, strong)
                     * 这三个数就是读者复算 match 所需的**闸门输入**（表头同步逐字回显）。
                     */
                    contentTokens: { type: 'integer', required: true },
                    contentTokenMin: { type: 'integer', required: true },
                    gateMargin: { type: 'number', required: true },
                    /**
                     * 标定漂移（本次新增）：`calibratedAt` = 标定日期（ISO），`calibrationRecords` = 标定时的库条数，
                     * `calibrationDrift` = 当前库条数 − 标定条数（有符号），两个阈值 `calibrationDriftRel`（相对）
                     * 与 `calibrationDriftAbs`（绝对条数）就是复算 `calibrationDriftExceeded` 所需的输入。
                     * 超阈值时**表头**会如实加一句「标定于 N 条(date)，现值 M 条⇒建议重跑 calibrate --write」；
                     * 该提示**只进 recall 表头，绝不进自动注入那行**（注入文本必须稳定）。
                     */
                    calibratedAt: { type: 'string', required: true },
                    calibrationRecords: { type: 'integer', required: true },
                    calibrationDrift: { type: 'integer', required: true },
                    calibrationDriftRel: { type: 'number', required: true },
                    calibrationDriftAbs: { type: 'number', required: true },
                    calibrationDriftExceeded: { type: 'boolean', required: true },
                    diversityBeta: { type: 'number', required: true },
                    diversityApplied: { type: 'boolean', required: true },
                    /**
                     * I2 分诊（残差金字塔）：全部是本查询自己的结论（请求级隔离，不跨请求复用）。
                     * kBase/kUsed 是**内部召回预算**（不是显示承诺）：kUsed = expanded ? min(max(kBase, 2×kBase), 库内条数) : kBase。
                     * 显示行数恒为 min(limit, 可用候选数) —— 扩检索只放大内部候选池，不改变返回行数（I2.1 修 1）。
                     */
                    expanded: { type: 'boolean', required: true },
                    kBase: { type: 'integer', required: true },
                    kUsed: { type: 'integer', required: true },
                    novelty: { type: 'number', required: true },
                    explainedRatio: { type: 'number', required: true },
                    residualRatio: { type: 'number', required: true },
                    basisSize: { type: 'integer', required: true },
                    layers: { type: 'integer', required: true },
                    logicalDepth: { type: 'number', required: true },
                    lowConfidence: { type: 'boolean', required: true },
                    /**
                     * 查询无词元能量（‖q‖²≈0）⇒ 未分诊：novelty=0、expanded=false、kUsed=kBase，
                     * explainedRatio/residualRatio 回显 0/0（0/0 未定义）。表头会如实写明「未分诊」。
                     */
                    noQueryEnergy: { type: 'boolean', required: true },
                    /**
                     * 口径回显（I1.3 可复算铁律）：没有这三个数，读者拿到的 expanded/lowConfidence 复算不出来。
                     * 有词元能量时：expanded ⟺ novelty >= noveltyThreshold；
                     * 无词元能量时（noQueryEnergy=true）**不做分诊**：expanded=false 与阈值无关（表头写明「未分诊」）；
                     * lowConfidence ⟺ covMax < activationThreshold（两种情形都成立）。
                     */
                    noveltyThreshold: { type: 'number', required: true },
                    activationThreshold: { type: 'number', required: true },
                    covMax: { type: 'number', required: true },
                    /**
                     * I3：标签共现图与有界脉冲传播的如实回显（全部是本请求的局部结论）。
                     * graphNodes/graphEdges 是当前库的图规模（两个方向分别计数的有向边数）；
                     * propagatedTags 是本次传播到达并通过激活下限的标签（按激活降序，全量，由 maxStates/maxHops 兜住规模）；
                     * maxHops/maxStates/maxFieldNeighbors 是三条**显式上限**；graphBonusCap 是图奖励硬上限；
                     * hubSuppressed 是被枢纽校正压过的标签（码元升序）；reachable 是图**新增可达**的记忆条数。
                     */
                    graphNodes: { type: 'integer', required: true },
                    graphEdges: { type: 'integer', required: true },
                    propagatedTags: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                tag: { type: 'string', required: true },
                                activation: { type: 'number', required: true },
                            },
                        },
                    },
                    maxHops: { type: 'integer', required: true },
                    maxStates: { type: 'integer', required: true },
                    maxFieldNeighbors: { type: 'integer', required: true },
                    graphBonusCap: { type: 'number', required: true },
                    hubSuppressed: { type: 'array', items: { type: 'string' }, required: true },
                    reachable: { type: 'integer', required: true },
                    /** I3 诊断（可复算传播边界）：种子数、共同展开的状态数、最深跳数、是否撞上 maxStates、有图证据的记忆数。 */
                    graphSeedCount: { type: 'integer', required: true },
                    graphStatesUsed: { type: 'integer', required: true },
                    graphHops: { type: 'integer', required: true },
                    graphStatesTruncated: { type: 'boolean', required: true },
                    graphEvidence: { type: 'integer', required: true },
                    lines: { type: 'array', items: { type: 'string' }, required: true },
                    rows: {
                        type: 'array',
                        required: true,
                        /**
                         * 键序必须与 `RECALL_COLUMNS` 一致（同一份列清单不养第二个顺序）：本次对账把 I3 遗留的
                         * 旧序对齐到打印列序。纯顺序调整 —— 字段名/类型/必填性一个字不改；
                         * 由 test/columns.test.mjs 的 `Object.keys(rows.properties)` 断言钉住。
                         */
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                id: { type: 'string', required: true },
                                kind: { type: 'string', required: true },
                                title: { type: 'string', required: true },
                                tags: { type: 'array', items: { type: 'string' }, required: true },
                                graph: { type: 'number', required: true },
                                via: { type: 'string', required: true },
                                rel: { type: 'number', required: true },
                                cov: { type: 'number', required: true },
                                match: { type: 'string', required: true },
                                score: { type: 'number', required: true },
                            },
                        },
                    },
                    text: { type: 'string', required: true },
                },
            },
            render: RENDER,
        },
        execute: async (rawArgs) => {
            const args = (rawArgs ?? {});
            const query = typeof args.query === 'string' ? args.query : '';
            const rawLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : 5;
            const limit = rawLimit < 1 ? 1 : rawLimit > RECALL_LIMIT_MAX ? RECALL_LIMIT_MAX : rawLimit;
            const records = loadRecords(cfg);
            const now = nowMs(cfg);
            // 打分口径：模块级绝对常数（可经 cfg.score 覆盖），**没有任何批次相关量**。
            const scoreCfg = resolveScoreOptions(cfg.score);
            // ── 标定漂移（本次新增；只影响 recall 表头的如实提示，绝不进自动注入那行）──────────────
            // 标定时的库规模与日期记在 src/pure.ts 的机器可读行（CALIBRATION_RECORDS / CALIBRATION_DATE）。
            // 与**当前库条数**比较：相对偏差 > driftRel 或绝对差 > driftAbs（取先到者）⇒ 表头加一句
            // 「该重跑 calibrate --write 了」。注入行必须稳定（每次写库都改提示词是坏事），所以只放表头。
            const calib = calibrationDrift(records.length, CALIBRATION_RECORDS, scoreCfg.calibrationDriftRel, scoreCfg.calibrationDriftAbs);
            // 语料统计（N / avgdl / df）每次调用现算：第三方明确记录过「模块级可变全局与并发不兼容」。
            const stats = corpusStats(records);
            // 相关度主分：BM25（字段内部各自统计）+ 字段权重，落在 0..1 绝对标度。
            const relById = new Map();
            for (const r of records)
                relById.set(r.id, lexicalScore(query, r, stats));
            // ── 内容量闸门（本次新增；判据/阈值/反例见 pure.ts 的 CONTENT_TOKEN_MIN 与 GATE_MARGIN 注释）──
            // qTok = 查询里「在本库任一分词字段出现过」的去重词元数（现算，无批次相关量）。
            // 它只影响 **match 的判定**：qTok < contentTokenMin 且 rel < gateMargin×strong 时 strong 封顶 weak；
            // qTok < contentTokenMin 但 rel >= gateMargin×strong 时**例外放行**（单个高专有词元的真话题，
            // 实测 `adb` 达 4.35×strong；例外倍数标定见 pure.ts）。
            // rel 的语义与四个已标定常数**一个字都不动**（rel 仍是 BM25 原始分、仍按它排序/判 weak/none）。
            const contentTokens = queryContentTokens(query, stats);
            // 本次是否有任何**已判 strong 的行**被闸门压到 weak（表头据此选「封顶支」措辞；
            // qTok=0 的行 base 必为 none，永不计入）。
            let gateCappedAny = false;
            // 路 1：词法相关度（只保留正分）
            const lexical = records
                .map((r) => ({ id: r.id, s: relById.get(r.id) ?? 0 }))
                .filter((x) => x.s > 0)
                .sort((a, b) => (b.s - a.s) || cmpId(a.id, b.id))
                .map((x) => x.id);
            // 路 2：新鲜度
            const freshness = records
                .map((r) => ({ id: r.id, s: decay(r.ts, now) }))
                .sort((a, b) => (b.s - a.s) || cmpId(a.id, b.id))
                .map((x) => x.id);
            const fused = rrf([lexical, freshness], { k: 60, alpha: 0.6 });
            const byId = new Map(records.map((r) => [r.id, r]));
            // 候选：排序层用原始相关度 rel 与融合秩 rank；展示层再用绝对映射 disp（两层解耦）。
            // 只奖不罚：无任何词法证据的候选 rel 就是 0，不做统一扣分、也不整批否决。
            //
            // ── I3：图奖励（标签共现图 + 有界脉冲传播）────────────────────────────
            // 口径全部是模块级默认常数（可经 cfg.graph 覆盖），**没有任何批次相关量**。
            // 图是「当前记忆库的纯函数」：每次调用从 records 现建（无模块级可变状态）。
            // 请求级隔离：传播/激活/奖励全是本次调用的局部量（与 I2 红线同类）。
            const graphCfg = resolveGraphOptions(cfg.graph);
            const tagGraph = tagGraphIndex(records, graphCfg);
            const graphSize = { nodes: tagGraph.nodes.length, edges: tagGraph.directedEdges };
            // 种子 = 本次直接命中的标签（严格定义：查询词元里、在全库标签出现过的那些标签）。
            const queryTokens = new Set(tokenize(query));
            const seedTags = [...new Set([...stats.tagDf.keys()].filter((t) => queryTokens.has(t)))].sort(cmpId);
            const prop = propagateTags(seedTags, tagGraph, graphCfg);
            const baseCandidates = fused.map((e, idx) => {
                const rec = byId.get(e.id);
                const tags = Array.isArray(rec?.tags) ? (rec?.tags ?? []) : [];
                return {
                    id: e.id,
                    score: relById.get(e.id) ?? 0,
                    tags,
                    rank: idx,
                    cov: tagCoverage(query, tags, stats),
                };
            });
            // 图奖励按「融合候选 + 图新增可达记忆」一起算：后者必须补进候选池，
            // 否则「与查询无词法重合、但与命中记录共享标签」的记忆永远进不了候选集。
            const inPool = new Set(baseCandidates.map((c) => c.id));
            const graphExtras = [];
            for (const rec of records) {
                if (inPool.has(rec.id))
                    continue;
                const tags = Array.isArray(rec.tags) ? rec.tags : [];
                graphExtras.push({
                    id: rec.id,
                    score: relById.get(rec.id) ?? 0,
                    tags,
                    rank: fused.length + graphExtras.length,
                    cov: tagCoverage(query, tags, stats),
                });
            }
            const rewardList = memoryGraphRewards([...baseCandidates, ...graphExtras], prop.propagated, tagGraph, graphCfg);
            const rewardById = new Map(rewardList.map((x) => [x.id, x]));
            const isLexicalHit = (id) => (relById.get(id) ?? 0) > 0;
            const reachable = rewardList.filter((x) => x.bonus > 0 && !isLexicalHit(x.id)).length;
            // 候选：final = rel + graph（图奖励是**辅助**，硬上限 GRAPH_BONUS_CAP ⇒ 压不过词法相关度）。
            const candidates = baseCandidates.map((c) => {
                const g = rewardById.get(c.id);
                return { ...c, score: c.score + (g?.bonus ?? 0), graph: g?.bonus ?? 0, viaTag: g?.viaTag ?? '' };
            });
            // 图新增的可达记忆：只把**真有图证据**的补进候选池（无证据的一条都不补，绝不灌水）。
            // 它们进入候选池 ⇒ 受同一套排序、多样性与 limit 硬上限约束（不额外承诺显示）。
            for (const extra of graphExtras) {
                const g = rewardById.get(extra.id);
                if (g === undefined || g.bonus <= 0)
                    continue;
                candidates.push({ ...extra, score: extra.score + g.bonus, graph: g.bonus, viaTag: g.viaTag });
            }
            // 候选 <= 5 时跳过多样性（小候选集拿不到多样性收益，纯添乱）。
            // 判据用**词法融合候选数** fused.length（I1.2 的口径原样保留）：图新增候选是**辅助**补充，
            // 不能让「一个本来只命中 3 条的查询」因为图补进几条就突然开起多样性重排 —— 那会改变
            // 既有排序语义。图有证据时它的影响体现在 final 上的 graph 项，不需要动 beta 口径。
            const beta = fused.length <= DIVERSITY_MIN_CANDIDATES ? 0 : scoreCfg.beta;
            // ── I2 分诊：残差金字塔（Gram-Schmidt）→ 是否扩检索 ────────────────────
            // 分诊口径：模块级默认常数（可经 cfg.triage 覆盖），**没有任何批次相关量**。
            const triageCfg = resolveTriageOptions(cfg.triage);
            // kBase = **内部**召回预算基线（= limit，仅决定候选池规模，**不承诺显示行数**）；
            // 扩检索预算 = min(2×kBase, 库内条数)
            // （规格：kExpanded = max(limit, 2×limit) 且**不超过库内条数** —— 库容小于 kBase 时
            //  kUsed 因此可能小于 kBase，但行为上不会少取候选：候选总数本身就 <= 库容，两种预算
            //  下 diversify 都只会取到库里全部候选）。
            const kBase = limit;
            const kExpanded = Math.min(Math.max(kBase, kBase * 2), records.length);
            // 探测集：按（rel 降序 / 融合秩 / id 决胜）取前 kBase 个 —— 分诊只看「本来就会取的那些候选」。
            // 全部是本次调用的局部量；**绝不**把基/能量场缓存到模块级（见 pure.ts 顶部隔离红线）。
            const probe = [...candidates]
                .sort((a, b) => (b.score - a.score) || (a.rank - b.rank) || cmpId(a.id, b.id))
                .slice(0, kBase);
            const triage = residualPyramid(query, probe, stats, triageCfg);
            const expanded = triage.expanded;
            const kUsed = expanded ? kExpanded : kBase;
            // 多样性乘进同一个分数：final = rel × (1 − β·maxSim)；列表按 final 降序 ⇒ 打印天然单调。
            // ── I2.1 修 1：limit 是**硬显示上限** ─────────────────────────────────
            // 显示行数恒为 min(limit, 可用候选数)。扩检索只放大**内部**预算 kUsed（给金字塔取基、
            // 给多样性一个更大的候选池），**绝不**改变返回行数：旧实现把 limit 直接换成 kUsed 交给
            // diversify ⇒ limit=3 也能吐 6 行（实测 rows=6），调用方无法依赖 limit，契约被泄漏破坏。
            // 内部先按 kUsed 选（保持「扩检索=更大候选池」的语义），再按硬上限截断显示。
            // 内部先按 kUsed 选（保持「扩检索=更大候选池」的语义），再按硬上限截断显示。
            // I3：可用候选数 = 词法融合候选 ∪ 图新增可达记忆（后者是本次新补进候选池的），
            // 仍是 min(limit, 可用候选数) 的严格硬上限 —— 图候选只可能**占用**可用名额，
            // 绝不会让行数超过 limit。
            const shownCap = Math.min(limit, candidates.length);
            const picked = diversify(candidates, { beta, limit: kUsed }).slice(0, shownCap);
            // 低置信：cov_max < activationThreshold。**低置信只影响如实报告**：
            // 不否决任何候选、不返回空（第三方明确回退过这种门控）。
            let covMax = 0;
            for (const item of picked)
                if (Number.isFinite(item.cov) && item.cov > covMax)
                    covMax = item.cov;
            const lowConfidence = covMax < triageCfg.activationThreshold;
            const lines = [];
            const rows = [];
            for (const item of picked) {
                const rec = byId.get(item.id);
                if (rec === undefined)
                    continue;
                // I1.3 自证修正：`rel` 直接打印**判定所用的同一个量**（BM25 原始分）。
                // 本次（闸门例外）后，`match` 的完整规则是
                //   match = 无内容量(qTok=0) ? none
                //         : qTok<contentTokenMin ? (base=strong 且 rel<gateMargin×strong ? weak : base)
                //         : matchLevel(rel,…)
                // —— qTok、阈值与**例外倍数 gateMargin** 都在表头与结构化字段里回显，
                // 所以**仍然恒可复算**（I1.3 铁律）。
                // 图奖励只进 final = rel + graph（再乘多样性惩罚），绝不改 rel 或 match。
                const rel = relById.get(item.id) ?? 0;
                const graph = Number.isFinite(item.graph) && (item.graph ?? 0) > 0 ? (item.graph ?? 0) : 0;
                // via：有词法证据就是 direct；否则标出最强来源标签（图传播到达）。
                const via = rel > 0 ? 'direct' : (graph > 0 && item.viaTag !== '' ? `tag:${item.viaTag}` : 'direct');
                const baseMatch = matchLevel(rel, scoreCfg.weak, scoreCfg.strong);
                const gatedMatch = matchLevelGated(rel, scoreCfg.weak, scoreCfg.strong, contentTokens, scoreCfg.contentTokenMin, scoreCfg.gateMargin);
                // 记录「贴线被压」这件事（表头封顶支的判据）：base=strong 却被压成 weak。
                if (baseMatch === 'strong' && gatedMatch === 'weak')
                    gateCappedAny = true;
                const view = {
                    score: absoluteDisp(item.final, scoreCfg.scaleA, scoreCfg.scaleB),
                    rel,
                    cov: item.cov,
                    match: gatedMatch,
                    graph,
                    via,
                };
                lines.push(formatL1(rec, view));
                rows.push({
                    // 键序与 RECALL_COLUMNS / schema rows.properties 一致（同一份列清单不养第二个顺序）：
                    // 纯顺序调整，字段名/类型一个字不改，也不影响 lines/text。
                    id: rec.id,
                    kind: rec.kind,
                    title: rec.title,
                    tags: [...rec.tags],
                    graph: view.graph,
                    via: view.via,
                    rel: view.rel,
                    cov: view.cov,
                    match: view.match,
                    score: view.score,
                });
            }
            // ── I5 表头减肥 + 修正 1：单行、总长 <= HEADER_MAX_CHARS，只留「可复算所必需」的结论性数字 ──
            // 修正 1 修正的是**旧声明本身**：旧注释写「单行、<= 400 字符」，但那只在 3 个短查询夹具上量过
            // （388~399），从未覆盖最坏情况 —— 表头回显 `query=` 时长随查询串线性增长，实测：
            //   短查询 alpha = 399；200 字符含边界字符 = 742；360 字符 = 932；换一组回显更宽的标度常数 = 413。
            // 现在两条路径都被堵死：① query 回显由 formatHeaderQuery 按**现算预算**截断并标注（见 HEADER_MAX_CHARS）；
            // ② 标度常数由 formatHeaderConstant 定宽回显（见 HEADER_CONST_MAX_CHARS）。总长上界因此对
            // 任意查询串、任意标度配置都成立，并由 test/header.test.mjs 的最坏情况用例钉住。
            // 旧表头 1049~1066 字符（本机实测，随查询与条数变化），而 RECALL_MAX_CHARS=2000 ⇒ 每次只剩
            // 7~9 行可见（40 条候选也只显示 7 行）。
            // 更糟的是旧表头把标度常数**本身**回显了两遍（score 公式 + 阈值），于是改
            // SCALE_A/SCALE_B/WEAK/STRONG 会连带改掉「能显示几行」——上一次标定落地时 6 个既有测试红，
            // 其中 5 个就是这么被掰弯的（把 8 行改成 6 行、把夹具标题压短）。现在常数照旧回显
            // （复算必需），但表头长度与它们的**小数位长度无关**地稳定；由 test/header.test.mjs 的
            // 结构性断言「标度常数不得影响显示行数」钉住。
            //
            // 必须保留（一个都不能少，理由见括号）：
            //   ① 列序（RECALL_COLUMNS 的列名与顺序，由它派生）——行按 ` | ` 切片读列，列序本身就是契约；
            //   ② rel=BM25 原始相关度、且是 match 的判定依据——否则 match 无法复算；
            //   ③ match 两个阈值数字 + 否则 none + (恒可复算)——复算 none/weak/strong 的依据；
            //   ③b 内容量闸门（本次新增，按分支回显）：封顶支 `内容量qTok=N<min⇒strong封顶weak`、
            //      不封顶支 `内容量qTok=N≥min⇒闸门未生效` —— qTok 与阈值都是**闸门输入**，
            //      少一个 match 就复算不出来（判据/阈值标定见 pure.ts 的 CONTENT_TOKEN_MIN 注释；
            //      无条件样板的旧缺陷见 redproof/i10-*）。
            //   ④ score=disp(final) 的公式与两个标度常数——复算展示分的唯一依据；
            //   ⑤ limit 是硬显示上限——防止把「内部候选池预算」误读成显示上限；
            //   ⑥ I2 结论：novelty、novelty 阈值、expanded、kBase->kUsed——复算 expanded；
            //   ⑦ 低置信：cov_max 与激活阈值——复算 lowConfidence；
            //   ⑧ I3 结论：final=rel+graph、graph 硬上限、图规模、枢纽被压数量、reachable——复算排序；
            //   ⑨ 多样性（本次对账补上）：final=(rel+graph)×多样性因子、因子**只在候选 > 5 时施加**，
            //      以及「多样性开时 score 无法仅由打印的 rel/graph 复算」——否则读者会以为
            //      score 恒等于 disp(rel+graph)（这正是旧表头漏掉多样性的那处不成立表述）。
            //
            // 为腾出 ⑨、③b 与「match 恒可复算」的字符预算，本次（含内容量闸门那次）同时压掉（都不是复算必需项）：
            //   - limit 段的 `(min(limit,候选数))`（min 语义仍在工具描述与 structured `shown` 上）；
            //   - 行首的 `候选N;`（词法融合候选数仍在结构化字段 matched 上，且它不参与任何复算）；
            //   - I3 段的括号与两处分隔符（判据文字一字未改，见 header.test 的三条 substring 断言）；
            //   - 行首的 `记忆召回` 前缀与 `库N`（`L1:` 已足以自证；库容在结构化字段 total 上）；
            //   - 未分诊分支的 `(‖q‖²≈0)` 与 `阈值 X 不门控`（原因在结构化字段 noQueryEnergy 上，
            //     且该分支不门控 ⇒ 阈值数字本来就不参与复算）。
            //
            // 压掉的（这些量**一个都没删**，仍逐字在结构化返回字段/rows 里，本来就不占文本预算）：
            //   - 解释性 prose（「返回行数恒为…」「仅用于排序展示」「不扣分」这类长句）；
            //   - 公式的文字展开（log(1+λW) 压缩、出流预算、枢纽校正指数、图 pivot 细节）；
            //   - 重复出现的「内部候选池预算」解释（kUsed 的语义只保留在结构化字段 kUsed 上）；
            //   - 非结论性诊断：basisSize/layers/logicalDepth、explainedRatio+residualRatio 守恒式、
            //     maxHops/maxStates/maxFieldNeighbors/gamma/rho、种子数/到达标签数/展开状态数/跳数、
            //     枢纽名单、以及多样性 beta（MMR 的 beta 要配整份候选集才能复算，单列它复算不了；
            //     现在由 ⑨ 如实说明「开时不可由 rel/graph 复算」，不再假装 score 只由 rel/graph 决定）。
            // 另：旧表头那句「本次显示 N 条」在截断时**是错的**（打印的是 fitLines 之前的行数），
            //     本次直接删掉；真实显示行数由结构化字段 shown 与截断附注如实给出。
            // I2 段也是**非复算必需**的冗字收紧对象（数值/判据一个没删）：
            // 旧 `novelty=… >= 阈值 0.5,expanded=…，kBase=5 -> kUsed=10`（61 字符，默认库）
            // → 新 `novelty=…>=阈值0.5,expanded=…,kBase=5->kUsed=10`（56 字符）。
            // 「阈值」二字保留（triage 用例按 novelty/阈值/比较符解析表头），只删空格与 ` -> ` 里的空格。
            const triageSeg = triage.noQueryEnergy
                ? `I2:未分诊:novelty=0,expanded=false,`
                    + `kBase=${kBase}->kUsed=${kUsed},0/0`
                : `I2:novelty=${triage.novelty.toFixed(4)}${expanded ? '>=' : '<'}阈值${triageCfg.noveltyThreshold},expanded=${expanded},`
                    + `kBase=${kBase}->kUsed=${kUsed}`;
            const lowConfSeg = lowConfidence
                ? `低置信:cov_max=${covMax.toFixed(4)}<${triageCfg.activationThreshold}`
                : `非低置信:cov_max=${covMax.toFixed(4)}>=${triageCfg.activationThreshold}`;
            // I3 表头用的如实回显量（全部是本请求的局部结论）；枢纽名单压给结构化字段 hubSuppressed。
            const hubSuppressedCount = tagGraph.hubSuppressed.length;
            const reachableWithGraph = rewardList.filter((x) => x.bonus > 0).length;
            // 标度常数经 formatHeaderConstant 定宽回显（精确优先，超宽则 `≈` 标注近似）——
            // 这是让「固定部分」真的与配置宽度无关的那一半；另一半是有界的 query 回显（见下）。
            const constA = formatHeaderConstant(scoreCfg.scaleA);
            const constB = formatHeaderConstant(scoreCfg.scaleB);
            const constWeak = formatHeaderConstant(scoreCfg.weak);
            const constStrong = formatHeaderConstant(scoreCfg.strong);
            // 固定部分（与**查询串**完全无关）：长度由库规模统计与上面四个定宽常数决定。
            // 内容量闸门回显（`;内容量…`）**按分支给，绝不写无条件样板**（真机缺陷修复，见 redproof/i10-*；
            // 本轮再按「贴线封顶 / 例外放行 / 闸门未生效」分三支）：
            //   - 贴线封顶支（qTok < min 且本次确有 base=strong 的行被压）：规则句
            //     `;内容量qTok=N<min且rel<M×strong⇒strong封顶weak` —— 逐字回显三个输入（qTok/min/M），
            //     读者对每一行都能复算：base=strong 且 rel<M×strong ⇒ 封顶，否则原样（条件句对所有行成立）；
            //   - 例外放行支（qTok < min 但没有任何 strong 行落在 M×strong 之下）：
            //     `;内容量qTok=N<min但rel≥M×strong⇒不压级` —— 措辞**刻意不含「封顶」二字**，
            //     好让测试直接断言不封顶支回显无该字样；
            //   - qTok=0：rel 恒为 0 ⇒ base 必为 none，落在封顶支的规则句上仍可复算出 none
            //     （0 < M×strong 恒成立），语义与旧实现一致；
            //   - qTok >= min：`;内容量qTok=N≥min⇒闸门未生效`（旧实现这一支照抄封顶样板，打出
            //     `qTok=5<2⇒strong封顶weak` 这种假不等式且与 match=strong 自相矛盾）；
            //   - 三支都逐字回显 qTok、min 与 M（复算 match 所必需的闸门输入）⇒ **恒可复算**（I1.3 铁律）。
            //   - 为了给「且rel<M×strong」腾字符，本轮把表头里**非复算必需**的冗字收紧
            //     （`limit 是硬显示上限`→`limit硬上限`、I2 段的空格/「阈值」、`match:` 前缀、
            //      I3 段的 `开时不可由 rel/graph 复算`→`开时score不可复算`、`枢纽被压`→`枢纽压`、
            //      `reachable=`→`可达=`、`候选>5时启用`→`候选>5启用`、`graph硬上限`→`graph上限`
            //     以及低置信段两处空格）——**一个复算必需项都没动**（数值、公式、阈值、列序全在）。
            const margin = scoreCfg.gateMargin;
            const gateEcho = contentTokens >= scoreCfg.contentTokenMin
                ? `内容量qTok=${contentTokens}≥${scoreCfg.contentTokenMin}⇒闸门未生效`
                : (contentTokens === 0 || gateCappedAny)
                    ? `内容量qTok=${contentTokens}<${scoreCfg.contentTokenMin}且rel<${margin}×strong⇒strong封顶weak`
                    : `内容量qTok=${contentTokens}<${scoreCfg.contentTokenMin}但rel≥${margin}×strong⇒不压级`;
            // 标定漂移段（**只在超阈值时出现**，如实给标定点/现值/建议；不进自动注入那行）。
            // 措辞里带上 `--write`：calibrate 脚本默认只打印，落地必须显式 `--write`。
            const driftSeg = calib.exceeded
                ? `标定${calib.calibratedRecords}条@${CALIBRATION_DATE},现值${calib.currentRecords}条,建议重跑calibrate --write`
                : '';
            const tail = `;limit=${limit}硬上限;`
                + `列序:${RECALL_COLUMNS.join('|')};`
                + 'rel=BM25原始相关度,match 依据;'
                + `score=disp(final)=clip((final-${constA})/(${constB}-${constA}));`
                + `rel>=${constWeak} weak、>=${constStrong} strong、否则 none(恒可复算);`
                + `${gateEcho};`
                + (driftSeg === '' ? '' : `${driftSeg};`)
                + `${triageSeg};`
                + `${lowConfSeg};`
                + `I3:final=rel+graph×多样性,候选>5启用,开时score不可复算,graph上限<=${graphCfg.bonusCap}，图${graphSize.nodes}节点/${graphSize.edges}边，`
                + `枢纽压${hubSuppressedCount}，可达=${reachable}`;
            // query 回显的预算是**现算**的：HEADER_MAX_CHARS 减去固定部分与分隔符。于是
            // 「表头总长 <= HEADER_MAX_CHARS」由构造保证，与查询串多长（含换行/引号/反斜杠）无关。
            // 完整查询串永远在结构化字段 `query` 上，回显只是给人看的短标识。
            const headerPrefix = 'L1:query=';
            const echoBudget = Math.max(2, HEADER_MAX_CHARS - headerPrefix.length - 1 - tail.length);
            const echoed = formatHeaderQuery(query, echoBudget);
            const header = `${headerPrefix}${echoed.text}${tail}`;
            const fitted = fitLines(header, lines, RECALL_MAX_CHARS);
            const text = records.length === 0
                ? `${header}\n(记忆库为空：请先用 memory_remember 写入)`
                : fitted.text;
            return prune({
                ok: true,
                code: 'ok',
                query,
                limit,
                total: records.length,
                matched: fused.length,
                shown: fitted.lines.length,
                truncated: fitted.truncated,
                scaleA: scoreCfg.scaleA,
                scaleB: scoreCfg.scaleB,
                weakThreshold: scoreCfg.weak,
                strongThreshold: scoreCfg.strong,
                // 内容量闸门的输入（复算 match 所必需；表头同步回显）：
                // qTok、封顶阈值，以及「离阈值多远」的例外倍数 M（封顶条件 = qTok<min 且 rel<M×strong）。
                contentTokens,
                contentTokenMin: scoreCfg.contentTokenMin,
                gateMargin: scoreCfg.gateMargin,
                // 标定漂移（复算 calibrationDriftExceeded 所需的全部输入都在这里；表头在超阈值时同步回显）：
                // 相对偏差 |calibrationDrift| / calibrationRecords > calibrationDriftRel 或
                // 绝对差 |calibrationDrift| > calibrationDriftAbs ⇒ 超阈值（取先到者）。
                calibratedAt: CALIBRATION_DATE,
                calibrationRecords: calib.calibratedRecords,
                calibrationDrift: calib.delta,
                calibrationDriftRel: calib.driftRel,
                calibrationDriftAbs: calib.driftAbs,
                calibrationDriftExceeded: calib.exceeded,
                diversityBeta: beta,
                diversityApplied: beta > 0,
                // I2 分诊字段（全部是本次调用的局部结论；rows 之外的返回体，schema 已同步声明）
                expanded,
                noQueryEnergy: triage.noQueryEnergy,
                kBase,
                kUsed,
                novelty: triage.novelty,
                explainedRatio: triage.explainedRatio,
                residualRatio: triage.residualRatio,
                basisSize: triage.basisSize,
                layers: triage.layers,
                logicalDepth: triage.logicalDepth,
                lowConfidence,
                // 口径回显：读者据此可自行复算 expanded 与 lowConfidence（I1.3 可复算铁律的延续）
                noveltyThreshold: triageCfg.noveltyThreshold,
                activationThreshold: triageCfg.activationThreshold,
                covMax,
                // I3 图与传播字段（全部是本次调用的局部结论；schema 已同步声明）。
                // graphNodes/graphEdges 是「当前库」的图规模；propagatedTags 是本次传播的标签激活；
                // hubSuppressed 是被枢纽校正压过的标签（码元升序）；reachable 是图**新增可达**的记忆条数。
                graphNodes: graphSize.nodes,
                graphEdges: graphSize.edges,
                // 如实回显**全部**到达标签（上限本来就由 maxStates/maxHops 兜住，不会无界）；
                // I5 减肥后表头一个名单都不列（只报数量），结构化字段给全量，免得读者按被截断的名单复算不出来。
                propagatedTags: prop.propagated.map((p) => ({ tag: p.tag, activation: p.weight })),
                maxHops: graphCfg.maxHops,
                maxStates: graphCfg.maxStates,
                maxFieldNeighbors: graphCfg.maxFieldNeighbors,
                graphBonusCap: graphCfg.bonusCap,
                hubSuppressed: [...tagGraph.hubSuppressed],
                reachable,
                /** I3 诊断：本次直接命中的标签种子数、传播状态数与最深跳数、是否撞上 maxStates。 */
                graphSeedCount: seedTags.length,
                graphStatesUsed: prop.statesUsed,
                graphHops: prop.hops,
                graphStatesTruncated: prop.statesTruncated,
                graphEvidence: reachableWithGraph,
                lines: fitted.lines,
                // rows 与真正打印出来的 lines 一一对应（截断时同步裁剪，不给出没打印的行）。
                rows: rows.slice(0, fitted.lines.length),
                text,
            });
        },
    }));
    // ── 工具 3：展开（L2，取回正文）─────────────────────────────────────────
    host.tools.register(defineTool({
        name: 'memory_expand',
        description: '按 id 取回记忆正文（L2）。找不到的 id 会如实列在 missing 里。取回成功会给这些记录累加 hits（影响将来的淘汰优先级）。',
        parameters: {
            ids: { type: 'array', items: { type: 'string' }, required: true, description: '要展开的记录 id 列表（去重后按给出顺序返回）' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    code: { type: 'string', required: true },
                    requested: { type: 'integer', required: true },
                    found: { type: 'integer', required: true },
                    missing: { type: 'array', items: { type: 'string' }, required: true },
                    records: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                id: { type: 'string', required: true },
                                kind: { type: 'string', required: true },
                                title: { type: 'string', required: true },
                                body: { type: 'string', required: true },
                                tags: { type: 'array', items: { type: 'string' }, required: true },
                                source: { type: 'string', required: true },
                                ts: { type: 'integer', required: true },
                                hits: { type: 'integer', required: true },
                            },
                        },
                    },
                    text: { type: 'string', required: true },
                },
            },
            render: RENDER,
        },
        execute: async (rawArgs) => queue.run(() => {
            const args = (rawArgs ?? {});
            const MAX_IDS = 50;
            const rawIds = Array.isArray(args.ids) ? args.ids : [];
            const ids = [];
            const seen = new Set();
            for (const raw of rawIds) {
                if (typeof raw !== 'string')
                    continue;
                const id = raw.trim();
                if (id === '' || seen.has(id))
                    continue;
                seen.add(id);
                ids.push(id);
            }
            const clipped = ids.slice(0, MAX_IDS);
            if (clipped.length === 0) {
                return prune({
                    ok: false,
                    code: 'empty-ids',
                    requested: 0,
                    found: 0,
                    missing: [],
                    records: [],
                    text: '未提供任何有效 id（失败关闭）。修复：先调 memory_recall 拿到 L1 行首的 id，再把 id 放进 ids 数组重试，例如 {"ids":["mem_xxx"]}。',
                });
            }
            const records = loadRecords(cfg);
            const byId = new Map(records.map((r) => [r.id, r]));
            const missing = clipped.filter((id) => !byId.has(id));
            const foundIds = clipped.filter((id) => byId.has(id));
            // hits 累加要落盘 ⇒ 同样受「外部改动」守卫约束：被拒时不落盘，但正文照常如实返回。
            let writeError;
            let bump;
            try {
                bump = foundIds.length > 0
                    ? bumpHits(foundIds, cfg)
                    : { hits: {}, count: records.length, bytes: 0, evicted: [] };
            }
            catch (err) {
                if (!(err instanceof StoreChangedExternallyError))
                    throw err;
                writeError = err;
                bump = { hits: {}, count: records.length, bytes: 0, evicted: [] };
            }
            const out = foundIds.map((id) => {
                const rec = byId.get(id);
                return {
                    id: rec.id,
                    kind: rec.kind,
                    title: rec.title,
                    body: rec.body,
                    tags: [...rec.tags],
                    source: rec.source,
                    ts: rec.ts,
                    hits: bump.hits[id] ?? rec.hits,
                };
            });
            const parts = [];
            parts.push(`展开 ${foundIds.length}/${clipped.length} 条（L2 正文）`);
            if (writeError !== undefined) {
                parts.push(externalChangeText(writeError));
                parts.push('- 说明：上面这些正文已如实返回，但 hits 未累加、库文件未被改动');
            }
            if (missing.length > 0)
                parts.push(`- 未找到（如实报告）：${missing.join(', ')}`);
            if (ids.length > MAX_IDS)
                parts.push(`- 一次最多展开 ${MAX_IDS} 个 id，本次已忽略后 ${ids.length - MAX_IDS} 个`);
            if (bump.evicted.length > 0)
                parts.push(`- 本次写入触发上限淘汰 ${bump.evicted.length} 条：${bump.evicted.map((r) => r.id).join(', ')}`);
            for (const rec of out) {
                parts.push(`\n【${rec.id}】${rec.kind} | ${rec.title} | tags=${rec.tags.join(',')} | source=${rec.source} | hits=${rec.hits}\n${rec.body}`);
            }
            return prune({
                ok: writeError === undefined,
                code: writeError === undefined ? 'ok' : 'store-changed-externally',
                requested: clipped.length,
                found: out.length,
                missing,
                records: out,
                text: parts.join('\n'),
            });
        }),
    }));
    // ── 工具 4：清理（默认 dry-run）──────────────────────────────────────────
    host.tools.register(defineTool({
        name: 'memory_prune',
        description: `按规则淘汰/合并记忆：同 kind 同标题者合并（保留最新，累加 hits，标签取有序并集），`
            + `再按 score=recency*(1+hits) 从低到高淘汰至上限内。dryRun 默认 true（只报告将要删什么，不动磁盘），显式传 false 才真删。`,
        parameters: {
            dryRun: { type: 'boolean', default: true, description: '默认 true：只报告将要删/合并什么；传 false 才真正落盘' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    code: { type: 'string', required: true },
                    dryRun: { type: 'boolean', required: true },
                    before: { type: 'integer', required: true },
                    after: { type: 'integer', required: true },
                    merged: { type: 'integer', required: true },
                    mergedGroups: { type: 'array', items: { type: 'string' }, required: true },
                    evicted: { type: 'integer', required: true },
                    evictedIds: { type: 'array', items: { type: 'string' }, required: true },
                    bytesBefore: { type: 'integer', required: true },
                    bytesAfter: { type: 'integer', required: true },
                    maxRecords: { type: 'integer', required: true },
                    maxBytes: { type: 'integer', required: true },
                    changed: { type: 'boolean', required: true },
                    text: { type: 'string', required: true },
                },
            },
            render: RENDER,
        },
        execute: async (rawArgs) => queue.run(() => {
            const args = (rawArgs ?? {});
            const dryRun = args.dryRun !== false;
            const plan = planPrune(cfg);
            const evictedIds = plan.evicted.map((r) => r.id);
            const mergedGroups = plan.merged.map((g) => `${g.keep} <- [${g.dropped.join(', ')}]`);
            const changed = plan.countBefore !== plan.countAfter || mergedGroups.length > 0 || plan.bytesBefore !== plan.bytesAfter;
            // 真删落盘同样受「外部改动」守卫约束：被拒时不落盘、不覆盖对方内容。
            let writeError;
            if (!dryRun) {
                try {
                    saveRecords(plan.records, cfg, plan.stamp);
                }
                catch (err) {
                    if (!(err instanceof StoreChangedExternallyError))
                        throw err;
                    writeError = err;
                }
            }
            const head = dryRun ? 'dry-run（未改动磁盘）' : (writeError === undefined ? '已执行并落盘' : '未落盘（失败关闭：库被外部改动）');
            const text = `${head}\n`
                + `- 条数：${plan.countBefore} -> ${plan.countAfter}（上限 ${plan.maxRecords}）\n`
                + `- 占用：${plan.bytesBefore} -> ${plan.bytesAfter} / ${plan.maxBytes} 字节\n`
                + `- 合并 ${mergedGroups.length} 组${mergedGroups.length > 0 ? '：' + mergedGroups.join(' ; ') : ''}\n`
                + `- 淘汰 ${evictedIds.length} 条（score=recency*(1+hits) 最低者）${evictedIds.length > 0 ? '：' + evictedIds.join(', ') : ''}\n`
                + (writeError !== undefined ? `${externalChangeText(writeError)}\n` : '')
                + (dryRun && changed ? '- 确认无误后请以 dryRun=false 重试以真正执行' : '- 无需进一步动作');
            void memoryPath(cfg);
            return prune({
                ok: writeError === undefined,
                code: writeError === undefined ? 'ok' : 'store-changed-externally',
                dryRun,
                before: plan.countBefore,
                after: plan.countAfter,
                merged: mergedGroups.length,
                mergedGroups,
                evicted: evictedIds.length,
                evictedIds,
                bytesBefore: plan.bytesBefore,
                bytesAfter: plan.bytesAfter,
                maxRecords: plan.maxRecords,
                maxBytes: plan.maxBytes,
                changed,
                text,
            });
        }),
    }));
    // ── I4a / I4a.3：记忆注入（**条件注册**）────────────────────────────────
    // 两条贡献，两种机制（详见 src/inject.ts 头部注释）：
    //  ① section（稳定段）`agent-memory-habit`：**条件规则**，属于稳定前缀，每步都该在；
    //  ② context（易变尾部块）`agent-memory`：库的索引，库变了才该变。
    // 用 **context()** 承载索引：context 是「有序动态上下文」——引擎把它渲染成
    // `Current runtime context...` 快照，交给 RuntimeContextProjection.project() 变成
    // **本轮消息列表尾部的一条 user 消息**，且文本与上一份相同就一条消息都不发（project() 去重）。
    // 这正是索引该待的地方（尾部、低频、可去重）；而规则不该跟着库的每次变动一起抖，
    // 所以规则走 section（正文段），**不要**把它塞进 context。
    //
    // **松耦合**（I4a.1）：`ctx.inject(['systemPrompt'], (scope) => {...})` 是引擎官方惯例
    // （先例：dsh-sandbox-policy/lib/index.js:121、dsh-user-approval/lib/index.js:79、
    // dsh-subagent/lib/index.js:2848 —— 回调参数是 scope（挂载了依赖的子 ctx），
    // 注册内容挂在 scope 上，生命周期与清理交给 fiber，回调本身不返回东西）。
    // 只有 systemPrompt 解析到实现时才执行回调 ⇒ 缺席时**工具面完全不受影响**。
    // 注意这里**不能**再沿用旧的 `ctx.systemPrompt` 读法：cordis 的 ctx 是 reflect 代理，
    // 没在 inject 里声明的服务名读一次就抛 `cannot get property "..." without inject`
    // （cordis/src/reflect.ts:144），所以必须用回调给的 scope。
    //
    // 关掉时**连 inject 都不发起**（比旧的「不注册」更彻底：不建子 fiber、零额外开销，
    // 注册本来就是按 scope 增删的，不注册 ⇒ contexts/sections 里根本没有这两项 ⇒ 零字符）。
    // **两条贡献共用同一个 enabled 开关**：关掉就两条都不注册（不允许只关一条的半开状态）。
    //
    // fail-open 四层（比改动前多一层，原有三层一一对应、一层未减）：
    //  1) buildInjectionIndex() 内部整体 try/catch，catch 里不再抛（读库/解析失败 ⇒ 空串 + diag）；
    //  2) context 注册箭头内再包一层 try/catch —— 即使将来 1) 被改出异常，也绝不让引擎的 assemble() 炸；
    //  3) section 注册单独包一层 try/catch —— 段注册失败只意味着**少一段**（尾部块与工具面照旧），
    //     绝不让它把同一次回调里的其它注册或整步 assemble() 拖下水；
    //  4) 最外层 try/catch 兜住 `ctx.inject` 本身：拿不到注入能力只意味着「少一块注入」。
    // 只读缓存实例仍挂在 apply 闭包里（模块级零可变状态，键严格是 {path,size,mtimeMs}）。
    const injectionCache = createInjectionCache();
    try {
        if (resolveInjectionOptions(cfg.injection).enabled) {
            ctx.inject(['systemPrompt'], (scope) => {
                const promptHost = scope;
                // ① 稳定段：条件规则（I4a.3）。order 必须是**显式数字**：getSectionOrder() 对外部名字
                // 返回 undefined，而 section() 对非有限 order 直接抛（见 INJECTION_SECTION_ORDER 注释）。
                // 文本过 sanitizeForPrompt() 是防御性的（常量里本没有 `{` `}`，净化对它应为恒等），
                // 保持与尾部块同一套「进 prompt 的文本一律净化」的口径。
                try {
                    promptHost.systemPrompt.section({
                        name: INJECTION_SECTION_NAME,
                        order: INJECTION_SECTION_ORDER,
                        text: sanitizeForPrompt(INJECTION_HABIT_TEXT),
                    });
                }
                catch {
                    /* 段注册失败不抛：只少一段规则提示，尾部块与工具面照常 */
                }
                // ② 易变尾部块：库的索引（I4a）。I4a.3 的文案改动只发生在 inject.ts 里，这里形状不变。
                try {
                    promptHost.systemPrompt.context({
                        name: INJECTION_CONTEXT_NAME,
                        order: INJECTION_CONTEXT_ORDER,
                        // text 用函数形式：引擎在每次 assemble() 现算（`entry.text(context)`），
                        // 于是库变了下一轮就跟着变；库不变时因缓存与确定性排序而逐字节相同。
                        text: () => {
                            try {
                                return buildInjectionIndex(cfg, injectionCache).text;
                            }
                            catch {
                                return '';
                            }
                        },
                    });
                }
                catch {
                    /* 注册失败不抛：宁可没有注入，也不能让 assemble 抛（工具面照常） */
                }
            });
        }
    }
    catch {
        /* 连 inject 都没发起成功（宿主桩/引擎缺 inject 面）也不抛：工具面优先 */
    }
}
