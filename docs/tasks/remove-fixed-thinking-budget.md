# 移除固定思考预算（maxThinkingTokens）

## 目标

全链路删除 `maxThinkingTokens` / `max_thinking_tokens`：智能体表单不再展示该控件，创建/更新/复制/版本快照回滚/专家包父子/沙箱任务/runner 选项/Web 缓存 diff 都不再出现该字段；推理深度只保留官方 `effort`。

验收：旧客户端带数字或 null 的请求/包/任务被明确拒绝 400，且不写库、不产生新版本；effort 语义（创建省略、PATCH 省略保留、null 清除）不变；Web 改名保存与重载后 effort 仍正确。

## 方案

- 官方依据：`code.claude.com/docs/en/model-config#extended-thinking` 与已安装 SDK 类型核对结论——Sonnet 5.5 等当前模型始终 adaptive，CLI 忽略数字 `maxThinkingTokens`；故删除虚假数值上限，只保留 `effort`（不新增 thinking 开关、不映射 adaptive、不保留旧模型分支或兼容层）。
- 共享 `agentInputSchema` 不整体 strict（会影响响应投影）；只在 API `createSchema` / `patchSchema` 上 strict，旧字段明确 400。
- 专家包侧车根/子 schema 本就 `.strict()`，删字段后旧包自动 400。
- `sandboxTaskSchema` 闭合为 `.strict()`，runner 不再接收旧任务字段。
- DB 删除列；生成迁移内一次性从 `agent_versions.snapshot` JSONB 删除废 key（旧版本接口直接返回 raw snapshot，避免露废字段），不做运行时兼容或回填。
- 既有历史迁移不改。

## 基线与范围

- 起点：worktree `codebase-review-loop`，HEAD `e060e3a`（merge PR #114）。
- 开工时既有未提交差异归属他人/其他并行任务：`packages/shared/src/agent.ts`、`packages/api/src/features/agent-package.ts` 及若干包/测试、docs 主记录；本任务只做增量删除，不还原任何旧修复。`packages/web/src/pages/chat.tsx`、knowledge/skills 面、历史 E2E、docs 主记录均不改。
- 允许改动：`packages/shared/src/{agent.ts,agent-package.ts,chat.ts}`、`packages/db/src/{schema.ts,repo/agents.ts}` 与本次生成迁移、`packages/api/src/features/agents/routes.ts`、`packages/api/src/features/agent-package.ts`、`packages/worker/src/index.ts`、`packages/sandbox/src/runner.ts`、`packages/web/src/{pages/agents.tsx,lib/queries.ts}`、上述域测试/fixtures、`tests/agent-defaults.e2e.ts`、本记录。

## 当前有效决定

- 删除字段，不保留 deprecated 别名、数字/null 兼容、旧模型分支。
- effort 保持创建省略、PATCH 省略保留、null 清除；RHF 默认/reset 显式 `effort` 键保留。
- 旧请求/包/任务字段一律 400/解析失败，避免剥离后假成功。
- 不为每个机械移除新增测试；保留原有效能力（effort 保存/重载、运行时环境绑定、导出往返），原借预算制造表单脏状态的测试改用 `maxTurns`。
- worker shutdown 注释「排空 10s」与实际先 abort 不符，本任务独占 `packages/worker/src/index.ts`，顺带改准确一行，行为不变。

## 已替代项及原因

- 旧设计「maxThinkingTokens 数字上限」被替代：当前模型 adaptive，CLI 忽略数字，UI 数值是虚假能力。

## 步骤

- [x] 先写红测试：POST/PATCH 旧字段数字/null 400 且无写无版本；包父子旧字段 400 无落库；sandbox task 旧字段拒绝且不调 SDK；runner 传 effort、不传 thinking。
- [x] 共享 schema/DB/repo/API/worker/sandbox/web 删除字段。
- [x] `pnpm db:generate`，审查 SQL/snapshot/journal，补 JSONB 废 key 清理。
- [x] 本次随机库显式 DATABASE_URL 跑 `pnpm db:migrate`。
- [x] 按改动范围跑测试、typecheck、build、biome；隔离 E2E `tests/agent-defaults.e2e.ts` 已真实通过。
- [x] 更新本记录与文档同步清单，交独立 Opus review（a06 通过）。

## 改动文件

- `packages/shared/src/agent.ts`、`agent-package.ts`、`chat.ts`
- `packages/db/src/schema.ts`、`repo/agents.ts`、`migrations/0042_curious_pet_avengers.sql`、`meta/{_journal.json,0042_snapshot.json}`
- `packages/api/src/features/agents/routes.ts`、`features/agent-package.ts`
- `packages/worker/src/index.ts`、`packages/sandbox/src/runner.ts`
- `packages/web/src/pages/agents.tsx`、`lib/queries.ts`
- 测试与 fixtures：`packages/api/test/{agent-defaults,agents,package-fixtures,agent-package-zip,subagent-export,agent-package-v2-validation}.test.ts|ts`、`packages/db/test/runtime-environments.test.ts`、`packages/sandbox/test/runner.test.ts`、`packages/web/test/agents-ui.test.ts`、`tests/agent-defaults.e2e.ts`
- 本地未跟踪的隔离运行脚本 `.tmp/codebase-review-e2e/{run.sh,run.ts}`（接受位置参数）与 `.tmp/remove-thinking-migrate/run.mjs`，不随分支交付。

## 下一步

- 已验收：独立 Opus a06 通过；主会话 `bjge` 真实 9 files / 168 passed / 0 skipped，`bgh` agentsUI 41 passed；迁移只在临时库执行；`agent-defaults` E2E auth 1 + 3 由 review 核对原输出通过。
- 产品文档同步已完成（2026-10-29），但本次新增文档改动尚未独立 review，不据此宣称全任务通过。
- `docs/UI-REDESIGN.md` 已在 `docs/README.md` 标为历史评审，其旧表述不作为当前契约，不重写历史；HANDOFF / CHANGELOG / DECISIONS 快照与主任务记录不改。
- 可选踩坑（交文档作者决定是否记入 `docs/PITFALLS.md`）：前端元素级测试不挂载真实 DOM，RHF 的 `valueAsNumber` 从 ref 读值；数字字段的 onChange 假事件要直接给 number，给字符串会被 zod 拒绝并让提交静默不发请求。

## 验证

红（实现前，`pnpm exec vitest run --project backend packages/api/test/agent-defaults.test.ts packages/api/test/agent-package-v2-validation.test.ts packages/sandbox/test/runner.test.ts`）：`3 failed files, 4 failed | 74 passed`，失败点分别是旧字段被接受（POST 201/PATCH 200）、包根/子旧字段导入成功、runner 未拒绝旧任务字段；失败原因与预期一致。

绿（实现后）：
- `pnpm exec vitest run --project backend <上述 9 个相关套件>`：9 files / 168 tests passed（含 agents、agent-defaults、包 zip/v2/subagent、db runtime-environments、shared sandbox-session、sandbox runner、worker run-runtime-identity）。
- `pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/agents-ui.test.ts`：41 passed。
- 全后端 `pnpm exec vitest run --project backend`：`2 failed files | 236 passed`，`1 failed | 2285 passed | 10 skipped`。两个失败均与本次字段无关：`packages/core/test/agent-md.test.ts` 期望缺 `runtimeEnvironmentId`（基线 `agent.ts` 已带该字段、core 未改动，属基线既有失败）；`packages/worker/test/session-sandbox-sdk.test.ts` 因 `agentport/sandbox:dev` 镜像缺 GNU bash 在用例前抛错（10 个用例跳过）。
- 全 Web `pnpm exec vitest run --config packages/web/vitest.config.ts`：115 files / 1277 passed。
- `pnpm --filter <shared|core|db|api|sandbox|worker|web> typecheck`：全部通过。
- `pnpm -r --workspace-concurrency=1 build`：通过（仅既有 chunk 体积提示）。
- Biome 改动文件检查：21 files，0 errors，6 warnings（全部是 `agent-package-v2-validation.test.ts` 既有 `noNonNullAssertion` 行）。
- 迁移（随机库，`.tmp/remove-thinking-migrate/run.mjs`，真实执行 `pnpm db:migrate`）：`created isolated database remove_thinking_0aba5dba594e` → `migrations applied` → `column removed; snapshot={"effort":"high"}` → `drizzle migrations applied: 43` → `dropped isolated database remove_thinking_0aba5dba594e`。证明 0042 删列与 JSONB 废 key 一次性清理都生效，且只删本次随机库。
- E2E（`.tmp/codebase-review-e2e/run.sh tests/agent-defaults.e2e.ts`，随机库 + 独享 Redis 容器 + 随机端口）：`tests/support/auth.e2e.ts` 1 + `tests/agent-defaults.e2e.ts` 3 全部通过；清理证明 `dropped database e2e_chat_history_b9d437d3709b49ea`、`database remaining rows: 0`、`removed redis container backend_test_redis_ea89ab3fc1674f81`、`redis container remaining lines: 0`。
