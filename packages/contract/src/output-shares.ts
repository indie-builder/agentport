import {
  createOutputShareInputSchema,
  outputOwnerIdSchema,
  outputPathSchema,
  outputShareSchema,
  publicOutputShareSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

const ownerParams = z.object({ id: outputOwnerIdSchema });
const shareParams = z.object({ id: z.string().min(1).max(200) });
const tripleQuery = z.object({ runId: outputOwnerIdSchema, path: outputPathSchema });

export const outputShareListSchema = z.object({ items: z.array(outputShareSchema) });

export const publicOutputContentSchema = z.object({
  file: publicOutputShareSchema.shape.file,
  content: z.string(),
});

const shareAccess = {
  kind: 'service',
  boundary: 'share-token',
  reason: 'public share authenticates with the link token, not a session',
} as const;

export const outputSharesContract = {
  create: contractProcedure
    .route({ method: 'POST', path: '/conversations/{id}/output-shares', successStatus: 201 })
    .input(z.object({ params: ownerParams, body: createOutputShareInputSchema }))
    .output(outputShareSchema)
    .meta({ access: { kind: 'permission', permissionId: 'conversations.share' } }),
  list: contractProcedure
    .route({ method: 'GET', path: '/conversations/{id}/output-shares' })
    .input(z.object({ params: ownerParams, query: tripleQuery }))
    .output(outputShareListSchema)
    .meta({ access: { kind: 'permission', permissionId: 'conversations.share' } }),
  revoke: contractProcedure
    .route({ method: 'DELETE', path: '/output-shares/{id}', successStatus: 204 })
    .input(z.object({ params: shareParams }))
    .output(z.void())
    .meta({ access: { kind: 'permission', permissionId: 'conversations.share' } }),
  publicMetadata: contractProcedure
    .route({ method: 'GET', path: '/public/output-shares/{id}' })
    .input(z.object({ params: shareParams }))
    .output(publicOutputShareSchema)
    .meta({ access: shareAccess }),
  publicContent: contractProcedure
    .route({ method: 'GET', path: '/public/output-shares/{id}/content' })
    .input(z.object({ params: shareParams }))
    .output(publicOutputContentSchema)
    .meta({ access: shareAccess }),
};
