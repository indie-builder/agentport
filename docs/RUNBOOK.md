# 运维手册（Runbook）

> 面向「凌晨被叫起来」的处置手册：每条按 **症状 → 判断命令 → 处置 → 验证** 展开。
> 环境变量清单、部署流程、备份策略见 [OPERATIONS.md](OPERATIONS.md)，这里不重复。
>
> 约定：命令都在仓库根目录执行；需要 `DATABASE_URL` / `REDIS_URL` 时先 `set -a; . ./.env; set +a`。
> 容器内命令用 `docker compose exec -T <service>`，不依赖宿主机安装 psql / redis-cli。

## 0. 先做三件事

1. 打开页面「系统状态」（`/status`），或用 curl 看端点（`/health/metrics` 需要登录 Cookie）：

```bash
curl -sS -w '\nHTTP %{http_code}\n' http://localhost:3000/health/live
curl -sS -w '\nHTTP %{http_code}\n' http://localhost:3000/health/ready
curl -sS -b "agentport_token=<登录后的会话 Cookie>" http://localhost:3000/health/metrics | jq .
```

2. 看容器与最近日志：

```bash
docker compose ps
docker compose logs --tail=120 api worker
```

3. 任何破坏性操作（恢复、删工作区、改密钥）之前，先备份：

```bash
set -a; . ./.env; set +a; pnpm backup
```

`/health/live`、`/health/ready` **没有鉴权**，`/health/metrics` 需要登录（`requireAuth`），不要直接暴露到公网；只经由反向代理的内网路径或本机访问。后文所有 `/health/metrics` 命令都假定先设置登录 Cookie：

```bash
AUTH='-b agentport_token=<登录后的会话 Cookie>'
```

---

## 1. 服务完全不响应

**症状**：浏览器超时/连接被拒，`curl localhost:3000/health/live` 无响应或 connection refused。

### 判断

```bash
docker compose ps -a
docker compose logs --tail=200 api
docker info >/dev/null 2>&1; echo "docker:$?"
```

- api 显示 `Exited` / `Restarting` → 看日志里的启动错误（多半是 `.env` 校验失败）。
- `docker info` 非零 → Docker daemon 没起来。
- api `Up` 但 curl 不通 → 端口没发布、进程还在启动、或宿主端口被占用。
- 所有容器都正常但页面 502 → 反向代理问题，检查代理到 `127.0.0.1:3000`。

端口与磁盘：

```bash
# macOS / Linux 二选一
lsof -nP -iTCP:3000 -sTCP:LISTEN
ss -ltnp 'sport = :3000'
df -h /
df -i /
docker system df
```

数据库/Redis 因磁盘满而拒绝写入时，api 会卡在迁移或启动阶段，表现也是「完全不响应」。

### 处置

```bash
# Docker daemon 未运行
# Linux:
sudo systemctl start docker
# macOS (Docker Desktop):
open -a Docker

# 配置错误：按日志补齐 .env 后重启（只重启不重建）
docker compose up -d --force-recreate api worker

# 端口被占用：停掉占用进程，或临时改 compose 的 "3000:3000" 左侧端口
# 磁盘满：先清可再生的东西（见 §7）
docker builder prune -f
docker image prune -f
```

不要用 `docker compose down -v` 排障——它会删除数据库、Redis 与工作区卷。

### 验证

```bash
curl -fsS http://localhost:3000/health/live && echo OK
curl -fsS http://localhost:3000/health/ready
docker compose ps
```

页面 `/status` 的「存活检查」应变为「正常」。

---

## 2. `/health/ready` 返回 503

**症状**：`{"status":"degraded","db":"ok|error","redis":"ok|error"}`，或页面「就绪检查」显示不可用。

### 2.1 数据库不可用（`"db":"error"`）

**判断**

```bash
docker compose ps postgres
docker compose logs --tail=100 postgres
docker compose exec -T postgres pg_isready -U agentport -d agentport
docker compose exec -T postgres psql -U agentport -d agentport -c 'select 1'
```

再看 api 日志里的具体错误：

```bash
docker compose logs api | grep -i 'readiness: db check failed' | tail -5
```

常见原因：postgres 容器未 healthy、`DATABASE_URL` 指向错误主机/端口/密码、磁盘满、`max_connections` 耗尽（见 §5）。

**处置**

```bash
# 依赖没起来（幂等）
docker compose up -d postgres
# 密码/DATABASE_URL 改动后重建
docker compose up -d --force-recreate postgres api worker
# 磁盘满先按 §7 清理；连接耗尽按 §5 处理
```

**验证**

```bash
curl -sS -w '\nHTTP %{http_code}\n' http://localhost:3000/health/ready
```

### 2.2 Redis 不可用（`"redis":"error"`）

**判断**

```bash
docker compose ps redis
docker compose logs --tail=100 redis
docker compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning ping'
docker compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning info server | head'
```

api 日志：

```bash
docker compose logs api | grep -i 'readiness: redis check failed' | tail -5
```

常见原因：Redis 未 healthy、compose 重建时用了与 `.env` 不同的 `REDIS_PASSWORD`、内存打满（见 §6）。

**处置**

```bash
# 宿主导出了不同的 REDIS_PASSWORD 时先清掉，再让两边一致
unset REDIS_PASSWORD
docker compose up -d --force-recreate redis api worker
```

**验证**

```bash
docker compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning ping'
curl -sS -w '\nHTTP %{http_code}\n' http://localhost:3000/health/ready
```

---

## 3. 智能体运行全部失败

**症状**：新 run 都是 `failed`，错误类似 `no such image`、`Cannot connect to the Docker daemon`、`401`。

### 3.1 先看错误原文

```bash
set -a; . ./.env; set +a
docker compose exec -T postgres psql -U agentport -d agentport -c \
  "SELECT id, status, left(error, 160) AS error, started_at
   FROM agent_runs ORDER BY started_at DESC NULLS LAST LIMIT 10;"
docker compose logs --tail=200 worker
```

按错误分三类处理。

### 3.2 沙盒镜像缺失 / 名字不对

**判断**

```bash
docker image inspect agentport/sandbox:dev >/dev/null 2>&1; echo "image:$?"
grep '^SANDBOX_IMAGE=' .env
```

**处置**

```bash
# 推荐：从仓库根构建 sandbox target，安装与构建都在镜像内完成
pnpm run up --rebuild
# 手动等价
docker build --target sandbox -t agentport/sandbox:dev .
# 或包脚本（同样从仓库根 context 构建）
pnpm --filter @agentport/sandbox image
# 若 .env 的 SANDBOX_IMAGE 不是这个名字，改成上面的 tag 后重启 worker
docker compose up -d --force-recreate worker
```

旧文档里的 `packages/sandbox/shared`、`package.shared.json` / `package.docker.json` 已删除；出现 `COPY shared/: not found` 说明仍在执行旧命令或使用旧构建上下文。

**验证**：在页面发起一次最简单对话，`agent_runs.status` 变为 `succeeded`。镜像本身只验证存在性：

```bash
docker image inspect agentport/sandbox:dev --format '{{.Id}} {{.Created}}'
docker compose logs --tail=100 worker | grep -i 'sandbox'
```

### 3.3 Docker daemon / socket 不可达

**判断**

```bash
docker compose exec -T worker docker ps
ls -l /var/run/docker.sock
docker compose exec -T worker id
```

报 `permission denied` 是 worker 的 `node` 用户没有 socket 权限；`Cannot connect` 是 socket 没挂上或 daemon 停了。

**处置**

```bash
# Linux: 把 DOCKER_GID 设为宿主 docker 组的 GID
export DOCKER_GID=$(getent group docker | cut -d: -f3)
docker compose up -d --force-recreate worker
```

`DOCKER_GID` 要写进 `.env` 才会在下次 `pnpm run up` 保留。Docker Desktop 默认 socket 为 `root:root`，`DOCKER_GID=0` 即可。

**验证**

```bash
docker compose exec -T worker docker ps
```

### 3.4 模型凭证缺失或失效

**判断**（只确认变量存在，不打印值）

```bash
docker compose exec -T worker sh -c 'env | grep -o "^ANTHROPIC_[A-Z_]*" | sort'
docker compose logs --tail=100 worker | grep -iE '401|403|unauthorized|authentication'
```

期望只出现 `ANTHROPIC_API_KEY` **或** `ANTHROPIC_AUTH_TOKEN` 之一（两个都填会以其中一种方式发送，容易互相覆盖）。

**处置**

```bash
# 编辑 .env，填入正确的 key / token；不要写 127.0.0.1 作为 BASE_URL
docker compose up -d --force-recreate worker
```

自建网关时确认沙盒可达：`ANTHROPIC_BASE_URL` 的 loopback 会被 worker 改写为 `host.docker.internal`，Linux 需要 Docker 支持 `host-gateway`（当前 compose 已加 `--add-host`）。

**验证**（会产生一次极小费用；不想产生就用页面跑一次真实 run）

```bash
set -a; . ./.env; set +a
curl -sS https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H 'anthropic-version: 2023-06-01' \
  -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-5-5","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}' \
  | head -c 300
```

返回 `type":"message"` 即凭证有效；`authentication_error` 说明 key 无效，`permission_error` 说明 key 无权访问该模型。

---

## 4. 队列堆积

**症状**：run 一直 `queued`，`/health/metrics` 的 `queue.waiting` 持续增长，`/status` 队列卡片黄色或红色。

### 4.1 判断：worker 是否在消费

```bash
set -a; . ./.env; set +a
docker compose ps worker
docker compose logs --tail=150 worker
docker compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning LLEN bull:agent-runs:wait'
docker compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning LLEN bull:agent-runs:active'
docker compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning ZCARD bull:agent-runs:delayed'
```

- `worker` 不在运行 / 反复重启 → 看日志里的启动错误。
- `wait > 0` 且 `active == 0` → worker 没有消费能力。
- `active` 等于 `AGENT_MAX_CONCURRENT` → 并发占满，属于容量问题。
- `active` 有值但长时间不变 → 单个 run 卡住。

### 4.2 worker 挂了

```bash
docker compose up -d worker
docker compose logs -f worker
```

队列在 Redis 里，worker 恢复后会继续消费；API/worker 重启丢失的 running run 由 worker 的 reconcile 任务在「超时 + 5 分钟」后收敛为 `failed`。

**验证**

```bash
curl -sS $AUTH http://localhost:3000/health/metrics | jq '.queue'
```

### 4.3 并发太低

**判断**：`active` 长期等于 `AGENT_MAX_CONCURRENT`，且每个 run 的耗时正常。

```bash
grep '^AGENT_MAX_CONCURRENT=' .env
docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}' | grep -E '^(pace-session-|agentport-)'
```

**处置**：按资源定并发。每个沙盒受 `SANDBOX_MEMORY`（默认 `1g`）上限约束；会话复用后，正常完成或成功取消的容器会在 `SANDBOX_IDLE_TIMEOUT_MS` 内热空闲并继续占用资源，实际容器数可能高于活跃 run 数。活跃并发上限不等于容器总数；本机没有实测热空闲容器的内存，不要据此推算新的并发上限。扩容前用上面的 `docker stats` 按全部会话容器观察。

```bash
# 编辑 .env: AGENT_MAX_CONCURRENT=4
docker compose up -d --force-recreate worker
```

**验证**：`/health/metrics` 的 `queue.active` 能稳定到新值，`waiting` 开始下降。

### 4.4 单个 run 卡死

**判断**

```bash
docker ps --filter 'name=^pace-session-' --format '{{.Names}}\t{{.Status}}\t{{.Image}}'
docker logs --tail=100 <容器名>
docker compose logs --tail=100 worker | grep -i '<runId>'
```

**处置**（从轻到重）

1. 页面「运行 → 详情」点取消：停止本轮执行，不再直接向整个会话容器发 SIGTERM。本轮确认停稳后保留容器供同一会话后续复用；重复取消幂等。
2. 无法确认本轮停稳（清理失败、状态不明或超时）时，宿主兜底删除该会话容器。回收容器不删除宿主上的 `sdk-sessions/` 与 `agent-memory/`，下一轮可新建容器并恢复同一会话。
3. 取消后本轮仍不结束时，先看 worker 日志里的 runId 与容器状态，确认没有工具副作用后再强制删容器；这属于异常兜底，会销毁复用容器：

```bash
docker rm -f <容器名>
```

4. worker 整体卡住时重启；running 的 run 由 reconcile 在超时后收敛：

```bash
docker compose restart worker
```

4. 确认没有活跃 run 后才允许直接改库（先停 worker，避免被覆盖）：

```bash
docker compose stop worker
docker compose exec -T postgres psql -U agentport -d agentport -c \
  "UPDATE agent_runs SET status='failed', error='manual reset', ended_at=now()
   WHERE status IN ('queued','running') AND started_at < now() - interval '2 hours';"
docker compose start worker
```

**验证**

```bash
curl -sS $AUTH http://localhost:3000/health/metrics | jq '.queue | {waiting, active, failed}'
```

---

## 5. 数据库连接耗尽

**症状**：接口间歇性 500 / 超时，`/health/metrics` 的 `db.waiting` 持续大于 5；日志出现 `remaining connection slots are reserved` 或 `too many clients`。

### 判断

```bash
set -a; . ./.env; set +a
docker compose exec -T postgres psql -U agentport -d agentport -c \
  "SELECT state, count(*) FROM pg_stat_activity WHERE datname='agentport' GROUP BY state ORDER BY 2 DESC;"
docker compose exec -T postgres psql -U agentport -d agentport -c \
  "SELECT pid, usename, application_name, state, wait_event_type,
          now()-state_change AS age, left(query,80) AS query
   FROM pg_stat_activity WHERE datname='agentport'
   ORDER BY age DESC LIMIT 20;"
docker compose exec -T postgres psql -U agentport -d agentport -c 'SHOW max_connections;'
grep '^DB_POOL_MAX=' .env
```

对照：api 与 worker **各自**建一个池，理论上限约为 `2 × DB_POOL_MAX`，再加迁移/备份连接。`total` 长期等于 `DB_POOL_MAX` 且 `waiting` 高，说明是池太小；`pg_stat_activity` 里大量 `idle in transaction` 则是代码层长事务。

### 处置

```bash
# 1) 终止最老的 idle in transaction（只杀确认无用的）
docker compose exec -T postgres psql -U agentport -d agentport -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
   WHERE datname='agentport' AND state='idle in transaction'
     AND now()-state_change > interval '5 minutes';"

# 2) 临时提高池上限（先确认 max_connections 有余量）
#    编辑 .env: DB_POOL_MAX=20
docker compose up -d --force-recreate api worker
```

若 `max_connections` 确实不够，再在 compose 的 postgres `command` 里加 `-c max_connections=200`；这是最后手段，连接越多内存开销越大。

**验证**

```bash
curl -sS $AUTH http://localhost:3000/health/metrics | jq '.db'
docker compose exec -T postgres psql -U agentport -d agentport -c \
  "SELECT count(*) FROM pg_stat_activity WHERE datname='agentport';"
```

`waiting` 应回落到个位数，接口 p95 恢复。

---

## 6. Redis 内存告警

**症状**：Redis 内存持续上涨；日志出现 `OOM command not allowed`、`maxmemory` 相关错误；队列开始报错。

### 判断

```bash
set -a; . ./.env; set +a
docker compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning INFO memory | grep -E "used_memory_human|maxmemory_human|maxmemory_policy"'
docker compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning DBSIZE'
docker compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning --scan --pattern "run:*:events" | wc -l'
docker compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning --scan --pattern "bull:agent-runs:*" | wc -l'
```

当前 compose **没有设置 `maxmemory`**（默认 0 = 不限制），所以「告警」通常来自容器/宿主内存压力，而不是 Redis 自己拒绝写入。

事件流 `run:<runId>:events` 每次写入都会续 1 小时 TTL；**BullMQ 的队列键没有 TTL**，靠 `removeOnComplete: 100` / `removeOnFail: 200` 限量。

### 处置

```bash
# 1) 找出最大的键（抽样 1000 个，避免全库 SCAN 卡顿）
docker compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning --scan --pattern "*" | head -1000 | while read -r k; do echo "$(redis-cli -a "$REDIS_PASSWORD" --no-auth-warning MEMORY USAGE "$k" 2>/dev/null) $k"; done | sort -rn | head -20'

# 2) 删除已过期的 run 事件流（TTL 已有，正常会自己消失；这里处理历史遗留）
docker compose exec -T redis sh -c 'for k in $(redis-cli -a "$REDIS_PASSWORD" --no-auth-warning --scan --pattern "run:*:events"); do t=$(redis-cli -a "$REDIS_PASSWORD" --no-auth-warning TTL "$k"); [ "$t" = "-1" ] && redis-cli -a "$REDIS_PASSWORD" --no-auth-warning DEL "$k" >/dev/null; done'

# 3) 清理 BullMQ 的终态记录（只删 completed/failed 的 job 与日志，不碰排队/运行中的 job）
docker compose exec -T -w /app/worker worker node --input-type=module -e "
import { Queue } from 'bullmq';
const q = new Queue('agent-runs', { connection: { url: process.env.REDIS_URL } });
console.log('completed removed', await q.clean(0, 1000, 'completed'));
console.log('failed removed', await q.clean(0, 1000, 'failed'));
await q.close();
"
```

要设置上限时，只能配 `noeviction`——BullMQ 依赖键不被淘汰，`allkeys-lru` 会直接丢任务：

```bash
docker compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning CONFIG SET maxmemory 512mb'
docker compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning CONFIG SET maxmemory-policy noeviction'
```

`CONFIG SET` 重启即失效；长期方案是在 compose 的 redis `command` 里加 `--maxmemory 512mb --maxmemory-policy noeviction`。

**验证**

```bash
docker compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning INFO memory | grep used_memory_human'
curl -sS http://localhost:3000/health/ready
```

---

## 7. 磁盘持续增长

**症状**：`df -h` 使用率上升；Postgres 报 `No space left on device`；容器反复重启。

### 判断

```bash
df -h /
docker system df
docker system df -v | head -40
du -sh backups
docker compose exec -T worker du -sh /workspaces 2>/dev/null
docker compose exec -T worker du -sh /workspaces/* 2>/dev/null | sort -h | tail -10
docker compose exec -T postgres du -sh /var/lib/postgresql
docker compose exec -T redis du -sh /data
```

数据库表大小：

```bash
set -a; . ./.env; set +a
docker compose exec -T postgres psql -U agentport -d agentport -c \
  "SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS total
   FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 10;"
docker compose exec -T postgres psql -U agentport -d agentport -c \
  "SELECT pg_size_pretty(pg_database_size('agentport')) AS db_size;"
```

Docker 日志（默认 json-file 无上限）：

```bash
docker inspect --format '{{.Name}} {{.LogPath}}' agentport-api-1 agentport-worker-1 2>/dev/null
```

### 处置（按收益排序，每步都可单独执行）

```bash
# 1) 构建缓存与悬空镜像（不影响运行中的容器）
docker builder prune -f
docker image prune -f

# 2) 旧工作区：run 结束会清理，残留来自崩溃/重试；确认没有 running 的 run 后删除 24h 前的目录
docker compose exec -T worker find /workspaces -mindepth 2 -maxdepth 2 -type d -mtime +1 -print
docker compose exec -T worker find /workspaces -mindepth 2 -maxdepth 2 -type d -mtime +1 -exec rm -rf {} +

# 3) 备份：正常情况下只保留 7 份；确认后手动删更老的
ls -lh backups | tail -20

# 4) 数据库：手动跑一次保留策略（默认保留 90 天 run / 30 天孤立消息）
pnpm --filter @agentport/worker maintenance

# 5) 日志：滚动重启或截断（截断需要 root；更稳妥是给 compose 加 logging 上限）
sudo truncate -s 0 "$(docker inspect --format '{{.LogPath}}' agentport-api-1)"
```

不要把 `agent_runs` 全表 `DELETE` 当作常规清理：外键与审计都依赖它，用保留策略或调小 `RETAIN_RUN_DAYS` 后跑 maintenance。

**验证**

```bash
df -h /
docker system df
curl -sS -w '\nHTTP %{http_code}\n' http://localhost:3000/health/ready
```

---

## 8. 登录失败

**症状**：登录返回 401 / 429；登录成功但刷新后退出；页面反复跳登录。

### 8.1 429（限流）

**判断**

```bash
docker compose logs api | grep -i 'rate' | tail -20
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"x"}'
```

登录限流 10 次/分钟（按 IP）。反向代理后未设 `TRUST_PROXY=1` 时所有请求共用代理 IP，会集体 429。

**处置**

```bash
grep '^TRUST_PROXY=' .env   # 代理之后必须是 1
# 编辑 .env 后重启 api
docker compose up -d --force-recreate api

# 仅排障时清掉限流计数（不影响会话）
set -a; . ./.env; set +a
docker compose exec -T redis sh -c 'for k in $(redis-cli -a "$REDIS_PASSWORD" --no-auth-warning --scan --pattern "agentport:rl:*"); do redis-cli -a "$REDIS_PASSWORD" --no-auth-warning DEL "$k" >/dev/null; done'
```

不要长期使用 `RATE_LIMIT_DISABLED=1` 绕过。

**验证**：等 1 分钟后重新登录，返回 200；`/api/auth/me` 返回 `{"authenticated":true}`。

### 8.2 会话丢失（PostgreSQL）

**判断**

```bash
docker compose exec -T postgres psql -U agentport -d agentport -c 'select count(*) from "session";'
docker compose logs api | grep -i 'session' | tail -20
```

会话存在 PostgreSQL 的 `session` 表（有效期 24 小时），由 better-auth 的 Drizzle adapter 管理；Redis 不参与会话校验，Redis 故障不会让已登录请求失效。数据库被恢复、清空，或会话行被删除时，已登录用户需要重新登录。

**处置**

```bash
docker compose up -d postgres
# 数据库不可用或数据损坏时按 OPERATIONS.md 的备份策略恢复
```

**验证**：重新登录后刷新页面仍保持登录；`session` 表行数增加。

### 8.3 改了 `.env` 的 `ADMIN_PASSWORD` 但账号密码没变

**判断**：这是首次初始化后的预期行为。`ADMIN_PASSWORD` 只在 `platform_bootstrap` marker 不存在时用于创建首个管理员；marker 已存在后，重启 api 或改 env 都不会覆盖现有账户密码。

**处置**：用该账户登录后调用本人改密接口（需要当前密码）：

```bash
curl -sS -b "agentport_token=<当前会话 Cookie>" -X POST http://localhost:3000/api/auth/change-password \
  -H 'content-type: application/json' -H "origin: <SELF_URL>" \
  -d '{"currentPassword":"<当前密码>","newPassword":"<新密码>"}'
```

改密成功后服务端删除该账户全部会话并清 Cookie。当前没有离线重置管理员密码的工具，不要执行不存在的「管理员恢复」脚本；有其他具备 `accounts.manage` 权限的管理员时，可在账户页重置该账户密码（同时撤销其会话）。已无法登录时按 OPERATIONS.md 的备份/重建流程处理，并先备份。

**验证**：旧密码或旧 Cookie 返回 401；新密码登录 200。

另外两类容易误判：生产 Cookie 带 `Secure`，用 HTTP + 非 localhost 访问会导致「登录成功但刷新退出」；`CORS_ORIGINS` 与浏览器实际 Origin 不一致会被 CORS 拦截。

---

## 9. 部署升级与回滚

### 9.0 升级前（每次必做）

```bash
set -a; . ./.env; set +a
pnpm backup
git rev-parse --short HEAD                 # 记录当前版本
docker tag agentport/api:dev agentport/api:pre-$(date +%Y%m%d-%H%M)
docker tag agentport/sandbox:dev agentport/sandbox:pre-$(date +%Y%m%d-%H%M)
```

镜像 tag 固定为 `agentport/api:dev` / `agentport/sandbox:dev`，没有版本号；上面的副本就是本机回滚点。首次部署时镜像尚不存在，`docker tag` 报错可忽略。

### 9.1 升级

```bash
git pull
pnpm install
pnpm run up --rebuild
```

`pnpm run up` 会重建 api/worker 与沙盒镜像、跑迁移，并用 compose `--wait --wait-timeout 120` 等 api 的 `/health/ready` healthcheck，再执行冒烟。迁移是**前向**的，不要手改已应用的迁移。

### 9.2 升级后验证

```bash
docker compose ps
curl -sS -w '\nHTTP %{http_code}\n' http://localhost:3000/health/ready
curl -sS $AUTH http://localhost:3000/health/metrics | jq '{process, queue, db, redis}'
BASE_URL=http://localhost:3000 ADMIN_USER=admin ADMIN_PASSWORD='<当前管理员密码>' \
  bash scripts/smoke.sh
```

首次初始化后 `.env` 的 `ADMIN_PASSWORD` 不保证等于当前密码，冒烟请填账号当前密码。

页面 `/status` 应全绿；在页面发起一次真实 run 确认沙盒与凭证正常。

### 9.3 回滚

优先回滚镜像（代码与镜像一致，迁移不回退）：

```bash
docker tag agentport/api:pre-<时间戳> agentport/api:dev
docker tag agentport/sandbox:pre-<时间戳> agentport/sandbox:dev
docker compose up -d --force-recreate api worker
```

镜像副本不存在时，用代码回滚后重建：

```bash
git checkout <上一个版本>
pnpm install
pnpm run up --rebuild
```

若新版本已经执行了不兼容的迁移，仅回滚镜像不够：先停 api/worker，再恢复升级前的备份：

```bash
set -a; . ./.env; set +a
docker compose stop api worker
pnpm restore backups/<升级前的时间戳>.sql.gz
docker compose start api worker
```

`pnpm restore` 会整库替换并先生成 `pre-restore-*` 安全副本；保持 `APP_SECRET_KEY` 不变，否则 MCP 密钥无法解密。

**验证**

```bash
curl -fsS http://localhost:3000/health/ready
docker compose logs --tail=80 api worker
```

### 9.4 只回滚配置

改坏了 `.env` 时，用备份或版本管理恢复后：

```bash
docker compose up -d --force-recreate api worker
```

只改 `AGENT_MAX_CONCURRENT` / `SANDBOX_*` 这类变量时，重启 worker 即可；改 `DATABASE_URL` / `REDIS_URL` / 密码类变量时，api 与 worker 都要重建。

---

## 10. 安全事件

> 处置顺序：先切断入口（轮换/撤销），再取证（审计），最后复盘。取证前不要 `docker compose down -v` 或清空 Redis。

### 10.1 平台 MCP token 泄露（`PLATFORM_MCP_TOKEN`）

**判断**：`.env` 或日志/截图里出现该值；`/mcp` 出现异常调用（审计里 `agent.run.requested` 的 actor 或频率异常）。

**处置**

```bash
# 生成新 token 并写回 .env（≥16 字符）
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
# 编辑 .env: PLATFORM_MCP_TOKEN=<新值>
docker compose up -d --force-recreate api
```

`worker` 不读取该变量，无需重启。

**验证**

```bash
# 旧 token 必须 401
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/mcp \
  -H 'authorization: Bearer <旧token>' -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# 新 token 200
```

### 10.2 账户密码泄露（含管理员）

**处置**

仍能登录时，优先用该账户调用本人改密接口；成功后服务端会删除该账户全部会话并清 Cookie：

```bash
curl -sS -b "agentport_token=<当前会话 Cookie>" -X POST http://localhost:3000/api/auth/change-password \
  -H 'content-type: application/json' -H "origin: <SELF_URL>" \
  -d '{"currentPassword":"<当前密码>","newPassword":"<新密码>"}'
```

需要立即断开全部登录，或账户已无法登录时，直接删除 PostgreSQL 的会话行：

```bash
# 指定业务 ID 的全部会话
docker compose exec -T postgres psql -U agentport -d agentport -c \
  'delete from "session" using "user" where "session".user_id = "user".id and "user".business_id = '\''<businessId>'\'';'

# 或清空全部会话（单管理员场景可接受）
docker compose exec -T postgres psql -U agentport -d agentport -c 'delete from "session";'
```

首次初始化后，改 `.env` 的 `ADMIN_PASSWORD` 并重启 api 不会改变现有账户密码；当前没有离线重置管理员密码的工具，不要执行不存在的「管理员恢复」脚本。有其他具备 `accounts.manage` 权限的管理员时，可在账户页重置该账户密码，重置会撤销其全部会话。

**验证**：改密后旧密码 401；旧 Cookie 访问任意需要鉴权的 `/api/*` 返回 401；新密码登录 200。

### 10.3 会话签名密钥泄露（`JWT_SECRET`）

`JWT_SECRET` 是 better-auth 的会话签名密钥（历史命名，不是应用 JWT）。轮换后已签发的 Cookie 无法通过签名校验；PostgreSQL `session` 表中的行仍在，会在 24 小时内自然过期，也可按 10.2 删除。

**处置**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
# 编辑 .env: JWT_SECRET=<新值>
docker compose up -d --force-recreate api worker
```

**验证**：未重新登录的浏览器访问任意 `/api/*` 返回 401。

### 10.4 主密钥泄露（`APP_SECRET_KEY`）

**不要直接轮换**：它会派生加密密钥，轮换后 `servers.secrets_encrypted` 无法解密，所有 MCP 的 env/headers 需要重新填写。

**处置**（确认必须轮换时）

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
# 编辑 .env: APP_SECRET_KEY=<新值>
docker compose up -d --force-recreate api worker
```

然后在「MCP Servers」逐个重新保存 env / headers；`generated` server 的 `mcpToken` 也要在页面「轮换 token」。轮换前先备份，确认无法恢复旧密文后再删旧备份，避免密钥与备份一起泄露。

### 10.5 单个 MCP server token 泄露

**处置**：页面「MCP Servers → 轮换 token」（`POST /api/servers/:id/rotate-token`），旧 token 立即失效；明文只返回一次。

**验证**：用旧 token 调用该 server 的 `/mcp/:serverId` 返回 401。

### 10.6 审计取证

页面「审计」或接口：

```bash
# 需要登录 Cookie；登录后从 Set-Cookie 取
curl -sS -X POST http://localhost:3000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"<密码>"}' -D - -o /dev/null | grep -i set-cookie

curl -sS 'http://localhost:3000/api/audit?action=auth.login.failed&status=denied&limit=200' \
  -H "Cookie: agentport_token=<token>"
```

直接查库（不依赖登录）：

```bash
set -a; . ./.env; set +a
docker compose exec -T postgres psql -U agentport -d agentport -c \
  "SELECT created_at, actor, action, status, target, request_id
   FROM audit_log ORDER BY created_at DESC LIMIT 100;"
docker compose exec -T postgres psql -U agentport -d agentport -c \
  "SELECT date_trunc('hour', created_at) AS hour, actor, count(*)
   FROM audit_log WHERE action='auth.login.failed'
   GROUP BY 1,2 ORDER BY 1 DESC LIMIT 48;"
docker compose exec -T postgres psql -U agentport -d agentport -c \
  "SELECT created_at, actor, action, target FROM audit_log
   WHERE action IN ('server.token.rotated','agent.run.requested','server.created')
   ORDER BY created_at DESC LIMIT 50;"
```

审计只保存输入摘要（SHA-256 前 32 位），没有请求原文；需要原始请求时只能结合反向代理访问日志。

**验证**：确认泄露 token 已失效、异常会话已清空、审计里不再出现新的异常动作；保留查询结果作为事件记录。

---

## 附：一页速查

```bash
# 状态
docker compose ps
curl -sS localhost:3000/health/live; echo
curl -sS localhost:3000/health/ready; echo
curl -sS $AUTH localhost:3000/health/metrics | jq .

# 日志
docker compose logs -f --tail=100 api worker

# 队列
docker compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning LLEN bull:agent-runs:wait'
docker compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning LLEN bull:agent-runs:active'

# 数据库
docker compose exec -T postgres psql -U agentport -d agentport -c 'select 1'

# 沙盒
docker ps --filter 'name=^pace-session-' --format '{{.Names}}\t{{.Status}}'   # 复用的会话容器
docker ps --filter 'name=^agentport-(probe|native-plugin)-'                    # 一次性试连/插件安装容器
docker compose exec -T worker docker ps

# 磁盘
df -h /; docker system df
```
