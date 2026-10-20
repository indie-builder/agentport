# 运维

> 本文覆盖环境变量、部署、备份恢复、维护任务、故障排查与观测入口。架构说明见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 1. 环境变量

所有变量从进程环境读取；本地开发由 `--env-file-if-exists=../../.env` 或 compose 的 `env_file` 注入。下表的「必填」指进程启动时校验失败会直接退出。启动时校验的 schema 只有两个：`packages/api/src/config.ts`（api）与 `packages/worker/src/config.ts`（worker）；表里「读取方」列为「未被 schema 读取」的变量由代码直接读 `process.env` 或只由 compose/脚本使用。

### 1.1 通用（api schema）

| 变量 | 必填 | 默认 | 读取方 | 说明 |
|---|---|---|---|---|
| `NODE_ENV` | 否 | `development` | api、worker | `development` / `test` / `production`；影响日志格式、SSRF 本地放行、Cookie `Secure` |
| `LOG_LEVEL` | 否 | `info` | api、worker | `fatal` / `error` / `warn` / `info` / `debug` / `trace` |
| `PORT` | 否 | `3000` | api | HTTP 监听端口，绑定 `0.0.0.0` |
| `DATABASE_URL` | 是 | — | api、worker、db 迁移、备份 | PostgreSQL 连接串 |
| `REDIS_URL` | 否 | `redis://localhost:6379` | api、worker | 队列、事件流、取消、限流共用；用 compose 的 Redis 时连接串需带 `REDIS_PASSWORD` |
| `APP_SECRET_KEY` | 是 | — | api、worker | MCP 密钥加密主密钥，≥32 字符。**api 与 worker 必须一致**，否则 worker 无法解密 |
| `ADMIN_USER` | 否 | `admin` | api | 唯一管理员用户名 |
| `ADMIN_PASSWORD` | 是 | — | api | 管理员密码，≥12 字符，且不能是 `admin-change-me` / `changeme` / `password`；每次登录用 scrypt 比对 |
| `JWT_SECRET` | 是 | — | api | 会话签名密钥，≥32 字符 |
| `CORS_ORIGINS` | 否 | `http://localhost:5173` | api | 逗号分隔的浏览器 Origin allowlist；生产填实际访问地址（如 `https://agentport.example.com`），不要用 `*` |
| `SELF_URL` | 否 | `http://127.0.0.1:3000` | api | generated server「测试连接」时访问的平台自身地址 |
| `AGENT_DEFAULT_MODEL` | 否 | `claude-sonnet-5-5` | api（仅校验，未使用） | 当前代码不使用；模型由每个 agent 的 `model` 字段决定 |
| `AGENT_MAX_CONCURRENT` | 否 | `2` | api、worker 均解析；worker 使用 | `agent-runs` 队列并发数（api 解析但不读） |
| `AGENT_TIMEOUT_MS` | 否 | `600000` | api、worker | 单个 run 的默认超时；agent 自身 `timeoutMs` 优先 |
| `AGENT_MAX_BUDGET_USD` | 否 | `2` | api（仅校验，未使用） | 当前代码不使用；预算由每个 agent 的 `maxBudgetUsd` 决定 |

以下变量不在 schema 中，由代码直接读 `process.env` 或只由 compose 使用：

| 变量 | 默认 | 读取方 | 说明 |
|---|---|---|---|
| `WEB_DIST` | 未设置 | api | 设置且目录存在时托管 SPA；compose 中为 `/app/web` |
| `PLATFORM_MCP_TOKEN` | 未设置 | api | `/mcp` 平台端点的 Bearer token，≥16 字符；未设置则端点不注册 |
| `RATE_LIMIT_DISABLED` | 未设置 | api | 值为 `1` 时关闭限流；仅用于测试/排障 |
| `TRUST_PROXY` | 未设置 | api | 值为 `1` 时信任 `X-Forwarded-For`/`X-Forwarded-Proto`（反向代理之后必须开启，否则限流按代理 IP 计数） |
| `DB_POOL_MAX` | `10` | api、worker | 每个进程的 pg 连接池上限 |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | 未设置 | worker | 仅 `SANDBOX_EGRESS=proxy` 时透传给沙盒，loopback 自动改写 |
| `REDIS_PASSWORD` | `agentport-dev` | compose | redis 服务密码，同时拼进 api/worker 的 `REDIS_URL`；不是应用变量 |
| `DOCKER_GID` | `0` | compose | worker 容器加入的组 GID，用于访问宿主 Docker socket |

### 1.2 智能体与模型（worker schema）

| 变量 | 必填 | 默认 | 读取方 | 说明 |
|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | 二选一 | — | worker → 沙盒 | 模型 API key；注入容器，不落工作区 |
| `ANTHROPIC_AUTH_TOKEN` | 二选一 | — | worker → 沙盒 | 以 Bearer token 发送；与上一项二选一 |
| `ANTHROPIC_BASE_URL` | 否 | — | worker → 沙盒 | 自建网关地址；loopback 会自动改写为 `host.docker.internal` |
| `AGENT_TIMEOUT_MS` | 否 | `600000` | worker | 单个 run 的默认超时（api 也解析，见 §1.1） |
| `AGENT_MAX_CONCURRENT` | 否 | `2` | worker | `agent-runs` 队列并发数 |

### 1.3 沙盒（worker schema）

| 变量 | 必填 | 默认 | 读取方 | 说明 |
|---|---|---|---|---|
| `SANDBOX_IMAGE` | 否 | `agentport/sandbox:dev` | worker | 每次 run 启动的镜像 |
| `WORKSPACES_DIR` | 否 | `./data/workspaces` | worker | 工作区根目录。compose 下为 `/workspaces`，必须与 api 同路径 |
| `HOST_WORKSPACES_DIR` | 否 | 同 `WORKSPACES_DIR` | worker | 宿主视角的工作区路径，`docker -v` 的源路径；compose 默认 `/var/lib/docker/volumes/agentport_workspaces/_data` |
| `SANDBOX_API_URL` | 否 | `http://host.docker.internal:3000` | worker、api（预览） | 沙盒视角的平台地址，写入 generated server 的 `.mcp.json` |
| `SANDBOX_EGRESS` | 否 | `proxy` | worker | `proxy` = bridge + 容器内 `HTTPS_PROXY`；`none` = `--network none`；`open` = bridge 直连。默认 `proxy` 但未设置 `HTTPS_PROXY`/`HTTP_PROXY` 时，启动 warn 并**按 `open` 运行**（不阻塞本地开发） |
| `SANDBOX_MEMORY` | 否 | `1g` | worker | 容器内存上限（Docker 格式，如 `1g`、`512m`） |
| `SANDBOX_CPUS` | 否 | `1` | worker | CPU 核数上限 |
| `SANDBOX_PIDS` | 否 | `128` | worker | PID 上限 |

### 1.4 数据保留

| 变量 | 必填 | 默认 | 读取方 | 说明 |
|---|---|---|---|---|
| `RETAIN_RUN_DAYS` | 否 | `90` | worker | 已终态 run 及其消息的保留天数 |
| `RETAIN_MESSAGE_DAYS` | 否 | `30` | worker | 无 `run_id` 的孤立消息保留天数 |
| `RETAIN_AGENT_VERSIONS` | 否 | `50` | worker | 每个智能体保留的版本数 |

`.env.example` 与本表一致；schema 之外可用的变量（`PLATFORM_MCP_TOKEN`、`RATE_LIMIT_DISABLED` 等）已在上方「不在 schema 中」表中列出。

## 2. 部署

### 2.1 前置

- Node.js 24、pnpm 12.14.0
- Docker Engine + Compose
- 宿主有 `pg_dump` / `psql`（备份与恢复）
- 至少一个模型凭证（`ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`）

### 2.2 Docker Compose

```bash
pnpm install
pnpm run up
```

`pnpm run up`（`scripts/up.sh`）依次执行：

1. `.env` 不存在时从 `.env.example` 复制，随机生成 `APP_SECRET_KEY`、`JWT_SECRET`、`REDIS_PASSWORD`、`PLATFORM_MCP_TOKEN`、`ADMIN_PASSWORD`（同时改写 `REDIS_URL`），并打印管理员密码；运行智能体仍需自行填写模型凭证。
2. `docker compose up -d --build postgres redis`，轮询 `docker compose ps` 直到两者 healthy。
3. 构建沙盒镜像 `agentport/sandbox:dev`（已存在则跳过；`pnpm run up --rebuild` 强制重建）。构建前先执行 `pnpm --filter @agentport/sandbox build` 生成 `dist/`。
4. `docker compose up -d --build api worker`。compose 会先运行一次性服务 `migrate`（`node api/node_modules/@agentport/db/scripts/migrate.js`，`restart: no`），成功后 api 才启动（`depends_on: service_completed_successfully`）。
5. 轮询 `/health/ready`，最多 90 秒。
6. 执行 `bash scripts/smoke.sh`。

任一步失败会打印相关容器状态或日志，并以非零退出。停止服务用 `pnpm run down`（`docker compose down`，保留卷）；`pnpm run down --clean` 使用 `down -v` 删除数据卷。

检查：

```bash
docker compose ps
curl -s http://localhost:3000/health/live
curl -s http://localhost:3000/health/ready
```

`/health/ready` 返回 `{"status":"ok","db":"ok","redis":"ok"}` 即依赖就绪。

说明：

- compose 的 `api`/`worker` 镜像内执行 `pnpm -r build`，不依赖宿主 `dist`；沙盒镜像例外，其 Dockerfile 复制 `packages/sandbox/dist`，由 `pnpm run up` 先构建。
- 迁移由 compose 的 `migrate` 服务自动执行；直接在宿主机操作时仍可用 `pnpm db:migrate`（需要 `packages/db/dist`，先 `pnpm build`）。
- `.env.example` 的 `REDIS_URL` 带 `agentport-dev` 密码，与 compose 的 redis 默认密码一致；若宿主导出了不同的 `REDIS_PASSWORD`，两边都要改。`pnpm run up` 生成 `.env` 时会同时写入匹配的 `REDIS_PASSWORD` 与 `REDIS_URL`。
- compose 会占用 3000、5432、6379；如冲突，先停掉本机对应服务或改端口。
- worker 容器内是 `node` 用户，通过 `group_add: ${DOCKER_GID:-0}` 访问 socket。Linux 上若 docker 组 GID 不是 0，部署前 `export DOCKER_GID=$(getent group docker | cut -d: -f3)`。
- Redis 健康检查（compose 里的 `healthcheck.test`）在容器内使用 redis 服务自身的 `REDIS_PASSWORD`；若宿主另行导出 `REDIS_PASSWORD`，compose 会用它重建 redis，与 `.env` 的 `REDIS_URL` 不一致时 api/worker 连不上。`pnpm run up` 不读取宿主导出的该变量，直接使用 `.env`。
- 生产通过 `http://localhost:3000` 访问；Cookie 带 `Secure`，局域网 IP + HTTP 会无法保持登录。
- 反向代理之后部署时，设置 `TRUST_PROXY=1`（否则限流按代理 IP 计数），并把 `CORS_ORIGINS` 改成浏览器实际访问的 Origin。

#### Docker socket 风险

worker 挂载 `/var/run/docker.sock`，**等价于把宿主 root 权限交给 worker 容器**：任何能控制 worker 的漏洞或恶意智能体镜像都可以启动特权容器、挂载宿主目录。当前实现只适合单机自用、只运行自己配置的智能体。

生产替换方案（按投入从低到高）：

1. **socket proxy**：在宿主前置 `tecnativa/docker-socket-proxy` 之类只放行 container 相关 API 的代理，worker 通过 `DOCKER_HOST` 连接它，不再直接挂 socket。
2. **独立沙盒节点**：worker 通过远程 Docker（`DOCKER_HOST` + TLS）或 microVM 运行时连到隔离主机，平台主机不暴露 socket。
3. **换运行时**：microsandbox / gVisor 等不依赖宿主 Docker 的实现（`SandboxProvider` 接口已预留，见 D-12）。

选择取决于部署形态，记录在 [DECISIONS-PENDING.md](DECISIONS-PENDING.md) D-16。

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

也可以先 `pnpm run up` 完成部署，再停掉 compose 的 api/worker（`docker compose stop api worker`）后 `pnpm dev`；依赖保持运行。

### 2.4 升级

```bash
git pull
pnpm install
pnpm run up --rebuild
```

`pnpm run up` 会重新构建镜像并由 compose 的 `migrate` 服务应用迁移；沙盒镜像仅在传 `--rebuild` 时重建。worker 升级会中断进行中的 run（容器随 `docker rm -f` 清理）；建议在空闲时操作。

## 3. 备份与恢复

### 3.1 备份

```bash
set -a; . ./.env; set +a     # backup.sh 不读 .env，必须已经 export DATABASE_URL
pnpm backup
```

行为（`scripts/backup.sh`）：

- `pg_dump --no-owner --no-privileges --clean --if-exists "$DATABASE_URL" | gzip` 写入 `backups/<YYYYMMDD-HHMMSS>.sql.gz`
- 宿主没有 `pg_dump` 时自动改用 `docker compose exec -T postgres pg_dump`（`DATABASE_URL` 必须能在容器内解析，默认 compose 配置满足）
- 生成后 `gzip -t` 校验，打印文件大小；校验失败删除临时文件并以非零退出
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
set -a; . ./.env; set +a
docker compose stop api worker
pnpm restore backups/20261020-031500.sql.gz
docker compose start api worker
```

`scripts/restore.sh` 的行为：

- 校验备份文件存在且 `gzip -t` 通过，并要求已 export `DATABASE_URL`
- 先用 `pg_dump` 生成 `backups/pre-restore-<timestamp>.sql.gz`；这一步失败就中止，不动库
- `gunzip -c <file> | psql -v ON_ERROR_STOP=1 --single-transaction`：备份自带 DROP/CREATE，整库替换，失败则整体回滚
- 成功后执行 `pnpm db:migrate`，补齐备份之后新增的迁移
- 成功打印 `RESTORE OK <file>`；任一步失败非零退出，并提示安全副本路径

要点：

- 恢复会**清空并替换**目标库，所以要先 `docker compose stop api worker`；同库恢复不需要事先创建空库。
- 保持原来的 `APP_SECRET_KEY`。换了主密钥，`servers.secrets_encrypted` 无法解密，所有 MCP 密钥需要重新填写。
- 恢复后 `pnpm db:migrate` 只为补齐备份之后新增的迁移。
- 如果只恢复单个智能体，用「智能体 → 导出 / 导入」（`agentport/agent@1` JSON）；导出不含密钥明文，只含键名，导入后要重新填写。

### 3.3 恢复演练记录（2026-10-20）

环境：本地 compose（postgres 18.6 / api / worker），宿主未安装 PostgreSQL 客户端，脚本走容器内 `pg_dump` / `psql`。

| 项 | 结果 |
|---|---|
| 数据量 | 备份 484 KiB；`skills` 10、`agents` 16、`agent_runs` 16，迁移 15 条 |
| `pnpm backup`（两次） | 约 0.3 s / 次 |
| 标记记录 | 插入 `skills.slug = restore-drill-20261020-074317` → 确认存在 → 删除 → 确认 0 行 |
| `pnpm restore` | 约 0.9 s，含 pre-restore 副本与迁移 |
| 恢复后校验 | 标记记录回来；`pnpm db:migrate` 通过；`pnpm smoke` 全部 ok（含 /mcp 401 与带 token 的 tools/list） |

遇到的问题：

1. 宿主没有 `pg_dump` / `psql`，原脚本直接报 `command not found`。两个脚本改为缺客户端时回退到 `docker compose exec -T postgres`。
2. 原始 `pg_dump` 输出不带 `DROP`，恢复到已有库会因表已存在失败。备份改为 `--clean --if-exists`，恢复才能直接整库替换。
3. 按「先备份、后建标记」的顺序演练，恢复点早于标记，标记不可能回来。实际做法是建标记后再备份一次，用该备份演练；同一原因下，插入的标记 id 用朴素字符串，`pg_dump` 的 sequence 只覆盖表，不影响结果。
4. `pnpm restore` 依赖 `DATABASE_URL` 已 export（与 `pnpm backup` 相同）；迁移步骤会把 `DATABASE_URL` 显式传给 `pnpm db:migrate`，不依赖 `.env`。

遗留：

- 单机库直接恢复；生产应恢复到新库、验证后再切流量，当前脚本仍会替换目标库。
- 脚本用 `--single-transaction`，大库恢复时长受单个事务限制。
- `backups/` 含密钥密文与审计数据，注意同步盘权限；演练产生的三个文件仍留在本地，确认后可删。

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

- 事件流在 Redis 中保留 1 小时（`run:<runId>:events`，最多 1000 条），过期后不能回放，但 `messages` 仍可还原主线。
- 终态 run 及其消息会被每日维护任务按 `RETAIN_RUN_DAYS` 清理；`/api/runs` 只展示仍保留的数据。
- 取消一个 queued 的 run 只会标记终态，worker 消费时会跳过；取消 running 的 run 会向容器发 SIGTERM。

## 5. 故障排查

| 症状 | 可能原因 | 检查命令 / 处理 |
|---|---|---|
| `/health/ready` 返回 503，`db` 或 `redis` 为 `error` | 依赖未启动、连接串错误、容器不健康 | `docker compose ps`；`docker compose logs postgres redis`；`curl -s localhost:3000/health/ready`；确认 `.env` 的 `DATABASE_URL` / `REDIS_URL` 与实际端口一致 |
| `docker compose ps` 中 redis 一直 `health: starting`，api/worker 不启动 | 宿主导出了与 `.env` 不同的 `REDIS_PASSWORD`，compose 用它重建了 redis，而 `.env` 的 `REDIS_URL` 仍是旧密码 | `unset REDIS_PASSWORD` 后 `docker compose up -d --force-recreate redis api worker`；或让 `.env` 的 `REDIS_PASSWORD`/`REDIS_URL` 与导出的值一致；确认用 `docker compose exec redis redis-cli -a "$REDIS_PASSWORD" ping` |
| 日志报 `Could not find a working container runtime strategy` 或 `Cannot connect to the Docker daemon` | worker 无法访问宿主 Docker socket | 在 worker 容器内 `docker ps`；检查 `/var/run/docker.sock` 挂载与 `DOCKER_GID`（`ls -l /var/run/docker.sock`，`getent group docker`） |
| run 失败，错误含 `no such image` / `pull access denied` | 沙盒镜像未构建或名字不对 | `docker images agentport/sandbox`；`pnpm --filter @agentport/sandbox build && pnpm --filter @agentport/sandbox image`；核对 `SANDBOX_IMAGE` |
| 模型调用 401 / 403 | 凭证缺失、失效，或 `ANTHROPIC_BASE_URL` 在容器内不可达 | `docker compose logs worker` 看容器 stderr；确认 `.env` 只填了 `ANTHROPIC_API_KEY` 与 `ANTHROPIC_AUTH_TOKEN` 之一；`ANTHROPIC_BASE_URL` 不要写 `127.0.0.1`（worker 会改写为 `host.docker.internal`，Linux 需 Docker 支持该别名） |
| MCP 工具未出现在智能体上下文 | 未绑定 server、工具被禁用、绑定关系未保存，或 server 连接失败 | 「MCP Servers」页点「测试」看 `listTools()`；检查 generated server 的工具是否 `enabled`；「智能体 → 文件预览」确认 `.mcp.json` 含该 server；运行详情看拒绝原因（`permissionMode=dontAsk` 下未预批准会直接拒绝） |
| `mcp__<server>__tool` 被拒绝 | 允许规则写成了 `mcp__*`，或 server 名与绑定名不一致 | 规则由 worker 按 `.mcp.json` 的 server key 生成 `mcp__<name>__*`；不要手写 `mcp__*`；在文件预览核对 server key |
| 队列堆积，run 一直 `queued` | worker 未启动、并发占满、Redis 不可用 | `curl -s localhost:3000/health/metrics` 看 `queue.waiting/active`；`docker compose logs worker`；确认 `AGENT_MAX_CONCURRENT`；`docker compose ps worker` |
| SSE 无输出或立即断开 | 未登录（401 后前端跳登录）、反向代理缓冲、run 尚未开始、事件流已过期 | `curl -N -b "agentport_token=<token>" http://localhost:3000/api/chat/<runId>/events`；代理需关闭 buffering（代码已发 `X-Accel-Buffering: no`）；确认 run 状态不是 `queued`；事件流 TTL 为 1 小时 |
| generated server 在沙盒内 401 | `.mcp.json` 里的 `mcpToken` 与数据库不一致，或平台地址不可达 | 短期 token 只在 run 期间有效，run 结束后 401 属预期；外部客户端用长期 `mcpToken`（页面「轮换 token」后旧值立即失效）；确认 `SANDBOX_API_URL` 从容器可达（`docker run --rm curlimages/curl -s $SANDBOX_API_URL/health/live`） |
| 页面登录成功但刷新后退出 | 生产 Cookie 带 `Secure`，却用 HTTP + 非 localhost 访问 | 用 `http://localhost:3000`，或在明确可信的内网终止 TLS 后访问；不要把 `NODE_ENV` 改成 development 来绕过 |
| 修改 schema 后报 `column ... does not exist` | 只改了 `schema.ts`，未生成或未应用迁移 | `pnpm db:generate && pnpm db:migrate`；迁移文件按顺序应用，不要手改已应用的迁移 |
| 登录返回 429 | 登录限流 10 次/分钟（按 IP）；反向代理后未设 `TRUST_PROXY=1` 时所有请求共用代理 IP | 等一分钟；确认 `TRUST_PROXY=1`；只在本地/测试环境可临时 `RATE_LIMIT_DISABLED=1` 后重启 api |
| `pnpm backup` 报 `DATABASE_URL is required` | 脚本不读取 `.env` | `set -a; . ./.env; set +a; pnpm backup` |
| `pnpm backup` / `pnpm restore` 报 `pg_dump`、`psql` 或 `docker compose` 找不到 | 宿主既没有 PostgreSQL 客户端，也不在项目目录运行 | 在项目根目录运行；安装 `postgresql` 客户端，或保持 compose 的 postgres 容器运行 |
| generated server 在沙盒内 401 | run 的短期 token 已过期/被清空，或 `.mcp.json` 未带上 `x-agentport-run-id` | 确认 run 仍为 `running`；不要手工改工作区文件；run 结束后短期 token 必然失效，属预期 |
| worker 退出并报 `Invalid environment` | `.env` 缺少必填项或长度不足 | 按报错里的字段名补齐；`APP_SECRET_KEY`、`JWT_SECRET` ≥32，`ADMIN_PASSWORD` ≥12 且不是常见默认口令 |
| 运行超时 | `timeoutMs` 太小、模型慢、工具上游慢 | 运行详情看 `latencyMs` 与最后一步；调大智能体的 `timeoutMs`；检查上游 API 延迟 |
| 评估跑批一直 `running` | 跑批在 worker 的 `eval-runs` 队列串行执行；worker 未运行、重启或 job 丢失会让它停在 running | 确认 worker 在运行；超过 1 小时的 running 会被 reconciler 置为 `failed`（`eval run lost`），之后重新发起跑批 |

常用观察命令：

```bash
docker compose logs -f api worker
docker compose ps
curl -s localhost:3000/health/metrics
set -a; . ./.env; set +a
redis-cli -u "$REDIS_URL" llen bull:agent-runs:wait
redis-cli -u "$REDIS_URL" xlen run:<runId>:events
docker ps --filter name=agentport-
```

`redis-cli` 不是项目依赖；本机没装时用 `docker compose exec redis redis-cli -a "$REDIS_PASSWORD" ...`。

## 6. 观测入口

| 入口 | 内容 | 鉴权 |
|---|---|---|
| `GET /health/live` | 进程存活 | 无 |
| `GET /health/ready` | DB 查询 + Redis ping；任一失败返回 503 与 `status: degraded` | 无 |
| `GET /health/metrics` | 进程（uptime、RSS、Node 版本）、队列计数、连接池、Redis ping 延迟；单项失败返回 `null`，整体仍 200 | 无 |
| `/api/overview` | 统计卡、智能体聚合（运行数、成本、错误率、P50/P99、tokens）、最近 20 条运行；`days` 限制 1–3650 | 登录 |
| `/api/runs`、`/api/runs/:id` | 运行列表与 trace 步骤 | 登录 |
| `/api/audit` | 审计事件，可按 action / status / 时间过滤 | 登录 |
| 页面「审计」 | 同上，按时间倒序 | 登录 |
| 页面「运行」→ 详情 | 状态、耗时、轮次、成本、token、错误、步骤时间线（子智能体内部调用缩进）；「用同样输入重新运行」 |
| 页面「系统状态」`/status` | live / ready / metrics 三面板，10 秒刷新；浏览器内只读自检 | 登录（接口本身无鉴权） |
| api 日志 | pino JSON（生产）/ pino-pretty（开发）；按路由模板记录，>2s 记 `slow request`，SSE 不打慢请求 | stdout |
| worker 日志 | 结构化 JSON；每步带 `runId`，容器 stderr 以 `sandbox` 字段转发 | stdout |

审计动作包括：`auth.login.succeeded`、`auth.login.failed`、`auth.logout`、`server.created/updated/deleted`、`mcp.server.tested`、`server.tool.created/updated/deleted`、`agent.created/updated/deleted/rolled_back/imported`、`skill.created/updated/deleted`、`agent.run.requested/approved/cancelled/finished`、`conversation.branched`、`eval.case.created/updated/deleted`、`eval.run.requested`、`maintenance.pruned`。审计只存输入摘要（SHA-256 前 32 位），不存原文。

## 7. 性能备注

- **索引**（0009 迁移）：`agent_runs(started_at DESC NULLS LAST, id DESC)` 与 `agent_runs(agent_id, started_at DESC NULLS LAST, id DESC)` 服务 `/api/runs` 与概览的「最近运行」排序；`messages(run_id)` 服务 run trace 查询；`messages(conversation_id, created_at, id)` 让会话消息免排序。改动见 `packages/db/src/schema.ts`，重新生成用 `pnpm db:generate`。
- **连接池可配**：`packages/db/src/client.ts` 读 `DB_POOL_MAX`（默认 10），api 与 worker 各自独立一个池。`/api/overview` 的 servers/agents 计数已并行，running/runs 聚合与最近运行也并行；单个请求仍会执行多条 SQL。
- **会话列表**：`/api/conversations` 的 `lastMessage` 只返回截断到 280 字的 `text`，不再回传整块 jsonb；`limit` 上限 200。
- **概览页**：`/api/overview` 已含 servers/agents 计数，前端不再额外请求 `/api/servers`、`/api/agents`；`/api/overview` 返回 404 时才回退到列表接口。
- **本机基线**（20 次 curl，改前 → 改后，p50/p95）：`/api/overview` 8.0/9.7 → 6.9/8.8 ms；`/api/runs` 3.1/4.9 → 3.1/4.0 ms；`/api/conversations` 3.4/5.3 → 3.0/5.1 ms（响应 8009 → 6820 B）。数据量很小时数据库耗时不占主导，收益主要来自索引在数据增长后避免全表扫描 + 排序。
- **未做**：`/api/agents`、`/api/skills`、`/api/eval/*` 列表仍无分页；当前单机数据量下影响可忽略，智能体/技能数量上来后再加 `limit`。MCP 端点每次请求重查 server + tools，属于配置即时生效的取舍，不在本次范围。

## 8. 压力测试结果

### 8.1 方法与环境

脚本 `scripts/loadtest.mjs`（纯 Node，无依赖）：

```bash
ADMIN_PASSWORD='...' node scripts/loadtest.mjs
# 可选：BASE_URL / ADMIN_USER / PLATFORM_MCP_TOKEN / DATABASE_URL
# 脚本会自动读取仓库根目录的 .env；API 未启动时打印提示并 exit 1。
```

只创建 slug 以 `loadtest-` 开头的智能体/技能；开始与结束各清理一次（DB 行、工作区目录、审计记录）。每次运行会产生约 12 次真实模型调用（单次约 $0.005），并留下几条 `auth.login.succeeded` 审计和 Redis 中最近 100 条完成的 BullMQ job，这两项无法按前缀安全清理。

测试环境（2026-10-20，单机）：

| 项 | 值 |
|---|---|
| 宿主 | macOS，12 逻辑核，API / worker / Postgres / Redis / 压测客户端同机 |
| API | Node v24.22.0，tsx dev，Fastify；pg 连接池 `max: 10`（当时硬编码；现由 `DB_POOL_MAX` 配置，默认仍为 10） |
| 数据库 | Postgres 18-alpine，`max_connections=100`，`shared_buffers=128MB`；测试时 3 agents / 2 skills / 1 server / 14 runs / 43 messages |
| worker | `AGENT_MAX_CONCURRENT=2`，`SANDBOX_MEMORY=1g`，模型 `claude-sonnet-5-5` |
| 读接口 | 50 并发 × 20 轮（每接口 1000 样本）；另做 100 / 200 并发 × 10 轮找拐点 |
| 指标 | 每 100ms 采样 `/health/metrics`，记录 RSS、`pool.waitingCount`、队列深度；`docker stats` 采样 CPU |

### 8.2 结果

读接口（错误率均为 0；RSS 为 API 进程采样峰值）：

| 场景 | 样本 | p50 | p95 | p99 | 吞吐 req/s | 峰值 RSS | 池等待峰值 |
|---|---|---|---|---|---|---|---|
| `GET /api/overview` ×50 | 1000 | 23.4 ms | 28.0 ms | 73.0 ms | 1717 | 393 MB | 40 |
| `GET /api/runs` ×50 | 1000 | 7.9 ms | 10.6 ms | 14.1 ms | 4542 | 393 MB | 3 |
| `GET /api/agents` ×50 | 1000 | 14.3 ms | 17.2 ms | 17.6 ms | 2806 | 393 MB | 136 |
| `GET /api/overview` ×100 | 1000 | 44.1 ms | 51.1 ms | 65.7 ms | 1917 | 393 MB | 90 |
| `GET /api/agents` ×100 | 1000 | 27.8 ms | 33.5 ms | 34.5 ms | 2863 | 393 MB | 260 |
| `GET /api/overview` ×200 | 2000 | 87.2 ms | 99.1 ms | 114 ms | 1961 | 399 MB | 115 |
| `GET /api/agents` ×200 | 2000 | 55.2 ms | 66.2 ms | 67.4 ms | 2882 | 401 MB | 498 |
| `GET /api/runs` ×200 | 2000 | 29.7 ms | 39.6 ms | 40.6 ms | 4706 | 402 MB | 159 |
| `GET /health/live` ×200（对照） | 2000 | 3.5 ms | 5.1 ms | 7.3 ms | 28534 | - | - |

池等待峰值 = 采样到的 `db.waiting` 最大值；`db.total` 始终为 10，即连接池打满后请求在进程内排队。

写接口、SSE、MCP：

| 场景 | 结果 |
|---|---|
| `POST /api/skills` 并发 20 | 20/20 成功（201），p50 5.2 / p95 5.5 / p99 5.6 ms，错误率 0；20 条随后删除成功 |
| SSE 20 个客户端订阅同一 run | 20/20 建立连接（全部拿到 ≥37 个事件），连接 p50 3.7 / p95 3.8 ms；API RSS 402.3 → 402.3 MB（+0.05 MB），无错误 |
| `POST /mcp` `tools/list` 并发 20 | 20/20 成功，p50 19.1 / p95 27.5 / p99 28.2 ms（其他轮次 p50 低至 9 ms） |
| 队列：并发投递 10 个 chat run | 10/10 返回 202（提交 p95 44 ms）；全部 succeeded；排队 p50 5.0 s / p95 10.5 s / max 10.9 s；队列峰值 waiting 8 / active 2；worker RSS 峰值 123 MB，沙盒容器峰值 2 个 |

CPU 采样：API 峰值约 117%，Postgres 峰值约 111%，Redis 峰值约 2%（12 核宿主）。宿主机整体远未打满。

### 8.3 第一个瓶颈

**API 的 Postgres 连接池（当时硬编码 `max: 10`，现为 `DB_POOL_MAX`）与读接口的查询条数，是系统在压力下先撞到的墙；不是 HTTP 层，也不是宿主机 CPU。**

依据：

1. **HTTP 层有大量余量**：同一客户端、同样 200 并发，`/health/live` 达到 28534 req/s（p50 3.5 ms），而 `/api/overview` 只有 1961 req/s。差距来自请求进入业务后的数据库访问。
2. **吞吐在 100 并发后不再增长，延迟随并发线性上升**：`/api/overview` 50→100→200 并发时吞吐 1717→1917→1961 req/s，p50 23.4→44.1→87.2 ms。这是固定服务能力被打满的典型形态（Little's law）。
3. **连接池确实在排队**：每个 `/api/overview` 请求执行 6 条 SQL（部分并行），池只有 10 条连接；200 并发时 `db.waiting` 峰值 115，`/api/agents`（4 条查询）峰值 498。`/api/runs` 只有 1 条查询，同样并发下仍有 4706 req/s、p50 29.7 ms，说明瓶颈是“查询条数 × 池大小”，而不是数据量或索引。
4. **数据库与 CPU 尚未打满**：测试数据集很小（14 runs），Postgres CPU 峰值约 1.1 核，Redis 约 2%，宿主机 12 核。提高池上限或减少查询条数可以直接换取吞吐，不需要先扩容机器。

第二个瓶颈是 **worker 并发 `AGENT_MAX_CONCURRENT=2`**：单次 run 固定成本约 2.5–3.3 s（主要是拉容器和启动 SDK，简单 prompt 也一样），因此 run 吞吐约 0.7 个/秒。10 个 run 同时投递时 p95 排队 10.5 s、峰值 waiting 8，与理论 FIFO 完全吻合，队列本身没有额外异常，只是并发上限低。

未发现 SSE、MCP、写接口在本次并发量下有问题：SSE 内存不增长（同一 run 的多个订阅者共用一条 Redis 订阅），MCP 每个请求重建 handler 的取舍在 20 并发下仍是 10–20 ms。

### 8.4 建议参数

1. **先改读接口的查询形态**（收益最大、无配置风险）：`/api/overview` 的 counts（servers/agents/running/runs）合并成一条 SQL，其余两条重查询与它并行；`packages/api/src/features/agents/routes.ts` 的 4 条查询已是 1+3 并行，可只把首条列表查询与关联查询合并。预期 200 并发下 p95 从约 100 ms 降到 40–50 ms，吞吐约翻倍。
2. **连接池可配置（已实现）**：`packages/db/src/client.ts` 读取 `DB_POOL_MAX`（默认 10）。单 API 实例、Postgres `max_connections=100` 时，20–30 安全；但若不同时做第 1 条，翻倍池只是把压力更早推给 Postgres。worker 另有独立连接池，扩容时一并计入。
3. **读接口补限流**：当前 `global: false`，只有显式配置的路由计数（登录 10/min、chat 20/min、`/mcp` 与 `/mcp/:serverId` 各 60/min、连接测试 20/min、评估发起 10/min），读接口完全不计流（压测中 2000 次读请求无 429）。若要暴露到 localhost 之外，建议读接口加 600 次/分/IP；单管理员场景下 chat 的 20 次/分偏低（两次突发落在同一分钟就会 429，本次压测已复现 2/10 被拒），可提到 60 次/分或按登录用户计数。
4. **worker 并发按内存定**：每个沙盒上限 `SANDBOX_MEMORY=1g`，把 `AGENT_MAX_CONCURRENT` 从 2 提到 4 可把 10 个 run 的 p95 排队从约 10.5 s 降到约 5 s，代价是 4 GB 沙盒内存与更多宿主 CPU；若 run 量继续增长，优先做容器预热池来消掉每次 2.5–3.3 s 的固定启动成本。
5. **观测告警线**：`/health/metrics` 的 `db.waiting > 5` 持续 10 s，或队列 `waiting > 10`，即可认为已进入本次测出的瓶颈区。

### 8.5 复现注意

- 脚本会等待 chat 限流窗口重置（上一次测试的请求可能仍在 60 s 窗口内），因此整体耗时约 2 分钟。
- 需要 api 与 worker 都在运行；只跑 api 时队列测试会一直排队到超时后取消。
- 测试使用真实模型调用并产生费用；不要在生产实例上运行。
- 清理仅按 `loadtest-` slug 前缀进行，不会触碰用户已有数据；如中断，重新运行脚本会在开始阶段清理上一轮残留。


## 9. 运行测试的前提

`pnpm test` 的集成用例会创建真实的 run 记录，并断言它们停留在 `queued`/`cancelled` 状态。如果此时有 **worker 在消费 `agent-runs` 队列**（本地 `pnpm dev` 或 `docker compose` 的 worker 服务），它会立刻把这些 run 跑掉，导致测试失败。

```bash
docker compose stop worker api   # 或在本地 pnpm dev 里停掉 worker
pnpm test
docker compose start api worker  # 测完恢复
```

E2E（`pnpm test:e2e`）相反：它需要 api + web，但不需要 worker（除非 `E2E_FULL=1`）。
