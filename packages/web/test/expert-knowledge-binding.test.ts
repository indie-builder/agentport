import { type Agent, agentInputSchema, type Server } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Combobox, ComboboxList } from '../src/components/ui/combobox.js';
import { AgentEditor } from '../src/pages/agents.js';

vi.mock('@/components/ui/button', () => import('../src/components/ui/button.js'));
vi.mock('@/components/ui/input-group', () => import('../src/components/ui/input-group.js'));
vi.mock('@/components/ui/input', () => import('../src/components/ui/input.js'));
vi.mock('@/components/ui/textarea', () => import('../src/components/ui/textarea.js'));
vi.mock('@/components/ui/label', () => import('../src/components/ui/label.js'));
vi.mock('@/components/ui/separator', () => import('../src/components/ui/separator.js'));
vi.mock('@tanstack/react-router', () => ({
  useBlocker: () => ({ status: 'idle' }),
  useNavigate: () => () => {},
  useSearch: () => ({}),
  Link: 'a',
}));

const mocks = vi.hoisted(() => ({
  servers: [] as unknown[],
  bases: [] as unknown[],
  agents: [] as unknown[],
}));

vi.mock('../src/lib/queries.js', async (original) => {
  const queries = await original<typeof import('../src/lib/queries.js')>();
  return {
    ...queries,
    useServers: () => ({ data: mocks.servers, isPending: false, isError: false }),
    // 通用 /api/servers 已过滤 knowledge；知识库只能从这里拿到 serverId 绑定。
    useKnowledgeBases: () => ({ data: mocks.bases, isPending: false, isError: false }),
    useSkills: () => ({ data: [], isPending: false, isError: false }),
    useAgents: () => ({ data: mocks.agents, isPending: false, isError: false }),
    useUpdateAgent: () => ({ isPending: false, mutate: () => {} }),
    useAgentFiles: () => ({ data: undefined, isPending: true, isError: false, refetch: () => {} }),
    useAgentVersions: () => ({ data: [], isPending: false, isError: false }),
    useRollbackAgent: () => ({ isPending: false, mutateAsync: () => {} }),
  };
});

const server: Server = {
  id: 'server',
  name: 'connector',
  description: '',
  kind: 'http',
  url: 'https://example.com/mcp',
  headers: {},
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

const bases = [
  {
    id: 'kb_1',
    slug: 'handbook',
    name: '产品手册',
    description: '',
    serverId: 'server-kb-active',
    status: 'active',
    embeddingProfileId: 'profile',
    rerankProfileId: null,
    settings: { chunkTokens: 800, chunkOverlap: 120, wikiAutoUpdate: false },
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  },
  {
    id: 'kb_2',
    slug: 'archive',
    name: '归档库',
    description: '',
    serverId: 'server-kb-disabled',
    status: 'disabled',
    embeddingProfileId: 'profile',
    rerankProfileId: null,
    settings: { chunkTokens: 800, chunkOverlap: 120, wikiAutoUpdate: false },
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  },
];

function agentWith(serverIds: string[]): Agent {
  return {
    ...agentInputSchema.parse({ slug: 'expert', name: 'Expert' }),
    id: 'expert',
    parentId: null,
    serverIds,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
}

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function flatText(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(flatText).join(' ');
  if (typeof node === 'string') return node;
  if (isValidElement<Record<string, unknown>>(node))
    return flatText(node.props.children as ReactNode);
  return '';
}

const clients: QueryClient[] = [];
function inspect(agent: Agent, visit: (tree: Element[], pass: number) => void) {
  mocks.servers = [server];
  mocks.bases = bases;
  mocks.agents = [agent];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } },
  });
  client.setQueryData(['agents'], [agent]);
  client.setQueryData(['servers'], [server]);
  client.setQueryData(['knowledge', 'bases'], {
    pages: [{ items: bases, nextCursor: null }],
    pageParams: [null],
  });
  clients.push(client);
  let pass = 0;
  function Probe() {
    visit(elements(render()), pass++);
    return null;
  }
  const render = () =>
    AgentEditor({
      agent,
      onDirtyChange: () => {},
      onPendingChange: () => {},
      onDeleteRequest: () => {},
    });
  renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Probe)));
}

function selectSection(tree: Element[], label: string) {
  const item = tree.find(
    (node) =>
      typeof node.props.onClick === 'function' && flatText(node.props.children).includes(label),
  );
  if (!item) throw new Error(`Missing section nav: ${label}`);
  (item.props.onClick as () => void)();
}
function knowledgePicker(tree: Element[], id: string) {
  const picker = tree.find(
    (node) =>
      node.type === Combobox &&
      (node.props.items as Array<{ id: string }> | undefined)?.some((item) => item.id === id),
  );
  if (!picker) throw new Error('Missing knowledge picker');
  return picker;
}

/** 渲染单个选项：ComboboxList 的 children 是 (option) => ReactNode 的渲染函数。 */
function renderOption(picker: Element, option: { id: string }) {
  const list = elements(picker.props.children).find((node) => node.type === ComboboxList);
  const render = list?.props.children;
  if (typeof render !== 'function') throw new Error('Missing ComboboxList render function');
  return elements((render as (value: unknown) => ReactNode)(option))[0];
}

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

describe('expert knowledge binding', () => {
  it('offers knowledge bases the generic server list filters out', () => {
    inspect(agentWith(['server']), (tree, pass) => {
      if (pass === 0) {
        selectSection(tree, '能力');
        return;
      }
      const picker = knowledgePicker(tree, 'server-kb-active');
      const items = picker.props.items as Array<{ id: string; label: string }>;
      expect(items.map((item) => item.id)).toEqual(['server-kb-active', 'server-kb-disabled']);
      expect(items.map((item) => item.label)).toEqual(['产品手册', '归档库']);
    });
  });

  it('keeps an existing binding to a disabled base selectable', () => {
    inspect(agentWith(['server', 'server-kb-disabled']), (tree, pass) => {
      if (pass === 0) {
        selectSection(tree, '能力');
        return;
      }
      const picker = knowledgePicker(tree, 'server-kb-disabled');
      expect((picker.props.value as Array<{ id: string }>).map((item) => item.id)).toEqual([
        'server-kb-disabled',
      ]);
      const items = picker.props.items as Array<{ id: string }>;
      const bound = items.find((item) => item.id === 'server-kb-disabled');
      const active = items.find((item) => item.id === 'server-kb-active');
      if (!bound || !active) throw new Error('Missing knowledge options');
      // 已绑定的停用库保留可解绑；未绑定的停用库不能再选。
      expect(renderOption(picker, bound).props.disabled).toBe(false);
      expect(renderOption(picker, active).props.disabled).toBe(false);
    });
  });

  it('blocks binding a disabled base that is not bound yet', () => {
    inspect(agentWith(['server']), (tree, pass) => {
      if (pass === 0) {
        selectSection(tree, '能力');
        return;
      }
      const picker = knowledgePicker(tree, 'server-kb-active');
      const items = picker.props.items as Array<{ id: string }>;
      const disabled = items.find((item) => item.id === 'server-kb-disabled');
      if (!disabled) throw new Error('Missing disabled knowledge option');
      expect(renderOption(picker, disabled).props.disabled).toBe(true);
    });
  });

  it('binds a knowledge base without dropping existing connectors', () => {
    inspect(agentWith(['server']), (tree, pass) => {
      if (pass === 0) {
        selectSection(tree, '能力');
        return;
      }
      if (pass === 1) {
        const picker = knowledgePicker(tree, 'server-kb-active');
        const items = picker.props.items as Array<{ id: string }>;
        (picker.props.onValueChange as (picked: unknown[]) => void)([
          items.find((item) => item.id === 'server-kb-active'),
        ]);
        return;
      }
      // 更新后：知识库被选中，普通连接器的绑定仍在。
      const picker = knowledgePicker(tree, 'server-kb-active');
      expect((picker.props.value as Array<{ id: string }>).map((item) => item.id)).toEqual([
        'server-kb-active',
      ]);
      const connector = tree.find(
        (node) =>
          node.type === Combobox &&
          (node.props.items as Array<{ id: string }> | undefined)?.some(
            (item) => item.id === 'server',
          ),
      );
      if (!connector) throw new Error('Missing connector picker');
      expect((connector.props.value as Array<{ id: string }>).map((item) => item.id)).toEqual([
        'server',
      ]);
    });
  });
});
