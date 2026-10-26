# 知识库多模态适配实施

## 目标与当前有效决定

2026-10-25 用户授权“按这个调整”：多模态以 WeKnora 已有真实链路为依据，适配为 PACE 内置知识库功能，绑定专家使用。涵盖独立图片/文档插图、图片 OCR/描述、检索、专家取图与原图引用；官方可选图片向量按实际模型协议适配，不凭空设计以图搜图。认证、模型运行、任务、存储和界面复用本项目。GitHub 等来源与既有审查整改继续保留在总体建设范围，此次不扩展这些独立功能。

腾讯 Memory 暂缓。不新增另一套 Agent harness、独立知识产品、外部宿主授权。用户未授权提交、推送、合并或主栈部署。

## 基线与已有差异

- 当前 worktree：`knowledge-base-research`，HEAD `797edfeaabd39b040d01736c49273da18347ea92`。
- 初始 git status 已记录于本轮工具输出：大量知识库实现、配置、测试和研究文档为本会话已有未提交成果；本轮在其上增量调整，不覆盖或还原既有差异，不提交。
- ce-work：native engine，配置仅 `auto_babysit:false`，没有外部执行绑定。既有未提交基础与用户不提交要求优先于技能的已提交并行基线要求；按明确文件所有权在当前树并行，不操作共享 git index，不并行安装/迁移/生成文件。
- 使用 ce-work、数据库最佳实践与 TDD 指南；当前 SDK 是 Claude Agent SDK，claude-api 技能明确不生成该 SDK 代码，不能以 API Tool Runner 替换它。

## 依据与接口

- [官方多模态调用链](weknora-multimodal-reference.md)
- [最新建设范围](weknora-core-proposal.md)
- 设计契约：`knowledge-multimodal-contract.md`（Opus 制定）。
- 官方 Agent SDK 文档 `https://code.claude.com/docs/en/agent-sdk/custom-tools` 已核：工具可返回 `image` + base64 + mimeType；SDKUserMessage.message 支持图像 content，已核本地 sdk.d.ts:6533。不用自行拼聊天用户消息实现供图。

## 执行边界与步骤

- [x] Opus 固定共享 schema、图片索引身份、配置、模型调用和 MCP 输出接口（134行契约）。
- [x] 0034 模型协议/图片能力迁移已生成并在55432隔离测试库执行；shared/db/core 构建通过，基础域30条红绿证据已收齐。
- [x] 独占域并行实现已返回：worker 图片处理；API 检索/MCP/包往返；Web 设置/检索/引用。
- [x] 定向测试、完整回归、全仓typecheck/build、focus/contract、实际浏览器与真SDK协议链已验证，真实服务质量边界见交付记录。
- [x] Opus 两份初审及独立定点复核完成，原9项已修复收口；最后事务内取消新增用例32/32通过。

真实依赖：共享契约先于跨模块代码；共享基础落盘/构建先于依赖测试。产品代码由子代理实施，主会话编排验证。库迁移只在55432隔离 PG，队列只用56379 Redis；主栈5432/6379及其运行 worker 不动。单元测试不得默认读取主库 .env。

## 验证

基线：shared/db/core 构建通过；定向 core knowledge-models、shared knowledge-mcp-entry、worker knowledge-parsing 三文件34测试通过（本轮实际运行，dot reporter复核）；隔离连接下原 knowledge-mcp 六测试通过。新产品 `describeKnowledgeImage` 已经实际 SDK→CLI→本地 Anthropic 协议夹具：两次原生 image 输入分别走 OCR/caption，structured_output 取值成功，进程退出0；脚本 `.tmp/knowledge-multimodal-sdk.ts`，结果 `.tmp/knowledge-multimodal-sdk-result.json`。没有注入 queryFn，没有真实模型推理。尚无整体多模态完成结论。先写行为测试观察预期失败再实现；外部模型采用本地 HTTP 协议夹具与真 SDK 路径，不冒充实际识别质量验证。检查文字原件/检索、图片开关、图像字段与安全边界、删除后不可取图、取消与失败、语料包往返、原图引用。真实模型效果/费用未经实测不做承诺。

## 评审与待收口

独立 Opus 两份报告：[处理链](knowledge-multimodal-review-processing.md)、[API/Web](knowledge-multimodal-review-api-web.md)。已派独占整改：取消发布检查、chunksOnly 模型空间一致性、图片向量降级/ZIP身份保留与回填、停库搜索/metadata/Profile入口、图片有效性与错误状态展示。原评审时不能按完整能力交付；后续已完成主要整改并补真实包恢复用例，最后事务内取消漏检仍在收口。Cohere `input_type:image` 经官方接口枚举及v3+说明核对，不凭指南缺少v4示例判错。

完整回归（首轮整改前快照）：181 files /1514 tests passed，退出0。整改后完整回归：180文件通过/1文件跳过，1523测试通过/7跳过/0失败；跳过文件为瞬时队列消费者触发前置条件的 agent-invoker-lifecycle，已在无消费者时单独复跑7/7通过，chat-admission另11/11通过。完整回归不重复宣称零跳过；最后事务取消补丁仍需定向复跑。全仓typecheck/build、focus/contract已再过；静态规范的unsafeoptionalchain与格式问题已修，34个相关文件error级检查通过。

## 实际运行记录

- `.tmp/knowledge-multimodal-app.ts` 启动3306独立 API/静态前端+真实知识 worker，使用 `pace_knowledge_multimodal` 临时库（同55432）与56379 Redis，本地3357向量协议夹具及随机端口视觉协议夹具。没有读取真实模型凭据。
- ego space62实际登录→创建profile/知识库→设置图片处理与mock模型→上传tiny PNG→worker摄取→页面“可检索”→检索“季度收入”命中OCR/caption→原图鉴权请求成功，浏览器 naturalWidth>0；已读取桌面及390×844截图，scrollWidth=390、单h1。微型纯色图只验证供图链，不代表识别效果。
- 第一轮联调脚本静态import先于process.loadEnvFile，producer拿到无密码Redis导致上传等待；改用tsx `--env-file`进程启动加载后通过。是测试脚本配置问题，不修改生产连接器。
- 真 SDK 工具 smoke `.tmp/knowledge-multimodal-mcp.ts`：独立API3307、创建指定库绑定专家/运行凭据、SDK真实HTTP MCP调用 `knowledge_read_image`；本地模型请求收到原生base64 image，退出0。没有queryFn注入。脚本报告 `.tmp/knowledge-multimodal-mcp-result.json`。
- 浏览器空间62已finish，3306应用/worker/夹具已停止，3307smoke正常退出；临时库/文件保留供复核。正式产品主栈未操作。

## 依赖与部署验证

入口坏图校验需要四格式真实解码；现有 PNG 测试依赖只在研发链，不是 worker 生产能力。新增 `sharp` 生产依赖（0.35.5，锁文件固定解析），负责在视觉调用前解码校验，不新增服务或自写图像解码器。`pnpm --filter .../worker deploy --prod --legacy .tmp/knowledge-multimodal-deploy` 成功；部署副本通过包正式导出加载 sharp，实际生成/读取1px PNG，width=1。仅宿主架构部署副本，不当作 Linux 容器运行验收。

## 当前验证结论

原9项评审发现已按 [最终Opus复核](knowledge-multimodal-final-review.md)关闭，源码可交付本地多模态功能。最后事务内取消用例已补入，主会话运行摄取32/32通过。最终结果集中见 [交付验证](knowledge-multimodal-delivery.md)。本轮保持未提交/未合入/未部署。

新增正式e2e `tests/knowledge-multimodal.e2e.ts` 在实际静态托管/CSP下运行，2/2通过（共享登录+图片引用，--no-cache），run01a173d9-8852-74ee-933d-fc26204dca8f；真实blob URL complete/naturalWidth>0及来源摘录已断言。图像解码严格化后原smoke坏PNG被拒，换完整PNG再次真SDK通过。最后取消补丁/CSP/包恢复定向3文件55测试通过，追加核心协议/设置/引用4文件50测试通过，摄取31/31通过；全仓类型、构建、focus/contract最后再过，35文件error级Biome通过。临时应用均已停止、隔离Redis无活动消费者。

## 下一步

本轮无待执行项。整体知识库后续范围不因本次多模态完成而标为全部完成；GitHub等独立功能及真实服务质量验收边界见交付记录。
