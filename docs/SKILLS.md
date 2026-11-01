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
| `test-driven-development` | obra/superpowers | 按需参考的红绿步骤：先写失败测试 → 最小实现 → 重构；Vitest 为项目默认执行器，不替代 `ub-mode` |
| `verification-before-completion` | obra/superpowers | 交付前先跑验证命令并看真实输出，再声明完成 / 修复 / 通过 |
| `shadcn` | shadcn-ui/ui | 组件库（本项目唯一 UI 组件来源） |
| `migrate-radix-to-base` | shadcn-ui/ui | Radix 组件迁移到 Base UI（交互原语已统一 Base UI） |
| `tailwind-design-system` | wshobson/agents | Tailwind 4 token 与设计系统 |
| `animate` | emilkowalski/skills | 从零构建动效：动画决策顺序与实现（Motion/CSS） |
| `animation-performance` | emilkowalski/skills | 动效掉帧定位与合成层性能 |
| `animation-vocabulary` | emilkowalski/skills | 动效术语反查与命名 |
| `apple-design` | emilkowalski/skills | Apple 交互、弹性动效与手势原则（桌面 Web 范围内） |
| `ask-sonner` | emilkowalski/skills | Sonner toast 用法与排障（复用现有 Toaster） |
| `break-ui` | emilkowalski/skills | 极值数据压力测试与破坏点报告（桌面） |
| `emil-design-eng` | emilkowalski/skills | UI 打磨与动效审美原则 |
| `find-animation-opportunities` | emilkowalski/skills | 只读发现应加动效的位置 |
| `improve-animations` | emilkowalski/skills | 动效审计与实施计划（写入 `docs/tasks/`） |
| `pick-ui-library` | emilkowalski/skills | 前端库选型（遵守项目能力选型顺序） |
| `prototype` | emilkowalski/skills | 多方案 UI 原型与可视化挑选 |
| `remove-animations` | emilkowalski/skills | 删除无必要动效 |
| `review-animations` | emilkowalski/skills | 动效代码评审（以 DESIGN-SYSTEM 为基线） |
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
| `docker-build-strategies` | docker/skills | Dockerfile 多阶段、缓存、非 root 与镜像瘦身；对应根 `Dockerfile` 与沙盒镜像 |
| `docker-compose-patterns` | docker/skills | Compose 服务编排、健康检查、卷与网络；对应现有 `docker-compose.yml` |
| `mcp-builder` | anthropics/skills | MCP server 工具设计与契约；对应现有 Fastify `/mcp/:serverId` |
| `vercel-composition-patterns` | vercel-labs/agent-skills | React 组合模式；对应 web 的 shadcn/Base UI 组件边界 |
| `zustand-5` | prowler-cloud/prowler | Zustand 5 共享客户端交互状态；对应现有 `chat-store` 的流式展示与草稿 |
| `effect-ts` | effect-ts/skills | Effect 4 任务内副作用、取消/超时/资源释放与类型化错误 |
| `getting-started` | tanstack/table | TanStack Table v9 React 入口；包内配套 table-state、feature 与迁移技能 |
| `ub-mode` | unclebob/ub-mode | 默认日常工程纪律：First Make it Work → Then Make it Right → Follow Practice；编排与并行仍归 pstack |
| `unslop` | heydamir/unslop | AI 生成感 UI 的诊断与九轮打磨（React/Tailwind，桌面浅色）；接在 DESIGN-SYSTEM 与 shadcn/Base UI 之上 |

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
- 需与上游对齐时定向重装：`npx --yes skills@latest add <repo> --skill <name> --agent claude-code --agent universal -y`。两个 agent 缺一不可（只给 `claude-code` 会退化成 copy 模式，canonical 不更新、入口变成真实目录）。整目录替换；`.git`、`__pycache__`、`__pypackages__` 不复制，`metadata.json` 是否复制按当次 CLI 实物核对（CLI 1.7.4 本次 `vercel-composition-patterns` 已实际复制）；重装前保留差异证据，装后逐项补回项目适配。
- 确凿的上游整技能删除才执行 `npx --yes skills@latest remove <name> -y`，并清理 lock、链接与文档；网络或鉴权失败不等于删除。上游只删单文件时，同步删除本地对应文件。
- lock 存的是上游 hash，不是带项目适配的本地内容 hash；不要为了“匹配”改 lock。CLI 1.7.4 实测：上游目录 hash 包含 `metadata.json`，安装时是否复制该文件按当次实物（本次 `vercel-composition-patterns` 已复制，docker 两项与 `mcp-builder` 未复制），因此核验以当次安装出的目录为准：有该文件时连同比对，没有时排除后比对，不按固定假设判断。

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

新增技能的适配以 `SKILL.md` 顶部一段 `Project convention` 为主，`references/` 与其余文件维持上游原样；例外是 `router-core` 的 `data-loading/SKILL.md`、`ssr/SKILL.md` 也改了本地路径引用。`vite`、`pnpm` 未改动；`skills-lock.json` 的 `computedHash` 保留上游 CLI 值。升级或重装后按本组规则补回适配，再跑「完成核验」。本组实际适配范围以各 `SKILL.md` 的 `Project convention` 为准，不在本文写死数量。

- **Fastify**：保持本项目入口约定——`typed(rawApp)` 类型化实例、Zod `schema` 校验、handler 直接读 `request.body`、统一 `INVALID_INPUT` 错误映射、`/api/*` 默认 `requireAuth`；认证走 Better Auth + Drizzle/PostgreSQL，不引入 JWT 或 TypeBox 层。
- **Better Auth / Drizzle**：认证实现以 `packages/api/src/features/auth` 为准；Drizzle 按本地 lock 锁定版本与 `packages/db/src/schema.ts` 现行写法。常规业务实体主键用应用层 `newId(entity)` TypeID；认证、关联表、幂等派生标识、外部资源等按 `docs/PROJECT-BRIEF.md` §「ID 约定」的例外处理；不采用上游 `serial`/数据库生成 ID 示例。迁移只走 `pnpm db:generate` + `pnpm db:migrate`。
- **React Hook Form**：沿用现有 `useZodForm` 与 `components/ui/` 的 Base UI/shadcn 控件，不引入 Radix 或 MUI；示例按本地 lock 版本核对。
- **Router / Query**：对准现有 React + Vite SPA 入口（`packages/web/src/router.tsx`、`routes/`、`lib/queries.ts`），示例中的包标识与跨技能链接用本地路径修正，不引入 TanStack Start/SSR 或额外依赖；版本差异按 lock。
- **Vitest**：技能文本可能来自高于 lock 的版本，使用前核对已安装版本，不为示例升级依赖；测试仍走根 `vitest.config.ts` 的 `backend`/`web` projects。

安装依据与许可：`better-auth-best-practices` 按上游 <https://www.better-auth.com/docs/ai-resources/skills> 发布的安装命令装入；上游仓库未提供 LICENSE 文件，此处只登记本地安装与来源事实。

### Docker / MCP / React 组合（首批 4 个）

`docker-build-strategies`、`docker-compose-patterns`、`mcp-builder`、`vercel-composition-patterns` 只在 `SKILL.md` 顶部各加一段中文 `Project convention`，`references/`、`scripts/` 等其余文件保持上游原样；`skills-lock.json` 的 `computedHash` 保留上游 CLI 值。约定只写项目关键边界与上游明确冲突，按任务实际需求做最小完整改动，不把当前文件细节固化为不可变架构。

- **Docker**：沿用 pnpm 与既有构建层/沙盒边界；`docker-compose.yml` 文件名和现有服务沿用；多 worktree 共享基础设施；按需增改服务/网络，不无故新增，也不禁止有明确需求的功能；技能脚本可按内容与当次授权使用。
- **MCP**：沿用现有 Fastify `/mcp/:serverId`、`@modelcontextprotocol/node` 2.1.2、`@modelcontextprotocol/server` 2.4.0、shared/core 契约、鉴权、错误形状与返回格式，不另起部署、鉴权或校验层。
- **React 组合**：沿用 React 19 + Vite SPA 的既定设计栈、各类状态职责与真实复杂度门槛，不按上游重写现有封装或视觉。
- **许可**：docker 两项补了上游根 `LICENSE`（Apache-2.0）；`mcp-builder` 随技能目录带 `LICENSE.txt`（Apache-2.0）；`vercel-composition-patterns` 上游无 LICENSE 文件，`SKILL.md` 声明 MIT，只登记来源事实。
- 升级或重装后补回上述 `Project convention`；`metadata.json` 等文件是否由 CLI 复制按当次实物核对，`computedHash` 不改。

### Zustand / Effect / TanStack Table（2026-10-31）

三个技能均由固定 commit 的原始 URL 直接安装（CLI 1.7.4，参数 `--agent claude-code --agent universal -y`），canonical 目录在 `.agents/skills/`、`.claude/skills/` 为同相对链接；`skills-lock.json` 的 `computedHash` 保留 CLI 上游值。

| 技能 | 上游 | 固定 commit | 许可 |
|---|---|---|---|
| `zustand-5` | `prowler-cloud/prowler` | `67aa9410127c7228fed304f3333b271808ba0c8d` | Apache-2.0（上游根 `LICENSE`，已补入技能目录） |
| `effect-ts` | `effect-ts/skills` | `155c50c911f9c99c294ef8a4461981c5bbe6453e` | MIT（上游根 `LICENSE`，已补入技能目录） |
| `getting-started` | `tanstack/table` | `c14e0221b1e656c7bb35e7b3d4cdf188719a3599` | MIT（上游根 `LICENSE`，已补入技能目录） |

- **Zustand**：`SKILL.md` 顶部加一段 `Project convention`；因技能只作只读指导，移除上游 frontmatter 的 `allowed-tools` 预授权行，避免激活时预授权写文件、执行命令与派子代理，其余 frontmatter、正文与其余文件保持上游原样。约定：只用于跨组件、非服务端的共享客户端交互状态，按业务域复用 `packages/web/src/lib/chat-store.ts`（流式展示投影、未发送草稿生命周期），不按页面并排新建 store；原子 selector、组合对象/数组用 `useShallow` 保持引用稳定、不整 store 订阅、更新保持不可变；服务端状态用 Query，可导航状态用 Router，平台资源编辑表单用 RHF/`useZodForm`，生成式表单走 OpenUI 官方运行时，组件私有临时状态留本地。上游直连 `fetch` 示例只作 store 写法参考，不另造服务端 cache；不引入 Immer、SSR 或新持久化层。版本以 lock 与已安装 `zustand@5.0.16` 为准。
- **Effect**：同样只加 `Project convention` 与上游根 `LICENSE`。约定：已锁 `effect@4.1.1`，`packages/api`、`packages/core`、`packages/worker` 已有依赖，跳过上游 Step 1，不安装 latest、不加根开发依赖；写 Effect 前完整读 `packages/core/node_modules/effect/AGENTS.md`（root `node_modules/effect` 不存在），按需查同目录 `src`；Effect 只负责任务内取消、超时、资源释放、并发与类型化错误，共用 Promise 边界与错误分类走 `packages/core/src/effect-runtime.ts`；Fastify 管 HTTP、BullMQ 管分发重试、SessionSandboxes 管沙盒，Claude Agent SDK 是唯一 AI 底座；不新增服务层适配器或第二套编排。
- **TanStack Table**：`description` 收窄为 TanStack Table v9 React（创建、状态、feature 排障、v8→v9 迁移），避免泛化触发；`SKILL.md` 加 `Project convention` 并补上游根 `LICENSE`。只安装 React 入口 `getting-started`，其余官方技能直接读已安装 npm 包，不安装 `intent`、不新增依赖。包内映射：React 技能根 `packages/web/node_modules/@tanstack/react-table/skills/`（`getting-started`、`table-state`、`migrate-v8-to-v9`）；core 技能为解析该路径真实目录后同层 `../table-core`（不假定 web `node_modules` 直接可达，不硬编码 `.pnpm` 版本），含 `core`、`table-state`、`table-features`、`custom-features`、`migrate-v8-to-v9`。路径适配仅限：所有 `intent load` 改为直接读包内文件；`SKILL.md` 的 `../table-state`、`../migrate-v8-to-v9` 与 `references/{create-table-hook,with-tanstack-query,with-tanstack-virtual}.md` 的 `../../table-state` 改为 React 包内真实路径；其余正文与 references 保持上游原样。约定还要求复用现有 `data-table.tsx`、shadcn/Base UI 与设计系统，Query/Router/Table own state/Zustand 按单一 owner 分工，`@tanstack/react-store` 是 Table 内部订阅机制，不引入 Virtual 或其他依赖。
- 升级或重装后按上述范围补回；`computedHash` 不改。

### emilkowalski/skills（桌面 Web 动效与设计工程）

上游 `emilkowalski/skills`（MIT，Copyright (c) 2026 Emil Kowalski）本次安装其中的桌面 Web 技能，排除 `animate-expo`、`write-swift`、`mobile-native`（与本项目栈不符）。上游根目录有 `LICENSE`，但 CLI 安装只复制技能目录内容，因此每个新技能目录补了一份上游 `LICENSE`；`SKILL.md` 其余内容与关联引用文件保持上游原样，`skills-lock.json` 的 `computedHash` 保留上游 CLI 值。

每个 `SKILL.md` 只在 frontmatter 后加一段中文 `Project convention`（原 `name`/`description` 不变），共同约定：仅桌面 Web；复用 shadcn/ui、Base UI、Tailwind 4 `@theme` token 与 Motion；视觉和动效数值以 `docs/DESIGN-SYSTEM.md` 为准；不换栈、不新增重复依赖。技能特有约定：

- `animate`：键盘、高频交互与既定动效按项目规范处理，保留 hover/focus 同等反馈，不套用上游一律禁止的规则。
- `improve-animations`：计划写入 `docs/tasks/`，不建 `plans/`；审计与计划的范围、属性、数值及 reduced-motion 以 `docs/DESIGN-SYSTEM.md` 为准，上游硬性要求与已定项目动效冲突时以项目为准。
- `remove-animations`：依赖清理按当次授权执行，确认零引用后直接清理，不重复确认。
- `prototype`：picker 交互照 PICKER.md，视觉控件用项目组件与 token。
- `break-ui`：只验证桌面容器宽度、200% 缩放、键盘与长内容/极值，不强制移动端、未支持主题或 RTL。
- `pick-ui-library`：遵守现有 → 原生/已装 → 开源 → 自研，不因清单换栈。
- `ask-sonner`：复用 `packages/web/src/App.tsx` 已挂载的唯一 Toaster。

升级或重装（`add`/`update`）后需补回上述 Project convention 与各目录 `LICENSE`（CLI 不会带上这两项），再跑「完成核验」。

### ub-mode（原样安装）

`ub-mode` 的 `SKILL.md` 与 `README.md` 保持上游原版，无本地适配；更新或重装后核对与上游逐字节一致
（`diff -r --exclude=.git <上游快照> .agents/skills/ub-mode`）。上游 README 提到的 crapper / dryer /
mutator / uml-viewer 配套工具本次未安装。上游仓库无 LICENSE 文件，此处只登记来源与安装事实。

职责分工（用户 2026-10-28 决定，流程细节以 `docs/DEV-WORKFLOW.md` 为准，不在此复制）：

- `ub-mode`：默认日常工程纪律，阶段固定为 First Make it Work → Then Make it Right → Follow Practice（先实现目标功能 → 再完善设计与实现 → 遵循工作纪律）；随手可用，不要求 `/ub-mode`。
- `pstack`：模型选择、任务编排、并行拆分与独立 review；不承担工程纪律本身。
- `test-driven-development`：按需参考红绿步骤，不是硬性门禁。
- `verification-before-completion`：交付前跑验证、看真实输出再声明完成。

### unslop（2026-11-01）

上游 `heydamir/unslop` 许可 CC-BY-4.0，`SKILL.md` 顶部原有署名段落保留。本地只在 `SKILL.md` frontmatter 之后补一段中文 `Project convention`（桌面浅色、shadcn/Base UI + Tailwind 4 `@theme`、以 `docs/DESIGN-SYSTEM.md` 为准；只诊断与打磨，不换栈、不改布局契约），`references/`、`scripts/` 保持上游原样；CLI 不带上游根 `LICENSE`，已从上游补入技能目录。
`skills-lock.json` 的 `computedHash` 保留上游 CLI 值。升级或重装后需补回 Project convention 与 `LICENSE`，再跑「完成核验」。

## 插件更新

- 先 `claude plugin marketplace update <marketplace>` 刷新目录（只刷新 catalog），再逐插件 `claude plugin update <id> --scope <scope> --json`。
- 保持原 marketplace 发布 pin，不绕过或改指其他来源；同版本号可能不替换文件，必须对比安装缓存与发布来源。
- 不卸载重装，不删除 runtime、历史缓存或插件持久数据。
- 有实际差异未能解决时如实列为未完成，不写成已更新。

## 并发

- 只读核验（上游快照、目录比对、插件只读检查）可并行；`skills-lock.json` 写入与插件注册表写入串行。

## 完成核验

- 文件集合：lock 条目 = 技能目录 = 有效相对链接（指向当前 worktree）；`skills list` 与 lock、本文清单一致，无残留。
- 内容：逐文件与上游来源对比；只允许列明的项目适配与官方排除项不同（`metadata.json` 是否复制按当次安装实物确认），无多余或缺失文件。`openui` 只应有 `SKILL.md` 的两处适配。
- 适配：`pnpm dlx shadcn@latest info --json -c packages/web` 退出 0 且路径在当次 worktree；`openui` 的 `description` 与 Project convention 与本文一致。
- 插件：当次全部生效插件 `outcome: ok`、无失败；缓存与发布来源一致，无缺失的活动组件。
- 未解决差异与范围外问题如实列出。

## 交付

- 按 `docs/DEV-WORKFLOW.md` 交独立 Opus 审查；只有当次授权才 commit/push/merge。
- 报告：已更新 / 已最新 / 已删除 / 保留的适配 / 限制 / 是否合入 main / 是否需要重载会话。
