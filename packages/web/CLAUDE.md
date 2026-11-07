# packages/web — 前端规则

> 只放 web 包专属规则；根共用原则、优先级、能力选型、协作与交付见 [../../CLAUDE.md](../../CLAUDE.md)，流程与门禁见 [../../docs/DEV-WORKFLOW.md](../../docs/DEV-WORKFLOW.md)，开工前或报错先读 [../../docs/PITFALLS.md](../../docs/PITFALLS.md)。不复制根规则，不为单个业务页面写专属规则或通用 DSL。

## 视觉与设计

- **仅桌面端。** 使用桌面布局与控件规格，不做移动端适配、手机断点、触摸尺寸或替代导航；保留窗口缩放、容器伸缩与无障碍行为。
- **视觉与组件外观单一来源是本包 [DESIGN.md](DESIGN.md)（impeccable，`packages/web/DESIGN.md`）。** 仓库级工程规约（布局/交互/无障碍/信息表达）见 [docs/DESIGN-SYSTEM.md](../../docs/DESIGN-SYSTEM.md)，布局几何沿用其中用户批准的布局契约；颜色采用用户选定的石青，字体、圆角、阴影与其他控件外观沿用 Claude Design System（CDS，参考 open-claude-ui），仅亮色；OpenUI 桌面基准仅保留为历史参考。本文不复制 hex/token 表；旧规则里的视觉具体值以 DESIGN.md 与 `src/styles.css` 的令牌为准，若发现有值缺失，报告缺口，不静默删除。
- **改 UI 前必读 §9（组件与交互契约）与 §10（信息表达）；涉及动效再按 §11 核对实际实现与 `src/styles.css`。** 品牌 Logo 与插画保留原配色（插画低饱和背景是图形色彩例外）；普通图标继承所属文字色，危险用 `danger`。主操作为石青实底三态，次操作为细边或中性浅底，按钮键盘焦点环为石青 `ring`、输入框聚焦为中性暖灰边；状态与数据不借用动作色，`chart-runs` 只用于图表数据。
- **布局优先。** 删掉标语、解释结构的辅助文案和重复次级标签；界面靠分组、对齐、间距与层级说明结构。字段标签、格式/约束、错误、风险与无障碍说明按 §10 保留。
- **图标与边线。** lucide 16px、`strokeWidth={1.75}` 由 `src/App.tsx` 的 `LucideProvider` 统一设置，组件内不再逐个传；1px 线、留白与控件尺寸按 §9，不用新增 border 改变控件尺寸。图表描边沿用图表自身数值，不按图标规则改。
- **组件与样式栈以 [DESIGN-SYSTEM §12](../../docs/DESIGN-SYSTEM.md#12-实现技术栈硬性) 为准。** 只用 shadcn/ui；交互原语只用 Base UI（`@base-ui/react`），不引入 Radix；Tailwind 4，颜色/字体/圆角/阴影只从 `src/styles.css` 的 `@theme` token 取，禁止硬编码 hex；间距使用 §9 的 `gap-*`/`p-*` 尺度，不新增私有间距令牌。先看 `src/components/ui/` 有无可复用再装官方组件（`bunx --bun shadcn@latest add <name>`）；改源码时保留原语 `aria-*`、焦点与键盘交互，`--overwrite` 前核对 diff。动效、分栏、拖拽、客户端状态、路由与 OpenUI 渲染等其余选型按 §12，本文不复制完整清单。
- **页面骨架。** 用 `src/components/page.tsx` 的 `Page`/`PageHeader`/`PageToolbar`/`PageSection`；每个渲染状态恰好一个 `h1`，不写页面级 `mt-*`/`mb-*`。
- **找专家页的扇形「新建专家」入口卡与「创建数字分身」卡为用户刻意要求保留，不得删除或合并到页头；其它页面仍可按设计规范精简。**
- **白底立体卡片跨页面适用。** 所有现有业务卡片复用共享 `Card` 与 [DESIGN.md「共享卡片深度」](DESIGN.md#elevation--depth)；已有自定义布局的详情卡可复用 `.cds-card-surface`，不另造阴影或叠装饰边框。整体可点击的卡片用 `interactive`，已有明确交互反馈的卡片沿用；仅内含按钮、链接或表单的静态卡保留常态深度，不据此添加整体上浮。卡片父级滚动容器为首排顶部与四周保留投影和已有交互的绘制余量，并用真实渲染核对；表格、列表与输入继续按各自任务使用。

## 表单

- **平台自身的资源编辑表单：多字段编辑用 `src/lib/use-zod-form.ts` 的 `useZodForm` + RHF。** 不手写 `useState` 保存字段值，不复制 dirty/submitted/pending 与校验状态；单字段的搜索、开关沿用 `SearchInput`、`Switch` 与现有轻量状态，不机械套 RHF。
- **OpenUI 生成式表单走官方运行时。** 表单状态、校验与提交用 `@openuidev/react-lang` 的 `useCreateFormValidation`、`useStateField` 与动作运行时（`src/openui/components/forms.tsx`），不接 RHF 或 `useZodForm`，也不套用下文的 defaultValues/reset 与离开保护规则；不为生成式表单另造第二套状态引擎。
- **平台资源编辑表单的公共字段约束**从 `@agentport/shared` 派生（如 `agentInputSchema`、`serverInputSchema`）；UI schema 只补充本地草稿转换、错误文案与 UI 专属规则，不另写一套相同的长度/范围边界。输入可能暂时不合法时，在表单值里保留原始文本草稿，提交时再转换。
- **平台资源编辑表单的 defaultValues 与 `reset` 快照必须包含每个受控字段的键。** 提交回调 `await` 完整请求：保存中禁用受影响的字段与冲突操作；失败保留草稿与 dirty；确认成功后按服务端结果 `reset`。
- **错误可见、可定位、可修正。** 用 `Field`/`FieldError` 与 `aria-invalid`/`aria-describedby` 关联控件；校验失败后聚焦首个无效字段，但不打断用户正在进行的修正。禁止在 `<form>` 内嵌套另一个 `<form>`。
- **平台资源编辑表单的离开保护用同一份 dirty/pending。** 路由离开、刷新与弹层关闭共用 `useBlocker`（公共封装见 `src/lib/form.ts` 的 `useFormBlocker`）；拥有弹窗/编辑子树生命周期的父层在真正卸载前结算 pending 与 blocker resolver，不依赖子组件卸载或 per-call mutation 回调；跨卸载仍要继续的异步收尾用 `mutateAsync` + `finally`。
- 只写通用规则；已合入任务的单点修复（如某个字段的默认值）不写成长期规则。

## 状态与复用

- **普通业务的服务端状态用 TanStack Query；JSON query/mutation 经 `src/lib/api.ts` 与 `src/lib/queries.ts`。** 页面和组件复用 `api`/Query，新增 query/mutation 与常规缓存写回/失效集中在 `queries.ts`，不建第二套 JSON 请求或缓存层。非 JSON 或事件驱动的通道各留其职责：鉴权图片 Blob 需要可取消请求与 object URL 释放（`knowledge-citations.tsx`），SSE 事件直接写回 Query 缓存（`use-chat-stream.ts`），OpenUI 的 Query/Mutation 走官方运行时与执行桥；这些通道不并入 `queries.ts` 的 JSON 请求层。
- **URL 状态用 TanStack Router。** 筛选、分页、选中的 tab/分区/文件走 `validateSearch`，不塞进组件 state；新增或删除路由后让 Vite 重新生成 `src/routeTree.gen.ts`，不手改生成文件。
- **共享客户端交互状态统一用 Zustand。** 跨组件、非服务端的交互状态放 Zustand，按业务域复用现有 store（当前 `src/lib/chat-store.ts`），不按页面并排新建同类 store。读取用原子 selector；组合对象/数组时保持稳定引用，按需使用 `useShallow`，不整 store 订阅。服务端状态仍用 Query，可导航状态用 Router，平台表单用 RHF/`useZodForm`，生成式表单用 OpenUI 官方运行时；组件私有、只影响自身的临时状态留本地。类名合并只用 `src/lib/cn.ts`。
- **先复用现有层。** 交互优先 `src/components/ui/` 原语，应用组合放 `src/components/`；不并排再造同职责的表单、查询、路由或样式封装。
- **实体列表用实体主键作为行标识。** 关联表、认证、幂等派生标识、外部资源及其他 UI 行标识按 [ID 约定](../../docs/PROJECT-BRIEF.md#162-id-约定) 处理。

## 层边界

- 不 import `@agentport/db`、`@agentport/api`、`@agentport/worker`；也不 import `@agentport/core` 根入口（含 `node:crypto`）。
- 只引用 `@agentport/shared`、`@agentport/contract` 与 core 的纯函数子路径（当前为 `@agentport/core/workspace`、`/tools`、`/plugin-display`）。契约只提供 type 与 schema，不把服务端实现带进 bundle。新增子路径前核对 `packages/web/package.json` 依赖与 [ARCHITECTURE](../../docs/ARCHITECTURE.md) §1。

## 验证

- 按改动范围从根 `package.json` 选现有命令，不固定全套、不加新门禁：`bun run --filter @agentport/web typecheck`、`bun run --filter @agentport/web build`、`bun run test:web`（有 web 测试时）、`bun run lint:focus` / `bun run lint:contract`；OpenUI 改动加 `bun run openui:audit`。机械检查与门禁策略见 [DEV-WORKFLOW](../../docs/DEV-WORKFLOW.md) §5（不装钩子、不阻塞）。
- 视觉、几何、焦点与 AX 结论以真实渲染证据为准：读 `getBoundingClientRect()`/计算样式或实际 AX 树，类名与截图不能替代。窄桌面检查无页面横向溢出、单一 `h1`、焦点与键盘可用。

## UI 验收（硬性）

任何改动一旦触及页面、组件、样式或设计令牌，交付前必须做真实渲染验收，不能只凭 typecheck/build、类名或代码推断宣称完成：

- 用 `bun run visual:shots --full --route <路径>`（或 `visual-check` 技能）起隔离临时库 + 真实登录，为每个受影响路由产出**整页长图**（full-page，一张长截图覆盖整页、不被视口截断；多视口时每个宽度各出一张长图）。
- 逐页核对：无白屏/运行时报错、无页面级横向溢出、每个渲染状态恰好一个 h1、焦点与键盘路径可用、关键元素与文案在位、颜色/圆角/阴影/间距与 `DESIGN.md` + `styles.css` 令牌一致。
- 交付回复附验收记录：代码根目录、commit、路由、视口、截图目录；未截图的路由明写「未做视觉验收」及原因。
- 设计参考迁移/改版时，同屏对照参考项目对应界面。
