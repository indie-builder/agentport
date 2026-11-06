import {
  idParams,
  runtimeEnvironmentInputSchema,
  runtimeEnvironmentOnlineVersionInputSchema,
  runtimeEnvironmentPatchSchema,
  runtimeEnvironmentSchema,
  runtimeEnvironmentVersionSchema,
  runtimeEnvironmentVersionSummarySchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

const versionParams = z.object({
  id: z.string().min(1),
  versionId: z.string().min(1),
});

export const runtimeEnvironmentsContract = {
  list: contractProcedure
    .route({ method: 'GET', path: '/runtime-environments' })
    .output(z.array(runtimeEnvironmentSchema))
    .meta({ access: { kind: 'permission', permissionId: 'runtime_environments.read' } }),
  create: contractProcedure
    .route({ method: 'POST', path: '/runtime-environments', successStatus: 201 })
    .input(z.object({ body: runtimeEnvironmentInputSchema }))
    .output(runtimeEnvironmentSchema)
    .meta({ access: { kind: 'permission', permissionId: 'runtime_environments.create' } }),
  detail: contractProcedure
    .route({ method: 'GET', path: '/runtime-environments/{id}' })
    .input(z.object({ params: idParams }))
    .output(runtimeEnvironmentSchema)
    .meta({ access: { kind: 'permission', permissionId: 'runtime_environments.read' } }),
  update: contractProcedure
    .route({ method: 'PATCH', path: '/runtime-environments/{id}' })
    .input(z.object({ params: idParams, body: runtimeEnvironmentPatchSchema }))
    .output(runtimeEnvironmentSchema)
    .meta({ access: { kind: 'permission', permissionId: 'runtime_environments.update' } }),
  remove: contractProcedure
    .route({ method: 'DELETE', path: '/runtime-environments/{id}', successStatus: 204 })
    .input(z.object({ params: idParams }))
    .output(z.void())
    .meta({ access: { kind: 'permission', permissionId: 'runtime_environments.delete' } }),
  versions: contractProcedure
    .route({ method: 'GET', path: '/runtime-environments/{id}/versions' })
    .input(z.object({ params: idParams }))
    .output(z.array(runtimeEnvironmentVersionSummarySchema))
    .meta({ access: { kind: 'permission', permissionId: 'runtime_environments.read' } }),
  build: contractProcedure
    .route({ method: 'POST', path: '/runtime-environments/{id}/versions', successStatus: 202 })
    .input(z.object({ params: idParams }))
    .output(runtimeEnvironmentVersionSchema)
    .meta({ access: { kind: 'permission', permissionId: 'runtime_environments.build' } }),
  versionDetail: contractProcedure
    .route({ method: 'GET', path: '/runtime-environments/{id}/versions/{versionId}' })
    .input(z.object({ params: versionParams }))
    .output(runtimeEnvironmentVersionSchema)
    .meta({ access: { kind: 'permission', permissionId: 'runtime_environments.read' } }),
  publish: contractProcedure
    .route({ method: 'PUT', path: '/runtime-environments/{id}/online-version' })
    .input(z.object({ params: idParams, body: runtimeEnvironmentOnlineVersionInputSchema }))
    .output(runtimeEnvironmentSchema)
    .meta({ access: { kind: 'permission', permissionId: 'runtime_environments.publish' } }),
};
