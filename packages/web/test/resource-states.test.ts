import { type Agent, type ApiTool, agentInputSchema, type Server } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorState } from '../src/components/states.js';
import { Combobox } from '../src/components/ui/combobox.js';
import { Field } from '../src/components/ui/field.js';
import { Input } from '../src/components/ui/input.js';
import { Select } from '../src/components/ui/select.js';
import { Switch } from '../src/components/ui/switch.js';
import { Textarea } from '../src/components/ui/textarea.js';
import { AgentEditor, AgentsPage } from '../src/pages/agents.js';
import { ServersPage } from '../src/pages/servers.js';

vi.mock('@/components/ui/toggle', () => import('../src/components/ui/toggle.js'));
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

const state = vi.hoisted(() => ({ saving: false }));
vi.mock('../src/lib/queries.js', async (original) => {
  const queries = await original<typeof import('../src/lib/queries.js')>();
  return {
    ...queries,
    useUpdateAgent: () => ({ ...queries.useUpdateAgent(), isPending: state.saving }),
  };
});

const agent: Agent = {
  ...agentInputSchema.parse({ slug: 'expert', name: 'Expert' }),
  id: 'expert',
  parentId: null,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  serverIds: ['server'],
  skillIds: ['skill'],
  subAgentIds: ['child'],
};
const server: Server = {
  id: 'server',
  name: 'connector',
  description: '',
  kind: 'generated',
  baseUrl: 'https://example.com',
  headers: {},
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};
const tool: ApiTool = {
  id: 'tool',
  serverId: server.id,
  name: 'list-users',
  description: '',
  method: 'GET',
  pathTemplate: '/users',
  inputSchema: {},
  paramsIn: 'query',
  requiresApproval: false,
  enabled: true,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [
    node,
    ...elements(node.props.children as ReactNode),
    ...elements(node.props.actions as ReactNode),
    ...elements(node.props.action as ReactNode),
  ];
}

const clients: QueryClient[] = [];
function client() {
  const result = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } },
  });
  result.setQueryData(['agents'], [agent, { ...agent, id: 'child', parentId: agent.id }]);
  result.setQueryData(['servers'], [server]);
  result.setQueryData(
    ['skills'],
    [{ id: 'skill', slug: 'skill', name: 'Skill', description: '', body: '' }],
  );
  result.setQueryData(['tools', server.id], [tool]);
  clients.push(result);
  return result;
}

// React owns state and rerenders; inspect the page's public control/event contracts without a DOM.
function inspect(
  queryClient: QueryClient,
  render: () => ReactNode,
  visit: (tree: Element[], pass: number) => void,
) {
  let pass = 0;
  function Probe() {
    visit(elements(render()), pass++);
    return null;
  }
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)),
  );
}
function editor() {
  return AgentEditor({
    agent,
    onDelete: () => {},
    onDirtyChange: () => {},
    onPendingChange: () => {},
  });
}
// 三栏布局一次只挂载一个分区：探针先点中栏的分区按钮把它切出来。
function selectSection(tree: Element[], label: string) {
  const item = tree.find(
    (node) => typeof node.props.onClick === 'function' && flatText(node).includes(label),
  );
  if (!item) throw new Error(`Missing section nav: ${label}`);
  (item.props.onClick as () => void)();
}
function flatText(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(flatText).join(' ');
  if (typeof node === 'string') return node;
  if (isValidElement<Record<string, unknown>>(node))
    return flatText(node.props.children as ReactNode);
  return '';
}
function required(tree: Element[], predicate: (node: Element) => boolean): Element {
  const found = tree.find(predicate);
  if (!found) throw new Error('Missing expected control');
  return found;
}
function text(tree: Element[]) {
  return tree
    .flatMap((node) =>
      Array.isArray(node.props.children) ? node.props.children : [node.props.children],
    )
    .filter((child) => typeof child === 'string')
    .join(' ');
}

afterEach(() => {
  for (const queryClient of clients.splice(0)) queryClient.clear();
  state.saving = false;
  vi.restoreAllMocks();
});

describe('resource async state regressions', () => {
  it.each([false, true])(
    'blocks every competing editor entry during import (empty list: %s)',
    (empty) => {
      const queryClient = client();
      if (empty) queryClient.setQueryData(['agents'], []);
      inspect(queryClient, AgentsPage, (tree, pass) => {
        if (pass === 0) {
          const upload = required(
            tree,
            (node) => node.type === 'input' && node.props.type === 'file',
          );
          (upload.props.onChange as (event: unknown) => void)({
            target: {
              files: [{ name: 'expert.json', size: 10, text: () => new Promise(() => {}) }],
              value: '',
            },
          });
          return;
        }
        const entries = tree.filter(
          (node) =>
            node.props.children === '配置' ||
            node.props['aria-label'] === '新建专家' ||
            (Array.isArray(node.props.children) && node.props.children.includes(' 新建专家')),
        );
        expect(entries.length).toBeGreaterThan(0);
        expect(entries.every((node) => node.props.disabled === true)).toBe(true);
      });
    },
  );

  it('disables expert fields, bindings, permissions, and enabled state while saving', () => {
    const queryClient = client();
    state.saving = true;
    const seen = { capability: 0, permissions: 0 };
    inspect(queryClient, editor, (tree, pass) => {
      if (pass === 0) {
        const enabled = required(tree, (node) => node.type === Switch);
        expect(enabled.props.disabled).toBe(true);
        selectSection(tree, '能力');
        return;
      }
      if (pass === 1) {
        const controls = tree.filter((node) =>
          [Input, Textarea, Select, Combobox].includes(node.type as typeof Input),
        );
        expect(controls.length).toBeGreaterThanOrEqual(3);
        expect(controls.every((node) => node.props.disabled === true)).toBe(true);
        seen.capability = controls.length;
        selectSection(tree, '权限');
        return;
      }
      const controls = tree.filter((node) =>
        [Input, Textarea, Select].includes(node.type as typeof Input),
      );
      expect(controls.length).toBeGreaterThan(0);
      expect(controls.every((node) => node.props.disabled === true)).toBe(true);
      seen.permissions = controls.length;
      expect(
        tree
          .filter((node) => node.type === Field)
          .every(
            (node) =>
              node.props['data-disabled'] === true || node.props['data-disabled'] === 'true',
          ),
      ).toBe(true);
      const permissions = tree.filter((node) => node.props['aria-pressed'] !== undefined);
      expect(permissions.length).toBeGreaterThan(0);
      expect(permissions.every((node) => node.props.disabled === true)).toBe(true);
    });
    expect(seen.capability + seen.permissions).toBeGreaterThanOrEqual(5);
  });

  it.each([
    ['tools', 'pending', false],
    ['tools', 'error', false],
    ['tools', 'error', true],
    ['servers', 'pending', false],
    ['servers', 'error', false],
  ] as const)(
    'does not count unavailable %s as zero (%s, cached: %s)',
    async (source, status, cached) => {
      const queryClient = client();
      const queryKey = source === 'tools' ? ['tools', server.id] : ['servers'];
      queryClient
        .getQueryCache()
        .find({ queryKey })
        ?.setState({
          status,
          ...(cached ? {} : { data: undefined }),
          error: status === 'error' ? new Error('Resources unavailable') : null,
        });
      let retry: (() => void) | undefined;
      inspect(queryClient, editor, (tree, pass) => {
        if (pass === 0) {
          selectSection(tree, '能力');
          return;
        }
        expect(text(tree)).not.toContain('将获得 0 个工具');
        expect(text(tree)).toContain(status === 'error' ? '工具数量未知' : '工具数量加载中');
        if (status === 'error')
          retry = required(tree, (node) => node.type === ErrorState).props.onRetry as () => void;
      });
      if (retry) {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          Response.json(source === 'tools' ? [tool] : [server]),
        );
        retry();
        await vi.waitFor(() => expect(queryClient.getQueryState(queryKey)?.status).toBe('success'));
        inspect(queryClient, editor, (tree, pass) => {
          if (pass === 0) {
            selectSection(tree, '能力');
            return;
          }
          expect(text(tree)).toContain('将获得 1 个工具');
        });
      }
    },
  );

  it.each(['pending', 'error'] as const)(
    'does not count unavailable server bindings as zero (%s)',
    async (status) => {
      const queryClient = client();
      queryClient
        .getQueryCache()
        .find({ queryKey: ['agents'] })
        ?.setState({
          status,
          data: undefined,
          error: status === 'error' ? new Error('Experts unavailable') : null,
        });
      let retry: (() => void) | undefined;
      inspect(queryClient, ServersPage, (tree) => {
        const card = required(tree, (node) => node.props.server === server);
        expect(card.props.agentCount).toBe(status === 'error' ? '未知' : '加载中…');
        if (status === 'error')
          retry = required(tree, (node) => node.type === ErrorState).props.onRetry as () => void;
      });
      if (retry) {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([agent]));
        retry();
        await vi.waitFor(() =>
          expect(queryClient.getQueryState(['agents'])?.status).toBe('success'),
        );
        inspect(queryClient, ServersPage, (tree) => {
          expect(required(tree, (node) => node.props.server === server).props.agentCount).toBe(1);
        });
      }
    },
  );

  it('locks only the approval checkbox whose tool is being edited', () => {
    const queryClient = client();
    queryClient.setQueryData(['tools', server.id], [tool, { ...tool, id: 'other', name: 'other' }]);
    let dialog: Element | undefined;
    inspect(queryClient, ServersPage, (tree, pass) => {
      if (pass === 0) {
        (
          required(tree, (node) => node.props.server === server).props.onTools as (
            trigger: unknown,
          ) => void
        )({});
      } else
        dialog = required(
          tree,
          (node) => node.props.server === server && node.props.getReturnFocus !== undefined,
        );
    });
    if (!dialog || typeof dialog.type !== 'function') throw new Error('Missing tool dialog');
    const renderDialog = dialog.type as (props: Record<string, unknown>) => ReactNode;
    const props = dialog.props;
    inspect(
      queryClient,
      () => renderDialog(props),
      (tree, pass) => {
        if (pass === 0) {
          (
            required(tree, (node) => node.props['aria-label'] === '编辑工具 list-users').props
              .onClick as () => void
          )();
          return;
        }
        expect(
          required(tree, (node) => node.props['aria-label'] === '批准工具 list-users').props
            .disabled,
        ).toBe(true);
        expect(
          required(tree, (node) => node.props['aria-label'] === '批准工具 other').props.disabled,
        ).toBe(false);
        expect(
          required(tree, (node) => node.props['aria-label'] === '启用工具 list-users').props
            .disabled,
        ).toBe(false);
      },
    );
  });

  it('accepts an empty model through the actual shared schema', () => {
    expect(agentInputSchema.safeParse({ ...agent, model: '' }).success).toBe(true);
  });
});
