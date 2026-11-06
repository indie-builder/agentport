import {
  evalCaseFieldsSchema,
  evalComparisonSchema,
  evalDatasetSchema,
  evalRunDetailSchema,
  evalRunListQuerySchema,
  evalRunPageSchema,
  idParams,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

export const evalCaseSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  name: z.string(),
  prompt: z.string(),
  expectation: z.string(),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
});

export const createEvalCaseSchema = evalCaseFieldsSchema.extend({ agentId: z.string().min(1) });

export const patchEvalCaseSchema = createEvalCaseSchema
  .omit({ agentId: true })
  .partial()
  .extend({ expectation: evalCaseFieldsSchema.shape.expectation.removeDefault().optional() });

export const evalDatasetImportResultSchema = z.object({
  imported: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});

export const evalCaseListQuerySchema = z.object({ agentId: z.string().min(1).optional() });

export const evalCaseExportQuerySchema = z.object({ agentId: z.string().min(1) });

export const evalImportBodySchema = z.object({
  agentId: z.string().min(1),
  dataset: evalDatasetSchema,
});

export const evalContract = {
  cases: {
    list: contractProcedure
      .route({ method: 'GET', path: '/eval/cases' })
      .input(z.object({ query: evalCaseListQuerySchema }))
      .output(z.array(evalCaseSchema))
      .meta({ access: { kind: 'permission', permissionId: 'eval.read' } }),
    create: contractProcedure
      .route({ method: 'POST', path: '/eval/cases', successStatus: 201 })
      .input(z.object({ body: createEvalCaseSchema }))
      .output(evalCaseSchema)
      .meta({ access: { kind: 'permission', permissionId: 'eval.manage' } }),
    update: contractProcedure
      .route({ method: 'PATCH', path: '/eval/cases/{id}' })
      .input(z.object({ params: idParams, body: patchEvalCaseSchema }))
      .output(evalCaseSchema)
      .meta({ access: { kind: 'permission', permissionId: 'eval.manage' } }),
    remove: contractProcedure
      .route({ method: 'DELETE', path: '/eval/cases/{id}', successStatus: 204 })
      .input(z.object({ params: idParams }))
      .output(z.void())
      .meta({ access: { kind: 'permission', permissionId: 'eval.manage' } }),
    import: contractProcedure
      .route({ method: 'POST', path: '/eval/cases/import', successStatus: 201 })
      .input(z.object({ body: evalImportBodySchema }))
      .output(evalDatasetImportResultSchema)
      .meta({ access: { kind: 'permission', permissionId: 'eval.manage' } }),
  },
  runs: {
    list: contractProcedure
      .route({ method: 'GET', path: '/eval/runs' })
      .input(z.object({ query: evalRunListQuerySchema }))
      .output(evalRunPageSchema)
      .meta({ access: { kind: 'permission', permissionId: 'eval.read' } }),
    create: contractProcedure
      .route({ method: 'POST', path: '/eval/runs', successStatus: 202 })
      .input(z.object({ body: z.object({ agentId: z.string().min(1) }) }))
      .output(z.object({ evalRunId: z.string() }))
      .meta({
        access: { kind: 'permission', permissionId: 'eval.execute' },
        rateLimit: 10,
      }),
    cancel: contractProcedure
      .route({ method: 'POST', path: '/eval/runs/{id}/cancel', successStatus: 202 })
      .input(z.object({ params: idParams }))
      .output(z.object({ ok: z.literal(true) }))
      .meta({ access: { kind: 'permission', permissionId: 'eval.manage' } }),
    compare: contractProcedure
      .route({ method: 'GET', path: '/eval/runs/{id}/compare' })
      .input(z.object({ params: idParams, query: z.object({ head: z.string().min(1) }) }))
      .output(evalComparisonSchema)
      .meta({ access: { kind: 'permission', permissionId: 'eval.read' } }),
    detail: contractProcedure
      .route({ method: 'GET', path: '/eval/runs/{id}' })
      .input(z.object({ params: idParams }))
      .output(evalRunDetailSchema)
      .meta({ access: { kind: 'permission', permissionId: 'eval.read' } }),
  },
};
