# 交接摘要（2026-10-20）

> 当前状态快照。能力清单见 [CHANGELOG.md](CHANGELOG.md)，待决策见 [DECISIONS-PENDING.md](DECISIONS-PENDING.md)，安全状态见 [SECURITY.md](SECURITY.md)。

## 一句话现状

PACE（仓库名 `agentport`）是一个可单机运行的智能体平台：MCP 三源接入、文件定义智能体、Docker 沙盒执行、SSE 流式对话、运行 trace、评估回归、审计、限流与备份均已落地，并有自动化测试与压测基线。

## 质量基线（2026-10-20 复核）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm typecheck` | ✅ 7 个包全部通过 |
| 构建 | `pnpm build` | ✅ 全部通过；web 有 >500 kB chunk 警告 |
| Lint | `pnpm lint` | ✅ 0 错误，1 条 warning（`mcp-endpoint.ts` 未使用参数 `ctx`） |
| 单测/集成 | `pnpm test` | ✅ 14 个文件、82 个用例通过（需要 Postgres 与 Redis；vitest 不读 `.env`，compose 的 Redis 需显式 `REDIS_URL=redis://:agentport-dev@localhost:6379`） |
| E2E | `pnpm test:e2e` | 未在本次复核中运行（需 5173+3000；`E2E_FULL=1` 才跑真实对话） |
| 部署自检 | `pnpm smoke` | 本次未运行（需要已登录的部署实例） |
| 基础设施 | `docker compose ps` | ✅ postgres/redis healthy；`REDIS_PASSWORD` 未导出时 redis 健康检查会失败（已记录在 OPERATIONS 排障表） |
| CI | `.github/workflows/ci.yml` | biome ci → typecheck → build → migrate → test |

真实链路（浏览器 → API → 队列 → 沙盒 → 模型 → MCP 工具 → 上游 API → SSE）与外部 MCP 客户端调用平台智能体，均在循环 6 之前实测通过。压测数据见 [OPERATIONS.md §8](OPERATIONS.md#8-压力测试结果)。

## 循环 0–9 摘要

| 循环 | 内容 |
|---|---|
| 0 | 仓库骨架、Postgres/Redis、日志、健康检查、首个迁移 |
| 1 | MCP 三源接入、HTTP→MCP、鉴权、文件定义智能体、Docker 沙盒、SSE |
| 2 | 技能、权限与工具策略、完整历史落库、token/延迟、版本回滚、审计页、平台→MCP、队列重试 |
| 3 | 工具级启停、评估集与回归、智能体导出、备份、运行完成审计 |
| 4 | 子智能体单层委派、数据保留、指标端点、E2E 回归、请求日志规范化 |
| 5 | 会话上下文注入与分支、智能体导入、可访问性与响应式收口 |
| 6 | 部署可移植（命名卷 + `HOST_WORKSPACES_DIR`）、`pnpm smoke`、工具审批最小闭环、文档收口 |
| 7 | 对抗性安全审查（1 Critical + 11 High）、失败路径测试、性能索引、会话列表瘦身 |
| 8 | 安全修复第二轮：预览脱敏、结构化审批表、日志脱敏、输出与事件上限 |
| 9 | 安全剩余项：限流、CSP、可吊销会话、乐观锁、外键；并发压测与瓶颈结论 |

## 当前已知限制

1. **会话上下文**靠注入最近 20 条消息，不是 SDK 原生 session resume；长对话会截断。
2. **子智能体**只支持单层，且共享主智能体的 MCP 绑定；子智能体自己的 server 绑定不参与渲染。
3. **工具审批**不是持久化暂停：未批准时工具返回错误，批准后需要用户重新发送消息。批准会继承到**同一会话的下一次 run**（复制 `approval_requests`，审计记 `agent.run.approvals_inherited`）；跨会话不继承，仍未实现自动恢复。
4. **评估跑批**已移到 worker 的 `eval-runs` 队列（串行，并发 1）；worker 重启后超过 1 小时仍停在 `running` 的跑批会被收敛为 `failed`（`eval run lost`）。
5. **SSE 事件**存在 Redis Stream，TTL 1 小时、最多 1000 条；过期后只能从 `messages` 还原主线。每个观众占一条独立 Redis 订阅连接，观众数上限受 Redis `maxclients` 约束（单机场景足够）。
6. **沙盒**用 Docker 共享内核；worker 挂载 `docker.sock`，等价宿主 root（D-16）。
7. **密钥落盘**：每次 run 把解密后的 MCP env/headers 写入 `data/workspaces/<slug>/.mcp.json`，文件权限未收紧（M12，见 SECURITY.md）。
8. **分支 UI** 只能从最新消息分支；API 支持指定 `fromMessageId`，UI 未暴露。
9. **导入**不携带子智能体与工具审批标记（当前导入格式没有这两个字段）。
10. **权限模式**仅 `dontAsk`（未预批准即拒绝）与 `plan`（只规划不执行）可用；`default` / `acceptEdits` / `auto` 依赖宿主审批通道，当前平台未实现，保存时返回 400。
11. **Server 地址校验**在登记/修改时做一次 DNS 解析（生产拒绝私网）；运行时会再校验一次，但解析与连接之间的 DNS 重绑定仍靠网络层 allowlist 兜底。
12. **读接口**没有限流（`global: false`）；高并发下 Postgres 连接池是第一个瓶颈（见 OPERATIONS §8）。

## 建议的下一步

1. 用真实业务场景跑一次完整流程（建 server → 建 agent → 评估 → 运行详情）。
2. 处理 SECURITY.md 中唯一未修复的 M12（工作区文件权限 / 短期 token）。
3. 若要对外提供服务：先做 D-1 的按 agent 发 token 与读接口限流，再考虑 D-12 的 microVM。
4. 补跑 `pnpm test:e2e` 与 `pnpm smoke`，把结果回填本表。

## 如何继续

```bash
cd ~/Documents/myself/agentport
docker compose up -d postgres redis
pnpm build
pnpm db:migrate
pnpm dev            # api + worker + web
pnpm smoke          # 需要 API 已启动且已设置 ADMIN_PASSWORD
```

新会话开始时读：`docs/PROJECT-BRIEF.md` → `docs/CAPABILITY-GAP.md` → `docs/DECISIONS-PENDING.md` → `docs/SECURITY.md`。
