# 动效巡检与局部交互收敛（ui-motion-loop）

## 目标
按 `docs/DESIGN-SYSTEM.md` §11 动效规范与 §0 第一性原则，持续巡检并收敛界面动效，使其只服务局部交互与状态反馈。

首轮（本轮）范围：**主导航展开/收起** 与 **路由切换** 两处交互的动效表现。其余区域是否纳入、纳入哪些改动，等 Opus 只读探索给出证据后再定，不在本记录中预设问题。

验收标准（本轮）：
- 实际存在的动效与 §11 数值一致：交互过渡 90–160ms、统一 `--ease-out-soft`、只过渡实际变化的属性、禁用 `transition-all`；侧栏宽度 160ms、标签淡出 90ms。
- 无页面入场动画、无装饰位移、无呼吸点；路由切换不引入页面级位移或入场效果。
- `prefers-reduced-motion` 下过渡/动画时长与延迟归零，JS Motion 调用方读取 `useReducedMotion`。
- 视觉数值、尺寸、色值、布局与业务行为不因动效改动而变化。

## 方案
- 本轮采用「先证据、后契约、再执行」：Opus 只读探索主导航与路由切换的现有实现与真实动效表现，输出事实清单与候选改动范围；主会话据证据固定契约，Sonnet 子代理执行，Opus 独立 review。
- 动效只允许局部交互与反馈（悬停背景、展开折叠、浮层显隐、流式光标、结果反馈），实现优先复用项目已选技术栈：CSS transition + Base UI `data-starting-style` / `data-ending-style`；需要布局开合时用 Motion（`motion/react`，`duration` 0.15–0.2、`easeOut`）。不手写库已提供的能力，不新增依赖。
- 无页面入场/装饰位移类需求；不做动效装饰化改造。
- 以最小完整改动为限，不做与巡检目标无关的重构。

## 基线与范围
- 工作目录：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/ui-motion-loop`（分支 `worktree-ui-motion-loop`）。
- 起点 HEAD：`917d84c3bc4664c711ed56e51e3ffb765e9fac11`；`origin/main` 同为 `917d84c3bc4664c711ed56e51e3ffb765e9fac11`。
- worktree 初始工作区干净，无未提交差异。
- 主 checkout 存在 `.vitest/json/output.json` 修改：**非本任务产出**，归属其他会话/其他用途，本任务不提交、不还原、不覆盖。所有产出只落在本 worktree。
- 本轮允许改动（待证据确认后收窄或扩展）：主导航展开/收起相关组件、路由切换相关布局组件、对应测试；以及本记录。不改后端、依赖、设计令牌、色值与布局数值。

## 当前有效决定
用户最新明确决定：
1. 任务以 15 分钟一轮巡检推进：发现问题或有价值机会即调整完成本轮，不再逐项等待确认。
2. 每轮流程固定：实现 → 按改动范围验证 → Opus 独立 review → commit → push → 创建 PR → 合并 main → 清理该轮 worktree → 等待下一轮。已完整授权，无需反复确认。
3. 项目设计系统优先；动效仅限局部交互与反馈，**不做页面入场动画与装饰位移**。
4. 动效调整必须与布局、间距、层级等一并看，UI 视为整体评估，不孤立调动效而破坏布局表现。
5. 模型分工：Opus 负责探索、设计与独立 review；Sonnet 负责执行；主会话不写代码。
6. 首轮范围为「主导航展开/收起」与「路由切换」；具体改动范围以 Opus 只读探索证据为准，不虚构问题。

### 本轮固定契约（2026-10-28，Opus 探索确认后由主会话固定）

只改 `packages/web/src/components/app-shell.tsx`、其真实相关测试与本记录；不新增抽象、不改后端/依赖/令牌/布局数值。

1. **主导航 active 改按实际匹配路由判定。** `SidebarLink` 现在的 active 是 `pathname.startsWith(to)`，`/plugins/*`、`/knowledge/*` 详情页丢掉 active 与 `aria-current`，未知路由（`/_shell/$`，例如 `/eval/missing`）又会被前缀误判成 `/eval`。改为读取 `state.matches.at(-1)?.routeId`，用显式 routeId → 主导航 `to` 表判定：agents/skills/servers/plugins/knowledge 的列表与详情都归属「专家·技能·连接器·插件·知识库」，runs 列表与详情归属「运行」，其余已有导航不变；`/_shell/$` 不在表内，任何导航都不得选中。先加先红的行为测试覆盖详情 active、未知路由不误选、已有导航不回归。
2. **收起态分组分隔线去掉 `bg-line`。** 保留原占位几何 `mx-auto mb-1 h-px w-6`（`aria-hidden`）与分组结构，只让线不可见，避免导航突然移位；不删除分组结构。
3. **标签收起/展开用规范 90ms 淡出且可逆。** 收起态不再切换 `truncate`/`sr-only` 两种节点，统一同一文本节点：收起时标签 `absolute inset-y-0 left-9` 脱离文档流、保留自身宽度，只对 `opacity` 做 90ms `--ease-out-soft` 过渡（文字仍在无障碍树中，可访问名称不随状态变化）；链接自身即时收到 32×32 图标块，展开/收起宽度 272/68 与既有内边距不变；`gap` 只在展开态生效，`nav` 加 `overflow-x-hidden` 容纳淡出中的文字。`prefers-reduced-motion` 由全局规则把时长归零。`Tooltip` wrapper 无条件包裹（不再按 `collapsed` 条件切换），展开态用 Base UI `Tooltip.Root` 原生 `disabled` 关闭 popup，避免收起/展开时 `Link` 被卸载重建导致过渡失效。
4. **收起态 Logo / 展开按钮互换 140ms。** 两处 `transition-opacity` 从 150ms 改为 140ms，缓动改用 `ease-out-soft`（`var(--ease-out-soft)`），其余品牌切图 300ms、aria/focus 与点击行为不变。

不做：页面入场/位移动效、`scale`、路由切换动效、任何尺寸/色值/布局数值调整。

## 已替代项及原因
- **标签收起方案：`w-0 overflow-hidden` 即时裁切 → `absolute left-9` 脱离流只淡出。** 第 1 轮 Opus review 的 blocker：即时把标签宽度收为 0 后，90ms 的 opacity 过渡作用在已被裁掉的文字上，屏幕上根本看不到淡出；且文字仍在 `overflow-hidden` 区域外溢，靠 `nav` 的 `overflow-x-hidden` 兜底才不出现横向滚动。改为收起态标签 `absolute inset-y-0 left-9` 保留自身宽度、只把 `opacity` 过渡到 0，链接自身宽度即时收到 32px，文字从原 48px 起点淡出；`nav` 仍需 `overflow-x-hidden` 防止淡出中的文字撑出侧栏。

## 步骤
- [x] 阅读 `docs/PITFALLS.md`、`docs/DEV-WORKFLOW.md` §3 与 `ub-mode` 技能，确认任务记录模板与工程纪律。
- [x] 核对基线：worktree 路径、分支、HEAD 与 `origin/main` 一致，初始工作区干净；记录主 checkout 初始差异归属。
- [x] 取得 Opus 只读探索证据：active 只覆盖精确 `resourceLabels`、收起态分组线 `bg-line`、标签 `truncate`/`sr-only` 切换无 90ms 过渡、Logo/展开按钮 150ms。
- [x] 固定本轮契约（见「本轮固定契约」），直接在 `app-shell.tsx` 与其真实测试上执行。
- [x] 先红后绿：`shell-route.test.ts` 新增详情 active、未知路由不误选、标签同节点淡出、tooltip 仅收起态开启；改动前确认失败，改动后全部通过。
- [x] 按改动范围验证：`pnpm test:web`、web typecheck、web build、`pnpm lint:focus`、改动文件 biome check。
- [x] Opus 第 1 轮 review：blocker——`w-0 overflow-hidden` 先裁掉文字再淡出，用户看不到过渡；已改为 `absolute left-9` 脱离流只淡出。
- [x] 修复后重跑 `pnpm test:web` 与 biome；Opus 第 2 轮源码 review 通过。
- [x] ego-browser 在真实 AppShell 上做确定性动效采样（暂停 CSSTransition 到 45ms 读计算值 + 逐帧读 aside 宽度）。
- [ ] 提交、推送、创建 PR、合并 main、清理本轮 worktree（由主会话执行）。

## 改动文件
- `packages/web/src/components/app-shell.tsx`
  - 新增 `navRoutes`（routeId → 主导航 `to`）；`SidebarLink` 用 `state.matches.at(-1)?.routeId` 判定 active，`Link` 加 `activeOptions={{ exact: true, includeSearch: false }}` 关闭路由器自带的前缀 active。新增路由需要在 `navRoutes` 登记归属，否则导航不选中（这是有意的显式契约，不做前缀兜底）。
  - 收起态分组占位去掉 `bg-line`，保留 `mx-auto mb-1 h-px w-6`。
  - 导航标签统一为一个文本节点：收起 `absolute inset-y-0 left-9 flex items-center opacity-0`（保留自身宽度，只淡出），展开 `truncate`；`transition-opacity duration-[90ms] ease-out-soft`；`gap-2.5` 只在展开态；`nav` 为容纳淡出中的文字加 `overflow-x-hidden`。
  - `Tooltip` 无条件包裹，展开态 `disabled`。
  - 收起态 Logo 与展开按钮 `transition-opacity` 150ms → 140ms，缓动 `ease-out-soft`。
- `packages/web/test/shell-route.test.ts`：补充 knowledge/agents/skills/servers 路由桩；新增「详情 active」「未知路由不选中」「同节点 90ms 淡出」「tooltip 仅收起态」用例；`beforeEach` 清 `localStorage` 避免侧栏折叠状态跨用例泄漏；收起态断言补上 `opacity-0`/`absolute`/`duration-[90ms]`，锁住 review blocker 的回归（标签保留宽度淡出，不能被裁成 0 宽）。
- `docs/tasks/ui-motion-loop.md`（本记录）。

## 下一步
本轮改动已完成源码复核、单元测试与真实浏览器动效采样；等待主会话决定提交/合并。

**本轮未覆盖 / 已知限制**
- 宽度 `auto ↔ 0` 无法用纯 CSS 过渡，标签占位宽度仍是即时变化；目标的 90ms 只作用于标签 `opacity`，与 §11 一致。若后续要求文字容器宽度也插值，需要 JS Motion 或 `grid-template-columns` 技巧，属于扩大范围，本轮不做。
- 侧栏宽度本身（Motion 的 `motion.aside`）在窗口被遮挡时 rAF 被浏览器降到约 1fps，无法逐帧拿到完整 160ms 曲线；用整段 `document.getAnimations()` 也找不到可 seek 的对象（Motion 直接用 rAF 写内联样式，不走 Web Animations）。改为逐帧记录宽度：实测 272 → 254.94 → 249.41 → 68，证明是插值而非跳变，但采样点稀疏，未验证 160ms 精确时长与缓动曲线。
- 标签淡出中途值是确定性证据：把 `opacity` 的 CSSTransition 暂停并 `currentTime = 45`，读出 computed opacity 0.0386（严格 0<opacity<1），标签与 nav 的可见交集 170.98×32（>0），同一节点在收起、展开两个方向都保留。反向（淡入）的同法中途读数不可信（见上表），只用终态与节点身份证明可逆。

## 验证
本轮实际命令与结果（worktree 根目录执行）：

| 命令 | 结果 |
|---|---|
| `npx vitest run --config packages/web/vitest.config.ts packages/web/test/shell-route.test.ts`（改动前） | 5 failed / 13 passed；失败原因为：详情页 `[]` 而非 `['/agents']`、未知路由得到 `['/eval']`、标签节点为 `sr-only` 无 `opacity-0`/`duration-[90ms]`、展开态仍弹 tooltip |
| 同上（改动后） | 21 passed（含工作台/对话/定时任务/评估/健康/审计的既有导航回归） |
| `pnpm test:web` | 75 files / 740 tests passed（最终态；补断言后复跑） |
| `pnpm --filter './packages/web' typecheck` | 通过（`tsc -b` 无输出） |
| `pnpm --filter './packages/web' build` | 通过（`vite build`，有 chunk >500kB 警告；未跑基线，不对其归属下结论）；产物 CSS 中确认生成 `transition-duration:90ms`、`.14s`（140ms）与 `.ease-out-soft` |
| `pnpm lint:focus` | 「焦点/边框规约校验通过。」 |
| `pnpm lint:contract` | 「project contract OK」 |
| `./node_modules/.bin/biome check packages/web/src/components/app-shell.tsx packages/web/test/shell-route.test.ts` | 「Checked 2 files … No fixes applied.」（格式与 lint 均通过） |
| `./node_modules/.bin/biome check packages/web/src packages/web/test` | 「Checked 199 files … No fixes applied.」 |
| ego-browser（真实 AppShell，5199 一次性入口） | 见下「浏览器实测」 |

基线记录（沿用上轮）：
- 起点 HEAD 与 `origin/main` 同为 `917d84c3bc4664c711ed56e51e3ffb765e9fac11`。
- 主 checkout 存在 `.vitest/json/output.json` 修改，非本任务产出，未触碰。
- 本 worktree 的 `.vitest/json/output.json` 是本轮跑 `test:web` 的生成物；确认内容为测试摘要后已 `git restore`，最终工作区无该差异。

### 浏览器实测（ego-browser，任务空间 `ui-motion-loop-fix`）

入口：`packages/web/.visual-check/` 一次性真实 `AppShell` + 真实 `styles.css`，`me` 查询用 seeded 缓存且 `staleTime: Infinity`，不访问业务接口；端口 5199。采样结束后已删除该临时目录并停止该临时 Vite 进程（主 checkout 的 5174 预览未动）。

| 检查项 | 结果 |
|---|---|
| 展开态 aside | 272×872，padding `16px 12px`，链接 248×32，图标块 16×16 |
| 收起终态 aside | 68×872，padding `16px 18px`，链接 32×32，图标块 32×32，图标 16×16 |
| aside 宽度过程 | 逐帧采样 272 → 254.94 → 249.41 → 68，为插值非跳变（采样点稀疏，见限制） |
| 标签淡出中途（暂停 CSSTransition，`currentTime=45`） | computed opacity `0.0386175`（0<opacity<1），标签与 nav 可见交集 170.98×32（>0） |
| 标签淡入中途（反向） | 能找到同一节点的 opacity CSSTransition 并暂停到 45ms，但读数为 `0.0386175`（与淡出中途相同），与 ease-out 在 50% 处应接近 1 不符——窗口被遮挡时渲染帧不推进，computed 值可能未刷新。**反向中途值不可作为通过证据**；反向可逆性由终态（展开后 opacity 1、aside 272）与同一节点身份证明。 |
| 收起/展开后 label 节点身份 | 调用前后同一 DOM 节点（dataset 标记复核为 true） |
| 收起终态标签 | opacity `0`，与 nav 的可见交集宽度 0，`navScrollWidth 207 / clientWidth 32`，横向溢出被 `overflow-x-hidden` 吸收 |
| 过渡参数 | `opacity \| 0.09s \| cubic-bezier(0.22, 1, 0.36, 1)` |
| `prefers-reduced-motion: reduce`（CDP 模拟） | 计算样式过渡时长 `1e-05s`、延迟 `0s`；点击后 100ms 内 aside 已到 68、标签 opacity 0；收起与展开均正常 |
| 收起后按钮互换 | `展开侧栏` 出现、`收起侧栏` 消失；展开后相反 |
