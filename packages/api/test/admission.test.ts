import { expect, it, spyOn } from 'bun:test';
import { repo } from '@agentport/db';
import { getQueue } from '../src/queue/producer.js';
import { cleanup, createAgent, loginCookie, request, startApp } from './helpers.js';

it('rejects overloaded chat with 503 before creating a run', async () => {
  const app = await startApp();
  const cookie = await loginCookie(app);
  const createdAgents: string[] = [];
  const agent = (
    await createAgent(app, cookie, { slug: 'admission-full', track: createdAgents })
  ).json<{ id: string }>();
  const waiting = spyOn(getQueue(), 'getWaitingCount').mockResolvedValue(101);
  const create = spyOn(repo.chat, 'createRun');
  try {
    const result = await request(app, {
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
