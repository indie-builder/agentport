import type { Agent } from '@agentport/shared';
import { judge } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getEvalQueue } from '../src/queue/producer.js';
import {
  cleanup,
  createAgent,
  infraReady,
  inject,
  loginCookie,
  queueIdle,
  startApp,
  unique,
} from './helpers.js';

// 有活跃 worker 时会立刻消费评估 job，测试只断言入队，因此必须确保队列空闲。
const ready = (await infraReady) && (await queueIdle);

describe('judge', () => {
  it('passes when expectation is empty and output has text', () => {
    expect(judge('anything', '')).toBe(true);
    expect(judge('   ', '')).toBe(false);
  });

  it('matches expectation case-insensitively as a substring', () => {
    expect(judge('The answer is OK.', 'answer is ok')).toBe(true);
    expect(judge('nope', 'answer')).toBe(false);
  });

  it('trims expectation before matching', () => {
    expect(judge('some text', '  text  ')).toBe(true);
  });
});

describe.skipIf(!ready)('eval routes', () => {
  let app: FastifyInstance;
  let cookie: string;
  const createdAgents: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs: createdAgents });
    await app.close();
  });

  const newAgent = async (): Promise<Agent> =>
    (
      await createAgent(app, cookie, {
        slug: unique('eval-agent'),
        track: createdAgents,
      })
    ).json<Agent>();

  it('POST /api/eval/runs returns 202 and enqueues the job', async () => {
    const agent = await newAgent();
    const created = await inject(app, {
      method: 'POST',
      url: '/api/eval/cases',
      headers: { cookie },
      payload: { agentId: agent.id, name: 'hello', prompt: 'say hello', expectation: 'hello' },
    });
    expect(created.statusCode).toBe(201);

    const res = await inject(app, {
      method: 'POST',
      url: '/api/eval/runs',
      headers: { cookie },
      payload: { agentId: agent.id },
    });
    expect(res.statusCode).toBe(202);
    const { evalRunId } = res.json<{ evalRunId: string }>();
    expect(evalRunId.startsWith('er_')).toBe(true);

    const job = await getEvalQueue().getJob(evalRunId);
    if (!job) throw new Error('eval job was not enqueued');
    expect(await job.getState()).toBe('waiting');
    expect(job.data).toEqual({ evalRunId });

    // 不真跑：移除排队中的 job，避免残留。
    await job.remove();
  });
});
