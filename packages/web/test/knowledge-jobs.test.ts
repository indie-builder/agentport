import type { KnowledgeJob } from '@agentport/shared';
import { PERMISSIONS } from '@agentport/shared';
import { HttpResponse, http } from 'msw';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  baseHandlers,
  button,
  calls,
  chooseMenuItem,
  click,
  dialog,
  dialogShown,
  doc,
  documentList,
  faqSummary,
  fill,
  findButton,
  flush,
  mount,
  openMenu,
  registerKnowledgeHarness,
  server,
  waitFor,
  wikiPageSummary,
} from './knowledge-harness.js';

vi.mock('../src/lib/toast.js', () => ({
  toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

registerKnowledgeHarness();

type KnowledgeJobFixture = KnowledgeJob & {
  documentId: string | null;
  sourceId: string | null;
  documentTitle: string | null;
  sourceName: string | null;
};

function jobFixture(
  overrides: Partial<KnowledgeJobFixture> & Pick<KnowledgeJobFixture, 'id' | 'type' | 'status'>,
): KnowledgeJobFixture {
  return {
    step: null,
    progress: 0,
    attempts: 1,
    error: null,
    createdAt: '2026-01-02T00:00:00Z',
    startedAt: '2026-01-02T00:00:00Z',
    endedAt: null,
    documentId: null,
    sourceId: null,
    documentTitle: null,
    sourceName: null,
    ...overrides,
  };
}

function meWith(ids: readonly string[]) {
  return {
    authenticated: true as const,
    user: { businessId: 'test-admin', username: 'admin', name: '测试管理员' },
    roles: [],
    grants: PERMISSIONS.filter((permission) => ids.includes(permission.id)).flatMap(
      (permission) => {
        const scope = permission.scopes[0];
        return scope ? [{ permissionId: permission.id, scope }] : [];
      },
    ),
  };
}

function menuLabels(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
    (item) => item.textContent?.trim() ?? '',
  );
}

function overviewHandlers() {
  server.use(
    http.get('/api/knowledge/bases/kb_1/summary', () =>
      HttpResponse.json({
        documents: 0,
        faqs: 0,
        wikiPages: 0,
        sources: 0,
        folders: 0,
        tags: 0,
        lastJob: null,
      }),
    ),
    http.get('/api/knowledge/bases/kb_1/activity', () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
  );
}

function jobRequest(): URL | undefined {
  const call = calls.find(
    (item) => item.method === 'GET' && item.path.startsWith('/api/knowledge/jobs?'),
  );
  return call ? new URL(call.path, 'http://localhost') : undefined;
}

describe('knowledge job failure reasons', () => {
  it('explains a lost worker job in Chinese and keeps the raw reason in the title', async () => {
    baseHandlers();
    const lostJob: KnowledgeJob = {
      id: 'kjob_lost',
      type: 'ingest',
      status: 'failed',
      step: null,
      progress: 0,
      attempts: 1,
      error: 'knowledge worker lost track of this job',
      createdAt: '2026-01-01T00:00:00Z',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:01:00Z',
      documentId: null,
      sourceId: null,
      documentTitle: null,
      sourceName: null,
    };
    server.use(
      http.get('/api/knowledge/jobs', () =>
        HttpResponse.json({ items: [lostJob], nextCursor: null }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'jobs' });
    const findReason = () =>
      document.querySelector('[title="knowledge worker lost track of this job"]');
    await waitFor(() => findReason() !== null);
    const reason = findReason();
    expect(reason?.textContent).toBe('后台任务中断，本次未完成；重试会重新执行');
  });
});

describe('knowledge batch actions', () => {
  it('submits selected documents once and shows every per-item result', async () => {
    baseHandlers();
    const second = { ...doc, id: 'kdoc_2', title: '部署流程', currentVersionId: 'kdv_2' };
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [doc, second], nextCursor: null }),
      ),
      http.post('/api/knowledge/bases/kb_1/documents/batch', () =>
        HttpResponse.json({
          results: [
            { documentId: 'kdoc_1', status: 'succeeded' },
            {
              documentId: 'kdoc_2',
              status: 'failed',
              code: 'INVALID_INPUT',
              message: '文档不属于该知识库',
            },
          ],
        }),
      ),
    );
    await mount('/knowledge/kb_1');
    const selectRow = (label: string): HTMLElement => {
      const item = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
      if (!item) throw new Error(`Missing selection: ${label}`);
      return item;
    };
    await waitFor(() => document.querySelector('[aria-label="选择 上线流程"]') !== null);
    await click(selectRow('选择 上线流程'));
    await click(selectRow('选择 部署流程'));
    expect(document.body.textContent).toContain('已选 2 个');
    await click(button('标签'));
    const batch = dialog('批量标签');
    await fill('knowledge-batch-tags', '重要');
    await click(button('标签', batch));
    expect(
      calls.find((item) => item.path === '/api/knowledge/bases/kb_1/documents/batch')?.body,
    ).toEqual({
      documentIds: ['kdoc_1', 'kdoc_2'],
      action: 'tag',
      tags: ['重要'],
      tagMode: 'add',
    });
    expect(batch.textContent).toContain('成功 1 项 · 失败 1 项');
    expect(batch.textContent).toContain('文档不属于该知识库');
  });
});

describe('knowledge detail business line', () => {
  it('orders the task tabs and exposes status, overview, edit and settings actions', async () => {
    documentList();
    overviewHandlers();
    const router = await mount('/knowledge/kb_1');

    const labels = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].map((item) =>
      item.textContent?.trim(),
    );
    expect(labels).toEqual([
      '概览',
      '文档',
      '图片',
      '来源',
      '检索测试',
      '离线评估',
      'FAQ',
      'Wiki',
      '处理记录',
    ]);
    expect(document.querySelector('[data-slot="page-header"]')?.textContent).toContain('启用');
    expect(findButton('编辑信息')).toBeDefined();
    expect(findButton('更多操作')).toBeDefined();
    expect(findButton('使用此库的专家')).toBeUndefined();
    expect(calls.some((item) => item.path === '/api/agents/reference')).toBe(false);

    await openMenu('更多操作');
    expect(menuLabels()).toEqual(['使用此库的专家', '设置']);
    await chooseMenuItem('使用此库的专家');
    await waitFor(() => router.state.location.search.panel === 'overview');
    await waitFor(() => calls.some((item) => item.path === '/api/agents/reference'));
    await waitFor(() => document.body.textContent?.includes('使用此库的专家') === true);

    await openMenu('更多操作');
    await chooseMenuItem('设置');
    expect(dialogShown('知识库设置')).toBe(true);
    expect(document.getElementById('knowledge-settings-chunk-tokens')).not.toBeNull();
  });

  it('keeps read-only users on inspection and never requests a search without execute', async () => {
    server.use(http.get('/api/auth/me', () => HttpResponse.json(meWith(['knowledge.read']))));
    documentList();
    await mount('/knowledge/kb_1');

    expect(findButton('上传文件')).toBeUndefined();
    expect(findButton('导入')).toBeUndefined();
    expect(findButton('新建文件夹')).toBeUndefined();
    expect(findButton('管理标签')).toBeUndefined();
    expect(findButton('操作 上线流程')).toBeUndefined();
    expect(findButton('编辑信息')).toBeUndefined();
    expect(findButton('设置')).toBeUndefined();
    expect(findButton('更多操作')).toBeUndefined();
    expect(findButton('使用此库的专家')).toBeUndefined();
    expect(calls.some((item) => item.path === '/api/agents/reference')).toBe(false);

    await click(button('上线流程'));
    const viewer = dialog('上线流程');
    expect(viewer.textContent).toContain('下载原件');
    expect(viewer.textContent).not.toContain('编辑分块 1');
    await click(button('关闭'));

    await click(button('检索测试'));
    expect(document.body.textContent).toContain('没有检索与处理权限');
    expect(calls.some((item) => item.path.includes('/search'))).toBe(false);
  });

  it('lets content managers write documents but not execute, settings or sources', async () => {
    server.use(
      http.get('/api/auth/me', () =>
        HttpResponse.json(meWith(['knowledge.read', 'knowledge.content.manage'])),
      ),
    );
    documentList();
    await mount('/knowledge/kb_1');

    expect(findButton('上传文件')).toBeDefined();
    expect(findButton('导入')).toBeDefined();
    expect(findButton('新建文件夹')).toBeDefined();
    expect(findButton('管理标签')).toBeDefined();
    await openMenu('操作 上线流程');
    expect(menuLabels().some((label) => label.includes('移动 / 标注'))).toBe(true);
    expect(menuLabels().some((label) => label.includes('删除'))).toBe(true);
    expect(menuLabels().some((label) => label.includes('重新解析'))).toBe(false);
    expect(findButton('更多操作')).toBeUndefined();

    await click(button('来源'));
    expect(findButton('新建来源')).toBeUndefined();
    expect(findButton('立即同步')).toBeUndefined();
  });

  it('lets source managers maintain sources without execute, content or settings', async () => {
    server.use(
      http.get('/api/auth/me', () =>
        HttpResponse.json(meWith(['knowledge.read', 'knowledge.sources.manage'])),
      ),
    );
    documentList();
    await mount('/knowledge/kb_1', { panel: 'sources' });

    expect(findButton('新建来源')).toBeDefined();
    expect(findButton('编辑来源 产品仓库')).toBeDefined();
    expect(findButton('删除来源 产品仓库')).toBeDefined();
    expect(findButton('检查配置')).toBeDefined();
    expect(findButton('立即同步')).toBeUndefined();
    expect(findButton('更多操作')).toBeUndefined();
    expect(findButton('上传文件')).toBeUndefined();
  });

  it('lets executors reprocess, search and manage jobs without writing documents', async () => {
    documentList();
    server.use(
      http.get('/api/auth/me', () =>
        HttpResponse.json(meWith(['knowledge.read', 'knowledge.execute'])),
      ),
      http.get('/api/knowledge/bases/kb_1/search', () =>
        HttpResponse.json({ degraded: false, hits: [] }),
      ),
      http.get('/api/knowledge/jobs', () =>
        HttpResponse.json({
          items: [jobFixture({ id: 'kjob_retry', type: 'ingest', status: 'failed' })],
          nextCursor: null,
        }),
      ),
    );
    await mount('/knowledge/kb_1');

    await openMenu('操作 上线流程');
    expect(menuLabels().some((label) => label.includes('重新解析'))).toBe(true);
    expect(menuLabels().some((label) => label.includes('移动 / 标注'))).toBe(false);
    expect(menuLabels().some((label) => label.includes('删除'))).toBe(false);
    await chooseMenuItem('重新解析');
    expect(dialog('重新解析文档').textContent).toContain('人工编辑过的分块会被丢弃');
    await click(button('取消'));
    expect(findButton('上传文件')).toBeUndefined();
    expect(findButton('更多操作')).toBeUndefined();

    await click(button('检索测试'));
    const search = document.querySelector<HTMLInputElement>('input[aria-label="检索知识库"]');
    if (!search) throw new Error('Missing search input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        search,
        '发布',
      );
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    await click(button('检索'));
    expect(calls.some((item) => item.path.includes('/api/knowledge/bases/kb_1/search'))).toBe(true);

    await click(button('处理记录'));
    expect(findButton('重试')).toBeDefined();
  });

  it('lets publishers edit a blank wiki with an explicit null expectedVersion and publish history', async () => {
    server.use(
      http.get('/api/auth/me', () =>
        HttpResponse.json(meWith(['knowledge.read', 'knowledge.publish', 'knowledge.execute'])),
      ),
    );
    documentList();
    server.use(
      http.get('/api/knowledge/bases/kb_1/wiki-pages', () =>
        HttpResponse.json({
          items: [
            {
              ...wikiPageSummary,
              id: 'kwp_blank',
              slug: 'blank',
              title: '空白页',
              status: 'draft',
              currentVersionId: null,
            },
          ],
          nextCursor: null,
        }),
      ),
      http.get('/api/knowledge/wiki-pages/kwp_blank', () =>
        HttpResponse.json({
          ...wikiPageSummary,
          id: 'kwp_blank',
          slug: 'blank',
          title: '空白页',
          status: 'draft',
          currentVersionId: null,
          versions: [],
          nextCursor: null,
        }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'wiki', page: 'kwp_blank' });

    expect(document.body.textContent).toContain('还没有正文');
    expect(findButton('生成草稿')).toBeDefined();
    expect(findButton('重新生成')).toBeUndefined();
    expect(findButton('新建 Wiki 页面')).toBeUndefined();
  });

  it('opens settings in place only with knowledge.update', async () => {
    server.use(
      http.get('/api/auth/me', () =>
        HttpResponse.json(meWith(['knowledge.read', 'knowledge.update'])),
      ),
    );
    documentList();
    await mount('/knowledge/kb_1');

    expect(findButton('上传文件')).toBeUndefined();
    expect(findButton('编辑信息')).toBeDefined();
    expect(findButton('使用此库的专家')).toBeUndefined();
    await openMenu('更多操作');
    expect(menuLabels()).toEqual(['设置']);
    await chooseMenuItem('设置');
    expect(dialogShown('知识库设置')).toBe(true);
    expect(calls.some((item) => item.path === '/api/knowledge/bases/kb_1/documents/upload')).toBe(
      false,
    );
  });
});

describe('knowledge expert usage', () => {
  const summary = (id: string, name: string) => ({
    id,
    name,
    description: '',
    enabled: true,
    createdBy: 'test-admin',
    ownerBusinessId: 'test-admin',
  });

  it('reads agent summaries and reports unreadable relationships instead of empty usage', async () => {
    documentList();
    overviewHandlers();
    server.use(
      http.get('/api/auth/me', () => HttpResponse.json(meWith(['knowledge.read', 'agents.read']))),
      http.get('/api/agents', () =>
        HttpResponse.json({
          items: [
            { ...summary('agent_a', '文档专家'), serverIds: ['srv_1'] },
            summary('agent_b', '外部专家'),
          ],
          nextCursor: null,
        }),
      ),
      http.get('/api/agents/reference', () =>
        HttpResponse.json({
          items: [
            { ...summary('agent_a', '文档专家'), serverIds: ['srv_1'] },
            summary('agent_b', '外部专家'),
          ],
          truncated: false,
        }),
      ),
    );
    await mount('/knowledge/kb_1');

    expect(calls.some((item) => item.path === '/api/agents/reference')).toBe(false);
    expect(findButton('编辑信息')).toBeUndefined();
    await openMenu('更多操作');
    expect(menuLabels()).toEqual(['使用此库的专家']);
    await chooseMenuItem('使用此库的专家');
    await waitFor(() => document.activeElement?.id === 'knowledge-expert-usage');
    expect(document.getElementById('knowledge-expert-usage')).not.toBeNull();
    await waitFor(() => document.body.textContent?.includes('文档专家') === true);
    await waitFor(() => document.body.textContent?.includes('部分专家的使用关系无法确认') === true);

    const link = document.querySelector<HTMLAnchorElement>(
      'a[href="/agents/agent_a?tab=config&section=capability"]',
    );
    expect(link?.textContent).toContain('文档专家');
    expect(document.body.textContent).not.toContain('还没有专家绑定此知识库');
    expect(
      document.querySelector<HTMLAnchorElement>('#knowledge-expert-usage a[href="/agents"]')
        ?.textContent,
    ).toContain('选择其他专家');
    expect(
      calls.filter(
        (item) => item.path.startsWith('/api/agents/') && item.path !== '/api/agents/reference',
      ),
    ).toEqual([]);
  });

  it('offers the agents list when no expert is bound yet', async () => {
    documentList();
    overviewHandlers();
    server.use(
      http.get('/api/auth/me', () =>
        HttpResponse.json(meWith(['knowledge.read', 'agents.read', 'agents.config.read'])),
      ),
      http.get('/api/agents', () => HttpResponse.json({ items: [], nextCursor: null })),
      http.get('/api/agents/reference', () => HttpResponse.json({ items: [], truncated: false })),
    );
    await mount('/knowledge/kb_1');
    await click(button('概览'));
    await waitFor(() => document.body.textContent?.includes('还没有专家绑定此知识库') === true);

    const next = document.querySelector<HTMLAnchorElement>(
      '#knowledge-expert-usage a[href="/agents"]',
    );
    expect(next?.textContent).toContain('前往找专家');
    expect(document.body.textContent).toContain('能力配置');
  });

  it('hides the expert entry and requests no agent data without agents.read', async () => {
    server.use(http.get('/api/auth/me', () => HttpResponse.json(meWith(['knowledge.read']))));
    documentList();
    overviewHandlers();
    await mount('/knowledge/kb_1');

    await click(button('概览'));
    await flush();
    expect(document.body.textContent).not.toContain('使用此库的专家');
    expect(calls.some((item) => item.path === '/api/agents/reference')).toBe(false);
  });
});

describe('knowledge document to jobs recovery', () => {
  it('sends a first-time failed document to its filtered jobs and retries the original job', async () => {
    const failedDocument = {
      ...doc,
      id: 'kdoc_failed',
      title: '导入失败',
      status: 'failed',
      currentVersionId: null,
    };
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [failedDocument], nextCursor: null }),
      ),
      http.get('/api/knowledge/jobs', ({ request }) => {
        const url = new URL(request.url);
        return HttpResponse.json({
          items:
            url.searchParams.get('documentId') === 'kdoc_failed'
              ? [
                  jobFixture({
                    id: 'kjob_failed',
                    type: 'ingest',
                    status: 'failed',
                    error: '解析失败',
                    documentId: 'kdoc_failed',
                    documentTitle: '导入失败',
                  }),
                ]
              : [],
          nextCursor: null,
        });
      }),
      http.post('/api/knowledge/jobs/kjob_failed/retry', () =>
        HttpResponse.json({ jobId: 'kjob_retry' }),
      ),
    );
    const router = await mount('/knowledge/kb_1');

    await openMenu('操作 导入失败');
    expect(menuLabels().some((label) => label.includes('重新解析'))).toBe(true);
    await chooseMenuItem('查看处理记录');

    await waitFor(() => router.state.location.search.panel === 'jobs');
    expect(router.state.location.search.document).toBe('kdoc_failed');
    await waitFor(() => jobRequest()?.searchParams.get('documentId') === 'kdoc_failed');
    expect(document.body.textContent).toContain('导入失败');

    await click(button('重试'));
    expect(
      calls.some(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/jobs/kjob_failed/retry',
      ),
    ).toBe(true);

    await click(button('查看全部处理记录'));
    await waitFor(() => router.state.location.search.document === undefined);
    expect(document.body.textContent).not.toContain('只显示该文档的处理记录');
  });

  it('keeps the FAQ tab usable after jumping from a document to its filtered jobs', async () => {
    const failedDocument = {
      ...doc,
      id: 'kdoc_failed',
      title: '导入失败',
      status: 'failed',
      currentVersionId: null,
    };
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [failedDocument], nextCursor: null }),
      ),
      http.get('/api/knowledge/bases/kb_1/faqs', () =>
        HttpResponse.json({ items: [faqSummary], nextCursor: null }),
      ),
    );
    const router = await mount('/knowledge/kb_1');

    await openMenu('操作 导入失败');
    await chooseMenuItem('查看处理记录');
    await waitFor(() => router.state.location.search.document === 'kdoc_failed');

    await click(button('FAQ'));
    await waitFor(() => router.state.location.search.panel === 'faqs');
    expect(router.state.location.search.document).toBeUndefined();
    expect(findButton('新建 FAQ')).toBeDefined();
    expect(document.body.textContent).toContain('如何备份？');
  });
});

describe('knowledge jobs pagination', () => {
  it('offers clearing the filter or re-uploading when a filtered document has no job', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [doc], nextCursor: null }),
      ),
    );
    const router = await mount('/knowledge/kb_1', { panel: 'jobs', document: 'kdoc_failed' });

    expect(document.body.textContent).toContain('该文档还没有处理记录');
    expect(document.body.textContent).not.toContain('重新解析');
    expect(findButton('查看全部处理记录')).toBeDefined();
    await click(button('重新上传文档'));
    await waitFor(() => router.state.location.search.panel === undefined);
    expect(router.state.location.search.document).toBeUndefined();
  });

  it('loads more while keeping rows through a failed page and retries it', async () => {
    let pageTwoCalls = 0;
    documentList();
    server.use(
      http.get('/api/knowledge/jobs', ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('cursor') === 'cursor_2') {
          pageTwoCalls += 1;
          if (pageTwoCalls === 1) {
            return HttpResponse.json(
              { code: 'INTERNAL', message: '任务分页失败' },
              { status: 500 },
            );
          }
          return HttpResponse.json({
            items: [
              jobFixture({
                id: 'kjob_3',
                type: 'sync',
                status: 'succeeded',
                sourceId: 'ksrc_1',
                sourceName: '产品仓库',
              }),
            ],
            nextCursor: null,
          });
        }
        return HttpResponse.json({
          items: [
            jobFixture({
              id: 'kjob_1',
              type: 'ingest',
              status: 'succeeded',
              documentId: 'kdoc_1',
              documentTitle: '上线流程',
            }),
            jobFixture({ id: 'kjob_2', type: 'cleanup', status: 'succeeded' }),
          ],
          nextCursor: 'cursor_2',
        });
      }),
    );
    await mount('/knowledge/kb_1', { panel: 'jobs' });

    expect(document.body.textContent).toContain('已加载 2 条处理记录');
    expect(document.body.textContent).toContain('上线流程');
    expect(document.body.textContent).toContain('整库');

    await click(button('加载更多处理记录'));
    expect(document.body.textContent).toContain('更多处理记录没有加载出来');
    expect(document.body.textContent).toContain('上线流程');

    await click(button('重试'));
    await waitFor(() => document.body.textContent?.includes('产品仓库') === true);
    expect(document.body.textContent).toContain('共 3 条处理记录');
  });
});

describe('knowledge job targets', () => {
  it('opens the document or source workspace from a job record', async () => {
    documentList();
    server.use(
      http.get('/api/knowledge/jobs', () =>
        HttpResponse.json({
          items: [
            jobFixture({
              id: 'kjob_doc',
              type: 'ingest',
              status: 'succeeded',
              documentId: 'kdoc_1',
              documentTitle: '上线流程',
            }),
            jobFixture({
              id: 'kjob_src',
              type: 'sync',
              status: 'succeeded',
              sourceId: 'ksrc_1',
              sourceName: '产品仓库',
            }),
          ],
          nextCursor: null,
        }),
      ),
      http.get('/api/knowledge/sources/ksrc_1/runs', () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get('/api/knowledge/documents/kdoc_1', () => HttpResponse.json(doc)),
    );
    const router = await mount('/knowledge/kb_1', { panel: 'jobs' });

    await click(button('上线流程'));
    await waitFor(() => router.state.location.search.panel === 'documents');
    expect(router.state.location.search.document).toBe('kdoc_1');

    await click(button('处理记录'));
    await waitFor(() => router.state.location.search.panel === 'jobs');
    await click(button('查看全部处理记录'));
    await waitFor(() => router.state.location.search.document === undefined);

    await click(button('产品仓库'));
    await waitFor(() => router.state.location.search.panel === 'sources');
    expect(router.state.location.search.source).toBe('ksrc_1');
    expect(router.state.location.search.document).toBeUndefined();
    await waitFor(() => document.body.textContent?.includes('同步记录') === true);
  });
});
