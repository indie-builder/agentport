# 找专家：已创建专家卡片重新设计

## 目标
在原有 208px 高度、列宽与 16px 网格间距内重设计已创建专家卡片，改善信息层级、介绍阅读宽度与操作辨识度；保留工牌、配置、删除、启停与权限行为。

## 方案
复用现有 shadcn Card/Button/StatusBadge、AgentAvatar 及列表摘要；身份头部、全宽介绍、操作区分层。姓名不再同时被两个图标挤压，工牌使用可见文字入口。只展示真实字段，不增加后端请求、统计或虚构能力。固定布局：上下 padding 共32px，身份头部48px（40px头像＋姓名/角色，右上仅更多），间距12px，中部72px（全宽两行介绍40px＋至多两行权限说明32px），间距12px，操作行32px（左开始对话，右工牌），合计208px。不加底带、分隔线、无数据标签；无介绍保留中部空间，停用状态与角色同行。

## 基线与范围
- 路径：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/expert-card-redesign`
- 分支：`worktree-expert-card-redesign`
- 基线：`8335cefc36118faec1bb95f3147ed868419a746b`，与 fetch 后 origin/main 相同。
- 初始未提交差异：无。
- 允许范围：`packages/web/src/pages/agents.tsx` 的列表卡片与工牌专用展示、相关 web 测试、必要根 E2E 断言、`docs/DESIGN-SYSTEM.md` 与 `packages/web/DESIGN.md` 对应专家卡/工牌契约、本任务记录。

## 当前有效决定
- 用户要求重新设计已创建卡片，尺寸维持现状，允许重新组织布局与丰富内容。
- 保留两张创建入口卡、网格规则、40px 专家头像与原有业务功能。
- 保留项目现有纯白/中性颜色、字体、圆角、共享控件。
- 用户最新授权：提交本任务改动、创建 PR 并合并，随后按 §2-7 清理本任务工作树并快进更新主 checkout 的 main；不触发或等待 CI。
- 2026-11-01 用户继续要求：点击后的工牌改为真正带挂绳、扣环与卡套的插画式工牌，替代普通表格和标准弹框外观。沿用本树与原卡片成果，范围扩到专用工牌展示、必要局部样式及对应文档/测试；保留可访问 Dialog 行为、完整真实信息与焦点返回。
- 工牌契约：专用透明 DialogContent、视觉隐藏原标题、固定可达关闭按钮；96px挂绳与扣环接360px宽竖式卡套，96px现有插画头像；姓名/岗位、启停、完整介绍、真实id及含时区创建时间以证件排版呈现。白底/中性token，装饰SVG不含文字，信息均为DOM。短视口整体单层滚动，长名/介绍不截断；不增数据请求或修改共享Dialog样式。

## 已替代项及原因
旧规范“开始对话紧跟介绍且不设独立操作区”的布局与本次重设计范围冲突，按用户本轮授权重新评估并同步规范。

## 步骤
- [x] 读取规范、并行定位实现与验证入口。
- [x] 建立隔离树并记录基线。
- [x] 实际查看现有页面与工牌。
- [x] 固定设计并派发实现与文档同步。
- [x] 独立 review 与范围验证。
- [x] 更新记录、交付预览与未提交差异。

## 改动文件
- `packages/web/src/pages/agents.tsx`：身份头部、全宽介绍、固定操作行。
- `docs/DESIGN-SYSTEM.md`：§9 专家卡当前契约。
- `packages/web/DESIGN.md`：同步实现快照。
- `docs/tasks/expert-card-redesign.md`

## 下一步
插画式工牌及原列表卡片改造已完成，独立 Opus 终审通过。按用户最新授权提交、创建 PR 并合并；合并后停止本树预览、删除本任务工作树，保留分支并更新主 checkout 的 main。

## 挂绳工牌追加步骤
- [x] 核对原工牌与交互，固定专用展示契约。
- [x] 源码实现与文档并行同步。
- [x] 真实渲染检查挂绳/卡套、长内容与短视口，回归焦点/关闭/停用/权限。
- [x] 独立 Opus 终审与范围验证。

## 验证
- 已用 ego-browser 进入真实 `https://agentport.localhost/agents`，实际打开故障演练工牌。
- 改前视口 1480×840，卡面宽 390.664px、高 208px，水平间距 16px。
- 改前截图：`/var/folders/9x/881dvsns4wv1dk0990m32_xm0000gn/T/ego-browser-shot-32474-1.png`。
- `pnpm install --frozen-lockfile` 通过；`pnpm --filter @agentport/shared --filter @agentport/core build` 通过。
- 页面布局变化使用真实浏览器矩形、截图与交互作为主要证据；已有权限/工牌/导航测试负责行为回归，不增加只断言类名的测试。
- Qoder 本轮未操作；直接沿用已有设计规范令牌，不修改主题或控件状态。
- 最终 `pnpm --filter @agentport/web typecheck` 通过；`pnpm --filter @agentport/web build --logLevel error` 通过。
- 最终 `pnpm test:web packages/web/test/agents-lifecycle.test.ts packages/web/test/expert-permission-empty.test.ts packages/web/test/audit-action-feedback.test.ts`：3 文件、87 项通过；jsdom 输出非阻塞的 `Window.scrollTo` 未实现提示。
- 执行代理补充运行 `pnpm test:web packages/web/test/agents-ui.test.ts`：43 项通过。主会话补充运行头像映射测试：5 项通过。
- `pnpm lint:focus` 通过；`rtk bypass pnpm exec biome check packages/web/src/pages/agents.tsx` 通过，因包装器把正常输出误标为失败而使用 bypass 查看真实结果；`git diff --check` 通过。
- 实页覆盖1480×840、1280×800、1024×800、800×800；卡面始终208px高，实际宽度390.664/320.664/361px，无页面横向溢出、内部裁切或多余h1。最终姓名计算字号14px、行高22px。
- 真实工牌打开/关闭与焦点返回通过；开始对话实际进入指定agent URL；停用卡按钮disabled且无chat链接，工牌内容仍正常；更多菜单包含配置/删除，姓名链接实际进入对应配置页。
- 预览：`https://worktree-expert-card-redesign.agentport.localhost/agents`；代码根与基线见上，Vite纯前端、不加载根env，API沿用已有3000服务；登录验收只读取主checkout `.env`，未修改配置或账户。
- 最终截图 `/tmp/expert-cards-redesigned-final.png`；未运行全站E2E或全量web测试，使用相关行为回归与实页证据。
- 实现中13px姓名与规范冲突，已恢复 `text-base` 并以实页14/22复核。旧规范的紧跟介绍/空介绍不占位布局条款已随本轮授权同步替换，未发现其他代码/文档冲突。

### 2026-11-01 插画式挂绳工牌追加验证
- 工牌专用透明 DialogContent 替代 DialogShell，保留 Base UI 原语及原标题/回焦，未修改共享组件；96px挂绳、360px宽/min480px卡套、96px方形插画证件照，全部原摘要信息完整保留。
- `pnpm --filter @agentport/web typecheck`、`pnpm --filter @agentport/web build --logLevel error` 通过。
- `pnpm test:web packages/web/test/agents-lifecycle.test.ts packages/web/test/expert-permission-empty.test.ts`：2 文件、81 项通过。含工牌摘要不请求详情、缺省介绍与日期、停用数字分身、无创建权限读者、关闭回焦与选中实体消失行为。
- `rtk bypass pnpm exec biome check packages/web/src/pages/agents.tsx`、`pnpm lint:focus`、`git diff --check` 通过。
- 真实浏览器：透明背景，外层所有 box-shadow 为0；挂绳96px、证件照96px、卡面360×480px。截图 `/tmp/employee-badge-final.png`。
- 1024×600 实页：Dialog y16..584、高568px；滚动区可见528px/总588px；关闭按钮 y28..56，无横向溢出。关闭按钮、Esc、背景点击全部关闭并返回原工牌触发器。
- 临时DOM布局探针（未写服务端数据、刷新即恢复）：800×600、长姓名与300段重复介绍，滚动总高3427px/可见528px，姓名与介绍无line-clamp、无横向溢出，滚动末尾可见真实上岗时间且关闭仍可达。该项仅证明布局伸展，不代替业务数据保存测试。
- 本次展示改造复用已有行为回归与实页视觉证据；终审发现键盘滚动入口缺口，追加具名可聚焦 section 与行为断言。先红（内容区不存在）再绿，lifecycle 73项通过；最终两文件81项、typecheck/build重新通过。浏览器预览已交还用户，修复后Tab/PageDown未单独实测，不将静态焦点属性断言冒充真实键盘滚动；未跑全站E2E。
- 文档冲突已修正：原工牌必须使用标准 DialogShell/摘要列表的条款替换为本场景专用透明实体工牌例外，不改变全局弹框契约。
