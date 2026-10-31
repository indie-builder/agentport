import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { HttpResponse, http } from 'msw';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KnowledgeProfilesDialog,
  KnowledgeSettingsDialog,
} from '../src/components/knowledge-settings.js';
import { toastError, toastSuccess } from '../src/lib/toast.js';
import { allAccessMe } from './me-fixture.js';
import { createMsw, runCleanup } from './msw.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const withoutExecuteMe = {
  ...allAccessMe,
  grants: allAccessMe.grants.filter((grant) => grant.permissionId !== 'knowledge.execute'),
};

const base = {
  id: 'kb_1',
  slug: 'handbook',
  name: '产品手册',
  description: '',
  serverId: 'srv_1',
  status: 'active' as const,
  embeddingProfileId: 'profile_embed',
  rerankProfileId: 'profile_rerank',
  settings: {
    chunkTokens: 800,
    chunkOverlap: 120,
    wikiAutoUpdate: false,
    imageProcessing: {
      enabled: false,
      model: null,
      ocrEnabled: true,
      captionEnabled: true,
      descriptionLanguage: 'zh-CN',
      customInstructions: '',
      imageVectorEnabled: false,
      imageVectorMinScore: 0.3,
    },
  },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const embeddingProfile = {
  id: 'profile_embed',
  kind: 'embedding' as const,
  name: 'bge-m3',
  endpointUrl: 'https://models.example.com',
  model: 'bge-m3',
  dimensions: 1024,
  enabled: true,
  hasSecret: true,
  embeddingProtocol: 'openai' as const,
  imageInputEnabled: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const cohereProfile = {
  ...embeddingProfile,
  id: 'profile_cohere',
  name: 'embed-v4.0',
  model: 'embed-v4.0',
  embeddingProtocol: 'cohere_v2' as const,
  imageInputEnabled: true,
};

const cohereBase = {
  ...base,
  embeddingProfileId: 'profile_cohere',
  settings: {
    ...base.settings,
    imageProcessing: {
      ...base.settings.imageProcessing,
      enabled: true,
      model: 'claude-vision',
    },
  },
};

const cohereVectorBase = {
  ...cohereBase,
  settings: {
    ...cohereBase.settings,
    imageProcessing: {
      ...cohereBase.settings.imageProcessing,
      imageVectorEnabled: true,
    },
  },
};

const imageEnabledBase = {
  ...base,
  settings: {
    ...base.settings,
    imageProcessing: {
      ...base.settings.imageProcessing,
      enabled: true,
      model: 'claude-vision',
    },
  },
};

const rerankProfile = {
  id: 'profile_rerank',
  kind: 'rerank' as const,
  name: 'bge-reranker',
  endpointUrl: 'https://models.example.com',
  model: 'bge-reranker-v2',
  dimensions: null,
  enabled: true,
  hasSecret: false,
  embeddingProtocol: 'openai' as const,
  imageInputEnabled: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const msw = createMsw();
const { server, calls } = msw;

type ProfileFixture = typeof embeddingProfile | typeof cohereProfile | typeof rerankProfile;

/** 选择投影与后端同一规则：停用、非 Cohere v2、非 embed-v4.0 或未开图片输入都不支持图片向量。 */
function selectionOf(profile: ProfileFixture) {
  return {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    enabled: profile.enabled,
    supportsImageVectors:
      profile.kind === 'embedding' &&
      profile.enabled &&
      profile.embeddingProtocol === 'cohere_v2' &&
      profile.model === 'embed-v4.0' &&
      profile.imageInputEnabled,
  };
}

/** 管理列表与选择投影是同一 URL 的两个形状；测试严格按 view 区分，避免用超集掩盖选择请求。 */
function profilesHandler(profiles: ProfileFixture[]) {
  return http.get('/api/knowledge/model-profiles', ({ request }) => {
    const view = new URL(request.url).searchParams.get('view');
    if (view === 'selection') return HttpResponse.json(profiles.map(selectionOf));
    if (view !== null) {
      return HttpResponse.json({ code: 'INVALID_INPUT', message: '未知的视图' }, { status: 400 });
    }
    return HttpResponse.json(profiles);
  });
}

function profileCalls() {
  return calls.filter((item) => item.path.startsWith('/api/knowledge/model-profiles'));
}

beforeAll(() => msw.listen());

afterAll(() => msw.close());

beforeEach(() => {
  msw.reset();
  // 设置弹层内部读取 me 决定是否显示重建入口；默认给全量权限身份。
  server.use(http.get('/api/auth/me', () => HttpResponse.json(allAccessMe)));
  vi.mocked(toastError).mockClear();
  vi.mocked(toastSuccess).mockClear();
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

async function mount(element: ReactElement) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  // 弹层会注册路由离开保护，必须挂在真实 router 上下文里。
  const rootRoute = createRootRoute({ component: () => element });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await act(async () => {
    await router.load();
    root?.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await flush();
  return router;
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

async function fill(id: string, value: string) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    throw new Error(`Missing field: ${id}`);
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function selectOption(id: string, label: string) {
  const trigger = document.getElementById(id);
  if (!trigger) throw new Error(`Missing select: ${id}`);
  await click(trigger);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!option) throw new Error(`Missing option: ${label}`);
  await click(option);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function toggle(id: string) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing switch: ${id}`);
  await click(element);
}

function dialog(title: string): HTMLElement {
  const element = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
    (item) => item.querySelector('h2')?.textContent === title,
  );
  if (!element) throw new Error(`Missing dialog: ${title}`);
  return element;
}

function mountSettings(selected = base, onClose = vi.fn()) {
  return mount(
    createElement(KnowledgeSettingsDialog, {
      base: selected,
      onClose,
      finalFocus: () => null,
    }),
  );
}

function mountProfiles(onClose = vi.fn()) {
  return mount(createElement(KnowledgeProfilesDialog, { onClose, finalFocus: () => null }));
}

describe('msw cleanup', () => {
  it('resets the mounted root, client and host for the next case', async () => {
    // afterEach 真实使用的就是同一个 cleanup；这里手动触发以覆盖引用复位。
    await mount(createElement('div'));
    const mounted = host;
    expect(mounted?.isConnected).toBe(true);
    await cleanup();
    expect(root).toBeUndefined();
    expect(client).toBeUndefined();
    expect(host).toBeUndefined();
    expect(mounted?.isConnected).toBe(false);
  });
});

describe('knowledge base settings', () => {
  it('saves chunk settings and the rerank profile through the base patch', async () => {
    server.use(
      profilesHandler([embeddingProfile, rerankProfile]),
      http.patch('/api/knowledge/bases/kb_1', () =>
        HttpResponse.json({ ...base, rerankProfileId: null }),
      ),
    );
    await mountSettings();
    expect(document.body.textContent).toContain('知识库设置');
    expect(profileCalls().map((item) => item.path)).toContain(
      '/api/knowledge/model-profiles?view=selection',
    );
    expect(profileCalls().some((item) => item.path === '/api/knowledge/model-profiles')).toBe(
      false,
    );
    await fill('knowledge-settings-chunk-tokens', '1000');
    await fill('knowledge-settings-chunk-overlap', '150');
    await click(button('保存设置'));
    expect(
      calls.find((item) => item.method === 'PATCH' && item.path === '/api/knowledge/bases/kb_1')
        ?.body,
    ).toEqual({
      rerankProfileId: 'profile_rerank',
      settings: {
        chunkTokens: 1000,
        chunkOverlap: 150,
        wikiAutoUpdate: false,
        imageProcessing: base.settings.imageProcessing,
      },
    });
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('saves settings for a read+update role without requesting the management list', async () => {
    server.use(
      http.get('/api/auth/me', () =>
        HttpResponse.json({
          ...allAccessMe,
          grants: allAccessMe.grants.filter(
            (grant) =>
              grant.permissionId !== 'knowledge.models.manage' &&
              grant.permissionId !== 'knowledge.create',
          ),
        }),
      ),
      profilesHandler([embeddingProfile, rerankProfile]),
      http.patch('/api/knowledge/bases/kb_1', () => HttpResponse.json(base)),
    );
    await mountSettings();
    expect(profileCalls().map((item) => item.path)).toContain(
      '/api/knowledge/model-profiles?view=selection',
    );
    expect(profileCalls().some((item) => item.path === '/api/knowledge/model-profiles')).toBe(
      false,
    );
    await fill('knowledge-settings-chunk-tokens', '1000');
    await click(button('保存设置'));
    expect(
      calls.find((item) => item.method === 'PATCH' && item.path === '/api/knowledge/bases/kb_1')
        ?.body,
    ).toMatchObject({ settings: { chunkTokens: 1000 } });
  });

  it('saves a newly selected embedding profile in the same patch', async () => {
    server.use(
      profilesHandler([embeddingProfile, cohereProfile, rerankProfile]),
      http.patch('/api/knowledge/bases/kb_1', () => HttpResponse.json(cohereBase)),
    );
    await mountSettings(imageEnabledBase);
    expect(
      (document.getElementById('knowledge-settings-image-vector') as HTMLButtonElement).disabled,
    ).toBe(true);
    await selectOption('knowledge-settings-embedding', 'embed-v4.0');
    expect(document.body.textContent).toContain('保存后立即切换检索模型');
    expect(document.body.textContent).toContain('已有文档需重建后恢复向量检索');
    // 图片向量能力按新选择的 profile 判定，而不是旧绑定。
    expect(
      (document.getElementById('knowledge-settings-image-vector') as HTMLButtonElement).disabled,
    ).toBe(false);
    await click(button('保存设置'));
    expect(
      calls.find((item) => item.method === 'PATCH' && item.path === '/api/knowledge/bases/kb_1')
        ?.body,
    ).toMatchObject({ embeddingProfileId: 'profile_cohere' });
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('blocks image vectors when switching to a profile that cannot embed images', async () => {
    server.use(
      profilesHandler([embeddingProfile, cohereProfile, rerankProfile]),
      http.patch('/api/knowledge/bases/kb_1', () => HttpResponse.json(base)),
    );
    await mountSettings(cohereVectorBase);
    await selectOption('knowledge-settings-embedding', 'bge-m3');
    // 已勾选的开关不能因能力不足被禁用，否则用户无法关闭它。
    const vector = document.getElementById('knowledge-settings-image-vector') as HTMLButtonElement;
    expect(vector.disabled).toBe(false);
    await click(button('保存设置'));
    expect(document.body.textContent).toContain('请关闭「图片向量」');
    expect(
      calls.some((item) => item.method === 'PATCH' && item.path === '/api/knowledge/bases/kb_1'),
    ).toBe(false);

    await toggle('knowledge-settings-image-vector');
    await click(button('保存设置'));
    const body = calls.find(
      (item) => item.method === 'PATCH' && item.path === '/api/knowledge/bases/kb_1',
    )?.body as {
      embeddingProfileId?: string;
      settings: { imageProcessing: Record<string, unknown> };
    };
    expect(body?.embeddingProfileId).toBe('profile_embed');
    expect(body?.settings.imageProcessing.imageVectorEnabled).toBe(false);
  });

  it('saves the image processing group with the gateway vision model id', async () => {
    server.use(
      profilesHandler([cohereProfile, rerankProfile]),
      http.patch('/api/knowledge/bases/kb_1', () => HttpResponse.json(cohereBase)),
    );
    await mountSettings(cohereBase);
    await fill('knowledge-settings-image-model', 'claude-vision');
    await fill('knowledge-settings-image-language', 'en-US');
    await fill('knowledge-settings-image-instructions', '保留表格结构');
    await click(button('保存设置'));
    const body = calls.find(
      (item) => item.method === 'PATCH' && item.path === '/api/knowledge/bases/kb_1',
    )?.body as { settings: { imageProcessing: Record<string, unknown> } } | undefined;
    expect(body?.settings.imageProcessing).toMatchObject({
      enabled: true,
      model: 'claude-vision',
      ocrEnabled: true,
      captionEnabled: true,
      descriptionLanguage: 'en-US',
      customInstructions: '保留表格结构',
    });
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('refuses to enable image processing without a model or any action', async () => {
    server.use(profilesHandler([cohereProfile, rerankProfile]));
    await mountSettings();
    await toggle('knowledge-settings-image-enabled');
    await click(button('保存设置'));
    expect(document.body.textContent).toContain('请填写视觉模型 ID');
    expect(
      calls.some((item) => item.method === 'PATCH' && item.path === '/api/knowledge/bases/kb_1'),
    ).toBe(false);
  });

  it('only offers image vectors when the bound profile is Cohere embed-v4.0 with images', async () => {
    server.use(profilesHandler([embeddingProfile, rerankProfile]));
    await mountSettings({ ...cohereBase, embeddingProfileId: 'profile_embed' });
    const vector = document.getElementById('knowledge-settings-image-vector') as HTMLButtonElement;
    expect(vector.disabled).toBe(true);
    expect(document.body.textContent).toContain('需要 Cohere embed-v4.0');
  });

  it('enables image vectors and the score floor on a capable profile', async () => {
    server.use(
      profilesHandler([cohereProfile, rerankProfile]),
      http.patch('/api/knowledge/bases/kb_1', () => HttpResponse.json(cohereBase)),
    );
    await mountSettings(cohereBase);
    await toggle('knowledge-settings-image-vector');
    await fill('knowledge-settings-image-min-score', '0.5');
    await click(button('保存设置'));
    const body = calls.find(
      (item) => item.method === 'PATCH' && item.path === '/api/knowledge/bases/kb_1',
    )?.body as { settings: { imageProcessing: Record<string, unknown> } } | undefined;
    expect(body?.settings.imageProcessing).toMatchObject({
      imageVectorEnabled: true,
      imageVectorMinScore: 0.5,
    });
  });

  it('shows the API conflict when image vectors are rejected', async () => {
    server.use(
      profilesHandler([cohereProfile, rerankProfile]),
      http.patch('/api/knowledge/bases/kb_1', () =>
        HttpResponse.json(
          { code: 'CONFLICT', message: '图片向量需要 Cohere embed-v4.0 且 profile 已开启图片输入' },
          { status: 409 },
        ),
      ),
    );
    await mountSettings(cohereBase);
    await click(button('保存设置'));
    expect(vi.mocked(toastError).mock.calls[0]?.[0]).toMatchObject({
      message: '图片向量需要 Cohere embed-v4.0 且 profile 已开启图片输入',
    });
  });

  it('asks before a whole rebuild because manual chunk edits are not carried over', async () => {
    server.use(
      profilesHandler([embeddingProfile, rerankProfile]),
      http.post('/api/knowledge/bases/kb_1/rebuild', () => HttpResponse.json({ jobId: 'kjob_9' })),
    );
    await mountSettings();
    // 常态说明与确认框描述同一后果：逐文档切换新版本，手改内容不进新版本，失败文档保留原版本、已成功的不回滚。
    const rebuildDialog = dialog('知识库设置');
    expect(rebuildDialog.textContent).toContain('逐文档从原件生成并切换新版本');
    expect(rebuildDialog.textContent).toContain('人工分块修改不会带入');
    expect(rebuildDialog.textContent).toContain('失败文档保留原版本');
    expect(rebuildDialog.textContent).toContain('已成功的文档不会回滚');
    await click(button('重建全部索引'));
    const confirm = dialog('重建全部索引');
    expect(confirm.textContent).toContain('逐文档从原件生成并切换新版本');
    expect(confirm.textContent).toContain('人工分块修改不会带入');
    expect(confirm.textContent).toContain('失败文档保留原版本');
    expect(confirm.textContent).toContain('已成功的文档不会回滚');
    await click(button('确认重建'));
    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/rebuild',
      )?.body,
    ).toEqual({ chunksOnly: false });
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('hides the rebuild entry without knowledge.execute but still allows saving settings', async () => {
    server.use(
      http.get('/api/auth/me', () => HttpResponse.json(withoutExecuteMe)),
      profilesHandler([embeddingProfile, rerankProfile]),
    );
    await mountSettings();
    // knowledge.update 只允许保存设置，不隐含执行权。
    expect(document.body.textContent).not.toContain('重建全部索引');
    expect(button('保存设置')).toBeDefined();
  });

  it('disables rebuild while settings are unsaved so it cannot run with the old bindings', async () => {
    server.use(profilesHandler([embeddingProfile, rerankProfile]));
    await mountSettings();
    expect(button('重建全部索引').disabled).toBe(false);
    await fill('knowledge-settings-chunk-tokens', '1000');
    expect(button('重建全部索引').disabled).toBe(true);
    expect(document.body.textContent).toContain('保存后才能重建');
  });

  it('keeps the bound embedding profile selectable when it has been disabled', async () => {
    const disabledEmbedding = { ...embeddingProfile, name: '旧 embedding', enabled: false };
    server.use(profilesHandler([disabledEmbedding, cohereProfile, rerankProfile]));
    await mountSettings();
    // 当前绑定项停用也必须回显，不能显示空值误导用户。
    expect(document.getElementById('knowledge-settings-embedding')?.textContent).toContain(
      '旧 embedding',
    );
    await selectOption('knowledge-settings-embedding', 'embed-v4.0');
    await selectOption('knowledge-settings-embedding', '旧 embedding');
    expect(document.getElementById('knowledge-settings-embedding')?.textContent).toContain(
      '旧 embedding',
    );
  });
});

describe('knowledge settings draft protection', () => {
  it('asks before discarding edited chunk settings', async () => {
    server.use(profilesHandler([embeddingProfile, rerankProfile]));
    const onClose = vi.fn();
    await mountSettings(base, onClose);
    await fill('knowledge-settings-chunk-tokens', '1000');
    await click(button('取消'));
    const confirmation = dialog('放弃未保存的更改？');
    await click(button('取消', confirmation));
    expect(
      (document.getElementById('knowledge-settings-chunk-tokens') as HTMLInputElement).value,
    ).toBe('1000');
    await click(button('取消'));
    await click(button('放弃并关闭', dialog('放弃未保存的更改？')));
    expect(onClose).toHaveBeenCalled();
  });

  it('guards an embedding-only change before closing', async () => {
    server.use(profilesHandler([embeddingProfile, cohereProfile, rerankProfile]));
    const onClose = vi.fn();
    await mountSettings(base, onClose);
    await selectOption('knowledge-settings-embedding', 'embed-v4.0');
    await click(button('取消'));
    await click(button('放弃并关闭', dialog('放弃未保存的更改？')));
    expect(onClose).toHaveBeenCalled();
  });

  it('associates chunk validation errors with the field and blocks the request', async () => {
    server.use(profilesHandler([embeddingProfile, rerankProfile]));
    await mountSettings();
    await fill('knowledge-settings-chunk-tokens', '100');
    await fill('knowledge-settings-chunk-overlap', '150');
    await click(button('保存设置'));
    const input = document.getElementById('knowledge-settings-chunk-tokens') as HTMLInputElement;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy as string)?.textContent).toContain('200–4000');
    expect(
      calls.some((item) => item.method === 'PATCH' && item.path === '/api/knowledge/bases/kb_1'),
    ).toBe(false);
  });
});

describe('knowledge model profile draft protection', () => {
  it('asks before discarding a dirty profile edit on cancel or switch', async () => {
    server.use(profilesHandler([embeddingProfile, rerankProfile]));
    await mountProfiles();
    // 管理弹层仍用原管理请求，不能消费选择投影而丢失编辑字段。
    expect(profileCalls().map((item) => item.path)).toContain('/api/knowledge/model-profiles');
    expect(profileCalls().some((item) => item.path.includes('view=selection'))).toBe(false);
    await click(button('编辑'));
    await fill('knowledge-profile-model', 'changed-model');
    await click(button('取消'));
    const discard = dialog('放弃未保存的更改？');
    await click(button('取消', discard));
    expect((document.getElementById('knowledge-profile-model') as HTMLInputElement).value).toBe(
      'changed-model',
    );

    const editButtons = () =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
        (item) => item.textContent?.trim() === '编辑',
      );
    await click(editButtons()[1] as HTMLButtonElement);
    await click(button('放弃并切换', dialog('放弃未保存的更改？')));
    expect((document.getElementById('knowledge-profile-name') as HTMLInputElement).value).toBe(
      'bge-reranker',
    );
  });

  it('blocks closing and switching profiles while a profile save is in flight', async () => {
    const request = deferred<void>();
    server.use(
      profilesHandler([embeddingProfile, rerankProfile]),
      http.patch('/api/knowledge/model-profiles/profile_embed', async () => {
        await request.promise;
        return HttpResponse.json(embeddingProfile);
      }),
    );
    await mountProfiles();
    await click(button('编辑'));
    await fill('knowledge-profile-model', 'changed-model');
    await click(button('保存'));
    expect(button('关闭').disabled).toBe(true);
    expect(button('取消').disabled).toBe(true);
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    await flush();
    expect(document.getElementById('knowledge-profile-model')).toBeTruthy();
    expect(
      [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
        (item) => item.textContent?.trim() === '编辑',
      )[0]?.disabled,
    ).toBe(true);
    await act(async () => request.resolve());
    await flush();
  });

  it('unlocks closing and creating after a profile save succeeds', async () => {
    server.use(
      http.get('/api/knowledge/model-profiles', () => HttpResponse.json([embeddingProfile])),
      http.patch('/api/knowledge/model-profiles/profile_embed', () =>
        HttpResponse.json(embeddingProfile),
      ),
    );
    const onClose = vi.fn();
    await mountProfiles(onClose);
    await click(button('编辑'));
    await fill('knowledge-profile-model', 'bge-m3-v2');
    await click(button('保存'));
    // 保存成功后表单卸载，外层 pending 必须已解锁，否则关闭与新增会永久不可用。
    expect(button('关闭').disabled).toBe(false);
    expect(button('新增 profile').disabled).toBe(false);
    await click(button('关闭'));
    expect(document.body.textContent).not.toContain('放弃未保存的更改？');
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a retry instead of pretending profiles are empty when loading fails', async () => {
    server.use(
      http.get('/api/knowledge/model-profiles', () =>
        HttpResponse.json({ code: 'INTERNAL', message: 'profile 加载失败' }, { status: 500 }),
      ),
    );
    await mountProfiles();
    expect(document.body.textContent).toContain('模型 profile 没有加载出来');
    expect(document.body.textContent).not.toContain('还没有模型 profile');
    expect(button('重试')).toBeDefined();
  });
});

describe('knowledge model profiles', () => {
  it('shows the fix when an embedding endpoint rejects the credentials', async () => {
    server.use(
      http.get('/api/knowledge/model-profiles', () => HttpResponse.json([embeddingProfile])),
      http.post('/api/knowledge/model-profiles/profile_embed/test', () =>
        HttpResponse.json({ ok: false, kind: 'auth' }),
      ),
    );
    await mountProfiles();
    await click(button('测试'));
    expect(document.body.textContent).toContain('凭证被端点拒绝');
  });

  it('keeps each parallel test result when they finish out of order', async () => {
    const embedRequest = deferred<void>();
    const rerankRequest = deferred<void>();
    server.use(
      profilesHandler([embeddingProfile, rerankProfile]),
      http.post('/api/knowledge/model-profiles/profile_embed/test', async () => {
        await embedRequest.promise;
        return HttpResponse.json(
          { code: 'INTERNAL', message: 'embedding 测试失败' },
          { status: 500 },
        );
      }),
      http.post('/api/knowledge/model-profiles/profile_rerank/test', async () => {
        await rerankRequest.promise;
        return HttpResponse.json({ ok: true });
      }),
    );
    await mountProfiles();
    const testButtons = () =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
        (item) => item.textContent?.trim() === '测试',
      );
    await click(testButtons()[0] as HTMLButtonElement);
    await click(testButtons()[1] as HTMLButtonElement);
    expect(testButtons()[0]?.disabled).toBe(true);
    expect(testButtons()[1]?.disabled).toBe(true);

    // 后发的 rerank 先完成，先发的 embedding 仍在途。
    await act(async () => rerankRequest.resolve());
    await flush();
    expect(testButtons()[0]?.disabled).toBe(true);
    expect(testButtons()[1]?.disabled).toBe(false);

    // 先发的 embedding 随后以 HTTP 错误完成并走 catch，不能覆盖 rerank 的结果。
    await act(async () => embedRequest.resolve());
    await flush();

    const rows = [...document.querySelectorAll<HTMLElement>('li')];
    const embedRow = rows.find((row) => row.textContent?.includes('bge-m3'));
    const rerankRow = rows.find((row) => row.textContent?.includes('bge-reranker'));
    expect(rerankRow?.textContent).toContain('连接正常');
    expect(embedRow?.textContent).toContain('服务端暂时无法完成请求');
    expect(embedRow?.textContent).not.toContain('测试中');
    expect(testButtons()[0]?.disabled).toBe(false);
    expect(testButtons()[1]?.disabled).toBe(false);
  });

  it('keeps the stored secret when the edit form leaves it blank', async () => {
    server.use(
      http.get('/api/knowledge/model-profiles', () => HttpResponse.json([embeddingProfile])),
      http.patch('/api/knowledge/model-profiles/profile_embed', () =>
        HttpResponse.json(embeddingProfile),
      ),
    );
    await mountProfiles();
    await click(button('编辑'));
    await fill('knowledge-profile-model', 'bge-m3-v2');
    await click(button('保存'));
    const body = calls.find(
      (item) =>
        item.method === 'PATCH' && item.path === '/api/knowledge/model-profiles/profile_embed',
    )?.body;
    expect(body).toMatchObject({ model: 'bge-m3-v2' });
    expect(body).not.toHaveProperty('apiKey');
  });

  it('sends the embedding protocol and image input on profile create', async () => {
    server.use(
      http.get('/api/knowledge/model-profiles', () => HttpResponse.json([])),
      http.post('/api/knowledge/model-profiles', () => HttpResponse.json(cohereProfile)),
    );
    await mountProfiles();
    await click(button('新增 profile'));
    await fill('knowledge-profile-name', 'embed-v4.0');
    await fill('knowledge-profile-endpoint', 'https://models.example.com/v2');
    await fill('knowledge-profile-model', 'embed-v4.0');
    await selectOption('knowledge-profile-protocol', 'Cohere v2');
    await toggle('knowledge-profile-image-input');
    await click(button('保存'));
    expect(
      calls.find((item) => item.method === 'POST' && item.path === '/api/knowledge/model-profiles')
        ?.body,
    ).toMatchObject({
      kind: 'embedding',
      model: 'embed-v4.0',
      embeddingProtocol: 'cohere_v2',
      imageInputEnabled: true,
    });
  });

  it('keeps image input off for a non-Cohere embedding model', async () => {
    server.use(
      http.get('/api/knowledge/model-profiles', () => HttpResponse.json([])),
      http.post('/api/knowledge/model-profiles', () => HttpResponse.json(embeddingProfile)),
    );
    await mountProfiles();
    await click(button('新增 profile'));
    await fill('knowledge-profile-name', 'bge-m3');
    await fill('knowledge-profile-endpoint', 'https://models.example.com');
    await fill('knowledge-profile-model', 'bge-m3');
    await selectOption('knowledge-profile-protocol', 'Cohere v2');
    const imageInput = document.getElementById(
      'knowledge-profile-image-input',
    ) as HTMLButtonElement;
    expect(imageInput.disabled).toBe(true);
    expect(document.body.textContent).toContain('embed-v4.0');
  });

  it('surfaces the binding conflict when deleting a profile still in use', async () => {
    server.use(
      http.get('/api/knowledge/model-profiles', () => HttpResponse.json([embeddingProfile])),
      http.delete('/api/knowledge/model-profiles/profile_embed', () =>
        HttpResponse.json(
          { code: 'CONFLICT', message: '该 profile 仍被知识库使用，请先切换或删除知识库' },
          { status: 409 },
        ),
      ),
    );
    await mountProfiles();
    await click(button('删除'));
    await click(button('确认删除'));
    expect(toastError).toHaveBeenCalledWith(
      expect.objectContaining({ message: '该 profile 仍被知识库使用，请先切换或删除知识库' }),
    );
  });
});
