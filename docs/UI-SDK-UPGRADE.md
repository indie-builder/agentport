# UI SDK 升级手册

> 目标：ui-sdk（`@ui-sdk/*`）发新版时，用最小改动、可验证的步骤完成升级，不靠记忆改代码。范式与 [OPENUI-UPGRADE.md](OPENUI-UPGRADE.md) 一致。
> ui-sdk 已接入：版本以根 `package.json` 的 `workspaces.catalog` 与 `bun.lock` 为准（见「版本来源」），接入落点与升级步骤见本文。

## 接入方式（原生直连，不套层）

- 直接 `import "@ui-sdk/react/<component>"`，用原生 `Root/Part` 组合与 `render`（不是 `asChild`）；受控/非受控用 `defaultValue` / `value + onValueChange`。
- 不自造 wrapper/facade 层，不镜像成 shadcn 旧签名；升级落点就是各组件文件本身。
- 样式只从 `packages/web/src/styles.css` 的 token 取，按 `data-slot` 与状态属性（`data-open`/`data-pressed`）选择；默认皮肤 `web.css` 不用。
- 自定义组件用 `@ui-sdk/core` 的 `definePrimitive` 定义行为，再用 `@ui-sdk/react/primitive` 的 `createParts` 映射成 React 部件，写在本仓库；参考随包 `docs/` 与 `skills/SKILL.md`。

## 版本来源（唯一真源）

本文不维护当前版本号（历史版本只出现在「升级记录」），避免与依赖漂移。版本只查以下两处：

| 内容 | 来源 |
|---|---|
| 锁定版本 | 根 `package.json` 的 `workspaces.catalog`（精确 pin，不用 `^`） |
| 实际解析版本 | `bun.lock` |

查可升级版本（同时给出 `Current` 列）：

```bash
bun outdated --filter '*'
```

- `@ui-sdk/core`（行为/primitive 层）与 `@ui-sdk/react`（React 适配器）必须同版本：上游 changesets 配置为 `fixed: [["@ui-sdk/*"]]`，所有包强制一起发版。
- `packages/web/package.json` 用 `"catalog:"` 引用；升级只改根 `catalog` 这一处，再 `bun install`（`bun.lock` 随之更新）。

## 需要看的地方（按耦合度排序）

接入后所有 `@ui-sdk/*` 引用必须能用一条命令列全，用它的结果维护下表：

```bash
rg -n "@ui-sdk/" packages/web/src
```

| 文件 | 用到的入口 | 升级时关注 |
|---|---|---|
| `packages/web/src/components/ui/*.tsx` | `@ui-sdk/react/<component>` | part 结构、`render` 签名、`data-slot`/状态属性名 |
| `packages/web/src/components/chat/conversation-search.tsx` | `@ui-sdk/react/command` | Command 的 item/group 结构与键盘行为 |
| `packages/web/src/components/ui/slider.tsx` | `@ui-sdk/core`、`@ui-sdk/core/slider`、`@ui-sdk/react/primitive`、`@ui-sdk/react/slider`、`@ui-sdk/react/field` | `createParts`/`usePart` 的 slot 映射、`useFieldControl` 的字段属性 |
| `packages/web/src/components/ui/sortable-list.tsx` | `@ui-sdk/core`（`definePrimitive`/`createReorder`）、`@ui-sdk/react/primitive` | 草稿/`data-moving`、`preview`、`message` 播报签名、`reorder.bind` 与手柄按键 |
| `packages/web/src/components/ui/mention-list.tsx` | `@ui-sdk/core`（`definePrimitive`/`createListbox`/`selects`）、`@ui-sdk/react/primitive` | `focus: 'virtual'` 与 `bindInput` 的 `aria-activedescendant`/`aria-autocomplete`/`aria-haspopup`/`aria-controls` 契约（textarea 保持 `textbox`，不写 `role`/`aria-expanded`）；方向键与 Enter/Tab/Escape 由 primitive 接管 |
| `packages/web/src/pages/servers/tool-editor-dialog.tsx`、`packages/web/src/pages/knowledge/detail/documents-tab.tsx`、`packages/web/src/components/knowledge/knowledge-faq.tsx` | `@ui-sdk/react/toolbar` | `Toolbar`/`ToolbarButton` 的 roving focus 与默认循环；禁用走 `aria-disabled`/`data-disabled`，外观用 `buttonVariants` 叠 class |
| `packages/web/src/components/ui/{label,textarea}.tsx` | `@ui-sdk/react/{label,textarea}` | 包装层只叠 `data-slot` 与 class；核对根元素与字段属性 |
| `packages/web/src/components/ui/{badge,attachment,bubble,marker}.tsx` | `@ui-sdk/react/primitive` | `renderElement`、`PartProps` 的形状 |
| `packages/web/src/lib/toast.ts`、`App.tsx` | `@ui-sdk/react/toast` | `createToaster` 选项、`ToastRegion` 的位置/`maxVisible`、`Toast*` part 的渲染函数签名 |
| `packages/web/src/components/ui/{calendar,carousel}.tsx` | `@ui-sdk/react/{calendar,carousel}` | 日期值形状（ISO 字符串）、`CalendarDay` 状态字段、`CarouselViewport` 结构与 `aria-disabled` |
| `packages/web/src/openui/components/{forms,data,shared,layout}.tsx` | 经 ui 组件间接使用 | 生成式 UI 里日历/轮播的取值与 DOM 断言 |
| `packages/web/src/pages/{chat,plugins/plugin-detail}.tsx` | `@ui-sdk/react/resizable` | 尺寸单位（数字=百分比，像素用 `"240px"`）、`onLayoutChange/onLayoutCommit` 的 `reason`、`createResizableController` |
| `packages/web/src/components/**` | 经 ui 组件间接使用 | 是否绕过 ui 组件直接 import |

> 纪律：任何 `@ui-sdk/*` 的 import 都保持规范 specifier（`@ui-sdk/react/<component>`）。升级时用 `rg -n "@ui-sdk/"` 列全引用；本地变量或组件名可以另起，不影响按包路径检索。

**为何不用 `@ui-sdk/react/trigger-menu`**：ui-sdk 另有 trigger-menu，可用 `editor` + `textFieldAdapter` 接现有 textarea 专门做 @ 触发，本项目未采用。`TriggerMenuContent` 是光标锚定浮层，而本产品提及面板是 composer 上方整宽内联列表、每项带「运行中」徽标，textarea 生命周期归 Composer（附件、取消运行、尺寸等），迁移会改动已批准的视觉与布局基线。因此用官方组合 `createListbox({ focus: 'virtual' })` 实现，属于官方能力组合而非兼容层；若将来提及面板改为浮层形态，可迁到 trigger-menu。

**为何 `message-scroller` 保留官方 `@shadcn/react`**：`packages/web/src/components/ui/message-scroller.tsx`（聊天消息滚动容器）继续使用官方 `@shadcn/react/message-scroller`，属允许栈（packages/web 规则「只用 shadcn/ui」）。ui-sdk 无消息级等价物：`@ui-sdk/react/scroll-area` 只有 `stickToEnd`（跟随末尾）、`ScrollAreaScrollToEnd`（回到底部按钮）与 edge fades，缺聊天所需的可见消息追踪（`useMessageScrollerVisibility` 喂已读游标）、prepend 锚点保持（加载更早消息不跳）与 `scrollPreviousItemPeek`。整体替换等于把这些聊天特有语义手写进核心滚动路径，风险高、收益低，故保留。若将来聊天面板去掉已读游标与 prepend 需求，迁移路径是 ui-sdk `scroll-area`（`stickToEnd` + `ScrollAreaScrollToEnd`）。

## 升级步骤

0. **留证据**：从根 `package.json` catalog / `bun.lock` 记下当前 `@ui-sdk/core`/`@ui-sdk/react` 版本，并备份随包文档 `node_modules/@ui-sdk/*/docs/`（该目录随版本发布；`skills/SKILL.md` 明确「读安装副本，它匹配当前版本」）。重装会覆盖它，升级前先留一份用于 diff。
1. **读官方变更**：各包 `CHANGELOG.md`、GitHub releases（`vercel-labs/ui`）、https://ui-sdk.dev/docs 的变更；重点核对 `createParts`、`data-slot`/状态属性、`defaultValue`/`onValueChange`、`definePrimitive` 签名。
2. **定范围**：`rg -n "@ui-sdk/" packages/web/src`。
3. **改版本**：改根 `catalog` 的精确版本 → `bun install`（`bun.lock` 随之更新）。**回滚**：把 `catalog` 改回原版本再 `bun install`，或 `git restore package.json bun.lock` 后重装。
4. **兜底定位破点**：`bun run --filter @agentport/web typecheck`，报错逐个对照「升级前备份的 docs / 新版 docs」修。typecheck 只能发现类型与签名变化，发现不了 `data-*` 状态属性、默认交互行为或可访问性变化；这些必须靠第 5 步的真实渲染与测试。
5. **验证**：`bun run --filter @agentport/web build`；再跑 `bun run test:web` 与 `bun run visual:shots --full --route <受影响路由>` 对照 `packages/web/DESIGN.md`，重点核对 `data-slot`/状态属性样式没有失效、聚焦态未叠第二层框。
6. **留痕**：在本文「升级记录」追加一条（日期、from → to、改动、踩坑、验证）。当前版本不写进本文，只以根 `package.json` catalog 与 `bun.lock` 为准。

## 关注点

- `agent` / `observe` / `history` 是 experimental：升级时优先确认其 API 是否变动，用到它们的地方升级后重点复测。
- 折叠面板：不要在 `motion-collapsible` 的 `render` 里按 `state.open` 手写 `inert`。beta.6 的退场清理会清除 inert，beta.8 改为保留 owner 在退场期间写入的 inert（否则恢复退场前状态）；若 render 按 `state.open` 写 inert，关闭写入的 inert 会被保留，重开时 React 移除后又被延迟的退场清理按关闭快照写回，导致重开后仍不可聚焦。`hidden="until-found"` 的 `content-visibility:hidden` 已让关闭内容不可聚焦，交给它即可（详见 PITFALLS）。
- 隐藏表单字段：beta.8 起 Combobox/Select/Listbox 会渲染独立 `data-slot="combobox-form-input"` 的隐藏表单字段（`<textarea>`，是否 `disabled` 取决于字段配置），按 `querySelector('textarea')` 找输入框会抓错，改用可访问名称（如 `textarea[aria-label="消息"]`）。
- 升级前必做第 0 步备份安装包 `docs/`，否则只能看粒度较粗的上游 changelog。
- 依赖探测：`bun outdated --filter '*'`。

## 升级记录

| 日期 | from → to | 改动（组件/文件） | 踩坑 | 验证 |
|---|---|---|---|---|
| 2026-11-14 | 未接入 → `0.1.0-beta.2` | 全量替换 Base UI 为 ui-sdk 原生 | `@layer ui-sdk` 须在 Tailwind 前声明；`exactOptionalPropertyTypes` 的可选属性一律由调用方条件展开传入；焦点契约检查改认 `data-dragging` | typecheck/build/lint 绿；`test:web` 1926 通过、12 条既有失败 |
| 2026-11-14 | 移除 sonner / embla-carousel-react / react-day-picker / react-resizable-panels | `lib/toast` + `App.tsx`、`components/ui/{calendar,carousel}`、`openui/components/*`、`pages/chat`、`pages/plugins/plugin-detail` | resizable 的数字是百分比、像素要写 `"240px"`；jsdom 里它测不到布局，折叠/展开不能由 layout 反推状态；UI 断言不要绑定 `.rdp-*` / `data-day` / `embla` 调用 | typecheck/build/lint 绿；`test:web` 1933 通过、10 条既有失败 |
| 2026-11-14 | 移除 `@dnd-kit/*` | `components/data-table.tsx`、新增 `components/ui/sortable-list.tsx` | TanStack Table 仍是顺序唯一来源，primitive 只存拖动草稿；Escape 先取消拖动并保留弹层，Tab 取消并继续；拖动预览用 `preview` | typecheck/build 通过；`test:web` 1933 通过、10 条既有失败；`/operations` 真实浏览器验证指针/键盘/持久化 |
| 2026-11-14 | `0.1.0-beta.2`（版本不变） | 手写交互原生化：`pages/channels/channel.tsx` 提及列表改用 `components/ui/mention-list.tsx`（`createListbox` virtual focus）；`pages/servers/tool-editor-dialog.tsx`、`pages/knowledge/detail/documents-tab.tsx`、`components/knowledge/knowledge-faq.tsx` 的 `role="toolbar"` 改用 `Toolbar`/`ToolbarButton`；`components/ui/{label,textarea}.tsx` 改用 ui-sdk 原生；删除 `components/ui/*` 里全部 `Loose<T>` 垫片 | 提及列表焦点留在共享 textarea，靠 `aria-activedescendant` 关联；可选属性改在调用方条件展开 `{...(cond ? { foo } : {})}`，不再放宽类型 | typecheck 通过；`test:web` 1933 通过、10 条既有失败 |
| 2026-11-14 | `0.1.0-beta.2`（版本不变） | 手写 `<details>/<summary>` 改用 ui-sdk `Collapsible`：`pages/knowledge/detail/source-runs.tsx`、`components/knowledge/knowledge-citations.tsx`、`components/knowledge/knowledge-search.tsx`（两处） | 旧 `<details>` 正文常挂载：SyncRunItems 立即取数、折叠态文本断言依赖 DOM 保留，迁移必须 keepMounted + hiddenUntilFound；无 animated 为即时显隐；展开指示用 ChevronRight + group-aria-expanded:rotate-90（Tailwind v4 输出 rotate 属性） | build 通过；test:web 1933 通过、10 条既有失败（与基线一致）；隔离栈真实渲染验证 4 处：aria-expanded 切换、面板显隐、ChevronRight 展开旋转 90°、无 console error；截图 /tmp/visual-detail-chevron/expanded.png |
| 2026-11-18 | `0.1.0-beta.2` → `0.1.0-beta.6` | 仅根 `catalog` 改版本；`components/markdown.tsx` 静态正文链路的 sanitize 覆盖为 `clobberPrefix: ''` 并排除 `undoubleClobberPrefix`（随 streamdown 2.8.0 一同暴露） | 上游 docs 与 d.ts 以新增导出和类型放宽为主，slider 泛型、menu triggerElements、calendar isPickable 等签名有变化，本项目 typecheck 未暴露破点；实际破点是 rehype-sanitize 不再关闭 clobberPrefix，`#plugin-file=`、页内锚点与脚注 id 被改写，只剥 href 前缀会破坏脚注/回链匹配 | typecheck/build 绿；test:web 1959 通过、9 失败（其中 1 条单独重跑通过，8 条既有失败：admin-pages 缺 useRetention mock、resource-navigation 未含 /data-domains，均与依赖无关）；隔离栈真实渲染 /、/agents、/knowledge、/operations：每页 1 个 h1、无横向溢出、无 console error，专家/知识库弹层焦点在弹层内且 Escape 关闭；截图 /tmp/visual-deps-update-2026-11 |
| 2026-11-18 | `0.1.0-beta.6` → `0.1.0-beta.10` | 仅根 `catalog` 改版本（`bun install` 同步 `bun.lock`）；删两处已不必需的类型强转：`components/ui/mention-list.tsx`、`components/ui/sortable-list.tsx` 的 `options: NonNullable<...>`（beta.8 已修 `Primitive.options` 在 `exactOptionalPropertyTypes` 下的赋值）；`components/motion-collapsible.tsx` 去掉手写 `inert`；同步 3 处测试（`agents-lifecycle`、`collapsible-motion` 删 inert 断言，`expert-permission-empty` 用 `textarea[aria-label="消息"]` 定位 composer） | release notes 全为补丁/新增，无破坏性签名变更，typecheck 未暴露破点；实际破点两个：① beta.8 起 `animateOut` 保留 owner 在退场动画期间写的 `inert`，若在 `render` 里按 `state.open` 写 `inert={!open}`，收起时写入的 inert 被保留，重开时 React 移除后又被延迟的退场清理按关闭快照写回，inert 卡在面板上导致重开后字段不可聚焦（`hidden="until-found"` 的 `content-visibility:hidden` 本身已阻止关闭态聚焦，故直接删手写 inert）；② beta.8 起 Combobox/Select/Listbox 渲染独立的 `data-slot="combobox-form-input"` 隐藏表单字段（由 `<input>` 改为 `<textarea>`，是否 `disabled` 取决于字段配置），`querySelector('textarea')` 会抓到它 | typecheck/build 绿；`test:web` 154 文件 / 1969 用例全通过；隔离栈真实渲染 `/`、`/agents`、`/knowledge`、`/operations`、`/chat`（1440/1200 整页）无白屏、无横向溢出、每页单一 h1；真机 ego-browser 验证新建专家高级设置：打开可聚焦、收起不可聚焦、再展开恢复可聚焦（修复前再展开仍 inert 不可聚焦） |
| 2026-11-20 | `0.1.0-beta.10` → `0.1.0-beta.13` | 仅根 catalog 改版本（bun install 同步 bun.lock），无源码改动；typecheck 未暴露破点 | 随包 docs 差异仅文档与 experimental agent-key 措辞；core 公共 index.d.ts 完全一致；react 相关模块 d.ts 仅共享 HTML 属性（defaultChecked/defaultValue/popoverTargetAction）在继承 props 中顺序挪动，无签名变化；未见 data-slot/状态属性契约变化 | typecheck 8/8、build 8/8、test:web 159 文件/1977 用例（全量并行偶发 1–2 条既有抖动，单跑通过）；真实渲染 visual:shots 已完成（隔离栈，空闲端口 3100/5273，1440x900 与 1200x900 整页长图，路由 /、/agents、/knowledge、/operations、/chat，截图 .visual/deps-upgrade/）——无白屏、无页面级横向溢出、每页单一 h1、布局与卡片/配色正常；弹层展开、分栏拖动、频道 @ 提及等交互态未在浏览器逐一手测，相关 collapsible/aria-disabled 行为由 test:web 覆盖 |
| 2026-11-26 | `0.1.0-beta.13` → `0.1.0-beta.17` | 仅根 `catalog` 改版本（`bun install` 同步 `bun.lock`），无前端源码改动；typecheck 未暴露破点 | 对比 `/tmp/ui-sdk-docs-beta13` 与新版随包 `docs/`：`core/docs` 仅 `agents.md` 更新（`query` 新增 `from`/`closed`、`data-agent-hidden` 覆盖名称、新增服务端运行示例，本项目未使用 experimental `agent` 桥）；`react/docs/components/` 仅 `alert-dialog`/`dialog`/`drawer` 在异步动作进行时给其余 Close 补 `data-disabled`/`aria-disabled`，以及 `hover-card`/`popover`/`select`/`tabs`/`toast`/`trigger-menu` 焦点/滚动/筛选细节修复，无 API、`data-slot` 或现有状态属性破坏性变化 | typecheck 8/8、build 8/8、lint/lint:focus/lint:contract/lint:docs 绿；`test:web` 161 文件 / 1975 用例（全量并行 160 通过、1 条 `knowledge-jobs.test.ts` 既有并行抖动，单跑 18/18 通过）；`bun run visual:shots --full --route / --route /agents --route /knowledge --route /chat` 8 张 1440/1200 整页截图真实渲染通过（无白屏、无横向溢出、布局与卡片深度正常） |
| 2026-11-27 | `0.1.0-beta.17` → `0.1.0-beta.18` | 仅根 `catalog` 改版本（`bun install` 同步 `bun.lock`），无前端源码改动；typecheck 未暴露破点 | 对比 `/tmp/ui-sdk-docs-beta17` 与新版随包 `docs/` 及 `.d.ts`：`0.1.0-beta.18` 发在 npm `beta` 标签（`latest` 仍为 `beta.17`），全为补丁修复与增量能力，无破坏性签名或 `data-slot` 契约变更；重点变动包括 `Combobox`/`Command`/`Select` IME 组字期间暂缓筛选（`TextChangeDetails.composing`）、弹窗/浮层 `anchor-hidden` 自动关闭与 `Escape`/焦点退出修复、`Menu`/`Tabs` 跳过隐藏项及 `ToolbarButton` 嵌套 Toggle 合并、`Carousel` `disabled`/`--carousel-display` 等，本项目无需适配 | typecheck 8/8、build 8/8、lint/lint:focus/lint:contract/lint:docs 绿；`test:web` 161 文件 / 1976 用例全通过；`bun run visual:shots --full --no-open --route / --route /agents --route /knowledge --route /chat` 8 张 1440/1200 整页截图真实渲染通过（无白屏、无横向溢出、布局与卡片深度正常） |

### 视觉验收（真实渲染）· 2026-11-14

官方 `visual:shots` 固定端口 3000/5173 当时被开发栈占用，故改用隔离端口起栈 + 真实登录，做多视口整页长图验收；下列截图路径为本次留存。

| 项目 | 路由 / 视口 | 截图 | 结论 |
|---|---|---|---|
| 频道 @ 提及（菜单打开态） | `/channels/<id>`，1440x900 与 1200x900 整页长图 | `/tmp/visual-finish/channel-mention-1440x900-full.png`、`/tmp/visual-finish/channel-mention-1200x900-full.png` | textarea 无 `role`/`aria-expanded`，具备 `aria-autocomplete="list"`/`aria-haspopup="listbox"`/`aria-controls`/`aria-activedescendant`；方向键首尾环绕、Enter/Tab 插入、Escape 关闭后 aria-* 清除，焦点始终在 textarea；无横向溢出、单一 h1、无 console error |
| 知识库文档批量工具栏 | 1440x900 | `/tmp/toolbar-documents-1440.png` | 与 FAQ 工具栏同源表现一致；roving focus（Tab 进出一次、方向键移动、Enter 触发）、`aria-disabled`/`data-disabled` 生效、`ml-auto` 布局不变 |
| 知识库 FAQ 批量工具栏 | 1440x900 与 1200x900 | `/tmp/toolbar-faq-1440.png`、`/tmp/toolbar-faq-1200.png` | 同上；禁用态见 `/tmp/toolbar-disabled.png` |
| 新建连接器表单（label + textarea） | 1440x900 与 1200x900 | `/tmp/agentport-visual/server-dialog-1440.png`、`/tmp/agentport-visual/server-dialog-1200.png` | textarea 尺寸/`field-sizing-content`/边框/圆角/焦点环与禁用态与设计一致，点击 label 正确聚焦控件 |
| 专家行为表单 | 1440x900 与 1200x900 | `/tmp/agentport-visual/agent-behavior-1440.png`、`/tmp/agentport-visual/agent-behavior-1200.png` | 同上 |

限制：工具编辑弹层的批量工具栏未单独在浏览器实测（结构与其它两处 toolbar 同源，类型检查与代码审查通过）。
