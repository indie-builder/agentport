# 手写逻辑简化：第十四轮

## 目标

知识任务列表只读取响应所需字段，删除知识库确认框复用同一次绑定智能体计算，减少无用数据读取和重复遍历。用户授权提交并合并 PR、清理工作区和隔离实例、更新 main。

## 方案

Opus 并行探索，Sonnet 分域实施，Opus 独立评审，范围验证通过后交付。无 schema、迁移或依赖改动，不宣称未测量的端到端性能。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport-worktrees/native-logic-round-14`
- 分支：`refactor/native-logic-round-14`
- 起始 origin/main：`837771fe50a117cd4de167ae53dd5bc68e3c0684`
- 初始差异为空，主 checkout 测试报告差异不属于本轮。
- A：`packages/db/src/repo/knowledge.ts` 的 listJobs 显式投影、`packages/api/src/features/knowledge/routes.ts` 的 JobRow 参数类型、`packages/api/test/knowledge-routes.test.ts` 必要列表回归。
- B：`packages/web/src/pages/knowledge.tsx` 删除确认的 boundAgents 计算与 `packages/web/test/knowledge-management.test.ts` 针对性测试。
- 本记录由主会话维护，执行代理不编辑。其他工作树、schema、依赖和运行底座不动。

## 当前有效决定

- 用户已授权 commit/push/PR/merge 以及清理与 main 更新。
- 主会话不写源码或测试；Sonnet 执行、Opus 独立评审，评审通过才提交；不触发或等待 CI。
- listJobs 只投影 toJob 实际使用的 10 列（id/type/status/step/progress/attempts/error/createdAt/startedAt/endedAt）。核代码确认原探索“11 列”计数有误。排除 payload 及归属外键，仅列表裁剪，getJob/重试/取消/worker 完整任务不变。
- 类型用最小准确摘要类型，保持列表外部响应、筛选、排序、游标和下一页规则不变。
- B 保留绑定匹配、名称顺序及删除确认行为，只在 deleting 非空时过滤一次，结果供长度和名称共用；不用 useMemo 或新 helper。
- 不改共享配置、数据库或登录态，验证仅用本轮实例。

## 已替代项及原因

无方案变更；字段计数以实际 toJob 的 10 个字段为准。

## 步骤

- [x] Opus 并行探索并固定范围
- [x] 从最新 main 建树
- [x] 依赖准备和隔离库迁移
- [x] Sonnet 并行实施和必要回归
- [x] 独立 Opus 评审（A/B 均通过，无阻断项）
- [x] 范围验证（回归、类型和受影响构建通过）
- [ ] 提交、PR、合并
- [ ] 清理本树和隔离实例、更新 main

## 改动文件

A/B 实际允许范围见上文；本记录也随分支提交。

## 下一步

A/B 实现、范围验证和独立 Opus 评审均通过。按已有授权提交合并并清理；实际交付结果以 GitHub/Git 状态为准。

## 验证

- pace-native-round14-pg：127.0.0.1:60280；pace-native-round14-redis：127.0.0.1:60282。
- 锁定依赖安装、shared/core/db 构建和独立库既有迁移通过。
- B：knowledge-management 48/48；web 全量 73 文件 712 项通过，web build/typecheck 和两文件 Biome 通过。未开浏览器（没有视觉改动）。
- B 独立 Opus 评审通过，另行复跑 knowledge-management 48/48；名称顺序按代码核对，测试覆盖单绑定及零绑定。
- A：任务列表从 14 列收窄为 10 列；主会话 knowledge-routes/source/content 三文件 41 项通过、0 跳过。真实 PG spy 确认列表不读 payload、getJob 仍读完整 payload，同时间戳分页与筛选通过。
- 主会话最终前端 73 文件 712 项通过，0 跳过；7 包 typecheck、db/API/web build、五文件错误级 Biome 与 diff --check 通过。
- 保留既有 chunk 体积提示和 12 条未改动代码的 Biome warning；不宣称 warning 清零。内容路由故障注入的空内容/Redis 错误日志为测试预期。
- 本轮未发现涉及的产品代码与文档冲突；未跑完整产品 E2E、浏览器视觉验收或耗时基准，不宣称端到端提速。
