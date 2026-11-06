import {
  idParams,
  memoryChangeSchema,
  memoryFileNamePattern,
  personalMemorySchema,
  slugSchema,
  writePersonalMemoryInputSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

export const memoryVersionsQuerySchema = z.object({
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const personalMemoryWriteResponseSchema = personalMemorySchema.extend({
  changeId: z.string(),
});

export const memoryVersionListSchema = z.object({ items: z.array(memoryChangeSchema) });

const agentParams = z.object({ id: z.string().min(1) });

export const agentMemoryVersionParams = agentParams.extend({
  name: z.string().regex(memoryFileNamePattern, '记忆文件名非法：只允许 <name>.md'),
});

export const agentRuleVersionParams = agentParams.extend({ slug: slugSchema });

export const memoryContract = {
  readPersonal: contractProcedure
    .route({ method: 'GET', path: '/me/memory' })
    .output(personalMemorySchema)
    .meta({ access: { kind: 'permission', permissionId: 'personal_memory.read' } }),
  writePersonal: contractProcedure
    .route({ method: 'PUT', path: '/me/memory' })
    .input(z.object({ body: writePersonalMemoryInputSchema }))
    .output(personalMemoryWriteResponseSchema)
    .meta({ access: { kind: 'permission', permissionId: 'personal_memory.write' } }),
  personalVersions: contractProcedure
    .route({ method: 'GET', path: '/me/memory/versions' })
    .input(z.object({ query: memoryVersionsQuerySchema }))
    .output(memoryVersionListSchema)
    .meta({ access: { kind: 'permission', permissionId: 'personal_memory.read' } }),
  agentFileVersions: contractProcedure
    .route({ method: 'GET', path: '/agents/{id}/memory/{name}/versions' })
    .input(z.object({ params: agentMemoryVersionParams, query: memoryVersionsQuerySchema }))
    .output(memoryVersionListSchema)
    .meta({ access: { kind: 'permission', permissionId: 'agents.memory.read' } }),
  agentRuleVersions: contractProcedure
    .route({ method: 'GET', path: '/agents/{id}/rules/{slug}/versions' })
    .input(z.object({ params: agentRuleVersionParams, query: memoryVersionsQuerySchema }))
    .output(memoryVersionListSchema)
    .meta({ access: { kind: 'permission', permissionId: 'agents.rules.read' } }),
  rollback: contractProcedure
    .route({ method: 'POST', path: '/memory/changes/{id}/rollback' })
    .input(z.object({ params: idParams }))
    .output(memoryChangeSchema)
    .meta({ access: { kind: 'permission', permissionId: 'personal_memory.write' } }),
};
