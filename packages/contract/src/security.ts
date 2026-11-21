import {
  contentPolicyActionSchema,
  contentPolicyCreateSchema,
  contentPolicySchema,
  contentPolicyUpdateSchema,
  idParams,
  policyApprovalDecisionSchema,
  policyApprovalSchema,
  policyApprovalStatusSchema,
  policyEventSchema,
  policySourceKindSchema,
  toolApprovalPolicyCreateSchema,
  toolApprovalPolicySchema,
  toolApprovalPolicyUpdateSchema,
  violationCaseSchema,
  violationCaseStatusSchema,
  violationCaseUpdateSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

const read = contractProcedure.meta({
  access: { kind: 'permission', permissionId: 'security.read' },
});
const manage = contractProcedure.meta({
  access: { kind: 'permission', permissionId: 'security.manage' },
});

const pageQuery = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
};

const eventListQuery = z.object({
  ...pageQuery,
  sourceKind: policySourceKindSchema.optional(),
  action: contentPolicyActionSchema.optional(),
});

const approvalListQuery = z.object({
  ...pageQuery,
  status: policyApprovalStatusSchema.default('pending'),
});

const violationListQuery = z.object({
  ...pageQuery,
  status: violationCaseStatusSchema.optional(),
});

export const securityContract = {
  policies: {
    list: read
      .route({ method: 'GET', path: '/security/policies' })
      .output(z.array(contentPolicySchema)),
    create: manage
      .route({ method: 'POST', path: '/security/policies', successStatus: 201 })
      .input(z.object({ body: contentPolicyCreateSchema }))
      .output(contentPolicySchema),
    update: manage
      .route({ method: 'PATCH', path: '/security/policies/{id}' })
      .input(z.object({ params: idParams, body: contentPolicyUpdateSchema }))
      .output(contentPolicySchema),
    remove: manage
      .route({ method: 'DELETE', path: '/security/policies/{id}', successStatus: 204 })
      .input(z.object({ params: idParams }))
      .output(z.void()),
  },
  events: {
    list: read
      .route({ method: 'GET', path: '/security/events' })
      .input(z.object({ query: eventListQuery }))
      .output(z.object({ items: z.array(policyEventSchema), nextCursor: z.string().nullable() })),
  },
  approvals: {
    list: read
      .route({ method: 'GET', path: '/security/approvals' })
      .input(z.object({ query: approvalListQuery }))
      .output(
        z.object({ items: z.array(policyApprovalSchema), nextCursor: z.string().nullable() }),
      ),
    decide: manage
      .route({ method: 'POST', path: '/security/approvals/{id}/decision' })
      .input(z.object({ params: idParams, body: policyApprovalDecisionSchema }))
      .output(policyApprovalSchema),
  },
  violations: {
    list: read
      .route({ method: 'GET', path: '/security/violations' })
      .input(z.object({ query: violationListQuery }))
      .output(z.object({ items: z.array(violationCaseSchema), nextCursor: z.string().nullable() })),
    update: manage
      .route({ method: 'PATCH', path: '/security/violations/{id}' })
      .input(z.object({ params: idParams, body: violationCaseUpdateSchema }))
      .output(violationCaseSchema),
  },
  toolPolicies: {
    list: read
      .route({ method: 'GET', path: '/security/tool-policies' })
      .output(z.array(toolApprovalPolicySchema)),
    create: manage
      .route({ method: 'POST', path: '/security/tool-policies', successStatus: 201 })
      .input(z.object({ body: toolApprovalPolicyCreateSchema }))
      .output(toolApprovalPolicySchema),
    update: manage
      .route({ method: 'PATCH', path: '/security/tool-policies/{id}' })
      .input(z.object({ params: idParams, body: toolApprovalPolicyUpdateSchema }))
      .output(toolApprovalPolicySchema),
    remove: manage
      .route({ method: 'DELETE', path: '/security/tool-policies/{id}', successStatus: 204 })
      .input(z.object({ params: idParams }))
      .output(z.void()),
  },
};
