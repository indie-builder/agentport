# Plan 002: 专家保存/回滚后失效 `agent-detail` 缓存

> **Executor instructions**: 按步骤执行并逐条验证。遇「STOP 条件」停止报告。完成后更新 `plans/README.md` 状态行。
>
> **Drift check（先跑）**: `git diff --stat 7166f519..HEAD -- packages/web/src/lib/queries/agents.ts packages/web/src/pages/agents/agent-detail-page.tsx`
> 漂移则对照「Current state」；不符按 STOP。

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (web)
- **Planned at**: commit `7166f519`, 2026-11-14

## Why this matters

专家详情页读取独立缓存 `['agent-detail', id]`，但“保存”和“回滚”两个 mutation 只失效了列表 `['agents']` 和文件 `['agent-files']`，没有失效详情。详情页 `current = full ?? summary.data` 直接拿这份旧的 `full`，于是保存成功后：页头名称/角色仍旧值；更糟的是编辑器里的“子智能体绑定未保存”提示会拿**保存前的** `agent.subAgentIds` 做比较，在保存成功后反而误报“未保存”。回滚同理，重新挂载或再次读取会拿到回滚前的数据。修复只需在两条 mutation 成功后失效/写回 `['agent-detail', id]`。

## Current state

- `packages/web/src/lib/queries/agents.ts:19-25` — 详情查询键：

```ts
export const agentDetailQuery = (id: string, enabled = true) =>
  queryOptions<Agent>({
    queryKey: ['agent-detail', id],
    queryFn: ({ signal }) => api.agent(id, signal),
    enabled,
    staleTime: 0,
  });
```

- `packages/web/src/lib/queries/agents.ts:202-231` — `useUpdateAgent`：`onSettled` 只失效 `['agents']` 与 `['agent-files']`，无 `['agent-detail', id]`：

```ts
  return useMutation({
    mutationFn: (vars: { id: string; input: AgentPatch; expectedUpdatedAt?: string }) =>
      api.updateAgent(vars.id, vars.input, vars.expectedUpdatedAt),
    ...
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['agents'] });
      void client.invalidateQueries({ queryKey: ['agent-files'] });
    },
  });
```

- `packages/web/src/lib/queries/agents.ts:164-174` — `useRollbackAgent`：`onSuccess` 失效 agents/versions/files，无 detail：

```ts
    onSuccess: (_agent, { id }) => {
      void client.invalidateQueries({ queryKey: ['agents'] });
      void client.invalidateQueries({ queryKey: ['agent-versions', id] });
      void client.invalidateQueries({ queryKey: ['agent-files'] });
    },
```

- `packages/web/src/pages/agents/agent-detail-page.tsx:97` — 渲染取 `const current = full ?? summary.data;`（`full` 即 detail 查询）。
- `packages/web/src/pages/agents/agent-editor.tsx:557-560` — `savedSubAgents` 用 `agent.subAgentIds`（来自上述 `current`）计算，是误报来源。
- 参考范式：`useTransferAgent`（`agents.ts:125-136`）已用 `client.setQueryData(['agent-detail', agent.id], agent)` 正确写回。

## Commands you will need

| 用途 | 命令 | 成功判据 |
|---|---|---|
| 类型检查 | `bun run --filter @agentport/web typecheck` | exit 0 |
| 前端测试 | `bun run test:web` | 全绿 |
| 规范检查 | `bunx biome check packages/web/src/lib/queries/agents.ts` | 0 error |
| 视觉/交互验收 | 见 web `AGENTS.md`「UI 验收」：真实渲染 + 多视口截图 | 保存后页头即时更新、无误报 |

## Scope

**In scope**:
- `packages/web/src/lib/queries/agents.ts`
- 如需补测试：`packages/web/test/` 下与 agents 查询相关文件（先 grep 现有用例定位）

**Out of scope**:
- 不改 editor 的表单/脏值基线逻辑（本计划只保证缓存被刷新；若验证发现刷新后 editor 仍死锁在旧基线，记录为后续项，不在本轮扩围）。
- 不动 `useTransferAgent`/其它 mutation。

## Git workflow

- 分支：`advisor/002-agent-detail-cache-invalidation`
- 提交风格：`fix(web): 专家保存/回滚后失效详情缓存`
- 不要 push/PR（除非被要求）。

## Steps

### Step 1: `useUpdateAgent` 成功后同步详情缓存

把 `onSettled` 改为接收变量并失效详情，同时若 mutation 返回更新后的 `Agent` 则直接写回以即时更新：

```ts
    onSuccess: (agent) => {
      client.setQueryData(['agent-detail', agent.id], agent);
    },
    onSettled: (_data, _err, vars) => {
      void client.invalidateQueries({ queryKey: ['agents'] });
      void client.invalidateQueries({ queryKey: ['agent-files'] });
      void client.invalidateQueries({ queryKey: ['agent-detail', vars.id] });
    },
```

若 `api.updateAgent` 的返回类型不是 `Agent`（先确认签名），则省略 `onSuccess` 的 `setQueryData`，仅保留 `onSettled` 里的 `invalidateQueries(['agent-detail', vars.id])`——`staleTime:0` 会触发重新拉取。

**Verify**: `bun run --filter @agentport/web typecheck` → exit 0

### Step 2: `useRollbackAgent` 成功后写回/失效详情

```ts
    onSuccess: (agent, { id }) => {
      client.setQueryData(['agent-detail', id], agent);
      void client.invalidateQueries({ queryKey: ['agents'] });
      void client.invalidateQueries({ queryKey: ['agent-versions', id] });
      void client.invalidateQueries({ queryKey: ['agent-files'] });
      void client.invalidateQueries({ queryKey: ['agent-detail', id] });
    },
```

（同样：若 `api.rollbackAgent` 不返回 `Agent`，去掉 `setQueryData` 行，保留 `invalidateQueries`。）

**Verify**: `bun run --filter @agentport/web typecheck` → exit 0

### Step 3: 前端测试与规范检查

**Verify**: `bun run test:web` → 全绿；`bunx biome check packages/web/src/lib/queries/agents.ts` → 0 error

### Step 4: 真实渲染验收

用 `bun run visual:shots --full --route /agents/<已存在专家 id>` 或运行 dev 栈，实测：
- 改名称并保存后，页头名称立即更新（不需手动刷新）。
- 保存后不再出现“子智能体绑定未保存”误报。
- 回滚后详情反映回滚版本。
记录 commit、路由、视口、截图目录到交付说明。

## Test plan

- 若 `packages/web/test/` 已有 agents 相关查询测试，追加一条：mock 保存成功后，`['agent-detail', id]` 被 invalidate/写入新值（用 QueryClient 观察或组件行为断言）。
- 若现有测试结构不适合，可只用 Step 4 的真实浏览器验收记录作为证据（web 改动的硬性验收以真实渲染为准）。

## Done criteria

- [ ] `bun run --filter @agentport/web typecheck` exit 0
- [ ] `bun run test:web` 全绿
- [ ] `grep -n "agent-detail" packages/web/src/lib/queries/agents.ts` 在 update/rollback 两个 mutation 内均命中
- [ ] 真实渲染验收通过并记录（无「未做视觉验收」）
- [ ] 仅 in-scope 文件改动；`plans/README.md` 已更新

## STOP conditions

- 「Current state」摘录与现状不符。
- `api.updateAgent` / `api.rollbackAgent` 返回类型与假设不同且影响 `setQueryData`——改用纯 invalidate 即可，不要改 api 层。
- 真实渲染显示保存后仍有个别字段不刷新：停止并报告具体字段，不要顺手重写 editor 表单逻辑。

## Maintenance notes

- `agentDetailQuery` 的 `staleTime:0` 意味着失效后必然重取；新增任何“写 agent”的 mutation 都要同步失效 `['agent-detail', id]`。
- 评审重点：确认两条 mutation 都覆盖、`setQueryData` 仅在其返回 `Agent` 时使用。
