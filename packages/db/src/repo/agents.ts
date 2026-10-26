import { AppError } from '@agentport/core';
import type { Agent, AgentDuplicateInput, AgentInput } from '@agentport/shared';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import {
  agentOutputStyles,
  agentPlugins,
  agentRules,
  agentServers,
  agentSkills,
  agents,
  servers,
  skills,
} from '../schema.js';
import { insertAgentVersion, retryOnVersionConflict, type Tx } from './agent-versions.js';
import { notStale } from './freshness.js';

export type AgentRow = typeof agents.$inferSelect;

export interface AgentWrite {
  slug: string;
  name: string;
  role: string;
  description: string;
  model: string;
  systemPromptMd: string;
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: string;
  uiFormat: string;
  effort: string | null;
  maxThinkingTokens: number | null;
  enabled: boolean;
  maxTurns: number;
  /** numeric 列以字符串写入，避免浮点误差。 */
  maxBudgetUsd: string;
  timeoutMs: number;
  parentId?: string | null;
}

/** DB 行 → 共享 Agent；所有字段映射只在这里做一次。 */
export function toAgent(
  row: AgentRow,
  serverIds: string[],
  skillIds: string[],
  subAgentIds: string[] = [],
  pluginBindings: Agent['pluginBindings'] = [],
): Agent {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    role: row.role,
    description: row.description,
    model: row.model,
    systemPrompt: row.systemPromptMd,
    serverIds,
    skillIds,
    pluginBindings,
    subAgentIds,
    parentId: row.parentId,
    allowedTools: row.allowedTools,
    disallowedTools: row.disallowedTools,
    permissionMode: row.permissionMode as AgentInput['permissionMode'],
    uiFormat: row.uiFormat as AgentInput['uiFormat'],
    maxTurns: row.maxTurns,
    maxBudgetUsd: Number(row.maxBudgetUsd),
    timeoutMs: row.timeoutMs,
    ...(row.effort === null ? {} : { effort: row.effort as NonNullable<AgentInput['effort']> }),
    ...(row.maxThinkingTokens === null ? {} : { maxThinkingTokens: row.maxThinkingTokens }),
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listAgents(db: Database): Promise<AgentRow[]> {
  return db.select().from(agents).orderBy(asc(agents.createdAt), asc(agents.id));
}

export async function getAgent(db: Database | Tx, id: string): Promise<AgentRow | null> {
  const [row] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  return row ?? null;
}

/**
 * 委派与插件绑定共用的锁。凡是会拿 agent 行锁的写事务，都必须在第一次拿行锁之前
 * 调它：两个方向交叉持锁（先行锁后 advisory / 先 advisory 后行锁）会真死锁。
 * 同事务内重复获取 PG 可重入，不会自阻塞。
 */
async function lockAgentBindings(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('agentport.subagent-bindings'))`);
}

/**
 * 绑定变更串行化：路由里的预检是快路径，并发下两个请求可能都通过，
 * 所以写事务再拿同一把 advisory 锁并复查。只保护绑定，不阻塞普通字段更新。
 * 调用方若会顺带拿行锁，必须先调 lockAgentBindings。
 */
async function lockSubAgentBindings(
  tx: Tx,
  selfId: string | null,
  subAgentIds: string[],
): Promise<void> {
  await lockAgentBindings(tx);
  if (new Set(subAgentIds).size !== subAgentIds.length) {
    throw new AppError('INVALID_INPUT', '同一个智能体被重复选为子智能体，请去掉重复项');
  }
  if (selfId !== null && subAgentIds.includes(selfId)) {
    throw new AppError('INVALID_INPUT', '智能体不能把自己设为子智能体');
  }
  if (selfId !== null) {
    const self = await getAgent(tx, selfId);
    if (self?.parentId != null && subAgentIds.length > 0) {
      throw new AppError('INVALID_INPUT', 'a sub-agent cannot have its own sub-agents');
    }
  }
  if (subAgentIds.length === 0) return;
  const rows = await tx
    .select({ id: agents.id, name: agents.name, parentId: agents.parentId })
    .from(agents)
    .where(inArray(agents.id, subAgentIds));
  if (rows.length !== subAgentIds.length) {
    throw new AppError('INVALID_INPUT', '选中的子智能体已被删除，请刷新后重新选择');
  }
  for (const row of rows) {
    if (row.parentId !== null && row.parentId !== selfId) {
      throw new AppError(
        'INVALID_INPUT',
        `「${row.name}」已经是其他智能体的子智能体；只支持一层委派`,
      );
    }
  }
  const nested = await tx
    .select({ parentId: agents.parentId })
    .from(agents)
    .where(inArray(agents.parentId, subAgentIds))
    .limit(1);
  if (nested.length > 0) {
    const row = rows.find((candidate) => candidate.id === nested[0]?.parentId);
    throw new AppError(
      'INVALID_INPUT',
      `「${row?.name ?? nested[0]?.parentId}」自己还有子智能体；只支持一层委派，请先解除它的子智能体`,
    );
  }
  const bound = await tx
    .select({ agentId: agentPlugins.agentId })
    .from(agentPlugins)
    .where(inArray(agentPlugins.agentId, subAgentIds))
    .limit(1);
  if (bound.length > 0) {
    const row = rows.find((candidate) => candidate.id === bound[0]?.agentId);
    throw new AppError(
      'INVALID_INPUT',
      `「${row?.name ?? bound[0]?.agentId}」绑定了插件；插件只在会话级加载，请先解除它的插件绑定`,
    );
  }
}

export async function createAgent(
  db: Database,
  input: AgentWrite,
  serverIds: string[],
  skillIds: string[],
  subAgentIds: string[] = [],
  pluginBindings: Agent['pluginBindings'] = [],
): Promise<AgentRow> {
  const id = newId('agent');
  const [row] = await retryOnVersionConflict(() =>
    db.transaction(async (tx) => {
      // 先拿 advisory 再碰 agents 的行和唯一索引，与 update/duplicate 的先后顺序一致。
      if (pluginBindings.length > 0) await lockAgentBindings(tx);
      if (subAgentIds.length > 0) await lockSubAgentBindings(tx, id, subAgentIds);
      const inserted = await tx
        .insert(agents)
        .values({ id, ...input })
        .returning();
      if (subAgentIds.length > 0) {
        const claimed = await tx
          .update(agents)
          .set({ parentId: id })
          .where(inArray(agents.id, subAgentIds))
          .returning({ id: agents.id });
        if (claimed.length !== subAgentIds.length) {
          throw new AppError('INVALID_INPUT', '选中的子智能体已被删除，请刷新后重新选择');
        }
      }
      if (serverIds.length > 0) {
        await tx
          .insert(agentServers)
          .values(serverIds.map((serverId) => ({ agentId: id, serverId })));
      }
      if (skillIds.length > 0) {
        await tx.insert(agentSkills).values(skillIds.map((skillId) => ({ agentId: id, skillId })));
      }
      const created = inserted[0];
      if (!created) throw new Error('agent insert returned no row');
      await writeAgentPluginBindings(tx, id, pluginBindings);
      await insertAgentVersion(
        tx,
        id,
        toAgent(created, serverIds, skillIds, subAgentIds, pluginBindings),
      );
      return inserted;
    }),
  );
  if (!row) throw new Error('agent insert returned no row');
  return row;
}

/** SQLSTATE 40001：串行化失败，调用方可安全重试整段事务。 */
function isSerializationFailure(err: unknown): boolean {
  let cause: unknown = err;
  for (let depth = 0; depth < 5 && typeof cause === 'object' && cause !== null; depth += 1) {
    if ('code' in cause && cause.code === '40001') return true;
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return false;
}

/**
 * 复制智能体配置：绑定、规则、输出风格一并复制，子智能体不复制（只支持一层，且源对象不变）。
 * repeatable read + FOR SHARE 保证读到一致的源配置；版本从 v1 重新开始。
 */
export async function duplicateAgent(
  db: Database,
  sourceId: string,
  input: AgentDuplicateInput,
): Promise<Agent | null> {
  try {
    return await retryOnVersionConflict(() =>
      db.transaction(
        async (tx) => {
          // 复制会照抄源绑定；先拿 advisory 再读/锁源行，避免与「先 advisory 后改候选行」
          // 的事务交叉持锁。源有没有绑定要先读才知道，所以直接无条件拿，代价只是一次快锁。
          await lockAgentBindings(tx);
          const [source] = await tx
            .select()
            .from(agents)
            .where(eq(agents.id, sourceId))
            .limit(1)
            .for('share');
          if (!source) return null;

          const serverIds = await getAgentServerIds(tx, sourceId);
          const skillIds = await getAgentSkillIds(tx, sourceId);
          const pluginBindings =
            (await listAgentPluginBindings(tx, [sourceId])).get(sourceId) ?? [];
          const ruleRows = await tx
            .select()
            .from(agentRules)
            .where(eq(agentRules.agentId, sourceId));
          const styleRows = await tx
            .select()
            .from(agentOutputStyles)
            .where(eq(agentOutputStyles.agentId, sourceId));

          const id = newId('agent');
          const [created] = await tx
            .insert(agents)
            .values({
              id,
              slug: input.slug,
              name: input.name,
              role: source.role,
              description: source.description,
              model: source.model,
              systemPromptMd: source.systemPromptMd,
              allowedTools: source.allowedTools,
              disallowedTools: source.disallowedTools,
              permissionMode: source.permissionMode,
              uiFormat: source.uiFormat,
              effort: source.effort,
              maxThinkingTokens: source.maxThinkingTokens,
              enabled: source.enabled,
              maxTurns: source.maxTurns,
              maxBudgetUsd: source.maxBudgetUsd,
              timeoutMs: source.timeoutMs,
              parentId: null,
            })
            .returning();
          if (!created) throw new Error('agent insert returned no row');

          if (serverIds.length > 0) {
            await tx
              .insert(agentServers)
              .values(serverIds.map((serverId) => ({ agentId: id, serverId })));
          }
          if (skillIds.length > 0) {
            await tx
              .insert(agentSkills)
              .values(skillIds.map((skillId) => ({ agentId: id, skillId })));
          }
          await writeAgentPluginBindings(tx, id, pluginBindings);
          if (ruleRows.length > 0) {
            await tx.insert(agentRules).values(
              ruleRows.map((row) => ({
                id: newId('rule'),
                agentId: id,
                slug: row.slug,
                content: row.content,
                globs: row.globs,
              })),
            );
          }
          if (styleRows.length > 0) {
            await tx.insert(agentOutputStyles).values(
              styleRows.map((row) => ({
                id: newId('outputStyle'),
                agentId: id,
                slug: row.slug,
                description: row.description,
                keepCodingInstructions: row.keepCodingInstructions,
                body: row.body,
                isSelected: row.isSelected,
              })),
            );
          }

          const snapshot = toAgent(created, serverIds, skillIds, [], pluginBindings);
          await insertAgentVersion(tx, id, snapshot);
          return snapshot;
        },
        { isolationLevel: 'repeatable read' },
      ),
    );
  } catch (err) {
    if (isSerializationFailure(err)) {
      throw new AppError('CONFLICT', 'agent duplication conflict, retry later', {
        retryable: true,
      });
    }
    throw err;
  }
}

export async function updateAgent(
  db: Database,
  id: string,
  patch: Partial<AgentWrite>,
  serverIds?: string[],
  skillIds?: string[],
  note: string | null = null,
  subAgentIds?: string[],
  expectedUpdatedAt?: Date,
  pluginBindings?: Agent['pluginBindings'],
): Promise<AgentRow | null> {
  return retryOnVersionConflict(() =>
    db.transaction(async (tx) => {
      // 锁和复查必须在 UPDATE 之前：拿到锁后再读，读到的才是最终状态。
      // 会拿行锁的写事务一律先拿 advisory，否则与委派事务交叉持锁（二者都改 agents 行）。
      if (subAgentIds !== undefined || (pluginBindings?.length ?? 0) > 0) {
        await lockAgentBindings(tx);
      }
      if (subAgentIds !== undefined) await lockSubAgentBindings(tx, id, subAgentIds);
      const where =
        expectedUpdatedAt === undefined
          ? eq(agents.id, id)
          : and(eq(agents.id, id), notStale(agents.updatedAt, expectedUpdatedAt));
      const [row] = await tx
        .update(agents)
        .set({
          ...patch,
          // 版本按毫秒比较，同一毫秒内的连续更新也要推进，否则旧 token 仍会命中。
          updatedAt: sql`greatest(now(), date_trunc('milliseconds', ${agents.updatedAt}) + interval '1 millisecond')`,
        })
        .where(where)
        .returning();
      if (!row) {
        // 条件更新落空：行还在就是并发修改，行没了交给路由返回 404。
        if (expectedUpdatedAt !== undefined && (await getAgent(tx, id))) {
          throw new AppError('CONFLICT_STALE', '配置已被修改，请刷新');
        }
        return null;
      }
      if (subAgentIds !== undefined) {
        await tx
          .update(agents)
          .set({ parentId: null })
          .where(and(eq(agents.parentId, id), ne(agents.id, id)));
        if (subAgentIds.length > 0) {
          const claimed = await tx
            .update(agents)
            .set({ parentId: id })
            .where(inArray(agents.id, subAgentIds))
            .returning({ id: agents.id });
          if (claimed.length !== subAgentIds.length) {
            throw new AppError('INVALID_INPUT', '选中的子智能体已被删除，请刷新后重新选择');
          }
        }
      }
      if (serverIds !== undefined) {
        await tx.delete(agentServers).where(eq(agentServers.agentId, id));
        if (serverIds.length > 0) {
          await tx
            .insert(agentServers)
            .values(serverIds.map((serverId) => ({ agentId: id, serverId })));
        }
      }
      if (skillIds !== undefined) {
        await tx.delete(agentSkills).where(eq(agentSkills.agentId, id));
        if (skillIds.length > 0) {
          await tx
            .insert(agentSkills)
            .values(skillIds.map((skillId) => ({ agentId: id, skillId })));
        }
      }
      const nextServerIds = serverIds ?? (await getAgentServerIds(tx, id));
      const nextSkillIds = skillIds ?? (await getAgentSkillIds(tx, id));
      const nextSubAgentIds = subAgentIds ?? (await getAgentSubAgentIds(tx, id));
      if (pluginBindings !== undefined) await writeAgentPluginBindings(tx, id, pluginBindings);
      const nextPluginBindings =
        pluginBindings ?? (await listAgentPluginBindings(tx, [id])).get(id) ?? [];
      await insertAgentVersion(
        tx,
        id,
        toAgent(row, nextServerIds, nextSkillIds, nextSubAgentIds, nextPluginBindings),
        note,
      );
      return row;
    }),
  );
}

export async function listAgentPluginBindings(
  db: Database | Tx,
  agentIds: string[],
): Promise<Map<string, Agent['pluginBindings']>> {
  const out = new Map<string, Agent['pluginBindings']>();
  if (agentIds.length === 0) return out;
  const rows = await db
    .select({
      agentId: agentPlugins.agentId,
      pluginId: agentPlugins.pluginId,
      allowHooks: agentPlugins.allowHooks,
      allowMcp: agentPlugins.allowMcp,
    })
    .from(agentPlugins)
    .where(inArray(agentPlugins.agentId, agentIds))
    .orderBy(asc(agentPlugins.agentId), asc(agentPlugins.pluginId));
  for (const row of rows) {
    const list = out.get(row.agentId) ?? [];
    list.push({
      pluginId: row.pluginId,
      allowHooks: row.allowHooks,
      allowMcp: row.allowMcp,
    });
    out.set(row.agentId, list);
  }
  return out;
}

/**
 * 专家与插件的绑定随专家一起写。子智能体不允许绑定：复查 parentId，
 * 这样「解绑后立刻被收为子智能体」和「已解绑后又想恢复旧绑定」都过不了。
 * 本函数是私有写 helper，不加锁：调用方在有绑定时必须先 lockAgentBindings，且在碰任何行锁之前。
 */
async function writeAgentPluginBindings(
  tx: Tx,
  agentId: string,
  bindings: Agent['pluginBindings'],
): Promise<void> {
  if (bindings.length > 0) {
    const self = await getAgent(tx, agentId);
    if (self !== null && self.parentId !== null) {
      throw new AppError('INVALID_INPUT', '子智能体不能绑定插件；插件在会话级加载');
    }
  }
  await tx.delete(agentPlugins).where(eq(agentPlugins.agentId, agentId));
  if (bindings.length === 0) return;
  await tx.insert(agentPlugins).values(
    bindings.map((binding) => ({
      agentId,
      pluginId: binding.pluginId,
      allowHooks: binding.allowHooks,
      allowMcp: binding.allowMcp,
    })),
  );
}

export async function deleteAgent(db: Database, id: string): Promise<boolean> {
  const rows = await db.delete(agents).where(eq(agents.id, id)).returning({ id: agents.id });
  return rows.length > 0;
}

export async function getAgentServerIds(db: Database | Tx, agentId: string): Promise<string[]> {
  const rows = await db
    .select({ serverId: agentServers.serverId })
    .from(agentServers)
    .where(eq(agentServers.agentId, agentId))
    .orderBy(asc(agentServers.serverId));
  return rows.map((row) => row.serverId);
}

/** 一次取回多个 agent 的绑定关系，列表接口避免 N+1。 */
export async function listAgentServerIds(
  db: Database,
  agentIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (agentIds.length === 0) return out;
  const rows = await db
    .select({ agentId: agentServers.agentId, serverId: agentServers.serverId })
    .from(agentServers)
    .where(inArray(agentServers.agentId, agentIds))
    .orderBy(asc(agentServers.agentId), asc(agentServers.serverId));
  for (const row of rows) {
    const list = out.get(row.agentId);
    if (list) list.push(row.serverId);
    else out.set(row.agentId, [row.serverId]);
  }
  return out;
}

export async function getAgentSkillIds(db: Database | Tx, agentId: string): Promise<string[]> {
  const rows = await db
    .select({ skillId: agentSkills.skillId })
    .from(agentSkills)
    .where(eq(agentSkills.agentId, agentId))
    .orderBy(asc(agentSkills.skillId));
  return rows.map((row) => row.skillId);
}

export async function listAgentSkillIds(
  db: Database,
  agentIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (agentIds.length === 0) return out;
  const rows = await db
    .select({ agentId: agentSkills.agentId, skillId: agentSkills.skillId })
    .from(agentSkills)
    .where(inArray(agentSkills.agentId, agentIds))
    .orderBy(asc(agentSkills.agentId), asc(agentSkills.skillId));
  for (const row of rows) {
    const list = out.get(row.agentId);
    if (list) list.push(row.skillId);
    else out.set(row.agentId, [row.skillId]);
  }
  return out;
}

/** 某 agent 的直接子智能体（含已停用的，供预览/管理）。 */
export async function listSubAgents(db: Database, agentId: string): Promise<AgentRow[]> {
  return db.select().from(agents).where(eq(agents.parentId, agentId)).orderBy(asc(agents.id));
}

/** 某 agent 的子智能体 id（parent_id 指向它）。 */
export async function getAgentSubAgentIds(db: Database | Tx, agentId: string): Promise<string[]> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.parentId, agentId))
    .orderBy(asc(agents.id));
  return rows.map((row) => row.id);
}

export async function listAgentSubAgentIds(
  db: Database,
  agentIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (agentIds.length === 0) return out;
  const rows = await db
    .select({ id: agents.id, parentId: agents.parentId })
    .from(agents)
    .where(inArray(agents.parentId, agentIds))
    .orderBy(asc(agents.id));
  for (const row of rows) {
    if (!row.parentId) continue;
    const list = out.get(row.parentId);
    if (list) list.push(row.id);
    else out.set(row.parentId, [row.id]);
  }
  return out;
}

/** 可以作为子智能体的候选：还没有 parent 的 agent，排除自己。 */
export async function listSubAgentCandidates(
  db: Database,
  excludeId?: string,
): Promise<AgentRow[]> {
  const rows = await db
    .select()
    .from(agents)
    .where(isNull(agents.parentId))
    .orderBy(asc(agents.createdAt), asc(agents.id));
  return excludeId === undefined ? rows : rows.filter((row) => row.id !== excludeId);
}

export async function getAgentsByIds(db: Database, ids: string[]): Promise<AgentRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(agents).where(inArray(agents.id, ids));
}

/** 批量取多个 agent 绑定的 servers：预览、导出与详情避免按行发 SQL。 */
export async function getBoundServersByAgentIds(
  db: Database,
  agentIds: string[],
): Promise<Map<string, Array<typeof servers.$inferSelect>>> {
  const out = new Map<string, Array<typeof servers.$inferSelect>>();
  if (agentIds.length === 0) return out;
  const rows = await db
    .select({ agentId: agentServers.agentId, server: servers })
    .from(agentServers)
    .innerJoin(servers, eq(agentServers.serverId, servers.id))
    .where(inArray(agentServers.agentId, agentIds))
    .orderBy(asc(agentServers.agentId), asc(agentServers.serverId));
  for (const row of rows) {
    const list = out.get(row.agentId);
    if (list) list.push(row.server);
    else out.set(row.agentId, [row.server]);
  }
  return out;
}

export async function getBoundSkills(
  db: Database,
  agentId: string,
): Promise<Array<typeof skills.$inferSelect>> {
  return (await getBoundSkillsByAgentIds(db, [agentId])).get(agentId) ?? [];
}

/** 批量取多个 agent 绑定的技能：子智能体技能只查一次，不按行发 SQL。 */
export async function getBoundSkillsByAgentIds(
  db: Database,
  agentIds: string[],
): Promise<Map<string, Array<typeof skills.$inferSelect>>> {
  const out = new Map<string, Array<typeof skills.$inferSelect>>();
  if (agentIds.length === 0) return out;
  const rows = await db
    .select({ agentId: agentSkills.agentId, skill: skills })
    .from(agentSkills)
    .innerJoin(skills, eq(agentSkills.skillId, skills.id))
    .where(inArray(agentSkills.agentId, agentIds))
    .orderBy(asc(agentSkills.agentId), asc(skills.slug));
  for (const row of rows) {
    const list = out.get(row.agentId);
    if (list) list.push(row.skill);
    else out.set(row.agentId, [row.skill]);
  }
  return out;
}
