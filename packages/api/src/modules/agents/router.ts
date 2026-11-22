import { agentsContract } from '@agentport/contract/agents';
import { fail, notFound, parseAgentMd } from '@agentport/core';
import { repo as allRepo, plugins as pluginsTable, schema } from '@agentport/db';
import {
  AGENT_HOOK_FILE_LIMIT,
  type AgentDefinition,
  decodeCursor,
  runEnqueueOptions,
  SUB_AGENT_PLUGIN_BINDING_MESSAGE,
  utcMonthStart,
} from '@agentport/shared';
import { implement, type Router } from '@orpc/server';
import { and, eq } from 'drizzle-orm';
import {
  accessFilter,
  agentAccess,
  authorize,
  authorizeObject,
  requireUser,
  resourceAccessFilter,
} from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { AppError, OBJECT_MISSING_MESSAGE, rethrowConflict } from '../../http/errors.js';
import { invalidCursor, requireCursorPage } from '../../http/pagination.js';
import { getQueue } from '../../queue/producer.js';
import {
  readMemoryTarget,
  withMemoryTargetLock,
  writeMemoryTargetLocked,
} from '../memory/changes.js';
import { requireRunQueueCapacity } from '../runs/capacity.js';
import { failQueuedRunEnqueue, failRunEnqueue } from '../runs/enqueue.js';
import { enforceContentPolicy } from '../security/policy-gate.js';
import { authorizeAgent, authorizedAgent } from './access.js';
import { listMemoryFiles, readMemoryFile } from './memory-files.js';
import {
  agentDetail,
  agentReferenceConflict,
  agentSlugConflictMessage,
  authorizeBoundResources,
  createAgent,
  restoreAgentVersion,
  toVersionDefinition,
  toWrite,
  transferAgent,
  validateRuntimeEnvironment,
  validateSubAgents,
} from './use-cases.js';
import { unsupportedAllowedTool } from './validation.js';
import { renderAgentWorkspace } from './workspace.js';
import { toAgentPatch } from './write.js';

type HookFileRow = Awaited<ReturnType<typeof allRepo.hooks.listHookFiles>>[number];
function toHookFile(row: HookFileRow) {
  return {
    id: row.id,
    agentId: row.agentId,
    path: row.path,
    content: row.content,
    executable: row.executable,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
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
async function authorizeSubAgentBindings(
  context: RequestContext,
  subAgentIds: string[],
): Promise<void> {
  for (const id of subAgentIds) {
    const child = await repo.getAgent(context.db, id);
    if (!child) continue;
    await authorizeAgent(context, child, 'agents.bindings.manage');
  }
}

async function validateDefinition(
  context: RequestContext,
  current: allRepo.agents.AgentRow,
  definition: AgentDefinition,
): Promise<void> {
  const { agent } = definition;
  const envError = await validateRuntimeEnvironment(context.db, agent.runtimeEnvironmentId);
  if (envError) invalid(envError);
  const toolError = unsupportedAllowedTool(agent.allowedTools);
  if (toolError) invalid(toolError);
  if (current.parentId !== null && agent.subAgentIds.length > 0) {
    invalid('a sub-agent cannot have its own sub-agents');
  }
  const subAgentError = await validateSubAgents(context.db, current.id, agent.subAgentIds);
  if (subAgentError) invalid(subAgentError);
  await authorizeSubAgentBindings(context, agent.subAgentIds);
  await allRepo.agentDefinitions.assertDefinitionResources(context.db, definition);
}

function invalid(message: string) {
  return fail('INVALID_INPUT', message);
}
function toSummary(
  row: allRepo.agents.AgentRow,
  serverIds?: string[],
  extras: { isFavorite?: boolean; lastUsedAt?: string | null } = {},
) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    isDefault: row.isDefault,
    createdBy: row.createdBy,
    ownerBusinessId: row.ownerBusinessId,
    slug: row.slug,
    role: row.role,
    model: row.model,
    uiFormat: row.uiFormat,
    parentId: row.parentId,
    visibility: row.visibility,
    tags: row.tags,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    isFavorite: extras.isFavorite ?? false,
    lastUsedAt: extras.lastUsedAt ?? null,
    createdAt: row.createdAt.toISOString(),
    ...(serverIds === undefined ? {} : { serverIds }),
  };
}
function assertSlugUnchanged(current: string, next: string | undefined): string | undefined {
  return next !== undefined && next !== current
    ? 'slug 是工作区目录名，创建后不能修改；需要新名称请另建智能体'
    : undefined;
}
const repo = allRepo.agents;

function listingAccess(context: RequestContext) {
  const { businessId, grants } = requireUser(context);
  return {
    access: {
      businessId,
      scopes: grants
        .filter((grant) => grant.permissionId === 'agents.read')
        .map((grant) => grant.scope),
    },
    configAccess: {
      businessId,
      scopes: grants
        .filter((grant) => grant.permissionId === 'agents.config.read')
        .map((grant) => grant.scope),
    },
  };
}

function toListSummary(row: Awaited<ReturnType<typeof repo.listAgentReference>>['items'][number]) {
  return toSummary(row, row.serverIds ?? undefined, {
    isFavorite: row.isFavorite,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  });
}

const os = implement(agentsContract).$context<RequestContext>();
export const agentsRouter: Router<typeof agentsContract, RequestContext> = os.router({
  list: os.list.handler(async ({ context, input }) => {
    const { cursor } = input.query;
    const anchor = cursor === undefined ? undefined : decodeCursor(cursor, 2);
    if (
      cursor !== undefined &&
      (!anchor || anchor[1] === undefined || anchor.some((part) => part.includes('\0')))
    ) {
      return invalidCursor();
    }
    const page = requireCursorPage(
      await repo.listAgents(context.db, {
        ...input.query,
        ...(anchor == null ? {} : { cursor: anchor[1], cursorSort: anchor[0] }),
        ...listingAccess(context),
      }),
    );
    return { items: page.items.map(toListSummary), nextCursor: page.nextCursor };
  }),
  reference: os.reference.handler(async ({ context }) => {
    const { access, configAccess } = listingAccess(context);
    const { items, truncated } = await repo.listAgentReference(context.db, access, configAccess);
    return { items: items.map(toListSummary), truncated };
  }),
  tags: os.tags.handler(async ({ context }) => {
    const items = await repo.listAgentTags(context.db, accessFilter(context, 'agents.read'));
    return { items };
  }),
  favorite: os.favorite.handler(async ({ context, input }) => {
    const current = await repo.getAgent(context.db, input.params.id);
    if (!current) return notFound('agent');
    const principal = requireUser(context);
    await authorizeAgent(context, current, 'agents.use');
    const favorite = await repo.setAgentFavorite(
      context.db,
      principal.businessId,
      current.id,
      input.body.favorite,
    );
    return { favorite };
  }),
  archive: os.archive.handler(async ({ context, input }) => {
    const principal = requireUser(context);
    const current = await repo.getAgent(context.db, input.params.id);
    if (!current) return notFound('agent');
    await authorizeAgent(context, current, 'agents.delete');
    const row = await repo.archiveAgent(context.db, current.id);
    if (!row) return notFound('agent');
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.archived',
      target: row.id,
      status: 'ok',
      requestId: context.requestId,
    });
    return toSummary(row);
  }),
  restore: os.restore.handler(async ({ context, input }) => {
    const principal = requireUser(context);
    const current = await repo.getAgent(context.db, input.params.id);
    if (!current) return notFound('agent');
    await authorizeAgent(context, current, 'agents.delete');
    const row = await repo.restoreAgent(context.db, current.id);
    if (!row) return notFound('agent');
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.restored',
      target: row.id,
      status: 'ok',
      requestId: context.requestId,
    });
    return toSummary(row);
  }),
  create: os.create.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    await authorize(context, 'agents.create');
    const input = routeInput.body;
    const toolError = unsupportedAllowedTool(routeInput.body.allowedTools ?? []);
    if (toolError) return invalid(toolError);
    const { subAgentIds } = input;
    const subAgentError = await validateSubAgents(context.db, null, subAgentIds);
    if (subAgentError) return invalid(subAgentError);
    await authorizeSubAgentBindings(context, subAgentIds);
    await authorizeBoundResources(context, {
      serverIds: input.serverIds,
      skillIds: input.skillIds,
      pluginIds: input.pluginBindings.map((binding) => binding.pluginId),
      runtimeEnvironmentId: input.runtimeEnvironmentId,
    });
    const envError = await validateRuntimeEnvironment(context.db, input.runtimeEnvironmentId);
    if (envError) return invalid(envError);
    return createAgent(
      {
        db: context.db,
        log: context.log,
        actor: principal.businessId,
        requestId: context.requestId,
      },
      input,
    );
  }),
  duplicate: os.duplicate.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const source = await repo.getAgent(context.db, routeInput.params.id);
    if (!source) return notFound('agent');
    await authorizeAgent(context, source, 'agents.clone');
    await authorize(context, 'agents.create');
    const [serverIds, skillIds, pluginBindings] = await Promise.all([
      repo.getAgentServerIds(context.db, source.id),
      repo.getAgentSkillIds(context.db, source.id),
      allRepo.plugins.listAgentPluginBindingInputs(context.db, [source.id]),
    ]);
    await authorizeBoundResources(context, {
      serverIds,
      skillIds,
      pluginIds: (pluginBindings.get(source.id) ?? []).map((binding) => binding.pluginId),
      runtimeEnvironmentId: source.runtimeEnvironmentId,
    });
    try {
      const row = await repo.duplicateAgent(
        context.db,
        source.id,
        routeInput.body,
        principal.businessId,
      );
      if (!row) return notFound('agent');
      await allRepo.audit.writeAudit(context.db, context.log, {
        actor: principal.businessId,
        action: 'agent.duplicated',
        target: row.id,
        input: { sourceId: source.id },
        status: 'ok',
        requestId: context.requestId,
      });
      return row;
    } catch (err) {
      rethrowConflict(err, agentSlugConflictMessage, agentReferenceConflict);
    }
  }),
  importFile: os.importFile.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    await authorize(context, 'agents.create');
    const { agent: imported, warnings } = parseAgentMd(routeInput.body.agentMd);
    const { serverIds, skillIds, subAgentIds, pluginBindings, ...rest } = imported;
    await authorizeSubAgentBindings(context, subAgentIds);
    await authorizeBoundResources(context, {
      serverIds,
      skillIds,
      pluginIds: pluginBindings.map((binding) => binding.pluginId),
    });
    try {
      const row = await repo.createAgent(
        context.db,
        toWrite(rest, principal.businessId),
        serverIds,
        skillIds,
        subAgentIds,
        pluginBindings,
      );
      await allRepo.audit.writeAudit(context.db, context.log, {
        actor: principal.businessId,
        action: 'agent.imported',
        target: row.id,
        input: { slug: row.slug },
        status: 'ok',
        requestId: context.requestId,
      });
      return {
        agent: repo.toAgent(row, serverIds, skillIds, subAgentIds, pluginBindings),
        warnings,
      };
    } catch (err) {
      rethrowConflict(err, agentSlugConflictMessage, agentReferenceConflict);
    }
  }),
  options: os.options.handler(async ({ context }) => {
    const principal = requireUser(context);
    if (!principal.grants.some((grant) => grant.permissionId === 'agents.bindings.manage')) {
      throw new AppError('FORBIDDEN', '没有管理专家资源绑定的权限');
    }
    const [serverAccess, skillAccess, pluginAccess, environmentAccess] = await Promise.all([
      resourceAccessFilter(context, 'servers.read', 'server', 'read'),
      resourceAccessFilter(context, 'skills.read', 'skill', 'read'),
      resourceAccessFilter(context, 'plugins.read', 'plugin', 'read'),
      resourceAccessFilter(context, 'runtime_environments.read', 'runtime_environment', 'read'),
    ]);
    const [servers, skills, plugins, environments] = await Promise.all([
      context.db
        .select({ id: schema.servers.id, name: schema.servers.name, kind: schema.servers.kind })
        .from(schema.servers)
        .where(
          allRepo.access.resourceScopeWhere(
            serverAccess,
            schema.servers.id,
            schema.servers.ownerBusinessId,
          ),
        )
        .orderBy(schema.servers.name),
      context.db
        .select({
          id: schema.skills.id,
          slug: schema.skills.slug,
          name: schema.skills.name,
          description: schema.skills.description,
        })
        .from(schema.skills)
        .where(
          and(
            allRepo.access.resourceScopeWhere(
              skillAccess,
              schema.skills.id,
              schema.skills.ownerBusinessId,
            ),
            eq(schema.skills.status, 'published'),
          ),
        )
        .orderBy(schema.skills.name),
      context.db
        .select({
          id: pluginsTable.id,
          slug: pluginsTable.slug,
          name: pluginsTable.name,
        })
        .from(pluginsTable)
        .where(
          allRepo.access.resourceScopeWhere(
            pluginAccess,
            pluginsTable.id,
            pluginsTable.ownerBusinessId,
          ),
        )
        .orderBy(pluginsTable.name),
      context.db
        .select({
          id: schema.runtimeEnvironments.id,
          name: schema.runtimeEnvironments.name,
          onlineVersionId: schema.runtimeEnvironments.onlineVersionId,
        })
        .from(schema.runtimeEnvironments)
        .where(
          allRepo.access.resourceScopeWhere(
            environmentAccess,
            schema.runtimeEnvironments.id,
            schema.runtimeEnvironments.ownerBusinessId,
          ),
        )
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
  }),
  get: os.get.handler(async ({ context, input: routeInput }) => {
    const row = await repo.getAgent(context.db, routeInput.params.id);
    if (!row) return notFound('agent');
    await authorizeAgent(context, row, 'agents.config.read');
    return agentDetail(context.db, row);
  }),
  budget: os.budget.handler(async ({ context, input: routeInput }) => {
    const row = await repo.getAgent(context.db, routeInput.params.id);
    if (!row) return notFound('agent');
    await authorizeAgent(context, row, 'agents.config.read');
    const periodStart = utcMonthStart();
    const spentUsd = await repo.sumAgentSpendSince(context.db, row.id, periodStart);
    const monthlyBudgetUsd = row.monthlyBudgetUsd === null ? null : Number(row.monthlyBudgetUsd);
    const budgetAlertRatio = Number(row.budgetAlertRatio);
    const ratio = monthlyBudgetUsd === null ? null : spentUsd / monthlyBudgetUsd;
    const state =
      monthlyBudgetUsd === null
        ? 'unlimited'
        : spentUsd >= monthlyBudgetUsd
          ? 'exceeded'
          : spentUsd >= monthlyBudgetUsd * budgetAlertRatio
            ? 'alert'
            : 'ok';
    return {
      monthlyBudgetUsd,
      budgetAlertRatio,
      periodStart: periodStart.toISOString(),
      spentUsd,
      ratio,
      state,
    };
  }),
  access: os.access.handler(async ({ context, input: routeInput }) => {
    const row = await repo.getAgent(context.db, routeInput.params.id);
    if (!row) return notFound('agent');
    const result = await agentAccess(context, row.id);
    if (!result.permissionIds.includes('agents.read')) return notFound('agent');
    return result;
  }),
  update: os.update.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const input = routeInput.body;
    const toolError = unsupportedAllowedTool(routeInput.body.allowedTools ?? []);
    if (toolError) return invalid(toolError);
    const current = await repo.getAgent(context.db, routeInput.params.id);
    if (!current) return notFound('agent');
    const access = await agentAccess(context, current.id);
    if (!access.permissionIds.includes('agents.read')) return notFound('agent');
    const canReadConfig = access.permissionIds.includes('agents.config.read');
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
      input.monthlyBudgetUsd,
      input.budgetAlertRatio,
      input.timeoutMs,
      input.runtimeEnvironmentId,
      input.visibility,
      input.tags,
    ];
    const bindingFields = [
      input.serverIds,
      input.skillIds,
      input.pluginBindings,
      input.subAgentIds,
    ];
    const updatesConfig = configFields.some((field) => field !== undefined);
    const updatesBindings = bindingFields.some((field) => field !== undefined);
    if (!updatesConfig && !updatesBindings && input.enabled === undefined) {
      return invalid('请至少提供一个可修改字段');
    }
    if (updatesConfig) {
      await authorizeAgent(context, current, 'agents.config.update');
    }
    if (updatesBindings) {
      await authorizeAgent(context, current, 'agents.bindings.manage');
    }
    if (input.enabled !== undefined) {
      await authorizeAgent(context, current, 'agents.enable');
    }
    if (
      input.serverIds !== undefined ||
      input.skillIds !== undefined ||
      input.pluginBindings !== undefined ||
      input.runtimeEnvironmentId !== undefined
    ) {
      await authorizeBoundResources(context, {
        serverIds: input.serverIds,
        skillIds: input.skillIds,
        pluginIds: input.pluginBindings?.map((binding) => binding.pluginId),
        runtimeEnvironmentId: input.runtimeEnvironmentId,
      });
    }
    if (input.runtimeEnvironmentId !== undefined) {
      const envError = await validateRuntimeEnvironment(context.db, input.runtimeEnvironmentId);
      if (envError) return invalid(envError);
    }
    const slugError = assertSlugUnchanged(current.slug, input.slug);
    if (slugError) return invalid(slugError);
    if (input.subAgentIds !== undefined) {
      if (current.parentId !== null && input.subAgentIds.length > 0) {
        return invalid('a sub-agent cannot have its own sub-agents');
      }
      const subAgentError = await validateSubAgents(context.db, current.id, input.subAgentIds);
      if (subAgentError) return invalid(subAgentError);
      await authorizeSubAgentBindings(context, input.subAgentIds);
    }
    if (current.parentId !== null && (input.pluginBindings?.length ?? 0) > 0) {
      return invalid(SUB_AGENT_PLUGIN_BINDING_MESSAGE);
    }
    const patch = toAgentPatch(input);
    try {
      const row =
        !updatesConfig && !updatesBindings && input.enabled !== undefined
          ? await allRepo.agentDefinitions.setAgentEnabled(context.db, current.id, input.enabled)
          : await repo.updateAgent(
              context.db,
              routeInput.params.id,
              patch,
              input.serverIds,
              input.skillIds,
              null,
              input.subAgentIds,
              input.expectedUpdatedAt === undefined ? undefined : new Date(input.expectedUpdatedAt),
              input.pluginBindings,
            );
      if (!row) return notFound('agent');
      await allRepo.audit.writeAudit(context.db, context.log, {
        actor: principal.businessId,
        action: 'agent.updated',
        target: row.id,
        input,
        status: 'ok',
        requestId: context.requestId,
      });
      return canReadConfig
        ? { kind: 'detail' as const, agent: await agentDetail(context.db, row) }
        : { kind: 'summary' as const, agent: toSummary(row) };
    } catch (err) {
      rethrowConflict(err, agentSlugConflictMessage, agentReferenceConflict);
    }
  }),
  publish: os.publish.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const current = await authorizedAgent(context, routeInput.params.id, 'agents.publish');
    const definition = await allRepo.agentDefinitions.loadLiveDefinition(context.db, current.id);
    if (!definition) return notFound('agent');
    await validateDefinition(context, current, definition);
    const canReadConfig = (await agentAccess(context, current.id)).permissionIds.includes(
      'agents.config.read',
    );
    const row = await allRepo.agentDefinitions.publishCurrent(
      context.db,
      current.id,
      routeInput.body.note ?? null,
    );
    if (!row) return notFound('agent');
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.published',
      target: row.id,
      input: { note: routeInput.body.note ?? null },
      status: 'ok',
      requestId: context.requestId,
    });
    return canReadConfig
      ? { kind: 'detail' as const, agent: await agentDetail(context.db, row) }
      : { kind: 'summary' as const, agent: toSummary(row) };
  }),
  offline: os.offline.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const current = await authorizedAgent(context, routeInput.params.id, 'agents.enable');
    const canReadConfig = (await agentAccess(context, current.id)).permissionIds.includes(
      'agents.config.read',
    );
    const row = await allRepo.agentDefinitions.setAgentEnabled(context.db, current.id, false);
    if (!row) return notFound('agent');
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.offline',
      target: row.id,
      status: 'ok',
      requestId: context.requestId,
    });
    return canReadConfig
      ? { kind: 'detail' as const, agent: await agentDetail(context.db, row) }
      : { kind: 'summary' as const, agent: toSummary(row) };
  }),
  trial: os.trial.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const current = await authorizedAgent(context, routeInput.params.id, 'agents.config.update');
    await authorizeAgent(context, current, 'agents.read');
    await authorizeAgent(context, current, 'agents.use');
    const definition = await allRepo.agentDefinitions.loadLiveDefinition(context.db, current.id);
    if (!definition) return notFound('agent');
    await validateDefinition(context, current, definition);
    await requireRunQueueCapacity();
    const { prompt: submittedPrompt } = routeInput.body;
    const policyDecision = await enforceContentPolicy({
      db: context.db,
      log: context.log,
      requestId: context.requestId,
      actor: principal.businessId,
      anthropicBaseUrl: context.config.ANTHROPIC_BASE_URL,
      agentId: current.id,
      origin: 'trial',
      sourceKind: 'run_prompt',
      sourceId: context.requestId,
      texts: [submittedPrompt],
      payload: ([text]) => ({ data: text, binding: { prompt: submittedPrompt } }),
    });
    const prompt = policyDecision.payload;
    const { run, conversationId } = await allRepo.chat.admitChatRun(context.db, {
      agentId: current.id,
      message: prompt,
      title: `试跑: ${prompt.slice(0, 60)}`,
      trigger: 'chat',
      subject: { kind: 'user', businessId: principal.businessId },
      ...(current.publishedVersion === null ? {} : { agentVersion: current.publishedVersion }),
      definitionSnapshot: definition,
      allowDisabled: true,
      ...(policyDecision.eventId === null ? {} : { policyEventId: policyDecision.eventId }),
      ...(policyDecision.approvalId === null
        ? {}
        : { consumePolicyApprovalId: policyDecision.approvalId }),
    });
    try {
      await getQueue().add(
        'run',
        {
          runId: run.id,
          agentId: current.id,
          conversationId,
          prompt,
          requestId: context.requestId,
        },
        runEnqueueOptions(run.id),
      );
    } catch {
      await failQueuedRunEnqueue(context.db, run.id).catch((err: unknown) => {
        context.log.warn({ err, runId: run.id }, 'trial enqueue failure cleanup failed');
      });
      return failRunEnqueue();
    }
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.trial.started',
      target: current.id,
      input: { runId: run.id, conversationId },
      status: 'ok',
      requestId: context.requestId,
    });
    return { runId: run.id, conversationId };
  }),
  delete: os.delete.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const current = await repo.getAgent(context.db, routeInput.params.id);
    if (!current) return notFound('agent');
    await authorizeAgent(context, current, 'agents.delete');
    const deleted = await repo.softDeleteAgent(context.db, current.id);
    if (!deleted) return notFound('agent');
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.deleted',
      target: current.id,
      status: 'ok',
      requestId: context.requestId,
    });
    return undefined;
  }),
  files: os.files.handler(async ({ context, input: routeInput }) => {
    const current = await repo.getAgent(context.db, routeInput.params.id);
    if (!current) return notFound('agent');
    await authorizeAgent(context, current, 'agents.files.read');
    if (
      current.hooksEnabled ||
      (await allRepo.hooks.listHookFiles(context.db, current.id)).length > 0
    ) {
      await authorizeObject(
        context,
        'agents.hooks.read',
        { agentId: current.id, createdBy: current.createdBy },
        OBJECT_MISSING_MESSAGE,
      );
    }
    const childIds = (await repo.listSubAgents(context.db, current.id))
      .filter((row) => row.enabled)
      .map((row) => row.id);
    const agentIds = [current.id, ...childIds];
    const [serversByAgent, skillsByAgent, pluginBindings] = await Promise.all([
      repo.getBoundServersByAgentIds(context.db, agentIds),
      repo.getBoundSkillsByAgentIds(context.db, agentIds),
      allRepo.plugins.listAgentPluginBindings(context.db, current.id),
    ]);
    await authorizeBoundResources(context, {
      serverIds: [...new Set([...serversByAgent.values()].flat().map((row) => row.id))],
      skillIds: [...new Set([...skillsByAgent.values()].flat().map((row) => row.id))],
      pluginIds: pluginBindings.map(({ plugin }) => plugin.id),
      runtimeEnvironmentId: current.runtimeEnvironmentId ?? undefined,
    });
    const files = await renderAgentWorkspace(context, current.id);
    if (!files) return notFound('agent');
    if (routeInput.query.reveal === '1') context.responseHeaders.set('Cache-Control', 'no-store');
    return files;
  }),
  versions: os.versions.handler(async ({ context, input: routeInput }) => {
    const current = await repo.getAgent(context.db, routeInput.params.id);
    if (!current) return notFound('agent');
    await authorizeAgent(context, current, 'agents.versions.read');
    return allRepo.agentVersions.listAgentVersions(context.db, current.id);
  }),
  version: os.version.handler(async ({ context, input: routeInput }) => {
    const current = await repo.getAgent(context.db, routeInput.params.id);
    if (!current) return notFound('agent');
    await authorizeAgent(context, current, 'agents.versions.read');
    const row = await allRepo.agentVersions.getAgentVersion(
      context.db,
      current.id,
      routeInput.params.version,
    );
    if (!row) {
      return fail('NOT_FOUND', '该版本不存在，可能已被清理；请刷新版本列表');
    }
    const definitionPermissions = [
      'agents.config.read',
      'agents.rules.read',
      'agents.styles.read',
      'agents.workflows.read',
      'agents.hooks.read',
      'agents.memory.read',
    ] as const;
    const allowed =
      row.definition === null
        ? null
        : new Set((await agentAccess(context, current.id)).permissionIds);
    const canReadDefinition =
      allowed !== null && definitionPermissions.every((id) => allowed.has(id));
    let definitionState: 'available' | 'forbidden' | 'legacy' =
      row.definition === null ? 'legacy' : canReadDefinition ? 'available' : 'forbidden';
    if (definitionState === 'available' && row.definition) {
      try {
        await authorizeBoundResources(context, {
          serverIds: row.definition.resources.servers.map((server) => server.id),
          skillIds: row.definition.resources.skills.map((skill) => skill.id),
          pluginIds: row.definition.resources.plugins.map((plugin) => plugin.id),
          runtimeEnvironmentId: row.definition.resources.runtimeEnvironment?.id,
        });
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        definitionState = 'forbidden';
      }
    }
    return {
      version: row.version,
      snapshot: { ...row.snapshot, isDefault: current.isDefault },
      definition:
        definitionState === 'available' && row.definition
          ? toVersionDefinition(row.definition)
          : null,
      definitionState,
      createdAt: row.createdAt.toISOString(),
    };
  }),
  rollback: os.rollback.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const current = await repo.getAgent(context.db, routeInput.params.id);
    if (!current) return notFound('agent');
    await authorizeAgent(context, current, 'agents.versions.restore');
    await authorizeAgent(context, current, 'agents.publish');
    const canReadConfig = (await agentAccess(context, current.id)).permissionIds.includes(
      'agents.config.read',
    );
    const target = await allRepo.agentVersions.getAgentVersion(
      context.db,
      current.id,
      routeInput.body.version,
    );
    if (!target) {
      return fail('NOT_FOUND', '该版本不存在，可能已被清理；请刷新版本列表');
    }
    if (target.definition) {
      await authorizeBoundResources(context, {
        serverIds: target.definition.resources.servers.map((server) => server.id),
        skillIds: target.definition.resources.skills.map((skill) => skill.id),
        pluginIds: target.definition.resources.plugins.map((plugin) => plugin.id),
        runtimeEnvironmentId: target.definition.resources.runtimeEnvironment?.id,
      });
      await validateDefinition(context, current, target.definition);
      const row = await allRepo.agentDefinitions
        .publishDefinition(
          context.db,
          current.id,
          target.definition,
          `rollback to v${target.version}`,
        )
        .catch((err) => rethrowConflict(err, agentSlugConflictMessage, agentReferenceConflict));
      if (!row) return notFound('agent');
      await allRepo.audit.writeAudit(context.db, context.log, {
        actor: principal.businessId,
        action: 'agent.rolled_back',
        target: row.id,
        input: { version: target.version },
        status: 'ok',
        requestId: context.requestId,
      });
      return canReadConfig
        ? { kind: 'detail' as const, agent: await agentDetail(context.db, row) }
        : { kind: 'summary' as const, agent: toSummary(row) };
    }
    const snapshot = target.snapshot;
    await authorizeBoundResources(context, {
      serverIds: snapshot.serverIds ?? [],
      skillIds: snapshot.skillIds ?? [],
      pluginIds: (snapshot.pluginBindings ?? []).map((binding) => binding.pluginId),
      runtimeEnvironmentId: snapshot.runtimeEnvironmentId,
    });
    const envError = await validateRuntimeEnvironment(
      context.db,
      snapshot.runtimeEnvironmentId ?? null,
    );
    if (envError) return invalid(envError);
    const toolError = unsupportedAllowedTool(snapshot.allowedTools);
    if (toolError) return invalid(toolError);
    const snapshotSubAgentIds = snapshot.subAgentIds as string[] | undefined;
    if (snapshotSubAgentIds !== undefined) {
      if (current.parentId !== null && snapshotSubAgentIds.length > 0) {
        return invalid('a sub-agent cannot have its own sub-agents');
      }
      const subAgentError = await validateSubAgents(context.db, current.id, snapshotSubAgentIds);
      if (subAgentError) return invalid(subAgentError);
      await authorizeSubAgentBindings(context, snapshotSubAgentIds);
    }
    const row = await restoreAgentVersion(
      {
        db: context.db,
        log: context.log,
        actor: principal.businessId,
        requestId: context.requestId,
      },
      current,
      target,
    );
    return canReadConfig
      ? { kind: 'detail' as const, agent: await agentDetail(context.db, row) }
      : { kind: 'summary' as const, agent: toSummary(row) };
  }),
  memory: os.memory.handler(async ({ context, input: routeInput }) => {
    const row = await authorizedAgent(context, routeInput.params.id, 'agents.memory.read');
    return listMemoryFiles(context.config.WORKSPACES_DIR, row.slug);
  }),
  memoryFile: os.memoryFile.handler(async ({ context, input: routeInput }) => {
    const row = await authorizedAgent(context, routeInput.params.id, 'agents.memory.read');
    const file = await readMemoryFile(
      context.config.WORKSPACES_DIR,
      row.slug,
      routeInput.params.name,
    );
    if (!file) return notFound('agent');
    return file;
  }),
  writeMemory: os.writeMemory.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const row = await authorizedAgent(context, routeInput.params.id, 'agents.memory.write');
    const slug = row.slug;
    const target = {
      kind: 'agent_memory',
      agentId: row.id,
      name: routeInput.params.name,
    } as const;
    const file = await withMemoryTargetLock(
      context.client,
      target,
      principal.businessId,
      async () => {
        await writeMemoryTargetLocked(context.db, {
          workspacesDir: context.config.WORKSPACES_DIR,
          businessId: principal.businessId,
          target,
          manualContent: routeInput.body.content,
          logger: context.log,
        });
        const written = await readMemoryFile(
          context.config.WORKSPACES_DIR,
          slug,
          routeInput.params.name,
        );
        if (!written) throw new Error('memory file disappeared after write');
        return written;
      },
    );
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.memory.write',
      target: row.id,
      input: { name: routeInput.params.name },
      status: 'ok',
      requestId: context.requestId,
    });
    return file;
  }),
  deleteMemory: os.deleteMemory.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const row = await authorizedAgent(context, routeInput.params.id, 'agents.memory.write');
    const target = {
      kind: 'agent_memory',
      agentId: row.id,
      name: routeInput.params.name,
    } as const;
    const removed = await withMemoryTargetLock(
      context.client,
      target,
      principal.businessId,
      async () => {
        const current = await readMemoryTarget(
          context.db,
          context.config.WORKSPACES_DIR,
          target,
          principal.businessId,
        );
        if (current.content === null) return false;
        await writeMemoryTargetLocked(context.db, {
          workspacesDir: context.config.WORKSPACES_DIR,
          businessId: principal.businessId,
          target,
          manualContent: null,
          logger: context.log,
        });
        return true;
      },
    );
    if (!removed) return notFound('agent');
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.memory.delete',
      target: row.id,
      input: { name: routeInput.params.name },
      status: 'ok',
      requestId: context.requestId,
    });
    return undefined;
  }),
  rules: os.rules.handler(async ({ context, input: routeInput }) => {
    const row = await authorizedAgent(context, routeInput.params.id, 'agents.rules.read');
    const rows = await allRepo.rules.listRules(context.db, row.id);
    return rows.map((r) => ({
      id: r.id,
      agentId: r.agentId,
      slug: r.slug,
      content: r.content,
      globs: r.globs,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }),
  writeRule: os.writeRule.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const agent = await authorizedAgent(context, routeInput.params.id, 'agents.rules.write');
    const target = {
      kind: 'agent_rule',
      agentId: agent.id,
      slug: routeInput.params.slug,
    } as const;
    const row = await withMemoryTargetLock(
      context.client,
      target,
      principal.businessId,
      async () => {
        await writeMemoryTargetLocked(context.db, {
          workspacesDir: context.config.WORKSPACES_DIR,
          businessId: principal.businessId,
          target,
          after: { content: routeInput.body.content, globs: routeInput.body.globs, index: null },
          logger: context.log,
        });
        const [rule] = await context.db
          .select()
          .from(schema.agentRules)
          .where(
            and(
              eq(schema.agentRules.agentId, agent.id),
              eq(schema.agentRules.slug, routeInput.params.slug),
            ),
          )
          .limit(1);
        if (!rule) throw new Error('rule disappeared after write');
        return rule;
      },
    );
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.rule.written',
      target: agent.id,
      input: { slug: row.slug },
      status: 'ok',
      requestId: context.requestId,
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
  }),
  deleteRule: os.deleteRule.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const agent = await authorizedAgent(context, routeInput.params.id, 'agents.rules.write');
    const target = {
      kind: 'agent_rule',
      agentId: agent.id,
      slug: routeInput.params.slug,
    } as const;
    const removed = await withMemoryTargetLock(
      context.client,
      target,
      principal.businessId,
      async () => {
        const [rule] = await context.db
          .select({ id: schema.agentRules.id })
          .from(schema.agentRules)
          .where(
            and(
              eq(schema.agentRules.agentId, agent.id),
              eq(schema.agentRules.slug, routeInput.params.slug),
            ),
          )
          .limit(1);
        if (!rule) return false;
        await writeMemoryTargetLocked(context.db, {
          workspacesDir: context.config.WORKSPACES_DIR,
          businessId: principal.businessId,
          target,
          after: { content: null, globs: '', index: null },
          logger: context.log,
        });
        return true;
      },
    );
    if (!removed) return notFound('agent');
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.rule.deleted',
      target: agent.id,
      input: { slug: routeInput.params.slug },
      status: 'ok',
      requestId: context.requestId,
    });
    return undefined;
  }),
  outputStyles: os.outputStyles.handler(async ({ context, input: routeInput }) => {
    const row = await authorizedAgent(context, routeInput.params.id, 'agents.styles.read');
    const rows = await allRepo.outputStyles.listOutputStyles(context.db, row.id);
    return rows.map(toOutputStyle);
  }),
  writeOutputStyle: os.writeOutputStyle.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const agent = await authorizedAgent(context, routeInput.params.id, 'agents.styles.write');
    const row = await allRepo.agentVersions.retryOnVersionConflict(() =>
      context.db.transaction(async (tx) => {
        const written = await allRepo.outputStyles.upsertOutputStyle(tx, agent.id, {
          slug: routeInput.params.slug,
          ...routeInput.body,
        });
        await allRepo.agentDefinitions.recordDraftVersionTx(tx, agent.id, null);
        return written;
      }),
    );
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.output_style.written',
      target: agent.id,
      input: { slug: row.slug },
      status: 'ok',
      requestId: context.requestId,
    });
    return toOutputStyle(row);
  }),
  unselectOutputStyle: os.unselectOutputStyle.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const agent = await authorizedAgent(context, routeInput.params.id, 'agents.styles.write');
    const ok = await allRepo.agentVersions.retryOnVersionConflict(() =>
      context.db.transaction(async (tx) => {
        const unselected = await allRepo.outputStyles.unselectOutputStyle(
          tx,
          agent.id,
          routeInput.params.slug,
        );
        if (!unselected) return false;
        await allRepo.agentDefinitions.recordDraftVersionTx(tx, agent.id, null);
        return true;
      }),
    );
    if (!ok) return fail('NOT_FOUND', '该输出风格不存在，可能已被删除');
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.output_style.unselected',
      target: agent.id,
      input: { slug: routeInput.params.slug },
      status: 'ok',
      requestId: context.requestId,
    });
    return undefined;
  }),
  deleteOutputStyle: os.deleteOutputStyle.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const agent = await authorizedAgent(context, routeInput.params.id, 'agents.styles.write');
    const removed = await allRepo.agentVersions.retryOnVersionConflict(() =>
      context.db.transaction(async (tx) => {
        const deleted = await allRepo.outputStyles.deleteOutputStyle(
          tx,
          agent.id,
          routeInput.params.slug,
        );
        if (!deleted) return false;
        await allRepo.agentDefinitions.recordDraftVersionTx(tx, agent.id, null);
        return true;
      }),
    );
    if (!removed) return fail('NOT_FOUND', '该输出风格不存在，可能已被删除');
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.output_style.deleted',
      target: agent.id,
      input: { slug: routeInput.params.slug },
      status: 'ok',
      requestId: context.requestId,
    });
    return undefined;
  }),
  hooks: os.hooks.handler(async ({ context, input: routeInput }) => {
    const agent = await authorizedAgent(context, routeInput.params.id, 'agents.hooks.read');
    const files = await allRepo.hooks.listHookFiles(context.db, agent.id);
    return {
      enabled: agent.hooksEnabled,
      config: agent.hooksConfig,
      files: files.map(toHookFile),
    };
  }),
  writeHooksSettings: os.writeHooksSettings.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const agent = await authorizedAgent(context, routeInput.params.id, 'agents.hooks.write');
    const updated = await allRepo.agentVersions.retryOnVersionConflict(() =>
      context.db.transaction(async (tx) => {
        const ok = await allRepo.hooks.updateHooksSettings(tx, agent.id, {
          enabled: routeInput.body.enabled,
          config: routeInput.body.config,
        });
        if (!ok) return false;
        await allRepo.agentDefinitions.recordDraftVersionTx(tx, agent.id, null);
        return true;
      }),
    );
    if (!updated) return notFound('agent');
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.hooks.settings.updated',
      target: agent.id,
      input: { enabled: routeInput.body.enabled },
      status: 'ok',
      requestId: context.requestId,
    });
    const files = await allRepo.hooks.listHookFiles(context.db, agent.id);
    return {
      enabled: routeInput.body.enabled,
      config: routeInput.body.config,
      files: files.map(toHookFile),
    };
  }),
  writeHookFile: os.writeHookFile.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const agent = await authorizedAgent(context, routeInput.params.id, 'agents.hooks.write');
    const existing = await allRepo.hooks.listHookFiles(context.db, agent.id);
    if (
      existing.length >= AGENT_HOOK_FILE_LIMIT &&
      !existing.some((file) => file.path === routeInput.body.path)
    ) {
      fail('INVALID_INPUT', `hook 脚本最多 ${AGENT_HOOK_FILE_LIMIT} 个，请先删除不用的脚本`);
    }
    const row = await allRepo.agentVersions.retryOnVersionConflict(() =>
      context.db.transaction(async (tx) => {
        const written = await allRepo.hooks.upsertHookFile(tx, agent.id, routeInput.body);
        await allRepo.agentDefinitions.recordDraftVersionTx(tx, agent.id, null);
        return written;
      }),
    );
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.hook.file.updated',
      target: agent.id,
      input: { path: row.path },
      status: 'ok',
      requestId: context.requestId,
    });
    return toHookFile(row);
  }),
  deleteHookFile: os.deleteHookFile.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const agent = await authorizedAgent(context, routeInput.params.id, 'agents.hooks.write');
    const removed = await allRepo.agentVersions.retryOnVersionConflict(() =>
      context.db.transaction(async (tx) => {
        const deleted = await allRepo.hooks.deleteHookFile(tx, agent.id, routeInput.query.path);
        if (!deleted) return false;
        await allRepo.agentDefinitions.recordDraftVersionTx(tx, agent.id, null);
        return true;
      }),
    );
    if (!removed) {
      fail('NOT_FOUND', 'hook 脚本不存在，可能已被删除；请刷新后重试');
    }
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.hook.file.deleted',
      target: agent.id,
      input: { path: routeInput.query.path },
      status: 'ok',
      requestId: context.requestId,
    });
    return undefined;
  }),
  members: os.members.handler(async ({ context, input: routeInput }) => {
    const row = await authorizedAgent(context, routeInput.params.id, 'agents.members.manage');
    const members = await allRepo.access.listAgentMembers(context.db, row.id);
    return { ownerBusinessId: row.ownerBusinessId, members };
  }),
  setMember: os.setMember.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const row = await authorizedAgent(context, routeInput.params.id, 'agents.members.manage');
    if (!(await allRepo.accounts.hasBusinessHistory(context.db, routeInput.params.businessId))) {
      return invalid('该业务 ID 尚未登记为人员，无法授权；请先在账户中添加该人员');
    }
    const member = await allRepo.access.setAgentMember(context.db, row.id, {
      businessId: routeInput.params.businessId,
      canUse: routeInput.body.canUse,
      canMaintain: routeInput.body.canMaintain,
    });
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.member.updated',
      target: row.id,
      input: routeInput.params.businessId,
      status: 'ok',
      requestId: context.requestId,
    });
    return member;
  }),
  deleteMember: os.deleteMember.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const row = await authorizedAgent(context, routeInput.params.id, 'agents.members.manage');
    if (routeInput.params.businessId === row.ownerBusinessId) {
      return invalid('负责人不是可删除的成员行；需要变更负责人请使用转交');
    }
    const removed = await allRepo.access.deleteAgentMember(
      context.db,
      row.id,
      routeInput.params.businessId,
    );
    if (!removed) return fail('NOT_FOUND', '该成员不存在，可能已被移除');
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.member.deleted',
      target: row.id,
      input: routeInput.params.businessId,
      status: 'ok',
      requestId: context.requestId,
    });
    return undefined;
  }),
  transfer: os.transfer.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const row = await authorizedAgent(context, routeInput.params.id, 'agents.transfer');
    return transferAgent(
      {
        db: context.db,
        log: context.log,
        actor: principal.businessId,
        requestId: context.requestId,
      },
      row,
      routeInput.body.ownerBusinessId,
    );
  }),
  identities: os.identities.handler(async ({ context, input: routeInput }) => {
    const row = await repo.getAgent(context.db, routeInput.query.agentId);
    if (!row) return notFound('agent');
    await authorizeAgent(context, row, 'agents.members.manage');
    return allRepo.accounts.listIdentities(context.db, {
      limit: routeInput.query.limit,
      offset: routeInput.query.offset,
      ...(routeInput.query.q === undefined ? {} : { q: routeInput.query.q }),
    });
  }),
});
