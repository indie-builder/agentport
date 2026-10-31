# worker `uniquePath` 六份副本收敛为叶模块纯函数

## 目标

`packages/worker/src/knowledge/` 下 6 个模块各自持有一份逐字相同的 `uniquePath`。把它们收敛为单一纯函数，调用方改为 import，行为、命名策略、扩展名处理与冲突后缀格式保持不变。

## 方案

- 新建叶模块 `packages/worker/src/knowledge/source-paths.ts`，导出 `uniquePath`；函数体从现有实现原样搬移，仅把 `function` 改为 `export function`。
- 不放进 `sources.ts`：`sources.ts` 已 import 各 `source-*` 模块，而 5 个 `source-*` 又 import `sources.js` 的类型（现有为 type-only），把函数放进去会形成值级循环依赖；独立叶模块只被单向依赖。
- 6 处删除本地副本，改为 `import { uniquePath } from './source-paths.js';`；未产生其它不再使用的 import。
- 在 `packages/worker/test/knowledge-sources.test.ts` 增加 5 条纯行为用例（同名冲突带扩展名、无扩展名冲突、未冲突原样返回、大小写与路径分隔符视为不同路径、目录名含点时按全路径最后一个点切分），只断言返回值与 `used` 集合这类外部可观察结果，不 mock。
- 不动命名策略、调用方语义、安全校验；不新增依赖。

## 基线

- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-cleanup-loop-20261101-0316`
- 分支：`worktree-codebase-cleanup-loop-20261101-0316`
- 基线提交：`origin/main` `7d5945c`

## 当前有效决定

- 搬移型改动，不是行为修复：红测试不适用。函数体在 6 处逐字相同（sha1 `6cc48f3f618be0d0261d9416531daf6e2aaa0b64`），搬移后函数体与旧实现逐字一致，只有 `export` 关键字不同；因此不存在「先红后绿」的失败态，等价性由「搬移前后同一测试命令全绿 + 函数体逐字一致」证明。
- 收敛目标是 `uniquePath`；同目录重复的 `sanitizeSegment` 不在本次范围，未改动。
- 不 commit、不 push。

## 步骤

1. 逐字比对 6 处实现：对每个文件从 `uniquePath` 起始行取 11 行计算 sha1，6 份完全一致（见验证 §1），确认无语义差异后再合并。
2. 新建 `source-paths.ts`，原样搬入函数并导出。
3. 6 个模块删除本地函数、增加 import。
4. 在现有 `knowledge-sources.test.ts` 追加 `describe('uniquePath')` 用例。
5. 运行 typecheck、定向测试、biome 与 `git diff --check`。

## 改动文件

- `packages/worker/src/knowledge/source-paths.ts`（新增）
- `packages/worker/src/knowledge/sources.ts`
- `packages/worker/src/knowledge/source-notion.ts`
- `packages/worker/src/knowledge/source-ima.ts`
- `packages/worker/src/knowledge/source-dingtalk.ts`
- `packages/worker/src/knowledge/source-yuque.ts`
- `packages/worker/src/knowledge/source-confluence.ts`
- `packages/worker/test/knowledge-sources.test.ts`
- `docs/tasks/codebase-cleanup-loop-20261101-0316.md`

## 下一步

- 用户审阅后决定是否提交；本任务未 commit、未 push。

## 验证

### 1. 改前：6 处实现逐字相同

对 `sources.ts:156`、`source-notion.ts:263`、`source-ima.ts:293`、`source-dingtalk.ts:202`、`source-yuque.ts:114`、`source-confluence.ts:457` 各取 11 行做 sha1：

```text
sources.ts:156            6cc48f3f618be0d0261d9416531daf6e2aaa0b64
source-notion.ts:263      6cc48f3f618be0d0261d9416531daf6e2aaa0b64
source-ima.ts:293         6cc48f3f618be0d0261d9416531daf6e2aaa0b64
source-dingtalk.ts:202    6cc48f3f618be0d0261d9416531daf6e2aaa0b64
source-yuque.ts:114       6cc48f3f618be0d0261d9416531daf6e2aaa0b64
source-confluence.ts:457  6cc48f3f618be0d0261d9416531daf6e2aaa0b64
```

无命名策略、扩展名处理、分隔符或后缀格式差异，可以合并。

### 2. 改前：定向测试基线

命令：

```bash
pnpm exec vitest run --project backend packages/worker/test/knowledge-sources.test.ts
```

输出摘要：

```text
Test Files  1 passed (1)
     Tests  40 passed (40)
```

### 3. 改后：同一命令

```text
Test Files  1 passed (1)
     Tests  45 passed (45)
```

40 条既有用例全部保持通过（覆盖该套件内的 URL 校验、RSS/Atom/JSON、HTTP 错误、GitLab、GitHub、Feishu），新增 5 条 `uniquePath` 用例通过。其余五个受影响的来源套件单独运行：notion / ima / dingtalk / yuque / confluence 5 个文件、103 项全部通过。

### 4. 函数体等价证据

`git show HEAD:packages/worker/src/knowledge/sources.ts` 的原函数与新模块对比，唯一差异是首行：

```diff
-function uniquePath(path: string, used: Set<string>, token: string): string {
+export function uniquePath(path: string, used: Set<string>, token: string): string {
```

### 5. 其它检查

- `pnpm --filter @agentport/worker typecheck`：`tsc -b` 退出码 0，无输出。
- `pnpm exec biome check`（8 个改动文件）：`Checked 8 files`，退出码 0。
- `git diff --check`：退出码 0。
- `grep -rn "function uniquePath" packages/worker/src`：仅剩 `source-paths.ts` 一处定义。
