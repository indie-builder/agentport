# 定时任务创建与编辑 UI 重设计

## 目标
参考 Qoder CN 自动化创建界面，统一重设计 PACE 定时任务的创建和编辑体验；平台只有云端执行，不出现云端/本地选择。保留当前字段、调度语义、权限、错误处理与已有功能。

## 方案
沿用项目 Qoder 浅色设计系统及 shadcn / Base UI 组件。Opus 先核对现有行为和真实参考，Sonnet 按固定契约实现；主会话协调、审查、运行验证。代码修改后交独立 Opus 评审。

## 基线与范围
- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/account-rbac`。
- 分支：`worktree-account-rbac`；起始 HEAD：`fed3e5af303f748649448dbbeaa0baf8a6ea0b2c`。
- 沿用当前已存在工作树，不另建树：此树包含账号与权限功能，UI 需保留其权限契约。
- 开工时已有大量 account-rbac 未提交/未跟踪文件，均视为既有工作，不还原、不提交、不覆盖。直接相关的既有修改包括 `packages/web/src/pages/ops.tsx`、`packages/web/test/schedule-feedback.test.ts`。
- 本次仅更改定时任务创建/编辑 UI、必要的行为测试与任务记录；不修改 API、DB、worker、全局主题和其它页面。

## 发布提取（2026-10-31）
- 目标发布树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/schedule-ui-pr`；分支 `fix/schedule-ui-qoder`；基线 `origin/main` `fed3e5af303f748649448dbbeaa0baf8a6ea0b2c`，开工时工作区干净。
- 仅从原工作树复制六个文件：`packages/web/src/pages/ops.tsx`、`packages/web/test/schedule-feedback.test.ts`、`docs/DESIGN-SYSTEM.md`、`packages/web/DESIGN.md`、`docs/research/qoder-cn-ui/report.md`、`docs/tasks/schedule-ui-redesign.md`；未复制 `api.ts`、`queries.ts`、shared/schema/锁文件等，零新依赖。
- 三份设计文档差异均为 schedule 相关，按原样复制。
- 代码剥离 account-rbac：ops 去掉 `useQuery`/`can`/`meQuery` 导入与 `me`/`canManage` 取值，`rowBusy` 只保留 toggle/remove，页头新建按钮恢复 main 的始终显示；测试去掉 `allAccessMe` 导入与 `['me']` 注入，不带 me-fixture 或 account-rbac 用例。剥离后 `SchedulesPage` 与 `AttentionPanel` 与 main 逐字一致，其余 ScheduleDialog/转换/schema/RHF/新 UI 保留。
- 验证与独立review通过，用户授权本次commit/push/PR/merge，后续以GitHub PR合并状态为准。

## 当前有效决定
- 用户要求参考 Qoder 重新设计定时任务创建和编辑 UI。
- 只有云端概念，不做本地/云端选择。
- 用户在第二版交付后明确授权「提交PR并合并」。仅发布本任务UI、测试与设计文档；其它account-rbac未提交改动保留。新建纯UI发布树后按main基线验证并独立评审，commit/push/PR/merge不等待CI，不开启监控。
- 不替换已确认的全局视觉系统；不引入 Qoder 独有但 PACE 尚无对应能力的假控件。

## 已替代项及原因
- 用户在查看最终截图后明确否定第一版 UI，要求使用设计相关技能重新设计；第一版的960px普通带框字段表单、固定440px左栏与启用贴底布局不再作为视觉验收目标。第一版通过的行为与调度保护仍需保留。
- 已加载 `frontend-design` 与 `impeccable`；第二版由Opus重新确定编辑面与计划区构图，Sonnet执行，主线程验证。仅云端、不做位置选择继续有效。

## 步骤
- [x] 阅读研发流程与踩坑，记录工作树和已有差异。
- [x] 核对现有功能与 Qoder 云端真实控件，Opus 已固定布局及调度编辑契约。
- [x] Sonnet 实现共用创建/编辑 UI 与必要行为测试。
- [x] 独立 Opus 代码及视觉评审，发现项已修复并复核通过。
- [x] 按范围测试、类型检查、构建与浏览器几何/交互验证；修后已重跑完整所选范围。

## 改动文件
- `docs/research/qoder-cn-ui/report.md`：补充真实云端模式，区分原本地默认状态，记录实测边界；截图仍保留仓库外。
- 已实现：`packages/web/src/pages/ops.tsx` 定时任务部分、`packages/web/test/schedule-feedback.test.ts`；未改 AttentionPanel。
- 文档：必要时同步 `docs/DESIGN-SYSTEM.md` 对应定时任务一行、`packages/web/DESIGN.md` 实现快照，本记录与局部 surface brief。

## 当前实施契约（第二版，替代第一版视觉）
- `frontend-design` + `impeccable`，Opus重新设计开放任务编辑面+紧凑计划区。最大1024px DialogShell20px内容边；容器>=800时左余宽、gap24、右总320（含1px分隔24pl），右仅自然高度。窄桌面顺序堆叠。
- 左：名称是首行，无常驻独立框（局部透明边框，base14/22 medium，真实focus/invalid保留），正文16px后使用可见任务内容标签和开放Textarea（最小160px约8行，去256/440强撑），专家在正文后12px轻工具行，选择器按内容宽最大240，不置底/不另分区。
- 右：执行计划标题，频率/UTC时间同行，周几原位展开或自定义cron；启用在计划后20px，不置底、不长空竖线。
- Footer：新建创建任务/创建中…，编辑保存更改/保存中…；短视口固定可达，保留既有共享焦点/错误/禁用。无云端/本地或时区选择，不加不存在能力。
- 原第一版已通过33条调度行为及保护完整延续：每天/每周/custom、UTC、复杂cron原文、版本和草稿保护，不改后端。

## 第一版实施契约（已被用户否定，仅保留历史）
- 最大 960px 双栏；左名称、任务内容（最小256px）与左下专家，右300px计划条件；容器小于800px时顺序堆叠。保留共享控件与 DialogShell，不改主题。
- 频率每天/每周/自定义 cron；默认每天09:00 UTC；每周必须至少一天，周日映射0。简单规范表达式精确回填，复杂表达式原文保留自定义。RHF统一草稿，提交投影原API字段，所有原保护不变。
- 子代理实现边界：`ops.tsx`定时任务部分、`schedule-feedback.test.ts`；文档代理只改权威规范对应行与实现快照；并行不交叉写。
- 局部设计记录（按现有 .gitignore 仅本地）：`packages/web/.impeccable/surfaces/packages-web-src-pages-ops-tsx.md`；可追溯实施契约同时保留在本任务记录和权威设计规范，不调整忽略规则。

## 下一步
发布树剥离后的重验与独立复核已通过；验证与独立review通过，用户授权本次commit/push/PR/merge，后续以GitHub PR合并状态为准。原 account-rbac 树与未提交内容保留、不改动。

## 已确认的行为与环境
- 当前定时任务基线测试：`pnpm test:web packages/web/test/schedule-feedback.test.ts`，1 文件 / 19 用例通过。
- 五段 cron 固定 UTC；专家创建后不可更换。编辑 PATCH 保留 `expectedUpdatedAt`；409 重载、404 显式另存为新建、dirty/pending/blocker 保护保持原语义。
- Qoder 原始截图已实际查看：`/private/tmp/qoder-ui-research.Z2KiTb/screenshots/10-automation-create.png`。仅作为任务编辑/计划分区依据，未把截图当作计划切换的交互证据。
- Qoder 计划频率菜单截图已实际查看：`/private/tmp/pace-qoder-schedule-20261031/03-cloud-frequency-menu-window.png`；真实菜单含不重复、间隔、每天、每周、每月，星期选项在每周时展开。PACE 只能映射现有 cron 支持的重复计划，不加入后端不存在的一次性/到期语义。
- 本树共享库缺 RBAC 新表且迁移账本漂移，原登录返回 500；未迁移或重置共享库、未改用户账号。已用项目既有隔离数据库工具建立独立预览。
- 已切换临时隔离预览：代码根目录及分支不变；配置为本树 `.tmp/schedule-ui/app.env`，随机库 `schedule_preview_4a1d92667d324036`、独享 Redis `backend_test_redis_978057fd2006408c`，未启 worker。使用专属测试管理员，未改共享账号。
- 真实浏览器从登录表单提交成功并进入 `/schedules`。1440×900 改前弹窗760×424.75，prompt420×192；关闭后焦点回到新建入口。截图 `.tmp/schedule-ui/before-1440.png`（忽略目录，不提交）。
- 验收完临时API进程PID1856可由SIGTERM自行清理仅本次数据库与Redis；句柄在 `.tmp/schedule-ui/handle.json`。
- 发现已有注释与实际实现冲突：`packages/shared/src/ops.ts` 写完整 cron 解析在 core/worker，实际 API 已做完整可调度校验；本次不改后端，只在交付中说明。

## 验证
- 已阅读 `docs/PITFALLS.md` 中参考 UI 实操、真实几何、文案全仓测试引用、保护混合差异条目。
- 开工时无运行中的 PACE API/前端路由；PostgreSQL 和 Redis 基础设施存在。已按本树脚本启动预览，后续切换到临时隔离库。
- 改动前基线：`pnpm --filter @agentport/web typecheck`、`pnpm lint:focus`、`pnpm lint:contract` 全部退出 0。
- 改前 Biome 存在1个import排序错误（`can`导入位置，来自既有RBAC差异）；无需改行为，随目标文件实现整理，不能称为本次功能回归。
- 工程测试基线已通过 19 用例；UI 变更后重新执行相应命令，基线不冒充改后验证。
- 共享弹窗、状态反馈与RBAC关联回归：`pnpm test:web packages/web/test/dialog-validation.test.ts packages/web/test/status-feedback.test.ts packages/web/test/account-rbac.test.ts` → 3文件31用例通过（2026-10-31）。
- Qoder实机主要计划控件已补核并写入参考报告，仍未覆盖其已有任务编辑和保存行为；PACE编辑按自身已验证契约实现。

### 改后验证（2026-10-31）
- 执行代理先红：30用例16失败/14通过，新增频率与时间控件缺失为预期失败；实现后30通过。
- 主会话重验：`pnpm test:web packages/web/test/schedule-feedback.test.ts packages/web/test/dialog-validation.test.ts packages/web/test/status-feedback.test.ts packages/web/test/account-rbac.test.ts` → 4文件61用例通过。
- `pnpm --filter @agentport/web typecheck`、`pnpm --filter @agentport/web build` → 退出0；`pnpm lint:focus`、`pnpm lint:contract`通过。
- Biome 首次凝缩输出报1错误，按RTK说明 bypass重查目标两文件 → `Checked 2 files … No fixes applied`退出0。
- Impeccable detect 仅对改动目标执行一次 → `[]`。
- 浏览器1440×900：弹窗960宽；表单920宽；左596，右300（含1px分隔+24px左内距），栏间24；prompt596×256。专家在左下，时间控件32高，页面无横向溢出。
- 1024×768：弹窗960宽、左右32；周几32×32，间8，方向键由周一移至周二。
- 800×720：弹窗768×576；两栏堆叠，内容可视519/滚高668，滚至149后专家与频率/时间完整可见，保存始终可见；页面无横向溢出。
- 真实编辑：错误cron `0 9 * *`就近显示五段提示、focus为`schedule-cron`；随后保存`*/15 9-17 * * 1-5`成功，重开仍为自定义且原文相同。
- 真实创建：每周项目总结、18:30 UTC选周日/一/三/五，保存后GET返回`30 18 * * 0,1,3,5`，仅业务字段落库；编辑重开正确识别每周。所有测试任务保持禁用，无worker执行。
- 截图存于`.impeccable/review/`本地忽略目录：desktop、weekly-filled-1440、edit-1440、custom-edit-1440、weekly-1024、narrow-800及narrow-800-bottom。视觉评审首轮仅证据检查发现custom图1480×840不符标称；主线程已重拍并Read确认1440×900，再送完整评审。

### Review修复轮次
- 固定范围为本次表单转换与UI，不扩扫既有account-rbac。
- 独立Opus通过内存探针确认两处P2：daily→custom→daily隐藏cron差异导致无业务变更却dirty；规范daily custom→weekly首次未补默认1-5。
- 最小频率修法：简单模式清空不使用的隐藏cron，按RHF原生dirty计算；按decoded.frequency及首次标记补每周默认，不复活用户主动空选。新增完整往返直接关闭、规范daily经custom首次weekly、主动空选经custom不复活三条行为用例。
- 频率修复33条完整测试通过；独立Opus复核明确通过，另重跑新增三例3通过（30未选，存在React act警告无失败）。
- 视觉完整评审结论`fix`：整体双栏与控件通过；800×720未滚动时sticky footer下方16px露出滚动字段碎片。Opus确定局部`bottom-0`改`-bottom-4`，Sonnet单处实施。主线程重测顶部/中段footer bottom648等于视口bottom648；滚底差0.1px取整，字段完整，无碎片；三张有效截图已Read。独立视觉verdict pass将唯一修复项评为resolved，disposition `ship`（仅覆盖此修复，结合前轮完整评审其余通过）。

### 第二版实现与验证（2026-10-31）
- 使用 `frontend-design` 与 `impeccable` 重做构图，由Opus契约、Sonnet实现；名称/正文开放编辑面，专家紧随正文，计划自然高度，不保留旧440/256强撑。
- 仅变更ScheduleDialog呈现和相关测试动作名称，转换、RHF、请求、版本与草稿保护未变。动作分创建任务/创建中…与保存更改/保存中…。
- 执行代理先红18失败/15通过，实施后33通过；主线程重新跑33通过；独立Opus代码review也独立重跑33通过且给出通过。
- 实页发现name的共享md:text-sm覆盖层级，局部补md:text-base后computed14px；专家空态补选择专家，消除仅箭头的空下拉。
- 主线程最终四文件64用例通过（原 account-rbac 树历史数字），web typecheck/build退出0，Biome两文件、focus/contract通过，detector只跑一次[]。
- 稳定1440×900新建弹窗1024×429.875，正文640×160；1024桌面弹窗992宽；800堆叠滚动后全部计划字段与页脚可达，稳定无横向溢出。50行正文自然增到1018px，页脚bottom648仍可达。
- 真实浏览器创建禁用的每周项目进展，再回开正确显示每周、编辑专家禁用、保存更改。不启动worker。
- 第二版临时资源：API PID95933、随机库schedule_preview_b8529e5adb284e9a、Redis backend_test_redis_5186cb07bcaa4527，配置仍本树.tmp/schedule-ui/app.env，URL https://worktree-account-rbac.agentport.localhost；不触碰共享库。
- 新截图v2-desktop/v2-weekly/v2-edit/v2-custom/v2-1024/v2-800/v2-800-bottom/v2-long-bottom/v2-errors均保留本地`.impeccable/review/`；1440/1024/800像素尺寸已sips核对。独立视觉review disposition ship，无material fixes，用户尚未认可外观。
- 已用系统查看器打开v2-desktop及v2-weekly供用户查看，均为1440×900。结束浏览器空间后停止临时API与Web；精确查询第二版随机库与Redis均不存在，Portless无活动路由，未触碰共享库或用户账号。未提交、未合并，源码及截图保留。

### 发布树验证（剥离后，2026-10-31）
- `pnpm test:web packages/web/test/schedule-feedback.test.ts packages/web/test/dialog-validation.test.ts packages/web/test/status-feedback.test.ts` → 3 文件 41 用例通过（schedule反馈33、弹窗校验2、状态反馈6）。
- `pnpm --filter @agentport/web typecheck`、`pnpm --filter @agentport/web build` → 退出 0。
- Biome 目标两文件 → `Checked 2 files … No fixes applied`；`pnpm lint:focus`、`pnpm lint:contract` 通过；`git diff --check` 无输出。
- 工作区变更仅六个文件，无权限相关依赖；未启动后端服务、未复制 `.env`。
- 上述 64 用例/四文件数字属于原 account-rbac 实施环境历史证据，不是本发布树结果；本发布树以 41 用例为准。

### 第一版最终验证及收尾（历史）
- 修后主会话完整复验同四文件：4文件64用例通过（其中schedule反馈33）；web typecheck与build退出0。Biome原始检查两文件通过，focus/contract通过，`git diff --check`无输出。
- 最终桌面截图`.impeccable/review/desktop-final.png`已Read确认有效1440×900；无新增shipping raster。
- documenter已核对既有系统与本表单并更新DESIGN.md Schedules快照；没有改token/主题/sidecar。已存在sidecar陈旧另行刷新才处理，不扩大本次任务。
- 完成浏览器task space；SIGTERM停止本次临时API后，按精确名称检查随机库` schedule_preview_4a1d92667d324036`与Redis容器均不存在；停止本次Web后Portless无活动路由。未删本工作树或任何未提交内容。
- 未运行后端全套或真实worker计划触发（本次为前端创建/编辑设计）；实际创建/编辑保存通过真实API完成，测试任务均禁用。
- 发现的冲突完整记录：旧设计规范把专家放右栏已同步；Qoder旧参考是本地默认，已补云端差异；shared cron注释与API完整校验位置不符仍为已有源码注释问题；设计sidecar预存落后于DESIGN.md未刷新。



