# Changelog

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
