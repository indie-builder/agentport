# 精简编码规则

## 目标
将用户指定的四条编码规则纳入项目 CLAUDE.md，语义完整且无重复。

## 方案
已有理论风险规则完整，保留原文；在其后补充入口校验、就地编写、错误处理与函数拆分规则。仅修改规则文档及本记录。

## 基线与范围
- 起始 commit：72a4db49413ec46e36000f9630c06e33196df183，与本地 main 一致。
- 初始 git status --short 为空，无已有未提交差异。
- 允许改动：CLAUDE.md、docs/tasks/simplify-coding-rules.md。

## 当前有效决定
用户明确要求更新项目 CLAUDE.md 中的四条规则，并已明确授权提交、推送、创建 PR 与合并到 main。此前「未授权提交」的记录已被该授权替代。

## 已替代项及原因
无。

## 步骤
- [x] 检索现有条款，确认理论风险规则已存在。
- [x] Opus 确认最小措辞，Sonnet 编辑。
- [x] 独立 Opus review 并执行文档验证。
- [ ] 提交并推送分支 `worktree-simplify-coding-rules`，创建 PR 并按授权合并到 main。

## 改动文件
- CLAUDE.md
- docs/tasks/simplify-coding-rules.md

## 下一步
已获授权：提交、推送、创建 PR 并合并到 main。CI 仅手动触发，合并不等待 CI，不开启 PR 自动监控。

## 验证
- git rev-parse HEAD main：均为 72a4db49413ec46e36000f9630c06e33196df183。
- git status --short：空，初始工作区干净。
- rg 定位：CLAUDE.md 已有理论风险规则，已保留并补充其余三条。
- git diff -- CLAUDE.md：仅新增三条规则，共 3 行，无删除。
- git diff --check：退出码 0，无格式错误。
- rg 核对：四条规则在 CLAUDE.md 第 33–36 行各出现一次。
- 纯文档变更，未运行应用测试或构建。
