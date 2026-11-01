# worker 第二批收敛内联错误文本到 shared `errorText`

## 目标
把 `packages/worker/src` 下 7 个文件里的 12 处内联错误文本表达式替换为 shared 已导出的 `errorText`（`packages/shared/src/errors.ts`，经 barrel 导出），消除逐字重复；不改变错误码、日志文案、截断长度、脱敏顺序或控制流。

## 方案
- 只替换「恰好等于 `X instanceof Error ? X.message : String(X)`」的表达式（变量名可变）：改为 `errorText(X)`。
- 每个文件按现有 import 风格从 `@agentport/shared` 引入 `errorText`；原本已有 shared import 的合并进同一组，由 Biome `organizeImports` 排序。
- 外层截断（`.slice(0, 500)` / `.slice(0, 300)`）、`redactSecrets`、URL 脱敏、错误分类与日志调用全部留在调用点，顺序不变。
- `sandbox/sessions.ts` 的私有同名函数 `errorText` 删除，改用 shared 版本（函数体逐字相同）。
- 不新增测试：等价的搬移型重构，行为前后完全一致，写不出「改前红、改后绿」的诚实测试；已有套件覆盖这些失败路径，作为回归证据。

## 基线与范围
- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-cleanup-loop-20261101-0820`，分支 `worktree-codebase-cleanup-loop-20261101-0820`，基线 `origin/main` `05382ca`；开工时工作区干净。
- 允许改动：下列 7 个源码文件 + 本任务记录。
- 不在本任务：`knowledge/parsing.ts`、sandbox 的 `runner.ts` / `memory-permissions.ts`、`runtime-environments/`、其它包、`isPgCode` / `hasCode` / connector 网络辅助。

## 当前有效决定
- 任务给出的预期是 12 处（`index.ts` 4 处），`rg` 实际在 `index.ts` 找到 5 处精确同形表达式；按「只替换精确同形」的规则全部替换，多出的 1 处是本轮 `rg` 计数与任务描述的偏差，不是范围扩大。
- `index.ts:958` 的 `err instanceof RunFailure || err instanceof Error ? err.message : String(err)` 带类型分支，**跳过**，保持原样。
- `sandbox/sessions.ts:90` 的 `err instanceof Error ? err : new Error(String(err))`（`toError`）不是文本表达式，跳过。
- 变量名不统一改名：`cleanupError` / `cause` / `err` 原样传入 `errorText`。

## 步骤
- [x] 读根 `CLAUDE.md`、`packages/worker/CLAUDE.md`、`docs/PITFALLS.md`
- [x] `rg` 确认目标行号与表达式形态，区分精确同形与复合/其它分支
- [x] 7 个文件补/合并 `errorText` import
- [x] 12 处表达式替换（回退的第 13 处 `DbError(cause)` 不计入）；删除 `sessions.ts` 私有 `errorText`
- [x] `rg` 复验、typecheck、相关 13 个测试文件、`git diff --check`、Biome

## 改动文件
- `packages/worker/src/index.ts`（5 处：`cleanupError` ×2、`outputSettlementError`、`messageSaveError`、发布失败 `message`）
- `packages/worker/src/reconcile.ts`（1 处：cleanup 的 `err`；`withDb` 的 `cause` 已按终审回退）
- `packages/worker/src/knowledge/image-processing.ts`（2 处：解码失败与动作失败警告）
- `packages/worker/src/knowledge/ingestion.ts`（1 处：`describeKnowledgeError`）
- `packages/worker/src/knowledge/wiki.ts`（1 处：`toolError(...)` 参数）
- `packages/worker/src/sandbox/sessions.ts`（1 处：删除私有 `errorText`，改用 shared）
- `packages/worker/src/memory-review.ts`（1 处：终态错误文本）
- `docs/tasks/codebase-cleanup-loop-20261101-0820.md`（本记录）

## 下一步
- 未覆盖（本轮明确跳过或不在范围）：
  - `index.ts:959`：`err instanceof RunFailure || err instanceof Error ? ...`（类型分支，非精确同形）
  - `sandbox/sessions.ts:90`：`toError`（不是文本表达式）
  - `knowledge/parsing.ts:389/448/1119`：固定文案兜底与模板拼接（非精确同形）；`parsing.ts:1247` 是精确同形表达式，因文件不在本批范围而跳过
  - `runtime-environments/build.ts:302`、`runtime-environments/verify.ts:274`：不在本批目标文件
  - `eval-runner.ts:42`：其它形态（`name` 三元），非文本表达式；`eval-runner.ts:72` 是 `Error || DbError` 复合文本分支、`:78` 为其调用点，同样跳过
  - `knowledge/source-dingtalk.ts:454`：返回 Error，非文本表达式
  - `reconcile.ts` 的 `DbError(cause)` 构造已按终审要求回退，未纳入本批
- 其它包与 connector 网络辅助按后续批次处理。

## 验证
改前 `rg -n "instanceof Error \? .*\.message : String\(" packages/worker/src` → 20 行；其中 13 行位于本批 7 个目标文件：

```
index.ts:982/1002/1039/1080/1134   reconcile.ts:24/243
image-processing.ts:45/178         ingestion.ts:205
wiki.ts:375                        sandbox/sessions.ts:89
memory-review.ts:438
（另有 index.ts:958 为 RunFailure 复合分支，跳过）
```

改后同一命令 → 8 行：7 行为本批明确排除的项（`index.ts:959` 复合分支、`parsing.ts:389/448/1119/1247`、`runtime-environments/build.ts:302`、`runtime-environments/verify.ts:274`），另 1 行为终审要求回退的 `reconcile.ts:24` `DbError(cause)` 构造；除已回退的该行外，7 个目标文件内精确同形表达式为 0。

逐字等价证据：`packages/shared/src/errors.ts` 的 `errorText` 函数体为 `return err instanceof Error ? err.message : String(err);`，与被替换的子表达式逐字相同；`git diff` 中每个调用点只改函数名/函数调用，`DbError(..., cause)` 的第二参数、`.slice(...)`、`redactSecrets`、错误分类与日志文案均未改动。`sessions.ts` 删除的私有函数体与 shared 版本逐字相同。

红测试不适用理由：搬移型重构，改动前后行为完全相同，无法构造诚实的失败测试；用现有套件覆盖这些失败路径回归。覆盖边界如实说明：这些用例多数不直接断言错误文本内容，只覆盖失败路径能走通；错误文本本身由 `errorText` 的单一实现保证。

命令与真实结果：
- `pnpm --filter @agentport/worker typecheck` → `$ tsc -b`，无错误输出，`exit=0`。
- `pnpm exec vitest run --project backend` 指定 13 个套件（`reconcile-queue`、`reconcile-queue-redis`、`reconcile-eval`、`reconcile-eval-redis`、`reconcile-shutdown`、`session-sandboxes`、`memory-review`、`knowledge-wiki`、`knowledge-wiki-update`、`knowledge-ingestion`、`knowledge-image-processing`、`outputs`、`message-persistence`）→ 13 个文件全部 `passed`，`numTotalTests 235`、`numPassedTests 235`、`numFailedTests 0`、`numPendingTests 0`（运行器文本解析失败，结果取自 `.vitest/json/output.json`；生成物已还原，不进提交）。
- `git diff --check` → 无输出，`exit=0`。
- `./node_modules/.bin/biome check <7 个改动文件>` → `Checked 7 files`、`Found 1 warning`、`exit=0`；唯一 warning 是 `ingestion.ts:1811` 的既有 `noConfusingVoidType`，该行不在本次 diff 内。
