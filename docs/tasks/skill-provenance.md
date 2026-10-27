# 技能来源字段持久化（skill provenance）

## 目标

把 `packages/core` 已能解析/渲染的 `license` / `compatibility` / `metadata`（`SkillProvenance`）落进 DB，导入、市场安装、更新与导出不再丢字段。

验收：`skills` 表出现三列；迁移编号 0038 且 SQL 只含这三列；shared 类型与 repo 写入链路带上字段；build/typecheck/test 通过。

## 方案

- `packages/db/src/schema.ts`：`license` / `compatibility` 为可空 `text`；`metadata` 为 `jsonb().$type<Record<string, unknown>>().notNull().default({})`，与 `knowledge_documents.metadata` 写法一致。
- `packages/shared/src/agent.ts`：`skillInputSchema` 增加三个可选字段，`skillSchema` 经 `and` 自动继承。
- `packages/db/src/repo/skills.ts`：`SkillWrite` 补三字段；`create*` 的 `{ id, ...input }` 自动写入，`updateSkill` 的 `...patch` 同样覆盖；`listSkills` 显式 select 补三列。
- 读取侧由同任务并行改动新增的 `toSkillDefinition` 把 DB `null` / 空 metadata 折叠成缺省，避免导出空字段。

关键取舍：`license`/`compatibility` 按任务要求保持可空；不用 `notNull default ''`，因为“未提供”与空字符串在 frontmatter 导出时应可区分。

## 基线与范围

- 起点：`origin/main` `e824377`（Merge PR #47）。
- 开工时 `git status --porcelain` 为空。
- 允许改动：`packages/db/**`、`packages/shared/**`、`packages/core/src/skill-md.ts`（仅为类型兼容）、`docs/tasks/skill-provenance.md`。
- 不改 `packages/api/**`、`packages/worker/**`（另一代理负责，同树并行改动）。

## 当前有效决定

- 迁移编号固定 0038，接在 0037 之后。
- `metadata` notNull default `{}`；另两列可空。
- 不提交、不合并，验证完成即交付。

## 已替代项及原因

- 曾把 `SkillProvenance` 放宽为接受 `null`。替代为在 `toSkillDefinition` 折叠 null、`parseSkillMd` 逐字段构造，保持 core 契约严格，避免波及 api 的类型。
- 本地库已存在三列（`license`/`compatibility` 为 `not null default ''`，与迁移不兼容）。确认唯一一行技能无任何来源数据后，删除这三列并按迁移重建，使列定义与 schema 一致且迁移账本记录 0038。

## 步骤

- [x] schema 加三列
- [x] `pnpm db:generate` 生成 0038，人工核对 SQL 与 snapshot/journal
- [x] shared `skillInputSchema` 加三字段
- [x] repo `SkillWrite` 补字段，确认 create/update 展开生效
- [x] 构建 shared/db，执行 `pnpm db:migrate`
- [x] `\d skills` 实证列存在
- [x] 跑 backend 测试

## 改动文件

- `packages/db/src/schema.ts`
- `packages/db/src/repo/skills.ts`
- `packages/db/migrations/0038_funny_spitfire.sql`
- `packages/db/migrations/meta/0038_snapshot.json`
- `packages/db/migrations/meta/_journal.json`
- `packages/shared/src/agent.ts`
- `packages/core/src/skill-md.ts`（`parseSkillMd` 返回逐字段构造，规避 exactOptionalPropertyTypes 冲突）
- `docs/tasks/skill-provenance.md`

## 下一步

- api 侧 `patchSchema`、market 安装注释与 `toApi` 的字段透传由并行代理收尾；本任务不触碰。
- 未提交、未合并。

## 验证

- `pnpm -r typecheck`：7 包通过
- `pnpm test`：**2223 / 2223 通过**（260 文件）。首次全量运行时 `worker/test/knowledge-wiki.test.ts` 有一条取消信号用例超时（20s），单跑 8/8 通过、复跑全量通过，属该项目既有的并行不稳定项，与本次改动无关。
- `biome check .`：仅 `packages/api/src/features/knowledge/package.ts` 的 17 处既有警告，不属本次改动
- 迁移实证：`\d skills` 显示 `license`/`compatibility` 为可空 text，`metadata` 为 `jsonb NOT NULL DEFAULT '{}'`；账本记录 0038（`created_at = 1793031472086`），哈希与迁移文件一致
- 集成测试真实执行（Postgres/Redis healthy，无 skip）：`skills.test.ts`、`agent-package-zip.test.ts`、`market-install.test.ts`、`skill-md.test.ts`
- 独立 Opus 审查：2 个阻断项（PATCH 静默丢弃来源字段、同名技能复用不比较来源字段）与 2 个建议项（长度约束不一致、测试断言过弱）已全部修复并复核

## 修复过程中发现并处理

- PATCH 原先不接受三字段：带 `license` 的更新会返回 200 并推进 `updatedAt`，值却没写入。已补 schema 与 handler 透传，`null` 表示显式清空。
- 专家包导入复用同名技能时，若只有来源字段不同，原先既不写入也不告警。已把规范化后的三字段加入漂移比较（metadata 按键排序后比较，避免 JSONB 键序误判）。
- `license`/`compatibility` 的长度上限在 core 与 shared 之间不一致（201 字符能解析但过不了 schema），统一为 200。

## 下一步

- 无。
