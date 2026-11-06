import {
  chatRequestSchema,
  conversationBranchSchema,
  conversationDetailSchema,
  conversationRenameSchema,
  conversationSearchQuerySchema,
  conversationSearchResponseSchema,
  conversationSummarySchema,
  idParams,
  messageAttachmentSchema,
  openUiToolResultSchema,
  outputFileSchema,
  outputListSchema,
  outputOwnerIdSchema,
  outputPathSchema,
  publicConversationSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';
export const chatContract = {
  startRun: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'conversations.create' }, rateLimit: 20 })
    .route({ method: 'POST', path: '/chat', successStatus: 202, outputStructure: 'detailed' })
    .input(z.object({ body: chatRequestSchema }))
    .output(
      z.union([
        z.object({
          status: z.literal(202),
          body: z.object({
            runId: z.string(),
            conversationId: z.string(),
            attachments: z.array(messageAttachmentSchema).optional(),
          }),
        }),
        z.object({ status: z.literal(204), body: z.undefined() }),
      ]),
    ),
  searchConversations: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'conversations.read' } })
    .route({ method: 'GET', path: '/conversations/search', successStatus: 200 })
    .input(z.object({ query: conversationSearchQuerySchema }))
    .output(conversationSearchResponseSchema),
  conversation: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'conversations.read' } })
    .route({ method: 'GET', path: '/conversations/{id}', successStatus: 200 })
    .input(
      z.object({
        params: idParams,
        query: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          before: z.string().min(1).optional(),
        }),
      }),
    )
    .output(conversationDetailSchema),
  renameConversation: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'conversations.update' } })
    .route({ method: 'PATCH', path: '/conversations/{id}', successStatus: 200 })
    .input(z.object({ params: idParams, body: conversationRenameSchema }))
    .output(publicConversationSchema),
  deleteConversation: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'conversations.delete' } })
    .route({ method: 'DELETE', path: '/conversations/{id}', successStatus: 204 })
    .input(z.object({ params: idParams }))
    .output(z.undefined()),
  cancelRun: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'runs.cancel' } })
    .route({ method: 'POST', path: '/chat/{runId}/cancel', successStatus: 202 })
    .input(z.object({ params: z.object({ runId: z.string().min(1) }) }))
    .output(z.object({ ok: z.literal(true) })),
  branchConversation: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'conversations.create' } })
    .route({ method: 'POST', path: '/conversations/{id}/branch', successStatus: 201 })
    .input(
      z.object({
        params: idParams,
        body: z.object({ fromMessageId: z.string().min(1).optional() }),
      }),
    )
    .output(conversationBranchSchema),
  listConversations: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'conversations.read' } })
    .route({ method: 'GET', path: '/conversations', successStatus: 200 })
    .input(
      z.object({
        query: z.object({
          agentId: z.string().min(1).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      }),
    )
    .output(z.array(conversationSummarySchema)),
  saveOpenuiState: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'conversations.update' } })
    .route({
      method: 'PUT',
      path: '/conversations/{conversationId}/messages/{messageId}/openui-state',
      successStatus: 200,
    })
    .input(
      z.object({
        params: z.object({
          conversationId: z.string().min(1),
          messageId: z.string().min(1),
        }),
        body: z.object({
          blockKey: z.string().min(1).max(256),
          state: z.record(z.string(), z.unknown()),
        }),
      }),
    )
    .output(z.object({ version: z.literal(1), blockKey: z.string() })),
  callOpenuiTool: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'conversations.update' }, rateLimit: 60 })
    .route({
      method: 'POST',
      path: '/chat/{conversationId}/openui/tools/{toolName}',
      successStatus: 200,
      outputStructure: 'detailed',
    })
    .input(
      z.object({
        params: z.object({
          conversationId: z.string().min(1),
          toolName: z.string().min(1),
        }),
        body: z.object({
          args: z.record(z.string(), z.unknown()).default({}),
          messageId: z.string().min(1),
          blockKey: z.string().min(1).max(256),
        }),
      }),
    )
    .output(
      z.union([
        z.object({ status: z.literal(202), body: openUiToolResultSchema }),
        z.object({ status: z.literal(200), body: openUiToolResultSchema }),
      ]),
    ),
  approveOpenuiTool: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'runs.approve' } })
    .route({
      method: 'POST',
      path: '/chat/{conversationId}/openui/approvals/{approvalId}/approve',
      successStatus: 200,
    })
    .input(
      z.object({
        params: z.object({
          conversationId: z.string().min(1),
          approvalId: z.string().min(1),
        }),
      }),
    )
    .output(
      z.object({
        approvalId: z.string(),
        approvedAt: z.string().nullable(),
        expiresAt: z.string().nullable(),
      }),
    ),
  listOutputs: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'conversations.read' } })
    .route({ method: 'GET', path: '/conversations/{id}/outputs', successStatus: 200 })
    .input(
      z.object({
        params: z.object({ id: outputOwnerIdSchema }),
        query: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          before: z.string().min(1).optional(),
        }),
      }),
    )
    .output(outputListSchema),
  output: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'conversations.read' } })
    .route({ method: 'GET', path: '/conversations/{id}/outputs/{runId}', successStatus: 200 })
    .input(
      z.object({
        params: z.object({ id: outputOwnerIdSchema, runId: outputOwnerIdSchema }),
        query: z.object({ path: outputPathSchema }),
      }),
    )
    .output(z.object({ file: outputFileSchema })),
};
