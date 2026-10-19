# 待决策事项

> 按用户要求：实现过程中遇到需要拍板的点，先按**最保守/最小**的方案继续，记录在此，等用户集中决策。
> 每条包含：问题、当前临时做法、备选、建议、影响面。

状态：⏳ 待决策 ／ ✅ 已决定

---

## D-1 ⏳ `/mcp` 平台端点的访问控制

**问题**：`POST /mcp` 把所有已启用智能体暴露为 MCP 工具，当前只校验 `PLATFORM_MCP_TOKEN`。

**当前做法**：单个全局 Bearer token，无来源限制（用户已明确「先不做限制」）。

**备选**：
- A. 保持现状（单机自用）
- B. 限制来源 IP / 网段
- C. 每个智能体独立 token + 可选吊销
- D. 加 scope（某个 token 只能调特定 agent）

**建议**：单机保持 A；放到内网时用 C，因为 B 在代理后不可靠。

**影响面**：`agent-tools-endpoint.ts`、`agents` 表（如需按 agent 发 token）。

---

## D-2 ⏳ 评估判定的方式

**问题**：回归跑批如何判断一个用例「通过」。

**当前做法**：最小实现——`expectation` 非空时检查输出是否包含该字符串（不区分大小写）；为空则能产出文本即通过。

**备选**：
- A. 字符串包含（当前）
- B. 正则/JSONPath 断言
- C. LLM-as-judge（用模型打分）
- D. 人工标注队列

**建议**：先用 A 覆盖大部分场景；等用例变多后加 B；C 会引入额外成本与不稳定，暂不做。

**影响面**：`packages/api/src/features/eval/routes.ts`。

---

## D-3 ⏳ 工具调用的审批（HITL）

**问题**：目前智能体在 `dontAsk` 模式下运行，未预批准的工具调用直接拒绝，没有「暂停等人批准」的路径。

**当前做法**：未实现持久化暂停；只能取消整个 run。

**备选**：
- A. 不做（工具白名单已能覆盖大部分风险）
- B. 用 SDK 的 `canUseTool` + 长轮询：run 暂停时把请求写库，前端审批后恢复
- C. 只在 `permissionMode: 'default'` 下支持，且限定单机交互场景

**建议**：B 的完整版成本较高（要处理进程生命周期与超时）；如果实际业务里写操作不多，A 足够。若要做，先做 C。

**影响面**：`runner.ts`、`agent_runs` 新增状态、前端对话页。

---

## D-4 ⏳ 智能体启用状态与外部调用的关系

**问题**：`enabled=false` 的智能体现在不会出现在 `/mcp` 工具列表，也不能发起对话。是否还需要「草稿/停用但可测试」的状态？

**当前做法**：二值（启用/停用）。

**备选**：A. 保持二值；B. 增加 `draft`（可手动测试，不对外暴露）。

**建议**：A。当前单管理员，草稿态价值有限。

---

## D-5 ⏳ 版本历史的保留策略

**问题**：每次保存智能体都写一条版本，长期会无限增长。

**当前做法**：不清理。

**备选**：
- A. 保留全部（当前）
- B. 每个 agent 保留最近 50 个
- C. 保留最近 30 天 + 每月首个版本

**建议**：B。单机数据库不大，但无限增长会让页面卡顿。

**影响面**：`agent-versions.ts`、一个清理任务。

---

## D-6 ⏳ 运行记录的保留策略

**问题**：`agent_runs` + `messages` 会随使用量增长，尤其工具返回大 JSON 时。

**当前做法**：不清理。

**备选**：A. 保留全部；B. 运行记录保留 90 天，消息保留 30 天；C. 只保留失败运行。

**建议**：B，配一个每日清理任务。

**影响面**：新增维护任务；审计表不参与清理。

---

## D-7 ⏳ 备份的执行方式

**问题**：`scripts/backup.sh` 是手动执行的。是否要做定时？

**当前做法**：手动 `pnpm backup`。

**备选**：A. 手动（当前）；B. 宿主机 cron；C. 应用内定时任务写入 backups 目录。

**建议**：B。备份属于运维职责，应用内做会和工作负载抢 IO。

---

## D-8 ⏳ 多智能体编排的范围

**问题**：SDK 支持子智能体（Agent 工具）与 handoff，但当前所有内置工具（含 `Agent`）都被禁用。

**当前做法**：不支持。

**备选**：
- A. 不做
- B. 允许「主智能体 → 子智能体」的单层委派，子智能体由平台定义
- C. 完整的编排 DSL / 工作流图

**建议**：B。C 会显著增加复杂度，且与「文件定义」的简洁性冲突。

**影响面**：workspace 渲染（子 agent 文件）、权限模型、UI。

---

## D-9 ⏳ 知识库 / RAG 是否需要

**问题**：当前可用技能（SKILL.md）承载流程性知识，但没有文档检索。

**当前做法**：不支持。

**备选**：
- A. 不做，靠 MCP resource 或外部检索服务
- B. 内置简单的文档上传 + 关键词检索
- C. 内置向量检索 + 重排

**建议**：A。B 的效果通常不如用户的现有检索系统；C 是另一个项目。

---

## D-10 ⏳ 多用户 / RBAC

**问题**：当前单管理员账号。

**当前做法**：单账号 + JWT。

**备选**：A. 保持；B. 多用户 + 角色（admin/operator/viewer）；C. SSO。

**建议**：A。单机优先，B 在需要时再加（表结构已预留 actor 字段）。

---

## D-11 ⏳ Redis 单点与高可用

**问题**：队列、事件流、限流都依赖单个 Redis。

**当前做法**：compose 单实例。

**备选**：A. 保持；B. Redis Sentinel；C. 换 Redis Cluster。

**建议**：A。单机场景下 Sentinel 的收益小于运维成本。

---

## D-12 ⏳ 沙盒运行时的演进

**问题**：当前用 Docker 容器（共享内核）。

**当前做法**：`SandboxProvider` 接口 + Docker 实现。

**备选**：A. 保持；B. 接入 microsandbox（microVM）；C. gVisor。

**建议**：A 用于自用；如果将来运行不受信用户的智能体，必须升级到 B。

**影响面**：新增 `MicrosandboxProvider`，接口已就绪。

---

## D-13 ⏳ 事件流的持久化

**问题**：SSE 事件存在 Redis Stream，1 小时后过期；`messages` 表只保留结构化消息，不保留原始事件序列。

**当前做法**：过期即丢；trace 页从 `messages` 重建。

**备选**：A. 保持；B. 把事件也落库；C. 导出到对象存储。

**建议**：A。`messages` 已能还原主线；原始事件只对深度调试有价值。

---

## D-14 ⏳ 前端是否需要浅色主题

**问题**：当前只有深色。

**当前做法**：token 已按可替换方式命名，但未实现切换。

**备选**：A. 不做；B. 加 `data-theme` 切换。

**建议**：A。控制台类产品深色是常态；要加时改 `styles.css` 与 `html` 属性即可。

---

## D-15 ⏳ 队列的可视化面板

**问题**：`@bull-board/fastify` 已在技术选型中，但未接入。

**当前做法**：通过 `/api/runs` 与日志观察队列。

**备选**：A. 不接；B. 接在 `/admin/queues`（需鉴权）。

**建议**：A。当前已有运行列表；队列内部视图对单机价值有限。若接入，必须放在鉴权之后。

---

## D-16 ⏳ worker 的 Docker socket 权限

**问题**：worker 挂载 `/var/run/docker.sock` 且 `group_add: ${DOCKER_GID:-0}`，可控制宿主 Docker，等价宿主 root。

**当前做法**：保持单机架构（D-12 的 Docker provider 需要它）。未改代码，只在 `docker-compose.yml` 与 `docs/OPERATIONS.md` 标注风险。

**备选**：
- A. 保持（单机自用，仅自己运行受信智能体）
- B. 宿主前置 socket proxy（如 tecnativa/docker-socket-proxy），只放行 container 相关 API
- C. 独立沙盒节点：worker 通过远程 Docker（`DOCKER_HOST`）或 microVM 运行时连另一台机器
- D. 放弃 Docker，换 microsandbox/gVisor（见 D-12）

**建议**：自用保持 A；只要运行不受信输入/多用户，必须 B 或 C；长期走 D。

**影响面**：`docker-compose.yml`、`packages/worker/src/sandbox/docker.ts`、部署文档。需要部署形态才能落地。

---

## 决策记录格式

决策后请在此处标注：

```
- D-1 ✅ 选择 B，理由：…
```

---

## 已按建议执行的项（2026-10-20 回填）

> 以下为对当前代码的核对结果，仅追加状态，不改动上文原有内容。表中「建议」指各条目的建议方案。

| 编号 | 建议 | 当前状态 | 代码落点 | 说明 |
|---|---|---|---|---|
| D-1 | A（单机单 token） | ✅ 按 A 执行 | `packages/api/src/features/servers/agent-tools-endpoint.ts` | 仅校验 `PLATFORM_MCP_TOKEN`，无来源限制；未设置 token 时 `/mcp` 不注册 |
| D-2 | A（字符串包含） | ✅ 按 A 执行 | `packages/api/src/features/eval/routes.ts` 的 `judge()` | `expectation` 非空时大小写不敏感包含；为空时要求有文本 |
| D-3 | A 或先做 C | ❌ 未实现 | — | 仍是 `dontAsk` + 预批准；未预批准的工具直接拒绝，没有暂停/审批/恢复路径，只能取消整个 run |
| D-4 | A（二值状态） | 🟡 部分 | `packages/api/src/features/servers/agent-tools-endpoint.ts`、`agent-invoker.ts` | 仅影响 `/mcp` 暴露与外部调用；`POST /api/chat` 只校验 agent 存在，**不校验 `enabled`**，停用智能体仍可从页面发起对话 |
| D-5 | B（每 agent 50 个版本） | ✅ 按 B 执行 | `packages/worker/src/maintenance.ts`、`packages/db/src/repo/maintenance.ts` | 每日任务按 `RETAIN_AGENT_VERSIONS`（默认 50）裁剪 |
| D-6 | B（运行 90 天、消息 30 天） | ✅ 按 B 执行 | 同上 | 终态 run 连同其消息按 90 天清理；无 `run_id` 的孤立消息按 30 天清理；`audit_log`、`eval_results` 不清理 |
| D-7 | B（宿主机 cron） | ✅ 按 B 执行 | `scripts/backup.sh` | 应用内无定时备份；保留最近 7 份，脚本不读取 `.env` |
| D-8 | B（单层委派） | ✅ 按 B 执行 | `packages/api/src/features/agents/routes.ts`、`packages/core/src/workspace.ts`、`packages/sandbox/src/runner.ts` | `parent_id` 单层限制；有子智能体时才放行 `Agent`/`TaskStop` |
| D-9 | A（不做 RAG） | ✅ 按 A 执行 | — | 只有 `SKILL.md`，无文档检索 |
| D-10 | A（单管理员） | ✅ 按 A 执行 | `packages/api/src/features/auth/routes.ts` | 单账号 + JWT Cookie；审计表保留 `actor` 字段 |
| D-11 | A（Redis 单实例） | ✅ 按 A 执行 | `docker-compose.yml` | 队列、事件流、限流共用同一 Redis |
| D-12 | A（Docker 起步） | ✅ 按 A 执行 | `packages/worker/src/sandbox/provider.ts`、`docker.ts` | 只有 `DockerSandboxProvider`；接口已留出替换点，未引入 microsandbox 依赖 |
| D-13 | A（事件流不落库） | ✅ 按 A 执行 | `packages/api/src/queue/producer.ts`、`packages/worker/src/runner-client.ts` | Redis Stream 保留 1 小时、最多 1000 条；trace 由 `messages` 重建 |
| D-14 | A（不做浅色主题） | ✅ 按 A 执行 | `packages/web/src/styles.css` | 只有深色 token，无主题切换 |
| D-15 | A（不接队列面板） | ✅ 按 A 执行 | — | 未安装 `@bull-board/*`；队列状态通过 `/health/metrics` 与 `/api/runs` 观察 |

需要用户确认的偏差只有 D-4：如果「停用」应当阻止页面发起对话，`POST /api/chat` 需要补一次 `enabled` 校验（当前代码没有）。
