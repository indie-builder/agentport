import {
  cursorPageSchema,
  idParams,
  pageQuerySchema,
  publicQuestionResponseSchema,
  publicRunQuestionSchema,
  runDetailSchema,
  runFeedbackListSchema,
  runFeedbackSchema,
  runListItemSchema,
  runStatusSchema,
  runTriggerSchema,
  skillSchema,
  submitRunFeedbackSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';
export const runsContract = {
  list: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'runs.read' } })
    .route({ method: 'GET', path: '/runs', successStatus: 200 })
    .input(
      z.object({
        query: pageQuerySchema.extend({
          agentId: z.string().min(1).optional(),
          status: runStatusSchema.optional(),
          trigger: runTriggerSchema.optional(),
          since: z.iso.datetime().optional(),
        }),
      }),
    )
    .output(cursorPageSchema(runListItemSchema)),
  detail: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'runs.read' } })
    .route({ method: 'GET', path: '/runs/{id}', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(runDetailSchema),
  feedback: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'runs.read' } })
    .route({ method: 'GET', path: '/runs/{id}/feedback', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(runFeedbackListSchema),
  submitFeedback: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'runs.feedback' } })
    .route({ method: 'POST', path: '/runs/{id}/feedback', successStatus: 201 })
    .input(z.object({ params: idParams, body: submitRunFeedbackSchema }))
    .output(runFeedbackSchema),
  approvals: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'runs.read' } })
    .route({ method: 'GET', path: '/runs/{id}/approvals', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(
      z.object({
        items: z.array(
          z.object({
            id: z.string(),
            serverId: z.string(),
            serverName: z.string().nullable(),
            toolName: z.string(),
            createdAt: z.string(),
            approvedAt: z.string().nullable(),
            deniedAt: z.string().nullable(),
            expiresAt: z.string().nullable(),
            waiting: z.boolean(),
          }),
        ),
      }),
    ),
  approve: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'runs.approve' } })
    .route({ method: 'POST', path: '/runs/{id}/approve', successStatus: 200 })
    .input(
      z.object({
        params: idParams,
        body: z.object({ serverId: z.string().min(1), toolName: z.string().min(1) }),
      }),
    )
    .output(
      z.object({
        serverId: z.string(),
        toolName: z.string(),
        approvedAt: z.string(),
        waiting: z.boolean(),
      }),
    ),
  deny: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'runs.approve' } })
    .route({ method: 'POST', path: '/runs/{id}/deny', successStatus: 200 })
    .input(
      z.object({
        params: idParams,
        body: z.object({ serverId: z.string().min(1), toolName: z.string().min(1) }),
      }),
    )
    .output(
      z.object({
        serverId: z.string(),
        toolName: z.string(),
        deniedAt: z.string(),
        waiting: z.boolean(),
      }),
    ),
  skillDraft: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'skills.create' } })
    .route({ method: 'POST', path: '/runs/{id}/skill-draft', successStatus: 201 })
    .input(z.object({ params: idParams }))
    .output(skillSchema),
  questions: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'runs.read' } })
    .route({ method: 'GET', path: '/runs/{id}/questions', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(z.object({ items: z.array(publicRunQuestionSchema) })),
  respondToQuestion: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'runs.questions.answer' } })
    .route({
      method: 'POST',
      path: '/runs/{id}/questions/{requestId}/response',
      successStatus: 200,
    })
    .input(
      z.object({
        params: idParams.extend({ requestId: z.string().min(1).max(256) }),
        body: publicQuestionResponseSchema,
      }),
    )
    .output(publicRunQuestionSchema),
};
