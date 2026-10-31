# 系统架构现代化：本批执行契约

> 裁决日期：2026-10-31。固定基线 `68241bab58ad8ec59727d70677bec790af2a5ae2`。
> 工作树 `/Users/xbjt/Documents/myself/agentport/.claude/worktrees/system-architecture-modernization`。
> 本文只裁决已返回的前端/API 事实；后端/异步任务、AI 审计仍在运行，未返回不等于通过。本文不阻塞无共享文件的实现，也不替其他审计下结论。

## 1. 约束与结论

已读 `CLAUDE.md`、`docs/DEV-WORKFLOW.md` §2、`docs/PITFALLS.md`。保持现有 Fastify/Zod、Drizzle、TanStack Query/Router、Zustand 和 Claude Agent SDK；智能体仍由官方文件系统表达。本批不改 SDK 选项、加载目录或运行定义，不新增服务、worker、执行循环、依赖、缓存协议或理论防护；不清库、不改用户登录配置、不 commit/push/merge、不改 `.loopx/`。

本批选择三个实现单元：A 响应边界与共享类型；B 健康流停止重复运行详情轮询；C 账户客户端状态隔离。B/C 合并为一个 Sonnet 执行分区，保证 `queries.ts` 单一写者。A 与 B/C 并行。

四项候选均有真实问题，但严重性不同：会话内部字段上 wire 与跨账户草稿串用属于必须修复的边界；健康流重复拉取完整 steps 是已有请求浪费；共享类型漂移是本次契约收口顺带完成的同源修复。成果 JSON 已经过 core 的 manifest 边界，不认定为当前泄密；其三个现有 JSON 端点可直接复用 shared schema，以很小改动完成本次会话读链的响应约束。

## 2. 独立核实的事实与证据

| 编号 | 实际事实（均为基线代码） | 裁决依据 |
|---|---|---|
| F1 | `packages/db/src/repo/chat.ts:121` 的 `getConversation()` 返回整行；`packages/api/src/features/chat/routes.ts:676` 详情仅声明输入 schema，`conversation` 原样返回。消息只手动排除 `sdkMessageUuid`。 | `sdkSessionId`、`forkFromSdkMessageUuid` 等内部续聊状态随会话 JSON 暴露，响应边界没有固定白名单。不要缩减 repo 返回值：授权、分支、worker 等内部调用需要这些列。 |
| F2 | 同文件 `:655` search、`:991` list 无响应 schema；已有 ISO 投影。`PATCH :729` 已投影四个公开会话字段但日期为 Date；`POST .../branch :987` 同样整行返回。 | 分支与详情是同源缺口，应一起修；不是借机全仓补 response。 |
| F3 | `packages/shared/src/chat.ts:353-401` 已定义消息/详情，含 `content`、`uiFormat`、`uiProgram`、`uiState`、runMetrics、分页。shared `outputs.ts:73-100` 已有成果文件、列表、正文 schema。 | 复用已存在契约。UI 历史恢复依赖消息身份、runId、格式和状态，不能缩减成 text。 |
| F4 | `packages/api/test/chat.test.ts:254` 已断言分支返回 `parentId`、`branchOfMessageId`；`conversations.test.ts:140` 断言消息含 `senderBusinessId`，但 web 无此字段消费，shared 消息也未声明它。 | 分支关系是已有明确行为，保留；senderBusinessId 属未声明且无 UI 消费字段，详情收口后剔除，测试同步，不扩展 shared 来保留整行泄漏。 |
| F5 | `pages/chat.tsx:2128` 的 RunReconciliation 无条件 `useRun(runId)`；`lib/queries.ts:750` 每 2 秒拉 `RunDetail` 全 steps。`features/chat/routes.ts:515-581` 同时每 2 秒查终态并补发 SSE。 | 健康 SSE 下重复获取完整详情没有必要。服务端补终态、断线回放及 canonical 恢复均已有，继续复用。 |
| F6 | `use-chat-stream.ts:665` 接受发送时、`:299` onopen 都置 streaming；因此尚未连接也可叫 streaming。`:327` 收到服务端 error 只置局部标记，`:429` onerror 才降级。 | 不能直接把 streaming 当连接健康。必须同时修正初始连接、error、onerror 状态，然后才关闭健康期间周期请求。 |
| F7 | `pages/chat.tsx:460-464` 取消的 onSettled 会 invalidate `['run', runId]`；`:2137` 和 `use-chat-stream.ts:688` 允许 streaming 下 cancelled 收口，但保护成功/失败/超时仍有缓冲的流。 | 保留 query observer 和 invalidate；不能用 enabled=false 把取消回读禁用，也不能让数据库终态覆盖尚未消费完的流。 |
| F8 | `queries.ts:110` clearSessionQueries 只清 Query；`chat-store.ts:168` reset 已能清内存和 sessionStorage 所有草稿，但生产无人调用。草稿按会话槽存储，没有账户归属。 | A 显式退出后 B 登录，B 可见 A 新会话槽草稿；这是实际隐私边界，不是理论竞态。复用 reset。 |
| F9 | clearSessionQueries 同时被两个退出入口、密码修改后和 login onSuccess 调用；401 在 `api.ts:762` 用 location.assign 到登录页，sessionStorage 保留。登录成功先清 Query 再 fetch `/me`。 | 不能让每次清 Query 都删除草稿，否则同账户过期重登/改密会丢稿。必须区分显式退出和身份确认。 |
| F10 | shared `schemas.ts:22-121` 与 web `api.ts:253-358` 重复定义运行和概况响应；web 漏 trigger/errorKind，OverviewAgentRow.createdAt 写成必有 string，而 shared 可 null。`formatRelative()` 已能处理 null。 | 共享 schema 推导类型为唯一来源；不修改运行/概况 wire，不加第二层浏览器逐响应解析。 |

### 本次真实验证

2026-10-31，在本任务树用 `pnpm --filter @agentport/api exec node --input-type=module -e '…'` 调用安装中的 Fastify、serializerCompiler、Zod，注册两个无数据库测试端点，再通过 `app.inject()` 断言：

- `/iso` 的 schema 为 `{ createdAt: z.string(), content: z.unknown(), uiState: z.unknown().nullable(), uiProgram: z.string().nullable() }`；handler 额外返回 `sdkSessionId`。结果 200，额外字段被剔除；content/uiState 中嵌套对象、数组、null 完整保留。
- `/date` 向同一 string 字段返回 Date，结果 500。
- 输出：`PASS: extra fields stripped; nested unknown JSON preserved; Date requires ISO projection`。

可复现命令（与本次实际执行等价排版，无需落临时文件）：

```sh
pnpm --filter @agentport/api exec node --input-type=module -e '
import assert from "node:assert/strict";
import Fastify from "fastify";
import { serializerCompiler } from "fastify-type-provider-zod";
import { z } from "zod";
const app = Fastify();
app.setSerializerCompiler(serializerCompiler);
const schema = z.object({ createdAt: z.string(), content: z.unknown(), uiState: z.unknown().nullable(), uiProgram: z.string().nullable() });
const nested = { blocks: [{ custom: { a: 1, b: null } }] };
app.get("/iso", { schema: { response: { 200: schema } } }, async () => ({ createdAt: new Date(0).toISOString(), content: nested, uiState: nested, uiProgram: "root = Text()", sdkSessionId: "internal" }));
app.get("/date", { schema: { response: { 200: schema } } }, async () => ({ createdAt: new Date(0), content: nested, uiState: null, uiProgram: null }));
const ok = await app.inject("/iso");
assert.equal(ok.statusCode, 200);
assert.deepEqual(ok.json(), { createdAt: "1970-01-01T00:00:00.000Z", content: nested, uiState: nested, uiProgram: "root = Text()" });
assert.equal((await app.inject("/date")).statusCode, 500);
console.log("PASS: extra fields stripped; nested unknown JSON preserved; Date requires ISO projection");
await app.close();
'
```

此验证证明底层行为，不替代真实会话路由、授权与流式生命周期测试。基线依赖安装、shared/core/db build、全仓 typecheck/build、lint:contract/focus 通过由控制会话提供，本裁决未重复运行；大 chunk 提示不构成本批架构缺陷。

## 3. A：响应边界和共享类型

### 写入边界

唯一 shared 写者为 A（Sonnet high）：

- `packages/shared/src/chat.ts`：需要时提取公开会话四字段 schema，给详情、改名复用；新增分支公开 schema，四字段加 `parentId`/`branchOfMessageId`（nullable string），不带 SDK 状态。不要因各 schema 共用 status 顺手全仓重构。
- `packages/shared/src/schemas.ts`：补充实际使用的 `RunStatus`、`RecentRun`、`RunStep`、`RunDetail`、`RunList`、`Overview`、`OverviewAgentRow` 类型；均由现有 schema `z.infer` 或索引访问推导。`RunListItem` 已有，直接复用。index.ts 已 export *，无新出口需求不编辑它。
- `packages/api/src/features/chat/routes.ts`、`packages/api/src/features/chat/outputs.ts`。
- `packages/web/src/lib/api.ts`：删除重复 Run/Overview 声明，导入并重新导出 shared 类型，保持现有 web 导入路径；branch 返回类型与公开 schema 对齐。此文件与 B/C 不共享写入。
- 测试：优先扩展 `packages/api/test/conversations.test.ts`、`chat.test.ts`、`conversation-search.test.ts`、`outputs-routes.test.ts`；必要的 shared 序列化行为测试可集中在一个新测试文件，禁止每 schema 各造套件。web 测试仅在共享类型使真实 fixture 不符时修正，由 A 明确列出文件并避开 B/C 测试。

### 响应矩阵

| 端点 | 成功 response schema | 必要投影 |
|---|---|---|
| GET `/api/conversations/:id` | 直接用 `conversationDetailSchema` | conversation.createdAt、每条 message.createdAt 显式 toISOString；runMetrics.endedAt 已转换。conversation 只四个公开字段；消息按公开字段构造或让 schema 剔除额外键。 |
| GET `/api/conversations/search` | 直接用 `conversationSearchResponseSchema` | 保留现有 updatedAt ISO、match、excerpt、nextBefore。 |
| GET `/api/conversations` | `z.array(conversationSummarySchema)` | 保留现有 createdAt/updatedAt/lastMessage.createdAt ISO，以及空 lastMessage。无需新增同义列表 schema。 |
| PATCH `/api/conversations/:id` | 公开会话 schema（可复用 `conversationDetailSchema.shape.conversation`，仅在复用值得时提取命名常量） | 四字段及 createdAt ISO；不扩展响应。 |
| POST `/api/conversations/:id/branch` | 新分支公开 schema，状态 201 | 四字段及 parentId、branchOfMessageId，createdAt ISO；不改变分支事务/文件复制/回滚。 |
| GET `/api/conversations/:id/outputs` | 直接用 `outputListSchema` | core 已返回 JSON 字符串日期，不二次转换。 |
| GET `/api/conversations/:id/outputs/:runId` | `z.object({ file: outputFileSchema })` | 保留所有文件元数据和两个消息锚点。无需新增同义导出。 |
| GET `/api/conversations/:id/outputs/:runId/content` | 直接用 `outputContentSchema` | 保留正文、mediaType、sha256、文件大小、状态、锚点；现有 1MiB/类型/UTF-8 校验不变。 |

只给 200/201 注册成功 schema，不用 `default`/`2xx` 改写 Problem 错误路径；204、SSE、Buffer 下载不套 JSON schema。不改全局 serializer，不加 replacer/date codec，不在 handler safeParse，不缩减 repo select。

### 数据不变量

- SDK session/message UUID 及会话 createdBy/serviceId 等内部状态不得出现在详情、分支公开对象中。已约定的分支关系字段保留。内部数据库、授权、续聊、fork 不变。
- `content` 和 `uiState` 继续用现有 unknown JSON：既有对象、数组、标量、null 及嵌套未知键保持 JSON 等价；不把它们改成 `z.object({})`，不逐块过滤、转换或重建 SDK 内容。字段顶层白名单与任意 JSON 正文是两个不同边界。
- uiFormat/uiProgram/uiState、消息 id/conversationId/runId、全部 runMetrics 和 nextBefore 必须完整保留。空消息、空成果、最后一页和含有效游标的分页都成功。
- 共享类型反映当前 schema：createdAt 可 null、trigger 可选、errorKind 可空可选；不为了匹配旧 web 类型修改 schema，不把 optional 改 required。formatter 已支持 null，无需增加兜底。

### 红绿与验收

先添加真实 HTTP 断言，在基线上确认“详情/分支内部字段不可见”因字段仍存在而失败，再实现；避免只测 `.parse()` 自证 schema。不要求成果端点先凑红：既有正确行为保留并增加 schema 接线证据。

至少覆盖：带非空 sdkSessionId/forkFromSdkMessageUuid 的会话；消息非空 sdkMessageUuid；OpenUI 快照带嵌套未知状态键；content 对象与数组；ISO 日期；详情分页/读数；分支关系；search/list 包装与游标；成果三个 JSON 端点、下载头和二进制不受影响；既有 401/403/404/400 Problem。分支关系断言保留，senderBusinessId 的旧整行断言改为不存在，不能为过测试扩 schema。

```sh
pnpm --filter @agentport/shared build
pnpm exec vitest run --project backend packages/api/test/conversations.test.ts packages/api/test/chat.test.ts packages/api/test/conversation-search.test.ts packages/api/test/outputs-routes.test.ts packages/api/test/route-access.test.ts
pnpm --filter @agentport/api typecheck
pnpm --filter @agentport/web typecheck
```

若新增了独立 serializer 行为测试，将其真实路径加入 backend 命令。数据库/Redis 不可用导致 skip 时明确列出，不能算路由验证通过；不借测试启动共享 worker、改共享登录或清库。

## 4. B：健康流与回读恢复

### 行为契约

- `useRun` 保留默认详情页行为（运行中每 2 秒取步骤），增加最小的可选轮询开关，默认开启；会话 RunReconciliation 仅在 run.status !== streaming 时允许周期拉取。
- 只修改 refetchInterval，保持 observer enabled、相同 `['run', id]`、首次获取、错误重试、手动 refetch、取消 onSettled invalidate 可用。不能用 enabled=false，也不能卸载 RunReconciliation 来关闭 polling。
- 已接受但 EventSource 尚未 onopen 时用现有 reconnecting 状态，onopen 才 streaming；同步修正 RunState 注释/依赖状态的必要测试。onerror 按原有重试上限转 reconnecting/detached。收到协议 error 时立即失去健康资格，最小做法标 detached，保留 runId/停止能力；现有 source.onerror 的清理与有限重试控制仍负责连接生命周期，不创造新状态机。
- 断线/首次连接期间继续现有 2 秒 fallback；从 streaming 变为非 streaming 后，已有 running/queued 缓存须恢复定时请求。存在缓存终态时原 reconcile effect 应能接管。必须用真实 observer 测试证明不会因旧缓存或 staleTime 永久停在 detached。
- streaming 下成功/失败/超时 DB 终态不能抢走尚在缓冲的文本；取消的 invalidate 回读仍可按既有 cancelled 分支恢复。正常 run_finished/run_unavailable、截断后 canonical 消息恢复、消息身份/UI 快照和 generation 作废规则不变。
- 不新增心跳、watchdog、连接超时或状态 API。streaming 表示已 onopen 且没有已知 error，不声称证明无静默网络中断；浏览器 error 与服务器补终态仍是已有恢复机制。

### 红绿与量化验证

用真实 QueryClient/useRun observer 与可控 EventSource、假时钟或等价受控计时器验证请求计数，不能 mock useRun 后声称轮询消失：

1. 基线：初始取到 running 后，连接健康推进至少 6 秒，完整 GET `/runs/:id` 仍每 2 秒发生；测试应红。
2. 修复：同场景只保留首次请求，健康窗口没有周期详情请求；至少继续消费一个 text_delta 再 run_finished，输出不丢。
3. 初始连接未打开、onerror 重连、协议 error 未等 onerror、重试耗尽 detached 均恢复 fallback；随后终态回读正常完成。onopen 后再次停止轮询。
4. streaming 时取消 invalidate 仍发请求并处理 cancelled；详情页默认每 2 秒仍更新步骤，终态停止。健康时收到别的终态缓存不提前截流。
5. 原有断线回放、截断恢复、切走后旧结果不落地测试保持通过；独立审批和原生提问轮询均不改。

不以 bundle 大小充当性能证据。本问题直接以同一运行、相同 6 秒窗口的完整详情请求数作为前后基准，不需要编造生产延迟收益。

## 5. C：账户客户端状态隔离

### 行为契约与最小实现位置

- 不把 clearSessionQueries 偷改为无条件删除草稿。Query 缓存清理继续复用现有函数；两个显式退出入口调用完整账户清理（Query + `useChatStore.getState().reset()`），删除会话槽草稿、内存消息、input、run/lastRun/lastRunId、引用、附件和 historyOpen。可以新增一个确有两个退出调用者的窄 helper，不建通用 store registry。
- 草稿属于同一业务人员 `AuthMe.user.businessId`。仅在现有 chat-store/sessionStorage 中增加一个最小归属标记与身份绑定动作；不是认证状态，不存 token，不扩成按账户历史草稿仓库。复用现有草稿 JSON，不迁移旧格式、不为旧未归属草稿增加兼容层。
- `/me` 成功且 authenticated=true 时，在结果交给受保护内容前绑定身份；推荐放在现有 `meQuery.queryFn`：先 await api.me，再同步调用 chat-store 的身份绑定，最后返回身份。同一身份不得每次 `/me` 都 reset；不同身份或无归属的残留数据先 reset，再记录新 businessId。绑定只处理 chat 状态，不在当前 `/me` queryFn 中 client.clear，以免取消自身请求。
- 登录成功仍先清 Query，再显式 fetch 新 `/me` 并确认 authenticated 后导航；身份确认失败/unauthenticated 时不绑定、不删已有归属草稿。登录页已登录自动回跳也通过同一 meQuery。显式退出后完整 reset 同时移除归属标记。
- 401 只沿用原有跳转，不删草稿；同一 A 重新登录、普通刷新/切会话/离开聊天页/修改密码后的 A 重登均保留属于 A 的未发送文本。B 确认身份后在其聊天内容渲染前清掉 A 草稿与内存。身份未确认的草稿不展示给另一账户。
- 现有 sessionStorage 不可用时保持进程内归属和草稿可用，不增加另一个持久层；失去持久归属时不跨刷新猜测归属。只清本产品聊天键，不用 sessionStorage.clear/localStorage.clear，不删无关偏好。
- 完整 reset 与已有聊天卸载共同作废请求：验证显式退出时运行中的 EventSource、重试计时器关闭，晚到发送/恢复结果不能给新账户重新写回草稿/消息。优先使用已有 closeStream、generation 和卸载清理；若真实失败需要改动 lifecycle，只在 B/C 分区内补最小修复，不加跨应用取消框架。

此归属标记是阻止已证明的 A→B 串稿并保留 A→A 草稿所需的最小事实，不是新的登录系统。首次没有归属的旧草稿被清理，不做迁移；这是本批可见的行为变化，必须在最终交付说明。

### 红绿与验收

先以生产清理入口或真实登录路由复现 A 草稿在 B 身份确认后仍可读，测试应红。复用 `login-route.test.ts`、`chat-drafts.test.ts`、`chat-lifecycle.test.ts`，可新增一个聚焦 session 清理的测试文件用于完整状态断言；不只直接测 store.reset。

至少覆盖：两个显式退出入口、A→B（含 401 后换账户）、A→A 401 后重登、同账户 `/me` 多次刷新/登录页自动返回、改密重登、`/me` 失败与未认证不误删、空槽及已有会话草稿全部隔离、附件/成果引用/运行结果清空、无关 sessionStorage 键保留，以及进行中请求/事件在切换后的归属。

## 6. Sonnet 执行分区、依赖与联合验证

| 执行者 | 模型/effort | 唯一写入文件 | 不得写入 |
|---|---|---|---|
| A：API/client 契约 | sonnet high | §3 的 shared、chat API、web api.ts 及对应 backend 测试；必要 fixture 改动先报文件清单 | queries.ts、chat-store.ts、use-chat-stream.ts、chat.tsx、app-shell.tsx、login.tsx、B/C 测试、LoopX |
| B/C：流恢复与账户隔离 | sonnet high | `packages/web/src/lib/queries.ts`（唯一写者）、`lib/chat-store.ts`、`lib/use-chat-stream.ts`、`pages/chat.tsx`、`components/app-shell.tsx`、`pages/login.tsx`；测试 `chat-stream.test.ts`、`chat-recovery.test.ts`、`chat-lifecycle.test.ts`、`chat-drafts.test.ts`、`login-route.test.ts`、`login-redirect.test.ts` 和必要聚焦新测试 | 全部 shared、web api.ts、API/DB/worker/SDK 文件、A backend 测试、LoopX |

A/B/C 不各建树，均使用本任务树。类型合同先由本文固定，B/C 可继续从 web api 模块导入现有名字，不等待 A 修改 shared；A 完成 shared build 后再做联合 web typecheck，此处存在真实构建产物依赖。若后端/AI 代理提出同文件实现，先由控制会话重新划分所有权再写，不覆盖并行工作。

B/C 执行命令（从任务树运行；新增测试实际路径须加入命令）：

```sh
pnpm test:web packages/web/test/chat-stream.test.ts packages/web/test/chat-recovery.test.ts packages/web/test/chat-lifecycle.test.ts packages/web/test/chat-drafts.test.ts packages/web/test/chat-ux.test.ts packages/web/test/login-route.test.ts packages/web/test/login-redirect.test.ts packages/web/test/api-requests.test.ts
pnpm --filter @agentport/web typecheck
```

联合后按实际变更选完整范围，不重复没有变化的基线检查：

```sh
pnpm --filter @agentport/shared build
pnpm --filter @agentport/api typecheck
pnpm --filter @agentport/web typecheck
pnpm --filter @agentport/api build
pnpm --filter @agentport/web build
pnpm lint:contract
pnpm lint:focus
```

另外运行新增行为测试和原相关 suites，逐条记录命令、红绿原因、通过/跳过/失败。独立 Opus high 终审按本基线后的固定 diff、本契约与真实验证输出检查；未经审查不宣称交付完成。当前只完成方案裁决，无源码实现结果。

## 7. 保留不改与冲突说明

- runs 列表限制/分页已由 `docs/REMAINING-TODOS.md` 延后，本批不扩；不借 API 技能的通用分页建议改变既定范围。
- 不改 repo 的整行 getConversation；问题在公开响应投影，内部确实依赖授权与 SDK 列。list/search 已有摘要查询，不重写数据访问。
- 成果下载、SSE、JSON 导出、附件及公开分享端点已有各自语义，不为 schema 覆盖率统一包裹。本批不扩到全部无 response 路由。
- 保留服务端 SSE 每 2 秒终态补偿、审批/原生提问独立轮询及运行详情页步骤轮询；各有不同职责。
- 不迁移 Zustand 草稿到 persist middleware；现有 read/write/reset 足够，只补真实账户归属。不改认证服务、账号、cookie、密码和服务器登录配置。
- 不用 chunk 警告、文件长度或无生产证据的吞吐量推断架构缺陷；不引入组件表单工具整顿。
- 代码与注释/类型冲突：routes.ts 原注释“只回前端契约字段”与直接返回 conversation 整行不符；实际还暴露 senderBusinessId。web Overview.createdAt 的非空声明与运行中的 shared 响应 schema 不符，Run 类型漏 trigger/errorKind。`streaming` 初始值与“连接健康”含义不符。clearSessionQueries 注释“清空所有用户私有数据”与仅清 Query 的实现不符。执行时在原文件修正这些失真的说明，不另建报告。

## 8. 官方来源与查证日期

均于 **2026-10-31** 查证，官方事实与本项目设计选择分开：

1. Fastify 官方 [Validation and Serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)：响应 schema 可约束输出并避免意外披露。注意本文不把 Fastify 默认 fast-json-stringify 的细节当成本项目运行行为；app.ts 实际覆盖为 Zod serializer。
2. 已用依赖上游 [fastify-type-provider-zod](https://github.com/turkerdev/fastify-type-provider-zod)：v7 用输出类型做序列化。另核对安装版本 `7.0.0` 的 `src/core.ts:222-236`，实际 `safeEncode(schema, data)` 后 `JSON.stringify(result.data)`；前述本地 inject 实验证明字段和日期行为。版本来自锁文件，Zod 实装 `4.6.7`。
3. Zod 官方 [API：Objects / Unknown](https://zod.dev/api)：z.object 默认去掉未知键；z.unknown 接受任意值，任意 JSON 子树不自动按空 object 清空。不是任意 JS 值都保证可 JSON 序列化，本项目 content/uiState 来源为既有 JSONB。
4. TanStack Query 官方 [useQuery](https://tanstack.com/query/latest/docs/framework/react/reference/useQuery)：refetchInterval 函数可返回 false 停止周期请求，保留正常挂载取数；[Disabling Queries](https://tanstack.com/query/latest/docs/framework/react/guides/disabling-queries)：enabled=false 会忽略 invalidate/refetchQueries 引发的请求，故本项目不能用来表达“健康时不轮询”。
5. Zustand 官方 [Persisting store data](https://zustand.docs.pmnd.rs/reference/integrations/persisting-store-data)：存储清理与内存状态是不同操作。本项目实际未使用 persist middleware，已有 reset 同时处理两者，应复用而非新增 persist。该页面不证明本项目账户归属策略；businessId 归属是针对 F8/F9 的项目裁决。

未使用无法访问的官方 URL 作为结论依据；未查 SDK 资料，因为本批不裁决 SDK 能力、配置、默认行为和加载规则。后端/AI 审计须各自提供其官方和本地类型证据，之后再决定是否另增执行单元。
