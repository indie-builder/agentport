# 异常管理设计

> 2026-10-20 初稿；2026-11-06 按 Bun/Hono/oRPC 迁移复核。记录错误契约、分层规则、以及每一类异常在哪里被处理。

## 结论先说

| 层 | 异常类型 | 表示 | 处理者 |
|---|---|---|---|
| 业务（core / db / feature） | **业务异常** | `AppError(code, message)` | 抛给边界，不写 HTTP 状态码 |
| API 边界（Hono / oRPC） | 校验 / 框架 / 未预期 | `Problem` JSON | `packages/api/src/http/errors.ts` 统一渲染 |
| Worker（BullMQ） | 运行失败 | `RunFailure(reason)` | Scope 收尾 + `isRetryableFailure` |
| 沙盒（容器内） | 模型/工具失败 | `run_finished.failureKind` | 过 stdout 传给宿主 |
| 进程 | 未捕获异常 | 日志 + 退出 | `installProcessGuards` |
| 前端 | 所有 HTTP 失败 | `ApiError`（保留全部 Problem 字段） | `errorMessage()` / `describeError()` 按 code 与 status 分支 |

一句话：**业务异常带稳定 code，系统异常只进日志，wire 上永远只有一个形状。**

## 引用的框架与取用点

| 来源 | 取用的设计 | 没取用的部分 |
|---|---|---|
| [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457.html) | 单一 envelope、`type`/`title` 语义、扩展成员放字段级 `errors[]` | `application/problem+json` 媒体类型——前端 `fetch` 只读 JSON，换媒体类型没有收益 |
| [NestJS Exception Filters](https://docs.nestjs.com/exception-filters) | `DomainError` + 全局 filter；业务层不感知 HTTP | 依赖注入式 filter 注册，Hono `onError` 与 oRPC 错误映射等价 |
| [Spring `ErrorResponse` / `ProblemDetail`](https://docs.springframework.org.cn/spring-framework/reference/web/webmvc/mvc-ann-rest-exceptions.html) | 异常自带映射；`ResponseEntityExceptionHandler` 先处理框架异常再兜底 | `@ControllerAdvice` 的注解机制 |
| [Google AIP-193](https://cloud.google.com/apis/design/errors) | `ErrorInfo.reason` 作为稳定机器可读码；retryability 与 code 绑定；`RetryInfo` | protobuf `Status.details` 的 Any 编码 |
| [BullMQ UnrecoverableError](http://docs.bullmq.io/patterns/stop-retrying-jobs) | 永久失败不重试 | 直接使用 `UnrecoverableError`——项目已有 `RunFailure.reason`，语义更细 |

三家的共同点：**业务代码抛领域错误，边界统一翻译，客户端按稳定 code 分支，绝不解析文案。**

## wire 契约

`packages/shared/src/errors.ts`：

```json
{
  "code": "CONFLICT_STALE",
  "message": "配置已被修改，请刷新",
  "status": 409,
  "requestId": "req-7",
  "retryable": false,
  "path": "/body/name",
  "errors": [{ "path": "/body/url", "message": "must be a valid URL" }]
}
```

资源不存在时，具体对象类别放在 `resource`，标识按需放在 `resourceId`：

```json
{
  "code": "NOT_FOUND",
  "message": "智能体不存在，可能已被删除；请刷新后重试",
  "status": 404,
  "requestId": "req-7",
  "retryable": false,
  "resource": "agent",
  "resourceId": "agent_01j...",
  "hint": "刷新资源列表，按资源类别和标识核对对象是否存在且可访问。"
}
```

| 字段 | 为什么存在 |
|---|---|
| `code` | 唯一稳定契约。新增是兼容变更，改语义/删除是破坏性变更 |
| `message` | 面向用户；4xx 保留具体说明，5xx 固定文案 |
| `status` | 与 HTTP 状态一致；客户端不必读 header |
| `requestId` | 关联日志。用户报错时可直接贴这一串 |
| `retryable` | 表示能否安全重放同一个请求。仅 `RATE_LIMITED` 默认允许重放 |
| `path` / `errors` | 字段级校验失败；oRPC 校验问题的 path 带 `body` / `query` / `params` 包装段（如 `/body/name`），批量导入一次返回多条 |
| `resource` | `NOT_FOUND` 的资源类别（`agent` / `conversation` / `run` / `approval` 等），不靠新增 `*_NOT_FOUND` 码表达 |
| `resourceId` | 出错资源的标识；仅在调用方持有且适合外发时带上 |
| `hint` | 面向智能体/运维的排查建议，不是给终端用户的文案；边界按 `code` 给默认值 |

`ERROR_META` 统一定义全部 26 个错误码的 HTTP 状态、默认重试策略和排查提示，三项均为必填；默认只有 `RATE_LIMITED` 的 `retryable` 为 `true`。业务代码可直接调用 `fail('CONFLICT', '...')`，对应状态取自 `ERROR_META.CONFLICT.status`。已登录的客户端可在 `/api/openapi.json` 的 `components.schemas.ErrorCodeCatalog` 查询完整目录。

## 错误码粒度

`code` 表达**可操作的错误类别**——调用方据此决定下一步（改输入、登录、申请权限、刷新、重试、报障）：

`INVALID_INPUT` / `UNAUTHORIZED` / `FORBIDDEN` / `NOT_FOUND` / `CONFLICT` / `RATE_LIMITED` / `INTERNAL_ERROR` …

**不按实体拆码**：不为 agent / conversation / run / approval 各造一个 `*_NOT_FOUND`。具体是哪个对象，用
`resource`（类别）与 `resourceId`（标识）表达：

```json
{ "code": "NOT_FOUND", "resource": "agent", "resourceId": "agent_01j..." }
```

这与主流做法一致：Google AIP-193 把机器可读的 `reason`（错误类别）与 `ResourceInfo`（资源维度）分开；
gRPC 只有单一的 canonical `NOT_FOUND`；Stripe 用 `code: "resource_missing"` 加 `param` 指出对象，
而不是给每种资源一个码。

不这么做会怎样：同一个资源（例如 run）在导出、取消、审批等不同调用点可能各产出一个码，
前端按 code 分支越写越多，文案也开始漂移——「运行不存在」和「找不到该运行」说的其实是同一件事。

## AX / UX 双友好契约

同一个 Problem 同时服务两类消费者，字段分工固定：

- **UX（终端用户）**：`message` 是「现象 + 下一步」，中文、可执行，例如「配置已被修改，请刷新」。
  5xx 固定为 `Internal server error`，不泄漏堆栈、SQL 或上游响应体。
- **AX（智能体 / 客户端）**：按固定顺序消费字段排查，不解析文案：
  1. `code` —— 错误类别，决定后续动作以及是否需要重试；
  2. `resource` / `resourceId` —— 出错的是哪个对象；
  3. `retryable` —— 确认能否安全地重放同一个请求；
  4. `requestId` —— 关联服务日志；
  5. `hint` —— 面向智能体/运维的排查建议与下一步。

`hint` 提供排查步骤。API 根据 `ERROR_META` 填充每个错误码的默认提示，业务可在抛错时覆盖。

一次 agent 404 的完整 Problem：

```json
{
  "code": "NOT_FOUND",
  "message": "智能体不存在，可能已被删除；请刷新后重试",
  "status": 404,
  "requestId": "req-7",
  "retryable": false,
  "resource": "agent",
  "resourceId": "agent_01j...",
  "hint": "刷新资源列表，按资源类别和标识核对对象是否存在且可访问。"
}
```

智能体据此排查：`code=NOT_FOUND` 说明不是请求格式问题，且 `retryable=false` 不做自动重试；
`resource=agent` + `resourceId` 定位到具体对象；需要人工介入时把 `requestId` 交给日志检索；
按 `hint` 先刷新列表或确认归属，仍失败再报障。

## 分层规则

### 业务异常

```ts
// core / db / feature 里
fail('CONFLICT_STALE', '配置已被修改，请刷新');
fail('INVALID_URL', '该地址解析到内网，生产环境不允许');
fail('CONFLICT', 'agent version conflict, retry later', { retryable: true });
```

- **不出现 `statusCode`**：code 自带状态。
- **不出现英文技术细节**：message 是给人看的下一步。
- **可重试要显式声明**。默认策略取自 `ERROR_META`，仅 `RATE_LIMITED` 为 `true`。其他错误仅在同一请求可安全重放时显式传入 `retryable: true`。
- **资源不存在用 `notFound(resource, message?, resourceId?)`**：统一产出 `NOT_FOUND` + `resource`，
  各资源的用户文案集中在一处，调用点不再各写一套。

### 系统异常

数据库断开、Redis 超时、代码缺陷一律**不是** `AppError`。它们在边界被归为：

| 来源 | 结果 |
|---|---|
| 未识别异常 | `INTERNAL_ERROR` 500，原始信息只进日志 |
| Hono body 超限 | `PAYLOAD_TOO_LARGE` 413 |
| 错误 Content-Type | `UNSUPPORTED_MEDIA_TYPE` 415 |
| 限流 | `RATE_LIMITED` 429，`retryable: true` |
| 响应不符合 schema | `RESPONSE_INVALID` 500（服务端缺陷） |
| 关停中/依赖不可用 | `SERVICE_UNAVAILABLE` 503；Redis 连接错误映射为 `SERVICE_UNAVAILABLE` 且显式 `retryable: true` |

5xx 的 `message` 在边界统一替换成 `Internal server error`——堆栈、SQL、上游响应体不会出现在 wire 上。

### 沙盒运行异常

沙盒是独立进程，结构化异常传不出来，只能靠事件。因此 `run_finished` 增加 `failureKind`：

| failureKind | 含义 | BullMQ 重试 |
|---|---|---|
| `infra` | Docker/网络/订阅失败 | ✅ |
| `agent` | 模型或工具返回错误 | ❌ |
| `cancelled` | 用户取消 | ❌ |

宿主把它存进 `agent_runs.error_kind`，用于运行详情与 `isRetryable`。runner 顶层加了 `try/catch`：
未捕获异常不再让进程「静默退出、没有 run_finished」，而是转成终态事件。

### 进程异常

`uncaughtException` / `unhandledRejection` 记录后退出（100ms 留给日志落盘）。理由：这两种错误发生后
进程状态不可信，继续服务比重启更危险。编排器（Docker `restart: unless-stopped`）负责拉起。

### 前端

`ApiError` 从 HTTP `Problem` 解码时保留全部 wire 字段：`code` / `message` / `status` / `requestId` / `retryable` / `path` / `resource` / `resourceId` / `hint` / `errors`；oRPC 客户端异常的回退路径只恢复 `code` / `status` / `requestId` / `retryable`，缺失字段按 `undefined` 处理。通用错误处理按字段分工：

- `errorMessage()` / `describeError()` 按 `code`、`status` 与 `message` 生成可执行文案：401 / 403 / `CONFLICT_STALE` / `RATE_LIMITED` 使用专门文案，其他 4xx 沿用服务端 message，5xx 一律换成可执行建议。
- `toastError` 显示 `message`，带 `requestId` 时同时显示「请求 ID: …」。
- 表单用 `applyProblemToForm` 消费 `errors[]` 的 `path` / `message`；映射到表单字段时去掉 oRPC 的 `body` / `query` / `params` 包装段（`/body/role` → `role`），并保留 JSON Pointer 解码；`errors[]` 缺失或为空时回退到顶层 `path`，只高亮该单字段。
- `code` 与 `retryable` 供业务调用方决定是否重试；`hint` 由 `describeError` 返回给需要展示排查建议的调用方；`resource` / `resourceId` 供按资源分支的调用方读取。
- 登录失效（401）在 `authenticatedFetch` 中直接跳转登录页，不经过 toast 文案。

## 明确的取舍

1. **不用 `application/problem+json`**：RFC 9457 的成员名与语义已采纳，媒体类型没有带来收益，
   反而会让现有 `fetch` 调用与反向代理多一层协商。
2. **不引入异常类层级**：`AppError` 一个类 + code 枚举，而不是 `NotFoundError` / `ConflictError`
   每个状态一个子类。code 已经是判别式，子类只会增加 import。
3. **不把 HTTP 映射放进 db 层**：`AppError` 定义在 core，db 只依赖 core；API 边界负责渲染。
   db 抛 `CONFLICT_STALE` 是因为它是**业务事实**，不是因为它知道 409。
4. **不留旧兼容分支**：`toAppError` 识别 zod、`ORPCError`、`HTTPException` 与 Redis 连接错误；Bun SQL 错误用 `isPgCode` 辅助判断。不再识别旧的 `statusCode` 对象形状。

## 验证

- `packages/api/test/errors.test.ts`：404/401 的 Problem 形状、code→状态映射、`retryable` 语义、
  跨包 `instanceof`。
- 各模块测试仍断言 `code`（如 `CONFLICT_STALE`、`INVALID_URL`），迁移前后行为一致。

## 已知边界

- MCP 端点（`/mcp/:id`）的错误仍由 MCP 协议自己的 JSON-RPC error 表达，不走 Problem；
  它是给 agent 客户端用的，不是浏览器。知识库 MCP 的 `DOCUMENT_NOT_FOUND` / `WIKI_NOT_FOUND`
  属于 MCP 工具错误通道（`code: message` 文本），不是 HTTP Problem 码，不受「错误码粒度」约束。
- `SERVICE_UNAVAILABLE` 目前只有显式抛出的路径；没有接入 under-pressure 自动熔断。
