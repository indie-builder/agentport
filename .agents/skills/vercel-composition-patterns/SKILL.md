---
name: vercel-composition-patterns
description:
  React composition patterns that scale. Use when refactoring components with
  boolean prop proliferation, building flexible component libraries, or
  designing reusable APIs. Triggers on tasks involving compound components,
  render props, context providers, or component architecture. Includes React 19
  API changes.
license: MIT
metadata:
  author: vercel
  version: '1.0.0'
---

> **Project convention（适用于本文件及关联引用）：** 本项目是 React 19 + Vite 桌面 SPA（TanStack Router/Query），不是 Next.js。组件沿用 `packages/web/src/components/ui/` 的 shadcn/Base UI 原语与 `packages/web/src/components/page.tsx` 骨架，样式只用 Tailwind 4 `@theme` token；状态归属按 `packages/web/CLAUDE.md`「状态与复用」：服务端状态用 Query，可导航状态（筛选、分页、选中的 tab/分区/文件）用 TanStack Router，跨组件非服务端的共享交互状态才用 Zustand（`packages/web/src/lib/chat-store.ts`），平台资源编辑表单用 `useZodForm`/RHF，生成式表单走 OpenUI 官方运行时，其余组件私有状态用本地 state。仅在真实复杂度出现时（多个同级组件共享状态或实际布尔属性膨胀）拆分 compound component/provider，保持 `docs/DESIGN-SYSTEM.md` 的视觉与几何；不按上游模式重写简单组件或现有 Base UI/shadcn 封装。按任务实际需求做最小完整改动，不为贴合技能新增 provider、组件库或状态库。

# React Composition Patterns

Composition patterns for building flexible, maintainable React components. Avoid
boolean prop proliferation by using compound components, lifting state, and
composing internals. These patterns make codebases easier for both humans and AI
agents to work with as they scale.

## When to Apply

Reference these guidelines when:

- Refactoring components with many boolean props
- Building reusable component libraries
- Designing flexible component APIs
- Reviewing component architecture
- Working with compound components or context providers

## Rule Categories by Priority

| Priority | Category                | Impact | Prefix          |
| -------- | ----------------------- | ------ | --------------- |
| 1        | Component Architecture  | HIGH   | `architecture-` |
| 2        | State Management        | MEDIUM | `state-`        |
| 3        | Implementation Patterns | MEDIUM | `patterns-`     |
| 4        | React 19 APIs           | MEDIUM | `react19-`      |

## Quick Reference

### 1. Component Architecture (HIGH)

- `architecture-avoid-boolean-props` - Don't add boolean props to customize
  behavior; use composition
- `architecture-compound-components` - Structure complex components with shared
  context

### 2. State Management (MEDIUM)

- `state-decouple-implementation` - Provider is the only place that knows how
  state is managed
- `state-context-interface` - Define generic interface with state, actions, meta
  for dependency injection
- `state-lift-state` - Move state into provider components for sibling access

### 3. Implementation Patterns (MEDIUM)

- `patterns-explicit-variants` - Create explicit variant components instead of
  boolean modes
- `patterns-children-over-render-props` - Use children for composition instead
  of renderX props

### 4. React 19 APIs (MEDIUM)

> **⚠️ React 19+ only.** Skip this section if using React 18 or earlier.

- `react19-no-forwardref` - Don't use `forwardRef`; use `use()` instead of `useContext()`

## How to Use

Read individual rule files for detailed explanations and code examples:

```
rules/architecture-avoid-boolean-props.md
rules/state-context-interface.md
```

Each rule file contains:

- Brief explanation of why it matters
- Incorrect code example with explanation
- Correct code example with explanation
- Additional context and references

## Full Compiled Document

For the complete guide with all rules expanded: `AGENTS.md`
