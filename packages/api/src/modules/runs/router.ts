import { runsContract } from '@agentport/contract/runs';
import { buildSkillDraft, fail, isAppError, notFound } from '@agentport/core';
import { repo } from '@agentport/db';
import { runStatusSchema, runTriggerSchema } from '@agentport/shared';
import { implement } from '@orpc/server';
import type { Hono } from 'hono';
import { z } from 'zod';
import { accessFilter, actorOf, requireUser } from '../../http/access.js';
import { attachmentResponse } from '../../http/attachment.js';
import type { HttpEnv, RequestContext } from '../../http/context.js';
import { parseRequest, requestContext } from '../../http/context.js';
import { isPgCode, RUN_NOT_FOUND_MESSAGE } from '../../http/errors.js';
import { access } from '../../http/middleware.js';
import { cursorOption, requireCursorPage } from '../../http/pagination.js';
import { agentSlug } from '../../lib/agent-slug.js';
import { toIso } from '../../lib/iso.js';
import { readWorkspaceOutput } from '../../lib/outputs.js';
import { recheckRunApproval } from '../servers/approval-policy.js';
import { toApi as toApiSkill } from '../skills/api.js';
import { authorizeRun, authorizeRunFeedback, RUN_MISSING } from './access.js';
import { toRunDetail } from './events.js';
import { runsQuestionsRouter } from './questions.js';

const runsRepo = repo.runs;
async function decideRunApproval(
  context: RequestContext,
  runId: string,
  approvalId: string,
  decision: 'approve' | 'deny',
) {
  await authorizeRun(context, runId, 'runs.approve');
  const businessId = actorOf(context);
  const result = await runsRepo.decideToolApproval(
    context.db,
    { runId, approvalId, businessId, decision },
    recheckRunApproval(context.log),
  );
  if (result.kind === 'not_found') notFound('approval');
  if (result.kind === 'conflict')
    fail('CONFLICT', '工具审批已失效、被拒绝或运行已结束，请刷新后重试');
  const { serverId, toolName } = result.approval;
  await repo.notifications
    .markBySource(context.db, 'approval', `approval:${runId}:${approvalId}`)
    .catch((err: unknown) => {
      context.log.warn({ err, runId, approvalId }, 'approval notification mark-read failed');
    });
  await repo.audit.writeAudit(context.db, context.log, {
    actor: businessId,
    action: decision === 'approve' ? 'agent.run.approved' : 'agent.run.denied',
    target: runId,
    input: { approvalId, serverId, toolName },
    status: 'ok',
    requestId: context.requestId,
  });
  return result;
}

function toItem(run: repo.runs.RunListItem) {
  return { ...run, startedAt: toIso(run.startedAt), endedAt: toIso(run.endedAt) };
}
function toFeedback(row: repo.runFeedback.RunFeedbackRow) {
  return { ...row, createdAt: row.createdAt.toISOString() };
}
const os = implement(runsContract).$context<RequestContext>();
const runsMainRouter = {
  list: os.list.handler(async ({ input, context }) => {
    const { agentId, status, trigger, since, cursor, limit } = input.query;
    const page = requireCursorPage(
      await runsRepo.listRuns(context.db, {
        ...(agentId === undefined ? {} : { agentId }),
        ...(status === undefined ? {} : { status }),
        ...(trigger === undefined ? {} : { trigger }),
        ...(since === undefined ? {} : { since: new Date(since) }),
        ...cursorOption(cursor),
        limit,
        access: accessFilter(context, 'runs.read'),
      }),
    );
    return { items: page.items.map(toItem), nextCursor: page.nextCursor };
  }),
  detail: os.detail.handler(async ({ input, context }) => {
    await authorizeRun(context, input.params.id, 'runs.read');
    const detail = await runsRepo.getRunDetail(context.db, input.params.id);
    if (!detail) notFound('run', RUN_MISSING);
    return toRunDetail(detail);
  }),
  feedback: os.feedback.handler(async ({ input, context }) => {
    await authorizeRunFeedback(context, input.params.id, 'runs.read');
    const rows = await repo.runFeedback.listRunFeedback(context.db, input.params.id);
    return { items: rows.map(toFeedback) };
  }),
  submitFeedback: os.submitFeedback.handler(async ({ input, context }) => {
    const { run } = await authorizeRunFeedback(context, input.params.id, 'runs.feedback');
    if (run.status === 'queued' || run.status === 'running') {
      return fail('CONFLICT', '运行尚未结束，暂不能验收');
    }
    const messageId = input.body.messageId ?? null;
    if (messageId !== null) {
      const message = await repo.runFeedback.getRunMessage(context.db, run.id, messageId);
      if (!message) return fail('INVALID_INPUT', '验收消息不属于该运行');
    }
    const outputPath = input.body.outputPath ?? null;
    let outputSha256: string | null = null;
    if (outputPath !== null) {
      const slug = await agentSlug(context.db, run.agentId);
      if (slug === null) return fail('INVALID_INPUT', '验收成果不存在或不属于该运行');
      try {
        const { file } = await readWorkspaceOutput(context, {
          slug,
          conversationId: run.conversationId,
          runId: run.id,
          path: outputPath,
        });
        outputSha256 = file.sha256;
      } catch (error) {
        if (isAppError(error) && (error.code === 'NOT_FOUND' || error.code === 'INVALID_INPUT')) {
          return fail('INVALID_INPUT', '验收成果不存在或不属于该运行');
        }
        throw error;
      }
    }
    const row = await repo.runFeedback.createRunFeedback(context.db, {
      conversationId: run.conversationId,
      runId: run.id,
      messageId,
      outputPath,
      outputSha256,
      decision: input.body.decision,
      rating: input.body.rating ?? null,
      comment: input.body.comment,
      reason: input.body.reason,
      createdBy: requireUser(context).businessId,
    });
    await repo.audit.writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'agent.run.feedback',
      target: run.id,
      input: {
        feedbackId: row.id,
        decision: row.decision,
        rating: row.rating,
        hasMessage: messageId !== null,
        outputPath,
      },
      status: 'ok',
      requestId: context.requestId,
    });
    return toFeedback(row);
  }),
  approvals: os.approvals.handler(async ({ input, context }) => {
    await authorizeRun(context, input.params.id, 'runs.read');
    const rows = await runsRepo.listApprovalRequests(context.db, input.params.id);
    const now = Date.now();
    return {
      items: rows.map((row) => ({
        id: row.id,
        serverId: row.serverId,
        serverName: row.serverName,
        toolName: row.toolName,
        createdAt: row.createdAt.toISOString(),
        approvedAt: row.approvedAt === null ? null : row.approvedAt.toISOString(),
        deniedAt: toIso(row.deniedAt),
        expiresAt: toIso(row.expiresAt),
        waiting:
          row.approvedAt === null &&
          row.deniedAt === null &&
          row.expiresAt !== null &&
          row.expiresAt.getTime() > now,
      })),
    };
  }),
  approve: os.approve.handler(async ({ input, context }) => {
    const { approval, waiting } = await decideRunApproval(
      context,
      input.params.id,
      input.body.approvalId,
      'approve',
    );
    return {
      serverId: approval.serverId,
      toolName: approval.toolName,
      approvedAt: approval.approvedAt?.toISOString() ?? fail('CONFLICT', '工具审批未批准'),
      waiting,
    };
  }),
  deny: os.deny.handler(async ({ input, context }) => {
    const { approval, waiting } = await decideRunApproval(
      context,
      input.params.id,
      input.body.approvalId,
      'deny',
    );
    return {
      serverId: approval.serverId,
      toolName: approval.toolName,
      deniedAt: approval.deniedAt?.toISOString() ?? fail('CONFLICT', '工具审批未拒绝'),
      waiting,
    };
  }),
  skillDraft: os.skillDraft.handler(async ({ input, context }) => {
    await authorizeRun(context, input.params.id, 'runs.read');
    const detail = await runsRepo.getRunDetail(context.db, input.params.id);
    if (!detail) return fail('NOT_FOUND', RUN_NOT_FOUND_MESSAGE);
    const steps = detail.steps.map((s) =>
      s.kind === 'tool' ? { kind: 'tool' as const, name: s.name } : { kind: s.kind, text: s.text },
    );
    const draft = buildSkillDraft({
      agentName: detail.run.agentName ?? '专家',
      runId: detail.run.id,
      steps,
    });
    try {
      const row = await repo.skills.createSkill(context.db, {
        ...draft,
        ownerBusinessId: requireUser(context).businessId,
        status: 'draft',
      });
      await repo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'skill.draft.created',
        target: row.id,
        input: { fromRun: detail.run.id, slug: row.slug, status: row.status },
        status: 'ok',
        requestId: context.requestId,
      });
      return toApiSkill(row);
    } catch (err) {
      if (isPgCode(err, '23505')) return fail('CONFLICT', '同名技能已存在，请先重命名或删除后重试');
      throw err;
    }
  }),
};
export const runExportQuerySchema = z.object({
  agentId: z.string().min(1).optional(),
  status: runStatusSchema.optional(),
  trigger: runTriggerSchema.optional(),
  since: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(1000),
});

export function registerRunExportHttp(app: Hono<HttpEnv>): void {
  app.get(
    '/api/runs/export',
    access({ kind: 'permission', permissionId: 'runs.export' }),
    async (c) => {
      const context = requestContext(c);
      const input = parseRequest(
        c,
        z.object({
          query: runExportQuerySchema,
        }),
      );
      const { agentId, status, trigger, since, limit } = input.query;
      const page = requireCursorPage(
        await runsRepo.listRuns(context.db, {
          ...(agentId === undefined ? {} : { agentId }),
          ...(status === undefined ? {} : { status }),
          ...(trigger === undefined ? {} : { trigger }),
          ...(since === undefined ? {} : { since: new Date(since) }),
          limit,
          access: accessFilter(context, 'runs.export'),
        }),
      );
      if (page.nextCursor !== null) {
        return fail('CONFLICT', `运行记录超过 ${limit} 条，请先按智能体或状态缩小范围后再导出`);
      }
      return attachmentResponse(
        JSON.stringify({
          format: 'agentport/runs@1',
          exportedAt: new Date().toISOString(),
          items: page.items.map(toItem),
        }),
        'runs.json',
        'application/json',
      );
    },
  );
  app.get(
    '/api/runs/:id/export',
    access({ kind: 'permission', permissionId: 'runs.export' }),
    async (c) => {
      const context = requestContext(c);
      const id = c.req.param('id');
      await authorizeRun(context, id, 'runs.export');
      const detail = await runsRepo.getRunDetail(context.db, id);
      if (!detail) notFound('run', RUN_MISSING);
      const body = JSON.stringify({
        format: 'agentport/run-trajectory@1',
        exportedAt: new Date().toISOString(),
        ...toRunDetail(detail),
      });
      return attachmentResponse(body, `run-${id}.json`, 'application/json');
    },
  );
}

export const runsRouter = { ...runsMainRouter, ...runsQuestionsRouter };
