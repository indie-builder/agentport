import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { newId } from '../id.js';
import * as chat from '../repo/chat.js';
import * as evalRepo from '../repo/eval.js';
import * as maintenance from '../repo/maintenance.js';
import { agentRuns, agents, conversations } from '../schema.js';

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
        sdkMessageUuid: '11111111-2222-4333-8444-555555555555',
        createdAt: at,
      },
    ]);
    await db
      .update(conversations)
      .set({ sdkSessionId: '66666666-7777-4888-8999-000000000000' })
      .where(eq(conversations.id, conversationId));
    await chat.branchConversation(db, { id: branchId, conversationId, fromMessageId: messageId });
    const [copy] = await chat.listMessages(db, branchId);
    expect(copy?.createdAt).toEqual(at);
    expect(copy?.runId).toBeNull();
    // 分支会话记下来源 session 与分叉点：首轮运行据此 fork，而不是拼文本历史。
    expect((await chat.getConversation(db, branchId))?.sdkSessionId).toBe(
      '66666666-7777-4888-8999-000000000000',
    );
    expect((await chat.getConversation(db, branchId))?.forkFromSdkMessageUuid).toBe(
      '11111111-2222-4333-8444-555555555555',
    );
    await maintenance.pruneRuns(db, 36_500);
    await pool.query('delete from conversations where id = $1', [conversationId]);
    await maintenance.pruneOrphanMessages(db, 36_500);
    expect((await chat.listMessages(db, branchId)).map((row) => row.content)).toEqual([
      { text: 'keep this' },
    ]);
  });

  it('keeps SDK session state consistent through the run finish path', async () => {
    const conv = newId('conversation');
    const runId = newId('run');
    await chat.createConversation(db, { id: conv, agentId, title: 'sdk state' });
    await chat.createRun(db, { id: runId, conversationId: conv, agentId });
    await db
      .update(agentRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(agentRuns.id, runId));

    const userMessage = await chat.appendMessage(db, {
      id: newId('message'),
      conversationId: conv,
      role: 'user',
      content: { text: 'hi' },
      runId,
      sdkMessageUuid: '11111111-2222-4333-8444-555555555555',
    });
    // 分支前还看不到 SDK 状态；运行收尾才写入。
    expect(await chat.getConversationSdkState(db, conv)).toEqual({
      sdkSessionId: null,
      forkFromSdkMessageUuid: null,
    });

    await chat.saveSdkState(db, {
      conversationId: conv,
      sdkSessionId: '66666666-7777-4888-8999-000000000000',
      uuidMap: [
        {
          from: '11111111-2222-4333-8444-555555555555',
          to: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        },
      ],
    });
    // uuid 重映射与 session 同事务写入；分叉点收尾清空。
    expect(await chat.getConversationSdkState(db, conv)).toEqual({
      sdkSessionId: '66666666-7777-4888-8999-000000000000',
      forkFromSdkMessageUuid: null,
    });
    expect((await chat.listMessages(db, conv))[0]?.sdkMessageUuid).toBe(
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );
    expect((await chat.listMessages(db, conv))[0]?.id).toBe(userMessage.id);
  });

  it('rejects branching when no SDK session exists yet', async () => {
    const conv = newId('conversation');
    await chat.createConversation(db, { id: conv, agentId, title: 'no session' });
    await chat.appendMessage(db, {
      id: newId('message'),
      conversationId: conv,
      role: 'user',
      content: { text: 'hi' },
    });
    await expect(
      chat.branchConversation(db, { id: newId('conversation'), conversationId: conv }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rolls back the branch row and copied history when a later message batch fails', async () => {
    const conv = newId('conversation');
    const branchId = newId('conversation');
    const marker = 'injected branch rollback marker';
    const total = 501;
    await chat.createConversation(db, { id: conv, agentId, title: 'rollback source' });
    await db
      .update(conversations)
      .set({ sdkSessionId: '66666666-7777-4888-8999-000000000000' })
      .where(eq(conversations.id, conv));
    const sourceRows = Array.from({ length: total }, (_, index) => ({
      id: newId('message'),
      conversationId: conv,
      role: 'user' as const,
      content: { text: index === 500 ? marker : `m${index}` },
      sdkMessageUuid: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
    }));
    await chat.insertMessages(db, sourceRows);

    // 标记消息落在第 501 条，让触发失败发生在第二批插入而不是第一批。
    await pool.query(`
      create or replace function messages_branch_rollback_probe() returns trigger
      language plpgsql as $$
      begin
        if new.content->>'text' = '${marker}' then
          raise exception 'injected branch rollback failure';
        end if;
        return new;
      end $$
    `);
    await pool.query(`
      create trigger messages_branch_rollback_probe
      before insert on messages
      for each row execute function messages_branch_rollback_probe()
    `);

    try {
      await expect(
        chat.branchConversation(db, { id: branchId, conversationId: conv }),
      ).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/injected branch rollback failure/) },
      });
    } finally {
      await pool.query('drop trigger if exists messages_branch_rollback_probe on messages');
      await pool.query('drop function if exists messages_branch_rollback_probe()');
    }

    const leftovers = await pool.query<{ conversations: string; messages: string }>(
      `select
        (select count(*) from conversations where id = $1) as conversations,
        (select count(*) from messages where conversation_id = $1) as messages`,
      [branchId],
    );
    expect(leftovers.rows[0]).toEqual({ conversations: '0', messages: '0' });

    // 源会话不受影响：消息完整、SDK 状态未变。
    const sourceAfter = await chat.listMessages(db, conv);
    expect(sourceAfter.map((row) => row.id)).toEqual(sourceRows.map((row) => row.id));
    expect(sourceAfter[500]?.content).toEqual({ text: marker });
    expect((await chat.getConversation(db, conv))?.sdkSessionId).toBe(
      '66666666-7777-4888-8999-000000000000',
    );
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
