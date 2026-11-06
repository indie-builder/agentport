import { fail } from '@agentport/core';
import { repo } from '@agentport/db';
import type { Skill } from '@agentport/shared';
import { isPgCode } from '../../http/errors.js';

type SkillRow = NonNullable<Awaited<ReturnType<typeof repo.skills.getSkill>>>;
export function rethrowConflict(err: unknown): never {
  if (isPgCode(err, '23505')) fail('CONFLICT', '该 slug 已被其他技能占用，请换一个');
  throw err;
}
export function toApi(row: SkillRow): Skill {
  return {
    ...repo.skills.toSkillDefinition(row),
    id: row.id,
    sourceId: row.sourceId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
