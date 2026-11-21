import { adminPageQuerySchema, auditActorKindSchema, cursorPageSchema } from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

export const auditStatusSchema = z.enum(['ok', 'error', 'denied']);

export const auditQuerySchema = adminPageQuerySchema.extend({
  action: z.string().trim().max(100).optional(),
  status: auditStatusSchema.optional(),
  target: z.string().trim().max(200).optional(),
  actor: z.string().trim().max(200).optional(),
  actorKind: auditActorKindSchema.optional(),
  since: z.iso.datetime().optional(),
  before: z.iso.datetime().optional(),
});

export const auditItemSchema = z.object({
  id: z.string(),
  actor: z.string(),
  actorKind: auditActorKindSchema,
  subjectBusinessId: z.string().nullable(),
  action: z.string(),
  target: z.string().nullable(),
  status: z.string().pipe(auditStatusSchema),
  durationMs: z.number().nullable(),
  requestId: z.string().nullable(),
  inputDigest: z.string().nullable(),
  detail: z.record(z.string(), z.string()).nullable(),
  detailType: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const auditContract = {
  list: contractProcedure
    .route({ method: 'GET', path: '/audit' })
    .input(z.object({ query: auditQuerySchema }))
    .output(cursorPageSchema(auditItemSchema))
    .meta({ access: { kind: 'permission', permissionId: 'audit.read' } }),
  verify: contractProcedure
    .route({ method: 'GET', path: '/audit/verify' })
    .input(
      z.object({
        query: z.object({
          afterSeq: z.coerce.number().int().nonnegative().optional(),
          limit: z.coerce.number().int().positive().max(5000).optional(),
        }),
      }),
    )
    .output(
      z.object({
        ok: z.boolean(),
        checked: z.number().int(),
        brokenSeq: z.string().nullable(),
        nextAfterSeq: z.number().int().nullable(),
        complete: z.boolean(),
      }),
    )
    .meta({ access: { kind: 'permission', permissionId: 'audit.read' } }),
};
