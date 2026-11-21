# Plan 008: 首次入库失败后允许重解析手工文档

> **Executor instructions**: 严格按步骤执行；每步先跑验证命令并确认预期结果，再进入下一步。遇到「STOP conditions」立即停止并报告。完成后更新 `plans/README.md` 中本计划的 Status 行（除非派发者声明由他维护索引）。
>
> **Drift check（先跑）**: `git diff --stat 90a0ad2c..HEAD -- packages/db/src/repo/knowledge/versions.ts packages/api/src/modules/knowledge/use-cases/documents.ts packages/db/src/repo/knowledge/jobs.ts`
> 若有变化，先对照「Current state」；对不上按 STOP 处理。

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `90a0ad2c`, 2026-11-22

## Why this matters

手工上传的文档第一次入库失败（解析失败、格式不支持、embedding 服务抖动）时，没有任何版本行落库。`hasUnpublishedDraft` 目前把「manual + document + `currentVersionId === null`」一律当成有未发布草稿，于是「重解析」永远返回 409，而实际上既没有草稿可发布，也没有草稿可放弃。用户只能删除后重新上传。修复后，只有真实存在草稿版本或正在进行的入库任务才阻断重解析；失败的首次入库可以直接重试。

## Current state

以下为修复前基线。

- `packages/db/src/repo/knowledge/versions.ts:117-133`：
  ```ts
  export async function hasUnpublishedDraft(
    db: DbHandle,
    document: {
      id: string;
      sourceType: string;
      contentKind: string;
      currentVersionId: string | null;
    },
  ): Promise<boolean> {
    if (
      document.sourceType === 'manual' &&
      document.contentKind === 'document' &&
      document.currentVersionId === null
    ) {
      return true;
    }
    return (await latestUnpublishedDraft(db, document)) !== undefined;
  }
  ```
- `packages/db/src/repo/knowledge/versions.ts:95-115` — `latestUnpublishedDraft` 按 `document_id` + `metadata->>'publication' = 'draft'` 查真实草稿版本，已经覆盖「有草稿」的判定。
- `packages/api/src/modules/knowledge/use-cases/documents.ts:552-554`：
  ```ts
  if (await repo.knowledge.hasUnpublishedDraft(deps.db, row)) {
    throw new AppError('CONFLICT', '文档存在未发布的草稿，请先发布或放弃草稿后再重解析');
  }
  ```
- `packages/db/src/repo/knowledge/jobs.ts:47-64` — 已有的活跃任务查询（只匹配 `type='ingest'` 且 `status in ('queued','running')`）：
  ```ts
  export async function findActiveIngestJobId(
    db: Database,
    documentId: string,
  ): Promise<string | null> { /* ... */ }
  ```
- `packages/api/src/modules/knowledge/use-cases/search.ts:327-334` — 批量 `reprocess` 也走 `reprocessDocument`；只要单入口修好，批量入口自动一致。
- `packages/worker/src/knowledge/ingestion.ts:1358` 与 `versions.ts:313` 也调用 `hasUnpublishedDraft`。**不要把「活跃任务」判断放进 `hasUnpublishedDraft`**：worker 自己的 ingest 任务正在运行时会被自己判成活跃而自锁。

仓库约定：
- 业务冲突用 `AppError('CONFLICT', ...)`；单条与批量入口复用同一 use case。
- 改 repo 语义必须检查全部调用方：`grep -rn "hasUnpublishedDraft" packages --include="*.ts"`（当前三处）。

## Commands you will need

| 用途 | 命令 | 成功判据 |
|---|---|---|
| 安装 | `bun install --frozen-lockfile` | exit 0 |
| 构建共享包 | `bun run --filter @agentport/shared --filter @agentport/contract --filter @agentport/db --filter @agentport/core build` | exit 0 |
| 类型检查 | `bun run --filter @agentport/db typecheck`、`--filter @agentport/api typecheck` | exit 0 |
| 后端套件 | `bun run test -- packages/api/test/knowledge-publishing-integration.test.ts` | 全绿 |
| 格式 | `bunx biome check packages/db/src/repo/knowledge/versions.ts packages/api/src/modules/knowledge/use-cases/documents.ts` | 0 error |

> 后端测试需要 Docker PostgreSQL/Redis（见 `docs/OPERATIONS.md`）。

## Scope

**In scope**
- `packages/db/src/repo/knowledge/versions.ts`
- `packages/db/src/repo/knowledge/jobs.ts`（活跃任务查询）
- `packages/db/src/repo/knowledge/chunks.ts`（类型放宽）
- `packages/api/src/modules/knowledge/use-cases/documents.ts`
- `packages/api/src/modules/knowledge/use-cases/search.ts`（批量重解析入口，与单入口保持一致）
- `packages/worker/src/knowledge/ingestion.ts`（`runReindex` 跳过错失首次入库的手写文档）
- `packages/web/src/pages/knowledge/detail/documents-tab.tsx`（重解析入口的状态门槛提示）
- `packages/api/src/modules/knowledge/use-cases/jobs.ts`（任务重试复用文档锁与活跃任务检查）
- `packages/api/test/knowledge-management-routes.test.ts`（活跃任务门槛下的既有用例调整）
- `packages/web/test/knowledge-jobs.test.ts` / `packages/web/test/knowledge-harness.ts`（既有用例适配：文档夹具补齐 `disabledReason`）

**Out of scope**
- `versions.ts:313` 的 `forbidUnpublishedDraft` 写版本守卫语义（保持“真实草稿才拒绝”）。
- 新增“放弃草稿”接口（当前没有公开入口；本计划不扩大范围）。
- 修改 `latestUnpublishedDraft` 的查询。

## Git workflow

- worktree + 分支 `improve/008-reprocess-after-failed-ingest`。
- 提交信息示例：`fix(knowledge): 首次入库失败后允许重解析手工文档`
- 不 push、不开 PR，除非派发者明确要求。

## Steps

### Step 1: 收窄 `hasUnpublishedDraft`

把函数体改成只查真实草稿：
```ts
export async function hasUnpublishedDraft(
  db: DbHandle,
  document: {
    id: string;
    sourceType: string;
    contentKind: string;
    currentVersionId: string | null;
  },
): Promise<boolean> {
  return (await latestUnpublishedDraft(db, document)) !== undefined;
}
```
不要保留未使用的参数解构（`sourceType` / `contentKind` 仍属于签名的一部分，保持签名不变，避免改动三个调用方）。

**Verify**: `bun run --filter @agentport/db typecheck` → exit 0。

### Step 2: 在重解析入口加“活跃入库任务”门槛

在 `reprocessDocument` 的事务内、对文档行 `FOR UPDATE` 并重查全部条件后加：
```ts
if ((await repo.knowledge.findActiveReprocessJobId(tx, row.id)) !== null) {
  throw new AppError('CONFLICT', '文档有正在进行的处理任务，请稍后重试');
}
```
`findActiveReprocessJobId` 匹配 `type in ('ingest','reindex')` 的活跃任务，避免已有版本的文档连续重解析各建一个 `reindex`；检查必须用事务内的 `tx`，不能改用 `deps.db`。`findActiveIngestJobId` 仍只匹配 `ingest`，供 `manual-documents.ts` 读取待处理入库任务。顺序保持：先草稿（真实草稿优先提示发布/放弃），后活跃任务。不要把这个检查加到 `hasUnpublishedDraft`。

无版本手写文档（`sourceType='manual'`、`contentKind='document'`、`currentVersionId === null`）只在 `status === 'failed'` 时走 `ingest + publish:'draft'` 的首次恢复分支；其余状态（`pending` / `processing` / `ready`）一律返回 409（文案「文档正在首次入库，请稍后重试」），停用状态由前置检查拦截。其他类型或已有版本的文档通过前置检查后走 `reindex`。

**Verify**: `bun run --filter @agentport/api typecheck` → exit 0；`grep -rn "findActiveReprocessJobId" packages/api/src` → 2 处（重解析与任务重试）；`findActiveIngestJobId` 仍只有 `manual-documents.ts` 一处调用。

### Step 3: 现有测试回归

**Verify**:
- `bun run test -- packages/api/test/knowledge-publishing-integration.test.ts` → 全绿，尤其是 `:1494` 附近的成功重解析用例。
- `bun run test -- packages/api/test/knowledge-management-routes.test.ts` → 全绿。

### Step 4: 覆盖缺口（原 e2e 计划作废）

原计划的 e2e 用例已作废，本轮不新增系统级用例：

- `tests/knowledge.e2e.ts:169` 已覆盖正常的手工创建文档与任务展示；本轮不新增系统级用例。
- 既有用例也未覆盖「首次入库失败后重解析」「活跃任务返回 409」「并发重解析只建一条任务」三项。

## Test plan

- 不新增测试；回归依赖既有 `knowledge-publishing-integration.test.ts` 与 `knowledge-management-routes.test.ts`。
- 受影响路径是 `createManualDocument` 创建的 `sourceType='manual'` 文档（text/markdown，`publish: 'draft'`）。`knowledge-publishing-integration.test.ts` 的 `/reprocess` 用例实际针对一条已有版本的声音上传，断言返回 202；草稿拦截与首次失败恢复均无自动化覆盖，属已知覆盖缺口。
- 既有两个套件的既有断言必须保持通过；它们不覆盖草稿拦截与首次失败恢复，仅用于确认本次收窄没有让既有用例转为失败。
- 任务重试入口复用同一活跃任务门槛，但仅限单文档：`retryJob` 只在 `(payload.type === 'ingest' || payload.type === 'reindex') && row.documentId !== null` 时于事务内锁定文档并检查活跃任务。`row.documentId === null` 的批量重建（payload 携带 `documentIds`）仍走原 `enqueue` 路径，不做逐文档活跃检查，属已知例外。

## Done criteria

- [ ] `hasUnpublishedDraft` 中不再出现 `sourceType === 'manual'`。
- [ ] `reprocessDocument` 在草稿检查后调用 `findActiveReprocessJobId`。
- [ ] `grep -rn "hasUnpublishedDraft" packages --include="*.ts"` 仍为 3 个调用点（无新增/删除）。
- [ ] 两个后端套件全绿。
- [ ] `git status --short` 只含 Scope 内文件。
- [ ] `plans/README.md` 的 008 行状态已更新。

## STOP conditions

- `hasUnpublishedDraft` 或 `reprocessDocument` 与「Current state」摘录不符。
- 发现除 `reprocessDocument` 外还有用户可触发、绕过它的重解析入口。

## Maintenance notes

- 重解析的检查与建任务在同一事务内并对文档行 `FOR UPDATE`，防止并发重复入队。
- 事务内锁序为 `knowledge_bases` `FOR KEY SHARE` → `knowledge_documents` `FOR UPDATE`，与删除知识库的级联顺序一致，避免与删除并发时死锁。
- `hasUnpublishedDraft` 现在严格对应名字：只回答“是否存在未发布草稿”。活跃任务属于调用方判断。
- 批量重解析复用 `reprocessDocument`，未来新增入口也必须走它。
- 审查重点：`forbidUnpublishedDraft`（worker 写版本守卫）必须是“真实草稿才拒绝”，否则 ingest 会自锁。
