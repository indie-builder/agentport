# 运行环境共享契约（DB / shared）

> 本文件由 DB/shared 实现者独占。其他并行执行者依赖这里的类型名、字段名与方法签名；
> 不确定的字段名一律以 shared 的 `RuntimeEnvironment` / `RuntimeEnvironmentVersion` 为准。
> 产品决定见 [runtime-environment-config.md](runtime-environment-config.md)。

## 1. 表结构

### `runtime_environments`

| 列 | 类型 | 约束 |
| --- | --- | --- |
| `id` | text | PK，TypeID 前缀 `rte` |
| `name` | text | NOT NULL，唯一（`runtime_environments_name_idx`） |
| `dockerfile` | text | NOT NULL，默认 `DEFAULT_RUNTIME_DOCKERFILE`，构建时快照 |
| `is_default` | boolean | NOT NULL，默认 false；部分唯一索引保证至多一个 true |
| `online_version_id` | text | 可空；与 `id` 组成复合外键指向版本表 `(id, environment_id)` |
| `created_at` / `updated_at` | timestamptz | NOT NULL |

复合外键 `runtime_environments_online_version_fk (online_version_id, id) -> runtime_environment_versions (id, environment_id)`
保证线上版本只能属于本环境；`online_version_id` 为空时（MATCH SIMPLE）不校验。

### `runtime_environment_versions`

| 列 | 类型 | 约束 |
| --- | --- | --- |
| `id` | text | PK，TypeID 前缀 `rtev` |
| `environment_id` | text | NOT NULL，FK → `runtime_environments.id`，`ON DELETE RESTRICT` |
| `dockerfile` | text | NOT NULL，入队时冻结的完整文本 |
| `base_image_id` | text | NOT NULL，入队时冻结的基座引用（tag 或 image ID）；构建成功后改为构建实际消费的基座 image ID |
| `status` | text | NOT NULL 默认 `queued`；`queued/building/ready/failed`；CHECK |
| `image_tag` | text | 可空，构建成功后写入（仅定位，不作为身份） |
| `image_id` | text | 可空，构建成功后的镜像内容 ID（容器创建用） |
| `build_log` | text | NOT NULL 默认 `''`，构建中分批追加，超出 64 KiB 保留尾部并置 `log_truncated` |
| `log_truncated` | boolean | NOT NULL 默认 false |
| `error` | text | 可空 |
| `started_at` / `finished_at` | timestamptz | 可空 |
| `created_at` | timestamptz | NOT NULL |

唯一约束 `(id, environment_id)`（`runtime_environment_versions_id_environment_idx`）是复合外键的
引用目标。列表索引 `(environment_id, created_at, id)` 使用升序，由 PostgreSQL 反向扫描满足倒序分页。
一次构建一行，任何方法都不覆盖已有版本。

### `agents.runtime_environment_id`

可空。`null` 表示使用平台默认环境（绑定语义，不是旧数据兼容分支）；非空为明确绑定。
FK → `runtime_environments.id`，`ON DELETE RESTRICT`（环境被绑定时删除在 DB 层也会失败）。

### `servers.last_test_runtime_environment`

可空 jsonb，类型 `ResolvedRuntimeEnvironment`。记录最近一次试连实际解析到的环境版本身份
（环境 ID/名称、版本 ID、镜像 ID）；一次成功不能被当成其他环境的成功。

### `agent_runs` 运行身份快照

由运行接线方在真实创建容器后写入，记录容器实际使用的身份（不是当前线上指针）：

- `runtime_environment_id` text 可空
- `runtime_environment_name` text 可空
- `runtime_environment_version_id` text 可空
- `runtime_environment_image_id` text 可空

故意不加外键：环境/版本删除后历史运行仍要显示当时身份。

## 2. shared 导出（`@agentport/shared`）

来自 `packages/shared/src/runtime-environment.ts`：

- `RUNTIME_ENVIRONMENT_BUILDS_QUEUE = 'runtime-environment-builds'`
- `DEFAULT_RUNTIME_ENVIRONMENT_NAME = '默认环境'`
- `DEFAULT_RUNTIME_DOCKERFILE`
- `runtimeEnvironmentVersionStatusSchema` / `RuntimeEnvironmentVersionStatus`
- `runtimeEnvironmentInputSchema` / `RuntimeEnvironmentInput`（`name`、`dockerfile`，dockerfile 默认模板）
- `runtimeEnvironmentPatchSchema` / `RuntimeEnvironmentPatch`（`name?`、`dockerfile?`）
- `runtimeEnvironmentSchema` / `RuntimeEnvironment`
  `{ id, name, dockerfile, isDefault, onlineVersionId, createdAt, updatedAt }`（时间为 ISO 字符串）
- `runtimeEnvironmentVersionSchema` / `RuntimeEnvironmentVersion`
  `{ id, environmentId, dockerfile, baseImageId, status, imageTag, imageId, buildLog, logTruncated, error, startedAt, finishedAt, createdAt }`
- `runtimeEnvironmentVersionSummarySchema` / `RuntimeEnvironmentVersionSummary`
  = 版本去掉 `dockerfile` 与 `buildLog`（列表用）
- `runtimeEnvironmentBuildJobSchema` / `RuntimeEnvironmentBuildJob` = `{ versionId }`（BullMQ jobId 也是 versionId）
- `runtimeEnvironmentOnlineVersionInputSchema` / `RuntimeEnvironmentOnlineVersionInput` = `{ versionId }`
- `resolvedRuntimeEnvironmentSchema` / `ResolvedRuntimeEnvironment`
  = `{ environmentId, environmentName, versionId, imageId }`

`Agent`、`AgentInput`、`AgentPatch` 增加 `runtimeEnvironmentId: string | null`（输入默认 `null`）。
专家包 sidecar 增加可选 `agent.runtimeEnvironmentName`，只保存环境名称引用；导入方负责映射到
本机同名环境，镜像/版本历史与构建不随包导入。

## 3. repo 公开 API（`repo.runtimeEnvironments`）

文件 `packages/db/src/repo/runtime-environments.ts`，所有方法 DB-first，返回 shared 形状
（时间已转 ISO），不向调用方泄漏 Drizzle 行。

```ts
listRuntimeEnvironments(db): Promise<RuntimeEnvironment[]>
getRuntimeEnvironment(db, id): Promise<RuntimeEnvironment | null>
getRuntimeEnvironmentByName(db, name): Promise<RuntimeEnvironment | null>
getDefaultRuntimeEnvironment(db): Promise<RuntimeEnvironment | null>
createRuntimeEnvironment(db, input: RuntimeEnvironmentInput): Promise<RuntimeEnvironment>
updateRuntimeEnvironment(db, id, patch: RuntimeEnvironmentPatch): Promise<RuntimeEnvironment | null>
deleteRuntimeEnvironment(db, id): Promise<boolean>
ensureDefaultRuntimeEnvironment(db, { imageTag, imageId }): Promise<RuntimeEnvironment>

listRuntimeEnvironmentVersions(db, environmentId): Promise<RuntimeEnvironmentVersionSummary[]>
getRuntimeEnvironmentVersion(db, environmentId, versionId): Promise<RuntimeEnvironmentVersion | null>
listPendingRuntimeEnvironmentBuilds(db): Promise<PendingRuntimeEnvironmentBuild[]>
enqueueRuntimeEnvironmentBuild(db, environmentId, baseImageId): Promise<RuntimeEnvironmentVersion | null>
claimRuntimeEnvironmentBuild(db, versionId): Promise<RuntimeEnvironmentVersion | null>
appendRuntimeEnvironmentBuildLog(db, versionId, chunk): Promise<void>
completeRuntimeEnvironmentBuild(db, versionId, { imageTag, imageId, baseImageId }): Promise<RuntimeEnvironmentVersion | null>
failRuntimeEnvironmentBuild(db, versionId, error): Promise<RuntimeEnvironmentVersion | null>
publishRuntimeEnvironmentVersion(db, environmentId, versionId): Promise<RuntimeEnvironment | null>
resolveOnlineRuntimeEnvironment(db, environmentId: string | null): Promise<ResolvedRuntimeEnvironment | null>
```

`PendingRuntimeEnvironmentBuild = { id, status: 'queued' | 'building', createdAt: Date, startedAt: Date | null }`，
专供崩溃恢复对账，只查 `queued/building`，不加载 Dockerfile 与日志。

行为约定：

- `createRuntimeEnvironment` 名称冲突抛 `AppError('CONFLICT')`；`updateRuntimeEnvironment` 同样。
- `deleteRuntimeEnvironment`：默认环境、仍被智能体绑定、存在 `queued/building` 版本时抛
  `AppError('CONFLICT')`；不存在返回 false。成功时在同一事务内先清空线上指针、删除本环境全部版本、
  再删环境。DB 的 RESTRICT 外键兜底并发绑定。
- `ensureDefaultRuntimeEnvironment`：行锁 + advisory lock 串行化；默认环境已存在时直接返回，
  **不 inspect/pull、不推进线上指针**，不随 `SANDBOX_IMAGE` 变化。首次创建默认环境与一个
  `ready` 版本：`imageTag` 记录 `SANDBOX_IMAGE`，`imageId` 与 `baseImageId` 都写调用方解析出的
  真实本地 image ID（基座不是 tag），并设为线上版本。远程基座在本地缺失时由调用方的
  `ensureImage` 先拉取，仓库层不自行 pull。
- `enqueueRuntimeEnvironmentBuild` 读取环境当前 Dockerfile 作为快照；环境不存在返回 null。
  允许排队多个构建。
- `claimRuntimeEnvironmentBuild` 只在 `queued → building` 时成功，重复投递返回 null。
- `appendRuntimeEnvironmentBuildLog` 只对 `building` 版本追加，按
  `RUNTIME_ENVIRONMENT_BUILD_LOG_LIMIT`（64 KiB）保留尾部并置 `logTruncated`；64 KiB 是唯一长度上限
  （worker 内存与 DB 用同一常量），worker 只按 1 秒或 16 KiB 窗口流式批量写库。
- `completeRuntimeEnvironmentBuild` 只在 `building → ready` 时成功，并同时把实际消费的基座
  image ID 写回 `baseImageId`；`failRuntimeEnvironmentBuild` 收敛 `queued/building → failed`。
  构建日志 flush 失败时 worker 调 `fail`，版本不会进入 `ready`。
- `publishRuntimeEnvironmentVersion`：锁定环境行；版本必须属于本环境（否则 `NOT_FOUND`）且
  `ready`（否则 `CONFLICT`）；失败构建永不改变线上指针。
- `resolveOnlineRuntimeEnvironment(null)` 解析默认环境。无线上版本、版本非 ready、`image_id`
  为空时返回 null，调用方必须明确报错，不得回落其他环境。

## 4. 绑定、复制与回滚

- `duplicateAgent` 照抄源智能体的 `runtimeEnvironmentId`。
- `updateAgent` 的 patch 可写 `runtimeEnvironmentId`（`null` 清除绑定）。
- 智能体版本快照（`agent_versions.snapshot`）自动包含 `runtimeEnvironmentId`；
  路由回滚时 `snapshotToWrite` 已把它写回。
- 专家 ZIP 导出/导入 sidecar 环境名称映射已接通：导出写可选 `runtimeEnvironmentName`；
  导入按显式 `runtimeEnvironmentId` 或同名环境映射，要求该环境已有可用线上版本。
  不导入镜像/版本历史，也不执行构建。

## 5. 迁移与验证记录

> 以下是阶段性记录，不是最终整体验收。真实 Docker lifecycle 用例需要本地基座镜像与
> 可用 Docker，未执行前不能据此声称全部通过或已上线；最终结果以当次命令输出为准。

- `pnpm --filter @agentport/shared build`、`pnpm --filter @agentport/db build`：通过。
- `pnpm db:generate`：生成 `packages/db/migrations/0040_chief_masque.sql`（两张新表、
  `agents`/`agent_runs` 新列、复合外键、名称/默认环境索引、绑定部分索引）。
- 首次生成暴露两个必须修的细节：复合外键的引用目标必须是 UNIQUE **约束**（UNIQUE 索引
  在迁移里晚于 `ALTER TABLE ADD CONSTRAINT` 创建，迁移会报 42830）；partial index 的
  `eq(column, true)` 会被 drizzle-kit 序列化成 `$1`，改用 `` sql`${t.isDefault} = true` ``。
- 隔离临时库验证（脚本用 `create database` 新建随机库、跑完整 migrator、查询 catalog、再
  `drop database ... with (force)`，未触碰共享开发库）：迁移成功；三处外键存在且
  `runtime_environments_online_version_fk` 为 `(online_version_id, id) ->
  (id, environment_id)`；`agent_runs` 四个运行身份列存在。
- `pnpm exec vitest run --project backend packages/shared/test/runtime-environment.test.ts
  packages/db/test/runtime-environments.test.ts`：2 文件 / 11 测试通过；backend globalSetup
  已在新随机库上执行全部迁移。
- 并行调用方的集成验证：`packages/api/test/runtime-environments.test.ts` +
  `agent-package-runtime-environment.test.ts` 13 测试通过；worker
  `runtime-environments-resolve` + `runtime-environment-build` 11 测试通过；
  `runtime-environment-reconcile` 8 测试通过（真实 Docker 构建测试未在本轮执行）。
- 回归：`pnpm exec vitest run --project backend packages/db/test packages/shared/test`：
  30 文件 / 191 测试通过（同一轮随机库迁移覆盖全部既有表）。
- `pnpm -r typecheck`：shared/db/api/worker/web 全部通过（当时 worker 使用短名别名，
  API 使用完整函数名）。web 单独重跑通过（并行全量时曾被 SIGKILL）。

### 单一写入收尾（本轮）

- repo 短名别名已删除，所有调用方改用完整函数名；worker handler 内部的
  `claimBuild`/`appendBuildLog`/`completeBuild` 等只是其 store 接口，不是 repo 别名。
- `pnpm db:generate` 生成 `0041_eager_guardian.sql`：
  `ALTER TABLE "servers" ADD COLUMN "last_test_runtime_environment" jsonb`。未改 0040。
- 隔离库验证：backend globalSetup 新建随机库并跑完整 migrator；新增的 servers jsonb
  往返读写用例通过，证明 0041 在全新库上生效。
- 合并前 rebase `origin/main`：远端已合入 `0040_fuzzy_warstar`，原 `0040_chief_masque` +
  `0041_eager_guardian` 改为在合并后 schema 上重新生成单个 `0041_careful_pretty_boy.sql`；
  SQL 与原先两文件语义一致，`pnpm db:generate` 再次运行返回无变更。
- `pnpm -C packages/db build` / `typecheck`：通过。
- 目标测试：db runtime-environments + worker build/reconcile/resolve 共 4 文件 / 30 测试通过。
  build 用例覆盖：构建中分批落库、失败/中断尾部、认领冻结基座不受 worker 当前镜像影响、
  complete 回写实际基座 image ID、64 KiB 尾部截断。
- `biome check`（本轮改动文件）：无 error；`runtime-environment-build.test.ts` 保留改动前
  已存在的 `noTemplateCurlyInString` warning（Dockerfile 测试字符串）。
- worker 全量 typecheck：运行接线代理已同步 `packages/worker/src/index.ts`，`pnpm -C
  packages/worker typecheck` 通过。

## 6. worker 接线状态（`packages/worker/src/index.ts`）

运行接线代理已完成，当前实现与本契约一致：

1. `claimBuild` 映射携带 `baseImageId: version.baseImageId`。
2. `completeBuild` 参数含 `baseImageId` 并直接透传 repo（成功时写回实际基座 image ID）。
3. `startRuntimeEnvironmentBuildWorker` 不再传 `sandboxImage`；worker 只认版本冻结基座。
4. reconciler 的 `listPendingBuilds` 直接调用
   `repo.runtimeEnvironments.listPendingRuntimeEnvironmentBuilds(db)`，不再内联查询。
5. 构建日志按 1 秒或 16 KiB 窗口流式落库；64 KiB 是唯一长度上限（worker 内存与 DB
   共用同一常量），只保留尾部并置 `logTruncated`。flush 失败时版本走 `fail`，不会写成 `ready`。
6. 成功构建调用共享的 `verifyRuntimeEnvironmentImage`：拒绝镜像声明的任何卷，实际启动
   `runner`/`session-supervisor`/`probe`/`native-plugins` 到协议边界，执行 SDK 原生 CLI
   `--version`，并确认 PATH 上有 Bash。

