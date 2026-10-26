# WeKnora 外部同步：飞书、GitLab 与 Feeds 范围方案

> 2026-10-25。状态：整体建设目标已获用户确认；本稿细化首批范围，不代表已获真实企业数据访问或生产操作权限。参考源码固定提交 `e1f9a6166a593a4804a2f99f1d942919c9cc8ea7`，仅静态阅读，未执行参考代码。行号均相对固定源码根 `.tmp/references/weknora-ycXjpOdz/source/WeKnora-…/`。

## 1. 确认事项与明确假设

- 建设目标：完整知识闭环、Wiki 与 Feeds、外部同步；首批实际接入飞书与 GitLab，其余连接器不随首批空壳上线。
- **Feeds 假设（暂定，需用户后续确认）**：按参考实现理解为一个订阅源连接器，支持 RSS 2.0、Atom 与 JSON Feed，每个 feed URL 是可勾选资源，条目按文章入库。**不把用户说的 Feeds 当作 FAQ**，也不擅自扩展为自动日报、邮件推送或 IM 推送；若用户另有含义，本文件第 3 节需改写。
- 范围底线：单管理员账号不等于授权同步整个企业。每个数据源必须显式选择空间/文件夹/项目/路径/feed，空选择不解释为全企业，不默认递归发现全部可见资源。
- 首批只承诺「选定范围的增量同步」，不承诺所有源全量实时。

## 2. 参考已实现的连接器（源码事实，非质量结论）

| 连接器 | 范围与选择 | 条目身份 | 增量 | 删除 | 证据 |
|---|---|---|---|---|---|
| 飞书/Lark Wiki | Wiki 空间→节点树，三级懒加载 | 节点 token | 每节点内容编辑时间+路径指纹 | 完整列举后比对缺失节点 | `internal/datasource/connector/feishu/wiki/connector.go:56-64,375-388`；`core/engine.go:100-160,217-237` |
| 飞书/Lark Drive | 用户提供 folder_token，逐层列子项 | 文件/文档 token | 文件 modified_time | 同上，子目录列举失败则暂缓 | `feishu/drive/connector.go:58-73,229-284` |
| GitLab | 每个数据源填 base_url+token，选 project_id、ref、paths | `base:project:ref:path` | 按 ref 的 commit SHA 走 compare 差异 | compare 结果中旧路径消失 | `gitlab/connector.go:23-25,98-210,211-263,448-450`；`gitlab/types.go:13-18` |
| RSS/Atom/JSON | feed URL 列表（换行/逗号分隔） | `feedURL:itemID`，itemID 取 GUID→link→title | feed 信号+条目指纹 | **故意不删除** | `rss/connector.go:58-100,128-131,239`；`rss/types.go:3-21,146-180,225-229` |

参考注册可用的相关类型为 `feishu`、`lark`、`feishu_drive`、`lark_drive`、`gitlab`、`rss`；GitHub、Web Crawler 等仍在元数据里但未注册（`website-docs/03-features/10-datasource.md:481`）。这直接约束「别把未实现连接器当已有能力」。

## 3. 飞书：Wiki 与云盘是分开的连接器

不是同一个连接器的两个标签，二者在类型、范围、内容枚举和授权动作上都分开：

- **连接器与范围**：Wiki 从空间列表进入，选择空间或节点；Drive 没有「空间列表」API，根必须是用户填写的文件夹 token，留空直接拒绝（`feishu/drive/connector.go:58-73,86-108`；`feishu/core/types.go:177,290`）。
- **授权范围**：Wiki 必选 `wiki:wiki:readonly` 等；Drive 明确**不需要** `wiki:wiki:readonly`，但必须把目标文件夹分享给应用所在群，API 权限与文件访问权是两层检查（`website-docs/03-features/10-datasource.md:79-102`；`24-feishu-drive.md:13-30`）。参考文档称权限开通后需发布新版本才生效；本轮仅核对官方 tenant token 文档：`app_id`/`app_secret` 换 token、token 最长 2 小时、该接口本身无权限要求（官方 `tenant_access_token_internal`），其余 scope 清单属参考文档陈述，实施前需按官方开放平台逐项复核。
- **内容范围（含表格与附件，不臆测）**：`docx` 走 blocks API 或异步导出；`doc`/`sheet`/`bitable` 走导出（xlsx/docx）；`file` 类型下载原文件；`mindnote`/`slides` 无正文 API，**跳过**；`board`/思维导图可导出图片，需要 `board:whiteboard:node:read`，缺权限降级占位（`core/shared.go:286-293`；`wiki/connector.go:416-428`；`drive/connector.go:387-396`；`website-docs/03-features/10-datasource.md:112-137`）。
- **表格/多维表**：作为独立 wiki 节点时导出为 xlsx 再解析；作为 docx 内嵌块时转成文档内 Markdown 表格，需 `sheets:spreadsheet:readonly` / `bitable:app:readonly`（`core/blocks.go:140-160,347-360,408-455`；`10-datasource.md:92-97`）。PACE 不能假定「导出 xlsx」已等同于表格结构完整保留，需在 M0 用真实表验证。
- **附件**：blocks 模式下 docx 内 file block 附件会作为独立条目入库并与父文档互相关联；export 模式不保留内嵌附件（`10-datasource.md:117-124`；`core/shared.go:148-160`）。这是飞书侧能力，不是所有源共有。

## 4. GitLab：只同步仓库文件

- 实际同步范围：所选项目的选定 ref（分支或标签）下的文件树/文件内容；不做 GitLab Wiki、Issues、Merge Requests（`grep issues|merge_requests|/wiki` 在 `connector/gitlab/` 无实现）。
- self-hosted：`base_url` 必填，自动补 `https://` 与 `/api/v4`，并经连接器基址校验（`gitlab/client.go:110-124`）；内网地址仍受 SSRF 白名单约束，不因「私有部署」放开。
- 项目选择：`settings.projects` 非空数组，每项 `project_id`、可选 `ref`（空=默认分支）、可选 `paths`（空=整仓）；路径去重并折叠父子目录（`gitlab/types.go:13-72`）。
- 增量与删除：首轮全量流式读取；之后按 commit SHA compare 只取变更文件，重命名/删除通过 OldPath 产生删除项，且受数据源 `sync_deletions` 开关控制（`connector.go:132-210,274-320,448-450`；`types/datasource.go:64-109`）。
- 只同步扩展名白名单内的文件（pdf/docx/md/html/图片/office 等），其余忽略；空文件以路径占位避免旧正文残留（`connector.go:382-395,405-424`）。
- Token 权限：官方 PAT 文档确认支持自建实例与 PAT，但本轮未查到明确列出文件/compare 所需 scope 的权威表述；实施前按目标 GitLab 版本核对 `read_api`/`read_repository`，不凭记忆下结论。

## 5. PACE 必需与后续可选

**首批建议覆盖（飞书/GitLab已确认必需，细分内容边界待契约固定；Feeds暂按订阅源）**
1. 四个源类型：飞书 Wiki、飞书 Drive、GitLab、RSS/Atom/JSON；飞书与 Lark 国际版共用内核但凭据与域名分开，首批至少飞书中国站。
2. 每源显式范围选择器；服务端校验范围非空，权限校验分「凭据可用」与「资源可读」两步。
3. 凭证加密存储、按源隔离；连接测试、错误分类（鉴权/权限/限流/超时/不存在）与同步日志。
4. 增量游标、首次全量、手动触发+定时；失败条目不推进游标，支持重试与断点恢复。
5. 源 ID 身份、原始链接、层级/目录映射、重名与移动处理、删除传播策略。
6. 同步完成后的解析、索引与引用可用性；Wiki 更新依赖稳定的内容版本。

**后续可选（不在首批承诺）**
GitLab tag 的额外验证、飞书画板导出增强、Lark 国际站、其他连接器（Notion/Confluence/语雀/Seafile 等）、Webhook 实时同步、增量元数据（GitLab 文件提交时间当前未取，参考实现刻意留空）。

## 6. 同步语义约束（实现前必须建模）

- **游标**：每个源保留 `last_sync_cursor`（时间+连接器私有游标）与上次结果；飞书按节点/文件粒度记录变更键，流式每 50 项或 30 秒落检查点（`types/datasource.go:401-411`；`core/shared.go:42`；`10-datasource.md:136-137`）。抓取失败保留旧键，避免被永久跳过（`core/engine.go:139-160`）。
- **源 ID ≠ 标题**：RSS 的 GUID 作用域到 feed，GitLab 的身份含 base/project/ref/path，飞书用 token；重名文件在不同路径共存是正确行为，不能按文件名合并（`rss/types.go:225-229`；`gitlab/connector.go:423-427`）。
- **权限不足 / 授权撤销 / 源删除不同**：网络失败或列举不全不得推断批量删除；已确认权限撤销应停用源、限制相关内容的新检索与原文访问，并提示重授权。原始记录保留与物理删除是另一决策，不以停用等同删除。源码关于列举不完整时暂缓删除见 `core/engine.go:217-237`、`feishu/drive/paths.go:116`；PACE的停用传播为待实现设计，需涵盖Wiki摘录与最近权限检查时间。
- **RSS 淘汰不等于删除**：feed 只保留最近窗口，条目自然滚出不得删除已入库知识；参考实现明确不发出删除（`rss/connector.go:128-131`；`rss/types.go:15-18`）。PACE 若要做「手动清理源」必须与同步删除分开。
- **重名与更新**：同一源 ID 的标题/正文变化按更新处理；目录改名/移动在飞书 Wiki 由路径指纹识别，Drive 文件夹改名增量不感知、需全量刷新（`10-datasource.md:115-120`）。PACE 首版可只承诺「全量刷新修正层级」，不承诺 Drive 改名即时跟随。
- **手改与源冲突**：参考只有 `overwrite`/`skip` 两种策略（`types/datasource.go:64-66`），`skip` 会连正常更新一起丢弃。PACE 需在 UI 明确策略语义，至少在覆盖手改前保留可见提示或版本，不能静默丢失人工编辑；具体模型留到接口设计。
- **原始链接与层级**：保存原始 URL（飞书 wiki/drive 链接、GitLab blob URL、feed 条目链接）与目录路径，回答引用可回源；层级由源树/路径重建，不靠标题猜测。
- **同步后依赖**：入库→解析→切块→索引是异步链，同步成功不代表可检索；Wiki/引用必须在对应内容版本索引就绪后才更新可见，失败要可定位重跑。
- **不承诺**：本轮未运行任何源，不给出同步吞吐、时延或「实时」指标；飞书真实表/附件的解析质量、GitLab 大仓 compare 行为均待 M0 样本验证。
