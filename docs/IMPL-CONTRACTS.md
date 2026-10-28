# 实施契约（历史文档）

> 这是 M1–M4 并行开发时使用的接口约定，**已不再约束当前代码**；当前结构见 [ARCHITECTURE.md](ARCHITECTURE.md)。
> 下文保留当时的分工与文件路径，部分名称已被后续实现取代（例如 ID 已从 `ulid` 改为 TypeID、配置字段以 `packages/api/src/config.ts` 为准）。

## 0. 已存在的基础设施

- `packages/shared/src/*.ts`：zod schema（`serverInputSchema`、`apiToolInputSchema`、`agentInputSchema`、`chatEventSchema`、`agentRunJobSchema`）。**已固定，不要改。**
- `packages/db/src/schema.ts`：Drizzle 表定义。**已固定，不要改。** 表：`servers`、`apiTools`、`agents`、`agentServers`、`conversations`、`messages`、`agentRuns`、`auditLog`。
- `packages/api/src/app.ts`：已挂载 `db`、`pool`、`config` 装饰器，并调用 `registerRoutes(app)`。
- `packages/api/src/config.ts`：zod 解析后的配置，字段见文件。
- `packages/api/src/plugins/errors.ts`：统一错误处理，已注册。
- `packages/api/src/routes/index.ts`：**已固定**，它按以下顺序 import 并调用：
  ```ts
  registerAuth(app)            // ./features/auth/routes.js
  registerHealthRoutes(app)    // ./routes/health.js  (已存在)
  registerServerRoutes(app)    // ./features/servers/routes.js
  registerMcpEndpoint(app)     // ./features/servers/mcp-endpoint.js
  registerAgentRoutes(app)     // ./features/agents/routes.js
  registerChatRoutes(app)      // ./features/chat/routes.js
  ```

## 1. 数据库访问约定

`app.db` 是 Drizzle 实例（`packages/db` 的 `createDb` 返回值）。

**repo 文件分工**（每人只写自己的）：
- `packages/db/src/repo/servers.ts` → 负责人 A
- `packages/db/src/repo/agents.ts` → 负责人 B
- `packages/db/src/repo/chat.ts` → 负责人 C
- `packages/db/src/repo/index.ts` 由 A 写，内容：
  ```ts
  export * as servers from './servers.js';
  export * as agents from './agents.js';
  export * as chat from './chat.js';
  ```

ID 使用 `newId()`（`typeid-js`；当时约定的是 `ulid`，后改为 TypeID）。

## 2. 鉴权约定

除以下公开路由外，**所有 `/api/*` 路由都必须 `preHandler: [app.requireAuth]`**：
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /health/live`、`GET /health/ready`
- `ALL /mcp/:serverId`（MCP 端点用独立 bearer token，见 §5）

`requireAuth` 由负责人 B 实现并注册为 `app.decorate('requireAuth', ...)`；类型声明修改 `packages/api/src/features/auth/types.ts`（B 负责）。

## 3. 负责人 A — MCP Server 管理 + 测试连接 + 动态挂载

**文件**：
```
packages/api/src/features/servers/routes.ts
packages/api/src/features/servers/repo.ts
packages/api/src/features/servers/secrets.ts
packages/api/src/features/servers/ssrf.ts
packages/api/src/features/servers/test-connection.ts
packages/api/src/features/servers/generated.ts
packages/api/src/features/servers/mcp-endpoint.ts
packages/db/src/repo/servers.ts
packages/db/src/repo/index.ts
```

**接口**：
```
GET    /api/servers                  -> Server[]（secrets 脱敏为 "••••"）
POST   /api/servers                  body: ServerInput -> Server
GET    /api/servers/:id              -> Server
PATCH  /api/servers/:id              body: Partial<ServerInput> -> Server
DELETE /api/servers/:id              -> 204
POST   /api/servers/:id/test         -> ServerTestResult（真连一次，listTools）
POST   /api/servers/:id/tools        (仅 generated) body: ApiToolInput -> ApiTool
GET    /api/servers/:id/tools        -> ApiTool[]
DELETE /api/servers/:id/tools/:toolId -> 204
```

**`test-connection.ts`** 必须用 `@modelcontextprotocol/client` v2：
```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
```
- stdio：`new StdioClientTransport({ command, args, env: { ...process.env, ...env } })`
- http：`new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })`
- 连接后 `client.listTools()`，拿 `client.getServerVersion()`（若存在），5 秒超时，最后 `client.close()`。
- 任何异常都返回 `{ ok:false, error, durationMs }`，不抛。

**`secrets.ts`**：AES-256-GCM。导出：
```ts
encryptSecrets(obj: Record<string,string>, keyB64url: string): string
decryptSecrets(payload: string, keyB64url: string): Record<string,string>
maskServer(s: Server): Server   // 敏感值替换为 '••••'，并标记 hasSecrets
```
密钥来自 `app.config.APP_SECRET_KEY`。

**`ssrf.ts`**：导出 `assertSafeUrl(raw: string): Promise<void>`。规则：只允许 http/https；解析 DNS 后拒绝私有网段（10/8、172.16/12、192.168/16、127/8、169.254/16、::1、fc00::/7）——**除非** `config.NODE_ENV === 'development'` 且 host 为 `localhost`/`127.0.0.1`（本地 MCP server 必须可用）。`test-connection.ts` 与 `generated.ts` 都调用它。

**`generated.ts`**：把 `ApiTool[] + baseUrl + headers` 转成 MCP `McpServer`：
```ts
import { McpServer } from '@modelcontextprotocol/server';
```
每个 tool 的 handler：按 `method` 与 `paramsIn` 把参数拼到 URL/query/body，`fetch` 上游，返回 `{ content: [{ type:'text', text: JSON.stringify(result) }] }`。输入 schema 用 `z.fromJSONSchema`（zod 4）或直接用 `Tool` 的 `inputSchema` JSON；若类型不兼容，退回 `z.record(z.unknown())` 并在 tool description 里写明参数。上游非 2xx 时返回 `isError: true`。

**`mcp-endpoint.ts`**：
```ts
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
```
注册 `app.all('/mcp/:serverId', ...)`：
- 仅 `kind === 'generated'` 的 server 可用，否则 404。
- 校验 `Authorization: Bearer <server.token>`（token 存 `servers.config.mcpToken`，创建时随机生成并明文存——这是给沙盒/其他 host 用的，不是用户密钥）。
- `const handler = createMcpHandler(() => buildGeneratedServer(...))`；用 `toNodeHandler(handler.fetch)` 转成 Node handler，转调 `reply.hijack()` + 原生 req/res。
- 若 `toNodeHandler` 的用法与类型定义不符，直接读 `node_modules/@modelcontextprotocol/node/dist/*.d.mts` 的真实签名后再写。

**注意**：A 也需要在创建 generated server 时生成 `mcpToken` 并写入 `config`。

## 4. 负责人 B — 鉴权 + 智能体 CRUD + 工作区渲染

**文件**：
```
packages/api/src/features/auth/routes.ts
packages/api/src/features/auth/types.ts
packages/api/src/features/agents/routes.ts
packages/api/src/features/agents/workspace.ts
packages/core/src/workspace.ts
packages/core/src/index.ts        (可追加 export)
packages/db/src/repo/agents.ts
```

**接口**：
```
POST /api/auth/login   body {username,password} -> set httpOnly cookie, {ok:true}
POST /api/auth/logout  -> clear cookie
GET  /api/auth/me      -> {authenticated:boolean, username?:string}

GET    /api/agents        -> Agent[]
POST   /api/agents        body AgentInput -> Agent
GET    /api/agents/:id    -> Agent
PATCH  /api/agents/:id    body Partial<AgentInput> -> Agent
DELETE /api/agents/:id    -> 204
GET    /api/agents/:id/files -> { mcpJson: string, claudeMd: string, agentMd: string }
```
- `@fastify/jwt` + `@fastify/cookie`，cookie 名 `agentport_token`，`httpOnly`、`sameSite:'lax'`、`secure` 仅生产。
- 密码用 `node:crypto` 的 `scrypt` 与 `ADMIN_PASSWORD` 比对（常量时间比较）。
- `requireAuth` 装饰器：从 cookie 验证 JWT，失败 401 `{code:'UNAUTHORIZED'}`。

**`workspace.ts`**（core）导出：
```ts
export interface WorkspaceFiles { mcpJson: string; claudeMd: string; agentMd: string }
export function renderWorkspace(input: {
  agent: { slug: string; name: string; model: string; systemPrompt: string; maxTurns: number };
  servers: Array<{ name: string; entry: McpJsonEntry }>;
  toolsAllow?: string[]; toolsDeny?: string[];
}): WorkspaceFiles
```
- `.mcp.json`：`{ "mcpServers": { [name]: entry } }`
- `CLAUDE.md`：systemPrompt + 工具使用说明
- `.claude/agents/<slug>.md`：frontmatter `name/description/model/disallowedTools/maxTurns`，正文为 systemPrompt 摘要。子智能体文件不写 `tools`（SDK 派生时 MCP 工具尚未注册，写 `mcp__<server>__*` 会被当成空集拒绝启动）；主智能体的 md 仅供预览，不落盘。
- `McpJsonEntry` 复用 `packages/core/src/tools.ts` 的 `toMcpJsonEntry`。

**`features/agents/workspace.ts`**（api）：从 DB 读 agent + 绑定 servers → 解密 secrets → 调 `renderWorkspace` → **写到** `path.join(WORKSPACES_DIR, slug)`（三个文件），返回内容。若 `WORKSPACES_DIR` 未配置，用 `./data/workspaces`。

## 5. 负责人 C — 对话 + 队列生产 + SSE

**文件**：
```
packages/api/src/features/chat/routes.ts
packages/api/src/queue/producer.ts
packages/db/src/repo/chat.ts
```

**接口**：
```
POST   /api/chat           body ChatRequest -> 202 {runId, conversationId}
GET    /api/chat/:runId/events   -> text/event-stream
GET    /api/conversations/:id    -> {conversation, messages, runMetrics, nextBefore}
DELETE /api/conversations/:id    -> 204（排队/运行中返回 409）
POST   /api/chat/:runId/cancel   -> 202
```
- `GET /api/conversations/:id`：`runMetrics` 是本页消息涉及的 run 读数（按 `runId` 去重后一次 `inArray` 查询），用于给每条历史回复回填读数行；`nextBefore` 为向前分页游标。
- `DELETE /api/conversations/:id`：事务内先锁 agent（KEY SHARE）再锁会话（UPDATE），与 `admitChatRun` 同序；会话仍有 queued/running 运行时返回 409 `CONFLICT` 并保留数据；成功后级联删除消息与运行记录，Fork 子会话的 `parent_id` 置空保留，并写 `conversation.deleted` 审计。
- `POST /api/chat`：创建/复用 conversation，写 user message，创建 `agentRuns` 行（status `queued`），投递 `agent-runs` 队列（BullMQ，`Queue` + `connection: { url: REDIS_URL }`），返回。
- `GET .../events`：从 Redis Stream `run:<runId>:events` 有界回放，再用独立连接的 `XREAD BLOCK` 从最后一条真实 ID 跟读，把 JSON 事件以 `data: <json>\n\n` 写出；收到 `run_finished` 后结束；`close()` 直接断开该连接，多标签页互不影响。
- `POST .../cancel`：往频道发 `{type:'cancel'}`，并把 run 标记为 `cancelled`。
- SSE 需 `reply.hijack()` 自己写 header，或使用 `reply.raw`；注意不能被 Fastify 的序列化拦截。

## 6. 负责人 D — Worker + 沙盒

**文件**：
```
packages/worker/src/index.ts
packages/worker/src/sandbox/provider.ts
packages/worker/src/sandbox/docker.ts
packages/worker/src/runner-client.ts
packages/sandbox/src/runner.ts
packages/sandbox/Dockerfile
```
可新增 `packages/worker/package.json` 的依赖（用 `pnpm --filter @agentport/worker add <pkg>`）。

**流程**：
1. 消费 `agent-runs`，`concurrency = AGENT_MAX_CONCURRENT`。
2. 从 DB 读 agent + 绑定 servers → 调 `@agentport/core` 的 `renderWorkspace` 写到 `WORKSPACES_DIR/<slug>`（**直接调用 API 包之外的核心函数**，不要 import api 包）。
3. `DockerSandboxProvider.create({ image: SANDBOX_IMAGE, workspaceDir, env })`：`docker run --rm -i --network <SANDBOX_NETWORK 或 host> -v <abs>:/workspace:ro -e ... agentport/sandbox:dev`。
   - 用 `node:child_process.spawn` 直接调 `docker` CLI（不引入 dockerode），`stdio: ['pipe','pipe','pipe']`。
4. 把 task JSON 写入子进程 stdin，逐行读 stdout NDJSON（`ChatEvent`），用 `publishRun(runId, event)` 发到 Redis。
5. 结束/失败/超时（`agent.timeoutMs`）都要 publish `run_finished`，并更新 `agentRuns` 状态、cost、turns。
6. 捕获 `cancel` 频道消息 → `SIGTERM` 子进程。

**`sandbox/src/runner.ts`** 需完整实现消息映射：
- `assistant` 消息里的 `tool_use` → `tool_start`（name）+ `tool_input`（json）
- `user` 消息里的 `tool_result` → `tool_result`
- `stream_event` 的 `content_block_delta.text_delta` → `text_delta`
- `result` → `run_finished`（含 costUsd / turns）
- 从 stdin 读一行 JSON 任务（`readline` 或手写），**不要**读到 EOF 才返回。
- 环境变量 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` 由容器注入，不在文件里。

## 7. 负责人 E — 前端

**文件**：`packages/web/**`（除 `package.json`、`vite.config.ts`、`tsconfig.json` 已存在，可改 scripts 但不要动依赖版本）。

页面（TanStack Router，文件路由或代码路由均可，优先代码路由以少文件）：
- `/` 概览
- `/servers`：列表 + 新建对话框（stdio / http / generated 三种 tab）+ 测试按钮 + tools 管理
- `/agents`：列表 + 编辑器（prompt、model、绑定 servers）+ 文件预览（`.mcp.json` / `CLAUDE.md` / agent md）
- `/chat`：选 agent → 对话 → SSE 流式渲染 text / tool_start / tool_result

要求：
- 用 shadcn 风格的组件（`components/ui/` 手写 button/input/dialog/card/badge/textarea/select，使用 `class-variance-authority` + `cn`）。
- `lib/api.ts`：typed fetch wrapper，统一处理 401。
- 不要引入新的 UI 依赖（已装 cva / clsx / tailwind-merge / lucide-react / sonner），不要跑 `pnpm add`。
- Tailwind 4：`@import "tailwindcss";` 已在 styles.css，直接用 class。
- 每个页面必须有 loading / empty / error 三态。

## 8. 负责人 F — 测试、CI、文档

**文件**：
```
vitest.config.ts
packages/api/test/*.test.ts
.github/workflows/ci.yml
docs/PROJECT-BRIEF.md   (只追加「实现记录」，不改已有结论)
README.md
```
- `vitest.config.ts`：node 环境，`test.include: ['packages/**/test/**/*.test.ts']`。
- 测试用 `buildApp` + `app.inject()`：
  - `health.test.ts`：`/health/live`、`/health/ready`
  - `servers.test.ts`：CRUD + 脱敏 + 非法输入 400
  - `auth.test.ts`：未登录 401、登录成功、登出
- 需要 `DATABASE_URL` 和 `REDIS_URL`；在测试里用 `describe.skipIf(!process.env.DATABASE_URL)`。
- CI：`pnpm install --frozen-lockfile` → `pnpm -r typecheck` → `pnpm -r build` → `biome ci` → `pnpm test`；service containers: postgres:18-alpine、`redis:8.10.3-alpine@sha256:896f241f…`（精确 tag/digest 以 `.github/workflows/ci.yml` 与 `packages/worker/test/global-setup.ts` 为唯一来源）。
- `README.md`：项目简介、架构图、启动步骤、环境变量表、里程碑状态。

## 9. 通用硬性要求

- 所有代码用 ESM，相对 import 必须带 `.js` 后缀。
- TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` 已开。
- 不写 `any`（Biome 会报错）；用 `unknown` + 收窄。
- 注释只写「为什么」，不写「是什么」。中文注释。
- 每个导出函数都要有明确的返回类型。
- 出错时返回结构化错误，不吞异常。
- 如果需要新增依赖：只允许 `pnpm --filter <pkg> add <name@exact-version>`，并说明原因。


## 工作区 Markdown 的等待语义（2026-10-20）

平台的智能体间沟通只有三种形式，且都是**同步等待**：

| 形式 | 机制 | 调用方怎样等 |
|---|---|---|
| 父 → 子智能体 | `Agent` 工具 + `.claude/agents/<slug>.md` | 运行时设 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`，子智能体调用在后台不可用，SDK 本轮阻塞到返回 |
| 外部 Host → 平台智能体 | `/mcp` 暴露的 `run_<slug>` 工具 | `AgentInvoker` 轮询 run 终态后返回文本 |
| 智能体 → HTTP 工具 | `.mcp.json` + `/mcp/:serverId` | MCP 调用本身同步；需批准的工具先返回 `需要批准：<tool>` |

平台要求同步等待，因此不等模型自觉传 `run_in_background: false`，而是在运行时环境里直接关闭后台任务（同时限制子智能体深度为 1 层）。`CLAUDE.md` 只保留子智能体清单（slug / 适用场景 / 超时，超时来自 `agents.timeout_ms`）与子定义「你是被父智能体同步调用的 / 父最多等你 N 秒」。
