import { type Agent, agentInputSchema, type Server } from '@agentport/shared';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../src/components/confirm-dialog.js';
import { ApiError, api } from '../src/lib/api.js';
import { AgentEditor } from '../src/pages/agents.js';
import { ServersPage } from '../src/pages/servers.js';
import { SkillsPage } from '../src/pages/skills.js';

const state = vi.hoisted(() => ({
  pending: false,
  mutate: vi.fn(),
  blocker: undefined as { shouldBlockFn: () => boolean; enableBeforeUnload: boolean } | undefined,
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
  Link: 'a',
  useBlocker: (options: typeof state.blocker) => {
    state.blocker = options;
    return { status: 'idle' };
  },
}));
vi.mock('@tanstack/react-query', () => ({ useQueries: () => [], useQueryClient: () => ({}) }));
vi.mock('../src/lib/queries.js', () => {
  const mutation = () => ({ isPending: state.pending, mutate: state.mutate });
  return {
    useAgents: () => ({ data: [] }),
    useSkills: () => ({ data: [] }),
    useServers: () => ({ data: [] }),
    useCreateSkill: mutation,
    useUpdateSkill: mutation,
    useDeleteSkill: mutation,
    useCreateServer: mutation,
    useUpdateServer: mutation,
    useDeleteServer: mutation,
    useTestServer: mutation,
    useImportMcpFile: mutation,
    useImportSkillFile: mutation,
    useCreateTool: mutation,
    useUpdateTool: mutation,
    useDeleteTool: mutation,
    useSetToolEnabled: mutation,
    useTools: () => ({ data: [] }),
    useUpdateAgent: mutation,
  };
});

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [
    node,
    ...elements(node.props.children as ReactNode),
    ...elements(node.props.action as ReactNode),
    ...elements(node.props.actions as ReactNode),
  ];
}
function inspect(render: () => ReactNode, visit: (tree: Element[], pass: number) => void) {
  let pass = 0;
  function Probe() {
    visit(elements(render()), pass++);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
}
function required(tree: Element[], predicate: (node: Element) => boolean) {
  const node = tree.find(predicate);
  if (!node) throw new Error('Missing control');
  return node;
}
function openDialog(page: () => ReactNode, buttonText: string, prop: string): Element {
  let dialog: Element | undefined;
  inspect(page, (tree, pass) => {
    if (pass === 0) {
      const button = required(
        tree,
        (node) => Array.isArray(node.props.children) && node.props.children.includes(buttonText),
      );
      (button.props.onClick as (event: unknown) => void)({ currentTarget: {} });
    } else
      dialog = required(
        tree,
        (node) =>
          node.props[prop] !== undefined &&
          node.props.onClose !== undefined &&
          typeof node.type === 'function',
      );
  });
  if (!dialog) throw new Error('Missing dialog');
  return dialog;
}
function renderDialog(dialog: Element, props = dialog.props) {
  return () => (dialog.type as (props: Record<string, unknown>) => ReactNode)(props);
}
const server: Server = {
  id: 'server',
  name: 'connector',
  description: '',
  kind: 'http',
  url: 'https://example.com/mcp',
  headers: {},
  createdAt: 'v1',
  updatedAt: 'v1',
};
const agent: Agent = {
  ...agentInputSchema.parse({ slug: 'expert', name: 'Expert' }),
  id: 'expert',
  parentId: null,
  createdAt: 'v1',
  updatedAt: 'v1',
};

beforeEach(() => {
  state.pending = false;
  state.blocker = undefined;
  vi.clearAllMocks();
});

describe('resource draft navigation', () => {
  it.each(['skill', 'server', 'tool'] as const)(
    'guards dirty and pending %s forms on navigation and unload',
    (kind) => {
      const page = kind === 'skill' ? SkillsPage : ServersPage;
      const dialog = openDialog(
        page,
        kind === 'skill' ? ' 新建技能' : ' 新建连接器',
        kind === 'skill' ? 'finalFocus' : 'getReturnFocus',
      );
      let render = renderDialog(dialog);
      if (kind === 'tool') {
        // Open the existing tool editor through the page's own dialog contract.
        let tools: Element | undefined;
        inspect(ServersPage, (tree, pass) => {
          if (pass === 0) {
            const button = required(
              tree,
              (node) =>
                Array.isArray(node.props.children) && node.props.children.includes(' 新建连接器'),
            );
            (button.props.onClick as (event: unknown) => void)({ currentTarget: {} });
          } else if (pass === 1) {
            const form = required(tree, (node) => node.props.onSaved !== undefined);
            (form.props.onSaved as (server: Server, created: boolean) => void)(
              {
                ...server,
                kind: 'generated',
                baseUrl: 'https://example.com',
                headers: {},
              } as Server,
              true,
            );
          } else
            tools = required(
              tree,
              (node) =>
                node.props.server !== undefined &&
                node.props.onClose !== undefined &&
                node.props.onSaved === undefined,
            );
        });
        if (!tools) throw new Error('Missing tool editor');
        let toolForm: Element | undefined;
        inspect(renderDialog(tools), (tree) => {
          toolForm = required(tree, (node) => node.props.onDirtyChange !== undefined);
        });
        if (!toolForm) throw new Error('Missing tool form');
        render = renderDialog(toolForm);
      }
      inspect(render, (tree, pass) => {
        if (pass === 0 && kind === 'server') {
          const select = required(tree, (node) => node.props['aria-label'] === '来源类型');
          (select.props.onValueChange as (values: string[]) => void)(['http']);
        } else if (pass === 0 || (pass === 1 && kind === 'server')) {
          const input = required(
            tree,
            (node) =>
              typeof node.props.onChange === 'function' && typeof node.props.value === 'string',
          );
          (input.props.onChange as (event: unknown) => void)({ target: { value: 'unsaved' } });
        } else {
          expect(state.blocker?.shouldBlockFn()).toBe(true);
          expect(state.blocker?.enableBeforeUnload).toBe(true);
        }
      });
      state.pending = true;
      inspect(render, () => {
        expect(state.blocker?.shouldBlockFn()).toBe(true);
        expect(state.blocker?.enableBeforeUnload).toBe(true);
      });
    },
  );
});

describe('conflict recovery', () => {
  it.each(['agent', 'server'] as const)(
    'retains %s draft and requires confirmation before fetching a replacement',
    async (kind) => {
      const reload = vi.spyOn(api, kind === 'agent' ? 'agents' : 'servers').mockResolvedValue([]);
      let request: (() => Promise<void>) | undefined;
      state.mutate.mockImplementationOnce((_input, callbacks) =>
        callbacks.onError(new ApiError(409, 'Changed')),
      );
      const dialog =
        kind === 'server' ? openDialog(ServersPage, ' 新建连接器', 'getReturnFocus') : undefined;
      const render = dialog
        ? renderDialog(dialog, { ...dialog.props, server })
        : () => AgentEditor({ agent, onDelete() {}, onDirtyChange() {}, onPendingChange() {} });
      inspect(render, (tree, pass) => {
        if (pass === 0) {
          const name = required(
            tree,
            (node) => node.props.id === (kind === 'agent' ? 'agent-name' : 'server-name'),
          );
          (name.props.onChange as (event: unknown) => void)({ target: { value: 'my-draft' } });
        } else if (pass === 1) {
          (
            required(tree, (node) => node.type === 'form').props.onSubmit as (
              event: unknown,
            ) => void
          )({ preventDefault() {} });
        } else if (pass === 2) {
          expect(reload).not.toHaveBeenCalled();
          expect(state.mutate.mock.calls[0]?.[0].expectedUpdatedAt).toBe('v1');
          const button = required(tree, (node) => node.props.children === '加载最新配置');
          (button.props.onClick as () => void)();
        } else {
          const confirmation = required(
            tree,
            (node) =>
              node.type === ConfirmDialog && node.props.title === '放弃草稿并加载最新配置？',
          );
          expect(confirmation.props.open).toBe(true);
          expect(confirmation.props.description).toContain('丢失');
          request = confirmation.props.onConfirm as () => Promise<void>;
        }
      });
      expect(reload).not.toHaveBeenCalled();
      await request?.();
      expect(reload).toHaveBeenCalledOnce();
      reload.mockRestore();
    },
  );
});
