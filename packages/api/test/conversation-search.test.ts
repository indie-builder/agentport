import { newId, repo } from '@agentport/db';
import type { Agent, ConversationSearchResponse } from '@agentport/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
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

const ready = await infraReady;

describe.skipIf(!ready)('conversation search', () => {
  let app: FastifyInstance;
  let cookie: string;
  const agentSlugs: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs });
    await app.close();
  });

  const auth = () => ({ cookie });

  const newAgent = async (): Promise<Agent> =>
    (
      await createAgent(app, cookie, { slug: unique('search-agent'), track: agentSlugs })
    ).json<Agent>();

  const newConversation = async (agentId: string, title = '') => {
    const id = newId('conversation');
    await repo.chat.createConversation(app.db, { id, agentId, title });
    return id;
  };

  const addMessage = async (
    conversationId: string,
    role: 'user' | 'assistant' | 'tool',
    content: unknown,
    createdAt = new Date(),
  ): Promise<void> => {
    await app.pool.query(
      'insert into messages (id, conversation_id, role, content, created_at) values ($1, $2, $3, $4, $5)',
      [newId('message'), conversationId, role, JSON.stringify(content), createdAt],
    );
  };

  const search = (
    query: Record<string, string | number | undefined>,
    headers: Record<string, string> = auth(),
  ) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    return inject(app, {
      method: 'GET',
      url: `/api/conversations/search?${params.toString()}`,
      headers,
    } satisfies InjectOptions);
  };

  const item = (body: ConversationSearchResponse) => body.items[0];

  it('requires auth', async () => {
    expectProblem(await search({}, {}), 'UNAUTHORIZED');
  });

  it('rejects invalid parameters with the shared INVALID_INPUT problem', async () => {
    expectProblem(await search({ q: 'a'.repeat(201) }), 'INVALID_INPUT');
    for (const limit of ['0', '51', '2.5', 'nope']) {
      expectProblem(await search({ limit }), 'INVALID_INPUT');
    }
    expectProblem(await search({ before: 'not-a-cursor' }), 'INVALID_INPUT');
  });

  it('accepts the parameter boundaries', async () => {
    expect((await search({ q: 'a'.repeat(200), limit: 50 })).statusCode).toBe(200);
    expect((await search({ q: '进', limit: 1 })).statusCode).toBe(200);
  });

  it('returns recent conversations with a null match for a blank query', async () => {
    const agent = await newAgent();
    const oldest = await newConversation(agent.id, '最旧');
    const middle = await newConversation(agent.id, '中间');
    const newest = await newConversation(agent.id, '最新');
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    await addMessage(oldest, 'user', { type: 'text', text: 'a' }, new Date(base));
    await addMessage(middle, 'user', { type: 'text', text: 'b' }, new Date(base + 1_000));
    await addMessage(newest, 'assistant', { type: 'text', text: 'c' }, new Date(base + 2_000));

    const body = (await search({ agentId: agent.id, q: '   ' })).json<ConversationSearchResponse>();
    expect(body.items.map((entry) => entry.id)).toEqual([newest, middle, oldest]);
    expect(body.items[0]).toMatchObject({
      agentId: agent.id,
      agentName: agent.name,
      title: '最新',
      updatedAt: '2026-01-01T00:00:02.000Z',
      match: null,
    });
    expect(body.nextBefore).toBeNull();
  });

  it('matches id, title and message in that priority order', async () => {
    const agent = await newAgent();
    const byId = await newConversation(agent.id, 'plain title');
    const idToken = byId.slice(-8).toUpperCase();

    const byTitle = await newConversation(agent.id, 'Quarterly REPORT');
    await addMessage(byTitle, 'user', { type: 'text', text: 'unrelated body' });

    const byMessage = await newConversation(agent.id, 'nothing');
    await addMessage(byMessage, 'assistant', { type: 'text', text: 'Deploy READY now' });

    const bothTitleAndMessage = await newConversation(agent.id, 'PriorityToken 出现在标题');
    await addMessage(bothTitleAndMessage, 'user', {
      type: 'text',
      text: 'PriorityToken 也出现在正文',
    });

    const idHit = item((await search({ agentId: agent.id, q: idToken })).json());
    expect(idHit).toMatchObject({ id: byId, match: { kind: 'id', excerpt: null } });

    const titleHit = item((await search({ agentId: agent.id, q: 'quarterly report' })).json());
    expect(titleHit).toMatchObject({ id: byTitle, match: { kind: 'title', excerpt: null } });

    const messageHit = item((await search({ agentId: agent.id, q: 'ready' })).json());
    expect(messageHit).toMatchObject({ id: byMessage, match: { kind: 'message' } });
    expect(messageHit?.match?.excerpt).toContain('Deploy READY now');

    const titlePriority = item((await search({ agentId: agent.id, q: 'prioritytoken' })).json());
    expect(titlePriority).toMatchObject({ id: bothTitleAndMessage, match: { kind: 'title' } });
  });

  it('searches text blocks in arrays and single Chinese characters', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id, '数组会话');
    await addMessage(id, 'user', [
      { type: 'text', text: '数组里的关键字 Zebra' },
      { type: 'openui_action', params: { secret: 'Zebra 只存在于动作参数' } },
    ]);

    const hit = item((await search({ agentId: agent.id, q: 'ZEBRA' })).json());
    expect(hit).toMatchObject({ id, match: { kind: 'message' } });
    expect(hit?.match?.excerpt).toContain('数组里的关键字 Zebra');

    const chinese = await newConversation(agent.id, '中文');
    await addMessage(chinese, 'assistant', { type: 'text', text: '项目进度更新完成' });
    expect(item((await search({ agentId: agent.id, q: '进' })).json())).toMatchObject({
      id: chinese,
      match: { kind: 'message' },
    });
  });

  it('treats % and _ as literal characters', async () => {
    const agent = await newAgent();
    const percent = await newConversation(agent.id, '100%_done');
    const plain = await newConversation(agent.id, '100xydone');

    const body = (await search({ agentId: agent.id, q: '%_' })).json<ConversationSearchResponse>();
    expect(body.items.map((entry) => entry.id)).toEqual([percent]);
    expect(body.items[0]?.match).toEqual({ kind: 'title', excerpt: null });

    const single = (await search({ agentId: agent.id, q: '%' })).json<ConversationSearchResponse>();
    expect(single.items.map((entry) => entry.id)).toEqual([percent]);
    expect(single.items.map((entry) => entry.id)).not.toContain(plain);
  });

  it('ignores tool rows, attachment metadata and action context/formState', async () => {
    const agent = await newAgent();
    const hidden = await newConversation(agent.id, '只含元数据');

    await addMessage(hidden, 'tool', { type: 'text', text: 'ToolToken' });
    await addMessage(hidden, 'assistant', { type: 'tool_result', text: 'NonTextToken' });
    await addMessage(hidden, 'user', {
      type: 'text',
      text: 'hello',
      attachments: [{ id: 'att_1', filename: 'AttachToken.txt', mimeType: 'text/plain', size: 1 }],
    });
    await addMessage(hidden, 'user', [
      { type: 'text', text: 'visible body' },
      {
        type: 'openui_action',
        params: { secret: 'ContextToken' },
        context: { secret: 'ContextToken' },
        formState: { secret: 'ContextToken' },
      },
    ]);
    await addMessage(hidden, 'assistant', {
      type: 'text',
      text: 'VisibleMatchToken is searchable',
    });

    for (const q of ['ToolToken', 'NonTextToken', 'AttachToken', 'ContextToken']) {
      expect(
        (await search({ agentId: agent.id, q })).json<ConversationSearchResponse>().items,
      ).toEqual([]);
    }
    expect(
      (
        await search({ agentId: agent.id, q: 'VisibleMatchToken' })
      ).json<ConversationSearchResponse>().items,
    ).toHaveLength(1);
  });

  it('returns one item per conversation with the newest matching excerpt, capped at 240 chars', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id, 'dedupe');
    const base = Date.parse('2026-02-01T00:00:00.000Z');
    await addMessage(
      id,
      'assistant',
      { type: 'text', text: 'DedupeToken old body' },
      new Date(base),
    );
    await addMessage(
      id,
      'assistant',
      { type: 'text', text: `DedupeToken ${'x'.repeat(300)}` },
      new Date(base + 1_000),
    );

    const body = (await search({ agentId: agent.id, q: 'dedupetoken' })).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.match?.excerpt).toContain('DedupeToken');
    expect(body.items[0]?.match?.excerpt).toContain('x'.repeat(100));
    expect(body.items[0]?.match?.excerpt).not.toContain('old body');
    expect(body.items[0]?.match?.excerpt.length).toBe(240);
  });

  it('keeps sub-millisecond activity times exact across pages', async () => {
    const agent = await newAgent();
    const token = unique('micro-token');
    const stamps = ['123900', '123800', '123100', '123000'];
    const ids: string[] = [];
    for (const [index, fraction] of stamps.entries()) {
      const id = await newConversation(agent.id, `micro ${index}`);
      await app.pool.query(
        'insert into messages (id, conversation_id, role, content, created_at) values ($1, $2, $3, $4, $5::timestamptz)',
        [
          newId('message'),
          id,
          'user',
          JSON.stringify({ type: 'text', text: `${token} ${index}` }),
          `2026-04-01 00:00:00.${fraction}+00`,
        ],
      );
      ids.push(id);
    }

    const first = (
      await search({ agentId: agent.id, q: token, limit: 2 })
    ).json<ConversationSearchResponse>();
    expect(first.items.map((entry) => entry.id)).toEqual(ids.slice(0, 2));
    expect(first.nextBefore).toEqual(expect.any(String));

    const second = (
      await search({
        agentId: agent.id,
        q: token,
        limit: 2,
        before: first.nextBefore ?? undefined,
      })
    ).json<ConversationSearchResponse>();
    expect(second.items.map((entry) => entry.id)).toEqual(ids.slice(2));
    expect(second.nextBefore).toBeNull();
  });

  it('centers the excerpt on the newest match past the first 240 characters', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id, '窗口');
    const base = Date.parse('2026-05-01T00:00:00.000Z');
    await addMessage(
      id,
      'assistant',
      { type: 'text', text: 'WindowToken starts the old body' },
      new Date(base),
    );
    await addMessage(
      id,
      'assistant',
      { type: 'text', text: `${'x'.repeat(300)} WindowToken after the long prefix` },
      new Date(base + 1_000),
    );

    const hit = item((await search({ agentId: agent.id, q: 'windowtoken' })).json());
    expect(hit?.match?.kind).toBe('message');
    expect(hit?.match?.excerpt).toContain('WindowToken');
    expect(hit?.match?.excerpt).not.toContain('old body');
    expect(hit?.match?.excerpt?.length ?? 0).toBeLessThanOrEqual(240);
  });

  it('matches spaced queries and Chinese words in whitespace-normalized text', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id, '空白与中文');
    await addMessage(id, 'assistant', {
      type: 'text',
      text: `${'长'.repeat(300)}\n\t关键词   出现\t在这里`,
    });

    const hit = item((await search({ agentId: agent.id, q: '关键词\t出现' })).json());
    expect(hit).toMatchObject({ id, match: { kind: 'message' } });
    expect(hit?.match?.excerpt).toContain('关键词 出现');
    expect(hit?.match?.excerpt?.length ?? 0).toBeLessThanOrEqual(240);
  });

  it('maps non-breaking spaces to ordinary spaces in body and query', async () => {
    const agent = await newAgent();
    const bodyNbsp = await newConversation(agent.id, 'nbsp body');
    await addMessage(bodyNbsp, 'assistant', {
      type: 'text',
      text: 'before alpha\u00A0beta after',
    });

    const bodyHit = item((await search({ agentId: agent.id, q: 'alpha beta' })).json());
    expect(bodyHit).toMatchObject({ id: bodyNbsp, match: { kind: 'message' } });
    expect(bodyHit?.match?.excerpt).toContain('alpha beta');

    const queryNbsp = await newConversation(agent.id, 'nbsp query');
    await addMessage(queryNbsp, 'assistant', {
      type: 'text',
      text: 'before gamma delta after',
    });

    const queryHit = item((await search({ agentId: agent.id, q: 'gamma\u00A0delta' })).json());
    expect(queryHit).toMatchObject({ id: queryNbsp, match: { kind: 'message' } });
    expect(queryHit?.match?.excerpt).toContain('gamma delta');
  });

  it('classifies title hits with the same lower rule as the filter', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id, 'İstanbul');

    const hit = item((await search({ agentId: agent.id, q: 'istanbul' })).json());
    expect(hit).toMatchObject({ id, match: { kind: 'title', excerpt: null } });
  });

  it('filters by agentId', async () => {
    const first = await newAgent();
    const second = await newAgent();
    const token = unique('agent-filter');
    const firstConversation = await newConversation(first.id, token);
    const secondConversation = await newConversation(second.id, token);

    const filtered = (
      await search({ agentId: first.id, q: token })
    ).json<ConversationSearchResponse>();
    expect(filtered.items.map((entry) => entry.id)).toEqual([firstConversation]);

    const unfiltered = (await search({ q: token })).json<ConversationSearchResponse>();
    expect(unfiltered.items.map((entry) => entry.id).sort()).toEqual(
      [firstConversation, secondConversation].sort(),
    );
  });

  it('matches the whole database before paginating past 50 conversations', async () => {
    const agent = await newAgent();
    const token = unique('page-token');
    const base = Date.parse('2026-03-01T00:00:00.000Z');
    const ids: string[] = [];
    for (let index = 0; index < 55; index += 1) {
      const id = await newConversation(agent.id, `page ${index}`);
      await addMessage(
        id,
        'user',
        { type: 'text', text: `${token} conversation ${index}` },
        new Date(base - index * 1_000),
      );
      ids.push(id);
    }

    const started = performance.now();
    const first = (
      await search({ agentId: agent.id, q: token, limit: 50 })
    ).json<ConversationSearchResponse>();
    const elapsedMs = performance.now() - started;

    expect(first.items).toHaveLength(50);
    expect(first.items.map((entry) => entry.id)).toEqual(ids.slice(0, 50));
    expect(first.items.every((entry) => entry.match?.kind === 'message')).toBe(true);
    expect(first.nextBefore).toEqual(expect.any(String));
    // 小型代表性数据：只约束上限，真实耗时写进测试输出供报告引用。
    expect(elapsedMs).toBeLessThan(2_000);
    console.log(`conversation search first page over 55 matches: ${elapsedMs.toFixed(1)}ms`);

    const second = (
      await search({
        agentId: agent.id,
        q: token,
        limit: 50,
        before: first.nextBefore ?? undefined,
      })
    ).json<ConversationSearchResponse>();
    expect(second.items.map((entry) => entry.id)).toEqual(ids.slice(50));
    expect(second.nextBefore).toBeNull();

    const seen = new Set([...first.items, ...second.items].map((entry) => entry.id));
    expect(seen.size).toBe(55);
  });
});
