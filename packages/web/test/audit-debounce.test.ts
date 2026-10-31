import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 审计筛选的真实防抖：每个字符都改 URL，但只有停顿 300ms 后才换查询键。
 * useDeferredValue 只让渲染降级，不会减少请求，因此这里直接数 api.audit 的调用。
 */

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  exportAudit: vi.fn(),
}));

const router = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  render: null as null | (() => void),
}));

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => router.search,
  useNavigate: () => async (options: { search?: Record<string, unknown> }) => {
    router.search = options.search ?? {};
    router.render?.();
  },
}));

vi.mock('../src/lib/api.js', () => ({
  api: { audit: mocks.audit, exportAudit: mocks.exportAudit },
  ApiError: class ApiError extends Error {},
  errorMessage: (error: unknown) => String(error),
}));

import { AuditPage } from '../src/pages/audit.js';

function Harness() {
  const [, rerender] = useReducer((value: number) => value + 1, 0);
  router.render = rerender;
  return createElement(AuditPage);
}

function entry(id: string) {
  return {
    id,
    actor: 'admin',
    action: 'agent.create',
    target: null,
    status: 'ok' as const,
    durationMs: null,
    requestId: null,
    inputDigest: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function input(label: string): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!found) throw new Error(`missing input ${label}`);
  return found;
}

async function type(label: string, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('input value setter unavailable');
  await act(async () => {
    setter.call(input(label), value);
    input(label).dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function exportButton(): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((button) =>
    ['导出审计', '等待筛选…', '导出中…'].some((label) => button.textContent?.includes(label)),
  );
  if (!found) throw new Error('missing export button');
  return found;
}

beforeEach(() => {
  vi.useFakeTimers();
  router.search = {};
  mocks.audit.mockReset().mockResolvedValue({ items: [entry('e1')] });
  mocks.exportAudit.mockReset().mockResolvedValue({ items: [] });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  client.clear();
  vi.useRealTimers();
});

describe('audit filter debounce', () => {
  it('updates the input immediately but sends one request after the typing pause', async () => {
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(Harness)));
    });
    await flush();
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenLastCalledWith({ limit: 100 }, expect.anything());

    await type('按动作前缀过滤', 'a');
    await type('按动作前缀过滤', 'ab');
    await type('按动作前缀过滤', 'abc');
    expect(input('按动作前缀过滤').value).toBe('abc');
    expect(router.search.action).toBe('abc');
    expect(mocks.audit).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(mocks.audit).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await flush();
    expect(mocks.audit).toHaveBeenCalledTimes(2);
    expect(mocks.audit).toHaveBeenLastCalledWith({ action: 'abc', limit: 100 }, expect.anything());
  });

  it('keeps export disabled until the pending filter takes effect, then clears immediately', async () => {
    router.search = { action: 'agent.' };
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(Harness)));
    });
    await flush();
    expect(exportButton().disabled).toBe(false);

    const clear = document.querySelector<HTMLButtonElement>(
      'button[aria-label="清除：按动作前缀过滤"]',
    );
    if (!clear) throw new Error('missing clear button');
    await act(async () => clear.click());

    // URL 与输入框立即清空，但查询还要等防抖落定；导出入口用可见文字说明为什么不可点。
    expect(input('按动作前缀过滤').value).toBe('');
    expect(router.search.action).toBeUndefined();
    expect(exportButton().disabled).toBe(true);
    expect(exportButton().textContent).toBe('等待筛选…');
    expect(mocks.audit).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await flush();
    expect(exportButton().disabled).toBe(false);
    expect(exportButton().textContent).toContain('导出审计');
    expect(mocks.audit).toHaveBeenLastCalledWith({ limit: 100 }, expect.anything());
  });

  it('resets pagination when the settled filter changes', async () => {
    mocks.audit.mockImplementation(async (query: { beforeId?: string; action?: string }) => {
      if (query.beforeId) return { items: [entry('older')] };
      if (query.action) return { items: [entry('filtered')] };
      return { items: Array.from({ length: 100 }, (_, index) => entry(`e${index}`)) };
    });
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(Harness)));
    });
    await flush();
    expect(mocks.audit).toHaveBeenCalledTimes(1);

    const loadMore = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('加载更多'),
    );
    if (!loadMore) throw new Error('missing load more button');
    await act(async () => loadMore.click());
    await flush();
    expect(mocks.audit).toHaveBeenLastCalledWith(
      { limit: 100, beforeId: 'e99' },
      expect.anything(),
    );

    await type('按动作前缀过滤', 'agent.');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await flush();
    // 新条件从第一页重新取，不复用旧游标。
    expect(mocks.audit).toHaveBeenLastCalledWith(
      { action: 'agent.', limit: 100 },
      expect.anything(),
    );
  });
});
