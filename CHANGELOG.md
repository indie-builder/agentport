# Changelog

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
