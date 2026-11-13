import { z } from 'zod';
import { contractProcedure } from './base.js';

export const auditStatusSchema = z.enum(['ok', 'error', 'denied']);

export const auditActorKindSchema = z.enum(['user', 'service', 'anonymous', 'agent']);

export const auditQuerySchema = z.object({
  action: z.string().trim().max(100).optional(),
  status: auditStatusSchema.optional(),
  target: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  before: z.iso.datetime().optional(),
  beforeId: z.string().trim().min(1).max(200).optional(),
});

export const auditItemSchema = z.object({
  id: z.string(),
  actor: z.string(),
  actorKind: auditActorKindSchema,
  action: z.string(),
  target: z.string().nullable(),
  status: z.string().pipe(auditStatusSchema),
  durationMs: z.number().nullable(),
  requestId: z.string().nullable(),
  inputDigest: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const auditContract = {
  list: contractProcedure
    .route({ method: 'GET', path: '/audit' })
    .input(z.object({ query: auditQuerySchema }))
    .output(z.object({ items: z.array(auditItemSchema) }))
    .meta({ access: { kind: 'permission', permissionId: 'audit.read' } }),
  verify: contractProcedure
    .route({ method: 'GET', path: '/audit/verify' })
    .output(
      z.object({
        ok: z.boolean(),
        checked: z.number().int(),
        brokenSeq: z.string().nullable(),
      }),
    )
    .meta({ access: { kind: 'permission', permissionId: 'audit.read' } }),
};
