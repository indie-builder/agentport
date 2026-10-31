# 知识库用户动线与布局调整

## 目标
从用户故事、第一性原理与 UX 审查知识库完整业务动线，并落实必要的页面重排；保留现有功能、权限、错误处理、草稿保护与视觉规范。

## 方案
使用 Impeccable 的 layout / Operate 方法。两个独立 Opus 审查分别核对业务动线与实际页面/机械证据，汇总后确定实现契约，再交 Sonnet 执行。主会话仅编排、文档记录、审查与验证。

## 基线与范围
- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-ux-review`
- 分支：`worktree-knowledge-ux-review`
- HEAD 与获取后的 `origin/main`：`522182f65a82f64eff34006b76650e5484ba55c0`
- 初始 `git status --short` 为空，无既有未提交差异。
- 候选范围：知识库列表、详情、设置组件、对应路由与行为测试；文档与已实现行为冲突时同步权威文档。

## 当前有效决定
- 用户要求从完整业务功能和实际用户动线审查并重新调整知识库页面，使用 Impeccable 中的布局技能。
- 产品定位、桌面端范围、现有 Qoder 配色、共享控件与布局令牌保持为约束。
- 不新增运行底座、数据库结构、独立服务或依赖，不引入尚无后端支持的功能入口。
- 2026-10-31 用户明确授权本轮提交全部知识库 UX 改动、推送分支并创建 PR；不合并，不触发或等待 CI，不做 babysit 监控。

## 已替代项及原因
无。

## 步骤
- [x] 独立审查用户故事、能力与入口闭环。
- [x] 确认真正运行入口并记录页面证据；真实业务页受登录阻塞，另用真实组件固定数据夹具验布局。
- [x] 固定最小完整布局契约与文件边界。
- [x] Sonnet 子代理执行，按可独立文件边界并行。
- [x] Opus 独立 review；jobs、安全selection/创建/设置、详情修复均明确通过，相关范围验证与实屏几何完成。

## 改动文件
- 文档：`docs/DECISIONS-PENDING.md`、`docs/DESIGN-SYSTEM.md`、`docs/PROJECT-BRIEF.md`、`docs/REMAINING-TODOS.md`、`docs/USER-STORIES.md`、`docs/tasks/knowledge-ux-review.md`、`packages/web/DESIGN.md`。
- 后端与共享：`packages/api/src/features/knowledge/routes.ts`、`packages/db/src/repo/knowledge.ts`、`packages/shared/src/knowledge.ts`、`packages/api/test/knowledge-routes.test.ts`、`packages/api/test/knowledge-jobs.test.ts`、`packages/api/test/knowledge-model-selections.test.ts`。
- 前端：`packages/web/src/components/knowledge-settings.tsx`、`packages/web/src/lib/api.ts`、`packages/web/src/lib/queries.ts`、`packages/web/src/pages/knowledge-detail.tsx`、`packages/web/src/pages/knowledge.tsx`、`packages/web/src/routes/-search.ts`，以及 knowledge-management/settings/create-flow/jobs-query/model-selections 五个测试文件。
- E2E：`tests/knowledge.e2e.ts`、`tests/knowledge-multimodal.e2e.ts`。

## 审查结论与实现边界
- 独立 Opus A 已确认：创建配置负担重；详情缺少设置和专家关系入口；叶权限与写按钮呈现不一致；首次文档失败恢复与任务对象脱节；任务游标被丢弃；空白 Wiki 无法直接手写；设置缺少已有的 embedding 切换且重建提示矛盾。
- Opus B 独立机械扫描 0 项；原有 Portless 443 代理未注册应用，API 未启动，无原业务页实屏证据。不是布局无问题的证明。
- 范围固定：保留五任务，按“文档 / 来源 / 检索测试 / Wiki / 处理记录”重排；新建渐进披露；详情就近设置及只读专家关系；按现有叶权限呈现；补任务对象、游标与文档到处理记录导航；空白 Wiki 直接写作；补已有 embedding 换绑 UI。
- 不增加检索参数面板、不改专家运行底座、不建概览看板、不新增索引管道或数据库结构。已发布 Wiki 未进入专家检索是已确认范围外缺口，记录而不伪装已实现。
- 实际应用预览已从本工作树启动，API PID 18974、前端 Vite 4504，URL `https://worktree-knowledge-ux-review.agentport.localhost/knowledge`。配置为工作树 `.env`（与主 checkout 副本逐字节一致）。真实页面停登录，未改用户账户或 Cookie；另由 Sonnet 建临时真实组件 + 固定数据的视觉夹具，只验证布局，不代替后端实测。
- Opus 共享契约：URL 仅新增 `document`（处理记录定位），HTTP 参数为 `documentId`；任务摘要新增必有可空 `documentId/sourceId/documentTitle/sourceName`；jobs 使用 infinite query 而 `data` 保持扁平数组。无数据库 schema 改动。
- 专家关系的真实限制：`/api/agents` 摘要不返回 `serverIds`，不可推断“无人使用”；弹层打开后查可见专家的 `/access`，仅对有配置读取权的专家查绑定，其余关系明确无法确认，不扩大后端权限。
- 分工：创建表单与独立测试、设置与现有 settings 测试、详情与 knowledge-management/E2E 测试、任务关联/分页契约与独立测试各自单一写入者。共享契约已由 Opus 聚焦确认。

## 用户查看与登录恢复
- 用户要求启动真实服务、打开并代登录；工作树 API / Portless 前端已启动，浏览器实际提交初始化凭据。
- 登录返回500，`platform_bootstrap`缺表，尚未进入密码验证；不能称密码错误。只读核对共享库有业务数据且迁移账本漂移（49账本条目/46当前journal，缺0042、0043目标表已存在、0045非空列不回填），未执行共享库迁移或清库，未改账户密码。
- 按既有隔离规则建立 `knowledge_preview_0c83467546b149cb`，53张表/15张knowledge表/46迁移全完成；Redis独立临时容器，仅本预览进程覆盖DB/Redis/knowledge/workspaces，默认.env未修改。脚本/metadata在`.tmp/knowledge-login-preview/`，launch/cleanup由该脚本负责。
- 浏览器已通过真实登录表单使用配置中的初始化凭据在新库首次创建并登录admin，成功进入`https://worktree-knowledge-ux-review.agentport.localhost/knowledge`，标题“知识库 · PACE”、账户admin、共0库。页面已交回用户，原库账户/数据均未修改；新预览为空，已明确说明。
- 主会话重复launch因准备代理已启动同一脚本而被3000占用校验拒绝；已核对PID56876父脚本→56878 tsx→56886 API，未杀不明进程、不重复建库。

## 文档与界面冲突清单
- 模型删除提示要求“去库设置切换”但原设置无对应入口：本轮补齐。
- 重建常态说明称保留人工分块，与执行/确认不符；另原“失败保留”未说明逐文档部分成功：本轮统一真实语义。
- embedding 原提示只影响后续解析，与保存立即影响检索不符：本轮修正。
- PROJECT-BRIEF 的文档/来源类型漏 GitHub：本轮按实际schema修正。
- USER-STORIES 未覆盖知识维护完整动线：本轮补 EPIC9 / US-9.1–9.4。
- PRODUCT.md / USER-STORIES 的RBAC段仍写“未合入main”，与基线已有 PR#129 合并事实不符：范围外状态文档保留，最终报告说明，未借本轮布局扩成全站文档清扫。

## 下一步
无本轮未完成实施项。成果已验证并经独立评审通过，按 2026-10-31 授权提交并推送分支、创建 PR 待 review；不合并、不触发或等待 CI。真实E2E与 Wiki 专家消费缺口见验证限制及项目待办。

## 验证
- 基线：`git rev-parse HEAD origin/main` 两者一致。
- 初始工作区：`git status --short` 为空。
- Impeccable context 已读取现有 PRODUCT.md / packages/web/DESIGN.md，无目标 surface brief；不为此新增产品定义。
- 改动前行为基线：`pnpm test:web packages/web/test/knowledge-management.test.ts packages/web/test/knowledge-settings.test.ts packages/web/test/knowledge-source-runs.test.ts packages/web/test/knowledge-document-polling.test.ts packages/web/test/knowledge-citations.test.ts packages/web/test/expert-knowledge-binding.test.ts packages/web/test/knowledge-errors.test.ts` → 7 files / 152 tests 全部通过；jsdom 的 navigation/scrollTo 提示不算浏览器行为证据。
- `pnpm lint:focus` 通过。知识库三个主体 TSX 的 `biome check` 通过；含 shell 转义 `$baseId` 路由的首次压缩结果不可用，未将其当成源码失败，去掉路由重跑主体检查已通过。
- 改动后局部：创建首轮 7 tests / 设置首轮 23 tests 通过；设置权限与未保存重建补验后 26 tests 通过。最终创建契约随后补空 slug 自动派生，故首轮证据不当作最终通过。
- 一次名为类型基线的异步检查实际撞上创建块中间编辑，报 `Cannot find name 'setCreated'`；执行者完成该块后已通过 web typecheck，最终仍需所有块落定后复验，未把中间失败写成基线缺陷。
- Biome 不处理本仓库 Markdown，文档命令结果为 `No files were processed`，不计作通过也不算文档语法错误。
- 设置块独立 Opus 首轮评审未过，三项真实发现：① create/update 角色无 `knowledge.models.manage` 时读取模型管理列表会 403，需要安全选择投影；② embedding 保存立即切换检索模型，旧文档未重建前不可按旧向量空间召回，原说明错误；③ 整库逐文档切换，批次失败不回滚已成功文档。后两项交 Sonnet 修复，第一项交 Opus 固定最小安全候选接口后实施。
- 视觉夹具已修复为外渐变 + 224px 侧栏占位 + 白色内容壳 + 24px 内容边；最初透明 main 的截图不作产品视觉证据。1480×840 实测 page x248/宽1204、页头56、任务导航32、文档表格964、页面横向溢出0；1024×768 同轮 CDP 确认 innerWidth1024、页头56、表格508、页面横向溢出0。Ego 的 emulation 跨调用会恢复，窄屏数据仅采用同轮确认值。首次失败文档菜单已实际看到“查看处理记录”且没有“重新解析”；只读场景隐藏上传/编辑等写入口，检索测试给权限提示。这些只证明真实组件+固定数据，不证明真实后端写链路。
- 模型选择安全契约已定：原 GET 增 `?view=selection`，只投影 id/name/kind/enabled/supportsImageVectors，knowledge.read 可读，管理GET仍 models.manage；调用方用独立 selection 缓存，保留管理配置不外泄。
- D 定向验证：jobs/routes/sources 3 files 40 tests 通过；jobs query/document polling/source runs 3 files7 tests通过，shared/core/db构建通过。执行者额外跑全后端出现两项失败（route-access并行400、sandbox:dev无GNU bash），不声称全后端通过；本任务最终复验按知识库范围。
- 窄桌面处理记录实屏发现：1024px viewport / 748px表格容器虽无页面溢出，但固定列挤压对象与步骤到约20px，几乎只剩省略号。待 B 释放文件后补最小列宽与表格容器内横滚，优先保留对象/错误可读性；不能以overflow0当成通过。
- 详情独立 Opus 首轮未过：Wiki `current` 不在已加载分页时不能当 `currentVersionId=null`；空专家关系需 `/agents` 后续入口；页头操作应32px非sm；E2E须展开高级字段再输入。另有主会话实测列宽与typecheck可选字段错误，待同一写入者收口。
- 最终主会话验证：知识库前端相关 10 files / 189 tests 全通过；`pnpm exec vitest run --project backend packages/api/test/knowledge-jobs.test.ts packages/api/test/knowledge-model-selections.test.ts packages/api/test/knowledge-routes.test.ts packages/api/test/knowledge-source-routes.test.ts packages/api/test/knowledge-wiki-routes.test.ts --no-file-parallelism` → 5 files / 67 tests 全通过，0跳过（压缩器只返回JSON报告路径，已解析 `.vitest/json/output.json` 核对逐文件passed）。
- 最终 `pnpm typecheck` 所有包通过；`pnpm --filter @agentport/web build` 通过（既有大chunk提示保留）；`pnpm lint:focus` / `pnpm lint:contract` / `git diff --check` 通过。Impeccable detect 对三个最终UI文件全规则返回 `[]`。
- 最终视觉：1480×840文档页文件夹220px、gap20、header56、h1=1、page overflow0；1024×768处理表1024px/容器748px、对象224px、步骤240px、header buttons32px、page overflow0。首次失败记录能看到确切文档/错误/重试；空白Wiki可编辑/生成草稿；设置关闭焦点回到实际按钮。截图 `.tmp/knowledge-ux-visual/knowledge-detail-final.png` 为临时查看产物，不入库。
- 源码与测试独立review：jobs块通过；安全selection+创建+设置复审通过；详情四项及实屏/类型修复定向复核通过，无剩余must-fix。执行者最终management 127 tests通过，主会话整合189 tests覆盖同一最终实现。
- `.vitest/json/output.json` 已确认属于本轮可重建输出并单路径恢复，未触其它成果；不保留测试输出归档。
- 静态清理删除确认未用的jobSchema/导入；界面和shared/db源码Biome通过，三个既有大文件formatter仍报历史格式（routes单行配置、api账户签名、queries既有queryFn）；`--formatter-enabled=false` 0error/6历史警告，未为此重排整文件。Markdown不在Biome范围。
- 未运行带seed的真实E2E；真实应用停登录；未改账户/Cookie/真实业务数据，未发付费模型或来源请求。临时视觉夹具写操作明确501，不冒充真实联调。

