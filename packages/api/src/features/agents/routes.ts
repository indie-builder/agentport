import * as repo from '@agentport/db/repo/agents.js';
import type { Agent } from '@agentport/shared';
import { agentInputSchema } from '@agentport/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { writeAgentWorkspace } from './workspace.js';

type AgentRow = Awaited<ReturnType<typeof repo.getAgent>>;

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
  model: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  serverIds: z.array(z.string()).optional(),
  maxTurns: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

function invalid(reply: FastifyReply, message: string) {
  return reply.status(400).send({ code: 'INVALID_INPUT', message });
}

function notFound(reply: FastifyReply) {
  return reply.status(404).send({ code: 'NOT_FOUND', message: 'agent not found' });
}

/** slug 上有唯一索引，冲突转 409。drizzle 把 pg 错误包在 cause 里，得顺着链找。 */
function rethrowConflict(err: unknown): never {
  let cause: unknown = err;
  while (typeof cause === 'object' && cause !== null) {
    if ('code' in cause && cause.code === '23505') {
      throw Object.assign(new Error('agent slug already exists'), {
        statusCode: 409,
        code: 'CONFLICT',
      });
    }
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw err;
}

function toApi(row: NonNullable<AgentRow>, serverIds: string[]): Agent {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    model: row.model,
    systemPrompt: row.systemPromptMd,
    serverIds,
    maxTurns: row.maxTurns,
    maxBudgetUsd: Number(row.maxBudgetUsd),
    timeoutMs: row.timeoutMs,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** slug 是工作区目录名，改了就得把旧目录留成孤儿；明确禁止比静默改名安全。 */
function assertSlugUnchanged(current: string, next: string | undefined): string | undefined {
  return next !== undefined && next !== current ? 'slug cannot change' : undefined;
}

export function registerAgentRoutes(app: FastifyInstance): void {
  const auth = { preHandler: [app.requireAuth] };

  app.get('/api/agents', auth, async () => {
    const rows = await repo.listAgents(app.db);
    const bound = await repo.listAgentServerIds(
      app.db,
      rows.map((row) => row.id),
    );
    return rows.map((row) => toApi(row, bound.get(row.id) ?? []));
  });

  app.post('/api/agents', auth, async (request, reply) => {
    const parsed = agentInputSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? 'invalid body');
    const { serverIds, ...input } = parsed.data;
    try {
      const row = await repo.createAgent(
        app.db,
        {
          slug: input.slug,
          name: input.name,
          model: input.model,
          systemPromptMd: input.systemPrompt,
          maxTurns: input.maxTurns,
          maxBudgetUsd: String(input.maxBudgetUsd),
          timeoutMs: input.timeoutMs,
        },
        serverIds,
      );
      return reply.status(201).send(toApi(row, serverIds));
    } catch (err) {
      rethrowConflict(err);
    }
  });

  app.get('/api/agents/:id', auth, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, 'invalid id');
    const row = await repo.getAgent(app.db, params.data.id);
    if (!row) return notFound(reply);
    return toApi(row, await repo.getAgentServerIds(app.db, row.id));
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

    const { slug, name, model, systemPrompt, serverIds, maxTurns, maxBudgetUsd, timeoutMs } =
      body.data;
    const patch: repo.AgentWrite = {
      slug: slug ?? current.slug,
      name: name ?? current.name,
      model: model ?? current.model,
      systemPromptMd: systemPrompt ?? current.systemPromptMd,
      maxTurns: maxTurns ?? current.maxTurns,
      maxBudgetUsd: maxBudgetUsd === undefined ? current.maxBudgetUsd : String(maxBudgetUsd),
      timeoutMs: timeoutMs ?? current.timeoutMs,
    };

    try {
      const row = await repo.updateAgent(app.db, current.id, patch, serverIds);
      if (!row) return notFound(reply);
      return toApi(row, serverIds ?? (await repo.getAgentServerIds(app.db, current.id)));
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

  // 检查配置是否可渲染的最直接方式就是真渲染一次；顺带把文件写到工作区供预览。
  app.get('/api/agents/:id/files', auth, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, 'invalid id');
    const files = await writeAgentWorkspace(app, params.data.id);
    if (!files) return notFound(reply);
    return files;
  });
}
