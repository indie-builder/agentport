# 插件能力接入（Claude Code 原生插件）

## 目标

补齐产品缺失的插件能力：插件作为可复用资源被多个专家引用，运行时不重复下载，并按官方文件约定加载到 Claude Agent SDK。

验收：

- 管理员可导入插件 ZIP / 目录，查看组件清单（技能、子智能体、hooks、MCP）。
- 专家可绑定插件；同一插件被多个专家引用时只有一份存储。
- 运行时把插件渲染到 `.claude/plugins/<slug>/`，经 SDK `plugins` 加载。
- 插件技能、插件子智能体在主会话可用；hooks / MCP 默认关闭，需逐项授权。
- 插件加载失败不会被静默跳过，能出现在运行错误里。

## 方案

路线 A：**DB 持有制品，SDK 本地加载**。

- `plugins` + `plugin_files` 保存完整插件目录树（一份）。
- `agent_plugins` 是专家到插件的引用；复用 = 引用，不复制。
- 每次运行渲染到工作区 `.claude/plugins/<slug>/`，`.claude/plugins` 已在 `/workspace:ro` 挂载内，无需新挂载。
- runner 传 `plugins: [{ type: 'local', path }]`。

不采用原生 marketplace 缓存 + seed 的原因：SDK 只接受本地目录；本沙盒 `CLAUDE_CONFIG_DIR` 按会话挂载，marketplace 安装记录与 cache 不跨会话；同时维护 DB 与 CLI 两套真相源。

## 基线与范围

- 起始 commit：`da56577`（worktree `plugin-support`，工作区干净）。
- 允许改动：`packages/{shared,db,core,sandbox,worker,api,web}`、`docs/`、迁移文件。
- 不改：`.claude/settings.json` 之外的工作区生命周期、原生记忆、会话 transcript。

## 当前有效决定

用户 2026-10-25 确认「按建议来」，即：

1. 路线 A（DB 持有制品 + SDK 本地加载），不接 marketplace。
2. 插件默认只启用 skills / agents；hooks / MCP 默认关闭，逐项显式授权。
3. v1 产品入口为插件根目录内容的 ZIP 导入，不做市场搜索安装或本机任意目录挂载。
4. 平台子智能体不单独绑定插件（SDK 插件是会话级）；插件自带子智能体可按原生命名空间委派。
5. 同一插件多专家引用；v1 不做每专家锁版本，也没有替换同一插件文件的升级入口。

## 已替代项及原因

- 「管理页用 `claude plugin` 装到共享缓存 + `CLAUDE_CODE_PLUGIN_SEED_DIR`」：被路线 A 替代。原因见上：两套真相源、CLI 不在 worker 镜像、project settings 的 `enabledPlugins` 不触发安装。
- 插件代码与持久数据分开：`${CLAUDE_PLUGIN_DATA}` 由 Claude Code 的插件根目录派生，与 SDK 是否就地加载无关。当前插件根默认随会话的 `CLAUDE_CONFIG_DIR` 挂载，未实现跨会话的专家级插件持久数据目录。

## 支持矩阵（v1）

| 组件 | 支持 | 说明 |
|---|---|---|
| skills | ✅ | 精确 `plugin:skill` 名进入 SDK `skills` 白名单 |
| agents | ✅ | 有插件子智能体时放行 `Agent` |
| commands | ✅ 原生 | 不提供平台命令菜单 |
| output styles | ✅ 原生 | 不提供平台选择入口 |
| hooks | ⚠️ 需显式授权 | 授权后随插件目录加载 |
| MCP servers | ⚠️ 需显式授权 | 授权后补 `mcp__plugin_<p>_<s>__*` 权限 |
| LSP / workflows / monitors / bin / themes | ❌ | 导入时拒绝或提示不支持 |
| `userConfig` / `channels` / `dependencies` | ❌ | 导入时拒绝 |

## 步骤

- [x] 任务记录与决策固化
- [x] DB：`plugins`、`plugin_files`、`agent_plugins` + 迁移 `0033`
- [x] shared：插件 schema、`pluginBindings`、sandbox 任务字段
- [x] core：`renderWorkspace` 输出插件树与插件技能名
- [x] sandbox：`plugins` 选项、技能白名单、MCP 权限、边界 hook、`plugin_errors` 回读
- [x] worker：查询绑定、写插件目录、传递任务字段
- [x] api：插件 CRUD / 导入导出 / 专家绑定 / 预览同源
- [x] web：插件资源页、导航、专家绑定与逐项授权
- [x] 文档：ARCHITECTURE 能力表、DECISIONS-PENDING

## 下一步

用户继续授权的运行验证已完成：插件技能及 references、插件自带子智能体、hooks / MCP 授权开启和关闭的端到端验证均有实测证据，详见 [结构化实测记录](plugin-support-runtime-verification.json)。用户已授权提交 PR 并合并；发布复审的创建、弹窗、嵌套 Agent 三项通过，最后的事务锁顺序也已获独立 Opus 明确通过结论，未发现剩余阻断项。下一步提交、创建 PR 并合并 main，不触发或等待 CI。

### 评审后修复（Opus 独立评审，结论原为不通过）

| 项 | 修复 |
|---|---|
| A1 manifest `settings` 可接管主会话 | 加入 `UNSUPPORTED_MANIFEST_KEYS`，导入即拒绝 |
| A2 `POST /api/plugins` 绕过导入校验 | 删除该路由；插件只能经 ZIP 导入（也解决了「新建空插件永不生效」） |
| A3 `agents/` 子目录漏判 | 正则改为 `^agents/.+\.md$` |
| B1 `scripts/` 被拒导致 hooks 不可用 | 加入 `ALLOWED_TOP_LEVEL` |
| B2 manifest `mcpServers` 数组写法被静默丢弃 | 明确拒绝而不是标 warning |
| B3 校验错误抛 500 | `safeParse` + `fail('INVALID_INPUT')`；querystring 用 `slugSchema` |
| B4 唯一约束冲突 500 | 导入与 PATCH 映射 `23505` → 409 |
| C1 子智能体仍可持有插件绑定 | 创建时拒绝；被选为子智能体时校验；预览按 `parentId` 过滤 |
| C2 插件 PATCH 乐观锁竞态 | 下沉到 SQL（`notStale` + `CONFLICT_STALE`） |
| D2 「新建插件」死路径 | 删除入口 |
| D3 原生 checkbox | 换 shadcn `Checkbox` |
| D4 死代码 | 删 `getPluginBySlug`/`setAgentPluginBindings`/`isPluginBoundByAgent`/`toPluginApi`/`agentPluginBindingSchema`/`pluginQuery`/`exportPlugin`/`createPlugin`/`features/plugins/index.ts`；删 `has_hooks/has_mcp/has_agents` 三列（重复真相源） |
| D5/D6/D7 | 简化 `toApi` 类型；同步 `chat.ts` 契约注释 |
| E1 专家包静默丢弃插件绑定 | 导出返回 warnings，经 `x-package-warnings` 响应头到页面 toast |
| E2 前端文件视图看不到插件 | `workspaceFilesSchema` 增加 `plugins`，文件视图新增「插件」分组 |
| E3 插件 API 零测试 | 新增 `packages/api/test/plugin-parse.test.ts`（9 条） |
| E5 空态无下一步 | 空态改为可点「导入插件」按钮 |

未采纳（记录原因）：
- A4/A5：插件子智能体与 `general-purpose` 不受「插件能力不下放」约束，是为官方别名行为留的缝；已在注释中写明范围。
- A6：MCP 授权是整插件粒度，与「逐项授权 hooks/MCP」的用户决定一致；不再拆到 per-server。
- E4：ZIP 顶层多一层目录未自动剥离；报错文案已直接提示「把插件根目录的内容打平到 ZIP 顶层」。
- E6：执行位仍按扩展名推断（已有 `shortcut:` 注释）。

## 验证

| 命令 / 操作 | 结果 |
|---|---|
| `pnpm --filter @agentport/{shared,db,core,worker,api,web} exec tsc -b`；`npx tsc -b packages/sandbox` | 全部 exit 0 |
| `vitest run packages/core/test packages/sandbox/test` | 17 files / 127 tests passed |
| `pnpm --filter @agentport/db migrate` | `migrations applied` |
| 真实 API 导入插件 ZIP（`POST /api/plugins/import?slug=demo-plugin`，agent 3311） | 201，capabilities 识别出 `skills:[review]`、`agents:[helper]` |
| 专家绑定（`PATCH /api/agents/:id` 带 pluginBindings） | 200，重新读取绑定一致 |
| 预览（`GET /api/agents/:id/files`） | 200，`plugins[0].files` 含 3 个插件文件，与运行同源 |
| DB → 运行时形态定点验证（真实 DB + `renderPlugin`） | `skills:["review"]`、`agents:true`、文件路径正确、未授权 MCP 为空 |
| 镜像内原生 CLI `plugin details`（`agentport/sandbox:plugin-dev`） | `demo-plugin@inline`，`Skills (1) review` / `Agents (1) helper` |
| 镜像内真实 runner 任务（带 `plugins` 字段） | 插件加载无 `plugin_errors`，仅在模型鉴权处失败（容器无凭据，属预期） |
| 修复后重跑：含 `scripts/` 的插件 ZIP 导入 | 201，capabilities 正确 |
| 修复后重跑：重复导入 / 非法 slug | 409 `CONFLICT` / 400（不再是 500） |
| 修复后重跑：绑定 + 预览 | 绑定含 `allowHooks:true`；预览含 4 个文件，`run.sh` 标记 `executable:true` |
| `packages/api/test/plugin-parse.test.ts` | 9 passed（不支持组件、危险 manifest 键、路径安全、命名空间、数组式 mcpServers） |
| 文件边界修复复核（仅 `memory-permissions.ts` 与测试） | Opus 结论通过；修正了测试中吞掉 ENOENT 的夹具，补真实 `private.md`、子智能体读取、符号链接和硬链接拒绝断言，18 项测试通过 |
| 本轮最终回归（文件边界、runner、子智能体边界、插件裁剪、真实 CLI 组件发现） | 5 个文件、45 项通过；有 runner 测试重复注册 SIGTERM listener 的警告，未将其视作端到端通过证据 |
| `biome check`（本次改动文件） | 无诊断 |

本期剩余运行项实测完成（2026-10-25）：

| 场景 | 运行与证据 | 结果 |
|---|---|---|
| 插件自带子智能体（hooks/MCP 关闭） | `run_01m5s79z3veh2v4hatk2j8vfh5`；`Agent` 入参 `subagent_type=vr581808-probe:echo`，子回复及主会话最终输出均为 fixture 固定标记，子 transcript 独立包含该标记 | 通过 |
| hooks/MCP 开启 | `run_01m5s7bhsseh2v4hdrwyhc69rz`；真实调用 `mcp__plugin_vr581808-probe_probe__probe` 并返回预期标记；通过 `/bin/sh` 和直接执行的两条 hooks 均在测试记忆目录写出文件；真实工作区只读挂载，脚本 0700 | 通过 |
| 撤销授权后的负向对照 | `run_01m5s7cqpweh2v4hgqdy65xk4g`；预览删除 hooks/MCP 配置，先删除的执行标记没有重建，记忆目录为空；该轮 transcript 不含此前存在的插件 MCP 工具 | 通过 |

三轮费用合计 $0.04643，均经 `/tmp/verify-worker.log` 的精确 runId 终态核对。固定标记、工具步骤及环境见 [实测报告](plugin-support-runtime-verification.json)。插件技能和 references 的正向真实模型验证此前已通过：`run_01m5s48chweh2v4h47sngjyqsv` 中 `Skill(demo-v2:review)` 成功，`Read` 返回 fixture 内容，最终回复与文件校验标记一致（约 8.4 秒、$0.0153804）。

本轮新建的专家、插件、工作区、临时脚本和 fixture 已删除；隔离 API/worker（3311/3427）在报告核对后关闭。只读挂载脚本执行已验证，不要求通过写入工作区来运行 hooks。

验证边界：hooks 以执行标记证明运行；MCP 以真实工具调用和关闭后的 transcript 对照证明加载行为，未额外采集原始 MCP initialize 帧。echo 子智能体不调用内部工具，未覆盖其嵌套工具事件。`CLAUDE_CODE_PLUGIN_SEED_DIR` 不属于本期选定路线。

### 第四轮评审修复（4 项）

| 项 | 修复 |
|---|---|
| 1 `POST /api/agents` 无条件拒绝 `pluginBindings` | 删除该预检：该路由只创建顶层智能体，绑定交给 `createAgent` 事务写。`toWrite` 本就 omit 掉绑定，绑定走独立参数，事务内支持。顺带把 `INVALID_REFERENCE` 文案补上插件 |
| 2 `PluginDialog` 缺 `Dialog.Root` | 按 `SkillDialog` 包受控 `Dialog open` + `onOpenChange`（保存中 `details.cancel()`）；`closeDisabled={pending}`；未保存修改时先弹「放弃未保存的更改？」确认，复用现有 `ConfirmDialog`，未新增 helper |
| 3 `hasAgents` 漏嵌套 agent | `plugin-render.ts` 正则改 `/^agents\/.+\.md$/`；测试补 `agents/team/reviewer.md` |
| 4 子智能体插件绑定缺少事务级约束 | `replaceAgentPluginBindings` 在写入前（有绑定时）拿与委派相同的 advisory 锁并复查 `parentId`，非顶层一律 `INVALID_INPUT`；`lockSubAgentBindings` 选候选绑定时也校验插件绑定。两条都是事务内检查，失败即回滚，版本与配置不变 |

### 第四轮验证

| 命令 | 结果 |
|---|---|
| `pnpm -r typecheck` | 全部 Done |
| `npx vitest run packages/core/test/plugin-render.test.ts packages/web/test/plugin-editor.test.ts` | 2 files / 8 tests passed |
| `npx vitest run packages/api/test/plugins.test.ts` | 1 file / 4 tests passed |
| `npx vitest run agents / subagent-binding-concurrency / child-skills / agent-md-import / subagent-bundle / db plugins / plugin-parse` | 7 files / 57 tests passed |
| `pnpm --filter @agentport/web build` | built in 609ms（仅 chunk 体积警告） |
| `biome check`（7 个改动文件） | No fixes applied，无诊断 |

新增测试覆盖：顶层创建带插件绑定成功；解绑 → 被收为子智能体 → 回滚旧绑定返回 `INVALID_INPUT` 且 `parentId`、绑定、名称与版本列表都不变；子智能体直接绑插件被拒；带绑定的候选不能被收为子智能体。

## PR 发布校验（2026-10-25）

用户明确授权提交、创建 PR 并合并。功能分支已快进到 `797edfe`，保留 main 上技能与编码规则文档更新，本次不修改它们。

- 最终定点回归：24 个测试文件、206 项通过，包含 core/sandbox、插件 API 与 DB、专家 CRUD/ZIP、插件编辑弹窗和确定性锁顺序回归。
- `pnpm -r typecheck` 全包通过；前端生产构建通过。
- Biome 对 37 个相关文件无诊断，焦点与项目约定检查通过。
- Vitest 有重复 SIGTERM listener 警告，测试结果通过，未用警告代替运行证据。
- 真实沙盒执行记录沿用独立实测报告，不额外重跑付费模型。
- 当前仅 ZIP 导入/导出，无 marketplace 或替换同一插件文件的升级入口；专家 ZIP 不携带插件代码或绑定，下载时明确提示。
- 本任务不触发 CI、不等待 CI、不启动 PR 监控。测试结果产物不纳入提交。

## PR 最后阻断修复：advisory 锁顺序（2026-10-25）

第四轮引入的 `replaceAgentPluginBindings` 在事务后段才拿 `pg_advisory_xact_lock`，形成真实死锁：
带 `pluginBindings` 的 PATCH 先 `UPDATE agents` 持有行锁、再等 advisory；带 `subAgentIds` 的 PATCH
先拿 advisory、再 `UPDATE` 候选行，两边互等。`duplicateAgent` 先 `FOR SHARE` 源行、后复制绑定拿
advisory，与前者同样反转。这不是理论竞态，PostgreSQL 会直接报 40P01。

修复（只动 `packages/db/src/repo/agents.ts` 与其测试）：

- 抽出 `lockAgentBindings(tx)` 作为唯一取锁点；`lockSubAgentBindings` 复用它在做校验前取锁。
  PG 的 advisory 锁同事务内可重入，重复获取不会自阻塞。
- 需要 advisory 的写事务一律在**第一次碰 agents 行/唯一索引之前**取锁：`updateAgent` 在
  `subAgentIds !== undefined` 或有非空 `pluginBindings` 时事务开头预取；`createAgent` 在同条件下
  也预取（它先 insert 再写绑定，原本只有委派分支取锁）；`duplicateAgent` 在 `FOR SHARE` 前无条件
  取锁——源有没有绑定要先读才知道，无条件拿一次快锁比先快读再决定更简单，也不会留反转窗口。
- `replaceAgentPluginBindings` 改为私有的 `writeAgentPluginBindings`，自己**不取锁**，只保留
  `parentId` 复查与写绑定。这样不存在「可独立调用、调用后才加锁」的陷阱；DB 层测试改走
  `updateAgent` 的真实写路径。
- 没有加 40P01 重试：顺序修好后不需要，重试只会掩盖再次反转。

确定性回归（`packages/api/test/plugins.test.ts`，两例各 10 秒上限，内部等待 3 秒）：

1. 外部事务先占 advisory，再发带 `pluginBindings` 的 PATCH：断言它停在 advisory 等待上，同时用
   `select ... for update nowait` 证明目标 agent 行仍可拿到（即尚未持有行锁）；随后发委派 PATCH，
   两请求同样停在同一把锁；放行后一个 200、一个 400，没有 40P01。
2. 同样占住 advisory 后克隆一个带绑定的源：断言克隆停在 advisory 上、源行仍可 nowait 拿到（即
   `FOR SHARE` 尚未发生），放行后 201 且绑定被复制。

两例都用 `pg_stat_activity` + `pg_blocking_pids` 判定阻塞语句，不靠 sleep 猜时序。把实现临时改回
旧的「后取锁」顺序后，两例分别以「plugin binding locked the agent row before the advisory lock」和
「clone locked the source row (FOR SHARE) before the advisory lock」失败，改回后通过。

### 修复验证

| 命令 | 结果 |
|---|---|
| `pnpm -r typecheck` | 全部 Done |
| `npx vitest run packages/db/test/plugins.test.ts packages/api/test/subagent-binding-concurrency.test.ts packages/api/test/plugins.test.ts` | 3 files / 14 tests passed |
| 旧顺序探针（临时改动，已还原） | 新增 2 例均失败，断言命中「先锁行」 |
| `biome check`（3 个改动文件） | 无诊断 |

绑定不变量未回退：子智能体不能绑定插件、带绑定的候选不能被收为子智能体、解绑→被收→回滚旧绑定被拒，
这几条仍由 `packages/api/test/plugins.test.ts` 原有 4 例覆盖并通过。
