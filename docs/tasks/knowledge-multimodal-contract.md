# PACE 知识库多模态实施契约

> 2026-10-25；基线 HEAD `797edfeaabd39b040d01736c49273da18347ea92` + 当前未提交实现。本文件是实施契约，尚未实现或实测；不提交。
> 当前有效范围：独立图片 / Docling 插图 → VLM OCR、caption → 文本检索与图片引用 → 专家按需读取描述或原图；另须实现显式 opt-in 同空间 image vector。只调整 PACE 现有链，不扩 GitHub、Wiki 重构、音视频或以图搜图。

## 1. 依据与已有接点

- 已读 `CLAUDE.md`、`docs/PITFALLS.md`；决定按 `weknora-core-proposal.md` 最新 §1 与 `weknora-multimodal-reference.md`。后者固定 WeKnora SHA `e1f9a6166a593a4804a2f99f1d942919c9cc8ea7`。
- 上游两入口汇入同一图片后处理；OCR/caption 独立，至少一个产出可用；默认文字索引；图片向量显式启用且模型支持同空间文本查询；向量失败可降级。参考报告 §1–4 的源码定位为依据。
- 已有 `parsing.ts`/`parsing-adapter.ts`、`ingestion.ts`、`queue.ts`：Docling 抽图、版本图片清单与磁盘 `docs/<document>/<version>/images/<name>`、最后 `setCurrentVersion`；复用，不建图片服务或第二队列。
- 已有 `knowledge-models.ts` 的端点请求/错误分类、`schema.ts` 的 `metadata`、`repo/knowledge.ts`、API `retrieval.ts`/`mcp.ts`/`image-routes.ts`/`package.ts`、Web settings/citations；都须贯通，不能只做上传或展示。
- SDK 官方核对：<https://code.claude.com/docs/en/headless>、<https://code.claude.com/docs/en/agent-sdk/typescript.md>。`query` 接受流式用户输入，`outputFormat` 提供 JSON Schema 输出，`abortController` 取消，`persistSession:false` 不持久化；`tools` 控制内置工具。
- 本地 `packages/worker/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（0.3.310）相关行：`query` 3322、`SDKUserMessage` 6533（MessageParam 支持 image）、`outputFormat` 2013、`structured_output` 6078、`settingSources` 2316。只采用这些已核接口，不推断 `bare` SDK 选项。
- 生成先复用 `wiki.ts` 的官方 query 隔离/清理方式与现有 `ANTHROPIC_*`；地址走 `upstream.ts:modelProxyUpstream`，遵守宿主/容器区别。不给 Wiki 增功能、不另建 OpenAI VLM harness。
- 真 image embedding 协议选已核官方 Cohere v2 Embed：<https://docs.cohere.com/v2/reference/embed>，`embed-v4.0`，文字 `texts`、图片 `images:[data URI]`、`embedding_types:['float']`、`embeddings.float`；查询 `search_query`、文档 `search_document`。这是 embedding 适配，非另一生成循环；不加依赖或部署服务。

## 2. 固定共享数据与导出

以下名称为跨域契约；新增共享 schema/类型从 shared `index.ts` 导出，core 函数从 core `index.ts` 导出。

```ts
// shared/src/knowledge.ts；嵌入既有 settings，不创建私有 Agent 文件格式。
type KnowledgeImageProcessing = {
  enabled: boolean; model: string | null; ocrEnabled: boolean; captionEnabled: boolean;
  descriptionLanguage: string; customInstructions: string;
  imageVectorEnabled: boolean; imageVectorMinScore: number;
};
// 默认 false/null/true/true/'zh-CN'/''/false/0.3；score 范围 [-1,1]。
// KnowledgeBaseSettings.imageProcessing；导出 knowledgeImageProcessingSchema。
type KnowledgeImageRef = { name: string; mimeType: string; page: number | null };
// 导出 knowledgeImageRefSchema；name 必须是版本图片清单里的单段文件名。
type KnowledgeImageChunkMetadata = {
  image: KnowledgeImageRef; imageRole: 'ocr' | 'caption' | 'vector';
};
// 导出 knowledgeImageChunkMetadataSchema；存 chunks.metadata，不复制原图/base64/磁盘路径。
// KnowledgeChunk 增 metadata；KnowledgeSearchHit 增 image: KnowledgeImageRef | null。
// 普通命中明确 image:null；图片定位仍用 hit.documentId/versionId + image.name。
type KnowledgeReadImageInput = { chunkId: string; format: 'description' | 'image' };
type KnowledgeReadImageResult = { hit: KnowledgeSearchHit; description: string };
// 导出 knowledgeReadImageInputSchema / knowledgeReadImageResultSchema；format 默认 description。
```

- `enabled:true` 要求 model 非空且 OCR/caption 至少一个开启；语言/指令限长。model 是现有 Anthropic 网关接受的模型 ID，非新增 VLM profile/凭证表；视觉能力要以真实探针验收，不能仅凭名称。
- `kind` 继续 `text|table|image`，不扩数据库枚举。OCR/caption 分别独立 `kind:image` chunk，content 是真实文字，metadata 标角色；vector chunk `kind:image`，content 为该图可用描述，searchText 为空，只存真实图 embedding。
- 每图至少一个非空 OCR/caption 后才可创建 vector chunk；vector 不替代描述。普通 text/table 的 metadata、编辑与索引行为保留。
- `versions.images` 原清单项增加 `warnings:string[]`（默认空），记录单动作失败/向量降级；原字段 name/sha256/mimeType/page 保留。不将失败占位或错误字符串当正文索引。
- `knowledge_model_profiles` 增 `embeddingProtocol:'openai'|'cohere_v2'`（默认 openai）、`imageInputEnabled:boolean`（默认 false）；两字段随 profile API/包序列化，rerank 不能开 imageInputEnabled。
- `EmbeddingProfile` 增上述字段；维度仍严格 1024，`vector(1024)` 不改。Cohere 固定发送 `output_dimension:1024`；普通 OpenAI `/embeddings` 不被当作有图片能力。
- imageInputEnabled 仅允许 `embeddingProtocol:cohere_v2` + `model:embed-v4.0`；imageVectorEnabled 要求当前 embedding profile 同时满足此条件且 enabled。OCR/caption 使用该 profile 的同一模型/端点/维度生成文本向量。
- 同维度不等于同空间；不允许独立 image profile、拼接/截断向量或从 caption 冒充 image embedding。不支持的模型/维度必须 409 `CONFLICT`，说明所需 profile；不是删除图片向量分支。

## 3. 固定函数与任务契约

```ts
// core/src/knowledge-models.ts；延伸现有错误分类/超时/入口响应校验。
embedTexts(profile: EmbeddingProfile, texts: string[], signal?: AbortSignal,
  inputType?: 'search_document' | 'search_query'): Promise<number[][]>;
// inputType 默认 search_document；OpenAI 保持既有请求，Cohere 分支用该字段。
embedImages(profile: EmbeddingProfile,
  images: { mimeType: string; dataBase64: string }[], signal?: AbortSignal): Promise<number[][]>;
// cohere_v2: endpointUrl 为 API 根（含 /v2），POST `${endpointUrl}/embed`。
// 校验数目、有限数字、恰好1024维；复用 KnowledgeModelError。
// worker/src/knowledge/image-processing.ts；该文件及生成测试由 processing 独占。
describeKnowledgeImage(input: {
  image: { mimeType: string; data: Uint8Array }; settings: KnowledgeImageProcessing;
  signal: AbortSignal;
}, deps?: { queryFn?: typeof query }): Promise<{
  ocr: string | null; caption: string | null; warnings: string[];
}>;
// API 新 knowledge/read-image.ts；供 MCP 与图片授权读取共用，不改聊天循环。
readKnowledgeImage(input: KnowledgeServerInput,
  args: KnowledgeReadImageInput): Promise<{
  result: KnowledgeReadImageResult; image?: { mimeType: string; data: string };
}>;
```

- OCR/caption 按已启用动作分别 query，互不因另一动作失败而丢弃有效内容；每次原生 `SDKUserMessage.message.content` 为 text+base64 image。输出 schema `{text:string}`，从成功 result.structured_output 校验取值；空白不是成功产物。
- query 使用该库 model、`tools:[]`、`mcpServers:{}`、`strictMcpConfig:true`、`settingSources:[]`、`settings:{autoMemoryEnabled:false}`、`permissionMode:'dontAsk'`、`persistSession:false`、maxTurns 2、maxBudgetUsd 0.5；临时 cwd/env 依现有 Wiki 模式，finally await generator.return() 后删目录；signal 连接 abortController。
- 任务不新增类型：`ingest{documentId}`、`reindex{baseId,documentIds?,chunksOnly}` 原参数保留。一次任务开始读取库设置；发布前重核该库未停用、配置未变化，变化则不发布并明确要求重试，不用旧配置覆盖新决定。
- QueueDeps/KnowledgeDeps 增 `imageQueryFn?:typeof query` 注入点，worker 真实运行默认 query；不把图生成包装成 agent_runs，也不复制 Wiki 工具或建立 agent loop。
- 处理阶段加 `image_processing`；图片先产生描述，再与普通 drafts 合并做文本 embedding，可选 embedImages 最后追加 vector drafts；所有 chunk metadata 贯通 insertChunks。

## 4. 摄取、发布、停用与重建

- 独立图片入口复用上传 API；按 MIME/真实解码一致性校验。直接包成 ParsedDocument.images 与安全相对 Markdown 图片引用，进入与 Docling 图相同后处理；无需先送 Docling。JPEG/PNG/GIF/WebP 为 SDK 原生图输入范围，超限明确失败。
- BMP/TIFF 等若现有 Docling 能转 PNG 则复用其输出；不得将原字节伪标 PNG。未证明可转换的格式报明确不支持，不引新图处理服务。
- enabled=false：新独立图入库失败并给出启用指引；普通文档照旧解析/索引/供图，跳过图片语义处理；Docling 自带文档 OCR 不被关闭。开关不删除原件或历史图片。
- enabled=true：每张候选图至少一个已启用动作有非空输出；两者都空/失败则该版本不发布。OCR/caption 一个成功可发布并记录 warning；可选 vector 失败只降级描述检索并记录 warning，符合参考链。
- 图片/描述/向量全部准备好才写入待发布版本，最后现有事务原子切 currentVersionId；失败/取消不切换，新文档不可检索，旧就绪版本继续可查，未发布版本不进入读图或检索。
- 所有模型/文件阶段传 signal；写 chunk 前及切版本前检查取消，切版本事务检查持久化任务未取消、库仍 active。取消已确认后不得再发布；复用现有取消键/队列终态，不加另一状态机。
- 库停用、文档停用/删除、chunk.enabled=false 在检索与 MCP 读图即时生效。imageProcessing.enabled=false 隐藏图片语义 chunk/读图工具，普通正文不受影响；历史 Web 引用依既有权限仍可看存量原图。
- OCR/caption 编辑复用 chunk 编辑并重算文字 embedding，metadata 不许通过自由输入改图片定位；vector chunk 只允许启停，不允许手改 content/embedding。不得将同图其他禁用 chunk 偷带到描述结果。
- reindex chunksOnly：按 imageRole 分派，OCR/caption 用 embedTexts、vector 从白名单原图读字节用 embedImages；普通正文照旧。完整重建重新生成图片描述，沿既有人工作品冲突确认，不静默覆盖人工编辑。
- embedding profile 的模型/协议/维度/图片能力被引用后不可原地更改；新建 profile 后换库并完整重建。相同1024维的新模型也要重建；不是 chunksOnly 补缺向量。
- 切库 profile 后关键词仍可查；vector 查询只选当前库 profileId 匹配的版本，避免混空间。重建逐文档原子发布，未重建文档关键词保留，向量暂缺；非1024维明确拒绝而不破坏现有列。

## 5. API、MCP、引用与知识包

- 现有 `/api/knowledge/bases` 建改/列表与 `/api/knowledge/model-profiles` 建改/列表/测试携带新字段；复用共享 settings schema，杜绝 Zod strip 后 worker 看不到开关。
- `/model-profiles/:profileId/test` 对图片能力 profile 真发固定 tiny PNG 和文本查询请求并校验两者1024维，不能只测文本后报“图片可用”；同空间由协议/model约束保证，探针不声称证明召回质量。
- `searchKnowledge` 的文字查询显式 inputType=search_query；关键词排除 imageRole=vector，普通向量分支排除 vector，再为 opt-in 同空间库单独查 vector role 并应用 imageVectorMinScore 后融合。
- vector 查询先限定版本 profileId、可见状态与1024维再算距离；同图多个子块可保留独立 chunkId，不将 vector 分数冒充 OCR 分数。rerank 输入可用描述文本，返回仍保留原图片命中身份。
- image 从 metadata 投影到 hit，quote 始终可读文字；不返回本机路径/任意远程图片 URL。已有搜索响应/JSON text wire、引用保存方式保持，新增字段跨历史 trace 原样保存。
- `KNOWLEDGE_TOOL_NAMES` 追加 `knowledge_read_image`；参数上述 schema，默认 description。description 只返回 JSON text `{hit,description}`；image 返回同一 JSON text 加 MCP `{type:'image',data:<base64>,mimeType}`，遵从 CallToolResult；不在聊天层拼 user message。
- 读图先按绑定 base/run 权限校验 chunk→document→version→versions.images，要求当前可见、chunk enabled、图片处理已开；不接受任意 name/path/URL。format=image 限 SDK 原生 MIME 与5MiB，超限返回明确工具错误并提示 description，不静默只给描述。
- 非视觉专家使用 description；视觉专家按工具说明显式选择 image。搜索已提供描述所以不会强迫所有专家接收图；真实 SDK+网关测试须证明 image content 到达视觉模型，不能用 UI 缩略图替代。
- 复用现有 `GET /api/knowledge/versions/:versionId/images/:name` 与 `api.knowledgeImageUrl`，Web 不加另一供图路由。引用弹窗按 hit.image 显示原图/alt=quote、页码和正文；401/403/404 继续明确呈现。
- ZIP 沿现有 `pace/knowledge@1` 版本图片/metadata 扩展，不导出 embedding 或密钥。**vector chunk 身份/角色/启停/描述保留，仅省略向量数值**，以便 chunksOnly 从原图恢复；不能删除整个子块。导入重映射文档/版本/chunk ID，image.name 仍按所属版本清单绑定；拒绝缺图/伪造引用/越界路径，保持 sha256 校验。
- 包携带图片处理设置和 embedding 协议/能力；导入必须显式选本机可用 profile/model，缺视觉模型或图片 profile 不得伪装 ready。仅缺索引的导入通过 reindex chunksOnly 重建 OCR/caption 与 image vector，已有描述不重新生成。

## 6. 四域所有权、真实依赖与验收

| 域 | 独占文件与产出 | 依赖 / 可并行工作 |
|---|---|---|
| foundation | shared knowledge/index、db schema/repo knowledge/迁移、core knowledge-models/index 及各自 tests；字段、insertChunks metadata、embedImages/扩展 embedTexts | 先落共享类型；纯 Cohere 请求/响应适配与 tiny fixture server 测试可先并行于 processing 生成 helper，不能同时编辑 core 文件 |
| processing | worker knowledge parsing/parsing-adapter/ingestion/queue、新 image-processing、worker index 必要注入及其 tests | query helper/图片 fixture 可按本契约先做；整链接入等待 foundation 导出与 repo；wiki/upstream 只读复用，不重构 |
| API | knowledge routes/retrieval/mcp/image-routes/package/package-routes、新 read-image、shared MCP 工具说明必要调用方及 API tests | 等 foundation；先写接口/ZIP失败测试；与 processing 并行，最终需 processing 产物验证 |
| Web | knowledge-settings/citations、web lib api/queries、knowledge-detail 必要入口及 Web tests | foundation 后按固定 wire 与 API 并行；复用现有组件/设计 token，不改 app-shell/chat 执行层 |

- 不新增必填环境变量：model/语言/动作进库设置；现有 ANTHROPIC_* 及 KNOWLEDGE_DIR 足够。若执行发现必要 config 变动，归 foundation 单写，processing 只接已定字段，禁止双方改 config/index。
- 每域仅改自有文件及测试；需要别域改文件提交契约反馈，由文件主人处理。API routes.ts 中 profile 与库 settings 同属 API，foundation 不抢写。
- RED→GREEN 场景① tiny PNG 独立上传及 Docling 双图：OCR/caption 内容进入 FTS/文字向量，命中 image.name/page 正确，MCP description/image 两模式及 Web 原图同一 sha256。
- 场景② OCR失败/caption成功、双空、vector 429/坏维度、取消于生成/入库/切换前：分别有警告可检索、不可发布、描述降级、无取消后新版本；替换失败旧文本仍可查。
- 场景③ text-only profile opt-in 被拒、Cohere 真图片请求/文字查询同 model+1024、阈值过滤；同维新模型重建不混空间，非1024拒绝；停库/停文档/停chunk与越库读图都失败。
- 场景④ ZIP 导出→导入→chunksOnly 重建，ID 全新但图片对应不变；缺图/错误哈希/伪定位失败；原有 TXT/MD/表格、关键词降级、编辑、原图下载、历史引用测试全部保留。
- fixture server 在 Vitest 用 node:http 临时端口，核对 `/embed` 请求 texts/images/input_type/output_dimension，回确定1024向量，并提供401/429/超时/坏维度；不启真实 worker，不访问生产模型。SDK queryFn 单测核原生图片块和 abort/return 清理。
- 命令按域运行：`pnpm exec vitest run packages/core/test/knowledge-models.test.ts packages/worker/test/knowledge-ingestion.test.ts packages/worker/test/knowledge-parsing.test.ts packages/worker/test/knowledge-image-processing.test.ts`；API/Web 同样运行新增 read-image 测试与现有 knowledge-retrieval/mcp/package/image-routes、knowledge-settings/citations 测试；先 RED 再 GREEN 记录实际计数。
- foundation schema 落地需 `pnpm db:generate`、`pnpm db:migrate`；集成后各受影响 package typecheck。真实验收另跑一次绑定专家 SDK search→read_image→带来源回答及历史回放，记录模型/网关/响应，不能把 stub 当真实视觉验证。

## 7. 已知不适配与交付状态

- 当前普通 OpenAI embedding profile 无原生图片输入协议；需新增上述 Cohere v2 适配并配置真 embed-v4.0 端点/凭证。没有兼容端点时默认文字索引仍完整可用，图片向量标为缺依赖，不能删实现或默认开启。
- 本地网关是否支持所选视觉模型、真实 MCP image 内容转交、BMP/TIFF 转换质量及真实召回尚未实测；这些是实施验收依赖，不据文档宣称已支持。
- 本轮仅写本契约；未改产品、未运行产品测试/迁移、未提交或合入；没有检查范围外 GitHub/Wiki/前审修复。
