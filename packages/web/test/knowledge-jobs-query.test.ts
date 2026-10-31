import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  knowledgeKeys,
  useKnowledgeDocuments,
  useKnowledgeJobs,
  useRetryKnowledgeJob,
} from '../src/lib/queries.js';

const now = '2026-01-02T00:00:00Z';

function job(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'ingest',
    status: 'succeeded',
    step: null,
    progress: 100,
    attempts: 1,
    error: null,
    documentId: null,
    sourceId: null,
    documentTitle: null,
    sourceName: null,
    createdAt: now,
    startedAt: now,
    endedAt: now,
    ...overrides,
  };
}

type JobQuery = {
  baseId: string | null;
  documentId: string | null;
  cursor: string | null;
};

type Call = {
  path: string;
  documentId: string | null;
  cursor: string | null;
  signal: unknown;
};

const state = {
  calls: [] as Call[],
  jobs: (_query: JobQuery): unknown => ({ items: [], nextCursor: null }),
};

function jobCalls() {
  return state.calls.filter((call) => call.path === '/api/knowledge/jobs');
}

beforeEach(() => {
  state.calls.length = 0;
  state.jobs = () => ({ items: [], nextCursor: null });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    state.calls.push({
      path: url.pathname,
      documentId: url.searchParams.get('documentId'),
      cursor: url.searchParams.get('cursor'),
      signal: init?.signal,
    });
    if (url.pathname === '/api/knowledge/jobs') {
      return Response.json(
        state.jobs({
          baseId: url.searchParams.get('baseId'),
          documentId: url.searchParams.get('documentId'),
          cursor: url.searchParams.get('cursor'),
        }),
      );
    }
    return Response.json({ items: [], nextCursor: null });
  });
});

let client: QueryClient | undefined;
let host: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  client?.clear();
  host?.remove();
  vi.restoreAllMocks();
});

async function mount(children: ReactNode) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false }, mutations: { retry: false } },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(createElement(QueryClientProvider, { client }, children)));
}

describe('useKnowledgeJobs', () => {
  it('保留扁平数组调用，分页逐页加载且无重复遗漏', async () => {
    state.jobs = ({ cursor }) =>
      cursor === 'cursor_1'
        ? { items: [job('kjob_2')], nextCursor: null }
        : { items: [job('kjob_1')], nextCursor: 'cursor_1' };

    let latest: ReturnType<typeof useKnowledgeJobs> | undefined;
    function Probe() {
      latest = useKnowledgeJobs('kb_1');
      return null;
    }
    await mount(createElement(Probe));
    await vi.waitFor(() => expect(latest?.data?.length).toBe(1));

    // 旧调用方式：data 仍是数组，可以直接 find。
    expect(latest?.data?.find((item) => item.id === 'kjob_1')?.id).toBe('kjob_1');
    expect(latest?.hasNextPage).toBe(true);

    await act(async () => {
      await latest?.fetchNextPage();
    });
    await vi.waitFor(() => expect(latest?.data?.length).toBe(2));

    expect(latest?.data?.map((item) => item.id)).toEqual(['kjob_1', 'kjob_2']);
    expect(latest?.hasNextPage).toBe(false);
    expect(jobCalls().map((call) => call.cursor)).toEqual([null, 'cursor_1']);
    expect(jobCalls().every((call) => call.signal)).toBe(true);
  });

  it('不同文档过滤各自缓存，前缀失效同时刷新所有过滤', async () => {
    state.jobs = ({ documentId }) => ({
      items: [job(documentId ? `job_${documentId}` : 'job_all', { documentId })],
      nextCursor: null,
    });

    let first: ReturnType<typeof useKnowledgeJobs> | undefined;
    let second: ReturnType<typeof useKnowledgeJobs> | undefined;
    let unfiltered: ReturnType<typeof useKnowledgeJobs> | undefined;
    function Probe() {
      first = useKnowledgeJobs('kb_1', { documentId: 'kdoc_1' });
      second = useKnowledgeJobs('kb_1', { documentId: 'kdoc_2' });
      unfiltered = useKnowledgeJobs('kb_1');
      return null;
    }
    await mount(createElement(Probe));
    await vi.waitFor(() => {
      expect(first?.data?.map((item) => item.id)).toEqual(['job_kdoc_1']);
      expect(second?.data?.map((item) => item.id)).toEqual(['job_kdoc_2']);
      expect(unfiltered?.data?.map((item) => item.id)).toEqual(['job_all']);
    });

    expect(new Set(jobCalls().map((call) => call.documentId))).toEqual(
      new Set(['kdoc_1', 'kdoc_2', null]),
    );

    const before = jobCalls().length;
    await act(async () => {
      await client?.invalidateQueries({ queryKey: knowledgeKeys.jobs('kb_1') });
    });
    await vi.waitFor(() => expect(jobCalls().length).toBe(before + 3));
  });

  it('任务重试成功刷新任务与文档查询', async () => {
    let retry: ReturnType<typeof useRetryKnowledgeJob> | undefined;
    function Probe() {
      retry = useRetryKnowledgeJob('kb_1');
      useKnowledgeDocuments('kb_1', {});
      return createElement(
        'button',
        { type: 'button', onClick: () => retry?.mutate('kjob_old') },
        'retry',
      );
    }
    await mount(createElement(Probe));
    await vi.waitFor(() =>
      expect(state.calls.filter((call) => call.path.endsWith('/documents')).length).toBe(1),
    );

    const button = document.querySelector('button');
    if (!button) throw new Error('missing retry button');
    await act(async () => button.click());
    await vi.waitFor(() =>
      expect(state.calls.filter((call) => call.path.endsWith('/documents')).length).toBe(2),
    );
  });
});
