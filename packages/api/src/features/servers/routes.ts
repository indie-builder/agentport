import { apiToolInputSchema, serverInputSchema, serverTestResultSchema } from '@agentport/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import * as repo from './repo.js';
import { getMcpToken, getServerWithSecrets } from './repo.js';
import { testConnection } from './test-connection.js';

const idParams = z.object({ id: z.string().min(1) });
const toolParams = idParams.extend({ toolId: z.string().min(1) });

// kind 不可变，其余字段按 kind 取用；未知字段忽略。
const serverPatchSchema = z.object({
  kind: z.enum(['stdio', 'http', 'generated']).optional(),
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(500).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.url().optional(),
  baseUrl: z.url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

function invalid(reply: FastifyReply, message: string) {
  return reply.status(400).send({ code: 'INVALID_INPUT', message });
}

function notFound(reply: FastifyReply, what: string) {
  return reply.status(404).send({ code: 'NOT_FOUND', message: `${what} not found` });
}

/** 名称唯一索引冲突转成 409，其余交给统一错误处理。 */
function rethrowConflict(err: unknown): never {
  if (typeof err === 'object' && err !== null && 'code' in err && err.code === '23505') {
    throw Object.assign(new Error('server name already exists'), {
      statusCode: 409,
      code: 'CONFLICT',
    });
  }
  throw err;
}

export function registerServerRoutes(app: FastifyInstance): void {
  const auth = { preHandler: [app.requireAuth] };
  const key = (): string => app.config.APP_SECRET_KEY;

  app.get('/api/servers', auth, async () => repo.listServers(app.db, key()));

  app.post('/api/servers', auth, async (request, reply) => {
    const parsed = serverInputSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? 'invalid body');
    try {
      const created = await repo.createServer(app.db, parsed.data, key());
      return reply.status(201).send(created);
    } catch (err) {
      rethrowConflict(err);
    }
  });

  app.get('/api/servers/:id', auth, async (request, reply) => {
    const parsed = idParams.safeParse(request.params);
    if (!parsed.success) return invalid(reply, 'invalid id');
    const server = await repo.getServer(app.db, parsed.data.id, key());
    return server ?? notFound(reply, 'server');
  });

  app.patch('/api/servers/:id', auth, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, 'invalid id');
    const body = serverPatchSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.issues[0]?.message ?? 'invalid body');
    try {
      const updated = await repo.updateServer(app.db, params.data.id, body.data, key());
      return updated ?? notFound(reply, 'server');
    } catch (err) {
      rethrowConflict(err);
    }
  });

  app.delete('/api/servers/:id', auth, async (request, reply) => {
    const parsed = idParams.safeParse(request.params);
    if (!parsed.success) return invalid(reply, 'invalid id');
    const ok = await repo.deleteServer(app.db, parsed.data.id);
    if (!ok) return notFound(reply, 'server');
    return reply.status(204).send();
  });

  app.post('/api/servers/:id/test', auth, async (request, reply) => {
    const parsed = idParams.safeParse(request.params);
    if (!parsed.success) return invalid(reply, 'invalid id');
    const server = await getServerWithSecrets(app.db, parsed.data.id, key());
    if (!server) return notFound(reply, 'server');
    const result = await testConnection(
      server,
      app.config.NODE_ENV,
      server.kind === 'generated'
        ? {
            baseUrl: app.config.SELF_URL,
            token: (await getMcpToken(app.db, server.id)) ?? '',
          }
        : undefined,
    );
    return serverTestResultSchema.parse(result);
  });

  app.get('/api/servers/:id/tools', auth, async (request, reply) => {
    const parsed = idParams.safeParse(request.params);
    if (!parsed.success) return invalid(reply, 'invalid id');
    const row = await repo.getServerRow(app.db, parsed.data.id);
    if (!row) return notFound(reply, 'server');
    return repo.listTools(app.db, parsed.data.id);
  });

  app.post('/api/servers/:id/tools', auth, async (request, reply) => {
    const parsed = idParams.safeParse(request.params);
    if (!parsed.success) return invalid(reply, 'invalid id');
    const row = await repo.getServerRow(app.db, parsed.data.id);
    if (!row) return notFound(reply, 'server');
    if (row.kind !== 'generated') {
      return invalid(reply, 'tools can only be added to generated servers');
    }
    const body = apiToolInputSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.issues[0]?.message ?? 'invalid body');
    try {
      const tool = await repo.createTool(app.db, parsed.data.id, body.data);
      return reply.status(201).send(tool);
    } catch (err) {
      rethrowConflict(err);
    }
  });

  app.delete('/api/servers/:id/tools/:toolId', auth, async (request, reply) => {
    const parsed = toolParams.safeParse(request.params);
    if (!parsed.success) return invalid(reply, 'invalid id');
    const ok = await repo.deleteTool(app.db, parsed.data.id, parsed.data.toolId);
    if (!ok) return notFound(reply, 'tool');
    return reply.status(204).send();
  });
}
