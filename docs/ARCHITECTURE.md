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
| `core` | `renderWorkspace()`、`encryptSecrets()` / `decryptSecrets()`、`toMcpJsonEntry()`、`embedTexts()` / `rerankDocuments()` / `segmentForSearch()` | 不碰数据库、不读写宿主文件；`knowledge-models.ts` 只发 HTTP |
| `db` | 表定义、repo、TypeID 生成、迁移 | 不含 HTTP 或业务编排 |
| `api` | 路由、鉴权、MCP 端点、SSE、入队、评估跑批 | 不启动沙盒、不写工作区 |
| `worker` | 消费队列、每轮渲染定义到会话工作区、管理会话沙盒（复用/空闲回收）、回传事件、维护任务 | 不暴露 HTTP |
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
| 其余（`skills`、`plugins`、`ops`、`overview`、`audit`、`runs`、`status`、`memory-panel`、`knowledge`） | 各资源页，多数是列表 + 详情/表单；`runs`/`audit`/`overview` 用 `data-table.tsx`，`knowledge` 用 `knowledge-settings.tsx` | 同上，优先复用而不是新写 |

页面骨架统一走 `components/page.tsx`（`Page`/`PageHeader`/`PageToolbar`/`PageSection`）；每个渲染状态恰好一个 `h1`。共享状态在 `lib/`（`api.ts`、`queries.ts`），路由表由 `routes/` 生成到 `routeTree.gen.ts`。

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

- **api 与 worker 共用镜像**（根 `Dockerfile` 的 `runtime` target），默认入口 `api/dist/index.js`；compose 用 `command` 覆盖为 `worker/dist/index.js`。沙盒镜像由同一 Dockerfile 的 `sandbox` target 产出，构建上下文同为仓库根。
- **web 没有独立生产容器**：`WEB_DIST=/app/web`，由 api 静态托管；SPA 路由回退到 `index.html`，`/api`、`/mcp`、`/health` 未命中仍返回 JSON 404。
- **沙盒由宿主 Docker daemon 启动**：worker 挂载 `/var/run/docker.sock`，容器内外使用同一工作区绝对路径。同一会话短期复用一个容器，空闲 `SANDBOX_IDLE_TIMEOUT_MS`（默认 5 分钟）后回收；试连与 native plugin 动作仍走一次性容器。
- **沙盒网络模式**：`open` / `proxy` 使用 `bridge`，并加 `--add-host host.docker.internal:host-gateway`；`none` 使用 `--network none`。
- **Redis 承担四件事**：BullMQ 队列、运行事件流、取消通知、限流计数；知识任务使用独立队列 `knowledge-jobs`。
- **知识存储另挂 `knowledgedata:/knowledge`**：api 与 worker 共卷，原件与解析产物不进数据库、不进工作区。

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
3. worker 消费 job：若 run 已被取消则跳过；置为 `running` 并发布 `run_started`。
4. worker 从 DB 读 agent、绑定的 server、技能、子智能体，解密 server 密钥，签发本次 run 的短期 MCP token，调用 `renderWorkspace()` 把官方定义刷新写入 `WORKSPACES_DIR/<slug>/session-sandboxes/<conversationId>/workspace/`；该会话目录只读挂载，每轮覆盖定义内容，根目录不按 run 重命名或删除。
5. worker 通过会话沙盒管理器 `SessionSandboxes.acquire(conversationId)` 取得该会话的容器：首次创建并启动常驻 supervisor，之后复用空闲容器；镜像缺失时先执行可取消的 `docker pull`。supervisor 轻量驻留，每轮由 worker 经 stdin 投递任务，并在容器内启动新的 runner query，不复用上一轮的 query 或进程环境。旧 `DockerSandboxProvider.create/destroy` 只保留给试连与 native plugin 等一次性容器。create 请求已经发出后取消会等待创建结果并删除，绝不继续启动。
6. 会话容器准确挂载 `sdk-sessions/<conversationId>`（→ `/home/node/.claude`）、`agent-memory`、`conversation-inputs`（首轮无附件也预建并挂载）与只读 `/workspace`；`/mnt/outputs` 指向稳定的 session outputs 目录，读写。每轮凭证只经新 runner 的进程环境与当轮 `.mcp.json` 注入。容器内 runner 读取一行任务，在 `/workspace` 上运行 Agent SDK；stdout 每行一个事件（`assistant_block_start`/`assistant_block_stop`、带 `blockIndex` 的 `text_delta`、`tool_start`、`tool_input`、`tool_result`（可选带 `todos` 快照，见 §3.1）、按块完成的 `assistant_text`、`run_finished`），日志写 stderr。块边界与 `sdkUuid`/`parentToolUseId` 让前端按内容块重建，单块超过 `SANDBOX_MAX_FIELD_BYTES`（默认 1MiB）时截断并标 `truncated`，不再静默丢尾部。
7. worker 逐行解析并按事件写入 Redis Stream（每次 `XADD` 与 TTL 续期合并为一次 pipeline）；supervisor 的业务事件保持原 `ChatEvent` 契约，`ready`/`started`/`settled`/`rejected` 等 control 事件只用于宿主握手，不写 SSE。工具调用经 `.mcp.json` 中的地址访问 api。
8. 取消：api 写 `run:<runId>:cancel` 键并 publish；worker 通知 supervisor 停止本轮。supervisor 发出 `settled` 并确认所有 run 进程停稳后，正常完成或成功取消可 `release(reuse=true)` 进入空闲；超时、异常或无法确认停稳则销毁容器。创建阶段的取消信号中止拉取，已发出的 create 则等待返回后删除、不启动。试连与 native plugin 仍由 `DockerSandboxProvider` 一次性 `create/destroy`，不走会话复用。
9. 结束后 worker 把 `assistant_text`（每块一行，内容保留 `blockIndex`/`parentToolUseId`/`truncated`）与 `tool_result` 写入 `messages`，更新 run 的状态、成本、轮次、token、延迟、错误，发布唯一一条 `run_finished`，写审计。事件展示额度与落库额度分开：`text_delta`、块边界等瞬时事件超出展示上限只停止展示，完整 `assistant_text` 与工具事件另有落库上限，不会被增量挤出。真正超过落库上限时保留已收集结果，将成功改为带明确原因的不可重试失败，避免缺失尾部仍报告成功。
10. 只有业务执行本身的基础设施类失败（Docker 不可用、连接被拒、镜像缺失等）会触发 BullMQ 重试；业务失败不重试。清理失败不作为基础设施失败重跑；已确定的终态与取消收尾的 `sessionId`、费用 metadata 保留。销毁失败会阻止发布成果并保留草稿，避免把未停稳的一轮当成已交付。

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

成果是运行数据，不是智能体定义；不新增成果表，也不把 `.claude/` 文件当成果。用户消息可携带 `output: { runId, path }`，API 校验该版本属于当前会话后随用户消息落库；worker 读取它准备下一轮草稿。每轮发布后，`GET /api/conversations/:id/outputs` 按版本返回有变化的文件，`.../outputs/:runId/content` 返回完整 UTF-8 文本，`.../download` 返回原件。前端右侧成果面板按路径分组、可选版本、阅读/源码切换和下载；“基于此版本修改”只挂引用，不自动发送，用户可继续编辑或取消。Fork 只复制历史边界内且两个消息锚点都能映射的版本，并把锚点重写为分支消息 ID；删除会话或专家回收成果，run 保留期清理不删除成果。

边界：当前模型没有删除工具，多文件中的单文件删除不作为支持路径；二进制只下载，Office 无预览；HTML/SVG 只按源码展示；正文超过 1MiB 只下载。成果正文是交付内容，不套用聊天的密钥脱敏；路径逃逸、符号/硬链接和跨会话读取在存储与 API 边界拒绝。

实现状态（2026-10-28）：真实两轮12/12、分支8/8、停止后保留2/2、浏览器预览/下载与反馈挂引用通过；串行后端1824/1824、Web905/905、API9/9、typecheck/build通过，独立评审通过。Office/PDF不预览、无删除工具、成果内容不做聊天脱敏；详见 [任务记录](tasks/agent-output-viewing.md) 与 D-67。成果查看不代表成果质量自动通过。

### 3.3 原生澄清提问（已接通）

US-6.2以官方 `AskUserQuestion → canUseTool → updatedInput` 接回用户答案，继续同一次工具调用。问题与答案属于运行数据，智能体定义仍由官方文件表达；不新增自定义提问工具或第二执行循环。

当前固定方案：supervisor 保留常驻 stdin 通道；本轮 runner 经 supervisor 发问题请求，worker 先持久化运行问题再发布 SSE 快照；用户经鉴权 API 回答，worker 沿现有 PG 轮询模式把答案回传给本轮 runner。消息内容保留问题最终快照，使历史与分支只读展示不依赖 run 保留期。等待计入原整体运行 timeout，停止/超时使待答问题关闭。

权限边界：官方 `dontAsk` 直接拒绝需要交互的工具、不会进入回调；新建默认采用 `default`，显式模式不重写。回调只处理主会话原生提问，其余未预批准工具拒绝；文件访问hook、禁用工具、子级边界与MCP服务端审批保留。回答问题不表示批准副作用。子智能体官方暂不支持原生提问。

本地SDK0.3.311探针已验证default回答后继续、dontAsk拒绝；隔离Linux沙盒与桌面浏览器已完成提问→刷新→回答→同run成果交付，并在最终源码上复测4条真实run（主场景、拒答、停止、超时）通过。回答后MCP副作用仍等待独立批准。公开问题以题序号与选项序号提交，API映射回原SDK键值；DB/SDK保留原文，GET/POST/SSE/历史统一脱敏投影。已知限制：流式增量按单帧脱敏；等待占用整体run超时。详见 [任务记录](tasks/agent-clarification.md)。

### 3.4 会话输入附件

用户在 Composer 选择文件后，随 `POST /api/chat` 以 base64 JSON 一次提交；服务端按扩展名映射规范 MIME，校验规范 base64、真实大小、文件签名与文本 UTF-8，再写入 `WORKSPACES_DIR/<slug>/conversation-inputs/<conversationId>/<attachmentId><ext>`。用户消息只保存 `{id, filename, mimeType, size, sha256}` 元数据，队列与 SSE 不携带文件字节。入口上限：每条消息 5 个、合计 10MiB，文本 1MiB、图片 5MiB、PDF 10MiB，JSON body 16MiB；Office/ODF、压缩包、音视频等明确拒绝并提示改用知识库或文本。

worker 预建该会话目录并只读挂到 `/mnt/inputs`（首轮无附件也预建并挂载），prompt 追加受控清单（显示名 JSON 转义、容器路径、类型、字节数），要求主智能体先 `Read` 再分析、读取失败必须说明。图片由官方 Read 返回视觉内容；PDF 短文件整份读取，长文件按 `pages` 分页，沙盒镜像安装 `poppler-utils`。输入目录只允许主会话 `Read`，Write/Edit、子智能体、未挂载路径、软链/硬链与越界继续拒绝；交付仍写 `/mnt/outputs`。

附件按会话保留：分支只复制被复制消息引用的文件（字节复制，删源后独立）；删除会话/专家回收目录；`pruneRuns` 保留带附件的用户消息并置空 `runId`，孤儿清理永不删除附件消息，保证历史与下载入口不随旧 run 消失。下载经鉴权且只接受该会话消息引用的附件。附件是运行数据，不进入智能体定义，也不替代知识库。

实现状态（2026-10-28）：隔离环境真实模型验证 CSV/PNG/14 页 PDF 的原生读取、报告内容与下载哈希一致、同会话第二轮读取历史附件、分支删源后继续读取；跨会话下载 404、伪类型/超限 400。Compose 为完整支持环境；宿主直跑需同一绝对 `WORKSPACES_DIR`，非 uid 1000 宿主与沙盒的 0700 目录限制见 `docs/OPERATIONS.md`。详见 [任务记录](tasks/agent-attachments.md)。

## 4. HTTP → MCP、平台 → MCP 与内置知识 MCP

前两个方向共用 MCP 协议与同一个 Node 适配器，但目的不同；`/mcp/:serverId` 还承载平台为知识库自动生成的内置连接（第三种用途）。

| 维度 | HTTP → MCP（`/mcp/:serverId`，generated） | 平台 → MCP（`/mcp`） | 内置知识 MCP（`/mcp/:serverId`，knowledge） |
|---|---|---|---|
| 解决什么 | 把已有 HTTP API 变成 MCP 工具 | 把平台内的智能体变成 MCP 工具 | 让绑定专家在 run 内只读检索一个知识库 |
| 工具来源 | `api_tools` 表，每个 generated server 一组 | 所有 `enabled = true` 的智能体，工具名 `run_<slug>` | 固定四个只读工具：`knowledge_search` / `knowledge_read` / `knowledge_list` / `knowledge_read_image` |
| 鉴权 | 沙盒内用按 run 签发的短期 token（DB 存 sha256，终态停稳后清空）；外部客户端用长期 `mcpToken` | 单个 `PLATFORM_MCP_TOKEN`；未设置则不注册该端点 | 只接受绑定该 server 的 run 短期 token；没有长期 token，无效一律 401 |
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

工作区按会话稳定复用，每轮只刷新定义内容；根目录不按 run 重命名或删除。目录 0700、文件 0600。持久数据只有 `agent-memory/`、`sdk-sessions/<conversationId>/`、`conversation-outputs/<conversationId>/` 与 `conversation-inputs/<conversationId>/`；`session-sandboxes/<conversationId>/{workspace,outputs}` 是可再生的派生缓存：`workspace` 每轮由数据库重渲染，`outputs` 在停稳后复制进 `conversation-outputs`，容器回收或关停不删除它，但它不是不可丢失的持久交付。run 保留期清理不删除会话成果，会话或专家删除时回收对应目录。

| 文件 | 内容来源 | 说明 |
|---|---|---|
| `.mcp.json` | `agent_servers` + `servers` | `mcpServers` 映射；stdio 写 command/args/env，http 写 url/headers，generated 写 `${SANDBOX_API_URL}/mcp/<id>` + 按 run 的短期 Bearer token 与 `x-agentport-run-id` |
| `CLAUDE.md` | `agents.system_prompt_md` | 系统提示词 + 工具说明 + 技能 + 子智能体清单（含超时）+ 多步骤任务用原生 `TodoWrite` 维护清单的约束；前台执行与单层委派由运行时环境变量强制，不再逐次写在提示里 |
| `.claude/agents/<child-slug>.md` | 子智能体配置 | YAML frontmatter：`name`、`description`、`model`、`mcpServers`（按名引用根 `.mcp.json`）、`disallowedTools`、`maxTurns` 及子级绑定的 `skills`；**不写 `tools`**，否则 SDK 派生时按名字解析 MCP 工具会得到空集并拒绝启动。父级不写 server 级 `disallowedTools`：子级继承会话权限，server 级 deny 会把子级工具一起移除，父级越权改由 PreToolUse 边界 hook 拒绝。主智能体自己的 md 只用于预览（`GET /api/agents/:id/files`），不落盘，避免被当成可委派子智能体 |
| `.claude/skills/<slug>/SKILL.md` | `skills` 表 | frontmatter：`name`、`description`，正文为技能步骤 |

运行时约定：

- 每轮在会话 workspace 内先删除并重建 `.claude/agents/` 与 `.claude/skills/`，解绑后的旧文件不会残留。不要手工往这两个目录放东西。
- 会话 workspace 以只读方式挂载到容器 `/workspace`；agent 不能修改自己的定义。稳定的 `session-sandboxes/<conversationId>/outputs` 以 rw 挂到 `/mnt/outputs`，主会话用原生 Read/Write/Edit 交付文件；不使用 SDK `additionalDirectories`，避免可写目录被当作配置来源加载。容器另准确挂载 `sdk-sessions/<conversationId>`、`agent-memory` 与预建的 `conversation-inputs`，不挂整个 agent 目录。
- 每轮 `.mcp.json` 与 runner 进程环境只携带本轮短期凭证；运行结束时不论容器清理是否成功都吊销本轮 MCP/模型 token，终态停稳后移除 `.mcp.json`，空闲容器不保留上一轮身份，下一轮重新渲染。
- 运行结束后 worker 等本轮 runner 停稳（`settled`），由 core 的 `captureOutputDraft` 从 stable outputs 复制出本轮草稿，再以当前最新完整快照为基线发布不可变快照；stable outputs 根只读复制，不发布也不删除。用户选定旧版时只把所选文件覆盖到草稿，其他最新文件保持原样。正在重试、消息保存失败、容器未停稳或销毁失败时不发布并保留草稿；空基线清空后发布空快照。
- API 鉴权读取成果列表、完整 UTF-8 文本（≤1MiB）与原件下载；读取只接受 manifest 成员，HTML/SVG 仅按源码返回，不执行。二进制提供下载，不在服务端伪造文本预览。
- 内置工具默认全部从上下文移除；`allowedTools` 只负责自动批准。原生 `TodoWrite` 是显式启用的例外（§3.1），只用于展示进度。MCP 工具的允许规则按 server name 逐个生成 `mcp__<name>__*`，`mcp__*` 通配无效。
- 父级绑定技能slug从worker传给SDK的`skills`选项；无绑定明确传`[]`，仅控制自动批准的Skill(name)清单，不代表CLI发现清单隐藏其他技能。CLAUDE.md仅列父绑定技能。启用子智能体的绑定技能经批量查询合并到工作区文件，其子定义独立写`skills`预加载字段，不扩展父级SDK许可。真实CLI已发现子定义和技能文件；初始化接口不暴露预加载状态，子级正文加载及实际模型调用仍未验证，支持资源目录另行验收。
- 有子智能体时才放行 `Agent` / `TaskStop`；子智能体自身不再获得委派能力。
- 会话间消息工具（`ListAgents`、`SendMessage`、`SendUserMessage`、`EndConversation`、`Monitor`）默认禁用：
  平台只支持「同步等待返回」这一种智能体沟通模型，发送方不等对方返回就继续与平台约定相悖。
- 平台内的「文件预览」与运行时使用同一个 `renderWorkspace()`，但不落盘；写文件只发生在 worker。
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
- 提示词进 CLAUDE.md 而不是 `.claude/rules/`：该段位于 `parseClaudeMd` 的截断标记之后，不污染用户可编辑正文，导出包也不会丢失。
- `pnpm-workspace.yaml` 的 `allowBuilds` 明确拒绝 `@openuidev/lang-core` 的构建脚本：否则每次 `pnpm install --frozen-lockfile` 因 `ERR_PNPM_IGNORED_BUILDS` 失败；该脚本只发匿名安装遥测。`.npmrc` 的变量**不会**作为进程环境传给 postinstall，因此不靠它关闭遥测。


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
| `.claude/output-styles/*.md` | project source，并按 settings 选择输出风格 | 已有输出风格管理、文件预览与根级运行落盘；选中者写入 settings.json 的 outputStyle，runner 通过 `settingSources: ['project']` 原生加载，不再手工解析后 inline 覆盖 |
| Hooks | 由 settings.json 的 hooks 配置或 SDK callbacks 注册；脚本目录本身不是自动发现入口 | 平台层回调与工作区文件Hooks需分别核对，不能仅创建hooks目录声称生效 |
| 插件根中的 `.claude-plugin/plugin.json`、skills/agents/hooks/.mcp.json | SDK `plugins: [{type:'local', path}]` 指定本地插件根；不是默认扫描项目 `.claude/plugins/` | 插件库文件在 DB 保存一次，多个专家引用，每次运行复制到独立 `.claude/plugins/<slug>/`。支持 ZIP 导入，以及 worker 独立安装沙盒调用 Claude Code CLI 从市场安装、读取平台已下载缓存后纳入插件库；来源记录 `name@marketplace` 去重，缓存不挂载给专家。hooks/MCP 默认关闭，仍按各专家绑定裁剪。平台子智能体不绑定插件；插件自带子智能体可原生委派。已有技能、references、子智能体及 hooks/MCP 开关真实沙盒证据。无升级/版本选择入口，专家 ZIP 不带插件并提示；不支持的组件、二进制和运行依赖明确拒绝，不静默漏文件 |
| `.claude/workflows/*.js`、`.claude/agent-memory/<name>/` | Claude Code 官方目录能力，受版本、工具与会话权限约束 | 原生 auto-memory 使用 `WORKSPACES_DIR/<slug>/agent-memory/`（uid 1000、0700），API/worker 共卷，沙盒 rw 挂载到 `/mnt/agent-memory` 并设置 `autoMemoryEnabled=true`、`autoMemoryDirectory`。主会话仅预批准该目录的 Read/Edit 路径规则（Edit 含 Write），SDK PreToolUse 每次拒绝越界、链接和非普通 Markdown 文件；子智能体仍禁用文件工具。保留官方 `MEMORY.md` 与主题文件；权限/挂载测试通过，真实模型跨 run 记忆验收尚未验证。Workflows 仍不接入 |

详情接口返回插件库实际保存的完整文件。前端 `/plugins/$pluginId` 是只读详情页：紧凑身份头（名称、版本、简介、导出）下用页内「简介 / 内容」两个 Tabs 切换，不使用抽屉、Sheet 或弹层，页面恰好一个 `h1`。简介页签只展示根 README；无 README 时给简洁空态并指向内容页签，不编写介绍、不拿首个技能冒充说明。内容页签在页内展示真实完整目录树与当前正文：桌面左右可拖动分栏，窄屏目录在同一页内折叠；默认文件为 README → 技能 `SKILL.md` → 首个真实文件。目录树用真实文件/目录名，目录优先、可折叠，只有当前文件铺选中底色，技能目录内 `SKILL.md` 优先，manifest、hooks、MCP、支持文件、空文件全部可达。URL 用 `tab=intro|content`、`file`、`mode=read|source`，默认 `intro` 且无 `file`；切换页签、选择文件与模式进入历史，刷新和前后退可恢复，切到简介保留 `file`/`mode`，切回内容恢复上次选择与滚动位置，失效文件给说明并回退。点击 README 或正文内真实文件链接切到内容页签并定位对应文件。正文显示实际路径 breadcrumb 与 frontmatter 语义名称，Markdown 默认阅读并可切源码，其余文件直接源码并可复制。展示解析只读取 frontmatter 的名称、描述和正文，不改变保存内容或运行定义；Markdown 静态渲染，HTML 作为文本，只有插件内真实存在的相对文件链接可点击。内容区按真实文件路径展示，不另建能力索引；多来源文件在目录树中各自可达。详情是插件库快照，专家运行时仍独立复制并按授权裁剪。

会话恢复、预算、取消信号、消息流、宿主 callbacks 等还有 SDK 运行时参数，不能声称全部都可写入 settings.json。`~/.claude/` 的认证、缓存、会话记录等宿主状态不属于可分享项目定义，不复制进用户工作区包。

会话上下文不再拼接历史文本：每个 conversation 的 SDK transcript 持久化在 `WORKSPACES_DIR/<slug>/sdk-sessions/<conversationId>/`，容器只挂这一个目录到 `/home/node/.claude`；续聊传 `resume`，从某条用户消息分支时先复制来源 transcript 再用官方 `forkSession` 截断，成功后写回新 session id。fork 会给消息换新 uuid，映射由 **worker 从宿主 transcript 的 `forkedFrom` 字段计算**（不按位置对齐，压缩过的会话顺序会变），并与消息同事务写库；resume 事件只携带新 session id。transcript 缺失时该轮以 infra 失败，不回退成文本上下文。该目录属于运行时持久数据，随备份保存，但不是可分享定义包的一部分。从历史点复制会话时，来源读取、分支会话行与复制消息在同一个 `db.transaction` 内提交；后续批次失败不会留下半成品分支。

当前 sandbox 明确使用 `cwd:'/workspace'`、`settingSources:['project']`；不加载宿主 user/local 偏好。outputStyle 因此由项目 `settings.json` 原生加载，inline settings 只覆盖同名 key。官方加载默认值可能随版本变化，继续显式配置。文件导入必须经过类型、路径与大小校验，不能直接解压到执行目录或自动运行导入的脚本。

官方来源：
- https://code.claude.com/docs/en/agent-sdk/claude-code-features
- https://code.claude.com/docs/en/claude-directory
- https://code.claude.com/docs/en/agent-sdk/skills
- https://code.claude.com/docs/en/agent-sdk/subagents
- https://code.claude.com/docs/en/agent-sdk/plugins
- https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts

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

首批只做 RSS/Atom/JSON Feed、飞书 Wiki/Drive、GitLab 仓库文件（项目/ref/path）。范围（`knowledge_source_ranges`）必须非空，空数组在入口就 400，**不解释成「全企业」**。一个来源可以保存多条范围，每条范围有独立游标：飞书按空间/节点/云盘目录，Feed 按订阅地址，GitLab 按项目/ref/paths；GitLab 的范围填了 `externalId` 就以范围为准，未填时回落到 `config` 的 `projectId`/`ref`。`listRanges` 只用于展示与连接检查，同步只读已保存的范围。API 支持整体替换范围；前端新建来源时只提交一条范围，编辑对话框保留原有范围但暂不提供增删改。飞书的 `appId` 存在 `config`，`appSecret` 只存加密列；GitLab 的 token 与模型 apiKey 同理。

文档身份只按 `(base_id, source_type, source_id)` 匹配外部条目，绝不用标题；`upload`/`manual` 的 `source_id` 为空。外部 `source_id` 形如 `<来源连接 ID>:<源端条目 ID>`（源端 ID 是飞书 token / GitLab `project:ref:path` / `feedURL:itemId`），加上连接前缀后，同一条目出现在两个来源里也不会互相覆盖。来源归属另记在 `metadata.knowledgeSourceId`，因为文档表没有指向来源的外键。

- Feed 是滚动窗口：条目自然滚出窗口不删除，连接器永远返回「不完整枚举」。
- 飞书只同步 `docx` 类型的 Wiki 节点与云盘的 docx/文本文件；其他类型或不支持的内容明确报错，不静默跳过。
- GitLab 只读取文本类扩展名（md/txt/html/csv/json/xml/yaml/rst/adoc 等）的 blob；PDF/Office 等二进制文件不在当前同步范围内。先完整遍历仓库树，任何分页失败都抛出，不推导删除。
- 飞书 Wiki/Drive 与 GitLab 只有在连接器明确声明「枚举完整」且本轮无失败时，`syncDeletions: true` 才允许把未再出现的条目置为 `disabled`（不物理删除、不参与检索）。
- 上传入口不做格式预筛，PDF/Office/OCR 交给 `DOCLING_URL`；未配置时该格式以任务失败明确报出，不静默降级。来源同步走各自的读取路径，不经过 Docling。
- 来源的「测试」只校验本地配置与凭证是否齐全，不发外网请求；真实连通性以同步 run 的结果为准。
- 私网出站：`KNOWLEDGE_PRIVATE_HOST_ALLOWLIST` 只做精确 `host` / `host:port` / origin 匹配，默认空。它当前作用于两处：worker 的来源连接器抓取（飞书/GitLab/Feed，逐跳校验，使用独立的 `validateSourceUrl`）与 API 侧模型 profile 的创建/修改/测试。名单外的地址分别走各自的私网校验；名单只对知识出站生效，不会让普通 MCP server 把任意 URL 变成可信。
- 目前**没有**接入该名单的知识出站还有三处，部署时应知悉：URL 导入只经 `assertSafeUrl`；worker 调 Docling 与 embedding/rerank 直接用已保存端点，不再逐次复核；这些端点的可信性依赖部署配置与 API 入口校验，公网部署仍需网络层出站限制兜底 DNS 重绑定。
- 凭证（飞书 appSecret、GitLab token、模型 apiKey）沿用 `encryptSecrets` 加密入库，API 只回 `hasSecret`。

知识库是单管理员部署下的共享资源：所有 REST 路由挂 `requireAuth`，不新增多租户或 RBAC。专家在编辑器里选中某个知识库、写入 `agent_servers` 后才获得该连接；没有「按用户授权」的中间层。

### 6.4 任务、调度与恢复

知识任务使用独立队列 `knowledge-jobs`（BullMQ jobId 即 `knowledge_jobs.id`），不占聊天 run 的并发额度，也不出现在运行历史。`queued → running` 用条件更新认领，终态只写一次；运行中取消通过 Redis 键 + `AbortController` 落地。超时为 ingest/sync/cleanup 30 分钟、reindex 2 小时、wiki_generate 15 分钟。

- `knowledge/reconcile.ts` 定期对账：running 且超过 2 倍超时、或 Redis 中已消失的置 failed；Redis 丢失但 DB 仍 queued 的重新入队。
- `knowledge/scheduler.ts` 以数据库的 `sync_cron` 为权威，在 Redis 维护 `knowledge-sync:<sourceId>` 调度器；到点只创建 sync run 与任务，不在 Redis 保存凭证。清空 cron 即移除调度器；同一来源已有 queued/running 任务时跳过重复触发。
- 任务重试不复用原行，而是创建新任务；这样才能被重新认领。

### 6.5 Wiki 生成

Wiki 生成是知识任务的一种（`wiki_generate`），**直接复用官方 `@anthropic-ai/claude-agent-sdk` 的 `query()`，不引入第二套消息循环**：worker 用 `createSdkMcpServer` + `tool` 注册进程内工具 `wiki_search` / `wiki_read` / `wiki_save_draft`，`allowedTools` 只放这三个 `mcp__knowledge__*`，`tools: []` 清空内置工具，`settingSources: []`、关闭 auto-memory、cwd/HOME 指向任务临时目录。模型取 `KNOWLEDGE_WIKI_MODEL`，走 worker 现有模型网关凭证，不新增 API key。它不创建 `agent_runs` / `conversations` / `messages`，不启动沙盒，也不写工作区。工具与来源限定在本次任务的知识库与可选 `sourceDocumentIds` 内。

草稿只追加版本：SDK 保存不会移动已发布页面的 `current_version_id`；发布与回退是显式 REST 动作，回退会复制目标版本成新版本。来源被删除或停用后，引用它的 Wiki 页标 `stale`，发布时若来源已不可用则拒绝。

### 6.6 与原生记忆的边界

知识语料与 SDK 原生 auto-memory 是两类对象：知识库承载有来源的企业文档、版本与引用；`agent-memory/` 承载专家自己的跨会话笔记，仍是工作区内的官方目录能力（§5）。两者不共用表、不互相写入；知识不会被挂载进沙盒，记忆也不会进入检索引擎。

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
| 宿主目录 bind mount，不打进镜像 | 一个镜像服务所有智能体；改配置不需重建 | 只支持单机，workspace 必须与 worker 同机 |
| 整个 runner 在容器内，会话级复用 | Agent SDK 自带的 sandbox 只隔离 shell，不能隔离 stdio MCP；同会话复用省容器创建/启动 | 镜像体积更大；空闲会话容器继续占用资源；不省每轮 SDK query 启动 |
| Redis 流契约只在 `shared/run-stream.ts` 定义 | api 与 worker 分属两个进程，键名/通道/取消载荷一旦漂移就是「事件写了没人读」这类静默故障；第 1 轮发现两处独立副本后收敛 | `@agentport/shared` 因此成为沙盒镜像的运行时依赖（见下） |
| 审计写入支持 `dedupeKey` | BullMQ 基础设施重试会重放同一件事；没有幂等键时每次重试都多写一行审计 | 有键时用 `onConflictDoNothing` 而不是覆盖，重复上报被丢弃 |
| 内置工具默认禁用 | 用户可配置任意 stdio server，必须收紧默认权限 | 需要显式绑定 MCP 才能做事 |
| SSE 走 Redis Stream + 阻塞读取 | 订阅前的事件可回放；TTL 自动清理 | 事件保留 1 小时，不落库；每个观众一条独立订阅连接（`XREAD BLOCK`）；回调过慢导致未读事件被 MAXLEN 裁剪时不再补截断提示 |
| MCP容量按执行计数 | 握手、SSE、平台invoke与审批等待不占上游执行槽，避免自等待 | 每进程执行4槽、排队8项；审批等待独立4槽且满时立即需批准，invoke既有4并发入场；非全局多进程限额 |
| 会话历史使用独占游标页 | 网页默认50条、最多100条，按(created_at,id)倒取后正序展示；before须属于当前会话 | nextBefore为空则结束；消息内容字节未单独限制，内部完整复制调用保持原语义 |
| api / worker 分进程 | 长任务不占 HTTP；队列消费可独立扩容 | 多一层队列与状态同步 |
| 单机优先，不抽象多机 | 少一层存储与服务发现 | 不能横向扩容 worker |
| TypeID（`srv_`、`agt_`、`run_`…） | 可排序、日志与 URL 自解释 | 依赖 `typeid-js` |
| 智能体版本快照 + 回滚 | 配置变更可追溯，回滚生成新版本 | 需维护保留策略 |
| 评估跑批在 worker 队列内 | API 只建行并入队，重启不丢跑批 | `eval-runs` 串行（并发 1）；超时 running 由 reconciler 收敛 |
| 评估批次列表使用游标分页 | 列表只投影摘要列，避免大字段随分页带出；`(agent_id,created_at,id)` 与 `(created_at,id)` 索引覆盖筛选和全局倒序分页 | `GET /api/eval/runs` 默认 50、最大 100，返回 `{items,nextCursor}`；详情仍按单批次读取 |

### 7.1 `shared/run-stream.ts`：跨进程的事件流契约

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

流的 TTL（1 小时）在写入侧设置，api 与 worker 的 `XADD` 都和 `EXPIRE` 合并为一次 pipeline 并逐条检查命令错误。订阅者按有界批次 XREVRANGE 回放最近 8MiB（顺序不变，累计不超过上限），再用 `XREAD BLOCK` 从最后一条真实 ID 跟读；每个观众仍是独立连接/独立订阅，`XADD` 本身唤醒阻塞读取，不再有单独的 pub/sub 唤醒通道或轮询兜底。终态事件丢失仍由 SSE 路由每 2 秒查数据库兜底。

### 7.2 审计幂等：`writeAudit(dedupeKey)`

`packages/db/src/repo/audit.ts` 的 `writeAudit(db, logger, event)` 正常用 `newId('audit')` 生成主键。
传 `dedupeKey` 时它**直接作为主键**并走 `onConflictDoNothing()`：重复上报同一件事只会保留第一行。
worker 在 run 完成时传 `dedupeKey: aud_<runId 去掉前缀>`，因此 BullMQ 的基础设施重试重放同一个 job 不会写出多条「run 完成」审计。
审计写失败只 `logger.warn`，不影响 run 的终态。

### 7.3 沙盒镜像自包含 workspace 依赖

runner 在 stdin 边界用 `@agentport/shared` 的 zod schema 校验任务（`agentRunJobSchema`），所以该包是
**镜像的运行时依赖**。镜像不再从宿主复制 `dist` 或维护独立 manifest：

- 根 Dockerfile 的 build stage 安装 workspace 依赖并执行 `pnpm -r build`，再用 `pnpm --filter @agentport/sandbox deploy --prod /out/sandbox` 生成自包含目录（dist、生产依赖与 workspace 包，含 shared 的 dist）。
- `sandbox` target 只复制 deploy 结果并验证 `dist/runner.js` 与 Agent SDK 原生 CLI 可执行；`git` 仅为官方插件市场安装保留。
- api、worker、sandbox 三个镜像都从仓库根 context 构建；沙盒命令是 `docker build --target sandbox -t agentport/sandbox:dev .`，CI 与 release 同样使用根 context + target。
- 根 `.dockerignore` 排除 `.git`、docs、data、`node_modules`、`dist` 等；旧版 `packages/sandbox/shared` 暂存目录、`package.shared.json`/`package.docker.json` 与 `packages/sandbox/.dockerignore` 均已删除。
- 步骤见 [OPERATIONS.md §2.2.1](OPERATIONS.md#221-手动构建沙盒镜像)；`pnpm run up --rebuild` 与 `pnpm --filter @agentport/sandbox image` 都走这条路径。

更细的选择理由（为什么 PostgreSQL、为什么 v2 MCP 包线、为什么不用 microsandbox 起步）见 `PROJECT-BRIEF.md` 与 `DECISIONS-PENDING.md`。
