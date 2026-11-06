import { fail } from '@agentport/core';
import { type Database, repo } from '@agentport/db';
import type { MarketInstallInput } from '@agentport/shared';
import type { Logger } from 'pino';
import { isPgCode } from '../../http/errors.js';
import { writeAudit } from '../../plugins/audit.js';
import { toApi } from '../skills/api.js';
import { installFromMarket } from './install.js';

const skills = repo.skills;
export async function installMarketSkill(
  deps: {
    db: Database;
    log: Logger;
    actor: string;
    requestId: string;
  },
  input: MarketInstallInput,
) {
  if (await skills.getSkillBySourceId(deps.db, input.id)) {
    return fail('CONFLICT', '该技能已安装');
  }
  const installed = await installFromMarket(input);
  try {
    const row = await skills.createSkillWithFiles(
      deps.db,
      { ...installed.skill, sourceId: input.id },
      installed.files,
    );
    await writeAudit(deps.db, deps.log, {
      actor: deps.actor,
      action: 'skill.installed',
      target: row.id,
      input: { sourceId: input.id },
      status: 'ok',
      requestId: deps.requestId,
    });
    return { skill: toApi(row), warnings: installed.warnings };
  } catch (err) {
    if (isPgCode(err, '23505')) {
      if (await skills.getSkillBySourceId(deps.db, input.id)) {
        return fail('CONFLICT', '该技能已安装');
      }
      return fail('CONFLICT', '已有同名技能占用该 slug，请先删除或重命名后再安装');
    }
    throw err;
  }
}
