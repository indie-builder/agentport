import { createHash } from 'node:crypto';
import { fail } from '@agentport/core';
import { type Database, repo, schema } from '@agentport/db';
import {
  createMemoryReviewInputSchema,
  MEMORY_FILE_MAX_BYTES,
  type MemoryContentSnapshot,
  type MemoryReview,
  type MemoryReviewProposal,
  type MemoryReviewSource,
  type MemoryReviewTarget,
  memoryChangeSchema,
  memoryContentSnapshotSchema,
  memoryReviewAfter,
  memoryReviewHasChanges,
  memoryReviewProposalSchema,
  memoryReviewSchema,
  memoryReviewTargetSchema,
  validateMemoryContent,
} from '@agentport/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { isAppError, isPgCode, reject } from '../../plugins/errors.js';
import { getQueue } from '../../queue/producer.js';
import { typed } from '../../types.js';
import { actorOf, authorizeObject, userPrincipal } from '../access.js';
import {
  assertNoPendingReviewWrite,
  discardReviewWriteJournal,
  memorySnapshot,
  readMemoryTarget,
  withMemoryTargetLock,
  writeMemoryTargetLocked,
} from '../memory/changes.js';

/** 审核快照与目标当前内容合计上限：超出后模型调用与响应体都不再可控。 */
export const MEMORY_REVIEW_MAX_BYTES = 256 * 1024;

const runParams = z.object({ runId: z.string().min(1) });

const createHeaders = z.object({ 'idempotency-key': z.uuid() });

// 个人页显式声明「来源必须属于本人」；不带该参数时保持既有平台/运维授权语义。
const createQuery = z.object({ scope: z.literal('own').optional() });

const createResponseSchema = z.object({ runId: z.string() });

const listQuery = z.object({
  conversationId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const listResponseSchema = z.object({ items: z.array(memoryReviewSchema) });

const decisionBody = z.object({ decision: z.literal('rejected') });

interface SnapshotMessage {
  id: string;
  role: string;
  text: string;
}

/** 规范化 JSON：同一对象无论键序都得到同一 hash。 */
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

/** 与 worker 相同的边界口径；只保留 user/assistant 的非空文本。 */
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

/** 详情与列表共用：来源只给会话摘要，不回传整段消息文本。 */
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

/** 持久化提案是外部数据：采纳前复核 schema、引用窗口、连续子串与角色归因。 */
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
    const problem = validateMemoryContent('MEMORY.md', after.index.content);
    if (problem) fail('INVALID_INPUT', problem);
  }
}

/** 目标类型的实际写叶；个人审核与专家记忆审核共用同一入口。 */
async function authorizeReviewTarget(
  app: FastifyInstance,
  request: FastifyRequest,
  target: MemoryReviewTarget,
  permissionId: 'personal_memory.review' | 'personal_memory.write',
): Promise<void> {
  if (target.kind === 'personal') {
    const businessId = userPrincipal(request).businessId;
    await authorizeObject(
      app,
      request,
      permissionId,
      { objectId: businessId, createdBy: businessId, privateContent: true },
      '记忆审核不存在，可能已被清理',
    );
    return;
  }
  if (target.kind === 'agent_memory') {
    await authorizeObject(
      app,
      request,
      'agents.memory.read',
      { objectId: target.agentId, agentId: target.agentId },
      '智能体不存在，可能已被删除；请刷新后重新选择',
    );
    await authorizeObject(
      app,
      request,
      'agents.memory.write',
      { objectId: target.agentId, agentId: target.agentId },
      '智能体不存在，可能已被删除；请刷新后重新选择',
    );
    return;
  }
  await authorizeObject(
    app,
    request,
    'agents.rules.read',
    { objectId: target.agentId, agentId: target.agentId },
    '智能体不存在，可能已被删除；请刷新后重新选择',
  );
  await authorizeObject(
    app,
    request,
    'agents.rules.write',
    { objectId: target.agentId, agentId: target.agentId },
    '智能体不存在，可能已被删除；请刷新后重新选择',
  );
}

export function registerMemoryReviewRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);

  app.post(
    '/api/memory-reviews',
    {
      config: { access: { kind: 'permission', permissionId: 'personal_memory.review' } },
      schema: {
        headers: createHeaders,
        querystring: createQuery,
        body: createMemoryReviewInputSchema,
        response: { 202: createResponseSchema },
      },
    },
    async (request, reply) => {
      const principal = userPrincipal(request);
      const businessId = principal.businessId;
      const input = request.body;
      const key = request.headers['idempotency-key'];
      const hash = requestHash(input);

      // 幂等复用的提前返回也必须先满足 own 来源约束，不能借相同键跳过校验。
      if (request.query.scope === 'own') {
        for (const source of input.sources) {
          const conversation = await repo.chat.getConversation(app.db, source.conversationId);
          // 他人会话按不存在处理，管理员也一样，不泄露存在性。
          if (!conversation || conversation.createdBy !== businessId) {
            fail('NOT_FOUND', '会话不存在，可能已被删除');
          }
        }
      }

      const existing = await repo.memoryReviews.findByRequest(app.db, businessId, key);
      if (existing) {
        if (existing.requestHash !== hash) {
          return reject(reply, 'CONFLICT', '幂等键已用于不同的审核请求');
        }
        return reply.status(202).send({ runId: existing.runId });
      }

      await assertModelAgent(app.db, input.modelAgentId);
      // 审核运行以当前用户为主体执行，必须仍具目标专家的使用范围。
      await authorizeObject(
        app,
        request,
        'agents.use',
        { agentId: input.modelAgentId },
        '智能体不存在，可能已被删除；请刷新后重新选择',
      );
      await authorizeReviewTarget(app, request, input.target, 'personal_memory.review');

      const loaded: Array<{ source: MemoryReviewSource; messages: SnapshotMessage[] }> = [];
      for (const source of input.sources) {
        const conversation = await repo.chat.getConversation(app.db, source.conversationId);
        if (!conversation) fail('CONVERSATION_NOT_FOUND', '会话不存在，可能已被删除');
        // 审核会把会话正文交给模型：来源必须是当前用户可读的私有会话。
        await authorizeObject(
          app,
          request,
          'conversations.read',
          { objectId: conversation.id, createdBy: conversation.createdBy, privateContent: true },
          '会话不存在，可能已被删除',
        );
        if (input.target.kind !== 'personal' && conversation.agentId !== input.target.agentId) {
          fail('INVALID_INPUT', '所选会话不属于目标专家，无法用于该专家的记忆审核');
        }
        loaded.push({ source, messages: await messagesInSource(app.db, source) });
      }

      const snapshot = loaded.flatMap(({ messages }) => messages);
      if (snapshot.length === 0) {
        fail('INVALID_INPUT', '所选会话没有可审核的用户或助手文本消息');
      }

      const before = await beforeSnapshot(
        app.db,
        app.config.WORKSPACES_DIR,
        input.target,
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

      // 固定窗口后再入队：runner 只按边界重读，后续新消息不会混进本次审核。
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
        review = await repo.memoryReviews.createWithRun(app.db, {
          businessId,
          modelAgentId: input.modelAgentId,
          requestKey: key,
          requestHash: hash,
          target: input.target,
          sources,
          instruction: input.instruction,
          before,
          agentVersion: await repo.agentVersions.latestAgentVersion(app.db, input.modelAgentId),
        });
      } catch (error) {
        if (!isPgCode(error, '23505')) throw error;
        const raced = await repo.memoryReviews.findByRequest(app.db, businessId, key);
        if (!raced) throw error;
        if (raced.requestHash !== hash) {
          return reject(reply, 'CONFLICT', '幂等键已用于不同的审核请求');
        }
        return reply.status(202).send({ runId: raced.runId });
      }

      try {
        const first = sources[0];
        if (!first) throw new Error('memory review needs at least one source');
        await getQueue().add(
          'run',
          {
            runId: review.runId,
            agentId: input.modelAgentId,
            conversationId: first.conversationId,
            prompt: '记忆审核',
          },
          { jobId: review.runId, attempts: 1, removeOnComplete: 100, removeOnFail: 200 },
        );
      } catch {
        await app.db
          .update(schema.agentRuns)
          .set({
            status: 'failed',
            endedAt: new Date(),
            error: '记忆审核入队失败，请稍后重试。',
            errorKind: 'infra',
          })
          .where(and(eq(schema.agentRuns.id, review.runId), eq(schema.agentRuns.status, 'queued')));
        return reject(reply, 'SERVICE_UNAVAILABLE', '记忆审核入队失败，请稍后重试');
      }

      await writeAudit(app.db, request.log, {
        actor: actorOf(request),
        action: 'review.created',
        target: review.runId,
        input: {
          modelAgentId: input.modelAgentId,
          target: input.target,
          sourceCount: sources.length,
        },
        status: 'ok',
        requestId: request.id,
      });

      return reply.status(202).send({ runId: review.runId });
    },
  );

  app.get(
    '/api/memory-reviews',
    {
      config: { access: { kind: 'permission', permissionId: 'personal_memory.read' } },
      schema: { querystring: listQuery, response: { 200: listResponseSchema } },
    },
    async (request) => {
      const { conversationId, agentId, before, limit } = request.query;
      const details = await repo.memoryReviews.listForUser(
        app.db,
        userPrincipal(request).businessId,
        {
          limit,
          ...(conversationId === undefined ? {} : { conversationId }),
          ...(agentId === undefined ? {} : { agentId }),
          ...(before === undefined ? {} : { before: new Date(before) }),
        },
      );
      const items = await Promise.all(
        details.map(async (detail) =>
          toReview(detail, await sourceSummaries(app.db, detail.sources)),
        ),
      );
      return { items };
    },
  );

  app.get(
    '/api/memory-reviews/:runId',
    {
      config: { access: { kind: 'permission', permissionId: 'personal_memory.read' } },
      schema: { params: runParams, response: { 200: memoryReviewSchema } },
    },
    async (request) => readReview(app.db, userPrincipal(request).businessId, request.params.runId),
  );

  app.post(
    '/api/memory-reviews/:runId/apply',
    {
      config: { access: { kind: 'permission', permissionId: 'personal_memory.write' } },
      schema: { params: runParams, response: { 200: memoryChangeSchema } },
    },
    async (request) => {
      const businessId = userPrincipal(request).businessId;
      const initial = await repo.memoryReviews.find(app.db, request.params.runId);
      if (!initial || initial.businessId !== businessId) {
        fail('NOT_FOUND', '记忆审核不存在，可能已被清理');
      }
      const parsedTarget = memoryReviewTargetSchema.safeParse(initial.target);
      if (!parsedTarget.success) fail('INVALID_INPUT', '记忆审核目标非法，无法采纳');
      const target = parsedTarget.data;
      await authorizeReviewTarget(app, request, target, 'personal_memory.write');

      // 采纳持锁到文件/规则、账本与审核决定全部完成，与拒绝、回滚、手工编辑互斥。
      return withMemoryTargetLock(app.pool, target, initial.businessId, async () => {
        const review = await repo.memoryReviews.find(app.db, request.params.runId);
        if (!review) fail('NOT_FOUND', '记忆审核不存在，可能已被清理');

        if (review.decision === 'applied') {
          const existing = review.appliedChangeId
            ? await repo.memoryChanges.find(app.db, review.appliedChangeId)
            : null;
          if (!existing) fail('CONFLICT', '该审核已采纳，但变更记录不存在');
          // 提交成功但进程在删日志前退出：这里顺带清掉残留日志。
          await discardReviewWriteJournal(app.db, app.config.WORKSPACES_DIR, review, request.log);
          return repo.memoryChanges.toMemoryChange(existing);
        }
        if (review.decision === 'rejected') {
          fail('CONFLICT', '该审核已被拒绝，不能采纳');
        }

        const run = await repo.chat.getRun(app.db, review.runId);
        if (run?.status !== 'succeeded') {
          fail('CONFLICT', '审核尚未成功完成，暂时不能采纳');
        }
        const before = memoryContentSnapshotSchema.safeParse(review.before);
        if (!before.success) fail('INVALID_INPUT', '记忆审核基线非法，无法采纳');
        const proposal = await validatedProposal(app.db, review);
        // 无变化（含内容相同且索引已链接）不写文件、不落账，保留完整提案。
        if (!memoryReviewHasChanges(target, before.data, proposal)) {
          fail('CONFLICT', '该审核没有需要写入的内容');
        }
        const after = memoryReviewAfter(target, before.data, proposal.proposedContent);
        // 持久化值可能来自旧记录或手工改库：限额与索引规则在首个文件写前复核。
        validateProposalAfter(target, after);

        const change = await writeMemoryTargetLocked(app.db, {
          workspacesDir: app.config.WORKSPACES_DIR,
          businessId: review.businessId,
          target,
          before: before.data,
          after,
          sourceReviewRunId: review.runId,
          logger: request.log,
        });
        if (!change) throw new Error('memory apply produced no change');
        return repo.memoryChanges.toMemoryChange(change);
      });
    },
  );

  app.patch(
    '/api/memory-reviews/:runId',
    {
      config: { access: { kind: 'permission', permissionId: 'personal_memory.review' } },
      schema: {
        params: runParams,
        body: decisionBody,
        response: { 200: memoryReviewSchema },
      },
    },
    async (request) => {
      const businessId = userPrincipal(request).businessId;
      const initial = await repo.memoryReviews.find(app.db, request.params.runId);
      if (!initial || initial.businessId !== businessId) {
        fail('NOT_FOUND', '记忆审核不存在，可能已被清理');
      }
      const parsedTarget = memoryReviewTargetSchema.safeParse(initial.target);
      if (parsedTarget.success) {
        await authorizeReviewTarget(app, request, parsedTarget.data, 'personal_memory.review');
      }
      const rejectReview = async () => {
        const detail = await repo.memoryReviews.findForUser(
          app.db,
          businessId,
          request.params.runId,
        );
        if (!detail) fail('NOT_FOUND', '记忆审核不存在，可能已被清理');
        if (detail.decision === 'applied') fail('CONFLICT', '已采纳的审核不能改为拒绝');
        if (detail.decision === 'pending') {
          if (parsedTarget.success) {
            await assertNoPendingReviewWrite(app.db, app.config.WORKSPACES_DIR, {
              runId: detail.runId,
              target: parsedTarget.data,
              businessId,
            });
          }
          await repo.memoryReviews.updateDecisionIfPending(
            app.db,
            request.params.runId,
            'rejected',
          );
        }
        return readReview(app.db, businessId, request.params.runId);
      };
      // 拒绝与采纳共用同一把目标锁；目标非法时采纳本身也无法进行，直接拒绝。
      return parsedTarget.success
        ? withMemoryTargetLock(app.pool, parsedTarget.data, initial.businessId, rejectReview)
        : rejectReview();
    },
  );
}
