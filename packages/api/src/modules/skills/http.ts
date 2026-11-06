import { fail, renderSkillMd } from '@agentport/core';
import { repo } from '@agentport/db';
import { idParams } from '@agentport/shared';
import type { Hono } from 'hono';
import type { AppContext, HttpEnv } from '../../http/context.js';
import { requestContext } from '../../http/context.js';
import { access } from '../../http/middleware.js';

export function registerSkillsHttp(app: Hono<HttpEnv>, _deps: AppContext): void {
  app.get(
    '/api/skills/:id/file',
    access({ kind: 'permission', permissionId: 'skills.read' }),
    async (c) => {
      const context = requestContext(c);
      const { id } = idParams.parse(c.req.param());
      const row = await repo.skills.getSkill(context.db, id);
      if (!row) fail('NOT_FOUND', '技能不存在，可能已被删除；请刷新后重试');
      return c.body(renderSkillMd(repo.skills.toSkillDefinition(row)), 200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': 'attachment; filename="SKILL.md"',
      });
    },
  );
}
