import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.js';
import { searchConversationsOptions } from '../src/lib/queries.js';

function mockFetch(response: Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response);
}

afterEach(() => {
  vi.restoreAllMocks();
});

const response = {
  items: [
    {
      id: 'conv_1',
      agentId: 'agt_1',
      agentName: '研究员',
      title: '标题',
      updatedAt: '2026-10-29T00:00:00.000Z',
      match: { kind: 'message' as const, excerpt: '正文' },
    },
  ],
  nextBefore: 'cursor-1',
};

describe('conversation search client', () => {
  it('passes every option through the query string and returns the response as-is', async () => {
    const fetch = mockFetch(Response.json(response));
    const controller = new AbortController();
    await expect(
      api.searchConversations(
        { q: '项目 进度', agentId: 'agt_1', limit: 5, before: 'cursor-0' },
        controller.signal,
      ),
    ).resolves.toEqual(response);

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(
      '/api/conversations/search?q=%E9%A1%B9%E7%9B%AE+%E8%BF%9B%E5%BA%A6&agentId=agt_1&limit=5&before=cursor-0',
    );
    expect(init?.signal).toBe(controller.signal);
  });

  it('omits undefined options', async () => {
    const fetch = mockFetch(Response.json({ items: [], nextBefore: null }));
    await api.searchConversations({});
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/conversations/search');
  });

  it('exposes searchConversationsOptions for the UI domain', () => {
    const options = searchConversationsOptions({ q: '进', agentId: 'agt_1', limit: 10 });
    expect(options.queryKey).toEqual(['conversation-search', '进', 'agt_1', 10, null]);
    expect(typeof options.queryFn).toBe('function');
  });
});
