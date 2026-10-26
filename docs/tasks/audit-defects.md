# 修复 PR #11 比对中确认的缺陷

## 目标

PR #11（`feat/audit-fixes-agent-archive`）已关闭：主体实现被 main 的官方目录 ZIP、Better Auth、沙盒化取代。但逐项比对确认其中有 8 处缺陷在今日 main 上**仍然存在**。本任务只修这些缺陷，不夹带归档、认证、沙盒架构的改动。

验收标准：每条缺陷都有回归测试，修复前后行为可对照。

## 方案

### 缺陷清单（均已读源码确认）

| # | 缺陷 | 位置 | 修法 |
|---|---|---|---|
| 1 | 定时任务 PATCH 因 `.partial()` 继承 `default` 而误启用 | `packages/shared/src/ops.ts:39` | 先去掉默认值再 `.partial()`，与 agent PATCH 的既有做法一致 |
| 2 | glob 花括号被 `.split(',')` 拆坏，`src/**/*.{ts,tsx}` 变成两个错误路径 | `packages/core/src/workspace.ts:122` | 只在顶层逗号拆分，保留 `{…}` 内部 |
| 3 | 运行导出漏传 `trigger`，筛选后导出与列表不一致 | `packages/api/src/features/runs/routes.ts:58` | 导出读取并传递 `trigger` |
| 4 | 限流 Redis `maxRetriesPerRequest: null`，故障时请求挂死并归为 500 | `packages/api/src/plugins/security.ts:40` | 加上有界重试与命令超时，存储故障映射 503 |
| 5 | 技能 frontmatter 的 license / compatibility / metadata 被静默丢弃 | `packages/core/src/skill-md.ts:40` | 保留并在导出/渲染/导入往返；需 DB 列、API、worker 同步 |
| 6 | 规则 slug 的宽泛 `catch {}` 把数据库故障误报为非法输入 | `packages/api/src/features/agents/routes.ts:768` | 非法输入走 schema 校验，真实故障交给统一错误处理 |
| 7 | 工具重名未映射 409 | `packages/api/src/features/servers/routes.ts:396` | 捕获唯一约束冲突，返回可读 409 |
| 8 | 禁止读 `.claude/skills/` 与允许读 `references/` 自相矛盾 | `packages/core/src/workspace.ts:261` vs `:297` | 删掉全面禁读指令，保留受限的 `references/` 读取 |

### 附带清理（低风险）

- 删除无引用导出：`DialogFooter`、`SheetHeader`、`SheetFooter`、`useAgentStats`、`useMe`、`listSubAgentCandidates`
- `scripts/up.sh` 收紧 `.env` 权限（`umask 077`，已有文件 `chmod 600`）
- 测试源码纳入 `tsc`（`typecheck:test`），按当前 main 的共享类型修正夹具

### 明确不做

- 不恢复 `/archive` 双接口、`buildWorkspaceArchive`、`{filename,dataBase64}` 协议
- 不恢复宿主 stdio 执行、JWT/Redis 会话
- 不引入 `schedule: cron` 自动 CI
- 不合 `pnpm-lock.yaml`，依赖按当前 main 重新解析
- 缺陷 5 若涉及 DB 迁移，编号必须基于现有账本 0037 之后重新生成

## 基线与范围

- Worktree：`.claude/worktrees/fix-audit-defects`，分支 `fix/audit-defects`
- 起始 HEAD：`95d9057`（= `origin/main`）
- 初始工作树干净
- 配置：`.env` 取自主 checkout 绝对路径

## 当前有效决定

用户 2026-10-26：「按你的建议来」——关闭 PR #11，另开分支只修确认的缺陷。

## 已替代项及原因

- 原 PR #11 的整包合并路径已放弃，理由见 PR 关闭说明。

## 步骤

- [x] 契约与并行边界确认
- [x] 缺陷 1–4（后端行为）
- [x] 缺陷 5 的 core 侧（解析/渲染保留字段）；DB/API/worker 透传另开任务
- [x] 缺陷 6–8（接口与指令）
- [x] 附带清理（5 处死代码、up.sh 权限）；`typecheck:test` 未做
- [ ] 独立 review + 修复
- [ ] 验证（typecheck / 全量测试 / 相关回归）

## 改动文件

修复
- `packages/shared/src/ops.ts`、`packages/shared/test/schedule-patch.test.ts`：定时 PATCH 不再注入 `enabled` 默认值
- `packages/core/src/workspace.ts`：`splitGlobs` 只按顶层逗号拆分，处理花括号、方括号字符集与反斜杠转义；删除与 `references/` 读取矛盾的禁读指令
- `packages/core/src/skill-md.ts`：保留 `license`/`compatibility`/`metadata`；`metadata` 拒绝非有限数字并指出键路径
- `packages/core/test/workspace.test.ts`、`packages/core/test/skill-md.test.ts`：上述回归
- `packages/api/src/features/runs/routes.ts`、`packages/api/test/runs-export.test.ts`：导出传递 `trigger`
- `packages/api/src/plugins/security.ts`：限流 Redis 有界重试 + 3s 命令超时；存储边界把错误转成可重试 503
- `packages/api/src/plugins/errors.ts`、`packages/api/test/errors.test.ts`：识别 Redis 故障（**不匹配 `AbortError`**，避免误伤外部 HTTP 超时）
- `packages/api/test/rate-limit-redis.test.ts`：真实连不通的 Redis，断言快速返回可重试 503
- `packages/api/src/features/agents/routes.ts`、`packages/api/test/agents.test.ts`：规则 slug 在路由边界校验，移除宽泛 catch
- `packages/api/src/features/servers/routes.ts`、`packages/api/test/servers.test.ts`：工具重名映射 409
- `packages/api/test/skills.test.ts`：改为直接断言 `parseSkillMd` 保留 `license`

清理
- `packages/web/src/components/ui/dialog.tsx`、`sheet.tsx`：删除无引用的 `DialogFooter`/`SheetHeader`/`SheetFooter`
- `packages/web/src/lib/queries.ts`：删除无引用的 `useAgentStats`/`useMe`（底层 query 仍被页面使用，保留）
- `packages/db/src/repo/agents.ts`：删除无引用的 `listSubAgentCandidates`
- `scripts/up.sh`：`umask 077` + `chmod 600 .env`

## 下一步

- 缺陷 5 的持久化透传：`skills` 表加 `license`/`compatibility`/`metadata` 列（迁移编号从 0038 起），并接上 `skills/routes.ts` 的 `createSkill`/`toApi`、`agent-package.ts` 的 `PackageSkillInput` 与 `withFiles`、`worker` 渲染链路。在此之前字段只保留在 core 解析层，导出包仍会丢。
- 限流 Redis 的 Proxy 依赖 `@fastify/rate-limit` RedisStore 只调用 `rateLimit`/`rateLimitRead` 两条命令；升级该插件时需复核。
- `typecheck:test`（测试源码纳入 tsc）未做，评估价值后再决定。

## 验证

- `pnpm -r typecheck`：7 包通过
- `pnpm test`：**2218 / 2218 通过**（260 文件）
- `pnpm lint:focus` / `pnpm lint:contract`：通过
- `biome check .`：16 处问题均在本次未触碰的 `knowledge/package.ts`（11）与 `agent-package-v2-validation.test.ts`（5），属 main 既有
- 集成测试（真实 Postgres/Redis，未跳过）：`agents.test.ts` + `servers.test.ts` + `runs-export.test.ts` **46/46**
- 限流行为回归：`rate-limit.test.ts` + `security.test.ts` **8/8**，确认 Redis 正常时限流仍生效（Proxy 未破坏计数）
- 独立 Opus 审查：2 个阻断项（`AbortError` 误伤、1s 超时过紧）与 3 个建议项（glob 转义/字符集、metadata 非有限数字、技能测试断言过弱）已全部修复并复核
