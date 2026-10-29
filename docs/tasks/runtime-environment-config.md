# 运行环境配置

## 目标

提供命名运行环境、可编辑 Dockerfile、异步构建版本、构建日志、发布/回退线上版本及专家绑定。Bash 默认可用的实施记录见 enable-agent-bash.md。

## 当前有效决定（后于初始设计，所有执行者以此为准）

1. 专家绑定环境，不绑定构建版本。构建成功不自动发布；设置线上版本同时支持发布与回退。
2. **只在创建容器时选择线上版本。存活容器保持旧镜像，跨轮也不因发布或回退被替换。** 容器消亡后重建使用当时线上版本，对话记录按原机制恢复。初始 Opus 建议的“每轮镜像变化就重建”被用户明确否决。
3. **默认复用 Docker/BuildKit 层缓存，重新构建也不加 --no-cache。** 初始 Opus 的无缓存建议被用户后续要求替代。只发送独立 Dockerfile 构建上下文，不发送仓库/工作区/env；多阶段构建保留运行时内容，清理归档/缓存，不复制原始包和构建工具到最终层。不自动删除真正运行依赖。
4. 默认继承平台 runner 基座，不额外开发跨发行版移植或包清单语言。完整标准 Dockerfile 支持多阶段、RUN、COPY --from；基础模板使用 `ARG RUNTIME_BASE_IMAGE` / `FROM ${RUNTIME_BASE_IMAGE}`，构建时传入固定基座本地tag。最终镜像必须包含当前 runner、supervisor、probe、native-plugin 入口及SDK，可在uid1000、/app和只读root下执行。
5. 运行环境是平台基础设施，不给官方 .claude 文件添加私有环境字段。专家 ZIP 沿现有平台 sidecar 保存环境名称引用；导入明确映射，不导入镜像/版本历史，不执行构建。
6. 继续现有Docker/BullMQ/PostgreSQL，不新增服务、registry、自动构建、包市场或多机。无commit/push/merge、生产重启/重建授权。

## 方案与共享契约

- 新表 `runtime_environments`：TypeID id、unique name、dockerfile草稿、isDefault、onlineVersionId、timestamps。
- 新表 `runtime_environment_versions`：TypeID id、environmentId、dockerfile快照、baseImageId、status (`queued/building/ready/failed`)、imageTag、imageId、buildLog、logTruncated、error、startedAt/finishedAt/createdAt。一次构建就是一个不可覆盖版本。
- `agents.runtimeEnvironmentId` 可空：null表示平台默认环境，非null为明确绑定；这是绑定语义，不是旧数据兼容分支。默认环境由worker首次启动从 SANDBOX_IMAGE登记首个已就绪版本，此后不随env变量自动推进线上指针。
- `agent_runs` 记录容器实际使用的环境ID/名称、版本ID/imageID凭据；存活容器记录旧版本，不谎报当前线上。
- 命名导出：shared `RuntimeEnvironment`、`RuntimeEnvironmentVersion`、`RuntimeEnvironmentInput`、`RuntimeEnvironmentPatch`、`RuntimeEnvironmentBuildJob`、`ResolvedRuntimeEnvironment`；`RUNTIME_ENVIRONMENT_BUILDS_QUEUE = 'runtime-environment-builds'`；`DEFAULT_RUNTIME_DOCKERFILE`。`ResolvedRuntimeEnvironment = { environmentId: string; environmentName: string; versionId: string; imageId: string }`。
- repo namespace `repo.runtimeEnvironments`，至少 list/get/create/update/delete/listVersions/getVersion/enqueueBuild/claimBuild/appendBuildLog/completeBuild/failBuild/publish/resolveOnline/ensureDefault；数据库检查“线上版本属于本环境”，发布事务只接受ready；业务冲突抛项目统一Problem或由路由处理，具体方法签名在实现中尽快记录并同步。
- API `GET/POST /api/runtime-environments`；`GET/PATCH/DELETE /:id`；`GET/POST /:id/versions`（POST202新构建）；`GET /:id/versions/:versionId`；`PUT /:id/online-version {versionId}`。常规返回实体/数组沿项目api约定；错误使用现有机制。构建jobId=versionId、payload={versionId}，并发1，失败不自动重试构建。
- 构建worker独立模块：读取冻结Dockerfile、固定基座身份，默认Docker层缓存；从iidfile获得镜像ID，tag仅定位；验证后ready，失败有日志且不改线上。日志适度限长，终态停止UI轮询。退出/中断任务按已有队列机制收敛，不常驻假building。
- `SessionSandboxSpec` 增加环境身份；lease返回实际 runtimeEnvironment。创建镜像使用lazy resolver：复用存活容器时不读线上，不因image变化替换；只有真实创建路径调用resolver。挂载变化/故障/空闲回收沿原逻辑处理。
- stdio试连加可选 `runtimeEnvironmentId`，缺省默认环境；结果记录/返回环境版本身份，不能把一次成功当跨环境成功。原生插件市场动作用默认环境，专家实际执行用其绑定环境。子智能体共享父容器不显示单独环境选择。
- UI：系统导航“运行环境”，列表与详情，Page骨架/现有控件/单h1；Dockerfile草稿、构建、版本历史/日志/设为线上；专家运行限制内环境选择；连接器试连环境选择。使用TanStack Query，构建时轮询、终态停止。无新编辑器依赖，用现有Textarea。
- 删除：默认环境、被绑定、queued/building时409；不提供逐版本删除，不自动rmi防止影响存活容器。无线上版本/镜像缺失明确报错，不偷偷换环境。

## 基线与范围

工作树 `/Users/xbjt/Documents/myself/agentport/.claude/worktrees/enable-agent-bash`，HEAD `d26ea00536a59e5de77bb1d963a9c35e39839e62`。此任务与Bash解除同一工作树，文件按单一写入者划分；已有文档变更必须保留。主会话不写代码，Sonnet实现，Opus审查。

## 步骤

- [x] 只读探索现有实现及官方Docker构建约定，明确产品缺口。
- [x] 按用户最新决定固定容器存活与镜像缓存语义。
- [x] 按文件边界启动六个 Sonnet 执行单元：DB/shared、构建worker、API、运行接线、UI、专家包/试连API；Bash独立验收与Opus review并行。
- [x] 环境管理 API 单元完成：8 条新API用例通过，与agents合跑2文件35条通过，API typecheck/biome通过。真实构建与会话行为仍待整体验证。
- [x] 构建worker单元完成：16 mock/对账测试通过；真实Docker重复构建1条通过，第二次日志含CACHED。真实验证使用独占临时基座叠加当前sandbox/dist，未覆盖dev，临时标签已清理。
- [x] DB/shared单元完成：0040迁移隔离临时库通过；db/shared30文件191测试通过，环境11测试通过，包级typecheck曾全绿。
- [x] 专家包API名称映射和stdio试连参数已接通：相关4文件74测试、扩展10文件152通过。
- [x] 运行接线：目标6文件100测试通过，真实Docker会话8测试通过；存活容器复用旧身份，新建惰性选择线上。
- [x] UI首轮：web101文件1038测试、typecheck/build通过；删除/导入映射/刷新试连身份正在定点补齐。
- [x] 试连身份收敛正式jsonb列并删除config临时路径与重复safeParse：相关9+28测试通过。
- [x] 构建修复：正式调用verify helper，旧存在性脚本删除；默认基座记录真实imageID；流式日志落库失败不再ready；5文件31测试通过（含真实Docker缓存+4个产物校验，0skip）。
- [x] 真实镜像A/B生命周期：发布B原容器仍A，新会话B，空闲回收后重建B，回退A存活B保持、新会话A；真实Docker inspect+exec marker+lease身份三重核对1测试通过（4.17s），自建容器与派生镜像清理。
- [x] 凭据失败与回滚校验：真实processor+Postgres触发器故障注入，环境UPDATE失败不start且release(false)，API恢复原环境/删除环境拒绝；2文件30测试通过。
- [x] 核对修复后的日志链路：空闲tick后继续日志/收尾回归通过；verify 200k输出限长摘要回归通过；环境相关8文件41测试（含真实Docker）通过。
- [x] 主会话运行17文件226定点回归通过，0失败0跳过；pnpm -r typecheck通过；web build通过，worker构建在中间类型错误修正后重跑通过。
- [x] 真实页面专家绑定持久化仅runtimeEnvironmentId，控件32px；已绑定环境删除返回409且确认框保留。
- [x] 浏览器TaskSpace已finish；独立预览API/web/worker、随机DB、Redis容器全部清理，临时凭据/日志/脚本删除；开发worker/postgres/redis仍原进程未重启。
- [x] 最终Opus定点复核通过：日志同步throw最后修复通过，build15测试0skip；UI四项与运行详情通过，web6文件113+DB2测试通过。所有已报告阻断项均已修复并复核。
- [x] 最终真实Docker主线程复跑：build-cache/verify/lifecycle3文件6测试通过（0skip）；最终pnpm -r typecheck和web build通过。
- [x] 隔离浏览器验收已真实创建「验收环境-层缓存」、构建第一版、发布、重复构建第二版（日志2处CACHED，未自动上线）、发布第二版并回退第一版；镜像运行产物v1存在，安装临时归档不存在。页面h1=1，无横向溢出。实例独立Postgres随机库/Redis/端口3317+5177，没有改共享登录态。
- [x] 真实构建缓存、发布/回退、存活容器/重建行为验证。
- [x] 实测当前 worker 容器 `docker buildx version` 返回 unknown command；根 Dockerfile runtime target 已补构建插件，现有服务未重启。
- [x] Opus独立review、修复与按范围验证。

## 验证策略

构建成功不自动上线；发布和回退只改指针；两个版本可区分；存活容器跨发布保持旧版，消亡后重建用新版；失败构建不改线上且日志可读；构建上下文仅Dockerfile；重复构建复用缓存；最终镜像不含安装包/临时文件；真实SDK Bash及Docker只读边界；API鉴权/绑定/发布/删除约束；UI真实操作与可访问状态。迁移用隔离临时数据库，不改共享开发登录态。

## 独立审查收口（2026-10-29）

Opus 对构建/存储初审暂不通过：镜像声明 `VOLUME /app/dist` 可产生可写运行代码卷（P1），仅exists的产物验证遗漏无效入口/缺依赖（P2），实际基座身份与快照脱节、截断标记丢失、日志仅终态落库、stdout/stderr无限累计（P2）。已拆单一写入修复：verify.ts新增严格产物检查；build/repo整合者负责基座、日志、内存；index/provider整合者负责接口接线与首次远程镜像恢复。修复后需Opus定点复核，不能沿用旧通过记录。

真实SDK初轮10通过使用busybox兼容壳，不是开箱证据；基础镜像补真bash、移除壳并根Dockerfile重建后重跑。独占验收tag `agentport/sandbox:runtime-env-bash-20261029`，不覆盖dev。

## 最终验证记录

- 主会话17文件226测试通过（0失败0跳过），全包typecheck通过；后续故障/运行详情/日志修改再跑6文件53测试通过。
- 真Bash基座根Dockerfile构建成功；SDK10测试无假壳通过；镜像契约7测试通过。
- Docker缓存+verify+DB5文件31测试0skip通过；日志后续修复环境8文件41测试通过。
- 真实A/B容器生命周期通过，详见`runtime-environment-lifecycle-docker.test.ts`；这条不声称验证完整worker进程，实际run凭据另由processor+真实DB故障注入和API详情测试覆盖。
- Web固定最终代码完整回归：**102文件1059测试全部通过**。此前并行负载下2条既有时序失败单独15/15通过；一次串行回归跨UI写入窗口的中间失败也已在最终固定代码回归消除。保留上述排查记录，不以局部通过冒充全量。
- 最终UI及运行详情Opus独立review通过，目标web113+DB2测试通过。
- `pnpm lint:focus`通过。`git diff --check`通过。
- API/worker构建中间曾因正在改的日志变量owned类型失败，修正后worker build通过，最终将再核对。
- 本任务未执行共享开发库迁移或服务重启；迁移在独立临时库验证。本轮用户已授权 commit/push/PR/merge，代码合并到 main 但未部署。隔离浏览器实例已清理。

## 下一步

实现与验证完成，无待执行编码项。本轮已提交到 `worktree-enable-agent-bash` 并创建 PR 合并到 main；只合并代码，未部署、未应用共享开发库迁移、未重启服务。合并前远端 main 已新增 `0040_fuzzy_warstar`，本任务的迁移因此重新生成为单个 `0041_careful_pretty_boy.sql`（内容与原先 0040/0041 等价，已在合并后的随机库上验证）。需要部署时应用 0040+0041 并重建沙盒/API-worker 镜像。验收临时资源与tracked测试报告已清理，独占真实Bash验收基座保留。
