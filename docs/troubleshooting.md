# 故障排查

本文件写给**装完 / 改完却觉得没生效的人**：最常见的几种「插件没工作」现象、各自的原因与排查步骤。

安装见 [install.md](install.md)；术语见 [glossary.md](glossary.md)；红证纪律与本机环境事实见 [development.md](development.md)；诚实局限见 [limitations.md](limitations.md)。

## 1. 工具没出现

插件是 **boot 时载入**的 ⇒ 装完、改完 `cordis.patch.yml` 或 profile 配置后 **必须重启 DSH**。不重启，工具列表不会变。

## 2. 插件卡在 PENDING、工具一直不来

先确认本包确实是 profile 的一层：

- 看 profile `package.json` 的 `dsh.profile.bundles` 里有没有 `@dsh-agent/dsh-agent-memory`（没有 ⇒ 这个包没被登记为 bundle）。
- `inject: ['tools']` 是**必需**依赖：缺 `tools` 会让 fiber **静默**停在 `PENDING`，不报错也不可用。
- 注入（`systemPrompt`）是**条件**依赖：缺 `systemPrompt` 只损失注入那一行，四个工具**照常注册**（I4a.1 起如此）。

## 3. `lib/` 没构建

官方 / `github:` 安装下来的包**自带入库的 `lib/`**，不需要构建。只有从源码或 `file:` 用本仓时才要先构建：

```bash
pnpm install && pnpm run build      # 等价 node node_modules/typescript/bin/tsc -p .
```

**若漏提交 `lib/`**（例如自行复制源码时），装下来的包会因缺编译产物而加载失败。改完 `src/` 必须重建并把 `lib/` 一并提交。

## 4. 注入那行为什么不变

自动进上下文的注入行**只由库内容决定**：库不变则逐字节相同（引擎只在快照文本变化时才产出新消息）。库变了才会变；`injection.enabled: false` 则完全不注入。**记忆正文永远不自动注入**，要内容必须显式调用 `memory_recall`。

## 5. `node --test` 报 `expected absolute path`

某些环境（安卓 / Termux）里 `process.execPath` 指向 linker64，测试运行器的子进程 spawn 失败。绕过：

- 逐文件直跑：`node test/x.test.mjs`（本仓 `npm test` 就是这么展开的）；
- 脚本里 spawn node 用 `process.argv0` 而不是 `process.execPath`。

## 6. 库在哪 / 怎么备份 / 上限

- 位置：`$DSH_HOME/agent-memory/memory.ndjson`（`DSH_HOME` 未设时为 `$HOME/.dsh`）。
- 备份：NDJSON 纯文本，`cp` 一份即可。
- 上限：默认 **2000 条 / 4 MiB**，单条默认 ≤ 总上限的 10%；写超限直接拒收（不落盘、不触发淘汰）。

## 7. 更多本机坑

`<external-storage>` 不能建软链（软链要建在 profile 侧）、`/tmp` 不可写但 `cd /tmp` 会成功 —— 见 [development.md](development.md) 第 5 节。
