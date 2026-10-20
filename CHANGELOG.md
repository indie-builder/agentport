# Changelog

所有对外可见的变更记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 [SemVer](https://semver.org/)。

## [0.1.0] - 2026-10-20

首个可用版本。按开发循环记录主要能力，一条一行；详细证据见 [docs/CAPABILITY-GAP.md](docs/CAPABILITY-GAP.md)、[docs/SECURITY.md](docs/SECURITY.md) 与 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

### Added

- 循环 0：仓库骨架、pnpm workspace、Postgres 18/Redis 8 compose、pino 日志、`/health/live` 与 `/health/ready`、首个 Drizzle 迁移
- 循环 1：MCP 三源接入（stdio / 远程 HTTP / HTTP API 转 MCP）、连接测试、AES-256-GCM 密钥加密、单管理员 JWT、文件定义智能体、Docker 沙盒、BullMQ + SSE 运行链路、TypeID
- 循环 2：技能、权限与工具策略、assistant/tool 消息落库、token/延迟指标、版本历史与回滚、审计页、平台 → MCP（`POST /mcp`）、队列重试与错误分类
- 循环 3：工具级启用/禁用、评估用例与回归跑批、智能体导出、`pnpm backup`、运行完成审计
- 循环 4：子智能体单层委派、数据保留任务、`/health/metrics`、E2E 回归、概览页健康卡片
- 循环 5：会话上下文注入（最近 20 条）、会话分支、智能体导入、可访问性与 1280/1024/768/390 响应式收口、空态与错误文案
- 循环 6：部署可移植（命名卷 + `HOST_WORKSPACES_DIR`）、`pnpm smoke` 自检、工具审批最小闭环、禁用智能体 409、文档一致性修正
- 循环 7：对抗性安全审查（1 Critical + 11 High）、9 条失败路径测试、性能索引、会话列表瘦身、SSE 引用计数修复
- 循环 8：预览脱敏、结构化审批表、日志与落库脱敏、沙盒/事件输出上限、导入 SSRF 校验与审计补齐、环境变量强度校验
- 循环 9：限流、CSP、可吊销会话、CORS/`TRUST_PROXY`、乐观锁、外键、`SANDBOX_EGRESS` 默认 proxy、读/写/SSE/MCP/队列压测基线与第一瓶颈结论
- CI 增加 E2E 与镜像构建 job；新增 tag 触发的 GHCR 发布流程（`api` / `sandbox` 镜像）
