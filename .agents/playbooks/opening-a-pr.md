---
extends: opening-a-pr
when: 在本仓库准备提交、推送或开 PR 时。
---

# Opening a PR 项目适配

- **Replace** "Work from a git worktree off trunk, and keep unrelated work out of it." 按 [docs/DEV-WORKFLOW.md](../../docs/DEV-WORKFLOW.md) §2 使用固定位置 `.claude/worktrees/<slug>` 并优先复用本任务既有任务树；脏树或缠绕状态按 §2 的撤销与续做规则处理，不执行上游的 reset-hard 或重建。提交、合并或部署前仍须确认本任务所有写入代理已结束，并运行 `git status` 读清待交付的树。无关改动不得混入本任务树。
- **Replace** "Rebase into small, landable commits." 按根 `CLAUDE.md`「交付」分别判断 commit、push 与 PR 授权：未授权时停在已验证的 diff，不 commit；commit 授权不自动扩大到 push 或 PR。按授权边界组织 small、可落地的提交。
- **Replace** "Run `/deslop` over the diff before commit." 提交前保留独立 Opus 终审，Sonnet 初审与辅助审查按需；不强制额外重构。PR 标题、说明与提交说明用中文，遵循项目格式。
