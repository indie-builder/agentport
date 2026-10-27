import { act, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PageNote } from '../src/components/page.js';
import { ErrorState, LoadingState } from '../src/components/states.js';
import { Button } from '../src/components/ui/button.js';
import { SkillsPage } from '../src/pages/skills.js';

/** 技能列表的空态、市场就绪门槛与搜索防抖反馈，按页面真实渲染的组件树验证。 */

const state = vi.hoisted(() => ({
  search: {} as Record<string, string | undefined>,
  skills: {} as Record<string, unknown>,
  market: {} as Record<string, unknown>,
  install: {} as Record<string, unknown>,
  refetchSkills: vi.fn(),
  refetchMarket: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => (options: { search?: (current: Record<string, unknown>) => object }) => {
    Object.assign(state.search, options.search?.(state.search) ?? {});
  },
  useSearch: () => state.search,
  Link: 'a',
  useBlocker: () => ({ status: 'idle' }),
}));

vi.mock('../src/lib/queries.js', () => {
  const mutation = () => ({ isPending: false, mutate: vi.fn() });
  return {
    useSkills: () => state.skills,
    useMarketSkills: () => state.market,
    useInstallMarketSkill: () => state.install,
    useCreateSkill: mutation,
    useUpdateSkill: mutation,
    useDeleteSkill: mutation,
    useImportSkillFile: mutation,
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

async function inspect(render: () => ReactNode, visit: (tree: Element[]) => void) {
  const container = document.createElement('div');
  const root = createRoot(container);
  function Probe() {
    visit(elements(render()));
    return null;
  }
  await act(async () => root.render(createElement(Probe)));
  await act(async () => root.unmount());
  container.remove();
}

function required(tree: Element[], predicate: (node: Element) => boolean) {
  const node = tree.find(predicate);
  if (!node) throw new Error('Missing expected element');
  return node;
}
// 市场页是 SkillsPage 的子组件，直接调用不会展开；按页面返回的 props 再挂一次。
async function inspectMarket(visit: (tree: Element[]) => void) {
  let market: Element | undefined;
  await inspect(SkillsPage, (tree) => {
    market = required(
      tree,
      (node) => typeof node.type === 'function' && node.type.name === 'MarketSkillsPage',
    );
  });
  if (!market) throw new Error('Missing market page');
  const marketElement = market;
  await inspect(
    () =>
      (marketElement.type as (props: Record<string, unknown>) => ReactNode)(marketElement.props),
    visit,
  );
}
function installButtons(tree: Element[]) {
  return tree.filter(
    (node) =>
      node.type === Button &&
      typeof node.props['aria-label'] === 'string' &&
      node.props['aria-label'].includes('安装'),
  );
}
function marketItem(id: string) {
  return {
    id,
    source: id.split('/').slice(0, 2).join('/'),
    slug: 'pdf',
    name: 'PDF',
    installs: 10,
  };
}

beforeEach(() => {
  state.search = {};
  state.skills = {
    data: [],
    status: 'success',
    isPending: false,
    isError: false,
    error: null,
    refetch: state.refetchSkills,
  };
  state.market = {
    data: [],
    status: 'success',
    isPending: false,
    isDebouncing: false,
    isError: false,
    error: null,
    refetch: state.refetchMarket,
  };
  state.install = { isPending: false, variables: undefined, mutate: vi.fn() };
  state.refetchSkills.mockClear();
  state.refetchMarket.mockClear();
  vi.clearAllMocks();
});

describe('internal skill library empty state', () => {
  it('points to the market instead of restating that the list is empty', async () => {
    await inspect(SkillsPage, (tree) => {
      const note = required(
        tree,
        (node) => node.type === PageNote && node.props.title === '技能库为空',
      );
      expect(String(note.props.title)).not.toContain('暂无');
      const action = required(
        elements(note.props.action as ReactNode),
        (node) => node.type === Button && node.props.children === '前往市场',
      );
      (action.props.onClick as () => void)();
    });
    expect(state.search.scope).toBe('market');
  });

  it('keeps the clear-filters note when only the filter result is empty', async () => {
    state.skills = {
      ...state.skills,
      data: [
        {
          id: 'skill',
          slug: 'demo',
          name: 'Demo',
          description: '',
          body: '',
          sourceId: null,
          agentCount: 0,
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
        },
      ],
    };
    state.search = { q: 'nomatch', usage: 'bound' };
    await inspect(SkillsPage, (tree) => {
      expect(tree.some((node) => node.type === PageNote && node.props.title === '技能库为空')).toBe(
        false,
      );
      expect(
        tree.some((node) => node.type === PageNote && node.props.title === '没有匹配的技能'),
      ).toBe(true);
    });
  });
});

describe('market readiness', () => {
  beforeEach(() => {
    state.search = { scope: 'market' };
    state.market = {
      ...state.market,
      data: [marketItem('owner/repo/pdf')],
      status: 'success',
    };
  });

  it('does not render cards or install actions while installed skills are pending', async () => {
    state.skills = {
      ...state.skills,
      data: undefined,
      status: 'pending',
      isPending: true,
    };
    await inspect(SkillsPage, (tree) => {
      // 安装生命周期由常驻的 SkillsPage 持有并下传，市场页卸载后仍在。
      const market = required(
        tree,
        (node) => typeof node.type === 'function' && node.type.name === 'MarketSkillsPage',
      );
      expect(market.props.install).toBe(state.install);
    });
    await inspectMarket((tree) => {
      expect(tree.some((node) => node.type === LoadingState)).toBe(true);
      expect(installButtons(tree)).toHaveLength(0);
      expect(tree.some((node) => node.type === PageNote && node.props.title === '榜单为空')).toBe(
        false,
      );
    });
  });

  it('retries the installed-skills query on error and stays without install actions', async () => {
    state.skills = {
      ...state.skills,
      data: undefined,
      status: 'error',
      isError: true,
      error: new Error('Skills unavailable'),
    };
    await inspectMarket((tree) => {
      const error = required(tree, (node) => node.type === ErrorState);
      expect(installButtons(tree)).toHaveLength(0);
      (error.props.onRetry as () => void)();
    });
    expect(state.refetchSkills).toHaveBeenCalledOnce();
  });

  it('replaces the stale list with loading while the search term is debouncing', async () => {
    state.market = { ...state.market, isDebouncing: true, status: 'pending' };
    await inspectMarket((tree) => {
      expect(tree.some((node) => node.type === LoadingState)).toBe(true);
      expect(installButtons(tree)).toHaveLength(0);
      expect(
        tree.some((node) => node.type === PageNote && node.props.title === '没有匹配的技能'),
      ).toBe(false);
    });
  });

  it('marks only the installing card as pending and blocks the rest', async () => {
    state.install = { isPending: true, variables: { id: 'owner/repo/pdf' }, mutate: vi.fn() };
    await inspectMarket((tree) => {
      const buttons = installButtons(tree);
      expect(buttons).toHaveLength(1);
      expect(buttons[0]?.props.disabled).toBe(true);
      expect(buttons[0]?.props['aria-busy']).toBe(true);
      expect(buttons[0]?.props.children).toBe('安装中…');
    });
  });

  it('treats an installed skill as done from the real installed set', async () => {
    state.skills = {
      ...state.skills,
      data: [{ id: 'skill', sourceId: 'owner/repo/pdf', agentCount: 0, name: 'PDF' }],
    };
    await inspectMarket((tree) => {
      const button = required(tree, (node) => installButtons([node]).length === 1);
      expect(button.props.disabled).toBe(true);
      expect(button.props.children).toBe('已安装');
    });
  });

  it('offers a refresh action when the empty ranking is not a failed search', async () => {
    state.market = { ...state.market, data: [] };
    await inspectMarket((tree) => {
      const note = required(
        tree,
        (node) => node.type === PageNote && node.props.title === '榜单为空',
      );
      const action = required(
        elements(note.props.action as ReactNode),
        (node) => node.type === Button && node.props.children === '刷新榜单',
      );
      (action.props.onClick as () => void)();
    });
    expect(state.refetchMarket).toHaveBeenCalledOnce();
  });
});
