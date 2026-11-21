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

export function badgeCreatedAt(value: string | undefined): { label: string; iso: string | null } {
  if (!value) return { label: '未记录', iso: null };
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? { label: '未记录', iso: null }
    : { label: badgeTimeFormatter.format(date), iso: value };
}

export const agentDefaults = agentInputSchema.parse({ slug: 'default', name: 'default' });

export const emptyInput: AgentInput = {
  slug: '',
  name: '',
  role: '通用助手',
  description: '',
  model: agentDefaults.model,
  systemPrompt: '',
  serverIds: [],
  skillIds: [],
  pluginBindings: [],
  subAgentIds: [],
  allowedTools: [],
  disallowedTools: [],
  permissionMode: 'default',
  uiFormat: 'markdown',
  maxTurns: agentDefaults.maxTurns,
  maxBudgetUsd: agentDefaults.maxBudgetUsd,
  monthlyBudgetUsd: agentDefaults.monthlyBudgetUsd,
  budgetAlertRatio: agentDefaults.budgetAlertRatio,
  timeoutMs: agentDefaults.timeoutMs,
  enabled: true,
  visibility: 'private',
  tags: [],
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
    monthlyBudgetUsd: agent.monthlyBudgetUsd,
    budgetAlertRatio: agent.budgetAlertRatio,
    timeoutMs: agent.timeoutMs,
    enabled: agent.enabled,
    visibility: agent.visibility ?? 'private',
    tags: agent.tags ?? [],
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

export function toolLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function tagList(text: string): string[] {
  return text
    .split(/[,，、]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export type AgentDraft = Omit<AgentInput, 'allowedTools' | 'tags'> & {
  allowedTools: string;
  tags: string;
};

export function draftFromInput(input: AgentInput): AgentDraft {
  return {
    ...input,
    allowedTools: input.allowedTools.join('\n'),
    tags: input.tags.join('、'),
  };
}

export function inputFromDraft(draft: AgentDraft): AgentInput {
  return {
    ...draft,
    allowedTools: toolLines(draft.allowedTools),
    tags: tagList(draft.tags),
  };
}

export const agentFormSchema = agentInputSchema
  .omit({ allowedTools: true })
  .extend({
    name: z
      .string()
      .trim()
      .min(1, '不能为空，请填写后再保存')
      .max(128, '最多 128 个字符，请精简后再保存'),
    description: z.string().max(300, '最多 300 个字符，请精简后再保存').default(''),
    allowedTools: z.string().default(''),
    tags: z
      .string()
      .default('')
      .superRefine((value, ctx) => {
        const tags = tagList(value);
        if (tags.length > 10) {
          ctx.addIssue({ code: 'custom', message: '最多 10 个标签，请精简后再保存' });
        }
        if (tags.some((tag) => tag.length > 24)) {
          ctx.addIssue({ code: 'custom', message: '单个标签最多 24 个字符，请精简后再保存' });
        }
      }),
    maxTurns: z
      .number({ error: invalidNumberMessage })
      .int(invalidNumberMessage)
      .positive(positiveIntMessage)
      .default(agentDefaults.maxTurns),
    maxBudgetUsd: z
      .number({ error: invalidNumberMessage })
      .positive(positiveIntMessage)
      .default(agentDefaults.maxBudgetUsd),
    monthlyBudgetUsd: z
      .number({ error: invalidNumberMessage })
      .min(0.01, '至少 0.01 美元，留空表示不限')
      .nullable()
      .default(agentDefaults.monthlyBudgetUsd),
    budgetAlertRatio: z
      .number({ error: invalidNumberMessage })
      .min(0.001, '至少 0.1%')
      .max(1, '最多 100%')
      .default(agentDefaults.budgetAlertRatio),
    timeoutMs: z
      .number({ error: invalidNumberMessage })
      .int(invalidNumberMessage)
      .positive(positiveIntMessage)
      .default(agentDefaults.timeoutMs),
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

const TAB_PERMISSIONS: Record<TabId, readonly PermissionId[] | null> = {
  overview: null,
  config: ['agents.config.read'],
  memory: ['agents.memory.read'],
  instructions: [
    'agents.rules.read',
    'agents.styles.read',
    'agents.workflows.read',
    'agents.hooks.read',
  ],
  files: ['agents.files.read'],
};

const INSTRUCTION_PERMISSIONS: Record<AgentInstruction, PermissionId> = {
  rules: 'agents.rules.read',
  styles: 'agents.styles.read',
  workflows: 'agents.workflows.read',
  hooks: 'agents.hooks.read',
};

export function canOpenTab(id: TabId, permissions: readonly PermissionId[]): boolean {
  const required = TAB_PERMISSIONS[id];
  return required === null || required.some((permission) => hasAnyGrant(permissions, permission));
}

export function asInstruction(value: unknown): AgentInstruction | undefined {
  return instructionItems.some((item) => item.id === value)
    ? (value as AgentInstruction)
    : undefined;
}

export function normalizeTab(value: unknown): TabId | undefined {
  if (asInstruction(value)) return 'instructions';
  return tabItems.some((item) => item.id === value) ? (value as TabId) : undefined;
}

export function activeAgentTab(value: unknown, permissions: readonly PermissionId[]): TabId {
  const available = tabItems.filter((item) => canOpenTab(item.id, permissions));
  const requested = normalizeTab(value) ?? available[0]?.id ?? 'overview';
  return available.some((item) => item.id === requested)
    ? requested
    : (available[0]?.id ?? 'overview');
}

export function availableInstructions(
  permissions: readonly PermissionId[],
  isSubAgent: boolean,
): (typeof instructionItems)[number][] {
  return instructionItems.filter(
    (item) =>
      ((item.id !== 'workflows' && item.id !== 'hooks') || !isSubAgent) &&
      hasAnyGrant(permissions, INSTRUCTION_PERMISSIONS[item.id]),
  );
}

export function activeInstruction(
  value: unknown,
  permissions: readonly PermissionId[],
  isSubAgent = false,
): AgentInstruction | undefined {
  const available = availableInstructions(permissions, isSubAgent);
  const requested = asInstruction(value) ?? available[0]?.id;
  return available.some((item) => item.id === requested) ? requested : available[0]?.id;
}

export function mergeKnowledgeIds(
  current: string[],
  knowledgeIds: Set<string>,
  next: string[],
): string[] {
  return [...current.filter((id) => !knowledgeIds.has(id)), ...next];
}

type AgentEditClass = 'config' | 'binding' | 'enable';

const agentFieldMap: Record<
  keyof AgentInput,
  { section: SectionId | null; editClass: AgentEditClass }
> = {
  slug: { section: 'identity', editClass: 'config' },
  name: { section: 'identity', editClass: 'config' },
  role: { section: 'identity', editClass: 'config' },
  description: { section: 'identity', editClass: 'config' },
  visibility: { section: 'identity', editClass: 'config' },
  tags: { section: 'identity', editClass: 'config' },
  model: { section: 'behavior', editClass: 'config' },
  effort: { section: 'behavior', editClass: 'config' },
  systemPrompt: { section: 'behavior', editClass: 'config' },
  serverIds: { section: 'capability', editClass: 'binding' },
  skillIds: { section: 'capability', editClass: 'binding' },
  pluginBindings: { section: 'capability', editClass: 'binding' },
  subAgentIds: { section: 'capability', editClass: 'binding' },
  permissionMode: { section: 'permissions', editClass: 'config' },
  allowedTools: { section: 'permissions', editClass: 'config' },
  disallowedTools: { section: 'permissions', editClass: 'config' },
  runtimeEnvironmentId: { section: 'limits', editClass: 'config' },
  uiFormat: { section: 'limits', editClass: 'config' },
  maxTurns: { section: 'limits', editClass: 'config' },
  maxBudgetUsd: { section: 'limits', editClass: 'config' },
  monthlyBudgetUsd: { section: 'limits', editClass: 'config' },
  budgetAlertRatio: { section: 'limits', editClass: 'config' },
  timeoutMs: { section: 'limits', editClass: 'config' },
  enabled: { section: null, editClass: 'enable' },
};

function fieldsByEditClass(editClass: AgentEditClass): Array<keyof AgentInput> {
  return (Object.keys(agentFieldMap) as Array<keyof AgentInput>).filter(
    (key) => agentFieldMap[key].editClass === editClass,
  );
}

export const configKeys = fieldsByEditClass('config');
export const bindingKeys = fieldsByEditClass('binding');

export const errorSections = Object.fromEntries(
  (Object.keys(agentFieldMap) as Array<keyof AgentInput>).flatMap((key) => {
    const section = agentFieldMap[key].section;
    return section === null ? [] : [[key, section]];
  }),
) as Partial<Record<keyof AgentInput, SectionId>>;
export type FileEntry = { id: string; path: string; group: string; content: string };

export const baseFileEntries: FileEntry[] = [
  { id: '.mcp.json', path: '.mcp.json', group: '根文件', content: '' },
  { id: 'CLAUDE.md', path: 'CLAUDE.md', group: '根文件', content: '' },
  { id: 'preview:agent-md', path: 'agent md', group: '根文件', content: '' },
];

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
    ...(files.workflows ?? []).map((workflow) => ({
      id: `.claude/workflows/${workflow.slug}.js`,
      path: `workflows/${workflow.slug}.js`,
      group: '工作流',
      content: workflow.content,
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
    ...(files.hookFiles ?? []).map((file) => ({
      id: `.claude/hooks/${file.path}`,
      path: `hooks/${file.path}`,
      group: 'Hooks',
      content: file.content,
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
