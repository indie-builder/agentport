# 频道架构调研交接（2026-11-08）

> 基线：`main` @ `67725813`。只读调研，未改代码，未跑真实浏览器验收或压测。
> 范围：`packages/{api,contract,shared,db,worker,web}` 的频道实现，Claude Agent SDK 基座边界，主流多智能体协作模式对照。
> 结论供接手人排期使用，不是已确认的产品决策。

## 1. 一句话结论

频道实现没有方向性错误，核心数据模型、权限、幂等、SSE 回放和 run 复用都成立。它准确实现的是“人在回路的多智能体共享频道”，不是“agent 自主协作”。基于 Claude Agent SDK 的 per-session 模型，这是合理选择。接下来优先修多用户作者身份、唤醒可靠性、长频道性能，再补共享工作现场和多用户边界。

## 2. 已经做对的部分，不要重做

- 频道是一等对象，四张表职责清楚：`channels` / `channel_members` / `channel_agent_bindings` / `channel_messages`。一条绑定就是一个 agent lane，频道时间线以 `seq` 为唯一回放游标（`packages/db/src/schema.ts:553-644`）。
- 准入、lane 复用、上下文注入在同一个事务内完成，频道行锁串行化发消息和准入（`packages/db/src/repo/chat.ts:966-1198`）。
- 助手回复与频道投影同事务，`source_message_id` 唯一索引防重复；可重试的中间轮不投影到频道（`packages/worker/src/messages.ts:367-409`）。
- 权限收口在真实成员关系上：平台管理员非成员也是 404，viewer 只读，最后一个 owner 不能移除，审批 CAS 串行化（`packages/db/src/repo/channels.ts:46-64,283-325`；`packages/db/src/repo/channel-approvals.ts:81-170`）。
- DB 是权威，Redis Stream 只做唤醒；发布失败只记日志，SSE 从 DB 按 `seq` 回放；上下文游标只在 run 真正执行后推进（`packages/api/src/queue/producer.ts:169-190`；`packages/worker/src/messages.ts:420-432`）。
- 复用现有执行链路 `admitChatRun → BullMQ → sandbox → Claude Agent SDK`，没有第二套执行循环。
- 测试覆盖强。频道相关 API、DB、worker 套件有 500 多个用例，真实模型业务 E2E 7/7，浏览器回归覆盖建频道、@、流式、停止、审批、未读和刷新恢复。

## 3. 问题清单

优先级说明：
- P0：多用户实际使用会立刻踩到，或属于安全/隐私边界。
- P1：可靠性、性能或产品闭环缺口。
- P2：产品增强或边角问题。

### CH-01 P0 人类消息没有作者身份，且会强制滚到底

**证据**
- `packages/web/src/pages/channel.tsx:184-186` 把所有 `human` 消息映射成 `{ kind: 'user' }`，丢弃 `authorBusinessId`。
- `packages/web/src/components/chat-thread.tsx:773` 对 user 消息右对齐；`:781` 读屏固定读“用户”。
- `packages/web/src/components/chat-thread.tsx:667,1087-1096` 任何新的末尾 user 项都会 `scrollToEnd()`。

**影响**
多人群聊里每个人的消息都像自己发的，没有头像、名字或作者信息。别人发言会把正在阅读的人强行拉到底部。频道作为多人协作界面直接失真。

**建议**
给 `ChatItem` 的 user 分支增加可选的作者信息；频道渲染时，本人右对齐，他人左对齐并显示名称/头像。`ScrollToLatest` 只对本人发送的消息或显式“回到底部”生效。成员显示名需要 API 返回，当前 `channelMemberSchema` 只有 `businessId`。

**验收**
两个账号同频道，各自发言后双方都能看到对方左对齐的作者消息；他人发言不改变当前滚动位置；读屏能读出作者。

### CH-02 P0 多用户记忆边界没有闭合

**证据**
- `packages/worker/src/index.ts:694-703` 频道 run 不注入触发者个人记忆，但仍使用 agent 的专家记忆策略。
- `docs/ARCHITECTURE.md:418` 明确说明专家与子智能体记忆按专家目录共享，频道里仍能读到，不能宣称私人信息完全隔离。
- `docs/DECISIONS-PENDING.md` D-74 已合入多账户和 RBAC；专家 auto-memory 共享语义保留。

**影响**
同一 agent 在频道和私聊之间共享记忆。多用户频道里，一个用户私聊中积累的信息可能出现在另一个用户的频道回答中。当前没有频道级记忆，也没有频道 run 的记忆写入策略。

**建议**
先做产品决策：频道 run 是否允许写专家记忆；默认建议只读，或引入频道级记忆。至少要在多用户上线前明确并在 UI/文档中提示。不要在没有决策前继续扩大频道使用范围。

**验收**
产品负责人确认策略；代码有对应开关或只读挂载；测试覆盖频道 run 的读写边界。

### CH-03 P0 多用户沙盒隔离仍是 D-16 方案 A

**证据**
- `docs/DECISIONS-PENDING.md` D-16：worker 挂 `docker.sock`，等价宿主 root；2026-10-31 备注已把“引入多用户”列为升级触发条件。
- 当前频道是多用户功能，成员可以是不同账户。

**影响**
多用户频道上线前没有 socket proxy、独立沙盒节点或 microVM，不能宣称生产安全。

**建议**
多用户上线前按 D-16 重新评估，至少做 B 方案 socket proxy；有外部用户或第三方 agent 时再评估 C/D。属于部署门槛，不是频道代码缺陷。

**验收**
部署清单明确升级方案；多用户环境不使用直挂 socket 的 worker。

### CH-04 P1 唤醒和入队不是原子的，崩溃窗口没有补偿

**证据**
- `packages/api/src/modules/channels/router.ts:312-378` 先提交频道消息，再逐个 agent 调 `admitChatRun` 和 `queue.add`。
- `packages/db/src/repo/channels.ts:602-603` 同一 `clientMessageId` 重放返回 duplicate，`wakeAgentIds` 为空。
- `packages/api/src/modules/runs/enqueue.ts` 入队失败只把 run 置 failed，不写频道提示。

**影响**
消息已保存但没有任何 run；多个 agent 中途失败时前面的 run 已入队而后面的没有，接口返回 503；用户重试不会补唤醒；刷新后频道里只有一条 @ 消息，没有失败提示。

**建议**
引入持久化 wake intent 或 outbox，例如 `channel_message_wakes(channel_message_id, agent_id, status)`，消息和唤醒意图同事务写入；消费者幂等准入；失败可重试。至少给 `(channel_id, channel_trigger_message_id, agent_id)` 加唯一约束，防止同一触发消息生成重复 run。入队失败写 system 消息。

**验收**
模拟消息提交后进程崩溃，重启后能恢复未处理的唤醒；同一 `clientMessageId` 重试不产生第二条消息或第二个 run；入队失败在频道里有可见提示。

### CH-05 P1 发送失败会丢 @，重发会产生重复消息

**证据**
- `packages/web/src/pages/channel.tsx:264` 每次发送都生成新的 `crypto.randomUUID()`。
- `:279-293` 发送即清空 `mentions`，失败只恢复 `input`，不恢复 `mentions`。
- `packages/web/src/lib/channel-state.ts:51-56` `pruneMentions` 依赖当前 `mentions` 列表。

**影响**
网络失败后用户重发，@ 目标丢失，agent 不被唤醒；或者服务端其实已保存消息，重发生成新 `clientMessageId`，频道出现两条相同消息。

**建议**
失败时恢复 `mentions`；同一次发送的重试复用同一个 `clientMessageId`；对“消息已保存但入队失败”的情况给出明确提示和重试入口。

**验收**
断网重发后 @ 目标仍在；服务端已保存但响应丢失时重试不产生重复消息。

### CH-06 P1 撤权不取消进行中的 run，控制按钮也没有权限门禁

**证据**
- `packages/db/src/repo/channels.ts:283-325` `removeMember` 只删成员行。
- `:407-437` `removeAgentBinding` 只删绑定行。
- `packages/api/src/modules/channels/control.ts:104-173` `disconnect` / `close` 会取消活动 run，和移除语义不一致。
- `packages/web/src/pages/channel.tsx:754-817` 对所有成员渲染“停止”和“批准”。
- `packages/api/src/modules/channels/control.ts:21-35` 活动 run DTO 不返回 `initiatedBy`，前端无法判断。

**影响**
被移除成员触发的 running run 继续执行并写入频道；普通 member 或 viewer 看到可点的按钮，点击后必然 403。

**建议**
`removeMember` / `removeAgent` 复用批量取消逻辑，或者在活跃 run 期间阻止移除。`activeRuns` 返回 `initiatedBy`；前端按角色和触发者控制停止/批准入口。

**验收**
移除成员或 agent 后其活动 run 被取消或移除被拒绝；viewer 看不到停止/批准；member 只能停自己触发的 run。

### CH-07 P1 agent 回复不更新频道列表时间

**证据**
- `packages/worker/src/messages.ts:367-408` 投影 agent 回复时只写 `channel_messages`，不更新 `channels.updated_at`。
- `packages/db/src/repo/channels.ts:121` 列表按 `updatedAt` 排序；`:584-586,631-634` 只有人类消息和 system 消息会 bump。
- `packages/web/src/pages/channels.tsx:194,272` 用 `updatedAt` 显示“更新时间”。

**影响**
频道卡片显示 agent 的最新回复正文，却配一个很久以前的相对时间；列表不会因 agent 回复上浮。

**建议**
投影回复时同事务更新 `channels.updatedAt`，或列表排序和显示改用 `lastMessage.createdAt`。

**验收**
只有 agent 回复的频道，列表时间和排序会更新。

### CH-08 P1 扇出没有频道级上限

**证据**
- `packages/shared/src/channels.ts:130` `mentions` 最多 50 个。
- 没有频道绑定数、每条消息唤醒数或频道级活跃 run 上限。
- `packages/worker/src/config.ts:46-47` worker 并发默认 2，沙盒上限默认 6；`packages/shared/src/run-stream.ts:8` 队列等待上限 100。
- 仓库最初的频道调研（`98e1159f`）建议目标数上限 3。

**影响**
一次 @50 个 agent 可以瞬间占满共享队列，私聊 run 被挤在后面；`mentionAll` 在多个 opt-in 绑定下同样放大成本。

**建议**
每条消息 mention 数限制在 3 到 5 个；加频道级活跃 run 配额；需要更大扇出时走明确的产品入口和预算。

**验收**
超限请求被拒绝或排队并给出明确提示；@all 不能绕过上限；压测确认不会挤占私聊队列到不可接受的程度。

### CH-09 P1 长频道首屏和回放策略不可扩展

**证据**
- `packages/web/src/lib/queries.ts:2988-2998` 固定 `after: 0, limit: 200`。
- `packages/db/src/repo/channels.ts:462-483` 升序返回最旧 200 条。
- `packages/web/src/lib/use-channel-stream.ts:71-78` 从已加载尾条开始 SSE。
- `packages/api/src/modules/channels/router.ts:468-495` catch-up 循环回放剩余全部。
- `packages/web/src/pages/channel.tsx:467-469` `hasOlder=false`，没有更早分页。

**影响**
频道超过 200 条后，首屏展示最旧 200 条，再靠 SSE 把剩余全部补到客户端。频道越大打开越慢，内存和 DOM 无界，刷新后重复全量回放。没有“跳到未读”。

**建议**
契约增加 `before` 或 `latest`；首屏取最新一页，向上加载更早；SSE 从最新页之后开始。长列表考虑虚拟化或至少限制初始回放。

**验收**
1000 条消息的频道打开时先看到最新一页；向上滚动能加载更早；打开不触发全量回放。

### CH-10 P1 频道 SSE 的轮询和成员校验成本过高

**证据**
- `packages/api/src/modules/channels/router.ts:513-520` 无论 Redis 是否正常，每 3 秒执行一次 `catchUp`。
- `:449-467` 每条回放消息都调用 `getChannelReadAccess`。
- `packages/api/src/modules/channels/control.ts:312-360` 频道 run SSE 对每个事件做一次成员校验。
- `packages/db/src/repo/channels.ts:646-681` `markRead` 每次拿频道行锁并查 `max(seq)`。

**影响**
每个频道观众每 3 秒至少一次 DB 查询；长回放是 N 次成员校验；已读操作和发消息/准入互相抢频道行锁。观众越多，DB 压力线性增长。

**建议**
Redis 订阅正常时停止无条件 DB poll，只在订阅失败时启用；消息回放按页做一次成员校验；run 流保留撤权检查但可缓存短时结果；`markRead` 不需要频道行锁，更新成员行即可。

**验收**
Redis 正常时无 3 秒 DB poll；撤权仍能及时停流；压测确认观众数增长时 DB QPS 可控。

### CH-11 P1 共享工作现场只到文本，不到执行证据和产物

**证据**
- `packages/worker/src/messages.ts:164-178` 频道只投影主助手文本，子智能体、工具调用、产物不投影。
- `packages/api/src/modules/runs/access.ts:19` 频道 run 被 `/api/runs` 拒绝。
- `packages/db/src/repo/chat.ts:146` 私有会话入口隐藏频道 lane。
- `packages/web/src/pages/channel.tsx:462-522` 没有提问回答、run 详情、产出入口，`openUi={false}`，`canAttach={false}`。

**影响**
刷新后频道里只剩一段文本，看不到 agent 做了什么、产出了什么、为什么失败。频道在 AskUserQuestion 场景下无法回答。生成文件挂在 lane conversation，频道成员无法访问。与“共享工作现场”的产品定位不符。

**建议**
增加频道级 run 详情、提问回答和 outputs/artifact 入口；或者在多用户频道明确禁用 AskUserQuestion，把提问转成普通消息。产物建议做成频道可见的 artifact，而不是只能留在 lane。

**验收**
频道 run 的提问可以在频道内回答；产出文件可从频道查看和下载；失败 run 在频道有可见记录。

### CH-12 P1 审批缺参数，审计不完整

**证据**
- `packages/db/src/schema.ts:791-824` `approval_requests` 只有 `serverId` / `toolName`，没有工具参数。
- `packages/api/src/modules/servers/mcp-endpoint.ts:49-55` `onApprovalRequired` 只收到 `toolName` / `expiresAt`。
- `packages/db/src/repo/audit.ts:10-12` `actorKind` 只有 `user` / `service` / `anonymous`，没有 agent。
- `packages/api/src/modules/channels/router.ts` 的 create / update / 成员 / 绑定 / 发消息没有审计写入。

**影响**
频道成员在看不到工具参数的情况下批准工具调用。共享频道的审计链不完整，无法回答谁改了成员、谁绑定了 agent、谁发了什么。

**建议**
审批行保存脱敏后的工具参数摘要，并在频道审批卡展示；补 create / update / 成员 / 绑定 / 发消息审计；审计主体增加 agent 类型，至少记录 `agentId`。

**验收**
审批卡能看到将要执行的关键参数；频道管理动作和发消息能在审计里查到；agent 动作不再只记成触发者或 worker。

### CH-13 P1 频道控制面在 UI 缺失

**证据**
- `packages/contract/src/channels.ts:49-140` 有 update / addMember / removeMember / removeAgent / disconnect / close。
- `packages/web/src/lib/api.ts:1139-1166` 没有这些方法。
- `packages/web/src/pages/channels.tsx` 新建频道只有名称/描述；`packages/web/src/pages/channel.tsx` 只能绑定 agent、停止 run、审批。

**影响**
产品界面无法建出多人群聊，也无法改名、改描述、加/移除成员、关闭频道、断开或移除智能体。频道生命周期只能靠 API 完成。

**建议**
按产品优先级补控制面 UI。至少先补成员管理、关闭频道和断开/移除智能体，否则频道无法作为产品功能交付。

**验收**
管理员能在 UI 完成建频道、加成员、改角色、改名、关闭、断开/移除 agent。

### CH-14 P2 死状态和未暴露能力

**证据**
- `packages/db/src/schema.ts:598-602` 绑定状态包含 `paused`，但全仓没有写入路径；`packages/web/src/pages/channel.tsx:861-871` 却渲染“已暂停”。
- `packages/shared/src/channels.ts:112-134` 支持 `autoWakeOnAll` / `mentionAll`，Web 没有设置入口或 @all 选项。

**影响**
用户会看到一个永远不可达的状态；@all 能力存在但产品不可用。按项目零死代码规则，二选一：实现或删除。

**建议**
删除 `paused`，或补暂停/恢复入口；决定 @all 是否作为产品能力，补 UI 或移除后端入口。

**验收**
状态和入口与产品能力一致，没有不可达分支。

### CH-15 P2 流式边角：旧游标、漏终态、重试重复

**证据**
- `packages/api/src/modules/channels/router.ts:156-158` SSE 只写 data，不写 `id:`；`packages/web/src/lib/use-channel-stream.ts:48,95` 游标只存在内存 ref，重连复用构造时的 URL。
- `packages/web/src/lib/use-channel-stream.ts:132-195` `runs.data` 不再包含某 run 时只关闭 EventSource，不删除 `streams` 条目。
- `packages/web/src/pages/channel.tsx:219-221` 频道流 items 没有 user 边界；`packages/web/src/lib/chat-state.ts:112-114,314-322` `run_started` 依赖 user 项清旧 attempt。

**影响**
断线重连可能用旧游标重复回放；漏掉终态的 run 会永久显示“运行中”；基础设施重试时频道流式正文可能重复。

**建议**
频道 SSE 写 `id: <seq>` 并支持 `Last-Event-ID`；run 流同理；runs 查询不再包含某 run 时清理对应 `streams` 条目；给频道流加合成 user 边界或单独处理 `run_started`。

**验收**
断线重连不重复全量回放；漏终态的 run 最终被清理；重试时频道只显示最终正文。

### CH-16 P2 列表 N+1、已关闭频道和描述

**证据**
- `packages/web/src/pages/channels.tsx:61-64` 为每个频道额外请求 detail 来取成员/智能体数量。
- `:126-135,150-208` 已关闭频道仍混在列表里。
- `packages/web/src/pages/channel.tsx` 详情页不显示 `channel.description`。

**影响**
频道多时请求数线性增长；已关闭频道没有过滤；描述信息在详情页丢失。

**建议**
把成员/智能体计数放进列表查询；加“只看进行中”或默认过滤；详情页显示描述。

**验收**
列表只发一个请求；已关闭频道有明确过滤方式；详情页显示描述。

### CH-17 P2 agent 身份和频道级权限

**证据**
- `packages/api/src/modules/channels/router.ts:335-342` 频道 run 的 subject 是触发者用户。
- `packages/db/src/repo/audit.ts` 没有 agent actor 类型。
- 仓库最初的频道调研建议“agent 身份独立，人类与 agent 不共享身份”；当前 P0 没有频道 token。

**影响**
同一个 agent 在不同成员的 @ 下以不同平台身份执行，权限复核、审计和个人记忆边界跟着触发者走；没有频道级 access 范围，任何 member 都能触发所有已绑定 agent 的工具能力。

**建议**
多用户正式上线前评估 agent 独立身份、频道级 token、actorType=agent 和 per-channel access。不要在没有审计和隔离的情况下扩大成员范围。

**验收**
agent 动作有独立审计主体；频道成员触发 agent 时权限来源明确；跨频道/跨成员边界有测试。

### CH-18 P2 一个 agent 一个频道 lane，无法并行任务

**证据**
- `packages/db/src/repo/chat.ts:1148-1158` 同一 lane 有 queued/running 时拒绝新 run。
- `packages/api/src/modules/channels/router.ts:343-352` 忙碌 lane 写 system 提示并跳过。
- 对照 Claude Tag：频道有自己的 session，长任务在消息下开 thread session，每个 thread 独立。

**影响**
同一 agent 在同一频道同时接到两个任务时只能串行，第二个被拒绝；不适合“一个频道里并行推进多个任务”的产品形态。

**建议**
需要并行时引入 thread 或 per-task session，每个 thread 独立 session/容器；这是数据模型级改动，不要用“加个开关”解决。现阶段把忙碌提示写清楚，并把它作为已知限制。

**验收**
产品明确当前是串行模型；若做并行，thread 级 run 隔离和资源上限有测试。

### CH-19 P2 agent 到 agent 协作、任务板和共享产物

**证据**
- `packages/db/src/repo/channels.ts:490-530` 只从人类消息解析 mentions；agent 回复不触发 run。
- 没有共享任务表、mailbox、artifact 表；每个 conversation 独立 workspace/outputs。
- 官方 Agent Teams 在 Agent SDK 非交互模式不可用；Managed Agents 是托管产品；跨 session messaging 只发纯文本且同机/同容器可达，频道 lane 各在独立容器。

**影响**
当前是“人驱动频道”，不是“agent 自主协作”。如果产品文案承诺自主协作，会形成语义落差。

**建议**
先做产品决策。轻量方向是“agent 建议交接，人确认后唤醒”；中等方向是可选 coordinator lane；完整群聊引擎不建议现在做。所有方案都走现有 DB/队列，不引入第二套执行循环。

**验收**
产品定位和 UI 文案一致；如果做 handoff，必须有确认步骤、深度/预算上限和终止条件。

## 4. 待产品确认的决策

1. 频道定位是“人驱动共享频道”还是“agent 自主协作”。这决定 CH-19 做不做。
2. 频道 run 是否允许写专家记忆；默认建议只读或频道级记忆。
3. 是否近期开放多用户。如果是，CH-02、CH-03、CH-17 必须先排。
4. 是否允许一个 agent 并行处理多个任务。如果是，CH-18 的 thread/session 模型要先设计。
5. @all 是否作为产品能力；如果否，删除 `mentionAll` / `autoWakeOnAll` 的 UI 期望。

## 5. 建议实施顺序

第一批，低成本高收益：
- CH-01 作者身份和滚动。
- CH-07 agent 回复更新时间。
- CH-05 发送失败保留 @、复用 clientMessageId。
- CH-06 控制按钮权限门禁和撤权取消。
- CH-15 流式条目清理和 SSE 游标。

第二批，可靠性和性能：
- CH-04 唤醒 outbox。
- CH-08 扇出上限。
- CH-09 长频道分页。
- CH-10 SSE 轮询和成员校验优化。
- CH-12 审批参数和审计。

第三批，产品闭环：
- CH-11 频道工作现场。
- CH-13 控制面 UI。
- CH-14 死状态和 @all。
- CH-16 列表和描述。

第四批，多用户和能力升级：
- CH-02 记忆策略。
- CH-03 D-16。
- CH-17 agent 身份和权限。
- CH-18 thread/per-task session。
- CH-19 agent 协作，只在有真实需求时做。

## 6. 验证与风险

- 本次是只读调研，没有改代码，没有跑真实浏览器视觉验收或压测。
- 前端结论来自代码路径和独立只读审查，实际观感需要浏览器确认。
- 性能结论是代码路径推断，真正确认需要压测。
- 仓库现有测试覆盖强，但不覆盖多用户 UI、长频道和跨用户记忆场景。
- 参考资料：
  - 官方 Agent Teams：https://code.claude.com/docs/en/agent-teams
  - Agent SDK Subagents：https://code.claude.com/docs/en/agent-sdk/subagents
  - Agent SDK Sessions：https://code.claude.com/docs/en/agent-sdk/sessions
  - Cross-session messaging：https://code.claude.com/docs/en/cross-session-messaging
  - Claude Tag：https://claude.com/docs/claude-tag/concepts/how-it-works
  - Anthropic 多智能体研究：https://www.anthropic.com/engineering/multi-agent-research-system
  - Managed Agents 多智能体：https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration
  - OpenAI Agents SDK 多智能体：https://openai.github.io/openai-agents-python/multi_agent/
  - AutoGen AgentChat teams：https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html
  - Slack AI agents：https://slack.com/help/articles/33076000248851
  - Slack agent context management：https://docs.slack.dev/ai/agent-context-management

## 7. 交接检查

- [ ] 产品确认频道定位和多用户上线时间。
- [ ] 先修 CH-01、CH-05、CH-06、CH-07、CH-15。
- [ ] 再排 CH-04、CH-08、CH-09、CH-10、CH-12。
- [ ] 多用户上线前完成 CH-02、CH-03、CH-17。
- [ ] 决定 CH-18、CH-19 是否进入 roadmap。

## 8. 本批实施状态（2026-11-08）

第 3 节的清单已有第一批落地；这里只记进度口径，具体行为以最终代码与 PR 为准。

**已实施**
- CH-01：作者身份、他人消息左对齐、只对本人发送强制滚底。
- CH-05：失败重试复用 clientMessageId，失败清乐观项并恢复输入。
- CH-06：移除成员/移除智能体取消活动 run，停止与审批按 owner/admin/member 归因门禁。
- CH-07：agent 回复投影同事务更新频道 updatedAt。
- CH-08：单条消息最多唤醒 5 个，mentionAll 解析超限整条拒绝。
- CH-09：首屏最新一页 + before 游标向上分页。
- CH-13：频道设置对话框，含基本信息、成员增删与角色、智能体绑定/断开/移除、关闭频道。
- CH-16：列表计数进列表查询，去掉 N+1；详情显示描述。

**部分实施**
- CH-10：频道 SSE 增加 Last-Event-ID 续传，Redis 订阅正常时兜底轮询降到 30 秒、失败回 3 秒；逐消息成员校验出于撤权安全保留，未去掉。
- CH-15：切频道清理流、活动 run 消失标 done、run_started 重放清空；旧游标/漏终态已有复核路径。

**延后**
- CH-02（记忆边界需产品决策）、CH-03（D-16 部署方案）、CH-04（wake outbox）、CH-11（共享工作现场）、CH-12（审批参数与审计）、CH-14（paused/@all）、CH-17（agent 身份）、CH-18（thread/per-task session）、CH-19（agent 自主协作）。

本批没有新增表或迁移，没有引入 wake outbox，没有改变频道的“人驱动共享频道”定位。

延期项的按功能维度取舍见第 9 节。§8 中「没有引入 wake outbox」是上一批历史状态，CH-04 已在 D-80 后落地。

## 9. 按功能维度的延期取舍（2026-11-09）

> 本节是第 8 节「延后」清单的取舍落档，不改写第 1-8 节的调研事实与实施记录。
> 前提：本项目实际形态是单机自用、内部小团队多账户（D-74）；D-21 暂不对外；D-16 方案 A 已接受。市面功能为外部多租户设计，取舍先过这道闸。
> 每条的「市场事实」指外部产品或官方文档的可核对做法；「本项目判断」指基于上述前提对当前项目应做与否的结论。

**取舍总览**

| 条目 | 结论 | 规模 | 排期 / 条件 |
|---|---|---|---|
| CH-04 唤醒可靠性 | 做 | M | 排第一 |
| CH-12 审批参数与审计 | 做 | M | 第二 |
| CH-11 共享工作现场 | 轻量版 | M | 第三；全量投影不做 |
| CH-02 记忆边界 | 只读策略 | S | 第四；频道级记忆缓做 |
| CH-14 死状态与 @all | 拆两半 | S | 第五 |
| CH-17 agent 身份 | 最小版 | M | 第六；完整版挂「对外」条件 |
| CH-03 沙盒隔离 | 维持 D-16 方案 A | — | 挂「对外」条件，不提前做 |
| CH-18 线程 / 并行 | 暂不做 | — | 写成已知限制 |
| CH-19 A2A 协作 | 不做 | — | 真需要时只做人工确认的 handoff |

### 9.1 CH-04 唤醒可靠性：做，M，排第一

- 市场事实：Slack Events API 对失败投递做重试，并用 `event_id` 去重（https://docs.slack.dev/apis/events-api/）；AWS 推荐 Transactional Outbox 模式，把业务数据和待发送消息同事务落库，再由独立流程可靠投递（https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html）。
- 本项目判断：唤醒与入队不是原子的，崩溃窗口没有补偿，直接导致「消息已保存但没有 run」，属于内部多账户也会真实踩到的可靠性缺口，应做且排第一。
- 做法：新增 `channel_wakes` 表，与频道消息同事务落库；`(channel_message_id, agent_id)` 唯一约束；补偿扫描补触发未完成的唤醒；失败写系统提示。`agent_runs` 再加 `(channel_id, channel_trigger_message_id, agent_id)` 部分唯一索引兜底。
- 代码事实：频道消息与 `channel_wakes` 行同事务落库后，请求路径调用 `dispatchChannelWakes`，再逐条认领并调 `admitChatRun` 和 `queue.add`（`packages/api/src/modules/channels/router.ts:372-380`、`packages/api/src/modules/channels/wakes.ts:187-228`）；入队失败处理在 `packages/api/src/modules/channels/wakes.ts`；同一 `clientMessageId` 重放返回 duplicate、`wakeAgentIds` 为空（`packages/db/src/repo/channels.ts:704-716`）。

### 9.2 CH-12 审批参数与审计：做，M

- 市场事实：GitHub PR review 在批准前展示 diff（https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews）；Asana AI Action Log 记录 agent 动作（https://www.asana.com/inside-asana/ai-agents-built-for-teams-context-transparency）；ChatGPT workspace agents 的审批动作可配置（https://openai.com/index/introducing-workspace-agents-in-chatgpt/）。
- 本项目判断：内部共享频道里，成员在看不到工具参数的情况下批准调用，且管理动作没有审计链，收益明确、成本可控，应做。
- 做法：`approval_requests` 增加可空脱敏参数列；频道 create / update / 成员 / 绑定 / 发消息补审计；`audit` 的 `actorKind` 增加 `agent`。采用最小审计，不依赖完整 CH-17。
- 代码事实：`approval_requests` 只有 `serverId` / `toolName`，没有工具参数（`packages/db/src/schema.ts:829-863`）；`actorKind` 只有 `user` / `service` / `anonymous`（`packages/db/src/repo/audit.ts:12`、`packages/db/src/schema.ts:982`）；频道 create / update / 成员 / 绑定 / 发消息未写审计（`packages/api/src/modules/channels/router.ts`）。

### 9.3 CH-11 共享工作现场：轻量版，M

- 市场事实：Linear Agent 用 activity 类型记录过程（https://linear.app/developers/agent-interaction）；Claude Tag 在线程内展示 checklist 与产物（https://claude.com/docs/claude-tag/concepts/how-it-works）；GitHub Copilot coding agent 提供 session 日志（https://docs.github.com/en/enterprise-cloud@latest/early-access/copilot/coding-agent/responsible-use-of-copilot-coding-agent）。
- 本项目判断：频道定位是共享工作现场，但全量投影工具调用和子智能体是 L 级改动，且与 CH-18 的 thread/session 设计重复；先做轻量版即可闭合「看得到过程、答得了提问、拿得到产物」。
- 做法：提供频道作用域的 run 详情、提问回答与 outputs 读取，复用现有 `getRunDetail` / `questionsRepo` / `listOutputFiles`，授权按频道成员判断；不做工具 / 子智能体全量投影进频道时间线。
- 风险：频道 lane 内容可能含触发者私有上下文，共享范围需产品确认。
- 代码事实：`getRunDetail` 在 `packages/db/src/repo/runs.ts:657`；`questionsRepo` 在 `packages/api/src/modules/runs/questions.ts:11`；`listOutputFiles` 在 `packages/api/src/modules/chat/outputs.ts:2,138`；频道 run 被 `/api/runs` 拒绝（`packages/api/src/modules/runs/access.ts:19`）；频道只投影主助手文本（`packages/worker/src/messages.ts:164-178`）。

### 9.4 CH-02 记忆边界：只读策略，S

- 市场事实：ChatGPT in Slack 不带入个人 memory（https://help.openai.com/en/articles/12462158）；Asana memories 遵守任务隐私（https://help.asana.com/s/article/understanding-access-control-for-ai-teammates）；Claude Tag 把频道 notes 与 workspace notes 分层（https://claude.com/docs/claude-tag/concepts/how-it-works）。
- 本项目判断：内部多账户频道的记忆写入边界必须先收紧；频道级记忆是新产品能力，当前没有真实需求，缓做。只读策略成本最小且能消除「一个用户私聊信息出现在另一个用户频道回答中」的主要风险。
- 做法：频道 run 强制专家记忆只读（worker 挂载时用 `readOnly` 覆盖，提示词同步说明只读）；文档与 UI 写明限制；频道级记忆缓做。
- 代码事实：频道 run 已排除触发者个人记忆（`packages/worker/src/personal-memory.ts`）；专家记忆仍按 agent 记忆策略共享（`packages/worker/src/index.ts:686-703`、`docs/ARCHITECTURE.md:419`）。

### 9.5 CH-14 死状态与 @all：拆两半，S

- 第一半，删除 `paused` 死状态：本项目判断是删除。全仓没有 `paused` 的写入路径，唯一的状态写入是 `disconnected`，违反零死代码；`paused` 只存在于 schema、类型和「已暂停」展示中。
- 代码事实：绑定状态枚举含 `active` / `paused` / `disconnected`，默认 `active`（`packages/db/src/schema.ts:598-602`）；插入绑定时不写状态（`packages/db/src/repo/channels.ts:496-500`）；唯一状态更新为 `disconnected`（`packages/db/src/repo/channel-control.ts:129-137`）；前端仍渲染「已暂停」（`packages/web/src/pages/channel.tsx:928,933`、`packages/web/src/components/channel-settings.tsx:62`）。
- 第二半，保留 @all 并补人工 UI 入口：市场事实是 Slack `@channel` 仅限人工发送且需确认影响人数（https://slack.com/help/articles/202009646-Notify-a-channel-or-workspace），Teams 的 @all 需 owner 开启。本项目判断是保留而不是删除，因为后端能力已存在且限制明确；当前缺的是人工入口与提示。
- 代码事实：显式 mentions 的唤醒上限为 5（`packages/shared/src/channels.ts:9,136`；`packages/api/src/modules/channels/router.ts:371`）；`mentionAll` / `autoWakeOnAll` 已进入契约与 API（`packages/shared/src/channels.ts:118-123,138`），Web 只透传 `autoWakeOnAll` 字段，没有设置入口或 @all 发送选项（`packages/web/src/lib/api.ts:303,1160`、`packages/web/src/lib/queries.ts:3145`）。

### 9.6 CH-17 agent 身份：最小版 M，完整版挂「对外」条件

- 市场事实：Slack 的 bot 使用独立 bot token 与身份（https://docs.slack.dev/authentication/tokens）；Asana 把 agent 的有效权限定义为 agent 权限与触发用户权限的交集（https://asana.com/inside-asana/how-asana-thinks-about-agentic-ai-security）；Claude Tag 使用 service accounts（https://claude.com/docs/claude-tag/concepts/agent-identity）。
- 本项目判断：内部场景下「成员触发即授权」自洽，独立 token / ACL 是 L 级安全改造；等 D-21 对外翻转再做。当前只做 agent 审计主体与频道授权入口收敛，作为最小身份闭环。
- 代码事实：频道 run 的 subject 是触发者用户（`packages/api/src/modules/channels/wakes.ts:190-197`）；审计没有 agent actor 类型（`packages/db/src/repo/audit.ts`）。

### 9.7 CH-03 沙盒隔离：维持 D-16 方案 A，挂「对外」条件

- 市场共识：socket proxy 只是缩小 Docker API 暴露面，不是租户边界（https://docs.docker.com/engine/security/）；单租户容器够用，多租户才需要 microVM（https://e2b.dev/security）。
- 本项目判断：当前是单机自用、内部小团队，维持 D-16 方案 A；不提前做 socket proxy、独立沙盒节点或 microVM。只有 D-21 翻转、引入外部用户或第三方 agent 时才重新评估。
- 代码事实：D-16 与 2026-10-31 备注见 `docs/DECISIONS-PENDING.md`；worker 直挂 `docker.sock`（`packages/worker`）。

### 9.8 CH-18 线程 / 并行：暂不做

- 市场事实：主流并行单位是 task/session 加独立工作区——Devin 每个 session 使用独立 VM（https://docs.devin.ai/work-with-devin/advanced-capabilities）；Cursor 每个 agent 使用独立 worktree（https://cursor.com/blog/agent-best-practices）。
- 本项目判断：做对的并行是 thread / per-task session 加独立 session 与容器，属 L 级数据模型改动；内部没有真实并行需求，暂不做。把「同一 agent 忙碌时拒绝新 run」写清楚为已知限制。
- 代码事实：同一 lane 有 queued / running 时拒绝新 run（`packages/db/src/repo/chat.ts:1151-1161`）；忙碌 lane 写 system 提示并跳过（`packages/api/src/modules/channels/wakes.ts:198-208`）。

### 9.9 CH-19 A2A 协作：不做

- 市场事实：未找到自由群聊的官方证据，Linear / Slack / Asana 均为 human 触发，agent 之间不会自动互相唤醒；主流框架依靠显式编排与终止条件（AutoGen termination：https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html；OpenAI handoffs：https://openai.github.io/openai-agents-python/handoffs/）；Claude Agent Teams 官方确认要求交互式会话，Agent SDK 不可用（https://code.claude.com/docs/en/agent-teams）。
- 本项目判断：频道定位是「人驱动共享频道」，不做 agent 自主协作。真出现需求时，只做「agent 建议、人确认」的 handoff，且必须有确认步骤、深度 / 预算上限与终止条件。
- 代码事实：只从人类消息解析 mentions，agent 回复不触发 run（`packages/db/src/repo/channels.ts:630-669`）；没有共享任务表、mailbox 或 artifact 表（`packages/db/src/schema.ts`）。

### 9.10 建议实施顺序

1. CH-04 唤醒可靠性。
2. CH-12 审批参数与审计。
3. CH-11 共享工作现场最小版。
4. CH-02 记忆只读策略。
5. CH-14 两半（删除 `paused`、补 @all 人工入口）。
6. CH-17 agent 身份最小版。

CH-03、CH-18、CH-19 挂条件不做：CH-03 等 D-21 对外翻转，CH-18 等真实并行需求，CH-19 只在出现 agent 交接需求时做人工确认版。

以上取舍已由 D-80 确认；CH-04 已在本批实现，其余项按第 9.10 顺序排期。
