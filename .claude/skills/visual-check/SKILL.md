---
name: visual-check
description: >
  开发完成后的 UI 视觉抽查：一条命令启动隔离环境、登录、按多个桌面视口截图并打开，
  结束后清理。Use when the user says 生成截图、看一下效果、截个图、UI 验收、
  visual check、screenshot，或需要确认页面在真实渲染下的观感。
---

# visual-check

把「开发完生成 UI 截图看效果」固化成 `scripts/visual-shots.mjs`。默认起**隔离临时库 + API/Web**，
不写真实开发库；`--base-url` 可复用已有栈。

## 何时用

- 改完 UI 需要肉眼确认真实渲染（不是类名、不是 HTML 快照）。
- 需要对比同一路由在 1440x900 / 1200x900 等桌面视口下的效果。
- 用户说「生成截图 / 看一下效果 / 截个图」。

## 前置条件

- 仓库根有 `.env`（`ADMIN_USER`、`ADMIN_PASSWORD`，隔离模式还需 `DATABASE_URL`）。
- PostgreSQL 已运行（`pnpm infra:up` 或 `docker compose ps` 能看到 `postgres`）。
- 首次或依赖改动后先构建 api 所需包：
  `pnpm --filter @agentport/shared --filter @agentport/db --filter @agentport/core build`
- 隔离模式要求 3000 / 5173 端口空闲；被占用时先停栈或改用 `--base-url`，脚本不会杀别人的进程。

## 用法

```bash
pnpm visual:shots --route /agents
pnpm visual:shots --route /agents --route /channels --viewports 1440x900,1200x900
node scripts/visual-shots.mjs --route '/agents?q=x' --no-open
node scripts/visual-shots.mjs --route /agents --base-url http://localhost:5173
```

关键参数（完整见 `node scripts/visual-shots.mjs --help`）：

| 参数 | 说明 |
|---|---|
| `--route <path>` | 可重复；支持 query。必填 |
| `--viewports <WxH,...>` | 默认 `1440x900,1200x900` |
| `--out <dir>` | 默认 `.visual/<yyyymmdd-hhmmss>` |
| `--seed none\|minimal\|dev-data` | 默认 `minimal`（空库时造 2 个 agent + 1 个频道） |
| `--base-url <url>` | 复用已有栈；不建库、不启停服务 |
| `--wait-ms <n>` | 每页稳定等待，默认 1200 |
| `--open` / `--no-open` | 截图后是否打开，默认打开 |
| `--keep` | 调试时保留环境与服务，不清理 |

## 流程

1. 在**任务 worktree 根**执行命令（不要在主 checkout）。
2. 脚本：建临时库 `pace_visual_<ts>` → 迁移 → 起 API(3000)/Web(5173) → 健康检查 →
   `ego-browser` 登录 → 可选最小种子 → 每个视口截图 → 打开 → 停进程、删临时库。
3. 用图片查看工具实际查看生成的 PNG，再给视觉结论；只报路径不算完成。
4. 失败时读 `.visual/logs/api.log` / `.visual/logs/web.log`；重试前先确认没有遗留进程与临时库。

## 证据与交付

- 汇报真实命令、PNG 绝对路径、端口是否释放
  （`lsof -tiTCP:3000 -sTCP:LISTEN`、`lsof -tiTCP:5173 -sTCP:LISTEN`）、
  临时库是否已删
  （`docker compose exec -T postgres psql -U <user> -d postgres -tAc "select datname from pg_database where datname like 'pace_visual_%'"`）。
- 视觉结论以截图为准；类名、`getBoundingClientRect()` 可作补充，但不能替代真实渲染。

## 限制

- 仅桌面视口；项目不做移动端适配。
- 登录依赖 `.env` 管理员凭据；登录页变更时需同步脚本里的选择器。
- `--seed dev-data` 较重且依赖沙箱/模型，失败只提示，不阻塞截图。
- 自动打开仅 macOS（其他平台打印路径）。
- 截图产物在 `.visual/`（已 gitignore），不要提交。
