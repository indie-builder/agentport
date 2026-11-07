import { skillsContract } from '@agentport/contract/skills';
import { fail, parseSkillMd } from '@agentport/core';
import { repo as skillRepo } from '@agentport/db';
import type { SkillWithAgentCount } from '@agentport/shared';
import { implement } from '@orpc/server';
import { actorOf } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { rethrowConflict, toApi } from './api.js';

const repo = skillRepo.skills;
const filesRepo = skillRepo.skillFiles;
type SkillWrite = Parameters<typeof repo.createSkill>[1];
function notFound() {
  return fail('NOT_FOUND', '技能不存在，可能已被删除；请刷新后重试');
}
const os = implement(skillsContract).$context<RequestContext>();
export const skillsRouter = os.router({
  list: os.list.handler(async ({ context, input: routeInput }) => {
    const rows = await repo.listSkills(context.db);
    return rows.map((row): SkillWithAgentCount => ({ ...toApi(row), agentCount: row.agentCount }));
  }),
  create: os.create.handler(async ({ context, input: routeInput }) => {
    try {
      const row = await repo.createSkill(context.db, routeInput.body);
      await skillRepo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'skill.created',
        target: row.id,
        input: routeInput.body,
        status: 'ok',
        requestId: context.requestId,
      });
      return toApi(row);
    } catch (err) {
      rethrowConflict(err);
    }
  }),
  importFile: os.importFile.handler(async ({ context, input: routeInput }) => {
    const { skill, warnings } = parseSkillMd(routeInput.body.skillMd);
    try {
      const row = await repo.createSkill(context.db, skill);
      await skillRepo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'skill.imported',
        target: row.id,
        input: { slug: row.slug },
        status: 'ok',
        requestId: context.requestId,
      });
      return { skill: toApi(row), warnings };
    } catch (err) {
      rethrowConflict(err);
    }
  }),
  get: os.get.handler(async ({ context, input: routeInput }) => {
    const row = await repo.getSkill(context.db, routeInput.params.id);
    return row ? toApi(row) : notFound();
  }),
  update: os.update.handler(async ({ context, input: routeInput }) => {
    const input = routeInput.body;
    const patch: Partial<SkillWrite> = {
      ...(input.slug === undefined ? {} : { slug: input.slug }),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.license === undefined ? {} : { license: input.license }),
      ...(input.compatibility === undefined ? {} : { compatibility: input.compatibility }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata ?? {} }),
    };
    try {
      const row = await repo.updateSkill(
        context.db,
        routeInput.params.id,
        patch,
        input.expectedUpdatedAt === undefined ? undefined : new Date(input.expectedUpdatedAt),
      );
      if (!row) return notFound();
      await skillRepo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'skill.updated',
        target: row.id,
        input: patch,
        status: 'ok',
        requestId: context.requestId,
      });
      return toApi(row);
    } catch (err) {
      rethrowConflict(err);
    }
  }),
  delete: os.delete.handler(async ({ context, input: routeInput }) => {
    const ok = await repo.deleteSkill(context.db, routeInput.params.id);
    if (!ok) return notFound();
    await skillRepo.audit.writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'skill.deleted',
      target: routeInput.params.id,
      status: 'ok',
      requestId: context.requestId,
    });
    return undefined;
  }),
  files: os.files.handler(async ({ context, input: routeInput }) => {
    const skill = await repo.getSkill(context.db, routeInput.params.id);
    if (!skill) return notFound();
    const rows = await filesRepo.listSkillFiles(context.db, skill.id);
    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      content: r.content,
      createdAt: r.createdAt.toISOString(),
    }));
  }),
  writeFile: os.writeFile.handler(async ({ context, input: routeInput }) => {
    const skill = await repo.getSkill(context.db, routeInput.params.id);
    if (!skill) return notFound();
    const path = routeInput.params.path;
    const row = await filesRepo.upsertSkillFile(
      context.db,
      skill.id,
      path,
      routeInput.body.content,
    );
    await skillRepo.audit.writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'skill.file.written',
      target: skill.id,
      input: { path },
      status: 'ok',
      requestId: context.requestId,
    });
    return {
      id: row.id,
      path: row.path,
      content: row.content,
      createdAt: row.createdAt.toISOString(),
    };
  }),
  deleteFile: os.deleteFile.handler(async ({ context, input: routeInput }) => {
    const skill = await repo.getSkill(context.db, routeInput.params.id);
    if (!skill) return notFound();
    const ok = await filesRepo.deleteSkillFile(context.db, skill.id, routeInput.params.path);
    if (!ok) return notFound();
    await skillRepo.audit.writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'skill.file.deleted',
      target: skill.id,
      input: { path: routeInput.params.path },
      status: 'ok',
      requestId: context.requestId,
    });
    return undefined;
  }),
});
