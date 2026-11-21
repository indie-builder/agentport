import {
  apiTokenCreateInputSchema,
  apiTokenCreateResultSchema,
  apiTokenSchema,
  cursorPageSchema,
  idParams,
  pageQuerySchema,
  webhookEndpointCreateInputSchema,
  webhookEndpointCreateResultSchema,
  webhookEndpointSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

const read = contractProcedure.meta({
  access: { kind: 'permission', permissionId: 'integrations.read' },
});
const manage = contractProcedure.meta({
  access: { kind: 'permission', permissionId: 'integrations.manage' },
});

export const integrationsContract = {
  tokens: {
    list: read
      .route({ method: 'GET', path: '/integrations/tokens' })
      .input(z.object({ query: pageQuerySchema }))
      .output(cursorPageSchema(apiTokenSchema)),
    create: manage
      .route({ method: 'POST', path: '/integrations/tokens', successStatus: 201 })
      .input(z.object({ body: apiTokenCreateInputSchema }))
      .output(apiTokenCreateResultSchema),
    revoke: manage
      .route({ method: 'DELETE', path: '/integrations/tokens/{id}', successStatus: 204 })
      .input(z.object({ params: idParams }))
      .output(z.void()),
  },
  webhooks: {
    list: read
      .route({ method: 'GET', path: '/integrations/webhooks' })
      .input(z.object({ query: pageQuerySchema }))
      .output(cursorPageSchema(webhookEndpointSchema)),
    create: manage
      .route({ method: 'POST', path: '/integrations/webhooks', successStatus: 201 })
      .input(z.object({ body: webhookEndpointCreateInputSchema }))
      .output(webhookEndpointCreateResultSchema),
    remove: manage
      .route({ method: 'DELETE', path: '/integrations/webhooks/{id}', successStatus: 204 })
      .input(z.object({ params: idParams }))
      .output(z.void()),
  },
};
