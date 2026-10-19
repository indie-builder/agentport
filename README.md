# PACE

智能体平台：把 HTTP API 或 MCP 服务接进来，用文件定义智能体，在隔离沙盒里运行，并观测每一次调用。

- 产品名 **PACE**；仓库与包名使用 `agentport`。
- 单机优先，生产可用；技术栈全部为当前稳定版本。

## 能力

| 领域 | 能力 |
|---|---|
| MCP Server | stdio / 远程 HTTP / HTTP API 转 MCP 三种来源；连接测试；密钥加密与脱敏 |
| HTTP → MCP | 运行时挂载 `/mcp/:serverId`，标准端点，带 Bearer token，不生成代码 |
| 智能体定义 | `.mcp.json`、`CLAUDE.md`、`.claude/agents/*.md`、`.claude/skills/*/SKILL.md` |
| 配置项 | 提示词、模型、技能、MCP 绑定、权限模式、工具白名单/黑名单、effort、思考预算、轮次、预算、超时 |
| 运行 | BullMQ 队列 → Docker 沙盒 → Agent SDK → SSE 流式事件 |
| 对话 | 会话历史、持久化消息、取消、成本与轮次统计 |
| 治理 | JWT 登录、审计日志、Redis 限流、健康检查 |

## 架构

```
浏览器 ──HTTP/SSE──▶ api (Fastify)
                       ├─▶ PostgreSQL  配置 / 会话 / 消息 / 运行 / 审计
                       ├─▶ Redis       BullMQ + 事件流 + 限流
                       └─▶ /mcp/:id    动态 MCP 端点

worker ──队列──▶ 沙盒容器（Node + Agent SDK）
                    └─▶ 只读挂载 workspaces/<slug>/
                          ├─ .mcp.json
                          ├─ CLAUDE.md
                          └─ .claude/{agents,skills}/
```

分层：`shared` → `core` → `db` → `api` / `worker`；`web` 只依赖 `shared`。API 与 worker 不互相 import，只经 PostgreSQL / Redis 通信。

## 快速开始

```bash
pnpm install
cp .env.example .env          # 必填 APP_SECRET_KEY / JWT_SECRET / ADMIN_PASSWORD
docker compose up -d postgres redis
pnpm db:migrate
pnpm dev                      # api + worker + web
```

打开 http://localhost:5173，用 `.env` 里的 `ADMIN_USER` / `ADMIN_PASSWORD` 登录。

首次运行还需要构建沙盒镜像：

```bash
pnpm --filter @agentport/sandbox image
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | 是 | PostgreSQL 连接串 |
| `REDIS_URL` | 是 | Redis 连接串 |
| `APP_SECRET_KEY` | 是 | 密钥加密主密钥（≥16 字节） |
| `JWT_SECRET` | 是 | 会话签名密钥 |
| `ADMIN_USER` / `ADMIN_PASSWORD` | 是 | 唯一管理员账号 |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | 二选一 | 模型凭证，注入沙盒容器 |
| `ANTHROPIC_BASE_URL` | 否 | 自建网关；容器内会自动把 loopback 改写为 `host.docker.internal` |
| `SANDBOX_IMAGE` | 否 | 沙盒镜像，默认 `agentport/sandbox:dev` |
| `SANDBOX_NETWORK` | 否 | `open`（默认）/ `none` / `proxy` |
| `WORKSPACES_DIR` | 否 | 工作区根目录，默认 `./data/workspaces` |
| `SELF_URL` | 否 | 平台自身地址，用于 generated server 自测 |
| `AGENT_MAX_CONCURRENT` | 否 | worker 并发（默认 2） |

## 脚本

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 并行启动 api / worker / web |
| `pnpm -r typecheck` | 全量类型检查 |
| `pnpm -r build` | 全量构建 |
| `pnpm test` | Vitest 集成测试 |
| `pnpm test:e2e` | Playwright（设 `E2E_FULL=1` 跑完整对话链路） |
| `pnpm db:generate` / `pnpm db:migrate` | 生成 / 应用迁移 |
| `pnpm infra:up` / `infra:down` | 启停 postgres + redis |
| `pnpm lint` | Biome 检查 |

## 文档

- [用户故事](docs/USER-STORIES.md) — 验收依据
- [项目简报](docs/PROJECT-BRIEF.md) — 需求、选型、架构、决策记录
- [设计系统](docs/DESIGN-SYSTEM.md) — PACE 品牌、token、组件规范
- [实施契约](docs/IMPL-CONTRACTS.md) — 并行开发时的接口边界

## 安全

- 密钥 AES-256-GCM 加密入库，接口返回脱敏为 `••••`。
- SSRF 防护：生产拒绝私网地址，开发放行 localhost。
- 沙盒：只读根文件系统、`--cap-drop ALL`、`no-new-privileges`、内存/CPU/PID 限制、只读工作区挂载。
- 内置工具默认禁用，只放行绑定 MCP Server 的工具。
- 日志对 authorization / cookie / token 等字段脱敏。

> 单机部署中 worker 挂载宿主 Docker socket 等价于宿主 root 权限；生产环境应改为独立沙盒节点或 microVM 运行时。
