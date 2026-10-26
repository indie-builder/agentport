import { AGENT_ROLES } from '@agentport/shared';
import { z } from 'zod';

export const resourceSearchSchema = z.object({
  q: z.string().optional().catch(undefined),
  sort: z.enum(['newest', 'name']).optional().catch(undefined),
});

export const serversSearchSchema = resourceSearchSchema.extend({
  kind: z.enum(['stdio', 'http', 'generated']).optional().catch(undefined),
});

export const agentsSearchSchema = resourceSearchSchema.extend({
  status: z.enum(['enabled', 'disabled']).optional().catch(undefined),
  role: z.enum(AGENT_ROLES).optional().catch(undefined),
});

const agentTabs = ['config', 'memory', 'rules', 'styles', 'files', 'stats'] as const;
const agentSections = ['identity', 'behavior', 'capability', 'permissions', 'limits'] as const;

/** 专家详情：任务、配置分区与选中文件都进 URL，刷新和分享后回到同一视图。 */
export const agentDetailSearchSchema = z.object({
  tab: z.enum(agentTabs).optional().catch(undefined),
  section: z.enum(agentSections).optional().catch(undefined),
  file: z.string().optional().catch(undefined),
});

export const skillsSearchSchema = resourceSearchSchema.extend({
  usage: z.enum(['bound', 'unbound']).optional().catch(undefined),
  scope: z.enum(['internal', 'market']).optional().catch(undefined),
  marketView: z.enum(['all-time', 'trending', 'hot']).optional().catch(undefined),
});

export const chatSearchSchema = z.object({
  agent: z.string().min(1).optional().catch(undefined),
  conversation: z.string().min(1).optional().catch(undefined),
});

export const auditSearchSchema = z.object({
  action: z.string().optional().catch(undefined),
  status: z.enum(['ok', 'error', 'denied']).optional().catch(undefined),
  target: z.string().optional().catch(undefined),
});

export const runsSearchSchema = z.object({
  agent: z.string().optional().catch(undefined),
  status: z
    .enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout'])
    .optional()
    .catch(undefined),
});

export const runDetailSearchSchema = z.object({
  step: z.coerce.number().int().nonnegative().optional().catch(undefined),
});

export const evalSearchSchema = z.object({
  agent: z.string().optional().catch(undefined),
});

export const knowledgeSearchSchema = resourceSearchSchema;

const knowledgeTabs = ['documents', 'search', 'wiki', 'sources', 'jobs'] as const;

/** 知识库详情：分区、Wiki 页面与文件夹都进 URL，刷新与分享后回到同一视图。 */
export const knowledgeDetailSearchSchema = z.object({
  panel: z.enum(knowledgeTabs).optional().catch(undefined),
  page: z.string().optional().catch(undefined),
  folder: z.string().optional().catch(undefined),
});
