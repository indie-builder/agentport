# 成果保留锚点修复

## 目标
修复旧 run 清理删除已发布成果的两个消息锚点，导致较新消息 fork 丢失旧成果的问题。真实隔离 PG、临时输出目录走维护→HTTP fork→删除来源→分支原件下载，并证明旧 run/无引用旧消息仍清理。

## 方案
复用 core `publishedVersions`/`loadManifest` 的路径、链接与 manifest 校验；新增 `outputMessageAnchors(identity): Promise<string[]>`，返回当前会话全部已发布快照的去重 userMessageId/afterMessageId（含空文件快照）。不公开内部 manifest，不引入目录解析、DB 表、迁移或兼容格式。
维护从 DB 当前 conversations JOIN agents 取得会话身份，先完整读取所有锚点，再调用现有 prune。`runMaintenance(db, logger, retain, workspacesDir)` 和 worker 启动参数必须显式传入成果根。读取错误原样抛出，不能继续删除消息。repo prune 增加可选 `retainedMessageIds: string[] = []`，一个 `text[]` 参数供 ANY 判定；run CTE detach 与 delete 使用同一保留条件，孤儿清理也排除。实际消息 ID 是全局主键；仅实际 manifest 引用被保护，附件条件不变。
选择理由：现有列表仅暴露文件且有分页，不暴露锚点；直接复用内部已发布版本读取是最小完整接口。个人项目按当前会话遍历并在单次维护中收集一个去重数组；不加全局缓存、复杂锁、分批事务或理论竞态保护。数组避免每个 ID 多个占位符，当前规模无需新配置。

## 基线与范围
- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-review-loop`。
- HEAD：`e060e3a559633a0d94adb637516a6d577b86b1aa`；沿用用户指定已有树，不重新建树/更新基线。
- 开工已有大量未提交源码、测试、文档差异，全部属于其他并行任务；本任务不还原其他任务差异，最终提交由主会话在 review 与验证后执行。允许路径初始无差异，唯 `worker/src/index.ts` 已有其他任务差异，仅添加必要参数传递。
- 写范围：core/src/outputs.ts、db/src/repo/maintenance.ts、worker/src/maintenance.ts、worker/src/index.ts 的必要参数、core outputs 测试、对应 outputs/maintenance API 回归测试、本记录。只读现有 exports、Interface、helpers/config/调用方。
- 禁止 queue 通知、native、sandbox-probe 域；不跑全 backend。

## 当前有效决定
- 本切口由作者子代理直接执行（不另派下级代理），不是用户全局约束；交付等待独立 Opus review，用户已授权最终提交 PR 与合并。
- fork 的两个锚点映射边界保持不变；只保留被 manifest 引用的消息，附件原保留规则保持。
- 先任务记录，再测试红→最小实现绿→整理→相关全文件测试/typecheck/build/biome。
- 独立 PG 使用现有 `createIsolatedDatabase`，测试 app 复用实际 routes helpers，临时目录 mkdtemp，结束仅清理本测试资源。

## 已替代项及原因
无。

## 步骤
- [x] 读取 CLAUDE/DEV-WORKFLOW/PITFALLS，加载 scoped ub-mode/Postgres/Drizzle/Vitest，检索所有调用方与安全 manifest 入口。
- [x] 真实 API 行为回归先红，补 core 安全读取回归。
- [x] 最小跨层实现并验证旧 run 删除、锚点 detach、孤儿清理和下载字节。
- [x] 相关完整文件测试、按包验证、biome，记录资源回收和覆盖限制。

## 改动文件
- `packages/core/src/outputs.ts`：新增 `outputMessageAnchors`，复用现有 `publishedVersions` 读取并去重两个锚点。
- `packages/core/test/outputs.test.ts`：空快照包含、去重、损坏与软链 manifest 拒绝。
- `packages/db/src/repo/maintenance.ts`：`PruneOptions.retainedMessageIds` 单 `text[]` 参数；run detach/delete 与孤儿清理统一排除。
- `packages/db/test/attachments.test.ts`：仓库层保留锚点 detach 回归。
- `packages/worker/src/maintenance.ts`：先读全部会话成果锚点再 prune；worker 与手动入口传入成果根。
- `packages/worker/src/index.ts`：仅增加 `workspacesDir: config.WORKSPACES_DIR`；同文件其它差异属并行任务。
- `packages/api/test/output-retention.test.ts`：隔离 PG + 临时成果根，真实维护、HTTP fork、删除来源、分支下载原件。
- `docs/PITFALLS.md`：记录 Drizzle 模板数组展开为占位符列表的坑。
- `docs/tasks/codebase-review-output-retention.md`：本记录。

## 下一步
无。独立 Opus review 已通过（a97），已验收；用户已授权最终提交 PR 与合并，由主会话在最终验证后执行。

## 验证
- 先红：`pnpm test --project backend packages/api/test/output-retention.test.ts --no-file-parallelism` 旧实现 3/3 失败；两种保留期在下载分支成果时均 404，损坏 manifest 仍继续删 run/消息。core 新接口测试先以 `outputMessageAnchors is not a function` 失败。
- 首次修复后仍红，定位到 Drizzle 模板数组被展开为多个占位符（`($2,$3)::text[]` 报 record cast），改为 `sql.param` 单参数；同时 `db` 未构建会让 worker 用到旧 prune。对应 PITFALLS「真实容器测试可能加载旧 dist」。
- 绿：`pnpm test --project backend packages/core/test/outputs.test.ts packages/db/test/attachments.test.ts packages/db/src/test/integrity.test.ts packages/api/test/outputs-routes.test.ts packages/api/test/output-retention.test.ts packages/api/test/chat-attachments.test.ts --no-file-parallelism` → 6 files / 79 passed / 0 skipped。
- `pnpm --filter @agentport/core --filter @agentport/db --filter @agentport/worker --filter @agentport/api typecheck` → 四包通过。
- `pnpm --filter @agentport/core --filter @agentport/db --filter @agentport/worker --filter @agentport/api build` → 四包通过。
- `biome check` 上述 7 个源码/测试文件 → No fixes applied。
- 资源：测试用 `createIsolatedDatabase` 随机 PG（结束 drop）、`mkdtemp` 临时成果根（结束 rm）、`app.close()`；Redis 由 backend globalSetup 独占容器随轮次回收。
- 覆盖限制：本任务未跑全 backend；主会话本轮完整 backend 为 241 files（1 failed / 240 passed）、2340 tests（1 failed / 2339 passed），唯一失败是 `agent-package-runtime-environment.test` 全表计数并发干扰（expected 34 / actual 32），Sonnet 正在修复；主会话本轮 web 115 files / 1277 passed、typecheck / build 通过；未测真实容器内 worker 长期运行与多进程维护；并发发布/维护竞态按个人项目要求未加锁。非本任务的环境缺失时套件按现有 `skipIf` 跳过。
