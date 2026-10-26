# Native 手写逻辑简化 第 1 轮（native-logic-round-1）

## 目标

- 用户授权定期检查仓库手写逻辑能否复用现有技术栈原生能力简化，目标是提高稳定性与响应性，且不引入过度复杂。
- 本轮验收：完成一次前后端只读探索，固定候选契约，实施通过独立评审的最小改动；按用户授权提交 PR 并合并；合并后删除本 worktree；主 checkout main 快进到最新 origin/main。
- 若没有候选同时满足「更简单、不丢功能、有可验证的稳定性或响应性收益」，记录证据并按无源码改动交付，不为凑改动而改。

## 方案

- 固定流程：Opus 前后端并行只读探索 → Opus 固定候选契约（文件边界、行为不变量、验证命令、回滚点）→ Sonnet 子代理按契约实现 → Opus 独立评审 → 按改动范围验证 → 提交/PR/合并 → 清理本树 → 主 checkout 快进。
- 主会话不写代码，只负责共享契约、派发、组织评审、合并与整体验证；所有源码与测试改动由 Sonnet 子代理完成；评审由 Opus 子代理独立执行。
- 选型顺序按 `CLAUDE.md`：先看项目现有实现，再用已安装依赖或 Node/React/BullMQ/TanStack Query/Effect 等原生能力，最后才考虑新依赖或自研；本轮不新增依赖。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport-worktrees/native-logic-round-1`
- 分支：`refactor/native-logic-round-1`；起始 `HEAD` 与 `origin/main`：`e824377506a2942d311bbf775d2bec3334155cd4`；初始未提交差异为空。
- 主 checkout：`/Users/xbjt/Documents/myself/agentport`，`main` 同为 `e824377506a2942d311bbf775d2bec3334155cd4`，工作区干净；本任务只在合并后快进主 checkout。
- 其他 worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/skill-provenance`（`feat/skill-provenance`）不归本任务，不读取、不修改、不清理。
- 工作流与文件边界（各工作流由不同 Sonnet 子代理负责，互不触碰对方文件）：
  - A：`packages/api/src/features/servers/agent-invoker.ts` + 新建 `packages/api/test/agent-invoker-cancel-wait.test.ts`。
  - B：`packages/api/src/features/servers/ssrf.ts` + 独立 ssrf 测试。
  - C：`packages/web/src/lib/queries.ts` + agents-lifecycle 测试。
  - 记录：`docs/tasks/native-logic-round-1.md`，由主会话维护。
- 未列入上述清单的源码、测试、配置、其他文档一律不改。

## 当前有效决定

- 用户真实授权：按上述判据实施本轮简化；代码完成后经 Opus 独立评审；评审通过后提交、推送、创建 PR 并合并；合并后删除本 worktree，主 checkout `main` 快进。按项目规则不触发、不等待 CI，不开启 PR 监控。
- 主会话不写代码；A/B/C 全部由 Sonnet 子代理执行；评审由 Opus 子代理独立完成，评审未过不提交。
- 执行子代理的范围限制由主会话在派发时设定，不是用户决定：只在 worktree 内动作、不自行派发代理、不自行提交；集成验证必须使用独立 Postgres/Redis，禁止共享 DB/服务/.env/登录态。
- 范围变化先改本记录再动手；本轮默认不新增依赖。

## 本轮固定契约

### A：可取消轮询等待

- 位置：`agent-invoker.ts` 的终态等待循环。
- 改动：`await new Promise(setTimeout)` 改为 `import { setTimeout as sleep } from 'node:timers/promises'`，传入现有 `signal`。
- 行为不变量：每次等待仍为 `Math.min(POLL_MS, Math.max(0, deadline - Date.now()))`；deadline 上限仍为 `Math.min(timeoutMs ?? agent.timeoutMs, 30 * 60_000)`；取消时立即走现有 `cancelled()`（取消 run、写审计、抛 `UPSTREAM_FAILED`），不再等当前 2 秒睡眠；`sleep` 的非取消异常原样上抛；醒来后、读 DB 前检查 `signal?.aborted`，取消时不再多读一次 `getRun`；保留终态判断、失败消息、最后一次取消检查、超时 `abortRun({ reason: 'deadline' })`、消息读取、准入、`activeInvokes` 与 `finally` 递减、入队失败收口与固定错误文案、审计。
- 回归测试：新建 mock DB/repo/queue/audit/cancel-run 的独立测试。先证明旧实现：睡眠中取消需约 2 秒且取消前多一次 `getRun`；修复后证明：取消在 500ms 内完成、未调用 `getRun`；正常醒来仍读 DB 并返回助手文本。

### B：SSRF IPv4 BlockList

- `ssrf.ts` 的 IPv4 判断改用 Node `net.BlockList`，保留现有全部私有/保留网段与 IPv6 行为；新增独立 ssrf 测试覆盖网段与 IPv6。

### C：useAgent 复用 agentsQuery

- `queries.ts` 的 `useAgent` 改为 `useQuery({ ...agentsQuery, select: (agents) => agents.find(...) ?? null })`；agents-lifecycle 测试覆盖命中与未命中。

## 已评估取舍

- 采纳 A：手写 2 秒轮询睡眠改原生可取消等待，直接消除取消延迟与多余 DB 读，改动最小、有可测响应性收益。
- 采纳 B：IPv4 网段判断改 `BlockList`，复用原生实现，保持现有网段与 IPv6 语义。
- 采纳 C：`useAgent` 改用 `select` 订阅缓存中的单个专家，避免展开完整查询结果造成无关通知；继续复用现有缓存键与请求路径。
- 不做 QueueEvents：需要独立 Redis 连接、连接生命周期与关停接线、测试隔离，扩大本轮生命周期范围；本轮只做可取消 sleep。同理不做 Queue+QueueEvents helper 去重，连接策略、错误映射、超时语义不同，抽象会隐藏差异。
- 其余候选（p-limit 并发、useMediaQuery 去重、OpenUI 防抖、其余 timer 清理、入队重试 helper、`Intl.RelativeTimeFormat` 等）收益低于改动成本，或会改变既有行为语义，本轮不纳入。

## 步骤

- [x] 进树并记录绝对路径、HEAD、初始差异
- [x] 读 `CLAUDE.md`、`docs/DEV-WORKFLOW.md`、`docs/PITFALLS.md`
- [x] 只读扫描候选，规划 A/B/C 与文件边界
- [x] 固定 A/B/C 契约并写入本记录
- [x] A：先写回归测试并确认红，再最小实现并确认绿（2 项红绿）
- [x] B：实现与 38 项测试完成
- [x] C：实现与执行报告完成
- [x] 最终 11 文件回归与 web 回归/build 结果返回
- [x] Opus 独立评审 B（通过）
- [x] Opus 独立评审 A、C（均通过，无阻断项）
- [ ] 提交、推送、创建 PR 并合并
- [ ] 合并后 `git worktree remove` 本树；主 checkout `git pull --ff-only`
- [x] 更新本记录「下一步/验证」

## 改动文件

- A（Sonnet 子代理）：`packages/api/src/features/servers/agent-invoker.ts`（可取消 sleep + 醒来后取消检查）、`packages/api/test/agent-invoker-cancel-wait.test.ts`（新建，不依赖真实 DB/Redis）。
- B（Sonnet 子代理）：`packages/api/src/features/servers/ssrf.ts` + 独立 ssrf 测试。
- C（Sonnet 子代理）：`packages/web/src/lib/queries.ts` + agents-lifecycle 测试。
- 记录：`docs/tasks/native-logic-round-1.md`。
- 其他文件一律不改。

## 验证

### 主会话已实测

- 最终 backend：11 文件 86 项通过，0 skip；使用专用 Postgres/Redis，未共享服务。
- 最终 web：73 文件 711 项通过，0 skip。
- C5 新测试：红（2 失败 3 通过）→ 绿；`agents-lifecycle` 23 项、C 定向 64 项通过。
- 7 包 `typecheck`、`api`/`web` build、`lint:focus`、`lint:contract`、6 个改动文件 Biome、`git diff --check` 均通过。
- 隔离容器 `pace-native-round1-pg`/`redis` 及数据卷已清理。
- 未做完整产品 E2E、真实模型调用与浏览器性能采样；不量化端到端收益。

### 独立评审

- B：Opus 评审通过，400,408 次地址判断与 75 次 URL/错误结果对照零差异。
- A：Opus 评审通过；原生等待、取消收口、截止规则、终态保护与并发释放均保留，独立复跑 2 项测试通过。
- C：Opus 评审通过；缓存/失效/去重、初始加载和 refetch 调用兼容；独立复跑 3 文件 59 项测试与前端类型检查通过。

### 过程记录

- C 执行者首次批量跑 preview-on-demand 时一个计数断言偶发失败；随后单跑 5 次、批量运行与主会话全量 web 均通过，按真实过程记录。

### 冲突

- 未发现产品代码与文档冲突；本任务早期临时记录中的状态与数字错误已在本文件纠正。

### 交付状态

- 代码验证和 A/B/C 独立评审全部通过，准备提交、推送、创建并合并 PR。
- PR 合并与 worktree 清理结果以 GitHub 和 Git 实际状态为准。

## 下一步

- 按用户授权提交/PR/合并，清理本树并快进主 checkout。
- PR 说明已备于 `.tmp/native-round1-pr.md`（忽略目录，未跟踪）。
