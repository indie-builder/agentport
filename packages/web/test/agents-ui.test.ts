import { type Agent, PERMISSIONS } from '@agentport/shared';
import {
  act,
  type ComponentProps,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../src/components/confirm-dialog.js';
import { PageHeader } from '../src/components/page.js';
import { ErrorState, LoadingState } from '../src/components/states.js';
import { Combobox, ComboboxItem, ComboboxList } from '../src/components/ui/combobox.js';
import { DropdownMenuTrigger } from '../src/components/ui/dropdown-menu.js';
import { Field, FieldDescription } from '../src/components/ui/field.js';
import { NumberInput, NumberInputControl } from '../src/components/ui/number-input.js';
import { Select, SelectItem } from '../src/components/ui/select.js';
import { Tabs } from '../src/components/ui/tabs.js';
import { AgentDetailPage } from '../src/pages/agents/agent-detail-page.js';
import { AgentEditor } from '../src/pages/agents/agent-editor.js';
import { AgentsPage } from '../src/pages/agents/agents-page.js';
import { VersionHistory } from '../src/pages/agents/version-history.js';

const TEST_PERMISSIONS = PERMISSIONS.map((permission) => permission.id);

vi.mock('../src/lib/toast.js', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/components/ui/button', () => import('../src/components/ui/button.js'));
vi.mock('@/components/ui/input-group', () => import('../src/components/ui/input-group.js'));
vi.mock('@/components/ui/input', () => import('../src/components/ui/input.js'));
vi.mock('@/components/ui/textarea', () => import('../src/components/ui/textarea.js'));
vi.mock('@/components/ui/label', () => import('../src/components/ui/label.js'));
vi.mock('@/components/ui/separator', () => import('../src/components/ui/separator.js'));

const state = vi.hoisted(() => ({
  agents: [] as Agent[],
  saving: false,
  skillsError: false,
  servers: [] as Array<{
    id: string;
    name: string;
    kind: string;
    url: string;
    headers: Record<string, string>;
  }>,
  knowledgeBases: [] as Array<{
    id: string;
    serverId: string;
    name: string;
    slug: string;
    status: string;
    updatedAt: string;
  }>,
  runtimeEnvironments: [] as Array<{ id: string; name: string; isDefault?: boolean }>,
  runtimeEnvironmentsError: false,
  runtimeEnvironmentsRetry: vi.fn(),
  agentsPending: false,
  agentsError: false,
  agentsRetry: vi.fn(),
  detail: {} as { isPending: boolean; isError: boolean; data?: unknown },
  rollback: vi.fn(),
  retry: vi.fn(),
  mutate: vi.fn(),
  search: {} as Record<string, string | undefined>,
  me: undefined as unknown,
}));
vi.mock('../src/lib/queries.js', () => ({
  useDrainPages: () => {},
  meQuery: {
    queryKey: ['me'],
    queryFn: async () => (await import('./me-fixture.js')).allAccessMe,
  },
  ...(() => {
    const experts = () => ({
      data: state.agents.filter((agent) => !agent.isDefault),
      isPending: state.agentsPending,
      isError: state.agentsError,
      error: new Error('Agents unavailable'),
      refetch: state.agentsRetry,
    });
    return { useExperts: experts, useAgentsBrowse: experts };
  })(),
  useAgentOptions: () => ({
    data: { servers: [], skills: [], plugins: [], runtimeEnvironments: [] },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }),
  agentDetailQuery: (id: string) => ({
    queryKey: ['agent-detail', id],
    queryFn: async () => null,
    enabled: false,
  }),
  useAgentSummary: () => ({ data: state.agents[0] ?? null, isPending: false, isError: false }),
  useAgentDetail: () => ({ data: state.agents[0] ?? null, isPending: false, isError: false }),
  useAgentAccess: () => ({
    data: {
      agentId: state.agents[0]?.id ?? 'parent',
      permissionIds: PERMISSIONS.map((permission) => permission.id),
    },
    isPending: false,
    isError: false,
  }),
  useServers: () => ({ data: state.servers }),
  useKnowledgeBases: () => ({ data: state.knowledgeBases, isPending: false, isError: false }),
  useRuntimeEnvironments: () => ({
    data: state.runtimeEnvironments,
    isPending: false,
    isError: state.runtimeEnvironmentsError,
    error: new Error('Runtime environments unavailable'),
    refetch: state.runtimeEnvironmentsRetry,
  }),
  usePlugins: () => ({ data: [], isPending: false, isError: false, status: 'success' }),
  useSkills: () => ({
    isError: state.skillsError,
    error: new Error('Skills unavailable'),
    refetch: state.retry,
  }),
  useUpdateAgent: () => ({ isPending: state.saving, mutate: state.mutate }),
  useCreateAgent: () => ({ isPending: false, mutate: vi.fn() }),
  useDuplicateAgent: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteAgent: () => ({ mutateAsync: vi.fn() }),
  useAgentTags: () => ({ data: { items: [] }, isPending: false, isError: false }),
  useSetAgentFavorite: () => ({ mutate: vi.fn(), isPending: false }),
  useArchiveAgent: () => ({ mutate: vi.fn(), isPending: false }),
  useRestoreAgent: () => ({ mutate: vi.fn(), isPending: false }),
  useAgentVersions: () => ({
    data: [{ id: 'v1', version: 1, note: null, createdAt: '2026-01-01' }],
  }),
  useAgentVersion: () => ({
    ...state.detail,
    error: new Error('Version unavailable'),
    refetch: state.retry,
  }),
  useRollbackAgent: () => ({ mutateAsync: state.rollback }),
  usePublishAgent: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useOfflineAgent: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useTrialAgent: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useStartEvalRun: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useAgentFiles: () => ({
    data: undefined,
    isPending: true,
    isError: false,
    error: null,
    refetch: () => {},
  }),
  useRuns: () => ({ data: { items: [] }, isPending: false, isError: false, error: null }),
  agentMemoryOverviewQuery: (id: string) => ({ queryKey: ['agent-memory-overview', id] }),
  agentRulesQuery: (id: string) => ({ queryKey: ['agent-rules', id] }),
  agentOutputStylesQuery: (id: string) => ({ queryKey: ['agent-output-styles', id] }),
}));
vi.mock('@tanstack/react-query', async () => {
  const { allAccessMe } = await import('./me-fixture.js');
  return {
    useQueries: () => [],
    useQueryClient: () => ({}),
    useQuery: () => ({
      data: state.me ?? allAccessMe,
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    }),
  };
});
vi.mock('@tanstack/react-router', () => ({
  Link: 'a',
  useBlocker: () => ({ status: 'idle', proceed: vi.fn(), reset: vi.fn() }),
  useNavigate: () => (options: { search?: (current: Record<string, unknown>) => object }) => {
    // 真实 router 把回调返回值整体作为新 search，这里保持一致以暴露过期闭包。
    state.search = { ...(options.search?.(state.search) ?? {}) };
  },
  useSearch: () => state.search,
  useParams: () => ({ agentId: state.agents[0]?.id ?? 'parent' }),
  useLocation: () => ({ state: undefined }),
}));

const parent = {
  id: 'parent',
  slug: 'parent',
  name: 'Parent',
  description: '',
  model: 'test',
  role: '',
  systemPrompt: '',
  serverIds: [],
  skillIds: [],
  pluginBindings: [],
  subAgentIds: ['child'],
  allowedTools: [],
  disallowedTools: [],
  permissionMode: 'dontAsk',
  uiFormat: 'markdown',
  maxTurns: 20,
  maxBudgetUsd: 2,
  monthlyBudgetUsd: null,
  budgetAlertRatio: 0.8,
  timeoutMs: 600_000,
  enabled: true,
  visibility: 'private',
  tags: [],
  createdBy: 'parent',
  ownerBusinessId: 'parent',
  isDefault: false,
  parentId: null,
  runtimeEnvironmentId: null,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
} as Agent;

type PickerProps = ComponentProps<typeof Combobox<string, true>>;
type ChangePickerValue = (value: Parameters<NonNullable<PickerProps['onValueChange']>>[0]) => void;
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function pickerValues(picker: Element): string[] {
  const list = elements(picker).find((node) => node.type === ComboboxList);
  return elements(list).flatMap((node) => {
    if (node.type !== ComboboxItem) return [];
    if (typeof node.props.value !== 'string') throw new Error('Missing picker option value');
    return [node.props.value];
  });
}
function findPicker(tree: Element[], value: string): Element | undefined {
  return tree.find((node) => node.type === Combobox && pickerValues(node).includes(value));
}

async function inspect(
  render: () => ReactNode,
  visit: (tree: Element[], pass: number) => boolean | undefined | Promise<boolean | undefined>,
) {
  const container = document.createElement('div');
  document.body.append(container);
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
function editor() {
  return AgentEditor({
    agent: parent,
    permissions: TEST_PERMISSIONS,
    onDirtyChange: () => {},
    onPendingChange: () => {},
    onDeleteRequest: () => {},
  });
}
function selectSection(tree: Element[], label: string) {
  const item = tree.find(
    (node) =>
      typeof node.props.onClick === 'function' &&
      flatText(node.props.children as ReactNode).includes(label),
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

function changeNumberField(tree: Element[], id: string, value: number): void {
  const field = tree.find(
    (node) => node.type === NumberInput && elements(node).some((child) => child.props.id === id),
  );
  if (!field) throw new Error(`Missing number field ${id}`);
  (field.props.onValueChange as (value: number | null) => void)(value);
}

beforeEach(() => {
  state.agents = [
    parent,
    { ...parent, id: 'child', name: 'Bound child', parentId: 'parent', subAgentIds: [] },
    { ...parent, id: 'free', name: 'Available', subAgentIds: [] },
    { ...parent, id: 'other-child', parentId: 'other', subAgentIds: [] },
  ];
  state.saving = false;
  state.skillsError = false;
  state.servers = [];
  state.knowledgeBases = [];
  state.runtimeEnvironments = [];
  state.runtimeEnvironmentsError = false;
  state.agentsPending = false;
  state.agentsError = false;
  state.detail = { isPending: false, isError: false };
  state.search = { tab: 'config' };
  state.me = undefined;
  vi.clearAllMocks();
});

describe('agents import permission gate', () => {
  it('hides the import action without agents.import', async () => {
    const { allAccessMe } = await import('./me-fixture.js');
    state.me = {
      ...allAccessMe,
      grants: allAccessMe.grants.filter((grant) => grant.permissionId !== 'agents.import'),
    };
    await inspect(AgentsPage, (tree) => {
      const header = tree.find((node) => node.type === PageHeader);
      const importItem = elements(header?.props.actions as ReactNode).find(
        (node) => node.props.title === '导入专家 ZIP 或 agent.md',
      );
      expect(importItem).toBeUndefined();
    });
    state.me = undefined;
    await inspect(AgentsPage, (tree) => {
      const header = tree.find((node) => node.type === PageHeader);
      const importItem = elements(header?.props.actions as ReactNode).find(
        (node) => node.props.title === '导入专家 ZIP 或 agent.md',
      );
      expect(importItem).toBeDefined();
    });
  });
});

describe('expert editor regressions', () => {
  it('shows a role for experts with a blank historical role', async () => {
    await inspect(AgentsPage, (tree) => {
      expect(flatText(tree.map((node) => node.props.children) as ReactNode)).toContain('通用助手');
    });
    await inspect(AgentDetailPage, (tree) => {
      const header = tree.find((node) => node.type === PageHeader);
      expect(flatText(header?.props.eyebrow as ReactNode)).toBe('通用助手');
    });
  });

  it('keeps a legacy role visible until the user selects a standard occupation', async () => {
    const legacy = { ...parent, role: '历史顾问' };
    await inspect(
      () =>
        AgentEditor({
          agent: legacy,
          permissions: TEST_PERMISSIONS,
          onDirtyChange() {},
          onPendingChange() {},
          onDeleteRequest() {},
        }),
      async (tree, pass) => {
        const picker = tree.find(
          (node) =>
            node.type === Select && elements(node).some((child) => child.props.id === 'agent-role'),
        );
        if (!picker) throw new Error('Missing role picker');
        if (pass === 0) {
          expect(picker.props.value).toBe('历史顾问');
          expect(
            tree.find((node) => node.type === SelectItem && node.props.value === '历史顾问')?.props
              .disabled,
          ).toBe(true);
          (picker.props.onValueChange as (value: string) => void)('测试工程师');
          return true;
        }
        const form = tree.find((node) => node.type === 'form');
        if (!form) throw new Error('Missing editor form');
        await (form.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {} });
        expect(state.mutate.mock.calls[0]?.[0]).toMatchObject({
          input: { role: '测试工程师' },
        });
      },
    );
  });

  it('uses the working background field for an existing digital twin', async () => {
    await inspect(
      () =>
        AgentEditor({
          agent: { ...parent, role: '数字分身' },
          permissions: TEST_PERMISSIONS,
          onDirtyChange() {},
          onPendingChange() {},
          onDeleteRequest() {},
        }),
      (tree, pass) => {
        if (pass === 0) {
          selectSection(tree, '行为');
          return;
        }
        const label = tree.find((node) => node.props.htmlFor === 'agent-prompt');
        expect(flatText(label?.props.children as ReactNode)).toBe('工作背景与表达方式');
      },
    );
  });

  it('keeps unparseable tool text as the draft and blocks saving', async () => {
    await inspect(editor, async (tree, pass) => {
      if (pass === 0) {
        selectSection(tree, '权限');
        return true;
      }
      if (pass === 1) {
        const allowed = tree.find((node) => node.props.id === 'agent-allowed-tools');
        if (!allowed) throw new Error('Missing allowed tools field');
        (allowed.props.onChange as (event: unknown) => void)({
          target: { name: 'allowedTools', value: 'mcp__crm__get user' },
        });
        return true;
      }
      if (pass === 2) {
        selectSection(tree, '运行限制');
        return true;
      }
      if (pass === 3) {
        const form = tree.find((node) => node.type === 'form');
        if (!form) throw new Error('Missing editor form');
        await (form.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {} });
        expect(state.mutate).not.toHaveBeenCalled();
        return true;
      }
      const allowed = tree.find((node) => node.props.id === 'agent-allowed-tools');
      expect(allowed?.props['aria-invalid']).toBe(true);
    });
  });

  it('keeps the draft timestamp when background refetch changes the expert', async () => {
    let current = parent;
    await inspect(
      () =>
        AgentEditor({
          agent: current,
          permissions: TEST_PERMISSIONS,
          onDirtyChange() {},
          onPendingChange() {},
          onDeleteRequest() {},
        }),
      async (tree, pass) => {
        if (pass === 0) {
          current = { ...parent, name: 'Someone else', updatedAt: '2026-02-01' };
          const name = tree.find((node) => node.props.id === 'agent-name');
          if (!name) throw new Error('Missing name field');
          (name.props.onChange as (event: unknown) => void)({
            target: { name: 'name', value: 'My draft' },
          });
          return true;
        }
        const form = tree.find((node) => node.type === 'form');
        if (!form) throw new Error('Missing form');
        // eslint-disable-next-line no-console
        await (form.props.onSubmit as (event: unknown) => Promise<void>)({
          preventDefault() {},
        });
        expect(state.mutate.mock.calls[0]?.[0]).toMatchObject({
          input: { name: 'My draft' },
          expectedUpdatedAt: '2026-01-01',
        });
        return false;
      },
    );
  });

  it('advances the baseline only to the successfully saved response', async () => {
    state.mutate.mockImplementationOnce((input, callbacks) => {
      callbacks.onSuccess({ ...parent, name: input.input.name, updatedAt: '2026-03-01' });
    });
    await inspect(editor, (tree, pass) => {
      const name = tree.find((node) => node.props.id === 'agent-name');
      const form = tree.find((node) => node.type === 'form');
      if (!name || !form) throw new Error('Missing editor fields');
      if (pass === 0 || pass === 2) {
        (name.props.onChange as (event: unknown) => void)({
          target: { name: 'name', value: pass === 0 ? 'First draft' : 'Second draft' },
        });
      } else if (pass === 1 || pass === 3) {
        (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
      }
      if (pass === 3) {
        expect(state.mutate.mock.calls[1]?.[0]).toMatchObject({
          input: { name: 'Second draft' },
          expectedUpdatedAt: '2026-03-01',
        });
      }
    });
  });

  it('offers a default effort and clears a saved effort with an explicit null', async () => {
    const configured = { ...parent, effort: 'high' as const };
    await inspect(
      () =>
        AgentEditor({
          agent: configured,
          permissions: TEST_PERMISSIONS,
          onDirtyChange() {},
          onPendingChange() {},
          onDeleteRequest() {},
        }),
      async (tree, pass) => {
        if (pass === 0) {
          selectSection(tree, '行为');
          return;
        }
        if (pass === 1) {
          const effort = tree.find((node) => node.type === Select && node.props.value === 'high');
          if (!effort) throw new Error('Missing effort field');
          expect(
            (effort.props.items as Array<{ value: string }>).some((item) => item.value === ''),
          ).toBe(true);
          (effort.props.onValueChange as (value: string) => void)('');
          selectSection(tree, '运行限制');
          return true;
        }
        const form = tree.find((node) => node.type === 'form');
        if (!form) throw new Error('Missing editor form');
        await (form.props.onSubmit as (event: unknown) => Promise<void>)({
          preventDefault() {},
        });
        expect(state.mutate.mock.calls[0]?.[0]).toMatchObject({
          input: { effort: null },
        });
      },
    );
  });

  it('keeps the configured effort after a rename without resending it', async () => {
    const configured = { ...parent, effort: 'high' as const };
    let saved: Agent | undefined;
    state.mutate.mockReset();
    state.mutate.mockImplementationOnce((vars, callbacks) => {
      saved = { ...configured, ...vars.input, updatedAt: '2026-03-01' };
      callbacks?.onSuccess?.(saved);
    });
    await inspect(
      () =>
        AgentEditor({
          agent: configured,
          permissions: TEST_PERMISSIONS,
          onDirtyChange() {},
          onPendingChange() {},
          onDeleteRequest() {},
        }),
      async (tree, pass) => {
        if (pass === 0) {
          const name = tree.find((node) => node.props.id === 'agent-name');
          if (!name) throw new Error('Missing name field');
          (name.props.onChange as (event: unknown) => void)({
            target: { name: 'name', value: 'Renamed' },
          });
          return true;
        }
        if (pass === 1) {
          const form = tree.find((node) => node.type === 'form');
          if (!form) throw new Error('Missing editor form');
          await (form.props.onSubmit as (event: unknown) => Promise<void>)({
            preventDefault() {},
          });
          expect(state.mutate.mock.calls[0]?.[0]).toMatchObject({
            input: { name: 'Renamed' },
          });
          expect(state.mutate.mock.calls[0]?.[0].input).not.toHaveProperty('effort');
          return true;
        }
        if (pass === 2) {
          selectSection(tree, '行为');
          return true;
        }
        expect(saved?.effort).toBe('high');
        expect(
          tree.find((node) => node.type === Select && node.props.value === 'high'),
        ).toBeDefined();
      },
    );
  });

  it('binds a top-level expert to a named runtime environment and hides the choice for sub-agents', async () => {
    state.runtimeEnvironments = [{ id: 'rte_1', name: '数据分析' }];
    await inspect(editor, async (tree, pass) => {
      if (pass === 0) {
        selectSection(tree, '运行限制');
        return true;
      }
      const picker = tree.find(
        (node) =>
          node.type === Select &&
          elements(node).some((child) => child.props.id === 'agent-runtime-environment'),
      );
      if (!picker) throw new Error('Missing runtime environment field');
      if (pass === 1) {
        expect(picker.props.value).toBe('default');
        expect(
          (picker.props.items as Array<{ value: string; label: string }>).some(
            (item) => item.value === 'rte_1' && item.label === '数据分析',
          ),
        ).toBe(true);
        (picker.props.onValueChange as (value: string) => void)('rte_1');
        return true;
      }
      const form = tree.find((node) => node.type === 'form');
      if (!form) throw new Error('Missing editor form');
      await (form.props.onSubmit as (event: unknown) => Promise<void>)({
        preventDefault() {},
      });
      expect(state.mutate.mock.calls[0]?.[0]).toMatchObject({
        input: { runtimeEnvironmentId: 'rte_1' },
      });
    });

    await inspect(
      () =>
        AgentEditor({
          agent: { ...parent, parentId: 'parent' },
          permissions: TEST_PERMISSIONS,
          onDirtyChange() {},
          onPendingChange() {},
          onDeleteRequest() {},
        }),
      (tree, pass) => {
        if (pass === 0) {
          selectSection(tree, '运行限制');
          return true;
        }
        expect(
          tree.find(
            (node) =>
              node.type === Select &&
              elements(node).some((child) => child.props.id === 'agent-runtime-environment'),
          ),
        ).toBeUndefined();
      },
    );
  });

  it('shows the real default environment name and keeps its explicit id after an unrelated save', async () => {
    state.runtimeEnvironments = [
      { id: 'rte_default', name: '默认环境', isDefault: true },
      { id: 'rte_named', name: '数据分析' },
    ];
    const configured = { ...parent, runtimeEnvironmentId: 'rte_default' };
    let saved: Agent | undefined;
    state.mutate.mockReset();
    state.mutate.mockImplementationOnce((vars, callbacks) => {
      saved = { ...configured, ...vars.input, updatedAt: '2026-03-01' };
      callbacks?.onSuccess?.(saved);
    });
    await inspect(
      () =>
        AgentEditor({
          agent: configured,
          permissions: TEST_PERMISSIONS,
          onDirtyChange() {},
          onPendingChange() {},
          onDeleteRequest() {},
        }),
      async (tree, pass) => {
        if (pass === 0) {
          selectSection(tree, '运行限制');
          return true;
        }
        const picker = tree.find(
          (node) =>
            node.type === Select &&
            elements(node).some((child) => child.props.id === 'agent-runtime-environment'),
        );
        if (!picker) throw new Error('Missing runtime environment field');
        const items = picker.props.items as Array<{ value: string; label: string }>;
        expect(picker.props.value).toBe('default');
        expect(items.filter((item) => item.value === 'default')).toEqual([
          { value: 'default', label: '默认环境' },
        ]);
        expect(items.some((item) => item.value === 'rte_default')).toBe(false);
        if (pass === 1) {
          changeNumberField(tree, 'agent-turns', 30);
          return true;
        }
        if (pass === 2) {
          const form = tree.find((node) => node.type === 'form');
          if (!form) throw new Error('Missing editor form');
          await (form.props.onSubmit as (event: unknown) => Promise<void>)({
            preventDefault() {},
          });
          expect(state.mutate.mock.calls[0]?.[0]).toMatchObject({
            input: { maxTurns: 30 },
          });
          expect(state.mutate.mock.calls[0]?.[0].input).not.toHaveProperty('runtimeEnvironmentId');
          return true;
        }
        expect(saved?.runtimeEnvironmentId).toBe('rte_default');
        expect(picker.props.value).toBe('default');
      },
    );
  });

  it('keeps the null default binding after saving an unrelated field without resending it', async () => {
    state.runtimeEnvironments = [
      { id: 'rte_default', name: '默认环境', isDefault: true },
      { id: 'rte_named', name: '数据分析' },
    ];
    let saved: Agent | undefined;
    state.mutate.mockReset();
    state.mutate.mockImplementationOnce((vars, callbacks) => {
      saved = { ...parent, ...vars.input, updatedAt: '2026-03-01' };
      callbacks?.onSuccess?.(saved);
    });
    await inspect(editor, async (tree, pass) => {
      if (pass === 0) {
        selectSection(tree, '运行限制');
        return true;
      }
      if (pass === 1) {
        changeNumberField(tree, 'agent-turns', 30);
        return true;
      }
      if (pass === 2) {
        const picker = tree.find(
          (node) =>
            node.type === Select &&
            elements(node).some((child) => child.props.id === 'agent-runtime-environment'),
        );
        expect(picker?.props.value).toBe('default');
        const form = tree.find((node) => node.type === 'form');
        if (!form) throw new Error('Missing editor form');
        await (form.props.onSubmit as (event: unknown) => Promise<void>)({
          preventDefault() {},
        });
        expect(state.mutate.mock.calls[0]?.[0]).toMatchObject({
          input: { maxTurns: 30 },
        });
        expect(state.mutate.mock.calls[0]?.[0].input).not.toHaveProperty('runtimeEnvironmentId');
        return true;
      }
      expect(saved?.runtimeEnvironmentId).toBeNull();
      const picker = tree.find(
        (node) =>
          node.type === Select &&
          elements(node).some((child) => child.props.id === 'agent-runtime-environment'),
      );
      expect(picker?.props.value).toBe('default');
    });
  });

  it('offers retry when runtime environments fail without dropping the binding', async () => {
    state.runtimeEnvironmentsError = true;
    const bound = { ...parent, runtimeEnvironmentId: 'rte_named' };
    let saved: Agent | undefined;
    state.mutate.mockReset();
    state.mutate.mockImplementationOnce((vars, callbacks) => {
      saved = { ...bound, ...vars.input, updatedAt: '2026-03-01' };
      callbacks?.onSuccess?.(saved);
    });
    await inspect(
      () =>
        AgentEditor({
          agent: bound,
          permissions: TEST_PERMISSIONS,
          onDirtyChange() {},
          onPendingChange() {},
          onDeleteRequest() {},
        }),
      async (tree, pass) => {
        if (pass === 0) {
          selectSection(tree, '运行限制');
          return true;
        }
        if (pass === 1) {
          const error = tree.find((node) => node.type === ErrorState);
          expect(error).toBeDefined();
          if (!error) throw new Error('Missing runtime environment retry');
          (error.props.onRetry as () => void)();
          expect(state.runtimeEnvironmentsRetry).toHaveBeenCalledOnce();
          const picker = tree.find(
            (node) =>
              node.type === Select &&
              elements(node).some((child) => child.props.id === 'agent-runtime-environment'),
          );
          expect(picker?.props.value).toBe('rte_named');
          expect(picker?.props.disabled).toBe(true);
          changeNumberField(tree, 'agent-turns', 30);
          return true;
        }
        if (pass === 2) {
          const form = tree.find((node) => node.type === 'form');
          if (!form) throw new Error('Missing editor form');
          await (form.props.onSubmit as (event: unknown) => Promise<void>)({
            preventDefault() {},
          });
          expect(state.mutate.mock.calls[0]?.[0]).toMatchObject({
            input: { maxTurns: 30 },
          });
          expect(state.mutate.mock.calls[0]?.[0].input).not.toHaveProperty('runtimeEnvironmentId');
          return true;
        }
        expect(saved?.runtimeEnvironmentId).toBe('rte_named');
        const picker = tree.find(
          (node) =>
            node.type === Select &&
            elements(node).some((child) => child.props.id === 'agent-runtime-environment'),
        );
        expect(picker?.props.value).toBe('rte_named');
      },
    );
  });

  it('labels timeout for independent runs and explains delegation only for sub-agents', async () => {
    await inspect(editor, (tree, pass) => {
      if (pass === 0) {
        selectSection(tree, '运行限制');
        return true;
      }
      const label = tree.find((node) => node.props.htmlFor === 'agent-timeout');
      expect(flatText(label?.props.children as ReactNode)).toBe('独立运行超时 (毫秒)');
      expect(tree.find((node) => node.props.id === 'agent-timeout-hint')).toBeUndefined();
    });

    await inspect(
      () =>
        AgentEditor({
          agent: { ...parent, parentId: 'parent', timeoutMs: 120_000 },
          permissions: TEST_PERMISSIONS,
          onDirtyChange() {},
          onPendingChange() {},
          onDeleteRequest() {},
        }),
      (tree, pass) => {
        if (pass === 0) {
          selectSection(tree, '运行限制');
          return true;
        }
        const field = tree.find(
          (node) =>
            node.type === Field &&
            elements(node).some((child) => child.props.id === 'agent-timeout'),
        );
        expect(field).toBeDefined();
        const fieldNodes = elements(field);
        const label = fieldNodes.find((node) => node.props.htmlFor === 'agent-timeout');
        expect(flatText(label?.props.children as ReactNode)).toBe('独立运行超时 (毫秒)');
        const hint = fieldNodes.find(
          (node) => node.type === FieldDescription && node.props.id === 'agent-timeout-hint',
        );
        expect(flatText(hint?.props.children as ReactNode)).toBe('被委派时使用主运行总超时。');
        const input = fieldNodes.find(
          (node) => node.type === NumberInputControl && node.props.id === 'agent-timeout',
        );
        expect(input).toBeDefined();
      },
    );
  });

  it('keeps the edited independent-run timeout when unbinding a child', async () => {
    const configured = { ...parent, timeoutMs: 600_000 };
    let saved: Agent | undefined;
    state.mutate.mockReset();
    state.mutate.mockImplementationOnce((vars, callbacks) => {
      saved = { ...configured, ...vars.input, updatedAt: '2026-03-01' };
      callbacks?.onSuccess?.(saved);
    });
    await inspect(
      () =>
        AgentEditor({
          agent: configured,
          permissions: TEST_PERMISSIONS,
          onDirtyChange() {},
          onPendingChange() {},
          onDeleteRequest() {},
        }),
      async (tree, pass) => {
        if (pass === 0) {
          selectSection(tree, '运行限制');
          return true;
        }
        if (pass === 1) {
          changeNumberField(tree, 'agent-timeout', 90_000);
          selectSection(tree, '能力');
          return true;
        }
        if (pass === 2) {
          const picker = findPicker(tree, 'free');
          if (!picker) throw new Error('Missing delegate picker');
          expect(picker.props.value as PickerProps['value']).toEqual(['child']);
          (picker.props.onValueChange as ChangePickerValue)([]);
          return true;
        }
        if (pass === 3) {
          const form = tree.find((node) => node.type === 'form');
          if (!form) throw new Error('Missing editor form');
          await (form.props.onSubmit as (event: unknown) => Promise<void>)({
            preventDefault() {},
          });
          expect(state.mutate.mock.calls[0]?.[0]).toMatchObject({
            input: { timeoutMs: 90_000, subAgentIds: [] },
          });
          return true;
        }
        expect(saved?.timeoutMs).toBe(90_000);
        expect(saved?.subAgentIds).toEqual([]);
      },
    );
  });

  it('shows loading and retry for delegate options without changing bound drafts', async () => {
    state.agentsPending = true;
    let saved: Agent | undefined;
    state.mutate.mockReset();
    state.mutate.mockImplementationOnce((vars, callbacks) => {
      saved = { ...parent, ...vars.input, updatedAt: '2026-03-01' };
      callbacks?.onSuccess?.(saved);
    });
    await inspect(editor, async (tree, pass) => {
      if (pass === 0) {
        const name = tree.find((node) => node.props.id === 'agent-name');
        if (!name) throw new Error('Missing name field');
        (name.props.onChange as (event: unknown) => void)({
          target: { name: 'name', value: 'Edited' },
        });
        selectSection(tree, '能力');
        return true;
      }
      if (pass === 1) {
        expect(tree.some((node) => node.type === LoadingState)).toBe(true);
        state.agentsPending = false;
        state.agentsError = true;
        return true;
      }
      if (pass === 2) {
        const error = tree.find((node) => node.type === ErrorState);
        expect(error).toBeDefined();
        if (!error) throw new Error('Missing delegate retry');
        (error.props.onRetry as () => void)();
        expect(state.agentsRetry).toHaveBeenCalledOnce();
        return true;
      }
      if (pass === 3) {
        const form = tree.find((node) => node.type === 'form');
        if (!form) throw new Error('Missing editor form');
        await (form.props.onSubmit as (event: unknown) => Promise<void>)({
          preventDefault() {},
        });
        expect(state.mutate.mock.calls[0]?.[0]).toMatchObject({
          input: { name: 'Edited' },
        });
        expect(state.mutate.mock.calls[0]?.[0].input).not.toHaveProperty('subAgentIds');
        state.agentsError = false;
        return true;
      }
      expect(saved?.subAgentIds).toEqual(['child']);
      const picker = findPicker(tree, 'free');
      if (!picker) throw new Error('Missing delegate picker');
      expect(picker.props.value as PickerProps['value']).toEqual(['child']);
    });
  });

  it('offers a clickable create route when there are no other experts to delegate', async () => {
    state.agents = [];
    await inspect(editor, (tree, pass) => {
      if (pass === 0) {
        selectSection(tree, '能力');
        return;
      }
      expect(flatText(tree.map((node) => node.props.children) as ReactNode)).toContain(
        '还没有可委派的专家',
      );
      const create = tree.find(
        (node) => (node.props.render as Element | undefined)?.props.to === '/agents',
      );
      expect(create).toBeDefined();
    });
  });

  it('retains bound children while adding another child and excludes other parents’ children', async () => {
    await inspect(editor, (tree, pass) => {
      if (pass === 0) {
        selectSection(tree, '能力');
        return true;
      }
      const picker = findPicker(tree, 'free');
      expect(picker).toBeDefined();
      if (!picker) throw new Error('Missing child picker');
      const values = pickerValues(picker);
      expect(values).toEqual(['child', 'free']);
      expect(picker.props.value as PickerProps['value']).toEqual(
        pass === 1 ? ['child'] : ['child', 'free'],
      );
      if (pass === 1) {
        (picker.props.onValueChange as ChangePickerValue)(values);
        return true;
      }
    });
  });

  it('retains knowledge and plugin bindings when changing ordinary connectors', async () => {
    state.servers = [
      {
        id: 'connector',
        name: 'Connector',
        kind: 'http',
        url: 'https://example.com/mcp',
        headers: {},
      },
    ];
    state.knowledgeBases = [
      {
        id: 'base',
        serverId: 'knowledge-server',
        name: 'Knowledge',
        slug: 'knowledge',
        status: 'active',
        updatedAt: parent.updatedAt,
      },
    ];
    const configured = {
      ...parent,
      serverIds: ['knowledge-server'],
      pluginBindings: [{ pluginId: 'plugin', allowHooks: true, allowMcp: false }],
    };
    let saved: Agent | undefined;
    state.mutate.mockReset();
    state.mutate.mockImplementationOnce((vars, callbacks) => {
      saved = { ...configured, ...vars.input, updatedAt: '2026-03-01' };
      callbacks?.onSuccess?.(saved);
    });
    await inspect(
      () =>
        AgentEditor({
          agent: configured,
          permissions: TEST_PERMISSIONS,
          onDirtyChange() {},
          onPendingChange() {},
          onDeleteRequest() {},
        }),
      async (tree, pass) => {
        if (pass === 0) {
          selectSection(tree, '能力');
          return true;
        }
        if (pass === 1) {
          const picker = findPicker(tree, 'connector');
          if (!picker) throw new Error('Missing connector picker');
          (picker.props.onValueChange as ChangePickerValue)(['connector']);
          return true;
        }
        if (pass === 2) {
          const form = tree.find((node) => node.type === 'form');
          if (!form) throw new Error('Missing editor form');
          await (form.props.onSubmit as (event: unknown) => Promise<void>)({
            preventDefault() {},
          });
          expect(state.mutate.mock.calls[0]?.[0]).toMatchObject({
            input: { serverIds: ['knowledge-server', 'connector'] },
          });
          expect(state.mutate.mock.calls[0]?.[0].input).not.toHaveProperty('pluginBindings');
          return true;
        }
        expect(saved?.pluginBindings).toEqual(configured.pluginBindings);
        const knowledge = findPicker(tree, 'knowledge-server');
        if (!knowledge) throw new Error('Missing knowledge picker');
        expect(knowledge.props.value as PickerProps['value']).toEqual(['knowledge-server']);
        const connector = findPicker(tree, 'connector');
        if (!connector) throw new Error('Missing connector picker');
        expect(connector.props.value as PickerProps['value']).toEqual(['connector']);
      },
    );
  });

  it('provides retry when skills cannot be loaded', async () => {
    state.skillsError = true;
    await inspect(editor, (tree, pass) => {
      if (pass === 0) {
        selectSection(tree, '能力');
        return;
      }
      const error = tree.find((node) => node.type === ErrorState);
      expect(error).toBeDefined();
      if (!error) throw new Error('Missing retry state');
      (error.props.onRetry as () => void)();
      expect(state.retry).toHaveBeenCalledOnce();
    });
  });

  it('blocks the version history button while the expert is saving', async () => {
    state.saving = true;
    await inspect(editor, (tree) => {
      expect(tree.find((node) => node.props['aria-label'] === '版本历史')?.props.disabled).toBe(
        true,
      );
    });
  });

  it('keeps a section change when the task changes in the same render', async () => {
    state.search = { tab: 'config' };
    await inspect(editor, (tree, pass) => {
      if (pass !== 0) return;
      const tabs = tree.find((node) => node.type === Tabs);
      if (!tabs) throw new Error('Missing task tabs');
      (tabs.props.onValueChange as (value: string) => void)('instructions');
      selectSection(tree, '行为');
    });
    expect(state.search).toMatchObject({ tab: 'instructions', section: 'behavior' });
  });

  it('disables the more menu while a save is in flight', async () => {
    state.saving = true;
    await inspect(editor, (tree) => {
      const trigger = tree.find((node) => node.type === DropdownMenuTrigger);
      const rendered = trigger?.props.render as Element | undefined;
      expect(rendered?.props['aria-label']).toBe('更多操作');
      expect(rendered?.props.disabled).toBe(true);
    });
  });

  it.each([
    { isPending: true, isError: false },
    { isPending: false, isError: true },
    { isPending: false, isError: false },
    {
      isPending: false,
      isError: true,
      data: { snapshot: parent, definition: null, definitionState: 'legacy' },
    },
  ])('blocks rollback without a successfully loaded version: %j', async (detail) => {
    state.detail = detail;
    await inspect(
      () =>
        VersionHistory({
          agentId: parent.id,
          current: parent,
          active: true,
          saving: false,
          onRolledBack: () => {},
        }),
      (tree, pass) => {
        if (pass === 0) {
          const row = tree.find((node) => node.props.onRollback);
          if (!row) throw new Error('Missing version row');
          (row.props.onRollback as () => void)();
          return;
        }
        const confirmation = tree.find((node) => node.type === ConfirmDialog);
        if (!confirmation) throw new Error('Missing rollback confirmation');
        expect(confirmation.props.open).toBe(true);
        expect(confirmation.props.confirmDisabled).toBe(true);
        void (confirmation.props.onConfirm as () => Promise<void>)();
        expect(state.rollback).not.toHaveBeenCalled();
        if (detail.isError) {
          const error = tree.find((node) => node.type === ErrorState);
          expect(error).toBeDefined();
          if (!error) throw new Error('Missing retry state');
          (error.props.onRetry as () => void)();
          expect(state.retry).toHaveBeenCalledOnce();
        }
      },
    );
  });

  it.each([false, true])('permits a loaded rollback only when saving is %s', async (saving) => {
    state.detail = {
      isPending: false,
      isError: false,
      data: {
        snapshot: { ...parent, name: 'Previous name' },
        definition: null,
        definitionState: 'legacy',
      },
    };
    state.rollback.mockResolvedValue({ kind: 'detail', agent: parent });
    const restored = vi.fn();
    let request: Promise<void> | undefined;
    await inspect(
      () =>
        VersionHistory({
          agentId: parent.id,
          current: parent,
          active: true,
          saving,
          onRolledBack: restored,
        }),
      (tree, pass) => {
        const row = tree.find((node) => node.props.onRollback);
        if (!row) throw new Error('Missing version row');
        expect(row.props.rollbackDisabled).toBe(saving);
        if (pass === 0) {
          (row.props.onRollback as () => void)();
          return true;
        }
        const confirmation = tree.find((node) => node.type === ConfirmDialog);
        if (!confirmation) throw new Error('Missing confirmation');
        expect(confirmation.props.confirmDisabled).toBe(saving);
        expect(confirmation.props.description).toContain('名称');
        request = (confirmation.props.onConfirm as () => Promise<void>)();
        return false;
      },
    );
    await request;
    if (saving) {
      expect(state.rollback).not.toHaveBeenCalled();
      expect(restored).not.toHaveBeenCalled();
    } else {
      expect(state.rollback).toHaveBeenCalledWith({ id: 'parent', version: 1 });
      expect(restored).toHaveBeenCalledWith(parent);
    }
  });

  it('returns create focus to the empty-state trigger, with toolbar fallback if removed', async () => {
    state.agents = [];
    state.search = {};
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const flush = async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    };
    const waitFor = async <T>(probe: () => T, tries = 50): Promise<T> => {
      for (let i = 0; i < tries; i += 1) {
        const value = probe();
        if (value) return value;
        await flush();
      }
      return probe();
    };
    try {
      await act(async () => {
        root.render(createElement(AgentsPage));
      });
      await flush();

      const toolbarTrigger = [
        ...container.querySelectorAll<HTMLButtonElement>('[data-slot="page-header"] button'),
      ].find((item) => item.textContent?.includes('新建专家'));
      const emptyTrigger = container.querySelector<HTMLButtonElement>(
        'ul[aria-label="专家列表"] button.agent-create-fan',
      );
      if (!toolbarTrigger || !emptyTrigger) throw new Error('Missing create triggers');

      await act(async () => {
        emptyTrigger.click();
      });
      await flush();
      const firstDialog = await waitFor(() => document.querySelector('[role="dialog"]'));
      expect(firstDialog).not.toBeNull();

      const cancelFirst = [
        ...(firstDialog?.querySelectorAll<HTMLButtonElement>('button') ?? []),
      ].find((item) => item.textContent?.trim() === '取消');
      if (!cancelFirst) throw new Error('Missing dialog cancel button');
      await act(async () => {
        cancelFirst.click();
      });
      await waitFor(() => !document.querySelector('[role="dialog"]'));
      await waitFor(() => document.activeElement === emptyTrigger);
      expect(document.activeElement).toBe(emptyTrigger);

      await act(async () => {
        emptyTrigger.click();
      });
      await flush();
      const secondDialog = await waitFor(() => document.querySelector('[role="dialog"]'));
      expect(secondDialog).not.toBeNull();

      state.search = { q: 'missing' };
      await act(async () => {
        root.render(createElement(AgentsPage));
      });
      await flush();
      expect(emptyTrigger.isConnected).toBe(false);

      const cancelSecond = [
        ...(secondDialog?.querySelectorAll<HTMLButtonElement>('button') ?? []),
      ].find((item) => item.textContent?.trim() === '取消');
      if (!cancelSecond) throw new Error('Missing dialog cancel button');
      await act(async () => {
        cancelSecond.click();
      });
      await waitFor(() => !document.querySelector('[role="dialog"]'));
      await waitFor(() => document.activeElement === toolbarTrigger);
      expect(document.activeElement).toBe(toolbarTrigger);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });
});
