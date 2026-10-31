import { AppError } from '@agentport/core';
import type { AccessFilter, Agent, AgentDuplicateInput, AgentInput } from '@agentport/shared';
import { and, asc, eq, inArray, isNotNull, ne, or, type SQL, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import {
  agentMembers,
  agentOutputStyles,
  agentPlugins,
  agentRules,
  agentRuns,
  agentServers,
  agentSkills,
  agents,
  conversations,
  servers,
  skills,
} from '../schema.js';
import { insertAgentVersion, retryOnVersionConflict, type Tx } from './agent-versions.js';
import type { ConversationSandboxTarget } from './chat.js';
import { notStale } from './freshness.js';
import { lockAgentBindings } from './locks.js';

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
  enabled: boolean;
  maxTurns: number;
  /** numeric 列以字符串写入，避免浮点误差。 */
  maxBudgetUsd: string;
  timeoutMs: number;
  /** 当前业务身份；创建后不随转交改变。 */
  createdBy: string;
  /** 当前负责人；新建时等于 createdBy。 */
  ownerBusinessId: string;
  parentId?: string | null;
  /** 绑定的运行环境；null 表示平台默认环境。 */
  runtimeEnvironmentId?: string | null;
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
    createdBy: row.createdBy,
    ownerBusinessId: row.ownerBusinessId,
    model: row.model,
    systemPrompt: row.systemPromptMd,
    serverIds,
    skillIds,
    pluginBindings,
    subAgentIds,
    parentId: row.parentId,
    runtimeEnvironmentId: row.runtimeEnvironmentId,
    allowedTools: row.allowedTools,
    disallowedTools: row.disallowedTools,
    permissionMode: row.permissionMode as AgentInput['permissionMode'],
    uiFormat: row.uiFormat as AgentInput['uiFormat'],
    maxTurns: row.maxTurns,
    maxBudgetUsd: Number(row.maxBudgetUsd),
    timeoutMs: row.timeoutMs,
    ...(row.effort === null ? {} : { effort: row.effort as NonNullable<AgentInput['effort']> }),
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** agents.read 的列表与删除重核共用同一范围谓词；范围不够时返回空结果。 */
function agentReadScopeWhere(access: AccessFilter): SQL | undefined {
  const scopes = new Set(access.scopes);
  if (scopes.has('platform')) return undefined;
  const visible: SQL[] = [];
  if (scopes.has('owned_agents')) {
    visible.push(eq(agents.ownerBusinessId, access.businessId));
  }
  if (scopes.has('authorized_agents')) {
    visible.push(
      sql`(${agents.ownerBusinessId} = ${access.businessId} or exists (select 1 from ${agentMembers} m where m.agent_id = ${agents.id} and m.business_id = ${access.businessId} and m.can_use))`,
    );
  }
  if (scopes.has('maintained_agents')) {
    visible.push(
      sql`(${agents.ownerBusinessId} = ${access.businessId} or exists (select 1 from ${agentMembers} m where m.agent_id = ${agents.id} and m.business_id = ${access.businessId} and m.can_maintain))`,
    );
  }
  if (visible.length === 0) return sql`false`;
  return or(...visible);
}

/** agents.delete 只接受 owned_agents / platform，不因 can_use/can_maintain 扩大删除范围。 */
function agentDeleteScopeWhere(access: AccessFilter): SQL | undefined {
  const scopes = new Set(access.scopes);
  if (scopes.has('platform')) return undefined;
  if (scopes.has('owned_agents')) return eq(agents.ownerBusinessId, access.businessId);
  return sql`false`;
}

function agentDeletionWhere(input: AgentDeletionInput): SQL | undefined {
  return and(
    eq(agents.id, input.id),
    agentDeleteScopeWhere(input.access),
    agentReadScopeWhere(input.readAccess),
  );
}

export async function listAgents(db: Database, access: AccessFilter): Promise<AgentRow[]> {
  return db
    .select()
    .from(agents)
    .where(agentReadScopeWhere(access))
    .orderBy(asc(agents.createdAt), asc(agents.id));
}

export async function getAgent(db: Database | Tx, id: string): Promise<AgentRow | null> {
  const [row] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  return row ?? null;
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

/**
 * 改变委派活动集合前，确认真实活动 run 已结束。审核 run 不挂可写目录、也不占委派资源，
 * 因此不算活动运行；queued 取消会直接进入终态，running 取消等 worker 收尾后才解除保护。
 */
async function assertAgentsIdle(db: Database | Tx, agentIds: string[]): Promise<void> {
  if (agentIds.length === 0) return;
  const [active] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        inArray(agentRuns.agentId, agentIds),
        inArray(agentRuns.status, ['queued', 'running']),
        ne(agentRuns.trigger, 'review'),
      ),
    )
    .limit(1);
  if (active) {
    throw new AppError('CONFLICT', '智能体或其委派关系中仍有运行未结束，请等待完成或取消后再修改');
  }
}

function sameIdSet(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
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
      if (subAgentIds.length > 0) {
        await lockSubAgentBindings(tx, id, subAgentIds);
        await assertAgentsIdle(tx, subAgentIds);
      }
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
  ownerBusinessId: string,
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
              enabled: source.enabled,
              maxTurns: source.maxTurns,
              maxBudgetUsd: source.maxBudgetUsd,
              timeoutMs: source.timeoutMs,
              createdBy: ownerBusinessId,
              ownerBusinessId,
              parentId: null,
              // 复制的是环境绑定（不是构建版本）；源环境的版本历史不跟着复制。
              runtimeEnvironmentId: source.runtimeEnvironmentId,
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

/** 普通编辑不能改归属；转交只走 access.transferAgent。 */
export type AgentPatch = Partial<Omit<AgentWrite, 'createdBy' | 'ownerBusinessId'>>;

export async function updateAgent(
  db: Database,
  id: string,
  patch: AgentPatch,
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
      const changesSet = subAgentIds !== undefined || patch.enabled !== undefined;
      if (changesSet || (pluginBindings?.length ?? 0) > 0) {
        await lockAgentBindings(tx);
      }
      if (subAgentIds !== undefined) await lockSubAgentBindings(tx, id, subAgentIds);
      if (changesSet) {
        const current = await getAgent(tx, id);
        if (current) {
          if (subAgentIds !== undefined) {
            const previousChildren = await getAgentSubAgentIds(tx, id);
            if (!sameIdSet(previousChildren, subAgentIds)) {
              await assertAgentsIdle(tx, [id, ...previousChildren, ...subAgentIds]);
            }
          }
          // 启停会改变父专家运行时的活动集合：只查目标与它当前的父专家。
          if (patch.enabled !== undefined && patch.enabled !== current.enabled) {
            await assertAgentsIdle(tx, current.parentId === null ? [id] : [id, current.parentId]);
          }
        }
      }
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

export interface AgentDeletionInput {
  id: string;
  /** agents.delete 的范围；只接受 owned_agents / platform。 */
  access: AccessFilter;
  /** agents.delete 依赖的 agents.read 范围，保留同一请求内授权快照。 */
  readAccess: AccessFilter;
}

export interface AgentDeletionSnapshot {
  id: string;
  slug: string;
  ownerBusinessId: string;
  parentId: string | null;
  enabled: boolean;
  /** 全部直接子级；影响解绑与活动集合。 */
  childIds: string[];
  affectedAgentIds: string[];
  /** 只含目标专家自身的会话，不包含子级会话。 */
  targets: ConversationSandboxTarget[];
}

/**
 * 短 tx A：按删除/读取范围重查主体，返回确定快照后立即提交。
 * 不在事务内等待任何网络关闭确认；目标集合由调用方在事务外精确核对。
 */
export async function prepareAgentDeletion(
  db: Database,
  input: AgentDeletionInput,
): Promise<AgentDeletionSnapshot | null> {
  return db.transaction((tx) => readAgentDeletionSnapshot(tx, input));
}

/** 短 tx B：重读完整快照并与 A 精确比较，匹配才删除；任何变化回滚。 */
export async function deleteAgent(
  db: Database,
  input: AgentDeletionInput & { expected: AgentDeletionSnapshot },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const actual = await readAgentDeletionSnapshot(tx, input, true);
    if (actual === null) return false;
    if (!sameAgentSnapshot(input.expected, actual)) {
      throw new AppError('CONFLICT', '智能体或其会话在删除期间发生变化，请重试', {
        retryable: true,
      });
    }
    const rows = await tx
      .delete(agents)
      .where(agentDeletionWhere(input))
      .returning({ id: agents.id });
    return rows.length > 0;
  });
}

async function readAgentDeletionSnapshot(
  tx: Tx,
  input: AgentDeletionInput,
  lockSelf = false,
): Promise<AgentDeletionSnapshot | null> {
  await lockAgentBindings(tx);
  const query = tx.select().from(agents).where(agentDeletionWhere(input)).limit(1);
  const [self] = lockSelf ? await query.for('update') : await query;
  if (!self) return null;
  const childIds = await getAgentSubAgentIds(tx, self.id);
  // 删除一个 enabled 子级也会改变父专家的活动集合。
  const affected = [...new Set([self.id, ...childIds])];
  if (self.enabled && self.parentId !== null) affected.push(self.parentId);
  affected.sort();
  await assertAgentsIdle(tx, affected);
  const targets = await sandboxTargetsForAgent(tx, self.id);
  return {
    id: self.id,
    slug: self.slug,
    ownerBusinessId: self.ownerBusinessId,
    parentId: self.parentId,
    enabled: self.enabled,
    childIds,
    affectedAgentIds: affected,
    targets,
  };
}

function sameAgentSnapshot(
  expected: AgentDeletionSnapshot,
  actual: AgentDeletionSnapshot,
): boolean {
  return (
    expected.id === actual.id &&
    expected.slug === actual.slug &&
    expected.ownerBusinessId === actual.ownerBusinessId &&
    expected.parentId === actual.parentId &&
    expected.enabled === actual.enabled &&
    sameIdSet(expected.childIds, actual.childIds) &&
    sameIdSet(expected.affectedAgentIds, actual.affectedAgentIds) &&
    sameTargets(expected.targets, actual.targets)
  );
}

function sameTargets(
  left: ConversationSandboxTarget[],
  right: ConversationSandboxTarget[],
): boolean {
  return (
    left.length === right.length &&
    left.every((target, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        target.conversationId === other.conversationId &&
        target.sandboxIds.length === other.sandboxIds.length &&
        target.sandboxIds.every((id, sandboxIndex) => id === other.sandboxIds[sandboxIndex])
      );
    })
  );
}

/** 目标会话与各会话已落库的容器名；锁内查询，供事务外精确关闭。 */
async function sandboxTargetsForAgent(
  tx: Tx,
  agentId: string,
): Promise<ConversationSandboxTarget[]> {
  const conversationRows = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.agentId, agentId))
    .orderBy(asc(conversations.id));
  const conversationIds = conversationRows.map((row) => row.id);
  const byConversation = new Map<string, Set<string>>(
    conversationIds.map((conversationId) => [conversationId, new Set<string>()]),
  );
  if (conversationIds.length > 0) {
    const runRows = await tx
      .select({ conversationId: agentRuns.conversationId, sandboxId: agentRuns.sandboxId })
      .from(agentRuns)
      .where(
        and(inArray(agentRuns.conversationId, conversationIds), isNotNull(agentRuns.sandboxId)),
      );
    for (const row of runRows) {
      if (row.sandboxId !== null) byConversation.get(row.conversationId)?.add(row.sandboxId);
    }
  }
  return conversationIds.map((conversationId) => ({
    conversationId,
    sandboxIds: [...(byConversation.get(conversationId) ?? [])].sort(),
  }));
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
