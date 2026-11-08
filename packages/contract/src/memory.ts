import {
  agentMemoryAssemblySchema,
  agentMemoryOverviewSchema,
  idParams,
  memoryChangeSchema,
  memoryFileNamePattern,
  memoryPolicySchema,
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

/** 记忆策略写入体：整份策略替换，不提供局部 patch。 */
export const agentMemoryPolicyBodySchema = z.object({ policy: memoryPolicySchema }).strict();

export const agentMemoryPolicyResponseSchema = z.object({ policy: memoryPolicySchema }).strict();

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
  agentMemoryOverview: contractProcedure
    .route({ method: 'GET', path: '/agents/{id}/memory/overview' })
    .input(z.object({ params: agentParams }))
    .output(agentMemoryOverviewSchema)
    .meta({ access: { kind: 'permission', permissionId: 'agents.memory.read' } }),
  agentMemoryAssembly: contractProcedure
    .route({ method: 'GET', path: '/agents/{id}/memory/assembly' })
    .input(z.object({ params: agentParams }))
    .output(agentMemoryAssemblySchema)
    .meta({ access: { kind: 'permission', permissionId: 'agents.memory.read' } }),
  updateAgentMemoryPolicy: contractProcedure
    .route({ method: 'PUT', path: '/agents/{id}/memory/policy' })
    .input(z.object({ params: agentParams, body: agentMemoryPolicyBodySchema }))
    .output(agentMemoryPolicyResponseSchema)
    .meta({ access: { kind: 'permission', permissionId: 'agents.memory.write' } }),
  rollback: contractProcedure
    .route({ method: 'POST', path: '/memory/changes/{id}/rollback' })
    .input(z.object({ params: idParams }))
    .output(memoryChangeSchema)
    .meta({ access: { kind: 'permission', permissionId: 'personal_memory.write' } }),
};
