# PACE

PACE（仓库名 `agentport`）是一个单机优先的智能体运行平台：把 HTTP API 或 MCP Server 接进来，用文件定义智能体，在隔离沙盒里运行，并观测每一次调用。

产品名 **PACE**；仓库、包名与镜像名使用 `agentport`。依赖版本以 `package.json` / `pnpm-lock.yaml` 为准：Node.js >= 24、pnpm 12.15.0、React 19.3、Vite 8.3、Fastify 5.12、PostgreSQL 18、Redis 8。项目版本见根 `package.json`（当前 0.14.0）。

## 能力

| 领域 | 能力 |
|---|---|
| MCP 接入 | stdio 命令、远程 HTTP、HTTP API 转 MCP（generated）三种来源；连接测试；密钥加密入库、接口脱敏 |
| HTTP → MCP | 运行时挂载 `/mcp/:serverId`，按数据库中的工具定义动态构造标准 MCP 端点，不生成代码 |
| 平台 → MCP | `POST /mcp` 把已启用的智能体暴露为 `run_<slug>` 工具，供其他 Host 调用 |
| 智能体定义 | `.mcp.json`、`CLAUDE.md`、`.claude/agents/*.md`、`.claude/skills/*/SKILL.md`（含技能支持资源）、`.claude/rules/*.md`、`.claude/output-styles/*.md`；原生 auto-memory（`agent-memory/`，浏览/编辑）；文件预览；版本历史与回滚；导入导出（官方 `.claude/` 目录 ZIP） |
| 运行时配置 | 提示词、模型、技能、MCP 绑定、子智能体、工具白名单/黑名单、权限模式（`dontAsk` / `plan` / `default` / `acceptEdits`，`auto` 不开放）、effort、思考预算、轮次、预算、超时 |
| 运行 | BullMQ 队列 → Docker 沙盒 → Claude Agent SDK → SSE 流式事件；取消、超时、预算与轮次限制；失败重试与孤儿 run 收敛 |
| 对话 | 会话历史、分支、工具调用落库、上下文注入（最近 20 条消息）、运行详情重跑 |
| 观测 | 运行列表与 trace 详情、成本/轮次/token/延迟、审计日志、`/health/*`、队列与进程指标、`/status` 系统状态页 |
| 评估 | 用例管理、`eval-runs` 队列异步回归跑批、通过率与结果详情 |
| 治理 | 单管理员 JWT 登录（可吊销会话）、Redis 限流、UTC cron 定时任务（BullMQ Job Scheduler，运行队列积压超过 100 时跳过）、数据保留任务、数据库备份与恢复 |
| 子智能体 | 单层委派、调用归属展示；已用真实模型 + 沙盒端到端验证 |

## 快速开始

### 前置条件

- Node.js >= 24
- pnpm 12.15.0（`packageManager` 已固定）
- Docker Engine 与 Docker Compose
- 备份需要本机有 `pg_dump`（PostgreSQL 客户端）

### 一条命令部署

```bash
pnpm install
pnpm run up        # 生成 .env、起依赖、迁移、构建镜像、冒烟
# 打开 http://localhost:3000
```

首次运行会从 `.env.example` 生成 `.env`，随机填充 `APP_SECRET_KEY`、`JWT_SECRET`、`REDIS_PASSWORD`、`PLATFORM_MCP_TOKEN` 和 `ADMIN_PASSWORD`，并打印管理员密码；请按需修改 `ADMIN_PASSWORD` 后重新执行 `pnpm run up`。运行智能体还需在 `.env` 填写 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`。

`pnpm run up` 依次完成：启动 postgres/redis → 等待 healthy → 构建 `agentport/sandbox:dev`（已存在则跳过，`pnpm run up --rebuild` 强制重建）→ compose 一次性 `migrate` 服务执行迁移 → 构建并启动 api/worker → 等待 `/health/ready` → `pnpm smoke`。任一步失败会打印原因并以非零退出。停止服务用 `pnpm run down`（保留数据卷），`pnpm run down --clean` 会删除数据卷。

生产中 web 由 api 静态托管（`WEB_DIST=/app/web`），没有独立 web 容器。

三个最容易踩的点（完整部署、升级与排障见 [docs/OPERATIONS.md](docs/OPERATIONS.md)）：

- 沙盒镜像必须用宿主 Docker 构建；`pnpm run up` 已包含该步骤，worker 通过宿主 Docker daemon 启动沙盒。
- worker 挂载 `/var/run/docker.sock`，等价于宿主 root 权限，仅适合单机自用。
- 生产模式下登录 Cookie 带 `Secure`；请通过 `http://localhost` 访问。用局域网 IP 走 HTTP 会无法保持登录。

### 本地开发

```bash
pnpm install
pnpm build                      # 生成各包 dist；db:migrate 与沙盒镜像依赖它
cp .env.example .env            # 填写下方必填项
docker compose up -d postgres redis
pnpm db:migrate
# 沙盒镜像：runner 需要 @agentport/shared 的编译产物，不能只跑 docker build
pnpm --filter @agentport/sandbox build
pnpm --filter @agentport/shared build
rm -rf packages/sandbox/shared && cp -R packages/shared/dist packages/sandbox/shared
docker build -t agentport/sandbox:dev packages/sandbox
pnpm dev
```

`.env` 至少填写：

- `APP_SECRET_KEY`：MCP 密钥加密主密钥，至少 32 字符，建议 32 字节随机串
- `JWT_SECRET`：会话签名密钥，至少 32 字符
- `ADMIN_PASSWORD`：管理员密码，至少 12 字符，且不能是常见默认口令
- `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`：二选一，worker 用于反向代理模型请求（沙盒只拿代理地址与 run token）；未配置时回退直接注入沙盒

生成随机串：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

打开 Portless 输出的地址（本机基地址 [https://agentport.localhost](https://agentport.localhost)，worktree 下带分支前缀；实际 URL 以终端输出为准），用 `ADMIN_USER` / `ADMIN_PASSWORD` 登录。配置与端口说明见 [docs/OPERATIONS.md §2.3](docs/OPERATIONS.md#23-本地开发)。

`pnpm dev` 并行启动 api、worker、web，以及 shared/core/db 的 TypeScript watch。web 的 Vite 开发服务器把 `/api`、`/health` 代理到 [http://localhost:3000](http://localhost:3000)。

后端已在 [http://localhost:3000](http://localhost:3000) 运行时，只验收前端可在当前 worktree 单独启动 web：`pnpm --filter @agentport/web dev`（需先 `pnpm install` 并构建 shared/core 的 dist），地址同样取 Portless 输出。它复用同一 API、数据库与 Redis，不隔离其他 worktree 的数据。

## 常用命令

完整环境变量与运维步骤见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

| 命令 | 作用 |
|---|---|
| `pnpm run up` | 一条命令部署：生成 `.env`、启动依赖、迁移、构建镜像并冒烟（`--rebuild` 强制重建沙盒镜像） |
| `pnpm run down` | 停止整套 compose 服务并保留数据卷（`--clean` 删除数据卷） |
| `pnpm dev` | 并行启动所有包的开发进程（api / worker / web / watch） |
| `pnpm build` | 全量构建（`pnpm -r build`） |
| `pnpm typecheck` | 全量类型检查（`pnpm -r typecheck`） |
| `pnpm lint` | Biome 检查 |
| `pnpm lint:fix` | Biome 检查并写入修复 |
| `pnpm test` | 同时跑 `web` 与 `backend` 两个 Vitest 项目。web 项目不依赖后端；`backend` 项目会加载 `.env`，默认连 `DATABASE_URL` / `REDIS_URL` 指向的 PostgreSQL 与 Redis，集成用例在连不上时自动跳过。**队列相关用例先停 worker**（`docker compose stop worker api`），否则测试建的 run 会被真实消费 |
| `pnpm test:web` | 只跑 `packages/web/test`（jsdom，不加载 `.env`，不需要 API、worker、PostgreSQL、Redis） |
| `pnpm test:watch` | Vitest watch |
| `pnpm test:e2e` | e2e 端到端测试（`e2e run`，用例在 `tests/*.e2e.ts`）。自动启动或复用 [http://localhost:5173](http://localhost:5173) 的 Vite（不经过 Portless）；API 需另行在 [http://localhost:3000](http://localhost:3000) 运行。前置与凭据见下方说明；配置收全部 `tests/**/*.e2e.ts`，普通套件含要求停 worker 的回放用例，真实对话用例需单独跑（见下） |
| `pnpm db:generate` | 修改 Drizzle schema 后生成迁移 |
| `pnpm db:migrate` | 在宿主机应用迁移（`pnpm run up` 部署时由 compose 的 `migrate` 服务自动执行） |
| `pnpm backup` | `pg_dump` → `backups/<timestamp>.sql.gz`，保留最近 7 份；需先 export `DATABASE_URL` |
| `pnpm restore` | `pnpm restore <backup-file>`：先留恢复前安全副本，再单事务整库替换并补迁移 |
| `pnpm smoke` | 部署自检（健康、登录、列表、`/mcp` 鉴权）；需 `ADMIN_PASSWORD` 与服务已启动 |
| `pnpm infra:up` | 启动 compose 中的 postgres 与 redis |
| `pnpm infra:down` | `docker compose down`，会停止整套 compose 服务 |
| `pnpm clean` | 删除各包 `dist` 与所有 `node_modules` |
| `pnpm --filter @agentport/sandbox build` | 构建 runner 产物（镜像构建前置） |
| `pnpm --filter @agentport/sandbox image` | 构建 `agentport/sandbox:dev` 镜像；**需先**构建 sandbox 与 shared 的 dist，并把 `packages/shared/dist` 复制到 `packages/sandbox/shared`（见上文本地开发，或直接用 `pnpm run up --rebuild`） |
| `pnpm --filter @agentport/worker maintenance` | 手动执行一次数据保留任务 |
| `pnpm --filter @agentport/api start` | 以构建产物启动 api（需先 `pnpm build`） |
| `pnpm --filter @agentport/web preview` | 预览 web 构建产物 |

E2E 配置（`e2e.config.ts`）不主动加载 `.env`，浏览器用例连的是 [http://localhost:5173](http://localhost:5173)，不走 Portless。`e2e.config.ts` 的默认凭据是 `admin` / `admin-local-dev-2026`，必须与服务端实际生效的 `ADMIN_USER` / `ADMIN_PASSWORD` 一致，否则用 `E2E_ADMIN_USER`、`E2E_ADMIN_PASSWORD` 覆盖。多数用例还会直写数据库：先 `pnpm build` 产出 `packages/db/dist`，并显式导出与 API 同库的 `DATABASE_URL`；个别用例另有前置：`tests/chat-replay.e2e.ts` 要求 `E2E_WORKER_PAUSED=1`（即先停 worker），且 `e2e.config.ts` 收集全部 `tests/**/*.e2e.ts`，所以普通 `pnpm test:e2e` 要停 worker；`tests/smoke.e2e.ts` 里的真实对话用例需要 worker 与模型凭据，只在 `E2E_FULL=1` 时运行，与回放用例前提相反——应单独运行该用例并启动 worker，不能只给整套加 `E2E_FULL=1`。其他前置以各文件与 `e2e.config.ts` 的实际配置为准。

## 版本与发布

版本号在根 `package.json`，变更记录见 [CHANGELOG.md](CHANGELOG.md)（SemVer）。
发布：更新版本号与 CHANGELOG 后推送 `v*` tag（如 `git tag v0.14.0 && git push origin v0.14.0`）。
tag 触发 `.github/workflows/release.yml`，构建并推送 `ghcr.io/<repo>/api:<tag>` 与 `ghcr.io/<repo>/sandbox:<tag>` 到 GHCR。

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
├─ tests/          e2e 用例（`*.e2e.ts`，`e2e run` 执行）
├─ scripts/        backup.sh 等运维脚本
├─ data/           运行期工作区（gitignore）
├─ backups/        pg_dump 输出（gitignore）
├─ Dockerfile      api / worker 共用镜像
├─ docker-compose.yml
└─ .env.example
```

## 文档

- [e2e 迁移进度](MIGRATION.md) — Playwright → e2e 的逐文件状态
- [交付总结](DELIVERY.md) — 能做什么、怎么验证、还缺什么索引

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
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | 凌晨处置手册：症状 → 判断 → 处置 → 验证 |
| [docs/SUBAGENTS-VERIFICATION.md](docs/SUBAGENTS-VERIFICATION.md) | 子智能体委派的真实端到端验证记录 |
| [docs/SECURITY.md](docs/SECURITY.md) | 安全审查记录与剩余项 |
| [CHANGELOG.md](CHANGELOG.md) | 版本与变更记录 |

## 安全说明

- **认证**：单管理员账号，scrypt 校验（常量时间比较），JWT 存在 httpOnly、SameSite=Lax 的 Cookie 中，有效期 24 小时；JWT 带随机 `sid`，服务端在 Redis 校验 `session:<sid>`，logout 立即吊销。CORS 使用 `CORS_ORIGINS` allowlist；限流按 IP 计数（全局 600/min，登录 10/min、对话 20/min、`/mcp` 60/min、连接测试 20/min、评估发起 10/min；`RATE_LIMIT_DISABLED=1` 可整体关闭，仅用于测试与本地）。
- **密钥**：MCP 的 env/headers 使用 AES-256-GCM 加密入库，API 返回时脱敏为 `••••`；日志对 authorization、cookie、token、secret 等字段脱敏。
- **工作区密钥**：每次运行会把解密后的 MCP env/headers 写入按 run 隔离的 `data/workspaces/<slug>/<runId>/.mcp.json`，供沙盒内进程使用。目录 0700、文件 0600，run 结束即删除；MCP 凭据使用按 run 签发的短期 token（DB 只存 sha256）。但工作区仍含明文 MCP 密钥，不要提交或打包。模型凭证已代理（D-17）：worker 启动回环代理（默认 `MODEL_PROXY_PORT=3426`），沙盒只拿到代理地址与按 run 签发的短期 token，真实密钥只存在于 worker 进程；未配置任何凭证时才回退直接注入并在启动日志警告（见 [SECURITY.md](docs/SECURITY.md) M12a）。
- **SSRF**：只允许 http/https；连接测试与工具运行时都会解析 DNS 并拒绝私网、回环、link-local 地址；开发模式放行 localhost。DNS 重绑定无法在应用层彻底消除，出站仍建议配合网络 allowlist。
- **沙盒**：只读根文件系统、只读工作区挂载（长期记忆目录 `agent-memory/` 单独 rw 挂载）、`--cap-drop ALL`、`no-new-privileges`、非 root 用户、内存/CPU/PID 限制；内置工具默认禁用，只放行绑定的 MCP 工具，以及长期记忆目录的 `Read`/`Edit`（`Edit` 含 `Write`，越界由 `PreToolUse` 拒绝）；有子智能体时才放行 `Agent`。
- **工具审批**：标记 `requiresApproval` 的工具会**挂起同一次调用**（MCP 工具内部轮询 DB，默认最多 300s，`APPROVAL_WAIT_MS`），在运行详情页批准后直接继续并返回结果，不需要模型重发；超时按拒绝处理。未标记的工具在 `dontAsk` 下直接拒绝。
- **出站**：`SANDBOX_EGRESS` 默认 `open`（bridge 直连，**不隔离出站**，便于本地开发）。需要出站管控时显式设 `proxy` 并配置 `HTTPS_PROXY`/`HTTP_PROXY`；只设 `proxy` 不设代理时 worker 启动即失败（fail-closed），不会静默降级。`none` 完全断网（此时模型与 MCP 不可用）。需要硬隔离时用 `none` 或独立出站网关。
- **平台端点**：`/mcp` 只校验单个 `PLATFORM_MCP_TOKEN`；`/mcp/:serverId` 使用每个 generated server 的 Bearer token。`/health/live`、`/health/ready` 供容器探针使用、不校验登录；`/health/metrics` 需要登录，不要暴露到公网。
- **宿主权限**：worker 挂载 Docker socket，可控制宿主 Docker，等同于宿主 root。生产环境应改为独立沙盒节点或 microVM 运行时（`SandboxProvider` 接口已预留）。
- **生产 Cookie**：`NODE_ENV=production` 时 Cookie 带 `Secure`，通过 HTTP + 非 localhost 访问会登录失败。

审查记录与剩余项见 [docs/SECURITY.md](docs/SECURITY.md)。
