# 频道模式调研（2026-11-01）

> Goal：`workbody-channel-mode-goal`（云端 Workbody 频道模式：人 + 多智能体共享工作现场）。
> LoopX 当前 checkpoint：`todo_7ffa76f1111d33cf1507a6f8`。
> 本文只做调研与可行性判断，**不含实现代码、不改产品代码**。
> 证据等级：官方产品页/官方文档为主；未对 Cana、WorkBuddy 做真实账号操作；Slack/Teams 行为来自官方开发者文档。标“推断”的条目需要后续实测。

## 0. 结论摘要

1. **频道（channel）是一等对象**，不是“群聊 + 机器人”。Cana 把频道定义为共享房间，成员同时包含人和 agent；WorkBuddy 则把它拆成“产品内 AI 同事频道 + 外部 IM 渠道”两层。[CANA-WT][CANA-LEARN-WT][WB-CA]
2. **agent 必须有独立身份**，不能复用人类创建者的身份。Cana 给 agent 单独的频道 token；Microsoft 把 agent 身份做成一等对象（blueprint → agent identity → 可选 agent user）；Mattermost 给每个 agent 独立 bot 账号。[CANA-WT][ENTRA-AGENT][MATTERMOST-AGENTS]
3. **默认只响应 @mention**。Cana：“没有 @ 的消息所有人可见、但没人执行”；Agentforce 明确不被动监听；Teams 即使授权全部消息，也不会把其他 bot/agent 的消息投递给该 agent。[CANA-WT][SALESFORCE][TEAMS-CONV]
4. **权限要拆成 receive / send / act / admin**，并绑定到频道范围的短期 token；审批只给频道 owner/admin，且“先到的回答生效”。[CANA-WT][CANA-PERM][WB-PERM]
5. **停止要分三档**：停止当前工作、断开某个 agent、关闭整个频道；关闭不可逆。Cana 有明确的 Stop / Disconnect / Kill channel；WorkBuddy 的强制停止能力在桌面/移动端与 CloudAgent 之间并不一致。[CANA-WT][CANA-LEARN-WT][WB-CA][WB-MULTI]
6. **PACE 现状是“单用户会话 + run 级授权”**。会话只有创建者或服务身份；SSE 可以多订阅者，但事件不带频道语义；审批、取消、提问回答都绑定发起人；没有频道成员表。[CODE-AUDIT]
7. **可行方向**：新增 `channels` + `channel_members` + `channel_agent_bindings`，复用现有 `conversations` / `messages` / `agent_runs` / SSE / 审批 / 取消 / run token；先把“私有对话”视为 1:1 频道保留，避免直接改写历史会话导致越权泄漏。[CODE-AUDIT]
8. **前置风险**：频道模式天然是多用户场景，会触发 `D-16` 的沙箱隔离升级条件（worker 当前挂 `docker.sock`，等价宿主 root）。生产化前必须给出 socket proxy / 独立沙盒节点 / microVM 的结论；频道调研本身不阻塞，但设计文档必须把它列为上线门槛。

## 1. 调研问题与方法

调研问题：

1. 频道/会话/成员的对象模型怎么设计？
2. 人、agent、bot 的身份与权限怎么分？
3. 消息、事件、@mention、唤醒、交接怎么流转？
4. 审批、急停、token 生命周期怎么做？
5. 一个 agent 会话能否服务多个频道？
6. 产品内频道与 IM 渠道如何分层？
7. 多租户、审计、失败边界怎么处理？
8. PACE 现有代码与 Claude Agent SDK 哪些能复用，哪些必须新增？

方法：

- 读 Cana Walkie-Talkie 产品页、Learn 文档、组织与权限页、手机审批页。
- 读腾讯 WorkBuddy CloudAgent 文档、产品指南、协作/权限/多端/企微接入页。
- 读 Slack / Teams / Agentforce / Microsoft Entra Agent ID / Google A2A / Mattermost Agents / LangGraph / OpenAI Agents SDK / AutoGen / CrewAI / Zulip / Rocket.Chat 的官方文档。
- 只读审计 PACE 代码与已安装 `@anthropic-ai/claude-agent-sdk` 的 `sdk.d.ts`。

限制：

- 没有 Cana / WorkBuddy 的真实账号，无法验证断线重连、消息丢失、IM 多群绑定等行为。
- Cana 的 token 期限在产品页与 Learn 页存在冲突（见 §2.1），采用前需产品确认。
- Slack/Teams 的部分行为来自帮助中心，落地前应以 API 实测为准。

## 2. 对标拆解

### 2.1 Cana Walkie-Talkie

**对象模型**

- 频道是共享房间：“A channel is a shared room”，人与 agent 共享同一份实时文本会话，“history stays in one place”。[CANA-LEARN-WT]
- 频道内角色：owner / admin / operator / member / viewer；另有私信。[CANA-LEARN-WT]
- Cana 没有公开的独立 session 对象或字段 schema。[CANA-WT]

**身份与角色**

- 参与者包括 Claude Code、Codex、Cana desktop agent、Cana cloud chats、bots。[CANA-WT]
- 人类必须已属于本组织；组织内 Owner/Admin/Member 是受保护角色，频道内再分五种角色。[CANA-LEARN-WT][CANA-ORG]

**权限**

- 拆成 receive / send / act / admin 四种能力；token “scoped to the channels you pick”。[CANA-WT]
- “Agents only take actions when their token allows it and the owner approves.” [CANA-WT]
- 新成员默认只读；Member 只能发；可授予 “Allow adding agents”。[CANA-PERM]
- Bypass 只能桌面开启；受保护路径是 “hard deny list ... can't be approved in any mode”。[CANA-PERM]

**消息与事件**

- 文本、@name/@all、私信、已读回执、附件、@Me 过滤、运行状态。[CANA-LEARN-WT]
- 未公开事件 schema、投递保证、重放机制。[CANA-WT]

**@mention 与唤醒**

- “Writing '@release-bot draft the notes' gives that agent the job.” [CANA-WT]
- “A message with no @handle is seen by everyone but acted on by no one.” [CANA-WT]
- “Mentioning a sleeping bot wakes it up.” [CANA-WT]

**上下文交接**

- “one agent can ask another for context, hand off a task, or report progress.” [CANA-WT]
- 频道共享历史，但未说明交接载荷与协议。[CANA-WT]

**审批**

- “When an agent needs a decision it asks with buttons, or posts a plan for an owner or admin to approve or deny.” [CANA-LEARN-WT]
- 计划审批 “exactly once”，决定与备注回传并落频道；非审批者看到 “Waiting for the channel owner or an admin”。[CANA-LEARN-WT]
- 工具卡标题 “Needs your approval”，选项 Approve / Always / Deny。[CANA-LEARN-WT]
- 手机可一键审批。[CANA-PHONE]

**急停 / 断开**

- “Click Stop beside work in progress.” [CANA-LEARN-WT]
- “Kill a channel or disconnect an agent in one click.” [CANA-WT]
- 关闭频道不可逆，“agents disconnect at once”。[CANA-WT]

**Token**

- 有效期 1 小时–7 天，默认 8 小时；只保存指纹；“Only a fingerprint of each token is stored”。[CANA-WT]
- 产品页与 Learn 页存在冲突：Learn 页另写 “never until revoked”；本文建议按产品页的受限期限设计，采用前需产品确认。[CANA-WT][CANA-LEARN-WT]

**一个会话服务多个频道**

- “One Claude Code session can serve several channels.” [CANA-WT]
- Learn 页未提，推断由多频道 scope token 支撑。[CANA-LEARN-WT]

**移动端 / IM**

- Web dashboard + iPhone app；mention/DM 推送、手机一键审批。[CANA-WT][CANA-PHONE]
- 未提 Slack/Teams/微信托管频道。[CANA-WT]

**部署**

- Cana Cloud、客户 VPC（AWS/Google Cloud/Azure/Oracle）、on-prem、完全气隙；支持数据驻留。[CANA]

**失败与安全边界**

- 组织成员才能入频道；默认只读；act 默认关闭；Bypass 只能桌面开启；hard deny list 不能审批。[CANA-PERM]
- 未说明断线重连、消息丢失、token 泄露应急。[CANA-LEARN-WT]

### 2.2 腾讯 WorkBuddy CloudAgent

**对象模型**

- Agent / Runtime / Session 三层；“一个 Runtime 下可以有多个 Session，每个 Session 维护独立的对话历史和 Agent 上下文”。[WB-CA]
- IM 侧：“每条接入记录对应一个 Bot → Session 的绑定关系”。[WB-CA]
- 产品内频道还有任务板、lead、委托人。[WB-PRODUCT]

**身份**

- AI 同事、默认 CodeBuddy、默认 Agent、人类；默认 Agent 不进花名册、不吃 @所有人 未读。[WB-PRODUCT]

**权限**

- CloudAgent 文档没有 RBAC/scope，只有默认权限 vs 完全访问、逐次确认、批量删除阈值 50、AI 智能审批。[WB-PERM]
- 团队空间四档：查看 / 编辑 / 管理 / 无权限；“人看不到的内容，Agent 也读不到”。[WB-COLLAB]

**消息与事件**

- 频道任务板有认领/完成/放回的时间线事件；频道回执与忙碌态。[WB-PRODUCT]
- 执行侧走 ACP/SSE 流式输出。[WB-CA]

**@mention 与唤醒**

- 企微群 “@机器人 下发团队协作任务”，但 “仅能读取@我的单条消息”。[WB-WECOM]
- 频道唤醒有预算；“超限只标记停滞、不再自动叫醒”。[WB-PRODUCT]

**上下文交接**

- AI 同事 Job 独立；lead 每轮拿任务板快照，可批量派单/催办；`sourceSessionId` 继承受限上下文。[WB-PRODUCT]
- Agent Teams 成员不继承领导历史，只靠共享任务列表 + 信箱。[WB-PRODUCT]

**审批**

- 桌面弹窗按读 / 写 / 删 / 联网 / 命令分类。[WB-PERM]
- 移动端推送 “等待审批”；IM 支持文字回复批准高危命令。[WB-MULTI][WB-WECOM]
- 双向 channel 经 `claude/channel/permission` 远程批准，“先到的回答生效”。[WB-CHANGELOG]

**急停**

- 移动端停止后 “电脑端已同步终止运行”，已完成步骤保留。[WB-MULTI]
- CloudAgent 没有急停；Agent Teams 只有优雅 `shutdown_request`，没有强制 kill。[WB-CA]

**Token**

- OAuth access_token 24h、refresh_token 60 天、client_secret 仅展示一次；分享私钥最多 10 对、按 kid 轮换。[WB-OPEN]
- 企微长连接用 Bot ID + Secret。[WB-WECOM]

**一个会话服务多个频道**

- 未明确；IM 远程助理反而 “仅一个会话，所有远程指令集中处理”。[WB-WECOM]
- 推断：一个 Session 多 IM 群未证明支持。

**移动端 / IM**

- 企微 / QQ / 飞书 / 钉钉 / 微信 BOT。[WB-CA]
- 移动端定位为桌面 Agent 的 “远程控制台”，加密中继、设备一对一绑定、四类推送。[WB-MULTI]

**部署**

- 桌面本地执行 + CloudAgent 云端沙箱（“300ms 极速启动”、闲置休眠不计费）+ WMA 托管。[WB-CA][WB-WMA]
- 私有化仅见飞书自定义 Host。[WB-WECOM]

**失败与安全边界**

- “未设防的 channel 是 prompt 注入攻击向量”，须按 `message.from.id` 而非 `message.chat.id` 校验。[WB-WECOM]
- `channelsEnabled` 组织策略仍生效；沙箱 + 备份 + 回收站。[WB-PERM]
- 无强制终止与跨租户边界文档。[WB-CA]

### 2.3 Slack / Teams / Agentforce

**Slack**

- agent 作为 “加入频道的应用/agent”，在频道头部 Agents & Apps 中加入后 @ 其名称唤起；回答可设为全频道可见或仅自己可见。[SLACK-AGENTS]
- Agentforce 官方明确不被动监听，只响应直接 @mention；后续线程回复不会再次触发。[SALESFORCE]
- Events API：单事件 POST，3 秒内 2xx；失败重试 3 次（立即/1 分钟/5 分钟）；`event_id` 全局唯一可去重；另有 Socket Mode。[SLACK-EVENTS]
- `app_mention` 仅由 bot user 被直接提及触发；DM 走 `message.im`。[SLACK-MENTION]
- 审计日志为 Enterprise 组织级、只读、不含消息内容；`users.setPresence` 仅支持手动 `auto`/`away`。[SLACK-AUDIT][SLACK-PRESENCE]

**Microsoft Teams / Entra**

- 以 `teams`/`groupchat` scope 安装，默认只收到直接 @mention；即使 RSC 授权“接收全部消息”，Teams 也不会把其他 agent/bot 发的消息投递给该 agent。[TEAMS-CONV]
- Channel Agent 每频道仅一个，不支持私有频道。[TEAMS-CHANNEL-AGENT]
- Activity Protocol 提供 `channelId`、`serviceUrl`、`conversation`、`entities[type=mention]` 与 conversationUpdate。[TEAMS-ACTIVITY]
- Microsoft Entra Agent ID：blueprint（持凭据）→ agent identity（service principal，审计主体）→ agent user（可选、1:1、不可设密码）。[ENTRA-AGENT]
- Graph presence 聚合多会话；应用可设 5–240 分钟会话。[GRAPH-PRESENCE]

**Mattermost Agents（最接近“真成员”）**

- 每个 agent 绑定独立 bot 账号；改名保留 user ID、频道成员关系、DM 与线程。[MATTERMOST-AGENTS]
- 工具卡片 Accept/Reject；审批人永远是发起人，服务端校验 UserID；策略 `ask` / `auto_run_in_dm` / `auto_run_everywhere`；无超时、不自动转移；执行后发起人选择 Share 或 Keep Private，并记录幂等。[MATTERMOST-MULTI]
- 外部 MCP 用管理员配置凭据；内置工具仍按请求用户权限执行；未配置的外部服务器失败关闭。[MATTERMOST-AGENTS]

### 2.4 A2A 与多智能体框架

**A2A**

- 以 Task 为核心，状态含 `INPUT_REQUIRED`、`AUTH_REQUIRED` 等 9 态。[A2A]
- Message 带 `messageId` / `contextId` / `taskId`，`role=USER|AGENT`；结果以 Artifact 交付。[A2A]
- 支持 SSE 流式与 webhook push；取消/删除要求幂等。[A2A][A2A-STREAM]
- `securitySchemes` 声明 APIKey / HTTP / OAuth2 / OIDC / mTLS；401 与 403 分离；`tenant` 为可选路由标识，声明后请求必须匹配；`messageId` 可去重，`contextId` 必须原样返回。[A2A]

**LangGraph**

- `interrupt()` + checkpointer + `thread_id`，用 `Command(resume=...)` 恢复；节点会从头重跑，中断前代码必须幂等。[LANGGRAPH]

**OpenAI Agents SDK**

- 区分 handoff（转移控制权、接收完整历史）与 agent-as-tool（主管保留最终答复）。[OPENAI-HANDOFF]

**AutoGen / CrewAI**

- AutoGen `SelectorGroupChat` 由 LLM 或 `selector_func` 选下一个发言者，`UserProxyAgent` 插入人工。[AUTOGEN]
- CrewAI 用 hierarchical manager 委派并校验结果。[CREWAI]

**Zulip / Rocket.Chat**

- Zulip outgoing webhook 由 @mention/DM 触发、10 秒超时、带 per-bot token。[ZULIP]
- Rocket.Chat 确认 Apps-Engine 的事件接口与 slash command 机制，但 agent 语义未展开。[ROCKET]

## 3. 横向对比

| 维度 | Cana | WorkBuddy | Slack / Teams | A2A / 框架 |
|---|---|---|---|---|
| 频道对象 | 一等对象，共享房间 | Runtime / Session + IM Bot 绑定 | 平台频道/会话 | Task + contextId |
| 成员 | 人 + 多种 agent/bot | AI 同事 + 人类 | 应用/agent 加入频道 | agent card + task |
| agent 身份 | 独立频道 token | AI 同事/默认 Agent | app/bot 账号；Entra agent identity | agent 端点 + security scheme |
| 权限 | receive/send/act/admin | 产品权限模式 + 团队空间四档 | 平台 scope + RSC | securitySchemes |
| 默认唤醒 | 仅 @mention | 仅 @我的单条 | 默认仅直接 @mention | 显式 task/message |
| 交接 | agent 可互相要上下文/交接/汇报 | 任务板 + lead + 受限 sourceSessionId | 平台线程/消息 | Task / Artifact |
| 审批 | owner/admin，计划 exactly once | 桌面/移动/IM 多入口，先到先得 | 平台卡片/审批 | INPUT_REQUIRED / AUTH_REQUIRED |
| 急停 | Stop / Disconnect / Kill channel | 桌面+移动同步；CloudAgent 无急停 | 平台能力不一 | 取消幂等 |
| token | 1h–7d，默认 8h，只存指纹 | OAuth 24h/60d，secret 一次展示 | 平台 token | OAuth2/OIDC/mTLS |
| 一会话多频道 | 明确支持 | 未证明 | 平台不同 | contextId 多 task |
| 移动/IM | Web + iPhone | 企微/QQ/飞书/钉钉/微信 + 移动远程控制台 | 平台原生 | push notification |
| 部署 | Cloud/VPC/on-prem/air-gap | 桌面 + 云沙箱 + 托管 | 平台 SaaS | 自托管/云 |
| 多租户 | 组织成员边界 | 团队空间 + 组织策略 | workspace/tenant | tenant 路由 |
| 审计 | 未公开细节 | 未公开细节 | Slack 组织级审计 | 调用方可记录 |

## 4. 可复用模式与反模式

### 4.1 建议采用

1. **频道即对象**：频道有名称、类型（项目/团队/事故）、可见性、成员、归档状态；不要把“群聊”直接等同于频道。
2. **成员显式区分 human / agent**：agent 有独立成员 ID、独立审计主体；人类与 agent 不共享身份。
3. **默认 @mention 唤醒**：没有 @ 的消息只可见、不执行；需要更大范围时显式订阅。
4. **权限拆分 receive / send / act / admin**：token 绑定频道范围、短时效、只存指纹；act 默认关闭。
5. **审批只给 owner/admin**：计划审批 exactly once；并发时“先到的回答生效”；审批人不可超时自动同意。
6. **Stop / Disconnect / Close 三档分离**：Stop 停当前工作；Disconnect 断开某个 agent；Close 关闭频道且不可逆，需要显式确认。
7. **幂等键持久化**：IM/事件入口用 `event_id` 或 `messageId` 去重；取消、审批、任务完成都幂等。
8. **任务状态机对齐 A2A**：至少区分 `INPUT_REQUIRED`（等人回答问题）、`AUTH_REQUIRED`（等人批准）与普通运行态；结果以 artifact 交付。
9. **产品内频道与 IM 渠道分层**：产品频道是主模型；IM 走 Bot → Session 绑定，再接内部频道/会话。
10. **agent 间消息必须显式**：Slack/Teams 不会把其他 bot 的消息投递给 agent；PACE 若要 agent 互相 @，需要自己的显式 agent-to-agent 通道。

### 4.2 避免

1. 被动监听全部消息：prompt 注入、成本、审计都会失控。
2. 人类与 agent 共用一个身份：审计无法区分“谁做的决定”。
3. 长期、无频道范围的 token。
4. 审批超时自动同意，或任意成员都能批准。
5. 把频道做成纯群聊，没有任务、artifact、审批状态。
6. 只靠内存去重；进程重启后重复执行。
7. 把“agent 正在处理”伪装成人类 presence；应该用 typing/状态事件。

## 5. PACE 现状映射

以下结论来自只读代码审计；文件路径与行号供设计阶段复核。

| 需求 | 现状 | 缺口 | 可复用 |
|---|---|---|---|
| 频道对象 | 无 `channels` / `channel_members` 表 | 需要新增 | `conversations` 可保留为 1:1 频道 |
| 会话归属 | `conversations.createdBy` 或 `serviceId` 二选一（`packages/db/src/schema.ts:451-493`） | 无多成员语义 | 可作为频道 owner |
| 可见性 | 只有 `own_data` / `platform`（`packages/db/src/repo/chat.ts:38-42`） | 成员可见性 | 可扩展为频道成员判断 |
| 发消息 | `POST /api/chat` 校验 `conversations.create/update + privateContent` + `agents.use`（`packages/api/src/features/chat/routes.ts:196-296`） | 成员发言会被拒 | 增加成员校验 |
| run 创建 | `admitChatRun` 同事务创建会话/run/用户消息（`packages/db/src/repo/chat.ts:893-988`） | run 只绑定发起人 | 可加 `channelId` / `agentId` |
| 并发 | 同一会话只允许一个 `queued/running`（`packages/db/src/repo/chat.ts:953-963`） | 多 agent 并行需要设计 | 顺序发言可复用 |
| SSE | 每个订阅独立 Redis 连接，可多观众（`packages/api/src/queue/producer.ts:176-223`） | 事件不带频道语义 | 可加 `{channelId, runId, event}` 信封 |
| 事件 | `ChatEvent` 除 `run_started` 外不带 `runId`（`packages/shared/src/chat.ts:78-206`） | 频道流无法关联 run | 加信封，不复制 token 增量 |
| SDK 流式输入 | `query({prompt: string \| AsyncIterable})`；`streamInput()`；`interrupt/setPermissionMode/setModel`（`sdk.d.ts:3345-3348`） | 当前只发一条用户消息（`packages/sandbox/src/runner.ts:413-424`） | 可支持持续频道输入 |
| SDK resume/fork | `Options.resume`、`forkSession`、`forkSession(id,{upToMessageId})`（`sdk.d.ts:2148,1770,870-891`） | 已用于续聊/分支 | 可直接复用 |
| canUseTool | 当前只放行 `AskUserQuestion`，其余拒绝（`packages/sandbox/src/questions.ts:134-141`） | 频道审批需要扩展 | 可接审批状态机 |
| hooks | 已用 PreToolUse / UserPromptSubmit（`packages/sandbox/src/runner.ts:459-491`） | 可加频道事件 hook | 复用 |
| subagents | `.claude/agents` + `forwardSubagentText`（`packages/sandbox/src/runner.ts:453`） | 单层委派 | 可做 agent 成员 |
| MCP | `.mcp.json + enableAllProjectMcpServers`（`packages/sandbox/src/runner.ts:439-450`） | 无频道级工具授权 | 可加频道绑定 |
| 审批 | `approval_requests` 无批准人列（`packages/db/src/schema.ts:664-694`） | 需要 `approvedByBusinessId` | 复用表与 MCP 门禁 |
| 取消 | `cancelAgentRun` CAS/信号（`packages/api/src/features/chat/cancel-run.ts:13-35`） | 授权只到发起人 | 改为频道 owner/成员 |
| token | run 级 MCP/模型 token（`packages/db/src/schema.ts:582-586`） | 无频道 scope | 可复用 run token |
| 容器 | 按 `conversationId` 复用，一次一个 run（`packages/worker/src/session-workspace.ts:26`、`packages/sandbox/src/session-supervisor.ts:239-258`） | 多 agent 并行受限 | 顺序发言可复用 |

**关键冲突**

1. SSE、取消、审批、提问回答都绑定 `initiatedBy`；频道成员会被拒。[CODE-AUDIT]
2. worker 启动复核要求 `conversations.create own_data` 命中创建者；成员发言会被判越权。[CODE-AUDIT]
3. 直接改造 `conversations` 为频道，任何遗漏旧 `createdBy` 过滤的路由都会泄露历史。[CODE-AUDIT]
4. 多用户触发 `D-16` 沙箱隔离升级；当前 `docker.sock` 等价宿主 root，云版本不能直接上线。[DECISIONS]

## 6. 方案候选（供设计 checkpoint 选择）

### 方案 A：新增 channel 对象，私有对话视为 1:1 频道（推荐）

- 新增 `channels`、`channel_members`、`channel_agent_bindings`。
- `messages` / `agent_runs` 增加 `channel_id`；保留 `conversation_id` 作为一次连续上下文。
- 私有对话 = 只有两个人的频道（人或 agent），旧数据不改语义。
- 优点：不破坏现有会话/SSE/审批；权限模型清晰；可逐步迁移。
- 代价：多一层对象；频道与会话的边界要在契约里定死。

### 方案 B：直接把 `conversations` 升级为频道

- 给 `conversations` 加成员表，放宽 `createdBy` 单主体。
- 优点：表更少，消息模型直接复用。
- 代价：所有旧过滤都要改；漏一处就泄露；回滚困难。个人项目可以承受，但风险高。

### 方案 C：只做外部 IM 频道适配器

- 以 Slack/企微/飞书为频道，内部只做 Bot → Session 绑定。
- 优点：最快接入现有 IM；用户不用换工具。
- 代价：不是“云端 Workbody”的产品内频道；无法承载审批、artifact、多 agent 协作的完整体验。

**建议**：先按 A 做产品内频道；C 作为后续 IM 接入层，不替代 A。

## 7. 待验证假设与风险

1. **Cana token 期限冲突**：产品页 1h–7d，Learn 页 “never until revoked”；设计按受限期限，落地前需产品确认。
2. **WorkBuddy 多群绑定/私有化细节未公开**：不能当作已验证能力。
3. **Slack/Teams 的默认回复可见性与 bot 消息投递行为**：部分来自帮助中心，落地前用 API 实测。
4. **prompt 注入**：未设防频道是明确攻击向量；必须按 sender ID 校验，不能按 chat ID。
5. **审批 exactly-once**：并发审批要“先到先得”，需要 DB 条件更新与幂等键。
6. **多用户沙箱隔离**：`D-16` 是上线门槛；P0 可做受信试点，但不能宣称生产安全。
7. **一个会话多频道**：Cana 明确支持；PACE 当前容器按 `conversationId` 复用且一次一个 run，需要决定“串行复用”还是“每 agent 一个会话”。
8. **事件重放/断线**：频道需要持久化事件日志与去重，不能只靠 SSE 内存流。
9. **ACL 感知检索**：WorkBuddy 的“人看不到的内容 Agent 也读不到”需要知识库文档级 ACL；PACE 当前只有来源级撤权。
10. **审计主体**：agent 动作要以 agent 身份记录，不能记成人类发起人。

## 8. 下一步（设计 checkpoint）

建议下一份产出是 `docs/tasks/channel-mode-contract.md`，至少定死：

1. 对象模型：channel、member、agent binding、conversation、run 的归属关系。
2. 权限矩阵：receive / send / act / admin × human/agent × owner/admin/member/viewer。
3. 事件契约：`{channelId, runId, event}` 信封、去重键、重放与保留。
4. 审批状态机：计划审批、工具审批、`INPUT_REQUIRED` / `AUTH_REQUIRED`、先到先得。
5. 停止语义：Stop / Disconnect / Close 三档；关闭的不可逆确认。
6. Token 模型：频道范围、短时效、只存指纹、撤销。
7. 多频道会话：一个 agent 会话服务多个频道的串行/并行策略。
8. 租户边界：频道属于哪个组织/租户；P0 单租户实例还是共享库。
9. IM 适配：Bot → Session 绑定、`event_id` 去重、sender 校验。
10. 迁移与验证：如何在不破坏现有私有对话的前提下上线；多用户浏览器/API/沙箱验收。

## 9. 来源

- [CANA-WT] https://cana.build/platform/walkie-talkie
- [CANA-LEARN-WT] https://cana.build/learn/walkie-talkie
- [CANA-PERM] https://cana.build/learn/permissions
- [CANA-PHONE] https://cana.build/learn/approve-from-phone
- [CANA-ORG] https://cana.build/learn/organisations
- [CANA-NEWS] https://cana.build/news/walkie-talkie
- [CANA-AGENTS] https://cana.build/platform/agents
- [CANA] https://cana.build/
- [WB-CA] https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/CloudAgent
- [WB-PRODUCT] https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Product-Guide
- [WB-COLLAB] https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Library/Collaboration
- [WB-PERM] https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Permission-Modes
- [WB-MULTI] https://www.workbuddy.cn/docs/workbuddyapp/features/Multidevice
- [WB-WECOM] https://www.workbuddy.cn/docs/workbuddy/Wecom-Guide
- [WB-CHANGELOG] https://www.workbuddy.cn/docs/workbuddy/Changelog
- [WB-OPEN] https://open.workbuddy.cn/docs/third-party-app
- [WB-TENCENT] https://cloud.tencent.com/document/product/1831/137063
- [WB-WMA] https://cloud.tencent.com/product/workbuddy-managed-agents
- [SLACK-AGENTS] https://slack.com/help/articles/33076000248851-Work-with-AI-agents-in-Slack
- [SLACK-MENTION] https://docs.slack.dev/reference/events/app_mention/
- [SLACK-EVENTS] https://docs.slack.dev/apis/events-api/
- [SALESFORCE] https://help.salesforce.com/s/articleView?id=005388402&language=en_US&type=1
- [TEAMS-CONV] https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations
- [TEAMS-CHANNEL-AGENT] https://support.microsoft.com/en-us/teams/chat-channels/how-to-create-a-channel-agent-for-a-teams-channel
- [TEAMS-ACTIVITY] https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/activity-protocol
- [ENTRA-AGENT] https://learn.microsoft.com/en-us/entra/agent-id/agent-users
- [A2A] https://a2a-protocol.org/latest/specification/
- [A2A-STREAM] https://a2aproject.github.io/A2A/latest/topics/streaming-and-async/
- [MATTERMOST-AGENTS] https://github.com/mattermost/mattermost-plugin-agents/blob/master/docs/features/managing_agents.md
- [MATTERMOST-MULTI] https://github.com/mattermost/mattermost-plugin-agents/blob/master/docs/features/multiplayer_tool_calling.md
- [LANGGRAPH] https://docs.langchain.com/oss/python/langgraph/interrupts
- [OPENAI-HANDOFF] https://openai.github.io/openai-agents-python/handoffs/
- [AUTOGEN] https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html
- [CREWAI] https://docs.crewai.com/en/concepts/crews
- [ZULIP] https://zulip.com/api/outgoing-webhook-payload
- [ROCKET] https://developer.rocket.chat/docs/rocketchat-apps-engine
- [SLACK-AUDIT] https://docs.slack.dev/admins/audit-logs-api/
- [GRAPH-PRESENCE] https://learn.microsoft.com/en-us/graph/manage-presence-state
- [SLACK-PRESENCE] https://docs.slack.dev/reference/methods/users.setPresence/
- [SDK-TS] https://code.claude.com/docs/en/agent-sdk/typescript
- [SDK-STREAM] https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- [SDK-SESSIONS] https://code.claude.com/docs/en/agent-sdk/sessions
- [SDK-PERM] https://code.claude.com/docs/en/agent-sdk/permissions
- [SDK-SUBAGENTS] https://code.claude.com/docs/en/agent-sdk/subagents
- [CODE-AUDIT] 本任务只读代码审计（`packages/db/src/schema.ts`、`packages/api/src/features/chat/`、`packages/worker/src/`、`packages/sandbox/src/runner.ts`、`packages/shared/src/chat.ts`、`sdk.d.ts`）
- [DECISIONS] `docs/DECISIONS-PENDING.md` D-16
