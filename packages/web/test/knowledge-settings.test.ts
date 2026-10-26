import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KnowledgeProfilesDialog,
  KnowledgeSettingsDialog,
} from '../src/components/knowledge-settings.js';
import { toastError, toastSuccess } from '../src/lib/toast.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

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

const state = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; path: string; body: unknown }>,
  handlers: {} as Record<string, unknown>,
  failures: {} as Record<string, { status: number; message: string }>,
}));

beforeEach(() => {
  state.calls.length = 0;
  state.handlers = {};
  state.failures = {};
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
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const raw = typeof init?.body === 'string' ? init.body : null;
    const body = raw === null ? undefined : (JSON.parse(raw) as unknown);
    state.calls.push({ method, path, body });
    const failure = state.failures[`${method} ${path}`];
    if (failure) {
      return Response.json(
        { code: 'CONFLICT', message: failure.message },
        { status: failure.status },
      );
    }
    const value = state.handlers[`${method} ${path}`];
    return Response.json(value ?? null);
  });
});

let client: QueryClient | undefined;
let host: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  client?.clear();
  host?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

async function mount(element: ReactElement) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(QueryClientProvider, { client }, element));
  });
  await flush();
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

async function toggle(id: string) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing switch: ${id}`);
  await click(element);
}

function mountSettings(selected = base) {
  return mount(
    createElement(KnowledgeSettingsDialog, {
      base: selected,
      onClose: vi.fn(),
      finalFocus: () => null,
    }),
  );
}

function mountProfiles() {
  return mount(
    createElement(KnowledgeProfilesDialog, { onClose: vi.fn(), finalFocus: () => null }),
  );
}

describe('knowledge base settings', () => {
  it('saves chunk settings and the rerank profile through the base patch', async () => {
    state.handlers['GET /api/knowledge/model-profiles'] = [embeddingProfile, rerankProfile];
    state.handlers['PATCH /api/knowledge/bases/kb_1'] = { ...base, rerankProfileId: null };
    await mountSettings();
    expect(document.body.textContent).toContain('知识库设置');
    await fill('knowledge-settings-chunk-tokens', '1000');
    await fill('knowledge-settings-chunk-overlap', '150');
    await click(button('保存设置'));
    expect(
      state.calls.find(
        (item) => item.method === 'PATCH' && item.path === '/api/knowledge/bases/kb_1',
      )?.body,
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

  it('saves the image processing group with the gateway vision model id', async () => {
    state.handlers['GET /api/knowledge/model-profiles'] = [cohereProfile, rerankProfile];
    state.handlers['PATCH /api/knowledge/bases/kb_1'] = cohereBase;
    await mountSettings(cohereBase);
    await fill('knowledge-settings-image-model', 'claude-vision');
    await fill('knowledge-settings-image-language', 'en-US');
    await fill('knowledge-settings-image-instructions', '保留表格结构');
    await click(button('保存设置'));
    const body = state.calls.find(
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
    state.handlers['GET /api/knowledge/model-profiles'] = [cohereProfile, rerankProfile];
    await mountSettings();
    await toggle('knowledge-settings-image-enabled');
    await click(button('保存设置'));
    expect(document.body.textContent).toContain('开启图片处理需要视觉模型');
    expect(
      state.calls.some(
        (item) => item.method === 'PATCH' && item.path === '/api/knowledge/bases/kb_1',
      ),
    ).toBe(false);
  });

  it('only offers image vectors when the bound profile is Cohere embed-v4.0 with images', async () => {
    state.handlers['GET /api/knowledge/model-profiles'] = [embeddingProfile, rerankProfile];
    await mountSettings({ ...cohereBase, embeddingProfileId: 'profile_embed' });
    const vector = document.getElementById('knowledge-settings-image-vector') as HTMLButtonElement;
    expect(vector.disabled).toBe(true);
    expect(document.body.textContent).toContain('需要 Cohere embed-v4.0');
  });

  it('enables image vectors and the score floor on a capable profile', async () => {
    state.handlers['GET /api/knowledge/model-profiles'] = [cohereProfile, rerankProfile];
    state.handlers['PATCH /api/knowledge/bases/kb_1'] = cohereBase;
    await mountSettings(cohereBase);
    await toggle('knowledge-settings-image-vector');
    await fill('knowledge-settings-image-min-score', '0.5');
    await click(button('保存设置'));
    const body = state.calls.find(
      (item) => item.method === 'PATCH' && item.path === '/api/knowledge/bases/kb_1',
    )?.body as { settings: { imageProcessing: Record<string, unknown> } } | undefined;
    expect(body?.settings.imageProcessing).toMatchObject({
      imageVectorEnabled: true,
      imageVectorMinScore: 0.5,
    });
  });

  it('shows the API conflict when image vectors are rejected', async () => {
    state.handlers['GET /api/knowledge/model-profiles'] = [cohereProfile, rerankProfile];
    state.failures['PATCH /api/knowledge/bases/kb_1'] = {
      status: 409,
      message: '图片向量需要 Cohere embed-v4.0 且 profile 已开启图片输入',
    };
    await mountSettings(cohereBase);
    await click(button('保存设置'));
    expect(vi.mocked(toastError).mock.calls[0]?.[0]).toMatchObject({
      message: '图片向量需要 Cohere embed-v4.0 且 profile 已开启图片输入',
    });
  });

  it('asks before a whole rebuild because it overwrites manual chunk edits', async () => {
    state.handlers['GET /api/knowledge/model-profiles'] = [embeddingProfile, rerankProfile];
    state.handlers['POST /api/knowledge/bases/kb_1/rebuild'] = { jobId: 'kjob_9' };
    await mountSettings();
    await click(button('重建全部索引'));
    expect(document.body.textContent).toContain('手动改过的文案会丢失');
    await click(button('确认重建'));
    expect(
      state.calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/rebuild',
      )?.body,
    ).toEqual({ chunksOnly: false });
    expect(toastSuccess).toHaveBeenCalled();
  });
});

describe('knowledge model profiles', () => {
  it('shows the fix when an embedding endpoint rejects the credentials', async () => {
    state.handlers['GET /api/knowledge/model-profiles'] = [embeddingProfile];
    state.handlers['POST /api/knowledge/model-profiles/profile_embed/test'] = {
      ok: false,
      kind: 'auth',
    };
    await mountProfiles();
    await click(button('测试'));
    expect(document.body.textContent).toContain('凭证被端点拒绝');
  });

  it('keeps the stored secret when the edit form leaves it blank', async () => {
    state.handlers['GET /api/knowledge/model-profiles'] = [embeddingProfile];
    state.handlers['PATCH /api/knowledge/model-profiles/profile_embed'] = embeddingProfile;
    await mountProfiles();
    await click(button('编辑'));
    await fill('knowledge-profile-model', 'bge-m3-v2');
    await click(button('保存'));
    const body = state.calls.find(
      (item) =>
        item.method === 'PATCH' && item.path === '/api/knowledge/model-profiles/profile_embed',
    )?.body;
    expect(body).toMatchObject({ model: 'bge-m3-v2' });
    expect(body).not.toHaveProperty('apiKey');
  });

  it('sends the embedding protocol and image input on profile create', async () => {
    state.handlers['GET /api/knowledge/model-profiles'] = [];
    state.handlers['POST /api/knowledge/model-profiles'] = cohereProfile;
    await mountProfiles();
    await click(button('新增 profile'));
    await fill('knowledge-profile-name', 'embed-v4.0');
    await fill('knowledge-profile-endpoint', 'https://models.example.com/v2');
    await fill('knowledge-profile-model', 'embed-v4.0');
    await selectOption('knowledge-profile-protocol', 'Cohere v2');
    await toggle('knowledge-profile-image-input');
    await click(button('保存'));
    expect(
      state.calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/model-profiles',
      )?.body,
    ).toMatchObject({
      kind: 'embedding',
      model: 'embed-v4.0',
      embeddingProtocol: 'cohere_v2',
      imageInputEnabled: true,
    });
  });

  it('keeps image input off for a non-Cohere embedding model', async () => {
    state.handlers['GET /api/knowledge/model-profiles'] = [];
    state.handlers['POST /api/knowledge/model-profiles'] = embeddingProfile;
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
    state.handlers['GET /api/knowledge/model-profiles'] = [embeddingProfile];
    state.failures['DELETE /api/knowledge/model-profiles/profile_embed'] = {
      status: 409,
      message: '该 profile 仍被知识库使用，请先切换或删除知识库',
    };
    await mountProfiles();
    await click(button('删除'));
    await click(button('确认删除'));
    expect(toastError).toHaveBeenCalledWith(
      expect.objectContaining({ message: '该 profile 仍被知识库使用，请先切换或删除知识库' }),
    );
  });
});
