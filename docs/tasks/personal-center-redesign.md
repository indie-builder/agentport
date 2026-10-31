# 个人中心整体布局重新设计

## 目标

2026-10-31 用户要求使用 Impeccable，从实际 UI 重新构想并重新设计个人资料、个人记忆、历史回顾、安全与会话、我的分享、使用记录六页。保留 Qoder 浅色视觉、已有业务行为和左下角独立账号入口。本任务启动时未授权 commit/push/merge；2026-11-01 用户已授权本次 PR 交付与合并。

用户随后明确要求以用户故事、动线与UX重新组织各页，并已批准[用户动线方案](personal-center-ux-brief.md)。当前执行以该方案为准；下文记录上一阶段布局验证与本轮新交互的实测结果。

## 基线与范围

- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/personal-center-redesign`。
- 分支：`design/personal-center-redesign`；基线：`624dc3bd523e6b675cc27127b0ea609c9834351f`，即 PR #146 合并后的 main。
- 初始差异只有本任务记录，源码从干净基线开始。复用原树，不改变主 checkout。
- 范围为个人六页、AppShell 个人上下文、个人父路由与相关测试和文档；不改后端、数据库、依赖、主题、权限数据或用户凭据。
- 工程按 ub-mode，主会话不写代码；源码与测试全部由 Sonnet 子代理按文件独占执行，设计与独立终审交 Opus。

## 方案与当前有效决定

1. Impeccable 模式 Operate、code-led，保留现有 PACE 视觉世界。context 与 concept-seed 各执行一次，既有抽取顺序 6/5/7，引用 `seed:214cadded55ffbb9`，不重复抽签。
2. 按直接继续、不再提问的要求自主选择第 6「个人上下文」，不记为用户审图批准。原侧栏在个人页替换为六项个人导航，复用现有运维上下文、SidebarLink、折叠和窄桌面 Sheet；不增加第二级侧栏或导航状态机制。
3. 展开224px、收起64px，外壳4px边距、16px圆角、白内容面、24px内容边不变。六页从标准56px PageHeader开始，删除内容顶端横向六chip。
4. 底部依次提供返回工作区、独立退出、账号入口；无业务权限不显示返回死链。退出仍走 logoutAccount。账号原ghost结构和外观不变：展开200×32、20px头像、12px文字、7px角、透明、头像姓名左对齐；收起32×32。
5. 六页 URL、权限、本人数据范围、RHF草稿、dirty/pending、错误恢复、记忆revision/版本/回滚、回顾流程、会话鲜度、分享与运行深链均保留。

### 结构比较

| 排位 | 候选 | 取舍 |
|---|---|---|
| 1 | 工作区内设置目录 | 全局侧栏外再加个人目录，窄桌面挤压内容 |
| 2 | 页头分类工具栏 | 六路由和标题挤入56px头部，密度偏高 |
| 3 | 三组目录带 | 资料/安全、记忆/回顾、分享/记录分组清楚，但每页都消耗目录带高度 |
| 4 | 单入口页面选择器 | 节省空间，六目的地发现性降低 |
| 5 | 展开式设置册 | 当前路由内容展开，长记录让其他目录进入滚动区 |
| 6 | 个人上下文 | 复用原224/64侧栏，无双侧栏、无顶部chip，采用 |
| 7 | 全幅个人工作面 | 保留工作侧栏与独立line导航，仍有两套目的地占据首屏 |

既有抽取6/5/7中采用6。UX获得连续导航和内容空间；DX复用现有机制；AX保留真实链接、当前项、唯一h1和焦点逻辑。无新增机制或依赖。

## Direction contract

原生契约位于 `packages/web/.impeccable/surfaces/packages-web-src-routes-shell-personal-tsx.md`，经 surface-brief write/read 建立和回读；该目录被现有 gitignore 排除，版本化交接以本记录为准，不为此改配置。

- **THESIS**：个人中心是可返回工作区的独立任务上下文。导航归侧栏，短表单动作归字段，长记录首屏展示实体。
- **OWN-WORLD**：保留静态外壳渐变、纯白内容、墨色动作、中性选中、Inter与共享shadcn/Base UI，账号锚点不动。
- **STORY**：从底部账号进入，原位置侧栏切换成六项，完成本人任务后返回工作区。具名交互「原位换境」沿用立即切页、现有侧栏与浮层过渡和reduced-motion，不新增动画。
- **FIRST VIEWPORT**：单侧栏、唯一h1；资料768px带/448px字段及下方动作；记忆编辑器+280px版本栏；安全320px改密栏+会话；记忆/安全容器不足800px顺序堆叠。回顾为筛选+创建+列表，分享单表及表后分页，使用记录为窗口+三行汇总+独立筛选的运行表。
- **FORM**：第6「个人上下文」，抽取6/5/7，`seed:214cadded55ffbb9`，代理自主选择。
- **FINISH**：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## 实现

| 区域 | 最终实现 |
|---|---|
| 外壳与资料 | PERSONAL_MENU进入主导航，原权限可见性；移除PersonalLayout wrapper，父路由直接Outlet。资料带768px、姓名448px、动作在字段下右对齐；身份标签96px，父flex gap表达间距 |
| 记忆 | 800px容器条件两栏、版本280px、gap24、版本栏左线及20px内边距；SourceEditor外框至少384px；下载/保存在编辑区右侧，保留冲突、回滚和草稿保护 |
| 回顾 | 原筛选/新建/列表/详情与创建Dialog，内容限宽1024px；不动共享流程与权限 |
| 安全 | 容器800px两栏、左320px；UA完整换行，时间/IP次行，右槽稳定放当前标记或撤销；改密撤销全部会话说明只保留一次 |
| 分享 | DataTable唯一行数，文件/来源全文换行；分页移表后，保留复制、撤销和来源权限 |
| 使用记录 | 删除十行纵表，开放dl三行运行/Token/成本；全部状态含0、null/0与覆盖信息保留。时间窗口独立，专家/状态/来源只放明细区；游标、UTC和深链不变 |

设计初稿的资料720px、编辑器352px、三列汇总、安全页退出已被最终768px、384px、三行dl、侧栏退出替代，不作为未满足项。

## 验证与真实结果

### 行为与机械检查

- 修改前前端基线：141文件、1674测试通过（`pnpm test:web -- ...`参数未有效筛选，实际跑成全量，如实记录）。
- 新导航测试先红：11失败、55通过，失败来自个人上下文尚未实现。
- 最终定向命令：`pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/shell-route.test.ts packages/web/test/personal-memory-page.test.ts packages/web/test/personal-module.test.ts packages/web/test/memory-review-page.test.ts`，4文件113/113通过、0失败。
- `pnpm --filter @agentport/web typecheck`通过。
- `pnpm --filter @agentport/web build`通过，既有大chunk提示保留。
- `pnpm lint:focus`、`pnpm lint:contract`、`git diff --check`通过。
- 直接Biome对11个改动源码/测试文件检查通过，无修复项。测试生成的`.vitest/json/output.json`仅属本次运行，已还原。
- Impeccable detect对全部变更UI源码运行一次，结果`[]`。无新增栅格素材，不适用素材来源扫描。
- 末次清理删除了无实际触发路径的personalNavTargets过滤，直接沿用homePath；无业务权限不显示返回的真实测试保留，shell-route最新52/52通过。最终typecheck与build重新通过，未重跑无关全量。
- 浏览器已以`finish({keep:['p1']})`交回用户，停在已登录的个人资料，姓名仍为admin、无未保存对话框、主导航6项且无横溢出；服务health/ready仍200。
- DESIGN.md的Personal、Navigation与Known Gaps已局部同步，原token未改；预先存在的design.json sidecar漂移未顺手修复。独立复核正在结算两个文档证据修正。

### 浏览器

预览：`https://personal-center-redesign.agentport.localhost`；代码根为本树，基线624dc3b，使用`business-e2e-dataset/.env`显式临时配置。没有修改主.env、账号、密码、Cookie或业务数据；只登录并只读查看，临时姓名草稿未提交后取消。

- 1492×818六页各一个h1，PageHeader y4/h56，无document横溢出。
- 资料：姓名字段right696、保存right696；账号仍200×32/20px头像/透明flex-start/12px/7px。
- 使用记录：表格y434、首行y459；原表格y808.5。
- 1280×800：内容约994px，记忆版本280px、两栏；安全改密320px与会话并列。
- 1024×768：内容748px，记忆版本y530顺序堆叠；安全会话标题y455.6；使用记录首行y459；均无document横溢出，运行表只在自身容器横滚。
- 900×768：复用既有Sheet，六项可见并点击记忆成功，一个h1、无document横溢出。
- 临时姓名草稿切页出现放弃确认，取消保留草稿，再取消编辑恢复服务端姓名；未保存姓名。
- 收起侧栏后六项可达、账号32×32，展开恢复；回顾详情Esc关闭后焦点回原查看按钮。
- 没有真实改密、撤销会话/分享、保存记忆或触发模型；这些已有行为由定向单测覆盖，不宣称真实写链路验收。
- 截图位于`/tmp/personal-redesign-*`、`/tmp/personal-verified-*`和`/tmp/personal-final-*`。浏览器截图偶有下一画面覆盖先前捕获的时序现象，按h1/当前项辨识，不能仅据文件名；评审据实际画面结算。

## 文档与代码冲突

1. 规范称个人独立导航，旧实现仍是工作/构建侧栏+顶部chip；本轮具体落实为现有AppShell上下文。
2. “我的分享”页标题与“我的会话分享”表格可访问名职责不同，两者均保留，不加重复h2。
3. PRODUCT与DESIGN旧称原个人模块未合入；PR146已在本树基线，PRODUCT已修正，DESIGN在最终documenter阶段校正。本轮布局已完成本地验证，待本次 PR 合并。
4. 全宽Page不要求字段全宽；资料只收敛内容子区，不更改共享Page或引入居中外壳。
5. 原生surface目录被gitignore排除，未改配置，契约持久记录于本文件。

## 步骤

- [x] 恢复独立工作树、读取规则与实际六页
- [x] 七候选比较与方向契约
- [x] 按文件边界并行实现，新增导航行为先红后绿
- [x] 类型、构建、定向行为、机械检查与桌面实屏复核
- [x] 独立Opus finish review与必要修正：首轮fidelity匹配且无高置信回归；两项文档/seed证据修正经独立复核均resolved，disposition ship（复核范围仅两修复与返回过滤清理）
- [x] DESIGN.md实现快照与最终交付记录

## 下一步

实现与本地验证完成，待本次 PR 合并。最新证据：web 全量 142 文件 1712 条通过，定向 6 文件 157 条通过；安全页最后修正仅主行 13→14，实屏 1492 / 1024 两宽主行高 64px、无跳动；worker 26 条为历史已通过结果，本次复跑因 PostgreSQL 不可用跳过，需与通过结果区分。独立最后定点终审正在进行，本记录不预写通过结论。下一步为 PR 交付与收尾。

原始roll已从既有会话日志找到，未重新抽签。来源：`11e8be60-fcae-47e7-951f-ab8bad3a1d22.jsonl`，消息UUID `edfc4713-25f3-43ce-8697-dde94eecdd6e`，tool result `call_e54ca8c1dd254b80b2801a17446ff63d`。原输出关键行：

```text
SURFACE CONCEPT SEED (... mode: operate; source: api; approved pool: c3b204a1eed6; 306/564 human-approved ...)
DEALT INDICES: 6, 5, 7 (index 6 leads)
SEED REFERENCE: seed:214cadded55ffbb9.
```

审查工具当前返回SEED UNKNOWN作为本机索引缺失如实保留，不据此重抽；原始工具返回可核对引用与6/5/7来源。预览服务与登录页保留供用户查看；本轮启动时未 commit/push/merge，2026-11-01 已授权本次 PR 交付。
