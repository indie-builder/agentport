# Plan 005: 上限化 worker 对沙盒可控数据的读取

> **Executor instructions**: 严格按步骤执行；每步先跑验证命令并确认预期结果，再进入下一步。遇到「STOP conditions」立即停止并报告，不要自行发挥。完成后更新 `plans/README.md` 中本计划的 Status 行（除非派发者声明由他维护索引）。
>
> **Drift check（先跑）**: `git diff --stat 90a0ad2c..HEAD -- packages/shared/src/knowledge.ts packages/worker/src/knowledge/image-processing.ts packages/core/src/outputs.ts packages/worker/src/runs/fork-uuids.ts packages/worker/src/runs/execute.ts`
> 若有文件变化，先对照本文件「Current state」的摘录；对不上按 STOP 处理。

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED（合法的超大产出/长转写可能触到新上限）
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `90a0ad2c`, 2026-11-22

## Why this matters

沙盒内的代码（专家、插件、stdio MCP）可以写 `outputs/` 与会话目录；worker 在这些目录之外、不受沙盒内存限制地读取它们。当前三处读取都没有上限：图片按最多 268,402,689 像素整幅解码（约 1 GiB RGBA）、产出草稿把整棵目录读进内存、fork 转写文件不限大小与文件类型。任意一次 run 或一次知识导入就能把共享 worker 打爆，连带中断其他 run 与队列任务。本计划在三个读取点加明确预算，并在超限时给出清晰错误，让失败只落在当前任务。

## Current state

- `packages/shared/src/knowledge.ts:40` — 图片入口上限，已存在：
  ```ts
  export const KNOWLEDGE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
  ```
- `packages/worker/src/knowledge/image-processing.ts:30-50` — 校验即整幅解码，像素上限是 sharp 默认值：
  ```ts
  export async function assertUsableImage(input: {
    mimeType: string;
    data: Uint8Array;
  }): Promise<void> {
    if (!SDK_IMAGE_MIME.has(input.mimeType)) throw new Error(`不支持的图片 MIME: ${input.mimeType}`);
    if (input.data.length > KNOWLEDGE_IMAGE_MAX_BYTES)
      throw new Error('图片超过 5MiB，不能供视觉模型直接读取');
    try {
      // raw() 才会真正解码像素；metadata() 只读文件头，截断图能蒙混过关。
      await sharp(input.data, { limitInputPixels: 268402689 }).raw().toBuffer();
    } catch (err) { /* ... */ }
    // 之后还有 PNG IEND 尾部校验
  }
  ```
- `packages/core/src/outputs.ts:214-249` — 草稿捕获逐文件整读，无预算：
  ```ts
  async function readRegularFile(identity, full, path): Promise<Buffer> {
    await trustedPath(...);
    const info = await lstat(full).catch(...);
    if (info.isSymbolicLink() || !info.isFile()) fail('INVALID_INPUT', '产出文件不是普通文件', ...);
    if (info.nlink !== 1) fail('INVALID_INPUT', '产出文件不允许硬链接', ...);
    return readFile(full);
  }

  async function draftEntries(identity, dir, prefix = ''): Promise<Array<{ path: string; data: Buffer }>> {
    // readdir 后对每个文件调用 readRegularFile；目录递归，无深度/数量/总字节限制
  }
  ```
  `captureOutputDraft()`（同文件 `:403-462`）调用 `draftEntries`，先写 staging 目录再原子改名；失败时保留上一版快照。
- `packages/worker/src/runs/execute.ts:930` — 停稳后调用 `captureOutputDraft`；失败被 catch 成 `outputSettlementError`，run 仍继续收尾。
- `packages/worker/src/runs/fork-uuids.ts:6-47` — 打开 `sessionsRoot/projects/*/<sessionId>.jsonl`，无 lstat、无大小上限：
  ```ts
  const file = await findSessionFile(sessionsRoot, newSessionId);
  if (file === null) return [];
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  ```
  `sessionsRoot` 对应沙盒里 rw 挂载的 `CONFIG_CONTAINER_DIR`（见 `packages/worker/src/sandbox/sessions.ts` 的 `mountsFor`）。

仓库约定：
- 可恢复错误统一用 `@agentport/core` 的 `fail()` / `AppError`；core 的 `outputs.ts` 已这样用。
- 常量放使用方：只被 worker 知识链使用的放 `packages/shared/src/knowledge.ts`；只被 core 产出捕获使用的放 `packages/core/src/outputs.ts` 顶部。
- 不新增依赖；`sharp` 已在 worker 依赖中。

## Commands you will need

| 用途 | 命令 | 成功判据 |
|---|---|---|
| 安装 | `bun install --frozen-lockfile` | exit 0 |
| 单包类型检查 | `bun run --filter @agentport/core typecheck` / `--filter @agentport/worker typecheck` / `--filter @agentport/shared typecheck` | exit 0 |
| 现有单测 | `bun run test -- packages/core/test/outputs.test.ts`、`bun run test -- packages/worker/test/knowledge-image-processing.test.ts`、`bun run test -- packages/worker/test/fork-uuids.test.ts` | 全绿 |
| 格式/规范 | `bunx biome check packages/core/src/outputs.ts packages/worker/src/knowledge/image-processing.ts packages/worker/src/runs/fork-uuids.ts packages/shared/src/knowledge.ts` | 0 error |

> 后端测试需要 Docker PostgreSQL/Redis；按 `docs/OPERATIONS.md` 的隔离说明运行。Docker 不可用时该套件会跳过，跳过不算通过，需在报告中注明。

## Scope

**In scope**
- `packages/shared/src/knowledge.ts`
- `packages/worker/src/knowledge/image-processing.ts`
- `packages/core/src/outputs.ts`
- `packages/worker/src/runs/fork-uuids.ts`
- 必要时同步 `docs/ARCHITECTURE.md` 中产出/图片限制的说明（仅事实句，不新增章节）

**Out of scope（不要动）**
- `packages/worker/src/runs/execute.ts` 的收尾流程与错误分类。
- 沙盒挂载策略、`SANDBOX_EGRESS`、容器内存限制。
- “知识库未启用图片处理时不解码”这条策略下沉（本计划只加预算；见 Maintenance notes）。
- 已发布产出的下载大小限制（`readOutputFile` 行为不变）。

## Git workflow

- 分支/worktree：按 `docs/DEV-WORKFLOW.md` §2 建独立 worktree；分支名 `improve/005-bound-worker-reads`。
- 提交信息用中文 conventional commits，参考最近提交风格，例如：
  `fix(worker): 限制产出捕获、图片解码与 fork 转写的读取上限`
- 不 push、不开 PR，除非派发者明确要求。

## Steps

### Step 1: 图片解码加像素预算

1. 在 `packages/shared/src/knowledge.ts` 的 `KNOWLEDGE_IMAGE_MAX_BYTES` 旁新增：
   ```ts
   export const KNOWLEDGE_IMAGE_MAX_PIXELS = 25_000_000;
   ```
   注释一句话说明：视觉模型会缩放输入，25 MP 足够覆盖文档扫描；该值限制解码内存。
2. 改 `assertUsableImage`：
   - 字节检查保留。
   - 先 `const meta = await sharp(input.data).metadata();`（`metadata()` 只读文件头，不整幅解码；**不要**在这一步传 `limitInputPixels`，否则超大图会以通用解码错误提前失败，拿不到预算错误）。
   - 计算总像素：`const frames = meta.pages ?? 1; const frameHeight = meta.pageHeight ?? meta.height ?? 0; const totalPixels = (meta.width ?? 0) * frameHeight * frames;`
   - 若 `totalPixels === 0 || totalPixels > KNOWLEDGE_IMAGE_MAX_PIXELS`，抛出 `new Error('图片像素超过上限，不能供视觉模型直接读取')`。
   - 再执行原有的 `.raw().toBuffer()` 解码（保留 `limitInputPixels: KNOWLEDGE_IMAGE_MAX_PIXELS`，保留 PNG IEND 尾部校验）。即：header 预算拒绝在前，真实解码只发生在预算内。
3. 预期效果：动画/多帧图片按“帧数 × 单帧像素”计预算，不按单帧。

**Verify**: `bun run --filter @agentport/shared typecheck && bun run --filter @agentport/worker typecheck` → exit 0；`bun run test -- packages/worker/test/knowledge-image-processing.test.ts` → 全绿（现有小图用例不受影响）。

### Step 2: 产出捕获加文件数/单文件/总字节/深度预算

在 `packages/core/src/outputs.ts` 顶部（常量区）新增：
```ts
const CAPTURE_MAX_FILES = 2_000;
const CAPTURE_MAX_FILE_BYTES = 32 * 1024 * 1024;
const CAPTURE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const CAPTURE_MAX_DEPTH = 16;
```

1. `readRegularFile` 增加可选参数 `maxBytes?: number`；在 `lstat` 之后、`readFile` 之前：
   ```ts
   if (maxBytes !== undefined && info.size > maxBytes)
     fail('INVALID_INPUT', '产出文件超过单文件上限', { path: `/${path}` });
   ```
   调用方不传时行为不变（`copySnapshot`、`readOutputFile` 等保持原样）。
2. `draftEntries` 增加一个贯穿递归的预算对象，例如：
   ```ts
   type CaptureBudget = { files: number; bytes: number };
   ```
   - 目录递归前检查 `depth > CAPTURE_MAX_DEPTH` → `fail('INVALID_INPUT', '产出目录层级过深', { path: ... })`。
   - 每个文件：`budget.files += 1`；超过 `CAPTURE_MAX_FILES` → fail。
   - 读取时传 `CAPTURE_MAX_FILE_BYTES`；读到后 `budget.bytes += data.length`，超过 `CAPTURE_MAX_TOTAL_BYTES` → fail。
   - 错误信息带上触发路径，便于用户定位。
3. 保持 staging + 原子改名不变：超限时 `captureOutputDraft` 抛错，上一版快照不被覆盖。

**Verify**: `bun run --filter @agentport/core typecheck` → exit 0；`bun run test -- packages/core/test/outputs.test.ts` → 全绿。

**Evidence（必做，写入交付说明）**: 在 `/tmp` 写一次性脚本（不要入库），用 `mkdtemp` 造两个目录并调用 `captureOutputDraft`：
- 2 001 个 1 字节文件 → 预期抛 `INVALID_INPUT`，消息含「文件数」。
- 1 个 33 MiB 文件 → 预期抛 `INVALID_INPUT`，消息含「单文件上限」。
保存脚本输出到 `/tmp/plan005-outputs.log` 并在报告中引用。

### Step 3: fork 转写读取加类型与大小校验

改 `packages/worker/src/runs/fork-uuids.ts`：
1. 顶部加：
   ```ts
   const FORK_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;
   const FORK_TRANSCRIPT_MAX_ENTRIES = 100_000;
   ```
2. `readForkUuidMap` 在拿到 `file` 后、`createReadStream` 前：
   ```ts
   const info = await lstat(file).catch(() => null);
   if (info === null || info.isSymbolicLink() || !info.isFile() || info.nlink !== 1)
     throw new Error('fork 转写文件不是普通文件');
   if (info.size > FORK_TRANSCRIPT_MAX_BYTES)
     throw new Error('fork 转写文件超过上限');
   ```
   需要 `import { lstat, readdir } from 'node:fs/promises'`。
3. 循环内每 push 一条映射就计数；超过 `FORK_TRANSCRIPT_MAX_ENTRIES` 时 `throw new Error('fork 转写映射条数超过上限')`。`file === null` 仍返回 `[]`（现有语义：缺文件不是安全事件）。
4. 不要在这里改用 `open` + `fstat` 之类的事务式读取；一次 `lstat` + 有界读取已覆盖本计划的风险，剩余 TOCTOU 记录在 Maintenance notes。

**Verify**: `bun run --filter @agentport/worker typecheck` → exit 0；`bun run test -- packages/worker/test/fork-uuids.test.ts` → 全绿。

**Evidence（必做）**: `/tmp` 脚本造三个文件并调用 `readForkUuidMap`：
- 指向任意现有文件的 symlink → 预期抛错；
- 65 MiB 普通文件 → 预期抛错；
- 正常小文件 → 预期返回映射或 `[]`，不抛错。
输出存 `/tmp/plan005-fork.log`。

### Step 4: 全量收口检查

- `bun run --filter @agentport/shared --filter @agentport/core --filter @agentport/worker typecheck` → exit 0。
- `bunx biome check <in-scope 文件>` → 0 error。
- `git status --short` → 只包含 Scope 列表中的文件（外加可能的 docs 同步与本计划状态行）。

## Test plan

本仓库默认不新增单测（根 `AGENTS.md`「测试」与全局规则）。因此本计划的回归证据是：

1. 现有三套测试保持全绿：`packages/core/test/outputs.test.ts`、`packages/worker/test/knowledge-image-processing.test.ts`、`packages/worker/test/fork-uuids.test.ts`。
2. Step 2/3 的一次性复现脚本输出（`/tmp/plan005-*.log`）贴进交付说明。
3. 若派发者明确授权新增用例，才在上述三个文件里各加 1 个拒绝用例；未授权不写。

## Done criteria

- [ ] `KNOWLEDGE_IMAGE_MAX_PIXELS` 存在且被 `assertUsableImage` 使用；`grep -n "268402689" packages/worker/src` 返回空。
- [ ] `grep -n "CAPTURE_MAX_" packages/core/src/outputs.ts` 命中 4 个常量，且 `draftEntries` 递归带预算。
- [ ] `grep -n "FORK_TRANSCRIPT_MAX" packages/worker/src/runs/fork-uuids.ts` 命中 2 个常量，且读取前有 `lstat`。
- [ ] 三个包的 typecheck 均 exit 0。
- [ ] 三套现有测试全绿（0 skip；Docker 不可用时在报告注明）。
- [ ] `git status --short` 无 Scope 外文件。
- [ ] `plans/README.md` 的 005 行状态已更新。

## STOP conditions

- `packages/core/src/outputs.ts` 的 `draftEntries` / `readRegularFile` 已不再匹配「Current state」摘录。
- `sharp` 的 `metadata()` 在实际图片上返回 `width/height/pages` 缺失，无法计算预算（先报告，不要猜 default）。
- 现有测试因新增上限失败且失败用例是合法的仓库夹具（说明上限过严），不要改夹具，先报告。
- 需要修改 `execute.ts` 才能让超限错误被正确记录。
- 发现 `captureOutputDraft` 之外还有第二条产出写入路径。

## Maintenance notes

- 未来新增产出捕获入口必须复用 `draftEntries`，否则预算失效。
- 图片上限与 `KNOWLEDGE_IMAGE_MAX_BYTES` 是配套的两个边界；调整时同时看 `packages/worker/test/knowledge-image-processing.test.ts`。
- 延后项：在知识库未启用图片处理时跳过解码（当前 `parseDocument` 对图片一律先 `assertUsableImage`）。本计划只保证解码有界。
- 残余风险：`lstat` 与 `createReadStream` 之间沙盒仍可能替换文件；该窗口需要本机攻击者已在沙盒内且赢得竞态，按项目规则不在本次加事务式读取。
