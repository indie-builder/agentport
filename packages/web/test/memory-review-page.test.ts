import type { Agent, MemoryChange, MemoryReview } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createBrowserHistory,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/lib/api.js';
import { MemoryPage } from '../src/pages/memory.js';
import { memorySearchSchema } from '../src/routes/-search.js';
import { allAccessMe } from './me-fixture.js';

const agentA: Agent = {
  id: 'agent-a',
  slug: 'agent-a',
  name: '专家甲',
  role: '通用助手',
  description: '',
  model: 'claude-sonnet-5-5',
  systemPrompt: '',
  serverIds: [],
  skillIds: [],
  pluginBindings: [],
  subAgentIds: [],
  runtimeEnvironmentId: null,
  allowedTools: [],
  disallowedTools: [],
  permissionMode: 'default',
  uiFormat: 'markdown',
  maxTurns: 20,
  maxBudgetUsd: 2,
  timeoutMs: 600_000,
  enabled: true,
  parentId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const agentB: Agent = { ...agentA, id: 'agent-b', slug: 'agent-b', name: '专家乙' };

function makeReview(overrides: Partial<MemoryReview> & Pick<MemoryReview, 'runId'>): MemoryReview {
  return {
    modelAgentId: 'agent-a',
    target: { kind: 'personal' },
    status: 'succeeded',
    decision: 'pending',
    sources: [{ conversationId: 'conv-1', title: '会话一', messageCount: 4 }],
    before: { content: '旧内容', globs: null },
    proposal: {
      summary: '补充长期偏好',
      proposedContent: '新内容',
      evidence: [{ messageId: 'msg-1', quote: '以后都用中文回答' }],
    },
    appliedChangeId: null,
    costUsd: '0.1200',
    error: null,
    ...overrides,
  };
}

const change: MemoryChange = {
  id: 'chg_1',
  target: { kind: 'personal' },
  before: { content: '旧内容', globs: null },
  after: { content: '新内容', globs: null },
  sourceReviewRunId: 'run-apply',
  reversesChangeId: null,
  state: 'applied',
  createdAt: '2026-10-01T00:00:00.000Z',
};

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;
let browserHistory: ReturnType<typeof createBrowserHistory> | null = null;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function mount(
  url = '/memory?tab=reviews',
  options: { browser?: boolean; stack?: string[] } = {},
) {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const memoryRoute = createRoute({
    getParentRoute: () => shell,
    path: '/memory',
    validateSearch: memorySearchSchema,
    component: MemoryPage,
  });
  const history = options.browser
    ? createBrowserHistory()
    : createMemoryHistory({ initialEntries: [url] });
  if (options.browser) {
    for (const entry of options.stack ?? []) {
      history.push(entry);
      history.flush?.();
    }
    history.push(url);
    history.flush?.();
    browserHistory = history as ReturnType<typeof createBrowserHistory>;
  }
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([memoryRoute])]),
    history,
  });
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await flush();
  return router;
}

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const match = buttonOrNull(label, scope);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function buttonOrNull(label: string, scope: ParentNode = document): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

async function openFirstDetail() {
  const view = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    item.getAttribute('aria-label')?.startsWith('查看'),
  );
  if (!view) throw new Error('Missing view button');
  await click(view);
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeTruthy());
  return document.querySelector('[role="dialog"]') as HTMLElement;
}

function dialogButton(label: string): HTMLButtonElement {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) throw new Error('Missing dialog');
  return button(label, dialog);
}

function allDialogs(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
}

function discardDialog(): HTMLElement | null {
  return allDialogs().find((item) => item.textContent?.includes('放弃新建的回顾？')) ?? null;
}

async function pressEscape() {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await flush();
}

async function pressOutside() {
  const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');
  if (!overlay) throw new Error('Missing dialog overlay');
  await act(async () => {
    overlay.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }),
    );
    overlay.dispatchEvent(
      new MouseEvent('click', { bubbles: true, button: 0, clientX: 0, clientY: 0 }),
    );
  });
  await flush();
}

async function browserBack() {
  await act(async () => {
    window.history.back();
  });
  await flush();
}

async function fill(id: string, value: string) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    throw new Error(`Missing input: ${id}`);
  }
  await act(async () => {
    const prototype =
      element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.spyOn(api, 'me').mockResolvedValue(allAccessMe);
  vi.spyOn(api, 'agents').mockResolvedValue([agentA, agentB]);
  vi.spyOn(api, 'personalMemory').mockResolvedValue({
    content: '',
    revision: 0,
    updatedAt: null,
  });
  vi.spyOn(api, 'personalMemoryVersions').mockResolvedValue({ items: [] });
  vi.spyOn(api, 'conversations').mockResolvedValue([
    {
      id: 'conv-1',
      agentId: 'agent-a',
      title: '会话一',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      lastMessage: null,
    },
  ]);
  vi.spyOn(api, 'agentRules').mockResolvedValue([]);
  vi.spyOn(api, 'agentMemoryVersions').mockResolvedValue({ items: [] });
  vi.spyOn(api, 'agentRuleVersions').mockResolvedValue({ items: [] });
  vi.spyOn(api, 'memoryReviews').mockResolvedValue({ items: [] });
  vi.spyOn(api, 'createMemoryReview').mockResolvedValue({ runId: 'run-new' });
  vi.spyOn(api, 'applyMemoryReview').mockResolvedValue(change);
  vi.spyOn(api, 'rejectMemoryReview').mockImplementation(async (runId) => ({
    ...makeReview({ runId, decision: 'rejected' }),
  }));
  vi.spyOn(api, 'cancelRun').mockResolvedValue(undefined);
  vi.spyOn(api, 'rollbackMemoryChange').mockResolvedValue(change);
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
    },
  });
  client.setQueryData(['agents'], [agentA, agentB]);
  client.setQueryData(['me'], allAccessMe);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  browserHistory?.destroy?.();
  browserHistory = null;
  window.history.replaceState(null, '', '/');
  client.clear();
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('历史回顾', () => {
  it('把个人偏好/专家记忆/专家规则与真实状态显示在列表', async () => {
    vi.mocked(api.memoryReviews).mockResolvedValue({
      items: [
        makeReview({ runId: 'run-q', status: 'queued' }),
        makeReview({
          runId: 'run-r',
          status: 'running',
          target: { kind: 'agent_memory', agentId: 'agent-b' },
        }),
        makeReview({
          runId: 'run-rule',
          status: 'succeeded',
          target: { kind: 'agent_rule', agentId: 'agent-a', slug: 'no-console' },
        }),
        makeReview({ runId: 'run-f', status: 'failed', proposal: null, error: '模型调用失败' }),
        makeReview({ runId: 'run-c', status: 'cancelled', proposal: null }),
        makeReview({ runId: 'run-t', status: 'timeout', proposal: null }),
      ],
    });
    await mount();
    await vi.waitFor(() => expect(host.textContent).toContain('专家甲 / no-console'));
    for (const text of [
      '个人偏好',
      '专家记忆',
      '专家规则',
      '排队中',
      '运行中',
      '成功',
      '失败',
      '已取消',
      '超时',
    ]) {
      expect(host.textContent).toContain(text);
    }
    expect(host.textContent).toContain('补充长期偏好');
    expect(host.querySelectorAll('h1')).toHaveLength(1);
  });

  it('按 URL 的专家筛选请求列表', async () => {
    await mount('/memory?tab=reviews&agent=agent-b');
    await vi.waitFor(() =>
      expect(api.memoryReviews).toHaveBeenCalledWith(
        { agentId: 'agent-b' },
        expect.any(AbortSignal),
      ),
    );
  });

  it('轮询配置在排队/运行时为 3 秒，终态停止', async () => {
    await mount();
    const query = client
      .getQueryCache()
      .getAll()
      .find((item) => item.queryKey[0] === 'memory-reviews');
    const interval = query?.options.refetchInterval;
    expect(typeof interval).toBe('function');
    if (typeof interval !== 'function') return;
    const evaluate = interval as (input: {
      state: { data: { items: MemoryReview[] } };
    }) => number | false;
    expect(
      evaluate({ state: { data: { items: [makeReview({ runId: 'q', status: 'queued' })] } } }),
    ).toBe(3_000);
    expect(
      evaluate({ state: { data: { items: [makeReview({ runId: 's', status: 'succeeded' })] } } }),
    ).toBe(false);
  });

  it('创建回顾提交幂等键并在提交前显示预算与超时', async () => {
    await mount();
    await vi.waitFor(() => expect(host.textContent).toContain('新建回顾'));
    const createButton = button('新建回顾');
    await click(createButton);
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('新建记忆回顾'),
    );
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) throw new Error('Missing create dialog');
    await vi.waitFor(() => expect(dialog.textContent).toContain('会话一'));

    expect(dialog.textContent).toContain('单次预算上限 $2');
    expect(dialog.textContent).toContain('超时 10 分钟');

    const checkbox = document.querySelector<HTMLElement>('[role="checkbox"]');
    if (!checkbox) throw new Error('Missing conversation checkbox');
    await click(checkbox);
    await fill('memory-review-instruction', '只整理长期偏好');
    await click(dialogButton('开始回顾'));

    await vi.waitFor(() => expect(api.createMemoryReview).toHaveBeenCalledTimes(1));
    const [input, key] = vi.mocked(api.createMemoryReview).mock.calls[0] ?? [];
    expect(input).toEqual({
      modelAgentId: 'agent-a',
      target: { kind: 'personal' },
      sources: [{ conversationId: 'conv-1' }],
      instruction: '只整理长期偏好',
    });
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  });

  it('createMemoryReview 把 Idempotency-Key 放进请求头', async () => {
    vi.mocked(api.createMemoryReview).mockRestore();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ runId: 'run-1' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const input = {
      modelAgentId: 'agent-a',
      target: { kind: 'personal' as const },
      sources: [{ conversationId: 'conv-1' }],
      instruction: '',
    };
    const key = '11111111-1111-4111-8111-111111111111';
    await expect(api.createMemoryReview(input, key)).resolves.toEqual({ runId: 'run-1' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/memory-reviews',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
      }),
    );
  });

  it('采用成功后显示已采用与回滚入口', async () => {
    let applied = false;
    vi.mocked(api.memoryReviews).mockImplementation(async () => ({
      items: [
        applied
          ? makeReview({
              runId: 'run-apply',
              decision: 'applied',
              appliedChangeId: 'chg_1',
            })
          : makeReview({ runId: 'run-apply' }),
      ],
    }));
    vi.mocked(api.applyMemoryReview).mockImplementation(async () => {
      applied = true;
      return change;
    });
    await mount();
    const dialog = await openFirstDetail();
    expect(dialog.textContent).toContain('以后都用中文回答');
    expect(dialog.textContent).toContain('回顾前内容');
    expect(dialog.textContent).toContain('旧内容');
    expect(dialog.textContent).toContain('新内容');

    await click(dialogButton('采用'));
    expect(api.applyMemoryReview).toHaveBeenCalledWith('run-apply');
    await vi.waitFor(() => expect(dialog.textContent).toContain('提案已采用'));
    expect(dialog.textContent).toContain('采用前内容');
    expect(dialog.textContent).not.toContain('当前内容');
    expect(dialog.textContent).toContain('回滚');
  });

  it('采用冲突显示目标已被修改并保留重新生成', async () => {
    vi.mocked(api.memoryReviews).mockResolvedValue({
      items: [makeReview({ runId: 'run-conflict' })],
    });
    vi.mocked(api.applyMemoryReview).mockRejectedValue(
      new ApiError(409, '目标内容在审核后已被修改，请重新发起审核', { code: 'CONFLICT' }),
    );
    await mount();
    const dialog = await openFirstDetail();
    await click(dialogButton('采用'));
    await vi.waitFor(() => expect(dialog.textContent).toContain('目标已被修改，请重新生成。'));
    expect(button('重新生成', dialog).disabled).toBe(false);
  });

  it('拒绝提案后列表变为已拒绝', async () => {
    let rejected = false;
    vi.mocked(api.memoryReviews).mockImplementation(async () => ({
      items: [
        rejected
          ? makeReview({ runId: 'run-reject', decision: 'rejected' })
          : makeReview({ runId: 'run-reject' }),
      ],
    }));
    vi.mocked(api.rejectMemoryReview).mockImplementation(async (runId) => {
      rejected = true;
      return makeReview({ runId, decision: 'rejected' });
    });
    await mount();
    const dialog = await openFirstDetail();
    await click(dialogButton('不采用'));
    expect(api.rejectMemoryReview).toHaveBeenCalledWith('run-reject');
    await vi.waitFor(() => expect(dialog.textContent).toContain('提案已拒绝。'));
  });

  it('重新生成不直接提交，打开预填的新建表单并显示预算与超时', async () => {
    vi.mocked(api.memoryReviews).mockResolvedValue({
      items: [
        makeReview({
          runId: 'run-empty',
          proposal: { summary: '没有需要改的内容', proposedContent: null, evidence: [] },
        }),
      ],
    });
    await mount();
    const dialog = await openFirstDetail();
    expect(dialog.textContent).toContain('未形成改进候选');
    await click(dialogButton('重新生成'));

    expect(api.createMemoryReview).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('新建记忆回顾'),
    );
    const createDialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(createDialog.textContent).toContain('会话一');
    expect(createDialog.textContent).toContain('单次预算上限 $2');
    expect(createDialog.textContent).toContain('超时 10 分钟');
    const instruction = document.getElementById('memory-review-instruction');
    expect(instruction).toBeInstanceOf(HTMLTextAreaElement);
    expect((instruction as HTMLTextAreaElement).value).toBe('');

    await fill('memory-review-instruction', '只保留长期结论');
    await click(button('开始回顾', createDialog));
    await vi.waitFor(() => expect(api.createMemoryReview).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.createMemoryReview).mock.calls[0]?.[0]).toEqual({
      modelAgentId: 'agent-a',
      target: { kind: 'personal' },
      sources: [{ conversationId: 'conv-1' }],
      instruction: '只保留长期结论',
    });
  });

  it('同一输入重试复用同一幂等键，修改输入后才换键', async () => {
    vi.mocked(api.memoryReviews).mockResolvedValue({
      items: [makeReview({ runId: 'run-key' })],
    });
    vi.mocked(api.createMemoryReview)
      .mockRejectedValueOnce(new Error('连不上 API 服务'))
      .mockRejectedValueOnce(new Error('连不上 API 服务'))
      .mockResolvedValue({ runId: 'run-new' });
    await mount();
    await click(button('新建回顾'));
    await vi.waitFor(() =>
      expect(document.getElementById('memory-review-instruction')).toBeTruthy(),
    );
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    await vi.waitFor(() => expect(dialog.textContent).toContain('会话一'));
    const checkbox = document.querySelector<HTMLElement>('[role="checkbox"]');
    if (!checkbox) throw new Error('Missing conversation checkbox');
    await click(checkbox);
    await fill('memory-review-instruction', '保留长期偏好');

    await click(button('开始回顾', dialog));
    await vi.waitFor(() => expect(api.createMemoryReview).toHaveBeenCalledTimes(1));
    await click(button('开始回顾', dialog));
    await vi.waitFor(() => expect(api.createMemoryReview).toHaveBeenCalledTimes(2));
    const firstKey = vi.mocked(api.createMemoryReview).mock.calls[0]?.[1];
    const retryKey = vi.mocked(api.createMemoryReview).mock.calls[1]?.[1];
    expect(firstKey).toBeTruthy();
    expect(retryKey).toBe(firstKey);

    await fill('memory-review-instruction', '保留长期偏好和格式');
    await click(button('开始回顾', dialog));
    await vi.waitFor(() => expect(api.createMemoryReview).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.createMemoryReview).mock.calls[2]?.[1]).not.toBe(firstKey);
  });

  it('新建回顾的取消、Esc、外部点击与关闭按钮共用放弃确认', async () => {
    await mount();
    await click(button('新建回顾'));
    await vi.waitFor(() =>
      expect(document.getElementById('memory-review-instruction')).toBeTruthy(),
    );
    const checkbox = document.querySelector<HTMLElement>('[role="checkbox"]');
    if (!checkbox) throw new Error('Missing conversation checkbox');
    await click(checkbox);

    const createDialog = () =>
      allDialogs().find((item) => item.textContent?.includes('新建记忆回顾')) ?? null;

    // 取消按钮
    await click(button('取消', createDialog() as HTMLElement));
    expect(discardDialog()).toBeTruthy();
    await click(button('取消', discardDialog() as HTMLElement));
    expect(createDialog()).toBeTruthy();

    // 关闭按钮
    await click(button('关闭', createDialog() as HTMLElement));
    expect(discardDialog()).toBeTruthy();
    await click(button('取消', discardDialog() as HTMLElement));

    // Esc
    await pressEscape();
    expect(discardDialog()).toBeTruthy();
    await click(button('取消', discardDialog() as HTMLElement));

    // 外部点击
    await pressOutside();
    expect(discardDialog()).toBeTruthy();

    await click(button('放弃并关闭', discardDialog() as HTMLElement));
    await flush();
    expect(createDialog()).toBeNull();
  });

  it('浏览器返回时确认放弃回顾草稿，取消保留、确认继续原导航', async () => {
    await mount('/memory?tab=reviews', { browser: true, stack: ['/memory'] });
    await click(button('新建回顾'));
    await vi.waitFor(() =>
      expect(document.getElementById('memory-review-instruction')).toBeTruthy(),
    );
    await fill('memory-review-instruction', '只整理长期偏好');
    expect(window.location.search).toBe('?tab=reviews');

    await browserBack();
    await vi.waitFor(() => expect(discardDialog()).toBeTruthy());
    expect(document.body.textContent).not.toContain('放弃未保存的个人偏好？');

    await click(button('取消', discardDialog() as HTMLElement));
    await vi.waitFor(() => expect(window.location.search).toBe('?tab=reviews'));
    const kept = document.getElementById('memory-review-instruction');
    expect(kept).toBeInstanceOf(HTMLTextAreaElement);
    expect((kept as HTMLTextAreaElement).value).toBe('只整理长期偏好');

    await browserBack();
    await vi.waitFor(() => expect(discardDialog()).toBeTruthy());
    await click(button('放弃并离开', discardDialog() as HTMLElement));
    await vi.waitFor(() => expect(window.location.search).toBe(''));
    await vi.waitFor(() => expect(host.textContent).toContain('个人偏好内容（Markdown）'));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('新建回顾草稿阻止同路径页签切换，确认后仅继续该次导航', async () => {
    const router = await mount('/memory?tab=reviews', {
      browser: true,
      stack: ['/memory'],
    });
    await click(button('新建回顾'));
    await vi.waitFor(() =>
      expect(document.getElementById('memory-review-instruction')).toBeTruthy(),
    );
    await fill('memory-review-instruction', '草稿');

    await act(async () => {
      void router.navigate({ to: '/memory', search: { tab: 'personal' } });
    });
    await vi.waitFor(() => expect(discardDialog()).toBeTruthy());
    await click(button('取消', discardDialog() as HTMLElement));
    await flush();
    expect(window.location.search).toBe('?tab=reviews');
    expect(document.getElementById('memory-review-instruction')).toBeTruthy();

    await act(async () => {
      void router.navigate({ to: '/memory', search: { tab: 'personal' } });
    });
    await vi.waitFor(() => expect(discardDialog()).toBeTruthy());
    await click(button('放弃并离开', discardDialog() as HTMLElement));
    await vi.waitFor(() => expect(window.location.search).toBe('?tab=personal'));
    await vi.waitFor(() => expect(host.textContent).toContain('个人偏好内容（Markdown）'));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('新建回顾提交中禁止离开，刷新前有离开保护', async () => {
    let resolve!: (value: { runId: string }) => void;
    vi.mocked(api.createMemoryReview).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await mount('/memory?tab=reviews', { browser: true, stack: ['/memory'] });
    await click(button('新建回顾'));
    await vi.waitFor(() =>
      expect(document.getElementById('memory-review-instruction')).toBeTruthy(),
    );
    const checkbox = document.querySelector<HTMLElement>('[role="checkbox"]');
    if (!checkbox) throw new Error('Missing conversation checkbox');
    await click(checkbox);
    await fill('memory-review-instruction', '草稿');
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    await click(button('开始回顾', dialog));
    await vi.waitFor(() => expect(api.createMemoryReview).toHaveBeenCalledTimes(1));

    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    await browserBack();
    await vi.waitFor(() => expect(discardDialog()).toBeTruthy());
    expect(button('放弃并离开', discardDialog() as HTMLElement).disabled).toBe(true);
    await click(button('取消', discardDialog() as HTMLElement));
    await vi.waitFor(() => expect(window.location.search).toBe('?tab=reviews'));
    expect(document.getElementById('memory-review-instruction')).toBeTruthy();

    await act(async () => resolve({ runId: 'run-new' }));
    await flush();
  });

  it('提交成功时取消被拦下的返回导航，地址栏与路由保持一致', async () => {
    let resolve!: (value: { runId: string }) => void;
    vi.mocked(api.createMemoryReview).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const router = await mount('/memory?tab=reviews', { browser: true, stack: ['/memory'] });
    await click(button('新建回顾'));
    await vi.waitFor(() =>
      expect(document.getElementById('memory-review-instruction')).toBeTruthy(),
    );
    const checkbox = document.querySelector<HTMLElement>('[role="checkbox"]');
    if (!checkbox) throw new Error('Missing conversation checkbox');
    await click(checkbox);
    const createDialog = document.querySelector('[role="dialog"]') as HTMLElement;
    await click(button('开始回顾', createDialog));
    await vi.waitFor(() => expect(api.createMemoryReview).toHaveBeenCalledTimes(1));

    await browserBack();
    await vi.waitFor(() => expect(discardDialog()).toBeTruthy());
    expect(window.location.search).toBe('');

    // 不操作放弃确认而请求成功时，关闭表单不能把地址栏留在被拦下的 /memory。
    await act(async () => resolve({ runId: 'run-new' }));
    await vi.waitFor(() => expect(discardDialog()).toBeNull());
    await vi.waitFor(() => expect(window.location.search).toBe('?tab=reviews'));
    expect(router.state.location.pathname).toBe('/memory');
    expect(router.state.location.search).toEqual({ tab: 'reviews' });
    expect(window.location.pathname + window.location.search).toBe(
      `${router.state.location.pathname}?tab=reviews`,
    );
    expect(host.textContent).toContain('让模型整理值得保存的记忆');
    expect(host.textContent).not.toContain('个人偏好内容（Markdown）');
  });

  it('新建回顾提交中禁止关闭', async () => {
    let resolve!: (value: { runId: string }) => void;
    vi.mocked(api.createMemoryReview).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await mount();
    await click(button('新建回顾'));
    await vi.waitFor(() =>
      expect(document.getElementById('memory-review-instruction')).toBeTruthy(),
    );
    const checkbox = document.querySelector<HTMLElement>('[role="checkbox"]');
    if (!checkbox) throw new Error('Missing conversation checkbox');
    await click(checkbox);
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    await click(button('开始回顾', dialog));

    await pressEscape();
    await pressOutside();
    expect(allDialogs().find((item) => item.textContent?.includes('新建记忆回顾'))).toBeTruthy();
    expect(discardDialog()).toBeNull();
    expect(
      document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="关闭"]'),
    ).toHaveProperty('disabled', true);

    await act(async () => resolve({ runId: 'run-new' }));
    await flush();
  });

  it('详情操作提交中禁用关闭、Esc 与外部点击', async () => {
    vi.mocked(api.memoryReviews).mockResolvedValue({
      items: [makeReview({ runId: 'run-pending' })],
    });
    let resolve!: (value: MemoryChange) => void;
    vi.mocked(api.applyMemoryReview).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await mount();
    await openFirstDetail();
    await click(dialogButton('采用'));

    await pressEscape();
    await pressOutside();
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    expect(
      document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="关闭"]'),
    ).toHaveProperty('disabled', true);

    await act(async () => resolve(change));
    await flush();
  });

  it('详情操作失败原因在关闭并重新打开后仍保留', async () => {
    vi.mocked(api.memoryReviews).mockResolvedValue({
      items: [makeReview({ runId: 'run-error' })],
    });
    vi.mocked(api.applyMemoryReview).mockRejectedValue(new Error('网络中断，请重试'));
    await mount();
    await openFirstDetail();
    await click(dialogButton('采用'));
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('网络中断，请重试'),
    );

    await click(button('关闭', document.querySelector('[role="dialog"]') as HTMLElement));
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    await openFirstDetail();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('网络中断，请重试');
  });

  it('根据服务端版本列表恢复已回滚状态，重开后仍隐藏回滚', async () => {
    let rolledBack = false;
    vi.mocked(api.memoryReviews).mockResolvedValue({
      items: [
        makeReview({
          runId: 'run-rolled',
          decision: 'applied',
          appliedChangeId: 'chg_1',
        }),
      ],
    });
    vi.mocked(api.personalMemoryVersions).mockImplementation(async () => ({
      items: rolledBack
        ? [
            {
              ...change,
              id: 'chg-reverse',
              reversesChangeId: 'chg_1',
              before: { content: '新内容', globs: null },
              after: { content: '旧内容', globs: null },
            },
          ]
        : [],
    }));
    vi.mocked(api.rollbackMemoryChange).mockImplementation(async () => {
      rolledBack = true;
      return {
        ...change,
        id: 'chg-reverse',
        reversesChangeId: 'chg_1',
        before: { content: '新内容', globs: null },
        after: { content: '旧内容', globs: null },
      };
    });
    await mount();
    let dialog = await openFirstDetail();
    await vi.waitFor(() => expect(dialog.textContent).toContain('提案已采用。'));
    await click(dialogButton('回滚'));
    await vi.waitFor(() => expect(dialog.textContent).toContain('已回滚这次变更。'));
    expect(buttonOrNull('回滚', dialog)).toBeUndefined();

    await click(button('关闭', dialog));
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    dialog = await openFirstDetail();
    await vi.waitFor(() => expect(dialog.textContent).toContain('已回滚这次变更。'));
    expect(buttonOrNull('回滚', dialog)).toBeUndefined();

    // 整页重挂载后仍从服务端版本列表恢复已回滚状态。
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    dialog = await openFirstDetail();
    await vi.waitFor(() => expect(dialog.textContent).toContain('已回滚这次变更。'));
    expect(buttonOrNull('回滚', dialog)).toBeUndefined();
  });

  it('列表区分待采用、已采用、已拒绝与已回滚，并显示成功摘要', async () => {
    vi.mocked(api.memoryReviews).mockResolvedValue({
      items: [
        makeReview({
          runId: 'run-pending',
          proposal: { summary: '待采用摘要', proposedContent: 'x', evidence: [] },
        }),
        makeReview({ runId: 'run-applied', decision: 'applied', appliedChangeId: 'chg-ok' }),
        makeReview({ runId: 'run-rejected', decision: 'rejected' }),
        makeReview({ runId: 'run-rolled', decision: 'applied', appliedChangeId: 'chg-rolled' }),
      ],
    });
    vi.mocked(api.personalMemoryVersions).mockResolvedValue({
      items: [
        {
          ...change,
          id: 'chg-reverse',
          reversesChangeId: 'chg-rolled',
          before: { content: 'x', globs: null },
          after: { content: 'y', globs: null },
        },
      ],
    });
    await mount();
    await vi.waitFor(() => expect(host.textContent).toContain('已回滚'));
    for (const label of ['待采用', '已采用', '已拒绝', '已回滚']) {
      expect(host.textContent).toContain(label);
    }
    expect(host.textContent).toContain('待采用摘要');

    const names = [...host.querySelectorAll<HTMLButtonElement>('button[aria-label^="查看"]')].map(
      (item) => item.getAttribute('aria-label'),
    );
    expect(names).toHaveLength(4);
    expect(new Set(names).size).toBe(4);
    expect(names.every((name) => name?.includes('回顾'))).toBe(true);
  });

  it('新规则 slug 复用规则格式校验并关联字段错误', async () => {
    await mount();
    await click(button('新建回顾'));
    await vi.waitFor(() =>
      expect(document.getElementById('memory-review-instruction')).toBeTruthy(),
    );
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    await click(button('目标', dialog));
    const ruleOption = await vi.waitFor(() => {
      const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (item) => item.textContent?.trim() === '专家规则',
      );
      expect(option).toBeTruthy();
      return option as HTMLElement;
    });
    await click(ruleOption);

    await fill('memory-review-rule-slug', 'Bad Slug');
    await vi.waitFor(() => expect(dialog.textContent).toContain('规则 slug 仅允许小写字母'));
    const slug = document.getElementById('memory-review-rule-slug');
    expect(slug?.getAttribute('aria-invalid')).toBe('true');
    expect(slug?.getAttribute('aria-describedby')).toBe('memory-review-rule-error');

    await fill('memory-review-rule-slug', 'memory-review');
    expect(dialog.textContent).not.toContain('规则 slug 仅允许小写字母');
  });

  it('目标被修改后的表单错误关联到字段', async () => {
    await mount();
    await click(button('新建回顾'));
    await vi.waitFor(() =>
      expect(document.getElementById('memory-review-instruction')).toBeTruthy(),
    );
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;

    await click(button('开始回顾', dialog));
    await vi.waitFor(() => expect(dialog.textContent).toContain('至少选择一段来源会话。'));
    const sourceBox = dialog.querySelector<HTMLElement>(
      '[aria-describedby="memory-review-sources-error"]',
    );
    expect(sourceBox?.getAttribute('aria-invalid')).toBe('true');
    await vi.waitFor(() => expect(document.activeElement).toBe(sourceBox));

    await fill('memory-review-instruction', 'a'.repeat(4001));
    expect(dialog.textContent).toContain('4001 / 4000');
    expect(dialog.textContent).toContain('最多 4000 个字符');
    expect(document.getElementById('memory-review-instruction')?.getAttribute('aria-invalid')).toBe(
      'true',
    );
  });

  it('生成中可以取消运行', async () => {
    vi.mocked(api.memoryReviews).mockResolvedValue({
      items: [makeReview({ runId: 'run-cancel', status: 'running', proposal: null })],
    });
    await mount();
    await openFirstDetail();
    await click(dialogButton('取消生成'));
    expect(api.cancelRun).toHaveBeenCalledWith('run-cancel');
  });

  it('关闭详情后焦点回到触发按钮', async () => {
    vi.mocked(api.memoryReviews).mockResolvedValue({
      items: [makeReview({ runId: 'run-focus' })],
    });
    await mount();
    const trigger = button('查看');
    await click(trigger);
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeTruthy());
    const close = document.querySelector<HTMLButtonElement>(
      '[role="dialog"] button[aria-label="关闭"]',
    );
    if (!close) throw new Error('Missing dialog close');
    await click(close);
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
