# 技术栈实践审查问题实施

## 目标与状态

完成用户授权的 13 项修复与优化，用本任务独立 PostgreSQL/Redis 验证真实行为，并保留前序技能安装差异。按文件域并行实施，主会话整合验证后交独立审查；用户已授权 commit / push / PR / merge。

当前状态：**13 项实现、回归、独立审查和范围内页面验收完成，验证环境已清理；用户已授权 commit / push / PR / merge，本次授权提交 PR 合并，结果以 PR 合并状态为准**。13 项全部实现并通过审查：知识库 API/DB 5 项、chat、plugin、Wiki（2 项阻断修复后定点复验）、专家 rootwatch（收窄后独立 Opus 验收）、worker 4 项（两项阻断修复后独立 Opus 定点复核通过，无新增阻断）。最后两处补丁为对账两分支改用 `Promise.allSettled`、`close-wait` 在 `finally` 清理超时定时器。真实 BullMQ 重建 503、sync 503 自动重试、挂起上游 abort 均实测通过。最终代码完整隔离回归 2069 用例通过 / 0 失败 / 11 跳过，两组跳过套件随后单独 11/11 通过；对账与退出定向回归 27 项通过。范围内真实浏览器验收通过：专家预览/保存重载、Wiki 详情刷新故障保草稿、插件悬停预取一次且点击不重复；临时 API、浏览器、临时库及任务已清理。

最终复验：全 web 64 文件 680 用例通过；全仓 typecheck 通过；full build 早前通过，最后两处 worker 补丁后 worker 构建重跑通过；focus / contract 通过；生产与测试 29 文件错误级 Biome 通过，末轮 4 文件复检通过（仓库既有 noNonNull 警告仍在，不声称全 warning 0）。最终代码完整隔离回归 `.tmp/stack-final-tests.json` 为 success、2069 用例通过 / 0 失败 / 11 跳过；跳过的两组套件随后单独 11/11 通过。**未做**：整体进程真实 SIGTERM、真实模型性能测量，无量化倍数。

验收标准：

- 13 项审查问题逐项有实现、测试或明确未完成项，不以「应该能跑」代替结果。
- 验证使用本任务独立 PG 18 + pgvector、Redis 8，不启停主栈、不改 `.env`、不动其他任务进程。
- 不新增依赖或迁移；`package.json` / `pnpm-lock.yaml` / `.env` / compose / 前序技能安装内容不变。
- 用户已授权 commit / push / PR / merge；本次授权提交 PR 合并，结果以 PR 合并状态为准。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/install-stack-best-practice-skills`
- 开工 HEAD：`efcf71c802560b472a96ad54a472e088cd4c8738`（`worktree-install-stack-best-practice-skills`）
- 开工未提交差异**全部归属前序任务** `install-stack-best-practice-skills`（该任务记录为「验证完成、未提交」）：
  - `docs/SKILLS.md`、`skills-lock.json` 修改；
  - `.agents/skills/` 11 个新增技能目录、`.claude/skills/` 11 个相对链接；
  - `docs/tasks/install-stack-best-practice-skills.md` 未跟踪。
  - **本任务不修改、不提交、不还原上述文件**；旧技能验证仍为 25 条一致、旧 188 文件未变。
- 允许改动：本记录、API/DB 知识库目录/检索/分块读取、worker 退出/代理/知识摄取/对账及测试、前端聊天/Wiki/查询/插件路由/专家预览及测试；`.tmp/` 仅放本任务临时验证工具。
- 保持不变：`package.json` / `pnpm-lock.yaml`、`.env`、compose、既有技能安装内容；不引入新框架、迁移或依赖。
- 主 checkout 只读；其他 worktree 只读。

## 当前有效决定

- 13 项按五个文件域并行：聊天/Wiki/路由、专家表单、知识库 API/DB、worker 退出/模型代理、知识重试/对账测试。共享接口先固定，互不覆盖文件。
- 现有未提交技能安装必须保留。
- 禁止启停主栈、修改 `.env`、修改管理员密码、kill 其他进程；端口冲突只换本任务随机端口。
- 各域先补失败回归，再实现最小修复；数据库查询变更验证全部调用方，worker 关闭与模型代理取消附实际测试。
- 按变更范围整合 typecheck、构建、测试与独立审查，不固定跑全套。

## 共享契约

- API/DB：`updateFolder(db, id, { name?, parentId? })`、`countEditedChunks(db, versionId)`、显式裁列的 `listChunkSummaries(db, versionId, options?)`；改名/移动同一事务，子树只重写一次。
- `listChunks` 完整返回契约保留，worker `reembedMissing` 仍能读取 embedding；API 展示、存在检查与包导出改用摘要投影。
- 知识队列 `close(): Promise<void>` 与错误分类器签名不变；关闭先停止领取并 abort 活跃任务，整段有界，保证沙盒清理可达。重试重抛原临时错误，终态由队列负责。
- 对账测试各自建唯一临时库并迁移，连接成功后的迁移/权限失败不能 skip；不改生产对账算法、不清理他人 Redis 键。
- 前端复用现有 QueryClient/查询键；Wiki 任务终态刷新当前页与列表，不重挂组件丢草稿；专家预览展开才订阅与渲染工作区。

## 13 项实施记录

| # | 问题 | 实现要点 | 验证 / 证据 | 状态 |
|---|---|---|---|---|
| 1 | 测试对账 DB 隔离 | 新增 `packages/worker/test/isolated-db.ts`：随机库、迁移、库身份校验、关闭即删；reconcile 两个套件与 `knowledge-ingestion` 共用；连不上才 skip，连上后迁移/身份失败直接抛 | 本轮 worker 7 文件 58 用例通过、0 skip（含 reconcile 与 ingestion；补丁前结果） | 已实现，独立 Opus 定点复核通过 |
| 2 | 文件夹 LIKE / Unicode | `escapeLike` 转义 `% _ \`；子树路径截断改用 PG `char_length`，避免 JS UTF-16 把 emoji 多算一位 | API routes 用例覆盖通配符、反斜杠、emoji 与相邻子树 | 已实现，审查通过 |
| 3 | 文件夹 PATCH 事务 | 合并为 `updateFolder` 单事务，按最终 parent/name 一次写 path；同级冲突由唯一约束回滚整棵子树 | API routes 同时改名+移动冲突 409，路径保持原位 | 已实现，审查通过 |
| 4 | reprocess 手工保护 >200 | `countEditedChunks` 整版聚合替代首页 200 条采样，人工块在分页外也触发确认 | API routes 插入 250 块、仅第 250 块人工编辑仍返回 409；确认后 202 | 已实现，审查通过 |
| 5 | 移动文档检索归属 | 检索所属过滤从 `c.folder_id` 改为 `d.folder_id`，不再读分块写入时的旧快照 | retrieval 移动文档后在原文件夹不召回、新文件夹召回 | 已实现，审查通过 |
| 6 | worker 关闭知识任务 | `knowledgeWorker.close()` 先停止领取并 abort 活跃任务；SIGTERM 中断退回 `queued` 交 BullMQ 重试；shutdown 并发启动所有关闭，聊天 run 10s、其余 5s 有界，沙盒不排在知识任务硬超时后；新增 `close-wait` helper，`waitClose` 返回 bool，DB 用户未全部结束时不再 `pool.end`，超时直接退出由进程回收连接 | knowledge-queue：close < 5s、任务回 queued、close 后不再领取、挂起请求收到关闭即结束；close-wait 3 用例，`finally` 清理超时定时器 | 已实现，独立 Opus 定点复核通过 |
| 7 | chat 后台错保内容 | 有已加载内容时不再因 `error` 隐藏历史；整页错误只在无内容可保留时显示 | chat-ux 3 用例：后台刷新失败、加载更早失败、无内容整页错误 | 已实现，审查通过 |
| 8 | Wiki 完成缓存 | 只跟踪本次提交返回的 jobId；任务跨终态时失效当前页与列表一次，轮询不重复失效；已有页面数据时刷新失败只做局部报错，不卸载编辑器 | knowledge-management 用例覆盖任务跟踪、终态刷新、失败保留草稿、重试恢复；2 项阻断（提交后 jobs 未失效、后台 detail 错误卸载草稿）修复后定点复验通过 | 已实现，审查通过 |
| 9 | 模型代理取消 | 客户端断开时 abort 上游 fetch 并 cancel reader；响应已结束时不再写二次错误 | model-proxy 2 用例：中途断连触发上游取消、正常连接完整流式返回 | 已实现，独立 Opus 定点复核通过 |
| 10 | 知识临时错重试 | `runReindex` / `runSync` 对可重试模型/解析错误重抛原类型，交队列现有分类器重试；永久错误继续汇总；ingestion 异常终态统一由 `queue.finish` 落库 | ingestion 原错误类型保留、sync 重试不重复建版本用例已过；真实 BullMQ 503 重试 run 保持 running（`endedAt` 为 null）后最终 succeeded，重建与 sync 均实测自动重试通过 | 已实现并真实回归通过；独立 Opus 定点复核通过 |
| 11 | 专家按需预览 | 折叠时不生成 workspace；展开后 `useWatch` 按当前表单值生成，收起后停止订阅；根级订阅收窄为显式字段列表 | agents-preview 5 用例：折叠不调用 renderWorkspace、展开实时更新、收起后不再生成；收窄后无关 Field 连续输入增量为 0，仅 dirty/errors 触发合理根渲染；独立 Opus 验收通过 | 已实现，审查通过 |
| 12 | 分块读裁列 | 新增 `listChunkSummaries` 显式投影展示字段；`listChunks` 保留完整行供 worker；API 列表、重新启用检查与包导出改用摘要 | API routes 响应无 `embedding` 且字段集合精确；db `knowledge-chunks` 2 用例含列级权限读取 | 已实现，审查通过 |
| 13 | plugin 路由预取 | route loader 经共享 QueryClient 预取，失败 `catch(noop)` 留给页面查询态；根路由设 `defaultPreloadStaleTime: 0` 由 Query 管新鲜度 | plugin-route-prefetch 3 用例：预取复用缓存不重复请求、失败落页面错误态、根路由配置生效 | 已实现，审查通过 |

### 主要改动文件

- API：`packages/api/src/features/knowledge/{routes,retrieval,package}.ts`；`packages/api/test/{knowledge-routes,knowledge-retrieval}.test.ts`。
- DB：`packages/db/src/repo/knowledge.ts`；新增 `packages/db/test/knowledge-chunks.test.ts`。
- Worker：`packages/worker/src/{index.ts,model-proxy.ts,close-wait.ts,reconcile.ts,knowledge/{queue,ingestion}.ts}`；`packages/worker/test/{knowledge-queue,knowledge-ingestion,reconcile-queue-redis,reconcile-eval-redis,close-wait}.test.ts`；新增 `packages/worker/test/{isolated-db.ts,model-proxy.test.ts,reconcile-shutdown.test.ts}`。`reconcile.ts` 与 `reconcile-shutdown.test.ts` 为本轮新增范围。
- Web：`packages/web/src/{router.tsx,lib/queries.ts,pages/{agents,chat,knowledge-detail}.tsx,routes/_shell/plugins.$pluginId.tsx}`；`packages/web/test/{chat-ux,knowledge-management}.test.ts`；新增 `packages/web/test/{agents-preview-on-demand,plugin-route-prefetch}.test.ts`。
- 本记录与 `.tmp/isolated-stack.mjs`（一次性验证工具，不提交业务含义）。

## 审查状态

- 13 项全部实现并审查通过。
- 知识库 5 项（2、3、4、5、12）API/DB 源码审查通过；对应回归已有真实结果。
- 前端：chat（7）、plugin（13）审查通过；Wiki（8）2 项阻断修复后定点通过；专家 rootwatch（11）收窄后独立 Opus 验收通过，5 用例通过，无关 Field 连续输入增量为 0。
- worker 域（1、6、9、10）：两项阻断修复并回归后，独立 Opus 定点复核通过，无新增阻断。最后两处补丁为对账两分支 `Promise.allSettled`、`close-wait` 在 `finally` 清理超时定时器；补丁后 2 文件 4 用例通过。
- 重试（10）：原错误保留通过；真实 BullMQ 503 重试保持 running 后 succeeded、重建自动重试均实测通过；挂起上游 abort 通过。
- 阶段红已关闭：首轮 6 个 sync 测试红已修，最终定向与全量回归 0 失败。
- `docs/PITFALLS.md` 未改：本次隔离与迁移教训已有「固定日期数据库会绕过外层隔离与新迁移」条目覆盖，无新增可复用教训。

## 验证（最终复验）

以下为最终真实结果；测试均经 `.tmp/isolated-stack.mjs run` 指向本任务独立 PG/Redis。即使外层 shell 已注入默认 `DATABASE_URL`，该连接串不作为本任务结果依据。

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 全 workspace 通过 |
| `pnpm build` | full build 早前通过；最后两处 worker 补丁后 worker 构建重跑通过 |
| `pnpm lint:focus` / `pnpm lint:contract` | 均通过 |
| `node .tmp/isolated-stack.mjs run -- pnpm test:web` | 64 文件 680 用例通过 |
| 完整隔离回归 JSON | `node .tmp/isolated-stack.mjs run -- pnpm exec vitest run --reporter=json --outputFile=.tmp/stack-final-tests.json`：最终代码 239 文件、2069 用例通过 / 0 失败 / 11 跳过；跳过定位为 `agent-tools-cancel-signal.test.ts` 与 `failure-paths.test.ts`，随后单独 11/11 通过。补丁前一轮曾为 2079/2079，通过口径不混用 |
| 补丁后 worker 定向回归 | 2 文件 4 用例通过（`reconcile-shutdown` 1、`close-wait` 3） |
| 真实 DB/Redis 对账（worker reconcile 6 文件） | 27 用例通过 |
| `pnpm -C packages/api exec vitest run test/knowledge-routes.test.ts test/knowledge-content-routes.test.ts test/knowledge-retrieval.test.ts test/knowledge-package.test.ts` | 4 文件 47 用例通过 |
| `pnpm -C packages/db exec vitest run test/knowledge-chunks.test.ts` | 2 用例通过 |
| 生产 + test 29 文件错误级 Biome | 通过；末轮 4 文件复检通过（既有 noNonNull 警告不计入） |
| 真实运行行为 | BullMQ 重建 503、sync 503 自动重试、挂起上游 abort 均通过 |
| `node /tmp/stack-skills-final-verification.*/check.mjs <worktree> <baseline>` | 25 条一致、旧 188 文件未变，通过；前序记录未动 |

未覆盖 / 不声称：

- 最终代码完整回归为 2069 通过、11 跳过、0 失败；两组跳过套件随后单独 11/11 通过，见上表。
- 页面验收：API 源码 + 生产静态产物运行于 `http://127.0.0.1:3341`，配置仅为 `.tmp/ui-accept/start-api.mjs` 与已删除的 runtime 文件；独立临时库隔离于回归库。专家预览/保存重载、Wiki 故障保草稿、插件预取均通过；截图在 `.tmp/ui-accept/shots/`。Wiki 使用临时库任务终态加浏览器故障注入，未运行真实生成；chat 错误路径仅有 jsdom 回归。
- 浏览器观察到保存成功后工具栏短暂保持未保存文案，刷新后为已保存且值已持久化；非阻断，未纳入本轮修复。
- 未做整体进程真实 SIGTERM 验证、未测真实模型性能，无量化倍数。
- Biome 为错误级；仓库既有 noNonNull 警告仍在，不声称全 warning 0。

## 独立基础设施与清理

- 本任务容器 `pace-stack-improvements-pg` 与 `pace-stack-improvements-redis`、命名卷 `pace-stack-improvements-pgdata` / `pace-stack-improvements-redisdata` 已通过 `node .tmp/isolated-stack.mjs cleanup` 删除，`status` 确认为 absent。浏览器验收 API、临时库及其两条任务已先行清理；主栈和其他任务服务未操作。
- 迁移只在本任务独立库执行，仓库无新增迁移；未启停主栈，未修改 `.env` / compose，未读取或清理其他任务隔离栈。
- 验证统一用 `node .tmp/isolated-stack.mjs run -- <命令>` 注入独立连接串。
- 环境不再需要时执行 `node .tmp/isolated-stack.mjs cleanup`，只删除本任务容器与命名卷；`status` 可先确认归属。

## 步骤

- [x] 固定共享契约，按五域并行实施 13 项
- [x] API/DB 5 项实现与回归
- [x] worker 4 项实现与回归
- [x] 前端 4 项实现与回归
- [x] 独立 PG/Redis 上跑 typecheck、构建与范围内测试
- [x] 知识库 5 项源码审查
- [x] chat / plugin 审查
- [x] Wiki 2 项阻断修复与定点复验
- [x] 专家 rootwatch 收窄与独立 Opus 验收
- [x] 前端最终全量复验（64 文件 680 用例）
- [x] 真实 BullMQ 503→success 与重建自动重试回归
- [x] worker 独立 Opus 定点复核（最后两处补丁）通过
- [x] 页面验收（独立浏览器会话，含浏览器截图）
- [x] 清理本任务独立栈

## 下一步

无待执行项。用户已授权 commit / push / PR / merge；本次授权提交 PR 合并，结果以 PR 合并状态为准。主 checkout 保持不动。
