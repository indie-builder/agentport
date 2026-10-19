import { repo as skillRepo } from '@agentport/db';
import type { Skill } from '@agentport/shared';
import { skillInputSchema } from '@agentport/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

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

function invalid(reply: FastifyReply, message: string) {
  return reply.status(400).send({ code: 'INVALID_INPUT', message });
}

function notFound(reply: FastifyReply) {
  return reply.status(404).send({ code: 'NOT_FOUND', message: 'skill not found' });
}

/** skills.slug 上有唯一索引；drizzle 把 pg 错误包在 cause 里，得顺着链找。 */
function rethrowConflict(err: unknown): never {
  let cause: unknown = err;
  while (typeof cause === 'object' && cause !== null) {
    if ('code' in cause && cause.code === '23505') {
      throw Object.assign(new Error('skill slug already exists'), {
        statusCode: 409,
        code: 'CONFLICT',
      });
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

export function registerSkillRoutes(app: FastifyInstance): void {
  const auth = { preHandler: [app.requireAuth] };

  app.get('/api/skills', auth, async () => {
    const rows = await repo.listSkills(app.db);
    return rows.map(toApi);
  });

  app.post('/api/skills', auth, async (request, reply) => {
    const parsed = skillInputSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? 'invalid body');
    try {
      const row = await repo.createSkill(app.db, parsed.data);
      return reply.status(201).send(toApi(row));
    } catch (err) {
      rethrowConflict(err);
    }
  });

  app.get('/api/skills/:id', auth, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, 'invalid id');
    const row = await repo.getSkill(app.db, params.data.id);
    return row ? toApi(row) : notFound(reply);
  });

  app.patch('/api/skills/:id', auth, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, 'invalid id');
    const body = patchSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.issues[0]?.message ?? 'invalid body');
    const input = body.data;
    const patch: Partial<SkillWrite> = {
      ...(input.slug === undefined ? {} : { slug: input.slug }),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.body === undefined ? {} : { body: input.body }),
    };
    try {
      const row = await repo.updateSkill(app.db, params.data.id, patch);
      return row ? toApi(row) : notFound(reply);
    } catch (err) {
      rethrowConflict(err);
    }
  });

  app.delete('/api/skills/:id', auth, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, 'invalid id');
    const ok = await repo.deleteSkill(app.db, params.data.id);
    if (!ok) return notFound(reply);
    return reply.status(204).send();
  });
}
