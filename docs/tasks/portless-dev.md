# Portless 本地启动（最小版）

## 目标

本地 `pnpm dev` 启动 web 时通过 Portless 访问，得到稳定地址
`https://agentport.localhost`，不再固定占用 5173。API、worker、沙盒和
compose 部署全部保持原样。

## 方案

- `packages/web` 的 `dev` 改为 `portless run --name agentport vite`；
  Portless 分配随机端口，Vite 经 `--port` 注入使用它。
- 根 `dev` 仍是 `pnpm --parallel --filter './packages/*' dev`，其余包启动方式不变。
- Vite 代理目标仍是 `http://localhost:3000`；API 继续监听 3000。
- 浏览器 Origin 变为 `https://agentport.localhost`，在 `.env` / `.env.example`
  的 `CORS_ORIGINS` 中放行（登录的 Origin 校验用），不改 API 代码。
- `portless` 作为根 devDependency；`pnpm-workspace.yaml` 由 pnpm 自动加入
  供应链白名单条目。

## 不改变

- API、worker、shared、调度与 job schema。
- Docker / compose / 沙盒镜像 / 容器网络；`pnpm up` 部署路径。
- Postgres 5432、Redis 6379、`MODEL_PROXY_PORT` 3426。

## 步骤

- [x] 安装 `portless@0.15.11`
- [x] web dev 脚本接入 Portless
- [x] CORS allowlist 与文档更新
- [x] typecheck + 本地实测

## 改动文件

- `package.json`（devDependency）、`packages/web/package.json`
- `.env`、`.env.example`、`docs/OPERATIONS.md`

## 下一步

首次 `pnpm dev` 需用户在本机批准 sudo（Portless 安装本地 CA、绑定 443）。
多 worktree 同时跑完整栈仍会争 API 的 3000；web 侧已不冲突。linked worktree
下 web 域名会带分支前缀，登录需把该 Origin 也加进 `CORS_ORIGINS`。

## 验证

- `pnpm --filter @agentport/{shared,core,api,worker,web} typecheck`：全部通过
- `pnpm vitest run packages/api/test/config.test.ts packages/api/test/shared-contracts.test.ts
  packages/worker/test/schedule-scheduler.test.ts packages/worker/test/eval-snapshot.test.ts`：
  3 passed / 1 skipped（19 passed，14 skipped 为依赖 Postgres/Redis 的用例）
- 免 sudo 实测（`PORTLESS_PORT=8446 PORTLESS_HTTPS=0`，代理到在跑的 compose API）：
  - `GET http://agentport.localhost:8446/` → 200
  - `GET /health/ready` → 200 `{"status":"ok","db":"ok","redis":"ok"}`
- 真实 443 + 本地 CA 的首次启动需用户本机 sudo 确认，未代跑。
