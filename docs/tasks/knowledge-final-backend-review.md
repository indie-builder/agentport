# 知识实现最终后台独立复核

2026-10-25。结论：**需修复，暂不通过后台完整闭环验收**。

本次按用户指定范围独立只读检查实际工作树（含未跟踪文件），复验上一轮整改；仅本报告为新增写入。未改实现、未提交、未运行会写共享树/数据库/Redis的测试。按个人项目、单 worker（知识并发2）判断，不提出全量重构或缩减 Wiki / Feeds / Feishu / GitLab 范围。

快照：重点文件最后修改时间分别为 ingestion.ts 13:37:52Z、sources.ts 13:04:51Z、routes.ts 13:17:44Z、repo/knowledge.ts 13:17:34Z、package.ts 13:28:29Z。另一个 agent 在途的 Web pages 与包图完成情况不作为本轮缺陷依据；本报告判断仅适用于实际读到的后台文件快照。

## 已确认落地的整改

- connector-adapter.ts 按所有启用 ranges 逐项读取，游标按 range 隔离，中间检查点 complete=false，最终汇总；Feed 明确 complete=false，GitLab 全 tree、Feishu 完整遍历后才 complete=true。摄取失败不推进来源游标、不推导缺失删除。
- 飞书 config.appId 经 settings.appId 进入实际 token 交换，appSecret 从加密 credentials 取；不再只读取首个 range。
- paused/disabled/auth_error 在任务启动时不执行同步；显式 disabled 会禁用 ready 文档并标引用 stale。下述鉴权错误路径仍有缺口。
- worker 正式依赖 SDK，静态导入；Wiki 使用 tools: []、独立 cwd/HOME/CLAUDE_CONFIG_DIR、env 白名单、settingSources: []、strictMcpConfig: true、关闭 auto-memory。已核官方 TypeScript 文档和本地 sdk.d.ts:1669/1683；env 是替换环境，tools: [] 在本地类型明确禁用内置工具。未调用真实模型。
- 已发布页面的 SDK 草稿仅追加版本，不切已发布 current 指针；存在显式 publish 路由，检查页/版本归属与禁用来源。下述 stale/旧版本状态仍需修复。
- Docling URL/token 已从 worker index → queue → parsing adapter 注入；结构分块逻辑已有修正。取消信号仍漏一段，见问题4。
- 模型端点创建/修改/测试入口已校验私网白名单；模型请求 redirect:error；embedding/rerank 响应使用有限数、维度、index 唯一与范围校验，未再 Number() 吞非法向量。
- 新增 chunk 版本归属、rebuild 文档跨库归属均已校验；Wiki SDK 搜索/读取/引用限制本库和指定文档。
- routes/index.ts 实际注册知识包、内容、图片、基础、来源、Wiki 路由。专家包知识连接导出为标准 HTTP MCP + 专用 token 环境变量占位，secretKeys 有登记，无真实密钥。独立语料包有分页与图片文件归档；历史删除后的引用自洽仍有问题3。
- 已接定时 scheduler、启动/周期 reconciliation、运行取消 Redis 信号、可重试模型/解析故障回 queued。下述同步记录生命周期仍有缺口。

## 必须修复

### 1. 同步任务取消和重试没有维护独立同步记录

证据：`packages/api/src/features/knowledge/routes.ts:1018`、`:1038`；`packages/db/src/repo/knowledge.ts:767`；`packages/worker/src/knowledge/queue.ts:138`、`:223`。

触发：新建一个 sync，在 queued 状态调用 cancel。requestCancel 只把 knowledge_jobs 改 cancelled，knowledge_sync_runs 仍 queued；worker 条件认领失败直接 return，reconciler 也只扫 queued/running 的 jobs，因此该 run 永久排队。随后对失败/取消 sync 调 retry，原 payload（含原 syncRunId）原样复制到新 job，后续结果会覆写原同步历史，而非生成一次新同步记录。

影响：来源同步历史永久显示进行中，重试覆盖过去记录，job 与 run 无法一一对应。

最小修法：queued sync 取消时一并 finish 对应 run；人工 retry sync 创建新的 syncRunId 和 cursorBefore，再构建新 payload。验收：queued sync cancel 后 job/run 都 cancelled；retry 得到不同 runId，旧记录状态和内容不变。

### 2. 真实来源鉴权失败接不到失权处理，旧文档仍可供 MCP 读取

证据：`packages/worker/src/knowledge/sources.ts:223`、`:1023`；`packages/worker/src/knowledge/ingestion.ts:854`、`:859`；`packages/api/src/features/knowledge/mcp.ts:119`。

触发：先成功同步飞书或 GitLab，再撤销 token/应用权限。HTTP 401/403 在 fetchChecked 抛普通 Error；飞书非零业务 code 在 assertFeishuCode 同样抛普通 Error。runSync 只识别 KnowledgeModelError(kind='auth') 来设置 auth_error，真实 connector 永远不会抛这个类型；该分支即便进入也没有禁用旧来源文档。

影响：来源继续 active，被 cron 反复调度；此前 ready 文档仍在检索及 knowledge_read 可见，Wiki 引用也不变 stale。暂停同步与明确失权应区分，但明确鉴权失败必须执行已定义的失权语义。

最小修法：在来源 HTTP/飞书业务响应边界分类已知鉴权失败，在 runSync 统一设 auth_error、禁用该来源文档并标 Wiki stale；不要把任意网络错误当撤权。验收：fixture 首轮成功，次轮401/403及已知飞书鉴权code，断言来源 auth_error、旧文档不能 search/read、Wiki stale。

### 3. 删除被 Wiki 历史引用的 chunk/文档后，自己的导出包无法再导入

证据：`packages/api/src/features/knowledge/package.ts:490`、`:820`、`:1008`；`packages/db/src/schema.ts:1029`、`:1046`；`packages/api/src/features/knowledge/routes.ts:880`。

触发：Wiki 版本引用 chunk C，之后通过已有删除 API 删除 C 或整篇来源文档，再导出知识库。Wiki 版本 sourceChunkIds 是 JSON 历史记录，不随 chunk 删除；导出原样保存旧 C，但导出的 documents/chunks 已无 C。导入 validateReferences 强制每个历史 sourceChunkId 必须在包内，直接 INVALID_INPUT。

影响：正常使用过删除功能的知识库可能无法恢复/迁移，受影响的不仅当前 Wiki，还包括任一保留历史版本。

最小修法：包格式显式保留失效历史引用的身份/状态，并在映射时允许已声明的失效引用；继续拒绝未声明的伪造引用。不要通过删除历史版本或无声丢掉引用解决。验收：引用→删除chunk/文档→导出→删除原库→导入成功，Wiki历史保留且引用显式失效。本次内存检查确认当前缺失 ID 判定会拒绝该路径，未执行数据库删除。

### 4. Docling 取消信号没有从摄取层传入解析器

证据：`packages/worker/src/knowledge/ingestion.ts:96`、`:388`；`packages/worker/src/knowledge/parsing-adapter.ts:31`；`packages/worker/src/knowledge/parsing.ts:631`。

触发：上传 PDF，Docling 请求处于等待中，此时取消 running job。queue 的 AbortController 已 abort，但 KnowledgeDeps.parse 类型和调用均不传 signal；适配器只有 input.signal 存在才向 parseDocument 转发。实际请求只受 Docling 自己10分钟超时控制。

影响：取消后任务和 Docling 请求最多继续等待10分钟，占用知识 worker 两个槽位之一；两个慢 PDF 都取消时，新任务仍不能及时执行。旧版本不会因此丢失，但取消闭环未完成。

最小修法：KnowledgeDeps.parse 接受 signal，并在唯一 deps.parse 调用传入 input.signal；embeddingClient 同理可传当前 signal，至少先补解析这一实际长请求。验收：fixture Docling 保持未响应，取消后连接中止、job及时 cancelled、下一 job 开始，无需等10分钟。

### 5. 发布旧草稿可以把已经过时的来源重新标成有效

证据：`packages/db/src/repo/knowledge.ts:1046`、`:1058`、`:1166`、`:1172`。

触发：SDK 草稿引用文档 v1 的 chunk；文档随后摄取成功切到 v2，v1 chunks 按设计保留。发布先前草稿时 usableSourceChunks 只检查 enabled 与文档 ready，没有检查 chunk.versionId 是否等于文档 currentVersionId，因此仍通过，页面被设 published，来源 stale=false。

影响：已经过时的证据重新变成“有效发布”，与 SDK 保存引用时的当前版本约束不一致，也抹掉版本更新产生的 stale 提示。

最小修法：usableSourceChunks 一次查询同时取 currentVersionId；旧版本引用在显式发布时拒绝并要求更新，人工回退/保存历史内容则保留 stale，不能洗成 published。验收：v1草稿→文档v2→发布v1草稿应409或明确保持stale；正常当前版本发布仍成功。

### 6. 未发布草稿被标 stale 后，被误判为曾经发布

证据：`packages/db/src/repo/knowledge.ts:1028`、`:1125`、`:1227`；`packages/worker/src/knowledge/ingestion.ts:278`。

触发：首次 SDK 生成产生 draft + currentVersionId，并建立 source 关系；尚未人工 publish 时更新来源文档。markWikiStaleByDocument 无条件把页面改 stale。hasPublishedVersion 仅靠 currentVersionId 非空且 status!='draft' 判断，于是把这个从未发布的旧草稿认成已发布；后续自动生成只追加版本，不再更新草稿指针，页面也失去从未发布的准确状态。

影响：草稿/已发布事实与新鲜度共用 status 导致丢失，draftPublished 复验不通过；用户看到的当前稿可能一直是首轮过时草稿。

最小修法：保持“是否已发布”与 stale 标记的判断可靠；最少让 stale 标记不把未发布 draft 改成已发布语义，并相应保留引用 stale。无需全量重构。验收：首次草稿→来源更新→自动生成，仍明确未发布，当前草稿行为符合约定；首次实际 publish 后再生成才保留已发布指针。本次用实际 hasPublishedVersion 函数体做内存复现，draft→stale 后返回 true。

## 验证及边界

只读命令：rg --files 枚举实际文件；/usr/bin/git status --short packages 确认未跟踪模块；逐段读取调用方/实现/既有测试；Node 内存复现 hasPublishedVersion 状态误判、缺失历史引用校验和 Set.add 行为。没有运行 Vitest、DB mutation、队列消费、真实模型或企业 API。

官方核对：https://code.claude.com/docs/en/agent-sdk/typescript 及已安装 worker SDK sdk.d.ts:1669、1683。真实 SDK/model、飞书/GitLab企业凭据端到端行为未实测，已有测试文件的存在不记为本次通过。

未审 Web 与 backup（交由另一 reviewer），未把其他 agent 在途实现当最终缺陷；未连接主库或隔离 DB/Redis，未执行提交或合并。
