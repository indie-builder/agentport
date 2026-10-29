# 知识连接守卫测试的配置缺口与回归

## 目标
- 让 `packages/api/test/knowledge-server-guard.test.ts` 在存在「带加密 secrets 的普通连接器」时也能真实通过：`GET /api/servers` 返回 200，包含普通连接器、不含 knowledge 连接器。
- 保留两条删除保护用例（通用 DELETE 返回 403；删除被拒后 knowledge 行仍在库里）。
- 用红 → 绿结果证明缺口来自测试 app 配置缺 `APP_SECRET_KEY`，不是生产源码、坏密文或响应 schema 问题。

## 方案
- 测试 app 的 `config` 不再手写 `{ NODE_ENV, SELF_URL }`，改用既有 `testConfig()`（`packages/api/test/helpers.ts`），由它提供 `APP_SECRET_KEY` 等真实配置。
- 在 `beforeAll` 直接调用生产 repo `createServer(handle.db, { kind:'stdio', env:{...} }, config.APP_SECRET_KEY)` 写入一条普通连接器：走生产加密，不手造密文、不改库内数据、不为生产代码加兜底（早前记录误写成 `POST /api/servers`，已按实际代码更正）。
- 列表断言同时验证普通项存在、knowledge 项被过滤。
- `afterAll` 只按本 fixture 的两个 ID 清理（普通连接器 + knowledge 连接器）。

## 基线与范围
- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-review-loop`（`git rev-parse --show-toplevel` 与 pwd 一致）。
- 基线 commit：`e060e3a559633a0d94adb637516a6d577b86b1aa`（HEAD）。
- 开工时已有 105 条未提交差异（约 75 个已跟踪文件改动 + 未跟踪任务记录/测试），属既有 codebase-review 工作与其他代理产出，不属本任务；本任务不触碰、不还原、不提交。
- 本任务只允许改：
  - `packages/api/test/knowledge-server-guard.test.ts`
  - `docs/tasks/codebase-review-knowledge-server-test.md`
- 不改生产源码、helpers、其他测试、主记录；不提交；不派子代理。
- 测试资源由 backend globalSetup 每轮随机 PostgreSQL database + 独享临时 Redis 提供，不共享开发数据；清理只删本次 fixture ID。

## 当前有效决定
- 用户本轮明确限定：只修该测试的配置与回归；不派代理、不提交；只改上述两个文件。
- 独立 Opus 已定位原因：测试 app config 只有 `NODE_ENV`/`SELF_URL`，缺 `APP_SECRET_KEY`；`listServers` 先查全库、过滤 knowledge 后，`toApiServer` 对普通连接器的加密 `env` 解密时 `Buffer.from(undefined)` 抛错 → 500。单跑 3/3 只因该库没有普通加密连接器；预置正常加密 env 可复现 500；补钥 200、去钥 500。非坏数据、非响应 schema。
- 回归顺序：最终测试内容先在旧缺钥 setup 下跑出红，再改用 `testConfig()` 跑绿。
- 队列线由另一代理诊断，不做其诊断、不改其文件；sandbox-probe 仅作为可跑的组合验证。

## 已替代项及原因
- 不改生产 `listServers`/`toApiServer` 加缺钥兜底：缺口在测试 app 的配置投影，生产配置 schema 已强制要求 `APP_SECRET_KEY`。
- 不向数据库手工插入密文：密文必须由生产 `encryptSecrets` 以同一 key 生成，否则验证的是伪造输入。

## 步骤
- [x] 记录基线与既有差异归属（本文件）
- [x] 在旧缺钥 setup 下加入普通加密连接器 fixture，跑到红色并记录真实失败
- [x] 改用 `testConfig()`，跑到绿色并记录计数
- [x] 跑完整 `knowledge-server-guard` 套件 + 必要组合 `sandbox-probe`
- [x] 跑 biome/diff 检查，更新记录

## 改动文件
- `packages/api/test/knowledge-server-guard.test.ts`
- `docs/tasks/codebase-review-knowledge-server-test.md`

## 下一步
已验收：独立 Opus `a0b` 通过；主会话 `bvn` 该文件 3 passed / 0 skip。未提交。最新全量 backend（`bcx1la0wa`）在本修复前该文件失败，修复后随队列交付统一重跑，见主记录。

## 验证
- 红（旧 setup：`app.decorate('config', { NODE_ENV:'test', SELF_URL })`，fixture 已用 `testConfig().APP_SECRET_KEY` 正常加密写入）：
  `pnpm exec vitest run packages/api/test/knowledge-server-guard.test.ts --project backend`
  → 1 文件失败（1 failed | 2 passed / 3）；列表用例 `expected 500 to be 200`，响应体 `{"code":"INTERNAL_ERROR","status":500}`。两条删除保护用例仍通过。
- 绿（仅把 app config 改为 `testConfig()`）：
  同命令 → 1 文件通过，3 passed / 3。
- 组合回归：
  `pnpm exec vitest run packages/api/test/knowledge-server-guard.test.ts packages/api/test/sandbox-probe.test.ts --project backend --no-file-parallelism`
  → 2 文件通过，9 passed / 9，0 失败/跳过。
- `pnpm --filter @agentport/api typecheck`：退出 0（`tsc -b` 无输出）。
- `./node_modules/.bin/biome check packages/api/test/knowledge-server-guard.test.ts`：No fixes applied，退出 0；任务记录 `.md` 被 biome 配置忽略（`No files were processed`），符合仓库配置。
- `git diff --check`：退出 0。
- `git status --porcelain` 对本任务两文件：`M` 测试 + `??` 任务记录；既有 105 条未提交差异未触碰。
- 资源：backend globalSetup 每轮随机 PostgreSQL database + 独享临时 Redis；`afterAll` 按本次两个 fixture ID 删除，未按前缀批量清理，未改开发数据。
- 最终验收：主会话 `bvn` 运行该文件 3 passed / 0 skip；独立 Opus `a0b` 通过。最新全量 backend `bcx1la0wa` 中该文件仍失败（修复前状态），修复后未随全量重跑，不据此写全绿。
- 限制：历史日志没有原异常栈，且同一轮可能有其他 writer，不能唯一归因某个测试或某次写入；本任务只证明「缺 `APP_SECRET_KEY` 时列表在存在正常加密普通连接器的情况下 500，补齐后 200」。队列线由另一代理诊断，本次未重做其诊断、未改其文件。
