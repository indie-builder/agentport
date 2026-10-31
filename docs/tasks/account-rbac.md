# 账户与对象范围权限

## 目标

在 Better Auth 1.7.14 + username + Drizzle 上完成多账户、动态角色权限矩阵、专家成员和稳定业务身份；清除认证资料并以同一 businessId 重建账户后，原业务归属、角色、成员和个人记忆恢复，旧会话永久失效。所有后端入口执行权限与对象范围检查，前端按同一功能目录显示菜单和动作。

## 方案

跨代理接口唯一实施依据为 [account-rbac-contract.md](account-rbac-contract.md)。认证技术 ID 保持随机；业务记录直接存 businessId，不引用可删除 authUsers。复用现有认证、Fastify、Drizzle、shared、TanStack 和 shadcn，不增加生产依赖；角色与权限授予存 DB，功能目录只在 shared 定义一次。权限以同一个 grant 的 permissionId + scope 判定对象，多角色只合并完整授权结果。

认证采用 Better Auth + Drizzle 的 PostgreSQL 会话（Cookie `agentport_token`），不建业务身份映射表。首次初始化由 `ensureBootstrap` 在 `platform_bootstrap` marker 不存在时执行一次：创建随机技术 ID、业务 ID `bootstrap-admin` 的管理员并播种默认角色；marker 写入后不再按 `.env` 密码重播。`user` 表增加服务端字段 `business_id`（稳定业务身份）与 `disabled`（停用状态），认证技术 ID 可更换，业务关联只认 businessId。

## 基线与范围

- 实现树（保留）：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/account-rbac`；分支 `worktree-account-rbac`；起点 `fed3e5af303f748649448dbbeaa0baf8a6ea0b2c`，初始 clean，无他人差异。
- 发布树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/account-rbac-release`；分支 `release/account-rbac`；起点 `origin/main=8abdbe5a18753ea3db5a34fd1b8f7ee0b8ca17a5`。发布树只落本任务产物，实现树与主 checkout 保持原状。
- 当前产物：发布树按 237 项显式清单从实现树提取（206 项修改、31 项新增），排除 `.vitest/json/output.json`、`docs/tasks/schedule-ui-redesign.md`、`docs/DESIGN-SYSTEM.md`、`docs/research/qoder-cn-ui/report.md`、`packages/web/DESIGN.md` 五项非本任务产物；尚未 commit/push/PR，未合入 main。
- 实施范围：shared、db（schema/repo/迁移）、api（认证、授权、业务入口）、worker（个人记忆/运行主体）、web（账户与权限界面）；跨代理接口见契约文件。
- 用户已于 2026-10-31 授权本任务 commit/push/PR/merge；生产发布或清空共享库仍未授权。本轮未修改共享数据库。

## 当前有效决定

- businessId 与 username 分离，管理员录入且不可修改、不可回收；1..160 Unicode 字符，拒绝空白/控制字符，不强制 ASCII 或 namespace 三段格式。业务字段直接存 ID，不建 businessIdentities、不连 authUsers FK；离线姓名缺失显示 businessId。
- 账户清理保留角色、专家 owner/member、业务内容与个人内容；恢复创建显式 restore:true，由服务端查历史引用确认。bootstrap 使用 `platform_bootstrap` 单表 marker，只初始化一次；删除认证资料后按同一 businessId 恢复，旧 cookie 因会话级联删除返回 401。
- 账户补 disabled 服务端字段及 active/disabled 状态，停用撤销会话、激活不恢复 cookie；补本人验证旧密码改密后重新登录。
- 专家配置/规则/风格/完整文件/绑定/启停/克隆/导入导出/记忆/版本均有独立叶；eval/schedules 独立，global 动作按真实入口拆分。treePath 支持多级树，种子展开精确 permissionId+scope，鉴权不使用前缀。
- 角色矩阵 GET/PUT /roles 整体读写，expectedRevision 同事务比较、全量落库和递增 revision；冲突 409 且不部分保存。管理写叶须对应最少视图读权限。
- 专家列表仅 AgentSummary，完整详情按 agents.config.read，规则/风格/文件/记忆额外按自身读取叶；维护权限 M、负责人 W、平台 P，普通用户保留本人会话 CRUD/分享/停止/审批/问答。
- 默认平台管理员、用户、负责人、维护人员四种角色；角色是 DB 数据，不能用角色名代替权限判定。
- 负责人只能管理本人负责专家；维护人员只能维护指定专家；二者不能由此读取其他用户正文或管理全局资源。
- 功能树按实际业务功能分组，评估与定时独立；父级为叶权限的三态聚合。
- 个人记忆按 businessId 独立目录（`WORKSPACES_DIR/_users/<sha256(businessId)>/`）与锁隔离，worker 从 DB 取主体；system/mcp 明确服务身份。
- 保留既有专家共享 auto-memory 的共享及读写语义，保留官方 SDK 文件结构、独立 MCP 与公开分享认证边界。
- 本期不接企业身份源、不做用量、组织租户、权限语言、资源发布体系、脚本恢复工具或空适配框架。
- 迁移新增 NOT NULL 字段且不回填；只在全新空库验证，不声称旧库可无损升级。部署到既有库需用户明确决定重建数据，不自动清库。
- 2026-10-31 用户明确授权本任务提交、推送、创建 PR 并合并；发布以新树 `release/account-rbac` 为唯一提交源，原实现树保留不改。合并完成前不声称已合入 main。

## 已替代项及原因

现有仅允许 ADMIN_USER 的鉴权、固定管理员技术 ID、每次首次登录覆盖管理员密码、单一 `_user` 个人目录均已被替换。`ensureAdmin` 重播已替换为 `ensureBootstrap` 一次性 marker；原始方案或执行日志中出现过的 `businessIdentities` 建表设想已废弃，最终不建该表。现有业务历史无需自动迁移，不允许擅自重置共享库。

## 实施状态

**实现与验证已完成；发布树定向 review 已通过（Opus a1ff064397f669a9：237 项源码、测试与迁移同实现树逐字节一致，5 个排除项与 `origin/main` 一致），用户已授权提交、推送、创建 PR 并合并；下一步只做 Git 发布，尚未合入 main。** 源码、迁移、服务端/前端实现、定向验证、最终全量前端与 backend 组合覆盖、typecheck、构建与迁移隔离验证均已完成；所有分层 Opus 独立 review 已明确通过。本轮发布树复查：四文件 64 条 web 测试通过、全仓 typecheck 与 web build 通过、237 项清单相对 `origin/main` 无空白错误、代码文件与实现树逐字一致。本期不接企业身份源、不接飞书/钉钉同步、不做用量统计、未做付费模型真实 worker run、未运行 CI。

独立 review 结论（均已通过）：数据库 scope + admin lock / name collision；runtime queued + sha256；business overview / OpenUI + private audit；web finegrain 最终 toggle / min patch；login / deletion / eval 最终 review。

## 步骤

- [x] 阅读 CLAUDE、DEV-WORKFLOW、PITFALLS，核对现有认证、schema、路由与个人记忆入口。
- [x] 固定本任务目标、基线、边界与实施契约。
- [x] shared + DB 导出、schema、repo、迁移落地。
- [x] auth + 授权基础、agents、其余 API、worker + 个人记忆按契约落地。
- [x] web 账户页、角色功能树、专家成员与入口权限按同一功能目录落地；主要 UI 定向验证通过。
- [x] 各单元写行为测试并取得真实通过报告；安全相关测试未跳过。
- [x] Opus 独立审查账户/权限数据与运行（`a9b523` 通过）；商务概况 OpenUI 验收（`a4d7`）通过。
- [x] 真实浏览器验收（ego task 77）：admin 登录、角色树行/角色列/搜索/分享勾选保存 revision、创建普通账户 `qa-business-user-001`、授权专家、普通用户 `/api/accounts` 与 `/api/roles` 403、`/api/agents` 完整详情 403 但可聊天、管理员 member dialog 的 businessId、删除认证后同 businessId rename 恢复 user 角色与 canUse；role 表 viewport 1492 = document 1492，table 1468.86 滚动容器 1206。
- [x] web 两项 mustfix 已修：只读工具 toggle、onlydirty writer；onlydirty 23 条通过；knowledge-source-runs 修复后单跑 2 条通过。
- [x] 全仓 typecheck、web build、API/worker build 最终通过；focus/contract 通过；core biome 15 文件为 rtk 误报，bypass 后实际通过。
- [x] production 浏览器 5190 真实登录 -> roles 四角色、无横向溢出通过；evil Origin 返回 403（检查时临时给 5190 加 CORS）。
- [x] 全量 backend：257 文件 / 2584 总 / 2568 通过 / 0 断言失败 / 16 跳过；命令 exit 1，原因是 `session-sandbox-sdk.test.ts` 的 beforeAll 依赖共享 `agentport/sandbox` dev 镜像，其中缺 GNU bash（非断言失败）。
- [x] 用独立已有镜像 `redesign-validation-642ddc7d`（仅覆盖 `SANDBOX_IMAGE`）重跑 `session-sandbox-sdk`：16/16 通过、0 跳过、命令 exit 0；与全量组合后覆盖完整，但原 full 命令本身不是 exit 0。
- [x] 全量 web：120 文件 / 1440 条全部通过、0 失败 0 跳过；并发 schedule 定向 1 文件 30 条通过。两轮合计覆盖 121 个前端文件，但不是同一轮次，不合并声称 1470 条同轮通过。
- [x] 付费模型真实 worker run、CI、飞书/钉钉同步与用量统计本期不在范围，未执行。
- [x] 从 `origin/main` 8abdbe5 新建发布树，按显式清单提取 237 项（206 修改、31 新增）；发布树 `pnpm install --frozen-lockfile`、shared/core/db 构建、四文件 64 条 web 测试、全仓 typecheck、web build、biome 与空白检查通过。
- [x] 发布树定向 review（Opus a1ff064397f669a9）：237 项源码、测试与迁移同实现树逐字节一致，混合 `ops.tsx` 11+/6-、`schedule-feedback.test.ts` 2+/0-，5 个排除项与 `origin/main` 基线一致；PASS。

## 改动文件

- `docs/tasks/account-rbac.md`：任务记录。
- `docs/tasks/account-rbac-contract.md`：跨代理接口、数据及权限语义唯一实施契约。
- `README.md`、`PRODUCT.md`、`DELIVERY.md`、`docs/ARCHITECTURE.md`、`docs/USER-STORIES.md`、`docs/PROJECT-BRIEF.md`、`docs/DECISIONS-PENDING.md`、`docs/OPERATIONS.md`：取消「目标待实现」状态，改为本工作树已实现、未合入 main；修正 JWT/Redis 会话、单账号、bootstrap 覆盖旧密码、`_user` 单目录与 businessId 关联描述；本轮更新为已通过最终 review、准备发布（尚未合入 main）。
- `docs/DEV-WORKFLOW.md`、`docs/PITFALLS.md`、`docs/SECURITY.md`、`docs/RUNBOOK.md`：bootstrap 语义、认证/JWT/Redis 过时说明与踩坑记录。
- `packages/web/test/agents-files-on-demand.test.ts`、`expert-knowledge-binding.test.ts`、`resource-navigation.test.ts`、`resource-states.test.ts`、`skills-resource-feedback.test.ts`：仅删除行尾空白的空行，无语义变更。
- 源码、测试与迁移位于发布树 `release/account-rbac` 的未提交差异中（237 项显式清单）；关键迁移为 `packages/db/migrations/0045_married_expediter.sql`，认证初始化为 `packages/api/src/features/auth/bootstrap.ts`，账户/角色仓储在 `packages/db/src/repo/accounts.ts`、`access.ts`、`identities.ts`，账户与角色路由在 `packages/api/src/features/auth/accounts.ts`。

## 验证（真实报告）

本轮已把 `.vitest/account-rbac-*.json` 中已生成的报告复制归档到 `.tmp/account-rbac-evidence/`。新增的 `account-rbac-sdk-valid-image.json`、`account-rbac-web-scope-final.json` 已按哈希与 JSON 解析校验一致后删除 `.vitest` 原件；其余 `.vitest` 原件仍留待主会话专属清理代理。`report.vitest/account-rbac-source-runs-final.json` 也已复制校验一致后删除仅含该文件的 `report.vitest/`。以下数字取自这些报告（链接相对本工作树，均存在）：

- 发布树本轮（2026-10-31）：`pnpm test:web packages/web/test/account-rbac.test.ts packages/web/test/schedule-feedback.test.ts packages/web/test/status-feedback.test.ts packages/web/test/dialog-validation.test.ts` 4 文件 64 条全部通过；`pnpm typecheck` exit 0；`pnpm --filter @agentport/web build` exit 0（仅 chunk 体积警告）；`pnpm exec biome check` 两混合文件 exit 0；237 项清单相对 `origin/main` 的逐文件空白检查无 trailing whitespace / space before tab / blank line at EOF；`ops.tsx` 11+/6-、`schedule-feedback.test.ts` 2+/0-；`pnpm install --frozen-lockfile` 成功，workspace 链接指向发布树内 `packages/*`。
- 主会话在原实现树最近复跑：全仓 typecheck、API/worker/web build、focus、contract、db:generate 均 exit 0；四文件 64 通过。backend 2568 通过 + SDK 16 通过与 web 1440 通过为先前轮次证据，非同轮，不合并声称。
- [account-rbac-access-final.json](../../.tmp/account-rbac-evidence/account-rbac-access-final.json)：access 6 个文件 61 条通过（accounts 7、agents-access 11、auth 15、roles 5、route-access 10、access 13）。
- [account-rbac-agent-patch-final.json](../../.tmp/account-rbac-evidence/account-rbac-agent-patch-final.json)：agents-ui 41 条通过。
- [account-rbac-ui-last.json](../../.tmp/account-rbac-evidence/account-rbac-ui-last.json)：onlydirty `account-rbac.test.ts` 23 条通过。
- [account-rbac-login-final.json](../../.tmp/account-rbac-evidence/account-rbac-login-final.json)：login 40 条通过。
- [account-rbac-agents.json](../../.tmp/account-rbac-evidence/account-rbac-agents.json)：agents-access 11、agents 29、delegation-memory-lock 8、memory-files 36，共 84 条通过。
- [account-rbac-knowledge-export-final.json](../../.tmp/account-rbac-evidence/account-rbac-knowledge-export-final.json)：knowledge/export 112 条通过。
- [account-rbac-knowledge-last.json](../../.tmp/account-rbac-evidence/account-rbac-knowledge-last.json)：knowledge-management 112 + knowledge-source-runs 2，共 114 条通过。
- [account-rbac-shell-final.json](../../.tmp/account-rbac-evidence/account-rbac-shell-final.json)：shell 40 条通过。
- [account-rbac-worker-final.json](../../.tmp/account-rbac-evidence/account-rbac-worker-final.json)：worker 80 条通过；[account-rbac-backend-worker-tests.json](../../.tmp/account-rbac-evidence/account-rbac-backend-worker-tests.json)：worker 19 条通过。
- [account-rbac-api-final2.json](../../.tmp/account-rbac-evidence/account-rbac-api-final2.json)：API 186 条通过、0 skip；[account-rbac-api-final2-overview.json](../../.tmp/account-rbac-evidence/account-rbac-api-final2-overview.json)：overview 11 条通过。
- [account-rbac-backend-db-tests.json](../../.tmp/account-rbac-evidence/account-rbac-backend-db-tests.json)：DB 全量 125 条通过。
- [account-rbac-backend-api-tests.json](../../.tmp/account-rbac-evidence/account-rbac-backend-api-tests.json)：旧 fixture API 91 条通过。
- [account-rbac-audit.json](../../.tmp/account-rbac-evidence/account-rbac-audit.json)：审计 10 条通过；[account-rbac-eval-authorization-final.json](../../.tmp/account-rbac-evidence/account-rbac-eval-authorization-final.json)、[account-rbac-eval-run-auth-final.json](../../.tmp/account-rbac-evidence/account-rbac-eval-run-auth-final.json)：eval 授权 40、运行鉴权 28 条通过。
- [account-rbac-web-chat.json](../../.tmp/account-rbac-evidence/account-rbac-web-chat.json)：web chat 定向 202 条通过。
- [account-rbac-web-confirmed.json](../../.tmp/account-rbac-evidence/account-rbac-web-confirmed.json) / [account-rbac-web-delivery-final.json](../../.tmp/account-rbac-evidence/account-rbac-web-delivery-final.json)：历史 web 全量 1459 总 / 1458 通过 / 1 失败（knowledge-source-runs、chat-outputs；前者已由 `knowledge-last` 单跑 2 条覆盖，整体已被下方 web-scope-final 取代）。
- [account-rbac-chat-outputs-final.json](../../.tmp/account-rbac-evidence/account-rbac-chat-outputs-final.json)：chat-outputs 定向 78 条全部通过，覆盖历史全量的唯一失败用例。
- [account-rbac-backend-full.json](../../.tmp/account-rbac-evidence/account-rbac-backend-full.json)：上一轮 backend 全量 2579 总 / 2467 通过 / 84 失败 / 28 跳过（历史报告）。
- [account-rbac-backend-delivery.json](../../.tmp/account-rbac-evidence/account-rbac-backend-delivery.json)：全量 backend 257 文件 / 2584 总 / 2568 通过 / 0 断言失败 / 16 跳过；`success=false`，唯一失败文件为 `session-sandbox-sdk.test.ts`，原因是 beforeAll 依赖的共享 `agentport/sandbox` dev 镜像缺 GNU bash（非断言失败）。
- [account-rbac-sdk-final.json](../../.tmp/account-rbac-evidence/account-rbac-sdk-final.json)：shared dev 镜像环境下 16 条全部 skip（历史）。
- [account-rbac-sdk-valid-image.json](../../.tmp/account-rbac-evidence/account-rbac-sdk-valid-image.json)：独立镜像 `redesign-validation-642ddc7d` 重跑 16/16 通过、0 跳过、`success=true`；与全量组合覆盖完整，但原 full 命令仍非 exit 0。
- [account-rbac-web-scope-final.json](../../.tmp/account-rbac-evidence/account-rbac-web-scope-final.json)：全量 web 120 文件 / 1440 条通过 / 0 失败 / 0 跳过。
- [schedule-concurrent-current.json](../../.tmp/account-rbac-evidence/schedule-concurrent-current.json)：并发 schedule 定向 1 文件 30 条通过 / 0 失败 / 0 跳过；与 web-scope-final 合计覆盖 121 个前端文件，但分属两轮，不声称同轮 1470 条。
- 浏览器（production 5190）：真实登录后角色页四角色列、账户页 businessId 列表均无横向溢出通过；角色/指定专家授权与同 businessId 恢复后的 role / use grant 恢复均验证通过；evil Origin 返回 403（仅检查时临时给 5190 加 CORS）；ego task 77 已完成并 keep[]。
- 迁移：`0045_married_expediter.sql` 在全新随机库完整建库并迁移成功，`db generate` 无变更；未修改共享开发库；迁移只在新库验证，不保留旧数据兼容。
- 类型检查与构建：全仓 typecheck、web build、API/worker build 最终通过；focus/contract 通过；core biome 15 文件为 rtk 误报，真实 bypass 后无 fix、实际通过。
- 旧开发 HMR 空 matches 未能确证、production 未复现，按已知限制保留，不声称完全无 bug。
- 并发 schedule 文件是设计文档、非本任务产物；其记录保护未回滚，最新 30 条测试已通过。
- 预览服务 3138、7661 已 stop，之后重启的 29352 也已 stop（[preview.log](../../.tmp/account-rbac-preview/preview.log)、[stopped.json](../../.tmp/account-rbac-preview/stopped.json)）；只清理任务独立库与 Redis，未改用户 dev DB，未触碰其它进程。
- 付费模型真实 worker run、CI、飞书/钉钉同步与用量统计本期不在范围，未执行。

## 下一步

1. 提交、推送、创建 PR 并按用户授权合并；合并完成前不声称已合入 main。
