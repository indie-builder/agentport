import {
  agentBudgetStatusSchema,
  agentDefinitionSchema,
  agentDuplicateInputSchema,
  agentHookFileInputSchema,
  agentHookFilePathSchema,
  agentHookFileSchema,
  agentHooksSchema,
  agentHooksSettingsInputSchema,
  agentInputSchema,
  agentLifecycleStatusSchema,
  agentMemberInputSchema,
  agentMemberSchema,
  agentOptionsSchema,
  agentSchema,
  agentSummarySchema,
  businessIdSchema,
  cursorPageSchema,
  expectedUpdatedAtSchema,
  idParams,
  MARKDOWN_FILE_MAX_CODE_POINTS,
  memoryFileContentSchema,
  memoryFileListSchema,
  memoryFileNameSchema,
  offsetPageSchema,
  offsetQuerySchema,
  outputStyleInputSchema,
  outputStyleSchema,
  pageQuerySchema,
  permissionIdSchema,
  ruleInputSchema,
  ruleSchema,
  slugSchema,
  workspaceFilesSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';
import { domainErrors } from './errors.js';

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
const ruleBody = ruleInputSchema
  .pick({ content: true, globs: true })
  .extend({ content: ruleInputSchema.shape.content.removeDefault() });
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
const identitiesQuery = offsetQuerySchema().extend({
  agentId: z.string().min(1),
  q: z.string().max(128).optional(),
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
    monthlyBudgetUsd: agentFields.monthlyBudgetUsd.removeDefault().optional(),
    budgetAlertRatio: agentFields.budgetAlertRatio.removeDefault().optional(),
    timeoutMs: agentFields.timeoutMs.removeDefault().optional(),
    effort: agentFields.effort.nullable().optional(),
    enabled: agentFields.enabled.removeDefault().optional(),
    visibility: agentFields.visibility.removeDefault().optional(),
    tags: agentFields.tags.removeDefault().optional(),
    expectedUpdatedAt: expectedUpdatedAtSchema,
  })
  .strict();
const importFileSchema = z.object({ agentMd: z.string().max(MARKDOWN_FILE_MAX_CODE_POINTS) });
const hookFileBody = agentHookFileInputSchema;
const hookFileDeleteQuery = z.object({ path: agentHookFilePathSchema });
export const agentWriteResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('detail'), agent: agentSchema }),
  z.object({ kind: z.literal('summary'), agent: agentSummarySchema }),
]);
export const agentsContract = {
  list: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'GET', path: '/agents', successStatus: 200 })
    .input(
      z.object({
        query: pageQuerySchema.extend({
          q: z.string().trim().max(128).optional(),
          tag: z.string().max(24).optional(),
          favorite: z.stringbool().optional(),
          sort: z.enum(['name', 'recent']).optional(),
          status: agentLifecycleStatusSchema.default('active'),
        }),
      }),
    )
    .output(cursorPageSchema(agentSummarySchema)),
  reference: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'GET', path: '/agents/reference', successStatus: 200 })
    .input(z.object({}))
    .output(z.object({ items: z.array(agentSummarySchema), truncated: z.boolean() })),
  tags: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'GET', path: '/agents/tags', successStatus: 200 })
    .input(z.object({}))
    .output(z.object({ items: z.array(z.string()) })),
  favorite: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.use' } })
    .route({ method: 'PUT', path: '/agents/{id}/favorite', successStatus: 200 })
    .input(z.object({ params: idParams, body: z.object({ favorite: z.boolean() }) }))
    .output(z.object({ favorite: z.boolean() })),
  archive: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.delete' } })
    .route({ method: 'POST', path: '/agents/{id}/archive', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(agentSummarySchema),
  restore: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.delete' } })
    .route({ method: 'POST', path: '/agents/{id}/restore', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(agentSummarySchema),
  create: contractProcedure
    .errors(domainErrors('INVALID_REFERENCE', 'CONFLICT'))
    .meta({ access: { kind: 'permission', permissionId: 'agents.create' } })
    .route({ method: 'POST', path: '/agents', successStatus: 201 })
    .input(z.object({ body: createSchema }))
    .output(agentSchema),
  duplicate: contractProcedure
    .errors(domainErrors('INVALID_REFERENCE', 'CONFLICT'))
    .meta({ access: { kind: 'permission', permissionId: 'agents.clone' } })
    .route({ method: 'POST', path: '/agents/{id}/duplicate', successStatus: 201 })
    .input(z.object({ params: idParams, body: agentDuplicateInputSchema }))
    .output(agentSchema),
  importFile: contractProcedure
    .errors(domainErrors('INVALID_REFERENCE', 'CONFLICT'))
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
  budget: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.config.read' } })
    .route({ method: 'GET', path: '/agents/{id}/budget', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(agentBudgetStatusSchema),
  access: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'GET', path: '/agents/{id}/access', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(z.object({ agentId: z.string(), permissionIds: z.array(permissionIdSchema) })),
  update: contractProcedure
    .errors(domainErrors('INVALID_REFERENCE', 'CONFLICT', 'CONFLICT_STALE'))
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'PATCH', path: '/agents/{id}', successStatus: 200 })
    .input(z.object({ params: idParams, body: patchSchema }))
    .output(agentWriteResultSchema),
  publish: contractProcedure
    .errors(domainErrors('CONFLICT'))
    .meta({ access: { kind: 'permission', permissionId: 'agents.publish' } })
    .route({ method: 'POST', path: '/agents/{id}/publish', successStatus: 200 })
    .input(z.object({ params: idParams, body: z.object({ note: z.string().max(200).optional() }) }))
    .output(agentWriteResultSchema),
  offline: contractProcedure
    .errors(domainErrors('CONFLICT'))
    .meta({ access: { kind: 'permission', permissionId: 'agents.enable' } })
    .route({ method: 'POST', path: '/agents/{id}/offline', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(agentWriteResultSchema),
  trial: contractProcedure
    .errors(
      domainErrors(
        'AGENT_DISABLED',
        'BUDGET_EXCEEDED',
        'CONTENT_BLOCKED',
        'CONTENT_APPROVAL_REQUIRED',
      ),
    )
    .meta({
      access: { kind: 'permission', permissionId: 'agents.config.update' },
      rateLimit: 10,
    })
    .route({ method: 'POST', path: '/agents/{id}/trial', successStatus: 200 })
    .input(
      z.object({
        params: idParams,
        body: z.object({ prompt: z.string().min(1).max(20_000) }),
      }),
    )
    .output(z.object({ runId: z.string(), conversationId: z.string() })),
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
    .output(
      z.object({
        version: z.number(),
        snapshot: agentSchema,
        definition: agentDefinitionSchema.nullable(),
        definitionState: z.enum(['available', 'forbidden', 'legacy']),
        createdAt: z.string(),
      }),
    ),
  rollback: contractProcedure
    .errors(domainErrors('INVALID_REFERENCE', 'CONFLICT'))
    .meta({ access: { kind: 'permission', permissionId: 'agents.versions.restore' } })
    .route({ method: 'POST', path: '/agents/{id}/rollback', successStatus: 200 })
    .input(z.object({ params: idParams, body: rollbackBody }))
    .output(agentWriteResultSchema),
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
    .errors(domainErrors('CONFLICT'))
    .meta({ access: { kind: 'permission', permissionId: 'agents.memory.write' } })
    .route({ method: 'PUT', path: '/agents/{id}/memory/{name}', successStatus: 200 })
    .input(z.object({ params: memoryFileParams, body: memoryWriteBody }))
    .output(memoryFileContentSchema),
  deleteMemory: contractProcedure
    .errors(domainErrors('CONFLICT'))
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
    .errors(domainErrors('CONFLICT'))
    .meta({ access: { kind: 'permission', permissionId: 'agents.rules.write' } })
    .route({ method: 'PUT', path: '/agents/{id}/rules/{slug}', successStatus: 200 })
    .input(z.object({ params: ruleParams, body: ruleBody }))
    .output(ruleSchema),
  deleteRule: contractProcedure
    .errors(domainErrors('CONFLICT'))
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
    .errors(domainErrors('CONFLICT'))
    .meta({ access: { kind: 'permission', permissionId: 'agents.styles.write' } })
    .route({ method: 'PUT', path: '/agents/{id}/output-styles/{slug}', successStatus: 200 })
    .input(z.object({ params: outputStyleParams, body: outputStyleWriteBody }))
    .output(outputStyleSchema),
  unselectOutputStyle: contractProcedure
    .errors(domainErrors('CONFLICT'))
    .meta({ access: { kind: 'permission', permissionId: 'agents.styles.write' } })
    .route({
      method: 'POST',
      path: '/agents/{id}/output-styles/{slug}/unselect',
      successStatus: 204,
    })
    .input(z.object({ params: outputStyleParams }))
    .output(z.void()),
  deleteOutputStyle: contractProcedure
    .errors(domainErrors('CONFLICT'))
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
    .errors(domainErrors('CONFLICT'))
    .meta({ access: { kind: 'permission', permissionId: 'agents.hooks.write' } })
    .route({ method: 'PUT', path: '/agents/{id}/hooks/settings', successStatus: 200 })
    .input(z.object({ params: idParams, body: agentHooksSettingsInputSchema }))
    .output(agentHooksSchema),
  writeHookFile: contractProcedure
    .errors(domainErrors('CONFLICT'))
    .meta({ access: { kind: 'permission', permissionId: 'agents.hooks.write' } })
    .route({ method: 'PUT', path: '/agents/{id}/hooks/files', successStatus: 200 })
    .input(z.object({ params: idParams, body: hookFileBody }))
    .output(agentHookFileSchema),
  deleteHookFile: contractProcedure
    .errors(domainErrors('CONFLICT'))
    .meta({ access: { kind: 'permission', permissionId: 'agents.hooks.write' } })
    .route({ method: 'DELETE', path: '/agents/{id}/hooks/files', successStatus: 204 })
    .input(z.object({ params: idParams, query: hookFileDeleteQuery }))
    .output(z.void()),
  members: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.members.manage' } })
    .route({ method: 'GET', path: '/agents/{id}/members', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(z.object({ ownerBusinessId: z.string(), members: z.array(agentMemberSchema) })),
  setMember: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.members.manage' } })
    .route({ method: 'PUT', path: '/agents/{id}/members/{businessId}', successStatus: 200 })
    .input(z.object({ params: memberParams, body: agentMemberInputSchema }))
    .output(agentMemberSchema),
  deleteMember: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'agents.members.manage' } })
    .route({ method: 'DELETE', path: '/agents/{id}/members/{businessId}', successStatus: 204 })
    .input(z.object({ params: memberParams }))
    .output(z.void()),
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
      offsetPageSchema(
        z.object({ businessId: z.string(), name: z.string(), accountActive: z.boolean() }),
      ),
    ),
};
