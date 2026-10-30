# 平台改进循环（动效 10 分钟 × 能力 30 分钟）

## 目标

用户已在 2026-10-30 明确授权「提交并启动」：先把 `redesign-agent-experience` 的成果提交并合入 `main`，再启动每 10 分钟唤醒的动效车道与每 30 分钟到期的能力车道，持续改进 Agentport / PACE。

同日用户后续明确决定：两个定时任务先不急启动，要重启电脑，重启后再由用户明确要求启动。因此当前记录为 `paused_until_user_start`：提交与合并授权不变，本会话不创建 cron、不自动恢复，循环启动必须等用户重启后再次明确要求。

验收：

1. 只有一个 cron，按真实时间判断两车道到期，不按 tick 数。
2. 动效车道轮转覆盖全部路由，每周期至少检查一个此前未覆盖页面；无真实收益时记录 no-op，不造动作。
3. 能力车道每轮只交付一个最小完整、高业务价值的功能，按「现有 → 官方 SDK/已装依赖 → 活跃开源 → 自研」选型，经过三轮独立 Opus review 才可交付。
4. 所有写入与合并共用同一把锁，不与其他会话、worktree 或车道抢写。
5. 循环只存在于当前会话；关闭会话即停止，7 天后自动过期，不写永久 harness hook、定时 job 或状态脚本。
6. 验证与提交状态如实记录；失败、跳过、未覆盖不写成通过。

## 方案

### 调度

- 主线程在本轮基线合入 `main` 后，且用户重启电脑后再次明确要求启动时，才用 `CronCreate` 创建**唯一** cron，每 10 分钟唤醒；创建前与每轮开始时用 `CronList` 确认没有同类任务，避免重复。本会话不创建 cron；`CronList` 已确认无 jobs，`ScheduleWakeup` 已停止且无 pending。
- 暂停契约：用户启动前状态保持 `enabled:false`、两车道 `phase:'paused_by_user'`、`nextDue:null`；不唤醒、不产生车道任务、不在下一次会话自动恢复。
- 唤醒只是检查点。每轮按真实时间读取状态，判断各车道 `nextDue`：动效车道周期 10 分钟，能力车道周期 30 分钟。
- cron 仅当前会话有效：关闭会话即停止，7 天自动过期。不创建独立定时 job、状态脚本、配置文件或永久 harness hook。
- 车道有进行中的任务时，到点只继续该任务，不重开、不新建；不补做 missed tick，不积压到期次数。任务完成后的 `nextDue = 完成时刻 + 周期`。
- 能力车道到期优先，但已有任务不中断。一个车道持有写锁时，另一车道跳过写入与合并，不竞争；可做只读检查，但不产生新任务。

### 共用锁

- 路径：`$(git rev-parse --git-common-dir)/pace-improvement-loop.lock`，两车道与合并共用同一把。
- 获取：原子 `mkdir`；失败即视为被占用。锁目录内写 `owner`、`run`、`time`。
- 持有：创建锁的代理/任务结束前不释放，其他代理不得代释放。
- 过期：不能仅凭时间抢锁。只有确认 owner 对应代理/会话已不活跃，才清理，并在状态中记录原因。
- 状态写入同样必须在锁内完成。

### 状态

- 位置：`$(git rev-parse --git-common-dir)/pace-improvement-loop-state.json`，不进仓库、不提交。
- 结构（保持这些字段，不新增脚本）：

```json
{
  "animation": {
    "lastStarted": "ISO-8601",
    "nextDue": "ISO-8601",
    "activeTask": null,
    "phase": null,
    "reviewRound": 0,
    "branch": null,
    "paths": [],
    "results": { "pageCursor": null, "coveredPages": [], "lastOutcome": null }
  },
  "capability": {
    "lastStarted": "ISO-8601",
    "nextDue": "ISO-8601",
    "activeTask": null,
    "phase": null,
    "reviewRound": 0,
    "branch": null,
    "paths": [],
    "results": { "contract": null, "lastOutcome": null }
  },
  "enabled": true,
  "pausedDecision": null,
  "pausedReason": null,
  "pausedAt": null,
  "baselinePending": false,
  "schedulerJobId": null,
  "initialMergeCommit": null
}
```

- 暂停态：`enabled:false`、`pausedDecision:'paused_until_user_start'`、两车道 `phase:'paused_by_user'` 与 `nextDue:null`、`schedulerJobId:null`；`baselinePending` 如实表示分支是否仍待合并。

### 每轮流程

每轮仅在用户重启后明确要求启动且状态 `enabled:true` 时执行；暂停期间不唤醒、不写车道。

1. 读 `CLAUDE.md`、`docs/DEV-WORKFLOW.md`、`docs/PITFALLS.md`、`docs/REMAINING-TODOS.md` 与本文件。
2. `CronList` 确认唯一 cron。
3. 读状态，按真实时间判断到期车道；检查其他会话/worktree 是否有活跃任务。
4. 需要写入或合并时按「共用锁」获取锁；失败则本车道本轮跳过写入，记录原因后退出。
5. 车道任务按下方契约执行；状态在阶段变化时更新。
6. 交付后更新本文件「运行记录」与 `docs/REMAINING-TODOS.md`（仅当能力或缺口状态变化），清洁工作区。

### 工作区与分支

- 当前会话的 developer 明确要求 in-place，优先不建 worktree。
- 写代码前确认工作区干净并 `git fetch origin main`；从最新 `origin/main` 建独立分支再写。
- 发现未知的他人差异：不 `stash`、不 `restore`、不提交；暂停写入并报告。
- 不覆盖其他 session/worktree 的活跃任务；无法确认归属时按未知差异处理。
- 启动门槛：当前基线（`redesign-agent-experience` 合入 `main`）完成前，不做任何新增。

### 角色与并行

- 主会话：只编排、读代码、定共享契约、派发、验证、提交与合并。
- Opus：设计、方案、探索判断、独立 review、能力契约。
- Sonnet：源码、测试、配置、脚本等具体执行。
- 不使用 Workflow；可拆的独立单元并行派发，同一文件只允许一个写入者。

### 动效车道（10 分钟）

- 每轮加载 `find-animation-opportunities`；Opus 逐页检查，含 loading / error / empty / modal 状态，不只首页。
- 维护页面覆盖游标（状态 `animation.results.coveredPages/pageCursor`），按路由轮转；每个周期至少检查一个尚未覆盖的页面，最终覆盖全部路由。
- 只有存在真实交互或状态收益且符合 `docs/DESIGN-SYSTEM.md` §11 时才实施：不做装饰入场，不改固定数值（时长、缓动、尺寸、色值、布局）。
- 使用 `animate` 技能实现；按需使用 `review-animations` / `animation-performance`。
- Sonnet 实现；验证行为、真实浏览器、`prefers-reduced-motion` 与键盘焦点；Opus 独立 review。
- 没有机会时记录 no-op 与已检查页面，不制造动作。

### 能力车道（30 分钟）

- 从两类业务用户的主路径选择：找专家 → 创建专家 → 沟通 → 成果预览/下载/分享 → 个人与专家记忆改进；运维能力不占业务主入口。
- 选型顺序：先查现有项目 → 官方 Claude Agent SDK / 已装依赖 → 活跃开源（需维护状态、版本与许可证的一手证据）→ 最后自研。不新增无实测价值的能力、外部独立服务或账号、第二套循环或私有定义格式。
- Opus 固定一个最小完整、高业务价值功能的契约与验收；Sonnet 实现。
- 独立 Opus review 严格三轮：每轮固定 diff 范围与审查重点，修复后进入下一轮；第三轮仍未通过则不提交、不合并，继续同一任务修复复核，不按轮数宣称通过。
- 验证按改动范围执行测试、typecheck、build 与真实浏览器；`git fetch` 后 `rebase origin/main`，只解决自己的冲突，必要时重测。
- 提交信息用中文，结尾 `Co-Authored-By: Claude Code <noreply@anthropic.com>`；push 后创建 PR，正文中文，末尾 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`；仓库策略允许时不等 CI 直接合并。
- 完成后更新任务记录、本文件运行记录并清洁工作区。
- 授权不包括破坏数据、修改用户密码、向外部发消息。遇到真实决策缺口：安全暂停该项，继续推进不依赖它的独立项，并报告。

## 基线与范围

- 项目目录 `/Users/xbjt/Documents/myself/agentport`；当前分支 `redesign-agent-experience` 提交 `8696a56` + 补修 `8ba7c90`（当前 HEAD），已整合 main `646217c`，尚未合入 `main`。两项独立 review 已报告的 mustfix 均由 Opus 定点复核通过（回顾 pending 导航 reset；成果 runId-null 与 fork tool_result 合并锚点，87 条定向用例复测）。前端 118 个文件 1384 条用例通过（38.90s）；输出锚点变更后后端全量 247 个文件 2422 条用例通过、0 skip（91.12s），此后仅改 web 工具结果字段；全仓 typecheck、全仓 build 与最终 web build 通过，lint focus/contract 通过，迁移隔离真实通过。聊天历史合并 `tool_result` 时保留 `resultMessageId`，成果分页未扩大。
- 循环协调锁 `pace-improvement-loop.lock` 与状态 `pace-improvement-loop-state.json` 曾在 git common dir 创建；本会话 owner 锁（`job642ddc7d` / `initial-submit`）已释放，状态保留并记录 `enabled:false`、两车道 `phase:'paused_by_user'`、`nextDue:null`；cron 从未创建（`CronList` 已确认无 jobs，`ScheduleWakeup` 无 pending），循环暂停，待用户重启后手动启动。
- 任务记录进仓库；锁与状态放 git common dir，不提交。
- 允许改动：能力/动效任务对应的源码、测试、配置、脚本与文档，按各任务契约限定；循环本身不新增定时 job、状态脚本或 harness hook。
- 不改变：品牌数值与设计基准、已选技术栈、官方文件系统第一性原则、Claude Agent SDK 单底座、运维不占业务主入口。

## 当前有效决定

- 2026-10-30 用户明确授权「提交并启动」：当前分支提交并合 `main`；启动 10 分钟动效与 30 分钟能力循环；能力车道每个任务完成时提交、推送并合并。
- 2026-10-30 用户最新明确决定（覆盖本会话立即启动）：两个定时任务先不启动，重启电脑后再由用户明确要求启动；记录 `paused_until_user_start`，本会话不创建 cron、不自动恢复。提交与合并授权不变，两车道周期、三轮独立 review 与共用互斥锁契约保留。
- 当前执行状态：提交已落 `8696a56`，补修提交 `8ba7c90`（当前 HEAD），已整合 main `646217c`；两项独立 review 的已报告 mustfix 均由 Opus 定点复核通过（回顾 pending 导航 reset；成果 runId-null 与 fork tool_result 合并锚点，87 条定向用例复测），合入 `main` 尚未执行，`baselinePending` 为真实待合并。前端 118 文件 1384 用例（38.90s）、后端全量 247/2422（91.12s，0 skip）、全仓 typecheck/build、最终 web build、lint focus/contract、迁移隔离均通过。本会话锁已释放，状态 `enabled:false`、两车道 `phase:'paused_by_user'`、`nextDue:null`；`CronList` 无 jobs，cron 从未创建。
- 单一 cron，按真实时间分车道，不按 tick 数；不启 CI、不开启 PR 监控或冷却等待。
- 主会话只编排/读/验证/提交；Opus 设计与判断；Sonnet 执行；不用 Workflow。
- in-place 优先；干净仓库从最新 `origin/main` 建独立分支；未知差异暂停并报告。
- 共用锁与状态文件放 git common dir，不进仓库。

## 已替代项及原因

- 旧的「未授权 commit / push / merge」被用户 2026-10-30 的明确授权替代。
- 「本轮基线合入后立即启动循环」被用户 2026-10-30 的最新决定替代：两个定时任务先不启动，重启电脑后由用户明确要求再启动（`paused_until_user_start`）；提交与合并授权以及循环契约不变。
- 多 cron 或多车道各自计时被单一 cron + 真实时间判断替代；避免重复任务与 tick 漂移。
- 用 Workflow 编排被主会话 + Opus/Sonnet 子代理替代；本项目要求主会话只编排，且已有并行子代理机制。
- 默认建 worktree 被当前会话 in-place 要求替代；例外来源为本轮任务指令，不推广。
- 独立定时 job 或状态脚本被禁止；状态用 git common dir 的 JSON，锁用原子 `mkdir`。

## 步骤

- [x] 创建本记录；更新 `docs/tasks/agent-experience-redesign.md` 授权段与收尾证据。
- [x] 提交当前分支为 `8696a56`，整合 main `646217c`，补修提交 `8ba7c90`（当前 HEAD）。
- [x] 2026-10-30 按用户最新决定暂停启动：记录 `paused_until_user_start`，状态置 `enabled:false`、两车道 `phase:'paused_by_user'`、`nextDue:null`，释放本会话 owner 锁（`job642ddc7d` / `initial-submit`）。
- [x] 两项独立 review 的已报告 mustfix 由 Opus 定点复核通过（回顾 pending 导航 reset；成果 runId-null 与 fork tool_result 合并锚点，87 条定向用例复测）。
- [ ] 合入 `main` 尚未执行；确认工作区干净后按授权处理。
- [ ] 用户重启电脑并再次明确要求启动后，`CronList` 确认无同类 cron，再用 `CronCreate` 创建唯一 10 分钟 cron（本会话不创建）。
- [ ] 每轮按契约检查两车道；动效轮转页面，能力任务三轮独立 review。
- [ ] 能力任务完成后提交、推送、合并，并更新本记录与待办。
- [ ] 停止时用 cron 工具取消；关闭会话即自动停止。

## 改动文件

- `docs/tasks/platform-improvement-loop.md`
- `docs/tasks/agent-experience-redesign.md`

## 运行记录

2026-10-30 / 暂停 / 用户决定重启电脑后再手动启动 / 记录 `paused_until_user_start`；状态 `enabled:false`、两车道 `phase:'paused_by_user'`、`nextDue:null`；`CronList` 无 jobs、`ScheduleWakeup` 无 pending；本会话 owner 锁已释放 / 无 commit

启动后每完成一个车道任务追加一行：时间 / 车道 / 任务 / 结果 / commit 或 PR。

## 下一步

- 当前分支提交 `8696a56` + 补修 `8ba7c90` 已完成、已整合 main `646217c`；已报告 review mustfix 已定点通过，合入 `main` 尚未执行（授权不变）。
- 循环保持暂停：用户重启电脑并再次明确要求启动前，不创建 cron、不执行车道任务、不自动恢复。
- 启动后首轮动效从尚未覆盖的页面开始；首轮能力从 `docs/REMAINING-TODOS.md` 与两类用户主路径中选取最小完整功能，契约由 Opus 固定。

## 验证

- `git diff --check`：通过（exit 0，无空白错误）。
- 本轮收尾验证（2026-10-30 最终结果，按真实结果记录）：
  - 全仓 typecheck：`pnpm -r typecheck` 完整通过。
  - 全仓 build：`pnpm -r build` 与最终 web build 完整通过。
  - Lint：focus / contract 检查通过。
  - 前端：最终 118 个测试文件、1384 条用例全部通过，38.90s。
  - 后端全量（锚点变更后）：`SANDBOX_IMAGE=agentport/sandbox:redesign-validation-642ddc7d pnpm exec vitest run --project backend` 247 个测试文件、2422 条用例全部通过，0 skip，91.12s；此后只有 web 工具结果字段改动，未再改后端。
  - 定向复测：成果 runId-null 与 fork tool_result 合并锚点 87 条用例复测通过；回顾 pending 导航 reset 定向复核通过。
  - 迁移：本轮验证全部在 backend globalSetup 的随机隔离库完成，迁移隔离真实通过。
  - 补修：manifest 成果条目补 `userMessageId`/`afterMessageId` 锚点，清理/分支后仍挂回正确轮次；聊天历史合并 `tool_result` 时保留结果消息 `resultMessageId`，成果分页未扩大；回顾提交成功先 reset 最新 blocker 再关闭，browser history 测试证明地址栏与路由一致。
  - 独立 sandbox 镜像：GNU bash 5.3.9、Claude Agent SDK 0.3.311，fake 模型无付费请求；共享开发镜像 `agentport/sandbox:dev` 仍缺 GNU bash，但未用于本轮验收，真实 SDK 覆盖已由独立镜像解决。
- 真实付费模型与有效分享页浏览器验收仍未完成；合入 `main` 尚未执行。以上均不写成通过。
- 上述数字来自本轮最终验证；循环尚未启动，本文件未重跑车道任务。两项独立 review 的已报告 mustfix 已定点通过，不据此宣称整项验收或合并完成。
