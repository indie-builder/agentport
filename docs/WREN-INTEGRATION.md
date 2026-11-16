# Wren 数据语义层集成

> 状态：M0 已完成（gate 通过），M1–M6 未实现。本文定义 PACE 集成 WrenAI 的设计契约与 M0 验证结论。M0 的 GO 只表示执行期按 session properties 强制生效，不代表生产安全或业务验收已经完成。

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

- 连接凭据只存在于受控的数据域查询服务进程内，由 `WrenEngine(connection_info=...)` 持有；对话沙盒没有 `.env`、连接 profile 或数据库网络。
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
- 连接凭据只经 `WrenEngine(connection_info=...)` 持有；`query()` 只接收 properties。

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

**理由**：语义层定义需要审阅、复现与回退；直接查「最新文件」无法保证同一 run 内的定义稳定，也无法审计当时使用的版本。文件作为投影满足 PACE「文件系统即智能体定义」的约束，DB 只保存编辑状态与版本指针。

**证据**：`packages/db/src/schema/runtime-environments.ts` 的版本表与线上指针设计。

### 3.4.1 数据域表结构

- `data_domains`：数据域本体。`id`、`name`、`slug`(唯一)、`description`、`datasource`、`connection_encrypted`(AES 密文)、`online_version_id`(线上版本指针, 与 `id` 组成复合外键指向 `data_domain_versions`)、`created_by`、`created_at`、`updated_at`。
- `data_domain_versions`：一次构建一行、不可覆盖。`id`、`data_domain_id`(FK→`data_domains`, ON DELETE cascade)、`status`(`queued`/`building`/`ready`/`failed`)、`project_files`(jsonb 文件快照)、`mdl_manifest`(`ready` 时非空)、`log_tail`、`log_truncated`、`created_at`、`updated_at`；唯一 `(id, data_domain_id)`。
- `data_domain_query_logs`：明文查询明细，用于核查版本、SQL 摘要、行数与耗时。`id`、`data_domain_id`(FK→`data_domains`, ON DELETE cascade)、`version_id`(可空)、`server_id`、`run_id`、`actor_business_id`、`sql_summary`、`row_count`、`status`(`ok`/`error`)、`duration_ms`、`created_at`；索引 `(data_domain_id, created_at, id)` 与 `(run_id)`。与 append-only 的 `audit_log` 分开：审计保留链式摘要，本表保留可核查明细。
- `data_domain_identities`：按登录用户配置的 Wren session properties（RLAC/CLAC 的 `required_properties` 取值来源）。`id`、`data_domain_id`(FK→`data_domains`, ON DELETE cascade)、`business_id`(平台用户业务身份, 非空)、`properties`(jsonb `Record<string,string>`, 键值皆字符串)、`created_at`、`updated_at`；唯一 `(data_domain_id, business_id)`。查询时由 api 依 run token→`business_id` 解析本表 properties 注入 `/query`，绝不接受客户端或模型自报。

### 3.5 建模工作流

**决策**：优先导入已有 Wren 项目（`wren_project.yml`、models、knowledge）。没有现成项目时提供两步辅助：

- `generate-mdl`：反射数据库结构，生成初始模型。
- `enrich-context`：补充业务语义、枚举、示例与 join 说明；可在 auto-pilot 或审批队列中运行。

高影响项（行级 / 列级访问控制、主键、金额与 PII 字段）必须人工确认后发布。建模与凭据操作在受控容器内完成；对话沙盒不挂载凭据、不接数据库网络。

**理由**：结构反射只能得到表与列，业务含义和权限规则必须由人确认；把凭据留在受控环境，避免模型或对话进程直接接触数据库账号。

**证据**：Wren CLI 的 `context build` 与建模流程；PACE 沙盒边界。

### 3.6 治理

**决策**：

- 默认只读 + strict mode；`run_sql` 可按数据域策略要求逐次审批。
- 每次查询记录审计：用户、run、数据域、版本、SQL 摘要、行数与结果状态。明细落 `data_domain_query_logs`（可核查），`audit_log` 仍有该事件的链式摘要。
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

| 里程碑 | 内容 | 完成判据 |
|---|---|---|
| M0 地基验证（已完成） | 验证 Wren SDK 的 MDL、RLAC / CLAC、properties 与安全调用边界 | 第 5 节证据齐全，结论 GO |
| M1 数据域资源骨架 | db / contract / api / UI：连接、导入、构建、版本、发布、查询服务编排 | 可创建数据域并发布一个可查询版本 |
| M2 绑定与查询 | `data_domain` 托管 MCP、专家绑定、端到端问答、审批与审计、原生图表 | 同一专家按不同用户身份得到不同结果 |
| M3 建模工作流 | `generate-mdl`、`enrich-context`、人工确认、版本化 | 从空连接生成可发布 MDL，并保留审批记录 |
| M4 治理与权限 | strict 默认、数据库最小权限、PII 处理、审计、两用户越权实测 | 越权用例全部被拒且有审计 |
| M5 结果呈现强化 | 表格、图表、导出与引用；公开分享路径复核 | 非管理员只能看到授权结果 |
| M6 收尾 | 文档、E2E、死代码与临时资源清理、PR | 文档与实现一致，验证命令可复现 |

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
- 公开分享是待验收风险：固定文件分享与导出可能把按用户过滤后的结果变成匿名可读；上线前必须确认分享路径不放行未授权数据，或限制数据域结果参与公开分享。

## 7. 未决与风险

- CLAC 表达力有限：复杂列权限可能需数据库侧列授权，语义层与数据库两处规则需保持一致。
- RLAC 依赖服务端正确生成 properties；任何客户端或模型可影响的属性都视为漏洞。
- 并发与扣压未压测：当前只验证单实例、单请求属性隔离，未覆盖并发、连接池与长查询。
- Python 运行时体积与冷启动成本需在镜像与资源配额中核算。
- 属性值必须是 SQL 字面量，字符串、数字、日期与 NULL 的类型处理需要统一封装，避免调用方各自拼接。
- 公开分享与导出的越权风险见第 6 节，属于 M4 / M5 的必测项。
