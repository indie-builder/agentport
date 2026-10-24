import { fail, isAppError, parseSkillMd, renderSkillMd } from '@agentport/core';
import { repo as skillRepo } from '@agentport/db';
import type { Skill, SkillWithAgentCount } from '@agentport/shared';
import { idParams, skillFileInputSchema, skillInputSchema, slugSchema } from '@agentport/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { isPgCode, reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';

const repo = skillRepo.skills;
const filesRepo = skillRepo.skillFiles;
type SkillWrite = Parameters<typeof repo.createSkill>[1];

// 通配路由用 '*' 捕获多段相对路径（scripts/run.sh 之类）；路径规则与导入导出共用。
const skillFileParams = z.object({
  id: z.string().min(1),
  '*': skillFileInputSchema.shape.path,
});

// 解析（含 frontmatter / 字段校验）放在 schema 里：handler 只拿解析结果，不再 safeParse。
const importSchema = z.object({ skillMd: z.string().max(131072) }).transform(({ skillMd }, ctx) => {
  try {
    return parseSkillMd(skillMd);
  } catch (err) {
    if (!isAppError(err)) throw err;
    ctx.addIssue({ code: 'custom', path: ['skillMd'], message: err.message });
    return z.NEVER;
  }
});

const patchSchema = z.object({
  slug: slugSchema.optional(),
  name: z.string().min(1).max(128).optional(),
  description: z.string().min(1).max(500).optional(),
  body: z.string().optional(),
  license: skillInputSchema.shape.license,
  compatibility: skillInputSchema.shape.compatibility,
  metadata: skillInputSchema.shape.metadata,
  expectedUpdatedAt: z.iso.datetime().optional(),
});

function notFound(reply: FastifyReply) {
  return reject(reply, 'NOT_FOUND', '技能不存在，可能已被删除；请刷新后重试');
}

/** skills.slug 有唯一索引（23505）→ 409。 */
function rethrowConflict(err: unknown): never {
  if (isPgCode(err, '23505')) fail('CONFLICT', '该 slug 已被其他技能占用，请换一个');
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
    ...(row.license ? { license: row.license } : {}),
    ...(row.compatibility ? { compatibility: row.compatibility } : {}),
    ...(Object.keys(row.metadata).length > 0 ? { metadata: row.metadata } : {}),
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

  // 导入只接受官方 SKILL.md；slug 即 frontmatter 的 name，冲突与手动创建一样返回 409。
  app.post(
    '/api/skills/import',
    { ...auth, schema: { body: importSchema } },
    async (request, reply) => {
      const { skill, warnings } = request.body;
      try {
        const row = await repo.createSkill(app.db, skill);
        await writeAudit(app.db, request.log, {
          actor: 'admin',
          action: 'skill.imported',
          target: row.id,
          input: { slug: row.slug },
          status: 'ok',
          requestId: request.id,
        });
        return reply.status(201).send({ skill: toApi(row), warnings });
      } catch (err) {
        rethrowConflict(err);
      }
    },
  );

  app.get('/api/skills/:id', { ...auth, schema: { params: idParams } }, async (request, reply) => {
    const row = await repo.getSkill(app.db, request.params.id);
    return row ? toApi(row) : notFound(reply);
  });

  // 下载内容必须与 worker 落盘的 SKILL.md 一致，因此复用同一个渲染函数。
  app.get(
    '/api/skills/:id/file',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      const row = await repo.getSkill(app.db, request.params.id);
      if (!row) return notFound(reply);
      return reply
        .header('Content-Type', 'text/markdown; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="SKILL.md"')
        .send(renderSkillMd(row));
    },
  );

  app.patch(
    '/api/skills/:id',
    { ...auth, schema: { params: idParams, body: patchSchema } },
    async (request, reply) => {
      const input = request.body;
      const patch: Partial<SkillWrite> = {
        ...(input.slug === undefined ? {} : { slug: input.slug }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.license === undefined ? {} : { license: input.license }),
        ...(input.compatibility === undefined ? {} : { compatibility: input.compatibility }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      };
      try {
        const row = await repo.updateSkill(
          app.db,
          request.params.id,
          patch,
          input.expectedUpdatedAt === undefined ? undefined : new Date(input.expectedUpdatedAt),
        );
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
      const ok = await repo.deleteSkill(app.db, request.params.id);
      if (!ok) return notFound(reply);
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'skill.deleted',
        target: request.params.id,
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );

  // 技能支持资源文件（官方 SKILL.md 目录里的 scripts/、references/ 等）。
  app.get(
    '/api/skills/:id/files',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      const skill = await repo.getSkill(app.db, request.params.id);
      if (!skill) return notFound(reply);
      const rows = await filesRepo.listSkillFiles(app.db, skill.id);
      return rows.map((r) => ({
        id: r.id,
        path: r.path,
        content: r.content,
        createdAt: r.createdAt.toISOString(),
      }));
    },
  );

  app.put(
    '/api/skills/:id/files/*',
    {
      ...auth,
      schema: { params: skillFileParams, body: skillFileInputSchema.pick({ content: true }) },
    },
    async (request, reply) => {
      const skill = await repo.getSkill(app.db, request.params.id);
      if (!skill) return notFound(reply);
      const row = await filesRepo.upsertSkillFile(
        app.db,
        skill.id,
        request.params['*'],
        request.body.content,
      );
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'skill.file.written',
        target: skill.id,
        input: { path: request.params['*'] },
        status: 'ok',
        requestId: request.id,
      });
      return {
        id: row.id,
        path: row.path,
        content: row.content,
        createdAt: row.createdAt.toISOString(),
      };
    },
  );

  app.delete(
    '/api/skills/:id/files/*',
    { ...auth, schema: { params: skillFileParams } },
    async (request, reply) => {
      const skill = await repo.getSkill(app.db, request.params.id);
      if (!skill) return notFound(reply);
      const ok = await filesRepo.deleteSkillFile(app.db, skill.id, request.params['*']);
      if (!ok) return notFound(reply);
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'skill.file.deleted',
        target: skill.id,
        input: { path: request.params['*'] },
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );
}
