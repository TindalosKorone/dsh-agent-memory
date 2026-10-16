# 安装

本文件写给**要把本插件装进一个 DSH profile 的人或 agent**：三种安装方式、装完的验证，以及每条路各自的前置条件。

使用与工具说明见 [../README.md](../README.md)；装完出问题见 [troubleshooting.md](troubleshooting.md)。

## 0. 前置

- 已装好 DSH（`dsh` 在 PATH 上）与 pnpm（`dsh plugin` 会把剩余参数转发给 pnpm）。
- 知道目标 profile 名（如 `web` / `tui`）。
- 本包**运行时零依赖**：`peerDependencies` 只有宿主提供的 `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-tools`，不需要额外装东西。

## 方式 A：一行装远端（最省事，不需要 clone）

```bash
dsh plugin --profile <profile> add github:TindalosKorone/dsh-agent-memory
```

装的是该仓**已提交**的内容，其中 `lib/` 是随包入库的构建产物 —— 所以安装时**不构建、不需要 TypeScript**。

## 方式 B：本地 clone + 构建 + 安装（要改代码走这条）

1. **克隆到本地**

   ```bash
   git clone https://github.com/TindalosKorone/dsh-agent-memory.git
   cd dsh-agent-memory
   ```

2. **构建产物**

   ```bash
   pnpm install
   pnpm run build          # 等价 node node_modules/typescript/bin/tsc -p .
   ```

   `lib/` 已随包入库，只装不改时可跳过；改过 `src/` 则**必须**重建并把 `lib/` 一并提交（见 [development.md](development.md) 第 1 节）。

3. **安装进 profile**

   ```bash
   dsh plugin --profile <profile> add /绝对路径/dsh-agent-memory
   ```

   pnpm 对本地目录记成 `link:` —— profile 的 `node_modules/@dsh-agent/dsh-agent-memory` 是指回本仓的软链。之后改代码只要重建 + **重启 DSH**，不必重装。

   > 无法在仓库内建软链的环境（FUSE / `<external-storage>`）不受影响：这条路本来就把软链建在 **profile 侧**。

## 方式 C：交给 agent

把下面这段（按需改 profile 名与路径）交给一个能跑命令的 agent，让它照着本文件做：

```text
请按 docs/install.md 把 dsh-agent-memory 安装进 DSH 的 web profile：
优先方式 B（clone 到本地、pnpm install && pnpm run build、再用
dsh plugin --profile web add <本仓绝对路径>），完成后重启 DSH 并验证四个
memory_* 工具出现。
```

> 方式 A 的一行装也可以直接交给 agent 执行。

## 安装后

- **必须重启 DSH**：插件在 boot 时载入。装完、改完配置不重启不会生效，工具也不会出现。
- 重启前的依赖登记检查：

  ```bash
  dsh plugin --profile <profile> list          # 应列出 @dsh-agent/dsh-agent-memory
  ```

- 重启后应能用 `memory_remember` / `memory_recall` / `memory_expand` / `memory_prune` 四个工具。
- 记忆库位置：`$DSH_HOME/agent-memory/memory.ndjson`（`DSH_HOME` 未设时为 `$HOME/.dsh`）。

## 卸载 / 回退

```bash
dsh plugin --profile <profile> remove @dsh-agent/dsh-agent-memory
```

- 方式 B 的 `link:` 依赖移除后，本仓与其中已构建的 `lib/` 原样保留。
- 记忆库是独立文件，卸载插件**不会**删记忆；要一并清掉需自行处理 `$DSH_HOME/agent-memory/memory.ndjson`。
