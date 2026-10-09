# 召回与写入契约

本文件写给**读输出、写记忆、或依赖这些字段做判断的人**：4 个工具的约定、`memory_recall` 的 10 列、打分常数、写入协议与 fail-closed 闸门。

最短上手见 [../README.md](../README.md)；工程主张见 [design.md](design.md)。

## 1. 四个工具

| 工具 | 作用 | 关键约定 |
| --- | --- | --- |
| `memory_remember` | 写入一条长期记忆并落盘 | 写入协议**失败关闭**：任一字段不满足即拒收且**不落盘**，并给出可直接照做的修复指引。返回新 id、当前总数与占用字节 |
| `memory_recall` | 按查询召回 **L1 索引**（每条一行，10 列） | **绝不返回 body**；要正文请拿 id 调 `memory_expand`。`limit` 默认 5、最大 50，且是**硬显示上限**。`match` 由 `rel` + 两个绝对阈值 + **内容量闸门**共同判定（§5） |
| `memory_expand` | 按 id 取回 **L2 正文** | 找不到的 id 如实列在 `missing` 里；取回成功会给这些记录累加 `hits`（影响将来的淘汰优先级） |
| `memory_prune` | 按规则淘汰 / 合并记忆 | 同 kind 同标题者合并（保留最新、累加 hits、标签取有序并集），再按 `score=recency*(1+hits)` 从低到高淘汰至上限内。`dryRun` **默认 true**（只报告将要删什么，不动磁盘），显式传 `false` 才真删 |

**分层披露是设计意图，不是缺陷**：`recall` 只回 L1 索引（10 列，**绝不回 body**），想看全文就必须显式拿 id 调 `expand` —— 也就是**付一次额外的工具调用**来省掉把正文全部注入上下文的 token。

## 2. 写入协议（`memory_remember`）的 5 条约束

- `kind` 必须是 `fact` / `lesson` / `preference` / `pointer` 之一；
- `title` 单行，去首尾空白后 **8..120 字符**，不得含换行（`\n` / `\r` / U+2028 / U+2029）；
- `body` 非空（它是 L2，只有 `memory_expand` 才取回）；
- `tags` 有序不重复 **1..12** 个、每个 **1..32** 字符（全库稳定复用，只做 trim + 小写化）；
- `source` 非空，形如 `session:xxx` / `file:path` / `url:https://...`。

校验顺序是 `kind → title → body → tags → source`（先报最靠前的错，指引不互相干扰）。

## 3. 两条 fail-closed 闸门

二者都**不落盘、也不触发淘汰**：

| code | 触发条件 |
| --- | --- |
| `record-too-large` | 单条记录序列化后超过单条上限（默认 `maxBytes` 的 10%）。淘汰是按字节数做的，放一条超大记录进来会把**整库挤空** |
| `store-changed-externally` | 库在上次加载之后被其他进程改过（只有进程内串行队列，没有跨进程写锁）。会打印加载时与落盘前两侧的 `size` / `mtimeMs` 供比对 |

## 4. `memory_recall` 的 10 列

每条 L1 行恰好 10 列，顺序如下（分隔符 ` | `，两侧各一个空格）：

```
id | kind | title | tags | graph | via | rel | cov | match | score
```

| 列 | 含义 |
| --- | --- |
| `id` | 记录 id（拿它调 `memory_expand`） |
| `kind` | `fact` / `lesson` / `preference` / `pointer` |
| `title` | 标题 |
| `tags` | 逗号连接的有序标签 |
| `graph` | I3 标签共现图传播给的**辅助**奖励（已应用硬上限 `GRAPH_BONUS_CAP`；无图证据恰好为 0） |
| `via` | 来源标记：`direct`（词法直接命中）或 `tag:<标签>`（由标签图传播到达） |
| `rel` | **BM25 原始相关度**（绝对标度，不随批次归一化）—— **`match` 的判定依据之一**（另一个是内容量闸门，见 §5） |
| `cov` | 标签覆盖率（**仅诊断**，不门控、不整批否决） |
| `match` | 绝对判定 `none` / `weak` / `strong`（`rel` + 两个阈值 + **内容量闸门**共同决定，见 §5） |
| `score` | `disp(final)` 映射到 0..1 的**展示分**（仅用于排序展示，与 `rel` 不同标度） |

**列序不可随手挪**（三步试错结论）：`score` 恒在末位；`rel` / `cov` / `match` 的行尾相对下标（-4 / -3 / -2）不变；前三列 `id` / `kind` / `title` / `tags` 不动。I3 的两列 `graph | via` 因此**只能**插在 `tags` 与 `rel` 之间。

## 5. 可复算铁律

- **`match` 恒可复算**：用打印出的 `rel`、表头给出的两个阈值、以及表头回显的**内容量闸门输入**（`qTok` 与阈值）一起算即可：

  ```
  match = qTok = 0            ? none
        : qTok < contentTokenMin ? (rel >= weak ? weak : none)   ← strong 被封顶成 weak
        : rel >= strong ? strong : rel >= weak ? weak : none
  ```

  表头**按分支**逐字打印闸门回显（绝不写无条件样板）：封顶支 `内容量qTok=<N><<min>⇒strong封顶weak`、不封顶支 `内容量qTok=<N>≥<min>⇒闸门未生效`（不封顶支的措辞刻意不含「封顶」二字，好让测试直接断言该支无此字样）。结构化字段是 `contentTokens` / `contentTokenMin`，所以复算不需要翻源码。
- **内容量闸门只封顶 `strong`，绝不整批否决**：`qTok`（**内容词元数** = 去重查询词元里在库内任一分词字段出现过的个数）不足 `contentTokenMin`（默认 2）时，`strong` 降为 `weak`；`weak` / `none` 两档逐字不变，**行照样返回**。`qTok = 0` 时 `rel` 必然为 0，`none` 是本来就成立的结论。
  为什么需要它：`rel` 的分母是「查询自身的理论 BM25 上界」，**单内容词元**的查询几乎能独自顶到那个上界 ⇒ 比值虚高。真实 204 条库实测：完全无关的 `ok` / `做` / `b` 分别拿到 rel `0.1867` / `0.1829` / `0.1707`，修前都判 `strong`；而真话题 `虚拟屏`（3 个字符但 5 个内容词元）rel `0.5549` 不受影响。判据取「内容词元数」而不是字符数：字符数闸门会把 `虚拟屏` 一起压掉。
- **`score` 不保证可精确复算**：`score = disp(final)`，其中 `final = (rel + graph) × 多样性因子`，多样性因子 `= 1 − β·maxSim`（β 默认 0.3，`maxSim` 是该行与**已选行**的最大标签 Jaccard 相似度），且该因子**只在候选数 > 5 时施加**（候选 <= 5 时恒为 1）。由于 **β 与 maxSim 都不是打印列**，多样性被启用时 `score` 无法仅由打印的 `rel` / `graph` 精确复算。这是如实声明的限制，不是实现疏漏。
- **`match` 与 `score` 是两种标度**，别拿一个去验另一个。
- **无词法证据时 `rel = 0`**（不是「score 是 0」）。仅由标签图到达的记录会 `graph > 0`、`via = tag:<标签>`、`match = none`；它的 `score` 取决于标度常数，默认口径下因 `SCALE_A (0.0199) > GRAPH_BONUS_CAP (0.018)` 而恰好为 `0.0000`，但这不是恒等式 —— 改了标度常数就会变。图奖励**只奖不罚**，绝不整批否决。

## 6. 打分常数（5 个）+ 内容量闸门阈值

`disp` 的绝对区间映射：`disp = clip((raw − SCALE_A) / (SCALE_B − SCALE_A), 0, 1)`。

| 常数 | 落地值 | 口径 |
| --- | --- | --- |
| `SCALE_A` | 0.0199 | p50(负样本)，噪声地板 |
| `SCALE_B` | 0.3666 | p95(正样本)，真命中高分位 |
| `WEAK_THRESHOLD` | 0.0382 | p95(负样本)，噪声上界 |
| `STRONG_THRESHOLD` | 0.1507 | p10(正样本)，正样本低分位 |
| `GRAPH_BONUS_CAP` | 0.018 | 图奖励硬上限（保留度量的量级，**待真实语料标定**） |
| `CONTENT_TOKEN_MIN` | 2 | 内容量闸门阈值（`qTok` 下限）；可用配置 `score.contentTokenMin` 覆盖，设 `1` 等价关掉闸门。**它不是打分常数**：`rel` / 排序 / 召回集合一概不读它，只决定 `match` 能不能称 `strong` |

前四个可用配置 `score.{scaleA,scaleB,weakThreshold,strongThreshold}` 覆盖；标定出处与「语料变了必须重标」见 [limitations.md](limitations.md)。

`CONTENT_TOKEN_MIN = 2` 的标定（2026-10-09，真实 204 条库；证据 `redproof/i9-short-query-gate.*`）：噪声侧 `ok`/`做`/`b` 的 `qTok` 全为 1；话题侧 `虚拟屏` 为 5、`虚拟屏不能用吗？` 为 11，该库真话题查询 `qTok >= 3`。取**能判红的最小值 2**：再大就会开始封顶 `qTok = 3` 的真短话题（`快照`/`门禁`/`注入`，rel≈0.5 判 strong）。代价如实声明：单内容词元查询（如英文单标签 `adb`/`ci`）从此最多 `weak`，本库 795 个正样本里 83 个（10.4%）落在这一档 —— 方向是保守的。**不用 idf 质量当闸门**（实测反例）：本库噪声 `好的` 的 idf 质量 6.49 **高于**真话题 `快照` 3.90 / `注入` 2.93，且 `虚拟屏` 的逐词元 idf（约 2.0~2.35）与 `好的` 的均值 2.16 不可区分 ⇒ idf 阈值会先误伤真话题再压噪声。

## 7. `limit` 是硬显示上限

- 返回行数恒为 `min(limit, 可用候选数)`。
- 内部扩检索（I2 分诊的 `kBase -> kUsed`）**只放大内部预算**（给金字塔取更大的基、给多样性更大的候选池），**绝不增加返回行数**。
- 把「内部候选池预算」误读成「显示上限」是明确的误用。

## 8. 分诊与低置信

- **I2 分诊**：以候选标签向量为基、在标签 idf 词法空间做 Gram-Schmidt 残差金字塔，得到 novelty = `0.7×残差能量比 + 0.3×方向一致性`，据此决定是否扩检索（`novelty >= noveltyThreshold`，默认 0.5）。
- **空查询不分诊**：查询无词元能量（`‖q‖²≈0`）时 `novelty=0`、`expanded=false`、`kUsed=kBase`，`explainedRatio` / `residualRatio` 如实回显 `0/0`（未定义）。
- **低置信只报告**：`activationThreshold`（默认 0.05）下 `cov_max` 偏低只置 `lowConfidence`，**绝不返回空、绝不整批否决**。
- **`cov` 是诊断列，不是质量保证**：高 `cov` 不等于高相关，它不门控任何结果。

## 9. 表头

表头是**单行**的，总长上界为 `HEADER_MAX_CHARS = 448` 字符。这个上界由**构造**保证，与查询串多长无关：

- **固定部分**（与查询无关）：列序 / `rel` 语义与 `match` 依据 / 两个阈值 / **内容量闸门输入与规则，按分支回显**（封顶支 `内容量qTok=<N><<min>⇒strong封顶weak`，不封顶支 `内容量qTok=<N>≥<min>⇒闸门未生效`）/ `disp(final)` 公式与两个标度常数 / `limit` 是硬显示上限 / I2 结论 / 低置信 / I3 结论。其中标度常数经 `formatHeaderConstant()` **定宽回显**（宽度上限 `HEADER_CONST_MAX_CHARS = 9`）：放得下就精确回显，放不下就用 `≈` 标注为**近似值**并降精度（精确值仍逐字在结构化字段 `scaleA`/`scaleB`/`weakThreshold`/`strongThreshold` 上）。
- **有界的 `query=` 回显**：回显预算 = `HEADER_MAX_CHARS` 减去固定部分**现算**；先按**码点**截断原始查询串，**再**做 JSON 转义（顺序不能反，否则会切断 `\"`、`\\`、`\n`、`\u00XX` 这类转义序列），放不下就继续缩短并如实标注 `…(截断)`。转义后一定单行。**完整查询串永远原样在结构化字段 `query` 上**，回显只是给人看的短标识。
- **回显位宽代价（本次已产生，后人注意）**：内容量闸门那次回显把「默认标度 + 3 条库」的固定部分从 384 顶到 **404**，最坏观测（`Number.MAX_VALUE` 常数）**414**，实测表头最坏 **447**（上界 448，只剩 1 个字符余量）。**按分支回显不改变这条最坏值**：两条最坏情况用例都落在封顶支（边界字符查询 `qTok=0`、极值常数夹具 `query=alpha` 的 `qTok=1`），而不封顶支比封顶支**短 7 个字符**（17 vs 24）。为腾字符，同一次改动压掉了 `候选N;`（候选数仍在结构化字段 `matched` 上）并收紧了 I3 段的括号与分隔符（判据文字一字未改）。**往表头再加文本前，必须先跑 `test/header.test.mjs` 的两条最坏情况用例。**

> 历史坑：旧文档/旧注释写的是「单行、<= 400 字符」。那个数字只在 3 个短查询夹具（388~399）上量过，从未覆盖最坏情况 —— 200 字符含边界字符的查询实测表头 742 字符、360 字符的查询 932 字符；换一组回显更宽的标度常数（22 位小数）也能把固定部分顶到 413。现在两条路径分别由上面的定宽回显与有界回显堵死，并由 `test/header.test.mjs` 的最坏情况用例（长边界查询 + `Number.MAX_VALUE` 常数 + 三位数库规模统计）钉住。**真正的上界一直是 `HEADER_MAX_CHARS = 448`**；`test/header.test.mjs` 里那个更紧的「常配短查询 <= 428」只是收紧位（闸门回显前是 400），不是总量上界。

非结论性诊断（`basisSize`、`layers`、`logicalDepth`、`explainedRatio`+`residualRatio` 守恒、传播上限与 `gamma`/`rho`、种子与到达计数、多样性 β）不回显在表头，但**一个都没删**，仍逐字在结构化返回字段里。

## 10. 工具描述瘦身（修正 2）：细则都在这里

`memory_recall` 的工具描述只留模型**每次调用都要用**的五件事（10 列清单 / `rel`-`match`-`score` 语义 / `limit` 是硬显示上限 / 绝不返回 body / 指向本文件），已从 **1182 字符压到 <= 300 字符**。

**描述里删掉的细则一条都没丢，全部逐字在本节** —— `test/description.test.mjs` 对本节逐条钉住。理由：描述既然把口径「指向本文件」，本文件就必须真的载着这些情报，否则那个指针本身就是一句谎。

- `score=disp(final)` 是映射到 0..1 的展示分，按它降序、**不随批次归一化**。
- `final=(rel+graph)×多样性因子`；因子 `= 1-β×maxSim`（`β 默认 0.3`，`maxSim` 是该行与已选行的最大标签 Jaccard 相似度）。
- 多样性因子**仅当候选数 > 5 时施加**；**是否施加见结构化字段 `diversityApplied`**。
- 因此多样性被启用时，`score` **无法仅由打印出的 rel/graph 精确复算**（β 与 maxSim 都不在打印列里）；而 `match` **始终可由打印的 rel + 表头阈值 + 表头回显的内容量闸门输入（`contentTokens`/`contentTokenMin`）复算**。
- **内容量闸门（本次新增）**：`match = 无内容量(qTok=0) ? none : (qTok < contentTokenMin ? strong 封顶 weak : 阈值判定)`；`qTok` = 去重查询词元里在库内任一分词字段出现过的个数，默认阈值 `CONTENT_TOKEN_MIN = 2`，可用配置 `score.contentTokenMin` 覆盖（设 1 即关闸门）。它**只封顶 strong**：短查询照样返回行、照样能判 weak，**绝不整批否决**；`rel` 的语义与四个已标定常数一个字都不动。
- **表头回显（按分支给，绝不写无条件样板）**：封顶支 `内容量qTok=<N><<min>⇒strong封顶weak`、不封顶支 `内容量qTok=<N>≥<min>⇒闸门未生效`。（判红点：删掉这段、只回显一半，或把不封顶支改回无条件样板 ⇒ `test/header.test.mjs` 与 `test/scoring.test.mjs` 变红；真机缺陷出处 `redproof/i10-*`。）
- `graph` 是标签图传播给的**辅助**奖励（有硬上限 `graphBonusCap`，**不会压过词法相关度**）。
- `via` 是该行来源：`direct`（词法直接命中）或 `tag:<标签>`（由该标签的图传播到达）。
- `cov` 是标签覆盖率（**仅诊断**，不门控、不整批否决）。
- **无词法证据时 `rel=0`**；仅由标签图到达的记录 `graph>0`、`via=tag:<标签>`，其 `score` 取决于标度常数（可能为 0 也可能 >0），`match=none`（**只奖不罚，不整批否决**）。
- **`limit` 是硬显示上限**：扩检索（`kBase -> kUsed`）只放大**内部**召回预算，**不增加返回行数**。
- 查询无词元能量（`‖q‖²≈0`）时**不做分诊**：`novelty=0`、`expanded=false`、`kUsed=kBase`，`explainedRatio`/`residualRatio` 如实回显 `0/0`（未定义）。
- 低置信只是**如实报告**：`lowConfidence` 置位时**绝不返回空、绝不整批否决**。

**为什么不用工具 schema 的延迟加载**（对方提到的 `deferLoading`）：本机引擎**支持**这个字段（`defineTool({ deferLoading: true })`，见 `@deepseek-ai/dsh-tools/lib/index.js:864` 与类型 `lib/types/schema.d.ts:194-195`），但它属于**会话工具更新**机制而不是「同一请求内按需载入 schema」：路由必须声明 `toolUpdate`（`dsh-llm/lib/types/types.d.ts:365-374`）才有语义，未声明的路由只会把该字段剥掉（`dsh-llm/lib/index.js:787-793`）、零收益；而在 `addition-only` 模式下，**显式延迟加载的初始工具在首个保留的 `tool-addition` 块出现前一直保持延迟状态，声明延迟加载并不会激活它**（`dsh-llm/README.zh.md:162`），`tool-addition` 又只由 agent loop 在活跃工具集**会话中变化**时产生（`dsh-agent-loop/lib/index.js:1230-1235`）。本插件的 4 个工具在插件 apply 时就进入初始 `request/header`，此后不会有 `tool-addition` 块点名它们 ⇒ 采用 `deferLoading` 的风险是**模型从此看不到 memory_recall 本身**。结论：**不采用**，改为瘦身描述。
