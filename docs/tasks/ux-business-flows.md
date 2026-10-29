# 全站用户故事、交互与 UI 统一调整

## 目标
按完整业务路径检查所有页面，修复可复现的交互阻塞、状态缺口和跨页面不一致；保持现有能力与官方文件定义契约。

## 方案
以 docs/USER-STORIES.md 与 docs/DESIGN-SYSTEM.md 为准，使用 interfaces 六项 UI 技能。Opus 并行审查不同业务域，固定改动边界后由 Sonnet 执行，最后独立 Opus 评审。浏览器覆盖真实页面、窗口伸缩和关键操作，源代码/测试覆盖不便安全触发的错误分支。

## 基线与范围
- 工作树：/Users/xbjt/Documents/myself/agentport/.claude/worktrees/ux-business-flows
- 分支：worktree-ux-business-flows
- 起点：origin/main 64767cddbf4b34242a4439e475c78297cb448993
- 初始差异：无。
- 范围：全部前端路由、对应组件与行为测试；必要的设计规范与用户故事同步。后端/数据库只在确认业务阻塞且前端无法解决时扩展。

## 当前有效决定
- 用户已要求整体检查并直接统一修复，授权实现；尚未授权 commit/push/merge。
- 仅桌面，保留窗口缩放与无障碍；不新增移动端方案、不更换视觉体系。
- 主会话不编辑代码，独立文件域单一写入者。
- 服务不改用户的默认登录凭据，不启动第二套共享 compose。

## 已替代项及原因
无。

## 步骤
- [x] 读取研发流程、踩坑、设计规范和用户故事；加载工程与 UI 审查技能。
- [x] 获取最新 origin/main 并创建干净工作树。
- [x] 并行审查全部页面与业务链路，形成有证据的统一问题清单。
- [x] 按文件域并行修复，补必要的行为测试；审查发现的收尾分支继续定向整改。
- [x] 浏览器验收与范围内类型、测试、构建检查。
- [x] 独立 Opus 评审并修复发现；最终 A/B 补丁终审通过、无阻塞。

## 改动文件
按单一写入者分组：
- 运行环境：pages/runtime-environments.tsx、runtime-environment-detail.tsx 与行为测试。
- 专家：pages/agents.tsx、lib/queries.ts 的 useDeleteAgent 与专家测试。
- 技能：pages/skills.tsx 与支持文件测试。
- 连接器：pages/servers.tsx 与试连测试。
- 知识：pages/knowledge.tsx、knowledge-detail.tsx、components/knowledge-settings.tsx、lib/api.ts 的单任务读取、lib/queries.ts 的 job key 与知识测试。
- 运行统计：shared/src/ops.ts 的 UTC 自然日窗口、db/src/repo/ops.ts 的 UTC 分组、api/features/ops/routes.ts、web/pages/ops.tsx 与统计测试。
- 插件及资源导航：pages/plugins.tsx、plugin-detail.tsx、components/resource-page.tsx 与对应测试。
- 对话/运行：pages/chat.tsx、run-detail.tsx、runs.tsx 与对应测试。
- 定时：pages/ops.tsx 与对应测试。
- 评估/URL契约：pages/eval.tsx、routes/-search.ts 与对应测试；search 文件只由评估执行者写。
- 登录恢复：components/app-shell.tsx、lib/api.ts、pages/login.tsx、routes/login.tsx 与对应测试。
- 概览健康：pages/overview.tsx、status.tsx 与必要已有 lib 状态逻辑和测试。

## 确认问题与执行契约
1. 运行环境创建 Esc 丢稿（浏览器复现）；补 dirty/pending，版本同时展示失败原因/日志/Dockerfile，删除成功解除旧草稿拦截。
2. 技能支持文件可写不可读改、删除无确认，正文保存会丢文件草稿；使用现有 SourceEditor 与 PUT 补完整闭环。
3. 专家同路由任务历史切换绕过草稿保护；删除乐观缓存卸载编辑器；回滚漏环境差异；创建模型不支持自定义；辅助请求缺恢复。
4. stdio 重新测试误用其他连接器最近环境；统一显式环境选择。
5. 知识表单及上传任务生命周期保护缺口、查询状态混淆、校验无字段反馈、同步结束摘要未刷新、导入后缺打开入口。
6. 插件安装/导入后缺阅读入口，无 README 缺下一步；资源跨路由导航改真实 nav/Link，保留外观。
7. 已有对话隐藏历史时缺当前专家入口，管理弹层缺离开保护，澄清查询失败缺重试；运行详情补回原会话与筛选列表。
8. 定时任务启停串行锁与版本冲突显式重新加载；评估 URL 恢复结果/比较并明确未完成数量。
9. 登录保留站内 returnTo 与过期原因；概览健康统一队列判断，保留旧值时明确刷新失败。
- URL 共享契约：runDetailSearch 增加 fromAgent/fromStatus（值与运行列表 agent/status 一致）；evalSearch 增加 run/base/head，比较状态由 base/head 表达。仅评估执行者修改 routes/-search.ts；运行执行者直接消费契约。
- 头部专家选择只在历史隐藏时显示，避免重复入口；保留短标题/更多/成果与现有切换语义。

## 下一步
改动与验证已完成，未获授权提交；等待用户决定是否提交/合并。当前工作树保留供预览。

## 运行记录
- 根目录：本工作树；commit：64767cd；配置：本工作树 .env（复制自主 checkout 的 .env）；预览：https://worktree-ux-business-flows.agentport.localhost。
- API 初次使用根配置，应用现有迁移后专家列表恢复；未修改schema或迁移。
- 旧会话文件在共享 Docker volume，宿主API不能读取；复制 /workspaces 只读快照到本树 data/workspaces，API 以绝对 WORKSPACES_DIR 指向快照用于历史阅读验收，未修改默认配置/原文件。真实模型运行不使用此快照作为端到端证据。

## 验证
- 第二轮完整回归：1211 用例，1205 通过、6 失败；仅 admin-errors/admin-pages 的评估旧 renderExpanded mock，已派发按 URL 结果契约同步，保留错误/输出断言。
- 最终完整前端回归：107 个测试文件、1231 项全部通过，0 失败、0 跳过（`bbc28z6i3`）；共享窗口测试 3/3、运维路由 9/9、知识详情 108/108 也分别通过。
- 最终构建：shared/db/api/web 全部 exit 0（`bonz3v6it`）；shared/db/api/web typecheck 均通过；全部改动源码/测试 `biome check` 通过。
- 统计口径已统一：API `since`、DB UTC 分组与前端 30 天补天共用 `utcWindowStart`/`recentUtcDays`，不再出现指标有运行而图中缺失。
- 专家运行统计图实测：30 天日期轴、单日正常窄柱、离屏表 30 行、无 `role=application`、视觉层无可 Tab 聚焦元素；页面无溢出。
- 最终收尾阶段 `pnpm --filter @agentport/web typecheck`：通过（b9v7seff5）。之前组合构建命令 exit0 只代表最后 build 成功，当时 typecheck 曾碰到知识域未完成引用；不以组合退出码冒充两项全过。
- 知识库按不存在关键词搜索只显示「没有匹配的知识库」与「清除搜索」，点击恢复原列表；未混显真空/加载状态。
- `pnpm lint:focus`、`pnpm lint:contract`：通过。
- 前端类型与生产构建已通过一轮（并行收尾后再复核最终范围）。
- 首次全 web 回归：1200 用例，1180 通过、20 失败；其中知识域仍处在红绿实现阶段，健康阈值测试处在更新中，专家按需文件测试的导航 mock 已改真实 Router，最终会整套复跑。
- 浏览器真实登录、资源创建表单、专家详情→对话→历史、运行列表筛选→详情→原会话、插件无 README→内容、成果阅读/下载均已操作。
- 下载周报 453 B，SHA-256 `5fabb7744da70bf0531bf0557a496e285ce93e8bd83df792937ec218930fa575`，正文含本周完成/下周计划。
- 实测常规 1512px、窄桌面 1024px 无页面横溢出；成果栏宽 320px；1024px 对话专家选择 x=368/w=176/h=32，会话操作 x=684/w=28，成果入口 x=912/w=92/h=32，均可见。756×419 下审计/运行表格宽 824/1096，均在 718px 容器内横向滚动，文档宽度仍为 756；运行环境复杂表单弹层高 335，内部内容区独立滚动，关闭/取消/创建可达。
- 实测文字颜色：次要文字 `rgb(102,102,102)` / 表面 `rgb(253,253,253)` 对比度 5.64:1，导航背景 `rgb(245,245,245)` 对比度 5.27:1；主文字 / 表面对比度 17.62:1；警告 `#8a5600` 6.05:1、失败 `#b42318` 6.46:1、成功 `#187646` 5.55:1。仅覆盖抽样配色，非整页自动 WCAG 认证。
- 全部 19 条 shell 叶路由（含动态详情、404）在 1512px 逐页断言单一 h1，未出现文档级横溢出；知识库首页在 250ms 采样时仍在加载，不作为终态。
- 浏览器 AX 树抽查连接器页未发现无名交互控件；Tab 焦点有 2px `rgb(138,138,138)` outline；reduce motion 仿真无活动动画。
- 知识来源空提交能列出名称/凭据/仓库字段错误，与 aria-invalid/describedby 关联，后续焦点进入 source-name。
- 运行环境创建通过应用内导航后浏览器后退会确认；取消后 URL 与原草稿恢复。用 goto 跨文档导航的第一次尝试不作为 SPA blocker 验收证据。
- 基线访问 http://agentport.localhost 返回 Portless 未注册；仅存在旧 qoder 工作树地址，不作为最新基线的验收来源。
- 测试先行：真实行为适用时先红后绿；纯视觉以渲染和实际几何为证，不编造样式快照测试。

## UI 技能审查结果

范围为全部 19 条 shell 叶路由、登录与共享骨架；源码审查覆盖六个 UI 领域，浏览器按主流程与代表状态操作，未声称逐个执行所有破坏性动作。

| 领域 | 已检查证据 | 结果 |
| --- | --- | --- |
| Accessibility | ResourcePage 导航、表单标签/错误关联、AX 树抽样、Tab 焦点、减少动效 | 修复路由 Tabs 语义与错误关联；真实读屏未验证 |
| Layout | Page/ResourcePage、专家详情、聊天头部、成果/插件阅读器、列表表格、1512/1024/756 窗口 | 保留既有布局；实测代表页面无整页横溢出，表格容器内滚动；原生缩放未验证 |
| Writing | 空态/失败恢复、取消评估、来源风险、健康状态、导入结果 | 修正误导或无下一步文案；保留安全/约束说明 |
| Typography | 计算字号/行高、头部截断、完整文件路径、阅读正文 | 复用既有令牌；长路径可完整阅读，不更换字体 |
| Colors | 实测主/次文字与背景配色、健康 warning/danger 语义 | 抽样对比度通过；修正 warning 原因色，不另造配色 |
| UI | 共享控件规格、弹层滚动、pending/关闭、图标与 reduced-motion | 复用现有组件，焦点和项目契约检查通过 |

按影响合并的根因（同一根因不逐页重复）：

| 严重度 | 领域 | 位置 | 修改前 | 修改后 | 用户影响 |
| --- | --- | --- | --- | --- | --- |
| HIGH | Accessibility | `components/resource-page.tsx:59` | 路由链接伪 Tabs，方向键选择不导航 | nav/Link + aria-current | 键盘与链接操作一致 |
| HIGH | UI | `pages/runtime-environments.tsx:191`、知识/插件/聊天表单 | 关闭/路由/刷新生命周期保护不完整 | 同一 dirty/pending 与确认路径 | 防止未保存内容丢失 |
| HIGH | UI | `pages/agents.tsx`、`lib/queries.ts:923` | 删除在途先移缓存，编辑器卸载 | 服务端成功后更新缓存，pending/失败保稿 | 删除失败可继续编辑 |
| HIGH | UI | `pages/skills.tsx:674` | 正文保存丢文件草稿，支持文件不可读改 | 独立保存与版本基线、文件选择编辑、删除确认、刷新失败禁旧内容 | 文件维护形成闭环 |
| HIGH | Writing | `pages/knowledge.tsx`、`knowledge-detail.tsx`、`knowledge-settings.tsx` | 请求失败/禁用查询与真空态混淆 | 加载、错误、成功空/筛选空互斥并可恢复 | 不误导重复创建/上传 |
| HIGH | Accessibility | 知识建库/来源/设置字段 | 超限无反馈、ready 禁止提交无修正入口 | 就地 FieldError + aria-invalid/describedby + 首错聚焦 | 能知道并修正输入 |
| MEDIUM | UI | `pages/chat.tsx`、`pages/run-detail.tsx` | 已有对话缺直接选专家，运行详情无回原会话 | 当前专家入口与原会话链接、筛选返回 | 连续工作不必重找上下文 |
| HIGH | Writing | `pages/chat.tsx`、`run-detail.tsx` | 澄清问题请求失败无提示 | 就地错误/重试，保留原问题和停止 | 等待任务有恢复路径 |
| MEDIUM | UI | `pages/servers.tsx:587` | stdio 重测误用另一连接器环境 | 每次确认、预选该连接器上次环境、缺失/失败明确反馈 | 测试对象可核对 |
| MEDIUM | Writing | `runtime-environment-detail.tsx`、`agents.tsx` | 日志遮错误、版本不可看快照、回滚漏环境 | error/log/Dockerfile 独立可读，环境加入差异 | 发布回滚前能判断变化 |
| HIGH | UI | `pages/ops.tsx:386` | 一份 pending 多行请求、冲突无重载 | 串行锁、显式重新加载/已删另存 | 状态一致且草稿可恢复 |
| MEDIUM | UI | `pages/eval.tsx:567` | 结果比较本地状态、取消隐藏未记录范围 | URL run/base/head、记录数与当前可能执行说明 | 刷新/返回恢复任务且不误判结果 |
| MEDIUM | Writing | 插件/知识导入与插件详情 | 成功后无结果入口、无 README 只有空文字 | 使用返回 ID 打开详情/内容 | 成功后能继续阅读 |
| HIGH | UI | `pages/login.tsx`、`lib/auth-redirect.ts` | 登录丢深链，预检可能阻塞表单 | 非阻塞当次认证检查、站内 returnTo 与错误回退 | 登录后回到原任务 |
| MEDIUM | Colors | `lib/health.ts:14`、overview/status | 阈值/状态口径不同，警告用危险色 | 共用阈值10/判定与查询，旧值刷新失败可重试 | 首页与诊断不互相矛盾 |
| HIGH | UI | `pages/ops.tsx` 运行统计 | 后端只返回有运行的天，手写 flex-1 柱把单日画成整宽深色块；视觉层无可读数据替代 | 项目 Recharts 图表补最近 30 个 UTC 自然日、日期轴与 tooltip；视觉层对辅助技术隐藏，离屏 30 行数据表保留日期/次数/成本 | 统计图可读、可核对且不误导 |
| MEDIUM | UI | `knowledge-detail.tsx` 同步任务 | 任务被级联删除后 404 会永久按 2 秒轮询且无提示 | 404 停止跟踪并一次性说明；网络/5xx 保留恢复轮询 | 不再后台空转，用户知道来源可能已删除 |

## 文档冲突裁决
- USER-STORIES 的 Bash 全部禁用/仅记忆文件说明已落后于现有容器工具与成果/附件能力：按 ARCHITECTURE 和实际源码同步，不改工具权限。
- USER-STORIES 的概览最近20条与计数定义落后于当前设计/实现：改为最近6条与运行次数/成本/专家/连接器四卡。
- DESIGN-SYSTEM §1“已有消息不另设专家选择”与§6“已有消息仍可选择”矛盾：统一为历史隐藏时消息头选择、展开时历史头选择。
- 连接器目录“宿主执行”与实际沙盒试连矛盾：改准确沙盒文案并保留来源可信风险。
- DESIGN-SYSTEM 首页历史failed说明与唯一待处理入口冲突：明确保留计数仅诊断页解释，首页关注当前异常。

## 审查取舍与限制
- 技能支持文件现有 PUT 无版本字段，跨标签页最后写入生效；本轮未扩后端并发协议。保存后缓存刷新失败导致重选旧内容属当前可复现路径，已修。
- 专家 DELETE 服务端已成功后，若另一个额外 history blocker 拦住返回，缓存反映实体已删除并卸载编辑器；用户已明确确认删除，因此不再引入“已删除实体的草稿快照/重试导航”新状态。修复范围仍是 DELETE 在途与失败必须保稿、成功返回不被自身 blocker 拦截。
- 不把单元测试、源码审查或缩放等效窗口声称为真实读屏、原生200%缩放、真实模型/同步服务端到端验收。
- 同步任务被最近 50 条挤出时改用单任务查询；404 停止并提示，网络/5xx 继续恢复轮询。提示只走一次性 toast，错过后需刷新来源列表确认。
