# 多模态适配本地交付验证

2026-10-26；worktree `knowledge-base-research`。按用户要求参考 WeKnora 实际多模态处理链适配为 PACE 内置知识库。**未提交、未推送、未合入、未部署主栈。**

## 本轮改动

- 独立 PNG/JPEG/GIF/WebP 与文档提取图片共用已有摄取/版本/存储。真实解码与单图5MiB检查在视觉调用前完成，成熟 sharp 库替代自写解码器。
- 库设置启用图片处理并选现有网关模型；OCR/caption独立生成可检索文字，图片向量显式opt-in（同profile Cohere v2 embed-v4.0，1024维）。单动作失败保留另一个，双失败不发布，向量失败保留可恢复子块和警告。
- 搜索命中保留图片名/MIME/页码/版本身份；专家 `knowledge_read_image` 默认描述，按需原生MCP图片内容，不改Agent执行循环。Web原图通过已有鉴权端点读取Blob，清理对象URL，区分401/403/404；CSP显式允许blob图片。
- 知识包保留图像子块身份/描述/启停，排除向量数值与密钥；导入校验角色和版本图清单，chunksOnly从原图恢复图片向量，不重复视觉生成。
- 处理/重建不混模型空间；已观察取消、库停用与配置变化拒绝发布。被引用profile不可原地换模型/协议，换绑profile必须启用且类型匹配。
- 迁移0034新增embedding协议/图片能力字段；现有PG/Redis/BullMQ/SDK/视觉体系保留，无新知识服务。

## 实际验证

| 检查 | 结果与边界 |
|---|---|
| 完整Vitest，整改后快照 | 180文件通过、1文件跳过；1523通过、7跳过、0失败，约139秒。agent-invoker-lifecycle因瞬时队列前置条件跳过；无消费者后单独7/7通过，另chat-admission11/11通过 |
| 最后取消补丁与包恢复/CSP回归 | 3文件55/55通过；随后新增事务读取期间取消用例，摄取整文件32/32通过，确认旧currentVersionId不切换。另含真实导出→导入→补索引与停库REST检索 |
| 图片处理/解码回归 | 3文件72/72通过；后续最后取消补丁在上述55条复核 |
| 图片引用/管理前端 | 2文件54/54通过；全Web由执行代理运行40文件397条通过 |
| 全仓typecheck/build | 最后补丁后退出0 |
| lint:focus / lint:contract | 最后整合通过 |
| Biome相关文件 | 35文件error级检查通过；已有非空断言warnings仍保留，不宣称全仓零告警 |
| 数据迁移 | 0034在55432隔离库及独立浏览器库执行成功；db:generate再次No schema changes，38表 |
| 真SDK图片理解 | describeKnowledgeImage→真实CLI→本地AnthropicHTTP协议夹具，OCR/caption两次原生base64图输入与structured_output返回成功；加真实解码后用完整PNG再跑退出0，无queryFn注入 |
| 真SDK专家取图 | 创建绑定专家/运行→真实HTTP知识MCP→原图image content进入模型请求，退出0；模型响应为本地协议夹具 |
| 实际浏览器 | 登录/建profile与库/开启图片/上传PNG→真实worker→可检索→命中OCR/描述→原图naturalWidth>0；已查看桌面/390×844截图，无横溢、单h1 |
| 正式e2e，最后原图组件/CSP | tests/knowledge-multimodal.e2e.ts＋共享登录2/2通过，--no-cache，run `01a173d9-8852-74ee-933d-fc26204dca8f`；断言blob URL、自然宽度及引用、无Image blocked |
| 生产依赖副本 | pnpm deploy --prod --legacy生成worker副本，可从该副本加载sharp并实际生成/解码PNG；未做Linux容器运行验收 |

首次正式e2e用了错误凭据变量，登录401、图片用例跳过；改为e2e共享session支持的 `E2E_USER_ADMIN_USERNAME/PASSWORD` 后2/2通过。首次SDK图例被严格解码拒绝，已更换完整PNG复跑通过，没有放宽坏图校验。

## 评审

- [初审处理链](knowledge-multimodal-review-processing.md)与[初审API/Web](knowledge-multimodal-review-api-web.md)。
- [API修复复核](knowledge-multimodal-fix-api-verification.md)：已确认源码修复；其测试覆盖缺口后续补了停库REST与真实包恢复，18条实测通过。
- [处理修复复核](knowledge-multimodal-fix-processing-verification.md)：模型空间与恢复关闭，事务内取消曾重开；其后已补最终update前检查与回归。
- [最终Opus定点复核](knowledge-multimodal-final-review.md)：原9项关闭，可交付本地多模态功能。复核时尚未看到的事务内取消用例后来已补入并由主会话整文件32/32实测通过，不能将此前55条误当作该用例的运行记录。

## 未验证与总体范围

真实视觉模型识别质量/费用、真实Cohere embedding服务、真实Docling插图输出与OCR质量、企业账号凭据与Linux镜像运行均未验收；本地HTTP夹具证明协议与状态流，不能证明推理质量。BMP/TIFF是否可通过目标Docling可靠转码未承诺，SDK原生四格式为明确路径。

本轮完成范围是多模态适配。GitHub新增同步、飞书/GitLab复杂对象覆盖、Wiki知识组织/专家消费及此前来源范围撤销等独立缺口仍在总体建设范围，未在此轮声称实现；腾讯Memory继续暂缓。

## 环境与产物

详细命令/红绿过程与临时脚本见 [实施记录](knowledge-multimodal-implementation.md)。测试只用55432独立Postgres与56379独立Redis；浏览器临时库 `pace_knowledge_multimodal`。主栈未操作。联调3306/3307服务、知识worker和本地模型夹具均已停止；ego空间62已finish。数据保留供复核，无自动生产清理操作。
