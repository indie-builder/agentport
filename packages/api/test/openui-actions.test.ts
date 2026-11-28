import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { newId, repo } from '@agentport/db';
import type { Agent } from '@agentport/shared';
import { getQueue } from '../src/queue/producer.js';
import {
  ADMIN_BUSINESS_ID,
  cleanup,
  createAgent,
  expectProblem,
  infraReady,
  loginCookie,
  request,
  startApp,
  type TestApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

const uiSegment = (name: string) => `\`\`\`openui-lang\n${name} = Card([])\n\`\`\``;

describe.skipIf(!ready)('openui actions', () => {
  let app: TestApp;
  let cookie: string;
  const agentSlugs: string[] = [];
  const runIds: string[] = [];
  const conversationIds: string[] = [];
  const policyIds: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    for (const runId of runIds) {
      await getQueue()
        .getJob(runId)
        .then((job) => job?.remove())
        .catch(() => undefined);
    }
    for (const policyId of policyIds) {
      await request(app, {
        method: 'DELETE',
        url: `/api/security/policies/${policyId}`,
        headers: auth(),
      });
    }
    if (conversationIds.length > 0) {
      await app.client.unsafe('delete from audit_log where target = any($1::text[])', [
        app.client.array(conversationIds, 'TEXT'),
      ]);
    }
    await cleanup(app, { agentSlugs, runIds });
    await app.close();
  });

  const auth = () => ({ cookie });
  const newAgent = async (): Promise<Agent> =>
    (
      await createAgent(app, cookie, { slug: unique('oui-action'), track: agentSlugs })
    ).json<Agent>();

  const sourceMessage = async (
    agentId: string,
    options: {
      segments?: number;
      text?: string;
      uiFormat?: 'markdown' | 'openui';
      role?: 'assistant' | 'user';
      parentToolUseId?: string;
    } = {},
  ) => {
    const conversationId = newId('conversation');
    await repo.chat.createConversation(app.db, {
      id: conversationId,
      agentId,
      title: 'action source',
      subject: { kind: 'user', businessId: ADMIN_BUSINESS_ID },
    });
    conversationIds.push(conversationId);
    const segments = options.segments ?? 1;
    const text =
      options.text ??
      [
        '先看结论：',
        ...Array.from({ length: segments }, (_, index) => uiSegment(`root${index}`)),
        '补充说明。',
      ].join('\n');
    const message = await repo.chat.appendMessage(app.db, {
      id: newId('message'),
      conversationId,
      role: options.role ?? 'assistant',
      content: {
        type: 'text',
        text,
        ...(options.parentToolUseId === undefined
          ? {}
          : { parentToolUseId: options.parentToolUseId }),
      },
    });
    await app.client.unsafe('update messages set ui_format = $2, ui_program = $3 where id = $1', [
      message.id,
      options.uiFormat ?? 'openui',
      text,
    ]);
    return { conversationId, messageId: message.id };
  };

  const userMessages = (conversationId: string) =>
    app.client.unsafe<{ content: unknown }[]>(
      "select content from messages where conversation_id = $1 and role = 'user'",
      [conversationId],
    );

  it('stores the full action next to the user text', async () => {
    const agent = await newAgent();
    const source = await sourceMessage(agent.id);
    const params = { card: 'paris', filters: { nights: [2, 5], tags: ['art', 'food'] } };
    const res = await request(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: {
        agentId: agent.id,
        conversationId: source.conversationId,
        message: 'Plan a trip to Paris',
        openuiAction: {
          type: 'continue_conversation',
          message: 'Plan a trip to Paris',
          params,
          context: { card: 'paris', source: 'card' },
          formState: { budget: 2500, nested: { days: 3 } },
          formName: 'trip-planner',
          messageId: source.messageId,
          blockKey: 's0',
        },
      },
    });
    expect(res.statusCode, res.body).toBe(202);
    const body = res.json<{ runId: string; conversationId: string }>();
    runIds.push(body.runId);

    const rows = await userMessages(body.conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toEqual([
      { type: 'text', text: 'Plan a trip to Paris' },
      {
        type: 'openui_action',
        params,
        context: { card: 'paris', source: 'card' },
        formState: { budget: 2500, nested: { days: 3 } },
        formName: 'trip-planner',
        messageId: source.messageId,
        blockKey: 's0',
      },
    ]);
  });

  it('keeps params.context when no explicit context is sent', async () => {
    const agent = await newAgent();
    const source = await sourceMessage(agent.id);
    const res = await request(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: {
        agentId: agent.id,
        conversationId: source.conversationId,
        message: 'continue',
        openuiAction: {
          type: 'continue_conversation',
          message: 'continue',
          params: { context: { option: 'fast' }, other: 1 },
          messageId: source.messageId,
          blockKey: 's0',
        },
      },
    });
    expect(res.statusCode, res.body).toBe(202);
    runIds.push(res.json<{ runId: string }>().runId);
    const rows = await userMessages(source.conversationId);
    expect(rows[0]?.content).toEqual([
      { type: 'text', text: 'continue' },
      {
        type: 'openui_action',
        params: { context: { option: 'fast' }, other: 1 },
        context: { option: 'fast' },
        messageId: source.messageId,
        blockKey: 's0',
      },
    ]);
  });

  it('accepts a live action without source for form-state continuation', async () => {
    const agent = await newAgent();
    const res = await request(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: {
        agentId: agent.id,
        message: 'submit',
        openuiAction: {
          type: 'continue_conversation',
          message: 'submit',
          formState: { name: 'Ada' },
          formName: 'signup',
        },
      },
    });
    expect(res.statusCode, res.body).toBe(202);
    runIds.push(res.json<{ runId: string }>().runId);
    const rows = await userMessages(res.json<{ conversationId: string }>().conversationId);
    expect(rows[0]?.content).toEqual([
      { type: 'text', text: 'submit' },
      {
        type: 'openui_action',
        params: {},
        formState: { name: 'Ada' },
        formName: 'signup',
      },
    ]);
  });

  it('accepts a source pointing at the second real segment', async () => {
    const agent = await newAgent();
    const source = await sourceMessage(agent.id, { segments: 2 });
    const res = await request(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: {
        agentId: agent.id,
        conversationId: source.conversationId,
        message: 'pick the second',
        openuiAction: {
          type: 'continue_conversation',
          message: 'pick the second',
          messageId: source.messageId,
          blockKey: 's1',
        },
      },
    });
    expect(res.statusCode, res.body).toBe(202);
    runIds.push(res.json<{ runId: string }>().runId);
  });

  it('numbers segments past Markdown and non-openui code fences', async () => {
    const agent = await newAgent();
    const text = [
      '# 标题',
      '说明文字。',
      '```js',
      'const s = "```openui-lang\\nroot = Card([])\\n```";',
      '```',
      '```openui-lang',
      'first = Card([])',
      '```',
      '中间 Markdown。',
      uiSegment('second'),
      '结尾。',
    ].join('\n');
    const source = await sourceMessage(agent.id, { text });
    const second = await request(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: {
        agentId: agent.id,
        conversationId: source.conversationId,
        message: 'pick the second',
        openuiAction: {
          type: 'continue_conversation',
          message: 'pick the second',
          messageId: source.messageId,
          blockKey: 's1',
        },
      },
    });
    expect(second.statusCode, second.body).toBe(202);
    runIds.push(second.json<{ runId: string }>().runId);

    const missing = await request(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: {
        agentId: agent.id,
        conversationId: source.conversationId,
        message: 'x',
        openuiAction: {
          type: 'continue_conversation',
          message: 'x',
          messageId: source.messageId,
          blockKey: 's2',
        },
      },
    });
    expectProblem(missing, 'INVALID_INPUT');
  });

  it('rejects a source missing messageId or blockKey', async () => {
    const agent = await newAgent();
    const source = await sourceMessage(agent.id);
    for (const sourcePart of [{ messageId: source.messageId }, { blockKey: 's0' }]) {
      const res = await request(app, {
        method: 'POST',
        url: '/api/chat',
        headers: auth(),
        payload: {
          agentId: agent.id,
          conversationId: source.conversationId,
          message: 'x',
          openuiAction: {
            type: 'continue_conversation',
            message: 'x',
            ...sourcePart,
          },
        },
      });
      expectProblem(res, 'INVALID_INPUT');
    }
  });

  it('rejects a source that does not exist or belongs to another conversation', async () => {
    const agent = await newAgent();
    const source = await sourceMessage(agent.id);
    const other = await sourceMessage(agent.id);
    const cases = [
      { conversationId: source.conversationId, messageId: newId('message'), blockKey: 's0' },
      { conversationId: other.conversationId, messageId: source.messageId, blockKey: 's0' },
      { conversationId: source.conversationId, messageId: other.messageId, blockKey: 's0' },
    ];
    for (const sourcePart of cases) {
      const res = await request(app, {
        method: 'POST',
        url: '/api/chat',
        headers: auth(),
        payload: {
          agentId: agent.id,
          conversationId: sourcePart.conversationId,
          message: 'x',
          openuiAction: {
            type: 'continue_conversation',
            message: 'x',
            messageId: sourcePart.messageId,
            blockKey: sourcePart.blockKey,
          },
        },
      });
      expectProblem(res, 'INVALID_INPUT');
    }
  });

  it('rejects a source that is not a main-assistant openui segment', async () => {
    const agent = await newAgent();
    const markdown = await sourceMessage(agent.id, { uiFormat: 'markdown' });
    const userMessage = await sourceMessage(agent.id, { role: 'user' });
    const subagent = await sourceMessage(agent.id, { parentToolUseId: 'toolu_parent' });
    const oneSegment = await sourceMessage(agent.id, { segments: 1 });
    const cases = [
      { conversationId: markdown.conversationId, messageId: markdown.messageId, blockKey: 's0' },
      {
        conversationId: userMessage.conversationId,
        messageId: userMessage.messageId,
        blockKey: 's0',
      },
      { conversationId: subagent.conversationId, messageId: subagent.messageId, blockKey: 's0' },
      {
        conversationId: oneSegment.conversationId,
        messageId: oneSegment.messageId,
        blockKey: 's1',
      },
      { conversationId: oneSegment.conversationId, messageId: oneSegment.messageId, blockKey: '0' },
    ];
    for (const sourcePart of cases) {
      const res = await request(app, {
        method: 'POST',
        url: '/api/chat',
        headers: auth(),
        payload: {
          agentId: agent.id,
          conversationId: sourcePart.conversationId,
          message: 'x',
          openuiAction: {
            type: 'continue_conversation',
            message: 'x',
            messageId: sourcePart.messageId,
            blockKey: sourcePart.blockKey,
          },
        },
      });
      expectProblem(res, 'INVALID_INPUT');
    }
  });

  it('rolls back the run and message when action admission fails', async () => {
    const agent = await newAgent();
    const source = await sourceMessage(agent.id);
    const fn = `test_openui_action_block_${Date.now()}`;
    await app.client.unsafe(
      `create function ${fn}() returns trigger language plpgsql as $$ begin raise exception 'blocked openui action insert'; end $$`,
    );
    await app.client.unsafe(
      `create trigger ${fn} before insert on messages for each row
       when (new.role = 'user' and jsonb_typeof(new.content) = 'array' and new.content @> '[{"type":"openui_action"}]'::jsonb)
       execute function ${fn}()`,
    );
    try {
      const res = await request(app, {
        method: 'POST',
        url: '/api/chat',
        headers: auth(),
        payload: {
          agentId: agent.id,
          conversationId: source.conversationId,
          message: 'boom',
          openuiAction: {
            type: 'continue_conversation',
            message: 'boom',
            formState: { a: 1 },
            messageId: source.messageId,
            blockKey: 's0',
          },
        },
      });
      expect(res.statusCode).toBe(500);

      const runs = await app.client.unsafe('select id from agent_runs where conversation_id = $1', [
        source.conversationId,
      ]);
      expect(runs).toHaveLength(0);
      const messages = await app.client.unsafe(
        "select id from messages where conversation_id = $1 and role = 'user'",
        [source.conversationId],
      );
      expect(messages).toHaveLength(0);
      const jobs = await getQueue().getJobs(['waiting', 'delayed', 'active']);
      expect(jobs.filter((job) => job.data.conversationId === source.conversationId)).toHaveLength(
        0,
      );
    } finally {
      await app.client.unsafe(`drop trigger if exists ${fn} on messages`);
      await app.client.unsafe(`drop function if exists ${fn}()`);
    }
  });

  it('rejects an open_url action that is not http(s)', async () => {
    const agent = await newAgent();
    const source = await sourceMessage(agent.id);
    const res = await request(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: {
        agentId: agent.id,
        message: 'open it',
        openuiAction: {
          type: 'open_url',
          message: 'open it',
          params: { url: 'javascript:alert(1)' },
          messageId: source.messageId,
          blockKey: 's0',
        },
      },
    });
    expectProblem(res, 'INVALID_INPUT');
  });

  it('accepts an https open_url action without persisting a message', async () => {
    const agent = await newAgent();
    const source = await sourceMessage(agent.id);
    const res = await request(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: {
        agentId: agent.id,
        message: 'open the docs',
        openuiAction: {
          type: 'open_url',
          message: 'open the docs',
          params: { url: 'https://example.com/docs' },
          messageId: source.messageId,
          blockKey: 's0',
        },
      },
    });
    expect(res.statusCode).toBe(204);
    const rows = await userMessages(source.conversationId);
    expect(rows).toHaveLength(0);
  });

  it('rejects an action over 64KB with 413', async () => {
    const agent = await newAgent();
    const source = await sourceMessage(agent.id);
    const res = await request(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: {
        agentId: agent.id,
        message: 'huge',
        openuiAction: {
          type: 'continue_conversation',
          message: 'huge',
          formState: { blob: 'x'.repeat(64 * 1024) },
          messageId: source.messageId,
          blockKey: 's0',
        },
      },
    });
    expectProblem(res, 'PAYLOAD_TOO_LARGE');
  });

  it('rejects an unknown action type', async () => {
    const agent = await newAgent();
    const source = await sourceMessage(agent.id);
    const res = await request(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: {
        agentId: agent.id,
        message: 'x',
        openuiAction: {
          type: 'launch_missiles',
          message: 'x',
          messageId: source.messageId,
          blockKey: 's0',
        },
      },
    });
    expectProblem(res, 'INVALID_INPUT');
  });

  it('leaves plain text messages unchanged', async () => {
    const agent = await newAgent();
    const res = await request(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: { agentId: agent.id, message: 'plain hello' },
    });
    const body = res.json<{ runId: string; conversationId: string }>();
    runIds.push(body.runId);
    const rows = await userMessages(body.conversationId);
    expect(rows[0]?.content).toEqual({ type: 'text', text: 'plain hello' });
  });

  it('redacts string leaf values inside openuiAction formState and params symmetrically', async () => {
    const agent = await newAgent();
    const source = await sourceMessage(agent.id);
    const secret = `SECRET-${unique('redact')}`;
    const policyRes = await request(app, {
      method: 'POST',
      url: '/api/security/policies',
      headers: auth(),
      payload: {
        name: unique('oui-redact'),
        direction: 'inbound',
        action: 'redact',
        matchType: 'keyword',
        pattern: secret,
        agentId: agent.id,
      },
    });
    expect(policyRes.statusCode, policyRes.body).toBe(201);
    policyIds.push(policyRes.json<{ id: string }>().id);

    const res = await request(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: {
        agentId: agent.id,
        conversationId: source.conversationId,
        message: 'submit form',
        openuiAction: {
          type: 'continue_conversation',
          message: 'submit form',
          params: { note: `token ${secret}` },
          formState: { nested: { apiKey: secret, count: 2 } },
          messageId: source.messageId,
          blockKey: 's0',
        },
      },
    });
    expect(res.statusCode, res.body).toBe(202);
    runIds.push(res.json<{ runId: string }>().runId);

    const rows = await userMessages(source.conversationId);
    expect(rows[0]?.content).toEqual([
      { type: 'text', text: 'submit form' },
      {
        type: 'openui_action',
        params: { note: 'token [REDACTED]' },
        formState: { nested: { apiKey: '[REDACTED]', count: 2 } },
        messageId: source.messageId,
        blockKey: 's0',
      },
    ]);
  });
});
