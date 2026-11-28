# 待决策事项

> 最后更新：2026-11-29。
> 原则：能依据现有约束决定时直接采用推荐方案并记录；确需用户或部署形态拍板时列选项、建议、影响及依赖，暂停的仅是依赖该决定的工作。未经授权的发布、清库、生产操作不自动执行。
> 结构：上半段集中列出所有仍待决策的开放事项（`⏳`，共 10 项：D-21、D-76、D-78、D-88 至 D-94）；下半段为全部已拍板/已取代/已撤回条目的紧凑归档（保留所有 `D-` 编号便于跨文档检索，早期辩论过程见 Git 历史）。

---

## 待决策与开放事项

### D-21 ⏳ 对外程度

**问题**：单管理员、`/mcp` 单一全局 token、读接口限流较松、`/health/live` 与 `/health/ready` 无鉴权。

> 现状更新（2026-10-21）：限流已改为全局 600/min（`plugins/security.ts` 的 `global: true`），`/health/metrics` 已挂 `requireAuth`；仍无鉴权的只剩供容器探针使用的 `/health/live`、`/health/ready`。

**决定**：**暂不对外**。保持现状，但在文档里写清四项前置条件；一旦要对外，先做按 agent 发 token 与读接口限流。

> 2026-10-31：多账户与 RBAC 目标见 D-74；本条的「暂不对外」判断不变，多账户不等于对外暴露。

**影响面**：文档为主。

---

### D-76 ⏳ 原生 MCP 上游长期凭据的隔离边界（2026-10-31）

**问题**：用户为原生 stdio/HTTP MCP 配置的 env/headers 凭据由 worker 解密写入沙盒工作区 `.mcp.json`；同容器内默认启用的 Bash、技能/插件执行内容及 stdio 子进程可读取，并可按该凭据的上游权限调用。0600、`/workspace:ro`、PreToolUse hook 与 `${VAR}` 插值都不能隔离同容器进程。

**当前处理（按运行边界合同 R5，最小策略）**：接受该受信执行边界，保留用户已选的原生 MCP；`docs/SECURITY.md` 明确“仅绑定受信任代码与该任务所需最小权限凭据”。不新增审批流或弹窗、不默认关闭 Bash、不引入上游统一代理、主机工具执行或第二套 MCP 路由，也不声称已实现上游代理。模型凭据走 D-17 模型凭证代理与按 run token；generated/knowledge MCP 用按 run token；二者与上游长期 secret 的边界不同。

**待决策**：仅当目标变为“模型/沙盒进程不能接触上游 MCP 长期凭据”时，才需要单独选择原生 stdio/HTTP 的执行与凭据边界（如上游代理、主机侧工具执行、按工具 egress 等）。这属独立决定，环境变量插值不能满足；不阻塞当前已授权的系统架构修复。

**影响面**：`packages/shared/src/mcp.ts`、`packages/worker/src/index.ts`、`packages/sandbox/src/runner.ts`、`docs/SECURITY.md`；改变边界会触及原生 MCP 集成、凭据信任与功能语义。

---

### D-78 ⏳ overview 接口 p95/p99 尾部回归（2026-11-06，Bun 迁移合并前记录；同日定位更新）

**发现**：正式 ABBA 性能对照（主对照 6 轮、1,843,462 成功请求、0 失败，两侧响应体逐字节一致，证据 `/tmp/pbm/summary-final.json`，可用 `jq '[.endpoints[].sides[].requests]|add'` 复算；约 650 万是主对照加独立 health 附测的历史合计，不是同一个样本，`/tmp/pbm/health-summary.json` 仅能证明该附测存在，不据此重新推导精确合计）显示 `/api/overview?days=7` 吞吐与 p50 持平，但 p95 约 1.30x、p99 约 1.38x 慢于迁移前 Node/Fastify。两侧瓶颈均在 PostgreSQL（约 6.8 核），服务端机制未定位（定位更新见下）。同轮 `/api/agents` 快 1.63x（p50 15.5→9.5ms、RSS 774→506MB），`/health/live` 快约 10%。

**定位更新（2026-11-06，合并版 `914c852` 对迁移前 `6cfa902`）**：同一 PostgreSQL 实例、交替顺序（ABBA）、c8 闭环负载各 6 轮复测 `/api/overview?days=7`，0 失败，两侧响应正文一致；p95 比为 1.245（范围 1.228–1.262），p99 比为 1.357（范围 1.327–1.387），尾部回归仍存在。原因收窄至 Bun SQL 1.4.3 在高查询需求、小连接池下的调度/容量边界：官方固定 tag `bun-v1.4.3` 的 `src/js/internal/sql/shared.ts` 按总需求与连接数给仍有 queryCount 的 ready connection 分配额度，不要求连接空闲后才接新查询，查询完成后也按剩余 queryCount 继续参与派发；`prepare:false` 使用 extended unnamed statement 且不流水线。源码与该负载下的局部排队形态相符，是首要机制，但现有证据不能断言全部增量都是纯连接池等待，也不能完全排除运行时、解码等贡献；未测试上游最新版本，不能宣称最新版仍未修复。

**证据限制**：此前 pool10 的「等待 9.62→12.77 ms」来自已被 pool32 运行覆盖的客户端样本，不能从留存产物复算，不作为定量证据。客户端端到端耗时减去 PG 各阶段耗时的差值是残差，含排队、协议往返、序列化/解码、事件循环与 GC，不是纯池等待。pool32 下差距收敛有相当部分来自参照侧 pg 变慢，不能作为 Bun 显著变快的证据。`DB_POOL_MAX` 默认 10 与 `prepare:false` 保持不变；`prepare:true` 对照未修复该负载的尾部。

**候选排除（2026-11-06，同一 `c812eb3948f3c2b9ce8158d01ff77e1963e93cc8` 工作树，Bun 1.4.3，生产构建，`DB_POOL_MAX=10`、`prepare:false`，独立 PG18/Redis，约 200 agents、2 万 runs 的只读种子数据，闭合 c8、15s 采样、3s 预热、gzip，真实鉴权 `GET /api/overview?days=7`；两侧响应正文逐字节一致，0 失败）**：顺序 await 版（B）单轮 c8 初筛 p50 比为 1.2407（+24.1%）、RPS 比为 0.8421（-15.8%）；单 SQL 版（C）p50 比为 1.4495（+45.0%）、RPS 比为 0.7211（-27.9%）、p95 比为 1.1552、p99 比为 1.0552。两版均未达到预设初筛门槛，且只做单轮、未跑 ≥5 轮，不能宣称稳定性能差异，也不能据此认定 D-78 增量是纯连接池等待；单 SQL 版另经执行计划与语义核对，响应一致。上述数字是初筛观测，不是发布性能承诺。两项候选均撤回，`DB_POOL_MAX=10`、`prepare:false` 与原并发设置不变；D-78 未修复，原迁移前后基线比较结论不改写。本轮未重测 Node 侧，不能算作新的迁移 A/B 对照。

**排序索引修复（2026-11-07，任务树基线 `59de63b`）**：recent 查询实际使用 PostgreSQL 默认的 `started_at DESC NULLS FIRST`，原 `agent_runs_started_idx(started_at DESC NULLS LAST, id DESC)` 无法提供该顺序。新增单列 `agent_runs_recent_idx(started_at DESC NULLS FIRST)`（0051 迁移），不改查询、本人过滤、无窗口限制或相同时间的未定义顺序；原索引继续服务 `/api/runs`。真实计划由扫描、连接 20,015 行再 top-N sort，变为索引读取 20 行、按主键连接专家后停止。独立诊断负载中 recent 的数据库执行均值约 5.02→0.065ms，占数据库执行时间 24.8%→0.44%；剩余主要开销是专家聚合与 counts，不能据此宣称总接口会按微查询加速倍数提升。

**本轮四侧复验**：固定 Bun 1.4.3 生产产物、pool10、`prepare:false`、UTC 与 200 专家/20,015 运行种子，同一独享 PG18 实例中的四个随机数据库分别测 Bun 原索引、Bun 新索引、迁移前 Node `6cfa902` 原索引和同一 Node 新索引；各库数据签名一致并各自 ANALYZE。c8 每侧 5 轮交替、每轮 10s，另有 c1/c4 各 3 轮 6s 控制。Bun 新索引相对原索引的吞吐中位数 356.25（340.26–359.16）→408.05（398.04–432.27）req/s，p95 34.19（33.51–36.11）→29.60（27.40–31.13）ms，二者精确秩和检验 p=0.00794；p99 43.05（41.30–47.99）→36.05（33.03–48.05）ms，p=0.151，p99 改善未超出本轮变异。Bun 候选对原 Node 的 p95 为 +1.44%（29.60 vs 29.18ms，p=0.841）、p99 为 -6.52%（36.05 vs 38.57ms，p=0.421），本轮未检出原基线量级的尾部回归，但这不是非劣效证明。同索引 Node 的 p95 为 26.19（25.57–26.68）ms，Bun 仍高 13.01%（p=0.00794）；这是整套运行时/HTTP/驱动栈的对照，不能单独归因为驱动。初筛、正式轮与控制轮合计 111,745 个成功请求，0 失败；完整原始记录与脚本在 `/tmp/d78-index.1b9wwV/`，正式汇总为 `run-1793980554673-fd6671/evaluation.json`。

**语义与成本**：四侧统计、专家数组和字段一致；recent 每行对照全体可见记录核验字段、唯一性、NULLS FIRST、截止时间与所有严格较新行。同时间/NULL 组内顺序因计划变化而不同，保留原始响应，不宣称字节相等。本人数据占 100%、约 1%（188 行）、约 0.1%（16 行）及空集均通过范围和截止校验；稀疏路径仍使用现有 `initiated_by` 索引，只排序匹配行，未增加本人复合索引。新索引 401,408 字节（392 KiB），原运行索引合计 5,955,584 字节；1000 条批量插入的 5 轮回滚实验 WAL 中位数 932,212→1,004,966 字节（+7.8%），执行时间 20.62（18.14–22.34）→17.80（17.45–18.88）ms，不能把这个有缓存/顺序影响的批量实验当作真实 worker 写入变快或零成本的证据。新库迁移、db typecheck、既有 overview 与 db 完整性 24 条测试通过；真实 HTTP 另确认 `days=1` 的统计为 0 时 recent 仍返回 20 条。独享资源清理后按 PID、容器 ID、卷和端口回查通过。

**最终预聚合复验（2026-11-07，任务树 `3d7eb8e`，未提交）**：原聚合查询（A，API source `f9cef0…` / build `c86440…`）对最终预聚合（J，source `3233…` / build `4231…`），HEAD、router 与冻结产物一致；Bun 1.4.3、`DB_POOL_MAX=10`、`prepare:false`、gzip、UTC、固定种子（200 agents / 20,015 runs），platform `GET /api/overview?days=7`、c8、每侧 5 轮交替、每轮 10s。A 20,587 请求、J 25,299 请求，均 0 失败；days=7 响应正文逐字节一致（sha256 `5a42cf…`，65,350 字节）；计时库只读，语义夹具在独立克隆库内执行、回滚后删除，两侧表大小一致且 `n_tup_upd=0`。J/A 中位数：吞吐 505.16（495.78–511.77）对 408.58（406.80–416.83）req/s，+23.64%；p50 15.11 对 18.27ms，-17.32%；p95 23.28（22.95–24.30）对 28.98（28.87–29.62）ms，-19.68%；p99 28.24（27.67–31.38）对 35.03（34.69–35.77）ms，-19.36%；5 轮全部 J 更优，精确秩和 p=0.00794。应用 CPU 中位数 86.3% 对 77.5%，生成器 13.77% 对 13.32%。all/1%/0.1%/none 四种本人分布 × days 1/7 均按 id 字段相等、零运行专家保留；days=1 实际 HTTP 正文也一致；合成语义库的 platform-1 仅因全为 null 的并列排序导致 `bytesEqual=false`，按 id 仍相等，展示层并列次序不作保证。最近运行 6 个同时间组、专家 74 组，A/J 顺序相同；全表 7,187 个同时间组（17,121 行），相同时间顺序未定义。已有 own 稀疏路径（`/tmp/d78-aggregate.BOqybz/run-1793984146471-5cdc44/own-summary.json`）A/J 为吞吐 -2.21%、p50 +2.77%、p95 +0.46%、p99 -2.65%，秩和 p=0.222/1/0.421，未见明确回退但这不是非劣效证明。平台旧正式 `run-1793983088945-950514` 是更早的 C（source `dc99…`）而非最终 J：其同查询 Node 对照 p95 -7.78%（p=0.690）、p99 -4.31%（p=1）只表示未检出差异，同样不是非劣效证明。本轮未跑 Node、own 或 c1/c4 计时，结果仅覆盖单机 12 核、单一合成分布、闭合 c8 负载。原始记录 `/tmp/d78-final.nL6VPq/run-1793984713612-31a8e0/final-summary.json`，清理回查 `cleanup.json`。

**当前处理**：保留 pending，不标完全解决。最终预聚合在 platform days=7 c8 上相对原查询有稳定吞吐与尾部收益（5 轮全胜，p=0.00794）；own 稀疏路径未见明确回退，但未证明非劣；旧 C 对同查询 Node 仅未检出差异，不能当作非劣效证明。其它并发、负载形态、Node 同查询与生产容量仍未验证；扩池仍只是容量/部署预算的可选调参，不是有限池调度问题的一般修复。

**影响面**：`packages/api/src/modules/overview/router.ts`、底层 SQL 与连接参数（`prepare: false`、ISO 日期绑定）均在候选范围内；定位属独立性能任务。

---

### D-88 ⏳ 工具审批可配置策略与可读审计（Stage 3a-2 已实现，其他入口待接入）

**用户故事**：安全运营人员希望让同一专家的查询工具直通，让普通成员的写操作先审批，并能在审计中看到谁把哪条规则从什么改成了什么。

**Stage 3 前的基线与依据**：

- generated 工具已有 `api_tools.approval_mode`（`allow`、`ask`、`deny`）。[`generated.ts`](../packages/api/src/modules/servers/generated.ts) 在调用上游前先做审批门禁：活动状态检查后，`deny` 返回 `policyDeniedResult`，MCP 入口记录 `mcp.tool.denied`；`ask` 在服务端复核批准。已有 run 定义快照时，[MCP 入口](../packages/api/src/modules/servers/mcp-endpoint.ts)与[审批入口](../packages/api/src/modules/servers/http.ts)按快照取工具；外部连接器调用走当前定义。
- worker 把父级和启用子级的连接器名到 ID 映射、`ask` 工具清单交给 runner。[`approval-hook.ts`](../packages/sandbox/src/approval-hook.ts) 用 `PreToolUse` 从 `.mcp.json` 取 run 凭证，`PUT /tool-approvals/{runId}/{serverId}/{toolName}` 登记，再 `GET` 轮询。`approval_requests` 的等待截止由 `APPROVAL_WAIT_MS` 写入（默认 300 秒，hook 最多等 355 秒）。[私有 run](../packages/api/src/modules/runs/router.ts)与[频道](../packages/api/src/modules/channels/approvals.ts)的批准、拒绝写 `agent.run.approved`、`agent.run.denied`。[#614](https://github.com/indie-builder/agentport/pull/614) 每 5 分钟随 `ops-alerts` 核对已到期且未决策的记录，写 `expired_at`，尝试追加 `agent.run.approval.expired` 和清理未读审批通知。等待按 `expires_at` 截止，不等扫描；私有 run 的迟到批准仍可用于后续调用，不能恢复已经超时的调用。
- [`renderWorkspace()`](../packages/core/src/workspace.ts) 把绑定连接器写入 `.mcp.json`，把 `env`、已选 `outputStyle` 和用户 hooks 写入 `.claude/settings.json`，目前不生成 `permissions`。[`runner.ts`](../packages/sandbox/src/runner.ts) 用 `settingSources: ['project']` 加载文件，另在 SDK 选项传 `allowedTools`、`disallowedTools`，其中按连接器生成的 allow 规则用于自动批准，不是工具白名单。已装 SDK 0.3.329 的 `sdk.d.ts` 有 `canUseTool` 和 `PreToolUse`；项目的 `canUseTool` 只处理原生澄清提问，`dontAsk` 不安装。工具审批走 hook；按[官方权限顺序](https://code.claude.com/docs/en/agent-sdk/permissions)，自动批准的调用也会跑 hook，但不一定会跑 `canUseTool`。
- [`audit_log`](../packages/db/src/schema/ops.ts) 保留明文 `target` 和事件元数据，`input` 只以 `input_digest` 入链。[审计 repo](../packages/db/src/repo/audit.ts) 无法从摘要还原 `old → new`。现有 `server.tool.updated` 只把补丁交给摘要计算，因此改审计文案或导出不能补出历史改动值。

**问题与目标**：单个工具目前只有一个审批模式，不能区分哪个专家在用、谁发起、要执行哪种 HTTP 操作。扩展后，同一调用在 hook 和 generated 服务端应得到一致的判定，策略修改须能在审计页和导出中读到变更前后的值。

**范围**：首期只对平台 generated MCP 落地可配置策略，复用现有审批、待办和审计入口。不重做审批界面、审批人规则或跨 runner 重启恢复，不做通用策略语言，也不把策略当作 Bash、网络或第三方 MCP 的隔离边界。[#602](https://github.com/indie-builder/agentport/pull/602) 已关闭且未合入：把扁平 `mcp__<server>__<tool>` 加入 `disallowedTools` 时，server 名含 `__` 会使身份有歧义，知识、HTTP、stdio、plugin 的运行时目录又不能在渲染时穷举，可能误藏合法工具。不以「从模型列表消失」为验收。

**推荐决策**：

- **(a) 规则模型。** 保留工具的 `approvalMode` 作为基线，新增专用策略表存平台治理规则，不把同一条跨工具规则复制到每个 `api_tools`，也不复用匹配内容正文的 `content_policies`。选择器用专家 ID（run 的根专家，含其委派）、连接器 ID、工具 ID、发起者角色和 HTTP 方法，可选精确 `pathTemplate`。已填项必须同时命中，未填项表示不限。方法和路径模板取 generated 工具的服务端定义，不从工具参数或名称猜测。API 在写入时校验选择器归属和组合，管理权限建议用平台 `security.manage`。先保留对象和工具启用检查，再对基线及全部命中规则取最严格结果 `deny > ask > allow`，无命中沿用基线；窄规则不能放宽宽规则，不按录入顺序决胜。例：连接器默认规则为 POST `ask`，同时命中「普通成员禁止写入」时取 `deny`，GET 仍按工具基线。
- **(b) 发起者上下文与执行门禁。** runner 继续传已绑定连接器的短期 run token 和工具标识。API 从 `agent_runs` 的 `subject_kind`、`initiated_by` 或 `service_id` 及 `agent_id`、`channel_id` 解析发起者。平台角色按稳定 role ID 匹配；[`access.ts`](../packages/shared/src/access.ts) 的 `platform`、`own_data`、`maintained_agents` 是权限范围，不是角色。专家关系取负责人及 `agent_members.can_maintain` 等现有关系；频道另读 `channel_members.role`（owner、admin、member、viewer）。定时按 run 的实际执行身份，服务主体单独匹配。审批人不改变发起者，prompt、工具参数或裸 run header 都不能声明身份。频道追加指令仍归当前 run；同一 run 内 API 无法可靠识别直接 MCP 请求出自哪个子级，首期只匹配根专家。
  - **run MCP。** API 在 `/tool-approvals` 和 generated 执行门禁使用同一判定。hook 不再只看旧 `ask` 清单，`allow` 或批准后也不返回 SDK `allow`。工具定义仍按 run 快照，上游发送前重查当前角色、规则与有效批准。身份失效、受管工具身份不明、判定失败均不执行。新策略的 `ask` 绑定不可复用的请求 ID 和判定版本（涵盖操作、有效角色和命中规则版本）；决定入口须同时匹配两者。判定变化或待决请求到达 `expires_at` 时，决定入口立即拒绝旧请求，不等巡检，也不接受迟到批准。后续仍为 `ask` 时用新 ID 登记，不复用旧的 `(runId, serverId, toolName)` 行或跨 run 批准。拒绝、过期、取消或无合资格审批人均不执行。私有审批保留 `runs.approve` 与对象范围校验；频道保留 owner/admin 可决策、member 只可决策本人发起的 run、viewer 不可决策。
  - **其他 generated 入口。** 外部 connector token 不具备 run 或人类角色，只匹配无这些身份条件的规则，结果为 `ask` 时不执行。[OpenUI](../packages/api/src/modules/chat/openui-tools.ts) 用已认证的点击者和会话专家判定，不用消息原 run 的身份。仅基线 `ask` 仍走现有会话审批；新增规则要求 `ask` 时，在有支持判定版本的审批前不执行。[管理试跑](../packages/api/src/modules/servers/router.ts) 用已认证的操作者和管理授权判定，不匹配依赖 run、专家或频道的条件。保留试跑对基线 `ask` 的显式例外，但不跳过新增规则的 `ask`、任何 `deny` 或 SSRF 校验。
- **(c) 官方文件投影。** 首期只接通运行时 hook 与服务端门禁，不从 HITL 规则合成 `disallowedTools`、`permissions.ask` 或额外 allow：静态 ask 会进入 SDK 提问路径，不等同于平台审批。以后只把整轮内不变、不依赖角色、名称和作用范围无歧义的原生规则投影到 `.claude/settings.json` 的 `permissions`。沿用 `renderWorkspace()`；当前[专家包导出另生成 settings、导入不接受 `permissions`](../packages/api/src/modules/agents/package.ts)，须先对齐预览、导入导出和 SDK 加载，再开放这部分配置。动态规则及运行时发现的目录走 `PreToolUse`，不靠扁平名拆分或补全清单。SDK 的 `PreToolUseHookInput.mcp_server` 是可选来源信息，须用真实 SDK 验证其能与受信绑定唯一对应。无法确认身份的来源不开放策略配置。平台规则和发起者上下文不写进专家包，导入文件也不能覆盖平台门禁。
- **(d) 可读审计（Stage 2 已交付）。** 给 `audit_log` 加可空结构化 `detail`，不另开 `security_events`。Stage 2 只覆盖工具基线变更：明细写 `{toolId,toolName,from,to}`（均为字符串）。策略规则的新增、编辑、删除及其 `from`/`to` 待 Stage 3 规则表落地后接入，新增或删除时缺的一侧显式为 `null`。明细只存稳定 ID、模式、启用状态和经审查的操作选择器；不存工具参数、凭证、完整 URL、自由文本或人员姓名，含个人信息的路径模板只记操作 ID。当前 `server.tool.approval_mode.changed` 在更新后追加写入，沿用 `writeAudit` 的「审计失败不影响主流程」；与配置变更同事务、失败即不保存仍是待决策项。并发更新时 `from` 可能读到较旧值。审计页展开行与 CSV 导出现已展示可读明细（`from`/`to` 等），展开行固定按工具名、工具 ID、变更前、变更后排序。
  - **入链与保留。** 无明细行继续按原材料验链；有明细行用 `[2, …原有固定顺序字段, canonicalJson(detail)]` 作 SHA-256 输入，`canonicalJson` 递归按键名排序后 `JSON.stringify`，数组保序。`detail = null` 表示无明细，不可用空对象代替；新明细事件必须带结构化对象。既有行不重算。审计页和 JSON、NDJSON 导出沿用 `audit.read`；导出每条记录带 `detailType`（`jsonb_typeof(detail)`），离线复算据此区分 SQL NULL（旧公式 `detail=null`）、`'object'`（v2 canonicalJson）与其他类型（判失败），与在线验链一致。离线连续验链使用无筛选 NDJSON，从链首或可信检查点顺序续页；筛选导出只供查询，不能证明中间没有缺行。明细随审计行保留，当前 `audit_log` 不参加每日清理；如需限期保留，先定可信检查点与分段策略，不单独抹除已入链明细。哈希链可发现普通改写，不能单独发现链尾截断或有权限者重算整条链。
- **(e) 分阶段交付。**
  - **Stage 1：定契约。** 负责人确认以下决策点。评审采用固定样例，列出重叠规则、不同角色、身份缺失、规则变更后的等待和管理试跑各自的预期判定。
  - **Stage 2：先补可读审计。** 先覆盖 generated 工具基线变更。审计写入为 best-effort：配置先提交，审计失败仅告警不回滚；并发下 `from` 可能过期或漏记个别变更，为已知边界。本期通过审计列表 API 与 JSON、NDJSON 导出提供可读 `detail`（扁平字符串记录），导出同时带 `detailType` 供离线复算；只覆盖工具基线变更，不含策略规则增删。审计页展开行与 CSV 导出已展示 `from`/`to` 等可读明细；配置变更与审计明细写入同事务、失败即不保存留待后续阶段决策。隔离库验证 `allow → ask` 在列表与两种导出一致，无 `audit.read` 者不能读取。用混合新旧记录核验连续 NDJSON 可离线验链、筛选导出不声称连续，改写明细或明细类型后在线验链与离线复算均失败。
  - **Stage 3：接通 generated 策略。** 用隔离上游和真实 sandbox 验证同一 POST 对两种角色判定不同，未命中的 GET 沿用基线。等待中撤权、规则变动或请求到期后，旧请求不能批准；仍需审批时，新请求获批才执行。对 run MCP（含直接请求）、外部 token、OpenUI 和试跑逐一确认拒绝时上游请求为零。
  - **Stage 4：核验投影和运行时目录，再决定扩展。** 用实际 SDK 加载 `.claude/settings.json`，验证原生规则往返，包含 `__` 的命名及 knowledge、HTTP、stdio、plugin 合法工具仍可发现与调用。仅对可识别且确有审批需求的运行时来源启用 hook 策略，无法证明身份的来源维持现有行为。

**边界与风险**：run 批准不继承，按工具操作和当前判定绑定，不等同于对每次参数的批准。新规则若需要逐次核准参数，另定调用级审批；本项不承诺撤销已发出的上游请求。管理 `testInvoke` 目前放行 `ask`、保留 `deny` 和 SSRF 校验，不能把这条例外悄悄扩大成动态规则的绕行入口。

**Stage 3a 复评补充（撤销时序）**：审批判定与出站前的最后复核使用 worker 实际选定的 server/tool 定义（根与已发布子级快照优先，未固定子级用当前定义）；当前工具定义不存在、禁用或与快照不一致时 fail-closed 拒绝。频道 run 的身份解析复用执行授权条件：发起者降为 viewer、频道归档、绑定失效或会话归属不符都不再产生有效主体。审批复核（工具定义、角色、命中规则版本、有效批准）与紧随其后的取消检查共同构成 `fetch` 前的最后异步检查，取消检查是其中最后一步；复核通过到请求发出之间的进程内窗口无法消除：此刻撤权或作废不会取消已经进入 `fetch` 的请求，也不承诺撤销上游副作用。要缩小该窗口可把数据库检查与出站发送放进同一分布式临界区，但无法撤回已送达的请求，当前不做；生效边界是「复核时点」，不是「上游收到请求时点」。另有一个版本窗口：子专家在本 run 启动后重新发布时，run 行没有记录 worker 启动时选中的子级版本，API 无法唯一还原；此时不采用该子级重发布后的定义，发现来源不明的子级即 fail-closed 拒绝（不退回当前定义放行）。若要求跨发布版本继续执行，需要把子级版本在启动时固定进 run。

**Stage 3a 已知残留（内部自用可接受；对外前必须清除或产品化）**：以下各项不阻塞内部自用；在 D-21 从「暂不对外」翻转前，须逐项清除或产品化，不能只以文档免责。

1. **取消微窗口**：出站前已恢复对已受理取消的检查（DB run 状态，以及 MCP 入口注入的 Redis 取消键检查），但复核通过到请求送达之间不是原子操作，极小窗口内受理的取消仍可能放过已在途请求。这与 D-88「不能撤销已发出的上游请求」一致；本地检查无法完全消除该窗口，即使把取消判定与出站发送放进同一临界区，也只能缩小窗口，不能撤回已经送达的请求。
2. **来源无法唯一还原**：legacy/未固定 run 在 live 绑定被移除时可能回退到当前连接器或工具定义，基线 `allow` 下存在出站风险。后续需统一「固定快照 vs 确认 live vs 不可还原即拒绝」的来源解析。
3. **出站凭证/请求头**：`decisionHash` 覆盖 `serverId`、`toolId`、`method`、`pathTemplate`、`baseUrl`、`paramsIn`、`agentId`、有效角色、基线与命中规则，但不包含实际出站认证头或凭证摘要；连接器管理员变更授权头后，旧批准仍可能命中。后续需把出站凭证摘要纳入判定并在复核时比对。
4. **子级重发布/来源失效时的审批作废时序**：部分场景审批行作废与 409 返回的先后尚未完全统一，客户端可能先看到 409，随后审批行才落为终态。
5. **工具删除级联删除 `tool_approval_policies`**：删除工具会级联删除其策略，绕开 `security.manage` 治理写入；删除后重建同名工具的新 run 可能按基线放行。需补治理生命周期设计（策略与可执行工具同生命周期，或改用稳定操作标识）。
6. **未将全局 `rolesRevision` 纳入哈希**：判定使用已解析角色加 `agents.use`，相关授权变化会改变角色或置 `subject=null`，命中规则版本已入哈希，因此当前判为可接受。若后续出现不改变已解析角色却能改写判定结果的全局变更，需把该版本纳入。

**待确认决策点**：

1. 是否接受新规则只收紧、平台 `security.manage` 集中写入，首期以根专家为匹配范围？
2. 是否接受按当前角色和规则在执行前重判、旧批准不继承，以及将管理试跑和外部连接器调用限制在无须 run 审批的场景？
3. 是否采用 `audit_log.detail` 随链保留和授权导出，而不是使用独立安全事件表来换取独立留存周期？

---

### D-89 ⏳ 知识库 cleanup 与导入复用 blob 的已知竞态（待决策）

**触发条件**（四个条件同时成立）：

1. 一个孤儿 blob 已存在超过 24 小时保留期（mtime 早于 `BLOB_RETENTION_MS` 截止），且无任何版本 `blobSha256`、文档非空 `contentHash` 或在途 `queued`/`running` 任务 `payload.input.blobSha256` 引用。
2. 之后的知识库包导入（或其它复用路径）`stat` 到同一 content-addressed blob 并直接复用，不重写、不刷新 mtime。
3. `runCleanup` 已读取引用集合并逐项 `stat`，尚未执行 `rm`。
4. 该窗口内导入完成并提交版本/文档引用，随后 `runCleanup` 执行 `rm`，删掉已被引用的共享 blob。

**概率量级**：单次同内容重导的条件概率约 1e-5–7e-4，取决于读取引用集合到 `rm` 的窗口（约 1–60 秒）；线上实际频率未知。

**候选方案与成本**：

- **删除前二次校验**：仍有「校验后、`rm` 前」窗口，成本低但不封闭。
- **复用改为重写 + rename**：重置 mtime，仍有「导入写 blob 后、提交引用前」窗口，成本中等。
- **引用计数**：需所有写入方（API 导入、worker 摄取、包导入）遵守同一协议，跨进程事务难保证，成本高。
- **跨进程按 sha 加锁**：可真正封闭，但需 API/worker 协调同一锁，长扫描会阻塞导入。

**当前状态**：本轮已移除导入回滚直接删除共享 blob 的路径——[`package.ts`](../packages/api/src/modules/knowledge/package.ts) 的导入失败回滚只删除本次新建的版本目录，已写入的 content-addressed blob 交由 `cleanup` 回收。竞态本身未修，[`ingestion.ts`](../packages/worker/src/knowledge/ingestion.ts) 的 `runCleanup` 仍按上述引用集合与 mtime 规则回收。

**待确认问题**：是否接受按 sha 加锁（API 与 worker 共同实现）；或接受导入返回 201 后极低概率原件下载 404，保留现状。

---

### D-90 ⏳ 其余 BullMQ 队列的启动就绪与故障恢复（待决策）

**现状与依据**：

- BullMQ 6.7.8 会缓存首次初始化失败的 Promise，同一实例不会重试（已实测）。知识主队列与对账器已按 [ARCHITECTURE §6.4](ARCHITECTURE.md) 加就绪门槛，不在此列；其余仍未设就绪门槛的入口包括：[知识 followups Queue](../packages/worker/src/knowledge/queue.ts)、[API producer](../packages/api/src/queue/producer.ts)、[知识 scheduler](../packages/worker/src/knowledge/scheduler.ts)、[通用 run/eval 对账](../packages/worker/src/scheduling/reconcile.ts)、[通用 schedule 调度](../packages/worker/src/scheduling/scheduler.ts)，以及主 run/eval 等未设就绪门槛的 consumer。
- 失败影响按入口不同：知识 followups 初始化失败只失去即时投递，`queued` 任务仍可由知识对账按 `jobId` 补投；自动摘要的 followup 投递失败会把该版本摘要从 `pending` 回写为 `none`（[`ingestion.ts`](../packages/worker/src/knowledge/ingestion.ts) 的补偿），任务行仍在，仍可由对账补投。API producer 持续失败时知识接口保留各端点原有的成功状态码（例如批量重解析 200、新建分块 201，其余多为 202；入队异常只记日志），任务由 worker 对账补投；API 后续入队会持续失败、健康指标对应项为 `null`，直到重启 API 实例。知识 scheduler、通用 run/eval 对账与通用 schedule 调度的连接或初始化失败可能只记日志后继续运行，Compose 看不到非零退出，不会重启，同一实例内该队列一直不可用。
- 这些入口没有统一在启动阶段 `waitUntilReady`，知识主链路的修复不覆盖它们。

**候选方案与成本**：

- **统一启动门槛**：各入口启动时 `waitUntilReady`，失败直接非零退出，交给 Compose `restart: unless-stopped` 得到干净实例。与知识主链路一致，改动集中在启动处；代价是每个入口增加一次启动等待，Redis 不可用时进程不再带病运行，API 会在启动失败后反复重启。
- **按需重建**：捕获初始化失败后丢弃该 Queue 与连接，下一次使用时重建，同实例内自愈。避免重启扩散，但需封装重建与并发去重，连接和事件监听要一并替换，容易漏；也要确认 BullMQ 对 Queue/Worker 的缓存边界。

**验证方式**：用单个连接失败（错误 URL 或阻断 Redis）制造首次初始化失败，待 Redis 恢复后对照「同一实例继续使用」与「重启后新实例」两组：前者应持续失败或按方案重建成功，后者应恢复正常；同时确认失败路径不吞掉入队错误、不产生重复消费。

**待确认问题**：是否接受按入口逐个加就绪门槛（而不是抽一层统一封装），并接受 API 在启动阶段因 Redis 不可用而退出重启？

---

### D-91 ⏳ 知识库数据包恢复未发布草稿（待决策）

现状：已生成版本的草稿导入后引用旧库 indexingJobId，无法在本库发布；停用的零版本手写文档导入后只落文档与原件，没有恢复入口；清单的当前指针可指向 draft/superseded，Wiki 指针可绕过 `knowledge.publish`。候选：导入时重建版本并绑定本库索引任务；拒绝 draft/superseded 作为当前指针；恢复线上指针要求 `knowledge.publish` 权限。

---

### D-92 ⏳ 知识库变更审计的原子性与必达（待决策）

现状：`writeAudit` 写失败只 warn，知识库文档变更（移动、标签、删除、重解析）与发布均可能成功但无审计；复制已改为事务内写审计，手写显式发布没有独立审计事件。候选：把必须留痕的变更与 `writeAuditInTx` 放进同一事务；发布补审计事件；明确「审计失败是否回滚业务」。验证：注入审计写入失败，逐个端点核对返回值与审计行。

---

### D-93 ⏳ Agent Run 入队异常路径复查与并发重投递回滚卡死（NoStuckEnqueueFailure，待决策）

**可复现配置与源码位置**：

- 形式化复现：`bun run verify:formal`（[`FindingNoStuckEnqueueFailure.cfg`](../formal/agent-run-lifecycle/FindingNoStuckEnqueueFailure.cfg)，不变量 `NoStuckEnqueueFailure`，[`AgentRunLifecycle.tla`](../formal/agent-run-lifecycle/AgentRunLifecycle.tla) 第 815–822 行，15 步反例）。
- 相关源码：[`enqueueRunJob` / `failQueuedRunEnqueue`](../packages/api/src/modules/runs/enqueue.ts)、[`failUnstartedRun`](../packages/db/src/repo/runs.ts)、[`requeueInfraFailedRun`](../packages/db/src/repo/chat/messages.ts)、[`runAgentJob`](../packages/worker/src/runs/execute.ts)（认领事务、`publishRun` 失败回退 `queued`）。

**通俗说明（三要素）**：

1. **到底会出什么问题**：同一条任务出现并发入队重放或 BullMQ 锁过期重投递（stall）时，可能发生「队列里显示已完成，但数据库里被标成“入队失败（infra）”且没人再跑」的卡死状态。典型 15 步路径：生产者 `P1` 正常入队并退出成功 → `P2` 并发重放时在 `queue.getJob` 报错，正准备执行 `failQueuedRunEnqueue` → `W2` 领到任务并完成初读（看到 `queued`）后发生 BullMQ stall 锁过期 → `W1` 接手并把数据库改写为 `running` → 晚到的 `W2` 在认领事务里看到已是 `running`，放弃认领并让 BullMQ 把这个 job 标记为 `completed` → 此时 `W1` 的 `publishRun(run_started)` 失败，把数据库改回 `queued`（`startedAt = null`），但 BullMQ 的 job 已经是 `completed` 不会再投递 → 最后滞后的 `P2` 执行 `failQueuedRunEnqueue`（条件正好是 `status = 'queued'`），把数据库写成 `failed / infra / startedAt = null`，任务彻底卡死。
2. **有多大概率发生**：极低（需要「并发入队重放或 `getJob` 抖动」+「BullMQ worker stall」+「`publishRun` Redis 失败回滚」三重故障在毫秒到秒级窗口内重叠）；平时单发请求几乎不会撞上，但一旦 Redis 抖动就可能把本来已经交接出去的任务打成假死。
3. **多加代码/修复的复杂度与候选方案**：
   - **方案 A（只收口入队异常清理 + 跳过分支不标 `completed`，中等复杂度）**：Worker 认领发现已是 `running` 时抛专门错误或延迟让锁自然交还，不在 `W2` 正常返回把 BullMQ job 标为 `completed`；`publishRun` 失败时若不能确保队列仍可重新投递，不再简单退回 `queued` 等无人认领；`failQueuedRunEnqueue` 在标 `failed` 前校验不是刚被回滚的已投递任务或把队列检查放到同一条件里。需要核对 BullMQ stall 锁语义。
   - **方案 B（接受现状、依赖人工重试，零代码复杂度）**：保持当前保护，依赖用户在界面对 `failed (infra)` 消息点重新发送。

**待确认问题**：是否接受只为这个极低概率的三重并发窗口修改 Worker 认领跳过返回值与 `publishRun` 失败回滚语义（方案 A），还是维持现状交由用户重发（方案 B）？

---

### D-94 ⏳ BullMQ 同 jobId 终态保留期间并发 enqueueRunJob 命中去重静默返回（EnqueueOkImpliesJobWasActive，待决策）

**可复现配置与源码位置**：

- 形式化复现：`bun run verify:formal`（[`FindingEnqueueOkImpliesJobWasActive.cfg`](../formal/agent-run-lifecycle/FindingEnqueueOkImpliesJobWasActive.cfg)，不变量 `EnqueueOkImpliesJobWasActive`，[`AgentRunLifecycle.tla`](../formal/agent-run-lifecycle/AgentRunLifecycle.tla) 第 824–826 行，17 步反例）。
- 相关源码：[`enqueueRunJob`](../packages/api/src/modules/runs/enqueue.ts)（第 48–119 行）、[`runEnqueueOptions`](../packages/shared/src/run-stream.ts)（`DEFAULT_JOB_RETENTION = { removeOnComplete: 100, removeOnFail: 200 }`）、[`runAgentJob`](../packages/worker/src/runs/execute.ts)（`publishRun` 失败回退 `queued`）。

**通俗说明（三要素）**：

1. **到底会出什么问题**：BullMQ 为同一 `jobId`（`runId`）保留最近 100 个已完成和 200 个已失败的 job 记录；当两个并发 `enqueueRunJob` 先后都通过了开头的 `getJob`（都没看到旧任务），第一个刚把任务放进队列并很快被 Worker 结束为 `completed`（比如前置校验跳过或并发 stall 后另一个 Worker 跳过返回完成，同时伴随 `publishRun` 失败把 DB 退回 `queued`），第二个后到的 `queue.add(..., { jobId })` 会被 BullMQ 当成“重复 jobId”而**静默成功返回**——既不报错，也不真的把新任务放进等待队列。结果 `enqueueRunJob` 正常返回成功并调用 `requeueInfraFailedRun`，实际上队列里根本没有待执行的任务，DB 却停在 `queued`。
2. **有多大概率发生**：低（需要两个并发的 `enqueueRunJob` 请求跨越完整个任务快速结束或 stall 跳过窗口，主要出现在网络超时重试、并发重放或 `removeOnComplete` 保留期间重复触发入队）。
3. **多加代码/修复的复杂度与候选方案**：
   - **方案 A（`queue.add` 后复查返回值 / 状态 + `enqueue` 单飞互斥，低到中等复杂度）**：在 `queue.add` 返回后检查返回的 job 状态（或再 `getJob` / `getState` 一次），若发现处于 `completed`/`failed` 且 DB 仍为 `queued` 或 `isNeverStartedFailure`，则清理后重投或按失败报错；或按 `runId` 加短时 Redis 分布式锁串行化同 `runId` 的 `enqueueRunJob`。
   - **方案 B（等待 5 分钟对账器兜底，零代码复杂度）**：不改入队路径，依赖 `reconcileQueued` 在 `timeout + GRACE_MS` 后把卡在 `queued` 且队列已 `completed` 的 run 标为 `failed (infra)`，由用户手动重试。

**待确认问题**：是否在 `enqueueRunJob` 中增加 `queue.add` 后状态复查或同 `runId` 互斥锁来消除 BullMQ 终态去重静默吞单（方案 A），还是保留现有实现交由超时对账兜底（方案 B）？

---

## 已决策归档（D-1 ~ D-87）

> 含所有已拍板（`✅`）、已取代、有效边界说明（D-73）与已撤回（`⛔` D-81）条目；各条目早期讨论、验收细节与旧实现上下文保留于 Git 历史。

| 编号 | 主题 | 结论摘要 | 状态/日期 |
|---|---|---|---|
| D-1 | `/mcp` 平台端点的访问控制 | 单个全局 `PLATFORM_MCP_TOKEN`、无来源限制，未设置时不注册；放内网时改按 agent 发 token。 | ✅ 2026-10-20 |
| D-2 | 评估判定的方式 | 已被当前实现取代：由仅子串包含升级为 `judgeMode`（`contains` 或 `llm` 受治理 SDK 判分）。 | ✅ 已取代 |
| D-3 | 工具调用的审批（HITL） | 已被 D-18 取代：由拒绝后模型重调改为 sandbox `PreToolUse` 登记并短轮询暂停等待。 | ✅ 已取代（D-18） |
| D-4 | 智能体启用状态与外部调用关系 | 二值状态；`enabled=false` 时不出现在 `/mcp` 且 `POST /api/chat` 返回 409 `AGENT_DISABLED`。 | ✅ 2026-10-20 |
| D-5 | 版本历史的保留策略 | 每个 agent 保留最近 `RETAIN_AGENT_VERSIONS`（默认 50）个，每日维护裁剪（D-85 改为 DB 可配、D-87 保护线上版）。 | ✅ 2026-10-20 |
| D-6 | 运行记录的保留策略 | 终态 run 默认保留 90 天、孤立消息 30 天，每日维护执行；`audit_log` 与 `eval_results` 不清理（D-85 改为 DB 可配）。 | ✅ 2026-10-20 |
| D-7 | 备份的执行方式 | 保留手动 `bun run backup`（`scripts/backup.sh`，留最近 7 份），宿主机 cron 调度，应用内不做定时（见 [OPERATIONS.md §3.1](OPERATIONS.md#31-备份)）。 | ✅ 2026-10-20 |
| D-8 | 多智能体编排的范围 | 仅做「主 → 子」单层委派（`agents.parent_id`），有子智能体时放行 `Agent`/`TaskStop`，不做编排 DSL。 | ✅ 2026-10-20 |
| D-9 | 知识库 / RAG 建设范围 | 建设 PACE 内置知识库（参照 WeKnora 补齐 COW 版本/FAQ/Wiki/Feeds/14 种来源/多模态 OCR/ASR/离线评估），通过 `servers.kind='knowledge'`（run 短期 token）与 `.mcp.json` 接入 SDK；关键词 + pgvector RRF 融合；PR #127 已合入，真实外部服务与 GraphRAG 待验收。 | ✅ 2026-10-31 |
| D-10 | 多用户 / RBAC | 已被 D-74 取代：由单管理员 + JWT Cookie 改为 Better Auth 会话落库 + 稳定 `businessId` + 角色权限矩阵。 | ✅ 已取代（D-74） |
| D-11 | Redis 单点与高可用 | Compose 单实例 Redis，队列、事件流、限流共用；不做 Sentinel / Cluster。 | ✅ 2026-10-20 |
| D-12 | 沙盒运行时的演进 | 先用 `DockerSandboxProvider` 并保留 `SandboxProvider` 替换点；运行不受信用户智能体前须升级（见 D-16）。 | ✅ 2026-10-20 |
| D-13 | 事件流的持久化 | 原始事件仅存 Redis Stream（1h / 1000 条），不落库；trace 页从 `messages` 重建。 | ✅ 2026-10-20 |
| D-14 | 前端主题 | 只保留暖纸浅色主题（令牌见 `packages/web/DESIGN.md`），不维护深色主题与切换开关。 | ✅ 2026-10-20 |
| D-15 | 队列的可视化面板 | 已被当前实现取代：原定不接 `@bull-board/*`，现已挂载只读 Bull Board 于 `/api/ops/queues`（需 `operations.read`，见 [OBSERVABILITY.md](OBSERVABILITY.md#队列面板-apiopsqueues)）。 | ✅ 已取代（2026-11-14） |
| D-16 | worker 的 Docker socket 权限 | 单机自用暂按 A 保持直挂 `/var/run/docker.sock`；触发升级条件（不受信内容 / 多用户对外 / 共机放他用凭证 / 导入第三方定义）时按 B（socket proxy）→ C（独立节点）→ D（microVM）升级；D-74 多用户后暂仍按 A 接受风险、D-21 对外前升级。 | ✅ 2026-10-20（挂条件） |
| D-17 | 模型凭证代理（M12a） | worker 启动宿主侧模型代理，沙盒仅持按 run 短期 token，真实凭证不进容器 env；白名单转发 `/v1/messages`、`/v1/models`，run 结束清空 token hash。 | ✅ 2026-10-20 |
| D-18 | 工具审批改为持久化暂停 | 取代 D-3；sandbox `PreToolUse` 通过短 PUT 登记、短 GET 轮询（`APPROVAL_WAIT_MS` 默认 300s，hook 360s），API 不挂起 `tools/call`、重启可恢复等待；批准后走既有权限规则执行。 | ✅ 2026-11-18 更新 |
| D-19 | 多智能体可控工具放行 | 坚持单层委派（D-8），`ListAgents`/`SendMessage` 改按配置放行，默认关闭 `Monitor`/`EndConversation`。 | ✅ 2026-10-20 |
| D-20 | 补全权限模式 | `default` 与 `acceptEdits` 透传；拒绝 `auto`，永不开放 `bypassPermissions`；`default` 的 `canUseTool` 仅处理主会话 `AskUserQuestion`（见 D-68）。 | ✅ 2026-10-20 |
| D-22 | SDK 文件工作区作为配置交互契约 | AI Harness 统一 Claude Agent SDK，官方 `.claude/` 文件为唯一投影、DB 为编辑与运行记录来源；插件保持 DB 快照 + 本地加载 + 官方 CLI 隔离缓存安装，hooks/MCP 默认关闭按专家授权。 | ✅ 2026-10-25 更新 |
| D-23 | `SKILL.md` 初始导入支持范围 | 支持官方 Markdown `name`/`description`/正文往返（首个 H1 映射显示名，≤128KiB）；拒绝未接入/未知 frontmatter 字段，重名 409 不覆盖。 | ✅ 2026-10-22 |
| D-24 | 评估用例文件交换范围 | `agentport/eval@1` JSON 交换用例（含可选 `expectedTools`/`forbiddenTools`），≤500 条 / ≤1MiB，导入同名跳过不覆盖。 | ✅ 2026-10-22 |
| D-25 | 评估批次固定用例文本 | 提交评估时事务内冻结 `eval_runs.case_snapshot`，源用例删除后结果保留快照文本；配置与资源固定由 D-87 扩展。 | ✅ 2026-10-22 |
| D-26 | 评估停止边界 | 「停止后续用例」原子标 `cancelled` 并保留已产出结果，worker 下次检查退出；不承诺即时中断当前沙盒用例。 | ✅ 2026-10-22 |
| D-27 | 技能编辑版本条件 | 复用 `notStale` 毫秒单调推进与 `CONFLICT_STALE` 冲突保护，冲突不清空草稿；省略 `expectedUpdatedAt` 沿用旧语义。 | ✅ 2026-10-22 |
| D-28 | 评估比较的可比证据 | 只比较同专家两终态批次，按快照原用例 ID 对齐；双侧输入一致才判改善/退步/无变化，不使用 LLM 评判。 | ✅ 2026-10-22 |
| D-29 | 子技能进入原生文件链路 | 启用子智能体绑定技能按 slug 合并进工作区文件，子定义声明自身 `skills`，根提示词与自动许可清单仅取根绑定。 | ✅ 2026-10-22 |
| D-30 | 原生 `agent.md` 受限导入 | 官方 Markdown 导入为独立专家（≤128KiB，仅接受 `model`/`maxTurns`/`effort`，拒 `model: inherit` 与未接入字段），重名 409。 | ✅ 2026-10-22 |
| D-31 | 只读 MCP 目录与活动列表刷新 | 测试连接回传工具目录（≤1000 条 / ≤1MiB），仅本页只读展示；运行列表仅在含 `queued`/`running` 时每 5s 刷新。 | ✅ 2026-10-22 |
| D-32 | 原生 MCP 配置受限导入 | 接受根 `mcpServers` 1–100 条 HTTP/stdio（≤1MiB），事务创建、重名整批 409；env/headers 加密存库；拒绝 `${VAR}`、URL 凭证与 SSE/WS。 | ✅ 2026-10-22 |
| D-33 | URL 凭证统一边界 | 共享 schema 与运行时 SSRF 拒绝含内嵌 username/password 的 URL；旧记录展示统一遮掩，不自动迁移。 | ✅ 2026-10-22 |
| D-34 | 审批等待与后续许可分开 | 已被 D-88 部分取代：`approval_requests.expires_at` 固定首次期限、sandbox hook 2s 轮询保留；run 迟到批准与跨调用继承已由 D-88 取消。 | ✅ 部分取代（D-88） |
| D-35 | 取消中的 MCP 等待 | 可信 run 工具调用在审批前后复查 `queued`/`running` 并响应 `AbortSignal`，取消后不发上游（不承诺撤销已发出请求）。 | ✅ 2026-10-22 |
| D-36 | MCP 容量按执行阶段划分 | 上游 fetch 与有界读取共用每进程 4 槽（最多排 8 项）；握手、SSE、审批登记轮询与平台 invoke 不占执行槽。 | ✅ 2026-10-22 |
| D-37 | 直接子定义专家包迁移 | 已被 D-65 取代：`agentport/agent@1` 私有 JSON 及其兼容分支已随官方目录 ZIP 方案删除。 | ✅ 已取代（D-65） |
| D-38 | 测得评估结果文件 | 终态评估可导出 `agentport/eval-run@1`（≤500 条 / ≤1MiB），只含已记录结果；配置与资源固定由 D-87 扩展。 | ✅ 2026-10-22 |
| D-39 | 同会话运行入场 | `admitChatRun` 事务内锁专家 `KEY SHARE` + 锁会话行，同会话存在 `queued`/`running` 返回 409；不同会话独立并行。 | ✅ 2026-10-22 |
| D-40 | 有界会话历史分页 | 会话详情默认最近 50 条、上限 100 条，按 `(created_at, id)` 独占游标加载更早页；分支复制与评估仍完整读取。 | ✅ 2026-10-22 |
| D-41 | 终态输出写入保护 | worker 落库按固定锁序仅允许归属一致且 `running` 的 run 替换本轮非用户消息，取消先提交则跳过落库。 | ✅ 2026-10-22 |
| D-42 | 队列感知的 `queued` 收口 | 陈旧 `queued` 先探测 BullMQ job（4 并发 / 20s 超时），活跃/等待/探测失败保守保留，缺失或终态才条件标 `failed`。 | ✅ 2026-10-22 |
| D-43 | 专家超时参与 `running` 收口 | `running` 收口按 `agent.timeout_ms + 5min` 并先探测队列（有效 job 保持运行）；stop/销毁失败暂存 `pending_finish`，由 5 分钟 reconciler 清理并 CAS 终态。 | ✅ 2026-10-31 更新 |
| D-44 | 审计目标筛选与有界导出 | 审计列表与导出支持 `target` 精确筛选，导出上限 1000 条（超限 409 不截断），附件 `audit.json` 禁缓存嗅探。 | ✅ 2026-10-22 |
| D-45 | 平台 MCP 请求取消传播 | `ctx.mcpReq.signal` 透传给 `AgentInvoker`，预取消不建 run，后续取消复用 `cancelAgentRun` 发停止信号或清队列。 | ✅ 2026-10-22 |
| D-46 | 评估批次按队列状态收口 | 超 1h 的 `running` 评估批次先探测 eval 队列 job（4 并发 / 20s 超时），有效 job 保留，缺失或终态才条件标 `failed`。 | ✅ 2026-10-22 |
| D-47 | 平台 MCP 调用失败收尾 | `timeoutMs` 前置校验；入队失败仅把仍 `queued` 的 run 条件标 `failed/infra` 并清理残留 job；等待超时复用共享取消。 | ✅ 2026-10-22 |
| D-48 | 审计精确分页 | 按记录 ID 游标（`cursor`/`nextCursor`）在 DB 内按 `(created_at, id)` 独占分页，保留微秒精度；未知游标 400。 | ✅ 2026-10-22 |
| D-49 | 大额 Token 聚合 | input/output token 转 `bigint` 求和后转 `float8`，避免 `int32` 溢出（JS 安全整数内精确）。 | ✅ 2026-10-22 |
| D-50 | SSE 裁剪回放恢复 | 检测 Redis Stream 保留裁剪并发送 `replay_truncated`，run 结束后拉取已保存步骤替换不完整尾部。 | ✅ 2026-10-22 |
| D-51 | 连接器编辑与凭证轮换原子化 | PATCH 与 token 轮换在同一行锁内读合并写，毫秒单调推进 `updatedAt`，版本不符返回 `CONFLICT_STALE`。 | ✅ 2026-10-22 |
| D-52 | 专家编辑版本单调推进 | 专家 `updatedAt` 每次更新至少推进 1ms，与版本快照和绑定同事务写入，冲突返回 `CONFLICT_STALE`。 | ✅ 2026-10-22 |
| D-53 | 专家包实际字节契约 | 导入导出统一 1MiB UTF-8 实际字节上限（导出超限 409、导入超限 413，不截断）；包格式后续由 D-65 改为 ZIP。 | ✅ 2026-10-22 |
| D-54 | 专家 PATCH 保留未提交字段 | PATCH 仅映射请求明确提供的列，不带版本的不同字段并发更新互不覆盖。 | ✅ 2026-10-22 |
| D-55 | 子智能体绑定事务校验 | 变更子定义绑定在仓储事务级绑定锁内校验单层/归属/存在性，路由预校验仅作快路径。 | ✅ 2026-10-22 |
| D-56 | 评估入队失败收尾 | 评估入队抛错后仅条件更新仍 `running` 且 `claimedAt` 为空的批次为 `failed` 并移除 job，返回固定 503 不泄 cause。 | ✅ 2026-10-22 |
| D-57 | 专家推理设置恢复默认 | 仅 PATCH 允许 `effort`/`maxThinkingTokens` 传 `null` 清除（落 SQL NULL，不向 SDK 传 null）；省略则保留。 | ✅ 2026-10-22 |
| D-58 | 事件流结束通知缺失补偿 | 对非终态 SSE 每 2s 不重叠查库，DB 已终态而流未收口时发 `terminal_missing` 与终态后关流。 | ✅ 2026-10-22 |
| D-59 | 普通聊天入队错误契约 | 保留 `queued` 条件失败收尾与用户消息，入队失败返回固定 503 `SERVICE_UNAVAILABLE` 且不泄队列 cause。 | ✅ 2026-10-22 |
| D-60 | 已连接运行记录消失收口 | 已订阅 run 行确认不存在时发 `run_unavailable` 关流，前端清空忙碌状态与 `lastRunId`、保留已接收文本。 | ✅ 2026-10-22 |
| D-61 | 长期记忆走原生 auto-memory | 启用 SDK 原生 `autoMemoryEnabled` + `autoMemoryDirectory`（宿主 `WORKSPACES_DIR/<slug>/agent-memory/` rw 挂 `/mnt/agent-memory`），平台仅做浏览/编辑，不建私有记忆表。 | ✅ 2026-10-31 校准 |
| D-62 | 定时任务与任务看板归平台运营层 | `agent_schedules` + worker 30s ticker 复用 BullMQ 起 `trigger='schedule'` 运行，不进 `.claude/`；5 段 UTC cron。 | ✅ 2026-10-23 |
| D-63 | 运行记录 `agent_version` 语义 | 已被 D-87 取代：原仅追溯入队版本、执行用 live 表；D-87 改为固定发布版本 `definition` 执行。 | ✅ 已取代（D-87） |
| D-64 | 专家包升级为 `agentport/agent@2` | 已被 D-65 取代：私有 JSON 格式 `@1`/`@2` 已全部删除，改用官方 `.claude/` 目录 ZIP。 | ✅ 已取代（D-65） |
| D-65 | 专家包改为官方目录 ZIP | 取代 D-37 / D-64；导出/导入直接用官方 `.claude/` 目录 ZIP，删私有 JSON 与兼容分支；根 `agentport.json` sidecar 仅存平台元数据不复制正文。 | ✅ 2026-10-25 |
| D-66 | 专家包 sidecar 与 ZIP 校验参数 | ZIP ≤1MiB、解压 ≤4MiB、条目 ≤6000、sidecar v1；严格路径白名单防 zip bomb / 路径逃逸 / 链接，密钥只传键名。 | ✅ 2026-10-25 |
| D-67 | 会话成果工作区数据链路 | 原生 Read/Write/Edit 写 `/mnt/outputs`，每轮发布不可变快照并经 manifest 鉴权访问；支持 PNG/JPEG/GIF/WebP 与 PDF 原生 Blob 预览；专家软删除保留成果（2026-11-18）。 | ✅ 2026-10-30 更新 |
| D-68 | 原生澄清提问与显式权限模式 | 新建默认 `default`（显式 `dontAsk` 保留），`canUseTool` 仅处理主会话 `AskUserQuestion` 并经 PG/SSE/stdin 往返；MCP 审批独立。 | ✅ 2026-10-28 |
| D-69 | 聊天附件按会话文件挂载 | 随 `POST /api/chat` 上传落会话目录、只读挂 `/mnt/inputs` 由原生 `Read` 读取（≤10MiB、5 文件，文本/图片/未加密 PDF）；专家软删除保留目录（2026-11-18）。 | ✅ 2026-10-28 |
| D-70 | 交付物固定版本公开分享 | `output_shares` 锚定 `(conversationId, runId, path)` 与字节 sha256；链接 `/s/<shareId>#<token>` 存哈希与密文，正文预览 ≤1MiB，下载 attachment + no-store + nosniff。 | ✅ 2026-10-30 |
| D-71 | 个人偏好（DB 权威 + 只读投影） | `user_preferences` 按 `businessId` 存权威正文与 `revision`（`memory_changes` 留账），原子投影到 `_users/<sha256>/CLAUDE.md`（0700/0600）只读挂 `/mnt/user`，`UserPromptSubmit` hook 每轮注入（≤9000 字符 / 36KiB）。 | ✅ 2026-10-30 |
| D-72 | 历史回顾（用户触发 `review` 运行） | `trigger='review'` 复用官方 `query()`（无工具/无沙盒/`json_schema`），证据须原文子串，用户确认后加 advisory lock 写入并落账；子智能体独立记忆已于 `50ae93e4` 合入。 | ✅ 2026-10-31 更新 |
| D-73 | 不引入外部记忆服务 | 有效边界说明：不引入 Mem0/Zep/Letta/LangMem 等外部服务或第二套 Harness，记忆落官方 `.claude` 文件与现有 PostgreSQL 账本；仅在基准证明不足时建可重建检索索引。 | ✅ 有效边界（2026-10-30） |
| D-74 | 多账户、业务身份与角色权限矩阵 | 取代 D-10；Better Auth 会话落库 + 稳定 `businessId` 承载归属与数据隔离；默认四角色（管理员/用户/负责人/维护人员），DB 角色权限矩阵勾选配置，私有数据按 `businessId` 隔离，管理员跨用户运维留审计。 | ✅ 2026-10-31 |
| D-75 | 记忆主题升级（官方主题文件 + 短索引） | 在原生 auto-memory 上支持命名主题回顾、`MEMORY.md` 确定性补链、双文件逻辑采纳/回滚、证据归因 `kind`、手工主题版本账本与独立记忆 ZIP 下载；5 项已知缺口与真实模型召回见 [REMAINING-TODOS.md](REMAINING-TODOS.md)。 | ✅ 2026-10-31 |
| D-77 | 技能市场安装按钮权限感知与视觉令牌 | `MarketSkillsPage` 按 `market.install` 禁用无权安装按钮并说明原因；`--shadow-composer` 按 `docs/DESIGN-SYSTEM.md` 保留。 | ✅ 2026-11-06 |
| D-79 | 专家记忆策略配置化与只读装配视图 | `agents.memory_policy` 控制启停/写模式（`proposal_only` 只读挂载）/个人记忆与规则注入/主题上限；新增 overview/assembly/policy 端点；D-87 后已纳入版本快照可回滚。 | ✅ 2026-11-08（D-87 扩展） |
| D-80 | 频道延期项业务取舍 | 在「单机自用、内部小团队、D-21 暂不对外」下已落地 CH-04/12/11/02/14/17 最小版与消息保留清理；CH-03（D-16 升级）与 CH-17 独立频道身份挂 D-21 对外前；CH-18 按需；不做 CH-19 自由群聊。 | ✅ 2026-11-09 |
| D-81 | MCP 统一聚合网关（`kind='gateway'`） | 已撤回（PR #290 关闭）：另造聚合层与复用 HTTP→MCP 闭环冲突，由 D-82 在 `generated` 连接器补齐能力替代。 | ⛔ 已撤回（2026-11-12） |
| D-82 | `generated` 连接器补齐 HTTP→MCP | 自研 core `parseOpenApiDocument` 导入（≤200 operation、本地 `$ref`）；`GENERATED_PRIVATE_HOST_ALLOWLIST` 精确白名单放行内网；沿用既有错误码。 | ✅ 2026-11-12 |
| D-83 | `generated` 工具 `outputSchema` 与管理 | `api_tools.output_schema` 声明 object schema 并返回 `structuredContent`；新增批量启停与单工具试跑 `testInvoke`（过 SSRF、绕过基线 `ask`、写审计）。 | ✅ 2026-11-12 |
| D-84 | 智能体月度预算治理 | `agents.monthly_budget_usd`（null 不限）+ `budget_alert_ratio`（0.8）；准入按 UTC 当月累计校验超限返回 409 `AGENT_BUDGET_EXCEEDED`（eval 豁免但计费）；新增预算查询与编辑展示。 | ✅ 2026-11-15 |
| D-85 | 数据保留策略配置 | `platform_settings` 单行表作运行/消息/版本保留期权威，worker 启动按 env 幂等播种，新增 `GET/PUT /api/retention` 与运维页编辑；不清理审计表。 | ✅ 2026-11-16 |
| D-86 | 成果验收与反馈闭环 | `run_feedback` 追加式记录采纳/退回（锚定 `messageId`、成果快照 `outputPath`+sha256 或 run 级），仅终态可提交；退回样本经人工期望答案确认可原子转 `eval_cases`。 | ✅ 2026-11-18 |
| D-87 | 专家发布闭环 | 取代 D-63 并扩展 D-25/D-38/D-79；编辑态与发布态分离，`agents.published_version` 指向线上快照，运行一律固定发布 `definition` 与运行环境版本，试跑隔离只读，评测支持 `published` / `draft` 固定指纹，清理跳过线上版。 | ✅ 2026-11-18 |

---

## 决策记录格式

决策后请在此处标注：

```
- D-1 ✅ 选择 B，理由：…
```

---
