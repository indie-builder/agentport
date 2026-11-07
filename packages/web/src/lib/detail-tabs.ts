export const agentSections = [
  { id: 'identity', label: '身份' },
  { id: 'behavior', label: '行为' },
  { id: 'capability', label: '能力' },
  { id: 'permissions', label: '权限' },
  { id: 'limits', label: '运行限制' },
] as const;

export const agentTabs = [
  { id: 'config', label: '配置' },
  { id: 'memory', label: '专家记忆' },
  { id: 'rules', label: '项目规则' },
  { id: 'styles', label: '输出风格' },
  { id: 'files', label: '完整文件' },
] as const;

export const knowledgeTabs = [
  { id: 'documents', label: '文档' },
  { id: 'sources', label: '来源' },
  { id: 'search', label: '检索测试' },
  { id: 'evaluations', label: '离线评估' },
  { id: 'faqs', label: 'FAQ' },
  { id: 'wiki', label: 'Wiki' },
  { id: 'jobs', label: '处理记录' },
] as const;
