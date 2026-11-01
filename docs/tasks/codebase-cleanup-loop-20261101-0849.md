# 第三批收敛内联错误文本到 shared `errorText`

## 目标
把 `worker` / `sandbox` / `core` 共 7 个文件里的 8 处独立错误文本表达式替换为 shared 已导出的 `errorText`（`packages/shared/src/errors.ts`，经 barrel 导出），消除逐字重复；不改变错误码、日志文案、截断长度、脱敏顺序或控制流。

## 方案
- 只替换「恰好等于 `X instanceof Error ? X.message : String(X)`」且结果直接作为函数参数、变量赋值或对象字段值的表达式（变量名可变）：改为 `errorText(X)`。
- 每个文件按现有 import 风格从 `@agentport/shared` 引入 `errorText`；原本已有 shared import 的合并进同一组。
  - `build.ts`、`runner.ts`、`probe.ts`、`openui-response.ts`：合并进已有 `@agentport/shared` 值导入。
  - `parsing.ts`：原 `import type { KnowledgeAudioMetadata }` 合并为 `import { errorText, type KnowledgeAudioMetadata }`。
  - `verify.ts`、`plugin-display.ts`：新增 `import { errorText } from '@agentport/shared'`（core 与 sandbox 均已依赖 shared；shared barrel 已被 web 使用，浏览器可达的 `plugin-display` 子路径不引入 Node 内建）。
- 外层 `failure(...)`、`KnowledgeParseError` 构造、`.slice()`、`redactSecrets`、日志文案、错误分类与 `finally` 清理保持原样。
- 不新增测试：搬移型等价重构，行为前后完全一致，写不出「改前红、改后绿」的诚实测试；已有套件覆盖这些失败路径，作为回归证据。

## 基线与范围
- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-cleanup-loop-20261101-0849`，分支 `worktree-codebase-cleanup-loop-20261101-0849`，基线 `origin/main` `bded79d`；开工时工作区干净。
- 允许改动：下列 7 个源码文件 + 本任务记录。
- 不在本任务：其它表达式形态（模板字符串内嵌、固定字符串兜底、`.slice()`、复合分支、`DbError` 构造）、其它包与文件。

## 当前有效决定
- `parsing.ts:1247` 位于 `KnowledgeParseError` 构造参数中，属于独立表达式而非 `DbError` 构造，按任务清单纳入。
- 严格按硬性规则跳过下列已知形态，不顺手扩大范围。
- 顺带仅有的格式变化：`parsing.ts:1245` 的 `KnowledgeParseError` 调用在参数缩短后由 Biome 规整为单行，语义不变。

## 步骤
- [x] 读根 `CLAUDE.md`、`docs/PITFALLS.md`、`packages/worker|sandbox|core/CLAUDE.md`
- [x] `git grep` 确认基线 17 行与表达式形态，区分精确同形与跳过项
- [x] 7 个文件补/合并 `errorText` import
- [x] 8 处表达式替换
- [x] `rg` 复验、typecheck、相关 7 个测试文件、`git diff --check`、Biome

## 改动文件
- `packages/worker/src/runtime-environments/build.ts`（1 处：`executeRuntimeEnvironmentBuild` 的 `catch (err)` 传入 `failure(log, ...)`）
- `packages/worker/src/runtime-environments/verify.ts`（1 处：`verifyRuntimeEnvironmentImage` 的 `catch (err)` 结果字段 `error`）
- `packages/worker/src/knowledge/parsing.ts`（1 处：图片解码失败的 `KnowledgeParseError('invalid_input', ...)` 参数）
- `packages/sandbox/src/runner.ts`（2 处：`session fork failed` 与 `query failed` 的 `const message`）
- `packages/sandbox/src/probe.ts`（1 处：`probe failed` 的 `const message`）
- `packages/core/src/plugin-display.ts`（1 处：`frontmatter 无法读取` 的 `const message`）
- `packages/core/src/openui-response.ts`（1 处：`merge-failed` 诊断的 `message` 字段）
- `docs/tasks/codebase-cleanup-loop-20261101-0849.md`（本记录）

加总：7 个源码文件，8 处替换；另 1 个任务记录文件。

## 下一步
本轮明确跳过、未覆盖的项（全部按硬性规则第 2 条保留原样）：
- 模板字符串内嵌：`sandbox/src/memory-permissions.ts:53/65`、`sandbox/src/questions.ts:114`、`sandbox/src/session-supervisor.ts:646`、`worker/src/knowledge/parsing.ts:389/448/1119`
- 复合分支：`worker/src/index.ts:959`（`err instanceof RunFailure || ...`）
- `DbError` 构造：`worker/src/reconcile.ts:24`
以上 9 行是改后 `rg` 的全部剩余命中，均为应跳过项；其中 3 处位于目标文件 `worker/src/knowledge/parsing.ts:389/448/1119`（模板内嵌），其余在目标文件之外。目标文件内符合本轮条件的独立表达式已清零。

## 验证
改前基线（对 `HEAD` 执行，真实输出 17 行）：
`/usr/bin/git grep -n "instanceof Error ? .*\.message : String(" HEAD -- packages/worker/src packages/sandbox/src packages/core/src`

```
HEAD:packages/core/src/openui-response.ts:107
HEAD:packages/core/src/plugin-display.ts:75
HEAD:packages/sandbox/src/memory-permissions.ts:53
HEAD:packages/sandbox/src/memory-permissions.ts:65
HEAD:packages/sandbox/src/probe.ts:94
HEAD:packages/sandbox/src/questions.ts:114
HEAD:packages/sandbox/src/runner.ts:395
HEAD:packages/sandbox/src/runner.ts:690
HEAD:packages/sandbox/src/session-supervisor.ts:646
HEAD:packages/worker/src/index.ts:959
HEAD:packages/worker/src/knowledge/parsing.ts:389
HEAD:packages/worker/src/knowledge/parsing.ts:448
HEAD:packages/worker/src/knowledge/parsing.ts:1119
HEAD:packages/worker/src/knowledge/parsing.ts:1247
HEAD:packages/worker/src/reconcile.ts:24
HEAD:packages/worker/src/runtime-environments/build.ts:302
HEAD:packages/worker/src/runtime-environments/verify.ts:274
```

改后同一模式（真实输出 9 行，全部为跳过项）：
`rg -n "instanceof Error \? .*\.message : String\(" packages/worker/src packages/sandbox/src packages/core/src`

```
packages/sandbox/src/memory-permissions.ts:53
packages/sandbox/src/memory-permissions.ts:65
packages/worker/src/index.ts:959
packages/sandbox/src/questions.ts:114
packages/sandbox/src/session-supervisor.ts:646
packages/worker/src/reconcile.ts:24
packages/worker/src/knowledge/parsing.ts:389
packages/worker/src/knowledge/parsing.ts:448
packages/worker/src/knowledge/parsing.ts:1119
```

改后 8 个调用点（真实输出）：
`rg -n "errorText\(" packages/worker/src/runtime-environments/build.ts packages/worker/src/runtime-environments/verify.ts packages/worker/src/knowledge/parsing.ts packages/sandbox/src/runner.ts packages/sandbox/src/probe.ts packages/core/src/plugin-display.ts packages/core/src/openui-response.ts`

```
packages/worker/src/runtime-environments/build.ts:303
packages/worker/src/runtime-environments/verify.ts:275
packages/worker/src/knowledge/parsing.ts:1245
packages/sandbox/src/runner.ts:396
packages/sandbox/src/runner.ts:691
packages/sandbox/src/probe.ts:95
packages/core/src/plugin-display.ts:76
packages/core/src/openui-response.ts:107
```

逐字等价证据：`packages/shared/src/errors.ts` 的 `errorText` 函数体为 `return err instanceof Error ? err.message : String(err);`，与被替换的每个子表达式逐字相同（仅变量名不同）。`git diff` 中每个调用点只把该子表达式换成 `errorText(X)` 并补 import；外层 `failure(...)` 其余参数、`KnowledgeParseError` 第一个参数、`.slice(...)`、`redactSecrets`、日志文案、错误分类与 `finally` 清理均未改动。

红测试不适用理由：搬移型重构，改动前后求得的值完全相同，无法构造诚实的「改前红、改后绿」测试；因此用现有套件覆盖这些失败路径回归。覆盖边界如实说明：这些用例多数不直接断言错误文本内容，只保证失败路径能走通；错误文本本身由 `errorText` 的单一实现保证。

命令与真实结果：
- `pnpm --filter @agentport/worker --filter @agentport/sandbox --filter @agentport/core typecheck` → 三个包均 `Done`，无错误输出，`exit=0`。
- `pnpm exec vitest run --project backend packages/worker/test/runtime-environment-build.test.ts packages/worker/test/runtime-environment-verify.test.ts packages/worker/test/knowledge-parsing.test.ts packages/sandbox/test/runner.test.ts packages/sandbox/test/probe.test.ts packages/core/test/plugin-display.test.ts packages/core/test/openui-response.test.ts` → `Test Files 7 passed (7)`、`Tests 146 passed (146)`。
- `git diff --check` → 无输出，`exit=0`。
- `./node_modules/.bin/biome check <7 个文件>` → `Checked 7 files in 36ms. No fixes applied.`，`exit=0`。
