# 会话级沙盒生命周期（任务记录）

## 目标

解决同一长对话每轮都新建并立即销毁沙盒容器的问题：同一 Session（平台会话/长对话）短期复用同一个独立容器，避免重复的容器创建、启动与销毁，并保留容器内的临时环境；空闲 5 分钟后由 worker 现有沙盒模块回收；回收后下一轮仍能从宿主持久状态恢复同一 SDK 会话。

本任务**不承诺降低 SDK 冷启动**：容器复用不会跳过每轮新建的 SDK query，SDK 进程与查询仍会在每轮重新启动。因此收益与验收只针对容器生命周期，不把“降低 SDK 冷启动”写成目标或指标。

验收以行为为准：同一会话多轮复用、不同会话隔离、取消后仍可续用、空闲回收后可 resume、每轮身份与成果边界不串、试连与关停不回归。**截至 2026-10-29：上一轮 runtime 与 integration 已实现并稳定，session manager、supervisor、core 限定 review 与取消链路独立复审均通过；上一轮联合回归 root backend 38 files 458 passed / 0 failed / 0 skipped（含 12 个真实 Docker/SDK 用例）仅作更早的历史基线。本轮按用户授权修复复核项 1+3/4/5/7（2/6 保留）；复核项 1 首修后又被独立 review 发现 `deleteEntry → create` 的 microtask 空档（原 Node probe 确定可复现），已最小修复；manager 36 passed、主会话 root 局部 7 files 112 passed / 0 failed / 0 skipped。此前记录的 109 passed 与真实 Docker/SDK 12 passed 是中间版本证据，已被最终结果取代。**最终结果（2026-10-29 收尾）：真实 Docker/SDK 共 12 passed / 0 failed / 0 skipped（Docker 8 + SDK 4，`/tmp/session-review-handoff-live-final.json`）；主会话 root 局部 7 files 112 passed / 0 failed / 0 skipped（`/tmp/session-review-handoff-validation.json`）；独立 final Opus review 明确通过，新增 handoff 校验无遗漏；shared/worker build 与 typecheck、6 个 TS 文件 Biome、diff check 均通过；测试后 docker 无遗留测试 container/image，无 tracked Vitest 报告差异。本轮实现无待办。用户最新已明确授权 commit / push / PR / merge 且不等待 CI；截至本记录更新尚未执行这些操作，本记录不宣称已提交或合入 main。**

## 方案

复用协议已固定，无需用户再次确认。当前有效方案：

- **复用粒度**：一个平台会话最多一个独立容器；同一会话的连续 run 短期复用，不在 run 正常完成或成功取消时立即销毁。
- **运行结构**：轻量驻留 supervisor + 每轮 runner。容器内 supervisor 常驻并接收下一轮任务，每轮启动新的 runner 执行；不新建沙盒池、快照服务、新 provider 或独立部署服务。
- **worker 生命周期**：新增 `SessionSandboxes` 负责会话级容器的 `acquire` / `release` / `close`；底层沿用 `DockerSandboxProvider`，由 worker 现有沙盒模块按 5 分钟空闲回收。
- **目录与挂载**：`/workspace` 与 `/mnt/outputs` 改为会话级稳定目录，`/mnt/inputs` 始终挂载；不在轮间热替换 bind mount。
- **数据性质**：持久数据只有 `agent-memory/`、`sdk-sessions/<conversationId>/`、`conversation-outputs/<conversationId>/` 与 `conversation-inputs/<conversationId>/`；`session-sandboxes/<conversationId>/{workspace,outputs}` 是可再生的派生缓存（workspace 每轮从数据库重渲染，outputs 停稳后复制进 conversation-outputs），容器回收或关停不删除它，但不把它当作不可丢失的持久交付。
- **每轮凭证**：MCP token、模型代理 token、`.mcp.json` 等每轮凭证写入新启动的 runner；运行结束时不论容器清理是否成功都吊销本轮 token，终态停稳后删除 `.mcp.json`，避免把上一轮身份带进下一轮。
- **成果边界**：core 的 `captureOutputDraft` 把本轮草稿捕获到原 run 草稿，保留旧 snapshot 语义，不因容器复用覆盖上一轮成果。
- **收尾顺序**：先完成消息/成果收尾，再释放会话容器；正常完成与确认 stopped 的取消复用容器，无法确认停稳（unconfirmed）则销毁。
- **一次性路径不变**：`sandbox-probe` 与 `native-plugins` 仍使用一次性容器，不进入会话复用。

## 基线与范围

- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/session-sandbox-lifecycle`。
- 起点：`6b6b3f1d9cb903ab4ad67306d41a3cf1b8288914`，与 `origin/main` 一致。
- 进入会话时 `git status` 为空。落笔前复核出现 `M .vitest/json/output.json`；已确认归属为 Vitest 自动生成的报告产物，不是本任务改的业务文件。测试结束后主会话核对 diff 确认该报告由本任务运行生成，已用 `git restore` 恢复，`git diff --quiet` 通过。本轮报告统一写到 `/tmp`，无 tracked Vitest 产物污染。
- 用户已授权整体实现。上一轮记录时**未授权 commit / push / merge**，该描述为历史截至上一轮；用户最新已明确授权 commit / push / PR / merge，且不触发、不等待 CI，当前有效授权见“授权边界”与“下一步”。此前“本轮只写记录”是记录子任务的边界，不是整体任务授权。
- 上一轮（2026-10-29，复核修复）只更新本记录与 `docs/OPERATIONS.md` 的 `SANDBOX_MAX_FIELD_BYTES` 一行，当时不改其它文件、不提交（历史，截至上一轮；当前授权已更新，见“授权边界”）；实现与测试由并行代理及主会话完成。上一阶段文档收尾曾更新本记录、`docs/ARCHITECTURE.md`、`docs/OPERATIONS.md`、`docs/HANDOFF.md`，保留为历史记录。

## 当前有效决定

1. 同一平台会话短期复用独立容器；不把复用扩大到跨会话共享。
2. 采用轻量驻留 supervisor + 每轮 runner：容器常驻，每轮新建 runner 执行，不重建容器。
3. worker 新增 `SessionSandboxes` 管理 `acquire` / `release` / `close`；底层沿用 `DockerSandboxProvider`，由 worker 现有沙盒模块承担空闲回收，默认 5 分钟（已由用户确认为本项目默认值）。
4. `/workspace`、`/mnt/outputs` 为会话级稳定目录，`/mnt/inputs` 始终挂载；每轮凭证写入新 runner，不热改挂载。稳定目录是可再生派生缓存，持久数据仍是 `agent-memory/`、`sdk-sessions/`、`conversation-outputs/` 与 `conversation-inputs/`。
5. core 的 `captureOutputDraft` 捕获到原 run 草稿，保留旧 snapshot；轮间不覆盖上一轮成果。
6. 释放在消息/成果收尾之后；正常完成与确认 stopped 的取消复用容器，无法确认停稳时销毁。
7. 持久状态留在宿主，容器可替换。
8. 只用现有 Docker 与现有沙盒模块；不加池、快照、新 provider 或独立服务；`sandbox-probe` 与 `native-plugins` 保持一次性。
9. 协议、停稳判据、凭证/挂载刷新、空闲计时与重启/关停方向均已固定；上一轮 runtime 与 integration 已实现并稳定，session manager、supervisor、core 限定 review 与取消链路独立复审均通过。本轮复核项 1（含 handoff 空档）与 3/4/5/7 已修复并通过本地验证；最终真实 Docker/SDK 12 passed / 0 failed / 0 skipped，独立 final Opus review 明确通过，本轮实现无待办。

## 已替代项及原因

- 原实现：每次 run `docker create/start -ai` 一次，Scoped `destroy` 在终态后立即 `stop --time 5` + `rm -f`。该行为适合一次性任务，与本任务“同会话短期复用”目标冲突，现已由会话复用路径替换；`sandbox-probe` 与 `native-plugins` 的一次性路径保留。
- 不采用“所有 provider 统一 5 分钟”的外部说法：已核对来源不支持该结论，见官方依据。

## 官方依据（2026-10-28 核对）

- Claude Agent SDK 自托管：[Hosting the Agent SDK](https://code.claude.com/docs/en/agent-sdk/hosting)。要点：一个 session 对应一个 `claude` 子进程；transcript、memory 与工作目录默认在容器本地，容器重启/迁移即丢失；混合模式建议按用户回访频率调整 provider idle timeout，并用 `SessionStore` 或持久卷保留状态。
- 官方 hosting cookbook 的可部署代码：[claude-cookbooks/claude_agent_sdk/hosting](https://github.com/anthropics/claude-cookbooks/tree/main/claude_agent_sdk/hosting)（Docker、Modal、Kubernetes）。
- Modal Sandboxes：[Sandbox guide](https://modal.com/docs/guide/sandboxes)。sandbox 生命周期与 idle timeout 为可配置项；该页不能作为“所有 provider 统一 5 分钟空闲回收”的依据。
- OpenHands Docker workspace 实现：[workspace.py](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-workspace/openhands/workspace/docker/workspace.py)，供参考容器生命周期处理。
- **非统一五分钟事实**：以上核对来源均未给出“所有 provider 统一 5 分钟空闲回收”的结论；本项目的 5 分钟是自身确认的默认值，不是外部平台共识。

## 本轮关键发现（2026-10-29）

1. **supervisor P1：stdio 继承时等 `close` 会死锁**。已改为 `exit` 先触发后代清理，再排空/结束输出管道并确认 settled；`close` 不再作为收尾起点。
2. **supervisor P2：超限帧必须显式失败**。超过输入上限的帧不再静默丢弃，按协议显式报错。
3. **manager 生命周期收口**：重复 `release` 返回第一次的同一个 Promise，不冒充已停稳；idle 回收与 attach/close 路径确认 `destroy` 收口；ready 等待由统一调用方 30 秒预算约束，signal 中断不重复计时。
4. **测试产物来源**：真实 Docker/SDK 测试每轮从当前源码独立临时编译并记录 source hash，不再复用 `dist`。本轮 shared `200b2316…`、sandbox `4933b87f…` 与当前源码一致；2 suites 12 passed / 0 skipped（Docker 8 + SDK 4，`/tmp/session-sandbox-current-source-live.json`）。
5. **真实进程清理（随后）**：fixture 改为两个后代分别继承 stdout/stderr、root 显式 exit；真实 Linux 8 passed（`/tmp/session-docker-inherited-stdio.json`），证明 detached、同进程组且 ppid=1 的后代仍持有管道时不会续写，容器可正常复用。
6. **review 修复联合验证**：root review fix 6 suites 113 passed（`/tmp/session-sandbox-review-fixes-validation.json`）；取消链路最终 8 files 82 passed / 0 skipped（`/tmp/session-sandbox-cancellation-final.json`）。integration 22 files 269 passed 与 boundaries 10 files 88 passed 是早期回归基线，属不同阶段范围，**不累加；458 是上一轮联合回归基线**。
7. **取消链路复审修复已完成**：runtime budget 覆盖取消订阅与 EXISTS 补查；EXISTS=1 以及 acquire 前已 abort 的分支都不会创建 manager 或启动 runner；订阅 Promise 晚到或中断后不再补发 EXISTS；question poll 失败按 infra 重试；`RunFailure.message` 直接作为可读 error（不再出现 `[object Object]`）。取消/超时 outcome 的 metadata 保留已上报的 sessionId 与费用。
8. **文档同步**：多份 docs 已按实现更新；命令中的容器名前缀修正为 `pace-session`；`AGENT_TIMEOUT_MS` 误写成执行超时的问题已修正（它只用于孤儿 run 对账）。稳定目录与持久数据的范围已统一为“派生缓存 vs 持久数据”。
9. PITFALLS 已有对应两条记录（Node 子进程 `exit`/`close` 不能混用、真实容器测试可能加载旧 dist）；本轮不改该文件。
10. **上一轮最终联合回归（2026-10-29）**：主会话在 root backend 跑 38 个文件，**458 passed / 0 failed / 0 skipped**，报告 `/tmp/session-sandbox-final-regression.json`；其中 12 个为真实 Docker/SDK 用例（Docker 8 例使用新版继承 stdio fixture，SDK 4 例 + 本地假 Anthropic SSE）。`pnpm typecheck`、`pnpm build`、31 个 TS 文件 Biome、lint focus、contract 与 `git diff` 检查均通过；测试结束后 `docker ps` 无 `pace-session` 残留。旧阶段数字只作过程证据；458 是上一轮联合回归基线，本轮结果另记，不累加、不替换。

## 复核整理、恢复与 handoff 修复（2026-10-29，未提交）

复核 7 项里只有第 1 项是实际恢复缺口，2/6 经裁决保留不改，3/4/5/7 属整理，不把 7 项都说成 bug。本轮按用户授权修复 1+3/4/5/7。此前 review 结论：1 需要修；3/4/5/7 整理已过；2/6 保留。

- **1 恢复缺口（已修复）**：上次销毁失败的 `broken` 条目在下一次 `acquire` 时独占重试一轮销毁旧容器，确认删除成功后才在同一批目录上重建；仍失败则继续保留跟踪并让该请求失败，不新建容器。没有后台定时重试；`acquirePending` 保证同一会话同时只有一个 acquire，`close`/abort 都不触发新建。
- **1 后续 handoff 空档（已最小修复）**：独立 review 发现首修在 `deleteEntry` 到 `createEntry` 之间留下 microtask 空档，并发 `acquire` 可在空档内再建一个容器（原 Node probe 确定可复现；新增测试先红：同一竞态产生 3 个容器、期望 2 个）。修法：`performDestroy` 用 `acquirePending` 保留占位，`createEntry` 检查并替换 owner 后同步替换；`broken`、spec change、idle join 三条路径同修；`cancel` / `close` 成功销毁后移除空壳。没有新增 timer 或锁。
- **2 异常 exit 策略**：保留，不改。
- **3 计算复用（已完成）**：`runner-client` 的 `onEvent` 只做一次 `Buffer.byteLength`，同一个 `bytes` 同时用于行上限与瞬时/落库额度，语义不变。
- **4 输入帧类型（已完成）**：shared 新增 `SupervisorInputFrame = z.input<typeof supervisorInputSchema>`，发送方可以用 defaults 可省略的形状；解析后的 `SupervisorInput` 不动。类型级断言用 `expectTypeOf` 固定在 shared 测试里。
- **5 常量复用（已完成）**：`runner-client` 删除本地 `MAX_LINE_BYTES`，改用 shared 的 `SUPERVISOR_INPUT_MAX_BYTES`；8MiB 与两类额度语义不变。
- **6 `startup_timeout` 销毁**：保留，不改。
- **7 注释（已完成）**：worker `index.ts` 的 `outputsHostPath` 注释改成说明它只表示本 run 草稿的准备路径/是否完成，与是否新建容器无关；不改变量名、不扩变量。
- **本轮验证（已通过）**：实现前红测 33 tests / 7 failed，实现后同范围 33 passed；handoff 精准测试 3 例先红（creates 3 / expected 2），修后 manager 36 passed；主会话 root 局部 7 files **112 passed / 0 failed / 0 skipped**（`/tmp/session-review-handoff-validation.json`）；最终真实 Docker/SDK **12 passed / 0 failed / 0 skipped**（Docker 8 + SDK 4，`/tmp/session-review-handoff-live-final.json`）；独立 final Opus review 明确通过（新增 handoff 校验无遗漏）；shared/worker build 与 typecheck、6 个 TS 文件 Biome、diff check 通过；测试后 docker 无遗留测试 container/image，无 tracked Vitest 报告差异。中间版本的 root 109 passed（`/tmp/session-review-recovery-final.json`）与真实 Docker/SDK 12 passed（`/tmp/session-review-recovery-live.json`）只作过程证据，已被最终结果取代。上一轮 458 是更早基线，本轮数字不累加、不替换。

## 现状与真实风险

- **上一轮基线与本轮状态**：上一轮 runtime（shared/supervisor/runner）与 worker integration 已实现并稳定；session manager、supervisor、core 限定 review 与取消链路独立复审均通过；上一轮联合回归 38 files 458 passed / 0 failed / 0 skipped 保留为更早基线。本轮复核项 1 两次修复（恢复重试 + handoff 空档）与 3/4/5/7 整理已完成并通过最终验证：root 局部 7 files 112 passed、真实 Docker/SDK 12 passed（均 0 failed / 0 skipped），独立 final Opus review 明确通过，本轮实现无待办。
- **取消链路**：runtime budget 已覆盖取消订阅与 EXISTS 补查；EXISTS=1 与 acquire 前已 abort 都不会创建 manager 或启动 runner；订阅 Promise 晚到/中断后不再补发 EXISTS；question poll 失败按 infra 重试；`RunFailure.message` 作为可读 error。最终独立复审 39 tests + 5 extra probes + 3 index asserts 通过；早期 8 files 82 passed 与 boundaries 10 files 88 passed 属不同阶段范围，只作过程证据。
- **每轮凭证与挂载**：会话级稳定目录 + 每轮凭证进新 runner 已实现；`/workspace`、`/mnt/outputs` 稳定，`/mnt/inputs` 常挂。运行结束即吊销本轮 token（不论容器清理是否成功），终态停稳后删除 `.mcp.json`；稳定 session 目录是可再生派生缓存，持久数据是 `agent-memory/`、`sdk-sessions/`、`conversation-outputs/` 与 `conversation-inputs/`。
- **取消分支与 metadata**：取消分支 sessionId 丢失已修复并有测试覆盖（cancel sessionId、query close）；取消/超时 outcome 的 metadata 保留已上报的 sessionId 与费用。
- **超时语义**：执行超时取 `agent.timeoutMs`；`AGENT_TIMEOUT_MS` 只用于孤儿 run 对账（queued run 超窗口 + 5 分钟宽限且确认 job 消失/终态才置 failed；running run 用智能体当前 `timeout_ms`），不是执行超时。docs、`.env.example` 与 `config.ts` 注释已按此修正。
- **容器命名与记录**：容器名使用 `pace-session-<random>`；`SessionSandboxes` 维护会话级身份与 per-run 映射，`agent_runs.sandbox_id` 落库当前会话容器 id（`outcome.sandboxId`）。
- **空闲回收**：`acquire` / `release` / `close` 与 idle 回收已实现；真实 Docker fixture 覆盖 idle 后新容器从宿主 state 恢复、busy 不回收与 close；idle 销毁中 acquire 等销毁收口后再重建。销毁到重建之间的空档由 `acquirePending` 占位，`createEntry` 替换 owner 后同步替换；broken / spec change / idle join 同一修法，`cancel`/`close` 成功销毁后移除空壳。销毁失败时保留跟踪并阻止复用，下一次 acquire 独占重试清理，确认旧容器删除后才重建，仍失败则该请求失败，无需重启 worker。
- **试连与插件动作**：`sandbox-probe`、`native-plugins` 仍一次性，不进入会话复用；已由上一轮套件覆盖，不回归。
- **未测范围**：真实付费模型与浏览器全链路未测。容器复用只省缓存镜像下约 122ms 的创建/启动基线，不承诺 SDK 冷启动加速。
- **验证口径**：上一轮联合回归 38 files 458 passed / 0 failed / 0 skipped（`/tmp/session-sandbox-final-regression.json`）是更早基线，本轮不重跑全量、不声称本轮全量通过。本轮以 root 局部 7 files 112 passed（`/tmp/session-review-handoff-validation.json`）与真实 Docker/SDK 12 passed（`/tmp/session-review-handoff-live-final.json`）为准，独立 final Opus review 明确通过；三组数字分属不同范围，不累加、不替换 458。

## 步骤

- [x] 记录基线、授权边界、当前有效方案与官方依据（本文件）。
- [x] 本机基线与现有回归：安装依赖、构建 shared/core/db、跑沙盒相关 Vitest、测量容器与 CLI 启动开销（见“验证”）。
- [x] 固定复用协议：supervisor + 每轮 runner、`SessionSandboxes`、会话级稳定目录、每轮凭证、成果捕获与收尾顺序（见“当前有效决定”）。
- [x] 先写/补齐行为测试（已完成范围）：两轮复用、隔离、取消后续用、idle 恢复、身份/成果边界与 close 已由 shared/supervisor/runner、真实 Docker fixture 与 capture/API 套件覆盖。
- [x] 实现 supervisor 与每轮 runner：任务投递、停稳上报、取消与每轮凭证注入；P1/P2 修复后 4 suite 64 passed（新增 6 例，历史证据）。
- [x] 实现 `SessionSandboxes` 的 `acquire` / `release` / `close` 与 5 分钟空闲回收；manager 套件 28 passed（历史证据）；真实 Docker fixture 覆盖 idle/busy/close，并修复 idle 销毁中 acquire 的竞态。
- [x] 调整 worker run 准备与收尾：会话级容器身份、会话级工作区/草稿、停稳确认、目录清理顺序（实现已稳定）。
- [x] 实现 core `captureOutputDraft` 到原 run 草稿（29 passed，含 rollback 故障注入）。
- [x] 修复取消分支 sessionId 丢失，并覆盖 fork/首次会话的取消场景（runner client 组覆盖）；取消/超时 metadata 保留 sessionId 与费用。
- [x] 保持 docs 与实现一致（生命周期、超时、容器名前缀、持久数据/派生缓存边界已同步）。
- [x] 真实 Docker fixture 与 SDK fake API 已改为当前源码独立临时编译 + source hash，2 suites 12 passed / 0 skipped。
- [x] 修完独立 integration 复审新增 4 项（runtime budget 订阅/EXISTS、EXISTS=1 与预 abort 无副作用、晚到 Promise 不补查、question poll infra 重试、`RunFailure.message` 可读），并复跑对应类型/构建/格式检查。
- [x] 上一轮独立分范围 review：session manager、supervisor、core 限定 review 与取消链路独立复审均通过，已发现阻断项已修复并复核。该轮记录时未授权 commit/push/merge（历史，截至上一轮）。
- [x] 修复复核项 1+3/4/5/7：broken 恢复、`Buffer.byteLength` 复用、shared `SupervisorInputFrame`、8MiB 常量复用、`outputsHostPath` 注释；2/6 保留。实现前 33 tests / 7 failed，修复后 33 passed。
- [x] 修复独立 review 发现的 `deleteEntry → create` microtask 空档：`acquirePending` 占位、`createEntry` 替换 owner、broken / spec change / idle join 三路径同修、cancel/close 成功销毁后移除空壳；3 例 handoff 测试先红后绿，manager 36 passed，root 局部 7 files 112 passed。
- [x] 最新真实 Docker/SDK live 已跑完并回填：Docker 8 + SDK 4 共 12 passed / 0 failed / 0 skipped（`/tmp/session-review-handoff-live-final.json`）；独立 final Opus review 明确通过（含新增 handoff 校验，无遗漏）。本轮实现无待办。

## 执行边界（并行代理）

- **shared + supervisor（实现完成，review 通过）**：协议类型/事件、常驻 supervisor 与每轮 runner；P1 stdio close 死锁与 P2 超限帧已修，4 suite 64 passed（历史证据）。
- **worker session manager（实现完成，review 通过）**：`SessionSandboxes` 的 `acquire` / `release` / `close`、会话级容器身份、5 分钟空闲回收与关停收口；28 passed（历史证据）。
- **core capture（已完成，限定 review 通过）**：`captureOutputDraft` 与原 run 草稿/旧 snapshot 的成果边界。
- **worker integration（实现完成）**：run 准备/收尾接入会话容器、每轮凭证、取消 sessionId 修复与 metadata 保留，以及 probe/plugin 一次性路径不回归；取消链路独立复审通过。
- **取消链路（上一轮复审通过，已复核）**：39 tests + 5 extra probes + 3 index asserts。
- **本轮复核修复（已完成并通过最终验证）**：复核项 1+3/4/5/7 已修复，2/6 保留；handoff 空档最小修复后 manager 36 passed、root 局部 7 files 112 passed；真实 Docker/SDK 12 passed / 0 failed / 0 skipped，独立 final Opus review 明确通过，本轮实现无待办。

## 改动文件

（历史，截至上一轮）复核修复与 handoff 修复只更新 `docs/tasks/session-sandbox-lifecycle.md` 与 `docs/OPERATIONS.md` 的 `SANDBOX_MAX_FIELD_BYTES` 一行，不改其它文件、不提交；实现与测试由并行代理及主会话完成。本轮测试报告均写在 `/tmp`，无 tracked Vitest 产物污染。上一阶段文档收尾曾更新 `docs/ARCHITECTURE.md`、`docs/OPERATIONS.md`、`docs/HANDOFF.md`，保留为历史记录。本次记录更新只改本文件，不改源码或其它文档。

新增文件（按当前实际路径）：

| 路径 | 范围 |
| --- | --- |
| `packages/shared/src/sandbox-session.ts` | supervisor 协议类型/事件 |
| `packages/shared/test/sandbox-session.test.ts` | 协议行为测试 |
| `packages/sandbox/src/session-supervisor.ts` | 容器内常驻 supervisor + 每轮 runner |
| `packages/sandbox/test/session-supervisor.test.ts` | supervisor 启动、投递、停稳、取消与进程收尾 |
| `packages/sandbox/test/fixtures/session-child.mjs` | supervisor 子进程 fixture |
| `packages/worker/src/sandbox/sessions.ts` | `SessionSandboxes` 的 acquire/release/close 与 idle 回收 |
| `packages/worker/src/session-workspace.ts` | 会话级稳定工作区/输出/输入目录 |
| `packages/worker/test/session-runner-client.test.ts` | runner client 会话协议、stdout 顺序、cancel sessionId/query close |
| `packages/worker/test/session-sandboxes.test.ts` | manager 生命周期、idle/busy/close |
| `packages/worker/test/session-sandbox-docker.test.ts` | 真实 Docker fixture（当前源码独立临时编译，8 passed / 0 skipped） |
| `packages/worker/test/session-sandbox-sdk.test.ts` | 真实 SDK + 本地假 Anthropic SSE（当前源码独立临时编译，4 passed / 0 skipped） |
| `packages/worker/test/session-workspace.test.ts` | 会话级目录行为 |
| `packages/worker/test/fixtures/session-task.mjs` | Docker fixture 任务脚本 |

已改动的既有文件（分组，具体细节由对应代理负责）：`Dockerfile`、`docker-compose.yml`、`.env.example`；`packages/worker/src/{config,index,outputs,runner-client}.ts`、`packages/worker/src/sandbox/{provider,docker}.ts` 及对应测试；`packages/shared/src/index.ts`；`packages/sandbox/src/runner.ts` 及测试；`packages/core/src/outputs.ts` 及测试；`packages/api/src/features/chat/routes.ts` 及 `conversations.test.ts`；`docs/{ARCHITECTURE,OPERATIONS,RUNBOOK,SECURITY,USER-STORIES,HANDOFF,IMPL-CONTRACTS,PROJECT-BRIEF,CAPABILITY-GAP,PITFALLS}.md`。

非本任务、不纳入交付：

- `docs/tasks/docker-sandboxes-kit-research.md`：他人未提交、未合 main 的研究记录，保留原样，不纳入本任务交付或验收依据。提交时排除该未跟踪文件；如它存在于本 worktree，清理/收尾不得移动或删除它，worktree 清理与收尾受该文件约束，须待其归属者处置。
- `.vitest/json/output.json` 等测试自动生成的报告产物：不是业务改动；主会话已核对 diff 确认由本任务测试生成，并 `git restore` 恢复，`git diff --quiet` 通过。本轮报告写到 `/tmp/session-review-handoff-*`，不产生 tracked 产物。

授权边界（当前有效）：用户最新已明确授权 commit / push / PR / merge，且不触发、不等待 CI。截至本记录更新尚未执行这些操作，不宣称已提交或已合入 main；上一轮“只实现、未 commit / push / merge”的描述为历史截至上一轮。提交时排除未跟踪的 `docs/tasks/docker-sandboxes-kit-research.md`，且不得移动或删除该他人文件。

## 下一步

- 真实 Docker/SDK 已跑完：Docker 8 + SDK 4 共 12 passed / 0 failed / 0 skipped（`/tmp/session-review-handoff-live-final.json`）。
- 独立 final Opus review 已明确通过（含 handoff 修复与新增校验，无遗漏）；本轮实现无待办。
- 458 passed / 0 failed / 0 skipped 是更早基线，本轮未重跑全量；109 passed / 真实 Docker+SDK 12 passed 是中间版本证据，已被最终结果取代；三组数字分属不同范围，不累加、不替换。
- **当前有效授权与下一步**：用户已明确授权 commit / push / 创建 PR / merge，且不触发或等待 CI、不自动开启 PR 监控。下一步由主会话执行：提交本任务改动（排除他人未跟踪文件 `docs/tasks/docker-sandboxes-kit-research.md`）→ push → 创建 PR → 合并；执行后回填实际 commit / PR / merge 结果，未发生前不伪造。
- **worktree 清理**：合并后删除 worktree 前须确认该 worktree 内他人未跟踪的 `docs/tasks/docker-sandboxes-kit-research.md` 已有归属处置；不得移动或删除该文件，存在该文件时清理受其约束，必要时先报告再由用户处置。
- 真实付费模型与浏览器全链路仍未测，需用户另行授权后展开。

## 验证

复用与空闲回收的实现证据见“本轮关键发现”和“当前验证”。当前证据按阶段列出；旧阶段数字只作过程证据，不累计。

### 当前验证（2026-10-29）

- **上一轮最终联合回归（历史基线）**：root backend 38 files **458 passed / 0 failed / 0 skipped**，报告 `/tmp/session-sandbox-final-regression.json`；其中 12 个真实 Docker/SDK 用例（Docker 8 例为新版继承 stdio fixture，SDK 4 例 + 本地假 Anthropic SSE）。该数字是上一轮全量基线，本轮不重跑全量、不累加、不替换。
- **上一轮检查与 review（历史）**：`pnpm typecheck`、`pnpm build`、31 个 TS 文件 Biome、lint focus、contract 与 `git diff` 检查均通过；测试后 `docker ps` 无 `pace-session` 残留；session manager、supervisor、core 限定 review 与取消链路独立复审均通过，取消链路复审 39 tests + 5 extra probes + 3 index asserts 通过。
- **本轮复核修复与 handoff 修复（最终结果，已通过）**：实现前红测 33 tests / 7 failed，实现后同范围 33 passed；handoff 精准测试 3 例先红（creates 3 / expected 2）、修后 manager 36 passed；主会话 root 局部 7 files **112 passed / 0 failed / 0 skipped**，报告 `/tmp/session-review-handoff-validation.json`；真实 Docker/SDK **12 passed / 0 failed / 0 skipped**（Docker 8 + SDK 4），报告 `/tmp/session-review-handoff-live-final.json`；独立 final Opus review 明确通过（新增 handoff 校验无遗漏）；shared/worker build 与 typecheck、6 个 TS 文件 Biome、diff check 通过；测试后 docker 无遗留测试 container/image，无 tracked Vitest 报告差异。中间版本的 root 109 passed（`/tmp/session-review-recovery-final.json`）与真实 Docker/SDK 12 passed（`/tmp/session-review-recovery-live.json`）只作过程证据，已被最终结果取代。
- **上一阶段复核整理局部验证（历史）**：5 files **74 passed / 0 failed / 0 skipped**（shared `sandbox-session` 6、`runner-client-limits` 10、`runner-client-questions` 10、`session-runner-client` 29、`outputs` 19），报告 `/tmp/session-review-cleanups.json`；上轮 458 仍是联合回归基线，不当作本轮结果。
- 历史阶段证据：当前源码独立临时编译 2 suites 12 passed、真实 Linux 继承 stdio fixture 8 passed、root review fix 6 suites 113 passed、取消链路 8 files 82 passed；这些只作过程记录。
- 真实付费模型与浏览器全链路未测。

### 基线（改造前一次性容器路径，2026-10-28）

- 依赖：`pnpm install --frozen-lockfile` 成功。
- 构建：`packages/shared`、`packages/core`、`packages/db` build 成功（测试解析 workspace 包所需）。
- 首次 Vitest 启动在业务用例前报 `code.charCodeAt is not a function`。不是业务失败，原因是依赖包尚未构建；补齐 shared/core/db 构建后重跑通过。
- 沙盒相关 Vitest：**86 passed / 0 failed / 0 skipped**，5 个文件：`docker-provider.test.ts` 20、`cancel.test.ts` 6、`runner-client-questions.test.ts` 10、`runner.test.ts` 38、`questions.test.ts` 12。
- 额外回归基线：`outputs`、`message-persistence`、`fork-uuids`、`shutdown`、`sandbox-probe`、`native-plugins`、`sandboxprobe` 共 **84 passed / 0 failed / 0 skipped**。
- 类型检查：`@agentport/sandbox` 与 `@agentport/worker` 的 typecheck 均通过。
- 配置：`packages/worker/test/config.test.ts` **10 passed**；`SANDBOX_IDLE_TIMEOUT_MS` 用例有先红后绿证据（字段加入前失败，加入后通过），属基线，只覆盖配置解析。
- 真实 Docker 容器开销（缓存镜像，`--entrypoint /bin/true run --rm`）五次：125 / 122 / 125 / 120 / 116 ms，均值 122 ms。只衡量容器创建、启动、退出、删除，不含 SDK 与模型。
- 离线 SDK 原生 CLI `--version`：13 ms，版本 2.1.311。只测 CLI 启动，不是 query，不能解释为模型启动耗时。

### 行为验收计划

1. **两轮复用**：同一会话连续两轮，记录容器 id、`docker inspect` 创建时间、DB/日志 sandbox 身份；断言第二轮未新建容器，SDK 能 resume 同一会话。— 已完成：Docker fixture 覆盖复用与持久 state；当前源码 SDK fake API 4 passed。
2. **同会话隔离**：同一专家两个不同会话，断言容器不同、`sdk-sessions`/附件/草稿互不可见，历史与成果不串。— 已完成：fixture 覆盖。
3. **取消后续用**：运行中取消，确认终态唯一、容器在停稳后保留；下一轮同会话继续，断言 sessionId 未丢（含 fork/首次会话场景），transcript 继续追加。— 已完成：runner client 覆盖 cancel sessionId；取消最终 8 files 82 passed；metadata 保留 sessionId 与费用。
4. **空闲回收后 resume**：空闲超过阈值后确认回收容器；下一轮新建容器并从宿主 `sdk-sessions` resume，断言历史连续、无重复/残留容器。— 已完成：fixture 覆盖 idle 回收后新容器从持久 state 恢复。
5. **每 run 身份与成果边界**：每轮新 runId、新 MCP/模型 token；旧 token 在 run 结束后被拒；`.mcp.json` 指向当前 run；`/mnt/outputs` 草稿按 run 隔离，`captureOutputDraft` 捕获到原 run 草稿且不覆盖旧 snapshot；仅停稳且不重试时发布成果，失败/重试不发布、不覆盖旧快照。— 已完成：capture 29 passed；运行结束即吊销 token（不论清理结果），停稳后移除 `.mcp.json`。
6. **试连与关停不回归**：`sandbox-probe` 与 native plugin 动作仍为一次性容器；创建中止、清理失败、worker SIGTERM 时复用容器被 `destroyAll` 收口，进程不挂起。— 已完成：root review fix、取消最终套件与上一轮联合回归覆盖。
7. **计时与环境**：真实等待 5 分钟不作为唯一测试手段；用假时钟覆盖边界与竞态，再补一次真实短阈值实测。— 已完成：manager 假时钟与真实 Docker fixture 覆盖 idle/busy/close。
8. **真实耗时**：实现后用相同缓存镜像/空任务对比“新建容器”与“复用容器”的创建启动开销；SDK query 启动单独测量，容器复用不改变每轮 SDK query 启动，不把它算作复用收益。真实模型多轮需用户另行授权。— 缓存镜像基线为容器创建/启动/退出约 122ms；未测复用收益，不承诺 SDK 冷启动加速。

### 后续可用命令（本任务相关）

- 定向测试：`pnpm exec vitest run --project backend packages/worker/test/config.test.ts packages/worker/test/docker-provider.test.ts packages/worker/test/cancel.test.ts packages/worker/test/runner-client-questions.test.ts packages/sandbox/test/runner.test.ts packages/sandbox/test/questions.test.ts`
- 会话复用测试：`packages/shared/test/sandbox-session.test.ts`、`packages/sandbox/test/session-supervisor.test.ts`、`packages/worker/test/session-{runner-client,sandboxes,workspace}.test.ts`
- 真实 Docker/SDK：`packages/worker/test/session-sandbox-docker.test.ts`、`packages/worker/test/session-sandbox-sdk.test.ts`（需要本机 `agentport/sandbox:dev` 镜像；每轮独立临时编译，不复用旧 dist）
- 类型检查：`pnpm --filter @agentport/worker typecheck`、`pnpm --filter @agentport/sandbox typecheck`
- 格式检查：`pnpm exec biome check <改动文件>`
- 沙盒镜像：`pnpm --filter @agentport/sandbox image`（需要 Docker）

本次文档收尾只改上述四份 docs，未运行测试；测试结论来自主会话已完成的联合回归与各范围 review。旧基线仍只作基线；测试报告产物已恢复。

测试环境提示：根 `pnpm test` 的 backend 项目由 globalSetup 创建随机 PostgreSQL database 与独享临时 Redis 容器；PostgreSQL/Docker 不可用时对应套件跳过，不回落共享库。沙盒镜像相关测试需要本地 Docker 与镜像。
