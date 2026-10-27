# 模型配置引用存在性查询

## 目标与方案

profile PATCH变更模型/协议/图片能力时，原count UNION ALL计数全部知识库和文档版本引用，只用于>0判断。改SELECT EXISTS(同样UNION ALL)，直接读boolean，不数尽引用。官方PG文档https://www.postgresql.org/docs/current/functions-subquery.html说明通常只执行到找到首行。无新helper/依赖/索引/迁移。

## 基线与范围

worktree /Users/xbjt/Documents/myself/agentport-worktrees/profile-reference-exists；branch perf/profile-reference-exists；origin/main e1e9ddd5ea67f293cce082e2efcf6d47eb944080，初始无差异。主checkout原.vitest/json/output.json保留。

只改api/src/features/knowledge/routes.ts及api/test/knowledge-multimodal.test.ts(复用引用保护夹具)与本记录。Opus设计/独立review、Sonnet实现测试分文件并行。主会话读代码/记录/验证/交付。

## 当前有效决定

用户授权确认收益后实施PR合并、清已合并树/专用实例、main同步。专用PG64100/Redis64102/9，不读主env/改共享账号，不触发CI/等CI/监控。

权限、合法能力组合校验、404/409顺序、引用两分支、重命名/禁用/凭据编辑、未引用可改保持。专用PG已确认EXISTS命中时提前停止；无引用时成本相近，不承诺整体提速。

测试额外复现DELETE已引用profile返回500：现代码仅处理23503，而RESTRICT实际返回23001。扩展同两文件范围，DELETE同时映射23001/23503为原CONFLICT 409；补HTTP拒绝及记录保留断言，不新增全局错误分类。官方SQLSTATE表已核23001 restrict_violation / 23503 foreign_key_violation。

## 步骤

- [x] 探索与实际代码核对、官方EXISTS依据、建树
- [x] EXISTS替换完成；依赖/前置构建/专用DB迁移就绪；主会话API typecheck/build及实现文件Biome错误级通过
- [x] 专用PG代表性引用数据EXPLAIN对比、真实HTTP引用/无引用/仅版本引用已完成
- [x] EXISTS生产独立Opus评审通过：两个引用分支与错误顺序不变，布尔判断正确
- [x] DELETE引用冲突修复红绿：base/history两例原500→409，数据保留；执行者2套48项通过
- [x] 最终主会话2文件48项、API类型构建/静态检查通过；新增DELETE与测试独立review通过，无剩余阻断
- [ ] 提交合并、清理并更新main

## 验证与下一步

主会话复跑 `.tmp/bench-reference-exists.sql`（docker exec psql，事务造5000版本后ROLLBACK）确认三场景boolean等价，残留计数均0。知识库命中COUNT 0.323ms/174 buffers→EXISTS 0.007ms/1 buffer，版本分支never executed；仅版本引用COUNT 5000行/1.292ms/174 buffers→EXISTS 1行/0.009ms/3 buffers；无引用0.366→0.343ms、均174 buffers，未明显改善。单轮局部执行计划，不作端到端倍数承诺。

EXISTS行为回归初轮2文件47项通过；补DELETE RESTRICT映射后，两个目标用例旧代码500→新409，配置/知识库/版本保留。主会话最终运行multimodal+knowledge-routes串行2文件48项通过，0skip/失败；API typecheck/build与两文件Biome错误级通过。EXISTS生产评审、新增DELETE与测试独立review均通过，无剩余阻断；按既有授权提交PR合并，确认合入后清理实例和工作区、更新main。未发现产品文档冲突，未运行真实模型或完整产品E2E。
