# 记忆能力升级：借鉴 TencentDB-Agent-Memory

## 目标

梳理 TencentDB-Agent-Memory 的真实记忆能力与实现，对照 Agentport 当前逻辑，明确复用、迁移、调整与不采用的功能点；由项目经理自主完成方案、实现、独立评审与验证后交付。

## 方案

先并行开展腾讯源码研究、Agentport 当前实现审查、官方 SDK 能力及历史方案核对。汇合证据后由 Opus 确定完整落地契约，再由 Sonnet 按互不重叠的文件边界并行实现。方案必须遵守官方文件系统定义、复用现有能力、无需新增独立服务。

## 基线与范围

- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/memory-upgrade`
- 分支：`feat/memory-upgrade`
- 起点：fetch 后的 `origin/main`，`522182f`。
- 初始 `git status --short --branch`：干净，只有分支信息。
- 腾讯参考目录：`/Users/xbjt/Documents/myself/TencentDB-Agent-Memory`，只读。
- 首轮研究在同基线的 `knowledge-ux-review` 树进行；其未跟踪文件 `docs/tasks/knowledge-ux-review.md` 属其它任务，不复制、不修改。
- 范围待研究汇合后固定；不得借记忆升级改知识库或登录数据。

## 当前有效决定

- 用户先要求梳理功能点与迁移/调整边界，再基于能力落地。
- 用户进一步授权主会话以项目经理身份完整设计、自主推进并交付，不等待逐项确认。
- 主会话只编排、读代码、审查与运行验证，不修改代码；Opus 负责判断与评审，Sonnet 负责确定方案后的执行。
- 2026-10-31 用户已明确授权本任务 commit/push/PR/merge；交付状态以 GitHub PR 实际结果为准。
- 遵守 `docs/PITFALLS.md` 中记忆索引/注入大小限制、共享个人偏好测试锁、随机测试数据库、构建当前 workspace dist 的规避规则。

## 已替代项及原因

- 不再停留于提交方案等待确认：用户已明确授权项目经理完成设计并落地。

## 已固定的主题经验升级契约

详见 [执行契约](memory-upgrade-contract.md) 与 [研究证据](memory-upgrade-research.md)。本次采用用户触发的主题整理，不新增私有 L1/L2/L3 数据库或后台提取管线：

- `agent_memory` 目标必填 `name`；既有/新主题均可回顾，沿用单目标完整正文提案。
- snapshot 增加固定伴随索引 `index`，仅主题目标携带，personal/rule/MEMORY.md 为 null；最多主题+索引两个文件，不提供任意文件写入计划。
- 主题缺少链接时确定地补相对 Markdown 链接，原索引其余正文保持；主题+索引一起采纳、记账、补偿、恢复及回滚。
- evidence 增加 kind 归因，纯助手建议不作为可采纳正文唯一依据；共享 no-change 判断统一 API/worker/web。
- 所有主题手工 CRUD 进账本、主题版本/回滚、正文缓存失效、索引容量校验、只读权限状态一起补齐。
- 独立记忆 ZIP 下载，解压经现有公开 PUT 导回新专家并核对正文；不改专家定义包格式。
- 不新增服务/依赖/物理 schema，不兼容旧 JSON 记录、不自动清库；原生 SDK 运行时不变。
- 当前契约保持既有平铺文件规则；运行时嵌套文件管理是已识别但本阶段尚未解决的边界，最终不得声称完整目录管理已覆盖。

固定公共函数：`memoryIndexContentAfter(name,content,indexContent)`、`memoryReviewAfter(target,before,proposedContent)`、`memoryReviewHasChanges(target,before,proposal)`、`validateMemoryContent(name,content)`，以及 shared 文件名 schema 与三项容量常量。

执行边界：共享 Sonnet 独占 shared memory 契约/测试；API Sonnet 独占 API 记忆读写/journal/review/download 与 DB repo/对应API测试；worker Sonnet 独占 memory-review及worker fixture；web Sonnet 独占 api/query/记忆组件/页面及web fixture。公共契约完成前后端/前端只准备测试，运行依赖当前 shared build。文档事实修正代理已结束，后续同步无写入冲突。

## 当前全链路审查新增事实

现有实现审查已返回：

- 原生文件工具及真实 SDK 允许嵌套主题文件，API 列表/CRUD 却只支持平铺，形成自动学习后 UI 不可管理的真实缺口。
- 主题文件手工编辑不入版本账本；版本接口对非 `MEMORY.md` 返回空。SDK 原生写入也不进 DB 账本，不能声称全量记忆历史。
- 个人版本 `before` 在拿到最新 `limit` 条后内存过滤，导致下一页不可达；已派独立 Sonnet 在上一纠错文件域修真正 SQL 游标，同时把唯一调用的 repo 方法改名 `listPersonalByUser`。
- 专家文件与规则手工编辑缺乏旧稿冲突保护；索引容量限制目前仅采纳入口生效。
- apply/rollback 的 Query invalidation 缺少 `agent-memory-file` 正文 key，编辑器可能显示旧内容。
- 回顾只能更新索引，无法整理主题；父会话的子智能体材料也不能直接回顾到子专家。
- 现有专家记忆按专家共享，非逐用户私有；不得把文件工具边界宣称 OS 级秘密隔离。
- 专家定义 ZIP 不携带记忆正文，保持定义与学习数据的既有边界；若本次新增可移植记忆能力应提供明确独立入口而非悄悄塞入定义包。

文档冲突待同步：ARCHITECTURE 个人投影写未运行前重建，但 worker 已每轮重建；journal 并非所有手工操作都有；export/routes 注释声称带记忆但实现不带；shared proposal 注释说无证据可行，但 worker 拒绝有正文无证据。

## 已确定的纠错单元（独立于能力选型）

Opus 确认个人偏好版本接口按用户查账本却未过滤 `target.kind=personal`，会混入同用户写入的专家记忆或规则；`delegation-memory-lock` 测试还漏持共享锁。Sonnet 独占 `packages/db/src/repo/memory-changes.ts`、`packages/api/src/features/memory/personal.ts`、`packages/api/test/personal-memory.test.ts`、`packages/api/test/delegation-memory-lock.test.ts`，先补混合目标与分页行为测试，再修过滤与共享锁。其它代理不得同时编辑这些文件。验收为上述两套件并行通过且个人版本范围准确。

## 首轮官方约束核对（2026-10-31）

- 官方 memory、sub-agents、hooks 与 Agent SDK 文档已由 Opus 核查；本地 SDK 为 `0.3.311`，捆绑 CLI `2.1.311`，不代表运行镜像版本。
- `MEMORY.md` 只自动加载前 200 行或 25KB，主题文件按需读取；不引入自定义分层格式来替换它。
- `settingSources: []` 不会关闭 auto memory；涉及隔离提取/回顾时需审查是否显式禁用，不能仅凭空 settings 声称无持久记忆。
- 子智能体 `memory: project` 与独立记忆目录现已接通，旧研究中“子智能体记忆不支持”的说法已过期。
- `UserPromptSubmit` 可追加上下文；`PreCompact` 不提供同样的 additionalContext 输出，不能当记忆注入通道。
- 官方现已允许有条件地从 project 配置 `autoMemoryDirectory`，本地类型注释及 D-61 仍保留旧说法；当前 inline settings 使用不受该漂移影响，后续修正文档。
- D-73 不新增独立服务与文件系统第一性约束保持有效；不得照搬 Tencent Proxy 或增加同范围第二权威。

## 能力选择与验收框架

研究结果汇合时逐项填写，不以腾讯能力清单直接作为新增需求：

| 维度 | 必答问题 | 交付证据 |
|---|---|---|
| 用户收益 | 实际解决哪种重复交代、错误记忆或维护困难？ | 明确用户操作和可观察结果 |
| 现状复用 | 已有原生文件、回顾、版本、锁和权限是否覆盖？ | 当前代码路径与缺口 |
| 腾讯机制 | 来自已实现代码还是文档宣称？ | 参考项目 commit、源码行号 |
| 可移植性 | 最终仍能落成官方文件并原样导出/导入吗？ | 生成路径与导回正文核对 |
| 记忆边界 | 内容属于个人、专家、子智能体还是知识库？ | 所有者、可见范围、写入权限 |
| 写入与纠错 | 谁决定记住、更新、删除或采纳？冲突时如何保留草稿？ | 行为测试与实际界面状态 |
| 运行时使用 | 何时加载哪些内容？是否存在容量限制？ | SDK/文件加载链路证据 |
| 成本 | 是否额外触发模型、索引、服务或维护负担？ | 明确触发规则与新增依赖 |
| 状态真实性 | 失败、空结果、跳过如何呈现？ | 失败/取消/权限测试 |

## 评审跟踪

- 个人版本纠错四文件：独立 Opus PASS，无阻断。
- 升级一致性设计：独立 Opus PASS。落实细节：manual先预分配最终changeId；journal恢复沿用稳定身份与原businessId；MEMORY版本显示伴随index时保留原主题target；仅检查和恢复实际改变的文件；证据校验先于no-change，不吞非法证据。
- API早期身份核查发现阻断（已交接Sonnet修复，保持单一写入者）：manual journal用randomUUID但账本另newId，已提交但清日志失败时，采纳/回滚/拒绝会被残留manual日志挡住；SDK随后只改索引还有重复补账路径。Opus给最小修法：manual预分配newId(memoryChange)作operationId并正常/恢复沿用；扫描/拒绝先按身份识别已提交日志，已提交只清日志不重写/补账/阻断；review/rollback沿用现有归属。需故障注入回归，不接受按最新快照猜同一操作。
- web独立首审未过：①MEMORY.md历史含伴随索引变更时错误显示主题正文，回滚确认未明确整次影响；②保存成功draft未清，后续cache更新仍显示旧稿；③review详情pending未拦路由/刷新，来源链接可离开。加文件列表请求失败未显示错误/重试。已交Sonnet在原web域补红测试并修，修后需重新验证并复核。全web1485通过仅为首版回归，不能覆盖这些新发现。
- web首审3阻断+文件错误反馈已修：4条新回归先红，60/60记忆测试、typecheck/build/Biome通过；独立Opus复核PASS，另重跑编辑/回顾46/46通过，追踪了blocker reset结算。主会话已真实浏览器确认索引历史映射与整次回滚影响。全web最终回归中。
- worker实现review PASS；新增不存在ID/窗口外引用行为26/26已通过，最终整合复核。
- shared首审：一阻断——非链接文本 `](topic.md)` 和图片语法会误判已有链接，导致漏补发现入口；Sonnet已修，独立Opus复核PASS：19/19测试、33项补充纯函数断言与shared noEmit通过，无签名/有效变化回归。两处注释也已校正。

## 步骤

- [x] 并行审查腾讯能力、现有链路、官方约束及历史方案，避免重复实现。
- [x] 固定能力矩阵、选择理由、实现契约与验收方式。
- [x] 先完成独立确定的个人版本纠错：目标过滤、SQL 游标、测试共享锁；已送独立 review。
- [x] 子代理按文件边界并行实现主题经验升级，行为测试先行。
- [x] Opus独立评审并修复阻断项（personal、shared、worker、web、API恢复与跨端完整性均PASS）。
- [x] 按改动范围验证、同步权威文档与交付状态（最终244后端/1489前端/16真实SDK及浏览器主路径通过；下载对象权限25套件复验通过；已提交至本任务 PR，合并状态以 GitHub 为准）。

## 改动文件

- `docs/tasks/memory-upgrade.md`、`memory-upgrade-contract.md`、`memory-upgrade-research.md`
- 权威文档：`docs/ARCHITECTURE.md`、`DECISIONS-PENDING.md`、`OPERATIONS.md`、`USER-STORIES.md`、`REMAINING-TODOS.md`、`README.md`
- shared：`packages/shared/src/memory.ts`、`packages/shared/test/memory.test.ts`
- API：`features/agents/{routes,memory-files}.ts`、`features/memory/{changes,journal,personal}.ts`、`features/memory-reviews/routes.ts`、`features/export/routes.ts`（纠错注释）；记忆相关API测试
- DB：`packages/db/src/repo/memory-changes.ts`、`packages/db/test/access.test.ts`（fixture）
- worker：`src/memory-review.ts`、`test/memory-review.test.ts`、`test/run-access-db.test.ts`（fixture）
- web：`lib/{api,queries}.ts`、`components/memory-review.tsx`、`pages/memory-panel.tsx`、三记忆页面测试
- `.tmp/`、`.vitest/`为本地验证临时产物，不属于产品交付；已跟踪默认报告在交付前还原。

## 下一步

已交付可体验运行入口：`http://127.0.0.1:61881/`，本树`feat/memory-upgrade`，基线522182f+未提交差异，最新API源码+本树web dist。管理器49145/API49203保持运行，独立PG `memory_preview_7fc57dd1b3454d7c`与Redis `backend_test_redis_5333ec453e2d49a5`。已实测登录、主题PUT/索引补链/主题与索引版本/ZIP与个人下载均200，受控提案2条可演示采纳与无需变更；主会话再次health与memory入口200。未启worker/付费模型，生成新回顾不在本预览运行能力内。停止`kill -TERM 49145`会清理仅本次资源。产品代码及既有评审证据不变；已提交至本任务 PR，合并状态以 GitHub 为准。

## 最终验证快照

- API最终Opus复核PASS；跨端完整性Opus复核PASS，无调用断裂。共享/worker/web此前均已独立PASS。本轮所有评审阻断已修并复核。
- API最终Opus复核PASS：manual身份与四P2全部通过，独立限定11/11回归通过（其余54按名称筛选未执行，不当作skip失败）；权限/运行锁/外部编辑保护保持。
- 最终代码浏览器复查：新API `60658`可读取回导3文件，原样保存MEMORY返回200且版本1→1；页面h1=1、无横向溢出；TaskSpace已finish关闭。
- 临时服务清理：停止final wrapper35327/API35395及旧资源owner74245；owner任务退出通知后自动重启了一次专用预览（36748/API36816、db memory_preview_13ecd0ed8251490e、Redis backend_test_redis_cfb1098935f74ebf），已再停止36748。两次专用Redis精确查询均为空，旧进程ps为空，`.tmp/memory-preview`目录不存在；其它会话资源未清理。
- 补充下载对象权限证据：使用真实maintainer账户，拥有功能权限但非目标成员时返回404 NOT_FOUND（防枚举既有策略），授予canMaintain后同对象下载200；规则globs测试快照补index:null。memory-changes完整25/25、0skip，报告`.tmp/memory-download-access.json`；api typecheck与Biome通过；最后测试增量独立Opus复核PASS，隔离库teardown回收账户与关联数据。
- 两接口文件格式/unused type整理后，三记忆web套件再次60/60通过（`.tmp/memory-web-post-format.json`），无运行行为变化。
- 续交付复核：API/web/worker三包typecheck再次通过；shared/API/worker/web五个核心实现Biome通过。上一轮244后端/1489前端证据已重新读取，代码未重做。可体验服务由Sonnet按现有隔离脚本准备中，不改共享用户数据。
- 后端整合：`pnpm --filter @agentport/shared --filter @agentport/core --filter @agentport/db build` 后，13个记忆/权限/文件/运行测试文件244/244通过、0失败/跳过，报告`.tmp/memory-final-backend.json`，覆盖最后身份与四P2回归。
- 前端全量：`pnpm exec vitest run --config packages/web/vitest.config.ts --reporter=default --reporter=json --outputFile=.tmp/memory-upgrade-web-final.json`，121文件1489/1489通过、0失败/跳过；后续仅两接口文件格式/未使用类型整理，web typecheck再次通过。
- `pnpm -r build && pnpm -r typecheck && pnpm lint:focus && pnpm lint:contract`：全部通过；构建仍有既有chunk大小提示。
- 全部25个修改代码/测试文件Biome：0 error、2条既有optional-chain建议warning，exit0。
- 原生运行：专属镜像真实容器+官方SDK+本地假模型16/16通过，不证明真实模型记忆归纳质量。
- 真实浏览器：受控提案主题/索引对比、来源归因、采用、索引版本、ZIP下载、公开PUT回导3正文一致、整体回滚、无需变更无采用动作均通过；最新1492×818布局body宽1492，h1=1，0残留弹层。
- 两份预览库已用容器内只读 `pg_database` 精确名称查询确认均不存在；两个专属Redis均已删除。默认跟踪测试报告已还原，未跟踪`.vitest/memory-*.json`移入忽略的`.tmp/`，历史过程报告路径以实际`.tmp/`为准。
- 未执行付费真实模型测评、全后端无关套件、发布或Git提交；本次不变物理schema，无需数据库迁移。

## 验证过程记录

- 已执行 `git fetch origin main` 与以 `origin/main` 创建专属 worktree。
- 初始工作树干净，基线为 `522182f`。
- `pnpm install --frozen-lockfile`：通过。
- `pnpm --filter @agentport/shared --filter @agentport/core --filter @agentport/db build`：通过，当前工作树产物。
- Web 基线：`pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/personal-memory-page.test.ts packages/web/test/memory-review-page.test.ts packages/web/test/memory-editor.test.ts`：3 文件、44 用例通过，0 跳过/失败。
- 后端首次独立报告：87 通过、75 因未配置 PostgreSQL 而跳过。同步主 checkout `.env` 后，随机数据库与独享 Redis 测试实际执行：10 文件，161 通过、1 失败、0 跳过。既有失败为 `packages/api/test/personal-memory.test.ts:229` 的版本列表断言：预期 2 条、实际 3 条。此时尚无源码变更，属于升级前基线问题，后续交 Opus 判断根因后修复。报告：`.vitest/memory-baseline-backend.json`。并行默认 JSON 报告曾互相覆盖，后续均显式使用独立输出文件。
- `personal-memory.test.ts` 单独复验：12/12 通过。完整 10 文件按 `--no-file-parallelism` 复验：162/162 通过、0 跳过。串行报告 `.vitest/memory-baseline-backend-serial.json`；跨文件并行污染的具体根因仍待审查，不能当产品逻辑已失败。
- 已在专属工作树复制主 checkout `.env`，仅供随机测试库连接与后续独立验收；未修改源配置、未修改用户账号。
- `pnpm -r typecheck`：各包全部通过（实现前）。
- `pnpm --filter @agentport/web build` 与 `pnpm --filter @agentport/sandbox build`：通过（实现前）。
- 真实 SDK 套件首跑失败在 beforeAll：本机 `agentport/sandbox:dev` 旧镜像没有 GNU bash，16 条均未执行。Dockerfile 已安装 bash，故不修改源码，改用本任务专属镜像 `agentport/sandbox:memory-upgrade` 构建并复验；不会覆盖共享 `:dev` 标签。报告 `.vitest/memory-sdk-baseline.json`。
- 第二纠错单元已实现：`before` 进入 SQL 后再 limit，repo 改名 `listPersonalByUser` 并去掉重复序列化；真正 3 页回归先红（第二页空）后绿，个人+delegation 22/22 通过，api/db typecheck通过。四文件已交 Opus 独立评审。
- 专属 `agentport/sandbox:memory-upgrade` 镜像构建通过；`SANDBOX_IMAGE=agentport/sandbox:memory-upgrade ... session-sandbox-sdk.test.ts --outputFile=.vitest/memory-sdk-current.json`：真实容器 + 官方 SDK + 本地假模型 16/16 通过、0 跳过，134.21s。覆盖跨 run/新容器子记忆加载与文件工具边界，不代表真实模型记忆质量。
- 个人版本四文件独立 Opus review `a4c65928e67b086d4`：PASS，无阻断问题；`git diff --check`通过。发现基线未引用 `listByAgent`，后续同文件整理时确认后删除。
- 主会话复验版本纠错后的整组并行记忆测试：10 文件、164/164 通过、0 跳过，报告 `.tmp/memory-fix-all-backend.json`；原跨文件失败已未复现。
- `pnpm lint:focus`、`pnpm lint:contract` 与 `git diff --check` 通过（主题升级前）。
- web最终独立复核PASS；此前三阻断已修，46/46限定复验通过。最终全web1489/1489、build/typecheck通过。两接口文件还有基线格式/未用类型导入，已交Sonnet纯机械整理，不变运行行为。
- API手工稳定身份修复完成：预分配newId关联journal/账本，settled先清理不阻断，新增5回归先4失败后81/81四套通过，api/db typecheck与db build通过；后续四P2修复正在此基础进行，最终需联合Opus复核。
- 前端修复后最终全量复验：121文件、1489/1489通过、0跳过，报告`.tmp/memory-upgrade-web-final.json`；web build/typecheck再次通过（主会话）。
- 浏览器无需变更详情已实测：deployment回顾成功/无需变更，只提供重新生成与关闭，没有采用/不采用/回滚；来源链接及用户事实可读，validation列表显示已回滚。
- API后续独立review发现四P2：日志恢复后手工PUT不能沿用恢复前算出的索引after；MEMORY无变化保存需正确投影主题伴随index记录；同内容PUT也需容量校验；恢复补账成功后的删日志失败不能返回500。API身份修复后已交同一Sonnet域补红测修，尚未最终通过。
- 主会话整合后端回归：shared/API/worker/db/sandbox共13文件、233/233通过、0跳过，报告`.tmp/memory-integrated-backend.json`；root `pnpm -r typecheck`与`lint:focus`/`lint:contract`通过。此时API身份/web review修复尚未完毕，修后受影响范围需再跑。
- 浏览器新版API预览`http://127.0.0.1:58723/`（wrapper18134/api18189）复用独立PG/Redis，真实操作通过：查看受控proposal的来源归因与主题/索引双对比→采用→公开GET核主题正文和索引链接均200→面板索引版本摘要正确→真实下载ZIP成功（3文件298 UTF-8字节）→版本详情展示主题+索引→回滚确认明确“删除validation主题并恢复索引”→执行后主题404、索引恢复原文、面板主题行消失且新增回滚记录。提案为直接种入受控SDK结果，不代表真实模型生成质量。下载文件`.tmp/browser-memory.zip`已在真实浏览器同源上下文解包，经公开POST新建专家及逐文件PUT回导：MEMORY111、deployment104、validation83字节，GET正文3/3完全一致，证据`.tmp/browser-memory-roundtrip.json`。
- API初版6套件120/120、db access13/13及root typecheck通过，ZIP真实解包→公开PUT导回另一专家→再次下载对正文通过；这不覆盖已识别manual稳定身份问题，当前Sonnet修正中，另Opus评审其它API路径。
- 主会话复验worker/web typecheck通过（新共享契约构建后）。
- 主会话全量前端回归：121文件、1485/1485通过、0跳过，报告`.tmp/memory-upgrade-web-full.json`（首次web升级实现完成后）。
- worker来源边界补证据：新增真实不存在ID与窗口外已存在消息引用两个行为用例，26/26通过，报告`.tmp/memory-worker-boundary.json`，实现无需修改。原worker独立review已PASS，新增测试待整合复核。
- 新web构建单元已完成：56/56记忆交互测试、web typecheck/build/focus通过，独立Opus review中；真实浏览器已打开新主题选择（已有deployment/MEMORY/新主题）、填写及来源勾选，560×580.625弹层在1492×818视口内完整可达、无横向溢出、h1=1；取消触发放弃确认，确认后0弹层且焦点返回“新建回顾”。尚未点开始回顾，避免未完成API和无worker阶段假验收。
- worker主题回顾已完成：24/24 memory-review、7/7 run-access-db、worker typecheck与本文件Biome通过；旧实现对新行为测试10失败/14通过，确认回归可识别缺口。范围：worker/src/memory-review.ts、worker/test/memory-review.test.ts、run-access-db.test.ts仅fixture；已交独立Opus评审。只假SDK管线证据，不宣称模型归纳质量。
- shared补链误判已修，残缺文本/图片红测试2失败后19/19通过、shared build/Biome通过，独立复核进行中。
- 主题升级文档已同步用户故事与运维边界，所有新增能力仍标实施中，未把契约当验证通过。ARCHITECTURE/D-61已修正个人投影每轮重建、journal当前覆盖范围、官方目录配置漂移。
- 共享契约Sonnet已完成并构建：18/18行为测试通过，包含索引保留/补链、有效变化、容量、必填字段；报告`.tmp/memory-shared.json`。`shared`无Node/DOM类型，UTF-8计数沿用项目现有按码点算法，无新依赖。
- 浏览器预览已启动：代码根为本树，commit `522182f` + 本任务差异，配置为脚本测试配置（仅管理员PG连接源自主checkout `.env`），URL `http://127.0.0.1:54559/`；独立随机PG与专用Redis，管理器PID74245，临时脚本 `.tmp/memory-preview.mts`。主会话ego-browser真实登录成功并检查回顾创建表单；h1=1，1492px视口内body.scrollWidth=1492，无横向溢出。此为升级前UI基线，非最终新功能验收。
- 浏览器提示Ego Lite可更新；本任务不升级浏览器，最终说明即可。当前专家详情实际选择参数由页面生成，手写 `task=memory` 不会切换；验收已通过点击“专家记忆”进入真实面板，确认索引和deployment主题可读取，源码编辑器可访问名称正常。
- 第一纠错单元已实现：个人版本目标过滤、混合目标分页回归、delegation共享锁；红测试正确显示agent_rule占页，随后personal+delegation21/21两次通过。
