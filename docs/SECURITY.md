# 安全审查记录

> 循环 7 的对抗性审查结果与修复状态。审查为只读，修复逐条验证。
>
> **历史说明**：本文件保留循环 7–10 当时的实现描述与修复记录，不按现状重写。认证已迁移为 Better Auth + Drizzle/PostgreSQL 会话，Cookie 为不透明会话令牌 `agentport_token`；`JWT_SECRET` 是 better-auth 会话签名密钥的历史命名，不是应用 JWT，Redis 也不存会话。旧记录中涉及 JWT/`sid`/Redis 会话的条目（如循环 9 的 M2）只代表当时实现，当前行为以 [OPERATIONS.md](OPERATIONS.md) 和代码为准。

## 已修复

| 编号 | 严重度 | 问题 | 修复 |
|---|---|---|---|
| C1 | Critical | compose 把 Postgres/Redis 发布到 0.0.0.0，Redis 无密码 | 端口绑 `127.0.0.1`；Redis 加 `--requirepass`；连接串带密码。compose 文件已修；已存在的容器需要 `docker compose up -d --force-recreate postgres redis` 才会生效 |
| H1 | High | `assertSafeUrl` 可被 `[::ffff:7f00:1]`（十六进制 IPv4-mapped）与 NAT64 绕过 | 改为单个 `net.BlockList`：原 IPv4 网段逐条同时登记 IPv4 与 NAT64 `64:ff9b::<network>/(96+prefix)` 子网，IPv4-mapped 由 BlockList 原生匹配；显式保留 `::/128`、`::1/128`、`fc00::/7`、`fe80::/10`，删除手写 IPv6 解析，拒绝范围不变 |
| H2 | High | `fetch` 默认跟随重定向，只在第一跳做 SSRF 校验 | `redirect:'error'` + 30s 超时 + 1 MiB 响应体上限 |
| H3 | High | stdio「测试连接」在 API 主机 spawn 用户命令并继承全部 `process.env` | 只传 `PATH`/`HOME`/`LANG` + 用户配置的 env |
| H6 | High | `/health/ready` 每请求新建 Redis 连接 | 复用 metrics 的共享 lazy 客户端 |
| H11 | High | SSE 共享 subscriber 收到任意频道消息都触发 drain（N² 放大） | 按频道过滤后再 drain |
| M1 | Medium | 登录失败把无长度上限的用户名写入永不清理的审计表 | 截断到 128 字符 |
| M6 | Medium | `/api/conversations` 的 limit 无上限 | 上限 200 |
| L6 | Medium | overview `days` 无上限导致非法日期 500 | 限制 1–3650 |
| — | — | 审批状态在连接建立时快照，批准后同一连接仍被拒 | 改为调用时重新读取（`refreshApprovals`） |
| — | — | `generated.ts` 的 SSRF 调用未传 `nodeEnv`，与测试连接行为不一致 | 显式传入 `config.NODE_ENV` |
| — | — | FakeIP `198.18.0.0/15` 的放行范围 | `ssrf.ts` 不单独屏蔽该网段，开发与生产一致；本机开发例外仅 `localhost`/`127.0.0.1`/`::1` |

## 循环 8 已修复

| 编号 | 修复 |
|---|---|
| H7 | `.dockerignore` 覆盖嵌套 `.env`/`data`；删除重复 `packages/api/.env` |
| H4 | 预览只显示 `<已配置>` 占位；generated 的 Authorization 省略并注明运行时注入 |
| H9 + M4 | 新表 `approval_requests(run_id, server_id, tool_name)`；审批严格绑定三元组，UI 改读结构化端点，删除正则匹配 |
| H10 | `redactSecrets` 覆盖 Bearer/sk-/ghp_/KEY=value/长 base64url；stderr 降为 debug；落库前脱敏 |
| H12 | 沙盒单字段 256 KB 截断；worker 单行 1 MiB、单 run 2000 事件/32 MiB 上限；UI 64 KB 折叠 |
| M9 | 重试时在同一事务内先删 `run_id` 对应的 assistant/tool 消息（保留 user） |
| M10 | 导入调用 `assertSafeUrl`；同名不同 kind 拒绝复用；写 `agent.imported` 审计 |
| M11 | 补 tool CRUD、eval case CRUD、logout、`/mcp` 触发 run 的审计 |
| L1 | `APP_SECRET_KEY`/`JWT_SECRET` ≥32、`ADMIN_PASSWORD` ≥12 且拒绝占位值 |
| M15 | `permissionMode` 透传到沙盒 runner |

## 循环 9 已修复

| 编号 | 修复 |
|---|---|
| H5 | `/mcp` 60/min + 进程内并发 4；`/api/servers/:id/test` 20/min；`/api/eval/runs` 10/min + 同 agent 只允许一个 running |
| H8 | 全局启用 CSP；仅 MCP 路由关闭；`style-src` 放行内联样式 |
| M2 | JWT 增加 `sid`，Redis 存会话，logout 立即失效；TTL 24 小时；鉴权查询 5 秒本地缓存（历史实现；当前见文首说明） |
| M3 | CORS 显式 allowlist（`CORS_ORIGINS`）；`TRUST_PROXY` 支持 |
| M7 | Agent/Server PATCH 乐观锁，冲突返回 409 `CONFLICT_STALE`；前端提示刷新 |
| M8 | `agent_runs` / `messages.run_id` 外键（迁移先清理孤儿行） |
| M13 | `SANDBOX_EGRESS` 三档显式选择：默认 `open`（bridge 直连，不隔离出站）；`proxy` 必须配 `HTTPS_PROXY`/`HTTP_PROXY`，否则 worker 启动 fail-closed 退出，不再静默降级 |
| M14 | 文档记录 docker.sock 风险与替换方案；记入 D-16（已决定：自用保持，升级触发条件见该节） |

## 循环 10 已修复

| 编号 | 修复 |
|---|---|
| — | `POST`/`PATCH /api/servers` 对 http 的 `url` 与 generated 的 `baseUrl` 调用 `assertSafeUrl`：生产拒绝私网/回环/link-local，开发放行 localhost；失败统一 400 `INVALID_URL`。共享 schema 只接受 http/https（`ftp:`/`file:`/`javascript:` 在 schema 层拒绝）；导入路径沿用同一错误码 |

## 待处理

| 编号 | 严重度 | 问题 | 状态 |
|---|---|---|---|
| M12a | Medium | 沙盒拿到模型主密钥：worker 把 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` 直接注入容器 env，沙盒内的进程可以读取 | **已修复（D-17）**：worker 起回环模型代理，沙盒只拿 `ANTHROPIC_BASE_URL=<proxy>` 与按 run 的 token；真实凭证只在 worker 内存。会话容器复用时 token 每轮重新签发，run 结束时从代理内存集合移除并尝试清空 DB hash（与容器是否停稳无关）；内存移除不保证独立于 DB 立即失效，清 hash 成功或 run 状态成功落库为非 running 后 DB 不再匹配，两者都失败时 token 仍可能被接受。未配置凭证时才回退直接注入，并在启动日志警告 |
| M12b | — | 工作区 `.mcp.json` 权限、长期 MCP token 落盘 | **已修复**（循环 13）：目录 0700 / 文件 0600（`core/mcp-token.ts`），重试复用后再次 `chmod`；generated server 改用按 run 签发的短期 token（32 字节随机，DB 只存 sha256 与过期时间）。实际清理边界：run 结束（不论容器是否停稳）都会尝试清空本轮 MCP token；DB 清空失败只记 warning，该 token 可能保留到过期时间。模型 token 结束时从代理内存集合移除并尝试清空 DB hash；清 hash 成功或 run 状态成功落库为非 running 后 DB 不再匹配，两者都失败时 token 仍可能被接受。`.mcp.json` 只在 runner 停稳后 best-effort 删除，删除失败会记录错误、禁止复用并在仍持有 lease 时销毁容器，但持久工作区里的文件可能留到下一轮刷新才被覆盖；文件中本轮 token 可能已清空或仍在有效期内，stdio/http 上游 secrets 不受本轮 token 撤销影响。长期 `mcpToken` 仅作外部客户端回退；实测 macOS Docker Desktop bind mount 下容器内 uid 1000 可读 0600 文件。这里的「已修复」只指平台签发凭证的落盘与撤销；上游长期 secret 仍可被同容器进程读取，见下方真实信任边界 |

**M12 现在的边界**：平台签发的 MCP 凭证与模型凭证都不再以长期明文进入沙盒。模型代理只转发 `/v1/messages` 等白名单路径，避免变成开放代理；未启用代理时启动日志会明确警告。stdio / http server 自己的 env/headers 仍会解密写入 `.mcp.json`（0600），这些上游 secrets 可能是长期凭证，run 结束不会被撤销。run 结束（不论容器是否停稳）都会尝试清空本轮 token：模型 token 结束时从代理内存集合移除并尝试清空 DB hash（内存移除不保证独立于 DB 立即失效，清 hash 或 run 状态成功落库为非 running 后 DB 不再匹配，两者都失败时 token 仍可能被接受）；MCP token 的 DB 清空失败时可能保留到过期时间。`.mcp.json` 只在 runner 停稳后 best-effort 删除，删除失败时记录错误、禁止复用并销毁容器，持久工作区文件可能留到下一轮刷新覆盖；文件残留期间本轮 token 是否仍有效取决于清空是否成功，上游长期 secret 仍可能有效。Linux 宿主 uid 非 1000 时容器读取 0600 bind mount 的行为未验证。

**上游 MCP 长期凭据的真实信任边界**：用户为原生 stdio/HTTP MCP 配置的 env/headers 凭据由 worker 解密后写入工作区 `.mcp.json`（目录 0700、文件 0600，`/workspace` 以只读方式绑定）。这些措施只能减少部分外部修改/访问，**不能阻止同一容器内以相同 uid 运行的进程读取凭据并按上游权限使用**；默认启用的 Bash、技能/插件执行内容及 stdio 子进程都可能读取。PreToolUse hook 只约束原生文件工具与 MCP 调用，不是进程隔离；`${VAR}`/headersHelper 等是配置取值机制，不是同容器 secret 隔离。平台签发的 generated/knowledge MCP token 是按 run 签发、可随 run 结束尝试清空的短期凭据；模型凭据经回环代理与按 run token 隔离（D-17）。二者与用户自带的长期上游凭据边界不同，per-run 撤销不会撤销上游长期 secret。因此只应把受信任的代码与该任务所需最小权限凭据绑定到原生 MCP；本说明不新增审批弹窗、不默认关闭 Bash，也不表示已实现上游统一代理。删除/目录回收的关闭确认修复在系统架构任务中实施，未完成前不宣称「凭据无残留」。

本次最终文档复核实际运行了 `pnpm test`（2026-10-21 复跑：25 个文件、156/162 通过、6 失败——失败项对应并行线尚未合入的 `/health/metrics` 鉴权与脱敏改动；需先停 worker）、`pnpm typecheck`、`pnpm build` 与 `pnpm smoke`（`SMOKE OK`）；biome 对 `packages/*/src packages/*/test` 的 154 个文件为 1 warning、0 error。E2E 未复跑；真实部署下的限流、CSP、会话吊销仍为「未验证」。

## 已检查无问题

- SQL 注入：全部 Drizzle 参数绑定，`sql` 模板只插值列对象。
- 命令注入：`spawn('docker', args)` argv 形式，无 shell。
- 路径穿越：slug 正则 + `sendFile` 双重校验。
- XSS：全仓无 `dangerouslySetInnerHTML` / `innerHTML` / `eval`。
- 鉴权覆盖：除明确公开路由外全部挂 `requireAuth`；JWT 无 `alg:none` 风险。
