# codebase-review：修复 agent-md 测试的陈旧完整对象预期

## 目标
`packages/core/test/agent-md.test.ts` 在整个文件运行时唯一失败的是首条用例：完整对象 `toEqual` 预期缺少 `runtimeEnvironmentId`。修复后完整文件全绿，且保留原测试目标（完整字段集合断言），不用 `toMatchObject` 放宽以掩盖额外字段。

## 方案
在测试的 `defaults` 预期对象中按 `agentInputSchema` 字段顺序补上 `runtimeEnvironmentId: null`，保持 `toEqual` 完整对象比较。不改源码、不改 schema、不改其他配置。

## 基线与范围
- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-review-loop`（分支 `worktree-codebase-review-loop`），HEAD `e060e3a559633a0d94adb637516a6d577b86b1aa`（merge PR #114）。
- 开工时本 worktree 已存在大量其他任务的未提交差异（含 `packages/shared/src/agent.ts` 删除可选 `maxThinkingTokens`）；这些差异非本任务产生，未触碰。
- 本任务允许改动：`packages/core/test/agent-md.test.ts`、本记录。
- 未授权 commit/push；代码由 Sonnet 子代理实际执行，主会话只做验证与记录，不是主会话直接改。

## 当前有效决定
- 只修测试陈旧预期，不动源码；若证据显示是真实回归则停止并报告。
- 不为此跑全仓 build / SDK 镜像。
- 修复后交独立 Opus review（a134 通过）。

## 已替代项及原因
无。

## 步骤
- [x] 完整运行 `packages/core/test/agent-md.test.ts`，确认真实失败内容。
- [x] 用 `git show e060e3a` 核对基线 `packages/core/src/agent-md.ts` 与 `packages/shared/src/agent.ts`，判定是陈旧预期还是回归。
- [x] 最小补全预期对象。
- [x] 重跑完整文件、biome、diff 空白检查。

## 改动文件
- `packages/core/test/agent-md.test.ts`：`defaults` 增加 `runtimeEnvironmentId: null`（1 行）。
- `docs/tasks/codebase-review-agent-md-test.md`：本记录。

## 下一步
已验收：主会话 `bg64` 12 tests 通过，独立 Opus a134 通过；未提交。

## 验证

### 红（修改前，完整文件）
`pnpm exec vitest run packages/core/test/agent-md.test.ts`：`Test Files 1 failed (1)`，`Tests 1 failed | 11 passed (12)`。唯一失败：

```text
FAIL |backend| packages/core/test/agent-md.test.ts > parseAgentMd > parses an agent file, keeps the whole body and fills safe defaults
AssertionError: expected { agent: { …(20) }, …(1) } to deeply equal { agent: { …(19) }, …(1) }
+     "runtimeEnvironmentId": null,
```

### 基线证据（证明为陈旧预期，非回归）
- `git show e060e3a:packages/shared/src/agent.ts` 中 `agentInputSchema` 已含
  `runtimeEnvironmentId: z.string().nullable().default(null)`；`parseAgentMd` 通过该 schema 解析并返回 `parsed.data`，因此结果必然带该默认字段。
- `git show e060e3a:packages/core/src/agent-md.ts` 与当前工作区文件一致（本任务未改 core 源码）。
- `git log -S'runtimeEnvironmentId' -- packages/shared/src/agent.ts` 指向 `3ab2556`（feat: 恢复智能体 Bash 并支持运行环境版本发布回退与专家绑定）；`git show 3ab2556 -- packages/core/test/agent-md.test.ts packages/core/src/agent-md.ts` 无输出，即该提交新增字段时未同步本测试的完整对象预期，属遗漏的陈旧预期。
- 当前未提交的 `packages/shared/src/agent.ts` 差异只删除可选 `maxThinkingTokens`，不涉及 `runtimeEnvironmentId`，不影响本失败原因。

### 绿（修改后，完整文件）
`pnpm exec vitest run packages/core/test/agent-md.test.ts`：

```text
Test Files  1 passed (1)
Tests  12 passed (12)
```

### 机械检查
- `pnpm exec biome check packages/core/test/agent-md.test.ts` → `exit=0`，`Checked 1 file in 5ms. No fixes applied.`
- `git diff --check -- packages/core/test/agent-md.test.ts` → `exit=0`，无空白问题。

### 独立验收
- 主会话 `bg64` 真实重跑 12 tests 通过。
- 独立 Opus a134 review 通过。
- 代码由 Sonnet 子代理执行，记录已更正此前「主会话直接改」的误述。
