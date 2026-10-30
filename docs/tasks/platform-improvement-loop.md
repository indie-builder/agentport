# 平台改进循环（动效 10 分钟 × 能力 30 分钟）

## 目标

用户已在 2026-10-30 明确授权「提交并启动」：先把 `redesign-agent-experience` 的成果提交并合入 `main`，再启动每 10 分钟唤醒的动效车道与每 30 分钟到期的能力车道，持续改进 Agentport / PACE。

同日用户曾要求重启电脑后再启动，记录为 `paused_until_user_start`；该暂停已由用户 2026-10-30 明确指令「好，现在给我开始启动这两个loop」替代。基线已由 PR #119 合入 `main`（`aa8142c`），唯一 scheduler 已创建并运行，两车道首轮任务已并行启动。

验收：

1. 只有一个 cron，按真实时间判断两车道到期，不按 tick 数。
2. 动效车道轮转覆盖全部路由，每周期至少检查一个此前未覆盖页面；无真实收益时记录 no-op，不造动作。
3. 能力车道每轮只交付一个最小完整、高业务价值的功能，按「现有 → 官方 SDK/已装依赖 → 活跃开源 → 自研」选型，经过三轮独立 Opus review 才可交付。
4. 所有写入与合并共用同一把锁，不与其他会话、worktree 或车道抢写。
5. 循环只存在于当前会话；关闭会话即停止，7 天后自动过期，不写永久 harness hook、定时 job 或状态脚本。
6. 验证与提交状态如实记录；失败、跳过、未覆盖不写成通过。

## 方案

### 调度

- 唯一 cron 已按用户 2026-10-30 的明确启动指令创建：jobID `b399e273`，`*/10 * * * *`，工具返回的实际下次运行是 2026-10-30 09:54 本地时间（运行时快照，后续以 cron 工具实际返回为准）；仅此一个 scheduler 同时承担动效 10 分钟与能力 30 分钟两车道，不另建第二个 cron。每轮开始时用 `CronList` 确认没有同类任务，避免重复。启动前置由用户明确启动控制；历史暂停期间「本会话不创建 cron」的表述已被这次启动替代，不是当前规则。
- 历史暂停契约（已替代）：启动前状态曾为 `enabled:false`、两车道 `phase:'paused_by_user'`、`nextDue:null`；用户明确启动后已切换为运行态，不再适用。
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

- 历史暂停态（已替代）：曾为 `enabled:false`、`pausedDecision:'paused_until_user_start'`、两车道 `phase:'paused_by_user'` 与 `nextDue:null`、`schedulerJobId:null`。
- 当前运行态：`enabled:true`、`baselinePending:false`、`initialMergeCommit:'aa8142c'`、`schedulerJobId:'b399e273'`；两车道 `nextDue` 首轮为当前到期，后续为完成任务时刻 + 周期；共用锁由本 job `startup` 持有至首轮任务收尾。

### 每轮流程

用户已于 2026-10-30 明确启动，状态 `enabled:true`；每轮按状态与真实时间执行。启动前置始终由用户明确启动控制，暂停期间不唤醒、不写车道。

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
- 启动门槛已满足：基线（`redesign-agent-experience`）已由 PR #119 合入 `main` `aa8142c`，不再有未合并前置。

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

- 项目目录 `/Users/xbjt/Documents/myself/agentport`；基线分支 `redesign-agent-experience` 的 `8696a56` + 补修 `8ba7c90` 已整合 main `646217c`，并已由 PR #119 合入 `main` `aa8142c`（原「尚未合入 main」已纠正）。两项独立 review 已报告的 mustfix 均由 Opus 定点复核通过（回顾 pending 导航 reset；成果 runId-null 与 fork tool_result 合并锚点，87 条定向用例复测）。前端 118 个文件 1384 条用例通过（38.90s）；输出锚点变更后后端全量 247 个文件 2422 条用例通过、0 skip（91.12s），此后仅改 web 工具结果字段；全仓 typecheck、全仓 build 与最终 web build 通过，lint focus/contract 通过，迁移隔离真实通过。聊天历史合并 `tool_result` 时保留 `resultMessageId`，成果分页未扩大。
- 循环协调锁 `pace-improvement-loop.lock` 与状态 `pace-improvement-loop-state.json` 位于 git common dir；历史暂停时 owner 锁曾释放，当前锁 owner 为本 job `startup`，持有至首轮任务收尾，其他会话、worktree 或车道不得抢锁。状态当前为 `enabled:true`、`baselinePending:false`、`initialMergeCommit:'aa8142c'`、`schedulerJobId:'b399e273'`；cron 已在用户明确启动后创建，session-only、7 天自动过期，关闭会话即停止。
- 任务记录进仓库；锁与状态放 git common dir，不提交。
- 允许改动：能力/动效任务对应的源码、测试、配置、脚本与文档，按各任务契约限定；循环本身不新增定时 job、状态脚本或 harness hook。
- 不改变：品牌数值与设计基准、已选技术栈、官方文件系统第一性原则、Claude Agent SDK 单底座、运维不占业务主入口。

## 当前有效决定

- 2026-10-30 用户明确指令「好，现在给我开始启动这两个loop」，覆盖此前的重启后暂停：两车道已启动，唯一 scheduler 承担动效 10 分钟与能力 30 分钟；启动前置由用户明确启动控制。
- 基线已由 PR #119 合入 `main` `aa8142c`，`baselinePending:false`、`initialMergeCommit:'aa8142c'`，不再有待合并前置。
- 当前调度：jobID `b399e273`、`*/10 * * * *`，session-only、7 天自动过期、关闭会话即停止；只有这一个 scheduler，不新增第二个 cron。两车道 `nextDue` 由主线程按各自任务完成时刻 + 周期计算，本记录不预置。
- 首轮两车道于 2026-10-30T01:41:28Z 并行启动：动效只读 Opus 子代理 `aba90cd64ba20f363`（专家/登录）、能力只读 Opus 子代理 `a4629c08d7aefb880`；首轮结果已回，见下条与运行记录。
- 2026-10-30 首轮动效车道完成实现、验证与合并：`CreateAgentDialog` 高级设置折叠补 150ms height+opacity 共享过渡（仅加 `animated`，测试草稿保持）；主线程 2 文件 102 用例 9.50s 通过；独立 Opus review `af6e2975d28243568` 通过、无 mustfix（3 文件 105 用例 + web typecheck/focus/diffcheck）；已由 PR #120 合入 `main` `5546502`。
- 能力车道任务 10「会话内图片成果预览」（PNG/JPEG/GIF/WebP，复用鉴权下载，公开/私有共享 BlobImage）已实现并通过三轮 Opus review（末轮 `a9c2e499b17d5672d`，86 条定向用例）；主线程 full web 118 文件 1396 用例 39.32s、API/Web typecheck/build、backend 18 通过；最终浏览器验收 `a7090b402c75b1cb1` 通过；源码 `e4d414d` 已由 PR #121 合入 `main` `70e28e2`，图片成果实际交付。
- 2026-10-30T03:10:43Z 动效第二轮 `/chat` 为 no-op（Opus 只读 `a5ad9d9ba376153d2`）：实屏覆盖欢迎、搜索最近筛选空结果、两条历史、Trace 执行、历史 239.8px、成果侧栏空态与 320 开合、菜单、不存在会话错误；已有 Trace 折叠 150ms、成果侧 160ms、共享 overlay 150ms，拒绝给消息流、搜索、骨架、欢迎装饰加动效；新增源码 0，未跑测试/build；reduce 模拟 `matchMedia` 仍 false，未通过实屏 reduce；分享 Dialog 等 pending 异常仅代码，不记为实测。`coveredPages` 加 `/chat`，`nextCursor` 为 `/memory`；`animation.nextDue` 2026-10-30T03:20:43Z、`capability.nextDue` 2026-10-30T03:30:34Z（时间均为 runtime 快照）。
- 循环 scheduler 仍为唯一 job `b399e273`，共用锁由本 job 持有；能力任务交付后的 `nextDue` 由主线程按完成时刻 + 周期计算，本记录不预置。
- 能力车道每个任务完成后按授权提交、推送并合并；三轮独立 Opus review 与共用互斥锁契约不变。
- 单一 cron，按真实时间分车道，不按 tick 数；不启 CI、不开启 PR 监控或冷却等待。
- 主会话只编排/读/验证/提交；Opus 设计与判断；Sonnet 执行；不用 Workflow。
- in-place 优先；干净仓库从最新 `origin/main` 建独立分支；未知差异暂停并报告。
- 共用锁与状态文件放 git common dir，不进仓库。

## 已替代项及原因

- 旧的「未授权 commit / push / merge」被用户 2026-10-30 的明确授权替代。
- 「本轮基线合入后立即启动循环」曾被用户 2026-10-30 的重启后暂停决定替代（`paused_until_user_start`）；该暂停又已被用户同日「好，现在给我开始启动这两个loop」替代，当前为运行态。提交与合并授权以及循环契约不变。
- 「本会话绝不创建 cron / 重启后再由用户明确要求启动」作为暂停期规则已替代：用户在 2026-10-30 明确启动，唯一 cron `b399e273` 已创建；启动前置仍由用户明确启动控制，不改写为自动恢复。
- 「基线尚未合入 main / baselinePending 待合并」已被 PR #119 合入 `main` `aa8142c` 替代。
- 多 cron 或多车道各自计时被单一 cron + 真实时间判断替代；避免重复任务与 tick 漂移。
- 用 Workflow 编排被主会话 + Opus/Sonnet 子代理替代；本项目要求主会话只编排，且已有并行子代理机制。
- 默认建 worktree 被当前会话 in-place 要求替代；例外来源为本轮任务指令，不推广。
- 独立定时 job 或状态脚本被禁止；状态用 git common dir 的 JSON，锁用原子 `mkdir`。

## 步骤

- [x] 创建本记录；更新 `docs/tasks/agent-experience-redesign.md` 授权段与收尾证据。
- [x] 提交当前分支为 `8696a56`，整合 main `646217c`，补修提交 `8ba7c90`。
- [x] 2026-10-30 曾按用户当时决定暂停启动（`paused_until_user_start`）；该暂停已被同日「好，现在给我开始启动这两个loop」替代。
- [x] 两项独立 review 的已报告 mustfix 由 Opus 定点复核通过（回顾 pending 导航 reset；成果 runId-null 与 fork tool_result 合并锚点，87 条定向用例复测）。
- [x] 基线已由 PR #119 合入 `main` `aa8142c`；此前「尚未合入」记录已纠正。
- [x] 用户明确启动后创建唯一 cron：jobID `b399e273`、`*/10 * * * *`，实际下次 2026-10-30 09:54 本地（运行时快照），session-only、7 天自动过期。
- [x] 首轮两车道于 2026-10-30T01:41:28Z 并行启动：动效只读 Opus `aba90cd64ba20f363`（专家/登录）、能力只读 Opus `a4629c08d7aefb880`。
- [x] 首轮动效任务完成实现、验证与独立 review，并由 PR #120 合入 `main` `5546502`。
- [x] 能力 task 10 完成实现、三轮 Opus review、主线程回归与最终浏览器验收 `a7090b402c75b1cb1`；源码 `e4d414d` 已由 PR #121 合入 `main` `70e28e2`。
- [x] 动效第二轮检查 `/chat` 并记录 no-op；`coveredPages` 增加 `/chat`，`nextCursor` 为 `/memory`。
- [x] 能力 task 10 已由 PR #121 合入 `main` `70e28e2`，图片成果实际交付；`nextDue` 按合并完成时刻计算。
- [ ] 每轮按契约检查两车道；动效轮转页面，能力任务三轮独立 review。
- [ ] 停止时用 cron 工具取消；关闭会话即自动停止。

## 改动文件

- `docs/tasks/platform-improvement-loop.md`（本启动记录）
- `docs/tasks/animation-advanced-settings-20261030.md`（首轮动效任务记录，本轮新增）
- `docs/tasks/agent-experience-redesign.md`（此前基线任务已更新，本轮未改）

## 运行记录

2026-10-30 / 暂停（已替代） / 用户当时决定重启电脑后再手动启动 / 记录 `paused_until_user_start`；状态曾为 `enabled:false`、两车道 `phase:'paused_by_user'`、`nextDue:null`；`CronList` 无 jobs、`ScheduleWakeup` 无 pending；本会话 owner 锁已释放 / 无 commit

2026-10-30 / 启动 / 用户明确「好，现在给我开始启动这两个loop」 / 唯一 cron `b399e273` 已创建（`*/10 * * * *`，实际下次 2026-10-30 09:54 本地，运行时快照，session-only/7 天）；状态 `enabled:true`、`baselinePending:false`、`initialMergeCommit:'aa8142c'`；共用锁 owner 为本 job `startup` / 无 commit

2026-10-30T01:41:28Z / 首轮 / 动效只读 Opus `aba90cd64ba20f363`（专家/登录）与能力只读 Opus `a4629c08d7aefb880` 并行 / 启动时结果未回，不写结论；后续结果见下两行 / 无 commit

2026-10-30 / 动效车道首轮 / `CreateAgentDialog` 高级设置折叠补 150ms height+opacity 共享过渡（仅加 `animated`，测试草稿保持） / 实现 agent `a62f9d919db87caa3`；主线程 `agents-ui`+`agents-lifecycle` 2 文件 102 用例 9.50s 通过；独立 Opus `af6e2975d28243568` review 通过、无 mustfix（3 文件 105 用例 + web typecheck/focus/diffcheck）；浏览器证据沿用作者本 checkout `http://localhost:5173`（`agentport.localhost` 指向旧 worktree），未重测帧率，截图在 `/tmp/agentport-animation-20261030/`；`review-animations` 工具本环境被禁用，未执行其流程 / 已由 PR #120 合入 `main` `5546502`

2026-10-30 / 能力车道 task 10 / 会话内图片成果预览（PNG/JPEG/GIF/WebP，复用鉴权下载，公开/私有共享 BlobImage） / 实现完成；三轮 Opus review 通过（末轮 `a9c2e499b17d5672d`，无 mustfix，86 条定向用例）；主线程 full web 118 文件 1396 用例 39.32s、API/Web typecheck/build、backend 18 通过；最终浏览器验收 `a7090b402c75b1cb1` 通过（同秒 62ms 两图可区分、唯一 checked、旧版 URL/图/下载 hash、分享旧版、引用精确且不发模型、关闭回焦、快速切版 0 不一致、临时数据清零、公开清理 404） / 源码提交 `e4d414d`，已由 PR #121 合入 `main` `70e28e2`

2026-10-30T03:10:43Z / 动效车道第二轮 / `/chat` 检查为 no-op（Opus 只读 `a5ad9d9ba376153d2`） / 实屏：欢迎、搜索最近筛选空结果、两条历史、Trace 执行、历史 239.8px、成果侧栏空态与 320 开合、菜单、不存在会话错误；codeRoot 为当前 checkout `packages/web`、`http://localhost:5173`，非旧 domain；已有 Trace 折叠 150ms、成果侧 160ms、共享 overlay 150ms，拒绝给消息流、搜索、骨架、欢迎装饰加动效；新增源码 0，未跑测试/build；reduce 模拟 `matchMedia` 仍 false，本轮未通过实屏 reduce；分享 Dialog 等 pending 异常仅代码，不记为实测；`coveredPages` 加 `/chat`，`nextCursor` `/memory`，`animation.nextDue` 2026-10-30T03:20:43Z、`capability.nextDue` 2026-10-30T03:30:34Z（runtime 快照） / 无 commit

启动后每完成一个车道任务追加一行：时间 / 车道 / 任务 / 结果 / commit 或 PR。

## 下一步

- 基线已由 PR #119 合入 `main` `aa8142c`；首轮动效任务已由 PR #120 合入 `main` `5546502`。
- 循环唯一 scheduler 仍为 `b399e273`，共用锁由本 job 持有；不新增第二个 cron，不抢锁。
- 能力 task 10（会话内图片成果预览）已由 PR #121 合入 `main` `70e28e2`，交付完成。
- 动效车道下一轮游标 `/memory`；本轮 `/chat` 为 no-op，未加动效。
- 两车道 `nextDue` 分别为动效 2026-10-30T03:20:43Z、能力 2026-10-30T03:30:34Z（runtime 快照），不预置后续值，不创建 cron/state，不改源码。

## 验证

- `git diff --check`：通过（本启动记录改动后 exit 0，无空白错误）。
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
- 真实付费模型与有效分享页浏览器验收仍未完成（历史验收项）；合入 `main` 已由 PR #119 完成（`aa8142c`）。以上未完成项均不写成通过。
- 上述数字来自基线合入前的最终验证；首轮动效任务已由 PR #120 合入 `main` `5546502`；能力 task 10 已实现并通过三轮 review、主线程回归与最终浏览器验收，源码 `e4d414d` 已由 PR #121 合入 `main` `70e28e2`。两项独立 review 的已报告 mustfix 已定点通过，不据此宣称整轮循环完成。
- 首轮动效复测：主线程 `agents-ui`+`agents-lifecycle` 2 文件 102 条用例 9.50s 通过；独立 Opus review 3 文件 105 条用例 + web typecheck + `lint:focus` + `git diff --check` 通过、无 mustfix；浏览器证据来自作者本 checkout `http://localhost:5173`，未重测帧率；`review-animations` 工具被禁用，未执行其流程。已由 PR #120 合入 `main` `5546502`。
- 能力 task 10（会话内图片成果预览）：三轮 Opus review 通过（末轮 `a9c2e499b17d5672d`，无 mustfix，86 条定向用例）；主线程 full web 118 文件 1396 用例 39.32s、API/Web typecheck/build、backend 18 通过；最终浏览器验收 `a7090b402c75b1cb1` 通过；源码 `e4d414d` 已由 PR #121 合入 `main` `70e28e2`。限制：元数据接口仍整份读取文件字节；坏图、大图与 HTML 在真实浏览器中的表现未测，大图内存未单独测量；分页外旧版由单测覆盖。
- 动效第二轮 `/chat`：仅记录本文件，新增源码 0，未跑测试/build；reduce 模拟 `matchMedia` 仍 false，本轮未通过实屏 reduce，不写成通过；`git diff --check` 通过。
