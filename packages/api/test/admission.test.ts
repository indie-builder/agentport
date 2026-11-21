import { expect, it, spyOn } from 'bun:test';
import { getQueue } from '../src/queue/producer.js';
import { cleanup, createAgent, loginCookie, request, startApp } from './helpers.js';

it('rejects overloaded chat with 503 before creating a run', async () => {
  const app = await startApp();
  const cookie = await loginCookie(app);
  const createdAgents: string[] = [];
  // 真实 agent 才能通过对象授权，队列满的 503 不再被 404 抢在前面。
  const agent = (
    await createAgent(app, cookie, { slug: 'admission-full', track: createdAgents })
  ).json<{ id: string }>();
  const waiting = spyOn(getQueue(), 'getWaitingCount').mockResolvedValue(101);
  try {
    const result = await request(app, {
      method: 'POST',
      url: '/api/chat',
      headers: { cookie },
      payload: { agentId: agent.id, message: 'hello' },
    });
    expect(result.statusCode).toBe(503);
    expect(result.json().code).toBe('SERVICE_UNAVAILABLE');
    const runs = await app.client.unsafe<{ count: number }[]>(
      'select count(*)::int as count from agent_runs where agent_id = $1',
      [agent.id],
    );
    expect(runs[0]?.count).toBe(0);
  } finally {
    waiting.mockRestore();
    await cleanup(app, { agentSlugs: createdAgents });
    await app.close();
  }
});
