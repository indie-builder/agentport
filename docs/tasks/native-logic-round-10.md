# 手写逻辑简化：第十轮

## 目标

取消评估运行的存在性校验只查询所需 ID，减少快照等无用字段读取，保持取消行为。用户授权提交并合并 PR，随后删除本树、清理验证实例和更新 main。

## 方案

Opus 窄域探索发现后端读取候选，前端已支持 signal 的查询均正确传递，前端不改。Sonnet 实施，Opus 独立评审，真实隔离 PostgreSQL/Redis 验证后交付。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport-worktrees/native-logic-round-10`
- 分支：`refactor/native-logic-round-10`
- 起始 origin/main：`35e08e2596fb8d679a8c503df3c7af430e909637`
- 初始本树差异：空；主 checkout 测试报告差异不属于本轮。
- 允许：`packages/api/src/features/eval/routes.ts` 取消入口、`packages/api/test/eval-cancel.test.ts` 必要边界、`packages/db/src/repo/eval.ts` 仅取消函数注释、本记录。
- 不改共享 getEvalRun、原子 update 或 schema/索引/迁移/依赖；不动其他树和 skill-provenance。

## 当前有效决定

- commit/push/PR/merge、清理与 main 更新已授权。
- 主会话不写源码/测试；Sonnet 执行，Opus 独立评审；子代理不自行提交属分工。
- 取消入口原两步查询不变，存在校验就地 select id + limit(1)，保留认证、404、终态 202、running 原子取消与单次审计。
- 修正 cancelEvalRun 的“调用方拒绝重复取消”注释：实际接口重复取消仍返回 202，只有状态转换成功才写审计。
- 不触发/等待 CI，不开启 PR 监控；不改共享环境或登录态。

## 已替代项及原因

注释与代码冲突仅上述取消说明，随本轮修正；不改变实际业务规则。

## 步骤

- [x] Opus 并行探索并固定范围
- [x] 基于最新 main 建树
- [x] 依赖准备与隔离库迁移
- [x] 实现和行为回归
- [x] 独立 Opus 评审与范围验证通过，无阻断项
- [ ] 提交、创建并合并 PR
- [ ] 清理实例和本树、更新 main

## 改动文件

- `packages/api/src/features/eval/routes.ts`
- `packages/api/test/eval-cancel.test.ts`
- `packages/db/src/repo/eval.ts`（仅注释）
- `docs/tasks/native-logic-round-10.md`

## 下一步

实现、范围验证及独立 Opus 评审均通过。按既有授权提交、合并、清理和更新 main；实际结果以 GitHub/Git 状态为准。

## 验证

- 前端只读探索实测 5 文件 25 项测试通过，无源码修改；未逐一实测全部 12 条取消链路。
- 锁定依赖安装、shared/core/db 构建与独立数据库既有迁移通过。
- 专用容器 pace-native-round10-pg（127.0.0.1:61893）及 pace-native-round10-redis（127.0.0.1:61895）；未操作共享服务。
- 真实 PG query spy：取消请求仅一条 eval_runs SELECT，投影只有 id、不含 case_snapshot。
- eval-cancel 11/11（含 succeeded/failed/cancelled、并发单审计及迟到写入）；主会话最终 9 文件 71 项通过，0 跳过。
- db/API build、API typecheck、三文件 Biome 与 diff --check 通过。
- 已修正取消函数注释与 202 幂等行为的冲突；未发现其他涉及的产品文档冲突。
- 未跑完整产品 E2E 或耗时基准；不宣称查询次数或端到端耗时降低。
