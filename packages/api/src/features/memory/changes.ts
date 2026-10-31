import { fail } from '@agentport/core';
import { type Database, type DbPool, newId, repo, schema } from '@agentport/db';
import {
  MEMORY_FILE_MAX_BYTES,
  type MemoryChange,
  type MemoryContentSnapshot,
  type MemoryReviewTarget,
  memoryChangeSchema,
  memoryContentSnapshotSchema,
  memoryFileNamePattern,
  memoryReviewAfter,
  memoryReviewProposalSchema,
  memoryReviewTargetSchema,
  slugSchema,
  validateMemoryContent,
} from '@agentport/shared';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { typed } from '../../types.js';
import { authorizeObject, userPrincipal } from '../access.js';
import {
  deleteMemoryFile,
  readMemoryFile,
  readMemoryFileBytes,
  restoreMemoryFile,
  writeMemoryFile,
} from '../agents/memory-files.js';
import {
  type AgentMemoryTarget,
  bufferSha256,
  deleteMemoryJournal,
  journalMatchesTarget,
  listMemoryJournals,
  type MemoryJournalEntry,
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

const INDEX_FILE = 'MEMORY.md';

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
  /** 主题文件的伴随索引；personal、规则与 MEMORY.md 自身为 null。 */
  index: MemoryContentSnapshot['index'];
  /** 仅个人记忆使用：写入时作为乐观锁版本号。 */
  revision?: number;
}

/** 三类目标当前内容的唯一读取口径；主题同时读取同专家的 MEMORY.md。 */
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
  const slug = await agentSlug(db, target.agentId);
  if (target.kind === 'agent_memory') {
    const file = await readMemoryFile(workspacesDir, slug, target.name);
    const index =
      target.name === INDEX_FILE
        ? null
        : {
            content: (await readMemoryFile(workspacesDir, slug, INDEX_FILE))?.content ?? null,
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

/** 比较时把「缺失规则的 globs」按空字符串处理，与审核快照同一表示。 */
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

/** 实际会变化的文件；主题与 MEMORY.md 最多两个，顺序固定为目标文件在前。 */
function changedFiles(
  target: MemoryReviewTarget,
  before: MemoryContentSnapshot,
  after: MemoryContentSnapshot,
): string[] {
  if (target.kind !== 'agent_memory') return [];
  const names: string[] = [];
  if ((before.content ?? null) !== (after.content ?? null)) names.push(target.name);
  if (target.name !== INDEX_FILE && !sameIndex(before.index, after.index)) names.push(INDEX_FILE);
  return names;
}

function contentBytes(content: string | null): Buffer | null {
  return content === null ? null : Buffer.from(content, 'utf8');
}

function decodeBase64(value: string | null): string | null {
  return value === null ? null : Buffer.from(value, 'base64').toString('utf8');
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

export interface WriteMemoryTargetBase {
  workspacesDir: string;
  businessId: string;
  target: MemoryReviewTarget;
  /** 审核/回滚要求目标仍是该快照；手工编辑不传，按锁内当前内容记录 before。 */
  before?: MemoryContentSnapshot;
  sourceReviewRunId?: string | null;
  reversesChangeId?: string | null;
  logger?: MemoryWriteLogger;
}

export type WriteMemoryTargetInput = WriteMemoryTargetBase &
  (
    | { after: MemoryContentSnapshot; manualContent?: never }
    /** 手工 PUT/DELETE 的正文意图；null 表示删除。after 在日志恢复并重读当前文件后计算。 */
    | { after?: never; manualContent: string | null }
  );

async function writeProjection(
  db: Database,
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
  db: Database,
  input: WriteMemoryTargetBase & { after: MemoryContentSnapshot },
  agentId: string | null,
  before: MemoryContentSnapshot,
  changeId?: string,
): Promise<repo.memoryChanges.MemoryChangeRow> {
  const change = await repo.memoryChanges.insert(db, {
    ...(changeId === undefined ? {} : { id: changeId }),
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

/** 每个文件都只认日志的显式哈希，任何第三方内容都返回冲突。 */
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

/** 把本次写入涉及的文件恢复到日志记录的原始字节；不存在则删除。 */
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

/** 文件已全部落到 after：按日志类型补完账本（审核/回滚）或补记手工版本。 */
async function finalizeJournalEntry(
  db: Database,
  workspacesDir: string,
  slug: string,
  entry: MemoryJournalEntry,
): Promise<repo.memoryChanges.MemoryChangeRow> {
  if (entry.operation === 'review') {
    const review = await repo.memoryReviews.find(db, entry.operationId);
    if (!review) fail('NOT_FOUND', '记忆审核不存在，可能已被清理');
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
    if (review.decision === 'rejected') fail('CONFLICT', '该审核已被拒绝，不能采纳');
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
        tx as unknown as Database,
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
    if (!change) fail('NOT_FOUND', '记忆版本不存在，可能已被清理');
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
        tx as unknown as Database,
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

  // manual：先按预分配的操作 ID 认已提交账本，不按内容猜同一操作。
  const existing = await repo.memoryChanges.find(db, entry.operationId);
  if (existing) return existing;
  const target: AgentMemoryTarget = entry.target;
  const targetFile = entry.files.find((file) => file.name === target.name);
  const afterContent = (await readMemoryFile(workspacesDir, slug, target.name))?.content ?? null;
  const beforeContent = targetFile ? decodeBase64(targetFile.beforeBase64) : afterContent;
  let beforeIndex: string | null = null;
  let afterIndex: string | null = null;
  if (target.name !== INDEX_FILE) {
    const indexFile = entry.files.find((file) => file.name === INDEX_FILE);
    afterIndex = (await readMemoryFile(workspacesDir, slug, INDEX_FILE))?.content ?? null;
    beforeIndex = indexFile ? decodeBase64(indexFile.beforeBase64) : afterIndex;
  }
  const before: MemoryContentSnapshot = {
    content: beforeContent,
    globs: null,
    index: target.name === INDEX_FILE ? null : { content: beforeIndex },
  };
  const after: MemoryContentSnapshot = {
    content: afterContent,
    globs: null,
    index: target.name === INDEX_FILE ? null : { content: afterIndex },
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

/**
 * 已提交日志只剩清理价值：先按稳定操作身份认账，不读写文件。
 * null 表示尚未提交，仍需按文件哈希恢复或阻断后续写入。
 */
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

/**
 * 锁内先处理该专家所有残留写入日志：
 * 全部仍是 before → 写从未生效，丢弃；混合 → 先恢复原字节；
 * 全部是 after → 按审核/回滚/手工补完账本。冲突则不覆盖外部编辑。
 */
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
    // 只有同一操作类型的日志才算「本次操作」：回滚的 operationId 是被撤销变更的 ID，
    // 不能因此把该手工变更的残留日志当成回滚自己的已提交记录。
    const own =
      ownOperationId !== undefined &&
      entry.operationId === ownOperationId &&
      entry.operation === operation;
    const settled = await settledJournal(db, entry);
    if (settled) {
      // 已提交：就算 SDK 之后改了文件，也只清日志，不恢复、不补账、不阻断后续。
      await discardJournalQuietly(workspacesDir, slug, entry.operationId, logger);
      if (own && settled.change) resolved = settled.change;
      continue;
    }
    const state = journalState(entry, await currentFileHashes(workspacesDir, slug, entry));
    if (state === 'conflict') {
      fail('CONFLICT', '目标记忆文件已被修改，存在未完成的写入，请重新生成或重试原操作');
    }
    // 索引是共享资源：其它操作的已落盘/半落盘写入只能由原操作恢复，
    // 不能借手工保存、回滚或另一次审核覆盖。手工写入之间可以收敛。
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
    // 账本已提交：日志只剩清理价值，删除失败不能把成功改写成 500。
    await discardJournalQuietly(workspacesDir, slug, entry.operationId, logger);
    if (own) resolved = change;
  }
  return resolved;
}

/**
 * 拒绝前的显式证据检查：本审核没有已落盘的文件变更才能拒绝。
 * 其他操作的残留写入占用共享索引时同样返回冲突，不允许绕过。
 */
export async function assertNoPendingReviewWrite(
  db: Database,
  workspacesDir: string,
  review: { runId: string; target: MemoryReviewTarget; businessId: string },
): Promise<void> {
  const target = review.target;
  if (target.kind !== 'agent_memory') return;
  const slug = await agentSlug(db, target.agentId);
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

/** 手工保存同内容：同一文件的最近一次已应用变更 after 与当前一致才不重复记账。 */
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
    includeIndexChanges: target.name === INDEX_FILE,
    limit: 1,
  });
  // MEMORY.md 的最近记录可能是以主题为 target 的变更：它的 after.index.content 才是 MEMORY 正文。
  const latestTarget = latest?.target;
  const latestIndexContent =
    latestTarget?.kind === 'agent_memory' && latestTarget.name === INDEX_FILE
      ? (latest?.after.content ?? null)
      : (latest?.after.index?.content ?? null);
  const same =
    latest !== undefined &&
    (target.name === INDEX_FILE
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

/** 所有候选文件在第一次写入前完成限额校验；超限整次拒绝，不截断。 */
function assertCandidateLimits(
  target: AgentMemoryTarget,
  after: MemoryContentSnapshot,
  changed: string[],
): void {
  if (after.content !== null && Buffer.byteLength(after.content, 'utf8') > MEMORY_FILE_MAX_BYTES) {
    fail('PAYLOAD_TOO_LARGE', `记忆文件不能超过 ${MEMORY_FILE_MAX_BYTES} 字节`);
  }
  if (target.name === INDEX_FILE && after.content !== null) {
    const problem = validateMemoryContent(INDEX_FILE, after.content);
    if (problem) fail('INVALID_INPUT', problem);
  }
  const indexContent = after.index?.content ?? null;
  if (changed.includes(INDEX_FILE) && indexContent !== null) {
    const problem = validateMemoryContent(INDEX_FILE, indexContent);
    if (problem) fail('INVALID_INPUT', problem);
  }
}

/** 专家记忆的双文件写入：日志先落盘，目标与索引依次 rename，账本提交后删日志。 */
async function writeAgentMemoryTarget(
  db: Database,
  input: WriteMemoryTargetInput,
  target: AgentMemoryTarget,
  current: MemoryContentSnapshot,
  changed: string[],
  after: MemoryContentSnapshot,
): Promise<repo.memoryChanges.MemoryChangeRow> {
  const slug = await agentSlug(db, target.agentId);
  assertCandidateLimits(target, after, changed);
  const operation = input.sourceReviewRunId
    ? ('review' as const)
    : input.reversesChangeId
      ? ('rollback' as const)
      : ('manual' as const);
  // 手工写入在写日志前先分配最终账本 ID，日志与账本使用同一稳定身份。
  const operationId = input.sourceReviewRunId ?? input.reversesChangeId ?? newId('memoryChange');
  const ordered = [...new Set([target.name, INDEX_FILE])].filter((name) => changed.includes(name));

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
  }

  try {
    const change = await db.transaction((tx) =>
      insertChange(
        tx as unknown as Database,
        { ...input, after },
        target.agentId,
        input.before ?? current,
        operation === 'manual' ? operationId : undefined,
      ),
    );
    // 账本与审核决定已提交：日志只剩清理价值，失败也不能影响已提交的结果。
    await discardJournalQuietly(input.workspacesDir, slug, operationId, input.logger);
    return change;
  } catch (error) {
    try {
      await restoreJournalFiles(input.workspacesDir, slug, entry);
      await discardJournalQuietly(input.workspacesDir, slug, operationId, input.logger);
    } catch (restoreError) {
      // 日志保留到下一次写入按显式证据恢复；错误本身保持可诊断。
      throw new AggregateError(
        [error, restoreError],
        'memory write failed and the original files could not be restored; journal kept',
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
    if (saved === null) fail('CONFLICT', '个人记忆已被其他编辑更新，请刷新后重试');
    const change = await repo.memoryChanges.find(db, saved.changeId);
    if (!change) throw new Error('personal memory change disappeared after save');
    return change;
  }

  await assertNoActiveRun(db, target.agentId);
  const slug = await agentSlug(db, target.agentId);
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
  // 手工写入的 after 必须基于日志恢复后的当前快照计算，不能沿用路由打开锁时读到的旧索引。
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
    // 同内容 PUT 仍会把当前索引作为候选；DELETE 不改索引，不因已有超限索引失败。
    if (input.manualContent !== undefined) {
      assertCandidateLimits(target, after, input.manualContent === null ? [] : [INDEX_FILE]);
    }
    const partial = input.reversesChangeId !== undefined;
    if (input.before !== undefined) {
      if (partial) {
        // 回滚只校验并写回本次变更真正改过的文件；无关的后续索引变化不阻断主题回滚。
        for (const name of changed) {
          const expected = fileContent(target, input.before, name);
          const actual = fileContent(target, current, name);
          if (expected !== actual) fail('CONFLICT', '目标内容已变化，无法回滚');
        }
      } else if (!sameSnapshot(current, input.before)) {
        fail('CONFLICT', '目标内容在审核后已被修改，请重新生成');
      }
    }
    if (changed.length === 0) {
      if (input.before === undefined) return recordManualSameContent(db, input, target, current);
      if (input.sourceReviewRunId) fail('CONFLICT', '该提案不需要改动记忆文件');
      const before = input.before;
      if (!before) throw new Error('memory change requires a baseline');
      return db.transaction((tx) =>
        insertChange(tx as unknown as Database, { ...input, after }, target.agentId, before),
      );
    }
    return writeAgentMemoryTarget(db, input, target, current, changed, after);
  }

  if (input.before !== undefined && !sameSnapshot(current, input.before)) {
    fail('CONFLICT', '目标内容在审核后已被修改，请重新生成');
  }
  if (sameSnapshot(current, after)) {
    if (input.before === undefined) return null;
    const before = input.before;
    return db.transaction((tx) =>
      insertChange(tx as unknown as Database, { ...input, after }, target.agentId, before),
    );
  }
  return db.transaction(async (tx) => {
    const txdb = tx as unknown as Database;
    await writeProjection(txdb, target, after);
    return insertChange(txdb, { ...input, after }, target.agentId, current);
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
      // 每个合法文件都有自己的历史；MEMORY.md 还包含实际改动了伴随索引的主题变更。
      return listVersions(app.db, {
        agentId: request.params.id,
        kind: 'agent_memory',
        name: request.params.name,
        includeIndexChanges: request.params.name === INDEX_FILE,
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
