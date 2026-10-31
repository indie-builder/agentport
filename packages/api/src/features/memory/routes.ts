import type { MemoryChange } from '@agentport/shared';
import {
  memoryChangeSchema,
  personalMemorySchema,
  writePersonalMemoryInputSchema,
} from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import { userPrincipal } from '../access.js';
import {
  listPersonalMemoryVersions,
  PERSONAL_MEMORY_FILENAME,
  readPersonalMemory,
  writePersonalMemory,
} from './personal.js';

const versionsQuery = z.object({
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const writeResponseSchema = personalMemorySchema.extend({ changeId: z.string() });

const versionsResponseSchema = z.object({ items: z.array(memoryChangeSchema) });

export function registerPersonalMemoryRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);

  app.get(
    '/api/me/memory',
    {
      config: { access: { kind: 'permission', permissionId: 'personal_memory.read' } },
      schema: { response: { 200: personalMemorySchema } },
    },
    async (request) => readPersonalMemory(app.db, userPrincipal(request).businessId),
  );

  app.put(
    '/api/me/memory',
    {
      config: { access: { kind: 'permission', permissionId: 'personal_memory.write' } },
      schema: { body: writePersonalMemoryInputSchema, response: { 200: writeResponseSchema } },
    },
    async (request, reply) => {
      const saved = await writePersonalMemory({
        db: app.db,
        pool: app.pool,
        workspacesDir: app.config.WORKSPACES_DIR,
        businessId: userPrincipal(request).businessId,
        content: request.body.content,
        expectedRevision: request.body.expectedRevision,
        logger: request.log,
      });
      if (saved === null) {
        return reject(reply, 'CONFLICT', '个人记忆已被其他编辑更新，请刷新后重试');
      }
      return saved;
    },
  );

  app.get(
    '/api/me/memory/download',
    { config: { access: { kind: 'permission', permissionId: 'personal_memory.read' } } },
    async (request, reply) => {
      const { content } = await readPersonalMemory(app.db, userPrincipal(request).businessId);
      return reply
        .header('content-disposition', `attachment; filename="${PERSONAL_MEMORY_FILENAME}"`)
        .header('cache-control', 'no-store')
        .type('text/markdown; charset=utf-8')
        .send(content);
    },
  );

  app.get(
    '/api/me/memory/versions',
    {
      config: { access: { kind: 'permission', permissionId: 'personal_memory.read' } },
      schema: { querystring: versionsQuery, response: { 200: versionsResponseSchema } },
    },
    async (request) => {
      const { before, limit } = request.query;
      const items: MemoryChange[] = await listPersonalMemoryVersions(
        app.db,
        userPrincipal(request).businessId,
        {
          ...(before === undefined ? {} : { before }),
          limit,
        },
      );
      return { items };
    },
  );
}
