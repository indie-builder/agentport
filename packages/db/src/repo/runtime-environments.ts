import { AppError } from '@agentport/core';
import {
  DEFAULT_RUNTIME_DOCKERFILE,
  DEFAULT_RUNTIME_ENVIRONMENT_NAME,
  type ResolvedRuntimeEnvironment,
  type RuntimeEnvironment,
  type RuntimeEnvironmentInput,
  type RuntimeEnvironmentPatch,
  type RuntimeEnvironmentVersion,
  type RuntimeEnvironmentVersionSummary,
} from '@agentport/shared';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { agents, runtimeEnvironments, runtimeEnvironmentVersions } from '../schema.js';
import type { Tx } from './agent-versions.js';

export type RuntimeEnvironmentRow = typeof runtimeEnvironments.$inferSelect;
export type RuntimeEnvironmentVersionRow = typeof runtimeEnvironmentVersions.$inferSelect;

/** 构建日志上限（字符，64 KiB）；超出后只保留尾部并置 logTruncated。 */
export const RUNTIME_ENVIRONMENT_BUILD_LOG_LIMIT = 64 * 1024;

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

export function toRuntimeEnvironmentVersion(
  row: RuntimeEnvironmentVersionRow,
): RuntimeEnvironmentVersion {
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

function isPgCode(err: unknown, code: string): boolean {
  let cause: unknown = err;
  for (let depth = 0; depth < 5 && typeof cause === 'object' && cause !== null; depth += 1) {
    if ('code' in cause && cause.code === code) return true;
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return false;
}

/** 名称冲突统一成 409；其他错误原样抛出。 */
function rethrowNameConflict(err: unknown): never {
  if (isPgCode(err, '23505')) {
    throw new AppError('CONFLICT', '运行环境名称已被占用，请换一个');
  }
  throw err;
}

export async function listRuntimeEnvironments(db: Database): Promise<RuntimeEnvironment[]> {
  const rows = await db
    .select()
    .from(runtimeEnvironments)
    .orderBy(
      desc(runtimeEnvironments.isDefault),
      asc(runtimeEnvironments.createdAt),
      asc(runtimeEnvironments.id),
    );
  return rows.map(toRuntimeEnvironment);
}

async function getRow(db: Database | Tx, id: string): Promise<RuntimeEnvironmentRow | null> {
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
  const row = await getRow(db, id);
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
): Promise<RuntimeEnvironment> {
  try {
    const [row] = await db
      .insert(runtimeEnvironments)
      .values({ id: newId('runtimeEnvironment'), name: input.name, dockerfile: input.dockerfile })
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

/**
 * 删除环境连同其全部版本。默认环境、仍被智能体绑定、仍在构建时拒绝；
 * 并在同一事务里先清空线上指针再删版本，避免复合外键互相阻塞。
 * 并发绑定的窗口由 agents 上的 RESTRICT 外键兜底。
 */
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

/**
 * worker 首次启动登记平台基座默认环境。默认环境已存在时原样返回：
 * 不因 SANDBOX_IMAGE 变化推进线上指针，也不覆盖用户发布/回退过的版本。
 */
export async function ensureDefaultRuntimeEnvironment(
  db: Database,
  input: { imageTag: string; imageId: string },
): Promise<RuntimeEnvironment> {
  return db.transaction(async (tx) => {
    // 多 worker 同时启动只允许一个建默认环境；行级唯一索引是最后兜底。
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

/** 详情（含冻结 Dockerfile 与完整构建日志）；版本必须属于该环境。 */
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

/** 崩溃恢复只需要的窄形状；时间保持 Date，null 表示从未开始。 */
export interface PendingRuntimeEnvironmentBuild {
  id: string;
  status: 'queued' | 'building';
  createdAt: Date;
  startedAt: Date | null;
}

/** 对账入口：只返回 queued/building 版本，避免全量加载版本行。 */
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

/** 用环境当前 Dockerfile 入队一次新构建；环境不存在返回 null。 */
export async function enqueueRuntimeEnvironmentBuild(
  db: Database,
  environmentId: string,
  baseImageId: string,
): Promise<RuntimeEnvironmentVersion | null> {
  return db.transaction(async (tx) => {
    // 与删除环境的 FOR UPDATE 串行：要么入队先提交（删除时能看见 queued 版本并拒绝），
    // 要么删除先提交（这里读不到环境返回 null），不会出现刚入队就被连带删掉。
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

/** BullMQ 重复投递时只有抢到 queued → building 的 worker 执行。 */
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

/** 只对构建中的版本追加；超出上限保留尾部并标记截断。 */
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

/**
 * 构建成功时同时落库实际基座 image ID：入队冻结的是引用（tag），
 * 构建真正消费的内容身份只有这里知道，版本不能继续谎报入队 tag。
 */
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

/** 失败构建只改版本行，线上指针不动。 */
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

/** 发布/回退：只接受本环境的 ready 版本，只改线上指针。 */
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

/**
 * 创建容器时解析真实镜像。environmentId 为 null 表示默认环境。
 * 无线上版本、版本未就绪或镜像 ID 缺失时返回 null，由调用方明确报错；
 * 这里绝不回落到其他环境或基座镜像。
 */
export async function resolveOnlineRuntimeEnvironment(
  db: Database,
  environmentId: string | null,
): Promise<ResolvedRuntimeEnvironment | null> {
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
        eq(runtimeEnvironmentVersions.id, runtimeEnvironments.onlineVersionId),
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
