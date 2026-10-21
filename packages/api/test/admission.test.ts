import { repo } from '@agentport/db';
import { expect, it, vi } from 'vitest';
import { getQueue } from '../src/queue/producer.js';
import { inject, loginCookie, startApp } from './helpers.js';

it('rejects overloaded chat with 503 before creating a run', async () => {
  const app = await startApp();
  const cookie = await loginCookie(app);
  const exists = vi.spyOn(repo.chat, 'agentExists').mockResolvedValue(true);
  const enabled = vi.spyOn(repo.chat, 'agentEnabled').mockResolvedValue(true);
  const waiting = vi.spyOn(getQueue(), 'getWaitingCount').mockResolvedValue(101);
  const create = vi.spyOn(repo.chat, 'createRun');
  try {
    const result = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: { cookie },
      payload: { agentId: 'agt_test', message: 'hello' },
    });
    expect(result.statusCode).toBe(503);
    expect(result.json().code).toBe('SERVICE_UNAVAILABLE');
    expect(create).not.toHaveBeenCalled();
  } finally {
    exists.mockRestore();
    enabled.mockRestore();
    waiting.mockRestore();
    create.mockRestore();
    await app.close();
  }
});
