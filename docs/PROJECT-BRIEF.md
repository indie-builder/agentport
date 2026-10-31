# Agentport · 智能体平台 · 项目简报

> 状态：需求、选型与 M0–M6 落地记录。当前实现状态以 [HANDOFF.md](HANDOFF.md) 与 [ARCHITECTURE.md](ARCHITECTURE.md) 为准；本文保留历史结论与选型理由，早期「下一轮」项多数已在循环 1–9 完成。
> 最后更新：2026-10-31 按实际 manifest / lockfile 核对 §3、§10 的技术栈与运行版本（Node 24 LTS 24.22.2、pnpm 12.16.1 等）；其余结论保持原样。
> 项目名：**Agentport**（仓库与包名保持 `agentport`；对外展示名 **PACE**，见 [USER-STORIES.md](USER-STORIES.md)）
> 包前缀：`@agentport/*`
> 本文是该项目的唯一需求基线。项目改名后，本文继续有效；改名只影响仓库名与包名，不影响任何结论。

---

## 0. 工作原则

**并行处理是项目的工作原则。** 任何多步骤交付都先识别可并行部分，再按「接口契约先行 → 多条独立线并行 → 主会话统一整合」执行。

- 开始并行前由主会话固定接口契约（文件域、导出名、URL、Redis 键名），写入当轮任务记录（模板见 `docs/DEV-WORKFLOW.md` §3）；当前结构与数据流以 `docs/ARCHITECTURE.md` 为准。`docs/IMPL-CONTRACTS.md` 是 M1–M4 的历史约定，不再约束当前代码。
- 并行单元使用独立子 agent；**不使用 Workflow 编排**。
- 每条线只改自己的文件；共享代码文件同样交给指定的单一写入子代理，主会话只定契约、整合与验证，不亲自编辑代码。
- 并行结束后由主会话跑 typecheck / build / lint / 真实运行，再逐条关闭 todo。

---

## 1. 原始诉求（逐条记录）

以下是用户在不同轮次中提出的原始要求，按提出顺序记录，不做删减。

### 1.1 项目定位

- 项目最初叫 `mcp-learn`，目的是学习 MCP 的完整链路。
- **后续修正**：不再定位为学习项目，而是**生产可用的智能体平台**。项目名待改。

### 1.2 MCP 相关

- 需要一个可以**把 HTTP 接口转成 MCP Server** 的能力。
- 也需要支持**来自配置的 MCP Server**（即用户填写已有的 stdio 命令或远程 URL）。
- 配置好之后，智能体页面可以使用这些 MCP Server。
- 需要**自建 MCP Client**，并把它引进智能体里。
- 智能体绑定 MCP Server 之后，可以直接调用其工具。
- MCP 相关配置最终**都以 `.mcp.json` 的形式落地**，适配 Claude Code 的规范。

### 1.3 三端划分

1. **前端**：Shadcn + Tailwind CSS，全部使用最新版本。
2. **后端**：Fastify + Zod。
3. **智能体**：Claude Agent SDK（Anthropic 官方）。
4. **数据层**：需要 ORM，要求轻量、当前热门。
5. **完整度**：技术栈要补齐，包括日志等，不能是临时项目。

### 1.4 页面

- 至少有一个**页面用来配置 MCP Server**。
- 用户不确定「该配 MCP Server 还是还要配 MCP Client」，需要项目给出明确答案。
- 后续追加（D-9）：知识库作为与专家/技能/连接器/插件并列的资源页签（`/knowledge`）。

### 1.5 智能体定义方式

- 使用 Claude Code 那种**文件定义**的方式：放在项目目录下的 `.claude` 相关配置中。
- 智能体定义需要支持**多个智能体**。
- `.mcp.json` 是智能体与 MCP Server 绑定的落盘形式。

### 1.6 沙盒

- 智能体运行需要 **Sandbox**。
- 每个 session 过来时，智能体在一个沙盒里跑。
- 需要确认 **microsandbox** 是否适合集成。
- 疑问：智能体定义和 Claude Agent SDK 是否需要放进沙盒里跑？是否需要打镜像？
- 疑问：多个智能体共用同一个镜像时，智能体定义文件如何**动态传导**进沙盒？

### 1.7 基础设施

- 平台会涉及 **Redis**、**BullMQ**。
- 本地要能跑起来，因此涉及 **Docker / Docker Compose**。

### 1.8 版本约束

- **严禁使用过时的老版本**。必须使用当前的新稳定版本（stable，不含 beta/rc）。

### 1.9 本轮的元需求

- 把以上全部原始诉求整理成文档放入项目，以免项目改名后丢失上下文。

---

## 2. MCP 概念澄清（回答 §1.4 的疑问）

MCP 生态只有三个角色，**用户只需要配置其中两个**：

| 角色 | 是什么 | 是否需要用户配置 |
|---|---|---|
| **MCP Server** | 提供 tools / resources / prompts 的进程或端点 | ✅ 需要 |
| **MCP Client** | 与某一个 server 建立的一条连接 | ❌ 不需要，是运行时对象 |
| **Host**（智能体） | 决定模型能看到哪些 server 的工具，并负责调用 | ✅ 需要（绑定关系） |

因此：

- 前端**只需**有 MCP Server 配置页 + 智能体绑定页。
- 但后端**必须**有一个自建 MCP Client，用途是：
  1. 「测试连接」：连接用户配置的 server，执行 `listTools()`，可选做一次 `callTool()`。
  2. 校验：把结果回显到页面，让用户立即知道配置是否正确。
- 没有这一步，用户无从判断自己填的命令/URL 是否正确，这在生产环境是不可接受的。

**结论：配置页面配 Server，不配 Client；Client 是后端的一个能力。**

---

## 3. 技术栈

包版本于 2026-10-31 通过 npm registry 核对，只取 stable / LTS 标签；镜像 tag/digest 以 `Dockerfile`、`docker-compose.yml` 与 CI 的实际引用为准。以根 `package.json`、各包 `package.json`、`pnpm-workspace.yaml` 的 catalog 与 `pnpm-lock.yaml` 的实际解析结果为准。

### 3.1 语言与工程

| 用途 | 选型 | 版本 | 备注 |
|---|---|---|---|
| 语言 | TypeScript | 7.0.2 | 当前 stable |
| 运行时 | Node.js | 24 LTS | 要求 24 的最新补丁版本（当前 24.22.2）；`engines` 为 `>=24.22.2 <25`，容器镜像用 `node:24-alpine` |
| 包管理 | pnpm workspace | 12.16.1 | `packageManager` 字段与本地版本一致 |
| Lint + 格式化 | Biome | 2.6.4 | 替代 ESLint + Prettier |
| 开发运行 | tsx | 4.23.15 | watch 模式 |
| 生产构建 | tsc | 7.0.2 | Node 直接运行 `dist`，不引入打包器 |

### 3.2 前端

| 用途 | 选型 | 版本 |
|---|---|---|
| 构建 | Vite | 8.3.5 |
| 框架 | React | 19.3.1 |
| 样式 | Tailwind CSS | 4.3.3（`@tailwindcss/vite`，无需 config 文件） |
| 组件 | shadcn/ui（`components.json` 已配，`style: base-nova`；源码在 `components/ui`） | — |
| 交互原语 | Base UI（`@base-ui/react`） | 1.9.0；项目不再直接依赖 Radix |
| 消息滚动容器 | `@shadcn/react`（`message-scroller`） | 0.3.1；仅 `components/ui/message-scroller.tsx` 使用 |
| 路由 | TanStack Router（`@tanstack/router-plugin` 生成路由） | 1.170.46 / 1.168.48 |
| 服务端状态 | TanStack Query | 5.105.0 |
| 数据表格 | TanStack Table + dnd-kit（`@dnd-kit/core`/`sortable`/`utilities`） | 9.3.1 / 6.3.1 / 10.0.0 / 3.2.2 |
| 表单 | react-hook-form + `@hookform/resolvers` | 7.91.0 / 6.0.2 |
| 校验 | zod（与后端共享） | 4.6.7 |
| 客户端状态 | Zustand | 5.0.16 |
| 动效 | Motion | 14.9.0 |
| 图表 | Recharts | 3.10.1 |
| 源码编辑 | CodeMirror 6（按需加载） | 6.43.15（`@codemirror/view`）等子包 |
| 智能体输出渲染 | Streamdown（含 `@streamdown/code`） | 2.7.1 / 2.0.0 |
| 生成式 UI | OpenUI：`@openuidev/lang-core`（后端）、`@openuidev/react-lang`（前端）、`@openuidev/cli`（生成 spec） | 1.0.2 / 1.0.2 / 0.6.1；`@openuidev/react-ui` 0.18.1 仅作开发期契约对照（测试用） |
| 提示 | sonner | 2.0.8 |
| 图标 | lucide-react | 1.66.0 |
| 流式 | 原生 `EventSource` | 无需额外库 |
| 本地访问 | Portless（开发期 `pnpm dev` 分配域名） | 0.15.12 |

### 3.3 后端

| 用途 | 选型 | 版本 |
|---|---|---|
| HTTP 框架 | Fastify | 5.12.7（6.x 仍为 alpha，不用） |
| Schema 校验 + 类型推导 | zod 4 + fastify-type-provider-zod | 4.6.7 / 7.0.0 |
| ORM | Drizzle ORM | 0.45.4 |
| 迁移工具 | drizzle-kit | 0.31.11 |
| 数据库 | PostgreSQL | 镜像 `pgvector/pgvector:pg18`（基于 PostgreSQL 18，内置 vector 扩展） |
| PG 驱动 | pg | 8.23.1 |
| 连接池 | pg 内置 Pool | — |
| 日志 | pino | 10.4.0 |
| 日志美化（dev） | pino-pretty | 13.2.0 |
| 日志落文件 | 未引入（stdout + 容器日志） | — |
| 安全头 | @fastify/helmet | 13.2.0 |
| CORS | @fastify/cors | 11.3.1 |
| 限流 | @fastify/rate-limit | 11.2.1 |
| 限流存储 | `@fastify/rate-limit` 内置 Redis store（ioredis） | —（未装 rate-limit-redis） |
| 压缩 | @fastify/compress | 9.3.0 |
| 静态托管 | @fastify/static | 10.1.8 |
| 鉴权 | Better Auth（`better-auth` + Drizzle adapter，会话存库，httpOnly cookie） | 1.7.14 |
| API 文档 | @fastify/swagger + `@scalar/fastify-api-reference`（已接入，需登录访问） | 9.9.2 / 1.76.4 |
| 过载保护 | 未接入（无 `@fastify/under-pressure` 依赖；`/health/live`、`/health/ready` 由 `routes/health.ts` 自行实现） | — |
| Redis 客户端 | ioredis | 6.0.0 |
| 队列 | BullMQ | 6.5.3 |
| 队列面板 | 不接（见 D-15） | — |
| 队列遥测 | 不接 | — |
| 并发控制 | p-limit | 7.3.3 |
| ID | typeid-js | 1.2.0 |
| 副作用运行时 | effect | 4.1.1 |

**为什么从 SQLite 改为 PostgreSQL**：上一轮建议 SQLite 是按「单机学习项目」判断的。引入 BullMQ worker 后，API 进程与 worker 进程会并发写同一份数据，SQLite 的单写者限制会成为真实瓶颈，而且队列本身又要求 Redis，基础设施复杂度已经上去了。PostgreSQL 18 与 Redis 8 都通过 compose 起，运维成本相当。Drizzle 的 schema 写法在两者间基本一致，但迁移文件不通用，越早切换成本越低。

**Drizzle 版本说明**：`0.45.4` 是 npm `latest` 标签对应的稳定版；`1.0.0` 目前只有 `rc` / `beta`，按「严禁过时、但只用 stable」的约束，取 0.45.4。

### 3.4 智能体与 MCP

| 用途 | 选型 | 版本 |
|---|---|---|
| Agent SDK | @anthropic-ai/claude-agent-sdk | 0.3.316 |
| MCP Server 实现 | @modelcontextprotocol/server | 2.4.0 |
| MCP Node 适配 | @modelcontextprotocol/node | 2.1.2 |
| MCP Client | @modelcontextprotocol/client | 2.4.0 |

> **包线警告**：MCP TS SDK 已经分化为 v2 包线（`@modelcontextprotocol/server` / `client`，实现 2026-07-28 规范）与旧的 v1 单包 `@modelcontextprotocol/sdk`（1.32.1）。Agent SDK 内部 peer-depend 的是 v1。**两套不要混用**，项目里统一使用 v2；Agent SDK 与我们的 server 之间通过 stdio 进程边界通信，不存在类型冲突。

### 3.5 沙盒

| 用途 | 选型 | 版本 | 说明 |
|---|---|---|---|
| 起步方案 | Docker Engine + Docker Compose | 以本机安装为准 | 本机由 Docker Desktop 提供，版本随其升级变动，不在文档里固定快照 |
| 容器控制 | 宿主 `docker` CLI（`spawn` argv） | — |
| 强隔离方案（未接入） | microsandbox | 0.7.8（仅评估） | Apache-2.0，libkrun microVM，提供 TS SDK |
| Agent SDK 内置沙箱 | `options.sandbox` | SDK 自带 | **不能**替代容器（见 §6.4） |

### 3.6 测试与交付

| 用途 | 选型 | 版本 |
|---|---|---|
| 单元/集成测试 | Vitest | 5.0.5 |
| 覆盖率 | 未配置（无 `@vitest/coverage-v8` 直接依赖与 coverage 配置） | — |
| E2E | e2e（`e2e` + `@e2e-dev/web`） | 0.22.0 / 0.15.4 |
| 集成测试 | 本地/CI service containers（未用 testcontainers） | — |
| 容器化 | Dockerfile（多阶段）+ docker-compose.yml | — |
| CI | GitHub Actions | — |

---

## 4. 架构

### 4.1 仓库布局

**包管理：pnpm workspace（已确认）。** 分层原则：**代码按依赖方向分层，进程按部署单元拆分**。层只能向下依赖，不能反向；进程之间只通过 PostgreSQL / Redis / HTTP 通信，不共享内存对象。

```
<repo>/
├─ package.json  pnpm-workspace.yaml  biome.json  tsconfig.base.json
├─ .env.example  Dockerfile  docker-compose.yml
├─ docs/PROJECT-BRIEF.md           # 本文件
├─ data/                            # gitignore
└─ packages/
   ├─ shared/     @agentport/shared      # L0 纯类型与 zod schema，无运行时依赖
   ├─ core/       @agentport/core        # L1 领域逻辑：渲染工作区、MCP 定义、任务模型
   ├─ db/         @agentport/db          # L2 Drizzle schema + 迁移 + repo
   ├─ web/        @agentport/web         # L3 React SPA
   ├─ api/        @agentport/api         # L3 Fastify 主进程
   ├─ worker/     @agentport/worker      # L3 BullMQ 消费者 + 沙盒生命周期
   └─ sandbox/    @agentport/sandbox     # L3 沙盒 runner/supervisor（镜像由根 Dockerfile 的 sandbox target 产出）
```

**依赖方向（强制）**：

```
shared  ◀── core ◀── db ◀── api
                     ◀── worker
shared  ◀── web
```

- `shared` 不能 import 任何东西（zod 除外）。
- `core` 只能 import `shared`。
- `db` 可以 import `core`、`shared`。
- `api` / `worker` / `web` 可以 import 下层，**彼此不 import**。
- `sandbox` 是独立产物，不参与 workspace 依赖（镜像内自包含）。

**为什么单独抽 `core` 和 `db`**：API 和 Worker 都要读 agent 配置、渲染工作区、写 run 状态。如果不抽出来，两边会各写一份，最后行为不一致。这两层是「多进程共享逻辑」的唯一入口。

**进程与层的对应关系**：

| 部署单元 | 对应包 | 职责 | 是否常驻 |
|---|---|---|---|
| `api` | `api` + `core` + `db` | HTTP、SSE、MCP 端点、配置 CRUD、入队 | 是 |
| `worker` | `worker` + `core` + `db` | 消费队列、创建/销毁沙盒、转发事件 | 是 |
| `web` | `web` | SPA，构建产物由 api 托管 | 否（静态） |
| `sandbox runner` | `sandbox` | 容器内常驻 supervisor + 每轮新 runner 执行 Agent SDK；容器按会话短期复用 | 是（同一会话容器，空闲 5 分钟回收） |

**MQ 的层定位**：BullMQ 是 `worker` 与 `api` 之间的**传输层**，不是业务层。业务层只定义「任务是什么」（`core` 里的 `AgentRunJob` 类型），`api` 负责生产、`worker` 负责消费。两边共享的只有 `shared` 里的 job schema，避免 producer/consumer 字段漂移。

**不引入的东西（明确记录）**：
- 不引入 monorepo 构建编排工具（Turborepo / Nx）。包只有 7 个，依赖方向是线性的，`pnpm -r` 足够。等构建时间成为问题时再评估。
- 不做独立的消息总线抽象层。BullMQ 直接用在 worker 里，换队列实现是极小概率事件。


### 4.2 运行时拓扑

```
浏览器 ──HTTP/SSE──▶ api (Fastify)
                       │
                       ├─▶ PostgreSQL      配置、会话、消息、审计、知识索引（pgvector）
                       ├─▶ Redis           BullMQ 队列、限流、缓存
                       ├─▶ /mcp/:serverId  动态 MCP 端点（HTTP→MCP 的产物；含内置知识连接）
                       └─▶ /knowledge      知识原件与解析产物（api 写入、worker 读取的持久卷）

worker ──消费 agent-runs / knowledge-jobs──▶ Sandbox (容器/microVM)
   │                              │
   ├─▶ 知识任务：解析 → 分块 → embedding → 切版本（不进入沙盒）
   └─▶ 渲染工作区到宿主机卷 ──────┘ 挂载进沙盒
                                  └─▶ 容器内 runner → Agent SDK → claude CLI
                                        └─▶ MCP 工具调用 ──▶ api /mcp/:serverId
```

### 4.3 「HTTP 接口转 MCP Server」的实现方式

**不做代码生成，做运行时挂载。**

1. 用户在页面定义工具：`name`、`description`、HTTP method、URL 模板、参数 schema、鉴权方式。
2. 存进 `api_tools` 表。
3. API 侧用 `createMcpHandler(factory)` 暴露 `/mcp/:serverId`，factory 每次按 DB 定义构造 `McpServer` 实例并注册工具。
4. 工具执行时，`mcp/proxy.ts` 发出真实 HTTP 请求，把响应转成 `CallToolResult`。
5. 在 `.mcp.json` 里，这个 server 就是一个普通条目：

```json
{ "type": "http", "url": "http://host.docker.internal:3000/mcp/<serverId>" }
```

优点：

- 改工具定义立即生效，无需重新生成、无需重启子进程。
- 「测试连接」和智能体调用走**完全相同**的端点，因此测通即调通。
- 生成的是标准 MCP 端点，其他 host（Claude Code、其他客户端）也能直接连。

### 4.4 MCP Server 在 `.mcp.json` 中的统一表达

```jsonc
{
  "mcpServers": {
    "stdio-demo": { "command": "npx", "args": ["-y", "some-server"], "env": { "TOKEN": "…" } },
    "remote-api": { "type": "http", "url": "https://api.example.com/mcp", "headers": { "Authorization": "Bearer …" } },
    "crm-api":    { "type": "http", "url": "http://host.docker.internal:3000/mcp/<serverId>" }
  }
}
```

> 沙盒内访问平台用 `SANDBOX_API_URL`（默认 `http://host.docker.internal:3000`）；compose 已把它显式设为该值（见 §6.5）。

知识库也遵循同一官方表达：平台为每个知识库自动生成一个 `servers.kind='knowledge'` 的内部连接，运行时在 `.mcp.json` 里写成标准 `http` 条目（`/mcp/<serverId>` + run 短期 token）。这个 kind 只存在于数据库与读路径，**不进入用户可提交的 `serverInputSchema`**，因此不能通过创建/导入伪造，也不出现在 `/api/servers` 列表。知识正文、索引和 Wiki 都是平台内容资源，不写进 `.claude/` 目录。

---

## 5. 数据模型

```sql
servers(
  id text pk                 -- TypeID，如 srv_/agt_/run_,
  name text unique,
  kind text check (kind in ('stdio','http','generated','knowledge')),  -- knowledge 仅平台内部写
  config jsonb,              -- command/args/url/headers 等非敏感字段
  secrets_encrypted bytea,   -- AES-256-GCM：env、Authorization 等
  created_at timestamptz,
  updated_at timestamptz
)

api_tools(
  id text pk                 -- TypeID，如 srv_/agt_/run_,
  server_id text fk          -- TypeID,
  name text,
  description text,
  method text,
  url_template text,
  input_schema jsonb,        -- JSON Schema（由 zod 生成）
  auth_ref text,             -- 指向 servers.secrets_encrypted 中的键
  unique (server_id, name)
)

agents(
  id text pk                 -- TypeID，如 srv_/agt_/run_,
  slug text unique,          -- 目录名，用于 workspaces/<slug>/
  name text,
  model text,
  system_prompt_md text,     -- 渲染为 CLAUDE.md
  tools_allow jsonb,         -- 例如 ["mcp__crm-api__*"]
  tools_deny jsonb,          -- 显式拒绝的工具名，默认空；平台默认在代码中
  max_turns int,
  max_budget_usd numeric,
  timeout_ms int,
  created_at timestamptz,
  updated_at timestamptz
)

agent_servers(agent_id text, server_id text, primary key (agent_id, server_id))

conversations(id text pk                 -- TypeID，如 srv_/agt_/run_, agent_id text fk           -- TypeID, title text, created_at timestamptz)

messages(
  id text pk                 -- TypeID，如 srv_/agt_/run_,
  conversation_id text fk    -- TypeID,
  role text,
  content jsonb,             -- 原始 assistant/user 消息块
  run_id text,               -- 关联同一次 agent run
  created_at timestamptz
)

agent_runs(
  id text pk                 -- TypeID，如 srv_/agt_/run_,
  conversation_id text,
  agent_id text,
  status text,               -- queued|running|succeeded|failed|cancelled|timeout
  session_id text,           -- Agent SDK session id
  sandbox_id text,
  started_at timestamptz,
  ended_at timestamptz,
  error text,
  cost_usd numeric,
  turns int
)

audit_log(
  id text pk                 -- TypeID，如 srv_/agt_/run_,
  actor text,
  action text,               -- mcp.test | mcp.call | agent.run | config.update
  target text,
  input_digest text,         -- 只存摘要，不存原文
  status text,
  duration_ms int,
  request_id text,
  created_at timestamptz
)
```

知识库是一组独立的内容表，不挂在专家定义下（字段契约见 [ARCHITECTURE.md §6.1](ARCHITECTURE.md#61-存储与数据模型)）：

```sql
knowledge_bases      (id, slug unique, name, description, status, server_id unique fk,
                      embedding_profile_id fk, rerank_profile_id fk, settings jsonb)
knowledge_folders    (id, base_id fk, parent_id fk, name, path)          -- 物化路径 /a/b
knowledge_tags / knowledge_document_tags                                 -- 文档标签
knowledge_documents  (id, base_id, folder_id, title,
                      source_type check in (upload,url,feishu_wiki,feishu_drive,gitlab,github,feed,manual),
                      source_id, source_url, mime_type, status, current_version_id, content_hash, metadata)
knowledge_document_versions (id, document_id, version, blob_sha256, markdown_sha256,
                      source_revision, parse_status, page_map, images, embedding_profile_id)
knowledge_chunks     (id, base_id, document_id, version_id, folder_id, ordinal, kind, heading,
                      content, search_text, search_vector generated, embedding vector(1024),
                      enabled, edited_by_user, page_from, page_to)
knowledge_sources    (id, base_id, type check in (feishu_wiki,feishu_drive,gitlab,github,feed),
                      name, config, secrets_encrypted, status, sync_cron, cursor)
knowledge_source_ranges (id, source_id, kind, external_id, ref, paths, enabled)
knowledge_sync_runs  (id, source_id, status, cursor_before, cursor_after, stats)
knowledge_jobs       (id, type, status, step, progress, payload)     -- BullMQ jobId = id
knowledge_model_profiles (id, kind embedding|rerank, endpoint_url, model, dimensions, secrets)
knowledge_wiki_pages / knowledge_wiki_versions / knowledge_wiki_sources
```

`source_id` 是外部条目的稳定 ID（worker 写入时形如 `<来源连接 ID>:<源端 ID>`，源端 ID 为飞书 token / GitLab `project:ref:path` / `feedURL:itemId`）；`upload`/`manual` 为空，身份只按 ID 匹配而不是标题。飞书的 `appId` 放在 `knowledge_sources.config`，`appSecret` 只在 `secrets_encrypted`。

`search_vector` 是 `to_tsvector('simple', search_text)` 的生成列（应用只写 `search_text`），embedding 固定 1024 维。业务实体主键同样用 TypeID（`kb_`、`kdoc_`、`kdv_`、`kchk_`、`ksrc_`、`kjob_` 等）；`knowledge_document_tags` 与 `knowledge_wiki_sources` 是纯关联表，不单独生成 ID。

---

## 6. 智能体、文件定义与沙盒

### 6.1 文件定义方式

每个智能体在宿主机有一个工作区：

```
workspaces/<agent-slug>/
├─ .mcp.json                    # 绑定关系 + server 配置
├─ CLAUDE.md                    # 由 agents.system_prompt_md 渲染
└─ .claude/
   ├─ agents/<agent-slug>.md    # YAML frontmatter: name/description/tools/model
   └─ settings.json             # 可选：项目级权限
```

渲染流程：DB 是编辑来源 → 每次运行前由 `packages/core/src/workspace.ts` 渲染 → 文件是交给 Agent SDK 加载的唯一运行投影。

以下为早期受限运行示例，不代表当前全部能力；其中内置工具禁用尤其不代表当前默认，Bash 默认启用。当前工具路径、原生记忆、成果与澄清接入以 `packages/sandbox/src/runner.ts`、`docs/ARCHITECTURE.md` §3 为准。新建智能体默认 `default`，显式 `dontAsk` 保留其拒绝交互语义。

调用方式：

```ts
query({
  prompt,
  options: {
    cwd: workspaceDir,
    settingSources: ['project'],           // 必须含 project，.mcp.json 才会被加载
    // strictMcpConfig 保持默认 false：设为 true 会忽略 .mcp.json
    env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    abortController,
    maxTurns,
    maxBudgetUsd,
    permissionMode: 'dontAsk',
    disallowedTools: ['Bash','Read','Write','Edit','Glob','Grep','NotebookEdit','WebFetch','WebSearch','Agent','TaskStop'],
    allowedTools: ['mcp__*'],
    includePartialMessages: true,
  },
})
```

**权限要点**：
- `allowedTools` 只是「自动批准」，不限制。
- 真正的限制来自 `disallowedTools` 里的裸工具名，它会把这些工具从上下文里移除。
- `permissionMode: 'dontAsk'` 下 `canUseTool` 不会被调用；要逐次拦截必须用 `PreToolUse` hook。

### 6.2 是否把 Agent SDK 放进沙盒

**是。整个 runner（含 Agent SDK 与内置 claude CLI）都在沙盒内运行。**

原因：

1. Agent SDK 的 `options.sandbox` **只隔离 shell 命令**，MCP server、文件工具、hook 都在沙箱外运行。对「用户可配置任意 stdio server」的平台来说，这个边界不够。
2. 若只把 shell 放进沙盒而 SDK 在宿主，那么 MCP server 仍在宿主拥有完整权限，等于没有隔离。

### 6.3 镜像策略：基座镜像 + 命名环境，定义动态挂载

**镜像只包含运行时，不包含任何智能体定义。**

镜像内容（根 `Dockerfile` 的 `sandbox` target）：

- 固定为 `node:24-alpine`（Dockerfile 中锁定 digest；没有 debian slim 分支）
- `runner` 构建产物（含 `@anthropic-ai/claude-agent-sdk` 及其平台原生 binary、MCP client）
- `git`（官方插件市场安装）、`poppler-utils`（长 PDF 分页读取）与 `bash`（官方 CLI 执行 Bash 工具所需的真实 shell）
- 固定的非 root 用户（uid 1000）

**不**包含：任何 `.mcp.json`、`CLAUDE.md`、`.claude/agents/*.md`、任何 API key。

运行时传导方式：**宿主目录绑定挂载**（已确认，单机方案）。

| 维度 | 决定 |
|---|---|
| 工作区来源 | 宿主 `workspaces/<slug>/` |
| 挂载方式 | 只读挂载到容器 `/workspace` |
| 多机部署 | **暂不支持，也不做抽象** |
| 对象存储 | 不引入 |

> **每次运行都重新渲染并挂载**，因此「改配置 → 下次对话生效」成立，不需要重建镜像。智能体默认共用基座镜像，需要额外依赖时绑定各自的命名运行环境；定义仍各自挂各自的目录。
>
> 单机意味着 workspace 目录与 worker 必须同机。这是当前明确的取舍：少一层存储抽象，代码更少。将来要多机时，把 `SandboxProvider.create()` 的 `workspaceDir` 参数换成「准备一个工作区」的异步函数即可，改动集中在一个方法内。

**按命名运行环境定制，不把镜像写进智能体。** `SANDBOX_IMAGE` 是平台基座：worker 首次启动时若本地缺失会先拉取，再用真实本地 image ID 登记「默认环境」的首个线上版本（`base_image_id` 也是该 image ID），并作为之后所有环境构建的基座；默认环境已存在时不再 inspect/pull，也不会随环境变量变化自动发布。需要额外依赖时新建命名运行环境、编辑 Dockerfile、构建并发布版本；智能体绑定环境、不绑定版本，只有新建容器时才解析该环境当时的线上版本，存活容器继续用创建时的旧镜像。环境是平台基础设施，不写入官方 `.claude/` 定义；专家包只在 sidecar 记录环境名称。

### 6.4 沙盒选型评估

| 方案 | 隔离级别 | 是否沙箱 MCP | 成熟度 | 结论 |
|---|---|---|---|---|
| Agent SDK `options.sandbox` | 共享内核（Seatbelt / bwrap） | ❌ | 稳定 | 可作为**纵深防御的一层**，不能作为主边界 |
| Docker 容器 | 共享内核 + namespace | ✅（整个进程都在容器内） | 非常成熟 | **起步方案** |
| microsandbox | 独立内核（libkrun microVM） | ✅ | 0.7.x，pre-1.0，Apache-2.0 | **推荐作为强隔离升级路径** |
| gVisor / Firecracker | 独立内核 / syscall 拦截 | ✅ | 运维复杂 | 规模化后再考虑 |

**microsandbox 是否适合集成：适合，但不要第一天就上。**

已核实的事实：

- npm 包 `microsandbox@0.7.8`，`engines.node >= 22`，Apache-2.0。
- 提供 TypeScript SDK，按平台分发 optionalDependencies：darwin-arm64、linux-x64/arm64-gnu、win32-x64/arm64-msvc。
- 兼容 OCI/Docker 镜像，本地模式无需 root、无需 daemon。
- 支持 macOS / Linux / Windows。
- 启动约 200–320ms（官方宣称，未实测）。

风险：

- 仍是 0.7.x，API 可能变动；云服务仍在私有 beta。
- 依赖各平台原生二进制，CI 矩阵要覆盖。
- 本机 macOS 是 arm64，容器镜像架构要匹配。

**因此设计一个 `SandboxProvider` 接口**：

```ts
interface SandboxProvider {
  create(opts: { image: string; workspaceDir: string; env: Record<string,string>; mounts?: Mount[] }): Promise<Sandbox>;
  exec(sb: Sandbox, cmd: string, args: string[]): AsyncIterable<Event>;
  destroy(sb: Sandbox): Promise<void>;
}
```

先实现 `DockerSandboxProvider`，接口稳定后再加 `MicrosandboxProvider`。业务代码只依赖接口。

### 6.5 沙盒内的网络与凭证

- 沙盒访问 API：用 `SANDBOX_API_URL`，默认 `http://host.docker.internal:3000`，由 worker 的 `--add-host` 解析；其他网络模式改用宿主可达地址。
- **不要把 model API key 写进挂载文件。** 默认由 worker 的模型凭证代理（D-17）持有真实凭证：配置 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN` 后，沙盒只注入代理地址与按 run 签发的短期 `ANTHROPIC_AUTH_TOKEN`，容器内进程看不到明文密钥；未配置凭证时代理不启动，保留直接注入配置值的回退路径并打印警告。
- 出站由 `SANDBOX_EGRESS` 控制：默认 `open`，容器走 bridge 直连，**不隔离出站**；`proxy` 为 bridge + 容器内 `HTTPS_PROXY`（未配置代理时启动失败，不降级为 open）；`none` 才使用 `--network none`。
- 挂载一律只读；需要写的工作区单独给一个可写子目录。

---

## 7. Redis 与 BullMQ

### 7.1 为什么需要

- **运行隔离**：agent run 可能持续数分钟，不能占着 HTTP 请求。
- **并发控制**：限制同时运行的沙盒数量（`AGENT_MAX_CONCURRENT`）。
- **重试与可观测**：失败重试、进度查询、取消。
- **定时任务**：将来的定时触发、清理过期沙盒。

### 7.2 队列设计

| 队列 | 用途 | 并发 | 重试 |
|---|---|---|---|
| `agent-runs` | 一次对话运行 | `AGENT_MAX_CONCURRENT`（默认 2） | `attempts: 2` + 指数退避；业务失败不重试 |
| `maintenance` | 版本/运行/孤立消息清理 | 1 | 每日 repeatable job |

「测试连接」在 API 进程内直接执行（5 秒超时），不走队列。

要点：

- Job id 使用 `runId`，天然幂等。
- 每个 job 带 `agentId / conversationId / runId`，日志与审计统一按 `runId` 关联。
- `agent-runs` 的 worker 与 API 分开部署（同一镜像、不同入口），可以独立扩缩容。
- 取消用 `job.remove()` + 通过 Redis pub/sub 通知 worker 终止子进程（SDK 的 `abortController`）。

### 7.3 关于 Redis 与 Valkey

- BullMQ 6.x 要求 Redis ≥ 5；Redis 8 已开源（AGPLv3）。
- 基础设施版本：Redis 8.10.3（`redis:8.10.3-alpine`，tag/digest 见 `docker-compose.yml` 与 CI）。
- 如镜像源受限可换 `valkey/valkey:9-alpine`（协议兼容，BullMQ 可用）。

---

## 8. 安全基线

| 风险 | 措施 |
|---|---|
| stdio server = 任意代码执行 | 命令白名单；或仅管理员可配置；沙盒内运行 |
| HTTP server URL = SSRF | 仅允许 http/https；禁止重定向；默认拒绝私有网段与 link-local |
| 密钥泄露 | AES-256-GCM 加密入库（主密钥 `APP_SECRET_KEY`）；接口返回脱敏为 `••••`；日志 `redact` |
| 工具输出注入 | 不放任文本直接进 system prompt；限制 `MAX_MCP_OUTPUT_TOKENS`；出站 allowlist |
| Agent 越权 | 内置工具默认禁用（Bash 例外）；Bash 在容器内运行且受只读挂载约束；`maxTurns` / `maxBudgetUsd` / 自建超时；沙盒只读挂载 |
| 沙盒逃逸 | Docker 起步；需要更强隔离时切换 microsandbox |
| 依赖供应链 | pnpm lockfile + CI 内 `pnpm audit`；镜像固定 digest |

---

## 9. 日志与可观测性

### 9.1 pino 配置要点

```ts
{
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie',
      '*.apiKey', '*.token', '*.secret',
      '*.env.*', '*.headers.authorization',
    ],
    censor: '[REDACTED]',
  },
  serializers: { err: pino.stdSerializers.err },
}
```

- 生产：纯 JSON 到 stdout（容器标准）。
- 开发：`pino-pretty` transport。
- 需要落文件时用 `pino-roll` 按大小/时间滚动。

### 9.2 关联字段

- 每个请求：`reqId`（Fastify 自动生成），日志中带 `reqId`。
- 每次 agent 运行：`runId`、`sessionId`、`agentId`、`turn`、`toolName`、`durationMs`。
- 追溯一轮对话：按 `runId` 过滤即可。

### 9.3 审计

`audit_log` 表独立于日志：日志会滚动删除，审计长期保留。写入时机：

- MCP server 配置变更
- MCP 连接测试
- 每一次 MCP tool 调用（含 digest，不存原文）
- 每次 agent run（状态、耗时、成本）
- 登录与鉴权失败

### 9.4 健康与保护

- `GET /health/live`：进程存活。
- `GET /health/ready`：DB 可读 + 迁移已应用 + Redis ping。
- `@fastify/under-pressure`：不接入（无该依赖）；过载由容器内存上限与队列并发控制约束。
- BullMQ 面板：不接（D-15）；队列状态看 `/health/metrics` 与 `/api/runs`。

### 9.5 OpenTelemetry

- 现在不接 OTEL collector。`bullmq-otel` 的版本已记录，将来需要跨服务链路时再启用。
- 前提是 `CLAUDE_CODE_ENABLE_TELEMETRY=1` 与 OTEL 环境变量，属于后续阶段。

---

## 10. 部署与本地运行

### 10.1 docker-compose 服务

| 服务 | 镜像 | 端口 | 说明 |
|---|---|---|---|
| `api` | 本仓库 Dockerfile | 3000 | Fastify，含 `/mcp/:serverId` |
| `worker` | 同一镜像，入口不同 | — | BullMQ 消费者 + 沙盒管理 |
| `postgres` | `pgvector/pgvector:pg18` | 5432 | 持久卷；PG18 + vector 扩展，知识检索依赖 |
| `redis` | `redis:8.10.3-alpine`（tag/digest 见 `docker-compose.yml` 与 CI） | 6379（仅绑定 127.0.0.1） | AOF 持久化 + 密码 |
| `docling` | `docling-serve-cpu` 1.38.2（`docling` profile，默认不启动） | 5001 | 复杂格式解析；未启动时 PDF/Office/OCR 明确报错 |
| `web` | 开发时 Vite dev server | 5173 | 生产由 `api` 静态托管 |

### 10.2 本地开发

- `pnpm dev`：并发启动 api（tsx watch）、worker、web（Vite）。
- 数据库与 Redis 用 `docker compose up -d postgres redis`。
- 迁移：改 schema 后 `pnpm db:generate`；应用迁移用 `pnpm db:migrate`，**启动时不会自动执行**。

### 10.3 镜像构建注意

- Agent SDK 通过 optionalDependencies 分发平台原生 CLI。Docker 构建时**不能** `--omit=optional`，否则运行时报 `Native CLI binary for <platform> not found`。
- 多平台构建（arm64 / amd64）要在对应架构上分别安装依赖，或在 CI 用 buildx + 目标平台执行 `pnpm install`。
- 沙盒镜像与主应用镜像**分别构建**：主应用镜像不含沙盒运行时，沙盒镜像不含业务代码。

---

## 11. 里程碑

| 阶段 | 交付 | 验收 |
|---|---|---|
| M0 | 仓库骨架、compose、DB/Redis、日志、健康检查、CI | ✅ 已完成：`/health/ready` 返回 ok，worker 已连通 Redis，DB 迁移已应用 |
| M1 | MCP Server CRUD + 测试连接 | ✅ 已完成：stdio / http / generated 三种；测试按钮返回真实 `listTools()` 结果 |
| M2 | HTTP→MCP 动态挂载 | ✅ 已完成：`/mcp/:serverId` + Bearer token；工具真实转发上游 HTTP |
| M3 | 智能体文件定义 + 单机运行 | ✅ 已完成：DB → `.mcp.json` / `CLAUDE.md` / `.claude/agents/*.md`，页面可预览 |
| M4 | 队列 + 沙盒 | ✅ 已完成：BullMQ → Docker 容器 → Agent SDK → SSE 回传 text/tool 事件 |
| M5 | 生产化 | ✅ 审计、E2E、CI、限流、CSP、会话吊销、乐观锁、外键、备份恢复、Runbook、状态页均已落地（缺少持久化 HITL 与模型凭证代理，见 [SECURITY.md](SECURITY.md) M12a） |
| M6 | 强隔离（可选） | ⬜ 未开始（`SandboxProvider` 接口已就位；D-12 决定暂不接入） |

---

## 12. 待确认项

1. ~~**项目名称**~~ 已定：**Agentport**（包前缀 `@agentport/*`）。重名检查结果：npm `agentport` 已被占用（0.1.1，非知名项目），GitHub 有 `yakkomajuri/agentport`（30 stars）。因此：
   - **npm 使用 scope**：`@agentport/api`、`@agentport/web`、`@agentport/shared`、`@agentport/worker`（scope 需在 npm 注册，若不用公开 npm 则直接使用）。
   - **Docker 镜像名**：`agentport/api`、`agentport/worker`、`agentport/sandbox`。
   - **展示名**：PACE（仓库与包名仍为 `agentport`）。
2. **登录方式**：Better Auth（username/密码 + Drizzle adapter，会话写 PostgreSQL，httpOnly Cookie `agentport_token`），不使用 JWT，也不在 Redis 校验会话。多账户/RBAC 已在本工作树实现、未合入 main、已通过最终 review、准备发布：稳定 `businessId`、默认四角色、DB 可配置的角色·功能矩阵与对象范围、私有会话/个人记忆隔离；见 §18 与 [account-rbac.md](tasks/account-rbac.md)。
3. **HTTP→MCP 的输入方式**：当前先做手动建工具，表结构按可导入 OpenAPI 设计。是否要 OpenAPI 导入？
4. **智能体是否允许非 MCP 工具**：Bash 默认启用；原生 Read/Write/Edit 仅限记忆、产出、附件与技能参考；其余内置工具默认禁止。
5. ~~**Redis 镜像标签**~~ 已确认 `redis:8-alpine` 可用（§15.2）；当前配置为 Redis 8.10.3（`redis:8.10.3-alpine`）。
6. **沙盒默认后端**：Docker（起步）→ microsandbox（升级）。是否接受先 Docker？
7. ~~**多机部署**~~ 已决定：**只做单机，暂不做多机设计**。见 §6.3。

---

## 13. 已核实事实与修正记录

这一节记录探索过程中**被推翻或修正**的结论，避免以后重复犯错。

| 主题 | 曾经的错误结论 | 正确结论 | 依据 |
|---|---|---|---|
| `strictMcpConfig` | 设为 `true` 以隔离外部 MCP | `true` 会**忽略**项目 `.mcp.json`；要使用文件配置必须保持 `false`，并让 `settingSources` 含 `project` | Claude Code MCP 文档 |
| `allowedTools` | 可以限制工具 | 只是「自动批准」；限制需 `disallowedTools` 裸名或 `tools` | Agent SDK 权限文档 |
| MCP TS SDK | 只有 `@modelcontextprotocol/sdk` | 已分 v1 / v2 两条包线，v2 为 `@modelcontextprotocol/server` + `client` | npm 实际包与类型定义 |
| Agent SDK 与 CLI | 依赖本机 `claude` | SDK 自带平台原生 CLI 二进制（optionalDependencies） | npm 包元数据 |
| Agent SDK 沙盒 | 可以隔离整个 agent | 只隔离 shell；MCP server、文件工具在沙箱外 | sandboxing 文档 |
| `.mcp.json` 加载位置 | 相对 `process.cwd()` | 相对 `options.cwd`，且 `project` 源不回退父目录 | Agent SDK 配置文档 |
| `ANTHROPIC_AUTH_TOKEN` | 不确定是否支持 | 支持，作为 `Authorization: Bearer` 发送 | 环境变量文档 |
| 数据库 | SQLite 足够 | 引入 worker 后改 PostgreSQL | 并发写入模型 |
| Drizzle 版本 | 直接用 latest 标签 | `latest = 0.45.4` 是 stable；1.0 仍是 rc | npm dist-tags |

---

## 14. 会话连续性

项目改名为 **Agentport** 后如何继续：

1. 本文档随仓库移动，位置保持在 `<repo>/docs/PROJECT-BRIEF.md`。
2. 新会话开始时，先读本文档，再读 [CAPABILITY-GAP.md](CAPABILITY-GAP.md)、[DECISIONS-PENDING.md](DECISIONS-PENDING.md)、[SECURITY.md](SECURITY.md)。
3. 如果 Claude Code 的会话上下文丢失，本文档 + 仓库代码即为唯一真相源。
4. 改名记录（已完成，保留作历史）：

```bash
# 1. 仓库目录改名（关闭本会话后执行，或在新路径重新打开）
mv ~/Documents/myself/mcp-learn ~/Documents/myself/agentport

# 2. 进入新目录
cd ~/Documents/myself/agentport

# 3. 同步修改
#    - package.json: name → @agentport/api | web | worker | shared | core | db
#    - pnpm-workspace.yaml: 无需改（使用 packages/*）
#    - docker-compose.yml: name: agentport；服务名 postgres / redis / api / worker
#    - Dockerfile: 镜像 tag agentport/api:dev；沙盒镜像 agentport/sandbox:dev
#    - docs/PROJECT-BRIEF.md: 已更新
```

5. Claude Code 的长期记忆按**项目路径**存储，目录改名后旧路径下的记忆不会被自动读取。新路径下需要重新记录一次关键上下文（文档本身已覆盖主要内容，所以影响有限）。


---

## 15. M0 落地记录（2026-10-20）

以下是在实际搭建中**验证过的事实**与**踩到的坑**，后续开发以此为准。

### 15.1 已验证可用

- `docker compose up -d postgres redis` → 两个容器均 healthy。
- `pnpm -r typecheck` / `pnpm -r build` / `biome ci` 全部通过。
- `GET /health/live` → `{"status":"ok"}`；`GET /health/ready` → `{"status":"ok","db":"ok"}`。
- Worker 启动后成功连接 Redis 并注册 `agent-runs` 队列。
- Drizzle 生成了 8 张表的首个迁移并成功应用。

### 15.2 必须记住的修正

| 问题 | 实际行为 | 处理 |
|---|---|---|
| PostgreSQL 18 镜像的数据目录 | 挂载 `/var/lib/postgresql/data` 会导致容器无限重启；18+ 要求挂载 `/var/lib/postgresql` | compose 已改为后者 |
| `redis:8-alpine` | 实际可用（`docker pull` 成功，容器 healthy）；此前 `docker manifest inspect` 因网络超时误判 | 当时维持该标签；当前配置为 8.10.3（见 §10.1） |
| npm 官方源 | 本机经代理访问 registry.npmjs.org 极慢（15s+），导致 `pnpm install` 长时间无输出 | 根目录 `.npmrc` 固定 `registry=https://registry.npmmirror.com` |
| pnpm 12 的 build script 审批 | pnpm 11 起移除 `onlyBuiltDependencies`、`ignoredBuiltDependencies` 等旧键，统一由 `allowBuilds` 的 `true`/`false` 决定（https://pnpm.io/settings/build#allowbuilds） | 已用 `pnpm approve-builds --all`，配置写入 `pnpm-workspace.yaml` 的 `allowBuilds`（见 OPERATIONS §2.1） |
| BullMQ 6 在 ESM 下 | 不自动加载 ioredis，报 "could not load the optional 'ioredis' package" | worker 包显式依赖 `ioredis@6.0.0` |
| TypeScript `-b --noEmit` | 与 project references 冲突（TS6310） | 各包 typecheck 统一为 `tsc -b`，无 `--noEmit` |
| tsx 与 env | `--env-file-if-exists` 在 tsx 下不生效 | 该参数交给 tsx 传参即可；migrate 脚本用 Node 原生 `--env-file-if-exists` |
| Biome 2.5（历史记录） | `linter.rules.recommended` 已废弃 | 改用 `preset: "recommended"`（已 `biome migrate`），当前版本 2.6.4 |

### 15.3 起步命令

```bash
pnpm install
docker compose up -d postgres redis
cp .env.example .env   # 填写 APP_SECRET_KEY / JWT_SECRET / ADMIN_PASSWORD
pnpm db:migrate
pnpm dev
```

> `.env` 中的 `ANTHROPIC_API_KEY` 与 `ANTHROPIC_AUTH_TOKEN` 二选一；本机当前使用 `ANTHROPIC_AUTH_TOKEN`，Agent SDK 会作为 Bearer token 发送。

---

## 16. M1–M4 落地记录（2026-10-20）

### 16.1 已真实验证的链路

```
浏览器/curl ──会话 cookie（Better Auth）──▶ api
                             ├─ servers CRUD（secrets AES-256-GCM 加密，返回脱敏 ••••）
                             ├─ /api/servers/:id/test ── MCP client ──▶ 真实 MCP 端点
                             ├─ /mcp/:serverId ── createMcpHandler ──▶ 上游 HTTP API
                             └─ /api/chat ── BullMQ ──▶ worker
                                                          └─ docker run ──▶ sandbox runner
                                                                               └─ Agent SDK
                                                                                    └─ mcp__jsonplaceholder__get_user
                                                                                         └─ https://jsonplaceholder.typicode.com/users/1
```

实测结果：模型在容器内调用 MCP 工具，拿到真实用户数据，文本流与 `tool_start` / `tool_input` / `tool_result` 事件都经 SSE 到达客户端。

### 16.2 ID 约定

常规业务实体主键统一通过 `@agentport/db` 导出的 `newId(entity)` 在应用层生成 TypeID，格式为 `<prefix>_<uuidv7 base32>`，前缀以 `packages/db/src/id.ts` 为准。下表为部分示例：

| 实体 | 前缀 | 示例 |
|---|---|---|
| server | `srv` | `srv_01m5afqxxhe4ebscs66w0d9kq8` |
| api tool | `tool` | `tool_01m5afqxzwe4ebscs8b6cqh021` |
| agent | `agt` | `agt_01m5afshq0exxsn0sc47th80fh` |
| conversation | `conv` | `conv_01m5ag6528eh7bw80fjkysa3vp` |
| message | `msg` | — |
| run | `run` | `run_01m5ag7sq6eh7bw81dxdrhkvec` |
| runtime environment | `rte` | — |
| runtime environment version | `rtev` | — |
| audit | `aud` | — |
| knowledge base | `kb` | `kb_01m6k4s2n8x7…` |
| knowledge folder | `kfd` | — |
| knowledge document | `kdoc` | — |
| knowledge version | `kdv` | — |
| knowledge chunk | `kchk` | — |
| knowledge tag | `ktag` | — |
| knowledge job | `kjob` | — |
| knowledge source | `ksrc` | — |
| knowledge source range | `krng` | — |
| knowledge sync run | `ksyn` | — |
| knowledge wiki page | `kwp` | — |
| knowledge wiki version | `kwv` | — |
| knowledge wiki source | `kws` | — |
| knowledge model profile | `kmp` | — |

TypeID 由 uuidv7 编码而来，按时间排序，便于按创建顺序扫描与分页；前缀让日志、URL 和跨表引用自解释。

例外：

- `agent_skills`、`agent_servers`、`knowledge_document_tags`、`knowledge_wiki_sources`：关联表只有复合唯一索引，没有独立 `id`。
- Better Auth 的用户与账号技术 ID 随机生成（bootstrap 也是随机 ID）；`session` / `verification` 默认随机 ID。
- 认证账户的技术 ID 只作登录载体，可删除并重建；业务记录不引用它，统一直接保存稳定 `businessId`（创建人、负责人、会话创建人、用户消息发送人、运行发起人、角色/成员授权、个人记忆）。`session` 属于认证载体，账户重建时不恢复旧会话。字段与接口见 §18 及配套契约文件；实现只在本工作树，未合入 main、已通过最终 review、准备发布。
- `audit_log` 默认用 `newId('audit')`；调用方提供 `dedupeKey` 时直接以其作为主键。
- 市场资源沿用上游的 owner/repo/skill 标识。

UI 实体列表复用实体主键；DataTable 通过 `rowKey` 提供行标识，聚合行可用 `agentId`，消息块可用组合 ID。行标识只要求在对应列表内唯一、在同一项更新期间稳定，无需统一为 TypeID。数据库目前不强制 TypeID 格式约束，沿用应用层生成与各类标识约定，保留已有 ID。

### 16.3 本轮踩到的坑（重要）

| 问题 | 表现 | 修复 |
|---|---|---|
| `.mcp.json` 里的 `mcp__*` 通配无效 | 模型调用 MCP 工具被拒：`Permission ... denied because ... don't ask mode` | allow 规则只支持 `mcp__<server>__` 之后通配。runner 从任务载荷的 `mcpServers` 逐个生成 `mcp__<name>__*` |
| `permissionMode: 'dontAsk'` 会拒绝未预批准的一切 | 仅靠 `allowedTools` 不够 | 用精确 allow 规则 + `disallowedTools` 移除内置工具；显式dontAsk保持拒绝语义。原生提问接入采用default与专用canUseTool，进展及验收见D-68 |
| 容器内 `127.0.0.1` 指向容器自身 | 本机代理 `ANTHROPIC_BASE_URL=http://127.0.0.1:3425` 在容器里 ECONNREFUSED | worker 把 loopback 改写成 `host.docker.internal`，并加 `--add-host host.docker.internal:host-gateway`（Linux 必需） |
| generated server 的测试连错地址 | 测试按钮连上游 baseUrl，返回 `Error POSTing to endpoint` | 改为连平台自己的 `/mcp/:id` 并带 `mcpToken`；新增 `SELF_URL` 配置 |
| 改了 schema 忘记重新生成迁移 | `column "path_template" does not exist` | 改 `schema.ts` 后必须 `pnpm db:generate`；SQLite/Postgres 迁移文件不通用 |
| 对话 ID 前缀写错 | conversation 用成了 `msg_` | 修成 `conv_`；`newId()` 的实体参数现在受类型约束 |
| `biome check` 在并行 lane 之后失败 | 格式不一致 | 统一跑 `biome check --write .` 一次 |

### 16.4 当时未完成、后续循环已补齐

1. ~~审计写入~~：已覆盖登录、server/agent/skill/tool、运行起止与审批、评估、维护（见 OPERATIONS §6）。
2. ~~Redis 限流~~：`@fastify/rate-limit` 使用 ioredis Redis store，无 `rate-limit-redis` 依赖。
3. ~~测试~~：14 个 vitest 文件、82 个用例；当时 E2E 用 Playwright，现已统一为 `e2e`（`e2e` + `@e2e-dev/web`，见 `e2e.config.ts`）。
4. ~~CI~~：`.github/workflows/ci.yml` 已创建。
5. ~~server 编辑 UI~~：servers 页已支持编辑（PATCH + 乐观锁）。
6. **沙盒网络**：仍为 `bridge` + `host.docker.internal`，默认 `SANDBOX_EGRESS=open`（不隔离出站）；`proxy` 必须配代理，否则 worker 启动 fail-closed；生产建议接受控出站代理。
7. ~~SSE 丢事件~~：已改为 Redis Stream 从 0 回放。

---

## 17. 信息架构与业务任务（2026-10-29）

> 本节是当前有效的信息架构契约。与 §1.4 的早期页面诉求冲突时以本节为准；视觉数值仍以 [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md) 为准，验收以 [USER-STORIES.md](USER-STORIES.md) 为准，任务过程见 [agent-experience-redesign.md](tasks/agent-experience-redesign.md)。
>
> §1.4 中「知识库与专家/技能/连接器/插件并列的资源页签」已被本节替代：专家移出资源中心，知识库仍在资源中心。

### 17.1 两类业务任务与账号

- 多账户与权限已在本工作树实现（未合入 main，已通过最终 review、准备发布）；页面行为按 §18 的授权范围执行。
- **使用专家**：找专家 → 开始对话 → 取交付物；在「记忆」维护个人偏好、发起历史回顾。
- **定义专家**：创建/配置专家 → 维护专家记忆；自动进化是已确认缺口。
- 主路径：找专家 → 直接用或创建 → 沟通 → 交付物预览、下载、分享 → 个人与专家记忆。固定版本公开分享、个人偏好、历史回顾已实现；自动进化仍是已确认缺口。现有成果预览、版本切换、下载与基于版本修改继续保留。

### 17.2 导航

```text
工作
├─ 找专家 /agents（默认入口，/ 重定向）
├─ 对话 /chat
├─ 记忆 /memory
└─ 定时任务 /schedules
构建
├─ 资源 /skills（技能 / 连接器 / 插件 / 知识库）
└─ 评估 /eval
运维 /operations（底部独立入口）
├─ 概况（原 OverviewPage）
├─ 运行
├─ 运行环境
├─ 健康
├─ 审计
└─ 返回工作区
```

- 专家不再属于资源中心，资源中心只保留技能、连接器、插件、知识库。
- 运维使用独立导航；业务分组不出现运行、运行环境、健康、审计。
- `/` 不承载业务首页或概况，直接重定向到 `/agents`；概况迁入「运维」。

### 17.3 页面行为

- 专家卡：主操作「开始对话」；名称链接进入配置页；停用专家不执行；卡片不显示连接器/技能计数与 slug。
- 创建：名称、角色、职责与工作方式前置；职责与工作方式写入同一个系统提示词（渲染到 `CLAUDE.md`），不新增职责字段；高级设置放模型与 slug；保留导入。
- 登录：按钮文案为「登录」/「正在登录…」/「重试」；登录成功回到工作区（`/` 重定向 `/agents`）。
- 专家详情：页签为配置 / 专家记忆 / 项目规则 / 输出风格 / 完整文件；不再有运行统计页签，改为「查看运行」次级链接。
- 记忆：页内 line 页签「个人偏好 / 历史回顾」。个人偏好以 DB 为权威、投影为只读 `_users/<sha256(businessId)>/CLAUDE.md` 并由 `UserPromptSubmit` hook 每轮按主体注入（不是 SDK 自动发现的用户级 `CLAUDE.md`）；可保存、下载、查看版本与回滚。历史回顾是用户触发的 `trigger='review'` 运行，产出个人偏好 / 专家 `MEMORY.md` / 专家规则提案，采用后才写入。
- 专家记忆：由原生 auto-memory 在运行中自动写入，不逐条确认；面板可浏览、编辑、删除文件，`MEMORY.md` 是索引。
- 公开分享：成果按 `runId + path` 固定版本，链接为 `/s/<shareId>#<token>`，token 只在 URL 片段；可撤销，撤销后统一 404。
- 专家网格常驻「新建专家」扇形动效卡与「创建数字分身」入口卡（有 `agents.create` 权限时）；数字分身仍是完整角色选项。
- 交付物：预览、版本切换、下载、基于版本修改保持现状；分享从对应版本的会话成果面板发起。

### 17.4 不变量

- 文件系统是智能体定义唯一投影，DB 是编辑来源。
- 个人偏好的权威是 DB，文件只是投影；专家记忆与规则的权威分别是 `agent-memory/` 文件与 `agent_rules`，版本账本记录完整快照。
- 只使用 Claude Agent SDK 一个运行底座；历史回顾复用同一个 `query()`，不引入第二套执行循环或外部记忆服务。
- 品牌视觉数值、已选技术栈不变。

---

## 18. 账户、业务身份与权限矩阵（2026-10-31，本工作树已实现；未合入 main）

> 本节描述本工作树的最终实现，尚未合入 main、已通过最终 review、准备发布；实施契约以 [account-rbac.md](tasks/account-rbac.md) 及其配套契约文件为准，证据与剩余项见任务记录。

### 18.1 业务身份

- 认证账户的技术 ID 保持随机，只作登录载体，可以删除并用同一 `businessId` 重建。
- `businessId` 稳定，由管理员录入且不可修改、不可回收给其他自然人；业务创建人、负责人、会话创建人、用户消息发送人、运行发起人、角色/成员授权和个人记忆都直接记录 `businessId`，不依赖认证技术 ID。
- 删除认证资料后以同一 `businessId` 重建账户，原业务归属、角色、成员授权与个人记忆恢复；旧会话永久失效，不随重建复活。
- 管理员引导（bootstrap）只在首次初始化创建管理员，不覆盖已有密码。

### 18.2 默认角色与边界

| 角色 | 允许 | 不允许 |
|---|---|---|
| 平台管理员 | 全部功能；跨用户运维与审计（读取私有内容留审计） | — |
| 用户 | 使用被授权的专家；访问自己的私有会话、消息与个人记忆 | 管理其他用户或全局资源 |
| 负责人 | 创建并管理本人负责的专家；分配使用、指定维护人员、转交 | 管理账户、全局资源或授权；读取其他用户正文 |
| 维护人员 | 维护被指定的专家 | 管理账户、全局资源、授权、新建/删除/转交；读取其他用户正文 |

默认角色只是数据库初始数据，不按角色名硬编码；可新增/调整角色并配置功能授权。系统 admin 角色授权固定、不可删除或改矩阵（可改显示名）；至少保留一名未停用的活跃管理员，删除、停用、降权或矩阵保存导致无管理员时返回 409。

### 18.3 角色·功能矩阵

- 界面为功能树纵向行、角色横向列；可展开到叶动作单独勾选，父级按叶权限三态聚合。
- 同一授权同时受动作与对象范围（全部/本人/被指定）约束；多角色只合并完整授权结果，不把不同角色的动作与范围拼接。
- 评估与定时任务在功能树中分立，不共用一条权限开关。
- 服务端每个入口执行动作授权与对象范围检查；前端按同一功能目录显示菜单与动作。

### 18.4 数据与隔离

- 私有会话、用户消息与个人偏好/个人记忆按 `businessId` 隔离；平台管理员可跨用户运维与审计，负责人与维护人员不因角色获得其他用户正文读取权。
- 既有专家共享 auto-memory 的读写语义保持不变；个人记忆与专家记忆是不同对象，不互相替代。
- 独立 MCP（`/mcp` 平台 token、`/mcp/:serverId` Bearer token）与公开分享（`/s/<shareId>#<token>`）沿用各自凭据；登录用户权限不扩展到这两类凭据。

### 18.5 范围外

第三方登录、飞书/钉钉等身份源同步、用量/套餐额度/计费、组织多租户均不在本期；不因此新增第二套执行底座或改变现有 SDK 文件契约。

### 18.6 状态

本工作树已实现，未合入 main，已通过最终 review、准备发布。已覆盖同 `businessId` 重建恢复与旧 Cookie 失效、bootstrap 不覆盖密码、多角色不跨对象串联、负责人/维护人员不能读他人正文、跨用户运维审计、角色矩阵配置与入口覆盖、个人记忆隔离，以及 MCP/分享凭据边界不被登录权限覆盖；数据库迁移只在全新空库验证，新增 NOT NULL 字段不回填，不声称旧库可无损升级，部署到既有库需用户明确决定重建数据，不能自动清库。

---

## 附：参考链接

- Agent SDK 总览：https://code.claude.com/docs/en/agent-sdk/overview
- Agent SDK TypeScript 参考：https://code.claude.com/docs/en/agent-sdk/typescript
- Agent SDK MCP：https://code.claude.com/docs/en/agent-sdk/mcp
- Agent SDK 自托管：https://code.claude.com/docs/en/agent-sdk/hosting
- Agent SDK 安全部署：https://code.claude.com/docs/en/agent-sdk/secure-deployment
- Claude Code 沙箱：https://code.claude.com/docs/en/sandboxing
- MCP TypeScript SDK v2：https://ts.sdk.modelcontextprotocol.io/v2/
- microsandbox：https://microsandbox.dev
- Drizzle ORM：https://orm.drizzle.team
- BullMQ：https://docs.bullmq.io
