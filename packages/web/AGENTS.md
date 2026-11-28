# packages/web — 前端规则

> 只放 web 包专属规则；根共用原则、优先级、能力选型、协作与交付见 [../../AGENTS.md](../../AGENTS.md)，流程与门禁见 [../../docs/DEV-WORKFLOW.md](../../docs/DEV-WORKFLOW.md)，开工前或报错先读 [../../docs/PITFALLS.md](../../docs/PITFALLS.md)。不复制根规则，不为单个业务页面写专属规则或通用 DSL。

## 视觉与设计

- **仅桌面端。** 使用桌面布局与控件规格，不做移动端适配、手机断点、触摸尺寸或替代导航；保留窗口缩放、容器伸缩与无障碍行为。
- **视觉权威是本包 [DESIGN.md](DESIGN.md)（impeccable）与 `src/styles.css` 令牌；布局/交互/无障碍/信息表达工程规约见 [docs/DESIGN-SYSTEM.md](../../docs/DESIGN-SYSTEM.md)。** 配色采用中性工作面（侧栏 `#FAFAFA` + 右缘发丝边），石青仅限工牌装饰，品牌 Logo 与插画保留原配色（低饱和底为图形例外）；字体、圆角、阴影与其他控件沿用 Claude Design System（CDS，参考 open-claude-ui，仅亮色），OpenUI 桌面基准仅作历史参考。主操作为白底、细边、深字中性按钮，次操作为细边或中性浅底；链接、选区、hover、选中、chip 与焦点环使用中性黑白灰，输入框聚焦为中性暖灰边；普通图标继承文字色，危险用 `danger`，状态与数据不借用动作色，`chart-runs` 仅用于图表。若发现令牌缺口，报告缺口不静默删值。
- **改 UI 前必读 DESIGN-SYSTEM §9（组件与交互契约）与 §10（信息表达）；涉及动效按 §11 核对实际实现与 `src/styles.css`。**
- **布局优先。** 删掉标语、解释结构的辅助文案与重复次级标签，靠分组、对齐、间距与层级表达结构；字段标签、格式/约束、错误、风险与无障碍说明按 §10 保留。
- **图标与边线。** lucide 16px、`strokeWidth={1.75}` 由 `src/App.tsx` 的 `LucideProvider` 统一设置，组件内不逐个传；1px 线、留白与控件尺寸按 §9，不用新增 border 改变控件尺寸；图表描边沿用图表自身数值。
- **组件与样式栈以 [DESIGN-SYSTEM §12](../../docs/DESIGN-SYSTEM.md#12-实现技术栈硬性) 为准。** 只用 shadcn/ui + `@ui-sdk/react`（每组件子路径直连），禁 Base UI / Radix；Tailwind 4，颜色/字体/圆角/阴影只取 `src/styles.css` `@theme` token，禁硬编码 hex；间距用 §9 `gap-*`/`p-*`，不增私有间距令牌。先看 `src/components/ui/` 再装官方组件（`bunx --bun shadcn@latest add <name>`）；改源码保留原语 `aria-*`、焦点与键盘交互，`--overwrite` 前核对 diff。
- **页面骨架。** 用 `src/components/page.tsx` 的 `Page`/`PageHeader`/`PageToolbar`/`PageSection`；每个渲染状态恰好一个 `h1`，不写页面级 `mt-*`/`mb-*`。
- **找专家页的扇形「新建专家」入口卡与「创建数字分身」卡为用户刻意要求保留，不得删除或合并到页头；其它页面仍可按设计规范精简。**
- **白底立体卡片跨页面适用。** 业务卡片复用共享 `Card` 与 [DESIGN.md「共享卡片深度」](DESIGN.md#elevation--depth)（自定义布局详情卡复用 `.cds-card-surface`，不另造阴影或叠装饰边）。业务卡片常驻 `--shadow-panel` 深度，hover 按三态契约执行（`static` 无变化、`shadow` 为 `Card` 默认只换投影不上浮、`lift` 换投影并上浮 1.5px 且仅用于整卡可点卡片）；视觉反馈不赋予整卡点击语义，不为此加点击处理、焦点或 `tabIndex`，不新增参考没有的 active/selected/disabled 外观。内部真实控件保留各自焦点与业务状态，OpenUI `sunk` 等语义变体保持。卡片父级滚动容器为首排顶部与四周留足投影与上浮绘制余量并实测核对；按钮、表格、列表行、输入与浮层不套卡片上浮，按 [DESIGN-SYSTEM §9](../../docs/DESIGN-SYSTEM.md#9-组件与交互契约) 执行。

## 表单

- **平台资源编辑多字段表单用 `src/lib/use-zod-form.ts` 的 `useZodForm` + RHF。** 不手写 `useState` 管字段、dirty/submitted/pending 或校验；单字段搜索、开关沿用 `SearchInput`/`Switch` 与轻量状态。
- **OpenUI 生成式表单走官方运行时。** 状态、校验与提交用 `@openuidev/react-lang` 的 `useCreateFormValidation`、`useStateField` 与动作运行时（`src/openui/components/forms.tsx`），不接 RHF/`useZodForm`，不套用下方 defaultValues/reset 与离开保护规则。
- **公共字段约束从 `@agentport/shared` 派生**（如 `agentInputSchema`、`serverInputSchema`）；UI schema 只补草稿转换、错误文案与 UI 规则，不重复写长度/范围边界。暂时不合法的输入保留原始文本草稿，提交时再转换。
- **defaultValues 与 `reset` 快照须包含每个受控字段的键。** 提交回调 `await` 完整请求：保存中禁用受影响字段与冲突操作；失败保留草稿与 dirty；确认成功后按服务端结果 `reset`。
- **错误可见、可定位、可修正。** 用 `Field`/`FieldError` 与 `aria-invalid`/`aria-describedby` 关联控件；校验失败聚焦首个无效字段但不打断正在进行的修正。禁止 `<form>` 嵌套 `<form>`。
- **离开保护共用同一份 dirty/pending。** 路由离开、刷新与弹层关闭共用 `useBlocker`（`src/lib/form.ts` 的 `useFormBlocker`）；拥有弹窗/编辑子树生命周期的父层在真正卸载前结算 pending 与 blocker resolver，不依赖子组件卸载或 per-call mutation 回调；跨卸载异步收尾用 `mutateAsync` + `finally`。

## 状态与复用

- **普通业务服务端状态用 TanStack Query；JSON query/mutation 经 `src/lib/api.ts` 与 `src/lib/queries.ts`。** 新增 query/mutation 与缓存写回/失效集中在 `queries.ts`，不建第二套 JSON 层。非 JSON 或事件通道各守职责：鉴权图片 Blob 需可取消请求与 object URL 释放（`knowledge-citations.tsx`），SSE 直写 Query 缓存（`use-chat-stream.ts`），OpenUI Query/Mutation 走官方运行时与执行桥。
- **URL 状态用 TanStack Router。** 筛选、分页、选中 tab/分区/文件走 `validateSearch`，不塞组件 state；增删路由后由 Vite 重生成 `src/routeTree.gen.ts`，不手改。
- **共享客户端交互状态统一用 Zustand。** 跨组件非服务端状态复用现有业务域 store（`src/lib/chat-store.ts`），不按页面并排建新 store；读取用原子 selector，组合对象/数组按需用 `useShallow`，不整 store 订阅。组件私有临时状态留本地；类名合并只用 `src/lib/cn.ts`。
- **先复用现有层。** 交互优先 `src/components/ui/` 原语，应用组合放 `src/components/`；实体列表用实体主键作行标识，其余标识按 [ID 约定](../../docs/PROJECT-BRIEF.md#162-id-约定) 处理。

## 层边界

- 禁 import `@agentport/db`、`@agentport/api`、`@agentport/worker` 与 `@agentport/core` 根入口（含 `node:crypto`）。
- 只引用 `@agentport/shared`、`@agentport/contract` 与 core 纯函数子路径（`@agentport/core/workspace`、`/plugin-display`、`/record`）；新增子路径前核对 `packages/web/package.json` 与 [ARCHITECTURE](../../docs/ARCHITECTURE.md) §1。

## 组件库升级

- `@ui-sdk/*` 用原生 API 直连、不套封装层；升级按 [../../docs/UI-SDK-UPGRADE.md](../../docs/UI-SDK-UPGRADE.md) 执行，版本只在根 `catalog` 精确 pin。
- 使用或改动 ui-sdk 组件前遵循 `ui-sdk` 技能，优先查阅 `packages/web/node_modules/@ui-sdk/react/docs/llms.txt` 与对应 `components/<name>.md`；自定义 primitive 查阅同目录 `core.md` 与 `rendering.md`。
- `packages/web` 第三方依赖源码与文档位于 `packages/web/node_modules/`（如 `@ui-sdk/*`、`@openuidev/*`），临时探测脚本统一用 `bun --cwd packages/web -e`，前端单测走 `bun run test:web`（Vitest），不用 `bun test`。

## 验证

- 按改动面选用根脚本：`bun run --filter @agentport/web typecheck`、`bun run --filter @agentport/web build`、`bun run test:web`、`bun run lint:focus` / `bun run lint:design`（含 `shadcn/no-restyle` 棘轮；定位单文件用 `bun --cwd packages/web oxlint <文件>`）/ `bun run lint:contract`；OpenUI 改动加 `bun run openui:audit`。策略见 [DEV-WORKFLOW](../../docs/DEV-WORKFLOW.md) §5。
- 视觉、几何、焦点与 AX 结论以真实渲染证据为准（`getBoundingClientRect()` / 计算样式 / 实际 AX 树），类名与截图不能替代。窄桌面检查无横向溢出、单一 `h1`、焦点与键盘可用。

## UI 验收（硬性）

触及页面、组件、样式或设计令牌的改动，交付前必须完成真实渲染验收，不凭 typecheck/build 或代码推断宣称完成：

- 跨多页面的 UI 视觉重构，全量铺开前先产出单页可渲染原型或真实截图供用户确认，再批量迁移。
- 用 `bun run visual:shots --full --route <路径>`（或 `visual-check` 技能）起隔离临时库 + 真实登录，为每个受影响路由产出整页长图（多视口时每宽度各一张）。
- 逐页核对：无白屏/报错、无页面级横向溢出、每状态恰好一个 `h1`、焦点与键盘可用、关键元素与文案在位、视觉与 `DESIGN.md` + `styles.css` 令牌一致。
- 交付附验收记录（代码根目录、commit、路由、视口、截图目录；未截图路由明写「未做视觉验收」及原因）；设计参考迁移/改版时同屏对照参考界面。
