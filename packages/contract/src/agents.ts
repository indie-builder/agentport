import {
  agentDuplicateInputSchema,
  agentHookFileInputSchema,
  agentHookFilePathSchema,
  agentHookFileSchema,
  agentHooksSchema,
  agentHooksSettingsInputSchema,
  agentInputSchema,
  agentMemberInputSchema,
  agentOptionsSchema,
  agentSchema,
  agentSummarySchema,
  businessIdSchema,
  idParams,
  memoryFileContentSchema,
  memoryFileListSchema,
  memoryFileNameSchema,
  outputStyleInputSchema,
  outputStyleSchema,
  permissionIdSchema,
  ruleSchema,
  slugSchema,
  workspaceFilesSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

const versionParams = z.object({
  id: z.string().min(1),
  version: z.coerce.number().int().positive(),
});
const rollbackBody = z.object({ version: z.number().int().positive() });
const memoryFileParams = z.object({
  id: z.string().min(1),
  name: memoryFileNameSchema,
});
const memoryWriteBody = z.object({ content: z.string() });
const ruleParams = z.object({ id: z.string().min(1), slug: slugSchema });
const outputStyleParams = z.object({ id: z.string().min(1), slug: slugSchema });
const ruleBody = z.object({
  content: z.string().max(100000),
  globs: z.string().max(1000).default(''),
});
const outputStyleWriteBody = outputStyleInputSchema.pick({
  description: true,
  keepCodingInstructions: true,
  body: true,
});
const memberParams = z.object({
  id: z.string().min(1),
  businessId: businessIdSchema,
});
const transferBody = z.object({ ownerBusinessId: businessIdSchema }).strict();
const identitiesQuery = z.object({
  agentId: z.string().min(1),
  q: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const createSchema = agentInputSchema.strict();
const agentFields = agentInputSchema.shape;
const patchSchema = z
  .object({
    slug: agentFields.slug.optional(),
    name: agentFields.name.optional(),
    role: agentFields.role.removeDefault().optional(),
    description: agentFields.description.removeDefault().optional(),
    model: agentFields.model.removeDefault().min(1).optional(),
    systemPrompt: agentFields.systemPrompt.removeDefault().optional(),
    serverIds: agentFields.serverIds.removeDefault().optional(),
    skillIds: agentFields.skillIds.removeDefault().optional(),
    pluginBindings: agentFields.pluginBindings.removeDefault().optional(),
    subAgentIds: agentFields.subAgentIds.removeDefault().optional(),
    runtimeEnvironmentId: agentFields.runtimeEnvironmentId
      .removeDefault()
      .unwrap()
      .min(1)
      .nullable()
      .optional(),
    allowedTools: agentFields.allowedTools.removeDefault().optional(),
    disallowedTools: agentFields.disallowedTools.removeDefault().optional(),
    permissionMode: agentFields.permissionMode.removeDefault().optional(),
    uiFormat: agentFields.uiFormat.removeDefault().optional(),
    maxTurns: agentFields.maxTurns.removeDefault().optional(),
    maxBudgetUsd: agentFields.maxBudgetUsd.removeDefault().optional(),
    timeoutMs: agentFields.timeoutMs.removeDefault().optional(),
    effort: agentFields.effort.nullable().optional(),
    enabled: agentFields.enabled.removeDefault().optional(),
    expectedUpdatedAt: z.coerce.date().optional(),
  })
  .strict();
const importFileSchema = z.object({ agentMd: z.string().max(131072) });
const hookFileBody = agentHookFileInputSchema;
const hookFileDeleteBody = z.object({ path: agentHookFilePathSchema });
const memberSchema = z.object({
  businessId: z.string(),
  name: z.string(),
  accountActive: z.boolean(),
  canUse: z.boolean(),
  canMaintain: z.boolean(),
});
export const agentsContract = {
  list: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.read' } })
    .route({ method: 'GET', path: '/agents', successStatus: 200 })
    .input(z.object({}))
    .output(z.array(agentSummarySchema)),
  create: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.create' } })
    .route({ method: 'POST', path: '/agents', successStatus: 201 })
    .input(z.object({ body: createSchema }))
    .output(agentSchema),
  duplicate: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.clone' } })
    .route({ method: 'POST', path: '/agents/{id}/duplicate', successStatus: 201 })
    .input(z.object({ params: idParams, body: agentDuplicateInputSchema }))
    .output(agentSchema),
  importFile: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.import' } })
    .route({ method: 'POST', path: '/agents/import-file', successStatus: 201 })
    .input(z.object({ body: importFileSchema }))
    .output(z.object({ agent: agentSchema, warnings: z.array(z.string()) })),
  options: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'GET', path: '/agents/options', successStatus: 200 })
    .input(z.object({}))
    .output(agentOptionsSchema),
  get: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.config.read' } })
    .route({ method: 'GET', path: '/agents/{id}', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(agentSchema),
  access: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'GET', path: '/agents/{id}/access', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(z.object({ agentId: z.string(), permissionIds: z.array(permissionIdSchema) })),
  update: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'PATCH', path: '/agents/{id}', successStatus: 200 })
    .input(z.object({ params: idParams, body: patchSchema }))
    .output(z.union([agentSchema, agentSummarySchema])),
  delete: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.delete' } })
    .route({ method: 'DELETE', path: '/agents/{id}', successStatus: 204 })
    .input(z.object({ params: idParams }))
    .output(z.void()),
  files: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.files.read' } })
    .route({ method: 'GET', path: '/agents/{id}/files', successStatus: 200 })
    .input(
      z.object({ params: idParams, query: z.object({ reveal: z.enum(['0', '1']).optional() }) }),
    )
    .output(workspaceFilesSchema),
  versions: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.versions.read' } })
    .route({ method: 'GET', path: '/agents/{id}/versions', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(
      z.array(
        z.object({
          id: z.string(),
          version: z.number(),
          note: z.string().nullable(),
          createdAt: z.string(),
        }),
      ),
    ),
  version: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.versions.read' } })
    .route({ method: 'GET', path: '/agents/{id}/versions/{version}', successStatus: 200 })
    .input(z.object({ params: versionParams }))
    .output(z.object({ version: z.number(), snapshot: agentSchema, createdAt: z.string() })),
  rollback: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.versions.restore' } })
    .route({ method: 'POST', path: '/agents/{id}/rollback', successStatus: 200 })
    .input(z.object({ params: idParams, body: rollbackBody }))
    .output(agentSchema),
  memory: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.memory.read' } })
    .route({ method: 'GET', path: '/agents/{id}/memory', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(memoryFileListSchema),
  memoryFile: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.memory.read' } })
    .route({ method: 'GET', path: '/agents/{id}/memory/{name}', successStatus: 200 })
    .input(z.object({ params: memoryFileParams }))
    .output(memoryFileContentSchema),
  writeMemory: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.memory.write' } })
    .route({ method: 'PUT', path: '/agents/{id}/memory/{name}', successStatus: 200 })
    .input(z.object({ params: memoryFileParams, body: memoryWriteBody }))
    .output(memoryFileContentSchema),
  deleteMemory: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.memory.write' } })
    .route({ method: 'DELETE', path: '/agents/{id}/memory/{name}', successStatus: 204 })
    .input(z.object({ params: memoryFileParams }))
    .output(z.void()),
  rules: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.rules.read' } })
    .route({ method: 'GET', path: '/agents/{id}/rules', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(z.array(ruleSchema)),
  writeRule: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.rules.write' } })
    .route({ method: 'PUT', path: '/agents/{id}/rules/{slug}', successStatus: 200 })
    .input(z.object({ params: ruleParams, body: ruleBody }))
    .output(ruleSchema),
  deleteRule: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.rules.write' } })
    .route({ method: 'DELETE', path: '/agents/{id}/rules/{slug}', successStatus: 204 })
    .input(z.object({ params: ruleParams }))
    .output(z.void()),
  outputStyles: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.styles.read' } })
    .route({ method: 'GET', path: '/agents/{id}/output-styles', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(z.array(outputStyleSchema)),
  writeOutputStyle: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.styles.write' } })
    .route({ method: 'PUT', path: '/agents/{id}/output-styles/{slug}', successStatus: 200 })
    .input(z.object({ params: outputStyleParams, body: outputStyleWriteBody }))
    .output(outputStyleSchema),
  unselectOutputStyle: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.styles.write' } })
    .route({
      method: 'POST',
      path: '/agents/{id}/output-styles/{slug}/unselect',
      successStatus: 204,
    })
    .input(z.object({ params: outputStyleParams }))
    .output(z.void()),
  deleteOutputStyle: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.styles.write' } })
    .route({ method: 'DELETE', path: '/agents/{id}/output-styles/{slug}', successStatus: 204 })
    .input(z.object({ params: outputStyleParams }))
    .output(z.void()),
  hooks: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.hooks.read' } })
    .route({ method: 'GET', path: '/agents/{id}/hooks', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(agentHooksSchema),
  writeHooksSettings: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.hooks.write' } })
    .route({ method: 'PUT', path: '/agents/{id}/hooks/settings', successStatus: 200 })
    .input(z.object({ params: idParams, body: agentHooksSettingsInputSchema }))
    .output(agentHooksSchema),
  writeHookFile: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.hooks.write' } })
    .route({ method: 'PUT', path: '/agents/{id}/hooks/files', successStatus: 200 })
    .input(z.object({ params: idParams, body: hookFileBody }))
    .output(agentHookFileSchema),
  deleteHookFile: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.hooks.write' } })
    .route({ method: 'DELETE', path: '/agents/{id}/hooks/files', successStatus: 204 })
    .input(z.object({ params: idParams, body: hookFileDeleteBody }))
    .output(z.void()),
  members: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.members.manage' } })
    .route({ method: 'GET', path: '/agents/{id}/members', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(z.object({ ownerBusinessId: z.string(), members: z.array(memberSchema) })),
  setMember: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.members.manage' } })
    .route({ method: 'PUT', path: '/agents/{id}/members/{businessId}', successStatus: 200 })
    .input(z.object({ params: memberParams, body: agentMemberInputSchema }))
    .output(memberSchema),
  deleteMember: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.members.manage' } })
    .route({ method: 'DELETE', path: '/agents/{id}/members/{businessId}', successStatus: 200 })
    .input(z.object({ params: memberParams }))
    .output(z.object({ ok: z.boolean() })),
  transfer: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.transfer' } })
    .route({ method: 'POST', path: '/agents/{id}/transfer', successStatus: 200 })
    .input(z.object({ params: idParams, body: transferBody }))
    .output(agentSchema),
  identities: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'GET', path: '/identities', successStatus: 200 })
    .input(z.object({ query: identitiesQuery }))
    .output(
      z.object({
        items: z.array(
          z.object({ businessId: z.string(), name: z.string(), accountActive: z.boolean() }),
        ),
        total: z.number(),
      }),
    ),
};
