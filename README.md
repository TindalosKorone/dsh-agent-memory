# dsh-agent-memory

给 DSH Agent 用的跨会话长期记忆：四个工具（`memory_remember` / `memory_recall` / `memory_expand` / `memory_prune`）把值得留下的结论写进一份人类可读的 NDJSON 文件，下次会话按需召回。

> **注意：没有「按话题自动召回」。** 自动进上下文的只有一行索引（条数 + 条件规则 + 标签锚点）和一条稳定规则；**记忆正文不会自动注入**，要内容必须由模型显式调用 `memory_recall`（再按 id 调 `memory_expand` 取正文）。那条规则是**提示**，不是**保证**。

## 适用场景

- **适合**：跨会话留结论 —— 事实、教训、偏好、指路。
- **不适合**：多用户 / 多租户共享记忆；「一问就自动想起相关内容」的场景（本插件不自动召回）。
- 边界：**单机、单用户、单 profile**，记忆库是一个本地文件（`$DSH_HOME/agent-memory/memory.ndjson`），默认上限 2000 条 / 4 MiB，超限按 `recency*(1+hits)` 淘汰。
- 本机正在用：203 条真实记忆（2026-10-09 实测；会随使用增长，现值以 `memory_recall` 的 `total` 或注入行的「记忆 N 条」为准）。

## 功能

- `memory_remember`：写入并落盘，写入协议**失败关闭**（字段不合规即拒收，不落盘，并给出可照做的修复指引）
- `memory_recall`：按查询召回 **L1 索引**（每条一行 10 列，**绝不回 body**）
- `memory_expand`：按 id 取回 **L2 正文**，取回会累加 `hits`
- `memory_prune`：同 kind 同标题合并，再按分淘汰（`dryRun` 默认 true，不动磁盘）
- 两条注入贡献：尾部索引行（`systemPrompt.context`，`order` 200，≤240 字符）+ 稳定规则段（`systemPrompt.section`，`order` 3200）
- 零运行时依赖；数据是人类可读的 NDJSON

## 快速开始

### 1. 构建

```bash
node node_modules/typescript/bin/tsc -p .
```

`lib/` 是 tsc 产物，不入库；它不存在时测试与运行时都加载不了。

### 2. 软链进 profile 的 `@dsh-agent/`

```bash
mkdir -p <profile>/node_modules/@dsh-agent
ln -s /storage/emulated/0/deepseek/dsh-agent-memory <profile>/node_modules/@dsh-agent/dsh-agent-memory
```

### 3. 在 `cordis.patch.yml` 里加一条

```yaml
- insert:
    - id: agent-memory
      name: '@dsh-agent/dsh-agent-memory'
```

### 4. 重启 DSH

**这一步不能省** —— 引擎是在**启动时**载入插件模块的，不重启不生效。

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

- **工具没出现**：插件是 boot 时载入的 ⇒ 改完软链或 patch **必须重启 DSH**。
- **插件卡在 PENDING、工具一直不来**：检查软链与 `cordis.patch.yml` 的 `- insert` 条目。`inject: ['tools']` 是必需依赖，缺 `tools` 会**静默**停在 PENDING，不报错也不可用。
- **`node --test` 报 `expected absolute path`**：本机 `process.execPath` 指向安卓 linker64，测试运行器 spawn 失败。绕过办法：逐文件直跑 `node test/x.test.mjs`；脚本里 spawn node 用 `process.argv0`。
- **`lib/` 没构建**：先 `tsc -p .`（见「快速开始」第 1 步）。
- **注入那行为什么不变**：它只由**库内容**决定，库不变则逐字节相同（引擎只在快照文本变化时才产出消息）。库变了才会变；`injection.enabled: false` 则完全不注入。
- **库在哪 / 怎么备份 / 上限**：`$DSH_HOME/agent-memory/memory.ndjson`，NDJSON 纯文本，直接 `cp` 就是备份。默认 2000 条 / 4 MiB，单条默认 ≤ maxBytes 的 10%。
- 更多本机坑（`/storage/emulated/0` 不能建软链、`/tmp` 不可写但 `cd /tmp` 会成功）见 [docs/development.md](docs/development.md)。

## 安全

- 记忆库是**本地纯文本**文件，位置 `$DSH_HOME/agent-memory/memory.ndjson`；**不含任何凭据**。
- 上限：默认 2000 条 / 4 MiB；单条默认 ≤ maxBytes 的 10%；写超限直接拒收（不落盘、不触发淘汰）。
- 许可：**CC BY-NC-SA 4.0**（与上游 VCPToolBox 保持同源）。条款见 [LICENSE](LICENSE)。

## 上游与署名

本仓是从零独立实现，未复制第三方项目的任何代码；设计来源、实际借用点与「负结果」清单见 [NOTICE](NOTICE)。

## 链接

- [docs/design.md](docs/design.md) — 分期实现、7 条硬不变量、两条注入机制、为什么不自动召回
- [docs/recall-contract.md](docs/recall-contract.md) — 10 列逐列含义、打分常数、写入协议与 fail-closed 闸门
- [docs/development.md](docs/development.md) — 构建、测试纪律与红证、脚本、环境事实
- [docs/limitations.md](docs/limitations.md) — 7 条诚实局限、标定出处、发布注意
- [redproof/](redproof/) — 红证取证目录（每条机制一份「能判红」的证据）
- [NOTICE](NOTICE) / [LICENSE](LICENSE)
