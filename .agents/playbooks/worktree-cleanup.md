---
extends: worktree-cleanup
when: 清理本任务已交付的 worktree 或用户要求回收工作区磁盘时。
---

# Worktree cleanup 项目适配

- **Replace** "Snapshot and audit." 按 [docs/DEV-WORKFLOW.md](../../docs/DEV-WORKFLOW.md) §2-7 固定本任务目标：记录 `df -h /`，用 `git worktree list` 与 `git status`、diff 对相关路径做只读检查，只核对本任务已交付的 worktree，不做全局审计或转录扫描。
- **Replace** "Prune the confirmed set." 仅当本任务已交付、已合并、不被其他会话占用且 §2-7 条件满足时清理；只移除确认为本任务的路径，不把 `--force`、`rm -rf` 或 `git worktree prune` 当作兜底；只有 `node_modules` 等可重建依赖挡住时才按 §2-7 用 `--force`，无法恢复的数据按上游第 4 步保留并报告。
- **Replace** "Simulators and other reclaimers." 本任务清理范围到此结束；无与本任务明确相关的授权，不扩展到模拟器、编辑器缓存、package cache 或用户全局转录。
