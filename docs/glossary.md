# 术语表（glossary）

本文件是本仓**对外术语的唯一定义处**：读输出、写记忆、或改代码时遇到 `rel` / `qTok` / `L1` 这类符号，先在这里查。
其它文档**首现**这些术语时应回链本文件。**内部实现批次代号（`I1…`、`修正N`、`iN`）不是对外语义**，只用于追溯，映射见 [decisions/increment-codes.md](decisions/increment-codes.md)。

## 1. 分层与存储

| 术语 | 含义 |
| --- | --- |
| **L1 索引** | `memory_recall` 返回的**每条一行、10 列**的摘要；**不含正文**。 |
| **L2 正文** | 记录的 `body` 字段，只有 `memory_expand` 才按 id 取回。 |
| **记忆库（store）** | 唯一活动数据文件 `$DSH_HOME/agent-memory/memory.ndjson`；NDJSON = 每行一个 JSON 对象，纯文本、可 grep、可 `cp` 备份。 |

> 「库」「记忆库」「store」是同一件事；「存储」只作动词（落盘）用，不用来指代该文件。

## 2. `memory_recall` 的 10 列

| 列 | 含义 |
| --- | --- |
| `id` | 记录 id（`memory_expand` 用它取正文）。 |
| `kind` | `fact` / `lesson` / `preference` / `pointer`。 |
| `title` | 单行标题。 |
| `tags` | 有序标签。 |
| `graph` | 标签图传播给的**辅助**奖励，有硬上限 `graphBonusCap`；不参与 `match`。 |
| `via` | 该行来源：`direct`（词法命中）或 `tag:<标签>`（仅由标签图到达）。 |
| `rel` | **BM25 原始相关度**（绝对标度，不随批次归一化）；`match` 就是拿它与阈值比出来的。 |
| `cov` | 标签覆盖率（**仅诊断**，不门控任何结果）。 |
| `match` | 绝对判定 `none` / `weak` / `strong`。 |
| `score` | `disp(final)` 展示分，仅用于排序展示。 |

## 3. 打分与标度

- **BM25**：按字段统计的词法相关度算法；本库用它算 `rel`。
- **绝对标度**：`disp` 的区间由固定常数 `SCALE_A` / `SCALE_B` 定义，**不依赖同批候选**（禁批内归一化）。
- **`disp(final)`**：`disp` 是把原始分 `final` 线性映射到 0..1 的**展示**函数；`final=(rel+graph)×多样性因子`（因子仅在候选数 > 5 时施加）。多样性启用时 `score` 无法仅由打印的 `rel`/`graph` 精确复算。
- **多样性 / MMR**：MMR（最大边际相关）式贪心去重；因子 `1 − β·maxSim`，`β` 默认 0.3，`maxSim` 是该行与已选行的最大标签 Jaccard 相似度。
- **内容量闸门**：短查询的降级闸门。`qTok`（内容词元数）= 去重查询词元里在库内出现过的个数（结构化字段 `contentTokens`）；`qTok < contentTokenMin` **且** `rel < gateMargin×STRONG_THRESHOLD` 时把 `strong` 封顶为 `weak`（单个高专有词元例外放行）。阈值 `contentTokenMin`（`CONTENT_TOKEN_MIN`，默认 2）与例外倍数 `gateMargin`（默认 2.0）都可配置。
- **idf**：逆文档频率；用于图与分诊的词法空间，不用于内容量闸门（实测 idf 会误伤真话题）。
- **`STRONG_THRESHOLD` / `WEAK_THRESHOLD`**：判定 `strong`/`weak` 的两个绝对阈值（不是「要不要注入」的策略开关）。

## 4. 分诊与图

- **残差金字塔分诊**：以候选标签向量为基、在标签 idf 空间做 Gram-Schmidt 残差金字塔，得到 `novelty`（= `0.7×残差能量比 + 0.3×方向一致性`），据此决定是否扩大**内部**检索预算。
- **`kBase` → `kUsed`**：扩检索只放大内部候选池预算（`kBase` 未扩、`kUsed` 扩后；旧文/旧注释里的 `kExpanded` 即 `kUsed`）。**绝不增加返回行数**。
- **图奖励**：有序双向标签共现图 + 有界脉冲传播给出的辅助奖励；`reachable` = 仅靠图到达的记录数（衡量图是否起作用看它，不看 `graph` 大小）。

## 5. 淘汰（`memory_prune`）

- **`hits`**：记录被 `memory_expand` 取回的次数。
- **`decay(ts)`**：按写入时间的衰减函数（半衰期默认 180 天）。**旧文档/旧注释里的 `recency` 就是它**，规范写法用 `decay(ts)`。
- **`pruneScore`**：淘汰排序分 `= decay(ts) × (1 + hits)`；**与召回 10 列里的 `score` 无关**。`memory_prune` 按它从低到高淘汰，先满足条数上限再满足字节上限。

## 6. 作用域

- **`scope`**：调用方声明的字符串，约定项目专属写 `project:<名>`；**省略即 `global`**（跨项目通用）。`memory_recall` 传了 `scope` 才过滤，只返回该值 **或** `global` 的记录（`global` 永远包含）；不传 = 不过滤。插件**不**用会话 cwd 自动推断 scope。

## 7. 失败策略与开关

- **fail-closed（写入）**：`memory_remember` 任一字段不合法即**整条拒收、不写入**，并给出修复指引。
- **fail-open（注入）**：注入侧任何读库/解析/注册异常都降级为空串，**绝不抛**（一次抛异常会毁掉每一步）。
- **`injection.enabled`**：注入总开关；`false` 时不注册、不输出任何字符。

## 8. 内部代号

`I1`…`I7`、`I4a.*`、`修正N`、`iN` 都是**实现批次/修订/取证编号**，仅供追溯，不构成对外语义。完整映射见 [decisions/increment-codes.md](decisions/increment-codes.md)。
