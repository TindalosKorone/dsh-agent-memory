/**
 * 纯函数层：时间衰减、RRF 多路融合、BM25 词法相关度、绝对标度展示、多样性并入分数。
 *
 * 约束：不碰 IO、不 import 任何运行时依赖、给定同一输入必然给出同一输出
 * （排序一律带 id 字典序做最终决胜，杜绝 V8 排序实现差异带来的不确定性）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 【纪律（I1.2 第三方设计审计点名，后人不要误改回去）】
 *
 * 「按批内极值归一化」在「查询场能量 / 传播预算」这类**作用对象**上是被允许的：
 * 那类量的语义本来就是「相对本次查询的预算分配」，归一化后比较才有意义。
 *
 * 但在**候选展示分**上它是被禁止的。一旦写成 `disp = raw / max(raw over 本批)`：
 * 无论候选多不相关，本批第一名恒等于 1.0000 —— 实测「今天天气怎么样」这种与库
 * 完全无关的查询，Top1 也照样打 1.0000，展示分彻底丧失绝对含义（第三方实测记录）。
 *
 * 两者作用对象不同，不要互相套用：
 *   - 允许：查询内部的预算 / 能量分配（作用对象 = 查询场本身）；
 *   - 禁止：候选展示分（作用对象 = 候选集合；一除就把无关候选抬成满分）。
 *
 * 展示分只走**固定绝对区间映射**：
 *   disp = clip((raw − SCALE_A) / (SCALE_B − SCALE_A), 0, 1)
 * SCALE_A / SCALE_B 是模块级常数（默认值见下，可用配置覆盖），**绝不随批次变化**。
 * 排序层与展示层解耦：排序用原始分 / 融合秩，展示用绝对映射后的 disp。
 * ─────────────────────────────────────────────────────────────────────────────
 */
export declare const DAY_MS = 86400000;
/** 时间衰减：越新越接近 1，越旧越接近 0；未来时间戳按「刚发生」处理（decay = 1，保证单调不增）。 */
export declare function decay(ts: number, now: number, halfLifeDays?: number): number;
/** 融合输入：字符串 id，或带 id 字段的对象。 */
export type RrfItem = string | {
    id: string;
};
export interface RrfOptions {
    /** RRF 平滑常数，默认 60。 */
    k?: number;
    /** 后续各路相对前一路的权重衰减系数，默认 0.6（榜首路权重 1）。 */
    alpha?: number;
}
export interface RrfEntry {
    id: string;
    /** 融合分（各路 weight / (k + rank) 求和）。 */
    score: number;
    /** 该 id 在各路中的名次（1 起，按路序）。 */
    ranks: number[];
}
/**
 * 多路有序列表融合（Reciprocal Rank Fusion 的加权变体）。
 *
 * - 第 i 路权重 = alpha ** i（i 从 0 起）⇒ 榜首路权重 1，越靠后的路越轻；
 * - 同一路内重复出现的 id 只记首次名次（确定性）；
 * - 排序：score 降序，同分按 id 字典序升序（稳定决胜）。
 */
export declare function rrf(rankLists: ReadonlyArray<ReadonlyArray<RrfItem>>, opts?: RrfOptions): RrfEntry[];
/** 字典序升序比较（显式实现，不依赖 locale）。 */
export declare function cmpId(a: string, b: string): number;
/**
 * 极简分词（不引依赖）：拉丁/数字连续串按整词切；汉字逐字切，并额外产出相邻二字组。
 * 中文没有空格，单靠整句匹配会大量漏召回，二字组是成本最低的补救。
 */
export declare function tokenize(text: unknown): string[];
/**
 * ── 真实语料标定（2026-10-09，第二次落地）──────────────────────────────────
 *
 * 标定工具：`node scripts/calibrate.mjs`（**默认只打印建议，绝不自动改写源码/配置**；
 * `--write` 是唯一的落地路径，且必须**显式请求**：写前备份成 `<target>.bak-<时间戳>`、打印逐行 diff、
 * 锚点缺失即失败关闭。本次运行的证据存档 `redproof/i7-calibrate-real-library.txt`）。
 *
 * 本次（第二次）标定语料：真实记忆库 **204 条**有效记录、正样本 **408** 个
 * （每条记录的标题 + 前 3 个标签各作一次查询、对自身打分）、负样本 **240** 个
 * （与库无关的冻结跨域词表查询，每个取库内最高分）；语料来源：`gotchas.md` 导入 + 手工教训记录。
 * 建议值 0.0199 / 0.3666 / 0.0382 / 0.1507，与落地前旧值的差为 +0.0012 / **+0.0246** / +0.0019 / +0.0031。
 * 按判据（差异 ≥ 0.005 视为显著）**只有 SCALE_B 单独显著**；但这四个量出自**同一次确定性运行**，
 * 跨运行混搭常数比整组落地更难解释，所以按整组落地，并在上句逐项写明各差多少。
 *
 * 上一次（第一次）落地的语料快照留档：库内 195 条、正样本 388 个、负样本 240 个，当时建议
 * 0.0188 / 0.3482 / 0.0364 / 0.1478（证据 redproof/i2.2-calibrate-real-library.txt）。
 * 2026-10-09 之后库长到 203/204 条，SCALE_B 的建议值随之抬到 0.3621 / 0.3666 ——
 * 这正是第一段那句「语料增长必须重标」的实例化。
 *
 * 四个常数各自取哪个分位数（脚本口径，不要顺手互换）：
 *   SCALE_A          = p50(负样本)   —— 噪声地板（无关查询的展示分压在 0 附近）
 *   SCALE_B          = p95(正样本)   —— 正样本高分位（真命中映射到 1.0000）
 *   WEAK_THRESHOLD   = p95(负样本)   —— 噪声上界（弱证据从噪声之上开始）
 *   STRONG_THRESHOLD = p10(正样本)   —— 正样本低分位（九成以上真命中判 strong）
 * 这四个量**只影响标签与展示**：WEAK/STRONG 决定 match 的 none/weak/strong，SCALE_A/SCALE_B
 * 只进展示分 disp；BM25、排序、召回集合、上限、分诊一概不读它们。
 *
 * 该语料有偏（单一项目、单一种文风），语料明显增长后必须用 `scripts/calibrate.mjs` 重新标定并同步更新本注释。
 *
 * 落地值（本行是 test/scoring.test.mjs 的「注释 ↔ 常数一致性」断言所锚定的机器可读行，格式别改）：
 * 落地值：SCALE_A = 0.0199  SCALE_B = 0.3666  WEAK_THRESHOLD = 0.0382  STRONG_THRESHOLD = 0.1507
 * 标定规模（本行同受一致性断言锚定，格式别改；供 memory_recall 比对「当前库条数」并如实报告漂移）：
 * 标定规模：CALIBRATION_RECORDS = 204  CALIBRATION_DATE = 2026-10-09
 */
/**
 * 标定时的库内有效记录数（机器可读行的镜像；标定注释见上方「真实语料标定」块）。
 * memory_recall 拿它与**当前库条数**比较，偏离超过阈值就在表头如实加一句「该重标了」。
 * **只进 recall 表头，绝不进自动注入那行**（注入文本必须稳定，否则每次写库都会改提示词）。
 */
export declare const CALIBRATION_RECORDS = 204;
/** 标定日期（ISO `YYYY-MM-DD`；机器可读行的镜像）。 */
export declare const CALIBRATION_DATE = "2026-10-09";
/**
 * 标定漂移阈值（起始值，可经 `score.calibrationDriftRel` / `score.calibrationDriftAbs` 覆盖）：
 *   - 相对偏差 > 20%，或
 *   - 绝对差 > 100 条，
 * 两者**取先到者**（任一命中即报漂移）。起点这么取的理由：库从 204 长到 ~245 或缩到 ~163 就
 * 触发相对阈值，绝对阈值 100 则防止小库上相对偏差过于敏感（例如 5 条库 ±1 条就是 20%）。
 * **待真实语料标定**：下次 calibrate 后按实际漂移速度复核这两个数。
 */
export declare const CALIBRATION_DRIFT_REL = 0.2;
export declare const CALIBRATION_DRIFT_ABS = 100;
/** 标定漂移的一次计算结论（纯函数，无库副作用）。 */
export interface CalibrationDrift {
    /** 标定时的库条数。 */
    calibratedRecords: number;
    /** 当前库条数。 */
    currentRecords: number;
    /** 有符号差（current − calibrated）。 */
    delta: number;
    /** 相对偏差（|delta| / calibrated；calibrated <= 0 时：current 也为 0 记 0，否则 +Infinity）。 */
    relative: number;
    /** 门槛：相对偏差阈值。 */
    driftRel: number;
    /** 门槛：绝对差阈值（条）。 */
    driftAbs: number;
    /** 是否超过阈值（相对或绝对，取先到者）。 */
    exceeded: boolean;
}
/**
 * 标定漂移计算（纯函数）：把「标定时的库规模」与「当前库规模」按两个阈值比一次。
 * 任一阈值被超过即 `exceeded=true`。非法阈值回落模块级默认；非有限 current 保守当 0。
 */
export declare function calibrationDrift(currentRecords: number, calibratedRecords?: number, driftRel?: number, driftAbs?: number): CalibrationDrift;
/**
 * 展示分绝对区间映射的下界，默认 0.0199 = 噪声地板 p50(负样本)。
 * 与 SCALE_B 一起构成「固定绝对区间」：不依赖任何候选的得分。
 */
export declare const SCALE_A = 0.0199;
/**
 * 展示分绝对区间映射的上界（raw 达到它即展示 1.0000），默认 0.3666 = p95(正样本)。
 * 旧值 0.45 是 offline 自语料夹具推出来的临时值（(3+2+1)·idf·sat 恒等式），已按真实语料替换；
 * 标定出处与分位数语义见上方「真实语料标定（2026-10-09，第二次落地）」块。
 */
export declare const SCALE_B = 0.3666;
/**
 * 绝对判定阈值（默认 0.0382 = p95(负样本)，噪声上界）：
 * raw ≥ WEAK_THRESHOLD 记 weak，raw ≥ STRONG_THRESHOLD 记 strong。
 * 更早的 0.06 只来自第三方审计的量级；在 240 个负样本上 p95 实测 0.0363 ⇒ 噪声上界下调，
 * 落在 (0.0363, 0.06) 的真相关记录从 none 变成 weak。本次（204 条库）再抬到 0.0382，
 * 于是又有一批 rel 落在 (0.0363, 0.0382) 的记录从 weak 落回 none ——
 * 两条边界红证都见 test/scoring.test.mjs（两条都能判红：改回旧值即红）。
 */
export declare const WEAK_THRESHOLD = 0.0382;
/** 见 WEAK_THRESHOLD。默认 0.1507 = p10(正样本)，正样本低分位。 */
export declare const STRONG_THRESHOLD = 0.1507;
/**
 * 多样性惩罚系数 β 默认值：`final = rel × (1 − β·maxSimToSelected)`。
 * 只作用于同一分数（不再做「先重排、后打印」的两段式）⇒ 列表按 final 降序，打印天然单调。
 */
export declare const DEFAULT_DIVERSITY_BETA = 0.3;
/** BM25 词频饱和参数（第三方给定口径，不要手改）。 */
export declare const BM25_K1 = 1.2;
/** BM25 文档长度归一参数（第三方给定口径）；b=0 即关掉长度归一（红证用）。 */
export declare const BM25_B = 0.75;
/** 打分字段（标签 / 标题 / 正文）。 */
export type ScoreField = 'tags' | 'title' | 'body';
/** 字段遍历顺序（固定，保证求和顺序确定 ⇒ 浮点结果可复现）。 */
export declare const SCORE_FIELDS: readonly ScoreField[];
/** 字段权重：tags 高于 title 高于 body。 */
export declare const FIELD_WEIGHTS: Readonly<Record<ScoreField, number>>;
/** 绝对判定三档。 */
export type MatchLevel = 'none' | 'weak' | 'strong';
/**
 * ── 内容量闸门（本次新增；只改判定 match 的诚实性，绝不动 rel 与四个已标定常数）──────
 *
 * 病灶（真实 204 条库实测，redproof/i9-short-query-gate.*）：`rel` 是
 * `BM25 原始分 ÷ 查询自身的理论上界`，而**单内容词元**的查询几乎能独自顶到那个上界
 * ⇒ 比值虚高。实测 `ok`(rel=0.1867)、`做`(0.1829)、`b`(0.1707) 三条**完全无关**的记忆都判
 * `strong`（阈值 0.1507）；而真话题 `虚拟屏`（3 个字符但 5 个内容词元）rel=0.5549。
 *
 * 判据：**内容词元数 qTok** = 去重后的查询词元里、**在本库任一分词字段（tags/title/body）
 * 至少出现过一次**（df>0）的个数。取这个量而不是字符数：
 *   - `虚拟屏` 只有 3 个字符却切出 5 个内容词元（虚/虚拟/拟/拟屏/屏）⇒ 不被封顶；
 *   - `ok`/`做`/`b` 各只有 1 个 ⇒ 被封顶。字符数闸门会把前者一起压掉（红证 i9-red2）。
 *
 * 为什么**不**用 idf 质量/最高 idf 当闸门（实测过的反例，别改回去）：
 *   - 本库上噪声 `好的` 的 idf 质量 qIdf=6.49 **高于**真话题 `快照`=3.90、`注入`=2.93、`判据`=2.57；
 *   - `虚拟屏` 的逐词元 idf 约 2.0~2.35，与 `好的` 的均值 2.16 在统计上不可区分。
 *   ⇒ idf 阈值会**先误伤真话题再压噪声**，方向是反的。字符数/idf 都试过，只有「有几个内容词元」能同时满足两侧。
 *
 * 阈值标定（2026-10-09，真实 204 条库；证据 redproof/i9-*.txt）：
 *   - 噪声侧：`ok`/`做`/`b` 的 qTok 全是 1；
 *   - 话题侧：`虚拟屏` qTok=5、`虚拟屏不能用吗？` qTok=11（该库全部真话题查询 qTok>=3）；
 *   - 取**能判红的最小值 2**：任何更大的阈值都会开始封顶 qTok=3 的真短话题
 *     （`快照`/`门禁`/`注入` 实测 qTok 均为 3，rel≈0.5 判 strong，不该被封顶）。
 *   代价（如实声明）：单内容词元的查询（如英文单标签 `adb`/`ci`）从此最多 weak；
 *   本库 795 个正样本里 83 个（10.4%）落在这一档 —— 方向是**保守**的（宁可不吹 strong，也不误伤真话题）。
 *
 * ── 闸门例外：离阈值多远才封顶（本次新增；只加例外，不改 rel 与四个标定常数）──────
 *
 * 病灶（同上，真实库实测）：纯 qTok 封顶会**误杀「单个高专有词元」的真话题** ——
 * 一个内容词元也能把 rel 顶到远超 strong 阈值。本机 205 条真实库实测（redproof/i11-*.txt）：
 *   - 真话题侧：`adb` qTok=1、rel=0.6557 = strong 阈值 0.1507 的 **4.35 倍**；
 *     （任务书点名的 `OpenSCAD` 已不在当前库里 —— grep 全库 0 命中，故改用同形的真实词元 `adb`，
 *      并在 test/scoring.test.mjs 用合成语料把「单内容词元 + 远超阈值」这条形态钉死。）
 *   - 噪声侧：`ok` 1.23 倍、`做` 1.21 倍、`b` 1.13 倍 —— 都只是**贴线**。
 * 判据：贴线的噪声该压，离阈值远的真话题不该压 ⇒ 封顶条件再加一条「rel 离 strong 不够远」：
 *   qTok < min **且** rel < GATE_MARGIN × strong 才封顶。
 *
 * GATE_MARGIN 起始值（**待真实语料标定**，本行是 test/scoring.test.mjs 的机器可读锚点，格式别改）：
 * 闸门余量 GATE_MARGIN = 2.0
 * 依据：噪声侧实测 1.13~1.23 倍、真话题侧实测 4.35 倍，2.0 落在两者之间（保守取值：
 * 优先不误杀真话题，代价是 `ci` 这类 1.77 倍的单内容词元查询仍被封顶）。
 * 该值可经 `score.gateMargin` 覆盖；传 0 表示**永不封顶**（红证用），非法值一律回落 2.0。
 *
 * 语义（表头按分支逐字回显，读者可用打印量复算 match）：
 *   match = 无内容量(qTok=0) ? none
 *         : qTok < CONTENT_TOKEN_MIN ? (base=strong 且 rel < GATE_MARGIN×strong ? weak : base)
 *         : matchLevel(rel, …)
 *   注意 qTok=0 时 rel 必然 = 0（num=0）⇒ `none` 由 matchLevel 已经给出，闸门只负责 strong→weak 的封顶。
 *   因此**绝不整批否决**：低内容量查询照样返回行，只是不再宣称 strong。
 */
export declare const CONTENT_TOKEN_MIN = 2;
/**
 * 内容量闸门的「离阈值多远」例外倍数（默认 2.0；见 CONTENT_TOKEN_MIN 上方的标定注释）。
 * 封顶条件 = `qTok < min 且 rel < GATE_MARGIN × strong`；越大越少封顶。
 * **待真实语料标定**：下次 calibrate 时应把噪声倍率与真话题倍率一并记录，据此复核本值。
 */
export declare const GATE_MARGIN = 2;
/** 打分口径的可覆盖项（配置来自工具 config，见 resolveScoreOptions）。 */
export interface ScoreOptions {
    scaleA?: number;
    scaleB?: number;
    weakThreshold?: number;
    strongThreshold?: number;
    diversityBeta?: number;
    /** 内容量闸门阈值（内容词元数下限），默认 CONTENT_TOKEN_MIN=2；设 1 等价于关掉闸门（红证用）。 */
    contentTokenMin?: number;
    /** 闸门例外倍数，默认 GATE_MARGIN=2.0；0 = 永不封顶（红证用），非法值回落默认。 */
    gateMargin?: number;
    /** 标定漂移的相对偏差阈值（默认 CALIBRATION_DRIFT_REL=0.2）。 */
    calibrationDriftRel?: number;
    /** 标定漂移的绝对差阈值（条，默认 CALIBRATION_DRIFT_ABS=100）。 */
    calibrationDriftAbs?: number;
}
/** 已解析（always 有值）的打分口径。 */
export interface ResolvedScoreOptions {
    scaleA: number;
    scaleB: number;
    weak: number;
    strong: number;
    beta: number;
    contentTokenMin: number;
    gateMargin: number;
    calibrationDriftRel: number;
    calibrationDriftAbs: number;
}
/** 夹到 0..1；非有限值一律夹成 0。 */
export declare function clamp01(value: number): number;
/**
 * 解析打分配置：显式配置 > 模块级常数默认。
 * 非法输入（非有限数）一律回落默认；SCALE_B 必须严格大于 SCALE_A（否则回落 SCALE_A + 1）；
 * weak > strong 时交换（保证 match 单调）。**任何一支都不引入批次相关量。**
 */
export declare function resolveScoreOptions(opts?: ScoreOptions): ResolvedScoreOptions;
/**
 * 固定绝对区间映射：disp = clip((raw − scaleA) / (scaleB − scaleA), 0, 1)。
 *
 * **绝不使用批内极值**（见本文件顶部纪律注释）：函数签名里根本没有「本批候选」这个入参，
 * 所以同一 raw 在任何批次里都得到同一个 disp，不存在「第一名恒为 1.0000」。
 */
export declare function absoluteDisp(raw: number, scaleA?: number, scaleB?: number): number;
/** 绝对判定：raw 与两个绝对阈值比较（不涉及任何批次统计）。 */
export declare function matchLevel(raw: number, weak?: number, strong?: number): MatchLevel;
/**
 * 查询的**内容词元数** qTok（内容量闸门的唯一输入，见 CONTENT_TOKEN_MIN 的注释）。
 *
 * 口径：查询去重分词后，落在**本库任一分词字段**（tags/title/body）里至少出现过一次的
 * 词元个数（即「在库内有据可查」的词元）。库内一次都没出现过的词元（df 全为 0）不计：
 * 它们既召回不到东西、也提示不了话题（`zzq` 这类拼凑串就是这种）。
 *
 * 只看现算出来的 CorpusStats，**不引入任何批次相关量、不读候选得分** —— 与 rel 同一条隔离纪律。
 */
export declare function queryContentTokens(query: unknown, stats: CorpusStats): number;
/**
 * 带内容量闸门（含「离阈值多远」例外）的绝对判定（**唯一**被 recall 路径调用的判定函数）：
 *
 *   match = 无内容量(qTok=0) ? none
 *         : qTok < contentTokenMin ? (base=strong 且 raw < gateMargin×strong ? weak : base)
 *         : matchLevel(raw, weak, strong)
 *
 * 四层：
 *  1. `qTok = 0` ⇒ 查询里没有一个词元在库内出现过 ⇒ 不可能有词法证据 ⇒ rel 必然为 0
 *     ⇒ `matchLevel` 已经给出 `none`（这里显式短路，让规则与表头回显逐字对应，也防万一）；
 *  2. `qTok < contentTokenMin` 且 `base=strong` 且 `raw < gateMargin×strong` ⇒ 贴线的强判定：
 *     **只封顶 strong，不封顶 weak**（短查询照样返回行，绝不整批否决）；
 *  3. `qTok < contentTokenMin` 但 `raw >= gateMargin×strong` ⇒ **例外放行**：单个高专有词元
 *     （实测 `adb` 达 4.35×strong）不再被误杀，仍判 strong；
 *  4. 否则原样 `matchLevel(raw, weak, strong)`（长查询、真话题完全不受影响）。
 *
 * 单调性：weak > strong 被交换的配置（resolveScoreOptions）下 `base='strong'` 仍是最高档，
 * 封顶到 weak 依然单调；非有限 qTok 一律保守（NaN/-Infinity 当 0，只有缺省 +Infinity 表示「不封顶」），
 * 阈值非法一律回落 CONTENT_TOKEN_MIN；倍数非法（负数/非有限）回落 GATE_MARGIN，**0 是合法值**
 * （表示永不封顶，判红点用）。
 */
export declare function matchLevelGated(raw: number, weak?: number, strong?: number, contentTokens?: number, contentTokenMin?: number, gateMargin?: number): MatchLevel;
/**
 * 频次 / 边权类量一律先做 log(1 + λW) 压缩，**禁止线性累加**（第三方审计点名）。
 * 说明：BM25 内部对 tf 的压缩由 (k1+1) 饱和完成（有界，非线性）；本函数用于
 * 「全局频次 / 共现边权」这类会被直接当权重的量（见 tagCoverage 的 logfreq 口径）。
 */
export declare function logCompress(weight: number, lambda?: number): number;
/** BM25 的 idf：log(1 + (N − df + 0.5) / (df + 0.5))。df=0（语料里没有该词）时取到最大值。 */
export declare function idf(df: number, n: number): number;
/**
 * BM25 的单词语义饱和项：tf·(k1+1) / (tf + k1·(1 − b + b·|D|/avgdl))。
 * 上界为 (k1+1)（tf→∞），随 |D|/avgdl 增大而下降 ⇒ 长文档不靠堆词频白拿分。
 */
export declare function fieldSat(tf: number, dl: number, avgdl: number, k1?: number, b?: number): number;
/** 单个字段的语料统计（该字段自己的 N / avgdl / df）。 */
export interface FieldStats {
    /** 该字段非空的记录数。 */
    n: number;
    /** 该字段的平均词元数（仅对该字段非空的记录求平均）。 */
    avgdl: number;
    /** 词元 → 含该词元的记录数。 */
    df: Map<string, number>;
}
/** 一次召回用到的全部语料统计（**每次调用现算**，绝不放模块级可变全局）。 */
export interface CorpusStats {
    /** 记录总数。 */
    total: number;
    /** 按字段各自的统计。 */
    fields: Record<ScoreField, FieldStats>;
    /** 标签字符串（trim + 小写）→ 含该标签的记录数（供 cov 用）。 */
    tagDf: Map<string, number>;
    /** 至少有一个标签的记录数。 */
    tagN: number;
}
/** 词法打分的输入（只需标题/正文/标签）。 */
export interface LexicalRecord {
    title?: unknown;
    body?: unknown;
    tags?: unknown;
}
/** 取某字段的规范化标签串（trim + 小写 + 去空 + 去重，保持出现顺序）。 */
export declare function normalizedTags(tags: unknown): string[];
/** 取某字段的词元序列（tags 以空格连接后分词）。 */
export declare function fieldTokens(record: LexicalRecord | null | undefined, field: ScoreField): string[];
/**
 * 现算语料统计：N / avgdl / df 全部按字段各自统计（字段内部的 df/avgdl 用该字段自己的统计）。
 * 刻意**不做**模块级缓存：第三方明确记录过「全局单例与并发不兼容」，一次召回一个快照最稳。
 */
export declare function corpusStats(records: ReadonlyArray<LexicalRecord | null | undefined>): CorpusStats;
/** BM25 单次打分的可覆盖参数（红证用 b=0 关掉长度归一）。 */
export interface Bm25Options {
    k1?: number;
    b?: number;
}
/**
 * BM25 相关度，归一化到 0..1。
 *
 * 做法（第三方给定口径）：查询词元去重后，**按字段各算 BM25 再加权求和**（字段内部用该字段
 * 自己的 df/avgdl）。再除以**查询在语料统计下的理论上界** Σ_w Σ_f w_f·idf_f(w)·(k1+1)：
 *
 *   rel = Σ_f w_f · Σ_w idf_f(w)·sat_f(w,D)   ÷   Σ_f w_f · Σ_w idf_f(w)·(k1+1)
 *
 * 因为 sat 的上界就是 (k1+1)，所以 rel 天然落在 0..1（浮点误差用 clamp 兜底）。
 *
 * 这个分母**不是批内归一化**，不要混淆（见文件顶部纪律注释）：
 *  - 它只依赖「查询词 + 语料统计（N/df/avgdl）」，**不依赖任何候选的得分**，更不是本批最大值；
 *  - 因此无关候选照样可以是 0（不会因为「本批第一名」被抬成 1.0000）；
 *  - 它的作用是给「不同查询」一个可比的绝对标度，让 WEAK/STRONG 两个绝对阈值有意义。
 */
export declare function bm25Relevance(query: unknown, record: LexicalRecord | null | undefined, stats: CorpusStats, opts?: Bm25Options): number;
/**
 * 词法相关度（主分）：BM25 + 字段权重 + 0..1 绝对标度。
 *
 * 契约（I1.2 起，与 I1.1 的「Σ(字段权重×命中词元数)/(6×查询词元数)」不同，已在用例里同步更新）：
 *   rel = Σ_f w_f · Σ_w idf_f(w)·sat_f(w,D) / Σ_f w_f · Σ_w idf_f(w)·(k1+1)，w = tags:3 / title:2 / body:1
 * 性质：tags > title > body（同 tf 时严格按 3:2:1）；长文档被长度归一压低；无关查询为 0。
 *
 * 省略 stats 时用「自语料」（只含这一条记录）现算 —— 仅供单条调用/夹具使用；
 * 召回路径必须传入整库 corpusStats（否则 df/avgdl 退化为单条，失去 idf 与长度归一的意义）。
 */
export declare function lexicalScore(query: unknown, record: LexicalRecord | null | undefined, stats?: CorpusStats, opts?: Bm25Options): number;
/** cov 的标签权重口径。 */
export type TagWeighting = 'idf' | 'logfreq';
export interface CoverageOptions {
    /** 标签权重口径，默认 'idf'（idf 自身即对数压缩）；'logfreq' 用 1/log(1+λ(df+1))。 */
    weighting?: TagWeighting;
    /** log 压缩系数 λ，默认 1。 */
    lambda?: number;
}
/** 标签权重：idf，或 1/log(1+λ(df+1))（分母恒 > 0；都随全局频次单调递减）。 */
export declare function tagWeight(tag: string, stats: CorpusStats, opts?: CoverageOptions): number;
/** 标签是否被查询命中：标签串本身命中，或它的任一词元被查询命中（中文二字组友好）。 */
export declare function tagHitsQuery(tag: string, queryTokens: ReadonlySet<string>): boolean;
/**
 * VCP 式覆盖率：cov = Σ(命中标签的权重) / Σ(候选全部标签的权重)。
 *
 * 作用：长文档的外围公共标签只能**稀释**（进分母）不能加分 —— 权重低 + 不算命中。
 * I1.2 里 cov **只作诊断列，不做门控**（低覆盖不得否决整批、不得返回空，第三方回退过这种做法）。
 */
export declare function tagCoverage(query: unknown, tags: unknown, stats: CorpusStats, opts?: CoverageOptions): number;
/** 多样性重排的输入：相关度分 + 标签（+ 融合秩，用于同分决胜）。 */
export interface DiversifyRecord {
    id: string;
    /** 相关度分（惩罚前）。 */
    score: number;
    tags?: readonly string[];
    /** 融合名次（越小越靠前）；缺省 0。同分时先按它、再按 id 字典序决胜 ⇒ 确定性。 */
    rank?: number;
}
/** 多样性重排的输出：原记录 + 选中时刻的最终分。 */
export type DiversifiedRecord<T extends DiversifyRecord> = T & {
    /**
     * 选中时刻的最终分：final = score × (1 − β·maxSimToSelected)。
     * 列表就是按它降序的 ⇒ 打印这一列天然单调不增（I1.2 修 C 的要害）。
     */
    final: number;
};
export interface DiversifyOptions {
    /** 多样性惩罚系数 β（优先于 lambda）。默认 DEFAULT_DIVERSITY_BETA = 0.3。 */
    beta?: number;
    /** I1.1 旧口径兼容：λ = 1 − β（lambda=1 ⇒ β=0 退化为纯按分数）。 */
    lambda?: number;
    /** 取回条数上限。 */
    limit?: number;
    /** 候选数 <= 该值时跳过多样性（小候选集拿不到多样性收益，纯添乱）。默认 0 = 不跳过。 */
    minCandidates?: number;
}
/**
 * 把多样性**乘进同一个分数**后按该分数降序输出（I1.2 修 C）。
 *
 *   final = rel × (1 − β·maxSimToSelected)，β 默认 0.3。
 *
 * 为什么这样就不会再出现「0.9763 排在 0.9785 前面」：I1.1 是「先归一化 → MMR 只改顺序 →
 * 仍打印归一化分」，于是打印列与列表顺序脱钩。现在顺序与打印列是同一个数（final），
 * 且贪心选择序列本身单调不增（每选一个，剩余候选的 maxSim 只增不减）⇒ 打印天然单调。
 *
 * `候选数 <= minCandidates` 时跳过多样性（第三方做法：小候选集只重排、拿不到多样性收益、纯添乱）。
 * 注意：minCandidates 默认 0（纯函数层不预设策略），召回层显式传 5。
 */
export declare function diversify<T extends DiversifyRecord>(records: ReadonlyArray<T>, opts?: DiversifyOptions): Array<DiversifiedRecord<T>>;
/** 基的规模上限（参与 Gram-Schmidt 的候选标签向量个数）。 */
export declare const MAX_BASIS = 6;
/** 投影层数上限。 */
export declare const MAX_LAYERS = 3;
/** 提前停止的残差能量比例：残差 < 该比例 × 原始能量就停。 */
export declare const RESIDUAL_STOP = 0.1;
/** novelty 里残差项的权重。 */
export declare const NOVELTY_RESIDUAL_WEIGHT = 0.7;
/** novelty 里方向一致性项的权重（两项权重和 = 1 ⇒ novelty 天然落在 0..1）。 */
export declare const NOVELTY_DIRECTION_WEIGHT = 0.3;
/** 分诊门控默认阈值：novelty >= 它 ⇒ 扩检索。 */
export declare const DEFAULT_NOVELTY_THRESHOLD = 0.5;
/** 低置信默认阈值：cov_max < 它 ⇒ lowConfidence（**只如实报告，绝不否决/返回空**）。 */
export declare const DEFAULT_ACTIVATION_THRESHOLD = 0.05;
/** 稀疏算术的零判定阈值（能量量级，1e-12 足够小且不吞掉真实的微小能量）。 */
export declare const PYRAMID_EPS = 1e-12;
/** 分诊口径（全部有模块级默认常数，可经工具配置覆盖）。 */
export interface TriageOptions {
    noveltyThreshold?: number;
    activationThreshold?: number;
    maxBasis?: number;
    maxLayers?: number;
    residualStop?: number;
}
/** 已解析（always 有值）的分诊口径。 */
export interface ResolvedTriageOptions {
    noveltyThreshold: number;
    activationThreshold: number;
    maxBasis: number;
    maxLayers: number;
    residualStop: number;
}
/** 解析分诊配置：显式配置 > 模块级默认；非法值一律回落，绝不接受 NaN/负层数。 */
export declare function resolveTriageOptions(opts?: TriageOptions): ResolvedTriageOptions;
/** 稀疏向量：词元 → 权重（只存非零项，未出现的词元视为 0）。 */
export type SparseVector = ReadonlyMap<string, number>;
/**
 * 稀疏点积。只遍历较短的一侧（常数因子优化），且按该侧的插入顺序累加
 * ⇒ 同一输入必然同一浮点结果（不依赖 Map 大小差异带来的遍历顺序漂移）。
 */
export declare function sparseDot(a: SparseVector, b: SparseVector): number;
/** ‖v‖²。 */
export declare function sparseNorm2(v: SparseVector): number;
/**
 * 标签 idf 加权的词元向量：`tokenize(tokens)` 去重后逐项取 tagWeight(t) = idf(df, tagN)。
 * 词元按首次出现顺序入表 ⇒ 同输入同顺序（浮点求和顺序固定）。
 */
export declare function tagVector(tokens: ReadonlyArray<string>, stats: CorpusStats): Map<string, number>;
/**
 * 经典 Gram-Schmidt 正交化（返回**正交归一**基）：
 * 逐个减掉与已接受单位基向量的投影，再归一化；范数 <= PYRAMID_EPS 的向量
 * （零向量，或与已有基线性相关）直接丢弃 —— 这正是「基的规模」只增不虚的原因。
 *
 * 数值说明：维度很小（词元数 + 最多 maxBasis 个基），一次正交化足够稳定，
 * 仍显式跳过退化向量，保证输出里不出现 NaN/Infinity。
 */
export declare function gramSchmidt(vectors: ReadonlyArray<SparseVector>): Array<Map<string, number>>;
/** 投影能量分布 → 熵与逻辑深度。 */
export interface ProjectionEntropy {
    /** 香农熵（bit），落在 [0, log2(K)]。 */
    entropy: number;
    /** K = 参与投影且能量 > 0 的基个数。 */
    k: number;
    /** 逻辑深度 = 1 − H / log2(K)，落在 [0,1]。 */
    logicalDepth: number;
}
/**
 * 投影熵 → 逻辑深度。
 *
 * p_i = e_i / Σe（e_i 是第 i 层的投影能量 c_i²，**这是查询场自身的归一化，不是候选展示分**），
 * H = −Σ p_i·log2 p_i，logicalDepth = 1 − H / log2(K)，K = 能量 > 0 的层数：
 *   - 能量集中在一个方向（K=1，或某一层独占）⇒ H=0 ⇒ logicalDepth=1；
 *   - 能量在 K 个方向上均摊 ⇒ H=log2(K) ⇒ logicalDepth=0。
 * 边界（不许 NaN）：K=0（没有基/没有投影）⇒ {0,0,0}；K=1 ⇒ H=0 且 log2(1)=0，
 * `1 − 0/0` 会出 NaN，所以**显式定义 logicalDepth = 0**（只有一个方向承载全部能量时
 * 没有「分布」可言，逻辑深度无信息，取 0 而不是 NaN）。
 */
export declare function projectionEntropy(energies: ReadonlyArray<number>): ProjectionEntropy;
/** 一个基候选（召回路径传的是「按分数排好序的前 kBase 个候选」）。 */
export interface PyramidBasisItem {
    id?: string;
    tags?: unknown;
}
/** 残差金字塔的分诊结果（全部落在 [0,1]，除 basisSize/layers/projectedBasis 是计数）。 */
export interface PyramidResult {
    /** 新颖度 = 0.7 × residualRatio + 0.3 × directionConsistency。 */
    novelty: number;
    /** ‖P‖²/‖q‖²：被基解释掉的能量比例。 */
    explainedRatio: number;
    /** ‖R‖²/‖q‖²：剩下的能量比例（实现上取 1 − explainedRatio ⇒ 两者和恒为 1）。 */
    residualRatio: number;
    /** 见下方长注释里的定义。 */
    directionConsistency: number;
    /** 投影熵（bit）。 */
    projectionEntropy: number;
    /** 逻辑深度。 */
    logicalDepth: number;
    /** 正交归一基的规模（≤ maxBasis，已丢弃线性相关向量）。 */
    basisSize: number;
    /** 实际投影的层数（≤ maxLayers；提前满足停止条件会更少）。 */
    layers: number;
    /** K = 参与投影且能量 > 0 的基个数。 */
    projectedBasis: number;
    /** 本次使用的 novelty 阈值（打印出来，读者才能自行复算 expanded）。 */
    noveltyThreshold: number;
    /** 是否扩检索：novelty >= noveltyThreshold。**与 lowConfidence 无关**（低置信不否决）。 */
    expanded: boolean;
    /**
     * 查询是否**没有**词元能量（‖q‖² ≈ 0，I2.1 修 2）。
     * true ⇒ 本查询**未做分诊**：novelty=0、expanded=false、explainedRatio/residualRatio
     * 回显 0/0（未定义）。上层必须在表头如实写明「无词元能量，未分诊」，不许假装算过。
     */
    noQueryEnergy: boolean;
}
/**
 * 残差金字塔：在词法向量空间里对基做 Gram-Schmidt 正交化，逐层投影查询向量，
 * 用「被解释的能量比例 / 残差方向是否是新方向 / 投影熵」三件事给查询分诊。
 *
 * 分工：本函数只算分诊量（纯函数，无 IO、无全局状态）；扩检索与低置信报告在召回层做，
 * 因为那要碰候选集与展示分。
 *
 * directionConsistency（**我的定义，必须写清，因为字面写法是退化量**）：
 * 先记一个结构性事实：基做过 Gram-Schmidt，投影是**正交投影**，于是
 * R = q − Σ_{i≤layers} c_i·u_i 必然与**所有已参与投影的基向量**正交，特别地 ⟨R, u_1⟩ ≡ 0。
 * 所以「残差方向与第一层投影方向的余弦」的字面写法 1 − |cos(R, u_1)| 恒等于 1
 * （只要 layers ≥ 1 且 R ≠ 0）—— 它不携带任何信息，还会给每个有残差的查询白送 0.3 分。
 * 这个量的本意是「残差是不是一个新方向」，所以我把定义挪到**尚未参与投影的基向量**上：
 *
 *   directionConsistency = 1 − max_{j > layers} |cos(R, u_j)|      （u_j 是单位基向量）
 *
 * 语义：残差若仍落在「基里还留着、这几层没用上」的方向上 ⇒ 不是新方向（→0）；
 * 残差若与所有未投影基向量都正交 ⇒ 基给不出这个方向（→1）。
 * 边界（都不许出 NaN）：
 *   - ‖R‖² ≈ 0（查询被基完全解释）⇒ 没有残差方向 ⇒ 定义 0
 *     （于是「完全被解释 ⇒ novelty = 0」，不会因为余项白拿分）；
 *   - 未投影基为空（layers = basisSize）而 R ≠ 0 ⇒ max 取 0 ⇒ 定义 1
 *     （残差按构造与本基子空间正交，确实是新方向）；
 *   - 一个基向量都没有（basisSize = 0）而 R ≠ 0 ⇒ 同样 1（没有任何方向能解释它）。
 *
 * I2.1 修 2（空查询不做分诊）：‖q‖² ≈ 0 时**直接短路返回**（见函数体），
 * novelty=0、expanded=false、explainedRatio=residualRatio=0（0/0 未定义，见那里的长注释）。
 */
export declare function residualPyramid(query: unknown, basisCandidates: ReadonlyArray<PyramidBasisItem | null | undefined>, stats: CorpusStats, opts?: TriageOptions): PyramidResult;
/** 边权 / 频次的 log 压缩系数 λ（起点 1，**待真实语料标定**）。 */
export declare const GRAPH_LAMBDA = 1;
/** 每个节点的出边总权重预算上限 m_out（起点 1，**待真实语料标定**）。 */
export declare const GRAPH_OUT_BUDGET = 1;
/** 枢纽校正指数 η（起点 0.5，**待真实语料标定**）。 */
export declare const GRAPH_HUB_ETA = 0.5;
/** 传播跳数上限（起点 2，**待真实语料标定**）。 */
export declare const GRAPH_MAX_HOPS = 2;
/** 传播状态数上限（起点 64，**待真实语料标定**）。 */
export declare const GRAPH_MAX_STATES = 64;
/** 每个节点最多沿多少条最强出边扩散（起点 4，**待真实语料标定**）。 */
export declare const GRAPH_MAX_FIELD_NEIGHBORS = 4;
/** 每跳衰减 γ（起点 0.60，**待真实语料标定**）。 */
export declare const GRAPH_DECAY = 0.6;
/** 立即回流抑制 ρ（起点 0.15）：不许沿刚来的那条边原路返回。 */
export declare const GRAPH_BACKFLOW_RHO = 0.15;
/** 图奖励硬上限（起点 0.018，**待真实语料标定**）：第三方「辅助奖励硬上限」的量级。 */
export declare const GRAPH_BONUS_CAP = 0.018;
/**
 * 「标签激活 → 记忆图奖励」的折算系数 K（**待真实语料标定**）：
 *
 *   graph(记录) = min(GRAPH_BONUS_CAP, K × graphBonusRaw(记录))
 *   graphBonusRaw(记录) = max_{t ∈ 记录标签, t 有激活} activation(t)
 *
 * 其中 activation(t) ∈ (0,1] 是本次传播得到的归一化标签激活（activationMin 以下不算证据）。
 * 说明：**只用激活、不再乘「标签出边权」**。理由：出边权已经在传播里用过一次了
 * （每跳 gain = 出边权 × 上游激活 × γ × (1−ρ)），再乘一次等于把同一个结构因子平方计入；
 * 更要紧的是「终端标签」（只有入边、没有出边的收敛点）会让加权版恒为 0 —— 而它恰恰是
 * 波浪走到终点时最该被标记的那类证据。传播本身已经同时体现「log 压缩 + 出流预算 + 枢纽抑制」
 * 三个约束，激活值就是它们的合成结果，直接取用即可。
 *
 *   - 取 **max** 不取和：标签多的记录 / 万能标签不得白拿加成 —— 那正是本机制要防的污染路径；
 *   - activation <= 1 ⇒ graphBonusRaw <= 1 ⇒ `min(bonusCap, K × ...)` 的硬上限恒成立；
 *   - **没有任何图证据 ⇒ 恰好 0**（只奖不罚，绝不因此整批否决或返回空）。
 *
 * K 越小 ⇒ 硬上限越少被触发、图奖励越平缓（**K 是「标定旋钮」，先用留有余量的起点值**）。
 */
export declare const GRAPH_BONUS_SCALE = 0.25;
/** 标签激活的下限：低于它不算「有图证据」（也就不会给任何记忆加奖励）。 */
export declare const GRAPH_ACTIVATION_MIN = 0.05;
/** 传播/图算术的零判定阈值。 */
export declare const GRAPH_EPS = 1e-12;
/** I3 图与传播口径（全部有模块级默认常数，可经工具配置覆盖）。 */
export interface GraphOptions {
    /** log 压缩系数 λ。 */
    lambda?: number;
    /** 每个节点的出流总预算 m_out。 */
    outBudget?: number;
    /** 枢纽校正指数 η。 */
    hubEta?: number;
    /** 传播跳数上限（0 = 关掉传播：所有图奖励恒为 0）。 */
    maxHops?: number;
    /** 传播状态数上限（0 = 关掉传播）。 */
    maxStates?: number;
    /** 每节点最强出边条数。 */
    maxFieldNeighbors?: number;
    /** 每跳衰减 γ。 */
    decay?: number;
    /** 立即回流抑制 ρ。 */
    backflowRho?: number;
    /** 图奖励硬上限。 */
    bonusCap?: number;
    /** 「标签激活 → 记忆奖励」折算系数 K。 */
    bonusScale?: number;
    /** 标签激活下限。 */
    activationMin?: number;
}
/** 已解析（always 有值）的图口径。 */
export interface ResolvedGraphOptions {
    lambda: number;
    outBudget: number;
    hubEta: number;
    maxHops: number;
    maxStates: number;
    maxFieldNeighbors: number;
    decay: number;
    backflowRho: number;
    bonusCap: number;
    bonusScale: number;
    activationMin: number;
}
/** 有界解析：非法值一律回落模块级默认；maxHops/maxStates 允许取 0（= 关掉传播）。 */
export declare function resolveGraphOptions(opts?: GraphOptions): ResolvedGraphOptions;
/** 有向边 (from -> to) 的原始计数与 log 压缩权（方向**分开记**，不合成一个数）。 */
export interface DirectedEdgeWeight {
    from: string;
    to: string;
    /** 原始计数 W。 */
    w: number;
    /** log(1 + λW) —— 压缩后的权。 */
    compressed: number;
}
/**
 * 某个标签的出边（**双向对称视图**，用于扩散与预算）：
 * 两个方向各自压缩后再相加，且 **两个方向的原始计数分别保留**（forward/backward），
 * 读者可以分别取到方向信息，也可以只看对称聚合。
 */
export interface OutEdge extends DirectedEdgeWeight {
    /** outRaw = 该标签在记录里紧跟着 to 出现的次数。 */
    outRaw: number;
    /** inRaw = to 在记录里紧跟着该标签出现的次数。 */
    inRaw: number;
    /** 最终权重（两次归一化 + 枢纽校正之后）；同一 from 的出边权重和 <= m_out。 */
    weight: number;
}
/** 图里一个标签节点。 */
export interface GraphTagNode {
    /** 归一化后的标签串（trim + 小写，与 store 落盘口径一致）。 */
    tag: string;
    /** 出度（不同后继标签个数）。 */
    outDeg: number;
    /** 入度（不同前驱标签个数）。 */
    inDeg: number;
    /** 全库出现频次（出现该标签的记录数）。 */
    inCount: number;
    /** 出流总权重（= Σ 出边最终 weight，恒 <= m_out）。 */
    outFlow: number;
    /** 枢纽校正因子 α ∈ (0,1]；非枢纽恰好为 1；被压过（α<1）即计入 hubSuppressed。 */
    hubFactor: number;
    /** 该标签的**对称**出边（已归一化 + 已枢纽校正），按 weight 降序 → 码元升序。 */
    outEdges: OutEdge[];
    /** 该标签的**前驱**标签（对称口径），按压缩权降序 → 码元升序。 */
    inNeighbors: string[];
}
/** 标签共现索引（当前记忆库的纯函数结果）。 */
export interface TagGraphIndex {
    nodes: GraphTagNode[];
    /** 标签 → 节点下标。 */
    index: Map<string, number>;
    /** 有向边数（**两个方向分别计数**）。 */
    directedEdges: number;
    /** 两个方向原始计数之和 > 0 的标签对个数（对称视图的边数）。 */
    symmetricEdges: number;
    /** 入度中位数（枢纽判定的基准）。 */
    medianIn: number;
    /** 被枢纽校正压过的标签（α < 1），按码元升序；对应「全部去重」口径。 */
    hubSuppressed: string[];
    /** 全库出现频次严格大于中位数、因而被判定为枢纽的标签数。 */
    hubSuppressedCount: number;
    /** 所有出边 weight 之和（<= 节点数 × m_out）。 */
    totalOutWeight: number;
}
/**
 * 从记录集构建**有序双向**标签共现图（纯函数；每次现建，无模块级状态）。
 *
 * 边定义：对每条记录的规范化标签序列 t0..t_{k-1}，为每个 i 记一条有向边
 * `(t_i -> t_{i+1})`（相邻对；自环跳过）。同一对标签的两个方向**分别计数**：
 * `(A -> B)` 记 forward、`(B -> A)` 记 backward，绝不合成一个数。
 *
 * 权重（禁止线性累加）：
 *   1. 对称压缩权 `c(u,v) = log(1 + λ·(forward + backward))`；
 *   2. 每个节点的出边按 c 归一化到总预算 `m_out`：`p(u->v) = m_out · c / Σc`；
 *      （按 c 归一化、再按 c 分配 ⇒ 低权出边被压到接近 0，但**不会整条消失**；
 *        若出现「Σc 里有零权项」的退化输入，则对正权项按权重分配、零权项给 0。）
 *   3. 枢纽校正：**枢纽判定 = 入度 >= 中位数 + 1**（「显著高于中位数」的可操作定义；
 *      median = 0 时**没有任何枢纽**，避免空库/单标签库上误压），
 *      `α(u) = clip((inDeg(u) / max(1, median))^(-η))`（非枢纽恒为 1），
 *      `weight(u->v) = p(u->v) · α(u)`（先预算、后枢纽 ⇒ 预算恒成立，枢纽只在其内再分配）。
 *      【为什么不用「入度 > 中位数」】：标签少的小库常常 median = 1，那时任何入度 2 的普通
 *      标签都会被误判成枢纽并被压到 0.7 倍 —— 实测这会连带压低「普通节点」的传播
 *      （calib4 夹具里 alpha 被误压，万能标签的激活反而更小）。加 1 的门槛把「比多数标签
 *      都更常见」和「稍微常见一点」分开，只有真正的万能标签才落入抑制区间。
 *
 * memo 是**调用级**（构建过程中）的临时缓存，直接建在节点对象上；它不跨调用存活，
 * 也不依赖任何模块级变量 —— 与 I2 禁止的「请求级状态提模块级」不是一回事。
 */
export declare function tagGraphIndex(records: ReadonlyArray<{
    tags?: unknown;
} | null | undefined>, opts?: GraphOptions): TagGraphIndex;
/** 便捷包装：只要「节点数 / 有向边数」（召回层报告用）。 */
export declare function tagGraphSize(records: ReadonlyArray<{
    tags?: unknown;
} | null | undefined>, opts?: GraphOptions): {
    nodes: number;
    edges: number;
};
/** 一条候选记忆的图奖励（graph 字段）。 */
export interface MemoryGraphReward {
    id: string;
    /** 已应用硬上限的图奖励（[0, graphBonusCap]，4 位小数打印）。 */
    bonus: number;
    /** 最强证据标签（激活 × 权最大者；码元升序决胜），无证据为 ''。 */
    viaTag: string;
    /** 该标签的激活值。 */
    activation: number;
}
/** 传播结果（全部是本次调用的局部量）。 */
export interface TagPropagation {
    /** 所有到达状态的标签 → 激活值（降序）。 */
    nodes: Array<{
        tag: string;
        weight: number;
    }>;
    /** 通过 activationMin 的标签（降序）。 */
    propagated: Array<{
        tag: string;
        weight: number;
    }>;
    /** 新达到标签的跳数（1 = 直接邻居）。 */
    hops: number;
    /** 实际展开的状态数（<= maxStates）。 */
    statesUsed: number;
    /** 是否撞上状态数上限。 */
    statesTruncated: boolean;
    /** 种子标签（本次直接命中的标签，码元升序）。 */
    seeds: string[];
}
/**
 * 有界脉冲传播（浪潮）：从本次直接命中的标签出发沿出边扩散。
 *
 * 规则（全部显式有上限，见 GraphOptions）：
 *  - 种子激活 = 1；
 *  - 每跳衰减 γ，立即回流抑制 ρ（不许沿刚来的那条边原路返回）；
 *  - 每个节点最多取 maxFieldNeighbors 条最强出边（权重降序 → 目标标签码元升序）；
 *  - maxHops 跳内结束；状态总数 <= maxStates；
 *  - 一个标签被多次到达时取**最大**激活（重新入队），保证结果与到达顺序无关；
 *  - 「状态」= 展开一个节点一次，总数 <= maxStates（这条在 for 条件里硬保证）。
 *
 * 确定性：邻居排序用确定的多级键；优先队列的比较器是全序；同输入必同输出。
 */
export declare function propagateTags(seeds: Iterable<string>, graph: TagGraphIndex, opts?: GraphOptions): TagPropagation;
/**
 * 「标签激活 → 每条记忆的图奖励」折算（**本机制的公式，必须写清**）：
 *
 *   对记录 r：graph(r) = min(bonusCap, K × max_{t ∈ tags(r), t 有激活} activation(t))
 *
 *   - activation(t) ∈ (0,1] 是传播值（activationMin 以下的标签不参与，等价于「无证据」）；
 *   - 取 **max** 不取和：标签个数多 / 万能标签不得白拿加成（求和会让标签多的记录恒占便宜）；
 *   - activation <= 1 ⇒ graphBonusRaw <= 1 ⇒ graph(r) <= bonusCap 恒成立；
 *   - 无任何图证据 ⇒ **恰好 0**（只奖不罚，绝不因此整批否决或返回空）。
 *
 * 返回数组与 candidates 一一对应（同分时按标签码元升序决定 viaTag，保证确定性）。
 */
export declare function memoryGraphRewards(candidates: ReadonlyArray<{
    id: string;
    tags?: readonly string[];
}>, propagated: ReadonlyArray<{
    tag: string;
    weight: number;
}>, graph: TagGraphIndex, opts?: GraphOptions): MemoryGraphReward[];
