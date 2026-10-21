// 只引用纯函数子路径：core 根入口还导出 node:crypto 相关模块，浏览器不能加载。

import type { McpJsonEntry } from '@agentport/core/tools';
import {
  DEFAULT_DISALLOWED_TOOLS,
  renderWorkspace,
  type WorkspaceFiles,
} from '@agentport/core/workspace';
import {
  type Agent,
  type AgentInput,
  agentInputSchema,
  BUILTIN_TOOLS,
  type Server,
} from '@agentport/shared';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  Check,
  ChevronRight,
  Download,
  Ellipsis,
  FileCode,
  FileText,
  History,
  Plug,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import { CodeBlock } from '../components/code-block.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { Page, PageHeader } from '../components/page.js';
import { EmptyState, ErrorState, InlineEmpty, LoadingState } from '../components/states.js';
import { Button } from '../components/ui/button.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../components/ui/collapsible.js';
import { Dialog } from '../components/ui/dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu.js';
import { FieldError, FieldHint, Input } from '../components/ui/input.js';
import { Label, RequiredMark } from '../components/ui/label.js';
import { MultiSelect } from '../components/ui/multi-select.js';
import { Select } from '../components/ui/select.js';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '../components/ui/sheet.js';
import { SearchInput, Tabs } from '../components/ui/tabs.js';
import { Textarea } from '../components/ui/textarea.js';
import type { AgentVersionSummary } from '../lib/api.js';
import { ApiError, api } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { fieldErrors } from '../lib/form.js';
import { formatDateTime } from '../lib/format.js';
import {
  toolsQuery,
  useAgentFiles,
  useAgents,
  useAgentVersion,
  useAgentVersions,
  useCreateAgent,
  useDeleteAgent,
  useRollbackAgent,
  useServers,
  useSkills,
  useUpdateAgent,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';

/**
 * 模型名由部署的网关决定，不是平台常量：直连 Anthropic 时是 claude-*，
 * 用自建网关时是网关 /v1/models 里的 id。这里给的是当前部署的默认值，
 * 创建后仍可手改，所以不要把它当成白名单。
 */
const models = ['group/flash', 'auto/deepseek-v4.1-flash', 'workbuddy/kimi-k3-2'];

/** 当前值可能不在建议列表里；Select 必须包含它，否则触发器显示为空。 */
function modelOptions(value: string): Array<{ value: string; label: string }> {
  const list = !value || models.includes(value) ? models : [value, ...models];
  return list.map((model) => ({ value: model, label: model }));
}

const emptyInput: AgentInput = {
  slug: '',
  name: '',
  description: '',
  model: 'claude-sonnet-5-5',
  systemPrompt: '',
  serverIds: [],
  skillIds: [],
  subAgentIds: [],
  allowedTools: [],
  disallowedTools: [],
  permissionMode: 'dontAsk',
  maxTurns: 20,
  maxBudgetUsd: 2,
  timeoutMs: 600_000,
  enabled: true,
};

function toInput(agent: Agent): AgentInput {
  return {
    slug: agent.slug,
    name: agent.name,
    description: agent.description,
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    serverIds: agent.serverIds,
    skillIds: agent.skillIds,
    subAgentIds: agent.subAgentIds,
    allowedTools: agent.allowedTools,
    disallowedTools: agent.disallowedTools,
    permissionMode: agent.permissionMode,
    maxTurns: agent.maxTurns,
    maxBudgetUsd: agent.maxBudgetUsd,
    timeoutMs: agent.timeoutMs,
    enabled: agent.enabled,
    ...(agent.effort === undefined ? {} : { effort: agent.effort }),
    ...(agent.maxThinkingTokens === undefined
      ? {}
      : { maxThinkingTokens: agent.maxThinkingTokens }),
  };
}

export function AgentsPage() {
  const agents = useAgents();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [deleting, setDeleting] = useState<Agent | null>(null);
  const [importing, setImporting] = useState(false);
  // 切换智能体会重挂编辑器、丢弃草稿：脏的时候先确认。
  const dirtyRef = useRef(false);
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const remove = useDeleteAgent();

  const onDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);

  const selectAgent = (id: string): void => {
    if (id === selectedId) return;
    if (dirtyRef.current) {
      setPendingSwitch(id);
      return;
    }
    setSelectedId(id);
  };

  // 切走前关掉浏览器标签会静默丢草稿：脏时挂 beforeunload（刷新也算切换）。
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent): void => {
      if (!dirtyRef.current) return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);

  // 导入返回的 agent 直接选中；列表与 server/skill 缓存随后失效刷新。
  const importFile = async (file: File): Promise<void> => {
    setImporting(true);
    try {
      const data: unknown = JSON.parse(await file.text());
      const result = await api.importAgent(data);
      setSelectedId(result.agent.id);
      await Promise.all(
        ['agents', 'servers', 'skills', 'overview'].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      );
      const suffix = result.warnings.length > 0 ? `，${result.warnings.length} 条提示` : '';
      toastSuccess(`已导入「${result.agent.name}」${suffix}`);
    } catch (error) {
      toastError(error);
    } finally {
      setImporting(false);
    }
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = agents.data ?? [];
    if (!needle) return list;
    return list.filter((agent) =>
      [agent.name, agent.slug, agent.description].join(' ').toLowerCase().includes(needle),
    );
  }, [agents.data, query]);

  // 搜索不应悄悄换掉正在编辑的智能体：先按全量列表解析，只有它不存在时才落到筛选结果。
  const selected =
    (agents.data ?? []).find((agent) => agent.id === selectedId) ?? filtered[0] ?? null;

  return (
    <Page>
      <PageHeader
        title="智能体"
        meta={
          <span className="font-mono text-xs tabular-nums text-subtle">
            {agents.data?.length ?? 0}
          </span>
        }
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void importFile(file);
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-8 rounded-full px-3"
              disabled={importing}
              aria-busy={importing}
              onClick={() => fileInput.current?.click()}
            >
              <Upload className="size-4" /> {importing ? '导入中…' : '导入'}
            </Button>
            <Button
              ref={createButtonRef}
              size="sm"
              className="h-8 rounded-full px-3.5"
              onClick={() => setCreating(true)}
            >
              <Plus className="size-4" /> 新建智能体
            </Button>
          </>
        }
      />

      <div className="grid lg:grid-cols-[260px_minmax(0,1fr)]">
        <div className="min-w-0 py-3 pr-5 lg:border-r lg:border-line">
          <SearchInput
            label="搜索智能体"
            placeholder="搜索名称或 slug…"
            value={query}
            onChange={setQuery}
            className="mb-2"
          />

          {agents.isPending ? <LoadingState rows={4} /> : null}
          {agents.isError ? (
            <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
          ) : null}
          {agents.data && agents.data.length === 0 ? (
            <EmptyState
              icon={<Bot className="size-5" />}
              title="还没有智能体"
              description="创建后绑定 MCP Server，即可在对话中使用它的工具。"
              action={
                <Button size="sm" onClick={() => setCreating(true)}>
                  新建智能体
                </Button>
              }
            />
          ) : null}
          {agents.data && agents.data.length > 0 && filtered.length === 0 ? (
            <InlineEmpty>没有匹配的智能体。</InlineEmpty>
          ) : null}

          <ul aria-label="智能体列表">
            {filtered.map((agent) => {
              const active = selected?.id === agent.id;
              return (
                <li key={agent.id} className="border-b border-line last:border-b-0">
                  <button
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    onClick={() => selectAgent(agent.id)}
                    className={cn(
                      'flex h-14 w-full items-center gap-3 rounded-[9px] px-2.5 text-left transition-colors duration-150 hover:bg-chip',
                      active ? 'bg-hover' : '',
                    )}
                  >
                    <span
                      className={cn(
                        'size-1.5 shrink-0 rounded-full',
                        agent.enabled ? 'bg-success' : 'bg-subtle',
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base text-fg">{agent.name}</span>
                      <span className="block truncate font-mono text-2xs text-subtle">
                        {agent.slug}
                      </span>
                    </span>
                    <span className="font-mono text-2xs tabular-nums text-subtle">
                      {agent.serverIds.length}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="min-w-0 lg:pl-6">
          {selected ? (
            <AgentEditor
              key={selected.id}
              agent={selected}
              onDelete={() => setDeleting(selected)}
              onDirtyChange={onDirtyChange}
            />
          ) : agents.data && agents.data.length > 0 ? (
            <EmptyState title="选择一个智能体" description="从左侧列表选择以查看和编辑配置。" />
          ) : null}
        </div>
      </div>

      {creating ? (
        <CreateAgentDialog
          returnFocusRef={createButtonRef}
          onClose={() => setCreating(false)}
          onCreated={(agent) => {
            setSelectedId(agent.id);
            setCreating(false);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={pendingSwitch !== null}
        onClose={() => setPendingSwitch(null)}
        title="放弃未保存的更改？"
        description={`「${selected?.name ?? ''}」还有未保存的修改，切换后会丢失。可以先取消、保存后再切换。`}
        confirmLabel="放弃并切换"
        onConfirm={async () => {
          if (pendingSwitch) setSelectedId(pendingSwitch);
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`删除智能体「${deleting?.name ?? ''}」`}
        description="它的会话、消息与绑定关系会一并删除，正在运行的任务不会被自动停止。此操作不可撤销。"
        onConfirm={async () => {
          if (!deleting) return;
          await remove.mutateAsync(deleting.id);
          if (selectedId === deleting.id) setSelectedId(null);
        }}
      />
    </Page>
  );
}

type SectionId = 'identity' | 'behavior' | 'capability' | 'permissions' | 'limits';

const sectionItems: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: 'identity', label: '身份' },
  { id: 'behavior', label: '行为' },
  { id: 'capability', label: '能力' },
  { id: 'permissions', label: '权限' },
  { id: 'limits', label: '运行限制' },
];

const errorSections: Record<string, SectionId> = {
  slug: 'identity',
  name: 'identity',
  description: 'identity',
  systemPrompt: 'behavior',
  model: 'behavior',
  effort: 'behavior',
  serverIds: 'capability',
  skillIds: 'capability',
  subAgentIds: 'capability',
  permissionMode: 'permissions',
  allowedTools: 'permissions',
  disallowedTools: 'permissions',
  maxTurns: 'limits',
  maxBudgetUsd: 'limits',
  timeoutMs: 'limits',
  maxThinkingTokens: 'limits',
};

/** 字段 → 落盘位置。仅运行时字段由 workspace.ts 证实在 renderWorkspace 之外。 */
function FileTag({ children }: { children: ReactNode }) {
  return <span className="shrink-0 font-mono text-2xs text-subtle">{children}</span>;
}

/** 输入 36px / radius 9：表单密度跟着设计基准走，而不是沿用表格控件。 */
function LineInput({ className, ...props }: ComponentProps<'input'>) {
  return <Input className={cn('h-9 rounded-[9px] px-3', className)} {...props} />;
}

function CodeArea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <Textarea className={cn('rounded-[9px] px-3 py-2 leading-relaxed', className)} {...props} />
  );
}

function RuntimeTag() {
  return <FileTag>仅运行时</FileTag>;
}

function AgentEditor({
  agent,
  onDelete,
  onDirtyChange,
}: {
  agent: Agent;
  onDelete: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const update = useUpdateAgent();
  const servers = useServers();
  const skills = useSkills();
  const agents = useAgents();
  const [form, setForm] = useState<AgentInput>(() => toInput(agent));
  const [tab, setTab] = useState<'config' | 'files'>('config');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [openSections, setOpenSections] = useState<Record<SectionId, boolean>>({
    identity: false,
    behavior: true,
    capability: true,
    permissions: false,
    limits: false,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [exporting, setExporting] = useState(false);
  // 多行文本按行解析为数组；草稿单独保留，输入换行时不会被 join 规范化掉。
  const [allowedText, setAllowedText] = useState(() => agent.allowedTools.join('\n'));
  const allowedInvalid = allowedText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => /\s/.test(line));
  // 空值表示「不设置」，不能落成 0（schema 是可选正整数）。
  const [thinkingText, setThinkingText] = useState(() =>
    agent.maxThinkingTokens === undefined ? '' : String(agent.maxThinkingTokens),
  );
  const thinkingNumber = thinkingText.trim() === '' ? undefined : Number(thinkingText);
  const thinkingInvalid =
    thinkingNumber !== undefined && (!Number.isInteger(thinkingNumber) || thinkingNumber <= 0);

  const set = <K extends keyof AgentInput>(key: K, value: AgentInput[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key as string];
      return next;
    });
  };

  const setAllowedArray = (next: string[]): void => {
    set('allowedTools', next);
    setAllowedText(next.join('\n'));
  };

  const setAllowedToolsText = (value: string): void => {
    setAllowedText(value);
    set(
      'allowedTools',
      value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );
  };

  const setThinkingTextSafely = (value: string): void => {
    setThinkingText(value);
    const number = value.trim() === '' ? undefined : Number(value);
    set(
      'maxThinkingTokens',
      number !== undefined && Number.isInteger(number) && number > 0 ? number : undefined,
    );
  };

  const download = async (): Promise<void> => {
    setExporting(true);
    try {
      const data = await api.exportAgent(agent.id);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `${agent.slug}.agent.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      toastError(error);
    } finally {
      setExporting(false);
    }
  };

  const initial = useMemo(() => toInput(agent), [agent]);
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initial), [form, initial]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const boundServers = useMemo(
    () => (servers.data ?? []).filter((server) => form.serverIds.includes(server.id)),
    [servers.data, form.serverIds],
  );
  const boundSkills = useMemo(
    () => (skills.data ?? []).filter((skill) => form.skillIds.includes(skill.id)),
    [skills.data, form.skillIds],
  );
  const boundSubAgents = useMemo(
    () => (agents.data ?? []).filter((item) => form.subAgentIds.includes(item.id)),
    [agents.data, form.subAgentIds],
  );

  const serverOptions = (servers.data ?? []).map((server) => ({
    id: server.id,
    label: server.name,
    hint: server.kind,
    tag: server.kind,
  }));

  // 候选只能是还没有 parent 的顶层 agent，排除自己；已是子智能体时不能再委派。
  const subAgentOptions = (agents.data ?? [])
    .filter((item) => item.id !== agent.id && item.parentId === null)
    .map((item) => ({ id: item.id, label: item.name, hint: item.slug }));

  // generated server 的工具表可数；stdio/http 的工具只有连接后才确定。
  const generatedIds = boundServers
    .filter((server) => server.kind === 'generated')
    .map((server) => server.id);
  const toolQueries = useQueries({ queries: generatedIds.map((id) => toolsQuery(id)) });
  const toolCount = toolQueries.reduce(
    (sum, query) => sum + (query.data?.filter((tool) => tool.enabled).length ?? 0),
    0,
  );
  const toolCountPending = toolQueries.some((query) => query.isPending);
  const unknownServerCount = boundServers.length - generatedIds.length;
  const serverToolSummary =
    boundServers.length === 0
      ? '将获得 0 个工具'
      : `将获得 ${toolCountPending ? '…' : toolCount} 个工具${
          unknownServerCount > 0 ? ` · 另 ${unknownServerCount} 个 server 连接后确定` : ''
        }`;

  const hasSubAgents = form.subAgentIds.length > 0;
  /** 实际生效的内置工具状态：默认禁用 + 显式禁用，allowedTools 显式放行。 */
  const builtinEnabled = (tool: string): boolean => {
    // runner 只要 allowSubAgents 为真就放行 Agent/TaskStop，显式禁用拦不住。
    if ((tool === 'Agent' || tool === 'TaskStop') && hasSubAgents) return true;
    if (form.disallowedTools.includes(tool)) return false;
    return !DEFAULT_DISALLOWED_TOOLS.includes(tool) || form.allowedTools.includes(tool);
  };

  const toggleBuiltin = (tool: string): void => {
    // Agent/TaskStop 由子智能体绑定决定，开关不生效，避免写出误导性的 disallowedTools。
    if (tool === 'Agent' || tool === 'TaskStop') return;
    if (builtinEnabled(tool)) {
      setAllowedArray(form.allowedTools.filter((item) => item !== tool));
      if (!form.disallowedTools.includes(tool)) {
        set('disallowedTools', [...form.disallowedTools, tool]);
      }
      return;
    }
    setAllowedArray([...form.allowedTools, tool]);
    set(
      'disallowedTools',
      form.disallowedTools.filter((item) => item !== tool),
    );
  };

  const save = (): void => {
    if (allowedInvalid || thinkingInvalid) return;
    const parsed = agentInputSchema.safeParse(form);
    if (!parsed.success) {
      const issues = fieldErrors(parsed.error.issues);
      setErrors(issues);
      // 错误可能在折叠分区里；展开它，错误本身由 role="alert" 播报。
      setOpenSections((current) => {
        const next = { ...current };
        for (const key of Object.keys(issues)) {
          const section = errorSections[key];
          if (section) next[section] = true;
        }
        return next;
      });
      return;
    }
    update.mutate(
      { id: agent.id, input: parsed.data, expectedUpdatedAt: agent.updatedAt },
      {
        onSuccess: () => {
          setErrors({});
          toastSuccess('智能体已保存');
        },
        onError: (error) => {
          if (error instanceof ApiError && error.status === 409) {
            toast.error('配置已被修改，请刷新');
            return;
          }
          toastError(error);
        },
      },
    );
  };

  // 草稿预览与真实落盘共用 core 的渲染函数，只有 server 条目用占位符替换密钥。
  const draft = useMemo(
    () => draftFiles(form, boundServers, boundSkills, boundSubAgents),
    [form, boundServers, boundSkills, boundSubAgents],
  );
  const claudeDraft = draft.claudeMd;
  const fileDraft = [
    '// .mcp.json',
    draft.mcpJson,
    `// .claude/agents/${form.slug || '<slug>'}.md（主智能体，仅预览）`,
    draft.agentMd,
    ...(draft.subAgents.length > 0
      ? [
          '// 子智能体文件（各用自己的配置）',
          ...draft.subAgents.map((sub) => `// .claude/agents/${sub.slug}.md`),
        ]
      : []),
  ].join('\n');

  const sectionSummary: Record<SectionId, string> = {
    identity: form.slug || '未命名',
    behavior: form.model,
    capability: `${form.serverIds.length} server · ${form.skillIds.length} 技能 · ${form.subAgentIds.length} 子智能体`,
    permissions: `${form.permissionMode} · 放行 ${
      BUILTIN_TOOLS.filter((tool) => builtinEnabled(tool)).length
    } 个内置工具`,
    limits: `${form.maxTurns} 轮 · $${form.maxBudgetUsd}`,
  };

  return (
    <div className="min-w-0">
      <div className="flex h-14 items-center gap-2.5">
        <button
          type="button"
          role="switch"
          aria-checked={form.enabled}
          aria-label="启用智能体"
          title={form.enabled ? '已启用，点击停用' : '已停用，点击启用'}
          onClick={() => set('enabled', !form.enabled)}
          className="inline-flex items-center gap-2 rounded-[9px] p-1 text-xs text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <span
            className={cn(
              'inline-flex h-[18px] w-8 items-center rounded-full transition-colors',
              form.enabled ? 'bg-ink' : 'bg-line-strong',
            )}
            aria-hidden="true"
          >
            <span
              className={cn(
                'size-3.5 rounded-full bg-surface transition-transform',
                form.enabled ? 'translate-x-4' : 'translate-x-0.5',
              )}
            />
          </span>
          {form.enabled ? '已启用' : '已停用'}
        </button>
        <div className="ml-auto flex items-center gap-1.5">
          {dirty ? (
            <span className="mr-1 inline-flex items-center gap-1.5 text-2xs text-warning">
              <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />
              未保存
            </span>
          ) : null}
          <Button
            size="sm"
            className="h-8 rounded-full px-3.5"
            disabled={!dirty || update.isPending || allowedInvalid || thinkingInvalid}
            aria-busy={update.isPending}
            onClick={save}
          >
            {update.isPending ? (
              '保存中…'
            ) : dirty ? (
              '保存更改'
            ) : (
              <>
                <Check className="size-3.5" /> 已保存
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="版本历史"
            title="版本历史"
            onClick={() => setHistoryOpen(true)}
          >
            <History className="size-4" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="更多操作">
                <Ellipsis className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              sideOffset={4}
              className="w-40 rounded-[12px] border border-line bg-surface p-1 shadow-overlay"
            >
              <DropdownMenuItem disabled={exporting} onSelect={() => void download()}>
                <Download className="size-4" /> {exporting ? '导出中…' : '导出 JSON'}
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-line" />
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <Trash2 className="size-4" /> 删除智能体
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <Tabs
        label="智能体编辑视图"
        value={tab}
        onChange={setTab}
        size="sm"
        items={[
          { value: 'config', label: '配置' },
          { value: 'files', label: '完整文件' },
        ]}
      />

      {tab === 'config' ? (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (dirty && !update.isPending) save();
          }}
        >
          <nav
            aria-label="配置分区"
            className="sticky top-0 z-20 flex gap-0.5 overflow-x-auto border-b border-line bg-surface/95 py-1.5 backdrop-blur-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {sectionItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setOpenSections((current) => ({ ...current, [item.id]: true }));
                  document.getElementById(`agent-${item.id}`)?.scrollIntoView({ block: 'start' });
                }}
                className="shrink-0 rounded-[9px] px-2.5 py-1 text-sm text-muted transition-colors hover:bg-hover hover:text-fg"
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="pt-2">
            <Section
              id="identity"
              title="身份"
              summary={sectionSummary.identity}
              open={openSections.identity}
              onToggle={() =>
                setOpenSections((current) => ({ ...current, identity: !current.identity }))
              }
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <Label htmlFor="agent-name">
                      名称
                      <RequiredMark />
                    </Label>
                    <FileTag>→ CLAUDE.md</FileTag>
                  </div>
                  <LineInput
                    id="agent-name"
                    value={form.name}
                    aria-invalid={Boolean(errors.name)}
                    aria-describedby={errors.name ? 'agent-name-error' : undefined}
                    onChange={(event) => set('name', event.target.value)}
                  />
                  <FieldError id="agent-name-error">{errors.name}</FieldError>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <Label htmlFor="agent-slug">Slug</Label>
                    <FileTag>→ 工作区目录名</FileTag>
                  </div>
                  <LineInput
                    id="agent-slug"
                    value={form.slug}
                    className="font-mono"
                    readOnly
                    aria-describedby="agent-slug-hint"
                  />
                  <FieldHint id="agent-slug-hint">
                    创建后不可修改；子智能体文件名也是 .claude/agents/&lt;slug&gt;.md。
                  </FieldHint>
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <Label htmlFor="agent-desc">描述</Label>
                    <FileTag>→ .claude/agents/&lt;slug&gt;.md · description</FileTag>
                  </div>
                  <LineInput
                    id="agent-desc"
                    value={form.description}
                    placeholder="一句话说明它擅长什么"
                    onChange={(event) => set('description', event.target.value)}
                  />
                </div>
              </div>
            </Section>

            <Section
              id="behavior"
              title="行为"
              summary={sectionSummary.behavior}
              open={openSections.behavior}
              onToggle={() =>
                setOpenSections((current) => ({ ...current, behavior: !current.behavior }))
              }
            >
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <Label htmlFor="agent-prompt">系统提示词</Label>
                  <FileTag>→ CLAUDE.md</FileTag>
                </div>
                <CodeArea
                  id="agent-prompt"
                  rows={16}
                  value={form.systemPrompt}
                  className="font-mono text-xs leading-relaxed"
                  placeholder="描述角色、边界与工作方式；会写入 CLAUDE.md。"
                  onChange={(event) => set('systemPrompt', event.target.value)}
                />
              </div>

              <DraftPreview title="将写入 CLAUDE.md 的内容" code={claudeDraft} />

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <Label htmlFor="agent-model">模型</Label>
                    <FileTag>→ .claude/agents/&lt;slug&gt;.md</FileTag>
                  </div>
                  <LineInput
                    id="agent-model"
                    list="agent-models"
                    value={form.model}
                    className="font-mono"
                    onChange={(event) => set('model', event.target.value)}
                  />
                  <datalist id="agent-models">
                    {modelOptions(form.model).map((option) => (
                      <option key={option.value} value={option.value} />
                    ))}
                  </datalist>
                  <FieldHint>可以填任意网关模型 ID，下面是当前部署的建议值。</FieldHint>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <Label htmlFor="agent-effort">推理强度</Label>
                    <FileTag>→ .claude/agents/&lt;slug&gt;.md · effort</FileTag>
                  </div>
                  <Select
                    id="agent-effort"
                    value={form.effort ?? ''}
                    onValueChange={(value) =>
                      set('effort', value === '' ? undefined : (value as AgentInput['effort']))
                    }
                    options={[
                      { value: '', label: '默认' },
                      { value: 'low', label: 'low' },
                      { value: 'medium', label: 'medium' },
                      { value: 'high', label: 'high' },
                      { value: 'xhigh', label: 'xhigh' },
                      { value: 'max', label: 'max' },
                    ]}
                  />
                </div>
              </div>
            </Section>

            <Section
              id="capability"
              title="能力"
              summary={sectionSummary.capability}
              open={openSections.capability}
              onToggle={() =>
                setOpenSections((current) => ({ ...current, capability: !current.capability }))
              }
            >
              <div className="divide-y divide-line border-y border-line">
                <div className="py-3">
                  <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="flex items-center gap-1.5 text-xs text-muted">
                      <Plug className="size-4 text-subtle" aria-hidden="true" /> MCP Servers
                      <FileTag>→ .mcp.json · mcpServers.&lt;name&gt;</FileTag>
                    </h3>
                    <span className="font-mono text-2xs tabular-nums text-subtle">
                      {serverToolSummary}
                    </span>
                  </div>
                  {servers.isPending ? <LoadingState rows={1} /> : null}
                  {servers.isError ? (
                    <ErrorState error={servers.error} onRetry={() => void servers.refetch()} />
                  ) : null}
                  {servers.data && servers.data.length === 0 ? (
                    <p className="text-xs text-muted">
                      还没有可绑定的 server，先去 MCP Servers 页面创建。
                    </p>
                  ) : null}
                  {servers.data && servers.data.length > 0 ? (
                    <MultiSelect
                      label="MCP Server"
                      options={serverOptions}
                      value={form.serverIds}
                      onChange={(next) => set('serverIds', next)}
                      placeholder="搜索并选择 server…"
                      emptyText="没有匹配的 server"
                    />
                  ) : null}
                  <p className="mt-1.5 text-2xs text-subtle">
                    绑定后智能体可使用
                    <code className="mx-1 font-mono text-muted">mcp__&lt;server&gt;__*</code>
                    工具；密钥只在运行时注入。
                  </p>
                </div>

                <div className="py-3">
                  <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="flex items-center gap-1.5 text-xs text-muted">
                      <Sparkles className="size-4 text-subtle" aria-hidden="true" /> 技能
                      <FileTag>→ .claude/skills/&lt;slug&gt;/SKILL.md</FileTag>
                    </h3>
                    <span className="font-mono text-2xs tabular-nums text-subtle">
                      选中 {form.skillIds.length} 个 · 不新增工具
                    </span>
                  </div>
                  {skills.isPending ? <LoadingState rows={1} /> : null}
                  {skills.data && skills.data.length === 0 ? (
                    <p className="text-xs text-muted">
                      还没有技能。技能是可复用的操作流程，会渲染为
                      <code className="mx-1 font-mono text-muted">
                        .claude/skills/&lt;slug&gt;/SKILL.md
                      </code>
                      供智能体按需读取。
                    </p>
                  ) : null}
                  {skills.data && skills.data.length > 0 ? (
                    <MultiSelect
                      label="技能"
                      options={skills.data.map((skill) => ({
                        id: skill.id,
                        label: skill.name,
                        hint: skill.description,
                      }))}
                      value={form.skillIds}
                      onChange={(next) => set('skillIds', next)}
                      placeholder="搜索并选择技能…"
                      emptyText="没有匹配的技能"
                    />
                  ) : null}
                  <p className="mt-1.5 text-2xs text-subtle">
                    技能不注册新工具；已选技能的 slug 同时写进 agent md 的
                    <code className="mx-1 font-mono text-muted">skills</code>。
                  </p>
                </div>

                <div className="py-3">
                  <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="flex items-center gap-1.5 text-xs text-muted">
                      <Bot className="size-4 text-subtle" aria-hidden="true" /> 子智能体
                      <FileTag>→ .claude/agents/&lt;slug&gt;.md</FileTag>
                    </h3>
                    <span className="font-mono text-2xs tabular-nums text-subtle">
                      将获得 {hasSubAgents ? 1 : 0} 个工具（Agent）
                    </span>
                  </div>
                  {agent.parentId !== null ? (
                    <p className="text-xs text-muted">
                      它本身已经是子智能体，不能再委派。子智能体只支持一层。
                    </p>
                  ) : subAgentOptions.length === 0 ? (
                    <p className="text-xs text-muted">
                      没有可选的主智能体。只有「没有父级」的智能体才能被委派。
                    </p>
                  ) : (
                    <MultiSelect
                      label="子智能体"
                      options={subAgentOptions}
                      value={form.subAgentIds}
                      onChange={(next) => set('subAgentIds', next)}
                      placeholder="搜索并选择子智能体…"
                      emptyText="没有匹配的智能体"
                    />
                  )}
                  <p className="mt-1.5 text-2xs text-subtle">
                    选中后主智能体获得 <code className="font-mono text-muted">Agent</code> 工具，
                    子智能体定义渲染到{' '}
                    <code className="font-mono text-muted">.claude/agents/&lt;slug&gt;.md</code>。
                  </p>
                </div>
              </div>

              <DraftPreview title="将写入 .mcp.json 与 frontmatter" code={fileDraft} />
            </Section>

            <Section
              id="permissions"
              title="权限"
              summary={sectionSummary.permissions}
              open={openSections.permissions}
              onToggle={() =>
                setOpenSections((current) => ({ ...current, permissions: !current.permissions }))
              }
            >
              <p className="rounded-[9px] bg-warning-soft px-3 py-2 text-xs leading-relaxed text-warning">
                放行内置工具会扩大攻击面：Bash、文件写入和网络访问都绕过沙盒的只读约定。
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <Label htmlFor="agent-perm">权限模式</Label>
                    <RuntimeTag />
                  </div>
                  <Select
                    id="agent-perm"
                    className="h-9 rounded-[9px]"
                    value={form.permissionMode}
                    onValueChange={(next) =>
                      set('permissionMode', next as AgentInput['permissionMode'])
                    }
                    options={[
                      { value: 'dontAsk', label: 'dontAsk — 拒绝未预批准' },
                      { value: 'plan', label: 'plan — 只规划不执行' },
                      { value: 'default', label: 'default — 标准权限' },
                      { value: 'acceptEdits', label: 'acceptEdits — 自动接受编辑' },
                    ]}
                  />
                  <FieldHint>
                    auto 依赖模型分类器，平台无法审计，因此不开放。该值只传给 SDK，不写文件。
                  </FieldHint>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <Label htmlFor="agent-allowed-tools">自定义允许的工具</Label>
                    <FileTag>→ agent md · tools</FileTag>
                  </div>
                  <CodeArea
                    id="agent-allowed-tools"
                    rows={3}
                    value={allowedText}
                    className="font-mono text-xs leading-relaxed"
                    placeholder={'mcp__jsonplaceholder__get_user\nmcp__crm__*'}
                    aria-invalid={allowedInvalid}
                    aria-describedby={
                      allowedInvalid ? 'agent-allowed-tools-error' : 'agent-allowed-tools-hint'
                    }
                    onChange={(event) => setAllowedToolsText(event.target.value)}
                  />
                  {allowedInvalid ? (
                    <FieldError id="agent-allowed-tools-error">
                      每行只能有一个工具名或模式，不能包含空格。
                    </FieldError>
                  ) : (
                    <FieldHint id="agent-allowed-tools-hint">
                      每行一个模式，例如 mcp__jsonplaceholder__get_user、mcp__crm__*。留空表示
                      「所有已绑定 server 的全部工具」。
                    </FieldHint>
                  )}
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <span className="text-xs text-subtle">内置工具</span>
                  <FileTag>→ agent md · tools / disallowedTools</FileTag>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {BUILTIN_TOOLS.map((tool) => {
                    const enabled = builtinEnabled(tool);
                    const fixed = tool === 'Agent' || tool === 'TaskStop';
                    return (
                      <button
                        key={tool}
                        type="button"
                        aria-pressed={enabled}
                        disabled={fixed}
                        onClick={() => toggleBuiltin(tool)}
                        title={
                          fixed
                            ? enabled
                              ? '由子智能体绑定放行；解绑子智能体后自动禁用'
                              : '绑定子智能体后自动放行'
                            : enabled
                              ? '已放行：点击禁用'
                              : '已禁用：点击放行'
                        }
                        className={cn(
                          'rounded-[6px] px-2 py-1 font-mono text-2xs transition-colors',
                          enabled
                            ? 'bg-warning-soft text-warning'
                            : 'bg-chip text-subtle hover:bg-hover hover:text-muted',
                          fixed && 'cursor-default opacity-80',
                        )}
                      >
                        {tool}
                        <span className="sr-only">
                          {enabled ? '：已启用' : '：已禁用'}
                          {fixed ? '，由子智能体绑定决定' : ''}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <FieldHint>
                  默认全部禁用。放行状态 = 不在默认禁用名单且未被显式禁用，或在允许列表里；
                  有子智能体时 Agent/TaskStop 自动放行。runner 对 Bash/文件/网络工具仍有硬限制。
                </FieldHint>
              </div>
            </Section>

            <Section
              id="limits"
              title="运行限制"
              summary={sectionSummary.limits}
              open={openSections.limits}
              onToggle={() =>
                setOpenSections((current) => ({ ...current, limits: !current.limits }))
              }
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <Label htmlFor="agent-turns">最大轮次</Label>
                    <FileTag>→ agent md · maxTurns</FileTag>
                  </div>
                  <LineInput
                    id="agent-turns"
                    type="number"
                    min={1}
                    inputMode="numeric"
                    value={form.maxTurns}
                    aria-invalid={Boolean(errors.maxTurns)}
                    aria-describedby={errors.maxTurns ? 'agent-turns-error' : undefined}
                    onChange={(event) => set('maxTurns', Number(event.target.value))}
                  />
                  <FieldError id="agent-turns-error">{errors.maxTurns}</FieldError>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <Label htmlFor="agent-budget">预算上限 (USD)</Label>
                    <RuntimeTag />
                  </div>
                  <LineInput
                    id="agent-budget"
                    type="number"
                    min={0.01}
                    step={0.01}
                    inputMode="decimal"
                    value={form.maxBudgetUsd}
                    aria-invalid={Boolean(errors.maxBudgetUsd)}
                    aria-describedby={errors.maxBudgetUsd ? 'agent-budget-error' : undefined}
                    onChange={(event) => set('maxBudgetUsd', Number(event.target.value))}
                  />
                  <FieldError id="agent-budget-error">{errors.maxBudgetUsd}</FieldError>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <Label htmlFor="agent-timeout">超时 (毫秒)</Label>
                    <RuntimeTag />
                  </div>
                  <LineInput
                    id="agent-timeout"
                    type="number"
                    min={1000}
                    step={1000}
                    inputMode="numeric"
                    value={form.timeoutMs}
                    aria-invalid={Boolean(errors.timeoutMs)}
                    aria-describedby={errors.timeoutMs ? 'agent-timeout-error' : undefined}
                    onChange={(event) => set('timeoutMs', Number(event.target.value))}
                  />
                  <FieldError id="agent-timeout-error">{errors.timeoutMs}</FieldError>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <Label htmlFor="agent-thinking">最大思考 tokens</Label>
                    <RuntimeTag />
                  </div>
                  <LineInput
                    id="agent-thinking"
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    value={thinkingText}
                    placeholder="不设置"
                    aria-invalid={thinkingInvalid}
                    aria-describedby={
                      thinkingInvalid ? 'agent-thinking-error' : 'agent-thinking-hint'
                    }
                    onChange={(event) => setThinkingTextSafely(event.target.value)}
                  />
                  {thinkingInvalid ? (
                    <FieldError id="agent-thinking-error">
                      请输入大于 0 的整数，或留空表示不设置。
                    </FieldError>
                  ) : (
                    <FieldHint id="agent-thinking-hint">
                      留空表示不设置；只传给 SDK，不写文件。
                    </FieldHint>
                  )}
                </div>
              </div>
            </Section>
          </div>
        </form>
      ) : (
        <FilesPreview agentId={agent.id} dirty={dirty} />
      )}

      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent
          side="right"
          showCloseButton={false}
          aria-describedby={undefined}
          className="w-full max-w-[480px] gap-0 border-l border-line bg-surface p-0 shadow-overlay sm:max-w-[480px]"
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-3.5">
            <div className="min-w-0">
              <SheetTitle className="text-md font-semibold text-fg">版本历史</SheetTitle>
              <SheetDescription className="mt-1 text-xs leading-relaxed text-muted">
                每次保存生成一份快照。回滚会覆盖当前配置并生成新版本。
              </SheetDescription>
            </div>
            <SheetClose
              aria-label="关闭"
              className="-mr-1 rounded-[7px] p-1.5 text-subtle transition-colors hover:bg-sunken hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg"
            >
              <X className="size-4" />
            </SheetClose>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <VersionHistory
              agentId={agent.id}
              current={agent}
              active={historyOpen}
              onRolledBack={(next) => {
                setForm(toInput(next));
                setAllowedText(next.allowedTools.join('\n'));
                setThinkingText(
                  next.maxThinkingTokens === undefined ? '' : String(next.maxThinkingTokens),
                );
                setErrors({});
                setHistoryOpen(false);
              }}
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Section({
  id,
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  id: SectionId;
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  const headingId = `agent-${id}-heading`;
  return (
    <section
      id={`agent-${id}`}
      aria-labelledby={headingId}
      className="scroll-mt-24 border-t border-line py-1 first:border-t-0"
    >
      <Collapsible open={open} onOpenChange={onToggle}>
        <h2>
          <CollapsibleTrigger
            id={headingId}
            className="flex w-full items-center gap-1.5 rounded-[7px] py-2.5 text-left text-xs text-subtle transition-colors hover:text-fg"
          >
            <ChevronRight
              className={cn(
                'size-3.5 shrink-0 text-subtle transition-transform duration-150',
                open && 'rotate-90',
              )}
              aria-hidden="true"
            />
            {title}
            <span className="ml-auto max-w-[60%] truncate font-mono text-2xs tabular-nums text-subtle">
              {summary}
            </span>
          </CollapsibleTrigger>
        </h2>
        {/* forceMount 保留 DOM（收起时 Radix 置 hidden）：校验错误仍能被 aria-describedby 找到。 */}
        <CollapsibleContent forceMount>
          <motion.div
            initial={false}
            animate={open ? { height: 'auto' } : { height: 0 }}
            transition={reduce ? { duration: 0 } : { duration: 0.15, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div hidden={!open} className="space-y-4 pb-5">
              {children}
            </div>
          </motion.div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

/** 草稿预览：折叠在表单里，内容随表单实时变化。 */
function DraftPreview({ title, code }: { title: string; code: string }) {
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-[9px] border border-line">
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1.5 rounded-[9px] px-3 py-2.5 text-xs text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg">
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-subtle transition-transform duration-150',
            open && 'rotate-90',
          )}
          aria-hidden="true"
        />
        {title}
        <span className="ml-auto font-mono text-2xs text-subtle">草稿 · 实时</span>
      </CollapsibleTrigger>
      {/* 高度动画由 motion 管，Radix 负责 open 状态和 trigger/content 的 aria 关联。 */}
      <CollapsibleContent forceMount>
        <AnimatePresence initial={false}>
          {open ? (
            <motion.div
              key="body"
              initial={{ height: 0 }}
              animate={{ height: 'auto' }}
              exit={{ height: 0 }}
              transition={reduce ? { duration: 0 } : { duration: 0.15, ease: 'easeOut' }}
              className="overflow-hidden"
            >
              <div className="border-t border-line p-2">
                <CodeBlock code={code} maxHeight="22rem" />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * 草稿预览直接调用 core 的渲染函数——不复制实现。
 *
 * 之前这里有一份「同构」副本，结果 core 新增「等待规则」与子智能体表格后
 * 副本没有跟上，预览与真实落盘内容出现差异，正好违背「配置即契约」。
 * core/workspace.ts 是纯函数、无 Node 依赖，浏览器可直接用。
 */
function draftFiles(
  form: AgentInput,
  servers: Server[],
  skills: Array<{ slug: string; name: string; description: string; body: string }>,
  subAgents: Array<{
    slug: string;
    name: string;
    description: string;
    model: string;
    systemPrompt: string;
    maxTurns: number;
    timeoutMs: number;
    allowedTools: string[];
    disallowedTools: string[];
  }>,
): WorkspaceFiles {
  return renderWorkspace({
    agent: {
      slug: form.slug,
      name: form.name,
      description: form.description,
      model: form.model,
      systemPrompt: form.systemPrompt,
      maxTurns: form.maxTurns,
      permissionMode: form.permissionMode,
      effort: form.effort ?? null,
      allowedTools: form.allowedTools,
      disallowedTools: form.disallowedTools,
    },
    // 预览只给键名：真实密钥永不出现在这里。
    servers: servers.map((server) => ({
      name: server.name,
      entry: previewEntry(server),
    })),
    skills,
    subAgents: subAgents.map((sub) => ({ ...sub, effort: null })),
    ...(form.allowedTools.length > 0 ? { toolsAllow: form.allowedTools } : {}),
    ...(form.disallowedTools.length > 0 ? { toolsDeny: form.disallowedTools } : {}),
  });
}

/** `.mcp.json` 预览条目：密钥替换为占位符。 */
function previewEntry(server: Server): McpJsonEntry {
  if (server.kind === 'stdio') {
    return {
      command: server.command,
      args: server.args,
      env: Object.fromEntries(Object.keys(server.env).map((key) => [key, '<已配置>'])),
    };
  }
  if (server.kind === 'http') {
    return {
      type: 'http',
      url: server.url,
      headers: Object.fromEntries(Object.keys(server.headers).map((key) => [key, '<已配置>'])),
    };
  }
  return {
    type: 'http',
    url: `<平台 /mcp/${server.id}>`,
    headers: { Authorization: '<运行时注入>' },
  };
}

const fileTabs = [
  ['mcpJson', '.mcp.json', FileCode],
  ['claudeMd', 'CLAUDE.md', FileText],
  ['agentMd', 'agent md', FileText],
] as const;

/** 完整文件来自上次保存；编辑中的草稿在内联预览里。 */
function FilesPreview({ agentId, dirty }: { agentId: string; dirty: boolean }) {
  const files = useAgentFiles(agentId);
  const [which, setWhich] = useState<(typeof fileTabs)[number][0]>('mcpJson');

  const disabled = files.isPending || files.isError || !files.data;
  const active = fileTabs.find(([key]) => key === which) ?? fileTabs[0];
  const content = files.data?.[active[0]] ?? '';

  return (
    <div className="space-y-3">
      <p className="rounded-[9px] bg-chip px-3 py-2 text-xs leading-relaxed text-muted">
        密钥在运行时注入，此处显示为占位符。
        {dirty ? ' 这里是上次保存后的完整文件；编辑中的草稿请回「配置」看内联预览。' : ''}
      </p>
      <Tabs
        label="工作区文件"
        value={which}
        onChange={setWhich}
        items={fileTabs.map(([value, label, Icon]) => ({
          value,
          label,
          icon: <Icon className="size-4" />,
        }))}
      />
      {files.isPending ? <LoadingState rows={6} /> : null}
      {files.isError ? (
        <ErrorState error={files.error} onRetry={() => void files.refetch()} />
      ) : null}
      {!disabled && content ? (
        <CodeBlock key={active[0]} code={content} lineNumbers maxHeight="calc(100vh - 22rem)" />
      ) : null}
      {!disabled && !content ? (
        <InlineEmpty>该文件当前为空。保存配置后会自动生成内容。</InlineEmpty>
      ) : null}
      <p className="py-2 text-2xs text-subtle">
        主智能体自己的 agent md 仅供预览、不落盘；路径{' '}
        <code className="font-mono">data/workspaces/{'{slug}'}/</code>
      </p>
    </div>
  );
}

const diffFields: ReadonlyArray<readonly [keyof Agent, string]> = [
  ['name', '名称'],
  ['description', '描述'],
  ['model', '模型'],
  ['systemPrompt', '系统提示词'],
  ['serverIds', 'MCP Servers'],
  ['skillIds', '技能'],
  ['subAgentIds', '子智能体'],
  ['allowedTools', '允许的工具'],
  ['disallowedTools', '禁用的工具'],
  ['permissionMode', '权限模式'],
  ['maxTurns', '最大轮次'],
  ['maxBudgetUsd', '预算上限'],
  ['timeoutMs', '超时'],
  ['effort', '推理强度'],
  ['maxThinkingTokens', '最大思考 tokens'],
  ['enabled', '启用状态'],
];

function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '空';
  if (Array.isArray(value)) return value.length === 0 ? '空' : `${value.length} 项`;
  if (typeof value === 'boolean') return value ? '启用' : '停用';
  const text = String(value);
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

function diffAgent(
  current: Agent,
  snapshot: Agent,
): Array<{ label: string; from: string; to: string }> {
  return diffFields
    .filter(([key]) => JSON.stringify(current[key]) !== JSON.stringify(snapshot[key]))
    .map(([key, label]) => ({
      label,
      from: displayValue(current[key]),
      to: displayValue(snapshot[key]),
    }));
}

function VersionHistory({
  agentId,
  current,
  active,
  onRolledBack,
}: {
  agentId: string;
  current: Agent;
  active: boolean;
  onRolledBack: (agent: Agent) => void;
}) {
  const versions = useAgentVersions(agentId, active);
  const rollback = useRollbackAgent();
  const [pending, setPending] = useState<AgentVersionSummary | null>(null);
  const pendingDetail = useAgentVersion(agentId, pending?.version ?? 0, pending !== null);
  const pendingDiff =
    pending !== null && pendingDetail.data ? diffAgent(current, pendingDetail.data.snapshot) : null;

  return (
    <div className="space-y-3">
      {versions.isPending ? <LoadingState rows={4} /> : null}
      {versions.isError ? (
        <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />
      ) : null}
      {versions.data && versions.data.length === 0 ? (
        <InlineEmpty>还没有版本记录。修改配置并保存后，这里会留下第一份快照。</InlineEmpty>
      ) : null}
      {versions.data && versions.data.length > 0 ? (
        <ul className="divide-y divide-line border-y border-line">
          {versions.data.map((item) => (
            <VersionRow
              key={item.id}
              agentId={agentId}
              item={item}
              current={current}
              onRollback={() => setPending(item)}
            />
          ))}
        </ul>
      ) : null}

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={`回滚到 v${pending?.version ?? ''}`}
        description={
          pendingDiff === null
            ? '正在读取该版本的差异…'
            : pendingDiff.length === 0
              ? '该版本与当前配置一致，回滚不会改变字段。仍会生成一个新版本。'
              : `将把 ${pendingDiff.length} 个字段改为该版本的值：${pendingDiff
                  .map((entry) => entry.label)
                  .join('、')}。当前配置会被覆盖，并生成一个新版本。`
        }
        confirmLabel="回滚"
        onConfirm={async () => {
          if (!pending) return;
          const agent = await rollback.mutateAsync({ id: agentId, version: pending.version });
          onRolledBack(agent);
          toastSuccess(`已回滚到 v${pending.version}`);
        }}
      />
    </div>
  );
}

function VersionRow({
  agentId,
  item,
  current,
  onRollback,
}: {
  agentId: string;
  item: AgentVersionSummary;
  current: Agent;
  onRollback: () => void;
}) {
  const [open, setOpen] = useState(false);
  const detail = useAgentVersion(agentId, item.version, open);
  const diff = detail.data ? diffAgent(current, detail.data.snapshot) : null;

  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-medium tabular-nums text-fg">
              v{item.version}
            </span>
            {item.note ? (
              <span className="truncate rounded-[6px] bg-chip px-1.5 py-0.5 text-2xs text-muted">
                {item.note}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 font-mono text-2xs tabular-nums text-subtle">
            {formatDateTime(item.createdAt)}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronRight
              className={cn('size-4 transition-transform', open && 'rotate-90')}
              aria-hidden="true"
            />
            {open ? '收起差异' : '查看差异'}
          </Button>
          <Button variant="outline" size="sm" className="rounded-full" onClick={onRollback}>
            <RotateCcw className="size-4" /> 回滚
          </Button>
        </div>
      </div>
      {open ? (
        <div className="mt-2">
          {detail.isPending ? <LoadingState rows={2} /> : null}
          {detail.isError ? (
            <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
          ) : null}
          {diff && diff.length === 0 ? (
            <p className="text-2xs text-subtle">与当前配置一致。</p>
          ) : null}
          {diff && diff.length > 0 ? (
            <ul className="divide-y divide-line border-y border-line">
              {diff.map((entry) => (
                <li
                  key={entry.label}
                  className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 py-1.5 text-2xs"
                >
                  <span className="text-subtle">{entry.label}</span>
                  <span className="break-all text-fg">
                    <span className="text-muted">{entry.from}</span>
                    <span className="mx-1 text-subtle" aria-hidden="true">
                      →
                    </span>
                    <span>{entry.to}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function CreateAgentDialog({
  onClose,
  onCreated,
  returnFocusRef,
}: {
  onClose: () => void;
  onCreated: (agent: Agent) => void;
  returnFocusRef: { current: HTMLElement | null };
}) {
  const create = useCreateAgent();
  const [form, setForm] = useState<AgentInput>(emptyInput);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = (): void => {
    const parsed = agentInputSchema.safeParse({
      ...form,
      name: form.name.trim() || form.slug,
    });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    create.mutate(parsed.data, {
      onSuccess: (agent) => {
        toastSuccess('智能体已创建');
        onCreated(agent);
      },
      onError: (error) => toastError(error),
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="新建智能体"
      description="创建后可继续配置提示词、绑定 server 与运行时限制。"
      returnFocusRef={returnFocusRef}
    >
      <form
        className="space-y-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="new-agent-slug">
              Slug
              <RequiredMark />
            </Label>
            <LineInput
              id="new-agent-slug"
              value={form.slug}
              placeholder="support-bot"
              className="font-mono"
              aria-invalid={Boolean(errors.slug)}
              aria-describedby={errors.slug ? 'new-agent-slug-error' : 'new-agent-slug-hint'}
              onChange={(event) => setForm({ ...form, slug: event.target.value })}
            />
            {errors.slug ? (
              <FieldError id="new-agent-slug-error">{errors.slug}</FieldError>
            ) : (
              <FieldHint id="new-agent-slug-hint">
                小写字母、数字、- 和 _；创建后不可修改。
              </FieldHint>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-agent-name">名称</Label>
            <LineInput
              id="new-agent-name"
              value={form.name}
              placeholder="客服助手"
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-agent-model">模型</Label>
          <Select
            id="new-agent-model"
            value={form.model}
            onValueChange={(model) => setForm({ ...form, model })}
            options={modelOptions(form.model)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-agent-prompt">系统提示词</Label>
          <CodeArea
            id="new-agent-prompt"
            rows={5}
            className="font-mono text-xs"
            value={form.systemPrompt}
            onChange={(event) => setForm({ ...form, systemPrompt: event.target.value })}
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            size="sm"
            className="rounded-full px-3.5"
            disabled={create.isPending}
            aria-busy={create.isPending}
          >
            {create.isPending ? '创建中…' : '创建'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
