import type { PublicRunQuestion } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.js';
import {
  runQuestionsQueryKey,
  useRespondToQuestion,
  useRunQuestions,
  withRunQuestion,
} from '../src/lib/queries.js';

const at = '2026-10-28T00:00:00.000Z';

function runQuestion(overrides: Partial<PublicRunQuestion> = {}): PublicRunQuestion {
  return {
    requestId: 'qreq_1',
    runId: 'run_1',
    toolUseId: 'toolu_1',
    questions: [
      {
        question: '选择部署环境',
        header: '环境',
        options: [
          { value: '0', label: '预发', description: '' },
          { value: '1', label: '生产', description: '' },
        ],
        multiSelect: false,
      },
    ],
    status: 'pending',
    answers: null,
    createdAt: at,
    resolvedAt: null,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    closeReason: null,
    ...overrides,
  };
}

let client: QueryClient;
let root: Root;
let respond: ReturnType<typeof useRespondToQuestion>;

function Probe() {
  useRunQuestions('run_1', false);
  respond = useRespondToQuestion();
  return null;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function cached(): PublicRunQuestion | undefined {
  return client.getQueryData<{ items: PublicRunQuestion[] }>(runQuestionsQueryKey('run_1'))
    ?.items[0];
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  root = createRoot(document.createElement('div'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  vi.restoreAllMocks();
});

describe('run question cache ordering', () => {
  it('does not let a delayed GET overwrite a newer answer', async () => {
    let resolveFetch: (value: { items: PublicRunQuestion[] }) => void = () => {};
    vi.spyOn(api, 'runQuestions').mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const answered = runQuestion({
      status: 'answered',
      answers: { 0: '预发' },
      resolvedAt: at,
    });
    vi.spyOn(api, 'respondToQuestion').mockResolvedValue(answered);

    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
    });
    await act(async () => {
      await respond.mutateAsync({
        runId: 'run_1',
        requestId: 'qreq_1',
        response: { answers: { 0: '预发' } },
      });
    });
    expect(cached()?.status).toBe('answered');

    await act(async () => {
      resolveFetch({ items: [runQuestion()] });
      await Promise.resolve();
    });
    await flush();

    expect(cached()?.status).toBe('answered');
  });

  it('never rewrites a resolved, declined or closed question back to pending', () => {
    const key = runQuestionsQueryKey('run_1');
    for (const status of ['answered', 'declined', 'closed'] as const) {
      const resolved = runQuestion({
        status,
        answers: status === 'answered' ? { 0: '预发' } : null,
        resolvedAt: at,
      });
      client.setQueryData<{ items: PublicRunQuestion[] }>(key, { items: [resolved] });
      client.setQueryData<{ items: PublicRunQuestion[] }>(key, (previous) => ({
        items: withRunQuestion(previous?.items, runQuestion()),
      }));

      expect(cached()?.status).toBe(status);
    }
  });

  it('accepts a resolved snapshot over a pending one', () => {
    const key = runQuestionsQueryKey('run_1');
    const answered = runQuestion({
      status: 'answered',
      answers: { 0: '预发' },
      resolvedAt: at,
    });
    client.setQueryData<{ items: PublicRunQuestion[] }>(key, { items: [runQuestion()] });
    client.setQueryData<{ items: PublicRunQuestion[] }>(key, (previous) => ({
      items: withRunQuestion(previous?.items, answered),
    }));

    expect(cached()).toEqual(answered);
  });
});
