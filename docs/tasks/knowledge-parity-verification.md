# 知识能力五组定点证据复核

2026-10-25；独立静态核验当前 worktree；只产出本文件，不修改产品、不派代理。
已对照三份 knowledge-parity 报告，结论取自产品调用链；未查上游代码，不以 README 或旧测试通过作证。
判定：confirmed=调用链成立；qualified=需限制触发/影响；rejected=现有链不支持该主张。P1 优先修复，P2 后续完善。
契约基线：`docs/tasks/weknora-core-proposal.md:50` 禁静默覆盖人工知识；`:52` 主动撤销来源/范围须立即限制检索和原文访问。
以下触发均是静态可得条件，不冒充运行复现，也不以理论 race 列缺陷。

## 1. 人工 chunk 的引用、历史、同步与重建 — confirmed / qualified，P1

- confirmed：正文 PATCH 保留 versionId/pageFrom/pageTo，只更新正文、分词、清向量和 editedByUser；repo 原位 UPDATE，无 chunk 修订追加。
- 核心链：`packages/api/src/features/knowledge/routes.ts:857` → `packages/db/src/repo/knowledge.ts:652` → `packages/api/src/features/knowledge/retrieval.ts:116`。
- 触发：把原 PDF 某块改成原件没有的新句，检索该句；hit 仍带旧页码/versionId，引用弹窗按旧版本读 Markdown（`packages/web/src/components/knowledge-citations.tsx:113`），且 hit 不携带人工标记。
- confirmed：再次修改同一块覆盖上次正文；文档历史不是同版本内人工编辑历史。PATCH 本身不允许改页码（`packages/api/src/features/knowledge/routes.ts:110`），不要写成支持人工任意修改来源坐标。
- confirmed：远端正文变化 → `packages/worker/src/knowledge/ingestion.ts:650` 哈希不同 → `:681` 摄取 → `:443` 新建原文 chunks → `:461` 切当前版本；不检查人工标记、不报告冲突，旧人工块退出当前召回。
- qualified：这通常是旧版本留存、当前知识被替换，不是物理抹掉所有历史；同哈希同步会跳过重新摄取，不必然覆盖人工块。
- confirmed：库级 rebuild 默认 chunksOnly=false（`packages/api/src/features/knowledge/routes.ts:116`、`:970`），`packages/worker/src/knowledge/ingestion.ts:592` 从原件重摄取，也绕过人工内容确认。
- 反证例外：chunksOnly=true 仅补向量（`packages/worker/src/knowledge/ingestion.ts:583`）；专用 reprocess 有确认（`packages/api/src/features/knowledge/routes.ts:758`），不能笼统写“所有重处理无提示”。
- 额外同目标边界：reprocess 只检查当前版本前 200 块；人工块全在后页时确认不生效（同文件 `:758`），属于确定分页边界，不是并发猜测。

## 2. RSS 全文退摘要与缺身份 — confirmed，P1 / P2

- 核心链：`packages/worker/src/knowledge/sources.ts:529` 抓文章失败 → `:543` feed 正文/摘要兜底 → `packages/worker/src/knowledge/connector-adapter.ts:86` → `packages/worker/src/knowledge/ingestion.ts:629` 哈希比较 → `:681` 新版本。
- 可发生触发：上轮文章成功存全文，本轮文章网络失败或无可提取正文，feed 只有非空摘要且与旧全文不同；摘要通过后续摄取即替换当前全文，没有“保留上轮成功全文”的信号。后续解析/模型失败则不会成功切版。
- 旧游标 itemHashes 不参与跳过文章抓取；`packages/worker/src/knowledge/sources.ts:500`、`:523`、`:551`、`:566` 只读取 initial 条件并重算哈希。不是已具备有效正文增量过滤。
- RSS 无 GUID/link 时，即使有 title 也会丢条目：feedLink 缺值返回空字符串（同文件 `:380`），`:458` 的 ?? 不跳过空串，`:459` 直接跳过；空 GUID 也会挡住有效 link。
- Atom 无 id 时用 title，未以 link 回退（同文件 `:429`）；缺 id/title 但有 link 会被跳过，同名标题会共享身份。此身份缺口列 P2，全文退化列 P1。
- 反证：RSS `complete:false`（同文件 `:570`）；不能把滑出滚动窗口报告成远端删除。

## 3. pause / disable / delete / 范围收缩 — qualified，含 P1 残留

- disable confirmed 已生效：`packages/api/src/features/knowledge/source-routes.ts:239` 停用所属文档并标 Wiki stale；delete keep 同文件 `:264` 停用，delete 删除分支 `:291` 删行。
- 调用完成后的准入链：`packages/api/src/features/knowledge/retrieval.ts:66` 仅 ready/current/enabled；`packages/api/src/features/knowledge/mcp.ts:119` read 仅 ready。正常完成 disable/delete 后原文退出新检索/read，不能重报成完全未撤权。
- pause qualified：PATCH 只更新 source.status，没有停用文档；`packages/worker/src/knowledge/ingestion.ts:752` 只取消后续同步。暂停后现有 ready 内容仍可搜/read；若 pause 定义为暂停抓取，这不等于撤销授权，报告须明确语义，不能一概判权限缺陷。
- range-shrink confirmed P1：`packages/api/src/features/knowledge/source-routes.ts:245` → `packages/db/src/repo/knowledge.ts:870` 仅换范围行，不撤销范围外文档；检索/read 不再核对来源范围，成功保存缩小配置后仍可访问旧文档，违反 proposal:52。
- 不是“下次同步一定补救”：`packages/worker/src/knowledge/ingestion.ts:913` 只有 syncDeletions=true 且完整枚举才扫掉未见文档；全范围禁用时 `:766` 直接报错，旧文档仍在。
- 额外 confirmed P1：撤权后完整 rebuild 可恢复可读，无需 race。库级 rebuild 不过滤 disabled 文档（`packages/worker/src/knowledge/ingestion.ts:567`），原件重摄取后 `packages/db/src/repo/knowledge.ts:508` 无条件设 ready；检索/MCP read 只看文档状态。
- 触发：disable 来源或 delete keep 后对保留原件的文档执行默认完整 rebuild，摄取成功即可恢复召回/read，来源仍禁用或已不存在；不是管理员显式重新授权来源。该链也要求修正“来源失权无残留”的总括。

## 4. 无相关性阈值与 MCP 降级状态 — confirmed，P1 / P2

- `packages/api/src/features/knowledge/retrieval.ts:105` 非空向量按距离取 top50，无最低相似度；`:192` RRF、`:214` rerank、`:224` 截取结果均没有相关性过滤。
- 触发：库内有可用向量、query embedding/SQL 成功，询问库外问题；未重排或重排仍给分时也能带回无关候选。确认的是无门槛，不能静态声称“必然答错”或已测质量下降；门槛校准列 P1。
- `packages/api/src/features/knowledge/retrieval.ts:164` 的 degraded 仅表达向量路可用性；`:218` 重排失败退回 RRF 不另报状态。`packages/api/src/features/knowledge/mcp.ts:98` 丢弃 degraded，仅发 hits。
- 触发：embedding 缺配置/失败时 Agent 收到的 hits 无降级标志；rerank 失败也不可诊断。状态透明度列 P2，score 不应解释为统一概率。

## 5. Wiki 自组织与失效发布内容的 Agent 可见性 — qualified / rejected，P2

- confirmed：自动摄取只创建首个 overview 并为关联页/overview 排单页任务（`packages/worker/src/knowledge/ingestion.ts:294`、`:310`、`:348`）；生成提示词绑定一个页面，工具只有搜原文/读原文/存草稿（`packages/worker/src/knowledge/wiki.ts:225`、`:331`）。没有完整实体归并/目录自组织调用链。
- qualified：“只能 overview”过强：`packages/worker/src/knowledge/wiki.ts:67` 可解析指定页或按任务标题建页；已有页面可单页生成，缺的是自动组织全库，不是不能生成其他页。
- confirmed：来源删/禁用后 `packages/db/src/repo/knowledge.ts:1241` 只标 stale，保留发布 currentVersionId；`:1100` SDK 新草稿不覆盖已发布内容。管理 REST `packages/api/src/features/knowledge/wiki-routes.ts:108` 仍返回版本正文与 stale 状态。
- rejected：“stale 已发布 Wiki 继续作为检索内容对 Agent 可见”：当前 `packages/api/src/features/knowledge/retrieval.ts:87`、`:106` 仅查 chunks/documents，MCP `mcp.ts:71`、`:102`、`:145` 仅 search/read/list 文档；Wiki 生成检索 `packages/worker/src/knowledge/wiki.ts:123` 也仅查原文块。
- 可发生触发是“删来源后管理员仍能查看 stale 发布正文”；没有 Wiki→知识 chunks/MCP read 的消费链，不能升级成 Agent 检索泄露。若要求 Wiki 成为 Agent 知识层，当前缺少该消费闭环，本身列 P2。

必须修正报告：retrieval:43–49 补同步/完整 rebuild 绕过与专用确认例外；wiki-sources:38–45 限定 stale 的实际消费者及单页能力；platform:30 不得把既修基线当当前范围收缩/重建撤权的通过依据。
优先级：P1 人工证据误归属、静默替换、范围撤销不生效、重建恢复撤权、RSS 全文退化与检索门槛；P2 身份回退、降级诊断、Wiki 自组织/消费闭环。无静态证据支持 P0。
未跑 DB、外部服务、模型、上游代码或旧测试；没有动态复现、质量指标和性能结论，以上结论只覆盖列出的确定控制流与触发条件。
