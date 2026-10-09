# 诚实的局限与发布注意

本文件写给**评估这个插件能不能用、以及准备公开它的人**：不粉饰的已知弱点、标定口径的出处，以及发布前必须知道的留痕情况。

使用见 [../README.md](../README.md)；契约见 [recall-contract.md](recall-contract.md)。

## 1. 七条诚实的局限

1. **标定常数是单一来源、单一声明的产物**。`SCALE_A` / `SCALE_B` / `WEAK_THRESHOLD` / `STRONG_THRESHOLD` 是在**一份语料、一种文风**上标出来的。**语料明显增长或文风变化后必须重标**。`scripts/calibrate.mjs` **只打印建议、从不自动改写**任何东西 —— 也就是说，重标是**人工动作**，不重标就会静默地失准。
2. **I3 的图奖励接近二值**。因为用了 `max` 聚合 + 硬上限，`graph` 列的取值实际上几乎只有「0」和「一个接近上限的值」两种。所以**不要用 `graph` 的大小去比较两条记忆**；衡量 I3 是否起作用应该看 **`reachable`**（有多少条是靠图到达的），那才是它价值的指标。
3. **注入边界对 `{{…}}` 做了净化，但写入协议可以被绕过**。插件侧的注入文本会过 `sanitizeForPrompt()`；但**手工改 NDJSON 文件**就绕过了 `memory_remember` 的写入协议 —— 库是纯文本、人类可读的，这是它的优点，也是它的**绕过面**。绕过协议写入的坏数据不会被插件拦住。
4. **库里存在少量近似重复**。在导入 `gotchas.md` 语料时，产生了若干「**手写版 + 导入原文版**」并存的记录 —— 同一件事被记了两遍，措辞不同。`memory_prune` 的合并规则是「同 kind 同标题」，**标题不同就合不掉**，所以这类重复会留在库里。
5. **`cov` 是诊断列，不是质量保证**。标签覆盖率只反映「查询词与标签的重合度」，高 `cov` 不等于高相关；它**不门控**任何结果（这是刻意的：上游回退过「低覆盖整批否决」）。
6. **标签空间靠人工稳定复用**。锚点质量依赖「全库稳定复用同一批标签」这个纪律；标签随手造（错别字、临时记号）会让锚点退化。I4a.2 的资格过滤只掐掉「覆盖全库的公共标签」这一种噪音，**掐不掉 df=1 的一次性标签**（那需要 idf 式排序，本增量刻意没做，只做了有红证的那一半）。
7. **`node --test` 不可用**，测试必须逐文件直跑（见 [development.md](development.md)）。这意味着 CI 不能照抄常规 Node 测试命令。

## 2. 标定出处（语料变了必须重标）

四个打分常数出自一次离线标定，**样本来源是本机真实记忆库**。以下是本机快照（**2026-10-09 实测**，会随使用变化）：

| 项 | 值 |
| --- | --- |
| 库内有效记录 | **203 条**（372110 字节） |
| 正样本 | **406 个**（每条记录的标题 + 前 3 个标签各一次查询，对自身打分） |
| 负样本 | **240 个**（12 个固定头部 + 228 个跨域词表组合；确定性，两次运行逐字节一致） |

**当前落地值 vs `calibrate.mjs` 在 203 条库上的实测建议**（两者不一致，属如实记录）：

| 常数 | 落地值（`src/pure.ts`） | 本次建议值 | 口径 |
| --- | --- | --- | --- |
| `SCALE_A` | 0.0187 | 0.0199 | p50(负样本) |
| `SCALE_B` | 0.3420 | 0.3621 | p95(正样本) |
| `WEAK_THRESHOLD` | 0.0363 | 0.0381 | p95(负样本) |
| `STRONG_THRESHOLD` | 0.1476 | 0.1506 | p10(正样本) |

也就是说：语料已经从标定时的规模长到 203 条，**重标已经该做了但还没做** —— 这正是第 1 条局限的实例化。差值都在 0.02 以内，属样本增长的正常漂移（对照 `src/pure.ts` 注释里记录的历史漂移量级）。

另有两点口径说明：

- **分诊阈值与图系数不由 `calibrate.mjs` 标定**：`noveltyThreshold`（0.5）、`activationThreshold`（0.05）是**门控行为量**不是分数标度；I3 的 `lambda` / `outBudget` / `hubEta` / `decay` 等图系数同理。`GRAPH_BONUS_CAP = 0.018` 仍标注为「**待真实语料标定**」。
- **取证日志里的数字是历史快照，不是当前值**。例如 `redproof/i2.2-calibrate-real-library.txt` 记录的是当天的 **194 条**库与 **388 个**正样本，`redproof/i2.3-calibrate-real-library.txt` 记录的是 **195 条**库与 **390 个**正样本，而当前真实库是 **203 条**。日志是「当时跑出什么」的凭证，**不应**被当成现值来引用；现值请以 `memory_recall` 的 `total` 字段或重新跑 `scripts/calibrate.mjs` 为准。

## 3. 发布注意

**本仓是按「本机开发过程的完整留痕」提交的，不做路径脱敏。**

- **`redproof/`、`scripts/`、`lib/` 与 `src/` 含本机绝对路径**。形如 `/data/user/0/com.dsharnessmobile.shell/files/home/.dsh/...`（应用私有目录）、`/data/data/com.dsharnessmobile.shell/files/usr/lib/node_modules/...`（引擎安装位置）、`/storage/emulated/0/deepseek/dsh-agent-memory/...`（本仓自身所在路径）、`/data/data/com.termux/files/usr/bin/bash`（`redproof/run-all.sh` 的 shebang）。
- **为什么保留 `redproof/` 而不脱敏**：这些路径是红证**可复现性**的一部分 —— 取证日志记录的是「在本机哪条命令、哪个库状态上跑出这个结果」，把路径改成占位符会让「怎么复现这条红证」不可核对。它们是**本机特有的环境细节**，泄露的是**目录布局**而非凭据。
- **没有发现任何密钥 / 令牌 / 凭据**。`token` 字样的命中全部是标定用的 `nonexistent-token` 负样本串。**也没有**设备型号或系统版本号。
- 若你要把它公开，自行决定是保留这些路径，还是改写为占位符（改写会削弱红证的可复现性）。

### 被跟踪文件里含本机绝对路径的数量

**口径**：把每个文件按下述三个模式取**并集**，命中即计数 —— `/data/user/0/`、`/data/data/`、`/storage/emulated/0/`。统计范围为仓库当前**全部被跟踪文件**（`git ls-files`）：**197 个**。以下为 **2026-10-09 实测值**（把 `lib/` 构建产物入库、新增包内 `cordis.patch.yml` 之后重测）：

- 三模式并集：**57 个文件**。
- 按目录：`redproof/` 49 个、`lib/` 2 个（`lib/store.js` 与 `lib/types/store.d.ts`，都是 `src/store.ts` 里那条路径的产物）、`docs/` 2 个（`development.md` / `limitations.md`）、`src/store.ts` 1 个、`scripts/i4a-measure.mjs` 1 个、`test/inject.test.mjs` 1 个、`README.md` 1 个。
- **只 grep `/data/` 会得到 12 个**（判据取自单模式粗筛，偏窄）：并集里 **45 个文件只含 `/storage/emulated/0/`、不含任何 `/data/` 子串**；两个模式都命中的只有 `docs/limitations.md`（本文件）一个。用单模式粗筛就会把 57 误判成 12 —— 这是必须用三模式并集的原因。

## 4. 许可文本

本插件采用 **CC BY-NC-SA 4.0**（Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International），与上游 VCPToolBox 保持同源许可。

- 完整条款见 [LICENSE](../LICENSE)（Creative Commons 标准法律文本，未作任何增删改写）；来源与署名见 [NOTICE](../NOTICE)。
- **如实说明**：Creative Commons 官方**不建议将 CC 协议用于软件** —— CC 协议不含专利授权条款，且「非商业性使用」在软件场景下含义不够确定。本项目刻意选择 CC BY-NC-SA 4.0 的理由是**与上游同源**，而不是因为它是软件许可的常规选择。
