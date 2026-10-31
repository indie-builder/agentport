# 收敛 `err instanceof Error ? err.message : String(err)` 到 shared

## 目标
把本轮触碰的 6 个文件里各自复制的「取错误文本」表达式收敛为 shared 的单一辅助函数 `errorText`，减少同名私有副本；不改变任何错误处理语义、日志文案或控制流。

## 方案
- 在 `packages/shared/src/errors.ts` 导出 `errorText(err: unknown): string`，实现逐字为 `err instanceof Error ? err.message : String(err)`；由 `packages/shared/src/index.ts` 的 `export * from './errors.js'` 进入 barrel（无需改 barrel）。
- 6 个文件删除本地具名副本（`messageOf` / `errorText` / `toError`）与 `runner-client.ts:223` 的内联表达式，改为从 `@agentport/shared` 引入。调用点自带的行为（如 `sanitize()`、`redactSecrets()`、`.slice(0, 500)`）保持原位，不搬进辅助函数。
- 与任务原始措辞的差异：任务写「新建 `packages/shared/src/errors.ts`」，但该文件已存在并承载 `Problem` / `errorCode` 契约；为保持单一错误模块，函数直接加在该文件，不新建平行文件。

## 基线与范围
- 起始 commit：`fb023bd`（`origin/main`），工作区初始干净。
- 允许改动：上列 6 个源码文件、`packages/shared/src/errors.ts`、新增 `packages/shared/test/errors.test.ts`、本任务记录。
- 不在本任务：全仓其余内联同表达式（见「下一步」未覆盖范围）；不改错误类型、日志文案、截断长度与控制流；不改 `packages/shared/src/index.ts`。

## 当前有效决定
- 辅助函数只做「Error 取 message，其余 `String()`」，不做截断、脱敏或空值兜底——这些是调用点各自的策略。
- 全仓精确同形的 `instanceof Error ? err.message : String(err)` 仍有 44 处未收敛（非测试 40 处、测试 4 处）；宽匹配 `instanceof Error ? .*\.message` 为 49 处，其中含新增的 shared 定义 1 处与 4 处不同表达式（3 处固定字符串兜底、1 处 cause 分支），不计入未收敛数。本轮不扩散清理。
- 交付按循环的持续授权：终审通过后由主会话 commit/push/PR/merge。

## 步骤
- [x] 读取根规则与 shared/api/worker/sandbox 模块规则、`docs/PITFALLS.md`
- [x] 确认 `packages/shared/src/errors.ts` 已存在，函数并入该文件
- [x] 在 shared 新增 `errorText`
- [x] 6 个文件删除本地副本并改 import；`runner-client.ts` 的 `toError` 调用点统一换成 `errorText`
- [x] 新增 `packages/shared/test/errors.test.ts`
- [x] 运行 typecheck、目标套件、`git diff --check`、biome

## 改动文件
- `packages/shared/src/errors.ts`（新增 `errorText`）
- `packages/shared/test/errors.test.ts`（新增）
- `packages/sandbox/src/native-plugins.ts`（删 `messageOf`，3 处调用改 `errorText`）
- `packages/api/src/queue/session-cleanup.ts`（删 `errorText`）
- `packages/worker/src/sandbox-probe.ts`（删 `errorText`）
- `packages/worker/src/runner-client.ts`（删 `toError`，8 处调用 + 1 处内联改 `errorText`）
- `packages/worker/src/native-plugins.ts`（删 `errorText`）
- `packages/worker/src/sandbox/session-cleanup.ts`（删 `errorText`）

## 下一步
- 未覆盖：全仓仍有 44 处精确同形的 `instanceof Error ? err.message : String(err)`（非测试 40 处、测试 4 处），包括 `packages/sandbox/src/{probe,runner,session-supervisor,questions,memory-permissions}.ts`、`packages/api/src/features/**`、`packages/worker/src/{reconcile,knowledge/**,runtime-environments/**}.ts`、`packages/core/src/{openui-response,plugin-display}.ts` 等。后续任务可按模块分批收敛；带 `.slice(0, 500)` 的调用点需保留截断在外层。
- 通过独立 Opus 终审后按循环授权 commit/push/PR/merge。

## 验证
改前（6 个文件内的内联副本，`grep -rn --include='*.ts' "instanceof Error ? .*\.message" <6 files>` 实际输出）：

```
packages/sandbox/src/native-plugins.ts:56:  return err instanceof Error ? err.message : String(err);
packages/api/src/queue/session-cleanup.ts:41:  return err instanceof Error ? err.message : String(err);
packages/worker/src/sandbox-probe.ts:68:  return err instanceof Error ? err.message : String(err);
packages/worker/src/runner-client.ts:223:    const detail = err instanceof Error ? err.message : String(err);
packages/worker/src/runner-client.ts:424:  return err instanceof Error ? err.message : String(err);
packages/worker/src/native-plugins.ts:76:  return err instanceof Error ? err.message : String(err);
packages/worker/src/sandbox/session-cleanup.ts:33:  return err instanceof Error ? err.message : String(err);
```

改后同一命令：无匹配（`exit=1`）；shared 只保留一处定义：

```
packages/shared/src/errors.ts:15:export function errorText(err: unknown): string {
packages/shared/src/errors.ts-16-  return err instanceof Error ? err.message : String(err);
packages/shared/src/errors.ts-17-}
```

全仓计数：精确同形表达式改前 51 处（含被替换的 7 处），改后 44 处；宽匹配 `instanceof Error ? .*\.message` 改前 55、改后 49，其中含新增 shared 定义 1 处与 4 处不同表达式，不代表未收敛数。

等价性证据：辅助函数体与原先 7 处被替换文本逐字相同；所有调用点只改函数名，参数与外围包装（`sanitize` / `redactSecrets` / `RunFailure` 构造）未动，`git diff` 中无其他逻辑行变化。

红测试为何不适用：这是搬移型重构，行为在改动前后完全相同，无法先写出一个「改前红、改后绿」的诚实测试；新增的 `errors.test.ts` 用于锁定辅助函数自身的契约，而不是证明行为修复。

命令与真实结果：
- `pnpm --filter @agentport/shared --filter @agentport/sandbox --filter @agentport/api --filter @agentport/worker typecheck` → 四个包均 `Done`。
- `pnpm exec vitest run --project backend packages/shared/test/errors.test.ts packages/worker/test/sandbox-probe.test.ts packages/api/test/session-cleanup.test.ts packages/worker/test/native-plugins.test.ts packages/worker/test/session-cleanup-channel.test.ts` → `Test Files 5 passed (5)`，`Tests 47 passed (47)`。
- `git diff --check` → 无输出，`exit=0`。
- `./node_modules/.bin/biome check <8 个改动文件>` → `Checked 8 files in 11ms. No fixes applied.`（首次运行提示 `runner-client.ts` import 排序，已按提示调整后复跑通过）。
