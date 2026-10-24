# 踩坑记录

> 跨任务反复出现的坑统一记在这里，由 `CLAUDE.md` 指向。开始新任务前、或遇到报错时先读本文件。
> 每条格式固定：现象 → 原因 → 规避。只写代码和文档里看不出来的东西。

## Worktree 是干净 checkout，`.env` 不会自动带过去

- **现象**：新 worktree 里起服务直接失败，报缺 `APP_SECRET_KEY` / `ANTHROPIC_API_KEY` 等。
- **原因**：worktree 只含受版本控制的文件，`.env` 被 gitignore，不会被复制。
- **规避**：项目根 `.worktreeinclude` 已列 `.env`、`.env.local`，Claude Code 建树时自动复制。新增必填的 env 文件时同步加进去。

## 多个 worktree 同时跑全栈 compose 会互相踩

- **现象**：两个窗口的任务看到对方的数据/容器，或 `3000/5432/6379` 端口被占起不来。
- **原因**：`docker-compose.yml` 写死 `name: agentport` 和固定端口，所有 worktree 共用同一 compose 项目、卷、端口。
- **规避**：只让主 checkout 跑基础设施（postgres/redis），各 worktree 只跑应用进程连同一套；确需各自全栈时用 `COMPOSE_PROJECT_NAME` + 端口变量隔离。

## EnterWorktree 的 name 只接受 ASCII slug

- **现象**：用中文任务名调用 `EnterWorktree` 会失败。
- **原因**：工具限制 name 每段只能是字母、数字、点、下划线、短横线（最长 64）。
- **规避**：worktree 名用 `log-to-file` 这类 ASCII slug；中文只写在 `docs/tasks/<slug>.md` 的标题里。

## recharts 的 `strokeWidth` 不是图标违例

- **现象**：`overview.tsx` 里 `<Area strokeWidth={1.5}>` 看着违反「图标统一 1.75」。
- **原因**：那是图表描边宽度，与 lucide 图标无关；规则针对的是 lucide 组件。
- **规避**：契约检查只匹配从 `lucide-react` 导入的组件名；不要为此改图表数值。

## 不要把任务记录写进 `.claude/worktrees/`

- **现象**：写在 worktree 目录里的记录，任务收尾后无法追溯。
- **原因**：worktree 退出即删或按周期清理，且 `.claude/worktrees/` 被 gitignore。
- **规避**：任务记录写 `docs/tasks/<slug>.md`，踩坑写 `docs/PITFALLS.md`，都在 worktree 内创建并随分支提交。
