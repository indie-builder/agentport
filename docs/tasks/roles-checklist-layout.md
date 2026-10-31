# 角色管理：层级功能 × 角色勾选矩阵

## 当前有效决定

用户在本轮纠正并确认：顶部横向为角色，左边纵向为菜单/功能的真实层级树；例如「专家」父节点下面缩进「查看」「创建」等功能，可以展开收起，不能平铺为「专家 · 查看」。顶部角色表头、左侧功能行头与中间数据区视觉明确区分。数据单元格只放勾选状态，授权范围移出矩阵。前轮左角色导航+右单角色清单已被用户否决。

最新追加（本轮）：用户批准迁移到仓库现有技术栈。角色编辑草稿、校验、`isDirty`/`dirtyFields`、`defaultValues`/`reset` 改由 `useZodForm` + React Hook Form 管理；功能树展开改由已安装的 TanStack Table 9.3.1 row expanding 管理。保留当前矩阵布局、角色设置范围弹层、未保存单元格/父组反馈、全展开/全收起、409 冲突与管理员只读。不新增依赖，不改 shared/api/db；迁移前建立同口径性能基线，迁移后同条件复测。业务差异分类基于库状态计算，不另建第二套通用草稿或表单引擎。

用户已在本轮明确授权提交、推送、创建 PR 并合并；不监控或等待 CI。

## 目标与方案

- 复用共享 Table/Checkbox 与真实权限目录 `buildPermissionTree`；顶部每个角色一列，左侧父子节点递归缩进，展开按钮仅在功能行头。
- 数据单元格只有 checkbox（父级三态保留）；授权范围、名称和设置入口不进数据区。本轮允许未保存单元格中性浅底+角标边界（CSS非文字），结合title/aria-description表达变化，不增加格内标签。
- 角色管理位于角色列头；已有范围设置在矩阵外的角色设置弹层，沿用同一 draft，不新增独立保存、API 或权限目录。
- 授权语义保留：组三态、批量不覆盖已有 scope、搜索父级禁批量/强制展开、清空恢复折叠、管理员 grants 只读、一次保存完整矩阵、409 保留草稿、重新加载确认与离开保护。
- 页面用既有 Page/Header/Toolbar；列头使用 sunken、行头使用 surface 与分隔边界，数据区纯白；角色增多只在表格容器内部横向滚动，左功能列可固定以便对照。
- 搜索 q 仍进 URL；role URL 表示打开的角色设置对象，无值/无效值即关闭，不再默认选首个。新建打开设置、删除关闭；关闭清 role 并保留矩阵草稿。原有矩阵草稿状态保留，不借此做全量 RHF 重构。
- 设置弹层只有「完成」关闭，不单独保存、不复制草稿；关闭不会丢失修改。范围使用完整目录的已授权叶，不受矩阵搜索/折叠影响；撤销最后一个范围沿用原语义撤销该叶授权。保存中禁用设置关闭和冲突操作。
- 测试契约：表格「角色权限矩阵」，角色列头 `scope=col`，功能行头 `scope=row`，Checkbox 名称「成员：查看专家」/「成员：专家」，展开按钮「收起 专家」；设置按钮「设置角色 成员」，弹层标题「角色设置：成员」，输入「角色名称」，范围组「成员：查看专家 授权范围」。
- 本轮反馈契约：工具栏「全部展开」「全部收起」；搜索期间禁用并解释强制展开。以保存baseline逐叶scope集合差异标记未保存，`td data-changed=true`+中性背景/边界、title与Checkbox aria-description给出新增/撤销/范围变化；父组聚合子叶变化，收起仍可见。工具栏显示未保存权限项数与最近一次角色/功能/动作，改回baseline/保存成功清除。
- 性能诊断：独立Opus React Profiler实测556checkbox单叶12次中位52.45ms(37.9–60.9)、收起40checkbox时4.85ms；三态计算0.037ms、草稿比较0.154ms。确定优化本页memo标量单元格+稳定操作回调，不虚拟化/换栈。未变Checkbox跳过渲染；现树与权限算法保留。
- 本轮测试先红：保留11例通过，新增5例因缺少全部展开/收起与未保存标记失败；工具栏计数按真实变化叶权限，父节点只聚合显示不重复计数（3个叶变化不报4个，测试计数期望4/3修正为3/2，格子标记数量仍4/3）。
- 性能验收：相同真实89权限/4默认角色、默认全展开，浏览器内click→aria-checked变化+2RAF，2次预热10次采样median/p95；优化前后同条件，禁止工具往返计时或仅凭memo宣称改快。
- 本轮迁移前先建同口径性能基线（真实89叶/4角色/556 checkbox，点击权限与编辑角色名两类交互），迁移后同条件复测；不以换库本身宣称更快。若基线或复测无法按同口径取得，如实记录限制。
- 仅修改 web 页面、相应测试与布局文档，不改 API/shared/db、依赖或用户登录/权限数据。

## 迁移契约（RHF + TanStack Table）

- 唯一表单值：`{ expectedRevision, roles: [{ roleId, systemKey, name, scopes }] }`；`scopes` 按共享 `PERMISSION_IDS` 顺序固定索引，字段路径 `roles.${r}.scopes.${p}`；权限 id 的 `.` 不进入 RHF 路径。所有权限（含空数组）进入 defaultValues/reset，scope 始终按 `SCOPE_ORDER` 排序，避免集合相同却被判脏。
- `useFieldArray` 接管角色增删，React key 用 `field.id`，业务 ID 存 `roleId`；URL 设置对象用 `roleId`，新角色用 `field.id`。名称读实时值，不读 `fields`。
- 删除 `draft/baseline` 状态、`sameDraft`、草稿 refs 与整份草稿更新器。`useZodForm` 独占值、defaultValues、isDirty、dirtyFields、reset；`shouldUnregister:false`，避免折叠卸载丢字段。
- 叶格 `useController`，父组订阅所属叶路径，列头订阅角色名，范围弹层订阅当前角色 scopes；页面顶层禁止 `watch('roles')`。稳定回调用 `getValues`，写入用 `setValue(..., {shouldDirty:true})`。批量授权保留已有 scope，取消最后 scope 即撤销。
- 未保存分类基于 RHF `formState.defaultValues` 派生 roleId 索引：已有角色按 roleId 找基线，新角色按空授权；保留父组聚合、叶计数、最近动作、改回基线/保存成功清除。不另存第二份基线。计数不得用 `dirtyFields.roles[index]` 过滤业务变化，角色删除后的下标与默认值可能不对应；管理员服务端原授权可单独保留业务只读快照。
- 独立终审整改已实现：基线从`useFormState.defaultValues`按roleId派生索引（无独立默认快照），管理员原grants只作业务只读ref；计数不再用dirtyFields数组下标筛选；refetch throwOnError且已有缓存时不卸载编辑子树，失败不reset。新增两例先红（29passed/2failed）后绿，最新完整3files90passed；单项Opus复核待返回。
- 名称 UI schema 复用共享名称约束（从 `roleMatrixInputSchema.shape.roles.element.shape.name` 取，不修改 shared）；跨字段重复名用 superRefine 给两个字段同报错；`mode:'onChange'` 保持即时反馈。提交转换为完整请求后，再用 `roleMatrixInputSchema` 校验；管理员提交用默认授权，权限依赖错误显示摘要。
- `handleSubmit` 中 `await save.mutateAsync`；成功按服务端回包 reset，失败/409 保留值及 dirty。后台 revision 仅在干净时 reset；脏时保留旧 expectedRevision 并提示冲突；确认重载后才 reset。离开保护共用 RHF dirty 与 pending。
- Table 9.3.1：`tableFeatures({ rowExpandingFeature, expandedRowModel: createExpandedRowModel() })` + `useTable`；既有树投影为 group/leaf 行，`getSubRows` 保持“直属叶→子组”顺序；行 ID 用组完整路径/权限 ID；渲染 `getRowModel().rows`，`row.toggleExpanded()`；受控 `ExpandedState` 初值 `true`，`autoResetExpanded:false`；全展开/收起用 `toggleAllRowsExpanded(true/false)`。搜索时传有效 `true` 且禁用展开操作，不改用户原状态，清空恢复。授权不接入 rowSelection。
- 边界：只改 `roles.tsx`、两个角色测试、任务记录与相关布局文档；不改共享表格/表单封装、shared/api/db，不新增依赖。

## 基线与范围

- 工作树 `/Users/xbjt/Documents/myself/agentport/.claude/worktrees/roles-checklist-layout`，分支 `worktree-roles-checklist-layout`。
- 起点 `2c7f3bf8def108ffaea4ba6e0631c7b2bf1228a7`；继续使用本任务原树、不重置。
- 现有未提交差异均为本任务前轮产物，允许本轮按用户纠正替换。
- 源码：packages/web/src/pages/roles.tsx、routes/-search.ts、routes/_shell/roles.tsx；必要时本页专属组件，不改共享UI语义。
- 测试：packages/web/test/roles-ui-hardening.test.ts、account-rbac.test.ts；保留现有权限、冲突和草稿保护覆盖。
- 文档：PRODUCT.md、docs/{ARCHITECTURE,PROJECT-BRIEF,USER-STORIES,DECISIONS-PENDING}.md、packages/web/DESIGN.md，仅改角色布局描述。

## 已替代项及原因

- 前轮左角色导航+右单角色清单方向不符合用户目标，全部被上述矩阵方案替代。
- 不将父子名称平铺拼接。沿用目录任意深度层级，而非新增一份假菜单数据。

## 步骤

- [x] 明确实现/测试契约，23 个角色矩阵用例先红（旧UI无矩阵），14 个非角色用例通过
- [x] 实现层级矩阵与矩阵外授权范围设置；同步文档
- [x] 定向测试、typecheck/build、焦点/契约/格式验证
- [x] 真实渲染检验表头区别、父子缩进、折叠、单元格仅checkbox与窄桌面宽度
- [x] 独立 Opus 终审：通过，未发现阻断交付的高可信问题；焦点实屏已由主会话复核

## 下一步

无实现待办。RHF + TanStack Table 迁移完成，90个定向用例及类型/构建/规范检查通过；终审三个问题修复后已独立复核通过。同脚本性能两类总渲染成本下降，权限首响应略回退见验证限制。预览服务保持运行，空间129已结束，临时采样文件已清理。未提交未合入。

## 验证

前轮有75个测试通过与浏览器证据，已被替代。本轮证据：

- `pnpm test:web roles-ui-hardening account-rbac shell-route` → 3 files / 79 tests passed；23个角色矩阵用例先红（旧UI缺矩阵），14个非角色用例原样通过。
- `pnpm --filter @agentport/web typecheck`、`pnpm lint:focus`、`pnpm lint:contract` → 通过。
- `rtk bypass pnpm exec biome check` 五个改动 TS/TSX → 通过；`git diff --check` → 通过。
- `pnpm --filter @agentport/web build` → 通过，既有 >500kB chunk warning。
- Impeccable detector → `[]`。
- 真实组件+真实目录89叶/4默认角色隔离夹具，所有API非GET被阻断，未触用户登录/授权。1492宽：139个行头scope=row、5个列头scope=col；556个td全部无文字且各只有一个checkbox；列头rgb(246,246,246)，行头白色。
- 1024×768：document.scrollWidth=1024、表格容器client/scroll均738、单一h1；专家父padding0、agents.read叶padding48；键盘Enter整组收起成功。新增第5角色后表格scrollWidth799，scrollLeft60.5，sticky功能行头x始终248，页面宽仍1024。
- 收起专家后所有专家子组/叶行数量=0；搜索查看专家强制展开，用户父checkbox禁用；清空恢复折叠。
- 矩阵外角色设置可打开与关闭，关闭回焦实测`设置角色 用户`。范围修改/关闭保留/统一保存/管理员/冲突/离开由定向测试覆盖。
- 最终截图 `/tmp/roles-matrix-final.png`（默认目录全部展开）。
- 本轮最终85tests/3files通过：终审发现取消最后scope实际撤销但recent写范围调整，已新增红绿用例并改为空scope显示撤销；其它84例保持通过。typecheck/Biome通过，最终build通过。单项Opus复核通过。
- 本轮新增反馈：`pnpm test:web roles-ui-hardening account-rbac shell-route` → 3files84passed；typecheck、focus/contract、Biome通过；build通过（既有chunk提示）；设计扫描[]。实屏全收起10个顶层行、0叶行，父级仍标变化；搜索全控disabled并title解释；取消勾选格与顶层父组高亮角标，status显示角色/功能/撤销；模拟PUT成功回包后标记2→0，未透传真实库。
- 迁移前基线（memo 手写版，89 叶/4 角色/556 checkbox，2 预热 12 样本，React 根 fiber actualDuration）：点击权限首 commit 中位 15.05ms/P95 17.50ms，`setTimeout(0)` 窗口合计 23.95/34.10ms，事件到首 commit 17.50/19.80ms；角色名输入一字符首 commit 23.00/44.20ms、合计 23.00/44.20ms、事件到首 commit 29.60/50.70ms。原始样本与复测脚本在 `.ego/rhf-migration-baseline/`（结果 JSON 含源码哈希），迁移后同脚本复测。仅开发模式本机 commit 耗时，未测绘制。
- 迁移后复测（同一脚本/space/host，89叶4角色556 checkbox）：点击权限首 commit 17.90/P95 20.30ms、合计 18.05/20.40ms；角色名输入首 commit 14.10/19.80ms、合计 79.40/101.50ms。点击合计较迁移前 23.95ms 下降，但改名合计仍高于 23.00ms；已确认第二次 commit 约65ms，正在按组件定位，不能宣称迁移整体更快。
- 已移除仅用于 UI 草稿的逐键 scope 校验（表单 schema scopes 零成本，提交仍用共享 roleMatrixInputSchema），85 例、typecheck、Biome 保持通过。
- 改名回退诊断：DevTools三次>25ms提交为68.8/71.8/68.4ms，矩阵占96%；556个MatrixCell/Checkbox全重渲染，PermissionMatrix本体未渲染，反馈组件≤0.1ms。根因`trigger('roles')`父路径校验广播命中每格useRoleName的errors订阅，memo无法阻挡内部订阅。正在缩小名称校验与错误订阅边界，保持两侧重复名即时校验。
- 迁移最终同脚本复测（2026-10-31T15:37:38，89叶4角色556checkbox，同viewport1480×840、同React19.3.1开发模式、2预热12样本）：权限点击首commit中位17.85/P95 19.80ms、窗口合计17.85/19.90ms、事件到首commit23.10/25.30ms；改名首commit13.90/20.90ms、合计16.40/23.90ms、事件到首commit20.15/26.80ms。对比迁移前合计23.95/34.10ms、23.00/44.20ms，两类合计成本降低；权限首commit及事件到首commit略回退，不能宣称所有指标提升，未测绘制延迟。
- 迁移最终终审整改后复测（2026-10-31T15:45:06，同脚本89叶4角色556checkbox、viewport1480×840、React19.3.1开发、2预热12样本）：权限首commit中位16.60/P95 18.30ms，合计16.70/18.40ms，事件到首commit21.85/23.40ms；改名首commit13.40/20.20ms，合计15.95/23.80ms，事件到首commit19.60/26.30ms。对比基线合计23.95/34.10、23.00/44.20两类改善，权限首commit及响应略回退仍如实披露。最终90tests/typecheck/build/focus/contract/Biome/diffcheck通过；1024doc1024单h1、89叶556td、全部收起10行。临时空间129已结束，采样文件清理中。
- 修复方式：scope UI按键不再重复逐项校验（提交仍共享schema完整校验）；叶格/父格不订阅errors，只精确订阅名称，跨角色重复名校验留列头/设置，父级trigger不再唤醒556格。
- 迁移最终验证：3files88passed（新增删除角色不串列、reset后范围基线、非法依赖拒绝PUT）；typecheck/focus/contract通过；实屏1024宽doc1024、h1=1、556td，全部收起10行/0叶，搜索1叶且全控禁用。截图/tmp/roles-rhf-migration.png。独立终审待返回。
- 性能复测限制：click→2RAF脚本多次等待超时，即使visibilityState=visible，不以该超时判产品失败；已停止此路径，改用React Profiler同类指标复测。前轮baseline52.45ms来自Profiler，不能与DOM/RAF口径混比。
- 未跑全套web/backend/E2E，未验证真实登录和PUT写库。

预览服务：`https://worktree-roles-checklist-layout.agentport.localhost/roles`，本树 Portless Vite 端口4567；使用已有 localhost:3000 API。浏览器 taskSpace120已交给用户，禁止未经允许接管或清除登录状态。

文档既有偏差：PRODUCT.md个人模块交付状态、PROJECT-BRIEF中RBAC交付状态过时；本轮不扩为历史交付状态清理。上一实现矩阵useState与当前多字段RHF规则偏差已在本轮迁移消除，基线必须来自RHF defaultValues。
