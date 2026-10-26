# 多模态 API / Web 独立只读审查

日期：2026-10-25。结论：**暂不可按完整多模态能力交付**；至少先修复下列 P1。
范围：knowledge routes/retrieval/mcp/read-image/image-routes/package/package-routes、Web settings/citations/detail/API types；仅为恢复链核对 worker reembedMissing 与必要 shared/core/repo。已读 CLAUDE.md、PITFALLS.md、knowledge-multimodal-contract.md。
方式：静态源码审查，无代理、产品改动、DB、构建或测试执行；唯一产出是本文，未提交/合入。

## 发现

1. **P1｜ZIP 往返永久丢失图片向量身份，chunksOnly 无法恢复。**
   - 定位：`packages/api/src/features/knowledge/package.ts:406`、`:462`；`packages/worker/src/knowledge/ingestion.ts:719`、`:733`、`:737`。
   - 触发/影响：启用图片向量的库导出时过滤整个 vector chunk；导入只写导出的 OCR/caption。chunksOnly 只处理已有 embedding=null 的 chunk，找不到 vector chunk 就返回，任务成功但图片向量检索始终缺失。完整重解析会重新生成描述，不能替代契约要求的保留人工内容恢复。
   - 最小修法：导出 vector chunk 的身份、metadata、启停状态与描述，仅省略 embedding；导入令 vector 的 searchText 为空，再用既有 chunksOnly 的 embedImages 分支恢复。增加 export→import→chunksOnly 后 vector role/原图绑定仍存在的集成断言。

2. **P1｜停用库仍可从管理检索 API 召回。**
   - 定位：`packages/api/src/features/knowledge/retrieval.ts:207`、`:218`；`packages/api/src/features/knowledge/routes.ts:1048`。
   - 触发/影响：库设为 disabled 后请求 GET /api/knowledge/bases/:id/search；searchKnowledge 只检查库存在，SQL 也未检查库状态，仍返回 ready 文档的文字及图片语义命中。MCP guard 的拦截没有覆盖该 REST 入口，违反契约的停库即时生效。
   - 最小修法：在 searchKnowledge 读取 base 后拒绝非 active，覆盖管理 API 与 MCP 的公共路径；增加停库后 REST 搜索拒绝的断言。

3. **P2｜ZIP 图片 metadata 可以绕过角色校验并制造不可检索分块。**
   - 定位：`packages/api/src/features/knowledge/package.ts:1055`；`packages/api/src/features/knowledge/retrieval.ts:100`、`:118`、`:141`；`packages/api/src/features/knowledge/read-image.ts:49`。
   - 触发/影响：导入 metadata={imageRole:'vector'}、没有 image 的分块；校验遇到没有 image 直接 continue，导入成功。文字两路排除 vector，但图片不开 opt-in 时没有召回路径，造成静默不可检索。反过来 kind=text/table 携带合法 image metadata 也通过，检索会给出图片身份，而 read_image 因 kind 不是 image 拒绝。
   - 最小修法：入口只要出现 image 或 imageRole 任一保留键，就校验完整图片 metadata，并要求 kind=image；验证引用图片的 page/MIME 与清单一致。普通无图片 metadata 仍照旧。

4. **P2｜切换 embedding profile 可绑定重排模型或停用模型。**
   - 定位：`packages/api/src/features/knowledge/routes.ts:547`、`:551`；对照创建入口 `:476`。
   - 触发/影响：PATCH 库 embeddingProfileId 为一个现存 rerank profile，或停用的 embedding profile。更新仅检查存在；未启用图片向量时 imageSettingsProblem 直接放行。库随后向量查询降级，重建不能使用正确 embedding profile，阻断切换 profile→完整重建链。
   - 最小修法：更新入口复用创建入口的 kind=embedding 且 enabled 检查；增加两种无效切换的拒绝用例。

5. **P2｜图片引用错误丢失 HTTP 类型，无法区分失权与缺图。**
   - 定位：`packages/web/src/components/knowledge-citations.tsx:156`、`:167`；`packages/web/src/pages/knowledge-detail.tsx:1159`、`:1553`、`:1564`。
   - 触发/影响：正文可读但单图被删返回404，或登录失效/拒绝返回401/403时，img onError 一律显示同一泛化错误。正文请求的 ApiError 分支不能反映独立图片请求状态，不满足契约要求的401/403/404明确呈现。
   - 最小修法：沿现有鉴权 request 封装读取图片 Blob 并保留 ApiError.status，使用对象 URL 展示并清理；各引用/版本图共用同一加载与错误呈现方式。

## 已核对与覆盖边界

- MCP read_image 逐次检查 active 库、图片开关、绑定库、enabled chunk、ready 文档与 currentVersion；metadata 使用单段 name schema，随后匹配 versions.images；读取原图检查 MIME 与5MiB。未发现直接传 name/path/URL 的入口。
- Web 图片端点有 requireAuth、版本清单与单段文件名校验；历史版本原图不受图片处理开关影响，符合契约的历史引用规则，未将其当越权问题。
- MCP 输出确实是 JSON text 加可选 image content；description 默认不附图。仅证明服务端构造，**未证明真实 SDK/网关把 MCP image 送达视觉模型**。
- 关键词与普通向量均排除 vector role；图片路要求 opt-in、能力匹配与最低分。向量 SQL 限制版本 profileId；已引用 profile 禁止改 model/protocol/imageInputEnabled。上述静态过滤未见混空间直接召回。
- profile 测试入口先发 search_query 文本，再对 imageInputEnabled profile 发真实 tiny PNG；core 文本适配校验返回数量，图片入口传预期图片数。未把缺真实凭据判为代码缺陷，未验证真实端点效果。
- 包的图片文件路径白名单、sha256、ID 重映射已存在；第3项是 metadata 关系校验缺口，而非缺少文件哈希。
- 未审查范围外 GitHub/Wiki 重构、完整摄取/取消/发布并发、完整 profile 切换后人工编辑的重嵌入行为；未跑 DB/build/fullsuite 或浏览器。真实服务质量与 SDK 原图通路仍需后续实测，本文不替代交付验收。
