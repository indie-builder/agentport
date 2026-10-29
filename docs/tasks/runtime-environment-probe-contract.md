# 运行环境试连身份契约（servers / API）

> 本文件由 servers 试连执行者维护。表结构与 shared 类型以 [runtime-environment-contract.md](runtime-environment-contract.md)
> 为准，产品决定见 [runtime-environment-config.md](runtime-environment-config.md)。
> 不新增测试历史表，也不重造试连结果对象。

## 1. 目标与不变量

- stdio 试连结果必须带**本次实际使用的环境身份**；http/generated 在平台侧直连，没有环境身份。
- 一次成功只对实际执行它的环境成立：换环境重测、在拿到新结果前，不能沿用旧环境的成功。
- 身份随现有 last-test 记录持久化，刷新页面后仍能读到；不记录历史。

## 2. servers 的 jsonb 字段

```ts
// servers 表
/** 最近一次测试实际使用的环境身份；null = 从未测试 / 非 stdio / 环境解析前就失败。 */
lastTestRuntimeEnvironment: jsonb('last_test_runtime_environment')
  .$type<ResolvedRuntimeEnvironment | null>(),
```

- 可空，类型 `ResolvedRuntimeEnvironment | null`：整份身份快照，不参与查询、不建外键、不拆成 4 列。
- 正式列由迁移 `0041_careful_pretty_boy.sql` 增加，不是临时写进 `servers.config` 的兼容路径。
- `null` 是确定语义，不是旧数据兼容分支。
- 写入在 `packages/db/src/repo/servers.ts` 的 `recordTestResult`，读取在
  `packages/api/src/features/servers/repo.ts` 的 `toApiServer`，直接使用 typed 列，不再二次 safeParse。

## 3. 数据流

1. `POST /api/servers/:id/test`（stdio）body 可带 `runtimeEnvironmentId`，缺省/null = 平台默认环境。
2. worker 返回的 `runtimeEnvironment`（`ResolvedRuntimeEnvironment`）原样进响应，
   同时交给 `repo.recordTestResult(..., result.runtimeEnvironment ?? null)`；失败结果也记录身份。
3. db repo 用**单条 UPDATE** 写入 last-test 四列（含身份）：不与并发 PATCH 的读改写互相覆盖，
   且测试结果不推进 `updatedAt`，不触发乐观锁冲突。
4. `toApiServer` 输出 `lastTestRuntimeEnvironment`；shared `serverSchema` 增加字段
   `lastTestRuntimeEnvironment: resolvedRuntimeEnvironmentSchema.nullable().optional()`，历史行自然读成 `null`。

## 4. 行为测试（`packages/api/test/sandbox-probe.test.ts`）

用真实 BullMQ + 假 consumer，覆盖：

- 环境 A 成功 → `GET /api/servers/:id` 读回 A 且 `lastTestOk: true`。
- 环境 B 失败 → 读回 B 且 `lastTestOk: false`，不能仍显示 A 的成功。
- 再测 A 成功 → 读回 A。
- 结果不带环境身份 → 读回 `null`。

## 5. Web 映射（已完成）

- `packages/web/src/lib/api.ts` 的 `importAgent(file, signal, runtimeEnvironmentId?)` 已增加可选环境参数，
  透传到 `POST /api/import/agents?runtimeEnvironmentId=...`；专家页导入对话框可选环境。
- 运行环境详情页提供删除；默认环境、仍被智能体绑定或存在 `queued/building` 版本时 API 返回 409。
- 未选环境时按 sidecar 中的环境名称映射同名环境，导入不执行构建。

## 6. 现状

- 环境身份走 `servers.last_test_runtime_environment` typed jsonb 列，写入与读回都直接使用列值，
  不再读写 `servers.config`、不再对内部确定类型重复 safeParse。
- shared 字段、API 写入/读回与行为测试已完成。
