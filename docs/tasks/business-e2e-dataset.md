# E2E 业务开发数据集

## 目标
通过现有真实业务 E2E 流程建立完整、关联一致、可复用且持久化的本地开发测试数据，后续开发不再从空列表开始。提供可执行构建/验证命令、真实结果与覆盖说明。

## 方案
先并行盘点实际业务页面与现有 E2E / seed / fixture 工具，再复用项目 e2e + @e2e-dev/web 构建数据。数据必须通过业务入口产生，不伪造运行成功、知识索引或评估结果；重复执行复用已有数据，不清空当前数据。先完成可验证构建，再完善覆盖、独立评审与说明。

## 基线与范围
- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/business-e2e-dataset`
- 分支：`worktree-business-e2e-dataset`
- 起点：刚 fetch 的 `origin/main`，`68241bab58ad8ec59727d70677bec790af2a5ae2`。
- 初始 `git status --short` 为空。
- 允许范围：业务数据 fixtures、E2E 构建/验证入口、必要 scripts 和操作文档；现有工具优先。具体文件边界待盘点后固定。
- 主会话负责契约、编排、审查与运行验证；代码、测试、配置、脚本由子代理修改。

## 当前有效决定
- 用户要求使用 LoopX，通过 E2E 方式补齐完整测试业务数据，后续功能开发直接复用。
- 保留已有数据及用户当前登录，不更改默认凭据、不清库。
- 2026-10-31 用户明确授权 commit / push / 创建 PR；未授权 merge。
- 最终状态：准备提交并创建 PR（不 merge）；知识相关待办继续 blocked，不再以「未提交差异」作为最终交付描述。历史段落中的未提交记录仅作当时过程保留。
- 不新增独立基础设施；不混入其他 LoopX 技术栈改造任务。
- LoopX：Goal `agentport-goal`，Agent `business-data-controller`。
- P0 `todo_78568594c3fedb5f491e9013`：盘点、实现、首次生成。
- P1 `todo_8df428198e79577d0b70d488`：重复运行/关联/持久化验证、独立 Opus 终审与文档。

## 已替代项及原因
无。

## 步骤
- [x] 并行盘点业务覆盖与现有数据/E2E 能力，固定实现契约。
- [ ] 实现持久化业务数据构建，并通过真实业务流程运行。
- [ ] 验证再次执行、跨页面关联和数据持久化。
- [ ] 独立 Opus 终审及必要修复，更新复用说明与 LoopX 证据。

## 改动文件
- `docs/tasks/business-e2e-dataset.md`

## 已核对的现有能力与缺口
- 已有 `e2e@0.21.3` / `@e2e-dev/web@0.15.3`，复用 `tests/support/auth.e2e.ts` 的 admin session；默认 E2E 只起 Vite，不负责 API/worker。
- 仓库无业务 seed；现有 smoke 能真实创建连接器/工具/专家但使用时间戳，重跑重复造数；多数其他 E2E 直写 fixture 并清理，不能当作本任务数据构建。
- 专用数据 E2E 默认跳过，仅显式命令启用，正常回归测试的清理逻辑保留。
- 实际覆盖领域：专家及版本/绑定/规则/风格/记忆、连接器及工具、技能、插件、运行环境、账户角色、知识库及文档/文件夹/标签/Wiki/来源/处理记录、对话/成果/分享、运行、评估、定时任务、个人记忆/回顾、审计与运维聚合。
- 动态结果须实际执行：LLM/Docker 支撑对话与评估，embedding 支撑知识 ready，Docling 支撑 PDF/Office/OCR。缺依赖时不能把配置创建冒充动态成功。
- 定时任务无立即运行入口；pending/running/审批/提问等瞬态不可当作稳定持久数据验收。
- `http://agentport.localhost` 当前无应用注册；已核对开发 PG/Redis 健康，3000/5173 未监听。环境代理负责服务准备，不清库、不改密码。

## 运行环境核验与当前阻塞
- 代码根为本 worktree，commit `68241ba`，配置为本树 `.env`（与主 checkout 来源文件内容一致，未改密钥）。
- 已构建 shared/core/db；API `http://127.0.0.1:3000` 健康检查 DB/Redis 连通；web `https://worktree-business-e2e-dataset.agentport.localhost` 返回 200，Vite 4955。
- worker 启动后在旧队列任务遇到 `agent_runs.subject_kind` / `audit_log.actor_kind` 缺列，已确认 PID 87397 属本任务并发送 TERM 暂停；其启动期间已观察到 2 个旧 job 失败，不能声称无影响。
- 共享库非空：agents 92、agent_runs 95、user 1；agent_schedules/eval_cases/eval_runs 各 0。未修改数据。
- 实际迁移账本最近时间戳 `1793290807794` 与当前 journal 历史不完全匹配；未手改账本、未迁移、未清库。
- 当前 `0045` 向非空 agents/agent_runs/user 增加无默认值 NOT NULL 列，不能以普通 migrate 保留旧数据。需选择不影响现有库的持久化数据集环境；后续先核定隔离与后续开发复用契约。

- 数据主题固定为“青禾商贸｜采购与售后协作” v1，命名空间 `devdata-qinghe-v1`，显示名 `【青禾演示】`，使用虚构采购单 `QH-PO-2026-001`、云杉包装、竹纤维随行杯。
- 专家 5、技能 2（含参考文件）、本地插件 1、显式连接器 2/工具 3、专用环境 1/成功与失败版本各 1、知识库 1/文件夹 2/标签 3/正常文档 4/Wiki 2/来源 1、暂停任务 2、评估用例 2/批次 1、演示账户 2；运行/审批/成果/分享/记忆审核由真实业务产生。
- 只读复用可用 embedding profile；无可用配置时明确知识链路缺口，不伪造 ready。个人偏好不覆盖。
- 两个命令：`pnpm dev:data` 缺项构建与复用，`pnpm dev:data:verify` 纯读验收；固定身份、分领域 manifest，冲突不覆盖，已发起的有成本任务不重发，失败不自动重试。
- 专用配置/显式环境开关隔离数据构建，普通 E2E 不收集；真实UI完成各域代表链路，重复项和轮询可用同浏览器同origin鉴权业务API，禁直写DB。
- 文件单一写入者：基础/资产组负责公共helper、配置、命令与assets；知识组只负责knowledge；环境组只负责runtime；业务组只负责business编排；主会话只改任务文档。

- 隔离方案已执行：持久PG库 `agentport_business_e2e_dataset`，现有PG角色/服务，全部46迁移成功，末条 `1793405324755`；Redis db12（启动前空且无其它客户端）。旧库仍92专家/95运行/1账户，未迁移或清理。
- 新库 bootstrap 登录真实 HTTP 200，新库1账户、0专家/0运行/0知识模型配置。沿用配置的bootstrap凭据但不输出，不改旧库登录。
- API现进程98657隔离库3000；web分支URL 200。worker98658确属隔离库，但主会话收到并行通知时误当旧库暂停；已派环境代理准确核对连接后恢复。
- Docker Desktop实测宿主0700目录/0600文件容器uid1000可读写，未放宽权限；限定本机Docker Desktop。
- 旧 `agentport/sandbox:dev` 缺 `session-supervisor.js`，专用镜像由环境执行组构建。不得改平台默认环境线上指针，runtime数据组在专用环境真实构建/发布后业务专家绑定。
- 无真实embedding profile（旧库1038条均测试配置），本地模型网关models目录200，Docling未启动；知识依赖只读调查继续。Markdown/txt不为可选Docling格式加服务。
- 数据文件在本树data目录，PG库独立持久；本任务未交付/未合并，后续不可直接删worktree丢失附件成果。

## 已验证运行条件
- 专用沙盒镜像 `agentport/sandbox:business-e2e-68241ba` 构建成功，镜像 ID `sha256:280a3b44e227587ab0b17fc218d0e3e54522af12c1802e9e1dd9a77f401c055a`；runner/session-supervisor、GNU bash 5.3.9、SDK 0.3.311 原生 CLI 均存在，uid1000权限探针通过。
- worker 已恢复 PID9304（detached），实际连接独立PG与Redis12、使用专用镜像；主会话复核镜像ID、进程存活、API ready（DB/Redis ok）。平台默认环境旧指针未修改，业务必须绑定专用环境成功版本。
- 真实embedding已确认缺失：无本地embedding服务、chat网关无embedding模型、配置无真实凭据。只依赖知识ready/检索的场景阻塞，其余继续。非阻塞User Todo `todo_4dd19d0448ec700941b44fe3` 已登记并完整回读，需通过知识模型设置补充真实endpoint/model/协议/API key，禁止用测试profile冒充。
- Docling未启动；本任务优先已有直接解析的Markdown/txt，不为可选格式加服务。

## 已落地数据与实测覆盖
- assets真实UI链通过：2连接器（generated测试成功/http测试失败）、3工具（普通/需批准/停用）、2技能、1参考文件、1插件、2账户（active/disabled）。`.e2e/assets-run4/report.json` 2/2通过，rerun 2/2、各ID/数量/状态及manifest摘要不变，verify-final2 2/2。
- assets实际修复：补app.open、工具断言按对应行防重复toast、创建成功写manifest前中断的同内容工具复用、Markdown CodeMirror改fill避免自动续号、仅ready=false自有未完成技能可补齐，已完成内容冲突不覆盖。
- knowledge入口已修复app.open；真实build登录后仅GET profiles/bases并明确缺embedding失败，verify实际执行且缺库失败、无skip。manifest status=blocked，base=null、所有实体/成本任务为空。报告 `.e2e/knowledge-build/report.json`、`.e2e/knowledge-verify/report.json`，未生成任何知识实体/索引。
- 数据manifest真实路径由 `datasetPath(section)` 决定，为 `data/dev-dataset/<DATASET_ID>/<section>.json`；早先报告里的qinghe-v1简写不能硬编码复用。

## 下一步
已完成现有可独立执行范围，最后独立终审通过；完整目标仍被真实embedding缺失阻塞。用户通过知识模型设置安全配置可用1024维endpoint/model/协议/API key后，恢复LoopX两个blocked待办，继续知识构建、主专家知识绑定和整体验收。当前交付未提交差异及已保留数据，不宣称全绿，不做无效重试。

## 最终交付验证与状态
- 主会话最终 `pnpm dev:data:verify` 实际6项：auth/assets/business-ui/runtime 4通过；business/knowledge 2失败，报错仅缺知识库/无embedding/未绑定知识server，没有skip。
- 主会话重跑backend两个完整测试文件：40/40通过（独立随机测试基础设施，TMPDIR=/private/tmp）；错误路径日志含预期NUL输入失败，JSON success=true/0failed，不混淆为回归。
- 主会话最终API build成功；Biome14文件exit0（2条原有optional-chain警告未扩改）；归属测试5/5，git diff --check通过。
- 最后独立Opus终审摘要授权边界、父子关系测试、UI读写开关和既有manifest helper均通过，无阻塞；仅删除一处过时注释，不改变逻辑。
- 分享SQL独立核对2条同run/path，revoked_at一空一非空；manifest只是场景索引，数量以API/DB事实为准。
- 文档最终已修正默认凭据描述和旧环境影响；首次环境准备两条旧job失败如实保留，原库未迁移/清理。
- LoopX最终进度与vision已写回、readback成功；完整构建与最终验收两Todo均blocked/done=false，原因是真实embedding配置缺失。循环停止等待输入，未虚标complete。
- 保留本树.env（忽略文件）与data；主checkout.env未改。未commit/push/merge，成果未合入。生成的已跟踪Vitest报告差异已仅还原本次产物，不把运行日志提交。


## 摘要修复与页面实测
- 唯一生产改动toSummary恢复6个既有元数据字段，不下发敏感配置；tests同步精确字段与父子关系，原红3项到backend2文件40/40绿（TMPDIR非软链路径），API build通过。
- business删除子专家API fallback，新增list身份/parentId verify；专用business-ui中只读verify默认运行、写验收仅显式E2E_DEV_DATA_UI_WRITE=1。
- API按本树配置重启为10262，worker未动。真实UI解绑保存后子专家parentId=null，再重绑保存/详情/工作区subAgents文件一致；已有OpenUI会话DOM table3行、采购单号/业务编号与3指标卡可见。
- UI verify/write各2/2，agents5/runs12/conversations11/schedules2全paused前后不变，无新增模型。
- 主会话最终Biome检查14文件exit0，生产routes存在2个原有optional-chain警告（非本次diff），未扩大修改。


## 最终审查与主会话验证
- 主会话 `pnpm dev:data:verify`：登录/assets/runtime通过，business/knowledge失败且仅报缺库/无embedding/未绑知识server，5测试3过2失败，无skip。
- 主会话独立SQL只读核对：5agents/12runs/2eval_cases/1eval_run/0knowledge_bases/0enabled schedules；chat成功3取消2超时1失败1，event成功2，schedule成功2，review成功1。
- Opus终审确认业务新增恢复与消息分页无冒领/重发问题；独立只读DB确认12运行均在重复构建前创建、任务paused/next_due_at null、timeout600000。
- 产品真实缺陷最小修法：toSummary补parentId/slug/role/model/uiFormat/createdAt（ISO），不扩敏感配置；原两套测试相反旧断言需同步，补真实list+父子关系与权限隔离行为。子专家UI需解绑再绑并保存/完整文件核对；OpenUI已有成功与程序落库但还需DOM呈现。已派Sonnet单一执行，不再次跑模型。


## 业务数据实际结果
- 5专家及其skills/plugin/generated connector/专用runtime/规则/风格/主题记忆/子专家关联已由真实业务入口建立；main仍复用首次ID `agt_01m68esp2sexsv5f8ch8p70fzp`。
- 7场景真实终态：purchase/openui/approval-approved succeeded，approval-cancel/stop cancelled，timeout timeout，invalid-model failed；采购有Markdown成果。
- 评估批次failed且1过1不过，两个底层运行succeeded；2定时任务各实际触发schedule succeeded后均paused、next_due_at为空；分享2（有效/撤销）；记忆review succeeded+applied及change。
- 共12运行（7chat+2eval+2schedule+1review），重跑仍12，未重复专家/用例/批次/分享或成本运行；timeout dirty=false、主专家600000已恢复。
- `.e2e/business-run6` 首次完成、run7重跑、verify3仅剩知识库/embedding及其绑定缺口而exit1；manifest status=partial不是全绿。主会话正用标准pnpm dev:data:verify独立确认整合结果。
- 实测发现production toSummary少于shared/前端预期，子专家picker不出现；当前测试临时同鉴权API绑定。此是实际代码与契约冲突，待Opus最小修法后补UI入口，不将API替代当UI通过。


## 业务复核与首次真实执行
- 7组关键修复获独立Opus通过，新增调度guardian默认Node HTTPS因本地CA未信任会失败；实测NODE_USE_SYSTEM_CA=1 GET200，可开始执行。
- 已带NODE_USE_SYSTEM_CA=1启动仅business build，E2E读取本树.env对应隔离库，报告保留 `.e2e/business-first`，后台任务 `bf5sxx3h7`。
- guardian Node参数已固化 `--use-system-ca`，Node24参数检查、真实HTTPS GET200、stop/disconnect/fired替身断言、Biome与窄类型均通过；不关闭TLS。
- 首次business真实E2E登录通过，主专家 `agt_01m68esp2sexsv5f8ch8p70fzp` 已由UI创建；脚本误认agents列表含slug而查重超时，尚未发起模型。已派执行代理按真实列表/详情契约统一修复并恢复creating记录，保留该专家继续；不重复创建或重发已有成本场景。


## 独立复核结论
- 资产与runtime本轮修复通过，生产源码无改动；复核已核对归属调用、终态不重试、技能正文与文件冲突、verify ID与插件正文、现有ZIP encoder无业务写入副作用、runtime归属在写manifest前判断。
- 独立重跑归属行为测试5/5、内存ZIP往返通过；四份assets/runtime修复后报告各2/2且exitCode0；assets manifest摘要仍为此前实测值。
- 此结论仅覆盖资产/运行环境及公共入口；不包括business和blocked knowledge，不代表整体完成。

## 后续开发复用配置
- 已将实际隔离配置保存在本worktree被忽略的 `.env`（权限600），主checkout `.env` 哈希未变；9项配置已更新，无重复键。
- DB为 `agentport_business_e2e_dataset`，Redis12，WORKSPACES/HOST_WORKSPACES/KNOWLEDGE均为本树data绝对路径；专用sandbox tag、网关3425、模型代理3426和API3000与已验证环境一致。
- node --env-file实际解析通过；api/worker现有dev脚本读../../.env，后续在本树用标准 `pnpm dev`，无需新启动脚本。已有任务进程占端口时先核对归属，不重复启动。
- OPERATIONS §9.3已补真实复用说明与知识依赖限制；该配置修改未重启服务、不影响进行中的测试。

- 资产/环境终审需修（正常路径证据认可）：资产按name查找可在改名后重建覆盖manifestID、无归属同名工具被接管、已记录连接终态自动重试/未完成技能正文重写会覆修改；runtime无manifest同名环境自动接管且有manifest缺name校验。分别派单写入者修复，保留已有数据。
- 同轮完善：资产verify改按manifest ID验身份并完整比较插件正文；helper删除手写ZIP，复用仓库现有encodePackage。修后真实rerun/verify核ID、数量、版本、manifest业务摘要，再Opus复核修复范围。
- runtime归属修复完成：无manifest同名对象拒绝，有manifest按ID命中后名称变更拒绝；两条无副作用断言通过（未触发manifest写）。真实 `.e2e/runtime-review-rerun` 和 `runtime-review-verify` 各2/2通过，版本3、线上指针、failedAttempts和业务摘要均未变。重跑仍更新source.updatedAt，因此字节哈希变化；verify不写manifest，哈希不变。Biome/严格类型通过，待独立复核仅两处分支。

- 资产修复完成：新增小型resolveOwnership纯函数及5条行为测试；按ID先定位，改名/丢失/无归属同名冲突停止，已终态不自动试连，删除技能正文重写，verify按manifest身份与插件完整正文；helper复用encodePackage删除手写ZIP。真实assets-review-build和verify各2/2、manifest摘要/ID/数量/状态不变；主会话node --test 5/5复核通过。已派独立Opus仅复核修复及新增影响。

## 独立审查与整合修复
- business审查结论需修：实际仅1generated同时承载普通/批准GET，脚本却需2generated且分类互斥；风格slug/记忆文件名ASCII与review UUID入参不合法；非主专家没绑定专用runtime；timeout修改恢复条件错误；重跑覆盖现有配置/绑定；eval清已有结果导致再次付费；schedule每分钟启用缺finally暂停且verify不查终态。
- 修复严格限定business测试文件，不扩生产代码；已有对象冲突时报错、已有批次不重发，调度finally暂停并核对消息标记runId及终态；统一只读环境变量、API前打开页面。修后独立复核再真实运行。
- package命令模式已修：dev:data明确E2E_DEV_DATA_VERIFY=0，verify=1；CLI选择四组build或四组verify准确，Biome通过。

## 运行环境与基础资产阶段结果
- 根因已确认：API入队冻结自身 `SANDBOX_IMAGE`，worker遵循版本的baseImageId。API重启为PID33860并注入专用新镜像，仍独立PG/Redis12，未改.env或默认线上指针。
- runtime测试新增显式 `E2E_DEV_DATA_RETRY_RUNTIME_VERSION=<失败版本ID>`；旧失败存failedAttempts，重跑不自动重试。
- 专用环境 `rte_01m68cyxg6fvnsfkagbrtc7ed0`，发布版本 `rtev_01m68d5863exsv5esc6wfz0dvf` ready，日志verify:ok；预期失败 `rtev_01m68d5hv9exsv5et8p7kp5f8c` 真实RUN exit1；首次missing supervisor版本保留。
- runtime显式恢复2/2通过；不开重试开关再运行2/2通过、版本3→3；VERIFY模式3/3通过，版本/指针/manifest摘要不变。报告 `.e2e/runtime-{recovery,rerun,verify}/report.json`。
- assets静态检查和普通配置排除验证通过；首次只读验收真实登录通过、缺assets manifest预期失败。首轮真实资产构建在任何写入前失败APP_NOT_OPEN（API查重前未app.open），已派执行修复并跑创建/重跑/只读。
- business实现已完成，仅业务测试及采购单附件；类型/Biome/CLI收集通过，只读验收登录通过后按缺business manifest预期失败。未发起真实模型场景，先由独立Opus审查实际API/资产契约及成本幂等，避免将静态通过当业务正确。
- 数据测试新增总代码约5361行（当次wc，knowledge仍实现中）；需独立审查实际接口与复用范围，不能因代码量宣称覆盖。

## 验证
- `git fetch origin main` 成功。
- `git log -1 --format='%H %D'`：HEAD 与 `origin/main` 同为 `68241bab58ad8ec59727d70677bec790af2a5ae2`。
- `git status --short`：空。
- `pnpm install --frozen-lockfile` 成功；shared/core/db build 成功。
- runtime E2E 静态检查：Biom​​e、严格类型检查、专用收集与verify标签筛选通过（执行代理证据）。
- 首次 runtime 只读验收因Portless前端退出404而未触及登录；恢复独立detached web进程PID23715后，登录页HTTP200。
- 第二次 runtime 只读验收：真实UI登录通过（967ms）；验收以“缺少runtime manifest”预期失败（481ms）。这是诚实空数据红证据，不计通过。
- runtime真实UI首轮：登录通过（862ms），创建专用环境 `rte_01m68cyxg6fvnsfkagbrtc7ed0`，正常构建版本 `rtev_01m68cyxnrfvnsfkb5k9jt7cgn` 实际failed（10s）。只读日志证明FROM旧 `runtime-base-f79edc9f2343`、缺session-supervisor；API提交时的底座配置需与worker一致。失败记录保留，不自动重试。Opus已派窄范围诊断/修复仅任务环境与runtime测试，允许修复后显式重试并保留历史，随后重跑/verify。

## 持续复用契约（2026-10-31）
- 本次已生成的持久 PostgreSQL 库 `agentport_business_e2e_dataset` 与本树 `data/` 目录是后续开发的默认数据基线，后续功能开发直接基于该数据，不重新造数。
- 日常 `pnpm dev` 不运行 E2E 造数；只有缺项首次生成或需要恢复时才运行 `pnpm dev:data`，`pnpm dev:data:verify` 始终只读。
- 不清库、不删 `data/`、不删本 worktree，也不复制临时空库替代现有持久库。
- PR 只包含代码、fixture 与文档，不含 `.env`、真实数据库或其他成果文件；成果数据本地保留，不随 PR 提交。
- 不新增备份、归档、构建脚本，也不改本地运行配置。
