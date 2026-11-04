---
extends: refactoring
when: 在本仓库做行为保持的结构性改动时。
---

# Refactoring 项目适配

- **Replace** "Pin the behavior contract first." 先用 **how** 技能定位受影响子系统与当前行为，再用获准的现有测试、快照、等价性脚本或真实运行证据固定契约。Type check 与 lint 仍不能作为等价证明。
- **Replace** "Rebase into small ordered commits. A subtraction commit, then the reshape, then any follow-on cleanup. Shape them with the **sequence-verifiable-units** principle skill, so each behavior-preserving slice stays green before the next. Run **Opening a PR**." 结构改动仍按原契约逐片保持 green 并完成行为验证，不扩新功能；未获本任务 commit 授权时以已验证的未提交 diff 完成，不 rebase、不 commit；获授权后仅在本任务授权范围内整理为小而有序的提交。后续 push 与 PR 仍需各自授权，按 [opening-a-pr](./opening-a-pr.md) 项目适配判断，不能由 commit 授权推导。
