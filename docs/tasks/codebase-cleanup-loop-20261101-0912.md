# 第四批收敛模板字符串内嵌错误文本到 shared `errorText`（含 1 处 MCP 错误字段）

## 目标
把 `sandbox` / `worker` / `api` 共 5 个文件里的 8 处错误文本表达式替换为 shared 已导出的 `errorText`（7 处模板字符串插值 + 1 处 MCP 错误字段值）（`packages/shared/src/errors.ts`，经 barrel 导出），消除逐字重复；模板前缀文案、换行、标点、外层结构、错误码、日志格式与控制流保持不变。

## 方案
- 替换「恰好等于 `X instanceof Error ? X.message : String(X)`」的表达式（变量名可变）：7 处位于模板字符串插值中，1 处（`agent-tools.ts`）作为 MCP 错误字段值；统一改为 `errorText(X)`。
- 每个文件按现有 import 风格从 `@agentport/shared` 引入 `errorText`：
  - `memory-permissions.ts`、`questions.ts`、`session-supervisor.ts`：合并进已有 `@agentport/shared` 值导入，由 Biome 规整顺序。
  - `parsing.ts`：已有 `import { errorText, type KnowledgeAudioMetadata }`，无需新增 import。
  - `agent-tools.ts`：新增 `import { errorText } from '@agentport/shared';`。
- 不新增测试：搬移型等价重构，行为前后完全一致，写不出「改前红、改后绿」的诚实测试；已有套件覆盖这些失败路径，作为回归证据。

## 基线与范围
- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-cleanup-loop-20261101-0912`，分支 `worktree-codebase-cleanup-loop-20261101-0912`，基线 `origin/main` `b47c5f5`；开工时工作区干净。
- 允许改动：下列 5 个源码文件 + 本任务记录。
- 不在本任务：复合分支、`DbError` 构造、固定字符串兜底、`.slice()`、其它包与文件。

## 步骤
- [x] 读根 `CLAUDE.md`、`docs/PITFALLS.md`、`packages/sandbox|worker|api/CLAUDE.md`
- [x] `rg` 确认基线 10 行与表达式形态，区分 8 处目标与 2 处跳过项
- [x] 5 个文件补/合并 `errorText` import
- [x] 8 处表达式替换
- [x] `rg` 复验、typecheck、受影响 9 个测试文件、`git diff --check`、Biome

## 改动文件
- `packages/sandbox/src/memory-permissions.ts`（2 处：`个人记忆读取失败：` 的 lstat 与 readFile 失败分支）
- `packages/sandbox/src/questions.ts`（1 处：`stdin command read failed` 日志）
- `packages/sandbox/src/session-supervisor.ts`（1 处：入口 `catch` 的 `[supervisor]` stderr 写入）
- `packages/worker/src/knowledge/parsing.ts`（3 处：`CSV 解析失败`、`JSON 解析失败`、`请求 Docling 失败`）
- `packages/api/src/features/servers/agent-tools.ts`（1 处：MCP 工具错误 `content[0].text` 对象字段值）
- `docs/tasks/codebase-cleanup-loop-20261101-0912.md`（本记录）

加总：5 个源码文件，8 处替换；另 1 个任务记录文件。

## 跳过项与未覆盖范围
以下按硬性规则保留原样：
- 复合分支：`packages/worker/src/index.ts:959`（`err instanceof RunFailure || err instanceof Error ? ...`）
- `DbError` 构造：`packages/worker/src/reconcile.ts:24`
- 固定字符串兜底与 `.slice()` 未触碰。
- 未覆盖：其它包/文件、行内变量赋值形态（上一批已处理）、固定文案兜底与 `.slice()` 形态；均不在本轮任务范围。

## 验证
改前基线（改动前执行，真实输出 10 行：8 处目标 + 2 处跳过项）：
`rg -n "instanceof Error \? .*\.message : String\(" packages/sandbox/src packages/worker/src packages/api/src`

```
packages/sandbox/src/memory-permissions.ts:53:      return fail(`个人记忆读取失败：${error instanceof Error ? error.message : String(error)}`);
packages/sandbox/src/memory-permissions.ts:65:      return fail(`个人记忆读取失败：${error instanceof Error ? error.message : String(error)}`);
packages/worker/src/index.ts:959:        const error = err instanceof RunFailure || err instanceof Error ? err.message : String(err);
packages/sandbox/src/questions.ts:114:        log(`stdin command read failed: ${err instanceof Error ? err.message : String(err)}`);
packages/sandbox/src/session-supervisor.ts:646:        `[supervisor] ${error instanceof Error ? error.message : String(error)}\n`,
packages/api/src/features/servers/agent-tools.ts:69:            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
packages/worker/src/reconcile.ts:24:    catch: (cause) => new DbError(cause instanceof Error ? cause.message : String(cause), cause),
packages/worker/src/knowledge/parsing.ts:389:      `CSV 解析失败: ${error instanceof Error ? error.message : String(error)}`,
packages/worker/src/knowledge/parsing.ts:448:      `JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`,
packages/worker/src/knowledge/parsing.ts:1119:      `请求 Docling 失败: ${error instanceof Error ? error.message : String(error)}`,
```

改后同一模式（真实输出 2 行，全部为跳过项）：
`rg -n "instanceof Error \? .*\.message : String\(" packages/sandbox/src packages/worker/src packages/api/src`

```
packages/worker/src/index.ts:959:        const error = err instanceof RunFailure || err instanceof Error ? err.message : String(err);
packages/worker/src/reconcile.ts:24:    catch: (cause) => new DbError(cause instanceof Error ? cause.message : String(cause), cause),
```

改后 5 个目标文件的 `errorText(` 调用（真实输出 9 行；其中 `parsing.ts:1236` 为上一批已存在的调用，本轮新增 8 行）：
`rg -n "errorText\(" packages/sandbox/src/memory-permissions.ts packages/sandbox/src/questions.ts packages/sandbox/src/session-supervisor.ts packages/worker/src/knowledge/parsing.ts packages/api/src/features/servers/agent-tools.ts`

```
packages/api/src/features/servers/agent-tools.ts:70:            content: [{ type: 'text', text: errorText(err) }],
packages/worker/src/knowledge/parsing.ts:387:    throw new KnowledgeParseError('invalid_input', `CSV 解析失败: ${errorText(error)}`);
packages/worker/src/knowledge/parsing.ts:443:    throw new KnowledgeParseError('invalid_input', `JSON 解析失败: ${errorText(error)}`);
packages/worker/src/knowledge/parsing.ts:1111:    throw new KnowledgeParseError('upstream_http', `请求 Docling 失败: ${errorText(error)}`);
packages/worker/src/knowledge/parsing.ts:1236:        throw new KnowledgeParseError('invalid_input', errorText(err));
packages/sandbox/src/session-supervisor.ts:646:      process.stderr.write(`[supervisor] ${errorText(error)}\n`);
packages/sandbox/src/memory-permissions.ts:54:      return fail(`个人记忆读取失败：${errorText(error)}`);
packages/sandbox/src/memory-permissions.ts:66:      return fail(`个人记忆读取失败：${errorText(error)}`);
packages/sandbox/src/questions.ts:115:        log(`stdin command read failed: ${errorText(err)}`);
```

逐字等价证据：`packages/shared/src/errors.ts` 的 `errorText` 函数体为 `return err instanceof Error ? err.message : String(err);`，与被替换的每个子表达式逐字相同（仅变量名不同）。`git diff` 中每个调用点只把该子表达式换成 `errorText(X)` 并补 import；模板字符串前缀文案、换行与标点、错误码与失败分类、日志目标均未改动。Biome 仅把 3 处 `KnowledgeParseError(...)` 与 1 处 `process.stderr.write(...)` 因参数缩短后自动收敛为单行（纯空白格式变化，语义不变），与上一批处理一致。

红测试不适用理由：搬移型重构，改动前后求得的值完全相同，无法构造诚实的「改前红、改后绿」测试；因此用现有套件覆盖这些失败路径回归。覆盖边界如实说明：这些用例多数不直接断言错误文本内容，只保证失败路径能走通；错误文本本身由 `errorText` 的单一实现保证。

命令与真实结果：
- `pnpm --filter @agentport/sandbox --filter @agentport/worker --filter @agentport/api typecheck` → `packages/sandbox typecheck: Done`、`packages/worker typecheck: Done`、`packages/api typecheck: Done`，`exit=0`。
- `pnpm --filter @agentport/shared --filter @agentport/core --filter @agentport/db build` → `tsc -b` 三次，`exit=0`（新 worktree 无 dist，按 `docs/PITFALLS.md` 先构建）。
- `rtk bypass pnpm exec vitest run --project backend packages/sandbox/test/memory-permissions.test.ts packages/sandbox/test/questions.test.ts packages/sandbox/test/session-supervisor.test.ts packages/worker/test/knowledge-parsing.test.ts packages/worker/test/knowledge-parsing-adapter.test.ts packages/api/test/agent-tools-cancel.test.ts packages/api/test/agent-tools-cancel-http.test.ts packages/api/test/agent-tools-cancel-signal.test.ts packages/api/test/agent-invoker-lifecycle.test.ts` → `Test Files  9 passed (9)`、`Tests  183 passed (183)`，`exit=0`。
- `git diff --check` → 无输出，`exit=0`。
- `./node_modules/.bin/biome check <5 个改动文件>` → `Checked 5 files in 19ms. No fixes applied.`，`exit=0`。
- 说明：首次跑测试时 RTK 的 vitest 解析失败并写入了被跟踪的 `.vitest/json/output.json`，已用 `/usr/bin/git checkout HEAD -- .vitest/json/output.json` 还原，未纳入改动。
