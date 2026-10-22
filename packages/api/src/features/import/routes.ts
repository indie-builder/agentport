import { randomBytes } from 'node:crypto';
import { fail } from '@agentport/core';
import type { Database } from '@agentport/db';
import {
  agentServers,
  agentSkills,
  agents,
  apiTools,
  newId,
  repo,
  servers,
  skills,
} from '@agentport/db';
import * as agentRepo from '@agentport/db/repo/agents.js';
import type { AgentInput, ServerInput } from '@agentport/shared';
import {
  AGENT_PACKAGE_MAX_BYTES,
  agentInputSchema,
  apiToolInputSchema,
  serverInputSchema,
  skillInputSchema,
  slugSchema,
} from '@agentport/shared';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { isPgCode } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import { allowedToolsSchema } from '../agents/validation.js';
import { assertSafeUrl } from '../servers/ssrf.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const importedToolSchema = apiToolInputSchema.extend({
  enabled: z.boolean().default(true),
});

const importedServerSchema = z
  .object({
    name: slugSchema,
    kind: z.enum(['stdio', 'http', 'generated']),
    description: z.string().max(500).default(''),
    config: z.record(z.string(), z.unknown()).default({}),
    secretKeys: z.array(z.string()).default([]),
    /** 旧导出没有这个字段；只有 generated server 能带工具。 */
    tools: z.array(importedToolSchema).max(2000).optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.tools === undefined) return;
    if (entry.kind !== 'generated' && entry.tools.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['tools'],
        message: `「${entry.name}」不是 generated server，不能携带工具`,
      });
    }
    const seen = new Set<string>();
    entry.tools.forEach((tool, index) => {
      if (seen.has(tool.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tools', index, 'name'],
          message: `「${entry.name}」的工具名称「${tool.name}」重复`,
        });
      }
      seen.add(tool.name);
    });
  });

type ImportedServer = z.infer<typeof importedServerSchema>;

const importBodySchema = z
  .object({
    format: z.literal('agentport/agent@1'),
    agent: agentInputSchema.extend({
      allowedTools: allowedToolsSchema.default([]),
      permissionMode: z.enum(['dontAsk', 'plan', 'default', 'acceptEdits']).default('dontAsk'),
      /** 缺省时沿用旧导出语义：绑定文件里的全部 server。 */
      serverNames: z.array(slugSchema).optional(),
      /** 缺省时沿用旧导出语义：绑定文件里的全部技能。 */
      skillSlugs: z.array(slugSchema).optional(),
    }),
    servers: z.array(importedServerSchema).max(100).default([]),
    skills: z.array(skillInputSchema).max(100).default([]),
    subAgents: z
      .array(
        agentInputSchema
          .omit({ serverIds: true, skillIds: true, subAgentIds: true })
          .extend({
            allowedTools: allowedToolsSchema.default([]),
            permissionMode: z
              .enum(['dontAsk', 'plan', 'default', 'acceptEdits'])
              .default('dontAsk'),
            serverNames: z.array(slugSchema).default([]),
            skillSlugs: z.array(slugSchema).default([]),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .superRefine((body, ctx) => {
    // 同名条目无法无损合并，静默取最后一条会悄悄丢配置。
    const seenServers = new Set<string>();
    body.servers.forEach((entry, index) => {
      if (seenServers.has(entry.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['servers', index, 'name'],
          message: `导入文件里 Server 名称「${entry.name}」重复`,
        });
      }
      seenServers.add(entry.name);
    });
    const seenSkills = new Set<string>();
    body.skills.forEach((entry, index) => {
      if (seenSkills.has(entry.slug)) {
        ctx.addIssue({
          code: 'custom',
          path: ['skills', index, 'slug'],
          message: `导入文件里技能 slug「${entry.slug}」重复`,
        });
      }
      seenSkills.add(entry.slug);
    });

    // 引用只能指向文件里的顶层资源：按名字挂到目标库的任意已有资源不可控。
    const checkRefs = (
      refs: { serverNames?: string[] | undefined; skillSlugs?: string[] | undefined },
      path: Array<string | number>,
    ) => {
      for (const field of ['serverNames', 'skillSlugs'] as const) {
        const values = refs[field] ?? [];
        const known = field === 'serverNames' ? seenServers : seenSkills;
        const seen = new Set<string>();
        values.forEach((value, index) => {
          if (seen.has(value)) {
            ctx.addIssue({
              code: 'custom',
              path: [...path, field, index],
              message: `「${value}」被重复引用`,
            });
          }
          seen.add(value);
          if (!known.has(value)) {
            ctx.addIssue({
              code: 'custom',
              path: [...path, field, index],
              message: `引用的「${value}」不在导入文件的 ${field === 'serverNames' ? 'servers' : 'skills'} 中`,
            });
          }
        });
      }
    };
    checkRefs(body.agent, ['agent']);

    const seenChildren = new Set([body.agent.slug]);
    body.subAgents.forEach((entry, index) => {
      if (seenChildren.has(entry.slug)) {
        ctx.addIssue({
          code: 'custom',
          path: ['subAgents', index, 'slug'],
          message: `子智能体 slug「${entry.slug}」与同级或其他子智能体重复`,
        });
      }
      seenChildren.add(entry.slug);
      checkRefs(entry, ['subAgents', index]);
    });
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

/** 路由只关心这些字段；server/skill/sub-agent 引用由绑定关系单独写入。 */
type AgentFields = Omit<AgentInput, 'serverIds' | 'skillIds' | 'subAgentIds'>;

function toAgentValues(input: AgentFields) {
  return {
    name: input.name,
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

/** generated 的 mcpToken 每次调用都会重新生成，不属于可比较的配置。 */
function nonSecretConfig(input: ServerInput): Record<string, unknown> {
  const { mcpToken: _mcpToken, ...config } = toServerConfig(input);
  return config;
}

function configDiffers(input: ServerInput, existing: Record<string, unknown>): boolean {
  return Object.entries(nonSecretConfig(input)).some(
    ([key, value]) => JSON.stringify(existing[key]) !== JSON.stringify(value),
  );
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
    { ...auth, bodyLimit: AGENT_PACKAGE_MAX_BYTES, schema: { body: importBodySchema } },
    async (request, reply) => {
      const { agent: input, servers: entries, skills: skillInputs, subAgents } = request.body;
      const serverEntries = entries.map((entry) => ({
        input: toServerInput(entry),
        tools: entry.tools,
        secretKeys: entry.secretKeys,
      }));

      // 导入文件同样不可信：http/generated 的地址与手动创建走同一个 SSRF 校验。
      for (const { input: serverInput } of serverEntries) {
        if (serverInput.kind === 'http') {
          await assertSafeUrl(serverInput.url, app.config.NODE_ENV);
        } else if (serverInput.kind === 'generated') {
          await assertSafeUrl(serverInput.baseUrl, app.config.NODE_ENV);
        }
      }
      const warnings: string[] = [];
      // 源实例的子智能体 ID 在目标库里没有意义；不绑定，但要让用户知道。
      // 新格式带 subAgents 时由文件内容重建关系，旧的 ID 不再是有效输入。
      if (input.subAgentIds.length > 0 && subAgents.length === 0) {
        warnings.push(`导入文件中的 ${input.subAgentIds.length} 个子智能体未绑定，需手动重新选择`);
      }

      const result = await app.db
        .transaction(async (tx) => {
          const createdServers: string[] = [];
          const reusedServers: string[] = [];
          const createdSkills: string[] = [];

          const existingServers =
            serverEntries.length === 0
              ? []
              : await tx
                  .select()
                  .from(servers)
                  .where(
                    inArray(
                      servers.name,
                      serverEntries.map((s) => s.input.name),
                    ),
                  );
          const existingByName = new Map(existingServers.map((row) => [row.name, row]));
          const serverIdsByName = new Map(existingServers.map((row) => [row.name, row.id]));
          for (const { input: serverInput, tools, secretKeys } of serverEntries) {
            const existing = existingByName.get(serverInput.name);
            if (existing !== undefined) {
              // 同名不同 kind 的配置结构不同，复用会得到行为不符的 server。
              if (existing.kind !== serverInput.kind) {
                fail(
                  'INVALID_INPUT',
                  `已存在同名 Server「${serverInput.name}」，但类型不同（${existing.kind} / ${serverInput.kind}），无法复用；请先在导入文件中改名`,
                );
              }
              reusedServers.push(serverInput.name);
              // 复用不改写已有配置，只提示差异，由用户决定是否手动同步。
              if (configDiffers(serverInput, existing.config)) {
                warnings.push(
                  `已存在同名 Server「${serverInput.name}」，其配置与导入文件不同，已保留原配置`,
                );
              }
              // 复用不合并工具，必须让用户知道文件里的工具没有被导入。
              if (tools !== undefined && tools.length > 0) {
                warnings.push(
                  `已存在同名 Server「${serverInput.name}」，其 ${tools.length} 个工具保留原配置，未按导入文件覆盖`,
                );
              }
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
            // 只有新建的 server 需要填密钥；已存在的不重复提示。
            if (secretKeys.length > 0) {
              warnings.push(`「${serverInput.name}」的密钥需要重新填写：${secretKeys.join(', ')}`);
            }
            serverIdsByName.set(row.name, row.id);
            createdServers.push(row.name);
            if (tools && tools.length > 0) {
              await tx
                .insert(apiTools)
                .values(tools.map((tool) => ({ id: newId('tool'), serverId: row.id, ...tool })));
            }
          }

          const existingSkills =
            skillInputs.length === 0
              ? []
              : await tx
                  .select()
                  .from(skills)
                  .where(
                    inArray(
                      skills.slug,
                      skillInputs.map((s) => s.slug),
                    ),
                  );
          const existingSkillBySlug = new Map(existingSkills.map((row) => [row.slug, row]));
          const skillIdsBySlug = new Map(existingSkills.map((row) => [row.slug, row.id]));
          for (const skillInput of skillInputs) {
            const existing = existingSkillBySlug.get(skillInput.slug);
            if (existing) {
              if (
                existing.name !== skillInput.name ||
                existing.description !== skillInput.description ||
                existing.body !== skillInput.body
              ) {
                warnings.push(
                  `已存在同名技能「${skillInput.slug}」，其内容与导入文件不同，已保留原配置`,
                );
              }
              continue;
            }
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
          /** 旧导出没有 serverNames/skillSlugs：沿用「绑定文件里的全部资源」语义。 */
          const resolve = (
            names: string[] | undefined,
            all: string[],
            ids: Map<string, string>,
          ): string[] =>
            (names ?? all)
              .map((name) => ids.get(name))
              .filter((id): id is string => id !== undefined);

          const serverIds = resolve(
            input.serverNames,
            serverEntries.map((s) => s.input.name),
            serverIdsByName,
          );
          const skillIds = resolve(
            input.skillSlugs,
            skillInputs.map((s) => s.slug),
            skillIdsBySlug,
          );

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

          const createdSubAgents: string[] = [];
          const childIds: string[] = [];
          for (const childInput of subAgents) {
            // 子智能体始终是新建行：同名已有 agent（可能已属于别的父级）一律加后缀，不复用。
            const childSlug = await uniqueSlug(tx, childInput.slug);
            if (childSlug !== childInput.slug) {
              warnings.push(`子智能体 slug "${childInput.slug}" 已存在，导入为 "${childSlug}"`);
            }
            const childServerIds = resolve(
              childInput.serverNames,
              serverEntries.map((s) => s.input.name),
              serverIdsByName,
            );
            const childSkillIds = resolve(
              childInput.skillSlugs,
              skillInputs.map((s) => s.slug),
              skillIdsBySlug,
            );
            const [childRow] = await tx
              .insert(agents)
              .values({
                id: newId('agent'),
                slug: childSlug,
                parentId: row.id,
                ...toAgentValues(childInput),
              })
              .returning();
            if (!childRow) throw new Error('sub-agent insert returned no row');
            if (childServerIds.length > 0) {
              await tx
                .insert(agentServers)
                .values(childServerIds.map((serverId) => ({ agentId: childRow.id, serverId })));
            }
            if (childSkillIds.length > 0) {
              await tx
                .insert(agentSkills)
                .values(childSkillIds.map((skillId) => ({ agentId: childRow.id, skillId })));
            }
            await repo.agentVersions.insertAgentVersion(
              tx,
              childRow.id,
              agentRepo.toAgent(childRow, childServerIds, childSkillIds),
            );
            childIds.push(childRow.id);
            createdSubAgents.push(childRow.slug);
          }

          // 父级快照必须等到子智能体落库后写，才能记录最终 ID。
          await repo.agentVersions.insertAgentVersion(
            tx,
            row.id,
            agentRepo.toAgent(row, serverIds, skillIds, childIds),
          );

          return {
            agent: agentRepo.toAgent(row, serverIds, skillIds, childIds),
            createdServers,
            reusedServers,
            createdSkills,
            createdSubAgents,
          };
        })
        .catch((err: unknown): never => {
          // 并发导入撞上同名 server/skill/agent 的唯一索引：只映射成 409，不重试。
          if (isPgCode(err, '23505')) {
            fail('CONFLICT', '导入期间同名 Server、技能或智能体被其他请求占用，请重试');
          }
          throw err;
        });

      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'agent.imported',
        target: result.agent.id,
        input: {
          slug: result.agent.slug,
          servers: { created: result.createdServers.length, reused: result.reusedServers.length },
          skills: result.createdSkills.length,
          subAgents: result.createdSubAgents.length,
        },
        status: 'ok',
        requestId: request.id,
      });

      return reply.status(201).send({ ...result, warnings });
    },
  );
}
