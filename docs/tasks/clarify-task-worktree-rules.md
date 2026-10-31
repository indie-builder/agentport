# 明确任务与 worktree 建树、续做规则

## 目标

把「每个独立新开发任务首次写入前建专属 worktree、续做复用原树」的已确认决定落实到现有规则文档，消除新任务与续做任务混用、主会话未入树就派发、子代理各自建树等歧义。

验收：

1. `docs/DEV-WORKFLOW.md` §2 第 2 步明确新建任务与续做任务的分支，任务按独立目标/验收划分。
2. §2 第 2 步完成判据明确以「主会话位于目标 worktree」为准，并说明子代理 `isolation: worktree` 不能替代。
3. §2 第 4 步明确子代理默认共享当前任务树、按文件边界并行。
4. `CLAUDE.md` 的研发流程指针收紧为「首次写入前 / 续做恢复时必读 §2」，不复制流程细节。
5. 只改 `CLAUDE.md`、`docs/DEV-WORKFLOW.md` 与本记录，无其他文件改动。
6. `docs/DEV-WORKFLOW.md` §2-7 改为「工作区收尾（`ExitWorktree`）」，明确「收尾工作区」的语义、只处理本任务、清理前核对、保留分支、回主 checkout 快进 main 的规则与完成判据。
7. `CLAUDE.md` 的清理摘要收紧为指向 §2-7 的短指针，不复制细节。

## 方案

只做文档措辞收敛，不新增流程、脚本、hooks 或依赖：

- `docs/DEV-WORKFLOW.md` §2 第 2 步：补「新建 vs 续做」分支、任务分割依据、主会话先入树、额外隔离树同守固定位置与禁止套娃；`fetch origin main` 保留为新建任务前提；完成判据主语改为主会话。
- `docs/DEV-WORKFLOW.md` §2 第 4 步：补子代理默认共享任务树、按文件边界并行。
- `docs/DEV-WORKFLOW.md` §2-7：定义「收尾工作区」= 清理本任务已交付 worktree、退出回主 checkout、更新 main；口令本身不自动授权 commit/push/merge；清理前核对提交与合并（接受 PR 真实合并状态，不能只靠祖先判断）、工作区干净、无其他会话占用；删除后保留本地与远程分支；回主 checkout `fetch` 后 `merge --ff-only`，异常保留报告且不 reset、不 stash。
- `CLAUDE.md`：现有研发流程指针一行收紧触发条件，引用而不复制；清理摘要改为指向 §2-7 的短指针。

## 基线与范围

- 基线：`origin/main` = `ae8407d402026ccadc1b8cb373cf34c184328b38`，与当前 HEAD 一致。
- 初始未提交差异：无（`git status --short` 无输出）。
- 允许改动：`CLAUDE.md`、`docs/DEV-WORKFLOW.md`、本记录。
- 禁止：修改其他文件、新建 worktree；Git 交付按当前有效决定授权执行。

## 当前有效决定

用户 2026-10-31 明确同意上一轮 Opus 建议：

- 每个独立新开发任务首次写入前新建专属 worktree。
- 续做同一未完成任务复用原树与任务记录，不重新建树或重置基线。
- 主会话先进入目标任务树再派发代码执行；仅对子代理使用 `isolation: worktree` 不能替代。
- 子代理默认在任务树内按文件边界并行；额外隔离树也遵守固定位置、禁止套娃。
- 任务分割按独立目标/验收；同一目标内的步骤与子任务不各自建树。
- 用户 2026-10-31 本轮明确授权：commit、push、开 PR、合并，删除本任务已完成并合入 main 的 worktree，返回主 checkout 并快进更新 main。
- 「收尾工作区」= 清理本任务已交付的 worktree、退出回主 checkout、更新 main；只处理本任务，不全局清扫；该口令本身不自动授权 commit/push/merge，只有本轮这类明确授权才执行。
- 收尾清理判据与主 checkout 快进规则按本轮 Opus 决定写入 `docs/DEV-WORKFLOW.md` §2-7：清理前核对全部提交且已合入 main（接受 PR 真实合并状态，不能仅靠祖先判断）、`git status --porcelain` 为空、无其他会话占用；删除后保留本地与远程分支；回主 checkout 确认 main 且干净后 `git fetch origin` + `git merge --ff-only origin/main`，异常保留报告，不 reset、不 stash。

## 已替代项及原因

- 旧决定「用户仅授权修改，未授权提交合并」已被本轮明确授权 commit/push/PR/merge/收尾取代；过往阶段按历史保留。

## 步骤

- [x] 读 `CLAUDE.md`、`docs/DEV-WORKFLOW.md` §2/§3、`docs/PITFALLS.md` 相关条目及 ub-mode / writing-for-agents 原则。
- [x] 先写本任务记录。
- [x] 改 `docs/DEV-WORKFLOW.md` §2 第 2 步与第 4 步。
- [x] 改 `CLAUDE.md` 研发流程指针。
- [x] 跑 `git diff --check` 与 `git diff --stat`，回报精确改动与行号。
- [x] 首轮独立 Opus review 发现 1 处问题，已修正并经定点复核通过。
- [x] 已按 review 修正 `docs/DEV-WORKFLOW.md:37` 完成判据：新建时 HEAD 与声明起点一致，续做保留原基线与记录、HEAD 可含本任务后续提交；仅改该行。
- [x] Opus 定点复核通过：仅核对 `docs/DEV-WORKFLOW.md:27–48` 与本记录，原阻塞已解决，未引入新的相邻矛盾。
- [x] 按本轮 Opus 决定先同步本记录「当前有效决定」「已替代项」。
- [x] 改 `docs/DEV-WORKFLOW.md` §2-7 为「工作区收尾（`ExitWorktree`）」，写入清理判据、删树规则、回主 checkout 快进规则与完成判据。
- [x] 改 `CLAUDE.md` 清理摘要为指向 §2-7 的短指针。
- [x] 跑 `git diff --check` 自检。
- [x] Opus 复核本轮文档改动：正文沿用前轮通过结论；本轮定点确认第 31 行与第 42 行授权冲突已解除，整体审查通过，无剩余阻塞。
- [ ] 复核通过后提交、开 PR、合并（本轮已授权）。
- [ ] 按 §2-7 收尾本任务 worktree 并回主 checkout 快进 main（本轮已授权）。

## 改动文件

- `docs/tasks/clarify-task-worktree-rules.md`（本记录）
- `docs/DEV-WORKFLOW.md`
- `CLAUDE.md`

## 下一步

整体审查已通过；待提交、push、开 PR、合并，再按 §2-7 实际收尾本任务 worktree 并回主 checkout 快进 main。上述交付与收尾步骤均尚未执行，当前未提交、未合入，不声称已交付。

## 验证

纯文档改动，不伪造红绿测试；以 diff 自检与独立审查作为验证方式。

- `/usr/bin/git diff --check`：通过，无输出（无空白/冲突标记错误）。
- `/usr/bin/git diff --stat`：`CLAUDE.md | 2 +-`、`docs/DEV-WORKFLOW.md | 8 +++++---`，合计 2 文件、6 行新增、4 行删除；另有本记录为未跟踪新文件。
- `/usr/bin/git status --short`：仅 `M CLAUDE.md`、`M docs/DEV-WORKFLOW.md`、`?? docs/tasks/clarify-task-worktree-rules.md`，无范围外改动。
- 首轮独立 Opus review：固定基线 `ae8407d402026ccadc1b8cb373cf34c184328b38`，范围为上述三个文件。新建任务、主会话先入树、仅子代理隔离不能替代、多个同任务子代理共享树与文件边界，以及固定位置/禁止套娃/授权规则均已核对。首轮发现 `docs/DEV-WORKFLOW.md:37` 的通用完成判据要求 HEAD 与起点一致，与第 32 行的续做规则不够一致；现已修正并复核通过：第 37 行区分新建与续做，允许续做 HEAD 包含本任务后续提交，保留原基线与任务记录，与第 32–36 行一致，未引入新的相邻矛盾。
- 本轮 `/usr/bin/git diff --check`：退出码 0，无输出。
- 本轮 `/usr/bin/git diff --no-index --check /dev/null docs/tasks/clarify-task-worktree-rules.md`：退出码 1，无诊断输出；表示新文件存在差异，未报告空白错误。
- 修正轮 `/usr/bin/git diff --check`：退出码 0，无输出。
- 定点复核轮：仅更新本记录的 review 勾选、下一步与验证；更新后 `/usr/bin/git diff --check` 通过，无输出。
- 本轮（§2-7 与 `CLAUDE.md` 指针）`/usr/bin/git diff --check`：退出码 0，无输出。
- 本轮 `/usr/bin/git diff --stat`：`CLAUDE.md | 4 ++--`、`docs/DEV-WORKFLOW.md | 21 +++++++++++++++------`，合计 2 文件、17 行新增、8 行删除；本记录为未跟踪新文件，不计入。
- 本轮 `/usr/bin/git status --porcelain`：仅 `M CLAUDE.md`、`M docs/DEV-WORKFLOW.md`、`?? docs/tasks/clarify-task-worktree-rules.md`，无范围外改动。
- 最终定点复核实际结果：仅读取本记录；第 31 行已改为「禁止：修改其他文件、新建 worktree；Git 交付按当前有效决定授权执行。」，与第 42 行明确授权一致，唯一阻塞已解除。结合前轮 Opus 已通过的 `CLAUDE.md` 与 `docs/DEV-WORKFLOW.md` 正文结论，整体审查通过，无剩余阻塞；仅更新本记录的 review 勾选、实际结果与下一步，未执行提交、PR、合并或工作区收尾。
- 最终定点复核后 `/usr/bin/git diff --check`：退出码 0，无输出。
