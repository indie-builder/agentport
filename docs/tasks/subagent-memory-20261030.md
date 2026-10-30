# 子智能体自身专家记忆（源码评审与最终测试夹具复验通过，未提交合并）

## 目标

让每个子智能体拥有自己的跨 run 专家记忆，直接复用 Claude Code 官方子智能体 `memory: project` 与既有 `agent-memory/` 目录，不新增平台私有记忆格式：

- 子智能体定义写入官方 `memory: project`；运行时把该子智能体既有的 `WORKSPACES_DIR/<slug>/agent-memory` 以 rw 直接挂到父会话工作区的 `/workspace/.claude/agent-memory/<slug>/`，由 SDK 原生按 project 记忆加载与写入。
- 主会话记忆保持现状不变：仍挂 `/mnt/agent-memory`，仍通过 `autoMemoryEnabled` + `autoMemoryDirectory` 加载；不把主记忆与子智能体记忆合并成一套。
- 不新增记忆表、run 级记忆快照或第二套记忆实现；记忆正文仍是官方 Markdown 文件。

验收目标（源码评审与最终测试夹具复验均已通过：整体 `a9f539537d2542d89` PASS、`sessions` format `a8c52733b5e29b393` PASS；SDK 最新接口 16/16 PASS、浏览器全部 PASS、stable/web/outputs/migration 通过，运行整合 13 文件 195/195 PASS；仍未提交合并）：

- 子智能体跨 run 读写自己的记忆；原生 Read/Write/Edit hook 拒绝兄弟子智能体、父级与未知子智能体访问非自身记忆，Bash 共享挂载可见性不作为隔离承诺。
- 绑定、启用状态与记忆写入在 chat / schedule / eval 执行期间不产生竞态；资源变化按约定拒绝，普通字段与无关专家仍可编辑。
- 主会话与子智能体的既有权限、显式 deny 与文件边界不因本次改动放宽。
- 专家包只携带定义，不携带学习到的记忆正文；导入导出对 `memory` 的 `project` 合法，`user` / `local` 明确拒绝。

## 方案

### 记忆挂载与加载

- 子定义 frontmatter 增加官方 `memory: project`。运行时由 worker 直接 rw 挂载该子智能体既有的 `WORKSPACES_DIR/<slug>/agent-memory` 到 `/workspace/.claude/agent-memory/<slug>/`；不复制、不转存、不另建目录。
- 主会话记忆路径与加载方式不变；同一会话里主记忆与各子记忆是不同挂载点，互不覆盖。
- 会话工作区每轮刷新时保留官方记忆子树本身的 inode（不删除重建该子树）；挂载集合发生变化时重建会话容器，避免沿用旧挂载。产出目录没有挂载根，同名 `.claude/agent-memory` 仍按普通内容整棵替换。
- 子记忆复用自身 `agent-memory/` 目录与既有写入口：UI 手工编辑 `MEMORY.md` 照常进入 `memory_changes`；只有 SDK 自主学习直接写 Markdown 不自动记账。

### 准入与并发

- chat / schedule / eval 三类执行型入口只使用「稳定启用」的直接子智能体集合；执行活动期间若绑定或启用资源发生变化，返回 409，不静默切换或合并新旧集合。审核 run（`trigger='review'`）不挂可写目录，不计入占用。
- 专家普通字段与无关专家的编辑不受该 409 影响。
- 锁顺序固定为：绑定锁 → 按排序后的 agent 记忆锁 → 行锁；反向持锁一律禁止，避免与现有委派/绑定事务交叉死锁。
- 占用集合为目标的执行型活动 run，或目标为启用子专家时其直接父专家的执行型活动 run；命中则拒绝记忆写入并返回 409。审核 run 与其他无合法归属关系的 run 不占用。

### 文件工具边界

- 已知子智能体的文件工具只允许访问自己的记忆 Markdown；兄弟子智能体、父级与未知子智能体的请求拒绝。
- 仅解除子定义平台默认 Read/Write/Edit 禁用；用户显式 deny 及其他平台边界继续保留。
- Bash 在容器内可看到已挂载目录，属于共享可见面；本次不声称 Bash 级别隔离，边界仍由只读/可写挂载与原生文件工具 hook 表达。

### 定义包

- 导入导出支持 `memory: project`；`user` / `local` 明确拒绝，不静默降级。拒绝理由是这些作用域未纳入平台挂载与导出契约，不是「目录在平台工作区之外」。
- 专家包只包含定义，不包含学习内容；`agent-memory/` 正文不进入包。

### 运行终态与清理（2026-10-31 契约，源码评审与运行整合复验通过）

针对第二路并发 review 的两项 P1（编辑 timeout 导致提前终态、stop/destroy 未确认仍按终态释放），复用现有 6 个运行状态（`queued/running/succeeded/failed/cancelled/timeout`）、现有 5 分钟 reconciler 与 `agent_runs.sandbox_id`，只新增 1 个可空字段，不新增表、服务或队列：

- **timeout 编辑**：普通超时编辑继续允许。running 收口即便已超过当前 `timeoutMs + 5 分钟`，也先探测队列 job；`active`、`waiting`、`delayed` 等有效状态或 Redis 探测失败时保持 running，只有 job 已消失或已到终态才条件更新 failed。因此调低 timeout 不再终止仍在执行的有效 job。
- **sandbox 身份**：run 启动前先把 sandbox id 写入运行行，而不是只在终态时写，供 worker 重启后按 id 清理。
- **stop 未确认**：停稳未确认且容器销毁失败时，不写终态、不发布 `run_finished`、不触发 BullMQ 重试；运行保持 running、`endedAt` 为 NULL，把完整的 `run_finished` 事件暂存到 `agent_runs.pending_finish`（可空 JSONB，类型复用现有事件）。后续由 reconciler 处理：job 仍有效则继续等待；job 已消失或已终态才按保存的 sandbox id 调用 `destroyById` 清理。
- **清理结果**：清理失败继续占用、保持 running 与 pending；成功后用 CAS 条件更新终态（运行仍为 running 且 pending 仍存在），清空 `pending_finish`，只发布一次终态事件并写一次审计。跨 worker 重启仍按 id 清理；Docker 暂不可用时保持占用，恢复后下一轮再清理。
- **实现边界**：schema（`pendingFinish` / 列 `pending_finish` 可空 JSONB + `0044_funny_sebastian_shaw.sql` 迁移）、provider（`destroyById`、`SessionSandboxes.cleanup(conversationId, sandboxId, expectedRunId)`、`SandboxCleanupError` 保留残留 ID）、runtime（index / `run-finish` / reconcile）已落地，源码整体评审 `a9f539537d2542d89` PASS，`sessions` format `a8c52733b5e29b393` PASS。第三轮 review `a72a49738d709d5d1` 的两项已修：reconcile 在 probe 后重读 status，避免旧 candidate 清理掉新 run 的容器 B；sessions 的 `acquire(spec, signal, runId)` 记录 `currentRunId`，`cleanup(conversationId, sandboxId, expectedRunId)` 拒绝其他 run 持有的容器；runner 取消/超时等待实际 acquire 完成，late lease release 保留 cause；index 对普通 pre-release error 保持 stopped 并保留 retry/cancel，typed error 走 pending，不再误判 unconfirmed。源码侧无待修项，运行整合两旧夹具按新取消收尾契约适配后已复验为 13 文件 195/195 PASS，生产源码未因此放宽。

### 评审与验收

- 三轮独立 Opus review，每轮固定 diff 范围；未全部通过不提交、不合并。
- 验证分层：SDK 本地 fake 模型、Docker 沙盒、真实浏览器验收；本轮不使用付费模型调用。
- 任一层未执行或未通过都如实记录，不以单测或代码检查冒充端到端验收。

## 基线与范围

### 原始基线（历史，已被工作树迁移替代）

- 起始 commit：`b683903`（`main`，分支 `loop-capability-subagent-memory-03`）。
- 原主 checkout 工作区持未提交实现；开发者当时明确要求 in-place，不建 worktree，属该轮例外。

### 当前基线（2026-10-31 迁移后）

- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/subagent-memory-pr`。
- HEAD：`f9c70f6`（`origin/main`），分支 `feat/subagent-memory-pr-20261031`。
- 迁移：从主 checkout `b683903` 的未提交实现迁入本树，逐文件核对 hash；未复制 `.vitest` 测试产物。原差异保全未修改，合并后备份清理。
- 锁：原主 checkout 的 inactive owner `642ddc7d` 写锁已接管为新 run `subagent-memory-pr-20261031`。
- 当前改动覆盖 `api` / `core` / `db` / `sandbox` / `web` / `worker` 模块；新增 migration、helper 与测试见下方文件清单，不硬编码文件或用例总数。
- 本记录只维护本文件；不新增其他文档。

## 当前有效决定

- 复用官方子智能体 `memory: project` 与既有目录，不新增第二套记忆或私有定义格式。
- 主记忆不变；子记忆只挂自己的目录。
- 锁顺序、执行期 409、目标写入检查、文件工具边界与 Bash 共享可见按上节执行。
- 工作树迁移替代原 in-place：产出只落 `.claude/worktrees/subagent-memory-pr`。
- 用户已授权 PR 合并并明确后续按推荐方案自主推进，不再逐项询问；最新表态「旅游期间按推荐方案自主，项目负责人」按同一授权记录，不等同于清库或生产部署授权。原任务的 commit/push/PR/merge 授权明确，无需再次确认。
- 当前阶段：源码评审通过——整体 `a9f539537d2542d89` PASS、`sessions` format `a8c52733b5e29b393` PASS；历史首轮 `ad8dc6d251f21accb`、第二轮 `a404e1a84b82c0403`、最新定点 `a3e9eaab09ee44c9f` 与第二路并发 `a18691bdeec312cf2` 的 3 个阻塞（enabled `aa3481a241ab8784a`、schema/migration `acee3691e15ad4a69`、provider cleanup `a3fa06824b5c42afb`）、第三轮 `a72a49738d709d5d1` 两项均已修复或通过。分层结果：SDK 最新接口 16/16 PASS（`/tmp/subagent-memory-sdk-final-interface-unique.json`）；浏览器全部 PASS、0 残留；stable 25 文件 376 用例、web 72、outputs 31、migration `generate` + `migrate` 隔离库 PASS。运行整合 13 文件 195/195 PASS（`/tmp/subagent-memory-runtime-final-green.json`）。因此仍是未提交、未合并，不得写成整体 passed 或已交付。
- 历史失败记录：运行终态曾出现 timeout 提前收敛与 stop/destroy 未确认仍按终态释放，均已修复并纳入上述源码评审。
- 只修已证实的路径，不因并行 review 或新评论扩大范围去加未经确认的理论防护。

## 评审与修复记录

- 首轮全范围 Opus review `ad8dc6d251f21accb`：发现成果刷新 P1、模型说明 P2；均已修复。
- 二轮修复 review `a404e1a84b82c0403`：确认原 P1/P2 已修复，新发现成果目录中普通 `.claude` 文件关联的 P2；已修复。
- 最新定点 review `a3e9eaab09ee44c9f`：明确通过。核对点为源码默认完整替换、仅 `preserveMemoryMount: true` 时保留官方记忆挂载根 inode；11 个 workspace 测试、worker typecheck、biome 通过。
- web 权限 UI 由 `ac32cb7b1b664d875` 完成；web 72 条用例通过（`/tmp/agentport-web-verify.json`），独立 UI review `aab8e7e3031ce6c04` PASS；typecheck/build 以最终全量复核为准。
- 第二路并发独立 review `a18691bdeec312cf2` 另发现 3 个真实阻塞，均确认为实际路径，不是理论假设：编辑 timeout 导致提前终态、stop 未确认且 destroy 失败仍按终态释放、chat / MCP 在锁外检查 enabled 的竞态。
- 第 3 项由 Sonnet 实施，锁内修复 `aa3481a241ab8784a` PASS。第 1/2 项按「运行终态与清理」契约实施；schema/migration `acee3691e15ad4a69` PASS，provider cleanup `a3fa06824b5c42afb` PASS，runtime 完成第三轮两项修复。
- 第三轮 review `a72a49738d709d5d1`：旧 candidate A probe 后清理 B 复用同一容器、pre-release 失败误判 unconfirmed 两项已修（probe 后重读 status、`expectedRunId` 拒绝跨 run 持有、保留残留 ID、runner 取消超时保 cause、index 区分 stopped/pending）；源码整体评审 `a9f539537d2542d89` PASS，`sessions` format `a8c52733b5e29b393` PASS。
- API 真实 processor 联调 `/tmp/run-pending-finish.json` 曾证明 pending/cleanup fail、记忆启停解绑 409、ordinary timeout 200、cleanup done 200；新 expected run id 后的最终结果并入运行整合复验。
- SDK 最新接口 16/16 PASS（`/tmp/subagent-memory-sdk-final-interface-unique.json`），不再有旧接口待办。

## 已替代项及原因

- 原先「in-place、不建 worktree」已被工作树迁移替代：本轮改为 `.claude/worktrees/subagent-memory-pr`（base `f9c70f6`）。
- 原记录「尚未执行，没有可引用的测试、typecheck、构建或浏览器结果」已被后续门禁替代；中间报告（如 23 文件 393 用例）早于最新修复，仅作历史中间基线。
- 原记录「未验证、未提交、未 review」中的「未验证」与「未 review」已被源码评审与分层验证替代；「未提交」仍然有效。
- 「子智能体的原生文件工具一律被平台禁用」已被「已登记子智能体只读写自身记忆 Markdown」替代；权限页文案已由 `ac32cb7b1b664d875` 修正，web 72 条与独立 UI review `aab8e7e3031ce6c04` 通过。
- 原记录「专项 SDK 运行中、浏览器正在验收」已被本轮结果替代：SDK 最新接口 16/16 PASS、浏览器全部 PASS、0 残留；旧接口待办已过时，运行整合两旧夹具已适配并通过 195/195。

## 步骤

- [x] 能力探索确认原生支持与平台缺口：子定义与文件权限原为禁用，直接接线会漏父 run 与子记忆编辑互斥、绑定变化与挂载复用。
- [x] Opus 定契约：记忆挂载、锁顺序、执行期准入、文件边界、定义包与评审方式。
- [x] Sonnet 并行实现锁与准入、运行时挂载、定义与导入导出三块源码及对应测试。
- [x] 从主 checkout `b683903` 迁入本树，核对接管锁与原差异保全。
- [x] 独立 Opus review：首轮、二轮、最新定点、第二路并发 3 个阻塞与第三轮两项均已修复或通过；源码整体 `a9f539537d2542d89` PASS，`sessions` format `a8c52733b5e29b393` PASS。
- [x] SDK 本地 fake、Docker 沙盒与真实浏览器验收：SDK 最新接口 16/16 PASS（`/tmp/subagent-memory-sdk-final-interface-unique.json`）；浏览器全部 PASS、0 残留，UI `aab8e7e3031ce6c04` PASS。
- [x] 最终测试夹具复验：stable 25 文件 376、web 72、outputs 31、migration `generate` + `migrate` 隔离库已通过；运行整合 13 文件 195/195 PASS（`/tmp/subagent-memory-runtime-final-green.json`）。

## 改动文件

源码与测试按模块（最终文件以实际 diff 为准，不硬编码总数）：

- `packages/api/src/features/agents/routes.ts`、`packages/api/src/features/memory/changes.ts`；测试含 `delegation-memory-lock.test.ts`（新增）、`chat-admission.test.ts`、`agent-package-zip.test.ts`、`subagent-export.test.ts`、`subagent-file.test.ts`。
- `packages/core/src/agent-md.ts`、`official-files.ts`、`workspace.ts` 及对应测试。
- `packages/db/src/schema.ts`、`repo/{agents,chat,locks,ops}.ts`；migration `0044_funny_sebastian_shaw.sql` 与 `meta/0044_snapshot.json`。
- `packages/sandbox/src/memory-permissions.ts`、`runner.ts` 及对应测试。
- `packages/web/src/pages/agents.tsx`、`packages/web/test/agents-lifecycle.test.ts`。
- `packages/worker/src/{index,reconcile,runner-client,eval-runner,session-workspace}.ts`、`sandbox/{docker,provider,sessions}.ts`、`run-finish.ts`（新增）；测试含 `run-pending-finish.test.ts`（新增）、`session-workspace.test.ts` 等。

文档：

- `docs/tasks/subagent-memory-20261030.md`（本记录）。

## 下一步

由后续收尾 agent 完成并记录：

1. 源码评审与最终夹具复验均已通过（`a9f539537d2542d89`、`a8c52733b5e29b393`、`/tmp/subagent-memory-runtime-final-green.json`）；两旧夹具按新的取消收尾、状态重查契约适配，生产源码未放宽。
2. 运行整合 13 文件 195/195 PASS，0 失败、0 skip。
3. SDK 最新接口 16/16 PASS（`/tmp/subagent-memory-sdk-final-interface-unique.json`），浏览器全部 PASS、0 残留；分层通过不等同于已提交合并。
4. stable 25 文件 376、web 72、outputs 31、migration `generate` + `migrate` 隔离库已通过；最终测试与 typecheck/build 以运行整合 green 结果为准。
5. 按用户授权提交并合并 PR；合并后删除工作树，原差异保全未修改，备份清理。最终结果与提交/合并号由后续收尾 agent 补入本文件。

## 验证

- 源码评审：整体 `a9f539537d2542d89` PASS，`sessions` format `a8c52733b5e29b393` PASS。
- stable 基线：25 个测试文件 / 376 条用例通过，0 失败、0 skip；web 72 条与 outputs 31 条通过；migration `generate` + `migrate` 在隔离库 PASS。
- 运行整合 13 文件 195/195 PASS，0 失败、0 skip（`/tmp/subagent-memory-runtime-final-green.json`）；两旧夹具按新的取消收尾、状态重查契约适配，生产源码未为此放宽。
- 浏览器最终验收全部 PASS、0 残留：保存/刷新、409 草稿、普通 200、导出再导入；权限默认、禁用-保存-重载、恢复 path rules、previews ZIP、父级回归全部通过。证据 `/tmp/subagent-memory-pr-browser-20261031-013033/evidence/validation-{results,permissions}.json`；临时 DB/Redis 端口 0、space 已结束、截图与 ZIP 保留。
- SDK 最新接口 16/16 PASS（`/tmp/subagent-memory-sdk-final-interface-unique.json`），0 skip；本轮无付费模型调用。
- API 真实 processor `/tmp/run-pending-finish.json`：pending/cleanup fail、记忆启停解绑 409、ordinary timeout 200、cleanup done 200 均已证明；最终结果并入运行整合复验。
- 新增 migration `0044_funny_sebastian_shaw.sql` 只在隔离测试库验证，未应用到共享库。
- 独立 review 结论：历史 `ad8dc6d251f21accb`、`a404e1a84b82c0403`、`a3e9eaab09ee44c9f`、`a18691bdeec312cf2`、`a72a49738d709d5d1` 的问题均已修复或通过；源码整体 `a9f539537d2542d89` PASS。
