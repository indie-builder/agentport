import { type Agent, PERMISSIONS } from '@agentport/shared';
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
import { Collapsible } from '../src/components/motion-collapsible.js';
import { PageHeader } from '../src/components/page.js';
import { ErrorState, LoadingState } from '../src/components/states.js';
import { Combobox } from '../src/components/ui/combobox.js';
import { DropdownMenuTrigger } from '../src/components/ui/dropdown-menu.js';
import { Field } from '../src/components/ui/field.js';
import { Input } from '../src/components/ui/input.js';
import { Select, SelectItem } from '../src/components/ui/select.js';
import { Tabs } from '../src/components/ui/tabs.js';
import { Textarea } from '../src/components/ui/textarea.js';
import {
  AgentDetailPage,
  AgentEditor,
  AgentsPage,
  CreateAgentDialog,
  VersionHistory,
} from '../src/pages/agents.js';

const TEST_PERMISSIONS = PERMISSIONS.map((permission) => permission.id);

vi.mock('@/components/ui/button', () => import('../src/components/ui/button.js'));
vi.mock('@/components/ui/input-group', () => import('../src/components/ui/input-group.js'));
vi.mock('@/components/ui/input', () => import('../src/components/ui/input.js'));
vi.mock('@/components/ui/textarea', () => import('../src/components/ui/textarea.js'));
vi.mock('@/components/ui/label', () => import('../src/components/ui/label.js'));
vi.mock('@/components/ui/separator', () => import('../src/components/ui/separator.js'));

const state = vi.hoisted(() => ({
  agents: [] as Agent[],
  saving: false,
  creating: false,
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
  create: vi.fn(),
  blockerOptions: [] as Array<{
    shouldBlockFn: (args?: {
      current: { pathname: string; search: Record<string, unknown> };
      next: { pathname: string; search: Record<string, unknown> };
    }) => boolean;
    enableBeforeUnload: boolean;
  }>,
  blockerStatus: 'idle' as 'idle' | 'blocked',
  proceed: vi.fn(),
  reset: vi.fn(),
  remove: vi.fn(),
  search: {} as Record<string, string | undefined>,
}));
vi.mock('../src/lib/queries.js', () => ({
  meQuery: {
    queryKey: ['me'],
    queryFn: async () => (await import('./me-fixture.js')).allAccessMe,
  },
  useAgents: () => ({
    data: state.agents,
    isPending: state.agentsPending,
    isError: state.agentsError,
    error: new Error('Agents unavailable'),
    refetch: state.agentsRetry,
  }),
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
  useAgent: () => ({ data: state.agents[0] ?? null, isPending: false, isError: false }),
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
  useCreateAgent: () => ({ isPending: state.creating, mutate: state.create }),
  useDuplicateAgent: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteAgent: () => ({ mutateAsync: state.remove }),
  useAgentVersions: () => ({
    data: [{ id: 'v1', version: 1, note: null, createdAt: '2026-01-01' }],
  }),
  useAgentVersion: () => ({
    ...state.detail,
    error: new Error('Version unavailable'),
    refetch: state.retry,
  }),
  useRollbackAgent: () => ({ mutateAsync: state.rollback }),
  useAgentFiles: () => ({
    data: undefined,
    isPending: true,
    isError: false,
    error: null,
    refetch: () => {},
  }),
}));
vi.mock('@tanstack/react-query', async () => {
  const { allAccessMe } = await import('./me-fixture.js');
  return {
    useQueries: () => [],
    useQueryClient: () => ({}),
    useQuery: () => ({ data: allAccessMe, isPending: false, isError: false, refetch: vi.fn() }),
  };
});
vi.mock('@tanstack/react-router', () => ({
  Link: 'a',
  useBlocker: (options: (typeof state.blockerOptions)[number]) => {
    state.blockerOptions.push(options);
    return { status: state.blockerStatus, proceed: state.proceed, reset: state.reset };
  },
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
  maxTurns: 20,
  maxBudgetUsd: 2,
  timeoutMs: 600_000,
  enabled: true,
  parentId: null,
  runtimeEnvironmentId: null,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
} as Agent;

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

/**
 * 用真实 React 渲染跑页面的元素与事件契约。
 * 表单只由 RHF 驱动后没有本地 setState：visit 在两帧之间运行，返回 true 表示再看下一帧，
 * 可以 await 提交（异步 resolver）后再断言。
 */
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
// 三栏布局一次只挂载一个分区：探针先点中栏的分区按钮把它切出来。
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

/** 组件测试不挂载真实 DOM，RHF 的 valueAsNumber 没有 ref 可取；直接传 number 值。 */
function changeNumberField(tree: Element[], id: string, value: number): void {
  const field = tree.find((node) => node.props.id === id);
  if (!field) throw new Error(`Missing number field ${id}`);
  (field.props.onChange as (event: unknown) => void)({
    target: { name: field.props.name, value },
  });
}

beforeEach(() => {
  state.agents = [
    parent,
    { ...parent, id: 'child', name: 'Bound child', parentId: 'parent', subAgentIds: [] },
    { ...parent, id: 'free', name: 'Available', subAgentIds: [] },
    { ...parent, id: 'other-child', parentId: 'other', subAgentIds: [] },
  ];
  state.saving = false;
  state.creating = false;
  state.skillsError = false;
  state.servers = [];
  state.knowledgeBases = [];
  state.runtimeEnvironments = [];
  state.runtimeEnvironmentsError = false;
  state.agentsPending = false;
  state.agentsError = false;
  state.detail = { isPending: false, isError: false };
  state.blockerOptions = [];
  state.blockerStatus = 'idle';
  state.search = {};
  vi.clearAllMocks();
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
        // 保存被拦下：非法文本不丢、也不发请求。
        const form = tree.find((node) => node.type === 'form');
        if (!form) throw new Error('Missing editor form');
        await (form.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {} });
        expect(state.mutate).not.toHaveBeenCalled();
        return true;
      }
      // 错误落在隐藏分区：保存后先切到第一个出错的分区再聚焦。
      const allowed = tree.find((node) => node.props.id === 'agent-allowed-tools');
      expect(allowed?.props['aria-invalid']).toBe(true);
    });
  });

  it('generates a slug when creating with only a name', async () => {
    await inspect(
      () => CreateAgentDialog({ onClose() {}, onCreated() {}, finalFocus: () => null }),
      async (tree, pass) => {
        const name = tree.find((node) => node.props.id === 'new-agent-name');
        if (!name) throw new Error('Missing name field');
        if (pass === 0) {
          (name.props.onChange as (event: unknown) => void)({
            target: { name: 'name', value: 'Support Expert' },
          });
          return true;
        }
        const form = tree.find((node) => node.type === 'form');
        if (!form) throw new Error('Missing create form');
        await (form.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {} });
        expect(state.create.mock.calls[0]?.[0]).toMatchObject({
          slug: 'support-expert',
          name: 'Support Expert',
          permissionMode: 'default',
        });
      },
    );
  });

  it('starts general creation with a selectable default occupation', async () => {
    await inspect(
      () => CreateAgentDialog({ onClose() {}, onCreated() {}, finalFocus: () => null }),
      (tree) => {
        const picker = tree.find(
          (node) =>
            node.type === Select &&
            elements(node).some((child) => child.props.id === 'new-agent-role'),
        );
        expect(picker?.props.value).toBe('通用助手');
        expect(state.blockerOptions.at(-1)?.shouldBlockFn()).toBe(false);
      },
    );
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
      // 服务端把清除后的空值回读为 undefined，而不是 null。
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
        // 固定思考预算控件已移除，推理深度只由 effort 表达。
        expect(tree.find((node) => node.props.id === 'agent-thinking')).toBeUndefined();
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
      // 真实 PATCH 只合并脏字段并回读完整 Agent；这里按同样语义模拟服务端响应。
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
      // 未变的环境绑定不随 PATCH 提交，服务端响应回读的仍是原值。
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
      // runtimeEnvironmentId 未变时不提交，服务端保留原来的 null。
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
      // 加载失败时草稿仍保留原绑定；未改动的绑定不提交，响应回读保持不变。
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

  it('shows loading and retry for delegate options without changing bound drafts', async () => {
    state.agentsPending = true;
    let saved: Agent | undefined;
    state.mutate.mockReset();
    state.mutate.mockImplementationOnce((vars, callbacks) => {
      // 子智能体绑定未改动就不提交；服务端合并后仍回读原有绑定。
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
      const picker = tree.find(
        (node) =>
          node.type === Combobox &&
          (node.props.items as Array<{ id: string }>).some((item) => item.id === 'free'),
      );
      if (!picker) throw new Error('Missing delegate picker');
      expect((picker.props.value as Array<{ id: string }>).map((item) => item.id)).toEqual([
        'child',
      ]);
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

  it.each(['通用助手', '数字分身'])(
    'accepts an arbitrary model id for a %s creation',
    async (role) => {
      await inspect(
        () =>
          CreateAgentDialog({
            initialRole: role as '通用助手',
            onClose() {},
            onCreated() {},
            finalFocus: () => null,
          }),
        async (tree, pass) => {
          if (pass === 0) {
            const advanced = tree.find((node) => node.type === Collapsible);
            if (!advanced) throw new Error('Missing advanced settings');
            expect(advanced.props.open).toBe(false);
            (advanced.props.onOpenChange as (open: boolean) => void)(true);
            return true;
          }
          if (pass === 1) {
            expect(tree.find((node) => node.type === Collapsible)?.props.open).toBe(true);
            const model = tree.find((node) => node.props.id === 'new-agent-model');
            if (!model) throw new Error('Missing model input');
            expect(model.type).toBe(Input);
            expect(model.props.list).toBe('new-agent-models');
            const suggestions = tree.find((node) => node.props.id === 'new-agent-models');
            expect(
              elements(suggestions?.props.children as ReactNode).map((node) => node.props.value),
            ).toContain('group/flash');
            const name = tree.find((node) => node.props.id === 'new-agent-name');
            if (!name) throw new Error('Missing name field');
            (name.props.onChange as (event: unknown) => void)({
              target: { name: 'name', value: 'Custom model' },
            });
            (model.props.onChange as (event: unknown) => void)({
              target: { name: 'model', value: 'gateway/custom-model' },
            });
            return true;
          }
          const form = tree.find((node) => node.type === 'form');
          if (!form) throw new Error('Missing create form');
          await (form.props.onSubmit as (event: unknown) => Promise<void>)({
            preventDefault() {},
          });
          expect(state.create.mock.calls[0]?.[0]).toMatchObject({
            model: 'gateway/custom-model',
          });
        },
      );
    },
  );

  it.each([false, true])(
    'protects new expert navigation and unload while pending: %s',
    async (pending) => {
      state.creating = pending;
      await inspect(
        () => CreateAgentDialog({ onClose() {}, onCreated() {}, finalFocus: () => null }),
        (tree, pass) => {
          if (!pending && pass === 0) {
            const input = tree.find((node) => node.props.id === 'new-agent-slug');
            if (!input) throw new Error('Missing slug field');
            (input.props.onChange as (event: unknown) => void)({
              target: { name: 'slug', value: 'draft' },
            });
            return;
          }
          const options = state.blockerOptions.at(-1);
          expect(options?.shouldBlockFn()).toBe(true);
          expect(options?.enableBeforeUnload).toBe(true);
        },
      );
    },
  );

  it('prevents a previously opened leave confirmation from proceeding during a save', async () => {
    state.saving = true;
    state.blockerStatus = 'blocked';
    let confirm: (() => Promise<void>) | undefined;
    await inspect(editor, (tree) => {
      const dialog = tree.find((node) => node.type === ConfirmDialog && node.props.open);
      expect(dialog?.props.confirmDisabled).toBe(true);
      confirm = dialog?.props.onConfirm as () => Promise<void>;
    });
    await confirm?.();
    expect(state.proceed).not.toHaveBeenCalled();
  });

  it('retains bound children while adding another child and excludes other parents’ children', async () => {
    await inspect(editor, (tree, pass) => {
      if (pass === 0) {
        selectSection(tree, '能力');
        return;
      }
      const picker = tree.find(
        (node) =>
          node.type === Combobox &&
          (node.props.items as Array<{ id: string }>).some((item) => item.id === 'free'),
      );
      expect(picker).toBeDefined();
      if (!picker) throw new Error('Missing child picker');
      const items = picker.props.items as Array<{ id: string }>;
      expect(items.map((item) => item.id)).toEqual(['child', 'free']);
      expect((picker.props.value as Array<{ id: string }>).map((item) => item.id)).toEqual(
        pass === 1 ? ['child'] : ['child', 'free'],
      );
      if (pass === 1) (picker.props.onValueChange as (items: unknown[]) => void)(items);
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
      // 只改普通连接器时 pluginBindings 未脏、不提交；服务端合并后仍回读原绑定。
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
          const picker = tree.find(
            (node) =>
              node.type === Combobox &&
              (node.props.items as Array<{ id: string }>).some((item) => item.id === 'connector'),
          );
          if (!picker) throw new Error('Missing connector picker');
          (picker.props.onValueChange as (items: unknown[]) => void)(
            picker.props.items as unknown[],
          );
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
        const knowledge = tree.find(
          (node) =>
            node.type === Combobox &&
            (node.props.items as Array<{ id: string }>).some(
              (item) => item.id === 'knowledge-server',
            ),
        );
        if (!knowledge) throw new Error('Missing knowledge picker');
        expect((knowledge.props.value as Array<{ id: string }>).map((item) => item.id)).toEqual([
          'knowledge-server',
        ]);
        const connector = tree.find(
          (node) =>
            node.type === Combobox &&
            (node.props.items as Array<{ id: string }>).some((item) => item.id === 'connector'),
        );
        if (!connector) throw new Error('Missing connector picker');
        expect((connector.props.value as Array<{ id: string }>).map((item) => item.id)).toEqual([
          'connector',
        ]);
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

  it('switches away from the config task without asking, because the config draft is kept', async () => {
    await inspect(editor, (tree, pass) => {
      if (pass === 0) {
        const name = tree.find((node) => node.props.id === 'agent-name');
        if (!name) throw new Error('Missing name field');
        (name.props.onChange as (event: unknown) => void)({
          target: { name: 'name', value: 'Kept draft' },
        });
        return true;
      }
      if (pass !== 1) return;
      const tabs = tree.find((node) => node.type === Tabs);
      if (!tabs) throw new Error('Missing task tabs');
      (tabs.props.onValueChange as (value: string) => void)('memory');
    });
    expect(state.search.tab).toBe('memory');
  });

  it('allows a task switch with only the main draft dirty and still blocks leaving', async () => {
    await inspect(editor, (tree, pass) => {
      if (pass === 0) {
        const name = tree.find((node) => node.props.id === 'agent-name');
        if (!name) throw new Error('Missing name field');
        (name.props.onChange as (event: unknown) => void)({
          target: { name: 'name', value: 'draft' },
        });
        return;
      }
      if (pass !== 1) return;
      const options = state.blockerOptions.at(-1);
      const args = (next: { pathname: string; search: Record<string, unknown> }) => ({
        current: { pathname: '/agents/parent', search: {} },
        next,
      });
      expect(
        options?.shouldBlockFn(
          args({ pathname: '/agents/parent', search: { section: 'behavior' } }),
        ),
      ).toBe(false);
      expect(
        options?.shouldBlockFn(args({ pathname: '/agents/parent', search: { tab: 'memory' } })),
      ).toBe(false);
      expect(options?.shouldBlockFn(args({ pathname: '/agents', search: {} }))).toBe(true);
    });
  });

  it('blocks same-page task changes while a save is pending', async () => {
    state.saving = true;
    await inspect(editor, () => {
      const options = state.blockerOptions.at(-1);
      expect(
        options?.shouldBlockFn({
          current: { pathname: '/agents/parent', search: {} },
          next: { pathname: '/agents/parent', search: { tab: 'memory' } },
        }),
      ).toBe(true);
      expect(
        options?.shouldBlockFn({
          current: { pathname: '/agents/parent', search: {} },
          next: { pathname: '/agents/parent', search: { section: 'behavior' } },
        }),
      ).toBe(false);
    });
  });

  it('reads the task and section from the URL', async () => {
    state.search = { tab: 'files', file: '.mcp.json' };
    await inspect(editor, (tree) => {
      const files = tree.find((node) => node.props['aria-label'] === '工作区文件');
      expect(files).toBeDefined();
    });
  });

  it('keeps a section change when the task changes in the same render', async () => {
    state.search = { tab: 'config' };
    await inspect(editor, (tree, pass) => {
      if (pass !== 0) return;
      const tabs = tree.find((node) => node.type === Tabs);
      if (!tabs) throw new Error('Missing task tabs');
      (tabs.props.onValueChange as (value: string) => void)('styles');
      selectSection(tree, '行为');
    });
    expect(state.search).toMatchObject({ tab: 'styles', section: 'behavior' });
  });

  it('switches tasks immediately when nothing is unsaved', async () => {
    await inspect(editor, (tree, pass) => {
      if (pass === 0) {
        const tabs = tree.find((node) => node.type === Tabs);
        if (!tabs) throw new Error('Missing task tabs');
        (tabs.props.onValueChange as (value: string) => void)('rules');
        return;
      }
      const confirmation = tree.find((node) => node.type === ConfirmDialog && node.props.open);
      expect(confirmation).toBeUndefined();
    });
    expect(state.search.tab).toBe('rules');
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
    { isPending: false, isError: true, data: { snapshot: parent } },
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

  it('disables all create fields during submission', async () => {
    state.creating = true;
    await inspect(
      () => CreateAgentDialog({ onClose: () => {}, onCreated: () => {}, finalFocus: () => null }),
      (tree) => {
        const fields = tree.filter(
          (node) => node.type === Input || node.type === Textarea || node.type === Select,
        );
        expect(fields).toHaveLength(5);
        expect(fields.every((node) => node.props.disabled === true)).toBe(true);
        expect(
          tree
            .filter((node) => node.type === Field)
            .every((node) => node.props['data-disabled'] === true),
        ).toBe(true);
      },
    );
  });

  it.each([false, true])('permits a loaded rollback only when saving is %s', async (saving) => {
    state.detail = {
      isPending: false,
      isError: false,
      data: { snapshot: { ...parent, name: 'Previous name' } },
    };
    state.rollback.mockResolvedValue(parent);
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

  it('keeps the deletion confirmation open while the optimistic delete is still pending', async () => {
    state.remove.mockResolvedValue(undefined);
    let position: number | undefined;
    await inspect(AgentDetailPage, (tree, pass) => {
      const root = tree[0];
      if (!root) throw new Error('Missing page');
      const children = root.props.children as Element[];
      const index = children.findIndex(
        (node) =>
          isValidElement(node) &&
          node.type === ConfirmDialog &&
          String(node.props.title).startsWith('删除专家'),
      );
      expect(index).toBeGreaterThanOrEqual(0);
      if (pass === 0) {
        position = index;
        const editor = tree.find((node) => node.type === AgentEditor);
        if (!editor) throw new Error('Missing editor');
        (editor.props.onDeleteRequest as () => void)();
        return;
      }
      const confirmation = tree.find(
        (node) => node.type === ConfirmDialog && String(node.props.title).startsWith('删除专家'),
      );
      expect(confirmation?.props.open).toBe(true);
      expect(index).toBe(position);
    });
  });

  it('returns create focus to the empty-state trigger, with toolbar fallback if removed', async () => {
    state.agents = [];
    const trigger = { isConnected: true };
    const fallback = { isConnected: true };
    await inspect(AgentsPage, (tree, pass) => {
      const header = tree.find((node) => node.type === PageHeader);
      const toolbar = elements(header?.props.actions as ReactNode).find(
        (node) => node.props.ref && node.type !== 'input',
      );
      if (!toolbar) throw new Error('Missing toolbar trigger');
      (toolbar.props.ref as { current: unknown }).current = fallback;
      if (pass === 0) {
        const fan = tree.find(
          (node) => node.type === 'button' && node.props['aria-label'] === '新建专家',
        );
        if (!fan) throw new Error('Missing create trigger');
        (fan.props.onClick as (event: unknown) => void)({ currentTarget: trigger });
        return;
      }
      const dialog = tree.find((node) => node.type === CreateAgentDialog);
      if (!dialog) throw new Error('Missing create dialog');
      const finalFocus = dialog.props.finalFocus as () => unknown;
      expect(finalFocus()).toBe(trigger);
      trigger.isConnected = false;
      expect(finalFocus()).toBe(fallback);
    });
  });
});
