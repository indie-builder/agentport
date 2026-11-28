import { type Agent, agentInputSchema, PERMISSIONS, type Server } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { HttpResponse, http } from 'msw';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentEditor } from '../src/pages/agents/agent-editor.js';
import { agentDetailSearchSchema } from '../src/routes/-search.js';
import { allAccessMe } from './me-fixture.js';
import { createMsw, runCleanup } from './msw.js';

const msw = createMsw();
const { server, calls } = msw;

const genericServer: Server = {
  id: 'server',
  name: 'connector',
  description: '',
  kind: 'http',
  url: 'https://example.com/mcp',
  headers: {},
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const bases = [
  {
    id: 'kb_1',
    slug: 'handbook',
    name: '产品手册',
    description: '',
    serverId: 'server-kb-active',
    status: 'active',
    embeddingProfileId: 'profile',
    rerankProfileId: null,
    asrProfileId: null,
    settings: { chunkTokens: 800, chunkOverlap: 120, wikiAutoUpdate: false },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'kb_2',
    slug: 'archive',
    name: '归档库',
    description: '',
    serverId: 'server-kb-disabled',
    status: 'disabled',
    embeddingProfileId: 'profile',
    rerankProfileId: null,
    asrProfileId: null,
    settings: { chunkTokens: 800, chunkOverlap: 120, wikiAutoUpdate: false },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

function agentWith(serverIds: string[]): Agent {
  return {
    ...agentInputSchema.parse({ slug: 'expert', name: 'Expert' }),
    id: 'expert',
    isDefault: false,
    parentId: null,
    serverIds,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

let client: QueryClient | undefined;
let host: HTMLDivElement | undefined;
let root: Root | undefined;

beforeAll(() => msw.listen());
afterAll(() => msw.close());

beforeEach(() => {
  msw.reset();
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
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
    () => vi.restoreAllMocks(),
    () => vi.unstubAllGlobals(),
    () => msw.assertClean(),
  ]);
});

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await msw.waitForRequests();
}

async function waitFor<T>(probe: () => T, tries = 40): Promise<T> {
  for (let i = 0; i < tries; i += 1) {
    try {
      const value = probe();
      if (value) return value;
    } catch {}
    await flush();
  }
  return probe();
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
  await flush();
}

function button(text: string): HTMLButtonElement {
  const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text,
  );
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}

async function mountCapability(agent: Agent): Promise<void> {
  server.use(
    http.get('/api/auth/me', () => HttpResponse.json(allAccessMe)),
    http.get('/api/agents/options', () =>
      HttpResponse.json({ servers: [], skills: [], plugins: [], runtimeEnvironments: [] }),
    ),
    http.get('/api/servers', () => HttpResponse.json({ items: [genericServer], nextCursor: null })),
    http.get('/api/knowledge/bases', () => HttpResponse.json({ items: bases, nextCursor: null })),
    http.get('/api/skills', () => HttpResponse.json({ items: [], nextCursor: null })),
    http.get('/api/plugins', () => HttpResponse.json({ items: [], nextCursor: null })),
    http.get('/api/agents/reference', () =>
      HttpResponse.json({ items: [agent], truncated: false }),
    ),
    http.get('/api/runtime-environments', () => HttpResponse.json({ items: [], nextCursor: null })),
    http.patch('/api/agents/expert', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ kind: 'detail', agent: { ...agent, ...body } });
    }),
  );

  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const detail = createRoute({
    getParentRoute: () => shell,
    path: '/agents/$agentId',
    validateSearch: agentDetailSearchSchema,
    component: () =>
      createElement(AgentEditor, {
        agent,
        permissions: PERMISSIONS.map((permission) => permission.id),
        onDirtyChange: () => {},
        onPendingChange: () => {},
        onDeleteRequest: () => {},
      }),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([detail])]),
    history: createMemoryHistory({ initialEntries: ['/agents/expert?tab=config'] }),
  });

  client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false }, mutations: { retry: false } },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);

  await act(async () => {
    await router.load();
    root?.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await flush();

  await click(button('能力'));
  await waitFor(() => document.querySelector<HTMLInputElement>('input[aria-label="知识库"]'));
}

async function openCombobox(ariaLabel: string): Promise<HTMLElement[]> {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${ariaLabel}"]`);
  if (!input) throw new Error(`Missing combobox input: ${ariaLabel}`);
  await act(async () => {
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  await flush();
  const listId = input.getAttribute('aria-controls');
  const listbox = listId
    ? document.getElementById(listId)
    : document.querySelector('[data-slot="combobox-content"][data-open] [role="listbox"]');
  if (!listbox) throw new Error(`Missing open listbox for: ${ariaLabel}`);
  return [...listbox.querySelectorAll<HTMLElement>('[role="option"]')];
}

function optionByLabel(options: HTMLElement[], label: string): HTMLElement {
  const option = options.find((item) => item.textContent?.includes(label));
  if (!option) throw new Error(`Missing option: ${label}`);
  return option;
}

function chipLabels(groupLabel: string): string[] {
  const group = document.querySelector(`[aria-label="${groupLabel}"]`);
  if (!group) throw new Error(`Missing chip group: ${groupLabel}`);
  return [...group.querySelectorAll<HTMLElement>('[data-slot="combobox-chip"]')].map(
    (item) => item.getAttribute('aria-label') ?? '',
  );
}

describe('expert knowledge binding', () => {
  it('offers knowledge bases the generic server list filters out', async () => {
    await mountCapability(agentWith(['server']));

    const connectorOptions = await openCombobox('MCP Server');
    expect(connectorOptions.map((item) => item.textContent)).toEqual(['connectorhttp']);

    const knowledgeOptions = await openCombobox('知识库');
    expect(knowledgeOptions.some((item) => item.textContent?.includes('产品手册'))).toBe(true);
    expect(knowledgeOptions.some((item) => item.textContent?.includes('归档库'))).toBe(true);
  });

  it('keeps an existing binding to a disabled base selectable', async () => {
    await mountCapability(agentWith(['server', 'server-kb-disabled']));

    expect(chipLabels('已选知识库')).toEqual(['归档库']);
    const options = await openCombobox('知识库');
    const bound = optionByLabel(options, '归档库');
    const active = optionByLabel(options, '产品手册');
    expect(bound.getAttribute('aria-disabled')).not.toBe('true');
    expect(active.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('blocks binding a disabled base that is not bound yet', async () => {
    await mountCapability(agentWith(['server']));

    const options = await openCombobox('知识库');
    const disabledOption = optionByLabel(options, '归档库');
    expect(disabledOption.getAttribute('aria-disabled')).toBe('true');
    await click(disabledOption);
    expect(chipLabels('已选知识库')).toEqual([]);
  });

  it('binds a knowledge base without dropping existing connectors', async () => {
    await mountCapability(agentWith(['server']));

    expect(chipLabels('已选连接器')).toEqual(['connector']);
    const options = await openCombobox('知识库');
    await click(optionByLabel(options, '产品手册'));

    expect(chipLabels('已选知识库')).toEqual(['产品手册']);
    expect(chipLabels('已选连接器')).toEqual(['connector']);

    await click(button('保存草稿'));
    const patch = calls.find(
      (item) => item.method === 'PATCH' && item.path === '/api/agents/expert',
    );
    expect(patch?.body).toMatchObject({ serverIds: ['server', 'server-kb-active'] });
  });
});
