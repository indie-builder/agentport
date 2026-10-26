# 多模态最终定点复核

2026-10-26；当前 knowledge-base-research 树；只读产品源码，仅写本文，未派代理、未提交、未合入。
结论：**可交付本地多模态功能；原两份初审共9项全部关闭。本次未发现有证据支持的新产品阻塞。**

## 原9项收口

1. processing-1 取消发布：CLOSED。`packages/db/src/repo/knowledge.ts:528` 入口检查；`:554` 在 job/base 两次 await 与配置检查之后、UPDATE 之前再次调用 `guard.isAborted`，补齐上次 REOPEN 的明确漏检。
   `packages/worker/src/knowledge/ingestion.ts:649–655` 切版前检查并传入真实 signal 回调；不将最后检查之后不可避免的瞬时取消窗口扩成新阻塞。
2. processing-2 profile空间：CLOSED，沿用[处理修复复核](knowledge-multimodal-fix-processing-verification.md)第2节。
3. processing-3 降级恢复：CLOSED，沿用上述复核第3节。
4. processing-4 图片解码/限额：CLOSED，沿用上述复核图片校验补充及[交付验证](knowledge-multimodal-delivery.md)72条回归与生产依赖副本记录。
5. API/Web-1 ZIP身份与恢复：CLOSED，沿用[API修复复核](knowledge-multimodal-fix-api-verification.md)，含真实导出→导入→chunksOnly回填与停用状态往返。
6. API/Web-2 停库检索：CLOSED，同上，已补REST active 200→disabled 409实测。
7. API/Web-3 metadata关系校验：CLOSED，同上；不将未逐分支实测误写为全分支覆盖。
8. API/Web-4 profile换绑：CLOSED，同上；以上API独立复核已有18条实际通过。
9. API/Web-5 图片错误状态：CLOSED。本轮核对 `knowledge-citations.tsx`、`knowledge-detail.tsx`、`security.ts`：共用 KnowledgeImage，鉴权fetch保留401/403/404，成功取Blob后img只读对象URL，CSP允许blob:。
   引用/版本图复用组件，正文去除生成的images/重复引用；无fetch后再以远程img src重复请求。换图重置状态，旧请求abort，完成回调检查abort，换图/卸载revoke；解码失败单次转alert，下载原件入口保留，无自动重试循环。

## 证据边界与质量限制

- 本轮为源码定点复核，不运行测试或DB；沿用[交付验证](knowledge-multimodal-delivery.md)及主会话工具执行记录：最后55条定向测试、全仓typecheck/build通过；正式e2e 2/2，断言blob URL与complete/naturalWidth>0。
- 本轮复核时未看到事务内callback测试；之后执行代理在 `packages/worker/test/knowledge-ingestion.test.ts:382` 补入“cancellation lands while the publish guard reads job/base”，主会话实际运行摄取文件32/32通过（brd2z8gmt）。这是复核后的运行补充，不能追认为此前55条已包含该用例。
- 真实视觉识别/检索质量、费用、真实Cohere服务与Docling插图输出、Linux镜像运行未经本轮验收；本地协议夹具与真实SDK/MCP通路不能代替这些质量结论，缺真实模型凭据不构成源码通过的前置条件。
- 本报告取代旧报告对取消项的REOPEN及最终交付阻塞判断；既有验证的范围限定仍有效。成果为本地未提交差异，尚未合入或部署主栈。
