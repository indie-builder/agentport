# 知识库来源同步与 GitHub 接入

## 目标

1. 知识库列表的整张卡片可进入已有详情；详情内的上传文件入口清晰可用。视觉参考 Qoder 知识库的布局与操作层级，但颜色、间距、圆角、字体等全部沿用 PACE 令牌，不复制 Qoder 品牌色。
2. 知识库详情的来源支持 GitHub、GitLab、飞书各自的完整配置操作流：来源类型、连接凭证、同步范围、同步计划、远端删除策略、创建与编辑、立即同步、同步记录、错误状态都能在现有来源面板内完成。
3. 补齐 GitHub 仓库文本文件同步端到端：配置、抓取、入库、更新、删除传播、运行记录与错误状态全部走现有管线。

验收以真实页面与真实 API 行为为准；本地 fixture 只能证明连接器契约，不能代替真实 GitHub 授权、限流与仓库内容验收。

## 方案

沿用现有 `knowledge_sources` / `knowledge_source_ranges` / `knowledge_sync_runs`、`knowledge-jobs` 队列、`encryptSecrets` 凭证加密和既有摄取/解析/索引管线，不新建第二套来源机制。

### 实施结果

- 数据库与共享契约已加入 `github`、`github_repo`，迁移 `0040_fuzzy_warstar.sql` 替换三个 CHECK；`knowledgeSourceTypeSchema` 与 `knowledgeSourceInputSchema` 同步。
- worker 已注册 `github` 连接器：读取仓库元数据与默认分支，递归树枚举，按文本扩展名与 `paths` 过滤，读取 blob 正文，生成稳定 externalId 与 `sourceUrl`。
- API 的创建、PATCH（含仅修改 ranges）与 `/test` 统一走 `configIssues`：GitHub 校验 `token`、`owner/repo`、可空 `ref` 与可选 `baseUrl`，非 `github_repo` 的范围和非法 `owner/repo` 在入口拒绝；`paths` 相对性仍由 worker 读取时校验。
- 来源 UI 改为「选择 provider → 配置」两步，创建与编辑共用分区表单；支持多条范围增删与启停、创建时配置 cron 与 `syncDeletions`，编辑时类型只读。
- 知识库列表整卡可点击进入详情，操作菜单浮在覆盖层之上；文档工具栏以上传文件为主操作，其余导入收进次级下拉。
- 相关文档已同步：`docs/ARCHITECTURE.md` §6.3、`docs/DECISIONS-PENDING.md` D-9、`docs/DESIGN-SYSTEM.md`、`docs/tasks/weknora-core-proposal.md` 的 GitHub 表述。

### GitHub 来源契约

- 类型：`knowledge_sources.type = 'github'`；文档 `source_type = 'github'`；范围 `kind = 'github_repo'`。
- 凭证：PAT，存 `secrets.token`，与 GitLab 的 `token` 同一加密列与只写不读规则；不新增 OAuth 服务。
- 范围：每个范围是一条仓库范围，`externalId = owner/repo`，`ref` 可为空（worker 回落到仓库 `default_branch`），`paths` 为仓库相对目录/文件前缀。
- 连接：`config.baseUrl` 可选，缺省 `https://api.github.com`；GitHub Enterprise 填 API 根（如 `https://ghe.example.com/api/v3`）。地址仍走现有 `validateSourceUrl` 与 `KNOWLEDGE_PRIVATE_HOST_ALLOWLIST`，不为 GitHub 放宽 SSRF 规则。
- 内容：只读取现有 `TEXT_EXTENSIONS` 文本类扩展名；PDF/Office 等二进制不在本轮同步范围。空文件仍要覆盖旧正文，沿用 GitLab 的占位处理。
- 身份：外部稳定 ID 形如 `github:<apiBase>:<repoId>:<ref>:<path>`，`sourceUrl` 指向仓库 blob 页面；文档只按 `(base_id, source_type, source_id)` 匹配，绝不用标题。
- 完整性：递归树读取失败或 `truncated: true` 必须抛错，不能把部分枚举当成完整枚举；只有完整枚举且本轮无单项失败时，`syncDeletions: true` 才允许推导远端删除。
- 错误分类：401、以及明确无权限的 403 归为 `SourceAuthError`；GitHub 限流也可能返回 403/429，必须结合 `x-ratelimit-remaining` / `retry-after` 等响应头区分，不能把限流误判成凭证失效并停用来源文档。
- 来源检查仍只校验本地配置与已存凭证，不发外网请求；真实连通性以「立即同步」产生的 run 结果为准。UI 文案继续使用「检查配置」，toast 明确「本地配置与已存凭证检查通过」。

### 来源编辑体验

- 来源类型使用显式 provider 选项：新建时先选类型再进入配置；编辑时直接进入配置并只读展示类型。
- 创建与编辑共用同一套分区表单：连接（类型、名称、Base URL、凭证）、同步范围（按类型显示仓库/空间/目录/Feed 字段，支持多条范围、启停、增删）、计划与删除（cron（UTC）、`syncDeletions`）。不再让创建与编辑两套字段漂移。
- 现有字段含义与校验保留：飞书 `appId`/`appSecret` + Wiki 空间/节点或云盘目录；GitLab `baseUrl` + `token` + 项目/ref/paths；GitHub 可选 API Base URL + PAT + owner/repo/ref/paths；Feed 只保留订阅地址并解释不提供删除传播。
- 立即同步要求来源为 `active`；已有 queued/running 同步任务时返回 409。该检查是非事务检查，与定时触发并发时仍可能各建一条；严格串行需复用 scheduler 的 advisory lock。
- 立即同步、同步记录、来源状态、`lastError`、run 错误继续使用现有接口；展开来源时才请求 runs 的行为不变。

### 列表与上传

- 列表卡使用覆盖整卡的详情链接；操作菜单提升层级并阻止点击冒泡，点菜单不能跳转。链接保留可访问名称，不出现嵌套交互元素。
- 文档页工具栏把「上传文件」提升为主按钮；「上传文件夹 / 手写文档 / 导入网址」收进相邻的次级下拉。上传进度、单文件 32 MB 限制、逐项失败提示与空状态入口沿用现有逻辑。
- 详情页仍使用现有文件夹侧栏、文档表格与查看器；不复制 Qoder 的独立阅读器布局，也不为移动端增加断点。

## 基线与范围

- 基线 commit：`d26ea00536a59e5de77bb1d963a9c35e39839e62`（main）。
- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-sync-details`。
- 本任务改动只落在该 worktree；代码、测试与文档改动尚未提交、推送或合并。
- 本任务范围：GitHub 适配、schema CHECK 迁移、前后端来源 UI、详情入口与上传、相关文档与测试。未顺手改知识检索、多模态、专家绑定或其他来源行为。

## 当前有效决定

- 沿用现有来源表、范围表、同步 run、队列、加密与摄取管线，不新建第二套来源机制。
- GitHub 使用 PAT，凭证键与 GitLab 一致为 `token`；范围使用仓库 `owner/repo` + 可选 `ref` + `paths`，仅文本文件，`config.baseUrl` 可选并支持 GitHub Enterprise。
- GitLab 继续使用现有 `token` 与 `baseUrl`；飞书保留知识库（Wiki）与云盘两种来源，使用 `appId`/`appSecret` + 范围。
- 不新增 OAuth 服务，不同步 issue/PR/讨论区，不把「GitHub 同步」扩成代码托管全能力。
- 来源检查仍只校验本地配置与已存凭证；UI 必须把这一点说清楚，真实连通性由立即同步与 run 结果体现。
- 列表整卡点击不能吞掉操作菜单；上传入口要清晰，但不改变现有上传限制与失败提示。
- 不复制 Qoder 品牌色，所有视觉沿用 PACE `styles.css` 的 `@theme` 令牌与 `docs/DESIGN-SYSTEM.md`。
- GitHub 401/无权限 403 标记 `auth_error`；403 限流（`x-ratelimit-remaining: 0` 或 `retry-after`）与 429 不标记，来源保持 active。
- 创建、PATCH（含仅 ranges）与 `/test` 共用 `configIssues`；GitHub 范围必须是合法 `owner/repo`，非法 kind/范围在入口拒绝，`paths` 相对性由 worker 校验。
- 手动同步的 queued/running 检查是非事务检查；与定时触发并发时仍可能各建一条，严格串行需复用 scheduler 的 advisory lock。

## 已替代项及原因

- **旧文档「编辑对话框保留原有范围但暂不提供增删改」**：当前创建与编辑都支持范围增删、启停和多条范围，`docs/ARCHITECTURE.md` §6.3 已按实际实现同步。
- **旧文档「前端新建来源时只提交一条范围」**：当前创建表单可添加多条范围，文档已同步。
- **旧事实「GitHub 完全未实现」**：GitHub schema、worker 连接器、API 校验、来源 UI 与 fixture 测试均已实现；真实 GitHub 授权、限流与私有仓库仍未验收，不能据此宣称生产可用。
- **旧做法「来源类型用通用 Select、字段挤在单弹窗」**：已改为显式 provider 两步流程与分区表单，原因是各来源字段差异大、创建时缺少计划/删除策略。
- **不采用新增 GitHub SDK / Octokit**：现有 worker 已有 `fetchChecked`、`fetchJson`、`fetchText`、`readCapped`、`validateSourceUrl` 与文本扩展过滤，直接复用；不为一个连接器新增依赖。
- **不采用 GitHub OAuth、issue/PR 同步、独立来源表或独立队列**：超出本轮目标，且会形成第二套授权/同步语义。

## 步骤

- [x] 固化契约：在 shared schema 与数据库 enum/check 中加入 `github`、`github_repo`；迁移 `0040_fuzzy_warstar.sql` 替换三个 CHECK。
- [x] 实现 GitHub 连接器：读取仓库元数据与默认分支，递归树读取，`truncated` 直接失败，按文本扩展名与 paths 过滤，读取文件正文，生成稳定 externalId/sourceUrl；注册到 `knowledgeConnectors`。
- [x] 完成错误分类：401/无权限 403 标记 `SourceAuthError`；403 限流与 429 不当成凭证失效。
- [x] 补 API 契约：创建、PATCH（含仅修改 ranges）与 `/test` 共用 `configIssues`；GitHub 校验 `token`、`owner/repo`、可空 `ref` 与可选 `baseUrl`，并拒绝非 `github_repo` 的范围与非法 `owner/repo`；`paths` 相对性由 worker 校验。
- [x] 改来源 UI：provider 两步流程、分区表单、GitHub 字段、创建时计划与删除策略、编辑时类型只读；保留现有 GitLab/飞书/Feed 行为与立即同步、runs、错误状态。
- [x] 改列表与上传：整卡链接加操作菜单层级隔离；文档页「上传文件」主按钮 + 次级导入菜单；更新可访问名称与 e2e 定位器。
- [x] 补测试：shared schema、API source routes、worker GitHub fixture、connector range 映射、Web 列表整卡/来源编辑器/上传入口。真实 GitHub 人工或受控集成验收仍未执行，不以 fixture 冒充。
- [x] 同步文档：更新 `docs/ARCHITECTURE.md` §6.3、`docs/DECISIONS-PENDING.md` D-9、`docs/DESIGN-SYSTEM.md`。
- [x] 同步 `docs/tasks/weknora-core-proposal.md` 中「当前代码没有 GitHub 来源适配」的表述。
- [x] 验证与收尾：单元/后端/typecheck/build/lint 与隔离环境浏览器验证已真实执行；E2E 与真实 GitHub 验收仍未执行；未获授权不 commit/push/merge。

## 改动文件

本任务实际改动（均未提交）：

- 文档：`docs/ARCHITECTURE.md`、`docs/DECISIONS-PENDING.md`、`docs/DESIGN-SYSTEM.md`、`docs/tasks/weknora-core-proposal.md`、`docs/tasks/knowledge-sync-details.md`。
- 数据库：`packages/db/src/schema.ts`、`packages/db/migrations/0040_fuzzy_warstar.sql`（新增）、`packages/db/migrations/meta/0040_snapshot.json`（新增）、`packages/db/migrations/meta/_journal.json`。
- 共享契约：`packages/shared/src/knowledge.ts`。
- API：`packages/api/src/features/knowledge/source-routes.ts`、`packages/api/test/knowledge-source-routes.test.ts`。
- worker：`packages/worker/src/knowledge/sources.ts`、`packages/worker/src/knowledge/connector-adapter.ts`、`packages/worker/test/knowledge-sources.test.ts`、`packages/worker/test/knowledge-connector.test.ts`。
- Web：`packages/web/src/lib/api.ts`、`packages/web/src/pages/knowledge.tsx`、`packages/web/src/pages/knowledge-detail.tsx`、`packages/web/test/knowledge-management.test.ts`。
- E2E：`tests/knowledge.e2e.ts`、`tests/knowledge-multimodal.e2e.ts`。

## 下一步

- 用最小 `contents:read` PAT 做真实 GitHub/GHE 受控验收：首次同步、内容更新、空文件、paths 过滤、远端删除、401/无权限 403、限流 403/429、GitHub Enterprise API base；不得使用未经授权的企业数据。
- 在可用的 3305 联调实例上运行 `tests/knowledge.e2e.ts`（`E2E_APP_URL`、`E2E_KNOWLEDGE_SEED=1`）。
- 目标共享开发库已执行 `pnpm db:migrate`，并核对三个 CHECK 含 `github`/`github_repo`；隔离测试库同样通过迁移。
- 未授权 commit/push/merge，保持未提交差异交付；是否提交等用户明确授权。

## 验证

### 已真实执行

- `pnpm test:web`：100 个测试文件、1043 条测试通过。
- 后端 4 个测试文件、93 条测试通过：API source routes、worker sources、worker connector、worker ingestion。
- `pnpm typecheck`：所有包通过；web / api / worker / shared build 通过；`lint:focus`、`lint:contract` 通过。
- 隔离 PostgreSQL/Redis 上以真实浏览器（3012）验证：点击列表卡片的描述区进入详情；上传文件产生 `pending` 文档；来源页显示 GitHub / GitLab / 飞书；GitHub 来源表单宽 760px；切换 provider 清空凭证；通过 UI 成功创建 GitHub 来源并出现在列表。

### 未执行

- `tests/knowledge.e2e.ts`：未运行，当前没有 3305 联调实例。
- 真实 GitHub/GHE 授权、限流与私有仓库内容：未验收；fixture 只证明连接器契约。
- 目标共享开发库迁移：已执行 `pnpm db:migrate`，三个 CHECK 均含 `github`/`github_repo`；隔离测试库同样通过迁移。

## 风险

- 真实外网未验收：PAT 授权、限流响应、私有仓库与企业 API 根均只有本地 fixture 证据。
- `tests/knowledge.e2e.ts` 未运行：整卡点击、上传主操作与来源两步流程缺少该套 E2E 证据（3012 浏览器手测已覆盖列出的路径，但不能替代 E2E）。
- GitHub 递归树 `truncated` 时直接失败；截断发生在按 `paths` 过滤之前，缩小 `paths` 不能避免，需要换更小的仓库范围或另选同步方式。
- 手动同步的 queued/running 检查非事务，定时触发并发下仍可能各建一条同步任务；严格串行需复用 scheduler 的 advisory lock。
- GitHub 404 不区分仓库不存在与失去访问，旧文档保留并可继续检索。
