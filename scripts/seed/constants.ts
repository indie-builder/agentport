export const DEMO_AGENTS = {
  analyst: { slug: 'demo-product-analyst', name: '演示·产品分析师', role: '产品分析师' },
  support: { slug: 'demo-support-lead', name: '演示·客服主管', role: '客服主管' },
  compliance: { slug: 'demo-compliance-reviewer', name: '演示·合规审查员', role: '合规审查员' },
  engineer: { slug: 'demo-frontend-engineer', name: '演示·前端工程师', role: '前端工程师' },
} as const;

export const DEMO_CHANNELS = {
  delivery: { name: '演示·产品交付协作', description: '产品、客服与合规共同跟进交付事项' },
  support: { name: '演示·客服值班', description: '客服日常交接与升级记录' },
} as const;

export const DEMO_KNOWLEDGE = { slug: 'demo-handbook', name: '演示·业务手册' } as const;

export const DEMO_CONVERSATIONS = {
  review: '演示·季度运营复盘',
  incident: '演示·线上故障复盘',
  planning: '演示·下季度规划',
} as const;

export const DEMO_CONNECTOR = {
  name: 'demo-order-api',
  baseUrl: 'https://jsonplaceholder.typicode.com',
} as const;
