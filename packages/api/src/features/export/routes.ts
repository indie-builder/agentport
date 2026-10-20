import type { McpJsonEntry, WorkspaceSkill } from '@agentport/core';
import { decryptSecrets, renderWorkspace } from '@agentport/core';
import * as agentRepo from '@agentport/db/repo/agents.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';

const idParams = z.object({ id: z.string().min(1) });

type ServerRow = Awaited<ReturnType<typeof agentRepo.getBoundServers>>[number];
type SkillRow = Awaited<ReturnType<typeof agentRepo.getBoundSkills>>[number];

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** 导出里只留非敏感配置；generated 的 mcpToken 和加密列的值一律不出现。 */
function toExportedServer(row: ServerRow, key: string) {
  const { mcpToken: _mcpToken, ...config } = row.config;
  return {
    name: row.name,
    kind: row.kind,
    description: row.description,
    config,
    secretKeys: row.secretsEncrypted
      ? Object.keys(decryptSecrets(row.secretsEncrypted, key)).sort()
      : [],
  };
}

/** 工作区预览按明文密钥为空渲染，否则 .mcp.json 会把密钥写进导出文件。 */
function toEntry(row: ServerRow): McpJsonEntry {
  if (row.kind === 'stdio') {
    return { command: str(row.config.command), args: strArray(row.config.args), env: {} };
  }
  return {
    type: 'http',
    url: str(row.kind === 'generated' ? row.config.baseUrl : row.config.url),
    headers: {},
  };
}

function toWorkspaceSkill(row: SkillRow): WorkspaceSkill {
  return { slug: row.slug, name: row.name, description: row.description, body: row.body };
}

export function registerExportRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };

  app.get(
    '/api/export/agents/:id',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      const row = await agentRepo.getAgent(app.db, request.params.id);
      if (!row) return reject(reply, 'NOT_FOUND', 'agent not found');

      const [serverRows, skillRows, serverIds, skillIds, subAgentIds] = await Promise.all([
        agentRepo.getBoundServers(app.db, row.id),
        agentRepo.getBoundSkills(app.db, row.id),
        agentRepo.getAgentServerIds(app.db, row.id),
        agentRepo.getAgentSkillIds(app.db, row.id),
        agentRepo.getAgentSubAgentIds(app.db, row.id),
      ]);

      const {
        id: _id,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        ...agent
      } = agentRepo.toAgent(row, serverIds, skillIds, subAgentIds);
      const skills = skillRows.map(toWorkspaceSkill);

      const payload = {
        format: 'agentport/agent@1',
        exportedAt: new Date().toISOString(),
        agent,
        servers: serverRows.map((server) => toExportedServer(server, app.config.APP_SECRET_KEY)),
        skills,
        workspace: renderWorkspace({
          agent: {
            slug: agent.slug,
            name: agent.name,
            description: agent.description,
            model: agent.model,
            systemPrompt: agent.systemPrompt,
            maxTurns: agent.maxTurns,
            permissionMode: agent.permissionMode,
            ...(agent.effort === undefined ? {} : { effort: agent.effort }),
            allowedTools: agent.allowedTools,
            disallowedTools: agent.disallowedTools,
          },
          servers: serverRows.map((server) => ({ name: server.name, entry: toEntry(server) })),
          skills,
          ...(agent.allowedTools.length > 0 ? { toolsAllow: agent.allowedTools } : {}),
          ...(agent.disallowedTools.length > 0 ? { toolsDeny: agent.disallowedTools } : {}),
        }),
      };

      return reply
        .header('content-disposition', `attachment; filename="${row.slug}.agent.json"`)
        .type('application/json')
        .send(payload);
    },
  );
}
