# 记忆升级执行契约

> 2026-10-31；工作树 `/Users/xbjt/Documents/myself/agentport/.claude/worktrees/memory-upgrade`，分支 `feat/memory-upgrade`，基线 `522182f`。这是已授权执行的设计契约，不是实现完成报告。主会话仅编排，Sonnet 执行、Opus 独立评审；不等待再次确认，不 commit/push/merge。
> 本文只固定本任务范围。实现结果与真实验证记录回写 `docs/tasks/memory-upgrade.md`，不得把下文验收条件写成已通过。

## 1. 问题与最终选择

当前已有官方 auto-memory、主题 Markdown、个人偏好投影、子智能体 `memory: project`、历史回顾与变更账本。具体缺口是：历史回顾的 `agent_memory` 没有文件名，读取/采纳/回滚硬编码 `MEMORY.md`，worker 明令禁止新主题；主题手工编辑绕开账本，主题版本接口始终返回空；无变化的成功回顾仍显示“待采用”。因此详细经验只能挤进索引，或由用户手工另建主题后再次整理。

采用“现有历史回顾接通官方主题文件”的完整功能集：

1. 回顾目标明确到 `MEMORY.md`、已有主题或用户命名的新主题；每次只处理一个目标正文，复用最多 10 段会话、一次 SDK query、现有预算与超时。
2. 模型在当前正文上提炼、更新、合并、跳过，保留其它内容；平台确定地维护主题发现链接，不让模型重写整个索引。
3. 用户查看目标正文与必要索引变化、来源及归因后采纳；不采纳不写文件。主题与必要索引作为一次逻辑变更采纳、记账、恢复和回滚。
4. 手工主题编辑进入同一账本；记忆面板可查看所选文件版本、回滚，下载原生记忆目录。运行时仍由 SDK 加载 `MEMORY.md`、按需读主题，不增加注入器。
5. 正确区分运行成功、无变化、待采用、已采用、已拒绝、已回滚、失败和取消。

UX：经验能按主题保存、看清影响与来源、恢复误改。DX：复用文件写入、账本、锁、query 和编辑器，只扩目标及伴随索引快照。AX：仍是 SDK 可原生读取的 Markdown 与短索引，无第二套记忆语义、服务或工具。

## 2. 证据与能力取舍

腾讯只读参考：`/Users/xbjt/Documents/myself/TencentDB-Agent-Memory`，HEAD `ecc01a545da0b2ac6cae2f0f0af0d39d41469793`，研究代理已核实工作树干净。完整事实报告见 `docs/tasks/memory-upgrade-research.md`；本表是执行选择。下列腾讯路径相对于该参考仓，Agentport 路径相对于本工作树。

| 腾讯能力 / 证据 | Agentport 现状 | 迁 / 调 / 不迁及理由 | 本次验收 |
|---|---|---|---|
| L0 原话与 checkpoint：`MemoryCore/src/core/hooks/auto-capture.ts:96` | `chat` 消息及回顾来源窗口已落库 | 复用，不建 L0 表。腾讯 Proxy 只捕获清洗后最新问答，不能据 README 声称完整原始上下文 | 来源消息固定到 from/through，后续消息不混入；证据仍能核对原话 |
| L1 单次抽取：`MemoryCore/src/core/record/l1-extractor.ts:177` | `worker/src/memory-review.ts` 已一次 query 产整篇提案 | 调：提炼长期、独立可理解的内容，补明确归因；不建原子记忆记录库、不机械采用最近 10+5 窗口 | 当前正文保留，重复结论不堆叠；超预算在调用前拒绝 |
| store/update/merge/skip：`MemoryCore/src/core/record/l1-dedup.ts:118,133`、`MemoryCore/src/core/record/l1-extractor.ts:311` | 当前正文已是自然的合并基线 | 调：在一次完整文本提案中完成新增/更新/归并/跳过，不增加 action 字段或第二次判重调用 | 新增、纠正、归并、重复无变化各有 fixture；同内容不新增版本 |
| 判重按 session，召回可跨 session | 现有回顾最多 10 个显式选中会话；专家记忆跨 run | 调：允许同专家多个会话一起对照目标正文；不宣称全库语义去重 | 两会话相同结论归并；不越过目标专家和来源会话权限 |
| L2 场景聚合：`MemoryCore/src/utils/pipeline-factory.ts:751` | 官方主题文件可读写，回顾目前不可选主题 | 迁其组织原则：主题 Markdown 承载详细经验，以现有用户触发回顾替代私有 L2 管线 | 已有主题更新和新主题创建都可端到端采纳、版本回滚 |
| L2 场景导航：`MemoryCore/src/core/scene/scene-navigation.ts`；Proxy 按需索引 | `MEMORY.md` 官方启动索引，主题按需读 | 调：平台为缺少链接的目标补相对链接，保留原索引全部正文；不引入腾讯内部导航标记或嵌套私有层级 | 索引可发现新主题，旧主题链接/正文原样保留，无重复补链 |
| L3 persona / 工作原则：`MemoryCore/src/core/persona/persona-generator.ts:110`、`MemoryCore/src/core/prompts/persona-generation.ts:144` | 个人偏好 + 官方 rules + 索引摘要已覆盖 | 复用并明确目标归属，不新增 L3 文件格式、画像生成器或稳定前缀注入 | personal 不写专家目录；规则仍按 globs；专家经验不伪装个人事实 |
| 来源 `source_message_ids`、generation 日志：`MemoryCore/src/core/record/l1-extractor.ts:235`（`source_message_ids`）、`:300`（generation 日志） | review sources/evidence、run 花费、memory_changes 已有 | 调：证据增加归因类别，UI 可打开来源会话；记忆正文仍自由 Markdown，来源留审核账本 | 非快照 ID / 非连续子串拒绝；助手建议不能成为已确认事实的唯一依据 |
| 团队确认与建议区分：`MemoryCore/src/core/prompts/l1-extraction.ts:162` | prompt 仅泛称用户偏好/结论，证据无类别 | 调：用户明确事实、已确认决定、助手建议分开显示和提示；建议只作上下文，未确认不能写成已决定 | user_fact 引用 user；confirmed_decision 包含用户明确确认的证据；纯助手建议不产生可采纳正文 |
| L3 常驻 + L2 按需 + L1 Bash curl：Proxy injectors | 官方 auto-memory + personal UserPromptSubmit 已有 | 复用官方常驻索引/按需读文件；不迁透明改请求、Bash curl 说明和代理通道 | 不改 runner 注入路径，无新增请求拦截/自动 HTTP 工具 |
| 自动轮次/idle 提取与层级调度：`MemoryCore/src/config.ts:662,681` | SDK 原生自动记忆；回顾显式用户触发 | 不迁平台定时提取：没有额外付费后台管线的真实缺口；保留原生行为 | 发起一次回顾只有一次受限 query，无后台额外模型任务 |
| 混合 FTS/向量/RRF：`MemoryCore/src/core/tools/l1-candidate-recall.ts:62,154` | 文件按需读取，没有独立检索库 | 不迁：本任务目标是整理与可发现，不是证实检索质量问题 | 无 embedding、向量服务、新索引或检索调参 |
| Scope/ACL、跨 Agent 借用 | 现有 businessId/RBAC、主子目录分离 | 复用，不照搬 team+agent 共享默认值、不跨专家借用私有来源 | 原权限、父运行占用检查、私有会话归属测试保持 |
| 删除、TTL、feedback/heat | 手工删除、版本/回滚已有；腾讯未证实反馈学习 | 不迁 TTL、认知遗忘、自动重排、反馈训练；heat 不是检索命中 | 删除仍显式操作；无自动删内容/推断性画像升级 |
| 工具过程转 Skill | 官方 skill 编辑/生成属于已有独立能力 | 不迁：不把本次记忆回顾扩大为技能生成系统 | 本次不修改 skills 格式、触发器或版本模型 |
| MemoryKnowledge wiki / code graph | Agentport 知识库独立 | 不迁：文档/代码资产不是对话记忆 | 不修改 knowledge API、索引、前端或数据 |
| SQLite/TCVDB/Mongo/COS、多服务 | PostgreSQL、Redis、官方工作区已足够 | 不迁：现有库与文件满足，没有新增依赖理由 | 无新服务、容器、依赖、账号或部署步骤 |
| 判重失败全部新增、update/merge 先删后写 | 已有失败终态、原子 rename、日志恢复 | 不迁这些失败语义，保留并扩展现有防丢失路径 | 模型失败零文件变更；双文件失败恢复不留假成功 |

上述“新增/归并/确认”是模型行为要求，不可声称仅凭 schema 能证明语义正确。自动化使用可控 SDK fixture 验证管线和约束；真实模型质量未测时如实报告。

## 3. 共享类型与不变量

### 3.1 文件名及目标

将现有文件名白名单移至 shared，作为唯一导出的 `memoryFileNameSchema` / `memoryFileNamePattern`；保留现有规则 `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.md$`，不改目录能力或引入别名。API 参数、回顾目标、journal、web 表单复用同一规则；底层文件系统函数继续保留自身信任边界验证，不复制另一套规则。

`MemoryReviewTarget` 的 `agent_memory` 直接改成必填：

```ts
{ kind: 'agent_memory'; agentId: string; name: string }
```

personal / agent_rule 不变。`name` 不设 MEMORY.md 默认值，不加旧 JSON 兼容分支；现存旧格式记录不迁移，不为它们保留二套语义，也不自动清用户库。

一次目标始终是一个文件。锁保持“同专家一把锁”，不细分到文件：索引是共享资源，现有 run 准入、父子占用和手工写入必须继续使用同一 key。

### 3.2 伴随索引快照

`MemoryContentSnapshot` 在原 `content/globs` 上增加必填字段：

```ts
index: { content: string | null } | null
```

- personal、agent_rule、`agent_memory/MEMORY.md`：`index: null`。
- 任意其它 agent_memory 文件：`content` 是目标正文（不存在为 null），`index.content` 是同专家 `MEMORY.md` 原文（不存在为 null）。
- `MemoryReview.before`、`memory_changes.before/after` 使用同一结构；index 没有独立 ID、版本号或新权威。
- 不扩展为任意 files 数组，不提供多文件任意写入计划。最多“目标主题 + MEMORY.md”两个固定文件。
- 伴随索引的 after 由 shared 的确定函数计算，API、worker 的有效变化判断与 web 对比共用它；这是真实复用点，避免三端各补一种链接。

### 3.3 索引发现规则

当主题最终正文非 null 且缺少指向该主题的 Markdown 行内链接时，在原索引末尾补一行 `- [<name>](<name>)`；无索引时从空串开始。识别普通相对目标 `<name>` 与 `./<name>`（可带 Markdown title），只需针对已有合法平面文件名识别，不造完整 Markdown 解析器。命中已有链接时索引逐字不变；其余索引字节、链接和结构不改。没有链接但有同名纯文本仍补真正的链接。

该行为覆盖回顾采纳和手工创建/保存主题，修复“文件已有却无入口”的实际缺口。模型无需输出 proposedIndex，不允许顺便整理其它主题。计算后的索引必须不超过 200 行 / 25 * 1024 UTF-8 字节；超限整次写入拒绝，不截断、不只写主题。主题仍沿用 200000 UTF-8 字节限额。

删除主题沿用显式删除操作，不扫描/重写用户自定义索引链接；UI 不声称自动修复所有手工链接。回滚一次包含索引的创建则按完整 before 快照撤销索引和正文，不留本次新增链接。既有任意 Markdown 链接重构、重命名文件和修全历史悬空链接均不属于本次范围。

### 3.4 提案、来源与 no-change

保留提案 `summary / proposedContent / evidence`，不新增“腾讯原子记忆”持久格式。`proposedContent` 仍是用户选择目标正文的完整替换；null 表示没有值得写入的内容，不表示删除。

`MemoryReviewEvidence` 在 `messageId/quote` 上增加必填 `kind`：`user_fact | confirmed_decision | assistant_suggestion`。此字段仅供审核归因，不进入官方文件格式。

- worker 保留 role，引用必须在固定来源窗口、quote 为消息原文连续子串。
- `user_fact` 必须来自 user。`confirmed_decision` 必须来自 user 的确认；助手描述方案可另附 assistant_suggestion，不能独自证明已确认。
- `assistant_suggestion` 必须来自 assistant，只作背景。非 null 正文至少有一条 user_fact 或 confirmed_decision；纯助手建议的非 null 结果视为非法提案失败，不能默默变成用户事实。
- prompt 明确要求确认必须有明确表达，不因一次采纳操作反向宣称原会话已有团队共识；个人偏好只收本人明确偏好，专家经验可收已确认的项目事实/方法，长期强约束进用户主动选择的 rule。
- 不做关键词分类器或额外 LLM 评委来“证明”自然语言确认；测试固定角色校验与提示约束，真实语义由用户查看原文后判断。

统一导出有效变化判断：`proposedContent === null` 或按上述规则算出的完整 after 与 before 完全一致，均为无变化。包括内容相同但仍需补主题索引链接时，属于有变化，UI 必须显示补链。

无变化保持 run `succeeded`、DB decision `pending`（表示没有用户决定），UI 显示“无需变更”，不显示“待采用”/采用/拒绝/回滚；可以查看理由、来源、重新生成。API apply 返回 409 CONFLICT，零文件、零账本变更。不加 decision 枚举、状态列或伪造 applied 记录。

## 4. worker 执行契约

文件 `packages/worker/src/memory-review.ts` 与对应测试：

- 按 `target.name` 显示真实文件名；MEMORY.md prompt 保持短索引要求，主题 prompt 要求保留原正文、独立可读、合并重复，允许新主题；删除现有“不要创建新文件”禁令。
- 同次 query 提供目标 before，主题时附原 MEMORY.md 用作组织背景；其它主题正文不全量加载、不扫描全仓、不给工具写权限。
- 资料同时保留 conversationId、messageId、role，传给模型便于归因。输出仍只写 review proposal，不写目标文件。
- 保留 `settings: { autoMemoryEnabled: false }`、`settingSources: []`、tools 空、MCP 空、persistSession false、独立临时 cwd、预算/超时/取消/清理。不能把 settingSources 空当成禁用 auto memory 的证据。
- worker 在外部结构化结果入口校验 schema、证据角色/子串和最终大小；API apply 对持久化提案信任边界复核。错误为 failed，保留既有脱敏错误和花费，不以全部新增/空成功兜底。
- 无新游标、调度器、后台合并任务。没有游标就不存在“失败推进 checkpoint”的新状态。

## 5. API、文件写入、账本与恢复

### 5.1 创建回顾及预算

沿用 `POST /api/memory-reviews` 及幂等请求 hash；name 参与 hash。创建时读取所选文件和索引，快照固定于创建；来源仍锁定首尾消息，专家目标只接受该专家的私有可读会话。

256 KiB 快照限额覆盖来源正文 + 目标正文 + 伴随索引，不重复计 MEMORY.md；超限返回 413 PAYLOAD_TOO_LARGE，入队/调用前拒绝。不偷偷截断来源或正文。

### 5.2 所有文件写入口统一

`readMemoryTarget / writeProjection / writeMemoryTargetLocked` 改为使用 target.name，所有主题 PUT/DELETE 都走同一账本路径，删除 routes.ts 中主题绕开账本的分支。`recordManualSameContent` 的最近版本查询必须按 kind + agentId + name，不能拿别的主题的 after 比较。

手工主题 PUT 的 index after 使用同一补链函数；主题 DELETE 保持当前 index 内容，账本记录 index before/after 相同。`MEMORY.md` 手工 PUT 也执行 200 行 / 25KB 限额，避免只有回顾采纳限制、手工保存却可越界的冲突。底层 200000 字节校验保留，先超过文件总限额仍按 413；索引更严格约束按 400 INVALID_INPUT。读取/下载不截断已存在的大文件，读取仍遵守底层 200000 字节上限。

### 5.3 一次逻辑变更

复用专家级会话锁、`assertNoActiveRun`、原子临时文件 rename、账本事务与 journal。以下是防数据丢失的实际需求，不是新增理论防护：主题和索引从一个文件变成两个文件，第二个写入或 DB 提交确实可能失败。

- 持锁后检查 target 和伴随 index 的当前快照均等于 before；任一变化返回 409，完整提案保留，提示重新生成。不重算成用户没看过的新索引后直接提交。
- 文件前先校验全部候选、捕获原始字节；先写主题，再写需要变化的 MEMORY.md；每个文件仍用现有安全路径及 rename，绝不删旧再写。
- 一个 memory_changes 行包含 target 与 index 快照，一个 review.appliedChangeId 指向它。账本与 decision 同事务提交，重复 apply 返回同一 change，绝不拆两条互相独立的采用。
- 任一写入/提交失败，恢复所有已改文件的原始字节；原来不存在的文件删除。恢复失败保留 journal，报告失败而非“已采用”。
- journal 从单文件 hash 扩为本次实际涉及的固定文件集合，记录每个文件 name、before/after hash（null 区分不存在），以及恢复所需原始字节。继续位于已有 `.memory-journal` 控制目录，不导出、不供 SDK 读取、不作为记忆权威。
- journal 的大小限额按目标 200000 字节 + 索引 25KB 的原始字节及所选编码实际调整，不能继续用 64KB 让合法主题失败；不在 journal 放会话原文。
- 恢复只认日志的显式证据：全部等于 before 则可安全重试；全部等于 after 且对应 pending 采纳/回滚可完成记账；before/after 混合则先恢复日志记载的原字节再重试。任一文件既非 before 又非 after 返回冲突，不能覆盖外部编辑。
- 日志标明 review / rollback / manual 及稳定操作身份；回滚与手工两文件写入也需要相同防丢失处理。提交后清日志失败不推翻成功，重试以账本已有 ID 收敛；沿用已有 `findByReverses`，不增加 prepared 状态或新表。
- 扫描 journal 时严格区分其它目标记录与损坏记录；同专家的未完成两文件变更会占索引，禁止被其它手工编辑/拒绝/回滚绕过。

实现可以在现有模块内缩减重复分支，但不得顺便重构 personal、规则或运行准入。若发现上述固定双文件语义无法用现有 journal 小范围扩展实现，交 Opus 收敛实现，不擅自退成两次独立采纳。

### 5.4 版本与回滚

- `GET /api/agents/:id/memory/:name/versions` 对所有合法文件返回实际历史，DB 在 LIMIT/分页前按 target.name 过滤；MEMORY.md 列表还应包含“以主题为 target、实际改动伴随 index”的变更，使用户能解释索引版本来源。
- 对主题筛选为 target.name 精确命中；对 MEMORY.md 为自身 target 或前后 index 内容实际不同。当前个人版本过滤修复不被覆盖。
- `POST /api/memory/changes/:id/rollback` 继续返回一个 MemoryChange；同时核对该次变更实际涉及的目标和 index after，再整体写回 before。某次仅改主题且 index 前后相同，不应因后续无关索引变动阻止主题回滚；此时只检查和恢复实际有变化的文件。
- 新主题创建回滚移除主题，并还原本次修改的索引（原索引不存在则恢复不存在）；其它内容随后已改则冲突，不抹掉后来修改。回滚本身记一条反向变更，可由现有来源 ID 识别已回滚。
- 版本归属继续遵守现有操作者 businessId 及目标权限，不能因主题化把专家账本混入个人版本。

### 5.5 HTTP 与错误

不新增错误体系，保留 `{ code, message, requestId, path? }`：

| 场景 | 状态 / code | 用户可见结果 |
|---|---|---|
| 文件名/目标/索引行数或25KB不合法 | 400 INVALID_INPUT | 指向字段或说明索引应精简，原提案/输入保留 |
| 快照 >256KiB 或主题 >200000 字节 | 413 PAYLOAD_TOO_LARGE | 不入队或整次不写，说明对应限额 |
| 来源/目标不存在 | 既有 404 code | 不泄露其它用户对象或宿主路径 |
| 无权限 | 既有权限 403/隐藏404策略 | 不产生模型任务/文件或泄露来源 |
| 运行占用、快照变化、无变化采用、拒绝后采用 | 409 CONFLICT | 保留提案，按原因等待或重新生成 |
| 入队失败 | 503 SERVICE_UNAVAILABLE | run 失败，不伪装已排队 |
| 模型输出/来源归因非法 | run failed + 既有脱敏 error | 零目标写入，可重新生成 |
| 文件/DB写入错误 | 既有 500 INTERNAL_ERROR | 尝试恢复；未成功不落 applied；无宿主路径泄露 |

Fastify 入口采用 typed + schema，handler 不新增 safeParse；持久化提案/日志是独立信任边界可校验。原 requireAuth/RBAC 与审计保持。

## 6. web 与用户完整路径

`components/memory-review.tsx`：

- 专家记忆目标增加“记忆文件”选择：MEMORY.md、现有主题、“新主题…”；新主题输入复用 shared 文件名校验，补 `.md` 的现有交互可保留。切换专家清空不再有效的文件名和来源，重新生成保留原目标 name。
- 候选不存在可创建；已有文件选择读取真实 before。创建新主题无需先写空文件，用户不采纳不留空主题。
- 列表和详情显示专家与文件名；用户看得到整篇正文 before/after 和索引 before/after（只有实际补链时展示第二组）；复用现有 CodeBlock 内容对比，不引入 diff 库。
- 证据展示归因“用户事实 / 已确认决定 / 助手建议”，按 messageId+kind+quote 区分 key；来源会话使用已有 `/chat?conversation=<id>` 打开。只承诺跳会话，不假造现有路由不支持的精确消息锚点。
- 无变化使用 §3.4 同一判断，显示无需变更；失败/取消不显示成功采用状态；冲突保留完整提案和来源，重新生成保留 name。
- 保留 focus 返回、键盘操作、pending 禁止关闭/离开、脏表单确认及幂等键复用。按 DESIGN-SYSTEM §10 分组，不加解释结构的标语。

`pages/memory-panel.tsx`：

- 复用当前文件列表、SourceEditor 与 canWrite；所选主题保存进统一账本；增加所选文件版本列表/查看/回滚，复用当前 memoryVersionsQuery 和回滚 mutation，不另写回滚 API。
- 保存/删除文案与实际新版本能力一致，不再笼统声称“不可撤销”；canWrite=false 不显示初始化/新建/保存/删除/回滚写动作。
- 回顾入口至少保留专家筛选；回顾创建表单本身能选文件即可，不强制为预选 name 改全局路由。如果实现预选则同步 search schema 和 dirty 防护，不用隐藏全局状态。
- 采纳/回滚/保存后失效 `agent-memory`、`agent-memory-file`、`memory-versions`、`memory-reviews`；当前失效缺少 agent-memory-file，必须补齐，否则编辑器仍显示旧正文。索引与主题两个文件缓存都要刷新。
- 请求失败保留草稿；刷新发生时不能无提示覆盖未保存草稿。

## 7. 可移植与导出边界

已读 `features/export/routes.ts` 和 `features/agent-package.ts:364-575`：专家包当前渲染 DB 定义、规则、技能和子定义，**没有读取运行时 agent-memory 目录**。路由“包含记忆”的注释与代码冲突，不得以它宣称记忆已可导出。

本次最小完整交付采用独立原生记忆目录下载，不扩大为专家定义包重构：

- 增加 `GET /api/agents/:id/memory/download`，在 `:name` 动态路由前登记；复用 `agents.memory.read` 对象权限，响应 ZIP、no-store、nosniff、`<slug>-memory.zip`。
- ZIP 根只有实际 `MEMORY.md` 和主题 `.md` 文件，不含 agent ID JSON、版本账本、review 原文、journal、个人偏好、其它专家或子级目录。解压到任意官方 auto-memoryDirectory 即可使用；子智能体导出的自己这份目录同样可放入其 `.claude/agent-memory/<slug>/`。
- 使用已安装 fflate 和现有 ZIP 打包/安全上限能力。最多沿用 AGENT_PACKAGE_MAX_ENTRIES 与 AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES，压缩与正文 UTF-8 实际字节均校验；无内容返回明确 NOT_FOUND，不伪造 MEMORY.md。普通文件/符号链接拒绝与现有读取一致。
- 持有同专家锁读取，避免下载到平台双文件采纳中间态；不声称能与运行中原生 SDK 的直接写入形成跨进程快照一致性，不新增停机/快照服务。
- 记忆面板提供下载按钮；不新增 ZIP 上传 UI 或整目录覆盖 API。已有 `PUT /memory/:name` 就是回导能力，自动化验收必须把真实下载 ZIP 解开后，用该公开接口逐个写入一位新专家，核对索引、所有主题正文及再次下载结果。相对链接不依赖原 agentId/slug。
- `POST /api/import/agents`、专家包 sidecar/version 不变；明确专家定义包与这份原生记忆目录是两个已有/新增交付物，不把运行历史塞到定义里。修正错误注释及权威文档，避免重复能力声明。

## 8. 数据库、导出类型及调用方清单

不新增表、列、索引、枚举或 SQL migration；`memory_reviews.target/before/proposal`、`memory_changes.target/before/after` 已为 jsonb，可承载 name、index、证据 kind。TypeScript 类型直接升级，不做旧记录兼容、数据迁移或清库。`pnpm db:generate/db:migrate` 本次不需要；若执行中改变了物理 schema，必须先交 Opus 说明必要性，并按项目规范 generate+migrate，不能悄悄加列。

`packages/shared/src/index.ts` 若已 `export * from './memory.js'` 则复用，不新增无引用导出。所有 MemoryReviewTarget / MemoryContentSnapshot / MemoryReviewEvidence 构造点与测试 fixture 必须一起更新，包括 personal/rule 的 `index:null`，不能只编译新主题路径。

| 边界 | 必改 / 核对路径 | 责任与验收 |
|---|---|---|
| 共享契约 | `packages/shared/src/memory.ts`、`index.ts`、相应 shared 测试 | name/index/kind、补链/有效变化公共规则，单一 schema |
| worker | `packages/worker/src/memory-review.ts`、`test/memory-review.test.ts` | 主题 prompt、来源归因、只读隔离、失败/取消/超时 |
| API 采纳/账本 | `packages/api/src/features/memory-reviews/routes.ts`、`features/memory/changes.ts`、`features/memory/journal.ts`、`test/memory-reviews.test.ts`、`test/memory-changes.test.ts` | 目标快照、整体采纳、恢复、版本筛选/回滚 |
| 文件 CRUD/下载 | `packages/api/src/features/agents/routes.ts`、`memory-files.ts`、`test/memory-routes.test.ts`、`test/memory-files.test.ts` | 主题全部入账、索引限额、下载/公开PUT回导 |
| DB 仓储 | `packages/db/src/repo/memory-changes.ts`、`memory-reviews.ts`、`schema.ts`（仅类型核对） | name/伴随index过滤和 LIMIT 前收窄；不变物理schema |
| web 接口/cache | `packages/web/src/lib/api.ts`、`lib/queries.ts` | agentMemoryVersions(id,name,signal)、下载 URL、完整缓存失效 |
| web 界面 | `packages/web/src/components/memory-review.tsx`、`pages/memory-panel.tsx`、`test/memory-review-page.test.ts`、`test/memory-editor.test.ts`、`test/personal-memory-page.test.ts` | 选择、对比、归因、无变化、版本回滚、下载、草稿/focus |
| 文档同步 | `docs/ARCHITECTURE.md`、`docs/OPERATIONS.md`、`docs/DECISIONS-PENDING.md` D-61、`docs/PITFALLS.md`、任务记录 | 主题账本、下载范围、官方约束和本轮真实证据；不重写旧任务研究史 |
| 运行时不变边界 | `packages/sandbox/src/runner.ts`、`packages/core/src/workspace.ts`、`packages/db/src/repo/locks.ts` | 只核对既有挂载/权限/锁，无新增注入或锁种类；除发现真实调用断裂不改 |
| 专家包边界 | `packages/api/src/features/export/routes.ts` 错误注释，`agent-package.ts` 只核对 | 不改包格式、不假称包里已有运行记忆 |

注意独占：`memory-changes.ts` DB repo、`api/src/features/memory/personal.ts`、`api/test/personal-memory.test.ts`、`api/test/delegation-memory-lock.test.ts` 已分给纠错 Sonnet。任何代理不得同时写；本能力所需 DB repo 增量等其完成后由同一写入者或明确交接处理，保留 personal kind 过滤和共享锁修复。

## 9. 并行单元与真实依赖

1. 先由一个 Sonnet 完成 shared 契约与行为测试；这是所有新字段的真实依赖。同期原独占 Sonnet 完成 personal 纠错；其它执行者可以读代码准备，不猜未定字段。
2. shared 完成并构建当前 workspace dist 后，同时派三个 Sonnet：A 独占 worker 文件/测试；B 独占上述 API 文件、API 相关测试和 DB 仓储；C 独占 web api/query/组件/页面及 web 测试。B 内部的 CRUD、journal、采纳与版本共享文件/状态，保持单一写入者，不为并行拆坏原子性。DB repo 交接前 B 不编辑它。
3. 下载放 B，web 下载入口放 C，接口已由本契约固定，无需彼此等待实现；不另派同时改 agents/routes.ts 的第四人。
4. 文档同步可由独立 Sonnet 在共享契约稳定后并行，限定上述 docs；它不得改其它代理的研究报告和源文件。主会话根据返回证据更新任务交付状态。
5. A/B/C 完成后主会话构建并运行整合验收；Opus 基于固定 diff、契约和文件清单独立 review。发现问题交原写入者改，review 复核修复及新增变更；不由主线程亲写代码。

本契约撰写代理只写本文，没有授权覆盖任何上述源码或其它文档。

## 10. 行为验收与可执行命令

先红后绿，不能仅检查 prompt 字符串就声称模型能正确记忆。至少留下以下真实行为测试：

| 层 | 必须证明的行为 |
|---|---|
| shared | 文件名穿越/隐藏/非md拒绝；原索引逐字保留；普通/./已有链接不重复；缺索引补链；多字节大小；正文相同但补链仍算变化；完全相同/null 为无变化 |
| worker | 已有主题保留内容的 fixture 成功；新主题 fixture；两来源重复归并 fixture；无变化；user_fact 角色错、confirmed_decision 纯助手、未知ID、非连续引用均失败；autoMemory false/tools空；取消/超时/失败不写文件 |
| API 创建 | name 进入幂等 hash；新主题前不存在；来源+主题+索引256KiB合计；无权限和跨专家来源拒绝且不入队 |
| API 采纳 | 创建新主题同时加索引；已有主题正文/索引保留；缺索引初始化；所有限制在首个文件写前拒绝；任一快照变化409、提案保留；重复apply同ID；无变化apply零版本 |
| 一致性 | 注入第二文件失败、DB提交失败、恢复失败；日志before/after混合重试；全部after补账只一次；外部编辑冲突不覆盖；残留日志下手工编辑/拒绝/回滚不绕过；父/子运行占用；不能只测happy path |
| 版本 | 主题A/B、MEMORY、规则、个人混合写入后分页前精确过滤；MEMORY能看见实际伴随索引变更；同正文手工保存不重复记账；回滚新主题含索引、回滚普通更新、后续修改冲突、无关索引变动不阻断单主题回滚 |
| 下载/回导 | 用户有权限才可下载；真实ZIP仅记忆md、无journal/个人来源；大小/符号链接边界；解包经现有PUT导入新专家，正文和相对链接核对，再次下载一致 |
| web | 选择已有/新主题与重新生成name；前后对比包含索引；归因标签/会话链接；无需变更无采用按钮；采纳/回滚后主题及索引缓存更新；主题版本回滚；无权限写操作隐藏；失败草稿、dirty/pending/focus保护 |
| 既有回归 | personal版本过滤修复不退回；personal和rule回顾/采用/回滚仍可用；memory编辑、权限及路径边界保持 |

从本工作树执行，先确认测试基础设施可用；backend 使用随机数据库与独享 Redis，不迁开发库、不停开发 worker。个人偏好测试保持同一 MEMORY_TEST_LOCK，会话级锁，不以串行唯一通过掩盖漏锁。JSON 报告显式指定本任务唯一文件名，避免并行覆盖默认 `.vitest/json/output.json`。

```sh
pnpm --filter @agentport/shared --filter @agentport/core --filter @agentport/db build
pnpm exec vitest run --project backend packages/shared/test/memory.test.ts packages/worker/test/memory-review.test.ts packages/api/test/memory-reviews.test.ts packages/api/test/memory-changes.test.ts packages/api/test/memory-routes.test.ts packages/api/test/memory-files.test.ts packages/api/test/personal-memory.test.ts packages/api/test/delegation-memory-lock.test.ts --reporter=default --reporter=json --outputFile=.vitest/memory-upgrade-backend.json
pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/memory-review-page.test.ts packages/web/test/memory-editor.test.ts packages/web/test/personal-memory-page.test.ts --reporter=default --reporter=json --outputFile=.vitest/memory-upgrade-web.json
pnpm typecheck
pnpm --filter @agentport/web build
pnpm lint:focus
```

`packages/shared/test/memory.test.ts` 是本契约指定的新增行为测试位置；如现有目录另有等价测试，优先补现有文件并同步命令。下载/回导可放既有 memory-changes 或 memory-reviews 集成测试，不为命令好看新增空测试文件。若实现确实改到 SDK 运行时/挂载，需追加对应真实容器+fake API 套件，当前契约没有要求改该层，不固定重跑无关全仓集成。

页面用实际 app 做一次“新主题回顾→查看来源和双文件对比→采用→面板确认→版本回滚→下载”操作。采用受控测试提案可以验证交互和写入，不冒充付费真实模型质量测评；使用 e2e/ego-browser，不新增 Playwright。若环境阻碍实际页面验证，记录具体阻碍与单测覆盖，不能写浏览器通过。

## 11. 官方核对及文档冲突清单

本轮已直接核对 [官方 memory](https://code.claude.com/docs/en/memory) 与本地 `packages/worker/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:9500`，安装包 `0.3.311`；不据此推断运行镜像版本。

- 官方：MEMORY.md 启动只读前 200 行或 25KB，以先到者为准，主题文件按需标准文件工具读取。平台采用拒绝超限而非静默截断；不把所有主题塞进每轮 prompt。
- `autoMemoryEnabled:false` 本地类型明确关闭自动读写；现有隔离 worker 已正确设置，应保留，不能错误“修复”成只保留 settingSources 空。
- 官方现允许 `autoMemoryDirectory` 来自 project/local，但受 workspace trust 条件控制；启用 `permissions.blockReadsOutsideWorkingDirectories` 时，不加载/写入 repository-supplied settings 选择的目录。路径仍须绝对或 `~/`。本地 sdk.d.ts 注释“projectSettings ignored”及 D-61 绝对禁止描述过期；不修改 node_modules，通过权威文档记录差异。现有 inline settings 不受此漂移影响，不趁机迁配置来源。
- `docs/ARCHITECTURE.md` 的“只有 MEMORY.md 入账”和 `changes.ts` 的“其它文件没有版本”在本次实现后必须改为本契约实际行为。
- `docs/tasks/memory-upgrade-research.md` 现状表“平台写入口与审核均校验索引”不完全准确：当前手工 MEMORY.md PUT 只有通用 200000 字节限额，严格200行/25KB只在review apply；本契约明确补齐，不能把旧研究当通过证据。
- `features/export/routes.ts` 声称专家包包含记忆，与实际 buildAgentPackage 无运行时目录读取冲突。本次独立记忆下载修复能力缺口，同时修正声明；专家包格式不变。
- `docs/OPERATIONS.md:100` 旧称子智能体文件访问全拒绝，与现已接通自身 project memory 不符；同步成主/子各自目录边界，保留未测真实模型的限制说明。
- 本文不把腾讯 heat 当检索命中，不把“L0完整上下文”宣称当实际保证，不迁失败回退全部新增或先删后写。

## 12. 完成判据

能力矩阵每项有明确选择；shared/worker/API/web 全部使用同一 name/index/kind 及有效变化口径；主题及索引没有半采纳/半回滚；原始来源可核对、助手建议不冒充确认；下载产物经公开PUT真实导回并核对正文；适用测试、typecheck、build 有真实输出，失败/跳过/未做模型质量测评明确记录；Opus 独立评审通过；任务记录更新为实际交付状态。用户已授权提交；随本任务 PR 交付，合并状态以 GitHub 为准。
