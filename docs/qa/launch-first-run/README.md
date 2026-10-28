# 桌面首次用户 QA 证据

本目录保留四类桌面用户的真实浏览器报告与截图。移动端按用户明确要求排除。测试使用已有大量测试资源的开发环境，不能视为空库首次安装验收。

| 视角 | 首轮 | 修复后复跑 | 验证边界 |
| --- | --- | --- | --- |
| 不耐烦 | [报告](impatient.md) | [PASS](rerun-impatient.md) | 可见专家入口、生成报告、发现并预览成果 |
| 字面理解 | [报告](literal.md) | [PASS](rerun-literal.md) | 名称优先创建、标识自动生成、开始对话、统一成果名称；旧机器名资源保持原数据 |
| 怀疑者 | [报告](skeptic.md) | [PASS](rerun-skeptic.md) | 页面明确 SDK 预批准与工具自身审批不同；未触发真实审批 |
| 破坏者 | [报告](breaker.md) | [中间版本 FAIL](rerun-breaker.md) → [最终定点 PASS](rerun-breaker-final.md) | 常规刷新与隔离通过；最终版本验证已有/新会话同文草稿接受后、刷新及切换均保留，普通发送清槽 |

关键前后对照：

- 专家入口：[之前](screens/literal-11-new-chat.png)／[之后](screens/rerun-impatient-05-new-chat.png)。
- 创建表单：[之前](screens/literal-17-create-expert-form.png)／[之后](screens/rerun-literal-11-form-name-first.png)。
- 成果入口：[之后](screens/rerun-impatient-11-outputs-open.png)。
- 权限说明：[之后](screens/rerun-skeptic-01-permissions.png)。
- 草稿刷新：[之前丢失](screens/breaker-06-draft-after-refresh.png)／[常规刷新恢复](screens/rerun-breaker-06-a-draft-after-refresh.png)。
- 同文重写：[中间版本刷新丢失](screens/rerun-breaker-25-same-text-after-reload.png)／[最终已有会话刷新保留](screens/rerun-breaker-final-05-a-reload.png)／[最终新会话刷新保留](screens/rerun-breaker-final-10-new-reload.png)。

报告是各阶段的原始观测，不回写旧失败为通过；其中对影响人数的“预计”不作为实测命中人数。部分报告含原临时目录路径，截图按文件名可在本目录 `screens/` 查找；凭据、Cookie、脚本不纳入证据。最终汇总见 [任务记录](../../tasks/launch-qa-first-run.md)。
