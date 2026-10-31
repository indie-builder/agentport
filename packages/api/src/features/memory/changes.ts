import { fail } from '@agentport/core';
import { type Database, type DbPool, repo, schema } from '@agentport/db';
import {
  type MemoryChange,
  type MemoryContentSnapshot,
  type MemoryReviewTarget,
  memoryChangeSchema,
  memoryReviewTargetSchema,
  slugSchema,
} from '@agentport/shared';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { typed } from '../../types.js';
import { authorizeObject, userPrincipal } from '../access.js';
import {
  deleteMemoryFile,
  memoryFileNamePattern,
  readMemoryFile,
  readMemoryFileBytes,
  restoreMemoryFile,
  writeMemoryFile,
} from '../agents/memory-files.js';
import {
  type AgentMemoryTarget,
  deleteMemoryJournal,
  findMemoryJournalForTarget,
  memorySha256,
  readMemoryJournal,
  writeMemoryJournal,
} from './journal.js';
import {
  type MemoryWriteLogger,
  readPersonalMemory,
  writePersonalMemoryLocked,
} from './personal.js';

const versionsQuery = z.object({
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const versionsResponseSchema = z.object({ items: z.array(memoryChangeSchema) });
const agentParams = z.object({ id: z.string().min(1) });
const memoryVersionParams = agentParams.extend({
  name: z.string().regex(memoryFileNamePattern, '记忆文件名非法：只允许 <name>.md'),
});
const ruleVersionParams = agentParams.extend({ slug: slugSchema });
const changeParams = z.object({ id: z.string().min(1) });

async function agentSlug(db: Database, agentId: string): Promise<string> {
  const [row] = await db
    .select({ slug: schema.agents.slug })
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .limit(1);
  if (!row) fail('AGENT_NOT_FOUND', '智能体不存在，可能已被删除；请刷新后重新选择');
  return row.slug;
}

/**
 * 采纳/回滚会覆盖工作区文件或规则，目标专家不能还有在跑的运行。
 * 一次 parent 运行也占用其 enabled 直接子级的记忆；审核 run 不挂可写目录，不算占用。
 */
export async function assertNoActiveRun(db: Database, agentId: string): Promise<void> {
  const [target] = await db
    .select({ enabled: schema.agents.enabled, parentId: schema.agents.parentId })
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .limit(1);
  const occupied = [agentId];
  if (target?.enabled && target.parentId !== null) occupied.push(target.parentId);
  const [active] = await db
    .select({ id: schema.agentRuns.id })
    .from(schema.agentRuns)
    .where(
      and(
        inArray(schema.agentRuns.agentId, occupied),
        inArray(schema.agentRuns.status, ['queued', 'running']),
        ne(schema.agentRuns.trigger, 'review'),
      ),
    )
    .limit(1);
  if (active) {
    fail('CONFLICT', '该专家或其发起中的父专家仍有运行未结束，请等待完成或取消后再修改记忆');
  }
}

export interface MemoryTargetState {
  content: string | null;
  globs: string | null;
  /** 仅个人记忆使用：写入时作为乐观锁版本号。 */
  revision?: number;
}

/** 三类目标当前内容的唯一读取口径。 */
export async function readMemoryTarget(
  db: Database,
  workspacesDir: string,
  target: MemoryReviewTarget,
  businessId: string,
): Promise<MemoryTargetState> {
  if (target.kind === 'personal') {
    const memory = await readPersonalMemory(db, businessId);
    return { content: memory.content, globs: null, revision: memory.revision };
  }
  const slug = await agentSlug(db, target.agentId);
  if (target.kind === 'agent_memory') {
    const file = await readMemoryFile(workspacesDir, slug, 'MEMORY.md');
    return { content: file?.content ?? null, globs: null };
  }
  const [rule] = await db
    .select({ content: schema.agentRules.content, globs: schema.agentRules.globs })
    .from(schema.agentRules)
    .where(
      and(eq(schema.agentRules.agentId, target.agentId), eq(schema.agentRules.slug, target.slug)),
    )
    .limit(1);
  return { content: rule?.content ?? null, globs: rule?.globs ?? '' };
}

/** 比较时把「缺失规则的 globs」按空字符串处理，与审核快照同一表示。 */
function sameSnapshot(current: MemoryContentSnapshot, expected: MemoryContentSnapshot): boolean {
  return current.content === expected.content && (current.globs ?? '') === (expected.globs ?? '');
}

function snapshotOf(state: MemoryTargetState, target: MemoryReviewTarget): MemoryContentSnapshot {
  return {
    content: state.content,
    globs: target.kind === 'agent_rule' ? state.globs : null,
  };
}

/** 整段记忆写入（检查、文件/规则、账本、审核决定）共用同一把目标会话锁。 */
export function withMemoryTargetLock<T>(
  pool: DbPool,
  target: MemoryReviewTarget,
  businessId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return repo.locks.withAdvisoryLock(pool, repo.locks.memoryTargetLockKey(target, businessId), fn);
}

export interface WriteMemoryTargetInput {
  workspacesDir: string;
  businessId: string;
  target: MemoryReviewTarget;
  /** 审核/回滚要求目标仍是该快照；手工编辑不传，按锁内当前内容记录 before。 */
  before?: MemoryContentSnapshot;
  after: MemoryContentSnapshot;
  sourceReviewRunId?: string | null;
  reversesChangeId?: string | null;
  logger?: MemoryWriteLogger;
}

async function writeProjection(
  db: Database,
  workspacesDir: string,
  slug: string,
  target: Exclude<MemoryReviewTarget, { kind: 'personal' }>,
  after: MemoryContentSnapshot,
): Promise<void> {
  if (target.kind === 'agent_memory') {
    if (after.content === null) {
      await deleteMemoryFile(workspacesDir, slug, 'MEMORY.md');
    } else {
      await writeMemoryFile(workspacesDir, slug, 'MEMORY.md', after.content);
    }
    return;
  }
  if (after.content === null) {
    await repo.rules.deleteRule(db, target.agentId, target.slug);
  } else {
    await repo.rules.upsertRule(db, target.agentId, {
      slug: target.slug,
      content: after.content,
      globs: after.globs ?? '',
    });
  }
}

async function insertChange(
  db: Database,
  input: WriteMemoryTargetInput,
  agentId: string | null,
  before: MemoryContentSnapshot,
): Promise<repo.memoryChanges.MemoryChangeRow> {
  const change = await repo.memoryChanges.insert(db, {
    businessId: input.businessId,
    agentId,
    target: input.target,
    before,
    after: input.after,
    sourceReviewRunId: input.sourceReviewRunId ?? null,
    reversesChangeId: input.reversesChangeId ?? null,
  });
  if (input.sourceReviewRunId) {
    const decided = await repo.memoryReviews.updateDecisionIfPending(
      db,
      input.sourceReviewRunId,
      'applied',
      change.id,
    );
    // 锁内不应再有人改决定；走到这里说明数据被外部改写，回滚事务。
    if (!decided) throw new Error('review decision changed under memory lock');
  }
  return change;
}

async function discardJournalQuietly(input: WriteMemoryTargetInput, slug: string): Promise<void> {
  if (!input.sourceReviewRunId) return;
  try {
    await deleteMemoryJournal(input.workspacesDir, slug, input.sourceReviewRunId);
  } catch (error) {
    input.logger?.warn({ err: error }, 'failed to remove memory write journal');
  }
}

/** 审核已 applied 时日志只剩清理价值；删除失败不能影响已提交的结果。 */
export async function discardReviewWriteJournal(
  db: Database,
  workspacesDir: string,
  review: { runId: string; target: MemoryReviewTarget },
  logger?: MemoryWriteLogger,
): Promise<void> {
  if (review.target.kind !== 'agent_memory') return;
  try {
    const slug = await agentSlug(db, review.target.agentId);
    await deleteMemoryJournal(workspacesDir, slug, review.runId);
  } catch (error) {
    logger?.warn({ err: error }, 'failed to remove settled memory write journal');
  }
}

/**
 * 拒绝前的显式证据检查：文件仍等于日志记录的基线说明上次写入从未落盘，
 * 日志可直接丢弃；否则文件可能已生效，不能把审核改成 rejected。
 */
export async function assertNoPendingReviewWrite(
  db: Database,
  workspacesDir: string,
  review: { runId: string; target: MemoryReviewTarget; businessId: string },
): Promise<void> {
  const target = review.target;
  if (target.kind !== 'agent_memory') return;
  const slug = await agentSlug(db, target.agentId);
  const journal = await readMemoryJournal(workspacesDir, slug, review.runId, target);
  if (!journal) return;
  const current = snapshotOf(
    await readMemoryTarget(db, workspacesDir, target, review.businessId),
    target,
  );
  if (memorySha256(current.content) !== journal.beforeSha256) {
    fail('CONFLICT', '目标写入未完成，请先重试采用或重新生成');
  }
  await deleteMemoryJournal(workspacesDir, slug, review.runId);
}

/** 手工保存同内容：最近一次已应用变更的 after 与当前一致才不重复记账。 */
async function recordManualSameContent(
  db: Database,
  input: WriteMemoryTargetInput,
  target: MemoryReviewTarget,
  current: MemoryContentSnapshot,
): Promise<repo.memoryChanges.MemoryChangeRow | null> {
  if (target.kind !== 'agent_memory') return null;
  const [latest] = await repo.memoryChanges.listFiltered(db, {
    agentId: target.agentId,
    kind: 'agent_memory',
    limit: 1,
  });
  if (latest && sameSnapshot(latest.after, current)) return null;
  return repo.memoryChanges.insert(db, {
    businessId: input.businessId,
    agentId: target.agentId,
    target,
    before: current,
    after: current,
  });
}

/** 专家 MEMORY.md 的写入窗口：日志先落盘，文件再 rename，账本提交后删日志。 */
async function writeAgentMemoryTarget(
  db: Database,
  input: WriteMemoryTargetInput,
  target: AgentMemoryTarget,
  current: MemoryContentSnapshot,
): Promise<repo.memoryChanges.MemoryChangeRow> {
  const slug = await agentSlug(db, target.agentId);
  // 失败恢复必须写回原字节，不能经过 UTF-8 解码再编码。
  const original = await readMemoryFileBytes(input.workspacesDir, slug, 'MEMORY.md');
  let journaled = false;
  if (input.sourceReviewRunId) {
    const afterSha256 = memorySha256(input.after.content);
    if (afterSha256 === null) throw new Error('memory review apply must write content');
    await writeMemoryJournal(input.workspacesDir, slug, {
      reviewRunId: input.sourceReviewRunId,
      target,
      beforeSha256: memorySha256(current.content),
      afterSha256,
    });
    journaled = true;
  }

  try {
    await writeProjection(db, input.workspacesDir, slug, target, input.after);
  } catch (error) {
    if (journaled) await discardJournalQuietly(input, slug);
    throw error;
  }

  try {
    const change = await db.transaction((tx) =>
      insertChange(tx as unknown as Database, input, target.agentId, current),
    );
    // 账本与审核决定已提交：日志只剩清理价值，失败也不能影响已提交的结果。
    await discardJournalQuietly(input, slug);
    return change;
  } catch (error) {
    try {
      if (original === null) {
        await deleteMemoryFile(input.workspacesDir, slug, 'MEMORY.md');
      } else {
        await restoreMemoryFile(input.workspacesDir, slug, 'MEMORY.md', original);
      }
      if (journaled) await discardJournalQuietly(input, slug);
    } catch (restoreError) {
      // 日志保留到下一次 apply 在锁内按显式证据恢复；错误本身保持可诊断。
      throw new AggregateError(
        [error, restoreError],
        'memory write failed and the original file could not be restored; journal kept',
      );
    }
    throw error;
  }
}

/**
 * 锁内写入：专家记忆文件先原子落盘、再提交账本与审核决定；
 * 规则写入与账本同事务。审核删除/采纳只在同一把锁里发生，不再有 prepared 中间态。
 * 调用方必须已持有该目标的会话锁。
 */
export async function writeMemoryTargetLocked(
  db: Database,
  input: WriteMemoryTargetInput,
): Promise<repo.memoryChanges.MemoryChangeRow | null> {
  const target = input.target;

  if (target.kind === 'personal') {
    if (input.after.content === null) fail('INVALID_INPUT', '个人记忆不能写入空内容');
    const current = await readPersonalMemory(db, input.businessId);
    const saved = await writePersonalMemoryLocked({
      db,
      workspacesDir: input.workspacesDir,
      businessId: input.businessId,
      content: input.after.content,
      expectedRevision: current.revision,
      ...(input.before === undefined ? {} : { expectedContent: input.before.content ?? '' }),
      ...(input.sourceReviewRunId ? { sourceReviewRunId: input.sourceReviewRunId } : {}),
      ...(input.reversesChangeId ? { reversesChangeId: input.reversesChangeId } : {}),
      ...(input.logger ? { logger: input.logger } : {}),
    });
    if (saved === null) fail('CONFLICT', '个人记忆已被其他编辑更新，请刷新后重试');
    const change = await repo.memoryChanges.find(db, saved.changeId);
    if (!change) throw new Error('personal memory change disappeared after save');
    return change;
  }

  await assertNoActiveRun(db, target.agentId);
  const current = snapshotOf(
    await readMemoryTarget(db, input.workspacesDir, target, input.businessId),
    target,
  );

  // 手工保存/删除/回滚：文件仍等于日志记录的基线时日志从未落盘，可安全丢弃；
  // 否则文件可能已生效，会覆盖或删掉日志正要恢复的内容。
  if (target.kind === 'agent_memory' && !input.sourceReviewRunId) {
    const slug = await agentSlug(db, target.agentId);
    const journal = await findMemoryJournalForTarget(input.workspacesDir, slug, target);
    if (journal) {
      if (memorySha256(current.content) !== journal.beforeSha256) {
        fail('CONFLICT', '存在未完成的审核写入，请先重试采用或重新生成');
      }
      await deleteMemoryJournal(input.workspacesDir, slug, journal.reviewRunId);
    }
  }

  // 专家记忆的写入日志是唯一可恢复证据；没有日志时绝不根据内容等于提案来补记。
  if (target.kind === 'agent_memory' && input.sourceReviewRunId) {
    const slug = await agentSlug(db, target.agentId);
    const journal = await readMemoryJournal(
      input.workspacesDir,
      slug,
      input.sourceReviewRunId,
      target,
    );
    if (journal) {
      const before = input.before;
      if (!before || memorySha256(before.content) !== journal.beforeSha256) {
        throw new Error('memory write journal does not match the review baseline');
      }
      if (memorySha256(input.after.content) !== journal.afterSha256) {
        throw new Error('memory write journal does not match the review proposal');
      }
      if (memorySha256(current.content) === journal.afterSha256) {
        const review = await repo.memoryReviews.find(db, input.sourceReviewRunId);
        if (!review) fail('NOT_FOUND', '记忆审核不存在，可能已被清理');
        if (review.decision === 'rejected') fail('CONFLICT', '该审核已被拒绝，不能采纳');
        if (review.decision === 'applied') {
          const existing = review.appliedChangeId
            ? await repo.memoryChanges.find(db, review.appliedChangeId)
            : null;
          if (!existing) throw new Error('applied memory review has no change row');
          await discardReviewWriteJournal(db, input.workspacesDir, review, input.logger);
          return existing;
        }
        const change = await db.transaction((tx) =>
          insertChange(tx as unknown as Database, input, target.agentId, before),
        );
        await discardReviewWriteJournal(db, input.workspacesDir, review, input.logger);
        return change;
      }
      if (memorySha256(current.content) !== journal.beforeSha256) {
        fail('CONFLICT', '目标内容已变化，请重新生成');
      }
      // 上次只写了日志、文件还没落盘：删掉过期日志后按正常流程继续。
      await deleteMemoryJournal(input.workspacesDir, slug, input.sourceReviewRunId);
    }
  }

  if (input.before !== undefined && !sameSnapshot(current, input.before)) {
    fail('CONFLICT', '目标内容在审核后已被修改，请重新发起审核');
  }

  if (sameSnapshot(current, input.after)) {
    if (input.before === undefined) return recordManualSameContent(db, input, target, current);
    // 快照完全匹配：无变化的提案/回滚只落账，不再写文件。
    const before = input.before;
    return db.transaction((tx) =>
      insertChange(tx as unknown as Database, input, target.agentId, before),
    );
  }

  if (target.kind === 'agent_memory') {
    return writeAgentMemoryTarget(db, input, target, current);
  }

  return db.transaction(async (tx) => {
    const txdb = tx as unknown as Database;
    await writeProjection(txdb, input.workspacesDir, '', target, input.after);
    return insertChange(txdb, input, target.agentId, current);
  });
}

/** 回滚入口：自己取锁；审核采纳需要先检查决定，所以直接使用 withMemoryTargetLock。 */
export async function writeMemoryTarget(
  db: Database,
  input: WriteMemoryTargetInput & { pool: DbPool },
): Promise<repo.memoryChanges.MemoryChangeRow | null> {
  return withMemoryTargetLock(input.pool, input.target, input.businessId, () =>
    writeMemoryTargetLocked(db, input),
  );
}

function toChange(row: repo.memoryChanges.MemoryChangeRow): MemoryChange {
  return repo.memoryChanges.toMemoryChange(row);
}

async function listVersions(
  db: Database,
  options: Omit<repo.memoryChanges.ListMemoryChangesOptions, 'before'> & { before?: string },
) {
  const { before, ...rest } = options;
  const rows = await repo.memoryChanges.listFiltered(db, {
    ...rest,
    ...(before === undefined ? {} : { before: new Date(before) }),
  });
  return { items: rows.map(toChange) };
}

export function registerMemoryChangeRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);

  app.get(
    '/api/agents/:id/memory/:name/versions',
    {
      config: { access: { kind: 'permission', permissionId: 'agents.memory.read' } },
      schema: {
        params: memoryVersionParams,
        querystring: versionsQuery,
        response: { 200: versionsResponseSchema },
      },
    },
    async (request) => {
      await authorizeObject(
        app,
        request,
        'agents.memory.read',
        { agentId: request.params.id },
        '智能体不存在，可能已被删除；请刷新后重新选择',
      );
      await agentSlug(app.db, request.params.id);
      // 只有 MEMORY.md 会经过审核/回滚写入变更账本；其他记忆文件没有版本历史。
      if (request.params.name !== 'MEMORY.md') return { items: [] };
      return listVersions(app.db, {
        agentId: request.params.id,
        kind: 'agent_memory',
        limit: request.query.limit,
        ...(request.query.before === undefined ? {} : { before: request.query.before }),
      });
    },
  );

  app.get(
    '/api/agents/:id/rules/:slug/versions',
    {
      config: { access: { kind: 'permission', permissionId: 'agents.rules.read' } },
      schema: {
        params: ruleVersionParams,
        querystring: versionsQuery,
        response: { 200: versionsResponseSchema },
      },
    },
    async (request) => {
      await authorizeObject(
        app,
        request,
        'agents.rules.read',
        { agentId: request.params.id },
        '智能体不存在，可能已被删除；请刷新后重新选择',
      );
      await agentSlug(app.db, request.params.id);
      return listVersions(app.db, {
        agentId: request.params.id,
        kind: 'agent_rule',
        slug: request.params.slug,
        limit: request.query.limit,
        ...(request.query.before === undefined ? {} : { before: request.query.before }),
      });
    },
  );

  app.post(
    '/api/memory/changes/:id/rollback',
    {
      // 回滚个人记忆与专家记忆共用入口；路由层要求个人记忆写叶，目标为专家时再按目标叶判定。
      config: { access: { kind: 'permission', permissionId: 'personal_memory.write' } },
      schema: { params: changeParams, response: { 200: memoryChangeSchema } },
    },
    async (request) => {
      const principal = userPrincipal(request);
      const [change] = await app.db
        .select()
        .from(schema.memoryChanges)
        .where(
          and(
            eq(schema.memoryChanges.id, request.params.id),
            eq(schema.memoryChanges.businessId, principal.businessId),
          ),
        )
        .limit(1);
      if (!change) fail('NOT_FOUND', '记忆版本不存在，可能已被清理');
      const target = memoryReviewTargetSchema.safeParse(change.target);
      if (!target.success) fail('INVALID_INPUT', '记忆版本的目标非法，无法回滚');
      if (target.data.kind === 'personal') {
        await authorizeObject(
          app,
          request,
          'personal_memory.write',
          {
            objectId: change.id,
            createdBy: change.businessId,
            privateContent: true,
          },
          '记忆版本不存在，可能已被清理',
        );
      } else if (target.data.kind === 'agent_memory') {
        await authorizeObject(
          app,
          request,
          'agents.memory.write',
          { agentId: target.data.agentId },
          '智能体不存在，可能已被删除；请刷新后重新选择',
        );
      } else {
        await authorizeObject(
          app,
          request,
          'agents.rules.write',
          { agentId: target.data.agentId },
          '智能体不存在，可能已被删除；请刷新后重新选择',
        );
      }
      const reverse = await writeMemoryTarget(app.db, {
        pool: app.pool,
        workspacesDir: app.config.WORKSPACES_DIR,
        businessId: change.businessId,
        target: target.data,
        before: change.after,
        after: change.before,
        reversesChangeId: change.id,
      });
      if (!reverse) fail('CONFLICT', '目标内容已变化，无法回滚');
      return toChange(reverse);
    },
  );
}
