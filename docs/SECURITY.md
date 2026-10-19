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

## 待处理

| 编号 | 严重度 | 问题 | 建议 |
|---|---|---|---|
| M12 | Medium | 沙盒拿到模型主密钥；`.mcp.json` 以默认权限落盘（worker 写入时未 `chmod 0600`） | 文件 `0o600` + 按 run 签发短期 token |

除 M12 外，循环 7–9 审查出的 Critical/High/Medium 均已修复。本次文档复核只跑了 `pnpm test`（82 个用例）；E2E 与真实部署下的限流、CSP、会话吊销未复测，状态为「未验证」。

## 已检查无问题

- SQL 注入：全部 Drizzle 参数绑定，`sql` 模板只插值列对象。
- 命令注入：`spawn('docker', args)` argv 形式，无 shell。
- 路径穿越：slug 正则 + `sendFile` 双重校验。
- XSS：全仓无 `dangerouslySetInnerHTML` / `innerHTML` / `eval`。
- 鉴权覆盖：除明确公开路由外全部挂 `requireAuth`；JWT 无 `alg:none` 风险。
