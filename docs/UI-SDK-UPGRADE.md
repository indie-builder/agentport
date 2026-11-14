# UI SDK 升级手册

> 目标：ui-sdk（`@ui-sdk/*`）发新版时，用最小改动、可验证的步骤完成升级，不靠记忆改代码。范式与 [OPENUI-UPGRADE.md](OPENUI-UPGRADE.md) 一致。
> 本文件同时是「接入 + 升级」的基线：ui-sdk 已接入，版本、落点与升级步骤以本文表格与记录为准。

## 接入方式（原生直连，不套层）

- 直接 `import "@ui-sdk/react/<component>"`，用原生 `Root/Part` 组合与 `render`（不是 `asChild`）；受控/非受控用 `defaultValue` / `value + onValueChange`。
- 不自造 wrapper/facade 层，不镜像成 shadcn 旧签名；升级落点就是各组件文件本身。
- 样式只从 `packages/web/src/styles.css` 的 token 取，按 `data-slot` 与状态属性（`data-open`/`data-pressed`）选择；默认皮肤 `web.css` 不用。
- 自定义组件用 `@ui-sdk/core` 的 `definePrimitive` 定义行为，再用 `@ui-sdk/react/primitive` 的 `createParts` 映射成 React 部件，写在本仓库；参考随包 `docs/` 与 `skills/SKILL.md`。

## 版本基线

| 包 | 锁定版本 | 用途 |
|---|---|---|
| `@ui-sdk/core` | `0.1.0-beta.2` | 行为/primitive 层 |
| `@ui-sdk/react` | `0.1.0-beta.2` | React 适配器 |

- 两者必须同版本：上游 changesets 配置为 `fixed: [["@ui-sdk/*"]]`，所有包强制一起发版。
- 版本只在根 `package.json` 的 `catalog` 精确 pin（不用 `^`），`packages/web/package.json` 用 `"catalog:"` 引用；升级只改这一处再 `bun install`。

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
| `packages/web/src/components/ui/{badge,attachment,bubble,marker}.tsx` | `@ui-sdk/react/primitive` | `renderElement`、`PartProps` 的形状 |
| `packages/web/src/lib/toast.ts`、`App.tsx` | `@ui-sdk/react/toast` | `createToaster` 选项、`ToastRegion` 的位置/`maxVisible`、`Toast*` part 的渲染函数签名 |
| `packages/web/src/components/ui/{calendar,carousel}.tsx` | `@ui-sdk/react/{calendar,carousel}` | 日期值形状（ISO 字符串）、`CalendarDay` 状态字段、`CarouselViewport` 结构与 `aria-disabled` |
| `packages/web/src/openui/components/{forms,data,shared,layout}.tsx` | 经 ui 组件间接使用 | 生成式 UI 里日历/轮播的取值与 DOM 断言 |
| `packages/web/src/pages/{chat,plugins/plugin-detail}.tsx` | `@ui-sdk/react/resizable` | 尺寸单位（数字=百分比，像素用 `"240px"`）、`onLayoutChange/onLayoutCommit` 的 `reason`、`createResizableController` |
| `packages/web/src/components/**` | 经 ui 组件间接使用 | 是否绕过 ui 组件直接 import |

> 纪律：任何 `@ui-sdk/*` 的 import 都保持规范 specifier（`@ui-sdk/react/<component>`）。升级时用 `rg -n "@ui-sdk/"` 列全引用；本地变量或组件名可以另起，不影响按包路径检索。

## 升级步骤

0. **留证据**：记下当前 `@ui-sdk/core`/`@ui-sdk/react` 版本，并备份随包文档 `node_modules/@ui-sdk/*/docs/`（该目录随版本发布；`skills/SKILL.md` 明确「读安装副本，它匹配当前版本」）。重装会覆盖它，升级前先留一份用于 diff。
1. **读官方变更**：各包 `CHANGELOG.md`、GitHub releases（`vercel-labs/ui`）、https://ui-sdk.dev/docs 的变更；重点核对 `createParts`、`data-slot`/状态属性、`defaultValue`/`onValueChange`、`definePrimitive` 签名。
2. **定范围**：`rg -n "@ui-sdk/" packages/web/src`。
3. **改版本**：改根 `catalog` 的精确版本 → `bun install`（`bun.lock` 随之更新）。
4. **兜底定位破点**：`bun run --filter @agentport/web typecheck`，报错逐个对照「升级前备份的 docs / 新版 docs」修。typecheck 只能发现类型与签名变化，发现不了 `data-*` 状态属性、默认交互行为或可访问性变化；这些必须靠第 5 步的真实渲染与测试。
5. **验证**：`bun run --filter @agentport/web build`；再跑 `bun run test:web` 与 `bun run visual:shots --full --route <受影响路由>` 对照 `packages/web/DESIGN.md`，重点核对 `data-slot`/状态属性样式没有失效、聚焦态未叠第二层框。
6. **留痕**：更新本文「版本基线」，并在「升级记录」追加一条。

## 关注点

- `agent` / `observe` / `history` 是 experimental：升级时优先确认其 API 是否变动，用到它们的地方升级后重点复测。
- 升级前必做第 0 步备份安装包 `docs/`，否则只能看粒度较粗的上游 changelog。
- 依赖探测：`bun outdated`。

## 升级记录

| 日期 | from → to | 改动（组件/文件） | 踩坑 | 验证 |
|---|---|---|---|---|
| 2026-11-14 | 未接入 → `0.1.0-beta.2` | 全量替换 Base UI 为 ui-sdk 原生 | `@layer ui-sdk` 须在 Tailwind 前声明；`exactOptionalPropertyTypes` 需 `Loose<T>` 包装；焦点契约检查改认 `data-dragging` | typecheck/build/lint 绿；`test:web` 1926 通过、12 条既有失败 |
| 2026-11-14 | 移除 sonner / embla-carousel-react / react-day-picker / react-resizable-panels | `lib/toast` + `App.tsx`、`components/ui/{calendar,carousel}`、`openui/components/*`、`pages/chat`、`pages/plugins/plugin-detail` | resizable 的数字是百分比、像素要写 `"240px"`；jsdom 里它测不到布局，折叠/展开不能由 layout 反推状态；UI 断言不要绑定 `.rdp-*` / `data-day` / `embla` 调用 | typecheck/build/lint 绿；`test:web` 1933 通过、10 条既有失败 |
| 2026-11-14 | 移除 `@dnd-kit/*` | `components/data-table.tsx`、新增 `components/ui/sortable-list.tsx` | TanStack Table 仍是顺序唯一来源，primitive 只存拖动草稿；Escape 先取消拖动并保留弹层，Tab 取消并继续；拖动预览用 `preview` | typecheck/build 通过；`test:web` 1933 通过、10 条既有失败；`/operations` 真实浏览器验证指针/键盘/持久化 |
