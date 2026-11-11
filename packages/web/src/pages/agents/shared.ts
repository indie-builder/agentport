import {
  AGENT_ROLES,
  type Agent,
  type AgentInput,
  agentDuplicateInputSchema,
  agentInputSchema,
  type PermissionId,
} from '@agentport/shared';
import { z } from 'zod';
import { hasAnyGrant } from '../../lib/access.js';
import type { AgentFiles } from '../../lib/api.js';
import {
  type AgentInstruction,
  type AgentSection,
  type AgentTab,
  agentInstructions as instructionItems,
  agentTabs as tabItems,
} from '../../lib/detail-tabs.js';

/**
 * 模型名由部署的网关决定，不是平台常量：直连 Anthropic 时是 claude-*，
 * 用自建网关时是网关 /v1/models 里的 id。这里给的是当前部署的默认值，
 * 创建后仍可手改，所以不要把它当成白名单。
 */
export const models = ['group/flash', 'auto/deepseek-v4.1-flash', 'workbuddy/kimi-k3-2'];

export const roleOptions = AGENT_ROLES.map((role) => ({ value: role, label: role }));

const badgeTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});

/** 工牌只展示真实的创建时间；缺失或无法解析时明确写「未记录」。 */
export function badgeCreatedAt(value: string | undefined): { label: string; iso: string | null } {
  if (!value) return { label: '未记录', iso: null };
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? { label: '未记录', iso: null }
    : { label: badgeTimeFormatter.format(date), iso: value };
}

export const emptyInput: AgentInput = {
  slug: '',
  name: '',
  role: '通用助手',
  description: '',
  model: 'claude-sonnet-5-5',
  systemPrompt: '',
  serverIds: [],
  skillIds: [],
  pluginBindings: [],
  subAgentIds: [],
  allowedTools: [],
  disallowedTools: [],
  permissionMode: 'default',
  uiFormat: 'markdown',
  maxTurns: 20,
  maxBudgetUsd: 2,
  timeoutMs: 600_000,
  enabled: true,
  runtimeEnvironmentId: null,
};

export function toInput(agent: Agent): AgentInput {
  return {
    slug: agent.slug,
    name: agent.name,
    role: agent.role?.trim() ? agent.role : '通用助手',
    description: agent.description,
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    serverIds: agent.serverIds,
    skillIds: agent.skillIds,
    pluginBindings: agent.pluginBindings,
    subAgentIds: agent.subAgentIds,
    allowedTools: agent.allowedTools,
    disallowedTools: agent.disallowedTools,
    permissionMode: agent.permissionMode,
    uiFormat: agent.uiFormat,
    maxTurns: agent.maxTurns,
    maxBudgetUsd: agent.maxBudgetUsd,
    timeoutMs: agent.timeoutMs,
    enabled: agent.enabled,
    runtimeEnvironmentId: agent.runtimeEnvironmentId,
    // 显式保留 undefined 键：RHF 的 defaultValues 必须覆盖每个受控字段，
    // 否则 reset 后 useController 写回的 undefined 会让表单再次判定为 dirty。
    effort: agent.effort,
  };
}

const positiveIntMessage = '必须大于 0，请调整后再保存';
const invalidNumberMessage = '请填写有效内容';

/** 原生文件工具：父按平台路径范围使用，子仅能访问自身记忆目录；两者都可显式关闭。 */
const FILE_TOOLS = ['Read', 'Write', 'Edit'] as const;

export function isFileTool(tool: string): tool is (typeof FILE_TOOLS)[number] {
  return FILE_TOOLS.includes(tool as (typeof FILE_TOOLS)[number]);
}

/** 每行一个工具名；空白行忽略，中间空白行不会把未完成的草稿规范化掉。 */
export function toolLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * 表单里保留原始文本：工具列表在输入过程中可能还不合法，
 * 但 RHF 必须能存住这份中间草稿，提交时才解析成 AgentInput。
 */
export type AgentDraft = Omit<AgentInput, 'allowedTools'> & {
  allowedTools: string;
};

export function draftFromInput(input: AgentInput): AgentDraft {
  return {
    ...input,
    allowedTools: input.allowedTools.join('\n'),
  };
}

export function inputFromDraft(draft: AgentDraft): AgentInput {
  return {
    ...draft,
    allowedTools: toolLines(draft.allowedTools),
  };
}

export const agentFormSchema = agentInputSchema
  .omit({ allowedTools: true })
  .extend({
    name: z.string().min(1, '不能为空，请填写后再保存').max(128, '最多 128 个字符，请精简后再保存'),
    description: z.string().max(300, '最多 300 个字符，请精简后再保存').default(''),
    allowedTools: z.string().default(''),
    maxTurns: z
      .number({ error: invalidNumberMessage })
      .int(invalidNumberMessage)
      .positive(positiveIntMessage)
      .default(20),
    maxBudgetUsd: z.number({ error: invalidNumberMessage }).positive(positiveIntMessage).default(2),
    timeoutMs: z
      .number({ error: invalidNumberMessage })
      .int(invalidNumberMessage)
      .positive(positiveIntMessage)
      .default(600_000),
  })
  .superRefine((value, ctx) => {
    if (!toolLines(value.allowedTools).every((tool) => !/\s/.test(tool))) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedTools'],
        message: '每行只能有一个工具名或模式，不能包含空格。',
      });
    }
  });

export const agentCreateFormSchema = agentFormSchema.safeExtend({
  name: z
    .string()
    .trim()
    .min(1, '不能为空，请填写后再保存')
    .max(128, '最多 128 个字符，请精简后再保存'),
  slug: z
    .string()
    .trim()
    .pipe(z.union([z.literal(''), agentInputSchema.shape.slug])),
});

export const duplicateFormSchema = agentDuplicateInputSchema.extend({
  slug: z
    .string()
    .min(1, '不能为空，请填写后再保存')
    .max(64, '最多 64 个字符，请精简后再保存')
    .regex(/^[a-z0-9][a-z0-9-_]*$/, '格式不正确，请检查后重新填写'),
  name: z
    .string()
    .trim()
    .min(1, '不能为空，请填写后再保存')
    .max(128, '最多 128 个字符，请精简后再保存'),
});

export type SectionId = AgentSection;
export type TabId = AgentTab;

/**
 * 概览没有权限叶，所有能打开该专家的人都可见；「指令」页只要规则或输出风格之一可读即可进入。
 * 内层分段再按各自权限决定渲染哪一项。
 */
const TAB_PERMISSIONS: Record<TabId, readonly PermissionId[] | null> = {
  overview: null,
  config: ['agents.config.read'],
  memory: ['agents.memory.read'],
  instructions: ['agents.rules.read', 'agents.styles.read'],
  files: ['agents.files.read'],
};

export const INSTRUCTION_PERMISSIONS: Record<AgentInstruction, PermissionId> = {
  rules: 'agents.rules.read',
  styles: 'agents.styles.read',
};

export function canOpenTab(id: TabId, permissions: readonly PermissionId[]): boolean {
  const required = TAB_PERMISSIONS[id];
  return required === null || required.some((permission) => hasAnyGrant(permissions, permission));
}

export function asInstruction(value: unknown): AgentInstruction | undefined {
  return value === 'rules' || value === 'styles' ? value : undefined;
}

/** 旧书签的 rules / styles 指向合并后的「指令」页。 */
export function normalizeTab(value: unknown): TabId | undefined {
  if (asInstruction(value)) return 'instructions';
  return tabItems.some((item) => item.id === value) ? (value as TabId) : undefined;
}

/** URL 里的任务可能没有读权限，回落到第一个可读任务，页面与页头共用同一判定。 */
export function activeAgentTab(value: unknown, permissions: readonly PermissionId[]): TabId {
  const available = tabItems.filter((item) => canOpenTab(item.id, permissions));
  const requested = normalizeTab(value) ?? available[0]?.id ?? 'overview';
  return available.some((item) => item.id === requested)
    ? requested
    : (available[0]?.id ?? 'overview');
}

/** 指令分段只保留有读权的一项；URL 值失效时回落到第一个可读项。 */
export function activeInstruction(
  value: unknown,
  permissions: readonly PermissionId[],
): AgentInstruction | undefined {
  const available = instructionItems.filter((item) =>
    hasAnyGrant(permissions, INSTRUCTION_PERMISSIONS[item.id]),
  );
  const requested = asInstruction(value) ?? available[0]?.id;
  return available.some((item) => item.id === requested) ? requested : available[0]?.id;
}

/** 普通连接器与知识库共用一个 serverIds：只替换知识库那部分，其余绑定原样保留。 */
export function mergeKnowledgeIds(
  current: string[],
  knowledgeIds: Set<string>,
  next: string[],
): string[] {
  return [...current.filter((id) => !knowledgeIds.has(id)), ...next];
}

export const errorSections: Record<string, SectionId> = {
  slug: 'identity',
  name: 'identity',
  role: 'identity',
  description: 'identity',
  systemPrompt: 'behavior',
  model: 'behavior',
  effort: 'behavior',
  serverIds: 'capability',
  skillIds: 'capability',
  subAgentIds: 'capability',
  permissionMode: 'permissions',
  allowedTools: 'permissions',
  disallowedTools: 'permissions',
  uiFormat: 'limits',
  maxTurns: 'limits',
  maxBudgetUsd: 'limits',
  timeoutMs: 'limits',
};

export type FileEntry = { id: string; path: string; group: string; content: string };

/** 加载中或失败时也保留根文件入口，文件与版本视图和重试界面才始终可达。 */
export const baseFileEntries: FileEntry[] = [
  { id: '.mcp.json', path: '.mcp.json', group: '根文件', content: '' },
  { id: 'CLAUDE.md', path: 'CLAUDE.md', group: '根文件', content: '' },
  { id: 'preview:agent-md', path: 'agent md', group: '根文件', content: '' },
];

/** 文件与版本视图的唯一清单来源：group 只承载导航结构，id 用作稳定选择键。 */
export function listWorkspaceFiles(files: AgentFiles): FileEntry[] {
  return [
    { id: '.mcp.json', path: '.mcp.json', group: '根文件', content: files.mcpJson },
    { id: 'CLAUDE.md', path: 'CLAUDE.md', group: '根文件', content: files.claudeMd },
    { id: 'preview:agent-md', path: 'agent md', group: '根文件', content: files.agentMd },
    {
      id: '.claude/settings.json',
      path: '.claude/settings.json',
      group: '根文件',
      content: files.settingsJson,
    },
    ...(files.skills ?? []).flatMap((skill) => [
      {
        id: `.claude/skills/${skill.slug}/SKILL.md`,
        path: `skills/${skill.slug}/SKILL.md`,
        group: '技能',
        content: skill.content,
      },
      ...(skill.files ?? []).map((file) => ({
        id: `.claude/skills/${skill.slug}/${file.path}`,
        path: `skills/${skill.slug}/${file.path}`,
        group: '技能',
        content: file.content,
      })),
    ]),
    ...(files.subAgents ?? []).map((subAgent) => ({
      id: `.claude/agents/${subAgent.slug}.md`,
      path: `agents/${subAgent.slug}.md`,
      group: '子智能体',
      content: subAgent.content,
    })),
    ...(files.rules ?? []).map((rule) => ({
      id: `.claude/rules/${rule.slug}.md`,
      path: `rules/${rule.slug}.md`,
      group: '规则',
      content: rule.content,
    })),
    ...(files.outputStyles ?? []).map((style) => ({
      id: `.claude/output-styles/${style.slug}.md`,
      path: `output-styles/${style.slug}.md`,
      group: '输出风格',
      content: style.content,
    })),
    ...(files.plugins ?? []).flatMap((plugin) =>
      plugin.files.map((file) => ({
        id: `.claude/plugins/${plugin.slug}/${file.path}`,
        path: `plugins/${plugin.slug}/${file.path}`,
        group: '插件',
        content: file.content,
      })),
    ),
  ];
}
