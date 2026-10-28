# Changelog

## [Unreleased]

### 智能体能力

- 接入原生 `TodoWrite` 任务清单：运行配置与专家包可移植启用，成功快照贯通 SSE、消息保存、历史恢复与按轮展示；停止/失败不改写步骤状态。
- 会话成果：原生 Read/Write/Edit 写入独立 `/mnt/outputs` 草稿，每轮发布不可变文件快照；成果面板支持版本选择、Markdown/源码预览、下载与“基于此版本修改”，分支按历史边界复制，停止后保留已写文件；不新增成果表或云存储服务。

## [0.14.0] - 2026-10-25

### 技术栈升级与重复机制收敛

- 直接依赖升到当前 stable：Claude Agent SDK 0.3.310、MCP client/server 2.4.0（node 2.1.2）、BullMQ 6.4.2、Effect 4.0.6、Vite 8.3.5、jsdom 30.1.3、Biome 2.6.3、pnpm 12.15.0 等；共享版本收进 pnpm Catalogs，沙盒独立镜像清单/锁同步
- `@scalar` 与 `@biomejs` 只对 scope 走官方 registry（npmmirror 传递依赖滞后）；Biome 新版 `noComponentHookFactories` 只对测试目录关闭

### 原生能力替代自研机制

- 会话上下文改用 SDK 原生 `resume`/`forkSession`：transcript 按 conversation 持久化到 `sdk-sessions/`，删除文本历史拼接；分支复制来源 transcript 并按 fork 点截断，缺失时明确失败
- 子智能体 MCP 改为官方 `mcpServers` 名称引用；新增运行时工具边界 hook，父/子只用自己的 server 与技能；`run_in_background` 提示改为官方环境变量约束
- SSE 跟随改用 `XREAD BLOCK`，删除事件 pub/sub 唤醒与 2 秒补轮询；慢客户端被 MAXLEN 裁剪时静默丢事件记为已知限制
- stdio 连接测试移入沙盒：独立 `sandbox-probes` 队列、无模型凭证、超时销毁；API 主机不再启动用户进程

### 数据与文件

- 迁移 0032：`conversations.sdk_session_id`、`fork_from_sdk_message_uuid`、`messages.sdk_message_uuid`
- 专家包改为官方 `.claude/` 目录 ZIP；删除 `agent@1/@2` 与 `serializeAgentPackage`；平台元数据放根 sidecar，不复制正文；导入前校验条目数、解压字节、路径与链接
- 备份改为单个 `tar.gz`（一致性 pg_dump + 持久工作区 + env + manifest），恢复单事务整库替换、文件先暂存后换入；可选 restic 推送/保留/校验，失败保留本地包

### 前端

- 专家/技能表单收敛为 React Hook Form 唯一数据源，删除双写、手动错误搬运与 JSON dirty 比较
- CodeMirror 6 按需加载的 `SourceEditor` 接入记忆、规则、输出风格、技能正文、支持文件与工具 inputSchema
- 删除 localStorage 会话索引与旧接口兼容分支；Query 取消信号接到 `fetch`；市场搜索 300ms 防抖
- 概览查询由 6 条 SQL 合并为 3 条

### 修复

- worker 在宿主机直跑时模型代理错误地把上游 loopback 改写成 `host.docker.internal`，导致 `pnpm dev` 下模型请求全部失败；现在仅 worker 自身在容器内时改写

## [0.13.1] - 2026-10-24

### 文档剪枝与单一真相收敛

- 删除 `docs/README.md` 中关于 `docs/tasks/` 目录「目前无任务时为空」的过期描述
- `CLAUDE.md` 的 E2E 行去掉固定版本号（版本以 `package.json` 为准，属环境而非规则）
- `CAPABILITY-GAP.md`、`HANDOFF.md` 顶部标注为只读历史，未完成项统一以 `REMAINING-TODOS.md` 为准

## [0.13.0] - 2026-10-21

### 前端技术栈对齐

- 手写控件全部换成项目指定的库：浮层/对话框/下拉用 shadcn/ui + Radix，图标统一走 lucide provider，类名合一走 `cn`，客户端状态与服务端数据分别交给 Zustand / TanStack Query
- 页面骨架统一到 `Page` / `PageHeader` / `PageToolbar` / `PageSection`；移除页面级硬编码外边距
- 设计令牌收进 `styles.css` 的 `@theme`，组件里不再出现硬编码十六进制色值与任意圆角

### 设计系统按实测校正

- 以 https://www.openui.com/chat?form_factor=desktop 为唯一基准，用 CDP 读取计算样式后修正：外壳 16px 圆角 / 4px 外边距、建议卡 16px 圆角、侧栏 272px 展开 / 68px 收起（抽屉 294px）、空态两行均 24px
- `docs/DESIGN-SYSTEM.md` 与实现对齐，包括对话页真实文案与侧栏尺寸

### 技术栈合规循环 第 1–2 轮

- 第 1 轮：30 项真违规 + 22 项次要。登录改为 zod schema；`agent_runs.model_token_hash` 补部分索引；Redis 流协议抽到 `@agentport/shared/run-stream.ts`，producer 与 runner-client 共用；sandbox 镜像打包 `@agentport/shared`（此前运行时会 `ERR_MODULE_NOT_FOUND`）；6 个裸 `<button>`、33 处任意圆角、16 处冗余 `strokeWidth` 收敛
- 第 2 轮：12 项真违规 + 12 项次要 + 8 个测试缺口。API producer 补齐 shared 流常量并加契约测试；修复概览页智能体链接嵌在 `disabled` 按钮里点不动；8 处无焦点环的 `focus-visible:outline-none` 删除；`writeAudit` 增加 `dedupeKey`（worker 传 `aud_<runId>` + `onConflictDoNothing`），基础设施重试不再写重复审计行
- 测试从 139 增至 162 项；biome 154 文件全绿

### 运行期加固（同批并行改动）

- **限流覆盖全部路由**：`plugins/security.ts` 增加 `global: true` 的 600/min 桶；`/health/metrics` 改挂 `requireAuth`
- **API 优雅关停**：先关闭队列 producer 与 SSE 订阅，再 `app.close()`，与超时竞速后强制关闭残留 socket；compose 增加 `stop_grace_period: 30s`
- **worker 退出时清扫遗留工作区目录**；孤儿 run 仍由 reconciler 收敛

## [0.12.0] - 2026-10-21

- 设计基准改为 https://www.openui.com/chat?form_factor=desktop，规范与实测值写入 `docs/DESIGN-SYSTEM.md`
- 通过 ego-browser（CDP）读取参考页计算样式：外壳 16px 圆角、4px 外边距、输入胶囊 56px 高 / 28px 圆角 / 双层阴影、两行标题均 24px
- 全站改为无彩度体系（黑白灰），移除品牌色；强调靠实底黑与透明度
- 外壳重写为 16px 圆角白色容器；侧栏改为白底 272px（收起 68px，移动端抽屉 294px），选中态为浅灰底
- 对话页重写：24px 问候语 + 胶囊输入 + 建议卡，会话列表移入白底侧栏
- 智能体 / Servers / 运行详情 / 运行 / 审计 / 健康 / 评估 / 技能 全部按新语言重排
- shadcn CLI 真正接入（`components.json` + `tsconfig` 路径别名 + vite alias），新增 sheet/scroll-area/separator/tooltip/dropdown-menu
- 字体换成 Inter + JetBrains Mono；图标统一 lucide 1.75
- 项目规则新增设计基准与无彩度约束

## [0.11.0] - 2026-10-21

- 对话页按新交互模型重写：状态条、单行工具、子智能体分组、原位审批、失败后恢复路径
- 智能体页改为分区编辑器 + 吸顶分区导航，每个字段标注落盘目标（`→ CLAUDE.md` / `仅运行时`）
- Server 页改为表格 + 来源筛选；工具定义可原位编辑，删除前列出受影响的智能体
- 后端：工具 PATCH 支持全字段编辑（此前只有 enabled/requiresApproval）
- 预览与落盘共用 `@agentport/core/workspace`，删除 web 内的重复渲染实现
- core 新增 `./workspace`、`./tools` 纯函数子路径，浏览器可直接引用
- 修复 web 引入 core 后 `node:crypto` 导致的白屏
- 新增 `docs/UI-REDESIGN.md`；项目规则新增多智能体并行

## [0.10.0] - 2026-10-20

- 第三次视觉重做：从「暖纸」换成「校准台」——冷中性、1px 分区线、2px 半径、IBM Plex
- 信号橙 `#C2410C` 成为全屏唯一高饱和色，只表示「正在发生」
- 工作台首屏改为「需要处理」（失败/超时运行），替代四张同款统计卡；新增 40 次运行刻度带
- 运行详情改为主从结构：步骤树带归一化时长条，检查器把参数与结果分开
- `tool_use` / `tool_result` 在 repo 层合并为一步（此前显示为两条同名步骤）
- 导航按任务分组（使用 / 构建 / 系统），概览更名工作台
- 技能、评估、健康页从卡片改为通栏分区
- 字号与代码高亮色收进 `@theme` 令牌，移除硬编码十六进制
- 新增 `docs/UI-REDESIGN.md` 记录诊断、架构与交互决策
- 项目规则新增「任务执行尽量使用多智能体并行」

## [0.9.0] - 2026-10-20

- 交互原语换成 shadcn/ui + Radix：`Dialog`、`Tabs`、`Select`、`Popover`（MultiSelect）
- 新增 `components.json`，声明 shadcn 配置，后续组件用 `shadcn add` 生成
- 新增页面骨架 `Page` / `PageHeader` / `PageToolbar` / `PageSection`，统一 20px / 32px 节奏
- 8 个页面改用骨架，移除各自的 `mb-3` / `mb-5` / `mt-8` 硬编码外边距
- 侧栏导航按「构建 / 运行 / 治理」分组，概览独立置顶
- 内容容器加宽到 1360px，页头下边距 32px → 24px，提升 Dashboard 信息密度
- 修复 MultiSelect 浮层被卡片 `overflow` 裁切（改 Radix Popover portal）
- 修复 Radix Select 把空字符串当未选中，导致「全部状态」显示为「请选择」
- 卡片内边距统一 `p-4`；移除各页 `CardContent` 的 padding 覆盖
- `docs/DESIGN-SYSTEM.md` 增加组件来源与页面骨架两节；`CLAUDE.md` 同步规则

## [0.8.0] - 2026-10-20

- 前端整体重做为浅色唯一主题：暖纸 + 墨 + 深青，令牌集中在 `styles.css`
- 概览首屏的四张同款指标卡改为一条横向账本，按「规模 → 活动 → 成本」阅读
- 登录页改为两栏：左侧平台事实，右侧表单；窄屏只保留表单
- 状态色改为成组令牌（`*-soft` / `*-line`），移除 `bg-*/5` 透明度近似
- 阴影收敛为 `shadow-panel` / `shadow-raised` / `shadow-overlay` 三档
- 代码高亮改用浅色底可读色，替换 Tailwind `*-300` 系列
- 输入框、标签、禁用按钮修正对比度（`text-fg` 标签，禁用态用 `bg-sunken` 而非半透明）
- 表格 ID 只显示 TypeID 后缀 8 位，避免前缀挤占宽度
- 智能体默认模型列表改为当前网关可用的 id（`group/flash` 等）
- `docs/DESIGN-SYSTEM.md` §3 与 D-14 同步

## [0.7.1] - 2026-10-20

- 修复：模型代理绑定随机端口，沙盒（默认 bridge）无法访问；改为固定 `MODEL_PROXY_PORT`（默认 3426）并发布到宿主回环
- 修复：worker 在容器里时 `ANTHROPIC_BASE_URL=127.0.0.1` 指向容器自身；启动时自动改写为 `host.docker.internal`
- 支持宿主机上的自建模型网关（实测 `127.0.0.1:3425`，`group/flash`）
- 测试隔离：`startApp()` 支持按实例覆盖配置，不再通过 `process.env` 影响并发文件
- `.env.example` 与 `docs/OPERATIONS.md` 补充本地网关配置说明

## [0.7.0] - 2026-10-20

- D-17 模型凭证代理：worker 起回环代理，沙盒只拿按 run 的短期 token；真实模型凭证不再进容器 env
- D-18 工具审批改为挂起式暂停：未批准时调用挂起，批准后同一次调用继续并返回结果，不再要求模型重发
- D-19 会话间工具改为按配置放行：`ListAgents` / `SendMessage` 可由智能体显式启用，`Monitor` / `EndConversation` 永久关闭
- D-20 权限模式开放 `default` 与 `acceptEdits`；`auto` 仍拒绝
- 新增 `agent_runs.model_token_hash`；新增 `APPROVAL_WAIT_MS`（默认 300s）
- 真实运行验证：容器 env 无真实密钥、审批挂起 16s 后同一次调用完成

## [0.6.1] - 2026-10-20

- D-16 已决定：单机自用继续直接挂载 docker.sock，不做 socket proxy
- 在 `docs/DECISIONS-PENDING.md` 写明升级触发条件（不受信内容 / 多用户 / 共用机器 / 导入第三方定义）与 B→C→D 路径
- `docker-compose.yml`、`docs/OPERATIONS.md`、`docs/SECURITY.md` 同步该决定

## [0.6.0] - 2026-10-20

- 工作区 Markdown 显式写出「等待规则」：平台的智能体沟通是同步调用，调用方必须等到被调用方返回
- `CLAUDE.md` 新增子智能体表格（slug / 适用场景 / 超时），超时取自 `agents.timeout_ms`
- 子智能体 md 写明「你是被父智能体同步调用的」与等待上限
- `Agent` 委派改为 MD 内硬约束 `run_in_background: false`：SDK 默认后台运行，会让父智能体在结果返回前结束本轮
- 默认禁用会话间消息工具 `ListAgents` / `SendMessage` / `SendUserMessage` / `EndConversation` / `Monitor`，与同步等待模型保持一致
- 真实模型验证：父智能体按 MD 传入 `run_in_background: false`，等待子智能体返回后输出完整结果（2 turns）

## [0.5.0] - 2026-10-20

- 新增异常管理标准：`docs/ERRORS.md`（引用 RFC 9457、NestJS Exception Filters、Spring `ErrorResponse`、Google AIP-193、BullMQ `UnrecoverableError`）
- 错误响应对齐 RFC 9457：`{ code, message, status, requestId, retryable, path?, errors? }`
- `packages/shared/src/errors.ts`：稳定 `errorCode` 表（code → HTTP 状态），加新码是兼容变更
- `packages/core/src/errors.ts`：`AppError` / `fail()`，业务层不再手写 `statusCode`
- 迁移全部 25 处内联错误响应与 10 处 `Object.assign(new Error(), { statusCode, code })`
- 框架错误统一映射：非法 JSON → 400，body 超限 → 413，媒体类型错误 → 415，限流 → 429 Problem
- 沙盒 `run_finished` 增加 `failureKind`（agent/infra/cancelled），落库为 `agent_runs.error_kind`；
  runner 顶层捕获未处理异常，不再「静默退出、没有终态」
- 取消订阅失败改为 `infra` 失败并交给 BullMQ 重试，而不是启动一个停不掉的容器
- API 与 worker 安装进程级兜底：`uncaughtException` / `unhandledRejection` 记录后退出
- reconciler 的 stop 等待在跑的 tick 结束，避免关停时与写事件撞车
- 前端 `ApiError` 解析 Problem，`errorMessage()` 按 `code` 分支（如 `CONFLICT_STALE` 提示刷新）

## [0.4.0] - 2026-10-20

- 引入 `effect@4.0.5`，新增 `packages/core/src/effect-runtime.ts`：`Clock`/`Db`/`Redis`/`Sandbox` 四个服务、`RunFailure` 分类、`runProgram`、`withTimeout`
- `runner-client` 重写为 Effect program：容器生命周期由 Scope 保证，取消/超时/退出用 `raceAll` 统一，`isRetryable` 改看 `RunFailure.reason` 而非匹配错误文本
- `eval-runner` 用 `Effect.forEach` + `Effect.result` 做逐条失败隔离；`reconcile` 的收敛 UPDATE 加指数退避重试
- `test-connection` 用 `acquireRelease` 保证 MCP client 在超时路径上也关闭
- 新增 `docs/EFFECT.md`；测试 122 项通过，真实沙盒验证成功/取消/超时三条路径
- `biome.json` 排除 `.agents` 与 `dist`，避免第三方技能资源污染 lint

## [0.3.0] - 2026-10-20

- Fastify × Zod 重构：所有路由改用 `schema` 声明校验，移除 39 处 `safeParse`
- `plugins/errors.ts` 统一映射 zod 校验失败与响应序列化失败
- 新增 `types.ts` 的 `typed(app)`，路由内获得推导后的 `request.body/params/query`
- 新增 `docs/VALIDATION.md` 记录设计原则

## [0.2.1] - 2026-10-20

- 完成 e2e 迁移：聊天步骤改用 `agent.waitFor`，配置 `agents.default`（OpenAI-compatible 复用 Anthropic 代理）
- 移除 `@playwright/test`、`playwright.config.ts` 与 `e2e/**` 旧套件
- CI 只运行 e2e；失败时上传 `.e2e/results/`
- `MIGRATION.md` 标记所有条目为 retired，迁移完成

## [0.2.0] - 2026-10-20

- E2E 技术栈迁移到 `e2e`（`e2e@0.21.2` + `@e2e-dev/web@0.15.2`）
- 新增 `e2e.config.ts`、`tests/**/*.e2e.ts`、`test.setup` 登录会话
- `pnpm test:e2e` 指向 e2e；Playwright 套件已退役
- CI 同时运行两套，失败时上传 `.e2e/results/`
- 迁移进度记录在 `MIGRATION.md`

## [0.1.1] - 2026-10-20

- 修复：刷新后工具卡片与结果错配（worker 用 `toolUseId`，前端只认 `tool_use_id`）
- 修复：首次部署时 smoke 直接调用 `tools/list` 得到 `-32601`，改为先 `initialize`
- 修复：`docker compose down -v` 后工作区卷归 root，`up.sh` 自动 chown 到 1000
- 部署提示：未配置模型凭据时明确告知「平台可用但对话会失败」
- 测试产物（`test-results/`、`playwright-report/`）移出版本控制

所有对外可见的变更记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 [SemVer](https://semver.org/)。

## [0.1.0] - 2026-10-20

首个可用版本。按开发循环记录主要能力，一条一行；详细证据见 [docs/CAPABILITY-GAP.md](docs/CAPABILITY-GAP.md)、[docs/SECURITY.md](docs/SECURITY.md) 与 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

### Added

- 循环 0：仓库骨架、pnpm workspace、Postgres 18/Redis 8 compose、pino 日志、`/health/live` 与 `/health/ready`、首个 Drizzle 迁移
- 循环 1：MCP 三源接入（stdio / 远程 HTTP / HTTP API 转 MCP）、连接测试、AES-256-GCM 密钥加密、单管理员 JWT、文件定义智能体、Docker 沙盒、BullMQ + SSE 运行链路、TypeID
- 循环 2：技能、权限与工具策略、assistant/tool 消息落库、token/延迟指标、版本历史与回滚、审计页、平台 → MCP（`POST /mcp`）、队列重试与错误分类
- 循环 3：工具级启用/禁用、评估用例与回归跑批、智能体导出、`pnpm backup`、运行完成审计
- 循环 4：子智能体单层委派、数据保留任务、`/health/metrics`、E2E 回归、概览页健康卡片
- 循环 5：会话上下文注入（最近 20 条）、会话分支、智能体导入、可访问性与 1280/1024/768/390 响应式收口、空态与错误文案
- 循环 6：部署可移植（命名卷 + `HOST_WORKSPACES_DIR`）、`pnpm smoke` 自检、工具审批最小闭环、禁用智能体 409、文档一致性修正
- 循环 7：对抗性安全审查（1 Critical + 11 High）、9 条失败路径测试、性能索引、会话列表瘦身、SSE 引用计数修复
- 循环 8：预览脱敏、结构化审批表、日志与落库脱敏、沙盒/事件输出上限、导入 SSRF 校验与审计补齐、环境变量强度校验
- 循环 9：限流、CSP、可吊销会话、CORS/`TRUST_PROXY`、乐观锁、外键、`SANDBOX_EGRESS` 默认 proxy、读/写/SSE/MCP/队列压测基线与第一瓶颈结论
- 循环 10：按 run 隔离工作区、`tool_use` 与 `tool_result` 一并落库、Redis 健康检查修复
- 循环 11：取消 SIGTERM → SIGKILL 升级、孤儿 run 收敛、Server URL 私网校验、审批跨 run 继承、权限模式诚实化（仅 `dontAsk` / `plan`）
- 循环 12：预览与运行时共用 `workspace-input`、generated server token 轮换、`pnpm run up` 一条命令部署
- 循环 13：按 run 签发的短期 MCP token（DB 只存 sha256，run 结束清空）、工作区目录 0700 / 文件 0600、评估跑批移入 `eval-runs` 队列并收敛超时 running、SSE 每连接独立 Redis 订阅
- 循环 14：子智能体真实端到端验证与三处修复（零工具拒绝、SSE 事件重复、父智能体自我递归）、`allowedTools` / `maxThinkingTokens` 编辑、运行详情重跑、技能使用数、`pnpm restore` 与恢复演练
- 循环 15：子智能体调用归属（`parentToolUseId`）、CI 增加 E2E 与镜像构建 job、`v*` tag 触发 GHCR 发布（`api` / `sandbox`）、[docs/RUNBOOK.md](docs/RUNBOOK.md)、系统状态页 `/status`
