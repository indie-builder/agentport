import { randomBytes } from 'node:crypto';
import { fail } from '@agentport/core';
import type { Database } from '@agentport/db';
import { agentServers, agentSkills, agents, newId, repo, servers, skills } from '@agentport/db';
import * as agentRepo from '@agentport/db/repo/agents.js';
import type { AgentInput, ServerInput } from '@agentport/shared';
import {
  agentInputSchema,
  serverInputSchema,
  skillInputSchema,
  slugSchema,
} from '@agentport/shared';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { typed } from '../../types.js';
import { assertSafeUrl } from '../servers/ssrf.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const importedServerSchema = z.object({
  name: slugSchema,
  kind: z.enum(['stdio', 'http', 'generated']),
  description: z.string().max(500).default(''),
  config: z.record(z.string(), z.unknown()).default({}),
  secretKeys: z.array(z.string()).default([]),
});

type ImportedServer = z.infer<typeof importedServerSchema>;

const importBodySchema = z.object({
  format: z.literal('agentport/agent@1'),
  agent: agentInputSchema.extend({
    permissionMode: z.enum(['dontAsk', 'plan', 'default', 'acceptEdits']).default('dontAsk'),
  }),
  servers: z.array(importedServerSchema).max(100).default([]),
  skills: z.array(skillInputSchema).max(100).default([]),
});

/** 密钥不入库；generated server 需要一个本机可用的新令牌。 */
function toServerConfig(input: ServerInput): Record<string, unknown> {
  switch (input.kind) {
    case 'stdio':
      return { command: input.command, args: input.args };
    case 'http':
      return { url: input.url };
    case 'generated':
      return { baseUrl: input.baseUrl, mcpToken: randomBytes(32).toString('base64url') };
  }
}

function toAgentValues(input: AgentInput) {
  return {
    name: input.name,
    role: input.role,
    description: input.description,
    model: input.model,
    systemPromptMd: input.systemPrompt,
    allowedTools: input.allowedTools,
    disallowedTools: input.disallowedTools,
    permissionMode: input.permissionMode,
    effort: input.effort ?? null,
    maxThinkingTokens: input.maxThinkingTokens ?? null,
    enabled: input.enabled,
    maxTurns: input.maxTurns,
    maxBudgetUsd: String(input.maxBudgetUsd),
    timeoutMs: input.timeoutMs,
  };
}

async function uniqueSlug(tx: Tx, base: string): Promise<string> {
  const taken = async (candidate: string): Promise<boolean> => {
    const rows = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.slug, candidate))
      .limit(1);
    return rows.length > 0;
  };
  if (!(await taken(base))) return base;
  const prefix = base.slice(0, 60);
  let n = 2;
  while (await taken(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

/**
 * 导出里的 config 就是 serverInputSchema 去掉密钥后的字段；不一致即视为非法导出。
 * config 是 JSON Schema，无法在 zod 顶层表达，所以在 handler 入口这一行校验一次。
 */
function toServerInput(entry: ImportedServer): ServerInput {
  const parsed = serverInputSchema.safeParse({
    ...entry.config,
    name: entry.name,
    kind: entry.kind,
    description: entry.description,
  });
  if (!parsed.success) fail('INVALID_INPUT', `「${entry.name}」的 Server 配置不完整，无法导入`);
  return parsed.data;
}

export function registerImportRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };

  app.post(
    '/api/import/agents',
    { ...auth, schema: { body: importBodySchema } },
    async (request, reply) => {
      const { agent: input, servers: entries, skills: skillInputs } = request.body;
      const serverInputs = entries.map(toServerInput);

      // 导入文件同样不可信：http/generated 的地址与手动创建走同一个 SSRF 校验。
      for (const serverInput of serverInputs) {
        if (serverInput.kind === 'http') {
          await assertSafeUrl(serverInput.url, app.config.NODE_ENV);
        } else if (serverInput.kind === 'generated') {
          await assertSafeUrl(serverInput.baseUrl, app.config.NODE_ENV);
        }
      }
      // 同名/同 slug 重复出现时只处理一次，避免重复绑定。
      const uniqueServers = [...new Map(serverInputs.map((s) => [s.name, s])).values()];
      const uniqueSkills = [...new Map(skillInputs.map((s) => [s.slug, s])).values()];

      const warnings: string[] = [];
      for (const entry of entries) {
        if (entry.secretKeys.length > 0) {
          warnings.push(`「${entry.name}」的密钥需要重新填写：${entry.secretKeys.join(', ')}`);
        }
      }

      const result = await app.db.transaction(async (tx) => {
        const createdServers: string[] = [];
        const reusedServers: string[] = [];
        const createdSkills: string[] = [];

        const existingServers =
          uniqueServers.length === 0
            ? []
            : await tx
                .select()
                .from(servers)
                .where(
                  inArray(
                    servers.name,
                    uniqueServers.map((s) => s.name),
                  ),
                );
        const serverIdsByName = new Map(existingServers.map((row) => [row.name, row.id]));
        const serverKindByName = new Map(existingServers.map((row) => [row.name, row.kind]));
        for (const serverInput of uniqueServers) {
          const reusedKind = serverKindByName.get(serverInput.name);
          if (reusedKind !== undefined) {
            // 同名不同 kind 的配置结构不同，复用会得到行为不符的 server。
            if (reusedKind !== serverInput.kind) {
              fail(
                'INVALID_INPUT',
                `已存在同名 Server「${serverInput.name}」，但类型不同（${reusedKind} / ${serverInput.kind}），无法复用；请先在导入文件中改名`,
              );
            }
            reusedServers.push(serverInput.name);
            continue;
          }
          const [row] = await tx
            .insert(servers)
            .values({
              id: newId('server'),
              name: serverInput.name,
              kind: serverInput.kind,
              description: serverInput.description,
              config: toServerConfig(serverInput),
              secretsEncrypted: null,
            })
            .returning();
          if (!row) throw new Error('server insert returned no row');
          serverIdsByName.set(row.name, row.id);
          createdServers.push(row.name);
        }

        const existingSkills =
          uniqueSkills.length === 0
            ? []
            : await tx
                .select()
                .from(skills)
                .where(
                  inArray(
                    skills.slug,
                    uniqueSkills.map((s) => s.slug),
                  ),
                );
        const skillIdsBySlug = new Map(existingSkills.map((row) => [row.slug, row.id]));
        for (const skillInput of uniqueSkills) {
          if (skillIdsBySlug.has(skillInput.slug)) continue;
          const [row] = await tx
            .insert(skills)
            .values({ id: newId('skill'), ...skillInput })
            .returning();
          if (!row) throw new Error('skill insert returned no row');
          skillIdsBySlug.set(row.slug, row.id);
          createdSkills.push(row.slug);
        }

        const slug = await uniqueSlug(tx, input.slug);
        if (slug !== input.slug) {
          warnings.push(`slug "${input.slug}" 已存在，导入为 "${slug}"`);
        }
        const serverIds = uniqueServers
          .map((s) => serverIdsByName.get(s.name))
          .filter((id): id is string => id !== undefined);
        const skillIds = uniqueSkills
          .map((s) => skillIdsBySlug.get(s.slug))
          .filter((id): id is string => id !== undefined);

        const [row] = await tx
          .insert(agents)
          .values({ id: newId('agent'), slug, ...toAgentValues(input) })
          .returning();
        if (!row) throw new Error('agent insert returned no row');
        if (serverIds.length > 0) {
          await tx
            .insert(agentServers)
            .values(serverIds.map((serverId) => ({ agentId: row.id, serverId })));
        }
        if (skillIds.length > 0) {
          await tx
            .insert(agentSkills)
            .values(skillIds.map((skillId) => ({ agentId: row.id, skillId })));
        }
        await repo.agentVersions.insertAgentVersion(
          tx,
          row.id,
          agentRepo.toAgent(row, serverIds, skillIds),
        );

        return {
          agent: agentRepo.toAgent(row, serverIds, skillIds),
          createdServers,
          reusedServers,
          createdSkills,
        };
      });

      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'agent.imported',
        target: result.agent.id,
        input: {
          slug: result.agent.slug,
          servers: { created: result.createdServers.length, reused: result.reusedServers.length },
          skills: result.createdSkills.length,
        },
        status: 'ok',
        requestId: request.id,
      });

      return reply.status(201).send({ ...result, warnings });
    },
  );
}
