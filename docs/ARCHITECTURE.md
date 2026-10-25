# 架构

> 本文描述当前代码的实际结构。需求背景与选型理由见 [PROJECT-BRIEF.md](PROJECT-BRIEF.md)；部署与排障见 [OPERATIONS.md](OPERATIONS.md)。

## 1. 分层

代码按依赖方向分层，进程按部署单元拆分。层只能向下依赖。

```
                 ┌──────────────┐
                 │    shared    │  zod schema、共享类型、事件契约
                 └──────┬───────┘
                        │
                 ┌──────▼───────┐
                 │     core     │  工作区渲染、密钥加解密、MCP 条目
                 └──────┬───────┘
                        │
                 ┌──────▼───────┐
                 │      db      │  Drizzle schema、repo、迁移
                 └───┬──────┬───┘
                     │      │
              ┌──────▼─┐  ┌─▼──────┐
              │  api   │  │ worker │      两者互不 import
              └────────┘  └────────┘

  web ──▶ shared（仅此一层）
  sandbox ── 独立产物：镜像内自包含，不参与 workspace 依赖
```

| 包 | 职责 | 不做什么 |
|---|---|---|
| `shared` | `agentInputSchema`、`serverInputSchema`、`chatEventSchema`、`agentRunJobSchema` 等 | 不 import 其他包（zod 除外） |
| `core` | `renderWorkspace()`、`encryptSecrets()` / `decryptSecrets()`、`toMcpJsonEntry()` | 不碰数据库、不碰文件系统 |
| `db` | 表定义、repo、TypeID 生成、迁移 | 不含 HTTP 或业务编排 |
| `api` | 路由、鉴权、MCP 端点、SSE、入队、评估跑批 | 不启动沙盒、不写工作区 |
| `worker` | 消费队列、渲染并写入工作区、管理沙盒、回传事件、维护任务 | 不暴露 HTTP |
| `sandbox` | 容器内 runner：读一行任务 JSON，逐行输出 NDJSON 事件 | 不含业务代码与智能体定义 |
| `web` | SPA；生产由 api 托管静态产物 | 不 import core/db/api/worker |

进程之间只通过 PostgreSQL、Redis、HTTP 通信，不共享内存对象。

**关停顺序**（api）：收到 SIGTERM 后先关闭队列 producer 与 SSE 订阅，再 `app.close()`；关停与超时竞速，超时后强制关闭残留 socket。compose 的 `stop_grace_period` 为 30s。worker 退出时清扫自己遗留的工作区目录，仍为 running 的 run 由 reconciler 收敛。

## 2. 运行时拓扑

```
┌──────────┐   HTTP / SSE    ┌──────────────────────────────┐
│ 浏览器    │ ───────────────▶│ api (Fastify, :3000)         │
│ (SPA)    │◀─────────────── │  /api/*  /mcp  /mcp/:id      │
└──────────┘                 │  /health/*  静态托管 web       │
                             └───┬───────────┬───────────┬──┘
                                 │           │           │
                    ┌────────────▼──┐  ┌─────▼─────┐  ┌──▼─────────────┐
                    │ PostgreSQL 18 │  │ Redis 8   │  │ /mcp/:serverId │
                    │ 配置/会话/运行 │  │ 队列/事件  │  │ 上游 HTTP API   │
                    │ 审计/评估     │  │ 限流      │  └──▲─────────────┘
                    └───────▲───────┘  └─────▲─────┘     │
                            │                │           │
                    ┌───────┴────────────────┴───────────┴──┐
                    │ worker (同一镜像，不同入口)             │
                    │  BullMQ 消费 + 工作区渲染 + 沙盒生命周期 │
                    └───────────────────┬────────────────────┘
                                        │ docker run（宿主 daemon）
                                        ▼
                    ┌───────────────────────────────────────┐
                    │ sandbox 容器                          │
                    │ 只读 /workspace + 只读根 + tmpfs 配置目录│
                    │ runner → Claude Agent SDK → 模型 API   │
                    │        └─ MCP 工具 ──▶ api /mcp/:id    │
                    └───────────────────────────────────────┘
```

要点：

- **api 与 worker 共用镜像**（根 `Dockerfile`），默认入口 `api/dist/index.js`；compose 用 `command` 覆盖为 `worker/dist/index.js`。
- **web 没有独立生产容器**：`WEB_DIST=/app/web`，由 api 静态托管；SPA 路由回退到 `index.html`，`/api`、`/mcp`、`/health` 未命中仍返回 JSON 404。
- **沙盒由宿主 Docker daemon 启动**：worker 挂载 `/var/run/docker.sock`，容器内外使用同一工作区绝对路径。
- **沙盒网络模式**：`open` / `proxy` 使用 `bridge`，并加 `--add-host host.docker.internal:host-gateway`；`none` 使用 `--network none`。
- **Redis 承担四件事**：BullMQ 队列、运行事件流、取消通知、限流计数。

## 3. 一次对话的数据流

```
浏览器                api                    Redis               worker              sandbox
  │                    │                      │                    │                    │
  │ POST /api/chat     │                      │                    │                    │
  ├───────────────────▶│ 校验 + 建会话/run     │                    │                    │
  │                    ├─────────────────────▶│ XADD agent-runs    │                    │
  │◀─ 202 {runId} ─────┤                      │                    │                    │
  │                    │                      │  消费 job           │                    │
  │                    │                      ├───────────────────▶│ 读 agent/servers    │
  │                    │                      │                    │ 渲染工作区到宿主     │
  │ GET /events        │                      │                    │ docker run          │
  ├───────────────────▶│ XRANGE 回放 + 订阅    │                    ├───────────────────▶│
  │                    │◀─────────────────────┤ XADD run:*:events  │◀─ NDJSON stdout ───┤
  │◀─ SSE data ────────┤                      │                    │                    │
  │                    │                      │                    │ Agent SDK 调工具     │
  │                    │◀──── /mcp/:serverId ─┼────────────────────┼────────────────────┤
  │                    │                      │                    │ 写终态 + 消息落库    │
  │◀─ run_finished ────┤◀─────────────────────┤                    │                    │
```

分步说明：

1. `POST /api/chat` 校验 agent 是否存在，创建或复用 conversation，写 user 消息，创建 `agent_runs` 行（`queued`），取最近 20 条历史，投递 `agent-runs` 队列（`jobId = runId`，`attempts: 2`，指数退避 5s；仅当排队数 ≤ 100 时才入队，否则 503），写审计，返回 202。
2. `GET /api/chat/:runId/events` 先订阅 Redis Stream，从 `0` 开始回放，因此 POST 与建连之间的事件不会丢；已结束的 run 直接补发终态。
3. worker 消费 job：若 run 已被取消则跳过；置为 `running` 并发布 `run_started`。
4. worker 从 DB 读 agent、绑定的 server、技能、子智能体，解密 server 密钥，签发本次 run 的短期 MCP token，调用 `renderWorkspace()` 生成文件并写入 `WORKSPACES_DIR/<slug>/<runId>/`。
5. worker 通过 `DockerSandboxProvider` 执行 `docker run`，把任务 JSON 写入容器 stdin。
6. 容器内 runner 读取一行任务，在 `/workspace` 上运行 Agent SDK；stdout 每行一个事件（`text_delta`、`tool_start`、`tool_input`、`tool_result`、`assistant_text`、`run_finished`），日志写 stderr。
7. worker 逐行解析并转发到 Redis Stream；工具调用经 `.mcp.json` 中的地址访问 api。
8. 取消：api 写 `run:<runId>:cancel` 键并 publish；worker 订阅后向容器发 SIGTERM；超时由 worker 计时；两者最终都 `docker rm -f`。
9. 结束后 worker 把 `assistant_text` 与 `tool_result` 写入 `messages`，更新 run 的状态、成本、轮次、token、延迟、错误，发布唯一一条 `run_finished`，写审计。
10. 只有基础设施类失败（Docker 不可用、连接被拒、镜像缺失等）会抛出以触发 BullMQ 重试；业务失败不重试，避免重复计费。

## 4. HTTP → MCP 与平台 → MCP

两个方向共用 MCP 协议与同一个 Node 适配器，但目的不同。

| 维度 | HTTP → MCP（`/mcp/:serverId`） | 平台 → MCP（`/mcp`） |
|---|---|---|
| 解决什么 | 把已有 HTTP API 变成 MCP 工具 | 把平台内的智能体变成 MCP 工具 |
| 工具来源 | `api_tools` 表，每个 generated server 一组 | 所有 `enabled = true` 的智能体，工具名 `run_<slug>` |
| 鉴权 | 沙盒内用按 run 签发的短期 token（DB 存 sha256，run 结束清空）；外部客户端用长期 `mcpToken` | 单个 `PLATFORM_MCP_TOKEN`；未设置则不注册该端点 |
| 调用发生什么 | 按 method / path 模板 / `paramsIn` 转发上游 HTTP | 创建 conversation 与 run，入队，轮询 DB 直到终态，返回最终 assistant 文本 |
| 执行位置 | api 进程内 `fetch` | worker + 沙盒（与浏览器发起的对话同一条链路） |
| 工具定义变更 | 下一次请求重建 handler，立即生效 | 下一次请求重建 handler，立即生效 |
| 超时 | 上游 HTTP 超时由 fetch/运行环境决定 | 默认取 agent `timeoutMs`，上限 30 分钟 |
| 主要代码 | `features/servers/mcp-endpoint.ts`、`generated.ts` | `features/servers/agent-tools-endpoint.ts`、`agent-tools.ts`、`agent-invoker.ts` |

共同点：

- 都使用 `createMcpHandler()` + `toNodeHandler()`，由适配器直接读写原始 req/res，Fastify 不再参与响应。
- 每个 HTTP 请求重建实例，避免跨调用复用。
- 都使用常量时间比较 Bearer token。
- `/mcp/:serverId` 先校验请求头 `x-agentport-run-id` 对应 run 的短期 token（且该智能体必须绑定此 server），失败再回退长期 `mcpToken`。

## 5. 工作区文件模型

数据库是真相源；文件是每次运行前重新渲染的只读快照。

```
data/workspaces/<agent-slug>/
├─ <run-id>/                      每次运行重建，run 结束删除
│  ├─ .mcp.json
│  ├─ CLAUDE.md
│  └─ .claude/
│     ├─ agents/
│     │  └─ <child-slug>.md       子智能体（仅单层；主智能体自己不落盘）
│     └─ skills/
│        └─ <skill-slug>/SKILL.md
├─ agent-memory/                  跨 run 持久：原生 auto-memory
└─ sdk-sessions/<conversationId>/ 跨 run 持久：SDK transcript（按会话隔离）
```

工作区按 run 隔离，run 结束删除；重试复用同一目录。目录 0700、文件 0600。`agent-memory/` 与 `sdk-sessions/` 不属于单次运行，清理与备份都按持久数据处理。

| 文件 | 内容来源 | 说明 |
|---|---|---|
| `.mcp.json` | `agent_servers` + `servers` | `mcpServers` 映射；stdio 写 command/args/env，http 写 url/headers，generated 写 `${SANDBOX_API_URL}/mcp/<id>` + 按 run 的短期 Bearer token 与 `x-agentport-run-id` |
| `CLAUDE.md` | `agents.system_prompt_md` | 系统提示词 + 工具说明 + 技能 + 子智能体清单（含超时）；前台执行与单层委派由运行时环境变量强制，不再逐次写在提示里 |
| `.claude/agents/<child-slug>.md` | 子智能体配置 | YAML frontmatter：`name`、`description`、`model`、`mcpServers`（按名引用根 `.mcp.json`）、`disallowedTools`、`maxTurns` 及子级绑定的 `skills`；**不写 `tools`**，否则 SDK 派生时按名字解析 MCP 工具会得到空集并拒绝启动。父级不写 server 级 `disallowedTools`：子级继承会话权限，server 级 deny 会把子级工具一起移除，父级越权改由 PreToolUse 边界 hook 拒绝。主智能体自己的 md 只用于预览（`GET /api/agents/:id/files`），不落盘，避免被当成可委派子智能体 |
| `.claude/skills/<slug>/SKILL.md` | `skills` 表 | frontmatter：`name`、`description`，正文为技能步骤 |

运行时约定：

- 每次 run 先删除并重建 `.claude/agents/` 与 `.claude/skills/`，解绑后的旧文件不会残留。不要手工往这两个目录放东西。
- 工作区以只读方式挂载到容器 `/workspace`；agent 不能修改自己的定义。
- 内置工具默认全部从上下文移除；`allowedTools` 只负责自动批准。MCP 工具的允许规则按 server name 逐个生成 `mcp__<name>__*`，`mcp__*` 通配无效。
- 父级绑定技能slug从worker传给SDK的`skills`选项；无绑定明确传`[]`，仅控制自动批准的Skill(name)清单，不代表CLI发现清单隐藏其他技能。CLAUDE.md仅列父绑定技能。启用子智能体的绑定技能经批量查询合并到工作区文件，其子定义独立写`skills`预加载字段，不扩展父级SDK许可。真实CLI已发现子定义和技能文件；初始化接口不暴露预加载状态，子级正文加载及实际模型调用仍未验证，支持资源目录另行验收。
- 有子智能体时才放行 `Agent` / `TaskStop`；子智能体自身不再获得委派能力。
- 会话间消息工具（`ListAgents`、`SendMessage`、`SendUserMessage`、`EndConversation`、`Monitor`）默认禁用：
  平台只支持「同步等待返回」这一种智能体沟通模型，发送方不等对方返回就继续与平台约定相悖。
- 平台内的「文件预览」与运行时使用同一个 `renderWorkspace()`，但不落盘；写文件只发生在 worker。

### 官方文件能力与接入状态（2026-10-22核对）

目录与字段以已安装 Claude Agent SDK/Claude Code 版本及官方文档为准；下表为能力清单，不表示所有目录已经生成。项目目录是 `.claude/`，技能入口文件区分大小写为 `SKILL.md`。仅有文件存在不代表能力已加载，需验证加载来源、权限及实际调用。

专家包是官方 `.claude/` 目录的 ZIP：`CLAUDE.md`、`.mcp.json`、`.claude/settings.json`、`.claude/agents/*.md`、`.claude/skills/**`、`.claude/rules/*.md`、`.claude/output-styles/*.md` 保存全部定义正文；根 `agentport.json` 只保存平台元数据（显示名、slug、预算/超时、密钥键名、generated 连接器定义、子定义自有规则等），不复制正文。旧 `agent@1`/`agent@2` JSON 已删除。包内每个技能的资源路径按大小写不敏感比较，禁止占用 `SKILL.md` 及其后代、重复路径和文件/目录祖先冲突；仅目录大小写不同、文件不同的路径（如 `References/a.md` 与 `references/b.md`）允许共存。导入与导出只读校验路径，保留合法路径的原始拼写及 content，不通过改名或归一化修复冲突。

子智能体自有 rules / outputStyles 已支持保存、以自身为根的文件预览、clone 与目录包导入导出；父级委派时不会自动应用这些子级自有配置，父工作区只渲染根智能体的规则与输出风格。clone 复制源智能体自身配置与资源绑定，不复制其子智能体。

| 官方文件/能力 | 加载方式 | 本项目当前状态 |
|---|---|---|
| `CLAUDE.md` 或 `.claude/CLAUDE.md` | project source 加载上下文，与是否使用 claude_code systemPrompt preset 无关 | 已生成根文件 |
| `.claude/rules/**/*.md` | project source；支持按路径组织规则，具体匹配按官方规则 | 已有规则管理、文件预览与根级运行落盘，含 globs 路径匹配配置 |
| `.claude/settings.json` | cwd 下 project settings；权限、环境、Hooks 等按该键允许的作用域生效 | 已生成选中输出风格的 outputStyle；其余主要通过 query options，尚未完整文件往返。**原生 auto-memory 已配置**：runner 通过 `settings.autoMemoryEnabled/autoMemoryDirectory` 指向挂载目录，文件工具权限及验收状态见下方记忆行 |
| `.claude/settings.local.json`、根 `CLAUDE.local.md` | local source；本地覆盖，不作为共享包默认内容 | 当前只启用 project，不默认加载 |
| `.mcp.json`（工作区根） | project source；连接与工具权限需实际验证 | 已生成运行时配置；受限HTTP/stdio文件可事务导入且凭证加密，不执行命令/测试连接；不支持字段与模板明确拒绝，导出不含密钥 |
| `.claude/skills/<name>/SKILL.md` 与其支持资源 | project source 发现；技能启用、可用工具由 SDK 配置控制 | 单文件生成、下载、受限导入及支持资源增删改查已实现；目录包携带父子绑定技能的支持资源。父子绑定技能均落盘，父会话可用 `Read` 只读打开 `.claude/skills/<slug>/references/**/*.md`（写入仍仅限原生记忆目录）；真实CLI正负发现通过，绑定slug原生许可已接入；实际模型按需读取 references 仍未实测 |
| `.claude/agents/*.md` | 文件子智能体定义；程序式同名定义优先 | 已生成子定义与子级 skills 字段，父编辑器可下载已保存且启用定义，预览与运行共用渲染器。**子智能体 MCP 绑定已接通**：子定义写官方 `mcpServers` 名称引用根 `.mcp.json`，运行时用 PreToolUse 边界 hook 保证子级只用自己的 server/技能、父级不隐式获得子级工具；CLI 发现通过，子级实际加载仍以真实模型调试验收（单层约束由 `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` 强制）；主定义预览不下载为子文件 |
| `.claude/commands/*.md` | 官方保留的旧式命令文件；新能力优先 skills | 尚未接入，不另造命令引擎 |
| `.claude/output-styles/*.md` | project source，并按 settings 选择输出风格 | 已有输出风格管理、文件预览与根级运行落盘；选中者写入 settings.json 的 outputStyle |
| Hooks | 由 settings.json 的 hooks 配置或 SDK callbacks 注册；脚本目录本身不是自动发现入口 | 平台层回调与工作区文件Hooks需分别核对，不能仅创建hooks目录声称生效 |
| 插件根中的 `.claude-plugin/plugin.json`、skills/agents/hooks/.mcp.json | SDK `plugins: [{type:'local', path}]` 指定本地插件根；不是默认扫描项目 `.claude/plugins/` | 已接入：ZIP 导入的插件在 DB 保存一份，多个专家引用，运行渲染到 `.claude/plugins/<slug>/` 后传给 SDK。hooks 与 MCP 默认关闭，按专家绑定分别授权，未授权组件由 `renderPlugin` 裁剪。平台子智能体不绑定插件；插件自带子智能体可原生委派。技能、references、插件子智能体、hooks/MCP 开启及撤销授权均有真实沙盒验证。v1 无 marketplace 或替换插件文件的升级入口；专家 ZIP 不携带插件并明确提示。拒绝 LSP/workflows/monitors/bin/userConfig/channels/dependencies |
| `.claude/workflows/*.js`、`.claude/agent-memory/<name>/` | Claude Code 官方目录能力，受版本、工具与会话权限约束 | 原生 auto-memory 使用 `WORKSPACES_DIR/<slug>/agent-memory/`（uid 1000、0700），API/worker 共卷，沙盒 rw 挂载到 `/mnt/agent-memory` 并设置 `autoMemoryEnabled=true`、`autoMemoryDirectory`。主会话仅预批准该目录的 Read/Edit 路径规则（Edit 含 Write），SDK PreToolUse 每次拒绝越界、链接和非普通 Markdown 文件；子智能体仍禁用文件工具。保留官方 `MEMORY.md` 与主题文件；权限/挂载测试通过，真实模型跨 run 记忆验收尚未验证。Workflows 仍不接入 |

会话恢复、预算、取消信号、消息流、宿主 callbacks 等还有 SDK 运行时参数，不能声称全部都可写入 settings.json。`~/.claude/` 的认证、缓存、会话记录等宿主状态不属于可分享项目定义，不复制进用户工作区包。

会话上下文不再拼接历史文本：每个 conversation 的 SDK transcript 持久化在 `WORKSPACES_DIR/<slug>/sdk-sessions/<conversationId>/`，容器只挂这一个目录到 `/home/node/.claude`；续聊传 `resume`，从某条用户消息分支时先复制来源 transcript 再用官方 `forkSession` 截断，成功后写回新 session id。fork 会给消息换新 uuid，映射由 **worker 从宿主 transcript 的 `forkedFrom` 字段计算**（不按位置对齐，压缩过的会话顺序会变），并与消息同事务写库；resume 事件只携带新 session id。transcript 缺失时该轮以 infra 失败，不回退成文本上下文。该目录属于运行时持久数据，随备份保存，但不是可分享定义包的一部分。

当前 sandbox 明确使用 `cwd:'/workspace'`、`settingSources:['project']`；不加载宿主 user/local 偏好。官方加载默认值可能随版本变化，继续显式配置。文件导入必须经过类型、路径与大小校验，不能直接解压到执行目录或自动运行导入的脚本。

官方来源：
- https://code.claude.com/docs/en/agent-sdk/claude-code-features
- https://code.claude.com/docs/en/claude-directory
- https://code.claude.com/docs/en/agent-sdk/skills
- https://code.claude.com/docs/en/agent-sdk/subagents
- https://code.claude.com/docs/en/agent-sdk/plugins
- https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts

## 6. 关键设计决策

| 决策 | 理由 | 代价 / 边界 |
|---|---|---|
| 运行时挂载 MCP，不生成代码 | 改工具定义立即生效；测试与调用走同一端点；其他 Host 也能连 | 每次请求重建 handler；工具执行在 api 进程内 |
| DB 为真相源，文件为快照 | 页面字段与文件一一对应；同一智能体可被其他 Host 直接使用 | 每次 run 都有渲染与写盘开销 |
| 宿主目录 bind mount，不打进镜像 | 一个镜像服务所有智能体；改配置不需重建 | 只支持单机，workspace 必须与 worker 同机 |
| 整个 runner 在容器内 | Agent SDK 自带的 sandbox 只隔离 shell，不能隔离 stdio MCP | 镜像体积更大；每次 run 启动容器 |
| Redis 流契约只在 `shared/run-stream.ts` 定义 | api 与 worker 分属两个进程，键名/通道/取消载荷一旦漂移就是「事件写了没人读」这类静默故障；第 1 轮发现两处独立副本后收敛 | `@agentport/shared` 因此成为沙盒镜像的运行时依赖（见下） |
| 审计写入支持 `dedupeKey` | BullMQ 基础设施重试会重放同一件事；没有幂等键时每次重试都多写一行审计 | 有键时用 `onConflictDoNothing` 而不是覆盖，重复上报被丢弃 |
| 内置工具默认禁用 | 用户可配置任意 stdio server，必须收紧默认权限 | 需要显式绑定 MCP 才能做事 |
| SSE 走 Redis Stream + 阻塞读取 | 订阅前的事件可回放；TTL 自动清理 | 事件保留 1 小时，不落库；每个观众一条独立订阅连接（`XREAD BLOCK`）；回调过慢导致未读事件被 MAXLEN 裁剪时不再补截断提示 |
| MCP容量按执行计数 | 握手、SSE、平台invoke与审批等待不占上游执行槽，避免自等待 | 每进程执行4槽、排队8项；审批等待独立4槽且满时立即需批准，invoke既有4并发入场；非全局多进程限额 |
| 会话历史使用独占游标页 | 网页默认50条、最多100条，按(created_at,id)倒取后正序展示；before须属于当前会话 | nextBefore为空则结束；消息内容字节未单独限制，内部完整复制调用保持原语义 |
| api / worker 分进程 | 长任务不占 HTTP；队列消费可独立扩容 | 多一层队列与状态同步 |

### 6.1 `shared/run-stream.ts`：跨进程的事件流契约

沙盒事件的 Redis 布局由 `@agentport/shared` 的 `run-stream.ts` 唯一定义，**api 的 producer 与 worker 的
消费/订阅两侧都必须从这里取，不得再写字符串副本**（第 1 轮只在 worker 换过来，第 2 轮补上 api，并加了
一个 mock 值的契约测试证明 producer 真的在消费 shared 常量）。

| 导出 | 作用 |
|---|---|
| `RUN_STREAM_MAXLEN`（1000） | `XADD` 的 `MAXLEN ~`，事件流按条数截断 |
| `runStreamKey(runId)` | `run:<runId>:events`，SSE 回放的事件流 |
| `runEventsConnectionName(runId)` | `run-events:<runId>`，订阅连接的名称，用于计数观众 |
| `runCancelKey(runId)` | `run:<runId>:cancel`，取消标记 |
| `RUN_CANCEL_PAYLOAD` | 取消键的固定值 |
| `runEnqueueOptions(jobId)` | BullMQ `jobId` + `attempts: 2` + 5s 指数退避 |

流的 TTL（1 小时）在写入侧设置。订阅者先用 XREVRANGE 有界回放最近 8MiB，再用 `XREAD BLOCK` 从最后一条真实 ID 跟读；`XADD` 本身会唤醒阻塞读取，不再有单独的 pub/sub 唤醒通道或轮询兜底。终态事件丢失仍由 SSE 路由每 2 秒查数据库兜底。

### 6.2 审计幂等：`writeAudit(dedupeKey)`

`packages/db/src/repo/audit.ts` 的 `writeAudit(db, logger, event)` 正常用 `newId('audit')` 生成主键。
传 `dedupeKey` 时它**直接作为主键**并走 `onConflictDoNothing()`：重复上报同一件事只会保留第一行。
worker 在 run 完成时传 `dedupeKey: aud_<runId 去掉前缀>`，因此 BullMQ 的基础设施重试重放同一个 job 不会写出多条「run 完成」审计。
审计写失败只 `logger.warn`，不影响 run 的终态。

### 6.3 沙盒镜像依赖 `@agentport/shared`

runner 在 stdin 边界用 `@agentport/shared` 的 zod schema 校验任务（`agentRunJobSchema`），所以该包是
**镜像的运行时依赖**，不只是构建期依赖：

- Dockerfile 复制 `dist/`、`shared/`（即 `packages/shared/dist`）与 `package.shared.json`（镜像内的独立 manifest）。
- 构建脚本必须先构建 shared 并把 `packages/shared/dist` 复制到 `packages/sandbox/shared`，再 `docker build`；否则报 `COPY shared/: not found`，或镜像能构建但运行时报 `ERR_MODULE_NOT_FOUND`。
- `packages/sandbox/.dockerignore` 单独放行这两个目录（根 `.dockerignore` 会排除 `**/dist`）。
- 步骤见 [OPERATIONS.md §3.1](OPERATIONS.md#31-手动构建沙盒镜像)；`pnpm run up --rebuild` 已包含全部三步。
| 单机优先，不抽象多机 | 少一层存储与服务发现 | 不能横向扩容 worker |
| TypeID（`srv_`、`agt_`、`run_`…） | 可排序、日志与 URL 自解释 | 依赖 `typeid-js` |
| 智能体版本快照 + 回滚 | 配置变更可追溯，回滚生成新版本 | 需维护保留策略 |
| 评估跑批在 worker 队列内 | API 只建行并入队，重启不丢跑批 | `eval-runs` 串行（并发 1）；超时 running 由 reconciler 收敛 |

更细的选择理由（为什么 PostgreSQL、为什么 v2 MCP 包线、为什么不用 microsandbox 起步）见 `PROJECT-BRIEF.md` 与 `DECISIONS-PENDING.md`。
