# 平台改进循环（动效 10 分钟 × 能力 30 分钟）

## 目标

用户已在 2026-10-30 明确授权「提交并启动」：先把 `redesign-agent-experience` 的成果提交并合入 `main`，再启动每 10 分钟唤醒的动效车道与每 30 分钟到期的能力车道，持续改进 Agentport / PACE。

验收：

1. 只有一个 cron，按真实时间判断两车道到期，不按 tick 数。
2. 动效车道轮转覆盖全部路由，每周期至少检查一个此前未覆盖页面；无真实收益时记录 no-op，不造动作。
3. 能力车道每轮只交付一个最小完整、高业务价值的功能，按「现有 → 官方 SDK/已装依赖 → 活跃开源 → 自研」选型，经过三轮独立 Opus review 才可交付。
4. 所有写入与合并共用同一把锁，不与其他会话、worktree 或车道抢写。
5. 循环只存在于当前会话；关闭会话即停止，7 天后自动过期，不写永久 harness hook、定时 job 或状态脚本。
6. 验证与提交状态如实记录；失败、跳过、未覆盖不写成通过。

## 方案

### 调度

- 主线程在本轮基线合入 `main` 后，用 `CronCreate` 创建**唯一** cron，每 10 分钟唤醒；创建前与每轮开始时用 `CronList` 确认没有同类任务，避免重复。
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
  }
}
```

### 每轮流程

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

- 项目目录 `/Users/xbjt/Documents/myself/agentport`；启动前分支 `redesign-agent-experience`，基线 `5ccf9d4`，工作树含本轮未提交改动，由主会话先提交并合入 `main`。
- 任务记录进仓库；锁与状态放 git common dir，不提交。
- 允许改动：能力/动效任务对应的源码、测试、配置、脚本与文档，按各任务契约限定；循环本身不新增定时 job、状态脚本或 harness hook。
- 不改变：品牌数值与设计基准、已选技术栈、官方文件系统第一性原则、Claude Agent SDK 单底座、运维不占业务主入口。

## 当前有效决定

- 2026-10-30 用户明确授权「提交并启动」：当前分支提交并合 `main`；启动 10 分钟动效与 30 分钟能力循环；能力车道每个任务完成时提交、推送并合并。
- 单一 cron，按真实时间分车道，不按 tick 数；不启 CI、不开启 PR 监控或冷却等待。
- 主会话只编排/读/验证/提交；Opus 设计与判断；Sonnet 执行；不用 Workflow。
- in-place 优先；干净仓库从最新 `origin/main` 建独立分支；未知差异暂停并报告。
- 共用锁与状态文件放 git common dir，不进仓库。

## 已替代项及原因

- 旧的「未授权 commit / push / merge」被用户 2026-10-30 的明确授权替代。
- 多 cron 或多车道各自计时被单一 cron + 真实时间判断替代；避免重复任务与 tick 漂移。
- 用 Workflow 编排被主会话 + Opus/Sonnet 子代理替代；本项目要求主会话只编排，且已有并行子代理机制。
- 默认建 worktree 被当前会话 in-place 要求替代；例外来源为本轮任务指令，不推广。
- 独立定时 job 或状态脚本被禁止；状态用 git common dir 的 JSON，锁用原子 `mkdir`。

## 步骤

- [x] 创建本记录；更新 `docs/tasks/agent-experience-redesign.md` 授权段与收尾证据。
- [ ] 提交当前分支并合入 `main`，确认工作区干净。
- [ ] `CronList` 确认无同类 cron 后，用 `CronCreate` 创建唯一 10 分钟 cron。
- [ ] 每轮按契约检查两车道；动效轮转页面，能力任务三轮独立 review。
- [ ] 能力任务完成后提交、推送、合并，并更新本记录与待办。
- [ ] 停止时用 cron 工具取消；关闭会话即自动停止。

## 改动文件

- `docs/tasks/platform-improvement-loop.md`
- `docs/tasks/agent-experience-redesign.md`

## 运行记录

无（循环启动后每完成一个车道任务追加一行：时间 / 车道 / 任务 / 结果 / commit 或 PR）。

## 下一步

- 主会话提交并合并当前分支后创建唯一 cron。
- 首轮动效从尚未覆盖的页面开始；首轮能力从 `docs/REMAINING-TODOS.md` 与两类用户主路径中选取最小完整功能，契约由 Opus 固定。

## 验证

- `git diff --check`：通过（exit 0，无空白错误）。
- 本轮收尾验证（主会话执行，按真实结果记录）：
  - 记忆相关：7 个测试文件、109 条通过。
  - 全仓 typecheck：通过。
  - 前端：113 个测试文件、1353 条通过。
  - 后端：2304 条通过、10 条跳过；唯一失败套件因本地 sandbox 镜像缺 GNU bash，属环境问题，不是业务回归。
- 上述数字来自本轮已知验证；本文件创建步骤未重跑全部套件，失败与未覆盖项如实保留。
