# 运行环境构建测试不稳定（buildx spawn 等待）

## 目标

修复 `packages/worker/test/runtime-environment-build.test.ts` 中「日志落库同步抛错后，后续输出仍会落库」的偶发失败：`buildIndex` 在 20 次 `setImmediate` 后仍为 -1。只修测试等待方式，不改生产源码；保留 fake timers 的两次 drain 与 `late-step` 核心断言。

## 方案

失败不是产品缺陷，而是测试把「固定事件循环轮数」当成「buildx 已 spawn」的就绪信号：

- handler → `executeRuntimeEnvironmentBuild`：`image inspect`、`tag` 由注入的 fake spawn 在微任务内完成；随后 `await mkdtemp`、`await writeFile` 是**真实 fs**（libuv 线程池），完成后才 spawn buildx。
- 20 次立即执行的 `setImmediate` 只推进事件循环轮次、不保证真实时间；全量并行时线程池被其它测试占用，很容易在这些异步 fs 回调前用完 20 轮。

修法：复用已有的 `spawn` 依赖注入，让 `fakeDocker` 在 buildx 的回复就绪（含 `--iidfile` 写入）时 resolve 一个 `buildxStarted` Promise；两处等待改为 `await` 该信号。并用 `Promise.race` 让「handler 在 spawn 前就结束」直接失败，而不是永远等待。第一个用例补上关闭 holdOpen 子进程并 `await handler` 收尾，避免持有挂起的执行链；断言仍放在关闭之前，回归时先命中 `late-step` 断言而不是挂住。

## 基线与范围

- 起点：`e060e3a559633a0d94adb637516a6d577b86b1aa`（worktree `codebase-review-loop`）。
- 开工时本文件无未提交差异；其它文件的既有差异归属其它任务，不触碰。
- 允许改动：`packages/worker/test/runtime-environment-build.test.ts`、本记录。不改生产源码/配置。

## 当前有效决定

- 只改测试的等待信号，不扩大轮数、不提高测试 timeout、不给生产代码加测试专用出口。
- fake 范围内无 Docker：`docker` 命令全部由注入的 fake spawn 回复，真实 fs 只用于临时目录与 iid 文件。

## 已替代项及原因

- 「把 20 轮改成更多轮」或「提高 testTimeout」：仍以事件循环轮数/时间猜就绪，线程池拥塞时继续偶发，且掩盖真实因果。
- 「第一个用例完全不 await handler」：旧注释是为规避修复前的 flush 死循环；现在 flush 能结束，收尾后不留挂起链。

## 步骤

- [x] 读生产链路，确认 buildx spawn 前的真实 fs 步骤。
- [x] `fakeDocker` 暴露 `buildxStarted`，删除不再被引用的 `children`。
- [x] 两个使用 holdOpen 的用例改为 `await` spawn 信号，并加「handler 提前结束即失败」的保护。
- [x] 第一个用例关闭子进程并 `await handler`。
- [x] 跑完整文件测试与 biome/diff 检查。

## 改动文件

- `packages/worker/test/runtime-environment-build.test.ts`
- `docs/tasks/codebase-review-build-test.md`

## 下一步

无（待 Opus review）。

## 验证

- 旧失败证据：主会话本轮全量 backend 运行中，本文件唯一失败为「日志落库同步抛错后，后续输出仍会落库」，断在 `expect(buildIndex).toBeGreaterThanOrEqual(0)`（buildIndex = -1，20 轮 `setImmediate` 后仍未 spawn）。
- 修复后完整文件（`pnpm exec vitest run --project backend packages/worker/test/runtime-environment-build.test.ts`）：连续 4 次均 `Test Files 1 passed (1)` / `Tests 15 passed (15)`（其中两次并发运行，用于加压），单次约 1.5s。
- `pnpm exec biome check packages/worker/test/runtime-environment-build.test.ts`：仅剩改动前就存在的 `noTemplateCurlyInString` 警告（第 20 行 Dockerfile 字符串），无 error。
- `/usr/bin/git diff --check`：无空白问题。
- 范围说明：真实 Docker 未参与；docker 命令全部由注入的 fake spawn 回复，真实异步只剩 `mkdtemp`/`writeFile`/`readFile` 的临时文件操作。
