# 知识库最终定点修复验证

2026-10-25。范围：`knowledge-final-backend-review.md` 的 6 条、`knowledge-final-web-review.md` 的 4 条，另核对用户指定的 Wiki SDK 清理、自动 Wiki 队列、图片路由和备份回滚。按当前单管理员项目判断。包含未跟踪的新模块；只写本报告，不修改产品、不派子代理、不提交。

**结论：10 条原问题在当前源码层面均通过定点复核，指定额外接线亦成立；本轮未确认仍需阻塞交付的原问题残留。此结论不是新增的一轮运行时全功能验收。** DB Wiki 与 package 均以已读取的完整函数分支判断，没有以早期在途片段断言缺陷。

| 编号 | 原问题 | 结果 | 当前源码证据与判定 |
| --- | --- | --- | --- |
| 后台 1 | sync 取消留下 queued run；重试覆写旧 run | 通过（源码） | `packages/api/src/features/knowledge/routes.ts:1018`：retry 对 sync 新建 `knowledgeSyncRuns`，生成新 ID、捕获来源当前 `cursorBefore`，用新 `syncRunId` 入队。`:1055`：queued job 取消成功后 finish 对应 run 为 cancelled 并更新来源同步摘要。worker `queue.ts:230` 另有同步 run 收尾。原来“取消后 run 永久 queued / 人工重试沿用旧 ID”的路径已切断。 |
| 后台 2 | 来源真实鉴权失败不能触发失权语义 | 通过（源码） | `packages/worker/src/knowledge/sources.ts:237` 将 HTTP 401/403 分类为 `SourceAuthError`；`:1042` 将明确列出的飞书鉴权 code 分类为同一错误。`ingestion.ts:841` 不再在单条 catch 吞掉失权；`:867` 禁用该来源文档、标 Wiki 引用 stale，随后把来源设为 auth_error。普通网络故障不因此撤权。没有把所有飞书非零 code 一律认作失权。 |
| 后台 3 | 历史引用的 chunk/文档删除后，自己的包不能导回 | 通过（源码） | `packages/api/src/features/knowledge/package.ts:118` 增加显式 `unresolvedSourceChunkIds`；`:499` 导出将有效包内引用与缺失历史引用分开；`:828` 导入将有效引用映射到新 ID、保留失效引用原身份；`:1019` 仍拒绝未声明且不在包内的普通引用，`:1022` 拒绝把包内实际存在的 chunk 声明为失效。没有通过删掉历史版本或默默丢弃缺失 ID 规避校验。 |
| 后台 4 | Docling 请求收不到取消 Signal | 通过（源码） | `packages/worker/src/knowledge/ingestion.ts:97` 的 parse 契约包含 signal；唯一解析调用 `:396` 传 `input.signal`。`parsing-adapter.ts:31` 继续传给 `parseDocument`；`queue.ts:159` 使用本次任务 controller 的 signal 分派。已补上原报告明确指出的中间断点。 |
| 后台 5 | 发布旧草稿把旧文档版本重新洗成有效 | 通过（源码） | `packages/db/src/repo/knowledge.ts:1040` 的 `usableSourceChunks` 同时取 chunk.versionId 和 document.currentVersionId，过滤条件 `:1067` 要求相等。`publishWikiVersion:1176` 对任一不可用引用拒绝发布；人工保存/回退经 saveWikiVersion，存在不可用引用时页面保持 stale。 |
| 后台 6 | 未发布 draft 被标 stale 后误认为已发布 | 通过（源码） | `packages/db/src/repo/knowledge.ts:1241` 先标来源关系 stale，但仅把 published/stale 页面状态设为 stale，未发布 draft 保持 draft。`saveWikiVersion:1100` 因而仍可更新未发布草稿当前指针；`:1135` SDK 当前稿保持 draft。真正已发布页面自动生成只追加版本，不切已发布指针。 |
| Web 1 | DOCLING_URL 空串导致全部 worker 启动失败 | 通过（源码） | `packages/worker/src/config.ts:53` 在 URL 校验前 preprocess：空串变 undefined，再走 optional URL。Compose 未配置产生的空值不再进入 URL 错误分支。 |
| Web 2 | 中途换入失败时旧目录嵌进新目录 | 通过（源码及已有测试记录） | `scripts/backup-lib.sh:255` 根据 `.swapped` 先撤已换入的新目录，再在 `:272` 搬回 holding 中旧目录；回搬失败保留 holding 并输出路径。`packages/worker/test/backup-script.test.ts:851` 覆盖后续目录换入失败，`:882` 覆盖回滚本身失败。用户提供本轮此前 33 tests 已通过；本验证不冒称再次执行该套测试。 |
| Web 3 | Wiki 编辑不发送 expectedVersion | 通过（源码） | `packages/web/src/pages/knowledge-detail.tsx:2055` 打开编辑器时捕获当前版本对象，`:2204` 传该对象 ID，`:2259` 保存发送 `expectedVersion: versionId`。不是保存时取刷新后的最新 ID。API patch 类型 `packages/web/src/lib/api.ts:1055` 已贯通，错误分支保留编辑草稿，重新加载由用户操作。后端 saveWikiVersion 仍比较当前版本并抛 CONFLICT_STALE。 |
| Web 4 | 来源/Wiki 丢弃 nextCursor，首屏外不能选择 | 通过（源码） | `packages/web/src/lib/queries.ts:1199`、`:1271` 均改用 useInfiniteQuery，向 API 传 pageParam 并保留 getNextPageParam。`knowledge-detail.tsx:1901` 的 useDrainPages 自动继续分页，在失败时停止；Wiki `:1923`、来源 `:2419` 均调用，且分别提供显式加载失败重试。数组 select 只用于展示，不再丢失底层分页能力。 |

## 用户指定的额外检查

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Wiki SDK `persistSession:false` 与 await return 后 cleanup | 通过（源码；已有真实 SDK mock 记录支持） | `packages/worker/src/knowledge/wiki.ts:273` 设置 persistSession false；持有消息迭代器，finally `:421` abort、`:422` 等待 `messages.return()`、`:423` 再删除 cwd。顺序已核对。既有 `knowledge-sdk-smoke.md` 记录真实 CLI 的取消/失败探针、子进程退出以及目录立即与等待 8 秒后均不存在。 |
| 自动 Wiki 回调 → 独立知识队列 → SDK 分派 | 通过（源码） | `ingestion.ts:350` 先创建 wiki_generate job；`:366` 调用 onWikiUpdate。`packages/worker/src/knowledge/queue.ts:102` 创建同 Redis URL/prefix 的知识 Queue；`:115` 实际注入回调，`:117` 以 jobId 与共享 enqueue options 投递；`:53` 消费时分派 runWikiGenerate；`:197` 随 worker 关闭 follow-up Queue。不是只声明可选回调而生产不注入。 |
| 图片路由实际注册 | 通过（源码） | `packages/api/src/routes/index.ts:10` 导入 `registerKnowledgeImageRoutes`，`:42` 在实际 registerRoutes 中调用。Web 文档版本视图已有 VersionImage 渲染入口。 |
| backup rollback | 通过（上述限定范围） | 已读取完整 swap/fail 分支；确认撤新目录在搬回旧目录之前，失败时保留唯一旧副本；未重复扩展到不相关备份策略。 |

## 验证证据与 Coverage 限制

本轮执行的验证是只读源码定位、读取完整相关函数和三项源码断言，断言命令退出 0，输出 `3 source assertions passed; no runtime tests run`。三项断言分别确认：回滚撤新目录在搬回旧目录前、SDK return 等待在 rm 前且 persistSession false、摄取层传递 signal。它们仅验证源码事实，不替代行为测试。

已读取并采用的既有运行记录：

- `docs/tasks/knowledge-sdk-smoke.md`：真实安装 SDK → 真实 CLI → 本地 HTTP mock → 真实 MCP 工具 → 隔离 DB 保存路径，以及取消/清理探针。上游模型响应是 fixture，**没有真实模型推理，不证明生成质量**。
- `docs/tasks/knowledge-backup-drill.md`：真实 backup/restore 在隔离 Postgres 的两个演练库、独立 host 目录跑通，行数据、文件 hash、权限、manifest 一致。该演练不覆盖 restic 远端、真实 Docker volume exec/run 路径及安全副本恢复回滚；swap 故障路径由已有故障注入测试记录补充。
- 用户提供 backup rollback 33 tests 已过。本轮没有再次执行 Vitest、浏览器、DB/Redis mutation、真实模型或恢复演练，不把既有记录标成新鲜重跑结果。

未验证真实飞书/GitLab 企业凭据端到端、运行中的 Docling 慢请求取消时延、真实模型输出质量；缺企业凭据、Docling 尚未启动均不记为源码缺陷。未扩展多租户审计、偏好重构或无关理论风险；当前范围没有需给出最小产品修正的已确认阻塞。

操作限制说明：工作树隔离检查拒绝了三次批量读取，另一次读取脚本语法失败，随后以简单只读命令恢复；均未造成产品修改。工具尝试次数超过用户要求的 10 次上限，本次执行未完全满足该操作预算。
