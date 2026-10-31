# 账户与 RBAC 实施契约

> 2026-10-31；实现基线 `fed3e5af303f748649448dbbeaa0baf8a6ea0b2c`；发布分支 `release/account-rbac` 基于 `origin/main` `8abdbe5a18753ea3db5a34fd1b8f7ee0b8ca17a5`。本文件是本任务跨代理接口的唯一实施契约；本工作树已按此实现并通过最终 review，准备发布（尚未合入 main）。术语“专家”对应现有 `agents`，不另造资源体系。源码代理不得自行改公共签名或权限语义；需要变化先交架构所有者更新此文件，再通知调用方。

## 1. 实施范围与官方依据

复用 Better Auth 1.7.14、username、Drizzle、现有 Fastify Zod/schema、统一 AppError、shared、TanStack Query/Router 和 shadcn。无新增生产依赖。2026-10-31 核对官方文档：

- https://www.better-auth.com/docs/concepts/database ：additionalFields 的 `input:false` 表示服务端持有，应用写入数据库；数据库约束仍由 Drizzle 明确声明。
- https://www.better-auth.com/docs/plugins/admin ：插件角色由代码 access control 定义、用户 role 保存分配；不能直接满足本期 DB 动态功能矩阵。不引入 admin 插件，不把其静态 role 当业务权限。
- https://www.better-auth.com/docs/concepts/users-accounts ：保留现有账户/会话模型。

在线页面未提供 1.7.14 固定快照，执行者须以锁定版本本地类型核对 additionalFields 配置；不升级版本。账户管理复用既有 `hashPassword` 与 Drizzle 事务写 credential account，不新增公开注册入口。本期不改变 SDK 配置、官方文件目录或专家 auto-memory 读写能力，因而不新增 SDK 能力设计。

不做：企业连接器、用量、组织/租户、策略表达式、资源发布/审核体系、恢复脚本框架、预置空适配器。全局资源继续沿用现有绑定关系；授权用户运行专家时可使用已绑定资源，不能因此查看原始配置、密钥或管理全局资源。

## 2. 稳定身份与账户生命周期

`authUsers.id` 是 Better Auth 随机技术 ID；每次重建都生成新值。`authUsers.businessId` 为 NOT NULL UNIQUE、`additionalFields.businessId={type:'string',required:true,input:false}`。禁止把 businessId 用作 auth ID，禁止请求直接指定技术 ID。认证 account/session 外键仍引用 authUsers.id 并 cascade；除此之外所有业务人员关联不引用 authUsers。

人员关联直接保存 businessId 文本，不 FK authUsers，不新增身份登记/墓碑表。businessId 由管理员录入，用户名与业务 ID 分离；业务 ID 创建后不可修改、不可回收给其他自然人。长度 1..160 个 Unicode 字符，拒绝任何空白、控制字符和首尾空白，不自动 trim 或大小写折叠；不强制 ASCII、namespace 或三段拼串格式。当前账户 businessId 唯一；历史业务记录重复出现同一 ID 正是同一人的关联。未来来源 scope、企业或外部 subject 的映射到实际接入时再记录，不在本期强加编码协议。

删除账户 = 事务删除该技术 user 的 sessions/accounts/user，保留 userRoles、agent owner/member、业务内容及个人目录。列表使用业务 ID 为主、LEFT JOIN 当前账户取名称；找不到名称就显示 businessId，不加姓名快照。服务端从 userRoles、agent createdBy/owner/member、会话/运行/定时/评估及个人偏好/记忆记录查询历史 businessId；创建历史身份必须显式 restore:true，否则409，界面确认“恢复原身份和授权”。restore:true 但无历史则409；无需身份查询端点或身份表。原 roleIds 未传时保留历史分配，不能隐式重置。旧技术 ID/token 永不复用；保持 DB session 校验，不开启 cookieCache/stateless session。密码重置撤销全部旧 sessions；权限每请求从 DB 加载。

`authUsers.disabled` 是 NOT NULL DEFAULT false 的服务端 boolean（additionalFields 同样 input:false）；Account.status 为 active/disabled。停用事务置 disabled=true 并撤销全部 sessions；登录、requireAuth 与 worker 启动检查均拒绝停用账户，重新激活不恢复旧 cookie。本人改密码校验旧密码后更新 credential 并撤销全部 sessions，返回后重新登录；复用 Better Auth 锁定版本 API/密码实现，不新造哈希协议。

bootstrap 仅首次安装：优先复用已有 DB settings/kv 的持久初始化 marker；基线没有通用 kv 时保留必要的 `platformBootstrap` 单行标记，不增加 businessIdentities。事务内先看 marker，再检查当前 authUsers 是否已有关联系统管理员角色的账户：已有则只记初始化完成，不改其密码/身份/角色；无管理员且未初始化时才用环境配置创建随机技术 ID 管理员（businessId 使用普通稳定值 `bootstrap-admin`）、四默认角色及授权。已初始化永不因删除普通用户或清理认证资料重播环境密码。空/弱密码沿用现有配置验证。系统 admin 角色不可删除/改矩阵，可改显示名；其他默认及自定义角色可编辑。账户停用/删除、角色移除及矩阵整体保存须在同一事务保证至少一个未停用账户持有系统 admin，否则409 CONFLICT；不加恢复工具。

## 3. shared 唯一导出

由 shared + DB writer 新增 `packages/shared/src/access.ts` 并从现有 `index.ts` 导出；共享身份、权限、账户/角色/成员 API 的 Zod schemas 和以下类型，其他单元只消费。

```ts
export type BusinessId = string;
export type AccessScope = 'own_data' | 'authorized_agents' | 'maintained_agents' | 'owned_agents' | 'platform';
export type PermissionGrant = { permissionId: PermissionId; scope: AccessScope };
export type ExecutionSubject =
  | { kind: 'user'; businessId: BusinessId }
  | { kind: 'service'; serviceId: 'system' | 'mcp' };
export type Principal =
  | { kind: 'user'; authUserId: string; businessId: BusinessId; username: string; name: string;
      roles: RoleSummary[]; grants: PermissionGrant[] }
  | { kind: 'service'; serviceId: 'system' | 'mcp' };
export type AccessResource = { agentId?: string; createdBy?: BusinessId | null; privateContent?: boolean };
export type PermissionDefinition = { id: PermissionId; label: string;
  treePath: readonly string[]; scopes: readonly AccessScope[] };
export type RoleMatrix = { revision: number; roles: Role[] };
export type RoleMatrixInput = { expectedRevision: number;
  roles: { id?: string; name: string; grants: PermissionGrant[] }[] };
export type RoleSummary = { id: string; name: string; systemKey: 'admin' | 'user' | 'owner' | 'maintainer' | null };
export type Role = RoleSummary & { grants: PermissionGrant[]; createdAt: string; updatedAt: string };
export type Account = { businessId: BusinessId; username: string; name: string;
  status: 'active' | 'disabled'; roles: RoleSummary[]; createdAt: string };
export type AgentMember = { businessId: BusinessId; name: string; accountActive: boolean;
  canUse: boolean; canMaintain: boolean };
export type AgentAccess = { agentId: string; permissionIds: PermissionId[] };
export type AuthMe = { authenticated: false } | { authenticated: true;
  user: { businessId: BusinessId; username: string; name: string };
  roles: RoleSummary[]; grants: PermissionGrant[] };
export const PERMISSIONS: readonly PermissionDefinition[];
export const DEFAULT_ROLES: readonly { systemKey: NonNullable<RoleSummary['systemKey']>;
  name: string; grants: readonly PermissionGrant[] }[];
```

`PermissionId` 从同一 `PERMISSIONS` 字面量目录推导，不另维护字符串 union；本文件使用表为它的确定输入。API schemas 拒绝未知 permissionId、该叶不允许的 scope、重复 permissionId+scope。一个叶可有多个 scope，DB 一行一个 grant；角色矩阵单元格为该叶的一组 scope，空数组=未授权。父节点只做 UI 聚合，不入库、不新增虚拟权限，不将父级选中当鉴权依据。

### 3.1 叶权限目录与允许范围

缩写：O=own_data（本人数据），A=authorized_agents（被授权专家），M=maintained_agents（维护专家），W=owned_agents（负责专家），P=platform（全平台）。下表每个逗号分隔项是独立叶 ID，禁止把 eval 与 schedules 合并。

`treePath` 是从业务根到叶父节点的有序数组（下表 `/` 分段），label 为具体叶动作；前端直接据此构建任意深度树，不能退回单一 group 扁平目录。每行多个 ID 仍分别产生独立叶及动作标签。

| treePath | 叶 permissionIds | 允许 scope |
|---|---|---|
| 工作台/概览 | `overview.read` | O,P |
| 专家/基本 | `agents.read`、`agents.use` | A,M,W,P |
| 专家/创建 | `agents.create` | O,P |
| 专家/配置 | `agents.config.read`、`agents.config.update` | M,W,P |
| 专家/规则 | `agents.rules.read`、`agents.rules.write` | M,W,P |
| 专家/输出风格 | `agents.styles.read`、`agents.styles.write` | M,W,P |
| 专家/完整文件 | `agents.files.read` | M,W,P |
| 专家/资源绑定 | `agents.bindings.manage` | M,W,P |
| 专家/生命周期 | `agents.enable`、`agents.clone`、`agents.import`、`agents.export` | M,W,P |
| 专家/记忆 | `agents.memory.read`、`agents.memory.write` | M,W,P |
| 专家/版本 | `agents.versions.read`、`agents.versions.restore` | M,W,P |
| 专家/管理 | `agents.delete`、`agents.members.manage`、`agents.transfer` | W,P |
| 对话/会话 | `conversations.read`、`conversations.create`、`conversations.update`、`conversations.delete`、`conversations.share` | O,P |
| 执行/运行 | `runs.read`、`runs.approve`、`runs.cancel`、`runs.export` | O,P |
| 执行/运行/交互 | `runs.questions.answer` | O,P |
| 个人/记忆 | `personal_memory.read`、`personal_memory.write`、`personal_memory.review` | O,P |
| 评估/用例与结果 | `eval.read`、`eval.manage`、`eval.execute` | M,W,P |
| 定时/任务 | `schedules.read`、`schedules.manage` | M,W,P |
| 资源/MCP 服务/定义 | `servers.read`、`servers.create`、`servers.update`、`servers.delete`、`servers.import`、`servers.test` | P |
| 资源/MCP 服务/令牌 | `servers.tokens.read`、`servers.tokens.rotate` | P |
| 资源/MCP 服务/工具 | `servers.tools.manage` | P |
| 资源/技能/定义 | `skills.read`、`skills.create`、`skills.update`、`skills.delete`、`skills.import` | P |
| 资源/技能/文件 | `skills.files.read`、`skills.files.write` | P |
| 资源/插件/包 | `plugins.read`、`plugins.import`、`plugins.install`、`plugins.update`、`plugins.delete`、`plugins.export` | P |
| 知识库/库与内容 | `knowledge.read`、`knowledge.create`、`knowledge.update`、`knowledge.delete`、`knowledge.content.manage` | P |
| 知识库/执行 | `knowledge.execute`、`knowledge.publish` | P |
| 知识库/来源 | `knowledge.sources.manage` | P |
| 知识库/模型 | `knowledge.models.manage` | P |
| 知识库/包 | `knowledge.import`、`knowledge.export` | P |
| 资源/运行环境/定义 | `runtime_environments.read`、`runtime_environments.create`、`runtime_environments.update`、`runtime_environments.delete` | P |
| 资源/运行环境/版本 | `runtime_environments.build`、`runtime_environments.publish` | P |
| 资源/市场 | `market.read`、`market.install` | P |
| 平台/运维 | `operations.read`、`operations.manage` | P |
| 平台/审计 | `audit.read` | P |
| 平台/账户 | `accounts.read`、`accounts.manage` | P |
| 平台/角色 | `roles.read`、`roles.manage` | P |

这些叶对应既有实际动作，不增加产品能力：servers.test/rotate-token/tools、skills/import/files、plugins/import/install/export、knowledge 的检索/处理/wiki 执行、既有发布动作、来源/模型/包，以及 runtime 的版本构建/online-version 分别映射上述叶。实施入口登记逐条沿现路由确认：不存在的动作不得为凑权限新建 API；现有未覆盖入口必须先补对应真实叶再接线。`operations.manage` 仅覆盖既有运维控制，不能承接上述任何资源管理动作。配置更新禁止夹带启停、规则、样式、绑定等其他叶字段；旧组合 PATCH 按实际字段逐项授权，整体拒绝越权请求。

不再使用 agents.update。`agents.read` 只开放必要业务摘要；config/read、rules/read、styles/read、files/read、memory/read、versions/read 分开检查，不能通过完整文件/导出接口绕过正文权限：完整文件和导出须同时具备所含配置、规则、样式、记忆读取叶，缺一则拒绝，不静默泄漏。绑定只允许选择已有资源摘要，原始配置/密钥仍需资源自己的 read/token 权限；内嵌新增全局资源要求其 create。主/子智能体绑定校验两侧范围。clone 额外要求 agents.create O/P；import 新建同样要求 create，覆盖则要求目标 config.update 及实际覆盖的规则/样式/绑定等写叶。

### 3.2 四默认角色（精确种子）

令 U 为以下逐项 grants：`overview.read` O；`agents.read` A、`agents.use` A；`conversations.read/create/update/delete/share` 各 O；`runs.read/approve/cancel/questions.answer/export` 各 O；`personal_memory.read/write/review` 各 O。斜线列举仅是本文缩写，最终均展开为完整叶 ID。

令 C 为以下确定的专家维护叶集合：`agents.read`、`agents.use`、`agents.config.read`、`agents.config.update`、`agents.rules.read`、`agents.rules.write`、`agents.styles.read`、`agents.styles.write`、`agents.files.read`、`agents.bindings.manage`、`agents.enable`、`agents.clone`、`agents.import`、`agents.export`、`agents.memory.read`、`agents.memory.write`、`agents.versions.read`、`agents.versions.restore`、`eval.read`、`eval.manage`、`eval.execute`、`schedules.read`、`schedules.manage`。

- admin：目录所有叶各 P，系统种子同步；create 仍设本人 owner。
- user：恰好 U，支持本人常规会话 CRUD/分享、停止自己的运行、审批和回答问题；无专家配置读取。
- owner：U + agents.create/O + C 中每叶 W + agents.delete/members.manage/transfer 各 W。
- maintainer：U + C 中每叶 M；无 create/delete/members.manage/transfer 或任何全局资源权限，因此 clone/import 新建仍受 create 前置限制。

prefix 只能作为种子生成辅助，生成后必须校验并保存具体 permissionId+scope；鉴权、API、DB 禁止 `*` 或前缀匹配。自定义角色也只能选目录中的精确叶。安全依赖：写配置/规则/样式/记忆/版本恢复/绑定/启停须具对应读取视图（配置读、规则读、样式读、记忆读、版本读等）及 agents.read，同一对象和相应 scope 下均成立；eval/schedules.manage/execute 需各自 read；其余资源写需其 read；accounts.manage 需 accounts.read，roles.manage 需 roles.read。矩阵保存入口校验依赖并返回 INVALID_INPUT 指出缺失叶，不擅自扩权；种子满足依赖。用户运行 O 还须目标 agents.use，撤权不能继续访问。成员标记不自动赋角色：canUse 配合 A grants、canMaintain 配合 M grants；管理员另配对应动态角色。

安全依赖按作用对象检查，不要求创建 O 与读取 A 使用相同 scope：agents.create 仅需 agents.read A/M/W/P 的可用视图；其余专家写操作要求同对象 agents.read 加对应视图叶。versions.restore 需 versions.read 及 config.read，并按恢复覆盖内容复核 rules/styles/bindings 等写叶；bindings.manage/enable 需 config.read。资源 create 需该资源 read/P。缺失依赖在保存时返回 INVALID_INPUT，运行时同样求值，不能靠另一个对象的读取 grant 拼接。

## 4. 对象范围及隐私语义

每次判定针对一个真实 DB 对象：存在同一条 grant 同时匹配 permissionId 和该对象 scope 才允许。禁止先合并角色“有某能力”再合并另一个角色“有某范围”。P 仅对该 grant 的叶生效；其他叶不会跟随升级。

- O：数据 createdBy/initiatedBy/sender 或个人记忆 businessId 等于当前 businessId；创建专家用本人作为新对象 owner。
- A：目标 agent 的 owner 为本人，或成员 canUse=true。M：owner 为本人或成员 canMaintain=true。W：agents.ownerBusinessId=本人。P：任意对象，仍须真实对象存在。
- 负责人管理 A 专家，不因此管理 B；维护 A 专家不因此转交 A。授权撤销后列表、详情、SSE、输出下载、附件、分享管理、run 问答/审批/取消都重新检查真实父对象，不信 URL 里的 agentId 或前端筛选。
- 会话正文、消息、transcript、运行 prompt/output/tool 参数、附件及产出均 privateContent。只能本人 O 或相应叶 P；M/W 不开放私人内容。平台管理员跨用户读取必须写审计（目标 businessId、对象 ID、动作、requestId；不把正文/密码/token 写审计）。默认不新增任意用户个人记忆管理路由，管理员若读取已有对象也须相应 P 并审计。
- 评估用例、评估结果、定时 prompt 是专家维护资料，M/W/P 可读；由它们产生的私有运行正文依 runs.read O/P。它们不应嵌入其它用户对话；相关 run 链接可因无权限不可打开。
- 列表必须在 repo 查询中约束后分页/count，禁止读取全量后截页再过滤。跨对象统计同样约束；不返回其他用户的标题/数量/搜索片段。未知或不属于范围的对象统一 404；已知功能级拒绝 403；无会话 401。
- 分享公开访问仍按现有 share token/有效期，只返回被分享产物，不扩展成账户权限。独立 MCP 原有 token 校验保留，只允许 MCP 暴露的工具与指定专家调用，不能获得网站管理权限。run 短 token 的原绑定范围不变。

## 5. DB 字段与仓库接口

单一 writer 拥有 `packages/db/**`、全部 DB repo、迁移、`packages/shared/**`。SQL 命名沿用 snake_case，API/TS camelCase。新实体 ID 用现有 `newId`，为 role 增加 entity 前缀；复合关联无额外 ID。

| 表 | 字段/约束 |
|---|---|
| `authUsers` | 新 businessId text NOT NULL UNIQUE（无业务身份 FK）、disabled boolean NOT NULL DEFAULT false；两字段均 additionalFields input:false |
| `platformBootstrap` | 仅无既有 settings/kv 时保留；id 固定 initial、adminBusinessId text、initializedAt、rolesRevision integer NOT NULL DEFAULT 0；不连 authUsers。marker 与矩阵 revision 可同处保存，不为 revision 另建表 |
| `roles` | id PK、name NOT NULL UNIQUE、systemKey nullable UNIQUE（admin/user/owner/maintainer）、createdAt、updatedAt |
| `rolePermissions` | roleId -> roles CASCADE、permissionId text、scope text；复合 PK 三列；schema/入口限定目录值 |
| `userRoles` | businessId text NOT NULL（无人员 FK）、roleId -> roles CASCADE；复合 PK |
| `agentMembers` | agentId -> agents CASCADE、businessId text NOT NULL（无人员 FK）、canUse boolean、canMaintain boolean、createdAt；复合 PK，至少一个 true |
| `agents` | createdBy businessId NOT NULL、ownerBusinessId NOT NULL，均不连 authUsers；owner 查询索引 |
| `conversations` | createdBy businessId nullable、serviceId nullable；恰有一个非空；保留业务专家外键 |
| `messages` | senderBusinessId nullable；用户自然人消息直接存业务 ID，assistant/tool 与服务输入为 null；服务输入由 conversation/run 服务主体追溯 |
| `agentRuns` | subjectKind user/service NOT NULL、initiatedBy businessId nullable、serviceId system/mcp nullable；判别约束保证 user 时仅 initiatedBy 非空，service 时仅 serviceId 非空 |
| `agentSchedules` | createdBy businessId NOT NULL、executeAsBusinessId NOT NULL；新建两者均当前用户，普通编辑不能改执行主体 |
| `evalCases` / `evalRuns` | createdBy businessId NOT NULL；eval run 的执行主体就是 createdBy |
| `userPreferences` / `memoryReviews` / `memoryChanges` | 现 userId 统一改 businessId，去掉 authUsers CASCADE；原唯一键/索引/锁参数随之更名 |
| `auditLog` | actor 保存 businessId 或明确服务/anonymous 标识；新增 actorKind=user/service/anonymous、subjectBusinessId nullable（跨用户目标）；失败登录用户名放脱敏 metadata/现摘要，不冒充已认证 actor |

以上人员字段不得 authUsers FK；业务实体之间原本的 FK/删除策略保持。角色/成员残留离线身份是恢复契约，不是垃圾。鉴权只接受活跃认证 user；离线身份不能登录或自动运行。DB 冲突统一 409（复用现有错误码），schema 不符统一 INVALID_INPUT；不新增错误封套。

仓库从现有 `repo/index.ts` 导出 `access`、`accounts`；下列签名固定，`DbHandle=Database|现有Tx`，返回行采用 shared 类型，时间统一 API ISO 字符串。所有接受业务主体的新 repo 写入参数为必填，无 ADMIN_USER_ID 默认值（历史提法：现行代码已无 `ADMIN_USER_ID`；业务主体来自 `request.principal.businessId`，`ADMIN_USER` 仅用于首次 bootstrap 的用户名，不作鉴权依据）。

```ts
// repo.access
getUserAccess(db: DbHandle, businessId: string): Promise<{ roles: RoleSummary[]; grants: PermissionGrant[] }>;
getAgentRelation(db: DbHandle, agentId: string, businessId: string): Promise<{
  exists: boolean; ownerBusinessId: string | null; canUse: boolean; canMaintain: boolean }>;
getRoleMatrix(db: DbHandle): Promise<RoleMatrix>;
replaceRoleMatrix(db: DbHandle, input: RoleMatrixInput): Promise<RoleMatrix>;
// 一次事务：锁 revision 行、比较 expectedRevision、校验目录/依赖/admin 保留/最后活跃管理员，
// 全量创建/更新角色和 grants、删除省略的非 admin 角色及关联分配，revision+1；任一步失败全部回滚。
// 冲突409，不以逐角色 PATCH 循环代替矩阵原子保存。
setUserRoles(db: DbHandle, businessId: string, roleIds: string[]): Promise<void>;
listAgentMembers(db: DbHandle, agentId: string): Promise<AgentMember[]>;
setAgentMember(db: DbHandle, agentId: string, input: { businessId: string; canUse: boolean; canMaintain: boolean }): Promise<AgentMember>;
deleteAgentMember(db: DbHandle, agentId: string, businessId: string): Promise<boolean>;
transferAgent(db: DbHandle, agentId: string, ownerBusinessId: string): Promise<boolean>;
// repo.accounts
listAccounts(db: DbHandle, input: { q?: string; limit: number; offset: number }): Promise<{ items: Account[]; total: number }>;
hasBusinessHistory(db: DbHandle, businessId: string): Promise<boolean>;
createAccount(db: DbHandle, input: { businessId: string; username: string; name: string; passwordHash: string; restore: boolean; roleIds?: string[] }): Promise<Account>;
updateAccount(db: DbHandle, businessId: string, input: { username?: string; name?: string }): Promise<Account | null>;
setAccountStatus(db: DbHandle, businessId: string, status: Account['status']): Promise<Account | null>;
changeOwnPassword(db: DbHandle, authUserId: string, input: { currentPassword: string; newPassword: string }): Promise<boolean>;
resetPassword(db: DbHandle, businessId: string, passwordHash: string): Promise<boolean>;
deleteAccount(db: DbHandle, businessId: string): Promise<boolean>;
```

createAccount 内部事务查询历史并检查 restore，创建随机 user/account ID、credential、角色；无 identity 写入。新身份 roleIds 未传时赋 user；历史身份未传时保持原分配，显式 roleIds 才替换。setAccountStatus 停用和 resetPassword/changeOwnPassword 的 credential 更新与 session 撤销均为单事务，最后活跃管理员校验同事务执行；本人改密旧密码不符走现认证错误。密码校验/哈希复用 Better Auth；DB writer 若无法在 repo 直接调用官方校验，提供同一事务 handle 给 auth writer 完成，不重复造密码实现。不能隐式恢复管理员密码。username 与 email 维持 Better Auth 唯一性；内部 email 用新技术 ID 派生 `@agentport.invalid`，不增加邮箱输入。

复用 repo.chat/runs/agents/ops/eval 等现接口，按新字段扩展写入 input；不平行再造仓库。共享查询筛选接口固定为 `AccessFilter={businessId:string; scopes:AccessScope[]}`（由当前叶 grants 导出），私有列表仅 O/P；专家列表支持 A/M/W/P 并通过 owner/EXISTS 成员筛选。所有受限 list/count/search/export repo 在现 options 内新增必填 `access:AccessFilter`，调用方不得省略来获得全量；系统内部全量 reconcile 以明确 service 专用现有函数调用，不复用面向用户的无过滤默认值。DB writer 与调用方仅交换签名，不允许其他单元修改 DB 文件。创建会话/运行、分支复制、消息落库、评估/定时、记忆审核写入逐一传主体；分支继承本人所有权，禁止复制无权读取的原会话。

## 6. Fastify 接口与入口登记

auth writer 拥有 `features/auth/**`、新增 `plugins/access.ts`、`plugins/audit.ts`、`plugins/errors.ts`（仅需要的既有错误复用）、Fastify augmentations 的 `types.ts`、`routes/index.ts` 接线。保留现 `app.requireAuth(request,reply)`，由 DB session 读到活跃 user 后设置 `request.principal`，不再比对 ADMIN_USER；未认证时为 null。服务入口只能在其既有 token 校验后设置 service principal，不能伪装用户。

```ts
// Fastify decorations；用户 HTTP 路由用两个 preHandler 或等价 hook 接线
app.requirePermission(permissionId: PermissionId): preHandlerHookHandler;
app.authorize(request: FastifyRequest, permissionId: PermissionId,
  resource?: AccessResource): Promise<void>;
app.agentAccess(request: FastifyRequest, agentId: string): Promise<AgentAccess>;
// request.principal: Principal | null
// config.access：每条路由必须选一种
export type RouteAccess =
  | { kind: 'public'; reason: string }
  | { kind: 'authenticated' }
  | { kind: 'permission'; permissionId: PermissionId }
  | { kind: 'service'; boundary: 'mcp' | 'run-token' | 'share-token'; reason: string };
```

采用一个 `onRoute` hook 检查 `/api/*` 每条路由存在 config.access；对 permission 自动挂 requireAuth + requirePermission，对 authenticated 自动挂 requireAuth；service/public 保留原认证流程。缺声明在注册时抛错，不做扫描框架/策略语言。requirePermission 仅校验当前叶存在某 grant；handler 读取对象后调用 `authorize` 执行范围，并按需写跨用户审计；无对象的全局叶直接要求 P。agents.create 只接受 O/P 并设本人 owner。列表使用当前叶 scopes 查询，不能仅依靠 preHandler。不存在对象时按现有 404 流程。

服务/user 两种身份判定不能混用；requirePermission 对 service 一律拒绝，服务调用继续使用既有有限工具链。`/api/auth/login`、logout、me 明确 public（me 返回状态，logout 仍须 CSRF）；health 明确 public；分享读取为 share-token；MCP 和 run callback 各按现 token 登记。其他全部业务路由登记具体叶。GET 自动生成 HEAD、OPTIONS 等沿用 Fastify 机制，测试验证登记覆盖，不另造通用网关。

所有新增写接口使用 typed(app)+Zod schema；敏感 body 不记日志。所有写操作保留可信 Origin/CSRF 约束，账户/角色/成员写入复用 auth writer 导出的同一 Origin preHandler，供其他业务 writer 使用。成功登录/登出审计 actor 改 businessId；保留登录 cookie 回读 disableRefresh 与一次重试、登出撤销回读和原安全 Cookie 参数。

## 7. HTTP payload（统一 `/api` 前缀）

JSON 时间为 ISO 字符串，businessId 路径段由客户端 encodeURIComponent；账户技术 ID 不公开。现有统一错误格式与错误码保留，409 复用 CONFLICT。所有资源创建返回 201、读取/修改 200、删除 200 `{ok:true}`，无正文 DELETE 输入。

| 方法与地址 | 权限 | 输入与返回 |
|---|---|---|
| `GET /auth/me` | public | 返回 `AuthMe`；未登录仍 200 authenticated:false |
| `POST /auth/change-password` | authenticated，本人 | `{currentPassword,newPassword}` → `{ok:true}`，旧密码验证、撤销全部会话后重新登录 |
| `GET /accounts` | accounts.read/P | query `{q?,limit=50(1..100),offset=0}` → `{items:Account[],total:number}`，含 active/disabled，不含已删除认证账户 |
| `POST /accounts` | accounts.manage/P | `{businessId,username,name,password,restore:false,roleIds?}` → Account；恢复必须 restore:true，服务端查历史，活动账户/用户名冲突409 |
| `PATCH /accounts/:businessId/status` | accounts.manage/P | `{status:'active'|'disabled'}` → Account；停用撤销会话，最后活跃管理员409 |
| `PATCH /accounts/:businessId` | accounts.manage/P | `{username?,name?}` 至少一项 → Account；无 businessId/password/roles 字段 |
| `POST /accounts/:businessId/password` | accounts.manage/P | `{password}` → `{ok:true}`，撤销全部旧 sessions |
| `DELETE /accounts/:businessId` | accounts.manage/P | 仅删除认证资料 → `{ok:true}`；保留所有业务关联，最后管理员409 |
| `PUT /accounts/:businessId/roles` | roles.manage/P | `{roleIds:string[]}` → `{ok:true}`；可对当前账户或具有历史业务引用的离线身份操作 |
| `GET /roles` | roles.read/P | → `RoleMatrix`（roles + revision） |
| `GET /permissions` | roles.read/P | → `{permissions:PermissionDefinition[],scopes:{id:AccessScope,label:string}[]}`，直接 shared 目录，无第二份配置 |
| `PUT /roles` | roles.manage/P | `RoleMatrixInput` → `RoleMatrix`；全矩阵一次原子保存，expectedRevision 不符409；省略非 admin 角色表示删除；id 缺省创建，已有 id 更新；admin 必须保留且 grants 不变；失败无部分写入 |
| `GET /agents/:id/access` | authenticated | 返回该对象 AgentAccess；没有 agents.read 对象访问权则404 |
| `GET /agents/:id/members` | agents.members.manage/W,P | → `{ownerBusinessId:string,members:AgentMember[]}` |
| `PUT /agents/:id/members/:businessId` | agents.members.manage/W,P | `{canUse:boolean,canMaintain:boolean}` 至少一个true → AgentMember；目标必须存在当前账户或历史业务引用，可离线 |
| `DELETE /agents/:id/members/:businessId` | 同上 | → `{ok:true}`；owner 不作为可删成员行 |
| `POST /agents/:id/transfer` | agents.transfer/W,P | `{ownerBusinessId}` → 更新后既有 Agent DTO；新 owner 须活跃且具 agents.create O/P，原 owner 不自动保留成员权 |

username 沿用当前 1..128 字符与不归一化规则；name 1..128；password 依据 Better Auth 当前最小长度且最长128（本地类型核对，普通新账户不得套管理员弱密码例外）；businessId 使用 §2 schema。roleIds 必须引用存在的角色，成员目标必须为当前账户或有历史业务引用的 businessId。不返回 passwordHash、session、credential、内部 email。

新增专家：createdBy/ownerBusinessId 均取当前业务主体，拒绝客户端指定。`GET /agents` 以 agents.read 范围过滤，只返回 `AgentSummary={id,name,description,enabled,createdBy,ownerBusinessId}`（沿实际字段映射）；严禁包含 systemPrompt、模型/工具/资源配置、规则/风格正文、环境变量、完整文件或记忆。`GET /agents/:id` 返回既有完整配置 DTO，必须 agents.config.read；仅可使用专家的用户由列表摘要和 `/access` 进入对话，不调用配置详情。既有详情内如混入规则/风格/记忆正文，须分开走对应 read 入口或额外校验，不因 config.read 全放行。`AgentSummary` 及详情 schema 由 shared writer 统一导出。

成员候选复用 `GET /identities?q=&limit=&offset=&agentId=`，只作为专家成员选择接口，不是稳定身份登记服务；同时检查目标 agents.members.manage 范围。候选从当前账户及现有 userRoles/agent owner/member/个人内容关联的 businessId 去重，LEFT JOIN 取名称，缺失显示 businessId，accountActive 仅在账户存在且未停用时 true。DB 签名为 `repo.accounts.listIdentities(db,{q?,limit,offset}):Promise<{items:{businessId:string;name:string;accountActive:boolean}[];total:number}>`；无身份表/快照。成员新增和离线角色分配目标必须存在当前账户或上述历史引用，服务端同一历史查询判定，不强求 auth FK。

## 8. worker、个人记忆及执行主体

- HTTP 请求只能提交业务参数。聊天 run 的 initiatedBy 来源 request.principal.businessId；job 只携带现有 ID，worker 由 run/conversation DB 读主体。禁止信任 job/client 的 userId、businessId、role/admin 标记；不得默认 ADMIN_USER_ID（历史提法：现行代码已无该默认，worker 由 run/conversation 读 `request.principal` 落库的业务主体）。
- schedule 的 executeAsBusinessId 创建时取当前用户；触发时重查该业务身份仍有活跃账户、对应专家 agents.use 与 schedules.manage。评估执行主体取 evalRuns.createdBy，并重查 eval.execute/agents.use。无资格明确失败/skip 并审计，不降级 system/admin；删除认证账户阻止之后新启动，但不因此删除业务记录。已启动运行按现有取消机制处理，不引入新调度恢复系统。
- system 的维护任务、MCP 输入有显式 service 主体，不能借 service 获用户 O/P 权限。服务任务不挂任何用户个人记忆；MCP 仅既有暴露专家执行能力。
- 个人目录为 `workspacesDir/_users/<sha256(UTF8(businessId)) 的完整小写 hex>/CLAUDE.md`；允许 Unicode 后 base64url 可能超过单目录名长度，改用 Node 原生 SHA-256 固定64字符，不增加依赖，不把原始 businessId 拼路径。主机目录变更不改沙盒内既有官方加载路径；仅把当前用户的目录作为现有 personalDir 传入。锁 key 使用同一完整 businessId，API/worker 一致。`projectPersonalMemory(db,pool,workspacesDir,businessId)` businessId 必填，移除默认管理员。
- worker writer 覆盖 session-workspace、sandbox 会话绑定/复用键、core personalDir 参数相关消费者，保证不同业务用户不能复用带前一用户个人挂载的活跃沙盒；同专家双用户并发实测隔离。SDK transcript/resume 必须沿既有 conversation 隔离；不得把另一个人的会话 session 挂入当前运行。
- `features/memory/**`、memory-reviews 的 API 通过 request principal 传 businessId，DB 参数及返回 DTO 同步改名。用户个人偏好、审核、变更与并发 revision 锁均按业务身份隔离；代理不能编辑别人的字段。
- 专家 auto-memory 仍是专家范围共享状态，现有读写、委派记忆与运行锁保留；不按用户拆专家共享记忆，不擅改只读，不声称它提供用户秘密隔离。个人信息写个人记忆；共享专家记忆的既有语义在 UI/文档明确，不能把共享内容当私人权限保证。

## 9. Web 可直接实施约定

沿现 `/lib/api.ts`、登录路由、`_shell`、页面骨架与组件，不重做外壳。新增账户页、角色页，专家详情加成员/转交；无需独立权限策略编辑器。GET me 是 auth 查询唯一来源；401 清理身份查询并去登录，403/404 用现错误 UI。登出清除所有用户私有 Query 缓存，登录/账户切换不能复用前用户列表/正文。

菜单与动作依据精确叶 grants，不判断 role 名；专家按钮据 `/agents/:id/access` 的已求值 permissionIds。列表摘要与配置详情分别查询，仅具 agents.read/use 的用户可正常会话且不会获取配置。角色页按 treePath 构建多级树，父节点仅聚合允许范围内的叶，三态及批量勾选逐叶计算；保存整张矩阵一次 PUT /roles，带读取时 revision 作为 expectedRevision，409 保留本地草稿并重新读取提示冲突，禁止部分逐列保存。系统 admin grants 禁用编辑；依赖缺失在表单指明并由服务端复核，不能自动扩成全局权限。账户页包含启用/停用、创建/恢复确认（restore:true）、businessId 编辑只读；历史恢复由 POST 服务端判断，不依赖 GET identity。密码只在创建/重置/本人改密码表单出现，本人改密后重新登录。缺失姓名显示 businessId，不加快照。

## 10. 单 writer 文件边界与次序

| 单元 | 唯一可写边界 | 不得写/验收 |
|---|---|---|
| shared + DB | `packages/shared/**`、`packages/db/**`、DB 单元测试（实施前列出根 test 具体文件） | 不写 API/worker/web；先交导出/schema/repo/migration，再受理调用签名需要；独立库迁移、身份重建/无级联测试 |
| auth + 授权基础 | `packages/api/src/features/auth/**`、`plugins/access.ts`、`plugins/audit.ts`、`plugins/errors.ts`、`packages/api/src/types.ts`、`routes/index.ts`、`packages/api/test/auth.test.ts`、新 access/accounts/roles 测试 | 不改领域 routes、DB/shared；交 request principal、decorations、hook、账户角色 routes；跨 scope 判定/最后管理员/旧session测试 |
| agents 领域 | `packages/api/src/features/agents/**`、`packages/api/test/agents*.test.ts`、专家 memory-files/delegation-memory-lock 测试、身份候选搜索路由 | 不写 auth/routes index/DB/shared；在 registerAgentRoutes 内注册 members/access/transfer/identities；专家授权/绑定/导出/记忆路径测试 |
| 其余 API 授权 | 除上述两单元之外 `packages/api/src/features/**`，含 chat/runs/eval/ops/servers/MCP/knowledge/import/export/output-shares/memory/memory-reviews；对应现 API 测试；`routes/health.ts` access 声明 | 不写 plugins、types、routes/index、agents、DB/shared；全入口声明、正文隔离、列表分页、服务 token 边界测试 |
| worker + 个人记忆 | `packages/worker/**`、确需调整 personalDir 的 `packages/core/**`/`packages/sandbox/**`（仅主体/挂载边界）、其对应测试 | 不写 API 个人记忆路由、DB/shared；双用户挂载、主体由 DB、调度权限撤销测试，保留专家共享记忆能力 |
| web | `packages/web/**`、本任务根 `tests/*.e2e.ts` 新增/改动（仅 web writer） | 不写其他 packages；角色矩阵/账户恢复/专家授权交互、登录/切换缓存和页面权限验收 |

新 shared/DB 接口是后续编译依赖，先落公共签名后六单元可并行完善；auth hook 是领域接线依赖，先交 hook 和 decorations，其他单元可先写测试/调用。真实依赖仅此两处，禁止按单元整块串行。若现有测试或 core 文件需要多个 writer 修改，先交协调者指定一人，不临时抢写。任务文档只由架构所有者改，源码代理返回记录由主会话汇入。一般文档最终由协调者单 writer 同步；本轮不改第三个文档。

## 11. 可执行验收与冲突记录

落地时使用根 scripts：`pnpm db:generate`；隔离数据库 `pnpm db:migrate`；`pnpm typecheck`；`pnpm test -- packages/api/test/auth.test.ts <新增access测试及相关领域测试>`；`pnpm test:web`；`pnpm --filter @agentport/web build`。占位测试路径在执行单元建成后替换为真实路径并写任务记录，不能把本段当执行结果。安全行为至少验证：

1. 管理员创建两个人、owner、maintainer、自定义角色；DB 矩阵改后下个请求即时生效，父级三态准确，评估/定时独立；整体 PUT revision 冲突409且无部分落库，依赖缺失拒绝保存，失败回滚角色/授权/分配。
2. 停用后旧 cookie401、登录拒绝且调度不启动；激活只允许重新登录；本人改密旧密码错误拒绝、成功撤销旧会话；agents.read 用户只能得摘要，配置/规则/风格/完整文件/绑定/记忆/导出各叶分别拒绝越权。Unicode businessId、空白/控制字符及目录长度均验证。
2. 删除某账户后技术 sessions/accounts 消失，所有业务记录/角色/成员/个人记忆仍在；同 businessId 重建新技术 ID，原授权恢复，旧 cookie 永久401。
3. bootstrap 重复调用不改变密码/用户角色；清认证资料不重播 bootstrap；最后管理员删除/降权409；其余管理员可管理账户。
4. 负责人仅管理本人专家，维护人不能授权/删除/转交；多角色在不同专家范围不能拼接越权；子智能体、导入/导出及资源绑定入口同样检查。
5. 两用户同专家的 conversation/run/SSE/approval/question/output/附件/分支/搜索/计数互不可读；owner/maintainer 无旁路；管理员跨用户读取有审计。
6. 所有 API route 含 access；公开/分享/MCP/run-token 各走原认证，无 token 拒绝；服务主体无用户管理权，cookie/Origin/登录探测不回归。
7. 个人目录/锁/沙盒双用户隔离、worker DB 主体、防客户端伪造、撤权后新 schedule/eval 不启动；共享专家 auto-memory 现有测试仍通过。

已确认现状与目标差异：现 `requireAuth`/me 只认 ADMIN_USER；ensureAdmin 固定 ID 且 upsert 密码；业务 agents/conversations/runs 尚无完整人员字段；userPreferences/memoryReviews/memoryChanges FK authUsers CASCADE；worker/API 个人记忆默认管理员且 `_user` 共享。均由上述单元替换，不保留兼容分支。`docs/DEV-WORKFLOW.md` 配置段和 `docs/PITFALLS.md` 已改为首次初始化语义，并保留不要覆盖用户密码的教训。迁移新增 NOT NULL 字段且不回填，只在全新空库验证，不声称旧库可无损升级。无新增待用户决定项。
