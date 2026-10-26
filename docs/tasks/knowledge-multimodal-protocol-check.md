# Cohere 多模态嵌入接口核对

核对对象：`packages/core/src/knowledge/models.ts` 的 `embedTexts` / `embedImages`，当前只走测试桩，**未对真实 Cohere API 发起请求**。

## 事实（docs.cohere.com，2026-10-25 查阅）

- `POST /v2/embed` 必填 `model`、`input_type`；`input_type` 允许值：`search_document`、`search_query`、`classification`、`clustering`、`image`。
- 图片通过可选 `images`（data URI 或 URL）传入；Embed v3.0 起支持，格式限 `image/jpeg`、`image/png`、`image/webp`、`image/gif`。
- 图片数量/体积：v3.x 每次 1 张、单张 5MB；v4.0 及更新无每请求图片数上限；所有图片合计 ≤20MB。
- `embedding_types` 允许 `float`/`int8`/`uint8`/`binary`/`ubinary`/`base64`，`float` 为默认且全模型支持。
- `embed-v4.0` 的 `output_dimension` 支持 256/512/1024/1536，默认 1536。

## 与当前实现的对照

- 图片走 `input_type: 'image'`（在允许值内，**不要**改成 `search_document`）；文本走 `search_document` / `search_query`，符合文档。
- `output_dimension: 1024`、`embedding_types: ['float']` 与文档一致，v4.0 显式 1024 合法。
- 未覆盖：20MB 合计体积、v3.x 单图限制、非 png/jpeg/webp/gif 的 MIME 在客户端无预检；真实 API 的限流与错误码未实测。
