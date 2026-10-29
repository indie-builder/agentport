# 全项目轮换代码审查与开发规范沉淀

## 目标

本轮全项目轮换式审查已停止扩审，进入最终交付：只修真实问题，并把有证据支撑、可复用的开发规范沉淀到现有权威文档。

- 审查按区域轮换，覆盖全部代码与配置，不重复扫已通过部分。
- 每个发现要有具体文件、位置与证据；修复走最小完整改动，能用诚实行为测试就先红后绿。
- 每轮经过独立 Opus review，并按改动范围跑真实验证命令。
- 开发规范最终整合进现有 `docs/DEV-WORKFLOW.md`、`docs/ARCHITECTURE.md` 及对应领域文档，不新增平行规范源，不写未经验证的规则。
- 扩审已停止：定时任务 `d1cce124` 已删除，CronList 无任务；不重建 loop、不新增审查切口，剩余工作只有最终验证、提交 PR 与合并。

验收标准：每轮有固定基线、文件清单与审查重点；未返回的审查标为「进行中」；作者报告与独立 review / 主会话验证分开记录，作者报告不得作为最终验收；未实际修复并验证的项不得标记完成。

## 方案

- **轮换顺序**：首轮并行只读审查 API/DB 入口、worker/sandbox/core、web 交互；后续轮换 knowledge、运维配置、导入/插件官方能力等领域。具体清单见「覆盖矩阵」。
- **审查方式**：每轮固定 commit 基线、文件清单和审查重点，交给只读审查子代理；发现新问题时先扩展基线与清单再继续，不压掉新发现。
- **模块设计语言**：使用 `codebase-design` 的 Module / Interface / Seam 术语描述边界问题，不另造词汇。
- **工程纪律**：按 `ub-mode` 做最小完整改动；先红后绿；不为理论风险加防护；范围变化先改本记录再动手。
- **证据纪律**：只把已返回、已复核的发现写成「已修复 / 已验证」；未返回的保持「进行中」；无法复现或无法验证的如实记录限制。
- **规范沉淀**：只把反复出现、已被真实缺陷或评审证明的规则写入现有文档对应章节；一次性的实现细节留在任务记录或 `PITFALLS.md`，不升级成规范。
- **踩坑规避**：开工前每轮读 `docs/PITFALLS.md`；worktree 内 git 用 `/usr/bin/git`，复合命令与 heredoc 分开执行；任务记录只写 `docs/tasks/`。

## 基线与范围

- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-review-loop`
- 分支：`worktree-codebase-review-loop`
- 基线：`HEAD` = `origin/main` = `e060e3a559633a0d94adb637516a6d577b86b1aa`；本任务提交 `39cd98a`，已合入 `origin/main` `5ccf9d4`（PR115/116/117 会话终态、技能、品牌蓝），merge 提交 `28a88a3` 已完成并推送。
- 主会话开工时 `git status --short` 为空；当前工作树差异全部由本任务产生或为本任务测试生成物，不按「开工遗留」处理。
- `.vitest/json/output.json` 是本任务测试生成的结果文件，仍会被并行测试改写，待统一收尾，不作为源码改动。
- 主 checkout 保持干净，产出只落在本 worktree。
- 源码与测试由 A/B/C/D/E、knowledge、web、eval、schedule 各作者持有，边界与证据只由本记录表格和对应子记录维护。
- 用户已明确授权提交 PR 后合并（commit / push / merge）；最终交付由主会话在验证后执行，不另开确认流程。

## 当前有效决定

- 用户已明确授权全项目审查修复与开发规范整理，已证实的文档冲突直接修正，不再逐项请求确认；并已授权最终 commit / push / merge（提交 PR 后合并），不另开确认流程。
- 规范沉淀只写已通过独立 review 与主会话验证的规则；按最小整合补进现有权威章节，不新增平行段落、工具或术语表。
- 已验收的子项：A（后端与专家包、前端共享 schema 管道）、B/C、D/E、knowledge 页面三项、navigation、knowledge cancel/queue 重投、chat 滚动（a12）、thinking 代码 / 测试 / 迁移、agent-md 测试、eval 两项（a1ba）、schedule 两项（a450 / a7c 业务 review；最终测试顺序 a573 复核，主会话 `bxb` 两文件 31 passed / 0 skip）、build 测试（a568；`bquo` 15 passed）、knowledge guard 测试（a0b；`bvn` 3 passed）；这是按子项验收，不代表对应区域全部代码已审通过。native/sandbox-probe 队列（独立 Opus `aa19`）与成果保留期（独立 Opus `a97`）两修复均已通过独立 review 并验收；`agent-package-runtime-environment` 全表计数修正经 Opus `a2c` 通过，最终全量已包含该修复。
- 历史 chat E2E 补修独立 review 通过（aa5）；滚动修复后最终真实运行 9/9（a12 核实，见下），清理无残留。
- 分页滚动根因已确证：产品侧引用相等识别与 load-older 阻塞原语 prepend；原 `scrollTop < 100` 断言不符阅读锚点。产品修复已独立 Opus a12 通过：a12 核实原始最后两轮 auth + history 各 9/9 及清理；精确 `075 / 025 top60 → 60` 只来自诊断轮逐帧，最后两轮无逐帧输出、以几何断言通过，两类证据不混写。主会话 chat-scroll / chat-ux / chat-stream 3 files / 89 passed / exit 0；E2E 由作者真实运行、a12 核实，主会话未另跑。具体见 `codebase-review-web-chat.md`。
- thinking 全链路移除 `maxThinkingTokens`：独立 Opus a06 代码 / 测试 / 迁移通过且结论不变；产品文档同步（README / USER-STORIES / CAPABILITY-GAP / ARCHITECTURE）已由 Opus ac822 复核通过；迁移仍只随机 / 临时库执行，未在共享库执行。
- 下一域 knowledge 执行链审查已返回 2 项：
  - 摄取取消跳过状态收尾：已修并验收。主会话完整 `knowledge-ingestion` 37 passed / 0 skipped、exit 0（输出任务 `bgd3kic5p`），独立 Opus `a3a79` 通过；首次摄取落 `failed`，已有版本保持 `ready` 且 chunks/向量保留。
  - 队列重投：DB 行停在 `running` 时 BullMQ stalled 重投，`claimJob` 失败后处理器正常 `return`，job 被记 `completed`。已修并验收：独立 Opus `a6fe` 通过，主会话 `b98hhx2wc` 真实重跑 4 files / 25 passed / 0 skipped / exit 0；测试模拟 stalled 重投入口，未实测 kill 进程，依赖既有 reconcile 恢复（通常 6–11 分钟），限制保留。独占 `packages/worker/src/knowledge/queue.ts` 与 `packages/worker/test/knowledge-queue.test.ts`，子记录 `codebase-review-knowledge-redelivery.md`。
- 安全文档（`ARCHITECTURE.md` / `OPERATIONS.md` / `SECURITY.md`）的模型 token 条件表述最终复核已通过（abf3）。
- 规范两处表述已通过独立 Opus `af217` 复核：文件资源校验各独立入口分别校验；正文 UTF-8 计数与 ZIP 大小统计分别保留。
- core `agent-md` 陈旧完整对象预期已补 `runtimeEnvironmentId: null`：主会话 `bg64` 12 tests 通过，独立 Opus `a134` 通过；代码由 Sonnet 实际执行，不是主会话直接改。
- SDK 镜像子项 `a681` 使用独有镜像 `agentport/sandbox:review-loop-610bd2`，verbose 真实 10/10 通过、无 skip；见 `codebase-review-sdk-image.md`。
- 恢复审查已最终验收：首轮 39 tests 通过但 Opus 未通过（破坏缺 `.env` 灾难恢复、`run_*` 部分回滚不全）；补修后独立 Opus `a3d703` 通过（最后 URL 反解；缺 env/坏配置中止与 `run_*` 归位同轮通过），主会话 `byw28qy0g` 完整 42 passed / 0 skipped / exit 0（原始输出 `rtk recall 278485a1b40f3648`），`bash -n` 与对应 `git diff --check` 通过。特殊字符 URL 仅 stub 逐字节往返 + Opus `/bin/bash` 两端各 782 组合，无真实特殊密码账户连接；不把 stub 当真实 PG 恢复。
- OPS 恢复新增段最终已通过独立 Opus `a146`：原 `ac403` 指出的四事实问题已修，结论为通过，不再等待。
- 恢复代码 42 tests + 独立 review、插件 path 13 + review、permissions 89 + review、7 包 typecheck / build 证据保持有效，不重跑。历史后端 239 files / 2314 passed 与历史 web 115 files / 1277 passed 早于本批代码，只作历史。最终验证（合并 `origin/main 5ccf9d4` 后）：backend `b0eg5ns1j` 241 files / 2340 passed / 0 skip / exit 0（完整日志 `tool-results/bd2s74p96.txt`）；web `bo6hv0cif` 115 files / 1291 passed / 0 skip / exit 0；7 包 typecheck `bbi` exit 0；build `bw1` exit 0（仅 chunk >500KB 提示）；focus / contract 合并前通过；合并后主会话再核 focus / contract 与 `git diff --check` 均通过。
- 提交与合并：本任务 `39cd98a` 已提交；已合入 `origin/main 5ccf9d4`（PR115/116/117 会话终态、技能、品牌蓝），merge 提交 `28a88a3` 已完成并推送。唯一 chat-ux 测试冲突由 Sonnet 解决，保留两边全部测试。Opus 集成 review `aa582` 已通过。main 品牌蓝 / 发送 solid / 终态等待修复完整保留；不改视觉 token 与已合决定。当前已验证，准备推 PR 合并；loop 已删，不重建。
- 本轮实际发现 4 项，状态如下（只覆盖各自切口，不代表全 eval / 全 ops 深审）：
  - eval 写失败收口（结果未落库却计 passed、批次仍 succeeded）：已修并验收；独立 Opus `a1ba` 通过；主会话 `bdxq197ci` 真实 5 files / 37 passed / 0 skipped。写失败批次 `failed` + `error`，passed 不虚增。
  - eval 失败路径 `runId` 丢失：同上验收；已创建子 run 的失败仍关联真实 `runId`，创建前失败仍为 `null`，每 case context 隔离。
  - schedule 普通保存重置调度：已修并验收；Opus `a450` 业务 review 通过；最终测试顺序复核 `a573` 通过，主会话 `bxb` 两文件 31 passed / 0 skip。
  - schedule `lastRunAt` 取 `job.timestamp` 而非计划时刻：已修并验收；Opus `a7c` 业务 review 通过；同上 `a573` / `bxb` 复核。
- eval 队列为 mock，不声称真实 Redis / worker 故障链路。
- 上述知识域与各子项结论只覆盖已列子项，不把对应区域全量标为审通过。

## 已替代项及原因

- 取代此前分散在各节的「作者已返回、review/验证中」与重复计数：当前状态只保留本记录表格、覆盖矩阵与验证证据各一份，详细过程链接各子记录。
- 取代「A 修复运行中 / B/C 补修中 / D/E review 进行中 / web a78 运行中」：这些均已返回，按独立 review 与主会话验证结果记录。
- 取代「chat 主会话 review/验证待进行、2 条 E2E 因环境未启动未跑」：chat 源码静态 review 已认可；E2E 已真实运行，历史补修 review aa5 通过，滚动失败项保留。
- 取代「knowledge 补修进行中、navigation review 与主会话验证进行中」：两者均已闭环，证据见对应子记录。
- 取代「web 全量 114 files / 1268 passed 代表当前全 web」：旧数只作历史；本批最终 web 为 115 files / 1291 passed / 0 skip / exit 0（`bo6hv0cif`），早先 115 / 1277 只代表本批代码之前的 Web 源码范围。
- 取代「knowledge 执行链审查进行中、规范两处待复核、cancel 待 Opus review」：审查已返回 2 项，cancel 与 queue 重投均已验收，规范两句 af217 已通过。
- 取代「thinking 文档新增待独立 review」：产品文档已由 Opus ac822 复核通过；代码 / 测试 / 迁移 a06 结论不变，迁移仍只随机 / 临时库。
- 取代「agent-md 测试由主会话直接改」：实际代码由 Sonnet 子代理执行，主会话只做记录与验证；已由 bg64 / Opus a134 验收。
- 取代「knowledge queue 真实 Redis 测试进行中」「SDK 镜像已完成」：queue 已验收（测试模拟重投、未实测 kill 进程）；SDK 独有镜像 verbose 已真实 10/10，不写「仍等待」。
- 取代「restore 补修中、41 tests / 真实 PG 未正式返回」：补修已由 Opus `a3d703` 与主会话 `byw28qy0g` 42 passed / 0 skipped 验收；stub 覆盖与真实 PG 演练边界分开记录。
- 取代「当前无未完代码修复 / 两条审查未返回」：eval 两项已验收（`a1ba`；`bdxq197ci` 37 passed）；schedule 两项已验收（a450 / a7c 业务 review，a573 测试顺序复核，`bxb` 两文件 31 passed / 0 skip）。
- 取代「loop `d1cce124` 持续每 15 分钟一轮」「后续领域轮换待进行」：扩审已停止，定时任务已删除且 CronList 无任务，不重建；只做最终交付。
- 取代「未授权 commit / push / merge」：用户已明确授权提交 PR 后合并；此前把最终交付的提交动作写成未授权，属误记。
- 取代「用户本轮不派代理、不提交」：那是两个修复子代理的局部执行约束，不是用户全局要求；作者返回后仍需独立 review 与主会话最终验证，提交由主会话执行。
- 取代「native/sandbox-probe `aa81` 仍在运行」「成果保留期审查未返回」：两修复已分别由独立 Opus `aa19` / `a97` 通过并验收。

## 步骤

- [x] 固定基线、记录路径与初始差异归属，创建本记录。
- [x] 派发三个 Opus 只读审查，收集 A/B/C、D/E 与 web 发现。
- [x] A/B/C/D/E 修复、独立 review 与主会话验证。
- [x] knowledge 页面三项与 navigation 闭环；chat 源码静态 review。
- [x] 规范文档整合与事实核对。
- [x] chat 历史 E2E 补修与独立 review（aa5）；run4/5 真实运行有结果，清理无残留。
- [x] knowledge 执行链审查返回 2 项；摄取取消修复经 Opus a3a79 与主会话 37 passed / 0 skipped 验收。
- [x] queue 重投修复：独立 Opus a6fe 与主会话真实重跑 4 files / 25 passed / 0 skipped 验收。
- [x] 分页滚动产品根因修复：独立 Opus a12 通过（核实最后两轮 auth + history 9/9 与清理；精确 top60 → 60 仅来自诊断轮逐帧），主会话 3 files / 89 passed；E2E 未由主会话另跑。
- [x] thinking 全链路移除 `maxThinkingTokens`：代码 / 测试 / 迁移 a06 通过，产品文档 ac822 通过。
- [x] core `agent-md` 陈旧完整对象预期修复：bg64 12 tests 与 Opus a134 通过。
- [x] SDK 独有镜像 `review-loop-610bd2` 的 verbose 验证：真实 10/10、无 skip。
- [x] 恢复审查补修：Opus `a3d703` 与主会话 `byw28qy0g` 42 passed / 0 skipped 验收；普通 URL 真实 PG 演练通过，特殊字符 URL 仅 stub 往返。
- [x] 插件 `paths` 有限修复：独立 Opus `a3c50` 通过，主会话 13 tests 通过。
- [x] 插件 `permissions` 有限修复：独立 Opus `ae3` 通过；主会话 `b9g1fl3ks` 7 files / 89 passed / 0 skipped；范围止于 API 存储、ZIP 往返与 render、按 worker 规则临时落盘执行，不声称真实 worker / SDK hook 调用。
- [x] eval 两项修复：独立 Opus `a1ba` 通过；主会话 `bdxq197ci` 真实 5 files / 37 passed / 0 skipped。
- [x] schedule 普通保存：Opus `a450` 业务 review 通过；测试顺序复核 `a573` 通过，主会话 `bxb` 两文件 31 passed / 0 skip。
- [x] schedule 计划时刻来源：Opus `a7c` 业务 review 通过；测试顺序复核 `a573` 通过，主会话 `bxb` 31 passed / 0 skip。
- [x] build 测试等待：明确 `buildxStarted` 信号 + `close/await` 收尾；主会话 `bquo` 15 passed，Opus `a568` 通过；生产代码未改。
- [x] knowledge guard 测试配置：复用 `testConfig()` + 正常加密 fixture；主会话 `bvn` 3 passed，Opus `a0b` 通过。
- [x] native/sandbox-probe 队列：独立 Opus `aa19` 通过并验收；红 3 轮 2 failed / 10 passed、绿多轮 12/12；受控窗口不作历史唯一归因，详见子记录。
- [x] 主会话最终完整 backend：241 files / 2340 passed / 0 skip / exit 0（`b0eg5ns1j`，日志 `tool-results/bd2s74p96.txt`）；`agent-package-runtime-environment` 全表计数修正经 Opus `a2c` 通过。
- [x] 运行保留期 maintenance / `pruneRuns` 与消息附件、成果清理（不含 knowledge 清理）：独立 Opus `a97` 通过并验收（红 3/3、绿 6 files / 79 passed）。
- [x] 停止扩审：删除定时任务 `d1cce124`，确认 CronList 无任务，不重建 loop。
- [ ] 最终交付：最终 backend / web / typecheck / build 已由主会话运行并全绿（计数见「验证」）；已合入 `origin/main 5ccf9d4`（含品牌蓝），merge 提交 `28a88a3` 已推送，chat-ux 测试冲突由 Sonnet 解决并保留两边测试；合并后主会话 focus / contract / `git diff --check` 均通过；Opus 集成 review `aa582` 已通过。当前已验证、准备推 PR 合并（用户已授权），尚未创建 PR 或确认远端合并结果。

## 发现与修复

| 编号 | 文件 / 区域 | 复现问题 | 结论 | 状态 |
|---|---|---|---|---|
| A | `packages/shared/src`（技能路径与资源路径检查及 exports）、`packages/db/src/repo/skill-files.ts`、`packages/db/src/repo/skills.ts` 及对应测试 | 技能资源 schema 允许 `SKILL.md` 自身、空段以及 `refs/refs/child` 冲突路径 | 核心与专家包共享 Interface 整合通过独立 Opus review；主会话 8 files / 147 passed / 0 skipped | 已闭环 |
| A（前端共享 schema 管道） | `packages/web/src/pages/skills.tsx`、`packages/web/test/skill-editor.test.ts` | 表单重复实现路径正则，与共享 schema 判定分叉 | 独立 review 通过；主会话 4 files / 45 tests 通过 | 已闭环 |
| B | `packages/api/src/features/agent-package.ts` 及测试 | `assertDefinitionLimits` 把规则与输出风格的 slug 命名空间混在一起，合法同名导出被拒 | 独立 Opus review 通过 | 已闭环 |
| C | 同上 | `packAgentPackage` 只检查压缩后大小；临界 UTF-8 总 4 MiB 包能导出却导不回 | 覆盖临界反例；独立 Opus review 通过 | 已闭环 |
| D | `packages/worker/src/index.ts`、`packages/worker/test/run-runtime-identity.test.ts` | `publishRun` 失败后状态残留 running，BullMQ 重试被认领守卫跳过 | 独立 Opus review 通过；联合测试通过 | 已闭环 |
| E | 同上 | 基础设施失败时提前持久化 session/uuidMap，重试续跑到错误 transcript | 独立 Opus review 通过；联合测试通过 | 已闭环 |
| Web | 见各子记录 | chat 缓存卸载、knowledge 三项、navigation blocker 生命周期 | knowledge、navigation 通过独立 review 与主会话验证；chat 源码缓存静态 review 认可，历史 E2E 补修 review aa5 通过；滚动 Opus a12 通过（核实最后两轮 auth + history 9/9 与清理）+ 主会话 89 passed | 已闭环 |
| knowledge-cancel | `packages/worker/src/knowledge/ingestion.ts`、`packages/worker/test/knowledge-ingestion.test.ts` | `KnowledgeCancelled` 在首次摄取时提前重抛，绕过状态收尾，文档永久停在 `processing` | 主会话完整套件 37 passed / 0 skipped、exit 0（`bgd3kic5p`）；独立 Opus a3a79 通过；首次 `failed`、已有版本 `ready` 且 chunks/向量保留 | 已验收 |
| knowledge-queue | `packages/worker/src/knowledge/queue.ts`、`packages/worker/test/knowledge-queue.test.ts` | 行仍为 `running` 时 stalled 重投，`claimJob` 返回空后处理器正常 `return`，job 被记 `completed`，任务不再执行 | 独立 Opus a6fe 通过；主会话 `b98hhx2wc` 4 files / 25 passed / 0 skipped / exit 0；测试模拟重投入口，未实测 kill 进程；reconcile 恢复通常 6–11 分钟，限制保留；契约见子记录 | 已验收 |
| thinking | 全链路 `maxThinkingTokens` | 不是必然 400；CLI 2.1.311 对 Sonnet 5.5 adaptive 忽略数字；真实 CLI 请求未抓包 | 独立 Opus a06 代码 / 测试 / 迁移通过；主会话 `bjge` 9 files / 168 passed、`bgh` agentsUI 41 passed；迁移只随机 / 临时库；产品文档 Opus ac822 通过 | 已验收 |
| agent-md | `packages/core/test/agent-md.test.ts` | 完整对象预期缺 `runtimeEnvironmentId: null` | 主会话 `bg64` 12 tests 通过；独立 Opus a134 通过；代码由 Sonnet 执行，非主会话直接改 | 已验收 |
| SDK 镜像 | `packages/worker/test/session-sandbox-sdk.test.ts`、独有镜像 `review-loop-610bd2` | 共享 `agentport/sandbox:dev` 缺 GNU bash，10 例在用例前失败 | 独有镜像 verbose 真实 10/10、无 skip；见子记录 | 已验收 |
| restore 补修 | 安全包 ENV 处理、`ws_swap` run 迁移、引导 env 引号往返 | 首轮 39 tests 通过但独立 Opus 未通过：破坏缺 `.env` 的灾难恢复；部分 `run_*` 搬成功后回滚不全 | Opus `a3d703` 通过（最后 URL 反解；前两项同轮通过）；主会话 `byw28qy0g` 42 passed / 0 skipped / exit 0；`bash -n` 与 diff check 通过；普通 URL 真实 PG 演练通过，特殊字符 URL 仅 stub 往返 | 已验收 |
| plugin-paths | `packages/api/src/features/plugins/parse.ts`、`packages/api/test/plugin-parse.test.ts` | `parsePluginFiles` 只查完全重复路径，祖先/后代路径可同时导入，落盘时同一路径既当文件又当目录 | 独立 Opus `a3c50` 通过；主会话 13 tests 通过；见子记录 | 已验收 |
| plugin-permissions | 插件导入导出可执行位 | 需真实导入/导出往返验证可执行位 | 独立 Opus `ae3` 通过；主会话 `b9g1fl3ks` 7 files / 89 passed / 0 skipped；覆盖 API 存储、ZIP 往返与 render、按 worker 规则临时落盘执行，不声称真实 worker / SDK hook 调用；见子记录 | 已验收 |
| eval-write | `packages/worker/src/eval-runner.ts`、`packages/worker/test/eval-result-write.test.ts` | `addResult` 失败只 log，批次仍 `succeeded` 且 `passed` 虚增 | Opus `a1ba` 通过；主会话 `bdxq197ci` 5 files / 37 passed / 0 skipped；写失败批次 `failed` + `error`，passed 不虚增；队列 mock，不声称真实 Redis / worker 故障链路 | 已验收 |
| eval-runId | 同上、`packages/worker/test/eval-snapshot.test.ts` | 子 run 创建后 failed/cancelled/timeout/队列等待失败时 `runId=null`，丢失追踪关联 | 同上验收；创建后失败仍关联真实 `runId`，创建前失败仍 `null`；每 case context 隔离 | 已验收 |
| schedule-save | `packages/api/src/features/ops/routes.ts`、`packages/api/test/schedule-routes.test.ts` | PATCH 普通保存也 upsert scheduler，重置 pending job 与 `next` | Opus `a450` 业务 review 通过；测试顺序复核 `a573` + 主会话 `bxb` 两文件 31 passed / 0 skip | 已验收 |
| schedule-time | `packages/worker/src/scheduler.ts`、`packages/worker/test/schedule-scheduler.test.ts` | `lastRunAt` 取 job 创建时刻 `job.timestamp`，日任务可提前数小时 | Opus `a7c` 业务 review 通过；测试顺序复核 `a573` + 主会话 `bxb` 31 passed / 0 skip | 已验收 |
| build-test | `packages/worker/test/runtime-environment-build.test.ts` | 固定 20 次 `setImmediate` 当 buildx 就绪信号；真实 fs 回调前轮数已用完，全量并行偶发 `buildIndex = -1` | 改 `buildxStarted` 明确信号 + `Promise.race` + 子进程 `close/await` 收尾；未改生产代码；主会话 `bquo` 15 passed；Opus `a568` 通过 | 已验收 |
| knowledge-guard | `packages/api/test/knowledge-server-guard.test.ts` | 测试 app config 缺 `APP_SECRET_KEY`，列表解密普通连接器 `env` 时 500；空库单跑掩盖 | 复用 `testConfig()`，用生产 `createServer` 预置正常加密记录；主会话 `bvn` 3 passed；Opus `a0b` 通过 | 已验收 |
| native-queue | native/sandbox-probe 队列测试 | 联合回归 4 条队列测试失败；受控实测首次 XREAD 前完成可漏通知 | 独立 Opus `aa19` 通过并验收；红 3 轮 2 failed / 10 passed、绿多轮 12/12；受控窗口不作历史唯一归因 | 已验收 |
| output-retention | `packages/core/src/outputs.ts`、`packages/db/src/repo/maintenance.ts`、`packages/worker/src/maintenance.ts` 及测试 | 旧 run 清理删除已发布成果锚点，较新消息 fork 丢失旧成果 | 独立 Opus `a97` 通过并验收；红 3/3、绿 6 files / 79 passed | 已验收 |

详细复现、测试契约与改动边界只由各子记录维护，本记录仅链接：

- [codebase-review-web-chat.md](codebase-review-web-chat.md)：源码缓存修复静态 review 认可；历史 E2E 补修 review aa5 通过；滚动 Opus a12 通过（证据口径见上）、主会话 3 files / 89 passed。
- [codebase-review-web-knowledge.md](codebase-review-web-knowledge.md)：三项修复通过独立 Opus 限定复核（a4aed）与主会话 2 files / 132 passed / 0 skipped。
- [codebase-review-web-navigation.md](codebase-review-web-navigation.md)：评审通过；主会话 8 files / 50 tests，共享 schema 整合 4 files / 45 tests。
- [codebase-review-knowledge-cancel.md](codebase-review-knowledge-cancel.md)：取消状态收尾已验收（37 passed / 0 skipped；Opus a3a79）。
- [codebase-review-knowledge-redelivery.md](codebase-review-knowledge-redelivery.md)：队列重投已验收（a6fe；4 files / 25 passed / 0 skipped；模拟重投入口与 reconcile 时延限制见子记录）。
- [remove-fixed-thinking-budget.md](remove-fixed-thinking-budget.md)：thinking 代码 / 测试 / 迁移（a06；bjge 168 passed；bgh 41 passed）与产品文档（ac822）均已通过。
- [codebase-review-agent-md-test.md](codebase-review-agent-md-test.md)：陈旧预期已修复（bg64 12 tests；Opus a134）。
- [codebase-review-sdk-image.md](codebase-review-sdk-image.md)：独有镜像 verbose 真实 10/10、无 skip，已验收。
- [codebase-review-restore.md](codebase-review-restore.md)：已最终验收：Opus `a3d703` 通过（最后 URL 反解；前两项同轮通过），主会话 `byw28qy0g` 42 passed / 0 skipped；stub 与真实 PG 边界见子记录。
- [codebase-review-plugin-paths.md](codebase-review-plugin-paths.md)：祖先路径冲突已修，Opus `a3c50` 通过，主会话 13 tests。
- [codebase-review-plugin-permissions.md](codebase-review-plugin-permissions.md)：已验收，Opus `ae3` 通过；主会话 `b9g1fl3ks` 7 files / 89 passed / 0 skipped；范围边界见子记录。
- [codebase-review-eval-results.md](codebase-review-eval-results.md)：eval 两项已验收（Opus `a1ba`；主会话 `bdxq197ci` 5 files / 37 passed / 0 skipped；队列 mock）。
- [codebase-review-schedule-save.md](codebase-review-schedule-save.md)：普通保存不重置调度；Opus `a450` 通过，`a573` / `bxb` 31 passed。
- [codebase-review-schedule-time.md](codebase-review-schedule-time.md)：`lastRunAt` 取计划时刻；Opus `a7c` 通过，`a573` / `bxb` 31 passed。
- [codebase-review-build-test.md](codebase-review-build-test.md)：buildx 就绪等待已修；`bquo` 15 passed，Opus `a568` 通过。
- [codebase-review-knowledge-server-test.md](codebase-review-knowledge-server-test.md)：knowledge guard 配置缺口已修；`bvn` 3 passed，Opus `a0b` 通过；fixture 误述已更正为 repo `createServer`。
- [codebase-review-queue-events.md](codebase-review-queue-events.md)：完成通知窗口修复已验收；独立 Opus `aa19` 通过；红 2 failed / 10 passed ×3、绿多轮 12/12。
- [codebase-review-output-retention.md](codebase-review-output-retention.md)：成果保留锚点修复已验收；独立 Opus `a97` 通过；红 3/3、绿 6 files / 79 passed。

## 覆盖矩阵

状态口径：`排队`（后续轮换）/ `进行中`（已派发，含作者已返回但独立 review / 主会话验证未完成）/ `已完成`（有证据结论）/ `已修复`（修复并经独立 review）。

| 轮换区域 | 范围 | 状态 | 证据 / 备注 |
|---|---|---|---|
| API/DB 入口 | `packages/api/src`、`packages/db/src` | 已修复 | A/B/C 独立 review 通过；主会话 8 files / 147 passed；knowledge guard 测试 `bvn` 3 passed / a0b 通过；不代表 API/DB 全区域已深审 |
| worker/sandbox/core | `packages/worker/src`、`packages/sandbox/src`、`packages/core/src` | 进行中 | D/E 独立 review 通过；review 30/30 + reconcile 9/9；worker typecheck/biome 通过；agent-md 测试 a134 通过；SDK 独有镜像 verbose 10/10；restore 已验收（Opus `a3d703`；主会话 42 passed）；build 测试 `bquo` 15 passed / a568 通过；native/sandbox-probe 队列已由独立 Opus `aa19` 通过并验收（红 2 failed / 10 passed ×3、绿多轮 12/12）；不代表全区域已深审 |
| web 交互 | `packages/web/src` | 已修复 | knowledge 三项与 navigation 已闭环；chat 历史 E2E review aa5 通过；滚动 Opus a12 通过、主会话 89 passed |
| knowledge | `packages/worker/src/knowledge`、相关 API/web/domain 文档 | 进行中 | 审查返回 2 项：cancel 与 queue 重投均已验收；页面三项已闭环；knowledge guard 测试配置缺口已修（`bvn` 3 passed / a0b）；不代表 knowledge 全区域审通过 |
| 运行保留与附件清理 | `packages/db/src/repo/maintenance.ts`（`pruneRuns` / `pruneOrphanMessages`）、`packages/worker/src/maintenance.ts`、chat 附件与成果清理相关 API / 测试 | 进行中 | 成果保留期已由独立 Opus `a97` 通过并验收（红 3/3、绿 6 files / 79 passed）；仍不代表该区域全量审过 |
| 运维与配置 | `docker-compose.yml`、`Dockerfile`、`scripts/`、`e2e.config.ts`、`vitest.config.ts`、`pnpm-workspace.yaml`、`docs/OPERATIONS.md` | 进行中 | 安全文档最终复核通过（abf3）；OPS 恢复新增段复核 `a146` 通过（原 `ac403` 四事实已修）；schedule 两项已验收（a450 / a7c；a573 复核；`bxb` 31 passed），仍仅两项切口，不代表完成运维审查 |
| eval 执行链 | `packages/api/src` eval、`packages/worker/src` eval-runner 及必要 repo / tests | 进行中 | 两项已修并验收（Opus `a1ba`；主会话 `bdxq197ci` 5 files / 37 passed / 0 skipped）；队列 mock，不声称真实 Redis / worker 故障链路；仅切口，不代表全 eval 深审 |
| 导入与插件官方能力 | 导入链路、插件/技能官方文件能力与 `.claude` 目录约定 | 进行中 | 插件 paths 已验收（Opus `a3c50`、主会话 13 tests）；permissions 已验收（Opus `ae3`、主会话 `b9g1fl3ks` 7 files / 89 passed / 0 skipped）；非完整插件审计；B/C 只覆盖专家包导入导出边界 |
| 共享契约与规范 | `packages/shared`、`tests/`、`CLAUDE.md`、`docs/` 规范一致性 | 部分完成 | 规范文档与两处表述 review 通过（af217）；A 的 shared 技能路径整合通过独立 review；shared 全量审查待后续轮换 |

## 改动文件

本轮仅文档收尾，不改源码；用户已授权最终提交 PR 与合并。最终验证已全绿、`origin/main 5ccf9d4` 已合入且 merge 提交 `28a88a3` 已推送，Opus 集成 review `aa582` 已通过；当前已验证、准备推 PR 合并：

- `docs/tasks/codebase-review-loop.md`（本记录）
- `docs/tasks/codebase-review-queue-events.md`（review 状态与 EOF 空行）
- `docs/tasks/codebase-review-output-retention.md`（review 状态与 EOF 空行）
- `docs/tasks/codebase-review-schedule-time.md`（局部约束表述与 EOF 空行）
- 前序文档更新：`docs/tasks/codebase-review-knowledge-server-test.md`、`docs/PITFALLS.md`

不改源码、其他测试或其他文档；队列与成果保留修复文件只由各自作者与子记录维护。

其他作者（证据只由对应记录维护）：

- A（6 files）：`packages/shared/src/agent.ts`、新增 `packages/shared/test/skill-resource-paths.test.ts`、`packages/db/src/repo/skill-files.ts`、`packages/db/src/repo/skills.ts`、`packages/api/test/skills.test.ts`、`packages/api/test/market-install.test.ts`
- B/C：`packages/api/src/features/agent-package.ts`、`packages/api/test/agent-package*.test.ts`（含新增 `agent-package-export-limits.test.ts`）
- D/E：`packages/worker/src/index.ts`、`packages/worker/test/run-runtime-identity.test.ts`
- knowledge cancel：`packages/worker/src/knowledge/ingestion.ts`、`packages/worker/test/knowledge-ingestion.test.ts`
- knowledge queue：`packages/worker/src/knowledge/queue.ts`、`packages/worker/test/knowledge-queue.test.ts`（已验收）
- thinking：`packages/db/migrations/0042_curious_pet_avengers.sql`、`meta/0042_snapshot.json` 及子记录所列源码 / 测试；迁移只在临时库执行
- agent-md：`packages/core/test/agent-md.test.ts`（已验收）
- SDK 镜像：本任务独有镜像与 `.tmp/codebase-review-sdk-image/*`，不改源码 / 测试；见子记录
- restore：`scripts/restore.sh`、`scripts/backup.sh`、`scripts/backup-lib.sh`、`packages/worker/test/backup-script.test.ts`（已验收），具体边界见子记录
- eval：`packages/worker/src/eval-runner.ts`、`packages/worker/test/eval-snapshot.test.ts`、新增 `packages/worker/test/eval-result-write.test.ts`（已验收）
- schedule-save：`packages/api/src/features/ops/routes.ts`、`packages/api/test/schedule-routes.test.ts`（已验收）
- schedule-time：`packages/worker/src/scheduler.ts`、`packages/worker/test/schedule-scheduler.test.ts`（已验收）
- build 测试：`packages/worker/test/runtime-environment-build.test.ts`（已验收，生产代码未改）
- knowledge guard：`packages/api/test/knowledge-server-guard.test.ts`（已验收）
- native/sandbox-probe 队列：`packages/api/src/features/plugins/native.ts`、`packages/api/src/features/servers/sandbox-probe.ts`、`packages/api/test/native-queue.test.ts`、`packages/api/test/sandbox-probe.test.ts`、新增 `packages/api/test/queue-events-gate.ts`（已验收；独立 Opus `aa19`）
- 成果保留：`packages/core/src/outputs.ts`、`packages/db/src/repo/maintenance.ts`、`packages/worker/src/maintenance.ts`、`packages/worker/src/index.ts`、对应测试与新增 `packages/api/test/output-retention.test.ts`（已验收；独立 Opus `a97`）
- web：文件边界见各子记录
- 生成物：`.vitest/json/output.json`，由本任务测试生成且仍在被并行测试改写，待统一收尾

## 下一步

- eval 两项已验收（Opus `a1ba`；主会话 `bdxq197ci` 5 files / 37 passed / 0 skipped），结果见子记录，不据此写全 eval 通过。
- schedule 两项已验收（a450 / a7c 业务 review；a573 测试顺序复核；主会话 `bxb` 两文件 31 passed / 0 skip）。
- 已按子项验收：build 15（a568）、knowledge guard 3（a0b）、schedule 31（a450 / a7c + a573 / `bxb`）、eval 37（a1ba / `bdxq197ci`）、queue 12/12（aa19）、成果保留 79（a97）；最终全量已包含这些用例并全绿（backend 241 / 2340、web 115 / 1291），历史 2314 只作历史。
- 运行保留 maintenance（`a97`）与 native/sandbox-probe 队列（`aa19`）两修复均已通过独立 Opus review 并验收，最终全量已含其用例。
- 最终全量：backend `b0eg5ns1j` 241 files / 2340 passed / 0 skip / exit 0（日志 `tool-results/bd2s74p96.txt`）；web `bo6hv0cif` 115 files / 1291 passed / 0 skip / exit 0；typecheck `bbi`、build `bw1` exit 0。`agent-package-runtime-environment` 计数修正 Opus `a2c` 通过。历史 239 / 2314 只作历史。
- PR 正文 `.tmp/codebase-review-pr-body.md` 已按最终事实修订（事件流回放、部分回滚边界、真实 SDK 未测边界），可直接用于推 PR。
- 扩审已停止：`d1cce124` 已删除且 CronList 无任务，不重建 loop，不再新增领域轮换。
- repo 旧注释已改：`packages/db/src/repo/eval.ts` 第 216 行现说明「子 run 创建前失败才为 NULL」，`packages/db/src/repo/ops.ts` 第 92 行现说明「本轮计划时刻 prevMillis」。
- 保留限制：真实模型调用、SDK hook 实际调用、跨机器灾难恢复演练、eval 真实 Redis / worker 故障链路均未验证；schedule 测试未覆盖真实 worker 停机时序；native/sandbox-probe 的受控窗口不等于历史失败唯一归因。
- permissions 已验收，但迁移 0042 仍未应用到共享库；部署需正常执行 `pnpm db:migrate`。
- `origin/main 5ccf9d4`（含品牌蓝）已合入，merge 提交 `28a88a3` 已推送；main 品牌蓝 / 发送 solid / 终态等待修复完整保留，不修改设计文档 token。
- `.vitest/json/output.json` 等生成物仍被并行测试改写，待统一收尾。
- 提交 `39cd98a` 已完成，`origin/main 5ccf9d4` 已合入、merge 提交 `28a88a3` 已推送；Opus 集成 review `aa582` 已通过；当前已验证、准备推 PR 合并（用户已授权），尚未创建 PR 或确认远端合并结果。

## 验证

主会话已执行的环境与基线命令（真实执行记录）：

- `pnpm install --frozen-lockfile` → exit 0
- `pnpm --filter @agentport/shared --filter @agentport/core --filter @agentport/db build` → exit 0
- `pnpm typecheck` → 全 7 个包 exit 0（最终 `bbi`；历史 `b352`）
- `pnpm lint:focus` / `pnpm lint:contract` 合并前通过；合并后主会话再核 focus / contract 通过；`git diff --check` 无输出
- `docker info` → 服务端 29.9.2 可用
- 历史 backend：`SANDBOX_IMAGE=agentport/sandbox:review-loop-610bd2 pnpm exec vitest run --project backend --hookTimeout 300000 --reporter=default` → 239 files / 2314 passed / 0 skip / exit 0（含 backup 42、plugin-permissions 4、SDK 10；完整原始日志 `bdo1m1z6g`）。该镜像只是本地测试环境，不是部署要求。
- 历史 web：115 files / 1277 passed / 0 skip / exit 0（`b9ieic9n9`），早于本批 eval / scheduler。
- 最终 backend：`b0eg5ns1j` 241 files / 2340 passed / 0 skip / exit 0（完整日志 `tool-results/bd2s74p96.txt`），含 queue（aa19）、成果保留（a97）与 `agent-package-runtime-environment` 计数修正用例。
- 最终 web：`bo6hv0cif` 115 files / 1291 passed / 0 skip / exit 0。
- 最终 typecheck：7 个包 `bbi` exit 0；build：`bw1` exit 0（仅 chunk >500KB 提示，无性能结论）。

集成证据（历史）：

- 旧 web 114 files / 1268 passed 以及早先 110 files / 1257 passed 都是 knowledge 补修与 skill 新增之前的集成证据，只作历史；本批最终 web 为 115 / 1291（`bo6hv0cif`），早先 115 / 1277 只作历史。

各修复的当前证据：

- A：独立 review 通过；主会话 8 files / 147 passed / 0 skipped。A 前端共享 schema 管道独立 review 通过；主会话 4 files / 45 tests 通过。
- B/C：独立 Opus review 通过；专家包临界 4 MiB 反例已覆盖。
- D/E：独立 Opus review 通过；review 30/30、reconcile 9/9；worker typecheck/biome 通过；联合测试通过。已知限制：最后一次 `publishRun` 失败会回退 `queued` 但已无重试，回退自身失败则停在 `running`；对账通常 15–20 分钟收敛，不是保证期限。
- knowledge 页面：主会话复跑 2 files / 132 passed / 0 skipped，exit 0；独立 Opus 限定复核 a4aed 通过。
- navigation：独立评审通过；主会话 8 files / 50 tests、共享 schema 整合 4 files / 45 tests 通过；ToolFormUI 记录误述已修正并复核。
- knowledge-cancel：主会话完整 `knowledge-ingestion` 37 passed / 0 skipped、exit 0（输出任务 `bgd3kic5p`）；独立 Opus a3a79 通过；首次摄取取消落 `failed`，已有版本取消保持 `ready`，旧版本与 chunks/向量保留。已验收。
- knowledge-queue：独立 Opus a6fe 通过；主会话 `b98hhx2wc` 真实重跑 4 files / 25 passed / 0 skipped / exit 0。测试模拟 stalled 重投入口，未实测 kill 进程；依赖既有 reconcile 恢复（通常 6–11 分钟），限制保留。已验收。
- chat：源码缓存修复静态 review 认可；历史 E2E 补修 review aa5 通过；run4/5 各 8 passed / 1 failed，清理无残留；分页滚动根因已确证，独立 Opus a12 通过，a12 核实原始最后两轮 auth + history 各 9/9 与清理；精确 `075 / 025 top60 → 60` 仅来自诊断轮逐帧，最后两轮无逐帧输出、以几何断言通过，证据不混写；主会话 `b6mx7cwdi` chat-scroll / chat-ux / chat-stream 3 files / 89 passed / exit 0；E2E 由作者真实运行、a12 核实，主会话未另跑。
- thinking：代码 / 测试 / 迁移独立 Opus a06 通过；主会话 `bjge` 真实 9 files / 168 passed / 0 skipped，`bgh` agentsUI 41 passed；迁移只执行随机 / 临时库；产品文档同步由 Opus ac822 复核通过。
- agent-md：主会话 `bg64` 12 tests 通过；独立 Opus a134 通过；代码由 Sonnet 执行。
- SDK 镜像：独有镜像 `agentport/sandbox:review-loop-610bd2` verbose 真实 10/10、无 skip；无残留容器；已验收。
- restore：最终验收 Opus `a3d703` 通过；主会话 `byw28qy0g` 完整 42 passed / 0 skipped / exit 0（原始输出 `rtk recall 278485a1b40f3648`）；`bash -n` 与对应 `git diff --check` 通过；普通 URL 真实 PG 演练通过，特殊字符 URL 仅 stub 往返（Opus `/bin/bash` 两端各 782 组合），无真实特殊密码账户连接。
- plugin-paths：独立 Opus `a3c50` 通过；主会话 13 tests 通过。
- plugin-permissions：独立 Opus `ae3` 通过；主会话 `b9g1fl3ks` 7 files / 89 passed / 0 skipped；覆盖 API 存储、ZIP 往返与 render、按 worker 规则临时落盘执行，不声称真实 worker / SDK hook 调用。
- eval：独立 Opus `a1ba` 通过；主会话 `bdxq197ci` 真实 5 files / 37 passed / 0 skipped，覆盖 worker eval snapshot、真实 PostgreSQL 定向写故障、API eval / enqueue-failure / cancel；写失败批次 `failed` + `error` 且 passed 不虚增，已创建子 run 的失败仍关联真实 `runId`，每 case context 隔离；队列为 mock，不声称真实 Redis / worker 故障链路。
- schedule-save：作者红 `1 failed / 14 passed` → 绿 15/15；Opus `a450` 业务 review 通过；最终测试顺序 `a573` 复核通过，主会话 `bxb` 两文件 31 passed / 0 skip。限制：未覆盖真实 worker 停机 5/10 分钟时序。
- schedule-time：作者红 1 条失败（`lastRunAt` 差 249250ms）→ 绿 16/16 连跑 3 次；Opus `a7c` 业务 review 通过；`a573` 测试顺序复核通过，`bxb` 同上 31 passed / 0 skip。
- build-test：`runtime-environment-build` 改为明确 `buildxStarted` 信号 + `Promise.race` + 子进程 `close/await`；主会话 `bquo` 15 passed，Opus `a568` 通过；未改生产代码。
- knowledge-guard：测试 app 改用 `testConfig()`，用生产 `createServer` 预置正常加密记录；主会话 `bvn` 3 passed，Opus `a0b` 通过；见子记录。
- queue-events：红 3 轮 2 failed / 10 passed（完成通知被 `$` 跳过、2s 预算内失败），绿多轮 12/12；api typecheck + biome 通过；独立 Opus `aa19` 通过，已验收。
- output-retention：旧实现 3/3 失败（删除来源后分支下载 404），绿 6 files / 79 passed；四包 typecheck/build、biome 通过；独立 Opus `a97` 通过，已验收。
- 规范两处修正（文件资源校验入口、正文大小限额与 ZIP 安全统计）已落入 `docs/DEV-WORKFLOW.md`，独立 Opus af217 复核通过：各独立入口分别校验；正文 UTF-8 与 ZIP max 统计分别保留。
- 安全文档：`ARCHITECTURE.md` / `OPERATIONS.md` / `SECURITY.md` 的模型 token 条件表述最终复核通过（abf3）。
- OPS 恢复新增文档：独立 Opus `a146` 复核通过，原 `ac403` 四事实已修；恢复代码 42 tests 与独立 review 证据不变，未重跑。
- 规范文档事实核对同前：`.mcp.json` 清理失败会禁止复用并销毁容器，但持久工作区文件可能留到下一轮刷新；模型 token 的内存移除不保证独立于 DB 立即失效；对账是常态时延而非保证期限。
- 本次文档改动后执行 `git diff --check` → 无输出；未跟踪记录（本记录、`codebase-review-knowledge-server-test.md`）分别用 `git diff --no-index --check -- /dev/null <file>` 检查 → 无 whitespace 输出（`/dev/null` 对比必然报告内容差异，非 whitespace 错误）；`docs/PITFALLS.md` 的 `git diff --check` 亦无输出。
