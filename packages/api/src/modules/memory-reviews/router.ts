import { createHash } from 'node:crypto';
import { memoryReviewsContract } from '@agentport/contract/memory-reviews';
import { fail, isAppError } from '@agentport/core';
import { type Database, repo, schema } from '@agentport/db';
import {
  INDEX_FILE_NAME,
  MEMORY_FILE_MAX_BYTES,
  type MemoryContentSnapshot,
  type MemoryReview,
  type MemoryReviewProposal,
  type MemoryReviewSource,
  type MemoryReviewTarget,
  memoryContentSnapshotSchema,
  memoryReviewAfter,
  memoryReviewHasChanges,
  memoryReviewProposalSchema,
  memoryReviewTargetSchema,
  validateMemoryContent,
} from '@agentport/shared';
import { implement } from '@orpc/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { actorOf, authorizeObject, requireUser } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { isPgCode } from '../../http/errors.js';
import { getQueue } from '../../queue/producer.js';
import {
  assertNoPendingReviewWrite,
  discardReviewWriteJournal,
  memorySnapshot,
  readMemoryTarget,
  withMemoryTargetLock,
  writeMemoryTargetLocked,
} from '../memory/changes.js';

const os = implement(memoryReviewsContract).$context<RequestContext>();

export const MEMORY_REVIEW_MAX_BYTES = 256 * 1024;

interface SnapshotMessage {
  id: string;
  role: string;
  text: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

function requestHash(input: unknown): string {
  return createHash('sha256').update(canonical(input)).digest('hex');
}

async function messagesInSource(
  db: Database,
  source: MemoryReviewSource,
): Promise<SnapshotMessage[]> {
  const rows = await repo.chat.listMessages(db, source.conversationId);
  const messages = rows.map((row) => ({
    id: row.id,
    role: row.role,
    text: repo.chat.messageText(row.content) ?? '',
  }));
  let from = 0;
  let through = messages.length;
  if (source.fromMessageId !== undefined) {
    const index = messages.findIndex((message) => message.id === source.fromMessageId);
    if (index < 0) fail('INVALID_INPUT', '审核起点消息不在会话中');
    from = index;
  }
  if (source.throughMessageId !== undefined) {
    const index = messages.findIndex((message) => message.id === source.throughMessageId);
    if (index < 0) fail('INVALID_INPUT', '审核终点消息不在会话中');
    through = index + 1;
  }
  if (from > through) fail('INVALID_INPUT', '审核起止消息顺序颠倒');
  return messages
    .slice(from, through)
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && message.text);
}

async function sourceSummaries(
  db: Database,
  sources: MemoryReviewSource[],
): Promise<MemoryReview['sources']> {
  return Promise.all(
    sources.map(async (source) => {
      const conversation = await repo.chat.getConversation(db, source.conversationId);
      let messageCount = 0;
      try {
        messageCount = (await messagesInSource(db, source)).length;
      } catch (error) {
        if (!isAppError(error)) throw error;
      }
      return {
        conversationId: source.conversationId,
        title: conversation?.title ?? '',
        messageCount,
      };
    }),
  );
}

function toReview(
  detail: repo.memoryReviews.MemoryReviewDetail,
  sources: MemoryReview['sources'],
): MemoryReview {
  return {
    runId: detail.runId,
    modelAgentId: detail.modelAgentId,
    target: detail.target,
    status: detail.status,
    decision: detail.decision,
    sources,
    before: detail.before,
    proposal: detail.proposal ?? null,
    appliedChangeId: detail.appliedChangeId ?? null,
    costUsd: detail.costUsd ?? null,
    error: detail.error ?? null,
  };
}

async function readReview(db: Database, businessId: string, runId: string): Promise<MemoryReview> {
  const detail = await repo.memoryReviews.findForUser(db, businessId, runId);
  if (!detail) fail('NOT_FOUND', '记忆审核不存在，可能已被清理');
  return toReview(detail, await sourceSummaries(db, detail.sources));
}

async function assertModelAgent(db: Database, agentId: string): Promise<void> {
  const [agent] = await db
    .select({ enabled: schema.agents.enabled })
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .limit(1);
  if (!agent) fail('AGENT_NOT_FOUND', '智能体不存在，可能已被删除；请刷新后重新选择');
  if (!agent.enabled) fail('AGENT_DISABLED', '该智能体已停用，无法执行记忆审核');
}

async function beforeSnapshot(
  db: Database,
  workspacesDir: string,
  target: MemoryReviewTarget,
  businessId: string,
): Promise<MemoryContentSnapshot> {
  return memorySnapshot(await readMemoryTarget(db, workspacesDir, target, businessId), target);
}

async function validatedProposal(
  db: Database,
  review: { proposal: unknown; sources: MemoryReviewSource[] },
): Promise<MemoryReviewProposal> {
  const parsed = memoryReviewProposalSchema.safeParse(review.proposal);
  if (!parsed.success) fail('INVALID_INPUT', '记忆提案格式非法，无法采纳');
  const proposal = parsed.data;
  if (proposal.proposedContent === null) return proposal;

  const messages = new Map<string, SnapshotMessage>();
  for (const source of review.sources) {
    try {
      for (const message of await messagesInSource(db, source)) {
        messages.set(message.id, message);
      }
    } catch (error) {
      if (!isAppError(error)) throw error;
    }
  }
  let hasUserBasis = false;
  for (const evidence of proposal.evidence) {
    const message = messages.get(evidence.messageId);
    if (!message) {
      fail('INVALID_INPUT', '记忆提案引用了来源窗口之外的消息，无法采纳');
    }
    if (!message.text.includes(evidence.quote)) {
      fail('INVALID_INPUT', '记忆提案的引用不是消息原文的连续片段，无法采纳');
    }
    if (evidence.kind === 'assistant_suggestion') {
      if (message.role !== 'assistant') {
        fail('INVALID_INPUT', '助手建议必须引用助手消息，无法采纳');
      }
    } else {
      if (message.role !== 'user') {
        fail('INVALID_INPUT', '用户事实与已确认决定必须引用用户消息，无法采纳');
      }
      hasUserBasis = true;
    }
  }
  if (!hasUserBasis) {
    fail('INVALID_INPUT', '记忆提案没有用户事实或已确认决定作为依据，无法采纳');
  }
  return proposal;
}

function validateProposalAfter(target: MemoryReviewTarget, after: MemoryContentSnapshot): void {
  if (after.content !== null && Buffer.byteLength(after.content, 'utf8') > MEMORY_FILE_MAX_BYTES) {
    fail('PAYLOAD_TOO_LARGE', `记忆文件不能超过 ${MEMORY_FILE_MAX_BYTES} 字节`);
  }
  if (after.content !== null) {
    const problem = validateMemoryContent(
      target.kind === 'agent_memory' ? target.name : '',
      after.content,
    );
    if (problem) fail('INVALID_INPUT', problem);
  }
  if (after.index?.content != null) {
    const problem = validateMemoryContent(INDEX_FILE_NAME, after.index.content);
    if (problem) fail('INVALID_INPUT', problem);
  }
}

async function authorizeReviewTarget(
  context: RequestContext,
  target: MemoryReviewTarget,
  permissionId: 'personal_memory.review' | 'personal_memory.write',
): Promise<void> {
  if (target.kind === 'personal') {
    const businessId = requireUser(context).businessId;
    await authorizeObject(
      context,
      permissionId,
      {
        objectId: businessId,
        createdBy: businessId,
        privateContent: true,
      },
      '记忆审核不存在，可能已被清理',
    );
    return;
  }
  const missing = '智能体不存在，可能已被删除；请刷新后重新选择';
  if (target.kind === 'agent_memory') {
    await authorizeObject(
      context,
      'agents.memory.read',
      { objectId: target.agentId, agentId: target.agentId },
      missing,
    );
    await authorizeObject(
      context,
      'agents.memory.write',
      { objectId: target.agentId, agentId: target.agentId },
      missing,
    );
    return;
  }
  await authorizeObject(
    context,
    'agents.rules.read',
    { objectId: target.agentId, agentId: target.agentId },
    missing,
  );
  await authorizeObject(
    context,
    'agents.rules.write',
    { objectId: target.agentId, agentId: target.agentId },
    missing,
  );
}

export const memoryReviewsRouter = os.router({
  create: os.create.handler(async ({ input, context }) => {
    const businessId = requireUser(context).businessId;
    const parsedKey = z
      .uuid()
      .safeParse(context.request.headers.get('idempotency-key') ?? undefined);
    if (!parsedKey.success) {
      fail('INVALID_INPUT', parsedKey.error.issues[0]?.message ?? 'idempotency-key 无效', {
        path: '/idempotency-key',
      });
    }
    const key = parsedKey.data;
    const hash = requestHash(input.body);

    if (input.query.scope === 'own') {
      for (const source of input.body.sources) {
        const conversation = await repo.chat.getConversation(context.db, source.conversationId);
        if (!conversation || conversation.createdBy !== businessId) {
          fail('NOT_FOUND', '会话不存在，可能已被删除');
        }
      }
    }

    const existing = await repo.memoryReviews.findByRequest(context.db, businessId, key);
    if (existing) {
      if (existing.requestHash !== hash) {
        fail('CONFLICT', '幂等键已用于不同的审核请求');
      }
      return { runId: existing.runId };
    }

    await assertModelAgent(context.db, input.body.modelAgentId);
    await authorizeObject(
      context,
      'agents.use',
      { agentId: input.body.modelAgentId },
      '智能体不存在，可能已被删除；请刷新后重新选择',
    );
    await authorizeReviewTarget(context, input.body.target, 'personal_memory.review');

    const loaded: Array<{ source: MemoryReviewSource; messages: SnapshotMessage[] }> = [];
    for (const source of input.body.sources) {
      const conversation = await repo.chat.getConversation(context.db, source.conversationId);
      if (!conversation) fail('CONVERSATION_NOT_FOUND', '会话不存在，可能已被删除');
      await authorizeObject(
        context,
        'conversations.read',
        {
          objectId: conversation.id,
          createdBy: conversation.createdBy,
          privateContent: true,
        },
        '会话不存在，可能已被删除',
      );
      if (
        input.body.target.kind !== 'personal' &&
        conversation.agentId !== input.body.target.agentId
      ) {
        fail('INVALID_INPUT', '所选会话不属于目标专家，无法用于该专家的记忆审核');
      }
      loaded.push({ source, messages: await messagesInSource(context.db, source) });
    }

    const snapshot = loaded.flatMap(({ messages }) => messages);
    if (snapshot.length === 0) {
      fail('INVALID_INPUT', '所选会话没有可审核的用户或助手文本消息');
    }

    const before = await beforeSnapshot(
      context.db,
      context.config.WORKSPACES_DIR,
      input.body.target,
      businessId,
    );
    const bytes =
      snapshot.reduce((total, message) => total + Buffer.byteLength(message.text, 'utf8'), 0) +
      Buffer.byteLength(before.content ?? '', 'utf8') +
      Buffer.byteLength(before.index?.content ?? '', 'utf8');
    if (bytes > MEMORY_REVIEW_MAX_BYTES) {
      fail(
        'PAYLOAD_TOO_LARGE',
        `审核快照与目标内容合计不能超过 ${MEMORY_REVIEW_MAX_BYTES / 1024} KiB`,
      );
    }

    const sources: MemoryReviewSource[] = loaded.map(({ source, messages }) => {
      const first = messages[0];
      const last = messages.at(-1);
      return first === undefined || last === undefined
        ? source
        : {
            conversationId: source.conversationId,
            fromMessageId: first.id,
            throughMessageId: last.id,
          };
    });

    let review: Awaited<ReturnType<typeof repo.memoryReviews.createWithRun>>;
    try {
      review = await repo.memoryReviews.createWithRun(context.db, {
        businessId,
        modelAgentId: input.body.modelAgentId,
        requestKey: key,
        requestHash: hash,
        target: input.body.target,
        sources,
        instruction: input.body.instruction,
        before,
        agentVersion: await repo.agentVersions.latestAgentVersion(
          context.db,
          input.body.modelAgentId,
        ),
      });
    } catch (error) {
      if (!isPgCode(error, '23505')) throw error;
      const raced = await repo.memoryReviews.findByRequest(context.db, businessId, key);
      if (!raced) throw error;
      if (raced.requestHash !== hash) {
        fail('CONFLICT', '幂等键已用于不同的审核请求');
      }
      return { runId: raced.runId };
    }

    try {
      const first = sources[0];
      if (!first) throw new Error('memory review needs at least one source');
      await getQueue().add(
        'run',
        {
          runId: review.runId,
          agentId: input.body.modelAgentId,
          conversationId: first.conversationId,
          prompt: '记忆审核',
        },
        { jobId: review.runId, attempts: 1, removeOnComplete: 100, removeOnFail: 200 },
      );
    } catch {
      await context.db
        .update(schema.agentRuns)
        .set({
          status: 'failed',
          endedAt: new Date(),
          error: '记忆审核入队失败，请稍后重试。',
          errorKind: 'infra',
        })
        .where(and(eq(schema.agentRuns.id, review.runId), eq(schema.agentRuns.status, 'queued')));
      fail('SERVICE_UNAVAILABLE', '记忆审核入队失败，请稍后重试');
    }

    await repo.audit.writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'review.created',
      target: review.runId,
      input: {
        modelAgentId: input.body.modelAgentId,
        target: input.body.target,
        sourceCount: sources.length,
      },
      status: 'ok',
      requestId: context.requestId,
    });

    return { runId: review.runId };
  }),

  list: os.list.handler(async ({ input, context }) => {
    const details = await repo.memoryReviews.listForUser(
      context.db,
      requireUser(context).businessId,
      {
        limit: input.query.limit,
        ...(input.query.conversationId === undefined
          ? {}
          : { conversationId: input.query.conversationId }),
        ...(input.query.agentId === undefined ? {} : { agentId: input.query.agentId }),
        ...(input.query.before === undefined ? {} : { before: new Date(input.query.before) }),
      },
    );
    const items = await Promise.all(
      details.map(async (detail) =>
        toReview(detail, await sourceSummaries(context.db, detail.sources)),
      ),
    );
    return { items };
  }),

  detail: os.detail.handler(async ({ input, context }) => {
    return readReview(context.db, requireUser(context).businessId, input.params.runId);
  }),

  apply: os.apply.handler(async ({ input, context }) => {
    const businessId = requireUser(context).businessId;
    const initial = await repo.memoryReviews.find(context.db, input.params.runId);
    if (!initial || initial.businessId !== businessId) {
      fail('NOT_FOUND', '记忆审核不存在，可能已被清理');
    }
    const parsedTarget = memoryReviewTargetSchema.safeParse(initial.target);
    if (!parsedTarget.success) fail('INVALID_INPUT', '记忆审核目标非法，无法采纳');
    const target = parsedTarget.data;
    await authorizeReviewTarget(context, target, 'personal_memory.write');

    return withMemoryTargetLock(context.client, target, initial.businessId, async () => {
      const review = await repo.memoryReviews.find(context.db, input.params.runId);
      if (!review) fail('NOT_FOUND', '记忆审核不存在，可能已被清理');

      if (review.decision === 'applied') {
        const existing = review.appliedChangeId
          ? await repo.memoryChanges.find(context.db, review.appliedChangeId)
          : null;
        if (!existing) fail('CONFLICT', '该审核已采纳，但变更记录不存在');
        await discardReviewWriteJournal(
          context.db,
          context.config.WORKSPACES_DIR,
          review,
          context.log,
        );
        return repo.memoryChanges.toMemoryChange(existing);
      }
      if (review.decision === 'rejected') {
        fail('CONFLICT', '该审核已被拒绝，不能采纳');
      }

      const run = await repo.chat.getRun(context.db, review.runId);
      if (run?.status !== 'succeeded') {
        fail('CONFLICT', '审核尚未成功完成，暂时不能采纳');
      }
      const before = memoryContentSnapshotSchema.safeParse(review.before);
      if (!before.success) fail('INVALID_INPUT', '记忆审核基线非法，无法采纳');
      const proposal = await validatedProposal(context.db, review);
      if (!memoryReviewHasChanges(target, before.data, proposal)) {
        fail('CONFLICT', '该审核没有需要写入的内容');
      }
      const after = memoryReviewAfter(target, before.data, proposal.proposedContent);
      validateProposalAfter(target, after);

      const change = await writeMemoryTargetLocked(context.db, {
        workspacesDir: context.config.WORKSPACES_DIR,
        businessId: review.businessId,
        target,
        before: before.data,
        after,
        sourceReviewRunId: review.runId,
        logger: context.log,
      });
      if (!change) throw new Error('memory apply produced no change');
      return repo.memoryChanges.toMemoryChange(change);
    });
  }),

  decide: os.decide.handler(async ({ input, context }) => {
    const businessId = requireUser(context).businessId;
    const initial = await repo.memoryReviews.find(context.db, input.params.runId);
    if (!initial || initial.businessId !== businessId) {
      fail('NOT_FOUND', '记忆审核不存在，可能已被清理');
    }
    const parsedTarget = memoryReviewTargetSchema.safeParse(initial.target);
    if (parsedTarget.success) {
      await authorizeReviewTarget(context, parsedTarget.data, 'personal_memory.review');
    }
    const rejectReview = async () => {
      const detail = await repo.memoryReviews.findForUser(
        context.db,
        businessId,
        input.params.runId,
      );
      if (!detail) fail('NOT_FOUND', '记忆审核不存在，可能已被清理');
      if (detail.decision === 'applied') fail('CONFLICT', '已采纳的审核不能改为拒绝');
      if (detail.decision === 'pending') {
        if (parsedTarget.success) {
          await assertNoPendingReviewWrite(context.db, context.config.WORKSPACES_DIR, {
            runId: detail.runId,
            target: parsedTarget.data,
            businessId,
          });
        }
        await repo.memoryReviews.updateDecisionIfPending(
          context.db,
          input.params.runId,
          'rejected',
        );
      }
      return readReview(context.db, businessId, input.params.runId);
    };
    return parsedTarget.success
      ? withMemoryTargetLock(context.client, parsedTarget.data, initial.businessId, rejectReview)
      : rejectReview();
  }),
});
