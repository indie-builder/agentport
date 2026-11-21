# Plan 012: 测量产出搜索的 manifest 扫描成本，再决定是否优化

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 321cf491..HEAD -- packages/core/src/outputs.ts packages/api/src/modules/search/outputs.ts packages/worker/src/maintenance.ts`
> On any mismatch with the excerpts below, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `321cf491`, 2026-11-22

## Why this matters

全局搜索每次防抖请求都会对最近 50 个会话逐个调用 `listWorkspaceOutputs`；`publishedVersions` 会 `readdir` 每个会话的 `runs` 目录，再逐个读取、`JSON.parse`、zod 校验每个 `manifest.json`。每日维护任务还会对全部会话重复同一动作。代码形状确定，但**真实成本未测量**。本计划先做可复现的本地测量，再决定是否优化；没有测量结果就不写缓存。

## Current state

- `packages/api/src/modules/search/outputs.ts:14-34` — 取最近 50 个会话，并发调用 `listWorkspaceOutputs`。
- `packages/core/src/outputs.ts:193-215` — `publishedVersions`：`readdir(runsDir)`，逐目录 `loadManifest`（读文件 + `JSON.parse` + zod）。
- `packages/core/src/outputs.ts:694-730` — `listOutputFiles` 在内存中对全部版本分页。
- `packages/worker/src/maintenance.ts:252-268` — 维护任务列出全部会话并逐个 `outputMessageAnchors`。
- `packages/web/src/pages/search.tsx:49` — 搜索输入 200ms 防抖。

关键现有代码：

```ts
const RECENT_CONVERSATIONS = 50;
const FILES_PER_CONVERSATION = 100;

export async function collectPersonalOutputs(
  context: RequestContext,
  options: { q: string | undefined; limit: number },
): Promise<PersonalOutputList> {
  const conversations = await repo.chat.listOwnConversationsWithAgent(
    context.db,
    requireUser(context).businessId,
    RECENT_CONVERSATIONS,
  );
  const pages = await Promise.all(
    conversations.map(async (conversation) => {
      const page = await listWorkspaceOutputs(context, {
        slug: conversation.agentSlug,
        conversationId: conversation.id,
        limit: FILES_PER_CONVERSATION,
      }).catch((error: unknown) => {
        if (isAppError(error) && error.code === 'NOT_FOUND') return { items: [], nextCursor: null };
        throw error;
      });
      return { conversation, page };
    }),
  );
```

```ts
async function publishedVersions(
  identity: ConversationIdentity,
): Promise<Array<{ runId: string; manifest: OutputManifest }>> {
  const runsDir = await trustedPath(identity, [...conversationSegments(identity), RUNS], RUNS);
  const entries = await readdir(runsDir, { withFileTypes: true }).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return [];
    throw error;
  });
  const versions: Array<{ runId: string; manifest: OutputManifest }> = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) {
      fail('INVALID_INPUT', '产出路径不能经过符号链接', { path: `/${entry.name}` });
    }
    if (!entry.isDirectory()) continue;
    const manifest = await loadManifest(identity, entry.name);
    if (manifest !== null) versions.push({ runId: entry.name, manifest });
  }
  versions.sort(
    (a, b) =>
      compareText(b.manifest.createdAt, a.manifest.createdAt) || compareText(b.runId, a.runId),
  );
  return versions;
}
```

仓库约定：

- 临时脚本放仓库根 `tmp/`（该目录存在），不提交。
- 不新增测试（根 `AGENTS.md`）。
- 测量不能写入真实工作区或共享库；只使用本脚本在 `tmp/` 下创建的临时目录。

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install --frozen-lockfile` | exit 0 |
| Build core | `bun run --filter @agentport/shared --filter @agentport/core build` | exit 0 |
| Run measurement | `bun tmp/measure-outputs.ts` | prints p50/p95 and manifest counts |
| Core typecheck | `bun run --filter @agentport/core typecheck` | exit 0 |
| Format/lint (read-only) | `bunx biome check packages/core/src/outputs.ts` | 0 error |

## Scope

**In scope**:
- `tmp/measure-outputs.ts`（新建，临时脚本，不提交）
- `plans/012-outputs-search-measurement.md`（只在文件末尾追加「Measurement results」）
- `plans/README.md`（状态行）

**Out of scope**:
- `packages/core/src/outputs.ts`、`packages/api/src/modules/search/outputs.ts`、`packages/worker/src/maintenance.ts` — 本计划不改生产代码。
- 不新增索引表、迁移、缓存或依赖。
- 不写入真实 `WORKSPACES_DIR`、共享数据库或真实用户数据。

## Git workflow

- 在 `.claude/worktrees/<slug>` 内工作，分支名用 ASCII slug。
- 本计划只提交 `plans/README.md` 的状态更新与计划末尾的测量记录；`tmp/measure-outputs.ts` 不提交。
- 不推送、不开 PR，除非操作者明确要求。

## Steps

### Step 1: 构造可复现的测量脚本

在 `tmp/measure-outputs.ts` 创建脚本，要求：

1. 使用 `mkdir`/`writeFile` 在 `tmp/outputs-bench-<随机后缀>/` 下生成会话目录。规模通过环境变量配置，默认 `BENCH_CONVERSATIONS=50`、`BENCH_RUNS=20`、`BENCH_FILES=50`；同一脚本可用 `BENCH_RUNS=50 BENCH_FILES=100` 跑更大规模。manifest 字段与 `outputManifestSchema` 一致：`version`、`runId`、`createdAt`、`status`、`userMessageId`、`afterMessageId`、`files[]`，文件项含 `path`、`size`、`sha256`、`mediaType`、`changed`。
2. 对每个会话调用 `listOutputFiles({ root, slug, conversationId, limit: 100 })`，用 `performance.now()` 记录每个会话耗时。
3. 并发方式与 `collectPersonalOutputs` 相同：`Promise.all` 一次发起 50 个会话。
4. 输出：总会话数、总 manifest 数、单会话 p50/p95（毫秒）、整轮 p50/p95（毫秒）、整轮解析 manifest 总数。
5. 连续跑 3 轮，丢弃第 1 轮（冷缓存），报告后两轮。
6. 结束前删除临时目录。

脚本从 `@agentport/core` 导入 `listOutputFiles`；先执行 `bun run --filter @agentport/shared --filter @agentport/core build`，确保加载的是当前 `dist`（见 `docs/PITFALLS.md`「workspace 包导出指向 dist」）。

**Verify**: `bun tmp/measure-outputs.ts` → 打印 3 轮结果，退出 0。

### Step 2: 记录并判断

在计划文件末尾追加：

```md
## Measurement results

- 日期：
- HEAD：
- 机器/文件系统：
- 会话 × run × 文件：
- 单会话 p50 / p95：
- 整轮 p50 / p95：
- 每轮解析 manifest 数：
- 结论：<optimize | not worth doing>
```

判定规则（写进记录，不允许凭感觉）：

- 默认规模整轮 p95 ≥ 200ms：`optimize`。
- 默认规模整轮 p95 < 100ms，且放大到 `BENCH_RUNS=50 BENCH_FILES=100` 后 p95 仍 < 200ms：`not worth doing`。
- 其他情况：`needs more data`，报告两档规模数字，不写优化。

不要在判定里使用「解析 manifest 数 ≥ N」这类由夹具规模直接决定的门槛；manifest 数只作为解释 p95 的背景数据记录。

**Verify**: 计划文件出现上述小节且所有字段已填；`plans/README.md` 的 012 状态改为 `DONE`（结论 `not worth doing` / `needs more data`）或 `BLOCKED`（等待优化计划拆分）。

### Step 3: 若判定为 optimize，只写后续计划

不要在 `packages/` 下改任何文件。另建 `plans/017-outputs-search-optimization.md`，要求：

- 方案首选「按 manifest 文件 `mtimeNs + size` 缓存的**解析结果**」，缓存未命中时仍走完整 `loadManifest`（保留 zod 校验与损坏检测）；缓存命中前必须 `stat` 该文件，文件被原地改写或截断会改变 `mtimeNs` 或 `size`，从而重新解析。
- 目录项仍每次 `readdir`，符号链接检查与路径校验不跳过。
- 缓存按绝对路径与 `runId` 分键，设上限与 TTL；不改变分页与排序。
- 明确写出「缓存命中仍能发现损坏 manifest 与符号链接」的验证方式。
- 若测量显示瓶颈在 `readdir` 而不是解析，改为评估数据库索引表，而不是加内存缓存。

**Verify**: 仅当 Step 2 结论为 `optimize` 时才存在该文件；否则跳过并说明。

## Test plan

- 本计划不新增测试，不改生产代码。
- 测量脚本是唯一产物，结束后删除。
- 现有 `packages/core/test/outputs.test.ts` 不需要运行（未改代码）；若 Step 3 写了后续计划，测试要求写在该计划里。

## Done criteria

- [ ] `tmp/measure-outputs.ts` 可重复运行并打印 3 轮结果
- [ ] 计划末尾「Measurement results」所有字段已填
- [ ] 按判定规则给出明确结论
- [ ] `git status --porcelain` 不显示 `tmp/`（临时脚本未提交），只显示 `plans/README.md` 与计划文件
- [ ] 未修改任何 `packages/` 源文件

## STOP conditions

Stop and report back (do not improvise) if:

- `publishedVersions` 或 `collectPersonalOutputs` 与上面的 excerpt 不一致。
- 无法在本地运行脚本（Bun 不可用、磁盘空间不足、临时目录创建失败）。
- 脚本写入路径无法限制在 `tmp/` 内（立即停止并报告）。
- 测量结果波动过大（3 轮 p95 相差超过 3 倍），无法据此判断；报告原始数字，不写优化。

## Maintenance notes

- 本计划刻意不改生产代码：缓存会跳过 `loadManifest` 的 zod 校验与损坏检测，必须先有测量证据和「命中仍校验」的设计，才能单独实施。
- 若后续做索引表，必须处理历史工作区回填与删除/保留任务的失效。
- 测量脚本使用临时目录，不要指向真实 `WORKSPACES_DIR`。
