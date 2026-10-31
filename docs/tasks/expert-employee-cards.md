# 专家卡片与数字员工工牌

## 目标

以「新建专家」「创建数字分身」入口卡当前原始尺寸为基准，统一已有专家与分身的卡片尺寸。卡片展示真实角色和介绍摘要，提供独立身份图标，点击查看数字员工工牌及真实可用的身份、介绍、时间资料。

## 方案

复用现有专家列表、头像、角色、查询、Card 与 DialogShell；先核对字段来源和时间含义。卡片摘要与完整工牌分层展示，保留名称配置链接、开始对话、停用与删除权限。使用 LoopX goal `expert-employee-cards`、agent `expert-cards-controller` 记录推进和验证。

已通过 `pnpm dlx shadcn@latest docs button card dialog -c packages/web` 核对官方组件文档；Dialog 保留标题、关闭与焦点返回，按钮与链接各按自身语义组合，不另造弹层交互。参考来源：`https://ui.shadcn.com/docs/components/base/dialog`、`https://base-ui.com/react/components/dialog.md`、`https://ui.shadcn.com/docs/components/base/card`、`https://ui.shadcn.com/docs/components/base/button`。

## 基线与范围

- 当前隔离 worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-cleanup`。
- 分支：`worktree-codebase-cleanup`；起始 commit：`0249734bec75f94973a6cc5db18b02499014a24e`。
- 初始工作区 clean，无需归属的既有未提交差异。
- 本会话宿主限定使用当前隔离目录，因此复用该树；未切入主 checkout，未重置清理任务已提交基线。
- 预期范围：web 专家列表、相应行为测试、设计规范及本记录；后端是否需变更依字段核对确定。
- 无 commit/push/merge 授权，以未提交差异交付。

## 当前有效决定

- 用户明确指定以创建卡大小为标准，所有已有数据遵循同一尺寸。
- 角色与完整介绍必须可读；工牌由独立图标触发，不挤占配置与对话入口。
- 不虚构履历与上岗日期，不无声将创建时间冒充首次上岗时间。工牌时间明确命名「上岗时间（创建时间）」并使用真实 `createdAt`；缺失或无效时显示「未记录」。
- 工牌只读使用列表 `AgentSummary` 的已有授权字段，不请求详情、提示词、绑定或成员资料；无需后端/DB/shared schema 改动。
- 四类卡片（两个入口、专家、已有分身）统一 `h-52`（208px），列宽和16px gap不变；名称和角色分两行，介绍最多两行，完整信息在工牌读取。
- 复用单一 Dialog 与 DialogShell，真实触发器焦点返回；空介绍在工牌显示「未填写介绍」，停用与无创建权限仍可查看已有员工工牌。
- 实现由 Sonnet high 子代理执行，关键契约与独立终审使用 Opus high。

## 已替代项及原因

- `docs/DESIGN-SYSTEM.md` §9 原有专家卡「不固定卡片高度」与本次用户指定统一尺寸冲突，本次应同步更新该契约。

## 步骤

- [x] 核对真实字段与创建卡几何，固定实现契约。
- [x] 补充行为测试并实现统一卡片与工牌（源码/单测和文档/E2E按文件边界并行）。
- [x] 执行范围内检查、真实浏览器几何和键盘验证。
- [x] 独立 Opus review 通过，无必须修复项；验证与完成状态已回写 LoopX，Todo done/no_followup，已停止会话续做循环。

## 改动文件

- `packages/web/src/pages/agents.tsx`：卡片尺寸、资料排布、身份按钮与单一工牌弹窗。
- `packages/web/test/agents-lifecycle.test.ts`、`packages/web/test/expert-permission-empty.test.ts`：真实字段/空资料/缺失时间/停用分身/只读权限/焦点与缓存消失行为。
- `tests/agent-defaults.e2e.ts`：真实几何与工牌专项 E2E，扩展既有自动清理 fixture。
- `docs/DESIGN-SYSTEM.md`、`packages/web/DESIGN.md`、`docs/USER-STORIES.md`：同步尺寸与工牌契约。
- 本任务记录。

## 下一步

无实现待办；已验证完成，以当前工作树未提交差异交付，未合入 main。保留预览供用户验收。

## 验证

- 首次浏览器检查：`https://agentport.localhost/agents` 为 Portless 404（No app registered），不作为本任务运行源。
- 当前树预览：`https://worktree-codebase-cleanup.agentport.localhost/agents`；代码与 commit 见基线，配置为本树 `.env`；前端端口 5183。API 复用 localhost:3000，相关 schema/migrations 与运行源无差异；未修改其他树服务及用户账号。
- 浏览器基线（1492×818）：3 列、gap 16px；两张创建卡均为 394.7×208px；数据卡外框为 394.7×118px（有介绍）或 394.7×98px（无介绍），其 li 被拉伸至208px。头像40px，卡片内边距16px。1024×768窄桌面复测为2列、卡宽366px，入口208px、已有卡118/98px，无页面横向溢出。
- 实现前 `pnpm --filter @agentport/web typecheck`、`pnpm lint:focus`、`pnpm lint:contract` 均通过。
- 实际打开「新建专家」并关闭，未提交或创建数据。基线截图 `/tmp/expert-cards-baseline.png`。
- 红→绿：先新增7个工牌用例，真实失败为缺失工牌按钮；实现后 `pnpm test:web packages/web/test/agents-lifecycle.test.ts packages/web/test/agents-ui.test.ts packages/web/test/expert-permission-empty.test.ts` 3文件124项通过（主会话复跑确认）。jsdom提示 `Window.scrollTo` 未实现，无失败。
- 独立 Opus 终审明确通过、无必须修复项；独立复测1492/1024宽度卡片全208px、746×409短视口无横向溢出及Enter/Esc焦点返回，通过Biome四文件与diff检查。未验证原生浏览器200%缩放。
- LoopX验收写回 `validated_delivery/primary_goal_outcome`，vision_closed，原Turn验证/持久回写/quota/Todo终态四步回执均 committed；关闭Todo时需补齐hard_lease key/version，已完成且自动释放，无后继任务，续做cron已取消。
- `pnpm --filter @agentport/web typecheck`、`pnpm --filter @agentport/web build` 均通过；构建仍有现存500kB chunk提示。
- `pnpm lint:focus`、`pnpm lint:contract` 通过；Biome初次指出新增测试两行格式，子代理修正后四个改动源码/测试文件检查通过；`git diff --check` 通过。
- 真实浏览器1440×900：全部6张卡高208px，同列宽约377.33px、行列间距16px；1024×768：全部高208px、同列宽361px，无页面横向溢出。名称和介绍长文本临时DOM夹具复测卡高208，内容未越卡面；该夹具只验证布局，未写服务器数据，已刷新还原。
- 工牌560px宽，真实资料与原ISO时间属性可读，空介绍「未填写介绍」；Enter打开、Tab留弹窗、Esc/关闭/外部点击均回原工牌按钮。长介绍临时DOM夹具内容区499px/scrollHeight3018px，关闭按钮可达、无横向溢出；已刷新还原。截图 `/tmp/expert-cards-unified.png`、`/tmp/expert-cards-1024.png`。
- 专项 `expert cards and employee badge` E2E通过，auth setup同时通过；主会话读取 `.e2e/report.json` 确认该用例status=passed、整体selected2/passed2。复用运行API实际数据库，3条临时员工fixture测试后已清理；未执行全量E2E。
- 环境限制：本树 `.env` 指向的历史开发库缺少 `created_by`/`owner_business_id`，不能直接当运行API库；测试使用当前API实际库，未迁移/重置共享库，未改账号。
- 发现的既有测试冲突：`tests/smoke.e2e.ts` 仍按「配置 ${agentName}」按钮定位，而当前页面已有名称链接和操作菜单；本任务未运行或修改该无关冒烟。
