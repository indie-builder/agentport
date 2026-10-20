# 安全审查记录

> 循环 7 的对抗性审查结果与修复状态。审查为只读，修复逐条验证。

## 已修复

| 编号 | 严重度 | 问题 | 修复 |
|---|---|---|---|
| C1 | Critical | compose 把 Postgres/Redis 发布到 0.0.0.0，Redis 无密码 | 端口绑 `127.0.0.1`；Redis 加 `--requirepass`；连接串带密码。compose 文件已修；已存在的容器需要 `docker compose up -d --force-recreate postgres redis` 才会生效 |
| H1 | High | `assertSafeUrl` 可被 `[::ffff:7f00:1]`（十六进制 IPv4-mapped）与 NAT64 绕过 | 提取内嵌 IPv4 再判断；补 `240/4`、`255.255.255.255`、`192.0.0.0/24`、`192.88.99/24` |
| H2 | High | `fetch` 默认跟随重定向，只在第一跳做 SSRF 校验 | `redirect:'error'` + 30s 超时 + 1 MiB 响应体上限 |
| H3 | High | stdio「测试连接」在 API 主机 spawn 用户命令并继承全部 `process.env` | 只传 `PATH`/`HOME`/`LANG` + 用户配置的 env |
| H6 | High | `/health/ready` 每请求新建 Redis 连接 | 复用 metrics 的共享 lazy 客户端 |
| H11 | High | SSE 共享 subscriber 收到任意频道消息都触发 drain（N² 放大） | 按频道过滤后再 drain |
| M1 | Medium | 登录失败把无长度上限的用户名写入永不清理的审计表 | 截断到 128 字符 |
| M6 | Medium | `/api/conversations` 的 limit 无上限 | 上限 200 |
| L6 | Medium | overview `days` 无上限导致非法日期 500 | 限制 1–3650 |
| — | — | 审批状态在连接建立时快照，批准后同一连接仍被拒 | 改为调用时重新读取（`refreshApprovals`） |
| — | — | `generated.ts` 的 SSRF 调用未传 `nodeEnv`，与测试连接行为不一致 | 显式传入 `config.NODE_ENV` |
| — | — | 本机代理的 `198.18.0.0/15` FakeIP 会被误判为私网 | 开发环境放行该网段，生产仍拦截 |

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
| M2 | JWT 增加 `sid`，Redis 存会话，logout 立即失效；TTL 24 小时；鉴权查询 5 秒本地缓存 |
| M3 | CORS 显式 allowlist（`CORS_ORIGINS`）；`TRUST_PROXY` 支持 |
| M7 | Agent/Server PATCH 乐观锁，冲突返回 409 `CONFLICT_STALE`；前端提示刷新 |
| M8 | `agent_runs` / `messages.run_id` 外键（迁移先清理孤儿行） |
| M13 | `SANDBOX_EGRESS` 默认 `proxy`，无代理时降级为 `open` 并告警 |
| M14 | 文档记录 docker.sock 风险与替换方案；记入 D-16 |

## 循环 10 已修复

| 编号 | 修复 |
|---|---|
| — | `POST`/`PATCH /api/servers` 对 http 的 `url` 与 generated 的 `baseUrl` 调用 `assertSafeUrl`：生产拒绝私网/回环/link-local，开发放行 localhost；失败统一 400 `INVALID_URL`。共享 schema 只接受 http/https（`ftp:`/`file:`/`javascript:` 在 schema 层拒绝）；导入路径沿用同一错误码 |

## 待处理

| 编号 | 严重度 | 问题 | 状态 |
|---|---|---|---|
| M12a | Medium | 沙盒拿到模型主密钥：worker 把 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` 直接注入容器 env，沙盒内的进程可以读取 | **未修复**。正确做法是模型凭证代理：沙盒只拿短期、按 run 的代理 token，由宿主侧代理注入真实凭证 |
| M12b | — | 工作区 `.mcp.json` 权限、长期 MCP token 落盘 | **已修复**（循环 13）：目录 0700 / 文件 0600（`core/mcp-token.ts`），重试复用后再次 `chmod`；generated server 改用按 run 签发的短期 token（32 字节随机，DB 只存 sha256 与过期时间，run 结束清空），长期 `mcpToken` 仅作外部客户端回退；实测 macOS Docker Desktop bind mount 下容器内 uid 1000 可读 0600 文件 |

**M12 现在的边界**：MCP 凭证已不再是长期明文落盘（run token 只在该次 run 有效），但 **模型凭证仍是沙盒可见的长期密钥**，这是剩余的唯一 Medium 项。stdio / http server 自己的 env/headers 仍会解密写入 `.mcp.json`（0600，run 结束删除）；Linux 宿主 uid 非 1000 时容器读取 0600 bind mount 的行为未验证。

本次最终文档复核实际运行了 `pnpm test`（18 个文件、104 个用例通过，需先停 worker）、`pnpm typecheck`、`pnpm build` 与 `pnpm smoke`（`SMOKE OK`）。E2E 未复跑；真实部署下的限流、CSP、会话吊销仍为「未验证」。

## 已检查无问题

- SQL 注入：全部 Drizzle 参数绑定，`sql` 模板只插值列对象。
- 命令注入：`spawn('docker', args)` argv 形式，无 shell。
- 路径穿越：slug 正则 + `sendFile` 双重校验。
- XSS：全仓无 `dangerouslySetInnerHTML` / `innerHTML` / `eval`。
- 鉴权覆盖：除明确公开路由外全部挂 `requireAuth`；JWT 无 `alg:none` 风险。
