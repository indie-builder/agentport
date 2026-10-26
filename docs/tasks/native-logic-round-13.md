# 手写逻辑简化：第十三轮

## 目标

复用 run token 查询中已有的绑定授权，删除知识库 MCP 入口重复的绑定查询，减少成功请求一次数据库往返，保持权限边界。用户授权提交、PR 合并、清理本树及实例、更新 main。

## 方案

Opus 并行检查鉴权与图片处理；图片校验无可安全删除的小逻辑，不改。鉴权候选固定后 Sonnet 实施和回归，Opus 独立评审，隔离 PostgreSQL/Redis 验证后交付。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport-worktrees/native-logic-round-13`
- 分支：`refactor/native-logic-round-13`
- 起始 origin/main：`f04619c4c777f39f35f9b9b93d1d45ed702d5f61`
- 初始本树差异为空，主 checkout 已有测试报告差异不属于本轮。
- 允许：`packages/api/src/features/servers/mcp-endpoint.ts` 的 knowledge 分支，`packages/api/test/run-server-scope.test.ts`、`packages/api/test/knowledge-mcp.test.ts` 必要回归和本记录。
- 不改 repo 授权谓词、generated 分支、SDK、schema/迁移/依赖；不改其他任务树。

## 当前有效决定

- commit/push/PR/merge、清理和 main 更新已授权；主会话不写源码/测试，Sonnet 执行、Opus 独立评审。
- getRunToken 与 isRunBoundToServer 使用相同 innerJoin(runMayUseServer)、runId/serverId where 和 limit；保留 getRunToken 的绑定检查，knowledge 分支仅删除后一次绑定检查。
- 保留 !ok 与 runId null 拒绝、token 哈希/时效校验、WWW-Authenticate、knowledge base 检查、父绑定及启用直接子级授权，禁用/孙级/旁系/跨 server 不可用。
- generated 分支及其 handlerFor 检查不动。一次绑定检查已保障入口，不承诺在任意并发解绑时刻撤销已进入执行的请求；不新增理论竞态机制。
- 安全相关变更必须真实权限回归与独立评审，不靠查询相同的静态结论交付。
- 不触发/等待 CI，不启动 PR 监控，不操作共享服务或登录态。

## 已替代项及原因

无。

## 步骤

- [x] 探索并核对两处授权条件
- [x] 从最新 origin/main 建树
- [x] 依赖和隔离库迁移
- [x] 实现与权限回归
- [x] 独立 Opus 评审与范围验证通过，无阻断项
- [ ] 提交、PR、合并
- [ ] 清理实例和本树、更新 main

## 改动文件

- `packages/api/src/features/servers/mcp-endpoint.ts`
- `packages/api/test/run-server-scope.test.ts`
- `packages/api/test/knowledge-mcp.test.ts`
- `docs/tasks/native-logic-round-13.md`

## 下一步

实现、权限回归、范围验证与独立 Opus 评审均通过。按已有授权提交合并，清理实例和本树、更新 main；实际结果以 GitHub/Git 状态为准。

## 验证

- 本轮 pace-native-round13-pg（127.0.0.1:56291）与 pace-native-round13-redis（127.0.0.1:56293）。
- 锁定依赖安装、shared/core/db 构建、独立库既有迁移通过。
- 原实现成功 knowledge 请求绑定 JOIN 计数为 2，新增计数回归先红；修改后计数为 1。
- 主会话最终 knowledge-mcp/run-server-scope 两文件 11 项、generated-mcp 9 项通过，0 跳过；覆盖父级、启用直接子级、禁用子级、孙级、旁系、未绑定、缺失 run、过期与清空 token。
- API build/typecheck、三文件 Biome、diff --check 通过。
- 独立 Opus 评审通过，34/34 相关回归及 7/7 补充 HTTP 实测通过，夹具无残留。
- 并发语义差异：解绑发生在原两次查询之间，旧实现会拒绝，新实现可继续；原实现第二次查询后解绑同样可继续，两者均无事务撤销保证。保留本任务入口授权约定，未增加撤销机制。
- 未发现涉及的产品文档与代码冲突。未跑完整产品 E2E 或并发压力/时序实测，不宣称端到端提速倍数。
