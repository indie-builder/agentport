import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { newId } from '../id.js';
import * as chat from '../repo/chat.js';
import * as evalRepo from '../repo/eval.js';
import * as maintenance from '../repo/maintenance.js';
import { agents } from '../schema.js';

const { db, pool } = createDb(
  process.env.DATABASE_URL ?? 'postgres://agentport:agentport@localhost:5432/agentport',
);
const agentId = newId('agent');
const conversationId = newId('conversation');

beforeAll(async () => {
  await db
    .insert(agents)
    .values({ id: agentId, slug: `integrity-${agentId}`, name: 'integrity', model: 'test' });
  await chat.createConversation(db, { id: conversationId, agentId, title: 'source' });
});

afterAll(async () => {
  await db.delete(agents).where(eq(agents.id, agentId));
  await pool.end();
});

describe('history integrity', () => {
  it('preserves branch timestamps and history through run pruning and parent deletion', async () => {
    const runId = newId('run');
    const messageId = newId('message');
    const branchId = newId('conversation');
    const at = new Date(Date.now() - 36_501 * 86_400_000);
    await chat.createRun(db, { id: runId, conversationId, agentId });
    await chat.updateRun(db, runId, { status: 'succeeded', startedAt: at, endedAt: at });
    await chat.insertMessages(db, [
      {
        id: messageId,
        conversationId,
        runId,
        role: 'user',
        content: { text: 'keep this' },
        createdAt: at,
      },
    ]);
    await chat.branchConversation(db, { id: branchId, conversationId, fromMessageId: messageId });
    const [copy] = await chat.listMessages(db, branchId);
    expect(copy?.createdAt).toEqual(at);
    expect(copy?.runId).toBeNull();
    await maintenance.pruneRuns(db, 36_500);
    await pool.query('delete from conversations where id = $1', [conversationId]);
    await maintenance.pruneOrphanMessages(db, 36_500);
    expect((await chat.listMessages(db, branchId)).map((row) => row.content)).toEqual([
      { text: 'keep this' },
    ]);
  });

  it('keeps eval result rows visible after their case and run are deleted', async () => {
    const conv = newId('conversation');
    const runId = newId('run');
    const evalRunId = newId('evalRun');
    const caseId = newId('evalCase');
    await chat.createConversation(db, { id: conv, agentId, title: 'eval' });
    await chat.createRun(db, { id: runId, conversationId: conv, agentId });
    await evalRepo.createCase(db, caseId, {
      agentId,
      name: 'original case',
      prompt: 'p',
      expectation: 'e',
    });
    await evalRepo.createEvalRun(db, { id: evalRunId, agentId, total: 1 });
    await evalRepo.addResult(db, {
      id: newId('evalResult'),
      evalRunId,
      caseId,
      runId,
      passed: true,
      output: 'saved output',
    });
    await evalRepo.finishEvalRun(db, evalRunId, { status: 'succeeded', passed: 1 });
    await evalRepo.deleteCase(db, caseId);
    await pool.query('delete from agent_runs where id = $1', [runId]);
    const detail = await evalRepo.getRunDetail(db, evalRunId);
    expect(detail?.evalRun).toMatchObject({ total: 1, passed: 1 });
    expect(detail?.results).toHaveLength(1);
    expect(detail?.results[0]).toMatchObject({
      caseId: null,
      runId: null,
      passed: true,
      output: 'saved output',
      name: 'Deleted case',
    });
  });
});

describe('database trust boundaries', () => {
  it.each([
    [
      'messages',
      "insert into messages (id, conversation_id, role, content) values ($1, $2, 'system', '{}')",
      conversationId,
    ],
    [
      'agent_runs',
      `insert into agent_runs (id, conversation_id, agent_id, status) values ($1, $2, '${agentId}', 'unknown')`,
      conversationId,
    ],
    [
      'agents permission',
      "insert into agents (id, slug, name, model, permission_mode) values ($1, $1, 'bad', 'test', 'auto')",
      null,
    ],
    [
      'agents tools',
      "insert into agents (id, slug, name, model, allowed_tools) values ($1, $1, 'bad', 'test', '[1]')",
      null,
    ],
    [
      'servers',
      "insert into servers (id, name, kind, config) values ($1, $1, 'unknown', '{}')",
      null,
    ],
    [
      'eval_runs',
      "insert into eval_runs (id, agent_id, status) values ($1, $2, 'unknown')",
      agentId,
    ],
  ])('rejects unsupported %s values', async (_name, query, parentId) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await expect(
        client.query(query, parentId === null ? [newId('message')] : [newId('message'), parentId]),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
