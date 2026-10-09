# dsh-agent-memory

一句话定位：**给 DSH agent 用的跨会话长期记忆层** —— 四个窄工具（remember / recall /
expand / prune）＋ 两条注入贡献（尾部一行记忆索引 + 稳定段一条条件规则），把「上一次会话
学到的东西」变成「这一次会话按需可查的经验」。**自动进上下文的只有那行索引与那条规则，
具体记忆内容仍要模型显式调用 `memory_recall`**（见下）。

它解决什么：

- **跨会话失忆**。DSH 的上下文随会话结束而消失；本插件把值得留下的结论（事实、教训、
  偏好、指路）落成一份**人类可读的 NDJSON 文件**，下次会话开局就能召回。
- **默认注入两段，都是「索引」而不是「内容」**。引擎装配系统提示词时，插件做两件互补的事：
  - **易变尾部块**（`context`，`name=agent-memory`，order 200，默认上限 240 字符；本机 200 条
    真库上实测 **76 字符**）：`记忆 N 条（跨会话经验教训）｜<条件规则>｜标签锚点：A / B / C`
    —— **条数 + 这是什么 + 什么时候该用（条件规则）+ 锚点**，**库变了才变**；
  - **稳定段**（`section`，`name=agent-memory-habit`，order 3200，属于**稳定前缀**，每步都在）：
    同一条件规则的独立一句话
    `遇到排查·为什么·复现·"以前是否踩过"这类问题，先用 memory_recall 查记忆库（跨会话经验教训）。`
  两段**共用同一个 `injection.enabled` 开关**：关掉就两条都不注册，没有「只关一条」的半开状态。
  索引行**与库内容实时联动是刻意避免的**（见「硬不变量」第 4 条）。
- **没有「按话题自动召回」**。自动进上下文的**只有**上面那行索引和那条规则 —— **具体记忆内容
  不会自动注入**，要正文/要内容必须由模型**显式调用 `memory_recall`**（再按 id 调 `memory_expand`）。
  那条规则是**「提示」而不是「保证」**：它提高「被想起来」的概率，**不强制**模型一定调用。
- **分层披露省 token**。`recall` 只回 L1 索引（10 列，**绝不回 body**），要正文必须显式
  拿 id 调 `expand`。想看全文就得付一次额外的工具调用——这是设计意图，不是缺陷。
- **真库在用**。本机 `$DSH_HOME` 下**有 200 条真实记忆**在跑（上限 2000 条），
  当前标签锚点是 `判据 / 快照 / 测试`。真实库**不在本仓里**（见「环境事实」）。
  （**上面的条数是快照值**：2026-10-09 实测；它会随使用增长，现值请以 `memory_recall` 的
  `total` 字段或注入行的「记忆 N 条」为准，别把本节的数字当常数。）

---

## 目录

- [1. 四个工具](#1-四个工具)
- [2. recall 的 10 列输出与可复算铁律](#2-recall-的-10-列输出与可复算铁律)
- [3. 分阶段实现](#3-分阶段实现)
- [4. 硬不变量（工程主张）](#4-硬不变量工程主张)
- [5. 安装](#5-安装)
- [6. 测试与红证](#6-测试与红证)
- [7. 诚实的局限](#7-诚实的局限)
- [8. 上游与署名](#8-上游与署名)
- [9. 许可证](#9-许可证)
- [10. 环境事实（本机特有的坑）](#10-环境事实本机特有的坑)
- [11. 仓库内容](#11-仓库内容)

---

## 1. 四个工具

| 工具 | 作用 | 关键约定 |
| --- | --- | --- |
| `memory_remember` | 写入一条长期记忆并落盘 | 写入协议**失败关闭**：任一字段不满足即拒收且**不落盘**，并给出可直接照做的修复指引。返回新 id、当前总数与占用字节 |
| `memory_recall` | 按查询召回 **L1 索引**（每条一行，10 列） | **绝不返回 body**；要正文请拿 id 调 `memory_expand`。`limit` 默认 5、最大 50，且是**硬显示上限** |
| `memory_expand` | 按 id 取回 **L2 正文** | 找不到的 id 如实列在 `missing` 里；取回成功会给这些记录累加 `hits`（影响将来的淘汰优先级） |
| `memory_prune` | 按规则淘汰 / 合并记忆 | 同 kind 同标题者合并（保留最新、累加 hits、标签取有序并集），再按 `score=recency*(1+hits)` 从低到高淘汰至上限内。`dryRun` **默认 true**（只报告将要删什么，不动磁盘），显式传 `false` 才真删 |

写入协议（`memory_remember`）的逐条约束：

- `kind` 必须是 `fact` / `lesson` / `preference` / `pointer` 之一；
- `title` 单行，去首尾空白后 **8..120 字符**，不得含换行；
- `body` 非空（它是 L2，只有 `memory_expand` 才取回）；
- `tags` 有序不重复 **1..12** 个、每个 **1..32** 字符（全库稳定复用，只做 trim + 小写化）；
- `source` 非空，形如 `session:xxx` / `file:path` / `url:https://...`。

另有两条失败关闭闸门，二者都**不落盘、也不触发淘汰**：
单条记录过大（`record-too-large`）、库在上次加载之后被其他进程改过
（`store-changed-externally`，会打印加载时与落盘前两侧的 `size` / `mtimeMs` 供比对）。

---

## 2. recall 的 10 列输出与可复算铁律

`memory_recall` 每条 L1 行恰好 10 列，顺序如下（` | ` 分隔，两侧各一个空格）：

```
id | kind | title | tags | graph | via | rel | cov | match | score
```

列序是**三步试错**出来的，别随手挪：`score` 恒在末位；`rel` / `cov` / `match` 的行尾
相对下标（-4 / -3 / -2）不变；前三列 `id` / `kind` / `title` / `tags` 不动。
I3 的两列 `graph | via` 因此**只能**插在 `tags` 与 `rel` 之间。

各列含义：

| 列 | 含义 |
| --- | --- |
| `id` | 记录 id（拿它调 `memory_expand`） |
| `kind` | `fact` / `lesson` / `preference` / `pointer` |
| `title` | 标题 |
| `tags` | 逗号连接的有序标签 |
| `graph` | I3 标签共现图传播给的**辅助**奖励（已应用硬上限 `GRAPH_BONUS_CAP`；无图证据恰好为 0） |
| `via` | 来源标记：`direct`（词法直接命中）或 `tag:<标签>`（由标签图传播到达） |
| `rel` | **BM25 原始相关度**（绝对标度，不随批次归一化）—— **`match` 的判定依据就是它** |
| `cov` | 标签覆盖率（**仅诊断**，不门控、不整批否决） |
| `match` | 绝对判定 `none` / `weak` / `strong` |
| `score` | `disp(final)` 映射到 0..1 的**展示分**（仅用于排序展示，与 `rel` 不同标度） |

### 可复算铁律

- **`match` 恒可复算**：把打印出的 `rel` 与表头给出的两个阈值比一下即可 ——
  `rel >= weak` 记 `weak`、`rel >= strong` 记 `strong`、否则 `none`。
  表头会同时打印阈值数字，所以复算不需要翻源码。
- **`score` 不保证可精确复算**：`score = disp(final)`，其中
  `final = (rel + graph) × 多样性因子`，多样性因子 `= 1 − β·maxSim`
  （β 默认 0.3，`maxSim` 是该行与**已选行**的最大标签 Jaccard 相似度），
  且该因子**只在候选数 > 5 时施加**（候选 <= 5 时恒为 1）。
  由于 **β 与 maxSim 都不是打印列**，多样性被启用时 `score` 无法仅由打印的 `rel` / `graph`
  精确复算。这是如实声明的限制，不是实现疏漏。
- **`match` 与 `score` 是两种标度**，别拿一个去验另一个。`rel` 的绝对标度由两个固定常数
  定义：`disp = clip((raw − SCALE_A) / (SCALE_B − SCALE_A), 0, 1)`，落地值
  `SCALE_A = 0.0187`、`SCALE_B = 0.3420`、`WEAK_THRESHOLD = 0.0363`、
  `STRONG_THRESHOLD = 0.1476`（可用配置覆盖）。
- **无词法证据时 `rel = 0`**（不是「score 是 0」）。仅由标签图到达的记录会
  `graph > 0`、`via = tag:<标签>`、`match = none`；它的 `score` 取决于标度常数，
  默认口径下因 `SCALE_A (0.0187) > GRAPH_BONUS_CAP (0.018)` 而恰好为 `0.0000`，
  但这不是恒等式 —— 改了标度常数就会变。图奖励**只奖不罚**，绝不整批否决。

表头已减肥为**单行、<= 400 字符**，只保留「复算所必需」的结论性数字（列序 / `rel` 语义与
`match` 依据 / 两个阈值 / `disp(final)` 公式与两个标度常数 / `limit` 是硬显示上限 /
I2 结论 / 低置信 / I3 结论）。非结论性诊断（`basisSize`、`layers`、`logicalDepth`、
`explainedRatio`+`residualRatio` 守恒、传播上限与 `gamma`/`rho`、种子与到达计数、多样性 β）
不再回显在表头，但**一个都没删**，仍逐字在结构化返回字段里。

---

## 3. 分阶段实现

| 阶段 | 一句话 |
| --- | --- |
| **I1 地基** | 四个窄工具 + 人类可读 NDJSON 存储：失败关闭的写入协议、原子写、硬上限 + 按分淘汰、零运行时依赖 |
| **I1.2 打分** | 打分口径对齐已验证机制：按字段统计的 BM25 + **绝对标度**（禁批内归一化）+ VCP 式标签覆盖率作诊断列 + MMR 多样性并入分数 |
| **I1.3 自证** | 让打印出来的数能自行复现判定：`rel` 改为**判定所用的 BM25 原始分**（此前打印的是另一个量，读者无法验算 `match`） |
| **I2 残差金字塔分诊** | 以候选标签向量为基、在标签 idf 词法空间做 Gram-Schmidt 残差金字塔，novelty = `0.7×残差能量比 + 0.3×方向一致性`，据此决定是否扩大内部检索预算；金字塔状态全部请求级局部 |
| **I2.1 limit 硬上限** | `limit` 从「影响候选池」改为**硬显示上限**：返回行数恒为 `min(limit, 可用候选数)`，扩检索只放大内部预算 `kBase -> kUsed`；空查询（无词元能量）不做分诊 |
| **I4a 稳定索引注入** | 两条与查询无关、低频变化的注入贡献、两种机制：**易变尾部块**（`context`，order 200）承载「库的索引」（条数 + 这是什么 + 条件规则 + 锚点，库变了才变），**稳定段**（`section`，order 3200）承载「规则本身」；硬字符预算 + 如实省略标记 + 两段共用开关 + 任何异常 fail-open；附幂等只读缓存 |
| **I4a.1 松耦合** | `inject` 收窄为 `['tools']`，注入面改走 `ctx.inject(['systemPrompt'], scope => ...)` 条件注册：缺 `systemPrompt` 时**只少一块注入**，绝不牵连 4 个工具 |
| **I4a.2 锚点资格过滤** | 标签出现率 > `ANCHOR_MAX_DF_RATIO`（默认 0.3）者**不得**成为锚点：本机 200 条真库（2026-10-09 快照）上 `坑位`（182/200 = 91.0%）被剔除，合格集合里最高的是 `判据`（34/200 = 17.0%）；一条都不合格时如实写「无可区分锚点」而**绝不**回落到全库最高频标签 |
| **I4a.3 条件规则 + 稳定段** | 注入文案从**陈述句**（旧句 `｜细则用 memory_recall`）改为**条件规则**（`排查·为什么·复现·以前是否踩过 这类问题，先 memory_recall 查库`），并把同一规则独立注册为稳定段 `agent-memory-habit`（order 3200，落在工具说明带之后、`TOOLS_SDK(5000)` 之前的空档，**不挤占任何引擎自有槽位**）；两段共用 `injection.enabled`；**如实定位：规则是提示，不是保证**（红证只能证明文案里写了触发条件，证明不了模型一定照做） |
| **I3 共现图与有界传播** | 每次调用按当前库构建有序双向标签共现图（分方向计数、`log(1+λW)` 压缩、出流归一化到固定预算、枢纽抑制 `(inDeg/median)^-η`）+ 有界脉冲传播（跳数/状态数/出邻边数上限、衰减 γ、即时回流抑制 ρ），给排序加**有上限的辅助奖励** |
| **语料导入** | `scripts/import-gotchas.mjs` 把 `gotchas.md` 批量导入记忆库，支持 dry-run 与备份 |
| **标定（按 200 条级语料）** | `scripts/calibrate.mjs` 在负样本集上标出 `SCALE_A = p50(negatives)`、`WEAK = p95(negatives)` 等常数；负样本由 `scripts/negative-samples.mjs` 从冻结的跨域词表**确定性生成、≥200 条（实测 240 条）**，不再是 12 条手写小集（并打印小样本 vs 全集的敏感性对照）；**只打印建议，从不自动改写任何文件或配置** |
| **表头减肥 / 标度解耦** | 召回表头从 1049~1066 字符（本机实测，见 `redproof/i5-header-old-measure.txt` 与 `redproof/i5-header-red.txt`）压到单行 <= 400 字符；此前表头把标度常数回显两遍，导致**改标定常数会连带改掉「显示几行」**，现在由 `test/header.test.mjs` 钉住「标度常数不得影响显示行数」 |
| **单点真相** | `RECALL_COLUMNS` 同时是四处（`recallCells` 键序、`L1Row` 字段序、输出 schema 的 `rows.properties` 键序、实际序列化行键序）的唯一来源，由 `test/columns.test.mjs` 在运行时钉住；列清单漂移会直接变红 |
| **描述对账** | `memory_recall` 的**工具描述**由 `test/description.test.mjs` 逐条钉住：`graph`/`via` 列语义、`final=(rel+graph)×多样性因子` 与「仅当候选数 > 5 时施加」、多样性开时 `score` 无法仅由打印的 `rel`/`graph` 精确复算而 `match` 恒可由 `rel` + 表头阈值复算、无**词法**证据时 `rel=0` 但图到达行 `graph>0`/`via=tag:<标签>`/`match=none`；`β` 与候选数阈值**直接引用模块级常数**（说不成立公式即变红） |

---

## 4. 硬不变量（工程主张）

这几条是本项目的核心工程主张，改动时不应绕过：

1. **候选展示分禁批内归一化**。改用**绝对标度 + BM25**：`disp` 的区间由固定的
   `SCALE_A` / `SCALE_B` 定义，**不依赖任何同批候选**。批内 min-max 归一化会让同一份
   记忆的分数随「这一批里恰好还有谁」而漂移，也让跨会话的分数不可比。
2. **`limit` 是硬显示上限**。返回行数恒为 `min(limit, 可用候选数)`；内部扩检索
   （I2 分诊的 `kBase -> kUsed`）**只放大内部预算**（给金字塔取更大的基、给多样性更大的
   候选池），**绝不增加返回行数**。把「内部候选池预算」误读成「显示上限」是明确的误用。
3. **请求级隔离**：无**影响请求结果**的模块级可变状态（代码里唯一的模块级可变是
   `src/store.ts` 的原子写临时文件序号 `tmpSeq`，只用于让临时文件名不重名，不参与任何
   召回 / 打分 / 注入计算；「请求级隔离」本身由 `test/triage.test.mjs` 与
   `test/graph.test.mjs` 的「新进程单独只跑第二次」逐字段一致断言钉住）。金字塔基、图传播、
   打分统计都按调用重建；注入侧只保留以文件身份三元组 `{path, size, mtimeMs}` 为键的**幂等只读**缓存
   （同键必同值，且与库自身的「外部改动守卫」同一身份口径）。同一个键禁止放进查询、
   agent、scope 或时间。
4. **注入文本稳定**：注入的**索引行不与库内容实时联动**。尾部块只放条数 + 这是什么 + 条件规则 +
   有区分力的标签锚点，**不放**「最近写入的标题」「时间戳」这类每次都变的东西；稳定段的规则是
   常量，库怎么变它都不变。引擎侧只在快照文本与上一份**不同**时才产出消息，所以库不变则文本
   逐字节相同、后续每一步零新增消息、前缀缓存不被打断。塞进实时列表会**每一步都追加一条消息**，
   既污染上下文也打断缓存。
5. **注入 fail-open 且松耦合**。任何读库 / 解析 / 注册异常都只降级成空串，**绝不抛**——
   一次抛异常的注入会跟着炸掉引擎的 `assemble()`，从而毁掉**每一步**。同时 `inject` 只声明
   `['tools']`，`systemPrompt` 走条件注册：缺它时只少一块注入，四个工具照常可用。
6. **注入文本净化 `{{…}}`**。注入的 `text` 会被引擎的 `interpolate()` 扫描，**未知或畸形
   引用会抛错**，所以所有动态文本都过 `sanitizeForPrompt()` 去掉 `{` `}`。
7. **列清单单点真相**。`RECALL_COLUMNS` + 编译期穷尽性检查
   （`Record<RecallColumn, string>`）：数组少一列或取值表没跟上，**tsc 直接报错**，
   而不是运行时静默漂移。

---

## 5. 安装

本插件是 DSH 插件，装进 profile 的插件面即可。

**第一步：软链进 profile 的 `node_modules/@dsh-agent/`**

```bash
mkdir -p <profile>/node_modules/@dsh-agent
ln -s /storage/emulated/0/deepseek/dsh-agent-memory <profile>/node_modules/@dsh-agent/dsh-agent-memory
```

**第二步：在 `cordis.patch.yml` 里加一条**

```yaml
- insert:
    - id: agent-memory
      name: '@dsh-agent/dsh-agent-memory'
```

**第三步：重启 DSH。这一步不能省** —— 引擎是在**启动时**载入插件模块的，不重启不会生效。

**构建**（先构建再重启；`lib/` 是 tsc 产物，不入库）：

```bash
node node_modules/typescript/bin/tsc -p .
```

可选配置挂在 `MemoryConfig` 上，常用几项：`maxRecords`、`maxBytes`、
`injection.enabled`（默认 true，false = 完全不注册、不输出任何字符）、
`injection.maxChars`（默认 240，天花板 4000）、`injection.topTags`（默认 3，天花板 64）、
`injection.anchorMaxDfRatio`（默认 0.3）。

---

## 6. 测试与红证

```bash
npm test
```

`npm test` 展开为一串**逐文件直跑**的 `node test/x.test.mjs`（18 个测试文件）。
当前状态：**172 pass / 0 fail**（2026-10-09 实测）。

**为什么不是 `node --test`**：本机的 `node --test` **坏**（见「环境事实」第 1 条），
所以测试全部按文件逐个直跑。这是本机环境事实，不是设计选择。

**`redproof/` 是什么**：它是本项目的**红证取证目录** —— 每条机制都附一份「**能判红**」的
证据。做法是：先把机制**人为禁用/改坏**（`*-disable.txt` 是禁用后的失败输出），确认测试
**确实变红**；再恢复（`*-restored.txt`）确认**变绿**。所以目录里成对出现
`…-disable.txt` / `…-restored.txt`。这样「测试通过」才不是空话 —— 它证明了这些测试
**在该机制坏掉时真的会失败**，而不是永远绿。

目录里还有少量探针脚本（只有 4 个 `.mjs`）：
`draft-header-lengths.mjs`、`lineformat-probe.mjs`、`measure-header.mjs`、`patch-src.mjs`，
以及 `run-all.sh` 汇总脚本。

`scripts/` 下 5 个脚本：

| 脚本 | 行数 | 作用 |
| --- | --- | --- |
| `calibrate.mjs` | 241 | 标定打分常数，**只打印建议，从不自动改写**文件或配置；空库时退出码 0 并给可读提示 |
| `import-gotchas.mjs` | 568 | 把 `gotchas.md` 导入记忆库，支持 dry-run 与备份 |
| `negative-samples.mjs` | 99 | 零参数、确定性的跨域负样本生成器；把负样本从 12 条手写扩到 240 条，让标定不再依赖手写小集 |
| `i4a-measure.mjs` | 117 | 注入行的实测（字符数 / 行数 / 落点） |
| `i4a1-loose-probe.mjs` | 156 | 松耦合注入的探针（缺 `systemPrompt` 时的行为） |

---

## 7. 诚实的局限

不粉饰，逐条列出已知的弱点与边界：

1. **标定常数是单一来源、单一声明的产物**。`SCALE_A` / `SCALE_B` / `WEAK_THRESHOLD` /
   `STRONG_THRESHOLD` 是在**一份语料、一种文风**上标出来的。**语料明显增长或文风变化后
   必须重标**。`scripts/calibrate.mjs` **只打印建议、从不自动改写**任何东西 ——
   也就是说，重标是**人工动作**，不重标就会静默地失准。
2. **I3 的图奖励接近二值**。因为用了 `max` 聚合 + 硬上限，
   `graph` 列的取值实际上几乎只有「0」和「一个接近上限的值」两种。
   所以**不要用 `graph` 的大小去比较两条记忆**；衡量 I3 是否起作用应该看
   **`reachable`**（有多少条是靠图到达的），那才是它价值的指标。
3. **注入边界对 `{{…}}` 做了净化，但写入协议可以被绕过**。插件侧的注入文本会过
   `sanitizeForPrompt()`；但**手工改 NDJSON 文件**就绕过了 `memory_remember` 的写入协议
   —— 库是纯文本、人类可读的，这是它的优点，也是它的**绕过面**。绕过协议写入的坏数据
   不会被插件拦住。
4. **库里存在少量近似重复**。在导入 `gotchas.md` 语料时，产生了若干
   「**手写版 + 导入原文版**」并存的记录 —— 同一件事被记了两遍，措辞不同。
   `memory_prune` 的合并规则是「同 kind 同标题」，**标题不同就合不掉**，所以这类重复会
   留在库里。
5. **`cov` 是诊断列，不是质量保证**。标签覆盖率只反映「查询词与标签的重合度」，
   高 `cov` 不等于高相关；它**不门控**任何结果（这是刻意的，见「硬不变量」背景：
   上游回退过「低覆盖整批否决」）。
6. **标签空间靠人工稳定复用**。锚点质量依赖「全库稳定复用同一批标签」这个纪律；
   标签随手造（错别字、临时记号）会让锚点退化。I4a.2 的资格过滤只掐掉「覆盖全库的公共
   标签」这一种噪音，**掐不掉 df=1 的一次性标签**（那需要 idf 式排序，本增量刻意没做，
   只做了有红证的那一半）。
7. **`node --test` 不可用**，测试必须逐文件直跑（见第 6 节与第 10 节）。
   这意味着 CI 不能照抄常规 Node 测试命令。

---

## 8. 上游与署名

**本仓是从零独立实现的项目。** 源码、测试、脚本与取证日志均为本项目自行编写，
**没有复制第三方项目的任何代码**（不含逐字复制、不含改写式复制、不含粘贴后改名）。

设计与来源参考：

- 参考项目：[lioensky/VCPToolBox](https://github.com/lioensky/VCPToolBox)
- 其许可：**CC BY-NC-SA 4.0**
- 使用方式：**仅参考公开的设计思想、部分常量的口径与作者的负结果记录**，
  **未使用其任何源代码**。

我们**实际借用**的东西（逐项列明，避免含糊）：

1. **残差金字塔 / 投影熵的分诊思想** —— 用「候选标签向量相对已有基的残差能量」判断召回
   是否已覆盖查询方向，据此决定是否扩大内部检索预算。本项目落地在 `residualPyramid()`
   与 I2 分诊段（差异：在**标签 idf 词法空间**里做 Gram-Schmidt，novelty 取
   `0.7×残差能量比 + 0.3×方向一致性`，且金字塔状态全部请求级局部）。
2. **时间衰减与 RRF 的口径** —— 以时间衰减作排序乘子，用 Reciprocal Rank Fusion 的
   倒数排名形式融合多路排序，避免引入需要重新标定的加权和。
3. **共现图的 `log(1+λW)` 压缩、出流预算与枢纽抑制** —— 共现权重按对数压缩而非线性累加；
   每节点出流归一化到固定预算；高度数枢纽节点按下压指数抑制，避免少数枢纽支配传播。
   落地常量：`GRAPH_LAMBDA=1`、`GRAPH_OUT_BUDGET=1`、`GRAPH_HUB_ETA=0.5`。
4. **它已回退的做法清单（负结果）帮助我们避免了三个坑**：
   - **批内归一化**：本项目改用绝对标度 + BM25，候选展示分绝不按批做 min-max 归一化；
   - **低覆盖整批否决**：`cov` 仅作诊断列，低置信只如实报告，绝不返回空、绝不整批否决；
   - **全局单例状态**：禁止模块级可变状态，跨调用状态一律请求级局部量。

详见本仓 [NOTICE](./NOTICE)。参考资料的本地只读副本在
`/storage/emulated/0/deepseek/audit/vcp/`（**不在本仓内**）。

---

## 9. 许可证

本仓采用 **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
（CC BY-NC-SA 4.0）**，与上游 VCPToolBox 保持同源许可。完整条款见 [LICENSE](./LICENSE)。

- **署名**：必须给出适当署名、提供指向本许可的链接，并说明是否作出修改；不得暗示许可人
  认可你或你的使用。
- **非商业性使用（NonCommercial）**：不得将本作品用于商业目的。
- **相同方式共享（ShareAlike）**：若再混合、转换或基于本作品创作，必须以相同或兼容的
  许可协议分发你的贡献作品。

**如实说明**：**Creative Commons 官方不建议将 CC 协议用于软件**。CC 协议不含专利授权
条款，且「非商业性使用」在软件场景下含义不够确定。本项目**刻意**选择 CC BY-NC-SA 4.0
的理由是**与上游保持同源**，而不是因为它是软件许可的常规选择 —— 如果你需要一个软件许可，
这不是推荐选择。

LICENSE 文件内容：Creative Commons **标准法律文本**（CC BY-NC-SA 4.0 官方
`legalcode.txt`，来源 <https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.txt>，
**438 行 / 20850 字节，与官方原文逐字节一致**、**未作任何增删改写**）；
本项目的**署名头（许可摘要 + 来源）在 [NOTICE](./NOTICE) 里**，**不在** LICENSE 开头
（LICENSE 第一行就是官方标题 `Attribution-NonCommercial-ShareAlike 4.0 International`）。

---

## 10. 环境事实（本机特有的坑）

以下是本机（Android / Termux 环境）特有的、想复现的人一定会撞上的坑：

1. **`node --test` 坏**。本机 `process.execPath` 指向安卓 linker64，导致测试运行器的
   子进程 spawn 失败。**绕过办法**：spawn node 时用 `process.argv0` 而不是
   `process.execPath`；测试也改成逐文件直跑 `node test/x.test.mjs`。
2. **`/storage/emulated/0`（FUSE）不能建软链**。所以插件的软链**必须建在 profile 侧**
   （`<profile>/node_modules/@dsh-agent/dsh-agent-memory -> 本仓`），
   不能在仓库内部建软链。这与 FUSE 不支持 symlink 有关，不是权限问题。
3. **`/tmp` 不可写，但 `cd /tmp` 会成功**（本机实测：`/tmp` 权限是 `drwxrwx--x`
   —— 对 others 有 `x` 无 `w`）。所以 `cd /tmp && pwd` 会顺利打印 `/tmp`，
   **看起来可用**，而任何写入都 `Permission denied`。别用 `cd /tmp` 去探测可写性，
   要探测就直接写一个文件。临时文件应落在别处（测试用 `.tmp-test/` 建临时 `DSH_HOME`，
   每次跑测试都会重建；已在 `.gitignore` 里）。
4. **`lib/` 不入库，测试前必须先 `tsc`**。`lib/` 是 `tsc` 产物（`.gitignore` 已排除），
   但测试与运行时都从 `lib/` 加载，所以**必须先构建**：
   `node node_modules/typescript/bin/tsc -p .`。
5. **真实记忆库不在仓里**。200 条真实记忆在 `$DSH_HOME` 下（快照值，2026-10-09 实测）：
   `<DSH_HOME>/agent-memory/memory.ndjson`。`DEFAULT_HOME` 的默认值是
   `/data/user/0/com.dsharnessmobile.shell/files/home/.dsh`（可用 `DSH_HOME` 覆盖）。
   `.gitignore` 不包含它 —— 它**物理上就不在仓目录内**。
6. **零运行时依赖**。`peerDependencies` 只有 cordis 与 dsh-tools；
   `devDependencies` 是 typescript、`@types/node`，外加把上述两个 peer 依赖按同版本再装一份
   （仅供本地构建 / 测试；运行时仍只吃宿主提供的 peer）。

---

## 11. 仓库内容

| 路径 | 内容 |
| --- | --- |
| `src/*.ts` | 6 个源文件（`index.ts` / `inject.ts` / `json.ts` / `protocol.ts` / `pure.ts` / `store.ts`） |
| `test/*.mjs` | 18 个测试文件（172 pass / 0 fail，2026-10-09 实测） |
| `scripts/*.mjs` | 5 个脚本（标定 / 导入 / 负样本 / 注入实测 / 松耦合探针） |
| `redproof/` | 143 个被跟踪红证取证文件（136 个 `.txt` 取证日志 + 4 个探针 `.mjs` + `run-all.sh` + 2 个 `lineformat-*.json`；`.txt` 里成对出现 disable / restored） |
| `package.json` / `tsconfig.json` | 包与编译配置 |
| `LICENSE` / `NOTICE` / `README.md` | 许可 / 署名 / 门面文档 |

**发布前请读这一节。** 本仓是**按「本机开发过程的完整留痕」提交的**，不做路径脱敏：

- **`redproof/` 与 `scripts/` 含本机绝对路径**。形如
  `/data/user/0/com.dsharnessmobile.shell/files/home/.dsh/...`（应用私有目录）、
  `/data/data/com.dsharnessmobile.shell/files/usr/lib/node_modules/...`（引擎安装位置）、
  `/storage/emulated/0/deepseek/dsh-agent-memory/...`（本仓自身所在路径）、
  `/data/data/com.termux/files/usr/bin/bash`（`redproof/run-all.sh` 的 shebang）。
  共 **54 个被跟踪文件**含这类路径（**三个模式取并集**：`/data/user/0/`、`/data/data/`、
  `/storage/emulated/0/`）。按目录：`redproof/` 49 个、`src/store.ts` 1 个、
  `scripts/i4a-measure.mjs` 1 个、`test/inject.test.mjs` 1 个、`README.md` 1 个、`NOTICE` 1 个。
  （**只 grep `/data/` 会得到 9** —— 并集里 **45 个文件只含 `/storage/emulated/0/`、不含任何
  `/data/` 子串**，两个模式都命中的只有 `README.md` 一个文件。这正是上一轮把 54 误判成
  9 的原因。）
- **取证日志里的数字是历史快照，不是当前值**。例如
  `redproof/i2.3-calibrate-real-library.txt` 记录的是当天的 **195 条**库，
  而当前真实库是 **200 条**（2026-10-09 快照）。日志是「当时跑出什么」的凭证，**不应**被当成现值来引用；
  现值请以 `memory_recall` 的 `total` 字段为准。
- **没有发现任何密钥 / 令牌 / 凭据**（见 README 的审计结论；`token` 字样的命中全部是
  标定用的 `nonexistent-token` 负样本串）。**也没有**设备型号或系统版本号。
- 这些路径确实是「本机特有的环境细节」，泄露的是**目录布局**而非凭据。若你要把它公开，
  自行决定是保留（它们是红证可复现性的一部分）还是改写为占位符。
