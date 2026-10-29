# 用本任务独有镜像验收真实 SDK + 本地假 Anthropic

## 目标

只为本任务构建一个独占 tag 的 sandbox 镜像（来源：当前工作树 Dockerfile + 当前源码），用该镜像真实执行 `packages/worker/test/session-sandbox-sdk.test.ts`，确认 10 个用例全部实际执行、无 skip，并且不修改/重标共享 `agentport/sandbox:dev`、不重启共享服务、不产生付费模型请求、不推送镜像。

## 方案

- 镜像来源：工作树根目录 `Dockerfile` 的 `sandbox` target（当前 HEAD 已含 `apk add ... bash` 与构建期 `bash --version | grep GNU bash` 校验）。构建上下文为当前 worktree 根，`.dockerignore` 排除 `node_modules`/`dist`/`.tmp`。
- 镜像 tag：`agentport/sandbox:review-loop-610bd2`，仅本任务使用，验收后保留供主会话联合复用；不删除、不覆盖任何共享 tag。
- 测试入口：`SANDBOX_IMAGE=<独有tag> pnpm exec vitest run --project backend packages/worker/test/session-sandbox-sdk.test.ts`。测试源码 `packages/worker/test/session-sandbox-sdk.test.ts:32` 已支持 `process.env.SANDBOX_IMAGE`（默认 `agentport/sandbox:dev`），无需修改测试。
- 当前源码产物：测试 `compileCurrentSources()` 每轮从当前 `packages/shared/src`、`packages/sandbox/src` 编译到 `mkdtemp` 独占目录，再以只读挂载覆盖镜像内旧 dist，不依赖仓库既有 `dist`。
- 模型流量：测试内置本地假 Anthropic SSE（`host.docker.internal`），清空真实凭证，不发外部模型请求。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-review-loop`
- HEAD：`e060e3a559633a0d94adb637516a6d577b86b1aa`；开工时 78 项未提交/未跟踪差异属并行任务（chat 滚动、knowledge queue、remove-thinking 等），不还原、不提交。
- 允许写：本记录与 `.tmp/codebase-review-sdk-image/`（gitignored）。不改源码、配置、测试。

## 当前有效决定

- 不动共享 `agentport/sandbox:dev` 与其他既有 tag；只新增本任务 tag。
- 不修改测试；如入口不支持镜像变量才报告最小修正，不自行改。
- 构建可后台运行；运行结束后清理本任务容器/临时目录，镜像保留。

## 已替代项及原因

无。

## 步骤

- [x] 确认测试支持 `SANDBOX_IMAGE`，旧 `agentport/sandbox:dev` 实测缺 bash（`exec: "bash": executable file not found in $PATH`）。
- [x] 从当前工作树构建独有 tag 镜像。
- [x] 校验镜像内 GNU bash、uid 1000、SDK 0.3.311。
- [x] 以独有镜像运行真实 SDK + 本地假 Anthropic 套件，核对 10 例均执行。
- [x] 清理本任务容器与临时目录并记录证据。

## 改动文件

- `docs/tasks/codebase-review-sdk-image.md`（本记录）
- `.tmp/codebase-review-sdk-image/*`（本地脚本/日志，不随分支交付）

## 下一步

无。镜像 `agentport/sandbox:review-loop-610bd2`（ID `sha256:f37fb83c4caf7fedca72b44218d1fd7ca1339d65c3e5befdf6876da599c31202`）保留，供主会话联合复用；不删除、不重标共享 `agentport/sandbox:dev`。

## 验证

基线：HEAD `e060e3a`；旧共享镜像实测缺 bash：`docker run --rm --entrypoint bash agentport/sandbox:dev --version` → `exec: "bash": executable file not found in $PATH`。

构建（工作树根，后台执行，exit 0）：
`docker build --target sandbox -t agentport/sandbox:review-loop-610bd2 .`
- 镜像 ID `sha256:f37fb83c4caf7fedca72b44218d1fd7ca1339d65c3e5befdf6876da599c31202`，Created `2026-10-29T13:25:48Z`；构建日志 `.tmp/codebase-review-sdk-image/build.log`。
- 实测 `bash --version` → `GNU bash, version 5.3.9(1)-release (aarch64-alpine-linux-musl)`；`id -u` → `1000`；镜像内 SDK 版本 → `0.3.311`。

真实套件（同一独有镜像，共跑两次）：
`SANDBOX_IMAGE=agentport/sandbox:review-loop-610bd2 pnpm exec vitest run --project backend --hookTimeout 300000 packages/worker/test/session-sandbox-sdk.test.ts`
→ `Test Files 1 passed (1)` / `Tests 10 passed (10)`，Duration 74.26s。

逐例证据（`--reporter=verbose --disableConsoleIntercept` 重跑，同一镜像）：
`SANDBOX_IMAGE=agentport/sandbox:review-loop-610bd2 pnpm exec vitest run --project backend --hookTimeout 300000 --reporter=verbose --disableConsoleIntercept packages/worker/test/session-sandbox-sdk.test.ts`
→ `Tests 10 passed (10)`，75.00s；10 条 `✓ |backend| ...` 分别为：单轮本地假 API（6024ms）、容器复用 + session 恢复（6838ms）、空闲回收 + 磁盘 session 恢复（12132ms）、取消挂起并续跑（10081ms）、Bash default 写 `/mnt/outputs`（6378ms）、Bash dontAsk（6072ms）、父级 Bash deny（6021ms）、命令级 Bash deny（6130ms）、子智能体 Bash（6189ms）、子智能体 Bash deny 作用域（6149ms）。无 skip、无 `×`。
- 全程 27 次模型请求全部打到本地假 Anthropic（`/v1/messages` 27/27，`model=claude-sonnet-5-5`，来自本次 `/tmp/session-sdk-ZJeuFz/fake-anthropic.jsonl`），无外部模型请求。
- `--hookTimeout 300000` 只是防止 beforeAll 的 `tsc -b --force` + 多次 `docker run` 探针超过项目默认 20s；未改测试与配置。第一次运行未加 verbose 同样通过，说明当前机器上默认 hook 时限通常也够。

源码来源：`/tmp/session-sdk-current-source.json`（通过轮次）记录 `compiledAt 2026-10-29T13:27:39Z`、`repoRoot` 指向本 worktree、`shared` digest `6bae5f0c…`、`sandbox` digest `6499afef…`；测试自行以 `tsc -b --force` 编译到 `session-sdk-source-GS1qFz` 并只读挂载进容器，未复用旧 dist。

清理与隔离证据：
- 无本任务镜像残留容器：`docker ps -a --filter ancestor=agentport/sandbox:review-loop-610bd2` 输出为空。
- 测试 beforeAll 的 `session-sdk-source-*` 临时编译目录由 afterAll 自行删除，检查无残留。
- 本任务两次运行的 `/tmp/session-sdk-ZJeuFz`、`/tmp/session-sdk-kr2ET5` 已删除。
- 共享 `agentport/sandbox:dev` 未被改动：ID 仍为 `sha256:f79edc9f2343…`，Created `2026-10-28T10:42:48Z`。
- 验收结束时仍在运行的 `backend_test_redis_a684af26d9f947fe` 创建于 `2026-10-29T13:29:00Z`，晚于本任务最后一轮测试结束（约 13:28:52Z），属其他并行任务，未触碰。
