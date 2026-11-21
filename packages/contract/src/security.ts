import {
  contentPolicyActionSchema,
  contentPolicyCreateSchema,
  contentPolicySchema,
  contentPolicyUpdateSchema,
  cursorPageSchema,
  idParams,
  pageQuerySchema,
  policyApprovalDecisionSchema,
  policyApprovalSchema,
  policyApprovalStatusSchema,
  policyEventSchema,
  policySourceKindSchema,
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

const eventListQuery = pageQuerySchema.extend({
  sourceKind: policySourceKindSchema.optional(),
  action: contentPolicyActionSchema.optional(),
});

const approvalListQuery = pageQuerySchema.extend({
  status: policyApprovalStatusSchema.default('pending'),
});

const violationListQuery = pageQuerySchema.extend({
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
      .output(cursorPageSchema(policyEventSchema)),
  },
  approvals: {
    list: read
      .route({ method: 'GET', path: '/security/approvals' })
      .input(z.object({ query: approvalListQuery }))
      .output(cursorPageSchema(policyApprovalSchema)),
    decide: manage
      .route({ method: 'POST', path: '/security/approvals/{id}/decision' })
      .input(z.object({ params: idParams, body: policyApprovalDecisionSchema }))
      .output(policyApprovalSchema),
  },
  violations: {
    list: read
      .route({ method: 'GET', path: '/security/violations' })
      .input(z.object({ query: violationListQuery }))
      .output(cursorPageSchema(violationCaseSchema)),
    update: manage
      .route({ method: 'PATCH', path: '/security/violations/{id}' })
      .input(z.object({ params: idParams, body: violationCaseUpdateSchema }))
      .output(violationCaseSchema),
  },
};
