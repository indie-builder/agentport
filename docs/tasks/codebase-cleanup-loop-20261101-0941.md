# 收敛 4 处重复 `hasCode` 到 shared `hasErrorCode`

## 目标
`packages/core` 与 `packages/api` 共 4 个文件各自定义了一份逐字相同的 `hasCode`，收敛到 `packages/shared/src/errors.ts`（经 barrel 导出），消除重复；所有调用点的判断逻辑、错误处理分支与调用顺序保持不变。

## 方案
- `packages/shared/src/errors.ts` 新增并导出 `hasErrorCode(error: unknown, code: string): boolean`，函数体逐字照搬删除前的 `hasCode`。
- 4 个调用方删除本地 `hasCode`，从 `@agentport/shared` 引入 `hasErrorCode`，仅替换函数名。
- `packages/shared/test/errors.test.ts` 增加 `describe('hasErrorCode')`，覆盖 6 类真实输入（Error 且 code 匹配 / code 不匹配 / 非 Error 的带 code 对象 / 无 code 的 Error / 字符串 / null 与 undefined），不 mock。

## 基线与范围
- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-cleanup-loop-20261101-0941`，分支 `worktree-codebase-cleanup-loop-20261101-0941`，基线 `origin/main` `5d3d37a`；开工时工作区干净。
- 允许改动：4 个调用方源码文件、`packages/shared/src/errors.ts`、`packages/shared/test/errors.test.ts`、本任务记录。
- 不在本任务：`isPgCode`、connector 网络辅助、其它重复项，以及 `outputs.ts` 中两处未命名为 `hasCode` 的内联同体判断。

## 步骤
- [x] 读根 `CLAUDE.md`、`packages/shared|core|api/CLAUDE.md`、`docs/PITFALLS.md`
- [x] 用 `git grep` 确认基线 4 处定义及其全部调用点
- [x] shared 增加并导出 `hasErrorCode`
- [x] 4 个文件删除本地定义、补 import、替换调用
- [x] shared 新增 `hasErrorCode` 单元测试
- [x] `grep` 复验、构建 dist、typecheck、受影响套件、`git diff --check`、Biome

## 改动文件
- `packages/shared/src/errors.ts`：新增 `hasErrorCode` 导出 1 处（定义在第 20 行）
- `packages/shared/test/errors.test.ts`：新增 `describe('hasErrorCode')`（第 29 行起），6 个用例
- `packages/core/src/attachments.ts`：删除本地定义 1 处，改调用 7 处
- `packages/core/src/outputs.ts`：删除本地定义 1 处，改调用 12 处；Biome 格式化把 1 处调用拆成两行
- `packages/api/src/features/agents/memory-files.ts`：删除本地定义 1 处，改调用 8 处
- `packages/api/src/features/memory/journal.ts`：删除本地定义 1 处，改调用 3 处
- `docs/tasks/codebase-cleanup-loop-20261101-0941.md`：本记录

加总：4 个调用方源码文件 + 1 个 shared 源码文件 + 1 个测试文件，共 6 个文件；删除 4 处本地定义，改 30 处调用；另新增 1 个任务记录文件。

## 跳过项与未覆盖范围
- 跳过 `packages/core/src/outputs.ts:363` 与 `packages/core/src/outputs.ts:560` 两处内联表达式 `error instanceof Error && 'code' in error && error.code === 'NOT_FOUND'`：它们未命名为 `hasCode`，属任务明确排除的「其它重复项」，本轮不改。
- 跳过 `isPgCode`、connector 网络辅助以及其它包/文件中的同类重复，均不在任务范围。
- 未覆盖：除上述 6 个文件外的任何文件；未改动错误码、错误处理分支、调用顺序或运行行为。

## 验证
改前基线（真实命令与输出，共 34 行 = 4 处定义 + 30 处调用）：
`/usr/bin/git grep -n "hasCode" HEAD -- packages`

```
HEAD:packages/api/src/features/agents/memory-files.ts:27:function hasCode(error: unknown, code: string): boolean {
HEAD:packages/api/src/features/agents/memory-files.ts:61:          if (!hasCode(error, 'EEXIST')) throw error;
HEAD:packages/api/src/features/agents/memory-files.ts:78:    if (hasCode(error, 'ELOOP')) invalidLink();
HEAD:packages/api/src/features/agents/memory-files.ts:124:    if (hasCode(error, 'ENOENT')) return null;
HEAD:packages/api/src/features/agents/memory-files.ts:147:    if (hasCode(error, 'ENOENT')) return { files: [], initialized: false };
HEAD:packages/api/src/features/agents/memory-files.ts:185:    if (hasCode(error, 'ENOENT')) return null;
HEAD:packages/api/src/features/agents/memory-files.ts:186:    if (hasCode(error, 'ELOOP')) invalidLink();
HEAD:packages/api/src/features/agents/memory-files.ts:244:        if (!hasCode(cleanupError, 'ENOENT')) {
HEAD:packages/api/src/features/agents/memory-files.ts:287:    if (hasCode(error, 'ENOENT')) return false;
HEAD:packages/api/src/features/memory/journal.ts:59:function hasCode(error: unknown, code: string): boolean {
HEAD:packages/api/src/features/memory/journal.ts:115:    if (hasCode(error, 'ENOENT')) return [];
HEAD:packages/api/src/features/memory/journal.ts:171:        if (!hasCode(error, 'ENOENT')) throw error;
HEAD:packages/api/src/features/memory/journal.ts:175:    if (!hasCode(error, 'ENOENT')) throw error;
HEAD:packages/core/src/attachments.ts:62:function hasCode(error: unknown, code: string): boolean {
HEAD:packages/core/src/attachments.ts:225:    if (hasCode(error, 'ENOENT')) {
HEAD:packages/core/src/attachments.ts:234:      if (hasCode(error, 'ENOENT')) return null;
HEAD:packages/core/src/attachments.ts:255:    if (hasCode(error, 'ENOENT')) return null;
HEAD:packages/core/src/attachments.ts:263:      if (hasCode(error, 'ENOENT')) return null;
HEAD:packages/core/src/attachments.ts:268:      if (hasCode(error, 'ENOENT')) return null;
HEAD:packages/core/src/attachments.ts:373:    if (hasCode(error, 'ENOENT')) {
HEAD:packages/core/src/attachments.ts:413:    if (hasCode(error, 'ENOENT')) {
HEAD:packages/core/src/outputs.ts:125:    if (hasCode(error, 'ENOENT'))
HEAD:packages/core/src/outputs.ts:133:      if (hasCode(error, 'ENOENT')) return null;
HEAD:packages/core/src/outputs.ts:152:function hasCode(error: unknown, code: string): boolean {
HEAD:packages/core/src/outputs.ts:197:    if (hasCode(error, 'ENOENT')) return null;
HEAD:packages/core/src/outputs.ts:221:    if (hasCode(error, 'ENOENT')) return [];
HEAD:packages/core/src/outputs.ts:263:    if (hasCode(error, 'ENOENT')) fail('NOT_FOUND', '产出文件不存在', { path: `/${path}` });
HEAD:packages/core/src/outputs.ts:349:      if (hasCode(error, 'ENOENT')) return null;
HEAD:packages/core/src/outputs.ts:395:    if (hasCode(error, 'ENOENT')) return null;
HEAD:packages/core/src/outputs.ts:469:    if (hasCode(error, 'ENOENT')) fail('NOT_FOUND', '产出挂载目录不存在', { path: '/sourceDir' });
HEAD:packages/core/src/outputs.ts:489:      if (hasCode(error, 'ENOENT')) return null;
HEAD:packages/core/src/outputs.ts:532:    if (hasCode(error, 'ENOENT')) return null;
HEAD:packages/core/src/outputs.ts:547:    if (hasCode(error, 'ENOENT')) return null;
HEAD:packages/core/src/outputs.ts:770:      if (hasCode(error, 'ENOENT')) return null;
```

同一命令的计数（真实输出）：`34`

改后复验（真实命令；第一条无输出，表示本地定义与旧名调用已清零）：
`grep -rn "hasCode(" packages --include='*.ts'`

```
（无输出）
```

`grep -c 'hasErrorCode(' <每个文件>`（真实输出）：

```
packages/core/src/outputs.ts: 12
packages/core/src/attachments.ts: 7
packages/api/src/features/agents/memory-files.ts: 8
packages/api/src/features/memory/journal.ts: 3
```

4 个文件调用点合计（真实输出）：`30`

新增定义与测试位置（真实输出）：

```
20:export function hasErrorCode(error: unknown, code: string): boolean {
29:describe('hasErrorCode', () => {
```

`git diff --stat`（真实输出）：

```
 packages/api/src/features/agents/memory-files.ts | 21 +++++++---------
 packages/api/src/features/memory/journal.ts      | 12 +++------
 packages/core/src/attachments.ts                 | 19 ++++++---------
 packages/core/src/outputs.ts                     | 30 +++++++++++------------
 packages/shared/src/errors.ts                    |  5 ++++
 packages/shared/test/errors.test.ts              | 31 +++++++++++++++++++++++-
 6 files changed, 70 insertions(+), 48 deletions(-)
```

逐字等价证据：`packages/shared/src/errors.ts` 新增函数体为 `return error instanceof Error && 'code' in error && error.code === code;`，与基线 4 处本地定义的函数体逐字相同（仅外层函数名从 `hasCode` 改为 `hasErrorCode`，参数名保持 `error` / `code`）。`git diff` 中每个调用点只替换函数名并补 import，未改变任何条件分支、`return` 值、`throw`、`invalidLink()` 或调用顺序；唯一非替换变化是 Biome 因函数名变长把 `outputs.ts` 的 1 处单行调用拆成两行（纯空白格式，语义不变）。

红测试不适用理由：这是提取/搬移型重构，改动前后求值结果完全相同，无法构造「改前红、改后绿」的诚实测试；因此按任务要求在 shared 为新导出的单一实现补充真实输入单元测试，并用 4 个调用方现有套件覆盖失败路径回归。覆盖边界如实说明：调用方用例多数不直接断言错误分类内部实现，只保证相关失败路径能走通；判断本身由 `hasErrorCode` 的单一实现与新增单元测试保证。

命令与真实结果：
- 新 worktree 无 workspace `dist`，按 `docs/PITFALLS.md` 先构建：`pnpm --filter @agentport/shared --filter @agentport/core --filter @agentport/db build` → 3 次 `$ tsc -b`，`exit=0`。
- `pnpm --filter @agentport/shared --filter @agentport/core --filter @agentport/api typecheck` → 3 次 `$ tsc -b`，`exit=0`。
- `pnpm exec vitest run --project backend packages/shared/test/errors.test.ts` → `Test Files  1 passed (1)`、`Tests  11 passed (11)`，`exit=0`。
- `pnpm exec vitest run --project backend packages/core/test/attachments.test.ts packages/core/test/outputs.test.ts packages/api/test/memory-files.test.ts packages/api/test/memory-changes.test.ts packages/api/test/memory-reviews.test.ts` → `Test Files  5 passed (5)`、`Tests  170 passed (170)`，`exit=0`（日志中的 `injected database commit failure` 为该套件主动注入失败的预期输出）。
- `git diff --check` → 无输出，`exit=0`。
- `./node_modules/.bin/biome check packages/shared/src/errors.ts packages/shared/test/errors.test.ts packages/core/src/attachments.ts packages/core/src/outputs.ts packages/api/src/features/agents/memory-files.ts packages/api/src/features/memory/journal.ts` → `Checked 6 files in 9ms. No fixes applied.`，`exit=0`。
