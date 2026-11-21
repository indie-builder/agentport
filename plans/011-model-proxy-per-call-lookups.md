# Plan 011: 合并模型代理每次调用中重复的 run 查询

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 321cf491..HEAD -- packages/db/src/repo/runs.ts packages/worker/src/model-proxy.ts packages/worker/src/model-providers.ts packages/worker/src/index.ts packages/worker/src/memory/memory-review.ts`
> On any mismatch with the excerpts below, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `321cf491`, 2026-11-22

## Why this matters

沙盒里的每次模型 API 调用都经 worker 的模型代理。当前每个请求都会：按 token 查 run、再查一次 run 行、查 run 的会话，然后才进入供应商与策略解析。「按 token 查 run / 再查 run 行 / 查会话」是同一事实的三次重复查询。本次修复让 token 查询一次返回后续步骤需要的字段，并把会话字段下传给供应商解析，去掉两次重复查询；预算、目的地审批、内容策略与端点校验全部保持每次请求执行。

## Current state

- `packages/db/src/repo/runs.ts:697-707` — 按模型 token 只返回 `runId`。
- `packages/worker/src/index.ts:261-284` — 代理回调：`resolveRun` 查 token；`checkOutbound` 再 `getRun`；`resolveProviders` 调供应商解析。
- `packages/worker/src/model-providers.ts:12-73` — 每次调用查会话、审批、历史目的地、供应商列表，逐个 `assertServerEndpoint`（DNS）与 `decryptSecrets`（AES），再查月预算。
- `packages/worker/src/memory/memory-review.ts:447-456` — 另一个 `resolveProviderUpstreams` 调用方。
- `packages/worker/test/model-proxy.test.ts:39-48` — 现有代理测试只传 `upstreamBaseUrl`、`apiKey`、`resolveRun`，不传 `resolveProviders`/`checkOutbound`。

关键现有代码：

```ts
// packages/db/src/repo/runs.ts:697
export async function findRunByModelToken(
  db: Database,
  tokenHash: string,
): Promise<{ runId: string } | null> {
  const [row] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.modelTokenHash, tokenHash), eq(agentRuns.status, 'running')))
    .limit(1);
  return row ? { runId: row.id } : null;
}
```

```ts
// packages/worker/src/index.ts:261
  resolveRun: async (token) => {
    const row = await repo.runs.findRunByModelToken(db, hashMcpToken(token));
    return row;
  },
  checkOutbound: async ({ runId, body }) => {
    const run = await repo.chat.getRun(db, runId);
    if (run === null) return { blocked: true, body: Buffer.alloc(0) };
    const text = body.toString('utf8');
    const checked = await checkOutboundPolicy(db, logger, {
      agentId: run.agentId,
      runId,
      text,
      sourceId: runId,
    });
```

```ts
// packages/worker/src/model-providers.ts:12
export async function resolveProviderUpstreams(
  db: Database,
  config: Pick<Config, 'APP_SECRET_KEY' | 'NODE_ENV' | 'MODEL_PROVIDER_PRIVATE_HOST_ALLOWLIST'>,
  model: string | undefined,
  runId: string,
  envBaseUrl: string,
): Promise<ProviderResolution> {
  const conversationId = await repo.runs.getRunConversationId(db, runId);
```

```ts
// packages/worker/src/model-providers.ts:57-70（供应商候选循环内）
      try {
        await assertServerEndpoint(provider.baseUrl, {
          nodeEnv: config.NODE_ENV,
          allowlist: config.MODEL_PROVIDER_PRIVATE_HOST_ALLOWLIST,
        });
        const baseUrl = new URL(provider.baseUrl);
        if (
          (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') ||
          baseUrl.username ||
          baseUrl.password
        )
          return null;
        const credential = decryptSecrets(
          provider.credentialEncrypted,
          config.APP_SECRET_KEY,
        ).credential;
```

仓库约定：

- `packages/db/AGENTS.md`：共享查询放 `src/repo/`，不为单个调用方预造抽象。
- 不为单个修复新增单测（根 `AGENTS.md`）。
- 不新增依赖；worker 当前没有 `lru-cache`，用进程内 `Map` 即可。

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install --frozen-lockfile` | exit 0 |
| Build shared deps before backend tests | `bun run --filter @agentport/shared --filter @agentport/core --filter @agentport/db build` | exit 0 |
| DB typecheck | `bun run --filter @agentport/db typecheck` | exit 0 |
| Worker typecheck | `bun run --filter @agentport/worker typecheck` | exit 0 |
| Model proxy tests | `bun run test -- packages/worker/test/model-proxy.test.ts` | all pass |
| Worker tests (touched area) | `bun run test -- packages/worker/test/cancel.test.ts packages/worker/test/claim-retry.test.ts` | all pass |
| Format/lint (read-only) | `bunx biome check packages/db/src/repo/runs.ts packages/worker/src/model-proxy.ts packages/worker/src/model-providers.ts packages/worker/src/index.ts` | 0 error |

## Scope

**In scope**:
- `packages/db/src/repo/runs.ts`（只改 `findRunByModelToken` 的返回字段）
- `packages/worker/src/model-proxy.ts`（回调类型与调用处）
- `packages/worker/src/model-providers.ts`（可选会话参数，去掉重复查询）
- `packages/worker/src/index.ts`（接线）
- `packages/worker/src/memory/memory-review.ts`（仅在签名不兼容时做最小适配）

**Out of scope**:
- 预算判定（`providerUsageForModel`）必须保持每次请求执行，不缓存。
- 审批目的地与历史目的地查询（`getApprovedPolicyApprovalForRun` / `getApprovedPolicyApprovalForConversation` / `listHistoricalProviderDestinations`）必须保持每次请求执行，不缓存。
- 内容策略查询与扫描必须保持每次请求执行，不缓存。
- `packages/worker/test/model-proxy.test.ts` 的既有用例逻辑；只允许为新增可选字段做最小类型适配。
- 不新增依赖、不引入跨进程缓存。

## Git workflow

- 在 `.claude/worktrees/<slug>` 内工作，分支名用 ASCII slug。
- 提交信息示例：`perf(worker): 合并模型代理对 run 的重复查询`。
- 不推送、不开 PR，除非操作者明确要求。

## Steps

### Step 1: 让 token 查询一次返回重复查询所需字段

在 `packages/db/src/repo/runs.ts` 把 `findRunByModelToken` 的 select 从 `{ id }` 扩为 `{ id, conversationId, agentId }`，返回类型改为：

```ts
Promise<{ runId: string; conversationId: string; agentId: string } | null>
```

映射时返回 `{ runId: row.id, conversationId: row.conversationId, agentId: row.agentId }`。不改变 `where` 条件（仍要求 `status='running'`）。

**Verify**: `bun run --filter @agentport/db typecheck` → exit 0；`rg -n 'findRunByModelToken' packages -g '*.ts'` 只显示定义与 `worker/src/index.ts`、测试。

### Step 2: 把 run 字段传过代理回调，去掉重复查询

在 `packages/worker/src/model-proxy.ts`：

1. 把 `ModelProxyOptions.resolveRun` 返回类型改为
   `Promise<{ runId: string; conversationId?: string; agentId?: string } | null>`。
2. 把 `checkOutbound` 的入参改为
   `{ runId: string; agentId?: string; model?: string; body: Buffer }`。
3. 在 `handle` 中调用 `options.checkOutbound` 时传入 `run.agentId`（存在时）。

在 `packages/worker/src/index.ts`：

```ts
  checkOutbound: async ({ runId, agentId, body }) => {
    const effectiveAgentId =
      agentId ??
      (await repo.chat.getRun(db, runId).then((run) => run?.agentId));
    if (effectiveAgentId === undefined || effectiveAgentId === null) {
      return { blocked: true, body: Buffer.alloc(0) };
    }
    const text = body.toString('utf8');
    const checked = await checkOutboundPolicy(db, logger, {
      agentId: effectiveAgentId,
      runId,
      text,
      sourceId: runId,
    });
```

保留现有 `blocked` 返回与 body 映射逻辑不变。`resolveProviders` 调用改为把整个 `run` 中的 `conversationId` 传下去（见 Step 3）。

**Verify**: `bun run --filter @agentport/worker typecheck` → exit 0；`bun run test -- packages/worker/test/model-proxy.test.ts` → all pass（测试只传 `{ runId }`，可选字段必须让旧形状继续工作）。

### Step 3: 避免供应商解析重复查会话

在 `packages/worker/src/model-providers.ts` 给 `resolveProviderUpstreams` 增加可选第 6 个参数：

```ts
  conversationId?: string,
```

函数体改为：

```ts
  const resolvedConversationId =
    conversationId ?? (await repo.runs.getRunConversationId(db, runId));
  if (resolvedConversationId === null) return { routed: true, blocked: true };
```

后续所有 `conversationId` 使用替换为 `resolvedConversationId`。`memory-review.ts` 的调用不传第 6 个参数，行为不变。

为了让代理把 `resolveRun` 已经拿到的会话传下来，在 `packages/worker/src/model-proxy.ts` 把回调类型改为：

```ts
  resolveProviders?: (
    run: { runId: string; conversationId?: string },
    model: string | undefined,
  ) => Promise<ProviderResolution>;
```

在 `handle` 中调用时传整个 `run`：

```ts
    const resolved = await options.resolveProviders?.(run, ctx.model);
```

在 `packages/worker/src/index.ts` 中：

```ts
  resolveProviders: (run, model) =>
    resolveProviderUpstreams(
      db,
      config,
      model,
      run.runId,
      modelProxyUpstream(envUpstream, false),
      run.conversationId,
    ),
```

不要新增额外的进程内身份表；会话字段随本次 `resolveRun` 结果传递，鉴权仍以 `resolveRun` 的 DB 查询与 `activeRuns` 集合为准。

**Verify**: `bun run --filter @agentport/worker typecheck` → exit 0；`rg -n 'resolveProviderUpstreams\(' packages -g '*.ts'` → 只有定义、`index.ts`、`memory-review.ts` 三处。

### Step 4: 完整验证

```bash
bun run --filter @agentport/shared --filter @agentport/core --filter @agentport/db build
bun run --filter @agentport/db typecheck
bun run --filter @agentport/worker typecheck
bun run test -- packages/worker/test/model-proxy.test.ts
bun run test -- packages/worker/test/cancel.test.ts packages/worker/test/claim-retry.test.ts
bunx biome check packages/db/src/repo/runs.ts packages/worker/src/model-proxy.ts packages/worker/src/model-providers.ts packages/worker/src/index.ts packages/worker/src/memory/memory-review.ts
```

全部 exit 0；后端测试 0 skip。

## Test plan

- 不新增测试（根 `AGENTS.md`）。
- 现有 `packages/worker/test/model-proxy.test.ts` 必须继续通过，证明可选字段没有破坏旧回调形状。
- 重复查询是否真正消失，由代码路径检查：`checkOutbound` 在 `agentId` 存在时不调用 `getRun`；`resolveProviderUpstreams` 在传入 `conversationId` 时不调用 `getRunConversationId`。

## Done criteria

- [ ] `findRunByModelToken` 返回 `runId`、`conversationId`、`agentId`
- [ ] `checkOutbound` 在 `agentId` 存在时不再调用 `repo.chat.getRun`
- [ ] `resolveProviderUpstreams` 在传入 `conversationId` 时不再调用 `getRunConversationId`
- [ ] 预算、审批目的地、历史目的地、内容策略、端点校验与凭证解密仍每次请求执行（`rg` 确认没有被移进缓存分支）
- [ ] 上述 typecheck、测试、biome 命令全部通过
- [ ] `git status --porcelain` 只显示 in-scope 文件与 `plans/README.md`

## STOP conditions

Stop and report back (do not improvise) if:

- `findRunByModelToken` 有 `worker/src/index.ts` 之外的运行时调用方（先 `rg` 全仓确认）。
- `model-proxy.test.ts` 的 `resolveRun` 返回结构或 `checkOutbound` 断言与可选字段方案冲突，且不能通过调整类型兼容。
- 需要把预算、审批、内容策略或端点校验收进缓存才能通过测试。
- 发现有文档或测试要求代理必须每次重新查 `getRun` 或 `getRunConversationId`。

## Maintenance notes

- 预算耗尽、目的地审批、内容策略、端点校验与凭证解密是安全与正确性边界，全部保持每次请求执行；未来若想缓存，先核对 D-88 的「复核时点」约定并单独评审。
- 会话字段只是随 `resolveRun` 结果下传的查询去重，不是鉴权来源；评审时确认 `resolveRun` 的 DB 查询仍是唯一身份入口。
