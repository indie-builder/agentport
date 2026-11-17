# Wren 数据语义层集成

> 状态：M0–M6 全部交付；M6 为文档同步与验收记录收尾。本文定义 PACE 集成 WrenAI 的设计契约、交付状态与验收证据。M0 的 GO 只表示执行期按 session properties 强制生效，不代表生产安全或业务验收已经完成；各里程碑的实际验收范围见第 6 节。

## 1. 定位与范围

WrenAI 是开源 GenBI 引擎：用 MDL（models、metrics、relationships）表达语义层，把业务问题转成受治理的 SQL，并在 22+ 数据源上执行（上游 README，2026-11）。

PACE 现有 `knowledge` 是文档 RAG：上传、解析、分块、检索与引用，不覆盖结构化数据。Wren 集成的定位是补「结构化数据 / BI」缺口：

- 数据域（data domain）= 数据连接 + MDL / 业务知识文件 + 已发布版本。
- 专家通过平台托管的 MCP 绑定数据域，按登录用户身份生成受控查询。
- 对话结果由 PACE 原生生成式 UI 与图表呈现，不由 Wren 托管看板。

两者不重叠：知识库回答「文档里写了什么」，数据域回答「数据库里是什么」。

## 2. 服务边界

| 归属 | 职责 |
|---|---|
| PACE | 智能体、用户身份与授权、数据域资源生命周期、专家绑定、审批、审计、成果与界面 |
| Wren 引擎 | MDL 语义解释、SQL 规划与执行、连接凭据持有 |

边界规则：

- 连接测试由调用方直接提供明文 `connection`，api 不做解密、原样转给运行时；查询、结构反射与版本构建则使用已存储的加密凭据，在 api 或受控构建 worker 内解密后随内部请求交给运行时，由运行时进程内的 `WrenEngine(connection_info=...)` 持有；对话 worker 与沙盒不接收数据库凭据。对话沙盒不挂载 `.env`、连接 profile 或数据库网络属于部署要求，默认 `SANDBOX_EGRESS=open` 本身不提供该隔离。
- PACE 不重写语义层、SQL 生成或执行逻辑；引擎返回的结果由 PACE 负责鉴权、审计与呈现。
- 身份与范围由 PACE 决定，Wren 只执行 PACE 传入的已授权查询与 properties。

## 3. 架构决策

### 3.1 数据域查询服务，而不是 `wren serve mcp`

**决策**：新建 Python 数据域查询服务，嵌入 `wrenai` SDK 的 `WrenEngine`。不直接把 stock `wren serve mcp` 暴露给 PACE。

**理由**：

- `wren serve mcp` 在启动时固定 project / profile，一个进程只有一个 caller 与引擎上下文；`run_sql(sql, limit)` 没有身份参数，无法按登录用户隔离。
- `--transport http` 默认绑定 loopback（`--host` 默认 `127.0.0.1`），但可改为 `0.0.0.0`，且没有请求级鉴权。
- Wren 自带「governed」形态需要 `private_model` 配置 + Warble（`@warble/pi`）runtime 作为策略进程；governed 直连模式不触发模型调用，但依赖该 runtime，且引入 PACE 之外的第二套执行底座，与「只保留 Claude Agent SDK 一套」冲突，因此不采用 governed 形态。
- 引擎本身提供 RLAC / CLAC 原语，`engine.query(properties=...)` 可在执行期按 session properties 过滤行与列，足以由查询服务按登录身份封装。

**证据**：`core/wren/src/wren/serve_cli.py`、`core/wren/src/wren/mcp_server.py`；M0 spike（见第 5 节）。

### 3.2 强制安全调用约束

**决策**：所有平台查询必须满足：

- `query(read_only=True)`。
- 构造 `WrenEngine(..., config=WrenConfig(strict_mode=True), fallback=False)`。
- session properties 由服务端依据登录身份生成：run token → businessId → 可见数据范围；绝不接受客户端或模型自报的属性值。
- 在运行时进程内，连接凭据只经 `WrenEngine(connection_info=...)` 持有；`query()` 只接收 properties。

注意接口归属：`read_only` 是 `query()` 的参数；`strict_mode` 属于 `WrenConfig`，在构造器传入；`fallback` 也是构造器参数。

**理由**：M0 证明默认 `read_only=False` 时可用物理表全限定名绕过 RLAC / CLAC；只开 `strict_mode` 仍不够。`read_only=True` 会拒绝带 catalog / schema 的限定名，与 strict mode 叠加后才把可查询对象收敛到 MDL 模型。

**证据**：`core/wren/src/wren/engine.py`、`policy.py`、`read_only.py`；M0 安全缺口实测（第 5 节）。

### 3.3 平台托管 MCP：`data_domain`

**决策**：数据域以平台托管 MCP 的形式提供给智能体，类别为 `data_domain`，经 `api` 的 `/mcp/:serverId` 代理；复用 run token 校验与 `isRunBoundToServer`。只接受 run 短期 token，不走用户 CRUD，也不提供外部客户端长期凭据。

**理由**：与现有知识 MCP 相同，平台托管端点可以在每次请求时拿到运行身份并生成 properties；直接暴露 Wren 自有 MCP 则没有这层身份与授权。`isRunBoundToServer` 保证 run 只使用其专家已绑定的 server，防止伪造 run header。

**证据**：`packages/api/src/modules/servers/http.ts`、`mcp-endpoint.ts`、`packages/db/src/repo/runs.ts`。

### 3.4 数据域是平台级资源

**决策**：数据域的生命周期仿照 `runtime_environment`：

- 编辑来源：连接配置 + MDL / 业务知识文件（文件是唯一投影，可导入导出）。
- 构建：由查询服务把编辑内容构建为不可变版本。
- 版本：一次构建一行，不可覆盖。
- 发布 / 回退：只改线上版本指针。

**理由**：语义层定义需要审阅、复现与回退；直接查「最新文件」无法审计当时使用的版本。实现上 `run_sql` 每次调用都重新读取 `data_domains.online_version_id` 指向的就绪版本，不在 run 级冻结；查询日志记录该次查询的 `versionId`，`audit_log` 只保留输入摘要，发布或回退后的查询可经查询明细追溯，但「同一 run 始终使用同一版本」不是保证。文件作为投影满足 PACE「文件系统即智能体定义」的约束，DB 只保存编辑状态与版本指针。

**证据**：`packages/db/src/schema/runtime-environments.ts` 的版本表与线上指针设计。

### 3.4.1 数据域表结构

- `data_domains`：数据域本体。`id`、`name`、`slug`(唯一)、`description`、`datasource`、`connection_encrypted`(AES 密文)、`online_version_id`(线上版本指针, 与 `id` 组成复合外键指向 `data_domain_versions`)、`query_approval_mode`(`off`/`all`，默认 `off`)、`created_by`、`created_at`、`updated_at`。
- `data_domain_versions`：一次构建一行、不可覆盖。`id`、`data_domain_id`(FK→`data_domains`, ON DELETE cascade)、`status`(`queued`/`building`/`ready`/`failed`)、`project_files`(jsonb 文件快照)、`mdl_manifest`(`ready` 时非空)、`log_tail`、`log_truncated`、`created_at`、`updated_at`；唯一 `(id, data_domain_id)`。
- `data_domain_query_logs`：明文查询明细，用于核查版本、SQL 摘要、行数与耗时。`id`、`data_domain_id`(FK→`data_domains`, ON DELETE cascade)、`version_id`(可空)、`server_id`、`run_id`、`actor_business_id`、`sql_summary`、`row_count`、`status`(`ok`/`error`)、`duration_ms`、`created_at`；索引 `(data_domain_id, created_at, id)` 与 `(run_id)`。与 append-only 的 `audit_log` 分开：审计保留链式摘要，本表保留可核查明细。
- `data_domain_identities`：按登录用户配置的 Wren session properties（RLAC/CLAC 的 `required_properties` 取值来源）。`id`、`data_domain_id`(FK→`data_domains`, ON DELETE cascade)、`business_id`(平台用户业务身份, 非空)、`properties`(jsonb `Record<string,string>`, 键值皆字符串)、`created_at`、`updated_at`；唯一 `(data_domain_id, business_id)`。查询时由 api 依 run token→`business_id` 解析本表 properties 注入 `/query`，绝不接受客户端或模型自报。
- `data_domain_query_approvals`：按数据域可选开启的查询审批记录。`id`、`data_domain_id`(FK→`data_domains`, ON DELETE cascade)、`server_id`、`run_id`、`actor_business_id`(可空)、`sql_text`、`sql_hash`(去除首尾空白后的 SHA-256)、`status`(`pending`/`approved`/`rejected`)、`decision_note`、`requested_at`、`decided_at`(可空)、`decided_by_business_id`(可空)；索引 `(data_domain_id, requested_at, id)`，部分唯一索引 `(data_domain_id, run_id, sql_hash) WHERE status = 'pending'` 保证同一 run 的同一 SQL 只有一个待审批项；约束保证 `pending` 与 `decided_at is null` 同真同假。
- `data_domain_enrichment_proposals`：enrich-context 提案。`id`、`data_domain_id`(FK→`data_domains`, ON DELETE cascade)、`source_version_id`(源版本，归属由 handler 校验)、`status`(`generating`/`ready`/`approved`/`rejected`/`failed`)、`instruction`、`summary`、`project_files`(jsonb 文件快照，生成前可空)、`error`、`created_by`、`created_at`、`updated_at`、`decided_at`(可空)、`decided_by_business_id`(可空)；索引 `(data_domain_id, created_at, id)`。

### 3.5 建模工作流

**决策**：优先导入已有 Wren 项目（`wren_project.yml`、models、knowledge）。没有现成项目时提供两步辅助：

- `generate-mdl`：反射数据库结构，生成初始模型。
- `enrich-context`：补充业务语义、枚举、示例与 join 说明；只生成待审提案。

enrich-context 已交付（M3，PR #522 / #523）：`POST /data-domains/{id}/enrich`（权限 `data_domains.build`）基于一个 `ready` 版本创建 `generating` 提案并入队，worker 经 `@anthropic-ai/claude-agent-sdk` 调用 `DATA_DOMAIN_ENRICH_MODEL`，只把源版本 `projectFiles` 与本次指令作为模型输入（另有固定提示词），返回结构化 `updatedFiles` / `removedPaths` / `summary`，合并后重新做项目文件结构校验，成功则提案转 `ready`。人工在详情页查看文件差异后，`POST /data-domains/{id}/proposals/{proposalId}/decision` 批准时在同一事务内标记 `approved` 并创建新版本，再交给既有构建队列；拒绝只标记提案。发布仍需单独执行，批准前不会修改线上版本，也不会自动发布；高影响项因此天然经过人工确认。

高影响项（行级 / 列级访问控制、主键、金额与 PII 字段）必须人工确认后发布。模型子进程环境只带 `PATH`、`HOME`、配置目录等固定运行变量与 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` 三个模型上游变量，不携带数据库连接凭据、`DATABASE_URL` 或 `APP_SECRET_KEY`；连接测试接收调用方明文 `connection`、没有解密步骤，查询、结构反射与版本构建才使用已存储的加密凭据并在 api 或受控构建 worker 内解密。部署要求对话沙盒不挂载凭据且不可达数据库网络，具体见 `docs/OPERATIONS.md` 的 Wren 章节。

**理由**：结构反射只能得到表与列，业务含义和权限规则必须由人确认；把凭据留在受控进程，避免模型或对话进程直接接触数据库账号。

**证据**：Wren CLI 的 `context build` 与建模流程；PACE 沙盒边界。

#### generate-mdl 结构反射

- 运行时读取 `information_schema.tables`（排除 `information_schema`、`pg_catalog`）与 `information_schema.columns`（一次查询全部列后按 catalog/schema/table 分组），合成 `models/<table>/metadata.yml`（全列、`primary_key` 留空，真实主键与关系留待后续补全）、`wren_project.yml`（`schema_version: 5`）与空的 `relationships.yml`，再执行 `wren context build` 得到 `target/mdl.json`；单次反射最多 200 张表，表名不能用作模型路径时直接报错。
- 入口：运行时 `POST /generate-mdl` 返回 `projectFiles` 与 `mdlManifest`；平台 `POST /data-domains/{id}/generate-mdl`（权限 `data_domains.build`）用反射结果创建一个 `queued` 版本并交给现有构建队列，构建成功后即可发布。
- 局限：已对 duckdb 验证（catalog 为文件主名，连接形如 `{url:<dir>,format:"duckdb"}`）；其他数据源尽力而为，DB 原生类型直接透传，错误由构建日志暴露。反射只产出草稿模型，需要人工补全业务语义；不生成关系、指标或访问控制。`enrich-context`（已交付，见本节前文）可基于就绪版本生成补全提案，仍需人工确认。

#### 导入校验

导入 `projectFiles` 时在 API 边界先做结构校验：必须包含 `wren_project.yml` 和至少一个 `models/<表>/metadata.yml`，YAML/JSON 能按语法解析且关键文件为映射，路径必须是相对路径且不越出项目根（与构建进程的路径规则一致）。非法输入直接返回 `INVALID_INPUT`，不创建版本、不入构建队列。

### 3.6 治理

**决策**：

- 默认只读 + strict mode；`run_sql` 可按数据域策略要求逐次审批。`data_domains.query_approval_mode` 默认为 `off`，只读查询直接放行；设为 `all` 时 `run_sql` 在无已批准记录时先落一条 `pending` 审批并返回待审批结果（已批准则直接执行，已有 pending/rejected 则回传其状态），由平台授权用户经 `POST /data-domains/{id}/approvals/{approvalId}/decision` 批准或拒绝，代理重试相同 SQL（按去除首尾空白后的 SHA-256 匹配）后才真正执行或被拒绝；审批按 `dataDomainId + runId + sqlHash` 复用，批准后同一 run 再次执行相同 SQL 不再新建审批。审批列表由 `GET /data-domains/{id}/approvals` 提供，请求与决策均写审计。审批只控制执行时机，执行仍按服务端注入的身份 session properties 与 RLAC 过滤，只读/strict/fallback 语义不变。
- 每次查询记录审计：用户、run、数据域、版本、SQL 摘要、行数与结果状态。明细落 `data_domain_query_logs`（可核查），`audit_log` 仍有该事件的链式摘要。
- 查询明细通过 `GET /data-domains/{id}/query-logs`（权限 `data_domains.read`）以 keyset 游标分页暴露，支持 `status` 与 `runId` 过滤，便于审计与排查查询历史。
- 服务端强制行数上限，不依赖模型自报。
- 数据库侧使用最小权限账号；PACE 当前为单租户，PRODUCT 已明确组织多租户不在本期范围。

**理由**：语义层权限必须在执行期生效，不能只靠提示词或界面隐藏；审计与行数上限是发现越权与资源滥用的最小闭环。

**证据**：M0 RLAC / CLAC 实测；`PRODUCT.md` 的范围约束。

### 3.7 结果呈现

**决策**：查询结果由 PACE 原生生成式 UI 与图表呈现，不托管 Wren wasm 看板，也不做外部部署。

**理由**：PACE 自身托管 web 并提供固定文件的公开分享，但没有用户生成「整站」的静态托管能力；全局 CSP 的 `script-src 'self'` 也不允许运行任意看板脚本。把结果转成 PACE 原生组件，才能复用现有鉴权、审计与视觉体系。

**证据**：`docs/ARCHITECTURE.md` 的 web 托管与公开分享说明；`docs/SECURITY.md` 的 CSP 约定。

## 4. 里程碑

完整交付 = M0–M6 全部完成。M0 是 gate，未通过不进入 M1。

| 里程碑 | 交付物 | 状态与依据 |
|---|---|---|
| M0 地基验证 | Wren SDK 的 MDL、RLAC / CLAC、properties 与安全调用边界实测 | 已交付；PR #506，证据见第 5 节，结论 GO |
| M1 数据域资源骨架 | db / contract / api / UI：连接、导入、构建、版本、发布、连接测试与查询服务编排 | 已交付；PR #507–#511、#518 |
| M2 绑定与查询 | `data_domain` 托管 MCP、身份映射、审批、查询日志、原生表格/图表与聚合建议 | 已交付；PR #513–#517、#525、#528、#529 |
| M3 建模工作流 | `generate-mdl`、`enrich-context` 提案与人工审核、版本化、导入结构校验 | 已交付；PR #519–#523；真实模型与受控构建记录见 6.1 |
| M4 治理与权限 | strict 默认、最小权限、两用户真实执行栈越权实测 | 已交付；PR #526；M4b 分享隔离 PR #527 |
| M5 结果呈现与审计 | 导出内容一致、查询日志与审计哈希链可追溯、结果/日志/导出哨兵不泄漏 | 已交付；PR #530 |
| M6 收尾 | 文档与实现对齐、验收记录汇总、已知限制与部署要求 | 本次文档收尾；最终全链路验收与 PR 关闭按交付流程执行 |

## 5. M0 实测证据

下列为 M0 spike 的原始记录。环境为单机 DuckDB 样例，不代表生产数据库或并发条件。

### 5.1 环境

Wren 源码：https://github.com/Canner/WrenAI ，commit `75035ad1588e7d9170e7939c61dfbac4e069a9a9`；`wrenai` 版本 0.18.0，依赖 `wren-core-py 0.8.2`。

```bash
uv venv --python 3.12 /tmp/wrenspike/venv
uv pip install --python /tmp/wrenspike/venv/bin/python -e /Users/xbjt/Documents/myself/WrenAI/core/wren
```

安装结果：`wren-core-py 0.8.2`、`duckdb` 来自 PyPI。执行方式是 Python 脚本实例化 `WrenEngine(connection_info=...)`，再调用 `query(..., read_only=True, properties=...)`。

### 5.2 MDL 规则

经 `wren context build` 构建，关键片段：

```yaml
row_level_access_controls:
  - name: dept_filter
    required_properties: [{name: department, required: true}]
    condition: "department = @department"
columns:
  - name: salary
    column_level_access_control:
      name: salary_clearance
      required_properties: [{name: clearance, required: true}]
      operator: GREATER_THAN_OR_EQUALS
      threshold: "3"
```

### 5.3 结果对比

同一 `WrenEngine` 实例，逐请求传 properties；`employees` 共 5 行。

| properties | 查询列 | 结果 |
|---|---|---|
| `department="'HR'"`、`clearance="5"` | `id, name, department, salary` | 返回 HR 行（Alice / Bob），含 salary（90000 / 80000） |
| `department="'Sales'"`、`clearance="1"` | 含 salary | `Permission Denied: Access denied to column "employees"."salary"` |
| `department="'Sales'"`、`clearance="1"` | 不含 salary | 返回 Sales 3 行（Carol / Dave / Eve） |
| `department="'Sales'"`、`clearance="5"` | 含 salary | 3 行，70000 / 60000 / 95000 |
| 缺 `department` | 任意 | `session property department is required for dept_filter` |

其他观测：

- 属性值只接受 SQL 字面量：`'HR' OR 1=1`、`1=1` 被拒（`allow only literal value`）；字符串需带引号，如 `"'HR'"`。
- 生成计划的 SQL 含 `WHERE employees.department = 'HR'`。
- 低权限用户执行 `SELECT *` 时，salary 列被静默去掉；显式引用 salary 则报错。

### 5.4 安全缺口

- 默认 `engine.query(read_only=False)` 下，用物理表全限定名（如 `warehouse.main.employees`）可绕过 RLAC，返回全部 5 行。
- `read_only=True` 会拒绝：`Query only unqualified bound models`。
- `strict_mode` 单独不够：模型名与物理表名相同时仍会放行。
- 因此最小安全调用 = `read_only=True` + `strict_mode=True` + `fallback=False`。

### 5.5 性能

- 冷启动：import 0.165s + 首查询 0.093s ≈ 0.258s。
- 后续查询：7–12ms。

### 5.6 局限

- CLAC 仅支持 1 个 requiredProperty 与 6 种比较器；复杂列权限可能需要数据库侧列授权配合。
- `mdl.schema.json` 把 threshold 定义为 `{value, dataType}` 对象，但运行时与 `wren context build` 实际接受字符串 `"3"`；文档与实现不一致，接入时按运行时实际行为处理并记录版本。

### 5.7 结论

**GO**：properties 能在执行期强制生效，RLAC 与 CLAC 均可按登录身份约束行与列。前提是所有调用遵循 3.2 的安全调用约束；不满足时 M0 的安全结论不成立。

## 6. 业务验收

核心场景：同一个专家被两个权限不同的用户使用。

- 查询、缓存、报告、下载与分享均不得越权。
- 不能靠「数据库共享只读账号」解决隔离；只读账号仍会看到该账号权限内的全部数据，必须由引擎按登录用户的 session properties 过滤。
- 建模阶段同样隔离凭据：普通用户不能借助数据域构建、预览或导入导出拿到连接账号。
- 公开分享路径已隔离（M4b，PR #527）：读取过数据域治理数据的会话在 `conversations.data_domain_restricted` 持久标记（成功的 `run_sql` 返回前写入，写入失败则查询报错；分支会话继承），其成果创建分享返回 403，已有 token 的公开读取与下载按 404 失效；本人授权下载不受影响，未读取数据域的普通会话分享保持可用。

### 6.1 验收记录

以下只写已实际执行过的验收范围；未在 M6 重跑的项目注明证据来源。真实运行时用例需要 Docker/OrbStack 与安装了 `wrenai` 的 Python 环境（`WREN_RUNTIME_TEST_PYTHON` / `E2E_WREN_RUNTIME_PYTHON`），未配置时相关套件跳过，不回落假引擎。

**M0（PR #506）**：安全调用边界按第 5 节的 DuckDB 实测；`read_only=True` + `strict_mode=True` + `fallback=False` 下，RLAC/CLAC 按 properties 生效，物理全限定名绕过被拒。结论 GO，范围限于单机样例。

**M1（PR #507–#511、#518）**：数据域 CRUD、连接测试、版本创建、构建队列→worker→`/build`、CAS 发布/回退与 UI 已交付。验证：`bun run test -- packages/api/test/data-domains-routes.test.ts`。

**M2（PR #513–#517、#525、#528、#529）**：`data_domain` 托管 MCP 只接受绑定 server 的 run 短期 token；`run_sql` / `get_mdl` 只读，api 从 `run.initiatedBy` 解析身份并注入该次查询的 session properties。同一 SQL 在两个真实用户身份下得到不同行与列（真实引擎 E2E，PR #524）；审批 `off` / `all`、查询日志与 `maxRows` 边界、失败输入审计、表格/图表、数值聚合与图表类型建议已交付。验证：`WREN_RUNTIME_TEST_PYTHON=<venv python> bun run test -- packages/api/test/data-domain-query-isolation.test.ts`；`bun run test:web -- packages/web/test/data-domain-result.test.ts`。

**M3（PR #519–#523）**：generate-mdl 反射、导入校验、enrich 提案后端与前端、批准建版本与构建已交付。真实模型 enrich + 受控构建交接记录（2026-11，M3 关闭）：`report.mdlBytes=1645`、`mdlParsed=true`、`modelCount=1`、datasource `duckdb`；批准后制品 `new-version-mdl.json` 为 1829 字节。模型输入经 prompt-capture（脱敏前）扫描未出现连接凭据；错误脱敏只证明脱敏后的形态（保留前四位），不宣称任意错误零泄漏。该次验证使用 Hono `app.request` 而非 TCP，只覆盖同源 consumer，未启动完整 worker 入口、其余 consumer 或 Web UI；不是完整生产端到端验收，也未固化为可重跑脚本。可复跑：`bun run test -- packages/api/test/data-domain-enrichment.test.ts`、`bun run test -- packages/worker/test/data-domain-enrichment.test.ts`。

**M4（PR #526）**：同一专家、同一数据域、同一条 SQL，两个真实登录用户的 run 在 Docker 沙盒内真实调用 `run_sql`；RLAC/CLAC 返回不同行与列，非成员读取/下载对方成果返回 404。验证：`E2E_WREN_RUNTIME_PYTHON=<venv python> bun run e2e:channel:execution`（同一用例同时覆盖 M2c 呈现与 M4b/M5 断言）。

**M4b（PR #527）**：受限会话分享 403、既有 token 公开读取/下载 404、分支会话继承、普通会话分享可用。验证：`bun run test -- packages/api/test/output-shares-data-domain.test.ts`。

**M5（PR #530）**：成果下载字节与清单 sha256/大小一致；查询日志、`audit_log` 与审计导出按 run 可追溯；`GET /api/audit/verify` 哈希链校验通过；导出与列表条目一一对应且字段受清单限制。A/B 下载均不含对方行值；B 的下载与 query-logs 不含受限列 `salary`（A 在授权范围内可见 salary）；凭据与账号口令哨兵未出现在下载、query-logs 与审计导出；原始 SQL 未出现在审计导出（导出使用 `inputDigest`）。验证：同一 `bun run e2e:channel:execution`；范围限于该 E2E 的样例与哨兵，不代表任意内容都经过通用 PII 脱敏。

**M6**：本次同步 `WREN-INTEGRATION.md` 与 `OPERATIONS.md`，把 M3 后的交付状态、真实证据、已知限制与部署要求写入文档；未重跑产品测试，最终全链路验收与 PR 关闭按交付流程执行。

## 7. 已知限制与风险

- CLAC 仅支持 1 个 requiredProperty 与 6 种比较器；复杂列权限需用数据库侧列授权兜底（最小权限 GRANT），语义层与数据库两处规则需保持一致。见 `docs/OPERATIONS.md` 的 Wren 章节。
- RLAC 依赖服务端正确生成 properties；任何客户端或模型可影响的属性都视为漏洞。
- 并发与扣压未压测：当前只验证单实例、单请求属性隔离，未覆盖并发、连接池与长查询。
- Python 运行时体积与冷启动成本需在镜像与资源配额中核算。
- 属性值必须是 SQL 字面量，字符串、数字、日期与 NULL 的类型处理需要统一封装，避免调用方各自拼接。
- enrich 任务 `attempts: 1` 不提供业务重试；worker 每 5 分钟对账一次，`generating` 提案超过 15 分钟未更新会被置为 `failed`（`生成中断或超时`），之后需重新发起提案。
- Wren 运行时无请求鉴权，且凭据在内部 HTTP 明文中传输；只能部署在可信内网/本机，不得暴露公网。默认宿主直跑会监听 `0.0.0.0`。
- `mdl.schema.json` 把 threshold 定义为 `{value, dataType}` 对象，但运行时与 `wren context build` 实际接受字符串 `"3"`；文档与实现不一致，接入时按运行时实际行为处理（另见 5.6）。
- `data_domain_query_logs.sql_summary` 为明文 SQL 前 500 字符，`audit_log` 只存摘要且不参与每日清理；查询明细与审计的留存边界见 `docs/OPERATIONS.md`。
