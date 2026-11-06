import {
  createMemoryReviewInputSchema,
  memoryChangeSchema,
  memoryReviewSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

const runParams = z.object({ runId: z.string().min(1) });

export const memoryReviewListQuerySchema = z.object({
  conversationId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const memoryReviewListSchema = z.object({ items: z.array(memoryReviewSchema) });

export const memoryReviewCreateQuerySchema = z.object({ scope: z.literal('own').optional() });

export const memoryReviewCreateResponseSchema = z.object({ runId: z.string() });

export const memoryReviewDecisionSchema = z.object({ decision: z.literal('rejected') });

export const memoryReviewsContract = {
  create: contractProcedure
    .route({ method: 'POST', path: '/memory-reviews', successStatus: 202 })
    .input(
      z.object({
        query: memoryReviewCreateQuerySchema,
        body: createMemoryReviewInputSchema,
      }),
    )
    .output(memoryReviewCreateResponseSchema)
    .meta({ access: { kind: 'permission', permissionId: 'personal_memory.review' } }),
  list: contractProcedure
    .route({ method: 'GET', path: '/memory-reviews' })
    .input(z.object({ query: memoryReviewListQuerySchema }))
    .output(memoryReviewListSchema)
    .meta({ access: { kind: 'permission', permissionId: 'personal_memory.read' } }),
  detail: contractProcedure
    .route({ method: 'GET', path: '/memory-reviews/{runId}' })
    .input(z.object({ params: runParams }))
    .output(memoryReviewSchema)
    .meta({ access: { kind: 'permission', permissionId: 'personal_memory.read' } }),
  apply: contractProcedure
    .route({ method: 'POST', path: '/memory-reviews/{runId}/apply' })
    .input(z.object({ params: runParams }))
    .output(memoryChangeSchema)
    .meta({ access: { kind: 'permission', permissionId: 'personal_memory.write' } }),
  decide: contractProcedure
    .route({ method: 'PATCH', path: '/memory-reviews/{runId}' })
    .input(z.object({ params: runParams, body: memoryReviewDecisionSchema }))
    .output(memoryReviewSchema)
    .meta({ access: { kind: 'permission', permissionId: 'personal_memory.review' } }),
};
