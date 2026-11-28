import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMarketSkills } from '../src/lib/queries.js';
import { createMsw, runCleanup } from './msw.js';

const msw = createMsw();
const { server, calls } = msw;

let setQuery: (value: string) => void;
let debouncing: boolean | undefined;

function Probe() {
  const [query, set] = useState('');
  setQuery = set;
  debouncing = useMarketSkills('all-time', query).isDebouncing;
  return null;
}

let client: QueryClient | undefined;
let host: HTMLDivElement | undefined;
let root: Root | undefined;

beforeAll(() => msw.listen());
afterAll(() => msw.close());

beforeEach(() => {
  vi.useFakeTimers();
  msw.reset();
  server.use(http.get('/api/market/skills', () => HttpResponse.json([])));
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  const mountedRoot = root;
  const mountedClient = client;
  const mountedHost = host;
  root = undefined;
  client = undefined;
  host = undefined;
  await runCleanup([
    () => mountedRoot && act(async () => mountedRoot.unmount()),
    () => mountedClient?.clear(),
    () => mountedHost?.remove(),
    () => msw.waitForRequests(),
    () => vi.useRealTimers(),
    () => msw.assertClean(),
  ]);
});

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await msw.waitForRequests();
}

async function mountProbe(): Promise<void> {
  await act(async () => {
    root?.render(
      createElement(QueryClientProvider, { client: client as QueryClient }, createElement(Probe)),
    );
  });
  await flush();
}

async function type(value: string): Promise<void> {
  await act(async () => setQuery(value));
}

function marketRequests(): string[] {
  return calls
    .filter((item) => item.method === 'GET' && item.path.startsWith('/api/market/skills'))
    .map((item) => item.path);
}

describe('market search debounce', () => {
  it('sends one request with the final term after rapid typing', async () => {
    await mountProbe();
    expect(marketRequests()).toEqual(['/api/market/skills?view=all-time']);

    await type('p');
    await type('pd');
    await type('pdf');
    expect(marketRequests()).toEqual(['/api/market/skills?view=all-time']);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await flush();
    expect(marketRequests()).toEqual([
      '/api/market/skills?view=all-time',
      '/api/market/skills?view=all-time&q=pdf',
    ]);
  });

  it('gates 1-character settled queries without sending an HTTP request', async () => {
    await mountProbe();
    expect(marketRequests()).toEqual(['/api/market/skills?view=all-time']);

    await type('p');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await flush();
    expect(marketRequests()).toEqual(['/api/market/skills?view=all-time']);

    await type('pd');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await flush();
    expect(marketRequests()).toEqual([
      '/api/market/skills?view=all-time',
      '/api/market/skills?view=all-time&q=pd',
    ]);
  });

  it('reports isDebouncing while the typed term differs from the settled one', async () => {
    await mountProbe();
    expect(debouncing).toBe(false);

    await type('pdf');
    expect(debouncing).toBe(true);
    expect(marketRequests()).toEqual(['/api/market/skills?view=all-time']);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(debouncing).toBe(true);
    expect(marketRequests()).toEqual(['/api/market/skills?view=all-time']);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await flush();
    expect(debouncing).toBe(false);
    expect(marketRequests()).toEqual([
      '/api/market/skills?view=all-time',
      '/api/market/skills?view=all-time&q=pdf',
    ]);
  });
});
