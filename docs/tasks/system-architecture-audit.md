# 系统架构审计汇总（证据候选）

> 日期：2026-10-31。基线：`68241bab58ad8ec59727d70677bec790af2a5ae2`。
> 范围：职责边界、API 契约、数据访问、异步任务、流式通信、SDK 文件系统。
> 本文汇总事实证据、候选与各 Opus 合同的裁决映射；裁决正文以合同为准，本文不替代合同，也不宣称实现或 review 完成。前端/API 的冻结方案与执行边界见 [架构契约](system-architecture-modernization-contract.md)；后端数据裁决见 [数据契约](system-architecture-data-contract.md)；AI 运行裁决见 [运行合同](system-architecture-runtime-contract.md)。

## 1. 状态定义与边界

- 三域事实审计均已返回：前端/API、后端数据与异步任务、AI 运行边界。
- 前端/API 4 项候选已被 Opus 接受并冻结为契约；A 已按契约实现并通过独立 Opus 终审（119/119、0 skipped）。B/C 最终通过独立 Opus 定向复审：14 files / 263 tests、0 skipped，原 probe 与新增 probe 7/7；完整 web 132 files / 1600 tests、0 skipped。原 C 阻断（旧 SSE、晚到发送、换 B/logout 后 generation 作废回写）已解除；浏览器隔离验收通过。JSON `testResults` 是文件数，不是 suite 数。
- 后端 3 项、AI 7 项均已由 Opus 逐项裁决：接受项进入实施。knowledge 初始后端 199/199 + web 129/129，补 9 场景 / 7 新增后 14 files / 206/206、0 skipped，独立 Opus PASS（`/tmp/agentport-architecture-knowledge-gapfix-review.json`），生产逻辑无确认错误。eval 历史阶段核心 9 files / 61、修复后 10 files / 64 与 index 日志 3 files / 40 均通过；最终 case output 修复后独立 Opus PASS（14 files / 112/112、0 failed、0 skipped，`/tmp/agentport-architecture-eval-outputfix-review.json`）。runtime A 的 R2 修复后定向 Opus PASS（115/115、core 63 + ZIP 52、0 skipped），R1/R4/UI 先前 PASS 保留，全线阻断解除。runtime B 旧证据 174/174 与 Docker 3/3 属旧事务回调实现，不能最终认可；删除编排已按 [runtimeB revision](system-architecture-runtimeB-revision.md) 实现为同一连接持 session advisory lock → 短 tx A → 事务外 ACK → 同连接短 tx B，agent 与 conversation 都回收四类目录并保留记忆。原三项终审发现已独立 PASS：分支补偿 22/22；真实 TCP 控制查询 5s、持锁 40s 从拿锁后覆盖设置恢复（locks 14/14、矩阵 127/127）；Docker 新编排 3/3。终复审剩余仅测试边界（跨库同 key 的 PID 选择红 1、异步锁释放等待），修后 4 files / 41 tests / 0 failed / 0 skipped；最终 Opus 窄复核运行中，未返回前不记 PASS。联合首轮 4374 total / 4338 pass / 19 fail / 17 skip 已被第二轮 403 files / 4382 tests / 4381 pass / 1 fail / 0 skip 取代；唯一失败为 MCP 取消观测竞态，修复后独立 3/3、相关 52 项 PASS。all3 完整联合运行中，结果待填写。裁决正文见数据契约 §1 与运行合同「结论」，下表只镜像状态。
- 总体架构保留模块化单体 + API/worker 进程 + 官方 SDK 沙盒；不追热换框架，不新增独立服务或第二执行循环。
- 本文不做全量代码审计；引用位置用于复现，可按需 `rg` 核对，不重复原长报告。A、B/C、eval、runtime A 与 knowledge 已通过独立终审/定向复审；runtime B 删除编排已实现，分支、截止/Docker 与测试边界修复均有独立证据；最终窄复核与 all3 完整联合尚未返回，当前没有整任务实现完成或 review 通过的结论。

## 2. 前端/API（已接受，契约冻结）

| ID | 现状 | 具体失败 | 已有能力 | 裁决状态 | 引用 |
|---|---|---|---|---|---|
| F1 | 会话详情/搜索/列表/改名/分支未接 response schema，详情与分支直接返回整行；shared 已有公开 schema | `sdkSessionId`、`forkFromSdkMessageUuid` 等内部续聊状态随 JSON 暴露；`senderBusinessId` 未声明且无 UI 消费 | Fastify + Zod serializer 可剔除未知顶层字段；repo 整行供授权/分支/worker 使用 | 已接受；A 已实现并独立 Opus PASS（119/119、0 skipped） | 契约 §2 F1-F4、§3；`packages/api/src/features/chat/routes.ts:655,676,729,987`；`packages/db/src/repo/chat.ts:121` |
| F2 | 健康 SSE 期间 RunReconciliation 仍无条件 `useRun`，每 2 秒拉完整 `RunDetail` 全 steps | 同一次运行、相同窗口内重复获取完整详情；服务端已每 2 秒补终态，健康连接下没有必要 | 服务端终态补偿、断线回放、canonical 恢复、取消 invalidate 均已存在 | 已接受；B/C 最终独立 Opus PASS（6 秒轮询 4→1、断线/取消 fallback；14 files / 263/263、probe 7/7、完整 web 1600/1600），浏览器隔离验收通过 | 契约 §2 F5-F7、§4；`packages/web/src/pages/chat.tsx:2128`；`packages/web/src/lib/queries.ts:750`；`packages/api/src/features/chat/routes.ts:515-581` |
| F3 | 显式退出只清 Query；`chat-store.reset` 能清内存与 sessionStorage 但生产未调用；草稿无账户归属 | A 显式退出后 B 登录，B 可看到 A 新会话槽的未发送草稿；属于实际隐私边界 | 已有 `reset`、会话槽草稿读写和两个退出入口 | 已接受；C 最终独立 Opus PASS：`accountEpoch` 同步推进 generation 并关流，原三条 probe 与新增 4 条共 7/7 通过；浏览器隔离验收通过 | 契约 §2 F8-F9、§5；`packages/web/src/lib/queries.ts:110`；`packages/web/src/lib/chat-store.ts:168` |
| F4 | shared `schemas.ts` 与 web `api.ts` 重复定义 Run/Overview 响应 | web 漏 `trigger`/`errorKind`；`OverviewAgentRow.createdAt` 写成必有 string，shared 可 null；类型漂移 | shared schema 可由 `z.infer` 直接导出；`formatRelative` 已处理 null | 已接受；A 已实现并独立 Opus PASS（119/119、0 skipped） | 契约 §2 F10、§3；`packages/shared/src/schemas.ts:22-121`；`packages/web/src/lib/api.ts:253-358` |

## 3. 后端数据与异步任务（已裁决，见数据契约）

| ID | 现状 | 具体失败 | 已有能力 | 裁决状态 | 引用 |
|---|---|---|---|---|---|
| B1 | 知识来源 `syncCron` 只做 5 段非空正则，未做可调度性校验；worker scheduler 串行 `await upsertJobScheduler`，循环内无逐条错误隔离 | 形如 `99 99 99 99 99` 的 5 段值可通过入口；若 BullMQ 解析抛错，该轮 `sync()` 在首条非法值处中断，后续来源的 upsert/removal 都不执行，直到下轮再失败 | Ops 定时任务已用 BullMQ `getNextMillis` 的 `isSchedulableCron` 拒绝不可调度表达式；知识 scheduler 有定时重试与错误日志 | 已实施并独立 Opus PASS（knowledge 14 files / 206/206、0 skipped）：shared `cronSchema` + API BullMQ 解析、scheduler 逐来源隔离更新/移除 | `packages/api/src/features/knowledge/source-routes.ts:26-30`；`packages/worker/src/knowledge/scheduler.ts:155-192`；对照 `packages/api/src/features/ops/schedule-sync.ts:23-26` |
| B2 | 手动同步先插 sync run、再建 job、再入队，三步不在同一事务；跑完时 `finishSyncRun` 与 `updateSource`（游标/lastSyncStatus）也是两次独立写 | 中间失败会留下 queued/running 的 sync run 而没有对应 job；`reconcileKnowledgeJobs` 只扫 `knowledge_jobs`，没有 job 的 run 不会被收口；run 已成功但来源状态/游标未更新时，两侧短暂或长期不一致 | 定时触发路径已用事务 + `pg_advisory_xact_lock`，入队最终失败会把 job 与 run 收为 failed；手动路径有非事务活动任务检查；每轮 job 对账最终处理已存在的 job | 已实施并独立 Opus PASS：`createSyncJob` 三入口共用来源级 advisory lock + pair 事务；`finishJob` 同事务提交 job/run/source 与成功游标；旧非事务检查已删除 | `packages/api/src/features/knowledge/source-routes.ts:371-400`；`packages/worker/src/knowledge/scheduler.ts:55-115`；`packages/worker/src/knowledge/ingestion.ts:1127-1137`；`packages/worker/src/knowledge/reconcile.ts:58-67` |
| B3 | 评估跑批用 `claimEvalRun` 的 `claimedAt IS NULL` 防止重复投递；孤儿对账在 `createdAt` 超过 1 小时后才看队列 | worker 重启后 BullMQ 把 stalled job 重投，DB 行仍是 running 且 `claimedAt` 已非空，新投递 claim 失败直接跳过；对账要求 job 消失/终态，而重投中的 job 仍在队列，1 小时内 DB 一直显示 running | `claimEvalRun` 保证并发只跑一份；`finishEvalRun`/`cancelEvalRun` 只收口 running；reconcile 最终会处理真正丢失的 job | 拒绝自动续跑；接受失败生命周期收口并已实施：公开失败文案脱敏、processor/failed 事件条件置 failed、已认领批次不续跑、保留已落库结果；中间阶段 eval 范围 10 files / 64 与 index 日志 3 files / 40 通过；最终 case output 修复后独立 Opus PASS（14 files / 112/112、0 skipped） | `packages/worker/src/eval-runner.ts:151-160`；`packages/db/src/repo/eval.ts:130-136`；`packages/worker/src/reconcile.ts:16,100-123` |

## 4. AI 运行边界（已裁决，见运行合同）

| ID | 现状 | 具体失败 | 已有能力 | 裁决状态 | 引用 |
|---|---|---|---|---|---|
| A1 | 父 CLAUDE.md 用 `input.servers`（父 + 子并集）列出 MCP Server；父自身 `serverNames` 只在子/独立定义渲染时用于过滤 | 导出与运行时 `.mcp.json` 是并集，父 CLAUDE.md 可能公布只绑定给子智能体的 Server，让父会话误以为可直接使用 | `.mcp.json` 并集是子定义按名引用的必要结构；父可见范围另由渲染与 hook 限制；子定义按自身 `serverNames` 过滤 | 接受；根提示按根 `serverNames` 过滤，`.mcp.json` 保留根与启用子级并集；已实施，R1 独立 Opus 通过 | `packages/core/src/workspace.ts:262-285`；`packages/api/src/features/agent-package.ts:430-451`；`packages/worker/src/index.ts:784-791` |
| A2 | `parseClaudeMd` 以精确字符串 `\n## 工具使用\n` 作为系统提示与生成段的边界，取第一次出现位置 | 用户系统提示自身含普通 `## 工具使用` 标题时，导入会把该标题之后的内容截掉；导出→导入不保证 roundtrip，提示词被破坏 | 渲染器固定生成该段；CRLF/BOM 已归一；无该段时整篇当提示词 | 接受并扩到子文件解析；root/child 共用成对、末尾锚定的可逆生成区标记格式，保留用户同标题/同标记正文；已实施并修复 R2 边界，定向独立 Opus PASS（115/115、core 63 + ZIP 52、0 skipped），见 §4.1 | `packages/core/src/official-files.ts:10,15,26-29`；`packages/core/test/official-files.test.ts:127` |
| A3 | runner 不逐项核对 SDK init 返回的 `skills`/`agents` 列表与渲染文件是否等价 | 候选主张列表不完整时应 fail-closed；但官方只声明列表字段，未证明其等于各作用域完整可调用集合，也没有合法渲染文件未被加载的复现 | renderer/import 已校验文件；真实 CLI 发现测试覆盖现有加载路径 | 拒绝作为修复项：init 列表完整性拒绝，不加猜测式 fail-closed | `packages/worker/src/index.ts:251-255,271`；`packages/sandbox/test/{skill-discovery,sdk-skills}.test.ts` |
| A4 | 父 CLAUDE.md 的委派表与子定义正文按子智能体自己的 `timeoutMs` 声明超时；worker 实际只把父 `agent.timeoutMs` 传给 runner | 子智能体被描述为受自身超时约束，但运行时没有把子级 timeout 单独下发给 SDK/委派；声明可能不实 | 父级运行超时真实生效；子定义有 `maxTurns`；runner 对整次运行计时并超时 | 接受声明错误并修正文案；保留 `timeoutMs` 独立运行语义，拒绝删字段或自造委派计时器；已实施，R4 独立 Opus 通过 | `packages/core/src/workspace.ts:309-314,448-450`；`packages/worker/src/index.ts:732,920`；`packages/worker/src/runner-client.ts:732,804` |
| A5 | 用户配置的 stdio env / headers 长期凭据由 worker 解密后写入工作区 `.mcp.json`；Bash 在同一容器内可用 | 容器内 Bash 可读取 `.mcp.json`，第三方长期凭据进入智能体可读文件；generated/knowledge 是 run 短期 token，但用户自带连接器仍是长期凭据 | `.mcp.json` 以受限模式写入；模型密钥走代理短期 token；PreToolUse 只约束原生文件工具，文档已明确不声称 OS 隔离 | 接受实际信任边界；拒绝擅自全代理化，D-76 边界保持不变，不做统一代理。runtime B 删除编排已按 [revision](system-architecture-runtimeB-revision.md) 实现；分支 22/22、截止（locks 14/14、矩阵 127/127）与 Docker 新编排 3/3 独立 PASS；最终窄复核与 all3 未收口；旧 174/Docker 3 证据不采用 | `packages/worker/src/index.ts:151-167,249-260,773-785`；`packages/sandbox/src/runner.ts:268-280`；`docs/OPERATIONS.md:100` |
| A6 | 审计时删除专家清 `sdk-sessions`、`conversation-outputs`、`conversation-inputs`，不清 `session-sandboxes` | 会话行被级联删除后，各会话的 sandbox 目录仍留在专家工作区；删除单个会话会清自己的 sandbox，但专家级删除没有对应清扫 | 单会话删除已有 `session-sandboxes/<conversationId>` 清理；专家目录按 slug 可定位 | 接受并已实施：短 tx A → 事务外 ACK → 短 tx B、同连接 session lock 后删 DB 并回收 `session-sandboxes` 等四类目录，保留父子与个人记忆；分支 22/22、截止/Docker 新编排独立 PASS；测试边界修后 4 files / 41 tests；最终窄复核与 all3 未收口；旧 174/Docker 3 不代表修订通过 | `packages/api/src/features/agents/routes.ts:742-766`；`packages/api/src/features/chat/routes.ts:795`；`packages/worker/src/session-workspace.ts:27,46` |
| A7 | 候选称生成的 CLAUDE.md 提示 `Read` 打开 `.claude/skills/<slug>/references/` 相对路径，而 PreToolUse 与 allow 规则要求绝对路径 | 候选误读模板：路径常量已含 `/`，实际生成 `//mnt/...`、`//workspace/...` 绝对路径；未复现 hook 拒绝，不是「另造相对 Read 漏洞」 | hook 支持绝对路径并校验目录、扩展名、软/硬链接；runner 已生成 `Read(//workspace/.claude/skills/*/references/**)` 规则 | 撤回，不是修复项 | `packages/core/src/workspace.ts:332`；`packages/sandbox/src/memory-permissions.ts:130-136`；`packages/sandbox/src/runner.ts:271-275` |

### 4.1 R2 修复与定向复审（2026-10-31）

先前独立 Opus 终审的唯一阻断是 R2 边界：`uiFormat: 'openui'` 且工具描述为多行时，描述中的独占 `<!-- agentport:generated:start -->` 会被 `openuiSystemPrompt` 带进平台生成后缀；`parseClaudeMd` 取终端 `END` 前最后一个独占 `START`，把外层生成内容误当用户正文（回读 35997 字符并含 `## 任务清单`）。

- 修复：不改官方目录/字段/SDK 加载；根生成正文在最终生成后缀的统一入口逐行转义独占保留标记行（`<` 前加反斜杠），覆盖 `description`/`name`/`inputSchema`/`outputSchema` 及 server/skill/sub-agent 派生内容，保留多行与字面量；原先 `inlineText` 压平的部分不变。用户 `systemPrompt` 与外层 wrapper 不处理，解析规则不变。子级生成后缀只有 3 行固定文本、无外来值，不需要同一 helper。
- 复审：定向独立 Opus PASS。原始 `START` 输入正文严格逐字相等；独立探测根 192、子 12、转义 8 组通过；core 63 + ZIP 52 共 115/115、0 skipped，报告 `/tmp/agentport-architecture-runtimeA-r2fix-review.json`。
- 状态：R1/R4/UI 先前 PASS 保留，runtime A 全线阻断解除；R3 init fail-closed 与 R6 绝对路径候选继续拒绝。结论与记忆路径复核见 [runtime A 独立终审](system-architecture-runtimeA-review.md)。

## 5. 裁决结果与执行边界

- 前端/API 已冻结的 4 项不重新裁决；实施中发现与契约冲突时先改契约/记录再动代码。
- 后端与 AI 候选的裁决正文在数据契约与运行合同中：数据接受 cron 可调度校验、逐来源隔离、创建/终态原子性与三入口复用既有锁；拒绝评估自动续跑、把孤儿阈值改为 5 分钟及新扫全表/outbox/持久终态意图/心跳租约；`ops` scheduler Queue 的 `onClose` 与 retrieval 无引用导出延期，不夹带。运行接受 R1、R2、R4 声明修正与 R5 生命周期；拒绝 R3 init fail-closed、全代理化、删 `timeoutMs` 或自造委派计时器；R6 绝对路径候选撤回。
- 拒绝与延期项不排期、不因「审计列出来了」就修；接受项由分区按合同文件所有权实施：A、B/C、eval、runtime A 与 knowledge 已终审/定向复审通过；runtime B 删除编排已实现，分支、截止/Docker 与测试边界修复均有独立证据，最终窄复核与 all3 未完成；整任务当前未完成。
- 不新增服务、执行循环、多 worker、外部依赖或理论防护；不为候选引入新的抽象层。eval 与 runtime A 已释放 `worker/index.ts`、`api/chat/routes.ts`；runtime B 模块的接线与删除编排由单一写入者按 revision 完成，不并写；测试边界修复、最终窄复核与 all3 联合验证仍在同一所有权内收口。
- 候选确认需要改时，先定唯一写入者与测试边界；共享文件重新分区，不覆盖并行工作。实现完成后由独立 Opus high 按固定 diff、合同与真实验证终审；A、B/C、eval、runtime A 与 knowledge 已通过；runtime B 的最终窄复核与 all3 联合验证仍未收口。

## 6. 官方来源与本地核对入口

前端/API 的官方来源以契约 §8 为准，本文不重复其结论。后端/AI 的裁决已在数据契约与运行合同中引用下列官方条目与实际读取到的行为；本文保留入口，不重复合同结论，也未把未实际读取的页面内容当作结论。

| 主题 | 官方入口 |
|---|---|
| API 响应序列化 | [Fastify Validation and Serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/) |
| 周期轮询与禁用语义 | [TanStack Query useQuery](https://tanstack.com/query/latest/docs/framework/react/reference/useQuery)；[Disabling Queries](https://tanstack.com/query/latest/docs/framework/react/guides/disabling-queries) |
| 路由与文件生成 | [TanStack Router](https://tanstack.com/router/latest/docs/framework/react/overview) |
| BullMQ 定时任务 | [Job Schedulers](https://docs.bullmq.io/guide/job-schedulers) |
| BullMQ stalled/重投 | [Stalled Jobs](https://docs.bullmq.io/guide/jobs/stalled) |
| BullMQ 优雅停机 | [Gracefully Shutdown](https://docs.bullmq.io/guide/going-to-production#gracefully-shutdown) |
| Drizzle 事务 | [Transactions](https://orm.drizzle.team/docs/transactions) |
| Claude Agent SDK | [Agent SDK Overview](https://code.claude.com/docs/en/agent-sdk/overview) |

本地已安装 SDK 为 `0.3.311`（`packages/worker/package.json`、`packages/sandbox/package.json`、`pnpm-lock.yaml`）；类型核对位置 `packages/worker/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`。官方文档与本地类型不一致时以官方文档为准。

## 7. 证据边界

- 基线测试真实结果、命令与报告路径记录在 [任务记录](system-architecture-modernization.md)「验证」；本文不重复流水账。
- A 分区的红绿、相关回归与静态检查结果见 [A 证据](system-architecture-A-evidence.md)；A 独立 Opus 终审 PASS（119/119、0 skipped），报告 `/tmp/agentport-architecture-A-review.json`。这是 A 范围证据，不证明 B/C、数据或运行分区完成。
- B/C 最终证据：受影响范围 14 files / 263 tests、0 skipped（`/tmp/agentport-architecture-BC-identityfix-review.json`），原 probe 与新增 probe 7/7；完整 web 132 files / 1600 tests、0 skipped（`/tmp/agentport-architecture-BC-identityfix-green-web-full3.json`）。历史时点 131/1593 与 131/1594 不混算；JSON `testResults` 是文件数，不是 suite 数。B/C 均通过独立 Opus 定向复审，浏览器隔离验收通过。
- eval 证据：历史阶段核心 9 files / 61、修复后 10 files / 64 与 index 日志 3 files / 40 通过；最终 case output 修复后独立 Opus PASS（14 files / 112/112、0 failed、0 skipped，`/tmp/agentport-architecture-eval-outputfix-review.json`；4 项增量为并行 shutdown，目标 4 文件回归前后 SHA-256 一致）。真实 PG+Redis+SIGKILL stalled 重投后 failed 且 passed=1、结果保留。
- runtime A 定向复审为 115/115（core 63 + ZIP 52）、0 skipped（`/tmp/agentport-architecture-runtimeA-r2fix-review.json`），原始 `START` 输入正文严格相等，独立探测根 192/子 12/转义 8 组通过；先前 114/114 报告 `/tmp/agentport-architecture-runtimeA-review.json` 与记忆路径复核见 [runtime A 独立终审](system-architecture-runtimeA-review.md)。记忆路径两份报告均只跑 2 项定向、27 项未跑，不能当作该套件整体通过。
- knowledge 证据：初始后端 199/199（14 files）、web 129/129；补 9 场景 / 7 新增后 14 files / 206/206、0 skipped（`/tmp/agentport-architecture-knowledge-gapfix-suite2.json`），独立 Opus PASS（`/tmp/agentport-architecture-knowledge-gapfix-review.json`）。
- runtime B 旧证据为 22 files / 174/174 与旧 Docker 3/3，属旧事务回调实现，不能最终认可；删除编排已按 [revision](system-architecture-runtimeB-revision.md) 实现，分支补偿 22/22、真实 TCP 控制 5s + 持锁 40s 覆盖设置恢复（locks 14/14、矩阵 127/127）、Docker 新编排 3/3 独立 PASS；测试边界修后 4 files / 41 tests / 0 failed / 0 skipped；最终 Opus 窄复核运行中。联合首轮已被第二轮 403 files / 4382 tests / 4381 pass / 1 fail / 0 skip 取代，唯一失败为 MCP 取消观测竞态，修复后独立 3/3、相关 52 项 PASS；all3 运行中，结果待填写。
- 联合首轮 19 fail / 17 skip 的套件级定位与 skip 原因只保留在历史记录，不再重复；SDK 16/16 使用 `SANDBOX_IMAGE=agentport/sandbox:runtime-env-bash-20261029` 与当前 shared/sandbox 独占产物（fake 模型，0 付费），默认老 dev 镜像未改。
- 基线通过只说明现有行为；它不证明候选必须修，也不证明各分区实施后仍通过。
- 当前 A、B/C、eval、runtime A 与 knowledge 已通过独立终审/定向复审；runtime B 删除编排已实现，分支、截止/Docker 与测试边界修复均有独立证据；最终窄复核与 all3 完整联合尚未返回，没有整任务实现完成或 review 通过的结论。
