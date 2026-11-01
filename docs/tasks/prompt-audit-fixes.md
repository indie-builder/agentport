# 提示词审计修正

## 目标
按 /claude-api prompt-audit 结论，修复知识库 MCP 工具描述欠描述、工作区提示词中的 TodoWrite 数量编排，以及文档层的陈旧/冲突条文；不改运行时行为。

## 方案
应用审计中高/中置信度的 hunk；`docs/VALIDATION.md` 一条因终审发现与现存回滚行为冲突而撤回，其余按终审意见修正后提交。

## 基线与范围
起始 commit 411bcb2（origin/main）。允许改动：
- `packages/api/src/features/knowledge/mcp.ts`
- `packages/core/src/workspace.ts`
- `CLAUDE.md`
- `docs/VALIDATION.md`
- `docs/DEV-WORKFLOW.md`
- `docs/SKILLS.md`
- `docs/PITFALLS.md`
- `docs/tasks/prompt-audit-fixes.md`

## 当前有效决定
只做提示词/文档修正，不改变业务行为；未授权合并到 main，PR 由主会话创建。
审计中低置信度项（`packages/web/CLAUDE.md`「旧规则」措辞、`CLAUDE.md` 日期坐标、`memory-review.ts` 的 JSON 强制语、`SKILLS.md` 历史日期）不纳入本次改动。
根规则「不做向后兼容」与该现存回滚分支的冲突记录为待决策项，不在本次改动中处理。

## 已替代项及原因
无。

## 步骤
- [x] `packages/api/src/features/knowledge/mcp.ts`：为 knowledge_search / knowledge_read / knowledge_list / knowledge_read_image 补 3–4 句描述与逐参数 description，类型与约束不变
- [x] `packages/core/src/workspace.ts:348`：TodoWrite 段落去掉「三步以上」与字段/节奏编排，只保留产品目标
- [x] `CLAUDE.md:107`：E2E 描述改为「不新增其他 E2E 框架的用例」，去掉已退役 Playwright 的陈述
- [ ] `docs/VALIDATION.md:84`：未采用——终审发现 `packages/api/src/features/agents/routes.ts:380` 仍为旧快照保留当前岗位，文档按现行为恢复，兼容分支是否删除另行决定
- [x] `docs/DEV-WORKFLOW.md:86`：删去 `ensureAdmin` 历史实现叙述，只保留 `ensureBootstrap` 当前行为
- [x] `docs/SKILLS.md:100`：去掉写死的技能适配数量，改为以各 `SKILL.md` 的 `Project convention` 为准
- [x] `docs/PITFALLS.md:423`：`pnpm --filter api exec tsx` 改为 `pnpm --filter @agentport/api exec tsx`
- [x] 运行 typecheck 与定向测试并回填验证结果

## 改动文件
- `packages/api/src/features/knowledge/mcp.ts`
- `packages/core/src/workspace.ts`
- `CLAUDE.md`
- `docs/VALIDATION.md`
- `docs/DEV-WORKFLOW.md`
- `docs/SKILLS.md`
- `docs/PITFALLS.md`
- `docs/tasks/prompt-audit-fixes.md`

## 下一步
复核修正后提交并创建 PR；VALIDATION 兼容分支作为待决策项在 PR 中说明。

## 验证
- `pnpm --filter @agentport/api typecheck` → 通过（tsc -b 无错误）
- `pnpm --filter @agentport/core typecheck` → 通过（tsc -b 无错误）
- `pnpm vitest run packages/api/test/knowledge-mcp.test.ts packages/api/test/knowledge-publishing-integration.test.ts packages/core/test/workspace.test.ts` → 3 个文件、63 个用例全部通过
- `biome check` 两文件 → 通过（经 `rtk bypass` 运行；直接 `pnpm exec` 的报错来自 RTK 包装层，非 biome 结果）
- grep 确认无测试或文档仍断言旧描述文案
- 独立 Opus 终审：4 条 P2；3 条工具描述已按实际检索行为修正，1 条文档改动已撤回
