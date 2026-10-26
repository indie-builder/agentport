import { renderWorkspace } from '@agentport/core/workspace';
import type { Agent } from '@agentport/shared';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentEditor } from '../src/pages/agents.js';

vi.mock('@/components/ui/button', () => import('../src/components/ui/button.js'));
vi.mock('@/components/ui/input-group', () => import('../src/components/ui/input-group.js'));
vi.mock('@/components/ui/input', () => import('../src/components/ui/input.js'));
vi.mock('@/components/ui/textarea', () => import('../src/components/ui/textarea.js'));
vi.mock('@/components/ui/label', () => import('../src/components/ui/label.js'));
vi.mock('@/components/ui/separator', () => import('../src/components/ui/separator.js'));

// Field 是无关分区的稳定子组件：它多渲染一次就代表根表单跟着文本重渲染了一次。
const fieldRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/components/ui/field', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/components/ui/field.js')>();
  return {
    ...actual,
    Field: (props: Parameters<typeof actual.Field>[0]) => {
      fieldRenders.count += 1;
      return createElement(actual.Field, props);
    },
  };
});
// 保留真实渲染逻辑，只记录调用：回归点是「折叠时不该生成工作区」。
vi.mock('@agentport/core/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentport/core/workspace')>();
  return { ...actual, renderWorkspace: vi.fn(actual.renderWorkspace) };
});

const state = vi.hoisted(() => ({
  agents: [] as Agent[],
  skills: [] as Array<{
    id: string;
    slug: string;
    name: string;
    description: string;
    body: string;
  }>,
}));

vi.mock('../src/lib/queries.js', () => ({
  useAgents: () => ({ data: state.agents }),
  useServers: () => ({ data: [], isPending: false, isError: false }),
  useKnowledgeBases: () => ({ data: [], isPending: false, isError: false }),
  usePlugins: () => ({ data: [], isPending: false, isError: false, status: 'success' }),
  useSkills: () => ({
    data: state.skills,
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    status: 'success',
  }),
  useUpdateAgent: () => ({ isPending: false, mutate: vi.fn() }),
  useCreateAgent: () => ({ isPending: false, mutate: vi.fn() }),
  useDuplicateAgent: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteAgent: () => ({ mutateAsync: vi.fn() }),
  useAgentVersions: () => ({ data: [] }),
  useAgentVersion: () => ({ data: undefined, isPending: false, isError: false }),
  useRollbackAgent: () => ({ mutateAsync: vi.fn() }),
  useAgentFiles: () => ({
    data: undefined,
    isPending: true,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  toolsQuery: () => ({ queryKey: ['tools'], queryFn: async () => [] }),
}));
vi.mock('@tanstack/react-query', () => ({ useQueries: () => [], useQueryClient: () => ({}) }));
vi.mock('@tanstack/react-router', () => ({
  Link: 'a',
  useBlocker: () => ({ status: 'idle', proceed: vi.fn(), reset: vi.fn() }),
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
  useParams: () => ({ agentId: 'parent' }),
  useLocation: () => ({ state: undefined }),
}));

const parent: Agent = {
  id: 'parent',
  slug: 'parent',
  name: 'Parent',
  description: '',
  model: 'test',
  role: '通用助手',
  systemPrompt: 'Initial prompt',
  serverIds: [],
  skillIds: ['skill-1'],
  pluginBindings: [],
  subAgentIds: ['child'],
  allowedTools: [],
  disallowedTools: [],
  permissionMode: 'dontAsk',
  maxTurns: 20,
  maxBudgetUsd: 2,
  timeoutMs: 600_000,
  enabled: true,
  parentId: null,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
} as Agent;

let host: HTMLDivElement;
let root: Root;
const renderSpy = vi.mocked(renderWorkspace);

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
async function waitFor<T>(probe: () => T, tries = 40): Promise<T> {
  for (let i = 0; i < tries; i += 1) {
    try {
      const value = probe();
      if (value) return value;
    } catch {
      // 预览展开动画与状态更新还没落地，继续等。
    }
    await flush();
  }
  return probe();
}
function button(text: string, scope: ParentNode = host): HTMLButtonElement {
  const element = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text,
  );
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}
async function type(id: string, value: string) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement)) {
    throw new Error(`Missing input: ${id}`);
  }
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}
function previewCode(): string | undefined {
  return host.querySelector('section[aria-label="代码内容"]')?.textContent ?? undefined;
}
async function mount() {
  await act(async () => {
    root.render(
      createElement(AgentEditor, {
        agent: parent,
        onDirtyChange: () => {},
        onPendingChange: () => {},
        onDeleteRequest: () => {},
      }),
    );
  });
  await flush();
  await click(button('行为'));
  await waitFor(() => document.querySelector('#agent-prompt'));
}
async function openPreview(title: string) {
  await click(button(title));
  return waitFor(previewCode);
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  state.agents = [
    parent,
    {
      ...parent,
      id: 'child',
      slug: 'bound-child',
      name: 'Bound child',
      parentId: 'parent',
      subAgentIds: [],
      skillIds: [],
    },
  ];
  state.skills = [
    {
      id: 'skill-1',
      slug: 'review-skill',
      name: 'Review skill',
      description: 'Checks reviews',
      body: '# Review',
    },
  ];
  renderSpy.mockClear();
  fieldRenders.count = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('expert draft preview on demand', () => {
  it('does not render the workspace while the preview is collapsed', async () => {
    await mount();
    await type('agent-prompt', 'Collapsed edit');

    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('renders the real workspace after expanding and follows later field edits', async () => {
    await mount();
    const code = await openPreview('CLAUDE.md 草稿');

    expect(code).toContain('Initial prompt');
    expect(code).toContain('review-skill');
    expect(code).toContain('bound-child');
    expect(renderSpy).toHaveBeenCalled();

    const callsBefore = renderSpy.mock.calls.length;
    await type('agent-prompt', 'Expanded edit');
    const updated = await waitFor(() =>
      previewCode()?.includes('Expanded edit') ? previewCode() : undefined,
    );

    expect(updated).toContain('Expanded edit');
    expect(renderSpy.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('does not re-render unrelated fields while typing the system prompt', async () => {
    await mount();
    // 第一次输入把表单从 pristine 变 dirty，根渲染一次是合法开销；之后不应再跟随文本逐键重渲染。
    await type('agent-prompt', 'First edit');
    const baseline = fieldRenders.count;
    await type('agent-prompt', 'Second edit');
    await type('agent-prompt', 'Third edit');

    expect(fieldRenders.count).toBe(baseline);
  });

  it('shows edits made before the preview is first expanded', async () => {
    await mount();
    await type('agent-prompt', 'Edited before first expand');

    const code = await openPreview('CLAUDE.md 草稿');

    expect(code).toContain('Edited before first expand');
  });

  it('stops rendering the workspace again after the preview is closed', async () => {
    await mount();
    await openPreview('CLAUDE.md 草稿');
    await click(button('CLAUDE.md 草稿'));
    expect(previewCode()).toBeUndefined();
    const callsAfterClose = renderSpy.mock.calls.length;

    await type('agent-prompt', 'Closed edit');

    expect(renderSpy.mock.calls.length).toBe(callsAfterClose);
  });
});
