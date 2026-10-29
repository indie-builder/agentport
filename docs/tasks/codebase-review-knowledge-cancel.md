# 知识首次摄取取消后残留 processing

## 目标

取消（`KnowledgeCancelled`）发生在文档首次摄取期间时，`runIngest` 直接重抛，绕过文档状态收尾，使没有当前版本的文档永久停在 `processing`。修复后：

- 首次摄取取消：文档落 `failed`，不产生版本/chunk 半发布。
- 已有当前版本的重新摄取取消：文档保持 `ready`，旧版本与 chunks 仍可查，新版本不切换。
- 其他异常与成功路径行为不变；仍原样抛出 `KnowledgeCancelled`，由队列写 `cancelled`。

## 方案

`runIngest` 的 `catch` 不再对 `KnowledgeCancelled` 提前重抛，而是与普通失败共用同一次文档状态收尾：

- `document.currentVersionId` 为空 → `failed`；
- 已有当前版本 → `ready`（旧版本保留）；
- 收尾后原样 `throw err`，不吞错、不新增文档状态枚举、不改迁移。

版本切换的原子守卫在 `ingestContent` 内，取消仍走原有守卫，不触碰。

## 基线与范围

- 起点 commit：`e060e3a`（`worktree-codebase-review-loop`）。
- 开工时已存在大量未提交差异（跨层 schema 迁移、web/其他 review 任务），归属其他在途工作，不提交、不还原、不覆盖。
- 本任务独占：
  - `packages/worker/src/knowledge/ingestion.ts`
  - `packages/worker/test/knowledge-ingestion.test.ts`
  - `docs/tasks/codebase-review-knowledge-cancel.md`
- 不改：knowledge queue/reconcile、DB schema/迁移、shared、其他记录或源码。

## 当前有效决定

- 取消也走既有状态收尾（首次 `failed`、有已发布版本 `ready`），随后原样抛 `KnowledgeCancelled` 供队列标 `cancelled`。
- 不新增 `cancelled` 文档状态、不改 DB/shared。
- 测试用 backend globalSetup 的独立 PG/Redis，不共享数据；基础设施不可用时整套 skip。
- 已验收：主会话完整套件 37 passed / 0 skipped、exit 0（输出任务 `bgd3kic5p`）；独立 Opus review `a3a79` 通过。

## 已替代项及原因

无。

## 步骤

- [x] 先写任务记录，固定基线与独占范围。
- [x] 红：把首次取消用例断言为真实终态 `failed`，确认现状失败。
- [x] 绿：移除 `runIngest` 对 `KnowledgeCancelled` 的提前重抛，复用既有状态收尾。
- [x] 补断言：已有当前版本时取消 → `ready` + 旧版本/chunks 不变 + 无新版本切换。
- [x] 跑 `knowledge-ingestion` 相关套件、worker typecheck、biome。
- [x] 记录验证结果与限制。
- [x] 独立 Opus review（a3a79）通过；主会话复跑确认并验收。

## 改动文件

- `packages/worker/src/knowledge/ingestion.ts`
- `packages/worker/test/knowledge-ingestion.test.ts`
- `docs/tasks/codebase-review-knowledge-cancel.md`

## 下一步

红绿完成；主会话完整套件 37 passed / 0 skipped、exit 0（输出任务 `bgd3kic5p`），独立 Opus review a3a79 通过；已验收。

## 验证

红（改源码前，首次取消用例）：

```bash
pnpm exec vitest run packages/worker/test/knowledge-ingestion.test.ts --project backend \
  -t "stops after cancellation without writing a version"
```

结果：`1 failed`，`AssertionError: expected 'processing' to be 'failed'`，失败原因与缺陷一致。

绿（改源码后，两个取消用例）：

```bash
pnpm exec vitest run packages/worker/test/knowledge-ingestion.test.ts --project backend \
  -t "stops after cancellation|keeps the published version ready"
```

结果：`2 passed | 35 skipped`。

完整套件：

```bash
pnpm exec vitest run packages/worker/test/knowledge-ingestion.test.ts --project backend
```

结果：`37 passed (37)`，使用 backend globalSetup 的独立随机 PG 与临时 Redis。

主会话复跑与独立 review（验收）：

- 主会话复跑完整套件（同上命令）→ 37 passed / 0 skipped，exit 0，输出任务 `bgd3kic5p`。
- 独立 Opus review `a3a79` 通过：首次摄取取消落 `failed`，已有当前版本的重新摄取取消保持 `ready`，旧版本与 chunks/向量保留；错误仍原样抛出，由队列写 `cancelled`。

类型检查：

```bash
pnpm --filter @agentport/worker typecheck
```

结果：`tsc -b` 通过，无输出错误。

Biome：

```bash
./node_modules/.bin/biome check packages/worker/src/knowledge/ingestion.ts \
  packages/worker/test/knowledge-ingestion.test.ts
```

结果：`Checked 2 files in 29ms. No fixes applied.`（exit 0）。

限制：

- 本 worktree 的 `pnpm exec biome` 会因环境侧 `Command "eslint" not found` 返回 exit 1，改用实际二进制 `./node_modules/.bin/biome` 校验；两者都指向 2.6.3，直接运行无诊断。
- 未跑全仓 build/typecheck，未迁移共享库；按任务要求避开在途跨层 schema 迁移。
- 未改 `runReindex` 的同类取消分支：本次缺陷与用户指定范围限定 `runIngest` 首次摄取；如后续确认 reindex 无版本文档取消也需落 `failed`，另开任务。
