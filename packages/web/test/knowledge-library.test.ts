import { HttpResponse, http } from 'msw';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { toastError } from '../src/lib/toast.js';
import {
  base,
  baseHandlers,
  button,
  calls,
  chooseFilter,
  chooseMenuItem,
  chunk,
  cleanup,
  click,
  detailsHandler,
  dialog,
  doc,
  fill,
  flush,
  markdownResponse,
  mount,
  mountState,
  msw,
  openMenu,
  patchBody,
  registerKnowledgeHarness,
  server,
  waitFor,
} from './knowledge-harness.js';
import { runCleanup } from './msw.js';

vi.mock('../src/lib/toast.js', () => ({
  toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

registerKnowledgeHarness();

describe('knowledge polling window', () => {
  it('keeps polling an active recent job but stops past its type timeout', async () => {
    const { knowledgeShouldPoll } = await import('../src/lib/queries.js');
    const now = new Date().toISOString();
    const stale = new Date(Date.now() - 31 * 60_000).toISOString();
    expect(knowledgeShouldPoll(undefined)).toBe(false);
    expect(knowledgeShouldPoll([{ status: 'running', startedAt: now, createdAt: stale }])).toBe(
      true,
    );
    expect(knowledgeShouldPoll([{ status: 'running', startedAt: null, createdAt: stale }])).toBe(
      false,
    );
    expect(knowledgeShouldPoll([{ status: 'succeeded', startedAt: now, createdAt: now }])).toBe(
      false,
    );
  });

  it('uses the per-type timeout so a long ingest is not cut off at ten minutes', async () => {
    const { knowledgeShouldPoll } = await import('../src/lib/queries.js');
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60_000).toISOString();
    // ingest 硬超时 30 分钟：20 分钟时仍在合法窗口内。
    expect(
      knowledgeShouldPoll([
        {
          status: 'running',
          type: 'ingest',
          startedAt: twentyMinutesAgo,
          createdAt: twentyMinutesAgo,
        },
      ]),
    ).toBe(true);
    // wiki_generate 硬超时 15 分钟：20 分钟时已不可能还在跑。
    expect(
      knowledgeShouldPoll([
        {
          status: 'running',
          type: 'wiki_generate',
          startedAt: twentyMinutesAgo,
          createdAt: twentyMinutesAgo,
        },
      ]),
    ).toBe(false);
  });
});

describe('knowledge library list', () => {
  it('offers creation and shows a single h1 when there is no base', async () => {
    server.use(
      http.get('/api/knowledge/bases', () => HttpResponse.json({ items: [], nextCursor: null })),
      http.get('/api/agents', () => HttpResponse.json([])),
    );
    await mount('/knowledge');
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    expect(document.body.textContent).toContain('未创建知识库');
    expect(button('新建知识库')).toBeDefined();
  });

  it('links each base to its detail route with status and count', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [doc], nextCursor: null }),
      ),
    );
    await mount('/knowledge');
    const link = document.querySelector<HTMLAnchorElement>('a[href="/knowledge/kb_1"]');
    const row = link?.closest<HTMLElement>('li');
    expect(row).not.toBeNull();
    expect(row?.querySelectorAll('a[href="/knowledge/kb_1"]')).toHaveLength(1);
    expect(link?.getAttribute('aria-label')).toContain('产品手册');
    expect(row?.textContent).toContain('产品手册');
    expect(row?.textContent).toContain('内部知识');
    expect(document.body.textContent).toContain('启用');
    expect(document.body.textContent).toContain('共 1 个知识库');
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    // 列表不再逐库拉 200 条文档只为算数量。
    expect(
      calls.some(
        (item) =>
          item.path.startsWith('/api/knowledge/bases/kb_1/documents') &&
          item.path.includes('limit=200'),
      ),
    ).toBe(false);
  });

  it('covers the whole card with the detail link while keeping the action menu separate', async () => {
    baseHandlers();
    const router = await mount('/knowledge');
    const row = document
      .querySelector<HTMLAnchorElement>('a[href="/knowledge/kb_1"]')
      ?.closest<HTMLElement>('li');
    const link = row?.querySelector<HTMLAnchorElement>('a[href="/knowledge/kb_1"]');
    // 覆盖整卡：入口铺满卡片，描述也在点击范围内，而不是只有标题可点。
    expect(link?.closest('li')).toBe(row);
    expect(link?.className).toContain('absolute');
    expect(link?.className).toContain('inset-0');
    expect(row?.querySelectorAll('a')).toHaveLength(1);

    await openMenu('操作 产品手册');
    expect(document.querySelector('[role="menuitem"]')).not.toBeNull();
    expect(router.state.location.pathname).toBe('/knowledge');
  });

  it('filters the list by status from the toolbar and clears every filter together', async () => {
    const disabled = {
      ...base,
      id: 'kb_2',
      name: '研发手册',
      slug: 'engineering',
      status: 'disabled',
    };
    server.use(
      http.get('/api/knowledge/bases', () =>
        HttpResponse.json({ items: [base, disabled], nextCursor: null }),
      ),
      http.get('/api/agents', () => HttpResponse.json([])),
    );
    const router = await mount('/knowledge');
    expect(document.body.textContent).toContain('共 2 个知识库');

    const openStatusFilter = async (option: string) => {
      const trigger = button('筛选');
      if (trigger.getAttribute('aria-expanded') !== 'true') {
        await click(trigger);
      }
      await chooseFilter('按启用状态筛选', option);
    };

    await openStatusFilter('启用');
    expect(router.state.location.search).toMatchObject({ status: 'active' });
    expect(document.body.textContent).toContain('产品手册');
    expect(document.body.textContent).not.toContain('研发手册');
    // 数量按过滤后的可见项计。
    expect(document.body.textContent).toContain('共 1 个知识库');

    await openStatusFilter('停用');
    expect(router.state.location.search).toMatchObject({ status: 'disabled' });
    expect(document.body.textContent).toContain('研发手册');
    expect(document.body.textContent).not.toContain('产品手册');
    expect(document.body.textContent).toContain('共 1 个知识库');

    // 回到全部状态：URL 不再带 status，列表恢复完整。
    await openStatusFilter('全部状态');
    expect(router.state.location.search.status).toBeUndefined();
    expect(document.body.textContent).toContain('共 2 个知识库');

    // 关键词与状态同时无结果时，清除筛选把两者一起清空。
    await openStatusFilter('停用');
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索知识库"]');
      if (!input) throw new Error('Missing search input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        '不存在',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    expect(router.state.location.search).toMatchObject({ q: '不存在', status: 'disabled' });
    expect(document.body.textContent).toContain('没有匹配的知识库');

    await click(button('清除筛选'));
    expect(router.state.location.search).toEqual({});
    expect(document.body.textContent).toContain('产品手册');
    expect(document.body.textContent).toContain('研发手册');
  });

  it('pulls the remaining base pages so the count covers the whole library', async () => {
    server.use(
      http.get('/api/knowledge/bases', ({ request }) =>
        new URL(request.url).searchParams.get('cursor') === 'kb_cursor'
          ? HttpResponse.json({
              items: [{ ...base, id: 'kb_2', name: '研发手册', slug: 'engineering' }],
              nextCursor: null,
            })
          : HttpResponse.json({ items: [base], nextCursor: 'kb_cursor' }),
      ),
      http.get('/api/agents', () => HttpResponse.json([])),
    );
    await mount('/knowledge');
    expect(document.body.textContent).toContain('研发手册');
    expect(document.body.textContent).toContain('共 2 个知识库');
    expect(calls.some((item) => item.path.includes('cursor=kb_cursor'))).toBe(true);
  });
});

describe('knowledge base pins', () => {
  const engineering = {
    ...base,
    id: 'kb_2',
    slug: 'engineering',
    name: '研发手册',
    createdAt: '2026-01-03T00:00:00Z',
  };

  function rowNames(): string[] {
    return [...document.querySelectorAll<HTMLElement>('ul > li h2')].map(
      (item) => item.textContent ?? '',
    );
  }

  function lastPinBody(): unknown {
    return calls
      .filter((item) => item.method === 'PUT' && item.path === '/api/knowledge/bases/kb_1/pin')
      .at(-1)?.body;
  }

  it('moves a pinned base to the top and toggles it back from the row menu', async () => {
    let pinnedIds: string[] = [];
    server.use(
      http.get('/api/knowledge/bases', () =>
        HttpResponse.json({ items: [base, engineering], nextCursor: null }),
      ),
      http.get('/api/knowledge/bases/pins', () => HttpResponse.json({ baseIds: pinnedIds })),
      http.put('/api/knowledge/bases/kb_1/pin', async ({ request }) => {
        const body = (await request.json()) as { pinned: boolean };
        pinnedIds = body.pinned ? ['kb_1'] : [];
        return HttpResponse.json({ pinned: body.pinned });
      }),
      http.get('/api/agents', () => HttpResponse.json([])),
    );
    await mount('/knowledge');

    // 默认按创建时间倒序，置顶图标不出现。
    expect(rowNames()).toEqual(['研发手册', '产品手册']);
    expect(document.querySelector('[title="已置顶"]')).toBeNull();

    await openMenu('操作 产品手册');
    await chooseMenuItem('置顶');
    expect(lastPinBody()).toEqual({ pinned: true });
    await waitFor(() => rowNames()[0] === '产品手册');
    expect(rowNames()).toEqual(['产品手册', '研发手册']);
    expect(document.querySelector('[title="已置顶"]')).not.toBeNull();

    // 菜单在置顶后重新打开时已经变成「取消置顶」，再点一次恢复原顺序。
    await openMenu('操作 产品手册');
    await chooseMenuItem('取消置顶');
    expect(lastPinBody()).toEqual({ pinned: false });
    await waitFor(() => rowNames()[0] === '研发手册');
    expect(rowNames()).toEqual(['研发手册', '产品手册']);
    expect(document.querySelector('[title="已置顶"]')).toBeNull();
  });

  it('falls back to unpinned rows without a toast when the pin list fails', async () => {
    server.use(
      http.get('/api/knowledge/bases', () =>
        HttpResponse.json({ items: [base, engineering], nextCursor: null }),
      ),
      http.get('/api/knowledge/bases/pins', () =>
        HttpResponse.json(
          { code: 'INTERNAL_ERROR', status: 500, message: '置顶读取失败' },
          { status: 500 },
        ),
      ),
      http.get('/api/agents', () => HttpResponse.json([])),
    );
    await mount('/knowledge');
    expect(rowNames()).toEqual(['研发手册', '产品手册']);
    expect(document.querySelector('[title="已置顶"]')).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe('knowledge library lifecycle', () => {
  it('edits a base name and description from the row menu', async () => {
    baseHandlers();
    server.use(
      http.patch('/api/knowledge/bases/kb_1', () =>
        HttpResponse.json({ ...base, name: '研发手册' }),
      ),
    );
    await mount('/knowledge');
    await openMenu('操作 产品手册');
    await chooseMenuItem('编辑信息');
    await fill('knowledge-base-info-name', '研发手册');
    await fill('knowledge-base-info-description', '研发内部知识');
    await click(button('保存', dialog('编辑信息')));
    expect(patchBody('/api/knowledge/bases/kb_1')).toEqual({
      name: '研发手册',
      description: '研发内部知识',
    });
  });

  it('toggles base status without resending other settings', async () => {
    baseHandlers();
    server.use(
      http.patch('/api/knowledge/bases/kb_1', () =>
        HttpResponse.json({ ...base, status: 'disabled' }),
      ),
    );
    await mount('/knowledge');
    await openMenu('操作 产品手册');
    await chooseMenuItem('停用');
    expect(patchBody('/api/knowledge/bases/kb_1')).toEqual({ status: 'disabled' });
  });

  it('names the experts that lose the binding before deleting', async () => {
    baseHandlers();
    server.use(
      http.get('/api/agents', () =>
        HttpResponse.json([
          { id: 'agent_1', name: '产品专家', serverIds: ['srv_1'] },
          { id: 'agent_2', name: '无关专家', serverIds: [] },
        ]),
      ),
      http.delete('/api/knowledge/bases/kb_1', () => HttpResponse.json({})),
    );
    await mount('/knowledge');
    await openMenu('操作 产品手册');
    await chooseMenuItem('删除');
    const confirmation = dialog('删除知识库');
    expect(confirmation.textContent).toContain('产品专家');
    expect(confirmation.textContent).not.toContain('无关专家');
    await click(button('删除', confirmation));
    expect(
      calls.some((item) => item.method === 'DELETE' && item.path === '/api/knowledge/bases/kb_1'),
    ).toBe(true);
  });

  it('deletes a base with no bound experts without mentioning unbound experts', async () => {
    baseHandlers();
    server.use(
      http.get('/api/agents', () =>
        HttpResponse.json([{ id: 'agent_2', name: '无关专家', serverIds: [] }]),
      ),
      http.delete('/api/knowledge/bases/kb_1', () => HttpResponse.json({})),
    );
    await mount('/knowledge');
    await openMenu('操作 产品手册');
    await chooseMenuItem('删除');
    const confirmation = dialog('删除知识库');
    expect(confirmation.textContent).not.toContain('解除与');
    expect(confirmation.textContent).not.toContain('无关专家');
    await click(button('删除', confirmation));
    expect(
      calls.some((item) => item.method === 'DELETE' && item.path === '/api/knowledge/bases/kb_1'),
    ).toBe(true);
  });
});

describe('knowledge folder and tag management', () => {
  function folderHandlers() {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [doc], nextCursor: null }),
      ),
    );
  }

  it('creates, renames and deletes folders', async () => {
    folderHandlers();
    server.use(
      http.post('/api/knowledge/bases/kb_1/folders', () =>
        HttpResponse.json({
          id: 'kfd_1',
          baseId: 'kb_1',
          parentId: null,
          name: '规范',
          path: '/规范',
          createdAt: '',
        }),
      ),
      http.patch('/api/knowledge/folders/kfd_1', () =>
        HttpResponse.json({
          id: 'kfd_1',
          baseId: 'kb_1',
          parentId: null,
          name: '研发规范',
          path: '/研发规范',
          createdAt: '',
        }),
      ),
      http.delete('/api/knowledge/folders/kfd_1', () => HttpResponse.json({})),
    );
    await mount('/knowledge/kb_1');
    await click(button('新建文件夹'));
    await fill('knowledge-folder-name', '规范');
    await click(button('创建', dialog('新建文件夹')));
    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/folders',
      )?.body,
    ).toEqual({ parentId: null, name: '规范' });

    server.use(
      http.get('/api/knowledge/bases/kb_1/folders', () =>
        HttpResponse.json([
          {
            id: 'kfd_1',
            baseId: 'kb_1',
            parentId: null,
            name: '规范',
            path: '/规范',
            createdAt: '',
          },
        ]),
      ),
    );
    await mountState.client.invalidateQueries({ queryKey: ['knowledge', 'folders', 'kb_1'] });
    await flush();
    await openMenu('文件夹操作 规范');
    await chooseMenuItem('重命名');
    await fill('knowledge-folder-name', '研发规范');
    await click(button('保存', dialog('重命名文件夹')));
    expect(patchBody('/api/knowledge/folders/kfd_1')).toEqual({ name: '研发规范' });

    await openMenu('文件夹操作 规范');
    await chooseMenuItem('删除');
    await click(button('删除', dialog('删除文件夹')));
    expect(
      calls.some(
        (item) => item.method === 'DELETE' && item.path === '/api/knowledge/folders/kfd_1',
      ),
    ).toBe(true);
  });

  it('renames a tag inline and refreshes the list', async () => {
    folderHandlers();
    let renamed = false;
    server.use(
      http.get('/api/knowledge/bases/kb_1/tags', () =>
        HttpResponse.json([
          {
            id: 'ktag_1',
            baseId: 'kb_1',
            name: renamed ? '流程规范' : '流程',
            createdAt: '',
          },
        ]),
      ),
      http.patch('/api/knowledge/tags/ktag_1', () => {
        renamed = true;
        return HttpResponse.json({ id: 'ktag_1', baseId: 'kb_1', name: '流程规范', createdAt: '' });
      }),
    );
    await mount('/knowledge/kb_1');
    await click(button('管理标签'));
    await click(button('重命名标签 流程', dialog('管理标签')));
    await fill('knowledge-tag-rename', '流程规范');
    await click(button('保存', dialog('管理标签')));
    expect(patchBody('/api/knowledge/tags/ktag_1')).toEqual({ name: '流程规范' });
    expect(dialog('管理标签').textContent).toContain('流程规范');
  });

  it('adds and removes a tag', async () => {
    folderHandlers();
    server.use(
      http.post('/api/knowledge/bases/kb_1/tags', () =>
        HttpResponse.json({ id: 'ktag_2', baseId: 'kb_1', name: '合规', createdAt: '' }),
      ),
      http.delete('/api/knowledge/tags/ktag_1', () => HttpResponse.json({})),
    );
    await mount('/knowledge/kb_1');
    await click(button('管理标签'));
    await fill('knowledge-tag-name', '合规');
    await click(button('添加', dialog('管理标签')));
    expect(
      calls.find((item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/tags')
        ?.body,
    ).toEqual({ name: '合规' });
    await click(button('删除标签 流程', dialog('管理标签')));
    await click(button('删除', dialog('删除标签')));
    expect(
      calls.some((item) => item.method === 'DELETE' && item.path === '/api/knowledge/tags/ktag_1'),
    ).toBe(true);
  });
});

describe('knowledge pagination', () => {
  it('loads the next document page and appends it', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', ({ request }) =>
        new URL(request.url).searchParams.get('cursor') === 'kdoc_cursor'
          ? HttpResponse.json({
              items: [{ ...doc, id: 'kdoc_2', title: '第二页文档' }],
              nextCursor: null,
            })
          : HttpResponse.json({ items: [doc], nextCursor: 'kdoc_cursor' }),
      ),
    );
    await mount('/knowledge/kb_1');
    await click(button('加载更多文档'));
    expect(document.body.textContent).toContain('第二页文档');
    expect(calls.some((item) => item.path.includes('cursor=kdoc_cursor'))).toBe(true);
  });

  it('loads the next chunk page inside the document viewer', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [doc], nextCursor: null }),
      ),
      http.get('/api/knowledge/versions/kdv_1/markdown', () => markdownResponse('正文')),
      detailsHandler(),
      http.get('/api/knowledge/documents/kdoc_1/chunks', ({ request }) =>
        new URL(request.url).searchParams.get('cursor') === 'kchk_cursor'
          ? HttpResponse.json({
              items: [{ ...chunk, id: 'kchk_2', ordinal: 1, content: '第二页分块内容' }],
              nextCursor: null,
            })
          : HttpResponse.json({ items: [chunk], nextCursor: 'kchk_cursor' }),
      ),
    );
    await mount('/knowledge/kb_1');
    await click(button('上线流程'));
    await click(button('加载更多分块', dialog('上线流程')));
    expect(dialog('上线流程').textContent).toContain('第二页分块内容');
  });
});

describe('msw request body capture', () => {
  it('waits for a delayed request body and fails on a read error', async () => {
    // 流式 fetch 在 body 发送完前不会触发 request:start，这里直接发事件以控制读取时机。
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayedBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        await released;
        controller.enqueue(new TextEncoder().encode('{"delayed":true}'));
        controller.close();
      },
    });
    const delayed = new Request('http://localhost/api/msw/body', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: delayedBody,
      duplex: 'half',
    } as RequestInit);
    server.events.emit({ type: 'request:start', request: delayed } as never);
    // 未等 body 读完时这里就是 undefined；负向断言不能靠「看起来没有」通过。
    expect(calls[0]?.body).toBeUndefined();
    release();
    await msw.waitForRequests();
    expect(calls[0]?.body).toEqual({ delayed: true });

    const failedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"broken":'));
        controller.error(new Error('body read failed'));
      },
    });
    const failed = new Request('http://localhost/api/msw/body', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: failedBody,
      duplex: 'half',
    } as RequestInit);
    server.events.emit({ type: 'request:start', request: failed } as never);
    await expect(msw.waitForRequests()).rejects.toThrow('body read failed');
  });
});

describe('msw cleanup fault injection', () => {
  it('runs every shared cleanup step and rethrows the first failure', async () => {
    const steps: string[] = [];
    await expect(
      runCleanup([
        () => {
          steps.push('clear');
          throw new Error('clear failed');
        },
        () => {
          steps.push('remove');
          throw new Error('remove failed');
        },
        () => {
          steps.push('assertClean');
        },
      ]),
    ).rejects.toThrow('clear failed');
    expect(steps).toEqual(['clear', 'remove', 'assertClean']);
  });

  function expectRestored() {
    expect(server.listHandlers()).toHaveLength(0);
    expect('ResizeObserver' in globalThis).toBe(false);
    expect(vi.isMockFunction(window.scrollTo)).toBe(false);
    const { root, client, host } = mountState;
    expect(root).toBeUndefined();
    expect(client).toBeUndefined();
    expect(host).toBeUndefined();
  }

  it('still restores handlers, globals and mocks after a body read rejection', async () => {
    server.use(http.get('/api/knowledge/bases', () => HttpResponse.json([])));
    const failedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"broken":'));
        controller.error(new Error('body read failed'));
      },
    });
    server.events.emit({
      type: 'request:start',
      request: new Request('http://localhost/api/msw/body', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: failedBody,
        duplex: 'half',
      } as RequestInit),
    } as never);
    await expect(cleanup()).rejects.toThrow('body read failed');
    expectRestored();
  });

  it('still restores handlers, globals and mocks when unmount throws', async () => {
    server.use(http.get('/api/knowledge/bases', () => HttpResponse.json([])));
    mountState.host = document.createElement('div');
    document.body.append(mountState.host);
    mountState.root = createRoot(mountState.host);
    const { root: mountedRoot, host: mountedHost } = mountState;
    await act(async () => mountedRoot.render(createElement('p', null, 'mounted')));
    expect(mountedHost.childNodes).toHaveLength(1);
    // cleanup 会先清空 root，回调必须用快照才能真正卸载；先卸载再抛错只替代「unmount 抛出」信号。
    await expect(
      cleanup(async () => {
        await act(async () => mountedRoot.unmount());
        throw new Error('unmount failed');
      }),
    ).rejects.toThrow('unmount failed');
    // host.remove() 只摘节点不清空子树：子节点消失才是 React root 真卸载的证据。
    expect(mountedHost.childNodes).toHaveLength(0);
    expectRestored();
  });
});
