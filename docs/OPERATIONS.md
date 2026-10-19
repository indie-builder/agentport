# 运维

> 本文覆盖环境变量、部署、备份恢复、维护任务、故障排查与观测入口。架构说明见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 1. 环境变量

所有变量从进程环境读取；本地开发由 `--env-file-if-exists=../../.env` 或 compose 的 `env_file` 注入。下表的「必填」指进程启动时校验失败会直接退出。

### 1.1 通用

| 变量 | 必填 | 默认 | 读取方 | 说明 |
|---|---|---|---|---|
| `NODE_ENV` | 否 | `development` | api、worker | `development` / `test` / `production`；影响日志格式、CORS、SSRF 本地放行、Cookie `Secure` |
| `LOG_LEVEL` | 否 | `info` | api、worker | `fatal` / `error` / `warn` / `info` / `debug` / `trace` |
| `PORT` | 否 | `3000` | api | HTTP 监听端口，绑定 `0.0.0.0` |
| `DATABASE_URL` | 是 | — | api、worker、db 迁移、备份 | PostgreSQL 连接串 |
| `REDIS_URL` | 否 | `redis://localhost:6379` | api、worker | 队列、事件流、取消、限流共用 |
| `APP_SECRET_KEY` | 是 | — | api、worker | MCP 密钥加密主密钥，≥16 字符。**api 与 worker 必须一致**，否则 worker 无法解密 |
| `ADMIN_USER` | 否 | `admin` | api | 唯一管理员用户名 |
| `ADMIN_PASSWORD` | 是 | — | api | 管理员密码，≥8 字符；每次登录用 scrypt 比对 |
| `JWT_SECRET` | 是 | — | api | 会话签名密钥，≥16 字符 |
| `SELF_URL` | 否 | `http://127.0.0.1:3000` | api | generated server「测试连接」时访问的平台自身地址 |
| `WEB_DIST` | 否 | 未设置 | api | 设置且目录存在时托管 SPA；compose 中为 `/app/web` |
| `PLATFORM_MCP_TOKEN` | 否 | 未设置 | api | `/mcp` 平台端点的 Bearer token，≥16 字符；未设置则端点不注册 |
| `RATE_LIMIT_DISABLED` | 否 | 未设置 | api | 值为 `1` 时关闭限流；仅用于测试/排障 |

### 1.2 智能体与模型

| 变量 | 必填 | 默认 | 读取方 | 说明 |
|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | 二选一 | — | worker → 沙盒 | 模型 API key；注入容器，不落工作区 |
| `ANTHROPIC_AUTH_TOKEN` | 二选一 | — | worker → 沙盒 | 以 Bearer token 发送；与上一项二选一 |
| `ANTHROPIC_BASE_URL` | 否 | — | worker → 沙盒 | 自建网关地址；loopback 会自动改写为 `host.docker.internal` |
| `AGENT_MAX_CONCURRENT` | 否 | `2` | worker | `agent-runs` 队列并发数 |
| `AGENT_TIMEOUT_MS` | 否 | `600000` | worker | 单个 run 的默认超时；agent 自身 `timeoutMs` 优先 |
| `AGENT_DEFAULT_MODEL` | 否 | `claude-sonnet-5-5` | api（已解析） | 当前代码未使用；模型由每个 agent 的 `model` 字段决定 |
| `AGENT_MAX_BUDGET_USD` | 否 | `2` | api（已解析） | 当前代码未使用；预算由每个 agent 的 `maxBudgetUsd` 决定 |

### 1.3 沙盒

| 变量 | 必填 | 默认 | 读取方 | 说明 |
|---|---|---|---|---|
| `SANDBOX_IMAGE` | 否 | `agentport/sandbox:dev` | worker | 每次 run 启动的镜像 |
| `SANDBOX_API_URL` | 否 | `http://host.docker.internal:3000` | worker、api（预览） | 沙盒视角的平台地址，写入 generated server 的 `.mcp.json` |
| `SANDBOX_EGRESS` | 否 | `open` | worker | `open` = bridge；`none` = `--network none`；`proxy` = bridge + 容器内 `HTTPS_PROXY` |
| `SANDBOX_MEMORY` | 否 | `1g` | worker | 容器内存上限（Docker 格式，如 `1g`、`512m`） |
| `SANDBOX_CPUS` | 否 | `1` | worker | CPU 核数上限 |
| `SANDBOX_PIDS` | 否 | `128` | worker | PID 上限 |
| `WORKSPACES_DIR` | 否 | `./data/workspaces` | worker | 工作区根目录。compose 下必须与宿主机同路径 |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | 否 | — | worker → 沙盒 | 仅 `SANDBOX_EGRESS=proxy` 时透传，loopback 自动改写 |
| `SANDBOX_PROVIDER` | 否 | `docker` | 无人读取 | `.env.example` 中的历史项；当前只有 Docker 实现 |
| `DOCKER_GID` | 否 | `0` | compose | worker 容器加入的组 GID，用于访问宿主 Docker socket |

### 1.4 数据保留

| 变量 | 必填 | 默认 | 读取方 | 说明 |
|---|---|---|---|---|
| `RETAIN_RUN_DAYS` | 否 | `90` | worker | 已终态 run 及其消息的保留天数 |
| `RETAIN_MESSAGE_DAYS` | 否 | `30` | worker | 无 `run_id` 的孤立消息保留天数 |
| `RETAIN_AGENT_VERSIONS` | 否 | `50` | worker | 每个智能体保留的版本数 |

> `.env.example` 未列出 `PLATFORM_MCP_TOKEN`、`SANDBOX_EGRESS`、`SANDBOX_MEMORY`、`SANDBOX_CPUS`、`SANDBOX_PIDS`、`RATE_LIMIT_DISABLED`。需要时直接追加到 `.env`。

## 2. 部署

### 2.1 前置

- Node.js 24、pnpm 12.14.0
- Docker Engine + Compose
- 宿主有 `pg_dump` / `psql`（备份与恢复）
- 至少一个模型凭证（`ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`）

### 2.2 Docker Compose

```bash
pnpm install
pnpm build                          # 迁移脚本引用 packages/db/dist
cp .env.example .env                # 填必填项；compose 要求 .env 存在
docker compose up -d postgres redis # 等两个容器 healthy
pnpm db:migrate                     # 迁移是单独步骤，不会自动执行
pnpm --filter @agentport/sandbox image
docker compose up -d --build        # 构建并启动 api 与 worker
```

检查：

```bash
docker compose ps
curl -s http://localhost:3000/health/live
curl -s http://localhost:3000/health/ready
```

`/health/ready` 返回 `{"status":"ok","db":"ok","redis":"ok"}` 即依赖就绪。

说明：

- `docker compose up -d --build` 会在镜像内执行 `pnpm -r build`，不依赖宿主 `dist`；但 `pnpm db:migrate` 在宿主机执行，需要 `packages/db/dist`。
- **迁移不会自动执行**，升级后必须手动运行 `pnpm db:migrate`。
- 沙盒镜像不由 compose 构建。`packages/sandbox/image` 脚本会 `docker build`，其 Dockerfile 复制 `dist/`，所以先 `pnpm --filter @agentport/sandbox build`。
- compose 会占用 3000、5432、6379；如冲突，先停掉本机对应服务或改端口。
- worker 容器内是 `node` 用户，通过 `group_add: ${DOCKER_GID:-0}` 访问 socket。Linux 上若 docker 组 GID 不是 0，部署前 `export DOCKER_GID=$(getent group docker | cut -d: -f3)`。
- 生产通过 `http://localhost:3000` 访问；Cookie 带 `Secure`，局域网 IP + HTTP 会无法保持登录。

### 2.3 本地开发

```bash
pnpm install
pnpm build
cp .env.example .env
docker compose up -d postgres redis
pnpm db:migrate
pnpm --filter @agentport/sandbox image
pnpm dev
```

- api: http://localhost:3000
- web: http://localhost:5173（Vite 代理 `/api`、`/health`）
- worker 与 api 同机；沙盒通过 `host.docker.internal:3000` 访问 api，因此 api 必须监听 3000。

### 2.4 升级

```bash
git pull
pnpm install
pnpm build
pnpm db:migrate
docker compose up -d --build
```

修改了 `packages/sandbox` 时再执行 `pnpm --filter @agentport/sandbox image`。worker 升级会中断进行中的 run（容器随 `docker rm -f` 清理）；建议在空闲时操作。

## 3. 备份与恢复

### 3.1 备份

```bash
set -a; . ./.env; set +a     # backup.sh 不读 .env，必须已经 export DATABASE_URL
pnpm backup
```

行为（`scripts/backup.sh`）：

- `pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip` 写入 `backups/<YYYYMMDD-HHMMSS>.sql.gz`
- 成功后只保留 `backups/` 下最近 7 个 `.sql.gz`
- 失败时删除临时文件并以非零退出
- 需要宿主已安装 PostgreSQL 客户端

建议用宿主机 cron 每天执行，并把 `backups/` 同步到另一台机器：

```cron
15 3 * * * cd /path/to/agentport && set -a && . ./.env && set +a && pnpm backup >> backups/cron.log 2>&1
```

备份含全部配置、会话、运行与审计，但**不含** `data/workspaces/`。工作区是每次 run 重建的派生物，无需备份；如果里面有手工放入的文件，需单独备份。

### 3.2 恢复

```bash
docker compose stop api worker
createdb -h localhost -U agentport agentport_restore   # 或创建一个空库
gunzip -c backups/20261020-031500.sql.gz | psql "$DATABASE_URL"
pnpm db:migrate
docker compose start api worker
```

要点：

- 恢复到空库或已清空的库；`pg_dump` 输出包含建表语句，不要叠加到同结构的旧库上。
- 保持原来的 `APP_SECRET_KEY`。换了主密钥，`servers.secrets_encrypted` 无法解密，所有 MCP 密钥需要重新填写。
- 恢复后 `pnpm db:migrate` 只为补齐备份之后新增的迁移。
- 如果只恢复单个智能体，用「智能体 → 导出 / 导入」（`agentport/agent@1` JSON）；导出不含密钥明文，只含键名，导入后要重新填写。

## 4. 维护任务

### 4.1 自动执行

worker 启动时注册 BullMQ 的 `maintenance` 每日重复任务（`upsertJobScheduler('daily', { every: 24h })`），执行：

| 动作 | 范围 | 依据 |
|---|---|---|
| 清理智能体版本 | 每个 agent 只保留最近 `RETAIN_AGENT_VERSIONS` 个 | `agent_versions` |
| 清理运行 | 已终态且结束超过 `RETAIN_RUN_DAYS` 的 run，连同其消息 | `agent_runs`、`messages.run_id` |
| 清理孤立消息 | 无 `run_id` 且超过 `RETAIN_MESSAGE_DAYS` 的消息 | `messages` |

`audit_log` 与 `eval_results` 不参与清理。每次执行写入一条 `maintenance.pruned` 审计，`target` 为 JSON 摘要。

### 4.2 手动触发

```bash
pnpm --filter @agentport/worker maintenance
```

它会读取 `.env`、连接数据库、执行一次并打印摘要（`runsDeleted`、`runMessagesDeleted`、`orphanMessagesDeleted`、`agentVersionsDeleted`、`durationMs`）。

注意：api 进程不读取这些保留变量，配置只需对 worker 生效。

### 4.3 会话与运行

- `/api/runs` 与 `/api/runs/:id` 不清理；运行详情由 `messages` 重建步骤。
- 事件流在 Redis 中保留 1 小时（`run:<runId>:events`，最多 1000 条），过期后不能回放，但 `messages` 仍可还原主线。
- 取消一个 queued 的 run 只会标记终态，worker 消费时会跳过；取消 running 的 run 会向容器发 SIGTERM。

## 5. 故障排查

| 症状 | 可能原因 | 检查命令 / 处理 |
|---|---|---|
| `/health/ready` 返回 503，`db` 或 `redis` 为 `error` | 依赖未启动、连接串错误、容器不健康 | `docker compose ps`；`docker compose logs postgres redis`；`curl -s localhost:3000/health/ready`；确认 `.env` 的 `DATABASE_URL` / `REDIS_URL` 与实际端口一致 |
| 日志报 `Could not find a working container runtime strategy` 或 `Cannot connect to the Docker daemon` | worker 无法访问宿主 Docker socket | 在 worker 容器内 `docker ps`；检查 `/var/run/docker.sock` 挂载与 `DOCKER_GID`（`ls -l /var/run/docker.sock`，`getent group docker`） |
| run 失败，错误含 `no such image` / `pull access denied` | 沙盒镜像未构建或名字不对 | `docker images agentport/sandbox`；`pnpm --filter @agentport/sandbox build && pnpm --filter @agentport/sandbox image`；核对 `SANDBOX_IMAGE` |
| 模型调用 401 / 403 | 凭证缺失、失效，或 `ANTHROPIC_BASE_URL` 在容器内不可达 | `docker compose logs worker` 看容器 stderr；确认 `.env` 只填了 `ANTHROPIC_API_KEY` 与 `ANTHROPIC_AUTH_TOKEN` 之一；`ANTHROPIC_BASE_URL` 不要写 `127.0.0.1`（worker 会改写为 `host.docker.internal`，Linux 需 Docker 支持该别名） |
| MCP 工具未出现在智能体上下文 | 未绑定 server、工具被禁用、绑定关系未保存，或 server 连接失败 | 「MCP Servers」页点「测试」看 `listTools()`；检查 generated server 的工具是否 `enabled`；「智能体 → 文件预览」确认 `.mcp.json` 含该 server；运行详情看拒绝原因（`permissionMode=dontAsk` 下未预批准会直接拒绝） |
| `mcp__<server>__tool` 被拒绝 | 允许规则写成了 `mcp__*`，或 server 名与绑定名不一致 | 规则由 worker 按 `.mcp.json` 的 server key 生成 `mcp__<name>__*`；不要手写 `mcp__*`；在文件预览核对 server key |
| 队列堆积，run 一直 `queued` | worker 未启动、并发占满、Redis 不可用 | `curl -s localhost:3000/health/metrics` 看 `queue.waiting/active`；`docker compose logs worker`；确认 `AGENT_MAX_CONCURRENT`；`docker compose ps worker` |
| SSE 无输出或立即断开 | 未登录（401 后前端跳登录）、反向代理缓冲、run 尚未开始、事件流已过期 | `curl -N -b "agentport_token=<token>" http://localhost:3000/api/chat/<runId>/events`；代理需关闭 buffering（代码已发 `X-Accel-Buffering: no`）；确认 run 状态不是 `queued`；事件流 TTL 为 1 小时 |
| generated server 在沙盒内 401 | `.mcp.json` 里的 `mcpToken` 与数据库不一致，或平台地址不可达 | 重新保存 server（PATCH 会沿用旧 token，不会轮换）；确认 `SANDBOX_API_URL` 从容器可达（`docker run --rm curlimages/curl -s $SANDBOX_API_URL/health/live`） |
| 页面登录成功但刷新后退出 | 生产 Cookie 带 `Secure`，却用 HTTP + 非 localhost 访问 | 用 `http://localhost:3000`，或在明确可信的内网终止 TLS 后访问；不要把 `NODE_ENV` 改成 development 来绕过 |
| 修改 schema 后报 `column ... does not exist` | 只改了 `schema.ts`，未生成或未应用迁移 | `pnpm db:generate && pnpm db:migrate`；迁移文件按顺序应用，不要手改已应用的迁移 |
| 登录返回 429 | 登录限流 10 次/分钟（按 IP） | 等一分钟；只在本地/测试环境可临时 `RATE_LIMIT_DISABLED=1` 后重启 api |
| `pnpm backup` 报 `DATABASE_URL is required` | 脚本不读取 `.env` | `set -a; . ./.env; set +a; pnpm backup` |
| worker 退出并报 `Invalid environment` | `.env` 缺少必填项或长度不足 | 按报错里的字段名补齐；`APP_SECRET_KEY`、`JWT_SECRET` ≥16，`ADMIN_PASSWORD` ≥8 |
| 运行超时 | `timeoutMs` 太小、模型慢、工具上游慢 | 运行详情看 `latencyMs` 与最后一步；调大智能体的 `timeoutMs`；检查上游 API 延迟 |
| 评估跑批一直 `running` | 跑批在 api 进程内异步执行，api 重启会中断 | 重启后重新发起；不要在生产重启窗口跑批 |

常用观察命令：

```bash
docker compose logs -f api worker
docker compose ps
curl -s localhost:3000/health/metrics
redis-cli -u "$REDIS_URL" llen bull:agent-runs:wait
redis-cli -u "$REDIS_URL" xlen run:<runId>:events
docker ps --filter name=agentport-
```

## 6. 观测入口

| 入口 | 内容 | 鉴权 |
|---|---|---|
| `GET /health/live` | 进程存活 | 无 |
| `GET /health/ready` | DB 查询 + Redis ping；任一失败返回 503 与 `status: degraded` | 无 |
| `GET /health/metrics` | 进程（uptime、RSS、Node 版本）、队列计数、连接池、Redis ping 延迟；单项失败返回 `null`，整体仍 200 | 无 |
| `/api/overview` | 统计卡、智能体聚合（运行数、成本、错误率、P50/P99、tokens）、最近 20 条运行 | 登录 |
| `/api/runs`、`/api/runs/:id` | 运行列表与 trace 步骤 | 登录 |
| `/api/audit` | 审计事件，可按 action / status / 时间过滤 | 登录 |
| 页面「审计」 | 同上，按时间倒序 | 登录 |
| 页面「运行」→ 详情 | 状态、耗时、轮次、成本、token、错误、步骤时间线 | 登录 |
| api 日志 | pino JSON（生产）/ pino-pretty（开发）；按路由模板记录，>2s 记 `slow request`，SSE 不打慢请求 | stdout |
| worker 日志 | 结构化 JSON；每步带 `runId`，容器 stderr 以 `sandbox` 字段转发 | stdout |

审计动作包括：`auth.login.succeeded`、`auth.login.failed`、`server.created/updated/deleted`、`mcp.server.tested`、`agent.created/updated/deleted/rolled_back`、`skill.created/updated/deleted`、`agent.run.requested/cancelled/finished`、`conversation.branched`、`eval.run.requested`、`maintenance.pruned`。审计只存输入摘要（SHA-256 前 32 位），不存原文。

## 7. 性能备注

- **索引**（0009 迁移）：`agent_runs(started_at DESC NULLS LAST, id DESC)` 与 `agent_runs(agent_id, started_at DESC NULLS LAST, id DESC)` 服务 `/api/runs` 与概览的「最近运行」排序；`messages(run_id)` 服务 run trace 查询；`messages(conversation_id, created_at, id)` 让会话消息免排序。改动见 `packages/db/src/schema.ts`，重新生成用 `pnpm db:generate`。
- **会话列表**：`/api/conversations` 的 `lastMessage` 只返回截断到 280 字的 `text`，不再回传整块 jsonb。
- **概览页**：`/api/overview` 已含 servers/agents 计数，前端不再额外请求 `/api/servers`、`/api/agents`；`/api/overview` 返回 404 时才回退到列表接口。
- **本机基线**（20 次 curl，改前 → 改后，p50/p95）：`/api/overview` 8.0/9.7 → 6.9/8.8 ms；`/api/runs` 3.1/4.9 → 3.1/4.0 ms；`/api/conversations` 3.4/5.3 → 3.0/5.1 ms（响应 8009 → 6820 B）。数据量很小时数据库耗时不占主导，收益主要来自索引在数据增长后避免全表扫描 + 排序。
- **未做**：`/api/agents`、`/api/skills`、`/api/eval/*` 列表仍无分页；当前单机数据量下影响可忽略，智能体/技能数量上来后再加 `limit`。MCP 端点每次请求重查 server + tools，属于配置即时生效的取舍，不在本次范围。
