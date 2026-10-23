# 交接摘要（2026-10-20，最终状态）

> 当前状态快照。能力清单见根 [CHANGELOG.md](../CHANGELOG.md)，待决策见 [DECISIONS-PENDING.md](DECISIONS-PENDING.md)，安全状态见 [SECURITY.md](SECURITY.md)，故障处置见 [RUNBOOK.md](RUNBOOK.md)。

## 一句话现状

PACE（仓库名 `agentport`）是一个可单机运行的智能体平台：MCP 三源接入、文件定义智能体、Docker 沙盒执行、SSE 流式对话、运行 trace、评估回归、审计、限流、备份恢复与状态页均已落地；子智能体已完成真实端到端验证，CI 覆盖单测、E2E 与镜像构建，tag 触发 GHCR 发布。

## 质量基线（2026-10-20 最终复核，实际运行）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm typecheck` | ✅ 7 个包全部通过 |
| 构建 | `pnpm build` | ✅ 全部通过；web 产物 669.63 kB（gzip 199.35 kB），仍有 >500 kB chunk 警告 |
| Lint | `./node_modules/.bin/biome check packages/*/src packages/*/test` | 🟡 **154 个文件，1 warning、0 error**（`packages/worker/src/index.ts` 未使用的 `readdir` 导入，来自并行进行中的工作区清理改动；此前记录的 2 errors 已修） |
| 单测/集成 | `pnpm test` | ✅ **2026-10-24 复跑：965/965 通过、0 失败、0 跳过**（停 worker，`DATABASE_URL=...agentport_test` 隔离库）。此前 HANDOFF 记录的 6 项失败已随 `requireAuth`/脱敏改动合入而消失 |
| E2E | `pnpm test:e2e` | ✅ **2026-10-24 复跑：43 条中 42 通过、1 条真实对话超时**（停 worker 时该用例无消费者，属套件设计冲突，非应用缺陷）。真实模型链路另行以 API 直连验证：`claude-sonnet-5-5` 6 秒成功、输出 127 tokens。旧失败为测试选中 `group/flash` 历史 agent 所致 |
| 部署自检 | `pnpm smoke` | ✅ `SMOKE OK`（本次实际对运行中的 compose 栈执行，含 `/mcp` 401 与带 token 的 `tools/list`） |
| 基础设施 | `docker compose ps` | ✅ postgres/redis healthy；api/worker Up |
| CI | `.github/workflows/ci.yml` | biome ci → typecheck → build → migrate → test；另含 e2e、docker 两个 job |
| 发布 | `.github/workflows/release.yml` | 推送 `v*` tag 构建并推送 api / sandbox 镜像到 GHCR |

真实链路（浏览器 → API → 队列 → 沙盒 → 模型 → MCP 工具 → 上游 API → SSE）与外部 MCP 客户端调用平台智能体均已实测；子智能体的委派链路见 [SUBAGENTS-VERIFICATION.md](SUBAGENTS-VERIFICATION.md)。压测数据见 [OPERATIONS.md §8](OPERATIONS.md#8-压力测试结果)。

## 循环 0–15 摘要

| 循环 | 内容 |
|---|---|
| 0 | 仓库骨架、pnpm workspace、Postgres/Redis、pino 日志、健康检查、首个迁移 |
| 1 | MCP 三源接入（stdio / 远程 HTTP / HTTP→MCP）、连接测试、AES-256-GCM、单管理员 JWT、文件定义智能体、Docker 沙盒、BullMQ + SSE |
| 2 | 技能、权限与工具策略、完整历史落库、token/延迟、版本历史与回滚、审计页、平台→MCP、队列重试 |
| 3 | 工具级启停、评估用例与回归跑批、智能体导出、`pnpm backup`、运行完成审计 |
| 4 | 子智能体单层委派、数据保留、`/health/metrics`、E2E 回归、概览健康卡片 |
| 5 | 会话上下文注入（最近 20 条）与分支、智能体导入、可访问性与 1280/1024/768/390 响应式 |
| 6 | 部署可移植（命名卷 + `HOST_WORKSPACES_DIR`）、`pnpm smoke`、工具审批最小闭环、禁用智能体 409、文档收口 |
| 7 | 对抗性安全审查（1 Critical + 11 High）、9 条失败路径测试、性能索引、会话列表瘦身、SSE 引用计数修复 |
| 8 | 预览脱敏、结构化审批表、日志/落库脱敏、沙盒与事件输出上限、导入 SSRF 校验、环境变量强度校验 |
| 9 | 限流、CSP、可吊销会话、CORS/`TRUST_PROXY`、乐观锁、外键、`SANDBOX_EGRESS` 默认 proxy、压测基线 |
| 10 | 最终验收、按 run 隔离工作区、工具卡片持久化（`tool_use` 落库）、Redis 健康检查修复 |
| 11 | 取消 SIGKILL 兜底与孤儿 run 收敛、Server URL 校验、审批跨 run 继承、权限模式诚实化 |
| 12 | 预览与运行时共用 `workspace-input`、generated token 轮换、`pnpm run up` 一条命令部署 |
| 13 | 按 run 签发短期 MCP token（DB 只存 sha256，结束即清空）、工作区 0700/0600、评估跑批移入 `eval-runs` 队列并收敛超时 running、SSE 每连接独立 Redis 订阅 |
| 14 | 子智能体真实端到端验证（修复零工具拒绝、SSE 事件重复、父智能体自我递归）、allowedTools/maxThinkingTokens UI、运行详情重跑、技能使用数、备份/恢复脚本与真实演练 |
| 15 | 子智能体调用归属（`parentToolUseId` 事件与缩进展示）、CI 增加 E2E/镜像构建、tag 触发的 GHCR 发布、Runbook、系统状态页 `/status` |

## 当前已知限制（与 DELIVERY.md 合并去重，以代码为准）

1. **单机部署**：worker 挂载 `docker.sock`，等价宿主 root；只适合单机自用（D-16）。生产需 socket proxy、独立沙盒节点或 microVM。
2. **同一智能体的并发仍共享宿主资源**：工作区已按 `runId` 隔离，但沙盒容器共享宿主 CPU/内存，吞吐受 `AGENT_MAX_CONCURRENT` 限制。
3. **模型凭证已代理（D-17）**：worker 起回环代理，沙盒只拿按 run 的短期 token；未配置凭证时才回退直接注入。代理只转发白名单路径。
4. **工作区仍含 MCP 明文密钥**：stdio / http server 解密后的 env/headers 会写入 `.mcp.json`；文件 0600、目录 0700，run 结束删除。Linux 宿主 uid 非 1000 时容器内可能读不到 0600 的 bind mount（macOS Docker Desktop 已实测可读）。
5. **工具审批是挂起式暂停（D-18）**：未批准时 MCP 调用挂起，批准后同一次调用继续并返回结果；`APPROVAL_WAIT_MS`（默认 300s）超时按拒绝处理。外部客户端没有 run 上下文时仍立即拒绝。
6. **权限模式**：`dontAsk`、`plan`、`default`、`acceptEdits` 可保存；`auto` 依赖模型分类器，平台无法审计，返回 400（D-20）。
7. **会话上下文靠注入最近 20 条消息**，不是 SDK 原生 session resume；长对话会截断。
8. **子智能体只支持单层**，且继承父会话的 MCP 工具集；子智能体自己的 server 绑定不参与渲染。子智能体内部调用已带 `parentToolUseId` 并在 UI 缩进，但单层约束仍靠 API 校验 + `disallowedTools`，SDK 本身无深度限制。
9. **评估跑批在 worker 的 `eval-runs` 队列串行（并发 1）**；worker 重启后超过 1 小时仍为 `running` 的跑批会被收敛为 `failed`（`eval run lost`）。
10. **SSE 事件保留 1 小时、最多 1000 条**；过期后只能从 `messages` 还原主线。每个观众占一条独立 Redis 连接，受 Redis `maxclients` 约束；唤醒失败时最多有 2 秒轮询兜底延迟。
11. **分支 UI 只能从最新消息分支**；API 支持 `fromMessageId`，UI 未暴露。
12. **导入不携带子智能体与工具审批标记**；导入格式当前没有这两个字段。
13. **Server 地址校验与连接之间的 DNS 重绑定窗口**仍靠网络层 allowlist 兜底。
14. **限流已覆盖全部路由**：`plugins/security.ts` 注册 `global: true` 的 120/min 桶（按 IP），另有登录 10/min 等更严的按路由桶。高并发下 Postgres 连接池仍是第一个瓶颈（OPERATIONS §8）。
15. **`/health/live`、`/health/ready` 无鉴权**（供容器探针）；`/health/metrics` 需要登录。不要把前两者暴露到公网。
16. **运行详情「重新运行」只重发该 run 的第一条 user 消息**，不带当时的工具审批状态。
17. **未实现**：浅色主题、RAG/知识库、多用户/RBAC、多机部署。

## 建议的下一步

1. 用真实业务 API 走一遍完整流程（建 server → 工具 → agent → 评估 → 运行详情 → `/status`）。
2. ~~决定 M12 剩余项（模型凭证代理）~~ 已按 D-17 实现。
3. 若要对外：先做按 agent 发 token 与读接口限流，再考虑 D-12 的 microVM。
4. ~~修复上述 2 条 lint error 后，把 `pnpm exec biome check .` 接回零错误基线。~~ 已完成：`biome check packages/*/src packages/*/test` 154 文件 0 error（当前 1 个未使用导入 warning，随并行改动合入后清除）。

## 如何继续

```bash
cd ~/Documents/myself/agentport
docker compose up -d postgres redis
pnpm build
pnpm db:migrate
pnpm dev            # api + worker + web
pnpm smoke          # 需要 API 已启动且已设置 ADMIN_PASSWORD
```

跑测试前先停 worker（否则集成用例会被真实消费）：

```bash
docker compose stop worker api
set -a; . ./.env; set +a; pnpm test
docker compose start api worker
```

新会话开始时读：`docs/PROJECT-BRIEF.md` → `docs/CAPABILITY-GAP.md` → `docs/DECISIONS-PENDING.md` → `docs/SECURITY.md` → `docs/RUNBOOK.md`。
