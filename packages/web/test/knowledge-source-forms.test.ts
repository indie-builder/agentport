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
import { z } from 'zod';
import { KnowledgePage } from '../src/pages/knowledge.js';
import { KnowledgeDetailPage } from '../src/pages/knowledge-detail.js';
import { createMsw, runCleanup } from './msw.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const base = {
  id: 'kb_1',
  slug: 'handbook',
  name: '产品手册',
  description: '内部知识',
  serverId: 'srv_1',
  status: 'active',
  embeddingProfileId: 'profile_1',
  rerankProfileId: null,
  asrProfileId: null,
  settings: { chunkTokens: 800, chunkOverlap: 120, wikiAutoUpdate: false },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

function sourceFixture(overrides: Record<string, unknown>) {
  return {
    id: 'ksrc_1',
    baseId: 'kb_1',
    name: '来源',
    config: {},
    hasSecret: true,
    status: 'active',
    syncCron: null,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastError: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    ranges: [],
    ...overrides,
  };
}

const msw = createMsw();
const { server, calls } = msw;

beforeAll(() => msw.listen());
afterAll(() => msw.close());

beforeEach(() => {
  msw.reset();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

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
    () => msw.waitForRequests(),
    () => vi.restoreAllMocks(),
    () => vi.unstubAllGlobals(),
    () => msw.assertClean(),
  ]);
}

afterEach(() => cleanup());

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await msw.waitForRequests();
}

async function mount(sources: unknown[] = []) {
  server.use(
    http.get('/api/knowledge/bases', () => HttpResponse.json({ items: [base], nextCursor: null })),
    http.get('/api/knowledge/bases/kb_1', () => HttpResponse.json(base)),
    http.get('/api/knowledge/bases/kb_1/folders', () => HttpResponse.json([])),
    http.get('/api/knowledge/bases/kb_1/tags', () => HttpResponse.json([])),
    http.get('/api/knowledge/bases/kb_1/sources', () =>
      HttpResponse.json({ items: sources, nextCursor: null }),
    ),
    http.get('/api/knowledge/bases/kb_1/wiki-pages', () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get('/api/knowledge/jobs', () => HttpResponse.json({ items: [], nextCursor: null })),
    http.get('/api/knowledge/model-profiles', () => HttpResponse.json([])),
    http.get('/api/agents', () => HttpResponse.json([])),
    http.post('/api/knowledge/bases/kb_1/sources', () =>
      HttpResponse.json(sourceFixture({ type: 'notion' })),
    ),
    http.patch('/api/knowledge/sources/ksrc_1', () =>
      HttpResponse.json(sourceFixture({ type: 'lark_wiki' })),
    ),
  );
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const list = createRoute({
    getParentRoute: () => shell,
    path: '/knowledge/',
    validateSearch: z.object({ q: z.string().optional() }),
    component: KnowledgePage,
  });
  const detail = createRoute({
    getParentRoute: () => shell,
    path: '/knowledge/$baseId',
    validateSearch: z.object({
      panel: z.string().optional(),
      page: z.string().optional(),
      folder: z.string().optional(),
      document: z.string().optional(),
      source: z.string().optional(),
    }),
    component: KnowledgeDetailPage,
  });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false }, mutations: { retry: false } },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([list, detail])]),
    history: createMemoryHistory({ initialEntries: ['/knowledge/kb_1?panel=sources'] }),
  });
  await act(async () => {
    await router.load();
    root?.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await flush();
}

function dialog(title: string): HTMLElement {
  const element = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
    (item) => item.querySelector('h2')?.textContent === title,
  );
  if (!element) throw new Error(`Missing dialog: ${title}`);
  return element;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const element = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text,
  );
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}

function sourceChoice(label: string): HTMLButtonElement {
  const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    item.textContent?.includes(label),
  );
  if (!element) throw new Error(`Missing source choice: ${label}`);
  return element;
}

async function fill(id: string, value: string) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`Missing field: ${id}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function chooseOption(id: string, optionLabel: string) {
  const trigger = document.getElementById(id);
  if (!trigger) throw new Error(`Missing select: ${id}`);
  await click(trigger);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (element) => element.textContent?.trim() === optionLabel,
  );
  if (!option) throw new Error(`Missing option: ${optionLabel}`);
  await click(option);
}

function postBody() {
  return calls
    .filter((item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/sources')
    .at(-1)?.body;
}

function patchBody() {
  return calls
    .filter((item) => item.method === 'PATCH' && item.path === '/api/knowledge/sources/ksrc_1')
    .at(-1)?.body;
}

async function openCreate(choice: string) {
  await click(button('新建来源'));
  await click(sourceChoice(choice));
}

describe('knowledge source forms', () => {
  const createCases = [
    {
      choice: 'Lark 知识库',
      fill: { 'source-app-id': 'cli_lark' },
      secret: 'lark-secret',
      range: 'spc_1',
      expected: {
        type: 'lark_wiki',
        config: { appId: 'cli_lark', syncDeletions: false },
        secrets: { appSecret: 'lark-secret' },
        ranges: [{ kind: 'wiki_space', externalId: 'spc_1', ref: null, paths: [], enabled: true }],
      },
    },
    {
      choice: 'Lark 云盘',
      fill: { 'source-app-id': 'cli_lark' },
      secret: 'lark-secret',
      range: 'fld_1',
      expected: {
        type: 'lark_drive',
        config: { appId: 'cli_lark', syncDeletions: false },
        secrets: { appSecret: 'lark-secret' },
        ranges: [
          { kind: 'drive_folder', externalId: 'fld_1', ref: null, paths: [], enabled: true },
        ],
      },
    },
    {
      choice: 'Notion',
      fill: {},
      secret: 'ntn-secret',
      range: '11111111-2222-3333-4444-555555555555',
      expected: {
        type: 'notion',
        config: { syncDeletions: false },
        secrets: { apiKey: 'ntn-secret' },
        ranges: [
          {
            kind: 'notion_page',
            externalId: '11111111-2222-3333-4444-555555555555',
            ref: null,
            paths: [],
            enabled: true,
          },
        ],
      },
    },
    {
      choice: '语雀',
      fill: {},
      secret: 'yuque-secret',
      range: '12345',
      expected: {
        type: 'yuque',
        config: { syncDeletions: false },
        secrets: { apiToken: 'yuque-secret' },
        ranges: [{ kind: 'yuque_repo', externalId: '12345', ref: null, paths: [], enabled: true }],
      },
    },
    {
      choice: '钉钉',
      fill: { 'source-client-id': 'ding_client', 'source-operator-union-id': 'union_1' },
      secret: 'ding-secret',
      range: 'node_1',
      expected: {
        type: 'dingtalk',
        config: { clientId: 'ding_client', operatorUnionId: 'union_1', syncDeletions: false },
        secrets: { clientSecret: 'ding-secret' },
        ranges: [
          { kind: 'dingtalk_workspace', externalId: 'node_1', ref: null, paths: [], enabled: true },
        ],
      },
    },
    {
      choice: 'IMA',
      fill: { 'source-client-id': 'ima_client' },
      secret: 'ima-secret',
      range: 'kb_1',
      expected: {
        type: 'ima',
        config: { clientId: 'ima_client', syncDeletions: false },
        secrets: { apiKey: 'ima-secret' },
        ranges: [{ kind: 'ima_kb', externalId: 'kb_1', ref: null, paths: [], enabled: true }],
      },
    },
    {
      choice: 'Seafile',
      fill: { 'source-base-url': 'https://seafile.example.com' },
      secret: 'seafile-secret',
      range: 'repo_uuid',
      expected: {
        type: 'seafile',
        config: { baseUrl: 'https://seafile.example.com', syncDeletions: false },
        secrets: { apiToken: 'seafile-secret' },
        ranges: [
          { kind: 'seafile_repo', externalId: 'repo_uuid', ref: null, paths: [], enabled: true },
        ],
      },
    },
    {
      choice: 'Nextcloud',
      fill: {
        'source-base-url': 'https://cloud.example.com',
        'source-username': 'alice',
      },
      secret: 'nextcloud-secret',
      range: '/Documents',
      expected: {
        type: 'nextcloud',
        config: {
          baseUrl: 'https://cloud.example.com',
          username: 'alice',
          syncDeletions: false,
        },
        secrets: { appPassword: 'nextcloud-secret' },
        ranges: [
          { kind: 'nextcloud_path', externalId: '/Documents', ref: null, paths: [], enabled: true },
        ],
      },
    },
  ] as const;

  it.each(createCases)('creates $choice with the exact wire payload', async (testCase) => {
    await mount();
    await openCreate(testCase.choice);
    await fill('source-name', '新来源');
    for (const [id, value] of Object.entries(testCase.fill)) await fill(id, value);
    await fill('knowledge-source-secret', testCase.secret);
    await fill('source-range-0-external', testCase.range);
    await click(button('创建', dialog('新建来源')));
    expect(postBody()).toMatchObject({ name: '新来源', ...testCase.expected });
  });

  it('keeps Lark on its own app fields without a base URL control', async () => {
    await mount();
    await openCreate('Lark 知识库');
    expect(document.getElementById('source-app-id')).toBeTruthy();
    expect(document.getElementById('source-base-url')).toBeNull();
    expect(document.body.textContent).toContain('与飞书应用不互通');
  });

  it('submits each Confluence auth mode with its matching credential', async () => {
    const cases = [
      {
        option: 'Cloud Basic',
        fill: { 'source-base-url': 'https://acme.atlassian.net', 'source-email': 'a@acme.test' },
        secrets: { apiToken: 'cloud-token' },
        config: {
          authMode: 'cloud_basic',
          baseUrl: 'https://acme.atlassian.net',
          email: 'a@acme.test',
          syncDeletions: false,
        },
        absent: 'source-cloud-id',
        present: 'source-email',
      },
      {
        option: 'Cloud Scoped',
        fill: {
          'source-base-url': 'https://acme.atlassian.net',
          'source-email': 'a@acme.test',
          'source-cloud-id': 'cloud-1',
        },
        secrets: { apiToken: 'cloud-token' },
        config: {
          authMode: 'cloud_scoped',
          baseUrl: 'https://acme.atlassian.net',
          email: 'a@acme.test',
          cloudId: 'cloud-1',
          syncDeletions: false,
        },
        absent: null,
        present: 'source-cloud-id',
      },
      {
        option: 'Data Center PAT',
        fill: { 'source-base-url': 'https://wiki.acme.test' },
        secrets: { pat: 'dc-pat' },
        config: { authMode: 'dc_pat', baseUrl: 'https://wiki.acme.test', syncDeletions: false },
        absent: 'source-email',
        present: 'source-base-url',
      },
    ] as const;

    for (const testCase of cases) {
      await mount();
      await openCreate('Confluence');
      await chooseOption('source-confluence-auth', testCase.option);
      await fill('source-name', `Confluence ${testCase.option}`);
      for (const [id, value] of Object.entries(testCase.fill)) await fill(id, value);
      await fill('knowledge-source-secret', Object.values(testCase.secrets)[0] as string);
      await fill('source-range-0-external', '42');
      expect(document.getElementById(testCase.present)).toBeTruthy();
      if (testCase.absent) expect(document.getElementById(testCase.absent)).toBeNull();
      await click(button('创建', dialog('新建来源')));
      expect(postBody()).toMatchObject({ config: testCase.config, secrets: testCase.secrets });
      await cleanup();
    }
  });

  it('normalizes Seafile relative directories and keeps an explicit root', async () => {
    await mount();
    await openCreate('Seafile');
    await fill('source-name', 'Seafile 文档');
    await fill('source-base-url', 'https://seafile.example.com');
    await fill('knowledge-source-secret', 'seafile-secret');
    await fill('source-range-0-external', 'repo_uuid');
    await fill('source-range-0-paths', '/Documents,/Manuals/');
    await click(button('创建', dialog('新建来源')));
    expect(postBody()).toMatchObject({
      ranges: [
        {
          kind: 'seafile_repo',
          externalId: 'repo_uuid',
          ref: null,
          paths: ['Documents', 'Manuals'],
          enabled: true,
        },
      ],
    });
  });

  it.each(['//', '///'])(
    'rejects the Seafile root %s instead of widening it to the whole library',
    async (value) => {
      await mount();
      await openCreate('Seafile');
      await fill('source-name', 'Seafile 文档');
      await fill('source-base-url', 'https://seafile.example.com');
      await fill('knowledge-source-secret', 'seafile-secret');
      await fill('source-range-0-external', 'repo_uuid');
      await fill('source-range-0-paths', value);
      await click(button('创建', dialog('新建来源')));
      expect(postBody()).toBeUndefined();
      const input = document.getElementById('source-range-0-paths') as HTMLInputElement;
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(input.getAttribute('aria-describedby')).toBe('source-range-0-paths-error');
      expect(document.getElementById('source-range-0-paths-error')?.textContent).toContain(
        '每个 Seafile 范围都需要目录根',
      );
    },
  );

  it('keeps a cleared Seafile root empty, invalid, and focused instead of showing /', async () => {
    await mount();
    await openCreate('Seafile');
    await fill('source-name', 'Seafile 文档');
    await fill('source-base-url', 'https://seafile.example.com');
    await fill('knowledge-source-secret', 'seafile-secret');
    await fill('source-range-0-external', 'repo_uuid');
    await fill('source-range-0-paths', '');
    const input = document.getElementById('source-range-0-paths') as HTMLInputElement;
    expect(input.value).toBe('');
    await click(button('创建', dialog('新建来源')));
    expect(postBody()).toBeUndefined();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('source-range-0-paths-error');
    expect(document.getElementById('source-range-0-paths-error')?.textContent).toContain(
      '每个 Seafile 范围都需要目录根',
    );
    expect(document.activeElement).toBe(input);
  });

  it('shows an existing Seafile whole-library root as / and saves it unchanged', async () => {
    await mount([
      sourceFixture({
        type: 'seafile',
        name: 'Seafile 库',
        config: { baseUrl: 'https://seafile.example.com', syncDeletions: false },
        ranges: [
          {
            id: 'krng_1',
            kind: 'seafile_repo',
            externalId: 'repo_uuid',
            ref: null,
            paths: [],
            enabled: true,
          },
        ],
      }),
    ]);
    await click(button('编辑来源 Seafile 库'));
    const editor = dialog('编辑来源');
    const input = editor.querySelector<HTMLInputElement>('#source-range-0-paths');
    expect(input?.value).toBe('/');
    await click(button('保存', editor));
    expect(patchBody()).toMatchObject({
      ranges: [
        {
          kind: 'seafile_repo',
          externalId: 'repo_uuid',
          ref: null,
          paths: [],
          enabled: true,
        },
      ],
    });
  });

  it('rejects a non-numeric Yuque repo and a blank Seafile root', async () => {
    await mount();
    await openCreate('语雀');
    await fill('knowledge-source-secret', 'yuque-secret');
    await fill('source-range-0-external', 'my-repo');
    await click(button('创建', dialog('新建来源')));
    expect(postBody()).toBeUndefined();
    expect(document.body.textContent).toContain('语雀知识库 ID 需为正整数');
    await cleanup();

    await mount();
    await openCreate('Seafile');
    await fill('source-base-url', 'https://seafile.example.com');
    await fill('knowledge-source-secret', 'seafile-secret');
    await fill('source-range-0-external', 'repo_uuid');
    await fill('source-range-0-paths', '');
    await click(button('创建', dialog('新建来源')));
    expect(postBody()).toBeUndefined();
    expect(document.body.textContent).toContain('每个 Seafile 范围都需要目录根');
  });

  it('offers all three Notion range kinds', async () => {
    await mount();
    await openCreate('Notion');
    await click(document.getElementById('source-range-0-kind') as HTMLElement);
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((item) =>
      item.textContent?.trim(),
    );
    expect(options).toEqual(expect.arrayContaining(['页面', '数据库', '数据源']));
  });

  it('keeps identity fields read-only when editing and omits a blank secret', async () => {
    await mount([
      sourceFixture({
        type: 'lark_wiki',
        name: 'Lark 文档',
        config: { appId: 'cli_lark', syncDeletions: true },
        ranges: [
          {
            id: 'krng_1',
            kind: 'wiki_space',
            externalId: 'spc_1',
            ref: null,
            paths: [],
            enabled: true,
          },
        ],
      }),
    ]);
    await click(button('编辑来源 Lark 文档'));
    const editor = dialog('编辑来源');
    const appId = editor.querySelector<HTMLInputElement>('#source-app-id');
    expect(appId?.value).toBe('cli_lark');
    expect(appId?.disabled).toBe(true);
    const secret = editor.querySelector<HTMLInputElement>('#knowledge-source-secret');
    expect(secret?.placeholder).toBe('留空保持原凭证');
    await click(button('保存', editor));
    expect(patchBody()).toMatchObject({
      config: { appId: 'cli_lark', syncDeletions: true },
    });
    expect(patchBody()).not.toHaveProperty('secrets');
  });

  it('locks Confluence auth mode and identity fields when editing', async () => {
    await mount([
      sourceFixture({
        type: 'confluence',
        name: 'Confluence 文档',
        config: {
          authMode: 'cloud_scoped',
          baseUrl: 'https://acme.atlassian.net',
          email: 'a@acme.test',
          cloudId: 'cloud-1',
          syncDeletions: false,
        },
        ranges: [
          {
            id: 'krng_1',
            kind: 'confluence_space',
            externalId: '42',
            ref: null,
            paths: [],
            enabled: true,
          },
        ],
      }),
    ]);
    await click(button('编辑来源 Confluence 文档'));
    const editor = dialog('编辑来源');
    expect((editor.querySelector('#source-confluence-auth') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((editor.querySelector('#source-base-url') as HTMLInputElement).disabled).toBe(true);
    expect((editor.querySelector('#source-email') as HTMLInputElement).disabled).toBe(true);
    expect((editor.querySelector('#source-cloud-id') as HTMLInputElement).disabled).toBe(true);
  });

  it('clears the previous provider fields and secret when switching provider', async () => {
    await mount();
    await openCreate('Lark 知识库');
    await fill('source-app-id', 'cli_lark');
    await fill('knowledge-source-secret', 'lark-secret');
    await fill('source-range-0-external', 'spc_1');
    await click(button('更换来源'));
    await click(button('放弃并切换', dialog('放弃未保存的更改？')));
    await click(sourceChoice('Notion'));
    expect(document.getElementById('source-app-id')).toBeNull();
    expect((document.getElementById('knowledge-source-secret') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('source-range-0-external') as HTMLInputElement).value).toBe('');
  });

  it('disables the form while the create request is pending', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mount();
    server.use(
      http.post('/api/knowledge/bases/kb_1/sources', async () => {
        await blocked;
        return HttpResponse.json(sourceFixture({ type: 'notion' }));
      }),
    );
    await openCreate('Notion');
    await fill('source-name', 'Notion 文档');
    await fill('knowledge-source-secret', 'ntn-secret');
    await fill('source-range-0-external', '11111111-2222-3333-4444-555555555555');
    await click(button('创建', dialog('新建来源')));
    const submit = button('创建中…', dialog('新建来源'));
    expect(submit.disabled).toBe(true);
    expect(button('取消', dialog('新建来源')).disabled).toBe(true);
    await act(async () => release());
    await flush();
  });

  it('labels every new provider and range kind instead of falling back', async () => {
    const labels: Array<[string, string, string]> = [
      ['lark_wiki', 'Lark 知识库', 'wiki_space'],
      ['lark_drive', 'Lark 云盘', 'drive_folder'],
      ['notion', 'Notion', 'notion_page'],
      ['confluence', 'Confluence', 'confluence_space'],
      ['yuque', '语雀', 'yuque_repo'],
      ['dingtalk', '钉钉', 'dingtalk_workspace'],
      ['ima', 'IMA', 'ima_kb'],
      ['seafile', 'Seafile', 'seafile_repo'],
      ['nextcloud', 'Nextcloud', 'nextcloud_path'],
    ];
    await mount(
      labels.map(([type, label, kind], index) =>
        sourceFixture({
          id: `ksrc_${index}`,
          type,
          name: `${label}来源`,
          ranges: [
            {
              id: `krng_${index}`,
              kind,
              externalId: `/id-${index}`,
              ref: null,
              paths: [],
              enabled: true,
            },
          ],
        }),
      ),
    );
    for (const [, label] of labels) expect(document.body.textContent).toContain(label);
    expect(document.body.textContent).not.toContain('未知来源');
  });
});
