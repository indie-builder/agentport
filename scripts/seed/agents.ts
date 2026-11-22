import { agents, repo, servers } from '@agentport/db';
import { eq } from 'drizzle-orm';
import { DEMO_AGENTS, DEMO_CONNECTOR } from './constants';
import type { DemoAgent, DemoCatalog, SeedContext } from './types';

interface AgentSpec {
  slug: string;
  name: string;
  role: string;
  description: string;
  systemPrompt: string;
  tags: string[];
  serverIds: string[];
}

export async function seedAgents(ctx: SeedContext, catalog: DemoCatalog): Promise<void> {
  const { db, businessId } = ctx;
  const model = process.env.SEED_AGENT_MODEL ?? 'claude-sonnet-5-5';

  const [existingServer] = await db
    .select({ id: servers.id, kind: servers.kind, config: servers.config })
    .from(servers)
    .where(eq(servers.name, DEMO_CONNECTOR.name))
    .limit(1);
  if (
    existingServer &&
    (existingServer.kind !== 'generated' ||
      existingServer.config.baseUrl !== DEMO_CONNECTOR.baseUrl)
  ) {
    throw new Error(`连接器「${DEMO_CONNECTOR.name}」已存在但不是演示配置，请先改名或清理`);
  }
  let serverId: string;
  let serverCreated = false;
  if (existingServer) {
    serverId = existingServer.id;
  } else {
    const row = await repo.servers.createServer(
      db,
      {
        name: DEMO_CONNECTOR.name,
        kind: 'generated',
        description: '演示用订单查询连接器，指向 JSONPlaceholder，不联网调用',
        config: {
          baseUrl: DEMO_CONNECTOR.baseUrl,
          mcpToken: crypto
            .getRandomValues(new Uint8Array(32))
            .toBase64({ alphabet: 'base64url', omitPadding: true }),
        },
        secretsEncrypted: null,
      },
      businessId,
    );
    serverId = row.id;
    serverCreated = true;
  }

  const tools: Array<Omit<repo.servers.ApiToolWrite, 'serverId'>> = [
    {
      name: 'get-user',
      description: '按用户 ID 查询用户资料',
      method: 'GET',
      pathTemplate: '/users/{id}',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: '用户 ID' } },
        required: ['id'],
      },
      paramsIn: 'query',
      approvalMode: 'allow',
    },
    {
      name: 'list-posts',
      description: '列出帖子，可按用户过滤',
      method: 'GET',
      pathTemplate: '/posts',
      inputSchema: {
        type: 'object',
        properties: { userId: { type: 'string', description: '按用户过滤帖子（可选）' } },
      },
      paramsIn: 'query',
      approvalMode: 'allow',
    },
  ];
  let toolsCreated = 0;
  if (serverCreated) {
    for (const tool of tools) {
      await repo.servers.createApiTool(db, { serverId, ...tool });
      toolsCreated += 1;
    }
  }
  ctx.log(
    `连接器：新建 ${serverCreated ? 1 : 0} / 复用 ${serverCreated ? 0 : 1}；工具新建 ${toolsCreated}`,
  );

  const analystSpec: AgentSpec = {
    ...DEMO_AGENTS.analyst,
    description: '梳理产品指标、定位异常并输出可执行的改进建议',
    systemPrompt:
      '你是产品分析师，负责整理产品指标、识别异常并给出可执行的改进建议。回答使用中文，先给结论，再列依据与下一步动作。',
    tags: ['演示', '产品'],
    serverIds: [serverId],
  };
  const supportSpec: AgentSpec = {
    ...DEMO_AGENTS.support,
    description: '汇总客户问题、升级工单与值班交接记录',
    systemPrompt:
      '你是客服主管，负责整理客户问题、升级工单与交接记录。回答使用中文，语气克制，明确当前状态、责任人和下一步。',
    tags: ['演示', '客服'],
    serverIds: [],
  };
  const complianceSpec: AgentSpec = {
    ...DEMO_AGENTS.compliance,
    description: '检查退款、隐私与数据使用是否符合内部政策',
    systemPrompt:
      '你是合规审查员，负责检查退款、隐私与数据使用是否符合内部政策。回答使用中文，指出风险条款并给出处理建议。',
    tags: ['演示', '合规'],
    serverIds: [],
  };
  const engineerSpec: AgentSpec = {
    ...DEMO_AGENTS.engineer,
    description: '负责前端性能、交互与可访问性改造',
    systemPrompt:
      '你是前端工程师，负责页面性能、交互与可访问性改进。回答使用中文，给出可落地的实现方案与验证方式。',
    tags: ['演示', '前端'],
    serverIds: [],
  };

  let created = 0;
  let reused = 0;
  async function ensureAgent(spec: AgentSpec): Promise<DemoAgent> {
    const [existing] = await db
      .select({ id: agents.id, slug: agents.slug, name: agents.name, tags: agents.tags })
      .from(agents)
      .where(eq(agents.slug, spec.slug))
      .limit(1);
    if (existing) {
      if (existing.name !== spec.name || !existing.tags.includes('演示')) {
        throw new Error(`专家 slug「${spec.slug}」已被「${existing.name}」占用，请先改名或清理`);
      }
      reused += 1;
      return existing;
    }
    const row = await repo.agents.createAgent(
      db,
      {
        slug: spec.slug,
        name: spec.name,
        role: spec.role,
        description: spec.description,
        model,
        systemPromptMd: spec.systemPrompt,
        allowedTools: [],
        disallowedTools: [],
        permissionMode: 'default',
        uiFormat: 'markdown',
        effort: null,
        enabled: true,
        visibility: 'organization',
        tags: spec.tags,
        maxTurns: 20,
        maxBudgetUsd: '2',
        monthlyBudgetUsd: null,
        budgetAlertRatio: '0.800',
        timeoutMs: 600_000,
        createdBy: businessId,
        ownerBusinessId: businessId,
        runtimeEnvironmentId: null,
      },
      spec.serverIds,
      [],
      [],
    );
    created += 1;
    return { id: row.id, slug: row.slug, name: row.name };
  }

  const analyst = await ensureAgent(analystSpec);
  const support = await ensureAgent(supportSpec);
  const compliance = await ensureAgent(complianceSpec);
  const engineer = await ensureAgent(engineerSpec);
  catalog.agents = { analyst, support, compliance, engineer };
  ctx.log(`专家：新建 ${created} / 复用 ${reused}`);
}
