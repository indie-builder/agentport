# 字体阶梯：补档位、修层级倒挂

## 目标
审计全项目字号：内容区（对话正文）与各页面（首页、专家、运行、定时任务）的实际渲染字号，修掉阶梯缺口与层级倒挂。

## 审计发现的 5 个问题
1. Markdown 标题比正文小（H1 14px、H2 13px，正文 15px），层级靠间距与加粗硬撑。
2. 页面标题 16px、对话标题 15px、欢迎标题 20/24px，同一层级三种尺寸，相邻 1px 肉眼分不出。
3. 两套徽章字号：`Badge` 12px、`StatusBadge` 11px（且 `leading-none` 让 12px 文本挤在 12px 行盒）。
4. 小按钮 `text-[0.8rem]`（12.8px）不在阶梯上。
5. 15px 到 24px 之间没有台阶；正文两种行高并存（气泡 24px、助手 25.5px）。

## 方案
阶梯补到 9 档，每档语义唯一：

| Token | 尺寸 / 行高 | 用途 |
| --- | --- | --- |
| `2xs` | 11 / 16 | 密集只读数据的次要行列（trace、ID、分组小标签） |
| `xs` | 12 / 16 | 元信息、所有徽章 |
| `sm` | 13 / 20 | 界面默认 |
| `base` | 14 / 22 | 列表与卡片标题 |
| `md` | 15 / 26 | 阅读正文 |
| `lg` | 16 / 24 | 页面标题、对话标题 |
| `xl` | 18 / 26 | Markdown H1 |
| `2xl` | 20 / 28 | 欢迎标题（窄屏） |
| `3xl` | 24 / 32 | 欢迎标题（桌面）、主统计 |

## 改动
- `packages/web/src/styles.css`：`lg` 从 24/30 改为 16/24；新增 `xl` 18/26、`2xl` 20/28、`3xl` 24/32；`base` 行高 24 → 22；`md` 行高 24 → 26。
- `packages/web/src/components/page.tsx`：页面 h1 `text-[16px]` → `text-lg`。
- `packages/web/src/pages/chat.tsx`：对话标题 `text-[15px]` → `text-lg`；欢迎标题 `text-[20px] sm:text-lg` → `text-2xl sm:text-3xl`；用户气泡去掉 `leading-relaxed`；折叠大文本去掉 `leading-[1.7]`。
- `packages/web/src/components/markdown.tsx`：H1 `text-base` → `text-xl`、H2 → `text-lg`、H3–H6 → `text-md`，字重 500 → 600；正文去掉 `leading-[1.7]`，改由 `md` 的 26px 行高承担。
- `packages/web/src/pages/run-detail.tsx`：运行步骤正文去掉 `leading-relaxed`。
- `packages/web/src/components/status-badge.tsx`：去掉 `text-2xs` 与 `leading-none`，字号继承 Badge 的 `xs`。
- `packages/web/src/components/ui/button.tsx` / `toggle.tsx`：`text-[0.8rem]` → `text-sm`。
- `packages/web/src/pages/overview.tsx` / `ops.tsx`：统计数字 `text-lg` → `text-3xl`。
- `docs/DESIGN-SYSTEM.md` §4：写入字号阶梯表与 Markdown 标题规则。

## 验证
- `pnpm --filter @agentport/web exec tsc --noEmit`：通过。
- `pnpm exec vitest run --project web`：281 用例通过。
- `biome check`（11 个改动文件）+ `lint:focus` + `lint:contract`：通过。
- 浏览器实测 Markdown 层级：H1 18/26/600、H2 16/24/600、H3 15/26/600、正文 15/26/400、列表项 15/26/400——全部 ≥ 正文。
- 浏览器实测行高一致：用户气泡与助手正文同为 `15px / 26px`。
- 浏览器实测页面（`/`、`/agents`、`/runs`、`/ops`）：h1 统一 `16/24/500`；徽章统一 `12/16/500`（此前为 11px 且行高 11px）；全项目已无 `text-[15px]` / `text-[16px]` / `text-[20px]` / `text-[0.8rem]` 硬编码。
