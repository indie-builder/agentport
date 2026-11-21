# Plan 013: 知识批量操作改为批量取数，消除逐条查询

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 321cf491..HEAD -- packages/api/src/modules/knowledge/http.ts packages/api/src/modules/knowledge/use-cases/search.ts packages/api/src/modules/knowledge/use-cases/faq.ts packages/db/src/repo/knowledge/documents.ts packages/db/src/repo/knowledge/versions.ts`
> On any mismatch with the excerpts below, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `321cf491`, 2026-11-22

## Why this matters

知识库的批量下载最多 200 个文档，但每个文档都要 `getDocument` + `getVersion` 两次串行查询，然后串行读取内容；批量标签等操作对 100 个文档逐个 `getDocument`，即使标签仓库已经支持一次查多个 ID。一次批量操作会产生数百次串行 DB 往返。改为按 ID 批量取文档与版本、标签一次取全，再保留逐项结果与错误语义，请求耗时与连接占用都会明显下降。

## Current state

- `packages/api/src/modules/knowledge/http.ts:154-183` — 批量下载：逐文档 `getDocument`、`getVersion`，再逐文件读取，最后同步 `zipSync`。
- `packages/api/src/modules/knowledge/use-cases/search.ts:286-313` — 批量操作：逐文档 `getDocument`；标签动作逐文档 `getDocumentTagNames([id])`。
- `packages/api/src/modules/knowledge/use-cases/faq.ts:778-796` — FAQ 批量操作逐条 `getDocument`。
- `packages/db/src/repo/knowledge/tags.ts:204-220` — `getDocumentTagNames` 已接受 `string[]` 并返回 `Map`。
- `packages/db/src/repo/knowledge/documents.ts:58-64` — `getDocument` 只按单 ID 查询。
- `packages/db/src/repo/knowledge/versions.ts:167-175` — `getVersion` 只按单 ID 查询。

批量下载关键代码：

```ts
      const downloadable: Array<{ versionId: string }> = [];
      let declaredBytes = 0;
      for (const documentId of parsed.data.documentIds) {
        const document = await repo.knowledge.getDocument(context.db, documentId);
        if (!document || document.baseId !== id) {
          throw new AppError('NOT_FOUND', '文档不存在或不属于该知识库');
        }
        if (!document.currentVersionId) continue;
        if (document.status === 'disabled' || document.disabledReason !== null) continue;
        const version = await repo.knowledge.getVersion(context.db, document.currentVersionId);
        if (!version) continue;
        declaredBytes += version.sizeBytes;
        downloadable.push({ versionId: document.currentVersionId });
      }
```

```ts
      for (const item of downloadable) {
        const content = await useCases.getVersionContent(deps, item.versionId);
        actualBytes += content.data.length;
        if (actualBytes > BATCH_DOWNLOAD_MAX_BYTES) {
          throw new AppError('PAYLOAD_TOO_LARGE', '所选文档原件合计超过 64MiB 上限');
        }
        entries[uniqueZipName(content.filename, usedLower)] = new Uint8Array(content.data);
      }
```

批量标签代码：

```ts
      } else if (input.action === 'tag') {
        const currentNames =
          (await repo.knowledge.getDocumentTagNames(deps.db, [document.id])).get(document.id) ?? [];
```

FAQ 批量代码：

```ts
  for (const item of input.items) {
    const document = await repo.knowledge.getDocument(deps.db, item.documentId).catch(() => null);
    if (!document || document.baseId !== base.id || document.contentKind !== 'faq') {
```

仓库约定（`packages/db/AGENTS.md`）：共享查询放 `src/repo/`；含用户内容的读取按主体过滤。本次只按 ID 取行，调用方已在入口完成 `baseId` 归属校验。

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install --frozen-lockfile` | exit 0 |
| Build shared deps before backend tests | `bun run --filter @agentport/shared --filter @agentport/core --filter @agentport/db build` | exit 0 |
| DB typecheck | `bun run --filter @agentport/db typecheck` | exit 0 |
| API typecheck | `bun run --filter @agentport/api typecheck` | exit 0 |
| Knowledge tests | `bun run test -- <rg 命中的知识库测试文件>` | all pass, 0 skip |
| Format/lint (read-only) | `bunx biome check <修改文件>` | 0 error |

## Scope

**In scope**:
- `packages/db/src/repo/knowledge/documents.ts`
- `packages/db/src/repo/knowledge/versions.ts`
- `packages/api/src/modules/knowledge/http.ts`
- `packages/api/src/modules/knowledge/use-cases/search.ts`
- `packages/api/src/modules/knowledge/use-cases/faq.ts`

**Out of scope**:
- `getDocumentTagNames` 本身 — 已支持数组，不改。
- ZIP 生成方式与 64MiB 上限 — 不变；`zipSync` 的既有 shortcut 保留。
- 文档归属、权限、错误码与逐项结果形状 — 不变。
- 前端、契约、队列。

## Git workflow

- 在 `.claude/worktrees/<slug>` 内工作，分支名用 ASCII slug。
- 提交信息示例：`perf(knowledge): 批量下载与批量操作改为按 ID 取数`。
- 不推送、不开 PR，除非操作者明确要求。

## Steps

### Step 1: 增加按 ID 批量读取的 repo 方法

在 `packages/db/src/repo/knowledge/documents.ts` 增加：

```ts
export async function getDocumentsByIds(
  db: Database,
  ids: string[],
): Promise<Map<string, KnowledgeDocumentRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(knowledgeDocuments)
    .where(inArray(knowledgeDocuments.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}
```

在 `packages/db/src/repo/knowledge/versions.ts` 增加同样形状的：

```ts
export async function getVersionsByIds(
  db: Database,
  ids: string[],
): Promise<Map<string, KnowledgeVersionRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(knowledgeVersions)
    .where(inArray(knowledgeVersions.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}
```

按文件现有导入与表名调整（`knowledgeDocuments` / `knowledgeVersions` 的实际导出名以当前文件为准）。不要新增抽象层。

**Verify**: `bun run --filter @agentport/db typecheck` → exit 0。

### Step 2: 批量下载改为两次批量查询

在 `packages/api/src/modules/knowledge/http.ts`：

1. 一次取齐文档：

```ts
      const documents = await repo.knowledge.getDocumentsByIds(context.db, parsed.data.documentIds);
      const downloadable: Array<{ versionId: string }> = [];
      const versionIds: string[] = [];
      let declaredBytes = 0;
      for (const documentId of parsed.data.documentIds) {
        const document = documents.get(documentId);
        if (!document || document.baseId !== id) {
          throw new AppError('NOT_FOUND', '文档不存在或不属于该知识库');
        }
        if (!document.currentVersionId) continue;
        if (document.status === 'disabled' || document.disabledReason !== null) continue;
        versionIds.push(document.currentVersionId);
      }
      const versions = await repo.knowledge.getVersionsByIds(context.db, versionIds);
      for (const versionId of versionIds) {
        const version = versions.get(versionId);
        if (!version) continue;
        declaredBytes += version.sizeBytes;
        downloadable.push({ versionId });
      }
```

2. 内容读取保持串行，但每次读取后立即累计并检查实际字节：

```ts
      for (const item of downloadable) {
        const content = await useCases.getVersionContent(deps, item.versionId);
        actualBytes += content.data.length;
        if (actualBytes > BATCH_DOWNLOAD_MAX_BYTES) {
          throw new AppError('PAYLOAD_TOO_LARGE', '所选文档原件合计超过 64MiB 上限');
        }
        entries[uniqueZipName(content.filename, usedLower)] = new Uint8Array(content.data);
      }
```

本次只兑现批量 DB 查询收益；文件读取并发不在本计划范围。保留 `downloadable.length === 0` 的既有错误、64MiB 声明值与实际值双检查、`zipSync` 与 `attachmentResponse` 不变。

**Verify**: `bun run --filter @agentport/api typecheck` → exit 0。

### Step 3: 批量操作与 FAQ 批量操作复用一次性文档查询

在 `packages/api/src/modules/knowledge/use-cases/search.ts`：

1. 循环前取一次：

```ts
  const documents = await repo.knowledge.getDocumentsByIds(deps.db, input.documentIds);
```

2. 循环内 `repo.knowledge.getDocument(deps.db, documentId)` 改为 `documents.get(documentId)`。
3. 标签动作在循环前取一次所有标签：

```ts
  const tagNames = input.action === 'tag' ? await repo.knowledge.getDocumentTagNames(deps.db, input.documentIds) : null;
```

循环内改为 `tagNames?.get(document.id) ?? []`。

在 `packages/api/src/modules/knowledge/use-cases/faq.ts`：

1. 循环前取一次 `const documents = await repo.knowledge.getDocumentsByIds(deps.db, input.items.map((item) => item.documentId)).catch(() => new Map());`
2. 循环内 `getDocument(...).catch(() => null)` 改为 `documents.get(item.documentId)`。

逐项 `results` 的顺序、`failed` 文案与后续写入逻辑完全不变。

**Verify**: `bun run --filter @agentport/api typecheck` → exit 0。

### Step 4: 运行知识库相关套件

```bash
bun run --filter @agentport/shared --filter @agentport/core --filter @agentport/db build
rg -l 'batch|批量|batchDownload|batchDocuments|faq.*batch' packages/api/test packages/db/test packages/worker/test -g '*.ts'
```

对命中的知识库套件逐个 `bun run test -- <file>`。至少覆盖批量下载、批量文档操作、FAQ 批量操作。

**Verify**: 所有命中套件通过，0 skip；`bunx biome check` 对 in-scope 文件 0 error。

## Test plan

- 不新增测试（根 `AGENTS.md`）。
- 现有知识库批量套件验证响应形状、逐项错误与 64MiB 上限；本次不改这些语义。
- 评审重点：批量查询没有放宽 `baseId` 归属与 `contentKind` 校验；并发读取没有打乱 ZIP 条目顺序或重复文件名处理。

## Done criteria

- [ ] `getDocumentsByIds`、`getVersionsByIds` 已加入对应 repo 文件并在三处调用
- [ ] 批量下载不再逐文档调用 `getDocument` / `getVersion`
- [ ] 标签批量操作只调用一次 `getDocumentTagNames`
- [ ] FAQ 批量操作只调用一次 `getDocumentsByIds`
- [ ] 既有 64MiB 上限、逐项结果、错误文案保持不变
- [ ] 命中的知识库测试套件全部通过，0 skip
- [ ] db / api typecheck exit 0；biome 0 error
- [ ] `git status --porcelain` 只显示 in-scope 文件与 `plans/README.md`

## STOP conditions

Stop and report back (do not improvise) if:

- 三处调用点的代码与上面的 excerpt 不一致。
- `getDocument` 或 `getVersion` 除按 ID 外还承担了额外过滤（例如软删除、版本状态），批量查询会绕过它。
- 知识库套件断言了逐个查询的调用次数或顺序（mock 计数），批量化会使其失败且不能通过调整夹具解决。
- 有测试证明并发读取会与内容存储的生命周期冲突。

## Maintenance notes

- 批量方法只按 ID 返回行，不做归属过滤；归属校验仍在调用方入口，新增调用方必须保持这一点。
- 若批量上限提高，重新评估串行读文件的总耗时与内存峰值；ZIP 仍在请求线程同步压缩，这是既有 shortcut。
- 未来若 `getDocument` 增加软删除过滤，必须同步 `getDocumentsByIds`。
