import { repo } from '@agentport/db';
import { expect, it, vi } from 'vitest';
import { getQueue } from '../src/queue/producer.js';
import { cleanup, createAgent, inject, loginCookie, startApp } from './helpers.js';

it('rejects overloaded chat with 503 before creating a run', async () => {
  const app = await startApp();
  const cookie = await loginCookie(app);
  const createdAgents: string[] = [];
  // 真实 agent 才能通过对象授权，队列满的 503 不再被 404 抢在前面。
  const agent = (
    await createAgent(app, cookie, { slug: 'admission-full', track: createdAgents })
  ).json<{ id: string }>();
  const waiting = vi.spyOn(getQueue(), 'getWaitingCount').mockResolvedValue(101);
  const create = vi.spyOn(repo.chat, 'createRun');
  try {
    const result = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: { cookie },
      payload: { agentId: agent.id, message: 'hello' },
    });
    expect(result.statusCode).toBe(503);
    expect(result.json().code).toBe('SERVICE_UNAVAILABLE');
    expect(create).not.toHaveBeenCalled();
  } finally {
    waiting.mockRestore();
    create.mockRestore();
    await cleanup(app, { agentSlugs: createdAgents });
    await app.close();
  }
});
