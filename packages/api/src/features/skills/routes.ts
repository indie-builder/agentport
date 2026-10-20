import { fail } from '@agentport/core';
import { repo as skillRepo } from '@agentport/db';
import type { Skill, SkillWithAgentCount } from '@agentport/shared';
import { skillInputSchema } from '@agentport/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';

const repo = skillRepo.skills;
type SkillWrite = Parameters<typeof repo.createSkill>[1];

const idParams = z.object({ id: z.string().min(1) });

const patchSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, '仅允许小写字母、数字、- 和 _')
    .optional(),
  name: z.string().min(1).max(128).optional(),
  description: z.string().min(1).max(500).optional(),
  body: z.string().optional(),
});

function notFound(reply: FastifyReply) {
  return reject(reply, 'NOT_FOUND', 'skill not found');
}

/** skills.slug 上有唯一索引；drizzle 把 pg 错误包在 cause 里，得顺着链找。 */
function rethrowConflict(err: unknown): never {
  let cause: unknown = err;
  while (typeof cause === 'object' && cause !== null) {
    if ('code' in cause && cause.code === '23505') {
      fail('CONFLICT', 'skill slug already exists');
    }
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw err;
}

type SkillRow = NonNullable<Awaited<ReturnType<typeof repo.getSkill>>>;

function toApi(row: SkillRow): Skill {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function registerSkillRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };

  app.get('/api/skills', auth, async () => {
    const rows = await repo.listSkills(app.db);
    return rows.map((row): SkillWithAgentCount => ({ ...toApi(row), agentCount: row.agentCount }));
  });

  app.post(
    '/api/skills',
    { ...auth, schema: { body: skillInputSchema } },
    async (request, reply) => {
      try {
        const row = await repo.createSkill(app.db, request.body);
        await writeAudit(app.db, request.log, {
          actor: 'admin',
          action: 'skill.created',
          target: row.id,
          input: request.body,
          status: 'ok',
          requestId: request.id,
        });
        return reply.status(201).send(toApi(row));
      } catch (err) {
        rethrowConflict(err);
      }
    },
  );

  app.get('/api/skills/:id', { ...auth, schema: { params: idParams } }, async (request, reply) => {
    const row = await repo.getSkill(app.db, request.params.id);
    return row ? toApi(row) : notFound(reply);
  });

  app.patch(
    '/api/skills/:id',
    { ...auth, schema: { params: idParams, body: patchSchema } },
    async (request, reply) => {
      const params = { data: request.params };
      const input = request.body;
      const patch: Partial<SkillWrite> = {
        ...(input.slug === undefined ? {} : { slug: input.slug }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.body === undefined ? {} : { body: input.body }),
      };
      try {
        const row = await repo.updateSkill(app.db, params.data.id, patch);
        if (!row) return notFound(reply);
        await writeAudit(app.db, request.log, {
          actor: 'admin',
          action: 'skill.updated',
          target: row.id,
          input: patch,
          status: 'ok',
          requestId: request.id,
        });
        return toApi(row);
      } catch (err) {
        rethrowConflict(err);
      }
    },
  );

  app.delete(
    '/api/skills/:id',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      const params = { data: request.params };
      const ok = await repo.deleteSkill(app.db, params.data.id);
      if (!ok) return notFound(reply);
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'skill.deleted',
        target: params.data.id,
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );
}
