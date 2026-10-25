# 最近十次对话的环境与流程改进

## 目标

将复盘中已发生的返工和环境问题落实到既有流程与文档，保护并行任务修改、核实参考 UI 交互、保留当前有效决定，纠正启动及测试说明。

## 方案

详细流程集中在 `docs/DEV-WORKFLOW.md`，事故原因留在 `docs/PITFALLS.md`；README 与运维文档按现有配置校正；全局 CLAUDE 只清理重复及失效的 RTK 引用。

## 基线与范围

- 起点：`0446b2d`；新 worktree 无已有未提交修改。
- 工作区：`.claude/worktrees/retro-environment-improvements`。
- 仓库改动：`CLAUDE.md`、`docs/DEV-WORKFLOW.md`、`docs/PITFALLS.md`、`README.md`、`docs/OPERATIONS.md`、`docs/FIRST-RUN.md` 和本记录。`FIRST-RUN.md` 仅校正仍有效的 E2E 建议并指向运维说明，历史实测记录保留。
- 另有用户全局文件 `/Users/xbjt/.claude/CLAUDE.md`：原有一个模型配置引用、两次 `@RTK.md` 和一个失效的 `.codex/RTK.md` 引用；仅清理后两类问题，不随仓库提交。
- 不触碰其他 worktree，不改业务代码、依赖、hooks 或 CI。

## 当前有效决定

- 用户已授权落实复盘建议，并明确要求本任务提交、推送、创建 PR 后合并；合并后由主会话清理该 worktree 与分支，本任务不删除 worktree/分支、不切主 checkout。
- 保留用户英文原则原文、并行与模型分工、手动 CI 策略。
- 混合文件撤销只恢复本任务差异；参考 UI 先实测交互；合并以用户最新明确决定为准。
- 使用现有检查，不新增阻塞门禁或新的标准文件。

## 已替代项及原因

无。

## 步骤

- [x] Opus 只读设计并确定文件边界
- [x] 建立隔离 worktree 与任务记录
- [x] Sonnet 调整流程与撤销、参考 UI、合并决定的验收条件
- [x] Sonnet 校正运行与测试说明
- [x] 全局 RTK 引用去重，保留模型配置并独立验证
- [x] Opus 独立评审并处理两项事实问题，窄范围复核通过
- [x] 验证差异、命令与配置、文档链接和英文原文保留
- [ ] 提交、推送、创建 PR 并按用户授权合并；worktree 与分支清理由主会话执行

## 改动文件

见“基线与范围”。

## 下一步

无待实现项。文档调整、评审修正、Opus 复核与文档校验均已完成。按用户本轮明确授权执行 commit、push、创建 PR 并合并（标准 merge，不 force、不绕过审批）；合并后由主会话清理该 worktree 与分支，本任务不代为删除。

仓库仅 Markdown 改动，未运行应用测试、类型检查或构建，也未启动服务；CI 按项目规则只手动触发，本任务不触发、不等待。全局文件已单独生效，不属本仓库提交；magpie 后续重新生成可能覆盖引用清理。

## 验证

- `/usr/bin/git rev-parse --short HEAD`：`0446b2d`。
- `/usr/bin/git diff --check`：全部文档差异通过。
- Python 检查 7 个文档的 35 个本地 Markdown 链接目标、3 个标题锚点、代码围栏和冲突标记：通过。
- Python 检查 9 个已有命令入口、web Portless 配置、3 段英文原文：通过。
- Python 检查任务模板与本记录的 9 个栏目，以及撤销、会话恢复、review 未返回状态和授权条件：通过。
- Python 断言全局 RTK 恰好引用一次、目标存在，模型指针与 magpie 标记保留：通过。
- Opus 首轮独立评审发现两项文档事实问题；Sonnet 已修正 RTK 原因断言及 E2E worker 前置说明。修正后重新执行 `diff --check`、35 个本地链接和 3 个锚点检查：通过；Opus 窄范围复核通过，无新增阻塞项。
- 本轮两次包含被包装或嵌入调用的 Git 检查被 worktree 隔离策略拒绝；纯 `/usr/bin/git` 调用成功。具体改写与隔离解析原因未确认，未改隔离策略。
- 交付前复核：`/usr/bin/git diff --check` 无输出；7 个文档的本地链接与 3 个标题锚点全部可解析；代码围栏成对、无冲突标记；`CLAUDE.md` 三段英文原则原文保留。远端分支当时不存在，`origin/main` 与起点同为 `0446b2d`，落后 0 个提交。
