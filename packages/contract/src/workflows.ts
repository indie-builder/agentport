import { agentWorkflowInputSchema, agentWorkflowSchema } from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

const agentParams = z.object({ id: z.string().min(1) });
const workflowParams = z.object({
  id: z.string().min(1),
  workflowId: z.string().min(1),
});
const createBody = agentWorkflowInputSchema.pick({ slug: true, content: true });
const updateBody = z.object({
  content: agentWorkflowInputSchema.shape.content,
  expectedUpdatedAt: z.iso.datetime().optional(),
});

export const workflowsContract = {
  list: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.workflows.read' } })
    .route({ method: 'GET', path: '/agents/{id}/workflows', successStatus: 200 })
    .input(z.object({ params: agentParams }))
    .output(z.array(agentWorkflowSchema)),
  create: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.workflows.write' } })
    .route({ method: 'POST', path: '/agents/{id}/workflows', successStatus: 201 })
    .input(z.object({ params: agentParams, body: createBody }))
    .output(agentWorkflowSchema),
  update: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.workflows.write' } })
    .route({ method: 'PATCH', path: '/agents/{id}/workflows/{workflowId}', successStatus: 200 })
    .input(z.object({ params: workflowParams, body: updateBody }))
    .output(agentWorkflowSchema),
  delete: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.workflows.write' } })
    .route({ method: 'DELETE', path: '/agents/{id}/workflows/{workflowId}', successStatus: 204 })
    .input(z.object({ params: workflowParams }))
    .output(z.void()),
};
