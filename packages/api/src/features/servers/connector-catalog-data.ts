import type { ConnectorCatalogItem } from '@agentport/shared';

/**
 * 策划的连接器目录（非实时 registry）。仅用于「浏览 → 预填创建表单」。
 * 每条记录 sourceUrl 与 reviewedAt；新增/更新条目必须人工核对官方文档，
 * 绝不在此写入任何密钥值，也不在浏览/选择时执行任何命令。
 * 发布前请复核来源与 endpoint，并保留"Curated"标识。
 */
const REVIEWED_AT = '2026-10-23';

export const connectorCatalog: ConnectorCatalogItem[] = [
  {
    slug: 'context7',
    name: 'Context7',
    description: '按库/框架拉取最新官方文档与示例，避免模型用过时知识回答。',
    kind: 'http',
    url: 'https://mcp.context7.com/mcp',
    sourceUrl: 'https://github.com/upstash/context7',
    reviewedAt: REVIEWED_AT,
  },
  {
    slug: 'deepwiki',
    name: 'DeepWiki',
    description: '对公开 GitHub 仓库生成可查询的维基式文档问答。',
    kind: 'http',
    url: 'https://mcp.deepwiki.com/mcp',
    sourceUrl: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
    reviewedAt: REVIEWED_AT,
  },
  {
    slug: 'notion',
    name: 'Notion',
    description: '读取与检索 Notion 页面、数据库，辅助写作与知识整理。',
    kind: 'http',
    url: 'https://mcp.notion.com/mcp',
    sourceUrl: 'https://developers.notion.com/docs/mcp',
    reviewedAt: REVIEWED_AT,
  },
  {
    slug: 'linear',
    name: 'Linear',
    description: '查询与创建 Linear issue、项目与团队信息。',
    kind: 'http',
    url: 'https://mcp.linear.app/mcp',
    sourceUrl: 'https://linear.app/docs/mcp',
    reviewedAt: REVIEWED_AT,
  },
  {
    slug: 'sentry',
    name: 'Sentry',
    description: '查询错误、性能与发布相关信息，辅助排障。',
    kind: 'http',
    url: 'https://mcp.sentry.dev/mcp',
    sourceUrl: 'https://docs.sentry.io/product/sentry-mcp/',
    reviewedAt: REVIEWED_AT,
  },
  {
    slug: 'supabase',
    name: 'Supabase',
    description: '查询 Supabase 项目、表结构与数据（需对应项目权限）。',
    kind: 'http',
    url: 'https://mcp.supabase.com/mcp',
    sourceUrl: 'https://supabase.com/docs/guides/getting-started/mcp',
    reviewedAt: REVIEWED_AT,
  },
  {
    slug: 'stripe',
    name: 'Stripe',
    description: '查询客户、支付与产品等 Stripe 资源（需 API 凭证）。',
    kind: 'http',
    url: 'https://mcp.stripe.com',
    sourceUrl: 'https://docs.stripe.com/mcp',
    reviewedAt: REVIEWED_AT,
  },
  {
    slug: 'huggingface',
    name: 'Hugging Face',
    description: '搜索模型、数据集与 Spaces。',
    kind: 'http',
    url: 'https://huggingface.co/mcp',
    sourceUrl: 'https://huggingface.co/settings/mcp',
    reviewedAt: REVIEWED_AT,
  },
  {
    slug: 'fetch',
    name: 'Fetch（官方参考）',
    description: '抓取网页并转 Markdown；stdio 参考服务器，测试连接会在宿主执行命令。',
    kind: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    reviewedAt: REVIEWED_AT,
  },
  {
    slug: 'memory',
    name: 'Memory（官方参考）',
    description: '基于知识图谱的持久记忆；stdio 参考服务器，测试连接会在宿主执行命令。',
    kind: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    reviewedAt: REVIEWED_AT,
  },
];
