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

- task 12 原按 developer 要求 in-place；2026-10-31 已迁入 `.claude/worktrees/subagent-memory-pr`（base `f9c70f6`），后续沿用工作树，主 checkout 保持干净。
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
- 能力车道 task 11「成果 PDF 原生预览」（私有/公开共享 `BlobPdf`，`pdfViewerEnabled` 支持判定与 `%PDF-` 前 5 字节 header 门槛，固定 `application/pdf` Blob URL，unsupported/invalid/readerror 三种提示保留下载，对象 URL 换版/卸载释放；CSP 仅加 `frame-src 'self' blob:`，`object-src 'none'`/`script-src 'self'` 保持；无新依赖/API/DB/模型费用）已实现并通过 API 一审（`a1f97d67a04771d6d`，26 用例）、Web 一审补修（`ada812d28cc77c763`，97 用例）、二审（`ab003ecf947f052cb`，无 mustfix）与第三轮 Opus review（`a18c436ffd11f7505`，无 mustfix，4 文件 110 用例）；主线程最终复验 full web 119 文件 1412 用例 39.50s、api/web typecheck/build、backend 3 文件 26 用例 2.62s 通过；生产隔离浏览器验收 `a46306ac16227d1ce` 通过；实现 `ca5cb28` 与文档 `9caf2fa` 已由 PR #123 合入 `main` `b683903`。
- 能力车道 task 12「子智能体自身专家记忆」源码评审与最终测试夹具复验通过、未提交合并：原生 `memory: project` + 既有 `agent-memory/` 直接 rw 挂载到 `/workspace/.claude/agent-memory/<slug>/`，主记忆不变，无新表/run 快照/第二记忆；绑定锁 → 排序 agent 记忆锁 → 行锁；chat/schedule/eval 只取稳定启用的直接子集合，活动期资源变化 409；目标写入检查自身或 enabled 父 run；已知子文件工具仅自身 md，兄弟/父/未知拒绝且显式 deny 保留；定义包支持 `project`、拒绝 `user`/`local` 且不携学习内容。历史评审链（首轮成果刷新/模型说明、第二轮普通 `.claude` 文件、第二路并发 3 个真实阻塞、第三轮两项）均已修复，源码整体 `a9f539537d2542d89` PASS、`sessions` format `a8c52733b5e29b393` PASS。分层结果：SDK 最新接口 16/16 PASS（`/tmp/subagent-memory-sdk-final-interface-unique.json`）；浏览器全部 PASS、0 残留；stable 25 文件 376、web 72、outputs 31、migration `generate` + `migrate` 隔离库通过。运行整合 13 文件 195/195 PASS（`/tmp/subagent-memory-runtime-final-green.json`）；未提交、未合并，不写整体 passed。原 in-place 已由工作树 `.claude/worktrees/subagent-memory-pr`（base `f9c70f6`）替代，主 checkout 未动。用户最新「旅游期间按推荐方案自主，项目负责人」按既有授权记录，不是清库或生产部署授权。详见 [任务记录](subagent-memory-20261030.md)。
- 2026-10-30 动效第四轮 `/schedules` 为 no-op（Opus 证据 `a0d97023647626f83`）：部分实屏覆盖空态、新建、专家选择、开关、dirty 取消保留草稿与放弃关闭、焦点回新建、150ms overlay；reduce 实际 `0.01ms`/delay `0ms`；非空列表、编辑、删除、pending、冲突、路由 blocker 仅代码检查，未测帧率与完整退出时序；新增源码 0。`coveredPages` 加 `/schedules`，`pageCursor` `/servers`。
- 2026-10-30T03:10:43Z 动效第二轮 `/chat` 为 no-op（Opus 只读 `a5ad9d9ba376153d2`）：实屏覆盖欢迎、搜索最近筛选空结果、两条历史、Trace 执行、历史 239.8px、成果侧栏空态与 320 开合、菜单、不存在会话错误；已有 Trace 折叠 150ms、成果侧 160ms、共享 overlay 150ms，拒绝给消息流、搜索、骨架、欢迎装饰加动效；新增源码 0，未跑测试/build；reduce 模拟 `matchMedia` 仍 false，未通过实屏 reduce；分享 Dialog 等 pending 异常仅代码，不记为实测。`coveredPages` 加 `/chat`，`nextCursor` 为 `/memory`；`animation.nextDue` 2026-10-30T03:20:43Z、`capability.nextDue` 2026-10-30T03:30:34Z（时间均为 runtime 快照）。
- 循环 scheduler 仍为唯一 job `b399e273`，共用锁由本 job 持有；能力任务交付后的 `nextDue` 由主线程按完成时刻 + 周期计算，本记录不预置。
- 能力车道每个任务完成后按授权提交、推送并合并；三轮独立 Opus review 与共用互斥锁契约不变。
- 单一 cron，按真实时间分车道，不按 tick 数；不启 CI、不开启 PR 监控或冷却等待。
- 主会话只编排/读/验证/提交；Opus 设计与判断；Sonnet 执行；不用 Workflow。
- 产出只落工作树；干净仓库从最新 `origin/main` 建独立分支。task 12 已由 in-place 迁到 `.claude/worktrees/subagent-memory-pr`（base `f9c70f6`），主 checkout 不动。
- 共用锁与状态文件放 git common dir，不进仓库。

## 已替代项及原因

- 旧的「未授权 commit / push / merge」被用户 2026-10-30 的明确授权替代。
- 「本轮基线合入后立即启动循环」曾被用户 2026-10-30 的重启后暂停决定替代（`paused_until_user_start`）；该暂停又已被用户同日「好，现在给我开始启动这两个loop」替代，当前为运行态。提交与合并授权以及循环契约不变。
- 「本会话绝不创建 cron / 重启后再由用户明确要求启动」作为暂停期规则已替代：用户在 2026-10-30 明确启动，唯一 cron `b399e273` 已创建；启动前置仍由用户明确启动控制，不改写为自动恢复。
- 「基线尚未合入 main / baselinePending 待合并」已被 PR #119 合入 `main` `aa8142c` 替代。
- 多 cron 或多车道各自计时被单一 cron + 真实时间判断替代；避免重复任务与 tick 漂移。
- 用 Workflow 编排被主会话 + Opus/Sonnet 子代理替代；本项目要求主会话只编排，且已有并行子代理机制。
- 默认建 worktree 曾被 2026-10-30 in-place 要求替代；该例外已再次被 2026-10-31 的工作树迁移替代（`.claude/worktrees/subagent-memory-pr`，base `f9c70f6`，主 checkout 保持未动），恢复「产出只落 worktree」的默认流程。
- 独立定时 job 或状态脚本被禁止；状态用 git common dir 的 JSON，锁用原子 `mkdir`。
- 「PDF 实现未 push、未 merge」已被 PR #123 合入 `main` `b683903` 替代；历史评审与验收证据保留原样。
- 「子智能体独立记忆尚未实现」已被 task 12 的源码评审通过状态替代：原生 `memory: project` 与既有 `agent-memory/` 直接挂载；源码整体 `a9f539537d2542d89`、`sessions` format `a8c52733b5e29b393` PASS，SDK 最新接口 16/16、浏览器与 stable/web/outputs/migration 分层通过；运行整合 13 文件 195/195 PASS，未提交未合并前不写成整体通过或已交付。
- 「定向 17 文件 297 用例 / 后端 23 文件 393 用例」作为最新证据已被更新替代：stable 25 文件 376、web 72、outputs 31、migration 隔离库通过，SDK 最新接口 16/16 PASS，浏览器全部 PASS、0 残留；运行整合 13 文件 195/195 PASS（`/tmp/subagent-memory-runtime-final-green.json`）回填。
- 原主 checkout inactive owner `642ddc7d` 写锁已接管为新 run `subagent-memory-pr-20261031`；迁移时 33 个路径与主 checkout 对应版本核对一致，迁入后本树内又修复 7 个文件，主 checkout 未被改动。

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
- [x] 能力 task 11 完成实现、三轮 Opus review、生产隔离浏览器验收与主线程最终复验；实现 `ca5cb28` 与文档 `9caf2fa` 已由 PR #123 合入 `main` `b683903`。
- [x] 动效第三轮检查 `/memory` 并记录 no-op（仅代码覆盖，实屏被登录阻挡）；`pageCursor` 更新为 `/schedules`。
- [x] 动效第四轮检查 `/schedules` 并记录 no-op：新增候选 0；空态/新建/专家选择/开关/取消草稿/焦点回焦与 150ms overlay 部分实屏覆盖，reduce 实际生效为 0.01ms；非空列表、编辑、删除、pending、冲突、路由 blocker 仅代码检查。`coveredPages` 增加 `/schedules`，`pageCursor` 为 `/servers`。
- [x] 能力 task 12「子智能体自身专家记忆」源码评审与最终夹具复验通过（整体 `a9f539537d2542d89`、`sessions` format `a8c52733b5e29b393`）：原生 `memory: project` + 既有 `agent-memory/` 直接挂载，归属锁、执行期准入、文件边界与定义包均已实现；历史评审问题均已修复。stable 25 文件 376、web 72、outputs 31、migration 隔离库通过；SDK 最新接口 16/16 PASS；浏览器全部 PASS、0 残留；运行整合 13 文件 195/195 PASS。未提交、未合并。详见 [任务记录](subagent-memory-20261030.md)。
- [ ] 每轮按契约检查两车道；动效轮转页面，能力任务三轮独立 review。
- [ ] 停止时用 cron 工具取消；关闭会话即自动停止。

## 改动文件

（累计记录；2026-10-31 本轮更新本文件、`docs/tasks/subagent-memory-20261030.md`、`docs/ARCHITECTURE.md`、`docs/USER-STORIES.md`、`docs/REMAINING-TODOS.md`、`docs/DECISIONS-PENDING.md`、`docs/tasks/agent-experience-redesign.md`。）

- `docs/tasks/platform-improvement-loop.md`（本启动记录）
- `docs/tasks/animation-advanced-settings-20261030.md`（首轮动效任务记录）
- `docs/tasks/pdf-output-preview-20261030.md`（能力 task 11 任务记录；已补正 PR #123 合并事实）
- `docs/tasks/subagent-memory-20261030.md`（能力 task 12 任务记录，本轮新增）
- `docs/DESIGN-SYSTEM.md`、`docs/ARCHITECTURE.md`、`docs/USER-STORIES.md`、`docs/REMAINING-TODOS.md`（同步 PDF PR #123 已合并、子智能体记忆源码评审与最终夹具复验通过、worktree 迁移与 §11 reduced-motion 的 `0.01ms` 事实）
- `docs/ARCHITECTURE.md`、`docs/DECISIONS-PENDING.md`（2026-10-31 同步运行终态与清理契约：timeout 有效 job 保持 running、unconfirmed 存 `pending_finish`、reconcile 按 id 清理与 CAS 终态；D-43 历史结论保留并追加后续更新）
- `docs/tasks/agent-experience-redesign.md`（此前基线任务已更新，本轮未改）

## 运行记录

2026-10-30 / 暂停（已替代） / 用户当时决定重启电脑后再手动启动 / 记录 `paused_until_user_start`；状态曾为 `enabled:false`、两车道 `phase:'paused_by_user'`、`nextDue:null`；`CronList` 无 jobs、`ScheduleWakeup` 无 pending；本会话 owner 锁已释放 / 无 commit

2026-10-30 / 启动 / 用户明确「好，现在给我开始启动这两个loop」 / 唯一 cron `b399e273` 已创建（`*/10 * * * *`，实际下次 2026-10-30 09:54 本地，运行时快照，session-only/7 天）；状态 `enabled:true`、`baselinePending:false`、`initialMergeCommit:'aa8142c'`；共用锁 owner 为本 job `startup` / 无 commit

2026-10-30T01:41:28Z / 首轮 / 动效只读 Opus `aba90cd64ba20f363`（专家/登录）与能力只读 Opus `a4629c08d7aefb880` 并行 / 启动时结果未回，不写结论；后续结果见下两行 / 无 commit

2026-10-30 / 动效车道首轮 / `CreateAgentDialog` 高级设置折叠补 150ms height+opacity 共享过渡（仅加 `animated`，测试草稿保持） / 实现 agent `a62f9d919db87caa3`；主线程 `agents-ui`+`agents-lifecycle` 2 文件 102 用例 9.50s 通过；独立 Opus `af6e2975d28243568` review 通过、无 mustfix（3 文件 105 用例 + web typecheck/focus/diffcheck）；浏览器证据沿用作者本 checkout `http://localhost:5173`（`agentport.localhost` 指向旧 worktree），未重测帧率，截图在 `/tmp/agentport-animation-20261030/`；`review-animations` 工具本环境被禁用，未执行其流程 / 已由 PR #120 合入 `main` `5546502`

2026-10-30 / 能力车道 task 10 / 会话内图片成果预览（PNG/JPEG/GIF/WebP，复用鉴权下载，公开/私有共享 BlobImage） / 实现完成；三轮 Opus review 通过（末轮 `a9c2e499b17d5672d`，无 mustfix，86 条定向用例）；主线程 full web 118 文件 1396 用例 39.32s、API/Web typecheck/build、backend 18 通过；最终浏览器验收 `a7090b402c75b1cb1` 通过（同秒 62ms 两图可区分、唯一 checked、旧版 URL/图/下载 hash、分享旧版、引用精确且不发模型、关闭回焦、快速切版 0 不一致、临时数据清零、公开清理 404） / 源码提交 `e4d414d`，已由 PR #121 合入 `main` `70e28e2`

2026-10-30T03:10:43Z / 动效车道第二轮 / `/chat` 检查为 no-op（Opus 只读 `a5ad9d9ba376153d2`） / 实屏：欢迎、搜索最近筛选空结果、两条历史、Trace 执行、历史 239.8px、成果侧栏空态与 320 开合、菜单、不存在会话错误；codeRoot 为当前 checkout `packages/web`、`http://localhost:5173`，非旧 domain；已有 Trace 折叠 150ms、成果侧 160ms、共享 overlay 150ms，拒绝给消息流、搜索、骨架、欢迎装饰加动效；新增源码 0，未跑测试/build；reduce 模拟 `matchMedia` 仍 false，本轮未通过实屏 reduce；分享 Dialog 等 pending 异常仅代码，不记为实测；`coveredPages` 加 `/chat`，`nextCursor` `/memory`，`animation.nextDue` 2026-10-30T03:20:43Z、`capability.nextDue` 2026-10-30T03:30:34Z（runtime 快照） / 无 commit

2026-10-30 / 动效车道第三轮 / `/memory` 检查记录为 no-op（仅代码覆盖） / 实屏访问被登录阻挡，未新增源码或测试；`coveredPages` 加 `/memory`、`pageCursor` `/schedules`；`pendingDocumentation` 记录该 no-op，已在本轮任务文档确认记录；不据此宣称实屏或 reduced-motion 通过 / 无 commit

2026-10-30 / 动效车道第四轮 / `/schedules` 检查为 no-op（Opus 证据 `a0d97023647626f83`） / codeRoot 为当前 checkout `packages/web`、commit `b683903`、`https://loop-ready.agentport.localhost/schedules`；实屏覆盖空态、新建、专家选择、开关、dirty 取消保留草稿与放弃关闭、关闭后焦点回新建按钮、overlay/select opacity 150ms `ease-out-soft`；reduce 模拟 `matchMedia=true` 且实际 `0.01ms`、delay `0ms`，已恢复模拟并关闭本轮 space；非空列表、编辑、删除、pending、冲突、路由 blocker 仅代码检查，未测帧率及完整退出时序；新增源码 0；`coveredPages` 加 `/schedules`，`pageCursor` `/servers`；不据此宣称未覆盖项通过 / 无 commit

2026-10-30 / 能力车道 task 11 / 成果 PDF 原生预览（私有/公开共享 `BlobPdf`，`pdfViewerEnabled` 支持与 `%PDF-` header 门槛，三种提示保留下载，对象 URL 释放） / API 一审 `a1f97d67a04771d6d` 26 用例通过；Web 一审 readerror mustfix 修复 `ada812d28cc77c763` 97 用例、二审 `ab003ecf947f052cb` 通过无 mustfix；第三轮 Opus review `a18c436ffd11f7505` 通过无 mustfix（4 文件 110 用例）；生产隔离浏览器 `a46306ac16227d1ce` 通过（独立随机 PG+Redis、端口 63465、production CSP `frame-src 'self' blob:`、`pdfViewerEnabled=true`、私有/公开 ONE/TWO、切版刷新、下载 sha、公开无 cookie、伪 PDF 无 iframe、引用不发模型、清理 0；非 Chromium 未测）；主线程最终复验 full web 119 文件 1412 用例 39.50s、api/web typecheck/build、backend 3 文件 26 用例 2.62s 通过；实现 `ca5cb28` 与文档 `9caf2fa` 已由 PR #123 合入 `main` `b683903` / PR #123（合并 `b683903`）

2026-10-30 / 能力车道 task 12 / 子智能体自身专家记忆（原生 `memory: project` + 既有 `agent-memory/` 直接 rw 挂到 `/workspace/.claude/agent-memory/<slug>/`；主记忆不变；无新表/run 快照/第二记忆） / 契约已定：复用绑定锁 → 排序 agent 记忆锁 → 行锁；chat/schedule/eval 只取稳定启用的直接子集合，活动期资源变化 409，普通字段/无关专家可改；目标记忆写检查自身或 enabled 父 run；会话刷新保官方记忆子树 inode、挂载变化重建；已知子文件工具仅自身 md，兄弟/父/未知拒绝且显式 deny 保留；Bash 共享可见不声称隔离；定义导入导出支持 `project`、`user`/`local` 拒绝，包仅定义不携学习内容；三个 Sonnet 并行源码、文档分工；当前 implementation 进行中，未验证、未提交、未 review，不写 passed / 无 commit

2026-10-31 / 能力车道 task 12 迁移与部分验证 / 工作树 `.claude/worktrees/subagent-memory-pr`（HEAD `f9c70f6`，分支 `feat/subagent-memory-pr-20261031`）接管原主 checkout inactive owner `642ddc7d` 写锁为 `subagent-memory-pr-20261031`；从主 checkout `b683903` 未提交实现迁入 33 个路径，迁移时 hash 核对一致，未带 `.vitest` 产物，主 checkout 未动；迁入后本树内修复 7 个文件（定义拒绝文案、CLAUDE.md 子记忆文件工具措辞、产出目录刷新不保留记忆挂载等） / 定向 17 个测试文件 / 297 条用例通过、0 skip，报告 `/tmp/agentport-subagent-memory-pr-f9c70f6-20261031-012813.json`（01:28:13，早于最后 7 文件修复 01:30，当前源码状态需复跑）；五包 typecheck exit 0、shared/core/db/sandbox build exit 0（最新修复后是否复跑未记录）；独立评审未全部返回、真实 Docker/SDK 运行中、专项子记忆与浏览器验收待补，未提交，不写 passed / 无 commit

2026-10-31 / 能力车道 task 12 评审修复推进 / 首轮全范围 Opus review `ad8dc6d251f21accb` 发现成果刷新 P1、模型说明 P2；二轮修复 review `a404e1a84b82c0403` 新发现普通 `.claude` 文件 P2；两者已修复，最新定点 review `a3e9eaab09ee44c9f` 明确通过（源码默认完整 replace、仅 `preserveMemoryMount: true` 保 inode；11 workspace 测试 / worker typecheck / biome 通过）。core 文案 22 文件 255 用例通过；web 权限 UI `ac32cb7b1b664d875` 完成，65 用例 / web typecheck / build 通过，独立 UI review `aab8…` 运行中。第二路并发 review `a18691bdeec312cf2` 发现 3 个真实阻塞：timeout 编辑导致 reconcile 提前终态、stop unconfirmed + destroy fail 仍终态释放、chat/MCP 锁外 enabled 竞态；第 3 项由 Sonnet `a405…` 实施，第 1/2 项由 Opus `acc5…` 定最小完整契约后实施。后端 23 文件 393 用例通过（`/tmp/agentport-backend-verify-20261031.json`）但早于普通文件二次修复与新准入修复；SDK/Docker 旧基线 18 项通过（`/tmp/session-sandbox-verify-f9c70f6-20261031.json`）仅基线；专项 SDK `a558…` 运行中、浏览器 `aa000…` 临时隔离验收中。只修已证实路径，不新增未经确认理论防护；未提交，不写全通过 / 无 commit

2026-10-31 / 能力车道 task 12 终版契约与验收更新 / Opus `acc5…` 决定两项旧 P1 本轮必修：timeout 缩短不得终止仍有效 job；unconfirmed cleanup 不得 terminal 释放。三路 Sonnet 并行：schema `a8e5…`（`pending_finish` 可空 JSONB，类型复用现有完整 `run_finished` 事件 + 迁移）、provider `a7a5…`（`destroyById`、`SessionSandboxes.cleanup(conversationId, sandboxId)`）、runtime `aa106…`（index/`run-finish`/reconcile）；契约见任务记录，实施中，未复跑、未 review、未提交，不写 passed。浏览器最终验收通过（保存/刷新、409 草稿、普通 200、导出再导入；权限默认、禁用-保存-重载、恢复 path rules、previews ZIP、父级回归；证据 `/tmp/subagent-memory-pr-browser-20261031-013033/evidence/validation-{results,permissions}.json`，临时 DB/Redis 端口 0、space 已结束、截图与 ZIP 保留）。SDK 16 项通过（新增 3 项 deny + general purpose）但 generic hook error 断言过宽，正在收紧复验，不能最终通过。主 checkout 运行态快照 `enabled:false`、`schedulerId:null`，与文件历史 `enabled:true`/job `b399e273` 不一致仅作现状记录；历史保持原样，不重启循环。 / 无 commit

2026-10-31 / 能力车道 task 12 源码评审通过与运行整合复验 / 源码整体 `a9f539537d2542d89` PASS、`sessions` format `a8c52733b5e29b393` PASS；历史评审问题（首轮、第二轮、第二路并发 3 阻塞、第三轮两项）均已修复 / stable 25 文件 376、web 72、outputs 31、migration `generate` + `migrate` 隔离库通过；SDK 最新接口 16/16 PASS（`/tmp/subagent-memory-sdk-final-interface-unique.json`）；浏览器全部 PASS、0 残留；运行整合 13 文件 195/195 PASS（`/tmp/subagent-memory-runtime-final-green.json`）；未提交未合并 / 无 commit

启动后每完成一个车道任务追加一行：时间 / 车道 / 任务 / 结果 / commit 或 PR。

## 下一步

- 基线已由 PR #119 合入 `main` `aa8142c`；首轮动效任务已由 PR #120 合入 `main` `5546502`。
- 循环唯一 scheduler 仍为 `b399e273`，共用锁由本 job 持有；不新增第二个 cron，不抢锁。
- 能力 task 10（会话内图片成果预览）已由 PR #121 合入 `main` `70e28e2`，交付完成。
- 能力 task 11（成果 PDF 原生预览）三轮 Opus review 通过（末轮 `a18c436ffd11f7505`，无 mustfix），主线程最终复验通过；实现 `ca5cb28` 与文档 `9caf2fa` 已由 PR #123 合入 `main` `b683903`，交付完成。
- 能力 task 12（子智能体自身专家记忆）源码评审与最终测试夹具复验通过：工作树 `.claude/worktrees/subagent-memory-pr`（base `f9c70f6`）已完成迁移；源码整体 `a9f539537d2542d89` PASS、`sessions` format `a8c52733b5e29b393` PASS，历史评审问题均已修复。stable 25 文件 376、web 72、outputs 31、migration 隔离库通过；SDK 最新接口 16/16 PASS；浏览器全部 PASS、0 残留；运行整合 13 文件 195/195 PASS。未提交、未合并；用户已授权 PR 合并与自主推进，最终提交/合并由收尾 agent 执行，不写整体 passed。
- 动效车道游标 `/servers`；`/memory` 为仅代码覆盖的 no-op，实屏待登录解除后补验；`/schedules` 已记录部分实屏 no-op，未覆盖非空列表、编辑、删除、pending、冲突与路由 blocker。
- 两车道 `nextDue` 由主线程按各自任务完成时刻 + 周期计算，本记录不预置；不创建 cron/state、不改用户密码或库。

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
- 真实付费模型与有效分享页其它格式的浏览器验收仍未完成（历史验收项；分享页图片与 PDF 已由能力 task 10/11 在隔离生产浏览器验证）；合入 `main` 已由 PR #119 完成（`aa8142c`）。以上未完成项均不写成通过。
- 上述数字来自基线合入前的最终验证；首轮动效任务已由 PR #120 合入 `main` `5546502`；能力 task 10 已实现并通过三轮 review、主线程回归与最终浏览器验收，源码 `e4d414d` 已由 PR #121 合入 `main` `70e28e2`。两项独立 review 的已报告 mustfix 已定点通过，不据此宣称整轮循环完成。
- 首轮动效复测：主线程 `agents-ui`+`agents-lifecycle` 2 文件 102 条用例 9.50s 通过；独立 Opus review 3 文件 105 条用例 + web typecheck + `lint:focus` + `git diff --check` 通过、无 mustfix；浏览器证据来自作者本 checkout `http://localhost:5173`，未重测帧率；`review-animations` 工具被禁用，未执行其流程。已由 PR #120 合入 `main` `5546502`。
- 能力 task 10（会话内图片成果预览）：三轮 Opus review 通过（末轮 `a9c2e499b17d5672d`，无 mustfix，86 条定向用例）；主线程 full web 118 文件 1396 用例 39.32s、API/Web typecheck/build、backend 18 通过；最终浏览器验收 `a7090b402c75b1cb1` 通过；源码 `e4d414d` 已由 PR #121 合入 `main` `70e28e2`。限制：元数据接口仍整份读取文件字节；坏图、大图与 HTML 在真实浏览器中的表现未测，大图内存未单独测量；分页外旧版由单测覆盖。
- 动效第二轮 `/chat`：仅记录本文件，新增源码 0，未跑测试/build；reduce 模拟 `matchMedia` 仍 false，本轮未通过实屏 reduce，不写成通过；`git diff --check` 通过。
- 能力 task 11（成果 PDF 原生预览）：API 一审 `a1f97d67a04771d6d` 3 文件 26 用例通过，api typecheck/build、`lint:focus`/`lint:contract` 通过；Web 一审 readerror mustfix 修复后 3 文件 97 用例通过（`ada812d28cc77c763`），二审 `ab003ecf947f052cb` 通过无 mustfix；第三轮 Opus review `a18c436ffd11f7505` 通过无 mustfix（4 文件 110 用例）；生产隔离浏览器 `a46306ac16227d1ce` 通过（见运行记录），证据在 `/Users/xbjt/.claude/jobs/642ddc7d/tmp/pdf-preview-production/`；主线程最终复验 full web 119 文件 1412 用例 39.50s、api/web typecheck/build、backend 3 文件 26 用例 2.62s 通过（loading 单文件 13 用例连续 5 次通过，修复仅测试）。限制：只测 Chromium，加密/坏结构 PDF 由原生 viewer 兜底未逐一实测，大 PDF 未压测；实现 `ca5cb28` 与文档 `9caf2fa` 已由 PR #123 合入 `main` `b683903`。
- 动效第三轮 `/memory`：仅代码覆盖的 no-op，实屏被登录阻挡；未跑测试/build，不写成通过。
- 动效第四轮 `/schedules`：记录部分实屏 no-op（空态、新建、专家选择、开关、dirty 取消保留草稿、焦点回新建、150ms overlay、reduce `0.01ms`/delay `0ms`）；非空列表、编辑、删除、pending、冲突、路由 blocker 仅代码检查，未测帧率与完整退出时序；新增源码 0，不写成全部覆盖。
- 能力 task 12（子智能体自身专家记忆）：源码整体 `a9f539537d2542d89` PASS、`sessions` format `a8c52733b5e29b393` PASS；历史评审问题（首轮 `ad8dc6d251f21accb`、第二轮 `a404e1a84b82c0403`、第二路并发 `a18691bdeec312cf2` 的 3 个阻塞、第三轮 `a72a49738d709d5d1` 两项）均已修复。stable 25 文件 376、web 72、outputs 31、migration `generate` + `migrate` 隔离库通过；SDK 最新接口 16/16 PASS（`/tmp/subagent-memory-sdk-final-interface-unique.json`）；浏览器全部 PASS、0 残留。运行整合 13 文件 195/195 PASS（`/tmp/subagent-memory-runtime-final-green.json`）；未提交，无整体通过结论。
- `git diff --check`：本轮文档改动后 exit 0，无空白错误。
