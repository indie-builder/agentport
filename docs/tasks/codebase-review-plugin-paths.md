# 插件导入的文件/目录祖先冲突

## 目标

只处理 codebase-review-loop 报告的一个有限发现：`parsePluginFiles` 目前只按 `Set` 检查完全相同的重复路径，`references`（文件）与 `references/guide.md` 这类「一个路径是另一个路径的祖先」能以 201 导入，但 `renderPlugin` 原样保留后，worker 落盘时同一路径既当文件又当目录而失败。

验收：

- 任一插件文件的路径是另一文件路径的祖先时，无论两个路径在输入中的先后顺序，都在 `parsePluginFiles` 入口返回 `INVALID_INPUT`，并给出明确的冲突路径。
- 合法引用文件（如 `references/guide.md`、`references-extra/guide.md`）与正常嵌套不会被误判。
- 既有完全重复、路径语法、manifest 安全、组件约束行为保持不变。
- 先有真实 parse 行为的失败测试，再做最小修复；不提交，交 Opus review。

## 方案

- 在既有 `parsePluginFiles` 的路径校验入口，组装完全部文件路径的 `Set` 后，对每个路径按 `/` 逐段取出祖先前缀，命中已有文件路径即拒绝。按段前缀匹配，避免把 `references-extra` 误认成 `references` 的后代。
- 错误指向祖先路径（既是文件又被当作目录的那一条），消息同时写明冲突的后代文件，保证两个输入顺序结果一致、`path` 明确。
- 大小写规则沿用插件现有契约：`pluginFilePathSchema` 与现有重复路径检查都是大小写敏感，不引入技能包那套大小写不敏感/保留 `SKILL.md` 的语义。
- 先看现有纯路径 helper：`findSkillResourcePathConflict`（`packages/shared/src/agent.ts`）带大小写折叠并固定保留 `SKILL.md`，是技能资源专用语义，不能直接套到插件；本任务也不允许改 shared，故不复用。
- 不按文件长度拆函数，不改 `routes.ts`、ZIP codec、权限测试（另作者独占）。

## 基线与范围

- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-review-loop`
- 分支：`worktree-codebase-review-loop`
- 基线：`HEAD` = `e060e3a559633a0d94adb637516a6d577b86b1aa`
- 开工时本任务独占文件均无未提交差异：
  - `packages/api/src/features/plugins/parse.ts`
  - `packages/api/test/plugin-parse.test.ts`
  - `docs/tasks/codebase-review-plugin-paths.md`（本记录）
- 工作树内其他已修改/未跟踪文件来自并行任务，不属于本任务，不提交、不还原、不覆盖。
- 允许改动：仅上述 3 个文件。

## 当前有效决定

- 用户本轮明确：有限执行，不派代理、不提交；只改上述 3 个文件；不改插件 routes、ZIP codec、权限测试。
- 用户本轮明确：最小改动放在既有 parse 入口，判「任一文件路径是另一文件祖先」，两种输入顺序都拒绝；合法 refs 与正常嵌套不误伤。
- 用户本轮明确：保持既有完全重复/路径语法/manifest 安全/组件约束；大小写按原插件实际契约，不新增理论策略。
- 既有名称/字段与文档冲突时以代码实际实现为准，并在最终回复列出。

## 已替代项及原因

- 无。

## 步骤

- [x] 写任务记录，固定范围、方案与基线。
- [x] 在 `packages/api/test/plugin-parse.test.ts` 写会失败的真实 parse 行为测试：两个顺序都拒绝、`path` 指向祖先；合法兄弟目录与正常嵌套仍通过。
- [x] 跑该测试确认失败原因符合预期（当前错误地返回 201）。
- [x] 在 `packages/api/src/features/plugins/parse.ts` 做最小修复。
- [x] 跑完整 `plugin-parse.test.ts`、`packages/api` typecheck 与 biome；更新本记录。

## 改动文件

- `packages/api/src/features/plugins/parse.ts`
- `packages/api/test/plugin-parse.test.ts`
- `docs/tasks/codebase-review-plugin-paths.md`

## 下一步

- 待 Opus 独立 review；未提交差异交付。
- 已知限制（未在本任务扩大）：祖先冲突沿用插件现有的大小写敏感契约，`References` 与 `references/guide.md` 不判冲突；插件渲染在大小写不敏感文件系统上的跨平台行为不在本次范围。

## 验证

**红（修复前）**

- `pnpm exec vitest run packages/api/test/plugin-parse.test.ts` → **13 tests，1 failed / 12 passed**。
- 失败原因与预期一致：祖先冲突用例没有抛错（`error` 为 `undefined`），即 `references` 与 `references/guide.md` 仍被当作合法目录导入；合法兄弟/嵌套路径用例已通过。

**绿（修复后）**

- `pnpm exec vitest run packages/api/test/plugin-parse.test.ts` → **13 passed**。
- `pnpm exec vitest run packages/api/test/plugin-parse.test.ts packages/api/test/plugins.test.ts packages/api/test/native-plugins.test.ts` → **3 files / 29 tests passed**（route 入口既有测试未改动）。
- `pnpm --filter @agentport/api typecheck` → `tsc -b`，exit 0。
- `./node_modules/.bin/biome check packages/api/src/features/plugins/parse.ts packages/api/test/plugin-parse.test.ts` → `Checked 2 files ... No fixes applied`，exit 0。
  - 备注：本环境 `pnpm exec biome` 包装调用报 `Command "eslint" not found`/`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`，与本次改动无关；直接运行仓库内 biome 二进制结果如上。
