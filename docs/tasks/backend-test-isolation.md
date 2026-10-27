# 后端测试默认隔离与文档收尾

## 目标
让默认后端测试不修改开发数据库及管理员，不与同时运行的其他测试共享可变队列；修正文档中的过时架构与交付状态。

## 方案
复用现有数据库隔离助手，采用 Vitest 5.0.5 的 backend globalSetup 创建每轮随机 PG database 与独享 Redis，provide/inject + setupFiles 在测试模块导入前传递连接串。Redis 复用已缓存 redis:8-alpine 镜像，临时测试容器由 Docker 分配 loopback 端口、关闭持久化，退出按本轮唯一容器名删除；这是测试资源，不新增产品部署服务。不使用随机有限库号，不扩散到生产 job 协议。套件级 PG 继续独享但统一建库助手；Redis 的 /1 分区保留在本轮私有实例内。文档独立并行修正。

## 基线与范围
- 基线：`d9fc9773396b78e9a91c6815111dd9a1e16c5b6f`，开工时与 fetch 后的 `origin/main` 一致；提交前快进到 `9b8bebd`（含 PR #79 SSRF 重构），未产生冲突。
- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/backend-test-isolation`；分支 `worktree-backend-test-isolation`。
- 新树初始干净。主 checkout 原有 `.vitest/json/output.json` 修改不属本任务，不触碰。
- 范围：测试配置、测试助手及受影响测试、验证用测试工具、相关权威文档及任务记录。

## 当前有效决定
- 用户于本任务明确授权提交、创建 PR 并合并，且不等待 CI；合并后清理已合入的任务 worktree。
- 保留最新 worktree 路径与清理判据；不新增完整多后端启动器、heavy、全局虚拟存储、构建缓存或 CI 门禁。
- Redis使用本轮唯一容器名，先create --pull=never再start，失败也只清理本轮名称；清理失败保留错误，不按前缀/镜像枚举删除。
- 隔离单位为一次Vitest调用/会话；watch同会话复用私有资源，退出清理，不将每次热重跑重建数据库纳入范围。
- 尊重已存在的外层隔离入口，保证默认入口安全；基础设施可用后的迁移失败必须暴露。
- 主会话只编排、记录与验证；代码由 Sonnet 实施，Opus 设计及独立审查。

## 已替代项及原因
无。

## 步骤
- [x] 拉取最新 main、核对规则、创建干净任务树
- [x] 固定隔离生命周期与文件边界
- [x] 并行实现与文档收尾
- [x] 独立 Opus review 及修复复核（文档、API助手及失败清理、核心生命周期、知识队列同类问题均已分轮定点复核通过）
- [x] 真实运行隔离验证与相关回归（最终统一270文件2407项通过，0失败/跳过）

## 改动文件
- 测试入口：`vitest.config.ts`、`packages/worker/test/global-setup.ts`、`setup-env.ts`、`isolated-db.ts`、`backend-infra-isolation.test.ts`。
- 共享助手调用与不可达清理：5个API套件；worker的`knowledge-ingestion`、`knowledge-reconcile`、`knowledge-scheduler`、`reconcile-eval-redis`、`reconcile-queue-redis`、`schedule-scheduler`。
- 使用与CI：`.github/workflows/ci.yml`、`CLAUDE.md`、`README.md`、`docs/OPERATIONS.md`、`docs/PITFALLS.md`。
- 事实修正：`docs/ARCHITECTURE.md`、`docs/REMAINING-TODOS.md`、4个已合并任务记录；本任务记录。

## 下一步
实现、独立Opus评审与真实验证均完成，用户已授权提交、创建 PR 和合并。提交前已快进到 `9b8bebd`（含 PR #79），并重跑 API/worker typecheck、SSRF+隔离定向测试、web 测试、Biome 与项目/焦点契约。合并后删除本任务 worktree，保留分支与远程。

## 验证
- `git rev-parse HEAD origin/main`：开工时均为 d9fc977；提交前快进后均为 9b8bebd。
- `git status --short --branch`：仅分支行，新树无初始差异。
- `pnpm install --frozen-lockfile`：退出0。
- `pnpm --filter @agentport/db... build`：shared/core/db构建退出0。
- 改动前 `pnpm --filter @agentport/api --filter @agentport/worker typecheck`：2包退出0。
- 验证前既有Docker服务：api:3000、worker模型代理:3426、PG:5432、Redis:6379；均不属于本任务资源，不停止或重配。
- `pnpm test:web`：75文件727项通过，退出0；既有jsdom导航未实现提示保留。
- 开发account表测试前快照：1行；仅输出不可逆SHA-256摘要作前后对比，不记录密码或连接串。
- 五个整合API套件：5文件23项通过、0跳过；结束后开发account摘要与测试前相同，私有Redis清理，四开发容器仍运行。
- 并行第二轮 `auth/native-queue/schedule-scheduler --no-file-parallelism`：3文件32项通过；退出后另一轮全量回归的Redis仍运行，开发服务不受影响。
- 改动后API/worker源码typecheck：2包通过；新增测试工具独立tsc检查通过；Biome14文件通过（两处import排序已修复）。
- 首轮后端完整回归（排除隔离专用测试、文件串行）：12文件失败/92通过/90跳过；33项失败/896通过/743跳过。日志显示临时库backend_test_1cbe4d6b88bb48fb被删除、Redis54233中断，已诊断为下条所述外部误删，不作为通过证据。日志保留于本次会话bash任务bw9gbrkxj。
- 首轮失败已查明：执行子代理23:16:01误把主会话仍运行的库/Redis当成残留手动删除；PG日志首次FATAL紧随删除，33项均可归因该外部清理。已禁止按前缀/镜像枚举清理，仅清本次函数创建返回的资源；开发服务未删除。第二轮全量结果见下。
- 核心独立review发现的不可用连接、Redis启动失败清理、新回归清理顺序、迁移失败清理错误均已修复并定点复核通过；watch范围为同会话复用、退出清理。
- PG不可达实测：指定不可连管理地址运行auth/config，1文件7项通过、1文件14项跳过，明确打印原因，退出0；未回落开发库。
- 首轮最早失败的knowledge-queue/knowledge-wiki/knowledge-wiki-update单独复验：3文件24项通过。
- 第二轮完整后端回归：194文件1672项通过，0失败/跳过，286.63s；退出时私有Redis56550清理，backend_test_*无残留，四开发容器保持运行。保留sourcemap、SIGTERM监听器和故障测试预期错误日志提示。
- 开发account摘要在23:29:46更新（全量23:29:41结束后约5秒）；此前定向与并发测试期间摘要一致。另有会话使用项目，无法将该次变化归因本测试，不宣称整个时段未变；最终定向验证前后重新取样。
- `pnpm lint:contract`：project contract OK；`pnpm lint:focus`：通过。
- 核心清理修复后定向7文件88项通过（隔离8项、登录/导出/聚合/知识写入/对账/调度）；该次前后开发account摘要一致。
- 不可达资源3套件：真实资源54项通过，PG不可达54项跳过；Docker不可用时两队列套件18项跳过且无重试挂起。
- CI镜像准备已前移到间接Vitest入口openui:check之前，远端未触发。
- 知识队列两套件红绿：跳过时原3次Queue连接降为0；正常18项过，PG/Docker不可达18项跳过；知识写入最后初始化修复正常36项过、PG不可达36项跳过。
- 最终固定版本：16文件Biome通过，新增隔离工具独立TypeScript检查通过。
- 最终统一 `pnpm test --no-file-parallelism`：270文件2407项通过，0失败/跳过，378.64s，退出0。保留既有sourcemap、SIGTERM监听器和jsdom导航提示；故障测试预期ERROR不作为失败。
- 最终统一测试前后开发account摘要一致；结束后backend_test_*及isolation_*无残留，临时Redis全部回收，四个原开发容器仍运行。
- 无产品src、schema、依赖或lockfile改动；未触发远端CI、未跑真实模型/E2E、未部署；不增加SIGKILL守护，watch只在会话退出清理。

## 文档冲突修正
- web依赖图与实际core纯函数子路径引用一致；对话入队无最近20条历史。
- overview查询6合3已完成，分页仍延后。
- 四个任务记录按git历史改为已合并，不据合并反推网络恢复或预览/资源清理。
- Compose项目名不解决固定端口、宿主卷路径与沙盒回连；保持现行边界。
- README/CLAUDE/OPERATIONS/PITFALLS从共享Redis db9与手动测试库准备改为会话私有资源；保留watch复用与配置错误边界。
- HANDOFF等明确历史快照保持不改，不作为当前缺口。

