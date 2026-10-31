# 模型成本优化：按任务性质分配模型

## 目标

降低常规任务对 Opus 的占用，同时保留关键判断与提交前独立终审的质量：

- 改用 Sonnet：常规探索、事实检索与解释、常规审计、按需的初审与风格一致性 review、方案已明确的机械重构。
- 保留 Opus：设计、规划与关键契约、复杂重构、架构/安全/并发/权限/数据丢失判断、独立最终 review。
- 验收：`CLAUDE.md` 与 `docs/DEV-WORKFLOW.md` 中「一律 Opus」等冲突表述清除；分工只在 `CLAUDE.md` 权威定义，流程文档引用；主会话模型不变、不亲写代码。

## 方案

在 `CLAUDE.md`「协作方式」按任务性质划分 Sonnet / Opus，并要求每次派发显式指定模型：常规事实检索 `medium`，其余 `high`，用户当轮明确指定优先。其他 `pstack-models.md` 角色在分工未覆盖时继续生效。

`docs/DEV-WORKFLOW.md` §2-4、§2-5、§5 改为引用该分工，不重复定义；提交前独立 Opus 终审保留，Sonnet 初审按需、不固定加一轮，终审按固定 diff、契约与验证证据聚焦判断，不全量重复探索，后续只复核修复与新增影响。

仓库外的 `~/.claude/pstack-models.md` 与协作记忆 `parallel-execution-principle.md` 属本任务范围并已同步：全局表只补「方案固定/机械重构用 Sonnet，复杂重构必须升级 `opus high`」，不重写角色表；协作记忆改正主会话可读码、审查、合并、按范围验证，并要求提交前独立 Opus 终审。

## 基线与范围

- 基线 commit：`496ccc906f57dda471b0498b0f036c8edfbc4ca3`（`origin/main`），初始工作区干净。
- 允许改动：`CLAUDE.md`、`docs/DEV-WORKFLOW.md`、`docs/tasks/model-cost-tuning.md`；本任务用户授权范围内另含 `~/.claude/pstack-models.md` 与协作记忆 `~/.claude/projects/-Users-xbjt-Documents-myself-agentport/memory/parallel-execution-principle.md`。
- 不写主 checkout；用户 2026-10-31 最新授权提交 PR 并合并，仓库内只提交本记录列出的三份文档，全局 `pstack-models.md` 与协作记忆不进入 PR。

## 当前有效决定

- 用户 2026-10-31：「可以，没有问题，按你的建议来给我调整」，同意上述模型分工调整。
- 常规探索/事实检索/解释、常规审计、可选初审与风格一致性 review、方案明确的机械重构 → Sonnet。
- 设计/规划/关键契约、复杂重构、架构/安全/并发/权限/数据丢失判断、独立最终 review → Opus。
- 主会话模型不变，只编排/读码/验证，不亲写代码；源码/测试/配置/脚本执行均 Sonnet；遇关键判断升级 Opus 后继续。
- 每次显式指定模型与 effort；常规事实检索 `medium`，其余 `high`；用户明确指定优先。
- Sonnet 初审按需，不固定多加一轮；Opus 终审按固定 diff、契约、验证证据与必要关联代码聚焦判断，不全量重复探索；后续只复核修复与新增影响。提交前独立 Opus review 保留。
- 用户 2026-10-31 授权小范围修复：全局表只补复杂重构升级条款、不重写表；§2-4 缩为引用；协作记忆只改必要句子；任务记录按整个任务收尾。当时未授权本任务 commit/push/merge。
- 用户 2026-10-31 最新授权：提交 PR 并合并；范围仅 `CLAUDE.md`、`docs/DEV-WORKFLOW.md`、`docs/tasks/model-cost-tuning.md`，全局 `pstack-models.md` 与协作记忆不进 PR。合并完成前不得声称已合并。

## 已替代项及原因

- 原「设计、规划、方案、探索判断、评审、审计一律派发 Opus」「无论复杂度一律用 Opus」：常规审计与探索无需 Opus，成本过高；改为按任务性质分配。
- 原「上述模型分工高于 `pstack-models.md` 的 per-role 配置」的全面覆盖：改为仅对已列类别覆盖，其余角色继续按 `pstack-models.md` 执行。

## 步骤

- [x] 先创建本任务记录。
- [x] 改 `CLAUDE.md`「协作方式」模型分工，清除与 `pstack-models.md` 的冲突表述。
- [x] 同步 `docs/DEV-WORKFLOW.md` §2-4、§2-5、§5，改为引用 `CLAUDE.md`。
- [x] 自查 diff 与文档内残留的「一律 Opus」表述。
- [x] 全局 `~/.claude/pstack-models.md` 补复杂重构升级 `opus high` 条款（独立 Opus 初次终审发现的遗漏）。
- [x] 协作记忆同步主会话读码/审查/合并/按范围验证边界与「提交前独立 Opus 终审」。
- [x] 独立 Opus 终审复核：通过，无剩余阻断（全局复杂重构升级条款已修复，项目分工/流程/记忆一致）。
- [x] 主会话收尾验证：`git diff --check` exit 0；17 角色完整期望匹配脚本 PASS；role 名对照 pstack 0.15.34 PASS；主模型与全局 import 检查 PASS。
- [x] 用户 2026-10-31 授权提交 PR 并合并。
- [ ] 提交 PR 并合并。

## 改动文件

- `CLAUDE.md`
- `docs/DEV-WORKFLOW.md`
- `docs/tasks/model-cost-tuning.md`
- `~/.claude/pstack-models.md`
- `~/.claude/projects/-Users-xbjt-Documents-myself-agentport/memory/parallel-execution-principle.md`

## 下一步

- 实现与验证无待办；本记录更新后提交 PR 并合并。
- 用户 2026-10-31 最新授权 commit/push/merge；纯规则文档改动，无应用测试。

## 验证

- 纯规则文档改动，不写应用行为测试，也不跑应用测试；以 diff 检查与角色场景审阅验证。
- `git diff --check` 通过；三份文档（`CLAUDE.md`、`docs/DEV-WORKFLOW.md`、本记录）无行尾空白、无冲突标记，旧「一律 Opus」表述已清除；均由主会话实际执行通过。
- 全局 `pstack-models.md` 17 行角色条目逐条匹配当前 pstack 合法 role/model/effort（model ∈ `opus`/`sonnet`/`haiku`/`fable`，effort ∈ `low`/`medium`/`high`/`xhigh`/`max`）；全局 `~/.claude/CLAUDE.md` 的 `@` import（`pstack-models.md`、`RTK.md`）未变，主会话模型保持 `group/opus[1m]`。
- 独立 Opus 初次终审指出全局缺复杂重构升级要求，现已补入；独立 Opus 终审复核通过，无剩余阻断。
