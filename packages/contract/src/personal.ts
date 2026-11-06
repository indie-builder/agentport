import {
  conversationSummarySchema,
  personalOutputShareListSchema,
  personalRunListQuerySchema,
  personalRunListSchema,
  personalShareListQuerySchema,
  personalUsageQuerySchema,
  personalUsageSummarySchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

const shareParams = z.object({ id: z.string().min(1).max(200) });

export const personalConversationsQuerySchema = z.object({
  agentId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const personalContract = {
  outputShares: contractProcedure
    .route({ method: 'GET', path: '/me/output-shares' })
    .input(z.object({ query: personalShareListQuerySchema }))
    .output(personalOutputShareListSchema)
    .meta({ access: { kind: 'permission', permissionId: 'conversations.share' } }),
  revokeOutputShare: contractProcedure
    .route({ method: 'DELETE', path: '/me/output-shares/{id}', successStatus: 204 })
    .input(z.object({ params: shareParams }))
    .output(z.void())
    .meta({ access: { kind: 'permission', permissionId: 'conversations.share' } }),
  usage: contractProcedure
    .route({ method: 'GET', path: '/me/usage' })
    .input(z.object({ query: personalUsageQuerySchema }))
    .output(personalUsageSummarySchema)
    .meta({ access: { kind: 'permission', permissionId: 'overview.read' } }),
  runs: contractProcedure
    .route({ method: 'GET', path: '/me/runs' })
    .input(z.object({ query: personalRunListQuerySchema }))
    .output(personalRunListSchema)
    .meta({ access: { kind: 'permission', permissionId: 'runs.read' } }),
  conversations: contractProcedure
    .route({ method: 'GET', path: '/me/conversations' })
    .input(z.object({ query: personalConversationsQuerySchema }))
    .output(z.array(conversationSummarySchema))
    .meta({ access: { kind: 'permission', permissionId: 'conversations.read' } }),
};
