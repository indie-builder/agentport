# 合并审批继承来源查询

## 目标与方案

inheritApprovals先查同会话上一轮run，再查其approvedAt非空记录，再map生成TypeID并插入。将前两条SELECT合并为现有Drizzle子查询；保留TypeID分配、onConflictDoNothing及原返回toolNames（含冲突项/重名），不改审批有效期或范围规则。

## 基线与范围

worktree /Users/xbjt/Documents/myself/agentport-worktrees/approval-inheritance-query；分支perf/approval-inheritance-query；origin/main 4ad1f079945c8255b514d68b15cb3c07e419da0a，初始无差异；主checkout原.vitest/json/output.json保留。

只改db/src/repo/runs.ts、新增db/test/approval-inheritance.test.ts及本记录。复用现有chat-admit-user-content/API审批测试，不改API/SDK/审批权限/新增事务锁/表结构/依赖。

## 当前有效决定

用户已授权实施、验证、PR合并、清理已合入工作区/专用实例及main同步；不触发或等CI。Opus设计独立评审，Sonnet执行；主会话读代码/验证/记录/提交。专用PG64108/Redis64110/9，不读主env、不改共享账号服务。

保留上一轮同conversation按id倒序limit1且排除当前run，不能回退更旧有批准的run；approvedAt非空是唯一继承条件，不为本轮新增expiresAt筛选；跨会话不继承。事务沿admitChatRun，消息写失败全部回滚。无前轮旧/新均1查询，有前轮但无批准2→1，有批准3→2。

## 步骤

- [x] 并行探索/原生子查询依据/调用边界确认、建立隔离树
- [x] 源码与测试分文件并行；依赖/前置构建与专用库迁移完成；生产7行差异，db typecheck/build与Biome错误级通过
- [x] SQL计数、上一轮/跨会话/重名/冲突/时间与事务回滚回归：主会话4文件34项通过，0skip；两文件Biome错误级通过
- [x] db typecheck/build、API/worker typecheck、源码Biome错误级通过；生产Opus评审通过
- [x] 测试独立review通过，无阻断；2ms排序夹具与事务内插入断言为非阻断建议
- [ ] 提交PR合并、清树/实例、main快进

## 验证与下一步

主会话实际执行：`DATABASE_URL=<专用64108> REDIS_URL=<专用64110/9> pnpm exec vitest run --project backend packages/db/test/approval-inheritance.test.ts packages/db/test/chat-admit-user-content.test.ts packages/api/test/approval-lifecycle.test.ts packages/api/test/chat-admission.test.ts --no-file-parallelism`：4文件34项通过，无失败或跳过；两份代码Biome错误级和diff check通过。db typecheck/build及API/worker typecheck通过。

真实Drizzle logger计数：无前轮1SELECT、前轮无批准1SELECT、有批准SELECT+INSERT两语句。测试保留pending过滤、最近一轮不回退、跨会话隔离、同名不同server、原批准时间、冲突返回与真实事务回滚。生产与测试独立review均通过，无剩余阻断。

未发现涉及的产品文档与代码冲突。通过最终评审后按授权提交PR合并、确认合入再清理专用实例和干净工作区、main快进。收益限减少一次数据库往返，未测端到端耗时，未运行真实模型或完整产品E2E。
