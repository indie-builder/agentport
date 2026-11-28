import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { settle } from '@ui-sdk/core/testing';
import type { AgentComponent } from '@ui-sdk/react/agent';
import { HttpResponse, http } from 'msw';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UiAgentHost } from '../src/components/ui-agent-host.js';
import { useChatStore } from '../src/lib/chat-store.js';
import { queryClient } from '../src/lib/queries.js';
import { setUiAgentConfirmHandler, uiAgent } from '../src/lib/ui-agent.js';
import { routeTree } from '../src/routeTree.gen.js';
import { allAccessMe } from './me-fixture.js';
import { createMsw, runCleanup } from './msw.js';

vi.mock('../src/lib/toast.js', () => {
  const toast = Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    promise: vi.fn(),
  });
  return {
    toast,
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
    toastPromise: vi.fn((promise: unknown) =>
      Promise.resolve(typeof promise === 'function' ? (promise as () => unknown)() : promise),
    ),
  };
});

const ISO_T1 = '2026-11-20T08:00:00.000Z';
const ISO_T2 = '2026-11-25T10:30:00.000Z';
const ISO_T3 = '2026-11-27T12:00:00.000Z';
const ISO_FUTURE = '2026-12-01T09:00:00.000Z';

const msw = createMsw();
const { server, calls } = msw;

let host: HTMLDivElement | undefined;
let root: Root | undefined;
let activeHistory: ReturnType<typeof createMemoryHistory> | undefined;

const defaultAgentSummary = {
  id: 'agt_default',
  name: '通用助手',
  description: '默认通用助手',
  enabled: true,
  isDefault: true,
  createdBy: 'test-admin',
  ownerBusinessId: 'test-admin',
  role: '通用助手',
  slug: 'general',
  parentId: null,
  createdAt: ISO_T1,
  uiFormat: 'markdown' as const,
  serverIds: [],
  skillIds: [],
  model: 'claude-sonnet-5-5',
  maxBudgetUsd: 2,
  timeoutMs: 600_000,
  visibility: 'organization' as const,
  tags: [],
  archivedAt: null,
  deletedAt: null,
  isFavorite: false,
  lastUsedAt: null,
};

const analystAgentSummary = {
  id: 'agt_analyst',
  name: '数据分析师小智',
  description: '负责业务指标拆解与异常归因',
  enabled: true,
  isDefault: false,
  createdBy: 'test-admin',
  ownerBusinessId: 'test-admin',
  role: '数据分析师',
  slug: 'data-analyst',
  parentId: null,
  createdAt: ISO_T1,
  uiFormat: 'markdown' as const,
  serverIds: ['srv_gen'],
  skillIds: ['skl_1'],
  model: 'claude-sonnet-5-5',
  maxBudgetUsd: 2,
  timeoutMs: 600_000,
  visibility: 'private' as const,
  tags: ['分析'],
  archivedAt: null,
  deletedAt: null,
  isFavorite: true,
  lastUsedAt: ISO_T2,
};

const opsAgentSummary = {
  id: 'agt_ops',
  name: '值班运维助手',
  description: '排查线上告警与日志异常',
  enabled: true,
  isDefault: false,
  createdBy: 'test-admin',
  ownerBusinessId: 'test-admin',
  role: '运维工程师',
  slug: 'ops-helper',
  parentId: null,
  createdAt: ISO_T2,
  uiFormat: 'markdown' as const,
  serverIds: [],
  skillIds: [],
  model: 'claude-sonnet-5-5',
  maxBudgetUsd: 2,
  timeoutMs: 600_000,
  visibility: 'organization' as const,
  tags: ['运维'],
  archivedAt: null,
  deletedAt: null,
  isFavorite: false,
  lastUsedAt: null,
};

const analystAgentDetail = {
  id: 'agt_analyst',
  slug: 'data-analyst',
  name: '数据分析师小智',
  role: '数据分析师',
  description: '负责业务指标拆解与异常归因',
  model: 'claude-sonnet-5-5',
  systemPrompt: '请基于指标给出结论。',
  serverIds: ['srv_gen'],
  skillIds: ['skl_1'],
  pluginBindings: [],
  subAgentIds: [],
  runtimeEnvironmentId: null,
  allowedTools: [],
  disallowedTools: [],
  permissionMode: 'default' as const,
  uiFormat: 'markdown' as const,
  maxTurns: 20,
  maxBudgetUsd: 2,
  monthlyBudgetUsd: null,
  budgetAlertRatio: 0.8,
  timeoutMs: 600_000,
  enabled: true,
  visibility: 'private' as const,
  tags: ['分析'],
  createdBy: 'test-admin',
  ownerBusinessId: 'test-admin',
  parentId: null,
  isDefault: false,
  publishedVersion: 1,
  publishedAt: ISO_T1,
  hasDraft: true,
  archivedAt: null,
  deletedAt: null,
  createdAt: ISO_T1,
  updatedAt: ISO_T2,
};

function installMatchMedia(matches = true) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

beforeAll(() => {
  msw.listen();
});

afterAll(() => {
  msw.close();
});

beforeEach(() => {
  msw.reset();
  useChatStore.getState().reset();
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  installMatchMedia(true);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  server.use(
    http.get('/api/auth/me', () => HttpResponse.json(allAccessMe)),
    http.get('/api/notifications/unread-count', () => HttpResponse.json({ unreadCount: 2 })),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  const mountedRoot = root;
  const mountedHost = host;
  const history = activeHistory;
  root = undefined;
  host = undefined;
  activeHistory = undefined;
  await runCleanup([
    () => {
      setUiAgentConfirmHandler(null);
    },
    () => mountedRoot && act(async () => mountedRoot.unmount()),
    () => history?.destroy(),
    () => mountedHost?.remove(),
    () => {
      useChatStore.getState().reset();
      queryClient.clear();
    },
    () => msw.waitForRequests(),
    () => vi.restoreAllMocks(),
    () => msw.assertClean(),
  ]);
});

async function flushUi() {
  await act(async () => {
    await settle();
  });
}

async function mountRoute(initialEntry: string) {
  if (!root) throw new Error('Missing root');
  activeHistory = createMemoryHistory({ initialEntries: [initialEntry] });
  const router = createRouter({ routeTree, history: activeHistory });
  await act(async () => {
    await router.load();
    root?.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RouterProvider, { router }),
        createElement(UiAgentHost),
      ),
    );
  });
  await flushUi();
  return router;
}

async function waitForPageReady(predicate: () => boolean, description: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await msw.waitForRequests();
    await flushUi();
    if (predicate()) {
      return;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
  }
  throw new Error(`Timed out waiting for page ready: ${description}`);
}

function visibleControls(snapshot = uiAgent.snapshot()): AgentComponent[] {
  return snapshot.filter(
    (entry) => !entry.offPage && !('more' in entry) && entry.component !== 'closed',
  );
}

function assertAllVisibleControlsNamed(controls: AgentComponent[]) {
  expect(controls.length).toBeGreaterThan(0);
  const unnamed = controls.filter((entry) => {
    const hasLabel = typeof entry.label === 'string' && entry.label.trim().length > 0;
    const isSharedMultiTriggerMenu =
      entry.component === 'menu' &&
      Array.isArray(entry.buttons) &&
      entry.buttons.length > 1 &&
      entry.buttons.every((button) => typeof button === 'string' && button.trim().length > 0);
    return !hasLabel && !isSharedMultiTriggerMenu;
  });
  expect(unnamed).toEqual([]);
}

function findHostAlertDialog(): HTMLElement {
  const dialogs = Array.from(document.body.querySelectorAll<HTMLElement>('[role="alertdialog"]'));
  const dialog = dialogs.find((item) => item.textContent?.includes('确认智能体操作'));
  if (!dialog) throw new Error('Missing UiAgentHost alertdialog');
  return dialog;
}

function hasHostAlertDialog(): boolean {
  return Array.from(document.body.querySelectorAll<HTMLElement>('[role="alertdialog"]')).some(
    (item) => item.textContent?.includes('确认智能体操作'),
  );
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  return button;
}

async function runAgentAct(steps: Parameters<typeof uiAgent.act>[0]['steps']) {
  let settled = false;
  let promise!: ReturnType<typeof uiAgent.act>;
  await act(async () => {
    promise = uiAgent.act({ steps }).finally(() => {
      settled = true;
    });
    await settle();
  });
  while (!settled) {
    await act(async () => {
      await settle();
    });
  }
  return promise;
}

async function startPendingAct(
  steps: Parameters<typeof uiAgent.act>[0]['steps'],
): Promise<{ promise: ReturnType<typeof uiAgent.act> }> {
  let promise!: ReturnType<typeof uiAgent.act>;
  await act(async () => {
    promise = uiAgent.act({ steps });
    await settle();
  });
  return { promise };
}

describe('all 11 core application routes agent-readiness', () => {
  it('covers /agents snapshot, search filter, detached row menu, and data-agent-confirm archive guard', async () => {
    let archived = false;
    server.use(
      http.get('/api/agents', ({ request }) => {
        const url = new URL(request.url);
        const q = url.searchParams.get('q') ?? '';
        const items = [analystAgentSummary, opsAgentSummary].filter((item) => {
          if (archived && item.id === analystAgentSummary.id) return false;
          if (!q) return true;
          return item.name.includes(q) || item.description.includes(q);
        });
        return HttpResponse.json({ items, nextCursor: null });
      }),
      http.get('/api/agents/tags', () => HttpResponse.json({ items: ['分析', '运维'] })),
      http.get('/api/runtime-environments', () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.post('/api/agents/:id/archive', ({ params }) => {
        if (params.id === analystAgentSummary.id) archived = true;
        return HttpResponse.json({ ...analystAgentSummary, archivedAt: ISO_T3 });
      }),
    );

    await mountRoute('/agents');
    await waitForPageReady(
      () =>
        Boolean(
          host?.textContent?.includes('数据分析师小智') &&
            host?.textContent?.includes('创建数字分身'),
        ),
      '/agents cards',
    );

    const initialControls = visibleControls();
    expect(initialControls.length).toBeGreaterThan(0);

    const searchResult = await runAgentAct([
      { ref: '搜索专家', action: 'setValue', args: ['运维'] },
    ]);
    expect(searchResult.ok, searchResult.error?.message).toBe(true);
    await waitForPageReady(
      () =>
        Boolean(host?.textContent?.includes('值班运维助手')) &&
        !host?.textContent?.includes('数据分析师小智'),
      '/agents filtered to 运维',
    );

    const clearSearch = await runAgentAct([{ ref: '搜索专家', action: 'setValue', args: [''] }]);
    expect(clearSearch.ok, clearSearch.error?.message).toBe(true);
    await waitForPageReady(
      () => Boolean(host?.textContent?.includes('数据分析师小智')),
      '/agents search cleared',
    );

    const rowMenuEntry = visibleControls().find(
      (entry) =>
        entry.component === 'menu' &&
        Array.isArray(entry.buttons) &&
        entry.buttons.includes('操作 数据分析师小智'),
    );
    expect(rowMenuEntry).toBeDefined();
    if (!rowMenuEntry) throw new Error('Missing /agents row menu entry');

    const openMenu = await runAgentAct([
      { ref: rowMenuEntry.ref, action: 'press', args: ['操作 数据分析师小智'] },
    ]);
    expect(openMenu.ok, openMenu.error?.message).toBe(true);
    await waitForPageReady(
      () =>
        visibleControls().some((entry) => entry.ref === rowMenuEntry.ref && entry.open === true),
      '/agents detached menu opened',
    );

    const rejectArchive = await startPendingAct([
      { ref: rowMenuEntry.ref, action: 'press', args: ['归档'] },
    ]);
    const rejectDialog = findHostAlertDialog();
    expect(rejectDialog.textContent).toContain('归档专家「数据分析师小智」');
    await act(async () => {
      findButtonByText(rejectDialog, '拒绝').click();
      await settle();
    });
    const rejectedResult = await rejectArchive.promise;
    expect(rejectedResult.ok).toBe(false);
    expect(archived).toBe(false);
    expect(calls.some((call) => call.method === 'POST' && call.path.includes('/archive'))).toBe(
      false,
    );
    await flushUi();
    expect(hasHostAlertDialog()).toBe(false);

    const allowArchive = await startPendingAct([
      { ref: rowMenuEntry.ref, action: 'press', args: ['归档'] },
    ]);
    const allowDialog = findHostAlertDialog();
    expect(allowDialog.textContent).toContain('归档专家「数据分析师小智」');
    await act(async () => {
      findButtonByText(allowDialog, '允许执行').click();
      await settle();
    });
    const allowedResult = await allowArchive.promise;
    expect(allowedResult.ok, allowedResult.error?.message).toBe(true);
    await waitForPageReady(() => archived, '/agents archive completed');
    expect(
      calls.some(
        (call) =>
          call.method === 'POST' && call.path === `/api/agents/${analystAgentSummary.id}/archive`,
      ),
    ).toBe(true);
    await flushUi();
    expect(hasHostAlertDialog()).toBe(false);

    assertAllVisibleControlsNamed(initialControls);
  });

  it('covers /chat controls and data-agent-confirm tool approval flow', async () => {
    let approved = false;
    server.use(
      http.get('/api/agents/reference', () =>
        HttpResponse.json({
          items: [defaultAgentSummary, analystAgentSummary],
          truncated: false,
        }),
      ),
      http.get('/api/conversations', () =>
        HttpResponse.json({
          items: [
            {
              id: 'conv_1',
              agentId: analystAgentSummary.id,
              agentName: analystAgentSummary.name,
              title: '指标波动复盘',
              createdAt: ISO_T1,
              updatedAt: ISO_T2,
              lastMessage: {
                role: 'assistant',
                text: '正在请求工具审批',
                createdAt: ISO_T2,
              },
            },
          ],
          nextCursor: null,
        }),
      ),
      http.get('/api/conversations/conv_1', () =>
        HttpResponse.json({
          conversation: {
            id: 'conv_1',
            agentId: analystAgentSummary.id,
            title: '指标波动复盘',
            createdAt: ISO_T1,
          },
          messages: [
            {
              id: 'msg_1',
              conversationId: 'conv_1',
              role: 'user',
              content: '请帮我核查本周成本异常',
              runId: 'run_chat_1',
              createdAt: ISO_T2,
              uiFormat: 'markdown',
              uiProgram: null,
              uiState: null,
            },
            {
              id: 'msg_2',
              conversationId: 'conv_1',
              role: 'assistant',
              content: '我需要调用报表工具进行查询。',
              runId: 'run_chat_1',
              createdAt: ISO_T2,
              uiFormat: 'markdown',
              uiProgram: null,
              uiState: null,
            },
          ],
          runMetrics: [
            {
              runId: 'run_chat_1',
              status: 'succeeded',
              turns: 1,
              durationMs: 1200,
              endedAt: ISO_T2,
              tokens: 320,
              costUsd: 0.012,
              error: null,
            },
          ],
          nextCursor: null,
        }),
      ),
      http.get('/api/conversations/conv_1/outputs', () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get('/api/runs/run_chat_1', () =>
        HttpResponse.json({
          run: {
            id: 'run_chat_1',
            agentId: analystAgentSummary.id,
            agentName: analystAgentSummary.name,
            status: 'succeeded',
            startedAt: ISO_T2,
            endedAt: ISO_T2,
            latencyMs: 1200,
            costUsd: '0.0120',
            turns: 1,
            inputTokens: 200,
            outputTokens: 120,
            error: null,
            trigger: 'chat',
            scheduleId: null,
            agentVersion: 1,
            conversationId: 'conv_1',
            initiatedBy: 'test-admin',
            sessionId: null,
            sandboxId: null,
            runtimeEnvironment: null,
            errorKind: null,
          },
          steps: [],
          conversation: {
            id: 'conv_1',
            agentId: analystAgentSummary.id,
            title: '指标波动复盘',
          },
        }),
      ),
      http.get('/api/runs/run_chat_1/approvals', () =>
        HttpResponse.json({
          items: approved
            ? []
            : [
                {
                  id: 'appr_chat_1',
                  serverId: 'srv_gen',
                  serverName: 'billing-api',
                  toolName: 'fetch_cost_report',
                  createdAt: ISO_T2,
                  approvedAt: null,
                  deniedAt: null,
                  expiresAt: ISO_FUTURE,
                  waiting: true,
                },
              ],
        }),
      ),
      http.get('/api/runs/run_chat_1/questions', () => HttpResponse.json({ items: [] })),
      http.post('/api/runs/run_chat_1/approve', () => {
        approved = true;
        return HttpResponse.json({
          serverId: 'srv_gen',
          toolName: 'fetch_cost_report',
          approvedAt: ISO_T3,
          waiting: true,
        });
      }),
    );

    await mountRoute(`/chat?conversation=conv_1&agent=${analystAgentSummary.id}`);
    await waitForPageReady(
      () => Boolean(host?.textContent?.includes('批准本次调用')),
      '/chat conversation and approval card',
    );

    const controls = visibleControls();
    assertAllVisibleControlsNamed(controls);
    const approveEntry = controls.find(
      (entry) => entry.label === '批准 billing-api / fetch_cost_report',
    );
    expect(approveEntry).toMatchObject({
      component: 'button',
      confirm: '批准 billing-api / fetch_cost_report 的工具调用',
    });

    const rejectApprove = await startPendingAct([
      { ref: '批准 billing-api / fetch_cost_report', action: 'press' },
    ]);
    const rejectDialog = findHostAlertDialog();
    expect(rejectDialog.textContent).toContain('批准 billing-api / fetch_cost_report 的工具调用');
    await act(async () => {
      findButtonByText(rejectDialog, '拒绝').click();
      await settle();
    });
    const rejected = await rejectApprove.promise;
    expect(rejected.ok).toBe(false);
    expect(approved).toBe(false);
    await flushUi();
    expect(hasHostAlertDialog()).toBe(false);

    const allowApprove = await startPendingAct([
      { ref: '批准 billing-api / fetch_cost_report', action: 'press' },
    ]);
    const allowDialog = findHostAlertDialog();
    await act(async () => {
      findButtonByText(allowDialog, '允许执行').click();
      await settle();
    });
    const allowed = await allowApprove.promise;
    expect(allowed.ok, allowed.error?.message).toBe(true);
    await waitForPageReady(() => approved, '/chat approval completed');
    expect(
      calls.some((call) => call.method === 'POST' && call.path === '/api/runs/run_chat_1/approve'),
    ).toBe(true);
    await flushUi();
    expect(hasHostAlertDialog()).toBe(false);
  });

  it('covers /channels snapshot and view toggle switching', async () => {
    server.use(
      http.get('/api/channels', () =>
        HttpResponse.json({
          items: [
            {
              id: 'ch_1',
              name: '平台发布值班室',
              description: '版本发布沟通与工单协作',
              createdBy: 'test-admin',
              archivedAt: null,
              createdAt: ISO_T1,
              updatedAt: ISO_T2,
              role: 'owner',
              lastReadSeq: 4,
              unreadCount: 1,
              memberCount: 5,
              agentCount: 2,
              lastMessage: {
                id: 'cmsg_1',
                seq: 5,
                kind: 'human',
                body: '今晚九点执行灰度观察',
                authorBusinessId: 'test-admin',
                agentId: null,
                createdAt: ISO_T2,
              },
            },
          ],
          nextCursor: null,
        }),
      ),
    );

    const router = await mountRoute('/channels');
    await waitForPageReady(
      () => Boolean(host?.textContent?.includes('平台发布值班室')),
      '/channels list',
    );

    const controls = visibleControls();
    assertAllVisibleControlsNamed(controls);
    expect(controls.map((entry) => entry.label)).toEqual(
      expect.arrayContaining(['新建频道', '切换视图']),
    );

    const switchView = await runAgentAct([
      { ref: '切换视图', action: 'setValue', args: ['table'] },
    ]);
    expect(switchView.ok, switchView.error?.message).toBe(true);
    await waitForPageReady(
      () =>
        Boolean(host?.querySelector('table')) && router.state.location.searchStr.includes('table'),
      '/channels table view',
    );
  });

  it('covers /knowledge snapshot, search, view toggle, and detached row menu', async () => {
    server.use(
      http.get('/api/knowledge/bases', () =>
        HttpResponse.json({
          items: [
            {
              id: 'kb_1',
              slug: 'ops-handbook',
              name: '运维操作手册',
              description: '常见故障排查与恢复流程',
              serverId: 'srv_kb_1',
              status: 'active',
              embeddingProfileId: 'prof_1',
              rerankProfileId: null,
              asrProfileId: null,
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
              createdAt: ISO_T1,
              updatedAt: ISO_T2,
            },
            {
              id: 'kb_2',
              slug: 'billing-faq',
              name: '计费规则文档',
              description: '账单口径与退费标准',
              serverId: 'srv_kb_2',
              status: 'disabled',
              embeddingProfileId: 'prof_1',
              rerankProfileId: null,
              asrProfileId: null,
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
              createdAt: ISO_T1,
              updatedAt: ISO_T2,
            },
          ],
          nextCursor: null,
        }),
      ),
      http.get('/api/knowledge/bases/pins', () => HttpResponse.json({ baseIds: ['kb_1'] })),
      http.get('/api/agents/reference', () =>
        HttpResponse.json({ items: [analystAgentSummary], truncated: false }),
      ),
    );

    const router = await mountRoute('/knowledge');
    await waitForPageReady(
      () =>
        Boolean(
          host?.textContent?.includes('运维操作手册') &&
            host?.textContent?.includes('计费规则文档'),
        ),
      '/knowledge bases',
    );

    const initialControls = visibleControls();
    expect(initialControls.map((entry) => entry.label)).toEqual(
      expect.arrayContaining(['新建知识库', '搜索知识库', '切换视图']),
    );

    const rowMenuEntry = initialControls.find(
      (entry) =>
        entry.component === 'menu' &&
        Array.isArray(entry.buttons) &&
        entry.buttons.includes('操作 运维操作手册'),
    );
    expect(rowMenuEntry).toBeDefined();
    if (!rowMenuEntry) throw new Error('Missing /knowledge row menu entry');

    const openMenu = await runAgentAct([
      { ref: rowMenuEntry.ref, action: 'press', args: ['操作 运维操作手册'] },
    ]);
    expect(openMenu.ok, openMenu.error?.message).toBe(true);
    await waitForPageReady(
      () =>
        visibleControls().some((entry) => entry.ref === rowMenuEntry.ref && entry.open === true),
      '/knowledge detached menu opened',
    );
    const closeMenu = await runAgentAct([
      { ref: rowMenuEntry.ref, action: 'setOpen', args: [false] },
    ]);
    expect(closeMenu.ok, closeMenu.error?.message).toBe(true);
    await waitForPageReady(
      () =>
        visibleControls().some((entry) => entry.ref === rowMenuEntry.ref && entry.open === false),
      '/knowledge detached menu closed',
    );

    const actRes = await runAgentAct([
      { ref: '搜索知识库', action: 'setValue', args: ['运维'] },
      { ref: '切换视图', action: 'setValue', args: ['table'] },
    ]);
    expect(actRes.ok, actRes.error?.message).toBe(true);
    await waitForPageReady(
      () =>
        Boolean(host?.textContent?.includes('运维操作手册')) &&
        !host?.textContent?.includes('计费规则文档') &&
        router.state.location.searchStr.includes('table'),
      '/knowledge filtered and switched view',
    );

    assertAllVisibleControlsNamed(initialControls);
  });

  it('covers /servers snapshot and ConnectionDialog rotated token data-agent-secret redaction', async () => {
    server.use(
      http.get('/api/servers', () =>
        HttpResponse.json({
          items: [
            {
              id: 'srv_gen',
              kind: 'generated',
              name: 'billing-api',
              description: '计费查询 API 连接器',
              baseUrl: 'https://billing.internal/v1',
              headers: {},
              createdAt: ISO_T1,
              updatedAt: ISO_T2,
              lastTestedAt: ISO_T2,
              lastTestOk: true,
              lastToolCount: 3,
              lastTestRuntimeEnvironment: null,
            },
          ],
          nextCursor: null,
        }),
      ),
      http.get('/api/connector-catalog', () => HttpResponse.json([])),
      http.get('/api/agents/reference', () =>
        HttpResponse.json({ items: [analystAgentSummary], truncated: false }),
      ),
      http.get('/api/runtime-environments', () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get('/api/servers/srv_gen/token', () =>
        HttpResponse.json({
          maskedToken: '••••',
          endpoint: 'https://agentport.local/mcp/srv_gen',
        }),
      ),
      http.post('/api/servers/srv_gen/rotate-token', () =>
        HttpResponse.json({
          token: 'srv_secret_plaintext_token_987654',
          endpoint: 'https://agentport.local/mcp/srv_gen',
        }),
      ),
    );

    await mountRoute('/servers');
    await waitForPageReady(
      () => Boolean(host?.textContent?.includes('billing-api')),
      '/servers list',
    );

    const controls = visibleControls();
    assertAllVisibleControlsNamed(controls);
    expect(controls.map((entry) => entry.label)).toEqual(
      expect.arrayContaining(['新建连接器', '搜索连接器', '操作 billing-api', '切换视图']),
    );

    const openConnect = await runAgentAct([
      { ref: '操作 billing-api', action: 'press', args: ['连接信息'] },
    ]);
    expect(openConnect.ok, openConnect.error?.message).toBe(true);
    await waitForPageReady(
      () => Boolean(document.body.textContent?.includes('连接「billing-api」')),
      'ConnectionDialog opened',
    );

    const triggerRotate = await runAgentAct([{ ref: '轮换', action: 'press' }]);
    expect(triggerRotate.ok, triggerRotate.error?.message).toBe(true);
    await waitForPageReady(
      () => Boolean(document.body.textContent?.includes('轮换 token？')),
      'rotate ConfirmDialog opened',
    );

    const pendingRotate = await startPendingAct([{ ref: '确认轮换 token', action: 'press' }]);
    const confirmDialog = findHostAlertDialog();
    await act(async () => {
      findButtonByText(confirmDialog, '允许执行').click();
      await settle();
    });
    const rotateResult = await pendingRotate.promise;
    expect(rotateResult.ok, rotateResult.error?.message).toBe(true);
    await waitForPageReady(
      () => Boolean(document.body.textContent?.includes('只显示这一次')),
      'rotated token shown',
    );

    const secretContainer = document.body.querySelector<HTMLElement>('[data-agent-secret]');
    expect(secretContainer?.textContent).toContain('srv_secret_plaintext_token_987654');

    const snapshotJson = JSON.stringify(uiAgent.snapshot());
    expect(snapshotJson).not.toContain('srv_secret_plaintext_token_987654');
  });

  it('covers /skills snapshot and detached row menu', async () => {
    server.use(
      http.get('/api/skills', () =>
        HttpResponse.json({
          items: [
            {
              id: 'skl_1',
              slug: 'sql-audit',
              name: 'SQL 审计规范',
              description: '检查查询语句是否缺少索引条件',
              body: '# SQL Audit',
              sourceId: null,
              createdAt: ISO_T1,
              updatedAt: ISO_T2,
              status: 'published',
              submittedAt: ISO_T1,
              reviewedAt: ISO_T1,
              reviewedBy: 'test-admin',
              reviewNote: null,
              agentCount: 2,
            },
            {
              id: 'skl_2',
              slug: 'release-check',
              name: '发布前检查清单',
              description: '核对回滚预案与变更窗口',
              body: '# Release Checklist',
              sourceId: null,
              createdAt: ISO_T2,
              updatedAt: ISO_T3,
              status: 'draft',
              submittedAt: null,
              reviewedAt: null,
              reviewedBy: null,
              reviewNote: null,
              agentCount: 0,
            },
          ],
          nextCursor: null,
        }),
      ),
    );

    await mountRoute('/skills');
    await waitForPageReady(
      () =>
        Boolean(
          host?.textContent?.includes('SQL 审计规范') &&
            host?.textContent?.includes('发布前检查清单'),
        ),
      '/skills list',
    );

    const initialControls = visibleControls();
    expect(initialControls.map((entry) => entry.label)).toEqual(
      expect.arrayContaining(['新建技能', '搜索技能', '切换视图']),
    );

    const rowMenuEntry = initialControls.find(
      (entry) =>
        entry.component === 'menu' &&
        Array.isArray(entry.buttons) &&
        entry.buttons.includes('操作 SQL 审计规范'),
    );
    expect(rowMenuEntry).toBeDefined();
    if (!rowMenuEntry) throw new Error('Missing /skills row menu entry');

    const openMenu = await runAgentAct([
      { ref: rowMenuEntry.ref, action: 'press', args: ['操作 SQL 审计规范'] },
    ]);
    expect(openMenu.ok, openMenu.error?.message).toBe(true);
    await waitForPageReady(
      () =>
        visibleControls().some((entry) => entry.ref === rowMenuEntry.ref && entry.open === true),
      '/skills detached menu opened',
    );

    assertAllVisibleControlsNamed(initialControls);
  });

  it('covers /eval snapshot, tabs, segmented controls, and tab switching', async () => {
    server.use(
      http.get('/api/agents/reference', () =>
        HttpResponse.json({
          items: [defaultAgentSummary, analystAgentSummary],
          truncated: false,
        }),
      ),
      http.get(`/api/agents/${analystAgentSummary.id}/access`, () =>
        HttpResponse.json({
          agentId: analystAgentSummary.id,
          permissionIds: ['eval.read', 'eval.manage', 'eval.execute', 'agents.config.read'],
        }),
      ),
      http.get(`/api/agents/${analystAgentSummary.id}`, () =>
        HttpResponse.json(analystAgentDetail),
      ),
      http.get('/api/eval/cases', () =>
        HttpResponse.json({
          items: [
            {
              id: 'ec_1',
              agentId: analystAgentSummary.id,
              name: '成本激增归因',
              prompt: '昨天成本上涨原因是什么？',
              expectation: '指出具体调用峰值',
              judgeMode: 'contains',
              expectedTools: ['fetch_cost_report'],
              forbiddenTools: [],
              createdBy: 'test-admin',
              createdAt: ISO_T1,
            },
          ],
          nextCursor: null,
        }),
      ),
      http.get('/api/eval/runs', () =>
        HttpResponse.json({
          items: [
            {
              id: 'er_2',
              agentId: analystAgentSummary.id,
              status: 'succeeded',
              agentVersion: 1,
              resourceVersions: null,
              total: 1,
              passed: 1,
              error: null,
              createdAt: ISO_T2,
              finishedAt: ISO_T2,
            },
            {
              id: 'er_1',
              agentId: analystAgentSummary.id,
              status: 'succeeded',
              agentVersion: 1,
              resourceVersions: null,
              total: 1,
              passed: 0,
              error: null,
              createdAt: ISO_T1,
              finishedAt: ISO_T1,
            },
          ],
          nextCursor: null,
        }),
      ),
      http.get('/api/eval/runs/er_2', () =>
        HttpResponse.json({
          evalRun: {
            id: 'er_2',
            agentId: analystAgentSummary.id,
            status: 'succeeded',
            agentVersion: 1,
            resourceVersions: null,
            total: 1,
            passed: 1,
            error: null,
            createdAt: ISO_T2,
            finishedAt: ISO_T2,
          },
          results: [
            {
              caseId: 'ec_1',
              name: '成本激增归因',
              prompt: '昨天成本上涨原因是什么？',
              expectation: '指出具体调用峰值',
              passed: true,
              output: '昨日 14:00 出现调用峰值。',
              judgeReason: null,
              runId: 'run_eval_2',
            },
          ],
        }),
      ),
      http.get('/api/eval/runs/er_1/compare', () =>
        HttpResponse.json({
          baseRun: {
            id: 'er_1',
            agentId: analystAgentSummary.id,
            status: 'succeeded',
            agentVersion: 1,
            resourceVersions: null,
            total: 1,
            passed: 0,
            error: null,
            createdAt: ISO_T1,
            finishedAt: ISO_T1,
          },
          headRun: {
            id: 'er_2',
            agentId: analystAgentSummary.id,
            status: 'succeeded',
            agentVersion: 1,
            resourceVersions: null,
            total: 1,
            passed: 1,
            error: null,
            createdAt: ISO_T2,
            finishedAt: ISO_T2,
          },
          rows: [
            {
              key: 'ec_1',
              status: 'improved',
              base: {
                caseId: 'ec_1',
                name: '成本激增归因',
                prompt: '昨天成本上涨原因是什么？',
                expectation: '指出具体调用峰值',
                passed: false,
                output: '未查到峰值',
                judgeReason: '未包含期望信息',
                runId: 'run_eval_1',
              },
              head: {
                caseId: 'ec_1',
                name: '成本激增归因',
                prompt: '昨天成本上涨原因是什么？',
                expectation: '指出具体调用峰值',
                passed: true,
                output: '昨日 14:00 出现调用峰值。',
                judgeReason: null,
                runId: 'run_eval_2',
              },
            },
          ],
        }),
      ),
    );

    const router = await mountRoute('/eval');
    await waitForPageReady(
      () =>
        Boolean(host?.textContent?.includes('评估运行') && host?.textContent?.includes('运行明细')),
      '/eval initial load',
    );

    const initialControls = visibleControls();
    const tabsControl = initialControls.find((entry) => entry.component === 'tabs');
    expect(tabsControl).toMatchObject({ component: 'tabs', label: '评估分区' });
    expect(initialControls.some((entry) => entry.component === 'segmented-control')).toBe(true);

    const switchToCases = await runAgentAct([
      { ref: '评估分区', action: 'setValue', args: ['cases'] },
    ]);
    expect(switchToCases.ok, switchToCases.error?.message).toBe(true);
    await waitForPageReady(
      () =>
        Boolean(host?.textContent?.includes('成本激增归因')) &&
        router.state.location.searchStr.includes('cases'),
      '/eval switched to cases tab',
    );

    const switchToCompare = await runAgentAct([
      { ref: '评估分区', action: 'setValue', args: ['compare'] },
    ]);
    expect(switchToCompare.ok, switchToCompare.error?.message).toBe(true);
    await waitForPageReady(
      () =>
        Boolean(host?.textContent?.includes('对比差异')) ||
        Boolean(host?.textContent?.includes('运行对比')),
      '/eval switched to compare tab',
    );

    assertAllVisibleControlsNamed(initialControls);
  });

  it('covers /operations snapshot, segmented toggle switching, and inspects approval links', async () => {
    server.use(
      http.get('/api/overview', () =>
        HttpResponse.json({
          window: { days: 7, since: ISO_T1 },
          counts: {
            servers: 2,
            agents: 3,
            runs: 12,
            running: 1,
            failed: 1,
            tokens: 4500,
            costUsd: 0.42,
            avgLatencyMs: 850,
          },
          agents: [
            {
              agentId: analystAgentSummary.id,
              name: analystAgentSummary.name,
              slug: analystAgentSummary.slug,
              createdAt: ISO_T1,
              enabled: true,
              lastRunStartTime: ISO_T2,
              runCount: 12,
              totalCost: 0.42,
              errorRate: 0.08,
              latencyP50: 700,
              latencyP99: 1500,
              totalTokens: 4500,
            },
          ],
          recent: [
            {
              id: 'run_recent_1',
              agentId: analystAgentSummary.id,
              agentName: analystAgentSummary.name,
              status: 'succeeded',
              startedAt: ISO_T2,
              endedAt: ISO_T2,
              costUsd: '0.0350',
              turns: 2,
              latencyMs: 850,
              error: null,
            },
          ],
        }),
      ),
      http.get('/api/overview/timeseries', () =>
        HttpResponse.json([
          { date: '2026-11-26', runs: 0, failed: 0, costUsd: 0, tokens: 0 },
          { date: '2026-11-27', runs: 0, failed: 0, costUsd: 0, tokens: 0 },
        ]),
      ),
      http.get('/api/attention', () =>
        HttpResponse.json({
          approvals: [
            {
              kind: 'approval',
              runId: 'run_pending_1',
              agentId: analystAgentSummary.id,
              agentName: analystAgentSummary.name,
              serverId: 'srv_gen',
              toolName: 'issue_refund',
              createdAt: ISO_T2,
              expiresAt: ISO_FUTURE,
            },
          ],
          failedRuns: [],
          total: 1,
        }),
      ),
      http.get('/api/retention', () =>
        HttpResponse.json({
          runDays: 90,
          messageDays: 30,
          agentVersions: 50,
          updatedAt: ISO_T2,
          updatedBy: 'test-admin',
        }),
      ),
      http.get('/api/observability', () =>
        HttpResponse.json({
          window: { minutes: 60, since: ISO_T2 },
          sloWindowMinutes: 60,
          sloEnabled: true,
          generatedAt: ISO_T3,
          runs: {
            total: 12,
            finished: 12,
            succeeded: 11,
            failed: 1,
            timeout: 0,
            cancelled: 0,
            running: 0,
            successRate: 11 / 12,
            errorRate: 1 / 12,
            p50LatencyMs: 700,
            p95LatencyMs: 1400,
            p99LatencyMs: 1500,
            costUsd: 0.42,
            inputTokens: 3000,
            outputTokens: 1500,
          },
          queues: [
            {
              name: 'runs',
              waiting: 0,
              active: 1,
              completed: 12,
              failed: 1,
              delayed: 0,
              oldestWaitingMs: null,
            },
          ],
          providers: [],
          slo: [
            {
              key: 'run_success',
              label: '运行成功率',
              target: 0.95,
              actual: 11 / 12,
              ok: false,
              sampleSize: 12,
            },
          ],
          alerts: {
            openViolations: 0,
            pendingApprovals: 1,
            recentOpsAlerts: 0,
          },
        }),
      ),
      http.get('/api/observability/slo', () =>
        HttpResponse.json({
          enabled: true,
          windowMinutes: 60,
          runSuccessTarget: 0.95,
          runP95LatencyMs: 120_000,
          queueOldestWaitMs: 60_000,
          providerErrorRateTarget: 0.05,
        }),
      ),
      http.get('/health/metrics', () =>
        HttpResponse.json({
          process: { uptimeSeconds: 1200, memoryRssBytes: 134_217_728, bunVersion: '1.3.1' },
          queue: {
            waiting: 0,
            active: 0,
            completed: 12,
            failed: 0,
            delayed: 0,
            oldestWaitingMs: null,
          },
          knowledgeQueue: {
            waiting: 0,
            active: 0,
            completed: 2,
            failed: 0,
            delayed: 0,
            oldestWaitingMs: null,
          },
          db: { connected: true, pingMs: 2, maxConnections: 10 },
          redis: { pingMs: 1 },
        }),
      ),
    );

    const router = await mountRoute('/operations');
    await waitForPageReady(
      () =>
        Boolean(
          host?.textContent?.includes('需要处理') &&
            host?.textContent?.includes('等待批准 issue_refund') &&
            host?.textContent?.includes('数据保留') &&
            host?.querySelector('table[aria-label="专家指标"]'),
        ),
      '/operations loaded',
    );

    const controls = visibleControls();
    assertAllVisibleControlsNamed(controls);
    expect(controls.map((entry) => entry.label)).toEqual(
      expect.arrayContaining(['概况分区', '数据保留', '导出 CSV']),
    );
    expect(host?.textContent).toContain('等待批准 issue_refund');

    const switchSection = await runAgentAct([
      { ref: '概况分区', action: 'setValue', args: ['observability'] },
    ]);
    expect(switchSection.ok, switchSection.error?.message).toBe(true);
    await waitForPageReady(
      () =>
        Boolean(host?.textContent?.includes('指标明细')) &&
        router.state.location.searchStr.includes('observability'),
      '/operations switched to observability section',
    );

    const obsControls = visibleControls();
    assertAllVisibleControlsNamed(obsControls);
    expect(obsControls.map((entry) => entry.label)).toEqual(
      expect.arrayContaining(['概况分区', '看板统计窗口', 'SLO 设置', '切换区段']),
    );

    const switchObsSegment = await runAgentAct([
      { ref: '切换区段', action: 'setValue', args: ['queues'] },
    ]);
    expect(switchObsSegment.ok, switchObsSegment.error?.message).toBe(true);
    await waitForPageReady(
      () =>
        Boolean(host?.querySelector('table[aria-label="队列"]')) &&
        router.state.location.searchStr.includes('queues'),
      '/operations switched to queues segment',
    );
  });

  it('covers /schedules snapshot and switch interaction', async () => {
    let enabled = true;
    server.use(
      http.get('/api/schedules', () =>
        HttpResponse.json({
          items: [
            {
              id: 'sch_1',
              agentId: analystAgentSummary.id,
              agentName: analystAgentSummary.name,
              name: '每日晨报汇总',
              cron: '0 9 * * *',
              timezone: 'Asia/Shanghai',
              missedPolicy: 'skip',
              description: '每天 09:00',
              prompt: '生成昨日指标日报',
              enabled,
              lastRunAt: ISO_T2,
              nextDueAt: ISO_FUTURE,
              createdAt: ISO_T1,
              updatedAt: ISO_T2,
            },
          ],
          nextCursor: null,
        }),
      ),
      http.get('/api/agents/reference', () =>
        HttpResponse.json({ items: [analystAgentSummary], truncated: false }),
      ),
      http.patch('/api/schedules/sch_1', async ({ request }) => {
        const body = (await request.json()) as { enabled?: boolean };
        if (typeof body.enabled === 'boolean') enabled = body.enabled;
        return HttpResponse.json({
          id: 'sch_1',
          agentId: analystAgentSummary.id,
          agentName: analystAgentSummary.name,
          name: '每日晨报汇总',
          cron: '0 9 * * *',
          timezone: 'Asia/Shanghai',
          missedPolicy: 'skip',
          description: '每天 09:00',
          prompt: '生成昨日指标日报',
          enabled,
          lastRunAt: ISO_T2,
          nextDueAt: ISO_FUTURE,
          createdAt: ISO_T1,
          updatedAt: ISO_T3,
        });
      }),
    );

    await mountRoute('/schedules');
    await waitForPageReady(
      () => Boolean(host?.textContent?.includes('每日晨报汇总')),
      '/schedules list',
    );

    const controls = visibleControls();
    assertAllVisibleControlsNamed(controls);
    expect(controls.map((entry) => entry.label)).toEqual(
      expect.arrayContaining(['新建定时任务', '切换视图', '暂停 每日晨报汇总']),
    );

    const toggleRes = await runAgentAct([
      { ref: '暂停 每日晨报汇总', action: 'setChecked', args: [false] },
    ]);
    expect(toggleRes.ok, toggleRes.error?.message).toBe(true);
    await waitForPageReady(() => !enabled, '/schedules toggled disabled');
  });

  it('covers /integrations snapshot, tab switching, and secret token creation redaction', async () => {
    server.use(
      http.get('/api/integrations/tokens', () =>
        HttpResponse.json({
          items: [
            {
              id: 'tok_1',
              name: 'CI 触发令牌',
              tokenPrefix: 'agp_live_',
              scopes: ['runs.create', 'runs.read'],
              expiresAt: null,
              revokedAt: null,
              lastUsedAt: ISO_T2,
              createdAt: ISO_T1,
            },
          ],
          nextCursor: null,
        }),
      ),
      http.get('/api/integrations/webhooks', () =>
        HttpResponse.json({
          items: [
            {
              id: 'wh_1',
              name: '告警推送端点',
              direction: 'outbound',
              agentId: null,
              agentName: null,
              url: 'https://hooks.example.com/agentport',
              events: ['run.completed', 'run.failed'],
              enabled: true,
              createdAt: ISO_T1,
              updatedAt: ISO_T2,
            },
          ],
          nextCursor: null,
        }),
      ),
      http.post('/api/integrations/tokens', async () =>
        HttpResponse.json(
          {
            id: 'tok_new',
            name: '自动化集成令牌',
            tokenPrefix: 'agp_sec_',
            scopes: ['runs.create'],
            expiresAt: null,
            revokedAt: null,
            lastUsedAt: null,
            createdAt: ISO_T3,
            token: 'agp_sec_one_time_secret_456',
          },
          { status: 201 },
        ),
      ),
    );

    const router = await mountRoute('/integrations');
    await waitForPageReady(
      () => Boolean(host?.textContent?.includes('CI 触发令牌')),
      '/integrations tokens list',
    );

    const controls = visibleControls();
    assertAllVisibleControlsNamed(controls);
    expect(controls.map((entry) => entry.label)).toEqual(
      expect.arrayContaining(['新建令牌', '集成分区', '切换视图']),
    );

    const switchTab = await runAgentAct([
      { ref: '集成分区', action: 'setValue', args: ['webhooks'] },
    ]);
    expect(switchTab.ok, switchTab.error?.message).toBe(true);
    await waitForPageReady(
      () =>
        Boolean(host?.textContent?.includes('告警推送端点')) &&
        router.state.location.searchStr.includes('webhooks'),
      '/integrations switched to webhooks tab',
    );

    const backToTokens = await runAgentAct([
      { ref: '集成分区', action: 'setValue', args: ['tokens'] },
    ]);
    expect(backToTokens.ok, backToTokens.error?.message).toBe(true);
    await waitForPageReady(
      () => Boolean(host?.textContent?.includes('新建令牌')),
      '/integrations back to tokens tab',
    );

    const openDialog = await runAgentAct([{ ref: '新建令牌', action: 'press' }]);
    expect(openDialog.ok, openDialog.error?.message).toBe(true);
    await waitForPageReady(
      () => Boolean(document.getElementById('api-token-name')),
      'ApiTokenDialog opened',
    );
    const submitToken = await runAgentAct([
      { ref: '名称 必填', action: 'setValue', args: ['自动化集成令牌'] },
      { ref: '触发运行runs.create', action: 'setChecked', args: [true] },
      { ref: '新建令牌', action: 'press', args: ['新建令牌'] },
    ]);
    expect(submitToken.ok, submitToken.error?.message).toBe(true);
    await waitForPageReady(
      () => Boolean(document.getElementById('api-token-value')),
      'one-time token secret field rendered',
    );

    const tokenInput = document.getElementById('api-token-value');
    expect(tokenInput).toBeInstanceOf(HTMLInputElement);
    expect((tokenInput as HTMLInputElement).value).toBe('agp_sec_one_time_secret_456');

    const secretSnap = uiAgent
      .snapshot()
      .find((entry) => !entry.offPage && entry.component === 'input' && entry.label === '令牌');
    expect(secretSnap).toMatchObject({
      component: 'input',
      label: '令牌',
      value: '[redacted]',
    });
    expect(JSON.stringify(uiAgent.snapshot())).not.toContain('agp_sec_one_time_secret_456');
  });

  it('covers /accounts snapshot, detached row menu, and PasswordInput redaction', async () => {
    server.use(
      http.get('/api/accounts', () =>
        HttpResponse.json({
          items: [
            {
              businessId: 'emp_001',
              username: 'zhangsan',
              name: '张三',
              status: 'active',
              roles: [{ id: 'role_admin', name: '平台管理员', systemKey: 'admin' }],
              createdAt: ISO_T1,
            },
            {
              businessId: 'emp_002',
              username: 'lisi',
              name: '李四',
              status: 'active',
              roles: [{ id: 'role_admin', name: '平台管理员', systemKey: 'admin' }],
              createdAt: ISO_T2,
            },
          ],
          total: 2,
        }),
      ),
      http.get('/api/roles', () =>
        HttpResponse.json({
          revision: 1,
          roles: [
            {
              id: 'role_admin',
              name: '平台管理员',
              systemKey: 'admin',
              grants: [],
              createdAt: ISO_T1,
              updatedAt: ISO_T1,
            },
          ],
        }),
      ),
    );

    await mountRoute('/accounts');
    await waitForPageReady(
      () => Boolean(host?.textContent?.includes('张三') && host?.textContent?.includes('李四')),
      '/accounts table',
    );

    const initialControls = visibleControls();
    expect(initialControls.map((entry) => entry.label)).toEqual(
      expect.arrayContaining([
        '新建账户',
        '搜索账户',
        '切换视图',
        '查看 张三 详情',
        '查看 李四 详情',
      ]),
    );

    const rowMenuEntry = initialControls.find(
      (entry) =>
        entry.component === 'menu' &&
        Array.isArray(entry.buttons) &&
        entry.buttons.includes('操作 张三'),
    );
    expect(rowMenuEntry).toBeDefined();
    if (!rowMenuEntry) throw new Error('Missing /accounts row menu entry');

    const openMenu = await runAgentAct([
      { ref: rowMenuEntry.ref, action: 'press', args: ['操作 张三'] },
    ]);
    expect(openMenu.ok, openMenu.error?.message).toBe(true);
    await waitForPageReady(
      () =>
        visibleControls().some((entry) => entry.ref === rowMenuEntry.ref && entry.open === true),
      '/accounts detached menu opened',
    );

    const openReset = await runAgentAct([
      { ref: rowMenuEntry.ref, action: 'press', args: ['重置密码'] },
    ]);
    expect(openReset.ok, openReset.error?.message).toBe(true);
    await waitForPageReady(
      () => Boolean(document.getElementById('account-reset-password')),
      'account inspector security tab opened',
    );

    assertAllVisibleControlsNamed(visibleControls());

    const typePassword = await runAgentAct([
      { ref: '新密码', action: 'setValue', args: ['SuperSecret#2026'] },
    ]);
    expect(typePassword.ok, typePassword.error?.message).toBe(true);
    const passwordEntry = visibleControls().find((entry) => entry.component === 'password-input');
    expect(passwordEntry).toMatchObject({
      component: 'password-input',
      value: '[redacted]',
      visible: false,
    });
    expect(JSON.stringify(uiAgent.snapshot())).not.toContain('SuperSecret#2026');

    assertAllVisibleControlsNamed(initialControls);
  });
});
