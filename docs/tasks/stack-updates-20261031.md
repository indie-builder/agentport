# 2026-10-31 全栈依赖升级

## 目标

将全部直接外部依赖升级到 npm `latest` 对应的非预发布稳定版本，包含主版本；同步 pnpm、Node 运行时（最新用户决定为 Node 24 LTS 24.22.2，不是 26）、容器镜像与 GitHub Actions。以真实构建、运行和已有行为回归验收，不为版本号新增形式测试。

## 方案

先核对版本和关键兼容点，固定执行契约，再按文件边界实施；依赖清单和 lock 保持单一写入者。关键检查为 Node 24 的原生依赖/构建工具、Effect 4 实际使用面、E2E 的截图与秘密边界、SDK 文件设置加载。调查结果、来源与验证证据在本记录追加；文档同步与代码变更随同一变更集交付。

## 关键版本事实

- e2e：worktree `node_modules/e2e/package.json` 实际为 `0.22.0`。官方 release `e2e@0.22.0` 的 breaking 变更写明「a secret fill no longer turns off screenshots for the model」；截图仍遮罩 secure 字段，secret 值仍从文本脱敏；通用 secret 填入普通输入框、或 secure 字段之外显示的值会进入截图并到达模型提供方。
- effect：`pnpm-workspace.yaml` catalog 与已安装 `node_modules/effect/package.json` 均为 `4.1.1`。`docs/EFFECT.md`、`docs/SKILLS.md` 只更新文档中的当前版本号，未改技能文件。
- lock 中既有预发布项有两处：gensync `1.0.0-beta.2`（基线已存在的 Babel 传递依赖，Babel 8 正式版仍声明 `^1.0.0-beta.2`，不能为消除预发布标记降到 `0.1.0` 破坏上游）与 date-fns-jalali `4.1.0-0`（基线已存在的传递依赖）。两者都不是本次新引入；本次未新增任何预发布依赖，也不声称所有传递依赖已无预发布标记。

## 基线与范围

- 工作目录：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/stack-updates-20261031`。
- 起始 commit：`56f01663acff77383ed0cb29cac5cde0971d4238`；开工时 `git status --short` 无输出，无他人未提交差异。
- 升级范围：所有 workspace manifest、pnpm lock/工作区策略、Node 声明、Docker/Compose、Actions、必要兼容修复及现有文档同步。
- 文档同步范围：`README.md`、`docs/PROJECT-BRIEF.md`、`docs/OPERATIONS.md`、`docs/IMPL-CONTRACTS.md`、`docs/EFFECT.md`、`docs/SKILLS.md`、本记录、`docs/PITFALLS.md`，以及 `.npmrc` 的过期 Biome 版本注释；不操作主 checkout、共享数据库或共享服务。
- 测试证据统一落在 `.e2e/stack-upgrade/`（目录被 `.gitignore` 忽略，不进入提交差异）；`/tmp` 或 `.vitest/` 下的临时报告不作为长期证据。

## 当前有效决定

- 用户已授权全部稳定版依赖/工具/Actions 升级到最新版，包含主版本，无需逐项确认。
- **Node 运行时维持 24 大版本，升级到最新补丁 `24.22.2` LTS，不升 26。** 契约统一为：`engines` `>=24.22.2 <25`、CI `node-version: 24.22.2`、镜像 `node:24-alpine`；`@types/node` 固定 `24.19.2`（根与 web 通过 catalog 引用）；pnpm `12.16.1`。历史性能证据不改。
- Node 26 决定已撤回：宿主虽已安装 Node 26，但本任务不使用、不作为验收运行时；Node 26 上得到的结果只作已替代的中间证据。
- 此前未获 commit/push/merge 授权时的状态已结束；本轮已授权提交、推送 PR 并合并，以及收尾本任务 worktree、main 快进更新。截至记录更新时尚未执行，不预测结果。仍不生产部署、不改共享数据库、不改用户登录态、不动共享配置服务。
- 最终需要独立 Opus review；review 未过不提交。

## 已替代项及原因

- 原计划「Node 26 / `@types/node` 26」被用户最新决定替代为 Node 24 LTS 24.22.2。此前在 Node 26 上得到的验证（web 132 files / 1600 passed、build 成功）是已替代的中间证据，不作为最终验收；最终结果以 Node 24.22.2 为准。
- 旧记录曾写「填入 secret 后本次尝试不再向模型发送任何像素」，不成立；已按 e2e 0.22 官方 release 与已安装 `node_modules/e2e/docs/reference/security.mdx` 修正为「secret fill 不再关闭模型截图；截图只遮罩 secure 字段；普通文本/通用 secret 仍可能进入截图并到达模型提供方」。
- 旧两轮 backend 失败是真实问题，不是随机噪声：`delete lifecycle` 故障用例在共享库持绑定锁等满 ACK 预算，拖慢同轮其它删除；`session-task` fixture 用同步写覆盖宿主正在读的文件，读到半截 JSON。两处已分别用独享库与「同目录临时文件 + rename」修复；最终 backend 全量已通过。

## 版本表

直接依赖（14 项，含主版本升级）：

| 依赖 | 升级前 | 升级后 |
| --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk`（worker/sandbox） | 0.3.311 | 0.3.316 |
| `@ai-sdk/openai-compatible` | ^3.0.79 | ^3.0.82 |
| `ai` | ^7.0.154 | ^7.0.159 |
| `@scalar/fastify-api-reference` | 1.76.0 | 1.76.4 |
| `@biomejs/biome` | 2.6.3 | 2.6.4 |
| `e2e` | 0.21.3 | 0.22.0 |
| `@e2e-dev/web` | 0.15.3 | 0.15.4 |
| `@hookform/resolvers` | 6.0.1 | 6.0.2 |
| `cn` | ^0.5.0 | ^0.5.1 |
| `lucide-react` | 1.62.0 | 1.66.0 |
| `motion` | ^14.7.1 | ^14.9.0 |
| `react-resizable-panels` | ^4.15.0 | ^4.15.3 |
| `bullmq`（catalog） | 6.5.0 | 6.5.3 |
| `effect`（catalog） | 4.0.6 | 4.1.1 |

工具与运行时：

| 项 | 升级前 | 升级后 |
| --- | --- | --- |
| Node.js | `>=24`，CI `24` | `>=24.22.2 <25`，CI `24.22.2` |
| `@types/node` | 未在根/web 直接声明 | 根/web 通过 catalog 固定 `24.19.2` |
| pnpm | 12.15.0 | 12.16.1 |

Actions 与镜像：

| 项 | 升级前 | 升级后 |
| --- | --- | --- |
| `actions/checkout` | v4 | v7.0.1 |
| `pnpm/action-setup` | v4 | v6.1.0 |
| `actions/setup-node` | v4 | v7.1.0 |
| `actions/upload-artifact` | v4 | v7.0.2 |
| `docker/setup-buildx-action` | v3 | v4.4.1 |
| `docker/login-action` | v3 | v4.7.0 |
| `docker/build-push-action` | v6 | v7.4.0 |
| `node:24-alpine` digest | `06d7adf3…` | `8a32c8cf…` |
| `redis:8.10.3-alpine` digest | `896f241f…` | `21090af9…` |
| `alpine` | 3.22 | 3.24.3 |

## 步骤

- [x] 核对规则、基线与干净状态，创建本记录。
- [x] 实时核对目标版本与关键官方变更。
- [x] 只读检查关键调用、配置、已安装 SDK 类型与真实回归入口。
- [x] 固定执行契约、分工、来源、待验证项和阻断，交接执行。
- [x] 最终 Node 24 下 `pnpm install --frozen-lockfile` 成功。
- [x] 依赖/配置/Actions 升级已落到工作区（清单见「改动文件」）。
- [x] 最终 Node 24 下 typecheck 通过（后台任务 `b1iei00d9` 退出 0）。
- [x] 最终 Node 24 下 build 通过（后台任务 `bfa8k57lo0` 退出 0）。
- [x] 最终 Node 24 下 web 测试 132 files / 1600 passed（后台任务 `bh0xfq9b5` 退出 0；`.e2e/` 下没有 web JSON 报告）。
- [x] OpenUI 检查 11 项通过（最新后台任务 `bgkljvf7o0`）。
- [x] `lint:focus`、`lint:contract` 通过。
- [x] 改动涉及的 14 个 TS/JSON 文件 Biome 检查通过。
- [x] Docker sandbox/runtime 本任务 tag 均以 final lock 构建成功（后台任务 `b3fo9x4m3` / `bh7w6e465` 退出 0）；运行时实装 Node 24.22.2、SDK 0.3.316、BullMQ 6.5.3、Effect 4.1.1、sharp 输出 PNG 92 字节、原生 CLI 2.1.316。
- [x] SDK/runtime docker 4 个测试文件 22/22 passed（`.e2e/stack-upgrade/real-sdk-final-node24.json`）。
- [x] docker fixture 9/9 passed（`.e2e/stack-upgrade/docker-fixture-node24.json`）。
- [x] 隔离 PostgreSQL 上 `conversations` / `delete-lifecycle` 31/31 passed（`.e2e/stack-upgrade/isolation-node24.json`）。
- [x] 旧两轮 backend 失败已保留历史证据与简述，未记为最终通过（`.e2e/stack-upgrade/backend-history-node24.json`、`targeted-node24.json`）。
- [x] 最终 backend 全量通过：`success: true`、267 test files / 2761 tests、2761 passed、0 failed、0 pending（`.e2e/stack-upgrade/backend-final.json`）。全量运行排除了 4 个真实 SDK/runtime docker 文件，这 4 个文件另行 22/22 passed；两者合计 2783 tests，但不是一次全套运行的结果。
- [x] E2E 补身份 fixtures 后按选择重跑通过：`run.status: passed`、`exitCode: 0`、runtime `node v24.22.2`，selected 16 / executed 16 / passed 16 / failed 0（`.e2e/report.json`）。选择为 `agent-defaults`、`chat-navigation`、`regression` 三个文件加 `support/auth`，实际 16/16；其余 31 条是未选中而记为 skipped，不记失败，也不能写成「全套 0 skip」。
- [x] 最终窄 Opus review（`a28b`）曾发现一项阻断：`delete-lifecycle` 的 `afterAll` 清理链路不健壮——`cleanup` 抛错会跳过 `app.close`，顺序关闭时 `db.close` 抛错会跳过 Redis 容器回收。修复代理 `a151` 已改为逐步收集失败、全部尝试后再抛 `AggregateError`；真实 JSON `.e2e/stack-upgrade/cleanup-final.json` 为 `success: true`、2 files / 31 tests / 31 passed / 0 failed / 0 pending，故障注入真实函数体 5 个场景通过。独立 Opus `a7cede` 复核结论为「此修复通过，代码最终 review 通过」（主会话已收结论并核对 JSON）。该项已关闭，全部升级验证完成。
- [x] 早前未获 commit/push/merge 授权时保持未提交、未合入 main；本轮已授权提交、PR 与合并，尚未执行。

## 改动文件

配置与依赖：

- `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`
- `packages/web/package.json`、`packages/api/package.json`、`packages/worker/package.json`、`packages/sandbox/package.json`
- `biome.json`、`Dockerfile`、`docker-compose.yml`
- `.github/workflows/ci.yml`、`.github/workflows/release.yml`

源码/测试：

- `packages/worker/test/global-setup.ts`（Redis digest 对齐）
- `packages/worker/test/session-sandbox-sdk.test.ts`（SDK 0.3.316）
- `packages/worker/test/fixtures/session-task.mjs`（SIGTERM 监听先于首次心跳；busy 输出改为临时文件 + `renameSync`）
- `packages/api/test/delete-lifecycle.test.ts`（故障用例改用独享库）
- `packages/api/test/conversations.test.ts`（更正 ACK 等待在事务外的注释）
- `packages/worker/src/sandbox/session-cleanup.ts`（同上语义注释）
- `tests/agent-defaults.e2e.ts`、`tests/chat-navigation.e2e.ts`、`tests/regression.e2e.ts`（补 RBAC 身份夹具、修正可见文案）
- Node 26 下为解决 Blob 类型问题加的 `packages/worker/src/knowledge/parsing.ts` 与 `packages/worker/test/knowledge-parsing.test.ts` 改动已撤回，工作区回到基线。

文档：

- `README.md`、`docs/PROJECT-BRIEF.md`、`docs/OPERATIONS.md`、`docs/IMPL-CONTRACTS.md`、`docs/EFFECT.md`、`docs/SKILLS.md`
- `.npmrc`（仅过期 Biome 版本注释）
- `docs/PITFALLS.md`（新增三条跨任务坑）
- `docs/tasks/stack-updates-20261031.md`（本记录）

## 文档与基线冲突

- pnpm 12 的 build script 审批旧字段：文档曾写 `onlyBuiltDependencies` / `ignoredBuiltDependencies`，按 pnpm 11 起官方语义改为 `allowBuilds`（`docs/PROJECT-BRIEF.md`、`docs/OPERATIONS.md` §2.1）。
- E2E 截图旧语义：旧文档把「secret fill 关闭截图」当成当前行为，已按 e2e 0.22 修正（`docs/OPERATIONS.md`）。
- Effect 文档旧版本：`docs/EFFECT.md`、`docs/SKILLS.md` 由 4.0.6 更新为 4.1.1。
- 源码注释与实际不符：删除 ACK 等待实际在事务外（仍持会话级绑定锁），`packages/api/test/conversations.test.ts` 与 `packages/worker/src/sandbox/session-cleanup.ts` 的旧注释已改。
- 当前版本表漂移：`README.md`、`docs/PROJECT-BRIEF.md`、`docs/IMPL-CONTRACTS.md`、`docs/OPERATIONS.md` 的 Node/pnpm/Biome/Redis digest 等已同步到当前 manifest 与 lock。
- 历史证据保留不改：以上只改文档与注释，不重写既有验收数据。

## 验证

- 开工：`git rev-parse HEAD` = `56f01663acff77383ed0cb29cac5cde0971d4238`，`git status --short` 无输出。
- 依赖安装：最终 Node 24 下 `pnpm install --frozen-lockfile` 成功；`pnpm -v` 为 `12.16.1`，已安装 `bullmq@6.5.3`、`effect@4.1.1`、`@anthropic-ai/claude-agent-sdk@0.3.316`、`e2e@0.22.0`、`@types/node@24.19.2`。
- 预发布核对：`git diff -- pnpm-lock.yaml | grep -E '^\+' | grep -Ei 'beta|alpha|rc\.|[0-9]-0:'` 无输出；`git show HEAD:pnpm-lock.yaml` 已含 `gensync@1.0.0-beta.2` 与 `date-fns-jalali@4.1.0-0`，本次未增删预发布条目。
- 证据核对命令：`jq '{success,numTotalTests,numPassedTests,numFailedTests,numPendingTests,files:(.testResults|length)}' .e2e/stack-upgrade/backend-final.json`；`jq '.run.summary,.run.status,.run.exitCode,.run.environment.runtime' .e2e/report.json`；`jq '{success,numTotalTests,numPassedTests}' .e2e/stack-upgrade/real-sdk-final-node24.json .e2e/stack-upgrade/docker-fixture-node24.json .e2e/stack-upgrade/isolation-node24.json`。
- Node 24 声明核对：根 `package.json` `engines` 为 `>=24.22.2 <25`、`packageManager` 为 `pnpm@12.16.1`；CI 两个 job 的 `node-version` 均为 `24.22.2`；`Dockerfile` 三处 base 为 `node:24-alpine`（digest `8a32c8cf…`）；`pnpm-workspace.yaml` catalog 的 `@types/node` 为 `24.19.2`。宿主 nvm default alias 为 `24.22.2`；当前 shell `node -v` 为 `v24.22.1` 是旧 PATH 先命中，不是默认版本未升级，最终验收命令使用 `24.22.2`。root/web/各包 manifest 经 catalog 固定 `@types/node` 24.19.2，lock 中无 26.x；`pnpm outdated` 仅把 `@types/node` 24 相对 latest 26 列为例外，这是 Node 24 契约决定的，不作为待升级项。
- web：132 files / 1600 passed（后台 `bh0xfq9b5` 退出 0）。
- OpenUI：11 项通过（最新后台 `bgkljvf7o0`）。
- `lint:focus`、`lint:contract`：通过。
- Biome：改动涉及的 14 个 TS/JSON 文件通过；全源扫描同一批 860 files，新 70 errors / 232 warnings，旧基线 71 errors / 232 warnings，无新增 error（`.e2e/stack-upgrade/biome-final.json`、`biome-baseline-version.json`）。**不能据此声称全仓 lint 已通过**，只证明没有新增 error。
- Docker：sandbox/runtime 本任务 tag 均以 final lock 构建成功（后台 `b3fo9x4m3` / `bh7w6e465` 退出 0）；运行时断言 Node 24.22.2、SDK 0.3.316、BullMQ 6.5.3、Effect 4.1.1、sharp PNG 92 字节、CLI 2.1.316。
- SDK/runtime docker：4 files 22/22 passed（`.e2e/stack-upgrade/real-sdk-final-node24.json`）。
- docker fixture：9/9 passed（`.e2e/stack-upgrade/docker-fixture-node24.json`）。
- 隔离 PostgreSQL：`conversations` / `delete-lifecycle` 31/31 passed（`.e2e/stack-upgrade/isolation-node24.json`）。
- 旧 backend 失败历史：Node 26 初轮为 2760/2762；Node 24 四 workers 为 2759/2761，对应 267 test files、2 failed files / 2 failed tests（`conversations` 删除用例 503≠204；`session-sandbox-docker` 子进程组标签不匹配）。定向重跑 2 files / 26 tests、1 failed（`session-sandbox-docker` 读到半截 JSON）。这些是已定位并修复的历史失败，不作最终通过。
- 最终 backend 全量：`success: true`、267 test files / 2761 tests、2761 passed、0 failed、0 pending（`.e2e/stack-upgrade/backend-final.json`）。该运行排除的 4 个真实 SDK/runtime docker 文件另行 22/22 passed；合计 2783 tests，但不是一次全套运行的结果。
- E2E：`run.status: passed`、`exitCode: 0`、runtime `node v24.22.2`、selected/executed/passed 16/16/16、failed 0（`.e2e/report.json`）；选择为 `agent-defaults`、`chat-navigation`、`regression` 三个文件和 `support/auth`，实际 16/16；其余 31 条未选中、记为 skipped，不记失败，也不声称全套 0 skip。
- 最终窄 Opus review：历史阻断项已修复并关闭。`a151` 将 `delete-lifecycle` 的 `afterAll` 改为逐步收集失败、全部尝试后再抛 `AggregateError`；真实 `.e2e/stack-upgrade/cleanup-final.json` 为 `success: true`、2 files / 31 tests / 31 passed / 0 failed / 0 pending，故障注入真实函数体 5 个场景通过。独立 Opus `a7cede` 已明确「此修复通过，代码最终 review 通过」，主会话已收到并核对该 JSON；无其他代码阻断。
- 工作区清理：6 个未跟踪 `.vitest/stack-*.json` 已复制到 `.e2e/stack-upgrade/` 后删除；跟踪文件 `.vitest/json/output.json` 已用 `/usr/bin/git restore -- .vitest/json/output.json` 还原到基线（1 个测试文件 / 2 tests），未触碰其他差异。
- 全部升级验证完成。截至记录更新时尚未 commit/push/merge，未合入 main；本轮已授权提交、PR 与合并及收尾，执行交主会话；不声称全套 CI 通过。

## 下一步

1. 无实施待办：全部升级验证已完成（含 `afterAll` 清理修复的 31 tests 与独立 Opus 终审）。
2. 已授权提交与收尾：主会话执行 commit、推送 PR、合并，然后收尾本任务 worktree 并将 main 快进更新；截至记录更新时尚未执行。
3. 已知限制照旧保留：全仓 lint 仍有既有 70 errors / 232 warnings（本次无新增 error），lock 仍有既有传递预发布 `gensync@1.0.0-beta.2` 与 `date-fns-jalali@4.1.0-0`（本次未新增预发布）；不写全套 CI 通过。
