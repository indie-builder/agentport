# 安装技术栈最佳实践技能

## 目标

按项目技术栈安装 11 个最佳实践技能，装后补齐项目适配、复核既有技能未变，并更新 `docs/SKILLS.md`。

状态：**验证完成，独立 Opus 第二轮复核通过**。11 个技能已落盘并接入 lock 与链接，项目适配、上游文件、最终集合与 Claude 启动发现均已验证。第一轮发现的 Query API 与 TypeID 适用边界问题已修复并复核，无新增阻断。用户已授权 commit / push / PR / merge；本次授权提交 PR 合并，结果以 PR 合并状态为准。

验收标准：

- 11 个技能目录位于 `.agents/skills/`，`.claude/skills/` 有对应相对链接，`skills-lock.json` 有对应条目。
- 既有 14 个技能逐文件 SHA256 与 §00 快照一致；shadcn / openui 项目适配未被改动。
- `docs/SKILLS.md` 清单与 lock、技能目录一致，11 个新技能已并入主表。
- `npx --yes skills@latest list` 与上述三者一致，无残留。

## 方案

1. 按 `docs/SKILLS.md`「开始前」核对 CLI 版本、帮助与 11 个技能的上游来源（仓库 + 技能名）。
2. 逐个安装：`npx --yes skills@latest add <repo> --skill <name> --agent claude-code --agent universal -y`（两个 agent 缺一不可）。
3. 不更新既有技能；安装后核验新增条目的上游完整文件、lock 条目、技能目录与有效相对链接。TanStack 包内技能安装加 `--full-depth`。
4. 用 §00 快照逐文件比对既有 14 个技能 SHA256，并 `diff -r` 校验 shadcn / openui 适配目录；必要时按 `docs/SKILLS.md`「项目适配」补回。
5. 把新技能并入 `docs/SKILLS.md` 主表，记录适配细节与实际验证结果。
6. 按 `docs/DEV-WORKFLOW.md` 交独立 Opus 审查后再交付。

取舍：

- 单个技能失败不跳过静默继续：记录失败项与原因，其余照常安装，最终如实列为未完成。
- 项目适配细节（是否需像 shadcn / openui 那样裁剪触发条件）留到装后按实际 `SKILL.md` 内容设计核验，不在安装前臆断。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/install-stack-best-practice-skills`
- 开工 HEAD：`efcf71c802560b472a96ad54a472e088cd4c8738`（`worktree-install-stack-best-practice-skills`）
- `origin/main`：`efcf71c802560b472a96ad54a472e088cd4c8738`（安装前重新 fetch 仍为该值）
- 本地 `main`：`797edfeaabd39b040d01736c49273da18347ea92`（落后于 `origin/main`，本任务不以本地 main 为对齐依据，见 `docs/PITFALLS.md`「新 worktree 不一定基于最新 origin/main」）
- `git status`：开工时干净；安装后为 11 个新增技能目录/链接、`skills-lock.json`、`docs/SKILLS.md` 与本记录的未提交差异。
- 既有技能：14 个目录，均在 `.agents/skills/`，`.claude/skills/` 为相对符号链接入口。
- 当次 CLI：`skills` 1.7.4、Claude Code 2.1.310。
- 允许改动：`docs/tasks/install-stack-best-practice-skills.md`、`docs/SKILLS.md`、`.agents/skills/`、`.claude/skills/`、`skills-lock.json`；worktree 外临时快照只读。
- 主 checkout 只读，不修改、不提交。

### 本次安装范围（11 个，已安装）

来源按用户授权登记；以上游仓库当次可解析的技能名为准。

| 技能 | 来源 | 项目对应依赖 |
|---|---|---|
| `fastify-best-practices` | mcollina/skills | `fastify` 5.12.7 |
| `better-auth-best-practices` | better-auth/skills | `better-auth` 1.7.12 |
| `tanstack-query-best-practices` | deckardger/tanstack-agent-skills | `@tanstack/react-query` 5.104.5 |
| `router-core` | tanstack/router | `@tanstack/react-router` 1.170.46 |
| `react-router` | tanstack/router | `@tanstack/react-router` 1.170.46 |
| `router-query` | tanstack/router | `@tanstack/react-router` + `@tanstack/react-query` |
| `vitest` | antfu/skills | `vitest` |
| `vite` | antfu/skills | `vite` |
| `pnpm` | antfu/skills | `packageManager: pnpm@12.15.0` |
| `drizzle-orm-patterns` | giuseppe-trisciuoglio/developer-kit | `drizzle-orm` |
| `react-hook-form` | pproenca/dot-skills | `react-hook-form` 7.91.0 |

### 00 快照位置（既有 14 技能的比对基线）

- 临时快照根目录：`/tmp/install-stack-skills-baseline.KhT4YF`（worktree 外，系统临时目录）
- `skills-lock.json` 副本：`/tmp/install-stack-skills-baseline.KhT4YF/skills-lock.json`
- shadcn 完整适配目录：`/tmp/install-stack-skills-baseline.KhT4YF/skills/shadcn`（21 个文件）
- openui 完整适配目录：`/tmp/install-stack-skills-baseline.KhT4YF/skills/openui`（15 个文件）
- 14 技能全部文件 SHA256 清单：`/tmp/install-stack-skills-baseline.KhT4YF/manifests/existing-14-skills.sha256`（188 条，绝对路径）
- `.claude/skills` 符号链接清单：`/tmp/install-stack-skills-baseline.KhT4YF/manifests/claude-skills-symlinks.txt`
- 快照文件总数：39（lock 1 + shadcn 21 + openui 15 + 清单 2）

快照自身 SHA256：`skills-lock.json` `07d42bb08da29155cbaaad35e93d02e22e676f5fc50efa5a1d70e0f4472bf112`；清单 `640609eb5733c5a9d3e7ed96d7606a5ea928820c53acf981407bb03cf4c697b7`、`c38cf4276c7d9a599f04a125332db000cea3fa5e82c98cf6ad05423f517034e9`。

## 当前有效决定

- 用户已授权安装上述 11 个技能，安装范围以 §「本次安装范围」为准。
- `test-driven-development` 在 `docs/SKILLS.md` 描述修正为框架无关 TDD，不再写成 Vitest 专用。
- 既有 shadcn / openui 项目适配规则保持不变；新增技能适配已补齐：9 个技能在 `SKILL.md` 顶部加 `Project convention`，`router-core` 的 `data-loading/SKILL.md`、`ssr/SKILL.md` 另改本地路径引用；`vite`、`pnpm` 未改动，`references/` 维持上游原样，lock 保留上游 hash。
- 安装代理装完后多跑了一次原生 `skills update`，输出 `All project skills are up to date`，无文件变动；本任务不再跑 `update`。
- `better-auth-best-practices` 按上游 <https://www.better-auth.com/docs/ai-resources/skills> 发布的安装命令本地安装；上游仓库无 LICENSE 文件，此处只登记本地安装与来源事实。
- 用户已授权 commit / push / PR / merge；本次授权提交 PR 合并，结果以 PR 合并状态为准。
- 主 checkout 只读；临时快照只读，不在其中执行下载或脚本。

## 审查修复与第二轮复核

第一轮独立 Opus 审查确认 2 处 `Project convention` 内容错误。本轮只修这两处，未改 `skills-lock.json`、其他技能与 `docs/SKILLS.md`：

1. `router-query/SKILL.md`：原适配声称本地 TanStack Query 5.104.5 不支持 `queryClient.query(...)` 与 `staleTime: 'static'`，并强制改用 `ensureQueryData` / `fetchQuery` / `prefetchQuery`。Opus 核对官方 `5.104.5/src/types.ts` 与 `queryClient.ts` 后确认这些 API 实际可用，且 `fetchQuery` / `ensureQueryData` 已弃用。已删除该错误否定与强制旧 API，只保留复用现有 `queryClient`、client-only Vite SPA（跳过 SSR / Start）、loader 使用 Query 时设 `defaultPreloadStaleTime: 0` 的约束，不新增版本推断。
2. `drizzle-orm-patterns/SKILL.md`：原适配把「全主键必须是 TypeID、禁用 `uuid`」写成全表规则。已改为「常规业务实体」主键用 `newId(entity)` TypeID；认证、关联表、幂等键等按 `docs/PROJECT-BRIEF.md#162-id-约定` 处理；保留本地 lock 版本（Drizzle ORM 0.45.4 / Drizzle Kit 0.31.11）与 `pnpm db:generate` + `pnpm db:migrate` 迁移要求。

同步更新 `/tmp/skill-adapt.bLvKKY/after/` 两份产物、对应 `diffs/*.patch` 与 `adaptation-manifest.json` 中这两条适配说明；`before/` 原版未改。修复后格式、上游完整性、最终集合与 Claude 启动发现复验通过；独立 Opus 第二轮定点复核通过，无新增阻断。

## 已替代项及原因

无。

## 步骤

- [x] 读 `docs/PITFALLS.md`、`docs/SKILLS.md`、`docs/DEV-WORKFLOW.md`
- [x] 记录 HEAD、`main`、`origin/main`、`git status` 基线；安装前重新 fetch `origin/main` 仍为 `efcf71c`
- [x] 核对当次 CLI：`skills` 1.7.4、Claude Code 2.1.310
- [x] 清点既有技能目录与 lock 条目（14 / 14）
- [x] 建 worktree 外临时快照，保存 lock、shadcn/openui 适配目录、14 技能 SHA256 清单（188 条）、符号链接清单
- [x] 校验快照：`diff -r` 适配目录无差异，SHA256 清单 188 行 = 技能文件数
- [x] `docs/SKILLS.md` 登记本次安装范围，修正 TDD 描述
- [x] 核对 11 个技能的上游来源与可解析技能名
- [x] 逐个安装 11 个技能（10 个走 `skills add`，Better Auth 单独安装）
- [x] 安装后本地结构核验：lock 25 条、11 个技能目录、11 个相对链接
- [x] 用 §00 快照比对既有 14 技能 188 个文件 SHA256 与 shadcn/openui 适配目录，旧 lock 条目未变
- [x] 上游最终核验：11/11 上游 hash 匹配、文件集合无缺失（新增 174 个文件）；仅 `Project convention` 与 router 本地路径差异，`vite`/`pnpm` 未改
- [x] 新增技能 `Project convention` 适配：9 个技能、11 个文件（含 Better Auth；`router-core` 两个子文档另改本地路径引用）
- [x] 新技能并入 `docs/SKILLS.md` 主表，补维护契约分组与验证结果
- [x] Claude 实际加载验证：init 含 11 个新技能、缺失 0（发现范围，不执行技能）
- [x] 第一轮 Opus 审查确认 2 处适配错误并修复：`router-query` 的错误 API 否定、`drizzle-orm-patterns` 的全表主键规则
- [x] 独立 Opus 第二轮复核通过，两项阻断已解除

## 改动文件

- `docs/tasks/install-stack-best-practice-skills.md`（本记录）
- `docs/SKILLS.md`（11 个技能并入主表、维护契约分组、TDD 描述修正）
- `.agents/skills/`（11 个新增技能目录）
- `.claude/skills/`（11 个相对链接）
- `skills-lock.json`（新增 11 条，共 25 条；既有 14 条不变）

第一轮审查修复另改 `.agents/skills/router-query/SKILL.md`、`.agents/skills/drizzle-orm-patterns/SKILL.md`；lock、其他技能与 `docs/SKILLS.md` 未改。

## 下一步

无待执行项。用户已授权 commit / push / PR / merge；本次授权提交 PR 合并，结果以 PR 合并状态为准。

## 验证

基线（安装前，只读）：

| 命令 | 结果 |
|---|---|
| `/usr/bin/git rev-parse HEAD` | `efcf71c802560b472a96ad54a472e088cd4c8738` |
| `/usr/bin/git rev-parse origin/main` | `efcf71c802560b472a96ad54a472e088cd4c8738` |
| `/usr/bin/git rev-parse main` | `797edfeaabd39b040d01736c49273da18347ea92` |
| `/usr/bin/git fetch origin main` | 无新提交，`origin/main` 不变 |
| `git status --short --branch` | 仅本记录为未跟踪新增 |
| `npx --yes skills@latest --version` | `1.7.4` |
| `claude --version` | `2.1.310 (Claude Code)` |
| `find .agents/skills -type f \| wc -l` | `188` |
| `skills-lock.json` 条目数 | 14，与技能目录数一致 |
| `.claude/skills` 链接 | 14 个相对链接，均指向 `../../.agents/skills/<name>` |
| `diff -r .agents/skills/shadcn <snapshot>/skills/shadcn` | 无输出（一致，21 个文件） |
| `diff -r .agents/skills/openui <snapshot>/skills/openui` | 无输出（一致，15 个文件） |
| `wc -l manifests/existing-14-skills.sha256` | `188`，与技能文件总数一致 |

安装后证据：

| 项目 | 结果 |
|---|---|
| 安装 | 10 个技能走 `skills add` 均 `Installed`；Better Auth 单独安装 `Installed 1 skill`（日志：`/tmp/install-stack-skills-run.wscX59/logs/`、`/tmp/better-auth-skill-QeFxff/install.log`） |
| lock / 目录 / 链接 | lock 25 条、技能目录 25 个、`.claude/skills` 25 个相对链接 |
| 上游最终核验 | `node /tmp/skill-verify-script.rsM0hQ/verify_final.mjs`：11/11 上游 hash 匹配、文件集合无缺失、新增 174 个文件；RHF 的 `metadata.json` 按 CLI 未复制但参与上游 hash |
| 适配差异 | 仅 `Project convention` 与 router 本地路径；9 个技能 / 11 个文件（含 Better Auth），`vite` / `pnpm` 无改动；`router-core` 的 `data-loading/SKILL.md`、`ssr/SKILL.md` 也改了引用 |
| Better Auth 证据 | 原版与 diff：`/tmp/better-auth-skill-QeFxff/better-auth-best-practices.orig/SKILL.md`、`project-convention.diff`；其余适配证据在 `/tmp/skill-adapt.bLvKKY` |
| 最终集合核验 | `node /tmp/stack-skills-final-verification.Ld4A5p/check.mjs <worktree> /tmp/install-stack-skills-baseline.KhT4YF`：lock / 目录 / 相对链接 / CLI / 文档均 25，旧文件 188 未变、旧 lock 14 未变 |
| shadcn 适配 | `pnpm dlx shadcn@latest info --json -c packages/web` 退出 0，路径在本 worktree |
| Claude 实际加载 | `node /tmp/skill-load-verify.JbSdHZ/verify.mjs /tmp/stack-skills-final-verification.Ld4A5p`：init 含 11 个新技能、缺失 0；42 = 25 项目 + 17 内置；取得 init 后主动终止（exit 143）。验证范围是技能发现，不执行技能 |
| 格式检查 | `git diff --check` 通过（第一轮修复后重跑，退出 0） |
| 上游完整性（修复后） | `node /tmp/skill-verify-script.rsM0hQ/verify_final.mjs`：`RESULT: PASS`，11/11 上游 hash 与 lock 匹配、无文件缺失；`contentDiff` 仍仅为既有适配文件（`router-core` 3 个、其余 8 个技能各 `SKILL.md`，`vite` / `pnpm` 无差异），无新增差异类型 |
| 独立 Opus 审查 | 第一轮两项错误已修复；第二轮定点复核通过，无新增阻断 |

以上 `/tmp` 路径为当次验证证据，不作为仓库内持久脚本。

未执行：修改既有 14 个技能、依赖安装、测试、全局扫描。
