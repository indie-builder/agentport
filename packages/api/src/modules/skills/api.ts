import { repo } from '@agentport/db';
import type { Skill } from '@agentport/shared';
import { toIso } from '../../lib/iso.js';

type SkillRow = NonNullable<Awaited<ReturnType<typeof repo.skills.getSkill>>>;
export function toApi(row: SkillRow): Skill {
  return {
    ...repo.skills.toSkillDefinition(row),
    id: row.id,
    sourceId: row.sourceId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    status: row.status,
    submittedAt: toIso(row.submittedAt),
    reviewedAt: toIso(row.reviewedAt),
    reviewedBy: row.reviewedBy,
    reviewNote: row.reviewNote,
  };
}
