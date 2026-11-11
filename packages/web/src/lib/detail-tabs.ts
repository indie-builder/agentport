export const agentSections = [
  { id: 'identity', label: '身份' },
  { id: 'behavior', label: '行为' },
  { id: 'capability', label: '能力' },
  { id: 'permissions', label: '权限' },
  { id: 'limits', label: '运行限制' },
] as const;

/** 任务页签按使用动线排列：先判断是什么，再改定义、记忆、指令，最后查原始文件。 */
export const agentTabs = [
  { id: 'overview', label: '概览' },
  { id: 'config', label: '配置' },
  { id: 'memory', label: '专家记忆' },
  { id: 'instructions', label: '指令' },
  { id: 'files', label: '文件与版本' },
] as const;

export type AgentTab = (typeof agentTabs)[number]['id'];
export type AgentSection = (typeof agentSections)[number]['id'];

/**
 * 旧书签的 tab 取值：`rules` / `styles` 曾是独立页签，现在并入「指令」页。
 * 进入后规范化为 `tab=instructions` + `instruction=rules|styles`。
 */
export const legacyAgentTabs = ['rules', 'styles'] as const;

/** 「指令」页内部分段：项目规则、输出风格与工作流各自保留原有面板与权限。 */
export const agentInstructions = [
  { id: 'rules', label: '项目规则' },
  { id: 'styles', label: '输出风格' },
  { id: 'workflows', label: '工作流' },
] as const;

export type AgentInstruction = (typeof agentInstructions)[number]['id'];

/** 专家记忆的子视图：概览 / 文件 / 策略，写进 URL search。 */
export const memoryViews = [
  { id: 'overview', label: '概览' },
  { id: 'files', label: '文件' },
  { id: 'policy', label: '策略' },
] as const;

export type MemoryView = (typeof memoryViews)[number]['id'];

export const knowledgeTabs = [
  { id: 'overview', label: '概览' },
  { id: 'documents', label: '文档' },
  { id: 'sources', label: '来源' },
  { id: 'search', label: '检索测试' },
  { id: 'evaluations', label: '离线评估' },
  { id: 'faqs', label: 'FAQ' },
  { id: 'wiki', label: 'Wiki' },
  { id: 'jobs', label: '处理记录' },
] as const;
