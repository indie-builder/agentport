# 测试信号加固：假绿、跨文件串扰、lint 红灯

## 目标

来自 Owen Gretzinger《How I made our CI 20x faster》的对照结论，用户 2026-11-01 确认「按建议处理」。三项：

1. **消除假绿**：PostgreSQL / Redis 不可用时，依赖基础设施的套件会静默 skip，`pnpm test` 仍退出 0，代理会把不完整覆盖当成通过。要求：这种情况运行必须非零退出，并明确说明缺哪项。
2. **修复跨文件串扰**：全量并行时 `packages/api/test/personal-memory.test.ts`（3 例）与 `packages/worker/test/run-pending-finish.test.ts`（1 例）失败，单跑 15 例全过。先定根因，再做最小修复。
3. **lint 回到绿灯**：main 上 `pnpm lint`（`biome check .`）有 66 errors，手动 CI 第二步就会挂。修到 0 errors，不关规则、不改行为。

不在范围内：pre-push 钩子（`docs/DEV-WORKFLOW.md` §5 禁止 blocking 钩子）、CI 自动触发与 runner 迁移、产品侧 hooks 能力。

## 方案

- 假绿：在 backend globalSetup 的 teardown 中，若本轮拿不到隔离库/临时 Redis，则在清理完成后抛出带缺失项的错误，使退出码非零；保留「不回落共享库」和纯单元套件仍可跑的行为。
- 串扰：Opus 先定位（固定业务 ID / 共享计划内账户写入 / 登录会话等既有同类坑），再按根因最小修复并补针对性验证。
- lint：只修 66 个 error，安全修复优先；不批量重排无关文件。

## 基线与范围

- 起点：`origin/main` = `c775e2d12b2f8e6df573318aa79f174a985ca364`，worktree `.claude/worktrees/test-signal-hardening`。
- 初始未提交差异：无。
- 允许改动：`packages/worker/test/global-setup.ts`、测试辅助与相关测试文件、以及 lint 报错涉及的源码/测试文件。不改业务行为、不改 CI 触发方式、不加钩子。

## 当前有效决定

- 用户 2026-11-01：「按你的建议来给我处理」→ 执行上述三项，不含 pre-push 钩子、不含 CI runner/成本改造、不含产品 hooks 改动。
- 假绿修复方向：基础设施缺失时运行非零退出（而非仅 warn），跳过行为本身保留。

## 已替代项及原因

无。

## 步骤

- [x] 修 `pnpm lint` 的 66 errors（机械修复，Sonnet）。
- [x] 基础设施缺失时让运行非零退出，并实测缺失场景（Sonnet）。
- [x] 定位并修复全量并行串扰（Opus 定位 → 实施 → 复验）。
- [x] 全量验证：`pnpm typecheck`、`pnpm test`、`pnpm lint`。
- [x] 独立 Opus 终审：通过，无必须修项。

## 改动文件

- `biome.json`：新增 `!docs/**/*.json`、`!packages/core/src/generated/**` 两条产物类排除。
- 48 个源码/测试文件：`biome check --write` 的格式化与 import 排序，无语义变化。
- `packages/worker/test/global-setup.ts`：teardown 在缺 PostgreSQL/Redis 时抛错，退出非零。
- `packages/worker/test/fixtures/access.ts` + 9 个引用方：测试身份按文件派生，消除跨文件共享业务 ID。
- `packages/api/test/personal-memory.test.ts`：独立测试账号并按 businessId 限定读写，移除跨文件 advisory 锁。
- `packages/worker/test/run-runtime-identity.test.ts`、`packages/worker/test/memory-review.test.ts`：mock `startSessionCleanupChannel`，不再订阅默认关闭信道。
- `docs/PITFALLS.md`：新增「跨文件共享测试身份与信道」条目。

## 下一步

无。改动已在本任务 worktree 内验证完成，未提交（用户未授权 commit/push/merge）。

## 验证

- 基线：`pnpm typecheck` 3.2s；`pnpm lint` 0.4s / 66 errors / 380 warnings；`pnpm test` 145.37s，452 文件 5315 用例，2 文件 3 用例失败。
- 修复后：`pnpm lint` 退出 0（1031 文件，379 warnings）；`pnpm typecheck` 退出 0。
- 假绿：模拟 PostgreSQL+Redis 缺失，修复前 EXIT=0，修复后 EXIT=1 且报 `missing infrastructure (PostgreSQL, Redis); dependent suites were skipped, not passed`；只缺 Docker 时报 `(Redis)`；web-only 跑在 PG 不可用时仍 EXIT=0（不误伤）。
- 串扰：`--sequence.shuffle --sequence.seed=431` 下 worker 两文件、personal-memory+agents 各 12 轮均通过；worker 目录 83 文件 1096 用例通过；`seed=1106` 下 output-retention + worker 入口测试 10 轮通过且无 503。
- 全量（最终）：`pnpm test` 147.39s，452/452 文件、5315/5315 用例通过。
- 终审：独立 Opus 按固定 diff 审查，结论「通过，无必须修项」；非阻塞备注：`!docs/**/*.json` 排除略宽。
