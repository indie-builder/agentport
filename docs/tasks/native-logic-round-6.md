# 手写逻辑简化：第六轮

## 目标

复用项目现有技术栈和原生能力，简化实际值得调整的逻辑，提高稳定性或响应效率。用户授权实施、提交并合并 PR，删除合并工作区、更新 main。

## 方案

Opus 并行窄域检查文件处理与前端状态；选择收益明确的最小完整修改，由 Sonnet 执行，独立 Opus 评审与范围验证后交付。没有候选则不制造改动。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport-worktrees/native-logic-round-6`
- 分支：`refactor/native-logic-round-6`
- 起始 origin/main：`4fcf101f79c80c9a1b14a227b5b15c9acd6606b7`
- 初始未提交差异：空。
- 主 checkout 原有 `.vitest/json/output.json` 差异不属于本轮，不覆盖或提交。
- 本轮最终仅新增本记录，无源码、测试或配置改动。
- 不动其他任务 skill-provenance 工作区。

## 当前有效决定

- commit/push/PR/merge、删除已合并工作区、更新 main 均已授权。
- 主会话不写源码或测试；Sonnet 执行，Opus 独立评审，评审通过才提交。
- 子代理不提交只属分工，不能记成用户撤回授权。
- 不触发或等待 CI，不启用 PR 监控，不改共享服务、配置、数据和登录态。
- 保留前五轮成果；不重复已否决或确认无净收益的方案。

## 已替代项及原因

无。

## 步骤

- [x] 同步 main、创建隔离工作区
- [x] 锁定依赖安装及 shared/core/db 构建
- [x] Opus 并行探索并确认本轮不改
- 实现、代码评审、提交和 PR：不适用，没有值得实施的候选。
- 工作区保留：仅含本记录的未提交新增文件，按流程不删除含未提交内容的工作区。
- [x] 核对 main 已与最新 origin/main 一致

## 检查结论

- 前端复选组的数据形态为 Record，使用 Base UI CheckboxGroup 需要数组双向转换，净收益不足；表格已使用 TanStack 原生列显隐和排序。
- 记忆文件读取循环保障 200KB 上限；原生定长 buffer 读取要求 Node 24.19，而项目最低约定为 >=24，不能直接替代。
- 知识文件清理枚举还承担引用、mtime、取消及错误语义，换用 glob 并未省去这些职责。
- 重复 storeBlob 短函数尚无足够收益或实际故障证据，不为抽象制造改动。
- 以上仅限本轮窄域，未发现需要修正的涉及文档与代码冲突。

## 改动文件

- `docs/tasks/native-logic-round-6.md`（未提交）

## 下一步

本轮结束，无代码交付。后续循环可检查其他尚未覆盖的路径；本树保留检查记录，不覆盖其他任务。

## 验证

- 安装锁定依赖、shared/core/db 构建退出码 0。
- 最终 fetch 后 HEAD 与 origin/main 均为 `4fcf101f79c80c9a1b14a227b5b15c9acd6606b7`，无需更新代码。
- 本树仅新增本记录；主 checkout 的原有测试报告差异保持。
- 未修改源码，未跑应用测试或新建 PR；未做全仓审计。
