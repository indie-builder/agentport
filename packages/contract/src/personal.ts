import {
  conversationSummarySchema,
  cursorPageSchema,
  pageQuerySchema,
  personalOutputListQuerySchema,
  personalOutputListSchema,
  personalOutputShareListSchema,
  personalRunExportQuerySchema,
  personalRunExportSchema,
  personalRunListQuerySchema,
  personalRunListSchema,
  personalShareListQuerySchema,
  personalUsageQuerySchema,
  personalUsageSummarySchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

const shareParams = z.object({ id: z.string().min(1).max(200) });

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
  exportRuns: contractProcedure
    .route({ method: 'GET', path: '/me/runs/export' })
    .input(z.object({ query: personalRunExportQuerySchema }))
    .output(personalRunExportSchema)
    .meta({ access: { kind: 'permission', permissionId: 'runs.read' } }),
  conversations: contractProcedure
    .route({ method: 'GET', path: '/me/conversations' })
    .input(
      z.object({
        query: pageQuerySchema.extend({
          agentId: z.string().min(1).optional(),
        }),
      }),
    )
    .output(cursorPageSchema(conversationSummarySchema))
    .meta({ access: { kind: 'permission', permissionId: 'conversations.read' } }),
  outputs: contractProcedure
    .route({ method: 'GET', path: '/me/outputs' })
    .input(z.object({ query: personalOutputListQuerySchema }))
    .output(personalOutputListSchema)
    .meta({ access: { kind: 'permission', permissionId: 'conversations.read' } }),
};
