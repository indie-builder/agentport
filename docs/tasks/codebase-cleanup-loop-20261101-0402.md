# worker 知识来源重复辅助函数收敛（sanitizeSegment / trimSlash / readCapped）

## 目标

`packages/worker/src/knowledge/` 下三组逐字重复的辅助函数收敛到单一实现，调用方改为 import，行为、正则、slice 长度、fallback 与调用点全部保持不变：

- `sanitizeSegment(value, fallback)`：6 份（`sources.ts`、`source-notion.ts`、`source-ima.ts`、`source-dingtalk.ts`、`source-yuque.ts`、`source-confluence.ts`）。
- `trimSlash(value)`：3 份（`source-nextcloud.ts`、`source-confluence.ts`、`source-seafile.ts`）。
- `readCapped(response, label)`：2 份（`sources.ts`、`source-http.ts`）。

验收：三组各只剩一处定义；typecheck、定向测试通过；函数体与搬移前逐字一致（仅多 `export`）。

## 方案

- `sanitizeSegment` 与 `trimSlash` 放进已有叶模块 `packages/worker/src/knowledge/source-paths.ts`（该文件已有 `uniquePath`，不 import 任何业务模块）。函数体原样复制，只加 `export`；顺带把文件头注释从「文件名去重后缀」改为「文件名/路径辅助函数」。
- `readCapped` 放进 `packages/worker/src/knowledge/source-http.ts` 并导出：该文件已拥有它依赖的 `readBytesCapped`，且 `sources.ts` 本来就从它 import `readBytesCapped`，方向不变、不成环。删除 `sources.ts` 本地副本。
- 6 个文件删除本地 `sanitizeSegment`，3 个文件删除本地 `trimSlash`，改为从 `./source-paths.js` import；`sources.ts` 的 `readCapped` 改为从 `./source-http.js` import。
- 清理不再使用的 import：实际没有产生（各文件原有 import 仍被其它代码使用）。
- 不改函数实现、正则、`slice(0, 120)`、fallback 逻辑或任何调用点；不新增依赖。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-cleanup-loop-20261101-0402`
- 分支：`worktree-codebase-cleanup-loop-20261101-0402`
- 基线提交：`origin/main` `4240f4f`
- 初始未提交差异：无（开工时 `git status` clean）。
- 允许改动：上述 10 个 `packages/worker/src/knowledge/*.ts`、`packages/worker/test/knowledge-sources.test.ts`、本任务记录。

## 当前有效决定

- 搬移型改动，不改变行为：红测试不适用。函数体在搬移前逐字相同（sha1 见验证 §1），搬移后与旧实现只差 `export` 关键字（验证 §5），因此不存在「先失败后通过」的实现态。等价证据采用两步：①先在旧实现上运行同一组新用例全绿（临时给旧副本加 `export` 以便测试 import，运行后随搬移删除，最终 diff 无残留）；②搬移后同一命令仍全绿。
- 任务描述里的「首尾点去除」与实现不符：`sanitizeSegment` 只去前导点（`.replace(/^\.+/, '')`），尾随点保留。按实际实现写用例并显式断言尾点保留，不改实现。
- 测试只断言外部返回值，不 mock。
- 不 commit、不 push。

## 已替代项及原因

- 无。`readCapped` 曾考虑也放进 `source-paths.ts`，但其依赖 `readBytesCapped`，放进 `source-http.ts` 可复用现有字节上限实现且不新增依赖方向，故采用后者。

## 步骤

- [x] 逐字比对三组副本的 sha1，确认无语义差异（验证 §1）。
- [x] 先把新用例写到 `knowledge-sources.test.ts`，在旧实现上运行确认全绿（验证 §2）。
- [x] 在 `source-paths.ts` 增加并导出 `sanitizeSegment` / `trimSlash`；在 `source-http.ts` 导出 `readCapped`。
- [x] 10 个模块删除本地副本并改为 import，`sources.ts` 删除本地 `readCapped`。
- [x] 运行 typecheck、两个定向测试套件、biome、`git diff --check`（验证 §3-§6）。

## 改动文件

- `packages/worker/src/knowledge/source-paths.ts`（新增 `trimSlash`、`sanitizeSegment` 导出）
- `packages/worker/src/knowledge/source-http.ts`（`readCapped` 改为导出）
- `packages/worker/src/knowledge/sources.ts`（删除本地 `sanitizeSegment`、`readCapped`，改为 import）
- `packages/worker/src/knowledge/source-notion.ts`
- `packages/worker/src/knowledge/source-ima.ts`
- `packages/worker/src/knowledge/source-dingtalk.ts`
- `packages/worker/src/knowledge/source-yuque.ts`
- `packages/worker/src/knowledge/source-confluence.ts`（删除 `sanitizeSegment` 与 `trimSlash`）
- `packages/worker/src/knowledge/source-nextcloud.ts`（删除 `trimSlash`）
- `packages/worker/src/knowledge/source-seafile.ts`（删除 `trimSlash`）
- `packages/worker/test/knowledge-sources.test.ts`（新增 `sanitizeSegment` / `trimSlash` 行为用例）
- `docs/tasks/codebase-cleanup-loop-20261101-0402.md`

## 下一步

- 用户审阅后决定是否提交；本任务未 commit、未 push。

## 验证

### 1. 改前：三组副本逐字相同

`sanitizeSegment` 按调用方给的 11 行口径（如 `sources.ts` 的 144-154 行，不含闭合括号）：

```text
sources.ts:144-154           7b0f8206dbf079f8859028b54b2799ebff402996
source-notion.ts:251-261     7b0f8206dbf079f8859028b54b2799ebff402996
source-ima.ts:281-291        7b0f8206dbf079f8859028b54b2799ebff402996
source-dingtalk.ts:190-200   7b0f8206dbf079f8859028b54b2799ebff402996
source-yuque.ts:102-112      7b0f8206dbf079f8859028b54b2799ebff402996
source-confluence.ts:445-455 7b0f8206dbf079f8859028b54b2799ebff402996
```

包含闭合括号的 12 行口径同样 6 份一致：`1438083aa28633524dd28959ddd17724c545cfe4`。

`trimSlash`（含闭合括号 3 行）：

```text
source-nextcloud.ts:134-136  b6e4d10aa6aa15f69e70aec0d2daf1c99beb1443
source-confluence.ts:216-218 b6e4d10aa6aa15f69e70aec0d2daf1c99beb1443
source-seafile.ts:100-102    b6e4d10aa6aa15f69e70aec0d2daf1c99beb1443
```

`readCapped`（含闭合括号 3 行）：

```text
sources.ts:108-110       ad3e49d34c3ff5b2c1d39d3a3ed4e647a047382e
source-http.ts:281-283   ad3e49d34c3ff5b2c1d39d3a3ed4e647a047382e
```

### 2. 改前：新用例在旧实现上运行

临时给 `sources.ts` 的 `sanitizeSegment`、`source-seafile.ts` 的 `trimSlash` 加 `export`（仅为了让测试 import），用例临时从这两个模块导入；该临时改动已在搬移中删除。

```bash
pnpm exec vitest run --project backend packages/worker/test/knowledge-sources.test.ts
```

```text
Test Files  1 passed (1)
     Tests  55 passed (55)
```

### 3. 改后：定向测试

```bash
pnpm exec vitest run --project backend packages/worker/test/knowledge-sources.test.ts packages/worker/test/knowledge-source-http.test.ts
```

```text
Test Files  2 passed (2)
     Tests  63 passed (63)
```

单独跑来源套件（与改前同一命令、同一数量）：

```text
Test Files  1 passed (1)
     Tests  55 passed (55)
```

新增 10 条用例（`sanitizeSegment` 6 条、`trimSlash` 4 条）覆盖：非法字符替换、控制字符变空格、空白折叠、前导点去除与尾点保留、120 截断、空结果 fallback、中文与扩展名保留；trimSlash 的单/多尾斜杠、无斜杠、仅斜杠、中间斜杠保留。

### 4. typecheck

```bash
pnpm --filter @agentport/worker typecheck
```

```text
$ tsc -b
```

退出码 0，无诊断输出。

### 5. 函数体等价证据

把 `HEAD` 中的旧副本与搬移后的实现直接 diff，唯一差异是 `export` 关键字：

```diff
-function sanitizeSegment(value: string, fallback: string): string {
+export function sanitizeSegment(value: string, fallback: string): string {
```

```diff
-function trimSlash(value: string): string {
+export function trimSlash(value: string): string {
```

```diff
-async function readCapped(response: Response, label: string): Promise<string> {
+export async function readCapped(response: Response, label: string): Promise<string> {
```

### 6. 其它检查

- `./node_modules/.bin/biome check`（11 个改动文件）：`Checked 11 files in 19ms. No fixes applied.`，退出码 0。
- `git diff --check`：退出码 0。
- `grep -rnE "^(export )?(async )?function (sanitizeSegment|trimSlash|readCapped)" packages/worker/src/knowledge/`：只剩三处导出定义——`source-http.ts:281` `readCapped`、`source-paths.ts:17` `trimSlash`、`source-paths.ts:21` `sanitizeSegment`，无残留本地副本。

### 7. 全仓与受影响套件（主会话执行）

- `pnpm typecheck`、`pnpm build`：全仓通过。
- `pnpm test`：单跑 JSON 报告 5259 项通过、16 项跳过、0 项失败；唯一套件级失败为本地 `agentport/sandbox:dev` 镜像缺 GNU bash 的既存环境问题。并行聚合运行出现过 1 条瞬时失败，单跑不复现，属既有并行抖动。
- `pnpm test:web`：148 文件、1841 项通过。
- 受影响的八个来源套件（notion / ima / dingtalk / yuque / confluence / nextcloud / seafile / http）：8 文件、146 项全部通过。
- 独立 Opus 终审：通过，无阻塞项。
