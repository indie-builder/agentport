# 个人模块落地

## 目标

用户于2026-10-31明确批准研究方案并要求使用LoopX实施。完成统一个人入口、个人资料（自助姓名）、个人记忆、历史回顾、账号安全（改密与会话管理）、我的分享及本人使用记录。保留个人/专家/平台/服务边界与既有权限。用户后续已明确授权提交 PR、合并后收尾；本轮集成执行者不 commit/push/merge，由主会话独立复核后执行。

## 方案

复用Page和现有导航、记忆、回顾、分享、运行/统计、Better Auth能力。先固定共享契约，再按文件域并行实现，定向验证与独立Opus终审后交付。研究文件在原codebase-cleanup树的.loopx/goals/user-center-research/{proposal,inventory}.md；当前任务记录为实施权威。

## 基线与范围

- 工作树：/Users/xbjt/Documents/myself/agentport/.claude/worktrees/personal-module
- 分支：worktree-personal-module
- HEAD与origin/main均为f430cd680835d17890c688399a635cd6e51302b4；初始git status为空。
- 原codebase-cleanup树的既有差异属于其他未完成任务，不复制、不覆盖、不提交。
- 范围：web/api/db/shared必要文件、关联测试及产品/设计文档；原则上不改schema，不加依赖。

## 当前有效决定

- 底部用户信息在侧栏展开/收起时均进入个人模块；显示姓名，默认个人资料；各子页可直达并有返回工作区。
- 资料与账号安全面向所有已认证用户；记忆、回顾、分享、使用记录遵循原能力权限，数据范围固定本人，管理员也不显示全局内容。
- 自助只编辑显示姓名，username/businessId/角色只读；不扩头像/邮箱/社交登录。
- 保留个人记忆保存/下载/版本/回滚/冲突草稿、回顾来源/模型专家/目标校验、改密撤销全部会话语义。
- 专家记忆、定时任务、平台凭据不搬入个人；通知、个人OAuth、集中删除、套餐计费不纳入本次。
- 本人统计以initiatedBy为口径，不按专家创建人过滤；成本标明记录覆盖情况；运行按真实来源跳转。

## 固定实施契约（2026-10-31，Opus 设计）

本节是三条执行线的唯一接口与文件所有权契约。设计基线已核对为 `f430cd680835d17890c688399a635cd6e51302b4`；根、web/api/db/shared 规则、DEV-WORKFLOW §2、PITFALLS、ub-mode 和 Better Auth 技能已读。仅固定契约，以下接口尚待实现与行为验证。不改 DB schema、不加依赖。

### 1. 页面路由与能力入口

- 固定 `/personal` 为个人模块，索引转 `/personal/profile`；六个可直达子路由是 `/personal/profile`、`/personal/memory`、`/personal/reviews`、`/personal/security`、`/personal/shares`、`/personal/usage`。底部姓名/头像在侧栏两种状态均进入 profile；返回工作区进入 `/chat`，登出保持独立动作。
- profile、security 对所有已认证用户开放，无须 `accounts.*`；memory 用 `personal_memory.read`，reviews 用 `personal_memory.read`（创建另查 review 叶），shares 用 `conversations.share`，usage 有 `overview.read` 或 `runs.read` 任一即可进入，两个区块分别判权与请求。无权子页显示既有无权限状态，隐藏对应导航，不发越权请求。
- 个人记忆复用现有编辑/下载/版本/回滚实现；回顾复用 `MemoryReviews`，支持 URL search `agent?: string`（目标/筛选专家）、`run?: string`（选中回顾，页内找不到时用已有详情 API 按 run 获取）。专家详情的就近入口进入 `/personal/reviews?agent=...`。不再保留第二套 `/memory` 页面或兼容路由，迁移全部调用与测试。
- shares、usage 分页和筛选进 URL；usage search 为 `days`（默认 30，1..90）、`agent?`、`status?`、`trigger?`、`cursor?`，shares 为 `cursor?`。改变筛选清空 cursor。

### 2. 资料与认证会话 API（执行线 A）

身份读复用 `GET /api/auth/me`，不新增平行 profile GET：原响应 `AuthMe`（`authenticated` 判别；已登录时 `user:{businessId,username,name}, roles, grants`）不变。角色/业务身份/用户名只读。

| 路由 | 输入 | 成功响应 | 访问与失败 |
|---|---|---|---|
| `PATCH /api/me/profile` | JSON `{name:string}`；复用 `accountNameSchema` 的 1..128 长度，再拒绝全空白；strict 拒绝 username/businessId/roles/image 等额外键 | 200 `{businessId:string,username:string,name:string}`，返回实际存储结果 | authenticated + user principal + `requireTrustedOrigin`；校验 400、无登录/停用 401、非法 Origin 403 |
| `GET /api/me/sessions` | 无输入 | 200 `{items:PersonalSession[]}` | authenticated + user principal；200 `Cache-Control:no-store`；原生鲜度不足映射 403 `FORBIDDEN`，中文提示“请重新登录后管理登录会话” |
| `DELETE /api/me/sessions/:id` | path `id` 为非空字符串，最长 200；不用 TypeID 约束认证载体 ID | 204 无 body | authenticated + user principal + trusted Origin；本人当前会话 409 `CONFLICT`；非本人/不存在/过期均 404 `NOT_FOUND`；原生鲜度不足同上 |
| `POST /api/auth/change-password` | 既有 `changeOwnPasswordSchema`：`{currentPassword,newPassword}` | 200 `{ok:true}`；全部旧会话失效，进入登录页 | 保持当前密码验证、trusted Origin、审计、全部会话撤销（包含当前）语义 |

`PersonalSession` 固定字段：`{id:string,createdAt:ISO,updatedAt:ISO,expiresAt:ISO,ipAddress:string|null,userAgent:string|null,current:boolean}`。只列未过期本人会话，按 createdAt/id 倒序；服务端通过原生 getSession 的 session.id 标记 current。严禁 wire、共享类型、审计或日志出现 session token/userId、Cookie 或原生列表原对象。

**Better Auth 证据与实现约束：** lockfile 与本地包为 `1.7.14`；2026-10-31 核对官方 1.7 索引及 [session-management](https://better-auth.com/docs/concepts/session-management.md)、[users-accounts](https://better-auth.com/docs/concepts/users-accounts.md)、[server API](https://better-auth.com/docs/concepts/api.md)，并读本地 `packages/api/node_modules/better-auth/dist/api/routes/{session.mjs,session.d.mts,update-user.d.mts}`。

- `auth.api.updateUser({body:{name},headers,returnHeaders:true})` 已原生支持；其返回 `{status:boolean}`，不能当 user 返回，随后原生 getSession 取新姓名并投影三字段。转发所有返回的 Set-Cookie，复用 auth/routes.ts 的 header 转发，不自己拼 token/Cookie。保留姓名原约束，不另造账号更新机制。
- `auth.api.listSessions({headers})` 原生只列当前 auth user 的未过期会话，包含敏感 token，且本地 `freshSessionMiddleware` 要求默认 1 天内新建的登录态；保持此限制，不设 `freshAge:0`，不绕过为直接全表查询。没有 SESSION_NOT_FRESH 新公共错误码，映射既有 FORBIDDEN 并在安全页提供重新登录动作，不自动登出用户。
- 单条撤销先调用原生 listSessions，在服务端用 path id 找本人目标、拒绝 current，再把目标 token 仅在服务端传给 `auth.api.revokeSession({body:{token},headers,returnHeaders:true})`。原生 revokeSession 会再次校验 token 的 userId，保留这道授权。未知 ID 不查询其他人的 session；不得向浏览器传 token 来换取实现方便。
- 当前配置无 cookieCache/secondaryStorage；撤销下一次请求即失效。不得引入认证插件、缓存、新 cookie 或自写 token。改密沿用当前已验证的全会话删除与清 Cookie 路径，本任务不重写它；新接口本身不复制 Cookie 实现。Better Auth 的 APIError 401/403/输入 400 转统一 Problem，未知异常仍交既有统一错误机制；不透传上游堆栈/原始响应。
- 姓名保存成功失效/刷新 `meQuery`，侧栏姓名立即同步；失败保留草稿。新写操作审计 action 为 `auth.profile.updated`、`auth.session.revoked`，actor 用本人 businessId、target 用本人 ID 或 session id，不写凭证。

### 3. 本人分享、使用记录、回顾来源 API（执行线 B）

所有个人数据接口同时满足“原能力叶授权”和“强制本人范围”。admin 的 platform grant 可以证明有该能力，但 SQL 仍固定本人；不得把 `accessFilter` 原样传入并让 platform 分支返回全局。无 user principal 401；缺能力 403；超出本人范围的对象/游标 404。所有列表在 SQL 层过滤并有 no-store。

| 路由 | 输入 | 成功响应 | 能力与归属 |
|---|---|---|---|
| `GET /api/me/output-shares` | query `{cursor?:string,limit?:1..100=50}` | 200 `{items:PersonalOutputShare[],nextCursor:string|null}` | `conversations.share`；join conversations 后 `createdBy = principal.businessId`，仅 `revokedAt IS NULL` |
| `DELETE /api/me/output-shares/:id` | path id 非空、最长 200 | 204，无 body；本人已撤销也 204 | `conversations.share` + 本人来源会话；他人/未知 ID 均 404；repo 条件更新需包含 owner 条件，不能无条件调用全局 revoke |
| `GET /api/me/usage` | query `{days?:1..90=30}` | 200 `PersonalUsageSummary` | `overview.read`；仅 `subjectKind='user' AND initiatedBy=businessId` |
| `GET /api/me/runs` | query `{days?:1..90=30,agentId?:string,status?:RunStatus,trigger?:RunTrigger,cursor?:string,limit?:1..100=50}` | 200 `{items:PersonalRun[],nextCursor:string|null}` | `runs.read`；同上本人运行谓词，绝不按 agents.createdBy 过滤 |
| `GET /api/me/conversations` | query `{agentId?:string,limit?:1..200=50}` | 200 `ConversationSummary[]`，复用已有 schema，不新增完整会话响应模型 | `conversations.read`；复用 `repo.chat.listConversations`，传入本人 businessId + `scopes:['own_data']`；供回顾来源选择使用 |

`PersonalOutputShare` = 现有 `outputShareSchema` extend `{conversationId:string,conversationTitle:string,agentId:string}`；`revokedAt` 在此列表恒 null，`urlPath` 复用既有 `/s/<shareId>#<token>`，允许复制分享凭据，但不进日志/referrer。界面称“我的会话分享”，不称“我创建的分享”：表里没有 creator，归属是来源会话本人。未撤销只表示链接未被撤销，不保证文件字节仍存在；不为了列表逐文件读盘验 hash，公开读取继续走既有 hash/文件存在校验。复制和撤销可仅凭 share 叶；来源跳转另外检查 conversations.read。

`PersonalUsageSummary` 固定字段：`{days:number,since:ISO,until:ISO,runCount:number,succeeded:number,failed:number,cancelled:number,timeout:number,queued:number,running:number,inputTokens:number,outputTokens:number,costUsd:string|null,costRecordedRuns:number,costMissingRuns:number}`。窗口采用现有 `utcWindowStart(days, now)`，`until` 是同次请求捕获的 now，均按 run.createdAt，`since <= createdAt <= until`。各状态计数互斥、和为 runCount；tokens 只合计已记录值（null 不冒充精确测量，UI 标签“已记录 Token”）。cost 用 PostgreSQL numeric 求和后 text 返回；无记录为 null，记录为 0 仍算已记录。`costRecordedRuns=count(costUsd IS NOT NULL)`、`costMissingRuns=runCount-costRecordedRuns`，包括排队/运行中的未记录值；空集合为 null/0/0，UI 显示“未记录”；部分缺失显示“已记录成本”与 X/Y 覆盖，不显示账单/余额，不在浏览器求金额和。

`PersonalRun` = `runListItemSchema` extend `{trigger:runTriggerSchema,createdAt:ISO,conversationId:string|null}`；保留 `costUsd:string|null` 与 tokens 的 null，不返回 prompt/steps/messages。conversationId 仅当来源会话确为本人时返回，否则 null；`review` 的 conversationId 不用作跳转。跳转规则：review 且有 personal_memory.read → `/personal/reviews?run=<id>`；chat 且 conversationId 非空且有 conversations.read → `/chat?agent=<agentId>&conversation=<conversationId>`；其余 → `/runs/<id>`。不得把 mcp/schedule/event 伪装成对话来源。runs.read 自身仍控制已有 run 详情。

分页固定复用现有 eval 游标惯例：cursor 是上页末项 id，shares/runs 按 `(createdAt,id) DESC`，查 limit+1 求 nextCursor；游标锚点先用同一 owner/窗口/筛选谓词查询，找不到返回 404，不能先跨用户读锚点。汇总不随分页变化，列表 agent/status/trigger 只过滤列表，UI 标明汇总窗口；本次不加图表、每日序列或新索引。

**回顾整合保留原 API：**

- `GET /api/memory-reviews` query 仍为 `{conversationId?,agentId?,before?:ISO,limit?:1..200=50}`，200 `{items:MemoryReview[]}`；`GET /api/memory-reviews/:runId` 200 `MemoryReview`；两个入口已以 review.businessId 固定本人，不另造 me 列表或复制编排。
- 创建仍 `POST /api/memory-reviews`，header `Idempotency-Key:UUID`，body 原样 `CreateMemoryReviewInput`：`{modelAgentId,target,sources:[{conversationId,fromMessageId?,throughMessageId?}],instruction}`，202 `{runId}`。为个人页面增加可选 query `scope=own`（仅此 literal）；个人页面和迁入后的专家就近入口一律发送它。带 scope 时每个来源额外校验 conversation.createdBy 等于本人，管理员也一样；幂等复用已有记录的提前返回分支也须满足这个来源约束，不能借相同幂等键跳过 own 校验。不带 scope 的既有 API 授权/运维审计语义保持。不把 scope 塞入业务 payload 或扩展 DB。
- 个人页创建来源一律走 `/api/me/conversations`；既有审核来源、模型专家 `agents.use`、目标专家 memory/rules 的 read/write、来源会话 read、同专家目标约束、消息窗口、大小上限和幂等校验全部保留。
- `POST /api/memory-reviews/:runId/apply` 无 body，200 `MemoryChange`；`PATCH /api/memory-reviews/:runId` body `{decision:'rejected'}`，200 `MemoryReview`。read/review/write 分别控制查看/创建或拒绝/采纳；前端独立检查，不把可读误当可创建。已有组件把 reviews 页签绑定 canReview，迁移时修为 canRead；创建按钮查 canReview、采纳查 canWrite、专家目标另查原叶。
- 个人记忆继续 `GET/PUT /api/me/memory`（PUT `{content,expectedRevision}` → `{content,revision,updatedAt,changeId}`）、`GET /api/me/memory/download`、`GET /api/me/memory/versions?before&limit` → `{items:MemoryChange[]}`、`POST /api/memory/changes/:id/rollback` → `MemoryChange`。9000 码点/36KiB、revision 冲突、持锁/账本、下载、草稿保护均不变；expert memory 不搬入个人。

### 4. shared 文件与固定导出

**仅 A 写 `packages/shared/src/personal.ts` 与 `packages/shared/src/index.ts`**，一次提供两条后端和 web 所需全部新契约；B 与 web 只 import，不改共享文件。复用 `accountNameSchema`、`runListItemSchema`、`runStatusSchema`、`runTriggerSchema`、`outputShareSchema`、`conversationSummarySchema`，不复制其定义。新 schema 均配 `z.infer` 类型，所有可由外部提供的 input object 为 strict。

- `updatePersonalProfileInputSchema` / `UpdatePersonalProfileInput`；`personalProfileSchema` / `PersonalProfile`（三身份展示字段）。
- `personalSessionSchema` / `PersonalSession`；`personalSessionListSchema` / `PersonalSessionList`。
- `personalOutputShareSchema` / `PersonalOutputShare`；`personalOutputShareListSchema` / `PersonalOutputShareList`。
- `personalUsageSummarySchema` / `PersonalUsageSummary`；`personalRunSchema` / `PersonalRun`；`personalRunListSchema` / `PersonalRunList`。
- `personalShareListQuerySchema` / `PersonalShareListQuery`；`personalUsageQuerySchema` / `PersonalUsageQuery`；`personalRunListQuerySchema` / `PersonalRunListQuery`，字段及默认值严格采用上表。
- 日期字段用 `z.iso.datetime()`；请求 limit/days 用 z.coerce；nullable 明确。无新公共错误码、无改 AuthMe 类型、无改 permission catalog、无新增 DB schema。path params、me/conversations query、scope=own query 仅单端使用，留 API 本地 schema，不为它们扩 shared。

### 5. 三条并行线的排他文件所有权

| 执行线 | 独占可写文件/目录 | 禁止写入与接线约束 |
|---|---|---|
| A：资料与安全（Sonnet high） | `packages/api/src/features/auth/routes.ts`；确需时同目录 `personal.ts`（由 registerAuth 调用，复用同一 auth 实例）；`packages/shared/src/personal.ts`、`packages/shared/src/index.ts`、`packages/shared/test/personal.test.ts`；`packages/api/test/personal-auth.test.ts`、`packages/api/test/auth.test.ts` | 不改 api/routes/index.ts、DB、web、其他 shared。首个可验证单元先产出 personal.ts 全部导出，通知另两线；不改 shared/access.ts 的原姓名/权限约束 |
| B：本人数据与回顾来源（Sonnet high） | `packages/api/src/features/personal/routes.ts`；`packages/api/src/routes/index.ts`（唯一注册新增 registerPersonalRoutes）；`packages/api/src/features/memory-reviews/routes.ts`；`packages/db/src/repo/output-shares.ts`、`packages/db/src/repo/runs.ts`；`packages/api/test/personal-data.test.ts`、`packages/api/test/memory-reviews.test.ts` | 不改 auth、shared、web、DB schema/repo/index。新增查询函数直接加入现有 repo namespace；me 分享路由调用同 repo owner-aware 方法，既有全局分享接口语义不变 |
| C：前端整合（Sonnet high） | `packages/web/**`；直接受路由/文案影响的 `tests/*.e2e.ts` | 不改 api/db/shared 和根配置；独占 api.ts、queries.ts、shell/nav、pages、routes 与 web 测试；routeTree.gen.ts 仅由 Vite 生成。不在其他线改动这些公共前端文件 |

三线可按固定字段同时实现，A 的新共享导出是另两线 typecheck 的真实依赖，等待该单元后再联编，不因此串行全部工作。新增路由注册只归 B；A 在现有 registerAuth 内接线，无注册文件争用。任务记录非本节、LoopX、产品/设计文档及最终验证由主会话另派文档执行者，A/B/C 不抢写；文档执行者需修下面已确认的过时状态。

### 6. 验收与证据要求

- A 行为测试先红：无权限叶但已登录的用户可改自己姓名、拒绝额外身份/角色字段和空白；未登录/停用/服务主体拒绝；非法 Origin 拒绝、可信预览 Origin 允许；响应无 token/Cookie/userId。A/B 两用户各两次原生登录：列表只有本人、current 准确，撤销本人其他 session 后旧 Cookie 401、当前 Cookie 仍可用；他人 session id/不存在 404，当前 session 409，老于默认鲜度的登录态 403；改密仍让全部旧 Cookie 失效且原账号密码错误时不撤销。全用隔离库和测试账户，不更改真实管理员密码。
- B 行为测试先红：四角色含管理员只返回本人；缺各权限 403；自己的运行使用别人创建的专家仍计入，别人使用自己专家不计入，服务运行不计入。cost 全 null/部分 null/真实 0/完整记录、空集合、失败/排队、UTC 日界均覆盖。shares 至少两个用户两个会话、撤销幂等、越权 id、分页相同 createdAt、越权游标；旧公开链接在本人撤销后 404。回顾 scope=own 拒绝管理员选择他人来源，不带 scope 保留已有授权；模型专家/目标/来源权限回归不退化。
- C 验证：侧栏展开/收起进入同一路由；所有子页直达、浏览器返回、标题/唯一 h1；只读回顾用户可看而无创建/采纳；姓名同步；重登提示不自动踢出；个人记忆保存/下载/版本/回滚/冲突留稿及离开保护；分享复制/撤销；usage 只请求有权区块，覆盖标签与五种来源跳转正确。按本人 UI 使用的接口做断言，禁止拉全局数据在浏览器过滤。
- 可执行验证（执行者按改动实际文件选择，不冒充已经通过）：先 `pnpm --filter @agentport/shared --filter @agentport/core --filter @agentport/db build`；`pnpm exec vitest run packages/shared/test/personal.test.ts packages/api/test/personal-auth.test.ts packages/api/test/personal-data.test.ts packages/api/test/auth.test.ts packages/api/test/memory-reviews.test.ts packages/api/test/output-shares.test.ts`；再 `pnpm --filter @agentport/shared --filter @agentport/api --filter @agentport/db typecheck`；前端 `pnpm test:web -- <受影响测试>`、`pnpm --filter @agentport/web build`、`pnpm --filter @agentport/web typecheck`。真实页面另在本树预览，不能借其他树的站点；基础设施不可用的 skip 逐项报告，不当安全通过。
- 契约阶段证据：官方文档与本地 d.mts/mjs 交叉核对完成；仅文档变更，不运行源码测试、不声称接口已存在。后续独立 Opus review 按本节与固定 diff 终审。

### 7. 与旧研究/当前文档的差异

- 旧 proposal 标为“研究未批准”，当前实施任务已批准；旧 proposal 将 shares/usage 列第二批，本轮范围明确一起完整交付。
- 旧研究没有指出原生 listSessions 的鲜度限制及敏感 token 字段，本契约补齐；本地 updateUser 返回 status，不能按文档元数据里的 user shape 实现。
- 现有 `overview` 可按 platform 放宽范围，own 分支的运行总计已按 initiatedBy，但专家分组列表仍按专家创建人限制，null cost 合成 0；个人模块不能原样套用，故固定本人新入口。现有 `/api/runs` 已有 initiatedBy own 口径，但管理员仍会走 platform，个人入口不能复用其默认结果。
- 现有 MemoryPage 以 review 叶控制回顾页签、回顾创建来源又直接使用普通 conversations 列表；本次分别修为 read/view 与 create 分离、本人来源列表 + 显式 own 写边界。
- 当前 PRODUCT.md:54 已写 RBAC 合入 main，docs/USER-STORIES.md:322、324、429 仍写未合入；main f430cd6 已含功能实现，后续文档线须同步这一过时状态。本代理权限仅本节，未越界修改这些产品文档。

## 已替代项及原因

研究阶段“只读不实施”已被实施授权取代；实施初次交付时 Git 未授权的状态，已被后续提交 PR、合并后收尾授权取代。

## 步骤

- [x] 读取流程和研究、从最新main建立干净隔离树、登记LoopX实施任务
- [x] 固定路由/API/共享类型与分工边界
- [x] 并行实现资料安全、本人数据、前端导航与页面
- [x] 更新产品/设计/用户故事和测试
- [x] 定向测试、typecheck/build、真实页面验证
- [x] 独立Opus终审与修复复核

## 验证

已完成基线：shared/core/db build、api/web typecheck、web build均通过；shell-route与personal-memory-page共55条通过；auth/accounts/output-shares共30条通过；personal-memory/memory-reviews/memory-changes共79条通过，无skip。以上为改动前基线，不冒充新增能力验证。

本树独享预览已启动：http://localhost:5177（API http://127.0.0.1:3127），配置位于.local/personal-module-preview/preview.env，独享随机PG personal_preview_8e455bb9121e481b与Redis backend_test_redis_8383542b08104228；凭据只存0600本地文件，不输出。浏览器空间personal-module-implementation，p1；已通过真实登录操作旧控件，展开用户按钮打开菜单，收起按钮点击仅展开侧栏且停留/agents，复现行为差异。当前视口展开底部运维与账户均x=12、w=200、h=32，y分别734/770，字号13/12px。最终实现后同环境量测，不用类名替代。

A线已完成实现，主会话复跑 `pnpm exec vitest run --project backend packages/shared/test/personal.test.ts packages/api/test/personal-auth.test.ts packages/api/test/auth.test.ts`：39/39通过，0失败0跳过。shared build通过；隔离API重启后真实浏览器 `/api/me/sessions` 200、Cache-Control:no-store，4条本人测试会话中恰好1条current，字段仅id/时间/IP/userAgent/current，无token/userId。独立Opus正在终审A范围，B/C仍实现中。

A独立Opus终审通过，B独立Opus终审通过（另实跑52/52）；主会话A+B联跑10文件155/155，0失败0skip，shared/db/api typecheck通过。前端迁入导航/记忆/回顾的3文件89条已通过、当前web typecheck通过，focus/contract检查通过；C尚未交付，后续扩读新增页面测试。

真实页面已完成姓名保存同步侧栏、收起点击直达且保持收起（x=16,y=770,w=h=32）、会话撤销确认及列表4→3且当前仍在、迁入CodeMirror个人记忆保存。当前测试视口1492×818，检查页均h1=1、无横溢出。分享/使用记录尚需非空样本验收；已派隔离seed脚本，不调用模型。

C当前web typecheck/build通过，四文件（新增personal-module+导航/记忆/回顾）96/96通过。真实姓名dirty离开提示与取消保草稿已通过；1024×768安全页子导航高32、无横溢出且h1=1。机械设计detect输出空数组。发现usage窗口使用本地时间格式却标UTC，已交C独立终审确认；其余非空数据与全流程验收仍待。

非空实屏已通过：管理员7条/成本0.0286覆盖4/7；普通用户真实退出重登后6条/成本0.0142覆盖3/6，双方分享与记忆彼此不同，服务运行不入个人。管理员2条分享复制动作可用、撤销weekly-report后变1条；chat来源进入对应/chat、review来源进入个人回顾详情、schedule进入/runs/:id。1024×768普通用户profile无横溢出且h1=1，个人导航32px。样本仅repo/schema插入，不调用模型，不能视为真实模型验证。

C终审发现4个P2待修：usage第三页不可达、窗口本地时间误标UTC、专家记忆/规则目标前端权限与查询门控不足、列表外运行中回顾详情无轮询。后端仍强制拒绝越权，修复后定向复核。

e2e定向 `all workspaces render the shared page shell|personal module opens as profile and exposes direct subpages` 实际报告selected/executed/passed=3（含共享登录setup），failed=0、skip=0；其余未选用例不计通过。普通用户个人记忆真实保存新版本，再回滚最新保存，GET下载200且正文恢复原PREVIEW-MEMBER-ONLY内容、Content-Disposition为CLAUDE.md。

修复后主会话4文件101/101、web typecheck/build通过；web全量134文件1618/1618通过。真实UTC窗口现显示10/02 00:00至当下UTC，单h1无横溢出；普通用户回顾创建目标菜单仅“个人偏好”，未提供专家记忆/规则，未提交模型任务。等待修复执行者完整报告及独立复核。

最终独立复核通过：四项前端修复均已确认、无新增阻断。固定源码SHA256前缀：personal-usage f485db51efa7、memory-review a2c992c74be2、personal-memory e328b7d68133、queries a648042d214d；新增测试e16b6b33e976/71f1177dd55b。A/B独立终审均通过。代码验证完成、未提交未合入main；不调用真实模型，不代表模型回顾归纳质量验证。

浏览器验收已结束并关闭空间；已执行本任务cleanup：停止API58899与web45553、删除Redis backend_test_redis_8383542b08104228、drop随机库personal_preview_8e455bb9121e481b；随后删除.local/personal-module-preview全部临时脚本/日志/样本/截图/凭据，不生成归档。测试生成的.vitest/json/output.json已按干净初始基线还原。代码差异保留，未提交未合main。

## LoopX交付

沿用goal user-center-research、agent user-center-researcher，实施todo_299de57c59ea00276af3bcaf已完成。final writeback为primary_goal_outcome，vision no_followup，settlement settled/next_step=null，终态完成continuation=no_followup；外部投递suppressed。原codebase-cleanup工作树期间已被清理，最终通过全局registry结算，四步回执均ok=true；若未来续用Goal需先更新旧工作树绑定。会话循环90e6900d已取消。

## main 集成（2026-10-31）

- 用户已明确授权提交 PR、合并后收尾；个人模块已审查并提交为 `69651141ed8a5ce00fc0b366999ea1a9e87a99bb`。本轮执行者只解冲突、验证与暂存，不 commit/push/merge；主会话将独立 Opus 复核集成 diff 后完成发布。
- 复用本树 `/Users/xbjt/Documents/myself/agentport/.claude/worktrees/personal-module`，HEAD 为 `6965114`，正在合并 `origin/main` 的 `d0900c81cd548ea5b369eafb20c4044c69bf104a`（PR145 前端审计、PR144 专家工牌）。初始已暂存差异均为该 merge 自动合并产物；六处冲突归本轮整合，不处理其他任务。
- 当前有效契约及 A/B/C 修复保留；吸收 main 的 `buttonVariants` 链接语义、SourceEditor、权限与 dirty/pending 审计成果，不恢复旧 `/memory` 路由或旧账户菜单，不改后端功能/schema。
- 范围：六个冲突文件、整合必要的关联 web 测试、本记录；定向核查自动合并的 `memory-panel.tsx` 与 `tests/regression.e2e.ts`。预览 API PID17083 保持运行，交付后由主会话收尾。
- 验证计划：`git diff --check`、web typecheck/build、全 web 测试；此前 1618 条结果不作为本次 main 集成证据。此轮是已有实现与测试的合并，使用现有行为测试验证双方契约，不机械重写实现制造红灯。
- 六处取舍：两份设计文档保留个人模块入口与分区，采用 main 的历史头部 32px 新建会话和侧栏展开 9px/收起 6px 几何；外壳保留个人路由与两种折叠入口，删除合并带回的旧 UserMenu/ChangePasswordDialog，同时保留 main 的 `Link` + `buttonVariants` 和圆角修正；回顾来源保留权限分支与 pending 保护，使用 main 的结构化 TanStack Link；个人记忆保留独立 panel、revision 草稿基线与 SourceEditor，下载采用原生 a + `buttonVariants`；回顾测试保留个人 memory/reviews 路由并添加 chat 路由，保留 main 新增在途与结算后真实导航测试，将旧 `/memory` 期望改为 `/personal/reviews`。
- 关联检查：`memory-panel.tsx` 自动合并保留 `/personal/reviews?agent=...` 与 canWrite/dirty/pending 门控，吸收下载链接语义及 dirty 回滚说明；`tests/regression.e2e.ts` 保留个人六分区回归与 `/personal/memory` 可访问名，搜索清除动作使用 main 新名称。新增关联断言：个人记忆下载没有显式 `role=button`。
- 真实验证：`git diff --check` 通过；`pnpm --filter @agentport/web typecheck` 通过；`pnpm --filter @agentport/web build` 通过（Vite 仅提示大于 500 kB chunk）；定向 `pnpm test:web packages/web/test/memory-review-page.test.ts packages/web/test/personal-memory-page.test.ts packages/web/test/personal-module.test.ts packages/web/test/shell-route.test.ts packages/web/test/memory-editor.test.ts packages/web/test/audit-action-feedback.test.ts packages/web/test/button-link-semantics.test.ts` 为 7 文件 132/132；最后 `pnpm test:web` 为 141 文件 1673/1673，0 失败、0 跳过。测试有 jsdom `scrollTo` 未实现提示，不影响结果。
- 补充检查：`pnpm lint:focus` 与 `pnpm lint:contract` 通过。五个改动的源码/测试文件 `pnpm exec biome check ...` 首次 RTK 摘要无诊断却显示失败，按 RTK 规则执行 `rtk bypass pnpm exec biome check ...` 后真实结果为 `Checked 5 files ... No fixes applied`、exit 0；未为此改代码。
- 文档冲突同步：旧设计中侧栏新建 28px、统一条目 radius 7 及旧账户菜单描述已按现有实现修正，保留个人入口最新契约；本任务顶部和“已替代项”中 Git 未授权的旧状态已改为后续真实授权。历史阶段记录保留其当时状态。
- 本轮没有编辑后端/schema、未停止 API PID17083，未执行真实模型或重新进行浏览器/E2E 验收；上述回归脚本仅定向检查源码。设计 sidecar 是 main 自动合并产物，本轮未扩展范围重新生成；文档快照与 sidecar 的更新时间提示不作为重新设计授权。

## 账号入口外观纠正（2026-10-31）

- 用户最新纠正：底部用户信息原有呈现方式没有问题，只是头像居中；不要改成普通侧栏菜单样式。仅纠正外观，不撤销六页/路由行为。
- 实现：展开态恢复账号触发器独立外观，用 `Link` + `buttonVariants({ variant: 'ghost' })` 保留链接语义，覆盖 `justify-start`，保持 200×32、12px 标签、7px 圆角与 20px 头像；不再按 `personalContext` 套 `bg-selected`，`aria-current` 保留但账号入口不呈现为导航选中行。收起态保持原 32 圆形头像，点击仍直达 `/personal/profile`；不新增下拉、不改密码、不动其它导航与颜色尺寸。
- 验证：`shell-route.test.ts` 新增账号独立外观/左对齐断言（先红后绿，42/42），`personal-module.test.ts` 9/9；未改后端与路由。

## 账号入口实屏复测

用户纠正后的构建已在预览实测：展开入口x=12,w=200,h=32；头像x=21,w=20，左内距9px；justify-content:flex-start、透明背景、字号12px、圆角7px，无bg-selected。保留独立账号外观与链接语义，非普通导航选中行。shell42与personal9测试、typecheck/build通过。

## 下一步

六处冲突已解决、集成验证通过；主会话独立 Opus 复核固定集成 diff 后提交 merge commit，再按已授权范围提交 PR、合并与收尾。本执行者只暂存明确的冲突及关联验证文件，不 commit/push/merge。
