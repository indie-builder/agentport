import type { Agent } from '@agentport/shared';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../src/components/confirm-dialog.js';
import { PageHeader } from '../src/components/page.js';
import { ErrorState } from '../src/components/states.js';
import { Combobox } from '../src/components/ui/combobox.js';
import { Field } from '../src/components/ui/field.js';
import { Input } from '../src/components/ui/input.js';
import { Select, SelectItem } from '../src/components/ui/select.js';
import { Textarea } from '../src/components/ui/textarea.js';
import {
  AgentDetailPage,
  AgentEditor,
  AgentsPage,
  CreateAgentDialog,
  VersionHistory,
} from '../src/pages/agents.js';

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
  detail: {} as { isPending: boolean; isError: boolean; data?: unknown },
  rollback: vi.fn(),
  retry: vi.fn(),
  mutate: vi.fn(),
  blockerOptions: [] as Array<{ shouldBlockFn: () => boolean; enableBeforeUnload: boolean }>,
  blockerStatus: 'idle' as 'idle' | 'blocked',
  proceed: vi.fn(),
  reset: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('../src/lib/queries.js', () => ({
  useAgents: () => ({ data: state.agents }),
  useAgent: () => ({ data: state.agents[0] ?? null, isPending: false, isError: false }),
  useServers: () => ({ data: [] }),
  useSkills: () => ({
    isError: state.skillsError,
    error: new Error('Skills unavailable'),
    refetch: state.retry,
  }),
  useUpdateAgent: () => ({ isPending: state.saving, mutate: state.mutate }),
  useCreateAgent: () => ({ isPending: state.creating }),
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
vi.mock('@tanstack/react-query', () => ({ useQueries: () => [], useQueryClient: () => ({}) }));
vi.mock('@tanstack/react-router', () => ({
  useBlocker: (options: (typeof state.blockerOptions)[number]) => {
    state.blockerOptions.push(options);
    return { status: state.blockerStatus, proceed: state.proceed, reset: state.reset };
  },
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
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

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

// Use real React state and the page's element/event contracts without a browser DOM.
function inspect(render: () => ReactNode, visit: (tree: Element[], pass: number) => void) {
  let pass = 0;
  function Probe() {
    const tree = elements(render());
    visit(tree, pass++);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
}
function editor() {
  return AgentEditor({
    agent: parent,
    onDirtyChange: () => {},
    onPendingChange: () => {},
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
  state.detail = { isPending: false, isError: false };
  state.blockerOptions = [];
  state.blockerStatus = 'idle';
  vi.clearAllMocks();
});

describe('expert editor regressions', () => {
  it('shows a role for experts with a blank historical role', () => {
    inspect(AgentsPage, (tree) => {
      expect(flatText(tree.map((node) => node.props.children) as ReactNode)).toContain('通用助手');
    });
    inspect(AgentDetailPage, (tree) => {
      const header = tree.find((node) => node.type === PageHeader);
      expect(flatText(header?.props.eyebrow as ReactNode)).toBe('通用助手');
    });
  });

  it('keeps a legacy role visible until the user selects a standard occupation', () => {
    const legacy = { ...parent, role: '历史顾问' };
    inspect(
      () => AgentEditor({ agent: legacy, onDirtyChange() {}, onPendingChange() {} }),
      (tree, pass) => {
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
          return;
        }
        const form = tree.find((node) => node.type === 'form');
        if (!form) throw new Error('Missing editor form');
        (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
        expect(state.mutate.mock.calls[0]?.[0]).toMatchObject({ input: { role: '测试工程师' } });
      },
    );
  });

  it('uses the working background field for an existing digital twin', () => {
    inspect(
      () =>
        AgentEditor({
          agent: { ...parent, role: '数字分身' },
          onDirtyChange() {},
          onPendingChange() {},
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

  it('starts general creation with a selectable default occupation', () => {
    inspect(
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

  it('keeps the draft timestamp when background refetch changes the expert', () => {
    let current = parent;
    inspect(
      () => AgentEditor({ agent: current, onDirtyChange() {}, onPendingChange() {} }),
      (tree, pass) => {
        if (pass === 0) {
          current = { ...parent, name: 'Someone else', updatedAt: '2026-02-01' };
          const name = tree.find((node) => node.props.id === 'agent-name');
          if (!name) throw new Error('Missing name field');
          (name.props.onChange as (event: unknown) => void)({ target: { value: 'My draft' } });
          return;
        }
        const form = tree.find((node) => node.type === 'form');
        if (!form) throw new Error('Missing form');
        (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
        expect(state.mutate.mock.calls[0]?.[0]).toMatchObject({
          input: { name: 'My draft' },
          expectedUpdatedAt: '2026-01-01',
        });
      },
    );
  });

  it('advances the baseline only to the successfully saved response', () => {
    state.mutate.mockImplementationOnce((input, callbacks) => {
      // 服务端把清除后的空值回读为 undefined，而不是 null。
      callbacks.onSuccess({ ...parent, name: input.input.name, updatedAt: '2026-03-01' });
    });
    inspect(editor, (tree, pass) => {
      const name = tree.find((node) => node.props.id === 'agent-name');
      const form = tree.find((node) => node.type === 'form');
      if (!name || !form) throw new Error('Missing editor fields');
      if (pass === 0 || pass === 2) {
        (name.props.onChange as (event: unknown) => void)({
          target: { value: pass === 0 ? 'First draft' : 'Second draft' },
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

  it('offers a default effort and clears a saved thinking limit with an explicit null', () => {
    const configured = { ...parent, effort: 'high' as const, maxThinkingTokens: 1024 };
    inspect(
      () => AgentEditor({ agent: configured, onDirtyChange() {}, onPendingChange() {} }),
      (tree, pass) => {
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
          selectSection(tree, '运行限制');
          return;
        }
        const thinking = tree.find((node) => node.props.id === 'agent-thinking');
        if (!thinking) throw new Error('Missing thinking field');
        if (pass === 2) {
          (thinking.props.onChange as (event: unknown) => void)({ target: { value: '' } });
        } else {
          expect(thinking.props['aria-invalid']).toBe(false);
          if (pass !== 3) return;
          const form = tree.find((node) => node.type === 'form');
          if (!form) throw new Error('Missing editor form');
          (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
        }
      },
    );
    expect(state.mutate.mock.calls[0]?.[0]).toMatchObject({
      input: { maxThinkingTokens: null },
    });
  });

  it.each([false, true])(
    'protects new expert navigation and unload while pending: %s',
    (pending) => {
      state.creating = pending;
      inspect(
        () => CreateAgentDialog({ onClose() {}, onCreated() {}, finalFocus: () => null }),
        (tree, pass) => {
          if (!pending && pass === 0) {
            const input = tree.find((node) => node.props.id === 'new-agent-slug');
            if (!input) throw new Error('Missing slug field');
            (input.props.onChange as (event: unknown) => void)({ target: { value: 'draft' } });
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
    inspect(editor, (tree) => {
      const dialog = tree.find((node) => node.type === ConfirmDialog && node.props.open);
      expect(dialog?.props.confirmDisabled).toBe(true);
      confirm = dialog?.props.onConfirm as () => Promise<void>;
    });
    await confirm?.();
    expect(state.proceed).not.toHaveBeenCalled();
  });

  it('retains bound children while adding another child and excludes other parents’ children', () => {
    inspect(editor, (tree, pass) => {
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

  it('provides retry when skills cannot be loaded', () => {
    state.skillsError = true;
    inspect(editor, (tree, pass) => {
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

  it('blocks the version history button while the expert is saving', () => {
    state.saving = true;
    inspect(editor, (tree) => {
      expect(tree.find((node) => node.props['aria-label'] === '版本历史')?.props.disabled).toBe(
        true,
      );
    });
  });

  it('disables deletion on the config page while a save is in flight', () => {
    inspect(AgentDetailPage, (tree, pass) => {
      const editor = tree.find((node) => node.type === AgentEditor);
      if (pass === 0) {
        if (!editor) throw new Error('Missing editor');
        (editor.props.onPendingChange as (pending: boolean) => void)(true);
        return;
      }
      const header = tree.find((node) => node.type === PageHeader);
      const actions = elements(header?.props.actions as ReactNode);
      expect(actions.find((node) => node.props['aria-label'] === '删除专家')?.props.disabled).toBe(
        true,
      );
    });
  });

  it.each([
    { isPending: true, isError: false },
    { isPending: false, isError: true },
    { isPending: false, isError: false },
    { isPending: false, isError: true, data: { snapshot: parent } },
  ])('blocks rollback without a successfully loaded version: %j', (detail) => {
    state.detail = detail;
    inspect(
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

  it('disables all create fields during submission', () => {
    state.creating = true;
    inspect(
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
    inspect(
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
          return;
        }
        const confirmation = tree.find((node) => node.type === ConfirmDialog);
        if (!confirmation) throw new Error('Missing confirmation');
        expect(confirmation.props.confirmDisabled).toBe(saving);
        expect(confirmation.props.description).toContain('名称');
        request = (confirmation.props.onConfirm as () => Promise<void>)();
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

  it('keeps the deletion confirmation open while the optimistic delete is still pending', () => {
    state.remove.mockResolvedValue(undefined);
    let position: number | undefined;
    inspect(AgentDetailPage, (tree, pass) => {
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
        const header = tree.find((node) => node.type === PageHeader);
        const trigger = elements(header?.props.actions as ReactNode).find(
          (node) => node.props['aria-label'] === '删除专家',
        );
        if (!trigger) throw new Error('Missing delete action');
        (trigger.props.onClick as () => void)();
        return;
      }
      expect(children[index]?.props.open).toBe(true);
      expect(index).toBe(position);
    });
  });

  it('returns create focus to the empty-state trigger, with toolbar fallback if removed', () => {
    state.agents = [];
    const trigger = { isConnected: true };
    const fallback = { isConnected: true };
    inspect(AgentsPage, (tree, pass) => {
      const root = tree[0];
      if (!root) throw new Error('Missing page');
      const toolbar = elements(root.props.actions as ReactNode).find(
        (node) => node.props.ref && node.type !== 'input',
      );
      if (!toolbar) throw new Error('Missing toolbar trigger');
      (toolbar.props.ref as { current: unknown }).current = fallback;
      if (pass === 0) {
        const empty = tree.find(
          (node) => node.props.title === '创建专家，绑定技能和连接器，即可在对话中使用。',
        );
        const action = empty?.props.action as Element;
        (action.props.onClick as (event: unknown) => void)({ currentTarget: trigger });
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
