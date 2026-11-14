# Plan 003: 同页历史导航不再静默丢弃专家草稿

> **Executor instructions**: 按步骤执行并逐条验证。遇「STOP 条件」停止报告。完成后更新 `plans/README.md` 状态行。
>
> **Drift check（先跑）**: `git diff --stat 7166f519..HEAD -- packages/web/src/pages/agents/agent-editor.tsx packages/web/src/pages/agents/agent-detail-page.tsx`
> 漂移则对照「Current state」；不符按 STOP。

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (web)
- **Planned at**: commit `7166f519`, 2026-11-14

## Why this matters

专家编辑器为未保存改动提供离开确认。但离开拦截在「同路径 + 同 tab」时一律放行，没考虑同一 tab 内切换 `instruction`（规则/输出风格/工作流）或 `view` 会**卸载**对应子面板并丢弃其表单草稿。于是：在「规则」面板编辑了一条规则，然后用浏览器**前进/后退**（历史里两条记录仅 `instruction` 不同）会静默丢失草稿——点击 tab 有本地拦截，历史导航没有，违反页面声明的离开确认契约。修复：同 tab 时，若卸载敏感键（`instruction`/`view`）发生变化且存在子面板脏值，则仍拦截。

## Current state

- `packages/web/src/pages/agents/agent-editor.tsx:405-425` — 主编辑器离开拦截（同 tab 直接放行）：

```ts
  const guarded = dirty || childDirty;
  const locked = pending || childPending;
  ...
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => {
      if (current.pathname === next.pathname) {
        const currentTab = 'tab' in current.search ? (current.search.tab ?? 'config') : 'config';
        const nextTab = 'tab' in next.search ? (next.search.tab ?? 'config') : 'config';
        // 分区与文件变化不卸载任务，直接放行。
        if (currentTab === nextTab) return false;
        // 主配置草稿随编辑器常驻；只有子面板草稿或在途请求会因切任务丢失。
        return childDirty || locked;
      }
      return guarded || locked;
    },
    withResolver: true,
    enableBeforeUnload: guarded || locked,
  });
```

- `packages/web/src/pages/agents/agent-detail-page.tsx:446-459` — 受限视图的同类拦截（`RestrictedAgentTabs`），同样在 `currentTab === nextTab` 时 `return false`。
- `packages/web/src/pages/agents/agent-detail-page.tsx:429-430, 521, 532` — `instruction` 与 `view` 均来自路由 search（`search.instruction` / `search.view`），并作为 prop 传入子面板。
- `packages/web/src/pages/agents/agent-instructions.tsx:78-95` — 按 `instruction` 条件渲染 `rules` / `styles` / `workflows` 面板，切换即卸载当前面板。

## Commands you will need

| 用途 | 命令 | 成功判据 |
|---|---|---|
| 类型检查 | `bun run --filter @agentport/web typecheck` | exit 0 |
| 前端测试 | `bun run test:web` | 全绿 |
| 规范检查 | `bunx biome check packages/web/src/pages/agents/agent-editor.tsx packages/web/src/pages/agents/agent-detail-page.tsx` | 0 error |
| 焦点契约 | `bun run lint:focus` | 退出 0 |
| 交互验收 | 真实 dev 栈手动/visual:shots | 见 Step 3 |

## Scope

**In scope**:
- `packages/web/src/pages/agents/agent-editor.tsx`（主 blocker）
- `packages/web/src/pages/agents/agent-detail-page.tsx`（`RestrictedAgentTabs` blocker）
- 如需补测试：`packages/web/test/` 下 agents 相关文件

**Out of scope**:
- 不改 tab 点击的本地拦截逻辑（点击 tab 仍按现有本地拦截提示）。
- 不改 `agent-instructions.tsx` 的渲染结构。
- 不动 `file`/`usageDays` 等不卸载面板的 search 键的放行行为（见 Step 1 的精确条件）。

## Git workflow

- 分支：`advisor/003-agent-editor-draft-history-nav`
- 提交：`fix(web): 同页历史导航不再静默丢弃专家草稿`
- 不要 push/PR（除非被要求）。

## Steps

### Step 1: 精确化同 tab 放行条件（主 blocker）

在 `agent-editor.tsx:411-421` 的 `shouldBlockFn` 内，把「同 tab 直接放行」改为「同 tab 且卸载敏感键未变才放行」：

```ts
    shouldBlockFn: ({ current, next }) => {
      if (current.pathname === next.pathname) {
        const currentTab = 'tab' in current.search ? (current.search.tab ?? 'config') : 'config';
        const nextTab = 'tab' in next.search ? (next.search.tab ?? 'config') : 'config';
        if (currentTab === nextTab) {
          const ci = 'instruction' in current.search ? current.search.instruction : undefined;
          const ni = 'instruction' in next.search ? next.search.instruction : undefined;
          const cv = 'view' in current.search ? current.search.view : undefined;
          const nv = 'view' in next.search ? next.search.view : undefined;
          if (ci === ni && cv === nv) return false; // 同面板内变化，不卸载，放行
          return childDirty || locked;              // instruction/view 变化会卸载子面板
        }
        return childDirty || locked;
      }
      return guarded || locked;
    },
```

注意保留原注释意图：`file`、`usageDays` 等键变化不影响 `instruction`/`view`，因此仍走 `return false` 放行，不打扰用户。

**Verify**: `bun run --filter @agentport/web typecheck` → exit 0

### Step 2: 同样修正 `RestrictedAgentTabs`

在 `agent-detail-page.tsx:447-455` 应用同一逻辑（该处用 `permittedTab`，请对齐其既有取 tab 方式，其余比较 `instruction`/`view` 与 `childDirty || pending` 的写法一致）。

**Verify**: `bun run --filter @agentport/web typecheck` → exit 0

### Step 3: 真实交互验收（硬性）

起 dev 栈或 `bun run visual:shots`，实测并记录：
- 在「规则」面板编辑未保存 → 浏览器后退到另一条仅 `instruction` 不同的历史记录 → **出现离开确认**，取消则草稿保留。
- 切到「输出风格」后再前进/后退同理拦截。
- 同一面板内改变不影响卸载的 search（如文件/usageDays）→ **不弹**确认，直接生效。

**Verify**: 记录 commit、路由、操作步骤、截图目录；无「未做验收」。

### Step 4: 测试与规范检查

**Verify**: `bun run test:web` 全绿；`bunx biome check <两文件>` 0 error；`bun run lint:focus` 退出 0。

## Test plan

- 为 blocker 的判定抽一个纯函数（如需）或用现有 `useBlocker` 测试方式，覆盖：同 tab + instruction 变 + childDirty → block；同 tab + 仅 file 变 + childDirty → 放行。
- 若现有 web 测试难以直接测 blocker，则以 Step 3 的真实交互记录为证据（web 硬性验收以真实渲染为准）。

## Done criteria

- [ ] `bun run --filter @agentport/web typecheck` exit 0
- [ ] `bun run test:web` 全绿
- [ ] `bun run lint:focus` 退出 0
- [ ] 真实交互验收通过并记录（同面板内非卸载键变化不打扰）
- [ ] 仅 in-scope 文件改动；`plans/README.md` 已更新

## STOP conditions

- 「Current state」摘录与现状不符。
- 发现还有第三个使用相同“同 tab 放行”模式的 blocker——核对其是否也卸载子面板，一并纳入或报告，不要遗漏。
- 真实验收中「取消离开」后草稿仍丢失：停止报告，说明是 blocker 结算/表单基线问题，不在本计划扩围。

## Maintenance notes

- 未来若新增会卸载子面板的 search 键（如新的子视图参数），需把它加入 Step 1 的「卸载敏感键」比较集合。
- 评审重点：确认普通同面板内变化（file/usageDays）仍不弹确认，避免把正常交互变得处处打断。
