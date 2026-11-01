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
- 用户本轮授权：在原 worktree 将 `origin/main`（`fa138c2`）合入已提交的 `91c0bf9`；保留双方踩坑条目与频道测试逻辑，夹具统一用 `testAccess(import.meta.url)`，完成合并提交及指定验证；不 push、不建 PR。续做起点工作区干净。

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

无。本轮合并（父提交 `91c0bf9`、`fa138c2`）已完成，独立 Opus 合并终审通过。提交后发现主线新增 `tests/channels-business.e2e.ts` 唯一格式错误，仅用 Biome 格式化并经独立 Opus 增量终审确认生成 JavaScript 完全一致；此机械修复和全部验证记录一并纳入合并提交。不 push、不建 PR。

## 验证

- 基线：`pnpm typecheck` 3.2s；`pnpm lint` 0.4s / 66 errors / 380 warnings；`pnpm test` 145.37s，452 文件 5315 用例，2 文件 3 用例失败。
- 修复后：`pnpm lint` 退出 0（1031 文件，379 warnings）；`pnpm typecheck` 退出 0。
- 假绿：模拟 PostgreSQL+Redis 缺失，修复前 EXIT=0，修复后 EXIT=1 且报 `missing infrastructure (PostgreSQL, Redis); dependent suites were skipped, not passed`；只缺 Docker 时报 `(Redis)`；web-only 跑在 PG 不可用时仍 EXIT=0（不误伤）。
- 串扰：`--sequence.shuffle --sequence.seed=431` 下 worker 两文件、personal-memory+agents 各 12 轮均通过；worker 目录 83 文件 1096 用例通过；`seed=1106` 下 output-retention + worker 入口测试 10 轮通过且无 503。
- 全量（最终）：`pnpm test` 147.39s，452/452 文件、5315/5315 用例通过。
- 终审：独立 Opus 按固定 diff 审查，结论「通过，无必须修项」；非阻塞备注：`!docs/**/*.json` 排除略宽。
- 本轮合并（2026-11-01）：仅 `docs/PITFALLS.md` 文本冲突，双方全部条目保留；两个 worker 测试自动合并保留全部频道测试，`message-persistence` 留工厂，`run-runtime-identity` 本地固定身份改为工厂。全仓 10 处夹具导入均为 `testAccess`，冲突标记扫描无输出。
- 锁文件：`git diff --stat HEAD~1 HEAD -- pnpm-lock.yaml` 无输出，因此未运行安装；所有 Git 操作均显式 `/usr/bin/git -C <本 worktree>`，未用 stash。
- 本轮 `pnpm typecheck`：退出 0，全部 7 个包 `Done`；格式化后复跑仍退出 0。
- 本轮 `pnpm lint`：首次 1 error / 379 warnings，唯一 error 为主线新增 `tests/channels-business.e2e.ts` 格式；最小格式化后退出 0，`Checked 1059 files in 465ms. No fixes applied. Found 379 warnings.` 未改业务逻辑或削弱测试。
- 本轮 `pnpm test`：退出 0，`Test Files 463 passed (463)`，`Tests 5486 passed (5486)`，`Duration 141.47s`；主线频道测试加入后文件数高于原 452。
- 本轮指定三文件：`pnpm exec vitest run packages/worker/test/message-persistence.test.ts packages/worker/test/run-runtime-identity.test.ts packages/worker/test/run-pending-finish.test.ts` 退出 0，3 文件 74 用例通过，9.75s。每轮 globalSetup 独立 PG/Redis，可并行运行。
- 本轮独立 Opus 合并终审及格式化增量终审均通过，无必须修项。完整原始输出位于 `/tmp/agentport-test-signal-hardening-{typecheck,lint,full,targeted}.log`。
