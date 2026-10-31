# web 知识库草稿保护去重（2026-11-01）

## 目标

把 `packages/web` 中三份完全重复的 `useDraftGuard` hook 与 `DraftGuardDialogs` 组件收敛为一份，保留在 `knowledge-shared.tsx` 并导出，其余两处改为引入。

验收标准：

- 三份副本在动手前逐行比对完全一致（仅允许 `export` 关键字差异）。
- 收敛后行为、文案、类名、样式、props 与调用点语义不变。
- 仅清理因删除副本而不再使用的 import，不删除或改动其它重复项（如 `useMediaQuery`）。
- `pnpm --filter @agentport/web typecheck`、`pnpm test:web`、`git diff --check`、biome 检查通过。

## 方案

先对三处副本做逐行文本比对（提取固定行区间后 diff，并归一化 `export ` 前缀，避免哈希或 JSX 花括号截断造成误判）。确认完全一致后：

1. `knowledge-shared.tsx` 保留 `export function useDraftGuard` / `export function DraftGuardDialogs` 作为唯一实现，不改动函数体。
2. 删除 `knowledge-settings.tsx` 与 `pages/knowledge.tsx` 内的本地副本。
3. 两处改为从共享模块引入，import 路径沿用项目现有相对路径 + `.js` 扩展名习惯（`./knowledge-shared.js` / `../components/knowledge-shared.js`）。
4. 删除因此不再使用的 `useFormBlocker` import；`ConfirmDialog`、`useEffect`、`useRef`、`useState` 在两个文件中仍有其它使用，保留。

不做重构、不新增抽象、不改任何实现细节。

## 基线与范围

- 起点：`origin/main` `c035144`。
- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-cleanup-loop-20261101-0445`，分支 `worktree-codebase-cleanup-loop-20261101-0445`。
- 初始未提交差异：无（`git status` 干净）。
- 允许改动：`knowledge-shared.tsx`（已含唯一实现，本次未改）、`knowledge-settings.tsx`、`pages/knowledge.tsx`，以及本任务记录。
- 不改动：主 checkout、`useMediaQuery` 或其它重复项、视觉与行为代码。

## 当前有效决定

- 用户要求等价搬移，行为与视觉不变；不 commit、不 push。
- 唯一实现保留在 `knowledge-shared.tsx`，另外两处改为引入。
- import 风格按仓库现状使用相对路径 + `.js`（`@/` 别名在本仓库知识库相关模块中未使用）。

## 已替代项及原因

无。

## 步骤

- [x] 提取三处行区间：`knowledge-shared.tsx:189-243`、`knowledge-settings.tsx:46-100`、`pages/knowledge.tsx:218-272`，各 55 行。
- [x] 归一化 `export ` 前缀后逐行 diff：shared vs settings、settings vs page 均无输出（退出码 0），确认三份逐字相同（仅 `export` 关键字差异）。
- [x] 删除 `knowledge-settings.tsx` 与 `pages/knowledge.tsx` 内的本地 hook/组件副本。
- [x] 两处改为从共享模块引入 `DraftGuardDialogs`、`useDraftGuard`；清理不再使用的 `useFormBlocker` import。
- [x] 运行 typecheck、全量 web 测试、`git diff --check` 与 biome 检查。

## 改动文件

- `packages/web/src/components/knowledge-settings.tsx`
- `packages/web/src/pages/knowledge.tsx`
- `docs/tasks/codebase-cleanup-loop-20261101-0445.md`（本记录）

`packages/web/src/components/knowledge-shared.tsx` 已是唯一实现，本次未改动。

## 下一步

无（等待主会话按流程终审与交付；未提交、未推送）。

## 验证

真实结果（2026-11-01，worktree 内）。

改前：

- 三份副本各 55 行，归一化 `export ` 后 `diff -u` 两次比对均无输出，退出码 0。
- 初始 `pnpm --filter @agentport/web typecheck` 因新 worktree 缺 workspace `dist`（`Cannot find module '@agentport/shared'`）失败，与本次改动无关；按 `docs/PITFALLS.md` 先构建 `@agentport/shared`、`@agentport/core`、`@agentport/db`。

改后：

- `grep -rn "function useDraftGuard\|function DraftGuardDialogs"` 仅命中 `knowledge-shared.tsx:189`、`:210`（均为 `export function`），无本地副本残留。
- `pnpm --filter @agentport/web typecheck`：`$ tsc -b`，退出 0。
- `pnpm test:web`：148 个测试文件、1841 个用例全部通过。
- `git diff --check`：退出 0，无空白错误。
- `./node_modules/.bin/biome check`（三个相关文件）：首次提示 `pages/knowledge.tsx` import 排序，调整 `knowledge-settings` / `knowledge-shared` 顺序后复跑为 `Checked 3 files ... No fixes applied`，无错误。
- `/usr/bin/git diff --stat`：2 个文件，2 行新增（两处 import），116 行删除。

红测试不适用的理由：本次是等价搬移，删除的是与保留实现逐字相同的副本，没有新增或改变任何分支、依赖、状态或渲染逻辑；能被测试捕获的行为差异在搬移前即已排除（逐行 diff 一致），因此先写失败测试没有可观察的失败信号。搬移后的等价性由 typecheck、既有 1841 项用例与调用点未变共同证明。
