# Migration to e2e

Source: Playwright, `e2e/**/*.spec.ts`（已删除）(guide: https://e2e.tester.army/docs/migrate/playwright.md, engine: https://e2e.tester.army/docs/web.md)
e2e: `e2e.config.ts`, tests `tests/**/*.e2e.ts`
Start dependencies: `docker compose up -d postgres redis api worker`（e2e 目标会复用已在跑的 5173）
Run old: 已退役（Playwright 依赖与配置已移除）
Run new: `pnpm exec e2e run`（`pnpm test:e2e` 已指向它）
Harness: done, smoke `tests/support/auth.e2e.ts` + `tests/regression.e2e.ts` on chromium
Defect check: off

| Source | e2e | Status | Assertions (source → e2e) | Passing | Defect check | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `e2e/fixtures.ts` `login()` | `tests/support/auth.e2e.ts` | ported | — → — | web 1/1 | — | 改为 `test.setup` + session |
| `e2e/regression.spec.ts` runs page | `tests/regression.e2e.ts` | retired | 2 → 2 | web 1/1 | — | `or()` 不支持，改为分别 `isVisible()` |
| `e2e/regression.spec.ts` audit page | `tests/regression.e2e.ts` | retired | 2 → 2 | web 1/1 | — | |
| `e2e/regression.spec.ts` skills create | `tests/regression.e2e.ts` | retired | 3 → 3 | web 1/1 | — | 原测试标题写「create and delete」，实际只建不删，标题已更正 |
| `e2e/regression.spec.ts` eval page | `tests/regression.e2e.ts` | retired | 2 → 2 | web 1/1 | — | |
| `e2e/regression.spec.ts` overview | `tests/regression.e2e.ts` | retired | 2 → 2 | web 1/1 | — | |
| `e2e/smoke.spec.ts` | `tests/smoke.e2e.ts` | retired | 8 → 8 | web 2/2 | — | 聊天步骤已迁移，用 `agent.waitFor`；`E2E_FULL=1` 时运行 |

## Shared helpers

| Source | e2e | Used by |
| --- | --- | --- |
| `e2e/fixtures.ts` `login()` | `tests/support/auth.e2e.ts` `test.setup('sign in as admin')` | 全部用例 |
| `e2e/fixtures.ts` `unique()` | 每个用例内的 `Date.now().toString(36)` | regression / smoke |

## 迁移中解决的差异

- `locator.or()` 不存在 → 分别 `isVisible()` 后断言布尔值。
- `toContainText` 按渲染文本比较 → JSON 预览改用 `getByText(..., { exact: false })`。
- CSS 选择器只能用于 `browser.locator`；`screen` 只接受语义查询。
- 原生 `<select>` 用 `selectOption({ index })`，不是 `getByRole('option')`。
- `agent.*` 需要模型：用 `@ai-sdk/openai-compatible` 复用项目已有的 Anthropic 代理端点。

## Gaps

- 无。Playwright 套件已全部退役，依赖与配置已删除。

## 迁移收益（实测）

| 指标 | Playwright | e2e |
|---|---|---|
| 登录次数 | 每个用例 1 次（6 次/轮）→ 触发 10/min 限流 | `test.setup` 一次，全轮复用 |
| 全套耗时 | 2.1 分钟（含限流等待与重试） | 2.2–4.3 秒 |
| 失败诊断 | trace.zip 需 `show-trace` 打开 | `.e2e/results/<test>/trace.md` 直接可读，含每步耗时、控制台、截图 |
| 断言定位 | 文本匹配，失败只报 «no node» | 同上，但带 48 次读取记录与屏幕快照 |

## Status

**迁移完成**。Playwright 依赖、配置与测试文件均已移除；`pnpm test:e2e` 只运行 e2e。
