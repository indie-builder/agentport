# runtimeB 修订契约：同连接绑定锁、事务外关闭确认

## 状态、范围与替代关系

2026-10-31；工作树 `/Users/xbjt/Documents/myself/agentport/.claude/worktrees/system-architecture-modernization`。本轮只新增本文，不改源码、LoopX 或 Git 状态；没有执行提交、切分支、fetch 或合并。读取本地 `main` 的最新根规则及 `packages/{db,api,worker}/CLAUDE.md`，并核对本树 `docs/DEV-WORKFLOW.md` §2、`docs/PITFALLS.md`、锁/连接/删除/准入/关停调用链。工作树原有差异由其他执行者持有，本文不覆盖。

`system-architecture-runtime-contract.md` 和 `system-architecture-runtimeB-integration.md` 当前没有可确认的写入租约交接；主合同文档代理与接线者仍可能写入，故不改这两个文件。本文是它们 **R5 删除编排部分的后续修订**：交接后由原文单一写入者回填指针并替换旧段落，不复制出第二套长期合同。R5.1 原生 MCP 信任边界、关闭协议/idle-only 规则、记忆保留及 best-effort rm 结论继续有效。

用户已授权采用此方向修复，不需要重复逐项确认。旧代理的“未授权”报告不是用户指令。后续 Sonnet high 在接线者交接 `agents/routes.ts`、`chat/routes.ts`、`worker/index.ts` 后执行；本轮只有设计与文档核对，**没有实施、没有新测试通过结论**。

## 必须纠正的已确认冲突

1. main 的 db 规则明确“事务内不做 HTTP、队列、文件或 SDK 调用”，且 db 不承担沙盒/业务编排。旧 R5.3 第 2–4、6 项与 integration §1/§2/§6 却要求 repo 事务回调等待 Redis ACK；当前 `repo/{agents,chat}.ts` 的 `beforeDelete` 与两个 DELETE handler 已按旧合同接线。不能把这一冲突默默视为例外。
2. `repo/locks.ts:57` 的 `withAdvisoryLock` 持有 client A，却只给回调 `fn()`；如果新删除继续传 `app.db`（pool B），其事务再拿同一绑定锁会等待自己。现实现还禁用 `statement_timeout`，且 unlock/reset 失败仍 `release()`，不满足本次有限等待与连接回收要求。
3. 删除 repo 当前仅按 ID 读写；路由先前的对象授权不能替代 tx A/B 中的主体范围 SQL。只补本次 agent/conversation 两个删除入口，复用现有 `AccessFilter` 与授权规则，不做全 repo 权限重构。
4. `worker/index.ts` 当前把 cleanup drain 超时记为 warning 后继续，可能由 `runShutdown` 返回 0。main worker 规则要求清理失败非零退出；旧 integration 的无界 `await sessionCleanup.close()` 也不可采用。
5. `system-architecture-runtimeB-evidence.md` 的 94/94、真实 Docker 3/3 是旧事务回调实现的历史证据；不能证明本修订的事务外等待、断线中止、解锁销毁或 shutdown failure 已正确。Docker 3 的现有用例直接调用旧 repo 回调，必须迁移后重跑。

## 选定方案与锁范围

沿用 **同一个锁标识** `hashtext('agentport.subagent-bindings')`：外层 session advisory lock；tx A 与 tx B 都由该 PoolClient 创建的 Drizzle 实例执行。现有 `lockAgentBindings` / `lockRunResources` 的 transaction advisory lock 与它互斥；同一 PG session 在短事务中再次取得同键 xact lock不会自阻塞，事务结束也不会释放外层 session lock。

没有新增锁键、持久删除状态、表、迁移、服务、Worker 或依赖。不新建通用锁管理器、lease/fencing 框架或恢复任务。只扩展现有 `withAdvisoryLock` 的资源交付与释放逻辑，并在 API 组合现有查询、ACK 与删除。

精确键评估：`agent:<id>` 已存在，但 agent 删除会改变自身、直接子级及 enabled 子级的父级活动集合；准入首先取得全局绑定锁，单个会话的行锁又不能跨 tx A/B 保留。本轮不扩展锁系统，用全局绑定键保证两入口一致。**因此单 conversation 删除也会在等待 ACK 期间短时挡住其他 agent 的准入、绑定修改及经过绑定锁的记忆操作**。这不是只影响目标会话；预算见下文。不得宣传为无全局影响。更细锁方案需修改准入/绑定协议，不在本修订中。

## 资源 owner 与顺序

| 资源/职责 | 唯一 owner | 生命周期与限制 |
|---|---|---|
| PoolClient、session advisory lock、断线标记、超时设置与销毁 | `packages/db/src/repo/locks.ts` 的 `withAdvisoryLock` | checkout → 加锁 → 回调 → unlock/reset → release；任何不确定连接销毁 |
| Drizzle 连接句柄 | 同一 helper 创建并传给 API 回调 | `drizzle(client, { schema })`；不接入 `app.db` / 新 pool；helper 不做 ACK/沙盒业务 |
| tx A / tx B | `repo.agents`、`repo.chat` 的数据库方法 | 在传入连接上各自 `transaction`；只做 SQL/内存比较，不传网络回调 |
| 主体 scope、删除流程、Redis ACK | API 删除编排函数及两个 DELETE handler | 复用当前授权/错误体系；ACK 位于 A 提交后、B 开始前 |
| 容器关闭与 ACK | 现有 cleanup channel / `SessionSandboxes.closeIdle` | 全目标确认才成功；busy/lease/acquirePending 拒绝；按精确 persisted ID 处理 |
| rm、成功审计 | API handler | B 确认提交且 helper 正常 unlock 返回后；沿用现有目录入口和日志 |
| drain 截止与失败退出 | worker 现有 shutdown 路径 | 有界等待，失败交 `runShutdown` 记账；不无限挂起、不 warning 后 exit 0 |

固定时序：

1. DELETE handler 继续 schema、用户认证、叶权限和对象授权；这些是快路径与审计，不把其旧对象值当最终授权结果。
2. API 用 `app.pool` checkout 一条 client 并取得同绑定 session lock；在此之前不取得 agent/conversation 行锁。
3. **短 tx A**：同连接按主体范围重查实体；agent 维持现有 affected 集合与 `assertAgentsIdle`（含 enabled 子级对父级影响、review 例外）；conversation 维持 agent key share → conversation update 锁序与 queued/running 检查。得到确定的快照后提交。
4. **事务外 ACK**：仍持同 session lock，调用 `closeSessionSandboxes`，等待全部目标关闭。此期间删除 client 在 `pg_stat_activity` 必须为 `idle`、`xact_start IS NULL`，不能是 `idle in transaction`。不持有 A 的行锁。失败不启动 B、不删目录。
5. **短 tx B**：在原 client 上重新取得相同锁序，按主体/范围重查存在、归属和活动状态，重新构造全部目标快照；与 A 集合精确比较。匹配才 DELETE，SQL 自身仍带 ID 与主体范围条件。范围不符或不存在按 404，活动或目标变化按 409；任何检查失败回滚 B。
6. B 确认提交后，helper unlock（检查返回 true）、恢复设置，再 release。最后 handler 执行已有 runtime 目录 rm 与成功审计。

**不得使用 client A 持锁、`app.db` / pool B 做 A/B 的组合。不得在连接断开后新取连接、重获锁或自动重试 B；必须结束本次请求并保留实体（若 B 尚未提交）与全部目录。** 用户主动重试是新的完整操作，不沿用旧快照/ACK。

## 固定接口与最小文件变更

以下是实施目标签名，不是已存在导出。名称沿用现有 repo，删除旧回调，不保留兼容 overload。

### 1. 连接与锁：`packages/db/src/client.ts`、`packages/db/src/repo/locks.ts`

```ts
// client.ts：使 pool/client 两种 Drizzle 实例拥有共同查询类型，排除 $client 差异。
export type Database = NodePgDatabase<typeof schema>;
export type DbPool = Pool;
// createDb 仍返回 { db, pool }，连接参数不做全局调整。

// locks.ts：导出已有 key 值给 API 复用，不创造新 key。
export const AGENT_BINDINGS_LOCK_KEY: string; // 值直接提取 lockAgentBindings 现有字面量
export function withAdvisoryLock<T>(
  pool: DbPool,
  key: string,
  fn: (db: Database) => Promise<T>,
  holdTimeoutMs?: number, // 仅新删除调用传 40_000；现有 memory 调用不改变持锁业务预算
): Promise<T>;
```

`Database` 来自已装 `drizzle-orm/node-postgres` 的 `NodePgDatabase`。本地 0.45.4 类型 `NodePgClient = Pool | PoolClient | Client`；`drizzle(client, { schema })` 有明确支持，不用 `as unknown as Database` 掩盖 `$client: Pool` 差异。现有 `createDb` 返回实际实例不变；不做全仓库 Tx 类型整顿。

helper 必须负责：

- 保持 callback 单次调用，在同一个 client 上构造带同 schema 的 Drizzle；禁止替回调重连。
- checkout 后、加锁前注册 client `error` / `end` 监听，记连接已失效；在 ACK 后进入 B 的第一条 SQL必须使用原 client。连接错误/断开不能被吞掉、不能被“恢复连接”转换为继续删除。
- 删除 `set statement_timeout = 0`。沿用连接已有 15s statement budget，取锁和 unlock 单独使用 5s 有界 query/服务端 timeout；同连接的 `lock_timeout` 设 5s，退出时恢复原值。恢复原值用进入时读取的设置，不假定 `RESET` 一定还原连接 config 值。
- 删除调用传 `holdTimeoutMs=40_000`，从拿到 session lock 起建立唯一截止 timer；超时销毁原 client，标记失败并拒绝操作，禁止只结束等待却让 callback 在后台继续删。SQL 必须仍用这个已失效的 client，不能换连接；helper 不得把已过期 callback 的迟到返回当成功。timer 在正常退出时清除；销毁与 finally 共享一次性 release 标记，不双 release。不对现有 memory 回调增加新的业务总时限。
- session lock acquire 必须与现有 `pg_advisory_xact_lock(hashtext(key))` 使用相同单 bigint 键空间，不改成两个 int 的 overload。
- `finally` 检查 unlock 的布尔结果。unlock false、SQL/恢复失败、query timeout 后结果不确定、client error/end，均 `release(true)` 销毁，不得普通归池。即使取锁语句结果不确定也销毁，避免已经拿锁的连接泄漏回池。
- 释放严格一次；连接错误监听持续到释放。保留原业务异常，记录或关联清理异常；仅有清理异常则向上失败，不假报成功。不要用 catch 空吞清理错误。
- 存量三个记忆调用者回调可以继续忽略新增参数：`api/features/memory/{changes,personal}.ts`、`worker/personal-memory.ts`。本轮只验证其行为，除类型确实迫使外不改这些业务文件；禁止把它们改为在持有某 memory key 时再经 pool 取得相同 key。

### 2. 数据库：`packages/db/src/repo/{agents,chat}.ts`

```ts
// 沿用 ConversationSandboxTarget 的数据语义，不引入 SDK/Redis 类型。
interface ConversationSandboxTarget {
  conversationId: string;
  sandboxIds: string[];
}
interface AgentDeletionInput {
  id: string;
  access: AccessFilter;       // agents.delete
  readAccess: AccessFilter;   // 当前 dependenciesOf('agents.delete') 的 agents.read
}
interface AgentDeletionSnapshot {
  id: string;
  slug: string;
  ownerBusinessId: string;
  parentId: string | null;
  enabled: boolean;
  childIds: string[];         // 全部直接子级；影响解绑与活动集合
  affectedAgentIds: string[];
  targets: ConversationSandboxTarget[]; // 只含自身会话，不含子级会话
}
prepareAgentDeletion(db: Database, input: AgentDeletionInput): Promise<AgentDeletionSnapshot | null>;
deleteAgent(
  db: Database,
  input: AgentDeletionInput & { expected: AgentDeletionSnapshot },
): Promise<boolean>;

interface ConversationDeletionInput { id: string; access: AccessFilter }
interface ConversationDeletionSnapshot {
  id: string;
  agentId: string;
  agentSlug: string;
  createdBy: string | null;
  targets: ConversationSandboxTarget[]; // 即使 sandboxIds=[]，也保留会话身份
}
prepareConversationDeletion(
  db: Database,
  input: ConversationDeletionInput,
): Promise<ConversationDeletionSnapshot | null>;
deleteConversation(
  db: Database,
  input: ConversationDeletionInput & { expected: ConversationDeletionSnapshot },
): Promise<boolean>;
```

每个 `prepare*` 自己开短 tx A；每个 `delete*` 自己开短 tx B，不接受网络回调。内部查询 helper 复用在 A/B，比较只做这两种实际快照，不新增通用 snapshot/version 框架。二者都先 `lockAgentBindings`，再按既有行锁序；调用方已持 session lock时因为是同连接可重入，普通 SQL 调用也保持原锁序。

目标快照按 conversationId 排序，sandboxIds 去重排序；childIds/affectedAgentIds 去重排序。B 必须重读并比较实体身份/归属/slug 与这些**完整集合**，不是计数或子集判断。新建/删除会话、增加/替换 sandboxId、父子集合或实体归属变化均拒绝删除；这些集合有入口不经过绑定锁（例如附件预建 conversation 与 branch），因此重核不是假设性扩展。B 用 agent 行 `FOR UPDATE` 保护 agent 删除时的外键目标集合，conversation 维持既有行锁；集合比较与 DELETE 在同一短事务内完成。

主体 SQL 最小整合：

- agent：复用 `listAgents` 的现有 scope 谓词（确需复用时提为本文件私有函数），A/B 查询和最终 DELETE 都带 ID + `access`；`agents.delete` 当前合法 scope 是 `owned_agents` / `platform`，不以 can_use/can_maintain 扩大删除权限。同时按 `readAccess` 保留现有 `agents.read` 依赖；比较 owner 变化，避免 A 后转交仍沿用旧授权。没有匹配返回 null/false，不返回别人的正文或目标。
- conversation：复用 `conversationAccessWhere`；`platform` 或 `createdBy === businessId` 的 `own_data`，服务创建会话 createdBy=null 只有 platform。A/B 和 DELETE 不能只带会话 ID。HTTP 删除另保留当前 `loadConversation` 的 conversations.read 校验；删除 SQL 用 **conversations.delete** 的 filter，不能把 read filter 当 delete filter。
- API `AccessFilter` 由当前请求已加载的 principal/grants 构造；B 重核的是当前对象所有权/成员关系与这些授权范围，保持既有请求内授权快照语义，不在本次引入全仓库 grant 热撤销协议。
- agent 级联只删除目标 agent 自身会话，子 agent 行和子级记忆保留；B 的目标会话查询是已经按主体校验后的父实体的级联集合，不另外要求拥有每个级联会话正文的读权限，也不把集合返回给用户。

### 3. API：新增一处小型业务编排，替换两个 handler 与内部回滚调用

允许新增 `packages/api/src/features/runtime-deletion.ts`，因为 agent 与 conversation 两个真实调用方复用“同连接锁 → A → ACK → B”，db 不拥有这一业务顺序；不建目录树/注册系统/通用协调器。

```ts
deleteAgentWithSandboxes(input: {
  pool: DbPool;
  redisUrl: string;
  deletion: AgentDeletionInput;
}): Promise<AgentDeletionSnapshot | null>;

deleteConversationWithSandboxes(input: {
  pool: DbPool;
  redisUrl: string;
  deletion: ConversationDeletionInput;
}): Promise<ConversationDeletionSnapshot | null>;
```

两个函数内部通过 `withAdvisoryLock(pool, AGENT_BINDINGS_LOCK_KEY, async (lockedDb) => ..., 40_000)` 完成顺序，所有 repo 调用使用 `lockedDb`。A 为 null 直接返回；ACK 不成功不调用 B；B false 按不存在返回；成功返回已匹配的快照，供 handler 在 helper 解锁后定位目录。返回快照不是重新取对象；不让 rm 依赖删除后再查询已不存在的 agent，也不使用锁外旧 slug。不要把 FastifyRequest、authorize 或 Redis回调传入 db。

- `packages/api/src/features/agents/routes.ts` DELETE：保留 `authorizeAgent` 及依赖/跨用户审计，构造 delete/read 两个 filter，调用新编排；成功后用返回 slug 清 sdk-sessions、session-sandboxes、conversation-outputs、conversation-inputs。
- `packages/api/src/features/chat/routes.ts` DELETE：保留当前 read 授权，补用 conversations.delete filter 调新编排；成功后用返回 agentSlug/id 清目标会话四类 runtime 目录，不再在提交后查 slug。
- 同文件旧 `deleteConversation(app.db, id)` 还有四处真实调用：附件预建会话的 agent 不存在分支、附件写入失败、admit 失败、branch 文件回滚。全部随签名替换，不能漏编译点，也不能留下绕过关闭的新默认参数。调用新 conversation 编排，主体限定为本次创建者 businessId 的 own_data，只接受当前请求刚生成的 exact conversationId，不伪造 platform scope；这属于既有创建失败补偿授权，不要求用户另有 DELETE 叶。已有 `.catch` 保留原始错误/日志语义，不扩大成随意删除已有会话的内部入口。
- 回滚测试应证明删除时仍检查活动与目标快照；如果新会话已产生 queued/running，继续拒绝，不能为“只是回滚”豁免保护。
- `packages/api/src/queue/session-cleanup.ts` 复用现有协议/normalizeTargets；把总 timeout 从建立 Redis 连接/订阅前开始计算，subscribe/publish/ACK 共用既有 10s deadline，不能等 subscribe 无限重连后才开始 ACK 计时。不为此增加新生产参数。

### 4. worker 关停：`packages/worker/src/index.ts` 与必要的 cleanup close

保留当前 provider close 中的顺序与 `finally { await provider.destroyAll(); }`。cleanup drain `waitClose(..., SESSION_CLEANUP_TIMEOUT_MS)` 返回 false时，记录一个 Error；仍尝试 `sessionSandboxes.close()` 与 finally 的 destroyAll；完成这些清理后抛出 drain Error，让现有 `runShutdown.attempt(provider)` 设置 failed、记录 error并返回 1。若关闭另有失败，保留可观察的原错误/聚合原因，不能被 warning 代替。

`waitClose` 对 rejection 也返回 true，**不能把 true 当成功**：传入 promise 的 rejection 必须显式收集并在 provider close 末尾抛出。否则 cleanup.close 失败仍可能 exit 0。这里修局部调用，不重构整个 shutdown 框架。

`packages/worker/src/sandbox/session-cleanup.ts` 可最小修改 `close`：先停止新请求，限定 drain 等待；无论成功/超时/失败都释放这两个新增 Redis连接。避免外层等待超时后，内部 `Promise.allSettled(inFlight)` 永远挡住 disconnect。保持单一 deadline（可以给已有 close 增加本地 `timeoutMs` 参数，生产传 shared 10s；测试传短值），不新增常驻 timer/轮询。超时必须 reject，被 provider failure 路径记录；迟到 ACK 不得变成 API 删除成功。

`runShutdown` 现有 provider.destroyAll 的行为和预算不借本次重写；本新增 cleanup drain 不能让已有限的路径变成无限 await。保留现有关停回归，新增 cleanup rejection 与永不 resolve 的 failure 注入。

## 有限等待与失败结果

- `pool.connect` 保留现有 `connectionTimeoutMillis=5_000`。本轮不调整全局池策略。
- session 取锁/释放及连接设置恢复：5s；短事务语句保留 15s statement timeout、5s lock timeout；禁止 `statement_timeout=0`。每个事务是固定有限 SQL 步骤，不循环重试/换池重试。设置恢复失败销毁连接。
- Redis 连接、订阅、发送和 ACK 共享现有 `SESSION_CLEANUP_TIMEOUT_MS=10_000` 截止；全局绑定锁跨越 tx A + 最多 10s ACK + tx B + unlock，**删除持锁总预算 40s**，超时销毁 client，不把总持锁时间误写成严格 10s。竞争准入还受其现有 15s statement timeout 约束，可能得到可重试基础设施失败。40s 是本次删除局部上限，不新增环境配置、不调整 memory 持锁预算；deadline 临近 COMMIT 的结果未知情形仍按下一条处理。
- ACK 超时、worker 不在线/失败、持锁 client 在 A 后断开：B 不提交，实体和目录保留，使用现有 `SERVICE_UNAVAILABLE` / retryable Problem；关闭过的 idle 容器不恢复，可在下次正常运行重建。
- A/B 不存在或范围不符 404；queued/running 或快照变化 409；不加新错误码。
- B 提交前 SQL 异常：回滚；断线丢失 COMMIT 回应则结果未知，不能声称“必定回滚/实体必在”。保留全部目录、记录 requestId/实体身份并返回失败；不加持久状态或自动补偿。
- B 已确认提交、随后 unlock/reset 失败：行已经删除，不能称可回滚；销毁连接、保留目录并报告服务失败/清理日志。这与“断线发生在 ACK 等待期间则实体保留”的测试分开。
- 正常提交并成功解锁后 rm 失败：保留既有 best-effort warning 与成功响应，不声称凭据绝无残留；日志含路径身份但不含 secret。

## 引入即替代与文件交接

后续执行可改的源码范围：

- `packages/db/src/client.ts`、`packages/db/src/repo/locks.ts`、`packages/db/src/repo/agents.ts`、`packages/db/src/repo/chat.ts`；只在实际导出需要时动 `packages/db/src/repo/index.ts`。
- `packages/api/src/features/runtime-deletion.ts`（上述唯一新增编排文件）、`packages/api/src/features/agents/routes.ts`、`packages/api/src/features/chat/routes.ts`、`packages/api/src/queue/session-cleanup.ts`。
- `packages/worker/src/index.ts`、`packages/worker/src/sandbox/session-cleanup.ts`；不改 sandbox provider 能力。
- 测试见下表；允许小型同文件 fixture/现有 responder 更新，不加独立运行服务。

接线者先交接三个共享源码文件，执行者再写；db 锁/签名先固定，API 与 worker 在互斥文件中可并行，最后合并验证。删除原 `BeforeDeleteSandboxes`、两处 repo `beforeDelete` 参数/注释与对应 route callback；`ConversationSandboxTarget` 若仍被快照使用则保留，不留无人使用导出。全仓库 `rg` 确认全部调用点与测试完成迁移。旧 `delete-sandbox-hook.test.ts` 就地改为两段事务/快照行为测试，避免为了文件名新造平行测试套件。

原合同写入者交接后需把 R5.3/5.4 与 integration 的旧事务回调和无界关停示例替换成本文约束；本文不越权编辑其文件。SECURITY/主记录仍交主任务既定文档 owner，不把此次只写 revision 误报为其他文档已同步。

## 必须完成的真实验证矩阵

所有 PG/Redis 使用 backend globalSetup 的随机隔离库/独享 Redis。Docker 沿用现有测试 image fixture 与三项行为，不启开发 worker、不用开发库或真实 secret。延迟/失败注入用 promise barrier，在确定到达 ACK 等待后观测，不靠固定 sleep 猜顺序。

| 文件/层 | 必要证据 |
|---|---|
| `packages/db/test/delete-sandbox-hook.test.ts`（就地替换） | 两入口 A/B 活动保护与主体 SQL；A 后 B 前实体可见；目标 canonical 集合一致才删；新增/减少 conversation、增加/替换 sandboxIds、owner/parent 变化拒绝，目录不动；不允许 beforeDelete 回调 |
| 同文件或一个必要的 `packages/db/test/locks.test.ts` | 持锁 client PID 与 A/B `pg_backend_pid()` 相同；pool max=1 完成两个事务而不自锁；第二连接同键 xact lock 被排斥；unlock false/throw、reset throw、acquire timeout 用真实 PG/窄故障注入证明 release(true)，后续池用户不会继承锁；已有 memory 调用可继续工作 |
| `packages/api/test/delete-lifecycle.test.ts` | 真 HTTP agent/conversation 成功在 ACK 后，失败 503、scope 404、活动 409；延迟 ACK 时通过独立 PG 连接查删除 PID `state='idle' AND xact_start IS NULL` 并查 `pg_locks` 仍持 advisory；同时准入不得在 ACK/B 间成功，失败释放后可恢复，成功释放后目标准入得到不存在 |
| 同 HTTP 生命周期套件 | ACK barrier 期间从控制连接 `pg_terminate_backend(删除PID)`，再放行 ACK：DELETE 失败、实体/目录保留、绝无换池后继续删；再主动重试可成功。此用例杀隔离测试连接，不杀开发会话 |
| 同 HTTP 生命周期套件 | ACK 等待时从另一连接新建无 run 会话/改变目标 sandboxId，B 409 且不删；变更 owner 后 scope 404；agent 删除不碰 child/personal/agent-memory 与其他 agent，会话删除保留其他会话；rm 失败日志语义不倒置提交结果 |
| `packages/api/test/session-cleanup.test.ts` | subscribe 永不完成/失败、publish 失败、worker 无监听、ACK 超时/丢失/迟到均受同一 10s deadline（测试短预算），释放 Redis；成功 ACK 只匹配本请求 |
| `packages/worker/test/session-cleanup-channel.test.ts`、`session-sandboxes.test.ts` | 原 idle-only、active/lease/acquirePending、重复 persisted ID、部分失败、重启后 ID 关闭、过期请求保护继续通过；新增 close drain reject/永不完成仍有限释放连接 |
| `packages/worker/test/shutdown.test.ts`（必要时 `reconcile-shutdown.test.ts`） | cleanup drain timeout/rejection 都经既有 runShutdown 错误机制返回 1；sessionSandboxes.close 与 provider.destroyAll 仍被执行；成功 drain 返回 0；验证挂起 promise 不阻塞退出预算，不能仅检索日志字符串 |
| `packages/worker/test/session-cleanup-docker.test.ts` | 把 deleteWithClose 改为新 API 编排/同一真实顺序，重跑既有 Docker 3：idle supervisor 关闭后才删行与目录、销毁失败保留并可重试、重启失去 entry 后按 persisted ID 关闭；不得继续保留旧 callback 只为使 Docker 测试绿 |
| 既有 API 回归 | `chat-attachments.test.ts`、`conversations.test.ts`、`agents-access.test.ts`、`chat-admission.test.ts`：四个补偿调用和 read/delete scope 不回归；记忆相关既有测试按 helper 新影响定向补跑 |

`pg_stat_activity` 采样通过独立连接/新语句获取，不能沿用观察者长事务的缓存快照；记录 PID、state、xact_start、对应 advisory key 与先后事件，不输出任何 secret。上述并发/连接故障证据必须真实 PG + Redis，mock 只补 unlock/reset 等难触发的小分支，不能替代主链路。

实施后从本树执行（不是本轮通过记录）：

```sh
pnpm --filter @agentport/db typecheck
pnpm --filter @agentport/api typecheck
pnpm --filter @agentport/worker typecheck
pnpm exec vitest run --project backend packages/db/test/delete-sandbox-hook.test.ts packages/api/test/delete-lifecycle.test.ts packages/api/test/session-cleanup.test.ts packages/worker/test/session-cleanup-channel.test.ts packages/worker/test/session-sandboxes.test.ts packages/worker/test/shutdown.test.ts packages/worker/test/reconcile-shutdown.test.ts packages/worker/test/session-cleanup-docker.test.ts
pnpm exec vitest run --project backend packages/api/test/chat-attachments.test.ts packages/api/test/conversations.test.ts packages/api/test/agents-access.test.ts packages/api/test/chat-admission.test.ts packages/api/test/personal-memory.test.ts packages/api/test/memory-changes.test.ts packages/worker/test/personal-memory.test.ts
rg -n 'BeforeDeleteSandboxes|beforeDelete' packages/db packages/api packages/worker
```

新增 locks 测试与已存在的 memory 定向套件由执行者按实际文件名加入第一组命令，不写不存在路径来冒充可执行证据。Docker 3 历史报告 `/tmp/agentport-architecture-runtimeB-docker3.json` 可复用其场景/fixture，但因调用顺序更改必须产生新的结果；与本修改无关的既有通过不重复全量扫。最终证据写清 pass/fail/skipped 与真实 PG/Redis/Docker 是否运行。没有这些结果前，不标 R5 通过。

## 官方依据（2026-10-31 核对）

- [PostgreSQL §13.3.5 Advisory Locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)：session lock 跨事务、显式释放或 session 结束释放；相同 identifier 的 session/xact lock 跨 session 互斥，同 session 重入可成功。这正是 A/B 同 client 的依据；断线释放锁不是允许换池继续删除的依据。
- [node-postgres Pool](https://node-postgres.com/apis/pool)：事务必须用同一 checked-out client；`pool.query` 会分配可用连接。`client.release(true)` 销毁连接，不回池；`connectionTimeoutMillis` 提供取连接的有限等待。
- [node-postgres Client](https://node-postgres.com/apis/client)：连接可能在 idle 时因网络/后端故障断开，使用 `error` / `end` 处理；有 `statement_timeout` / `query_timeout`，不能假定原 client 自动重连且保留 session lock。
- [Drizzle PostgreSQL](https://orm.drizzle.team/docs/get-started-postgresql)：可复用既有 node-postgres 连接对象。该官方页当前示例明确展示 Pool；PoolClient 能力另外核对本地已装 `drizzle-orm@0.45.4` 的 `node-postgres/session.d.ts`（`NodePgClient`）及 `driver.d.ts`（`drizzle<TSchema,TClient>`），不冒称网页已经给出 PoolClient 示例。现有 driver transaction 实现在 client 模式不会重新 pool.connect。
- [PostgreSQL pg_stat_activity](https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-ACTIVITY-VIEW)：`idle` 等待新命令，`idle in transaction` 仍有打开的事务；`xact_start` 在无活动事务时 null。作为 ACK 等待阶段必须真实观测的判据。
- [PostgreSQL timeout 设置](https://www.postgresql.org/docs/current/runtime-config-client.html)：statement_timeout 限制语句执行，lock_timeout 限制每次取锁等待，0 禁用；本次保留有限值，不全局调大或关闭以迁就网络事务。

本修订只改变 PG 锁/事务和既有关闭通道编排，不改变 Claude Agent SDK 参数、memory 文件约定或模型执行方式，因此不重新开展 SDK 全审。下一步是共享源码 owner 交接后按本文实施、取得新增行为证据，再由独立 Opus 按固定差异终审。
