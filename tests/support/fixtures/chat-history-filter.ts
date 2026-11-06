import { randomUUID } from 'node:crypto';
import { newId } from '../../../packages/db/src/index.js';
import { client as sql } from './database.js';

interface Fixture {
  agents: [string, string];
  names: [string, string];
  conversations: { alpha: string; beta: string; gamma: string };
  titles: { alpha: string; beta: string; gamma: string };
  bodies: { alpha: string; beta: string; gamma: string };
}

export async function seed(): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const fixture: Fixture = {
    agents: [newId('agent'), newId('agent')],
    names: [`E2E 过滤 A ${suffix}`, `E2E 过滤 B ${suffix}`],
    conversations: {
      alpha: newId('conversation'),
      beta: newId('conversation'),
      gamma: newId('conversation'),
    },
    titles: {
      alpha: `Alpha 项目 ${suffix}`,
      beta: `Beta 计划 ${suffix}`,
      gamma: `Gamma 话题 ${suffix}`,
    },
    bodies: {
      alpha: `Alpha 正文关键词 ${suffix}`,
      beta: `Beta 正文关键词 ${suffix}`,
      gamma: `Gamma 正文关键词 ${suffix}`,
    },
  };
  const [agentA, agentB] = fixture.agents;
  const { alpha, beta, gamma } = fixture.conversations;

  await sql.begin(async (tx) => {
    await tx`insert into agents (id, slug, name, model, created_by, owner_business_id) values
         (${agentA}, ${`e2e-filter-a-${suffix}`}, ${fixture.names[0]}, 'test-model', 'bootstrap-admin', 'bootstrap-admin'), (${agentB}, ${`e2e-filter-b-${suffix}`}, ${fixture.names[1]}, 'test-model', 'bootstrap-admin', 'bootstrap-admin')`;
    await tx`insert into conversations (id, agent_id, title, created_by) values
         (${alpha}, ${agentA}, ${fixture.titles.alpha}, 'bootstrap-admin'), (${beta}, ${agentA}, ${fixture.titles.beta}, 'bootstrap-admin'), (${gamma}, ${agentB}, ${fixture.titles.gamma}, 'bootstrap-admin')`;
    await tx`insert into messages (id, conversation_id, role, content) values
         (${newId('message')}, ${alpha}, 'user', jsonb_build_object('type', 'text', 'text', ${fixture.bodies.alpha}::text)),
         (${newId('message')}, ${beta}, 'user', jsonb_build_object('type', 'text', 'text', ${fixture.bodies.beta}::text)),
         (${newId('message')}, ${gamma}, 'user', jsonb_build_object('type', 'text', 'text', ${fixture.bodies.gamma}::text))`;
  });
  return fixture;
}

export async function cleanup(fixture: Fixture): Promise<void> {
  await sql`delete from audit_log where target = any(${sql.array([...fixture.agents, ...Object.values(fixture.conversations)], 'TEXT')}::text[])`;
  await sql`delete from agents where id = any(${sql.array(fixture.agents, 'TEXT')}::text[])`;
}
