# 开发与验证

本文件写给**改代码、跑测试、加红证的人**：构建、测试纪律、红证目录、脚本用法与本机环境事实。

安装与使用见 [../README.md](../README.md)；设计主张见 [design.md](design.md)。

## 1. 构建

```bash
node node_modules/typescript/bin/tsc -p .
```

`lib/` 是 tsc 产物，**随包入库**：官方安装装的是 git 依赖，pnpm 只会打包该仓**已提交**的内容（实测 pnpm 10.12.1 还会为 git 依赖跑一次内部 `npm install`，因此 `prepare` 路线也可行；但产物入库更确定 —— 安装时不构建、不需要 TypeScript、也不受 pnpm 构建审批策略影响）。`lib/` 不入库，装下来的就是一个没有编译产物、加载不了的包。测试与运行时都从 `lib/` 加载，所以改完源码必须先构建、**并把 `lib/` 一并提交**。`npm run build` 等价于上面这条。

## 2. 测试纪律

```bash
npm test
```

`npm test` 展开为一串**逐文件直跑**的 `node test/x.test.mjs`（18 个测试文件）。当前状态：**172 pass / 0 fail**（2026-10-09 实测；`ℹ pass` 汇总行累加，18 个文件各一行）。

也可以一次跑完并落证据：

```bash
bash redproof/run-all.sh            # 默认写 redproof/full-suite.txt
bash redproof/run-all.sh 证据路径   # 自定义输出；有 fail 时退出码非 0
```

**汇总行**：每个测试文件末尾由 Node 测试运行器打印 `ℹ pass N` / `ℹ fail N`。`run-all.sh` 就是靠 sed 取这两行做汇总（`TOTAL | pass=172 | fail=0`）。

**为什么不是 `node --test`**：本机 `node --test` **坏**（见第 5 节第 1 条），所以测试全部按文件逐个直跑。这是本机环境事实，不是设计选择。

**红证要求（重要）**：新增或改动一条机制时，**必须有「能判红」的证据** —— 先把机制人为禁用 / 改坏，确认相关测试**确实变红**；再恢复，确认**变绿**。只有「测试通过」不算证据：那可能是测试永远绿。红证成对落在 `redproof/`，命名 `…-disable.txt` / `…-restored.txt`。

## 3. `redproof/` 是什么

本项目的**红证取证目录**：每条机制都附一份「**能判红**」的证据。做法是先把机制**人为禁用/改坏**（`*-disable.txt` 是禁用后的失败输出），确认测试确实变红；再恢复（`*-restored.txt`）确认变绿。所以目录里成对出现 `…-disable.txt` / `…-restored.txt`。

被跟踪内容：**143 个文件** = 136 个 `.txt` 取证日志 + 4 个探针 `.mjs` + `run-all.sh` + 2 个 `lineformat-*.json`。

4 个探针脚本（非测试）：

| 脚本 | 用法 |
| --- | --- |
| `patch-src.mjs` | `node redproof/patch-src.mjs "<原串>" "<新串>"`，对 `src/index.ts` 做一次精确子串替换（找不到 / 多处命中即失败），让「关掉某个机制」这一步可复现、可核对 |
| `measure-header.mjs` | `node redproof/measure-header.mjs`，量两处夹具的表头长度，确认「单行」 |
| `lineformat-probe.mjs` | `node redproof/lineformat-probe.mjs <lib/index.js 路径> <home 子目录名>`，用同一份固定语料 + 同一批查询对比改动前后的 L1 输出 |
| `draft-header-lengths.mjs` | `node redproof/draft-header-lengths.mjs`，试算表头草稿长度，找最短可行措辞组合 |
| `i7a-header-after-measure.mjs` | `node redproof/i7a-header-after-measure.mjs`，量「修正 1」后的表头长度：短查询 / 240 字符边界查询 / `Number.MAX_VALUE` 常数，全部必须 `<= HEADER_MAX_CHARS` |

**如何加一条红证**：

1. 先确保对应用例在正常状态下**绿**（跑一遍该文件）。
2. 用 `node redproof/patch-src.mjs "<原串>" "<新串>"` 关掉该机制（改的是 `src/index.ts`），重建 `tsc -p .`。
3. 跑该用例，把失败输出**原文**存为 `redproof/<增量>-<机制>-disable.txt`；确认它是**红**的（不是偶然跳过）。
4. 用 `patch-src.mjs` 反向还原（或 `git checkout -- src/index.ts`），重建，把绿输出存为 `redproof/<增量>-<机制>-restored.txt`。
5. 确认 `git status` 里 `src/` 已还原干净，再提交。

## 4. `scripts/` 用法

`scripts/` 下 5 个脚本：

| 脚本 | 行数 | 作用 |
| --- | --- | --- |
| `calibrate.mjs` | 241 | 标定打分常数，**只打印建议，从不自动改写**文件或配置；空库时退出码 0 并给可读提示 |
| `import-gotchas.mjs` | 568 | 把 `gotchas.md` 导入记忆库，支持 dry-run 与备份 |
| `negative-samples.mjs` | 99 | 零参数、确定性的跨域负样本生成器；把负样本从 12 条手写扩到 240 条，让标定不再依赖手写小集 |
| `i4a-measure.mjs` | 117 | 注入行的实测（字符数 / 行数 / 落点） |
| `i4a1-loose-probe.mjs` | 156 | 松耦合注入的探针（缺 `systemPrompt` 时的行为） |

常用：

```bash
node scripts/calibrate.mjs                 # 只打印：当前常数 + 建议值 + 敏感性对照
node scripts/import-gotchas.mjs --source gotchas.md          # dry-run
node scripts/import-gotchas.mjs --source gotchas.md --write  # 落盘（先备份）
```

`calibrate.mjs` 的纪律：**只打印、从不自动改写**；要改常数得人工动 `src/pure.ts`（或经 `score.*` 配置覆盖）。标定出处与重标时机见 [limitations.md](limitations.md)。

## 5. 环境事实（本机特有的坑）

本机是 Android / Termux 环境。以下是**想复现的人一定会撞上**的坑：

1. **`node --test` 坏**。本机 `process.execPath` 指向安卓 linker64，导致测试运行器的子进程 spawn 失败。**绕过办法**：spawn node 时用 `process.argv0` 而不是 `process.execPath`；测试也改成逐文件直跑 `node test/x.test.mjs`。
2. **`<external-storage>`（FUSE）不能建软链**。所以插件的软链**必须建在 profile 侧**（`<profile>/node_modules/@dsh-agent/dsh-agent-memory -> 本仓`），不能在仓库内部建软链。这与 FUSE 不支持 symlink 有关，不是权限问题。
3. **`/tmp` 不可写，但 `cd /tmp` 会成功**（本机实测：`/tmp` 权限是 `drwxrwx--x` —— 对 others 有 `x` 无 `w`）。所以 `cd /tmp && pwd` 会顺利打印 `/tmp`，**看起来可用**，而任何写入都 `Permission denied`。别用 `cd /tmp` 去探测可写性，要探测就直接写一个文件。临时文件应落在别处（测试用 `.tmp-test/` 建临时 `DSH_HOME`，每次跑测试都会重建；已在 `.gitignore` 里）。
4. **`lib/` 是构建产物、但已入库**：改完 `src/` 必须 `tsc` 重建并提交，否则测试与官方安装下来的包跑的都是旧产物。见第 1 节。
5. **真实记忆库不在仓里**。真实记忆在 `$DSH_HOME` 下：`<DSH_HOME>/agent-memory/memory.ndjson`。`DSH_HOME` 未设时 `DEFAULT_HOME` 取 `$HOME/.dsh`（可移植推导，不再硬编码本机路径；见 `src/store.ts` 与 [limitations.md](limitations.md) 的路径规范化说明）。`.gitignore` 不包含它 —— 它**物理上就不在仓目录内**。
6. **零运行时依赖**。`peerDependencies` 只有 cordis 与 dsh-tools，且用**语义化范围**（`^4.0.4` / `^0.2.0-rc.2`）而不是精确版本 —— 精确版本会让宿主装不进任何别的小版本，`^` 允许向后兼容的 minor/patch、同时挡掉下一个大版本。`devDependencies` 是 typescript、`@types/node`，外加把上述两个 peer 依赖**按精确版本**再装一份（仅供本地构建 / 测试，故意钉死以保证可复现；运行时仍只吃宿主提供的 peer —— 所以 peer 放宽、dev 钉死，两者目的不同，不需要同步）。

## 6. 仓库内容

| 路径 | 内容 |
| --- | --- |
| `src/*.ts` | 6 个源文件（`index.ts` / `inject.ts` / `json.ts` / `protocol.ts` / `pure.ts` / `store.ts`） |
| `lib/*.js` + `lib/types/*.d.ts` | tsc 构建产物（6 个 `.js` + 6 个 `.d.ts`），**随包入库** —— 官方安装不跑构建 |
| `test/*.mjs` | 19 个测试文件（176 pass / 0 fail，2026-10-09 实测）；另有 `helpers.mjs` 与 `isolation-probe.mjs` 两个非测试文件 |
| `scripts/*.mjs` | 5 个脚本（标定 / 导入 / 负样本 / 注入实测 / 松耦合探针） |
| `redproof/` | 168 个被跟踪红证取证文件（159 个 `.txt` + 6 个探针 `.mjs` + `run-all.sh` + 2 个 `lineformat-*.json`） |
| `docs/` | 4 个工程文档（设计 / 召回契约 / 开发 / 局限） |
| `package.json` / `tsconfig.json` | 包与编译配置 |
| `cordis.patch.yml` | 本包的 bundle patch（`package.json` 的 `dsh.bundle.patch` 指向它；官方安装后由它挂载插件，不需要手改 profile 的 patch） |
| `LICENSE` / `NOTICE` / `README.md` | 许可 / 署名 / 门面文档 |
