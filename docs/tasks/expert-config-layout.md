# 专家配置页信息层级与布局重设计

## 目标
按用户已确认的方案，将专家详情组织为任务页签、任务内导航和编辑内容；明确保存范围，保留全部现有能力与草稿保护。

## 方案
- 六个任务：配置、长期记忆、项目规则、输出风格、完整文件、运行统计；URL 保存任务、配置分区和选中文件。
- 配置保留身份、行为、能力、权限、运行限制五分区，移除导航摘要。其他编辑面板不再嵌套外层导航。
- 配置工具栏只在配置任务显示，版本历史明确配置范围；删除收进更多菜单；行为先模型与推理强度再提示词。
- 记忆、规则、风格向父级报告 dirty/pending，切换任务及路由离开需保护；各自文件切换、创建与删除保护草稿。
- 继续使用既有设计令牌、Page、Tabs、Select、Field、ConfirmDialog 和文件渲染，不新增依赖或修改执行/存储语义。

## 步骤
- [x] 现状盘点、独立 Opus 设计评估、用户确认
- [x] 创建 worktree，确认 HEAD 与 main 一致
- [x] 主布局、子编辑器保护及间距修复
- [x] 同步设计规范和现有测试定位
- [ ] 本轮控件统一及子编辑器独立评审（主配置控件评审已通过）
- [x] 类型、267 条 web 测试、构建、契约检查与 1500/768/320px 浏览器验证
- [x] 本轮间距修改限定范围 Opus 评审：已读部分通过；子面板 Select、Section helper 和新增规范条款未完整独立核验

## 改动文件
- packages/web/src/pages/agents.tsx
- packages/web/src/pages/memory-panel.tsx
- packages/web/src/routes/_shell/agents.$agentId.tsx
- packages/web/src/routes/-search.ts
- packages/web/test/ 相关测试
- tests/ 相关 E2E 定位
- docs/DESIGN-SYSTEM.md

## 共享契约
- 路由：`/_shell/agents/$agentId` 增加 `validateSearch: agentDetailSearchSchema`，字段 `tab`（config|memory|rules|styles|files|stats，默认 config）、`section`（identity|behavior|capability|permissions|limits，默认 identity）、`file`（string，默认 .mcp.json）。搜索 schema 放 `routes/-search.ts`；AgentDetailPage 用 `useSearch({ from: '/_shell/agents/$agentId' })`、`useNavigate()` 更新，替换优先 `replace: true`；直接调用页面组件的测试 mock 必须补 `useSearch`（现有 mock 已返回 `{}`，字段需可缺省）。
- AgentEditor props：`agent, onDirtyChange, onPendingChange` 保持不变；新增 `onDeleteRequest` 由页面打开删除确认。任务与分区在编辑器内读取并同步 URL，文件直接读取 URL；不新增 tab/section/file 回调 props。
- 页头：`PageHeader` 保留 44px 头像、名称、角色（eyebrow）、返回列表；描述从编辑器内移回页头，但收进同一个 `flex flex-col gap-2` 容器（仍是单一 `PageHeader` 与单一 h1），避免再吃一次 Page 的 20px 区块间距。删除从页头 actions 移入编辑器「更多操作」菜单，菜单项文案保持「删除专家」且 `disabled={pending}`，现有测试按 aria-label 查找需同步。
- 任务页签桌面用共享 `Tabs`（`components/ui/tabs.tsx`，variant="line"），`hidden md:flex` 且不换行；窄屏用同一组任务的 `Select`（`md:hidden`，`w-full`，`disabled={locked}`），调用同一个 `changeTab`。配置分区导航保持按钮 + `aria-current`，测试按文字点击。
- 完整文件导航桌面 `hidden md:block`，窄屏换成当前文件 `Select`（选项为完整路径，按组用 `SelectGroup`/`SelectLabel`，`w-full min-w-0`、值 `truncate`），调用同一个 `setActiveFile`。
- 记忆、规则、输出风格三个子面板：外层统一 `rounded-card bg-surface px-6 py-5 ring-1 ring-line`（记忆此前缺失）；内部列表 + 编辑器统一 `md:grid-cols-[220px_minmax(0,1fr)] gap-5 items-start`；列表在 `md` 以下换成 `Select`（可访问名称、`disabled={pending}`），仍走各自原有的 `guard`/切换确认，不改草稿保护语义。
- 配置工具栏只在 `tab==='config'` 显示（启用开关、未保存、去修正、保存更改、配置版本历史、更多操作）；记忆/规则/风格各自保存，不显示配置保存按钮。
- 子面板 MemoryPanel、RulesPanel、OutputStylesPanel 新增可选 props：`onDirtyChange?: (dirty: boolean) => void`、`onPendingChange?: (pending: boolean) => void`；面板不再自行调用 `useFormBlocker` 做路由离开保护，统一由 AgentEditor 用合并后的 `childDirty/childPending` 保护路由离开与任务切换；面板内部文件切换、创建、删除仍保留自己的 ConfirmDialog。回调在卸载时回调 false；effect 依赖传进来的回调身份。
- 页面主配置 pending（保存/回滚/重载）、子面板 pending 分别跟踪，任一为真都禁用页头删除、任务切换和路由离开。
- 切换任务保留主配置草稿；当前子面板有 dirty 时先确认，确认后才切换。切换配置分区、只读文件不做确认。
- 现有保存语义、409 处理、回滚、校验定位、完整文件只读、草稿预览 renderWorkspace 全部不变。

## 下一步
并行实现，按 docs/PITFALLS.md 核对 worktree 依赖/启动和根目录 E2E 文案定位。不提交或推送，除非用户另行要求。

## 实屏间距修复（2026-10-24）

实测问题：行为页任务 tablist 位于 x284 y120 h32；整行因操作区 `min-h-12 py-2` 撑到 169，下方内容 grid 直接从 169 开始、与页签行无间距；页头描述作为独立 Page 子项多吃了 20px 区块间距；配置左栏 160px 过窄；三个子面板的列表 + 编辑器用 `lg` 断点与 13rem，窄屏仍铺长列表。

处理（均改在 `agents.tsx` / `memory-panel.tsx`，不动保存、路由、共享组件）：

- AgentEditor 根容器改 `flex min-w-0 flex-col gap-5`，主块之间 20px。
- 页签/操作行 `items-center`，去掉 `-mb-px` 与操作区 `min-h-12 py-2`，整行 `pb-3` 留 12px 并保留 `border-b`；组间 12、操作按钮间 8，控件高度不变。
- 配置与完整文件 grid 统一 `items-start gap-5 md:grid-cols-[220px_minmax(0,1fr)]`；列表项加 `min-w-0`，长路径不撑宽。
- Section 标题到内容 `mt-4`、子组 `gap-4`；`FieldGroup gap-5`、Field `gap-1.5` 保持不变。
- 子面板外层统一卡片（记忆补上）；内部 grid 统一 220px + 20；列表 `md` 以下换成 `Select`，保留各自 guard 与确认。
- 任务页签桌面 `hidden md:flex` 且不换行，窄屏 `Select`；完整文件导航桌面 `hidden md:block`，窄屏当前文件 `Select`。
- 页头与描述包进同一 `flex flex-col gap-2`，仍是单一 `PageHeader` 与单一 h1。
- 身份分区：描述字段移到 slug 之前，绑定不变。

## 控件统一复查（2026-10-24）

用户反馈按钮间距、配色与输入控件仍不一致。实屏测量确认页头返回及历史/更多为28px、主配置保存32px；代码确认记忆保存28px且在顶部、规则/风格保存32px且在底部；输出风格只有placeholder没有可见字段标签；规则/风格保存中部分字段仍能编辑；权限项自定义黄色小按钮绕过共享Toggle；若干Input局部text-xs压低字号。

本轮边界：agents.tsx主配置与memory-panel.tsx三个子编辑器，沿用共享控件与颜色令牌，不改主题/共享组件、不增加依赖。并行修复主配置与子面板；主会话同步规范、实屏验证。新增最小子面板测试覆盖可见标签与保存pending禁用/dirty复位。

主配置实屏（浏览器空间27）已确认：返回/保存/历史32px，返回为outline、保存为石墨default；编辑后保存可用，恢复原名后dirty复位（未提交到服务端）。权限Toggle实测28px、中性选中底、aria-pressed正确，Agent/TaskStop仍锁定。Ego Lite提示可更新，未升级。主配置执行线类型检查与39条相关测试通过；子编辑器尚待完成并做集成验证。

本轮完成（2026-10-24 晚）：主配置与三个子编辑器控件已统一。子编辑器保存/删除移至标题右侧，字段全部使用 Field/FieldLabel 并有真实 id，共享输入字号恢复，保存中字段与冲突操作禁用；新增 `packages/web/test/expert-panel-controls.test.ts` 覆盖标签关联、dirty/pending 与保存禁用。规则删除在有无草稿时都走二次确认（行为变化，用户可见），风格删除为两步确认。验证：typecheck、`pnpm test:web` 29 文件 268 用例、build、lint:focus、lint:contract、Biome 均通过；实屏复查输出风格、记忆、权限按钮。主配置控件改动限定评审通过；子编辑器独立评审发现并已修复：规则删除改为始终确认、删除失败双提示去重、记忆标签与 aria 名称统一。未提交。

## 验证
- git rev-parse main 与当前 HEAD 均为 e1e02ae7ceb9e6a173c64f9a16fdb49c05531ecb：一致。
- `pnpm --filter @agentport/web typecheck`：本轮通过。
- `pnpm test:web`：28 个文件、267 条用例全部通过（本轮无测试文件改动；窄屏 Select/Tabs 并存未影响既有断言）。
- `pnpm exec biome check packages/web/src/pages/agents.tsx packages/web/src/pages/memory-panel.tsx docs/DESIGN-SYSTEM.md`：通过。
- 上一轮记录：`pnpm --filter @agentport/web build` 通过（仅有既有的 chunk 体积警告）；`pnpm lint:focus`、`pnpm lint:contract`、`pnpm exec biome check packages/web` 通过。
- 行为澄清：主配置随 AgentEditor 常驻，切任务保留草稿、不弹确认；只有记忆/规则/输出风格的草稿会随面板卸载丢失，此时才确认。路由 blocker 只拦离开页面，不拦同页 search 变化；保存中禁止离开与切换。
- 本轮重新运行 `pnpm --filter @agentport/web build`、`pnpm lint:focus`、`pnpm lint:contract`、源文件 Biome：全部通过（构建仅有既有 chunk 大小提示）。
- 浏览器实测 1500px / 768px / 320px：桌面操作与页签居中；768px 工具栏到内容 20px、导航宽 220px、标题到字段 16px；320px 完整文件视图 scrollWidth=innerWidth=320，无横向溢出，任务选择器可切规则/文件，文件选择器可切 CLAUDE.md。未提交；200% 缩放与 RTL 未验证。
