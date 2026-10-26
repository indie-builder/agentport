# 项目技能与插件维护

> 本文件是本项目技能与插件维护的唯一 SOP：已装技能清单、项目适配、更新与删除流程。
> 技能装在 `.agents/skills/`，Claude Code 经 `.claude/skills/` 相对符号链接读取，版本锁定在 `skills-lock.json`。命令均在仓库或当前 worktree 根执行。

## 清单

| 技能 | 来源 | 对应项目技术栈 |
|---|---|---|
| `frontend-design` | anthropics/skills | 整体 UI 方向与排版 |
| `api-and-interface-design` | addyosmani/agent-skills | REST 接口契约、TypeScript 类型边界与错误语义 |
| `cli-interface-design` | samber/developer-platform-skills | 在 API 之上设计 CLI：命令分层、`--json`/退出码冻结契约、agent 友好 |
| `public-api-design-review` | samber/developer-platform-skills | REST 面检查表：命名、方法/状态码、分页、错误信封、Hyrum's Law 兼容 |
| `api-error-design` | samber/developer-platform-skills | 错误码 taxonomy、RFC 9457 problem-details、retryable 信号 |
| `api-integration-surface-strategy` | samber/developer-platform-skills | 按回滚成本与受众排序 REST/CLI/SDK/MCP 等各集成面的建设顺序 |
| `vercel-react-best-practices` | vercel-labs/agent-skills | React 19 组件与性能 |
| `supabase-postgres-best-practices` | supabase/agent-skills | PostgreSQL 18 查询、索引、RLS |
| `test-driven-development` | obra/superpowers | 框架无关的 TDD：先写测试看失败，再写最小实现（Vitest 只是项目默认执行器） |
| `verification-before-completion` | obra/superpowers | 交付前的验证纪律 |
| `shadcn` | shadcn-ui/ui | 组件库（本项目唯一 UI 组件来源） |
| `migrate-radix-to-base` | shadcn-ui/ui | Radix 组件迁移到 Base UI（交互原语已统一 Base UI） |
| `tailwind-design-system` | wshobson/agents | Tailwind 4 token 与设计系统 |
| `openui` | thesysdev/skills | 明确涉及 OpenUI / OpenUI Lang / `@openuidev/*` / Gateway / Autofix / CLI 的生成式 UI 任务；不用于普通 chat/dashboard，也不替代本项目 UI 实现 |
| `fastify-best-practices` | mcollina/skills | Fastify 5 路由、schema 校验、插件与生命周期 |
| `better-auth-best-practices` | better-auth/skills | Better Auth 会话、插件与鉴权配置 |
| `tanstack-query-best-practices` | deckardger/tanstack-agent-skills | TanStack Query 5 数据获取与缓存 |
| `router-core` | tanstack/router | TanStack Router 核心：路由树、类型安全导航 |
| `react-router` | tanstack/router | TanStack Router 的 React 绑定与组件用法 |
| `router-query` | tanstack/router | TanStack Router 与 Query 的集成（loader、预取） |
| `vitest` | antfu/skills | Vitest 配置、断言与测试组织 |
| `vite` | antfu/skills | Vite 配置、插件与构建 |
| `pnpm` | antfu/skills | pnpm workspace 与依赖管理 |
| `drizzle-orm-patterns` | giuseppe-trisciuoglio/developer-kit | Drizzle ORM schema、查询与迁移模式 |
| `react-hook-form` | pproenca/dot-skills | React Hook Form 表单状态与校验 |

## 范围

- 技能：`.agents/skills/`、`.claude/skills/`、`skills-lock.json`；同步 `docs/SKILLS.md` 与任务记录。
- 插件：只处理本项目实际生效或继承的插件（以当次 `claude plugin list` 或插件配置为准），排除禁用项与其他项目专属项。
- user scope 插件更新会同时影响其他项目：按当次请求和既有明确授权确定范围，已覆盖的操作不重复确认，交付中说明该跨项目影响。
- 技能与插件数量以当次 CLI 发现结果为准，不在文档或命令里写死条目数。
- 不安装与项目栈冲突的技能（例如 Playwright 类；本项目 E2E 已统一为 `e2e`）。

## 开始前

1. 读 `docs/DEV-WORKFLOW.md`、`docs/PITFALLS.md`，进入 worktree 并记录基线；先写 `docs/tasks/<slug>.md`。
2. 核对当次 CLI 版本与帮助：`npx --yes skills@latest --version`/`--help`、`claude --version`、`claude plugin update --help`、`claude plugin marketplace update --help`；插件行为以 <https://code.claude.com/docs/en/discover-plugins>、<https://code.claude.com/docs/en/plugins/loading.md> 为准。
3. 记录现状：lock 中的来源、上游 hash、技能目录与链接、本地已有差异；插件 id、scope、版本与发布 pin。
4. 保存差异证据与可恢复的项目适配补丁（含 shadcn / openui 规则），路径记入任务记录，完成后才能执行 `update`/`add`/`remove`。`git diff` 不够——适配已在 HEAD，须比本地与旧上游；旧上游不可得时保存完整适配文件及规则。三方比对确认差异是适配还是漂移后再动，不得直接覆盖。

## 技能更新

- 先跑原生 `npx --yes skills@latest update --project --yes`（CLI 1.7.4 实测，后续按当次核对）：只比较上游 hash 与 lock，非交互不删技能；输出 up to date 不代表本地与上游一致，必须再核验完整目录。
- 无新版且本地无文件变化时不重装。
- 需与上游对齐时定向重装：`npx --yes skills@latest add <repo> --skill <name> --agent claude-code --agent universal -y`。两个 agent 缺一不可（只给 `claude-code` 会退化成 copy 模式，canonical 不更新、入口变成真实目录）。整目录替换，只排除 `metadata.json`、`.git`、`__pycache__`、`__pypackages__`；重装前保留差异证据，装后逐项补回项目适配。
- 确凿的上游整技能删除才执行 `npx --yes skills@latest remove <name> -y`，并清理 lock、链接与文档；网络或鉴权失败不等于删除。上游只删单文件时，同步删除本地对应文件。
- lock 存的是上游 hash，不是带项目适配的本地内容 hash；不要为了“匹配”改 lock。

## 项目适配（必须保留）

### shadcn

- 一律 `pnpm dlx`；项目内命令从当前 worktree 根加 `-c packages/web`（`info`、`docs`、`add`、`search`、`view`、`apply`、已有项目的 `init`、`preset resolve`），相对路径保证不出 worktree。
- `preset decode`、`preset url`、`preset open` 不接受 cwd，不加 `-c`；新建项目用其实际新目录。
- 所有更新（`add`/`update`，含整目录替换）完成后都要补回本节规则。历史背景见 `docs/tasks/shadcn-worktree-context.md`，执行规则以技能内 Project convention 为准。
- 实物验证：适配补回后运行 `pnpm dlx shadcn@latest info --json -c packages/web`，须退出 0 且返回路径位于当前 worktree 的 `packages/web`；只改文字不算完成。

### openui

`openui` 只对 `SKILL.md` 做两处适配，`references/` 与其余文件保持上游原样；`skills-lock.json` 的 `computedHash` 保留上游 CLI 值。

- `description` 收窄：仅用于明确涉及 OpenUI、OpenUI Lang、`@openuidev/*` 包、OpenUI Gateway、Autofix、`@openuidev/cli` 的任务；不用于普通 chat / agent / dashboard 需求，也不用于只借 openui.com 做视觉参考的场景。
- 正文 Project convention：UI 一律 shadcn/Base UI、Tailwind 4 现有 `@theme` token 与 `docs/DESIGN-SYSTEM.md`，不新建 app；运行底座只有 Claude Agent SDK，不默认切换 Gateway / OpenAI / LangGraph，也不引入外部存储或部署。
- 更新（`add`/`update`）后同样要补回这两处；以本地版与上游 `SKILL.md` 的差异为准，适配副本路径记入当次任务记录。

### 技术栈最佳实践技能

新增技能的适配以 `SKILL.md` 顶部一段 `Project convention` 为主，`references/` 与其余文件维持上游原样；例外是 `router-core` 的 `data-loading/SKILL.md`、`ssr/SKILL.md` 也改了本地路径引用。11 个技能中 9 个有适配（合计 11 个文件，含 Better Auth），`vite`、`pnpm` 未改动；`skills-lock.json` 的 `computedHash` 保留上游 CLI 值。升级或重装后按本组规则补回适配，再跑「完成核验」。

- **Fastify**：保持本项目入口约定——`typed(rawApp)` 类型化实例、Zod `schema` 校验、handler 直接读 `request.body`、统一 `INVALID_INPUT` 错误映射、`/api/*` 默认 `requireAuth`；认证走 Better Auth + Drizzle/PostgreSQL，不引入 JWT 或 TypeBox 层。
- **Better Auth / Drizzle**：认证实现以 `packages/api/src/features/auth` 为准；Drizzle 按本地 lock 锁定版本与 `packages/db/src/schema.ts` 现行写法。常规业务实体主键用应用层 `newId(entity)` TypeID；认证、关联表、幂等派生标识、外部资源等按 `docs/PROJECT-BRIEF.md` §「ID 约定」的例外处理；不采用上游 `serial`/数据库生成 ID 示例。迁移只走 `pnpm db:generate` + `pnpm db:migrate`。
- **React Hook Form**：沿用现有 `useZodForm` 与 `components/ui/` 的 Base UI/shadcn 控件，不引入 Radix 或 MUI；示例按本地 lock 版本核对。
- **Router / Query**：对准现有 React + Vite SPA 入口（`packages/web/src/router.tsx`、`routes/`、`lib/queries.ts`），示例中的包标识与跨技能链接用本地路径修正，不引入 TanStack Start/SSR 或额外依赖；版本差异按 lock。
- **Vitest**：技能文本可能来自高于 lock 的版本，使用前核对已安装版本，不为示例升级依赖；测试仍走根 `vitest.config.ts` 的 `backend`/`web` projects。

安装依据与许可：`better-auth-best-practices` 按上游 <https://www.better-auth.com/docs/ai-resources/skills> 发布的安装命令装入；上游仓库未提供 LICENSE 文件，此处只登记本地安装与来源事实。

## 插件更新

- 先 `claude plugin marketplace update <marketplace>` 刷新目录（只刷新 catalog），再逐插件 `claude plugin update <id> --scope <scope> --json`。
- 保持原 marketplace 发布 pin，不绕过或改指其他来源；同版本号可能不替换文件，必须对比安装缓存与发布来源。
- 不卸载重装，不删除 runtime、历史缓存或插件持久数据。
- 有实际差异未能解决时如实列为未完成，不写成已更新。

## 并发

- 只读核验（上游快照、目录比对、插件只读检查）可并行；`skills-lock.json` 写入与插件注册表写入串行。

## 完成核验

- 文件集合：lock 条目 = 技能目录 = 有效相对链接（指向当前 worktree）；`skills list` 与 lock、本文清单一致，无残留。
- 内容：逐文件与上游来源对比；只允许列明的项目适配与官方排除项不同（`metadata.json` 是否排除按当次 CLI 确认），无多余或缺失文件。`openui` 只应有 `SKILL.md` 的两处适配。
- 适配：`pnpm dlx shadcn@latest info --json -c packages/web` 退出 0 且路径在当次 worktree；`openui` 的 `description` 与 Project convention 与本文一致。
- 插件：当次全部生效插件 `outcome: ok`、无失败；缓存与发布来源一致，无缺失的活动组件。
- 未解决差异与范围外问题如实列出。

## 交付

- 按 `docs/DEV-WORKFLOW.md` 交独立 Opus 审查；只有当次授权才 commit/push/merge。
- 报告：已更新 / 已最新 / 已删除 / 保留的适配 / 限制 / 是否合入 main / 是否需要重载会话。
