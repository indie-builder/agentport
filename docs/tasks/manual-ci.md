# CI 改为手动运行

## 目标与方案

个人项目按改动范围本地验证，CI 仅通过 workflow_dispatch 手动触发；提交和合并不自动等待 CI 或启动 PR 监控。保留现有检查命令、CI jobs 和独立发布工作流。

## 完成项

- [x] ci.yml 移除 push/pull_request 触发。
- [x] 配置 auto_babysit: false。
- [x] 同步 CLAUDE.md、研发流程、运维说明及踩坑记录。

## 验证

已核对触发配置、发布工作流保持不变，git diff --check 通过；未运行完整测试（仅流程配置与文档改动）。

## 下一步

提交并合并配置调整。
