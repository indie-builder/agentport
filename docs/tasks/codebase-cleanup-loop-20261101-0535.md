# 收敛 sha256 十六进制实现到 core 的 `sha256Hex`

## 目标

删除 api / worker 各文件私有的 SHA-256 十六进制实现，统一复用 `@agentport/core` 导出的 `sha256Hex`，使同一计算只有一处实现，调用逻辑、输入、输出与错误行为完全不变。

## 方案

- 在 `packages/core/src/outputs.ts` 把原私有 `sha256(data: Buffer)` 改名为导出的 `sha256Hex(data: Buffer | string)`，函数体不变；core 入口经 `export *` 自然可见。
- api 的 `knowledge/routes.ts`、`knowledge/faq-routes.ts`、`knowledge/content-routes.ts`、`output-shares/routes.ts` 与 worker 的 `knowledge/ingestion.ts` 删除本地副本，改为从 `@agentport/core` 导入 `sha256Hex`，调用点仅改名。
- 删除因此不再使用的 `node:crypto` 导入；仍使用 `randomUUID` / `randomBytes` 的文件保留相应导入。
- `packages/api/src/features/knowledge/package.ts:57` 的 `sha256Schema` 是 schema 正则，不是函数，不动。
- 不合并任务边界列出的其他辅助函数（`errorText`/`messageOf`/`toError`、`isPgCode`、`useMediaQuery`、`utf8Bytes`、`hasCode`、connector `networkOptions`/`failureOf`/`rethrowAuth`）。

## 基线

- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-cleanup-loop-20261101-0535`
- 分支：`worktree-codebase-cleanup-loop-20261101-0535`
- 基线提交：`origin/main` `c476513`

## 当前有效决定

- 单次用户任务明确：只做这一项收敛；不 commit、不 push。
- 函数名为 `sha256Hex`，参数类型取 `Buffer | string`（`createHash().update()` 两者都支持），不引入重载或包装。
- 任务清单列出 5 处；实施时 grep 另发现 `packages/api/src/features/output-shares/routes.ts` 已有同名 `sha256Hex(value: string | Buffer)`，除参数名 `value` / `data` 外函数体相同，一并收敛，否则会留下与新导出同名的第二份实现。
- 其他 `createHash('sha256')` 用法不属本任务：`memory/journal.ts`、`memory-reviews/routes.ts`、`knowledge/faq.ts`、`wiki-routes.ts`、`package.ts` 的 `hash`、`mcp-token.ts`（base64url）、`personal-memory.ts`（utf8）、`attachments.ts`、db/worker 中带 `slice()` 或以其他输入拼接的版本，语义或命名不同，按边界不动，留待单独任务评估。

## 步骤

1. 逐字比对 5 处实现，确认只有参数类型宽度差异（`Buffer` vs `Buffer | string`），函数体相同。
2. core 导出 `sha256Hex` 并更新内部调用。
3. api 四个文件与 worker ingestion 改为导入 core，删除本地副本与无用 `node:crypto` 导入。
4. 在 `packages/core/test/outputs.test.ts` 增加 `sha256Hex` 两条用例：已知字符串与 Buffer 字节分别断言标准 SHA-256 十六进制值，不 mock。
5. 跑 typecheck、定向测试、biome、`git diff --check`。

## 改动文件

- `packages/core/src/outputs.ts`
- `packages/core/test/outputs.test.ts`
- `packages/api/src/features/knowledge/routes.ts`
- `packages/api/src/features/knowledge/faq-routes.ts`
- `packages/api/src/features/knowledge/content-routes.ts`
- `packages/api/src/features/output-shares/routes.ts`
- `packages/worker/src/knowledge/ingestion.ts`
- `docs/tasks/codebase-cleanup-loop-20261101-0535.md`

## 下一步

- 用户审阅后决定是否提交；本任务未 commit、未 push。

## 验证

### 改前：搬移型改动没有可先红的断言

本改动不改变任何行为，只把相同函数体搬到 core 并改名，因此不存在「改前失败、改后通过」的行为断言。新增的两条用例在实现搬移前会因模块没有 `sha256Hex` 导出而报导入错误，这不是可供先红的行为证据，故不伪造红灯。

等价证据是改动前的真实源码逐字相同（`git show HEAD:<file>`，本 worktree 基线 `c476513`）：

```text
packages/core/src/outputs.ts:156
function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

packages/api/src/features/knowledge/faq-routes.ts:105
function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

packages/api/src/features/output-shares/routes.ts:34
function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
```

`knowledge/routes.ts:445`、`content-routes.ts:69`、`worker/src/knowledge/ingestion.ts:215` 的删除行在同一份 `git diff` 中可见，函数体与上面完全一致；output-shares 那份除参数名 `value` / `data` 外一致。

### 改后：类型检查

```bash
pnpm --filter @agentport/core --filter @agentport/api --filter @agentport/worker typecheck
```

```text
packages/core typecheck$ tsc -b
packages/core typecheck: Done
packages/api typecheck$ tsc -b
packages/worker typecheck$ tsc -b
packages/worker typecheck: Done
packages/api typecheck: Done
```

### 改后：定向测试

```bash
pnpm exec vitest run --project backend packages/core/test/outputs.test.ts packages/worker/test/knowledge-source-http.test.ts packages/api/test/knowledge-routes.test.ts
```

```text
Test Files  3 passed (3)
     Tests  71 passed (71)
  Duration  4.01s
```

未出现因基础设施缺失而跳过的套件；本轮后端测试由 globalSetup 在隔离 PostgreSQL 与临时 Redis 上运行。

新增用例覆盖：

- `sha256Hex('hello')` → `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`
- `sha256Hex(Buffer.from([0, 1, 2, 255]))` → `3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56`

### 改后：额外受影响的 API 套件

因一并收敛了 `output-shares/routes.ts`，追加运行其与两个知识路由套件：

```bash
pnpm exec vitest run --project backend packages/api/test/output-shares.test.ts packages/api/test/knowledge-content-routes.test.ts packages/api/test/knowledge-faq-routes.test.ts
```

```text
Test Files  3 passed (3)
     Tests  33 passed (33)
  Duration  3.03s
```

（日志中的 `redis down` 是 content 套件内主动模拟入队失败的用例，最终全绿。）

### 改后：格式与空白

```bash
./node_modules/.bin/biome check <7 个改动文件>
git diff --check
```

- biome：`Checked 7 files`，退出码 0；13 条 warning 全部位于改动前既有代码（knowledge/routes.ts 的 `noNonNullAssertion`/`useOptionalChain`、ingestion.ts 的 `noConfusingVoidType`），本次改动未新增诊断。
- `git diff --check`：无输出，退出码 0。
