import {
  idParams,
  modelProviderCreateSchema,
  modelProviderSchema,
  modelProviderTestResultSchema,
  modelProviderUpdateSchema,
  modelProviderUsageSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

const read = contractProcedure.meta({
  access: { kind: 'permission', permissionId: 'models.read' },
});
const manage = contractProcedure.meta({
  access: { kind: 'permission', permissionId: 'models.manage' },
});

export const modelProvidersContract = {
  list: read
    .route({ method: 'GET', path: '/model-providers' })
    .output(z.array(modelProviderSchema)),
  usage: read
    .route({ method: 'GET', path: '/model-providers/usage' })
    .output(z.array(modelProviderUsageSchema)),
  create: manage
    .route({ method: 'POST', path: '/model-providers', successStatus: 201 })
    .input(z.object({ body: modelProviderCreateSchema }))
    .output(modelProviderSchema),
  update: manage
    .route({ method: 'PATCH', path: '/model-providers/{id}' })
    .input(z.object({ params: idParams, body: modelProviderUpdateSchema }))
    .output(modelProviderSchema),
  remove: manage
    .route({ method: 'DELETE', path: '/model-providers/{id}', successStatus: 204 })
    .input(z.object({ params: idParams }))
    .output(z.void()),
  test: manage
    .route({ method: 'POST', path: '/model-providers/{id}/test' })
    .input(z.object({ params: idParams }))
    .output(modelProviderTestResultSchema),
};
