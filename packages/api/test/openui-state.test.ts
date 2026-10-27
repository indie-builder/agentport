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

// 直接写 repo：不经过 /api/chat，避免依赖 worker 空闲。
const ready = await infraReady;

/** 归属读取只可能是 select messages 或 select conversations。 */
const ownershipRead = /^\s*select\b[\s\S]*\bfrom\s+"?(?:messages|conversations)"?\b/i;

function countOwnershipReads(sql: string[]): number {
  return sql.filter((text) => ownershipRead.test(text)).length;
}

/**
 * 直通真实 pool.query：drizzle 的 node-postgres 会话最终也调用它，
 * 因此能同时看到 repo 的 select/update 与 direct pool 查询。恢复必须放 finally。
 */
function spyPoolQueries(app: FastifyInstance): { sql: string[]; restore: () => void } {
  const sql: string[] = [];
  const original = app.pool.query;
  app.pool.query = ((...args: unknown[]) => {
    const first = args[0];
    sql.push(
      typeof first === 'string'
        ? first
        : first !== null && typeof first === 'object' && 'text' in first
          ? String((first as { text: unknown }).text)
          : '',
    );
    return (original as (...inner: unknown[]) => unknown).apply(app.pool, args);
  }) as typeof app.pool.query;
  return {
    sql,
    restore: () => {
      app.pool.query = original;
    },
  };
}

/** n 个独立 OpenUI 段；blockKey 只按 UI 段计数（s0、s1…），Markdown 不占号。 */
function uiText(segments: number): string {
  return Array.from(
    { length: segments },
    (_unused, index) => `第 ${index} 段\n\n\`\`\`openui-lang\nroot = Card([])\n\`\`\``,
  ).join('\n\n');
}

describe.skipIf(!ready)('openui state', () => {
  let app: FastifyInstance;
  let cookie: string;
  const agentSlugs: string[] = [];
  const conversationIds: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    if (conversationIds.length > 0) {
      await app.pool.query('delete from audit_log where target = any($1::text[])', [
        conversationIds,
      ]);
    }
    await cleanup(app, { agentSlugs });
    await app.close();
  });

  const auth = () => ({ cookie });

  const seed = async (
    options: {
      role?: 'assistant' | 'user';
      uiFormat?: 'markdown' | 'openui';
      /** 真实 UI 段数量；状态键只能是这些段对应的 s0…sN。 */
      segments?: number;
      parentToolUseId?: string;
      /** 落库的合并程序；缺省回退到原始文本。 */
      uiProgram?: string | null;
    } = {},
  ) => {
    const agent = (
      await createAgent(app, cookie, { slug: unique('oui-state'), track: agentSlugs })
    ).json<Agent>();
    const conversationId = newId('conversation');
    await repo.chat.createConversation(app.db, {
      id: conversationId,
      agentId: agent.id,
      title: 'openui state',
    });
    conversationIds.push(conversationId);
    const content = {
      type: 'text',
      text: uiText(options.segments ?? 2),
      ...(options.parentToolUseId === undefined
        ? {}
        : { parentToolUseId: options.parentToolUseId }),
    };
    const message = await repo.chat.appendMessage(app.db, {
      id: newId('message'),
      conversationId,
      role: options.role ?? 'assistant',
      content,
    });
    // 状态只挂在生成式 UI 的助手消息上；appendMessage 不暴露这两个渲染字段，夹具直接补齐。
    await app.pool.query('update messages set ui_format = $2, ui_program = $3 where id = $1', [
      message.id,
      options.uiFormat ?? 'openui',
      options.uiProgram ?? null,
    ]);
    return { agent, conversationId, messageId: message.id };
  };

  const put = (conversationId: string, messageId: string, payload: unknown) =>
    inject(app, {
      method: 'PUT',
      url: `/api/conversations/${conversationId}/messages/${messageId}/openui-state`,
      headers: auth(),
      payload: payload as Record<string, unknown>,
    });

  const savedState = async (messageId: string): Promise<unknown> => {
    const res = await app.pool.query<{ ui_state: unknown }>(
      'select ui_state from messages where id = $1',
      [messageId],
    );
    return res.rows[0]?.ui_state;
  };

  it('requires auth', async () => {
    const { conversationId, messageId } = await seed();
    const res = await inject(app, {
      method: 'PUT',
      url: `/api/conversations/${conversationId}/messages/${messageId}/openui-state`,
      payload: { blockKey: 's0', state: { name: 'x' } },
    });
    expectProblem(res, 'UNAUTHORIZED');
  });

  it('returns CONVERSATION_NOT_FOUND for an unknown conversation', async () => {
    const { messageId } = await seed();
    const spy = spyPoolQueries(app);
    try {
      expectProblem(
        await put('conv_missing', messageId, { blockKey: 's0', state: { a: 1 } }),
        'CONVERSATION_NOT_FOUND',
      );
      // 错误路径最多两次归属读取：消息未命中后再查会话。
      expect(countOwnershipReads(spy.sql)).toBeGreaterThan(0);
      expect(countOwnershipReads(spy.sql)).toBeLessThanOrEqual(2);
    } finally {
      spy.restore();
    }
  });

  it('rejects a message that belongs to another conversation', async () => {
    const first = await seed();
    const second = await seed();
    const spy = spyPoolQueries(app);
    try {
      expectProblem(
        await put(first.conversationId, second.messageId, { blockKey: 's0', state: { a: 1 } }),
        'NOT_FOUND',
      );
      expect(countOwnershipReads(spy.sql)).toBeGreaterThan(0);
      expect(countOwnershipReads(spy.sql)).toBeLessThanOrEqual(2);
    } finally {
      spy.restore();
    }
    expect(await savedState(second.messageId)).toBeNull();
  });

  it('rejects a message that is not an openui assistant message', async () => {
    const user = await seed({ role: 'user' });
    expectProblem(
      await put(user.conversationId, user.messageId, { blockKey: 's0', state: { a: 1 } }),
      'INVALID_INPUT',
    );
    const markdown = await seed({ uiFormat: 'markdown' });
    expectProblem(
      await put(markdown.conversationId, markdown.messageId, { blockKey: 's0', state: { a: 1 } }),
      'INVALID_INPUT',
    );
  });

  it('rejects a message produced inside a sub-agent', async () => {
    // 子智能体的文本不是主助手回复：没有可恢复的顶层界面。
    const child = await seed({ parentToolUseId: 'toolu_parent' });
    const res = await put(child.conversationId, child.messageId, {
      blockKey: 's0',
      state: { a: 1 },
    });
    expectProblem(res, 'FORBIDDEN');
    expect(await savedState(child.messageId)).toBeNull();
  });

  it('rejects a message whose text has no UI segment', async () => {
    const plain = await seed({ segments: 0 });
    expectProblem(
      await put(plain.conversationId, plain.messageId, { blockKey: 's0', state: { a: 1 } }),
      'INVALID_INPUT',
    );
    expect(await savedState(plain.messageId)).toBeNull();
  });

  it('only accepts the blockKey of a real UI segment', async () => {
    const { conversationId, messageId } = await seed({ segments: 2 });
    // 任意自造键、越界段号都不存在；只能是 s0 / s1。
    for (const blockKey of ['b1', 'msg_1:0', 's2', 's-1', 'S0']) {
      expectProblem(
        await put(conversationId, messageId, { blockKey, state: { a: 1 } }),
        'INVALID_INPUT',
      );
    }
    expect(await savedState(messageId)).toBeNull();
  });

  it('uses the stored program instead of the raw text when deciding segments', async () => {
    // 合并后的程序只有一段，原文有两段：以落库快照为准，s1 不存在。
    const { conversationId, messageId } = await seed({
      segments: 2,
      uiProgram: uiText(1),
    });
    expectProblem(
      await put(conversationId, messageId, { blockKey: 's1', state: { a: 1 } }),
      'INVALID_INPUT',
    );
    expect(
      (await put(conversationId, messageId, { blockKey: 's0', state: { a: 1 } })).statusCode,
    ).toBe(200);
  });

  it.each([
    ['missing blockKey', { state: { a: 1 } }],
    ['missing state', { blockKey: 's0' }],
    ['state is an array', { blockKey: 's0', state: [1, 2] }],
    ['state is a scalar', { blockKey: 's0', state: 'text' }],
    ['blockKey is empty', { blockKey: '', state: { a: 1 } }],
  ])('rejects %s with 400', async (_label, payload) => {
    const { conversationId, messageId } = await seed();
    expectProblem(await put(conversationId, messageId, payload), 'INVALID_INPUT');
  });

  it('saves a state after a single ownership read', async () => {
    const { conversationId, messageId } = await seed();

    // 旧实现先 getConversation 再 getMessageInConversation：同一判据下命中 2 条。
    expect(
      countOwnershipReads([
        'select "id" from "conversations" where "id" = $1 limit $2',
        'select "id" from "messages" where "id" = $1 and "conversation_id" = $2 limit $3',
      ]),
    ).toBe(2);

    const spy = spyPoolQueries(app);
    try {
      const res = await put(conversationId, messageId, { blockKey: 's0', state: { a: 1 } });
      expect(res.statusCode, res.body).toBe(200);
      // 命中路径只查一次消息归属，不再先 getConversation。
      expect(countOwnershipReads(spy.sql)).toBe(1);
      // 正对照：spy 确实抓到了后续写入，不是恒 0 的空抓取。
      expect(spy.sql.some((text) => /^\s*update\s+"?messages"?/i.test(text))).toBe(true);
      expect(spy.sql.some((text) => /^\s*insert\s+into\s+"?audit_log"?/i.test(text))).toBe(true);
    } finally {
      spy.restore();
    }

    expect(await savedState(messageId)).toEqual({ version: 1, blocks: { s0: { a: 1 } } });
    const audit = await app.pool.query(
      "select 1 from audit_log where action = 'openui.state.saved' and target = $1",
      [messageId],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('persists a state envelope and merges blocks instead of overwriting', async () => {
    const { conversationId, messageId } = await seed({ segments: 2 });

    const first = await put(conversationId, messageId, {
      blockKey: 's0',
      state: { title: 'hello' },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(await savedState(messageId)).toEqual({
      version: 1,
      blocks: { s0: { title: 'hello' } },
    });

    const second = await put(conversationId, messageId, { blockKey: 's1', state: { count: 3 } });
    expect(second.statusCode, second.body).toBe(200);
    expect(await savedState(messageId)).toEqual({
      version: 1,
      blocks: { s0: { title: 'hello' }, s1: { count: 3 } },
    });
  });

  it('overwrites only the same blockKey', async () => {
    const { conversationId, messageId } = await seed({ segments: 2 });
    await put(conversationId, messageId, { blockKey: 's0', state: { v: 1 } });
    await put(conversationId, messageId, { blockKey: 's0', state: { v: 2 } });
    await put(conversationId, messageId, { blockKey: 's1', state: { v: 9 } });
    expect(await savedState(messageId)).toEqual({
      version: 1,
      blocks: { s0: { v: 2 }, s1: { v: 9 } },
    });
  });

  it('keeps both blocks when different blockKeys are written concurrently', async () => {
    // 两个请求都先读到同一份旧快照；读改写实现会让后到的覆盖先到的。
    const { conversationId, messageId } = await seed({ segments: 8 });
    await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        put(conversationId, messageId, { blockKey: `s${index}`, state: { v: index } }),
      ),
    );
    const saved = (await savedState(messageId)) as { blocks: Record<string, unknown> };
    expect(Object.keys(saved.blocks).sort()).toEqual(
      Array.from({ length: 8 }, (_unused, index) => `s${index}`).sort(),
    );
  });

  it('replaces an invalid stored envelope instead of leaking it', async () => {
    const { conversationId, messageId } = await seed();
    // 历史版本/手工写入的脏数据：形状不符时按空快照重来，不把原文回给前端。
    await app.pool.query('update messages set ui_state = $2::jsonb where id = $1', [
      messageId,
      JSON.stringify({ version: 2, blocks: ['nope'] }),
    ]);
    const res = await put(conversationId, messageId, { blockKey: 's0', state: { a: 1 } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await savedState(messageId)).toEqual({ version: 1, blocks: { s0: { a: 1 } } });
  });

  it('rejects a block over 64KB with 413 instead of truncating', async () => {
    const { conversationId, messageId } = await seed();
    const big = { blob: 'x'.repeat(64 * 1024) };
    const res = await put(conversationId, messageId, { blockKey: 's0', state: big });
    expectProblem(res, 'PAYLOAD_TOO_LARGE');
    expect(await savedState(messageId)).toBeNull();
  });

  it('writes an audit row naming the block, not its values', async () => {
    const { conversationId, messageId } = await seed();
    await put(conversationId, messageId, { blockKey: 's1', state: { secret: 'pii' } });
    const res = await app.pool.query<{ input_digest: string | null }>(
      "select input_digest from audit_log where action = 'openui.state.saved' and target = $1",
      [messageId],
    );
    expect(res.rows).toHaveLength(1);
    // 只存摘要：原文（含用户输入）不进审计表。
    expect(res.rows[0]?.input_digest).not.toBeNull();
  });
});
