# 版本快照写入减少查询往返

## 目标

将智能体版本号计算并入现有 INSERT，每次快照写入从两次查询减少为一次，保持版本递增、快照内容与并发冲突规则。用户授权修改、提交并合并 PR、清理本树及实例、更新 main。

## 方案

Opus 探索与主会话核对后，使用现有 Drizzle sql 标量子查询计算 coalesce(max(version),0)+1；Sonnet 实施和必要回归，独立 Opus 评审、隔离 PG/Redis 验证后交付。前端导入/导出没有收益足够候选，不改。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport-worktrees/version-insert-query`
- 分支：`refactor/version-insert-query`
- 起点 origin/main：`ff5ebb5bb56429a81dea3124c996cec32fdbbf57`
- 初始本树差异为空；主 checkout 原有测试报告差异不属本轮。
- 允许：`packages/db/src/repo/agent-versions.ts` 的 insertAgentVersion、`packages/api/test/agent-concurrency.test.ts` 及确需直接版本测试、本记录。
- 现有 agents 创建/复制/更新/回滚与包导入调用方接口不变，不改 schema/索引/迁移/依赖，不动其他任务树。

## 当前有效决定

- 用户既有 commit/push/PR/merge 与清理同步授权有效；主会话不写源码/测试，Sonnet 执行、Opus 独立评审。
- insertAgentVersion 删除独立 max SELECT，将按 agentId 过滤的 max 标量子查询作为 version 值；ID、snapshot、note 参数绑定保留。
- 事务、(agent_id,version) 唯一约束、retryOnVersionConflict 和错误映射原样保留；不添加锁/新重试/理论防护。
- 每份版本快照两次往返变一次，不宣称端到端提速倍数。
- 不触发或等待 CI，不开启 PR 监控，不操作共享服务/配置/登录态。

## 已替代项及原因

无。

## 步骤

- [x] 探索和官方标量子查询语义核对
- [x] 同步 main 并创建隔离工作区
- [x] 依赖准备与独立库迁移
- [x] Sonnet 实施和真实数据库回归
- [x] Opus 独立评审与范围验证通过，无阻断项
- [ ] 提交、PR、合并
- [ ] 清理实例和工作区，更新 main

## 改动文件

- `packages/db/src/repo/agent-versions.ts`
- 必要直接版本回归测试
- `docs/tasks/version-insert-query.md`

## 下一步

实现、范围验证和独立 Opus 评审通过，另行评审复跑两套件29项无跳过。按既有授权提交、创建并合并 PR，清理本树与实例、更新 main；实际结果以 GitHub/Git 状态为准。

## 验证

- 本轮专用 pace-version-query-pg（127.0.0.1:57447）与 pace-version-query-redis（127.0.0.1:57451）。
- 官方 PostgreSQL SQL expressions 文档确认 INSERT 值可使用标量子查询、空集合 max 需 coalesce。
- 锁定依赖安装、shared/core/db 构建和独立库既有迁移通过。
- 新查询次数回归在原实现先红：INSERT 不含 max 标量子查询；新实现两次连续快照各一条 INSERT，无独立 max SELECT。
- 主会话最终 agents、agent-concurrency、subagent-bundle、包校验与导入相关 7 文件 117 项通过、0 跳过；涵盖初版1、递增、快照、回滚 note、并发和导入。UTF8空字节故障测试日志为预期。
- db build、API typecheck、两文件 Biome、diff --check 通过。
- 未发现涉及的文档与代码冲突，未跑完整产品 E2E 或耗时基准，不宣称端到端提速。
