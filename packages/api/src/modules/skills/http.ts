import { fail, NOT_FOUND_MESSAGES, renderSkillMd } from '@agentport/core';
import { repo } from '@agentport/db';
import { idParams } from '@agentport/shared';
import type { Hono } from 'hono';
import { authorizeResourceAccess } from '../../http/access.js';
import { attachmentResponse } from '../../http/attachment.js';
import type { HttpEnv } from '../../http/context.js';
import { requestContext } from '../../http/context.js';
import { access } from '../../http/middleware.js';

export function registerSkillsHttp(app: Hono<HttpEnv>): void {
  app.get(
    '/api/skills/:id/file',
    access({ kind: 'permission', permissionId: 'skills.read' }),
    async (c) => {
      const context = requestContext(c);
      const { id } = idParams.parse(c.req.param());
      const row = await repo.skills.getSkill(context.db, id);
      if (!row) fail('NOT_FOUND', NOT_FOUND_MESSAGES.skill);
      if (row.status !== 'published') fail('NOT_FOUND', NOT_FOUND_MESSAGES.skill);
      await authorizeResourceAccess(
        context,
        'skills.read',
        { kind: 'skill', resourceId: row.id, ownerBusinessId: row.ownerBusinessId, level: 'read' },
        NOT_FOUND_MESSAGES.skill,
      );
      return attachmentResponse(
        renderSkillMd(repo.skills.toSkillDefinition(row)),
        'SKILL.md',
        'text/markdown; charset=utf-8',
      );
    },
  );
}
