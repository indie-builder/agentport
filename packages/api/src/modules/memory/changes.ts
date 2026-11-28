import { fail, notFound } from '@agentport/core';
import { type Database, type DbHandle, newId, repo, schema } from '@agentport/db';
import {
  DEFAULT_MEMORY_POLICY,
  INDEX_FILE_NAME,
  MEMORY_FILE_MAX_BYTES,
  MEMORY_FILE_TOO_LARGE_MESSAGE,
  MEMORY_REVIEW_NOT_FOUND_MESSAGE,
  MEMORY_REVIEW_REJECTED_MESSAGE,
  MEMORY_ROLLBACK_STALE_MESSAGE,
  MEMORY_VERSION_NOT_FOUND_MESSAGE,
  type MemoryContentSnapshot,
  type MemoryReviewTarget,
  memoryContentSnapshotSchema,
  memoryReviewAfter,
  memoryReviewProposalSchema,
  memoryReviewTargetSchema,
  PERSONAL_MEMORY_STALE_MESSAGE,
  validateMemoryContent,
} from '@agentport/shared';
import type { SQL } from 'bun';
import { and, eq } from 'drizzle-orm';
import {
  type AgentMemoryTarget,
  bufferSha256,
  deleteMemoryJournal,
  journalMatchesTarget,
  listMemoryJournals,
  type MemoryJournalEntry,
  writeMemoryJournal,
} from './journal.js';
import { recordMemoryChange } from './ledger.js';
import {
  deleteMemoryFile,
  readMemoryFile,
  readMemoryFileBytes,
  restoreMemoryFile,
  writeMemoryFile,
} from './memory-files.js';
import { countMemoryTopics } from './overview.js';
import {
  type MemoryWriteLogger,
  readPersonalMemory,
  writePersonalMemoryLocked,
} from './personal.js';

async function requireAgentSlug(db: Database, agentId: string): Promise<string> {
  const slug = await repo.agents.findAgentSlug(db, agentId);
  if (slug === null) notFound('agent');
  return slug;
}

async function assertNoActiveRun(db: Database, agentId: string): Promise<void> {
  const [target] = await db
    .select({ enabled: schema.agents.enabled, parentId: schema.agents.parentId })
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .limit(1);
  const occupied = [agentId];
  if (target?.enabled && target.parentId !== null) occupied.push(target.parentId);
  if (await repo.agents.hasActiveRunUsingAgents(db, occupied)) {
    fail('CONFLICT', '该专家或其发起中的父专家仍有运行未结束，请等待完成或取消后再修改记忆');
  }
}

export interface MemoryTargetState {
  content: string | null;
  globs: string | null;
  index: MemoryContentSnapshot['index'];
  revision?: number;
}

export async function readMemoryTarget(
  db: Database,
  workspacesDir: string,
  target: MemoryReviewTarget,
  businessId: string,
): Promise<MemoryTargetState> {
  if (target.kind === 'personal') {
    const memory = await readPersonalMemory(db, businessId);
    return { content: memory.content, globs: null, index: null, revision: memory.revision };
  }
  const slug = await requireAgentSlug(db, target.agentId);
  if (target.kind === 'agent_memory') {
    const file = await readMemoryFile(workspacesDir, slug, target.name);
    const index =
      target.name === INDEX_FILE_NAME
        ? null
        : {
            content: (await readMemoryFile(workspacesDir, slug, INDEX_FILE_NAME))?.content ?? null,
          };
    return { content: file?.content ?? null, globs: null, index };
  }
  const [rule] = await db
    .select({ content: schema.agentRules.content, globs: schema.agentRules.globs })
    .from(schema.agentRules)
    .where(
      and(eq(schema.agentRules.agentId, target.agentId), eq(schema.agentRules.slug, target.slug)),
    )
    .limit(1);
  return { content: rule?.content ?? null, globs: rule?.globs ?? '', index: null };
}

export function memorySnapshot(
  state: MemoryTargetState,
  target: MemoryReviewTarget,
): MemoryContentSnapshot {
  return {
    content: state.content,
    globs: target.kind === 'agent_rule' ? state.globs : null,
    index: state.index,
  };
}

function sameIndex(
  before: MemoryContentSnapshot['index'],
  after: MemoryContentSnapshot['index'],
): boolean {
  if (!before || !after) return !before && !after;
  return before.content === after.content;
}

function sameSnapshot(current: MemoryContentSnapshot, expected: MemoryContentSnapshot): boolean {
  return (
    current.content === expected.content &&
    (current.globs ?? '') === (expected.globs ?? '') &&
    sameIndex(current.index, expected.index)
  );
}

function fileContent(
  target: AgentMemoryTarget,
  snapshot: MemoryContentSnapshot,
  name: string,
): string | null {
  if (name === target.name) return snapshot.content;
  return snapshot.index?.content ?? null;
}

function changedFiles(
  target: MemoryReviewTarget,
  before: MemoryContentSnapshot,
  after: MemoryContentSnapshot,
): string[] {
  if (target.kind !== 'agent_memory') return [];
  const names: string[] = [];
  if ((before.content ?? null) !== (after.content ?? null)) names.push(target.name);
  if (target.name !== INDEX_FILE_NAME && !sameIndex(before.index, after.index))
    names.push(INDEX_FILE_NAME);
  return names;
}

function contentBytes(content: string | null): Buffer | null {
  return content === null ? null : Buffer.from(content, 'utf8');
}

function decodeBase64(value: string | null): string | null {
  return value === null ? null : Buffer.from(value, 'base64').toString('utf8');
}

export function withMemoryTargetLock<T>(
  client: SQL,
  target: MemoryReviewTarget,
  businessId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return repo.locks.withAdvisoryLock(
    client,
    repo.locks.memoryTargetLockKey(target, businessId),
    fn,
  );
}

interface WriteMemoryTargetBase {
  workspacesDir: string;
  businessId: string;
  target: MemoryReviewTarget;
  before?: MemoryContentSnapshot;
  sourceReviewRunId?: string | null;
  reversesChangeId?: string | null;
  logger?: MemoryWriteLogger;
}

export type WriteMemoryTargetInput = WriteMemoryTargetBase &
  (
    | { after: MemoryContentSnapshot; manualContent?: never }
    | { after?: never; manualContent: string | null }
  );

async function writeProjection(
  db: DbHandle,
  target: Extract<MemoryReviewTarget, { kind: 'agent_rule' }>,
  after: MemoryContentSnapshot,
): Promise<void> {
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
  db: DbHandle,
  input: WriteMemoryTargetBase & { after: MemoryContentSnapshot },
  agentId: string | null,
  before: MemoryContentSnapshot,
  changeId?: string,
): Promise<repo.memoryChanges.MemoryChangeRow> {
  return recordMemoryChange(db, {
    ...(changeId === undefined ? {} : { id: changeId }),
    businessId: input.businessId,
    agentId,
    target: input.target,
    before,
    after: input.after,
    sourceReviewRunId: input.sourceReviewRunId ?? null,
    reversesChangeId: input.reversesChangeId ?? null,
  });
}

async function discardJournalQuietly(
  workspacesDir: string,
  slug: string,
  operationId: string,
  logger?: MemoryWriteLogger,
): Promise<void> {
  try {
    await deleteMemoryJournal(workspacesDir, slug, operationId);
  } catch (error) {
    logger?.warn({ err: error }, 'failed to remove memory write journal');
  }
}

export async function discardReviewWriteJournal(
  db: Database,
  workspacesDir: string,
  review: { runId: string; target: MemoryReviewTarget },
  logger?: MemoryWriteLogger,
): Promise<void> {
  if (review.target.kind !== 'agent_memory') return;
  try {
    const slug = await requireAgentSlug(db, review.target.agentId);
    await deleteMemoryJournal(workspacesDir, slug, review.runId);
  } catch (error) {
    logger?.warn({ err: error }, 'failed to remove settled memory write journal');
  }
}

type JournalState = 'all-before' | 'all-after' | 'mixed' | 'conflict';

async function currentFileHashes(
  workspacesDir: string,
  slug: string,
  entry: MemoryJournalEntry,
): Promise<Map<string, string | null>> {
  const hashes = new Map<string, string | null>();
  for (const file of entry.files) {
    hashes.set(file.name, bufferSha256(await readMemoryFileBytes(workspacesDir, slug, file.name)));
  }
  return hashes;
}

function journalState(entry: MemoryJournalEntry, hashes: Map<string, string | null>): JournalState {
  let before = 0;
  let after = 0;
  for (const file of entry.files) {
    const hash = hashes.get(file.name) ?? null;
    if (hash === file.beforeSha256) before += 1;
    else if (hash === file.afterSha256) after += 1;
    else return 'conflict';
  }
  if (before === entry.files.length) return 'all-before';
  if (after === entry.files.length) return 'all-after';
  return 'mixed';
}

async function restoreJournalFiles(
  workspacesDir: string,
  slug: string,
  entry: MemoryJournalEntry,
): Promise<void> {
  for (const file of entry.files) {
    const bytes = file.beforeBase64 === null ? null : Buffer.from(file.beforeBase64, 'base64');
    if (bytes === null) {
      await deleteMemoryFile(workspacesDir, slug, file.name);
    } else {
      await restoreMemoryFile(workspacesDir, slug, file.name, bytes);
    }
  }
  const restored = await currentFileHashes(workspacesDir, slug, entry);
  for (const file of entry.files) {
    if ((restored.get(file.name) ?? null) !== file.beforeSha256) {
      throw new Error('memory write journal restore did not restore the baseline bytes');
    }
  }
}

function assertJournalMatchesSnapshot(
  entry: MemoryJournalEntry,
  target: AgentMemoryTarget,
  snapshot: MemoryContentSnapshot,
  side: 'before' | 'after',
): void {
  for (const file of entry.files) {
    const expected = bufferSha256(contentBytes(fileContent(target, snapshot, file.name)));
    const journaled = side === 'before' ? file.beforeSha256 : file.afterSha256;
    if (expected !== journaled) {
      throw new Error(`memory write journal does not match the ${side} snapshot`);
    }
  }
}

async function finalizeJournalEntry(
  db: Database,
  workspacesDir: string,
  slug: string,
  entry: MemoryJournalEntry,
): Promise<repo.memoryChanges.MemoryChangeRow> {
  if (entry.operation === 'review') {
    const review = await repo.memoryReviews.find(db, entry.operationId);
    if (!review) fail('NOT_FOUND', MEMORY_REVIEW_NOT_FOUND_MESSAGE);
    const target = memoryReviewTargetSchema.safeParse(review.target);
    const before = memoryContentSnapshotSchema.safeParse(review.before);
    const proposal = memoryReviewProposalSchema.safeParse(review.proposal);
    if (!target.success || !before.success || !proposal.success) {
      fail('INVALID_INPUT', '记忆审核记录非法，无法恢复到账本');
    }
    const agentTarget = target.data;
    if (agentTarget.kind !== 'agent_memory') {
      fail('INVALID_INPUT', '记忆审核记录非法，无法恢复到账本');
    }
    if (!journalMatchesTarget(entry, agentTarget)) {
      throw new Error('memory write journal target does not match the review');
    }
    if (review.decision === 'rejected') fail('CONFLICT', MEMORY_REVIEW_REJECTED_MESSAGE);
    if (review.decision === 'applied') {
      const existing = review.appliedChangeId
        ? await repo.memoryChanges.find(db, review.appliedChangeId)
        : null;
      if (!existing) throw new Error('applied memory review has no change row');
      return existing;
    }
    const after = memoryReviewAfter(agentTarget, before.data, proposal.data.proposedContent);
    assertJournalMatchesSnapshot(entry, agentTarget, before.data, 'before');
    assertJournalMatchesSnapshot(entry, agentTarget, after, 'after');
    return db.transaction((tx) =>
      insertChange(
        tx,
        {
          workspacesDir,
          businessId: review.businessId,
          target: agentTarget,
          before: before.data,
          after,
          sourceReviewRunId: review.runId,
        },
        agentTarget.agentId,
        before.data,
      ),
    );
  }

  if (entry.operation === 'rollback') {
    const existing = await repo.memoryChanges.findByReverses(db, entry.operationId);
    if (existing) return existing;
    const change = await repo.memoryChanges.find(db, entry.operationId);
    if (!change) fail('NOT_FOUND', MEMORY_VERSION_NOT_FOUND_MESSAGE);
    const target = memoryReviewTargetSchema.safeParse(change.target);
    if (!target.success) fail('INVALID_INPUT', '记忆版本的目标非法，无法恢复');
    const agentTarget = target.data;
    if (agentTarget.kind !== 'agent_memory') {
      fail('INVALID_INPUT', '记忆版本的目标非法，无法恢复');
    }
    if (!journalMatchesTarget(entry, agentTarget)) {
      throw new Error('memory write journal target does not match the rolled back change');
    }
    assertJournalMatchesSnapshot(entry, agentTarget, change.before, 'after');
    return db.transaction((tx) =>
      insertChange(
        tx,
        {
          workspacesDir,
          businessId: change.businessId,
          target: agentTarget,
          before: change.after,
          after: change.before,
          reversesChangeId: change.id,
        },
        agentTarget.agentId,
        change.after,
      ),
    );
  }

  const existing = await repo.memoryChanges.find(db, entry.operationId);
  if (existing) return existing;
  const target: AgentMemoryTarget = entry.target;
  const targetFile = entry.files.find((file) => file.name === target.name);
  const afterContent = (await readMemoryFile(workspacesDir, slug, target.name))?.content ?? null;
  const beforeContent = targetFile ? decodeBase64(targetFile.beforeBase64) : afterContent;
  let beforeIndex: string | null = null;
  let afterIndex: string | null = null;
  if (target.name !== INDEX_FILE_NAME) {
    const indexFile = entry.files.find((file) => file.name === INDEX_FILE_NAME);
    afterIndex = (await readMemoryFile(workspacesDir, slug, INDEX_FILE_NAME))?.content ?? null;
    beforeIndex = indexFile ? decodeBase64(indexFile.beforeBase64) : afterIndex;
  }
  const before: MemoryContentSnapshot = {
    content: beforeContent,
    globs: null,
    index: target.name === INDEX_FILE_NAME ? null : { content: beforeIndex },
  };
  const after: MemoryContentSnapshot = {
    content: afterContent,
    globs: null,
    index: target.name === INDEX_FILE_NAME ? null : { content: afterIndex },
  };
  assertJournalMatchesSnapshot(entry, target, before, 'before');
  assertJournalMatchesSnapshot(entry, target, after, 'after');
  return repo.memoryChanges.insert(db, {
    id: entry.operationId,
    businessId: entry.businessId,
    agentId: target.agentId,
    target,
    before,
    after,
  });
}

interface SettledJournal {
  change: repo.memoryChanges.MemoryChangeRow | null;
}

async function settledJournal(
  db: Database,
  entry: MemoryJournalEntry,
): Promise<SettledJournal | null> {
  if (entry.operation === 'manual') {
    const change = await repo.memoryChanges.find(db, entry.operationId);
    return change ? { change } : null;
  }
  if (entry.operation === 'rollback') {
    const change = await repo.memoryChanges.findByReverses(db, entry.operationId);
    return change ? { change } : null;
  }
  const review = await repo.memoryReviews.find(db, entry.operationId);
  if (!review || review.decision === 'pending') return null;
  if (review.decision === 'rejected') return { change: null };
  if (!review.appliedChangeId) return null;
  const change = await repo.memoryChanges.find(db, review.appliedChangeId);
  return change ? { change } : null;
}

async function resolveJournalsForWrite(
  db: Database,
  workspacesDir: string,
  slug: string,
  operation: 'review' | 'rollback' | 'manual',
  ownOperationId: string | undefined,
  logger?: MemoryWriteLogger,
): Promise<repo.memoryChanges.MemoryChangeRow | null> {
  let resolved: repo.memoryChanges.MemoryChangeRow | null = null;
  for (const entry of await listMemoryJournals(workspacesDir, slug)) {
    const own =
      ownOperationId !== undefined &&
      entry.operationId === ownOperationId &&
      entry.operation === operation;
    const settled = await settledJournal(db, entry);
    if (settled) {
      await discardJournalQuietly(workspacesDir, slug, entry.operationId, logger);
      if (own && settled.change) resolved = settled.change;
      continue;
    }
    const state = journalState(entry, await currentFileHashes(workspacesDir, slug, entry));
    if (state === 'conflict') {
      fail('CONFLICT', '目标记忆文件已被修改，存在未完成的写入，请重新生成或重试原操作');
    }
    if (
      !own &&
      state !== 'all-before' &&
      !(operation === 'manual' && entry.operation === 'manual')
    ) {
      fail('CONFLICT', '存在未完成的记忆写入，请先重试原操作或重新生成');
    }
    if (state === 'all-before') {
      await deleteMemoryJournal(workspacesDir, slug, entry.operationId);
      continue;
    }
    if (state === 'mixed') {
      try {
        await restoreJournalFiles(workspacesDir, slug, entry);
      } catch (error) {
        logger?.warn({ err: error }, 'failed to restore a partially written memory journal');
        throw error;
      }
      await deleteMemoryJournal(workspacesDir, slug, entry.operationId);
      continue;
    }
    const change = await finalizeJournalEntry(db, workspacesDir, slug, entry);
    await discardJournalQuietly(workspacesDir, slug, entry.operationId, logger);
    if (own) resolved = change;
  }
  return resolved;
}

export async function assertNoPendingReviewWrite(
  db: Database,
  workspacesDir: string,
  review: { runId: string; target: MemoryReviewTarget; businessId: string },
): Promise<void> {
  const target = review.target;
  if (target.kind !== 'agent_memory') return;
  const slug = await requireAgentSlug(db, target.agentId);
  for (const entry of await listMemoryJournals(workspacesDir, slug)) {
    if (await settledJournal(db, entry)) {
      await discardJournalQuietly(workspacesDir, slug, entry.operationId);
      continue;
    }
    if (entry.operationId !== review.runId || !journalMatchesTarget(entry, target)) {
      fail('CONFLICT', '存在未完成的记忆写入，请先重试原操作或重新生成');
    }
    const state = journalState(entry, await currentFileHashes(workspacesDir, slug, entry));
    if (state !== 'all-before') {
      fail('CONFLICT', '目标写入未完成，请先重试采用或重新生成');
    }
    await deleteMemoryJournal(workspacesDir, slug, review.runId);
  }
}

async function recordManualSameContent(
  db: Database,
  input: WriteMemoryTargetInput,
  target: AgentMemoryTarget,
  current: MemoryContentSnapshot,
): Promise<repo.memoryChanges.MemoryChangeRow | null> {
  const [latest] = await repo.memoryChanges.listFiltered(db, {
    agentId: target.agentId,
    kind: 'agent_memory',
    name: target.name,
    includeIndexChanges: target.name === INDEX_FILE_NAME,
    limit: 1,
  });
  const latestTarget = latest?.target;
  const latestIndexContent =
    latestTarget?.kind === 'agent_memory' && latestTarget.name === INDEX_FILE_NAME
      ? (latest?.after.content ?? null)
      : (latest?.after.index?.content ?? null);
  const same =
    latest !== undefined &&
    (target.name === INDEX_FILE_NAME
      ? latestIndexContent === current.content
      : sameSnapshot(latest.after, current));
  if (same) return null;
  return repo.memoryChanges.insert(db, {
    businessId: input.businessId,
    agentId: target.agentId,
    target,
    before: current,
    after: current,
  });
}

function assertCandidateLimits(
  target: AgentMemoryTarget,
  after: MemoryContentSnapshot,
  changed: string[],
): void {
  if (after.content !== null && Buffer.byteLength(after.content, 'utf8') > MEMORY_FILE_MAX_BYTES) {
    fail('PAYLOAD_TOO_LARGE', MEMORY_FILE_TOO_LARGE_MESSAGE);
  }
  if (target.name === INDEX_FILE_NAME && after.content !== null) {
    const problem = validateMemoryContent(INDEX_FILE_NAME, after.content);
    if (problem) fail('INVALID_INPUT', problem);
  }
  const indexContent = after.index?.content ?? null;
  if (changed.includes(INDEX_FILE_NAME) && indexContent !== null) {
    const problem = validateMemoryContent(INDEX_FILE_NAME, indexContent);
    if (problem) fail('INVALID_INPUT', problem);
  }
}

export async function assertTopicCapacity(
  db: Database,
  workspacesDir: string,
  slug: string,
  agentId: string,
): Promise<void> {
  const policy = (await repo.agents.getAgentMemoryPolicy(db, agentId)) ?? DEFAULT_MEMORY_POLICY;
  const topics = await countMemoryTopics(workspacesDir, slug);
  if (topics >= policy.topicLimit) {
    fail('CONFLICT', `主题数量已达上限 ${policy.topicLimit}，请先合并或删除现有主题`);
  }
}

async function writeAgentMemoryTarget(
  db: Database,
  input: WriteMemoryTargetInput,
  target: AgentMemoryTarget,
  current: MemoryContentSnapshot,
  changed: string[],
  after: MemoryContentSnapshot,
): Promise<repo.memoryChanges.MemoryChangeRow> {
  const slug = await requireAgentSlug(db, target.agentId);
  assertCandidateLimits(target, after, changed);
  const operation = input.sourceReviewRunId
    ? ('review' as const)
    : input.reversesChangeId
      ? ('rollback' as const)
      : ('manual' as const);
  const operationId = input.sourceReviewRunId ?? input.reversesChangeId ?? newId('memoryChange');
  const ordered = [...new Set([target.name, INDEX_FILE_NAME])].filter((name) =>
    changed.includes(name),
  );

  const entry: MemoryJournalEntry = {
    operation,
    operationId,
    businessId: input.businessId,
    target,
    files: await Promise.all(
      ordered.map(async (name) => {
        const beforeBytes = await readMemoryFileBytes(input.workspacesDir, slug, name);
        const afterBytes = contentBytes(fileContent(target, after, name));
        return {
          name,
          beforeSha256: bufferSha256(beforeBytes),
          afterSha256: bufferSha256(afterBytes),
          beforeBase64: beforeBytes?.toString('base64') ?? null,
        };
      }),
    ),
  };
  await writeMemoryJournal(input.workspacesDir, slug, entry);

  const rollbackWrite = async (error: unknown): Promise<never> => {
    try {
      await restoreJournalFiles(input.workspacesDir, slug, entry);
      await discardJournalQuietly(input.workspacesDir, slug, operationId, input.logger);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        'memory write failed and the original files could not be restored; journal kept',
      );
    }
    throw error;
  };

  try {
    for (const name of ordered) {
      const content = fileContent(target, after, name);
      if (content === null) {
        await deleteMemoryFile(input.workspacesDir, slug, name);
      } else {
        await writeMemoryFile(input.workspacesDir, slug, name, content);
      }
    }
  } catch (error) {
    return rollbackWrite(error);
  }

  try {
    const change = await db.transaction((tx) =>
      insertChange(
        tx,
        { ...input, after },
        target.agentId,
        input.before ?? current,
        operation === 'manual' ? operationId : undefined,
      ),
    );
    await discardJournalQuietly(input.workspacesDir, slug, operationId, input.logger);
    return change;
  } catch (error) {
    return rollbackWrite(error);
  }
}

export async function writeMemoryTargetLocked(
  db: Database,
  input: WriteMemoryTargetInput,
): Promise<repo.memoryChanges.MemoryChangeRow | null> {
  const target = input.target;

  if (target.kind === 'personal') {
    if (input.manualContent !== undefined) fail('INVALID_INPUT', '个人记忆不支持手工正文意图');
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
    if (saved === null) fail('CONFLICT', PERSONAL_MEMORY_STALE_MESSAGE);
    const change = await repo.memoryChanges.find(db, saved.changeId);
    if (!change) throw new Error('personal memory change disappeared after save');
    return change;
  }

  await assertNoActiveRun(db, target.agentId);
  const slug = await requireAgentSlug(db, target.agentId);
  const operation = input.sourceReviewRunId
    ? ('review' as const)
    : input.reversesChangeId
      ? ('rollback' as const)
      : ('manual' as const);
  const recovered = await resolveJournalsForWrite(
    db,
    input.workspacesDir,
    slug,
    operation,
    input.sourceReviewRunId ?? input.reversesChangeId ?? undefined,
    input.logger,
  );
  if (recovered) return recovered;

  const current = memorySnapshot(
    await readMemoryTarget(db, input.workspacesDir, target, input.businessId),
    target,
  );
  const after: MemoryContentSnapshot =
    input.manualContent === undefined
      ? input.after
      : input.manualContent === null
        ? { content: null, globs: null, index: current.index }
        : memoryReviewAfter(target, current, input.manualContent);

  if (target.kind === 'agent_memory') {
    const changed =
      input.before === undefined
        ? changedFiles(target, current, after)
        : changedFiles(target, input.before, after);
    if (target.name !== INDEX_FILE_NAME && current.content === null && after.content !== null) {
      await assertTopicCapacity(db, input.workspacesDir, slug, target.agentId);
    }
    if (input.manualContent !== undefined) {
      assertCandidateLimits(target, after, input.manualContent === null ? [] : [INDEX_FILE_NAME]);
    }
    const partial = input.reversesChangeId !== undefined;
    if (input.before !== undefined) {
      if (partial) {
        for (const name of changed) {
          const expected = fileContent(target, input.before, name);
          const actual = fileContent(target, current, name);
          if (expected !== actual) fail('CONFLICT', MEMORY_ROLLBACK_STALE_MESSAGE);
        }
      } else if (!sameSnapshot(current, input.before)) {
        fail('CONFLICT_STALE', '目标内容在审核后已被修改，请重新生成');
      }
    }
    if (changed.length === 0) {
      if (input.before === undefined) return recordManualSameContent(db, input, target, current);
      if (input.sourceReviewRunId) fail('CONFLICT', '该提案不需要改动记忆文件');
      const before = input.before;
      return db.transaction((tx) => insertChange(tx, { ...input, after }, target.agentId, before));
    }
    return writeAgentMemoryTarget(db, input, target, current, changed, after);
  }

  if (input.before !== undefined && !sameSnapshot(current, input.before)) {
    fail('CONFLICT_STALE', '目标内容在审核后已被修改，请重新生成');
  }
  if (sameSnapshot(current, after)) {
    if (input.before === undefined) return null;
    const before = input.before;
    return db.transaction((tx) => insertChange(tx, { ...input, after }, target.agentId, before));
  }
  return repo.agentVersions.retryOnVersionConflict(() =>
    db.transaction(async (tx) => {
      await writeProjection(tx, target, after);
      await repo.agentDefinitions.recordDraftVersionTx(tx, target.agentId, null);
      return insertChange(tx, { ...input, after }, target.agentId, current);
    }),
  );
}

export async function writeMemoryTarget(
  db: Database,
  input: WriteMemoryTargetInput & { client: SQL },
): Promise<repo.memoryChanges.MemoryChangeRow | null> {
  return withMemoryTargetLock(input.client, input.target, input.businessId, () =>
    writeMemoryTargetLocked(db, input),
  );
}
