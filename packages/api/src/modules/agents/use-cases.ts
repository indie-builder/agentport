import { fail, notFound } from '@agentport/core';
import { repo as allRepo, type Database } from '@agentport/db';
import type { Agent, AgentDefinition, AgentInput } from '@agentport/shared';
import {
  AGENT_ROLES,
  maskUrlCredentials,
  SUB_AGENT_DUPLICATE_MESSAGE,
  SUB_AGENT_MISSING_MESSAGE,
  SUB_AGENT_SELF_MESSAGE,
} from '@agentport/shared';
import type { Logger } from 'pino';
import { authorizeResourceAccess } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { rethrowConflict } from '../../http/errors.js';
import { importAgentPackage, type parseAgentPackage } from './package.js';
import { toAgentConfigValues } from './write.js';

const repo = allRepo.agents;

const BINDING_RESOURCES = {
  server: { permissionId: 'servers.read', message: '连接器不存在，可能已被删除；请刷新后重新选择' },
  skill: { permissionId: 'skills.read', message: '技能不存在，可能已被删除；请刷新后重新选择' },
  plugin: { permissionId: 'plugins.read', message: '插件不存在，可能已被删除；请刷新后重新选择' },
  runtime_environment: {
    permissionId: 'runtime_environments.read',
    message: '运行环境不存在，可能已被删除；请刷新后重新选择',
  },
} as const;

export async function authorizeBoundResources(
  context: RequestContext,
  bindings: {
    serverIds?: readonly string[] | undefined;
    skillIds?: readonly string[] | undefined;
    pluginIds?: readonly string[] | undefined;
    runtimeEnvironmentId?: string | null | undefined;
  },
): Promise<void> {
  const resources = [
    ['server', bindings.serverIds ?? []],
    ['skill', bindings.skillIds ?? []],
    ['plugin', bindings.pluginIds ?? []],
    [
      'runtime_environment',
      bindings.runtimeEnvironmentId === undefined || bindings.runtimeEnvironmentId === null
        ? []
        : [bindings.runtimeEnvironmentId],
    ],
  ] as const;
  for (const [kind, ids] of resources) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) continue;
    const { permissionId, message } = BINDING_RESOURCES[kind];
    const rows = await repo.getResourceOwners(context.db, kind, unique);
    if (rows.length !== unique.length) {
      fail(kind === 'runtime_environment' ? 'INVALID_INPUT' : 'INVALID_REFERENCE', message);
    }
    for (const row of rows) {
      await authorizeResourceAccess(
        context,
        permissionId,
        { kind, resourceId: row.id, ownerBusinessId: row.ownerBusinessId, level: 'read' },
        message,
      );
    }
    if (kind === 'skill') {
      const published = await repo.getPublishedSkillIds(context.db, unique);
      if (published.size !== unique.length) {
        fail('INVALID_INPUT', '技能不可用或未发布，请刷新后重新选择');
      }
    }
  }
}

export const agentSlugConflictMessage = '该 slug 已被其他智能体占用，请换一个';
export const agentReferenceConflict = {
  code: 'INVALID_REFERENCE',
  message: '引用的 MCP Server、技能或插件不存在，请刷新后重新选择',
} as const;
export function toWrite(
  input: Omit<AgentInput, 'serverIds' | 'skillIds' | 'subAgentIds' | 'pluginBindings'>,
  ownerBusinessId: string,
): allRepo.agents.AgentWrite {
  return {
    slug: input.slug,
    ...toAgentConfigValues(input),
    createdBy: ownerBusinessId,
    ownerBusinessId,
  };
}
export async function validateSubAgents(
  db: Database,
  selfId: string | null,
  subAgentIds: string[],
): Promise<string | undefined> {
  if (new Set(subAgentIds).size !== subAgentIds.length) {
    return SUB_AGENT_DUPLICATE_MESSAGE;
  }
  if (selfId !== null && subAgentIds.includes(selfId)) return SUB_AGENT_SELF_MESSAGE;
  const rows = await repo.getAgentsByIds(db, subAgentIds);
  if (rows.length !== subAgentIds.length) return SUB_AGENT_MISSING_MESSAGE;
  for (const row of rows) {
    if (row.parentId !== null && row.parentId !== selfId) {
      return `「${row.name}」已经是其他智能体的子智能体；只支持一层委派`;
    }
  }
  const nested = await repo.listAgentSubAgentIds(
    db,
    rows.map((row) => row.id),
  );
  for (const row of rows) {
    if ((nested.get(row.id) ?? []).length > 0) {
      return `「${row.name}」自己还有子智能体；只支持一层委派，请先解除它的子智能体`;
    }
  }
  const bindings = await allRepo.plugins.listAgentPluginBindingInputs(
    db,
    rows.map((row) => row.id),
  );
  for (const row of rows) {
    if ((bindings.get(row.id) ?? []).length > 0) {
      return `「${row.name}」绑定了插件；插件只在会话级加载，请先解除它的插件绑定`;
    }
  }
  const workflowAgentIds = await allRepo.workflows.listAgentIdsWithWorkflows(
    db,
    rows.map((row) => row.id),
  );
  for (const row of rows) {
    if (workflowAgentIds.has(row.id)) {
      return `「${row.name}」已有工作流；工作流是 project 级能力，请先删除它的工作流再设为子智能体`;
    }
  }
  return undefined;
}
export async function validateRuntimeEnvironment(
  db: Database,
  id: string | null,
): Promise<string | undefined> {
  if (id === null) return undefined;
  const env = await allRepo.runtimeEnvironments.getRuntimeEnvironment(db, id);
  if (!env) return '选中的运行环境不存在，可能已被删除；请刷新后重新选择';
  if ((await allRepo.runtimeEnvironments.resolveOnlineRuntimeEnvironment(db, id)) === null) {
    return `「${env.name}」还没有可用的线上版本；请先完成构建并发布后再绑定`;
  }
  return undefined;
}
type AgentWriteDependencies = {
  db: Database;
  log: Logger;
  actor: string;
  requestId: string;
};
export async function createAgent(deps: AgentWriteDependencies, input: AgentInput) {
  const { serverIds, skillIds, subAgentIds, pluginBindings, ...rest } = input;
  try {
    const row = await repo.createAgent(
      deps.db,
      toWrite(rest, deps.actor),
      serverIds,
      skillIds,
      subAgentIds,
      pluginBindings,
    );
    await allRepo.audit.writeAudit(deps.db, deps.log, {
      actor: deps.actor,
      action: 'agent.created',
      target: row.id,
      input,
      status: 'ok',
      requestId: deps.requestId,
    });
    return repo.toAgent(row, serverIds, skillIds, subAgentIds, pluginBindings);
  } catch (error) {
    rethrowConflict(error, agentSlugConflictMessage, agentReferenceConflict);
  }
}
export async function agentDetail(db: Database, row: allRepo.agents.AgentRow): Promise<Agent> {
  const [serverIds, skillIds, subAgentIds, pluginBindings, latest] = await Promise.all([
    repo.getAgentServerIds(db, row.id),
    repo.getAgentSkillIds(db, row.id),
    repo.getAgentSubAgentIds(db, row.id),
    allRepo.plugins.listAgentPluginBindingInputs(db, [row.id]),
    allRepo.agentVersions.latestAgentVersion(db, row.id),
  ]);
  return {
    ...repo.toAgent(row, serverIds, skillIds, subAgentIds, pluginBindings.get(row.id) ?? []),
    hasDraft: latest !== null && (row.publishedVersion === null || latest > row.publishedVersion),
  };
}
export function toVersionDefinition(definition: AgentDefinition): AgentDefinition {
  const mask = (value: unknown) => (typeof value === 'string' ? maskUrlCredentials(value) : '');
  return {
    ...definition,
    resources: {
      ...definition.resources,
      servers: definition.resources.servers.map((server) => {
        const { secretsEncrypted: _secretsEncrypted, config, ...rest } = server;
        const publicConfig =
          server.kind === 'stdio'
            ? { command: config.command ?? '', args: config.args ?? [] }
            : server.kind === 'http'
              ? { url: mask(config.url) }
              : server.kind === 'generated'
                ? { baseUrl: mask(config.baseUrl) }
                : server.kind === 'knowledge'
                  ? { knowledgeBaseId: config.knowledgeBaseId ?? '' }
                  : server.kind === 'data_domain'
                    ? { dataDomainId: config.dataDomainId ?? '' }
                    : {};
        return { ...rest, config: publicConfig };
      }),
    },
  };
}
function snapshotToWrite(
  snapshot: Agent,
  current: allRepo.agents.AgentRow,
): Partial<allRepo.agents.AgentWrite> {
  return {
    slug: current.slug,
    ...toAgentConfigValues({
      ...snapshot,
      role: AGENT_ROLES.some((role) => role === snapshot.role) ? snapshot.role : current.role,
      uiFormat: snapshot.uiFormat ?? 'markdown',
      runtimeEnvironmentId: snapshot.runtimeEnvironmentId ?? null,
      monthlyBudgetUsd:
        'monthlyBudgetUsd' in snapshot
          ? snapshot.monthlyBudgetUsd
          : current.monthlyBudgetUsd === null
            ? null
            : Number(current.monthlyBudgetUsd),
      budgetAlertRatio:
        'budgetAlertRatio' in snapshot
          ? snapshot.budgetAlertRatio
          : Number(current.budgetAlertRatio),
    }),
  };
}
export async function importAgent(
  deps: AgentWriteDependencies,
  parsed: ReturnType<typeof parseAgentPackage>,
  options: Parameters<typeof importAgentPackage>[2],
  authorization?: Parameters<typeof importAgentPackage>[3],
) {
  const result = await importAgentPackage(deps.db, parsed, options, authorization);
  await allRepo.audit.writeAudit(deps.db, deps.log, {
    actor: deps.actor,
    action: 'agent.imported',
    target: result.agent.id,
    input: {
      slug: result.agent.slug,
      servers: { created: result.createdServers.length, reused: result.reusedServers.length },
      skills: result.createdSkills.length,
      files: result.counts.files,
      workflows: result.counts.workflows,
      rules: result.counts.rules,
      outputStyles: result.counts.outputStyles,
      hookFiles: result.counts.hookFiles,
      subAgents: result.createdSubAgents.length,
    },
    status: 'ok',
    requestId: deps.requestId,
  });
  const { counts: _counts, ...response } = result;
  return response;
}
export async function transferAgent(
  deps: AgentWriteDependencies,
  row: allRepo.agents.AgentRow,
  ownerBusinessId: string,
) {
  const target = await allRepo.accounts.getIdentity(deps.db, ownerBusinessId);
  if (!target?.accountActive) {
    return fail('INVALID_INPUT', '新负责人必须是已登记且未停用的账户');
  }
  const targetAccess = await allRepo.access.getUserAccess(deps.db, ownerBusinessId);
  const canCreate = targetAccess.grants.some(
    (grant) =>
      grant.permissionId === 'agents.create' &&
      (grant.scope === 'own_data' || grant.scope === 'platform'),
  );
  if (!canCreate) {
    return fail('INVALID_INPUT', '新负责人需要具备「创建专家」权限');
  }
  const transferred = await allRepo.access.transferAgent(deps.db, row.id, ownerBusinessId);
  if (!transferred) return notFound('agent');
  await allRepo.audit.writeAudit(deps.db, deps.log, {
    actor: deps.actor,
    action: 'agent.transferred',
    target: row.id,
    input: ownerBusinessId,
    status: 'ok',
    requestId: deps.requestId,
  });
  const updated = await repo.getAgent(deps.db, row.id);
  if (!updated) return notFound('agent');
  return agentDetail(deps.db, updated);
}
export async function restoreAgentVersion(
  deps: AgentWriteDependencies,
  current: allRepo.agents.AgentRow,
  target: {
    version: number;
    snapshot: Agent;
  },
) {
  const snapshot = target.snapshot;
  try {
    const row = await allRepo.agentVersions.retryOnVersionConflict(() =>
      deps.db.transaction(async (tx) => {
        const updated = await allRepo.agents.updateAgentTx(
          tx,
          current.id,
          { ...snapshotToWrite(snapshot, current), enabled: true },
          snapshot.serverIds,
          snapshot.skillIds,
          `rollback to v${target.version}`,
          snapshot.subAgentIds,
          undefined,
          (
            snapshot as {
              pluginBindings?: Agent['pluginBindings'];
            }
          ).pluginBindings,
        );
        if (!updated) return null;
        return allRepo.agentDefinitions.markLatestPublishedTx(tx, current.id);
      }),
    );
    if (!row) return notFound('agent');
    await allRepo.audit.writeAudit(deps.db, deps.log, {
      actor: deps.actor,
      action: 'agent.rolled_back',
      target: row.id,
      input: { version: target.version },
      status: 'ok',
      requestId: deps.requestId,
    });
    return row;
  } catch (err) {
    rethrowConflict(err, agentSlugConflictMessage, agentReferenceConflict);
  }
}
