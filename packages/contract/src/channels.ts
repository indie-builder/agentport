import {
  channelAgentBindingSchema,
  channelAgentInputSchema,
  channelCreateSchema,
  channelDetailSchema,
  channelListItemSchema,
  channelMemberInputSchema,
  channelMemberSchema,
  channelMessageInputSchema,
  channelMessageSchema,
  channelMessagesQuerySchema,
  channelReadInputSchema,
  channelReadStateSchema,
  channelRoleSchema,
  channelSchema,
  channelUpdateSchema,
  idParams,
  outputContentSchema,
  outputListSchema,
  outputPathSchema,
  publicQuestionResponseSchema,
  publicRunQuestionSchema,
  runDetailSchema,
  runStatusSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

const channelApprovalSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  runId: z.string(),
  serverId: z.string(),
  serverName: z.string().nullable(),
  toolName: z.string(),
  argumentsSummary: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  approvedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
});
const channelRunParams = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
});
export const channelsContract = {
  list: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'GET', path: '/channels', successStatus: 200 })
    .input(z.object({}))
    .output(z.array(channelListItemSchema)),
  create: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'POST', path: '/channels', successStatus: 201 })
    .input(z.object({ body: channelCreateSchema }))
    .output(channelSchema),
  detail: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'GET', path: '/channels/{id}', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(channelDetailSchema),
  update: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'PATCH', path: '/channels/{id}', successStatus: 200 })
    .input(z.object({ params: idParams, body: channelUpdateSchema }))
    .output(channelSchema),
  addMember: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'POST', path: '/channels/{id}/members', successStatus: 201 })
    .input(z.object({ params: idParams, body: channelMemberInputSchema }))
    .output(channelMemberSchema),
  updateMember: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'PATCH', path: '/channels/{id}/members/{businessId}', successStatus: 200 })
    .input(
      z.object({
        params: z.object({ id: z.string().min(1), businessId: z.string().min(1) }),
        body: z.object({ role: channelRoleSchema }),
      }),
    )
    .output(channelMemberSchema),
  removeMember: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'DELETE', path: '/channels/{id}/members/{businessId}', successStatus: 204 })
    .input(z.object({ params: z.object({ id: z.string().min(1), businessId: z.string().min(1) }) }))
    .output(z.undefined()),
  addAgent: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'POST', path: '/channels/{id}/agents', successStatus: 201 })
    .input(z.object({ params: idParams, body: channelAgentInputSchema }))
    .output(channelAgentBindingSchema),
  removeAgent: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'DELETE', path: '/channels/{id}/agents/{agentId}', successStatus: 204 })
    .input(z.object({ params: z.object({ id: z.string().min(1), agentId: z.string().min(1) }) }))
    .output(z.undefined()),
  messages: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'GET', path: '/channels/{id}/messages', successStatus: 200 })
    .input(z.object({ params: idParams, query: channelMessagesQuerySchema }))
    .output(z.array(channelMessageSchema)),
  postMessage: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({
      method: 'POST',
      path: '/channels/{id}/messages',
      successStatus: 200,
      outputStructure: 'detailed',
    })
    .input(z.object({ params: idParams, body: channelMessageInputSchema }))
    .output(
      z.union([
        z.object({ status: z.literal(200), body: channelMessageSchema }),
        z.object({ status: z.literal(201), body: channelMessageSchema }),
      ]),
    ),
  markRead: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'POST', path: '/channels/{id}/read', successStatus: 200 })
    .input(z.object({ params: idParams, body: channelReadInputSchema }))
    .output(channelReadStateSchema),
  activeRuns: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'GET', path: '/channels/{id}/runs', successStatus: 200 })
    .input(
      z.object({
        params: idParams,
        query: z.object({
          status: z.literal('active').default('active'),
        }),
      }),
    )
    .output(
      z.object({
        items: z.array(
          z.object({
            runId: z.string(),
            agentId: z.string(),
            status: runStatusSchema,
            initiatedBy: z.string().nullable(),
            startedAt: z.string().nullable(),
          }),
        ),
      }),
    ),
  stopRun: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'POST', path: '/channels/{id}/runs/{runId}/stop', successStatus: 202 })
    .input(z.object({ params: z.object({ id: z.string().min(1), runId: z.string().min(1) }) }))
    .output(z.object({ ok: z.literal(true) })),
  runDetail: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'GET', path: '/channels/{id}/runs/{runId}', successStatus: 200 })
    .input(z.object({ params: channelRunParams }))
    .output(runDetailSchema),
  runQuestions: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'GET', path: '/channels/{id}/runs/{runId}/questions', successStatus: 200 })
    .input(z.object({ params: channelRunParams }))
    .output(z.object({ items: z.array(publicRunQuestionSchema) })),
  respondToRunQuestion: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({
      method: 'POST',
      path: '/channels/{id}/runs/{runId}/questions/{requestId}/response',
      successStatus: 200,
    })
    .input(
      z.object({
        params: channelRunParams.extend({ requestId: z.string().min(1).max(256) }),
        body: publicQuestionResponseSchema,
      }),
    )
    .output(publicRunQuestionSchema),
  runOutputs: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'GET', path: '/channels/{id}/runs/{runId}/outputs', successStatus: 200 })
    .input(
      z.object({
        params: channelRunParams,
        query: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          before: z.string().min(1).optional(),
        }),
      }),
    )
    .output(outputListSchema),
  runOutputContent: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({
      method: 'GET',
      path: '/channels/{id}/runs/{runId}/outputs/content',
      successStatus: 200,
    })
    .input(z.object({ params: channelRunParams, query: z.object({ path: outputPathSchema }) }))
    .output(outputContentSchema),
  disconnectAgent: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({
      method: 'POST',
      path: '/channels/{id}/agents/{agentId}/disconnect',
      successStatus: 204,
    })
    .input(z.object({ params: z.object({ id: z.string().min(1), agentId: z.string().min(1) }) }))
    .output(z.undefined()),
  close: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'POST', path: '/channels/{id}/close', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(z.object({ id: z.string(), archivedAt: z.string() })),
  approvals: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'GET', path: '/channels/{id}/approvals', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(z.object({ items: z.array(channelApprovalSchema) })),
  approve: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({
      method: 'POST',
      path: '/channels/{id}/approvals/{approvalId}/approve',
      successStatus: 200,
    })
    .input(z.object({ params: z.object({ id: z.string().min(1), approvalId: z.string().min(1) }) }))
    .output(channelApprovalSchema),
};
