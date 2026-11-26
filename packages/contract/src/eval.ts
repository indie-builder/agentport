import {
  cursorPageSchema,
  evalCaseFieldsSchema,
  evalComparisonSchema,
  evalDatasetImportResultSchema,
  evalDatasetSchema,
  evalJudgeModeSchema,
  evalRunDetailSchema,
  evalRunListQuerySchema,
  evalRunPageSchema,
  evalToolNamesSchema,
  idParams,
  pageQuerySchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';
import { domainErrors } from './errors.js';

export const evalCaseSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  name: z.string(),
  prompt: z.string(),
  expectation: z.string(),
  judgeMode: evalJudgeModeSchema,
  expectedTools: evalToolNamesSchema.nullable(),
  forbiddenTools: evalToolNamesSchema.nullable(),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
});

export const createEvalCaseSchema = evalCaseFieldsSchema.extend({ agentId: z.string().min(1) });

export const patchEvalCaseSchema = createEvalCaseSchema.omit({ agentId: true }).partial().extend({
  expectation: evalCaseFieldsSchema.shape.expectation.removeDefault().optional(),
  judgeMode: evalJudgeModeSchema.optional(),
});

export const evalCaseListQuerySchema = pageQuerySchema.extend({
  agentId: z.string().min(1).optional(),
});

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
      .output(cursorPageSchema(evalCaseSchema))
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
    fromRun: contractProcedure
      .errors(domainErrors('CONFLICT'))
      .route({ method: 'POST', path: '/eval/cases/from-run', successStatus: 201 })
      .input(
        z.object({
          body: z.object({
            runId: z.string().min(1),
            name: z.string().trim().min(1).max(128).optional(),
            expectation: z.string().trim().min(1).max(5000),
            judgeMode: evalJudgeModeSchema.default('contains'),
            confirmed: z.literal(true),
            feedbackId: z.string().min(1).max(200).optional(),
          }),
        }),
      )
      .output(evalCaseSchema)
      .meta({ access: { kind: 'permission', permissionId: 'eval.manage' } }),
    sampleCandidates: contractProcedure
      .route({ method: 'GET', path: '/eval/cases/sample-candidates' })
      .input(
        z.object({
          query: z.object({
            agentId: z.string().min(1),
            limit: z.coerce.number().int().min(1).max(50).default(10),
          }),
        }),
      )
      .output(
        z.array(
          z.object({
            runId: z.string(),
            conversationId: z.string(),
            title: z.string(),
            prompt: z.string(),
            endedAt: z.string(),
          }),
        ),
      )
      .meta({ access: { kind: 'permission', permissionId: 'eval.read' } }),
  },
  runs: {
    list: contractProcedure
      .route({ method: 'GET', path: '/eval/runs' })
      .input(z.object({ query: evalRunListQuerySchema }))
      .output(evalRunPageSchema)
      .meta({ access: { kind: 'permission', permissionId: 'eval.read' } }),
    create: contractProcedure
      .route({ method: 'POST', path: '/eval/runs', successStatus: 202 })
      .errors(domainErrors('EVAL_RUN_IN_PROGRESS'))
      .input(
        z.object({
          body: z.object({
            agentId: z.string().min(1),
            target: z.enum(['published', 'draft']).default('published'),
          }),
        }),
      )
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
      .errors(domainErrors('EVAL_RUN_IN_PROGRESS'))
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
