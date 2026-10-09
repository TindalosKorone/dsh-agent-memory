/**
 * I4a / I4a.3：记忆层的两条注入贡献 —— 同一条「条件规则」用两种机制承载。
 *
 * I4a.3（本次改动）改的是**注入文案的语法**：陈述句 → 条件规则。
 *  - 真机观察：旧那行是纯陈述（`记忆 N 条（上限 M）｜标签锚点：…｜细则用 memory_recall`），
 *    它只说明「库里有这么个东西」，**不触发行为** —— 上线以来模型一次都不是被它提醒去召回的
 *    （每次召回都发生在测插件的时候）。结论：把「有这个东西」改成「这种情况该用它」。
 *  - 改法：显式写出**触发条件**（排查·为什么·复现·以前是否踩过 ⇒ 先 memory_recall 查库）。
 *  - **诚实定位：这条规则是「提示」，不是保证。** 它提高「被想起来」的概率，
 *    **不强制**模型一定调用 memory_recall；模型仍可能忽略它。红证只能证明「文案里确实写了
 *    触发条件」，证明不了「模型一定会照做」——这个区别不要含糊过去。
 *
 * 落点：**两种机制，别混用**
 *  - **稳定前缀**（`section`，prompt 正文段，每步都在）＝ 承载「这条规则本身」：
 *    INJECTION_SECTION_NAME / INJECTION_SECTION_ORDER / INJECTION_HABIT_TEXT（见其注释）。
 *  - **易变尾部**（`context`，有序动态上下文，库变了才该变）＝ 承载「库的索引」：
 *    本文件主体（条数 + 这是什么 + 什么时候该用 + 锚点）。
 *  规则低频稳定、索引随库变动，两者更新频率与语义都不同，所以用两种机制各自承载；
 *  不要为了少一次注册把它们塞进同一处（那会让规则跟着库的每次变化一起抖）。
 *
 * 一、机制（已核实的源码事实，不是猜的）
 *  - 注册入口是 `ctx.systemPrompt.context({ name, order, text })`（dsh-system-prompt/lib/index.js:266-268）。
 *    `order` 必须是有限数字（否则抛 TypeError）；`name` 在同一 scope 内不得重复；`text` 可以是字符串
 *    或 `(assemblyContext) => string`（assemble() 里 `typeof entry.text === "function" ? entry.text(context) : entry.text`）。
 *  - 顺序表是 **CONTEXT_ORDERS**（SANDBOX_POLICY:110 / APPROVAL_POLICY:115 / SUBAGENT_DELEGATION:120），
 *    `getContextOrder()` 对未列名返回 undefined ⇒ 必须自己传显式数字；本插件取 200（落在 120 之后 = 尾部）。
 *  - `text` 会被 `interpolate()` 扫描 `{{name}}` 引用：**未知/畸形引用会抛错**（同文件 interpolate()），
 *    而 inject 函数一旦抛错，整个 `assemble()` 就炸 ⇒ **每一步**都完蛋。所以这里所有动态文本都要过
 *    sanitizeForPrompt()（去掉 `{` `}`），并且整个构建过程 fail-open（catch 里绝不再抛）。
 *  - 落点（dsh-agent-loop/lib/index.js:909-917）：`assemble()` → `renderContextSections(assembly)` →
 *    `joinContextSections(...)` → `this.runtimeContext.project(...)`，project 返回的是**一条 user 消息**
 *    （RuntimeContextProjection.project，同文件 334-346：334 起 project()，337 文本相同即 return，338 起 createUserMessage(source.kind = "runtime-context")），由
 *    `agent/pre-step` 的默认分支 `messages: [...claimed, context]` 追加到本轮消息列表**尾部**，
 *    再由 `this.session.append("user/message", message, ...)`（同文件 1061）落库。**它不改 system prompt 正文**。
 *
 * 二、为什么必须「与查询无关、低频变化」
 *  - project() 只在快照文本与上一份**不同**时才产出消息（`if (this.retained?.text === snapshot) return`），
 *    也就是说：库不变 ⇒ 文本逐字节相同 ⇒ 后续每一步零新增消息、零 prompt 变化（缓存友好）。
 *    一旦把「最近写入的标题」「时间戳」这类每次都在变的实时列表塞进来，就会**每一步都追加一条消息**，
 *    既污染上下文历史，也把前缀缓存打断。
 *  - 所以这里只放四样东西（I4a.3 的结构）：**条数 + 这是什么 + 什么时候该用 + 锚点**。
 *    全部只由「库内容」决定，与查询/时间/agent 无关。
 *
 * 二点五、I4a.2：锚点为什么必须先做「出现率资格过滤」（本文件的重点修正）
 *  - 现象（真机可见）：导入 185 条坑位语料后，那一行从 `失败关闭 / 假绿 / 区分力` 退化成
 *    `坑位 / 判据 / 快照` —— `坑位` 出现在 94% 的记录上，对读者零信息量，等于给每一步的上下文塞噪音。
 *  - 根因：锚点原规则是「按全局词频取 top-N」，而长尾分布下**「最高频」与「最有区分力」是两回事**：
 *    越接近 100% 的标签越像「整个语料的公共前缀」，它区分不了任何两条记忆。
 *  - 修法：先做**资格过滤**（该标签的记录数 / 总记录数 > ANCHOR_MAX_DF_RATIO 的标签一律不参与），
 *    再在合格集合里按 记录频次降序 → 标签码元升序决胜 取 top-N（全确定）。
 *  - 为什么用「df 上限」而不是 idf 式排序：df 上限卡的是**上端**（覆盖全库的公共标签），这正是
 *    真机上观察到的失效模式；而 idf 单调排序会一路把 df=1 的**一次性标签**（错别字、临时记号）
 *    顶到最前面 —— 那些同样不是「锚点」，只是另一种噪音。两者可以叠加，但本增量只做**有红证的**
 *    那一半：上限。上限口径本身也是 idf 的粗糙形式（df 越小 idf 越大），只是只掐上端、不改排序主键。
 *  - 阈值可配置（injection.anchorMaxDfRatio）；默认 0.3 是**待真实语料标定的起点**（见常数注释）。
 *  - 合格锚点不足 N 个 ⇒ 如实少给；一个都没有 ⇒ 那行写「无可区分锚点」并**绝不回落到全库最高频标签**。
 *
 * 三、关于「缓存」与 I2 红线的边界
 *  - I2 禁止的是**请求级**可变状态（同一个键必须同值：所以这里严禁放进查询、agent、scope、时间）。
 *  - 这里允许的是**幂等的只读缓存**：键严格是文件身份三元组 `{path, size, mtimeMs}`，
 *    同键必同值（纯函数：内容 → 条数 + 锚点）。它与库自身的「外部改动守卫」用的是同一套身份口径
 *    （store.ts 的 StoreStamp），所以不会比库自己更乐观。
 *  - 缓存实例由 apply() 的闭包持有（模块级没有任何可变状态），可注入、可不用（不传就每次真读）。
 */
import { type MemoryConfig } from './store.js';
import type { MemoryRecord } from './protocol.js';
/** I4a 注入开关与预算（挂在 MemoryConfig.injection 上）。 */
export interface InjectionConfig {
    /** false = 完全不注册、不输出任何字符（默认 true）。 */
    enabled?: boolean;
    /** 注入行的**硬字符上限**（默认 240；超过天花板 4000 按 4000 处理）。 */
    maxChars?: number;
    /** 标签锚点个数（默认 3；超过天花板 64 按 64 处理）。 */
    topTags?: number;
    /**
     * I4a.2 锚点资格过滤的出现率上限（该标签的记录数 / 总记录数，默认 0.3，夹到 0..1）。
     * 严格大于它的标签**不得参与锚点**（覆盖全库的公共标签就此被剔除）。
     * 0 ⇒ 任何出现过的标签都超限（等于「不要锚点」，那行会如实写「无可区分锚点」）；
     * 1 ⇒ 过滤实际关闭（只作对照用，生产不建议）。
     */
    anchorMaxDfRatio?: number;
}
/** 解析后的注入口径（解析过程本身绝不抛：字段类型不对就回落默认值）。 */
export interface InjectionOptions {
    enabled: boolean;
    maxChars: number;
    topTags: number;
    anchorMaxDfRatio: number;
}
/**
 * 注入贡献的固定名字。引擎侧 context 名在同一 scope 内重复注册会抛错，
 * 所以固定名 + 「注册失败也不抛」的兜底是必需的。
 */
export declare const INJECTION_CONTEXT_NAME = "agent-memory";
/**
 * 显式顺序号：CONTEXT_ORDERS 里最大的既有值是 120（SUBAGENT_DELEGATION），
 * 取 200  ⇒ 排在所有既有 context 之后（尾部块）。未列名时 getContextOrder 返回 undefined，
 * 所以这里传显式数字而不是去查表。
 */
export declare const INJECTION_CONTEXT_ORDER = 200;
export declare const DEFAULT_INJECTION_ENABLED = true;
export declare const DEFAULT_INJECTION_MAX_CHARS = 240;
export declare const DEFAULT_INJECTION_TOP_TAGS = 3;
/**
 * I4a.2 锚点资格过滤的出现率上限起点：出现率（含该标签的记录数 / 总记录数）**严格大于**它的标签
 * 一律不参与锚点。**待真实语料标定**：0.3 是「先把覆盖全库的公共标签掐掉」的保守起点
 * （本机 194 条真实库上，`坑位` = 182/194 = 0.938 被剔除，合格集合里最高的是 `判据` 34/194 = 0.175）；
 * 想更严（只留真正稀疏的标签）可下调，例如 0.1；调到 1 等于关掉过滤（只作对照用）。
 */
export declare const ANCHOR_MAX_DF_RATIO = 0.3;
/** 天花板的理由：这一行会进每一步的上下文，配置写错（比如 100000）不能变成一次 prompt 爆炸。 */
export declare const INJECTION_MAX_CHARS_CEILING = 4000;
/** 同上：锚点数有上限，避免在一个手改过的巨大标签空间上做无界排序输出。 */
export declare const INJECTION_TOP_TAGS_CEILING = 64;
/** 锚点分隔符（固定常量，便于目视与断言）。 */
export declare const ANCHOR_SEP = " / ";
/**
 * 「库里有标签，但一个都没通过资格过滤」时那行的如实说明段。
 * 注意：**库内一条标签都没有**（空库 / 全部无标签）时**不写这一段**（沿用旧的最小行），
 * 两种情形是两回事：前者是「标签区分不了」，后者是「根本没有标签」。
 */
export declare const ANCHOR_NONE_MARK = "\uFF5C\u65E0\u53EF\u533A\u5206\u951A\u70B9";
/**
 * I4a.3「这是什么」：一句话说明这个库装的是什么（跨会话经验教训）。
 * 与「什么时候该用」是两件事，别合并：前者回答「这是什么」，后者回答「什么时候该用它」。
 */
export declare const INJECTION_WHAT = "\uFF08\u8DE8\u4F1A\u8BDD\u7ECF\u9A8C\u6559\u8BAD\uFF09";
/**
 * I4a.3「什么时候该用」＝ **条件规则**（尾部块的规则段）。
 *
 * 写作要求（本次改动立的契约，可判红）：
 *  - 必须含**触发条件**：由「类别词 + 动作」组成，而不是「有这个工具」这种陈述；
 *  - 触发条件之后紧跟**行动**（先 memory_recall 查库）——规则是「这种情况 ⇒ 做这个」；
 *  - 与查询无关、库不变时逐字节稳定（纯常量，无时间/随机/查询输入）。
 *
 * 反面教材（改动前的旧句，`INJECTION_TAIL = '｜细则用 memory_recall'`）：
 * 那是**陈述句**，只说明「细则可以怎么查」，没说「遇到什么该查」——
 * 真机观测到它上线以来一次都没触发过召回。
 */
export declare const INJECTION_RULE = "\u6392\u67E5\u00B7\u4E3A\u4EC0\u4E48\u00B7\u590D\u73B0\u00B7\u4EE5\u524D\u662F\u5426\u8E29\u8FC7 \u8FD9\u7C7B\u95EE\u9898\uFF0C\u5148 memory_recall \u67E5\u5E93";
/**
 * I4a.3 稳定段的名字（`section` 贡献）。与尾部块的 context 名字分开：
 * 引擎侧同名 section 会在同一 scope 内抛错（NamedEntries 守卫），固定名 + fail-open 是必需的；
 * 而 context 与 section 是**两张不同的注册表**，名字本可以撞，但这里刻意取不同名，便于目视区分。
 */
export declare const INJECTION_SECTION_NAME = "agent-memory-habit";
/**
 * I4a.3 稳定段的**显式顺序号**。
 *
 * 为什么必须显式传：`getSectionOrder(name)` 只对引擎自有的 SECTION_ORDERS 列名返回数字，
 * 对本插件这种外部名字**返回 undefined**（dsh-system-prompt/lib/index.js:249-251
 * `getSectionOrder(name) { return SECTION_ORDERS[name] }`），而 `section()` 对非有限 order
 * **直接抛 TypeError**（同文件 240-243）。所以照抄 persona 的 `getSectionOrder("...")` 写法是不行的。
 *
 * 为什么取 3200（而不是别的数）：
 *  - SECTION_ORDERS 的布局是分带的：引擎政策段（HARNESS_IDENTITY -1000 / persona 前缀 0 /
 *    PLAN_POLICY 500 / TEAM_POLICY 600 / PTC_ONLY 800 / FILE_REFERENCE 900）→ **工具说明带
 *    （TOOL_BASH 1000 … TOOL_COMPUTER_USE 3000 / MCP_SERVERS 3100）** → SDK 与交付带
 *    （TOOLS_SDK 5000 / DELIVERABLE_FILE_REFERENCES 9000 / STRUCTURED_OUTPUT 9900）→
 *    宿主环境与 persona 尾巴（HARNESS_SOURCE 10000 / WEB_SURFACE 10100 / persona 后缀 10200）。
 *  - 这条稳定段是一条**工具使用习惯**（「遇到这类问题先查记忆库」），紧贴工具说明带读最自然。
 *  - **3200 落在工具说明带之后、TOOLS_SDK(5000) 之前的空档**：该区间引擎没有任何自有槽位，
 *    而 section 只按 `order - order || name` 排序（同文件 97-98 comparePromptSections），
 *    所以这个数字**不会让任何引擎自有 section 的相对顺序发生变化**（不挤占、不顶掉任何槽位）。
 *  - 刻意避开语义敏感的槽位：0 附近是 persona 前缀与身份，9900+ 是结构化输出与 persona 后缀，
 *    把外部段插进去会干扰引擎的既定语义；空档里加一段则是纯增量。
 */
export declare const INJECTION_SECTION_ORDER = 3200;
/**
 * I4a.3 稳定段的**逐字文本**（一行，极短）。
 *
 * 为什么极短：它进的是**每一步的系统提示词正文**（稳定前缀），是按「每步都付」计费的常驻成本；
 * 细则（条数、锚点、查询语法）在尾部块与工具面里，这里只负责「把行为习惯钉住」。
 * 措辞与尾部块的 INJECTION_RULE 同源（同一类触发条件、同一个动作），但**不必逐字相同**：
 * 尾部那句是对库的说明的一部分，这句是对行为习惯的独立提醒。
 * 同样遵守：无 `{` `}`（引擎 interpolate() 会当变量引用）、无换行。
 */
export declare const INJECTION_HABIT_TEXT = "\u9047\u5230\u6392\u67E5\u00B7\u4E3A\u4EC0\u4E48\u00B7\u590D\u73B0\u00B7\"\u4EE5\u524D\u662F\u5426\u8E29\u8FC7\"\u8FD9\u7C7B\u95EE\u9898\uFF0C\u5148\u7528 memory_recall \u67E5\u8BB0\u5FC6\u5E93\uFF08\u8DE8\u4F1A\u8BDD\u7ECF\u9A8C\u6559\u8BAD\uFF09\u3002";
/** 极端超限时的硬截断标记（本身也算进上限）。 */
export declare const HARD_MARK = "\uFF08\u622A\u65AD\uFF09";
/** 一行注入文本的构建计划（truncated/omitted 用于如实报告，不是装饰）。 */
export interface LinePlan {
    text: string;
    truncated: boolean;
    omitted: number;
}
/** 只读缓存的三元组内容：同键必同值（纯函数：文件内容 → 条数 + 锚点 + 判据留痕）。 */
export interface InjectionCache {
    key: string | undefined;
    count: number | undefined;
    anchors: string[] | undefined;
    /** 库里有标签但一个都没通过资格过滤（决定那行是否写「无可区分锚点」）。 */
    noAnchor: boolean | undefined;
    /** 判据留痕（命中缓存时 diag 也必须如实，不能靠锚点数反推）。 */
    distinctTags: number | undefined;
    qualifiedTags: number | undefined;
}
/** 建一个空缓存；不传缓存给 buildInjectionIndex 就是「每次都真读」（纯函数路径）。 */
export declare function createInjectionCache(): InjectionCache;
/** 诊断字段：fail-open 时也要能看出「为什么没注入」。 */
export interface InjectionDiagnostics {
    ok: boolean;
    enabled: boolean;
    /** ok | empty-store（库空，给最小占位）| disabled（开关关掉）| read-failed（读/算失败，注入空串）。 */
    code: 'ok' | 'empty-store' | 'disabled' | 'read-failed';
    count: number;
    anchors: string[];
    maxChars: number;
    chars: number;
    truncated: boolean;
    omitted: number;
    /** 本次是否命中只读缓存（键 = {path,size,mtimeMs}）。 */
    cached: boolean;
    /** 失败原因（成功时为空串；绝不参与 prompt）。 */
    detail: string;
    /** I4a.2 本次用的锚点资格过滤上限（判据留痕：同一个库换个 ratio 会有不同的 anchors）。 */
    anchorMaxDfRatio: number;
    /** 库内出现过的可净化标签总数（去重）；0 = 库里根本没有标签。 */
    distinctTags: number;
    /** 通过资格过滤的标签数；distinctTags > 0 而它是 0 ⇒ 那行写「无可区分锚点」。 */
    qualifiedTags: number;
}
export interface InjectionResult {
    /** 要注入的一行文本；失败/关掉时是空串（绝不抛）。 */
    text: string;
    diag: InjectionDiagnostics;
}
/**
 * 解析注入口径（解析本身绝不抛：配置写错只降级，不炸每一步）。
 * 上限型字段一律夹到天花板；enabled 只认显式 boolean；anchorMaxDfRatio 夹到 0..1。
 */
export declare function resolveInjectionOptions(cfg?: InjectionConfig | null): InjectionOptions;
/**
 * 把任意文本净化成「可安全插值 + 单行」的形式：
 *  - 去掉 `{` `}`：引擎的 interpolate() 会把 `{{name}}` 当变量引用，未注册就**抛错**，
 *    而抛错点在整个 assemble() 里 ⇒ 会在每一步炸掉。锚点来自库（可能被手改成任意字符串），
 *    所以不能只在写入侧信任标签。
 *  - 去掉 C0/C1 控制字符与 Unicode 行分隔符 ⇒ 保证「一行」。
 * 返回长度**永不增长**（只删字符 + 折叠空格），所以先净化后计量即可保证 ≤ maxChars。
 */
export declare function sanitizeForPrompt(text: string): string;
/** 锚点选择的中间结果（anchors 之外还带上资格过滤的判据留痕，供 diag 与红证用）。 */
export interface AnchorPlan {
    /** 最终锚点（≤ topTags 个；可能为空 = 如实少给）。 */
    anchors: string[];
    /** 库内出现过的可净化标签总数（去重）；0 = 库里根本没有标签。 */
    distinctTags: number;
    /** 通过资格过滤（df 占比 <= maxDfRatio）的标签数。 */
    qualifiedTags: number;
}
/**
 * I4a.2 锚点选择：**先资格过滤，再排序取 top-N**。
 *
 * 1) 记录频次 df：每条记录内同名标签只计一次（口径就是「含该标签的记录数」，
 *    与出现率 df/总记录数 同一把尺子，避免「词次」与「记录数」两套口径各说各话）。
 * 2) 资格过滤：df / 总记录数 **严格大于** maxDfRatio 的标签一律剔除 —— 覆盖全库的标签
 *    区分不了任何两条记忆，进 prompt 就是纯噪音。**绝不因为过滤后为空而回落**。
 * 3) 排序：df 降序 → 标签码元升序（决胜确定，不依赖 Map 迭代顺序与 locale）。
 *
 * maxDfRatio 只认有限数字（越界夹到 0..1，非有限值回落默认）；NaN 之类的脏输入不会
 * 变成「不过滤」（那是最危险的静默失效方向）。
 */
export declare function planAnchors(records: ReadonlyArray<MemoryRecord>, topTags: number, maxDfRatio?: number): AnchorPlan;
/**
 * 全局标签锚点（**与查询无关**、只由库内容决定 ⇒ 库不变时逐字节稳定）。
 * 排序：记录频次降序 → 标签码元升序（决胜确定）；资格过滤见 planAnchors。
 * 第三参数默认就是生产口径 ANCHOR_MAX_DF_RATIO（**默认安全**：忘记传参也不会退化成「最高频」）。
 */
export declare function stableAnchors(records: ReadonlyArray<MemoryRecord>, topTags: number, maxDfRatio?: number): string[];
/**
 * 一行注入文本的构建阶梯（每一步都保证 ≤ maxChars；优先信息量，最后才硬截断）：
 *  1. 完整行（条数 + 这是什么 + **条件规则** + 全部锚点），装得下 ⇒ truncated=false；
 *  2/3. 逐个丢弃尾部锚点并**如实标注**省略了几个（标记本身也算进上限）；
 *  4. 只留「条数 + 这是什么 + 条件规则」的最小行（仍如实标注省略了几个锚点，装得下就带上）；
 *  5. 连最小行都装不下（maxChars 极小）⇒ 硬截断并带 `（截断）` 标记；
 *  6. 连标记都装不下 ⇒ 空串（**绝不超限**，也绝不硬塞半句假信息）。
 *
 * I4a.3 的结构固定为「条数 + 这是什么 + 什么时候该用 + 锚点」四段，顺序即语义：
 * 先说是多少、装的是什么，再说**什么情况该来查**（条件规则），最后才给锚点。
 * 压缩阶梯**只丢锚点**（尾巴），绝不丢条件规则段 —— 规则的缺省只能是「整行都没有」，
 * 不能是「有索引但没有触发条件」（那正是被本次改动判为失效的旧形态）。
 *
 * @param maxRecords - **保留形参、新文案不再回显**。上限是「库自身的容量参数」，
 *   既不属于「这是什么」也不属于「什么时候该用」；每步都占 prompt 预算不划算
 *   （容量由 prune 工具面与 recall 的输出承担）。保留形参是为了不动调用面
 *   （纯函数测试与 scripts 按位置传参），删掉会牵连一批无关改动。
 * @param noDiscriminatingAnchors - 库里有标签、但一个都没通过资格过滤（I4a.2）：
 *   这时那行写「无可区分锚点」而不是假装没有标签；**绝不回落到全库最高频标签**。
 *   库内一条标签都没有（空库/无标签）时传 false ⇒ 沿用最小行（不写这一段）。
 */
export declare function planInjectionLine(count: number, maxRecords: number, anchors: ReadonlyArray<string>, maxChars: number, noDiscriminatingAnchors?: boolean): LinePlan;
/**
 * 构建要注入的那一行。**绝不出异常**（读库失败 / 解析失败 / 字段缺失都只降级成空串 + diag）。
 *
 * @param cfg - 与工具面共用同一份 MemoryConfig（照旧走可注入的 FsOps 接缝）。
 * @param cache - 可选只读缓存（键严格是 {path,size,mtimeMs}；不传就是每次都真读）。
 */
export declare function buildInjectionIndex(cfg?: MemoryConfig, cache?: InjectionCache): InjectionResult;
