# 交付总结

> 2026-10-20（2026-10-24 按代码复核）。本文按「能做什么 / 怎么验证 / 还缺什么」组织；详细交接见 [docs/HANDOFF.md](docs/HANDOFF.md)，故障处置见 [docs/RUNBOOK.md](docs/RUNBOOK.md)。

## 一、项目是什么

**PACE**（仓库名 `agentport`）：单机部署的智能体平台。

- 把 **MCP Server**（stdio / 远程 HTTP / HTTP API 转 MCP）接进来；
- 用**文件**定义智能体（`.mcp.json` / `CLAUDE.md` / `.claude/agents/*.md` / `.claude/skills/*/SKILL.md` 及支持资源 / `.claude/rules/*.md` / `.claude/output-styles/*.md` / 原生 auto-memory）；
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

## 三、质量基线（2026-10-24 复核）

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 7 个包全通过 |
| `pnpm build` | ✅ 全通过；web 产物 669.63 kB（gzip 199.35 kB），有 >500 kB chunk 警告 |
| `./node_modules/.bin/biome check packages/*/src packages/*/test` | 🟡 297 个文件，0 error、2 warning（`core/src/skill-draft.ts` 的 non-null assertion），退出码 0 |
| `pnpm test` | ✅ 971/971 通过、0 失败、0 跳过（停 worker、隔离测试库；见 [docs/HANDOFF.md](docs/HANDOFF.md)） |
| `pnpm test:e2e` | 🟡 43 条中 42 通过；唯一失败为停 worker 时真实对话无消费者（套件设计冲突） |
| `pnpm smoke` | ✅ `SMOKE OK`（对运行中的 compose 栈实测） |
| 真实链路 | ✅ 浏览器 → API → 队列 → 沙盒 → 模型 → MCP 工具 → 上游 API → SSE |
| 平台即 MCP | ✅ 外部 MCP 客户端可发现并调用智能体 |
| 子智能体 | ✅ 真实模型 + 沙盒跑通，事件与落库序列见 [docs/SUBAGENTS-VERIFICATION.md](docs/SUBAGENTS-VERIFICATION.md) |
| 响应式 | ✅ 1280/1024/768/390 无横向溢出 |
| 压测 | ✅ 聚合读 1.7k rps、SSE 20 并发 +0.05 MB、健康检查 25k rps |
| 备份恢复 | ✅ 真实演练：`pnpm backup` + `pnpm restore` + 迁移 + `pnpm smoke` 全部通过（OPERATIONS §3.3） |

## 四、这一晚做了什么（16 轮循环）

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
| 10 | 最终验收、工作区按 run 隔离、工具卡片持久化、Redis 健康检查修复 |
| 11 | 取消强杀与孤儿收敛、URL 校验、审批跨 run 继承、权限诚实化 |
| 12 | 预览/运行时渲染统一、token 轮换、一条命令部署 |
| 13 | per-run 短期 MCP token + 工作区 0700/0600、评估跑批入队 `eval-runs`、SSE 每连接独立订阅 |
| 14 | 子智能体验证与归属、allowedTools/maxThinkingTokens UI、运行重跑、技能使用数、备份恢复与演练 |
| 15 | 子智能体 `parentToolUseId` 展示、CI E2E/镜像 job、GHCR 发布、Runbook、状态页 |

### 循环 13–15 新增能力

- **per-run token**：worker 每次 run 生成 32 字节随机 token，DB 只存 sha256 与过期时间（run 超时 + 5 分钟）；`.mcp.json` 写入短期 token 与 `x-agentport-run-id`，run 结束（含崩溃）即清空；长期 `mcpToken` 只作为外部客户端回退。
- **工作区文件权限**：目录 0700、文件 0600，重试复用时再次 `chmod`；run 结束删除整个 run 目录。
- **评估入队**：`POST /api/eval/runs` 只建行并入 `eval-runs` 队列（202），worker 串行执行；超过 1 小时仍 `running` 的跑批由 reconciler 置为 `failed`。
- **SSE 独立连接**：每个观众 `duplicate()` 一条 Redis 连接，关闭只释放自己的；串行 drain + 2 秒轮询兜底，事件不重复、不丢失。
- **子智能体验证**：修复零工具拒绝、事件重复、父智能体自我递归；子智能体内部调用带 `parentToolUseId`，对话页与运行详情缩进展示。
- **CI / 发布**：CI 三 job（biome/typecheck/build/migrate/test、e2e 端到端、Docker 镜像构建）；`v*` tag 推送 api/sandbox 镜像到 GHCR。
- **Runbook**：`docs/RUNBOOK.md`，按症状 → 判断 → 处置 → 验证组织，含 token 泄露、恢复、审计取证。
- **状态页**：`/status` 展示 live / ready / metrics，10 秒刷新，含浏览器内只读自检按钮。

## 五、过程中修掉的真实缺陷（节选）

- **SSE 订阅互相干扰**：一个标签页关闭会让另一个静默失联；事件还会重复投递。
- **运行时丢密钥**：预览解密了 MCP 密钥，worker 却没注入。
- **工作区并发覆盖**：同一智能体并发跑两次会互相删文件。
- **刷新后工具卡片消失**：只存了 `tool_result`，没存 `tool_use`。
- **Redis 健康检查永远 unhealthy**：变量展开写错，新部署会卡住。
- **`pnpm up` 是内置命令**：按文档执行会升级依赖而不是部署。
- **测试被真实 worker 干扰**：集成测试的 run 被后台 worker 消费。
- **子智能体零工具被拒**：子智能体 md 写了 `tools`，SDK 派生时 MCP 尚未注册；改为继承父会话。
- **父智能体可自我递归**：主智能体 md 曾写入 `.claude/agents/`；现在只落子智能体文件。

## 六、已知限制（诚实清单）

1. **单机部署**：worker 挂载 docker.sock，等价宿主 root；生产需 socket proxy 或独立节点（D-16）。
2. **同一智能体并发仍共享宿主资源**：工作区已按 run 隔离，沙盒仍共享宿主 CPU/内存。
3. **模型凭证已代理（D-17）**：worker 起仅监听回环的模型代理（`MODEL_PROXY_PORT`，默认 3426），沙盒只拿到代理地址与按 run 的短期 token，真实密钥只存在于 worker 内存；未配置任何凭证时才回退直接注入并在启动日志警告。剩余边界：代理只转发 `/v1/messages`、`/v1/models` 等白名单路径，沙盒的其它出站仍靠 `SANDBOX_EGRESS`。
4. **工具审批是挂起式暂停（D-18）**：需要审批的工具调用挂起等待（`APPROVAL_WAIT_MS`，默认 300s），批准后同一次调用继续；超时按拒绝处理。批准在同一会话的下次 run 继承，跨会话不继承；进程重启会丢失等待中的调用，该 run 需重跑。
5. **权限模式**：可保存 `dontAsk`、`plan`、`default`、`acceptEdits`；`auto` 依赖模型分类器、平台无法审计，API 返回 400（D-20）。`default` 在无人值守沙盒里实际接近 `dontAsk`。
6. **会话上下文靠注入最近 20 条消息**，不是 SDK 原生 session resume；长对话会截断。
7. **子智能体只支持单层**，且继承父会话工具集；子智能体自己的 server 绑定不参与渲染，SDK 层无深度限制。
8. **MCP 明文密钥仍落在工作区** `.mcp.json`（0600/0700，run 结束删除）；Linux 宿主 uid 非 1000 时容器可读性未验证。
9. **`/health/live`、`/health/ready` 不校验登录**（供容器探针）；`/health/metrics` 需要登录。不要把探针端点暴露到公网。
10. **DNS 重绑定**：SSRF 校验与 fetch 之间仍有窗口，需网络层 allowlist 兜底。
11. **评估跑批串行**：worker 重启会让进行中的跑批延迟；超过 1 小时才收敛。
12. **SSE 每个观众一条 Redis 连接**，受 `maxclients` 约束；轮询兜底最多 2 秒延迟。
13. **分支 UI** 只能从最新消息分支；API 支持 `fromMessageId`，UI 未暴露。
14. **导入**：`agentport/agent@2` 已携带根级/子级规则、输出风格与技能支持资源；同名 Server 复用已有配置、其工具不按文件覆盖（返回 warnings），被复用 Server 的密钥需重新填写。
15. **全局 600/min 限流桶覆盖全部路由**（按 IP，`plugins/security.ts`），另有登录 10/min 等更严的按路由桶；高并发下 Postgres 连接池仍是第一个瓶颈。
16. **运行详情重跑**只重发第一条 user 消息；重跑新建 run，工具审批按同会话上一 run 继承，历史审批不单独回放。
17. **深色主题、RAG、多用户、多机部署**：均未实现（当前只有亮色主题）。

## 七、下一步建议

1. 用真实业务 API 走一遍：建 server → 建 tool → 建 agent → 评估 → 看运行详情 → `/status`。
2. ~~决定 M12 剩余项（模型凭证隔离）是否要现在做~~ 已按 D-17 实现，剩余边界见第六节第 3 条。
3. 清零 `core/src/skill-draft.ts` 的 2 条 non-null assertion warning，恢复零 warning 基线。
4. 如果要对外：先做按 agent 签发 token 与更细粒度的读接口限额（当前只有全局 600/min 桶），再考虑 microVM 沙盒。

## 八、文档地图

| 文档 | 内容 |
|---|---|
| `README.md` | 入口：能力、快速开始、命令 |
| `docs/HANDOFF.md` | 交接摘要（本文的详版，循环 0–15 + 最终基线） |
| `docs/RUNBOOK.md` | 凌晨处置手册：症状 → 判断 → 处置 → 验证 |
| `docs/SUBAGENTS-VERIFICATION.md` | 子智能体真实端到端验证记录 |
| `docs/USER-STORIES.md` | 验收依据：4 个 EPIC、20 条故事 |
| `docs/CAPABILITY-GAP.md` | 对标行业基线的能力差距与补齐记录 |
| `docs/SECURITY.md` | 安全审查结果与修复状态（M12 拆分） |
| `docs/DECISIONS-PENDING.md` | 待决策项与已采用的默认值 |
| `docs/ARCHITECTURE.md` | 分层、拓扑、数据流 |
| `docs/OPERATIONS.md` | 环境变量、部署、备份、排障、压测 |
| `docs/DESIGN-SYSTEM.md` | PACE 品牌与 UI 规范 |
| `CHANGELOG.md`（根） | 按版本/轮次的变更记录（唯一版本记录） |
| `PRODUCT.md` | 产品真值（impeccable 规范） |
