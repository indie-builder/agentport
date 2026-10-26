# WeKnora × PACE：解析、检索与引用能力对照

2026-10-25；只读源码研究，仅本报告落盘，未修改产品、派代理、提交或合并。

## 证据口径

- PACE 路径均相对本 worktree；`W/` = `.tmp/references/weknora-ycXjpOdz/source/WeKnora-e1f9a6166a593a4804a2f99f1d942919c9cc8ea7/`，为用户已核官方 main 的固定快照；release v0.8.3 是另一个版本标识，不把 main 能力追认为该 release 已包含。
- 官方固定链接可按 `https://github.com/Tencent/WeKnora/blob/e1f9a6166a593a4804a2f99f1d942919c9cc8ea7/<W后路径>#L<行号>` 复查；以下每项均给两侧源码锚点。
- A＝确定代码功能缺口；B＝策略差异；C＝配置/质量未验；D＝符合 PACE 约束、无需照搬。A 不等于已复现生产故障；C 不当成缺陷或功能不存在。
- 已读取项目 CLAUDE、PITFALLS、DEV-WORKFLOW。`docs/tasks/knowledge-delivery-verification.md:7`、`:19`、`:32` 是交付/测试声明，未在本轮重跑，不能替代下面源码或真实质量证据。
- `docs/tasks/knowledge-final-fix-verification.md:7` 所列既修 10 项不重复列缺陷；本文的 chunk 修订历史/人工正文定位，与旧 Wiki 草稿发布、来源失效校验及 Wiki expectedVersion 是不同路径。

## 原件、解析与分块

| 项目/分类 | WeKnora 实际逻辑 | PACE 实际逻辑与判断 |
| --- | --- | --- |
| 上传入口/格式矩阵 C | `W/internal/utils/import_filetypes.go:15` 明列允许扩展名；`W/docreader/parser/registry.py:159` 将部分格式实际绑定解析器。允许上传不等于每种格式、每个部署均能解析。 | `packages/api/src/features/knowledge/routes.ts:78` 接受 filename/MIME/base64，`:636` 实际上传；`packages/worker/src/knowledge/parsing.ts:52` 本地识别文本，其余一律交 Docling（`:734`）。没有与服务能力绑定的逐格式矩阵，不能据“能上传”宣布格式已支持。 |
| MD/TXT/HTML/CSV/JSON B | 官方入口含 md/markdown、txt、html/htm/mhtml、csv/json（`W/internal/utils/import_filetypes.go:16`）；内置/MarkItDown 注册见 `W/docreader/parser/registry.py:159`、`:181`。 | MD/markdown、TXT/text/log、HTML/htm/xhtml、CSV、JSON/+json 走本地实现，见 `packages/worker/src/knowledge/parsing.ts:52`、`:751`；CSV/HTML 表格转换见 `:246`、`:291`。已有真实转换分支，不列缺失；解析正确率未测。 |
| PDF/Office C | PDF、DOC/DOCX、XLS/XLSX、PPT/PPTX 有明确注册（`W/docreader/parser/registry.py:162`），另有解析引擎可用性描述（`:135`）。 | 上述格式经通用 Docling 请求（`packages/worker/src/knowledge/parsing.ts:623`），未配置明确失败（`:735`）。这些是“外部服务接入能力”；本轮未启动 Docling，不能保证扫描 PDF、老 Office、复杂表格效果。 |
| 长尾原件 C | 入口还列 EPUB、DOCM/ODT/RTF、MHTML、XMind、XLSM/ODS、PPTM/ODP，及 MP3/WAV/M4A/FLAC/OGG（`W/internal/utils/import_filetypes.go:16`）；EPUB/XMind/MHTML 有注册（`W/docreader/parser/registry.py:171`），音频交 ASR 前标记见 `W/internal/infrastructure/docparser/builtin_converter.go:113`。 | `packages/worker/src/knowledge/parsing.ts:85` 对这些均无专用区分；`:741` 仍发 Docling。不能宣称 PACE 一律支持，也不能仅凭没有格式名断言一律不支持；应按实际 Docling 版本逐格式验证。未发现相应音频转写接线于该解析链。 |
| OCR/图片 C、A | 官方注册 jpg/jpeg/png/gif/bmp/tiff/webp 的 ImageParser（`W/docreader/parser/registry.py:155`），知识入库另有多模态图片处理选项（`W/internal/application/service/knowledge_process.go:4166`）。 | Docling 请求确实开启 OCR/表格（`packages/worker/src/knowledge/parsing.ts:628`）；图片仅提取带页码的内嵌 data URI（`:567`），入库保存文件元数据（`ingestion.ts:433`）。适配器仅生成 table/text（`parsing-adapter.ts:146`），embedding 输入仅 chunk 正文（`ingestion.ts:418`）；图片查看≠图片向量/视觉检索，当前摄取链没有后者。未验图片实际返回策略及 OCR 准确率。 |
| parent-child/邻块 A | 可生成父子块、父块不入向量索引、子块链接父块（`W/internal/application/service/knowledge_process.go:575`、`:610`、`:638`）；命中后补父块和前后块（`W/internal/application/service/knowledgebase_search_results.go:147`）。 | `packages/worker/src/knowledge/ingestion.ts:443` 仅平铺 chunks；`packages/shared/src/knowledge.ts:90` 无父子关系；API `retrieval.ts:116`、`:224` 直接输出命中块，没有父/邻块扩充。MCP `mcp.ts:103` 可另读整篇，但不等于自动上下文扩充。 |
| context chunks A | 官方把标题面包屑与原文分开，embedding 时加回（`W/internal/infrastructure/chunker/splitter.go:23`、`:45`），索引再加文档标题（`W/internal/application/service/knowledge_index_content.go:12`；调用 `knowledge_process.go:730`）。这是可见的确定性上下文，不据此推称另有 LLM 逐块上下文生成。 | PACE heading 单独存储（`ingestion.ts:451`），embedding 与关键词正文均不带它（`:418`、`:453`）；重排只传 `row.content`（`packages/api/src/features/knowledge/retrieval.ts:209`）。标题下的“本产品/本季度”等短块可能丢主题，UI 显示 heading 不补模型输入。 |
| token预算/1024 B、C | 正在调用的 Go chunker 有语言近似 token 估计与可选 TokenLimit（`W/internal/infrastructure/chunker/tokens.go:31`；`strategy.go:318`），不是精确 tokenizer；默认字符预算见 `splitter.go:72`。不能拿旧 Python splitter 的 token 注释证明当前调用。 | `packages/shared/src/knowledge.ts:25` 为 200–4000；`parsing-adapter.ts:105` 实际按 JS 字符数；`ingestion.ts:457` 又按长度/2记 tokenCount。**1024 是 embedding 维度**（`core/src/knowledge-models.ts:8`、`db/src/schema.ts:21`），不是固定输入 token 预算；请求也未发送 dimensions（`knowledge-models.ts:139`），返回必须恰好1024（`:156`）。模型窗口与多语 token 适配未验。 |
| 表格/代码 B、C | 官方 splitter 提供源文本位置约束及 TokenLimit（`W/internal/infrastructure/chunker/splitter.go:16`、`:61`）；结构定位可映射 sheet/row（`W/internal/types/source_locator.go:53`）。 | `packages/worker/src/knowledge/parsing-adapter.ts:48` 表格按行拆且重复表头，`:73` 代码保 fence；已有支持。单超长行可越过预算（`:46`、`:89`），`parsing.ts:840` 原子块也允许超长；这是真实代码边界，是否触发模型拒绝属 C，不凭长度估算宣布已溢窗。 |

## 查询、融合、重排与无答案

| 项目/分类 | WeKnora 实际逻辑 | PACE 实际逻辑与判断 |
| --- | --- | --- |
| 查询改写 B、D | 问答 pipeline 按 EnableRewrite 选择改写（`W/internal/application/service/chat_pipeline/query_understand.go:64`），另有本地关键词变体扩展（`query_expansion.go:123`）；这属于问答链，不能套称每次裸检索都执行。 | REST `packages/api/src/features/knowledge/routes.ts:944`、MCP `mcp.ts:94` 共用 `retrieval.ts:148`，仅分词后原查询召回，无历史指代改写。PACE 的 Agent 可主动多次搜索，工具接受自拟 q（`mcp.ts:74`），但不保证发生。无需复制另一套问答循环；有连续追问失败样本再由现有 Agent/工具约定补齐。 |
| 多路融合 B | 官方单向量路径保留相似度、混合路径用权重 RRF 并归一化（`W/internal/application/service/knowledgebase_search_fusion.go:47`、`:170`）。 | 已有关键词+向量、RRF（`packages/api/src/features/knowledge/retrieval.ts:76`、`:97`、`:132`），每路50、融合30、k=60（`:18`），等权且未归一化；即使仅一路仍算 RRF。不是“缺混合检索”。请求 limit=50 最多得30（`:224`），固定池策略限制更深召回。 |
| 阈值/无答案 A、D | 向量/关键词阈值传入召回（`W/internal/application/service/knowledgebase_search.go:485`、`:514`）；重排阈值传给统一 reranker（`knowledgebase_search_rerank.go:109`、`:185`）；问答无结果走 fallback（`session_knowledge_qa.go:779`）。 | `packages/shared/src/knowledge.ts:106` 仅 q/folders/tags/limit/rerank；`retrieval.ts:105` 对所有非空向量按距离取前50，`:224` 无最低相关性过滤。因此向量可用且有候选时，库外问题仍可能返回无关命中；不是说它必然生成错误答案。Web 有空结果状态（`knowledge-detail.tsx:1842`），MCP 仅返回 hits（`mcp.ts:98`）。相关性门槛缺口属 A；照搬官方独立 fallback 生成链不符合 PACE 单 SDK 底座，属 D。 |
| 重排/分数/诊断 A、B | 官方响应含模型来源、阈值、候选数、降级 outcome（`W/internal/application/service/knowledgebase_search_rerank.go:113`、`:173`）。 | PACE 已调用兼容 /rerank（`packages/core/src/knowledge-models.ts:167`），失败保留融合序（`retrieval.ts:195`）。但 score 可能是未归一 RRF 或模型原分，Web 一律三位小数（`knowledge-detail.tsx:1860`）；未报告重排实际执行/失败，degraded 仅标向量（`retrieval.ts:38`），MCP 还丢掉该标志（`mcp.ts:98`）。不能把显示分数当概率/统一置信度。 |
| 跨语言 C、B | 官方改写和关键词扩展有具体接线（`W/internal/application/service/chat_pipeline/query_understand.go:64`；`query_expansion.go:188` 有中英停用词）；上述本地扩展不是翻译，不能由此证明跨语召回达标。 | `packages/core/src/knowledge-models.ts:199` 用 zh word segmenter；查询向量用分词后的拼接文本（`retrieval.ts:180`），重排用原 q（`:208`）。无跨语言翻译参数于 shared query（`knowledge.ts:106`）。跨语主要取决于所选 embedding/rerank 和 Agent 自拟查询；两侧均未用中问英答语料实测，不能判“支持=效果达标”或全盘不支持。 |
| 用户可见检索测试 A、B | 官方用户设置可调三类阈值（`W/frontend/src/views/settings/RetrievalSettings.vue:34`、`:125`）；FAQ 测试实际发 vector_threshold/match_count（`views/knowledge/components/FAQEntryManager.vue:2560`）。两者入口不同，不推称普通文档测试面板也有全部旋钮。 | `packages/web/src/pages/knowledge-detail.tsx:1802` 仅问题输入；hook `lib/queries.ts:1160` 默认10，API client `lib/api.ts:986` 仅发 q/limit。虽后端支持 folders/tags/rerank，这个测试界面不能调；也不能对照召回路、阈值、重排状态，因此“有检索测试”尚不足以诊断质量。 |

## 引用定位与人工修改

| 项目/分类 | WeKnora 实际逻辑 | PACE 实际逻辑与判断 |
| --- | --- | --- |
| 源位置 A | 源类型含 PDF bbox、Word block、slide、sheet rows、text offsets、audio time、EPUB section（`W/internal/types/source_locator.go:12`）；不仅类型：结构对齐见 `knowledge_source_locators.go:21`，分块时按范围取 locators（`knowledge_process.go:4190`），搜索结果携带定位（`knowledgebase_search_results.go:368`）。解析对齐失败可以没有定位，不能保证每个原件都精确回跳。 | Docling 层曾有 bbox/ref（`packages/worker/src/knowledge/parsing.ts:426`），但 `parsing-adapter.ts:33` 丢 blocks，重新由 Markdown/pageMap 构块（`:119`），最终只留 pageFrom/pageTo（`:146`）；`shared/src/knowledge.ts:116` 与 `api/retrieval.ts:116` 亦只传页码。Web `knowledge-detail.tsx:1492` 是整篇 Markdown+独立摘录，不是原 PDF/单元格内定位。 |
| chunk编辑与历史 A | 正文编辑保存 ChunkRevision、原文 SourceContent、递增 ContentRevision（`W/internal/application/service/chunk.go:559`），再触发索引相关处理；不能把修订记录等同本轮已验证历史 UI/恢复体验。 | UI `knowledge-detail.tsx:1424` → API `routes.ts:850` → repo `knowledge.ts:652` 原位 update；清空向量并排队补建是已有能力（`routes.ts:857`、`:870`）。这个链不新建修订、无 expected revision；可读文档历史版本（`:793`）不等于同一版本内 chunk 编辑历史，旧正文会被覆盖。 |
| 人工正文后的源引用 A | WeKnora 正文改变会清 SourceLocators（`W/internal/application/service/chunk.go:570`），子块编辑亦清父块定位（`:754`），避免继续声称人工文本属于原件。 | PACE patch 设置 editedByUser，但不清页码、不换 versionId（`packages/api/src/features/knowledge/routes.ts:854`；`db/src/repo/knowledge.ts:643`）；命中摘录来自新 chunk（`retrieval.ts:123`），查看正文却按旧 versionId 读取（`web/src/components/knowledge-citations.tsx:113`），还显示原页码（`:127`）。触发条件：编辑某句后检索该新句；摘录与所称原文可能不一致，且搜索 hit 不传 editedByUser（`shared/src/knowledge.ts:116`）。 |
| 人工改引用的边界 B、D | 官方上述“清定位”是内容改变后的证据失效处理，并非允许人工任意伪造原件坐标（`W/internal/application/service/chunk.go:570`）；已核路径不能证明官方有任意改源引用功能。 | PACE chunk patch 不开放 pageFrom/pageTo（`routes.ts:110`），但新增块可填页码（`:101`）；Wiki 人工改正文沿用既有 sourceChunkIds（`wiki-routes.ts:24`、`:147`），未开放人工替换该集合。应区分“编辑知识”与“修改证据归属”；无需照搬自由填原件坐标。若正文被改到新主张，现有 chunk 身份/旧引用集合本身不证明语义仍获来源支持。 |

## 优先级（最多六项，均为最小改进方向）

1. **P1，人工内容与来源身份（A）**：改 chunk 后再次检索/引用，可能把原件没有的句子标为原页内容。先贯通人工标记与来源失效表达，再补最小修订留存；不要把文档历史当编辑历史。依据：上表人工正文、chunk历史两行。
2. **P1，相关性与无答案（A）**：库外问题在有向量候选时被无关块填满，Agent 容易把噪声当证据。先用包含无答案问题的小语料集校准召回/重排门槛，并返回有效检索状态；由现有 Agent 处理空证据。依据：阈值/无答案、诊断两行。
3. **P1，检索测试可解释性（A/B）**：用户调模型后无法知道是否真的重排、是否只剩关键词。先显示实际检索路、分数来源与重排 outcome，并开放后端已有参数；同步 REST/MCP 状态。依据：重排诊断、用户测试两行。
4. **P2，主题上下文与长文召回（A/B）**：短子句脱离章节、答案跨相邻块时漏关键信息。先把已有标题/heading 加入索引和重排上下文；有失败样本再引入最小邻块扩充/父子块，不一次移植整套策略。依据：context、parent-child、固定融合池三行。
5. **P2，原件证据定位（A）**：合同页内、表格单元格核对只能下载/翻全文。先保留解析器已有结构定位穿过 adapter→storage→hit→viewer；原件没有可靠对齐时明确未知。依据：源位置行。
6. **P2，格式与预算验证（B/C）**：扫描件、长表格、老 Office、跨语模型替换后可能任务失败或质量下降。先声明并实测当前 Docling/模型矩阵，统一 chunk 参数真实单位，验证1024维输出与模型窗口；不为矩阵空白直接新增另一套解析底座。依据：格式、OCR、预算、跨语各行。

## 后续定点复核补充

独立[定点复核](knowledge-parity-verification.md:9)确认人工引用身份问题，并补充：远端正文变化与默认完整 rebuild 可替换当前人工块，没有同等冲突确认；旧文档版本通常仍留存，不能称所有历史被物理删除。专用 reprocess 已有人工确认，但只查前200块，后页人工块可能漏检；chunksOnly=true 只补向量，不重新解析。不能将这些路径笼统写成“所有重处理无提示”。Wiki 支持指定页/新标题单页生成，“只能 overview”不是本报告结论。

## 验证与结论边界

- 本轮只读两侧源码、沿 PACE UI→query/client→REST/MCP→retrieval 和 worker adapter→parse/chunk→embed→DB、编辑 API→repo→引用 viewer 追踪；没有执行下载参考中的程序或读取其指令文件。
- 仅本地纯算术检查：`min(50,30)==30`、RRF 单路首名 `1/61=0.016393`、双路首名 `2/61=0.032787`，断言退出0。它们解释固定上限/分数，不是模型或数据库行为测试。
- 报告校验实际通过：Python 只读断言确认62行（≤120）、无尾随空白、有末尾换行；未运行产品测试。两次 git/格式检查命令被工作树自动审查拒绝，改用上述只读校验，未改权限。工具调用超过约20次预算；原有脏差异不属于本报告产出。
- 结论是：PACE 已形成可调用的解析/索引/混合检索/来源查看链路，但“完整闭环”若含格式逐项保证、图片语义检索、可靠无答案、上下文恢复、精确原件定位、人工修订证据一致性，则声明过强。
- 未跑真实模型、Docling、浏览器、共享 DB 或全套测试；未测召回率、跨语质量、OCR/表格准确率，也未验证 WeKnora 全部定位/历史 UI。双方“存在实现”均不等于“效果达标”。
