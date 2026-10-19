# 能力差距与补齐计划

> 本文件由「探索 → 差距 → 补齐 → 验证」循环产出，每轮迭代更新。
> 参考来源见文末。

---

## 循环 1（2026-10-20）

### 行业基线：生产级智能体平台的六个原语

综合 2026 年多方实践，平台能力被归纳为**模型无关的六个原语**，换模型不用重写平台：

| 原语 | 含义 |
|---|---|
| **沙盒** | 隔离执行，最小权限，临时凭证 |
| **凭证** | 密钥不下放到不可信代码，按需注入 |
| **工具网关** | 参数校验、限流、高风险调用审批 |
| **HITL** | 分级自治：常规直通、不确定排队审批、高风险升级 |
| **Tracing** | 多步推理树，含工具输入输出、token、版本、策略决策 |
| **回滚** | 配置与运行的快照恢复 |

在此之上，生产必需项包括：**离线评估套件 + 在线抽样评估 + 轨迹评估**、**版本化（提示词/工具/记忆策略/护栏一起验证）**、**预算与停机控制**、**审计与 RBAC**。

### 差距矩阵

状态：✅ 已实现 ／ 🟡 部分 ／ ❌ 未实现

> 说明：此矩阵是**循环 1 结束时**的快照，「本轮」指循环 1；后续循环的补齐记录见下方各节与 [CHANGELOG.md](CHANGELOG.md)。「下一轮」是当时的计划，不代表当前状态。

| 领域 | 能力 | 循环前 | 本轮 | 说明 |
|---|---|---|---|---|
| 沙盒 | 隔离执行、资源限制、只读根 | ✅ | ✅ | cap-drop、no-new-privileges、memory/cpu/pids |
| 凭证 | 密钥加密入库、接口脱敏 | ✅ | ✅ | AES-256-GCM |
| 凭证 | **运行时注入 MCP env/headers** | ❌ | ✅ | 已移到 `core/secrets.ts`，worker 解密注入 |
| 工具网关 | MCP 三类来源 + 连接测试 | ✅ | ✅ | |
| 工具网关 | 工具级启用/禁用 | ❌ | ❌ | 下一轮 |
| HITL | 取消运行 | ✅ | ✅ | |
| HITL | 工具调用审批 / 暂停恢复 | ❌ | ❌ | 下一轮（需 SDK 交互通道） |
| Tracing | 运行状态/成本/轮次 | ✅ | ✅ | |
| Tracing | **token 与延迟落库** | 🟡 | ✅ | `latency_ms` / `input_tokens` / `output_tokens` |
| Tracing | **完整对话历史（assistant + tool）** | ❌ | ✅ | worker 持久化 `assistant_text` 与 `tool_result` |
| Tracing | run 详情页 / trace 树 | ❌ | ❌ | 下一轮 |
| 回滚 | 配置版本历史 | ❌ | ❌ | 下一轮 |
| 评估 | 离线评估集、在线抽样、轨迹评估 | ❌ | ❌ | 下一轮 |
| 版本 | 智能体/技能版本化 | ❌ | ❌ | 下一轮 |
| 治理 | 审计写入覆盖 | 🟡 | 🟡 | 已有 3 个动作；配置变更与登录待补 |
| 治理 | 审计页 | ❌ | ❌ | 下一轮 |
| 知识 | 文档/RAG | ❌ | ❌ | 优先级低（可用技能替代） |
| 多智能体 | 子智能体 / 编排 | ❌ | ❌ | 优先级中 |
| 运行时 | agent enabled 生效 | ❌ | ✅ | POST /api/chat 拒绝禁用 agent |
| 运行时 | 健康检查含 Redis | 🟡 | ✅ | `/health/ready` 同时检查 DB 与 Redis |
| 运行时 | 队列重试策略 | ❌ | ❌ | 下一轮 |

### 本轮已修复并验证

1. **运行时密钥注入**：worker 从 `secrets_encrypted` 解密后写入 `.mcp.json`，与预览一致。验证：技能绑定 + 文件预览输出一致。
2. **对话历史完整**：worker 把 `assistant_text` 与 `tool_result` 写入 `messages`。验证：一次真实运行后角色序列为 `user, tool, tool, assistant`。
3. **token 与延迟**：从 SDK `result.modelUsage` 汇总并落库。验证：`totalTokens=3152`、`latencyP50=6228`。
4. **enabled 生效**：禁用智能体调用返回 409。
5. **健康检查**：`/health/ready` 返回 `{db:"ok",redis:"ok"}`。
6. **错误映射**：外键引用不存在返回 400（`INVALID_REFERENCE`）而非 500；重名返回 409。

### 循环 1 补充：完整对标结论

详细调研（LangSmith / LangGraph / Dify / n8n / Flowise / Vellum / OpenAI Agents / Claude Code / MCP）确认了 P0 的完整集合，并补出三个此前遗漏项：

| 能力 | 状态 | 说明 |
|---|---|---|
| **把平台自身暴露为 MCP Server** | ❌ | 目前只做 HTTP→MCP；反向暴露（智能体即工具）缺。Dify / n8n / Flowise 都有。边际成本低、价值高。 |
| **持久化 HITL（暂停落盘、跨重启恢复）** | ❌ | 现有「取消」只是终止，不是暂停。LangGraph 的 `interrupt` + checkpointer 是参照。 |
| **错误分类与重试策略** | ❌ | 队列未设 attempts/backoff；模型限流、工具失败、超时未区分。 |

另确认以下项**已达标**：文件定义智能体、MCP 客户端（stdio + HTTP）、HTTP→MCP、流式 SSE、会话持久化、沙盒、取消/超时/预算、凭据加密。

### 循环 2 已补齐

| 能力 | 状态 | 证据 |
|---|---|---|
| 运行详情页 + trace 时间线 | ✅ | `GET /api/runs`、`/api/runs/:id`；`/runs`、`/runs/$runId` 页面 |
| 配置版本历史 + 回滚 | ✅ | `agent_versions` 表；创建/更新同事务写快照；`POST /api/agents/:id/rollback`。实测 v1→v2→rollback 生成 v3 |
| 审计页 + 覆盖 | ✅ | `GET /api/audit`；登录成功/失败、server/agent/skill 增删改、测试连接、运行请求/取消 |
| 平台暴露为 MCP Server | ✅ | `POST /mcp` + `PLATFORM_MCP_TOKEN`；已启用智能体成为工具。实测 `initialize` 成功 |
| 错误分类与重试 | ✅ | BullMQ `attempts:2` + 指数退避；`isRetryable` 只重试基础设施错误 |
| 工具调用消息落库 | ✅ | `tool_result` 与 `assistant_text` 写入 `messages` |

### 循环 3 已补齐

| 能力 | 状态 | 证据 |
|---|---|---|
| 工具级启用/禁用 | ✅ | `api_tools.enabled`；`PATCH /api/servers/:id/tools/:toolId`；`buildGeneratedServer` 跳过禁用项。实测禁用后测试连接工具消失、评估跑批失败；恢复后 2/2 通过 |
| 评估集 + 回归跑批 | ✅ | `eval_cases` / `eval_runs` / `eval_results`；`POST /api/eval/runs` 异步串行执行；实测 2 个用例全部判对 |
| 资产导出 | ✅ | `GET /api/export/agents/:id`，`agentport/agent@1` 格式，密钥只导出键名 |
| 数据库备份 | ✅ | `pnpm backup` → `pg_dump | gzip`，保留 7 份 |
| 运行完成审计 | ✅ | worker 写 `agent.run.finished` |
| run 步骤映射单测 | ✅ | `packages/db/test/steps.test.ts`，5 个用例 |

### 循环 4 已补齐

| 能力 | 状态 | 证据 |
|---|---|---|
| 子智能体单层委派 | ✅ | `agents.parent_id`；渲染 `.claude/agents/<child>.md`；仅 `allowSubAgents` 时放行 `Agent` 工具；拒绝自引用与两层 |
| 数据保留 | ✅ | 版本保留 50、终态运行 90 天、孤立消息 30 天；每日 repeatable job + `pnpm --filter @agentport/worker maintenance` |
| 指标端点 | ✅ | `GET /health/metrics`：进程 / 队列 / 连接池 / Redis ping，依赖不可用时返回 null 而非 500 |
| 请求日志规范化 | ✅ | 按路由模板记录，`unmatched` 兜底；>2s 记 warn；SSE 排除 |
| 平台健康卡片 | ✅ | 概览页 30s 轮询队列与内存 |
| E2E 回归 | ✅ | 5 条用例覆盖运行/审计/技能/评估/概览 |

### 循环 5 已补齐

| 能力 | 状态 | 证据 |
|---|---|---|
| 会话上下文恢复 | ✅ | 发起 run 时取最近 20 条消息注入 prompt；不依赖 SDK session resume |
| 会话分支 | ✅ | `conversations.parent_id` + `branch_of_message_id`；`POST /api/conversations/:id/branch`；侧栏按钮 |
| 智能体导入 | ✅ | `POST /api/import/agents`；slug 冲突自动改名；密钥只提示不导入；6 个测试 |
| 可访问性收口 | ✅ | 焦点环兜底、skip-link、Dialog/抽屉焦点陷阱、键盘导航、错误文案与 `aria-describedby` |
| 响应式 | ✅ | 1280/1024/768/390 四宽度实测无横向溢出；每页唯一 h1 |
| 文案质量 | ✅ | 错误按状态码给「发生了什么 + 下一步」；空态补主行动 |

### 循环 6 已补齐

| 能力 | 状态 | 证据 |
|---|---|---|
| 部署可移植 | ✅ | compose 去掉 `${PWD}`，改用命名卷 + `HOST_WORKSPACES_DIR`；在 `/tmp` 下 `--project-directory` 验证通过 |
| 部署自检 | ✅ | `pnpm smoke` 覆盖健康、登录、三类列表、MCP 鉴权；实测输出 `SMOKE OK` |
| 工具审批（最小） | ✅ | `api_tools.requires_approval` + `agent_runs.approvals`；未批准返回明确文案；`POST /api/runs/:id/approve`；20 个相关测试 |
| 文档收口 | ✅ | README（概览 + 命令 + 安全要点）、ARCHITECTURE、OPERATIONS（环境变量、部署、排障、压测） |
| 文档与代码一致性 | ✅ | 修正 15 处偏差（`SANDBOX_NETWORK`→`SANDBOX_EGRESS`、`pnpm -r typecheck` 写法、迁移非自动、`PLATFORM_MCP_TOKEN` 未文档化等） |
| 禁用智能体拦截 | ✅ | `POST /api/chat` 返回 409 并给下一步 |

### 循环 7 已补齐

| 能力 | 状态 | 证据 |
|---|---|---|
| 失败路径测试 | ✅ | 9 条：SSE 提前断开、重复投递、非法 JSON、超长输入、审批边界、约束冲突 |
| 修复的真实缺陷 | ✅ | SSE 引用计数泄漏（两个标签页互相影响）、批准不存在工具被静默接受、prompt 无上限 |
| 性能索引 | ✅ | `messages.run_id`、`agent_runs(started_at)`、`(conversation_id, created_at, id)`；执行计划由 Seq Scan 转 Index Scan |
| 会话列表瘦身 | ✅ | `lastMessage` 只取 280 字符，响应体 8009 → 6820 B |
| 安全审查 | ✅ | `docs/SECURITY.md`：1 Critical + 11 High；循环 8、9 已修复全部 High 与 Medium，仅剩 M12 |
| 测试总数 | ✅ | 82 个 vitest 用例（当前实测）+ E2E |

### 循环 8 已补齐

| 能力 | 状态 | 证据 |
|---|---|---|
| 预览脱敏 | ✅ | 密钥值显示 `<已配置>`；generated 的 Authorization 运行时注入 |
| 结构化工具审批 | ✅ | `approval_requests(run_id, server_id, tool_name)`；`POST /api/runs/:id/approve`；UI 改读 `/api/runs/:id/approvals` |
| 日志/落库脱敏 | ✅ | `redactSecrets` 覆盖 Bearer/sk-/ghp_/`KEY=value`/长 base64url；stderr 降为 debug |
| 输出上限 | ✅ | 沙盒单字段 256 KB；worker 单行 1 MiB、单 run 2000 事件/32 MiB；UI 64 KB 折叠 |
| 导入安全 | ✅ | 导入调用 `assertSafeUrl`；同名不同 kind 拒绝复用；写 `agent.imported` 审计 |
| 审计补齐 | ✅ | tool CRUD、eval case CRUD、logout、`/mcp` 触发 run 均有审计 |
| 环境校验 | ✅ | `APP_SECRET_KEY`/`JWT_SECRET` ≥32、`ADMIN_PASSWORD` ≥12 且拒绝占位值 |

### 循环 9 已补齐

| 能力 | 状态 | 证据 |
|---|---|---|
| 限流 | ✅ | 登录 10/min、chat 20/min、`/mcp` 与 `/mcp/:serverId` 60/min、连接测试 20/min、评估发起 10/min；`/mcp` 另有进程内并发 4 |
| CSP | ✅ | 全局启用；仅 MCP 路由关闭；`style-src` 放行内联样式 |
| 可吊销会话 | ✅ | JWT 带 `sid`，Redis `session:<sid>`，logout 立即失效；鉴权结果本地缓存 5 秒 |
| CORS / 代理 | ✅ | `CORS_ORIGINS` allowlist；`TRUST_PROXY=1` 信任转发头 |
| 乐观锁 | ✅ | Agent/Server PATCH 带 `expectedUpdatedAt`，冲突返回 409 `CONFLICT_STALE` |
| 外键 | ✅ | `agent_runs`、`messages.run_id` 外键（迁移 0011 先清理孤儿行） |
| 沙盒出站 | ✅ | `SANDBOX_EGRESS` 默认 `proxy`，无代理时降级为 `open` 并告警 |
| 压测基线 | ✅ | 读/写/SSE/MCP/队列数据与第一瓶颈见 [OPERATIONS.md §8](OPERATIONS.md#8-压力测试结果) |

### 下一轮优先级（按对「生产可用」的影响排序）

| 优先级 | 能力 | 状态 / 理由 |
|---|---|---|
| ~~P0~~ | run 详情页 + trace 树 | ✅ |
| ~~P0~~ | 智能体配置版本历史 + 回滚 | ✅ |
| ~~P0~~ | 审计页 + 配置变更审计 | ✅ |
| ~~P0~~ | 平台自身暴露为 MCP Server | ✅ |
| ~~P0~~ | 错误分类与重试 | ✅ |
| ~~P1~~ | 工具级启用/禁用 | ✅ |
| ~~P1~~ | 资产导出/备份 | ✅ |
| ~~P2~~ | 评估集（手工用例 + 回归） | ✅ |
| ~~P2~~ | 子智能体（单层委派） | ✅ |
| P1 | 持久化 HITL（暂停 → 落盘 → 恢复） | 未做；当前是最小审批闭环（D-3） |
| P1 | 工作区密钥文件权限（M12） | 未做；见 [SECURITY.md](SECURITY.md) |
| P3 | RAG / 知识库 | 未做；技能可覆盖多数场景（D-9） |

---

## 参考

- [Production AI Agents in 2026: The Reliability Stack](https://icmd.app/article/the-agentic-reliability-stack-in-2026-how-teams-are-making-ai-agents-safe-fast-a-1776488198970)
- [Building Production-Ready AI Agents in 2026 — MLflow](https://mlflow.org/articles/building-production-ready-ai-agents-in-2026/)
- [AgentOps Is the New DevOps — operating AI agents in production](https://turjo.me/agentops-ai-agents-production)
- [Beyond the Demo: AI Agent Governance, Traceability, and Quality](https://prextechnologies.com/blog/ai-agents-governance-traceability-quality)
- [Building Autonomous AI Agents: Architecture and Design Patterns](https://www.netconsulate.com/insights/building-autonomous-ai-agents-architecture-and-design-patterns)
- [2026 年生产团队最佳 AI Agent 评估与可观测性 Harness](https://mcplato.com/zh-hant/blog/top-ai-agent-evaluation-observability-harnesses-2026)
