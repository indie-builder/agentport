# PACE 与 WeKnora：Wiki / Feeds / 外部源逻辑审查

- 范围：当前 worktree 源码静态审查；未实现功能、未派代理、未启动服务/模型、未访问共享 DB。
- 官方固定版本：`e1f9a6166a593a4804a2f99f1d942919c9cc8ea7`（任务提供的 main 对齐结果，本次未再次联网核对）。
- 以下 `W/` 唯一展开为 `.tmp/references/weknora-ycXjpOdz/source/WeKnora-e1f9a6166a593a4804a2f99f1d942919c9cc8ea7/`；其余路径相对本 worktree 根。每个结论均对应本次直接读取的代码，不以旧任务报告为依据。
- 结论：PACE 已有知识摄取、单页 Wiki 草稿、版本发布/回退、来源调度及失权处理；与官方的差异主要是知识组织深度、外部对象覆盖、真实增量和可诊断性，不能按同名入口认定等价。

## 首批来源支持边界

| 能力 | PACE | 官方固定版本 |
|---|---|---|
| RSS / Atom / JSON Feed | 支持解析及逐项导入，全文提取与增量局部支持 | RSS 连接器有正文指纹/条目信号及抓取失败保留逻辑；不把“支持 feed”解释为抓取任意站点必成功 |
| 飞书 Wiki 空间/节点及子树 | 支持 docx 与分页递归；混合对象局部支持 | Wiki/Drive 共享对象处理引擎，支持 docx/doc/sheet/bitable/file；仍有不支持对象 |
| 飞书 Drive 文件夹 | 支持递归、docx、文本文件；二进制和云表格不支持 | 支持文件下载、doc/sheet/bitable 导出和附件子项 |
| GitLab 项目/ref/路径 | 支持文本仓库文件、全树分页、完整快照删除对账；真实增量局部支持 | 支持仓库文件、更多格式、commit compare 增量、删除/重命名 |
| GitLab Wiki / Issue / MR | 本连接器不支持 | 本连接器同样未实现，不列官方已有优势 |
| 企业权限 | 来源凭据、部署级私网 allowlist、整源失权停用 | 连接器按应用凭据可访问范围取数；不能据此承诺逐用户 ACL 镜像 |

## 核心差距（按业务影响和最小适配顺序）

### 1. P1：RSS 临时失败会让已存全文退化为摘要，且游标未用于跳过未变条目

- PACE 每轮重新抓取文章，异常后回退 feed 正文/摘要；生成的 `itemHashes` 只返回，读取旧游标只用于 `initial`，不做增量过滤：`packages/worker/src/knowledge/sources.ts:495`、`:523`、`:539`、`:551`。摄取按新内容哈希接收变化，因此回退摘要会成为内容更新，而非保留既有全文：`packages/worker/src/knowledge/ingestion.ts:643`、`:681`。
- 官方先比较 feed 信号，未变则跳过；文章失败且旧正文可用时保留旧指纹/正文，后续仍可重试：`W/internal/datasource/connector/rss/connector.go:244`、`:255`、`:264`、`:294`。
- 身份也有边界：PACE RSS `guid ?? link ?? title` 中 link 已归一为空字符串，缺 guid/link 时不会回退 title；Atom 只用 id/title，没有 link 回退：`packages/worker/src/knowledge/sources.ts:429`、`:458`；官方使用首个非空 GUID/link/title：`W/internal/datasource/connector/rss/connector.go:239`。
- 滚动删除不是缺口：PACE 明确 `complete:false`，不会把滑出 feed 窗口当远端删除：`packages/worker/src/knowledge/sources.ts:569`；摄取删除需完整枚举：`packages/worker/src/knowledge/ingestion.ts:911`。
- 最小路径：保留既有 connector/摄取接口，增加“全文失败不得降级既有成功内容”的结果语义，再利用条目信号和正文哈希跳过读取；补无 id、连续全文失败、窗口滚动用例。全文目前用 article/body 选择加 Turndown，并非阅读模式抽取器：`sources.ts:362`。

### 2. P1：飞书复杂对象覆盖不足，单个不支持对象可阻断整范围

- PACE 支持空间/节点、Drive 子文件夹、docx 分页与基本 Markdown（含普通表格）；Wiki 非 docx 直接抛错，Drive 只收 docx/text 文件，PDF 等二进制抛错：`packages/worker/src/knowledge/sources.ts:904`、`:1048`、`:1202`、`:1248`、`:1270`、`:1281`。
- 图片、附件、内嵌 sheet/bitable/画板仅占位，不是已同步内容；大 docx 达块数上限直接返回截断结果：`packages/worker/src/knowledge/sources.ts:984`、`:1103`。混合空间和长文档因此不能标“完整支持”。
- 官方 Drive 对 doc/sheet/bitable 走导出，对 file 下载字节：`W/internal/datasource/connector/feishu/drive/connector.go:435`、`:461`；共享 docx 路径处理附件子项：`W/internal/datasource/connector/feishu/core/shared.go:409`、`:479`、`:501`。官方引擎也明确跳过 mindnote/slides 等：`W/internal/datasource/connector/feishu/core/engine.go:194`，并非支持所有对象。
- 最小路径：用现有摄取的 Buffer/解析能力接收二进制和导出文件，补云表格/附件；枚举保留失败项而不是把整个混合范围判死；截断必须显式失败或标记不完整。无需照搬 Go 服务。

### 3. P1：Wiki 更新/撤回是“重写草稿 + stale”，尚非贡献级增量维护

- PACE 摄取后标记关联页面 stale，并为关联页和 overview 排队生成草稿；自动生成不会覆盖已发布版本：`packages/worker/src/knowledge/ingestion.ts:281`、`:318`、`:354`；`packages/db/src/repo/knowledge.ts:1100`、`:1135`。来源停用/删除使文档退出使用并标 stale：`packages/worker/src/knowledge/ingestion.ts:814`、`:865`、`:733`。
- 官方按文档维护贡献，更新时处理旧 slug 与新 slug 的贡献撤回，再按 slug reduce；不是仅重跑整页提示词：`W/internal/application/service/wiki_ingest_batch.go:1693`、`:1707`、`:1890`；撤回有独立持久任务入口：`W/internal/application/service/wiki_ingest.go:653`。
- 影响：新草稿与旧发布内容并存是 PACE 的人工发布设计，不应报“自动覆盖用户编辑”；但 stale 不等于事实已撤回，也不能声称知识页已完成自动更新。
- 最小路径：保留 SDK 与人工发布契约，先把“哪份来源变动、哪些贡献失效”呈现在草稿审阅与差异中，再按来源贡献更新；继续复用现有任务和版本表，不另造 agent loop。

### 4. P2：Wiki 单页生成与官方知识组织深度不等

- PACE 工具只有 search/read/save_draft，提示词围绕一个绑定页面；自动创建的是唯一 overview，其他页面需要已有结构：`packages/worker/src/knowledge/wiki.ts:218`、`:331`；`packages/worker/src/knowledge/ingestion.ts:18`、`:310`。
- 官方按文档抽取实体/概念、引用分类、归并到页面，稳定同一实体身份并规划分类目录：`W/internal/application/service/wiki_ingest_batch.go:1322`、`:1786`、`:1890`；`W/internal/application/service/wiki_ingest_cite.go:257`；`W/internal/application/service/wiki_ingest_dedup.go:396`；`W/internal/application/service/wiki_ingest_taxonomy.go:32`。
- 官方还有结构化索引、入链/出链维护与修复：`W/internal/application/service/wiki_page.go:560`、`:1104`、`:1454`、`:1536`；界面真正使用索引和反链：`W/frontend/src/views/knowledge/wiki/WikiBrowser.vue:236`、`:619`。PACE 界面是页面列表与单页编辑器：`packages/web/src/pages/knowledge-detail.tsx:1913`、`:2002`。
- 最小路径：在现有 SDK 工具和 job 上先做页面计划、同名实体复用、结构化索引和链接；按真实知识库样本验收跨文档合并，不要求复制官方调用链。

### 5. P2：有版本与来源 ID，但引用覆盖、lint 与内容损失保护仍不等价

- PACE 验证非空引用集合中 chunk 当前有效且在范围内，保存 document/version/chunk 来源；但允许空 `sourceChunkIds`，未验证正文各结论的引用覆盖：`packages/worker/src/knowledge/wiki.ts:180`、`:186`、`:309`、`:365`。版本、发布来源校验和回退已实现：`packages/db/src/repo/knowledge.ts:1082`、`:1157`、`:1196`。
- 官方 lint 检查孤页、坏链、失效来源、缺少交叉引用、空内容等，提供自动修复；另对重写丢表格行进行保护：`W/internal/application/service/wiki_lint.go:16`、`:94`、`:346`；`W/internal/application/service/wiki_write_row_guard.go:149`；拒绝写入的贡献会留待重试：`W/internal/application/service/wiki_ingest_batch.go:1884`。这也不是对所有事实真实性的保证。
- 最小路径：先让无来源生成显式可审阅，补断链/失效引用检查与版本差异；按实际表格样本决定是否加入覆盖损失检查。PACE 已用草稿保护已发布页，不能把缺行保护混称为没有版本保护。

### 6. P2：GitLab/飞书的“增量”目前主要发生在下载后的内容判等

- PACE GitLab 每轮拉全树并逐个 raw 文件，只支持文本扩展；飞书每轮重新枚举和取 docx，游标只含 initial：`packages/worker/src/knowledge/sources.ts:578`、`:678`、`:698`、`:718`、`:1317`。适配器 revision 用 externalId、内容均标成已解析 Markdown：`packages/worker/src/knowledge/connector-adapter.ts:76`，HTML/CSV 等并不因此完成各格式解析。
- 官方 GitLab 用 commit SHA/compare 读变更与删除/重命名，格式含 PDF/Office/图片等：`W/internal/datasource/connector/gitlab/connector.go:164`、`:182`、`:193`、`:390`；飞书按编辑时间跳过未变节点，失败不推进该节点时间，支持检查点：`W/internal/datasource/connector/feishu/core/engine.go:148`、`:161`、`:167`、`:200`。
- PACE 不是没有分页或删除：全树分页错误抛出，完整快照才推导删除且需开启 syncDeletions：`packages/worker/src/knowledge/sources.ts:679`；`packages/worker/src/knowledge/ingestion.ts:911`。GitLab Wiki/Issue/MR 两侧连接器均未见入口，不列为官方优势。
- 最小路径：GitLab 保存 head，飞书保存对象版本/编辑时间；先补 bytes 与 MIME 的传递，交现有 parser 处理原文件；保留完整枚举的删除门槛，增量事件另明确 deleted 语义。

### 7. P2：“测试”尚不等于试连，范围选择缺远端导航

- PACE test 仅解密凭据并运行 configIssues，成功不证明 DNS/HTTP/凭据权限或所选范围可读：`packages/api/src/features/knowledge/source-routes.ts:303`。范围 UI 是输入空间/节点/folder/project ID 等，未见远端资源树接口：`packages/web/src/pages/knowledge-detail.tsx:2669`；API 在实际 sync 才入队：`packages/api/src/features/knowledge/source-routes.ts:324`。
- 官方服务调用 connector.Validate，并有 ListResources 与祖先解析：`W/internal/application/service/datasource_service.go:406`、`:427`、`:459`；编辑器加载远端资源并展开树：`W/frontend/src/views/knowledge/settings/DataSourceEditorDialog.vue:369`、`:504`。
- 最小路径：把现有按钮明确为配置检查，或补一次只读远端验证；复用同一连接器增加分页导航，不把整轮同步当试连。私网 allowlist 只是部署网络准入，不等于企业成员/文件 ACL 同步：`packages/worker/src/knowledge/ingestion.ts:71`、`:865`。

### 8. P2：任务恢复已存在，但日志无法做准确差异对账和逐项恢复

- PACE 已有 cron 对账、queued 补投、丢失 running 任务收尾，单项失败不推进来源游标：`packages/worker/src/knowledge/scheduler.ts:124`；`packages/worker/src/knowledge/reconcile.ts:55`、`:117`；`packages/worker/src/knowledge/ingestion.ts:894`。不能报“没有重试/恢复”。
- 但未变文档的 upsert 返回 false，调用处一律计 updated；单项错误只打 worker 日志，运行记录只有计数与通用错误：`packages/worker/src/knowledge/ingestion.ts:643`、`:838`、`:844`、`:896`；Web 只展示新增/更新/失败及 run.error：`packages/web/src/pages/knowledge-detail.tsx:2978`。因此“更新 N”不是内容变动 N，用户也不能从运行记录定位每个失败对象。
- 官方日志界面展示 created/updated/deleted/skipped/failed 与逐项失败列表：`W/frontend/src/views/knowledge/settings/DataSourceSyncLogs.vue:259`、`:289`；飞书失败项有对象身份并保留节点游标：`W/internal/datasource/connector/feishu/core/engine.go:167`、`:175`。
- 最小路径：upsert 返回 created/updated/unchanged 三态，保存有上限的对象错误列表与恢复检查点；复用现有 BullMQ/reconciler，先实现可对账、可定位，再决定是否需要逐项重试入口。

## 后续定点复核补充

独立[定点复核](knowledge-parity-verification.md:30)确认：来源禁用/删除正常完成后会停用/删文档；暂停仅停抓取，应与撤权区分。但范围收缩只换配置、不立即停用范围外文档；完整 rebuild 又可把已撤权来源的保留文档设回 ready，这两项列 P1。人工修改还可能在源正文变化或完整 rebuild 后被替换为新的当前版本，缺冲突提示；旧版本通常仍留存。

[Wiki 复核](knowledge-parity-verification.md:47)限定实际消费者：支持指定页生成，首次自动建 overview 不等于只能生成 overview。stale 发布正文仍供管理员查看，但现有检索/MCP仅消费原文档，不消费 Wiki，不能报成失效 Wiki 被 Agent 继续召回。反过来，若 Wiki 要作为专家知识层，当前缺少该消费闭环（P2）。

## 验证证据与界限

- 本次执行：直接读取两侧 worker/service/connector/API/repo/schema/Web/测试代码并核对行号；静态检查报告行数及唯一输出路径。未运行测试，不声称集成验证通过。
- PACE 来源测试已覆盖 RSS/Atom/JSON、分页、重定向凭据、GitLab 完整快照、飞书部分渲染及不支持对象报错：`packages/worker/test/knowledge-sources.test.ts:555`、`:635`、`:684`。这些本地 HTTP fixture 不能证明真实飞书混合空间、企业授权、长文档和公网全文失败后不会退化；“报错符合测试”不等于支持该对象。
- Wiki 测试注入 fakeQuery，覆盖 SDK 工具契约、草稿不覆盖、有效引用、取消与失败：`packages/worker/test/knowledge-wiki.test.ts:110`、`:199`、`:256`、`:292`；更新测试覆盖 stale/overview/任务去重：`packages/worker/test/knowledge-wiki-update.test.ts:270`、`:368`。均不能证明真实模型归纳质量、跨文档去重、事实覆盖或自动撤回正确。
- 后续验证可用：`pnpm exec vitest run packages/worker/test/knowledge-sources.test.ts`（本地 HTTP fixture）；Wiki/ingestion 测试须先提供独立测试 DB 与隔离队列，不在共享 DB 上直接运行。
- 图谱可视化、Lark 产品化、FAQ、更多连接器是可选扩展，不作为本批违约项；不以许可证、国际化或项目热度评价实现质量。
