---
extends: feature
when: 在本仓库实现新功能或修改行为时。
---

# Feature 项目适配

- **In** "Delegate code-writing to a subagent" 保留该步的委派 model、scope、验收与 arena 规则；把「Give every file-writing delegate its own worktree」及其先 commit 再建树的要求替换为 [docs/DEV-WORKFLOW.md](../../docs/DEV-WORKFLOW.md) §2：子代理默认共享当前任务树、按文件边界并行，不各自建树；只有确需额外隔离时才加 `isolation: worktree`，同样落在 `.claude/worktrees/<slug>`，不套娃。
- **In** "Commit liberally." 本句按根 `CLAUDE.md`「交付」替换：只有用户在本任务明确授权时才 commit；未授权时保留 diff，继续完成 review 与验证，停在「验证完成、未提交差异」。
- **Replace** "Rebase into small, ordered commits. Stack follow-ups. Use the **sequence-verifiable-units** principle skill, building, verifying, and committing each small unit before the next." 每个单元仍先 building、verifying 再进入下一个，但不授权自动逐单元提交；未获本任务 commit 授权时以已验证的未提交 diff 完成，不 rebase、不 commit；获授权后仅在本任务授权范围内整理为小而有序的提交。push 与 PR 仍需各自授权，按 [opening-a-pr](./opening-a-pr.md) 项目适配判断，不能由 commit 授权推导。
