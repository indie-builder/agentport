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

## 待处理（需要设计决策，见 DECISIONS-PENDING.md）

| 编号 | 严重度 | 问题 | 建议 |
|---|---|---|---|
| H4 | High | `/api/agents/:id/files` 预览返回明文密钥与 `mcpToken` | 预览应复用导出逻辑，密钥只显示「已配置」；需确认是否影响排障 |
| H5 | High | `/mcp`、`/api/eval/runs`、`/api/servers/:id/test` 无限流/并发上限 | 需确定配额策略（单机 vs 多用户） |
| H7 | High | `.dockerignore` 未覆盖嵌套 `.env` 与 `data/` | 一行修复，本轮未做以避免与部署改动冲突 |
| H8 | High | 全局关闭 CSP，而 API 同时托管 SPA | 需评估前端内联样式，决定是否启用 `style-src 'unsafe-inline'` |
| H9 | High | `x-agentport-run-id` 被无条件信任，审批可跨 run 复用 | 审批记录应带 `server_id`，并校验 run 绑定关系 |
| H10 | High | 沙盒 stderr 原样写入日志、`agent_runs.error` 与页面 | 需 secret 模式过滤，避免误伤正常错误信息 |
| H12 | High | 沙盒事件流无单行/总量上限 | 需确定截断策略与 UI 展示方式 |
| M2 | Medium | JWT 7 天不可吊销 | 需引入 session 存储或缩短 TTL |
| M3 | Medium | 开发 CORS 反射任意 Origin；无 `trustProxy` | 需确认部署形态（是否有反向代理） |
| M4 | Medium | 审批 UI 靠正则匹配工具输出，可被伪造 | 改为结构化 `approval_requests` 表 |
| M7 | Medium | Agent/Server PATCH 事务外读—事务内写，并发丢更新 | 需引入乐观锁（`updated_at` 条件更新） |
| M8 | Medium | `agent_runs` / `messages.run_id` 无外键 | 需回填数据后加约束 |
| M9 | Medium | BullMQ 重试会重复写入消息 | 落库前按 `run_id` 先删后写 |
| M10 | Medium | 导入绕过 SSRF 校验与审计 | 导入时补校验与 `writeAudit` |
| M11 | Medium | 审计覆盖缺口（工具 CRUD、评估用例、`/mcp` 触发、登出） | 逐点补 `writeAudit` |
| M12 | Medium | 沙盒拿到模型主密钥；`.mcp.json` 默认权限落盘 | 文件 `0o600` + 按 run 签发短期 token |
| M13 | Medium | 沙盒默认 `open` 出站 + host-gateway | 默认改 `none`/`proxy`，需确认是否影响模型调用 |
| M14 | Medium | worker 挂载 docker.sock 且 `group_add: 0` | 需部署决策（socket proxy / 独立节点） |
| M15 | Medium | `permissionMode` 保存并展示但 runner 硬编码 `dontAsk` | 透传或从 UI 移除 |

## 已检查无问题

- SQL 注入：全部 Drizzle 参数绑定，`sql` 模板只插值列对象。
- 命令注入：`spawn('docker', args)` argv 形式，无 shell。
- 路径穿越：slug 正则 + `sendFile` 双重校验。
- XSS：全仓无 `dangerouslySetInnerHTML` / `innerHTML` / `eval`。
- 鉴权覆盖：除明确公开路由外全部挂 `requireAuth`；JWT 无 `alg:none` 风险。
