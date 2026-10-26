# 知识实现独立审查与整改

2026-10-25。用户选择A：知识库作为第四资源页签，完整功能继续实施，腾讯Memory暂缓。不提交。

## 审查结论

独立Opus检查当前实际产品文件并做部分最小复现：**不通过完整闭环验收**。此前105tests green只覆盖各自模块，不能称后端全部完成。已拆独占执行包修复，主会话不并发编辑相同文件。

| 发现 | 证据/影响 | 整改owner与范围 |
|---|---|---|
| 不完整快照推导缺失删除 | adapter丢complete，Feed窗口淘汰会被误禁用；GitLab现实际全tree，不再误称已证实增量items路径 | sources集成：sources/adapter/ingestion/http |
| 飞书凭据映射/多范围 | config.appId未进credentials，ranges只取首项 | 同上，范围游标隔离与真实HTTP测试 |
| Docling未接真实配置 | queue/index没注入DOCLING_URL/key/signal，PDF必失败 | parsing owner出工厂，queue owner接实际配置 |
| 解析适配破结构 | heading清空、fenced code空行断裂、页码offset不对应、token粗换失真 | parsing/adapters + core模型owner |
| 任务取消/调度/恢复缺失 | cancel只queued、syncCron/wikiAutoUpdate只有配置，进程重启running永卡 | API任务owner + worker scheduler/reconcile owner |
| Wiki SDK不在部署依赖 | fallback兄弟sandbox路径生产无效 | 已安装worker正式0.3.310，Wiki owner静态导入清fallback |
| Wiki宿主内置工具仍存在 | allowedTools非工具白名单，tools未清空，cwd默认worker项目 | Wiki owner官方SDK配置和最小运行权限 |
| 草稿替换已发布 | saveWikiVersion对sdk也切current指针，失败不恢复 | API/DB owner只追加草稿，明确publish入口 |
| 模型出站/响应异常 | 未检私网/重定向；garbage向量被Number吞为NaN | API URL owner + core有限数/排序/范围/redirect校验 |
| 导出/绑定断裂 | 专家包knowledge fallthrough generated空baseUrl，独立语料包缺失 | 绑定/引用owner + package owner |

## 同时补齐的已确认功能

- 前端：库/文件夹/标签/分块编辑与文档检查器、来源编辑、syncDeletions开关，不接受删入口缩scope。
- 专家绑定：普通servers列表隐藏knowledge后必须从知识列表选择serverId，保留父子原绑定。
- 聊天引用：从真实持久tool results读取来源，原文预览与失效状态。
- 备份：macOS Docker Desktop命名卷无法宿主读取不能当null；按已有workspaces容器exec/run读写。
- 部署：使用真实registry RepoDigest，禁止image config Id作为manifest digest；不把同PG18换镜像误称必然不可逆。

## 实施基础设施

隔离PG：pace-knowledge-research-pg，127.0.0.1:55432，已验证vector0.8.7。新独立Redis：pace-knowledge-research-redis，127.0.0.1:56379，与主队列分开。
主会话统一依赖：worker正式新增feedsmith3.0.1（MIT）、Claude Agent SDK0.3.310（同sandbox），此前turndown7.2.4/@types5.0.6。安装已成功；不安装腾讯Memory。

## 状态

整改进行中，等待实际改动与测试结果，再复核；静态API/MCP tests不等同真实SDK模型或企业连接验收。无真实模型/飞书/GitLab凭据时明确未验证，不伪造结果。
