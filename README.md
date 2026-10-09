# dsh-agent-memory

给 DSH Agent 用的跨会话长期记忆：四个工具（`memory_remember` / `memory_recall` / `memory_expand` / `memory_prune`）把值得留下的结论写进一份人类可读的 NDJSON 文件，下次会话按需召回。

> **注意：没有「按话题自动召回」。** 自动进上下文的只有一行索引（条数 + 条件规则 + 标签锚点）和一条稳定规则；**记忆正文不会自动注入**，要内容必须由模型显式调用 `memory_recall`（再按 id 调 `memory_expand` 取正文）。那条规则是**提示**，不是**保证**。

## 适用场景

- **适合**：跨会话留结论 —— 事实、教训、偏好、指路。
- **不适合**：多用户 / 多租户共享记忆；「一问就自动想起相关内容」的场景（本插件不自动召回）。

## 安装

```bash
dsh plugin --profile web add github:TindalosKorone/dsh-agent-memory
```

## 怎么用

1. `memory_remember`：写一条。`kind` 四选一（`fact` / `lesson` / `preference` / `pointer`），`title` 单行 8..120 字符，`tags` 1..12 个，`source` 非空。
2. `memory_recall`：按查询召回索引，每条一行 10 列
   `id | kind | title | tags | graph | via | rel | cov | match | score`。
   `limit` 默认 5、最大 50，且是**硬显示上限**。
   `match` 恒可由打印出的 `rel` 与表头阈值复算；多样性启用时 `score` 不能仅由 `rel`/`graph` 复算。
3. `memory_expand`：拿 `recall` 回的 `id` 取正文（L2）。
4. `memory_prune`：同 kind 同标题合并（留最新、累加 hits），再按 `score = recency*(1+hits)` 从低到高淘汰；`dryRun: false` 才真删。

完整列语义、打分常数、写入协议与闸门见 [docs/recall-contract.md](docs/recall-contract.md)。

## 故障排查

- **工具没出现**：插件是 boot 时载入的 ⇒ 装完或改完配置 **必须重启 DSH**。
- **插件卡在 PENDING、工具一直不来**：先确认本包确实是 profile 的一层 —— 看 profile `package.json` 的 `dsh.profile.bundles` 里有没有 `@dsh-agent/dsh-agent-memory`（没有就说明这个包没被登记为 bundle）。`inject: ['tools']` 是必需依赖，缺 `tools` 会**静默**停在 PENDING，不报错也不可用。
- **`node --test` 报 `expected absolute path`**：本机 `process.execPath` 指向安卓 linker64，测试运行器 spawn 失败。绕过办法：逐文件直跑 `node test/x.test.mjs`；脚本里 spawn node 用 `process.argv0`。
- **`lib/` 没构建**：官方安装下来的包自带入库的 `lib/`，不需要构建；只有从源码或 `file:` 用本仓时才要先 `tsc -p .`（见「安装」）。
- **注入那行为什么不变**：它只由**库内容**决定，库不变则逐字节相同（引擎只在快照文本变化时才产出消息）。库变了才会变；`injection.enabled: false` 则完全不注入。
- **库在哪 / 怎么备份 / 上限**：`$DSH_HOME/agent-memory/memory.ndjson`，NDJSON 纯文本，直接 `cp` 就是备份。默认 2000 条 / 4 MiB，单条默认 ≤ maxBytes 的 10%。
- 更多本机坑（`<external-storage>` 不能建软链、`/tmp` 不可写但 `cd /tmp` 会成功）见 [docs/development.md](docs/development.md)。

## 安全

- 记忆库是**本地纯文本**文件，位置 `$DSH_HOME/agent-memory/memory.ndjson`；**不含任何凭据**。
- 上限：默认 2000 条 / 4 MiB；单条默认 ≤ maxBytes 的 10%；写超限直接拒收（不落盘、不触发淘汰）。
- 许可：本插件采用 [CC BY-NC-SA 4.0](LICENSE)。

## 上游与署名

本插件参考了 [lioensky/VCPToolBox](https://github.com/lioensky/VCPToolBox) 的记忆系统设计（该项目同样采用 CC BY-NC-SA 4.0）。

## 链接

- [docs/design.md](docs/design.md) — 分期实现、7 条硬不变量、两条注入机制、为什么不自动召回
- [docs/recall-contract.md](docs/recall-contract.md) — 10 列逐列含义、打分常数、写入协议与 fail-closed 闸门
- [docs/development.md](docs/development.md) — 构建、测试纪律与红证、脚本、环境事实
- [docs/limitations.md](docs/limitations.md) — 7 条诚实局限、标定出处、发布注意
- [redproof/](redproof/) — 红证取证目录（每条机制一份「能判红」的证据）
- [NOTICE](NOTICE) / [LICENSE](LICENSE)
