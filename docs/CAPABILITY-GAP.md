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

### 下一轮优先级（按对「生产可用」的影响排序）

| 优先级 | 能力 | 理由 |
|---|---|---|
| P0 | run 详情页 + trace 树 | 没有它，失败无法定位；已有数据只差界面与接口 |
| P0 | 智能体配置版本历史 + 回滚 | 改错无法恢复，是治理底线 |
| P0 | 审计页 + 配置变更审计 | 现有审计数据不可见 |
| P1 | 工具级启用/禁用 | 当前只能整 server 绑定 |
| P2 | 评估集（手工用例 + 回归） | 有真实价值，但依赖 trace 先落地 |
| P2 | 子智能体 / 多智能体编排 | SDK 支持，但需权限模型先稳定 |
| P3 | RAG / 知识库 | 技能可覆盖多数场景 |

---

## 参考

- [Production AI Agents in 2026: The Reliability Stack](https://icmd.app/article/the-agentic-reliability-stack-in-2026-how-teams-are-making-ai-agents-safe-fast-a-1776488198970)
- [Building Production-Ready AI Agents in 2026 — MLflow](https://mlflow.org/articles/building-production-ready-ai-agents-in-2026/)
- [AgentOps Is the New DevOps — operating AI agents in production](https://turjo.me/agentops-ai-agents-production)
- [Beyond the Demo: AI Agent Governance, Traceability, and Quality](https://prextechnologies.com/blog/ai-agents-governance-traceability-quality)
- [Building Autonomous AI Agents: Architecture and Design Patterns](https://www.netconsulate.com/insights/building-autonomous-ai-agents-architecture-and-design-patterns)
- [2026 年生产团队最佳 AI Agent 评估与可观测性 Harness](https://mcplato.com/zh-hant/blog/top-ai-agent-evaluation-observability-harnesses-2026)
