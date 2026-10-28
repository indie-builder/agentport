# 原生澄清提问与同任务继续

## 目标

核对并接通US-6.2中的真实断点：用户目标缺少关键信息→智能体使用官方AskUserQuestion询问→用户在当前对话回答→同一次任务继续→交付成果并支持既有反馈修改。保留现有MCP工具人工审批，二者不混为一种授权。不扩展云服务或第二harness。

## 基线与授权

- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/agent-clarification`
- 分支：`worktree-agent-clarification`
- HEAD：`8f577becd99f16ea37571dd39502195a034789db`，刚fetch的origin/main，包含PR #96原生清单、#97成果查看及#98桌面首次用户修复。
- 初始代码差异：无；配置从主checkout.env复制，不输出凭据、不更改共享管理员。
- 用户续跑授权实现、验证、Opus独立评审、commit/push/PR/merge；CI不自动触发监控。主会话不改代码。

## 当前有效决定

- Opus只读设计已核对官方文档及已安装SDK类型：既有runner没有canUseTool，外层stdin只取首行，尚无问题/答案API或表单，属于真实断点。官方回调可保持pending；采用现有整体run超时，不引入新的独立等待配置。原生探针另行验证dontAsk拒绝和default成功。
- 涉及共享事件/schema/API/回答传输的契约固定后，才拆分互不重叠的Sonnet执行域。源码改动全部由子代理完成。
- 默认dontAsk下AskUserQuestion是否可被canUseTool正常处理必须有实测；不得为提问放宽其他工具权限。
- 首次完整验收至少包含提问、真实回答、同run继续、成果可查看；刷新待回答恢复与停止路径单列，不以单测代替真实SDK验收。

## 固定实现契约（官方文档核对后）

本节是首次派发契约；评审后的当前公开身份以「A/B交界修复执行者」一节的PublicRunQuestion/PublicQuestionResponse为准。运行request回调另接收sandbox实际启动时确定的expiresAt，已替代本节旧deadline推算。

- 官方https://code.claude.com/docs/en/agent-sdk/user-input及permissions：AskUserQuestion在dontAsk下直接deny；default可经canUseTool等待并以updatedInput原questions+answers继续。本地SDK0.3.311回调提供requestId、toolUseID、signal。主会话接提问，子级不开放。
- 新文件`shared/src/questions.ts`统一：`nativeQuestionInputSchema`（官方questions1–4，每题question/header/options2–4/multiSelect），`QuestionResponse={answers:Record<string,string>}|{decline:true}`，`RunQuestion={requestId,runId,toolUseId,questions,status:'pending'|'answered'|'declined'|'closed',answers:Record<string,string>|null,createdAt,resolvedAt:string|null,expiresAt,closeReason:string|null}`。全边界限定字符串/整体大小，不篡改原问题；重复问题文本不可回答则入口明确拒绝。
- shared chat事件增加`question_requested {requestId,toolUseId,questions}`、`question_closed {requestId}`（runner→worker），`question_updated {question:RunQuestion}`（worker→SSE/历史）；stdin命令`question_response {requestId,response:QuestionResponse}`。工具历史use/result的content附`question:RunQuestion`快照，前端chat-state保留。
- `repo.questions`统一导出函数：`createQuestion(db,{runId,requestId,toolUseId,questions,expiresAt}):Promise<RunQuestion>`、`listQuestions(db,runId):Promise<RunQuestion[]>`、`respondToQuestion(db,runId,requestId,response):Promise<RunQuestion|null>`、`closeQuestions(db,runId,reason,requestId?):Promise<RunQuestion[]>`。表使用newId('question')作为内部PK及unique(runId,requestId)；JSON字段保存官方questions/answers。respond入口锁run行、校验running/期限/精确题键/非空有界答案、同内容幂等、不同内容或关闭409，null404。close只pending，回答/拒答不可覆盖。新增独立repo文件，避免runs冲突。
- API单独`features/runs/questions.ts`导出`registerRunQuestionRoutes(rawApp)`，由既有registerRunRoutes调用。GET `/api/runs/:id/questions`→`{items:RunQuestion[]}`；POST `/api/runs/:id/questions/:requestId/response`→RunQuestion；typed/Zod/requireAuth/审计摘要；检查run取消marker，已取消409。无需新Redis键或服务。
- worker `SandboxRunInput`新增可选`questions`回调对象：`request(event:{requestId,toolUseId,questions}):Promise<RunQuestion>`、`list():Promise<RunQuestion[]>`、`close(reason:string,requestId?:string):Promise<RunQuestion[]>`。index注入db repo绑定并根据剩余整体timeout设置expiresAt。runner-client问题请求先await落库再question_updated，pending时500ms单轮无重叠轮询，answered/declined写一次stdin，任何响应不可重放到另一sandbox尝试。取消/超时/失败/retry/final清理pending并记录关闭快照；所有异步事件串行、收尾等队列，避免先run_finished后落问题。question_updated计入持久化事件，脱敏历史与普通消息一致；没有原生tool_result时也保留问题工具快照。
- Web API/query读live run问题，question_updated触发对应query更新/失效。共用`components/run-question.tsx`表单：单选/多选/每题其他输入、提交、暂不回答，已答/关闭只读；使用官方shadcn/BaseUI现有组件，无新依赖。chat与运行详情同用，历史不依赖run表保留期；Fork只复制只读工具快照不继承回答权限；切会话不带旧问题。
- `default`成为新建agent默认值（shared/DB/Web一致），显式dontAsk保留；其余模式直传。新增canUseTool对非AskUserQuestion一律deny，不返回updatedPermissions。现有文件边界hook、禁用工具、MCP审批不变，不能把回答当操作授权。
- 执行域：A shared+DB+API+defaults；B sandbox+worker+core提示；C web界面+状态+测试（不改agents.tsx默认，该文件归A）。先完成shared及repo签名再并行，其他域不编辑共享文件。

## 步骤

- [x] 阅读项目规则与用户故事、确认不重复已合并能力。
- [x] 收尾并合入前一桌面QA任务PR #98，创建新任务树；QA旧树已确认无未提交差异并删除，报告与截图已随PR归档。
- [x] 官方接口与现有链路核对，固定最小完整契约。
- [x] 子代理并行红绿实现，主会话按范围验证。
- [x] 独立Opus评审、修复复核（数据入口、运行链路、桌面交互三轮均发现真实问题，已修复并定点复核通过）。
- [x] 真实SDK/沙盒与桌面浏览器验收（第一轮浏览器回答+4条真实run通过；最终源码上4条真实run复测通过）。
- [x] 提交PR合并、记录证据、清理已合并工作树：实现由 [PR #99](https://github.com/indie-builder/agentport/pull/99) 合入 main（`1860b4f`）；隔离验收环境已`down`并核对无遗留进程/容器。

## 评审修正契约

- A/C评审未通过：实际复现关闭与回答覆盖、API原文泄漏/脱敏题键无法回答、无sidecar子定义默认遗漏、运行详情无已落库tool时缺入口、旧GET/回放覆盖终态、多选其他隐藏值、提交未禁用字段、过期仍可答。均按真实缺陷修复，非扩大理论防护。
- **对外答案键改为题目序号字符串**（从`"0"`起），GET/POST/SSE/历史RunQuestion均是脱敏投影，answers也按题序号。UI只提交题序号；repo入口将序号映射回DB保存的原问题文本，DB内部与发给SDK的stdin仍保持官方原问题键。SDK的QuestionResponse与表单共用record形状，但信任边界语义不同，测试明确区分，不使用脱敏文本识别问题。
- 现有worker脱敏函数迁到shared单一实现供API/worker复用，worker旧路径仅re-export保持现有调用；所有对外投影统一，不改给模型原文。问题关闭/回答锁同一问题行；已关闭不得被回答覆盖。
- Web修复单独进行，身份键待该轮结束后统一接线，不让两个写入者同时改Web文件。
- B域额外评审待修：答案轮询list异常不能只退出轮询、让SDK空等整体超时；问题期限需与sandbox实际执行截止一致（容器创建耗时不能提前挤占问答期限）；repo.runs.toStep保留question结构及终态刷新，防止运行详情永久显示旧pending。已知取消期间迟到stdin未证明能复活SDK调用，不作为缺陷扩大处理。
- 第二轮复核剩2项：原生伴随tool_input/tool_result仍原样进入SSE，需要统一公开事件文本脱敏且保留JSON语义；多题答案映射回原题键后的总量可能超过stdin约束，需在入库answered前校验映射后的完整QuestionResponse，明确失败而不让SDK空等。其余指定修复静态复核通过。
- 修复后的定向回归：后端13文件163/163；Web扩大回归旧权限文案断言同步后最终94文件970/970通过；焦点与项目规约检查通过。运行步骤真实API序列化快照用例已补红绿，避免只在内存测试中有字段。

## 阶段验证（2026-10-28）

- 共享问答9/9、sandbox通道12/12、DB问题10/10、API与worker问题13/13、Web表单8/8、chat/运行详情6/6均由主会话独立运行通过。
- 当前Web全量93文件956/956、全仓build/typecheck通过；后端问答相关9文件120/120通过。并行实现后有新增修改，最终收尾仍按最终版本复验。
- A域完成；0039迁移已在独立临时PG库应用并清理，未触及开发库。首轮Opus数据入口、Web交互与运行链路均发现问题、未通过，当前按上文逐项修复，不能据局部绿宣布能力完成。
- 隔离验收启动器的fd问题已修到可启动：随机PG/Redis、API端口59848、独立workspaces，未使用共享服务；最终契约修完后重启验收进程再发模型任务，避免在旧运行源上验收。
- 独立sandbox镜像`agentport/sandbox:clarification-live`构建通过。隔离验收启动器首次因日志WriteStream的fd尚未打开失败；正在仅修临时脚本并重启独立环境，未把该脚本错误归为产品失败。

## A/B 交界修复执行者（2026-10-28）

- 身份/范围：本执行者直接修复 shared/DB/API/worker 和 `agents.tsx` 权限说明；遵照本轮禁止派生，不启动代理、不提交、不重启服务。其他 Web 文件由 C 独占。
- 对外契约：保留 SDK `QuestionResponse={answers:Record<原问题文本,string>}|{decline:true}`；新增 `PublicQuestionResponse={answers:Record<题序号,string>,choices?:Record<题序号,string[]>}|{decline:true}`。`answers` 仅为自由文本，选择项通过 `choices` 中的选项原序号字符串传递，空 answers 用 `{}`；每题须有非空自由文本或非空 choices，单选最多一项且不能同时自由文本，多选可同时带两者。repo 锁问题行后校验题/选项序号、映射原 label，并按 `", "` 拼接原 label 与自由文本；DB/worker stdin 保持原问题键、原值。
- 对外 `PublicRunQuestion` 与内部 `RunQuestion` 显式区分；公开每个 option 新增 `value:String(原选项序号)`，问题/header/label/description/答案/closeReason 脱敏，answers 以题序号为键。API GET/POST 和 worker `question_updated` 各从内部记录调用一次 `publicRunQuestion`；history 收集已投影事件直接使用，禁止再次投影。worker `redact.ts` 仅 re-export shared 的唯一脱敏实现。
- 接线要求（C）：Web GET/POST 与 SSE/history 使用 `PublicRunQuestion`；POST 使用 `PublicQuestionResponse`，选项用 option.value 送 choices，其他输入送 answers，均以题序号为键。不存在原文本 key/原 label value 的兼容分支。
- 需验证：真实 PG 关闭与回答重叠并发、关闭优先返回 CONFLICT；API 敏感题/选项投影后以稳定序号回答，DB 与 stdin 原文不变；tool_result 早于终态 question_updated 时 history 仍为最终快照；无 sidecar 子定义 default。
- 红绿证据：真实 PG 用独占问题行锁排出 close→respond 两个等待者；修前 close 已完成仍被 respond 返回成功覆盖，补问题行 FOR UPDATE 后 respond CONFLICT、最终 closed。API 敏感题/选项用例修前 GET 泄露原凭证，修后 GET/POST 均脱敏、choices 序号还原原 label、同响应幂等。无 sidecar 子定义用例修前 dontAsk、修后 default。history 预收集逻辑在本执行开始已存在，保留并补 answered/cancelled 早 tool_result 后终态的断言；删除对已投影事件二次投影，保住索引 answers。
- 额外边界：多选 choices + 自由文本恢复为 SDK `", "` 字符串，保持自由文本空白原样；拒绝越界/重复选项、单选多项/混自由文本，以及拼接后超过 SDK 2,000 字符的答案。公开 schema 独立于原生唯一题文校验，允许两条原题脱敏后显示相同文本。
- 验证完成：`pnpm exec vitest run --project backend packages/shared/test/questions.test.ts packages/shared/test/agent-permission-default.test.ts packages/db/test/questions.test.ts packages/db/test/steps.test.ts packages/api/test/run-questions.test.ts packages/api/test/agent-md-import.test.ts packages/worker/test/runner-client-questions.test.ts packages/worker/test/message-persistence.test.ts packages/worker/test/redact.test.ts --reporter=default --no-file-parallelism` → 9 文件 94/94（PG/Redis 隔离基础设施实际可用，无跳过）；`pnpm --filter @agentport/shared --filter @agentport/db --filter @agentport/api --filter @agentport/worker typecheck` → 全部通过。
- 文档/代码冲突已在本段明确覆盖：旧固定契约的 HTTP 原题键与内部/外部共用类型已替换为 PublicQuestionResponse/PublicRunQuestion；原 `agents.tsx`“default 不提供 SDK 交互宿主”已改成支持原生问答、dontAsk 拒绝，保留服务端业务审批。未动其他 Web 文件，未做浏览器/真实模型验收、独立代理复审或提交。`biome check --write` 已整理本次 14 文件，剩测试夹具的非空断言警告，不将其宣称为零警告。

## 真实隔离验收第一轮（2026-10-28）

- 独立PG `clarify_live_ac4d916fe2b94ebb`、Redis `backend_test_redis_cf2fa59cb3f84a69`、API63479、workspace、随机管理员；未改变localhost3000或共享数据/配置。该轮运行源尚未包含第二轮复核新增的公开工具事件脱敏和映射后总量校验，修后需明确复测覆盖。
- 4次真实run均通过：主场景原生提问→待问无成果→浏览器刷新与运行详情仍可答→键盘选产品经理并提交→同run原生Write生成report.md196B；content/download/manifest sha均为`cf9446f00c63dd2145f7145158589d2042894a40ba727fb30633f183873e951b`。
- 同一主run的requiresApproval工具：批准前副作用计数0，批准后1；澄清回答未跳过业务审批。
- 拒答：question declined、run succeeded（模型明确缺少答案）；等待停止：run cancelled、question closed；20秒整体timeout：run timeout、question closed。关闭原因当前由SDK取消事件记录通用closed，不伪称区分了具体原因。
- 证据已从.tmp复制到`docs/qa/agent-clarification/{summary,main,decline,cancel-pending,short-timeout}.json`及main-report.md；[浏览器报告](../qa/agent-clarification/browser.md)与12张screens已归档，主会话已查看真实待问和成果截图。TaskSpace已finish。不将临时凭据/完整日志入库。

## 最终源码真实复测（2026-10-28）

- 重新 `pnpm build`、`down` 后以最终源码 `up`（新独立PG/Redis/API端口/workspace/随机管理员），执行4条真实模型run；未触碰localhost:3000、根.env与共享管理员。
- 主场景：run `run_01m615w7fvfzyvzskf0df95hm3`，提问「这份报告的目标受众是谁？」→ 回答产品经理 → 同run继续原生Write生成`report.md` 340B；manifest/content/download sha均为`a5a259c8b4c6fca7068d3dfe64cc736155258b35ca02c32b0cb4b1919afe4be6`；requiresApproval工具批准前计数0、批准后1。
- 拒答：declined + run succeeded；等待停止：cancelled + question closed；20秒超时：timeout + question closed。证据归档在`docs/qa/agent-clarification/final-run/`（第一轮与浏览器报告保留在原目录，不覆盖）。
- 清理：`down` 退出码0；复核查无遗留clarify容器/进程，隔离端口不再响应。
- 最终定向测试：shared/db/api/worker问题相关47/47（最后夹具整理后）；此前完整相关后端115/115、Web 94文件970/970；`pnpm typecheck`、`pnpm build`、lint:focus、lint:contract通过；本轮改动文件Biome通过。未跑全量后端（本轮无其他域改动，按改动范围验证）。

## 验证与限制

产品链路已在隔离环境完成真实沙盒/模型验收，并在最终源码上复测通过（见上节）。剩余限制：未覆盖多问题/多选在多轮真实模型中的组合、真实读屏与原生200%缩放、凭证跨两个流式增量帧的实时显示拆分；关闭原因在SDK取消路径落为通用`closed`，界面只展示状态；未实现通用“任意工具调用挂起等待人工批准”宿主，MCP审批保持独立。

原生小探针（2026-10-28）：SDK0.3.311，独立cwd/config、仅AskUserQuestion、两次运行。default回调1次，回传Alpha后成功输出Alpha；dontAsk回调0次，实际工具结果permission_denied。证据`.tmp/clarification-probe/result.md`；花费约$0.0153。仅证明宿主SDK回调，不替代Linux沙盒、DB/API/Web用户故事验收。

## 最后两项定点修复（2026-10-28）

- 范围：仅 `shared/redact.ts`、`worker/{redact,runner-client,messages}.ts`、`db/repo/questions.ts` 及其相关测试；未改 Web/API 源码，未启动代理、未提交、未重启或重跑当前 4-run 真实隔离验收（现有 API/worker/验收进程保持原状）。因此上节“真实隔离验收第一轮”的运行源不包含本轮修复，不将其当作本轮证据。
- P1 公开事件边界：`redactChatEvent` 成为 worker 唯一对外事件脱敏点，统一处理 `assistant_text` / `text_delta` / `tool_input` / `tool_result`（含 `todos`）/ `error` / `run_unavailable` / `run_finished.error`；先交给 `questionRuntime.handle` 使用原文落库/回写，再把脱敏后的同一对象同时写入持久化事件与 Redis/SSE。`question_updated` 已是 `publicRunQuestion` 投影，原样返回，不二次投影；SDK stdin 与 DB 原问题/原答案不变。
- P1 JSON 语法：`redactJson` 先解析工具入参并递归脱敏字符串值，再 `JSON.stringify`，避免既有整体正则把 JSON 结束引号吞进值里；截断的非法 JSON 退回文本脱敏。`messages.buildMessageRows` 也改用该函数，防止持久化阶段二次整体脱敏再次破坏语法。
- P1 红绿：新增用例在修前失败——持久化事件与 Redis Stream 均直接含 `sk-abcdefghijklmnop` 的 `tool_input`（原问题）、`tool_result`（原答案）、`assistant_text`、`text_delta`、`error`；修后 native 文本全部为 `sk-a***`，`tool_input.json` 可被 `JSON.parse`，SDK stdin 仍是原答案。Redis 用例实际读取 `run:<runId>:events`，未 mock 发布路径。
- P2 组合边界：`repo.questions.answersFor` 把公开题序号映射回原问题文本后，用共享 `questionResponseSchema` 校验最终 `answers` 整体载荷（与 runner stdin 同一 schema/上限），失败统一 `CONFLICT` 且不写 `answered`。未修改 `QUESTION_LIMITS.responseBytes`，未放宽真实 channel 上限。
- P2 红绿：新增 4 题用例，每题原题 200 字、选择 A + 1,900 字自由文本（映射后每题 1,903 字符合单题上限），修前 repo 写成 `answered` 但映射后 JSON 超过 8,192，stdin 会忽略并让 SDK 挂起；修后返回 `CONFLICT`，问题行保持 `pending`、`answers:null`。同形状的 4 题 500 字答案仍在限额内，返回 `answered`，证明拒绝范围只针对真实总载荷。
- 验证命令与结果：`pnpm exec vitest run --project backend packages/shared/test/questions.test.ts packages/shared/test/agent-permission-default.test.ts packages/db/test/questions.test.ts packages/db/test/steps.test.ts packages/api/test/run-questions.test.ts packages/api/test/agent-md-import.test.ts packages/sandbox/test/questions.test.ts packages/worker/test/runner-client-questions.test.ts packages/worker/test/message-persistence.test.ts packages/worker/test/redact.test.ts --reporter=default --no-file-parallelism` → 10 文件 115/115；`pnpm --filter @agentport/shared --filter @agentport/db --filter @agentport/api --filter @agentport/worker typecheck` → 全部通过；`pnpm --filter @agentport/shared --filter @agentport/db --filter @agentport/worker build` → 通过；`biome check` 对本次 8 个文件通过（测试夹具既有的非空断言警告不计为零警告）。
- 已知限制：`text_delta` 按单帧脱敏，凭证被拆到两个增量帧时实时流仍可能各显示片段；完整 `assistant_text` 与历史已脱敏，落库/刷新后不泄露。未新增跨帧缓冲，避免改变流式时序。
