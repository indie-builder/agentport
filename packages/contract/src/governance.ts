import {
  adminPageQuerySchema,
  alertSettingsSchema,
  budgetInputSchema,
  budgetStatusSchema,
  businessIdSchema,
  costGroupBySchema,
  costSummarySchema,
  cursorPageSchema,
  departmentInputSchema,
  departmentMembersInputSchema,
  departmentSchema,
  governanceIdentitySchema,
  governanceResourceSchema,
  handoverChecklistSchema,
  handoverTransferInputSchema,
  handoverTransferResultSchema,
  idParams,
  resourceGrantInputSchema,
  resourceGrantSchema,
  resourceKindSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';
import { domainErrors } from './errors.js';

const read = contractProcedure.meta({
  access: { kind: 'permission', permissionId: 'governance.read' },
});
const manage = contractProcedure.meta({
  access: { kind: 'permission', permissionId: 'governance.manage' },
});
const resourceQuery = z.object({ resourceKind: resourceKindSchema, resourceId: z.string().min(1) });
const businessParams = z.object({ businessId: businessIdSchema });

export const governanceContract = {
  departments: {
    list: read
      .route({ method: 'GET', path: '/governance/departments' })
      .input(z.object({ query: adminPageQuerySchema }))
      .output(cursorPageSchema(departmentSchema)),
    create: manage
      .errors(domainErrors('CONFLICT'))
      .route({ method: 'POST', path: '/governance/departments', successStatus: 201 })
      .input(z.object({ body: departmentInputSchema }))
      .output(departmentSchema),
    update: manage
      .errors(domainErrors('CONFLICT'))
      .route({ method: 'PATCH', path: '/governance/departments/{id}' })
      .input(z.object({ params: idParams, body: departmentInputSchema }))
      .output(departmentSchema),
    remove: manage
      .route({ method: 'DELETE', path: '/governance/departments/{id}', successStatus: 204 })
      .input(z.object({ params: idParams }))
      .output(z.void()),
    members: manage
      .route({ method: 'PUT', path: '/governance/departments/{id}/members' })
      .input(z.object({ params: idParams, body: departmentMembersInputSchema }))
      .output(departmentSchema),
  },
  budgets: {
    list: read
      .route({ method: 'GET', path: '/governance/budgets' })
      .input(z.object({ query: adminPageQuerySchema }))
      .output(cursorPageSchema(budgetStatusSchema)),
    upsert: manage
      .route({ method: 'PUT', path: '/governance/budgets' })
      .input(z.object({ body: budgetInputSchema }))
      .output(budgetStatusSchema),
    remove: manage
      .route({ method: 'DELETE', path: '/governance/budgets/{id}', successStatus: 204 })
      .input(z.object({ params: idParams }))
      .output(z.void()),
  },
  resourceGrants: {
    list: read
      .route({ method: 'GET', path: '/governance/resource-grants' })
      .input(z.object({ query: resourceQuery }))
      .output(z.array(resourceGrantSchema)),
    upsert: manage
      .route({ method: 'PUT', path: '/governance/resource-grants' })
      .input(z.object({ body: resourceGrantInputSchema }))
      .output(resourceGrantSchema),
    remove: manage
      .route({ method: 'DELETE', path: '/governance/resource-grants', successStatus: 204 })
      .input(z.object({ query: resourceQuery.extend({ businessId: businessIdSchema }) }))
      .output(z.void()),
  },
  resources: read
    .route({ method: 'GET', path: '/governance/resources' })
    .input(
      z.object({
        query: adminPageQuerySchema.extend({
          resourceKind: resourceKindSchema,
          q: z.string().max(200).optional(),
        }),
      }),
    )
    .output(cursorPageSchema(governanceResourceSchema)),
  identities: read
    .route({ method: 'GET', path: '/governance/identities' })
    .input(z.object({ query: adminPageQuerySchema.extend({ q: z.string().max(200).optional() }) }))
    .output(cursorPageSchema(governanceIdentitySchema)),
  handover: {
    checklist: read
      .route({ method: 'GET', path: '/governance/handover/{businessId}' })
      .input(z.object({ params: businessParams }))
      .output(handoverChecklistSchema),
    transfer: manage
      .route({ method: 'POST', path: '/governance/handover/{businessId}/transfer' })
      .input(z.object({ params: businessParams, body: handoverTransferInputSchema }))
      .output(handoverTransferResultSchema),
  },
  costSummary: read
    .route({ method: 'GET', path: '/governance/cost-summary' })
    .input(
      z.object({
        query: z.object({
          days: z.coerce.number().int().min(1).max(365).default(30),
          groupBy: costGroupBySchema.default('user'),
        }),
      }),
    )
    .output(costSummarySchema),
  alerts: {
    get: read.route({ method: 'GET', path: '/governance/alerts' }).output(alertSettingsSchema),
    update: manage
      .route({ method: 'PUT', path: '/governance/alerts' })
      .input(z.object({ body: alertSettingsSchema }))
      .output(alertSettingsSchema),
  },
};
