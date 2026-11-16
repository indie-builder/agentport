import { idParams, slugSchema } from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

const connectionSchema = z.record(z.string().min(1).max(128), z.string().max(4096));

const dataDomainListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const dataDomainInputSchema = z.object({
  name: z.string().trim().min(1).max(64),
  slug: slugSchema,
  description: z.string().trim().max(2000).default(''),
  datasource: z.string().trim().min(1).max(64),
  connection: connectionSchema.refine((value) => Object.keys(value).length > 0, '请填写连接配置'),
});

export const dataDomainPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    slug: slugSchema,
    description: z.string().trim().max(2000),
    datasource: z.string().trim().min(1).max(64),
    connection: connectionSchema.refine((value) => Object.keys(value).length > 0, '请填写连接配置'),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: '至少需要修改一项' });

export const dataDomainSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  datasource: z.string(),
  onlineVersionId: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const dataDomainListSchema = z.object({
  items: z.array(dataDomainSchema),
  nextCursor: z.string().nullable(),
});

export const dataDomainVersionSchema = z.object({
  id: z.string(),
  dataDomainId: z.string(),
  status: z.enum(['queued', 'building', 'ready', 'failed']),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const dataDomainVersionInputSchema = z.object({
  projectFiles: z.record(z.string().min(1).max(512), z.string()),
});

export const dataDomainOnlineVersionInputSchema = z.object({
  versionId: z.string().min(1),
});

const read = contractProcedure.meta({
  access: { kind: 'permission', permissionId: 'data_domains.read' },
});

export const dataDomainsContract = {
  list: read
    .route({ method: 'GET', path: '/data-domains' })
    .input(z.object({ query: dataDomainListQuerySchema }))
    .output(dataDomainListSchema),
  create: contractProcedure
    .route({ method: 'POST', path: '/data-domains', successStatus: 201 })
    .input(z.object({ body: dataDomainInputSchema }))
    .output(dataDomainSchema)
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.create' } }),
  detail: read
    .route({ method: 'GET', path: '/data-domains/{id}' })
    .input(z.object({ params: idParams }))
    .output(dataDomainSchema),
  update: contractProcedure
    .route({ method: 'PATCH', path: '/data-domains/{id}' })
    .input(z.object({ params: idParams, body: dataDomainPatchSchema }))
    .output(dataDomainSchema)
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.update' } }),
  remove: contractProcedure
    .route({ method: 'DELETE', path: '/data-domains/{id}', successStatus: 204 })
    .input(z.object({ params: idParams }))
    .output(z.void())
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.delete' } }),
  versions: read
    .route({ method: 'GET', path: '/data-domains/{id}/versions' })
    .input(z.object({ params: idParams }))
    .output(z.array(dataDomainVersionSchema)),
  createVersion: contractProcedure
    .route({ method: 'POST', path: '/data-domains/{id}/versions', successStatus: 202 })
    .input(z.object({ params: idParams, body: dataDomainVersionInputSchema }))
    .output(dataDomainVersionSchema)
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.build' } }),
  publish: contractProcedure
    .route({ method: 'PUT', path: '/data-domains/{id}/online-version' })
    .input(z.object({ params: idParams, body: dataDomainOnlineVersionInputSchema }))
    .output(dataDomainSchema)
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.publish' } }),
};
