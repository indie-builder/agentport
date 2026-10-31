# 基于设计规范的前端审计与修复

## 目标

用户于 2026-10-31 授权使用 Impeccable 审计当前前端，并直接修复确认的问题。基于刚刷新的设计规范，检查可访问性、性能、主题一致性、桌面伸缩与实现完整性；输出可追溯的问题与修复证据。本记录以最终实际命令结果验收，中间态只作历史定位。

## 方案

先按 Impeccable `audit` 做五维技术审计，随后按 `polish`/对应修复指引处理有证据的缺陷。优先共享组件与真实交互根因，不改变既定视觉风格，不新增移动端/深色模式，不将已接受的输入浅边线对比度限制当作本次改色授权。源码/浏览器检查并行；共享文件保持单一写入者。根据实际变更运行 web 验证与独立 Opus 终审。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/frontend-design-audit`
- 分支：`fix/frontend-design-audit`
- 基线：`56f01663acff77383ed0cb29cac5cde0971d4238`，等于刚 fetch 的 `origin/main`。
- 建树初始 `git status --short` 为空。
- 随后导入上一任务已审查的 4 份设计文档差异（`docs/DESIGN-SYSTEM.md`、`docs/README.md`、`packages/web/DESIGN.md`、`packages/web/.impeccable/design.json`），作为本次审计的设计基准；原任务树与未提交成果保留。导入补丁为 `/tmp/frontend-design-docs-baseline.patch`，不覆盖他人改动。
- 审计面：`packages/web` 当前所有页面、共享组件、样式；修复限确认问题和其测试、设计快照/本记录。后端仅作既有服务连接，不改账号、数据或基础设施。
- 范围限定桌面浅色界面。未做移动端、深色主题与运行时性能采样；这些不属于本轮验收项，也不能由本轮结论推导为通过。
- 用户已明确授权提交 PR、合并与收尾；当前正在同步 `origin/main` 并发布，合并完成前不声称已合入 `main`。

## 当前有效决定

- 用户已授权“查看并修复”，audit 的只报告阶段后直接进入修复，无需再次确认。
- 已有设计方向保留；桌面端、Qoder 外观、中性动作与既定布局优先。
- `impeccable context` 本会话已执行，不重复运行。审计及 polish 指引已读；UI 编辑前读取 craft-floor。
- 主会话只编排、阅读、审查和验证；代码改动派给子代理。
- 用户已明确授权提交 PR、合并与收尾；当前正在同步 `origin/main` 并发布，合并完成前不以已合入状态记录。
- 已接受的限制保持：输入默认浅边线低于 3:1、既定 reduced-motion、仅桌面浅色；不借本次修复扩成改色或新增主题。

## 已替代项及原因

无。

## 步骤

- [x] 读取 audit/polish 与项目流程，建立隔离树并导入已审查设计基准。
- [x] 并行审计源码与真实浏览器页面，确认问题和误报。
- [x] 冻结修复清单，按文件边界并行实施。
- [x] 按变更范围完成共享视觉、焦点、链接语义、缓存/权限、只读与信息表达修复。
- [x] 完成卡片 invalid 定点复核、skills/feedback 复评、修复后 detector 与最终全量复跑，交付未提交差异。

## 审计评分（初始 16/20，每维满分 4）

| 维度 | 初始 | 主要根因与修复 | 仍存限制 |
| --- | --- | --- | --- |
| 可访问性 | 3/4 | 表头弱化、选中控件焦点、链接/按钮语义、禁用原因、重复名称、只读入口、技能读权限撤权与卡片 invalid 均已修并复测 | 未做整页 WCAG 达标证明；输入浅边线对比度为已接受限制 |
| 性能 | 3/4 | 仅做源码机械 detector 与构建检查，未据此优化 | 未采样运行时性能，不形成性能结论 |
| 主题一致性 | 4/4 | 表头/行 hover/页脚底色、字号、圆角、中文默认文案与 composer 无阴影对齐 | 输入浅边线对比度为已接受限制 |
| 桌面伸缩 | 3/4 | 16 主路由 1440/1024 实测无横溢、单 h1；767 输入固定 13/20 | 未跑根 e2e；800px 只覆盖专家/插件详情与专家页，其余主路由以 1440/1024 验收 |
| 实现完整性 | 3/4 | 缓存错误保留内容、eval 权限区分、只读边界、输出空态、链接语义、skills/feedback 复评均已修并终审通过 | OpenUI 2 个既有 missing 未补齐；2 条既有 Biome warning 非本轮新增 |

初始 16/20 是审计起点，不作为修复后重新打分的依据。修复完成后不改写为满分：性能未采样、根 e2e 未跑、OpenUI 2 个既有 missing、2 条既有 warning 仍在，最终以实际命令结果与未覆盖项验收。

## 问题、根因与状态（按严重度）

### P0

无阻塞问题。

### P1

| 问题 | 根因 | 状态 |
| --- | --- | --- |
| 技能 `files.read` 撤权时卸载文件编辑器，丢草稿并挂起 pending | 编辑器生命周期直接绑定权限查询，未在卸载前结算草稿与 blocker | 已补保留生命周期、隐藏正文与停止新读；新增 11 条测试，技能相关 47 项通过；独立 Opus 复核明确通过 |

### P2

| 问题 | 根因 | 状态 |
| --- | --- | --- |
| 共享表头 13px/正文色，不符合 12px/辅助色 | 共享 Table 原语未按 §9 表格契约收敛 | 已修；真实页面测得 12px / `rgb(95,95,95)` |
| 表格行 hover 为半透明 muted、selected 与卡片 footer 不一致 | 共享原语沿用 alpha hover，卡片页脚未对齐 | 已修；普通/展开行与 footer 实测 `rgb(246,246,246)` |
| 选中 Checkbox/Switch 焦点环与深色填充贴合 | 选中态仍用 ring，未使用已批准的单层 outline 例外 | 已修为 `outline solid 2px` + `offset 2px`，无可见 ring；卡片 invalid 组合已实测通过：3 个控件 border `rgb(180,35,24)`，内部 outline none / ring 0，外层 label 单层 2px ring |
| 导航/下载入口被 `Button` 强制成 `role=button` | 有 href 的入口误用动作组件而非原生链接 | 全局检索 18 处后仅迁移真实导航/下载入口；插件实页 AX 已验证链接语义 |
| 缓存刷新失败时整块卸载已有数据 | 查询错误分支未区分“无缓存失败”与“有缓存刷新失败” | 已修；新增 9 条 QueryClient/Router 行为测试；真实刷新拦截保留 14 行并恢复重试 |
| eval 无权限、pending、error 状态混用并可能卸载草稿 | 页面状态未区分权限与后台错误 | 已修并由独立 Opus 终审通过 |
| 通用 DataTable 行缺少业务可访问名 | 行标识只有主键，没有可读业务名 | 增加可选 `rowLabel`，仅交互实例传入；补行为测试 |
| 连接器/技能在只读权限下仍出现编辑入口 | 查看与编辑权限未分离，技能支持文件未独立控制 | 增加只读视图与 `skills.files.read/write`；补充行为测试并由独立 Opus 终审通过 |
| 会话运行详情、插件详情、运行日志、知识原文与搜索清除存在重名 | 可访问名只复用泛化文案，未带对象/位置 | 已修；knowledge 同名文档以共同 44 字前缀带 index 且保留「查看详情」前缀，相关 128 项通过；e2e 清除按钮断言同步为带对象名称 |
| 无会话时 conversation outputs 空态不准确 | 空态未区分“无会话”与“有会话无成果” | 已改为正确引导；有会话语义不变 |

### P3

| 问题 | 根因 | 状态 |
| --- | --- | --- |
| CardTitle 行高低于 14/22 | 共享 Card 标题保留 `leading-snug` | 已修；实页测得 14/22 |
| 共享图标按钮圆角未统一 7px | 图标按钮实例遗漏圆角令牌 | 已修；聊天会话头部菜单 32×32 / 7px，侧栏与账户 7px |
| 聊天会话菜单按钮 28px，偏离 32px 规范 | 实例自行覆盖尺寸 | 已修；头部会话菜单回到 32px，28px 仅保留给明确的紧凑控件 |
| 767px 共享输入跳为 16/24 | 残留移动端字号切换 | 已统一桌面 13/20，并移除未引用的移动输入令牌 |
| Carousel/Sheet/Dialog/MessageScroller 默认可访问文案为英文 | 原语默认文案未中文化 | 已修，保留原语行为 |
| Toggle 残留无效 Radix `state=on` 类 | 旧类名未随 Base UI 迁移清理 | 已删，保留真实状态 |
| 未消费的 composer 阴影定义 | 定义未被任何组件使用 | 按零死代码删除；composer 实测无阴影 |

## 业务修复契约（定点裁定）

- 缓存刷新：runs 表与 overview 趋势仅首次无 data 失败整块报错；有缓存（包括空数组）保留原内容并显示真实错误/重试，不改查询策略。
- eval 权限：pending/error 与无权区分、可 refetch；无权限数据不开放操作，后台错误不卸载已挂载 CaseDialog/草稿；空用例创建入口补 `canManageEval`。
- DataTable 增加可选 `rowLabel`，仅交互实例 runs/overview 最近运行/eval/audit 传业务名；key/id/展开状态继续主键。
- 禁用原因仅补真实缺口：chat 无会话创建权、agents 启用却无使用权、audit 等待筛选、eval 比较不足 2 次、memory-panel 脏草稿回滚；已有停用/默认徽章与 eval 执行说明不重复。
- 重复名称：chat 运行详情、plugin 详情、runtime 日志、knowledge 原文带文档/位置、SearchInput 清除复用 label；knowledge 同名文档以 index 区分并保留「查看详情」前缀。
- servers/skills 保留标题查看能力，原弹层增加 readonly。定义权限分别 `servers.update`/`skills.update`；技能支持文件按 `skills.files.read/write` 独立控制读取/修改，无 read 不挂查询；权限变化不重置草稿，不改后端。
- skills 写回：保存成功先以服务端返回对象 `setQueryData` 写回缓存，再 `invalidateQueries({ refetchType: 'none' })` 仅标记失效、不自动重取；仅当前仍具备读取权限时才 `refetch()` 并等列表刷新后解 busy；撤权时暂停读取，恢复授予后立即用挂起 GET 重选新版本；删除同步清理缓存。
- conversation outputs 无会话时改正确引导；已存在会话无成果语义不变。
- memory-review 内部来源导航、AccessDenied 返回用 Router Link；保留 pending 拦截/blocker，不改外部新窗口链接。
- 排除：未实测技能搜索性能，不移除正文搜索；不为所有 disabled 按钮堆 helper。

## 改动文件

设计基准导入（非本任务新增，保留既有未提交成果）：

- `docs/DESIGN-SYSTEM.md`、`docs/README.md`、`packages/web/DESIGN.md`、`packages/web/.impeccable/design.json`。本任务同步 `DESIGN.md` 的焦点验收措辞；`design.json` 的设计基准随上述导入保留。

共享组件与样式：

- `packages/web/src/components/ui/`：button、card、carousel、checkbox、combobox、dialog、input、message-scroller、radio-group、sheet、switch、table、textarea、toggle。
- `packages/web/src/components/`：app-shell、conversation-outputs、data-table、memory-review、plugin-file-tree、reader-toolbar、search-input、source-editor。
- `packages/web/src/styles.css`。

页面：

- `packages/web/src/pages/`：agents、audit、chat、eval、knowledge-detail、knowledge、memory-panel、memory、not-found、overview、plugin-detail、plugins、run-detail、runs、runtime-environment-detail、servers、skills。

测试：

- 修改：`packages/web/test/` 下 account-rbac、audit-debounce、audit-details、chat-outputs、chat-ux、data-table、eval-feedback、eval-navigation、eval-runs-pagination、knowledge-management、memory-review-page、openui-card-layout-ui、run-detail-navigation、ui-focus-states。
- 新增：`packages/web/test/` 下 audit-accessible-actions、audit-action-feedback、audit-data-retention、button-link-semantics、server-readonly-audit、skill-readonly-audit、ui-controls-behavior。
- 根 e2e：`tests/audit-export.e2e.ts`、`tests/regression.e2e.ts` 已随文案/名称调整，但本轮未执行根 e2e。
- 本记录：`docs/tasks/frontend-design-audit.md`。

排除：`.vitest/json/output.json` 是 tracked 生成文件，已由主会话 restore，不在最终 diff 中。

## 验证

- 基线与路径：初始 `pnpm test:web` 为 132 files / 1600 tests 全部通过（`/tmp/frontend-design-audit-tests-before.log`）；本树真实运行 `https://frontend-design-audit.agentport.localhost` / 4380，commit 为上述基线，配置来自主 checkout `.env`（未改），API 3000 为既有 business-e2e-dataset 隔离库进程，未停止。登录一次通过，未修改账号资料。Ego 出现更新提示，未升级；浏览器任务 90 已 finish，keep 为空。
- 最新全量：`pnpm test:web` 139 files / 1648 tests 全部通过，exit 0（`/tmp/frontend-design-audit-tests-complete.log`），较基线 132/1600 增加 48 项；`pnpm --filter @agentport/web build` exit 0（`/tmp/frontend-design-audit-build-complete.log`）；typecheck exit 0。中间态 139/1645、139/1641 与 7 失败只作历史定位，不当作最终结论。
- Biome：63 files，0 errors，2 条既有 `noNonNullAssertion` warnings（chat-outputs、chat-ux），非本轮新增。
- 门禁：`pnpm lint:focus`、`pnpm lint:contract` 通过。OpenUI 覆盖审计 84 组件：behavior 14 / render 39 / nested 29，嵌套有交互但无行为证据 0，missing 2（IconButton、MetricIndicatorWithStrikethrough）为本轮前既有缺口，未新增交互缺口。
- Detector：修复前源码 detector 输出 `[]`（`/private/tmp/frontend-design-audit-before.json`）；修复后输出 `[]`，exit 0（`/private/tmp/frontend-design-audit-after.json`）。需如实说明：该次检测在最后一项 skills 缓存 `setQueryData` 补丁之前执行，该补丁不涉及 UI 或视觉；之后未再重扫，不能表述为“最终代码后已复扫”。
- 浏览器几何与单 h1：16 个主路由各在 `innerWidth=1440/1024` 检查，共 32 项，均一个 h1、`scrollWidth` 等于视口、无页面横向溢出（`/tmp/frontend-design-audit-browser-final.json`）。800px 仅覆盖专家详情/完整文件、插件详情与专家页，同样无横溢；定时新建弹窗 Esc 回焦触发器；角色/聊天/专家 AX 树无无名主要交互控件。只读已有数据，不发模型任务、不创建/删除业务记录。
- 焦点：checked/unchecked 行为 22 项与 forced-colors 通过；真实页面测得选中 Checkbox/Switch/Radio `outline solid 2px`、`offset 2px`、ring 无可见宽度；普通标签、卡片标签、独立 invalid 控件与卡片 invalid 组合均实测：3 个控件 border `rgb(180,35,24)`，内部 outline none / ring 0，外层 label 单层 2px ring。
- 技能：最终新增 11 条测试，技能相关 47 项全部通过；保存成功以服务端对象 `setQueryData` 写回，随后 `invalidateQueries({ refetchType: 'none' })` 仅标记失效，并在仍有读取权限时条件 `refetch()`；撤权暂停读取，恢复后挂起 GET 立即重选新版本；删除同步缓存；独立 Opus 复核明确通过。
- 知识：同名文档的共同 44 字前缀附 index，相关 128 项通过，保留「查看详情」前缀。
- 反馈名称：两项已修，名称最终命中 index；2 个文件 134 项通过；独立复核通过。
- 已通过的独立复核：共享视觉/链接、servers readonly、cache/eval、datatable/navigation、feedback 名称、焦点卡片 invalid、skills 缓存写回。
- `git diff --check` exit 0；独立 Ruby 文档检查通过；未运行根 e2e。

## 文档冲突修正

| 冲突项 | 文档旧写法或缺口 | 当前代码与结论 |
| --- | --- | --- |
| 字体栈 | `Inter, "Inter Fallback", system-ui, sans-serif` | 代码为 `"Inter Variable", Inter, "Inter Fallback", system-ui, "PingFang SC", sans-serif`；DESIGN-SYSTEM §4 与 DESIGN.md typography 已对齐 |
| 表头 | 13px / 正文色 | 共享 Table 为 `text-xs` 12px + `muted-foreground`；§8/§9 与 DESIGN.md 已对齐 |
| 行色 | 半透明 muted，和 selected / footer 不一致 | 行 hover/展开与 footer 均为不透明 `hover #F6F6F6`；DESIGN.md 已对齐 |
| 圆角 | 侧栏项/新建会话笼统写 9px，未区分展开、收起与 32px 图标按钮 | 展开 9px、收起 6px、32px 图标按钮 7px；DESIGN-SYSTEM §3/§12 与 DESIGN.md 已对齐 |
| 移动 input | 767px 切到 16/24 | 固定桌面 13/20，移动输入令牌已删除；DESIGN.md 已对齐 |
| menu 28 | 聊天会话菜单写 28px | 头部会话菜单 32px / 7px；28px 仅保留给明确的紧凑控件；DESIGN.md 已对齐 |
| unused shadow | 文档保留 `--shadow-composer` | 定义已删除，composer 无阴影；DESIGN-SYSTEM §3/§13 与 DESIGN.md 已对齐 |
| card line | 描述为所有裸 Card 子节点统一 p16 | 根为 `py-4` 纵向 flex，Header/Content 各自 16px 水平，Footer `p-4` 且根 `pb-0`；DESIGN.md 已对齐 |

以上只修正规范/快照与代码不一致处；历史任务记录中的旧值是当时事实，不重写。

## 待终审与未覆盖

- 未运行根 e2e；`tests/audit-export.e2e.ts`、`tests/regression.e2e.ts` 的修改尚未由 e2e 命令验证。
- 未做运行时性能采样；移动端、深色主题不适用本轮桌面浅色范围。
- OpenUI 仍有 2 个既有 missing（IconButton、MetricIndicatorWithStrikethrough），非本轮新增，未在本轮补齐。
- Biome 仍有 2 条既有非空断言 warning，非本轮新增。
- 修复后 detector 在最后一项非 UI 的 skills 缓存补丁之前执行，之后未重扫。
- 已获授权提交 PR、合并与收尾；当前正在同步 `origin/main` 并发布，合并完成前不声称已合入 `main`。

## 交付状态

本任务修复与验证已完成；用户已明确授权提交 PR、合并与收尾，当前正在同步 `origin/main` 并发布，合并完成前不声称已合入 `main`。上文验收事实保持原记录，不随发布改写。
