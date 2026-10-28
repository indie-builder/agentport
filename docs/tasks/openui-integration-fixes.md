# OpenUI 官方行为复核与修复

## 目标

再次核对官方文档及已安装源码，修复已证实的本地组件适配问题，保留官方 Renderer、现有传输、设计体系和 schema。

## 方案与证据

- 官方 OpenUI interactivity：状态按原样持久化和恢复，优先使用官方 hooks。https://www.openui.com/docs/openui-lang/interactivity
- Base UI composition：render 自定义组件必须传递所有属性及 ref。https://base-ui.com/react/handbook/composition
- 已安装 react-ui 0.18.1 EditableTable 使用 tableName/tableName 命名空间；CheckBoxGroup/SwitchGroup 更新前聚合 stored/defaultChecked。
- 日期 YYYY-MM-DD 是项目纯日期约定，不是官方统一格式；按本地年月日转换，避免 UTC 偏移。
- 表格 clean 跟随最新 stored/data；dirty 时整表草稿保持，Reset 采用最新来源，Save 建立新 baseline。不增加冲突合并协议。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/openui-integration-audit`
- 分支：`docs/openui-integration-audit`
- 本轮基线：`6db7a98d21a9cfd788f24acd1c43b9c495ff103e`；已从 origin/main 快进。
- 初始仅未跟踪 `docs/tasks/openui-integration-audit.md`，属前轮报告；不覆盖。
- 主 checkout `.vitest/json/output.json` 为原有差异，不触碰。
- A：forms.tsx、新增 openui-form-fixes.test.ts。
- B：data.tsx、新增 openui-editable-table.test.ts。
- C：openui-message.tsx、openui-message.test.ts、library.tsx 的无用兼容导出。
- 临时浏览器夹具仅在 .tmp/，不增加产品调试入口。

## 当前有效决定

前轮的“未授权 commit/push/merge、以未提交差异交付”是历史状态，不代表当前授权。用户已按建议授权：补齐 7 项交互证据（ContextCardBlock、FollowUpBlock、OverviewCardBlock、Select、SnippetCardBlock、TextArea、VisualCardBlock），发现 bug 修复，经独立 Opus 评审与本地验证后 commit/push/创建 PR 合并、清理已合并干净树并更新 main，不等待 CI。主会话不写源码，Opus 定契约和独立评审，Sonnet 按互斥域并行执行。使用 ub-mode；先诚实行为失败，再最小修复。定时任务保持删除，不新增依赖、Gateway 或外部服务。

下方修复与验证记录均为前轮结果，保留备查，不代表本轮已通过。

## 持续发现机制（本轮新增）

问题不是“检查得不够勤”，而是之前的检查不可证伪：契约全绿、渲染不空白，但没人验证点击、清空、恢复。所以不加高频定时任务（`/loop` 默认仅在当前会话内可用，recurring 任务到期上限为 7 天；重复跑同一条命令本身也不会发现新问题），而是加两个能自己产出新发现的检查：

- `pnpm openui:audit`：把 84 个契约组件按证据分级 —— behavior / render（仅渲染断言）/ nested（含可交互但尚未登记行为证据）/ missing，缺口是数字而不是注释；只有契约与登记不一致才非零退出。
- `openui-renderer-parity.test.ts`：同一 OpenUI Lang 程序、同一份 `initialState`（Range 展示用例按两端原生快照形状各给一份）分别用官方 `react-ui` 与本地组件渲染，比较归一后的文本、勾选/选中/数值状态和输入值。它以官方实现作为独立参照，能发现“已选场景内”的差异；程序与比较面仍由人挑选，不会自动覆盖未写到的交互。命令：
  `pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/openui-renderer-parity.test.ts`

触发时机：升级 `@openuidev/*`、改动 OpenUI 组件、或新增生成式 UI 能力时，跑 `openui:check` + `openui:audit` + 相关专项；缺口按同一比较范围对比，不应上升；新增组件或能力可以带来明确登记的新缺口，须在记录中写明，不算回归。人工浏览器证据不等同于语义覆盖率，behavior 计数只认登记在案的行为测试。新发现的 bug 必须先落一条会失败的行为用例，再修。

前轮历史基线（2026-10-28，仅备查，不是当前值）：`openui:audit` 输出 behavior 7 / render 39 / nested 36（其中嵌套且有交互、尚无行为证据 7）/ missing 2；差分测试 11 条覆盖文本、勾选、单选、开关、日期单日/区间、滑块、页签、表格单元格。本轮当前数见 `docs/tasks/openui-interaction-completion.md`。

差分测试当场暴露一处此前未知的分歧并已固化：官方 `DatePicker` 的 range 快照是 `Date` 对象，本项目持久化 ISO 字符串；把本项目快照喂给官方组件会抛 `from.toDateString is not a function`。这是内部不透明快照、不对外兼容，本地正常；用例同时断言两端行为，官方若改接受字符串会翻红提醒重评。

## 步骤

- [x] 官方与已安装源码重新核对，Opus 固定契约。
- [x] 快进最新基线，记录原有差异。
- [x] A：日历触发器透传 props/ref、本地年月日转换、复选/开关全量默认项与显式 false 聚合；首轮 mustfix 4 项已补。
- [x] B：表格 source 跟随 stream/hydrate、tableName 命名空间、dirty 草稿按 id/key、Reset 取最新来源、Save 存 raw rows、五类列输入；首轮 mustfix 4 项已补。
- [x] C：无效→有效按失败 program 恢复，不重挂正常表单，删除无用 alias。
- [x] 独立 Opus review 与四项补修复核通过，复核者实际执行 19/19 边界测试。
- [x] 范围测试、契约自检、类型/构建、浏览器操作。
- [x] 文档同步；以未提交差异交付，未 commit/push/merge。

## 下一步

当前状态与逐项证据见 `docs/tasks/openui-interaction-completion.md`：本地提交 `c5a3c13` 已完成，基于缓存 `origin/main` = `d6aacd3` 的 merge 集成验证完成，独立 Opus 复核通过；只剩 merge commit / push / PR 受本机 TLS 证书链阻断，尚未合入远端。不等待 CI，不重建 cron。

### 网络状态（2026-10-28）

- `git fetch` 失败：SSL issuer 证书校验未通过。
- `gh auth status` 无法确认有效 token。
- 远端 `origin/main` 只能用本地缓存 `d6aacd3`，不能声称已取到最新远端。
- 不为此扩大防护或新增重试/绕过逻辑，如实记录。

## 验证

### 官方交互复核

- 真实浏览器操作 shadcn Base UI Date Picker：触发器打开日历，选择 2026-10-28 后显示 October 28th, 2026，Escape 关闭。
- Base UI composition 页面明确要求自定义组件透传全部 props 和 ref。
- OpenUI Renderer 页面明确 initialState 是加载恢复、onStateUpdate 返回原始状态；Query/Mutation 机制不改。
- 桌面视觉沿用 DESIGN-SYSTEM §9/§10，不添加解释结构的辅助文案。

### 当前执行证据

- 修复前反例已确认：stream 空表补行后仍 0 行；复选默认 true 的 A 与点击 B 后真实载荷只有 `b:true`；日期 UTC 往返偏移；触发器不透传 props 时日历打不开。
- 执行说明：首轮 A/B 子代理产出超长且无正式产出，已停止并缩小任务重派，不计为完成；后续按互斥域并行执行。
- 实现已落地并补修首轮 mustfix 4 项：日期触发器透传 props/ref、本地年月日与 defaultMonth/清空空串；表格 source 随 stream/hydrate、tableName 命名空间、dirty 草稿按 id/key、Reset 取最新 source、Save 存 raw rows、表身份变更丢弃旧草稿；五类列输入到位；message 按 failedProgram 恢复。
- 子代理报告：message 13 项通过并有 Opus 通过；A/B 补修后上海、洛杉矶边界各 19/19，确认下一状态日志已完成；form/table 新增用例 7/12。
- 主会话最终结果：完整 OpenUI web 17 文件 201/201（含新增差分测试 11 条），web typecheck 与 build 退出 0，8 文件 Biome 0，`openui:check` 11 项通过（产品 schema 未变）；Renderer chunk 255.24 kB gzip，保留既有大 chunk 告警，不宣称性能改善。
- 浏览器真实夹具（Asia/Shanghai，`http://127.0.0.1:53421/`，截图 `/tmp/openui-fixes-preview.png`）：日期单日/区间 2026-10-28 到 30 显示与保存 action 一致；checkbox 默认 A+B 载荷 a/b 均 true、switch sa/sb 均 true；stream 0→2 行；表格改值 Save→卸载→重挂保留 `rows.rows.value` 含 id 与 number；Select 选「已完成」存 done；保存 11-01 后重开定位 11 月选中，再点清空存 `''`；message 无效→有效恢复。键盘/Escape 已真实关闭弹层，但未做自动化焦点断言，不声称有焦点测试。
- 夹具只在 `.tmp/`，不提交，无模型/DB/登录请求；本轮不做付费模型或全产品 E2E。

### 最终独立复核与收尾

- 独立 Opus 最终复核通过，四项 must-fix 已修复，复核者实际执行 19/19 测试。
- `openui:check` 只证明契约与生成物一致，不证明全部交互；独立评审也需配合专项测试与浏览器夹具看，不当作全交互验收。
- TaskSpace110 已 finish 且未保留页面；仅本任务预览 server 已停止。CronList 无定时任务。Ego 可选更新未执行。
- 本树 `.vitest/json/output.json` 由本轮的测试运行污染，已 `git restore` 恢复；主 checkout 同名差异未触碰。
- 产品改动只在本 worktree，未提交/推送/合并；`main` 未合入。

### 本轮验收清单

- [x] DatePicker 点击/Escape 真实操作打开关闭；single/range 在 Asia/Shanghai 与 America/Los_Angeles 边界用例各 19/19 通过。键盘关闭已实测，焦点自动化断言未做。
- [x] checkbox/switch 默认值与显式 false 保留，提交载荷与显示值一致（夹具 a/b、sa/sb 均 true）。
- [x] 表格流式补行、hydration、保存→重挂恢复、namespace 隔离由 table 专项 12 项覆盖。
- [x] 表格 dirty 不被来源更新覆盖、Reset/Save baseline、行/列身份及五类列输入由专项覆盖。
- [x] 无效→有效 canonical 恢复、迟到错误不污染、有效更新保留输入：message 13 项通过，独立 Opus 评审通过，浏览器恢复验证通过。
- [x] 新增与现有 OpenUI 专项回归（17 文件 201 项，含差分测试）、`openui:check` 11 项、`openui:audit`、web typecheck/build、8 文件 Biome。
- [x] 真实浏览器合成夹具验收，无数据库或付费模型依赖（截图 `/tmp/openui-fixes-preview.png`）。
- [x] 独立 Opus 最终复核通过，整体修复按本记录范围验收。

修复前基线：openui-form-behavior、openui-message、openui-form-ui 3 文件 22 项通过，只作为基线，不证明新问题已修复。crapper/dryer/mutator 工具不可用，采用定向行为测试、差异核查和独立评审，不新增工具依赖。
