---
name: getting-started
description: TanStack Table v9 React：创建与渲染表格、Table state 与订阅、feature 排障及 v8→v9 迁移。Used for `@tanstack/react-table` table tasks; shared APIs live in `@tanstack/table-core`.
metadata:
  type: framework
  library: '@tanstack/react-table'
  library_version: '9.3.1'
  framework: react
requires:
  - '@tanstack/table-core#core'
sources:
  - TanStack/table:docs/framework/react/guide/migrating.md
  - TanStack/table:examples/react/basic-use-table
  - TanStack/table:packages/react-table/src/index.ts
  - TanStack/table:docs/framework/react/guide/composable-tables.md
  - TanStack/table:docs/framework/react/guide/table-context.md
  - TanStack/table:examples/react/composable-tables
  - TanStack/table:packages/react-table/src/createTableHook.tsx
  - TanStack/table:packages/react-table/src/createTableHookContexts.tsx
  - TanStack/table:examples/react/with-tanstack-query
  - TanStack/table:examples/react/virtualized-infinite-scrolling
  - TanStack/table:docs/framework/react/guide/pagination.md
  - TanStack/table:docs/framework/react/guide/virtualization.md
  - TanStack/table:examples/react/virtualized-rows
  - TanStack/table:examples/react/virtualized-columns
---

> **Project convention（适用于本文件及关联引用）：** 本项目使用 `@tanstack/react-table@9.3.1`（与上游技能元数据一致），只安装 React 入口；其余官方技能直接读已安装 npm 包内的文件，不安装 `intent` 或新增依赖，依赖缺失先 `pnpm install --frozen-lockfile`。所有文档中的 `intent load` 都改为直接读包内技能：React 根目录为 `packages/web/node_modules/@tanstack/react-table/skills/`（含 `table-state`、`migrate-v8-to-v9`）；core 为解析该路径真实目录后同层的 `../table-core`（即 `readlink -f packages/web/node_modules/@tanstack/react-table/../table-core`，不假定 web `node_modules` 直接可达 `@tanstack/table-core`，不硬编码 `.pnpm` 版本），其 `skills/` 含 `core`、`table-state`、`table-features`、`custom-features`、`migrate-v8-to-v9`。表格沿用现有 `packages/web/src/components/data-table.tsx`、`components/ui/table.tsx`、shadcn/Base UI 与 `docs/DESIGN-SYSTEM.md` 的视觉，不另造表格壳。状态职责：服务端数据与请求参数用 TanStack Query；可导航的分页、筛选、排序用 TanStack Router `validateSearch` 与 URL；表内临时交互归 Table 官方 state；跨组件的非服务端状态才用 Zustand，保持单一 owner。`@tanstack/react-store` 是 Table 官方内部订阅机制，不是第二套应用共享状态。不引入 `@tanstack/react-virtual` 或其他依赖；确有虚拟化需求时先按包内 `with-tanstack-virtual.md` 核对现有依赖。按任务实际需求做最小完整改动，示例里的 `node_modules/...` 路径按当前 worktree 解析。

# React Table setup and integration

Before starting, read the shared headless model and stable-input rules from the installed core skill: resolve `packages/web/node_modules/@tanstack/react-table` to its real directory, then read the sibling `../table-core/skills/core/SKILL.md`.

## Setup

```tsx
import { useState } from 'react'
import {
  createColumnHelper,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'

type Person = { name: string; age: number }
const features = tableFeatures({})
const helper = createColumnHelper<typeof features, Person>()
const columns = helper.columns([
  helper.accessor('name', { header: 'Name' }),
  helper.accessor('age', { header: 'Age' }),
])

export function PeopleTable() {
  const [data] = useState<Person[]>([{ name: 'Ada', age: 36 }])
  const table = useTable({ features, columns, data })

  return (
    <table>
      <thead>
        {table.getHeaderGroups().map((group) => (
          <tr key={group.id}>
            {group.headers.map((header) => (
              <th key={header.id}>
                {header.isPlaceholder ? null : (
                  <table.FlexRender header={header} />
                )}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr key={row.id}>
            {row.getAllCells().map((cell) => (
              <td key={cell.id}>
                <table.FlexRender cell={cell} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
```

Table produces models and state; React owns the semantic markup, styles, event affordances, and accessibility.

## Essential constraints

Use `useTable` for v9. Keep `features`, `columns`, and fallback data at module scope or in stable state/memos. A new `response.data ?? []` fallback invalidates row models on every render. The default selector subscribes the owner to all registered state.

Table owns models and state. The application owns markup, CSS, interactions, and accessibility. Core-only tables use `row.getAllCells()`; visibility-aware methods need `columnVisibilityFeature`. Optional state and APIs require their features. Put row-model slots after their prerequisite features in `tableFeatures()`.

## Load by task

- For repeated features, defaults, typed contexts, or component registries, read [reusable app hooks](references/create-table-hook.md).
- For Query-backed data, server pages, sorting, filtering, or request keys, read [TanStack Query integration](references/with-tanstack-query.md).
- For virtual rows, columns, dynamic measurement, or infinite scrolling, read [TanStack Virtual integration](references/with-tanstack-virtual.md).
- For controlled state, tracked reads, or render subscriptions, read [table state](../../../packages/web/node_modules/@tanstack/react-table/skills/table-state/SKILL.md).
- For feature registration, missing feature APIs, or processing ownership, read the installed core `table-features` skill (resolved React package's sibling `../table-core/skills/table-features/SKILL.md`) and only the references needed by the task.
- For v8 code, read the [migration checklist](../../../packages/web/node_modules/@tanstack/react-table/skills/migrate-v8-to-v9/SKILL.md).

## API discovery

Inspect `node_modules/@tanstack/react-table/dist/index.d.ts`, then the exported adapter declarations for the installed version. Inspect optional core APIs under `node_modules/@tanstack/table-core/dist/features/`.
