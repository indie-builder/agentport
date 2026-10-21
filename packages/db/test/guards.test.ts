import { count, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/client.js';
import { newId } from '../src/id.js';
import * as chat from '../src/repo/chat.js';
import * as evalRepo from '../src/repo/eval.js';
import { agents, conversations, evalCases, evalResults, evalRuns } from '../src/schema.js';

const url = process.env.DATABASE_URL ?? 'postgres://agentport:agentport@localhost:5432/agentport';
const { db, pool } = createDb(url);
const ready = await pool.query('select 1').then(
  () => true,
  () => false,
);

describe.skipIf(!ready)('db repo guards', () => {
  const agentId = newId('agent');
  const conversationId = newId('conversation');

  afterAll(async () => {
    // 删 agent 级联清掉会话、消息、评估数据。
    await db.delete(agents).where(eq(agents.id, agentId));
    await pool.end();
  });

  it('listMessages pages newest-first and keeps the no-arg order', async () => {
    await db.insert(agents).values({
      id: agentId,
      slug: `guard-${agentId}`,
      name: 'guard',
      model: 'test',
    });
    await db.insert(conversations).values({ id: conversationId, agentId });
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: newId('message'),
      conversationId,
      role: 'user',
      content: { text: `m${i}` },
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
    }));
    await chat.insertMessages(db, rows);

    const all = await chat.listMessages(db, conversationId);
    expect(all.map((row) => row.content)).toEqual(rows.map((row) => row.content));

    const page = await chat.listMessages(db, conversationId, { limit: 2 });
    expect(page.map((row) => row.content)).toEqual([{ text: 'm3' }, { text: 'm4' }]);

    const older = await chat.listMessages(db, conversationId, {
      limit: 2,
      before: page[0]?.id,
    });
    expect(older.map((row) => row.content)).toEqual([{ text: 'm1' }, { text: 'm2' }]);
  });

  it('a reconciled failed eval run cannot be overwritten or duplicated', async () => {
    const caseId = newId('evalCase');
    const evalRunId = newId('evalRun');
    await db.insert(evalCases).values({ id: caseId, agentId, name: 'c', prompt: 'p' });
    await evalRepo.createEvalRun(db, { id: evalRunId, agentId, total: 1 });
    await db
      .update(evalRuns)
      .set({ status: 'failed', error: 'reconciled' })
      .where(eq(evalRuns.id, evalRunId));

    await evalRepo.finishEvalRun(db, evalRunId, { status: 'succeeded', passed: 1 });
    await evalRepo.updateProgress(db, evalRunId, 1);

    const row = await evalRepo.getEvalRun(db, evalRunId);
    expect(row?.status).toBe('failed');
    expect(row?.passed).toBe(0);

    // 新外键要求 run 真实存在：造一条属于本测试的 run。
    const realRunId = newId('run');
    await chat.createRun(db, { id: realRunId, conversationId, agentId });
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
