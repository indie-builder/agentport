import {
  agentRuns,
  agents,
  conversations,
  messages,
  newId,
} from '../../../packages/db/src/index.js';
import { db as database, client as sql } from './database.js';

export async function seed() {
  const agentId = newId('agent');
  const conversationId = newId('conversation');
  const runId = newId('run');

  await database.insert(agents).values({
    id: agentId,
    slug: `regression-${agentId}`,
    name: 'Run navigation fixture',
    model: 'test-model',
    createdBy: 'bootstrap-admin',
    ownerBusinessId: 'bootstrap-admin',
  });
  await database
    .insert(conversations)
    .values({ id: conversationId, agentId, createdBy: 'bootstrap-admin' });
  await database.insert(agentRuns).values({
    id: runId,
    agentId,
    conversationId,
    status: 'succeeded',
    subjectKind: 'user',
    initiatedBy: 'bootstrap-admin',
    startedAt: new Date(),
    endedAt: new Date(),
  });
  await database.insert(messages).values({
    id: newId('message'),
    conversationId,
    runId,
    role: 'user',
    content: { type: 'text', text: 'Run navigation fixture' },
  });
  return { agentId, runId };
}

export async function cleanup(agentId: string): Promise<void> {
  await sql`delete from agents where id = ${agentId}`;
}
