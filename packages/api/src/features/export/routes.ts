import type { McpJsonEntry, WorkspaceSkill } from '@agentport/core';
import { decryptSecrets, renderWorkspace, toWorkspaceInput } from '@agentport/core';
import type { Database } from '@agentport/db';
import { agentServers, agentSkills, apiTools, servers, skills } from '@agentport/db';
import * as agentRepo from '@agentport/db/repo/agents.js';
import {
  AGENT_PACKAGE_MAX_BYTES,
  idParams,
  maskUrlCredentials,
  serializeAgentPackage,
} from '@agentport/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import { str, strArray } from '../servers/repo.js';

type AgentRow = Awaited<ReturnType<typeof agentRepo.getAgent>>;
type ServerRow = typeof servers.$inferSelect;
type SkillRow = typeof skills.$inferSelect;
type ToolRow = typeof apiTools.$inferSelect;

/** 一个智能体导出最多带 20 个直接子定义；超过就明确拒绝，不截断。 */
const MAX_SUB_AGENTS = 20;
/** 根 + 子智能体的资源并集上限；超过就明确拒绝，不截断。 */
const MAX_RESOURCES = 100;

/** 导出里只留非敏感配置；generated 的 mcpToken 和加密列的值一律不出现。 */
function toExportedServer(row: ServerRow, key: string, tools: ToolRow[] | undefined) {
  const { mcpToken: _mcpToken, ...config } = row.config;
  // 旧数据可能把账号密码写在 URL 里：复制一份再遮，库里的原文不动。
  for (const field of ['url', 'baseUrl'] as const) {
    const value = config[field];
    if (typeof value === 'string') config[field] = maskUrlCredentials(value);
  }
  return {
    name: row.name,
    kind: row.kind,
    description: row.description,
    config,
    secretKeys: row.secretsEncrypted
      ? Object.keys(decryptSecrets(row.secretsEncrypted, key)).sort()
      : [],
    // 只有 generated server 有工具；旧导出没有这个字段也能导入。
    ...(tools === undefined
      ? {}
      : {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            method: tool.method,
            pathTemplate: tool.pathTemplate,
            inputSchema: tool.inputSchema,
            paramsIn: tool.paramsIn,
            enabled: tool.enabled,
            requiresApproval: tool.requiresApproval,
          })),
        }),
  };
}

/** 工作区预览按明文密钥为空渲染，否则 .mcp.json 会把密钥写进导出文件。 */
function toEntry(row: ServerRow): McpJsonEntry {
  if (row.kind === 'stdio') {
    return { command: str(row.config.command), args: strArray(row.config.args), env: {} };
  }
  return {
    type: 'http',
    url: maskUrlCredentials(str(row.kind === 'generated' ? row.config.baseUrl : row.config.url)),
    headers: {},
  };
}

function toWorkspaceSkill(row: SkillRow): WorkspaceSkill {
  return { slug: row.slug, name: row.name, description: row.description, body: row.body };
}

/** 多个 agent 的绑定一次性查回：导出整个委派树时不按子智能体逐条发 SQL。 */
async function boundServersByAgent(
  db: Database,
  agentIds: string[],
): Promise<Map<string, ServerRow[]>> {
  const rows = await db
    .select({ agentId: agentServers.agentId, server: servers })
    .from(agentServers)
    .innerJoin(servers, eq(agentServers.serverId, servers.id))
    .where(inArray(agentServers.agentId, agentIds))
    .orderBy(asc(agentServers.agentId), asc(agentServers.serverId));
  const out = new Map<string, ServerRow[]>();
  for (const row of rows) {
    const list = out.get(row.agentId);
    if (list) list.push(row.server);
    else out.set(row.agentId, [row.server]);
  }
  return out;
}

async function boundSkillsByAgent(
  db: Database,
  agentIds: string[],
): Promise<Map<string, SkillRow[]>> {
  const rows = await db
    .select({ agentId: agentSkills.agentId, skill: skills })
    .from(agentSkills)
    .innerJoin(skills, eq(agentSkills.skillId, skills.id))
    .where(inArray(agentSkills.agentId, agentIds))
    .orderBy(asc(agentSkills.agentId), asc(skills.slug));
  const out = new Map<string, SkillRow[]>();
  for (const row of rows) {
    const list = out.get(row.agentId);
    if (list) list.push(row.skill);
    else out.set(row.agentId, [row.skill]);
  }
  return out;
}

/**
 * 可移植的智能体定义：源实例的 id、时间戳、父级与资源 ID 一律去掉，
 * 资源改用名称引用，目标实例才能按名称重建绑定。
 */
function toPortableAgent(row: NonNullable<AgentRow>, serverNames: string[], skillSlugs: string[]) {
  const {
    id: _id,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    parentId: _parentId,
    serverIds: _serverIds,
    skillIds: _skillIds,
    subAgentIds: _subAgentIds,
    ...config
  } = agentRepo.toAgent(row, [], [], []);
  return { ...config, serverNames, skillSlugs };
}

/** 并集只保留每个资源一次；名称引用按当前智能体的绑定取。 */
function unionById<T extends { id: string }>(lists: T[][]): T[] {
  const out = new Map<string, T>();
  for (const list of lists) for (const item of list) if (!out.has(item.id)) out.set(item.id, item);
  return [...out.values()];
}

export function registerExportRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };

  app.get(
    '/api/export/agents/:id',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      const row = await agentRepo.getAgent(app.db, request.params.id);
      if (!row) return reject(reply, 'AGENT_NOT_FOUND', '智能体不存在，可能已被删除；请刷新后重试');

      const children = await agentRepo.listSubAgents(app.db, row.id);
      if (children.length > MAX_SUB_AGENTS) {
        return reject(
          reply,
          'CONFLICT',
          `该智能体有 ${children.length} 个子智能体，超过导出上限 ${MAX_SUB_AGENTS} 个；请先减少子智能体`,
        );
      }

      const agentIds = [row.id, ...children.map((child) => child.id)];
      const [serversByAgent, skillsByAgent] = await Promise.all([
        boundServersByAgent(app.db, agentIds),
        boundSkillsByAgent(app.db, agentIds),
      ]);
      const rootServers = serversByAgent.get(row.id) ?? [];
      const rootSkills = skillsByAgent.get(row.id) ?? [];
      // 子智能体定义无论启停都要带；停用状态本身是配置的一部分。
      const allServers = unionById([
        rootServers,
        ...children.map((c) => serversByAgent.get(c.id) ?? []),
      ]);
      const allSkills = unionById([
        rootSkills,
        ...children.map((c) => skillsByAgent.get(c.id) ?? []),
      ]);
      if (allServers.length > MAX_RESOURCES || allSkills.length > MAX_RESOURCES) {
        return reject(
          reply,
          'CONFLICT',
          `导出包含 ${allServers.length} 个 Server、${allSkills.length} 个技能，超过单项上限 ${MAX_RESOURCES}；请先减少绑定`,
        );
      }

      const generatedIds = allServers
        .filter((server) => server.kind === 'generated')
        .map((server) => server.id);
      const toolRows =
        generatedIds.length === 0
          ? []
          : await app.db
              .select()
              .from(apiTools)
              .where(inArray(apiTools.serverId, generatedIds))
              .orderBy(asc(apiTools.createdAt), asc(apiTools.id));
      const toolsByServerId = new Map<string, ToolRow[]>();
      for (const tool of toolRows) {
        const tools = toolsByServerId.get(tool.serverId);
        if (tools) tools.push(tool);
        else toolsByServerId.set(tool.serverId, [tool]);
      }

      // 根智能体只声明自己的绑定；子智能体的资源通过子定义里的名称引用带走。
      const agent = {
        ...toPortableAgent(
          row,
          rootServers.map((s) => s.name),
          rootSkills.map((s) => s.slug),
        ),
        serverIds: [],
        skillIds: [],
        subAgentIds: [],
      };
      const subAgents = children.map((child) =>
        toPortableAgent(
          child,
          (serversByAgent.get(child.id) ?? []).map((s) => s.name),
          (skillsByAgent.get(child.id) ?? []).map((s) => s.slug),
        ),
      );
      const rootWorkspaceSkills = rootSkills.map(toWorkspaceSkill);
      const subAgentRows = children.map((child) => ({
        ...child,
        skills: (skillsByAgent.get(child.id) ?? []).map(toWorkspaceSkill),
      }));

      const payload = {
        format: 'agentport/agent@1',
        exportedAt: new Date().toISOString(),
        agent,
        subAgents,
        servers: allServers.map((server) =>
          toExportedServer(
            server,
            app.config.APP_SECRET_KEY,
            server.kind === 'generated' ? (toolsByServerId.get(server.id) ?? []) : undefined,
          ),
        ),
        skills: allSkills.map(toWorkspaceSkill),
        // 预览只含根智能体的 server 与技能；子技能随子定义渲染，不扩给父级。
        workspace: renderWorkspace(
          toWorkspaceInput({
            agent: row,
            servers: rootServers.map((server) => ({ name: server.name, entry: toEntry(server) })),
            skills: rootWorkspaceSkills,
            subAgents: subAgentRows,
          }),
        ),
      };

      // 按浏览器实际下载的字节判断：截断会得到一个导入不回来的文件。
      const body = serializeAgentPackage(payload);
      if (Buffer.byteLength(body, 'utf8') > AGENT_PACKAGE_MAX_BYTES) {
        return reject(reply, 'CONFLICT', '专家包超过 1 MiB，请减少提示词、技能或工具定义后重试');
      }

      return reply
        .header('content-disposition', `attachment; filename="${row.slug}.agent.json"`)
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .type('application/json')
        .send(body);
    },
  );
}
