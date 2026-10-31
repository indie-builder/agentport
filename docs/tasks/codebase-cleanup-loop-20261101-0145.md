# 限额常量去重：记忆文件 200000 字节与知识库图片 5 MiB（2026-11-01）

## 目标

消除同一限额在多个包各写一份的重复，统一到 `@agentport/shared`：

1. 记忆文件 200000 字节上限：api 本地 `MAX_MEMORY_BYTES` 与 shared 已有的 `MEMORY_FILE_MAX_BYTES` 重复。
2. 知识库图片 5 MiB 上限：api 与 worker 各写一份 `5 * 1024 * 1024`，下沉为 shared 的 `KNOWLEDGE_IMAGE_MAX_BYTES`。

验收标准：

- 两处限额都只保留 shared 唯一定义，使用点全部引用共享常量，不保留转发别名。
- 行为、错误码、错误文案、校验顺序、视觉与迁移均不变；错误文案仍为「记忆文件不能超过 200000 字节」与「图片超过 5MiB…」。
- `git diff --check` 通过。

## 方案

- `packages/api/src/features/agents/memory-files.ts`：删除本地 `MAX_MEMORY_BYTES`，从 `@agentport/shared` 引入 `MEMORY_FILE_MAX_BYTES`，三处比较与一处 `Buffer.alloc` 改为共享常量。
- `packages/shared/src/knowledge.ts`：新增 `KNOWLEDGE_IMAGE_MAX_BYTES = 5 * 1024 * 1024`，保留原注释语义。
- `packages/api/src/features/knowledge/read-image.ts` 与 `packages/worker/src/knowledge/image-processing.ts`：删除各自本地定义，改为引用共享常量。
- `packages/worker/test/knowledge-image-processing.test.ts`：`IMAGE_LIMIT_BYTES` 的唯一外部 importer，改为从 `@agentport/shared` 引入新常量。
- 不新增抽象、不改错误处理与校验顺序。

## 基线与范围

- 起点：`origin/main` 66e61cb。
- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-cleanup-loop-20261101-0145`，分支 `worktree-codebase-cleanup-loop-20261101-0145`。
- 初始未提交差异：无（`git status` 干净）。
- 允许改动：上述常量定义、使用点、测试 import 与本任务记录。
- 不改动：主 checkout、行为/错误码/文案、视觉、迁移与其它文档。

## 当前有效决定

- 范围只做常量统一与必要的 import 调整；实施代理不 commit/push、不运行测试，验证由主会话执行。
- 交付按循环的持续授权：终审通过后由主会话 commit/push/PR/merge。
- 记忆文件错误文案保持字面量 `200000`，不改成模板插值，避免文案变化。

## 已替代项及原因

无。

## 步骤

- [x] `rg` 确认 `MAX_MEMORY_BYTES` 仅存在于 `memory-files.ts`，shared 已有 `MEMORY_FILE_MAX_BYTES`。
- [x] `rg` 确认 `IMAGE_LIMIT_BYTES` 的外部 importer 只有 `packages/worker/test/knowledge-image-processing.test.ts`，其余为 worker 自身使用。
- [x] 在 shared 知识库契约新增 `KNOWLEDGE_IMAGE_MAX_BYTES`。
- [x] 替换 api 记忆文件与 api/worker 图片限额的使用点，删除本地定义。
- [x] 更新 worker 测试 import 与使用点。
- [x] 运行 `git diff --check`、`biome check`（改动文件）与 `rg` 复核，确认无残留定义、无格式/空白问题。

## 改动文件

- `packages/shared/src/knowledge.ts`
- `packages/api/src/features/agents/memory-files.ts`
- `packages/api/src/features/knowledge/read-image.ts`
- `packages/worker/src/knowledge/image-processing.ts`
- `packages/worker/test/knowledge-image-processing.test.ts`
- `docs/tasks/codebase-cleanup-loop-20261101-0145.md`

## 下一步

- 无（验证与独立 Opus 终审已完成，按循环授权提交 PR 并合并）。

## 验证

真实结果（2026-11-01，worktree 内）：

- `pnpm typecheck`：全仓 7 包全部 Done，退出 0。
- `pnpm build`：全仓构建成功，仅保留既有 >500 kB chunk 警告。
- `pnpm test:web`：148 文件、1841 项全部通过。
- `pnpm test`：5232 项通过、16 项跳过、0 项失败；1 个文件套件级失败为本地 `agentport/sandbox:dev` 镜像缺 GNU bash（16 项全部跳过），属既存环境问题，与本次改动无关。
- `biome check` 五个改动文件退出 0；`git diff --check` 通过。
- 独立 Opus 终审：数值（200000 字节 / 5242880 字节）、错误码、文案、校验顺序逐字未变；指出 `image-processing.ts` 的类型转发已无消费者、任务记录验证状态未同步，均已修正后复核。
