# 多模态处理链独立评审

2026-10-25；静态评审；只检查 core/shared/db 与 worker 图片解析、摄取、重建、队列及相关测试。未修改实现、未派代理、未碰共享数据库。
依据：`knowledge-multimodal-contract.md`、项目 CLAUDE.md、PITFALLS.md。负载按个人平台现有异步 worker，不假定大型并发集群。
结论：以下 1、2 应先修复；3、4 为明确功能缺口。真实 CLI + HTTP mock describe 链通过不能覆盖这些数据发布与恢复问题。

## 必须修复

1. **P1：收到取消后仍可发布新版本**
   - 位置：`packages/worker/src/knowledge/ingestion.ts:623`；`packages/worker/src/knowledge/queue.ts:151`；`packages/db/src/repo/knowledge.ts:500`。
   - 触发：embedding 后最后一次 `checkAborted` 在 ingestion:572；随后创建版本、写图片、插 chunks 都有 await。在写文件/插 chunks 期间取消，queue 只 abort signal，运行中 job 行仍是 running。
   - 结果：623–626 只查 job.status，不读 signal；setCurrentVersion 也不校验取消或库状态，因此仍切换 currentVersionId。库在最后一次 active 检查后停用，也可被该事务发布。违反合同 §4 的取消/发布约束。
   - 最小修法：插 chunks 前、切版前补 `checkAborted`；让现有切版事务接收 jobId 并检查持久化取消/库 active，和现有取消入口统一发布判定，避免仅靠外部读取 job 行。
   - 验证缺口：需在 writeParsed 或 insertChunks 的 await 期间触发 abort，断言 currentVersionId 保持旧值；现有配置变更测试不能证明该路径。

2. **P1：chunksOnly 会把新模型向量写入旧模型版本**
   - 位置：`packages/worker/src/knowledge/ingestion.ts:707`、`:730`、`:742`、`:756`。
   - 触发：文档当前版本属于 profile A，库改用 profile B，然后执行 chunksOnly；有缺失 embedding 的 OCR/caption/vector chunk 时，代码直接用 B 客户端补写。
   - 结果：version.embeddingProfileId 仍为 A，已有 A 向量与新 B 向量混在一版。按合同的版本 profile 过滤时 B 查询不会使用这些补写结果；库切回 A 后则可能使用 B 向量。相同 1024 维不能保证同空间。
   - 最小修法：reembedMissing 开始读取版本，若 version.embeddingProfileId 与 base.embeddingProfileId 不同立即拒绝并要求完整重建；同一版本禁止改 profile 标签来掩盖混空间。
   - 验证缺口：增加 A 版本切 B 后 chunksOnly 的拒绝测试，并断言旧 chunk.embedding 未改。模型 profile 的 API 原地修改已有引用时已有拦截，不把它重复报错。

## 功能缺口

3. **P2：降级后的图片向量不能通过补缺失任务恢复**
   - 位置：`packages/worker/src/knowledge/ingestion.ts:465`、`:482`、`:733`。
   - 触发：OCR/caption 成功，embedImages 临时 429/超时；catch 只写 warning，不追加 vector draft。上游恢复后执行 chunksOnly。
   - 结果：reembedMissing 只遍历已存在、embedding=null 的 vector chunk；降级版没有这种 chunk，因此静默返回成功，图片向量仍缺失。现有补建测试手工提供 vector chunk，未覆盖真实降级产物。
   - 最小修法：向量失败时仍创建合法 vector draft（已有描述、metadata、searchText:''、embedding:null），明确从文本 embedding 列表排除它，供 chunksOnly 按原图补建；或在补建时按清单与描述补缺少的 vector chunk。
   - 限制：完整重建会重新描述原图并再次请求向量，因此不是永久不可恢复；问题是既有“只补缺失向量”恢复入口未接通。

4. **P2：独立图仅校验 magic，未实现真实解码和本地限额校验**
   - 位置：`packages/worker/src/knowledge/parsing.ts:56`、`:769`；`packages/worker/src/knowledge/image-processing.ts:177`；`packages/worker/test/knowledge-parsing.test.ts:219`。
   - 触发：只有 6 字节 JPEG 头、10 字节 GIF 头或 RIFF/WEBP 标签的截断数据。现有测试甚至把这些不可解码 fixture 标为 real image 并要求成功。
   - 结果：parseDocument 返回 ParsedDocument.images，后处理只查 MIME 就发给视觉模型；坏图进入收费模型阶段才失败。尺寸/像素及请求体限额也没有在这条入口校验，不能达到合同 §4“真实解码一致性、超限明确失败”的验收要求。
   - 最小修法：复用现有可用图像解码能力验证图像与尺寸，在发 SDK 前按实际上游限制检查大小；将头部 fixture 改为完整可解码小图，并增加截断图与超限拒绝用例。不要另建图片服务。

## 已核对与未下结论项

- Cohere 官方 `<https://docs.cohere.com/v2/reference/embed>` 当前明确列出 `input_type` 的 `image` 枚举，并写明 image embeddings 支持 v3.0 及更新模型；v4+ 图片请求总量上限 20MB。因此不把 embed-v4.0 + images + input_type:image 判为不支持。未用真实 Cohere 凭证验收效果。
- OCR/caption 按动作独立取 structured_output，空文本不索引；单动作成功保留结果，双失败阻止发布；vector 正常成功时单独 embedding 且 searchText 为空。这些分支在代码及对应测试中有接线。
- shared settings 的默认值与启用约束、图 metadata 角色、DB 图片 warnings 与 profile/imageInputEnabled 字段已存在；不据实现 agent 自报认定通过。
- Docling 仅提取 pictures[].image.uri 的 data URI，跳过远程 URI；请求未显式指定图片导出模式。本轮未取得实际部署 Docling 响应，不能证明默认形态必定丢图，也不能认定已通过真实插图验收。
- SDK errors/result/异常原文及 embedding HTTP 错误会进入 warnings，部分分支未限长。未在本 scope 证明包含凭证的真实错误样本与最终授权外暴露，故不以假定泄密立缺陷；建议验收用含敏感标记的上游错误确认脱敏边界。
- 图片开关关闭后的检索/读图即时隐藏、profile 切换后的检索过滤、历史回滚读取属于 API 调用方，本轮按限定范围未审；不能从 worker 的“不再生成”推断历史语义 chunk 已隐藏。
- 未运行集成测试、build/runall 或共享 DB；未评 GitHub/source bugs/Wiki。结论是静态缺陷定位，不是多模态质量或部署验收。
