import type { KnowledgeJob } from '@agentport/shared';
import { HttpResponse, http } from 'msw';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { toastError, toastSuccess } from '../src/lib/toast.js';
import {
  baseHandlers,
  button,
  calls,
  chooseFilter,
  chooseOption,
  click,
  deferred,
  dialog,
  dialogShown,
  faq,
  faqDocument,
  faqSummary,
  fill,
  findButton,
  flush,
  hitWire,
  mount,
  mountState,
  patchBody,
  registerKnowledgeHarness,
  server,
  waitFor,
  wikiJob,
  wikiPage,
  wikiPageSummary,
} from './knowledge-harness.js';

vi.mock('../src/lib/toast.js', () => ({
  toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

registerKnowledgeHarness();

// ---- K-U1..U3：批量、版本/草稿、FAQ、Wiki 组织与检索诊断 -----------------

const faqPublishedVersion = {
  id: 'kdv_faq_pub',
  documentId: 'kdoc_faq',
  version: 1,
  origin: 'faq' as const,
  parentVersionId: null,
  metadata: {},
  faq,
  isCurrent: true,
  createdAt: '2026-01-01T00:00:00Z',
};

const faqDraftVersion = {
  ...faqPublishedVersion,
  id: 'kdv_faq_draft',
  version: 2,
  origin: 'manual' as const,
  parentVersionId: 'kdv_faq_pub',
  metadata: { publication: 'draft' },
  isCurrent: false,
  createdAt: '2026-01-02T00:00:00Z',
};

const faqDetail = {
  document: faqDocument,
  draftVersion: faqDraftVersion,
  publishedVersion: faqPublishedVersion,
  faq,
};

function wikiSummary(override: Record<string, unknown>) {
  return { ...wikiPageSummary, ...override };
}

describe('knowledge wiki versions', () => {
  it('lists the real version shape and rolls back to an older version', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/wiki-pages/kwp_1', () => HttpResponse.json(wikiPage)),
      http.post('/api/knowledge/wiki-pages/kwp_1/rollback', () =>
        HttpResponse.json(wikiPage.versions[1]),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'wiki', page: 'kwp_1' });
    expect(document.body.textContent).toContain('v2');
    expect(document.body.textContent).toContain('v1');
    await click(button('回退到此版本'));
    await click(button('回退', dialog('回退 Wiki 版本')));
    expect(
      calls.find(
        (item) =>
          item.method === 'POST' && item.path === '/api/knowledge/wiki-pages/kwp_1/rollback',
      )?.body,
    ).toEqual({ versionId: 'kwv_1' });
  });

  it('loads the published version from the next version page before editing', async () => {
    baseHandlers();
    const older = {
      id: 'kwv_old',
      pageId: 'kwp_1',
      version: 1,
      markdown: '## 更早版本\n\n第二页正文。',
      sourceChunkIds: [],
      model: 'manual',
      generatedBy: 'manual',
      createdAt: '2026-01-01T00:00:00Z',
    };
    server.use(
      http.get('/api/knowledge/wiki-pages/kwp_1', () =>
        HttpResponse.json({
          ...wikiPage,
          currentVersionId: 'kwv_old',
          // 第一页不含当前发布版本：不能把它当成空白首版。
          versions: [wikiPage.versions[0]],
          nextCursor: 'kwv_cursor_old',
        }),
      ),
      http.get('/api/knowledge/wiki-pages/kwp_1/versions', () =>
        HttpResponse.json({ items: [older], nextCursor: null }),
      ),
      http.patch('/api/knowledge/wiki-pages/kwp_1', () =>
        HttpResponse.json({ ...wikiPageSummary, currentVersionId: 'kwv_old' }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'wiki', page: 'kwp_1' });

    // 当前发布版本不在第一页时自动取更早的版本页，读到正文后才允许编辑。
    await waitFor(() => document.body.textContent?.includes('第二页正文。') === true);
    expect(findButton('重新生成')).toBeDefined();
    expect(findButton('生成草稿')).toBeUndefined();
    expect(button('编辑正文').disabled).toBe(false);
    await click(button('编辑正文'));
    const editor = dialog('编辑 Wiki 正文');
    // 草稿从最新版本续写；当前发布版本只用于展示。
    expect(editor.querySelector<HTMLTextAreaElement>('#knowledge-wiki-markdown')?.value).toBe(
      '## 当前\n\n第二步。',
    );
    await fill('knowledge-wiki-markdown', '## 修改后');
    await click(button('保存草稿', editor));
    expect(patchBody('/api/knowledge/wiki-pages/kwp_1')).toEqual({
      markdown: '## 修改后',
      expectedVersion: 'kwv_2',
    });
  });

  it('switches the current page between reading and source and copies it from the same toolbar', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    baseHandlers();
    server.use(http.get('/api/knowledge/wiki-pages/kwp_1', () => HttpResponse.json(wikiPage)));
    await mount('/knowledge/kb_1', { panel: 'wiki', page: 'kwp_1' });
    expect(document.body.textContent).toContain('第二步。');

    await click(button('源码'));
    expect(document.querySelector('pre')?.textContent).toContain('## 当前');
    const copies = [...document.querySelectorAll<HTMLButtonElement>('button')].filter((item) =>
      item.getAttribute('aria-label')?.startsWith('复制'),
    );
    expect(copies).toHaveLength(1);
    expect(copies[0]?.getAttribute('aria-label')).toBe('复制 发布指南');

    const copy = document.querySelector<HTMLButtonElement>('button[aria-label="复制 发布指南"]');
    if (!copy) throw new Error('Missing copy action');
    await act(async () => copy.click());
    await flush();
    expect(writeText).toHaveBeenLastCalledWith('## 当前\n\n第二步。');
  });

  it('keeps the version captured on open even after a background refetch, and keeps the draft on 409', async () => {
    baseHandlers();
    let currentVersionId = 'kwv_2';
    server.use(
      http.get('/api/knowledge/wiki-pages/kwp_1', () =>
        HttpResponse.json({
          ...wikiPage,
          currentVersionId,
          versions:
            currentVersionId === 'kwv_2'
              ? wikiPage.versions
              : [
                  {
                    id: 'kwv_3',
                    pageId: 'kwp_1',
                    version: 3,
                    markdown: '## 别人刚发布\n\n第三步。',
                    sourceChunkIds: [],
                    model: 'manual',
                    generatedBy: 'manual',
                    createdAt: '2026-01-03T00:00:00Z',
                  },
                  ...wikiPage.versions,
                ],
        }),
      ),
      http.patch('/api/knowledge/wiki-pages/kwp_1', () =>
        HttpResponse.json(
          {
            code: 'CONFLICT',
            message: 'Wiki 页面已被修改，请刷新后重试',
            status: 409,
            requestId: '',
            retryable: false,
          },
          { status: 409 },
        ),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'wiki', page: 'kwp_1' });
    await click(button('编辑正文'));
    const editor = dialog('编辑 Wiki 正文');
    await fill('knowledge-wiki-markdown', '## 我的草稿');

    // 另一个窗口发布了 v3：后台刷新把页面当前版本推进到 v3。
    currentVersionId = 'kwv_3';
    await act(async () => {
      await mountState.client?.invalidateQueries({ queryKey: ['knowledge', 'wiki-page', 'kwp_1'] });
    });
    await flush();
    expect(document.body.textContent).toContain('v3');
    expect(document.querySelector<HTMLTextAreaElement>('#knowledge-wiki-markdown')?.value).toBe(
      '## 我的草稿',
    );

    await click(button('保存草稿', editor));
    expect(patchBody('/api/knowledge/wiki-pages/kwp_1')).toEqual({
      markdown: '## 我的草稿',
      expectedVersion: 'kwv_2',
    });
    expect(editor.textContent).toContain('Wiki 页面已被修改，请刷新后重试');
    expect(document.querySelector<HTMLTextAreaElement>('#knowledge-wiki-markdown')?.value).toBe(
      '## 我的草稿',
    );
    expect(toastError).not.toHaveBeenCalled();

    const detailCalls = () =>
      calls.filter((item) => item.path === '/api/knowledge/wiki-pages/kwp_1').length;
    const before = detailCalls();
    await click(button('重新加载', editor));
    await click(button('重新加载', dialog('重新加载 Wiki 正文')));
    expect(detailCalls()).toBeGreaterThan(before);
    expect(document.querySelector('#knowledge-wiki-markdown')).toBeNull();
    expect(document.body.textContent).toContain('第三步。');
  });

  it('tracks the submitted generation job and refreshes page and list once it finishes', async () => {
    baseHandlers();
    let jobs: KnowledgeJob[] = [];
    let pageCalls = 0;
    let listCalls = 0;
    server.use(
      http.get('/api/knowledge/jobs', () => HttpResponse.json({ items: jobs, nextCursor: null })),
      http.get('/api/knowledge/wiki-pages/kwp_1', () => {
        pageCalls += 1;
        return HttpResponse.json(wikiPage);
      }),
      http.get('/api/knowledge/bases/kb_1/wiki-pages', () => {
        listCalls += 1;
        return HttpResponse.json({ items: [wikiPageSummary], nextCursor: null });
      }),
      http.post('/api/knowledge/wiki-pages/kwp_1/generate', () => {
        jobs = [wikiJob('queued'), ...jobs];
        return HttpResponse.json({ jobId: 'kjob_gen' });
      }),
    );
    // 其他页面或其他来源的终态任务留在列表里，但不显示在这一页。
    jobs = [wikiJob('succeeded', 'kjob_other')];
    await mount('/knowledge/kb_1', { panel: 'wiki', page: 'kwp_1' });
    expect(document.body.textContent).not.toContain('生成任务');
    await click(button('编辑正文'));
    const editor = dialog('编辑 Wiki 正文');
    await fill('knowledge-wiki-markdown', '## 未保存的草稿');

    const pageBefore = pageCalls;
    const listBefore = listCalls;
    await click(button('重新生成'));
    await flush();
    // 提交后由产品自己刷新任务列表即可看到新任务，不靠测试手动刷新。
    expect(document.body.textContent).toContain('生成任务 排队中');
    // 任务仍在跑时只刷新任务列表，不重复拉当前页面与页面列表。
    expect(pageCalls).toBe(pageBefore);
    expect(listCalls).toBe(listBefore);

    // 任务终态刷新页面失败时保留页面数据与编辑草稿，只做局部报错。
    server.use(
      http.get('/api/knowledge/wiki-pages/kwp_1', () =>
        HttpResponse.json({ code: 'INTERNAL', message: '页面刷新失败' }, { status: 500 }),
      ),
    );
    jobs = [wikiJob('succeeded'), wikiJob('succeeded', 'kjob_other')];
    await act(async () => {
      await mountState.client?.invalidateQueries({ queryKey: ['knowledge', 'jobs', 'kb_1'] });
    });
    await flush();
    expect(listCalls).toBe(listBefore + 1);
    expect(editor.isConnected).toBe(true);
    expect(document.querySelector<HTMLTextAreaElement>('#knowledge-wiki-markdown')?.value).toBe(
      '## 未保存的草稿',
    );
    expect(document.body.textContent).toContain('Wiki 页面没有刷新成功');

    server.use(
      http.get('/api/knowledge/wiki-pages/kwp_1', () => {
        pageCalls += 1;
        return HttpResponse.json(wikiPage);
      }),
    );
    await click(button('重试'));
    await flush();
    expect(editor.isConnected).toBe(true);
    expect(document.querySelector<HTMLTextAreaElement>('#knowledge-wiki-markdown')?.value).toBe(
      '## 未保存的草稿',
    );
    expect(document.body.textContent).not.toContain('Wiki 页面没有刷新成功');
    expect(document.body.textContent).toContain('第二步。');

    // 终态后的轮询即使继续刷新任务列表，也不再重复失效页面与列表。
    const settledPage = pageCalls;
    const settledList = listCalls;
    await act(async () => {
      await mountState.client?.invalidateQueries({ queryKey: ['knowledge', 'jobs', 'kb_1'] });
    });
    await flush();
    expect(pageCalls).toBe(settledPage);
    expect(listCalls).toBe(settledList);
    expect(editor.isConnected).toBe(true);
  });

  it('loads every wiki page page so older pages stay selectable', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/wiki-pages', ({ request }) =>
        new URL(request.url).searchParams.get('cursor') === 'kwp_cursor'
          ? HttpResponse.json({
              items: [{ ...wikiPageSummary, id: 'kwp_old', title: '旧页面', slug: 'old' }],
              nextCursor: null,
            })
          : HttpResponse.json({ items: [wikiPageSummary], nextCursor: 'kwp_cursor' }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'wiki' });
    expect(calls.some((item) => item.path.includes('cursor=kwp_cursor'))).toBe(true);
    expect(document.body.textContent).toContain('旧页面');
  });
});

describe('knowledge FAQ management', () => {
  const importCounts = {
    total: 2,
    success: 1,
    failed: 0,
    partialFailed: 1,
    skipped: 0,
    added: 1,
    merged: 1,
  };

  const importedDetail = {
    document: {
      ...faqDocument,
      id: 'kdoc_new',
      title: '新的备份',
      currentVersionId: null,
      tags: [],
    },
    draftVersion: {
      ...faqDraftVersion,
      id: 'kdv_new',
      documentId: 'kdoc_new',
      version: 1,
      parentVersionId: null,
      metadata: {
        publication: 'draft',
        faqImport: { batchId: 'imp_1', mode: 'append', expectedVersionId: null },
      },
    },
    publishedVersion: null,
    faq,
  };

  function faqHandlers() {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/faqs', () =>
        HttpResponse.json({ items: [faqSummary], nextCursor: null }),
      ),
      http.get('/api/knowledge/faqs/kdoc_faq', () => HttpResponse.json(faqDetail)),
      http.get('/api/knowledge/faqs/kdoc_new', () => HttpResponse.json(importedDetail)),
      http.put('/api/knowledge/faqs/kdoc_faq', () =>
        HttpResponse.json({ documentId: 'kdoc_faq', jobId: 'kjob_faq' }),
      ),
      http.post('/api/knowledge/faqs/kdoc_faq/publish', () => HttpResponse.json(faqDocument)),
      http.post('/api/knowledge/bases/kb_1/faqs/import', async ({ request }) => {
        const body = (await request.json()) as { dryRun: boolean; mode: 'append' | 'replace' };
        if (body.dryRun) {
          return HttpResponse.json({
            dryRun: true,
            mode: body.mode,
            committed: false,
            importBatchId: null,
            counts: importCounts,
            results: [
              {
                row: 1,
                status: 'success',
                operation: 'add',
                issues: [],
              },
              {
                row: 2,
                status: 'partial_failed',
                operation: 'merge',
                issues: [
                  { field: 'similarQuestions', code: 'DUPLICATE', message: '重复问题已去掉' },
                ],
              },
            ],
          });
        }
        return HttpResponse.json(
          {
            dryRun: false,
            mode: body.mode,
            committed: true,
            importBatchId: 'imp_1',
            counts: { ...importCounts, skipped: 1, total: 1, success: 1 },
            results: [
              {
                row: 1,
                status: 'success',
                operation: 'add',
                documentId: 'kdoc_new',
                expectedVersionId: null,
                jobId: 'kjob_import',
                issues: [],
              },
            ],
          },
          { status: 202 },
        );
      }),
      http.post('/api/knowledge/bases/kb_1/faqs/batch', () =>
        HttpResponse.json({ results: [{ documentId: 'kdoc_new', status: 'succeeded' }] }),
      ),
      http.get('/api/knowledge/jobs/kjob_import', () =>
        HttpResponse.json({
          id: 'kjob_import',
          type: 'ingest',
          status: 'succeeded',
          step: null,
          progress: 100,
          attempts: 1,
          error: null,
          createdAt: '2026-01-01T00:00:00Z',
          startedAt: '2026-01-01T00:00:00Z',
          endedAt: '2026-01-01T00:01:00Z',
        }),
      ),
      http.get(
        '/api/knowledge/bases/kb_1/faqs/export',
        () => new HttpResponse('[]', { headers: { 'content-type': 'application/json' } }),
      ),
      http.post('/api/knowledge/bases/kb_1/faqs/test', () =>
        HttpResponse.json({ hits: [hitWire()], degraded: false, warnings: [] }),
      ),
    );
  }

  it('filters the FAQ list by recommendation without changing status', async () => {
    faqHandlers();
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    await chooseFilter('按推荐筛选', '推荐');
    const call = calls.find(
      (item) =>
        item.method === 'GET' &&
        item.path.startsWith('/api/knowledge/bases/kb_1/faqs?') &&
        item.path.includes('isRecommended=true'),
    );
    expect(call).toBeDefined();
    const params = new URL(call?.path ?? '', 'http://localhost').searchParams;
    expect(params.get('isRecommended')).toBe('true');
    expect(params.get('limit')).toBe('50');
  });

  it('saves the answer strategy and recommendation flag without changing published answers', async () => {
    faqHandlers();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:faq');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    expect(document.body.textContent).toContain('如何备份？');
    expect(document.body.textContent).toContain('2 个答案');

    await click(button('编辑'));
    const editor = dialog('编辑 FAQ');
    await waitFor(() => document.querySelectorAll('textarea[aria-label^="答案"]').length === 2);
    expect(
      [...document.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label^="答案"]')].map(
        (item) => item.value,
      ),
    ).toEqual(['每日自动备份。', '异机保存副本。']);
    await fill('faq-question', '如何做备份？');
    await chooseOption('faq-answer-strategy', '随机一条');
    await click(document.getElementById('faq-recommended') as HTMLElement);
    await click(button('保存草稿', editor));
    expect(
      calls.find((item) => item.method === 'PUT' && item.path === '/api/knowledge/faqs/kdoc_faq')
        ?.body,
    ).toEqual(
      expect.objectContaining({
        faq: expect.objectContaining({
          question: '如何做备份？',
          answers: faq.answers,
          answerStrategy: 'random',
          isRecommended: false,
        }),
        expectedVersionId: 'kdv_faq_draft',
      }),
    );
    expect(toastSuccess).toHaveBeenCalledWith('FAQ 草稿已保存，发布后可召回');

    await click(button('发布草稿'));
    const publish = dialog('发布 FAQ');
    await waitFor(() => publish.textContent?.includes('将 v2') === true);
    await click(button('发布', publish));
    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/faqs/kdoc_faq/publish',
      )?.body,
    ).toEqual({ versionId: 'kdv_faq_draft', expectedVersionId: 'kdv_faq_pub' });
  });

  it('previews without writing, then polls the imported job and publishes the whole batch', async () => {
    faqHandlers();
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    await click(button('导入'));
    const importer = dialog('导入 FAQ');
    await fill('faq-import-content', '{"items":[]}');
    await click(button('预览', importer));
    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/faqs/import',
      )?.body,
    ).toEqual({ format: 'json', content: '{"items":[]}', mode: 'append', dryRun: true });
    expect(importer.textContent).toContain('预览 · 未写入');
    expect(importer.textContent).toContain('共 2');

    await click(button('确认导入', importer));
    expect(
      calls
        .filter(
          (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/faqs/import',
        )
        .at(-1)?.body,
    ).toEqual({ format: 'json', content: '{"items":[]}', mode: 'append', dryRun: false });

    await waitFor(() =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].some((item) =>
        item.textContent?.includes('发布本批 1 条 FAQ'),
      ),
    );
    const publishButton = button('发布本批 1 条 FAQ', importer);
    await click(publishButton);
    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/faqs/batch',
      )?.body,
    ).toEqual({
      action: 'publish',
      importBatchId: 'imp_1',
      items: [{ documentId: 'kdoc_new', versionId: 'kdv_new', expectedVersionId: null }],
    });
    expect(importer.textContent).toContain('本批已发布');
    expect(toastSuccess).toHaveBeenCalledWith('本批 FAQ 已发布');
  });

  it('shows the old FAQ count in the replace confirmation and keeps the dialog open', async () => {
    faqHandlers();
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    await click(button('导入'));
    const importer = dialog('导入 FAQ');
    await fill('faq-import-content', '{"items":[]}');
    await chooseOption('faq-import-mode', '替换全部');
    await click(button('预览', importer));
    await click(button('确认导入', importer));
    const confirm = dialog('替换全部 FAQ');
    expect(confirm.textContent).toContain('1 条 FAQ');
    expect(dialogShown('导入 FAQ')).toBe(true);
    await click(button('确认导入', confirm));
    await flush();
    expect(
      calls
        .filter(
          (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/faqs/import',
        )
        .at(-1)?.body,
    ).toEqual({ format: 'json', content: '{"items":[]}', mode: 'replace', dryRun: false });
    expect(dialogShown('导入 FAQ')).toBe(true);
  });

  it('sends xlsx content as the selected import format', async () => {
    faqHandlers();
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    await click(button('导入'));
    const importer = dialog('导入 FAQ');
    await chooseOption('faq-import-format', 'Excel (.xlsx)');
    await fill('faq-import-content', 'UEsDBAo=');
    await click(button('预览', importer));
    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/faqs/import',
      )?.body,
    ).toEqual({ format: 'xlsx', content: 'UEsDBAo=', mode: 'append', dryRun: true });
  });

  it('keeps the import dialog and its input open while the commit request is in flight', async () => {
    faqHandlers();
    const response = deferred<void>();
    server.use(
      http.post('/api/knowledge/bases/kb_1/faqs/import', async ({ request }) => {
        const body = (await request.json()) as { dryRun: boolean; mode: 'append' | 'replace' };
        if (body.dryRun) {
          return HttpResponse.json({
            dryRun: true,
            mode: body.mode,
            committed: false,
            importBatchId: null,
            counts: importCounts,
            results: [],
          });
        }
        await response.promise;
        return HttpResponse.json(
          {
            dryRun: false,
            mode: body.mode,
            committed: true,
            importBatchId: 'imp_1',
            counts: { ...importCounts, skipped: 1, total: 1, success: 1 },
            results: [],
          },
          { status: 202 },
        );
      }),
    );
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    await click(button('导入'));
    const importer = dialog('导入 FAQ');
    await fill('faq-import-content', '{"items":[]}');
    await click(button('预览', importer));
    await click(button('确认导入', importer));
    expect((document.getElementById('faq-import-content') as HTMLTextAreaElement).value).toBe(
      '{"items":[]}',
    );
    await click(button('关闭', importer));
    expect(dialogShown('导入 FAQ')).toBe(true);
    await act(async () => response.resolve());
    await flush();
    expect(dialogShown('导入 FAQ')).toBe(true);
  });

  it('runs the shared FAQ hit test with recommendation and direct-answer options', async () => {
    faqHandlers();
    server.use(
      http.post('/api/knowledge/bases/kb_1/faqs/test', () =>
        HttpResponse.json({
          hits: [
            hitWire({
              faq: {
                answers: ['每日自动备份。'],
                answerStrategy: 'random',
                isRecommended: true,
                matchedQuestion: '如何备份？',
                questionKind: 'standard',
              },
            }),
          ],
          degraded: false,
          warnings: [],
          directAnswer: {
            target: { kind: 'faq', id: 'kdoc_faq' },
            versionId: 'kdv_faq_pub',
            answers: ['每日自动备份。'],
            vectorScore: 0.96,
          },
        }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    const input = document.querySelector<HTMLInputElement>('input[aria-label="FAQ 命中测试"]');
    if (!input) throw new Error('Missing FAQ test input');
    const testForm = input.closest('form');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        '怎么备份',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(document.querySelector('[aria-label="只返回推荐 FAQ"]') as HTMLElement);
    await click(document.querySelector('[aria-label="FAQ 优先"]') as HTMLElement);
    await fill('faq-test-direct-threshold', '0.8');
    await act(async () => {
      testForm?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/faqs/test',
      )?.body,
    ).toEqual(
      expect.objectContaining({
        q: '怎么备份',
        onlyRecommended: true,
        faqPriority: true,
        faqDirectAnswerThreshold: 0.8,
      }),
    );
    const section = [...document.querySelectorAll('section')].find(
      (item) => item.querySelector('h2')?.textContent === '命中测试',
    );
    expect(section?.textContent).toContain('直接答案');
    expect(section?.textContent).toContain('cosine 0.960');
    expect(section?.textContent).toContain('随机答案 · 本次 1 条');
    expect(section?.textContent).not.toContain('异机保存副本。');
  });
});

describe('knowledge wiki organization and contributions', () => {
  it('shows directory links, diffs versions and saves drafts without publishing', async () => {
    baseHandlers();
    const third = {
      id: 'kwv_3',
      pageId: 'kwp_1',
      version: 3,
      markdown: '## 当前\n\n第三步。',
      sourceChunkIds: ['kchk_2'],
      model: 'manual',
      generatedBy: 'manual' as const,
      createdAt: '2026-01-03T00:00:00Z',
    };
    const page = {
      ...wikiPage,
      currentVersionId: 'kwv_2',
      parentId: null,
      position: 0,
      versions: [third, ...wikiPage.versions],
    };
    const sibling = wikiSummary({
      id: 'kwp_2',
      slug: 'backup',
      title: '备份指南',
      status: 'published',
      currentVersionId: null,
    });
    server.use(
      http.get('/api/knowledge/bases/kb_1/wiki-pages', () =>
        HttpResponse.json({ items: [wikiPageSummary, sibling], nextCursor: null }),
      ),
      http.get('/api/knowledge/wiki-pages/kwp_1', () => HttpResponse.json(page)),
      http.get('/api/knowledge/wiki-pages/kwp_1/links', () =>
        HttpResponse.json({
          outgoing: [{ targetPageId: 'kwp_2', anchor: '备份' }],
          incoming: [{ sourcePageId: 'kwp_2', anchor: null }],
        }),
      ),
      http.get('/api/knowledge/wiki-pages/kwp_1/diff', () =>
        HttpResponse.json({
          fromVersionId: 'kwv_2',
          toVersionId: 'kwv_3',
          addedLines: ['第三步。'],
          removedLines: ['第二步。'],
          addedSourceChunkIds: ['kchk_2'],
          removedSourceChunkIds: ['kchk_1'],
        }),
      ),
      http.patch('/api/knowledge/wiki-pages/kwp_1', () => HttpResponse.json(wikiPageSummary)),
      http.post('/api/knowledge/wiki-pages/kwp_1/publish', () =>
        HttpResponse.json(wikiPageSummary),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'wiki', page: 'kwp_1' });
    await waitFor(() => document.body.textContent?.includes('链接') === true);
    expect(document.body.textContent).toContain('备份指南');
    expect(document.body.textContent).toContain('链接');
    // 回退后的历史版本不等于草稿；没有 publication 标记时只说明未设为当前。
    expect(document.body.textContent).toContain('未设为当前版本');
    expect(document.body.textContent).not.toContain('有未发布草稿');

    await click(button('对比上一版'));
    const diff = dialog('版本贡献差异');
    await waitFor(() => diff.textContent?.includes('第三步。') === true);
    expect(diff.textContent).toContain('第二步。');
    expect(diff.textContent).toContain('kchk_2');
    await click(button('关闭', diff));

    await click(button('组织'));
    const organize = dialog('组织 Wiki 页面');
    await chooseOption('wiki-parent', '备份指南');
    await fill('wiki-position', '2');
    await click(button('保存', organize));
    expect(
      calls.find(
        (item) => item.method === 'PATCH' && item.path === '/api/knowledge/wiki-pages/kwp_1',
      )?.body,
    ).toEqual({ parentId: 'kwp_2', position: 2, expectedVersion: 'kwv_3' });

    await click(button('编辑正文'));
    const editor = dialog('编辑 Wiki 正文');
    await fill('knowledge-wiki-markdown', '## 新草稿');
    await click(button('保存草稿', editor));
    expect(
      calls
        .filter(
          (item) => item.method === 'PATCH' && item.path === '/api/knowledge/wiki-pages/kwp_1',
        )
        .at(-1)?.body,
    ).toEqual({ markdown: '## 新草稿', expectedVersion: 'kwv_3' });
    expect(toastSuccess).toHaveBeenCalledWith('Wiki 草稿已保存，发布后才会上线');

    await click(button('发布此版本', document.body));
    const publish = dialog('发布 Wiki 版本');
    await click(button('发布', publish));
    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/wiki-pages/kwp_1/publish',
      )?.body,
    ).toEqual({ versionId: 'kwv_3' });
  });
});
