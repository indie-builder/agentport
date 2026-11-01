# worker 知识来源模块收敛内联错误文本到 shared `errorText`

## 目标
把 `packages/worker/src/knowledge/` 下 8 个来源文件的 10 处内联错误文本表达式替换为 shared 已导出的 `errorText`（上一轮加入 `packages/shared/src/errors.ts` 并经 barrel 导出），消除同名私有表达式；不改变任何错误码、日志文案、截断长度、脱敏顺序或控制流。

## 方案
- 每处 `err instanceof Error ? err.message : String(err)` 改为 `errorText(err)`：
  - 8 处 `message: (err instanceof Error ? err.message : String(err)).slice(0, 500)` → `message: errorText(err).slice(0, 500)`，外层截断原样保留。
  - 2 处 `const message = err instanceof Error ? err.message : String(err);` → `const message = errorText(err);`，变量名与后续 `redactUrls` / URL 脱敏逻辑不动。
- `errorText` 只做「Error 取 `message`，其余 `String()`」，与原先内联表达式逐字等价；`slice` 不搬进辅助函数。
- 8 个文件此前都未引入 `@agentport/shared`，各新增一行 `import { errorText } from '@agentport/shared';`，按仓库既有顺序（`node:` 之后、其它外部包之前、相对导入之前）。

## 基线与范围
- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-cleanup-loop-20261101-0755`，分支 `worktree-codebase-cleanup-loop-20261101-0755`，基线 `origin/main` `1cd1205`；开工时工作区干净。
- 允许改动：下列 8 个源码文件 + 本任务记录。
- 不在本任务：`parsing.ts`（固定字符串兜底与模板拼接，语义不同）；`wiki.ts`、`ingestion.ts`、`image-processing.ts`（本轮范围外，留给后续）；其它包；`isPgCode` / `hasCode` / connector 网络辅助。

## 当前有效决定
- 截断、脱敏、错误码全部留在调用点，`errorText` 只负责取文本；顺序不变。
- 10 处变量名均为 `err`，无需改名分支。
- 不新增测试：这是等价的搬移型重构，行为前后一致；已有来源套件覆盖这些失败路径，用于回归。

## 步骤
- [x] 读根 `CLAUDE.md`、`packages/worker/CLAUDE.md`、`docs/PITFALLS.md`
- [x] `rg` 重新确认目标行号（与任务给的一致）
- [x] 8 个文件补 `errorText` import
- [x] 10 处表达式替换
- [x] `rg` 复验、typecheck、8 个来源测试套件、`git diff --check`、biome

## 改动文件
- `packages/worker/src/knowledge/sources.ts`（1 处）
- `packages/worker/src/knowledge/source-notion.ts`（1 处）
- `packages/worker/src/knowledge/source-ima.ts`（2 处：`failureOf` + `sanitizeDownloadError`）
- `packages/worker/src/knowledge/source-dingtalk.ts`（2 处：`failureOf` + `sanitizeDownloadError`）
- `packages/worker/src/knowledge/source-yuque.ts`（1 处）
- `packages/worker/src/knowledge/source-confluence.ts`（1 处）
- `packages/worker/src/knowledge/source-seafile.ts`（1 处）
- `packages/worker/src/knowledge/source-nextcloud.ts`（1 处）
- `docs/tasks/codebase-cleanup-loop-20261101-0755.md`（本记录）

## 下一步
- 未覆盖（同一 `packages/worker/src/knowledge/` 目录内仍有 8 处精确同形表达式）：
  - `parsing.ts:389/448/1119/1247`（固定文案兜底与模板拼接，需单独判断）
  - `wiki.ts:375`（`toolError(...)` 包装）
  - `ingestion.ts:205`、`image-processing.ts:45/178`（范围外，后续按模块收敛）
- 其它包与 connector 网络辅助按后续批次处理。

## 验证
改前 `rg -n "instanceof Error \? .*\.message : String\(" packages/worker/src/knowledge/` → 18 行，其中 10 行在本次 8 个目标文件中：

```
source-confluence.ts:411  source-dingtalk.ts:209/392  source-ima.ts:295/376
source-nextcloud.ts:202   source-notion.ts:344       source-seafile.ts:178
source-yuque.ts:121       sources.ts:124
```

改后同一命令 → 8 行，全部是明确排除的文件（`ingestion.ts:205`、`parsing.ts:389/448/1119/1247`、`image-processing.ts:45/178`、`wiki.ts:375`）；8 个目标文件内为 0（`exit=1` 无匹配）。

逐字等价证据：`packages/shared/src/errors.ts` 的 `errorText` 函数体为 `return err instanceof Error ? err.message : String(err);`，与被替换的子表达式逐字相同；`git diff` 中每个调用点只改函数名，`code` / `retryable` / `.slice(0, 500)` / `redactUrls` / URL 正则脱敏均未改动，import 只新增一行。

红测试为何不适用：搬移型重构，改动前后行为完全相同，写不出「改前红、改后绿」的诚实测试；已有 8 个来源套件覆盖 `failureOf` 失败路径作为等价回归。覆盖边界如实说明：IMA 现有脱敏断言针对 API 错误，未直接断言 `sanitizeDownloadError` 下载失败分支；钉钉过期下载用例断言失败分类，未断言签名 query 被移除。这两处是既有覆盖缺口，本轮未扩大也未补齐。

命令与真实结果：
- `pnpm --filter @agentport/worker typecheck` → `$ tsc -b`，无错误输出，`exit=0`。
- `pnpm exec vitest run --project backend packages/worker/test/knowledge-sources.test.ts packages/worker/test/knowledge-source-{notion,ima,dingtalk,yuque,confluence,nextcloud,seafile}.test.ts` → 8 个测试文件全部 `passed`，`numFailedTests 0`，共 193 个用例通过（运行器文本解析失败，结果取自 `.vitest/json/output.json`；生成物已还原，不进提交）。
- `git diff --check` → 无输出，`exit=0`。
- `./node_modules/.bin/biome check <8 个改动文件>` → `Checked 8 files in 28ms. No fixes applied.`
