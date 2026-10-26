# 全页面动效机会发现与落地

## 目标

使用 find-animation-opportunities 技能检查所有页面，将通过频率、目的、速度、功能四项筛选的机会全部落地，保持现有视觉与业务行为。

## 方案

先由 Opus 只读探索所有路由与共享组件，以 Emil Kowalski 的 find-animation-opportunities 技能筛选最多 5–7 类高价值机会；固定共享契约后，多个 Sonnet 在互斥文件范围并行实现。复用 Base UI / Motion / Tailwind 原生能力；保持 reduced-motion、键盘焦点、表单草稿和流式逻辑。独立 Opus 评审，通过本地类型、构建与浏览器验证后交付未提交差异。

## 基线与范围

- 主 checkout 开始时：797edfeaabd39b040d01736c49273da18347ea92，干净。
- worktree：project-motion-opportunities；起始 HEAD f2eee7d8fc8fbef0ae59805f828eec4e0e537a35；初始无未提交差异。
- 本树按 EnterWorktree 默认从 origin/main 创建，已包含本地 main；`git merge --ff-only main`：Already up to date。实际工作基线为 f2eee7d（比启动上下文的本地 main 新，包含知识库、插件等页面），已增派 Opus 检查新增页面，所有实施与评审均以本树 HEAD 为准。实施期间 `git fetch origin main` 显示远端推进到226bbf0；为避免改动中的基线漂移，本任务保持f2eee7d，不自动合入其他会话的新提交。
- 范围：packages/web/src 的所有页面与共享动效组件、相关测试，以及设计规范与本记录。
- 技能通过 `npx --yes skills@latest use emilkowalski/skills@find-animation-opportunities` 临时加载，不安装、不修改技能目录/锁文件。

## 当前有效决定

- 用户授权检查全项目所有页面并执行发现的机会；不止出报告。
- 发现阶段按技能只读执行，实施交给执行子代理。
- 遵守设计规范：无页面入场、装饰位移、呼吸点；不动画化密集数据、流式文本、键盘焦点或常用导航。
- 动效用于真实交互状态、展开折叠与反馈，不改变尺寸、颜色、布局或业务功能。
- 用户本轮明确授权 commit/push/创建 PR/合并，无需再问；按项目规则不等待 CI、不启动 PR 监控，不动主 checkout，不删除 worktree 或本地分支。

## 已替代项及原因

无。

## 步骤

- [x] 阅读研发流程、踩坑、设计规范与技能规范。
- [x] 定位并临时加载专用技能（上游 MIT，49,682 stars；搜索显示 208.4K installs）。
- [x] 完成全路由覆盖清单及动效筛选（18 个路由入口，含技能市场额外状态）。
- [x] 固定实现契约。
- [x] 完成 A/B/C/E 实施及 D 初版接线，全部初版纳入固定 HEAD 差异审查。
- [x] 修复业务首轮4项与共享首轮1项，代码修复获独立Opus确认。
- [x] 完成SourceRuns测试退出窗口/来源切换断言和统一曲线；最终独立Opus明确通过。
- [x] 完成最终本地验证结果汇总（69文件690用例、类型、构建与契约通过）。

## 改动文件

- 共享：`motion-collapsible`、`code-block`、`copy-button`、`data-table`、`plugin-file-tree`、`knowledge-settings`。
- 原语：`ui/accordion`、`carousel`、`dialog`、`sheet`、`popover`、`dropdown-menu`、`select`、`combobox`、`tooltip`、`badge`、`switch`、`skeleton`、`message-scroller`。
- 页面：`chat`、`agents`、`eval`、`knowledge-detail`、`overview`、`plugin-detail`、`plugins`、`runs`、`servers`、`skills`、`ops`；生成式图表数据视图 `openui/components/charts`。
- 样式/依赖：`styles.css`、`packages/web/package.json`、`pnpm-lock.yaml`。
- 测试：`agents-lifecycle`、`chat-ux`，新建 `collapsible-motion`、`copy-button`、`carousel-controls`、`carousel-reduced-motion`、`knowledge-source-runs`。
- 文档：`docs/DESIGN-SYSTEM.md`、`docs/tasks/project-motion-opportunities.md`。

## 动效机会筛选与实施契约

所有机会均不改变业务数据、路由、查询键、表单草稿或控件尺寸。沿用 `--ease-out-soft: cubic-bezier(0.22, 1, 0.36, 1)`，普通过渡 150ms、侧栏 160ms、标签 90ms；无页面入场。

| # | 位置 | 当前 | 目的 | 频率 | 实施 |
|---|---|---|---|---|---|
| 1 | 共享折叠、代码大内容、版本差异、来源记录、插件文件、图表数据视图 | 条件卸载导致突然出现/消失 | 状态提示/防突变 | 偶发 | Base UI Panel 高度变量，height+opacity 150ms；每个区域只有一个高度所有者，已有 Motion 折叠不叠加 |
| 2 | 评估 DataTable 展开结果 | 表格详情直接切换 | 状态提示 | 偶发 | td 内合法折叠，150ms，不移动排序数据，不提前请求隐藏详情 |
| 3 | Dialog/Sheet/菜单/选择器等共享浮层 | 已有 keyframe/zoom/slide 不一致 | 空间连续/防突变 | 偶发 | Base UI starting/ending 状态透明度 150ms，保留定位 transform、Portal 和焦点生命周期 |
| 4 | CopyButton、安装/测试/刷新状态 | 图标/结果瞬间切换，部分刷新无在途反馈 | 反馈 | 偶发 | 局部 opacity 150ms，保持原按钮 DOM、真实 pending、文本/图标静态信号 |
| 5 | 历史/评估/知识库文件夹操作与代码复制入口 | hover 隐藏规则不统一，触摸可能不可见 | 反馈 | 每日数十次 | 仅 fine+hover 默认隐藏；hover/focus-within/打开时 opacity 150ms，触摸直接显示 |
| 6 | 对话右成果栏 | 条件挂载使布局突变 | 空间连续 | 偶发 | 沿用 Motion 宽度开合 160ms；不修改左侧分栏库拖动/存储，不清输入 |
| 7 | 全局 reduced-motion、既有状态动画 | CSS 延迟残留，个别装饰/默认图表动画 | 功能与可访问性 | 全站 | 清零延迟，Motion 显式减少动态，保留静态骨架与运行提示，关闭趋势绘图动效 |

### 明确拒绝的候选

- 页面/网格入场、资源 tab 与搜索筛选：高频导航，不应延迟操作。
- 统计数字滚动、趋势图绘线、表格排序/轮询数据移动：用户读取的功能数据，不做装饰。
- 流式文字逐字淡入、每条消息位移：高频且会影响阅读与跟随。
- 登录 Logo、404 空态弹跳、全局按钮缩放：无必要状态信息，现有视觉规范禁止装饰位移。
- 破坏性操作长按确认：已有确认机制，改动交互与本次动效目标无关。

### 页面覆盖

工作台、对话、运行列表/详情、定时任务、评估、专家列表/配置（含记忆/规则/风格/文件/统计）、技能内部/市场、连接器、插件列表/详情、知识库列表/详情（文档/检索/Wiki/来源/任务）、健康、审计、登录、404。登录/404/审计/健康等无需专属动画，继承共享组件即可。

### 并行文件边界

- A 共享折叠：motion-collapsible、ui/collapsible、ui/accordion、data-table、code-block、plugin-file-tree 与专属生命周期测试。
- B 共享视觉反馈：styles.css、浮层原语、CopyButton、Skeleton、message-scroller、共享状态徽章、DESIGN-SYSTEM 动效章节。
- C 对话/专家：pages/chat.tsx、agents.tsx、eval.tsx 与对应回归测试。
- D 其余页面：servers、skills、plugins、plugin-detail、knowledge-detail、ops、runs、overview、openui charts/layout 与对应测试。
- 固定折叠接口 `CollapsibleContent animated?: boolean` 默认 false；普通折叠显式 animated，已有 Motion 高度容器不传。实现方先按此契约写独立部分，调用接线依赖 A 完成，不抢改共享文件。
- 增量 Opus 发现知识库图片处理组显隐与 Embla 的 JS reduced-motion 缺口；补充 E 独占 `components/knowledge-settings.tsx`、`ui/carousel.tsx` 及专属测试。前者归入机会 1，后者归入机会 7；不扩大机会类别数量。
- 两份独立探索对插件文件区/图表数据视图的高度动画收益存在不同判断：实施保持最小接线，评审重点核对连续选择/密集数据阅读，如明显干扰即保持即时开合；不加行级动画。

## 下一步

无实施待办。验证完成，按用户本轮授权提交本任务 43 个预期文件、推送分支并以 `--merge` 方式合并到 main（准备 PR 合并阶段，不在本记录提前声称已合并）。可通过 https://worktree-project-motion-opportunities.agentport.localhost 预览。插件/知识库真实服务成功态仍需匹配本树版本的 API，逐帧流畅度无法由当前节流环境可靠量化；未触发模型/worker/完整后端测试。


## 最终验收结果

- 独立Opus首轮发现业务4项、共享1项，均修复；后续复核只检查修复/新增项，最终明确通过。
- `pnpm test:web`：69文件、690用例通过，退出0。保留jsdom既有提示 `Not implemented: navigation to another Document`，无测试失败。
- `pnpm --filter './packages/web' typecheck`：通过。
- `pnpm --filter './packages/web' build`：通过，非法媒体查询警告已消失，仅既有chunk体积提示。
- `pnpm lint:focus`、`pnpm lint:contract`、`git diff --check`：通过。
- 已完成37个源文件/测试Biome干净；最后来源测试格式已修正，动画测试闭包有一个`noNonNullAssertion`风格警告（不影响运行/类型），如后续编辑可局部改写。
- 浏览器桌面/320px主页面、浮层关闭回焦、版本折叠、代码大内容、触摸/键盘显影、复制、刷新、对话草稿已验证。全路由源码覆盖，插件/知识库成功态依赖现有96项相关测试验证，真实服务缺口如上。
- Ego TaskSpace 67已finish并清理临时探针页面；独立前端预览保留，无业务资源变更。

## 验证

- `git merge --ff-only main`：Already up to date。
- `npx --yes skills@latest use emilkowalski/skills@find-animation-opportunities`：成功输出完整技能，CLI 1.7.4。
- `pnpm install --frozen-lockfile`：退出 0；shared/core 构建成功。
- 运行源：本 worktree，HEAD f2eee7d；配置为本树 `.env`（已核对与主 checkout 和现有 API 一致）；URL https://worktree-project-motion-opportunities.agentport.localhost；独立前端代理到已有 localhost:3000 API，未改配置/worker。
- 浏览器 TaskSpace 67；已实际操作 OpenUI 参考页侧栏折叠和模型菜单，并检查本树创建弹窗、会话历史展开。参考页原有过渡不作为新增布局数值依据。
- 已逐页浏览：工作台、专家、技能、连接器、插件、知识库、运行、定时任务、评估、健康、审计、对话、404；正常可见状态每页单一 h1、无页面级横向溢出。
- 环境缺口：共享 API 版本落后于本树，`GET /api/plugins` 和 `GET /api/knowledge/bases` 返回路由不存在；这两页真实成功态/详情需使用本树 API 才能实测，现阶段仅看到真实错误恢复界面。不为动效任务替换共享 API 或改登录配置。
- 已通过真实浏览器表单登录；无持久数据写入（仅会话登录与浏览）。
- 运行列表刷新真实浏览器：请求期间“刷新中…”+disabled+旋转，完成后“刷新”+enabled+无旋转；技能市场安装按钮已确认opacity150ms过渡，未执行安装写入。
- 浏览器真实组件探针：Accordion展开高度约64.5px，CSS height150ms，关闭Panel卸载且aria-expanded=false；超过64KB CodeBlock默认不渲染、展开可读、关闭卸载并回焦到内容触发器。探针仅临时页面DOM，结束清理，无生产/数据库写入。
- 共享反馈 B 已完成，保留 Button DOM 的复制交叉淡入、Base UI 浮层原生过渡与 CSS reduced-motion 延迟归零。全源码已无 tw-animate-css 运行引用，新增窄范围清理任务仅移除 web package/lock 的死依赖。
- A 共享折叠已完成：新生命周期回归真实红→绿2项，相关123用例通过；C 对话/专家/评估已完成：草稿和版本按需加载回归，相关191用例通过。
- 独立业务评审首轮4项：媒体查询缺空格、SourceRuns提前清空/共享查询、无hover细指针按钮隐藏、服务器pending文字低对比度；专项Sonnet按限定文件修复中。同类CodeBlock显影单文件补修。
- 共享Opus首轮仅1项：Carousel reduced-motion 拖拽松手后仍有惯性；真实浏览器复现remaining约254px，专项Sonnet用官方事件修复。其余共享项目通过静态与部分浏览器验证（DataTable宽度/零高、折叠快速反转、复制尺寸、Dialog退出回焦、减少动态延迟）。
- 死依赖清理完成：pnpm remove tw-animate-css，package/lock仅9行删除，`pnpm install --frozen-lockfile --lockfile-only`成功。
- E 已完成：图片处理组共享折叠、Embla 键盘 jump 与 reduced-motion 按钮 jump；2 个边界行为测试真实红→绿，相关 52 个用例通过。
- 整合阶段 `pnpm test:web`：68 文件、687 用例通过；`pnpm --filter './packages/web' typecheck`：退出0。前一次类型检查碰到并行写入中的 knowledge-detail 未闭合JSX，文件写完后复跑通过。
- 媒体查询修复后构建退出0，非法媒体查询警告已消失，仅保留既有chunk体积提示。真实浏览器历史菜单fine+hover默认opacity0，键盘聚焦1，触摸无hover为1；CodeBlock复制同规则实测通过。
- 修复中全量测试曾为69文件/691用例，其中2失败：carousel-reduced-motion普通偏好隔离、knowledge-source-runs退出窗口模拟。两项均为新增测试、实施代理尚在完善；未把此轮称为最终通过。
- Carousel pointerUp接线最终由Opus源码+真实浏览器独立核实：同步remaining254px来自Embla同target跳过同步render；jump=true已将duration设0，下一RAF直接location=target=-516，普通模式duration25且继续缓动。保留官方API修法，不加入内部引擎代码。此轮共享缺陷可关闭，轮播测试验证监听和清理。
- Carousel最终专项测试2文件3用例通过；独立Opus源码/实测确认修法有效（duration0、下一更新直接落目标）。普通拖拽和鼠标按钮仍保留原行为，键盘即时。
- 最终生产 `pnpm --filter './packages/web' typecheck`、`pnpm lint:focus`、`pnpm lint:contract`、`git diff --check`均通过；已完成的37个源文件/测试 Biome通过。
- 改动后再次逐页桌面与320px触摸视口检查：单一h1、无文档级溢出；插件/知识库仍旧API缺口，无新增页面运行错误。
- 业务Opus第二轮确认四项生产代码均已修；待补SourceRuns受控退出窗口测试最终卸载与A→B并存断言，以及chat/eval ease-out-soft。已将收尾交窄范围新Sonnet，旧修复代理停止避免冲突。
- 浏览器已实测 CopyButton 成功确认、两图标16px与原28px按钮；Dialog opacity150ms、无keyframes，关闭焦点返回；版本差异展开后16px、收起inert并卸载；对话成果栏收起0px且inert，快速开合保留草稿；320px成果抽屉无溢出。逐帧采样仍受Ego环境RAF节流，不能声称动画每帧流畅。
- 改动前 `pnpm test:web`：64 个文件、680 个用例通过，退出 0；`pnpm --filter './packages/web' typecheck`：退出 0。
- 改动前桌面与320px触摸视口遍历14个可用页面/状态，单一h1、无文档级横向溢出；包含真实运行详情。专家配置及配置版本历史亦已浏览，差异异步展开成功，关闭后焦点返回实际版本历史入口。知识库/插件成功态仍受旧API缺口影响。
