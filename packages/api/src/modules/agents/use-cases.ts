import { fail } from '@agentport/core';
import { repo as allRepo, type Database } from '@agentport/db';
import type { Agent, AgentInput } from '@agentport/shared';
import { AGENT_ROLES } from '@agentport/shared';
import type { Logger } from 'pino';
import { isPgCode } from '../../http/errors.js';
import { importAgentPackage, type parseAgentPackage } from './package.js';
import { toAgentConfigValues } from './write.js';

const repo = allRepo.agents;

export function rethrowConflict(err: unknown): never {
  if (isPgCode(err, '23505')) fail('CONFLICT', '该 slug 已被其他智能体占用，请换一个');
  if (isPgCode(err, '23503'))
    fail('INVALID_REFERENCE', '引用的 MCP Server、技能或插件不存在，请刷新后重新选择');
  throw err;
}
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
    return '同一个智能体被重复选为子智能体，请去掉重复项';
  }
  if (selfId !== null && subAgentIds.includes(selfId)) return '智能体不能把自己设为子智能体';
  const rows = await repo.getAgentsByIds(db, subAgentIds);
  if (rows.length !== subAgentIds.length) return '选中的子智能体已被删除，请刷新后重新选择';
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
    rethrowConflict(error);
  }
}
export async function agentDetail(db: Database, row: allRepo.agents.AgentRow): Promise<Agent> {
  const [serverIds, skillIds, subAgentIds, pluginBindings] = await Promise.all([
    repo.getAgentServerIds(db, row.id),
    repo.getAgentSkillIds(db, row.id),
    repo.getAgentSubAgentIds(db, row.id),
    allRepo.plugins.listAgentPluginBindingInputs(db, [row.id]),
  ]);
  return repo.toAgent(row, serverIds, skillIds, subAgentIds, pluginBindings.get(row.id) ?? []);
}
function snapshotToWrite(
  snapshot: Agent,
  slug: string,
  currentRole: string,
): Partial<allRepo.agents.AgentWrite> {
  return {
    slug,
    ...toAgentConfigValues({
      ...snapshot,
      role: AGENT_ROLES.some((role) => role === snapshot.role) ? snapshot.role : currentRole,
      uiFormat: snapshot.uiFormat ?? 'markdown',
      runtimeEnvironmentId: snapshot.runtimeEnvironmentId ?? null,
    }),
  };
}
export async function importAgent(
  deps: AgentWriteDependencies,
  parsed: ReturnType<typeof parseAgentPackage>,
  options: Parameters<typeof importAgentPackage>[2],
) {
  const result = await importAgentPackage(deps.db, parsed, options);
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
  if (!transferred)
    return fail('AGENT_NOT_FOUND', '智能体不存在，可能已被删除；请返回列表刷新后重试');
  await allRepo.audit.writeAudit(deps.db, deps.log, {
    actor: deps.actor,
    action: 'agent.transferred',
    target: row.id,
    input: ownerBusinessId,
    status: 'ok',
    requestId: deps.requestId,
  });
  const updated = await repo.getAgent(deps.db, row.id);
  if (!updated) return fail('AGENT_NOT_FOUND', '智能体不存在，可能已被删除；请返回列表刷新后重试');
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
    const row = await repo.updateAgent(
      deps.db,
      current.id,
      snapshotToWrite(snapshot, current.slug, current.role),
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
    if (!row) return fail('AGENT_NOT_FOUND', '智能体不存在，可能已被删除；请返回列表刷新后重试');
    await allRepo.audit.writeAudit(deps.db, deps.log, {
      actor: deps.actor,
      action: 'agent.rolled_back',
      target: row.id,
      input: { version: target.version },
      status: 'ok',
      requestId: deps.requestId,
    });
    const restoredPlugins = await allRepo.plugins.listAgentPluginBindingInputs(deps.db, [
      current.id,
    ]);
    return repo.toAgent(
      row,
      snapshot.serverIds,
      snapshot.skillIds,
      snapshot.subAgentIds ?? [],
      restoredPlugins.get(current.id) ?? [],
    );
  } catch (err) {
    rethrowConflict(err);
  }
}
