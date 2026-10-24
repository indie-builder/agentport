# 技能页拆分：内部 / 市场

## 目标

「专家 / 技能 / 连接器」里的技能页增加来源视图：

- **内部**：用户自建、上传 SKILL.md、市场安装后的技能，沿用现有卡片与支持文件编辑。
- **市场**：直接呈现 skills.sh 的榜单与搜索；安装后落入内部技能。

## 数据来源（已实测）

- 榜单：解析 `www.skills.sh` 首页 / `/trending` / `/hot` 的服务端 HTML，内存缓存 10 分钟。
- 搜索：`https://skills.sh/api/search?q=&limit=50`（无需认证，缓存 5 分钟）。
- 安装：直连 `https://skills.sh/api/download/{owner}/{repo}/{slug}` 拿技能快照
  （`{files:[{path,contents}]}`），校验路径/大小后落内部技能；不启子进程。
- 官方 `/api/v1/*` 需要 Vercel OIDC，本期不接。

## 契约

- `skills.source_id`（可空、唯一）记录市场来源 `owner/repo/skill`；内部自建为 null。
- `GET /api/market/skills?view=all-time|trending|hot&q=` → `MarketSkill[]`
  （`id / source / slug / name / installs`）。
- `POST /api/market/skills/install` body `{ id }` → `{ skill, warnings }`。
- 安装时 slug 取市场 id 的最后一段，frontmatter 只取 name/description/body。
- 重复 source_id → 409；slug 冲突 → 409。

## 步骤

- [x] shared / db 契约：sourceId、MarketSkill、安装入参
- [x] API：榜单解析 + 搜索代理 + 快照安装 + 审计
- [x] Web：内部 / 市场切换、市场列表、搜索、安装
- [x] 单元测试：榜单解析、快照校验
- [x] typecheck / test / 本地实测
- [x] Opus review（4 个 Must fix 已处理：选项注入、符号链接、git 依赖、读取顺序）
- [ ] 提交 / 合并

## 验证

- `pnpm typecheck`：全部通过
- `pnpm vitest run packages/api/test/market-leaderboard.test.ts packages/api/test/market-install.test.ts packages/api/test/skills.test.ts`：16 passed
- `pnpm lint:focus` / `pnpm lint:contract` / `biome check`：通过
- `pnpm db:migrate`：0031 已应用（`source_id` + 唯一索引）
- 端到端：hot 榜单 200/50 条；搜索 200/50 条；安装 `vercel-labs/skills/find-skills` 201；
  重复安装 409「该技能已安装」；删除 204
- 浏览器实测：市场榜单/搜索/安装/已安装态/内部来源徽标正常；测试技能已清理

## 不做

- 官方 v1 API / Vercel OIDC。
- 技能更新检查（快照 hash 暂不落库）。
- pack 安装、私有仓库认证。
- 内部技能 zip 整目录上传。
