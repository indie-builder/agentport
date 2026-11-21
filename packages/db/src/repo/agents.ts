import { AppError } from '@agentport/core';
import {
  ACTIVE_RUN_STATUSES,
  type AccessFilter,
  type Agent,
  type AgentDefinition,
  type AgentDuplicateInput,
  agentInputSchema,
  apiToolSchema,
  DEFAULT_MEMORY_POLICY,
  encodeCursor,
  type MemoryPolicy,
  pluginInputSchema,
  resolveMemoryPolicy,
} from '@agentport/shared';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Database, DbHandle, Transaction } from '../client.js';
import { newId } from '../id.js';
import {
  agentFavorites,
  agentHookFiles,
  agentMembers,
  agentOutputStyles,
  agentPlugins,
  agentRules,
  agentRuns,
  agentServers,
  agentSkills,
  agents,
  agentVersions,
  agentWorkflows,
  apiTools,
  plugins,
  runtimeEnvironments,
  servers,
  skills,
} from '../schema.js';
import {
  assertDefinitionResources,
  getAgentVersion,
  insertAgentVersion,
  recordPublishedVersion,
  retryOnVersionConflict,
} from './agent-versions.js';
import { notStale, touchUpdatedAt } from './freshness.js';
import { lockAgentBindings } from './locks.js';
import type { CursorPage } from './pagination.js';
import { isPgCode } from './pg-errors.js';
import { getPluginFilesByPluginIds, listAgentPluginBindingInputs } from './plugins.js';
import { getSkillFilesBySkillIds } from './skill-files.js';
import { toSkillDefinition } from './skills.js';
import { listAgentIdsWithWorkflows } from './workflows.js';

export type AgentRow = typeof agents.$inferSelect;

const DEFAULT_AGENT_SLUG = 'assistant';
const DEFAULT_AGENT_NAME = '通用助手';

function assertNotReservedSlug(slug: string): void {
  if (slug === DEFAULT_AGENT_SLUG) {
    throw new AppError(
      'INVALID_INPUT',
      `slug '${DEFAULT_AGENT_SLUG}' 保留给平台通用助手，请换一个`,
    );
  }
}

export interface AgentWrite {
  slug: string;
  name: string;
  role: string;
  description: string;
  model: string;
  systemPromptMd: string;
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: AgentRow['permissionMode'];
  uiFormat: AgentRow['uiFormat'];
  effort: AgentRow['effort'];
  enabled: boolean;
  visibility: AgentRow['visibility'];
  tags: string[];
  maxTurns: number;
  maxBudgetUsd: string;
  monthlyBudgetUsd: string | null;
  budgetAlertRatio: string;
  timeoutMs: number;
  createdBy: string;
  ownerBusinessId: string;
  parentId?: string | null;
  runtimeEnvironmentId?: string | null;
}

export function toAgent(
  row: AgentRow,
  serverIds: string[],
  skillIds: string[],
  subAgentIds: string[] = [],
  pluginBindings: Agent['pluginBindings'] = [],
): Agent & { archivedAt: string | null; deletedAt: string | null } {
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
    permissionMode: row.permissionMode,
    uiFormat: row.uiFormat,
    maxTurns: row.maxTurns,
    maxBudgetUsd: Number(row.maxBudgetUsd),
    monthlyBudgetUsd: row.monthlyBudgetUsd === null ? null : Number(row.monthlyBudgetUsd),
    budgetAlertRatio: Number(row.budgetAlertRatio),
    timeoutMs: row.timeoutMs,
    ...(row.effort === null ? {} : { effort: row.effort }),
    enabled: row.enabled,
    visibility: row.visibility,
    tags: row.tags,
    isDefault: row.isDefault,
    publishedVersion: row.publishedVersion,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const organizationVisibleWhere = sql`(${agents.visibility} = 'organization' and ${agents.publishedVersion} is not null and ${agents.enabled} and ${agents.archivedAt} is null and ${agents.deletedAt} is null)`;

/** agents.read 的列表范围谓词；范围不够时返回空结果。 */
function agentReadScopeWhere(access: AccessFilter): SQL | undefined {
  const scopes = new Set(access.scopes);
  if (scopes.has('platform')) return undefined;
  const visible: SQL[] = [];
  if (scopes.has('owned_agents')) {
    visible.push(eq(agents.ownerBusinessId, access.businessId));
  }
  if (scopes.has('authorized_agents')) {
    visible.push(
      sql`(${agents.ownerBusinessId} = ${access.businessId} or exists (select 1 from ${agentMembers} m where m.agent_id = ${agents.id} and m.business_id = ${access.businessId} and m.can_use) or ${organizationVisibleWhere})`,
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

function agentListScopeWhere(access: AccessFilter): SQL | undefined {
  const scope = agentReadScopeWhere(access);
  if (scope === undefined) return undefined;
  return or(eq(agents.isDefault, true), scope);
}

export type AgentLifecycleStatus = 'active' | 'archived' | 'deleted';

export interface AgentListOptions {
  q?: string | undefined;
  tag?: string | undefined;
  favorite?: boolean | undefined;
  sort?: 'name' | 'recent' | undefined;
  status?: AgentLifecycleStatus;
  enabled?: boolean;
  limit?: number;
}

type AgentListRow = AgentRow & {
  serverIds: string[] | null;
  isFavorite: boolean;
  lastUsedAt: Date | null;
};

type AgentPageOptions = AgentListOptions & {
  access: AccessFilter;
  configAccess?: AccessFilter;
  cursor?: string | undefined;
  cursorSort?: string | undefined;
  limit: number;
};

function agentListing(
  db: Database,
  access: AccessFilter,
  configAccess: AccessFilter | undefined,
  options: AgentListOptions,
) {
  const configScope = configAccess ? agentReadScopeWhere(configAccess) : sql`false`;
  const status = options.status ?? 'active';
  const lifecycleWhere =
    status === 'deleted'
      ? sql`${agents.deletedAt} is not null`
      : status === 'archived'
        ? sql`${agents.archivedAt} is not null and ${agents.deletedAt} is null`
        : sql`${agents.archivedAt} is null and ${agents.deletedAt} is null`;
  const lifecycleVisible =
    status === 'active' || access.scopes.includes('platform')
      ? undefined
      : access.scopes.includes('owned_agents')
        ? eq(agents.ownerBusinessId, access.businessId)
        : sql`false`;
  const favoriteWhere = sql`exists (select 1 from ${agentFavorites} where ${agentFavorites.agentId} = ${agents.id} and ${agentFavorites.businessId} = ${access.businessId})`;
  const lastUsedAt = sql<Date | null>`(select max(${agentRuns.createdAt}) from ${agentRuns} where ${agentRuns.agentId} = ${agents.id} and ${agentRuns.initiatedBy} = ${access.businessId})`;
  const needle = options.q?.trim();
  const searchWhere =
    needle === undefined || needle === ''
      ? undefined
      : or(
          sql`strpos(lower(${agents.name}), lower(${needle})) > 0`,
          sql`strpos(lower(${agents.role}), lower(${needle})) > 0`,
          sql`strpos(lower(${agents.description}), lower(${needle})) > 0`,
          sql`strpos(lower(${agents.slug}), lower(${needle})) > 0`,
          sql`exists (select 1 from jsonb_array_elements_text(${agents.tags}) as tag(value) where strpos(lower(tag.value), lower(${needle})) > 0)`,
        );
  const tagWhere =
    options.tag === undefined
      ? undefined
      : sql`${agents.tags} @> ${JSON.stringify([options.tag])}::jsonb`;
  const favoriteFilter =
    options.favorite === undefined
      ? undefined
      : options.favorite
        ? favoriteWhere
        : sql`not ${favoriteWhere}`;
  const enabledWhere =
    options.enabled === undefined ? undefined : eq(agents.enabled, options.enabled);
  const order =
    options.sort === 'name'
      ? [asc(agents.name), asc(agents.id)]
      : options.sort === 'recent'
        ? [sql`${lastUsedAt} desc nulls last`, asc(agents.name), asc(agents.id)]
        : [desc(agents.createdAt), desc(agents.id)];
  const scope = and(
    agentListScopeWhere(access),
    lifecycleWhere,
    lifecycleVisible,
    enabledWhere,
    searchWhere,
    tagWhere,
    favoriteFilter,
  );
  const fields = {
    ...getTableColumns(agents),
    serverIds: sql<
      string[] | null
    >`case when ${configScope ?? sql`true`} and not ${agents.isDefault} then
      coalesce(array_agg(${agentServers.serverId} order by ${agentServers.serverId})
        filter (where ${agentServers.serverId} is not null), '{}'::text[])
      else null end`,
    isFavorite: sql<boolean>`${favoriteWhere}`,
    lastUsedAt,
  };
  const load = (limit?: number, bound?: SQL) => {
    const query = db
      .select(fields)
      .from(agents)
      .leftJoin(agentServers, eq(agentServers.agentId, agents.id))
      .where(and(scope, bound))
      .groupBy(agents.id)
      .orderBy(...order);
    return limit === undefined ? query : query.limit(limit);
  };
  return { scope, lastUsedAt, load };
}

export function listAgents(
  db: Database,
  options: AgentPageOptions,
): Promise<CursorPage<AgentListRow> | null>;
export function listAgents(
  db: Database,
  access: AccessFilter,
  configAccess?: AccessFilter,
  options?: AgentListOptions,
): Promise<AgentListRow[]>;
export async function listAgents(
  db: Database,
  accessOrOptions: AccessFilter | AgentPageOptions,
  configAccess?: AccessFilter,
  options: AgentListOptions = {},
): Promise<AgentListRow[] | CursorPage<AgentListRow> | null> {
  if (!('access' in accessOrOptions)) {
    const { load } = agentListing(db, accessOrOptions, configAccess, options);
    return load(options.limit);
  }

  const {
    access,
    configAccess: pageConfigAccess,
    sort = 'createdAt',
    cursor,
    cursorSort,
    limit,
  } = accessOrOptions;
  const { scope, lastUsedAt, load } = agentListing(db, access, pageConfigAccess, accessOrOptions);
  let bound: SQL | undefined;
  if (cursor !== undefined) {
    if (cursorSort !== sort) return null;
    const time = sort === 'recent' ? lastUsedAt : agents.createdAt;
    const anchorTime = sql<
      string | null
    >`to_char(${time} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const [anchor] = await db
      .select({ id: agents.id, name: agents.name, time: anchorTime })
      .from(agents)
      .where(and(scope, eq(agents.id, cursor)))
      .limit(1);
    if (!anchor) return null;
    if (sort === 'name') {
      bound = sql`(${agents.name}, ${agents.id}) > (${anchor.name}, ${anchor.id})`;
    } else if (sort === 'createdAt') {
      bound = sql`(${agents.createdAt}, ${agents.id}) < (${anchor.time}::timestamptz, ${anchor.id})`;
    } else {
      const afterName = sql`(${agents.name}, ${agents.id}) > (${anchor.name}, ${anchor.id})`;
      if (anchor.time === null) {
        bound = sql`${lastUsedAt} is null and ${afterName}`;
      } else {
        bound = sql`(${lastUsedAt} is null or ${lastUsedAt} < ${anchor.time}::timestamptz or (${lastUsedAt} = ${anchor.time}::timestamptz and ${afterName}))`;
      }
    }
  }

  const rows = await load(limit + 1, bound);
  const items = rows.slice(0, limit);
  const last = rows.length > limit ? items.at(-1) : undefined;
  const nextCursor = last ? encodeCursor([sort, last.id]) : null;
  return { items, nextCursor };
}

export async function listAgentReference(
  db: Database,
  access: AccessFilter,
  configAccess: AccessFilter,
) {
  const rows = await listAgents(db, access, configAccess, { sort: 'name', limit: 501 });
  return { items: rows.slice(0, 500), truncated: rows.length > 500 };
}

export async function listServerBoundAgents(
  db: Database,
  serverId: string,
  access: AccessFilter,
): Promise<{ agents: Array<{ id: string; name: string }>; hiddenCount: number }> {
  const active = and(
    eq(agentServers.serverId, serverId),
    isNull(agents.archivedAt),
    isNull(agents.deletedAt),
  );
  const scope = access.scopes.length === 0 ? sql`false` : agentListScopeWhere(access);
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      visible: scope === undefined ? sql<boolean>`true` : sql<boolean>`coalesce((${scope}), false)`,
    })
    .from(agentServers)
    .innerJoin(agents, eq(agents.id, agentServers.agentId))
    .where(active)
    .orderBy(asc(agents.name), asc(agents.id));
  const visible = rows.filter((row) => row.visible).map(({ id, name }) => ({ id, name }));
  return { agents: visible, hiddenCount: rows.length - visible.length };
}

export async function listAgentTags(db: Database, access: AccessFilter): Promise<string[]> {
  const tag = sql<string>`jsonb_array_elements_text(${agents.tags})`.as('tag');
  const rows = await db
    .selectDistinct({ tag })
    .from(agents)
    .where(and(agentListScopeWhere(access), isNull(agents.archivedAt), isNull(agents.deletedAt)))
    .orderBy(asc(tag));
  return rows.map((row) => row.tag);
}

export async function setAgentFavorite(
  db: DbHandle,
  businessId: string,
  agentId: string,
  favorite: boolean,
): Promise<boolean> {
  if (favorite) {
    await db.insert(agentFavorites).values({ businessId, agentId }).onConflictDoNothing();
  } else {
    await db
      .delete(agentFavorites)
      .where(and(eq(agentFavorites.businessId, businessId), eq(agentFavorites.agentId, agentId)));
  }
  return favorite;
}

export async function archiveAgent(db: DbHandle, agentId: string): Promise<AgentRow | null> {
  const now = new Date();
  const [row] = await db
    .update(agents)
    .set({ archivedAt: now, updatedAt: now })
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
    .returning();
  return row ?? null;
}

export async function restoreAgent(db: DbHandle, agentId: string): Promise<AgentRow | null> {
  const now = new Date();
  const [row] = await db
    .update(agents)
    .set({ archivedAt: null, deletedAt: null, updatedAt: now })
    .where(eq(agents.id, agentId))
    .returning();
  return row ?? null;
}

export async function softDeleteAgent(db: DbHandle, agentId: string): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(agents)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(agents.id, agentId))
    .returning({ id: agents.id });
  return rows.length > 0;
}

export async function getAgent(db: DbHandle, id: string): Promise<AgentRow | null> {
  const [row] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  return row ?? null;
}

export async function sumAgentSpendSince(
  db: DbHandle,
  agentId: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${agentRuns.costUsd}), 0)::float` })
    .from(agentRuns)
    .where(and(eq(agentRuns.agentId, agentId), gte(agentRuns.startedAt, since)));
  return Number(row?.total ?? 0);
}

export async function findAgentSlug(db: DbHandle, agentId: string): Promise<string | null> {
  const [row] = await db
    .select({ slug: agents.slug })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return row?.slug ?? null;
}

export async function getDefaultAgent(db: DbHandle): Promise<AgentRow | null> {
  const [row] = await db.select().from(agents).where(eq(agents.isDefault, true)).limit(1);
  return row ?? null;
}

export async function ensureDefaultAgent(
  tx: Transaction,
  ownerBusinessId: string,
): Promise<AgentRow> {
  const existing = await getDefaultAgent(tx);
  if (existing !== null) return existing;
  const [conflict] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.slug, DEFAULT_AGENT_SLUG))
    .limit(1);
  if (conflict !== undefined) {
    throw new AppError(
      'CONFLICT',
      `slug '${DEFAULT_AGENT_SLUG}' 已被普通专家占用，无法创建通用助手`,
    );
  }
  const id = newId('agent');
  const [row] = await tx
    .insert(agents)
    .values({
      id,
      slug: DEFAULT_AGENT_SLUG,
      name: DEFAULT_AGENT_NAME,
      role: DEFAULT_AGENT_NAME,
      description: '',
      systemPromptMd: '',
      model: agentInputSchema.shape.model.parse(undefined),
      createdBy: ownerBusinessId,
      ownerBusinessId,
      isDefault: true,
      enabled: true,
      parentId: null,
      runtimeEnvironmentId: null,
      memoryPolicy: { ...DEFAULT_MEMORY_POLICY, enabled: false },
    })
    .returning();
  if (!row) throw new Error('default agent insert returned no row');
  const definition = await loadLiveDefinition(tx, id);
  if (!definition) throw new Error('default agent definition not found');
  if (definition.resources.runtimeEnvironment === null) return row;
  const version = await insertAgentVersion(tx, id, definition.agent, definition);
  const published = await recordPublishedVersion(tx, id, version);
  if (!published) throw new Error('default agent publish returned no row');
  return published;
}

export async function publishDefaultAgentIfNeeded(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('agentport:bootstrap'))`);
    const agent = await getDefaultAgent(tx);
    if (agent === null) return;
    const live = await loadLiveDefinition(tx, agent.id);
    if (live === null || live.resources.runtimeEnvironment === null) return;
    const published =
      agent.publishedVersion === null
        ? null
        : await getAgentVersion(tx, agent.id, agent.publishedVersion);
    if (published?.definition?.resources.runtimeEnvironment != null) return;
    const version = await insertAgentVersion(
      tx,
      agent.id,
      live.agent,
      live,
      'default environment ready',
    );
    await recordPublishedVersion(tx, agent.id, version);
  });
}

/** 只读记忆策略：行不存在返回 null；已落库 JSON 非法时按默认策略运行。 */
export async function getAgentMemoryPolicy(
  db: DbHandle,
  agentId: string,
): Promise<MemoryPolicy | null> {
  const [row] = await db
    .select({ memoryPolicy: agents.memoryPolicy })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return row ? resolveMemoryPolicy(row.memoryPolicy) : null;
}

export async function updateAgentMemoryPolicy(
  db: DbHandle,
  agentId: string,
  policy: MemoryPolicy,
): Promise<boolean> {
  const rows = await db
    .update(agents)
    .set({ memoryPolicy: policy })
    .where(eq(agents.id, agentId))
    .returning({ id: agents.id });
  return rows.length > 0;
}

/**
 * 绑定变更串行化：路由里的预检是快路径，并发下两个请求可能都通过，
 * 所以写事务再拿同一把 advisory 锁并复查。只保护绑定，不阻塞普通字段更新。
 * 调用方若会顺带拿行锁，必须先调 lockAgentBindings。
 */
export async function lockSubAgentBindings(
  tx: Transaction,
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
  const workflowAgentIds = await listAgentIdsWithWorkflows(tx, subAgentIds);
  if (workflowAgentIds.size > 0) {
    const agentId = subAgentIds.find((id) => workflowAgentIds.has(id));
    const row = rows.find((candidate) => candidate.id === agentId);
    throw new AppError(
      'INVALID_INPUT',
      `「${row?.name ?? agentId}」已有工作流；工作流是 project 级能力，请先删除它的工作流再设为子智能体`,
    );
  }
}

export async function hasActiveRunUsingAgents(db: DbHandle, agentIds: string[]): Promise<boolean> {
  if (agentIds.length === 0) return false;
  const liveIds = (
    await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(inArray(agents.id, agentIds), eq(agents.enabled, true)))
  ).map(({ id }) => id);
  const [active] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .leftJoin(
      agentVersions,
      and(
        eq(agentVersions.agentId, agentRuns.agentId),
        eq(agentVersions.version, agentRuns.agentVersion),
      ),
    )
    .where(
      and(
        inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
        ne(agentRuns.trigger, 'review'),
        or(
          inArray(agentRuns.agentId, agentIds),
          ...liveIds.map(
            (id) => sql`coalesce(${agentRuns.definitionSnapshot}, ${agentVersions.definition})
              ->'resources'->'subAgents' @> jsonb_build_array(jsonb_build_object('id', ${id}::text))`,
          ),
        ),
      ),
    )
    .limit(1);
  return active !== undefined;
}

/**
 * 改变委派活动集合前，确认真实活动 run 已结束。审核 run 不挂可写目录、也不占委派资源，
 * 因此不算活动运行；queued 取消会直接进入终态，running 取消等 worker 收尾后才解除保护。
 */
export async function assertAgentsIdle(db: DbHandle, agentIds: string[]): Promise<void> {
  if (await hasActiveRunUsingAgents(db, agentIds)) {
    throw new AppError('CONFLICT', '智能体或其委派关系中仍有运行未结束，请等待完成或取消后再修改');
  }
}

function sameIdSet(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export async function createAgent(
  db: DbHandle,
  input: AgentWrite,
  serverIds: string[],
  skillIds: string[],
  subAgentIds: string[] = [],
  pluginBindings: Agent['pluginBindings'] = [],
): Promise<AgentRow> {
  assertNotReservedSlug(input.slug);
  const id = newId('agent');
  const row = await retryOnVersionConflict(() =>
    db.transaction(async (tx) => {
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
      const definition = await loadLiveDefinition(tx, id);
      if (!definition) throw new Error('created agent definition not found');
      await assertDefinitionResources(tx, definition);
      const version = await insertAgentVersion(tx, id, definition.agent, definition);
      return recordPublishedVersion(tx, id, version);
    }),
  );
  if (!row) throw new Error('agent insert returned no row');
  return row;
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
  assertNotReservedSlug(input.slug);
  try {
    return await retryOnVersionConflict(() =>
      db.transaction(
        async (tx) => {
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
            (await listAgentPluginBindingInputs(tx, [sourceId])).get(sourceId) ?? [];
          const ruleRows = await tx
            .select()
            .from(agentRules)
            .where(eq(agentRules.agentId, sourceId));
          const styleRows = await tx
            .select()
            .from(agentOutputStyles)
            .where(eq(agentOutputStyles.agentId, sourceId));
          const workflowRows = await tx
            .select()
            .from(agentWorkflows)
            .where(eq(agentWorkflows.agentId, sourceId));

          const hookRows = await tx
            .select()
            .from(agentHookFiles)
            .where(eq(agentHookFiles.agentId, sourceId));

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
              visibility: source.visibility,
              tags: source.tags,
              maxTurns: source.maxTurns,
              maxBudgetUsd: source.maxBudgetUsd,
              monthlyBudgetUsd: source.monthlyBudgetUsd,
              budgetAlertRatio: source.budgetAlertRatio,
              timeoutMs: source.timeoutMs,
              createdBy: ownerBusinessId,
              ownerBusinessId,
              parentId: null,
              runtimeEnvironmentId: source.runtimeEnvironmentId,
              hooksEnabled: source.hooksEnabled,
              hooksConfig: source.hooksConfig,
              memoryPolicy: source.memoryPolicy,
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

          if (workflowRows.length > 0) {
            await tx.insert(agentWorkflows).values(
              workflowRows.map((row) => ({
                id: newId('agentWorkflow'),
                agentId: id,
                slug: row.slug,
                name: row.name,
                description: row.description,
                content: row.content,
              })),
            );
          }

          if (hookRows.length > 0) {
            await tx.insert(agentHookFiles).values(
              hookRows.map((row) => ({
                ...row,
                id: newId('agentHookFile'),
                agentId: id,
              })),
            );
          }
          const definition = await loadLiveDefinition(tx, id);
          if (!definition) throw new Error('duplicated agent definition not found');
          const version = await insertAgentVersion(tx, id, definition.agent, definition);
          const published = await recordPublishedVersion(tx, id, version);
          if (!published) throw new Error('duplicated agent not found');
          return toAgent(published, serverIds, skillIds, [], pluginBindings);
        },
        { isolationLevel: 'repeatable read' },
      ),
    );
  } catch (err) {
    if (isPgCode(err, '40001')) {
      throw new AppError('CONFLICT', 'agent duplication conflict, retry later', {
        retryable: true,
      });
    }
    throw err;
  }
}

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
    db.transaction((tx) =>
      updateAgentTx(
        tx,
        id,
        patch,
        serverIds,
        skillIds,
        note,
        subAgentIds,
        expectedUpdatedAt,
        pluginBindings,
      ),
    ),
  );
}

export async function updateAgentTx(
  tx: Transaction,
  id: string,
  patch: AgentPatch,
  serverIds?: string[],
  skillIds?: string[],
  note: string | null = null,
  subAgentIds?: string[],
  expectedUpdatedAt?: Date,
  pluginBindings?: Agent['pluginBindings'],
): Promise<AgentRow | null> {
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
      updatedAt: touchUpdatedAt(agents.updatedAt),
    })
    .where(where)
    .returning();
  if (!row) {
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
      await tx.insert(agentSkills).values(skillIds.map((skillId) => ({ agentId: id, skillId })));
    }
  }
  if (pluginBindings !== undefined) await writeAgentPluginBindings(tx, id, pluginBindings);
  const definition = await loadLiveDefinition(tx, id);
  if (!definition) return null;
  await insertAgentVersion(tx, id, definition.agent, definition, note);
  return row;
}

/**
 * 专家与插件的绑定随专家一起写。子智能体不允许绑定：复查 parentId，
 * 这样「解绑后立刻被收为子智能体」和「已解绑后又想恢复旧绑定」都过不了。
 * 本函数是私有写 helper，不加锁：调用方在有绑定时必须先 lockAgentBindings，且在碰任何行锁之前。
 */
async function writeAgentPluginBindings(
  tx: Transaction,
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

export async function getAgentServerIds(db: DbHandle, agentId: string): Promise<string[]> {
  const rows = await db
    .select({ serverId: agentServers.serverId })
    .from(agentServers)
    .where(eq(agentServers.agentId, agentId))
    .orderBy(asc(agentServers.serverId));
  return rows.map((row) => row.serverId);
}

export async function getPublishedSkillIds(db: DbHandle, skillIds: string[]): Promise<Set<string>> {
  if (skillIds.length === 0) return new Set();
  const rows = await db
    .select({ id: skills.id })
    .from(skills)
    .where(and(inArray(skills.id, skillIds), eq(skills.status, 'published')));
  return new Set(rows.map((row) => row.id));
}

export async function getAgentSkillIds(db: DbHandle, agentId: string): Promise<string[]> {
  const rows = await db
    .select({ skillId: agentSkills.skillId })
    .from(agentSkills)
    .where(eq(agentSkills.agentId, agentId))
    .orderBy(asc(agentSkills.skillId));
  return rows.map((row) => row.skillId);
}

/** 某 agent 的直接子智能体（含已停用的，供预览/管理）。 */
export async function listSubAgents(db: Database, agentId: string): Promise<AgentRow[]> {
  return db.select().from(agents).where(eq(agents.parentId, agentId)).orderBy(asc(agents.id));
}

export async function getAgentSubAgentIds(db: DbHandle, agentId: string): Promise<string[]> {
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

export type BoundResourceKind = 'skill' | 'server' | 'plugin' | 'runtime_environment';

export async function getResourceOwners(
  db: DbHandle,
  kind: BoundResourceKind,
  ids: string[],
): Promise<Array<{ id: string; ownerBusinessId: string | null }>> {
  if (ids.length === 0) return [];
  switch (kind) {
    case 'skill':
      return db
        .select({ id: skills.id, ownerBusinessId: skills.ownerBusinessId })
        .from(skills)
        .where(inArray(skills.id, ids));
    case 'server':
      return db
        .select({ id: servers.id, ownerBusinessId: servers.ownerBusinessId })
        .from(servers)
        .where(inArray(servers.id, ids));
    case 'plugin':
      return db
        .select({ id: plugins.id, ownerBusinessId: plugins.ownerBusinessId })
        .from(plugins)
        .where(inArray(plugins.id, ids));
    case 'runtime_environment':
      return db
        .select({
          id: runtimeEnvironments.id,
          ownerBusinessId: runtimeEnvironments.ownerBusinessId,
        })
        .from(runtimeEnvironments)
        .where(inArray(runtimeEnvironments.id, ids));
  }
}

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
    .where(and(inArray(agentSkills.agentId, agentIds), eq(skills.status, 'published')))
    .orderBy(asc(agentSkills.agentId), asc(skills.slug));
  for (const row of rows) {
    const list = out.get(row.agentId);
    if (list) list.push(row.skill);
    else out.set(row.agentId, [row.skill]);
  }
  return out;
}

export async function loadLiveDefinition(
  db: DbHandle,
  agentId: string,
): Promise<AgentDefinition | null> {
  const row = await getAgent(db, agentId);
  if (!row) return null;
  const [
    serverRows,
    skillRows,
    pluginRows,
    subAgentRows,
    rules,
    outputStyles,
    workflows,
    hookFiles,
    environments,
  ] = await Promise.all([
    db
      .select({
        id: servers.id,
        name: servers.name,
        kind: servers.kind,
        config: servers.config,
        secretsEncrypted: servers.secretsEncrypted,
        updatedAt: servers.updatedAt,
      })
      .from(agentServers)
      .innerJoin(servers, eq(agentServers.serverId, servers.id))
      .where(eq(agentServers.agentId, agentId))
      .orderBy(asc(servers.id)),
    db
      .select(getTableColumns(skills))
      .from(agentSkills)
      .innerJoin(skills, eq(agentSkills.skillId, skills.id))
      .where(and(eq(agentSkills.agentId, agentId), eq(skills.status, 'published')))
      .orderBy(asc(skills.id)),
    db
      .select({
        ...getTableColumns(plugins),
        allowHooks: agentPlugins.allowHooks,
        allowMcp: agentPlugins.allowMcp,
      })
      .from(agentPlugins)
      .innerJoin(plugins, eq(agentPlugins.pluginId, plugins.id))
      .where(eq(agentPlugins.agentId, agentId))
      .orderBy(asc(plugins.id)),
    db
      .select({
        id: agents.id,
        name: agents.name,
        updatedAt: agents.updatedAt,
        publishedVersion: agents.publishedVersion,
      })
      .from(agents)
      .where(eq(agents.parentId, agentId))
      .orderBy(asc(agents.id)),
    db
      .select()
      .from(agentRules)
      .where(eq(agentRules.agentId, agentId))
      .orderBy(asc(agentRules.slug)),
    db
      .select()
      .from(agentOutputStyles)
      .where(eq(agentOutputStyles.agentId, agentId))
      .orderBy(asc(agentOutputStyles.slug)),
    db
      .select()
      .from(agentWorkflows)
      .where(eq(agentWorkflows.agentId, agentId))
      .orderBy(asc(agentWorkflows.slug)),
    db
      .select()
      .from(agentHookFiles)
      .where(eq(agentHookFiles.agentId, agentId))
      .orderBy(asc(agentHookFiles.path)),
    db
      .select({
        id: runtimeEnvironments.id,
        name: runtimeEnvironments.name,
        versionId: runtimeEnvironments.onlineVersionId,
      })
      .from(runtimeEnvironments)
      .where(
        row.runtimeEnvironmentId === null
          ? eq(runtimeEnvironments.isDefault, true)
          : eq(runtimeEnvironments.id, row.runtimeEnvironmentId),
      ),
  ]);
  const generatedServerIds = serverRows
    .filter((item) => item.kind === 'generated')
    .map((item) => item.id);
  const [skillFileMap, pluginFileMap, toolRows] = await Promise.all([
    getSkillFilesBySkillIds(
      db,
      skillRows.map((item) => item.id),
    ),
    getPluginFilesByPluginIds(
      db,
      pluginRows.map((item) => item.id),
    ),
    generatedServerIds.length === 0
      ? []
      : db
          .select()
          .from(apiTools)
          .where(inArray(apiTools.serverId, generatedServerIds))
          .orderBy(asc(apiTools.createdAt), asc(apiTools.id)),
  ]);
  const toolsByServer = Object.groupBy(
    toolRows.map((item) =>
      apiToolSchema.parse({ ...item, createdAt: item.createdAt.toISOString() }),
    ),
    (item) => item.serverId,
  );
  return {
    agent: {
      ...toAgent(
        row,
        serverRows.map((item) => item.id),
        skillRows.map((item) => item.id),
        subAgentRows.map((item) => item.id),
        pluginRows.map((item) => ({
          pluginId: item.id,
          allowHooks: item.allowHooks,
          allowMcp: item.allowMcp,
        })),
      ),
      hasDraft: false,
    },
    rules: rules.map((item) => ({
      ...item,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    })),
    outputStyles: outputStyles.map((item) => ({
      ...item,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    })),
    workflows: workflows.map((item) => ({
      ...item,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    })),
    hooks: {
      enabled: row.hooksEnabled,
      config: row.hooksConfig,
      files: hookFiles.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      })),
    },
    memoryPolicy: resolveMemoryPolicy(row.memoryPolicy),
    resources: {
      servers: serverRows.map((item) => ({
        ...item,
        updatedAt: item.updatedAt.toISOString(),
        ...(item.kind === 'generated' ? { tools: toolsByServer[item.id] ?? [] } : {}),
      })),
      skills: skillRows.map((item) => ({
        ...toSkillDefinition(item),
        id: item.id,
        sourceId: item.sourceId,
        status: item.status,
        submittedAt: item.submittedAt?.toISOString() ?? null,
        reviewedAt: item.reviewedAt?.toISOString() ?? null,
        reviewedBy: item.reviewedBy,
        reviewNote: item.reviewNote,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
        files: (skillFileMap.get(item.id) ?? []).map(({ path, content }) => ({ path, content })),
      })),
      plugins: pluginRows.map((item) => ({
        id: item.id,
        slug: item.slug,
        runtimeName: item.runtimeName,
        name: item.name,
        description: item.description,
        version: item.version,
        capabilities: pluginInputSchema.shape.capabilities.parse(item.manifest),
        sourceId: item.sourceId,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
        files: (pluginFileMap.get(item.id) ?? []).map(({ path, content, executable }) => ({
          path,
          content,
          executable,
        })),
      })),
      subAgents: subAgentRows.map((item) => ({ ...item, updatedAt: item.updatedAt.toISOString() })),
      runtimeEnvironment: environments[0] ?? null,
    },
  };
}
