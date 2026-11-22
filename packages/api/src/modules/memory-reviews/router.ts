import { memoryReviewsContract } from '@agentport/contract/memory-reviews';
import {
  AGENT_SELECTION_MISSING_MESSAGE,
  fail,
  isAppError,
  notFound,
  reviewAnchorMissingMessage,
  selectReviewWindow,
  sha256Hex,
} from '@agentport/core';
import { type Database, idSuffix, repo } from '@agentport/db';
import {
  DEFAULT_MEMORY_POLICY,
  INDEX_FILE_NAME,
  MEMORY_FILE_MAX_BYTES,
  MEMORY_REVIEW_NOT_FOUND_MESSAGE,
  MEMORY_REVIEW_REJECTED_MESSAGE,
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
import { actorOf, authorizeObject, requireUser } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { isPgCode } from '../../http/errors.js';
import { cursorOption, requireCursorPage } from '../../http/pagination.js';
import { requireAgentSlug } from '../../lib/agent-slug.js';
import { listMemoryFiles } from '../agents/memory-files.js';
import {
  assertNoPendingReviewWrite,
  assertTopicCapacity,
  discardReviewWriteJournal,
  memorySnapshot,
  readMemoryTarget,
  withMemoryTargetLock,
  writeMemoryTargetLocked,
} from '../memory/changes.js';
import { enqueueRunJob } from '../runs/enqueue.js';

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
  return sha256Hex(canonical(input));
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
  const window = selectReviewWindow(messages, source);
  if (window.kind === 'missing') {
    fail('INVALID_INPUT', reviewAnchorMissingMessage(window.anchor));
  }
  if (window.from > window.through) fail('INVALID_INPUT', '审核起止消息顺序颠倒');
  return window.messages;
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
    createdAt: detail.createdAt.toISOString(),
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
  if (!detail) fail('NOT_FOUND', MEMORY_REVIEW_NOT_FOUND_MESSAGE);
  return toReview(detail, await sourceSummaries(db, detail.sources));
}

async function resolveModelAgent(db: Database, agentId: string, businessId: string) {
  const agent = await repo.agents.getAgent(db, agentId);
  if (!agent) notFound('agent');
  if (!agent.enabled) fail('AGENT_DISABLED', '该智能体已停用，无法执行记忆审核');
  const version =
    agent.publishedVersion === null
      ? null
      : await repo.agentVersions.getAgentVersion(db, agentId, agent.publishedVersion);
  await db.transaction((tx) =>
    repo.governance.assertRunBudget(tx, {
      agentId,
      initiatedBy: businessId,
      definition: version?.definition ?? null,
    }),
  );
  return agent;
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
      MEMORY_REVIEW_NOT_FOUND_MESSAGE,
    );
    return;
  }
  if (target.kind === 'agent_memory') {
    await authorizeObject(
      context,
      'agents.memory.read',
      { objectId: target.agentId, agentId: target.agentId },
      AGENT_SELECTION_MISSING_MESSAGE,
    );
    await authorizeObject(
      context,
      'agents.memory.write',
      { objectId: target.agentId, agentId: target.agentId },
      AGENT_SELECTION_MISSING_MESSAGE,
    );
    return;
  }
  await authorizeObject(
    context,
    'agents.rules.read',
    { objectId: target.agentId, agentId: target.agentId },
    AGENT_SELECTION_MISSING_MESSAGE,
  );
  await authorizeObject(
    context,
    'agents.rules.write',
    { objectId: target.agentId, agentId: target.agentId },
    AGENT_SELECTION_MISSING_MESSAGE,
  );
}

async function authorizeReviewInput(
  context: RequestContext,
  input: { scope: 'own' | undefined; sources: MemoryReviewSource[]; target: MemoryReviewTarget },
): Promise<Array<{ source: MemoryReviewSource; conversation: repo.chat.Conversation }>> {
  const businessId = requireUser(context).businessId;
  const authorized: Array<{ source: MemoryReviewSource; conversation: repo.chat.Conversation }> =
    [];
  for (const source of input.sources) {
    const conversation = await repo.chat.getConversation(context.db, source.conversationId);
    if (!conversation) notFound('conversation');
    if (input.scope === 'own' && conversation.createdBy !== businessId) {
      fail('NOT_FOUND', '会话不存在，可能已被删除');
    }
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
    authorized.push({ source, conversation });
  }
  await authorizeReviewTarget(context, input.target, 'personal_memory.review');
  return authorized;
}

async function assertProposalAllowed(
  context: RequestContext,
  target: MemoryReviewTarget,
): Promise<void> {
  if (target.kind !== 'agent_memory') return;
  const policy =
    (await repo.agents.getAgentMemoryPolicy(context.db, target.agentId)) ?? DEFAULT_MEMORY_POLICY;
  if (!policy.enabled) fail('CONFLICT', '该专家的记忆已停用，暂不接受新的记忆提案');
  if (target.name === INDEX_FILE_NAME) return;
  const slug = await requireAgentSlug(context.db, target.agentId);
  const files = (await listMemoryFiles(context.config.WORKSPACES_DIR, slug)).files;
  const existing = files.some((file) => file.name === target.name);
  if (existing) return;
  await assertTopicCapacity(context.db, context.config.WORKSPACES_DIR, slug, target.agentId);
}

const MEMORY_REVIEW_PROMPT = '记忆审核';

async function enqueueReviewRun(
  context: RequestContext,
  run: { id: string; agentId: string; conversationId: string },
): Promise<void> {
  try {
    await enqueueRunJob(
      { db: context.db, log: context.log, requestId: context.requestId },
      {
        runId: run.id,
        agentId: run.agentId,
        conversationId: run.conversationId,
        prompt: MEMORY_REVIEW_PROMPT,
      },
    );
  } catch (error) {
    if (isAppError(error)) throw error;
    fail('SERVICE_UNAVAILABLE', '记忆审核入队失败，请稍后重试', { cause: error });
  }
}

async function writeReviewCreatedAudit(
  context: RequestContext,
  runId: string,
  body: { modelAgentId: string; target: MemoryReviewTarget; sources: MemoryReviewSource[] },
): Promise<void> {
  await repo.audit.writeAudit(context.db, context.log, {
    actor: actorOf(context),
    action: 'review.created',
    target: runId,
    input: {
      modelAgentId: body.modelAgentId,
      target: body.target,
      sourceCount: body.sources.length,
    },
    status: 'ok',
    requestId: context.requestId,
    dedupeKey: `aud_memrev_${idSuffix(runId)}`,
  });
}

async function replayReviewRun(
  context: RequestContext,
  run: repo.chat.AgentRun,
  input: { scope: 'own' | undefined; sources: MemoryReviewSource[]; target: MemoryReviewTarget },
): Promise<void> {
  const replayable = run.status === 'queued' || repo.runPredicates.isNeverStartedFailure(run);
  if (!replayable) return;
  await authorizeReviewInput(context, input);
  if (run.status === 'queued') {
    await enqueueReviewRun(context, run);
    return;
  }
  if (await repo.chat.requeueInfraFailedRun(context.db, run.id)) {
    await enqueueReviewRun(context, run);
    return;
  }
  const latest = await repo.chat.getRun(context.db, run.id);
  if (latest === null) fail('SERVICE_UNAVAILABLE', '记忆审核入队失败，请稍后重试');
  if (latest.status === 'queued') {
    await enqueueReviewRun(context, latest);
    return;
  }
  if (repo.runPredicates.isNeverStartedFailure(latest)) {
    fail('SERVICE_UNAVAILABLE', '记忆审核入队失败，请稍后重试');
  }
}

async function replayReview(
  context: RequestContext,
  review: repo.memoryReviews.MemoryReviewRow,
  hash: string,
  body: { modelAgentId: string; target: MemoryReviewTarget; sources: MemoryReviewSource[] },
  scope: 'own' | undefined,
): Promise<{ runId: string }> {
  if (review.requestHash !== hash) {
    fail('CONFLICT', '幂等键已用于不同的审核请求');
  }
  await writeReviewCreatedAudit(context, review.runId, body);
  if (review.decision !== 'pending') return { runId: review.runId };
  const run = await repo.chat.getRun(context.db, review.runId);
  if (run === null) fail('SERVICE_UNAVAILABLE', '记忆审核入队失败，请稍后重试');
  await replayReviewRun(context, run, {
    scope,
    sources: body.sources,
    target: body.target,
  });
  return { runId: review.runId };
}

export const memoryReviewsRouter = os.router({
  create: os.create.handler(async ({ input, context }) => {
    const businessId = requireUser(context).businessId;
    const key = input.headers['idempotency-key'];
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
    if (existing) return replayReview(context, existing, hash, input.body, input.query.scope);

    const modelAgent = await resolveModelAgent(context.db, input.body.modelAgentId, businessId);
    await authorizeObject(
      context,
      'agents.use',
      { agentId: input.body.modelAgentId },
      AGENT_SELECTION_MISSING_MESSAGE,
    );
    const authorized = await authorizeReviewInput(context, {
      scope: input.query.scope,
      sources: input.body.sources,
      target: input.body.target,
    });
    await assertProposalAllowed(context, input.body.target);

    const loaded: Array<{ source: MemoryReviewSource; messages: SnapshotMessage[] }> = [];
    for (const { source, conversation } of authorized) {
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
        agentVersion: modelAgent.publishedVersion,
      });
    } catch (error) {
      if (!isPgCode(error, '23505')) throw error;
      const raced = await repo.memoryReviews.findByRequest(context.db, businessId, key);
      if (!raced) throw error;
      return replayReview(context, raced, hash, input.body, input.query.scope);
    }

    const first = sources[0];
    if (!first) throw new Error('memory review needs at least one source');
    await enqueueReviewRun(context, {
      id: review.runId,
      agentId: input.body.modelAgentId,
      conversationId: first.conversationId,
    });

    await writeReviewCreatedAudit(context, review.runId, input.body);

    return { runId: review.runId };
  }),

  list: os.list.handler(async ({ input, context }) => {
    const limit = input.query.limit;
    const { cursor, conversationId, agentId } = input.query;
    const page = requireCursorPage(
      await repo.memoryReviews.listForUser(context.db, requireUser(context).businessId, {
        limit,
        ...(conversationId === undefined ? {} : { conversationId }),
        ...(agentId === undefined ? {} : { agentId }),
        ...cursorOption(cursor),
      }),
    );
    const items = await Promise.all(
      page.items.map(async (detail) =>
        toReview(detail, await sourceSummaries(context.db, detail.sources)),
      ),
    );
    return { items, nextCursor: page.nextCursor };
  }),

  detail: os.detail.handler(async ({ input, context }) => {
    return readReview(context.db, requireUser(context).businessId, input.params.runId);
  }),

  apply: os.apply.handler(async ({ input, context }) => {
    const businessId = requireUser(context).businessId;
    const initial = await repo.memoryReviews.find(context.db, input.params.runId);
    if (!initial || initial.businessId !== businessId) {
      fail('NOT_FOUND', MEMORY_REVIEW_NOT_FOUND_MESSAGE);
    }
    const parsedTarget = memoryReviewTargetSchema.safeParse(initial.target);
    if (!parsedTarget.success) fail('INVALID_INPUT', '记忆审核目标非法，无法采纳');
    const target = parsedTarget.data;
    await authorizeReviewTarget(context, target, 'personal_memory.write');

    return withMemoryTargetLock(context.client, target, initial.businessId, async () => {
      const review = await repo.memoryReviews.find(context.db, input.params.runId);
      if (!review) fail('NOT_FOUND', MEMORY_REVIEW_NOT_FOUND_MESSAGE);

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
        fail('CONFLICT', MEMORY_REVIEW_REJECTED_MESSAGE);
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
      fail('NOT_FOUND', MEMORY_REVIEW_NOT_FOUND_MESSAGE);
    }
    const parsedTarget = memoryReviewTargetSchema.safeParse(initial.target);
    if (parsedTarget.success) {
      await authorizeReviewTarget(context, parsedTarget.data, 'personal_memory.review');
    }
    const rejectReview = async () => {
      if (initial.decision === 'pending' && parsedTarget.success) {
        await assertNoPendingReviewWrite(context.db, context.config.WORKSPACES_DIR, {
          runId: initial.runId,
          target: parsedTarget.data,
          businessId,
        });
      }
      const outcome = await repo.memoryReviews.rejectIfRunNotActive(context.db, initial.runId);
      if (outcome === 'missing') fail('NOT_FOUND', MEMORY_REVIEW_NOT_FOUND_MESSAGE);
      if (outcome === 'applied') fail('CONFLICT', '已采纳的审核不能改为拒绝');
      if (outcome === 'run_active') {
        fail('CONFLICT', '审核尚未完成，暂时不能拒绝，请稍候');
      }
      return readReview(context.db, businessId, input.params.runId);
    };
    return parsedTarget.success
      ? withMemoryTargetLock(context.client, parsedTarget.data, initial.businessId, rejectReview)
      : rejectReview();
  }),
});
