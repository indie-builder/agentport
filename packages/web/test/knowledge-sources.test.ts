import { HttpResponse, http } from 'msw';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  baseHandlers,
  button,
  calls,
  chooseMenuItem,
  click,
  deferred,
  dialog,
  fill,
  flush,
  markdownResponse,
  mount,
  openMenu,
  patchBody,
  registerKnowledgeHarness,
  server,
  source,
  sourceChoice,
  syncJob,
  waitFor,
} from './knowledge-harness.js';

vi.mock('../src/lib/toast.js', () => ({
  toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

registerKnowledgeHarness();

describe('knowledge source skipped-only runs', () => {
  it('always offers the per-item expander when every recorded item was skipped', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/sources/ksrc_1/runs', () =>
        HttpResponse.json({
          items: [
            {
              id: 'ksyn_1',
              sourceId: 'ksrc_1',
              status: 'succeeded',
              startedAt: '2026-01-01T00:00:00Z',
              endedAt: '2026-01-01T00:01:00Z',
              cursorBefore: null,
              cursorAfter: null,
              stats: { listed: 1, created: 0, updated: 0, disabled: 0, failed: 0 },
              error: null,
              createdAt: '2026-01-01T00:00:00Z',
            },
          ],
          nextCursor: null,
        }),
      ),
      http.get('/api/knowledge/sources/ksrc_1/runs/ksyn_1/items', () =>
        HttpResponse.json({
          items: [
            {
              id: 'ksync_item_1',
              syncRunId: 'ksyn_1',
              sourceId: 'ksrc_1',
              rangeId: 'krng_1',
              documentId: null,
              externalId: 'unsupported.bin',
              status: 'skipped',
              code: 'UNSUPPORTED',
              message: '暂不支持该类型',
              retryable: false,
              createdAt: '2026-01-01T00:00:00Z',
            },
          ],
          nextCursor: null,
        }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('产品仓库'));
    await waitFor(() => document.body.textContent?.includes('逐项结果') === true);
    expect(document.body.textContent).toContain('逐项结果');
    expect(document.body.textContent).toContain('unsupported.bin');
    expect(document.body.textContent).toContain('跳过');
    expect(document.body.textContent).toContain('UNSUPPORTED');
  });
});

describe('knowledge source editing', () => {
  it('deletes with an explicit choice between keeping and removing documents', async () => {
    baseHandlers();
    server.use(http.delete('/api/knowledge/sources/ksrc_1', () => HttpResponse.json({})));
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('删除来源 产品仓库'));
    const confirmation = dialog('删除来源');
    expect(confirmation.textContent).toContain('保留但停用');
    await click(button('删除', confirmation));
    expect(
      calls.some(
        (item) =>
          item.method === 'DELETE' && item.path === '/api/knowledge/sources/ksrc_1?documents=keep',
      ),
    ).toBe(true);
  });

  it('keeps the stored credential when the field is left empty', async () => {
    baseHandlers();
    server.use(http.patch('/api/knowledge/sources/ksrc_1', () => HttpResponse.json(source)));
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    const editor = dialog('编辑来源');
    const secret = editor.querySelector<HTMLInputElement>('#knowledge-source-secret');
    expect(secret?.placeholder).toBe('留空保持原凭证');
    await click(button('保存', editor));
    const patch = patchBody('/api/knowledge/sources/ksrc_1') as {
      secrets?: unknown;
      config?: { syncDeletions?: boolean };
    };
    expect(patch).not.toHaveProperty('secrets');
    expect(patch.config?.syncDeletions).toBe(true);
  });

  it('rotates the credential when a new value is entered', async () => {
    baseHandlers();
    server.use(http.patch('/api/knowledge/sources/ksrc_1', () => HttpResponse.json(source)));
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    await fill('knowledge-source-secret', 'glpat-new');
    await click(button('保存', dialog('编辑来源')));
    expect(patchBody('/api/knowledge/sources/ksrc_1')).toMatchObject({
      secrets: { token: 'glpat-new' },
    });
  });

  it('keeps an auth_error status when no new credential is entered', async () => {
    baseHandlers();
    const broken = { ...source, status: 'auth_error' };
    server.use(
      http.get('/api/knowledge/bases/kb_1/sources', () =>
        HttpResponse.json({ items: [broken], nextCursor: null }),
      ),
      http.patch('/api/knowledge/sources/ksrc_1', () => HttpResponse.json(broken)),
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    await click(button('保存', dialog('编辑来源')));
    expect(patchBody('/api/knowledge/sources/ksrc_1')).not.toHaveProperty('status');
  });

  it('reactivates an auth_error source when a new credential is entered', async () => {
    baseHandlers();
    const broken = { ...source, status: 'auth_error' };
    server.use(
      http.get('/api/knowledge/bases/kb_1/sources', () =>
        HttpResponse.json({ items: [broken], nextCursor: null }),
      ),
      http.patch('/api/knowledge/sources/ksrc_1', () =>
        HttpResponse.json({ ...broken, status: 'active' }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    await fill('knowledge-source-secret', 'glpat-new');
    await click(button('保存', dialog('编辑来源')));
    expect(patchBody('/api/knowledge/sources/ksrc_1')).toMatchObject({
      status: 'active',
      secrets: { token: 'glpat-new' },
    });
  });

  it('disables manual sync for a non-active source and explains why', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/sources', () =>
        HttpResponse.json({ items: [{ ...source, status: 'paused' }], nextCursor: null }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    const syncButton = button('立即同步');
    expect(syncButton.disabled).toBe(true);
    expect(syncButton.title).toBe('来源未启用，无法同步');
  });

  it('disables manual sync while the submission is in flight', async () => {
    baseHandlers();
    const response = deferred<void>();
    server.use(
      http.post('/api/knowledge/sources/ksrc_1/sync', async () => {
        await response.promise;
        return HttpResponse.json({ jobId: 'kjob_1', syncRunId: 'ksyn_1' }, { status: 202 });
      }),
      http.get('/api/knowledge/sources/ksrc_1/runs', () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get('/api/knowledge/jobs/kjob_1', () => HttpResponse.json(syncJob('running', 'kjob_1'))),
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('立即同步'));
    const syncButton = button('立即同步');
    expect(syncButton.disabled).toBe(true);
    expect(syncButton.title).toBe('正在提交同步任务');
    await act(async () => response.resolve());
    await flush();
  });

  it('sends the edited range instead of echoing the stored one back', async () => {
    baseHandlers();
    server.use(http.patch('/api/knowledge/sources/ksrc_1', () => HttpResponse.json(source)));
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    const editor = dialog('编辑来源');
    await fill('source-range-0-external', '34');
    await click(button('保存', editor));
    expect(patchBody('/api/knowledge/sources/ksrc_1')).toMatchObject({
      ranges: [
        {
          kind: 'gitlab_project',
          externalId: '34',
          ref: 'main',
          paths: ['docs'],
          enabled: true,
        },
      ],
    });
  });

  it('adds a second range and saves both', async () => {
    baseHandlers();
    server.use(http.patch('/api/knowledge/sources/ksrc_1', () => HttpResponse.json(source)));
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    const editor = dialog('编辑来源');
    await click(button('添加范围', editor));
    await fill('source-range-1-external', '56');
    await fill('source-range-1-ref', 'release');
    await fill('source-range-1-paths', 'src, docs');
    await click(button('保存', editor));
    expect(
      (patchBody('/api/knowledge/sources/ksrc_1') as { ranges: unknown[] }).ranges,
    ).toHaveLength(2);
    expect(patchBody('/api/knowledge/sources/ksrc_1')).toMatchObject({
      ranges: [
        { externalId: '12', ref: 'main', paths: ['docs'], enabled: true },
        { externalId: '56', ref: 'release', paths: ['src', 'docs'], enabled: true },
      ],
    });
  });

  it('keeps the surviving range value and focus after deleting the first row', async () => {
    baseHandlers();
    server.use(http.patch('/api/knowledge/sources/ksrc_1', () => HttpResponse.json(source)));
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    const editor = dialog('编辑来源');
    await click(button('添加范围', editor));
    await fill('source-range-1-external', '56');
    await fill('source-range-1-ref', 'release');
    const second = document.getElementById('source-range-1-external') as HTMLInputElement;
    await act(async () => second.focus());
    await click(button('删除范围 1', editor));
    const survivor = document.getElementById('source-range-0-external') as HTMLInputElement;
    expect(survivor.value).toBe('56');
    expect(document.activeElement).toBe(survivor);
    await click(button('保存', editor));
    const patch = patchBody('/api/knowledge/sources/ksrc_1') as {
      ranges: Array<Record<string, unknown>>;
    };
    expect(patch.ranges).toHaveLength(1);
    expect(patch.ranges[0]).toMatchObject({ externalId: '56', ref: 'release', paths: [] });
    expect(patch.ranges[0]).not.toHaveProperty('clientId');
  });

  it('explains a missing range on submit instead of disabling save', async () => {
    baseHandlers();
    server.use(http.patch('/api/knowledge/sources/ksrc_1', () => HttpResponse.json(source)));
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    const editor = dialog('编辑来源');
    await click(button('删除范围 1', editor));
    expect(editor.textContent).toContain('至少需要一个范围');
    const save = button('保存', editor);
    expect(save.disabled).toBe(false);
    await click(save);
    expect(patchBody('/api/knowledge/sources/ksrc_1')).toBeUndefined();
  });

  it('explains that every range is disabled on submit instead of disabling save', async () => {
    baseHandlers();
    server.use(http.patch('/api/knowledge/sources/ksrc_1', () => HttpResponse.json(source)));
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    const editor = dialog('编辑来源');
    await click(editor.querySelector<HTMLElement>('#source-range-0-enabled') as HTMLElement);
    expect(editor.textContent).toContain('至少需要一个启用的范围');
    const save = button('保存', editor);
    expect(save.disabled).toBe(false);
    await click(save);
    expect(patchBody('/api/knowledge/sources/ksrc_1')).toBeUndefined();
  });

  it('does not offer eviction-based deletion for a feed', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/sources', () =>
        HttpResponse.json({
          items: [
            {
              ...source,
              id: 'ksrc_2',
              type: 'feed',
              name: '行业资讯',
              config: {},
              hasSecret: false,
              ranges: [
                {
                  id: 'krng_2',
                  kind: 'feed',
                  externalId: 'https://example.com/feed.xml',
                  ref: null,
                  paths: [],
                  enabled: true,
                },
              ],
            },
          ],
          nextCursor: null,
        }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 行业资讯'));
    const editor = dialog('编辑来源');
    expect(editor.textContent).toContain('不会把条目滚出窗口当作删除');
    expect(editor.querySelector('#knowledge-source-sync-deletions')).toBeNull();
  });
  it('creates a source with the range entered in its single row', async () => {
    baseHandlers();
    server.use(
      http.post('/api/knowledge/bases/kb_1/sources', () =>
        HttpResponse.json({ ...source, id: 'ksrc_new' }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('新建来源'));
    await click(sourceChoice('飞书知识库', dialog('新建来源')));
    const creator = dialog('新建来源');
    await fill('source-name', '研发空间');
    await fill('source-range-0-external', 'spc_9');
    await fill('source-app-id', 'cli_x');
    await fill('knowledge-source-secret', 'secret');
    await click(button('创建', creator));
    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/sources',
      )?.body,
    ).toMatchObject({
      type: 'feishu_wiki',
      ranges: [{ kind: 'wiki_space', externalId: 'spc_9', enabled: true }],
    });
  });

  it('starts a new source with five provider choices and shows only that provider fields', async () => {
    baseHandlers();
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('新建来源'));
    const creator = dialog('新建来源');
    expect(creator.classList.contains('max-w-190')).toBe(true);
    for (const label of ['GitHub', 'GitLab', '飞书知识库', '飞书云盘', 'RSS']) {
      expect(creator.textContent).toContain(label);
    }
    expect(creator.querySelector('#source-name')).toBeNull();

    await click(sourceChoice('GitHub', creator));
    expect(creator.textContent).toContain('API 地址');
    expect((creator.querySelector('#source-github-api') as HTMLInputElement).placeholder).toBe(
      'https://api.github.com',
    );
    expect(creator.textContent).toContain('Access Token');
    expect(creator.textContent).toContain('仓库');
    expect(creator.textContent).toContain('仅同步文本文件');
    expect(creator.textContent).toContain('留空读取整个仓库');
    expect(creator.textContent).not.toContain('整个项目');
    expect(creator.textContent).toContain('Contents 只读权限');
    expect(creator.querySelector('#source-app-id')).toBeNull();

    await click(button('更换来源', creator));
    await click(sourceChoice('GitLab', creator));
    expect(creator.textContent).toContain('实例 URL');
    expect(creator.textContent).not.toContain('API 地址');
    expect(creator.textContent).toContain('仅同步文本文件');
    expect(creator.textContent).toContain('留空读取整个项目');
    expect(creator.textContent).not.toContain('整个仓库');
    expect(creator.textContent).not.toContain('Contents 只读权限');
    expect(creator.querySelector('#source-app-id')).toBeNull();

    await click(button('更换来源', creator));
    await click(sourceChoice('飞书知识库', creator));
    expect(creator.querySelector('#source-app-id')).toBeTruthy();
    expect(creator.querySelector('#knowledge-source-secret')).toBeTruthy();
    expect(creator.textContent).toContain('知识空间');
    expect(creator.textContent).not.toContain('Access Token');
  });

  it('clears the previous provider credentials and connection fields when switching', async () => {
    baseHandlers();
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('新建来源'));
    const creator = dialog('新建来源');
    await click(sourceChoice('GitHub', creator));
    await fill('source-name', '仓库');
    await fill('source-github-api', 'https://ghe.example.com/api/v3');
    await fill('source-range-0-external', 'acme/docs');
    await fill('knowledge-source-secret', 'ghp_secret');

    await click(button('更换来源', creator));
    await click(button('放弃并切换', dialog('放弃未保存的更改？')));
    await click(sourceChoice('GitLab', creator));
    expect((document.getElementById('knowledge-source-secret') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('source-gitlab-url') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('source-name') as HTMLInputElement).value).toBe('仓库');
    expect(document.getElementById('source-range-0-external')).toBeTruthy();

    await click(button('更换来源', creator));
    await click(sourceChoice('飞书知识库', creator));
    expect((document.getElementById('source-app-id') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('knowledge-source-secret') as HTMLInputElement).value).toBe('');
  });

  it('opens the stored configuration directly when editing an existing source', async () => {
    baseHandlers();
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    const editor = dialog('编辑来源');
    expect((editor.querySelector('#source-name') as HTMLInputElement).value).toBe('产品仓库');
    expect((editor.querySelector('#source-gitlab-url') as HTMLInputElement).value).toBe(
      'https://gitlab.example.com',
    );
    expect(
      [...editor.querySelectorAll('button')].some((item) => item.textContent?.includes('飞书云盘')),
    ).toBe(false);
  });

  it('creates a GitHub source with repo, per-range ref and Enterprise API root', async () => {
    baseHandlers();
    server.use(
      http.post('/api/knowledge/bases/kb_1/sources', () =>
        HttpResponse.json({ ...source, id: 'ksrc_gh', type: 'github' }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('新建来源'));
    await click(sourceChoice('GitHub', dialog('新建来源')));
    const creator = dialog('新建来源');
    await fill('source-name', '仓库文档');
    await fill('source-github-api', 'https://ghe.example.com/api/v3');
    await fill('source-range-0-external', 'acme/docs');
    await fill('source-range-0-ref', 'release');
    await fill('source-range-0-paths', 'docs, README.md');
    await fill('knowledge-source-secret', 'ghp_x');
    await click(button('创建', creator));
    const body = calls.find(
      (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/sources',
    )?.body as Record<string, unknown> | undefined;
    expect(body).toMatchObject({
      type: 'github',
      name: '仓库文档',
      syncCron: null,
      ranges: [
        {
          kind: 'github_repo',
          externalId: 'acme/docs',
          ref: 'release',
          paths: ['docs', 'README.md'],
          enabled: true,
        },
      ],
      config: {
        baseUrl: 'https://ghe.example.com/api/v3',
        projectId: 'acme/docs',
        syncDeletions: false,
      },
      secrets: { token: 'ghp_x' },
    });
    expect(body?.config).not.toHaveProperty('ref');
  });

  it('keeps a GitHub range ref out of config when editing', async () => {
    baseHandlers();
    const githubSource = {
      ...source,
      id: 'ksrc_gh',
      type: 'github',
      config: {
        baseUrl: 'https://api.github.com',
        projectId: 'acme/docs',
        ref: 'main',
        syncDeletions: true,
      },
      ranges: [
        {
          id: 'krng_gh',
          kind: 'github_repo',
          externalId: 'acme/docs',
          ref: 'main',
          paths: ['docs'],
          enabled: true,
        },
      ],
    };
    server.use(
      http.get('/api/knowledge/bases/kb_1/sources', () =>
        HttpResponse.json({ items: [githubSource], nextCursor: null }),
      ),
      http.patch('/api/knowledge/sources/ksrc_gh', () => HttpResponse.json(githubSource)),
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    const editor = dialog('编辑来源');
    await fill('source-range-0-ref', 'release');
    await click(button('保存', editor));
    const patch = patchBody('/api/knowledge/sources/ksrc_gh') as {
      config: Record<string, unknown>;
      ranges: Array<Record<string, unknown>>;
    };
    expect(patch.ranges[0]).toMatchObject({ ref: 'release' });
    expect(patch.config).not.toHaveProperty('ref');
  });

  it('creates a GitLab source with instance URL, project and ref', async () => {
    baseHandlers();
    server.use(http.post('/api/knowledge/bases/kb_1/sources', () => HttpResponse.json(source)));
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('新建来源'));
    await click(sourceChoice('GitLab', dialog('新建来源')));
    const creator = dialog('新建来源');
    await fill('source-name', '研发仓库');
    await fill('source-gitlab-url', 'https://gitlab.example.com');
    await fill('source-range-0-external', 'group/docs');
    await fill('source-range-0-ref', 'main');
    await fill('knowledge-source-secret', 'glpat_x');
    await click(button('创建', creator));
    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/sources',
      )?.body,
    ).toMatchObject({
      type: 'gitlab',
      ranges: [{ kind: 'gitlab_project', externalId: 'group/docs', ref: 'main', enabled: true }],
      config: {
        baseUrl: 'https://gitlab.example.com',
        projectId: 'group/docs',
        ref: 'main',
        syncDeletions: false,
      },
      secrets: { token: 'glpat_x' },
    });
  });

  it('shows provider, target summary, cron and last sync status on each source row', async () => {
    baseHandlers();
    const synced = {
      ...source,
      syncCron: '0 3 * * *',
      lastSyncAt: '2026-01-02T00:00:00Z',
      lastSyncStatus: 'succeeded',
    };
    const githubSource = {
      ...source,
      id: 'ksrc_gh',
      type: 'github',
      name: '文档仓库',
      config: { baseUrl: 'https://api.github.com' },
      ranges: [
        {
          id: 'krng_gh',
          kind: 'github_repo',
          externalId: 'acme/docs',
          ref: 'main',
          paths: ['docs'],
          enabled: true,
        },
      ],
    };
    server.use(
      http.get('/api/knowledge/bases/kb_1/sources', () =>
        HttpResponse.json({ items: [synced, githubSource], nextCursor: null }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    const rows = [...document.querySelectorAll('li')];
    const gitlabRow = rows.find((item) => item.textContent?.includes('产品仓库'));
    expect(gitlabRow?.textContent).toContain('GitLab');
    expect(gitlabRow?.textContent).toContain('12@main');
    expect(gitlabRow?.textContent).toContain('cron 0 3 * * *');
    expect(gitlabRow?.textContent).toContain('上次同步 成功');
    const githubRow = rows.find((item) => item.textContent?.includes('文档仓库'));
    expect(githubRow?.textContent).toContain('GitHub');
    expect(githubRow?.textContent).toContain('acme/docs@main');
  });
});

describe('knowledge package export and import', () => {
  it('downloads the exported zip through the normal api request', async () => {
    baseHandlers();
    server.use(
      http.get(
        '/api/knowledge/bases/kb_1/export',
        () => new HttpResponse('zip', { headers: { 'content-type': 'application/zip' } }),
      ),
    );
    const createObjectURL = vi.fn(() => 'blob:kit');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    await mount('/knowledge');
    await openMenu('操作 产品手册');
    await chooseMenuItem('导出知识包');
    await flush();
    expect(calls.some((item) => item.path === '/api/knowledge/bases/kb_1/export')).toBe(true);
    expect(createObjectURL).toHaveBeenCalled();
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(await blob.text()).toBe('zip');
  });

  it('shows the recoverable conflict when the imported profile is missing', async () => {
    let uploaded = '';
    server.use(
      http.get('/api/knowledge/bases', () => HttpResponse.json({ items: [], nextCursor: null })),
      http.get('/api/agents', () => HttpResponse.json([])),
      http.post('/api/knowledge/bases/import', async ({ request }) => {
        uploaded = new TextDecoder().decode(await request.arrayBuffer());
        return HttpResponse.json(
          {
            code: 'CONFLICT',
            message: '缺少 embedding 模型 profile「bge-m3」；请先创建同名 profile 再导入',
          },
          { status: 409 },
        );
      }),
    );
    await mount('/knowledge');
    await openMenu('更多操作');
    await chooseMenuItem('导入知识包');
    const file = new File(['zip'], 'handbook.zip', { type: 'application/zip' });
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>('input[type="file"]');
      if (!input) throw new Error('Missing file input');
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(calls.find((item) => item.path === '/api/knowledge/bases/import')?.body).toEqual({
      __blob: 'application/zip',
    });
    expect(uploaded).toBe('zip');
    expect(document.body.textContent).toContain('知识包没有导入');
    expect(document.body.textContent).toContain('缺少 embedding 模型 profile');
    expect(button('重试')).toBeDefined();
  });
});

describe('knowledge source configuration check', () => {
  it('submits a read-only remote probe instead of claiming the local check tested connectivity', async () => {
    baseHandlers();
    server.use(
      http.post('/api/knowledge/sources/ksrc_1/test', () =>
        HttpResponse.json({ jobId: 'kjob_probe' }),
      ),
      http.get('/api/knowledge/jobs/kjob_probe', () =>
        HttpResponse.json({
          id: 'kjob_probe',
          type: 'source_probe',
          status: 'succeeded',
          step: null,
          progress: 100,
          attempts: 1,
          error: null,
          result: { ok: true, checks: [{ rangeId: 'krng_1', ok: true }] },
          createdAt: '2026-01-01T00:00:00Z',
          startedAt: '2026-01-01T00:00:00Z',
          endedAt: '2026-01-01T00:00:00Z',
        }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    const check = button('检查配置');
    expect(check.title).toContain('只读远程连接测试');
    await click(check);
    expect(
      calls.some(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/sources/ksrc_1/test',
      ),
    ).toBe(true);
    await waitFor(() => document.body.textContent?.includes('连接测试通过') === true);
    expect(document.body.textContent).toContain('krng_1 · 可读');
  });
});

describe('knowledge source pagination', () => {
  it('loads every source page so older sources can still be edited or synced', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/sources', ({ request }) =>
        new URL(request.url).searchParams.get('cursor') === 'ksrc_cursor'
          ? HttpResponse.json({
              items: [{ ...source, id: 'ksrc_old', name: '旧仓库' }],
              nextCursor: null,
            })
          : HttpResponse.json({ items: [source], nextCursor: 'ksrc_cursor' }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    expect(calls.some((item) => item.path.includes('cursor=ksrc_cursor'))).toBe(true);
    expect(document.body.textContent).toContain('旧仓库');
    expect(document.body.textContent).toContain('2 个来源');
  });
});

describe('knowledge request transport', () => {
  it('turns a real network failure into the offline message', async () => {
    server.use(
      http.get('/api/knowledge/bases', () => HttpResponse.error()),
      http.get('/api/agents', () => HttpResponse.json([])),
    );
    await mount('/knowledge');
    expect(document.body.textContent).toContain('连不上 API 服务');
  });

  it('does not treat a jsdom cookie as a real logged-in session', async () => {
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom 没有 Cookie Store API，这里只验证不伪造登录。
    document.cookie = 'session=jsdom-only';
    let cookie: string | null = null;
    server.use(
      http.get('/api/knowledge/model-profiles', ({ request }) => {
        cookie = request.headers.get('cookie');
        return HttpResponse.json([]);
      }),
    );
    const { api } = await import('../src/lib/api.js');
    await api.knowledgeModelProfiles();
    // jsdom 的 cookie 没有真实登录会话，Node fetch 也不会自动带上；这里只守住「不伪造登录」。
    expect(cookie).toBeNull();
    // biome-ignore lint/suspicious/noDocumentCookie: 同上，清理 jsdom 测试 cookie。
    document.cookie = 'session=; Max-Age=0';
  });

  it('propagates an abort after the handler starts as AbortError instead of a network failure', async () => {
    let entered!: () => void;
    const handlerEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const releaseHandler = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get('/api/knowledge/versions/kdv_abort/markdown', async () => {
        entered();
        await releaseHandler;
        return markdownResponse('正文');
      }),
    );
    const { api } = await import('../src/lib/api.js');
    const controller = new AbortController();
    try {
      const pending = api.knowledgeMarkdown('kdv_abort', controller.signal);
      await handlerEntered;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      release();
    }
  });
});
