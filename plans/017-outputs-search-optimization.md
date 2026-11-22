# Plan 017: 消除产出扫描中重复的路径校验

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. If a "STOP conditions" item occurs, stop and report — do not improvise.
>
> **Drift check (run first)**: `git diff --stat 83151cbd..HEAD -- packages/core/src/outputs.ts packages/core/src/path-segments.ts`. If either file changed, compare the excerpts below against live code; mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED（触碰产出路径信任边界）
- **Depends on**: 012 的测量结论（已合并）
- **Category**: performance
- **Planned at**: commit `83151cbd`, 2026-11-22

## Why this matters

012 实测：默认规模（50 会话 × 20 run × 50 文件）整轮 `listOutputFiles` p95 = 466.6ms，判定 `optimize`。归因显示瓶颈不是 `readdir`、JSON 解析或 zod，而是每个 manifest 重复的路径校验系统调用：`loadManifest` 自己调一次 `trustedPath`，随后 `readRegularFile` 又调一次；每次 `trustedPath` 都对根做 `realpath`，并对 6 段路径逐段 `lstat` + `realpath`。单个 manifest 约 28 次系统调用。

本计划不改变任何校验语义：每个 manifest 仍逐段 `lstat` + `realpath` 校验完整 6 段，路径段实现保持原样；只消除重复劳动——根 `realpath` 每次 `publishedVersions` 调用只做一次，`loadManifest` 不再对自己刚校验过的路径调用第二次 `trustedPath` 与 `lstat`。目标：同一测量口径整轮 p95 降到 200ms 以下。

## Current state

`packages/core/src/outputs.ts:121-136`：

```ts
async function trustedPath(
  identity: ConversationIdentity,
  segments: string[],
  label: string,
): Promise<string> {
  const logicalRoot = resolve(identity.root);
  const physicalRoot = await realpath(logicalRoot).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT'))
      return fail('NOT_FOUND', '产出根目录不存在', { path: `/${label}` });
    throw error;
  });
  if ((await pathSegmentsProblem(physicalRoot, segments)) !== null) {
    fail('INVALID_INPUT', '产出路径不能经过符号链接', { path: `/${label}` });
  }
  return join(logicalRoot, ...segments);
}
```

`packages/core/src/outputs.ts:165-191`（`loadManifest`）先 `trustedPath`，再用 `lstat` 判存在，最后 `readRegularFile`；`packages/core/src/outputs.ts:232-238`（`readRegularFile`）又对同一路径调一次 `trustedPath`，再 `lstat` 一次。

`packages/core/src/outputs.ts:193-216`（`publishedVersions`）先对 `[slug, conversation-outputs, conversationId, runs]` 调 `trustedPath`，再对每个 run 目录调 `loadManifest`，导致固定前缀每 manifest 重新校验。

`packages/core/src/path-segments.ts`：

```ts
export async function pathSegmentsProblem(
  physicalRoot: string,
  segments: readonly string[],
): Promise<'link' | 'outside' | null> {
  let physical = physicalRoot;
  for (const segment of segments) {
    physical = join(physical, segment);
    const info = await lstat(physical).catch((error: unknown) => {
      if (hasErrorCode(error, 'ENOENT')) return null;
      throw error;
    });
    if (info === null) break;
    if (info.isSymbolicLink()) return 'link';
    const actual = await realpath(physical);
    if (actual !== physicalRoot && !actual.startsWith(`${physicalRoot}${sep}`)) return 'outside';
  }
  return null;
}
```

`attachments.ts:206` 是另一个调用方；它只判 `problem !== null`，不依赖 `'outside'`。

既有安全回归：`packages/core/test/outputs.test.ts`（符号链接 manifest、硬链接 manifest、目录逃逸等）与 `packages/core/test/attachments.test.ts`（input 目录符号链接逃逸）。这些测试必须原样通过，作为本次边界的证据。

仓库约定：

- 不写代码注释、不新增单测/集成测试（根 `AGENTS.md`）。
- core 的路径校验必须保留（`packages/core/AGENTS.md`「文件安全」）。

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install --frozen-lockfile` | exit 0 |
| Core typecheck | `bun run --filter @agentport/core typecheck` | exit 0 |
| Outputs tests | `bun run test -- packages/core/test/outputs.test.ts` | 全绿 |
| Attachments tests | `bun run test -- packages/core/test/attachments.test.ts` | 全绿 |
| Related api suites | `bun run test -- packages/api/test/outputs-search.test.ts` | 全绿（若该文件存在；不存在则跳过并记录） |
| Biome | `bunx biome check packages/core/src/outputs.ts packages/core/src/path-segments.ts` | 0 error |
| Re-measure | 按 Step 4 的临时脚本 | 整轮 p95 < 200ms 或较 466.6ms 至少下降 50% |

## Scope

**In scope**:
- `packages/core/src/outputs.ts`
- `plans/README.md`（状态行）

**Out of scope**:
- `path-segments.ts` 与 `attachments.ts` 的校验策略：保持逐段 `lstat` + `realpath` 原样。
- manifest 语义、分页、游标、输出目录结构。
- 任何缓存跨请求留存（禁止进程级缓存；校验上下文只在单次调用内生效）。
- API/worker 调用方。

## Git workflow

- 在 `.claude/worktrees/outputs-path-scan` 内工作，分支 `worktree-outputs-path-scan`。
- 提交信息：`perf(core): 消除产出扫描中重复的路径校验`。
- 不推送、不开 PR，除非操作者明确要求。

## Steps

### Step 1: `path-segments.ts` 保持不动

该文件当前实现就是目标语义：逐段 `lstat`、拒绝符号链接、`realpath` 越界判定。任何「去掉逐段 `realpath`」或「跳过已校验前缀」的改法都会丢失扫描期间目录被替换的检测，明确不做。

**Verify**: `git diff -- packages/core/src/path-segments.ts` → 无输出。

### Step 2: 根 `realpath` 在单次调用内复用

抽出 `rootPhysicalPath(identity, label)`（错误映射与原 `trustedPath` 相同），`trustedPath` 增加可选 `physicalRoot` 参数：传入时跳过 `realpath`，否则照旧自己算。

`publishedVersions` 先算一次 `physicalRoot`，同时传给 `runsDir` 的 `trustedPath` 与每个 `loadManifest`。`loadManifest` 仍用完整 6 段调用 `pathSegmentsProblem`，不跳过任何前缀。

**Verify**: `bun run --filter @agentport/core typecheck` exit 0；outputs/attachments 套件全绿。

### Step 3: `loadManifest` 复用已取得的 `lstat` 结果

`loadManifest` 的 `lstat(full)` 已拿到 `Stats`。用它完成符号链接、普通文件、`nlink === 1` 检查后直接 `readFile`，不再调用 `readRegularFile`（避免第二次 `trustedPath` 与 `lstat`）。读取时把 `ENOENT` 映射为 `NOT_FOUND`、`产出文件不存在`、`/manifest.json`，其他错误原样抛出。`readRegularFile` 保持原样，供 `readOutputFile` 等外部读取继续使用。

校验顺序必须保持：路径校验 → `lstat` → 非符号链接/普通文件/`nlink === 1` → 读取。任一不满足仍按原错误码与 `path` 报错。

**Verify**: outputs 套件全绿，特别是合并前已有的符号链接 / 硬链接 manifest 拒绝用例；`rg -n 'readRegularFile' packages/core/src/outputs.ts` → 仍有定义与除 `loadManifest` 外的调用。

### Step 4: 复测

在 `tmp/` 写一次性脚本重建 012 的测量（不提交）：生成 50 会话 × 20 run × 每 run 50 文件的合成 manifest（schema 与 `outputManifestSchema` 一致），连续 3 轮对 50 个会话并发调用 `listOutputFiles({ limit: 100 })`，丢弃第 1 轮，记录整轮 p50/p95；脚本结束删除临时目录。

**Verify**: 输出的整轮 p95 < 200ms，或至少 ≤ 233ms（较 466.6ms 下降 ≥ 50%）。若未达到，报告实际数字，不修改目标掩盖。

### Step 5: 收尾验证

```bash
bun run --filter @agentport/core typecheck
bun run test -- packages/core/test/outputs.test.ts packages/core/test/attachments.test.ts
bunx biome check packages/core/src/outputs.ts packages/core/src/path-segments.ts
```

全部 exit 0。更新 `plans/README.md`（若操作者要求）。

## Test plan

- 不新增测试（根 `AGENTS.md`）。
- 既有 `outputs.test.ts` 与 `attachments.test.ts` 是安全边界回归：符号链接中间目录、符号链接 manifest、硬链接 manifest、目录逃逸都必须继续被拒绝。
- 性能以 Step 4 的临时脚本实测为准，不以推测替代。

## Done criteria

- [ ] `path-segments.ts` 与 `attachments.ts` 零 diff，逐段 `lstat` + `realpath` 语义不变
- [ ] `physicalRoot` 只在单次 `publishedVersions` 调用内复用，无跨请求缓存
- [ ] 每个 manifest 仍校验完整 6 段路径，不跳过前缀
- [ ] `loadManifest` 不再二次调用 `trustedPath`，`ENOENT` 映射为 `/manifest.json` 的 `NOT_FOUND`
- [ ] core typecheck exit 0
- [ ] outputs 与 attachments 套件全绿（含所有符号链接/硬链接拒绝用例）
- [ ] biome 0 error
- [ ] 复测整轮 p95 < 200ms 或降幅 ≥ 50%

## Measurement results

- 日期：2026-11-22
- 环境：Apple M2 Max（arm64，macOS 27.0.0），仓库 `tmp/` 内一次性脚本，测后删除
- 规模：50 会话 × 20 run × 每 run 50 文件（1000 manifest），50 路并发 `listOutputFiles({ limit: 100 })`，3 轮丢弃首轮
- 同机优化前基线：整轮 p50 / p95 = 167.5 / 169.1 ms
- 优化后：整轮 p50 / p95 = 89.6 / 94.8 ms（后两轮 87.4/89.7 与 93.1/95.1）
- 降幅：p95 −44%，绝对值 94.8 ms < 200 ms，达标
- 说明：012 记录的 466.6 ms 属另一环境；本次以同机前后对照为准

## STOP conditions

Stop and report if:

- `pathSegmentsProblem` 的 `'outside'` 分支存在当前测试依赖的用例（用 `rg` 搜索后确认有测试断言该错误），说明不能直接删除，先报告。
- 任一符号链接/硬链接拒绝用例开始通过（安全回归）。
- 需要修改 `outputs.test.ts` 或 `attachments.test.ts` 的断言才能通过。
- 性能复测未达标且原因不在路径校验（例如解析或 JSON 成为新瓶颈），先报告测量拆解。
