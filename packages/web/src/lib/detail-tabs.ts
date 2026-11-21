export const agentSections = [
  { id: 'identity', label: '身份' },
  { id: 'behavior', label: '行为' },
  { id: 'capability', label: '能力' },
  { id: 'permissions', label: '权限' },
  { id: 'limits', label: '运行限制' },
] as const;

export const agentTabs = [
  { id: 'overview', label: '概览' },
  { id: 'config', label: '配置' },
  { id: 'memory', label: '专家记忆' },
  { id: 'instructions', label: '指令' },
  { id: 'files', label: '文件与版本' },
] as const;

export type AgentTab = (typeof agentTabs)[number]['id'];
export type AgentSection = (typeof agentSections)[number]['id'];

export const legacyAgentTabs = ['rules', 'styles'] as const;

export const agentInstructions = [
  { id: 'rules', label: '项目规则' },
  { id: 'styles', label: '输出风格' },
  { id: 'workflows', label: '工作流' },
  { id: 'hooks', label: 'Hooks' },
] as const;

export type AgentInstruction = (typeof agentInstructions)[number]['id'];

export const memoryViews = [
  { id: 'overview', label: '概览' },
  { id: 'files', label: '文件' },
  { id: 'policy', label: '策略' },
] as const;

export type MemoryView = (typeof memoryViews)[number]['id'];

export const knowledgeTabs = [
  { id: 'overview', label: '概览' },
  { id: 'documents', label: '文档' },
  { id: 'images', label: '图片' },
  { id: 'sources', label: '来源' },
  { id: 'search', label: '检索测试' },
  { id: 'evaluations', label: '离线评估' },
  { id: 'faqs', label: 'FAQ' },
  { id: 'wiki', label: 'Wiki' },
  { id: 'jobs', label: '处理记录' },
] as const;
