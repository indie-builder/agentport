# worktree 位置规则

## 目标
把 worktree 的固定位置写进研发流程权威文档，消除 `git worktree add <abs-path>` 的自由措辞，避免把主 checkout 当成当前任务 worktree 而嵌套建树。

## 方案
在 `docs/DEV-WORKFLOW.md` §2-2 声明唯一位置：主 checkout 的 `.claude/worktrees/<任务 slug>`；默认 `EnterWorktree`，手动 `git worktree add` 也使用同一根目录，从刚 fetch 的 `origin/main` 建树；不建在仓库同级或任何已有任务 worktree 内部。保留 fetch、起点核对与初始差异归属要求；`CLAUDE.md` 已有指针，不重复。

## 基线与范围
- 起始 commit：`f33849d679da84e741219fdde3d5fc17b8d20c78`
- 初始工作区：干净（`git status --porcelain` 为空）
- 允许改动：`docs/DEV-WORKFLOW.md`、`docs/tasks/worktree-location-rules.md`
- 不在本任务：个人记忆 `worktree-workflow-and-task-records.md` 由主会话删除；不重构历史 worktree 位置。

## 当前有效决定
- worktree 固定建在主 checkout 的 `.claude/worktrees/<任务 slug>`，默认 `EnterWorktree`。
- 手动 `git worktree add` 同样使用该根目录，起点为最新 `origin/main`。
- 不建在仓库同级或已有任务 worktree 内部；主 checkout 不是当前任务 worktree。
- 用户已授权提交、创建 PR、合并与收尾；不触发或等待 CI。

## 已替代项及原因
- 旧措辞「从主仓库用绝对路径建树」（`<abs-path>` 自由选择）→ 位置固定，避免同级树与嵌套树。
- 个人记忆中的工作流内容已在项目文档里；删除该记忆，不把其旧规则再引入流程。

## 步骤
- [x] 读取 `docs/PITFALLS.md`、`docs/DEV-WORKFLOW.md`、`CLAUDE.md`
- [x] 记录起始 commit 与初始 `git status`
- [x] 改写 `docs/DEV-WORKFLOW.md` §2-2
- [x] 创建本任务记录
- [x] 运行 `git diff --check`
- [x] 提交 `4214935`、创建 PR #78、合并 `d9fc977`

## 改动文件
- `docs/DEV-WORKFLOW.md`
- `docs/tasks/worktree-location-rules.md`

## 下一步
个人记忆 `worktree-workflow-and-task-records.md`、MEMORY.md 索引入口及其他两份记忆中的旧引用已删除；源码无改动。Opus 评审指出「任何已有 worktree」会把主 checkout 也包含进去，已限定为「已有任务 worktree」。成果已提交为 `4214935`，经 PR #78 合并为 `d9fc977`，规则文本已合入 main 的 `docs/DEV-WORKFLOW.md` §2-2（可用 `git log` 核对）。任务 worktree 是否已删除未在本记录内核实。

## 验证
- `git status --porcelain=v1`：仅 `M docs/DEV-WORKFLOW.md`、`?? docs/tasks/worktree-location-rules.md`
- `git diff --check`：通过（无输出）；最终独立 Opus 复核通过。
- 个人记忆文件已删除，memory 目录搜索旧记忆名称无匹配。
- `git diff --no-index --check /dev/null docs/tasks/worktree-location-rules.md`：通过（无空白错误）
- 主 checkout：本任务未改；worktree 隔离守卫拒绝跨树 `git -C` 状态查询
