# 可观测性

面向排障的最小基础：结构化日志基字段、一次请求与后台运行的关联、PostgreSQL 慢查询/锁日志、`/health/metrics` 的队列字段。部署与其它观测入口见 [OPERATIONS.md](OPERATIONS.md#6-观测入口)。

## 日志基字段

api 与 worker 的 pino 日志都带三个基字段，由初始化处统一注入，业务函数不再重复传：

| 字段 | 取值 |
|---|---|
| `service` | `api` 或 `worker` |
| `env` | `NODE_ENV`（`development` / `test` / `production`） |
| `version` | 根 `package.json` 的 `version` |

`base` 会替换 pino 默认的 `pid` 与 `hostname`，当前日志不再包含这两个字段；进程区分靠 `service` 与容器来源。

请求内日志是 Hono 生成的 child logger，额外带 `requestId`。与运行相关的日志带 `runId`，它同时用于 API 与 worker 两侧。

## 事件命名

日志消息是短句、小写、空格分隔的事件名，例如 `request completed`、`slow request`、`run enqueued`、`worker started`。可变内容放结构化字段，事件名只描述发生了什么，不拼参数。

API 请求日志只记录路由模板、状态码与耗时；不记录请求/响应正文、SQL 参数或凭证。

## 关联请求与后台运行

聊天入队成功后，API 写一条 `run enqueued`，同一行同时带 `requestId` 与 `runId`。这是把 HTTP 请求和后台运行串起来的唯一点：

```bash
# 一次 HTTP 请求的全部日志（含它触发的 runId）
docker compose logs api | grep '"requestId":"<id>"'

# 该运行在 API 与 worker 两侧的日志
docker compose logs api worker | grep '"runId":"<id>"'
```

反过来，先拿到 `requestId` 找到 `runId`，再用 `runId` 看 worker 的认领、执行与终态。生产日志是 pino JSON；用 `jq` 过滤时加 `--no-log-prefix`，否则 compose 的服务名前缀会破坏 JSON。

## PostgreSQL 慢查询与锁等待

compose 的 `postgres` 服务通过启动参数开启数据库侧日志，应用代码无感：

| 参数 | 作用 |
|---|---|
| `log_min_duration_statement=200` | 执行超过 200ms 的语句写日志 |
| `log_lock_waits=on` | 锁等待超过 `deadlock_timeout` 时写日志 |
| `log_temp_files=0` | 所有落盘临时文件都写日志 |

`log_lock_waits` 的触发阈值是 PostgreSQL 的 `deadlock_timeout`（默认 1s），不是 200ms；200ms 只约束慢语句。日志输出到容器 stderr：

```bash
docker compose logs -f postgres
docker compose logs postgres | grep 'duration:'
```

慢日志会包含 SQL 文本，语句里的字面量与绑定参数可能带业务数据。对外分享或贴进工单前先脱敏，不要整段外传。

## /health/metrics

需要 `operations.read` 权限，不只是登录。各检查独立执行，单项超时或失败为 `null`，整体仍返回 200。

| 字段 | 含义 |
|---|---|
| `process` | uptime、RSS、Bun 版本 |
| `queue` | `agent-runs` 队列的 `waiting/active/completed/failed/delayed` |
| `knowledgeQueue` | `knowledge-jobs` 队列的同样五项 |
| `queue.oldestWaitingMs`、`knowledgeQueue.oldestWaitingMs` | `waiting` 集合中第一条 job 的等待时长，按 `Date.now() - job.timestamp` 计算 |
| `db` | `connected`、`pingMs`、`maxConnections` |
| `redis` | `pingMs` |

`oldestWaitingMs` 为 `null` 表示当前没有 waiting job，或该次读取失败；读取失败不影响同队列的计数。它只看 `waiting` 列表，不含 `delayed` 与尚未进入 waiting 的优先级 job。

## 队列面板 /api/ops/queues

Bull Board 只读面板，覆盖 `agent-runs`、`eval-runs`、`knowledge-jobs`、`runtime-environment-builds`、`schedule-triggers`、`sandbox-probes`、`native-plugins`、`knowledge-sync-triggers`、`maintenance` 九个队列的计数、job 详情与调度器状态。

访问 `http://<api>/api/ops/queues`，需要登录且具备 `operations.read` 权限，与 `/health/metrics` 相同；未授权返回 `Problem` 形状的 401/403。页面、静态资源与面板内部 JSON 接口都在同一权限校验之后。

面板全部队列以只读模式挂载，新增、重试、删除、清空、暂停与调度器写入都不会改变队列：队列级写接口返回 405，面板级批量 pause/resume 对只读队列不执行任何操作。需要修改队列时仍走业务入口或运维脚本。

面板是第三方 UI（Bull Board），其内部接口的错误响应沿用 Bull Board 自己的 `{error:{key}}` 形状，是本 API「唯一 Problem 错误形状」的明确例外。不要把这个子应用的错误改写成 Problem，那会破坏面板前端；面板边界之外的 API 路由仍一律用 Problem。

`operations.read` 持有人能在面板看到 job 的 payload，可能含 prompt、模型输出与日志正文，属敏感信息，只授予可信运维或专用智能体。

## 排障配方

1. 有 `requestId`：在 API 日志中检索该 id，看路由、状态码、耗时与错误，并取到它触发的 `runId`。
2. 有 `runId`：同时检索 api 与 worker，按时间排序看入队、认领、执行、失败与终态。
3. 没有 id：先看 `/health/metrics` 的 `queue.waiting/active/failed`、`oldestWaitingMs`、`db.pingMs`，再按时间窗检索日志。
4. 慢请求：API 日志的 `slow request` 是超过 2s 的请求；数据库侧用 `duration:` 查慢语句，结合 `log_temp_files` 判断是否落盘。
5. 队列积压：`waiting` 持续增长且 `oldestWaitingMs` 升高说明消费不足；`failed` 增长时检索 worker 的 `failed` 日志。worker 是否存活用 `docker compose ps worker` 确认。
