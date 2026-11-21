# Plan 009: FAQ 导入对话框改为批量取数，消除逐条请求风暴

> **Executor instructions**: 严格按步骤执行；每步先跑验证命令并确认预期结果，再进入下一步。遇到「STOP conditions」立即停止并报告。完成后更新 `plans/README.md` 中本计划的 Status 行（除非派发者声明由他维护索引）。
>
> **Drift check（先跑）**: `git diff --stat 90a0ad2c..HEAD -- packages/contract/src/knowledge.ts packages/api/src/modules/knowledge/use-cases/faq.ts packages/api/src/modules/knowledge/router.ts packages/db/src/repo/knowledge/jobs.ts packages/web/src/components/knowledge/knowledge-faq.tsx packages/web/src/lib/queries/knowledge-faq.ts`
> 若有变化，先对照「Current state」；对不上按 STOP 处理。

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED（对话框的恢复/发布门控逻辑复杂，改错会影响导入流程）
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `90a0ad2c`, 2026-11-22

## Why this matters

打开 FAQ 导入对话框时，组件先抽干全部 FAQ 分页，然后为**每一条** FAQ 发一个 `GET /knowledge/faqs/{id}`（500 条 base ≈ 500 个请求）。导入开始后，每个导入/恢复的 job 又各挂一个 2 秒轮询。这是列表页最重的请求扇出，浏览器和 API 同时承压。改成两个批量入口：一次取一页 FAQ 的草稿元数据（分块，每块 ≤100 个 id），一次取一组 job 状态；请求数与页大小/块大小相关，不再与条数线性增长。

## Current state

- `packages/web/src/components/knowledge/knowledge-faq.tsx:696-707` — 打开对话框即逐条取详情：
  ```ts
  const faqIds = existingItems.map((item) => item.id);
  const faqDetails = useKnowledgeFaqDraftVersions(faqIds, faqIds.length > 0);
  // ...
  const recovered = recoverBatches(faqDetails.map((query) => query.data))[0] ?? null;
  ```
- `packages/web/src/components/knowledge/knowledge-faq.tsx:791` — 导入完成后再逐条取详情（同样 N 个请求）。
- `packages/web/src/lib/queries/knowledge-faq.ts:127-136`：
  ```ts
  export function useKnowledgeFaqImportJobs(jobIds: string[]) {
    return useQueries({ queries: jobIds.map((jobId) => knowledgeJobQuery(jobId)) });
  }

  export function useKnowledgeFaqDraftVersions(documentIds: string[], enabled: boolean) {
    return useQueries({
      queries: documentIds.map((documentId) => ({
        queryKey: knowledgeKeys.faq(documentId),
        queryFn: () => api.knowledgeFaq(documentId),
        enabled,
        staleTime: 0,
      })),
    });
  }
  ```
- `packages/web/src/components/knowledge/knowledge-faq.tsx:636-662` — `recoverBatches(details)` 只读 `detail.document.id/title` 与 `detail.draftVersion.{id,createdAt,metadata}`。批量草稿接口返回同样字段即可复用。
- `packages/contract/src/knowledge.ts:1153-1160` — 单条详情的输出形状（批量接口复用 `knowledgeFaqVersionSchema`）：
  ```ts
  get: contractProcedure
    .route({ method: 'GET', path: '/knowledge/faqs/{documentId}' })
    .output(z.object({
      document: knowledgeFaqDocumentSchema,
      draftVersion: knowledgeFaqVersionSchema.nullable(),
      publishedVersion: knowledgeFaqVersionSchema.nullable(),
      faq: knowledgeFaqSchema.nullable(),
    })),
  ```
- `packages/contract/src/knowledge.ts:553-557` — job 列表查询，已支持分页与过滤，但没有按 id 批量取：
  ```ts
  const jobQuery = pageQuerySchema.extend({
    baseId: z.string().optional(),
    documentId: z.string().optional(),
    status: knowledgeJobStatusSchema.optional(),
  });
  ```
- `packages/api/src/modules/knowledge/use-cases/faq.ts:575-596` — `faqDetail` / `getFaq`；`latestFaqDraftVersion(deps, documentId, currentVersionId)` 是单文档草稿查询。
- `packages/api/src/modules/knowledge/use-cases/faq.ts:483-532` — `listFaqs` 已按页批量查 tags 与 versions，可作为批量查询的写法参考。
- `packages/db/src/repo/knowledge/jobs.ts` — `listJobs(filter)` 支持 `baseId/documentId/status`；加 `ids` 过滤即可。
- `packages/web/src/lib/queries/shared.ts:223-233` — `knowledgeJobQuery` 的 2 秒轮询与终态判断；批量 hook 必须保持同样的轮询与终态语义。

约定：
- 契约在 `@agentport/contract`，API 实现是薄适配（`router.ts` 调 `useCases`）；`access` 必须显式声明。
- 前端只经 `src/lib/queries/*` + `api` 调 JSON；服务端状态用 TanStack Query。
- 删除旧 hook 后不得留引用（零死代码）。

## Commands you will need

| 用途 | 命令 | 成功判据 |
|---|---|---|
| 安装 | `bun install --frozen-lockfile` | exit 0 |
| 构建共享包 | `bun run --filter @agentport/shared --filter @agentport/contract --filter @agentport/db --filter @agentport/core build` | exit 0 |
| 类型检查 | `bun run --filter @agentport/contract typecheck`、`--filter @agentport/db typecheck`、`--filter @agentport/api typecheck`、`--filter @agentport/web typecheck` | exit 0 |
| 后端套件 | `bun run test -- packages/api/test/knowledge-faq.test.ts`、`packages/api/test/knowledge-jobs.test.ts` | 全绿 |
| 前端测试 | `bun run test:web` | 全绿 |
| 布局契约 | `bun run lint:contract`、`bun run lint:focus` | exit 0 |
| 视觉验收 | `bun run visual:shots --full --route /knowledge` | 生成整页长图，无白屏/报错 |

## Scope

**In scope**
- `packages/contract/src/knowledge.ts`
- `packages/api/src/modules/knowledge/router.ts`
- `packages/api/src/modules/knowledge/use-cases/faq.ts`
- `packages/db/src/repo/knowledge/jobs.ts`
- `packages/web/src/lib/queries/knowledge-faq.ts`
- `packages/web/src/lib/queries/shared.ts`（只在需要新增批量 job hook 时）
- `packages/web/src/lib/api/knowledge.ts`（新增批量草稿 wrapper、给 `knowledgeJobs` 加 `ids`）
- `packages/web/src/components/knowledge/knowledge-faq.tsx`

**Out of scope**
- FAQ 列表页自身的 `useDrainPages`（`knowledge-faq.tsx:1457`）。
- 导入/发布的后端业务语义（版本、草稿、权限）。
- 其他页面的 job 轮询。
- 新的 UI 设计或布局调整；对话框视觉不变。

## Git workflow

- worktree + 分支 `improve/009-faq-import-batching`。
- 提交信息示例：`perf(web): FAQ 导入对话框改为批量取草稿与任务状态`
- 不 push、不开 PR，除非派发者明确要求。

## Steps

### Step 1: 新增批量草稿契约与用例

1. 在 `packages/contract/src/knowledge.ts` 的 `faqsContract` 增加：
   ```ts
   drafts: contractProcedure
     .route({ method: 'POST', path: '/knowledge/faqs/drafts' })
     .meta({ access: { kind: 'permission', permissionId: 'knowledge.read' } })
     .input(z.object({
       body: z.object({ documentIds: z.array(z.string().min(1)).min(1).max(200) }),
     }))
     .output(z.array(z.object({
       documentId: z.string(),
       draft: knowledgeFaqVersionSchema.nullable(),
     }))),
   ```
2. 在 `use-cases/faq.ts` 增加 `faqDrafts(deps, documentIds)`：
   - 一次查询取出这些 document 中可读的 FAQ 文档（复用 `listFaqDocuments` 里相同的 readable 过滤条件；不要逐条 `loadFaqDocument`）。
   - 一次查询取出这些 document 的最新 draft version（`metadata->>'publication' = 'draft'`，按 version desc 取每文档第一条）。
   - 返回 `[{ documentId, draft: toFaqVersion(row, false) }]`；不可读或不存在的 document 直接不出现在结果里（不泄露存在性）。
   - 空输入不可能出现（契约 min(1)）。
3. 在 `router.ts` 的 `faqs` handler 旁边注册 `drafts`，调用 `useCases.faqDrafts(depsOf(context), input.body.documentIds)`。

**Verify**: `bun run --filter @agentport/contract typecheck && bun run --filter @agentport/api typecheck` → exit 0；`bun run test -- packages/api/test/knowledge-faq.test.ts` → 全绿。

### Step 2: job 列表支持按 id 批量取

1. `packages/contract/src/knowledge.ts` 的 `jobQuery` 增加：
   ```ts
   ids: z.array(z.string().min(1)).max(200).optional(),
   ```
   现有 `folders`/`tags`/`kinds` 已经在 query 里传数组（`web/src/lib/api/knowledge.ts:604-607`），走同一套 oRPC 查询参数编码，无需新序列化方案。
2. `packages/db/src/repo/knowledge/jobs.ts` 的 `listJobs` 在 `ids` 非空时加 `inArray(knowledgeJobs.id, ids)`。
3. `packages/web/src/lib/api/knowledge.ts` 的 `knowledgeJobs(baseId, options)` 的 options 类型加 `ids?: string[]`，并透传：
   ```ts
   knowledgeJobs: (
     baseId: string,
     options: { documentId?: string; ids?: string[]; cursor?: string; limit?: number } = {},
     signal?: AbortSignal,
   ): Promise<KnowledgePage<KnowledgeJob>> =>
     rpc.knowledge.jobs.list({ query: { baseId, ...options } }, clientOptions(signal)),
   ```

**Verify**: `bun run --filter @agentport/contract typecheck && bun run --filter @agentport/db typecheck && bun run --filter @agentport/api typecheck` → exit 0；`bun run test -- packages/api/test/knowledge-jobs.test.ts` → 全绿。

### Step 3: web 批量 hook

在 `packages/web/src/lib/queries/knowledge-faq.ts`：

1. 先在 `packages/web/src/lib/api/knowledge.ts` 增加批量草稿 wrapper（放在 `knowledgeFaq` 旁）：
   ```ts
   knowledgeFaqDrafts: (
     documentIds: string[],
     signal?: AbortSignal,
   ): Promise<Array<{ documentId: string; draft: KnowledgeFaqVersion | null }>> =>
     rpc.knowledge.faqs.drafts({ body: { documentIds } }, clientOptions(signal)),
   ```
   类型 `KnowledgeFaqVersion` 从 `@agentport/contract/knowledge` 已有的导出取；若没有该导出，用 `KnowledgeFaqDetail['draftVersion']` 去掉 `null`。
2. 用分块辅助替换 `useKnowledgeFaqDraftVersions`：
   ```ts
   const BATCH = 100;
   function chunk<T>(items: T[], size = BATCH): T[][] {
     const out: T[][] = [];
     for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
     return out;
   }

   export function useKnowledgeFaqDrafts(documentIds: string[], enabled: boolean) {
     const chunks = chunk(documentIds);
     return useQueries({
       queries: chunks.map((ids) => ({
         queryKey: ['knowledge', 'faq-drafts', ...ids],
         queryFn: () => api.knowledgeFaqDrafts(ids),
         enabled: enabled && ids.length > 0,
         staleTime: 0,
       })),
     });
   }
   ```
   调用方需要的是 Map 形式的聚合结果。在本文件里导出固定形状，组件只读聚合对象：
   ```ts
   export interface FaqDraftSummary {
     byDocumentId: Map<string, KnowledgeFaqVersion | null>;
     complete: boolean;
     errorCount: number;
     retrying: boolean;
   }
   export function summarizeFaqDrafts(
     results: Array<{ data?: Array<{ documentId: string; draft: KnowledgeFaqVersion | null }>; isSuccess: boolean; isError: boolean; isFetching: boolean }>,
   ): FaqDraftSummary {
     const byDocumentId = new Map<string, KnowledgeFaqVersion | null>();
     for (const result of results) {
       for (const item of result.data ?? []) byDocumentId.set(item.documentId, item.draft);
     }
     return {
       byDocumentId,
       complete: results.length > 0 && results.every((r) => r.isSuccess && !r.isError && !r.isFetching),
       errorCount: results.filter((r) => r.isError).length,
       retrying: results.some((r) => r.isError && r.isFetching),
     };
   }
   ```
   注意：`complete` 的判定要与原 `detailsComplete` 等价（原来要求 `faqIds.length > 0`；请求为空时由调用方决定，不要把它当成“已加载”）。
3. 替换 `useKnowledgeFaqImportJobs`（需要 `baseId`，调用方已有）：
   ```ts
   export function useKnowledgeFaqImportJobs(baseId: string, jobIds: string[]) {
     const chunks = chunk(jobIds);
     return useQueries({
       queries: chunks.map((ids) => ({
         queryKey: ['knowledge', 'jobs', 'batch', baseId, ...ids],
         queryFn: () => api.knowledgeJobs(baseId, { ids, limit: ids.length }),
         enabled: ids.length > 0,
         retry: (failureCount, error) => !isMissingJob(error) && failureCount < 1,
         refetchInterval: (query) => {
           const items = query.state.data?.items;
           if (items === undefined) return 2_000;
           return items.every((job) => isTerminalKnowledgeJob(job.status)) ? false : 2_000;
         },
       })),
     });
   }
   ```
   组件需要的是 Map 形式的聚合结果。在同一文件导出固定形状：
   ```ts
   export interface FaqJobSummary {
     statuses: Map<string, string | undefined>;
     missing: Set<string>;
     error: boolean;
     retrying: boolean;
   }
   export function summarizeFaqJobs(
     results: Array<{ data?: { items: Array<{ id: string; status: string }> }; error?: unknown; isError: boolean; isFetching: boolean }>,
     jobIds: string[],
   ): FaqJobSummary {
     const byId = new Map<string, string>();
     for (const result of results) for (const job of result.data?.items ?? []) byId.set(job.id, job.status);
     return {
       statuses: new Map(jobIds.map((id) => [id, byId.get(id)])),
       missing: new Set(jobIds.filter((id) => !byId.has(id))),
       error: results.some((r) => r.isError && !isMissingJob(r.error)),
       retrying: results.some((r) => r.isError && r.isFetching),
     };
   }
   ```
   `missing` 的语义要与原 `recoveredJobsMissing`/`recoveredMissingIds` 等价：列表返回里没有该 id 就视为缺失。原逻辑用单条查询的 404 判定缺失；批量列表不会 404，缺 id 即等价。
4. 删除不再被引用的旧 `knowledgeJobQuery` 用法（仅本文件的调用方迁移后）；`knowledgeJobQuery` 仍被 `knowledge-documents.ts` 使用，**不要删**。

**Verify**: `bun run --filter @agentport/web typecheck` → exit 0。

### Step 4: 改造对话框

在 `packages/web/src/components/knowledge/knowledge-faq.tsx`：

1. 删除 `faqIds` / `faqDetails` 与由它派生的 `detailsComplete`、`detailErrorCount`、`detailsRetrying`；`recoveryReadReady` 改为只依赖 `existingComplete` 与批量草稿结果。
2. `recoverBatches` 的输入改为批量结果：`Array<{ documentId: string; draft: KnowledgeFaqVersion | null }>`，内部逻辑不变（仍读 `draft.metadata.faqImport` 与 `draft.metadata.faqImportJobId`，仍用 `draft.id`/`draft.createdAt`；`documentId`/`title` 从 `existingItems` 的 Map 取）。
3. 导入完成后的 `details`（`:791`）改用 `useKnowledgeFaqDrafts(documentIds, jobsOk)`；`publishItems` 从聚合 Map 取 draft。
4. 两处 `useKnowledgeFaqImportJobs` 的调用点改为消费第 3 步的聚合结果；保持原有门控：
   - `recoveredReady` 要求每个成员 job 状态为 `succeeded`；
   - `recoveredStatusLoading`、`recoveredWaiting`、`retryTargets` 的语义不变；
   - `jobsOk`、`jobsSettled`、`jobsPending` 的语义不变。
5. 删除 `queries/knowledge-faq.ts` 中不再使用的 `useKnowledgeFaqDraftVersions` 与旧 `useKnowledgeFaqImportJobs` 实现；`grep` 确认零引用。

**Verify**: `bun run --filter @agentport/web typecheck` → exit 0；`bun run test:web` → 全绿。

### Step 5: 验证请求数与 UI

1. 请求数：在浏览器 Network 或 devtools 中打开一个含 ≥200 条 FAQ 的 base 的导入对话框；确认打开时只有 **1–3 个** `faq-drafts` 请求（按 100 分块），不再是每 FAQ 一个 `/knowledge/faqs/{id}`。
2. 视觉验收（硬性）：`bun run visual:shots --full --route /knowledge`，用真实登录与隔离库，产出整页长图；核对无白屏/运行时报错、无横向溢出、对话框布局与文案未变。若种子数据没有可用 base，先跑 `bun run db:seed` 或在验收记录中写明原因。
3. 记录：截图目录、路由、视口、commit。

**Verify**: 上述命令与实际截图；Network 请求数记录。

## Test plan

- 不新增单测/集成测试（仓库规则）；批量草稿与批量 job 的正确性由现有 `knowledge-faq.test.ts`、`knowledge-jobs.test.ts` 回归 + 实际请求记录覆盖。
- 前端 `test:web` 全绿；对话框的手工验收覆盖：无进度的普通导入、有历史批量导入的恢复、失败 job 的重试、发布步骤。
- 若现有前端测试直接断言旧 hook 的逐条查询次数，先报告；不要为了让测试通过而保留双路径。

## Done criteria

- [ ] `grep -rn "useKnowledgeFaqDraftVersions" packages/web/src` 返回空。
- [ ] `grep -n "documentIds.map" packages/web/src/lib/queries/knowledge-faq.ts` 返回空。
- [ ] 打开含 ≥200 FAQ 的 base 时，`faq-drafts` 请求数 ≤3（记录 Network 截图/计数）。
- [ ] 导入期间 job 请求数为分块数（≤3），不是每条 job 一个。
- [ ] `bun run --filter @agentport/web typecheck`、`bun run test:web`、`bun run lint:contract`、`bun run lint:focus` 全部通过。
- [ ] 视觉验收截图已产出并记录。
- [ ] `git status --short` 只含 Scope 内文件。
- [ ] `plans/README.md` 的 009 行状态已更新。

## STOP conditions

- `knowledge-faq.tsx` 的恢复/发布门控与「Current state」摘录差异较大，无法在不改变行为的前提下替换数据源。
- 批量草稿需要跨知识库读取才能实现（说明单条详情里有本计划没有的权限/范围逻辑）。
- 现有前端测试依赖逐条查询的调用次数。
- 视觉验收发现对话框布局或交互变化；本计划不允许改视觉。
- 需要修改导入/发布的后端业务规则才能完成。

## Maintenance notes

- 未来新增 FAQ 详情读取时必须走 `faqDrafts` 批量入口，避免重新引入逐条 GET。
- 分块大小 100 与契约的 `max(200)` 绑定；调大前同步契约。
- 审查重点：`recoveredReady` / `jobsOk` / `publishItems` 三个门控必须与改动前等价；请求数下降不能以放宽“只有全部 job 成功才允许发布”为代价。
