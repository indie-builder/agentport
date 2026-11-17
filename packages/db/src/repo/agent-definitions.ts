import { isDeepStrictEqual } from 'node:util';
import { AppError } from '@agentport/core';
import type { AgentDefinition } from '@agentport/shared';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { DbHandle, Transaction } from '../client.js';
import {
  agentHookFiles,
  agentOutputStyles,
  agentPlugins,
  agentRules,
  agentServers,
  agentSkills,
  agents,
  agentWorkflows,
} from '../schema.js';
import {
  getAgentVersion,
  insertAgentVersion,
  latestAgentVersion,
  retryOnVersionConflict,
} from './agent-versions.js';
import {
  type AgentRow,
  assertAgentsIdle,
  getAgentSubAgentIds,
  loadLiveDefinition,
  lockSubAgentBindings,
} from './agents.js';
import { lockAgentBindings } from './locks.js';

export { loadLiveDefinition } from './agents.js';

export async function assertDefinitionResources(
  db: DbHandle | Transaction,
  definition: AgentDefinition,
): Promise<void> {
  if (definition.agent.parentId !== null || definition.resources.subAgents.length === 0) return;
  const children = await Promise.all(
    definition.resources.subAgents.map(async ({ id, name, publishedVersion }) => {
      if (publishedVersion === null) {
        throw new AppError(
          'INVALID_INPUT',
          `子智能体「${name}」尚未发布，无法固定版本；请先发布子智能体`,
        );
      }
      const version = await getAgentVersion(db, id, publishedVersion);
      if (!version) {
        throw new AppError(
          'INVALID_INPUT',
          `子智能体「${name}」的发布版本不存在；请重新发布子智能体`,
        );
      }
      return version.definition;
    }),
  );
  const resources = [definition, ...children.filter((child) => child !== null)].map(
    (item) => item.resources,
  );
  const servers = new Map<string, AgentDefinition['resources']['servers'][number]>();
  const serverNames = new Map<string, string>();
  resources
    .flatMap((item) => item.servers)
    .forEach((server) => {
      const snapshot = ({ name, kind, config, secretsEncrypted, tools }: typeof server) => ({
        name,
        kind,
        config,
        secretsEncrypted,
        tools: [...(tools ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
      });
      const nameOwner = serverNames.get(server.name);
      if (nameOwner !== undefined && nameOwner !== server.id) {
        throw new AppError(
          'INVALID_INPUT',
          `父子专家共享的 MCP Server 名称「${server.name}」对应不同资源；请重新命名或重新发布相关专家后再发布`,
        );
      }
      serverNames.set(server.name, server.id);
      const previous = servers.get(server.id);
      if (previous && !isDeepStrictEqual(snapshot(previous), snapshot(server))) {
        throw new AppError(
          'INVALID_INPUT',
          `父子专家共享的 MCP Server「${server.name}」快照内容不一致；请重新发布相关专家后再发布`,
        );
      }
      servers.set(server.id, server);
    });
  const skills = new Map<string, AgentDefinition['resources']['skills'][number]>();
  resources
    .flatMap((item) => item.skills)
    .forEach((skill) => {
      const snapshot = ({
        name,
        description,
        body,
        license,
        compatibility,
        metadata,
        files,
      }: typeof skill) => ({
        name,
        description,
        body,
        license,
        compatibility,
        metadata,
        files: files
          .map(({ path, content }) => ({ path, content }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      });
      const previous = skills.get(skill.slug);
      if (previous && !isDeepStrictEqual(snapshot(previous), snapshot(skill))) {
        throw new AppError(
          'INVALID_INPUT',
          `父子专家共享的技能「${skill.slug}」内容不一致；请重新发布相关专家后再发布`,
        );
      }
      skills.set(skill.slug, skill);
    });
}

export async function recordDraftVersionTx(
  tx: Transaction,
  agentId: string,
  note: string | null = null,
): Promise<number | null> {
  const definition = await loadLiveDefinition(tx, agentId);
  if (!definition) return null;
  return insertAgentVersion(tx, agentId, definition.agent, definition, note);
}

export async function publishCurrent(
  db: DbHandle,
  agentId: string,
  note: string | null = null,
): Promise<AgentRow | null> {
  return retryOnVersionConflict(() =>
    db.transaction(async (tx) => {
      await lockAgentBindings(tx);
      const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId)).for('update');
      if (!agent) return null;
      if (agent.enabled === false) {
        await assertAgentsIdle(tx, agent.parentId === null ? [agent.id] : [agent.id, agent.parentId]);
      }
      const definition = await loadLiveDefinition(tx, agentId);
      if (!definition) return null;
      await assertDefinitionResources(tx, definition);
      const version = await insertAgentVersion(
        tx,
        agentId,
        definition.agent,
        definition,
        note ?? '发布',
      );
      const now = new Date();
      const [row] = await tx
        .update(agents)
        .set({ publishedVersion: version, publishedAt: now, enabled: true, updatedAt: now })
        .where(eq(agents.id, agentId))
        .returning();
      return row ?? null;
    }),
  );
}

export async function publishDefinition(
  db: DbHandle,
  agentId: string,
  definition: AgentDefinition,
  note: string,
): Promise<AgentRow | null> {
  return retryOnVersionConflict(() =>
    db.transaction(async (tx) => {
      await lockAgentBindings(tx);
      const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId)).for('update');
      if (!agent) return null;
      if (agent.enabled === false) {
        await assertAgentsIdle(tx, agent.parentId === null ? [agent.id] : [agent.id, agent.parentId]);
      }
      await applyDefinition(tx, agent, definition);
      const fresh = await loadLiveDefinition(tx, agentId);
      if (!fresh) return null;
      fresh.resources = definition.resources;
      await assertDefinitionResources(tx, fresh);
      const version = await insertAgentVersion(tx, agentId, fresh.agent, fresh, note);
      const now = new Date();
      const [row] = await tx
        .update(agents)
        .set({ publishedVersion: version, publishedAt: now, enabled: true, updatedAt: now })
        .where(eq(agents.id, agentId))
        .returning();
      return row ?? null;
    }),
  );
}

export async function markLatestPublishedTx(
  tx: Transaction,
  agentId: string,
): Promise<AgentRow | null> {
  const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId)).for('update');
  if (!agent) return null;
  const version = await latestAgentVersion(tx, agentId);
  const now = new Date();
  const [row] = await tx
    .update(agents)
    .set({ publishedVersion: version, publishedAt: now, enabled: true, updatedAt: now })
    .where(eq(agents.id, agentId))
    .returning();
  return row ?? null;
}

export async function markLatestPublished(db: DbHandle, agentId: string): Promise<AgentRow | null> {
  return db.transaction((tx) => markLatestPublishedTx(tx, agentId));
}

export async function setAgentEnabled(
  db: DbHandle,
  agentId: string,
  enabled: boolean,
): Promise<AgentRow | null> {
  return db.transaction(async (tx) => {
    await lockAgentBindings(tx);
    const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId)).for('update');
    if (!agent) return null;
    if (agent.enabled !== enabled) {
      await assertAgentsIdle(tx, agent.parentId === null ? [agent.id] : [agent.id, agent.parentId]);
    }
    const [row] = await tx
      .update(agents)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(agents.id, agentId))
      .returning();
    return row ?? null;
  });
}

async function applyDefinition(
  tx: Transaction,
  current: AgentRow,
  definition: AgentDefinition,
): Promise<void> {
  const { agent } = definition;
  const agentId = current.id;
  if (current.parentId === null) {
    await lockSubAgentBindings(tx, agentId, agent.subAgentIds);
    const currentChildren = await getAgentSubAgentIds(tx, agentId);
    const nextChildren = new Set(agent.subAgentIds);
    if (
      currentChildren.length !== nextChildren.size ||
      currentChildren.some((id) => !nextChildren.has(id))
    ) {
      await assertAgentsIdle(tx, [agentId, ...currentChildren, ...agent.subAgentIds]);
    }
    await tx.update(agents).set({ parentId: null }).where(eq(agents.parentId, agentId));
    if (agent.subAgentIds.length > 0) {
      const claimed = await tx
        .update(agents)
        .set({ parentId: agentId })
        .where(
          and(
            inArray(agents.id, agent.subAgentIds),
            isNull(agents.parentId),
            ne(agents.id, agentId),
          ),
        )
        .returning({ id: agents.id });
      if (claimed.length !== agent.subAgentIds.length) {
        throw new AppError('INVALID_INPUT', '选中的子智能体已被删除或已绑定，请刷新后重新选择');
      }
    }
  } else {
    await assertAgentsIdle(tx, [agentId, current.parentId]);
    if (agent.pluginBindings.length > 0 || definition.workflows.length > 0) {
      throw new AppError('INVALID_INPUT', '子智能体不能绑定插件或工作流');
    }
  }
  await tx
    .update(agents)
    .set({
      name: agent.name,
      role: agent.role,
      description: agent.description,
      model: agent.model,
      systemPromptMd: agent.systemPrompt,
      allowedTools: agent.allowedTools,
      disallowedTools: agent.disallowedTools,
      permissionMode: agent.permissionMode,
      uiFormat: agent.uiFormat,
      effort: agent.effort ?? null,
      maxTurns: agent.maxTurns,
      maxBudgetUsd: String(agent.maxBudgetUsd),
      monthlyBudgetUsd: agent.monthlyBudgetUsd === null ? null : String(agent.monthlyBudgetUsd),
      budgetAlertRatio: String(agent.budgetAlertRatio),
      timeoutMs: agent.timeoutMs,
      runtimeEnvironmentId: agent.runtimeEnvironmentId,
      memoryPolicy: definition.memoryPolicy,
      hooksEnabled: definition.hooks.enabled,
      hooksConfig: definition.hooks.config,
    })
    .where(eq(agents.id, agentId));
  await tx.delete(agentServers).where(eq(agentServers.agentId, agentId));
  if (agent.serverIds.length > 0) {
    await tx
      .insert(agentServers)
      .values(agent.serverIds.map((serverId) => ({ agentId, serverId })));
  }
  await tx.delete(agentSkills).where(eq(agentSkills.agentId, agentId));
  if (agent.skillIds.length > 0) {
    await tx.insert(agentSkills).values(agent.skillIds.map((skillId) => ({ agentId, skillId })));
  }
  await tx.delete(agentPlugins).where(eq(agentPlugins.agentId, agentId));
  if (agent.pluginBindings.length > 0) {
    await tx
      .insert(agentPlugins)
      .values(agent.pluginBindings.map((binding) => ({ agentId, ...binding })));
  }
  await tx.delete(agentRules).where(eq(agentRules.agentId, agentId));
  if (definition.rules.length > 0) {
    await tx.insert(agentRules).values(
      definition.rules.map((item) => ({
        ...item,
        agentId,
        createdAt: new Date(item.createdAt),
        updatedAt: new Date(item.updatedAt),
      })),
    );
  }
  await tx.delete(agentOutputStyles).where(eq(agentOutputStyles.agentId, agentId));
  if (definition.outputStyles.length > 0) {
    await tx.insert(agentOutputStyles).values(
      definition.outputStyles.map((item) => ({
        ...item,
        agentId,
        createdAt: new Date(item.createdAt),
        updatedAt: new Date(item.updatedAt),
      })),
    );
  }
  await tx.delete(agentWorkflows).where(eq(agentWorkflows.agentId, agentId));
  if (definition.workflows.length > 0) {
    await tx.insert(agentWorkflows).values(
      definition.workflows.map((item) => ({
        ...item,
        agentId,
        createdAt: new Date(item.createdAt),
        updatedAt: new Date(item.updatedAt),
      })),
    );
  }
  await tx.delete(agentHookFiles).where(eq(agentHookFiles.agentId, agentId));
  if (definition.hooks.files.length > 0) {
    await tx.insert(agentHookFiles).values(
      definition.hooks.files.map((item) => ({
        ...item,
        agentId,
        createdAt: new Date(item.createdAt),
        updatedAt: new Date(item.updatedAt),
      })),
    );
  }
}
