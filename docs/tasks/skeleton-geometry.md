# 共享骨架几何对齐

## 目标

让共享加载骨架（`LoadingState`）的盒子与真实内容一致，减少数据到达时的布局跳动；不引入任何新依赖（不接 skullet）。

验收：
- 卡片骨架高度与设计规范中的卡片高度一致（208px / `h-52`）。
- 卡片骨架列数与各页真实卡片网格一致。
- 不改变骨架的静态约束（DESIGN-SYSTEM §11）与共享骨架契约。

## 方案

评估了 skullet（智能骨架屏库）后放弃引入：0.0.3 版本、发布 5 天、与 §11「骨架屏保持静态、不做入场动画」及「shadcn/ui 单一实现」冲突，且本项目是 SPA，其 SSR 价值不适用。

改为零依赖收口：
1. `packages/web/src/components/states.tsx`：`layout="cards"` 的骨架高度 `h-48`（192px）→ `h-52`（208px），对齐 DESIGN-SYSTEM §9 专家卡/资源卡的 208px 基准。
2. `LoadingState` 增加 `columns?: 3 | 4`（默认 4），让真实网格最多 3 列的页面使用 3 列骨架：`runs.tsx`、`personal-shares.tsx`、`personal-usage.tsx`。
3. `LoadingState` 增加 `layout="list"`：`@container` + `grid grid-cols-1 gap-x-6 gap-y-0.5 @4xl:grid-cols-2`，单项 `h-14.5`（58px，与真实条目同高）`rounded-item`，对齐技能市场的真实两列行列表；`skills.tsx` 两处（市场列表加载、本地技能列表 pending）改用它。

不改：表格骨架（`data-table.tsx` 已按 `h-14` 对齐 `min-h-14` 真实行高）、默认 `rows` 布局（`h-11` 是通用列表占位，逐页实测前不动）。

## 基线与范围

- 起始 commit：`ee4523d`（= `origin/main`）。
- 初始未提交差异：无。
- 允许改动文件：
  - `packages/web/src/components/states.tsx`
  - `packages/web/src/pages/runs.tsx`
  - `packages/web/src/pages/personal-shares.tsx`
  - `packages/web/src/pages/personal-usage.tsx`
  - `packages/web/src/pages/skills.tsx`
  - 本任务记录

## 当前有效决定

- 用户确认「按建议来」：采用零依赖方案，不引入 skullet。
- 用户追加确认：同时修掉技能市场那处既有错配，并起本地服务供其查看加载效果。
- 不为骨架做按页定制形状；只对齐尺寸、列数与列表形态。

## 已替代项及原因

- 引入 skullet 作为依赖：放弃，原因见「方案」。

## 步骤

- [x] 改 `LoadingState` 卡片高度为 `h-52` 并新增 `columns` 选项
- [x] 三个 3 列页面传 `columns={3}`
- [x] 新增 `layout="list"`，技能市场两处加载态改用它
- [x] 验证 typecheck / build
- [ ] 用户本地查看加载效果

## 改动文件

- `packages/web/src/components/states.tsx`
- `packages/web/src/pages/runs.tsx`
- `packages/web/src/pages/personal-shares.tsx`
- `packages/web/src/pages/personal-usage.tsx`
- `packages/web/src/pages/skills.tsx`

## 下一步

- 终审通过后等用户验收。
- 未授权提交；工作树保留待验收。

## 验证

- `pnpm --filter @agentport/shared --filter @agentport/core build`：通过。
- `pnpm --filter @agentport/web typecheck`：通过（worktree 首次运行前需先构建 shared/core）。
- `pnpm --filter @agentport/web build`：通过（仅有既有的 chunk 体积警告）。
- 列表骨架行高：真实条目 58px（`text-base` 22 + `text-xs` 16 + `py-2.5` 20），骨架用 `h-14.5`；构建产物确有 `h-14\.5{height:calc(var(--spacing) * 14.5)}`。
- `git diff`：5 文件（states.tsx、runs、personal-shares、personal-usage、skills）；未提交。
- 未做浏览器内像素测量：骨架只在 pending 期间出现，未在登录后的真实页面抓取 `getBoundingClientRect()`；本地已起 `http://localhost:5173` 供用户自查。`h-14.5` 的 58px 有构建产物证据，骨架与真实条目的列数/间距来自同一组类名。

### 浏览器实测（2026-11-01，ego-browser + CDP 限速）

环境：worktree dev server `http://localhost:5173`，API 在本树 3001 端口，使用隔离库 `agentport_preview`（共享库迁移台账与 main 不一致，未改动）。

- 技能市场列表骨架：网格 2 列（590px + 590px），8 项，每项实测 58px —— 与真实条目一致。
- 技能首页卡片骨架：3 列（视口 <1536px 时为 xl:3），4 项，每项实测 208px。
- 运行页卡片视图骨架：3 列，3 项，每项实测 208px。
- 截图：`/tmp/agentport-preview/market-list.png`、`skills-cards.png`、`runs-cards.png`。

## 环境修复（本次顺带发现）

预览登录时发现共享库 `agentport` 的 drizzle 台账与仓库 journal 不一致（台账最大 `created_at` 早于 0043，实际结构停在 0043 之前），导致所有 API 登录 500。

处理方式（经用户授权，已有 `pg_dump -Fc` 备份 `/tmp/agentport-backup-before-migration.dump`）：

- 只读核验实际结构与 journal，确定真实基线；在 dump 恢复的副本库完整演练。
- 台账：删除 49 条旧记录，按仓库 0000–0046 的 47 条真实 `(hash, created_at)` 重建。
- 0043：不重跑（对象已存在），补齐漂移（删 `agents.max_thinking_tokens`、`memory_changes.state` 默认值改回 `applied`）。
- 0044 / 0046：原样执行；0046 额外回填 39 条 feed 文档的来源与范围、155 个版本 `origin`。
- 0045：四条 NOT NULL 加列改为「先可空 → 回填 → SET NOT NULL」；历史无主体字段的数据统一归现有 admin（业务 ID `bootstrap-admin`）；审计按 actor 分类回填；种子化 4 角色 / 187 权限 / 1 条 user_roles。
- 验证：台账 47 条、`pnpm db:migrate` 无新增；登录 200；`platform_bootstrap` = `initial/bootstrap-admin/0`；92 专家 / 95 运行 / 53 会话 / 291 消息保持不变；审计 60493 user + 393 anonymous + 407 service。

备份文件与预览库 `agentport_preview` 为临时产物，确认无误后可删除。
