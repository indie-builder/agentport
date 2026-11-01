import { AGENT_ROLES } from '@agentport/shared';
import { z } from 'zod';

export const resourceSearchSchema = z.object({
  q: z.string().optional().catch(undefined),
  sort: z.enum(['newest', 'name']).optional().catch(undefined),
});

/** 表格/卡片切换进 URL；非法值忽略，由页面回落到默认视图。 */
export const listViewSchema = z.enum(['table', 'cards']).optional().catch(undefined);

export const serversSearchSchema = resourceSearchSchema.extend({
  kind: z.enum(['stdio', 'http', 'generated']).optional().catch(undefined),
});

export const agentsSearchSchema = resourceSearchSchema.extend({
  // 默认发现已启用的专家；all 与 disabled 是筛选里的显式选项。
  status: z.enum(['all', 'enabled', 'disabled']).optional().catch(undefined),
  role: z.enum(AGENT_ROLES).optional().catch(undefined),
});

const agentTabs = ['config', 'memory', 'rules', 'styles', 'files'] as const;
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

export const pluginsSearchSchema = resourceSearchSchema;

/** 插件详情：简介/内容、选中文件与阅读/源码模式进 URL，刷新和分享后回到同一视图。 */
export const pluginDetailSearchSchema = z.object({
  tab: z.enum(['intro', 'content']).optional().catch(undefined),
  file: z.string().optional().catch(undefined),
  mode: z.enum(['read', 'source']).optional().catch(undefined),
});

export const chatSearchSchema = z.object({
  agent: z.string().min(1).optional().catch(undefined),
  conversation: z.string().min(1).optional().catch(undefined),
  /** 会话成果：选中的版本与文件进 URL，刷新后回到同一预览。 */
  outputRun: z.string().min(1).optional().catch(undefined),
  outputPath: z.string().min(1).optional().catch(undefined),
  outputMode: z.enum(['read', 'source']).optional().catch(undefined),
});

/** 角色页：设置弹层目标角色与权限搜索进 URL，刷新和分享回到同一视图。 */
export const rolesSearchSchema = z.object({
  role: z.string().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
});

export const auditSearchSchema = z.object({
  action: z.string().optional().catch(undefined),
  status: z.enum(['ok', 'error', 'denied']).optional().catch(undefined),
  target: z.string().optional().catch(undefined),
});

const runStatuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout'] as const;
const runTriggers = ['chat', 'mcp', 'schedule', 'event', 'review'] as const;

/** 个人记忆提案：专家筛选、选中提案、阶段筛选、列表布局与创建入口都进 URL，链接可复现同一视图。 */
export const personalReviewsSearchSchema = z.object({
  agent: z.string().min(1).optional().catch(undefined),
  run: z.string().min(1).optional().catch(undefined),
  stage: z.enum(['pending', 'generating', 'done']).optional().catch(undefined),
  view: listViewSchema,
  create: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .catch(undefined)
    .transform((value) => (value === undefined ? undefined : value === true || value === 'true')),
});

/** 我的分享：游标分页进 URL，刷新和返回保持同一页。 */
export const personalSharesSearchSchema = z.object({
  cursor: z.string().min(1).max(200).optional().catch(undefined),
  view: listViewSchema,
});

/** 使用记录：窗口、筛选与游标都进 URL；汇总只随窗口变化。 */
export const personalUsageSearchSchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30).catch(30),
  agent: z.string().min(1).optional().catch(undefined),
  status: z.enum(runStatuses).optional().catch(undefined),
  trigger: z.enum(runTriggers).optional().catch(undefined),
  cursor: z.string().min(1).max(200).optional().catch(undefined),
  view: listViewSchema,
});

export const runsSearchSchema = z.object({
  agent: z.string().optional().catch(undefined),
  status: z.enum(runStatuses).optional().catch(undefined),
  view: listViewSchema,
});

export const schedulesSearchSchema = z.object({ view: listViewSchema });

export const personalSecuritySearchSchema = z.object({ view: listViewSchema });

export const accountsSearchSchema = z.object({ view: listViewSchema });

/** 运行详情：返回来源用进入前的相对 URL，刷新后能回到同一列表视图。 */
export const runDetailSearchSchema = z.object({
  step: z.coerce.number().int().nonnegative().optional().catch(undefined),
  // 只接受站内相对地址，三层校验：必须以 / 开头（相对地址）；不能以 // 开头（协议相对地址会离站）；
  // 不能含反斜杠或空白（URL 解析器会把 \ 归一化成 /、裁剪空白，再拼成离站地址）。
  // 最后解析一次作兜底：origin 必须仍是占位站。
  backTo: z
    .string()
    .min(1)
    .max(2048)
    .refine((value) => {
      if (!value.startsWith('/') || value.startsWith('//') || /[\\\s]/.test(value)) return false;
      try {
        return (
          new URL(value, 'https://placeholder.invalid').origin === 'https://placeholder.invalid'
        );
      } catch {
        return false;
      }
    })
    .optional()
    .catch(undefined),
});

/** 评估：选中运行与比较两侧都进 URL，深链可打开不在当前分页里的批次。 */
export const evalSearchSchema = z.object({
  agent: z.string().optional().catch(undefined),
  run: z.string().min(1).optional().catch(undefined),
  base: z.string().min(1).optional().catch(undefined),
  head: z.string().min(1).optional().catch(undefined),
});

export const knowledgeSearchSchema = resourceSearchSchema;

const buildStatuses = ['queued', 'building', 'ready', 'failed'] as const;

export const runtimeEnvironmentsSearchSchema = z.object({
  q: z.string().optional().catch(undefined),
  view: listViewSchema,
});

/** 运行环境详情：状态筛选与选中的构建版本进 URL，刷新与分享后回到同一视图。 */
export const runtimeEnvironmentDetailSearchSchema = z.object({
  status: z.enum(buildStatuses).optional().catch(undefined),
  version: z.string().min(1).optional().catch(undefined),
});

const knowledgeTabs = [
  'documents',
  'search',
  'evaluations',
  'faqs',
  'wiki',
  'sources',
  'jobs',
] as const;
const knowledgeKinds = ['document', 'faq', 'wiki'] as const;

/**
 * 知识库详情：分区、Wiki 页面、文档与来源选中、检索条件都进 URL。
 * 数组经 Router 默认 JSON 序列化，刷新与分享后回到同一筛选。
 */
export const knowledgeDetailSearchSchema = z.object({
  panel: z.enum(knowledgeTabs).optional().catch(undefined),
  /** 处理记录按文档过滤；API 参数名为 documentId，URL 用面向用户的 document。 */
  document: z.string().min(1).optional().catch(undefined),
  page: z.string().optional().catch(undefined),
  folder: z.string().optional().catch(undefined),
  source: z.string().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  folders: z.array(z.string()).optional().catch(undefined),
  tags: z.array(z.string()).optional().catch(undefined),
  kinds: z.array(z.enum(knowledgeKinds)).optional().catch(undefined),
  rerank: z.boolean().optional().catch(undefined),
  minVectorScore: z.coerce.number().min(-1).max(1).optional().catch(undefined),
  onlyRecommended: z.boolean().optional().catch(undefined),
  faqPriority: z.boolean().optional().catch(undefined),
  faqDirectAnswerThreshold: z.coerce.number().min(-1).max(1).optional().catch(undefined),
  diagnostics: z.boolean().optional().catch(undefined),
});
