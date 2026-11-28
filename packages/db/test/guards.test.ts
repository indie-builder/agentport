import { afterAll, describe, expect, it } from 'bun:test';
import { count, eq } from 'drizzle-orm';
import { newId } from '../src/id.js';
import * as chat from '../src/repo/chat.js';
import * as evalRepo from '../src/repo/eval.js';
import { agents, conversations, evalCases, evalResults, evalRuns } from '../src/schema.js';
import { probeTestDb } from './db-probe.js';

const { db, client, ready } = await probeTestDb();

describe.skipIf(!ready)('db repo guards', () => {
  const businessId = 'guard-owner';
  const agentId = newId('agent');
  const conversationId = newId('conversation');

  afterAll(async () => {
    await db.delete(agents).where(eq(agents.id, agentId));
    await client.close();
  });

  it('listMessages pages newest-first and keeps the no-arg order', async () => {
    await db.insert(agents).values({
      id: agentId,
      slug: `guard-${agentId}`,
      name: 'guard',
      model: 'test',
      createdBy: businessId,
      ownerBusinessId: businessId,
    });
    await db.insert(conversations).values({ id: conversationId, agentId, createdBy: businessId });
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: newId('message'),
      conversationId,
      role: 'user' as const,
      senderBusinessId: businessId,
      content: { text: `m${i}` },
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
    }));
    await chat.insertMessages(db, rows);

    const all = await chat.listMessages(db, conversationId);
    expect(all.map((row) => row.content)).toEqual(rows.map((row) => row.content));

    const page = await chat.listMessages(db, conversationId, { limit: 2 });
    expect(page.map((row) => row.content)).toEqual([{ text: 'm3' }, { text: 'm4' }]);

    const firstMessage = page[0];
    if (!firstMessage) throw new Error('expected first message in page');
    const older = await chat.listMessages(db, conversationId, {
      limit: 2,
      before: firstMessage.id,
    });
    if (!older) throw new Error('expected older messages');
    expect(older.map((row) => row.content)).toEqual([{ text: 'm1' }, { text: 'm2' }]);
  });

  it('a reconciled failed eval run cannot be overwritten or duplicated', async () => {
    const caseId = newId('evalCase');
    const evalRunId = newId('evalRun');
    await db
      .insert(evalCases)
      .values({ id: caseId, agentId, name: 'c', prompt: 'p', createdBy: businessId });
    await evalRepo.createEvalRun(db, { id: evalRunId, agentId, total: 1, createdBy: businessId });
    await db
      .update(evalRuns)
      .set({ status: 'failed', error: 'reconciled' })
      .where(eq(evalRuns.id, evalRunId));

    await evalRepo.finishEvalRun(db, evalRunId, { status: 'succeeded', passed: 1 });

    const row = await evalRepo.getEvalRun(db, evalRunId);
    expect(row?.status).toBe('failed');
    expect(row?.passed).toBe(0);

    const realRunId = newId('run');
    await chat.createRun(db, {
      id: realRunId,
      conversationId,
      agentId,
      subject: { kind: 'user', businessId },
    });
    const result = { evalRunId, caseId, runId: realRunId, passed: true, output: '' };
    await evalRepo.addResult(db, { id: newId('evalResult'), ...result });
    await evalRepo.addResult(db, { id: newId('evalResult'), ...result });

    const [dupes] = await db
      .select({ n: count() })
      .from(evalResults)
      .where(eq(evalResults.evalRunId, evalRunId));
    expect(dupes?.n).toBe(1);
  });
});
