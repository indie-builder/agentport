import { AppError } from '@agentport/core';
import {
  ACTIVE_RUN_STATUSES,
  DEFAULT_RUNTIME_DOCKERFILE,
  DEFAULT_RUNTIME_ENVIRONMENT_NAME,
  type ResolvedRuntimeEnvironment,
  type ResourceAccessFilter,
  RUNTIME_ENVIRONMENT_BUILD_LOG_LIMIT,
  type RuntimeEnvironment,
  type RuntimeEnvironmentInput,
  type RuntimeEnvironmentPatch,
  type RuntimeEnvironmentVersion,
  type RuntimeEnvironmentVersionSummary,
} from '@agentport/shared';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  ne,
  notExists,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database, DbHandle } from '../client.js';
import { newId } from '../id.js';
import { agents, runtimeEnvironments, runtimeEnvironmentVersions } from '../schema.js';
import { resourceScopeWhere } from './access.js';
import { type CursorPage, paginate } from './pagination.js';
import { isPgCode } from './pg-errors.js';

export type RuntimeEnvironmentRow = typeof runtimeEnvironments.$inferSelect;
export type RuntimeEnvironmentVersionRow = typeof runtimeEnvironmentVersions.$inferSelect;

const DEFAULT_ENVIRONMENT_LOCK = 'agentport.runtime-environment-default';

export function toRuntimeEnvironment(row: RuntimeEnvironmentRow): RuntimeEnvironment {
  return {
    id: row.id,
    name: row.name,
    dockerfile: row.dockerfile,
    isDefault: row.isDefault,
    onlineVersionId: row.onlineVersionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRuntimeEnvironmentVersion(row: RuntimeEnvironmentVersionRow): RuntimeEnvironmentVersion {
  return {
    id: row.id,
    environmentId: row.environmentId,
    dockerfile: row.dockerfile,
    baseImageId: row.baseImageId,
    status: row.status,
    imageTag: row.imageTag,
    imageId: row.imageId,
    buildLog: row.buildLog,
    logTruncated: row.logTruncated,
    error: row.error,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toRuntimeEnvironmentVersionSummary(
  row: RuntimeEnvironmentVersionRow,
): RuntimeEnvironmentVersionSummary {
  const version = toRuntimeEnvironmentVersion(row);
  return {
    id: version.id,
    environmentId: version.environmentId,
    baseImageId: version.baseImageId,
    status: version.status,
    imageTag: version.imageTag,
    imageId: version.imageId,
    logTruncated: version.logTruncated,
    error: version.error,
    startedAt: version.startedAt,
    finishedAt: version.finishedAt,
    createdAt: version.createdAt,
  };
}

function rethrowNameConflict(err: unknown): never {
  if (isPgCode(err, '23505')) {
    throw new AppError('CONFLICT', '运行环境名称已被占用，请换一个');
  }
  throw err;
}

function afterEnvironment(anchor: { isDefault: boolean; createdAt: Date }, cursorId: string): SQL {
  return or(
    sql`${runtimeEnvironments.isDefault} < ${anchor.isDefault}`,
    and(
      eq(runtimeEnvironments.isDefault, anchor.isDefault),
      or(
        gt(runtimeEnvironments.createdAt, anchor.createdAt),
        and(
          eq(runtimeEnvironments.createdAt, anchor.createdAt),
          gt(runtimeEnvironments.id, cursorId),
        ),
      ),
    ),
  ) as SQL;
}

export async function listRuntimeEnvironmentPage(
  db: Database,
  options: {
    access?: ResourceAccessFilter | undefined;
    cursor?: string | undefined;
    limit: number;
  },
): Promise<CursorPage<RuntimeEnvironment> | null> {
  const scope =
    options.access === undefined
      ? undefined
      : resourceScopeWhere(
          options.access,
          runtimeEnvironments.id,
          runtimeEnvironments.ownerBusinessId,
        );
  const filters: SQL[] = scope === undefined ? [] : [scope];
  if (options.cursor?.includes('\u0000')) return null;
  if (options.cursor !== undefined) {
    const [anchor] = await db
      .select({
        isDefault: runtimeEnvironments.isDefault,
        createdAt: runtimeEnvironments.createdAt,
      })
      .from(runtimeEnvironments)
      .where(and(...filters, eq(runtimeEnvironments.id, options.cursor)))
      .limit(1);
    if (!anchor) return null;
    filters.push(afterEnvironment(anchor, options.cursor));
  }
  const rows = await db
    .select()
    .from(runtimeEnvironments)
    .where(and(...filters))
    .orderBy(
      desc(runtimeEnvironments.isDefault),
      asc(runtimeEnvironments.createdAt),
      asc(runtimeEnvironments.id),
    )
    .limit(options.limit + 1);
  return paginate(rows.map(toRuntimeEnvironment), options.limit);
}

export async function getRuntimeEnvironmentRow(
  db: DbHandle,
  id: string,
): Promise<RuntimeEnvironmentRow | null> {
  const [row] = await db
    .select()
    .from(runtimeEnvironments)
    .where(eq(runtimeEnvironments.id, id))
    .limit(1);
  return row ?? null;
}

export async function getRuntimeEnvironment(
  db: Database,
  id: string,
): Promise<RuntimeEnvironment | null> {
  const row = await getRuntimeEnvironmentRow(db, id);
  return row === null ? null : toRuntimeEnvironment(row);
}

export async function getRuntimeEnvironmentByName(
  db: Database,
  name: string,
): Promise<RuntimeEnvironment | null> {
  const [row] = await db
    .select()
    .from(runtimeEnvironments)
    .where(eq(runtimeEnvironments.name, name))
    .limit(1);
  return row === undefined ? null : toRuntimeEnvironment(row);
}

export async function getDefaultRuntimeEnvironment(
  db: Database,
): Promise<RuntimeEnvironment | null> {
  const [row] = await db
    .select()
    .from(runtimeEnvironments)
    .where(eq(runtimeEnvironments.isDefault, true))
    .limit(1);
  return row === undefined ? null : toRuntimeEnvironment(row);
}

export async function createRuntimeEnvironment(
  db: Database,
  input: RuntimeEnvironmentInput,
  ownerBusinessId: string,
): Promise<RuntimeEnvironment> {
  try {
    const [row] = await db
      .insert(runtimeEnvironments)
      .values({
        id: newId('runtimeEnvironment'),
        name: input.name,
        dockerfile: input.dockerfile,
        ownerBusinessId,
      })
      .returning();
    if (!row) throw new Error('runtime environment insert returned no row');
    return toRuntimeEnvironment(row);
  } catch (err) {
    rethrowNameConflict(err);
  }
}

export async function updateRuntimeEnvironment(
  db: Database,
  id: string,
  patch: RuntimeEnvironmentPatch,
): Promise<RuntimeEnvironment | null> {
  try {
    const [row] = await db
      .update(runtimeEnvironments)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(runtimeEnvironments.id, id))
      .returning();
    return row === undefined ? null : toRuntimeEnvironment(row);
  } catch (err) {
    rethrowNameConflict(err);
  }
}

async function hasFixedEnvironmentReferences(db: DbHandle, id: string): Promise<boolean> {
  const result = await db.execute<{ blocked: boolean }>(sql`
    select exists (
      select 1
      from agents p
      join agent_versions v on v.agent_id = p.id and v.version = p.published_version
      where v.definition->'resources'->'runtimeEnvironment'->>'id' = ${id}
      union all
      select 1
      from agent_runs r
      left join agent_versions av
        on av.agent_id = r.agent_id and av.version = r.agent_version
      where r.status in (${sql.join(
        ACTIVE_RUN_STATUSES.map((status) => sql`${status}`),
        sql`, `,
      )})
        and (
          r.runtime_environment_id = ${id}
          or coalesce(r.definition_snapshot, av.definition)->'resources'->'runtimeEnvironment'->>'id' = ${id}
        )
      union all
      select 1
      from eval_runs e
      where e.status = 'running'
        and e.definition_snapshot->'resources'->'runtimeEnvironment'->>'id' = ${id}
    ) as "blocked"
  `);
  return result[0]?.blocked === true;
}

export async function deleteRuntimeEnvironment(db: Database, id: string): Promise<boolean> {
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(runtimeEnvironments)
        .where(eq(runtimeEnvironments.id, id))
        .limit(1)
        .for('update');
      if (!row) return false;
      if (row.isDefault) {
        throw new AppError('CONFLICT', '默认运行环境不能删除');
      }
      const [bound] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.runtimeEnvironmentId, id))
        .limit(1);
      if (bound) {
        throw new AppError('CONFLICT', '运行环境仍被智能体绑定，请先解除绑定');
      }
      if (await hasFixedEnvironmentReferences(tx, id)) {
        throw new AppError(
          'CONFLICT',
          '运行环境仍被已发布定义或运行中的任务引用，请先切换并重新发布相关专家',
        );
      }
      const [busy] = await tx
        .select({ id: runtimeEnvironmentVersions.id })
        .from(runtimeEnvironmentVersions)
        .where(
          and(
            eq(runtimeEnvironmentVersions.environmentId, id),
            inArray(runtimeEnvironmentVersions.status, ['queued', 'building']),
          ),
        )
        .limit(1);
      if (busy) {
        throw new AppError('CONFLICT', '运行环境仍有排队或构建中的版本，请等待构建结束');
      }
      await tx
        .update(runtimeEnvironments)
        .set({ onlineVersionId: null })
        .where(eq(runtimeEnvironments.id, id));
      await tx
        .delete(runtimeEnvironmentVersions)
        .where(eq(runtimeEnvironmentVersions.environmentId, id));
      await tx.delete(runtimeEnvironments).where(eq(runtimeEnvironments.id, id));
      return true;
    });
  } catch (err) {
    if (isPgCode(err, '23503')) {
      throw new AppError('CONFLICT', '运行环境正被智能体绑定，请先解除绑定');
    }
    throw err;
  }
}

export async function ensureDefaultRuntimeEnvironment(
  db: Database,
  input: { imageTag: string; imageId: string },
): Promise<RuntimeEnvironment> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${DEFAULT_ENVIRONMENT_LOCK}))`);
    const [existing] = await tx
      .select()
      .from(runtimeEnvironments)
      .where(eq(runtimeEnvironments.isDefault, true))
      .limit(1);
    if (existing) return toRuntimeEnvironment(existing);

    const environmentId = newId('runtimeEnvironment');
    const versionId = newId('runtimeEnvironmentVersion');
    const now = new Date();
    await tx.insert(runtimeEnvironments).values({
      id: environmentId,
      name: DEFAULT_RUNTIME_ENVIRONMENT_NAME,
      dockerfile: DEFAULT_RUNTIME_DOCKERFILE,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(runtimeEnvironmentVersions).values({
      id: versionId,
      environmentId,
      dockerfile: DEFAULT_RUNTIME_DOCKERFILE,
      baseImageId: input.imageId,
      status: 'ready',
      imageTag: input.imageTag,
      imageId: input.imageId,
      buildLog: '',
      startedAt: now,
      finishedAt: now,
      createdAt: now,
    });
    const [row] = await tx
      .update(runtimeEnvironments)
      .set({ onlineVersionId: versionId })
      .where(eq(runtimeEnvironments.id, environmentId))
      .returning();
    if (!row) throw new Error('default runtime environment update returned no row');
    return toRuntimeEnvironment(row);
  });
}

export async function listRuntimeEnvironmentVersions(
  db: Database,
  environmentId: string,
): Promise<RuntimeEnvironmentVersionSummary[]> {
  const rows = await db
    .select()
    .from(runtimeEnvironmentVersions)
    .where(eq(runtimeEnvironmentVersions.environmentId, environmentId))
    .orderBy(desc(runtimeEnvironmentVersions.createdAt), desc(runtimeEnvironmentVersions.id));
  return rows.map(toRuntimeEnvironmentVersionSummary);
}

export async function getRuntimeEnvironmentVersion(
  db: Database,
  environmentId: string,
  versionId: string,
): Promise<RuntimeEnvironmentVersion | null> {
  const [row] = await db
    .select()
    .from(runtimeEnvironmentVersions)
    .where(
      and(
        eq(runtimeEnvironmentVersions.id, versionId),
        eq(runtimeEnvironmentVersions.environmentId, environmentId),
      ),
    )
    .limit(1);
  return row === undefined ? null : toRuntimeEnvironmentVersion(row);
}

export interface PendingRuntimeEnvironmentBuild {
  id: string;
  status: 'queued' | 'building';
  createdAt: Date;
  startedAt: Date | null;
}

export async function listPendingRuntimeEnvironmentBuilds(
  db: Database,
): Promise<PendingRuntimeEnvironmentBuild[]> {
  const rows = await db
    .select({
      id: runtimeEnvironmentVersions.id,
      status: runtimeEnvironmentVersions.status,
      createdAt: runtimeEnvironmentVersions.createdAt,
      startedAt: runtimeEnvironmentVersions.startedAt,
    })
    .from(runtimeEnvironmentVersions)
    .where(inArray(runtimeEnvironmentVersions.status, ['queued', 'building']))
    .orderBy(asc(runtimeEnvironmentVersions.createdAt), asc(runtimeEnvironmentVersions.id));
  return rows.flatMap((row): PendingRuntimeEnvironmentBuild[] =>
    row.status === 'queued' || row.status === 'building'
      ? [{ id: row.id, status: row.status, createdAt: row.createdAt, startedAt: row.startedAt }]
      : [],
  );
}

export async function enqueueRuntimeEnvironmentBuild(
  db: Database,
  environmentId: string,
  baseImageId: string,
): Promise<RuntimeEnvironmentVersion | null> {
  return db.transaction(async (tx) => {
    const [environment] = await tx
      .select()
      .from(runtimeEnvironments)
      .where(eq(runtimeEnvironments.id, environmentId))
      .limit(1)
      .for('share');
    if (!environment) return null;
    const [row] = await tx
      .insert(runtimeEnvironmentVersions)
      .values({
        id: newId('runtimeEnvironmentVersion'),
        environmentId,
        dockerfile: environment.dockerfile,
        baseImageId,
      })
      .returning();
    return row === undefined ? null : toRuntimeEnvironmentVersion(row);
  });
}

export async function claimRuntimeEnvironmentBuild(
  db: Database,
  versionId: string,
): Promise<RuntimeEnvironmentVersion | null> {
  const [row] = await db
    .update(runtimeEnvironmentVersions)
    .set({ status: 'building', startedAt: new Date(), finishedAt: null, error: null })
    .where(
      and(
        eq(runtimeEnvironmentVersions.id, versionId),
        eq(runtimeEnvironmentVersions.status, 'queued'),
      ),
    )
    .returning();
  return row === undefined ? null : toRuntimeEnvironmentVersion(row);
}

export async function appendRuntimeEnvironmentBuildLog(
  db: Database,
  versionId: string,
  chunk: string,
): Promise<void> {
  if (chunk === '') return;
  await db
    .update(runtimeEnvironmentVersions)
    .set({
      buildLog: sql`right(${runtimeEnvironmentVersions.buildLog} || ${chunk}, ${RUNTIME_ENVIRONMENT_BUILD_LOG_LIMIT})`,
      logTruncated: sql`${runtimeEnvironmentVersions.logTruncated} or length(${runtimeEnvironmentVersions.buildLog} || ${chunk}) > ${RUNTIME_ENVIRONMENT_BUILD_LOG_LIMIT}`,
    })
    .where(
      and(
        eq(runtimeEnvironmentVersions.id, versionId),
        eq(runtimeEnvironmentVersions.status, 'building'),
      ),
    );
}

export async function completeRuntimeEnvironmentBuild(
  db: Database,
  versionId: string,
  image: { imageTag: string; imageId: string; baseImageId: string },
): Promise<RuntimeEnvironmentVersion | null> {
  const [row] = await db
    .update(runtimeEnvironmentVersions)
    .set({
      status: 'ready',
      imageTag: image.imageTag,
      imageId: image.imageId,
      baseImageId: image.baseImageId,
      error: null,
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(runtimeEnvironmentVersions.id, versionId),
        eq(runtimeEnvironmentVersions.status, 'building'),
      ),
    )
    .returning();
  return row === undefined ? null : toRuntimeEnvironmentVersion(row);
}

export async function failRuntimeEnvironmentBuild(
  db: Database,
  versionId: string,
  error: string,
): Promise<RuntimeEnvironmentVersion | null> {
  const [row] = await db
    .update(runtimeEnvironmentVersions)
    .set({ status: 'failed', error, finishedAt: new Date() })
    .where(
      and(
        eq(runtimeEnvironmentVersions.id, versionId),
        inArray(runtimeEnvironmentVersions.status, ['queued', 'building']),
      ),
    )
    .returning();
  return row === undefined ? null : toRuntimeEnvironmentVersion(row);
}

export async function publishRuntimeEnvironmentVersion(
  db: Database,
  environmentId: string,
  versionId: string,
): Promise<RuntimeEnvironment | null> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: runtimeEnvironments.id })
      .from(runtimeEnvironments)
      .where(eq(runtimeEnvironments.id, environmentId))
      .limit(1)
      .for('update');
    if (!locked) return null;
    const [version] = await tx
      .select({ id: runtimeEnvironmentVersions.id, status: runtimeEnvironmentVersions.status })
      .from(runtimeEnvironmentVersions)
      .where(
        and(
          eq(runtimeEnvironmentVersions.id, versionId),
          eq(runtimeEnvironmentVersions.environmentId, environmentId),
        ),
      )
      .limit(1);
    if (!version) {
      throw new AppError('NOT_FOUND', '该版本不属于当前运行环境');
    }
    if (version.status !== 'ready') {
      throw new AppError('CONFLICT', '只有构建完成的版本才能设为线上版本');
    }
    const [row] = await tx
      .update(runtimeEnvironments)
      .set({ onlineVersionId: versionId, updatedAt: new Date() })
      .where(eq(runtimeEnvironments.id, environmentId))
      .returning();
    return row === undefined ? null : toRuntimeEnvironment(row);
  });
}

export async function resolveOnlineRuntimeEnvironment(
  db: Database,
  environmentId: string | null,
  versionId?: string | null,
): Promise<ResolvedRuntimeEnvironment | null> {
  if (versionId === null) return null;
  const [row] = await db
    .select({
      environmentId: runtimeEnvironments.id,
      environmentName: runtimeEnvironments.name,
      versionId: runtimeEnvironmentVersions.id,
      imageId: runtimeEnvironmentVersions.imageId,
    })
    .from(runtimeEnvironments)
    .innerJoin(
      runtimeEnvironmentVersions,
      and(
        versionId === undefined
          ? eq(runtimeEnvironmentVersions.id, runtimeEnvironments.onlineVersionId)
          : eq(runtimeEnvironmentVersions.id, versionId),
        eq(runtimeEnvironmentVersions.environmentId, runtimeEnvironments.id),
      ),
    )
    .where(
      and(
        environmentId === null
          ? eq(runtimeEnvironments.isDefault, true)
          : eq(runtimeEnvironments.id, environmentId),
        eq(runtimeEnvironmentVersions.status, 'ready'),
        isNotNull(runtimeEnvironmentVersions.imageId),
        ne(runtimeEnvironmentVersions.imageId, ''),
      ),
    )
    .limit(1);
  if (!row || row.imageId === null) return null;
  return {
    environmentId: row.environmentId,
    environmentName: row.environmentName,
    versionId: row.versionId,
    imageId: row.imageId,
  };
}

export interface StaleOnlineRuntimeEnvironment {
  environmentId: string;
  environmentName: string;
  onlineVersionId: string;
  onlineBaseImageId: string;
}

export async function listStaleOnlineRuntimeEnvironments(
  db: Database,
  currentBaseImageId: string,
  sandboxImage: string,
): Promise<StaleOnlineRuntimeEnvironment[]> {
  const online = alias(runtimeEnvironmentVersions, 'online_version');
  const attempted = alias(runtimeEnvironmentVersions, 'attempted_version');
  const baseCandidates =
    currentBaseImageId === sandboxImage ? [currentBaseImageId] : [currentBaseImageId, sandboxImage];
  const blockingAttempt = db
    .select({ id: attempted.id })
    .from(attempted)
    .where(
      and(
        eq(attempted.environmentId, runtimeEnvironments.id),
        or(
          and(
            inArray(attempted.baseImageId, baseCandidates),
            inArray(attempted.status, ['queued', 'building']),
          ),
          and(
            eq(attempted.baseImageId, currentBaseImageId),
            eq(attempted.status, 'failed'),
            eq(attempted.dockerfile, runtimeEnvironments.dockerfile),
          ),
        ),
      ),
    );
  return db
    .select({
      environmentId: runtimeEnvironments.id,
      environmentName: runtimeEnvironments.name,
      onlineVersionId: online.id,
      onlineBaseImageId: online.baseImageId,
    })
    .from(runtimeEnvironments)
    .innerJoin(
      online,
      and(
        eq(online.id, runtimeEnvironments.onlineVersionId),
        eq(online.environmentId, runtimeEnvironments.id),
      ),
    )
    .where(
      and(
        eq(online.status, 'ready'),
        ne(online.baseImageId, currentBaseImageId),
        notExists(blockingAttempt),
      ),
    )
    .orderBy(asc(runtimeEnvironments.createdAt), asc(runtimeEnvironments.id));
}

export async function publishRuntimeEnvironmentVersionIfOnlineMatches(
  db: Database,
  environmentId: string,
  versionId: string,
  expectedOnlineVersionId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ onlineVersionId: runtimeEnvironments.onlineVersionId })
      .from(runtimeEnvironments)
      .where(eq(runtimeEnvironments.id, environmentId))
      .limit(1)
      .for('update');
    if (!locked || locked.onlineVersionId !== expectedOnlineVersionId) return false;
    const [version] = await tx
      .select({ status: runtimeEnvironmentVersions.status })
      .from(runtimeEnvironmentVersions)
      .where(
        and(
          eq(runtimeEnvironmentVersions.id, versionId),
          eq(runtimeEnvironmentVersions.environmentId, environmentId),
        ),
      )
      .limit(1);
    if (version?.status !== 'ready') return false;
    const updated = await tx
      .update(runtimeEnvironments)
      .set({ onlineVersionId: versionId, updatedAt: new Date() })
      .where(eq(runtimeEnvironments.id, environmentId))
      .returning({ id: runtimeEnvironments.id });
    return updated.length > 0;
  });
}
