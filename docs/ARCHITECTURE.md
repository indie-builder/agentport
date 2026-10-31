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

  web ──▶ shared、core 的纯函数子路径（workspace / tools / plugin-display）
  sandbox ── 同一 workspace 的 runner；镜像内由 pnpm deploy 自包含
```

| 包 | 职责 | 不做什么 |
|---|---|---|
| `shared` | `agentInputSchema`、`serverInputSchema`、`chatEventSchema`、`agentRunJobSchema` 等 | 不 import 其他包（zod 除外） |
| `core` | `renderWorkspace()`、`encryptSecrets()` / `decryptSecrets()`、`parseMcpJson()`、`embedTexts()` / `rerankDocuments()` / `segmentForSearch()`、`writePersonalMemoryProjection()` | 不碰数据库、不启动进程；纯函数模块不做 I/O，`outputs.ts` / `attachments.ts` / `personal-memory.ts` 只在调用方传入的根内读写宿主文件；`knowledge-models.ts` 只发 HTTP |
| `db` | 表定义、repo、TypeID 生成、迁移 | 不含 HTTP 或业务编排 |
| `api` | 路由、鉴权、MCP 端点、SSE、入队、评估跑批 | 不启动沙盒、不渲染每轮定义；宿主文件只经既有记忆/附件/成果入口读写投影 |
| `worker` | 消费队列、每轮渲染定义到会话工作区、管理会话沙盒（复用/空闲回收）、回传事件、维护任务 | 不承业务 REST；唯一 HTTP 监听是模型凭证代理 |
| `sandbox` | 容器内 supervisor 常驻；每轮启动新 runner query，读任务并逐行输出 NDJSON 事件 | 不含业务代码与智能体定义 |
| `web` | SPA；生产由 api 托管静态产物 | 不 import db/api/worker，也不 import core 根入口（根入口含 `node:crypto` 模块）；仅引用 core 的纯函数子路径 `workspace`、`tools`、`plugin-display` |

进程之间只通过 PostgreSQL、Redis、HTTP 通信，不共享内存对象。

**关停顺序**（api）：收到 SIGTERM 后先关闭队列 producer 与 SSE 订阅，再 `app.close()`；关停与超时竞速，超时后强制关闭残留 socket。compose 的 `stop_grace_period` 为 30s。worker 关停时由会话沙盒管理器 `close()` 收口 active/idle/pending 容器；stdin EOF 让 supervisor 收尾退出，容器以 `--rm` 删除。稳定的会话工作区与成果根不随 run 或关停删除；仍为 running 的 run 由 reconciler 收敛。

### 1.1 前端页面地图

`packages/web/src/pages/` 下有五个文件已过千行（`agents` 3677、`knowledge-detail` 3434、`chat` 2451、`servers` 2183、`eval` 1072），进文件前先看这张表定位，不要整文件读。

| 页面 | 职责 | 会碰到的共享件 |
|---|---|---|
| `agents.tsx` | 专家/智能体：列表、配置表单、版本历史、文件视图 | `page.tsx`、`agent-avatar.tsx`、`resource-page.tsx`、`dialog-shell.tsx` |
| `chat.tsx` | 对话三栏：会话列表、消息流、右侧产出；SSE 生命周期 | `agent-avatar.tsx`、`openui-message.tsx`、`code-block.tsx`、`motion-collapsible.tsx`、`knowledge-citations.tsx` |
| `knowledge-detail.tsx` | 单个知识库：文档、来源、Wiki、检索调试 | `knowledge-citations.tsx`、`source-editor.tsx`、`markdown.tsx`、`filter-select.tsx` |
| `servers.tsx` | 连接器：MCP/stdio/生成式 server、工具目录、测试连接 | `resource-page.tsx`、`dialog-shell.tsx`、`filter-select.tsx`、`source-editor.tsx` |
| `eval.tsx` | 评估：数据集、跑批、结果对比 | `data-table.tsx`、`dialog-shell.tsx` |
| 其余（`skills`、`plugins`、`runtime-environments`、`ops`、`overview`、`audit`、`runs`、`status`、`memory-panel`、`knowledge`、`personal-profile`、`personal-memory`、`personal-security`、`personal-shares`、`personal-usage`） | 各资源页，多数是列表 + 详情/表单；`runs`/`audit`/`overview` 用 `data-table.tsx`，`knowledge` 用 `knowledge-settings.tsx`，个人模块五页沿用标准 Page/表格/Dialog 并共用 `personal-profile.tsx` 的个人导航外壳 | 同上，优先复用而不是新写 |

页面骨架统一走 `components/page.tsx`（`Page`/`PageHeader`/`PageToolbar`/`PageSection`）；每个渲染状态恰好一个 `h1`。共享状态在 `lib/`（`api.ts`、`queries.ts`），路由表由 `routes/` 生成到 `routeTree.gen.ts`。

### 1.2 状态与副作用库的职责边界

- **客户端状态**：Zustand 统一管理跨组件、非服务端的交互状态，按业务域复用现有 store；服务端数据归 TanStack Query，可导航状态归 TanStack Router，平台表单归 RHF/`useZodForm`，生成式表单归 OpenUI 官方运行时，组件私有临时状态留本地。细则见 [packages/web/CLAUDE.md](../packages/web/CLAUDE.md#状态与复用)。
- **任务/请求内副作用**：Effect 只管单个任务内的类型化错误、取消/超时、资源释放与并发。Fastify 请求生命周期、BullMQ 分发与重试、`SessionSandboxes` 容器生命周期、Claude Agent SDK 唯一执行循环各自负责，Effect 不接管，也不做全仓机械改写。公共契约在 `packages/core/src/effect-runtime.ts`（`DbError` / `RunFailure` / `runProgram`）；api/worker 按各自语义用 `Effect.runPromiseExit` / `Effect.runPromise` 进入，边界细则见各包规则。

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
                    │  BullMQ 消费 + 每轮渲染 + 会话沙盒生命周期 │
                    └───────────────────┬────────────────────┘
                                        │ acquire 会话容器（宿主 daemon）
                                        ▼
                    ┌───────────────────────────────────────┐
                    │ sandbox 会话容器（每会话一个）          │
                    │ supervisor 常驻；每轮新 runner query    │
                    │ /workspace 只读 + /mnt/outputs 可写     │
                    │ runner → Claude Agent SDK → 模型 API   │
                    │        └─ MCP 工具 ──▶ api /mcp/:id    │
                    └───────────────────────────────────────┘
```

要点：

- **api 与 worker 共用镜像**（根 `Dockerfile` 的 `runtime` target），默认入口 `api/dist/index.js`；compose 用 `command` 覆盖为 `worker/dist/index.js`。沙盒基座镜像由同一 Dockerfile 的 `sandbox` target 产出，构建上下文同为仓库根；它是命名运行环境构建的固定基座，会话容器实际使用环境线上版本记录的本地 image ID。
- **web 没有独立生产容器**：`WEB_DIST=/app/web`，由 api 静态托管；SPA 路由回退到 `index.html`，`/api`、`/mcp`、`/health` 未命中仍返回 JSON 404。
- **沙盒由宿主 Docker daemon 启动**：worker 挂载 `/var/run/docker.sock`，容器内外使用同一工作区绝对路径。同一会话短期复用一个容器，空闲 `SANDBOX_IDLE_TIMEOUT_MS`（默认 5 分钟）后回收；试连与 native plugin 动作仍走一次性容器。容器镜像来自所属运行环境创建时解析的线上版本，存活容器不随发布/回退替换。
- **沙盒网络模式**：`open` / `proxy` 使用 `bridge`，并加 `--add-host host.docker.internal:host-gateway`；`none` 使用 `--network none`。
- **Redis 承担四件事**：BullMQ 队列、运行事件流、取消通知、限流计数；知识任务使用独立队列 `knowledge-jobs`。
- **知识存储另挂 `knowledgedata:/knowledge`**：api 与 worker 共卷，原件与解析产物不进数据库、不进工作区。

### 2.1 命名运行环境

运行环境是平台基础设施，不是官方 `.claude/` 能力，也不向智能体目录写私有字段。需要额外系统依赖时改环境 Dockerfile，而不是把包写进智能体定义。

- **数据与身份**：`runtime_environments` 保存名称、Dockerfile 草稿、`is_default` 与 `online_version_id`；`runtime_environment_versions` 每次构建一行，保存 Dockerfile 快照、`base_image_id`、状态（`queued/building/ready/failed`）、`image_tag`/`image_id` 与截断日志。版本不可覆盖；智能体绑定环境，不绑定版本。
- **构建**：独立队列 `runtime-environment-builds`，并发 1，jobId = versionId，失败不自动重试。构建上下文是只含冻结 Dockerfile 的临时空目录，不发送仓库、工作区或 env；基座先解析为本地 image ID 并派生不可变 tag，经 `ARG RUNTIME_BASE_IMAGE` 传入，默认复用 BuildKit 层缓存。日志按 1 秒或 16 KiB 窗口流式落库，DB 只保留 64 KiB 尾部并置 `log_truncated`；日志写入失败时版本收敛为 `failed`，不会变成 `ready`。构建成功前的真实容器校验会拒绝镜像声明的任何 `VOLUME`（防止 `/app/dist` 变成可写匿名卷），实际启动 runner/supervisor/probe/native-plugins 入口到各自协议边界，执行 SDK 原生 CLI `--version`，确认 PATH 上有 Bash，并要求 uid 1000、只读根文件系统与 `/app` 不可写。多阶段构建只保留运行时内容；安装归档与缓存清理由用户 Dockerfile 在同一 RUN 层完成。worker 运行镜像的 `runtime` target 需带 `docker-cli-buildx`（根 Dockerfile 已装），它不进入沙盒基座。
- **线上指针**：构建成功只写 `ready` 版本，不自动发布；发布与回退共用 `PUT /api/runtime-environments/:id/online-version`，只移动指针。
- **容器**：只有真实创建容器的路径调用 resolver 读取线上版本；复用存活容器不读线上，发布/回退或下一轮对话都不会替换它。容器消亡后重建才使用当时的线上版本，`agent_runs` 记录容器实际使用的环境 ID/名称、版本 ID 与镜像 ID。
- **默认环境**：worker 首次启动登记默认环境：本地没有 `SANDBOX_IMAGE` 时先复用 `DockerSandboxProvider.ensureImage` 拉取，再用真实本地 image ID 登记默认环境和首个 `ready` 版本（`image_id` 与 `base_image_id` 都是该 image ID，不是 tag）。默认环境已存在时完全不 inspect/pull、不推进线上指针；`SANDBOX_IMAGE` 只作为新构建的基座。
- **绑定与导入**：`agents.runtime_environment_id` 为 `null` 表示平台默认环境，非空为明确绑定；绑定前要求该环境已有可用线上版本。专家包 sidecar 只写环境名称，导入时按显式选择或同名环境映射，不导入镜像、版本历史，也不执行构建。子智能体不单独选择环境。
- **边界**：环境只决定容器镜像及其中预装的运行时依赖；`.claude/` 定义仍每轮渲染并只读挂载。没有可用线上版本时明确报错，不偷偷换环境。
- **入口**：系统导航「运行环境」提供列表、Dockerfile 草稿、构建版本/日志、设为线上与删除（默认环境、仍被绑定或存在排队/构建中版本时 409）；专家「运行限制」与 stdio 试连可选环境；专家包导入可选目标环境或按同名环境映射。实现状态以当次代码和任务记录为准。

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
  │                    │                      │                    │ 每轮渲染会话定义    │
  │ GET /events        │                      │                    │ 复用会话容器        │
  ├───────────────────▶│ XRANGE 回放 + 订阅    │                    ├───────────────────▶│
  │                    │◀─────────────────────┤ XADD run:*:events  │◀─ NDJSON stdout ───┤
  │◀─ SSE data ────────┤                      │                    │                    │
  │                    │                      │                    │ Agent SDK 调工具     │
  │                    │◀──── /mcp/:serverId ─┼────────────────────┼────────────────────┤
  │                    │                      │                    │ 写终态 + 消息落库    │
  │◀─ run_finished ────┤◀─────────────────────┤                    │                    │
```

分步说明：

1. `POST /api/chat` 校验 agent 是否存在，创建或复用 conversation，写 user 消息，创建 `agent_runs` 行（`queued`），投递 `agent-runs` 队列（`jobId = runId`；载荷只有 `runId`、`agentId`、`conversationId` 与本轮 `prompt`，不携带历史文本；`attempts: 2`，指数退避 5s；仅当排队数 ≤ 100 时才入队，否则 503），写审计，返回 202。续聊/分支状态由 worker 从 DB 读取。
2. `GET /api/chat/:runId/events` 先订阅 Redis Stream，从 `0` 开始回放，因此 POST 与建连之间的事件不会丢；已结束的 run 直接补发终态。
3. worker 消费 job：若 run 已被取消则跳过；条件认领 `queued → running` 后发布 `run_started`。发布失败时把仍为 `running` 的行条件回退 `queued` 并清 `startedAt`，再抛出原错误，使 BullMQ 重试能重新认领；不把行留在 `running`。若这次已是最后一次尝试（回退后停在 `queued`），或回退自身失败（停在 `running`），由现有 reconciler 收敛：`queued` 用 worker 的 `AGENT_TIMEOUT_MS`（默认 10 分钟）从 `createdAt` 起算，`running` 用该 agent 当前 `timeoutMs` 从 `startedAt` 起算。两者都加 5 分钟宽限并先探测队列：只有 job 已消失或已到终态才条件置 failed；`running` 即使已超过超时上限，job 仍处于 `active`/`waiting`/`delayed` 等有效状态或 Redis 探测失败时保持 running，因此调低专家 timeout 不会终止仍在执行的有效 job。每 5 分钟扫描，通常从各自起算点 15–20 分钟内以通用 `LOST_RUN_ERROR` 收敛；这是常态时延，不是发布失败后的保证期限，也不额外加锁或补偿。
4. worker 从 DB 读 agent、绑定的 server、技能、子智能体，解密 server 密钥，签发本次 run 的短期 MCP token，调用 `renderWorkspace()` 把官方定义刷新写入 `WORKSPACES_DIR/<slug>/session-sandboxes/<conversationId>/workspace/`；该会话目录只读挂载，每轮覆盖定义内容，根目录不按 run 重命名或删除。
5. worker 通过会话沙盒管理器 `SessionSandboxes.acquire(conversationId)` 取得该会话的容器：首次创建时按智能体绑定环境（`null` 为平台默认环境）解析当时线上版本，用版本记录的本地不可变 image ID 创建并启动常驻 supervisor，之后复用空闲容器；已存活容器保持创建时的旧版本，发布/回退只影响之后新建的容器。线上版本缺失或本地镜像不存在时明确失败，不隐式 pull、不回落其他环境。取得容器后先把 sandbox id（容器名）写入运行行，再启动本轮 runner，供 worker 重启后按 id 清理。supervisor 轻量驻留，每轮由 worker 经 stdin 投递任务，并在容器内启动新的 runner query，不复用上一轮的 query 或进程环境。会话容器与试连、native plugin 的一次性容器共用同一个 `DockerSandboxProvider.create/destroy` 底层接口；一次性容器不走会话复用。create 请求已经发出后取消会等待创建结果并删除，绝不继续启动。
6. 会话容器准确挂载 `sdk-sessions/<conversationId>`（→ `/home/node/.claude`）、`agent-memory`、`conversation-inputs`（首轮无附件也预建并挂载）与只读 `/workspace`；`/mnt/outputs` 指向稳定的 session outputs 目录，读写。每轮凭证只经新 runner 的进程环境与当轮 `.mcp.json` 注入。容器内 runner 读取一行任务，在 `/workspace` 上运行 Agent SDK；stdout 每行一个事件（`assistant_block_start`/`assistant_block_stop`、带 `blockIndex` 的 `text_delta`、`tool_start`、`tool_input`、`tool_result`（可选带 `todos` 快照，见 §3.1）、按块完成的 `assistant_text`、`run_finished`），日志写 stderr。块边界与 `sdkUuid`/`parentToolUseId` 让前端按内容块重建，单块超过 `SANDBOX_MAX_FIELD_BYTES`（默认 1MiB）时截断并标 `truncated`，不再静默丢尾部。
7. worker 逐行解析并按事件写入 Redis Stream：`XADD` 不做 MAXLEN 裁剪，每次写入把 TTL 续到 1 小时（同一 pipeline）；写入量只受 worker 的展示/落库预算约束，不再由 Redis 按条数裁掉流头，无新事件满 1 小时后整条流过期。supervisor 的业务事件保持原 `ChatEvent` 契约，`ready`/`started`/`settled`/`rejected` 等 control 事件只用于宿主握手，不写 SSE。工具调用经 `.mcp.json` 中的地址访问 api。
8. 取消：api 写 `run:<runId>:cancel` 键并 publish；worker 通知 supervisor 停止本轮。supervisor 发出 `settled` 并确认所有 run 进程停稳后，正常完成或成功取消可 `release(reuse=true)` 进入空闲；超时、异常或无法确认停稳则销毁容器。创建阶段的取消信号中止拉取，已发出的 create 则等待返回后删除、不启动。试连与 native plugin 也走同一 provider，但每次一次性 `create/destroy`，不进入会话复用。
9. 结束后 worker 把 `assistant_text`（每块一行，内容保留 `blockIndex`/`parentToolUseId`/`truncated`）与 `tool_result` 写入 `messages`，更新 run 的状态、成本、轮次、token、延迟、错误，发布唯一一条 `run_finished`，写审计。事件展示额度（`RUN_TRANSIENT_MAX_EVENTS=2000` / `RUN_TRANSIENT_MAX_BYTES=32MiB`）与落库额度（`RUN_PERSISTED_MAX_EVENTS=2000` / `RUN_PERSISTED_MAX_BYTES=32MiB`）分开，常量只在 `shared/run-stream.ts` 定义：`text_delta`、块边界等瞬时事件超出展示上限只停止展示；完整 `assistant_text`、工具事件与问题快照共用落库额度，不会被增量挤出。两类溢出都发布非终态的 `replay_truncated {reason:'budget'}`：瞬时溢出只停止展示，后续完整 `assistant_text` 仍继续补齐；落库溢出则停止继续收集，保留已收集结果，把成功改为带明确原因的不可重试失败，避免缺失尾部仍报告成功。若本次 attempt 还会被 BullMQ 重试，失败轮次的 `outcome.sessionId` 与 fork `uuidMap` 不落库，保留会话已有的 `sdkSessionId`/fork 锚点；成功或最终失败才提交本轮 SDK 状态。
10. 只有业务执行本身的基础设施类失败（Docker 不可用、连接被拒、镜像缺失等）会触发 BullMQ 重试；业务失败不重试。清理失败不作为基础设施失败重跑；已确定的终态与取消收尾的 `sessionId`、费用 metadata 保留。停稳未确认且容器销毁失败时不写终态、不发布 `run_finished`、不触发 BullMQ 重试：运行保持 `running`、`endedAt` 为 NULL，完整终态事件暂存到 `agent_runs.pending_finish`（可空 JSONB）。下一轮 reconciler 在队列 job 仍有效时继续等待，job 已消失或已终态才按运行行保存的 sandbox id 清理；probe 后重读 run status，并用 `expectedRunId` 拒绝清理仍被其他 run 持有的容器。清理失败继续占用，成功后条件更新终态、清空 `pending_finish` 并只发布一次终态与写一次审计。跨 worker 重启仍按 id 清理，Docker 暂不可用时保持占用、恢复后下一轮再清理。销毁失败期间不发布成果并保留草稿，避免把未停稳的一轮当成已交付。

事件流保留与恢复（2026-10-31）：`subscribeRun` 首次回放从 `0-0` 正序按 `XRANGE COUNT 2` 逐页读取，每页 `await` 回调完成后才读下一批，再以最后一条真实 ID 做 `XREAD BLOCK` 跟读；不再从尾部累计 8MiB，也不再在服务端截断或补 `reason:'bytes'`。前端在 `run_started` 时只清掉本轮旧 attempt 的助手输出，保留本轮 user 与更早轮次；收到终态后重新分页读取本轮完整消息并合并已加载历史 prefix，跨页补出本轮 user 锚点，避免首屏历史在 run 查询变终态后仍是旧内容；截断补读期间保留本轮 run 作为发送屏障，补读结束才释放；run 详情 404 时释放 `detached` 假运行并保留可读历史。

恢复链路仍有的真实限制：Redis 流无新事件满 1 小时会过期，之后只能靠已落库消息恢复；runner 单块受 `SANDBOX_MAX_FIELD_BYTES`（默认 1MiB）约束；落库额度为 2000 条 / 32MiB，超出即失败；终态 `uiProgram` 不受 8MiB NDJSON 行预算约束，因此不承诺日志严格 64MiB 总量；单条 SSE 事件本身可以较大（如 `run_finished` 的 canonical），回放不设累计字节上限；不引入新 snapshot 或游标。

会话读写边界（2026-10-31）：会话详情、搜索、列表、改名与分支都注册 shared response schema；详情只返回公开四字段（`id`/`agentId`/`title`/`createdAt`）与消息公开字段，SDK session/message UUID、fork 锚点与 `createdBy` 等内部状态不进 wire，分支额外保留 `parentId`/`branchOfMessageId`。`content`/`uiState` 仍为不裁剪的 unknown JSON，日期显式 ISO；成果列表、元数据与正文复用 shared output schema；web 的运行与概况类型由 shared schema 推导，不再维护第二份声明。授权、续聊与分支仍读 repo 整行，收窄只发生在响应投影。

事件流健康与回读（2026-10-31）：`streaming` 只在 EventSource `onopen` 后成立；发送已接受但尚未连上时为 `reconnecting`，`onerror`、协议 error 与重试耗尽转 `detached`。会话内 `RunReconciliation` 仅在 run 状态不是 `streaming` 时保留每 2 秒完整 `GET /runs/:id` 回读；健康窗口只保留首次详情请求，服务端每 2 秒终态补偿、断线回放、canonical 恢复与审批/原生提问独立轮询不变，取消的 `onSettled` invalidate 仍可回读。

账户级状态撤销（2026-10-31）：显式退出由 `logoutAccount` 同时清 Query 与聊天 store（草稿、消息、附件、run/成果引用等），并同步递增 `accountEpoch`；`/me` 确认业务身份时同身份不清稿，换人或无归属先 reset。已挂载的聊天页订阅该信号同步 `closeStream()`（递增 generation、关闭 EventSource、清重试计时器），晚到发送、恢复与 SSE 事件不能写回新账户；401 与改密重登仍只清 Query 并保留草稿。

会话串行与范围：同一会话的 run 通过 lease 串行执行，lease 持续到消息与本轮成果发布完成；不同会话相互独立。首版仍是现有单 worker 的进程内管理，不包含多 worker 路由、容器池、快照或新 provider；空闲容器计入资源占用，但不计入 `AGENT_MAX_CONCURRENT` 的同时执行数。容器复用只省创建/启动（缓存镜像基线约 122ms/次），不跳过每轮 SDK query 启动，不算也不承诺 SDK 冷启动优化。实现状态（2026-10-29）：session manager、supervisor、core 限定 review 与取消链路独立复审均通过，已发现阻断项修复并复核。最终联合回归 root backend 38 files 458 passed / 0 failed / 0 skipped（含真实 Docker 8 例与 SDK + 本地假 Anthropic SSE 4 例，均从当前源码独立临时编译）；真实付费模型与浏览器全链路未测，不据此声称生产可用或多 worker 支持。

### 3.1 原生任务清单进度（TodoWrite）

平台不新增任务表或第二个执行循环，进度只来自官方 `TodoWrite` 的结构化结果：

- **启用**：`PORTABLE_TODO_ENV` 设置 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 与 `CLAUDE_CODE_ENABLE_TASKS=0`，选择原生 `TodoWrite` 而非四个 Task 工具；`SANDBOX_RUNTIME_ENV` 复用它写入工作区 `.claude/settings.json.env`，runner 启动 SDK 时合并进程环境。显式 `disallowedTools` 仍然生效；当轮在 `dontAsk` 下已完成真实调用验收。专家导出包携带两个可移植 TodoWrite env 及选中的 `outputStyle`，不携带沙盒专有的后台任务与委派深度约束；导入仍不执行外来 env，导出按平台必需项重新生成。
- **快照来源**：runner 只记录主会话（`parent_tool_use_id === null`）的 `TodoWrite` 调用 id；只有该调用成功、且同一 user 消息的 `tool_use_result.newTodos` 通过 `progressTodoSchema` 校验时，才发出完整列表快照。工具失败、结果缺失或损坏、子智能体调用都不更新清单。
- **事件与持久化**：`tool_result` 事件新增可选 `todos`（`{content, activeForm, status}` 数组）。省略表示本事件不改清单，空数组表示清空，出现时整体替换；worker 把它与同一 `tool_result` 行一起落库，`content`/`activeForm` 走现有脱敏。快照 JSON 超过 `maxFieldBytes` 时整份不发送并在 stderr 记录原因，保留上一份确认清单，不发送删减后冒充完整的快照。
- **展示**：实时流、历史恢复与重连回放复用同一字段；每个用户轮次只显示最后一次确认的顶层快照。子智能体清单不进入主清单，空快照隐藏清单；没有清单时保留原有工具与运行状态行，不新增空态。
- **边界**：清单是模型自报的步骤进度，不是运行成功、完成度或成果质量的判据；停止、失败或成功都不会自动改写步骤状态，运行终态也不会替模型补完未完成项。没有任务表、endpoint、队列或 schema 迁移。

能力状态（2026-10-28）：已由 [PR #96](https://github.com/indie-builder/agentport/pull/96) 合入 main（`cd95b19`）。真实 SDK→沙盒→SSE→历史保存已通过14项验收；浏览器刷新后保留同一份清单。独立 review 的导出设置、快照大小、确认顺序与字号问题已修复并复核通过；测试和完整证据见 [任务记录](tasks/platform-capability-gaps.md)。此证据只验证用户故事 US-6.3 的进度环节，不代表子智能体与整个复杂任务故事均已验收。官方依据见 <https://code.claude.com/docs/en/agent-sdk/todo-tracking>。

### 3.2 会话成果的生成、版本与查看

成果是运行数据，不是智能体定义；不新增成果表，也不把 `.claude/` 文件当成果。用户消息可携带 `output: { runId, path }`，API 校验该版本属于当前会话后随用户消息落库；worker 读取它准备下一轮草稿。每轮发布后，`GET /api/conversations/:id/outputs` 按版本返回有变化的文件，认证的 `GET /api/conversations/:id/outputs/:runId?path=` 返回该版 `{ file }` 元数据（大小、类型、sha256、创建时刻、状态与消息锚点，含列表分页外的旧版），`.../outputs/:runId/content` 返回完整 UTF-8 文本，`.../download` 返回原件。前端右侧成果面板按路径分组、可选版本、阅读/源码切换和下载；图片仅 PNG/JPEG/GIF/WebP，经鉴权下载取 Blob 且浏览器解码成功后才显示，解码失败保留下载；PDF 经同一鉴权下载取 Blob 交给浏览器原生查看器，`navigator.pdfViewerEnabled` 与 `%PDF-` 前 5 字节 header 门槛不满足时只提示并保留下载；“基于此版本修改”只挂引用，不自动发送，用户可继续编辑或取消。Fork 只复制历史边界内且两个消息锚点都能映射的版本，并把锚点重写为分支消息 ID；删除会话或专家回收成果，run 保留期清理不删除成果。

固定版本公开分享单独建 `output_shares`：`POST /api/conversations/:id/output-shares` 锚定 `runId + path` 的真实字节并复用同三元组的有效分享，`GET /api/public/output-shares/:id[/content|/download]` 在未登录下凭 Bearer token 访问，`DELETE /api/output-shares/:id` 幂等撤销。公开元数据只含文件名、大小、类型、哈希与创建时刻；无效、撤销或来源删除统一 404。公开页图片仅 PNG/JPEG/GIF/WebP，经 Bearer 下载且解码成功后才显示；PDF 与会话成果共用 `BlobPdf`（Bearer 下载 + 同一支持/header 门槛），旧的对象 URL/iframe 分支已移除；其余格式沿用既有行为。

边界：当前模型没有删除工具，多文件中的单文件删除不作为支持路径；二进制仅 PNG/JPEG/GIF/WebP 图片与 PDF 有预览（PDF 为浏览器原生查看器 + header 门槛，不是结构或安全完整验证），Office 无预览；HTML/SVG 只按源码展示；正文超过 1MiB 只下载。成果正文是交付内容，不套用聊天的密钥脱敏；路径逃逸、符号/硬链接和跨会话读取在存储与 API 边界拒绝。

实现状态（2026-10-28）：真实两轮12/12、分支8/8、停止后保留2/2、浏览器预览/下载与反馈挂引用通过；串行后端1824/1824、Web905/905、API9/9、typecheck/build通过，独立评审通过。Office/PDF不预览、无删除工具、成果内容不做聊天脱敏；详见 [任务记录](tasks/agent-output-viewing.md) 与 D-67。成果查看不代表成果质量自动通过。

后续更新（2026-10-30）：新增认证 `outputs/:runId?path=` 元数据接口（响应只含 `{ file }`，handler 仍整份读取所选文件校验 manifest 成员，不回正文）与 PNG/JPEG/GIF/WebP 图片预览；会话成果面板与公开分享页共用 `BlobImage`，解码成功才显示，损坏字节保留原件下载；公开页只替换 image 为共享组件，PDF 行为随后续 PDF 任务改为共享 `BlobPdf`。三轮 Opus review 与最终浏览器验收通过；源码 `e4d414d` 已由 PR #121 合入 `main` `70e28e2`。详见 [任务记录](tasks/image-output-preview-20261030.md)。

后续更新（2026-10-30，PDF）：私有成果精确命中 `application/pdf` 后经鉴权下载取 Blob，公开分享页移除旧对象 URL/iframe 分支，两处共用 `BlobPdf`；先判断 `navigator.pdfViewerEnabled === true`，只把前 5 字节为 `%PDF-` 的文件交给原生查看器（仅 header 门槛），以固定 `application/pdf` 建 Blob URL；不支持、header 不符、读取失败分别提示并保留下载，iframe 的 load/error 不作为解码成功判据，对象 URL 随换版与卸载释放；CSP 仅新增 `frame-src 'self' blob:`，`object-src 'none'` 与 `script-src 'self'` 保持，无新依赖/API/DB/模型费用。API 一审 26 用例、Web 一审补修 97 用例、二审无 mustfix、第三轮 `a18c436ffd11f7505` 无 mustfix（4 文件 110 用例）；生产隔离浏览器验收通过（Chromium 原生查看器，私有/公开旧新版、切版刷新、下载 sha、公开无管理 cookie、伪 PDF 无 iframe、引用不发模型、临时资源清理 0）。该更新覆盖上一条 2026-10-28 的「Office/PDF 不预览」：PDF 已可原生预览，Office 仍只下载。限制：加密/坏结构 PDF 由原生 viewer 兜底未逐一实测，大 PDF 未压测，非 Chromium 未测；实现 `ca5cb28` 与文档 `9caf2fa` 已由 PR #123 合入 `main` `b683903`。详见 [任务记录](tasks/pdf-output-preview-20261030.md)。

### 3.3 原生澄清提问（已接通）

US-6.2以官方 `AskUserQuestion → canUseTool → updatedInput` 接回用户答案，继续同一次工具调用。问题与答案属于运行数据，智能体定义仍由官方文件表达；不新增自定义提问工具或第二执行循环。

当前固定方案：supervisor 保留常驻 stdin 通道；本轮 runner 经 supervisor 发问题请求，worker 先持久化运行问题再发布 SSE 快照；用户经鉴权 API 回答，worker 沿现有 PG 轮询模式把答案回传给本轮 runner。消息内容保留问题最终快照，使历史与分支只读展示不依赖 run 保留期。等待计入原整体运行 timeout，停止/超时使待答问题关闭。

权限边界：官方 `dontAsk` 直接拒绝需要交互的工具、不会进入回调；新建默认采用 `default`，显式模式不重写。回调只处理主会话原生提问，其余未预批准工具拒绝；文件访问hook、禁用工具、子级边界与MCP服务端审批保留。回答问题不表示批准副作用。子智能体官方暂不支持原生提问。

本地SDK0.3.311探针已验证default回答后继续、dontAsk拒绝；隔离Linux沙盒与桌面浏览器已完成提问→刷新→回答→同run成果交付，并在最终源码上复测4条真实run（主场景、拒答、停止、超时）通过。回答后MCP副作用仍等待独立批准。公开问题以题序号与选项序号提交，API映射回原SDK键值；DB/SDK保留原文，GET/POST/SSE/历史统一脱敏投影。已知限制：流式增量按单帧脱敏；等待占用整体run超时。详见 [任务记录](tasks/agent-clarification.md)。

### 3.4 会话输入附件

用户在 Composer 选择文件后，随 `POST /api/chat` 以 base64 JSON 一次提交；服务端按扩展名映射规范 MIME，校验规范 base64、真实大小、文件签名与文本 UTF-8，再写入 `WORKSPACES_DIR/<slug>/conversation-inputs/<conversationId>/<attachmentId><ext>`。用户消息只保存 `{id, filename, mimeType, size, sha256}` 元数据，队列与 SSE 不携带文件字节。入口上限：每条消息 5 个、合计 10MiB，文本 1MiB、图片 5MiB、PDF 10MiB，JSON body 16MiB；Office/ODF、压缩包、音视频等明确拒绝并提示改用知识库或文本。

worker 预建该会话目录并只读挂到 `/mnt/inputs`（首轮无附件也预建并挂载），prompt 追加受控清单（显示名 JSON 转义、容器路径、类型、字节数），要求主智能体先 `Read` 再分析、读取失败必须说明。图片由官方 Read 返回视觉内容；PDF 短文件整份读取，长文件按 `pages` 分页，沙盒镜像安装 `poppler-utils`。输入目录的原生文件工具只允许主会话 `Read`，Write/Edit、子智能体的文件工具、未挂载路径、软链/硬链与越界继续拒绝；Bash 不在该 hook 内，但 `/mnt/inputs` 为只读挂载，shell 也只能读取。交付仍写 `/mnt/outputs`。

附件按会话保留：分支只复制被复制消息引用的文件（字节复制，删源后独立）；删除会话/专家回收目录；`pruneRuns` 保留带附件的用户消息并置空 `runId`，孤儿清理永不删除附件消息，保证历史与下载入口不随旧 run 消失。下载经鉴权且只接受该会话消息引用的附件。附件是运行数据，不进入智能体定义，也不替代知识库。

实现状态（2026-10-28）：隔离环境真实模型验证 CSV/PNG/14 页 PDF 的原生读取、报告内容与下载哈希一致、同会话第二轮读取历史附件、分支删源后继续读取；跨会话下载 404、伪类型/超限 400。Compose 为完整支持环境；宿主直跑需同一绝对 `WORKSPACES_DIR`，非 uid 1000 宿主与沙盒的 0700 目录限制见 `docs/OPERATIONS.md`。详见 [任务记录](tasks/agent-attachments.md)。

## 4. HTTP → MCP、平台 → MCP 与内置知识 MCP

前两个方向共用 MCP 协议与同一个 Node 适配器，但目的不同；`/mcp/:serverId` 还承载平台为知识库自动生成的内置连接（第三种用途）。

| 维度 | HTTP → MCP（`/mcp/:serverId`，generated） | 平台 → MCP（`/mcp`） | 内置知识 MCP（`/mcp/:serverId`，knowledge） |
|---|---|---|---|
| 解决什么 | 把已有 HTTP API 变成 MCP 工具 | 把平台内的智能体变成 MCP 工具 | 让绑定专家在 run 内只读检索一个知识库 |
| 工具来源 | `api_tools` 表，每个 generated server 一组 | 所有 `enabled = true` 的智能体，工具名 `run_<slug>` | 固定四个只读工具：`knowledge_search` / `knowledge_read` / `knowledge_list` / `knowledge_read_image` |
| 鉴权 | 沙盒内用按 run 签发的短期 token（DB 存 sha256，run 结束时尝试清空，DB 失败则保留至过期）；外部客户端用长期 `mcpToken` | 单个 `PLATFORM_MCP_TOKEN`；未设置则不注册该端点 | 只接受绑定该 server 的 run 短期 token；没有长期 token，无效一律 401 |
| 调用发生什么 | 按 method / path 模板 / `paramsIn` 转发上游 HTTP | 创建 conversation 与 run，入队，轮询 DB 直到终态，返回最终 assistant 文本 | 在 api 进程内查 pgvector/全文索引并读解析正文；工具不能跨库、不能写入 |
| 执行位置 | api 进程内 `fetch` | worker + 沙盒（与浏览器发起的对话同一条链路） | api 进程内 `retrieval.ts` + 文件读取 |
| 工具定义变更 | 下一次请求重建 handler，立即生效 | 下一次请求重建 handler，立即生效 | 由代码固定，不随用户配置变化 |
| 超时 | 上游 HTTP 超时由 fetch/运行环境决定 | 默认取 agent `timeoutMs`，上限 30 分钟 | 同一次 MCP 请求 |
| 主要代码 | `features/servers/mcp-endpoint.ts`、`generated.ts` | `features/servers/agent-tools-endpoint.ts`、`agent-tools.ts`、`agent-invoker.ts` | `features/servers/mcp-endpoint.ts`（kind 分支）、`features/knowledge/mcp.ts`、`retrieval.ts` |

共同点：

- 都使用 `createMcpHandler()` + `toNodeHandler()`，由适配器直接读写原始 req/res，Fastify 不再参与响应。
- 每个 HTTP 请求重建实例，避免跨调用复用。
- 都使用常量时间比较 Bearer token。
- `/mcp/:serverId` 先校验请求头 `x-agentport-run-id` 对应 run 的短期 token（且该智能体必须绑定此 server），失败再回退长期 `mcpToken`；`kind='knowledge'` 没有长期 token 回退。

`servers.kind` 因此有四种取值：`stdio`、`http`、`generated` 属于用户可创建/导入的连接；`knowledge` 是平台内部的第四种，只能由知识库生命周期写入（name `kb-<slug>`，config 只有 `{ knowledgeBaseId }`）。读写类型分离：`serverKindSchema` 与读联合包含 `knowledge`，`serverInputSchema` 只含前三种。它不出现在 `/api/servers` 列表，也不能经该接口 PATCH/DELETE；URL 永远由运行时拼 `/mcp/:serverId`。共享的 `knowledgeMcpEntry()` 是预览与运行时的唯一构造点，避免两处漂移。

内置知识连接的工具是只读的：`knowledge_search` 返回带 `chunkId`/标题/页码/score 的命中，`knowledge_read` 只读当前版本正文（超过 20,000 字符截断并标 `truncated`），`knowledge_list` 按游标列出文档，`knowledge_read_image` 读取版本图片（详见 §6.2.1）。参数里带别的 `baseId` 返回 `BASE_MISMATCH` 工具错误而不是静默换库；库被禁用时四个工具都返回 `BASE_DISABLED`。没有写入、上传、删除或重建工具。

## 5. 工作区文件模型

数据库是真相源；定义文件仍是每次运行前重新渲染的只读快照，会话级目录只提供稳定挂载根。

```
data/workspaces/<agent-slug>/
├─ session-sandboxes/<conversationId>/
│  ├─ workspace/                  每轮按 DB 刷新官方定义；只读挂 /workspace；根不按 run 改名或删除
│  └─ outputs/                    会话内唯一可写草稿，rw 挂 /mnt/outputs；根不发布、不删除
├─ agent-memory/                  跨 run 持久：原生 auto-memory
├─ sdk-sessions/<conversationId>/ 跨 run 持久：SDK transcript（按会话隔离）
└─ conversation-outputs/<conversationId>/
   ├─ drafts/<runId>/             停稳后由 captureOutputDraft 从 stable outputs 复制
   └─ runs/<runId>/
      ├─ manifest.json            平台索引（成员、hash、状态、消息边界）
      └─ files/**                 发布后不可变的完整文件快照
```

工作区按会话稳定复用，每轮只刷新定义内容；根目录不按 run 重命名或删除。目录 0700、文件 0600。持久数据只有 `agent-memory/`、`sdk-sessions/<conversationId>/`、`conversation-outputs/<conversationId>/` 与 `conversation-inputs/<conversationId>/`；`session-sandboxes/<conversationId>/{workspace,outputs}` 是可再生的派生缓存：`workspace` 每轮由数据库重渲染，`outputs` 在停稳后复制进 `conversation-outputs`，容器回收或关停不删除它，但它不是不可丢失的持久交付。run 保留期清理不删除会话成果；删除会话或专家时 API 都回收 `sdk-sessions/<conversationId>/`、`session-sandboxes/<conversationId>/`、`conversation-outputs/<conversationId>/` 与 `conversation-inputs/<conversationId>/` 四类目录，`agent-memory/`、子专家与个人记忆保留。删除编排固定为同一 checked-out 连接持 session advisory lock → 短 tx A 取快照 → 事务外等待沙盒关闭 ACK（连接保持 idle、无事务）→ 同连接短 tx B 精确重核并删除 → unlock 成功后按 A/B 核对过的快照 best-effort 回收目录。控制查询（读设置、取锁/解锁、写设置）有 5s 客户端截止；删除持锁总预算 40s 从确认拿到锁起覆盖设置恢复、tx A、ACK、tx B 与 unlock。B 提交前任何失败都保留实体行与全部目录；B 提交后 unlock/reset 失败不能伪装成回滚；rm 失败只记录并尽力收敛，可能残留目录。全局绑定锁使 ACK 等待窗口短时挡住其他专家的准入、绑定修改与经过绑定锁的记忆操作，这是已接受的代价；更细粒度需另改准入协议。上述编排已在 agent 与 conversation 两个删除入口落地。

子智能体各自的工作区同样包含 `agent-memory/`。运行时按 slug 把该目录 rw 挂到父会话 workspace 的 `/workspace/.claude/agent-memory/<slug>/`，不复制、不回写；会话刷新保留这棵挂载子树的 inode，挂载集合变化时重建容器。源码评审已通过（整体 `a9f539537d2542d89` PASS、`sessions` format `a8c52733b5e29b393` PASS）；SDK 最新接口 16/16 PASS（`/tmp/subagent-memory-sdk-final-interface-unique.json`，含跨 run、容器内自动 system 加载与显式 Read/Write/Edit deny）；浏览器全部 PASS、0 残留。运行整合 13 文件 195/195 PASS（`/tmp/subagent-memory-runtime-final-green.json`）；未提交、未合并，不能记为已交付或整体通过。

| 文件 | 内容来源 | 说明 |
|---|---|---|
| `.mcp.json` | `agent_servers` + `servers` | `mcpServers` 映射；stdio 写 command/args/env，http 写 url/headers（env/headers 含解密后的上游 secrets），generated 写 `${SANDBOX_API_URL}/mcp/<id>` + 按 run 的短期 Bearer token 与 `x-agentport-run-id` |
| `CLAUDE.md` | `agents.system_prompt_md` | 系统提示词 + 工具说明 + 技能 + 子智能体清单（含实际 `maxTurns` 与委派等待规则）+ 多步骤任务用原生 `TodoWrite` 维护清单的约束；前台执行与单层委派由运行时环境变量强制，不再逐次写在提示里 |
| `.claude/agents/<child-slug>.md` | 子智能体配置 | YAML frontmatter：`name`、`description`、`model`、`mcpServers`（按名引用根 `.mcp.json`）、`disallowedTools`、`maxTurns`、`memory` 及子级绑定的 `skills`；`memory` 仅接受官方 `project`，`user` / `local` 拒绝。**不写 `tools`**，否则 SDK 派生时按名字解析 MCP 工具会得到空集并拒绝启动。父级不写 server 级 `disallowedTools`：子级继承会话权限，server 级 deny 会把子级工具一起移除，父级越权改由 PreToolUse 边界 hook 拒绝。主智能体自己的 md 只用于预览（`GET /api/agents/:id/files`），不落盘，避免被当成可委派子智能体 |
| `.claude/skills/<slug>/SKILL.md` | `skills` 表 | frontmatter：`name`、`description`，正文为技能步骤 |

运行时约定：

- 每轮在会话 workspace 内先删除并重建 `.claude/agents/` 与 `.claude/skills/`，解绑后的旧文件不会残留。不要手工往这两个目录放东西。
- 用户正文之后是成对、末尾锚定的 `<!-- agentport:generated:start -->` / `<!-- agentport:generated:end -->` 生成后缀；导入取终端结束标记前最后一个独占开始行之前为用户正文，用户正文中的同名标题、单独或成对标记、完整示例与重复标题全部保留。最终生成后缀进入的 OpenUI 与服务/技能/子智能体派生文本会逐行转义独占保留标记行（`<` 前加反斜杠），根与子级共用同一解析规则；生成区只是编辑识别约定，不是权限边界。
- 根 `CLAUDE.md` 的工具枚举、无 MCP 分支与等待说明只依据根 `serverNames`；`.mcp.json` 仍是根与启用子级的并集，子级定义按自身 `mcpServers` 引用，运行时由 PreToolUse 边界 hook 保证父级不隐式获得子级工具。`serverNames` 缺省表示传入全集，显式 `[]` 表示根无绑定。
- `timeoutMs` 是专家独立运行超时；作为子智能体被委派时由主运行总超时约束，子级文件只声明官方 `maxTurns` 与委派等待规则，不写非官方 timeout frontmatter，也不在平台侧另造委派计时器。
- 会话 workspace 以只读方式挂载到容器 `/workspace`；agent 不能修改自己的定义。稳定的 `session-sandboxes/<conversationId>/outputs` 以 rw 挂到 `/mnt/outputs`，主会话用原生 Read/Write/Edit 交付文件；不使用 SDK `additionalDirectories`，避免可写目录被当作配置来源加载。原生 Read/Write/Edit/Glob/Grep/NotebookEdit 另有 PreToolUse 边界 hook 逐次校验路径；Bash 不在该 hook 内，文件边界由只读/可写挂载决定，无法写入只读挂载。容器另准确挂载 `sdk-sessions/<conversationId>`、`agent-memory` 与预建的 `conversation-inputs`，不挂整个 agent 目录。
- 每轮 `.mcp.json` 与 runner 进程环境携带本轮短期 MCP/模型凭证；stdio 的 `env` 与 http 的 `headers` 还会写入对应的上游解密 secrets，可能是长期凭证，generated 只给按 run 的短期 token。运行结束（不论容器是否停稳）都会尝试清空本轮 MCP/模型 token：模型 token 结束时从代理内存集合移除并尝试清空 DB hash；内存移除不保证独立于 DB 立即失效（集合里还有活跃 run 时，代理会拒绝不在集合中的 token），清 hash 成功或 run 状态成功落库为非 running 后 DB 不再匹配，两者都失败时 token 仍可能被接受。MCP token 的 DB 清空失败只记 warning，token 可能保留到过期时间（该 agent 超时 + 5 分钟）。终态停稳后从会话工作区移除 `.mcp.json`；移除失败时 worker 记录错误、禁止复用该会话容器，并在仍持有 lease 时销毁容器，但持久工作区里的文件可能留到下一轮刷新时被覆盖。本轮 token 撤销不影响上游 secrets，文件残留期间长期 secret 仍可能有效。目录 0700、文件 0600。空闲容器不保留上一轮身份，下一轮重新渲染。
- 运行结束后 worker 等本轮 runner 停稳（`settled`），由 core 的 `captureOutputDraft` 从 stable outputs 复制出本轮草稿，再以当前最新完整快照为基线发布不可变快照；stable outputs 根只读复制，不发布也不删除。用户选定旧版时只把所选文件覆盖到草稿，其他最新文件保持原样。正在重试、消息保存失败、容器未停稳或销毁失败时不发布并保留草稿；空基线清空后发布空快照。
- API 鉴权读取成果列表、按 `runId + path` 的 `{ file }` 元数据、完整 UTF-8 文本（≤1MiB）与原件下载；读取只接受 manifest 成员，HTML/SVG 仅按源码返回，不执行。二进制提供下载，不在服务端伪造文本预览；PNG/JPEG/GIF/WebP 图片由前端经鉴权下载取 Blob 并在解码成功后显示。
- 内置工具默认禁用；例外是 Bash（默认启用，用户可在 `disallowedTools` 中显式拒绝）、主会话受路径规则约束的原生 Read/Write/Edit、显式启用的 `TodoWrite`（§3.1，只用于展示进度），以及子智能体仅限自身记忆 Markdown 的原生 Read/Write/Edit（§5）。`allowedTools` 只负责自动批准。MCP 工具的允许规则按 server name 逐个生成 `mcp__<name>__*`，`mcp__*` 通配无效。
- 父级绑定技能slug从worker传给SDK的`skills`选项；无绑定明确传`[]`，仅控制自动批准的Skill(name)清单，不代表CLI发现清单隐藏其他技能。CLAUDE.md仅列父绑定技能。启用子智能体的绑定技能经批量查询合并到工作区文件，其子定义独立写`skills`预加载字段，不扩展父级SDK许可。真实CLI已发现子定义和技能文件；初始化接口不暴露预加载状态，子级正文加载及实际模型调用仍未验证，支持资源目录另行验收。
- 有子智能体时才放行 `Agent` / `TaskStop`；子智能体自身不再获得委派能力。
- 会话间消息工具（`ListAgents`、`SendMessage`、`SendUserMessage`、`EndConversation`、`Monitor`）默认禁用：
  平台只支持「同步等待返回」这一种智能体沟通模型，发送方不等对方返回就继续与平台约定相悖。
- 平台内的「文件预览」与运行时使用同一个 `renderWorkspace()`，但不落盘。每轮定义渲染、会话工作区落盘与沙盒执行只发生在 worker；API 不渲染每轮定义，只经既有入口读写个人记忆、专家记忆与会话附件，并读取成果文件。
- 知识库不是工作区文件能力：语料不写进 `.claude/`，也不挂载进沙盒。专家只在 `.mcp.json` 里得到一个知识库 MCP 条目（§4），知识正文由 api 在工具调用时读取。

### 官方文件能力与接入状态（2026-10-22核对）

目录与字段以已安装 Claude Agent SDK/Claude Code 版本及官方文档为准；下表为能力清单，不表示所有目录已经生成。项目目录是 `.claude/`，技能入口文件区分大小写为 `SKILL.md`。仅有文件存在不代表能力已加载，需验证加载来源、权限及实际调用。

专家包是官方 `.claude/` 目录的 ZIP：`CLAUDE.md`、`.mcp.json`、`.claude/settings.json`、`.claude/agents/*.md`、`.claude/skills/**`、`.claude/rules/*.md`、`.claude/output-styles/*.md` 保存全部定义正文；根 `agentport.json` 只保存平台元数据（显示名、slug、预算/超时、密钥键名、generated 连接器定义、子定义自有规则等），不复制正文。旧 `agent@1`/`agent@2` JSON 已删除。包内每个技能的资源路径按大小写不敏感比较，禁止占用 `SKILL.md` 及其后代、重复路径和文件/目录祖先冲突；仅目录大小写不同、文件不同的路径（如 `References/a.md` 与 `references/b.md`）允许共存。导入与导出只读校验路径，保留合法路径的原始拼写及 content，不通过改名或归一化修复冲突。

子智能体自有 rules / outputStyles 已支持保存、以自身为根的文件预览、clone 与目录包导入导出；父级委派时不会自动应用这些子级自有配置，父工作区只渲染根智能体的规则与输出风格。clone 复制源智能体自身配置与资源绑定，不复制其子智能体。

### 生成式 UI（OpenUI）接入

> 官方契约重调及独立评审已完成，验证见 `docs/tasks/openui-integration.md`。当前继续按官方 shadcn 示例调整 UI 呈现，范围和本轮验收见 `docs/tasks/openui-official-shadcn-ui.md`；适配来源见 `docs/OPENUI-UI-ADAPTATION.md`，升级见 `docs/OPENUI-UPGRADE.md`。

智能体的 `uiFormat` 决定助手回复的格式：`markdown`（默认）或 `openui`。选 `openui` 时，平台在 CLAUDE.md 的平台生成段末尾追加一段组件签名提示词，模型把 OpenUI Lang 程序放进 ```openui-lang 围栏；浏览器用同一个组件库解析并渲染围栏内容，围栏外的散文仍按 Markdown 显示。

| 位置 | 作用 |
|---|---|
| `packages/shared/src/openui/` | 唯一组件契约：纯 zod 定义 + 提示词规则 + 跨端协议（动作、状态信封、工具描述），不 import 任何 OpenUI 包 |
| `packages/core/src/openui-prompt.ts` | 从官方 CLI 生成的 `generated/openui.spec.json` 生成提示词，按工具目录缓存；不导入浏览器组件 |
| `packages/core/src/openui-response.ts` | 流结束后用官方解析器与 `mergeStatements` 合并对应段，保存完整混合响应；缺基线/非法程序保留原文并提供诊断 |
| `packages/db/src/repo/openui.ts` | OpenUI 工具目录（提示词与执行桥同源）、消息状态原子更新、会话级审批 |
| `packages/api/src/features/chat/openui-state.ts` | `PUT /api/conversations/:conversationId/messages/:messageId/openui-state`：按 blockKey 合并表单/绑定快照 |
| `packages/api/src/features/chat/openui-actions.ts` | 动作回传协议：`continue_conversation` 存成 `[{type:'text'},{type:'openui_action',…}]`，`open_url` 不入库 |
| `packages/api/src/features/chat/openui-tools.ts` | `POST /api/chat/:conversationId/openui/tools/:toolName`：Query/Mutation 执行桥；`POST /api/chat/:conversationId/openui/approvals/:approvalId/approve`：会话级批准 |
| `packages/worker/src/openui-action.ts` | 将已校验动作上下文/表单值完整追加给模型；大小应在 API 边界拒绝，不能在 worker 静默省略 |
| `packages/web/src/openui/library.tsx` | 真实 Zod/reactive 定义配上 shadcn 组件实现，官方 CLI 和浏览器共享同一个 library |
| `packages/web/src/openui/renderer.tsx`、`components/openui-message.tsx` | 按围栏分段、状态恢复、原生工具错误/重试及完整动作回传 |

要点：

- **运行底座保持 Claude Agent SDK**：OpenUI Lang 支持接入现有模型与智能体框架。Gateway 是官方推荐的托管推理/纠错路径，并不是使用 Renderer 的前提；当前 SDK 路径保留现有推理方式。Autofix 可在既有推理之后修复输出，属于可选外部服务，当前未接入。
- **业务运行时不引入 `@openuidev/react-ui` 的视觉层**：项目用真实 Zod/reactive 组件定义和 shadcn/Base UI 实现。该包仅作为开发期的官方契约对照，不能以其 JSON Schema 反编译出等价的 Zod（会丢绑定标记等语义）。
- **输出模式由宿主选择**：当前选择 `inlineMode:true` 支持 Markdown 与 UI 混合；这属于产品行为，不是所有 OpenUI 接入都必须使用的选项。`editMode` 必须与跨轮 previous/完成后合并的存储路径同时验收。
- **消息级格式快照**：`messages.ui_format` 固定消息生成时的渲染模式；`content` 保留原始模型输出与 SDK transcript 对应，`ui_program` 保存完成后按段合并的完整混合响应，`ui_state` 原样保存官方渲染器状态。历史优先读已存快照，不在浏览器二次合并。
- **段归属**：消息的每个UI围栏按`s0/s1…`编号，Markdown段不占编号；状态保存在`ui_state.blocks[sN]`。外部请求另带真实conversationId/messageId，不能把messageId编码到state键，也不能从全局store倒找最后一条消息。分支复制快照后不需重写段键。
- **工具目录单一来源**：`repo.openui.listOpenUiTools(agentId)` 同时喂提示词（worker 渲染 CLAUDE.md）和执行桥（API 校验）。只收已绑定且启用的 http / generated server 工具；stdio 由用户提供任意命令，仅沙盒内可见。http server 的目录来自最近一次「测试连接」写入 `servers.config.toolCatalog` 的快照——worker 没有 MCP client。
- **审批与会话绑定**：生成式UI的工具需要批准时返回202与approvalId，由当前UI段提供批准及重试；会话级批准8小时有效，重放不能续期，过期须重新请求并批准。Query可显式重试，Mutation不自动重放。它与run级审批分开：`approval_requests.run_id` 可空，UI来源使用 `conversation_id/message_id/source` 和会话工具部分唯一索引；run审批行为不变。
- 提示词进 CLAUDE.md 而不是 `.claude/rules/`：该段位于成对、末尾锚定的 `agentport:generated:start/end` 生成区内，不污染用户可编辑正文；导出→导入按生成区解析，用户同名标题与标记正文逐字保留。
- `pnpm-workspace.yaml` 的 `allowBuilds` 明确拒绝 `@openuidev/lang-core` 的构建脚本：否则每次 `pnpm install --frozen-lockfile` 因 `ERR_PNPM_IGNORED_BUILDS` 失败；该脚本只发匿名安装遥测。`.npmrc` 的变量**不会**作为进程环境传给 postinstall，因此不靠它关闭遥测。


| 官方文件/能力 | 加载方式 | 本项目当前状态 |
|---|---|---|
| `CLAUDE.md` 或 `.claude/CLAUDE.md` | project source 加载上下文，与是否使用 claude_code systemPrompt preset 无关 | 已生成根文件 |
| `.claude/rules/**/*.md` | project source；支持按路径组织规则，具体匹配按官方规则 | 已有规则管理、文件预览与根级运行落盘，含 globs 路径匹配配置 |
| `.claude/settings.json` | cwd 下 project settings；权限、环境、Hooks 等按该键允许的作用域生效 | 已生成选中输出风格的 outputStyle；其余主要通过 query options，尚未完整文件往返。**原生 auto-memory 已配置**：runner 通过 `settings.autoMemoryEnabled/autoMemoryDirectory` 指向挂载目录，文件工具权限及验收状态见下方记忆行 |
| `.claude/settings.local.json`、根 `CLAUDE.local.md` | local source；本地覆盖，不作为共享包默认内容 | 当前只启用 project，不默认加载 |
| `.mcp.json`（工作区根） | project source；连接与工具权限需实际验证 | 已生成运行时配置；受限HTTP/stdio文件可事务导入且凭证加密，不执行命令/测试连接；不支持字段与模板明确拒绝，导出不含密钥 |
| `.claude/skills/<name>/SKILL.md` 与其支持资源 | project source 发现；技能启用、可用工具由 SDK 配置控制 | 单文件生成、下载、受限导入及支持资源增删改查已实现；目录包携带父子绑定技能的支持资源。父子绑定技能均落盘，父会话可用 `Read` 只读打开 `.claude/skills/<slug>/references/**/*.md`（主会话原生文件工具写入仍仅限记忆与本轮产出目录）；真实CLI正负发现通过，绑定slug原生许可已接入；实际模型按需读取 references 仍未实测 |
| `.claude/agents/*.md` | 文件子智能体定义；程序式同名定义优先 | 已生成子定义与子级 skills 字段，父编辑器可下载已保存且启用定义，预览与运行共用渲染器。**子智能体 MCP 绑定已接通**：子定义写官方 `mcpServers` 名称引用根 `.mcp.json`，运行时用 PreToolUse 边界 hook 保证子级只用自己的 server/技能、父级不隐式获得子级工具；CLI 发现通过，子级实际加载仍以真实模型调试验收（单层约束由 `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` 强制）；主定义预览不下载为子文件。**子智能体自身记忆已接通（源码评审与最终夹具复验通过）**：子定义可写官方 `memory: project`（`user` / `local` 拒绝），运行时把其既有 `agent-memory/` 直接挂成 `/workspace/.claude/agent-memory/<slug>/`，由 SDK 原生按 project 自动加载，与主会话 auto-memory 相互独立；子智能体的原生 Read/Write/Edit 默认启用但仅限自身记忆 Markdown，兄弟、父级与未知子智能体拒绝，显式 deny 保留且可恢复。源码评审整体 `a9f539537d2542d89` PASS、`sessions` format `a8c52733b5e29b393` PASS；真实 SDK 最新接口 16/16 PASS（含跨 run、容器内自动 system 加载及边界与显式 Read/Write/Edit deny），浏览器全部 PASS、0 残留；运行整合 13 文件 195/195 PASS（`/tmp/subagent-memory-runtime-final-green.json`），未提交、未合并。 |
| `.claude/commands/*.md` | 官方保留的旧式命令文件；新能力优先 skills | 尚未接入，不另造命令引擎 |
| `.claude/output-styles/*.md` | project source，并按 settings 选择输出风格 | 已有输出风格管理、文件预览与根级运行落盘；选中者写入 settings.json 的 outputStyle，runner 通过 `settingSources: ['project']` 原生加载，不再手工解析后 inline 覆盖 |
| Hooks | 由 settings.json 的 hooks 配置或 SDK callbacks 注册；脚本目录本身不是自动发现入口 | 平台层回调与工作区文件Hooks需分别核对，不能仅创建hooks目录声称生效 |
| 插件根中的 `.claude-plugin/plugin.json`、skills/agents/hooks/.mcp.json | SDK `plugins: [{type:'local', path}]` 指定本地插件根；不是默认扫描项目 `.claude/plugins/` | 插件库文件在 DB 保存一次，多个专家引用，每次运行复制到独立 `.claude/plugins/<slug>/`。支持 ZIP 导入，以及 worker 独立安装沙盒调用 Claude Code CLI 从市场安装、读取平台已下载缓存后纳入插件库；来源记录 `name@marketplace` 去重，缓存不挂载给专家。hooks/MCP 默认关闭，仍按各专家绑定裁剪。平台子智能体不绑定插件；插件自带子智能体可原生委派。已有技能、references、子智能体及 hooks/MCP 开关真实沙盒证据。无升级/版本选择入口，专家 ZIP 不带插件并提示；不支持的组件、二进制和运行依赖明确拒绝，不静默漏文件 |
| `.claude/workflows/*.js`、`.claude/agent-memory/<name>/` | Claude Code 官方目录能力，受版本、工具与会话权限约束 | 原生 auto-memory 使用 `WORKSPACES_DIR/<slug>/agent-memory/`（uid 1000、0700），API/worker 共卷，沙盒 rw 挂载到 `/mnt/agent-memory` 并设置 `autoMemoryEnabled=true`、`autoMemoryDirectory`。主会话仅预批准该目录的 Read/Edit 路径规则（Edit 含 Write），SDK PreToolUse 每次拒绝越界、链接和非普通 Markdown 文件；该 hook 只覆盖原生文件工具，子智能体只放行自身记忆 Markdown（默认启用、可显式关闭），Bash 可写同一可写挂载。**主会话与子智能体分开**：主会话继续使用上述 `agent-memory/` 与 `/mnt/agent-memory`；子智能体源码评审与最终夹具复验均已通过：子定义写官方 `memory: project`，运行时把该子智能体既有的 `WORKSPACES_DIR/<slug>/agent-memory` 直接 rw 挂到 `/workspace/.claude/agent-memory/<slug>/`，由 SDK 原生按 project 自动加载，与主会话 auto-memory 相互独立，不新增记忆表、run 快照或第二套记忆。保留官方 `MEMORY.md` 与主题文件；SDK 最新接口 16/16 PASS（含跨 run、容器内自动 system 加载及边界与显式 Read/Write/Edit deny），浏览器全部 PASS、0 残留；运行整合 13 文件 195/195 PASS，未提交、未合并。Workflows 仍不接入 |

详情接口返回插件库实际保存的完整文件。前端 `/plugins/$pluginId` 是只读详情页：紧凑身份头（名称、版本、简介、导出）下用页内「简介 / 内容」两个 Tabs 切换，不使用抽屉、Sheet 或弹层，页面恰好一个 `h1`。简介页签只展示根 README；无 README 时给简洁空态并指向内容页签，不编写介绍、不拿首个技能冒充说明。内容页签在页内展示真实完整目录树与当前正文：桌面左右可拖动分栏，窄屏目录在同一页内折叠；默认文件为 README → 技能 `SKILL.md` → 首个真实文件。目录树用真实文件/目录名，目录优先、可折叠，只有当前文件铺选中底色，技能目录内 `SKILL.md` 优先，manifest、hooks、MCP、支持文件、空文件全部可达。URL 用 `tab=intro|content`、`file`、`mode=read|source`，默认 `intro` 且无 `file`；切换页签、选择文件与模式进入历史，刷新和前后退可恢复，切到简介保留 `file`/`mode`，切回内容恢复上次选择与滚动位置，失效文件给说明并回退。点击 README 或正文内真实文件链接切到内容页签并定位对应文件。正文显示实际路径 breadcrumb 与 frontmatter 语义名称，Markdown 默认阅读并可切源码，其余文件直接源码并可复制。展示解析只读取 frontmatter 的名称、描述和正文，不改变保存内容或运行定义；Markdown 静态渲染，HTML 作为文本，只有插件内真实存在的相对文件链接可点击。内容区按真实文件路径展示，不另建能力索引；多来源文件在目录树中各自可达。详情是插件库快照，专家运行时仍独立复制并按授权裁剪。

会话恢复、预算、取消信号、消息流、宿主 callbacks 等还有 SDK 运行时参数，不能声称全部都可写入 settings.json。模型推理深度只保留官方 `effort`；`maxThinkingTokens` 已从定义、API、专家包与沙箱任务移除，旧字段明确拒绝，因为当前模型自适应思考、CLI 不执行数值上限。删列迁移 0042 尚未应用到共享数据库，部署需正常执行 `pnpm db:migrate`。`~/.claude/` 的认证、缓存、会话记录等宿主状态不属于可分享项目定义，不复制进用户工作区包。

会话上下文不再拼接历史文本：每个 conversation 的 SDK transcript 持久化在 `WORKSPACES_DIR/<slug>/sdk-sessions/<conversationId>/`，容器只挂这一个目录到 `/home/node/.claude`；续聊传 `resume`，从某条用户消息分支时先复制来源 transcript 再用官方 `forkSession` 截断，成功后写回新 session id。fork 会给消息换新 uuid，映射由 **worker 从宿主 transcript 的 `forkedFrom` 字段计算**（不按位置对齐，压缩过的会话顺序会变），并与消息同事务写库；resume 事件只携带新 session id。transcript 缺失时该轮以 infra 失败，不回退成文本上下文。该目录属于运行时持久数据，随备份保存，但不是可分享定义包的一部分。从历史点复制会话时，来源读取、分支会话行与复制消息在同一个 `db.transaction` 内提交；后续批次失败不会留下半成品分支。

当前 sandbox 明确使用 `cwd:'/workspace'`、`settingSources:['project']`；不加载宿主 user/local 偏好。个人记忆（原个人偏好）不是 SDK 自动发现的用户级 `CLAUDE.md`：它是宿主只读挂载的 `/mnt/user/CLAUDE.md`，由平台 `UserPromptSubmit` hook 每轮注入。outputStyle 因此由项目 `settings.json` 原生加载，inline settings 只覆盖同名 key。官方加载默认值可能随版本变化，继续显式配置。文件导入必须经过类型、路径与大小校验，不能直接解压到执行目录或自动运行导入的脚本。

官方来源：
- https://code.claude.com/docs/en/agent-sdk/claude-code-features
- https://code.claude.com/docs/en/claude-directory
- https://code.claude.com/docs/en/agent-sdk/skills
- https://code.claude.com/docs/en/agent-sdk/subagents
- https://code.claude.com/docs/en/agent-sdk/plugins
- https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts

### 5.1 记忆、记忆提案与固定版本分享（2026-10-31）

记忆按对象分类，权威、加载方式与版本能力各不相同；现有个人记忆（原个人偏好）与子智能体记忆链路已核实：

| 对象 | 权威 | 沙盒加载 | 版本与回滚 |
|---|---|---|---|
| 个人记忆（原个人偏好；底层表 `user_preferences`） | `user_preferences` 单行（按 `businessId`，`revision` 乐观锁） | DB 投影到 `WORKSPACES_DIR/_users/<sha256(businessId)>/CLAUDE.md`（0700/0600，temp + rename），只读挂到 `/mnt/user`；runner 的 `UserPromptSubmit` hook 每轮按主体读取并以 `additionalContext` 注入，上限 9000 字符 / 36 KiB，超限拒绝本轮 | `memory_changes` 账本；按 `businessId` 隔离 |
| 专家记忆 | `agent-memory/` 官方文件（`MEMORY.md` 索引 + 平铺主题 `.md`） | runner 开启原生 auto-memory（`autoMemoryEnabled` + `autoMemoryDirectory`），模型按官方机制自动写，不逐条确认；主会话文件工具受 PreToolUse 路径 hook 限制；子智能体的原生 Read/Write/Edit 默认启用但仅可读写自身记忆 Markdown，兄弟、父级与未知子智能体拒绝 | 平台写入（记忆提案采纳、主题/索引手工 PUT/DELETE、回滚）按目标文件进 `memory_changes`，主题变更同时记录伴随索引；SDK 原生自动写入直接改 Markdown，不进账本 |
| 子智能体记忆 | 各子智能体自身 `agent-memory/` 官方文件 | 子定义写官方 `memory: project`；worker 把该子智能体既有的 `WORKSPACES_DIR/<slug>/agent-memory` 直接 rw 挂到 `/workspace/.claude/agent-memory/<slug>/`，由 SDK 原生按 project 自动加载，与主会话 auto-memory 相互独立，主记忆与兄弟记忆不合并 | 与专家记忆一致：平台写入口进账本，SDK 自动写入不记账；验收证据见[子记忆任务记录](tasks/subagent-memory-20261030.md) |
| 专家规则 | `agent_rules`（DB） | 渲染为 `.claude/rules/<slug>.md`，每次运行自动生效 | `memory_changes` 完整快照 |

- **个人记忆（原个人偏好）不是官方用户级配置**：`settingSources` 仍为 `['project']`，不读取宿主 `~/.claude`；`_users/<sha256(businessId)>/CLAUDE.md` 只是平台维护的只读文件投影，DB 才是成功依据。API 保存以 DB 事务提交为准，投影失败只记日志；worker 在每轮用户运行、挂载工作区前按 DB 重建该用户的投影，崩溃遗留的旧投影不会带入下一轮。服务主体不重建也不挂个人记忆；重建失败则中止该轮运行。
- **个人记忆按 `businessId` 隔离**：投影目录与锁都以 `businessId` 为键；worker 从 DB 读取运行主体，服务主体没有个人记忆，也不回退到管理员。既有专家共享 auto-memory 的读写语义保持不变。
- **记忆提案是用户触发的运行**：`agent_runs.trigger='review'`，目标为个人记忆、指定专家的某个记忆文件或规则；`agent_memory` 目标必须带 `name`，不设 `MEMORY.md` 隐式默认。一次记忆提案只处理一个文件，读已落库的会话快照（最多 10 段，可选用首尾消息固定窗口），`tools: []`、`settingSources: []`、`persistSession: false`、关闭 auto-memory，`outputFormat: json_schema` 返回提案；沿用专家 `timeoutMs`、`maxBudgetUsd`、`maxTurns`，支持取消与 worker 关停，不建沙盒、不追加消息、不写成果。快照在创建时固定：来源正文 + 目标正文 + 伴随索引合计不超过 256 KiB，超限入队前拒绝。证据必须是快照消息原文的连续子串，并带 `user_fact | confirmed_decision | assistant_suggestion` 归因：用户事实与已确认决定只能引用 user，助手建议只能引用 assistant 且仅作背景；非 null 正文至少有一条用户依据，纯助手建议不能变成可采纳记忆。
- **确认制，不是自动进化**：提案写入个人记忆、专家记忆文件或专家规则；采用、拒绝、回滚与手工编辑共用目标级 advisory lock，采用才写目标并落账。没有无人值守的自动提取与发布。
- **`MEMORY.md` 是索引**：官方启动只加载前 200 行或 25KB；记忆提案采纳与手工 PUT 都按 200 行 / 25KB 拒绝超限，不截断。主题文件正文上限 200000 UTF-8 字节。
- **主题 + 索引是固定两文件**：主题目标的快照为 `{ content, globs, index: { content } | null }`，`index` 是同专家 `MEMORY.md` 原文；personal、规则与 `MEMORY.md` 自身为 null。主题正文非 null 且索引缺少指向它的行内链接时，平台按确定规则在索引末尾补一行 `- [name](name)`，原索引其余字节、链接与结构逐字保留；已有普通相对链接或 `./name` 链接不重复补。模型不输出索引，也不得顺手整理其它主题。补链后的索引仍须满足 200 行 / 25KB，超限整次写入拒绝，不只写主题。
- **一次采纳/回滚是一个逻辑变更**：持锁后先要求目标与伴随索引的当前快照都等于 before（任一变化返回 409 并保留完整提案），校验全部候选文件限额，再按“目标文件 → 需要变化的 `MEMORY.md`”顺序原子 rename；一个 `memory_changes` 行同时保存主题与索引前后快照，审核的 `appliedChangeId` 只指向它，重复 apply 返回同一变更。主题手工 PUT 使用同一补链规则；DELETE 保持索引原样，账本中 index before/after 相同。回滚只检查并恢复该次变更实际改过的文件，因此后续无关索引变动不阻断单主题回滚；新主题回滚会移除主题并恢复本次修改前的索引（原来不存在则恢复不存在），但若这些文件之后又被修改则冲突，不覆盖后来内容。删除主题不扫描或重写用户自定义索引链接。
- **双文件写入可恢复**：`.memory-journal/` 是平台控制目录，不导出、不供 SDK 读取、不是记忆权威。review、rollback、manual 三种写入都先写日志，记录本次涉及的固定文件集合（最多两个）、每个文件的 name、before/after hash（null 区分不存在）和恢复所需原始字节，再原子写文件、提交账本；任一文件写入或 DB 提交失败时恢复全部原始字节，恢复失败保留日志并报告失败，不补记假成功。锁内恢复只认日志证据：全部等于 before 则丢弃，全部等于 after 则补完账本，before/after 混合先恢复原字节，出现第三方内容返回冲突；同专家有未完成两文件变更时，其共享索引占用会阻止其它手工编辑、拒绝与回滚绕过。
- **无变化**：`proposedContent` 为 null，或按同一确定性函数算出的完整 after 与 before 一致，都表示没有文件要改；内容相同但仍需补主题链接属于有变化。无变化时 run 仍为 `succeeded`、DB decision 保持 `pending`（表示用户尚未决定），UI 显示“无需变更”，不显示待采用/采用/拒绝/回滚；apply 返回 409，零文件、零账本变更，不新增 decision 枚举或伪造 applied 记录。
- **版本与回滚**：`GET /api/agents/:id/memory/:name/versions` 对所有合法记忆文件返回实际历史；DB 在 LIMIT 前按目标 `kind + agentId + name` 收窄。`MEMORY.md` 的列表还包含“以主题为目标、实际改动了伴随索引”的变更，让索引版本可解释；主题列表按 name 精确命中。回滚沿用 `POST /api/memory/changes/:id/rollback`，返回一个 `MemoryChange`。个人版本按 `businessId` 且 `kind='personal'` 过滤，专家账本不混入个人范围。
- **原生记忆目录独立下载与回导**：`GET /api/agents/:id/memory/download` 复用 `agents.memory.read` 对象权限，持同专家锁打包。ZIP 根只含实际存在的 `MEMORY.md` 与平铺主题 `.md`，不含 agent ID JSON、版本账本、记忆提案原文、journal、个人记忆、其它专家或子级目录；无内容返回 404，不用伪 `MEMORY.md` 占位，沿用既有条目数、解压大小、压缩大小与符号链接边界。解压后可直接作为官方 auto-memory 目录使用；回导复用现有 `PUT /api/agents/:id/memory/:name` 写入新专家，不新增 ZIP 上传或整目录覆盖 API。相对链接不依赖原 agentId/slug。专家定义包仍只携带定义，不携带学习到的记忆正文；定义包与这份原生记忆目录是两个交付物。
- **当前范围与未覆盖**：API 列表/CRUD 只管理 `agent-memory/` 顶层的合法 `.md` 文件；原生文件工具允许的嵌套主题目录尚未进入列表、编辑器、版本与下载管理，属于待办边界。SDK 原生 auto-memory 直接写入的文件不进入 `memory_changes`，因此版本与回滚只覆盖平台写入口（记忆提案采纳、手工 PUT/DELETE、回滚），不能宣称全部记忆历史可追。
- **子智能体记忆的准入与并发**：chat / schedule / eval 只使用稳定启用的直接子智能体集合；执行活动期间资源变化返回 409，普通字段与无关专家仍可编辑。锁顺序固定为绑定锁 → 排序后的 agent 记忆锁 → 行锁；目标自身有执行型活动 run，或目标是启用子专家且其直接父专家有执行型活动 run，就拒绝记忆写入并返回 409；审核 run 与其他无合法归属关系的 run 不占用。会话工作区刷新保留官方记忆子树 inode，挂载集合变化时重建容器。子智能体的原生 Read/Write/Edit 默认启用但只允许自己的 Markdown，兄弟、父级与未知子智能体拒绝，既有显式 deny 保留且恢复只移除裸 deny/allow、不清除路径规则；Bash 共享可见，不声称 OS 级隔离。平台写入口进账本，SDK 自动写入不记账。验收证据见[子记忆任务记录](tasks/subagent-memory-20261030.md)；其中真实 SDK 16/16 使用本地假模型，只证明加载与文件边界，不代表真实模型记忆质量。
- **定义包边界**：子定义 `memory: project` 可导入导出；`user` / `local` 明确拒绝；专家包只携带定义，不携带学习到的记忆正文。
- **完整快照比较**：`memory_changes` 保存 before/after 完整内容（规则含 `globs`，主题含伴随 `index`）；个人记忆、规则与专家记忆的冲突判断按完整快照，不用局部 diff。
- **验收状态（2026-10-31）**：主题 `name/index/kind` 共享契约、worker 主题记忆提案、API 双文件账本/版本/下载与 web 面板均已落地；shared、worker、web 独立 review 已 PASS，完整浏览器主路径（受控提案的来源归因、主题/索引双对比、采用、索引版本、ZIP 下载与公开 PUT 回导、整次回滚、无需变更）已实测通过；API 与跨端最终独立评审均 PASS。验证及独立评审通过；本任务 PR 交付，合并状态以 GitHub 为准，不能据此宣称已上线；最终回归数字与证据以[任务记录](tasks/memory-upgrade.md)为准。真实容器 + 官方 SDK + 本地假模型只证明加载与文件边界，付费真实模型的归纳质量与跨 run 召回未审计。沿用既有 `memory_reviews` / `memory_changes` jsonb，不新增表、列或迁移，不兼容旧 JSON 记录、不自动清库。详见[执行契约](tasks/memory-upgrade-contract.md)。
- **固定版本公开分享**：`output_shares` 锚定 `conversationId + runId + path` 与真实字节 sha256；token 只存哈希与密文，链接为 `/s/<shareId>#<token>`。公开接口校验 token、未撤销、实际字节哈希三重条件，无效统一 404；撤销幂等，已发出的链接不随同一路径的新版本变化。

### 5.2 调研结论：不引入外部记忆服务（2026-10-31）

不引入 Mem0、Zep、Letta、LangMem 等外部记忆服务，也不新增第二套执行底座。借鉴的是产品做法而非依赖：Manus / Fleet 的候选确认、Devin 的来源与索引分离、Letta 的 Git 式版本思想、claude-mem 的索引优先。当前以官方文件和 PostgreSQL 账本实现；只有实测文件检索不足时，才做可重建的检索索引（PostgreSQL 已具备），并需先给出基准证据。详见 D-73。本次主题经验升级遵守同一边界：不新增 L1/L2/L3 私有记忆库、后台提取管线、向量/检索索引、服务或依赖，只扩展记忆提案目标、固定两文件采纳与版本、原生目录下载。

### 5.3 个人模块接口（2026-10-31，本工作树）

个人模块把本人资料、记忆、记忆提案、账号安全、分享与使用记录集中到 `/personal/*`，复用既有权限叶与数据表，不新增执行底座。页面固定为 `/personal/profile`、`/personal/memory`、`/personal/reviews`、`/personal/security`、`/personal/shares`、`/personal/usage`；`/personal` 转个人资料，旧 `/memory` 页面已删除。侧栏展开与收起状态点击底部用户信息进入同一模块，登出是独立动作。

| 接口 | 权限与范围 | 作用 |
|---|---|---|
| `PATCH /api/me/profile` | authenticated + user principal + trusted Origin | 只改显示姓名；strict 拒绝其他身份字段；审计 `auth.profile.updated` |
| `GET /api/me/sessions` | authenticated + user principal | 仅本人未过期会话的展示投影，`no-store`；不返回 token/userId；受 Better Auth 默认鲜度限制 |
| `DELETE /api/me/sessions/:id` | 同上 + trusted Origin | 撤销本人其他会话；当前会话 409，他人/未知 404；审计 `auth.session.revoked` |
| `GET /api/me/output-shares`、`DELETE /api/me/output-shares/:id` | `conversations.share` + 本人来源会话 | 只列/撤销本人会话下未撤销的分享；撤销幂等 |
| `GET /api/me/usage` | `overview.read` + `initiatedBy` 本人 | UTC 创建时间窗口内的本人运行汇总与已记录成本 |
| `GET /api/me/runs` | `runs.read` + `initiatedBy` 本人 | 本人运行分页与来源跳转 |
| `GET /api/me/conversations` | `conversations.read` + `own_data` | 记忆提案来源选择只列本人会话 |
| `POST /api/memory-reviews?scope=own` | 其余记忆提案权限保持不变 | 个人页创建记忆提案时额外校验每个来源会话属于本人 |

- 共享契约集中在 `packages/shared/src/personal.ts`；本人列表查询在 SQL 层固定本人范围，管理员个人页也不返回全局数据。既有 `personal_memory.read/write`、`conversations.share`、`overview.read`、`runs.read` 等权限叶不新增、不扩权。
- 会话管理受 Better Auth 默认鲜度限制：登录态过旧返回 403 并提示重新登录，不自动登出。分享列表只表示链接未撤销，不保证文件字节仍存在；公开访问仍按既有文件存在与哈希校验。
- 无 DB schema/迁移、无新依赖；沿用 `user_preferences`、`memory_changes`、`output_shares`、`agent_runs` 等现有结构。
- 实现与验证：定向测试、web 全量、typecheck/build 与真实页面检查记录见 [任务记录](tasks/personal-module.md)；真实页面使用隔离库构造样本，未调用模型或 worker，最终终审状态以该记录为准。

## 6. 知识库运行时

知识库是平台的独立内容资源，不是智能体定义的一部分：语料、版本、chunk、Wiki 与同步游标都存在平台自己的表和持久卷里，**不写进任何专家工作区**。智能体访问知识的唯一入口是平台自动生成的内置 MCP 连接（§4）。这让 `.claude/` 目录始终保持官方语义：知识连接只是一个标准 MCP server 条目，知识正文也不会被误当成可分享的智能体定义。

这条路由也是对旧决定的替代：此前「不做内置 RAG、文档检索交给外部服务或技能」的结论已被 D-9 当前决定取代。知识能力用项目既有栈自己实现，不引入第二套向量数据库或编排引擎。

### 6.1 存储与数据模型

| 位置 | 内容 | 说明 |
|---|---|---|
| PostgreSQL 18 + pgvector | 知识库/文件夹/标签/文档/版本/chunk/任务/来源/同步运行/Wiki/模型 profile | 迁移 `0036_demonic_dust.sql`；`CREATE EXTENSION vector` 与 HNSW 索引是手工补的 SQL |
| `$KNOWLEDGE_DIR/blobs/<前2位>/<sha256>` | 原件，按内容寻址、只读 | 上传/抓取先写临时文件再原子 rename；同内容复用 |
| `$KNOWLEDGE_DIR/docs/<documentId>/<versionId>/` | `markdown.md` 与 `images/` | 解析产物；版本删除后目录不会立即消失，等 cleanup 任务回收 |
| `$KNOWLEDGE_DIR/wiki-sdk/<jobId>/` | Wiki 生成时的平台私有临时 cwd（同时作 HOME / `CLAUDE_CONFIG_DIR`） | 不是 Claude 官方目录约定，也不进入专家工作区或导出包；任务结束即删除 |
| `knowledgedata:/knowledge` | 上述目录的 compose 命名卷 | api 与 worker 必须同卷；随 `pnpm backup` 归档为 `knowledge/` |

关键 schema 事实：`knowledge_chunks.search_vector` 是 `to_tsvector('simple', search_text)` 的生成列（应用不写），`embedding vector(1024)` 由 `customType` 映射；GIN 全文索引与 HNSW 向量部分索引（`WHERE enabled AND embedding IS NOT NULL`）在迁移里手写。embedding profile 的 `dimensions` 由 schema 的 check 约束固定为 1024。chunk、版本、Wiki、任务等业务实体都用 `newId()` 生成 TypeID（`kb_`、`kdoc_`、`kchk_`、`kjob_`…，见 `packages/db/src/id.ts`）。`insertChunks` 按 500 行分批执行 `INSERT`，避免单条语句超过 PostgreSQL 绑定参数上限；返回顺序与输入一致。

删除文档/知识库删除行与引用，blob与解析目录由`cleanup`按“无版本引用且超过24小时”回收。知识对账器启动时及每5分钟检查当天UTC清理任务，复用同一队列每日创建一条；入队失败保留queued供后续补投。`POST /bases/:id/rebuild`与知识库“设置”中的整库重建入口贯通，重建前提示人工分块更改会被覆盖。

### 6.2 摄取与检索

摄取链路是「API 落原件 + 建行 + 入队」→「worker 解析、分块、embedding、原子切版本」：

1. 上传走 base64 JSON（路由级 `bodyLimit` 48 MiB，解码后上限 32 MiB），手写正文与 URL 导入走独立入口；三者都先写 blob，再建 `knowledge_documents` 行，最后投 `ingest` 任务并返回 202。
2. worker 取当前知识库的 embedding profile，解析（Markdown/文本/CSV/JSON/HTML 本地处理；PDF/Office/OCR 走 `DOCLING_URL`）、结构感知分块、批量 embedding，最后在事务里把 `current_version_id` 切到新版本。失败或取消时旧版本继续可查。
3. 内容读取只走带鉴权的 REST：`versions/:versionId/content` 回原件（`Content-Disposition` 用清洗后的文件名）、`.../markdown` 回解析正文（用 `X-Knowledge-Document-Status` 带文档状态）、`.../images/:name` 回图片。图片名必须匹配白名单文件名且在该版本的 `images` 清单里，磁盘路径只由库内记录拼出，不按 URL 原文读取；对外不暴露静态目录。
4. 检索固定为两路：关键词（应用侧 `Intl.Segmenter('zh')` 分词 + `plainto_tsquery('simple')`）与向量（pgvector `<=>`），各取 top 50 后用 RRF（k=60）融合取前 30，再按知识库配置的 rerank profile 重排。召回条件同时要求 `chunks.enabled`、文档 `ready` 且 `current_version_id = chunks.version_id`，旧版本与停用内容不会命中。
5. embedding 不可用时只返回关键词结果并在响应标 `degraded: true`；rerank 失败则保留 RRF 顺序。两种降级都不把整次检索变成错误。模型端点失败被归类为 `auth / rate_limit / timeout / bad_response / unavailable`；只有 `rate_limit`、`timeout`、`unavailable` 会重试，`auth` 与 `bad_response` 重试也不会变好。

本地解析：CSV 用 `csv-parse`（保留 BOM、引号内换行、不等宽列，CR-only 换行可解析，非法引号以 `invalid_input` 失败），表格列宽线性聚合，大行数不展开参数；Markdown 是线性轻量分块，只支持最小围栏、单行 Setext 与 GFM 表格（含无外管道），**不是完整 CommonMark**，未覆盖的语法按普通段落处理。

### 6.2.1 图片多模态（参考 WeKnora）

独立 PNG/JPEG/GIF/WebP 与 Docling 文档插图进入同一摄取链。库设置 `imageProcessing` 指定现有模型网关接受的视觉模型及 OCR/caption 动作；worker 用官方 Agent SDK 的原生图像输入和结构化输出，复用既有模型凭据。临时会话关闭内置工具、外部设置与 auto-memory，取消后等待 SDK 退出再清理，不创建专家聊天 run。

OCR 与 caption 分别形成 `kind:image` 的文字块，`metadata.imageRole` 标记来源动作，`metadata.image` 保存当前版本图片名/MIME/页码；图片字节留在已有版本图片目录。至少一个动作成功可使用，失败动作记录 `versions.images[].warnings`，两者均无有效输出则不发布新版本。默认经现有文字 embedding/关键词检索；启用图片处理不等于默认启用图片向量。

可选原生图片向量使用同一 embedding profile 的 Cohere v2 `embed-v4.0` 文本与图像编码，固定1024维；profile 新字段 `embeddingProtocol`/`imageInputEnabled` 由迁移 `0036_demonic_dust.sql` 声明。只有显式支持图片输入的 profile 才允许库开启图片向量；关键词排除 vector 子块，图像向量召回独立应用最低相似度。同维不同模型不混用：向量分支限定版本 profile ID，profile 被引用后不允许原地替换模型/协议。

专家仍通过官方 `.mcp.json` 加载知识连接。`knowledge_read_image` 默认返回可读描述；`format:image` 校验绑定库、当前版本、文档/chunk状态和版本图片清单后返回 JSON 文本加 MCP 原生 image content。原图传给 SDK，不在聊天执行层重新拼消息；Web 引用经已有鉴权图片端点显示同一原图。真实 SDK→受控 MCP→图像到达本地模型协议夹具已实测，真实视觉模型质量与 Cohere 服务未验收。详见 [多模态实施](tasks/knowledge-multimodal-implementation.md)。

### 6.3 外部来源

首批只做 RSS/Atom/JSON Feed、飞书 Wiki/Drive、GitLab 仓库文件（项目/ref/path）与 GitHub 仓库文本文件。范围（`knowledge_source_ranges`）必须非空，空数组在入口就 400，**不解释成「全企业」**。一个来源可以保存多条范围，每条范围有独立游标：飞书按空间/节点/云盘目录，Feed 按订阅地址，GitLab/GitHub 按项目或仓库 + 可选 ref + paths；GitLab 读取时优先使用范围的 `externalId`/`ref`，缺失时回落到 `config` 的 `projectId`/`ref`，GitHub 则每条范围必须是 `owner/repo`，读取时使用范围的 `ref`，为空时使用该仓库的 `default_branch`，不回退 `config.ref`。来源创建与 PATCH（包括仅修改 ranges）统一调用 `configIssues` 校验，GitHub 的范围 `kind` 必须为 `github_repo`、`externalId` 必须为合法 `owner/repo`，在入口就拒绝；`paths` 是否为仓库相对路径仍由 worker 校验。`listRanges` 只用于展示与连接检查，同步只读已保存的范围。API 支持整体替换范围；前端创建与编辑共用同一套分区表单，支持多条范围的增删与启停，创建时即可配置 cron 与 `syncDeletions`。飞书的 `appId` 存在 `config`，`appSecret` 只存加密列；GitLab/GitHub 的 token 与模型 apiKey 同理。来源级 `appId`/`baseUrl`/`config` 可编辑，凭证只写不读，响应只返回 `hasSecret`。

文档身份只按 `(base_id, source_type, source_id)` 匹配外部条目，绝不用标题；`upload`/`manual` 的 `source_id` 为空。外部 `source_id` 形如 `<来源连接 ID>:<源端条目 ID>`（源端 ID 是飞书 token / GitLab `project:ref:path` / `feedURL:itemId`），加上连接前缀后，同一条目出现在两个来源里也不会互相覆盖。来源归属另记在 `metadata.knowledgeSourceId`，因为文档表没有指向来源的外键。

- Feed 是滚动窗口：条目自然滚出窗口不删除，连接器永远返回「不完整枚举」。
- 飞书只同步 `docx` 类型的 Wiki 节点与云盘的 docx/文本文件；其他类型或不支持的内容明确报错，不静默跳过。
- GitLab 只读取文本类扩展名（md/txt/html/csv/json/xml/yaml/rst/adoc 等）的 blob；PDF/Office 等二进制文件不在当前同步范围内。先完整遍历仓库树，任何分页失败都抛出，不推导删除。
- GitHub 使用 PAT（`secrets.token`），`config.baseUrl` 可选，缺省 `https://api.github.com`；GitHub Enterprise 填 API 根（如 `https://ghe.example.com/api/v3`）。范围是 `owner/repo` + 可选 `ref`（缺省回落到仓库默认分支）+ `paths`，同样只同步文本扩展名文件；空文件写入占位正文以覆盖旧内容。外部条目 ID 为 `github:<apiBase>:<repoId>:<ref>:<path>`；`sourceUrl` 的 ref 与 path 按路径分段编码（保留 `/` 层级，编码 `#`、`?`、空格等段内字符）。递归树读取失败或 `truncated` 直接失败，不把部分枚举当成完整枚举，因此只有完整枚举且本轮无失败时才允许按 `syncDeletions` 推导远端删除。
- GitHub 的 401 与明确无权限的 403 抛 `SourceAuthError`；限流可能是 403（带 `x-ratelimit-remaining: 0` 或 `retry-after`）或 429，这类限流不标记 `auth_error`，来源保持 active、可继续重试。
- 飞书 Wiki/Drive、GitLab 与 GitHub 只有在连接器明确声明「枚举完整」且本轮无失败时，`syncDeletions: true` 才允许把未再出现的条目置为 `disabled`（不物理删除、不参与检索）。
- 上传入口不做格式预筛，PDF/Office/OCR 交给 `DOCLING_URL`；未配置时该格式以任务失败明确报出，不静默降级。来源同步走各自的读取路径，不经过 Docling。
- 来源的「测试」只校验本地配置与凭证是否齐全，不发外网请求；真实连通性以同步 run 的结果为准。
- 来源 UI 分「选择 provider → 配置」两步；手动同步要求来源为 `active`。手动、失败任务重试与定时触发统一通过 `repo.knowledge.createSyncJob` 创建：同一事务取来源级 `pg_advisory_xact_lock(hashtext(sourceId))`、重读来源与在途 queued/running，再插入 queued sync run 与 job，Redis add 只在事务提交后。同一来源已有在途同步时，手动/重试返回 409，定时触发跳过；缺失 404、非 active 409。
- 私网出站：`KNOWLEDGE_PRIVATE_HOST_ALLOWLIST` 只做精确 `host` / `host:port` / origin 匹配，默认空。它当前作用于两处：worker 的来源连接器抓取（飞书/GitLab/GitHub/Feed，逐跳校验，使用独立的 `validateSourceUrl`）与 API 侧模型 profile 的创建/修改/测试。名单外的地址分别走各自的私网校验；名单只对知识出站生效，不会让普通 MCP server 把任意 URL 变成可信。
- 目前**没有**接入该名单的知识出站还有三处，部署时应知悉：URL 导入只经 `assertSafeUrl`；worker 调 Docling 与 embedding/rerank 直接用已保存端点，不再逐次复核；这些端点的可信性依赖部署配置与 API 入口校验，公网部署仍需网络层出站限制兜底 DNS 重绑定。
- 凭证（飞书 appSecret、GitLab/GitHub token、模型 apiKey）沿用 `encryptSecrets` 加密入库，API 只回 `hasSecret`。
- GitHub 连接器目前只在本地 fixture 验证；真实 GitHub 授权、限流与私有仓库内容尚未验收。

知识库当前是共享资源：所有 REST 路由挂 `requireAuth`，并按 `knowledge.*` 功能叶声明动作授权；专家在编辑器里选中某个知识库、写入 `agent_servers` 后才获得该连接。仍不引入组织多租户，也不按知识库对象做跨用户范围授权。

### 6.4 任务、调度与恢复

知识任务使用独立队列 `knowledge-jobs`（BullMQ jobId 即 `knowledge_jobs.id`），不占聊天 run 的并发额度，也不出现在运行历史。`queued → running` 用条件更新认领；job 终态由 DB 仓库 `finishJob` 的条件事务一次提交，sync 同时提交 sync run 终态、source 摘要与成功游标；失败/取消不推进 `source.cursor`，中间检查点只保留在本次 sync run，任务内部重试不重新打开终态。运行中取消通过 Redis 键 + `AbortController` 落地。超时为 ingest/sync/cleanup 30 分钟、reindex 2 小时、wiki_generate 15 分钟。

- `knowledge/reconcile.ts` 定期对账：running 且超过 2 倍超时、或 Redis 中已消失的置 failed；Redis 丢失但 DB 仍 queued 的重新入队。
- `knowledge/scheduler.ts` 以数据库的 `sync_cron` 为权威，在 Redis 维护 `knowledge-sync:<sourceId>` 调度器；到点经同一 `createSyncJob` 创建 pair，不在 Redis 保存凭证。清空 cron 即移除调度器；同一来源已有 queued/running 任务时跳过重复触发。入口 cron 先用 shared `cronSchema` 做结构校验，API 再用 BullMQ `getNextMillis` 判定实际可调度性（`99 99 99 99 99` 等被拒），scheduler 不重复预解析；每个来源的「移除旧 pattern → upsert 新 pattern」在独立 `try/catch` 内执行，单来源失败记录来源 ID 与阶段后继续其余来源。
- 任务重试不复用原行，而是创建新任务；这样才能被重新认领。

### 6.5 Wiki 生成

Wiki 生成是知识任务的一种（`wiki_generate`），**直接复用官方 `@anthropic-ai/claude-agent-sdk` 的 `query()`，不引入第二套消息循环**：worker 用 `createSdkMcpServer` + `tool` 注册进程内工具 `wiki_search` / `wiki_read` / `wiki_save_draft`，`allowedTools` 只放这三个 `mcp__knowledge__*`，`tools: []` 清空内置工具，`settingSources: []`、关闭 auto-memory、cwd/HOME 指向任务临时目录。模型取 `KNOWLEDGE_WIKI_MODEL`，走 worker 现有模型网关凭证，不新增 API key。它不创建 `agent_runs` / `conversations` / `messages`，不启动沙盒，也不写工作区。工具与来源限定在本次任务的知识库与可选 `sourceDocumentIds` 内。

草稿只追加版本：SDK 保存不会移动已发布页面的 `current_version_id`；发布与回退是显式 REST 动作，回退会复制目标版本成新版本。来源被删除或停用后，引用它的 Wiki 页标 `stale`，发布时若来源已不可用则拒绝。

### 6.6 与原生记忆的边界

知识语料、个人记忆（原个人偏好）与 SDK 原生 auto-memory（主会话与子智能体各自的 `agent-memory/`）是三类对象：知识库承载有来源的企业文档、版本与引用；`agent-memory/` 承载专家自己的跨会话笔记；个人记忆是跨专家共享、DB 权威的偏好文本，经 hook 注入。三者不共用表、不互相写入；知识不会被挂载进沙盒，记忆也不会进入检索引擎。记忆提案只读已落库的会话快照，不读知识库。

### 6.7 导出与备份

| 对象 | 形式 | 是否含向量/凭证/游标 |
|---|---|---|
| 专家包 | `.claude/` 目录 ZIP + 根 sidecar | 知识连接导出为**官方 MCP HTTP 条目** + 专用 token 环境变量占位，不含 run token、不含知识正文 |
| 知识库数据包 | ZIP `pace/knowledge@1`（`manifest.json` + 原件 + markdown） | 不含向量、密钥、同步游标、任务记录；导入按新 ID 建库，profile 按名称匹配，chunk 不导入向量（可 rebuild 补），缺 profile 时整体 409 而不是建半库 |
| 平台备份 | `knowledge/**` + `pg_dump` + 环境 + 工作区 | 含原件与解析产物；恢复后索引可重建 |

两者不能互相替代：专家包只表达「这个专家绑定了一个知识连接」，知识库数据包才是可迁移的语料交付物。

### 6.8 当前实现状态

知识库已作为与专家/技能/连接器/插件并列的资源页签接入：`/knowledge`列表含新建、设置、启停、知识包导入导出和删除，模型配置支持创建/编辑/删除/测试；`/knowledge/$baseId`含文档/检索/Wiki/来源/任务五个面板。文档支持批量上传、网页和手写，检查器含分块编辑与图片访问；库设置可调整分块字符长度、重叠、Wiki自动更新与重排配置。专家绑定、聊天工具引用和后端任务、调度、对账、导出备份均已落盘；未完成真实企业与真实模型服务验收，当前不能据此宣称生产可用。

**真实闭环仍未完整验收**：上传 → 真实 embedding/rerank → 检索、真实飞书/GitLab 凭证、真实 Wiki 模型生成仍没有跑过真模型或真实企业服务；现有 embedding/feed 运行用的是本地协议夹具（确定性向量与自建 feed/article 服务），只能证明协议形状与任务生命周期，**不代表真实企业来源已接通**。Docling 的 PDF/OCR 适配已在独立容器用固定镜像实测真实 PDF（文本、图片、表格、OCR 开关与 failure 返回），但 compose profile 从未实际拉起，Office 格式、完整真实 embedding 与企业链仍未验；仅标题 OCR 文本在 chunk 丢失的缺陷已由 PR #95（`b28d3e6`）合入 main 并验证通过（见 [任务记录](tasks/real-runtime-acceptance.md)）。已有的运行记录、发现的问题与未验证项见 [任务记录](tasks/knowledge-runtime-verification.md) 与 [审查整改](tasks/knowledge-review-findings.md)，不能把模块测试通过当成端到端通过。

## 7. 关键设计决策

| 决策 | 理由 | 代价 / 边界 |
|---|---|---|
| 运行时挂载 MCP，不生成代码 | 改工具定义立即生效；测试与调用走同一端点；其他 Host 也能连 | 每次请求重建 handler；工具执行在 api 进程内 |
| DB 为真相源，文件为快照 | 页面字段与文件一一对应；同一智能体可被其他 Host 直接使用 | 每次 run 都有渲染与写盘开销 |
| 宿主目录 bind mount，不打进镜像 | 定义不进镜像，改配置不需重建；镜像只承载运行时，可按命名环境扩展依赖 | 只支持单机，workspace 必须与 worker 同机 |
| 整个 runner 在容器内，会话级复用 | Agent SDK 自带的 sandbox 只隔离 shell，不能隔离 stdio MCP；同会话复用省容器创建/启动 | 镜像体积更大；空闲会话容器继续占用资源；不省每轮 SDK query 启动 |
| Redis 流契约只在 `shared/run-stream.ts` 定义 | api 与 worker 分属两个进程，键名/通道/取消载荷一旦漂移就是「事件写了没人读」这类静默故障；第 1 轮发现两处独立副本后收敛 | `@agentport/shared` 因此成为沙盒镜像的运行时依赖（见下） |
| 审计写入支持 `dedupeKey` | BullMQ 基础设施重试会重放同一件事；没有幂等键时每次重试都多写一行审计 | 有键时用 `onConflictDoNothing` 而不是覆盖，重复上报被丢弃 |
| 内置工具默认禁用（Bash 与受路径规则约束的文件工具例外） | 用户可配置任意 stdio server，必须收紧默认权限；Bash 在容器内运行，文件边界由只读挂载约束 | 无需 MCP 即可执行命令；Bash 可访问容器可写挂载，网络按出站配置 |
| SSE 走 Redis Stream + 阻塞读取 | 订阅前的事件可回放；TTL 自动清理 | 事件保留 1 小时，不落库；每个观众一条独立订阅连接（`XREAD BLOCK`）；流不按条数裁剪，写入量由 worker 的展示/落库预算约束；无新事件 1 小时后过期，之后只能靠落库消息恢复 |
| MCP容量按执行计数 | 握手、SSE、平台invoke与审批等待不占上游执行槽，避免自等待 | 每进程执行4槽、排队8项；审批等待独立4槽且满时立即需批准，invoke既有4并发入场；非全局多进程限额 |
| 会话历史使用独占游标页 | 网页默认50条、最多100条，按(created_at,id)倒取后正序展示；before须属于当前会话 | nextBefore为空则结束；消息内容字节未单独限制，内部完整复制调用保持原语义 |
| api / worker 分进程 | 长任务不占 HTTP；队列消费可独立扩容 | 多一层队列与状态同步 |
| 单机优先，不抽象多机 | 少一层存储与服务发现 | 不能横向扩容 worker |
| TypeID（`srv_`、`agt_`、`run_`…） | 可排序、日志与 URL 自解释 | 依赖 `typeid-js` |
| 智能体版本快照 + 回滚 | 配置变更可追溯，回滚生成新版本 | 需维护保留策略 |
| 评估跑批在 worker 队列内 | 批次与用例快照先持久化，API 重启不打断 worker 执行；未认领的队列任务可在 worker 重启后执行 | `eval-runs` 串行（并发 1）；已认领批次中断后不续跑，重投或队列最终失败时条件置 failed，保留已有结果；事件或 DB 收口失败仍由原有超过 1 小时的队列探测对账兜底 |
| 评估批次列表使用游标分页 | 列表只投影摘要列，避免大字段随分页带出；`(agent_id,created_at,id)` 与 `(created_at,id)` 索引覆盖筛选和全局倒序分页 | `GET /api/eval/runs` 默认 50、最大 100，返回 `{items,nextCursor}`；详情仍按单批次读取 |

2026-10-31 状态：评估生命周期修复已实施，并通过独立 Opus PASS（14 文件 / 112 项、0 failed / 0 skipped，含 case output 修复）；本表描述当前实现语义。

### 7.1 `shared/run-stream.ts`：跨进程的事件流契约

沙盒事件的 Redis 布局由 `@agentport/shared` 的 `run-stream.ts` 唯一定义，**api 的 producer 与 worker 的
消费/订阅两侧都必须从这里取，不得再写字符串副本**（第 1 轮只在 worker 换过来，第 2 轮补上 api，并加了
一个 mock 值的契约测试证明 producer 真的在消费 shared 常量）。

| 导出 | 作用 |
|---|---|
| `RUN_TRANSIENT_MAX_EVENTS`（2000）/ `RUN_TRANSIENT_MAX_BYTES`（32MiB） | worker 瞬时展示额度；超出只停止展示并发布 `replay_truncated {reason:'budget'}` |
| `RUN_PERSISTED_MAX_EVENTS`（2000）/ `RUN_PERSISTED_MAX_BYTES`（32MiB） | worker 落库额度，完整消息、工具事件与问题快照共用；超出将成功改为不可重试失败 |
| `runStreamKey(runId)` | `run:<runId>:events`，SSE 回放的事件流 |
| `runEventsConnectionName(runId)` | `run-events:<runId>`，订阅连接的名称，用于计数观众 |
| `runCancelKey(runId)` | `run:<runId>:cancel`，取消标记 |
| `RUN_CANCEL_PAYLOAD` | 取消键的固定值 |
| `runEnqueueOptions(jobId)` | BullMQ `jobId` + `attempts: 2` + 5s 指数退避 |

流的 TTL（1 小时）在写入侧设置，api 与 worker 的 `XADD` 都不带 MAXLEN，每次写入都和 `EXPIRE 3600` 合并为一次 pipeline 并逐条检查命令错误；保留条数不再由 Redis 裁剪，写入量只受上面两个 worker 预算约束。订阅者从流头按 `XRANGE COUNT 2` 正序逐页回放，每页 `await` 回调后才读下一批，再用 `XREAD BLOCK` 从最后一条真实 ID 跟读；回放完成后服务端才补发终态，因此晚加入或重连的观众也能拿到完整流。每个观众仍是独立连接/独立订阅，`XADD` 本身唤醒阻塞读取，不再有单独的 pub/sub 唤醒通道或轮询兜底。终态事件丢失仍由 SSE 路由每 2 秒查数据库兜底。

### 7.2 审计幂等：`writeAudit(dedupeKey)`

`packages/db/src/repo/audit.ts` 的 `writeAudit(db, logger, event)` 正常用 `newId('audit')` 生成主键。
传 `dedupeKey` 时它**直接作为主键**并走 `onConflictDoNothing()`：重复上报同一件事只会保留第一行。
worker 在 run 完成时传 `dedupeKey: aud_<runId 去掉前缀>`，因此 BullMQ 的基础设施重试重放同一个 job 不会写出多条「run 完成」审计。
审计写失败只 `logger.warn`，不影响 run 的终态。

### 7.3 沙盒镜像自包含 workspace 依赖

runner 在 stdin 边界用 `@agentport/shared` 的 zod schema 校验任务（`agentRunJobSchema`），所以该包是
**镜像的运行时依赖**。镜像不再从宿主复制 `dist` 或维护独立 manifest：

- 根 Dockerfile 的 build stage 安装 workspace 依赖并执行 `pnpm -r build`，再用 `pnpm --filter @agentport/sandbox deploy --prod /out/sandbox` 生成自包含目录（dist、生产依赖与 workspace 包，含 shared 的 dist）。
- `sandbox` target 只复制 deploy 结果并验证 `dist/runner.js` 与 Agent SDK 原生 CLI 可执行；`git` 仅为官方插件市场安装保留，`poppler-utils` 供官方长 PDF 分页读取，`bash` 是官方 CLI 执行 Bash 工具所需的真实 shell（缺失会报 `No suitable shell found`）。
- 命名运行环境以该 target 的本地镜像为基座：构建时只发送冻结 Dockerfile，基座固定为 image ID 派生的不可变 tag，产物是独立版本、默认复用 BuildKit 缓存；`docker-cli`/`buildx` 只装进 worker 的 `runtime` target，不进沙盒基座。
- api、worker、sandbox 三个镜像都从仓库根 context 构建；沙盒命令是 `docker build --target sandbox -t agentport/sandbox:dev .`，CI 与 release 同样使用根 context + target。
- 根 `.dockerignore` 排除 `.git`、docs、data、`node_modules`、`dist` 等；旧版 `packages/sandbox/shared` 暂存目录、`package.shared.json`/`package.docker.json` 与 `packages/sandbox/.dockerignore` 均已删除。
- 步骤见 [OPERATIONS.md §2.2.1](OPERATIONS.md#221-手动构建沙盒镜像)；`pnpm run up --rebuild` 与 `pnpm --filter @agentport/sandbox image` 都走这条路径。

更细的选择理由（为什么 PostgreSQL、为什么 v2 MCP 包线、为什么不用 microsandbox 起步）见 `PROJECT-BRIEF.md` 与 `DECISIONS-PENDING.md`。

## 8. 账户、业务身份与权限（2026-10-31 已由 PR #129 合入 main）

> 本节描述已合入 main 的实现；实施契约见 [account-rbac.md](tasks/account-rbac.md) 及其配套契约文件。验收证据与剩余项见任务记录。

### 8.1 两类身份

- **认证技术 ID**：Better Auth `user`/`account` 的随机 ID，只承载登录与会话；允许删除并重建。
- **`businessId`**：稳定业务身份，由管理员录入、不可修改、不可回收给其他自然人。
- 业务创建人、负责人、会话创建人、用户消息发送人、运行发起人、角色/成员授权和个人记忆直接记录 `businessId`，不引用可删除的认证 ID；不以指向认证用户的外键作为业务归属依据。
- 用同一 `businessId` 重建认证账户时，业务归属、角色、成员授权和个人记忆恢复；旧会话行不恢复，旧 Cookie 立即失效。
- 管理员引导（bootstrap）只在首次初始化创建管理员，不覆盖已有密码。

### 8.2 授权模型

- 角色、功能与授权存 DB；默认四角色是初始数据，不写死角色名，也不以角色名代替权限判定。系统 admin 角色的授权固定、不可删除或改矩阵（可改显示名），其他默认与自定义角色可编辑。
- 每条授权 = 动作（功能树叶节点）+ 对象范围（全部/本人/被指定）；判定必须同时满足 permission 与 scope。
- 多角色合并完整授权结果：不把 A 角色的动作与 B 角色的范围拼接。
- 服务端每个业务入口声明并执行动作授权与对象范围检查；前端菜单与动作由同一功能目录驱动。
- 功能树纵向为功能行、横向为角色列，可展开到叶动作单独授权，父级按叶权限三态聚合；评估与定时任务分立。
- 至少保留一名未停用的活跃管理员；删除、停用、降权或矩阵保存导致无管理员时返回 409。

### 8.3 默认角色边界

| 角色 | 允许 | 不允许 |
|---|---|---|
| 平台管理员 | 全部功能；跨用户运维与审计（读取私有内容留审计） | — |
| 用户 | 使用被授权的专家；访问自己的私有会话、消息、运行与个人记忆 | 管理其他用户或全局资源 |
| 负责人 | 创建并管理本人负责的专家；分配使用、指定维护人员、转交 | 管理账户、全局资源或授权；读取其他用户正文 |
| 维护人员 | 维护被指定的专家 | 管理账户、全局资源、授权、新建/删除/转交；读取其他用户正文 |

### 8.4 数据隔离与凭据边界

- 私有会话、用户消息、运行与个人记忆按 `businessId` 归属；个人记忆按 `businessId` 独立目录与锁隔离，不与其他用户共享。
- 既有专家共享 auto-memory 的读写语义不变；个人记忆与专家记忆不互相替代，也不因账户隔离把专家记忆改成只读或私有。
- 平台管理员可跨用户运维与审计并留痕；负责人、维护人员不因角色获得其他用户正文读取权。
- `/mcp` 平台 token、`/mcp/:serverId` Bearer token 与 `/s/<shareId>#<token>` 分享 token 保持独立边界；登录用户权限不扩展到这些凭据。

### 8.5 实施状态

已由 PR #129 合入 main，合入前通过定向验证与最终 review：`0045_married_expediter.sql` 在全新隔离库建库迁移通过；账户/角色/成员与对象范围由 `packages/db/src/repo/accounts.ts`、`access.ts`、`identities.ts` 承接，API 入口按功能叶声明动作与范围，前端功能树复用 `@agentport/shared` 的同一目录。默认角色与验收边界见本节与 [USER-STORIES.md](USER-STORIES.md) EPIC 8；技术字段、表结构与接口以配套契约文件为准。迁移新增 NOT NULL 字段且不回填，仅验证空库；不声称旧库可无损升级，部署到既有库需用户明确决定重建数据，不能自动清库。
