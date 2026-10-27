# 技能资源列表与安装反馈（ui-resource-feedback）

## 目标
第二轮资源界面巡检：处理**技能内部列表**与**技能市场列表**的呈现，以及**搜索、安装过程中的反馈**（可发现性、进行中/完成/失败状态）。

首轮（`ui-motion-loop`，PR #83）已合并，覆盖主导航展开/收起与路由 active 归属，本记录不重复其范围。本轮改动范围由主会话依据 Opus 探索结果固定的五条契约确定，见下节。

验收标准：
- 列表与搜索、安装反馈符合 `docs/DESIGN-SYSTEM.md`（信息表达 §10、动效 §11）。
- 状态反馈完整：搜索中、无结果、安装中、安装成功、安装失败均有可见且可访问的表现。
- 动效只用于局部交互与状态反馈（90–160ms、`--ease-out-soft`、只过渡实际变化属性、禁用 `transition-all`），无页面入场或装饰位移。
- 视觉数值、尺寸、色值与既有业务行为不因本轮改动而变化；不新增依赖、不改后端契约。

## 固定契约（第二轮 UI 修复）

只改前端技能列表/市场与搜索安装反馈，不改后端、依赖、设计令牌与导航（首轮 PR #83 已合并）。

1. **安装生命周期**：`useInstallMarketSkill` 上移到常驻的 `SkillsPage`（`internal`/`market` 两种 scope 都挂载），经 props 传给 `MarketSkillsPage`，不再依赖市场页局部 state 或页面卸载后存活的 observer。删除 `installingId`，pending 由 `install.isPending` + `install.variables?.id` 推导；toast 与缓存更新放进 hook 自身回调：`onSuccess` 先 `setQueryData<SkillWithAgentCount[]>(['skills'])` 前插 `{...skill, agentCount: 0}`（安装总是新建，安装接口不返回 `agentCount`），再 `invalidateQueries(['skills'])`；`onError` 走共享 `toastError`。串行安装：`isPending` 时忽略点击，所有安装按钮同时禁用。
2. **搜索同步**：`useMarketSkills` 返回 `{...useQuery结果, isDebouncing}`，`isDebouncing = settled !== query.trim()`。唯一调用方 `MarketSkillsPage` 在防抖窗口显示共享 `LoadingState`（`status: pending`），不渲染旧列表、旧空态或安装按钮。1 字符时 `ResourcePage` 的 `count` 传 `undefined`：`count` 改为可选，`success` 且未提供时不渲染数量 `span`，`pending`/`error` 文案保留。
3. **已安装集合就绪**：`skills.isPending` → `LoadingState`；`skills.isError` → `ErrorState onRetry=skills.refetch`；两者期间都不渲染市场卡片、空态与可安装按钮。
4. **空态**：内部列表成功且长度 0 → `PageNote`（Sparkles），标题「技能库为空」，动作「前往市场」导航 `/skills?scope=market`（保留 `sort`/`marketView`，不复述「暂无」）；过滤后为空仍用「清除筛选」。市场榜单 term 为空且空数组 → 现有 `PageNote` 动作改为「刷新榜单」调用 `market.refetch`，有 term 时仍是「清除搜索」。
5. **Toggle**：`ui/toggle.tsx` 的 `transition-all` 改为 `transition-[color,background-color,border-color,opacity] duration-150 ease-out-soft`；尺寸、圆角、变体不变。

## 方案
- 主会话依据 Opus 探索固定契约与写入边界（四个源码文件 + 相关测试 + 本记录）；执行代理只在该 worktree 内完成实现、真实测试与浏览器实测，且不再向下派代理、不 commit——该限制只约束执行代理，git 交付（commit/push/PR/merge）由主会话负责。
- 优先复用现有实现：`components/ui/`、`components/page.tsx` 骨架、已选的 TanStack Query / Base UI；不自造等价实现，不引入第二套数据流。
- 最小完整改动；范围之外的重构不做。

## 基线与范围
- 工作目录：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/ui-resource-feedback`（分支 `worktree-ui-resource-feedback`）。
- 起点 HEAD：`fc542941f4330497775624702847fe35ca0da4c2`（PR #83 合并后）；`origin/main` 同为 `fc542941f4330497775624702847fe35ca0da4c2`。
- worktree 初始工作区干净，无未提交差异；首轮 worktree `ui-motion-loop` 已删除。
- 主 checkout 存在 `.vitest/json/output.json` 修改：**非本任务产出**，本任务不提交、不还原、不覆盖。
- 本轮允许改动（主会话固定白名单）：`packages/web/src/pages/skills.tsx`、`packages/web/src/lib/queries.ts`、`packages/web/src/components/resource-page.tsx`（仅 count 可选）、`packages/web/src/components/ui/toggle.tsx`、`packages/web/test` 中相关测试、本记录。不改后端、依赖、设计令牌与导航。

## 当前有效决定
1. 用户已完整授权每轮流程：实现 → 按改动范围验证 → Opus 独立 review → commit → push → 创建 PR → 合并 main → 清理该轮 worktree，无需重新授权。给执行代理的「不派代理、不 commit」只是该代理的执行限制，git 交付由主会话完成。源码 review a8b 已通过，新增生命周期 review a242 已通过。
2. 本轮范围仅技能内部/市场列表与搜索安装反馈，具体由上述五条固定契约确定，不虚构问题。
3. 本轮由单个执行代理完成实现、测试与实测，该代理不再向下派子代理；提交与合并由主会话执行。
4. 动效限制沿用项目规则：仅局部交互与反馈，不做页面入场动画与装饰位移；数值以 `docs/DESIGN-SYSTEM.md` §11 为准。

## 已替代项及原因
无。

## 步骤
- [x] 阅读 `docs/DEV-WORKFLOW.md` §3 模板、`docs/PITFALLS.md` 相关规则与首轮任务记录，确认记录格式与工程纪律。
- [x] 核对基线：HEAD 与 `origin/main` 同为 `fc54294`，worktree 干净，记录主 checkout 既有差异归属。
- [x] 创建本任务记录。
- [x] 固定本轮契约（改动文件白名单 + 行为验收）并写入本记录：主会话依据 Opus 探索固定，执行代理未再派只读探索代理。
- [x] 执行实现与测试，按改动范围验证（执行代理不派子代理、不 commit）。
- [x] Opus 独立 review：源码 review a8b 通过；新增生命周期测试 review a242 通过。
- [ ] 由主会话按现有完整授权提交、推送、创建 PR 并合并，随后清理 worktree。

## 改动文件

- `packages/web/src/lib/queries.ts`：`useMarketSkills` 增加 `isDebouncing`；`useInstallMarketSkill` 内置 toast、前插缓存与失效。
- `packages/web/src/pages/skills.tsx`：安装 hook 上移并下传；内部空库「前往市场」；市场页就绪门槛、防抖加载态、短词隐藏数量、剔除局部 `installingId`、榜单空态「刷新榜单」。
- `packages/web/src/components/resource-page.tsx`：`count` 改为可选，成功态未提供时不渲染数量。
- `packages/web/src/components/ui/toggle.tsx`：过渡属性与时长收敛到 §11。
- `packages/web/test/market-search.test.ts`：新增 `isDebouncing` 时序与旧键不请求断言。
- `packages/web/test/resource-count.test.ts`：新增未提供 `count` 时 pending/error 文案保留、success 不渲染数量。
- `packages/web/test/skills-resource-feedback.test.ts`：内部空库前往市场、过滤空态不串台、市场 pending/error/防抖、单卡 pending、已安装集合、榜单刷新动作、安装 hook 由常驻页下传。
- `packages/web/test/skills-install-lifecycle.test.ts`：真实 QueryClient + mock API；请求在途卸载页面后，成功/警告/失败 toast 与缓存前插仍生效。
- `docs/tasks/ui-resource-feedback.md`（本记录）。

## 验证

### 真实命令结果（本 worktree，2026-10-28）

| 命令 | 结果 |
|---|---|
| `pnpm vitest run --config packages/web/vitest.config.ts <新增/更新用例>`（改动前源码） | 9 failed / 4 passed；失败项正是本轮新增断言（`isDebouncing`、安装缓存/toast、内部空态、市场就绪/防抖/刷新）——先红已诚实执行 |
| 同上（改动后） | 13 passed（后续拆分为 15 条；最终全套待主会话重跑） |
| `pnpm test:web` | 最终全量 77 files / 754 tests 全过（02:41:10）；早期 756 为含已清理的 `skills-install-cache.test.ts` 时的结果。 |
| `pnpm --filter @agentport/web typecheck` | 通过（`tsc -b` 无输出） |
| `pnpm --filter @agentport/web build` | 通过；出现 chunk >500kB 警告，本轮未做基线对照，不称既有 |
| `pnpm lint:focus` | 「焦点/边框规约校验通过。」 |
| `pnpm lint:contract` | 「project contract OK」 |
| `biome check`（8 个改动源码/测试文件） | 「Checked 8 files … No fixes applied.」 |

测试生成的 `.vitest/json/output.json` 已在本树 `git restore`，最终工作区无该差异。

### 浏览器实测（ego-browser，固定 space `ui-resource-feedback`）

入口：`packages/web/.visual-check/` 一次性真实 `SkillsPage` + 真实 `styles.css`（用 `@source "../src"` 让 Tailwind 扫真实源码）+ 内存 TanStack Router/QueryClient；`fetch` 按 `?skills=&market=&install=` 控制三接口 pending/success/error/empty。端口 5199。采样后已删临时目录、停独立 Vite、`finish` space。

| 检查项 | 结果 |
|---|---|
| 内部空库 | 文本 `技能库为空 / 前往市场`，无「暂无」；点击后 URL search 变为 `scope=market` |
| Toggle 过渡 | `transition-property: color, background-color, border-color, opacity`，`0.15s`，`cubic-bezier(0.22, 1, 0.36, 1)`，类名无 `transition-all` |
| `prefers-reduced-motion: reduce` | 同一 Toggle 过渡 `property` 不变，`duration: 1e-05s`、`delay: 0s` |
| 键盘焦点（ToggleGroup 方向键） | 「市场」`focus-visible: true`，`outline-style: none`，boxShadow 仅一层 `rgb(138,138,138) 0 0 0 2px` |
| 320px 桌面收窄 | 资源页本身无横向溢出；溢出元素是资源类型 `tablist`（396px，`w-fit`）——本轮实测发现，属范围外问题，留给后续共享资源页签任务 |
| 市场 skills pending | 只出现 `LoadingState`（`aria-busy=true`、状态文案「加载中…」），无卡片、无空态、无安装按钮 |
| 市场 skills error | 显示 `ErrorState`「内容没有加载出来」+「重试」，无安装按钮 |
| 搜索 1 字符 | 状态 `span` 不存在（数量隐藏），仅「至少输入 2 个字符」说明 |
| 搜索 2 字符防抖窗口 | 立即采样：状态「加载中…」、骨架可见、卡片 0 条；600ms 后：`共 2 个技能`、2 张卡 |
| 榜单空态 | `榜单为空 / skills.sh 暂时没有返回榜单数据。 / 刷新榜单`；点击触发 `market.refetch` |
| 安装中 | 目标卡「安装中…」`disabled`、`aria-busy=true`；另一张卡「安装」也 `disabled` |
| 安装成功 | 出现两条 toast：`已安装「PDF Toolkit」`、`已跳过同名文件 scripts/run.sh`；按钮恢复可点（该验证入口的 `/api/skills` 为静态 stub，不随安装变化，见限制） |
| 安装失败 | 共享错误 toast（服务端 message），列表与按钮状态不变 |
| 已安装集合 | 市场条目命中 `sourceId` 时按钮为「已安装」且 `disabled`，另一条仍可安装 |

### 测试限制与未覆盖

- jsdom 下 sonner 只验证 `toast.success/info/error` 调用参数；真实 toast 堆叠外观由浏览器实测覆盖。
- 安装成功后的服务端列表校正（`invalidateQueries` 后返回真实 `agentCount`）未在浏览器验证：一次性入口的 `/api/skills` 是静态 stub，安装后仍返回安装前数据；缓存前插由单测覆盖。
- 防抖窗口内的真实网络请求次数未在浏览器计数；由 `market-search.test.ts` 的 queryKey 序列断言覆盖。
- 320px 下资源类型 `tablist`（396px）横向溢出：本轮实测确认，属范围外发现，不在本轮修复；留给后续共享资源页签任务处理（不另起待办系统）。

