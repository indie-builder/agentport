# 共享资源页签窄窗收窄（ui-resource-tabs）

## 目标
修复资源中心（专家 / 技能 / 连接器 / 插件 / 知识库）共享页签在窄窗口下的横向溢出，使收窄到 320px 时页面无横向溢出、五个页签仍可读可选。

验收标准：
- 320px 窗口下资源页签（`[aria-label="资源类型"]`）容器宽度不超过可用宽度，页面 `scrollWidth === clientWidth`。
- 五个页签全部可见、文字不截断、当前页签的 line 下划线仍贴合该页签。
- 可访问性不退化：仍是一个 `tablist`，页签名称不变，焦点行为沿用 Base UI。
- 不改其他页面的页签（专家配置任务页签、技能内部/市场分段、插件安装方式等），不改设计令牌与后端。
- 动效限制同项目规则：只做局部交互与状态反馈，无页面入场或装饰位移。

## 方案
- 溢出根因（来自共享组件实际样式）：`TabsList` 是 `inline-flex w-fit`，`TabsTrigger` 默认 `flex-1`（flex-basis 为 0），五个「图标 + 文字」页签被排成单行并按内容撑宽；上一轮 PR #84 的浏览器实测该行约 396px。
- 最终契约（缩小后的范围）：**资源页局部布局调整 + 共享仅动效**。
  - `components/resource-page.tsx`（调用点）：`TabsList` 加 `max-w-full flex-wrap justify-start gap-x-4 gap-y-2 group-data-[orientation=horizontal]/tabs:h-auto min-h-8`；`TabsTrigger` 加 `flex-none h-[25px]`。
  - `components/ui/tabs.tsx`（共享）：仅把 `transition-all` 换成 `transition-[color,background-color,border-color,box-shadow] duration-150 ease-out-soft`，其余（`TabsList` 基类、Trigger 高度、各 variant）与 HEAD 完全一致。
- 为什么缩小范围：Opus 复核发现上一轮把换行/高度写进共享 `TabsList` 带来两处回归（知识库详情页签单行高度由 HEAD 的 32px 增至 41px——并非塌到 15px，15px 是 HEAD 下 Trigger 的既有计算高度；OpenUI `TabsRenderer` 因继承 `flex-wrap` 被迫加 `flex-nowrap`），并让 vertical 页签继承 `max-w-full flex-wrap`。改为调用点自治后无需任何回归补丁。
- 已确认 cn（`cn@0.5.0`，tailwind-merge 语义）合并结果：调用点的 `group-data-[orientation=horizontal]/tabs:h-auto min-h-8` 会替换基类同一 variant 的 `h-8`；`h-[25px]` 会替换 Trigger 基类的 `h-[calc(100%-1px)]`，实测计算高度 25px。
- 未采用的备选：横向滚动会让部分页签默认不可见；只留图标在窄窗丢失标签可读性。多行换行符合设计规范「窗口收窄时保持无页面横向溢出」。

## 基线与范围
- 工作目录：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/ui-resource-tabs`（分支 `worktree-ui-resource-tabs`）。
- 起点 HEAD：`b58547c1b85b2573ff1ea69ae736b2033ca89361`，`origin/main` 同为 `b58547c1b85b2573ff1ea69ae736b2033ca89361`，与声明起点一致。
- 本 worktree 初始工作区干净（`git status --short` 无输出）。
- 主 checkout 存在 `.vitest` 相关未提交差异：**非本任务产出**，本任务不提交、不还原、不覆盖。
- 允许改动（白名单）：`packages/web/src/components/resource-page.tsx`、`packages/web/src/components/ui/tabs.tsx`（仅动效）、本记录。
- 溢出问题是上一轮 PR #84 的实测发现（`docs/tasks/ui-resource-feedback.md` 验证表「320px 桌面收窄」行），本轮不虚构新问题。

## 当前有效决定
1. 用户已完整授权每轮流程：实现 → 按改动范围验证 → Opus 独立 review → commit → push → 创建 PR → 合并 main → 清理该轮 worktree，无需重新授权；该完整授权截至本次记录时仍然有效。
2. 本轮范围仅共享资源页签的窄窗收窄可用性，不扩无关页面与无关页签。
3. 模型分工按 `pstack-models.md`：设计/契约/独立 review 用 Opus，执行用 Sonnet；主会话不亲自改源码。收尾轮由接手代理直接改两个白名单源码文件并实测。
4. 动效沿用项目限制：只做局部交互与状态反馈（90–160ms、`--ease-out-soft`、只过渡实际变化的属性），不做页面入场动画。本轮把共享 Trigger 的 `transition-all` 收窄为四属性 150ms `--ease-out-soft`。
5. 实测口径按 `docs/PITFALLS.md`「对齐/间距类改动没量实际坐标就宣布完成」：交付前读浏览器实际 `getBoundingClientRect()` 与 `scrollWidth/clientWidth`，把数值写进验证段。
6. 改动契约最终收敛为「资源局部布局 + 共享仅动效」，其余共享类名与其它调用方文件保持 HEAD 原样。

## 已替代项及原因
- 原方案「在共享 `TabsList` 加 `flex-wrap max-w-full gap-y-2 min-h-8`、共享 Trigger 固定 `h-[25px]`」被替代：Opus 复核发现它同时造成知识库详情页签单行高度由 32px 增至 41px（不是塌到 15px，15px 是 HEAD trigger 的既有高度）与 OpenUI `TabsRenderer` 横向滚动被破坏，并为 vertical 页签引入换行副作用。改为调用点自治后所有回归补丁不再需要。

## 步骤
- [x] 阅读 `docs/DEV-WORKFLOW.md` §3 模板与 `docs/PITFALLS.md` 相关条目，确认记录格式与测量要求。
- [x] 核对基线：HEAD 与 `origin/main` 同为 `b58547c1`，worktree 干净，并记录主 checkout 既有差异归属。
- [x] 阅读共享页签实现（`components/resource-page.tsx`、`components/ui/tabs.tsx`）与设计规范 §8/§9 的收窄约定，确认溢出根因在 `flex-1` + `w-fit` 的单行排布。
- [x] 固定改动契约（调用点局部布局 + 共享仅动效）并派执行代理落地。
- [x] Opus 独立 review 发现两处回归与 vertical 副作用（见「方案」），据此把共享 `TabsList`/Trigger 高度改动全部回退到 HEAD，`knowledge-detail.tsx`、`openui/components/layout.tsx` 一并回退到 HEAD。
- [x] 浏览器实测 320 / 640(zoom) / 768 / 1440、键盘可达性、reduced motion、其他调用方（见「验证」）。
- [x] 按改动范围验证（typecheck、biome、定向测试）。
- [ ] commit / push / PR / merge 与 worktree 清理由主会话执行（本轮未做）。

## 改动文件
- `packages/web/src/components/ui/tabs.tsx`：仅 `transition-all` → `transition-[color,background-color,border-color,box-shadow] duration-150 ease-out-soft`（1 行）。
- `packages/web/src/components/resource-page.tsx`：资源页 `TabsList`/`TabsTrigger` 增加换行与高度类（13 增 3 删）。
- `docs/tasks/ui-resource-tabs.md`（本记录）。
- 已回退到 HEAD、最终无差异：`packages/web/src/pages/knowledge-detail.tsx`、`packages/web/src/openui/components/layout.tsx`。

## 下一步
主会话按既有授权执行 commit / push / PR / merge 与 worktree 清理。

## 验证（实测，2026-10-28）
环境：临时 Vite（`packages/web/.visual-check`，端口 5199）渲染真实 `ResourcePage` 与 `ui/tabs`，ego-browser v2.1.0（Chromium）CDP `Emulation.setDeviceMetricsOverride` 设定真实视口，读计算样式与 `getBoundingClientRect()`；验证后已删除临时入口并停止该 Vite。

| 视口 | 文档 scrollWidth / innerWidth | TabsList rect | 行数 | 五个 Trigger rect | 结论 |
| --- | --- | --- | --- | --- | --- |
| 320×800 | 320 / 320 | x=12 w=296 h=64 | 2 | 60/60/73/60/73 × 25px，两行 y=15、y=48 | 无横向溢出，全部可见 |
| 768×900 | 768 / 768 | x=12 w=396 h=32 | 1 | 5 项均 25px 高，y=15.5 | 单行 32px |
| 1440×900 | 1440 / 1440 | x=12 w=396 h=32 | 1 | 同上 | 单行 32px |

- 640px 视口 + CSS `zoom: 2`（**CSS zoom，不是原生浏览器缩放**）：TabsList 视觉 592×128，表格仍按 320 逻辑宽度排两行，页面 `scrollWidth === clientWidth === 640`。
- 计算样式：TabsList `max-width:100%; flex-wrap:wrap; column-gap:16px; row-gap:8px; justify-content:flex-start; min-height:32px`；320 时 `height:64px`，768/1440 时 `height:32px`。Trigger 计算高度均 `25px`（`flex-none h-[25px]` 已覆盖基类百分比高度）。
- `h1` 数量：各视口均为 1。
- 键盘：焦点从「专家」开始，`ArrowRight` ×5 依次到达 技能 → 连接器 → 插件 → 知识库 → 专家，`End` 到知识库、`Home` 回专家，5 项全可达；焦点项 `box-shadow` 出现 ring（`rgba(138,138,138,0.867) 0 0 0 1.73px`，即 `ring-2 ring-ring` 的过渡中间值）。
- reduced motion：`matchMedia('(prefers-reduced-motion: reduce)').matches === true` 时 Trigger `transition-duration` 为 `1e-05s`（全局 `transition-duration: 0.01ms !important` 生效）。
- 动效：默认 Trigger `transition-property: color, background-color, border-color, box-shadow`，`0.15s`，`cubic-bezier(0.22, 1, 0.36, 1)`；未做长动画采样。
- 其他调用方（768 视口，HEAD 原样的文件与共享类）：知识库任务页签 list 271×32、5 项单行（`h-[calc(100%-1px)]` 下计算 15px，与 HEAD 相同）；插件视图 90×32；插件安装方式 138×32。均未受影响。
- `pnpm --filter …/web typecheck`（`tsc -b`）：通过，exit 0。
- `pnpm exec biome check packages/web/src/components/ui/tabs.tsx packages/web/src/components/resource-page.tsx`：通过，exit 0。
- `pnpm vitest run --config packages/web/vitest.config.ts packages/web/test/resource-navigation.test.ts packages/web/test/resource-count.test.ts`：2 文件 17 用例通过（1.30s）。
- `pnpm test:web`（主会话最终一轮，03:14:06）：77 个测试文件、754 个用例全部通过。此前（改动落地后、收尾提交前）的定向验证亦已通过；build / typecheck 等由主会话随后运行，本记录不预填结果，提交前以主会话最终核对为准。
- 未测：生产 build 与真实 AppShell 下的实际窗口缩放（本页用复刻的 `px-3 pb-10` 内容区），最终以主会话随后运行的 build/typecheck 结果为准。`.vitest` 报告为本仓既有被跟踪文件，本轮未改动、未删除；浏览器验证只清理了临时 Vite 入口（`packages/web/.visual-check`），未删除任何真实浏览器配置或会话数据。
