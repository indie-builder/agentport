# 知识库最终独立只读 Review：Web / backup / deployment

结论：**需修复以下 4 项后交付**。按单管理员、自用部署评估。只审 Web 及必要 wire 契约、备份恢复与部署，不重复审查后端业务实现。包括未跟踪的新文件；未修改产品代码、未派代理、未提交。

## 1. P1：未配置 Docling 时整个 worker 无法启动

- 位置：`docker-compose.yml:131`；`packages/worker/src/config.ts:53`。
- 复现：Compose 的 `${DOCLING_URL:-}` 在没有配置时产生 `DOCLING_URL=''`，而 `z.string().url().optional()` 只允许合法 URL 或 undefined。实际运行 `pnpm --filter @agentport/worker exec tsx -e 'import {loadConfig} from "./src/config.ts";loadConfig({DATABASE_URL:"postgres://local/test",APP_SECRET_KEY:"x".repeat(32),DOCLING_URL:""});'` 得到 `Invalid environment: DOCLING_URL: Invalid URL`，非零退出。
- 影响：本应可选的 Docling 配置阻止全部 worker 任务启动，包括聊天任务。
- 最小修法：在 worker 配置入口把空字符串预处理成 undefined，再做 URL 校验；补空值配置测试。保持复杂格式任务在真正调用时明确报缺配置。

## 2. P1：文件换入中途失败，回滚把旧目录嵌进新目录

- 位置：`scripts/backup-lib.sh:255`（回滚）及 `:274`（开始换入）；工作区和知识库都共用 `ws_swap_script`。
- 复现：目标已有 `blobs/old` 与 `docs/old`，归档有 `blobs/new` 与 `docs/new`。以 PATH 中的 mv 替身只让 `.restore-staging-*/docs` 的搬入失败，其余调用真实 `/bin/mv`。实际退出 1 并打印 `workspace swap failed: aborted`；结果为 `docs/old`、`blobs/new`、`blobs/blobs/old`，原 `blobs/old` 不存在。
- 原因：已成功换入的 `ROOT/blobs` 仍存在，回滚的 `mv "$old" "$ROOT/${old##*/}"` 会把旧 blobs 搬入新 blobs 内部，然后删除 holding。
- 影响：失败后旧知识文件没有回到 DB 引用的原路径，回滚承诺失效，需要从安全归档手工恢复。
- 最小修法：记录已换入的顶层目录，失败时先撤掉这些新目录，再把 holding 中旧目录搬回；回搬失败时保留 holding 并报路径。补“第一个目录换入成功、第二个失败”的测试，不能仅测复制阶段失败。

## 3. P2：Wiki 编辑没有发送后端提供的过期版本条件

- 位置：`packages/web/src/pages/knowledge-detail.tsx:2176`；`packages/web/src/lib/api.ts:1013`。后端已有契约：`packages/api/src/features/knowledge/wiki-routes.ts:28`、`:152`。
- 复现：两个窗口打开同一已发布页面 v1。A 保存新内容成为 v2；B 保留旧正文并保存。B 的 PATCH 只有 `{markdown}`，没有打开编辑器时的 `expectedVersion`，后端因此跳过版本条件，B 可以把基于旧正文的修改直接设成新的当前内容。
- 影响：真实过期编辑不会出现 409 冲突，用户可能覆盖刚发布的内容；历史版本仍保留。
- 最小修法：打开编辑器时固定捕获 currentVersionId，贯通 dialog props、API patch 类型并发送 `expectedVersion`；409 时保留草稿并提示重新加载。不要在保存时改取最新 versionId。

## 4. P2：来源和 Wiki 列表丢弃 nextCursor，超过首屏的数据无法选择

- 位置：`packages/web/src/lib/queries.ts:1188`、`:1257`；`packages/web/src/pages/knowledge-detail.tsx:1883`。
- 复现：建立超过接口默认页大小的来源或 Wiki 页面。两个 hook 都只调用一次列表接口，并用 `select: (page) => page.items` 丢弃 nextCursor；调用页面没有后续加载入口。较旧的来源无法从页面编辑或同步，较旧 Wiki 无法从列表选中。
- 影响：后端仍有数据，Web 却永久只显示第一页，和已正确分页的文档/chunk/知识库列表行为不同。
- 最小修法：沿用文档列表的 useInfiniteQuery 和加载更多入口；或对这两个小型集合沿用知识库列表自动取后续页及显式重试的模式。保留游标，不需要新增分页协议。

## 已核对及验证

- `pnpm exec vitest run packages/worker/test/config.test.ts packages/worker/test/backup-script.test.ts packages/web/test/knowledge-management.test.ts packages/web/test/knowledge-citations.test.ts packages/web/test/expert-knowledge-binding.test.ts --reporter=dot`：**5 文件、76 测试通过**，耗时 65.50s。以上启动失败和中途换入失败为额外真实执行，现有测试没有拦住。
- 第四个资源 tab 已进入共享 ResourcePage；知识库页沿用共享页面骨架。来源编辑密钥初值为空、留空不发送 secrets；发布操作已发送选定 versionId。人工重解析确认后明确发送 `confirmOverwriteManualChunks: true`。
- 当前源码已补手写内容、URL、知识包导入导出和指定版本发布，不把实施过程中的暂时空缺列成问题。聊天引用保留原始版本 ID，错误显示与原件接口分别走鉴权请求；未把历史引用仍可由管理员读取误判成绑定专家的授权绕过。
- 备份知识目录有 host/exec/run 分支；缺失/空目录写 knowledge:null；读取失败会终止。Compose 使用 pgvector manifest digest，PG18 卷挂 `/var/lib/postgresql`，init 对工作区与知识卷设置 uid 1000；Dockerfile 以 node 运行。未在本轮重新拉镜像核验 digest。
- 采用用户提供的 3305 浏览器验收事实（上传检索、Feed 二次同步及实际标题修复），本轮未重复浏览器操作。没有真实企业外网凭证，不把未跑真实企业来源当作代码缺陷。

未检查：其他 reviewer 负责的后台业务、真实飞书/GitLab 凭证链路、完整容器构建及生产恢复演练。风险：本结论针对并行交付中的源码快照，后续修复需重新核对上述 4 个入口。
