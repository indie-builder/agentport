import { type Agent, agentInputSchema, PERMISSIONS, type Server } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  type ComponentProps,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Combobox, ComboboxItem, ComboboxList } from '../src/components/ui/combobox.js';
import { AgentEditor } from '../src/pages/agents/index.js';
import { allAccessMe } from './me-fixture.js';

vi.mock('@/components/ui/button', () => import('../src/components/ui/button.js'));
vi.mock('@/components/ui/input-group', () => import('../src/components/ui/input-group.js'));
vi.mock('@/components/ui/input', () => import('../src/components/ui/input.js'));
vi.mock('@/components/ui/textarea', () => import('../src/components/ui/textarea.js'));
vi.mock('@/components/ui/label', () => import('../src/components/ui/label.js'));
vi.mock('@/components/ui/separator', () => import('../src/components/ui/separator.js'));
vi.mock('@tanstack/react-router', () => ({
  useBlocker: () => ({ status: 'idle' }),
  useNavigate: () => () => {},
  // 这些用例检查配置任务的绑定选择器；概览页有独立用例。
  useSearch: () => ({ tab: 'config' }),
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
    meQuery: {
      queryKey: ['me'],
      queryFn: async () => (await import('./me-fixture.js')).allAccessMe,
    },
    useServers: () => ({ data: mocks.servers, isPending: false, isError: false }),
    useAgentOptions: () => ({
      data: { servers: [], skills: [], plugins: [], runtimeEnvironments: [] },
      isPending: false,
      isError: false,
      refetch: () => {},
    }),
    // 通用 /api/servers 已过滤 knowledge；知识库只能从这里拿到 serverId 绑定。
    useKnowledgeBases: () => ({ data: mocks.bases, isPending: false, isError: false }),
    useSkills: () => ({ data: [], isPending: false, isError: false }),
    useExperts: () => ({ data: mocks.agents, isPending: false, isError: false }),
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
    isDefault: false,
    parentId: null,
    serverIds,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
}

type PickerProps = ComponentProps<typeof Combobox<string, true>>;
type ChangePickerValue = (value: Parameters<NonNullable<PickerProps['onValueChange']>>[0]) => void;
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
  client.setQueryData(['me'], allAccessMe);
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
      permissions: PERMISSIONS.map((permission) => permission.id),
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
function pickerItems(picker: Element): Element[] {
  const list = elements(picker).find((node) => node.type === ComboboxList);
  return elements(list).filter((node) => node.type === ComboboxItem);
}

function knowledgePicker(tree: Element[], id: string) {
  const picker = tree.find(
    (node) => node.type === Combobox && pickerItems(node).some((item) => item.props.value === id),
  );
  if (!picker) throw new Error('Missing knowledge picker');
  return picker;
}

function renderOption(picker: Element, value: string) {
  const item = pickerItems(picker).find((node) => node.props.value === value);
  if (!item) throw new Error(`Missing knowledge option: ${value}`);
  return item;
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
      const items = pickerItems(picker);
      expect(items.map((item) => item.props.value)).toEqual([
        'server-kb-active',
        'server-kb-disabled',
      ]);
      expect(items.map((item) => item.props.label)).toEqual(['产品手册', '归档库']);
    });
  });

  it('keeps an existing binding to a disabled base selectable', () => {
    inspect(agentWith(['server', 'server-kb-disabled']), (tree, pass) => {
      if (pass === 0) {
        selectSection(tree, '能力');
        return;
      }
      const picker = knowledgePicker(tree, 'server-kb-disabled');
      expect(picker.props.value as PickerProps['value']).toEqual(['server-kb-disabled']);
      const bound = renderOption(picker, 'server-kb-disabled');
      const active = renderOption(picker, 'server-kb-active');
      // 已绑定的停用库保留可解绑；未绑定的停用库不能再选。
      expect(bound.props.disabled).toBe(false);
      expect(active.props.disabled).toBe(false);
    });
  });

  it('blocks binding a disabled base that is not bound yet', () => {
    inspect(agentWith(['server']), (tree, pass) => {
      if (pass === 0) {
        selectSection(tree, '能力');
        return;
      }
      const picker = knowledgePicker(tree, 'server-kb-active');
      expect(renderOption(picker, 'server-kb-disabled').props.disabled).toBe(true);
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
        (picker.props.onValueChange as ChangePickerValue)(['server-kb-active']);
        return;
      }
      // 更新后：知识库被选中，普通连接器的绑定仍在。
      const picker = knowledgePicker(tree, 'server-kb-active');
      expect(picker.props.value as PickerProps['value']).toEqual(['server-kb-active']);
      const connector = tree.find(
        (node) =>
          node.type === Combobox && pickerItems(node).some((item) => item.props.value === 'server'),
      );
      if (!connector) throw new Error('Missing connector picker');
      expect(connector.props.value as PickerProps['value']).toEqual(['server']);
    });
  });
});
