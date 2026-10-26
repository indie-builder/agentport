# 手写逻辑简化：第十二轮

## 目标

减少审计游标分页有结果时的重复数据库往返，保留未知游标拒绝和有效空页语义。用户授权提交 PR 并合并，清理本树及验证实例、更新 main。

## 方案

Opus 探索发现接口先查游标存在再查分页。采用更小的实现：分页先执行，有记录时游标自然存在；只有有游标且结果为空时，再调用现有存在性查询区分未知游标和有效空页。保留原 SQL 微秒比较，无需横向连接或新返回类型。维护清理已有原生批量 SQL，本轮不改。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport-worktrees/native-logic-round-12`
- 分支：`refactor/native-logic-round-12`
- 起始 origin/main：`4809f8e142228cf26676fa3a0c70accec1d83a1a`
- 初始本树差异为空。主 checkout 既有 `.vitest/json/output.json` 差异不属于本轮。
- 允许：`packages/api/src/features/audit/routes.ts`、`packages/api/test/audit-pages.test.ts`、按需 `audit-export.test.ts`、本记录。
- repo audit SQL 和返回类型不变；不改 schema、依赖、索引、迁移，不修改其他树。

## 当前有效决定

- commit/push/PR/merge 和清理 main 同步均已授权，无需再次确认。
- 主会话定契约、读差异、维护记录、验证与提交；源码和测试由 Sonnet 执行，Opus 独立评审。
- auditOptions 改为同步过滤映射，删除其存在性读取与 app 参数；每个 handler 在 listAudit 后，仅 beforeId 存在且 rows 为空时调用 auditEntryExists，失败返回原 INVALID_INPUT 消息。
- 保留鉴权、筛选、过滤外游标、库内微秒排序、空页、未知游标不回显、导出多取一条超限规则。
- 有结果的游标页由两次审计 SELECT 降为一次；空游标页仍两次，无游标仍一次。不宣称整体耗时倍数。
- 不采用 leftJoinLateral：仅为本处收益引入新的结果形态与查询结构不划算。
- 不触发/等待 CI，不开启 PR 监控，不操作共享服务、配置或登录态。

## 已替代项及原因

探索建议横向连接并返回 null/数组来区分未知游标，已由“仅空页再查存在”替代，减少改动面并复用现有 SQL。

## 步骤

- [x] 并行探索并固定契约
- [x] 从最新 origin/main 建树
- [x] 依赖与隔离库迁移
- [x] Sonnet 实现及必要回归
- [x] 独立 Opus 评审通过，无阻断项
- [x] 范围验证
- [ ] 提交、PR、合并
- [ ] 清理实例和本树、更新 main

## 改动文件

- `packages/api/src/features/audit/routes.ts`
- `packages/api/test/audit-pages.test.ts`
- 按需 `packages/api/test/audit-export.test.ts`
- `docs/tasks/native-logic-round-12.md`

## 下一步

实现、范围验证和独立 Opus 评审均通过。按已有授权提交合并、清理实例和本树并更新 main；实际结果以 GitHub/Git 状态为准。

## 验证

- 独立 pace-native-round12-pg（127.0.0.1:52615）与 pace-native-round12-redis（127.0.0.1:52617）。
- 锁定依赖安装、shared/core/db 构建和独立库既有迁移均通过。
- 先红：非空游标页真实 PG SELECT 计数预期 1、旧实现为 2；改后两个 GET 均 1。
- 有效游标过滤后空页 200 []、未知游标 400 均为 2 次审计 SELECT，无游标仍 1 次。
- 主会话最终 audit-pages + audit-export 共 14 项通过，0 跳过；API build/typecheck、两文件 Biome、diff --check 通过。
- 保留微秒排序、过滤外游标与导出 limit+1 超限规则；未发现涉及的文档代码冲突。
- 独立 Opus 评审通过，另行运行同两套件 14/14、0 跳过；确认 SQL 非空结果足以证明游标存在。评审引用的早期“尚未改源码”状态已在提交前记录中更新。
- 未运行完整产品 E2E、执行计划或耗时基准，不宣称端到端提速倍数。
