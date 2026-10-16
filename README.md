# dsh-agent-memory

给 DSH Agent 用的跨会话长期记忆：四个工具（`memory_remember` / `memory_recall` / `memory_expand` / `memory_prune`）把值得留下的结论写进一份人类可读的 NDJSON 文件，下次会话按需召回。

> **注意：没有「按话题自动召回」。** 自动进上下文的只有一行索引（条数 + 条件规则 + 标签锚点）和一条稳定规则；**记忆正文不会自动注入**，要内容必须由模型显式调用 `memory_recall`（再按 id 调 `memory_expand` 取正文）。那条规则是**提示**，不是**保证**。

## 适用场景

- **适合**：跨会话留结论 —— 事实、教训、偏好、指路。
- **不适合**：多用户 / 多租户共享记忆；「一问就自动想起相关内容」的场景（本插件不自动召回）。

## 安装

按 **1 → 2 → 3** 走：clone 到本地 → 构建产物 → 用命令装进 profile。

1. **克隆到本地**

   ```bash
   git clone https://github.com/TindalosKorone/dsh-agent-memory.git
   cd dsh-agent-memory
   ```

2. **构建产物**

   ```bash
   pnpm install        # 取 TypeScript 等 devDependencies（本包运行时零依赖）
   pnpm run build      # 等价 node node_modules/typescript/bin/tsc -p .
   ```

   `lib/` 是 tsc 产物且**已随包入库**；只安装、不改源码时，这一步可跳过。

3. **安装进 profile**

   ```bash
   dsh plugin --profile <profile> add /绝对路径/dsh-agent-memory
   ```

   把 `<profile>` 换成目标 profile（如 `web`）。装完**重启 DSH** —— 插件在 boot 时载入，不重启不会出现。

只想用、不打算改代码的话，也可以跳过 clone 直接一行装远端：`dsh plugin --profile <profile> add github:TindalosKorone/dsh-agent-memory`。

**或者，让你的 agent 按 [docs/install.md](docs/install.md) 安装** —— 那份文档写全了三种方式、profile 侧软链、路径与验证步骤。

## 怎么用

1. `memory_remember`：写一条。`kind` 四选一（`fact` / `lesson` / `preference` / `pointer`），`title` 单行 8..120 字符，`tags` 1..12 个，`source` 非空；`scope` **可选**（建议 `project:<名>`，省略 = `global`，非空单行 <= 64 字符）。
2. `memory_recall`：按查询召回索引，每条一行 10 列
   `id | kind | title | tags | graph | via | rel | cov | match | score`。
   `limit` 默认 5、最大 50，且是**硬显示上限**；`scope` **可选**：不传 = 不过滤（与过去完全一致），传了 = 只返回该 scope **或** `global` 的记录（`global` 永远包含），表头回显 `;scope=<值>`，结构化 `rows` 另带 `scope` 字段（打印行仍是 10 列）。
   `match` 恒可由打印出的 `rel`、表头两个阈值与表头回显的**内容量闸门**输入（`contentTokens`/`contentTokenMin`/`gateMargin`）复算（`qTok` 不足**且** `rel < gateMargin×strong` 时 `strong` 封顶 `weak`，短查询照样返回行；单个高专有词元 `rel` 远超阈值则例外放行）；多样性启用时 `score` 不能仅由 `rel`/`graph` 复算。库规模离标定点超过阈值时，表头会如实加一句「建议重跑 calibrate --write」（**只在 recall 表头，不进自动注入**）。
3. `memory_expand`：拿 `recall` 回的 `id` 取正文（L2）。
4. `memory_prune`：同 kind 同标题合并（留最新、累加 hits），再按 `score = recency*(1+hits)` 从低到高淘汰；`dryRun: false` 才真删。

完整列语义、打分常数、写入协议与闸门见 [docs/recall-contract.md](docs/recall-contract.md)。

## 故障排查

装完工具不出现、插件卡在 PENDING、`lib/` 没构建、注入行为不变、库在哪与怎么备份 —— 这些排查步骤已移到 **[docs/troubleshooting.md](docs/troubleshooting.md)**。

## 安全

- 记忆库是**本地纯文本**文件，位置 `$DSH_HOME/agent-memory/memory.ndjson`；**不含任何凭据**。
- 上限：默认 2000 条 / 4 MiB；单条默认 ≤ maxBytes 的 10%；写超限直接拒收（不落盘、不触发淘汰）。
- 许可：本插件采用 [CC BY-NC-SA 4.0](LICENSE)。

## 上游与署名

本插件参考了 [lioensky/VCPToolBox](https://github.com/lioensky/VCPToolBox) 的记忆系统设计（该项目同样采用 CC BY-NC-SA 4.0）。

## 链接

- [docs/install.md](docs/install.md) — 三种安装方式（远端一行 / 本地 clone + 构建 / 交给 agent）、重启与验证
- [docs/troubleshooting.md](docs/troubleshooting.md) — 故障排查（工具不出现、卡 PENDING、注入不变、库位置与备份）
- [docs/design.md](docs/design.md) — 分期实现、7 条硬不变量、两条注入机制、为什么不自动召回
- [docs/recall-contract.md](docs/recall-contract.md) — 10 列逐列含义、打分常数、写入协议与 fail-closed 闸门
- [docs/development.md](docs/development.md) — 构建、测试纪律与红证、脚本、环境事实
- [docs/limitations.md](docs/limitations.md) — 9 条诚实局限、标定出处、发布注意
- [redproof/](https://github.com/TindalosKorone/dsh-agent-memory/tree/main/redproof) — 红证取证目录（每条机制一份「能判红」的证据）
- [NOTICE](NOTICE) / [LICENSE](LICENSE)
