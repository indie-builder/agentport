import { type Agent, agentInputSchema, type WorkspaceFiles } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.js';
import { AgentEditor } from '../src/pages/agents.js';

const state = vi.hoisted(() => ({ agent: null as Agent | null }));

// 其余数据源保持桩，只让 useAgentFiles 走真实查询，才能看到 enabled 的实际效果。
vi.mock('../src/lib/queries.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/queries.js')>();
  return {
    ...actual,
    useAgents: () => ({ data: state.agent ? [state.agent] : [] }),
    useServers: () => ({ data: [], isPending: false, isError: false }),
    useKnowledgeBases: () => ({ data: [], isPending: false, isError: false }),
    usePlugins: () => ({ data: [], isPending: false, isError: false, status: 'success' }),
    useSkills: () => ({
      data: [],
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
  };
});
vi.mock('@tanstack/react-router', () => ({
  Link: 'a',
  useBlocker: () => ({ status: 'idle', proceed: vi.fn(), reset: vi.fn() }),
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
  useParams: () => ({ agentId: 'expert' }),
  useLocation: () => ({ state: undefined }),
}));

const agent: Agent = {
  ...agentInputSchema.parse({ slug: 'expert', name: 'Expert' }),
  id: 'expert',
  parentId: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
} as Agent;

const files: WorkspaceFiles = {
  mcpJson: '{}',
  claudeMd: '# CLAUDE',
  agentMd: '# Expert',
  settingsJson: null,
  skills: [],
  subAgents: [],
  rules: [],
  outputStyles: [],
  selectedOutputStyle: null,
  plugins: [],
};

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let agentFiles: ReturnType<typeof vi.spyOn>;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function waitFor(probe: () => boolean, tries = 40): Promise<void> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (probe()) return;
    await flush();
  }
  expect(probe()).toBe(true);
}

function button(text: string): HTMLButtonElement {
  const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
  await flush();
}

async function renderEditor(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AgentEditor, {
          agent,
          onDirtyChange: () => {},
          onPendingChange: () => {},
          onDeleteRequest: () => {},
        }),
      ),
    );
  });
  await flush();
}

beforeEach(() => {
  state.agent = agent;
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
  agentFiles = vi.spyOn(api, 'agentFiles').mockResolvedValue(files);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('agent files on demand', () => {
  it('only requests workspace files once the files tab is opened', async () => {
    await renderEditor();
    expect(agentFiles).not.toHaveBeenCalled();

    await click(button('完整文件'));
    await waitFor(() => agentFiles.mock.calls.length > 0);

    expect(agentFiles).toHaveBeenCalledWith('expert');
  });
});
