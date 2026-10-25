import { createHash } from 'node:crypto';
import { newId, repo } from '@agentport/db';
import type { Agent } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  createAgent,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

// 会话 fixture 直接写 repo，不经过 /api/chat：不会产生 queued run，也就不依赖 worker 空闲。
const ready = await infraReady;

describe.skipIf(!ready)('conversations', () => {
  let app: FastifyInstance;
  let cookie: string;
  const agentSlugs: string[] = [];
  const conversationIds: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs });
    if (conversationIds.length > 0) {
      await app.pool.query('delete from audit_log where target = any($1::text[])', [
        conversationIds,
      ]);
    }
    await app.close();
  });

  const auth = () => ({ cookie });

  const newAgent = async (): Promise<Agent> =>
    (
      await createAgent(app, cookie, { slug: unique('conv-agent'), track: agentSlugs })
    ).json<Agent>();

  const newConversation = async (agentId: string, title = '原会话') => {
    const id = newId('conversation');
    await repo.chat.createConversation(app.db, { id, agentId, title });
    conversationIds.push(id);
    return id;
  };

  const rename = (id: string, payload: unknown, headers: Record<string, string> = auth()) =>
    inject(app, { method: 'PATCH', url: `/api/conversations/${id}`, headers, payload });

  const remove = (id: string, headers: Record<string, string> = auth()) =>
    inject(app, { method: 'DELETE', url: `/api/conversations/${id}`, headers });

  it('requires auth', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    expectProblem(await rename(id, { title: 'x' }, {}), 'UNAUTHORIZED');
  });

  it('returns 404 for an unknown conversation', async () => {
    expectProblem(await rename('conv_missing', { title: 'x' }), 'CONVERSATION_NOT_FOUND');
  });

  it.each([
    ['blank', ''],
    ['whitespace only', '   '],
    ['too long', 'a'.repeat(129)],
    ['not a string', 42],
    ['missing title', {}],
  ])('rejects %s with 400', async (_label, title) => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    expectProblem(await rename(id, { title }), 'INVALID_INPUT');
    expect((await repo.chat.getConversation(app.db, id))?.title).toBe('原会话');
  });

  it('renames with a trimmed Unicode title and leaves messages, run and timestamps intact', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id, '旧标题');
    const message = await repo.chat.appendMessage(app.db, {
      id: newId('message'),
      conversationId: id,
      role: 'user',
      content: { type: 'text', text: '保留我' },
    });
    const before = await inject(app, {
      method: 'GET',
      url: `/api/conversations/${id}`,
      headers: auth(),
    });
    const beforeBody = before.json<{
      conversation: { createdAt: string; agentId: string; title: string };
      messages: Array<{ id: string; content: unknown; createdAt: string }>;
    }>();

    const res = await rename(id, { title: '  会议 ✨  ', agentId: 'agt_other', id: 'conv_x' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      id,
      agentId: agent.id,
      title: '会议 ✨',
      createdAt: beforeBody.conversation.createdAt,
    });

    const row = await repo.chat.getConversation(app.db, id);
    expect(row?.agentId).toBe(agent.id);
    expect(row?.title).toBe('会议 ✨');

    const after = await inject(app, {
      method: 'GET',
      url: `/api/conversations/${id}`,
      headers: auth(),
    });
    const afterBody = after.json<typeof beforeBody>();
    expect(afterBody.conversation).toEqual({
      ...beforeBody.conversation,
      title: '会议 ✨',
    });
    expect(afterBody.messages).toEqual([
      {
        id: message.id,
        conversationId: id,
        role: 'user',
        content: { type: 'text', text: '保留我' },
        runId: null,
        createdAt: beforeBody.messages[0]?.createdAt,
      },
    ]);

    const list = await inject(app, {
      method: 'GET',
      url: `/api/conversations?agentId=${agent.id}`,
      headers: auth(),
    });
    const item = list
      .json<Array<{ id: string; title: string; createdAt: string; lastMessage: unknown }>>()
      .find((entry) => entry.id === id);
    expect(item).toMatchObject({ title: '会议 ✨', createdAt: beforeBody.conversation.createdAt });
    expect(item?.lastMessage).toEqual({
      role: 'user',
      text: '保留我',
      createdAt: expect.any(String),
    });

    const runCount = await app.pool.query<{ count: string }>(
      'select count(*) from agent_runs where conversation_id = $1',
      [id],
    );
    expect(runCount.rows[0]?.count).toBe('0');

    const audit = await app.pool.query<{ action: string; input_digest: string | null }>(
      "select action, input_digest from audit_log where action = 'conversation.renamed' and target = $1",
      [id],
    );
    expect(audit.rows).toHaveLength(1);
    // 审计只记字段名，不落标题原文。
    expect(audit.rows[0]?.input_digest).toBe(
      createHash('sha256')
        .update(JSON.stringify({ fields: ['title'] }))
        .digest('hex')
        .slice(0, 32),
    );
  });

  it('returns per-run metrics for every message that belongs to a run', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id, '读数');
    const run = await repo.chat.createRun(app.db, {
      id: newId('run'),
      conversationId: id,
      agentId: agent.id,
    });
    await repo.chat.updateRun(app.db, run.id, {
      status: 'succeeded',
      endedAt: new Date('2026-10-22T00:00:10.000Z'),
      latencyMs: 2400,
      turns: 3,
      costUsd: '0.0250',
    });
    await app.pool.query(
      'update agent_runs set input_tokens = 120, output_tokens = 80 where id = $1',
      [run.id],
    );
    for (const [role, content] of [
      ['user', { type: 'text', text: '问题' }],
      ['assistant', { type: 'text', text: '回答' }],
    ] as const) {
      await repo.chat.appendMessage(app.db, {
        id: newId('message'),
        conversationId: id,
        role,
        content,
        runId: run.id,
      });
    }
    // 没有 run 的旧消息不该编造读数。
    await repo.chat.appendMessage(app.db, {
      id: newId('message'),
      conversationId: id,
      role: 'user',
      content: { type: 'text', text: '单独一条' },
    });

    const body = (
      await inject(app, {
        method: 'GET',
        url: `/api/conversations/${id}`,
        headers: auth(),
      })
    ).json<{ runMetrics: unknown[] }>();
    expect(body.runMetrics).toEqual([
      {
        runId: run.id,
        status: 'succeeded',
        turns: 3,
        durationMs: 2400,
        tokens: 200,
        costUsd: 0.025,
        error: null,
        endedAt: '2026-10-22T00:00:10.000Z',
      },
    ]);
  });

  it('overwrites the title on repeat rename and repo returns null for unknown ids', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id, 'first');
    expect((await rename(id, { title: 'second' })).statusCode).toBe(200);
    expect((await rename(id, { title: 'third' })).statusCode).toBe(200);
    expect((await repo.chat.getConversation(app.db, id))?.title).toBe('third');
    expect(await repo.chat.getConversation(app.db, 'conv_missing')).toBeNull();
  });

  it('requires auth to delete', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    expectProblem(await remove(id, {}), 'UNAUTHORIZED');
    expect(await repo.chat.getConversation(app.db, id)).not.toBeNull();
  });

  it('returns 404 when deleting an unknown conversation', async () => {
    expectProblem(await remove('conv_missing'), 'CONVERSATION_NOT_FOUND');
  });

  it('deletes the conversation with its messages and runs', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id, '待删除');
    const message = await repo.chat.appendMessage(app.db, {
      id: newId('message'),
      conversationId: id,
      role: 'user',
      content: { type: 'text', text: '也会被删除' },
    });
    const run = await repo.chat.createRun(app.db, {
      id: newId('run'),
      conversationId: id,
      agentId: agent.id,
    });
    // 终态 run 不阻塞删除，同时验证删除会级联带走运行记录。
    await repo.chat.updateRun(app.db, run.id, { status: 'cancelled', endedAt: new Date() });

    const res = await remove(id);
    expect(res.statusCode, res.body).toBe(204);
    expect(await repo.chat.getConversation(app.db, id)).toBeNull();

    const leftovers = await app.pool.query<{ messages: string; runs: string }>(
      `select
        (select count(*) from messages where id = $1) as messages,
        (select count(*) from agent_runs where id = $2) as runs`,
      [message.id, run.id],
    );
    expect(leftovers.rows[0]).toEqual({ messages: '0', runs: '0' });

    const audit = await app.pool.query<{ action: string }>(
      "select action from audit_log where action = 'conversation.deleted' and target = $1",
      [id],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('rejects deleting a conversation with a queued run and keeps both rows', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    const run = await repo.chat.createRun(app.db, {
      id: newId('run'),
      conversationId: id,
      agentId: agent.id,
    });

    expectProblem(await remove(id), 'CONFLICT');
    expect(await repo.chat.getConversation(app.db, id)).not.toBeNull();
    expect(await repo.chat.getRun(app.db, run.id)).not.toBeNull();
  });

  it('keeps forked children when the parent is deleted', async () => {
    const agent = await newAgent();
    const parentId = await newConversation(agent.id, '父会话');
    await repo.chat.appendMessage(app.db, {
      id: newId('message'),
      conversationId: parentId,
      role: 'user',
      content: { type: 'text', text: '分支点' },
    });
    const branched = await repo.chat.branchConversation(app.db, {
      id: newId('conversation'),
      conversationId: parentId,
    });
    if (!branched) throw new Error('branchConversation returned null');
    const childId = branched.conversation.id;
    conversationIds.push(childId);

    expect((await remove(parentId)).statusCode).toBe(204);
    expect(await repo.chat.getConversation(app.db, parentId)).toBeNull();
    expect((await repo.chat.getConversation(app.db, childId))?.parentId).toBeNull();
  });
});
