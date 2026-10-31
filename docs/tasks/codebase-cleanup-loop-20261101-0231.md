# core 本地 slug 正则统一到 shared `slugSchema`

## 目标

把 `packages/core/src/outputs.ts` 与 `packages/core/src/attachments.ts` 各自维护的本地 `slugPattern` 删除，统一复用 `@agentport/shared` 的 `slugSchema`，使 core 的 slug 规则（1–64 字符、首字符小写字母或数字、后续小写字母/数字/`_`/`-`）与 shared 契约一致，并拒绝旧实现漏掉的 65 字符合法序列。

## 方案

- 两个源文件从 `@agentport/shared` 导入 `slugSchema`，删除本地 `slugPattern`。
- `outputs.ts` 的 `conversationSegments` 与 `attachments.ts` 的 `conversationSegments` / `removeConversationInputs` 改用 `slugSchema.safeParse(...).success` 判定。
- 不新增 helper、不导出内部校验函数、不改 shared、不改调用方。
- 保留现有公开导出、签名、错误码、错误文案、`path`、`retryable`。

## 基线

- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-cleanup-loop-20261101-0231`
- 分支：`worktree-codebase-cleanup-loop-20261101-0231`
- 基线提交：`origin/main` `6877b06`

## 当前有效决定

- 本轮用户任务明确：先红后绿，测试复用现有文件，不新增测试文件；不 commit、不 push。
- slug 唯一来源为 shared `slugSchema`；core 不再保留第二份正则。
- 错误仍为 `AppError`：`INVALID_INPUT`、400、`retryable: false`、`path: '/slug'`、文案「智能体目录名非法」，不泄露 Zod 默认错误。
- `removeConversationInputs` 对非法 slug 静默返回；`removeConversationOutputs` 继续抛错。

## 步骤

1. 在 `packages/core/test/outputs.test.ts` 增加 3 条会失败的 65 字符 slug 用例（prepare / read / remove）及改前就应绿的边界用例。
2. 在 `packages/core/test/attachments.test.ts` 增加 3 条会失败的 65 字符 slug 用例（write / read / remove）及改前就应绿的边界用例。
3. 运行定向测试，确认 6 条失败且原因均为「旧实现接受长 slug」。
4. 修改 `packages/core/src/outputs.ts` 与 `packages/core/src/attachments.ts`，复用 `slugSchema`。
5. 重新运行定向测试与 `pnpm --filter @agentport/core typecheck`，并跑 biome 格式检查。

## 改动文件

- `packages/core/src/outputs.ts`
- `packages/core/src/attachments.ts`
- `packages/core/test/outputs.test.ts`
- `packages/core/test/attachments.test.ts`
- `docs/tasks/codebase-cleanup-loop-20261101-0231.md`

## 下一步

- 用户审阅后决定是否提交；本任务未 commit、未 push。

## 验证

### 红灯（改实现前）

命令：

```bash
pnpm exec vitest run --project backend packages/core/test/outputs.test.ts packages/core/test/attachments.test.ts
```

结果摘要：`Test Files 2 failed (2)`，`Tests 6 failed | 60 passed (66)`。6 条失败均为旧实现接受 65 字符 slug：

- `attachments > slug validation > rejects a 65-character slug when writing and creates nothing` — `promise resolved "[ { …(5) } ]" instead of rejecting`
- `attachments > slug validation > rejects a 65-character slug when reading existing attachments` — `promise resolved "{ data: Buffer[ 120 ], …(2) }" instead of rejecting`
- `attachments > slug validation > keeps the directory when removing with a 65-character slug` — 旧实现静默删除目录后 `ENOENT ... sentinel.txt`
- `outputs > slug validation > rejects a 65-character slug when preparing a draft and creates nothing` — `promise resolved "'/var/folders/.../aaaa.../conversation-outputs/conv_1/drafts/run_1'" instead of rejecting`
- `outputs > slug validation > rejects a 65-character slug when reading an existing snapshot` — `promise resolved "{ file: { runId: 'run_1', …(8) }, …(1) }" instead of rejecting`
- `outputs > slug validation > rejects a 65-character slug when removing and keeps the directory` — `promise resolved "undefined" instead of rejecting`

失败均来自行为断言，不是 fixture、模块解析或基础设施错误。

### 绿灯（改实现后）

同一命令：

```text
Test Files  2 passed (2)
Tests  66 passed (66)
```

类型检查：

```bash
pnpm --filter @agentport/core typecheck
```

结果：`tsc -b` 成功，无输出。

格式检查：

```bash
pnpm exec biome check packages/core/src/outputs.ts packages/core/src/attachments.ts packages/core/test/outputs.test.ts packages/core/test/attachments.test.ts
```

结果：`Checked 4 files`，退出码 0。

### 全仓验证（主会话执行）

- `pnpm typecheck`：全仓 7 包全部 Done。
- `pnpm build`：全仓构建成功，仅既有 >500 kB chunk 警告。
- `pnpm test`：5244 项通过、16 项跳过、0 项失败；唯一套件级失败为本地 `agentport/sandbox:dev` 镜像缺 GNU bash 的既存环境问题。并行运行时偶发文件级失败，单跑 JSON 报告为 0 失败。
- `pnpm test:web`：148 文件、1841 项通过。
- 独立 Opus 终审：通过，无阻塞项。
