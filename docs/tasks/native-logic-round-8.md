# 手写逻辑简化：第八轮

## 目标

复用现有 Drizzle/Postgres 能力，减少批量文档归属校验的串行查询和工具目录冗余字段读取。用户授权修改、提交 PR 并合并，随后清理任务工作区和验证实例、更新 main。

## 方案

Opus 并行探索 API 与 repo，固定文件边界后 Sonnet 分域执行；独立 Opus 评审、隔离数据库回归通过后提交。查询和字段行为可实证，不宣称未测量的端到端提速。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport-worktrees/native-logic-round-8`
- 分支：`refactor/native-logic-round-8`
- 起始 origin/main：`b3e9707ca2c7b9859c964e24ed3895b257975d6b`
- 初始本树差异：空。主 checkout 原有 `.vitest/json/output.json` 差异不属于本轮。
- A 域：`packages/db/src/repo/openui.ts` 的 listOpenUiTools 生成工具 select，仅投影 serverId/name/description/inputSchema/requiresApproval；相关 `packages/db/test/openui-tools.test.ts` 仅必要行为验证。
- B 域：`packages/api/src/features/knowledge/routes.ts` 批量 rebuild 归属校验及 `packages/api/test/knowledge-routes.test.ts` 的针对性回归。使用现有 schema/Drizzle 查询风格，不新增仓储抽象。
- 记录由主会话维护，执行者不得编辑本记录；如需扩大范围先报告。
- 不改 schema/索引/迁移/依赖；不碰其他 worktree、第六轮记录及 skill-provenance。

## 当前有效决定

- 用户已授权 commit/push/PR/merge，独立评审通过后主会话执行。
- 源码与测试由 Sonnet 子代理实施，主会话不亲自改代码；Opus 独立评审。
- A 保留原有筛选、排序、许可与输出，查询次数不变，每行返回字段由 11 减为 5。
- B 将 N 次串行 getDocument 改为一条按 baseId 和去重 ID 集合筛选的查询，只选 id；缺失/跨库仍 400 且不入队；重复、空数组和缺省仍保留原 payload 语义。
- 不触发、不等待 CI，不启用 PR 监控；不改共享服务、配置、数据库或登录态。

## 已替代项及原因

无。

## 步骤

- [x] 探索并固定 A/B 契约
- [x] 从最新 main 建树
- [x] 锁定依赖安装、shared/core/db 构建和隔离数据库迁移通过
- [x] Sonnet 并行实现与回归
- [x] Opus 独立评审（A/B 均通过，无阻断项）
- [x] 范围验证
- [ ] 提交、PR、合并
- [ ] 清理本树和隔离实例、更新 main

## 改动文件

- `packages/db/src/repo/openui.ts`
- `packages/api/src/features/knowledge/routes.ts`
- 按需的对应 db/api 测试
- `docs/tasks/native-logic-round-8.md`

## 下一步

A/B 实现、范围验证和独立 Opus 评审均通过。按已有授权提交合并，清理本树及隔离实例、更新 main；实际合并和清理结果以 GitHub/Git 状态为准。

## 验证

- 隔离容器 pace-native-round8-pg（127.0.0.1:55135）及 pace-native-round8-redis（127.0.0.1:55137），仅本轮使用。
- 锁定依赖安装、shared/core/db 构建和专用库既有迁移均退出码 0。
- A：db 工具目录 9、API 工具目录 25、worker action/persistence 11，共 45 项通过、0 跳过；db build 与两文件 Biome 通过。真实 PG 查询探针确认 select 仅五列。
- A 独立 Opus 评审通过，无阻断项；独立复跑 db 工具目录 9/9，0 跳过。
- B：新增真实 PG 查询断言在旧实现为 3 失败/18 通过（多个 ID 触发逐条查询）；修改后 knowledge-routes 21/21，knowledge-package 14/14。原始入队数组与空/缺省语义保留。
- 主会话最终隔离回归 6 文件 80 项通过，0 跳过；7 包 typecheck、db/API build、diff --check 通过。4 文件 Biome 无错误，12 条既有 warning 保留，未声称全 warning 清零。
- 本轮未发现涉及的产品文档与代码冲突；未做完整产品 E2E 或耗时基准，不宣称端到端提速。
