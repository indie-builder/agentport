import {
  apiToolInputSchema,
  apiToolSchema,
  connectorCatalogSchema,
  generatedServerSchema,
  httpServerSchema,
  idParams,
  serverInputSchema,
  serverSchema,
  serverTestResultSchema,
  stdioServerSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

const toolParams = idParams.extend({ toolId: z.string().min(1) });
const serverPatchSchema = z.object({
  kind: z.enum(['stdio', 'http', 'generated']).optional(),
  name: stdioServerSchema.shape.name.optional(),
  description: stdioServerSchema.shape.description.removeDefault().optional(),
  command: stdioServerSchema.shape.command.optional(),
  args: stdioServerSchema.shape.args.removeDefault().optional(),
  env: stdioServerSchema.shape.env.removeDefault().optional(),
  url: httpServerSchema.shape.url.optional(),
  baseUrl: generatedServerSchema.shape.baseUrl.optional(),
  headers: httpServerSchema.shape.headers.removeDefault().optional(),
  expectedUpdatedAt: z.coerce.date().optional(),
});
const toolPatchSchema = z
  .object({
    name: apiToolInputSchema.shape.name.optional(),
    description: apiToolInputSchema.shape.description.removeDefault().optional(),
    method: apiToolInputSchema.shape.method.removeDefault().optional(),
    pathTemplate: apiToolInputSchema.shape.pathTemplate.optional(),
    inputSchema: apiToolInputSchema.shape.inputSchema.removeDefault().optional(),
    paramsIn: apiToolInputSchema.shape.paramsIn.removeDefault().optional(),
    requiresApproval: apiToolInputSchema.shape.requiresApproval.removeDefault().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少需要修改一项' });
const serverTestBodySchema = z
  .object({
    runtimeEnvironmentId: z.string().min(1).nullable().optional(),
  })
  .strict()
  .nullish();
const importedServerSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['stdio', 'http', 'generated']),
  secretKeys: z.array(z.string()),
});
const readServers = contractProcedure.meta({
  access: { kind: 'permission', permissionId: 'servers.read' },
});
const manageTools = contractProcedure.meta({
  access: { kind: 'permission', permissionId: 'servers.tools.manage' },
});

export const serversContract = {
  list: readServers.route({ method: 'GET', path: '/servers' }).output(z.array(serverSchema)),
  catalog: readServers
    .route({ method: 'GET', path: '/connector-catalog' })
    .output(connectorCatalogSchema),
  create: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'servers.create' } })
    .route({ method: 'POST', path: '/servers', successStatus: 201 })
    .input(z.object({ body: serverInputSchema }))
    .output(serverSchema),
  importFile: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'servers.import' } })
    .route({ method: 'POST', path: '/servers/import-file', successStatus: 201 })
    .input(z.object({ body: z.object({ mcpJson: z.string().max(1_048_576) }) }))
    .output(
      z.object({ servers: z.array(importedServerSummarySchema), warnings: z.array(z.string()) }),
    ),
  get: readServers
    .route({ method: 'GET', path: '/servers/{id}' })
    .input(z.object({ params: idParams }))
    .output(serverSchema),
  token: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'servers.tokens.read' } })
    .route({ method: 'GET', path: '/servers/{id}/token' })
    .input(z.object({ params: idParams }))
    .output(z.object({ maskedToken: z.string(), endpoint: z.string() })),
  rotateToken: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'servers.tokens.rotate' } })
    .route({ method: 'POST', path: '/servers/{id}/rotate-token' })
    .input(z.object({ params: idParams }))
    .output(z.object({ token: z.string(), endpoint: z.string() })),
  update: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'servers.update' } })
    .route({ method: 'PATCH', path: '/servers/{id}' })
    .input(z.object({ params: idParams, body: serverPatchSchema }))
    .output(serverSchema),
  delete: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'servers.delete' } })
    .route({ method: 'DELETE', path: '/servers/{id}', successStatus: 204 })
    .input(z.object({ params: idParams }))
    .output(z.void()),
  test: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'servers.test' }, rateLimit: 20 })
    .route({ method: 'POST', path: '/servers/{id}/test' })
    .input(z.object({ params: idParams, body: serverTestBodySchema }))
    .output(serverTestResultSchema),
  tools: {
    list: readServers
      .route({ method: 'GET', path: '/servers/{id}/tools' })
      .input(z.object({ params: idParams }))
      .output(z.array(apiToolSchema)),
    create: manageTools
      .route({ method: 'POST', path: '/servers/{id}/tools', successStatus: 201 })
      .input(z.object({ params: idParams, body: apiToolInputSchema }))
      .output(apiToolSchema),
    update: manageTools
      .route({ method: 'PATCH', path: '/servers/{id}/tools/{toolId}' })
      .input(z.object({ params: toolParams, body: toolPatchSchema }))
      .output(apiToolSchema),
    delete: manageTools
      .route({ method: 'DELETE', path: '/servers/{id}/tools/{toolId}', successStatus: 204 })
      .input(z.object({ params: toolParams }))
      .output(z.void()),
  },
};
