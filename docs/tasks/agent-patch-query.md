# 专家 PATCH 省去普通更新前置查询

## 目标与方案

普通PATCH仅修改名称、描述、enabled等时省掉路由getAgent一次SELECT；仅slug/subAgentIds/pluginBindings任一非undefined时读取旧行并执行原校验（空数组仍走原路径）。更新使用request.params.id，响应关联读取使用row.id；仓储UPDATE RETURNING和原有404/409区分、事务/快照/审计不变。官方依据：https://orm.drizzle.team/docs/update 。不新增helper/依赖/服务/迁移。

## 基线与范围

- worktree /Users/xbjt/Documents/myself/agentport-worktrees/agent-patch-query
- branch perf/agent-patch-query；origin/main 7eba55f2eaf95ebad1aeae91d37f6e5fe2af65ba，初始无差异。
- 主checkout原.vitest/json/output.json差异保留。
- 只改packages/api/src/features/agents/routes.ts、packages/api/test/agents.test.ts及本记录。源码测试由不同Sonnet并行，Opus独立review。

## 当前决定

用户授权实施验证提交PR合并、合并确认后删除工作区和专用实例、更新main；不触发或等CI、不自动监控。专用PG64080、Redis64082/9，不复制主.env/改共享登录。

## 已替代项

技能/插件普通列表已是线性map且repo SQL聚合，不为凑PR加Map；仅实施确认少一次查询的PATCH。

## 步骤

- [x] 两域Opus探索、原生文档核对、固定契约
- [x] 实现与回归分文件并行；依赖安装/前置构建与专用PG迁移完成
- [x] 源码实施完成；主会话API typecheck/build/Biome错误级与diff check通过；并发/plugins/subagent相邻3文件17项通过；Opus生产review通过
- [x] 查询次数证据、普通PATCH边界回归及测试独立review全部通过，无剩余阻断
- [ ] 提交PR合并、确认后清理并更新main

## 验证与下一步

已完成：`pnpm --filter ./packages/api typecheck`、`build`、路由文件`biome check --diagnostic-level=error`与`git diff --check`均通过。专用PG64080/Redis64082/9执行agent-concurrency/plugins/subagent-binding-concurrency：3文件17项通过，0skip。生产Opus评审通过，三个特殊字段的旧行读取和权限/错误优先级保持；事务/快照/审计未改变。

执行代理真实HTTP测试26项通过（两轮）；pool.query拦截真实SQL，普通name/description/enabled:false、空patch、合法null清除均0次前置SELECT，特殊slug/subAgentIds[]/pluginBindings[]每请求1次作正对照。缺失id+旧token仍404、存活过期仍409。未还原旧生产代码做红灯，特殊路径正对照证明捕获非恒0。

无既有产品文档与本轮实现冲突；对外字段和状态码契约未改，查询次数与理由集中记在本任务。普通PATCH相关48项与静态检查已完成，测试独立评审通过，确认SQL捕获、正对照、转发语义和持久化断言有效。

主会话最终验证：`vitest run --project backend packages/api/test/{agents,agent-concurrency,plugins,subagent-binding-concurrency,agent-defaults}.test.ts --no-file-parallelism`：5文件48项通过；两份改动代码Biome错误级/diff check通过。原有NUL输入触发的INTERNAL_ERROR日志是预期断言。生产与测试独立review均通过，按用户既有授权提交PR合并、确认后清理并同步main。收益限减少一次查询，不承诺端到端倍数。
