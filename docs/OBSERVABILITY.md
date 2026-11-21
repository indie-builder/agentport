# 可观测性

面向排障的最小基础：结构化日志基字段、一次请求与后台运行的关联、PostgreSQL 慢查询/锁日志、`/health/metrics` 的队列字段。部署与其它观测入口见 [OPERATIONS.md](OPERATIONS.md#6-观测入口)。

## 日志契约（规范）

服务日志只经 `@agentport/core/logger` 创建，api 与 worker 的业务代码不直接构造 pino（测试可用 `pino({ level: 'silent' })`）。

- 唯一实现：`createServiceLogger` 注入基字段并应用 `LOG_REDACT_PATHS` 脱敏；`requestScopedLogger` 生成带 `requestId` 的请求作用域 child，`runScopedLogger` 生成带 `runId`（及可选 `requestId` / `agentId` / `conversationId`）的运行作用域 child，用于该 run 的执行日志（含传给沙盒的 logger）。
- 基字段、事件命名与脱敏的细节分别见下文「日志基字段」「事件命名」「脱敏」三节，此处不重复。

## 日志基字段

api 与 worker 的 pino 日志都带三个基字段，由初始化处统一注入，业务函数不再重复传：

| 字段 | 取值 |
|---|---|
| `service` | `api` 或 `worker` |
| `env` | `NODE_ENV`（`development` / `test` / `production`） |
| `version` | 根 `package.json` 的 `version` |

`base` 会替换 pino 默认的 `pid` 与 `hostname`，当前日志不再包含这两个字段；进程区分靠 `service` 与容器来源。

请求内日志是 Hono 生成的 child logger，额外带 `requestId`。与运行相关的日志带 `runId`（worker 的 run 作用域 child 还带 `requestId`、`agentId`、`conversationId`），`runId` 同时用于 API 与 worker 两侧。

## 事件命名

日志消息是短句、小写、空格分隔的事件名，例如 `request completed`、`slow request`、`run enqueued`、`worker started`。可变内容放结构化字段，事件名只描述发生了什么，不拼参数。

API 请求日志只记录路由模板、状态码与耗时；不记录请求/响应正文、SQL 参数或凭证。

## 类型化横切事件

`@agentport/core/logger` 的 `LogEventMap` 是横切事件的字段契约，`logEvent(log, event, fields, level?, extra?)` 按事件名约束字段：

| 事件 | 字段 |
|---|---|
| `request completed` | `route`、`statusCode`、`responseTime` |
| `slow request` | `route`、`statusCode`、`responseTime` |
| `request failed` | `route`、`statusCode`、`responseTime`、`code` |
| `unhandled error` | `code` |
| `run enqueued` | `runId`、`queue` |
| `run failed` | `runId`、`attemptsMade`、可选 `code` |
| `queue error` | `queue` |
| `worker started` / `worker stopped` | 无 |

`extraFields` 用于补 `err` 等非契约字段；事件名与字段不要另建字符串常量表。模块内的普通 warn/error 仍可直接用 logger，但消息保持同一种短事件名风格。

上表是 `LogEventMap` 的完整声明，且每个声明都有调用点：`request completed`、`slow request`、`request failed`、`unhandled error`、`run enqueued`、`run failed`、`queue error`、`worker started` 与 `worker stopped` 均经 `logEvent` 写入。新增横切事件先加 `LogEventMap`，再用 `logEvent` 调用。

## 请求事件的实际语义

- `request completed` 由 `packages/api/src/app.ts` 的请求中间件在 Hono dispatch 返回后写入，仅覆盖 `/api/*`；`/health/*`、`/mcp` 与静态资源不写该事件。`app.onError` 已处理该请求时中间件跳过此事件。
- `request failed` 只在 `app.onError` 中写入，覆盖到达 Hono 错误边界的异常；oRPC 已转换成响应的业务错误不会触发它。`app.onError` 不另写 `unhandled error` / `request rejected`，同一请求只有这一条请求级错误事件。
- 因此每个 `/api/*` 请求只写一条结果事件：正常返回写 `request completed`，经 `app.onError` 处理的请求只写 `request failed`。`slow request` 只在完成路径上作为额外 warn，不替代完成事件。
- `unhandled error` 与 `request rejected` 只由 `packages/api/src/http/orpc.ts` 的拦截器写入，且仅针对非 `ORPCError` 的异常：5xx 写 `unhandled error`，其余非 401 错误写 `request rejected`；两者都带 `err`，用于堆栈检索。请求身份事件仍保持每请求一条。
- 原生校验失败不经 `app.onError`。输入校验在业务 handler 执行前抛 `ORPCError`（400），输出校验在 handler 返回后抛 `ORPCError`（500）；拦截器对 `ORPCError` 原样重抛，因此两者都不写 `unhandled error` / `request rejected`。`customErrorResponseBodyEncoder` 把它们转成 `INVALID_INPUT` / `RESPONSE_INVALID` 的 400 / 500 Problem 响应，中间件按返回结果写 `request completed`（对应状态码），不写 `request failed`。输出校验分支另写一条 `unhandled transport error` 的 `logger.error`（带 `err`），它不是 `LogEventMap` 事件。

## 队列错误

BullMQ 的 `Queue` / `QueueEvents` 错误统一写 logger，不直接写 stderr：

- api 的队列生产器与调度队列用 `logEvent(logger, 'queue error', { queue }, 'error', { err })`。
- worker 的队列、reconciler 与调度器用各自的 `logger.warn` / `logger.error` 短事件名（如 `knowledge sync queue error`、`schedule queue error`）。
- api/worker 应用源码中没有 `process.stderr.write` / `console.*` 日志旁路；`packages/worker/src/runtime-environments/verify.ts` 内嵌的容器自检脚本使用 `console.error` / `process.stdout.write` 输出校验结果，属于子进程协议，不是服务日志。

## 关联请求与后台运行

聊天入队成功后，API 写一条 `run enqueued`（`runId` 与 `queue`），同一行同时带 `requestId` 与 `runId`。聊天 run 的 job payload 也带 `requestId`，worker 认领该 run 后使用 run 作用域 child logger，该 run 的执行日志（含传给沙盒的 logger）都带同一 `requestId`：一次 `requestId` 检索可横跨 api 与 worker。频道唤醒、MCP invoker 与定时触发的 run，其 job 不携带 `requestId`，即使由 HTTP 请求发起也一样；这些 run 只能用 `runId` 关联。

```bash
# 一次 HTTP 请求在 API 与 worker 两侧的关联日志
docker compose logs api worker | grep '"requestId":"<id>"'

# 该运行在 API 与 worker 两侧的日志
docker compose logs api worker | grep '"runId":"<id>"'
```

反过来，先拿到 `requestId` 找到 `runId`，再用 `runId` 看 worker 的认领、执行与终态。生产日志是 pino JSON；用 `jq` 过滤时加 `--no-log-prefix`，否则 compose 的服务名前缀会破坏 JSON。

## 脱敏

脱敏路径的唯一清单是 `@agentport/core/logger` 的 `LOG_REDACT_PATHS`，由 `createServiceLogger` 应用到 api、worker 的 logger 及其 child，命中值替换为 `[REDACTED]`。新增凭证类日志字段只改这一处。

## 待改进（已知缺口）

- 没有按 `requestId` / `runId` 的只读日志查询 API 或 MCP，排障仍依赖 `docker logs` 加 `grep`。
- 缺阶段耗时：排队、沙盒获取、首 token、模型轮次、工具调用、持久化、事件发布。
- 事件名依赖 pino 的 `msg`，键名尚未统一。
- eval、knowledge 等其它 job payload 未带 `requestId`。
- 生产 `LOG_LEVEL=info` 会丢弃 runner / sandbox 的 stderr，仅失败时保留尾部。
- compose 未声明日志轮转，需按实际部署核对。

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

Bull Board 只读面板，覆盖 `agent-runs`、`eval-runs`、`knowledge-jobs`、`runtime-environment-builds`、`schedule-triggers`、`sandbox-probes`、`native-plugins`、`knowledge-sync-triggers`、`maintenance`、`data-domain-builds`、`data-domain-enrichments` 十一个队列的计数、job 详情与调度器状态。

访问 `http://<api>/api/ops/queues`，需要登录且具备 `operations.read` 权限，与 `/health/metrics` 相同；未授权返回 `Problem` 形状的 401/403。页面、静态资源与面板内部 JSON 接口都在同一权限校验之后。

面板全部队列以只读模式挂载，新增、重试、删除、清空、暂停与调度器写入都不会改变队列：队列级写接口返回 405，面板级批量 pause/resume 对只读队列不执行任何操作。需要修改队列时仍走业务入口或运维脚本。

面板是第三方 UI（Bull Board），其内部接口的错误响应沿用 Bull Board 自己的 `{error:{key}}` 形状，是本 API「唯一 Problem 错误形状」的明确例外。不要把这个子应用的错误改写成 Problem，那会破坏面板前端；面板边界之外的 API 路由仍一律用 Problem。

`operations.read` 持有人能在面板看到 job 的 payload，可能含 prompt、模型输出与日志正文，属敏感信息，只授予可信运维或专用智能体。

## 排障配方

1. 有 `requestId`：在 api 与 worker 日志中检索该 id，看路由、状态码、耗时与错误，并取到它触发的 `runId`。
2. 有 `runId`：同时检索 api 与 worker，按时间排序看入队、认领、执行、失败与终态。
3. 没有 id：先看 `/health/metrics` 的 `queue.waiting/active/failed`、`oldestWaitingMs`、`db.pingMs`，再按时间窗检索日志。
4. 慢请求：API 日志的 `slow request` 是超过 2s 的请求；数据库侧用 `duration:` 查慢语句，结合 `log_temp_files` 判断是否落盘。
5. 队列积压：`waiting` 持续增长且 `oldestWaitingMs` 升高说明消费不足；`failed` 增长时检索 worker 的 `failed` 日志。worker 是否存活用 `docker compose ps worker` 确认。
