# 知识库 PR 合并定点评审

- 对象：3ca2076 合并 origin/main 633e837 后的工作树；仅静态评审，不修改产品代码。
- 结论：通过 with limits。本轮未确认具有确定触发条件的合并阻塞。
- 方法限制：环境拦截器拒绝 Git diff 命令，因此直接读取合并后文件；未完成双父差异证明，不将本结论解释为全量合并完整性保证。

## 已核对接点

- `packages/web/src/components/resource-page.tsx:13`：资源导航保留 plugins 与 knowledge，section 类型同时包含 agents/skills/servers/plugins/knowledge。
- `packages/web/src/pages/agents.tsx:844`：知识库选择保留其他 serverIds；知识库选项、插件选项和两者的编辑区均仍存在。
- `packages/web/src/pages/agents.tsx:2769`：预览保留 knowledge MCP 条目；`:2856` 保留插件文件投影。
- `packages/web/src/pages/chat.tsx:47`：知识引用组件保留；`:53` 与 `:124` 保留 OpenUI 消息和 renderer 引用。
- `packages/api/src/routes/index.ts:9`：知识内容、图片、包、来源、Wiki 路由导入保留；`:47` 插件注册保留。完整知识注册调用未在最后一次精简摘录中逐条确认。
- `packages/api/src/features/agent-package.ts:106`：知识连接转换为标准 HTTP MCP 与专用环境变量；`:135`、`:184` 导出和预览分支均保留 knowledge kind。
- `packages/db/src/repo/openui.ts:53`：既定 owner 的 http/generated 白名单过滤已出现；`:71` 明确排除 stdio/knowledge。本轮未重复实现。
- `packages/db/migrations/0033_slim_cyclops.sql:1`：agent_plugins/plugin_files/plugins 建表保留。
- `packages/db/migrations/0034_wealthy_ikaris.sql`、`0035_pretty_tana_nile.sql` 仍存在；本轮不宣称已证明其与 main 逐字一致。
- `packages/db/migrations/0036_demonic_dust.sql:2`：vector 扩展保留；`:249` GIN、`:273` HNSW 索引保留。

## 合并条件及已知限制

- 主会话已报告 pace_knowledge_merge 空库迁移成功、vector 0.8.7 与 GIN/HNSW 真实存在；本轮不重复执行、不冒称独立实测。
- 全量 typecheck/build/tests 由主会话运行；需以其最终结果判断，不在此提前声称通过。
- 最终 lockfile、routeTree 以及迁移 journal 的完整性仍以各 owner 和主会话验证为准。
- PR 必须明确此前 GitHub/Wiki/source 的 known limits；这些不是本次 merge 遗漏，不扩大整改范围。
- 未检查真实第三方凭据、远端源完整流程、浏览器操作及全仓安全；不要求提供真实凭据。
- 本记录只支持上述接点的定点通过，不替代主会话的合并、构建及测试验证。
