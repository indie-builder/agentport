import * as repo from '@agentport/db/repo/agents.js';
import type { AgentInput } from '@agentport/shared';
import { agentInputSchema, permissionModeSchema } from '@agentport/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { renderAgentWorkspace } from './workspace.js';

const idParams = z.object({ id: z.string().min(1) });

// 字段与 agentInputSchema 保持一致；PATCH 用显式可选字段，才能区分「没传」与「传了默认值」。
const patchSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, '仅允许小写字母、数字、- 和 _')
    .optional(),
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(300).optional(),
  model: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  serverIds: z.array(z.string()).optional(),
  skillIds: z.array(z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  permissionMode: permissionModeSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  maxThinkingTokens: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
});

function invalid(reply: FastifyReply, message: string) {
  return reply.status(400).send({ code: 'INVALID_INPUT', message });
}

function notFound(reply: FastifyReply) {
  return reply.status(404).send({ code: 'NOT_FOUND', message: 'agent not found' });
}

/** slug 上有唯一索引，冲突转 409。drizzle 把 pg 错误包在 cause 里，得顺着链找。 */
/** 外键失败意味着引用了不存在的 server/skill，属于客户端错误。 */
/** drizzle 把 pg 错误包在 cause 链里，需要逐层查找。 */
function pgCode(err: unknown): string | undefined {
  let cause: unknown = err;
  for (let depth = 0; depth < 5 && typeof cause === 'object' && cause !== null; depth += 1) {
    if ('code' in cause && typeof cause.code === 'string') return cause.code;
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return undefined;
}

function rethrowConflict(err: unknown): never {
  const code = pgCode(err);
  if (code === '23505') {
    throw Object.assign(new Error('agent slug already exists'), {
      statusCode: 409,
      code: 'CONFLICT',
    });
  }
  if (code === '23503') {
    throw Object.assign(new Error('referenced server or skill does not exist'), {
      statusCode: 400,
      code: 'INVALID_REFERENCE',
    });
  }
  throw err;
}

function toWrite(input: Omit<AgentInput, 'serverIds' | 'skillIds'>): repo.AgentWrite {
  return {
    slug: input.slug,
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

// slug 是工作区目录名，改了旧目录会变孤儿，只能显式拒绝。
function assertSlugUnchanged(current: string, next: string | undefined): string | undefined {
  return next !== undefined && next !== current ? 'slug cannot change' : undefined;
}

export function registerAgentRoutes(app: FastifyInstance): void {
  const auth = { preHandler: [app.requireAuth] };

  app.get('/api/agents', auth, async () => {
    const rows = await repo.listAgents(app.db);
    const ids = rows.map((row) => row.id);
    const servers = await repo.listAgentServerIds(app.db, ids);
    const skills = await repo.listAgentSkillIds(app.db, ids);
    return rows.map((row) =>
      repo.toAgent(row, servers.get(row.id) ?? [], skills.get(row.id) ?? []),
    );
  });

  app.post('/api/agents', auth, async (request, reply) => {
    const parsed = agentInputSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? 'invalid body');
    const { serverIds, skillIds, ...rest } = parsed.data;
    try {
      const row = await repo.createAgent(app.db, toWrite(rest), serverIds, skillIds);
      return reply.status(201).send(repo.toAgent(row, serverIds, skillIds));
    } catch (err) {
      rethrowConflict(err);
    }
  });

  app.get('/api/agents/:id', auth, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, 'invalid id');
    const row = await repo.getAgent(app.db, params.data.id);
    if (!row) return notFound(reply);
    const [serverIds, skillIds] = await Promise.all([
      repo.getAgentServerIds(app.db, row.id),
      repo.getAgentSkillIds(app.db, row.id),
    ]);
    return repo.toAgent(row, serverIds, skillIds);
  });

  app.patch('/api/agents/:id', auth, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, 'invalid id');
    const body = patchSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.issues[0]?.message ?? 'invalid body');

    const current = await repo.getAgent(app.db, params.data.id);
    if (!current) return notFound(reply);
    const slugError = assertSlugUnchanged(current.slug, body.data.slug);
    if (slugError) return invalid(reply, slugError);

    const input = body.data;
    const patch: Partial<repo.AgentWrite> = {
      name: input.name ?? current.name,
      description: input.description ?? current.description,
      model: input.model ?? current.model,
      systemPromptMd: input.systemPrompt ?? current.systemPromptMd,
      allowedTools: input.allowedTools ?? current.allowedTools,
      disallowedTools: input.disallowedTools ?? current.disallowedTools,
      permissionMode: input.permissionMode ?? current.permissionMode,
      effort: input.effort ?? current.effort,
      maxThinkingTokens: input.maxThinkingTokens ?? current.maxThinkingTokens,
      enabled: input.enabled ?? current.enabled,
      maxTurns: input.maxTurns ?? current.maxTurns,
      maxBudgetUsd:
        input.maxBudgetUsd === undefined ? current.maxBudgetUsd : String(input.maxBudgetUsd),
      timeoutMs: input.timeoutMs ?? current.timeoutMs,
    };

    try {
      const row = await repo.updateAgent(
        app.db,
        current.id,
        patch,
        input.serverIds,
        input.skillIds,
      );
      if (!row) return notFound(reply);
      const [serverIds, skillIds] = await Promise.all([
        input.serverIds ?? repo.getAgentServerIds(app.db, current.id),
        input.skillIds ?? repo.getAgentSkillIds(app.db, current.id),
      ]);
      return repo.toAgent(row, serverIds, skillIds);
    } catch (err) {
      rethrowConflict(err);
    }
  });

  app.delete('/api/agents/:id', auth, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, 'invalid id');
    const ok = await repo.deleteAgent(app.db, params.data.id);
    if (!ok) return notFound(reply);
    return reply.status(204).send();
  });

  // 检查配置是否可渲染的最直接方式就是真渲染一次；只预览，不落盘。
  app.get('/api/agents/:id/files', auth, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, 'invalid id');
    const files = await renderAgentWorkspace(app, params.data.id);
    if (!files) return notFound(reply);
    return files;
  });
}
