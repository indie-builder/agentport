# 项目 Skills 更新结果

> 本文件只记录项目 Skills（`.agents/skills/`、`.claude/skills/`、`skills-lock.json`）的更新执行与核验结果；用户级插件结果见 `docs/tasks/update-user-plugins-result.md`。

## 基线与方法

- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/update-plugins-skills`
- 起点：`9b8bebdd44286510ba93d9f966228d778323bcd8`
- CLI：`skills@1.7.4`（`npx --yes skills@latest`）
- 更新前依据：`skills-lock.json`、此前保存的 16 个来源上游快照（13 项旧快照 + openui 快照 + 后 11 项七仓库快照），按 CLI 的 `computeSkillFolderHash` 实现复算：文件按相对路径排序后依次 `update(相对路径)` + `update(内容)`；仅跳过 `.git`、`node_modules`；lock 为上游目录 hash，项目适配不改变 lock。
- 更新前把 lock、完整技能目录、`.claude/skills` 链接、逐文件 SHA256、13 个适配文件的完整 diff 保存到独立备份目录（见文末）。
- 执行 `npx --yes skills@latest update --project --yes`；CLI 只对上游 hash 变化的技能重装，不读取本地漂移。
- 更新后对 22 项未更新技能逐文件比对旧上游快照与更新前备份；对 3 项更新技能在独立空临时目录重新克隆 `samber/developer-platform-skills@e262cfeabab5f38710334540f8ca5d67b24753c2`，只读比对完整文件集合与内容。

## 结果

3 项更新，22 项已最新，0 项删除。

| 技能 | 结果 | 更新前上游 hash | 更新后上游 hash |
|---|---|---|---|
| `api-error-design` | 已更新（1.0.1 → 1.0.2） | `3ec0d5f3…2012d` | `7d4d2048…5475` |
| `api-integration-surface-strategy` | 已更新（1.0.3 → 1.0.4） | `158a5638…78fa` | `c3008c6f…f93a` |
| `public-api-design-review` | 已更新（1.0.2 → 1.0.3） | `7fdcf6a4…05d3` | `1d000a68…130b` |
| `api-and-interface-design` | 已最新 | `8bdbf1fc…f2ba` | 同左 |
| `better-auth-best-practices` | 已最新（保留适配） | `0c30be0e…66ee` | 同左 |
| `cli-interface-design` | 已最新 | `981c2191…12bc` | 同左 |
| `drizzle-orm-patterns` | 已最新（保留适配） | `d63e6d73…bcbb` | 同左 |
| `fastify-best-practices` | 已最新（保留适配） | `cd479b55…247e` | 同左 |
| `frontend-design` | 已最新 | `89496d5d…1576` | 同左 |
| `migrate-radix-to-base` | 已最新 | `e1f2030e…755e` | 同左 |
| `openui` | 已最新（保留适配） | `1f2f2737…7dac` | 同左 |
| `pnpm` | 已最新 | `d1bd6f4f…2603` | 同左 |
| `react-hook-form` | 已最新（保留适配） | `e9881245…e4d1` | 同左 |
| `react-router` | 已最新（保留适配） | `4a108fd0…f7e7` | 同左 |
| `router-core` | 已最新（保留适配，3 文件） | `c5664f69…f1a5` | 同左 |
| `router-query` | 已最新（保留适配） | `1c1cbbc7…e516` | 同左 |
| `shadcn` | 已最新（保留适配） | `b864a958…302d` | 同左 |
| `supabase-postgres-best-practices` | 已最新 | `e14e2762…5e60` | 同左 |
| `tailwind-design-system` | 已最新 | `4e5bfe5a…4f89` | 同左 |
| `tanstack-query-best-practices` | 已最新（保留适配） | `8e5a7e3c…6719` | 同左 |
| `test-driven-development` | 已最新 | `3cfe4ebb…2e05` | 同左 |
| `vercel-react-best-practices` | 已最新 | `3219a194…2357` | 同左 |
| `verification-before-completion` | 已最新 | `b529822b…1651` | 同左 |
| `vite` | 已最新 | `88ee465f…a486` | 同左 |
| `vitest` | 已最新（保留适配） | `90f1cee9…5291` | 同左 |

3 项更新的实际内容变更：

- `api-error-design`：版本号与工作量表述。
- `api-integration-surface-strategy`：版本号、MCP 自建成本表述，`references/surface-condition-tables.md` 同步更新。
- `public-api-design-review`：版本号、评审计划工作量表述，`evals/evals.json` 同步更新。

这 3 项没有项目适配，无需补回。

## 项目适配核验

- 11 个技能、13 个文件保留既有适配，更新前后与旧上游的差异和备份完全一致：
  - `shadcn`：`SKILL.md` 的 `pnpm dlx`、当前 worktree 根加 `-c packages/web` 规则；`preset decode/url/open` 不加 `-c`。
  - `openui`：仅 `SKILL.md` 的 `description` 与 Project convention 两处。
  - 技术栈组 9 项 11 文件：`better-auth-best-practices`、`drizzle-orm-patterns`、`fastify-best-practices`、`react-hook-form`、`react-router`、`router-core`（`SKILL.md`、`data-loading/SKILL.md`、`ssr/SKILL.md`）、`router-query`、`tanstack-query-best-practices`、`vitest`。
- 未出现本地独有文件、远端独有文件或未登记内容漂移。
- 实物验证：`pnpm dlx shadcn@latest info --json -c packages/web` 退出 0，返回的 `resolvedPaths.cwd` 为当前 worktree 的 `packages/web`。
- 未安装 `node_modules`；`pnpm dlx` 按需拉取执行。npm 的 `Unknown project config "strict-peer-dependencies"` 是警告，不影响退出码。

## 完成核验

- lock 25 项 = `.agents/skills` 25 个目录 = `.claude/skills` 25 个有效相对链接（均解析到当前 worktree）= `skills list` 25 项 = `docs/SKILLS.md` 清单 25 项。
- 22 项未更新技能与更新前备份逐字节一致；3 项更新技能与独立克隆的新上游文件集合、内容逐字节一致（排除官方不安装的 `metadata.json`）。
- 全部 lock `computedHash` 与对应上游目录 hash 一致；`vercel-react-best-practices`、`react-hook-form` 的上游 hash 含官方 `metadata.json`，本地按 CLI 规则不复制该文件。
- 无上游删除项；无技能需要新增或移除。

## 文档修正

`docs/SKILLS.md` 原文只说“lock 存上游 hash，不是本地内容 hash”，未说明上游 `metadata.json` 会计入 hash 但不被安装，实际核验时会被误判为不一致。已在该条补充 CLI 1.7.4 的这一行为与判断口径；其余内容与实际一致，未改动。

## 证据与可重跑脚本

- 备份目录：`/tmp/skills-update-backup.Ekzo4a/`
  - `skills/`：更新前完整技能目录
  - `claude-skills-symlinks/`：更新前链接
  - `skills-lock.json`、`SKILLS.md`、`sha256-files.txt`
  - `adaptation-diffs/`：13 个适配文件与旧上游的 unified diff 及 `inventory.json`
  - `update.log`、`baseline.txt`、`final.txt`、`shadcn-info.json`、`skills-list-before.txt`、`skills-list-after.txt`
- 验证脚本（独立目录，可重跑）：`/tmp/skills-update-verify.xyL1xo/`
  - `node compare.mjs`：复算更新前 lock、本地目录与旧上游快照
  - `node verify-final.mjs`：更新后完整核验，当前输出 `RESULT PASS`
- 新上游独立快照：`/tmp/skills-upstream-samber.6jaz0S/repo`（`e262cfeabab5f38710334540f8ca5d67b24753c2`）

## 限制与未完成

- 22 项“已最新”基于本次执行时各上游默认分支与 lock 的 hash 对比；未锁定上游 commit，后续上游变动需再次更新。
- 旧上游快照来自此前任务保存的临时目录，已按 CLI 算法重新复算并全部与更新前 lock 一致；临时目录若被系统清理，需从 lock 与备份重新建立基线。
- 本次未 commit / push / merge，Skills 新版仅位于本任务 worktree，未合入主 checkout。
- 用户级插件的磁盘更新见独立结果记录；当前会话可用 `/reload-plugins` 加载新版，或重启 / 开启新会话。未在本任务中执行重载。
