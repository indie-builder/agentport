import { repo } from '@agentport/db';
import { marketInstallInputSchema, marketViewSchema } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { isPgCode, reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import { actorOf } from '../access.js';
import { toApi } from '../skills/api.js';
import { installFromMarket } from './install.js';
import { fetchLeaderboard } from './leaderboard.js';
import { searchMarket } from './search.js';

const skills = repo.skills;

const listQuerySchema = z.object({
  view: marketViewSchema.optional(),
  q: z.string().trim().max(100).optional(),
});

export function registerMarketRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);

  app.get(
    '/api/market/skills',
    {
      config: { access: { kind: 'permission', permissionId: 'market.read' } },
      schema: { querystring: listQuerySchema },
    },
    async (request) => {
      const { view, q } = request.query;
      if (q === undefined) return fetchLeaderboard(view ?? 'all-time');
      // 单字符搜不出有意义的结果，直接返回空，避免打上游。
      if (q.length < 2) return [];
      return searchMarket(q);
    },
  );

  app.post(
    '/api/market/skills/install',
    {
      config: { access: { kind: 'permission', permissionId: 'market.install' } },
      schema: { body: marketInstallInputSchema },
    },
    async (request, reply) => {
      const input = request.body;
      if (await skills.getSkillBySourceId(app.db, input.id)) {
        return reject(reply, 'CONFLICT', '该技能已安装');
      }

      const installed = await installFromMarket(input);
      try {
        const row = await skills.createSkillWithFiles(
          app.db,
          { ...installed.skill, sourceId: input.id },
          installed.files,
        );
        await writeAudit(app.db, request.log, {
          actor: actorOf(request),
          action: 'skill.installed',
          target: row.id,
          input: { sourceId: input.id },
          status: 'ok',
          requestId: request.id,
        });
        return reply.status(201).send({ skill: toApi(row), warnings: installed.warnings });
      } catch (err) {
        // 并发安装同一技能会撞 source_id 唯一索引；先区分来源冲突，再落到 slug 冲突。
        if (isPgCode(err, '23505')) {
          if (await skills.getSkillBySourceId(app.db, input.id)) {
            return reject(reply, 'CONFLICT', '该技能已安装');
          }
          return reject(reply, 'CONFLICT', '已有同名技能占用该 slug，请先删除或重命名后再安装');
        }
        throw err;
      }
    },
  );
}
