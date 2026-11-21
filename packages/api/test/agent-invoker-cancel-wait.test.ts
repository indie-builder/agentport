import { describe, expect, it, mock } from 'bun:test';
import * as dbModule from '@agentport/db';
import { createInvoker } from '../src/modules/servers/agent-invoker.js';
import type { TestApp } from './helpers.js';

const realDb = { ...dbModule };

const queue = {
  getWaitingCount: mock(async () => 0),
  add: mock(async () => undefined),
  getJob: mock(async () => undefined),
};

mock.module('@agentport/db', () => {
  const actual = realDb;
  return {
    ...actual,
    repo: {
      ...actual.repo,
      audit: { ...actual.repo.audit, writeAudit: mock(async () => undefined) },
      agentVersions: {
        ...actual.repo.agentVersions,
        latestAgentVersion: async () => null,
      },
      chat: {
        ...actual.repo.chat,
        admitChatRun: async () => ({
          run: { id: 'run-1' },
          conversationId: 'conversation-1',
          inherited: [],
          userMessageUuid: 'user-message-1',
        }),
        getRun: async () => ({ id: 'run-1', status: 'succeeded', error: null }),
        listMessages: async () => [
          { role: 'assistant', content: { type: 'text', text: 'assistant reply' } },
        ],
        messageText: (content: { text?: string } | null) => content?.text ?? null,
      },
    },
  };
});

mock.module('../src/queue/producer.js', () => ({ getQueue: () => queue }));
mock.module('../src/modules/runs/cancel-run.js', () => ({
  cancelAgentRun: mock(async () => 'queued'),
}));

function fakeApp(): TestApp {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () => [],
          limit: async () => [{ id: 'agent-1', slug: 'demo', enabled: true, timeoutMs: 30_000 }],
        }),
      }),
    }),
  };
  return {
    db,
    config: { ANTHROPIC_BASE_URL: undefined },
    log: { error: () => undefined, warn: () => undefined },
  } as unknown as TestApp;
}

async function rejectionOf(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    return err as { code?: string; message: string };
  }
  throw new Error('expected promise to reject');
}

describe('agent invoker cancellable wait', () => {
  it('cancels a pending poll immediately without another run read', async () => {
    const controller = new AbortController();
    const pending = createInvoker(fakeApp()).invoke({
      slug: 'demo',
      prompt: 'cancel during poll',
      signal: controller.signal,
    });
    pending.catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const abortedAt = performance.now();
    controller.abort();

    const err = await rejectionOf(pending);
    expect(err.code).toBe('UPSTREAM_FAILED');
    expect(err.message).toBe('agent run cancelled');
    expect(performance.now() - abortedAt).toBeLessThan(500);
  });

  it('reads the run after a normal wait and returns assistant text', async () => {
    const text = await createInvoker(fakeApp()).invoke({ slug: 'demo', prompt: 'hello' });
    expect(text).toBe('assistant reply');
  });
});
