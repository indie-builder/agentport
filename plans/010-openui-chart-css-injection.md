# Plan 010: 用内部系列键承载图表数据与样式，阻断类别名进入 CSS

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 321cf491..HEAD -- packages/web/src/components/ui/chart.tsx packages/web/src/openui/components/charts.tsx`
> If either in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `321cf491`, 2026-11-22

## Why this matters

模型生成的 OpenUI 图表把任意 `series.category` 字符串当作 `ChartConfig` 的键名；`ChartStyle` 会把这些键名原样拼进 `<style>` 文本的 `--color-${key}`。CSP 允许 `style-src 'unsafe-inline'`，因此构造含 `;`、`}` 的类别名可以跳出声明、向应用源注入任意 CSS，遮挡或伪造界面。修复从源头改：系列数据键改为内部生成的 `s0`、`s1`……，类别原文只作为标签与数据视图文本；共享 `ChartStyle` 再加一道安全键名过滤，防止其他调用方未来重新引入不可信键名。

## Current state

- `packages/web/src/components/ui/chart.tsx:79-105` — `ChartStyle` 用 `dangerouslySetInnerHTML` 生成主题变量。
- `packages/web/src/openui/components/charts.tsx:158-173` — 把模型输出的 `series.category` 原样变成 `key` 与 `label`；`buildConfig`（:187-194）再把它作为 `ChartConfig` 键名。
- `packages/api/src/http/security.ts:73-84` — CSP 含 `style-src 'self' 'unsafe-inline'`，注入的样式文本会生效。
- `packages/web/test/openui-chart-ui.test.ts:284-293` — 已覆盖「重复系列名不会互相覆盖」与中文类别；`openui-chart-ui.test.ts` 是本次主要 UI 回归。

当前 `ChartStyle`（`packages/web/src/components/ui/chart.tsx:79-105`）：

```tsx
const ChartStyle = ({ id, config }: { id: string; config: ChartConfig }) => {
  const colorConfig = Object.entries(config).filter(([, config]) => config.theme ?? config.color);

  if (!colorConfig.length) {
    return null;
  }

  return (
    <style
      dangerouslySetInnerHTML={{
        __html: Object.entries(THEMES)
          .map(
            ([theme, prefix]) => `
${prefix} [data-chart=${id}] {
${colorConfig
  .map(([key, itemConfig]) => {
    const color = itemConfig.theme?.[theme as keyof typeof itemConfig.theme] ?? itemConfig.color;
    return color ? `  --color-${key}: ${color};` : null;
  })
  .join('\n')}
}
`,
          )
          .join('\n'),
      }}
    />
  );
};
```

不可信来源（`packages/web/src/openui/components/charts.tsx:158-173`）：

```ts
function seriesFrom(input: unknown[]): SeriesEntry[] {
  const occurrences = new Map<string, number>();
  return input
    .map((node) => childProps<SeriesInput>(node))
    .filter((series): series is SeriesInput => !!series && typeof series.category === 'string')
    .map((series) => {
      const count = (occurrences.get(series.category) ?? 0) + 1;
      occurrences.set(series.category, count);
      return {
        category: series.category,
        label: count === 1 ? series.category : `${series.category} (${count})`,
        key: count === 1 ? series.category : `${series.category}·${count}`,
        values: asArray(series.values ?? []).map(finiteValue),
      };
    });
}
```

`buildConfig` 与 `buildRows`（`charts.tsx:177-194`）：

```ts
function buildRows(labels: string[], series: SeriesEntry[]): ChartRow[] {
  return labels.map((label, index) => {
    const row: ChartRow = { category: label };
    for (const item of series) {
      row[item.key] = item.values[index] ?? null;
    }
    return row;
  });
}

function buildConfig(series: SeriesEntry[], icons: readonly ComponentType[]): ChartConfig {
  return Object.fromEntries(
    series.map((item, index) => [
      item.key,
      { label: item.label, color: seriesTone(index), icon: icons[index] ?? (() => null) },
    ]),
  );
}
```

已核实的其他 `ChartContainer` 调用方键名都是字面安全值：`overview-trend-chart.tsx:12-15`（`runs`、`failed`）、`eval/pass-rate-chart.tsx:26-28`（`ratePct`）、`chat-thread/data-domain-result.tsx:119-121`（`value`）。OpenUI 图表颜色来自 `seriesTone(index)` 内联值，不依赖 `ChartStyle` 生成的变量，因此改键名不会改变图表配色。

仓库约定：

- 不写代码注释（根 `AGENTS.md`）。
- 不为单个修复新增单测；验证用现有 web 测试、类型检查、构建与真实渲染验收（`packages/web/AGENTS.md`「验证」「UI 验收」）。

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install --frozen-lockfile` | exit 0 |
| Web typecheck | `bun run --filter @agentport/web typecheck` | exit 0 |
| Chart UI tests | `bunx vitest run --config packages/web/vitest.config.ts packages/web/test/openui-chart-ui.test.ts` | all pass |
| All web tests | `bun run test:web` | all pass |
| Web build | `bun run --filter @agentport/web build` | exit 0 |
| OpenUI gate | `bun run openui:check` | exit 0 |
| Format/lint (read-only) | `bunx biome check packages/web/src/components/ui/chart.tsx packages/web/src/openui/components/charts.tsx` | 0 error |
| Visual acceptance | `bun run visual:shots --full --route /` | screenshots produced, no page-level horizontal overflow |

## Scope

**In scope**:
- `packages/web/src/openui/components/charts.tsx`
- `packages/web/src/components/ui/chart.tsx`
- `packages/web/test/openui-renderer.test.ts`（只把既有断言 `--color-收入` 更新为内部键 `--color-s0`）

**Out of scope**:
- 其他 `ChartContainer` 调用方与图表配色 — 键名已安全，颜色是内部值。
- CSP 与 `security.ts` — 不放宽、不收紧。
- `ChartConfig` 类型、图例/提示/数据视图的文案与排序。

## Git workflow

- 按 `docs/DEV-WORKFLOW.md` §2 在 `.claude/worktrees/<slug>` 内工作，分支名用 ASCII slug。
- 提交信息沿用仓库 conventional commits，例如 `fix(web): 用内部系列键承载图表数据与样式`。
- 不推送、不开 PR，除非操作者明确要求。

## Steps

### Step 1: 系列键改为内部生成，类别只做标签

`charts.tsx` 有两条模型输入路径会生成 `ChartConfig` 键：XY/雷达图的 `seriesFrom` 与饼图/单条堆叠图的 `buildSlices`。两处都要改。

在 `seriesFrom` 中，把 `.map((series) => ...)` 改为带索引，并让 `key` 只由索引生成：

```ts
    .map((series, index) => {
      const count = (occurrences.get(series.category) ?? 0) + 1;
      occurrences.set(series.category, count);
      return {
        category: series.category,
        label: count === 1 ? series.category : `${series.category} (${count})`,
        key: `s${index}`,
        values: asArray(series.values ?? []).map(finiteValue),
      };
    });
```

在 `buildSlices` 中做同样修改（`labels.map((category, index) => ...)` 已经有 `index`）：

```ts
      return {
        category,
        label: count === 1 ? category : `${category} (${count})`,
        key: `s${index}`,
        value: finiteValue(values[index]),
      };
```

保留 `category` 字段：`buildRows` 用它作为 X 轴分类值，`label` 继续用于图例与数据视图。`sliceRows` 已使用 `slice.label`，不受影响。不要改 `buildConfig`、`sliceConfig`、`buildRows`、`seriesTone` 或任何图例/提示组件。

**Verify**: `rg -n 'key: `s\$\{index\}`' packages/web/src/openui/components/charts.tsx` → 2 处命中；`bunx vitest run --config packages/web/vitest.config.ts packages/web/test/openui-chart-ui.test.ts` → 全部通过（含重复系列名、饼图、单条堆叠图与中文类别）。

### Step 2: 共享样式生成为安全键名加过滤

在 `packages/web/src/components/ui/chart.tsx` 的 `ChartStyle` 上方定义只匹配 CSS 自定义属性名安全字符的正则，并在 `colorConfig` 过滤条件中加入该正则：

```tsx
const SAFE_CHART_KEY = /^[A-Za-z0-9_-]+$/;

const ChartStyle = ({ id, config }: { id: string; config: ChartConfig }) => {
  const colorConfig = Object.entries(config).filter(
    ([key, config]) => SAFE_CHART_KEY.test(key) && (config.theme ?? config.color),
  );
```

不要修改 `--color-${key}` 模板、`THEMES`、`id` 或 `dangerouslySetInnerHTML` 的其他部分。不要新增注释。

**Verify**: `rg -n 'SAFE_CHART_KEY' packages/web/src/components/ui/chart.tsx` → 两处命中（定义与使用）。

### Step 3: 类型检查、测试、构建

```bash
bun run --filter @agentport/web typecheck
bunx vitest run --config packages/web/vitest.config.ts packages/web/test/openui-chart-ui.test.ts
bun run test:web
bun run --filter @agentport/web build
bun run openui:check
bunx biome check packages/web/src/components/ui/chart.tsx packages/web/src/openui/components/charts.tsx
```

全部 exit 0；测试无失败。

### Step 4: 真实渲染验收

**Verify**: `bun run visual:shots --full --route /` → 生成整页长图；打开截图确认概览页趋势图正常渲染、无白屏、无页面级横向溢出、恰好一个 `h1`。

概览页只覆盖共享组件的普通调用方。OpenUI 对话图表的实际渲染由 `openui-chart-ui.test.ts` 覆盖（含中文类别与重复系列名）；若环境允许，另外打开一个含图表的会话确认图例、X 轴与数据视图文本仍是原始类别名。

## Test plan

- 不新增单元测试（根 `AGENTS.md`）。
- `openui-chart-ui.test.ts` 是主要回归：重复系列名、中文类别、数据视图、图例文本都必须保持。
- 安全回归由结构保证：系列 `key` 只来自索引；`ChartStyle` 只发出匹配 `[A-Za-z0-9_-]+` 的键。

## Done criteria

- [ ] `seriesFrom` 与 `buildSlices` 的 `key` 均为 `` `s${index}` ``，`label` 仍使用原始类别与重复计数
- [ ] `ChartStyle` 的 `colorConfig` 同时检查 `SAFE_CHART_KEY.test(key)` 与颜色存在
- [ ] `bunx vitest run --config packages/web/vitest.config.ts packages/web/test/openui-chart-ui.test.ts` 全部通过
- [ ] `bun run --filter @agentport/web typecheck` exit 0
- [ ] `bun run test:web` 全部通过
- [ ] `bun run --filter @agentport/web build` exit 0
- [ ] `bun run openui:check` exit 0
- [ ] `bunx biome check` 对两个 in-scope 文件 0 error
- [ ] 视觉验收截图存在，概览页趋势图正常
- [ ] `git status --porcelain` 只显示两个 in-scope 文件与 `plans/README.md`

## STOP conditions

Stop and report back (do not improvise) if:

- `seriesFrom`、`buildConfig` 或 `ChartStyle` 与上面的 excerpt 不一致（代码已漂移）。
- `openui-chart-ui.test.ts` 断言了 `key` 必须等于类别名（若存在，说明数据视图或提示依赖它；先报告，不擅自改测试）。
- 去掉不安全键名后现有图表测试出现颜色、图例或数据视图断言失败。
- 需要修改 CSP、其他图表调用方或 `ChartConfig` 类型才能让测试通过。
- `bun run visual:shots` 因环境原因无法启动（报告未做视觉验收，不声称通过）。

## Maintenance notes

- 未来任何把外部字符串作为 `ChartConfig` 键名的新图表都会经过这两道防护；若需要支持含点号或空格的键名，先确认 CSS 自定义属性名语义，不要直接放宽正则。
- 评审重点：`key` 不再包含任何类别字符；`ChartStyle` 的过滤发生在 `dangerouslySetInnerHTML` 之前的唯一入口；没有第二处 `<style>` 拼接。
- 本次不处理颜色值 `itemConfig.color` 的注入面：现有颜色来自内部常量或 `seriesTone()`，没有不可信来源。
