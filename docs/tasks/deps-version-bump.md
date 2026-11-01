# 依赖版本升级（3 项）

## 目标
把 3 个落后于 registry latest 的依赖升到最新稳定版，其余不动；升级后全量 typecheck + 相关测试通过，文档版本号同步。

## 方案
- `@hookform/resolvers` 6.0.2 → 7.0.0（major；v7 peer 要求 `react-hook-form ^7.55`、`zod ^3.25||^4`，与现有 7.91.0 + zod 4.6.7 兼容；入口仅 `zodResolver`，v7 保留该导出）
- `better-auth` 1.7.14 → 1.7.15（patch）
- `@tanstack/react-query` 5.105.0 → 5.105.1（patch）
- 不动：`@types/node`（24.19.2 已是 Node 24 线最新，26.x 与运行时错配）、`fastify`（6.x alpha）、`drizzle-orm`（1.0 仅 rc/beta）等既定稳定线选型。

## 基线与范围
- 起点：`origin/main` @ 619b0c6a684130030b990f1022294235eccd0724，工作区干净。
- 允许改动：`packages/web/package.json`、`packages/api/package.json`、`packages/db/package.json`、`pnpm-lock.yaml`、`docs/PROJECT-BRIEF.md`（仅版本号）。
- 不改业务代码。

## 当前有效决定
用户确认执行这 3 项升级。

## 已替代项及原因
无。

## 步骤
- [ ] 改 3 个包 package.json 版本号
- [ ] `pnpm install` 更新锁文件
- [ ] 同步 `docs/PROJECT-BRIEF.md` §3.2/§3.3 版本号
- [ ] 验证：全量 `pnpm typecheck` + web 表单相关测试 + `pnpm test`

## 改动文件
- packages/web/package.json
- packages/api/package.json
- packages/db/package.json
- pnpm-lock.yaml
- pnpm-workspace.yaml（pnpm 自动追加发布年龄豁免）
- docs/PROJECT-BRIEF.md

## 下一步
无

## 验证
- `pnpm install`：成功，`Lockfile passes supply-chain policies`；`--frozen-lockfile` 通过。
- 安装落地：`@hookform/resolvers 7.0.0`、`@tanstack/react-query 5.105.1`、`better-auth 1.7.15`（api/db 均）。
- `pnpm typecheck`（全 8 包）：全部 Done（主会话独立复跑确认）。
- `pnpm test:web`：151 文件 / 1880 测试通过。
- `pnpm test`（全量）：461 文件通过 / 3 文件失败，均为 20s 超时（knowledge-ingestion / knowledge-wiki / runner-client-questions），与本次升级包无关；这 3 个文件单独重跑 66 测试全通过。
- 兼容性：`@hookform/resolvers/zod` 仍导出 `zodResolver`；better-auth 的 `better-auth/api|node` 与 `createAuth` 导入正常。
- `pnpm-workspace.yaml` 新增 10 条 `minimumReleaseAgeExclude`（`@better-auth/*@1.7.15`、`@tanstack/*@5.105.1`），是 pnpm 12 发布年龄策略要求、与仓库既有条目同一机制，保留。
