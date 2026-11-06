import {
  idParams,
  nativeInstalledPluginSchema,
  nativePluginImportInputSchema,
  nativePluginInstallInputSchema,
  pluginSchema,
  pluginWithAgentCountSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

const patchSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(500).optional(),
  version: z.string().max(64).optional(),
  expectedUpdatedAt: z.iso.datetime().optional(),
});
const nativeResultBodySchema = z.object({
  plugin: pluginSchema,
  warnings: z.array(z.string()),
  reused: z.boolean(),
});
const nativeResultSchema = z.union([
  z.object({ status: z.literal(200), body: nativeResultBodySchema }),
  z.object({ status: z.literal(201), body: nativeResultBodySchema }),
]);
export const pluginsContract = {
  list: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'plugins.read' } })
    .route({ method: 'GET', path: '/plugins', successStatus: 200 })
    .input(z.object({}))
    .output(z.array(pluginWithAgentCountSchema)),
  native: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'plugins.read' } })
    .route({ method: 'GET', path: '/plugins/native', successStatus: 200 })
    .input(z.object({}))
    .output(
      z.object({
        installed: z.array(nativeInstalledPluginSchema.extend({ imported: z.boolean() })),
      }),
    ),
  install: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'plugins.install' } })
    .route({
      method: 'POST',
      path: '/plugins/install',
      successStatus: 201,
      outputStructure: 'detailed',
    })
    .input(z.object({ body: nativePluginInstallInputSchema }))
    .output(nativeResultSchema),
  importNative: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'plugins.import' } })
    .route({
      method: 'POST',
      path: '/plugins/native/import',
      successStatus: 201,
      outputStructure: 'detailed',
    })
    .input(z.object({ body: nativePluginImportInputSchema }))
    .output(nativeResultSchema),
  get: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'plugins.read' } })
    .route({ method: 'GET', path: '/plugins/{id}', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(pluginSchema),
  update: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'plugins.update' } })
    .route({ method: 'PATCH', path: '/plugins/{id}', successStatus: 200 })
    .input(z.object({ params: idParams, body: patchSchema }))
    .output(pluginSchema),
  delete: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'plugins.delete' } })
    .route({ method: 'DELETE', path: '/plugins/{id}', successStatus: 204 })
    .input(z.object({ params: idParams }))
    .output(z.void()),
};
