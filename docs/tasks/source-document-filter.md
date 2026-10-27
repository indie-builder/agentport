# 同步删除推导按来源过滤文档

## 目标与方案

disableStaleDocuments原分页加载整库ready文档再按metadata.knowledgeSourceId===source.id过滤；增加ListDocumentsFilter.knowledgeSourceId并将同样来源精确匹配下推SQL。仅同步删除推导传入，不暴露新HTTP参数。复用现有disableDocumentsBySource的JSON字段SQL约定，不另造列表或索引。

## 基线与范围

worktree /Users/xbjt/Documents/myself/agentport-worktrees/source-document-filter；分支perf/source-document-filter；基线origin/main 079c6096eabc28aacf63176b7fce8f7b29f5ef8c，初始无差异。主checkout原.vitest/json/output.json差异保留。

允许改db/src/repo/knowledge.ts、worker/src/knowledge/ingestion.ts、worker/test/knowledge-ingestion.test.ts、必要db/test/knowledge-document-filter.test.ts及本记录。主会话只读/验证/记录/交付，Sonnet实现测试，Opus独立评审。

## 当前有效决定

用户授权实施PR合并、删已合入工作区及专用实例、更新main；不触发或等待CI。专用PG64096/Redis64098/9，不读主.env，不动共享登录/服务。无新增依赖、schema、产品服务、索引。

保留base/status/分页createdAt+id/游标/seen处理/checkAborted/disable和Wiki stale顺序；来源字段是内部过滤器，HTTP列表无新行为。来源完整枚举且无失败才推导删除，Feed不推导删除。

## 已替代项

定时任务列表批量scheduler读取收益未证实不改。

## 步骤

- [x] 并行探索与调用核查、建隔离树
- [x] 实现完成，隔离依赖/前置构建和专用库迁移完成；db/worker类型构建及两文件Biome错误级主会话通过
- [x] 多来源分页/SQL过滤真实数据量、删除/滚动窗口/失败边界验证：最终4文件74项通过，无跳过；四份代码Biome错误级通过
- [x] 生产Opus独立review通过：来源TypeID匹配与原严格比较等价，分页/seen/停用/Wiki顺序及完整枚举守卫保持
- [x] 测试独立review通过，SQL捕获、分页及行为断言有效，无剩余阻断
- [ ] PR合并/清理/main同步

## 验证与下一步

主会话已运行db/worker typecheck与build、四份代码Biome错误级和git diff --check，均通过；最终专用实例串行运行knowledge-document-filter、knowledge-ingestion、knowledge-sources、knowledge-scheduler：4文件74项通过，0失败/跳过。

worker专项包含210条当前来源ready文档跨页，以及30条其他来源、manual、缺失/null/JSON null归属和非ready文档；捕获真实SQL来源参数及两页201+10返回行（含lookahead），确认无关文档不被取回，保留seen/停用/Wiki标旧。DB另核无过滤器列表、base/status和分页游标。

生产与测试Opus独立review均通过，无剩余阻断。按既有授权提交PR合并、确认合入再清理专用实例和干净工作区、main快进。不承诺无索引SQL扫描提速或端到端倍数，未运行真实外部来源和完整产品E2E。
