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

// fixture 直接写 repo / messages 表：不产生 queued run，不需要空闲 worker。
const ready = await infraReady;

/** 所有消息共用同一个 created_at，(created_at, id) 的次级排序决定顺序。 */
const TIES = new Date('2026-10-22T00:00:00.000Z');

interface HistoryBody {
  conversation: { id: string; createdAt: string };
  messages: Array<{ id: string; role: string; content: unknown; createdAt: string }>;
  nextBefore: string | null;
}

describe.skipIf(!ready)('chat history pagination', () => {
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

  const newConversation = async (count: number) => {
    const agent = (
      await createAgent(app, cookie, { slug: unique('history-agent'), track: agentSlugs })
    ).json<Agent>();
    const id = newId('conversation');
    await repo.chat.createConversation(app.db, { id, agentId: agent.id, title: '分页' });
    conversationIds.push(id);
    // id 带会话前缀：全局唯一，且同一会话内按序号字典序排列。
    const ids = Array.from(
      { length: count },
      (_, index) => `${id}_m${index.toString().padStart(3, '0')}`,
    );
    for (const [index, messageId] of ids.entries()) {
      await app.pool.query(
        'insert into messages (id, conversation_id, role, content, created_at) values ($1, $2, $3, $4, $5)',
        [
          messageId,
          id,
          index % 2 === 0 ? 'user' : 'assistant',
          JSON.stringify({ type: 'text', text: `第 ${index} 条` }),
          TIES,
        ],
      );
    }
    return { id, ids };
  };

  const getPage = (id: string, query = '') =>
    inject(app, {
      method: 'GET',
      url: `/api/conversations/${id}${query === '' ? '' : `?${query}`}`,
      headers: auth(),
    });

  it('defaults to the latest 50 messages and continues backwards without overlap', async () => {
    const { id, ids } = await newConversation(52);

    const first = await getPage(id);
    expect(first.statusCode, first.body).toBe(200);
    const firstBody = first.json<HistoryBody>();
    expect(firstBody.messages.map((message) => message.id)).toEqual(ids.slice(2));
    expect(firstBody.nextBefore).toBe(ids[2]);
    expect(firstBody.conversation.id).toBe(id);
    expect(typeof firstBody.conversation.createdAt).toBe('string');
    expect(firstBody.messages.every((message) => typeof message.createdAt === 'string')).toBe(true);

    const second = await getPage(id, `before=${encodeURIComponent(firstBody.nextBefore ?? '')}`);
    expect(second.statusCode, second.body).toBe(200);
    const secondBody = second.json<HistoryBody>();
    expect(secondBody.messages.map((message) => message.id)).toEqual(ids.slice(0, 2));
    expect(secondBody.nextBefore).toBeNull();

    expect([...secondBody.messages, ...firstBody.messages].map((message) => message.id)).toEqual(
      ids,
    );
  });

  it('walks 125 messages in pages of 50 with full coverage', async () => {
    const { id, ids } = await newConversation(125);

    const collected: string[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const res = await getPage(
        id,
        `limit=50${before === null ? '' : `&before=${encodeURIComponent(before)}`}`,
      );
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<HistoryBody>();
      expect(body.messages.length).toBeLessThanOrEqual(50);
      // 每页按正序返回；更早的页要拼在前面。
      collected.unshift(...body.messages.map((message) => message.id));
      before = body.nextBefore;
      pages += 1;
    } while (before !== null);

    expect(pages).toBe(3);
    expect(collected).toEqual(ids);
    expect(new Set(collected).size).toBe(125);
  });

  it('accepts limit=100 and returns the oldest page with a null cursor', async () => {
    const { id, ids } = await newConversation(125);

    const first = (await getPage(id, 'limit=100')).json<HistoryBody>();
    expect(first.messages.map((message) => message.id)).toEqual(ids.slice(25));
    expect(first.nextBefore).toBe(ids[25]);

    const second = (
      await getPage(id, `limit=100&before=${encodeURIComponent(first.nextBefore ?? '')}`)
    ).json<HistoryBody>();
    expect(second.messages.map((message) => message.id)).toEqual(ids.slice(0, 25));
    expect(second.nextBefore).toBeNull();
  });

  it.each(['0', '101', 'abc', '1.5'])('rejects limit=%s', async (limit) => {
    const { id } = await newConversation(1);
    const res = await getPage(id, `limit=${limit}`);
    expectProblem(res, 'INVALID_INPUT');
    expect(res.json()).not.toHaveProperty('messages');
  });

  it('returns an empty page with a null cursor for an empty conversation', async () => {
    const { id } = await newConversation(0);
    const body = (await getPage(id)).json<HistoryBody>();
    expect(body.messages).toEqual([]);
    expect(body.nextBefore).toBeNull();
  });

  it('treats the oldest message as a terminal cursor', async () => {
    const { id, ids } = await newConversation(3);
    const body = (
      await getPage(id, `before=${encodeURIComponent(ids[0] ?? '')}`)
    ).json<HistoryBody>();
    expect(body.messages).toEqual([]);
    expect(body.nextBefore).toBeNull();
  });

  it('rejects a foreign or unknown cursor without leaking messages', async () => {
    const mine = await newConversation(3);
    const other = await newConversation(2);

    for (const before of [other.ids[1] ?? '', 'msg_missing_cursor']) {
      const res = await getPage(mine.id, `before=${encodeURIComponent(before)}`);
      expectProblem(res, 'INVALID_INPUT');
      expect(res.json()).not.toHaveProperty('messages');
    }

    // 两条消息属于不同会话：用另一会话的 id 不能当游标。
    const swapped = await getPage(other.id, `before=${encodeURIComponent(mine.ids[0] ?? '')}`);
    expectProblem(swapped, 'INVALID_INPUT');
  });

  it('requires auth and 404s unknown conversations before validating the cursor', async () => {
    const { id } = await newConversation(2);

    const anonymous = await inject(app, {
      method: 'GET',
      url: `/api/conversations/${id}`,
      headers: {},
    });
    expectProblem(anonymous, 'UNAUTHORIZED');

    expectProblem(
      await getPage('conv_missing', 'before=msg_missing_cursor'),
      'CONVERSATION_NOT_FOUND',
    );
  });

  it('branches all 125 messages while leaving the original history unbounded', async () => {
    const { id, ids } = await newConversation(125);

    const res = await inject(app, {
      method: 'POST',
      url: `/api/conversations/${id}/branch`,
      headers: auth(),
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(201);
    const branchId = res.json<{ id: string }>().id;
    conversationIds.push(branchId);

    const copied = await repo.chat.listMessages(app.db, branchId);
    expect(copied).toHaveLength(125);
    const original = await repo.chat.listMessages(app.db, id);
    expect(original).toHaveLength(125);
    // 分支复制保留内容与时间；db 层不传 limit 时仍是整段历史。
    expect(copied.map(({ role, content, createdAt }) => ({ role, content, createdAt }))).toEqual(
      original.map(({ role, content, createdAt }) => ({ role, content, createdAt })),
    );

    const firstPage = (await getPage(id)).json<HistoryBody>();
    expect(firstPage.messages).toHaveLength(50);
    expect(firstPage.nextBefore).toBe(ids[75]);
  });
});
