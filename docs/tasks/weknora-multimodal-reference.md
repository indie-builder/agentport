# WeKnora 多模态：官方已有调用链与 PACE 接点

> 只记录上游（WeKnora）真实实现与 PACE 现状，不设计新架构、不排期。
> 上游固定 SHA：`e1f9a6166a593a4804a2f99f1d942919c9cc8ea7`（Tencent/WeKnora，路径下称 `W/`，URL 前缀 `https://github.com/Tencent/WeKnora/blob/e1f9a6166a593a4804a2f99f1d942919c9cc8ea7/`）。
> PACE 基线 HEAD：`797edfeaabd39b040d01736c49273da18347ea92`，本报告实际检查包含当前未提交知识库代码，不能用该 SHA 重现这些新增实现；路径相对当前 worktree 根。
> 未运行上游、未调真实模型；以下均来自源码阅读，"是否有效果"不做承诺。

## 1. 图片从哪来：独立上传 + 文档内提取，两条都走同一条后处理

- 独立图片：docreader 注册 `jpg/jpeg/png/gif/bmp/tiff/webp → ImageParser`（`W/docreader/parser/registry.py:155`）；`ImageParser` 把图片原样包成一条 Markdown 引用，并把原始字节放进 `Document.images` 交由 Go 侧落盘（`W/docreader/parser/image_parser.py:19`）。
- 文档内图片：Go 先解析出 Markdown，再解析内联/远程图片并存储，汇总为 `storedImages`（`W/internal/application/service/knowledge_process.go:4134`），随后 `imagesForMultimodal` 过滤掉 `SkipMultimodal` 的图（同文件 `:218`、使用点 `:4166`）。
- 开关：独立图片入库必须 `EnableMultimodel`，否则文档直接置 failed（`W/internal/application/service/knowledge_process.go:3856`）；每张图按异步任务处理，入队条件 `EnableMultimodel && len(StoredImages) > 0`（同文件 `:895`）。

## 2. 图片后处理的 OCR / 视觉描述：这里走已配置 VLM

本节限定到图片异步后处理；不据此推断所有文档解析器都没有本地 OCR。PACE 现有 Docling OCR 与这条上游 VLM 处理链也应分开。

- 两条路都是"图片 → 已配置的 VLM（接受图片的 chat 模型）"：`ImageMultimodalService.processImage`（`W/internal/application/service/image_multimodal.go:273`），OCR 提示词 `vlmOCRPrompt`/扫描件专用提示词（同文件 `:32`、`:43`），caption 提示词 `buildVLMCaptionPrompt`（`:57`）。调用经 `image_action_registry.go:526`（OCR）与 `:607`（caption）。
- 配置：知识库级 `VLMConfig{Enabled, ModelID, DescriptionLanguage, CustomInstructions}`（`W/internal/types/knowledgebase.go:709`），`IsMultimodalEnabled()` 只看 `VLMConfig.IsEnabled()`（同文件 `:1017`）。
- 开关：每库两个独立动作 `caption_enabled` / `ocr_enabled`，默认都开，规则要求至少留一个（`W/internal/application/service/image_pipeline_default.go:37`、`:60`、`:107`）。
- 失败语义：OCR chunk 与 caption chunk 各自独立生成（`image_multimodal.go:409`、`:432`）；已产出内容时失败只记 span 不失败任务，两者都空才判该图失败；永久错误用 `asynq.SkipRetry` 归档、瞬时错误重试（`image_multimodal.go:450`、`:644`）。图片向量失败只丢召回、不让任务失败（同文件 `:812`）。

## 3. 索引：默认文字索引；原生图像 embedding 存在但需显式开启

- OCR 文本与 caption 都是普通文本 chunk（`image_ocr` / `image_caption`，`W/internal/types/chunk.go:21`、`:23`），进入常规向量化（`W/internal/application/service/knowledge_post_process.go:179`）。
- 原生图像 embedding：`ImageEmbedder.BatchEmbedImages`，注释明确"图像向量与文本向量同空间，文本查询可找到图片"（`W/internal/models/embedding/embedder.go:37`、`:49`）。写入为 `image_vector` chunk（`image_multimodal.go:820`、`:884`；类型 `types/chunk.go:24`）。
- 开启条件：知识库 `ImageProcessingConfig.ImageVectorEnabled` 且向量开启（`W/internal/types/knowledgebase.go:578`、`:1025`）；任务可显式覆盖（`image_multimodal.go:827`）。检索侧只对"已 opt-in 且 embedding 模型确实收图"的库召回，并给图像向量单独阈值（`W/internal/application/service/knowledgebase_search_image.go:31`、`:48`）。
- 以图搜图：核到的召回路径是"查询文本向量 → image_vector"，未发现独立的 image→image 检索入口（此点未穷举，标为未验证）。

## 4. 聊天检索命中图片后：给图像本体还是只给文字，取决于 chat 模型

- 有视觉能力的模型：检索命中的图片被读回并作为图片内容附到用户消息（`W/internal/application/service/chat_pipeline/into_chat_message.go:227`、`chat_pipeline/common.go:94`）。
- 非视觉模型：只加一段 `[用户上传图片内容]` 的图片描述文本（`into_chat_message.go:106`、`:194`）。
- 引用/UI：引用来源保留图片子 chunk 身份与 `ImageInfo`（`chat_pipeline/citation_sources.go:78`、`:128`）；前端按 `chunk_type` 前缀 `image_` 与 `image_info` 定位并回显原图（`W/frontend/src/components/ChatReferenceSourceView.vue:217`、`:255`）。

## 5. 表格与音频（边界，不展开）

- 表格无独立模态：解析期直接转 GFM Markdown（如 `W/docreader/parser/docx_parser.py:61`），切片时按表格行/表头处理（`W/docreader/splitter/splitter.py:81`），之后就是文本 chunk。
- 音频独立于多模态：`ASRConfig{Enabled, ModelID, Language}`（`W/internal/types/knowledgebase.go:792`）；未配 ASR 时音频入库直接失败（`knowledge_process.go:3867`）；视频明确不支持入库（`:3879`）。本次不扩音频。

## 6. PACE 已有 vs 未接（只读核对）

- 已有：Docling 解析结果里的图片被抽出并随版本落盘、按名提供访问（`packages/worker/src/knowledge/parsing.ts:567`、`:719`；`packages/worker/src/knowledge/ingestion.ts:204`、`:433`；`packages/api/src/features/knowledge/image-routes.ts`）；图片随知识包导出/导入（`packages/api/src/features/knowledge/package.ts:74`、`:401`）。
- 已有但未用于多模态：chunk `kind` 枚举含 `image`（`packages/shared/src/knowledge.ts:88`），但切片只产出 `text`/`table`（`packages/worker/src/knowledge/parsing-adapter.ts:146`）。
- 未接：模型档案只有 `embedding`/`rerank` 且 embedding 固定 1024 维（`packages/db/src/schema.ts:623`、`:640`），没有 VLM/视觉/ASR 类型；检索结果只回文本 `quote`，无图片字段（`packages/api/src/features/knowledge/retrieval.ts:117`；`packages/shared/src/knowledge.ts:116`）；MCP 只暴露文本型 `knowledge_search`/`knowledge_read`（`packages/api/src/features/knowledge/mcp.ts:72`、`:103`）。
- 结论：PACE 的"图片抽取/存储/包导出/HTTP 供图"已有实现，可复用这条链路；Docling 文档 OCR 请求也已接入，但不等于已接通上游的图片 VLM OCR/caption 后处理。后者以及图像向量、专家读取命中图片本体尚未接通。知识模型 profile 无独立 VLM 配置，不能据此断言平台所有聊天模型均无视觉能力。
