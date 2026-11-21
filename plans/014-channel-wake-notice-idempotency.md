# Plan 014: 频道 wake 通知按 CAS 结果发布，消除重复系统消息

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 321cf491..HEAD -- packages/api/src/modules/channels/wakes.ts packages/db/src/repo/channel-wakes.ts`
> On any mismatch with the excerpts below, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `321cf491`, 2026-11-22

## Why this matters

频道里智能体不在、绑定失效或启动失败时，wake 会向频道写入一条系统提示。当前实现先发提示、再执行带租约校验的 CAS；如果租约已过期或被另一个 dispatcher 重新领取，CAS 会返回 `false`，但旧 dispatcher 的提示已经发出。两个 dispatcher 同时处理同一条 wake 时，用户会在时间线看到重复的「未执行」提示。修复后只有 CAS 成功的一方才发提示。

## Current state

- `packages/api/src/modules/channels/wakes.ts:57-67` — `postNotice` 直接写系统消息。
- `packages/api/src/modules/channels/wakes.ts:82-92` — `skipWake` 先 `postNotice`，再 `markChannelWakeSkipped`，丢弃返回值。
- `packages/api/src/modules/channels/wakes.ts:100-120` — `handleEnqueueFailure` 在达到最大尝试次数时先 `markChannelWakeFailed`，再 `postNotice`，丢弃返回值。
- `packages/api/src/modules/channels/wakes.ts:152-178` — `dispatchWake` 的另一处「超过最大尝试」分支同样先 `markChannelWakeFailed`，再 `postNotice`。
- `packages/db/src/repo/channel-wakes.ts:95-130` — `markChannelWakeSkipped` / `markChannelWakeFailed` 都是 `(id, status='dispatching', claimedAt)` 的 CAS，返回 `boolean`。

关键现有代码：

```ts
async function skipWake(
  context: WakeContext,
  wake: repo.channelWakes.ChannelWakeRow,
  notice: string,
): Promise<'skipped'> {
  await postNotice(context, wake, notice);
  await channelWakeRepo.markChannelWakeSkipped(context.db, {
    id: wake.id,
    claimedAt: wake.claimedAt as Date,
  });
  return 'skipped';
}
```

```ts
    await channelWakeRepo.markChannelWakeFailed(context.db, {
      id: wake.id,
      claimedAt: wake.claimedAt as Date,
      lastError: errorText(err),
    });
    await postNotice(context, wake, WAKE_FAILED_NOTICE);
    return 'failed';
```

```ts
export async function markChannelWakeSkipped(
  db: Database,
  input: { id: string; claimedAt: Date },
): Promise<boolean> {
  return updateClaimedWake(db, input.id, input.claimedAt, { status: 'skipped' });
}
```

仓库约定：`docs/ARCHITECTURE.md` 记录频道消息与 wake 的语义；不新增表、字段或迁移；现有测试只有 `packages/api/test/channels-mentions.test.ts` 覆盖 wake 派发。

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install --frozen-lockfile` | exit 0 |
| Build shared deps before backend tests | `bun run --filter @agentport/shared --filter @agentport/core --filter @agentport/db build` | exit 0 |
| API typecheck | `bun run --filter @agentport/api typecheck` | exit 0 |
| Wake tests | `bun run test -- packages/api/test/channels-mentions.test.ts` | all pass, 0 skip |
| Format/lint (read-only) | `bunx biome check packages/api/src/modules/channels/wakes.ts` | 0 error |

## Scope

**In scope**:
- `packages/api/src/modules/channels/wakes.ts`

**Out of scope**:
- `packages/db/src/repo/channel-wakes.ts` — CAS 已返回 boolean，不改。
- `postSystemMessage` 与频道消息 schema — 不新增去重键或迁移。
- `markChannelWakeEnqueued` 的返回值 — 成功入队不写系统消息，不影响重复提示。
- 其他频道通知、SSE 发布与 wake 清扫周期。

## Git workflow

- 在 `.claude/worktrees/<slug>` 内工作，分支名用 ASCII slug。
- 提交信息示例：`fix(channels): 仅 CAS 成功的 wake 才发布系统提示`。
- 不推送、不开 PR，除非操作者明确要求。

## Steps

### Step 1: `skipWake` 先 CAS 再通知

改为：

```ts
async function skipWake(
  context: WakeContext,
  wake: repo.channelWakes.ChannelWakeRow,
  notice: string,
): Promise<'skipped'> {
  const skipped = await channelWakeRepo.markChannelWakeSkipped(context.db, {
    id: wake.id,
    claimedAt: wake.claimedAt as Date,
  });
  if (skipped) await postNotice(context, wake, notice);
  return 'skipped';
}
```

**Verify**: `rg -n -A 8 'async function skipWake' packages/api/src/modules/channels/wakes.ts` → `markChannelWakeSkipped` 出现在 `postNotice` 之前，且 `postNotice` 被 `if (skipped)` 包住。

### Step 2: 失败通知同样以 CAS 结果为准

在 `handleEnqueueFailure` 的「达到最大尝试次数」分支改为：

```ts
    const failed = await channelWakeRepo.markChannelWakeFailed(context.db, {
      id: wake.id,
      claimedAt: wake.claimedAt as Date,
      lastError: errorText(err),
    });
    if (failed) await postNotice(context, wake, WAKE_FAILED_NOTICE);
    return 'failed';
```

在 `dispatchWake` 的「`wake.attempts > WAKE_MAX_ATTEMPTS`」分支改为：

```ts
    const failed = await channelWakeRepo.markChannelWakeFailed(context.db, {
      id: wake.id,
      claimedAt: wake.claimedAt as Date,
      lastError: 'channel wake exceeded max attempts',
    });
    if (failed) await postNotice(context, wake, WAKE_FAILED_NOTICE);
    return 'failed';
```

**Verify**: `rg -n -B 8 'await postNotice\(context, wake, WAKE_FAILED_NOTICE\)' packages/api/src/modules/channels/wakes.ts` → 两处都在 `if (failed)` 内。

### Step 3: 验证

```bash
bun run --filter @agentport/shared --filter @agentport/core --filter @agentport/db build
bun run --filter @agentport/api typecheck
bun run test -- packages/api/test/channels-mentions.test.ts
bunx biome check packages/api/src/modules/channels/wakes.ts
```

全部 exit 0；测试 0 skip。

## Test plan

- 不新增测试（根 `AGENTS.md`）。
- `packages/api/test/channels-mentions.test.ts` 覆盖 wake 派发、跳过与提示路径，必须保持全绿。
- 去重语义由顺序保证：只有 CAS 成功方发布提示；租约失败方直接返回 `skipped` / `failed`，不再写系统消息。

## Done criteria

- [ ] `skipWake`、两处 `WAKE_FAILED_NOTICE` 都在 CAS 返回 `true` 后才发布提示
- [ ] 未新增迁移、字段或去重键
- [ ] `bun run --filter @agentport/api typecheck` exit 0
- [ ] `bun run test -- packages/api/test/channels-mentions.test.ts` 全部通过，0 skip
- [ ] `bunx biome check packages/api/src/modules/channels/wakes.ts` 0 error
- [ ] `git status --porcelain` 只显示 `packages/api/src/modules/channels/wakes.ts` 与 `plans/README.md`

## STOP conditions

Stop and report back (do not improvise) if:

- `skipWake`、`handleEnqueueFailure` 或 `dispatchWake` 与上面的 excerpt 不一致。
- `markChannelWakeSkipped` / `markChannelWakeFailed` 不再返回 boolean，或 CAS 条件不含 `claimedAt`。
- `channels-mentions.test.ts` 断言「即使 CAS 失败也要发提示」这类与本次语义冲突的行为。
- 需要修改 `channel-wakes.ts`、频道消息 schema 或新增迁移才能通过验证。

## Maintenance notes

- 语义从「至少一次提示」变为「CAS 胜者一次提示」：进程在 CAS 成功与 `postNotice` 之间崩溃会丢一条提示。这是为消除重复选择的取舍，写进评审说明，不新增补偿任务。
- 如果未来给 wake 通知加持久化去重键，可回到「先发后 CAS」并容忍重复写；本次不做。
- 评审重点：三处提示发布都必须被 CAS 结果门禁；`markChannelWakeEnqueued` 的返回值保持现状。
