import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fail, isAppError, parseAgentMd } from '@agentport/core';
import { repo as allRepo, plugins as pluginsTable, schema } from '@agentport/db';
import * as repo from '@agentport/db/repo/agents.js';
import type { AccessScope, Agent, AgentInput, PermissionId, Principal } from '@agentport/shared';
import {
  AGENT_PACKAGE_MAX_BYTES,
  AGENT_PACKAGE_MAX_ENTRIES,
  AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES,
  AGENT_ROLES,
  agentDuplicateInputSchema,
  agentInputSchema,
  agentMemberInputSchema,
  agentOptionsSchema,
  agentRoleSchema,
  agentSchema,
  agentSummarySchema,
  businessIdSchema,
  grantDependencies,
  idParams,
  memoryFileNameSchema,
  outputStyleInputSchema,
  permissionModeSchema,
  slugSchema,
  uiFormatSchema,
} from '@agentport/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { AppError, isPgCode, reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import { encodePackage } from '../agent-package-zip.js';
import {
  readMemoryTarget,
  withMemoryTargetLock,
  writeMemoryTargetLocked,
} from '../memory/changes.js';
import { listMemoryFiles, readMemoryFile } from './memory-files.js';
import { allowedToolsSchema, unsupportedAllowedTool } from './validation.js';
import { renderAgentWorkspace } from './workspace.js';

const versionParams = z.object({
  id: z.string().min(1),
  version: z.coerce.number().int().positive(),
});
const rollbackBody = z.object({ version: z.number().int().positive() });
const subAgentFileParams = z.object({
  id: z.string().min(1),
  childId: z.string().min(1),
});
const memoryParams = z.object({ id: z.string().min(1) });
const memoryFileParams = z.object({
  id: z.string().min(1),
  name: memoryFileNameSchema,
});
const memoryWriteBody = z.object({ content: z.string() });
const ruleParams = z.object({ id: z.string().min(1), slug: slugSchema });
const outputStyleParams = z.object({ id: z.string().min(1), slug: slugSchema });
const ruleBody = z.object({
  content: z.string().max(100_000),
  globs: z.string().max(1000).default(''),
});
const outputStyleWriteBody = outputStyleInputSchema.pick({
  description: true,
  keepCodingInstructions: true,
  body: true,
});
const memberParams = z.object({
  id: z.string().min(1),
  businessId: businessIdSchema,
});
const transferBody = z.object({ ownerBusinessId: businessIdSchema }).strict();
const identitiesQuery = z.object({
  agentId: z.string().min(1),
  q: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

type OutputStyleRow = Awaited<ReturnType<typeof allRepo.outputStyles.listOutputStyles>>[number];

function toOutputStyle(row: OutputStyleRow) {
  return {
    id: row.id,
    agentId: row.agentId,
    slug: row.slug,
    description: row.description,
    keepCodingInstructions: row.keepCodingInstructions,
    body: row.body,
    isSelected: row.isSelected,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 委派绑定必须同时落在调用者的管理范围内：
 * 否则负责人可以借自己的父专家驱动别人维护的子智能体。
 */
async function authorizeSubAgentBindings(
  app: FastifyInstance,
  request: FastifyRequest,
  subAgentIds: string[],
): Promise<void> {
  for (const id of subAgentIds) {
    const child = await repo.getAgent(app.db, id);
    if (!child) continue; // 不存在的候选由 validateSubAgents 统一报错。
    await authorizeAgent(app, request, child, 'agents.bindings.manage');
  }
}

/** default/acceptEdits 直接透传 SDK；auto 依赖无法审计的模型分类器，暂不开放。 */
const unsupportedPermissionModes = new Set(['auto']);

function unsupportedPermissionMode(mode: string | undefined): string | undefined {
  return mode !== undefined && unsupportedPermissionModes.has(mode)
    ? `permissionMode "${mode}" 依赖模型分类器，平台暂不开放；可用 dontAsk、plan、default、acceptEdits`
    : undefined;
}

const createSchema = agentInputSchema
  .extend({ allowedTools: allowedToolsSchema.default([]) })
  .strict();

// 解析（含 frontmatter / 字段校验）放在 schema 里：handler 只拿解析结果，不再 safeParse。
const importFileSchema = z
  .object({ agentMd: z.string().max(131072) })
  .transform(({ agentMd }, ctx) => {
    try {
      return parseAgentMd(agentMd);
    } catch (err) {
      if (!isAppError(err)) throw err;
      ctx.addIssue({ code: 'custom', path: ['agentMd'], message: err.message });
      return z.NEVER;
    }
  });

// 字段与 agentInputSchema 保持一致；PATCH 用显式可选字段，才能区分「没传」与「传了默认值」。
const patchSchema = z
  .object({
    slug: slugSchema.optional(),
    name: z.string().min(1).max(128).optional(),
    role: agentRoleSchema.removeDefault().optional(),
    description: z.string().max(300).optional(),
    model: z.string().min(1).optional(),
    systemPrompt: z.string().optional(),
    serverIds: z.array(z.string()).optional(),
    skillIds: z.array(z.string()).optional(),
    pluginBindings: z
      .array(
        z.object({
          pluginId: z.string(),
          allowHooks: z.boolean().default(false),
          allowMcp: z.boolean().default(false),
        }),
      )
      .optional(),
    subAgentIds: z.array(z.string()).optional(),
    /** null 清除绑定、回平台默认环境；undefined 保持不动。 */
    runtimeEnvironmentId: z.string().min(1).nullable().optional(),
    allowedTools: allowedToolsSchema.optional(),
    disallowedTools: z.array(z.string()).optional(),
    permissionMode: permissionModeSchema.optional(),
    uiFormat: uiFormatSchema.optional(),
    maxTurns: z.number().int().positive().optional(),
    maxBudgetUsd: z.number().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    // null 表示清除回「未配置」；undefined 保持不动，两者语义不同。
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(),
    enabled: z.boolean().optional(),
    /** 乐观锁：首次加载时的 updatedAt。 */
    expectedUpdatedAt: z.coerce.date().optional(),
  })
  .strict();

function invalid(reply: FastifyReply, message: string) {
  return reject(reply, 'INVALID_INPUT', message);
}

function notFound(reply: FastifyReply) {
  return reject(reply, 'AGENT_NOT_FOUND', '智能体不存在，可能已被删除；请返回列表刷新后重试');
}

/** 每条路由显式声明叶；onRoute 据此自动挂 requireAuth + requirePermission。 */
function access(permissionId: PermissionId) {
  return { access: { kind: 'permission' as const, permissionId } };
}

const authenticated = { access: { kind: 'authenticated' as const } };

/** 写叶必须同时具备对应读取视图；依赖只由 shared 目录定义一次。 */
function dependenciesOf(permissionId: PermissionId): readonly PermissionId[] {
  return grantDependencies(permissionId);
}

function principalOf(request: FastifyRequest): Extract<Principal, { kind: 'user' }> {
  const principal = request.principal;
  if (!principal || principal.kind !== 'user') throw new AppError('UNAUTHORIZED', 'not logged in');
  return principal;
}

function scopesFor(principal: Extract<Principal, { kind: 'user' }>, permissionId: PermissionId) {
  return principal.grants
    .filter((grant) => grant.permissionId === permissionId)
    .map((grant): AccessScope => grant.scope);
}

/** 对象级检查：同一条 grant 必须同时匹配 permissionId 与对象 scope。 */
async function authorizeAgent(
  app: FastifyInstance,
  request: FastifyRequest,
  row: repo.AgentRow,
  permissionIds: PermissionId | PermissionId[],
): Promise<void> {
  const ids = Array.isArray(permissionIds) ? permissionIds : [permissionIds];
  for (const permissionId of ids) {
    await app.authorize(request, permissionId, {
      agentId: row.id,
      createdBy: row.createdBy,
    });
    for (const dependency of dependenciesOf(permissionId)) {
      await app.authorize(request, dependency, {
        agentId: row.id,
        createdBy: row.createdBy,
      });
    }
  }
}

/** 列表摘要：只给成员可见的业务字段，不含提示词、绑定或任何密钥。 */
function toSummary(row: repo.AgentRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    createdBy: row.createdBy,
    ownerBusinessId: row.ownerBusinessId,
  };
}

/** 专家详情（配置、绑定）只在 agents.config.read 之后返回。 */
async function detailOf(app: FastifyInstance, row: repo.AgentRow): Promise<Agent> {
  const [serverIds, skillIds, subAgentIds, pluginBindings] = await Promise.all([
    repo.getAgentServerIds(app.db, row.id),
    repo.getAgentSkillIds(app.db, row.id),
    repo.getAgentSubAgentIds(app.db, row.id),
    repo.listAgentPluginBindings(app.db, [row.id]),
  ]);
  return repo.toAgent(row, serverIds, skillIds, subAgentIds, pluginBindings.get(row.id) ?? []);
}

/** 成员只能指向已登记身份：当前账户（含停用，可离线保留）或历史业务记录。 */
function registeredIdentity(app: FastifyInstance, businessId: string): Promise<boolean> {
  return allRepo.accounts.hasBusinessHistory(app.db, businessId);
}

/** slug 有唯一索引（23505）→ 409；外键失败（23503）→ 引用了不存在的 server/skill。 */
function rethrowConflict(err: unknown): never {
  if (isPgCode(err, '23505')) fail('CONFLICT', '该 slug 已被其他智能体占用，请换一个');
  if (isPgCode(err, '23503'))
    fail('INVALID_REFERENCE', '引用的 MCP Server、技能或插件不存在，请刷新后重新选择');
  throw err;
}

function toWrite(
  input: Omit<AgentInput, 'serverIds' | 'skillIds' | 'subAgentIds' | 'pluginBindings'>,
  ownerBusinessId: string,
): repo.AgentWrite {
  return {
    slug: input.slug,
    name: input.name,
    role: input.role,
    description: input.description,
    model: input.model,
    systemPromptMd: input.systemPrompt,
    allowedTools: input.allowedTools,
    disallowedTools: input.disallowedTools,
    permissionMode: input.permissionMode,
    uiFormat: input.uiFormat,
    effort: input.effort ?? null,
    enabled: input.enabled,
    maxTurns: input.maxTurns,
    maxBudgetUsd: String(input.maxBudgetUsd),
    timeoutMs: input.timeoutMs,
    runtimeEnvironmentId: input.runtimeEnvironmentId,
    // 业务身份只由服务端写入，客户端提交的同名字段在 schema 里被拒绝。
    createdBy: ownerBusinessId,
    ownerBusinessId,
  };
}

// slug 是工作区目录名，改了旧目录会变孤儿，只能显式拒绝。
function assertSlugUnchanged(current: string, next: string | undefined): string | undefined {
  return next !== undefined && next !== current
    ? 'slug 是工作区目录名，创建后不能修改；需要新名称请另建智能体'
    : undefined;
}

/**
 * 单层委派校验：自己不能当子智能体，候选只能是「没有 parent」的顶层 agent。
 * 返回错误文案；合法时返回 undefined。
 */
async function validateSubAgents(
  app: FastifyInstance,
  selfId: string | null,
  subAgentIds: string[],
): Promise<string | undefined> {
  if (new Set(subAgentIds).size !== subAgentIds.length) {
    return '同一个智能体被重复选为子智能体，请去掉重复项';
  }
  if (selfId !== null && subAgentIds.includes(selfId)) return '智能体不能把自己设为子智能体';
  const rows = await repo.getAgentsByIds(app.db, subAgentIds);
  if (rows.length !== subAgentIds.length) return '选中的子智能体已被删除，请刷新后重新选择';
  for (const row of rows) {
    if (row.parentId !== null && row.parentId !== selfId) {
      return `「${row.name}」已经是其他智能体的子智能体；只支持一层委派`;
    }
  }
  // 候选自己不能再有子智能体，否则会拼出两层。
  const nested = await repo.listAgentSubAgentIds(
    app.db,
    rows.map((row) => row.id),
  );
  for (const row of rows) {
    if ((nested.get(row.id) ?? []).length > 0) {
      return `「${row.name}」自己还有子智能体；只支持一层委派，请先解除它的子智能体`;
    }
  }
  // 子智能体不绑插件：带插件绑定的候选必须先解绑，否则运行时会静默忽略而预览仍显示。
  const bindings = await repo.listAgentPluginBindings(
    app.db,
    rows.map((row) => row.id),
  );
  for (const row of rows) {
    if ((bindings.get(row.id) ?? []).length > 0) {
      return `「${row.name}」绑定了插件；插件只在会话级加载，请先解除它的插件绑定`;
    }
  }
  return undefined;
}

/**
 * 绑定必须是「真实存在且已有可用线上版本」的环境。
 * 没有线上版本时明确报错，不在运行时偷偷回落到默认环境。
 */
async function validateRuntimeEnvironment(
  app: FastifyInstance,
  id: string | null,
): Promise<string | undefined> {
  if (id === null) return undefined;
  const env = await allRepo.runtimeEnvironments.getRuntimeEnvironment(app.db, id);
  if (!env) return '选中的运行环境不存在，可能已被删除；请刷新后重新选择';
  if ((await allRepo.runtimeEnvironments.resolveOnlineRuntimeEnvironment(app.db, id)) === null) {
    return `「${env.name}」还没有可用的线上版本；请先完成构建并发布后再绑定`;
  }
  return undefined;
}

/** 快照是共享 Agent（camelCase）；回滚时先转回 DB 写入形状，slug 保持不变。 */
function snapshotToWrite(
  snapshot: Agent,
  slug: string,
  currentRole: string,
): Partial<repo.AgentWrite> {
  return {
    slug,
    name: snapshot.name,
    // 旧快照缺失或未使用标准角色时保留当前值，避免回滚丢失岗位信息。
    role: AGENT_ROLES.some((role) => role === snapshot.role) ? snapshot.role : currentRole,
    description: snapshot.description,
    model: snapshot.model,
    systemPromptMd: snapshot.systemPrompt,
    allowedTools: snapshot.allowedTools,
    disallowedTools: snapshot.disallowedTools,
    permissionMode: snapshot.permissionMode,
    // 旧快照没有 uiFormat，回滚按默认 markdown。
    uiFormat: snapshot.uiFormat ?? 'markdown',
    effort: snapshot.effort ?? null,
    enabled: snapshot.enabled,
    maxTurns: snapshot.maxTurns,
    maxBudgetUsd: String(snapshot.maxBudgetUsd),
    timeoutMs: snapshot.timeoutMs,
    runtimeEnvironmentId: snapshot.runtimeEnvironmentId ?? null,
  };
}

export function registerAgentRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);

  // 列表只返回当前 agents.read 范围可读的专家摘要；提示词、绑定与密钥都不下发。
  app.get(
    '/api/agents',
    {
      config: access('agents.read'),
      schema: { response: { 200: z.array(agentSummarySchema) } },
    },
    async (request) => {
      const principal = principalOf(request);
      const rows = await repo.listAgents(app.db, {
        businessId: principal.businessId,
        scopes: scopesFor(principal, 'agents.read'),
      });
      return rows.map(toSummary);
    },
  );

  app.post(
    '/api/agents',
    { config: access('agents.create'), schema: { body: createSchema } },
    async (request, reply) => {
      const principal = principalOf(request);
      // requirePermission 只确认叶存在；create 的对象范围由本人作为新对象 owner 满足。
      await app.authorize(request, 'agents.create');
      const input = request.body;
      const modeError = unsupportedPermissionMode(input.permissionMode);
      if (modeError) return invalid(reply, modeError);
      const { serverIds, skillIds, subAgentIds, pluginBindings, ...rest } = input;
      const subAgentError = await validateSubAgents(app, null, subAgentIds);
      if (subAgentError) return invalid(reply, subAgentError);
      await authorizeSubAgentBindings(app, request, subAgentIds);
      const envError = await validateRuntimeEnvironment(app, input.runtimeEnvironmentId);
      if (envError) return invalid(reply, envError);
      try {
        const row = await repo.createAgent(
          app.db,
          toWrite(rest, principal.businessId),
          serverIds,
          skillIds,
          subAgentIds,
          pluginBindings,
        );
        await writeAudit(app.db, request.log, {
          actor: principal.businessId,
          action: 'agent.created',
          target: row.id,
          input,
          status: 'ok',
          requestId: request.id,
        });
        return reply
          .status(201)
          .send(repo.toAgent(row, serverIds, skillIds, subAgentIds, pluginBindings));
      } catch (err) {
        rethrowConflict(err);
      }
    },
  );

  // 克隆：配置、绑定、规则、输出风格一起复制；子智能体不复制，从 v1 重新计版本。
  app.post(
    '/api/agents/:id/duplicate',
    {
      config: access('agents.clone'),
      schema: {
        params: idParams,
        body: agentDuplicateInputSchema,
        response: { 201: agentSchema },
      },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      const source = await repo.getAgent(app.db, request.params.id);
      if (!source) return notFound(reply);
      await authorizeAgent(app, request, source, 'agents.clone');
      await app.authorize(request, 'agents.create');
      try {
        // 新对象归当前用户所有；源成员的授权不随克隆带出。
        const row = await repo.duplicateAgent(
          app.db,
          source.id,
          request.body,
          principal.businessId,
        );
        if (!row) return notFound(reply);
        await writeAudit(app.db, request.log, {
          actor: principal.businessId,
          action: 'agent.duplicated',
          target: row.id,
          input: { sourceId: source.id },
          status: 'ok',
          requestId: request.id,
        });
        return reply.status(201).send(row);
      } catch (err) {
        rethrowConflict(err);
      }
    },
  );

  // 导入只接受官方 .claude/agents/*.md；slug 即 frontmatter 的 name，冲突与手动创建一样返回 409。
  app.post(
    '/api/agents/import-file',
    { config: access('agents.import'), schema: { body: importFileSchema } },
    async (request, reply) => {
      const principal = principalOf(request);
      // 导入新建同样要求创建专家，且新对象归当前用户所有。
      await app.authorize(request, 'agents.create');
      const { agent: input, warnings } = request.body;
      const { serverIds, skillIds, subAgentIds, pluginBindings, ...rest } = input;
      await authorizeSubAgentBindings(app, request, subAgentIds);
      try {
        const row = await repo.createAgent(
          app.db,
          toWrite(rest, principal.businessId),
          serverIds,
          skillIds,
          subAgentIds,
          pluginBindings,
        );
        await writeAudit(app.db, request.log, {
          actor: principal.businessId,
          action: 'agent.imported',
          target: row.id,
          input: { slug: row.slug },
          status: 'ok',
          requestId: request.id,
        });
        return reply.status(201).send({
          agent: repo.toAgent(row, serverIds, skillIds, subAgentIds, pluginBindings),
          warnings,
        });
      } catch (err) {
        rethrowConflict(err);
      }
    },
  );

  // 配置绑定时的可选资源目录：只出摘要，不含任何资源配置或密钥。
  app.get(
    '/api/agents/options',
    { config: authenticated, schema: { response: { 200: agentOptionsSchema } } },
    async (request) => {
      const principal = principalOf(request);
      if (!principal.grants.some((grant) => grant.permissionId === 'agents.bindings.manage')) {
        throw new AppError('FORBIDDEN', '没有管理专家资源绑定的权限');
      }
      const [servers, skills, plugins, environments] = await Promise.all([
        app.db
          .select({ id: schema.servers.id, name: schema.servers.name, kind: schema.servers.kind })
          .from(schema.servers)
          .orderBy(schema.servers.name),
        app.db
          .select({
            id: schema.skills.id,
            slug: schema.skills.slug,
            name: schema.skills.name,
            description: schema.skills.description,
          })
          .from(schema.skills)
          .orderBy(schema.skills.name),
        app.db
          .select({
            id: pluginsTable.id,
            slug: pluginsTable.slug,
            name: pluginsTable.name,
          })
          .from(pluginsTable)
          .orderBy(pluginsTable.name),
        app.db
          .select({
            id: schema.runtimeEnvironments.id,
            name: schema.runtimeEnvironments.name,
            onlineVersionId: schema.runtimeEnvironments.onlineVersionId,
          })
          .from(schema.runtimeEnvironments)
          .orderBy(schema.runtimeEnvironments.name),
      ]);
      return {
        servers,
        skills,
        plugins,
        runtimeEnvironments: environments.map((row) => ({
          id: row.id,
          name: row.name,
          hasOnlineVersion: row.onlineVersionId !== null,
        })),
      };
    },
  );

  // 完整配置只对 agents.config.read 开放；普通使用者只能看到列表摘要。
  app.get(
    '/api/agents/:id',
    {
      config: access('agents.config.read'),
      schema: { params: idParams, response: { 200: agentSchema } },
    },
    async (request, reply) => {
      const row = await repo.getAgent(app.db, request.params.id);
      if (!row) return notFound(reply);
      await authorizeAgent(app, request, row, 'agents.config.read');
      return detailOf(app, row);
    },
  );

  // 已求值的对象权限：前端据此显示编辑、授权、转交、删除按钮。
  app.get(
    '/api/agents/:id/access',
    { config: authenticated, schema: { params: idParams } },
    async (request, reply) => {
      const row = await repo.getAgent(app.db, request.params.id);
      if (!row) return notFound(reply);
      const result = await app.agentAccess(request, row.id);
      // 与列表一致：没有对象读权限就当作不存在，避免泄漏其他用户的专家。
      if (!result.permissionIds.includes('agents.read')) return notFound(reply);
      return result;
    },
  );

  // PATCH 可同时提交配置、绑定与启停字段，任一项按叶分别授权；因此这里先只要求登录。
  app.patch(
    '/api/agents/:id',
    { config: authenticated, schema: { params: idParams, body: patchSchema } },
    async (request, reply) => {
      const principal = principalOf(request);
      const input = request.body;
      const modeError = unsupportedPermissionMode(input.permissionMode);
      if (modeError) return invalid(reply, modeError);
      const envError =
        input.runtimeEnvironmentId === undefined
          ? undefined
          : await validateRuntimeEnvironment(app, input.runtimeEnvironmentId);
      if (envError) return invalid(reply, envError);

      const current = await repo.getAgent(app.db, request.params.id);
      if (!current) return notFound(reply);
      // 任何 PATCH 都需要对象级 agents.read；响应是否带完整配置另看 config.read。
      const access = await app.agentAccess(request, current.id);
      if (!access.permissionIds.includes('agents.read')) return notFound(reply);
      const canReadConfig = access.permissionIds.includes('agents.config.read');

      // 旧组合 PATCH 按实际提交的字段逐项授权；任一项越权就整体拒绝，不写部分字段。
      const configFields = [
        input.name,
        input.role,
        input.description,
        input.model,
        input.systemPrompt,
        input.allowedTools,
        input.disallowedTools,
        input.permissionMode,
        input.uiFormat,
        input.effort,
        input.maxTurns,
        input.maxBudgetUsd,
        input.timeoutMs,
        input.runtimeEnvironmentId,
      ];
      const bindingFields = [
        input.serverIds,
        input.skillIds,
        input.pluginBindings,
        input.subAgentIds,
      ];
      if (configFields.some((field) => field !== undefined)) {
        await authorizeAgent(app, request, current, 'agents.config.update');
      }
      if (bindingFields.some((field) => field !== undefined)) {
        await authorizeAgent(app, request, current, 'agents.bindings.manage');
      }
      if (input.enabled !== undefined) {
        await authorizeAgent(app, request, current, 'agents.enable');
      }

      const slugError = assertSlugUnchanged(current.slug, input.slug);
      if (slugError) return invalid(reply, slugError);
      if (input.subAgentIds !== undefined) {
        // 自己已经是子智能体时不能再有子智能体，否则就是两层。
        if (current.parentId !== null && input.subAgentIds.length > 0) {
          return invalid(reply, 'a sub-agent cannot have its own sub-agents');
        }
        const subAgentError = await validateSubAgents(app, current.id, input.subAgentIds);
        if (subAgentError) return invalid(reply, subAgentError);
        await authorizeSubAgentBindings(app, request, input.subAgentIds);
      }
      // 插件是会话级能力：子智能体不能绑定，避免出现「配了但实际不隔离」的假能力。
      if (current.parentId !== null && (input.pluginBindings?.length ?? 0) > 0) {
        return invalid(reply, '子智能体不能绑定插件；插件在会话级加载');
      }

      // 请求未提交的列必须留给数据库保留，避免并发的不同字段更新互相覆盖。
      const patch: Partial<repo.AgentWrite> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.role !== undefined) patch.role = input.role;
      if (input.description !== undefined) patch.description = input.description;
      if (input.model !== undefined) patch.model = input.model;
      if (input.systemPrompt !== undefined) patch.systemPromptMd = input.systemPrompt;
      if (input.allowedTools !== undefined) patch.allowedTools = input.allowedTools;
      if (input.disallowedTools !== undefined) patch.disallowedTools = input.disallowedTools;
      if (input.permissionMode !== undefined) patch.permissionMode = input.permissionMode;
      if (input.uiFormat !== undefined) patch.uiFormat = input.uiFormat;
      if (input.effort !== undefined) patch.effort = input.effort;
      if (input.enabled !== undefined) patch.enabled = input.enabled;
      if (input.maxTurns !== undefined) patch.maxTurns = input.maxTurns;
      if (input.maxBudgetUsd !== undefined) patch.maxBudgetUsd = String(input.maxBudgetUsd);
      if (input.timeoutMs !== undefined) patch.timeoutMs = input.timeoutMs;
      if (input.runtimeEnvironmentId !== undefined) {
        patch.runtimeEnvironmentId = input.runtimeEnvironmentId;
      }

      try {
        const row = await repo.updateAgent(
          app.db,
          request.params.id,
          patch,
          input.serverIds,
          input.skillIds,
          null,
          input.subAgentIds,
          input.expectedUpdatedAt,
          input.pluginBindings,
        );
        // 版本不匹配时仓储抛 409，走到这里只剩「行不存在」。
        if (!row) return notFound(reply);
        await writeAudit(app.db, request.log, {
          actor: principal.businessId,
          action: 'agent.updated',
          target: row.id,
          input,
          status: 'ok',
          requestId: request.id,
        });
        // 只有具备配置读取叶的调用者才拿完整 DTO；绑定-only 角色只看摘要。
        return canReadConfig ? detailOf(app, row) : toSummary(row);
      } catch (err) {
        rethrowConflict(err);
      }
    },
  );

  app.delete(
    '/api/agents/:id',
    { config: access('agents.delete'), schema: { params: idParams } },
    async (request, reply) => {
      const principal = principalOf(request);
      const current = await repo.getAgent(app.db, request.params.id);
      if (!current) return notFound(reply);
      await authorizeAgent(app, request, current, 'agents.delete');
      // 目录名依赖 slug，删除后无法再定位；先取出 slug 再删行。
      const slug = current.slug;
      const ok = await repo.deleteAgent(app.db, current.id);
      if (!ok) return notFound(reply);
      // 会话 transcript 是每次分支/续聊的运行时数据，删专家后不再需要；记忆按约定保留为持久资产。
      await rm(join(app.config.WORKSPACES_DIR, slug, 'sdk-sessions'), {
        recursive: true,
        force: true,
      }).catch((err: unknown) => {
        request.log.warn({ err, agentId: current.id }, 'sdk session cleanup failed');
      });
      // 会话行已级联删除，成果目录失去所有索引；整个专家目录一起回收。
      await rm(join(app.config.WORKSPACES_DIR, slug, 'conversation-outputs'), {
        recursive: true,
        force: true,
      }).catch((err: unknown) => {
        request.log.warn({ err, agentId: current.id }, 'output cleanup failed');
      });
      // 附件同样是会话行产生的运行数据：专家删除后没有任何索引可再引用。
      await rm(join(app.config.WORKSPACES_DIR, slug, 'conversation-inputs'), {
        recursive: true,
        force: true,
      }).catch((err: unknown) => {
        request.log.warn({ err, agentId: current.id }, 'input cleanup failed');
      });
      await writeAudit(app.db, request.log, {
        actor: principal.businessId,
        action: 'agent.deleted',
        target: current.id,
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );

  // 检查配置是否可渲染的最直接方式就是真渲染一次；只预览，不落盘。
  // 预览永远只含密钥键名，reveal=1 也不返回明文，仅要求浏览器不缓存。
  app.get(
    '/api/agents/:id/files',
    {
      config: access('agents.files.read'),
      schema: {
        params: idParams,
        querystring: z.object({ reveal: z.enum(['0', '1']).optional() }),
      },
    },
    async (request, reply) => {
      const current = await repo.getAgent(app.db, request.params.id);
      if (!current) return notFound(reply);
      // 完整文件包含配置、规则、样式与记忆视图；缺任一读取叶都拒绝，不静默泄漏。
      await authorizeAgent(app, request, current, 'agents.files.read');
      const files = await renderAgentWorkspace(app, current.id);
      if (!files) return notFound(reply);
      if (request.query.reveal === '1') reply.header('Cache-Control', 'no-store');
      return files;
    },
  );

  // 下载内容必须与 worker 落盘的 .claude/agents/<slug>.md 一致：先渲染父级工作区再取文件。
  app.get(
    '/api/agents/:id/subagents/:childId/file',
    { config: access('agents.files.read'), schema: { params: subAgentFileParams } },
    async (request, reply) => {
      const [parent, child] = await Promise.all([
        repo.getAgent(app.db, request.params.id),
        repo.getAgent(app.db, request.params.childId),
      ]);
      if (!parent || !child || child.parentId !== parent.id || child.id === parent.id) {
        return notFound(reply);
      }
      await authorizeAgent(app, request, parent, ['agents.files.read', 'agents.config.read']);
      const files = await renderAgentWorkspace(app, parent.id);
      const rendered = files?.subAgents.find((subAgent) => subAgent.slug === child.slug);
      if (!rendered) return notFound(reply);
      return reply
        .header('Content-Type', 'text/markdown; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${child.slug}.md"`)
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .send(rendered.content);
    },
  );

  app.get(
    '/api/agents/:id/versions',
    { config: access('agents.versions.read'), schema: { params: idParams } },
    async (request, reply) => {
      const current = await repo.getAgent(app.db, request.params.id);
      if (!current) return notFound(reply);
      await authorizeAgent(app, request, current, 'agents.versions.read');
      return allRepo.agentVersions.listAgentVersions(app.db, current.id);
    },
  );

  app.get(
    '/api/agents/:id/versions/:version',
    { config: access('agents.versions.read'), schema: { params: versionParams } },
    async (request, reply) => {
      const current = await repo.getAgent(app.db, request.params.id);
      if (!current) return notFound(reply);
      await authorizeAgent(app, request, current, 'agents.versions.read');
      const row = await allRepo.agentVersions.getAgentVersion(
        app.db,
        current.id,
        request.params.version,
      );
      if (!row) {
        return reject(reply, 'NOT_FOUND', '该版本不存在，可能已被清理；请刷新版本列表');
      }
      return {
        version: row.version,
        snapshot: row.snapshot,
        createdAt: row.createdAt.toISOString(),
      };
    },
  );

  app.post(
    '/api/agents/:id/rollback',
    { config: access('agents.versions.restore'), schema: { params: idParams, body: rollbackBody } },
    async (request, reply) => {
      const principal = principalOf(request);
      const current = await repo.getAgent(app.db, request.params.id);
      if (!current) return notFound(reply);
      await authorizeAgent(app, request, current, 'agents.versions.restore');
      const target = await allRepo.agentVersions.getAgentVersion(
        app.db,
        current.id,
        request.body.version,
      );
      if (!target) {
        return reject(reply, 'NOT_FOUND', '该版本不存在，可能已被清理；请刷新版本列表');
      }

      const snapshot = target.snapshot;
      const envError = await validateRuntimeEnvironment(app, snapshot.runtimeEnvironmentId ?? null);
      if (envError) return invalid(reply, envError);
      const toolError = unsupportedAllowedTool(snapshot.allowedTools);
      if (toolError) return invalid(reply, toolError);
      // 旧快照没有 subAgentIds 字段；缺失时保持现有关系不动。
      const snapshotSubAgentIds = snapshot.subAgentIds as string[] | undefined;
      if (snapshotSubAgentIds !== undefined) {
        if (current.parentId !== null && snapshotSubAgentIds.length > 0) {
          return invalid(reply, 'a sub-agent cannot have its own sub-agents');
        }
        const subAgentError = await validateSubAgents(app, current.id, snapshotSubAgentIds);
        if (subAgentError) return invalid(reply, subAgentError);
        await authorizeSubAgentBindings(app, request, snapshotSubAgentIds);
      }
      try {
        const row = await repo.updateAgent(
          app.db,
          current.id,
          snapshotToWrite(snapshot, current.slug, current.role),
          snapshot.serverIds,
          snapshot.skillIds,
          `rollback to v${target.version}`,
          snapshotSubAgentIds,
          undefined,
          // 旧快照没有 pluginBindings；缺失时保持现有绑定不动。
          (snapshot as { pluginBindings?: Agent['pluginBindings'] }).pluginBindings,
        );
        if (!row) return notFound(reply);
        await writeAudit(app.db, request.log, {
          actor: principal.businessId,
          action: 'agent.rolled_back',
          target: row.id,
          input: { version: target.version },
          status: 'ok',
          requestId: request.id,
        });
        const restoredPlugins = await repo.listAgentPluginBindings(app.db, [current.id]);
        return repo.toAgent(
          row,
          snapshot.serverIds,
          snapshot.skillIds,
          snapshotSubAgentIds ?? [],
          restoredPlugins.get(current.id) ?? [],
        );
      } catch (err) {
        rethrowConflict(err);
      }
    },
  );

  // 长期记忆：Claude Code 原生 auto-memory（MEMORY.md + 主题文件），平台只浏览/编辑。
  // 目录是 WORKSPACES_DIR/<slug>/agent-memory/，worker 每次运行读写挂载进容器。
  const authorizedAgent = async (
    request: FastifyRequest,
    reply: FastifyReply,
    id: string,
    permissionIds: PermissionId | PermissionId[],
  ): Promise<repo.AgentRow | null> => {
    const row = await repo.getAgent(app.db, id);
    if (!row) {
      notFound(reply);
      return null;
    }
    await authorizeAgent(app, request, row, permissionIds);
    return row;
  };

  app.get(
    '/api/agents/:id/memory',
    { config: access('agents.memory.read'), schema: { params: memoryParams } },
    async (request, reply) => {
      const row = await authorizedAgent(request, reply, request.params.id, 'agents.memory.read');
      if (!row) return reply;
      return listMemoryFiles(app.config.WORKSPACES_DIR, row.slug);
    },
  );

  // 原生记忆目录下载：ZIP 只含 agent-memory 下的 .md 文件，解压即可作为官方 auto-memory 目录使用。
  app.get(
    '/api/agents/:id/memory/download',
    { config: access('agents.memory.read'), schema: { params: memoryParams } },
    async (request, reply) => {
      const row = await authorizedAgent(request, reply, request.params.id, 'agents.memory.read');
      if (!row) return reply;
      const body = await withMemoryTargetLock(
        app.pool,
        { kind: 'agent_memory', agentId: row.id, name: 'MEMORY.md' },
        principalOf(request).businessId,
        async () => {
          const listed = await listMemoryFiles(app.config.WORKSPACES_DIR, row.slug);
          if (listed.files.length === 0) {
            fail('NOT_FOUND', '该专家还没有可下载的记忆文件');
          }
          if (listed.files.length > AGENT_PACKAGE_MAX_ENTRIES) {
            fail('CONFLICT', `记忆文件数超过 ${AGENT_PACKAGE_MAX_ENTRIES} 个，无法打包下载`);
          }
          const files: Record<string, string> = {};
          let total = 0;
          for (const file of listed.files) {
            const content = await readMemoryFile(app.config.WORKSPACES_DIR, row.slug, file.name);
            if (!content) fail('NOT_FOUND', '记忆文件在下载过程中被删除');
            total += Buffer.byteLength(content.content, 'utf8');
            if (total > AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES) {
              fail(
                'CONFLICT',
                `记忆目录解压后超过 ${AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES} 字节，无法打包下载`,
              );
            }
            files[file.name] = content.content;
          }
          const archive = encodePackage(files);
          if (archive.byteLength > AGENT_PACKAGE_MAX_BYTES) {
            fail('CONFLICT', `记忆目录压缩后超过 ${AGENT_PACKAGE_MAX_BYTES} 字节，无法打包下载`);
          }
          return archive;
        },
      );
      return reply
        .header('content-disposition', `attachment; filename="${row.slug}-memory.zip"`)
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .type('application/zip')
        .send(body);
    },
  );

  app.get(
    '/api/agents/:id/memory/:name',
    { config: access('agents.memory.read'), schema: { params: memoryFileParams } },
    async (request, reply) => {
      const row = await authorizedAgent(request, reply, request.params.id, 'agents.memory.read');
      if (!row) return reply;
      const file = await readMemoryFile(app.config.WORKSPACES_DIR, row.slug, request.params.name);
      if (!file) return notFound(reply);
      return file;
    },
  );

  app.put(
    '/api/agents/:id/memory/:name',
    {
      config: access('agents.memory.write'),
      schema: { params: memoryFileParams, body: memoryWriteBody },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      const row = await authorizedAgent(request, reply, request.params.id, 'agents.memory.write');
      if (!row) return reply;
      const slug = row.slug;
      const target = {
        kind: 'agent_memory',
        agentId: row.id,
        name: request.params.name,
      } as const;
      const file = await withMemoryTargetLock(app.pool, target, principal.businessId, async () => {
        // 正文意图交给写入口，在日志恢复并重读当前索引后计算 after，避免沿用恢复前的旧索引。
        await writeMemoryTargetLocked(app.db, {
          workspacesDir: app.config.WORKSPACES_DIR,
          businessId: principal.businessId,
          target,
          manualContent: request.body.content,
          logger: request.log,
        });
        const written = await readMemoryFile(app.config.WORKSPACES_DIR, slug, request.params.name);
        if (!written) throw new Error('memory file disappeared after write');
        return written;
      });
      await writeAudit(app.db, request.log, {
        actor: principal.businessId,
        action: 'agent.memory.write',
        target: row.id,
        input: { name: request.params.name },
        status: 'ok',
        requestId: request.id,
      });
      return file;
    },
  );

  app.delete(
    '/api/agents/:id/memory/:name',
    { config: access('agents.memory.write'), schema: { params: memoryFileParams } },
    async (request, reply) => {
      const principal = principalOf(request);
      const row = await authorizedAgent(request, reply, request.params.id, 'agents.memory.write');
      if (!row) return reply;
      const target = {
        kind: 'agent_memory',
        agentId: row.id,
        name: request.params.name,
      } as const;
      const removed = await withMemoryTargetLock(
        app.pool,
        target,
        principal.businessId,
        async () => {
          const current = await readMemoryTarget(
            app.db,
            app.config.WORKSPACES_DIR,
            target,
            principal.businessId,
          );
          if (current.content === null) return false;
          // 删除主题不改索引：账本里 index before/after 相同，便于按实际改动回滚。
          await writeMemoryTargetLocked(app.db, {
            workspacesDir: app.config.WORKSPACES_DIR,
            businessId: principal.businessId,
            target,
            manualContent: null,
            logger: request.log,
          });
          return true;
        },
      );
      if (!removed) return notFound(reply);
      await writeAudit(app.db, request.log, {
        actor: principal.businessId,
        action: 'agent.memory.delete',
        target: row.id,
        input: { name: request.params.name },
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );

  // 项目规则：渲染到 .claude/rules/<slug>.md（官方 project source 加载）。
  app.get(
    '/api/agents/:id/rules',
    { config: access('agents.rules.read'), schema: { params: memoryParams } },
    async (request, reply) => {
      const row = await authorizedAgent(request, reply, request.params.id, 'agents.rules.read');
      if (!row) return reply;
      const rows = await allRepo.rules.listRules(app.db, row.id);
      return rows.map((r) => ({
        id: r.id,
        agentId: r.agentId,
        slug: r.slug,
        content: r.content,
        globs: r.globs,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }));
    },
  );

  app.put(
    '/api/agents/:id/rules/:slug',
    { config: access('agents.rules.write'), schema: { params: ruleParams, body: ruleBody } },
    async (request, reply) => {
      const principal = principalOf(request);
      const agent = await authorizedAgent(request, reply, request.params.id, 'agents.rules.write');
      if (!agent) return reply;
      const target = {
        kind: 'agent_rule',
        agentId: agent.id,
        slug: request.params.slug,
      } as const;
      const row = await withMemoryTargetLock(app.pool, target, principal.businessId, async () => {
        await writeMemoryTargetLocked(app.db, {
          workspacesDir: app.config.WORKSPACES_DIR,
          businessId: principal.businessId,
          target,
          after: { content: request.body.content, globs: request.body.globs, index: null },
          logger: request.log,
        });
        const [rule] = await app.db
          .select()
          .from(schema.agentRules)
          .where(
            and(
              eq(schema.agentRules.agentId, agent.id),
              eq(schema.agentRules.slug, request.params.slug),
            ),
          )
          .limit(1);
        if (!rule) throw new Error('rule disappeared after write');
        return rule;
      });
      await writeAudit(app.db, request.log, {
        actor: principal.businessId,
        action: 'agent.rule.written',
        target: agent.id,
        input: { slug: row.slug },
        status: 'ok',
        requestId: request.id,
      });
      return {
        id: row.id,
        agentId: row.agentId,
        slug: row.slug,
        content: row.content,
        globs: row.globs,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    },
  );

  app.delete(
    '/api/agents/:id/rules/:slug',
    { config: access('agents.rules.write'), schema: { params: ruleParams } },
    async (request, reply) => {
      const principal = principalOf(request);
      const agent = await authorizedAgent(request, reply, request.params.id, 'agents.rules.write');
      if (!agent) return reply;
      const target = {
        kind: 'agent_rule',
        agentId: agent.id,
        slug: request.params.slug,
      } as const;
      const removed = await withMemoryTargetLock(
        app.pool,
        target,
        principal.businessId,
        async () => {
          const [rule] = await app.db
            .select({ id: schema.agentRules.id })
            .from(schema.agentRules)
            .where(
              and(
                eq(schema.agentRules.agentId, agent.id),
                eq(schema.agentRules.slug, request.params.slug),
              ),
            )
            .limit(1);
          if (!rule) return false;
          await writeMemoryTargetLocked(app.db, {
            workspacesDir: app.config.WORKSPACES_DIR,
            businessId: principal.businessId,
            target,
            after: { content: null, globs: '', index: null },
            logger: request.log,
          });
          return true;
        },
      );
      if (!removed) return notFound(reply);
      await writeAudit(app.db, request.log, {
        actor: principal.businessId,
        action: 'agent.rule.deleted',
        target: agent.id,
        input: { slug: request.params.slug },
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );

  // 输出风格：渲染到 .claude/output-styles/<slug>.md，选中者经 settings.outputStyle 激活。
  app.get(
    '/api/agents/:id/output-styles',
    { config: access('agents.styles.read'), schema: { params: memoryParams } },
    async (request, reply) => {
      const row = await authorizedAgent(request, reply, request.params.id, 'agents.styles.read');
      if (!row) return reply;
      const rows = await allRepo.outputStyles.listOutputStyles(app.db, row.id);
      return rows.map(toOutputStyle);
    },
  );

  app.put(
    '/api/agents/:id/output-styles/:slug',
    {
      config: access('agents.styles.write'),
      schema: { params: outputStyleParams, body: outputStyleWriteBody },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      const agent = await authorizedAgent(request, reply, request.params.id, 'agents.styles.write');
      if (!agent) return reply;
      const row = await allRepo.outputStyles.upsertOutputStyle(app.db, agent.id, {
        slug: request.params.slug,
        ...request.body,
      });
      await writeAudit(app.db, request.log, {
        actor: principal.businessId,
        action: 'agent.output_style.written',
        target: agent.id,
        input: { slug: row.slug },
        status: 'ok',
        requestId: request.id,
      });
      return toOutputStyle(row);
    },
  );

  app.post(
    '/api/agents/:id/output-styles/:slug/unselect',
    { config: access('agents.styles.write'), schema: { params: outputStyleParams } },
    async (request, reply) => {
      const principal = principalOf(request);
      const agent = await authorizedAgent(request, reply, request.params.id, 'agents.styles.write');
      if (!agent) return reply;
      const ok = await allRepo.outputStyles.unselectOutputStyle(
        app.db,
        agent.id,
        request.params.slug,
      );
      if (!ok) return reject(reply, 'NOT_FOUND', '该输出风格不存在，可能已被删除');
      await writeAudit(app.db, request.log, {
        actor: principal.businessId,
        action: 'agent.output_style.unselected',
        target: agent.id,
        input: { slug: request.params.slug },
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );

  app.delete(
    '/api/agents/:id/output-styles/:slug',
    { config: access('agents.styles.write'), schema: { params: outputStyleParams } },
    async (request, reply) => {
      const principal = principalOf(request);
      const agent = await authorizedAgent(request, reply, request.params.id, 'agents.styles.write');
      if (!agent) return reply;
      const removed = await allRepo.outputStyles.deleteOutputStyle(
        app.db,
        agent.id,
        request.params.slug,
      );
      if (!removed) return reject(reply, 'NOT_FOUND', '该输出风格不存在，可能已被删除');
      await writeAudit(app.db, request.log, {
        actor: principal.businessId,
        action: 'agent.output_style.deleted',
        target: agent.id,
        input: { slug: request.params.slug },
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );

  // 成员：本人负责的专家才可授权；维护人员只能维护，不能改成员。
  app.get(
    '/api/agents/:id/members',
    { config: access('agents.members.manage'), schema: { params: memoryParams } },
    async (request, reply) => {
      const row = await authorizedAgent(request, reply, request.params.id, 'agents.members.manage');
      if (!row) return reply;
      const members = await allRepo.access.listAgentMembers(app.db, row.id);
      return { ownerBusinessId: row.ownerBusinessId, members };
    },
  );

  app.put(
    '/api/agents/:id/members/:businessId',
    {
      config: access('agents.members.manage'),
      schema: { params: memberParams, body: agentMemberInputSchema },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      const row = await authorizedAgent(request, reply, request.params.id, 'agents.members.manage');
      if (!row) return reply;
      if (!(await registeredIdentity(app, request.params.businessId))) {
        return invalid(reply, '该业务 ID 尚未登记为人员，无法授权；请先在账户中添加该人员');
      }
      const member = await allRepo.access.setAgentMember(app.db, row.id, {
        businessId: request.params.businessId,
        canUse: request.body.canUse,
        canMaintain: request.body.canMaintain,
      });
      await writeAudit(app.db, request.log, {
        actor: principal.businessId,
        action: 'agent.member.updated',
        target: row.id,
        input: request.params.businessId,
        status: 'ok',
        requestId: request.id,
      });
      return member;
    },
  );

  app.delete(
    '/api/agents/:id/members/:businessId',
    { config: access('agents.members.manage'), schema: { params: memberParams } },
    async (request, reply) => {
      const principal = principalOf(request);
      const row = await authorizedAgent(request, reply, request.params.id, 'agents.members.manage');
      if (!row) return reply;
      if (request.params.businessId === row.ownerBusinessId) {
        return invalid(reply, '负责人不是可删除的成员行；需要变更负责人请使用转交');
      }
      const removed = await allRepo.access.deleteAgentMember(
        app.db,
        row.id,
        request.params.businessId,
      );
      if (!removed) return reject(reply, 'NOT_FOUND', '该成员不存在，可能已被移除');
      await writeAudit(app.db, request.log, {
        actor: principal.businessId,
        action: 'agent.member.deleted',
        target: row.id,
        input: request.params.businessId,
        status: 'ok',
        requestId: request.id,
      });
      return { ok: true };
    },
  );

  // 转交：只改负责人，createdBy 保持创建人；原负责人不会自动保留成员权。
  app.post(
    '/api/agents/:id/transfer',
    { config: access('agents.transfer'), schema: { params: memoryParams, body: transferBody } },
    async (request, reply) => {
      const principal = principalOf(request);
      const row = await authorizedAgent(request, reply, request.params.id, 'agents.transfer');
      if (!row) return reply;
      const target = await allRepo.accounts.getIdentity(app.db, request.body.ownerBusinessId);
      if (!target || !target.accountActive) {
        return invalid(reply, '新负责人必须是已登记且未停用的账户');
      }
      const targetAccess = await allRepo.access.getUserAccess(app.db, request.body.ownerBusinessId);
      const canCreate = targetAccess.grants.some(
        (grant) =>
          grant.permissionId === 'agents.create' &&
          (grant.scope === 'own_data' || grant.scope === 'platform'),
      );
      if (!canCreate) {
        return invalid(reply, '新负责人需要具备「创建专家」权限');
      }
      const transferred = await allRepo.access.transferAgent(
        app.db,
        row.id,
        request.body.ownerBusinessId,
      );
      if (!transferred) return notFound(reply);
      await writeAudit(app.db, request.log, {
        actor: principal.businessId,
        action: 'agent.transferred',
        target: row.id,
        input: request.body.ownerBusinessId,
        status: 'ok',
        requestId: request.id,
      });
      const updated = await repo.getAgent(app.db, row.id);
      if (!updated) return notFound(reply);
      return detailOf(app, updated);
    },
  );

  // 负责人挑选成员用的身份摘要；必须绑定到本人可管理的具体专家，不授予全局账户读取权。
  app.get(
    '/api/identities',
    { config: authenticated, schema: { querystring: identitiesQuery } },
    async (request, reply) => {
      const row = await repo.getAgent(app.db, request.query.agentId);
      if (!row) return notFound(reply);
      await authorizeAgent(app, request, row, 'agents.members.manage');
      return allRepo.accounts.listIdentities(app.db, {
        limit: request.query.limit,
        offset: request.query.offset,
        ...(request.query.q === undefined ? {} : { q: request.query.q }),
      });
    },
  );
}
