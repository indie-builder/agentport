import { z } from 'zod';

/**
 * 账户与 RBAC 的唯一共享契约。
 * 业务人员关联只保存 businessId；authUsers 的技术 ID 只在认证边界内使用。
 */

export type BusinessId = string;

/** businessId 由管理员录入：1..160 个 Unicode 字符，不含任何空白或控制字符。 */
export function isValidBusinessId(value: string): boolean {
  const chars = [...value];
  return (
    chars.length >= 1 &&
    chars.length <= 160 &&
    !/\p{White_Space}/u.test(value) &&
    !/\p{Cc}/u.test(value)
  );
}

export const businessIdSchema = z
  .string({ error: '请输入业务 ID' })
  .refine(isValidBusinessId, '业务 ID 须为 1..160 个字符，且不能包含空白或控制字符');

export const ACCESS_SCOPES = [
  { id: 'own_data', label: '本人数据' },
  { id: 'authorized_agents', label: '被授权专家' },
  { id: 'maintained_agents', label: '维护专家' },
  { id: 'owned_agents', label: '负责专家' },
  { id: 'platform', label: '全平台' },
] as const;

export type AccessScope = (typeof ACCESS_SCOPES)[number]['id'];

export const accessScopeSchema = z.enum([
  'own_data',
  'authorized_agents',
  'maintained_agents',
  'owned_agents',
  'platform',
]);

const OP = ['own_data', 'platform'] as const;
const AMWP = ['authorized_agents', 'maintained_agents', 'owned_agents', 'platform'] as const;
const MWP = ['maintained_agents', 'owned_agents', 'platform'] as const;
const WP = ['owned_agents', 'platform'] as const;
const P = ['platform'] as const;

type PermissionCatalogEntry = {
  id: string;
  label: string;
  treePath: readonly string[];
  scopes: readonly AccessScope[];
};

const catalog = [
  { id: 'overview.read', label: '查看概览', treePath: ['工作台', '概览'], scopes: OP },

  { id: 'agents.read', label: '查看专家', treePath: ['专家', '基本'], scopes: AMWP },
  { id: 'agents.use', label: '使用专家', treePath: ['专家', '基本'], scopes: AMWP },
  { id: 'agents.create', label: '创建专家', treePath: ['专家', '创建'], scopes: OP },
  { id: 'agents.config.read', label: '读取配置', treePath: ['专家', '配置'], scopes: MWP },
  { id: 'agents.config.update', label: '修改配置', treePath: ['专家', '配置'], scopes: MWP },
  { id: 'agents.rules.read', label: '读取规则', treePath: ['专家', '规则'], scopes: MWP },
  { id: 'agents.rules.write', label: '修改规则', treePath: ['专家', '规则'], scopes: MWP },
  { id: 'agents.styles.read', label: '读取输出风格', treePath: ['专家', '输出风格'], scopes: MWP },
  { id: 'agents.styles.write', label: '修改输出风格', treePath: ['专家', '输出风格'], scopes: MWP },
  { id: 'agents.files.read', label: '读取完整文件', treePath: ['专家', '完整文件'], scopes: MWP },
  {
    id: 'agents.bindings.manage',
    label: '管理资源绑定',
    treePath: ['专家', '资源绑定'],
    scopes: MWP,
  },
  { id: 'agents.enable', label: '启停专家', treePath: ['专家', '生命周期'], scopes: MWP },
  { id: 'agents.clone', label: '克隆专家', treePath: ['专家', '生命周期'], scopes: MWP },
  { id: 'agents.import', label: '导入专家', treePath: ['专家', '生命周期'], scopes: MWP },
  { id: 'agents.export', label: '导出专家', treePath: ['专家', '生命周期'], scopes: MWP },
  { id: 'agents.memory.read', label: '读取专家记忆', treePath: ['专家', '记忆'], scopes: MWP },
  { id: 'agents.memory.write', label: '修改专家记忆', treePath: ['专家', '记忆'], scopes: MWP },
  { id: 'agents.versions.read', label: '读取版本', treePath: ['专家', '版本'], scopes: MWP },
  { id: 'agents.versions.restore', label: '恢复版本', treePath: ['专家', '版本'], scopes: MWP },
  { id: 'agents.delete', label: '删除专家', treePath: ['专家', '管理'], scopes: WP },
  { id: 'agents.members.manage', label: '管理成员', treePath: ['专家', '管理'], scopes: WP },
  { id: 'agents.transfer', label: '转交专家', treePath: ['专家', '管理'], scopes: WP },

  { id: 'conversations.read', label: '查看会话', treePath: ['对话', '会话'], scopes: OP },
  { id: 'conversations.create', label: '新建会话', treePath: ['对话', '会话'], scopes: OP },
  { id: 'conversations.update', label: '重命名会话', treePath: ['对话', '会话'], scopes: OP },
  { id: 'conversations.delete', label: '删除会话', treePath: ['对话', '会话'], scopes: OP },
  { id: 'conversations.share', label: '分享产物', treePath: ['对话', '会话'], scopes: OP },

  { id: 'runs.read', label: '查看运行', treePath: ['执行', '运行'], scopes: OP },
  { id: 'runs.approve', label: '批准工具', treePath: ['执行', '运行'], scopes: OP },
  { id: 'runs.cancel', label: '停止运行', treePath: ['执行', '运行'], scopes: OP },
  { id: 'runs.export', label: '导出运行', treePath: ['执行', '运行'], scopes: OP },
  {
    id: 'runs.questions.answer',
    label: '回答问题',
    treePath: ['执行', '运行', '交互'],
    scopes: OP,
  },

  { id: 'personal_memory.read', label: '读取个人记忆', treePath: ['个人', '记忆'], scopes: OP },
  { id: 'personal_memory.write', label: '修改个人记忆', treePath: ['个人', '记忆'], scopes: OP },
  { id: 'personal_memory.review', label: '审核个人记忆', treePath: ['个人', '记忆'], scopes: OP },

  { id: 'eval.read', label: '查看评估', treePath: ['评估', '用例与结果'], scopes: MWP },
  { id: 'eval.manage', label: '管理评估用例', treePath: ['评估', '用例与结果'], scopes: MWP },
  { id: 'eval.execute', label: '执行评估', treePath: ['评估', '用例与结果'], scopes: MWP },

  { id: 'schedules.read', label: '查看定时任务', treePath: ['定时', '任务'], scopes: MWP },
  { id: 'schedules.manage', label: '管理定时任务', treePath: ['定时', '任务'], scopes: MWP },

  { id: 'servers.read', label: '查看连接器', treePath: ['资源', '连接器', '定义'], scopes: P },
  {
    id: 'servers.create',
    label: '新建连接器',
    treePath: ['资源', '连接器', '定义'],
    scopes: P,
  },
  {
    id: 'servers.update',
    label: '修改连接器',
    treePath: ['资源', '连接器', '定义'],
    scopes: P,
  },
  {
    id: 'servers.delete',
    label: '删除连接器',
    treePath: ['资源', '连接器', '定义'],
    scopes: P,
  },
  {
    id: 'servers.import',
    label: '导入连接器',
    treePath: ['资源', '连接器', '定义'],
    scopes: P,
  },
  { id: 'servers.test', label: '测试连接器', treePath: ['资源', '连接器', '定义'], scopes: P },
  {
    id: 'servers.tokens.read',
    label: '查看服务令牌',
    treePath: ['资源', '连接器', '令牌'],
    scopes: P,
  },
  {
    id: 'servers.tokens.rotate',
    label: '轮换服务令牌',
    treePath: ['资源', '连接器', '令牌'],
    scopes: P,
  },
  {
    id: 'servers.tools.manage',
    label: '管理服务工具',
    treePath: ['资源', '连接器', '工具'],
    scopes: P,
  },

  { id: 'skills.read', label: '查看技能', treePath: ['资源', '技能', '定义'], scopes: P },
  { id: 'skills.create', label: '新建技能', treePath: ['资源', '技能', '定义'], scopes: P },
  { id: 'skills.update', label: '修改技能', treePath: ['资源', '技能', '定义'], scopes: P },
  { id: 'skills.delete', label: '删除技能', treePath: ['资源', '技能', '定义'], scopes: P },
  { id: 'skills.import', label: '导入技能', treePath: ['资源', '技能', '定义'], scopes: P },
  { id: 'skills.files.read', label: '读取技能文件', treePath: ['资源', '技能', '文件'], scopes: P },
  {
    id: 'skills.files.write',
    label: '修改技能文件',
    treePath: ['资源', '技能', '文件'],
    scopes: P,
  },

  { id: 'plugins.read', label: '查看插件', treePath: ['资源', '插件', '包'], scopes: P },
  { id: 'plugins.import', label: '导入插件', treePath: ['资源', '插件', '包'], scopes: P },
  { id: 'plugins.install', label: '安装插件', treePath: ['资源', '插件', '包'], scopes: P },
  { id: 'plugins.update', label: '修改插件', treePath: ['资源', '插件', '包'], scopes: P },
  { id: 'plugins.delete', label: '删除插件', treePath: ['资源', '插件', '包'], scopes: P },
  { id: 'plugins.export', label: '导出插件', treePath: ['资源', '插件', '包'], scopes: P },

  { id: 'knowledge.read', label: '查看知识库', treePath: ['知识库', '库与内容'], scopes: P },
  { id: 'knowledge.create', label: '新建知识库', treePath: ['知识库', '库与内容'], scopes: P },
  { id: 'knowledge.update', label: '修改知识库', treePath: ['知识库', '库与内容'], scopes: P },
  { id: 'knowledge.delete', label: '删除知识库', treePath: ['知识库', '库与内容'], scopes: P },
  {
    id: 'knowledge.content.manage',
    label: '管理知识内容',
    treePath: ['知识库', '库与内容'],
    scopes: P,
  },
  { id: 'knowledge.execute', label: '执行检索与处理', treePath: ['知识库', '执行'], scopes: P },
  { id: 'knowledge.publish', label: '发布知识 Wiki', treePath: ['知识库', '执行'], scopes: P },
  {
    id: 'knowledge.sources.manage',
    label: '管理知识来源',
    treePath: ['知识库', '来源'],
    scopes: P,
  },
  { id: 'knowledge.models.manage', label: '管理模型端点', treePath: ['知识库', '模型'], scopes: P },
  { id: 'knowledge.import', label: '导入知识库', treePath: ['知识库', '包'], scopes: P },
  { id: 'knowledge.export', label: '导出知识库', treePath: ['知识库', '包'], scopes: P },

  {
    id: 'runtime_environments.read',
    label: '查看运行环境',
    treePath: ['资源', '运行环境', '定义'],
    scopes: P,
  },
  {
    id: 'runtime_environments.create',
    label: '新建运行环境',
    treePath: ['资源', '运行环境', '定义'],
    scopes: P,
  },
  {
    id: 'runtime_environments.update',
    label: '修改运行环境',
    treePath: ['资源', '运行环境', '定义'],
    scopes: P,
  },
  {
    id: 'runtime_environments.delete',
    label: '删除运行环境',
    treePath: ['资源', '运行环境', '定义'],
    scopes: P,
  },
  {
    id: 'runtime_environments.build',
    label: '构建运行环境',
    treePath: ['资源', '运行环境', '版本'],
    scopes: P,
  },
  {
    id: 'runtime_environments.publish',
    label: '发布运行环境',
    treePath: ['资源', '运行环境', '版本'],
    scopes: P,
  },

  { id: 'market.read', label: '查看市场', treePath: ['资源', '市场'], scopes: P },
  { id: 'market.install', label: '安装市场资源', treePath: ['资源', '市场'], scopes: P },

  { id: 'operations.read', label: '查看运维', treePath: ['平台', '运维'], scopes: P },
  { id: 'operations.manage', label: '运维控制', treePath: ['平台', '运维'], scopes: P },
  { id: 'audit.read', label: '查看审计', treePath: ['平台', '审计'], scopes: P },
  { id: 'accounts.read', label: '查看账户', treePath: ['平台', '账户'], scopes: P },
  { id: 'accounts.manage', label: '管理账户', treePath: ['平台', '账户'], scopes: P },
  { id: 'roles.read', label: '查看角色', treePath: ['平台', '角色'], scopes: P },
  { id: 'roles.manage', label: '管理角色', treePath: ['平台', '角色'], scopes: P },
] as const satisfies readonly PermissionCatalogEntry[];

export type PermissionId = (typeof catalog)[number]['id'];

export type PermissionDefinition = {
  id: PermissionId;
  label: string;
  treePath: readonly string[];
  scopes: readonly AccessScope[];
};

export const PERMISSIONS: readonly PermissionDefinition[] = catalog;

export const PERMISSION_IDS = catalog.map((entry) => entry.id) as [PermissionId, ...PermissionId[]];

const permissionById = new Map<string, PermissionDefinition>(
  PERMISSIONS.map((permission) => [permission.id, permission]),
);

export function scopesForPermission(permissionId: PermissionId): readonly AccessScope[] {
  return permissionById.get(permissionId)?.scopes ?? [];
}

export type PermissionGrant = { permissionId: PermissionId; scope: AccessScope };

export type AccessFilter = { businessId: BusinessId; scopes: AccessScope[] };

export type ExecutionSubject =
  | { kind: 'user'; businessId: BusinessId }
  | { kind: 'service'; serviceId: 'system' | 'mcp' };

export type RoleSummary = {
  id: string;
  name: string;
  systemKey: 'admin' | 'user' | 'owner' | 'maintainer' | null;
};

export type Role = RoleSummary & {
  grants: PermissionGrant[];
  createdAt: string;
  updatedAt: string;
};

export type Principal =
  | {
      kind: 'user';
      authUserId: string;
      businessId: BusinessId;
      username: string;
      name: string;
      roles: RoleSummary[];
      grants: PermissionGrant[];
    }
  | { kind: 'service'; serviceId: 'system' | 'mcp' };

export type AccessResource = {
  /** 已加载对象的实际主键（run、conversation 等）；跨用户审计优先用它做 target。 */
  objectId?: string;
  agentId?: string;
  createdBy?: BusinessId | null;
  privateContent?: boolean;
};

export type RoleMatrix = { revision: number; roles: Role[] };

export type RoleMatrixInput = {
  expectedRevision: number;
  roles: { id?: string; name: string; grants: PermissionGrant[] }[];
};

export type Account = {
  businessId: BusinessId;
  username: string;
  name: string;
  status: 'active' | 'disabled';
  roles: RoleSummary[];
  createdAt: string;
};

export type AgentMember = {
  businessId: BusinessId;
  name: string;
  accountActive: boolean;
  canUse: boolean;
  canMaintain: boolean;
};

export type AgentAccess = { agentId: string; permissionIds: PermissionId[] };

export type AuthMe =
  | { authenticated: false }
  | {
      authenticated: true;
      user: { businessId: BusinessId; username: string; name: string };
      roles: RoleSummary[];
      grants: PermissionGrant[];
    };

/** 依赖同叶读取能力的写权限；矩阵保存时逐项校验。 */
const READ_DEPENDENCIES: Partial<Record<PermissionId, PermissionId>> = {
  'agents.config.update': 'agents.config.read',
  'agents.rules.write': 'agents.rules.read',
  'agents.styles.write': 'agents.styles.read',
  'agents.memory.write': 'agents.memory.read',
  'agents.versions.restore': 'agents.versions.read',
  'agents.bindings.manage': 'agents.read',
  'agents.enable': 'agents.read',
  'agents.delete': 'agents.read',
  'agents.members.manage': 'agents.read',
  'agents.transfer': 'agents.read',
  'eval.manage': 'eval.read',
  'eval.execute': 'eval.read',
  'schedules.manage': 'schedules.read',
  'servers.create': 'servers.read',
  'servers.update': 'servers.read',
  'servers.delete': 'servers.read',
  'servers.import': 'servers.read',
  'servers.test': 'servers.read',
  'servers.tokens.read': 'servers.read',
  'servers.tokens.rotate': 'servers.tokens.read',
  'servers.tools.manage': 'servers.read',
  'skills.create': 'skills.read',
  'skills.update': 'skills.read',
  'skills.delete': 'skills.read',
  'skills.import': 'skills.read',
  'skills.files.read': 'skills.read',
  'skills.files.write': 'skills.files.read',
  'plugins.import': 'plugins.read',
  'plugins.install': 'plugins.read',
  'plugins.update': 'plugins.read',
  'plugins.delete': 'plugins.read',
  'plugins.export': 'plugins.read',
  'knowledge.create': 'knowledge.read',
  'knowledge.update': 'knowledge.read',
  'knowledge.delete': 'knowledge.read',
  'knowledge.content.manage': 'knowledge.read',
  'knowledge.execute': 'knowledge.read',
  'knowledge.publish': 'knowledge.read',
  'knowledge.sources.manage': 'knowledge.read',
  'knowledge.models.manage': 'knowledge.read',
  'knowledge.import': 'knowledge.read',
  'knowledge.export': 'knowledge.read',
  'runtime_environments.create': 'runtime_environments.read',
  'runtime_environments.update': 'runtime_environments.read',
  'runtime_environments.delete': 'runtime_environments.read',
  'runtime_environments.build': 'runtime_environments.read',
  'runtime_environments.publish': 'runtime_environments.read',
  'market.install': 'market.read',
  'operations.manage': 'operations.read',
  'accounts.manage': 'accounts.read',
  'roles.manage': 'roles.read',
};

/** 完整文件与导出必须能看到所含配置、规则、样式和记忆。 */
const EXPORT_DEPENDENCIES: PermissionId[] = [
  'agents.config.read',
  'agents.rules.read',
  'agents.styles.read',
  'agents.memory.read',
];

export function grantDependencies(permissionId: PermissionId): readonly PermissionId[] {
  if (permissionId === 'agents.files.read' || permissionId === 'agents.export') {
    return EXPORT_DEPENDENCIES;
  }
  const read = READ_DEPENDENCIES[permissionId];
  return read ? [read] : [];
}

/**
 * 读取依赖的对象范围覆盖（candidate 覆盖 required）：
 * 负责人同时具备被授权与维护关系，因此 A 和 M 都覆盖 W，但 A/M 互不包含；
 * own_data 只覆盖自身，platform 覆盖全部，其余反向均不成立。
 * 写权限不能靠更窄的读取范围"看似有读取"而放大对象范围。
 */
const SCOPE_COVERAGE: Record<AccessScope, readonly AccessScope[]> = {
  own_data: ['own_data'],
  authorized_agents: ['authorized_agents', 'owned_agents'],
  maintained_agents: ['maintained_agents', 'owned_agents'],
  owned_agents: ['owned_agents'],
  platform: ['own_data', 'authorized_agents', 'maintained_agents', 'owned_agents', 'platform'],
};

export function scopeCovers(candidate: AccessScope, required: AccessScope): boolean {
  return SCOPE_COVERAGE[candidate]?.includes(required) ?? false;
}

/** 校验一组 grants 的目录值、允许 scope、重复项与读取依赖；返回第一条问题的中文说明。 */
export function validateGrants(grants: readonly PermissionGrant[]): string | null {
  const seen = new Set<string>();
  const scopesByPermission = new Map<PermissionId, Set<AccessScope>>();
  for (const grant of grants) {
    const definition = permissionById.get(grant.permissionId);
    if (!definition) return `未知权限 ${grant.permissionId}`;
    if (!definition.scopes.includes(grant.scope)) {
      return `${grant.permissionId} 不支持范围 ${grant.scope}`;
    }
    const key = `${grant.permissionId}\u0000${grant.scope}`;
    if (seen.has(key)) return `${grant.permissionId} 的范围 ${grant.scope} 重复`;
    seen.add(key);
    const scopes = scopesByPermission.get(grant.permissionId);
    if (scopes) scopes.add(grant.scope);
    else scopesByPermission.set(grant.permissionId, new Set([grant.scope]));
  }
  for (const grant of grants) {
    for (const dependency of grantDependencies(grant.permissionId)) {
      const scopes = scopesByPermission.get(dependency);
      if (!scopes) {
        return `${grant.permissionId} 需要同时授权 ${dependency}`;
      }
      if (![...scopes].some((scope) => scopeCovers(scope, grant.scope))) {
        return `${grant.permissionId} 的范围 ${grant.scope} 需要 ${dependency} 覆盖同一范围`;
      }
    }
  }
  return null;
}

export const permissionIdSchema = z.enum(PERMISSION_IDS);

export const permissionGrantSchema = z
  .object({ permissionId: permissionIdSchema, scope: accessScopeSchema })
  .strict()
  .superRefine((grant, ctx) => {
    if (!scopesForPermission(grant.permissionId).includes(grant.scope)) {
      ctx.addIssue({
        code: 'custom',
        message: `${grant.permissionId} 不支持范围 ${grant.scope}`,
      });
    }
  });

export const permissionGrantsSchema = z.array(permissionGrantSchema).superRefine((grants, ctx) => {
  const message = validateGrants(grants);
  if (message) ctx.addIssue({ code: 'custom', message });
});

const roleNameSchema = z
  .string({ error: '请输入角色名称' })
  .min(1, '请输入角色名称')
  .max(128, '角色名称不能超过 128 个字符');

export const roleMatrixInputSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    roles: z
      .array(
        z
          .object({
            id: z.string().min(1).optional(),
            name: roleNameSchema,
            grants: permissionGrantsSchema,
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((input, ctx) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const role of input.roles) {
      if (role.id !== undefined) {
        if (ids.has(role.id)) {
          ctx.addIssue({ code: 'custom', message: `角色 ${role.id} 重复` });
        }
        ids.add(role.id);
      }
      if (names.has(role.name)) {
        ctx.addIssue({ code: 'custom', message: `角色名称 ${role.name} 重复` });
      }
      names.add(role.name);
    }
  });

export const usernameSchema = z
  .string({ error: '请输入用户名' })
  .min(1, '请输入用户名')
  .max(128, '用户名不能超过 128 个字符');

export const accountNameSchema = z
  .string({ error: '请输入姓名' })
  .min(1, '请输入姓名')
  .max(128, '姓名不能超过 128 个字符');

// Better Auth 1.7.14 emailAndPassword 的最小长度为 8、最大 128。
export const passwordSchema = z
  .string({ error: '请输入密码' })
  .min(8, '密码至少 8 个字符')
  .max(128, '密码不能超过 128 个字符');

export const accountCreateSchema = z
  .object({
    businessId: businessIdSchema,
    username: usernameSchema,
    name: accountNameSchema,
    password: passwordSchema,
    roleIds: z.array(z.string().min(1)).optional(),
    restore: z.boolean().optional(),
  })
  .strict();

export const accountUpdateSchema = z
  .object({ username: usernameSchema.optional(), name: accountNameSchema.optional() })
  .strict()
  .refine((input) => input.username !== undefined || input.name !== undefined, {
    message: '至少修改一项',
  });

export const accountPasswordSchema = z.object({ password: passwordSchema }).strict();

export const accountRolesSchema = z.object({ roleIds: z.array(z.string().min(1)) }).strict();

export const accountStatusSchema = z.enum(['active', 'disabled']);

export const changeOwnPasswordSchema = z
  .object({ currentPassword: z.string().min(1), newPassword: passwordSchema })
  .strict();

export const agentMemberInputSchema = z
  .object({ canUse: z.boolean(), canMaintain: z.boolean() })
  .strict()
  .refine((input) => input.canUse || input.canMaintain, {
    message: '至少授予使用或维护权限',
  });

export const listQuerySchema = z.object({
  q: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const U_GRANTS: PermissionGrant[] = [
  { permissionId: 'overview.read', scope: 'own_data' },
  { permissionId: 'agents.read', scope: 'authorized_agents' },
  { permissionId: 'agents.use', scope: 'authorized_agents' },
  { permissionId: 'conversations.read', scope: 'own_data' },
  { permissionId: 'conversations.create', scope: 'own_data' },
  { permissionId: 'conversations.update', scope: 'own_data' },
  { permissionId: 'conversations.delete', scope: 'own_data' },
  { permissionId: 'conversations.share', scope: 'own_data' },
  { permissionId: 'runs.read', scope: 'own_data' },
  { permissionId: 'runs.approve', scope: 'own_data' },
  { permissionId: 'runs.cancel', scope: 'own_data' },
  { permissionId: 'runs.questions.answer', scope: 'own_data' },
  { permissionId: 'runs.export', scope: 'own_data' },
  { permissionId: 'personal_memory.read', scope: 'own_data' },
  { permissionId: 'personal_memory.write', scope: 'own_data' },
  { permissionId: 'personal_memory.review', scope: 'own_data' },
];

const C_MAINTENANCE_PERMISSIONS: PermissionId[] = [
  'agents.read',
  'agents.use',
  'agents.config.read',
  'agents.config.update',
  'agents.rules.read',
  'agents.rules.write',
  'agents.styles.read',
  'agents.styles.write',
  'agents.files.read',
  'agents.bindings.manage',
  'agents.enable',
  'agents.clone',
  'agents.import',
  'agents.export',
  'agents.memory.read',
  'agents.memory.write',
  'agents.versions.read',
  'agents.versions.restore',
  'eval.read',
  'eval.manage',
  'eval.execute',
  'schedules.read',
  'schedules.manage',
];

function grantsWithScope(
  permissionIds: readonly PermissionId[],
  scope: AccessScope,
): PermissionGrant[] {
  return permissionIds.map((permissionId) => ({ permissionId, scope }));
}

export const DEFAULT_ROLES: readonly {
  systemKey: NonNullable<RoleSummary['systemKey']>;
  name: string;
  grants: readonly PermissionGrant[];
}[] = [
  {
    systemKey: 'admin',
    name: '平台管理员',
    grants: PERMISSIONS.map((permission) => ({
      permissionId: permission.id,
      scope: 'platform' as const,
    })),
  },
  { systemKey: 'user', name: '用户', grants: U_GRANTS },
  {
    systemKey: 'owner',
    name: '负责人',
    grants: [
      ...U_GRANTS,
      { permissionId: 'agents.create', scope: 'own_data' },
      ...grantsWithScope(C_MAINTENANCE_PERMISSIONS, 'owned_agents'),
      ...grantsWithScope(
        ['agents.delete', 'agents.members.manage', 'agents.transfer'],
        'owned_agents',
      ),
    ],
  },
  {
    systemKey: 'maintainer',
    name: '维护人员',
    grants: [...U_GRANTS, ...grantsWithScope(C_MAINTENANCE_PERMISSIONS, 'maintained_agents')],
  },
];
