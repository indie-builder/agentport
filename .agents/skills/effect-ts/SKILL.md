---
name: effect-ts
description: Use this skill when setting up a repository that uses the Effect Typescript library.
---

> **Project convention（适用于本文件及关联引用）：** 本项目已锁定 `effect@4.0.6`，`packages/api`、`packages/core`、`packages/worker` 已有依赖，跳过上游 Step 1：不执行 `pnpm add effect@latest`，也不把 effect 加到根开发依赖。写 Effect 代码前完整读取当前 worktree 的 `packages/core/node_modules/effect/AGENTS.md`（根 `node_modules/effect` 不存在），需要更多 API 或概念时再查 `packages/core/node_modules/effect/src`。Effect 只负责一个任务内部的副作用：取消、超时、资源释放、并发与类型化错误；共用 Promise 边界与错误分类走 `packages/core/src/effect-runtime.ts`（`runProgram`、`RunFailure`）。Fastify 管 HTTP 请求，BullMQ 管任务分发与重试，SessionSandboxes 管沙盒生命周期，Claude Agent SDK 是唯一 AI 运行底座。不新增 Effect 服务层适配器、第二套编排或额外依赖，版本以 lock 为准。

# Step 1: Install effect

Use the users preferred package manager:

```
pnpm add effect@latest
```

If in a monorepo, install it as a dev dependency at the root, so you can access
the source code from `node_modules/effect/src`.

```
pnpm add -D effect@latest
```

# Step 2: Update AGENTS.md / CLAUDE.md

Ensure that the agent instructions contain the following:

```md
# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.
```
