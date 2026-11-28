import {
  AGENT_ROLES,
  auditActorKindSchema,
  auditStatusSchema,
  contentPolicyActionSchema,
  dataDomainQueryLogStatusSchema,
  knowledgeBaseStatusSchema,
  knowledgeContentKindSchema,
  knowledgeDocumentStatusSchema,
  policyApprovalStatusSchema,
  policySourceKindSchema,
  resourceKindSchema,
  runStatusSchema,
  runTriggerSchema,
  runtimeEnvironmentVersionStatusSchema,
  violationCaseStatusSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { safeInternalPath } from '../lib/auth-redirect.js';
import {
  agentInstructions,
  agentSections,
  agentTabs,
  knowledgeTabs,
  legacyAgentTabs,
  memoryViews,
} from '../lib/detail-tabs.js';

const resourceSearchSchema = z.object({
  q: z.string().optional().catch(undefined),
  sort: z.enum(['newest', 'name']).optional().catch(undefined),
});

const listViewSchema = z.enum(['table', 'cards']).optional().catch(undefined);

export const serversSearchSchema = resourceSearchSchema.extend({
  kind: z.enum(['stdio', 'http', 'generated', 'data_domain']).optional().catch(undefined),
  view: listViewSchema,
});

export const agentsSearchSchema = resourceSearchSchema.extend({
  status: z.enum(['all', 'enabled', 'disabled']).optional().catch(undefined),
  role: z.enum(AGENT_ROLES).optional().catch(undefined),
});

const backToSearchSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => safeInternalPath(value) !== undefined)
  .optional()
  .catch(undefined);

export const agentDetailSearchSchema = z.object({
  tab: z
    .enum([...agentTabs.map((item) => item.id), ...legacyAgentTabs])
    .optional()
    .catch(undefined),
  instruction: z
    .enum(agentInstructions.map((item) => item.id))
    .optional()
    .catch(undefined),
  section: z
    .enum(agentSections.map((item) => item.id))
    .optional()
    .catch(undefined),
  view: z
    .enum(memoryViews.map((item) => item.id))
    .optional()
    .catch(undefined),
  file: z.string().optional().catch(undefined),
  usageDays: z.coerce
    .number()
    .pipe(z.union([z.literal(7), z.literal(30), z.literal(90)]))
    .optional()
    .catch(undefined),
  backTo: backToSearchSchema,
});

export const skillsSearchSchema = resourceSearchSchema.extend({
  status: z.enum(['draft', 'pending', 'published', 'rejected']).optional().catch(undefined),
  usage: z.enum(['bound', 'unbound']).optional().catch(undefined),
  scope: z.enum(['internal', 'market']).optional().catch(undefined),
  marketView: z.enum(['all-time', 'trending', 'hot']).optional().catch(undefined),
  view: listViewSchema,
});

export const pluginsSearchSchema = resourceSearchSchema.extend({ view: listViewSchema });

export const pluginDetailSearchSchema = z.object({
  tab: z.enum(['intro', 'content']).optional().catch(undefined),
  file: z.string().optional().catch(undefined),
  mode: z.enum(['read', 'source']).optional().catch(undefined),
});

export const chatSearchSchema = z.object({
  agent: z.string().min(1).optional().catch(undefined),
  conversation: z.string().min(1).optional().catch(undefined),
  outputRun: z.string().min(1).optional().catch(undefined),
  outputPath: z.string().min(1).optional().catch(undefined),
  outputMode: z.enum(['read', 'source']).optional().catch(undefined),
});

export const rolesSearchSchema = z.object({
  role: z.string().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
});

export const auditSearchSchema = z.object({
  action: z.string().optional().catch(undefined),
  status: auditStatusSchema.optional().catch(undefined),
  target: z.string().optional().catch(undefined),
  actor: z.string().optional().catch(undefined),
  actorKind: auditActorKindSchema.optional().catch(undefined),
  range: z.coerce
    .string()
    .pipe(z.enum(['7', '30', '90']))
    .optional()
    .catch(undefined),
});

export const personalReviewsSearchSchema = z.object({
  agent: z.string().min(1).optional().catch(undefined),
  run: z.string().min(1).optional().catch(undefined),
  stage: z.enum(['pending', 'generating', 'aborted', 'done']).optional().catch(undefined),
  view: listViewSchema,
  create: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .catch(undefined)
    .transform((value) => (value === undefined ? undefined : value === true || value === 'true')),
});

export const personalSharesSearchSchema = z.object({
  cursor: z.string().min(1).max(200).optional().catch(undefined),
  view: listViewSchema,
});

export const personalUsageSearchSchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30).catch(30),
  agent: z.string().min(1).optional().catch(undefined),
  status: runStatusSchema.optional().catch(undefined),
  trigger: runTriggerSchema.optional().catch(undefined),
  cursor: z.string().min(1).max(200).optional().catch(undefined),
  view: listViewSchema,
});

export const runsSearchSchema = z.object({
  agent: z.string().optional().catch(undefined),
  status: runStatusSchema.optional().catch(undefined),
  trigger: runTriggerSchema.optional().catch(undefined),
  range: z.coerce
    .string()
    .pipe(z.enum(['7', '30', '90']))
    .optional()
    .catch(undefined),
  view: listViewSchema,
  preview: z.string().min(1).optional().catch(undefined),
});

export const channelsSearchSchema = z.object({ view: listViewSchema });

export const integrationsSearchSchema = z.object({
  tab: z.enum(['tokens', 'webhooks']).optional().catch(undefined),
  view: listViewSchema,
});

export const personalWorkSearchSchema = z.object({
  tab: z.enum(['conversations', 'outputs']).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  source: z.enum(['manual', 'scheduled']).optional().catch(undefined),
});

export const notificationsSearchSchema = z.object({
  filter: z.enum(['all', 'unread']).optional().catch(undefined),
});

export const schedulesSearchSchema = z.object({ view: listViewSchema });

export const personalSecuritySearchSchema = z.object({ view: listViewSchema });

export const accountsSearchSchema = z.object({
  q: z.string().optional().catch(undefined),
  view: listViewSchema,
  page: z.coerce.number().int().min(1).default(1).catch(1),
});

export const governanceTabSchema = z.enum([
  'cost',
  'budgets',
  'departments',
  'grants',
  'handover',
  'alerts',
]);

export const governanceSearchSchema = z.object({
  tab: governanceTabSchema.optional().catch(undefined),
  businessId: z.string().min(1).max(160).optional().catch(undefined),
  days: z.coerce
    .number()
    .pipe(z.union([z.literal(7), z.literal(30), z.literal(90)]))
    .optional()
    .catch(undefined),
  groupBy: z.enum(['user', 'department', 'model']).optional().catch(undefined),
  resourceKind: resourceKindSchema.optional().catch(undefined),
  resourceId: z.string().min(1).max(160).optional().catch(undefined),
  resourceQ: z.string().optional().catch(undefined),
});

export const modelsSearchSchema = z.object({
  q: z.string().optional().catch(undefined),
  status: z.enum(['all', 'enabled', 'disabled']).optional().catch(undefined),
  view: listViewSchema,
});

export const securitySearchSchema = z.object({
  tab: z.enum(['policies', 'approvals', 'events', 'violations']).optional().catch(undefined),
  approvalStatus: policyApprovalStatusSchema.optional().catch(undefined),
  eventAction: contentPolicyActionSchema.optional().catch(undefined),
  eventSource: policySourceKindSchema.optional().catch(undefined),
  violationStatus: violationCaseStatusSchema.optional().catch(undefined),
});

export const operationsSearchSchema = z.object({
  section: z.enum(['overview', 'observability', 'health']).optional().catch(undefined),
  tab: z.enum(['recent', 'agents']).optional().catch(undefined),
  obsTab: z.enum(['slo', 'queues', 'providers']).optional().catch(undefined),
  windowMinutes: z.coerce
    .number()
    .pipe(z.union([z.literal(15), z.literal(60), z.literal(360), z.literal(1440)]))
    .optional()
    .catch(undefined),
});

export const runDetailSearchSchema = z.object({
  step: z.coerce.number().int().nonnegative().optional().catch(undefined),
  tab: z.enum(['trace', 'delivery']).optional().catch(undefined),
  backTo: backToSearchSchema,
});

export const evalSearchSchema = z.object({
  agent: z.string().optional().catch(undefined),
  tab: z.enum(['runs', 'cases', 'compare']).optional().catch(undefined),
  run: z.string().min(1).optional().catch(undefined),
  failedOnly: z.coerce
    .string()
    .pipe(z.enum(['1']))
    .optional()
    .catch(undefined),
  caseId: z.string().min(1).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  filter: z.enum(['all', 'llm', 'contains', 'tools']).optional().catch(undefined),
  base: z.string().min(1).optional().catch(undefined),
  head: z.string().min(1).optional().catch(undefined),
  diff: z.enum(['changed', 'regressed', 'all']).optional().catch(undefined),
});

export const knowledgeSearchSchema = resourceSearchSchema.extend({
  status: knowledgeBaseStatusSchema.optional().catch(undefined),
  view: listViewSchema,
});

export const runtimeEnvironmentsSearchSchema = z.object({
  q: z.string().optional().catch(undefined),
  view: listViewSchema,
});

export const runtimeEnvironmentDetailSearchSchema = z.object({
  status: runtimeEnvironmentVersionStatusSchema.optional().catch(undefined),
  version: z.string().min(1).optional().catch(undefined),
  tab: z.enum(['versions', 'dockerfile']).optional().catch(undefined),
  backTo: backToSearchSchema,
});

export const dataDomainsSearchSchema = z.object({
  q: z.string().optional().catch(undefined),
  view: listViewSchema,
});

export const dataDomainDetailSearchSchema = z.object({
  version: z.string().min(1).optional().catch(undefined),
  approvalStatus: z.enum(['all', 'pending', 'approved', 'rejected']).optional().catch(undefined),
  queryStatus: dataDomainQueryLogStatusSchema.optional().catch(undefined),
  run: z.string().min(1).max(128).optional().catch(undefined),
  backTo: backToSearchSchema,
});

export const knowledgeDetailSearchSchema = z.object({
  panel: z
    .enum(knowledgeTabs.map((item) => item.id))
    .optional()
    .catch(undefined),
  document: z.string().min(1).optional().catch(undefined),
  page: z.string().optional().catch(undefined),
  folder: z.string().optional().catch(undefined),
  source: z.string().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  status: knowledgeDocumentStatusSchema.optional().catch(undefined),
  tag: z.string().min(1).optional().catch(undefined),
  sort: z.enum(['updated', 'created', 'title']).optional().catch(undefined),
  folders: z.array(z.string()).optional().catch(undefined),
  tags: z.array(z.string()).optional().catch(undefined),
  kinds: z.array(knowledgeContentKindSchema).optional().catch(undefined),
  rerank: z.boolean().optional().catch(undefined),
  minVectorScore: z.coerce.number().min(-1).max(1).optional().catch(undefined),
  onlyRecommended: z.boolean().optional().catch(undefined),
  faqPriority: z.boolean().optional().catch(undefined),
  faqDirectAnswerThreshold: z.coerce.number().min(-1).max(1).optional().catch(undefined),
  diagnostics: z.boolean().optional().catch(undefined),
});
