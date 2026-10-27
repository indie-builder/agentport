import { inspect } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createIsolatedDatabase } from '../../worker/test/isolated-db.js';
import { buildApp } from '../src/app.js';
import { getQueue } from '../src/queue/producer.js';

// 每次运行建独立库：固定名的残留库迁移账本会与新迁移错位（缺插件表），导致建智能体 500。
const isolated = await createIsolatedDatabase('api_chat_enqueue', process.env.DATABASE_URL ?? '');
if (isolated) process.env.DATABASE_URL = isolated.url;

// helpers 在模块求值时读取 DATABASE_URL，必须等库准备好再加载。
const { cleanup, createAgent, expectProblem, infraReady, inject, loginCookie, testConfig, unique } =
  await import('./helpers.js');

const ready = await infraReady;
// skipIf 的 describe 不跑 hook；Redis 缺失时这里回收自己刚建的库。
if (!ready && isolated) await isolated.close();

// 故意带上连接串与密码：日志和响应都不能回显它们。
const DOWN = 'redis://:hunter2-secret@127.0.0.1:6379 refused';

interface RunRow {
  id: string;
  conversation_id: string;
  status: string;
  error: string | null;
  error_kind: string | null;
  ended_at: Date | null;
}

describe.skipIf(!(ready && isolated))('chat enqueue failure', () => {
  let app: FastifyInstance;
  let cookie: string;
  const agentSlugs: string[] = [];
  const loggedErrors: unknown[] = [];

  beforeAll(async () => {
    app = await buildApp(testConfig());
    app.addHook('onRequest', async (request) => {
      request.log.error = (...args: unknown[]) => {
        loggedErrors.push(args);
      };
    });
    await app.ready();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    try {
      if (app) {
        try {
          await cleanup(app, { agentSlugs });
        } finally {
          await app.close();
        }
      }
    } finally {
      await isolated?.close();
    }
  });

  const newAgent = async (): Promise<string> =>
    (
      await createAgent(app, cookie, {
        slug: unique('chat-enqueue'),
        track: agentSlugs,
      })
    ).json<{ id: string }>().id;

  const post = (agentId: string, message: string, conversationId?: string) =>
    inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: { cookie },
      payload: {
        agentId,
        message,
        ...(conversationId === undefined ? {} : { conversationId }),
      },
    });

  const runsOf = async (agentId: string): Promise<RunRow[]> =>
    (
      await app.pool.query<RunRow>(
        `select id, conversation_id, status, error, error_kind, ended_at
           from agent_runs where agent_id = $1 order by created_at, id`,
        [agentId],
      )
    ).rows;

  it('returns a fixed 503, records failed/infra, keeps the user message, and allows a retry', async () => {
    const agentId = await newAgent();
    const queue = getQueue();
    const add = vi.spyOn(queue, 'add').mockRejectedValueOnce(new Error(DOWN));
    loggedErrors.length = 0;
    let res: Awaited<ReturnType<typeof post>>;
    try {
      res = await post(agentId, 'remember this chat');
    } finally {
      add.mockRestore();
    }

    expectProblem(res, 'SERVICE_UNAVAILABLE');
    expect(res.body).not.toContain('hunter2');
    expect(res.body).not.toContain('redis://');
    expect(loggedErrors.length).toBeGreaterThan(0);
    expect(inspect(loggedErrors, { depth: null })).not.toContain('hunter2');
    expect(inspect(loggedErrors, { depth: null })).not.toContain('redis://');

    const [run] = await runsOf(agentId);
    if (!run) throw new Error('chat run was not created');
    expect(run.status).toBe('failed');
    expect(run.error_kind).toBe('infra');
    expect(run.error).not.toBeNull();
    expect(run.ended_at).not.toBeNull();

    // 用户消息必须留在会话历史里，失败只收口 run。
    const history = await inject(app, {
      method: 'GET',
      url: `/api/conversations/${run.conversation_id}`,
      headers: { cookie },
    });
    expect(history.statusCode).toBe(200);
    expect(
      history.json<{ messages: Array<{ role: string; content: { text?: string } }> }>().messages,
    ).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: expect.objectContaining({ text: 'remember this chat' }),
      }),
    );

    // 失败行已收口：同一会话可再次发送，不带版本条件也不返回 409。
    const retry = vi.spyOn(queue, 'add').mockResolvedValueOnce({ id: 'synthetic' } as never);
    try {
      const next = await post(agentId, 'try again', run.conversation_id);
      expect(next.statusCode, next.body).toBe(202);
      const retryBody = next.json<{ runId: string }>();
      // 注入的 add 不产生真实 job，队列里不应有残留。
      expect(await queue.getJob(retryBody.runId)).toBeUndefined();
    } finally {
      retry.mockRestore();
    }
  });

  it('returns 503 and preserves a run the worker claimed before the rejection', async () => {
    const agentId = await newAgent();
    const queue = getQueue();
    const add = vi.spyOn(queue, 'add').mockImplementationOnce(async (_name, data) => {
      await app.pool.query(
        "update agent_runs set status = 'running', started_at = now() where id = $1",
        [data.runId],
      );
      throw new Error(DOWN);
    });
    let res: Awaited<ReturnType<typeof post>>;
    try {
      res = await post(agentId, 'already claimed');
    } finally {
      add.mockRestore();
    }

    expectProblem(res, 'SERVICE_UNAVAILABLE');
    const [run] = await runsOf(agentId);
    if (!run) throw new Error('chat run was not created');
    expect(run.status).toBe('running');
    expect(run.ended_at).toBeNull();
    expect(run.error).toBeNull();
    expect(run.error_kind).toBeNull();
  });

  it.each(['cancelled', 'succeeded'] as const)(
    'returns 503 and preserves a run finished as %s before the rejection',
    async (terminal) => {
      const agentId = await newAgent();
      const queue = getQueue();
      const add = vi.spyOn(queue, 'add').mockImplementationOnce(async (_name, data) => {
        await app.pool.query('update agent_runs set status = $2, ended_at = now() where id = $1', [
          data.runId,
          terminal,
        ]);
        throw new Error(DOWN);
      });
      let res: Awaited<ReturnType<typeof post>>;
      try {
        res = await post(agentId, `finished ${terminal}`);
      } finally {
        add.mockRestore();
      }

      expectProblem(res, 'SERVICE_UNAVAILABLE');
      const [run] = await runsOf(agentId);
      if (!run) throw new Error('chat run was not created');
      expect(run.status).toBe(terminal);
      expect(run.ended_at).not.toBeNull();
      expect(run.error).toBeNull();
      expect(run.error_kind).toBeNull();
    },
  );
});
