# PACE

PACE（仓库名 `agentport`）是一个单机优先的智能体运行平台：把 HTTP API 或 MCP Server 接进来，用文件定义智能体，在隔离沙盒里运行，并观测每一次调用。

产品名 **PACE**；仓库、包名与镜像名使用 `agentport`。依赖版本以 `package.json` / `pnpm-lock.yaml` 为准：Node.js >= 24、pnpm 12.14.0、React 19.3、Vite 8.3、Fastify 5.12、PostgreSQL 18、Redis 8。项目本身没有对外版本号。

## 能力

| 领域 | 能力 |
|---|---|
| MCP 接入 | stdio 命令、远程 HTTP、HTTP API 转 MCP（generated）三种来源；连接测试；密钥加密入库、接口脱敏 |
| HTTP → MCP | 运行时挂载 `/mcp/:serverId`，按数据库中的工具定义动态构造标准 MCP 端点，不生成代码 |
| 平台 → MCP | `POST /mcp` 把已启用的智能体暴露为 `run_<slug>` 工具，供其他 Host 调用 |
| 智能体定义 | `.mcp.json`、`CLAUDE.md`、`.claude/agents/*.md`、`.claude/skills/*/SKILL.md`；文件预览；版本历史与回滚；导入导出 |
| 运行时配置 | 提示词、模型、技能、MCP 绑定、子智能体、工具白名单/黑名单、effort、思考预算、轮次、预算、超时 |
| 运行 | BullMQ 队列 → Docker 沙盒 → Claude Agent SDK → SSE 流式事件；取消、超时、预算与轮次限制 |
| 对话 | 会话历史、分支、工具调用落库、上下文注入（最近 20 条消息） |
| 观测 | 运行列表与 trace 详情、成本/轮次/token/延迟、审计日志、`/health/*`、队列与进程指标 |
| 评估 | 用例管理、异步回归跑批、通过率与结果详情 |
| 治理 | 单管理员 JWT 登录（可吊销会话）、Redis 限流、数据保留任务、数据库备份 |

## 快速开始

### 前置条件

- Node.js >= 24
- pnpm 12.14.0（`packageManager` 已固定）
- Docker Engine 与 Docker Compose
- 备份需要本机有 `pg_dump`（PostgreSQL 客户端）

### 本地开发

```bash
pnpm install
pnpm build                      # 生成各包 dist；db:migrate 与沙盒镜像依赖它
cp .env.example .env            # 填写下方必填项
docker compose up -d postgres redis
pnpm db:migrate
pnpm --filter @agentport/sandbox image
pnpm dev
```

`.env` 至少填写：

- `APP_SECRET_KEY`：MCP 密钥加密主密钥，至少 32 字符，建议 32 字节随机串
- `JWT_SECRET`：会话签名密钥，至少 32 字符
- `ADMIN_PASSWORD`：管理员密码，至少 12 字符，且不能是常见默认口令
- `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`：二选一，运行智能体时注入沙盒

生成随机串：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

打开 http://localhost:5173，用 `ADMIN_USER` / `ADMIN_PASSWORD` 登录。

`pnpm dev` 并行启动 api、worker、web，以及 shared/core/db 的 TypeScript watch。web 的 Vite 开发服务器把 `/api`、`/health` 代理到 `localhost:3000`。

### Docker

```bash
pnpm install
pnpm build
cp .env.example .env            # 填写 APP_SECRET_KEY / JWT_SECRET / ADMIN_PASSWORD / 模型凭证
docker compose up -d postgres redis
pnpm db:migrate                 # 迁移不会自动执行
pnpm --filter @agentport/sandbox image
docker compose up -d --build
```

打开 http://localhost:3000。生产中 web 由 api 静态托管（`WEB_DIST=/app/web`），没有独立 web 容器。

三个最容易踩的点（完整部署、升级与排障见 [docs/OPERATIONS.md](docs/OPERATIONS.md)）：

- 沙盒镜像必须在宿主机构建，compose 不会构建它；worker 通过宿主 Docker daemon 启动沙盒。
- worker 挂载 `/var/run/docker.sock`，等价于宿主 root 权限，仅适合单机自用。
- 生产模式下登录 Cookie 带 `Secure`；请通过 `http://localhost` 访问。用局域网 IP 走 HTTP 会无法保持登录。

## 常用命令

完整环境变量与运维步骤见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 并行启动所有包的开发进程（api / worker / web / watch） |
| `pnpm build` | 全量构建（`pnpm -r build`） |
| `pnpm typecheck` | 全量类型检查（`pnpm -r typecheck`） |
| `pnpm lint` | Biome 检查 |
| `pnpm lint:fix` | Biome 检查并写入修复 |
| `pnpm test` | Vitest 测试（需要 PostgreSQL 与 Redis；不可用时集成用例自动跳过）。vitest 不读 `.env`；用 compose 的 Redis 时需 `REDIS_URL=redis://:agentport-dev@localhost:6379 pnpm test` |
| `pnpm test:watch` | Vitest watch |
| `pnpm test:e2e` | Playwright 端到端测试；`E2E_FULL=1` 才跑真实对话链路 |
| `pnpm db:generate` | 修改 Drizzle schema 后生成迁移 |
| `pnpm db:migrate` | 应用迁移 |
| `pnpm backup` | `pg_dump` → `backups/<timestamp>.sql.gz`，保留最近 7 份；需先 export `DATABASE_URL` |
| `pnpm smoke` | 部署自检（健康、登录、列表、`/mcp` 鉴权）；需 `ADMIN_PASSWORD` 与服务已启动 |
| `pnpm infra:up` | 启动 compose 中的 postgres 与 redis |
| `pnpm infra:down` | `docker compose down`，会停止整套 compose 服务 |
| `pnpm clean` | 删除各包 `dist` 与所有 `node_modules` |
| `pnpm --filter @agentport/sandbox build` | 构建 runner 产物（镜像构建前置） |
| `pnpm --filter @agentport/sandbox image` | 构建 `agentport/sandbox:dev` 镜像 |
| `pnpm --filter @agentport/worker maintenance` | 手动执行一次数据保留任务 |
| `pnpm --filter @agentport/api start` | 以构建产物启动 api（需先 `pnpm build`） |
| `pnpm --filter @agentport/web preview` | 预览 web 构建产物 |

E2E 不读取 `.env`，默认管理员为 `admin` / `admin-change-me`（该口令不能用于服务端配置）；如与 `.env` 不同，用 `E2E_ADMIN_USER`、`E2E_ADMIN_PASSWORD` 覆盖。本地 `.env` 的默认口令是 `admin-local-dev-2026`。

## 目录结构

```
agentport/
├─ packages/
│  ├─ shared/      纯类型与 zod schema，无运行时依赖（zod 除外）
│  ├─ core/        领域逻辑：工作区渲染、密钥加解密、MCP 条目
│  ├─ db/          Drizzle schema、repo、迁移
│  ├─ api/         Fastify：HTTP、鉴权、MCP 端点、SSE、队列生产
│  ├─ worker/      BullMQ 消费者、沙盒生命周期、维护任务
│  ├─ sandbox/     容器内 runner 与沙盒镜像（Claude Agent SDK）
│  └─ web/         React 19 + Vite SPA
├─ docs/           产品、架构、运维与实施文档
├─ e2e/            Playwright 用例
├─ scripts/        backup.sh 等运维脚本
├─ data/           运行期工作区（gitignore）
├─ backups/        pg_dump 输出（gitignore）
├─ Dockerfile      api / worker 共用镜像
├─ docker-compose.yml
└─ .env.example
```

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分层、运行时拓扑、数据流、两个 MCP 方向、工作区文件模型、设计决策 |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 环境变量、部署、备份恢复、维护任务、故障排查、观测入口 |
| [docs/USER-STORIES.md](docs/USER-STORIES.md) | 用户故事与验收条件 |
| [PRODUCT.md](PRODUCT.md) | 产品定位、用户、原则与约束 |
| [docs/PROJECT-BRIEF.md](docs/PROJECT-BRIEF.md) | 需求、选型与实现记录；部分早期结论已被后续实现取代 |
| [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md) | PACE 品牌、token 与组件规范 |
| [docs/IMPL-CONTRACTS.md](docs/IMPL-CONTRACTS.md) | 并行开发时的接口契约（历史文档） |
| [docs/CAPABILITY-GAP.md](docs/CAPABILITY-GAP.md) | 对标行业基线后的能力差距与补齐记录 |
| [docs/DECISIONS-PENDING.md](docs/DECISIONS-PENDING.md) | 待决策事项与已执行状态回填 |
| [docs/HANDOFF.md](docs/HANDOFF.md) | 当前状态、质量基线、已知限制、下一步 |
| [docs/SECURITY.md](docs/SECURITY.md) | 安全审查记录与剩余项 |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | 按循环 0–9 的能力清单 |

## 安全说明

- **认证**：单管理员账号，scrypt 校验（常量时间比较），JWT 存在 httpOnly、SameSite=Lax 的 Cookie 中，有效期 24 小时；JWT 带随机 `sid`，服务端在 Redis 校验 `session:<sid>`，logout 立即吊销。CORS 使用 `CORS_ORIGINS` allowlist；限流按 IP 计数（登录 10/min、对话 20/min、`/mcp` 60/min、连接测试 20/min、评估发起 10/min）。
- **密钥**：MCP 的 env/headers 使用 AES-256-GCM 加密入库，API 返回时脱敏为 `••••`；日志对 authorization、cookie、token、secret 等字段脱敏。
- **工作区密钥**：每次运行会把解密后的 MCP env/headers 写入 `data/workspaces/<slug>/.mcp.json`，供沙盒内进程使用。该目录含明文密钥，必须限制宿主访问权限，且不要提交或打包（文件权限尚未收紧，见 [SECURITY.md](docs/SECURITY.md) M12）。
- **SSRF**：只允许 http/https；连接测试与工具运行时都会解析 DNS 并拒绝私网、回环、link-local 地址；开发模式放行 localhost。DNS 重绑定无法在应用层彻底消除，出站仍建议配合网络 allowlist。
- **沙盒**：只读根文件系统、只读工作区挂载、`--cap-drop ALL`、`no-new-privileges`、非 root 用户、内存/CPU/PID 限制；内置工具（Bash/Read/Write/Edit/WebFetch 等）从上下文移除，只放行绑定的 MCP 工具；有子智能体时才放行 `Agent`。
- **工具审批**：当前没有「暂停等待批准」的 HITL；`dontAsk` 下未预批准的工具直接拒绝。标记 `requiresApproval` 的工具会先记录审批请求，批准后同一 run 的后续调用放行，但不是暂停恢复。
- **出站**：`SANDBOX_EGRESS` 默认 `proxy`，容器通过 `HTTPS_PROXY` 出站；未设置代理地址时启动 warn 并回退到 `open`（bridge 直连）。`none` 完全断网（此时模型与 MCP 不可用）。需要硬隔离时用 `none` 或独立出站网关。
- **平台端点**：`/mcp` 只校验单个 `PLATFORM_MCP_TOKEN`；`/mcp/:serverId` 使用每个 generated server 的 Bearer token。`/health/*`（含 `/health/metrics`）无鉴权，不要直接暴露到公网。
- **宿主权限**：worker 挂载 Docker socket，可控制宿主 Docker，等同于宿主 root。生产环境应改为独立沙盒节点或 microVM 运行时（`SandboxProvider` 接口已预留）。
- **生产 Cookie**：`NODE_ENV=production` 时 Cookie 带 `Secure`，通过 HTTP + 非 localhost 访问会登录失败。

审查记录与剩余项见 [docs/SECURITY.md](docs/SECURITY.md)。
