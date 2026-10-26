# 知识库 PR 与主分支整合

2026-10-26。用户明确授权提交PR并合并，不部署、不等待CI。完整知识库与多模态成果已保存为提交 `3ca2076`，基于 `797edfe`。当前远端 main 已到 `633e837`，包含插件与OpenUI；在本worktree执行 `merge --no-commit --no-ff origin/main`，不操作主checkout。

## 当前范围

保留本次知识库与主分支插件/OpenUI两侧功能。共享资源页须同时出现专家/技能/连接器/插件/知识库。数据库以main已提交0033–0035迁移为历史，重新生成知识库增量；不让旧知识0033/0034快照覆盖main插件/OpenUI结构。生成锁文件、路由树与实现文件各有独占owner。

## 分工与依赖

- Opus：共享资源页/专家绑定/API客户端与相应测试冲突。
- Opus：聊天引用与OpenUI、路由注册、配置测试/文档冲突。
- Opus：迁移重建与schema语义核对。
- Sonnet：锁文件/生成路由树，统一安装依赖。
- 主会话：独立新测试库、整合验证、定点Opus复核、merge提交、推送PR与GitHub合并。

此前功能本地验证与评审见 [多模态交付](knowledge-multimodal-delivery.md)。那些证据不替代本次merge后的新状态验证。

## 验证与状态

合并冲突已解决；独立[整合评审](knowledge-pr-integration-review.md)通过，未确认新的合并阻塞。

- 新库 `pace_knowledge_merge` 完整 migrate成功：vector0.8.7，知识GIN/HNSW真实存在；schema41表，再generate无变化。
- main已发布0033–0035不改，知识增量统一0036；见[迁移整合](knowledge-main-integration-migrations.md)。
- 主分支整合后全量Vitest233文件/2047测试全部通过，0跳过/0失败；最终OpenUI分派修复又做定向回归。
- 全仓typecheck/build、focus/contract通过；14个冲突/修复文件Biome error级检查通过。
- 五资源页签、父专家插件/知识绑定、聊天OpenUI与知识引用并存。OpenUI工具查询与执行保持http/generated白名单，knowledge不会作为远程HTTP工具转发。
- 生成路由树已由正式Vite构建验证，锁文件frozen安装通过。

成果本地已提交，整合merge提交与PR推送/合并随后执行；未部署或操作主应用数据库。不开启CI或PR监控。提交/PR attribution按用户本会话要求。
