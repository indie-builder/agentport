---
name: visual-check
description: >
  开发完成后的 UI 视觉抽查：一条命令启动隔离环境、登录、按多个桌面视口截图并打开，
  结束后清理。Use when the user says 生成截图、看一下效果、截个图、UI 验收、
  visual check、screenshot，或需要确认页面在真实渲染下的观感。
---

# visual-check

把「开发完生成 UI 截图看效果」固化成 `scripts/visual-shots.mjs`。默认起**隔离临时 PG 库、
独享 Redis 容器与 API/Web**，不写真实开发库；`--base-url` 可复用已获授权的测试栈，且不创建或销毁
PG/Redis/应用服务、不把业务栈作为默认验收对象。

## 何时用

- 改完 UI 需要肉眼确认真实渲染（不是类名、不是 HTML 快照）。
- 需要对比同一路由在 1440x900 / 1200x900 等桌面视口下的效果。
- 用户说「生成截图 / 看一下效果 / 截个图」。

## 前置条件

- 仓库根有 `.env`（`ADMIN_USER`、`ADMIN_PASSWORD`，隔离模式还需 `DATABASE_URL`，用于派生临时库连接）。
- PostgreSQL 已运行（`bun run infra:up` 或 `docker compose ps` 能看到 `postgres`）。
- 本机已有脚本钉住的 `redis:8.10.3-alpine` 镜像：脚本用 `--pull=never`，不会自动拉取。
- 首次或依赖改动后先构建 api 所需包：
  `bun run --filter @agentport/shared --filter @agentport/db --filter @agentport/core build`
- 隔离模式固定使用 3000 / 5173 端口，要求空闲；被占用时不得停其他会话或用户的服务，可复用已获授权的测试栈（`--base-url`）或另行隔离启动；本脚本固定端口、不支持随机 API 端口，也不会杀别人的进程。

## 用法

```bash
bun run visual:shots --route /agents
bun run visual:shots --route /agents --route /channels --viewports 1440x900,1200x900
node scripts/visual-shots.mjs --route '/agents?q=x' --no-open
node scripts/visual-shots.mjs --route /agents --base-url http://localhost:5173
```

`bun run visual:shots` 等价于 `node scripts/visual-shots.mjs`。关键参数（完整见
`node scripts/visual-shots.mjs --help`）：

| 参数 | 说明 |
|---|---|
| `--route <path>` | 可重复；支持 query。必填 |
| `--viewports <WxH,...>` | 默认 `1440x900,1200x900` |
| `--out <dir>` | 默认 `.visual/<yyyymmdd-hhmmss>` |
| `--seed none\|minimal\|dev-data` | 默认 `minimal`（空库时造 2 个 agent + 1 个频道） |
| `--base-url <url>` | 复用已获授权的测试栈，不创建或销毁 PG/Redis/应用服务；种子与截图仍写入该栈，不把业务栈作为默认验收对象 |
| `--wait-ms <n>` | 每页稳定等待，默认 1200 |
| `--open` / `--no-open` | 截图后是否打开，默认打开 |
| `--full` | 截整页长图，不被视口高度截断 |
| `--keep` | 保留环境与服务（调试用），不自动清理，并打印手动停止/删除命令 |

## 流程

1. 在**任务 worktree 根**执行命令（不要在主 checkout）。
2. 隔离模式下脚本：检查 3000 / 5173 → 建临时库 `pace_visual_<ts>_<hex>` → 迁移 →
   创建本次独享 Redis 容器（随机名、已缓存镜像、loopback 随机端口、关闭持久化）→
   起 API（3000，显式注入本次临时库与 Redis）与 Web（5173）→ 健康检查 →
   `ego-browser` 独立登录 → 可选种子 → 每个视口截图 → 打开。
3. 用图片查看工具实际查看生成的 PNG，再给视觉结论；只报路径不算完成。
4. 结束、中断或异常退出时，脚本只终止自己启动的进程组，只删除本次成功创建的 Redis 容器 ID
   与临时库；端口仍被其他进程占用时只告警，不杀未知进程。
5. 失败时读 `.visual/logs/api.log` / `.visual/logs/web.log`；重试前先确认没有本次遗留的
   容器、临时库与进程。

## 证据与交付

- 汇报真实命令、PNG 绝对路径、端口是否释放
  （`lsof -tiTCP:3000 -sTCP:LISTEN`、`lsof -tiTCP:5173 -sTCP:LISTEN`）、
  本次 Redis 容器是否已删（脚本会打印容器 ID；也可按 `pace_visual_redis_` 名称核对）、
  临时库是否已删
  （`docker compose exec -T postgres psql -U <user> -d postgres -tAc "select datname from pg_database where datname like 'pace_visual_%'"`）。
- 视觉结论以截图为准；类名、`getBoundingClientRect()` 可作补充，但不能替代真实渲染。

## 限制

- 仅桌面视口；项目不做移动端适配。
- 登录依赖 `.env` 管理员凭据；登录页变更时需同步脚本里的选择器。
- 隔离模式依赖 Docker 与本机已缓存的 Redis 镜像；固定占用 3000 / 5173。
- `--seed dev-data` 较重且依赖沙箱/模型，失败只提示，不阻塞截图。
- 自动打开仅 macOS（其他平台打印路径）。
- 截图产物在 `.visual/`（已 gitignore），不要提交。
