import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useCreateKnowledgeModelProfile,
  useKnowledgeModelProfileSelections,
  useKnowledgeModelProfiles,
} from '../src/lib/queries.js';
import { createMsw, runCleanup } from './msw.js';

const { server, listen, reset, waitForRequests, assertClean, close } = createMsw();

const selection = {
  id: 'profile_1',
  name: 'embed-v4.0',
  kind: 'embedding' as const,
  enabled: true,
  supportsImageVectors: true,
};

const managed = {
  id: 'profile_1',
  kind: 'embedding' as const,
  name: 'embed-v4.0',
  endpointUrl: 'https://models.example.com',
  model: 'embed-v4.0',
  dimensions: 1024,
  enabled: true,
  hasSecret: true,
  embeddingProtocol: 'cohere_v2' as const,
  imageInputEnabled: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

beforeAll(() => listen());
afterAll(() => close());

beforeEach(() => reset());

let client: QueryClient | undefined;
let host: HTMLDivElement | undefined;
let root: Root | undefined;

async function cleanup() {
  const mountedRoot = root,
    mountedClient = client,
    mountedHost = host;
  root = client = host = undefined;
  await runCleanup([
    () => mountedRoot && act(async () => mountedRoot.unmount()),
    () => mountedClient?.clear(),
    () => mountedHost?.remove(),
    () => waitForRequests(),
    () => assertClean(),
  ]);
}

afterEach(() => cleanup());

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await waitForRequests();
}

function Probe() {
  const selections = useKnowledgeModelProfileSelections();
  const profiles = useKnowledgeModelProfiles();
  const create = useCreateKnowledgeModelProfile();
  return createElement(
    'div',
    null,
    createElement('output', { id: 'selection' }, JSON.stringify(selections.data ?? null)),
    createElement('output', { id: 'managed' }, JSON.stringify(profiles.data ?? null)),
    createElement(
      'button',
      {
        type: 'button',
        onClick: () =>
          create.mutate({
            kind: 'embedding',
            name: 'second',
            endpointUrl: 'https://models.example.com',
            model: 'bge-m3',
          }),
      },
      'create',
    ),
  );
}

async function mount() {
  server.use(
    http.get('/api/knowledge/model-profiles', ({ request }) => {
      const view = new URL(request.url).searchParams.get('view');
      if (view === 'selection') return HttpResponse.json([selection]);
      if (view === null) return HttpResponse.json([managed]);
      return HttpResponse.json({ code: 'INVALID_INPUT', message: '未知的视图' }, { status: 400 });
    }),
    http.post('/api/knowledge/model-profiles', () => HttpResponse.json(managed)),
  );
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
  });
  await flush();
}

describe('knowledge model profile selections', () => {
  it('refreshes the selection list after creating a profile', async () => {
    await mount();
    expect(document.getElementById('selection')?.textContent).toContain('embed-v4.0');

    server.use(
      http.get('/api/knowledge/model-profiles', ({ request }) =>
        new URL(request.url).searchParams.get('view') === 'selection'
          ? HttpResponse.json([{ ...selection, name: 'bge-m3-new' }])
          : HttpResponse.json([managed]),
      ),
    );

    await act(async () => (document.querySelector('button') as HTMLButtonElement).click());
    await vi.waitFor(() =>
      expect(document.getElementById('selection')?.textContent).toContain('bge-m3-new'),
    );
  });
});
