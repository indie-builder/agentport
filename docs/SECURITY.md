# 安全审查记录

> 循环 7 的对抗性审查结果与修复状态。审查为只读，修复逐条验证。

## 已修复

| 编号 | 严重度 | 问题 | 修复 |
|---|---|---|---|
| C1 | Critical | compose 把 Postgres/Redis 发布到 0.0.0.0，Redis 无密码 | 端口绑 `127.0.0.1`；Redis 加 `--requirepass`；连接串带密码 |
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

## 待处理（需要设计决策，见 DECISIONS-PENDING.md）

| 编号 | 严重度 | 问题 | 建议 |
|---|---|---|---|
| H5 | High | `/mcp`、`/api/eval/runs`、`/api/servers/:id/test` 无限流/并发上限 | 需确定配额策略（单机 vs 多用户） |
| H8 | High | 全局关闭 CSP，而 API 同时托管 SPA | 需评估前端内联样式，决定是否启用 `style-src 'unsafe-inline'` |
| M2 | Medium | JWT 7 天不可吊销 | 需引入 session 存储或缩短 TTL |
| M3 | Medium | 开发 CORS 反射任意 Origin；无 `trustProxy` | 需确认部署形态（是否有反向代理） |
| M7 | Medium | Agent/Server PATCH 事务外读—事务内写，并发丢更新 | 需引入乐观锁（`updated_at` 条件更新） |
| M8 | Medium | `agent_runs` / `messages.run_id` 无外键 | 需回填数据后加约束 |
| M12 | Medium | 沙盒拿到模型主密钥；`.mcp.json` 默认权限落盘 | 文件 `0o600` + 按 run 签发短期 token |
| M13 | Medium | 沙盒默认 `open` 出站 + host-gateway | 默认改 `none`/`proxy`，需确认是否影响模型调用 |
| M14 | Medium | worker 挂载 docker.sock 且 `group_add: 0` | 需部署决策（socket proxy / 独立节点） |

## 已检查无问题

- SQL 注入：全部 Drizzle 参数绑定，`sql` 模板只插值列对象。
- 命令注入：`spawn('docker', args)` argv 形式，无 shell。
- 路径穿越：slug 正则 + `sendFile` 双重校验。
- XSS：全仓无 `dangerouslySetInnerHTML` / `innerHTML` / `eval`。
- 鉴权覆盖：除明确公开路由外全部挂 `requireAuth`；JWT 无 `alg:none` 风险。
