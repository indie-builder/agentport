# PACE 知识库实际运行验证记录

2026-10-25，真实应用与浏览器测试，不使用主应用数据，不调用付费模型。

## 测试实例

- API/静态前端：http://127.0.0.1:3305（独立进程，task bsd98lb1p）
- PG：pace_knowledge，127.0.0.1:55432
- Redis：新独立 pace-knowledge-research-redis，127.0.0.1:56379；不消费主Redis队列
- 原件/工作区：`.tmp/knowledge-runtime/{files,workspaces}`
- 协议夹具：http://127.0.0.1:3356，提供embedding/rerank/Feed/文章，确定性向量并非真实模型推理；脚本`.tmp/knowledge-runtime/fixtures.mjs`（task btkhpipm3）
- 浏览器ego taskSpace49，p1；只使用本测试账户登录。

## 已操作

1. health/live HTTP返回status ok。
2. 浏览器登录成功，导航到/knowledge，看见第四资源页签，与用户A选择一致。
3. 打开新建表单，创建本地协议fixture embedding profile（API201），选择该profile填写知识库名称和slug，通过真实页面创建成功。
4. 点击新库进入详情，页面正确显示单一h1与五个tab（文档/检索/Wiki/来源/任务），桌面无水平溢出。已截图查看，截图路径在ego临时目录。
5. 发现真实标题缺陷：详情内容正确，但document.title是“页面不存在 · 控制台”；需补app-shell路由身份识别，不能把知识详情当未知路由。
6. 列表显示共50个库但测试库中多于50（此前测试fixture残留），计数需分页/服务端总量或明确当前页，不能假装全部。
7. 登录后的默认跳转是工作台，不保留知识路径，本轮未改登录流程，手动导航到/knowledge继续。

## 实际运行补充

- 为避免同一DB的认证fixture干扰，浏览器已改用独立库 `pace_knowledge_browser`（同55432实例），原件根 `.tmp/knowledge-runtime/browser-files`，API3305。单元测试仍用 `pace_knowledge`。
- 浏览器真实建库、选择本地fixture模型、上传中文Markdown，独立Redis56379投递，真实 `startKnowledgeWorker` 消费：文档pending→ready，生成当前版本。
- 浏览器检索“发布”命中真实索引，标题层级和代码片段保留。无手工写索引；fixture deterministic embedding仅证明协议链，不证明模型质量。
- 浏览器创建/触发本地RSS来源，实际worker连续两次sync succeeded，本地文档和外部文章均保持ready，未误disable未改内容。
- 修复详情title后页面显示“知识库 · 控制台”，单h1；390×844窄屏截图确认无横向溢出。
- 浏览器打开文档检查器，真实正文/代码/分块可见；编辑首chunk并保存，页面更新后真实重索引，再检索“手工修订”命中新正文；点击查看原文真实加载对应版本解析Markdown与下载链接。
- 网页导入菜单/表单实际提交本地文章，worker处理为ready。
- 新发现并修复轮询：文档排队状态是pending，而轮询只认queued/running/processing；导致新文档即显示“已停止自动刷新”。回归测试先false→预期true失败，再加入pending后2条通过。
- SDK/CLI真实进程→本地Anthropic协议mock→受控MCP→Wiki落库另见 [SDK冒烟](knowledge-sdk-smoke.md)，不注入queryFn。正常保存已验证，取消目录残留修复仍进行中。

## 未验收

真实Docling/OCR、真实飞书/GitLab账号、真实模型质量与收费路径未调用。Wiki发布、完整语料包与全备份恢复演练仍需看各独立验证报告；本记录不替代它们，也不把模块测试通过当生产上线通过。

## 工具限制

ego显示有可用更新，本轮不擅自升级。当前通过已安装版本操作并遵循用户登录与taskSpace边界。测试完成后finish同一taskSpace，关闭独立进程与本任务容器前保留可复现记录；不操作主应用进程。
