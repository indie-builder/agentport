# Web 聊天修复（刷新失败卸载 + 历史搜索 E2E）

## 目标

修复 web 交互审查确认的两个问题，并以真实行为验证，不扩大范围：

1. **专家列表后台刷新失败会卸载聊天工作区。** `ChatPage` 目前对 `agents.isError` 直接返回整页错误；TanStack Query 在已有缓存数据时后台刷新失败仍会置 `isError`，于是 `ChatWorkspace` 被卸载，其 cleanup 的 `resetConversation` 清掉未发送附件、草稿与当前会话/运行上下文。最小修复：只有首次没有数据时错误才替换主内容；已有缓存时保留同一工作区，并为真实刷新错误提供重试入口。
2. **两个会话历史 E2E 仍按旧 UI 写。** 历史侧栏默认折叠、搜索已是跨全部专家的浮层入口「搜索全部会话」；旧用例直接操作 `aside[aria-label="会话历史"]` 和侧栏 `searchbox`，并断言“只搜当前专家”，与 `DESIGN-SYSTEM.md` §6 冲突。改为先显式展开会话历史，再通过真实浮层验证跨专家标题/正文检索、清除、跳转与草稿保留；分页、切换、重命名断言保留。

验收标准：

- 新增真实 Query 行为测试先红后绿：选附件 + 草稿 + 已打开会话后让 `agents` 失效且刷新失败，断言工作区未卸载、内容/草稿/附件保留、出现真实错误与重试；重试成功后仍可继续输入。
- 两个 E2E 文件改为当前真实入口与跨专家搜索语义，不删原分页/切换/重命名断言凑绿。
- 运行所选 chat web 测试、web typecheck 与所改文件 biome，记录真实计数与 skip；E2E 在独立验收环境可用时才运行，否则如实报告缺口。

## 方案

- **刷新失败不卸载**：`ChatPage` 的整页替换条件从 `agents.isPending || agents.isError || agents.data.length === 0` 改为仅看「没有数据或数据为空」。有缓存数据时继续渲染 `ChatWorkspace`，把 `agents.isError` 的 error 与 `refetch` 通过现有 props 链传到 `ChatColumn`，用共享 `ErrorState`（含重试按钮）显示在现有错误区，不新增状态体系。
- **测试先行**：在 `packages/web/test/chat-ux.test.ts` 的 `confirmed chat UX defects` 中新增行为测试，复用现有真实 Router/QueryClient harness 与文件输入；不做实现细节断言。
- **E2E**：
  - `tests/chat-history-filter.e2e.ts` 改为先点「显示会话历史」，再点「搜索全部会话」打开真实浮层，验证跨专家标题与正文命中、无结果空态、清除后回到最近会话，以及选中跨专家结果后跳到目标专家/会话并保留原会话草稿（返回原会话时恢复）。
  - `tests/chat-history-pages.e2e.ts` 在依赖历史列表的切换与重命名用例中先显式展开会话历史；分页用例继续直接验证消息分页，不改断言。
  - fixture 标题/正文带唯一后缀，避免与其他数据或并行残留互相命中。
- **不触碰**：包依赖、配置、数据库、其他源码/测试与主任务记录；不提交。

## 基线与范围

- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-review-loop`
- 分支：`worktree-codebase-review-loop`
- 基线：`e060e3a`（`origin/main`，工作树 HEAD 一致）
- 开工时工作树已有其他作者的未提交差异（API/worker/shared/文档等），归属见 `docs/tasks/codebase-review-loop.md`；本任务不读取为自身改动，也不还原/提交它们。
- **本任务唯一允许改动的文件**：
  - `packages/web/src/pages/chat.tsx`
  - `packages/web/test/chat-ux.test.ts`（可另建 `chat-refetch` 行为测试文件，本次直接复用现有 harness）
  - `tests/chat-history-filter.e2e.ts`
  - `tests/chat-history-pages.e2e.ts`
  - `docs/tasks/codebase-review-web-chat.md`（本记录）
- 明确不改：其他源码/测试/配置/依赖/迁移、`docs/tasks/codebase-review-loop.md` 及其他作者记录。

## 当前有效决定

- 用户要求不派代理、不提交；主会话直接执行本任务。
- 问题 1 只做最小修复：首次无数据错误才整页替换；缓存存在保持同一 workspace，并给实际刷新错误与重试入口，不造新状态体系。
- 问题 2 以 `DESIGN-SYSTEM.md` §6 为准确认当前交互：历史默认折叠；搜索是跨全部专家的浮层「搜索全部会话」。旧 E2E *搜索*类断言按新语义重写；分页/切换/重命名行为与断言保留。
- E2E 必须使用独立验收环境；不得访问或修改共享开发库与用户登录。没有可安全隔离的现成环境时不运行并如实报告所缺，不为此新建框架。
- 草稿保留按现有「按会话隔离」语义验证：搜索跳转会切到目标会话自己的草稿，返回原会话时原草稿恢复；不在本任务改写该行为。

## 已替代项及原因

- 取代「`chat-history-filter.e2e.ts` 搜索只作用于当前专家」：现行 `DESIGN-SYSTEM.md` §6 明确搜索跨全部专家，旧断言与真实 UI 冲突；改为跨专家标题/正文、清除、跳转与草稿保留，不删除搜索行为的验证。

## 步骤

- [x] 读 `CLAUDE.md`、`docs/DEV-WORKFLOW.md`、`docs/PITFALLS.md`、`docs/DESIGN-SYSTEM.md`，加载 ub-mode / TanStack Query / Router / Vitest 技能。
- [x] 记录基线 `e060e3a`、现有差异归属与本任务独占文件范围。
- [x] 在 `chat-ux.test.ts` 写真实 Query 行为测试并确认按预期失败（工作区被卸载）。
- [x] 最小修复 `ChatPage` 条件与刷新错误重试入口，测试转绿。
- [x] 重写两个 E2E 的历史入口与跨专家搜索流程，保留原行为断言。
- [x] 跑所选 chat web 测试、web typecheck、所改文件 biome。
- [x] 更新本记录为待 Opus review，列出实际改动/结果/限制。

## 改动文件

- `packages/web/src/pages/chat.tsx`
- `packages/web/test/chat-ux.test.ts`
- `tests/chat-history-filter.e2e.ts`
- `tests/chat-history-pages.e2e.ts`
- `docs/tasks/codebase-review-web-chat.md`

## 下一步

- 待独立 Opus review；未返回结论前不标记已验收。
- E2E 已于 2026-10-29 在独立库/Redis/端口运行（8/9 通过），见下方「E2E（补充运行）」。
- 未授权 commit / push / merge，不执行。

## 验证

### 测试先行（红）

改动前新增用例后执行：

```
pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/chat-ux.test.ts -t "keeps the workspace, draft and attachments when refreshing experts fails"
```

真实结果：`1 failed | 39 skipped`。失败原因符合预期：`agents` 后台刷新失败后整页被错误态替换，DOM 只剩 `对话内容没有加载出来… 重试`，`old prompt` 已不在，工作区被卸载。

修复完成、测试转绿之后，又临时把旧 guard 放回、用最终版用例重跑一次确认红，再恢复修复；结果同上（`1 failed | 39 skipped`，同一行失败），证明最终用例确实覆盖该缺陷而不是跟随实现写成。

### 修复后（绿）

同一命令：`1 passed | 39 skipped`。

完整所选 chat web 测试：

```
pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/chat-
```

真实结果：`Test Files 17 passed (17)`，`Tests 275 passed (275)`，无 skip、无失败，Duration 7.68s（恢复修复后最终复跑）。

`pnpm --filter @agentport/web typecheck`（`tsc -b`）：exit 0，无输出；该包 tsconfig 只含 `src` 与 `vite.config.ts`，不含测试文件。

`pnpm exec biome check packages/web/src/pages/chat.tsx packages/web/test/chat-ux.test.ts tests/chat-history-filter.e2e.ts tests/chat-history-pages.e2e.ts`：`Checked 4 files ... No fixes applied`，0 error；首次检查仅 `chat-history-filter.e2e.ts` 格式不符，已 `biome format --write` 后复查通过。

### E2E（补充运行，2026-10-29）

在本 worktree 用 `.tmp/codebase-review-e2e/run.sh` 起了完全独立的运行时：随机 PostgreSQL 库 +
唯一临时 Redis 容器 + 随机 loopback 端口 API，前端用当前源码重建的 `packages/web/dist`，
只清理本次资源；未使用共享库、共享登录态或付费模型。完整命令与清理证明见
`docs/tasks/codebase-review-e2e.md`。

连续两轮（run4、run5）结果一致：`Test Files 1 failed | 2 passed (3)`，
`Tests 8 passed | 1 failed (9)`。通过包括 auth setup、filter 4 条与 pages 3 条；
唯一失败是 `chat history pages older messages without losing the visible position`
的滚动位置断言（`tests/chat-history-pages.e2e.ts:211`），该断言与产品逻辑本轮未改，
已连同 trace 交回独立诊断。

运行中修复的本任务测试缺陷：seed 参数 `$7::text` 等与事务回滚、Base UI 搜索框
`combobox` 定位、切换会话后重新展开历史、防抖窗口内的结果定位歧义。

### 未覆盖 / 限制

- E2E 仅剩上述滚动位置断言失败，其余 chat history 行为已在真实浏览器验证。
- `packages/web` 的 typecheck 不覆盖测试文件；新测试的实际证据来自 Vitest 运行。
- 源码修复只处理「已有缓存 + 刷新失败」；首次无数据失败仍整页错误，符合最小范围。
