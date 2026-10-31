# 全仓无引用死代码清理（2026-11-01）

## 目标

删除一批已确认「全仓无真实引用」的死代码与零引用类型别名，降低维护噪音，不改变任何运行时行为、接口契约、错误处理、校验、文档与视觉。

验收标准：

- 清单内每一项在删除前均以 `rg` 在同一 worktree 内重新核实，排除 `node_modules`、`dist`、`pnpm-lock.yaml`。
- 仅删除目标符号及仅被其使用的 import/辅助；发现任何真实引用（代码、字符串、动态入口、测试、fixtures、E2E、scripts、配置）即保留并报告。
- `git diff --check` 通过。

## 方案

逐项 `rg` 精确核实后直接删除符号；同文件内检查 import 使用情况，只清理因本次删除而不再使用的 import。不做重构、不新增抽象、不改文档、不改迁移。

清单：

1. `packages/api/src/features/knowledge/mcp.ts`：`KNOWLEDGE_TOOL_NAMES`
2. `packages/db/src/repo/knowledge.ts`：`deleteVersionsExcept`、`nextChunkOrdinal`、`deleteChunk`
3. `packages/api/src/features/knowledge/faq.ts`：`faqEntrySchema`、`faqTransferEntrySchema`、`isNegativeFaqQuestion`、`duplicateFaqQuestions`
4. `packages/shared/src/openui/index.ts`：`openUiToolsCacheKey`
5. `packages/shared/src/redact.ts`：`redactQuestion` 兼容别名
6. `packages/web/src/lib/access.ts`：`groupState`
7. `packages/web/test/me-fixture.ts`：`meQueryStub`
8. 零引用类型别名：`PublicConversation`、`KnowledgeAudioSegment`、`KnowledgeFaqImportCounts`、`KnowledgeImageChunkMetadata`、`KnowledgeWikiLink`、`KnowledgeWikiPage`、`KnowledgeDocumentSourceRangeRow`、`PersonalShareListQuery`、`PersonalUsageQuery`、`UpdatePersonalProfileInput`、`RuntimeEnvironmentOnlineVersionInput`

## 基线与范围

- 起点：`origin/main` 6017b10。
- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-cleanup-loop-20261101-0055`，分支 `worktree-codebase-cleanup-loop-20261101-0055`。
- 初始未提交差异：无（`git status` 干净）。
- 允许改动：上述清单涉及的源码与测试 fixture，以及本任务记录。
- 不改动：主 checkout、文档正文、迁移、视觉与行为代码。

## 当前有效决定

- 用户明确要求只做删除与必要的 import 清理，不重构、不改行为、不改文档、不 commit/push。
- 验证由主会话执行（本记录已回填真实结果）。

## 已替代项及原因

无。

## 步骤

- [x] 用 `rg` 逐项核实引用，确认除定义自身与 `docs/` 记述外无代码引用。
- [x] 删除 api knowledge 的 MCP 常量、FAQ schema 别名与两个归一化辅助函数，并清理仅其使用的 shared import。
- [x] 删除 db knowledge repo 的三个无调用方函数与零引用行类型；确认 `and`/`sql`/`knowledgeDocumentSourceRanges` 仍被其它实现使用，保留。
- [x] 删除 shared 的 `openUiToolsCacheKey`、`redactQuestion` 别名与 10 个零引用类型别名（shared 侧）；db 侧另删 `KnowledgeDocumentSourceRangeRow`，合计 11 个类型别名。
- [x] 删除 web 的 `groupState` 与测试 fixture 的 `meQueryStub`；确认 `allAccessMe`、`PERMISSIONS`、`groupLeafIds` 等仍被使用。
- [x] 运行 `git diff --check` 与 `git diff --stat`，确认仅删除、无空白错误。

## 改动文件

- `packages/api/src/features/knowledge/mcp.ts`
- `packages/api/src/features/knowledge/faq.ts`
- `packages/db/src/repo/knowledge.ts`
- `packages/shared/src/chat.ts`
- `packages/shared/src/knowledge.ts`
- `packages/shared/src/openui/index.ts`
- `packages/shared/src/personal.ts`
- `packages/shared/src/redact.ts`
- `packages/shared/src/runtime-environment.ts`
- `packages/web/src/lib/access.ts`
- `packages/web/test/me-fixture.ts`

## 下一步

无（验证与独立 Opus 终审已完成，按循环授权提交 PR 并合并）。

## 验证

真实结果（2026-11-01，worktree 内）：

- `pnpm typecheck`：全仓 7 包全部 Done，退出 0。
- `pnpm build`：全仓构建成功，仅保留既有的 >500 kB chunk 警告。
- `pnpm test:web`：148 文件、1841 项全部通过。
- `pnpm test`：5232 项通过、16 项跳过、0 项失败；1 个文件套件级失败为本地 `agentport/sandbox:dev` 镜像缺 GNU bash（16 项全部跳过），属既存环境问题，与本次删除无关。
- 基础设施：主 checkout `docker compose up -d postgres redis` 启动，worktree 复制主 checkout `.env` 后后端套件可运行。
- 独立 Opus 终审：源码审查通过；指出本记录中「8 个类型别名」应为 10 个、验证仍写待执行，均已修正后复核。
- `git diff --check` 通过；`git diff --stat` 为 11 个文件、119 行删除、0 行新增。
