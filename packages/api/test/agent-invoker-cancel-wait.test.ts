import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createInvoker } from '../src/features/servers/agent-invoker.js';

const state = vi.hoisted(() => ({
  getRunCalls: 0,
  cancelCalls: 0,
}));

const queue = vi.hoisted(() => ({
  getWaitingCount: vi.fn(async () => 0),
  add: vi.fn(async () => undefined),
  getJob: vi.fn(async () => undefined),
}));

vi.mock('@agentport/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentport/db')>();
  return {
    ...actual,
    repo: {
      ...actual.repo,
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
        getRun: async () => {
          state.getRunCalls += 1;
          return { id: 'run-1', status: 'succeeded', error: null };
        },
        listMessages: async () => [
          { role: 'assistant', content: { type: 'text', text: 'assistant reply' } },
        ],
        messageText: (content: { text?: string } | null) => content?.text ?? null,
      },
    },
  };
});

vi.mock('../src/queue/producer.js', () => ({ getQueue: () => queue }));
vi.mock('../src/plugins/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock('../src/features/chat/cancel-run.js', () => ({
  cancelAgentRun: vi.fn(async () => {
    state.cancelCalls += 1;
    return 'queued';
  }),
}));

function fakeApp(): FastifyInstance {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ id: 'agent-1', slug: 'demo', enabled: true, timeoutMs: 30_000 }],
        }),
      }),
    }),
  };
  return {
    db,
    log: { error: () => undefined, warn: () => undefined },
  } as unknown as FastifyInstance;
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
    state.getRunCalls = 0;
    state.cancelCalls = 0;
    const controller = new AbortController();
    const pending = createInvoker(fakeApp()).invoke({
      slug: 'demo',
      prompt: 'cancel during poll',
      signal: controller.signal,
    });
    pending.catch(() => undefined);

    // 先让调用进入 2 秒轮询睡眠，再取消；旧实现会等到睡眠结束才处理。
    await new Promise((resolve) => setTimeout(resolve, 100));
    const abortedAt = performance.now();
    controller.abort();

    const err = await rejectionOf(pending);
    expect(err.code).toBe('UPSTREAM_FAILED');
    expect(err.message).toBe('agent run cancelled');
    // 两个维度都报告：取消延迟与取消后是否还多读了一次 run。
    expect.soft(performance.now() - abortedAt).toBeLessThan(500);
    expect.soft(state.getRunCalls).toBe(0);
    expect(state.cancelCalls).toBe(1);
  });

  it('reads the run after a normal wait and returns assistant text', async () => {
    state.getRunCalls = 0;
    const text = await createInvoker(fakeApp()).invoke({ slug: 'demo', prompt: 'hello' });
    expect(text).toBe('assistant reply');
    expect(state.getRunCalls).toBe(1);
  });
});
