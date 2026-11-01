# 频道模式设计契约（2026-11-01）

> 状态：设计 checkpoint。2026-11-01 按「先在本机/单台服务器跑通、租户不做重」修订：取消租户抽象（D1），沙盒保持 D-16 方案 A 并补单机容量约束（§10.2）。
> 上游证据：[频道模式调研](channel-mode-research.md)。
> Goal：`workbody-channel-mode-goal`；LoopX checkpoint：`todo_787f225da9fa6630e50e67fc`。
> 基线：`ee4523d`（origin/main）。

### M1 实施记录（2026-11-01）

- 目标：四张频道表、shared 契约、成员/绑定/消息/未读/SSE API 与隔离集成测试；不含 UI、唤醒、审批及旧会话表改动。
- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/channel-mode`；分支 `worktree-channel-mode`；起始 HEAD `ee4523d053ead56335d24f160d2b5d7d3accb489`。
- 初始差异：本契约与 `channel-mode-research.md` 为已有未跟踪设计材料，保留原内容；本次不提交 git。
- 当前有效决定：以用户本轮 M1 指令为准；不新增权限矩阵叶，成员默认 `member`，非成员统一 404；以 `channel_messages.seq` 回放，不建 `channel_events`、`channel_read_states`、`plan_approvals`。
- 已替代项：下文 §3.1、§3.2 默认 viewer、§4 的事件表及独立事件 ID、§11 的完整 P0 路由是后续设计材料，不作为 M1 实现要求；M1 仅新增 `message.created` 事件与 `POST /api/channels/:id/read`。
- 方案：数据库分配 `bigserial`；同频道发消息事务先锁频道，再插入消息并更新频道时间；幂等由部分唯一索引兜底；未读按他人消息计数；SSE 复用现有 Redis Stream 订阅循环并以数据库消息补拉。
- 步骤：数据与 shared 契约、API/仓储、集成测试按文件边界并行；依赖完成后统一类型检查、隔离迁移和回归测试，随后独立评审。
- 已发现入口差异：仓库没有 `packages/api/src/buildApp.ts`，实际 `buildApp` 位于 `packages/api/src/app.ts`，feature 注册入口是 `packages/api/src/routes/index.ts`。
- 环境处理：首次现有流测试因本树缺少 `packages/api/node_modules` 未进入用例；`pnpm install --frozen-lockfile` 补齐依赖后成功，未改依赖清单与锁文件。测试并行时 RTK 共用 `.vitest/json/output.json` 会相互覆盖，最终证据使用 `rtk bypass` 的独立原始输出。
- 已验证：`pnpm --filter @agentport/db generate` 生成 `0047_solid_miek.sql`，再次生成输出 `59 tables`、`No schema changes, nothing to migrate`；通过 `pnpm --filter @agentport/api exec tsx --env-file=../../.env --eval 'import("../worker/test/isolated-db.ts").then(async ({createIsolatedDatabase}) => { const database = await createIsolatedDatabase("channel_m1_migrate"); if (!database) throw new Error("PostgreSQL unavailable"); console.log("Fresh isolated database: all migrations applied successfully"); await database.close(); console.log("Isolated database removed"); })'` 在全新随机 PG 库应用全部迁移成功并清理，未迁开发库。
- 已验证：`pnpm -r typecheck` 全部 7 包通过；shared 全套 22 文件 211 用例通过；db 全套 21 文件 185 用例通过；频道 + producer-contract + run-stream + sse-subscribers + sse-terminal-recovery + chat + conversations 组合回归 7 文件 72 用例通过；频道相关 10 个源码文件 Biome 通过。
- 评审第一轮：独立 Opus 暂不通过，提出 Redis 无限等待、SSE 移除后缓存页继续发送、未来 SSE 游标长期漏消息、平台跨用户频道读取缺审计四项。已派关键修复并补故障/时序测试，未新增 outbox 或推送机制。绑定授权顺序另已修复并新增真实无角色账号回归；实测原非成员已按现有错误映射返回 404，实际修复的是无 agent 授权的 member/viewer 原本误返 404，现在先按频道角色返回 403。
- 同树其他改动：实施期间出现 `packages/worker/**` 沙盒容量相关差异，非 M1 代理产出，保留不覆盖，不纳入 M1 交付清单。
- 新增验证：频道行为套件扩充为 15 用例，独立原始输出 `Test Files 1 passed (1)`、`Tests 15 passed (15)`；覆盖正文空白保留、opaque 幂等键、未知字段与空白正文拒绝、跨 200 条 SSE 回放、成员移除停止流、两个 owner 并发退出。旧会话准入/历史分页/搜索另 3 文件 40 用例通过；现有路由权限套件 1 文件 11 用例通过。
- 终审修复验证：最大序号查询歧义已修（Drizzle 单表投影将外层 `${channels.id}` 去限定名为 `"id"`，子查询误绑定内层消息 ID；现用 `${channelId}` 参数，经验记入 `docs/PITFALLS.md`）。全工作区类型检查恢复通过；频道故障 + 频道行为 + 旧聊天/SSE 组合回归 8 文件 82 用例全部通过，包含 Redis 黑洞无回应、SQL 读取时撤权、背压缓存页撤权、未来/正常游标与平台跨用户审计。
- 最终包级回归：`rtk bypass pnpm exec vitest run --project backend packages/db/test packages/shared/test` → `Test Files 43 passed (43)`、`Tests 396 passed (396)`；类型检查全 7 包通过，故障测试仅一处长行经 Biome 换行，不改语义。服务退出信号调整后组合回归再次 `8 passed` / `82 passed`（11.92s），`pnpm -r typecheck` exit 0，11 文件 Biome exit 0，`git diff --check` exit 0。
- 独立终审：第二轮 Opus 明确通过，四项修复闭合，无阻塞交付的 P1/P2；其独立运行故障套件 5/5、游标定向 1/1 通过。接受限制：Redis 初连未 ready 的 SSE 本连接保留 3 秒 DB 轮询，重连后恢复 Redis；只有 DB 轮询的连接由现有 API 退出时限关闭，客户端断开均清理轮询。
- 构建：`pnpm --filter @agentport/api build` → `tsc -b`、exit 0。
- 最后验证：故障代理补强 XADD/XRANGE 均实际进入无回应路径的断言后，8 文件组合回归仍为 `82 passed`（12.02s，exit 0）；11 文件 Biome `No fixes applied`（exit 0）。自动生成的 `.vitest/json/output.json` 已恢复，不作为交付差异。
- 下一步：无代码待办；保留未提交差异，不合入、不提交 git。


### M2 实施记录（2026-11-01）

- 目标：显式 `mentions` / opt-in `mentionAll` → lane → 既有 run 队列 → 助手消息事务投影；补齐频道准入和生命周期提示，不改 UI、不做 M3、不提交 git。
- 基线：继续 `/Users/xbjt/Documents/myself/agentport/.claude/worktrees/channel-mode` / `worktree-channel-mode`，HEAD `ee4523d053ead56335d24f160d2b5d7d3accb489`；已有 M1 全部未提交差异保留；已有 M0 worker 容量、`docker-compose.yml`、`docs/OPERATIONS.md` 及相关测试差异不归 M2、不覆盖。
- 当前有效决定：本轮用户明确要求以 lane 为忙碌边界，允许不同 lane 各自入队；同 lane 已 queued/running 时写 system 提示并跳过，排队/合并留 P1。替代下文 §8 的“全频道最多 1 run”与 P0 排队三条描述。沿用 M1 成员授权，不新增 `channels.*` RBAC 叶；频道成员与 active binding 决定唤醒/执行，不沿用 lane 首次创建者的私有对象归属。
- 数据契约：`admitChatRun` 可选 `channel: { channelId, channelMessageId }`，频道分支同事务取建唯一 lane、写 run 与 user 消息来源关联；不修改既有私有分支语义。所有显式 mentions 在频道消息写入前验证，失败整条 400；重复客户端消息不再次唤醒。
- 发布契约：沿用 shared 的 `channelStreamKey` 与 Redis Stream payload/TTL；生命周期仅提示，DB 是权威来源；消息 `seq` 仍是 SSE 唯一持久回放游标，不新建事件表。
- 步骤：数据库/shared、API 与 worker 按文件边界并行；统一运行新迁移隔离验证、全包类型检查和频道/聊天/会话列表/SSE 回归，再做独立评审。
- 影响面：schema/迁移、chat 与 channel repo、shared 频道与 trigger 契约、频道路由/SSE、worker 准入/消息落库/认领与统一终态发布；测试及现有表说明同步。
- 官方依据：核对 https://code.claude.com/docs/en/agent-sdk/sessions 与已安装 `packages/worker/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 的 `Options.resume` / `sessionId`；每个 lane 复用自己的 conversation session，不改变 SDK 选项或执行底座。
- 验证（整合前）：`pnpm exec vitest run packages/api/test/chat.test.ts packages/api/test/conversations.test.ts packages/api/test/conversation-search.test.ts packages/api/test/run-stream.test.ts packages/api/test/sse-subscribers.test.ts packages/api/test/sse-terminal-recovery.test.ts` → `Test Files 6 passed (6)`、`Tests 73 passed (73)`、12.32s、exit 0。并行期间代码仍有变化，最终需重跑对应组合。
- 验证：`pnpm db:generate` → `59 tables`、`No schema changes, nothing to migrate`；`0048_nappy_shaman.sql` 在全新随机 PG 库迁移成功并删除库（替代本轮未交付的 `0048_panoramic_thunderbolts.sql`，移除额外加在旧 `source_message_id` 上的 FK，保持旧列语义）。`pnpm -r typecheck` 全 7 包 exit 0；初次缺 `channel` 来源名称映射，补齐现有个人用量/路由筛选枚举后通过，不新增 UI。
- 组合验证：频道/mentions/故障/chat/run-access 两套件共 6 文件 58 用例通过；db/shared M2 + worker 投影/事件 + 会话列表/搜索/SSE 共 9 文件 113 用例通过；`run-pending-finish` 独立 1/1 通过（同轮并行共享身份初始化 409 见 PITFALLS）；API 与 worker build exit 0；`git diff --check` exit 0。
- 独立终审第一轮不通过：旧 `/api/runs/:id` 与 questions/approvals 仍按触发者私有归属授权；重试尝试的回复提前投影且覆盖时 seq 不变，在线 SSE 会漏最终正文；旧 source 列额外 FK 越界。FK 已移除并重生成迁移；其余两项并行修复：旧私有 run 入口拒绝频道 run，频道回复只在 `!willRetry` 时投影，保留 lane 消息原有重试行为，新增实际回归。
- 最终迁移收紧后验证：核心验收 8 文件 89 用例通过；db/shared 全套 45 文件 418 用例通过；会话列表/搜索/SSE 5 文件 61 用例通过；claim/reconcile/publisher 4 文件 30 用例通过。全包类型检查再次 exit 0，Biome 16 文件 `No fixes applied`。
- 终审修复已落地：API 统一授权函数拒绝频道 run，普通成员撤出后的详情/问题/审批读写拒绝且存储未变，私有对照仍 200；测试先 `3 failed / 1 passed` 后 `4 passed`。worker `persistRunMessages` 可选 `projectChannelReply`，index 传 `!willRetry`；真实 processor 验证中间 A 无频道行/无发布、最终 B 一条且发布一次、最终空零投影。
- 修复后最终验证：`pnpm -r typecheck` 全 7 包 exit 0；核心 10 文件 111 用例通过（包含用户指定文件与 mentions/旧入口撤权/投影/真实 processor）；API 旧 run/问题回归 4 文件 23 用例通过；Biome 25 文件 `No fixes applied`；API/worker build exit 0；`git diff --check` exit 0。核心日志中的 runtime identity/Docker/Redis 错误来自对应故障注入断言，用例全部通过，无 skipped。
- M2 改动文件：`packages/db/src/schema.ts`、`repo/chat.ts`、`repo/channels.ts`、迁移 `0048_nappy_shaman.sql` 与 snapshot/journal；`packages/shared/src/channels.ts` / `ops.ts`；API `features/channels/routes.ts`、`features/chat/routes.ts`、`features/runs/routes.ts` / `questions.ts`；worker `run-access.ts` / `messages.ts` / `index.ts` / `run-finish.ts` / `runner-client.ts` / `channel-events.ts`；新增 db/shared M2、API mentions/撤权、worker lifecycle 测试，扩展 worker message-persistence/run-access-db/run-runtime-identity 测试；web 仅现有来源枚举与“频道”标签适配；同步 ARCHITECTURE/PROJECT-BRIEF/PITFALLS 与本记录。M1 注册/导出与 M0 配置/部署差异保留原样，不计入 M2。
- 剩余限制：频道消息写入与 run 准入/Redis 入队跨事务，进程在两者间中断仍可能留下无 run 的消息；同客户端幂等重发不重新唤醒。run 生命周期为实时提示，Redis 发布失败时消息可按 DB seq 补拉，生命周期不另建持久事件回放。未运行真实付费模型/Docker SDK 端到端，worker 使用真实 processor 加受控沙盒替身覆盖执行链路。
- 可复跑核心命令：`pnpm exec vitest run packages/api/test/channels.test.ts packages/api/test/channels-resilience.test.ts packages/api/test/channels-mentions.test.ts packages/api/test/channels-run-access.test.ts packages/api/test/chat.test.ts packages/worker/test/run-access.test.ts packages/worker/test/run-access-db.test.ts packages/worker/test/message-persistence.test.ts packages/worker/test/channel-run-events.test.ts packages/worker/test/run-runtime-identity.test.ts` → `Test Files 10 passed (10)`、`Tests 111 passed (111)`、7.12s。
- 可复跑扩展命令：`pnpm exec vitest run --project backend packages/db/test packages/shared/test` → 45 文件 418 用例；`pnpm exec vitest run packages/api/test/conversations.test.ts packages/api/test/conversation-search.test.ts packages/api/test/run-stream.test.ts packages/api/test/sse-subscribers.test.ts packages/api/test/sse-terminal-recovery.test.ts` → 5 文件 61 用例；`pnpm exec vitest run packages/worker/test/run-pending-finish.test.ts` → 1 文件 1 用例，8.25s（单独运行避免共享身份冲突）。
- 独立 Opus 修复复核通过：三项问题闭合，无阻塞问题；独立定向 6 文件 86 用例通过，0 失败、0 跳过，`git diff --check` 通过。只读复核产生的 `.vitest/json/output.json` 已恢复，原始验证摘要保留在本记录。
- 下一步：无 M2 代码待办；以验证完成的未提交差异交付，未合入。M3 与真实模型端到端不在本轮范围。

### M3 实施记录（2026-11-01，完整控制面；已通过独立终审）

- 目标：在数据契约子集基础上补齐频道控制面：活动 run 列表、单 run 事件流、stop / disconnect / close、审批列表与批准、审批记录挂频道与批准人、`approval.requested`、取消复用与操作人审计；不含计划审批、UI、外部 token 与真实付费模型端到端，不提交 git。
- 基线：继续 `/Users/xbjt/Documents/myself/agentport/.claude/worktrees/channel-mode` / `worktree-channel-mode`，基线 `ee4523d053ead56335d24f160d2b5d7d3accb489`；已有 M0/M1/M2 未提交差异全部保留，不覆盖。
- 分工：数据契约子集（db/shared/迁移）先由本代理完成；API control/approvals 由本轮其他代理完成。本记录把两部分合并为完整控制面记录；本代理只改 db/shared/迁移与本文档，未改 API/worker 源码。
- 当前有效决定（数据契约子集，保留）：
  - 关闭不新增 `closed_at`，复用 `channels.archived_at`；关闭入口设置该列。
  - `approval_requests` 仅新增 `channel_id`（nullable text，FK `channels(id)` cascade）与 `approved_by_business_id`（nullable text）；不新增 `status` / `decided_at` / `approval_key`，不建 `plan_approvals` 表，不回填旧行。
  - 审批不持久化 denied/expired 状态机，只记录 `approved_at` 与 `approved_by_business_id`；批准先到先得，由 API 用条件更新实现。
  - 关闭后写入口径：`postMessage` 在既有 channel 行锁内读取 `archived_at`，已关闭时抛 `CONFLICT`「频道已关闭，不能发送消息」；`admitChatRun` 频道分支继续在同一行锁内以 `archived_at` 阻止新 run；私有分支与绑定状态准入保持原样。
  - `postSystemMessage` 在行锁内发现已关闭时返回 `null`，不写忙碌误提示；调用方需跳过 `null`。
  - shared 新增 `approval.requested { channelId, runId, approvalId, toolName }` 事件；active runs / approvals 响应 schema 由使用方按需补充，不预置无用导出。
  - 不新增 `channels.*` RBAC 权限叶；P0 沿用现有账户权限与频道成员角色。
- 已替代项及原因：§2.2 的 `plan_approvals` 表与 `approval_requests.status`、§5 的 pending/approved/denied/expired 状态机、`approval_key` 与超时处理、§6 的 `closed_at`、§12 的旧行状态回填、§3.1 的 `channels.*` 新权限叶，均不再实现；以本轮用户明确要求与本记录为准。
- 迁移：`pnpm db:generate` 生成 `0049_elite_siren.sql`，内容为两条 `ADD COLUMN` 与一个 `ON DELETE cascade` 外键，无默认值、无回填、无新索引。

#### 控制面七端点与真实成员权限（本轮新增）

平台管理员若不是频道成员，控制面同样按 404 收口，不因平台身份绕过成员校验；角色不足返回 403。`viewer` 的“读”包括以下三个 GET 以及频道消息/频道事件读取。

| 方法 | 路径 | 真实成员权限 | 行为 |
|---|---|---|---|
| `GET` | `/api/channels/:id/runs` | 任意真实成员（含 viewer）；非成员 404 | 只列 `queued` / `running`，返回 runId、agentId、status、startedAt |
| `GET` | `/api/channels/:id/runs/:runId/events` | 任意真实成员（含 viewer）；非成员在 hijack 前 404 | run SSE；每 2s 复核 run 与成员关系；撤权或记录消失写 `run_unavailable` 并停流；已终态的 run 从 DB 补发终态 |
| `POST` | `/api/channels/:id/runs/:runId/stop` | viewer 403；member 只能停自己触发的 run；owner/admin 可停任意 run；非成员 404 | 锁频道与 run；复用 `cancelAgentRun`；queued 由 CAS 写 cancelled 并补发频道 `run.finished`；running 只发取消信号；实际发出取消才写审计 |
| `POST` | `/api/channels/:id/agents/:agentId/disconnect` | 仅 owner/admin；member 与 viewer 一律 403（member 要停自己的运行用 stop）；非成员 404 | 绑定置 `disconnected`，取消该 lane 的活动 run；P0 无频道 token，不做 token 撤销 |
| `POST` | `/api/channels/:id/close` | 仅 owner；admin/member/viewer 403；非成员 404 | 锁频道写 `archived_at`，取消全部活动 run；重复 close 幂等返回同一 `archivedAt`；之后发消息/新 run 被拒 |
| `GET` | `/api/channels/:id/approvals` | 任意真实成员（含 viewer）；非成员 404 | 只列活动 run、尚未批准且未过期的频道审批 |
| `POST` | `/api/channels/:id/approvals/:approvalId/approve` | viewer 403；member 仅能批准自己触发 run 的审批；owner/admin 可批准任意审批；非成员 404 | 锁 run 后 CAS `approved_at is null`；已决定、已过期、run 非活动返回 409；仅 CAS 赢家写审计 |

- 取消复用：stop / disconnect / close 全部复用 `cancelAgentRun`，不新增第二套取消路径。queued 由 API CAS 写终态并补发频道 `run.finished`；running 只发 Redis 取消信号，终态、消息与产出由 worker 收尾。
- 批量取消：close / disconnect 先提交频道状态（写入 `archived_at` / `disconnected`），再逐条 best-effort 取消全部活动 run；单条失败不中断其余 run，汇总 `failedRunIds` 后写 `status: 'error'` 审计并返回 503 `SERVICE_UNAVAILABLE`（`retryable: true`）。频道状态不回滚，调用方可原样重试补停剩余 run；不再静默吞错。
- 审批事件：`approval.requested` 只在频道 run 申请工具审批时发布；发布失败只 warn，不把工具调用或 run 判失败。订阅端仍以 `approval_requests` 与活动 run 查询为准，事件只做唤醒；本轮没有 `approval.decided`、拒绝端点或过期状态机。
- 频道发布连接：`packages/api/src/queue/producer.ts` 本轮提取 `publishChannelEvent`，频道事件使用独立 `channel-producer` Redis 客户端；`enableOfflineQueue: true` 配 `commandTimeout: 1000` 与 `connectTimeout: 1000`，冷启动首个事件在连接未 ready 时短暂排队而不丢，Redis 不可用时由 commandTimeout 限时失败、不阻塞请求；既有 `channels-resilience` 覆盖无响应黑洞。

#### 数据契约子集验证（保留，先红后绿）

- 红测：`pnpm exec vitest run packages/shared/test/channels-m2.test.ts` → `1 failed | 6 passed`（`approval.requested` 不在判别联合）；`pnpm exec vitest run packages/db/test/channels-m3.test.ts` → `4 failed | 1 passed`（发消息未拒绝、系统提示未返回 null、两列不存在；已实现的 admit 关闭检查为绿）。
- 绿测：shared 频道契约 `7 passed`；db M3 `5 passed`（关闭后发言 CONFLICT、系统提示返回 null 且零写入、admit 关闭检查、审批两列持久化、删频道级联删审批）。
- 全量：`rtk bypass pnpm exec vitest run --project backend packages/db/test packages/shared/test` → `Test Files 46 passed (46)`、`Tests 424 passed (424)`，23.54s。
- 类型检查：`pnpm --filter @agentport/db typecheck`、`pnpm --filter @agentport/shared typecheck` 均 exit 0。
- 迁移：`pnpm db:generate` 生成 `0049_elite_siren.sql`（两列 + 一个 cascade FK）；再次生成输出 `No schema changes, nothing to migrate`。db/shared 测试的 globalSetup 已在全新随机库应用全部迁移。
- 数据契约子集交付时：API 代理已适配上 `postSystemMessage` 的 `null`（`packages/api/src/features/channels/routes.ts` 已判断 `notice !== null`），`pnpm --filter @agentport/api typecheck` 已 exit 0；本代理不提交、不合入。

#### 此前完整验证（终审修复前证据，不代表最终通过）

- `pnpm db:generate` → `59 tables`、`No schema changes, nothing to migrate`。
- `pnpm --filter @agentport/api exec tsx ... createIsolatedDatabase("channel_m3_migrate")` → `Fresh isolated database: all migrations applied successfully`、`Isolated database removed`。
- `pnpm -r typecheck` 全 7 包 exit 0；`pnpm --filter @agentport/api build` exit 0。
- `rtk bypass pnpm exec vitest run ...` → 21 文件 184 用例通过（12.88s）；覆盖 M3/control/approvals/db M3、M1/M2 频道、chat、approval lifecycle/waiting/deadline、generated-cancel/HTTP、run-stream/SSE、db M2/shared M2/worker 频道/准入/持久化。
- `rtk bypass pnpm exec vitest run --project backend packages/db/test packages/shared/test` → 46 文件 424 用例通过（22.83s）。
- Biome 15 文件 `No fixes applied`；`git diff --check` 通过。
- 以上均为独立终审修复前的历史证据，不代表最终通过；修复后的对应范围已按下节重跑。

#### 终审三项修复与修复后验证（已闭合：后续第四项修复与独立终审见下）

- 修复 1：`cancelAgentRun` 返回真实路径 `'queued' | 'running' | null`；私有 chat 取消与 agent-invoker 取消均改为 `!== null` 判定“本次是否真正取消”；频道控制面只在 `result === 'queued'` 时补发频道 `run.finished`，running 只依赖 worker 收尾，不再依据陈旧快照误发终态。
- 修复 2：run SSE 在回放与跟读的每条事件发送前重新核验成员与 run，撤权即写 `run_unavailable` 并停流；频道 SSE 每条消息发送前复核读权限。run SSE 保持 2s 终态/成员复核，频道 SSE 保持 3s DB 补拉。回放中的撤权不再依赖 `subscribeRun` resolve 后才启动的定时器。
- 修复 3：批量取消按上节“批量取消”执行；close / disconnect 的频道状态先提交并保留，单条失败继续处理其余 run，最终 503 + `status: 'error'` 审计 + `retryable: true`，可直接重试。
- 红测证据（均为修复前旧实现）：claim 竞争用例旧实现补发了 `run.finished`，断言得到 `expected true to be false`；回放撤权用例旧实现把撤权后的 3 条 `text_delta` 送给了非成员连接（现断言为 0）；close 单条取消失败用例旧实现返回 200，现应返回 503。disconnect 用例首轮红是 fixture 的两条 run 因同 lane 忙碌只建成 1 条；已把第二条 run 归入同一 lane 覆盖批量取消，这不计为实现红测。
- 绿测（修复后最终证据）：26 文件 `218 passed`，0 skipped，13.18s。组合为：此前 21 文件 184 用例 + `channels-control` 新增 4 用例 + `agent-invoker-cancel-wait` / `agent-invoker-lifecycle` / `agent-invoker-admission` / `failure-paths` / `run-questions` 共 30 用例。
- 26 文件可复跑命令：`pnpm exec vitest run packages/api/test/channels.test.ts packages/api/test/channels-resilience.test.ts packages/api/test/channels-mentions.test.ts packages/api/test/channels-run-access.test.ts packages/api/test/channels-control.test.ts packages/api/test/channels-approvals.test.ts packages/api/test/chat.test.ts packages/api/test/approval-lifecycle.test.ts packages/api/test/approval-wait-state.test.ts packages/api/test/approval-deadline.test.ts packages/api/test/generated-cancel.test.ts packages/api/test/generated-cancel-http.test.ts packages/api/test/run-stream.test.ts packages/api/test/sse-subscribers.test.ts packages/api/test/sse-terminal-recovery.test.ts packages/api/test/agent-invoker-cancel-wait.test.ts packages/api/test/agent-invoker-lifecycle.test.ts packages/api/test/agent-invoker-admission.test.ts packages/api/test/failure-paths.test.ts packages/api/test/run-questions.test.ts packages/db/test/channels-m2.test.ts packages/db/test/channels-m3.test.ts packages/shared/test/channels-m2.test.ts packages/worker/test/channel-run-events.test.ts packages/worker/test/run-access-db.test.ts packages/worker/test/message-persistence.test.ts`。
- db/shared 此前 `46 passed` / `424 passed` 证据仍有效：三项修复未再改 schema 与 shared 契约。
- 其他最终检查：`pnpm -r typecheck` 全 7 包 exit 0；`pnpm --filter @agentport/api build`（`tsc -b`）exit 0；Biome 18+2 文件 `No fixes applied`；`git diff --check` 无输出；`pnpm db:generate` 输出 `59 tables`、`No schema changes, nothing to migrate`。
- 独立 Opus 复核当时仍在运行、结果未返回，因此本节只作为三项修复的阶段性证据；后续第四项修复与独立终审通过见下，本节历史已闭合。

#### 第四项修复：逐事件成员校验抛错（已闭合）

- 问题：run SSE 在回放与跟读的每条事件发送前复核成员与 run 时，DB 查询抛错被静默 `return`，流没有结束但也不再发送，造成客户端 token 缺口。
- 修复：成员/权限查询抛错时置 `finishing = true`，发送固定 `error` 事件并结束流；即使之后查询恢复，也不再发送 token 或终态。
- 红绿：新增 `channels-control` 用例，首个事件权限查询失败、之后查询恢复，断言客户端只收到固定 `error` 且服务端随后结束，无后续 token、无终态；`channels-control` 14/14 通过。

#### 独立终审结论（已闭合）

- M3 独立 Opus 最终复核明确通过：累积前轮审查，整个 M3 已审范围最终通过，无阻断问题。
- 历史：独立 Opus 终审第一轮不通过三项（① 回放撤权；② claim 竞争误发终态；③ 批量取消吞错），三项修复与回归已完成，证据见上节；该轮已闭合。
- M1/M2 以及 M3 前三项修复的历史红绿与终审记录保留在上文，均已闭合。

#### 最终真实证据（2026-11-01，Start 15:26:18）

- 沿用上文 26 文件可复跑命令 → 26 文件 `219 passed`，0 failed，0 skipped，12.74s（Start 15:26:18）。上一轮 218 passed 记录保留为第四项修复前一轮证据。
- `pnpm -r typecheck` → 7 包 `Done`，exit 0。
- `pnpm --filter @agentport/api build`（`tsc -b`）→ exit 0。
- Biome 20 文件，25ms，`No fixes applied`，exit 0。
- `git diff --check` 无输出。
- `pnpm db:generate` → `59 tables`、`No schema changes, nothing to migrate`。
- 隔离迁移：全新随机 PG 库应用全部迁移成功并清理。
- db/shared `46 文件 424 用例` 证据仍有效（schema 未再变更）。

#### 最终限制

1. DB 状态（关闭/断开）与 Redis 取消都在事务外发布；进程中断后需要重试，没有 outbox/recovery 自动保证。
2. running 的 stop 只发取消信号，尚未停稳；终态仍由 worker 收尾。
3. SSE 逐事件 DB 查询有开销，未做负载验证；approval 实时事件无持久回放，新连接通过 `GET approvals` 恢复。

- 未运行付费模型/容器端到端；未做 UI、拒绝、计划审批、IM。

#### 下一步

- M3 代码与验证完成、独立终审通过；以验证完成的未提交差异交付，未合入、未提交 git。
- 后续 M4（频道 UI）与真实模型端到端不在本轮范围。

## 0. 一句话方案

新增 **channel 对象 + 成员 + agent lane**，复用现有 `conversations` / `messages` / `agent_runs` / SSE / 审批 / 取消 / run token；把现有私有对话保留为 1:1 频道。P0 只做**产品内频道**，IM、外部 agent、多租户后置。

## 1. 不可变边界

1. 不引入第二套执行循环。频道 run 仍走 `admitChatRun` → BullMQ → 沙箱 → Claude Agent SDK。
2. 不改现有私有对话语义。`/chat`、`conversations`、现有 SSE 与审批行为保持；频道是新增对象。
3. agent 身份独立，但不改 `.claude/` 文件定义；频道权限是平台层，工具权限仍在 agent 定义（`tools_allow` / `tools_deny` / `.claude/settings.json`）。
4. 不新增独立消息总线。频道事件持久化在 PostgreSQL，实时用 Redis Stream；不引入 Kafka / NATS / WebSocket 第二套协议。
5. 沙盒底座不变：Docker provider + 每会话常驻 supervisor 容器。P0 不引入 socket proxy、独立沙盒节点、microVM、K8s、per-tenant 沙盒池，也不改 provider 接口。
6. `D-16`（worker 挂 `docker.sock`）在 P0 保持 A：单机、自用、只跑自己定义的智能体。升级触发线见 §10.2。
7. P0 不做 IM 接入、外部 agent token、租户抽象；这些是 P1，不提前写空壳。

## 2. 对象模型

### 2.1 新表

| 表 | 关键列 | 说明 |
|---|---|---|
| `channels` | `id`, `name`, `description`, `created_by`, `archived_at`, `created_at`, `updated_at` | 频道是一等对象；P0 全部私有，无公开频道 |
| `channel_members` | `channel_id`, `business_id`, `role`(owner/admin/member/viewer), `last_read_seq`, `created_at` | 只放人；未读游标就是 `last_read_seq`，不单设表。复合主键 `(channel_id, business_id)` |
| `channel_agent_bindings` | `channel_id`, `agent_id`, `conversation_id`(nullable，M2 才有值), `status`(active/paused/disconnected), `auto_wake_on_all`, `added_by`, `created_at` | 一条绑定 = 一个 agent lane；`unique(channel_id, agent_id)` |
| `channel_messages` | `id`, `channel_id`, `seq` bigserial, `kind`(human/agent/system), `author_business_id`, `agent_id`, `run_id`, `body`, `client_message_id`, `source_message_id`, `created_at` | 频道时间线唯一来源；事件回放就是 `seq > cursor`，不另设事件表 |
| `plan_approvals` | 不建此表 | M3 不做独立计划审批；频道工具审批复用 `approval_requests`，只加 `channel_id` / `approved_by_business_id` 并记录 `approved_at`，不持久化拒绝/过期状态机 |

相对初稿砍掉两张表：`channel_events`（时间线本身带 `seq`，实时走 Redis Stream，run 状态从 `agent_runs` 推导）与 `channel_read_states`（折进 `channel_members.last_read_seq`）。

TypeID 前缀按 `packages/db/src/id.ts` 统一登记；`channel_members`、`channel_agent_bindings` 不单独生成 ID。

### 2.2 现有表的最小改动

| 表 | 改动 | 原因 |
|---|---|---|
| `conversations` | 加 `channel_id` nullable；`unique(channel_id, agent_id) where channel_id is not null` | 一个 agent lane 一个会话；私有对话保持 `channel_id = null` |
| `messages` | 加 `channel_message_id` nullable | 把人发的频道消息与 agent lane 的 user message 关联，便于回溯 |
| `agent_runs` | 加 `channel_id` nullable、`channel_trigger_message_id` nullable；`trigger` 枚举加 `channel` | 频道触发的 run 可追溯来源消息 |
| `approval_requests` | 仅加 `channel_id` nullable、`approved_by_business_id` nullable | 记录审批所属频道与批准人；不新增 status/decided_at/approval_key，不建独立计划审批表，不回填旧行 |
| `run_questions` | 本轮未改 | 当前没有 `channel_id` / `answered_by_business_id` 列，频道澄清问题回答未接入；后续需要时再按现有问题链路补迁移 |

迁移策略：只新增表/可空列；不 backfill 现有私有对话或审批行。M3 不新增审批状态列，因此没有需要一次性回填的列；`approval_requests.channel_id` 是 nullable，私有行保持为空，不回填。

### 2.3 消息模型（关键决策）

- `channel_messages` 是**频道时间线的权威读模型**；`messages` 是**每个 agent lane 的 SDK 上下文**。
- 人发频道消息：只写一条 `channel_messages`；若 @ 了 agent，`admitChatRun` 在每个目标 lane 写一条 `messages`（`channel_message_id` 指向频道消息），SDK 只看到本 lane 的上下文。
- agent 回复：先写 `messages`（现有路径），同事务投影一条 `channel_messages`（`source_message_id` 指向 `messages.id`）。
- 这样不会让多个 agent 共享同一个 SDK session，也不会让频道时间线依赖跨 lane union。
- 代价：agent 回复文本存两份。接受该代价；用单事务 + `source_message_id` 保证一致，查询以 `channel_messages` 为准。

### 2.4 Channel lane 的归属与访问（必须改的授权规则）

- `conversations.createdBy` 对 channel lane 只记录“首次触发者”，**不再作为访问控制依据**；访问控制统一走 `channel_id` + 频道成员角色，不新增 `channels.*` RBAC 叶。
- `/api/conversations` 默认排除 `channel_id is not null` 的频道 lane，避免成员在私有会话列表看到别人的 lane；频道 lane 只通过频道页访问。
- worker 的 `run-access` 对 channel lane 走 `channel_members` + active binding 校验，不能继续要求 `conversations.create own_data` 命中创建者；否则第二个成员发言会被判越权。
- `conversations_subject_check` 不变：channel lane 仍有一个人类 `createdBy`（首次触发者），不新增 service 枚举；首次触发者离开频道后 lane 仍归频道所有，不随个人权限消失。


## 3. 权限模型

### 3.1 平台 RBAC + 频道成员双门禁

频道入口先过平台认证与现有对象授权（成员管理、agent 绑定等仍沿用已有权限），再过频道成员角色。M3 控制面七端点只要求登录 + 真实频道成员角色，不新增 `channels.*` RBAC 叶。

以下 `channels.*` 权限叶是未实现的早期草案（P1 候选），不代表当前能力；M1-M3 均未落地，新增入口不写 `role_permissions` 叶。

| 功能 | 说明 |
|---|---|
| `channels.view` | 查看频道列表与详情 |
| `channels.create` | 创建频道 |
| `channels.post` | 发消息 |
| `channels.act` | @agent、触发 run、停止 run |
| `channels.approve` | 审批工具（草案；不做计划审批，当前未使用该叶） |
| `channels.manage` | 成员、agent 绑定、改名 |
| `channels.close` | 关闭频道（草案；当前 close 仅 owner，未使用该叶） |

对象范围沿用现有“全部/本人/被指定”；频道成员权限是第二层，不能替代已有对象授权。

### 3.2 频道内角色

| 角色 | receive（频道/消息/活动 run/run 流/审批列表） | send | act（stop / disconnect） | approve | manage | close |
|---|---|---|---|---|---|---|
| owner | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| admin | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| member | ✅ | ✅ | 仅自己触发的 run：stop 自己的；disconnect ❌ | 仅自己触发 run 的审批 | ❌ | ❌ |
| viewer | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| agent | 按绑定 | 按绑定 | 按绑定 | ❌ | ❌ | ❌ |

- close 仅 owner；admin 也不能关闭频道。disconnect 仅 owner/admin，member 与 viewer 一律 403；member 要停自己的运行用 stop。
- agent 永远没有 `manage` / `close`；agent 不能给自己加权限。
- 新成员默认 `member`（`channelMemberInputSchema` 默认值；`channel_members.role` 默认同为 `member`），不是 viewer；加人由 owner/admin 执行。
- 最后一个 owner 不能被移除；当前没有成员角色变更入口，因此不存在降级路径。

### 3.3 审批策略

- **不做计划审批**：不建 `plan_approvals`，没有计划审批端点，也没有对应 RBAC 叶。
- **工具审批**：owner/admin 或触发该 run 的 member 可批准；viewer 与其他 member 403，非成员 404。批准先到先得，条件更新只有一个赢家，输家返回 409。
- **过期/拒绝**：不持久化 denied/expired 状态机，也没有独立拒绝端点；`expires_at` 到期后批准返回 409，未批准即 `approved_at is null`。不自动同意，超时不按“已拒绝”落库。
- **澄清问题**：频道问题回答未在 M3 接入；`run_questions` 本轮未加频道列。
- 只有 CAS 赢家写审计；并发输家不留下第二条批准记录。

### 3.4 @all 与唤醒

- 默认：**只有 @agent 才唤醒 agent**；没有 @ 的消息所有人可见、没有 agent 执行。
- `@all` 只通知人类成员；agent 只有在绑定上 `auto_wake_on_all = true` 时才被唤醒（默认 false）。
- `@agent` 唤醒该 agent lane；同一 lane 已有 queued/running 时，后续消息排队或合并（见 §8）。
- agent 之间可以 @ 另一个 agent；需要双方都是频道成员，且受深度/预算限制（见 §9）。

## 4. 事件与消息流

### 4.1 主流程

```text
人 POST /api/channels/:id/messages
  → 事务：成员/mentions 校验 + channel_messages（客户端幂等）
  → 每个目标 agent：
      admitChatRun(trigger='channel', channel: {channelId, channelMessageId})
      同事务取/建唯一 lane 并回写 channel_agent_bindings.conversation_id
      写 lane user message 与 agent_runs 的频道来源
      lane 忙碌则仅追加 system 提示，其他 lane 继续
  → worker：现有 run 管线（沙箱 → SDK → 事件）
  → 投影：助手 messages 与 channel_messages 同事务保存
  → Redis：message.created 唤醒 DB 补拉；run.started / run.finished 为实时提示
  → SSE：GET /api/channels/:id/events?after=<seq>
      DB 消息按 seq 回放，再订阅 Redis 频道流；不建 channel_events
```

### 4.2 事件信封（M2 当前实现）

M2 的 `ChannelEvent` 使用 shared 的 `type` 判别联合：`message.created` 带 `channelId` / `seq` / `message`，`run.started` 带 `channelId` / `runId` / `agentId`，`run.finished` 额外带终态 `status`；错误事件带 `message`。M3 只新增 `approval.requested { channelId, runId, approvalId, toolName }`，不新增 `eventId` 或事件表。以下信封与扩展事件列表仅为后续设计草案，不代表当前已实现能力。

```json
{
  "schemaVersion": 1,
  "channelId": "chn_...",
  "seq": 123,
  "eventId": "cevt_...",
  "type": "run.tool",
  "runId": "run_...",
  "actorType": "agent",
  "actorId": "agt_...",
  "payload": {},
  "createdAt": "2026-11-01T04:00:00.000Z"
}
```

事件类型（除 `message.created` / `run.started` / `run.finished` / `error` / `approval.requested` 外，以下均为后续草案）：

- 消息：`message.created` / `message.edited` / `message.deleted`
- 运行：`run.started` / `run.status` / `run.tool` / `run.todo` / `run.question` / `run.approval` / `run.finished`
- 成员：`member.added` / `member.removed` / `agent.joined` / `agent.left` / `agent.status`
- 频道：`channel.archived` / `channel.closed`
- 审批：`approval.requested` / `approval.decided`

流式 token 增量不落持久事件表；实时增量走 Redis，最终文本落 `channel_messages`，避免事件表被 token 撑爆。

### 4.3 去重与重放

- `dedupe_key` 必须持久化，不能只靠内存。
- 典型键：`client:<clientMessageId>`、`run:<runId>:tool:<toolUseId>`、`approval:<approvalId>:<decision>`、`im:<provider>:<eventId>`。
- SSE 用 `after=<seq>` 游标；断线重连先回放 DB，再接 Redis。
- 发现 `seq` 缺口时，重新拉取最近消息并合并，不伪造事件。
- 保留：没有 `channel_events` 表；频道实时事件只在 Redis Stream（1 小时 TTL，只做唤醒），持久时间线是 `channel_messages`，跟随现有消息保留策略。

## 5. 审批模型（M3 无持久状态机）

M3 不持久化 pending/approved/denied/expired 状态机，也不引入 `approval_key` 或独立计划审批：

- `approval_requests` 只记录 `approved_at` 与 `approved_by_business_id`；未批准即 `approved_at is null`。
- 批准先锁 run 行，再用条件更新（`where approved_at is null`）；已决定、已过期、run 非 queued/running 均返回 409，不自动同意。
- 不新建 `plan_approvals`；频道与私有对话的工具审批共用 `approval_requests`。
- 没有独立拒绝端点，也不新增持久拒绝/过期状态列；过期只按 `expires_at` 在读取和批准时判定。

## 6. 停止 / 断开 / 关闭

| 操作 | 语义 | 真实权限 | 当前实现 |
|---|---|---|---|
| Stop | 停止单条活动 run（没有频道级批量 stop 路由），保留已完成步骤与消息 | viewer 403；member 仅自己触发的 run；owner/admin 任意；非成员 404 | 锁频道与 run；复用 `cancelAgentRun`；queued 由 CAS 写 cancelled 并补发频道 `run.finished`；running 只发取消信号，终态由 worker 收尾；实际取消才写审计 |
| Disconnect | 暂停某个 agent 绑定，取消该 lane 的活动 run，不再接新任务；历史保留 | 仅 owner/admin；member 与 viewer 403；非成员 404 | 更新 binding 状态为 `disconnected`；P0 无频道 token，不做 token 撤销；写审计；批量取消失败保留断开状态并返回 503 可重试 |
| Close | 关闭频道；取消全部活动 run；拒绝新消息/新 run；只读 | 仅 owner；admin/member/viewer 403；非成员 404 | 锁频道行写 `channels.archived_at`；重复 close 幂等返回同一 `archivedAt`；不可逆；P0 不硬删；批量取消失败保留关闭状态并返回 503 可重试 |

竞态：发消息、触发 run、关闭频道、stop / disconnect / close 都要在事务内锁 `channels` 行并检查 `archived_at`；关闭赢家之后，落败的发消息/准入请求返回 409。忙碌提示在发现频道已关闭时不写系统消息（`postSystemMessage` 返回 `null`）。close / disconnect 先提交并保留频道状态，再逐条 best-effort 取消全部活动 run；单条失败继续处理其余 run，汇总后写 `status: 'error'` 审计并返回 503（`retryable: true`），不回滚频道状态，调用方可重试补停剩余 run。三项终审修复与第四项逐事件成员校验抛错修复均已实现并通过回归，独立 Opus 终审通过，M3 已闭合。

## 7. Token 模型

- **平台内 agent（P0）**：不新增频道 token。worker 继续使用现有 run 级 MCP token 与模型代理 token；频道绑定只决定“能不能被唤醒、能看哪个频道”。
- **外部 agent（P1）**：新增 `channel_agent_tokens`，只存 sha256；权限 receive/send/act/admin；`expires_at` 默认 8 小时，最长 7 天；可撤销；明文只展示一次。
- **IM（P1）**：provider bot secret 加密存储；按频道绑定；入站按 `event_id` 去重；出站用 provider API。
- 任何 token 都不写进频道消息、`.mcp.json` 或工作区文件。

## 8. 多频道会话与并行

- **一个 agent 在一个频道 = 一个 conversation lane**；同一个 agent 服务多个频道时是多个 lane，SDK 上下文不混。
- M2：各 agent lane 分别准入；同一频道可向不同 agent 分别入队，不加频道级串行限制（以本轮用户明确要求为准）。
- 后续并发仍受现有 `AGENT_MAX_CONCURRENT` 与沙盒容量约束；频道级新增上限需要后续明确需求。
- 不使用持久化流式 `query()`。继续沿用现有“每次 run 新建 query + resume”模型；流式输入的持久会话留作 P1 优化。
- M2 同一 lane 已有 queued/running 时写一条 system 提示并跳过唤醒，原人类消息保留；排队与合并留 P1。

## 9. Agent 间协作

- agent 输出里可以 @ 另一个 agent；路由器把它当作新的 mention，创建目标 lane 的 run，并带 `parent_run_id` / `context_id`。
- 限制：最大委派深度 3；每个频道每日委派预算；超过限制只记录 `agent.handoff.blocked`，不继续唤醒。
- 交接载荷：最近 N 条频道消息摘要 + 当前任务/artifact 引用 + 来源 runId；不复制整个频道历史。
- agent 之间不共享 SDK session；通过频道消息与 artifact 交接。

## 10. 部署与租户

### 10.1 P0 不做租户抽象

- **一套部署 = 一个 Workbody = 一家企业的全部数据**。P0 不引入 `org_id` / `tenant_id`，不加租户列，不改现有表结构去支持共享库多租户。
- 多企业 = 多套 compose（各自的 PostgreSQL / Redis / workspace / 端口），手动或脚本起，不做控制面调度。
- 现有账户与 RBAC（D-74）保留原样：同一 Workbody 内可以有多个账号和频道角色，但都属于同一家企业，不做跨租户鉴权。
- 租户隔离、开通/计费/资源配额等控制面能力，等真有第二家企业要用时再做；现在做等于给一个还不存在的需求写调度器。

### 10.2 沙盒约束（单机 / 单服务器）

现状：每个 `conversation` 一个常驻 supervisor 容器，空闲 `SANDBOX_IDLE_TIMEOUT_MS`（默认 5 分钟）回收，**没有容器数量上限**；每容器 `--memory 1g --cpus 1 --pids-limit 128`（上限，不是预留）。频道模式把「一个会话」放大成「频道 × agent lane」，这是唯一需要动的沙盒约束。

- **容器数量上限**：新增 `SANDBOX_MAX_ACTIVE`（默认 6）。超出时回收**最久未用且没有活动 run 的**容器；正在执行的永不回收，回收后下次 run 重建容器（现有复用路径已支持）。只改 `SessionSandboxes`，不改 provider。
- **资源默认值不变**：单机 8G 内存下，6 个空闲容器约 1–2G 实际占用，可接受。内存紧的机器靠 `SANDBOX_MEMORY` / `SANDBOX_MAX_ACTIVE` 调，不按租户分池。
- **主机工作区路径**：`HOST_WORKSPACES_DIR` 当前默认硬编码 `/var/lib/docker/volumes/agentport_workspaces/_data`，只在 rootful Docker + 项目名 `agentport` 下成立。修正方向是把它变成部署时必须显式给出、启动即校验的绝对路径（bind mount + `up.sh` 导出），不再靠猜命名卷目录；这一步随单机部署一起做，不在 M0。
- **出站**：默认 `SANDBOX_EGRESS=open`。云端 Workbody 接的是企业自己的数据，注入后外发是真实的数据丢失路径；单机阶段保持 open 方便开发，接入不受信内容时显式切 `none`，出站网关列 P1。

### 10.3 `D-16` 升级触发线

P0 保持 B 之前的 A（直接挂 socket）。满足任一条就换 B（`tecnativa/docker-socket-proxy` + `DOCKER_HOST`，改动只有 compose）：

1. API 对公网暴露，或出现本企业之外的使用者。
2. 运行导入的第三方智能体定义。
3. 这台机器上还有不属于本平台的数据或凭证。

频道模式本身不触发升级：频道里的人还是本企业的人，agent 还是自己定义的 agent。

## 11. API 与 UI

### 11.1 API

| 方法 | 路径 | 行为 |
|---|---|---|
| `POST` | `/api/channels` | 创建频道；创建者成为 owner |
| `GET` | `/api/channels` | 列出我有权限的频道 |
| `GET` | `/api/channels/:id` | 频道详情 + 成员 + agent 绑定 |
| `PATCH` | `/api/channels/:id` | 改名等管理操作（owner/admin） |
| `POST` | `/api/channels/:id/members` | 添加成员（owner/admin；默认 `member`） |
| `DELETE` | `/api/channels/:id/members/:businessId` | 移除成员（owner/admin；最后 owner 不可移除） |
| `POST` | `/api/channels/:id/agents` | 绑定 agent（owner/admin，且走现有 agent 对象授权） |
| `DELETE` | `/api/channels/:id/agents/:agentId` | 解绑 agent |
| `GET` | `/api/channels/:id/messages` | 消息列表（游标） |
| `POST` | `/api/channels/:id/messages` | 发消息；显式 mentions 校验后按 lane 准入 |
| `POST` | `/api/channels/:id/read` | 更新 `last_read_seq` 未读游标 |
| `GET` | `/api/channels/:id/events` | 频道 SSE，`after=<seq>`，成员撤权停流 |
| `GET` | `/api/channels/:id/runs` | 活动 run 列表；任意真实成员含 viewer |
| `GET` | `/api/channels/:id/runs/:runId/events` | 单 run SSE；任意真实成员含 viewer，撤权/终态处理 |
| `POST` | `/api/channels/:id/runs/:runId/stop` | 停止指定 run；member 仅自己触发，owner/admin 任意 |
| `POST` | `/api/channels/:id/agents/:agentId/disconnect` | 断开 agent；仅 owner/admin |
| `POST` | `/api/channels/:id/close` | 关闭频道；仅 owner，设置 `archived_at` 并取消全部活动 run |
| `GET` | `/api/channels/:id/approvals` | 待批频道审批列表；任意真实成员含 viewer |
| `POST` | `/api/channels/:id/approvals/:approvalId/approve` | 批准；触发者 member 或 owner/admin |

所有入口走 `requireAuth` + 频道成员角色校验；不新增 `channels.*` RBAC 叶。非成员统一 404，角色不足 403；错误形状沿用现有 API 约定。

### 11.2 UI

- 新导航：工作 → 频道 `/channels`；频道详情 `/channels/$channelId`。
- 现有 `/chat` 保留为私有对话；不把私有对话强行迁入频道。
- 频道页三栏：频道列表 / 消息时间线 / 成员与 agent 状态 + 产物/审批。
- 复用 `chat` 页的 `message-scroller`、`agent-avatar`、`openui-message`、`code-block`、`knowledge-citations`；不新造消息组件。
- 输入框支持 `@` 自动补全（人 + agent）、附件、发送；agent 卡片显示 idle/working/waiting approval/stopped；审批卡片内联；owner/admin 可断开 agent，仅 owner 可关闭频道（UI 后置，本轮未做）。
- 可访问性：新消息 `aria-live`、键盘可达、焦点返回、390px 无横向溢出；视觉遵循 `docs/DESIGN-SYSTEM.md`。

## 12. 迁移与兼容

- 只新增表与可空列；不重写现有 `conversations` / `messages` / `agent_runs`。
- 现有私有对话 `channel_id = null`，行为不变；频道是新增入口。
- M3 不新增 `approval_requests` 状态列，不做审批行回填；`channel_id` / `approved_by_business_id` 保持 nullable。
- 不做 feature flag；新路由独立，旧路由不动。回滚只需删除新表/新列与频道路由。
- 迁移后更新 `docs/ARCHITECTURE.md`、`docs/PROJECT-BRIEF.md` 的表说明（按 db 模块规则）。

## 13. 验证计划

### 13.1 单元 / 集成

- 权限矩阵：human/agent × role × action；viewer 只读；member stop/approve 仅自己触发的 run；disconnect 仅 owner/admin；close 仅 owner；最后 owner 不可移除；agent 不能 manage/close。
- Channel lane 隔离：频道 lane 不出现在 `/api/conversations`；第二个成员发言不会被 worker 判越权；首次触发者离开频道后 lane 仍可用。
- mention 路由：@agent 只唤醒目标；无 @ 不创建 run；@all 只通知人类；`auto_wake_on_all` 才唤醒 agent。
- 去重：重复 `clientMessageId`、重复 run 事件、重复审批决定只生效一次。
- 审批：并发批准只有一个赢家，输家 409；已过期、run 非活动返回 409；不做计划审批，不做拒绝/过期持久状态机。
- 停止/断开/关闭：Stop 只停目标 run；Disconnect 不再接新任务；Close 取消全部活动 run，之后发消息/准入 409，重复 close 幂等返回同一 `archivedAt`；批量取消的单条失败要可见，不能静默吞错。
- 事件重放：断线后 `after=<seq>` 完整回放，无重复、无缺口。
- 审计：每条频道动作有 actor（人/agent）、action、target、requestId。

### 13.2 真实运行

- 真实 PostgreSQL + Redis：建频道 → 加人/加 agent → 发消息 → @agent → run → 流式 → 审批 → 停止 → 重连回放。
- 两个人类 + 两个 agent：A @agent1，B 实时看到流式；agent2 不被唤醒；触发该 run 的成员与 owner/admin 可审批，其他成员 403；断开 agent1 后不再接任务。
- 浏览器 E2E：频道页、@补全、审批卡、停止、断开、刷新/重连、390px、无横向溢出。
- 安全：非成员读取 404/403；跨频道 token 无效；私信只有收发双方可见（P1）；prompt 注入按 sender 校验；agent 不能给自己加权限。
- 沙箱：单机部署，`SANDBOX_MAX_ACTIVE` 生效后超出上限的 lane 会重建容器，不得因此丢消息或重复 run。

### 13.3 交付门禁

- 按改动范围跑 typecheck / build / 相关 backend + web 套件；真实运行记录写入 `docs/tasks/`。
- 提交前独立 Opus 终审；未过不提交。
- 用户未授权时不 commit / push / merge；以未提交差异交付。

## 14. 实施切片

| 切片 | 内容 | 验收 |
|---|---|---|
| M0 | `SANDBOX_MAX_ACTIVE`（默认 6）+ 回收最久未用空闲容器 | 造 8 个会话超限后仍能正常执行，不丢消息不重复 run |
| M1 | 四张频道表 + 迁移 + 频道 CRUD/成员/agent 绑定/消息/未读/SSE（不含 agent 唤醒、不含 UI） | 两个账号同频道收发，实时可见，刷新按 `seq` 回放，未读数正确 |
| M2 | mention 路由 + agent lane + run 投影 + 频道路径准入改造 | @唤醒、无 @ 不跑、两个 agent 上下文不串、私有对话鉴权未被改坏 |
| M3 | 频道内工具审批（列表 + 批准）+ Stop/Disconnect/Close + 七端点成员权限 + 审计（不做计划审批） | 并发批准只有一个赢家；关闭竞态失败请求 409；停稳才写终态；批量取消失败返回 503 且可重试；三项终审修复与第四项逐事件成员校验抛错修复完成，`channels-control` 14/14；最终 26 文件 219 用例通过（0 failed / 0 skipped，12.74s），独立 Opus 终审通过，已闭合 |
| M4 | 频道 UI：列表、时间线、@补全、审批卡、agent 状态 | 真实浏览器跑通；390px 无横向溢出 |
| M5 | 去重/保留期/注入校验/断线回放 + 单机部署（工作区路径显式化） | 断线回放无缺口；`pnpm run up` 在单机可用 |

P1：外部 agent token、IM 适配、私信、出站网关、多机部署。

## 15. 需要用户拍板的决策

| 编号 | 决策 | 推荐 | 状态 |
|---|---|---|---|
| D1 | 租户模型 | **不做租户抽象**：一套部署 = 一个 Workbody；多企业 = 多套 compose | 已按用户 2026-11-01 方向调整 |
| D2 | 频道模型：A 新增 channel 对象 vs B 改造 conversations | A；私有对话保留为 1:1 | 待确认 |
| D3 | 并行：频道串行 vs lane 分别准入 | M2 各 lane 分别入队，同 lane 忙碌写 system 提示 | 已按用户本轮 M2 要求覆盖 |
| D4 | 工具审批人：仅 owner/admin vs 触发者 + owner/admin | 触发该 run 的 member + owner/admin；不做计划审批 | M3 已按此实现 |
| D5 | @all：只通知人类 vs 唤醒所有 agent | 只通知人类；agent 需 `auto_wake_on_all` | 待确认 |
| D6 | 外部 agent（Claude Code/Codex）接入 | P1，不进 P0 | 待确认 |
| D7 | IM（企微/飞书/钉钉）接入 | P1，不进 P0 | 待确认 |
| D8 | `D-16` 沙箱隔离 | 保持 A（单机自用直接挂 socket）；按 §10.3 三条触发线升级到 B | 待确认 |
| D9 | 沙盒容器上限 | 新增 `SANDBOX_MAX_ACTIVE`（默认 6），超出回收最久未用的空闲容器 | 待确认 |

若以上推荐默认被接受，下一步直接进入 S0 → S1；若 D1/D2/D8 有不同选择，先改本契约再实现。

## 16. 风险与未决

1. **Prompt 注入**：频道消息是不可信输入；必须按 `sender` 校验，不能按 `chat/thread` 校验。
2. **Agent 循环**：agent 互相 @ 可能无限循环；深度 3 + 每日预算 + 阻塞事件。
3. **扇出成本**：一个 @ 可能拉起多个 run；P0 频道串行 + 目标数上限（建议 3）。
4. **重复 run**：重试/重连可能重复触发；`dedupe_key` + 事务 + run 唯一约束。
5. **事件顺序**：多 lane 事件按 `channel_messages.seq` 排序；不要依赖时间戳。
6. **权限泄漏**：任何遗漏成员校验的旧路由都可能泄露历史；新增入口统一走真实频道成员角色校验，不新增 `channels.*` RBAC 叶，不改旧路由。
7. **审计主体**：agent 动作记录 `actorType=agent` + `agentId`，不能记成人类发起人。
8. **数据保留**：没有 `channel_events` 表；实时事件只在 Redis Stream（1 小时 TTL，只做唤醒），持久消息跟随现有保留策略；删除/归档要可审计。
9. **沙箱容量**：频道把会话放大成「频道 × lane」，没有容器上限会把单机内存吃满；按 §10.2 加上限并回收空闲容器。`docker.sock` 风险按 §10.3 的触发线管理，频道模式本身不触发升级。
10. **Cana token 期限冲突**：若做外部 agent token，按 8 小时默认、最长 7 天，不采用 “never until revoked”。

## 17. 参考

- 调研与来源：[channel-mode-research.md](channel-mode-research.md)
- 现有表定义：`packages/db/src/schema.ts`
- 现有聊天路由：`packages/api/src/features/chat/`
- 现有 worker：`packages/worker/src/`
- 审批：`packages/api/src/features/servers/mcp-endpoint.ts`
- 决策：`docs/DECISIONS-PENDING.md` D-16、D-18、D-74
- Agent SDK：https://code.claude.com/docs/en/agent-sdk/typescript

### 频道上下文增量注入实施记录（2026-11-01，M2/M3 后续增量）

- 目标：在频道 lane 的既有准入事务内，把游标之后、触发消息之前的频道消息增量拼入该 run 原有的一条 lane 用户消息；不新增频道消息、不改私有分支、不新增 API 入参或依赖。
- 基线：`ee4523d053ead56335d24f160d2b5d7d3accb489`；工作树 `/Users/xbjt/Documents/myself/agentport/.claude/worktrees/channel-mode` / `worktree-channel-mode`。M0-M4 及其他并发代理的未提交差异全部保留，本增量不覆盖、不提交 git。
- 数据契约：`channel_agent_bindings.context_seq bigint not null default 0`，一条绑定即一个 lane 的注入游标。迁移 `0050_worthless_lady_vermin.sql`（`ADD COLUMN "context_seq" bigint DEFAULT 0 NOT NULL`）；再次 `pnpm db:generate` 输出 `No schema changes, nothing to migrate`。
- 行为：准入在既有频道行锁、绑定行锁与授权内读取 `context_seq` 与触发消息 `seq`，只取 `context_seq < seq < trigger.seq` 的 human/agent/system 消息；`order by seq desc limit 21` 取最新 20 条（`CHANNEL_CONTEXT_MESSAGE_LIMIT=20`），超过 20 条时标记省略并反转升序。
- 格式：`【频道上下文】` / `成员 <businessId 后 6 位>：正文` / `智能体 <agentId>：正文` / `系统：正文` / `【当前消息】` + `input.message`。前缀（含分隔与省略提示、不含当前消息）不超过 `CHANNEL_CONTEXT_CHAR_LIMIT=8000`；超限从最早整条丢弃并加「更早的消息已省略」，单条超长时只保留省略提示。没有新消息时不注入，沿用原 content 表达式。
- 游标：准入只读取不推进；该 run 被确认执行后，在消息持久化事务内写 `Math.max(context_seq, trigger.seq)`。queued 取消、入队失败、开跑前拒绝都不消费上下文；旧触发不倒退。非频道路径与 `userContent` 自定义 content 原样保持不变。
- 真实注入字符串（db 集成测试实际值）：
  ```text
  【频道上下文】
  成员 -owner：first body
  智能体 agt_01m6b81f7zfqebykcjd0y89kmw：agent body
  系统：system body
  【当前消息】
  trigger body
  ```
- 红测：`pnpm exec vitest run packages/db/test/channels-m2.test.ts` → `Tests 7 failed | 17 passed (24)`（Start 17:42:44）。失败均为预期行为缺失：注入内容仍为纯 `message`、`contextSeq` 仍为 0；不是编译或环境错误。
- 绿测：同一命令 → `Test Files 1 passed (1)`、`Tests 25 passed (25)`（Start 17:43:50，2.24s）。覆盖游标推进、严格边界（触发消息及其后消息不入）、增量不重复、最近 20+省略、8000 字符裁剪、单条超长降级、无新上下文原 content、旧触发不倒退、viewer/忙碌/非成员失败不推进、私有普通与自定义 content 原样、常量值。
- 全量 db：`pnpm exec vitest run --project backend packages/db/test` → `Test Files 23 passed (23)`、`Tests 215 passed (215)`，23.17s（globalSetup 在全新随机 PG 库应用含 0050 的全部迁移）。
- 其他：`pnpm --filter @agentport/db typecheck` exit 0；改动 3 文件 Biome `No fixes applied`。
- 改动文件：`packages/db/src/schema.ts`、`packages/db/src/repo/chat.ts`、`packages/db/test/channels-m2.test.ts`、`packages/db/migrations/0050_worthless_lady_vermin.sql` 及 meta journal/snapshot；`docs/ARCHITECTURE.md`、`docs/PROJECT-BRIEF.md`、本记录。
- 未做/限制：未做 system 消息摘要，按原正文注入；字符上限按 JS UTF-16 code unit 计数；未运行真实付费模型端到端。API/web 由并行代理处理，本代理未改其文件。
- 下一步：无本增量代码待办；以验证完成的未提交差异交付，未合入、未提交 git。

### 频道模式终审与整体验证记录（2026-11-01，主会话汇总）

- 验证（主会话执行，均在本工作树）：全 7 包 typecheck 均 exit 0；核心 9 个测试文件 103 个用例全通过（22.04s），可复跑命令：`rtk bypass pnpm exec vitest run --project backend --no-file-parallelism packages/db/test/channels-m2.test.ts packages/db/test/channels-m3.test.ts packages/api/test/channels.test.ts packages/api/test/channels-mentions.test.ts packages/api/test/channels-control.test.ts packages/api/test/channels-approvals.test.ts packages/api/test/channels-run-access.test.ts packages/api/test/chat.test.ts packages/api/test/chat-admission.test.ts`（9 files / 103 tests，22.04s）；SSE 相关 4 个文件 33 个用例通过（22.80s）；worker 48 个用例以 `--no-file-parallelism` 串行通过——并行 worker 首跑为 1 失败 47 通过（lock 期望 1、实际 2），改用 `--no-file-parallelism` 复跑 48 个全通过，未改生产代码；OpenUI 6 个、web 频道状态 8 个通过；API 频道用例按先红后绿推进，最终 2 个文件 22 个用例通过。web 侧只做了 `canManage` 源码修正 + typecheck，未新增权限断言；聊天消息精确原文（不是子串匹配）那条是 `packages/api/test/chat.test.ts` 的 API 断言，不在 web 侧。
- 随机隔离库迁移实测：由主会话显式调用 `createIsolatedDatabase("channel_context_migrate")` 创建隔离库并应用含本次迁移的全部迁移，核对 `channel_agent_bindings.context_seq` 为 `bigint`、`not null`、默认 0，记录元数据检查与库删除均正常。测试 globalSetup 那次是另一条路径（globalSetup 也会应用迁移），不与本次显式核对混为一谈。
- 独立 Opus 终审结论：无逻辑与安全问题；待修项仅为注释/文档表述（即下方修正）。
- 本次已修：
  - `packages/db/src/repo/chat.ts`：删除两个常量与 `buildChannelContext` 的复述性 JSDoc，保留 `limit+1` 与 `Math.max` 游标原因的单行注释；`packages/db/src/schema.ts` 删除 `contextSeq` 的「已注入过」注释。
  - `docs/ARCHITECTURE.md`：`context_seq` 说明改为「记录最近一次已确认执行的 run 消费到的频道消息 seq」。该游标是**执行确认边界**：准入只读不写，只有 run 真正执行（消息持久化事务内）才推进，queued 取消与入队失败不会把未注入的上下文吞掉。仍需注意：当本次取到的上下文被 20 条上限或 8000 字符上限截断时，被截掉的更早消息不会注入，但游标会推进到触发消息 seq，因此这些消息不会被后续 run 再次补注入。
- 本次修正仅涉及注释与文档，无运行语义变化；Biome 只检查 `packages/db/src/repo/chat.ts`、`packages/db/src/schema.ts` 两个源文件。独立 Opus 聚焦复核已返回最终通过，无剩余阻塞；只读复核未重跑测试。
- 状态：验证完成的未提交差异，未合入、未提交 git；其余 M0-M4 记录与差异保持不变。

