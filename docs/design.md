# 设计说明

本文件写给**改这个插件的人**：分期实现、硬不变量、两条注入机制，以及为什么不做动态召回。

面向使用者的最短说明见 [../README.md](../README.md)；召回输出契约见 [recall-contract.md](recall-contract.md)。

## 1. 分期实现

| 阶段 | 一句话 |
| --- | --- |
| **I1 地基** | 四个窄工具 + 人类可读 NDJSON 存储：失败关闭的写入协议、原子写、硬上限 + 按分淘汰、零运行时依赖 |
| **I1.2 打分** | 打分口径对齐已验证机制：按字段统计的 BM25 + **绝对标度**（禁批内归一化）+ VCP 式标签覆盖率作诊断列 + MMR 多样性并入分数 |
| **I1.3 自证** | 让打印出来的数能自行复现判定：`rel` 改为**判定所用的 BM25 原始分**（此前打印的是另一个量，读者无法验算 `match`） |
| **I2 残差金字塔分诊** | 以候选标签向量为基、在标签 idf 词法空间做 Gram-Schmidt 残差金字塔，novelty = `0.7×残差能量比 + 0.3×方向一致性`，据此决定是否扩大内部检索预算；金字塔状态全部请求级局部 |
| **I2.1 limit 硬上限** | `limit` 从「影响候选池」改为**硬显示上限**：返回行数恒为 `min(limit, 可用候选数)`，扩检索只放大内部预算 `kBase -> kUsed`；空查询（无词元能量）不做分诊 |
| **I4a 稳定索引注入** | 两条与查询无关、低频变化的注入贡献、两种机制：**易变尾部块**（`context`，order 200）承载「库的索引」（条数 + 这是什么 + 条件规则 + 锚点，库变了才变），**稳定段**（`section`，order 3200）承载「规则本身」；硬字符预算 + 如实省略标记 + 两段共用开关 + 任何异常 fail-open；附幂等只读缓存 |
| **I4a.1 松耦合** | `inject` 收窄为 `['tools']`，注入面改走 `ctx.inject(['systemPrompt'], scope => ...)` 条件注册：缺 `systemPrompt` 时**只少一块注入**，绝不牵连 4 个工具 |
| **I4a.2 锚点资格过滤** | 标签出现率 > `ANCHOR_MAX_DF_RATIO`（默认 0.3）者**不得**成为锚点：本机 203 条真库（2026-10-09 快照）上 `坑位`（182/203 = 89.7%）被剔除，合格集合里最高的是 `判据`（34/203 = 16.7%）；一条都不合格时如实写「无可区分锚点」而**绝不**回落到全库最高频标签 |
| **I4a.3 条件规则 + 稳定段** | 注入文案从**陈述句**（旧句 `｜细则用 memory_recall`）改为**条件规则**（`排查·为什么·复现·以前是否踩过 这类问题，先 memory_recall 查库`），并把同一规则独立注册为稳定段 `agent-memory-habit`（order 3200，落在工具说明带之后、`TOOLS_SDK(5000)` 之前的空档，**不挤占任何引擎自有槽位**）；两段共用 `injection.enabled`；**如实定位：规则是提示，不是保证**（红证只能证明文案里写了触发条件，证明不了模型一定照做） |
| **I3 共现图与有界传播** | 每次调用按当前库构建有序双向标签共现图（分方向计数、`log(1+λW)` 压缩、出流归一化到固定预算、枢纽抑制 `(inDeg/median)^-η`）+ 有界脉冲传播（跳数/状态数/出邻边数上限、衰减 γ、即时回流抑制 ρ），给排序加**有上限的辅助奖励** |
| **语料导入** | `scripts/import-gotchas.mjs` 把 `gotchas.md` 批量导入记忆库，支持 dry-run 与备份 |
| **标定（按 200 条级语料）** | `scripts/calibrate.mjs` 在负样本集上标出 `SCALE_A = p50(negatives)`、`WEAK = p95(negatives)` 等常数；负样本由 `scripts/negative-samples.mjs` 从冻结的跨域词表**确定性生成、≥200 条（实测 240 条）**，不再是 12 条手写小集（并打印小样本 vs 全集的敏感性对照）；**只打印建议，从不自动改写任何文件或配置** |
| **表头减肥 / 标度解耦 / 有界回显** | 召回表头从 1049~1066 字符（本机实测，见 `redproof/i5-header-old-measure.txt` 与 `redproof/i5-header-red.txt`）压到单行；此前表头把标度常数回显两遍，导致**改标定常数会连带改掉「显示几行」**，现在由 `test/header.test.mjs` 钉住「标度常数不得影响显示行数」。**修正 1**：旧的「<= 400」只被 3 个短查询夹具验过，而表头的长度输入里有一个**无界量**（回显的查询串）与一个**配置相关量**（标度常数的十进制宽度）——长查询实测 742/932 字符、22 位小数常数把固定部分顶到 413。现在总上界 `HEADER_MAX_CHARS = 448` 由构造保证：`formatHeaderQuery()` 按**现算预算**先截断原始查询再 JSON 转义并标注 `…(截断)`，`formatHeaderConstant()` 把常数定宽回显（超宽用 `≈` 标注近似）；最坏情况用例覆盖 240 字符边界查询、`Number.MAX_VALUE` 常数与三位数库规模统计 |
| **单点真相** | `RECALL_COLUMNS` 同时是四处（`recallCells` 键序、`L1Row` 字段序、输出 schema 的 `rows.properties` 键序、实际序列化行键序）的唯一来源，由 `test/columns.test.mjs` 在运行时钉住；列清单漂移会直接变红 |
| **描述瘦身 + 描述/文档对账（修正 2）** | `memory_recall` 的**工具描述**从 1182 字符压到 **261 字符**（<= 300），只留模型每次调用都要用的五件事：由 `RECALL_COLUMNS` 派生的 10 列清单、一句 `rel`/`match`/`score` 语义、`limit` 是硬显示上限、绝不返回 body、指向 `docs/recall-contract.md`。删掉的细则**一条都没丢**，逐字搬进该文档的 §10；`test/description.test.mjs` 于是分两层钉：描述层钉「长度 <= 300 + 五件必备 + 两根反向断言（旧的不成立表述不得复现）」，文档层把原先钉在描述上的每一条细则**逐字**钉在文档上（删掉文档里任一条即红）—— 描述既然把口径指向那份文档，文档就必须真的载着情报，否则指针是谎。`β` 与候选数阈值**直接引用模块级常数**（说不成立公式即变红）。**不用 `deferLoading`** 的理由见 `docs/recall-contract.md` §10 末段 |
| **发布面（修正 3）** | 去掉 `"private": true` 并补 `publishConfig.access = "public"`（scoped 包否则 `npm publish` 以 402 被拒）；`peerDependencies` 用语义化范围 `^4.0.4` / `^0.2.0-rc.2` 而不是精确版本（精确版本会把宿主的 minor 升级挡在门外），`devDependencies` **故意**保持精确（本地构建可复现，目的不同不需同步）；`files` 补上 `docs/recall-contract.md`（描述指向它，不随包发出去就是指向空气）。**路径规范化**：全仓被跟踪文件里机器相关的应用私有前缀清零（`test/release.test.mjs` 钉住，它用拆字构造以免自指）；`src/store.ts` 的 `DEFAULT_HOME` 改成可移植推导 `$HOME/.dsh`，`ENGINE_BASE` 改成从 `$PREFIX` 推，`redproof/run-all.sh` 的 shebang 改成 `#!/usr/bin/env bash`。计数与口径见 `docs/limitations.md` |

## 2. 硬不变量（工程主张）

改动时不应绕过：

1. **候选展示分禁批内归一化**。改用**绝对标度 + BM25**：`disp` 的区间由固定的 `SCALE_A` / `SCALE_B` 定义，**不依赖任何同批候选**。批内 min-max 归一化会让同一份记忆的分数随「这一批里恰好还有谁」而漂移，也让跨会话的分数不可比。
2. **`limit` 是硬显示上限**。返回行数恒为 `min(limit, 可用候选数)`；内部扩检索（I2 分诊的 `kBase -> kUsed`）**只放大内部预算**（给金字塔取更大的基、给多样性更大的候选池），**绝不增加返回行数**。把「内部候选池预算」误读成「显示上限」是明确的误用。
3. **请求级隔离**：无**影响请求结果**的模块级可变状态（代码里唯一的模块级可变是 `src/store.ts` 的原子写临时文件序号 `tmpSeq`，只用于让临时文件名不重名，不参与任何召回 / 打分 / 注入计算；「请求级隔离」本身由 `test/triage.test.mjs` 与 `test/graph.test.mjs` 的「新进程单独只跑第二次」逐字段一致断言钉住）。金字塔基、图传播、打分统计都按调用重建；注入侧只保留以文件身份三元组 `{path, size, mtimeMs}` 为键的**幂等只读**缓存（同键必同值，且与库自身的「外部改动守卫」同一身份口径）。同一个键禁止放进查询、agent、scope 或时间。
4. **注入文本稳定**：注入的**索引行不与库内容实时联动**。尾部块只放条数 + 这是什么 + 条件规则 + 有区分力的标签锚点，**不放**「最近写入的标题」「时间戳」这类每次都变的东西；稳定段的规则是常量，库怎么变它都不变。引擎侧只在快照文本与上一份**不同**时才产出消息，所以库不变则文本逐字节相同、后续每一步零新增消息、前缀缓存不被打断。塞进实时列表会**每一步都追加一条消息**，既污染上下文也打断缓存。
5. **注入 fail-open 且松耦合**。任何读库 / 解析 / 注册异常都只降级成空串，**绝不抛** —— 一次抛异常的注入会跟着炸掉引擎的 `assemble()`，从而毁掉**每一步**。同时 `inject` 只声明 `['tools']`，`systemPrompt` 走条件注册：缺它时只少一块注入，四个工具照常可用。
6. **注入文本净化 `{{…}}`**。注入的 `text` 会被引擎的 `interpolate()` 扫描，**未知或畸形引用会抛错**，所以所有动态文本都过 `sanitizeForPrompt()` 去掉 `{` `}`。
7. **列清单单点真相**。`RECALL_COLUMNS` + 编译期穷尽性检查（`Record<RecallColumn, string>`）：数组少一列或取值表没跟上，**tsc 直接报错**，而不是运行时静默漂移。

## 3. 两条注入机制与引擎 seam

插件只碰三处引擎 seam，其余一律不碰：

| seam | 用途 | 落点与顺序 |
| --- | --- | --- |
| `host.tools.register`（`inject: ['tools']`） | 注册 4 个工具 | 必需依赖；缺 `tools` 时 fiber **静默**停在 PENDING |
| `ctx.systemPrompt.context({ name, order, text })` | 库的**索引行**（易变尾部块） | `name = agent-memory`，`order = 200`（引擎 `CONTEXT_ORDERS` 既有最大值是 120 `SUBAGENT_DELEGATION`，取 200 ⇒ 排在所有既有 context 之后）。落点是一条 `runtime-context` user 消息，追加在本轮消息列表**尾部**，**不改 system prompt 正文** |
| `ctx.systemPrompt.section({ name, order, text })` | **条件规则本身**（稳定段） | `name = agent-memory-habit`，`order = 3200`，落在工具说明带之后、`TOOLS_SDK(5000)` 之前的空档，**不挤占任何引擎自有槽位**。属于稳定前缀，每步都在 |

为什么用两种机制：规则的更新频率（几乎不变）与索引的更新频率（库一变成一条）不同。塞进同一处会让规则跟着库的每次变化一起抖。

**注册方式**：`ctx.inject(['systemPrompt'], (scope) => { scope.systemPrompt.section(...); scope.systemPrompt.context(...) })`。这是引擎官方惯例的条件注册：`systemPrompt` 解析不到实现时回调不执行 ⇒ **只少一块注入**，4 个工具照常可用。`context` / `section` 的 `order` 必须是**显式有限数字**（`getSectionOrder()` 对外部名字返回 undefined，而 `section()` 对非有限 order 直接抛）。

**文本来源**：`text` 可以是字符串或 `(assemblyContext) => string`。动态部分全部过 `sanitizeForPrompt()`，整个构建过程 fail-open（catch 里绝不再抛）。

**两段共用开关**：`injection.enabled`（默认 true）。关掉就两条都不注册，没有「只关一条」的半开状态。

**本机实测（2026-10-09，203 条真库）**：索引行文本逐字为

```
记忆 203 条（跨会话经验教训）｜排查·为什么·复现·以前是否踩过 这类问题，先 memory_recall 查库｜标签锚点：判据 / 快照 / 测试
```

长度 **76 字符**（上限 240，未截断）；当前锚点集合是 `判据 / 快照 / 测试`；全库 110 个不同标签，过 0.3 出现率资格过滤的有 109 个。

**幂等只读缓存**：注入侧唯一的缓存以文件身份三元组 `{path, size, mtimeMs}` 为键，同键必同值（纯函数：内容 → 条数 + 锚点）。缓存实例由 `apply()` 闭包持有，模块级没有任何可变状态。缓存不参与 I2 红线（I2 禁的是**请求级**可变状态）。

## 4. 为什么不自动召回（按话题）

**现状**：自动进上下文的只有那行索引和那条稳定规则。**具体记忆内容不会自动注入** —— 要正文必须由模型显式调 `memory_recall`。那条规则是**提示**，提高「被想起来」的概率，**不强制**模型调用。

**要做「按话题自动召回」会缺什么**（依据：当前源码的配置面与注册面）：

1. **缺一个相关性门槛**。`MemoryConfig` 里与召回 / 打分有关的只有 `score`（标度常数）、`triage`（`noveltyThreshold` / `activationThreshold` / `maxBasis` / `maxLayers` / `residualStop`）、`graph`、`injection` 这几组（另有 `home` / `maxRecords` / `maxBytes` / `maxRecordBytes` / `fs` / `now` / `newId` 属于存储与测试注入项），**没有任何 `minMatch` 之类的「够不够格自动注入」门槛**。`WEAK_THRESHOLD` / `STRONG_THRESHOLD` 是**绝对判定**（给 `match` 标签用），不是「要不要注入这段正文」的闸门；直接拿它当自动注入的门槛，等于把判定标度当成行为策略，误注入的代价（把无关记忆塞进每一步上下文）由用户承担。
2. **缺一个每步钩子**。索引行是**与查询无关**的常量（这是硬不变量第 4 条刻意要求的：库不变则文本逐字节相同、前缀缓存不被打断）。要按话题召回，就得有一个**按当前用户消息重算**的注入点（引擎侧对应 `agent/pre-step` 一类钩子），而本插件今天**只注册 `tools` 与条件 `systemPrompt`**，没有注册任何 pre-step 钩子。加上它就意味着注入文本**每一步都可能不同** —— 那正是第 4 条明确要避免的失效模式，必须同时解决缓存与上下文污染，不是加一行代码。

**因此**：当前选择是「**索引常驻 + 内容按需显式召回**」，并把「不自动召回」如实写进 README 的适用场景与边界（而不是让用户以为是自动的）。这是**如实的现状说明**，不是「暂未实现」的承诺。

## 5. 可选配置

配置挂在 `MemoryConfig` 上（工具 config / profile patch 皆可）。常用几项：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `maxRecords` | 2000 | 条数硬上限（可用 `DSH_AGENT_MEMORY_MAX_RECORDS` 覆盖） |
| `maxBytes` | 4 MiB | 字节硬上限（可用 `DSH_AGENT_MEMORY_MAX_BYTES` 覆盖） |
| `maxRecordBytes` | `maxBytes` 的 10% | 单条上限，超出即 `record-too-large` 拒收 |
| `injection.enabled` | true | false = 完全不注册、不输出任何字符 |
| `injection.maxChars` | 240 | 索引行硬字符上限（天花板 4000） |
| `injection.topTags` | 3 | 标签锚点个数（天花板 64） |
| `injection.anchorMaxDfRatio` | 0.3 | 锚点资格过滤的出现率上限 |

打分 / 分诊 / 图口径的覆盖字段见 `src/store.ts` 的 `MemoryConfig` 注释（`score` / `triage` / `graph`）。
