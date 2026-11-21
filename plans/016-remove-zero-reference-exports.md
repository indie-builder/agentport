# Plan 016: 删除真正零引用的导出与类型别名

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 321cf491..HEAD -- packages/db/src/repo/data-domains.ts packages/db/src/repo/tool-approval-policies.ts packages/web/src/lib/api/auth.ts packages/web/test/login-route.test.ts`
> On any mismatch with the excerpts below, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `321cf491`, 2026-11-22

## Why this matters

仓库规则要求零死代码。复核后只剩 3 个符号是真正零引用：两个 repo 函数与一个 web 类型别名。其余候选虽然生产不可达，但被混在真实行为测试中当夹具或断言依据，删除会削弱生产行为覆盖，因此明确保留。

## Current state

要删除的 3 个符号（已核实全仓零引用）：

| 符号 | 定义 | 引用 |
|---|---|---|
| `listDataDomains` | `packages/db/src/repo/data-domains.ts:79` | 无（`listDataDomainPage` 已取代） |
| `getById` | `packages/db/src/repo/tool-approval-policies.ts:59` | 无 |
| `Me`（类型别名） | `packages/web/src/lib/api/auth.ts:14` | 只有 `packages/web/test/login-route.test.ts:6,102,104,217,220` |

`listDataDomains` 当前实现：

```ts
export async function listDataDomains(
  db: DbHandle,
  access?: ResourceAccessFilter,
): Promise<DataDomainRow[]> {
  const scope =
    access === undefined
      ? undefined
      : resourceScopeWhere(access, dataDomains.id, dataDomains.ownerBusinessId);
  return dataDomainRows(db, scope);
}
```

`Me` 当前定义：

```ts
export type Me = AuthMe;
```

`AuthMe` 由 `@agentport/shared` 导出（`packages/shared/src/personal.ts:34`，并经 `src/index.ts` 再导出），`auth.ts:31` 仍在直接使用 `AuthMe`，只删除别名行。

明确保留（不删除，理由记录在此）：

- `changeOwnPassword`（`packages/db/src/repo/accounts.ts:291`）：`packages/db/test/access.test.ts` 的混合用例如实断言它，同一 `it` 块还验证 `setAccountStatus`、`listAccounts`、`getIdentity`、`resetPassword`。
- `updateProgress`（`packages/db/src/repo/eval.ts:304`）：`packages/db/test/guards.test.ts` 与 `packages/api/test/eval-cancel.test.ts` 把它作为批次状态断言的一部分；`packages/worker/test/eval-snapshot.test.ts` 作为 mock 字段。
- `replaceRanges`（`packages/db/src/repo/knowledge/sources.ts:271`）：`packages/db/test/knowledge-foundation.test.ts` 与 `packages/worker/test/knowledge-integrity-regressions.test.ts` 用它构造后续生产行为断言的前置数据。
- `rollbackWikiPage`（`packages/db/src/repo/knowledge/wiki.ts:188`）：`knowledge-foundation.test.ts` 的混合用例如实断言回滚行为。
- `listReadableDocuments`（`packages/db/src/repo/knowledge/documents.ts:435`）：`knowledge-foundation.test.ts` 用它验证可读文档范围。

仓库约定：删除前用 `rg` 确认引用；删除后跑 typecheck；不新增测试与注释。

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install --frozen-lockfile` | exit 0 |
| Build shared deps | `bun run --filter @agentport/shared --filter @agentport/core --filter @agentport/db build` | exit 0 |
| DB typecheck | `bun run --filter @agentport/db typecheck` | exit 0 |
| Web typecheck | `bun run --filter @agentport/web typecheck` | exit 0 |
| API typecheck | `bun run --filter @agentport/api typecheck` | exit 0 |
| Web tests | `bun run test:web` | all pass |
| Format/lint (read-only) | `bunx biome check <modified files>` | 0 error |

## Scope

**In scope**:
- `packages/db/src/repo/data-domains.ts`
- `packages/db/src/repo/tool-approval-policies.ts`
- `packages/web/src/lib/api/auth.ts`
- `packages/web/test/login-route.test.ts`（仅把 `Me` 类型引用改为 `AuthMe`）

**Out of scope**:
- 上表「明确保留」的 5 个函数及其测试。
- 任何生产调用方 — 若出现，STOP。
- 不重构删除后文件里的其他函数；只清理因删除而不再使用的 import/私有 helper。

## Git workflow

- 在 `.claude/worktrees/<slug>` 内工作，分支名用 ASCII slug。
- 提交信息示例：`refactor: 删除零引用的 repo 导出与 Me 类型别名`。
- 不推送、不开 PR，除非操作者明确要求。

## Steps

### Step 1: 复核零引用

对 3 个符号运行：

```bash
rg -n '\blistDataDomains\b|\bgetById\b' packages scripts -g '*.ts' -g '*.tsx' -g '*.mjs' -g '*.js'
rg -n '\bMe\b' packages/web
```

预期：`listDataDomains` / `getById` 只有定义行；`Me` 只有 `auth.ts:14` 定义与 `login-route.test.ts` 的类型使用。任何额外命中都是 STOP。

**Verify**: 输出与预期一致。

### Step 2: 删除两个零引用 repo 函数

从 `packages/db/src/repo/data-domains.ts` 删除 `listDataDomains`；从 `packages/db/src/repo/tool-approval-policies.ts` 删除 `getById`。删除后检查同文件是否有只被它们使用的私有 helper 或 import（例如 `dataDomainRows` 若不再被其他函数使用），一并删除；仍在使用的 import 不动。

**Verify**: `bun run --filter @agentport/db typecheck` → exit 0。

### Step 3: 替换 `Me` 类型引用

在 `packages/web/test/login-route.test.ts`：

1. 把 `type Me` 导入改为 `type AuthMe`（来自 `@agentport/shared`）。
2. 替换 4 处 `Me` 类型使用为 `AuthMe`。
3. 不改任何断言与测试逻辑。

在 `packages/web/src/lib/api/auth.ts` 删除 `export type Me = AuthMe;`；保留仍在使用的 `AuthMe` 导入。

**Verify**: `bun run --filter @agentport/web typecheck` → exit 0；`bun run test:web` → all pass。

### Step 4: 完整验证

```bash
bun run --filter @agentport/shared --filter @agentport/core --filter @agentport/db build
bun run --filter @agentport/db typecheck
bun run --filter @agentport/api typecheck
bun run --filter @agentport/web typecheck
bun run test:web
bunx biome check packages/db/src/repo/data-domains.ts packages/db/src/repo/tool-approval-policies.ts packages/web/src/lib/api/auth.ts packages/web/test/login-route.test.ts
```

全部通过。

## Test plan

- 不新增测试（根 `AGENTS.md`）。
- `login-route.test.ts` 只做类型名替换，断言与行为不变。
- `test:web` 必须全绿。

## Done criteria

- [ ] `rg` 确认 `listDataDomains`、`getById`、`Me` 无定义、无引用
- [ ] 5 个「明确保留」的函数与测试未被修改
- [ ] db / api / web typecheck exit 0
- [ ] `bun run test:web` 全部通过
- [ ] biome 0 error
- [ ] `git status --porcelain` 只显示 in-scope 文件与 `plans/README.md`

## STOP conditions

Stop and report back (do not improvise) if:

- 任一符号出现计划外的调用方（生产、脚本、e2e、其他包）。
- 删除后同文件出现无法安全清理的未使用代码（需要重构其他函数）。
- `login-route.test.ts` 的 4 处 `Me` 使用无法直接替换为 `AuthMe`（例如依赖别名语义）。
- typecheck 在生产源码报错，且修复需要新增代码而不是删除。

## Maintenance notes

- 5 个保留函数是「生产不可达但被测试当夹具」的已知债务；若未来重写这些测试，可一并评估删除。
- 评审重点：3 个符号确实零引用；保留的测试块没有被顺手改动。
