# 手写逻辑简化：第七轮

## 目标

将 Wiki 来源可用性筛选交给现有 SQL，减少读回字段和 JS 处理，保留人工保存及发布规则。用户授权提交 PR 并合并、删除合并工作区、更新 main。

## 方案

Opus 并行探索查询与定时任务。定时任务已用 BullMQ 原生能力，保持现状。查询候选固定后由 Sonnet 实施与回归；独立 Opus 评审及隔离数据库验证通过后交付。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport-worktrees/native-logic-round-7`
- 分支：`refactor/native-logic-round-7`
- 起始 origin/main：`4fcf101f79c80c9a1b14a227b5b15c9acd6606b7`
- 本树初始差异为空。主 checkout 原有 `.vitest/json/output.json` 差异不属于本轮。
- 允许：`packages/db/src/repo/knowledge.ts` 的 usableSourceChunks、`packages/api/test/knowledge-wiki-routes.test.ts` 的针对性回归、本记录；确需独立 db 测试时先补记录范围。
- 不改 schema、索引、依赖或迁移；不动其他工作区，包括第六轮未提交检查记录和 skill-provenance。

## 当前有效决定

- 用户已授权 commit/push/PR/merge，无需再次确认；主会话不写源码测试，Sonnet 实施，Opus 独立评审。
- usableSourceChunks 将 enabled=true、document.status=ready、chunk.versionId=document.currentVersionId 放入现有 where；仅选择 chunkId/documentId/versionId 三列，删除 JS filter/map。
- 保留 Set 去重、空输入短路、baseId 限制和 wanted.size-usable.length；当前版本 NULL 与旧版本均不可用。
- 人工编辑无效来源仍保存但 stale；发布无效来源仍冲突，事务和权限边界不改。
- 仅减少传回行/列和 JS 工作，不宣称查询次数、数据库扫描或端到端耗时减少。
- 不触发或等待 CI，不启动 PR 监控，不改共享服务、配置或用户登录态。
- 执行子代理只在本树内实施，不再派发或自行提交，属于主会话分工；用户原有 commit/push/PR/merge 授权保持有效。
- 验证使用本轮专用 `DATABASE_URL=postgres://round7:***@127.0.0.1:51767/round7`、`REDIS_URL=redis://127.0.0.1:51769/9`，不读主 `.env`。

## 已替代项及原因

无。

## 步骤

- [x] Opus 探索并固定方案
- [x] 从最新 main 创建隔离工作区
- [x] 依赖准备与隔离实例迁移
- [x] Sonnet 实施和必要回归
- [x] Opus 独立评审通过，无阻断项
- [x] 范围验证
- [ ] 提交、PR、合并
- [ ] 清理本树和隔离实例，更新 main

## 改动文件

- `packages/db/src/repo/knowledge.ts`（仅 `usableSourceChunks`）
- `packages/api/test/knowledge-wiki-routes.test.ts`
- `docs/tasks/native-logic-round-7.md`

## 下一步

实现、范围验证和独立 Opus 评审均通过。按已有授权提交、创建并合并 PR，清理本树和验证实例并更新 main；实际交付结果以 GitHub/Git 状态为准。

## 验证

- 隔离容器 `pace-native-round7-pg`（127.0.0.1:51767）与 `pace-native-round7-redis`（127.0.0.1:51769）；仅用于本轮。
- 旧实现先跑新增行为回归：`vitest run packages/api/test/knowledge-wiki-routes.test.ts --project backend` → 20 passed。
- 新实现同命令 → 20 passed；相关套件 `knowledge-wiki-routes + worker/knowledge-wiki + worker/knowledge-wiki-update + api/knowledge-package` → 49 passed；`worker/knowledge-ingestion` → 35 passed。
- `pnpm --filter @agentport/db build`、`pnpm --filter @agentport/api typecheck`、两文件 `biome check` 均通过。
- 真实 PG 查询列/过滤证明（脚本 `/tmp/round7-spy.mjs`，未入库）：生成 SQL 仅 select `knowledge_chunks.id/document_id/version_id`；`enabled = true`、`status = 'ready'`、`version_id = current_version_id` 均在 where；有效+禁用混合只写入有效来源。
- 新增回归：禁用 chunk、NULL currentVersionId、有效+失效混合、跨 base、不存在 ID、空输入、重复有效 ID；同时实测人工保存 stale 状态与发布 409、来源关系行。
- 主会话最终复验上述 5 文件 84 项全部通过，0 跳过；db build/API typecheck/Biome/diff --check 通过。
- 首次临时库连接因测试凭证不一致失败；仅修正本轮容器凭证后迁移成功，共享服务未操作。
- 未发现涉及的产品代码与文档冲突；未运行完整产品 E2E 或执行计划/耗时基准，不宣称扫描或端到端提速。
