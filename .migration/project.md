# project — Radix → Base UI

2026-10-21 · 手工转换（legacy `new-york` 风格没有 base 对应版本，CLI 无法生成）· 8 个 wrapper 全部迁移完成，radix 依赖已移除。

## 策略

`components.json` 的 style 是 `new-york` —— 这是旧式注册表风格，**没有 `base-new-york`**。
按技能规则：legacy 风格只能用转换引擎，不能用 golden pair。因此保留原有全部 class
（这些 class 已按 `docs/DESIGN-SYSTEM.md` 改成项目令牌），只替换行为层与结构。

`components.json` 的 `base` 从 `radix` 改为 `base-ui`，`style` 保持 `new-york`。

## 结构映射（radix → Base UI）

| radix | Base UI | 说明 |
|---|---|---|
| `Content`（自带定位） | `Positioner` + `Popup` | 定位属性在 Positioner，外观在 Popup |
| `Overlay`（Dialog） | `Backdrop` | 改名 |
| `Content`（Collapsible） | `Panel` | 改名 |
| `asChild` | `render={<El />}` | 全项目统一 |
| `onSelect`（MenuItem） | `onClick` | Base UI 没有 onSelect |
| `delayDuration` | `delay` | Tooltip Provider |
| `forceMount` | `keepMounted` | Collapsible Panel |
| `data-[state=open/closed]` | `data-[open]/[closed]` | 
| `--radix-*-trigger-width` | `--anchor-width` | Select / Popover |

## 改动文件

- `components/ui/collapsible.tsx` — Content → Panel，forceMount → keepMounted
- `components/ui/tooltip.tsx` — Portal > Positioner > Popup；delayDuration → delay
- `components/ui/popover.tsx` — 同上；删除无人使用的 PopoverAnchor
- `components/ui/dialog.tsx` — Overlay → Backdrop
- `components/ui/dropdown-menu.tsx` — radix DropdownMenu → Base UI Menu；只保留实际使用的 5 个部件（Sub/Radio/Checkbox 本项目无使用方，删除）
- `components/ui/sheet.tsx` — 同 Dialog，Content → Popup
- `components/ui/select.tsx` — Content → Positioner+Popup+List；`--anchor-width`
- `components/ui/multi-select.tsx` — `onOpenAutoFocus` → `initialFocus`，`--radix-popover-trigger-width` → `--anchor-width`
- `components/app-shell.tsx`、`pages/agents.tsx`、`pages/servers.tsx`、`components/data-table.tsx` — 调用点：asChild → render、onSelect → onClick
- `packages/web/package.json` — 移除 `radix-ui`
- `packages/web/components.json` — base: radix → base-ui

残留扫描：`grep -rn "radix-ui" packages/web/src` → **0**；`data-[state=` → **0**；`--radix-` → **0**。

## 未触碰

- `sonner`（toast）— 不是 radix，按技能规则不动
- `dnd-kit`、`motion`、`react-resizable-panels`、`zustand` — 与底座库无关
- `ui/badge`、`ui/button`、`ui/input`、`ui/label`、`ui/skeleton`、`ui/table`、`ui/textarea` — 本来就不依赖 radix

## 行为差异（已确认，未修补）

- **Menu 关闭时机**：Base UI 默认点击 item 后关闭，与 radix 一致，实测无差异。
- **Select 空值编码**：radix 用 `''` 表示未选中；Base UI 用 `null`。wrapper 内部仍用
  `__empty__` 哨兵转发，对外 API（`value: string`）不变。
- **Sheet 无侧滑动画**：原实现已按 DESIGN-SYSTEM §9 去掉位移，只保留淡入淡出，本次未改变。

## 验证

- typecheck 7 包 · biome 190 文件 · 179 单测 · web build
- 浏览器实测：/servers 的 Select 开合（4 个选项）、行操作 Menu、新建 Server Dialog 均正常
- 视觉对比迁移前后截图：布局、间距、圆角、字号无变化（「来源」列换行是迁移前就有的）

## 遗留

`components.json` 的 style 仍是 `new-york`（legacy），CLI 未来 `shadcn add` 可能仍给 radix 变体；
新增组件需手工改底座或单独处理。按用户决定保留此状态以维持视觉不变。
