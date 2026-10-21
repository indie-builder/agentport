import { fail } from '@agentport/core';
import type { ApiToolPatch } from '@agentport/db/repo/servers.js';
import {
  apiToolInputSchema,
  httpUrlSchema,
  serverInputSchema,
  serverTestResultSchema,
} from '@agentport/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { isPgCode, reject } from '../../plugins/errors.js';
import { serverTestRateLimit } from '../../plugins/security.js';
import { typed } from '../../types.js';
import * as repo from './repo.js';
import { getMcpToken, getServerWithSecrets } from './repo.js';
import { assertSafeUrl } from './ssrf.js';
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
  url: httpUrlSchema.optional(),
  baseUrl: httpUrlSchema.optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** 乐观锁：首次加载时的 updatedAt。 */
  expectedUpdatedAt: z.coerce.date().optional(),
});

/**
 * 工具的可编辑字段。与 apiToolInputSchema 同名同义，但全部可选且**不带默认值**：
 * `.partial()` 只把字段设为可选，`default()` 仍会为空对象填上默认值，
 * 于是「至少改一项」的校验永远不会触发。所以这里显式重写，而不是 partial()。
 */
const toolPatchSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-_]*$/, '仅允许小写字母、数字、- 和 _')
      .optional(),
    description: z.string().max(1000).optional(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
    pathTemplate: z.string().min(1).optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    paramsIn: z.enum(['query', 'body']).optional(),
    requiresApproval: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'at least one field is required',
  });

function notFound(reply: FastifyReply, what: string) {
  return reject(reply, 'NOT_FOUND', `${what} not found`);
}

/** server 名有唯一索引（23505）→ 409。 */
function rethrowConflict(err: unknown): never {
  if (isPgCode(err, '23505')) fail('CONFLICT', 'server name already exists');
  throw err;
}

/** schema 声明即校验与类型来源；handler 里不再 safeParse。 */
export function registerServerRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = { preHandler: [app.requireAuth] };
  const key = (): string => app.config.APP_SECRET_KEY;

  app.get('/api/servers', auth, async () => repo.listServers(app.db, key()));

  app.post(
    '/api/servers',
    { ...auth, schema: { body: serverInputSchema } },
    async (request, reply) => {
      const input = request.body;
      try {
        // 登记与导入走同一个 SSRF 检查；失败由统一错误处理返回 400 INVALID_URL。
        if (input.kind === 'http') {
          await assertSafeUrl(input.url, app.config.NODE_ENV);
        } else if (input.kind === 'generated') {
          await assertSafeUrl(input.baseUrl, app.config.NODE_ENV);
        }
        const created = await repo.createServer(app.db, input, key());
        await writeAudit(app.db, request.log, {
          actor: 'admin',
          action: 'server.created',
          target: created.id,
          input,
          status: 'ok',
          requestId: request.id,
        });
        return reply.status(201).send(created);
      } catch (err) {
        rethrowConflict(err);
      }
    },
  );

  app.get('/api/servers/:id', { ...auth, schema: { params: idParams } }, async (request, reply) => {
    const server = await repo.getServer(app.db, request.params.id, key());
    return server ?? notFound(reply, 'server');
  });

  /** 只返回掩码与端点；明文只由 rotate 返回一次。 */
  app.get(
    '/api/servers/:id/token',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      const row = await repo.getServerRow(app.db, request.params.id);
      if (!row) return notFound(reply, 'server');
      if (row.kind !== 'generated') {
        return reject(reply, 'INVALID_INPUT', 'token is only available for generated servers');
      }
      const token = await getMcpToken(app.db, row.id);
      return {
        token: token ? `${token.slice(0, 4)}••••` : '',
        endpoint: `${app.config.SELF_URL}/mcp/${row.id}`,
      };
    },
  );

  app.post(
    '/api/servers/:id/rotate-token',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      const row = await repo.getServerRow(app.db, request.params.id);
      if (!row) return notFound(reply, 'server');
      if (row.kind !== 'generated') {
        return reject(reply, 'INVALID_INPUT', 'token is only available for generated servers');
      }
      const token = await repo.rotateMcpToken(app.db, row.id);
      if (!token) return notFound(reply, 'server');
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'server.token.rotated',
        target: row.id,
        status: 'ok',
        requestId: request.id,
      });
      return { token, endpoint: `${app.config.SELF_URL}/mcp/${row.id}` };
    },
  );

  app.patch(
    '/api/servers/:id',
    { ...auth, schema: { params: idParams, body: serverPatchSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      try {
        const row = await repo.getServerRow(app.db, id);
        if (!row) return notFound(reply, 'server');
        // 地址按库里实际的 kind 校验；只改描述不会复查既有地址。
        if (row.kind === 'http' && body.url !== undefined) {
          await assertSafeUrl(body.url, app.config.NODE_ENV);
        } else if (row.kind === 'generated' && body.baseUrl !== undefined) {
          await assertSafeUrl(body.baseUrl, app.config.NODE_ENV);
        }
        const updated = await repo.updateServer(app.db, id, body, key(), body.expectedUpdatedAt);
        if (!updated) return notFound(reply, 'server');
        await writeAudit(app.db, request.log, {
          actor: 'admin',
          action: 'server.updated',
          target: updated.id,
          input: body,
          status: 'ok',
          requestId: request.id,
        });
        return updated;
      } catch (err) {
        rethrowConflict(err);
      }
    },
  );

  app.delete(
    '/api/servers/:id',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      const ok = await repo.deleteServer(app.db, request.params.id);
      if (!ok) return notFound(reply, 'server');
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'server.deleted',
        target: request.params.id,
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );

  app.post(
    '/api/servers/:id/test',
    { ...auth, ...serverTestRateLimit, schema: { params: idParams } },
    async (request, reply) => {
      const server = await getServerWithSecrets(app.db, request.params.id, key());
      if (!server) return notFound(reply, 'server');
      const startedAt = Date.now();
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
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'mcp.server.tested',
        target: server.id,
        input: { kind: server.kind, name: server.name },
        status: result.ok ? 'ok' : 'error',
        durationMs: Date.now() - startedAt,
        requestId: request.id,
      });
      return serverTestResultSchema.parse(result);
    },
  );

  app.get(
    '/api/servers/:id/tools',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      const row = await repo.getServerRow(app.db, request.params.id);
      if (!row) return notFound(reply, 'server');
      return repo.listTools(app.db, request.params.id);
    },
  );

  app.post(
    '/api/servers/:id/tools',
    { ...auth, schema: { params: idParams, body: apiToolInputSchema } },
    async (request, reply) => {
      const row = await repo.getServerRow(app.db, request.params.id);
      if (!row) return notFound(reply, 'server');
      if (row.kind !== 'generated') {
        return reject(reply, 'INVALID_INPUT', 'tools can only be added to generated servers');
      }
      try {
        const tool = await repo.createTool(app.db, request.params.id, request.body);
        await writeAudit(app.db, request.log, {
          actor: 'admin',
          action: 'server.tool.created',
          target: request.params.id,
          input: { name: request.body.name, method: request.body.method },
          status: 'ok',
          requestId: request.id,
        });
        return reply.status(201).send(tool);
      } catch (err) {
        rethrowConflict(err);
      }
    },
  );

  app.patch(
    '/api/servers/:id/tools/:toolId',
    { ...auth, schema: { params: toolParams, body: toolPatchSchema } },
    async (request, reply) => {
      const { id, toolId } = request.params;
      const body = request.body;
      // 去掉 undefined：exactOptionalPropertyTypes 下「没有该键」与「值为 undefined」不同。
      const patch: ApiToolPatch = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.description !== undefined) patch.description = body.description;
      if (body.method !== undefined) patch.method = body.method;
      if (body.pathTemplate !== undefined) patch.pathTemplate = body.pathTemplate;
      if (body.inputSchema !== undefined) patch.inputSchema = body.inputSchema;
      if (body.paramsIn !== undefined) patch.paramsIn = body.paramsIn;
      if (body.requiresApproval !== undefined) patch.requiresApproval = body.requiresApproval;
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      const tool = await repo.updateTool(app.db, id, toolId, patch);
      if (!tool) return notFound(reply, 'tool');
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'server.tool.updated',
        target: id,
        input: { toolId, name: tool.name, ...patch },
        status: 'ok',
        requestId: request.id,
      });
      return tool;
    },
  );

  app.delete(
    '/api/servers/:id/tools/:toolId',
    { ...auth, schema: { params: toolParams } },
    async (request, reply) => {
      const { id, toolId } = request.params;
      const ok = await repo.deleteTool(app.db, id, toolId);
      if (!ok) return notFound(reply, 'tool');
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'server.tool.deleted',
        target: id,
        input: { toolId },
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );
}
