# 本地开发使用 admin / admin

## 目标

用户明确要求个人开发环境的管理员账号和密码都为 `admin`，重启后仍可使用，并验证实际登录。

## 方案

沿用现有 `.env` 与 better-auth 管理员播种流程。新增严格 `true/false` 的 `ALLOW_WEAK_ADMIN_PASSWORD`，未设置视为关闭：关闭时保留 12–128 字符与既有黑名单；打开时仍要求非空且不超过 128 字符。Compose 的 production 模式不变，不改会话、Cookie、来源校验或业务数据结构。

当前 API 基于已不存在的旧 worktree 构建。为保留其功能，以运行中镜像派生本地镜像，仅覆盖编译后的 `config.js`，不整体重建应用；使用仅本地的 Compose override 更换该镜像及登录环境变量，只重建 API 服务。旧镜像保留以便恢复。所有受控代码产出只在当前 worktree；已更新当前 worktree `.env`。主 checkout `.env` 的直接编辑被隔离规则拦截，最终需明确说明配置来源，不能声称主配置已更新。

## 步骤

- [x] 核对配置、认证链路与当前容器。
- [x] Opus 固定最小方案。
- [x] Sonnet 实施配置与测试，配置本地凭据。
- [x] Opus review。
- [x] 更新当前运行服务并验证真实 admin / admin 登录。

## 改动文件

- `packages/api/src/config.ts`
- `packages/api/test/config.test.ts`
- `.env.example`
- `docs/OPERATIONS.md`
- `docs/tasks/local-admin-login.md`
- 当前 worktree `.env`（未跟踪）：`ADMIN_USER=admin`、`ADMIN_PASSWORD=admin`、`ALLOW_WEAK_ADMIN_PASSWORD=true`、`API_IMAGE=agentport/api:local-admin-20261024`，并增加实际预览来源 `http://localhost:5174`。

## 下一步

无实施待办。当前容器及浏览器已验证新密码；用户已要求与配色调整一起提交 PR 并合并，不运行 CI。主 checkout 的 `.env` 未更新（worktree 隔离拒绝共享文件编辑），从主 checkout 重建旧镜像/旧配置会恢复原密码。本地 worktree 配置已指定派生镜像，当前容器普通 restart 保留新配置。本地 `.env`、临时 Dockerfile、Compose override 与镜像均不纳入提交。

## 验证

- Opus 探索确认 better-auth 1.7.12 的 signInUsername 不限制最短密码，无需更改认证库。
- Sonnet 先补测试并观察预期失败，再实现配置转绿。
- `pnpm --filter @agentport/api build`：成功。
- `pnpm exec vitest run packages/api/test/config.test.ts packages/api/test/shared-contracts.test.ts packages/worker/test/config.test.ts`：3 文件、38 用例通过。
- `pnpm exec biome check packages/api/src/config.ts packages/api/test/config.test.ts`：Checked 2 files，No fixes applied。
- Opus 独立 review：通过，无需修改。
- 派生镜像 `agentport/api:local-admin-20261024` 仅覆盖现有镜像的 `/app/api/dist/config.js`。原镜像保留为 `agentport/api:local-admin-base`，仅重建 API，不重启 DB/Redis/worker。
- `/health/ready` 返回 `status/db/redis: ok`；`POST /api/auth/login` 使用 admin/admin 返回 HTTP 200 `{ok:true}`。
- 浏览器 `http://localhost:5174/login` 实际输入 admin/admin 后进入工作台；`/api/auth/me` 返回 authenticated true / admin，刷新仍显示工作台。
- 原 `https://agentport.localhost` 当前未注册 Portless 服务，不作为本次验证地址。预览端口 5174 已加入本地 CORS allowlist 后验证成功。
- 未运行会重播管理员的 DB 认证集成测试，避免测试密码覆盖用户新配置。
