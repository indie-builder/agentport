# Plan 016: 删除生产不可达的导出与只测到自身的测试

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 321cf491..HEAD -- packages/db/src/repo packages/api/src/modules/memory/journal.ts packages/web/src/lib/api/auth.ts`
> On any mismatch with the excerpts below, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `321cf491`, 2026-11-22

## Why this matters

仓库规则要求零死代码。当前有一批导出只被测试引用（或完全无引用）：测试它们等于测试一个生产路径永远到不了的函数，制造虚假覆盖，也让公开面看起来比实际更大。删除后，测试只保留真实可达行为。

## Current state

已核实「定义 + 仅测试调用」的符号：

| 符号 | 定义 | 非测试调用 |
|---|---|---|
| `listDataDomains` | `packages/db/src/repo/data-domains.ts:79` | 无 |
| `getById` | `packages/db/src/repo/tool-approval-policies.ts:59` | 无 |
| `changeOwnPassword` | `packages/db/src/repo/accounts.ts:291` | 无（只有 `packages/db/test/access.test.ts:460,466`） |
| `updateProgress` | `packages/db/src/repo/eval.ts:304` | 无（只有测试） |
| `memorySha256` | `packages/api/src/modules/memory/journal.ts:43` | 无（只有 `packages/api/test/memory-reviews.test.ts`） |
| `replaceRanges` | `packages/db/src/repo/knowledge/sources.ts:271` | 无（只有 db/worker 测试） |
| `getDocumentTagRows` | `packages/db/src/repo/knowledge/tags.ts:188` | 无（只有 `packages/worker/test/knowledge-tagging.test.ts`） |
| `rollbackWikiPage` | `packages/db/src/repo/knowledge/wiki.ts:188` | 无（只有 `packages/db/test/knowledge-foundation.test.ts`） |
| `listReadableDocuments` | `packages/db/src/repo/knowledge/documents.ts:423` | 无（只有 `knowledge-foundation.test.ts`） |
| `Me`（类型别名） | `packages/web/src/lib/api/auth.ts:14` | 无（只有 `packages/web/test/login-route.test.ts` 导入） |

相关测试文件：

- `packages/db/test/access.test.ts`
- `packages/db/test/guards.test.ts`
- `packages/api/test/eval-cancel.test.ts`
- `packages/worker/test/eval-snapshot.test.ts`（`updateProgress` 只作为 mock 对象字段出现）
- `packages/api/test/memory-reviews.test.ts`
- `packages/db/test/knowledge-foundation.test.ts`
- `packages/worker/test/knowledge-integrity-regressions.test.ts`
- `packages/worker/test/knowledge-tagging.test.ts`
- `packages/web/test/login-route.test.ts`

`Me` 的来源是 `AuthMe`，由 `@agentport/shared` 导出（`packages/shared/src/personal.ts:34`，并经 `src/index.ts` 再导出）。

仓库约定：删除前用 `rg` 确认引用；删除后跑 typecheck 确认没断；不新增注释与测试。

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install --frozen-lockfile` | exit 0 |
| Build shared deps | `bun run --filter @agentport/shared --filter @agentport/core --filter @agentport/db build` | exit 0 |
| DB typecheck | `bun run --filter @agentport/db typecheck` | exit 0 |
| API typecheck | `bun run --filter @agentport/api typecheck` | exit 0 |
| Worker typecheck | `bun run --filter @agentport/worker typecheck` | exit 0 |
| Web typecheck | `bun run --filter @agentport/web typecheck` | exit 0 |
| Affected backend suites | `bun run test -- <本计划列出的测试文件>` | all pass, 0 skip |
| Web tests | `bun run test:web` | all pass |
| Format/lint (read-only) | `bunx biome check <modified files>` | 0 error |

## Scope

**In scope**:
- 上表 10 个定义所在文件
- 上表列出的 9 个测试文件

**Out of scope**:
- 任何生产调用方 — 若发现非测试调用方，STOP。
- `getDocumentTagNames`、`bufferSha256`、`dataDomainRows` 以外的同类函数 — 只删除确认死掉的。
- 不重构仍在使用的函数，不为删除后留下的文件做额外整理。

## Git workflow

- 在 `.claude/worktrees/<slug>` 内工作，分支名用 ASCII slug。
- 提交信息示例：`refactor: 删除生产不可达的导出与只测自身的用例`。
- 不推送、不开 PR，除非操作者明确要求。

## Steps

### Step 1: 逐个复核调用方（不改代码）

对每个符号运行：

```bash
rg -n "\bSYMBOL\b" packages --glob '!node_modules' -g '*.ts' -g '*.tsx'
```

判定：除定义行外，命中必须全部位于本计划列出的测试文件中。任何其他命中（包括脚本、e2e、其他包）都是 STOP 条件。

对 `Me` 使用 `rg -n '\bMe\b' packages/web`，预期只有 `auth.ts` 定义与 `login-route.test.ts` 导入/使用。

**Verify**: 上表每个符号的 `rg` 输出与预期一致。

### Step 2: 删除定义

从对应 repo 文件删除完整函数（含 JSDoc，若有）。删除 `Me` 别名。删除后检查同文件是否有只被该函数使用的私有 helper 或 import；若有，一并删除，避免留下死代码（例如 `data-domains.ts` 的 `dataDomainRows` 若因此不再被使用）。不要删除仍在其他函数中使用的 import。

**Verify**: `bun run --filter @agentport/db typecheck` 与 `bun run --filter @agentport/api typecheck` 仅在测试相关文件报错（下一步处理）；生产源码不再报错。

### Step 3: 删除只测试这些符号的用例

对每个列出的测试文件：

1. `rg -n '\bSYMBOL\b' <file>` 定位。
2. 逐行阅读命中位置前后的 `it(...)` / `describe(...)` 块，确认该块**只在验证被删符号**。
3. 只删除这样的断言块。用于构造测试数据、登录、创建文档的 helper 与 setup 即使提到该符号名，只要它们服务其他用例，也必须保留。
4. 如果块同时断言其他生产行为、或删除后文件不再有任何用例，STOP 并报告该文件与行号。
5. 删除因此不再使用的 import；不要重写、放宽或替换断言，也不要把测试改成调用另一个生产函数来“保住覆盖”。

**Verify**: 对每个文件运行 `bun run test -- <file>` → 全部通过；若文件被整体清空，`git rm` 该文件并说明。

### Step 4: `Me` 类型替换

在 `packages/web/test/login-route.test.ts` 把 `type Me` 导入改为 `type AuthMe`（来自 `@agentport/shared`），替换 4 处使用；删除 `packages/web/src/lib/api/auth.ts` 的 `Me` 别名与随之未使用的 `AuthMe` 导入（若文件其他位置不再使用）。

**Verify**: `bun run --filter @agentport/web typecheck` → exit 0；`bun run test:web` → all pass。

### Step 5: 完整验证

```bash
bun run --filter @agentport/shared --filter @agentport/core --filter @agentport/db build
bun run --filter @agentport/db typecheck
bun run --filter @agentport/api typecheck
bun run --filter @agentport/worker typecheck
bun run --filter @agentport/web typecheck
bun run test -- packages/db/test/access.test.ts packages/db/test/guards.test.ts packages/db/test/knowledge-foundation.test.ts packages/api/test/eval-cancel.test.ts packages/api/test/memory-reviews.test.ts packages/worker/test/eval-snapshot.test.ts packages/worker/test/knowledge-integrity-regressions.test.ts packages/worker/test/knowledge-tagging.test.ts
bun run test:web
```

全部通过，0 skip。

## Test plan

- 不新增测试（根 `AGENTS.md`）。
- 删除的用例只覆盖被删符号；其余断言不变。
- `login-route.test.ts` 的类型替换不改测试行为。

## Done criteria

- [ ] 上表 10 个符号在本仓库无定义、无引用
- [ ] 每个被删测试块只涉及被删符号
- [ ] `rg` 复核无生产调用方
- [ ] 四个包 typecheck exit 0
- [ ] 列出的后端套件与 `test:web` 全部通过，0 skip
- [ ] `git status --porcelain` 只显示 in-scope 文件与 `plans/README.md`

## STOP conditions

Stop and report back (do not improvise) if:

- 任一符号出现本计划未列出的调用方（生产、脚本、e2e、其他包）。
- 某个测试块混合验证被删符号与其他生产行为。
- 删除 `changeOwnPassword` 后发现 better-auth 账户改密路径实际依赖它。
- 删除 `getDocumentTagRows` / `replaceRanges` 后发现 worker 通过动态属性访问使用它们。
- 删除后 typecheck 在生产源码报错，且修复需要新增代码而不是删除。

## Maintenance notes

- 这次删除的是「测试专用导出」；未来若要测试同类 repo 行为，应通过真实生产调用方或系统级 E2E，而不是重新导出生产不可达函数。
- 评审重点：每个删除的测试块确实只测被删符号；没有借机简化仍在使用函数的断言。
- 如果后续新增「Wiki 回滚」「原范围替换」「可读文档列举」等真实功能，需要重新设计并接入生产调用方，不要从 git 历史恢复未使用的实现。
