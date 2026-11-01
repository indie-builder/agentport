import type { Agent, MemoryChange, MemoryReview, PermissionId } from '@agentport/shared';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
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
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/lib/api.js';
import { memoryReviewQuery } from '../src/lib/queries.js';
import { PersonalMemoryPage, PersonalReviewsPage } from '../src/pages/personal-memory.js';
import { chatSearchSchema, personalReviewsSearchSchema } from '../src/routes/-search.js';
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

function meWith(permissionIds: PermissionId[]) {
  return {
    authenticated: true as const,
    user: { businessId: 'test-user', username: 'tester', name: '测试用户' },
    roles: [],
    grants: permissionIds.map((permissionId) => ({ permissionId, scope: 'own_data' as const })),
  };
}

function makeReview(overrides: Partial<MemoryReview> & Pick<MemoryReview, 'runId'>): MemoryReview {
  return {
    modelAgentId: 'agent-a',
    target: { kind: 'personal' },
    status: 'succeeded',
    decision: 'pending',
    sources: [{ conversationId: 'conv-1', title: '会话一', messageCount: 4 }],
    before: { content: '旧内容', globs: null, index: null },
    proposal: {
      summary: '补充长期偏好',
      proposedContent: '新内容',
      evidence: [{ messageId: 'msg-1', quote: '以后都用中文回答', kind: 'user_fact' }],
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
  before: { content: '旧内容', globs: null, index: null },
  after: { content: '新内容', globs: null, index: null },
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
  url = '/personal/reviews',
  options: { browser?: boolean; stack?: string[] } = {},
) {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const memoryRoute = createRoute({
    getParentRoute: () => shell,
    path: '/personal/memory',
    component: PersonalMemoryPage,
  });
  const reviewsRoute = createRoute({
    getParentRoute: () => shell,
    path: '/personal/reviews',
    validateSearch: personalReviewsSearchSchema,
    component: PersonalReviewsPage,
  });
  const chatRoute = createRoute({
    getParentRoute: () => shell,
    path: '/chat',
    validateSearch: chatSearchSchema,
    component: () => null,
  });
  const agentDetailRoute = createRoute({
    getParentRoute: () => shell,
    path: '/agents/$agentId',
    component: () => null,
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
    routeTree: rootRoute.addChildren([
      shell.addChildren([memoryRoute, reviewsRoute, chatRoute, agentDetailRoute]),
    ]),
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

/**
 * 模拟浏览器真实点击：React 在事件派发内同步刷新 DOM 后，浏览器才执行默认激活。
 * `.click()` 在 act 中可能错过这个时序，这里在 document 冒泡末尾强制同步刷新。
 */
async function clickNative(element: HTMLElement) {
  await act(async () => {
    document.addEventListener('click', () => flushSync(() => {}), { once: true });
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  });
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
  return allDialogs().find((item) => item.textContent?.includes('放弃新建的提案？')) ?? null;
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

async function chooseOption(selectLabel: string, optionLabel: string, scope: ParentNode) {
  await click(button(selectLabel, scope));
  const option = await vi.waitFor(() => {
    const element = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.textContent?.trim() === optionLabel,
    );
    expect(element).toBeTruthy();
    return element as HTMLElement;
  });
  await click(option);
}

async function openCreate() {
  await click(button('生成记忆提案'));
  await vi.waitFor(() =>
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('第 1 / 3 步'),
  );
  return document.querySelector('[role="dialog"]') as HTMLElement;
}

function firstConversationCheckbox(): HTMLElement {
  const checkbox = document.querySelector<HTMLElement>('[role="checkbox"]');
  if (!checkbox) throw new Error('Missing conversation checkbox');
  return checkbox;
}

/** 第 1 步选一段来源后进入第 2 步，返回仍在同一弹层内的表单。 */
async function openCreateOnTargetStep() {
  const dialog = await openCreate();
  await click(firstConversationCheckbox());
  await click(button('下一步', dialog));
  return dialog;
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
  vi.spyOn(api, 'personalConversations').mockResolvedValue([
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
  vi.spyOn(api, 'agentMemory').mockResolvedValue({
    files: [
      { name: 'MEMORY.md', size: 10, updatedAt: '2026-10-01T00:00:00.000Z' },
      { name: 'topic.md', size: 20, updatedAt: '2026-10-01T00:00:00.000Z' },
    ],
    initialized: true,
  });
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

describe('记忆提案', () => {
  it('把个人记忆/专家记忆/专家规则与真实状态显示在列表', async () => {
    vi.mocked(api.memoryReviews).mockResolvedValue({
      items: [
        makeReview({ runId: 'run-q', status: 'queued' }),
        makeReview({
          runId: 'run-r',
          status: 'running',
          target: { kind: 'agent_memory', agentId: 'agent-b', name: 'topic.md' },
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
      '个人记忆',
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

  it('默认渲染列表，view=cards 渲染卡片，切换写入 URL 并保留阶段筛选', async () => {
    vi.mocked(api.memoryReviews).mockResolvedValue({
      items: [
        makeReview({
          runId: 'run-a',
          proposal: { summary: '补充长期偏好', proposedContent: 'x', evidence: [] },
        }),
        makeReview({
          runId: 'run-b',
          proposal: { summary: '记录部署约定', proposedContent: 'y', evidence: [] },
        }),
      ],
    });
    const router = await mount('/personal/reviews?stage=pending');
    await vi.waitFor(() => expect(host.textContent).toContain('补充长期偏好'));
    expect(host.querySelector('ul')).toBeTruthy();
    expect(host.querySelectorAll('[data-slot="card"]')).toHaveLength(0);

    await click(button('卡片', host));
    await vi.waitFor(() =>
      expect(router.state.location.search).toMatchObject({ view: 'cards', stage: 'pending' }),
    );
    expect(host.querySelector('ul')).toBeNull();
    const cards = [...host.querySelectorAll<HTMLElement>('[data-slot="card"]')];
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain('运行状态');
    expect(cards[0]?.textContent).toContain('成本');
    expect(cards[0]?.textContent).toContain('补充长期偏好');
    expect(cards[0]?.querySelector('button[aria-label^="查看"]')).toBeTruthy();
  });

  it('按 URL 的专家筛选请求列表', async () => {
    await mount('/personal/reviews?agent=agent-b');
    await vi.waitFor(() =>
      expect(api.memoryReviews).toHaveBeenCalledWith(
        { agentId: 'agent-b' },
        expect.any(AbortSignal),
      ),
    );
  });

  it('列表优先待审核，并按当前已加载记录提供处理状态筛选', async () => {
    vi.mocked(api.memoryReviews).mockResolvedValue({
      items: [
        makeReview({
          runId: 'run-done',
          decision: 'applied',
          appliedChangeId: 'chg-done',
          proposal: { summary: '已处理摘要', proposedContent: 'x', evidence: [] },
        }),
        makeReview({
          runId: 'run-active',
          status: 'running',
          proposal: null,
          sources: [{ conversationId: 'conv-running', title: '生成中会话', messageCount: 1 }],
        }),
        makeReview({
          runId: 'run-pending',
          proposal: { summary: '待审核摘要', proposedContent: 'x', evidence: [] },
        }),
        makeReview({
          runId: 'run-nochange',
          proposal: { summary: '无需变更摘要', proposedContent: null, evidence: [] },
          before: { content: '同内容', globs: null, index: null },
        }),
      ],
    });
    const router = await mount();
    await vi.waitFor(() => expect(host.textContent).toContain('当前已加载 4 条'));
    expect(host.textContent).toContain('待审核 1');
    expect(host.textContent).toContain('生成中 1');
    expect(host.textContent).toContain('已处理 2');
    // 默认顺序把待审核放在已处理之前，不静默改变用户需要先处理的对象。
    expect(host.textContent.indexOf('待审核摘要')).toBeLessThan(
      host.textContent.indexOf('已处理摘要'),
    );

    await chooseOption('按处理状态筛选', '待审核', host);
    expect(host.textContent).toContain('待审核摘要');
    expect(host.textContent).not.toContain('已处理摘要');
    expect(host.textContent).not.toContain('无需变更摘要');
    expect(
      [...host.querySelectorAll<HTMLButtonElement>('button[aria-label^="查看"]')].some((item) =>
        item.getAttribute('aria-label')?.includes('生成中会话'),
      ),
    ).toBe(false);
    await vi.waitFor(() =>
      expect(router.state.location.search).toMatchObject({ stage: 'pending' }),
    );
    expect(router.state.location.search).not.toHaveProperty('create');

    await chooseOption('按处理状态筛选', '生成中', host);
    expect(
      [...host.querySelectorAll<HTMLButtonElement>('button[aria-label^="查看"]')].some((item) =>
        item.getAttribute('aria-label')?.includes('生成中会话'),
      ),
    ).toBe(true);
    expect(host.textContent).not.toContain('待审核摘要');
  });

  it('create=true 自动打开新建流程，关闭后从 URL 移除', async () => {
    const router = await mount('/personal/reviews?create=true');
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('新建记忆提案'),
    );
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    await click(button('取消', dialog));
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    await vi.waitFor(() => expect(router.state.location.search).not.toHaveProperty('create'));
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

  it('创建按来源、目标、摘要三步展开，提交幂等键并在生成前确认预算与超时', async () => {
    await mount();
    await vi.waitFor(() => expect(host.textContent).toContain('生成记忆提案'));
    const dialog = await openCreate();
    await vi.waitFor(() => expect(dialog.textContent).toContain('会话一'));
    expect(dialog.textContent).toContain('来源专家');

    const checkbox = firstConversationCheckbox();
    await click(checkbox);
    await click(button('下一步', dialog));

    // 第 2 步才出现目标与执行专家，执行者与来源专家分开展示。
    expect(dialog.textContent).toContain('写入目标');
    expect(dialog.textContent).toContain('执行专家');
    await fill('memory-review-instruction', '只整理长期偏好');
    expect(dialog.textContent).toContain('单次预算上限 $2');
    expect(dialog.textContent).toContain('超时 10 分钟');
    await click(button('下一步', dialog));

    // 摘要确认列出三类角色与可选要求。
    expect(dialog.textContent).toContain('确认生成');
    expect(dialog.textContent).toContain('来源专家');
    expect(dialog.textContent).toContain('专家甲');
    expect(dialog.textContent).toContain('个人记忆');
    expect(dialog.textContent).toContain('执行专家');
    expect(dialog.textContent).toContain('只整理长期偏好');

    await click(button('生成提案', dialog));

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

  it('第 2 步按真实默认激活点下一步只进入确认页，不发起生成，最后一步才提交一次', async () => {
    await mount();
    const dialog = await openCreate();
    await vi.waitFor(() => expect(dialog.textContent).toContain('会话一'));
    await click(firstConversationCheckbox());

    // 第 1 步的隐式提交（Enter）也只推进，不生成。
    await act(async () => {
      dialog
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(dialog.textContent).toContain('写入目标');
    expect(api.createMemoryReview).not.toHaveBeenCalled();

    // 第 2 步的推进按钮会和第 3 步提交按钮落在同一位置；浏览器默认激活必须被拦住。
    await clickNative(button('下一步', dialog));
    expect(dialog.textContent).toContain('确认生成');
    expect(dialog.textContent).toContain('来源专家');
    expect(dialog.textContent).toContain('写入目标');
    expect(api.createMemoryReview).not.toHaveBeenCalled();

    await click(button('生成提案', dialog));
    await vi.waitFor(() => expect(api.createMemoryReview).toHaveBeenCalledTimes(1));
  });

  it('直接打开新建弹层先等专家数据，来源专家选中值与下方会话一致', async () => {
    let releaseAgents: (() => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (String(input) === '/api/agents') {
          return new Promise<Response>((resolve) => {
            releaseAgents = () =>
              resolve(
                new Response(JSON.stringify([agentA, agentB]), {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                }),
              );
          });
        }
        return Promise.reject(new Error(`Unexpected fetch: ${String(input)}`));
      }),
    );
    // agentsQuery 直接引用模块加载时的 api.agents，这里用挂起的 fetch 模拟目录尚未返回。
    client.removeQueries({ queryKey: ['agents'] });
    await mount('/personal/reviews?create=true');
    // 专家目录未就绪时不挂载弹层，避免用空数组把来源专家初始化成空值。
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await vi.waitFor(() => expect(releaseAgents).toBeDefined());

    await act(async () => releaseAgents?.());
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeTruthy());
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    await vi.waitFor(() => expect(dialog.textContent).toContain('会话一'));

    const sourceSelect = dialog.querySelector('[data-slot="select-trigger"]');
    expect(sourceSelect?.textContent).toContain('专家甲');
  });

  it('createMemoryReview 把 Idempotency-Key 放进请求头并声明本人来源', async () => {
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
    await expect(api.createMemoryReview(input, key, 'own')).resolves.toEqual({
      runId: 'run-1',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/memory-reviews?scope=own',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
      }),
    );
  });

  it('详情先展示写入目标与完整变化，再展示理由、证据与来源', async () => {
    vi.mocked(api.memoryReviews).mockResolvedValue({
      items: [
        makeReview({
          runId: 'run-order',
          target: { kind: 'agent_memory', agentId: 'agent-a', name: 'topic.md' },
          before: { content: '旧正文', globs: null, index: { content: '# 旧索引\n' } },
          proposal: {
            summary: '补充主题经验',
            proposedContent: '新正文',
            evidence: [{ messageId: 'msg-1', quote: '以后都用中文回答', kind: 'user_fact' }],
          },
        }),
      ],
    });
    await mount();
    const dialog = await openFirstDetail();
    expect(dialog.textContent).toContain('记忆提案');
    const order = ['写入目标', '修改前内容', '提案内容', '索引', '理由', '证据', '来源'].map(
      (label) => dialog.textContent?.indexOf(label) ?? -1,
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  it('采纳专家目标后提供目标专家现有详情入口', async () => {
    vi.mocked(api.memoryReviews).mockResolvedValue({
      items: [
        makeReview({
          runId: 'run-target-link',
          target: { kind: 'agent_memory', agentId: 'agent-a', name: 'topic.md' },
          decision: 'applied',
          appliedChangeId: 'chg_1',
        }),
      ],
    });
    await mount();
    const dialog = await openFirstDetail();
    await vi.waitFor(() => expect(dialog.textContent).toContain('提案已采用'));
    const targetLink = dialog.querySelector<HTMLAnchorElement>('a[href^="/agents/agent-a"]');
    expect(targetLink?.textContent).toContain('查看专家记忆');
    expect(targetLink?.getAttribute('href')).toContain('tab=memory');
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
    expect(dialog.textContent).toContain('修改前内容');
    expect(dialog.textContent).toContain('旧内容');
    expect(dialog.textContent).toContain('新内容');

    await click(dialogButton('采用'));
    expect(api.applyMemoryReview).toHaveBeenCalledWith('run-apply');
    await vi.waitFor(() => expect(dialog.textContent).toContain('提案已采用'));
    expect(dialog.textContent).toContain('采用前内容');
    expect(dialog.textContent).not.toContain('当前内容');
    expect(dialog.textContent).toContain('回滚');
    const targetLink = dialog.querySelector<HTMLAnchorElement>('a[href="/personal/memory"]');
    expect(targetLink?.textContent).toContain('查看个人记忆');
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
    await vi.waitFor(() => expect(dialog.textContent).toContain('提案已拒绝'));
    expect(dialog.textContent).toContain('目标内容未更改');
    // 拒绝没有写入目标，链接文案说明看的是当前内容而不是本次提案。
    expect(dialog.textContent).toContain('查看当前个人记忆');
    expect(dialog.textContent).not.toContain('查看个人记忆');
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
    expect(dialog.textContent).toContain('当前内容');
    await click(dialogButton('重新生成'));

    expect(api.createMemoryReview).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('新建记忆提案'),
    );
    const createDialog = document.querySelector('[role="dialog"]') as HTMLElement;
    await vi.waitFor(() => expect(createDialog.textContent).toContain('会话一'));
    await click(button('下一步', createDialog));
    const instruction = document.getElementById('memory-review-instruction');
    expect(instruction).toBeInstanceOf(HTMLTextAreaElement);
    expect((instruction as HTMLTextAreaElement).value).toBe('');

    await fill('memory-review-instruction', '只保留长期结论');
    await click(button('下一步', createDialog));
    expect(createDialog.textContent).toContain('单次预算上限 $2');
    expect(createDialog.textContent).toContain('超时 10 分钟');
    await click(button('生成提案', createDialog));
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
    const dialog = await openCreate();
    await vi.waitFor(() => expect(dialog.textContent).toContain('会话一'));
    await click(firstConversationCheckbox());
    await click(button('下一步', dialog));
    await fill('memory-review-instruction', '保留长期偏好');
    await click(button('下一步', dialog));

    await click(button('生成提案', dialog));
    await vi.waitFor(() => expect(api.createMemoryReview).toHaveBeenCalledTimes(1));
    await click(button('生成提案', dialog));
    await vi.waitFor(() => expect(api.createMemoryReview).toHaveBeenCalledTimes(2));
    const firstKey = vi.mocked(api.createMemoryReview).mock.calls[0]?.[1];
    const retryKey = vi.mocked(api.createMemoryReview).mock.calls[1]?.[1];
    expect(firstKey).toBeTruthy();
    expect(retryKey).toBe(firstKey);

    await click(button('上一步', dialog));
    await fill('memory-review-instruction', '保留长期偏好和格式');
    await click(button('下一步', dialog));
    await click(button('生成提案', dialog));
    await vi.waitFor(() => expect(api.createMemoryReview).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.createMemoryReview).mock.calls[2]?.[1]).not.toBe(firstKey);
  });

  it('生成记忆提案的取消、Esc、外部点击与关闭按钮共用放弃确认', async () => {
    await mount();
    const createDialog = await openCreate();
    await click(firstConversationCheckbox());

    const findCreateDialog = () =>
      allDialogs().find((item) => item.textContent?.includes('新建记忆提案')) ?? null;

    // 取消按钮
    await click(button('取消', createDialog));
    expect(discardDialog()).toBeTruthy();
    await click(button('取消', discardDialog() as HTMLElement));
    expect(findCreateDialog()).toBeTruthy();

    // 关闭按钮
    await click(button('关闭', findCreateDialog() as HTMLElement));
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
    expect(findCreateDialog()).toBeNull();
    expect(new URLSearchParams(window.location.search).get('create')).toBeNull();
  });

  it('新建入口写入 URL，浏览器返回时确认放弃草稿，取消保留草稿', async () => {
    await mount('/personal/reviews', { browser: true, stack: ['/personal/memory'] });
    const dialog = await openCreate();
    await click(firstConversationCheckbox());
    await click(button('下一步', dialog));
    await fill('memory-review-instruction', '只整理长期偏好');
    expect(new URLSearchParams(window.location.search).get('create')).toBe('true');

    await browserBack();
    await vi.waitFor(() => expect(discardDialog()).toBeTruthy());
    expect(document.body.textContent).not.toContain('放弃未保存的个人记忆？');

    await click(button('取消', discardDialog() as HTMLElement));
    await vi.waitFor(() =>
      expect(new URLSearchParams(window.location.search).get('create')).toBe('true'),
    );
    const kept = document.getElementById('memory-review-instruction');
    expect(kept).toBeInstanceOf(HTMLTextAreaElement);
    expect((kept as HTMLTextAreaElement).value).toBe('只整理长期偏好');

    await browserBack();
    await vi.waitFor(() => expect(discardDialog()).toBeTruthy());
    await click(button('放弃并离开', discardDialog() as HTMLElement));
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    await vi.waitFor(() =>
      expect(new URLSearchParams(window.location.search).get('create')).toBeNull(),
    );

    await browserBack();
    await vi.waitFor(() => expect(window.location.pathname).toBe('/personal/memory'));
    await vi.waitFor(() => expect(host.textContent).toContain('每轮对话会带入这些长期信息。'));
  });

  it('生成记忆提案草稿阻止切回个人记忆，确认后仅继续该次导航', async () => {
    const router = await mount('/personal/reviews', {
      browser: true,
      stack: ['/personal/memory'],
    });
    const dialog = await openCreate();
    await click(firstConversationCheckbox());
    await click(button('下一步', dialog));
    await fill('memory-review-instruction', '草稿');

    await act(async () => {
      void router.navigate({ to: '/personal/memory' });
    });
    await vi.waitFor(() => expect(discardDialog()).toBeTruthy());
    await click(button('取消', discardDialog() as HTMLElement));
    await flush();
    expect(new URLSearchParams(window.location.search).get('create')).toBe('true');
    expect(document.getElementById('memory-review-instruction')).toBeTruthy();

    await act(async () => {
      void router.navigate({ to: '/personal/memory' });
    });
    await vi.waitFor(() => expect(discardDialog()).toBeTruthy());
    await click(button('放弃并离开', discardDialog() as HTMLElement));
    await vi.waitFor(() => expect(window.location.pathname).toBe('/personal/memory'));
    await vi.waitFor(() => expect(host.textContent).toContain('每轮对话会带入这些长期信息。'));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('生成记忆提案提交中禁止离开，刷新前有离开保护', async () => {
    let resolve!: (value: { runId: string }) => void;
    vi.mocked(api.createMemoryReview).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await mount('/personal/reviews', { browser: true, stack: ['/personal/memory'] });
    const createDialog = await openCreate();
    await click(firstConversationCheckbox());
    await click(button('下一步', createDialog));
    await fill('memory-review-instruction', '草稿');
    await click(button('下一步', createDialog));
    await click(button('生成提案', createDialog));
    await vi.waitFor(() => expect(api.createMemoryReview).toHaveBeenCalledTimes(1));

    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    await browserBack();
    await vi.waitFor(() => expect(discardDialog()).toBeTruthy());
    expect(button('放弃并离开', discardDialog() as HTMLElement).disabled).toBe(true);
    await click(button('取消', discardDialog() as HTMLElement));
    await vi.waitFor(() =>
      expect(new URLSearchParams(window.location.search).get('create')).toBe('true'),
    );
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('第 3 / 3 步');

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
    const router = await mount('/personal/reviews', { browser: true, stack: ['/personal/memory'] });
    const createDialog = await openCreate();
    await click(firstConversationCheckbox());
    await click(button('下一步', createDialog));
    await click(button('下一步', createDialog));
    await click(button('生成提案', createDialog));
    await vi.waitFor(() => expect(api.createMemoryReview).toHaveBeenCalledTimes(1));

    await browserBack();
    await vi.waitFor(() => expect(discardDialog()).toBeTruthy());
    // 浏览器已回退地址栏，但路由仍停在被拦下的 create=true；成功关闭时两者要对齐。
    expect(router.state.location.search).toMatchObject({ create: true });

    // 不操作放弃确认而请求成功时，关闭表单不能把地址栏留在被拦下的上一页。
    await act(async () => resolve({ runId: 'run-new' }));
    await vi.waitFor(() => expect(discardDialog()).toBeNull());
    await vi.waitFor(() => expect(window.location.pathname).toBe('/personal/reviews'));
    expect(router.state.location.pathname).toBe('/personal/reviews');
    expect(router.state.location.search).toEqual({});
    expect(window.location.pathname + window.location.search).toBe(router.state.location.pathname);
    expect(host.textContent).toContain('让模型整理值得保存的记忆');
    expect(host.textContent).not.toContain('个人记忆内容（Markdown）');
  });

  it('生成记忆提案提交中禁止关闭', async () => {
    let resolve!: (value: { runId: string }) => void;
    vi.mocked(api.createMemoryReview).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await mount();
    const dialog = await openCreate();
    await click(firstConversationCheckbox());
    await click(button('下一步', dialog));
    await click(button('下一步', dialog));
    await click(button('生成提案', dialog));

    await pressEscape();
    await pressOutside();
    expect(allDialogs().find((item) => item.textContent?.includes('新建记忆提案'))).toBeTruthy();
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

  it('在途操作时来源会话链接不离开，结算后正常导航到结构化会话地址', async () => {
    vi.mocked(api.memoryReviews).mockResolvedValue({
      items: [makeReview({ runId: 'run-pending' })],
    });
    let resolve!: (value: MemoryChange) => void;
    vi.mocked(api.applyMemoryReview).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const router = await mount();
    await openFirstDetail();
    await click(dialogButton('采用'));

    const sourceLink = () =>
      document.querySelector<HTMLAnchorElement>('[role="dialog"] a[href*="conversation=conv-1"]');
    expect(sourceLink()?.getAttribute('aria-disabled')).toBe('true');
    await act(async () => sourceLink()?.click());
    await flush();
    expect(router.state.location.pathname).toBe('/personal/reviews');

    await act(async () => resolve(change));
    await flush();
    await vi.waitFor(() => expect(sourceLink()?.getAttribute('aria-disabled')).toBeNull());
    await act(async () => sourceLink()?.click());
    await flush();
    expect(router.state.location.pathname).toBe('/chat');
    expect(router.state.location.search).toEqual({ conversation: 'conv-1' });
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
              before: { content: '新内容', globs: null, index: null },
              after: { content: '旧内容', globs: null, index: null },
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
        before: { content: '新内容', globs: null, index: null },
        after: { content: '旧内容', globs: null, index: null },
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
          before: { content: 'x', globs: null, index: null },
          after: { content: 'y', globs: null, index: null },
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
    expect(names.every((name) => name?.includes('提案'))).toBe(true);
  });

  it('新规则 slug 复用规则格式校验并关联字段错误', async () => {
    await mount();
    const dialog = await openCreateOnTargetStep();
    await chooseOption('目标', '专家规则', dialog);
    await vi.waitFor(() => expect(document.getElementById('memory-review-rule-slug')).toBeTruthy());

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
    const dialog = await openCreate();

    await click(button('下一步', dialog));
    await vi.waitFor(() => expect(dialog.textContent).toContain('至少选择一段来源会话。'));
    const sourceBox = dialog.querySelector<HTMLElement>(
      '[aria-describedby="memory-review-sources-error"]',
    );
    expect(sourceBox?.getAttribute('aria-invalid')).toBe('true');
    await vi.waitFor(() => expect(document.activeElement).toBe(sourceBox));

    await click(firstConversationCheckbox());
    await click(button('下一步', dialog));
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

  it('专家记忆可选 MEMORY.md、已有主题或新主题，并把文件名提交为 target.name', async () => {
    await mount();
    const dialog = await openCreateOnTargetStep();
    await chooseOption('目标', '专家记忆', dialog);
    await chooseOption('记忆文件', 'topic.md', dialog);
    await click(button('下一步', dialog));
    await click(button('生成提案', dialog));

    await vi.waitFor(() => expect(api.createMemoryReview).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.createMemoryReview).mock.calls[0]?.[0].target).toEqual({
      kind: 'agent_memory',
      agentId: 'agent-a',
      name: 'topic.md',
    });
  });

  it('新主题文件名复用 shared 校验并自动补 .md', async () => {
    await mount();
    const dialog = await openCreateOnTargetStep();
    await chooseOption('目标', '专家记忆', dialog);
    await chooseOption('记忆文件', '新主题…', dialog);

    await fill('memory-review-new-file', 'Bad Name');
    await click(button('下一步', dialog));
    await vi.waitFor(() => expect(dialog.textContent).toContain('记忆文件名非法'));
    expect(document.getElementById('memory-review-new-file')?.getAttribute('aria-invalid')).toBe(
      'true',
    );
    expect(api.createMemoryReview).not.toHaveBeenCalled();

    await fill('memory-review-new-file', 'deploy-notes');
    expect(dialog.textContent).not.toContain('记忆文件名非法');
    await click(button('下一步', dialog));
    await click(button('生成提案', dialog));
    await vi.waitFor(() => expect(api.createMemoryReview).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.createMemoryReview).mock.calls[0]?.[0].target).toEqual({
      kind: 'agent_memory',
      agentId: 'agent-a',
      name: 'deploy-notes.md',
    });
  });

  it('来源专家、目标专家与执行专家互不耦合，摘要让用户确认', async () => {
    await mount();
    const dialog = await openCreateOnTargetStep();
    await chooseOption('目标', '专家记忆', dialog);
    await chooseOption('目标专家', '专家乙', dialog);
    await vi.waitFor(() =>
      expect(document.getElementById('memory-review-memory-file')?.textContent).toContain(
        'MEMORY.md',
      ),
    );
    await click(button('下一步', dialog));

    // 切换目标专家不会静默丢掉来源；三类角色在摘要里分别展示。
    expect(dialog.textContent).toContain('来源专家');
    expect(dialog.textContent).toContain('会话一');
    expect(dialog.textContent).toContain('写入目标');
    expect(dialog.textContent).toContain('专家乙 / MEMORY.md');
    expect(dialog.textContent).toContain('执行专家');
    expect(dialog.textContent).toContain('专家甲');

    await click(button('生成提案', dialog));
    await vi.waitFor(() => expect(api.createMemoryReview).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.createMemoryReview).mock.calls[0]?.[0]).toMatchObject({
      modelAgentId: 'agent-a',
      target: { kind: 'agent_memory', agentId: 'agent-b', name: 'MEMORY.md' },
      sources: [{ conversationId: 'conv-1' }],
    });
  });

  it('重新生成保留原目标文件名', async () => {
    vi.mocked(api.memoryReviews).mockResolvedValue({
      items: [
        makeReview({
          runId: 'run-theme',
          target: { kind: 'agent_memory', agentId: 'agent-b', name: 'topic.md' },
        }),
      ],
    });
    await mount();
    const detail = await openFirstDetail();
    await click(dialogButton('重新生成'));
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('新建记忆提案'),
    );
    const createDialog = document.querySelector('[role="dialog"]') as HTMLElement;
    await vi.waitFor(() => expect(createDialog.textContent).toContain('会话一'));
    await click(button('下一步', createDialog));
    await vi.waitFor(() =>
      expect(document.getElementById('memory-review-memory-file')?.textContent).toContain(
        'topic.md',
      ),
    );
    await click(button('下一步', createDialog));
    await click(button('生成提案', createDialog));
    await vi.waitFor(() => expect(api.createMemoryReview).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.createMemoryReview).mock.calls[0]?.[0].target).toEqual({
      kind: 'agent_memory',
      agentId: 'agent-b',
      name: 'topic.md',
    });
    expect(detail).toBeTruthy();
  });

  it('主题详情显示正文与索引前后对比、来源会话链接和证据归因', async () => {
    vi.mocked(api.memoryReviews).mockResolvedValue({
      items: [
        makeReview({
          runId: 'run-index',
          target: { kind: 'agent_memory', agentId: 'agent-a', name: 'topic.md' },
          before: { content: '旧正文', globs: null, index: { content: '# 索引\n' } },
          proposal: {
            summary: '补充主题经验',
            proposedContent: '新正文',
            evidence: [
              { messageId: 'msg-1', quote: '以后都用中文回答', kind: 'confirmed_decision' },
              { messageId: 'msg-2', quote: '可以试试分主题整理', kind: 'assistant_suggestion' },
            ],
          },
        }),
      ],
    });
    await mount();
    const dialog = await openFirstDetail();
    expect(dialog.textContent).toContain('旧正文');
    expect(dialog.textContent).toContain('新正文');
    expect(dialog.textContent).toContain('索引');
    expect(dialog.textContent).toContain('- [topic.md](topic.md)');
    expect(dialog.textContent).toContain('已确认决定');
    expect(dialog.textContent).toContain('助手建议');
    expect(dialog.querySelector('a[href="/chat?conversation=conv-1"]')).toBeTruthy();
  });

  it('内容与索引都无变化时显示无需变更且不提供采用或拒绝', async () => {
    vi.mocked(api.memoryReviews).mockResolvedValue({
      items: [
        makeReview({
          runId: 'run-nochange',
          target: { kind: 'agent_memory', agentId: 'agent-a', name: 'topic.md' },
          before: {
            content: '同正文',
            globs: null,
            index: { content: '- [topic.md](topic.md)\n' },
          },
          proposal: { summary: '无需修改', proposedContent: '同正文', evidence: [] },
        }),
      ],
    });
    await mount();
    await vi.waitFor(() => expect(host.textContent).toContain('无需变更'));
    const dialog = await openFirstDetail();
    expect(dialog.textContent).toContain('无需变更');
    // 无变化时只展示一次当前内容，不渲染左右对比或空代码框。
    expect(dialog.textContent).toContain('当前内容');
    expect(dialog.textContent).not.toContain('修改前内容');
    expect(dialog.textContent).not.toContain('提案内容');
    expect(dialog.querySelector('section[aria-label="内容对比"]')).toBeNull();
    expect(dialog.querySelectorAll('[aria-label="代码内容"]')).toHaveLength(1);
    expect(buttonOrNull('采用', dialog)).toBeUndefined();
    expect(buttonOrNull('不采用', dialog)).toBeUndefined();
    expect(buttonOrNull('重新生成', dialog)).toBeTruthy();
  });

  it('采纳后主题与索引正文缓存一起失效', async () => {
    vi.mocked(api.memoryReviews).mockResolvedValue({
      items: [
        makeReview({
          runId: 'run-cache',
          target: { kind: 'agent_memory', agentId: 'agent-a', name: 'topic.md' },
        }),
      ],
    });
    await mount();
    client.setQueryData(['agent-memory-file', 'agent-a', 'topic.md'], {
      name: 'topic.md',
      content: '旧正文',
      updatedAt: null,
    });
    client.setQueryData(['agent-memory-file', 'agent-a', 'MEMORY.md'], {
      name: 'MEMORY.md',
      content: '# 索引',
      updatedAt: null,
    });
    await openFirstDetail();
    await click(dialogButton('采用'));
    await vi.waitFor(() => expect(api.applyMemoryReview).toHaveBeenCalledWith('run-cache'));
    await vi.waitFor(() => {
      expect(
        client.getQueryState(['agent-memory-file', 'agent-a', 'topic.md'])?.isInvalidated,
      ).toBe(true);
      expect(
        client.getQueryState(['agent-memory-file', 'agent-a', 'MEMORY.md'])?.isInvalidated,
      ).toBe(true);
    });
  });

  it('采纳在途时阻止来源链接与浏览器后退，结算后恢复导航', async () => {
    vi.mocked(api.memoryReviews).mockResolvedValue({
      items: [makeReview({ runId: 'run-hang' })],
    });
    let resolve!: (value: MemoryChange) => void;
    vi.mocked(api.applyMemoryReview).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await mount('/personal/reviews', { browser: true, stack: ['/personal/memory'] });
    const dialog = await openFirstDetail();
    const source = dialog.querySelector<HTMLAnchorElement>('a[href^="/chat?"]');
    if (!source) throw new Error('Missing source link');
    await click(dialogButton('采用'));

    expect(source.getAttribute('aria-disabled')).toBe('true');
    const sourceClick = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    await act(async () => source.dispatchEvent(sourceClick));
    expect(sourceClick.defaultPrevented).toBe(true);
    expect(new URLSearchParams(window.location.search).get('run')).toBe('run-hang');

    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    await browserBack();
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();

    await act(async () => resolve(change));
    await flush();
    await vi.waitFor(() =>
      expect(new URLSearchParams(window.location.search).get('run')).toBe('run-hang'),
    );
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    expect(source.getAttribute('aria-disabled')).toBeNull();
  });

  it('记忆文件列表加载失败时显示可重试错误，不伪装成没有主题', async () => {
    vi.mocked(api.agentMemory)
      .mockRejectedValueOnce(new Error('记忆文件加载失败'))
      .mockResolvedValue({
        files: [
          { name: 'MEMORY.md', size: 10, updatedAt: '2026-10-01T00:00:00.000Z' },
          { name: 'topic.md', size: 20, updatedAt: '2026-10-01T00:00:00.000Z' },
        ],
        initialized: true,
      });
    await mount();
    const dialog = await openCreateOnTargetStep();
    await chooseOption('目标', '专家记忆', dialog);
    await vi.waitFor(() => expect(dialog.textContent).toContain('记忆文件加载失败'));

    await click(button('重试', dialog));
    await vi.waitFor(() => expect(dialog.textContent).not.toContain('记忆文件加载失败'));
    await chooseOption('记忆文件', 'topic.md', dialog);
  });

  it('个人审核权限不会读取或操作无权限的专家目标', async () => {
    const me = meWith([
      'personal_memory.read',
      'personal_memory.write',
      'personal_memory.review',
      'agents.read',
      'agents.use',
      'conversations.read',
    ]);
    client.setQueryData(['me'], me);
    vi.mocked(api.me).mockResolvedValue(me);
    vi.mocked(api.memoryReviews).mockResolvedValue({
      items: [
        makeReview({
          runId: 'run-agent-memory',
          target: { kind: 'agent_memory', agentId: 'agent-a', name: 'topic.md' },
        }),
        makeReview({
          runId: 'run-agent-rule',
          target: { kind: 'agent_rule', agentId: 'agent-a', slug: 'no-console' },
          decision: 'applied',
          appliedChangeId: 'chg_1',
        }),
      ],
    });
    await mount();
    await vi.waitFor(() => expect(host.textContent).toContain('专家甲 / no-console'));

    expect(api.agentMemory).not.toHaveBeenCalled();
    expect(api.agentRules).not.toHaveBeenCalled();
    expect(api.agentMemoryVersions).not.toHaveBeenCalled();
    expect(api.agentRuleVersions).not.toHaveBeenCalled();

    await click(button('生成记忆提案'));
    const createDialog = await vi.waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeTruthy();
      return document.querySelector('[role="dialog"]') as HTMLElement;
    });
    await click(firstConversationCheckbox());
    await click(button('下一步', createDialog));
    await click(button('目标', createDialog));
    const targetOptions = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(
      (option) => option.textContent?.trim(),
    );
    expect(targetOptions).toContain('个人记忆');
    expect(targetOptions).not.toContain('专家记忆');
    expect(targetOptions).not.toContain('专家规则');
    const personalOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.trim() === '个人记忆',
    );
    if (!personalOption) throw new Error('Missing personal target option');
    await click(personalOption);
    await click(button('取消', createDialog));
    await click(button('放弃并关闭', discardDialog() as HTMLElement));
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(api.agentMemory).not.toHaveBeenCalled();
    expect(api.agentRules).not.toHaveBeenCalled();

    const detail = await openFirstDetail();
    expect(buttonOrNull('采用', detail)).toBeUndefined();
    expect(buttonOrNull('不采用', detail)).toBeUndefined();
    expect(buttonOrNull('重新生成', detail)).toBeUndefined();
    await click(dialogButton('关闭详情'));

    const views = [...host.querySelectorAll<HTMLButtonElement>('button')].filter((item) =>
      item.getAttribute('aria-label')?.startsWith('查看'),
    );
    const ruleView = views[1];
    if (!ruleView) throw new Error('Missing rule review view button');
    await click(ruleView);
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeTruthy());
    const ruleDialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(buttonOrNull('回滚', ruleDialog)).toBeUndefined();
  });

  it('缺少专家使用权限时不提供生成记忆提案', async () => {
    const me = meWith([
      'personal_memory.read',
      'personal_memory.review',
      'agents.read',
      'conversations.read',
    ]);
    client.setQueryData(['me'], me);
    vi.mocked(api.me).mockResolvedValue(me);
    await mount();
    await vi.waitFor(() => expect(host.textContent).toContain('生成记忆提案'));
    const create = button('生成记忆提案');
    expect(create.disabled).toBe(true);
    expect(create.title).toContain('专家使用权限');
  });

  it('列表外的运行中回顾详情每 3 秒刷新，成功进入终态后停止', async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.spyOn(api, 'memoryReview').mockImplementation(async (runId) => {
      calls += 1;
      return calls === 1
        ? makeReview({ runId, status: 'running', proposal: null })
        : makeReview({ runId, status: 'succeeded' });
    });
    const local = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    const observer = new QueryObserver(local, memoryReviewQuery('run-poll'));
    const unsubscribe = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    expect(observer.getCurrentResult().data?.status).toBe('running');

    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toBe(2);
    expect(observer.getCurrentResult().data?.status).toBe('succeeded');

    await vi.advanceTimersByTimeAsync(9_000);
    expect(calls).toBe(2);
    unsubscribe();
    local.clear();
    vi.useRealTimers();
  });
});
