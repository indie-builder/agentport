import { type Agent, agentInputSchema, type Server } from '@agentport/shared';
import {
  act,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../src/components/confirm-dialog.js';
import { ResourcePage } from '../src/components/resource-page.js';
import { ApiError, api } from '../src/lib/api.js';
import { AgentEditor } from '../src/pages/agents.js';
import { ServerFormDialog, ServersPage } from '../src/pages/servers.js';
import { SkillsPage } from '../src/pages/skills.js';

const state = vi.hoisted(() => ({
  pending: false,
  mutate: vi.fn(),
  search: {} as Record<string, string>,
  blocker: undefined as { shouldBlockFn: () => boolean; enableBeforeUnload: boolean } | undefined,
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => (options: { search?: (current: Record<string, unknown>) => object }) => {
    Object.assign(state.search, options.search?.(state.search) ?? {});
  },
  useSearch: () => state.search,
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
    useAgentFiles: () => ({
      data: undefined,
      isPending: true,
      isError: false,
      error: null,
      refetch: () => {},
    }),
    useSkills: () => ({ data: [] }),
    useMarketSkills: () => ({
      data: [],
      isPending: false,
      isError: false,
      error: null,
      refetch: () => {},
    }),
    useInstallMarketSkill: mutation,
    useServers: () => ({ data: [] }),
    useKnowledgeBases: () => ({ data: [], isPending: false, isError: false }),
    useRuntimeEnvironments: () => ({
      data: [],
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    }),
    usePlugins: () => ({ data: [], isPending: false, isError: false, status: 'success' }),
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
    ...elements(node.props.filters as ReactNode),
    ...elements(node.props.leadingFilters as ReactNode),
  ];
}
/**
 * 组件按函数直接调用，hook 落在 Probe 上。
 * 表单只由 RHF 驱动后不再有本地 state：visit 在两帧之间运行，返回 true 表示再看下一帧。
 */
async function inspect(
  render: () => ReactNode,
  visit: (tree: Element[], pass: number) => boolean | undefined | Promise<boolean | undefined>,
) {
  const container = document.createElement('div');
  const root = createRoot(container);
  let tree: Element[] = [];
  let rerender: (() => void) | undefined;
  function Probe() {
    const [, setVersion] = useState(0);
    rerender = () => setVersion((version) => version + 1);
    tree = elements(render());
    return null;
  }
  await act(async () => root.render(createElement(Probe)));
  for (let pass = 0; pass < 12; pass += 1) {
    if ((await visit(tree, pass)) !== true) break;
    await act(async () => {
      rerender?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  await act(async () => root.unmount());
  container.remove();
}
function required(tree: Element[], predicate: (node: Element) => boolean) {
  const node = tree.find(predicate);
  if (!node) throw new Error('Missing control');
  return node;
}
async function openDialog(
  page: () => ReactNode,
  buttonText: string,
  prop: string,
): Promise<Element> {
  let dialog: Element | undefined;
  await inspect(page, (tree, pass) => {
    if (pass === 0) {
      const button = required(
        tree,
        (node) => Array.isArray(node.props.children) && node.props.children.includes(buttonText),
      );
      (button.props.onClick as (event: unknown) => void)({ currentTarget: {} });
      return true;
    }
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
  state.search = {};
  state.blocker = undefined;
  vi.clearAllMocks();
});

describe('skills toolbar', () => {
  it('hides market ranking controls only while a market search is active', async () => {
    const rankingCount = async (): Promise<number> => {
      let market: Element | undefined;
      await inspect(SkillsPage, (tree) => {
        market ??= tree.find(
          (node) =>
            typeof node.type === 'function' &&
            (node.type as { name?: string }).name === 'MarketSkillsPage',
        );
      });
      if (!market) throw new Error('Missing market page');
      let count = 0;
      await inspect(
        () => (market.type as (props: Record<string, unknown>) => ReactNode)(market.props),
        (tree) => {
          count = tree.filter((node) => node.props.label === '榜单').length;
        },
      );
      return count;
    };
    state.search = { scope: 'market', marketView: 'trending' };
    expect(await rankingCount()).toBe(1);
    state.search = { scope: 'market', marketView: 'trending', q: 'react' };
    expect(await rankingCount()).toBe(0);
  });
});

describe('resource navigation', () => {
  it.each(['skills', 'servers', 'plugins', 'knowledge'] as const)(
    'renders %s as real navigation links instead of tabs',
    async (section) => {
      await inspect(
        () =>
          ResourcePage({
            section,
            query: '',
            onQueryChange() {},
            sort: 'newest',
            onSortChange() {},
            count: 0,
            status: 'success',
            children: null,
          }),
        (tree) => {
          const nav = tree.find(
            (node) => node.type === 'nav' && node.props['aria-label'] === '资源类型',
          );
          if (!nav) throw new Error('Missing resource navigation');
          const links = elements(nav.props.children as ReactNode).filter(
            (node) => node.type === 'a',
          );
          expect(links.map((node) => [node.props.to, node.props['aria-current']])).toEqual([
            ['/skills', section === 'skills' ? 'page' : undefined],
            ['/servers', section === 'servers' ? 'page' : undefined],
            ['/plugins', section === 'plugins' ? 'page' : undefined],
            ['/knowledge', section === 'knowledge' ? 'page' : undefined],
          ]);
          expect(
            tree.some(
              (node) =>
                node.props.role === 'tab' ||
                node.props.role === 'tablist' ||
                node.props['data-slot'] === 'tabs-list',
            ),
          ).toBe(false);
        },
      );
    },
  );
});

describe('resource toolbar reading order', () => {
  it('keeps navigation, actions, search, filters, sort and count in reading order', async () => {
    const onQueryChange = vi.fn();
    const onAction = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          createElement(ResourcePage, {
            section: 'skills',
            query: '',
            onQueryChange,
            sort: 'newest',
            onSortChange() {},
            count: 2,
            status: 'success',
            leadingFilters: createElement('button', { type: 'button' }, '来源'),
            filters: createElement('button', { type: 'button' }, '使用情况'),
            actions: createElement('button', { type: 'button', onClick: onAction }, '新建'),
            // biome-ignore lint/correctness/noChildrenProp: Required by the component's props type in createElement.
            children: null,
          }),
        );
      });

      const nav = container.querySelector('nav[aria-label="资源类型"]');
      const search = container.querySelector('input[aria-label="搜索技能"]');
      const buttons = [...container.querySelectorAll('button')];
      const source = buttons.find((button) => button.textContent === '来源');
      const usage = buttons.find((button) => button.textContent === '使用情况');
      const sort = container.querySelector('button[aria-label="资源排序"]');
      const action = buttons.find((button) => button.textContent === '新建');
      const count = container.querySelector('[role="status"]');
      const requiredNode = <T extends Element>(node: T | null, name: string): T => {
        if (!node) throw new Error(`Missing ${name} control`);
        return node;
      };
      const navNode = requiredNode(nav, 'nav');
      const searchNode = requiredNode(search, 'search');
      const sourceNode = requiredNode(source, 'source');
      const usageNode = requiredNode(usage, 'usage');
      const sortNode = requiredNode(sort, 'sort');
      const actionNode = requiredNode(action, 'action');
      const countNode = requiredNode(count, 'count');
      const order = (first: Element, second: Element): boolean =>
        Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

      // 阅读与 Tab 顺序：类型导航 → 管理动作 → 来源 → 搜索 → 筛选 → 排序 → 数量。
      expect(order(navNode, actionNode)).toBe(true);
      expect(order(actionNode, sourceNode)).toBe(true);
      expect(order(sourceNode, searchNode)).toBe(true);
      expect(order(searchNode, usageNode)).toBe(true);
      expect(order(usageNode, sortNode)).toBe(true);
      expect(order(sortNode, countNode)).toBe(true);
      expect(container.querySelectorAll('h1')).toHaveLength(1);

      const input = searchNode as HTMLInputElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          input,
          'react',
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(onQueryChange).toHaveBeenCalledWith('react');

      await act(async () => (actionNode as HTMLButtonElement).click());
      expect(onAction).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('renders the market toolbar without a sort control', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          createElement(ResourcePage, {
            section: 'skills',
            query: '',
            onQueryChange() {},
            sort: 'newest',
            onSortChange() {},
            count: 0,
            status: 'success',
            hideSort: true,
            // biome-ignore lint/correctness/noChildrenProp: Required by the component's props type in createElement.
            children: null,
          }),
        );
      });
      expect(container.querySelector('button[aria-label="资源排序"]')).toBeNull();
      expect(container.querySelector('input[aria-label="搜索技能"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe('resource draft navigation', () => {
  it.each(['skill', 'server', 'tool'] as const)(
    'guards dirty and pending %s forms on navigation and unload',
    async (kind) => {
      const page = kind === 'skill' ? SkillsPage : ServersPage;
      const dialog = await openDialog(
        page,
        kind === 'skill' ? ' 新建技能' : ' 新建连接器',
        kind === 'skill' ? 'finalFocus' : 'getReturnFocus',
      );
      let render = renderDialog(dialog);
      if (kind === 'tool') {
        // Open the existing tool editor through the page's own dialog contract.
        let tools: Element | undefined;
        await inspect(ServersPage, (tree, pass) => {
          if (pass === 0) {
            const button = required(
              tree,
              (node) =>
                Array.isArray(node.props.children) && node.props.children.includes(' 新建连接器'),
            );
            (button.props.onClick as (event: unknown) => void)({ currentTarget: {} });
            return true;
          }
          if (pass === 1) {
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
            return true;
          }
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
        await inspect(renderDialog(tools), (tree) => {
          toolForm = required(tree, (node) => node.props.onDirtyChange !== undefined);
        });
        if (!toolForm) throw new Error('Missing tool form');
        render = renderDialog(toolForm);
      }
      await inspect(render, (tree, pass) => {
        if (pass === 0 && kind === 'server') {
          const select = required(tree, (node) => node.props['aria-label'] === '来源类型');
          (select.props.onValueChange as (values: string[]) => void)(['http']);
          return true;
        }
        if (pass === 0 || (pass === 1 && kind === 'server')) {
          const input = required(
            tree,
            (node) =>
              typeof node.props.id === 'string' &&
              node.props.id.startsWith(kind === 'tool' ? 'tool-name-' : `${kind}-name`),
          );
          (input.props.onChange as (event: unknown) => void)({
            target: { name: 'name', value: 'unsaved' },
          });
          return true;
        }
        expect(state.blocker?.shouldBlockFn()).toBe(true);
        expect(state.blocker?.enableBeforeUnload).toBe(true);
      });
      state.pending = true;
      await inspect(render, () => {
        expect(state.blocker?.shouldBlockFn()).toBe(true);
        expect(state.blocker?.enableBeforeUnload).toBe(true);
      });
    },
  );
});

describe('conflict recovery', () => {
  it('retains agent draft and requires confirmation before fetching a replacement', async () => {
    const reload = vi.spyOn(api, 'agents').mockResolvedValue([]);
    let request: (() => Promise<void>) | undefined;
    state.mutate.mockImplementationOnce((_input, callbacks) =>
      callbacks.onError(new ApiError(409, 'Changed')),
    );
    const render = () =>
      AgentEditor({
        agent,
        onDirtyChange() {},
        onPendingChange() {},
        onDeleteRequest() {},
      });
    await inspect(render, async (tree, pass) => {
      if (pass === 0) {
        const name = required(tree, (node) => node.props.id === 'agent-name');
        (name.props.onChange as (event: unknown) => void)({
          target: { name: 'name', value: 'my-draft' },
        });
        return true;
      }
      if (pass === 1) {
        await (
          required(tree, (node) => node.type === 'form').props.onSubmit as (
            event: unknown,
          ) => Promise<void>
        )({ preventDefault() {} });
        return true;
      }
      if (pass === 2) {
        expect(reload).not.toHaveBeenCalled();
        expect(state.mutate.mock.calls[0]?.[0].expectedUpdatedAt).toBe('v1');
        const button = required(tree, (node) => node.props.children === '加载最新配置');
        (button.props.onClick as () => void)();
        return true;
      }
      const confirmation = required(
        tree,
        (node) => node.type === ConfirmDialog && node.props.title === '放弃草稿并加载最新配置？',
      );
      expect(confirmation.props.open).toBe(true);
      expect(confirmation.props.description).toContain('丢失');
      request = confirmation.props.onConfirm as () => Promise<void>;
    });
    expect(reload).not.toHaveBeenCalled();
    await request?.();
    expect(reload).toHaveBeenCalledOnce();
    reload.mockRestore();
  });

  it('retains server draft and requires confirmation before fetching a replacement', async () => {
    const reload = vi.spyOn(api, 'servers').mockResolvedValue([]);
    state.mutate.mockImplementationOnce((_input, callbacks) =>
      callbacks.onError(new ApiError(409, 'Changed')),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(ServerFormDialog, {
          server,
          onClose() {},
          onSaved() {},
          getReturnFocus: () => null,
        }),
      );
    });

    const name = document.querySelector<HTMLInputElement>('#server-name');
    if (!name) throw new Error('Missing server name input');
    const setNativeValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      setNativeValue?.call(name, 'my-draft');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const form = name.closest('form');
    if (!form) throw new Error('Missing server form');
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(state.mutate.mock.calls[0]?.[0].expectedUpdatedAt).toBe('v1');
    expect(reload).not.toHaveBeenCalled();

    const reloadButton = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('加载最新配置'),
    );
    if (!reloadButton) throw new Error('Missing reload button');
    await act(async () => {
      reloadButton.click();
    });

    const confirm = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('放弃并加载'),
    );
    if (!confirm) throw new Error('Missing confirm button');
    expect(document.body.textContent).toContain('放弃草稿并加载最新配置？');
    expect(document.body.textContent).toContain('当前未保存的更改会丢失');
    await act(async () => {
      confirm.click();
    });
    expect(reload).toHaveBeenCalledOnce();

    await act(async () => {
      root.unmount();
    });
    container.remove();
    reload.mockRestore();
  });
});
