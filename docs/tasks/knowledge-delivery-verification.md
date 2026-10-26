# 知识库本地交付验证

日期2026-10-25；基线797edfea，分支worktree-knowledge-base-research。按用户选择A加入第四资源页签。腾讯Memory暂缓，原生记忆未替换。**未提交、未推送、未合并、未操作主库镜像/迁移。**

## 已实现

- 知识库/目录/标签与原件管理；批量上传、网页、手写Markdown，文档解析/OCR服务配置、结构化分块、图片读取、分块人工修订/启停。
- 中文关键词与向量混合召回、RRF、可选rerank、检索测试、版本来源、原文查看；模型配置与库设置/重建。
- 每库内置只读MCP，run凭证与库绑定；专家父子分别绑定；聊天来源查看；官方专家包的知识连接配置导入导出。
- Wiki SDK生成草稿、来源约束、人工编辑/发布/回退、版本冲突、旧来源拒绝发布、源变化stale/自动草稿任务。
- 飞书Wiki/Drive、GitLab仓库文本、RSS/Atom/JSON Feed的显式范围、多范围游标、定时/手动同步、失败重试与历史、删除/失权/Feed窗口区别。
- 队列取消、超时、重启对账、缺失队列补投与每日无引用文件清理。
- 知识包（含真实图片字节、人工分块、Wiki历史失效引用）导入导出；平台知识卷备份/恢复与失败回滚；Compose与正式文档。

## 新鲜验证结果

| 检查 | 真实结果 |
|---|---|
| 完整Vitest | 178 files / 1449 tests passed / 0 failed，隔离55432 PG与56379 Redis、无联调消费者，约141秒 |
| 正式e2e | tests/knowledge.e2e.ts三条＋共享登录一条，4/4 passed；标准超时、--no-cache再跑仍过，run01a1737d-65ce-7d32-b45a-66351fda906d |
| 全仓typecheck/build | 通过 |
| pnpm lint | 退出0，106 warnings/1 info（主要非空断言）；不是零告警 |
| lint:focus / lint:contract | 通过 |
| Compose含docling profile / shell bash -n | 通过 |
| db:generate | No schema changes；0033已空库/既有结构隔离迁移演练 |
| 独立Opus | 最终两份报告10项问题定点源码复核均有修复，无确认阻塞残留，另有覆盖限制 |

最后测试格式整理涉及生成器增加`yield await rejectedPromise`，定向Wiki/连接器/检索/backup测试回归在最后收尾命令记录；不以格式代替行为验证。受版本控制的`.vitest/json/output.json`仅为本轮运行自动变动，已备份进.tmp并恢复原文件，避免交付运行产物。

## 超出单测的实际运行

- 浏览器独立3305＋pace_knowledge_browser：真实页面建库/上传→独立Redis→实际worker→解析与索引→检索，保留中文标题、代码。实际改chunk保存重索引后检索新正文与原文回跳。390px窄屏无横溢、单h1。Feed实际连续两次同步succeeded，不误停未变内容。
- Wiki真实SDK0.3.310 spawn CLI→本地Anthropic协议mock→真实MCP工具→真实草稿落库；工具集只有受控MCP，子进程无DB/APP_SECRET/Redis；取消等待return并persistSession:false后会话目录不重生。
- 主会话重新执行完整backup.sh→restore.sh真实PG演练：关键行md5、知识二进制/Markdown、记忆文件sha、manifest和权限一致；非空target先拒绝。临时drill库已清理。
- macOS Docker Desktop新造命名卷run模式tar/换入曾实际演练；故障回滚用shell替身注入第二mv失败及回滚失败，旧文件保留不嵌套。
- `pnpm deploy --prod --legacy`独立worker复制成功，部署副本可import Wiki模块及正式SDK依赖，不再依赖兄弟sandbox目录。

## 未验证/必须配置

- 未拉起真实Docling服务、未用真实扫描PDF/Office验证OCR和定位质量；配置DOCLING_URL与X-Api-Key后再验收。未配置只使对应格式任务失败，不阻止worker启动。
- embedding/rerank使用本地确定性协议夹具，Wiki模型使用本地响应mock：证明装配不是模型质量/费用保证。
- 未使用真实飞书/GitLab凭据，scope、企业内容和目标版本限流仍需实际账号验收。当前GitLab是仓库文件，不含Wiki/Issues/MR；飞书表格/多维表等未实现对象明确报不支持，不冒充成功。
- 未在主数据库执行镜像切换或迁移；同PG18不意味着已验证所有卷兼容，实际部署先完整备份。
- restic远端未实测。知识私有语料包与公开专家定义包分开，私有记忆/会话不自动公开。

## 记录

[运行](knowledge-runtime-verification.md) · [SDK](knowledge-sdk-smoke.md) · [真实恢复演练](knowledge-backup-drill.md) · [最终复核](knowledge-final-fix-verification.md) · [实施](knowledge-implementation.md)

本地参考WeKnora仍位于忽略目录.tmp/references/；所有产出留在本worktree。最终停止本任务API/fixture服务并关闭ego space49，不影响主应用服务；隔离容器/数据保留供继续验证，按明确名称识别，不使用compose down清主栈。
