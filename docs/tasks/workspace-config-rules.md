# 工作区建树与启动配置规则

## 目标

把「旧 worktree 的 `.env` 被复制、已确认的 admin 密码变旧」这类问题固化成可执行的单一规则：新任务以最新 `origin/main` 建树，配置默认取主 checkout，启动前核对关键项，登录态不被调试任务改掉。

## 方案

权威规则一次写进 `docs/DEV-WORKFLOW.md`：§2 建隔离环境改为「fetch 后从主仓库绝对路径以 `origin/main` 建树」，新增「配置与启动」小节；`CLAUDE.md` 只加短指针；`PITFALLS.md` 修两条与新规则矛盾的旧条目（`.env` 复制、本地 main 建树）。不新增脚本、门禁或框架。

## 基线与范围

- 起点：`ff0a6d7`（与当时 `origin/main` 相同）；本 worktree 无既有未提交差异。
- 允许改动：`CLAUDE.md`、`docs/DEV-WORKFLOW.md`、`docs/PITFALLS.md`、本记录。不改业务代码、依赖、配置、hooks、CI，不安装、不委派、不 commit。

## 当前有效决定

- 建树：先 `git fetch origin main`，新任务从主仓库用绝对路径以 `origin/main` 建；本地 main 不等于最新，主 checkout 默认不写并保持干净。
- 不在旧 worktree 下套娃建树；当前嵌套目录属历史，不重构。
- 工作区项目指令仍要求产出只落在 worktree。
- 配置：`.env` 不受 Git 管理，`.worktreeinclude` 只是初始化副本且可能取自发起建树的旧树，不能视为最新；默认配置入口为主 checkout `.env` 绝对路径。现有加载只认 `../../.env`，不存在 `.env.local` 优先级，不自创。
- 用户最新明确决定优先于磁盘残留；主 checkout `.env` 当前也旧，之前确认的弱口令管理员只存在于历史工作树与容器本地 override，不能把「来自 main 的 `.env`」等同于用户决定。
- 启动前核对改动过的关键项，日志不输出明文密码。各树可共用数据库，首次登录时 `ensureAdmin` 会按启动配置重播管理员；调试/测试不得改用户登录。
- 旧 worktree 与遗留镜像不作默认运行源；已合并验收跑最新 `origin/main`，未合并功能仅显式按功能树预览并标注。
- 每次启动只记录代码根目录、commit、配置路径、URL；不新增 preflight 脚本、框架或重 CI。
- 权限不允许写主配置时明确说明「未同步」，不声称已修好，不反复请求批准；任务内可用已确认的临时配置恢复服务。
- 本次由主会话直接定契约，不再另起 Opus 设计探索。

## 已替代项及原因

- 原 PITFALLS「复制 `.env` 即完成配置」：会让旧值被当成最新，已改为「复制结果不代表最新」。
- 原 PITFALLS「以本地 main 对齐、`git merge --ff-only main`」：方向与最新 `origin/main` 相反，已改。
- 原 DEV-WORKFLOW「`EnterWorktree` 建树、完成判据仅看位于 `.claude/worktrees/<name>`」：未约束起点与路径，已改为主仓库绝对路径 + `origin/main`。

## 步骤

- [x] 读 `CLAUDE.md`、`DEV-WORKFLOW.md`、`PITFALLS.md`、`docs/tasks/local-admin-login.md`
- [x] 核对 env 加载方式（`--env-file-if-exists=../../.env`）与 `ensureAdmin` 重播行为
- [x] 改 DEV-WORKFLOW 建树步骤与新增「配置与启动」
- [x] 加 CLAUDE.md 短指针
- [x] 修 PITFALLS 两条旧条目
- [x] 本记录
- [x] `git diff --check` 与规则对照

## 改动文件

- `CLAUDE.md`
- `docs/DEV-WORKFLOW.md`
- `docs/PITFALLS.md`
- `docs/tasks/workspace-config-rules.md`

## 下一步

无。未提交，未运行应用测试（纯 Markdown）。

## 验证

- `/usr/bin/git rev-parse HEAD`：`ff0a6d7`，与 `origin/main` 相同；本地 `main` 为 `797edfe`（落后），确认「本地 main 不等于最新」。
- `git diff --check`：无输出，退出码 0。
- `git diff --stat`：`CLAUDE.md` +1/-1、`docs/DEV-WORKFLOW.md` +19/-4、`docs/PITFALLS.md` +8/-8（另新增本记录），在 30–60 行约束内。
- 规则对照：建树已写 `fetch origin main` + 主仓库绝对路径 + 不套娃 + 主 checkout 干净；配置已写 `.worktreeinclude` 非最新、主 checkout `.env` 默认入口、无 `.env.local` 优先级、用户最新决定优先、启动前核对关键项、不输出明文密码、`ensureAdmin` 首次登录重播风险与登录态保护、旧树/遗留镜像不作运行源、四要素记录、权限受限如实说明。
- 代码核对：`packages/api/package.json`、`worker`、`db` 均只用 `--env-file-if-exists=../../.env`（web 的 `vite.config.ts` 不读 `.env`，故规则按 api/worker/db 描述）；`packages/api/src/features/auth/routes.ts:48` 在首次登录前调用 `ensureAdmin`，`better-auth.ts:72` 按当前配置覆盖唯一管理员，确认「共用库 + 旧配置会重播密码」；主 checkout `.env` 存在（644），本 worktree 无 `.env`。
- 未运行应用测试、类型检查或构建（纯 Markdown）；未启动服务；未提交。
