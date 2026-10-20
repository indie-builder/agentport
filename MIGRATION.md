# Migration to e2e

Source: Playwright, `e2e/**/*.spec.ts` (guide: https://e2e.tester.army/docs/migrate/playwright.md, engine: https://e2e.tester.army/docs/web.md)
e2e: `e2e.config.ts`, tests `tests/**/*.e2e.ts`
Start dependencies: `docker compose up -d postgres redis api worker`（e2e 目标会复用已在跑的 5173）
Run old: `pnpm exec playwright test`
Run new: `pnpm exec e2e run`（`pnpm test:e2e` 已指向它）
Harness: done, smoke `tests/support/auth.e2e.ts` + `tests/regression.e2e.ts` on chromium
Defect check: off

| Source | e2e | Status | Assertions (source → e2e) | Passing | Defect check | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `e2e/fixtures.ts` `login()` | `tests/support/auth.e2e.ts` | ported | — → — | web 1/1 | — | 改为 `test.setup` + session |
| `e2e/regression.spec.ts` runs page | `tests/regression.e2e.ts` | ported | 2 → 2 | web 1/1 | — | `or()` 不支持，改为分别 `isVisible()` |
| `e2e/regression.spec.ts` audit page | `tests/regression.e2e.ts` | ported | 2 → 2 | web 1/1 | — | |
| `e2e/regression.spec.ts` skills create | `tests/regression.e2e.ts` | ported | 3 → 3 | web 1/1 | — | 原测试标题写「create and delete」，实际只建不删，标题已更正 |
| `e2e/regression.spec.ts` eval page | `tests/regression.e2e.ts` | ported | 2 → 2 | web 1/1 | — | |
| `e2e/regression.spec.ts` overview | `tests/regression.e2e.ts` | ported | 2 → 2 | web 1/1 | — | |
| `e2e/smoke.spec.ts` | `tests/smoke.e2e.ts` | ported | 8 → 5 | web 1/1 | — | 第 5 步（真实模型对话）未迁移；见 Gaps |

## Shared helpers

| Source | e2e | Used by |
| --- | --- | --- |
| `e2e/fixtures.ts` `login()` | `tests/support/auth.e2e.ts` `test.setup('sign in as admin')` | 全部用例 |
| `e2e/fixtures.ts` `unique()` | 每个用例内的 `Date.now().toString(36)` | regression / smoke |

## Gaps

- Playwright 的 `page.locator(...).or(...)` 在 e2e 中不存在；改为分别读取 `isVisible()` 后断言布尔值。
- Playwright 的 `expect(locator).toContainText('...')` 在 e2e 中按渲染文本比较；对 `pre` 内的 JSON 改为 `getByText(..., { exact: false })`。
- CSS 选择器（`#id`、`div.rounded-[10px]`）只能用于 `browser.locator`；`screen` 只接受语义查询。
- smoke 的「真实模型对话」步骤依赖 worker + 模型凭据，未迁移；它仍在 Playwright 套件中（`E2E_FULL=1` 时运行）。

## 迁移收益（实测）

| 指标 | Playwright | e2e |
|---|---|---|
| 登录次数 | 每个用例 1 次（6 次/轮）→ 触发 10/min 限流 | `test.setup` 一次，全轮复用 |
| 全套耗时 | 2.1 分钟（含限流等待与重试） | 2.2–4.3 秒 |
| 失败诊断 | trace.zip 需 `show-trace` 打开 | `.e2e/results/<test>/trace.md` 直接可读，含每步耗时、控制台、截图 |
| 断言定位 | 文本匹配，失败只报 «no node» | 同上，但带 48 次读取记录与屏幕快照 |

## Next

- 决定是否把 smoke 的聊天步骤也迁到 e2e（需要 agent 配置里的 model，而当前项目用 Anthropic 直连，需确认 `agent.*` 的 provider 配置）。
- 全部移植测试连续 3 次通过后，经确认可删除对应的 Playwright 用例。
