# 待决策事项

> 实现过程中需要拍板的点，先按**最保守/最小**的方案执行并记录在此。
> 状态：✅ 已决定 = 已按表中方案实现；⏳ 待决策 = 需要用户或部署形态才能确定。
> D-1 至 D-16 均已有决定（2026-10-20）。D-16 按「先自用、后续再扩展」执行；
> 触发升级的条件写在 D-16 末尾，届时按 B/C/D 重新评估。

---

## D-1 ✅ `/mcp` 平台端点的访问控制

**决定（按 A）**：单个全局 `PLATFORM_MCP_TOKEN`，无来源限制（用户已明确「先不做限制」）；未设置 token 时端点不注册。放到内网时改用按 agent 发 token（C）。

---

## D-2 ✅ 评估判定的方式

**决定（按 A）**：`expectation` 非空时检查输出是否包含该字符串（大小写不敏感）；为空则能产出文本即通过。不做 LLM judge。

**影响面**：`packages/api/src/features/eval/routes.ts` 的 `judge()`。

---

## D-3 ✅ 工具调用的审批（HITL）

**问题**：目前智能体在 `dontAsk` 模式下运行，未预批准的工具调用直接拒绝，没有「暂停等人批准」的路径。

**决定（循环 6 已落地，按最小闭环 B′）**：工具上可标 `requiresApproval`；调用时若未批准，MCP 端点写入 `approval_requests(run_id, server_id, tool_name)` 并返回带说明的错误；`POST /api/runs/:id/approve` 后，同一 run 内的后续调用放行。**不是进程内暂停**：批准后需要模型/用户再次发起同一调用。

**未做**：持久化暂停与自动恢复（LangGraph `interrupt` 式）。若需要，按原备选 B 实现。

**影响面**：`packages/api/src/features/servers/generated.ts`、`mcp-endpoint.ts`、`packages/api/src/features/runs/routes.ts`、`approval_requests` 表。

---

## D-4 ✅ 智能体启用状态与外部调用的关系

**问题**：`enabled=false` 的智能体是否还应允许页面发起对话？

**决定（按 A）**：二值状态。停用后不出现在 `/mcp` 工具列表，且 `POST /api/chat` 返回 409 `AGENT_DISABLED`（循环 6 已补）；页面会提示先启用。

---

## D-5 ✅ 版本历史的保留策略

**决定（按 B）**：每个 agent 保留最近 `RETAIN_AGENT_VERSIONS`（默认 50）个，由每日维护任务裁剪。

**影响面**：`packages/worker/src/maintenance.ts`、`packages/db/src/repo/maintenance.ts`。

---

## D-6 ✅ 运行记录的保留策略

**决定（按 B）**：终态 run 保留 `RETAIN_RUN_DAYS`（默认 90）天，孤立消息保留 `RETAIN_MESSAGE_DAYS`（默认 30）天；每日维护任务执行；`audit_log` 与 `eval_results` 不清理。

**影响面**：`packages/worker/src/maintenance.ts`。

---

## D-7 ✅ 备份的执行方式

**决定（按 B）**：保留手动 `pnpm backup`，由宿主机 cron 调用（示例见 [OPERATIONS.md §3.1](OPERATIONS.md#31-备份)）；应用内不做定时。

**影响面**：`scripts/backup.sh`；保留最近 7 份，不读取 `.env`。

---

## D-8 ✅ 多智能体编排的范围

**决定（按 B）**：只做「主智能体 → 子智能体」单层委派，子智能体由平台定义（`agents.parent_id`）；有子智能体时才放行 `Agent`/`TaskStop`。不做编排 DSL。

**影响面**：`packages/api/src/features/agents/routes.ts`、`packages/core/src/workspace.ts`、`packages/sandbox/src/runner.ts`。

---

## D-9 ✅ 知识库 / RAG 是否需要

**决定（按 A）**：不做内置 RAG；流程性知识用 `SKILL.md`，文档检索交给 MCP resource 或外部检索服务。

---

## D-10 ✅ 多用户 / RBAC

**决定（按 A）**：单管理员账号 + JWT Cookie。审计表保留 `actor` 字段，将来加角色时不用改表。

---

## D-11 ✅ Redis 单点与高可用

**决定（按 A）**：compose 单实例 Redis，队列、事件流、限流共用；不做 Sentinel / Cluster。

---

## D-12 ✅ 沙盒运行时的演进

**决定（按 A）**：先实现 `DockerSandboxProvider`；`SandboxProvider` 接口保留替换点，未引入 microsandbox 依赖。运行不受信用户的智能体前必须升级（见 D-16）。

---

## D-13 ✅ 事件流的持久化

**决定（按 A）**：原始事件只存 Redis Stream（1 小时、最多 1000 条），不落库；trace 页从 `messages` 重建。

---

## D-14 ✅ 前端是否需要浅色主题

**决定（按 A）**：只做深色；token 已按可替换方式命名，将来改 `styles.css` 与 `html` 属性即可。

---

## D-15 ✅ 队列的可视化面板

**决定（按 A）**：不接 `@bull-board/*`；队列状态通过 `/health/metrics` 与 `/api/runs` 观察。

---

## D-16 ✅ worker 的 Docker socket 权限

**决定（2026-10-20）：先按 A 保持，自用场景；扩展时再按 B/C/D 升级。**

**问题**：worker 挂载 `/var/run/docker.sock` 且 `group_add: ${DOCKER_GID:-0}`，可控制宿主 Docker，等价宿主 root。

**当前做法**：保持单机架构（D-12 的 Docker provider 需要它）。只在 `docker-compose.yml` 与 `docs/OPERATIONS.md` 标注风险，不做 socket proxy。

**适用范围**：单机、单管理员、只运行自己配置的智能体；机器上不放其他有价值的数据或凭证（或已接受该风险）。

**备选**：
- A. 保持（单机自用，仅自己运行受信智能体）
- B. 宿主前置 socket proxy（如 tecnativa/docker-socket-proxy），只放行 container 相关 API
- C. 独立沙盒节点：worker 通过远程 Docker（`DOCKER_HOST`）或 microVM 运行时连另一台机器
- D. 放弃 Docker，换 microsandbox/gVisor（见 D-12）

**升级触发条件**（满足任一条就重新评估，不要等到出事）：
1. 智能体开始处理**不受信内容**：公开的 HTTP 工具、用户可编辑的提示词/技能、外部 MCP server。
2. 引入**多用户**或对外暴露 API。
3. worker 与**其他服务共用一台机器**，且该机器上有不属于本平台的凭证或数据。
4. 需要运行**第三方/导入的智能体定义**（`/api/import` 已支持导入，导入了别人的定义即触发第 1 条）。

**升级路径**：B（socket proxy，改动最小）→ C（独立沙盒节点）→ D（microVM）。

**影响面**：`docker-compose.yml`、`packages/worker/src/sandbox/docker.ts`、部署文档。

---

## 决策记录格式

决策后请在此处标注：

```
- D-1 ✅ 选择 B，理由：…
```

---
