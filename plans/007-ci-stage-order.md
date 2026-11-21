# Plan 007: 本地 CI 先 typecheck 后 build，消除两个 `tsc -b` 并发写

> **Executor instructions**: 严格按步骤执行；每步先跑验证命令并确认预期结果，再进入下一步。遇到「STOP conditions」立即停止并报告。完成后更新 `plans/README.md` 中本计划的 Status 行（除非派发者声明由他维护索引）。
>
> **Drift check（先跑）**: `git diff --stat 90a0ad2c..HEAD -- scripts/ci.ts docs/DEV-WORKFLOW.md`
> 若有变化，先对照「Current state」；对不上按 STOP 处理。

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW（只改执行顺序）
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `90a0ad2c`, 2026-11-22

## Why this matters

本地 `bun run ci` 是唯一质量门（GitHub CI 已删除）。它现在把 `typecheck` 与 `build` 放进同一个 `Promise.all` 并行执行，而两者的每个 workspace 脚本都是 `tsc -b`，会同时写同一批 `dist/` 与 `.tsbuildinfo`。两个增量构建互相看到半写产物或陈旧 build info 时，门禁本身可能假绿或假红。改成先 typecheck、通过后再 build，重复的 `tsc -b` 会命中增量缓存，耗时增加有限。

## Current state

`scripts/ci.ts:31-40`：
```ts
const started = performance.now();
const phaseOne = await Promise.all([
  run('lint', [
    ['run', 'lint'],
    ['run', 'lint:focus'],
    ['run', 'lint:contract'],
    ['run', 'lint:docs'],
  ]),
  run('typecheck', [['run', 'typecheck']]),
  run('build', [['run', 'build']]),
]);
const results = [...phaseOne];
const built = phaseOne.find((result) => result.stage === 'build')?.status === 'PASS';
```

事实：
- 根 `package.json` 的 `typecheck` 与 `build` 都是 `bun run --filter './packages/*' <script>`。
- 每个后端包（`api`、`core`、`db`、`shared`、`contract`、`sandbox`、`worker`）的 `typecheck`/`build` 都是 `tsc -b`；`web` 的 `typecheck` 是 `tsc -b`、`build` 是 `vite build`。
- 因此 **不能删除 typecheck**（`vite build` 不做类型检查）。
- `docs/DEV-WORKFLOW.md:120` 目前写「`bun run ci` 并行跑 lint/typecheck/build」，需要与新顺序一致。

仓库约定：脚本是纯 Bun/TypeScript（`bun scripts/ci.ts`），失败阶段返回 `FAIL` 并让后续阶段按 `built` 跳过。保持现有 `Result`/`run`/`skipped` 结构。

## Commands you will need

| 用途 | 命令 | 成功判据 |
|---|---|---|
| 安装 | `bun install --frozen-lockfile` | exit 0 |
| 本地 CI | `bun run ci` | 末尾 summary 所有阶段 PASS，exit 0 |
| 格式 | `bunx biome check scripts/ci.ts` | 0 error |

## Scope

**In scope**
- `scripts/ci.ts`
- `docs/DEV-WORKFLOW.md`（只改 §5 那句门禁描述）

**Out of scope**
- `bun run ci:e2e` 的 e2e 阶段与 `release.yml`。
- 各包 `package.json` 的 `typecheck`/`build` 脚本。
- `test:web` 与 `openui:check`/`test` 的并行关系（保持现状）。

## Git workflow

- worktree + 分支 `improve/007-ci-stage-order`。
- 提交信息示例：`fix(ci): 先 typecheck 后 build，避免并发写 tsc 产物`
- 不 push、不开 PR，除非派发者明确要求。

## Steps

### Step 1: 串行化 build

把 `phaseOne` 改成：
```ts
const phaseOne = await Promise.all([
  run('lint', [
    ['run', 'lint'],
    ['run', 'lint:focus'],
    ['run', 'lint:contract'],
    ['run', 'lint:docs'],
  ]),
  run('typecheck', [['run', 'typecheck']]),
]);
const results = [...phaseOne];
const typecheckOk = phaseOne.find((result) => result.stage === 'typecheck')?.status === 'PASS';
results.push(
  ...(typecheckOk ? [await run('build', [['run', 'build']])] : skipped(['build'])),
);
const built = results.find((result) => result.stage === 'build')?.status === 'PASS';
```
后续 `openui:check`/`test`/`test:web`/`e2e` 的 `built` 判断保持不变。不要改 `run`、`skipped`、summary 输出格式。

**Verify**: `bun run lint` → exit 0（Biome 覆盖 `scripts/`）；`grep -n "run('build'" scripts/ci.ts` → 只出现在 `results.push` 的串行分支中。

### Step 2: 同步文档

把 `docs/DEV-WORKFLOW.md` §5「CI 在本地运行」那一句改成与新行为一致，例如：
> **CI 在本地运行**：`bun run ci` 先并行跑 lint 与 typecheck，typecheck 通过后跑 build；build 通过后并行跑 openui:check/test/test:web；`bun run ci:e2e` 再追加 `e2e:suite`。不使用 GitHub CI（`ci.yml` 已删除），push 与 PR 不触发远端检查。

**Verify**: `grep -n "并行跑 lint" docs/DEV-WORKFLOW.md` → 不再出现“并行跑 lint/typecheck/build”的原句。

### Step 3: 完整跑一次门禁

**Verify**: `bun run ci` → 末尾 summary 中 `lint`、`typecheck`、`build`、`openui:check`、`test`、`test:web` 全部 `PASS`，exit 0。若 `test` 存在与本改动无关的既有失败，记录阶段与首个失败用例后停止（见 STOP conditions）。

## Test plan

本计划只改编排顺序，无新增单测。验证就是完整跑一次 `bun run ci` 并保存 summary 输出。另做一次反证：临时把某个无关类型错误注入再撤销不是必须步骤；不要修改源码来制造失败。

## Done criteria

- [ ] `scripts/ci.ts` 中 `typecheck` 与 `build` 不再位于同一个 `Promise.all`。
- [ ] typecheck 失败时 `build` 显示 `SKIP`（读代码确认分支）。
- [ ] `docs/DEV-WORKFLOW.md` §5 描述与新顺序一致。
- [ ] `bun run ci` exit 0，summary 全 PASS（或记录与本改动无关的既有失败并标记 BLOCKED）。
- [ ] `git status --short` 只含两个 in-scope 文件 + `plans/README.md`。
- [ ] `plans/README.md` 的 007 行状态已更新。

## STOP conditions

- `scripts/ci.ts` 结构与「Current state」不符（例如已经串行或已删 typecheck）。
- `bun run ci` 的 `test` 阶段失败，且失败用例与本次改动无关：报告阶段、首个失败与失败数，不要顺手修测试。
- 需要修改任何包的 `package.json` 脚本才能完成。
- 发现 `bun run ci` 还并行写了别的共享产物（例如两个阶段都写同一缓存目录），报告后停止。

## Maintenance notes

- 以后新增阶段时，任何会写 `dist/`/`.tsbuildinfo` 的阶段必须排在 `build` 之后，或与 `build` 串行。
- 审查重点：`built` 的计算要基于串行后的 `results`，不能继续用 `phaseOne`。
- 若未来把 `web` 的 `build` 改成也做类型检查，可重新评估是否去掉独立 typecheck；当前不行。
