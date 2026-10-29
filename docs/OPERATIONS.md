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
| `ADMIN_PASSWORD` | 是 | — | api | 管理员密码，默认要求 ≥12 字符且不能是 `admin-change-me` / `changeme` / `password`；每次登录用 scrypt 比对 |
| `ALLOW_WEAK_ADMIN_PASSWORD` | 否 | 未设置（等同 `false`） | api | 只接受字面量 `true` / `false`。默认关闭，保持上面的密码规则；个人本地开发要用 admin/admin 时显式设为 `true`，此时仅保留 1–128 字符的基础限制。生产部署不要开启 |
| `JWT_SECRET` | 是 | — | api | better-auth 会话签名密钥，≥32 字符 |
| `CORS_ORIGINS` | 否 | `http://localhost:5173` | api | 逗号分隔的浏览器 Origin allowlist；生产填实际访问域名（如 `https://agentport.example.com`），不要用 `*`。本机 Portless 可加通配符 `https://*.agentport.localhost`（仅 HTTPS 默认端口），一次覆盖变化的 worktree 子域名，精确的 `https://agentport.localhost` 仍保留；生产只有确实要覆盖子域名时才用通配符 |
| `SELF_URL` | 否 | `http://127.0.0.1:3000` | api | generated server「测试连接」时访问的平台自身地址 |
| `AGENT_MAX_CONCURRENT` | 否 | `2` | api、worker 均解析；worker 使用 | `agent-runs` 队列并发数（api 解析但不读）；只限制同时执行的 run，热空闲的会话容器不计入该并发 |
| `AGENT_TIMEOUT_MS` | 否 | `600000` | api 解析但不读；worker 用于对账 | **不是执行超时**。真实执行超时取该智能体的 `timeoutMs`（默认 `600000`）；本变量只作为孤儿 run 对账的时间窗口：queued run 超过 `AGENT_TIMEOUT_MS` + 5 分钟宽限后先探测队列，job 消失或已终态才置 failed；running run 改用该智能体当前配置的 `timeout_ms` |

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
| `ANTHROPIC_API_KEY` | 二选一 | — | worker | 模型 API key 的配置入口；默认只由 worker 的模型凭证代理持有，不注入容器 |
| `ANTHROPIC_AUTH_TOKEN` | 二选一 | — | worker | 以 Bearer token 发送；与上一项二选一，同样由 worker 持有 |
| `ANTHROPIC_BASE_URL` | 否 | — | worker | 自建网关地址，作为模型凭证代理的上游；容器内不可达的 loopback 由 worker 改写为 `host.docker.internal` |
| `AGENT_TIMEOUT_MS` | 否 | `600000` | worker | 仅用于孤儿 run 对账：queued run 超过该值 + 5 分钟宽限且队列探测确认 job 消失/已终态才置 failed；running run 用该智能体当前配置的 `timeout_ms`。不是执行超时，执行取 `agent.timeoutMs`（默认 `600000`）；api 也解析但不读 |
| `AGENT_MAX_CONCURRENT` | 否 | `2` | worker | `agent-runs` 队列并发数；只限制同时执行的 run，正常完成或成功取消后的热空闲会话容器会在 `SANDBOX_IDLE_TIMEOUT_MS` 内继续占用资源 |

**配置入口与容器 env 不同。** 配置任一模型凭证后，worker 在 `MODEL_PROXY_PORT`（默认 3426）启动模型凭证代理（D-17）：真实凭证只留在 worker 进程，沙盒每轮只拿到 `ANTHROPIC_BASE_URL=<代理地址>` 与短期 `ANTHROPIC_AUTH_TOKEN=run_...`（`ANTHROPIC_API_KEY` 置空），run 结束即吊销（不论容器清理是否成功）。未配置凭证时代理不启动，`sandboxEnv` 保留直接把配置值注入容器的回退路径，并打印警告。

### 1.3 沙盒（worker schema）

| 变量 | 必填 | 默认 | 读取方 | 说明 |
|---|---|---|---|---|
| `SANDBOX_IMAGE` | 否 | `agentport/sandbox:dev` | worker、api | 平台沙盒基座：worker 首次启动时本地缺失会先拉取，再用真实本地 image ID 登记默认环境的首个线上版本，并作为之后所有环境构建的基座；默认环境已存在时不再 inspect/pull。api 入队构建时记录该值。它不自动推进线上指针，也不是每次创建容器的直接来源（容器用环境线上版本的 image ID） |
| `WORKSPACES_DIR` | 否 | `./data/workspaces` | worker | 工作区根目录。compose 下为 `/workspaces`，必须与 api 同路径 |
| `HOST_WORKSPACES_DIR` | 否 | 同 `WORKSPACES_DIR` | worker | 宿主视角的工作区路径，`docker -v` 的源路径；compose 默认 `/var/lib/docker/volumes/agentport_workspaces/_data` |
| `SANDBOX_API_URL` | 否 | `http://host.docker.internal:3000` | worker、api（预览） | 沙盒视角的平台地址，写入 generated server 的 `.mcp.json` |
| `SANDBOX_EGRESS` | 否 | `open` | worker | `open` = bridge 直连（不隔离出站）；`proxy` = bridge + 容器内 `HTTPS_PROXY`；`none` = `--network none`。**fail-closed**：`proxy` 未设置 `HTTPS_PROXY`/`HTTP_PROXY` 时启动直接报错退出，不会降级为 `open` |
| `SANDBOX_MEMORY` | 否 | `1g` | worker | 容器内存上限（Docker 格式，如 `1g`、`512m`） |
| `SANDBOX_CPUS` | 否 | `1` | worker | CPU 核数上限 |
| `SANDBOX_PIDS` | 否 | `128` | worker | PID 上限 |
| `SANDBOX_IDLE_TIMEOUT_MS` | 否 | `300000` | worker | 会话沙盒无执行任务后的保留时间（毫秒）。执行中或等待用户回答不算空闲；只接受正整数，不支持 `0`/`-1` 无限保活，可用短阈值实测 |
| `SANDBOX_MAX_FIELD_BYTES` | 否 | `1048576` | worker | 沙盒单块文本/工具负载上限（字节）。超限只截断该块并随事件标 `truncated`，不再静默丢尾部。上限固定 1MiB：最坏 JSON 转义约 6 倍，仍落在 shared `SUPERVISOR_INPUT_MAX_BYTES`（8MiB，`packages/shared/src/sandbox-session.ts`，supervisor 输入/输出与 worker 侧协议共用）的单行上限内；配置超过 1MiB 时 worker 启动直接报错，不靠调高单行上限兜底。supervisor 协议帧超限按显式失败处理（输入 `INVALID_COMMAND`、输出本轮失败），不再静默丢弃 |

#### 会话沙盒生命周期

- 一个平台会话最多一个沙盒容器；同一会话的连续 run 短期复用，不同会话各自独立，不跨会话共享。
- 只有正常完成或成功取消、且本轮进程已确认停稳时保留容器。运行失败（failed/error）、超时或异常导致无法确认停稳、清理失败、运行结束前 release、镜像或挂载发生变化时都会销毁容器，避免复用仍在写入或状态不可信的容器。
- 销毁失败仍保留跟踪并阻止复用；后续获取该会话时先重试清理，确认旧容器删除后才重建，无需重启 worker；仍失败该请求失败。
- worker 现有沙盒模块负责空闲回收：没有执行任务且未在等待用户回答超过 `SANDBOX_IDLE_TIMEOUT_MS`（默认 5 分钟）后回收容器。该阈值是正整数，不支持 `0`/`-1` 保活，可用短值实测。
- 回收只删除容器，不删除宿主上的持久数据（`agent-memory/`、`sdk-sessions/<conversationId>/`、`conversation-outputs/<conversationId>/`、`conversation-inputs/<conversationId>/`）；后续 run 新建容器时从 `sdk-sessions` 与 `agent-memory` 恢复同一 SDK 会话与记忆。
- 容器内是常驻 supervisor，每轮启动新的 runner（新 SDK query）；复用只省容器创建与启动（缓存镜像基线约 122ms/次），不算也不承诺 SDK 冷启动优化。
- 会话级稳定目录为 `WORKSPACES_DIR/<slug>/session-sandboxes/<conversationId>/{workspace,outputs}`：`workspace` 渲染本轮官方定义后只读挂入 `/workspace`，`outputs` 可写挂入 `/mnt/outputs`，`/mnt/inputs` 始终挂载（会话目录即使本轮无附件也预建）。整个 `session-sandboxes/<conversationId>/{workspace,outputs}` 是可再生的派生缓存（`workspace` 每轮按数据库重渲染，`outputs` 停稳后复制进 `conversation-outputs`），不是不可丢失的持久交付；容器回收与关停不删除、也不 rename 该根目录，丢失后可由数据库与持久数据重建；删除会话时由 API 回收该会话目录。
- 每轮重新渲染官方定义并刷新到 `workspace`；运行专属 MCP 与模型凭证只进当轮 runner。运行结束时不论容器清理是否成功都吊销本轮 token；终态停稳后删除 `.mcp.json`，空闲容器不保留上一轮身份，下一轮重新渲染。
- `agent-memory/` 仍按智能体共享，不随会话隔离；只有 `sdk-sessions/<conversationId>/` 按会话隔离。
- `sandbox-probe` 试连与 `native-plugins` 安装仍使用一次性容器，不进入会话复用。
- 实现状态（2026-10-29）：session manager、supervisor、core 限定 review 与取消链路独立复审均通过，已发现阻断项修复并复核；最终联合回归 root backend 38 files 458 passed / 0 failed / 0 skipped（含真实 Docker 8 例与 SDK 4 例）。真实付费模型与浏览器全链路未测。详见 [任务记录](tasks/session-sandbox-lifecycle.md)。

### 原生记忆存储（native memory storage）

`WORKSPACES_DIR/<slug>/agent-memory/` 是原生 `MEMORY.md` 与主题 Markdown 的持久存储，独立于 `run_*` 工作区，run 结束与过期清理均保留。Compose 将同一 `workspaces` 卷以 `/workspaces` 挂给 API 和 worker；两者镜像及沙盒均使用 node（uid 1000），命名卷 init 保持 1000:1000。worker 创建目录为 0700 并收紧已有目录权限；创建目录或 chmod 失败会使 run 明确失败，不再吞错或改为 0777。

沙盒及 API/worker 都以 uid 1000 运行时，才能对 0700 记忆目录读写一致：请用 Compose 启动 API/worker。本地 `pnpm dev` 以宿主 uid 运行时仍可正常跑智能体，但原生记忆跨宿主 uid 与容器内 uid 1000 的 0700 目录可能不可写，记忆功能不保证；需要持久记忆时用 Compose。不要递归 chown 未核对的宿主目录，也不要以 0777 绕过错误。已有外部数据卷应先备份并确认属主后再启用。

runner 将目录挂到 `/mnt/agent-memory`，设置官方 `autoMemoryEnabled`/`autoMemoryDirectory`，通过 Read/Edit 的绝对路径许可与 SDK PreToolUse 双重约束，仅主会话可读写目录内普通 `.md` 文件。子智能体、软链接、硬链接、非普通文件、相对路径及越界请求均在检查时点拒绝。API 与沙盒访问同一存储；请把该目录单独纳入文件备份。专项测试不调用付费模型，真实跨 run 的自动写入、主题读取仍需模型验收。

### 会话成果存储

`WORKSPACES_DIR/<slug>/conversation-outputs/<conversationId>/` 保存会话成果：`drafts/<runId>/` 是本轮草稿，`runs/<runId>/{manifest.json,files/**}` 是发布后不可变快照。沙盒实际写入会话级稳定的 `session-sandboxes/<conversationId>/outputs`（`/mnt/outputs` 可写）；停稳后由 `captureOutputDraft` 复制回 `drafts/<runId>/`。复制不动源目录，也保留 `drafts/<runId>.base`、`drafts/<runId>.blocked` 与已发布快照的原有语义。它不属于 `run_*`，run 保留期清理不会删除；删除会话或专家时回收对应目录。`scripts/backup.sh` 备份整个 workspaces 卷，因此成果随工作区备份，不需要新增变量或独立存储。成果内容不做聊天密钥脱敏；读取与下载由 API 鉴权，路径/链接边界在存储层校验。

### 会话输入附件存储

`WORKSPACES_DIR/<slug>/conversation-inputs/<conversationId>/<attachmentId><ext>` 保存随消息上传的临时资料。发送时经 `POST /api/chat` 的 base64 JSON 写入（路由上限 16MiB）；每条消息最多 5 个文件，原件合计 ≤10MiB；文本 ≤1MiB，图片 ≤5MiB，PDF ≤10MiB。只接受 txt/md/csv/tsv/json/jsonl、PNG/JPEG/GIF/WebP 与未加密 PDF；Office/ODF、压缩包、音视频等请在知识库处理或转成文本。目录 0700、文件 0600，磁盘名只用服务端 UUID 与规范扩展名，原文件名仅作显示。

worker 预建该会话目录（即使本轮没有附件）并把整个目录只读挂到 `/mnt/inputs`，挂载始终存在且只指向当前会话目录；prompt 列出本轮文件并要求主智能体用原生 `Read` 读取；图片与 PDF 由 Read 原生处理。子智能体不能直接读文件；输入不可写，交付仍写 `/mnt/outputs`。附件按会话保留，分支只复制被复制消息引用的文件，删除会话或专家时回收目录；run 保留清理会保留带附件的用户消息，因此历史下载入口不随旧 run 消失。

Compose 中 API/worker/沙盒同为 uid 1000，可直接读写这些 0700/0600 目录。Linux 宿主以其他 UID 直跑 `pnpm dev` 时，沙盒以 1000 运行将无法读取附件（与原生记忆的既有 UID 限制相同）；需要附件时请用 Compose 启动，不要递归放宽目录权限。

Compose 将同一 `workspaces` 卷以 `/workspaces` 挂给 API 与 worker，两者看到同一目录。本地 `pnpm dev` 时 API 与 worker 各自以包目录为 cwd 解析 `.env` 里的相对 `WORKSPACES_DIR`，附件、原生记忆与成果会分别落到两个目录；本地开发请把 `WORKSPACES_DIR` 设为同一个绝对路径（例如 `/abs/path/data/workspaces`），或改用 Compose。这与上面的 UID 限制同属本地启动方式带来的差异，不是附件功能本身的缺陷。

### 1.4 数据保留

| 变量 | 必填 | 默认 | 读取方 | 说明 |
|---|---|---|---|---|
| `RETAIN_RUN_DAYS` | 否 | `90` | worker | 已终态 run 及其消息的保留天数 |
| `RETAIN_MESSAGE_DAYS` | 否 | `30` | worker | 无 `run_id` 的孤立消息保留天数 |
| `RETAIN_AGENT_VERSIONS` | 否 | `50` | worker | 每个智能体保留的版本数 |

### 1.5 知识库（api/worker 共享目录与可信端点配置）

| 变量 | 必填 | 默认 | 读取方 | 说明 |
|---|---|---|---|---|
| `KNOWLEDGE_DIR` | 否 | `./data/knowledge` | api、worker | 原件 blob 与解析产物目录。宿主直跑用相对路径；compose 覆盖为 `/knowledge`（`knowledgedata` 命名卷） |
| `DOCLING_URL` | 否 | — | worker | Docling 服务 base URL；未设置时 PDF/Office/OCR 等格式明确报错。用内置服务时设 `http://docling:5001` 并 `--profile docling` 启动 |
| `DOCLING_TOKEN` | 否 | — | worker | 以 `X-Api-Key` 头发给 Docling；服务端用 `DOCLING_SERVE_API_KEY` 校验。compose 把同一变量同时喂给 `docling` 服务，留空即不启用鉴权 |
| `KNOWLEDGE_WIKI_MODEL` | 否 | — | worker | Wiki 生成使用的模型；未设置时 wiki 任务明确失败 |
| `KNOWLEDGE_PRIVATE_HOST_ALLOWLIST` | 否 | 空 | api、worker | 逗号分隔的精确私网主机（可含端口）；仅部署白名单端点放行，用于自建GitLab和模型服务，不是用户可配置的通用私网开关 |

`.env.example` 与本表一致；schema 之外可用的变量（`PLATFORM_MCP_TOKEN`、`RATE_LIMIT_DISABLED` 等）已在上方「不在 schema 中」表中列出。

图片多模态复用 worker 的现有 `ANTHROPIC_*` 凭据/网关；在知识库「设置」启用图片处理，填写网关支持视觉输入的模型 ID，并开启 OCR 和/或图片描述，不新增独立视觉服务环境变量。默认将识别文字/描述纳入普通检索；独立 PNG/JPEG/GIF/WebP 不必先经 Docling。文档内插图仍依赖 Docling 实际返回图片字节，需用目标解析服务验收。

可选图片向量需要新建 Cohere v2 的 `embed-v4.0` embedding profile（Endpoint URL 为含 `/v2` 的根地址），启用该 profile 的图片输入，再在库设置开启图片向量。固定1024维，必须使用同一模型的文本/图片编码；普通 OpenAI embedding profile 不支持此选项。更换已引用模型需新建 profile 后完整重建，不能仅补缺失向量混用空间。图片描述失败/向量降级可查看任务错误与版本图片 warnings；真实服务质量/费用不由本地协议测试保证。

## 2. 部署

### 2.1 前置

- Node.js 24（要求 24 的最新补丁版本；`engines` 为 `>=24`）、pnpm 12.15.0
- pnpm 12 默认不跑依赖的安装脚本，决定写在根 `pnpm-workspace.yaml` 的 `allowBuilds`：放行 `esbuild`、`msgpackr-extract`，拒绝 `@openuidev/lang-core`（其 postinstall 只上报匿名安装遥测）。新增带安装脚本的依赖时在这里补决定，否则 `pnpm install` / `deploy` 以 `ERR_PNPM_IGNORED_BUILDS` 失败。
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
2. `docker compose up -d --wait --wait-timeout 120 postgres redis`，按 compose healthcheck 等两者就绪；失败时打印状态与日志。
3. 从仓库根构建沙盒镜像 `agentport/sandbox:dev`（已存在则跳过；`pnpm run up --rebuild` 强制重建）。步骤见下文「2.2.1 手动构建沙盒镜像」。
4. `docker compose up -d --build --wait --wait-timeout 120 api worker`。compose 会先运行一次性服务 `migrate`（`node api/node_modules/@agentport/db/scripts/migrate.js`，`restart: no`），成功后 api 才启动（`depends_on: service_completed_successfully`）；`--wait` 继续等 api 的 `/health/ready` healthcheck 通过。
5. 执行 `bash scripts/smoke.sh`。

任一步失败会打印相关容器状态或日志，并以非零退出。停止服务用 `pnpm run down`（`docker compose down`，保留卷）；`pnpm run down --clean` 使用 `down -v` 删除数据卷。

检查：

```bash
docker compose ps
curl -s http://localhost:3000/health/live
curl -s http://localhost:3000/health/ready
```

`/health/ready` 返回 `{"status":"ok","db":"ok","redis":"ok"}` 即依赖就绪。

说明：

- compose 的 api/worker 镜像与 `sandbox` target 都在镜像内执行安装与 `pnpm -r build`（sandbox 再用 `pnpm deploy --prod` 打包），不依赖宿主 `dist` 或暂存目录。
- 迁移由 compose 的 `migrate` 服务自动执行；直接在宿主机操作时仍可用 `pnpm db:migrate`（需要 `packages/db/dist`，先 `pnpm build`）。
- `.env.example` 的 `REDIS_URL` 带 `agentport-dev` 密码，与 compose 的 redis 默认密码一致；若宿主导出了不同的 `REDIS_PASSWORD`，两边都要改。`pnpm run up` 生成 `.env` 时会同时写入匹配的 `REDIS_PASSWORD` 与 `REDIS_URL`。
- compose 会占用 3000、5432、6379；如冲突，先停掉本机对应服务或改端口。
- 知识库卷 `knowledgedata` 与 `workspaces` 一样由一次性 `init` 服务 `chown 1000:1000`（镜像 `USER node`，即 uid 1000），否则 api/worker 首次上传会 EACCES。卷内容随 `pnpm backup` 的 `knowledge/` 归档；`docker compose down -v` 会连同知识库一起删除。
- 复杂格式解析默认不部署：需要时 `docker compose --profile docling up -d docling`，并把 `.env` 的 `DOCLING_URL` 设为 `http://docling:5001`。不内置时指向外部 Docling 服务即可，`DOCLING_TOKEN` 通过 `X-Api-Key` 发送。当前配置 Docling Serve 1.38.2（tag/digest 见 `docker-compose.yml`，该镜像已预装解析模型，无需首次下载）。本轮已用该固定镜像在独立容器中验证真实 PDF 的文本、图片与表格解析、纯图片 PDF 的 OCR 开关、200/401/损坏文件的 failure 返回；镜像预装 rapidocr，无运行时模型下载。来源 pageMap 的两处缺陷已修复并经 Opus review 通过：真实响应回放确认表格 chunk 的 pageFrom 为 2、短 OCR 不侵入数字、CRLF 与多段 JSON 区间均回归通过，详细范围见任务记录。范围限于独立容器直连 Docling，`--profile docling` 的 compose 路径未实际拉起；Office 格式本轮未实测，不声称已验证；仅标题 OCR 文本在 chunk 丢失的缺陷已修复并在工作分支验证通过（真实响应回放 1/1），尚未合入 main，见 [任务记录](tasks/real-runtime-acceptance.md)。compose 的 `DOCLING_SERVE_MAX_SYNC_WAIT` 为 `600`，与客户端 10 分钟超时对齐。未配置 `DOCLING_URL` 时 PDF/Office/OCR 解析会明确报错，而不是假装成功。
- 基础设施版本：Redis 8.10.3（compose 的 `redis` 服务，tag/digest 见 `docker-compose.yml` 与 CI）；是否已启动以当次 `docker compose ps` 为准，本文不代替运行状态。
- worker 容器内是 `node` 用户，通过 `group_add: ${DOCKER_GID:-0}` 访问 socket。Linux 上若 docker 组 GID 不是 0，部署前 `export DOCKER_GID=$(getent group docker | cut -d: -f3)`。
- Redis 健康检查（compose 里的 `healthcheck.test`）在容器内使用 redis 服务自身的 `REDIS_PASSWORD`；若宿主另行导出 `REDIS_PASSWORD`，compose 会用它重建 redis，与 `.env` 的 `REDIS_URL` 不一致时 api/worker 连不上。`pnpm run up` 不读取宿主导出的该变量，直接使用 `.env`。
- 生产通过 `http://localhost:3000` 访问；Cookie 带 `Secure`，局域网 IP + HTTP 会无法保持登录。

#### 2.2.1 手动构建沙盒镜像

沙盒镜像与 api/worker 共用根 `Dockerfile`，**必须从仓库根 context 构建 `sandbox` target**；依赖安装、`pnpm -r build` 与 `pnpm deploy --prod` 都在镜像内完成，不需要先在宿主构建 `dist`，也不再把 shared 复制到 `packages/sandbox`。

推荐直接用脚本：

```bash
pnpm run up --rebuild
```

手动等价步骤：

```bash
docker build --target sandbox -t agentport/sandbox:dev .
# 或使用包脚本（同样从仓库根 context 构建）：
pnpm --filter @agentport/sandbox image
```

- 镜像构建期验证 `dist/runner.js` 存在、Agent SDK 原生 CLI 可执行，并确认 `bash` 是 GNU bash、`pdftoppm`/`pdfinfo` 可用；`deploy` 输出已包含生产依赖与 workspace 包（含 `@agentport/shared` 的 `dist`）。
- `runtime` target 额外安装 `docker-cli` 与 `docker-cli-buildx`，只服务 worker 的宿主 Docker 调用和运行环境构建，不进入 `sandbox` 基座。
- 不再有 `package.shared.json` / `package.docker.json` 或 `packages/sandbox/.dockerignore`；旧版 `packages/sandbox/shared` 暂存目录也已删除。
- 根 `.dockerignore` 排除 `.git`、docs、data、`node_modules`、`dist` 等；镜像内重新安装和编译，`packages/sandbox/shared` 即使残留也不会进入构建上下文。
- 反向代理之后部署时，设置 `TRUST_PROXY=1`（否则限流按代理 IP 计数），并把 `CORS_ORIGINS` 改成浏览器实际访问的 Origin。

#### 2.2.2 运行环境构建、发布与回退

命名运行环境在「运行环境」页维护 Dockerfile、提交构建并设置线上版本；对应 API：

- `POST /api/runtime-environments` 新建环境；`POST /api/runtime-environments/:id/versions` 用当前 Dockerfile 快照入队构建（202），`GET /api/runtime-environments/:id/versions/:versionId` 查看状态与日志。
- `PUT /api/runtime-environments/:id/online-version` 发布或回退；构建成功不会自动发布，失败构建不改线上指针。
- 构建由 worker 的独立队列消费，并发 1，失败不自动重试。上下文只含冻结 Dockerfile；基座解析为本地 image ID 后经 `ARG RUNTIME_BASE_IMAGE` 传入，默认复用 BuildKit 层缓存。
- 构建日志按 1 秒或 16 KiB 窗口流式写库，只保留 64 KiB 尾部并置 `log_truncated`；日志落库失败时版本收敛为 `failed`，不会标成 `ready`。
- 构建成功前在真实容器约束下校验：拒绝镜像声明的任何卷，实际启动四个入口到各自协议边界，执行 SDK 原生 CLI `--version`，并确认 PATH 上有 Bash。
- 只有新建容器才解析智能体所属环境的线上版本；存活容器跨发布保持旧镜像，消亡后重建才用当前线上版本。没有线上版本或本地缺失对应镜像时明确失败，不隐式 pull、不回落其他环境。
- worker 容器必须能执行 `docker buildx build`。旧 worker 镜像没有 buildx 插件时构建失败，需按当前根 Dockerfile 重建 worker；不重启正在使用的服务。

本地验证先构建依赖，不跑固定全量：

```bash
pnpm --filter @agentport/shared --filter @agentport/core --filter @agentport/db build

pnpm exec vitest run --project backend \
  packages/shared/test/runtime-environment.test.ts \
  packages/db/test/runtime-environments.test.ts \
  packages/worker/test/runtime-environment-build.test.ts \
  packages/worker/test/runtime-environment-reconcile.test.ts \
  packages/worker/test/runtime-environments-resolve.test.ts \
  packages/api/test/runtime-environments.test.ts \
  packages/api/test/agent-package-runtime-environment.test.ts

pnpm exec vitest run --project web packages/web/test/runtime-environments.test.ts
```

需要宿主 Docker 的真实构建/校验用例按当次环境单独执行；缺少本地基座镜像或 Docker 时整组跳过，跳过不等于通过：

```bash
# 真实构建缓存、镜像卷/入口/Bash/SDK CLI 校验
pnpm exec vitest run --project backend \
  packages/worker/test/runtime-environment-build-docker.test.ts \
  packages/worker/test/runtime-environment-verify-docker.test.ts

# 线上指针 + 存活容器跨发布/回退 + 重建的真实 lifecycle 证据
# 需本地基座 agentport/sandbox:runtime-env-bash-20261029（可用 RUNTIME_ENV_LIFECYCLE_BASE 覆盖）与可用 Docker
pnpm exec vitest run --project backend packages/worker/test/runtime-environment-lifecycle-docker.test.ts
```

backend 套件由 globalSetup 在随机 PostgreSQL 库和临时 Redis 上运行，不触碰开发库登录态；是否通过以当次命令输出为准，不能据此声称全部通过或已上线。

#### Docker socket 风险

worker 挂载 `/var/run/docker.sock`，**等价于把宿主 root 权限交给 worker 容器**：任何能控制 worker 的漏洞或恶意智能体镜像都可以启动特权容器、挂载宿主目录。当前实现只适合单机自用、只运行自己配置的智能体。

生产替换方案（按投入从低到高）：

1. **socket proxy**：在宿主前置 `tecnativa/docker-socket-proxy` 之类只放行 container 相关 API 的代理，worker 通过 `DOCKER_HOST` 连接它，不再直接挂 socket。
2. **独立沙盒节点**：worker 通过远程 Docker（`DOCKER_HOST` + TLS）或 microVM 运行时连到隔离主机，平台主机不暴露 socket。
3. **换运行时**：microsandbox / gVisor 等不依赖宿主 Docker 的实现（`SandboxProvider` 接口已预留，见 D-12）。

**当前决定（2026-10-20）**：单机自用场景保持直接挂载 socket，不做 proxy。
开始处理不受信内容、引入多用户、或与其他服务共用机器时，按 D-16 列出的触发条件升级到 B/C/D。

### 2.3 本地开发

```bash
pnpm install
pnpm build
cp .env.example .env
docker compose up -d --wait postgres redis
pnpm db:migrate
# 见上文「2.2.1 手动构建沙盒镜像」：从仓库根构建 sandbox target，安装与构建都在镜像内
docker build --target sandbox -t agentport/sandbox:dev .
pnpm dev
```

- web: [https://agentport.localhost](https://agentport.localhost)（Portless 分配随机端口，实际 URL 以启动输出为准；Vite 代理 `/api`、`/health` 到 [http://localhost:3000](http://localhost:3000)）
- 在 worktree 中运行时 Origin 是 `https://<worktree>.agentport.localhost`：`CORS_ORIGINS` 同时保留精确基地址与 `https://*.agentport.localhost` 通配符即可，一次配置覆盖后续变化的子域名；通配符仅匹配 HTTPS 默认端口
- api: [http://localhost:3000](http://localhost:3000)（不变）
- worker、沙盒与 Docker 网络不变；沙盒仍通过 `host.docker.internal:3000` 回连 API
- 首次运行 `pnpm dev` 会请求 sudo 安装本地 CA 并绑定 443，状态在 `~/.portless`，之后无感
- Postgres/Redis 的 5432/6379 与 worker 的 `MODEL_PROXY_PORT=3426` 仍是固定端口
- `pnpm run up`（compose，生产地址仍为 3000）路径不变；Portless 只在本地 `pnpm dev` 启动 web 时使用

按所需最小进程启动：只验收前端、且后端已在运行（compose 或另一 worktree）时，在当前 worktree 运行 `pnpm --filter @agentport/web dev` 即可（web 引用 shared/core 的 `dist`，先 `pnpm install` 并构建这两个包），地址同样取 Portless 输出；不必重复起 api/worker。后端尚未运行时仍需停掉 compose 的 api/worker（`docker compose stop api worker`）后跑完整 `pnpm dev`；依赖（postgres/redis）保持运行。

多 worktree 共用同一套 API、数据库与 Redis，前端单独启动不提供后端隔离；不同任务的数据会互相可见（见 [PITFALLS.md](PITFALLS.md)）。

### 2.4 原生插件安装

插件页的「从市场安装」调用 Claude Code 官方 `plugin install`，由 worker 在独立 Linux 沙盒中执行。需要 worker、Redis、Docker 和包含 `dist/native-plugins.js` 的新版沙盒镜像；仅启动 API 时可以使用已纳入插件库的定义，无法执行新的安装任务。

安装器缓存保存在 `WORKSPACES_DIR/plugin-cache/`，以可写目录挂入安装沙盒，配置和下载目录都与宿主个人 `~/.claude` 分离。「已安装」只列平台自己的缓存，选择「加入插件库」不重新安装或下载。不要在运行中的安装任务期间手工删除该缓存。

插件加入现有插件库后在 DB 保存一次，各专家仍按绑定生成自己的运行文件，安装缓存不挂载给专家。hooks/MCP 的逐专家授权继续在运行文件渲染时生效。现有文本插件限制同样适用；不支持的二进制、运行依赖或组件应明确报错，不视为全部原生插件生态兼容。

新部署需应用来源字段迁移并重建 sandbox 镜像（见 §2.2.1）。升级前已下载的插件可从平台缓存重新加入，ZIP 导入保持可用。

### 2.5 升级

```bash
git pull
pnpm install
pnpm run up --rebuild
```

`pnpm run up` 会重新构建镜像并由 compose 的 `migrate` 服务应用迁移；沙盒镜像仅在传 `--rebuild` 时重建。worker 升级会中断进行中的 run 和运行环境构建（容器随 `docker rm -f` 清理）；建议在空闲时操作。

**关停顺序**：api 收到 SIGTERM 后先关闭队列 producer 与 SSE 订阅，再 `app.close()`，并把它与超时竞速，最后强制关闭残留 socket；compose 为 api/worker 设了 `stop_grace_period: 30s`。worker 先禁止新的沙盒创建并取消镜像拉取，等待已发出的创建请求收尾后清理容器；单项清理失败仍继续关闭其余资源，记录错误并以非零状态退出。执行已经完成后的清理失败不改写业务结果或触发模型重试。reconciler 会收敛仍为 running 的 run。因此 `docker compose stop api worker` 宁可多等几秒，不要 `kill -9`。

## 3. 备份与恢复

### 3.1 备份

```bash
pnpm backup
```

`scripts/backup.sh`（共享实现见 `scripts/backup-lib.sh`）生成一个完整包：`backups/<YYYYMMDD-HHMMSS>.tar.gz`（0600）。

包内容：

| 成员 | 内容 |
|---|---|
| `database.dump` | `pg_dump --format=custom` 的一致性快照（不带 `--clean`，由恢复侧 `pg_restore --clean` 替换） |
| `workspaces/` | 持久工作区，排除每次 run 重建的 `<slug>/run_*`；含 `agent-memory/`、`sdk-sessions/`、`conversation-inputs/`、`conversation-outputs/` 与 `session-sandboxes/`。`session-sandboxes/` 的 `workspace`/`outputs` 是可按会话再生的派生缓存，随包备份但不视为不可丢失的持久交付 |
| `knowledge/` | 知识库原件 blob 与解析产物；从未启用知识库时该成员不存在，manifest 记 `knowledge: null` |
| `env` | `.env` 副本（0600），恢复主密钥与模型凭证 |
| `manifest.json` | 格式版本、数据库/配置/工作区/知识库的 sha256、字节数与文件数；不含任何密钥或连接串 |

行为要点：

- 数据库客户端按需选择：宿主 `pg_dump` 主版本匹配时用宿主，否则走 `docker compose exec -T postgres`；`PG_CLIENT=host|container|auto` 可强制。
- 工作区按 `BACKUP_WORKSPACES_DIR` → `HOST_WORKSPACES_DIR` → 运行中的 compose 服务 → compose 卷 → 宿主默认目录依次定位，不假定数据在 `./data/workspaces`。
- 知识库与工作区同一套定位方式：`BACKUP_KNOWLEDGE_DIR` → `knowledgedata` 卷 → `KNOWLEDGE_DIR` → `.env` 的 `KNOWLEDGE_DIR`。卷存在但宿主路径不可读时（macOS Docker Desktop 的命名卷目录不在宿主文件系统里），改走 `docker compose exec -T api tar`（服务在跑）或 `docker compose run --rm --no-deps api tar`（服务已停），不假设卷路径宿主可见。
- **知识库已配置却读不到时备份直接失败**（`cannot read knowledge storage`），不会写成 `knowledge: null` 瞒过恢复；只有确实没有目录/卷、或目录为空时才记 `null`。
- 有其他数据库连接时打印警告（快照仍一致，但文件与数据库可能略微不同步）；要求完全对齐时先停 api/worker。
- 先写临时文件，`gzip -t` 后再用恢复侧同一套 `validate_archive` 校验，最后原子改名发布；任一步失败删除临时文件并以非零退出。
- 只保留最近 `BACKUP_KEEP`（默认 7）个 `*.tar.gz`；`pre-restore-*` 安全副本不参与清理。
- 设置 `RESTIC_REPOSITORY` 时，在本地包发布后执行 `restic backup --tag <format>`、`forget --keep-last $BACKUP_RESTIC_KEEP --prune`、`check`；任一步失败返回非零但保留本地包。加密与仓库密码完全交给 restic 的 `RESTIC_PASSWORD`/`_FILE`/`_COMMAND`，脚本不另存秘密。

可用变量：`BACKUP_DIR`、`BACKUP_ENV_FILE`、`BACKUP_WORKSPACES_DIR`、`BACKUP_KNOWLEDGE_DIR`、`BACKUP_KEEP`、`BACKUP_RESTIC_KEEP`、`PG_CLIENT`、`WORKSPACES_CONTAINER_DIR`、`KNOWLEDGE_CONTAINER_DIR`。

建议用宿主机 cron 每天执行：

```cron
15 3 * * * cd /path/to/agentport && pnpm backup >> backups/cron.log 2>&1
```

`backups/` 与完整包都含密文密钥与会话数据，按敏感文件保护并使 restic 或同步盘保持 0600/0700。

### 3.2 恢复

```bash
docker compose stop api worker
pnpm restore backups/<YYYYMMDD-HHMMSS>.tar.gz
docker compose start api worker
```

`scripts/restore.sh` 的行为：

1. 校验归档（格式版本 2；旧版归档需重新备份）：必须是本格式的 `tar.gz`，成员只能是 `manifest.json` / `database.dump` / `env` / `workspaces/**` / `knowledge/**`；拒绝绝对路径、`..`、控制字符、重复成员、符号链接/硬链接/设备文件、旧 `.sql.gz`，以及超出 `MAX_RESTORE_BYTES` 的包。解压后再按 manifest 校验 sha256（含工作区与知识库内容指纹）、字节数与文件数。
2. compose 的 api/worker 仍在运行时直接拒绝（脚本不替你停共享服务）。
3. 先写 `pre-restore-<ts>.tar.gz`（当前数据库 + 工作区 + 知识库 + 配置）和 `pre-restore-<ts>.env`；任一步失败即中止，不改动任何目标。当前知识库已配置却读不到时同样中止，不留一个缺知识库的回退点。
4. `pg_restore --clean --if-exists --single-transaction --exit-on-error`：数据库失败整体回滚，库保持原样。
5. 恢复 `env`（可用 `RESTORE_ENV_TARGET` 改路径；`--target-workspaces` 旁路验证默认不改配置），再按“暂存 → 权限收紧 → 顶层换入”恢复工作区，保留现有 `run_*`（`session-sandboxes/` 属普通工作区内容随包换入，是可再生的会话派生缓存）；知识库用同一套换入（宿主目录在宿主执行，`knowledgedata` 卷用一次性容器），最后执行 `pnpm db:migrate`。

要点：

- **数据库目标只来自调用环境**（`DATABASE_URL`，或 `BACKUP_ENV_FILE` 中的值）；归档内的 `env` 不参与任何数据库操作，仅用于恢复配置。
- 文件恢复在数据库提交之后；若文件换入失败会明确说明「不是完整回滚」，不会谎报成功。
- `--target-workspaces <空目录>` 可把文件恢复到旁路目录做验证，不碰当前工作区；`--target-knowledge <空目录>` 把知识库恢复到隔离目录（即使真实部署用命名卷），两者可同时使用。
- 只给 `--target-workspaces` 时知识库不恢复，避免演练覆盖线上知识卷；要一起验就同时给 `--target-knowledge`。
- 容器卷模式下换入会在目标卷里做「暂存 + 按顶层换入」，中断时尽力回滚；api/worker 必须先停。
- 新机器上恢复知识库前，先让 compose 建出 `knowledgedata` 卷（`docker compose create` 或先启动过一次），再执行 `pnpm restore`：卷还不存在时脚本会按 `KNOWLEDGE_DIR` 落到宿主目录，随后启动的容器读的却是空卷。
- 保持原来的 `APP_SECRET_KEY`。换了主密钥，`servers.secrets_encrypted` 无法解密，所有 MCP 密钥需重新填写。
- restic 恢复本身不由脚本执行：按需 `restic restore latest --target <dir>` 取回完整包后再运行 `pnpm restore`。

### 3.3 其他数据约束

- 集成测试使用固定APP_SECRET_KEY，测试默认不再读写开发数据库：backend 的 globalSetup 每轮以 `DATABASE_URL` 为管理连接创建随机库并完成迁移，`setupFiles` 在测试模块导入前把连接串写入 `process.env.DATABASE_URL`，退出时只删除本轮创建的库。PostgreSQL 连不上时发布不可连地址，依赖数据库的套件跳过；管理账号需有 `CREATEDB` 权限，连接成功但建库或迁移失败（含无建库权限）属配置错误，直接报错而不跳过。
- 测试 Redis 同样每轮独享：globalSetup 复用已缓存的 Redis 镜像（tag 以 `packages/worker/test/global-setup.ts` 的 `REDIS_IMAGE` 为准）启动临时容器（仅 loopback 随机端口、关闭持久化，实例内部仍用 db 9），退出时按本轮唯一容器名删除。本地需预先缓存该镜像（首次可显式 `docker pull redis:8.10.3-alpine@sha256:896f241f438ab6a210cfb24f573b84bea721a4cbe67f1b4fd07eb638b3b02a7b`，须与 `REDIS_IMAGE` 完整一致），镜像缺失属配置错误直接失败；只有 Docker 不可用时依赖 Redis 的套件才跳过。开发与各 worktree 的 worker 留在共享 Redis db 0，因此「队列里没有消费者」类断言不会被别人的 worker 干扰；禁止回落到共享 Redis，也不要为此停开发 worker。
- URL中不能写username/password；新建、编辑和两类导入均拒绝。旧记录在列表/导出/预览显示掩码，测试连接会在传输前返回固定错误；数据库不自动改写。需改为无内嵌凭证的URL并在加密headers中配置认证后保存，详见D-33。
- 连接器页「导入 .mcp.json」接受≤1MiB、1–100条HTTP/stdio配置；env/headers加密保存，响应只给密钥键名。任一重名整批409不覆盖；未知字段、未支持transport、`${VAR}`占位符及URL内嵌凭证明确拒绝。HTTP仍校验SSRF；导入不测试连接或执行命令，详见D-32。
- 专家页「导入」同时接受专家JSON与≤128KiB的agent.md。Markdown只导入name/description/model/maxTurns/effort及完整正文（含H1），创建独立专家与初始版本；重名409不覆盖，不自动运行。权限和绑定使用平台默认值并提示，inherit及未支持的权限/Hook字段明确拒绝，详见D-30。
- 技能页「导入 SKILL.md」接受≤128KiB文件，解析官方YAML frontmatter的name/description与Markdown正文；首个H1用作显示名。重名返回409且不覆盖；license/compatibility/metadata会提示未保存，尚未接入的Hooks/工具权限/model等行为字段会明确拒绝。保留当前项目500字符描述及命名规则，超限不截断。
- 审计加载更多使用beforeId记录游标，数据库按原始(created_at,id)比较，同一时间超过一页也不漏记录；before继续表示独立时间范围。游标记录被清理后需刷新；审计导出共用过滤，仍以1000条为上限，超限拒绝。
- 概览窗口与专家Token总量在加法前转bigint、汇总后转JSON数字，避免int32溢出；单条25亿和累计30亿已验证，超过JavaScript安全整数上限2^53-1的累计不保证精度。
- 运行历史展开后可「导出结果」，仅终态开放，包含已记录的用例文本、输出与通过情况；最多500条且≤1MiB，超限明确拒绝。agentport/eval-run@1标记configurationPinned=false，专家配置未冻结，文件不构成完整复现包；提示词可能包含敏感内容，分享前自行检查，详见D-38。
- 会话详情接口支持limit（默认50、最大100）与before消息ID，返回按时间正序的最近一页和nextBefore；nextBefore为null表示没有更早消息。未知/其他会话游标返回400，历史被清理后应刷新重新加载；分支复制、评估与平台调用的内部历史读取仍完整，详见D-40。
- worker持久化输出时按专家→会话→运行锁序检查running；终态先提交则不追加/替换晚到输出，已有历史保留。落库先完成则取消等待其提交；这不撤回已发出的SSE或外部请求，详见D-41。
- 同一会话已有queued/running时，聊天提交返回409并保留既有运行；等待完成或取消后重发。会话行锁保证HTTP入场互斥，历史和用户消息同事务写入；不同会话继续并行，既有重复运行不自动清理，详见D-39。
- 评估页可导入/导出 `agentport/eval@1` JSON，只含用例name/prompt/expectation和导出时间；显式选择目标专家，同名跳过并告警。单文件≤500条且≤1MiB，导入不启动评估；超限导出留在页面提示错误，不截断。导入与单条CRUD并发不承诺名称全局唯一，详见D-24。
- 单个技能可在资源中心「技能 → 操作 → 导出 SKILL.md」下载；内容与专家工作区预览一致。安装到其他 Claude Code/Agent SDK 工作区时，放到 `.claude/skills/<frontmatter中的name>/SKILL.md`；这是单文件下载，不是完整工作区或支持资源目录包。
- 专家包是官方 `.claude/` 目录的 ZIP（`application/zip`），下载名为 `<slug>.zip`；包内 `CLAUDE.md`、`.mcp.json`、`.claude/settings.json`、`.claude/agents/*.md`、`.claude/skills/**`、`.claude/rules/*.md`、`.claude/output-styles/*.md` 是定义正文的唯一来源。根 `agentport.json` 只存官方文件表达不了的平台元数据（显示名、slug、预算/超时、密钥键名、generated 连接器托管定义及子定义自有规则等），不复制正文；删掉它后目录仍可作为普通官方目录加载。旧 `agent@1`/`agent@2` JSON 不再接受。
- 专家包导入使用同一 ZIP；没有 sidecar 时用请求参数 `slug`/`name` 补标识。限制与校验：ZIP ≤1MiB、解压总量 ≤4MiB、条目 ≤6000，先读中央目录再解压；拒绝绝对路径、`..`、反斜杠、重复成员、符号链接与未知顶层路径；连接器密钥只以键名出现，导入后需重新填写；generated 端点在目标实例按新 id 重建。导入不调用模型、不测试连接、不执行工具。

### 3.4 恢复演练记录

新格式尚未做真实库/工作区卷的完整备份→恢复演练（数据库与 `workspaces` 卷仍缺实测）。演练前不要把它当作已验证的灾难恢复路径。

2026-10-25 在 macOS Docker Desktop 上做了**知识卷**实测（临时项目名 `agentport-kn-drill-*` 与临时命名卷，只写自造测试文件，未读主应用数据）：

- 命名卷的 `Mountpoint` 是容器内路径（`/var/lib/docker/volumes/.../_data`），宿主不可读 → 脚本判定 `mode=run`，通过 `docker compose run --rm --no-deps --entrypoint tar` 读出 2 个文件，`knowledge_tar_out` 得到正确的 `./blobs/...`、`./docs/...` 成员。
- 同一模式下 `knowledge_swap` 在容器里完成换入，卷内 `blobs/ab/abcdef` 内容变为恢复源的新内容。
- 临时卷与网络演练后删除。

2026-10-20 的旧 `.sql.gz` 演练与当前 tar.gz 包格式不兼容，结论不再适用，已删除。

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

- 评估历史「比较运行」选择同专家两个终态批次，按结果快照中的用例ID对齐；仅在两边都有快照且prompt/expectation相同时显示改善/退步。输入变更、旧记录或重复身份另标；单边无结果也可能是批次未执行完成，不代表用例增删。专家配置未固定，比较不等于完整可复现。
- 评估页「停止后续用例」将批次置为cancelled并保留已有结果；重复请求幂等，晚到进度/完成不能覆盖。当前用例可能仍执行至完成或超时并产生费用，停止不等同于即时终止沙盒，不提供恢复。迁移0023扩展eval_runs状态约束。
- 评估提交时冻结本次用例数组与total；worker按冻结的提示词/期望执行，结果保留原文，后续编辑或删除用例不会改写新批次历史。迁移0022新增eval_runs/eval_results的case_snapshot列；旧记录不回填，专家配置/技能/连接器仍未冻结。
- 评估批次列表 `GET /api/eval/runs?agentId=&cursor=&limit=` 返回 `{items,nextCursor}`：`limit` 默认 50、最大 100，游标取当前页末条 ID，按 `(created_at,id)` 倒序排他翻页；游标不属于当前筛选范围（不存在或跨专家）返回 400 `INVALID_INPUT`。列表 SQL 只投影摘要列；迁移 `0037` 用 `(agent_id,created_at,id)` 与 `(created_at,id)` 复合索引支持按专家或全局倒序分页，替换冗余的专家单列索引。详情仍按单批次读取，不参与列表分页。
- `/chat?agent=<id>&conversation=<id>`保留专家和会话选择；刷新、前进后退恢复已保存历史，服务端会话归属优先于链接中的专家参数。新建会话清除conversation，首次发送获id后replace写入URL；链接本身不创建运行、不恢复SDK会话。浏览其他历史只关闭客户端事件流，不等同取消服务端运行；离开后的迟到提交响应不会把界面拉回，运行结束后会刷新会话及历史列表缓存。
- 对话历史的操作菜单支持重命名持久化会话：标题去除首尾空白、1–128字符；只更新标题，不修改消息、归属或最近消息时间。脏草稿退出须确认，提交中不可关闭。
- MCP上游执行每API进程4槽、排队最多8项，满额返回可重试错误；审批等待独立4槽，满额立即返回需批准而非排队。握手/SSE/平台invoke不占上游槽，invoke仍保留既有4并发入场；多进程不共享全局容量，详见D-36。
- 工具审批只接受running状态的运行；API在事务内锁定运行行再批准，与取消/终态更新串行。queued及终态返回409，不写批准时间；重复批准保留首次时间。等待中的同一次MCP调用可继续，无需重发消息。聊天结束后停止审批轮询，终态详情只显示失效说明。
- 审批是有超时的调用内等待；0024新增expires_at，服务端返回waiting并区分当前等待与后续调用许可。过期批准仍可用于后续调用，不会恢复已超时的旧调用；截止前后都检查期限（包括读取批准状态之后）。期限不证明沙盒仍在线，不提供跨重启检查点；API与数据库时钟需保持同步。
- 事件流在 Redis 中保留 1 小时（`run:<runId>:events`，约 1000 条），首次回放按有界批次读取、累计不超过8MiB，并保持写入顺序；每个观众仍是独立订阅。展示增量（`text_delta`、块边界）与需落库的完整事件分开限额，增量超限只停止展示，不挤占完整消息的落库额度；完整事件超过保存上限时保留部分结果并明确失败（不可自动重试），取消、超时等既有非成功状态优先。保留裁剪或字节裁剪返回独立提示。裁剪运行结束后页面读取该run已保存步骤恢复本轮尾部，保留已加载旧历史；保存缺失或读取失败则保留部分输出并提示。过期流仍需从历史查看，不等于SDK会话恢复，详见D-50。
- 已订阅运行每2秒非重叠检查数据库终态：结束事件缺失时发terminal_missing标记后补终态，页面读取已保存步骤；若确认运行行已消失，则发run_unavailable并关闭，页面保留已接收文本、释放忙碌、不伪造结果。初次请求不存在仍404，数据库查询失败继续固定警告重试，详见D-58/D-60。
- 普通聊天入队失败只将仍queued的运行收口为failed/infra，用户消息保留，可重提；固定503及统一安全日志不附原始队列cause，认领/终态保留。数据库收尾失败可能等待既有协调清理，详见D-59。
- 连接器编辑与token轮换共用行锁内合并，避免并发覆盖或旧token复活；提交expectedUpdatedAt过期返回409且保留最新配置，版本时间至少前进一毫秒。省略版本仍是同字段后写优先，详见D-51。
- 终态 run 及其消息会被每日维护任务按 `RETAIN_RUN_DAYS` 清理；`/api/runs` 只展示仍保留的数据。
- 取消queued运行会写入终态并尽力移除等待job；worker若先认领则转入running取消路径，停止本轮执行。正常停稳时保留会话容器，无法确认停稳时才销毁；已发出的上游请求不保证撤回。
- 平台MCP的timeoutMs必须是正有限数，等待时间最长30分钟；截止会取消对应运行，不只断开等待。入队失败返回固定错误并仅将仍queued的运行收口为failed/infra，已认领或终态不被覆盖；数据库或Redis故障可能推迟清理，详见D-47。
- 评估入队失败返回固定503，仅收口尚未认领的running批次并尽力移除job；已认领或终态保留。数据库收尾失败时可取消或等待既有一小时清理；Redis命令故障可能推迟响应，错误日志不携带原始队列cause，详见D-56。

## 5. 故障排查

| 症状 | 可能原因 | 检查命令 / 处理 |
|---|---|---|
| `/health/ready` 返回 503，`db` 或 `redis` 为 `error` | 依赖未启动、连接串错误、容器不健康 | `docker compose ps`；`docker compose logs postgres redis`；`curl -s localhost:3000/health/ready`；确认 `.env` 的 `DATABASE_URL` / `REDIS_URL` 与实际端口一致 |
| `docker compose ps` 中 redis 一直 `health: starting`，api/worker 不启动 | 宿主导出了与 `.env` 不同的 `REDIS_PASSWORD`，compose 用它重建了 redis，而 `.env` 的 `REDIS_URL` 仍是旧密码 | `unset REDIS_PASSWORD` 后 `docker compose up -d --force-recreate redis api worker`；或让 `.env` 的 `REDIS_PASSWORD`/`REDIS_URL` 与导出的值一致；确认用 `docker compose exec redis redis-cli -a "$REDIS_PASSWORD" ping` |
| 日志报 `Could not find a working container runtime strategy` 或 `Cannot connect to the Docker daemon` | worker 无法访问宿主 Docker socket | 在 worker 容器内 `docker ps`；检查 `/var/run/docker.sock` 挂载与 `DOCKER_GID`（`ls -l /var/run/docker.sock`，`getent group docker`） |
| run 失败，错误含 `no such image` / `pull access denied` | 沙盒镜像未构建或名字不对 | `docker images agentport/sandbox`；`pnpm run up --rebuild`（或按「2.2.1 手动构建沙盒镜像」）；核对 `SANDBOX_IMAGE` |
| 新建会话报「运行环境 ... 没有可用的线上版本」 | 智能体绑定的环境尚未发布版本，或默认环境登记失败 | 在「运行环境」构建并设为线上；默认环境首次登记时本地缺失会先拉取 `SANDBOX_IMAGE`，已有默认环境不会因环境变量变化自动拉取或推进指针；不要手工改线上指针 |
| 运行环境构建报 `unknown command: buildx` | worker 镜像的 `runtime` target 未带 buildx 插件 | 用当前根 Dockerfile 重建 worker 镜像；旧镜像不会自动获得该插件 |
| 运行环境构建报基座镜像不存在或不可用 | `SANDBOX_IMAGE` 指向的本地基座缺失 | 按 §2.2.1 构建基座；构建不会隐式 pull，也不会改用其他镜像 |
| 发布/回退后运行中的会话仍用旧镜像 | 设计如此：线上指针只在新建容器时解析 | 需要新镜像时等容器空闲回收或被销毁后重建，不要期待发布替换存活容器 |
| 构建沙盒镜像报 `COPY package.json: not found` 或 `SDK native CLI is not executable` | 仍在用 `packages/sandbox` 作为构建上下文；或 `pnpm deploy` 未带入平台对应的 optional 原生依赖 | 从仓库根执行 `docker build --target sandbox ... .`；确认基础镜像平台与 SDK optional 依赖匹配，删掉旧构建缓存后重试 |
| 模型调用 401 / 403 | 凭证缺失、失效，或 `ANTHROPIC_BASE_URL` 在容器内不可达 | `docker compose logs worker` 看容器 stderr；确认 `.env` 只填了 `ANTHROPIC_API_KEY` 与 `ANTHROPIC_AUTH_TOKEN` 之一；`ANTHROPIC_BASE_URL` 不要写 `127.0.0.1`（worker 会改写为 `host.docker.internal`，Linux 需 Docker 支持该别名） |
| MCP 工具未出现在智能体上下文 | 未绑定 server、工具被禁用、绑定关系未保存，或 server 连接失败 | 「MCP Servers」页点「测试」看 `listTools()`；检查 generated server 的工具是否 `enabled`；「智能体 → 文件预览」确认 `.mcp.json` 含该 server；运行详情看拒绝原因（`permissionMode=dontAsk` 下未预批准会直接拒绝） |
| `mcp__<server>__tool` 被拒绝 | 允许规则写成了 `mcp__*`，或 server 名与绑定名不一致 | 规则由 worker 按 `.mcp.json` 的 server key 生成 `mcp__<name>__*`；不要手写 `mcp__*`；在文件预览核对 server key |
| 原生澄清提问被拒绝 | 智能体显式使用 `dontAsk`，或 `AskUserQuestion` 被禁用 | 官方 `dontAsk` 不触发 `canUseTool`，即使allow也拒绝需要交互的工具。需要澄清时显式选 `default`；本能力接入状态与验收见 `docs/tasks/agent-clarification.md`，不要把普通文本问句当同run挂起已接通 |
| 队列堆积，run 一直 `queued` | worker 未启动、并发占满、Redis 不可用 | 登录后看 `/health/metrics` 的 `queue.waiting/active`（需 Cookie）；`docker compose logs worker`；确认 `AGENT_MAX_CONCURRENT`；`docker compose ps worker` |
| SSE 无输出或立即断开 | 未登录（401 后前端跳登录）、反向代理缓冲、run 尚未开始、事件流已过期 | `curl -N -b "agentport_token=<token>" http://localhost:3000/api/chat/<runId>/events`；代理需关闭 buffering（代码已发 `X-Accel-Buffering: no`）；确认 run 状态不是 `queued`；事件流 TTL 为 1 小时 |
| generated server 在沙盒内 401 | `.mcp.json` 里的 `mcpToken` 与数据库不一致，或平台地址不可达 | 短期 token 只在 run 期间有效，run 结束后 401 属预期；外部客户端用长期 `mcpToken`（页面「轮换 token」后旧值立即失效）；确认 `SANDBOX_API_URL` 从容器可达（`docker run --rm curlimages/curl -s $SANDBOX_API_URL/health/live`） |
| 页面登录成功但刷新后退出 | 生产 Cookie 带 `Secure`，却用 HTTP + 非 localhost 访问 | 用 `http://localhost:3000`，或在明确可信的内网终止 TLS 后访问；不要把 `NODE_ENV` 改成 development 来绕过 |
| 修改 schema 后报 `column ... does not exist` | 只改了 `schema.ts`，未生成或未应用迁移 | `pnpm db:generate && pnpm db:migrate`；迁移文件按顺序应用，不要手改已应用的迁移 |
| 登录返回 429 | 登录限流 10 次/分钟（按 IP）；反向代理后未设 `TRUST_PROXY=1` 时所有请求共用代理 IP | 等一分钟；确认 `TRUST_PROXY=1`；只在本地/测试环境可临时 `RATE_LIMIT_DISABLED=1` 后重启 api |
| `pnpm backup` 报 `DATABASE_URL is required` | 脚本不读取 `.env` | `set -a; . ./.env; set +a; pnpm backup` |
| `pnpm backup` / `pnpm restore` 报 `pg_dump`、`psql` 或 `docker compose` 找不到 | 宿主既没有 PostgreSQL 客户端，也不在项目目录运行 | 在项目根目录运行；安装 `postgresql` 客户端，或保持 compose 的 postgres 容器运行 |
| `pnpm backup` 报 `cannot read knowledge storage` | `knowledgedata` 卷存在，但宿主挂载点不可读且容器方式也失败（Docker 未运行、服务不健康） | 启动 Docker 与 postgres/api 容器后重跑；本机直跑且没有卷时设 `BACKUP_KNOWLEDGE_DIR` 指向真实目录。不要为绕过它改成 `KNOWLEDGE_DIR=`（会把知识库漏出备份） |
| generated server 在沙盒内 401 | run 的短期 token 已过期/被清空，或 `.mcp.json` 未带上 `x-agentport-run-id` | 确认 run 仍为 `running`；不要手工改工作区文件；run 结束后短期 token 必然失效，属预期 |
| worker 退出并报 `Invalid environment` | `.env` 缺少必填项或长度不足 | 按报错里的字段名补齐；`APP_SECRET_KEY`、`JWT_SECRET` ≥32，`ADMIN_PASSWORD` ≥12 且不是常见默认口令 |
| 运行超时 | `timeoutMs` 太小、模型慢、工具上游慢 | 运行详情看 `latencyMs` 与最后一步；调大智能体的 `timeoutMs`；检查上游 API 延迟 |
| 评估跑批一直 `running` | 跑批在 worker 的 `eval-runs` 队列串行执行；job 真正丢失才会永久停在 running | 确认 worker 在运行；超过 1 小时只成为候选，reconciler 会核对 eval 队列，waiting/delayed/active 仍保留，仅 job 缺失或已终结才置 `failed`（`eval run lost`）；不要仅因耗时超过一小时手动重发 |

常用观察命令：

```bash
docker compose logs -f api worker
docker compose ps
curl -s -b "agentport_token=<登录后的会话 cookie>" localhost:3000/health/metrics   # 需要登录
set -a; . ./.env; set +a
redis-cli -u "$REDIS_URL" llen bull:agent-runs:wait
redis-cli -u "$REDIS_URL" xlen run:<runId>:events
docker ps --filter 'name=^(pace-session-|agentport-)'
```

`redis-cli` 不是项目依赖；本机没装时用 `docker compose exec redis redis-cli -a "$REDIS_PASSWORD" ...`。

## 6. 观测入口

| 入口 | 内容 | 鉴权 |
|---|---|---|
| `GET /health/live` | 进程存活 | 无 |
| `GET /health/ready` | DB 查询 + Redis ping；任一失败返回 503 与 `status: degraded` | 无 |
| `GET /health/metrics` | 进程（uptime、RSS、Node 版本）、队列计数、连接池、Redis ping 延迟；单项失败返回 `null`，整体仍 200 | 登录（`requireAuth`） |
| `/api/overview` | 统计卡、智能体聚合（运行数、成本、错误率、P50/P99、tokens）、最近 20 条运行；`days` 限制 1–3650 | 登录 |
| `/api/runs`、`/api/runs/:id` | 运行列表与 trace 步骤 | 登录 |
| `/api/audit` | 审计事件，可按 action / status / 时间过滤 | 登录 |
| 页面「审计」 | 同上，按时间倒序 | 登录 |
| 页面「运行」→ 详情 | 状态、耗时、轮次、成本、token、错误、步骤时间线（子智能体内部调用缩进）；「用同样输入重新运行」 |
| 页面「系统状态」`/status` | live / ready / metrics 三面板，10 秒刷新；浏览器内只读自检 | 登录（metrics 接口同样需要登录） |
| api 日志 | pino JSON（生产）/ pino-pretty（开发）；按路由模板记录，>2s 记 `slow request`，SSE 不打慢请求 | stdout |
| worker 日志 | 结构化 JSON；每步带 `runId`，容器 stderr 以 `sandbox` 字段转发 | stdout |

审计动作包括：`auth.login.succeeded`、`auth.login.failed`、`auth.logout`、`server.created/updated/deleted`、`mcp.server.tested`、`server.tool.created/updated/deleted`、`agent.created/updated/deleted/rolled_back/imported`、`skill.created/updated/deleted/imported`、`agent.run.requested/approved/cancelled/finished`、`conversation.branched/renamed/deleted`、`eval.case.created/updated/deleted`、`eval.cases.imported`、`eval.run.requested/cancelled`、`maintenance.pruned`。审计只存输入摘要（SHA-256 前 32 位），不存原文。

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
| API | Node 24 LTS（测时 v24.22.0；以当前 24 最新补丁为准），tsx dev，Fastify；pg 连接池 `max: 10`（当时硬编码；现由 `DB_POOL_MAX` 配置，默认仍为 10） |
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

第二个瓶颈是 **worker 并发 `AGENT_MAX_CONCURRENT=2`**：单次 run 固定成本约 2.5–3.3 s（主要是拉容器和启动 SDK，简单 prompt 也一样；该基线为每次新建容器，同会话复用只省容器部分，不省每轮 SDK query 启动），因此 run 吞吐约 0.7 个/秒。10 个 run 同时投递时 p95 排队 10.5 s、峰值 waiting 8，与理论 FIFO 完全吻合，队列本身没有额外异常，只是并发上限低。

未发现 SSE、MCP、写接口在本次并发量下有问题：SSE 内存不增长（同一 run 的多个订阅者共用一条 Redis 订阅），MCP 每个请求重建 handler 的取舍在 20 并发下仍是 10–20 ms。

### 8.4 建议参数

1. **先改读接口的查询形态**（收益最大、无配置风险）：`/api/overview` 的 counts（servers/agents/running/runs）合并成一条 SQL，其余两条重查询与它并行；`packages/api/src/features/agents/routes.ts` 的 4 条查询已是 1+3 并行，可只把首条列表查询与关联查询合并。预期 200 并发下 p95 从约 100 ms 降到 40–50 ms，吞吐约翻倍。
2. **连接池可配置（已实现）**：`packages/db/src/client.ts` 读取 `DB_POOL_MAX`（默认 10）。单 API 实例、Postgres `max_connections=100` 时，20–30 安全；但若不同时做第 1 条，翻倍池只是把压力更早推给 Postgres。worker 另有独立连接池，扩容时一并计入。
3. **读接口补限流**：当前 `global: false`，只有显式配置的路由计数（登录 10/min、chat 20/min、`/mcp` 与 `/mcp/:serverId` 各 60/min、连接测试 20/min、评估发起 10/min），读接口完全不计流（压测中 2000 次读请求无 429）。若要暴露到 localhost 之外，建议读接口加 600 次/分/IP；单管理员场景下 chat 的 20 次/分偏低（两次突发落在同一分钟就会 429，本次压测已复现 2/10 被拒），可提到 60 次/分或按登录用户计数。
4. **worker 并发按资源定**：每个沙盒受 `SANDBOX_MEMORY=1g` 上限约束，把 `AGENT_MAX_CONCURRENT` 从 2 提到 4 可把 10 个 run 的 p95 排队从约 10.5 s 降到约 5 s，代价是活跃沙盒按该上限占用的内存与更多宿主 CPU。以上是一次性容器压测数据；会话复用后，正常完成或成功取消的容器会在 `SANDBOX_IDLE_TIMEOUT_MS` 内热空闲并继续占用资源，实际容器总数可能高于活跃 run 数。本机未实测热空闲容器的内存，也不据此给出新的并发上限；扩容前按容器数（含热空闲）观察资源水位。同会话复用减少容器创建/启动，但不跳过每轮 SDK query 启动，不算 SDK 冷启动优化。
5. **观测告警线**：`/health/metrics` 的 `db.waiting > 5` 持续 10 s，或队列 `waiting > 10`，即可认为已进入本次测出的瓶颈区。

### 8.5 复现注意

- 脚本会等待 chat 限流窗口重置（上一次测试的请求可能仍在 60 s 窗口内），因此整体耗时约 2 分钟。
- 需要 api 与 worker 都在运行；只跑 api 时队列测试会一直排队到超时后取消。
- 测试使用真实模型调用并产生费用；不要在生产实例上运行。
- 清理仅按 `loadtest-` slug 前缀进行，不会触碰用户已有数据；如中断，重新运行脚本会在开始阶段清理上一轮残留。


## 9. 运行测试的前提

### 9.1 仅运行 Web 单元测试

```bash
pnpm install --frozen-lockfile
pnpm test:web
# 按需输出机器可读结果（路径自行指定）
pnpm test:web --reporter=json --outputFile=web-test-results.json
pnpm --filter @agentport/web typecheck
pnpm exec biome check package.json vitest.config.ts packages/web/vitest.config.ts packages/web/test
pnpm --filter @agentport/web build
```

`test:web` 使用 `packages/web/vitest.config.ts`，只收集 `packages/web/test/**/*.test.ts`。配置基于自身文件定位仓库与 `@` → `packages/web/src` 别名，使用 Vitest 的 `jsdom` 环境与自动 JSX 转换；`packages/web/test/setup.ts` 开启 React `act` 环境。`jsdom` 是锁定版本的根开发依赖，安装时需包含 devDependencies。

此命令禁用 `.env` 文件加载，不需要 API、worker、PostgreSQL 或 Redis，也不依赖机器上的临时配置。它仍会继承调用进程已有的环境变量。

根 `pnpm test` / `pnpm test:watch` 使用 Vitest projects：`web` 项目加载上述独立配置；`backend` 项目维持 Node 环境、原有测试变量与超时，并排除 Web 目录。手动触发 CI 时，`pnpm test` 会运行两类测试，不需要单独追加 Web 步骤；push 和 PR 不自动运行 CI，合并不等待远端检查。根命令仍适用下方后端运行前提。

只检查文件收集、不执行测试模块时，可运行 `pnpm exec vitest list --filesOnly`。此根命令仍解析后端配置并可能读取 `.env`；需要严格避免读取本地秘密时只用 `pnpm exec vitest list --config packages/web/vitest.config.ts --filesOnly`。

### 9.2 后端集成测试与 E2E

根 `pnpm test` 的 `backend` 项目（`vitest.config.ts`）会用 `process.loadEnvFile('.env')` 读取仓库根 `.env`，只把其中的 `DATABASE_URL` 当作管理连接：globalSetup 每轮创建一个随机 PostgreSQL database 并完成迁移，同时启动一个独享临时 Redis 容器；两者通过 `inject('backendInfra')` + `setupFiles` 在测试模块导入前写入 `process.env`，后端用例不再读写开发库或共享 Redis。PostgreSQL 或 Docker 不可用时，globalSetup 注入明确的不可连地址，对应 describe 自动跳过；管理账号缺 `CREATEDB`、本地未缓存 `REDIS_IMAGE` 指定的 Redis 镜像（首次可 `docker pull redis:8.10.3-alpine@sha256:896f241f438ab6a210cfb24f573b84bea721a4cbe67f1b4fd07eb638b3b02a7b`）以及建库或迁移失败都属配置错误，直接报错。`pnpm test:web` 不走这条路径（见 §9.1）。watch 会话开始时 globalSetup 只执行一次，会话内复用本轮创建的数据库与 Redis 容器，退出时统一清理；热重跑不会重建资源。

集成用例会创建真实的 run 记录，并断言它们停留在 `queued`/`cancelled` 状态。这类断言怕的是**同一个 Redis 实例上有 worker 在消费 `agent-runs`**。测试使用每轮独享的临时 Redis 容器（内部 db 9），开发 worker 留在共享实例的 db 0，默认互不可见，**不需要停 worker**；不要为了让测试通过把 `REDIS_URL` 指回共享实例。

E2E（`pnpm test:e2e`）的地址与启动方式以 `e2e.config.ts` 为准：web 目标固定为 [http://localhost:5173](http://localhost:5173)，未就绪时由 e2e 自动执行 `pnpm --filter @agentport/web exec vite` 启动，已就绪则复用（`reuseExisting`）——它不走 Portless，也不使用 Portless 分配的地址。API 不会被自动启动，需另行在 [http://localhost:3000](http://localhost:3000) 运行。多数用例直写数据库：先 `pnpm build` 产出 `packages/db/dist`，并显式导出与 API 同库的 `DATABASE_URL`。登录凭据取自 `e2e.config.ts` 的 `credentials.admin`（默认 `admin` / `admin-local-dev-2026`，可用 `E2E_ADMIN_USER`、`E2E_ADMIN_PASSWORD` 覆盖），须与服务端实际生效的管理员一致；个别文件另有前置：`tests/chat-replay.e2e.ts` 要求 `E2E_WORKER_PAUSED=1`（即先停 worker），且 `e2e.config.ts` 收集全部 `tests/**/*.e2e.ts`，所以普通 `pnpm test:e2e` 要停 worker。`tests/smoke.e2e.ts` 中的真实对话用例需要 worker 与模型凭据，仅在 `E2E_FULL=1` 时运行，与回放用例前提相反；要跑它应单独选择该用例并启动 worker，不能只给整套加 `E2E_FULL=1`。


## 本地模型网关

worker 通过模型凭证代理访问上游，代理监听 `MODEL_PROXY_PORT`（默认 3426）并发布到宿主回环。
沙盒在默认 bridge 网络上，通过 `host.docker.internal:3426` 访问它。

配置自建网关（例如宿主机上的 `127.0.0.1:3425`）：

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:3425
ANTHROPIC_AUTH_TOKEN=<网关的 key>
```

要点：

- `ANTHROPIC_BASE_URL` 写 `127.0.0.1` 即可：worker 在容器里时会改写为 `host.docker.internal`。
- 模型名必须是网关接受的名字。直连 Anthropic 的名字（`claude-sonnet-5-5`）在自建网关上通常不存在。
- 代理只转发 `/v1/messages`、`/v1/count_tokens`、`/v1/models`；网关的其他端点不可达。
- 代理使用 Node 原生 `http` 与 `stream/promises.pipeline` 流式转发：上游/下游按流背压，沙盒或客户端提前断开时中止上游请求，不再手工逐 chunk 读写。
- 改端口时同步改 compose 的 `ports` 映射，否则沙盒连不上。
- 容器里只有 `ANTHROPIC_AUTH_TOKEN=run_...`；拿这个 token 直接访问代理以外的地址没有意义。
