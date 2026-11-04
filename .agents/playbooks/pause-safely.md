---
extends: pause-safely
when: 用户明确要求暂停并保存进度时。
---

# Pause safely 项目适配

- **Replace** "Make the work durable." 恢复依据是本任务按 pstack 原生机制留下的 checkpoint 与工作树实际 Git 状态（分支、HEAD、`git status`、未提交 diff），不指向固定 `docs/tasks/` 记录，按 [docs/DEV-WORKFLOW.md](../../docs/DEV-WORKFLOW.md) §3 续做。仍须遵守提交授权：只有本任务已获提交授权时才把未提交改动整理为清晰的 `wip:` commit；未获授权时保留当前 diff 并在状态说明里写清，不自动建 WIP 提交。
