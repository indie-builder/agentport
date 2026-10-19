# 交付总结

> 2026-10-20。本文是整晚自主交付的收尾，按「能做什么 / 怎么验证 / 还缺什么」组织。

## 一、项目是什么

**PACE**（仓库名 `agentport`）：单机部署的智能体平台。

- 把 **MCP Server**（stdio / 远程 HTTP / HTTP API 转 MCP）接进来；
- 用**文件**定义智能体（`.mcp.json` / `CLAUDE.md` / `.claude/agents/*.md` / `.claude/skills/*/SKILL.md`）；
- 在 **Docker 沙盒**里执行，事件经 **SSE** 实时回传；
- 提供运行观测、评估回归、审计、版本回滚。

## 二、怎么跑起来

```bash
cd ~/Documents/myself/agentport
pnpm install
pnpm run up          # 生成 .env、起 Postgres/Redis、迁移、构建镜像、冒烟自检
```

打开 http://localhost:3000，用 `.env` 里的 `ADMIN_USER` / `ADMIN_PASSWORD` 登录。

> 注意是 `pnpm run up`，不是 `pnpm up`——后者是 pnpm 内置的依赖升级命令。

本地开发：`docker compose up -d postgres redis` → `pnpm dev`（api + worker + web）。

## 三、质量基线（本轮实测）

| 项 | 结果 |
|---|---|
| `pnpm -r typecheck` | ✅ 7 个包全通过 |
| `pnpm -r build` | ✅ 全通过 |
| `biome check` | ✅ 159 文件，0 错误 |
| `pnpm test` | ✅ **94 个用例通过** |
| `pnpm test:e2e` | ✅ 5 通过 + 1 按设计跳过 |
| `pnpm smoke` | ✅ `SMOKE OK` |
| 真实链路 | ✅ 浏览器 → API → 队列 → 沙盒 → 模型 → MCP 工具 → 上游 API → SSE |
| 平台即 MCP | ✅ 外部 MCP 客户端可发现并调用智能体 |
| 响应式 | ✅ 1280/1024/768/390 无横向溢出 |
| 压测 | ✅ 聚合读 1.7k rps、SSE 20 并发 +0.05 MB、健康检查 25k rps |

## 四、这一晚做了什么（12 轮循环）

| 轮次 | 主题 |
|---|---|
| 0 | 骨架、Postgres/Redis、日志、健康检查 |
| 1 | MCP 三源、HTTP→MCP、鉴权、文件定义、沙盒、SSE |
| 2 | 技能、权限、完整历史、token/延迟、版本回滚、审计页、平台→MCP、重试 |
| 3 | 工具级启停、评估回归、导出、备份 |
| 4 | 子智能体单层委派、数据保留、指标端点、E2E |
| 5 | 会话上下文与分支、导入、可访问性与响应式 |
| 6 | 部署可移植、工具审批最小闭环、文档收口 |
| 7 | 安全审查（1 Critical + 11 High）、失败路径测试、性能索引 |
| 8 | 预览脱敏、结构化审批、日志脱敏、输出上限 |
| 9 | 限流/CSP/可吊销会话/乐观锁/外键、压测基线 |
| 10 | 最终验收、工作区并发隔离、工具卡片持久化、Redis 健康检查修复 |
| 11 | 取消强杀与孤儿收敛、URL 校验、审批跨 run 继承、权限诚实化 |
| 12 | 预览/运行时渲染统一、token 轮换、一条命令部署 |

## 五、过程中修掉的真实缺陷（节选）

- **SSE 订阅互相干扰**：一个标签页关闭会让另一个静默失联。
- **运行时丢密钥**：预览解密了 MCP 密钥，worker 却没注入。
- **工作区并发覆盖**：同一智能体并发跑两次会互相删文件。
- **刷新后工具卡片消失**：只存了 `tool_result`，没存 `tool_use`。
- **Redis 健康检查永远 unhealthy**：变量展开写错，新部署会卡住。
- **`pnpm up` 是内置命令**：按文档执行会升级依赖而不是部署。
- **测试被真实 worker 干扰**：集成测试的 run 被后台 worker 消费。

## 六、已知限制（诚实清单）

1. **单机部署**：worker 挂载 docker.sock，等价宿主 root；生产需 socket proxy 或独立节点。
2. **无法并发运行同一智能体**：已按 run 隔离工作区，但沙盒容器仍共享宿主资源。
3. **工具审批不是持久化暂停**：批准在同一会话的下次 run 继承，跨会话不继承；批准后需重发消息。
4. **权限模式只有 `dontAsk` 与 `plan` 可用**：`default`/`auto` 依赖宿主审批通道，未实现。
5. **会话上下文靠注入最近 20 条消息**，不是 SDK 原生 session resume；长对话会截断。
6. **子智能体未经真实端到端验证**：文件格式符合规范，但没有自动化测试证明 SDK 会调用。
7. **密钥明文落在工作区** `.mcp.json`（权限已收紧），沙盒能读模型主密钥（M12 未闭环）。
8. **`/health/metrics` 无鉴权**：只应内网访问。
9. **DNS 重绑定**：SSRF 校验与 fetch 之间仍有窗口，需网络层 allowlist 兜底。
10. **评估跑批在 API 进程内**：API 重启会让进行中的跑批停在 running。
11. **浅色主题、RAG、多用户、多机部署**：均未实现。

## 七、下一步建议

1. 用真实业务 API 走一遍：建 server → 建 tool → 建 agent → 评估 → 看运行详情。
2. 决定 M12（沙盒密钥隔离）是否要现在做——这是剩余唯一 High 级安全问题。
3. 如果要对外：先做按 agent 签发 token，再考虑 microVM 沙盒。

## 八、文档地图

| 文档 | 内容 |
|---|---|
| `README.md` | 入口：能力、快速开始、命令 |
| `docs/HANDOFF.md` | 交接摘要（本文的详版） |
| `docs/USER-STORIES.md` | 验收依据：4 个 EPIC、20 条故事 |
| `docs/CAPABILITY-GAP.md` | 对标行业基线的能力差距与补齐记录 |
| `docs/SECURITY.md` | 安全审查结果与修复状态 |
| `docs/DECISIONS-PENDING.md` | 待决策项与已采用的默认值 |
| `docs/ARCHITECTURE.md` | 分层、拓扑、数据流 |
| `docs/OPERATIONS.md` | 环境变量、部署、备份、16 条排障 |
| `docs/DESIGN-SYSTEM.md` | PACE 品牌与 UI 规范 |
| `docs/CHANGELOG.md` | 按轮次的能力清单 |
| `PRODUCT.md` | 产品真值（impeccable 规范） |
