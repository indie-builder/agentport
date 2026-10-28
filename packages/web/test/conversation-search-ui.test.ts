import type { ConversationSearchItem, ConversationSearchResponse } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationSearch } from '../src/components/conversation-search.js';
import { api } from '../src/lib/api.js';

const item = (id: string, title: string, overrides: Partial<ConversationSearchItem> = {}) => ({
  id,
  agentId: 'agent-b',
  agentName: '研究员',
  title,
  updatedAt: '2026-10-29T00:00:00.000Z',
  match: null,
  ...overrides,
});

const response = (
  items: ConversationSearchItem[],
  nextBefore: string | null = null,
): ConversationSearchResponse => ({ items, nextBefore });

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;
let onSelect: ReturnType<typeof vi.fn>;
let onOpenChange: ReturnType<typeof vi.fn>;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function mount(): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ConversationSearch, {
          open: true,
          onOpenChange,
          onSelect,
        }),
      ),
    );
  });
  await flush();
}

function searchInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索会话"]');
  if (!input) throw new Error('Missing search input');
  return input;
}

async function setInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(input: HTMLInputElement, key: string, which = 0): Promise<void> {
  await act(async () => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'which', { value: which });
    Object.defineProperty(event, 'keyCode', { value: which });
    input.dispatchEvent(event);
  });
  await flush();
}

async function waitForDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  await flush();
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  onSelect = vi.fn();
  onOpenChange = vi.fn();
});

afterEach(async () => {
  await act(async () => root.unmount());
  root = undefined as unknown as Root;
  host.remove();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('conversation search overlay', () => {
  it('loads recent conversations from every expert when the query is empty', async () => {
    const search = vi
      .spyOn(api, 'searchConversations')
      .mockResolvedValue(
        response([
          item('c1', '项目进度同步', { match: { kind: 'message', excerpt: '今天的进展' } }),
        ]),
      );
    await mount();

    expect(search).toHaveBeenCalledWith({ limit: 20 }, expect.anything());
    expect(document.body.textContent).toContain('所有专家');
    expect(document.body.textContent).toContain('项目进度同步');
    expect(document.body.textContent).toContain('研究员');
    expect(document.body.textContent).toContain('今天的进展');
  });

  it('debounces typing and only queries the settled text', async () => {
    const search = vi.spyOn(api, 'searchConversations').mockResolvedValue(response([]));
    await mount();
    search.mockClear();

    await setInput(searchInput(), '进');
    await setInput(searchInput(), '进度');
    await waitForDebounce();

    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith({ q: '进度', limit: 20 }, expect.anything());
  });

  it('selects the highlighted result with arrow keys and Enter', async () => {
    vi.spyOn(api, 'searchConversations').mockResolvedValue(
      response([item('c1', '项目进度同步'), item('c2', '另一条会话')]),
    );
    await mount();

    const input = searchInput();
    await press(input, 'ArrowDown');
    await press(input, 'ArrowUp');
    await press(input, 'Enter', 13);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }));
  });

  it('opens the highlighted result after typing and waiting for results', async () => {
    vi.spyOn(api, 'searchConversations').mockResolvedValue(
      response([item('c1', '项目进度同步'), item('c2', '另一条会话')]),
    );
    await mount();

    const input = searchInput();
    await setInput(input, 'q');
    await waitForDebounce();
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options).toHaveLength(2);

    await press(input, 'ArrowDown');
    const highlighted = document.querySelector<HTMLElement>('[role="option"][data-highlighted]');
    expect(highlighted?.textContent).toContain('另一条会话');
    await press(input, 'Enter', 13);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'c2' }));
    expect(input.value).toBe('q');
  });

  it('selects with the real highlighted item even when the synthesized click never runs', async () => {
    vi.spyOn(api, 'searchConversations').mockResolvedValue(
      response([item('c1', '项目进度同步'), item('c2', '另一条会话')]),
    );
    // Base UI 的 Enter 依赖对列表项合成 click；浏览器里这条路径可能不触发 React 事件。
    const syntheticClick = vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(() => {});
    await mount();

    const input = searchInput();
    await press(input, 'ArrowDown');
    await press(input, 'Enter', 13);

    expect(syntheticClick).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'c2' }));
    expect(input.value).toBe('');
    syntheticClick.mockRestore();
  });

  it('selects a pointer target once', async () => {
    vi.spyOn(api, 'searchConversations').mockResolvedValue(response([item('c1', '项目进度同步')]));
    await mount();

    const option = document.querySelector<HTMLElement>('[role="option"]');
    if (!option) throw new Error('Missing search result');
    await act(async () => option.click());
    await flush();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }));
  });

  it('does not open a result while an IME composition confirms with Enter', async () => {
    vi.spyOn(api, 'searchConversations').mockResolvedValue(response([item('c1', '项目进度同步')]));
    await mount();

    const input = searchInput();
    await act(async () => {
      input.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    });
    await press(input, 'Enter', 229);
    await act(async () => {
      input.dispatchEvent(new Event('compositionend', { bubbles: true }));
    });

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('appends the next page and keeps the cursor in the request', async () => {
    const search = vi.spyOn(api, 'searchConversations');
    search.mockResolvedValueOnce(response([item('c1', '第一页')], 'cursor-1'));
    search.mockResolvedValueOnce(response([item('c2', '第二页')]));
    await mount();

    const more = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '加载更多',
    );
    if (!more) throw new Error('Missing load more button');
    await act(async () => more.click());
    await flush();

    expect(search).toHaveBeenLastCalledWith({ limit: 20, before: 'cursor-1' }, expect.anything());
    expect(document.body.textContent).toContain('第一页');
    expect(document.body.textContent).toContain('第二页');
  });

  it('offers a retry after the first page fails', async () => {
    const search = vi.spyOn(api, 'searchConversations');
    search.mockRejectedValueOnce(new Error('搜索服务暂时不可用'));
    search.mockResolvedValueOnce(response([item('c1', '恢复正常')]));
    await mount();

    expect(document.body.textContent).toContain('搜索服务暂时不可用');
    const retry = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '重试',
    );
    if (!retry) throw new Error('Missing retry button');
    await act(async () => retry.click());
    await flush();

    expect(document.body.textContent).toContain('恢复正常');
  });

  it('reports a failed refetch over cached results and keeps the old list', async () => {
    const search = vi
      .spyOn(api, 'searchConversations')
      .mockResolvedValueOnce(response([item('c1', '缓存结果')]));
    await mount();
    expect(document.body.textContent).toContain('缓存结果');

    search.mockRejectedValueOnce(new Error('重新加载失败'));
    await act(async () => {
      await client.refetchQueries({
        queryKey: ['conversation-search', '', null, 20, null],
      });
    });
    await flush();

    expect(document.body.textContent).toContain('缓存结果');
    expect(document.body.textContent).toContain('重新加载失败');
    const retry = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '重试',
    );
    if (!retry) throw new Error('Missing retry button');

    search.mockResolvedValueOnce(response([item('c1', '缓存结果'), item('c2', '新结果')]));
    await act(async () => retry.click());
    await flush();
    expect(document.body.textContent).toContain('新结果');
  });

  it('keeps the next-page retry button and earlier pages when appending fails', async () => {
    const search = vi.spyOn(api, 'searchConversations');
    search.mockResolvedValueOnce(response([item('c1', '第一页')], 'cursor-1'));
    search.mockRejectedValueOnce(new Error('下一页失败'));
    await mount();

    const more = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '加载更多',
    );
    if (!more) throw new Error('Missing load more button');
    await act(async () => more.click());
    await flush();

    expect(document.body.textContent).toContain('第一页');
    expect(document.body.textContent).not.toContain('下一页失败');
    const retry = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '加载失败，重试',
    );
    if (!retry) throw new Error('Missing next-page retry button');

    search.mockResolvedValueOnce(response([item('c2', '第二页')]));
    await act(async () => retry.click());
    await flush();
    expect(document.body.textContent).toContain('第一页');
    expect(document.body.textContent).toContain('第二页');
  });

  it('clears the query and returns to the recent conversations request', async () => {
    const search = vi.spyOn(api, 'searchConversations').mockResolvedValue(response([]));
    await mount();

    await setInput(searchInput(), '进度');
    await waitForDebounce();
    expect(search).toHaveBeenLastCalledWith({ q: '进度', limit: 20 }, expect.anything());

    const clear = document.querySelector<HTMLButtonElement>('button[aria-label="清除搜索"]');
    if (!clear) throw new Error('Missing clear button');
    await act(async () => clear.click());
    await waitForDebounce();

    expect(searchInput().value).toBe('');
    expect(search).toHaveBeenLastCalledWith({ limit: 20 }, expect.anything());
  });
});
