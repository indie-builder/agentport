import { randomUUID } from 'node:crypto';
import { newId } from '../../../packages/db/src/index.js';
import { client as sql } from './database.js';

interface Fixture {
  ownAgentId: string;
  foreignAgentId: string;
  succeededRunId: string;
  failedRunId: string;
  foreignRunId: string;
  targets: string[];
}

export async function seed(): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const fixture: Fixture = {
    ownAgentId: newId('agent'),
    foreignAgentId: newId('agent'),
    succeededRunId: newId('run'),
    failedRunId: newId('run'),
    foreignRunId: newId('run'),
    targets: [],
  };
  const ownConversations = [newId('conversation'), newId('conversation')];
  const foreignConversation = newId('conversation');

  await sql`insert into agents (id, slug, name, model, created_by, owner_business_id) values
       (${fixture.ownAgentId}, ${`e2e-runs-export-own-${suffix}`}, ${`E2E 运行导出 ${suffix}`}, 'test-model', 'bootstrap-admin', 'bootstrap-admin'), (${fixture.foreignAgentId}, ${`e2e-runs-export-foreign-${suffix}`}, ${`E2E 无关专家 ${suffix}`}, 'test-model', 'bootstrap-admin', 'bootstrap-admin')`;
  await sql`insert into conversations (id, agent_id, title, created_by) values
       (${ownConversations[0]}, ${fixture.ownAgentId}, ${`E2E 运行导出会话 ${suffix}`}, 'bootstrap-admin'), (${ownConversations[1]}, ${fixture.ownAgentId}, ${`E2E 运行导出会话 ${suffix}`}, 'bootstrap-admin'), (${foreignConversation}, ${fixture.foreignAgentId}, ${`E2E 无关会话 ${suffix}`}, 'bootstrap-admin')`;
  await sql`insert into agent_runs (id, conversation_id, agent_id, status, started_at, ended_at, error, subject_kind, initiated_by)
     values
       (${fixture.succeededRunId}, ${ownConversations[0]}, ${fixture.ownAgentId}, 'succeeded', now(), now(), null, 'user', 'bootstrap-admin'),
       (${fixture.failedRunId}, ${ownConversations[1]}, ${fixture.ownAgentId}, 'failed', now(), now(), 'fixture boom', 'user', 'bootstrap-admin'),
       (${fixture.foreignRunId}, ${foreignConversation}, ${fixture.foreignAgentId}, 'failed', now(), now(), 'foreign boom', 'user', 'bootstrap-admin')`;

  fixture.targets = [
    fixture.ownAgentId,
    fixture.foreignAgentId,
    ...ownConversations,
    foreignConversation,
    fixture.succeededRunId,
    fixture.failedRunId,
    fixture.foreignRunId,
  ];
  return fixture;
}

export async function cleanup(fixture: Fixture): Promise<void> {
  await sql`delete from audit_log where target = any(${sql.array(fixture.targets, 'TEXT')}::text[])`;
  await sql`delete from agents where id = any(${sql.array([fixture.ownAgentId, fixture.foreignAgentId], 'TEXT')}::text[])`;
}
