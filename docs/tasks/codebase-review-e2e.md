# 两份 chat-history E2E 的隔离环境真实验证与测试缺陷修复

## 目标

在完全隔离的运行时里真实执行 `tests/chat-history-filter.e2e.ts` 与
`tests/chat-history-pages.e2e.ts`，修复已确认属于 E2E 自身的 fixture/定位/步骤缺陷，
给出真实用例计数、失败原因与资源清理证明。

本任务只改两个测试文件、本记录与 `docs/tasks/codebase-review-web-chat.md`；
不改产品源码/配置，不降低产品行为断言，不为凑绿修改「加载更早消息」的滚动断言。

## 运行源

- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-review-loop`
- 分支：`worktree-codebase-review-loop`
- HEAD：`e060e3a559633a0d94adb637516a6d577b86b1aa`
- 前端运行产物：2026-10-29 21:01:56 用当前源码重建的 `packages/web/dist`
  （先重建 `shared`/`core`/`db`，再 `pnpm --filter @agentport/web build`）
- 凭据：运行时从根 `.env` 仅装入进程环境，未打印、未复制、未改写

## 隔离方案

- 随机 PostgreSQL 库：`createIsolatedDatabase('e2e_chat_history', <共享 PG 作为 admin>)`，自动迁移，只用共享 PG 建库，不写共享开发库
- 唯一临时 Redis 容器：复用 `packages/worker/test/global-setup.ts` 的 `startRedisContainer()`，镜像 `redis:8.10.3-alpine@sha256:896f24…a7b`，loopback 随机端口
- 独立 API：随机空闲 loopback 端口，`DATABASE_URL` / `REDIS_URL` / 认证配置全部走子进程环境；`WEB_DIST` 指向本次构建
- 未启动/未停止共享 worker，未改 compose，未改主 `.env`，未删他人容器或数据库

实际命令（由 `.tmp/codebase-review-e2e/run.sh` 编排）：

```bash
pnpm exec e2e run tests/support/auth.e2e.ts tests/chat-history-filter.e2e.ts \
  tests/chat-history-pages.e2e.ts \
  --output .e2e/codebase-review-e2e --reporter list
```

`E2E_APP_URL=http://127.0.0.1:<随机端口>`；`e2e.config.ts` 因此不启动本地 vite。
这两个文件没有 agent step，未调用付费模型。

## 本次修复（仅测试文件）

1. **filter seed 参数类型**：消息插入的 `jsonb_build_object(..., 'text', $7)` 无法推断
   裸参数类型；改为 `$7::text`（同理 `$8`、`$9`）。
2. **seed 失败回滚**：三条 insert 包进 `begin` / `commit`，失败时 `rollback` 后抛出。
   原来 agent/conversation 先落库、消息失败时调用方还拿不到 fixture，`cleanup` 不会执行；
   现在半成品不落库。`cleanup` 保持原实现，仅在 seed 成功后由调用方执行。
3. **搜索输入框定位**：真实 `@base-ui/react` 1.9.0 的 `Autocomplete.Input`
   由 `combobox/root/AriaCombobox.js` 显式设置 `reference.role = 'combobox'`
   （不是 `searchbox`）；文件内全部会话搜索定位统一为
   `getByRole('combobox', '搜索会话')`。
4. **pages 切换会话后历史折叠**：切换会话会重载工作区并收起历史面板，原用例第二次
   点历史行前没有重新展开。现在每次需要历史列表时显式点「显示会话历史」，
   原切换与消息隔离断言全部保留。
5. **filter 第 4 条新暴露的定位歧义**：输入标题后 300ms 防抖期间浮层仍展示最近会话，
   `getByText(专家名)` 会同时命中 A 的两条结果。改为先等 `option` 收敛到唯一命中，
   再把专家名断言限定在该结果行，随后仍断言跨专家跳转到 A 的会话；没有降低行为断言。

## 结果

| 轮次 | 运行源 | Test Files | Tests |
|---|---|---|---|
| 历史 run1 | 20:20 旧 dist | 2 failed / 1 passed (3) | 6 failed / 3 passed (9) |
| 历史 run2 | 20:55 重建 dist | 2 failed / 1 passed (3) | 6 failed / 3 passed (9) |
| run3（修复 1–4 后） | 21:01 当前源码重建 dist | 2 failed / 1 passed (3) | 7 passed / 2 failed (9) |
| run4（含修复 5） | 同上 | 1 failed / 2 passed (3) | **8 passed / 1 failed (9)** |
| run5（复跑确认） | 同上 | 1 failed / 2 passed (3) | **8 passed / 1 failed (9)** |

run3 明细：filter 3/4 通过（第 4 条在防抖窗口出现新的定位歧义，见修复 5）；
pages 3/4 通过；另一条失败为下述已知滚动失败。

run4、run5 两轮一致，9 条含 1 条登录 setup。通过：

- `tests/support/auth.e2e.ts` 登录 setup
- filter 4 条：跨专家标题/正文检索与清除、无结果空态、跨专家跳转保留草稿、
  切换专家后搜索仍跨全部专家
- `chat history pagination works at a 390px viewport`
- `switching conversations in the history panel drops the old messages`
- `renaming the open conversation keeps the loaded history and pages older ones`

`tests/chat-replay.e2e.ts` 未被 positional 选中，提示 skip，与本任务无关。

## 未修：pages older messages 滚动位置

```text
ASSERTION_FAILED: expect.poll(...).toBe(...) timed out after 10000 ms
加载更早消息后视口跳到了底部
tests/chat-history-pages.e2e.ts:211
```

- 滚轮到顶（`scrollTop < 100`）通过，点击「加载更早消息」后接口 200、025–074 已加载，
  随后 10 秒内始终不满足 `scrollTop < 100 && distanceFromBottom > 700`；失败截图显示
  视口停在最底部。
- 该断言与产品滚动逻辑本轮未改动；run3/run4/run5 均在当前源码重建的生产构建下稳定复现，
  排除构建过期。属于产品「补旧消息时保持滚动位置」缺陷或断言前提问题，
  按任务要求保持原样，交 Opus 诊断后处理。

## 资源清理证明

run4、run5 的 `.tmp/codebase-review-e2e/logs/run{4,5}/cleanup-proof.txt` 均记录：

```text
removed redis container backend_test_redis_691660a4f3d54151
dropped database e2e_chat_history_ec76e0b4fa7d4bd4
database remaining rows: 0
redis container remaining lines: 0
...
removed redis container backend_test_redis_43e7709879ff46d9
dropped database e2e_chat_history_e77d0e0be4ec4d90
database remaining rows: 0
redis container remaining lines: 0
```

独立复核（运行结束后）：

- `docker ps -a` 无本次三个 `backend_test_redis_*` 容器
- `pg_database` 查询 `database remaining rows: 0`
- 本 worktree 无残留 `tsx src/index.ts`、`e2e run` 进程

## 保留证据

- 运行日志与清理证明：`.tmp/codebase-review-e2e/logs/`（`prior-run/`、`run3/`、`run4/`、`run5/`）
- 历史两轮报告/trace：`.tmp/codebase-review-e2e/run2-evidence/`、`run1/`
- 本轮 trace/截图：`.tmp/codebase-review-e2e/run3-partial/`、`run4/`、`run5/`；
  最新一份同时在 `.e2e/codebase-review-e2e/`
- 报告快照：`.tmp/codebase-review-e2e/report-run4.json`、`report-run5.json`
- 本任务脚本：`.tmp/codebase-review-e2e/run.sh`、`run.ts`（`.tmp/` 被 gitignore，不含明文密钥）

## 局限与待 review

- 前端按任务要求用已构建静态资源由 API 托管（生产构建），未用 vite dev。
- 仅剩 1 条滚动位置断言失败，该断言与产品逻辑未改，等待独立诊断。
- 测试文件的 5 处修改待独立 review；未授权 commit / push / merge。
