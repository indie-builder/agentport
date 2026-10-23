// 只引用纯函数子路径：core 根入口还导出 node:crypto 相关模块，浏览器不能加载。

import type { McpJsonEntry } from '@agentport/core/tools';
import {
  DEFAULT_DISALLOWED_TOOLS,
  renderWorkspace,
  type WorkspaceFiles,
} from '@agentport/core/workspace';
import {
  AGENT_PACKAGE_MAX_BYTES,
  AGENT_ROLES,
  type Agent,
  type AgentInput,
  agentInputSchema,
  BUILTIN_TOOLS,
  type Server,
  serializeAgentPackage,
} from '@agentport/shared';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  ArrowLeft,
  BarChart3,
  Bot,
  Brain,
  Check,
  ChevronRight,
  Download,
  Ellipsis,
  FileCode,
  FileText,
  History,
  Palette,
  Plug,
  Plus,
  RotateCcw,
  ScrollText,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  type ComponentProps,
  Fragment,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import digitalTwinPortrait from '../assets/agents/digital-twin.png';
import { AgentAvatar, createShowcaseAvatars } from '../components/agent-avatar.js';
import { CodeBlock } from '../components/code-block.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { DialogShell } from '../components/dialog-shell.js';
import { FilterSelect } from '../components/filter-select.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../components/motion-collapsible.js';
import { Page, PageHeader, PageNote } from '../components/page.js';
import { RequiredMark } from '../components/required-mark.js';
import { ResourcePage } from '../components/resource-page.js';
import { ErrorState, InlineEmpty, LoadingState } from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { Button } from '../components/ui/button.js';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../components/ui/card.js';
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from '../components/ui/combobox.js';
import { Dialog } from '../components/ui/dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu.js';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '../components/ui/sheet.js';
import { Switch } from '../components/ui/switch.js';
import { Textarea } from '../components/ui/textarea.js';
import type { AgentFiles, AgentVersionSummary } from '../lib/api.js';
import { ApiError, api } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { fieldErrors, useFormBlocker } from '../lib/form.js';
import { formatDateTime } from '../lib/format.js';
import {
  toolsQuery,
  useAgent,
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
import { MemoryPanel, OutputStylesPanel, RulesPanel } from './memory-panel.js';
import { AgentStatsPanel } from './ops.js';

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

const roleOptions = AGENT_ROLES.map((role) => ({ value: role, label: role }));

const emptyInput: AgentInput = {
  slug: '',
  name: '',
  role: '通用助手',
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
    role: agent.role?.trim() ? agent.role : '通用助手',
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
  const navigate = useNavigate();
  const search = useSearch({ from: '/shell/agents' });
  const query = search.q ?? '';
  const sort = search.sort ?? 'newest';
  const status = search.status ?? '';
  const role = search.role ?? '';
  const [creating, setCreating] = useState(false);
  const [initialRole, setInitialRole] = useState('通用助手');
  const [deleting, setDeleting] = useState<Agent | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const editorTriggerRef = useRef<HTMLButtonElement | null>(null);
  const remove = useDeleteAgent();

  const importFile = async (file: File): Promise<void> => {
    setImporting(true);
    try {
      const isMarkdown = file.name.toLowerCase().endsWith('.md');
      if (file.size > (isMarkdown ? 131072 : AGENT_PACKAGE_MAX_BYTES)) {
        toastError(
          new Error(
            isMarkdown ? 'agent.md 不能超过 128 KB，请精简后重试。' : '导入文件不能超过 1 MiB。',
          ),
        );
        return;
      }
      const text = await file.text();
      const result = isMarkdown
        ? await api.importAgentFile(text)
        : await api.importAgent(JSON.parse(text));
      await Promise.all(
        ['agents', 'servers', 'skills', 'overview'].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      );
      const suffix = result.warnings.length > 0 ? `，${result.warnings.length} 条提示` : '';
      toastSuccess(`已导入「${result.agent.name}」${suffix}`);
      // 导入提示随路由状态带到配置页，在那边一次性展示后清掉。
      void navigate({
        to: '/agents/$agentId',
        params: { agentId: result.agent.id },
        state: { importWarnings: [...new Set(result.warnings)] } as unknown as true,
      });
    } catch (error) {
      toastError(error);
    } finally {
      setImporting(false);
    }
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (agents.data ?? [])
      .filter(
        (agent) =>
          (!status || agent.enabled === (status === 'enabled')) &&
          (!role || (agent.role?.trim() || '通用助手') === role) &&
          [agent.name, agent.slug, agent.description, agent.role?.trim() || '通用助手']
            .join(' ')
            .toLowerCase()
            .includes(needle),
      )
      .sort((a, b) =>
        sort === 'name'
          ? a.name.localeCompare(b.name, 'zh-CN')
          : Date.parse(b.createdAt) - Date.parse(a.createdAt),
      );
  }, [agents.data, query, sort, status, role]);

  const openAgent = (id: string): void => {
    void navigate({ to: '/agents/$agentId', params: { agentId: id } });
  };

  return (
    <ResourcePage
      section="agents"
      query={query}
      onQueryChange={(q) => {
        void navigate({ to: '/agents', search: { ...search, q: q || undefined }, replace: true });
      }}
      sort={sort}
      onSortChange={(next) => {
        void navigate({
          to: '/agents',
          search: { ...search, sort: next === 'newest' ? undefined : next },
        });
      }}
      count={filtered.length}
      status={agents.status}
      filters={
        <>
          <FilterSelect
            value={status}
            onValueChange={(next) => {
              if (next !== '' && next !== 'enabled' && next !== 'disabled') return;
              void navigate({ to: '/agents', search: { ...search, status: next || undefined } });
            }}
            options={[
              { value: '', label: '全部状态' },
              { value: 'enabled', label: '已启用' },
              { value: 'disabled', label: '已停用' },
            ]}
            label="按启用状态筛选"
            className="w-32"
          />
          <FilterSelect
            value={role}
            onValueChange={(next) => {
              const valid =
                next === '' || AGENT_ROLES.includes(next as (typeof AGENT_ROLES)[number]);
              if (!valid) return;
              void navigate({
                to: '/agents',
                search: {
                  ...search,
                  role: next === '' ? undefined : (next as (typeof AGENT_ROLES)[number]),
                },
              });
            }}
            options={[
              { value: '', label: '全部角色' },
              ...AGENT_ROLES.map((item) => ({ value: item, label: item })),
            ]}
            label="按角色筛选"
            className="w-36"
          />
        </>
      }
      actions={
        <>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json,text/markdown,.md"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importFile(file);
            }}
          />
          <Button
            variant="outline"
            title="导入专家 JSON 或 agent.md"
            disabled={importing}
            aria-busy={importing}
            onClick={(event) => {
              editorTriggerRef.current = event.currentTarget;
              fileInput.current?.click();
            }}
          >
            <Upload data-icon="inline-start" /> {importing ? '导入中…' : '导入'}
          </Button>
          <Button
            ref={createButtonRef}
            disabled={importing}
            onClick={(event) => {
              editorTriggerRef.current = event.currentTarget;
              setInitialRole('通用助手');
              setCreating(true);
            }}
          >
            <Plus data-icon="inline-start" /> 新建专家
          </Button>
        </>
      }
    >
      {agents.isPending ? <LoadingState rows={4} layout="cards" /> : null}
      {agents.isError ? (
        <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
      ) : null}
      {agents.data && agents.data.length === 0 ? (
        <PageNote
          icon={<Bot />}
          title="创建专家，绑定技能和连接器，即可在对话中使用。"
          action={
            <Button
              disabled={importing}
              onClick={(event) => {
                editorTriggerRef.current = event.currentTarget;
                setInitialRole('通用助手');
                setCreating(true);
              }}
            >
              新建专家
            </Button>
          }
        />
      ) : null}
      {agents.data && agents.data.length > 0 && filtered.length === 0 ? (
        <PageNote
          title="没有匹配的专家。"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void navigate({
                  to: '/agents',
                  search: { ...search, q: undefined, status: undefined, role: undefined },
                })
              }
            >
              清除筛选
            </Button>
          }
        />
      ) : null}

      <ul
        aria-label="专家列表"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
      >
        {filtered.length > 0 ? (
          <li className="min-w-0">
            <button
              type="button"
              aria-label="新建专家"
              disabled={importing}
              onClick={(event) => {
                editorTriggerRef.current = event.currentTarget as HTMLButtonElement;
                setInitialRole('通用助手');
                setCreating(true);
              }}
              className="agent-create-fan h-full min-h-52 w-full disabled:pointer-events-none disabled:opacity-60"
            >
              <span className="agent-create-fan__art" aria-hidden="true">
                {createShowcaseAvatars.map((src) => (
                  <span key={src} className="agent-create-fan__chip">
                    <img src={src} alt="" />
                  </span>
                ))}
              </span>
              <span className="agent-create-fan__label">
                <Plus aria-hidden="true" />
                <span>新建专家</span>
              </span>
            </button>
          </li>
        ) : null}
        {agents.data ? (
          <li className="min-w-0">
            <Card className="h-full">
              <CardContent className="flex flex-1 flex-col items-center justify-center gap-4">
                <img
                  src={digitalTwinPortrait}
                  alt=""
                  className="size-20 rounded-full object-cover"
                />
                <Button
                  variant="outline"
                  disabled={importing}
                  onClick={(event) => {
                    editorTriggerRef.current = event.currentTarget;
                    setInitialRole('数字分身');
                    setCreating(true);
                  }}
                >
                  <Plus data-icon="inline-start" /> 创建数字分身
                </Button>
              </CardContent>
            </Card>
          </li>
        ) : null}
        {filtered.map((agent) => (
          <li key={agent.id} className="min-w-0">
            <Card className="h-full">
              <CardHeader className="grid-cols-[auto_minmax(0,1fr)_auto]!">
                <AgentAvatar agent={agent} className="row-span-2 self-center" />
                <CardTitle className="col-start-2 min-w-0">
                  <h2 className="flex min-w-0 items-center gap-2">
                    <Button
                      variant="ghost"
                      aria-label={`配置 ${agent.name}`}
                      disabled={importing}
                      className="h-auto min-w-0 flex-1 justify-start p-0 text-left text-base font-medium"
                      onClick={() => openAgent(agent.id)}
                    >
                      <span className="truncate" title={agent.name}>
                        {agent.name}
                      </span>
                    </Button>
                    <StatusBadge className="max-w-28 min-w-0 shrink">
                      <span className="truncate" title={agent.role?.trim() || '通用助手'}>
                        {agent.role?.trim() || '通用助手'}
                      </span>
                    </StatusBadge>
                  </h2>
                </CardTitle>
                <CardAction className="col-start-3">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`操作 ${agent.name}`}
                          onClick={(event) => {
                            editorTriggerRef.current = event.currentTarget;
                          }}
                        >
                          <Ellipsis />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end">
                      <DropdownMenuGroup>
                        <DropdownMenuItem disabled={importing} onClick={() => openAgent(agent.id)}>
                          配置
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => setDeleting(agent)}>
                          删除
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </CardAction>
                <CardDescription className="col-start-2 row-start-2 line-clamp-2 min-h-10 break-words">
                  {agent.description}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-1.5">
                <StatusBadge>{agent.enabled ? '已启用' : '已停用'}</StatusBadge>
                <StatusBadge>
                  <Plug aria-hidden="true" /> {agent.serverIds.length} 个连接器
                </StatusBadge>
                <StatusBadge>
                  <Sparkles aria-hidden="true" /> {agent.skillIds.length} 项技能
                </StatusBadge>
              </CardContent>
              <CardFooter className="mt-auto justify-between">
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {agent.slug}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={importing}
                  onClick={() => openAgent(agent.id)}
                >
                  配置
                </Button>
              </CardFooter>
            </Card>
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`删除专家「${deleting?.name ?? ''}」`}
        description="它的会话、消息与绑定关系会一并删除，正在运行的任务不会被自动停止。此操作不可撤销。"
        finalFocus={() =>
          editorTriggerRef.current?.isConnected ? editorTriggerRef.current : createButtonRef.current
        }
        onConfirm={async () => {
          if (!deleting) return;
          await remove.mutateAsync(deleting.id);
          setDeleting(null);
        }}
      />

      {creating ? (
        <CreateAgentDialog
          initialRole={initialRole}
          finalFocus={() =>
            editorTriggerRef.current?.isConnected
              ? editorTriggerRef.current
              : createButtonRef.current
          }
          onClose={() => setCreating(false)}
          onCreated={(agent) => {
            setCreating(false);
            openAgent(agent.id);
          }}
        />
      ) : null}
    </ResourcePage>
  );
}

/** 专家配置的整页形态：头像 + 名称/描述在页头，编辑与版本历史仍由 AgentEditor 承载。 */
export function AgentDetailPage() {
  const params = useParams({ from: '/shell/agents/$agentId' });
  const navigate = useNavigate();
  const agent = useAgent(params.agentId);
  const remove = useDeleteAgent();
  const location = useLocation();
  const [pending, setPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // 导入后随导航状态带过来的一次性提示；展示关闭后从本地状态清空。
  const [warnings, setWarnings] = useState<string[]>(() => {
    const state = location.state as { importWarnings?: string[] } | undefined;
    return state?.importWarnings ?? [];
  });

  const backToList = (): void => {
    void navigate({ to: '/agents' });
  };

  // 有缓存就先渲染：后台刷新失败不能把已加载的配置整页换成错误态。
  if (!agent.data) {
    if (agent.isPending) {
      return (
        <Page>
          <LoadingState rows={6} />
        </Page>
      );
    }
    if (agent.isError) {
      return (
        <Page>
          <ErrorState error={agent.error} onRetry={() => void agent.refetch()} />
        </Page>
      );
    }
    return (
      <Page>
        <PageNote
          icon={<Bot />}
          title="专家不存在"
          description="它可能已被删除，返回列表重新选择。"
          action={
            <Button variant="outline" size="sm" onClick={backToList}>
              <ArrowLeft data-icon="inline-start" /> 返回列表
            </Button>
          }
        />
      </Page>
    );
  }

  const current = agent.data;
  return (
    <Page>
      <PageHeader
        leading={<AgentAvatar agent={current} className="size-11" />}
        title={current.name}
        eyebrow={
          <StatusBadge className="max-w-full whitespace-normal break-words">
            {current.role?.trim() || '通用助手'}
          </StatusBadge>
        }
        {...(current.description ? { description: current.description } : {})}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={backToList} disabled={pending}>
              <ArrowLeft data-icon="inline-start" /> 返回列表
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="删除专家"
              title="删除专家"
              disabled={pending}
              onClick={() => setDeleting(true)}
            >
              <Trash2 />
            </Button>
          </>
        }
      />
      <AgentEditor
        key={current.id}
        agent={current}
        onDirtyChange={() => {}}
        onPendingChange={setPending}
      />
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`删除专家「${current.name}」`}
        description="它的会话、消息与绑定关系会一并删除，正在运行的任务不会被自动停止。此操作不可撤销。"
        confirmDisabled={pending}
        onConfirm={async () => {
          if (pending) return;
          await remove.mutateAsync(current.id);
          setDeleting(false);
          backToList();
        }}
      />
      <Dialog
        open={warnings.length > 0}
        onOpenChange={(open) => {
          if (!open) setWarnings([]);
        }}
      >
        <DialogShell title="导入提示" description="专家已导入，请检查以下配置。">
          <ul className="flex flex-col gap-2 text-sm">
            {warnings.map((warning) => (
              <li key={warning} className="whitespace-pre-wrap break-all">
                {warning}
              </li>
            ))}
          </ul>
        </DialogShell>
      </Dialog>
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
  role: 'identity',
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

export function AgentEditor({
  agent,
  onDirtyChange,
  onPendingChange,
}: {
  agent: Agent;
  onDirtyChange: (dirty: boolean) => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const update = useUpdateAgent();
  const servers = useServers();
  const skills = useSkills();
  const agents = useAgents();
  const serverAnchor = useComboboxAnchor();
  const skillAnchor = useComboboxAnchor();
  const subAgentAnchor = useComboboxAnchor();
  const [baseline, setBaseline] = useState(agent);
  const [conflict, setConflict] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const pending = update.isPending || reloading || rollingBack;
  const [form, setForm] = useState<AgentInput>(() => toInput(agent));
  const [historyOpen, setHistoryOpen] = useState(false);
  const [mode, setMode] = useState<'config' | 'files' | 'memory' | 'rules' | 'styles' | 'stats'>(
    'config',
  );
  const [activeSection, setActiveSection] = useState<SectionId>('identity');
  const [activeFile, setActiveFile] = useState('.mcp.json');
  const files = useAgentFiles(agent.id);
  const fileEntries = files.data ? listWorkspaceFiles(files.data) : baseFileEntries;
  const resolvedEntry = fileEntries.find((entry) => entry.id === activeFile) ?? fileEntries[0];
  const resolvedId = resolvedEntry?.id;
  const fileGroups = [...new Set(fileEntries.map((entry) => entry.group))];
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [exporting, setExporting] = useState(false);
  // 多行文本按行解析为数组；草稿单独保留，输入换行时不会被 join 规范化掉。
  const [allowedText, setAllowedText] = useState(() => agent.allowedTools.join('\n'));
  const allowedInvalid = allowedText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => /\s/.test(line));
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
        new Blob([serializeAgentPackage(data)], { type: 'application/json' }),
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

  const initial = useMemo(() => toInput(baseline), [baseline]);

  const loadDraft = (next: Agent): void => {
    setBaseline(next);
    setForm(toInput(next));
    setAllowedText(next.allowedTools.join('\n'));
    setThinkingText(next.maxThinkingTokens === undefined ? '' : String(next.maxThinkingTokens));
    setErrors({});
    setConflict(false);
  };
  const reload = async (): Promise<void> => {
    setReloading(true);
    try {
      const latest = (await api.agents()).find((item) => item.id === baseline.id);
      if (!latest) throw new Error('该专家已不存在，请关闭配置并刷新列表');
      loadDraft(latest);
      setConfirmReload(false);
    } catch (error) {
      toastError(error);
    } finally {
      setReloading(false);
    }
  };
  const dirty =
    JSON.stringify(form) !== JSON.stringify(initial) ||
    allowedText !== initial.allowedTools.join('\n') ||
    thinkingText !==
      (initial.maxThinkingTokens === undefined ? '' : String(initial.maxThinkingTokens));

  const blocker = useFormBlocker(dirty, pending);

  useEffect(() => {
    onDirtyChange(dirty || pending);
  }, [dirty, pending, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  useEffect(() => {
    onPendingChange(pending);
    return () => onPendingChange(false);
  }, [pending, onPendingChange]);

  // 进入「完整文件」时滚回该栏顶部，避免停在上一份长文件的中段。
  useEffect(() => {
    if (mode !== 'files') return;
    const el = document.getElementById('agent-files-detail');
    el?.scrollIntoView({ block: 'start' });
  }, [mode]);

  const boundServers = useMemo(
    () => (servers.data ?? []).filter((server) => form.serverIds.includes(server.id)),
    [servers.data, form.serverIds],
  );
  const boundSkills = useMemo(
    () => (skills.data ?? []).filter((skill) => form.skillIds.includes(skill.id)),
    [skills.data, form.skillIds],
  );
  const boundSubAgents = useMemo(
    () =>
      (agents.data ?? [])
        .filter((item) => item.enabled && form.subAgentIds.includes(item.id))
        .map((item) => ({
          ...item,
          effort: item.effort ?? null,
          skills: (skills.data ?? []).filter((skill) => item.skillIds.includes(skill.id)),
        })),
    [agents.data, form.subAgentIds, skills.data],
  );
  // 下载入口只能指向已落盘的配置，不能跟着未保存的草稿走。
  const savedSubAgents = useMemo(
    () => (agents.data ?? []).filter((item) => item.enabled && agent.subAgentIds.includes(item.id)),
    [agents.data, agent.subAgentIds],
  );

  const serverOptions = (servers.data ?? []).map((server) => ({
    id: server.id,
    label: server.name,
    hint: server.kind,
    tag: server.kind,
  }));

  const skillOptions = (skills.data ?? []).map((skill) => ({
    id: skill.id,
    label: skill.name,
    hint: skill.description,
  }));

  // 保留当前绑定的子智能体，允许解绑；其他父级的子智能体不可选。
  const subAgentOptions = (agents.data ?? [])
    .filter(
      (item) => item.id !== agent.id && (item.parentId === null || item.parentId === agent.id),
    )
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
  const toolCountPending = servers.isPending || toolQueries.some((query) => query.isPending);
  const toolCountUnknown = servers.isError || toolQueries.some((query) => query.isError);
  const unknownServerCount = boundServers.length - generatedIds.length;
  const serverToolSummary =
    form.serverIds.length === 0
      ? '将获得 0 个工具'
      : toolCountUnknown
        ? '工具数量未知'
        : toolCountPending
          ? '工具数量加载中…'
          : `将获得 ${toolCount} 个工具${
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

  // 这两项不经过 zod：按钮禁用前要说明是哪一项、在哪个折叠分区里。
  const invalidField = allowedInvalid
    ? ('permissions' as const)
    : thinkingInvalid
      ? ('limits' as const)
      : null;
  const saveHint =
    invalidField === 'permissions'
      ? '「权限」里的自定义工具格式无效'
      : invalidField === 'limits'
        ? '「运行限制」里的最大思考 tokens 无效'
        : null;

  /** 错误字段所在分区可能不是当前选中项：先切过去，下一帧再聚焦。 */
  const revealInvalidField = (): void => {
    const [section, id] =
      invalidField === 'limits'
        ? (['limits', 'agent-thinking'] as const)
        : (['permissions', 'agent-allowed-tools'] as const);
    focusSection(section, id);
  };

  const save = (): void => {
    if (pending) return;
    if (allowedInvalid || thinkingInvalid) {
      revealInvalidField();
      return;
    }
    const parsed = agentInputSchema.safeParse(form);
    if (!parsed.success) {
      const issues = fieldErrors(parsed.error.issues);
      setErrors(issues);
      // 错误可能不在当前分区：切到第一个出错的分区，错误本身由 role="alert" 播报。
      const section = Object.keys(issues)
        .map((key) => errorSections[key])
        .find((item): item is SectionId => item !== undefined);
      if (section) {
        setMode('config');
        setActiveSection(section);
      }
      return;
    }
    update.mutate(
      {
        id: baseline.id,
        // 全量表单保存时显式发 null，才能清空已设为「默认」的字段。
        input: {
          ...parsed.data,
          effort: parsed.data.effort ?? null,
          maxThinkingTokens: parsed.data.maxThinkingTokens ?? null,
        },
        expectedUpdatedAt: baseline.updatedAt,
      },
      {
        onSuccess: (saved) => {
          loadDraft(saved);
          toastSuccess('智能体已保存');
        },
        onError: (error) => {
          if (error instanceof ApiError && error.status === 409) {
            setConflict(true);
            toastError(new Error('配置已被修改；当前草稿已保留，请加载最新配置后重新编辑。'));
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

  /** 分区详情只挂载当前选中项：出错时先切分区，下一帧再聚焦字段。 */
  const focusSection = (section: SectionId, fieldId?: string): void => {
    setMode('config');
    setActiveSection(section);
    requestAnimationFrame(() => {
      const target = document.getElementById(fieldId ?? `agent-${section}`);
      target?.scrollIntoView({ block: fieldId ? 'center' : 'start' });
      if (fieldId) (target as HTMLElement | null)?.focus();
    });
  };

  const sectionButtonClass = (active: boolean): string =>
    cn(
      'flex w-full flex-col gap-0.5 rounded-icon px-2 py-1.5 text-sm transition-colors md:text-left',
      active ? 'bg-selected font-medium text-fg' : 'text-muted-foreground hover:bg-hover',
    );

  const effortOptions = [
    { value: '', label: '默认' },
    { value: 'low', label: 'low' },
    { value: 'medium', label: 'medium' },
    { value: 'high', label: 'high' },
    { value: 'xhigh', label: 'xhigh' },
    { value: 'max', label: 'max' },
  ];
  const permissionOptions = [
    { value: 'dontAsk', label: 'dontAsk — 拒绝未预批准' },
    { value: 'plan', label: 'plan — 只规划不执行' },
    { value: 'default', label: 'default — 标准权限' },
    { value: 'acceptEdits', label: 'acceptEdits — 自动接受编辑' },
  ];

  return (
    <div className="min-w-0">
      {conflict ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 py-2 text-sm">
          <p>配置已被修改，当前草稿已保留。加载最新配置会放弃此草稿。</p>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => setConfirmReload(true)}
          >
            加载最新配置
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmReload}
        onClose={() => {
          if (!pending) setConfirmReload(false);
        }}
        title="放弃草稿并加载最新配置？"
        description="当前未保存的更改会丢失。加载失败时会保留当前草稿。"
        confirmLabel="放弃并加载"
        confirmDisabled={pending}
        onConfirm={async () => {
          if (!pending) await reload();
        }}
      />
      <div className="flex min-h-14 flex-wrap items-center gap-2.5 py-2">
        <label
          data-disabled={pending}
          htmlFor="agent-enabled"
          className="inline-flex items-center gap-2 rounded-item p-1 text-xs text-muted-foreground transition-colors hover:bg-hover hover:text-fg"
        >
          <Switch
            disabled={pending}
            id="agent-enabled"
            checked={form.enabled}
            onCheckedChange={(enabled) => set('enabled', enabled)}
            aria-label="启用专家"
            title={form.enabled ? '已启用，点击停用' : '已停用，点击启用'}
          />
          {form.enabled ? '已启用' : '已停用'}
        </label>
        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-1.5">
          {dirty ? (
            <span className="mr-1 inline-flex items-center gap-1.5 text-2xs text-warning">
              <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />
              未保存
            </span>
          ) : null}
          {saveHint ? (
            <span className="mr-1 flex items-center gap-1.5 text-2xs text-danger">
              <span id="agent-save-hint" role="alert">
                {saveHint}
              </span>
              <Button
                type="button"
                variant="link"
                size="xs"
                onClick={revealInvalidField}
                // Keep a small inline warning link instead of the base primary-colored, medium-weight link.
                className="h-auto rounded-none border-0 p-0 text-2xs font-normal text-inherit underline underline-offset-2 hover:text-fg active:not-aria-[haspopup]:translate-y-0"
              >
                去修正
              </Button>
            </span>
          ) : null}
          <Button
            disabled={!dirty || pending || invalidField !== null}
            aria-busy={pending}
            aria-describedby={saveHint ? 'agent-save-hint' : undefined}
            onClick={save}
          >
            {pending ? (
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
            disabled={pending}
            onClick={() => setHistoryOpen(true)}
          >
            <History className="size-4" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label="更多操作">
                  <Ellipsis className="size-4" />
                </Button>
              }
            />
            <DropdownMenuContent
              align="end"
              sideOffset={4}
              // Keep the 16px menu corners, explicit border, and project overlay shadow.
              className="w-40 rounded-card border shadow-overlay"
            >
              <DropdownMenuGroup>
                <DropdownMenuItem disabled={exporting} onClick={() => void download()}>
                  <Download className="size-4" /> {exporting ? '导出中…' : '导出 JSON'}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
        {/* 导航栏：一个分组菜单承载「配置分区」与「完整文件」，不再有独立的顶层页签。 */}
        <nav aria-label="配置导航" className="min-w-0">
          <ul className="flex flex-wrap gap-1 md:flex-col md:flex-nowrap md:gap-0.5">
            <li>
              <p className="px-2 pt-1 pb-0.5 text-2xs text-subtle">配置分区</p>
            </li>
            {sectionItems.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  aria-current={mode === 'config' && activeSection === item.id ? 'true' : undefined}
                  onClick={() => focusSection(item.id)}
                  className={sectionButtonClass(mode === 'config' && activeSection === item.id)}
                >
                  {item.label}
                  <span className="hidden truncate font-mono text-2xs tabular-nums text-muted-foreground md:block">
                    {sectionSummary[item.id]}
                  </span>
                </button>
              </li>
            ))}
            <li className="md:mt-3 md:border-t md:pt-1">
              <p className="px-2 pt-1 pb-0.5 text-2xs text-subtle">完整文件</p>
            </li>
            {fileGroups.map((group) => (
              <Fragment key={group}>
                <li>
                  <p className="px-2 pt-1 pb-0.5 text-2xs text-subtle">{group}</p>
                </li>
                {fileEntries
                  .filter((entry) => entry.group === group)
                  .map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        aria-current={
                          mode === 'files' && resolvedId === entry.id ? 'true' : undefined
                        }
                        onClick={() => {
                          setMode('files');
                          setActiveFile(entry.id);
                        }}
                        className={sectionButtonClass(mode === 'files' && resolvedId === entry.id)}
                      >
                        <span className="inline-flex min-w-0 items-center gap-1.5">
                          {entry.id === '.mcp.json' ? (
                            <FileCode aria-hidden="true" />
                          ) : (
                            <FileText aria-hidden="true" />
                          )}
                          <span className="truncate" title={entry.path}>
                            {entry.path}
                            {entry.group === '输出风格' &&
                            files.data?.selectedOutputStyle &&
                            entry.id ===
                              `.claude/output-styles/${files.data.selectedOutputStyle}.md`
                              ? ' · 已启用'
                              : ''}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
              </Fragment>
            ))}
            <li className="md:mt-3 md:border-t md:pt-1">
              <p className="px-2 pt-1 pb-0.5 text-2xs text-subtle">记忆</p>
            </li>
            <li>
              <button
                type="button"
                aria-current={mode === 'memory' ? 'true' : undefined}
                onClick={() => setMode('memory')}
                className={sectionButtonClass(mode === 'memory')}
              >
                <span className="inline-flex items-center gap-1.5">
                  <Brain aria-hidden="true" /> 长期记忆
                </span>
              </button>
            </li>
            <li>
              <button
                type="button"
                aria-current={mode === 'rules' ? 'true' : undefined}
                onClick={() => setMode('rules')}
                className={sectionButtonClass(mode === 'rules')}
              >
                <span className="inline-flex items-center gap-1.5">
                  <ScrollText aria-hidden="true" /> 项目规则
                </span>
              </button>
            </li>
            <li>
              <button
                type="button"
                aria-current={mode === 'styles' ? 'true' : undefined}
                onClick={() => setMode('styles')}
                className={sectionButtonClass(mode === 'styles')}
              >
                <span className="inline-flex items-center gap-1.5">
                  <Palette aria-hidden="true" /> 输出风格
                </span>
              </button>
            </li>
            <li>
              <button
                type="button"
                aria-current={mode === 'stats' ? 'true' : undefined}
                onClick={() => setMode('stats')}
                className={sectionButtonClass(mode === 'stats')}
              >
                <span className="inline-flex items-center gap-1.5">
                  <BarChart3 aria-hidden="true" /> 运行统计
                </span>
              </button>
            </li>
          </ul>
        </nav>

        <div className="min-w-0">
          {mode === 'memory' ? (
            <div className="min-w-0">
              <MemoryPanel agentId={agent.id} />
            </div>
          ) : mode === 'rules' ? (
            <div className="min-w-0 rounded-card bg-surface px-6 py-5 ring-1 ring-line">
              <RulesPanel agentId={agent.id} />
            </div>
          ) : mode === 'styles' ? (
            <div className="min-w-0 rounded-card bg-surface px-6 py-5 ring-1 ring-line">
              <OutputStylesPanel agentId={agent.id} />
            </div>
          ) : mode === 'stats' ? (
            <AgentStatsPanel agentId={agent.id} />
          ) : mode === 'config' ? (
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                if (dirty && !pending) save();
              }}
            >
              <div className="rounded-card bg-surface px-6 py-5 ring-1 ring-line">
                {activeSection === 'identity' ? (
                  <Section id="identity" title="身份">
                    <FieldGroup className="grid gap-5 sm:grid-cols-2">
                      <Field
                        data-disabled={pending}
                        className="gap-1.5"
                        data-invalid={Boolean(errors.name)}
                      >
                        <FieldLabel htmlFor="agent-name">
                          名称
                          <RequiredMark />
                        </FieldLabel>
                        <Input
                          disabled={pending}
                          id="agent-name"
                          value={form.name}
                          aria-required="true"
                          aria-invalid={Boolean(errors.name)}
                          aria-describedby={errors.name ? 'agent-name-error' : undefined}
                          onChange={(event) => set('name', event.target.value)}
                        />
                        <FieldError id="agent-name-error">{errors.name}</FieldError>
                      </Field>
                      <Field
                        data-disabled={pending}
                        className="gap-1.5"
                        data-invalid={Boolean(errors.role)}
                      >
                        <FieldLabel htmlFor="agent-role">角色</FieldLabel>
                        <Select
                          disabled={pending}
                          value={form.role}
                          items={
                            roleOptions.some((option) => option.value === form.role)
                              ? roleOptions
                              : [{ value: form.role, label: form.role }, ...roleOptions]
                          }
                          onValueChange={(role) => {
                            if (role !== null) set('role', role);
                          }}
                        >
                          <SelectTrigger
                            id="agent-role"
                            className="w-full min-w-0"
                            aria-invalid={Boolean(errors.role)}
                            aria-describedby={errors.role ? 'agent-role-error' : undefined}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {!roleOptions.some((option) => option.value === form.role) ? (
                                <SelectItem value={form.role} disabled>
                                  {form.role}
                                </SelectItem>
                              ) : null}
                              {roleOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        <FieldError id="agent-role-error">{errors.role}</FieldError>
                      </Field>
                      <Field className="gap-1.5 sm:col-span-2" data-disabled="true">
                        <FieldLabel htmlFor="agent-slug">Slug</FieldLabel>
                        <Input
                          id="agent-slug"
                          value={form.slug}
                          // Keep monospace technical identifiers instead of the base sans-serif input.
                          className="font-mono"
                          disabled
                          aria-describedby="agent-slug-hint"
                        />
                        <FieldDescription id="agent-slug-hint">创建后不可修改</FieldDescription>
                      </Field>
                      <Field
                        data-disabled={pending}
                        className="gap-1.5 sm:col-span-2"
                        data-invalid={Boolean(errors.description)}
                      >
                        <FieldLabel htmlFor="agent-desc">描述</FieldLabel>
                        <Input
                          disabled={pending}
                          id="agent-desc"
                          value={form.description}
                          aria-invalid={Boolean(errors.description)}
                          aria-describedby={errors.description ? 'agent-desc-error' : undefined}
                          placeholder="一句话说明它擅长什么"
                          onChange={(event) => set('description', event.target.value)}
                        />
                        <FieldError id="agent-desc-error">{errors.description}</FieldError>
                      </Field>
                    </FieldGroup>
                  </Section>
                ) : null}

                {activeSection === 'behavior' ? (
                  <Section id="behavior" title="行为">
                    <Field data-disabled={pending} className="gap-1.5">
                      <FieldLabel htmlFor="agent-prompt">
                        {form.role === '数字分身' ? '工作背景与表达方式' : '系统提示词'}
                      </FieldLabel>
                      <Textarea
                        disabled={pending}
                        id="agent-prompt"
                        rows={16}
                        value={form.systemPrompt}
                        // Keep compact monospace code text instead of the base prose typography.
                        className="font-mono text-xs leading-relaxed"
                        placeholder="描述角色、边界与工作方式"
                        onChange={(event) => set('systemPrompt', event.target.value)}
                      />
                    </Field>

                    <DraftPreview title="将写入 CLAUDE.md 的内容" code={claudeDraft} />

                    <FieldGroup className="grid gap-5 sm:grid-cols-2">
                      <Field data-disabled={pending} className="gap-1.5">
                        <FieldLabel htmlFor="agent-model">模型</FieldLabel>
                        <Input
                          disabled={pending}
                          id="agent-model"
                          list="agent-models"
                          value={form.model}
                          // Keep monospace technical identifiers instead of the base sans-serif input.
                          className="font-mono"
                          onChange={(event) => set('model', event.target.value)}
                        />
                        <datalist id="agent-models">
                          {modelOptions(form.model).map((option) => (
                            <option key={option.value} value={option.value} />
                          ))}
                        </datalist>
                      </Field>
                      <Field data-disabled={pending} className="gap-1.5">
                        <FieldLabel htmlFor="agent-effort">推理强度</FieldLabel>
                        <Select
                          disabled={pending}
                          value={form.effort ?? ''}
                          onValueChange={(value) => {
                            if (value !== null) {
                              set(
                                'effort',
                                value === '' ? undefined : (value as AgentInput['effort']),
                              );
                            }
                          }}
                          items={effortOptions}
                        >
                          <SelectTrigger id="agent-effort">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {effortOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                    </FieldGroup>
                  </Section>
                ) : null}

                {activeSection === 'capability' ? (
                  <Section id="capability" title="能力">
                    <div className="flex flex-col gap-6">
                      <div>
                        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                          <h3 className="flex items-center gap-1.5 text-sm font-medium text-fg">
                            <Plug className="size-4 text-muted-foreground" aria-hidden="true" />
                            MCP Servers
                          </h3>
                          <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                            {serverToolSummary}
                          </span>
                        </div>
                        {servers.isPending ? <LoadingState rows={1} /> : null}
                        {servers.isError ? (
                          <ErrorState
                            error={servers.error}
                            onRetry={() => void servers.refetch()}
                          />
                        ) : null}
                        {toolQueries.map((query, index) =>
                          query.isError ? (
                            <ErrorState
                              key={generatedIds[index]}
                              error={query.error}
                              onRetry={() => void query.refetch()}
                            />
                          ) : null,
                        )}
                        {servers.data && servers.data.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            还没有可绑定的 server，先去 MCP Servers 页面创建。
                          </p>
                        ) : null}
                        {servers.data && servers.data.length > 0 ? (
                          <Combobox
                            disabled={pending}
                            multiple
                            items={serverOptions}
                            value={serverOptions.filter((option) =>
                              form.serverIds.includes(option.id),
                            )}
                            onValueChange={(picked) =>
                              set(
                                'serverIds',
                                picked.map((option) => option.id),
                              )
                            }
                            itemToStringLabel={(option) => option.label}
                            itemToStringValue={(option) => option.id}
                            isItemEqualToValue={(a, b) => a.id === b.id}
                            filter={(option, query) =>
                              `${option.label} ${option.hint}`
                                .toLowerCase()
                                .includes(query.trim().toLowerCase())
                            }
                          >
                            <ComboboxChips
                              aria-label="已选连接器"
                              data-disabled={pending}
                              ref={serverAnchor}
                            >
                              <ComboboxValue>
                                {(selected: typeof serverOptions) =>
                                  selected.map((option) => (
                                    <ComboboxChip key={option.id} aria-label={option.label}>
                                      {option.label}
                                    </ComboboxChip>
                                  ))
                                }
                              </ComboboxValue>
                              <ComboboxChipsInput
                                aria-label="MCP Server"
                                placeholder="搜索并选择 server…"
                              />
                            </ComboboxChips>
                            <ComboboxContent anchor={serverAnchor}>
                              <ComboboxEmpty>没有匹配的 server</ComboboxEmpty>
                              <ComboboxList>
                                {(option: (typeof serverOptions)[number]) => (
                                  <ComboboxItem key={option.id} value={option}>
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate">{option.label}</span>
                                      <span className="block truncate text-xs text-muted-foreground">
                                        {option.hint}
                                      </span>
                                    </span>
                                    <StatusBadge tone="mono">{option.tag}</StatusBadge>
                                  </ComboboxItem>
                                )}
                              </ComboboxList>
                            </ComboboxContent>
                          </Combobox>
                        ) : null}
                      </div>

                      <div>
                        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                          <h3 className="flex items-center gap-1.5 text-sm font-medium text-fg">
                            <Sparkles className="size-4 text-muted-foreground" aria-hidden="true" />
                            技能
                          </h3>
                          <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                            已选 {form.skillIds.length}
                          </span>
                        </div>
                        {skills.isPending ? <LoadingState rows={1} /> : null}
                        {skills.isError ? (
                          <ErrorState error={skills.error} onRetry={() => void skills.refetch()} />
                        ) : null}
                        {skills.data && skills.data.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            还没有技能。技能是可复用的操作流程，会渲染为
                            <code className="mx-1 font-mono text-muted-foreground">
                              .claude/skills/&lt;slug&gt;/SKILL.md
                            </code>
                            供智能体按需读取。
                          </p>
                        ) : null}
                        {skills.data && skills.data.length > 0 ? (
                          <Combobox
                            disabled={pending}
                            multiple
                            items={skillOptions}
                            value={skillOptions.filter((option) =>
                              form.skillIds.includes(option.id),
                            )}
                            onValueChange={(picked) =>
                              set(
                                'skillIds',
                                picked.map((option) => option.id),
                              )
                            }
                            itemToStringLabel={(option) => option.label}
                            itemToStringValue={(option) => option.id}
                            isItemEqualToValue={(a, b) => a.id === b.id}
                            filter={(option, query) =>
                              `${option.label} ${option.hint}`
                                .toLowerCase()
                                .includes(query.trim().toLowerCase())
                            }
                          >
                            <ComboboxChips
                              aria-label="已选技能"
                              data-disabled={pending}
                              ref={skillAnchor}
                            >
                              <ComboboxValue>
                                {(selected: typeof skillOptions) =>
                                  selected.map((option) => (
                                    <ComboboxChip key={option.id} aria-label={option.label}>
                                      {option.label}
                                    </ComboboxChip>
                                  ))
                                }
                              </ComboboxValue>
                              <ComboboxChipsInput aria-label="技能" placeholder="搜索并选择技能…" />
                            </ComboboxChips>
                            <ComboboxContent anchor={skillAnchor}>
                              <ComboboxEmpty>没有匹配的技能</ComboboxEmpty>
                              <ComboboxList>
                                {(option: (typeof skillOptions)[number]) => (
                                  <ComboboxItem key={option.id} value={option}>
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate">{option.label}</span>
                                      {option.hint ? (
                                        <span className="block truncate text-xs text-muted-foreground">
                                          {option.hint}
                                        </span>
                                      ) : null}
                                    </span>
                                  </ComboboxItem>
                                )}
                              </ComboboxList>
                            </ComboboxContent>
                          </Combobox>
                        ) : null}
                      </div>

                      <div>
                        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                          <h3 className="flex items-center gap-1.5 text-sm font-medium text-fg">
                            <Bot className="size-4 text-muted-foreground" aria-hidden="true" />
                            子智能体
                          </h3>
                          <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                            {hasSubAgents ? '已启用委派' : '未启用'}
                          </span>
                        </div>
                        {agent.parentId !== null ? (
                          <p className="text-xs text-muted-foreground">
                            它本身已经是子智能体，不能再委派。子智能体只支持一层。
                          </p>
                        ) : subAgentOptions.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            没有可选的主智能体。只有「没有父级」的智能体才能被委派。
                          </p>
                        ) : (
                          <Combobox
                            disabled={pending}
                            multiple
                            items={subAgentOptions}
                            value={subAgentOptions.filter((option) =>
                              form.subAgentIds.includes(option.id),
                            )}
                            onValueChange={(picked) =>
                              set(
                                'subAgentIds',
                                picked.map((option) => option.id),
                              )
                            }
                            itemToStringLabel={(option) => option.label}
                            itemToStringValue={(option) => option.id}
                            isItemEqualToValue={(a, b) => a.id === b.id}
                            filter={(option, query) =>
                              `${option.label} ${option.hint}`
                                .toLowerCase()
                                .includes(query.trim().toLowerCase())
                            }
                          >
                            <ComboboxChips
                              aria-label="已选子智能体"
                              data-disabled={pending}
                              ref={subAgentAnchor}
                            >
                              <ComboboxValue>
                                {(selected: typeof subAgentOptions) =>
                                  selected.map((option) => (
                                    <ComboboxChip key={option.id} aria-label={option.label}>
                                      {option.label}
                                    </ComboboxChip>
                                  ))
                                }
                              </ComboboxValue>
                              <ComboboxChipsInput
                                aria-label="子智能体"
                                placeholder="搜索并选择子智能体…"
                              />
                            </ComboboxChips>
                            <ComboboxContent anchor={subAgentAnchor}>
                              <ComboboxEmpty>没有匹配的智能体</ComboboxEmpty>
                              <ComboboxList>
                                {(option: (typeof subAgentOptions)[number]) => (
                                  <ComboboxItem key={option.id} value={option}>
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate">{option.label}</span>
                                      <span className="block truncate text-xs text-muted-foreground">
                                        {option.hint}
                                      </span>
                                    </span>
                                  </ComboboxItem>
                                )}
                              </ComboboxList>
                            </ComboboxContent>
                          </Combobox>
                        )}
                      </div>
                      {savedSubAgents.length > 0 ? (
                        <div className="flex flex-col gap-2">
                          <h3 className="flex items-center gap-1.5 text-sm font-medium text-fg">
                            <FileText className="size-4 text-subtle" aria-hidden="true" />{' '}
                            已保存的子智能体文件
                          </h3>
                          <div className="flex flex-wrap gap-2">
                            {savedSubAgents.map((child) => (
                              <Button
                                key={child.id}
                                variant="outline"
                                size="sm"
                                nativeButton={false}
                                render={
                                  <a href={`/api/agents/${agent.id}/subagents/${child.id}/file`} />
                                }
                              >
                                <Download />
                                {child.slug}.md
                              </Button>
                            ))}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            下载已保存的子定义；其中声明的技能文件与 MCP
                            连接配置仍需来自同一工作区。
                            {form.subAgentIds.length !== agent.subAgentIds.length ||
                            form.subAgentIds.some((id) => !agent.subAgentIds.includes(id))
                              ? '当前草稿的子智能体绑定尚未保存，这里仍是已保存版本。'
                              : ''}
                          </p>
                        </div>
                      ) : null}
                    </div>

                    <DraftPreview title="将写入 .mcp.json 与 frontmatter" code={fileDraft} />
                  </Section>
                ) : null}

                {activeSection === 'permissions' ? (
                  <Section id="permissions" title="权限">
                    <p className="rounded-item bg-warning-soft px-3 py-2 text-xs leading-relaxed text-warning">
                      放行内置工具会扩大攻击面：Bash、文件写入和网络访问都绕过沙盒的只读约定。
                    </p>
                    <FieldGroup className="grid gap-5 sm:grid-cols-2">
                      <Field data-disabled={pending} className="gap-1.5">
                        <FieldLabel htmlFor="agent-perm">权限模式</FieldLabel>
                        <Select
                          disabled={pending}
                          value={form.permissionMode}
                          onValueChange={(next) => {
                            if (next !== null) {
                              set('permissionMode', next as AgentInput['permissionMode']);
                            }
                          }}
                          items={permissionOptions}
                        >
                          <SelectTrigger id="agent-perm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {permissionOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field
                        data-disabled={pending}
                        className="gap-1.5"
                        data-invalid={allowedInvalid}
                      >
                        <FieldLabel htmlFor="agent-allowed-tools">自定义允许的工具</FieldLabel>
                        <Textarea
                          disabled={pending}
                          id="agent-allowed-tools"
                          rows={3}
                          value={allowedText}
                          // Keep compact monospace code text instead of the base prose typography.
                          className="font-mono text-xs leading-relaxed"
                          placeholder={'mcp__jsonplaceholder__get_user\nmcp__crm__*'}
                          aria-invalid={allowedInvalid}
                          aria-describedby={
                            allowedInvalid
                              ? 'agent-allowed-tools-error'
                              : 'agent-allowed-tools-hint'
                          }
                          onChange={(event) => setAllowedToolsText(event.target.value)}
                        />
                        {allowedInvalid ? (
                          <FieldError id="agent-allowed-tools-error">
                            每行只能有一个工具名或模式，不能包含空格。
                          </FieldError>
                        ) : (
                          <FieldDescription id="agent-allowed-tools-hint">
                            每行一个模式，如 mcp__crm__*；留空表示全部已绑定工具。
                          </FieldDescription>
                        )}
                      </Field>
                    </FieldGroup>

                    <div>
                      <h3 className="mb-2 text-sm font-medium text-fg">内置工具</h3>
                      <div className="flex flex-wrap gap-1.5">
                        {BUILTIN_TOOLS.map((tool) => {
                          const enabled = builtinEnabled(tool);
                          const fixed = tool === 'Agent' || tool === 'TaskStop';
                          return (
                            <Button
                              key={tool}
                              type="button"
                              variant="ghost"
                              size="xs"
                              aria-pressed={enabled}
                              disabled={fixed || pending}
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
                              // Keep compact monospace permission chips and their enabled/disabled status colors.
                              className={cn(
                                'h-auto border-0 px-2 py-1 font-mono text-2xs font-normal transition-colors active:not-aria-[haspopup]:translate-y-0 [&]:rounded-tag',
                                enabled
                                  ? 'bg-warning-soft text-warning hover:bg-warning-soft hover:text-warning'
                                  : 'bg-chip text-muted-foreground hover:bg-hover hover:text-muted-foreground',
                                fixed && 'cursor-default opacity-80 disabled:opacity-80',
                              )}
                            >
                              {tool}
                              <span className="sr-only">
                                {enabled ? '：已启用' : '：已禁用'}
                                {fixed ? '，由子智能体绑定决定' : ''}
                              </span>
                            </Button>
                          );
                        })}
                      </div>
                    </div>
                  </Section>
                ) : null}

                {activeSection === 'limits' ? (
                  <Section id="limits" title="运行限制">
                    <FieldGroup className="grid gap-5 sm:grid-cols-2">
                      <Field
                        data-disabled={pending}
                        className="gap-1.5"
                        data-invalid={Boolean(errors.maxTurns)}
                      >
                        <FieldLabel htmlFor="agent-turns">最大轮次</FieldLabel>
                        <Input
                          disabled={pending}
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
                      </Field>
                      <Field
                        data-disabled={pending}
                        className="gap-1.5"
                        data-invalid={Boolean(errors.maxBudgetUsd)}
                      >
                        <FieldLabel htmlFor="agent-budget">预算上限 (USD)</FieldLabel>
                        <Input
                          disabled={pending}
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
                      </Field>
                      <Field
                        data-disabled={pending}
                        className="gap-1.5"
                        data-invalid={Boolean(errors.timeoutMs)}
                      >
                        <FieldLabel htmlFor="agent-timeout">超时 (毫秒)</FieldLabel>
                        <Input
                          disabled={pending}
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
                      </Field>
                      <Field
                        data-disabled={pending}
                        className="gap-1.5"
                        data-invalid={thinkingInvalid}
                      >
                        <FieldLabel htmlFor="agent-thinking">最大思考 tokens</FieldLabel>
                        <Input
                          disabled={pending}
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
                          <FieldDescription id="agent-thinking-hint">
                            留空表示不设置；只传给 SDK，不写文件。
                          </FieldDescription>
                        )}
                      </Field>
                    </FieldGroup>
                  </Section>
                ) : null}
              </div>
            </form>
          ) : (
            <div
              id="agent-files-detail"
              className="min-w-0 scroll-mt-4 rounded-card bg-surface px-6 py-5 ring-1 ring-line"
            >
              <FilesPreview entry={resolvedEntry} dirty={dirty} files={files} />
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onClose={() => blocker.reset?.()}
        title="放弃未保存的更改？"
        description={`「${agent.name}」还有未保存的修改，离开后会丢失。可以先取消、保存后再离开。`}
        confirmLabel="放弃并离开"
        confirmDisabled={pending}
        onConfirm={async () => {
          blocker.proceed?.();
        }}
      />

      <Sheet
        open={historyOpen}
        onOpenChange={(open, details) => {
          if (!open && pending) {
            details.cancel();
            return;
          }
          setHistoryOpen(open);
        }}
      >
        <SheetContent
          side="right"
          showCloseButton={false}
          aria-describedby={undefined}
          // Keep the project shadow.
          className="w-full max-w-[480px]! gap-0 p-0 shadow-overlay sm:max-w-[480px]!"
        >
          <div className="flex items-start justify-between gap-4 border-b px-5 py-3.5">
            <div className="min-w-0">
              {/* Keep the larger, heavier history title instead of the base title typography. */}
              <SheetTitle className="text-md font-semibold">版本历史</SheetTitle>
              {/* Keep smaller, relaxed history help text instead of the base text-sm. */}
              <SheetDescription className="mt-1 text-xs leading-relaxed">
                每次保存生成一份快照。回滚会覆盖当前配置并生成新版本。
              </SheetDescription>
            </div>
            <SheetClose
              disabled={pending}
              render={<Button variant="ghost" size="icon-sm" aria-label="关闭" className="-mr-1" />}
            >
              <X aria-hidden="true" />
            </SheetClose>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <VersionHistory
              agentId={agent.id}
              current={agent}
              active={historyOpen}
              saving={pending}
              dirty={dirty}
              onPendingChange={setRollingBack}
              onRolledBack={(next) => {
                loadDraft(next);
                setHistoryOpen(false);
              }}
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Section({ id, title, children }: { id: SectionId; title: string; children: ReactNode }) {
  const headingId = `agent-${id}-heading`;
  return (
    <section id={`agent-${id}`} aria-labelledby={headingId} className="scroll-mt-24">
      <h2 id={headingId} className="text-md font-semibold tracking-[-0.01em] text-fg">
        {title}
      </h2>
      <div className="mt-5 flex flex-col gap-5">{children}</div>
    </section>
  );
}

/** 草稿预览：折叠在表单里，内容随表单实时变化。 */
function DraftPreview({ title, code }: { title: string; code: string }) {
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();

  // Collapsible is unstyled; keep the draft border, 9px corners, and compact muted trigger.
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-item border">
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1.5 rounded-item px-3 py-2.5 text-xs text-muted-foreground transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform duration-150',
            open && 'rotate-90',
          )}
          aria-hidden="true"
        />
        {title}
        <span className="ml-auto font-mono text-2xs text-muted-foreground">草稿 · 实时</span>
      </CollapsibleTrigger>
      {/* 高度动画由 motion 管，Radix 负责 open 状态和 trigger/content 的 aria 关联。 */}
      <CollapsibleContent keepMounted>
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
              <div className="border-t p-2">
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
    permissionMode: string;
    effort?: string | null;
    allowedTools: string[];
    disallowedTools: string[];
    skills?: Array<{ slug: string; name: string; description: string; body: string }>;
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
    subAgents,
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

type FileEntry = { id: string; path: string; group: string; content: string };

/** 加载中或失败时也保留根文件入口，完整文件视图与重试界面才始终可达。 */
const baseFileEntries: FileEntry[] = [
  { id: '.mcp.json', path: '.mcp.json', group: '根文件', content: '' },
  { id: 'CLAUDE.md', path: 'CLAUDE.md', group: '根文件', content: '' },
  { id: 'preview:agent-md', path: 'agent md', group: '根文件', content: '' },
];

/** 完整文件视图的唯一清单来源：group 只承载导航结构，id 用作稳定选择键。 */
function listWorkspaceFiles(files: AgentFiles): FileEntry[] {
  return [
    { id: '.mcp.json', path: '.mcp.json', group: '根文件', content: files.mcpJson },
    { id: 'CLAUDE.md', path: 'CLAUDE.md', group: '根文件', content: files.claudeMd },
    { id: 'preview:agent-md', path: 'agent md', group: '根文件', content: files.agentMd },
    ...(files.settingsJson === null
      ? []
      : [
          {
            id: '.claude/settings.json',
            path: '.claude/settings.json',
            group: '根文件',
            content: files.settingsJson,
          },
        ]),
    ...(files.skills ?? []).flatMap((skill) => [
      {
        id: `.claude/skills/${skill.slug}/SKILL.md`,
        path: `skills/${skill.slug}/SKILL.md`,
        group: '技能',
        content: skill.content,
      },
      ...(skill.files ?? []).map((file) => ({
        id: `.claude/skills/${skill.slug}/${file.path}`,
        path: `skills/${skill.slug}/${file.path}`,
        group: '技能',
        content: file.content,
      })),
    ]),
    ...(files.subAgents ?? []).map((subAgent) => ({
      id: `.claude/agents/${subAgent.slug}.md`,
      path: `agents/${subAgent.slug}.md`,
      group: '子智能体',
      content: subAgent.content,
    })),
    ...(files.rules ?? []).map((rule) => ({
      id: `.claude/rules/${rule.slug}.md`,
      path: `rules/${rule.slug}.md`,
      group: '规则',
      content: rule.content,
    })),
    ...(files.outputStyles ?? []).map((style) => ({
      id: `.claude/output-styles/${style.slug}.md`,
      path: `output-styles/${style.slug}.md`,
      group: '输出风格',
      content: style.content,
    })),
  ];
}

/** 完整文件来自上次保存；编辑中的草稿在内联预览里。文件切换由外层的三栏布局承载。 */
function FilesPreview({
  entry,
  dirty,
  files,
}: {
  entry: FileEntry | undefined;
  dirty: boolean;
  files: ReturnType<typeof useAgentFiles>;
}) {
  const disabled = files.isPending || files.isError || !files.data;

  return (
    <div className="flex flex-col gap-3">
      <p className="rounded-item bg-chip px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        密钥在运行时注入，此处显示为占位符。
        {dirty ? ' 这里是上次保存后的完整文件；编辑中的草稿请回「配置」看内联预览。' : ''}
      </p>
      {files.isPending ? <LoadingState rows={6} /> : null}
      {files.isError ? (
        <ErrorState error={files.error} onRetry={() => void files.refetch()} />
      ) : null}
      {!disabled && entry && entry.content ? (
        <CodeBlock
          key={entry.id}
          code={entry.content}
          lineNumbers
          maxHeight="calc(100vh - 22rem)"
        />
      ) : null}
      {!disabled && entry && !entry.content ? <InlineEmpty>该文件当前为空。</InlineEmpty> : null}
      <p className="py-2 text-2xs text-muted-foreground">
        除根文件外，路径相对 <code className="font-mono">.claude/</code>；agent md
        仅供预览，不落盘。
      </p>
    </div>
  );
}

const diffFields: ReadonlyArray<readonly [keyof Agent, string]> = [
  ['name', '名称'],
  ['role', '角色'],
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
  if (Array.isArray(value)) return value.length === 0 ? '空' : JSON.stringify(value, null, 2);
  if (typeof value === 'boolean') return value ? '启用' : '停用';
  return String(value);
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

export function VersionHistory({
  agentId,
  current,
  active,
  saving,
  dirty = false,
  onPendingChange,
  onRolledBack,
}: {
  agentId: string;
  current: Agent;
  active: boolean;
  saving: boolean;
  dirty?: boolean;
  onPendingChange?: (pending: boolean) => void;
  onRolledBack: (agent: Agent) => void;
}) {
  const versions = useAgentVersions(agentId, active);
  const rollback = useRollbackAgent();
  const [pending, setPending] = useState<AgentVersionSummary | null>(null);
  const pendingDetail = useAgentVersion(agentId, pending?.version ?? 0, pending !== null);
  const rollbackDisabled =
    saving || pendingDetail.isPending || pendingDetail.isError || !pendingDetail.data;
  const pendingDiff =
    pending !== null && pendingDetail.data ? diffAgent(current, pendingDetail.data.snapshot) : null;

  return (
    <div className="flex flex-col gap-3">
      {versions.isPending ? <LoadingState rows={4} /> : null}
      {versions.isError ? (
        <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />
      ) : null}
      {versions.data && versions.data.length === 0 ? (
        <InlineEmpty>还没有版本记录。修改配置并保存后，这里会留下第一份快照。</InlineEmpty>
      ) : null}
      {versions.data && versions.data.length > 0 ? (
        <ul className="divide-y divide-line border-y">
          {versions.data.map((item) => (
            <VersionRow
              key={item.id}
              agentId={agentId}
              item={item}
              current={current}
              rollbackDisabled={saving}
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
          (dirty ? '当前未保存的更改会丢失。回滚失败时会保留当前草稿。' : '') +
          (pendingDetail.isError
            ? '无法读取该版本，请重试后再回滚。'
            : pendingDiff === null
              ? '正在读取该版本的差异…'
              : pendingDiff.length === 0
                ? '该版本与当前配置一致，回滚不会改变字段。仍会生成一个新版本。'
                : `将把 ${pendingDiff.length} 个字段改为该版本的值：${pendingDiff
                    .map((entry) => entry.label)
                    .join('、')}。当前配置会被覆盖，并生成一个新版本。`)
        }
        confirmLabel="回滚"
        confirmDisabled={rollbackDisabled}
        onConfirm={async () => {
          if (!pending || rollbackDisabled) return;
          onPendingChange?.(true);
          try {
            const agent = await rollback.mutateAsync({ id: agentId, version: pending.version });
            onRolledBack(agent);
            toastSuccess(`已回滚到 v${pending.version}`);
          } finally {
            onPendingChange?.(false);
          }
        }}
      >
        {pendingDetail.isError ? (
          <ErrorState error={pendingDetail.error} onRetry={() => void pendingDetail.refetch()} />
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

function VersionRow({
  agentId,
  item,
  current,
  rollbackDisabled,
  onRollback,
}: {
  agentId: string;
  item: AgentVersionSummary;
  current: Agent;
  rollbackDisabled: boolean;
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
              <span className="truncate rounded-tag bg-chip px-1.5 py-0.5 text-2xs text-muted-foreground">
                {item.note}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 font-mono text-2xs tabular-nums text-muted-foreground">
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
          <Button variant="outline" size="sm" disabled={rollbackDisabled} onClick={onRollback}>
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
            <p className="text-2xs text-muted-foreground">与当前配置一致。</p>
          ) : null}
          {diff && diff.length > 0 ? (
            <ul className="divide-y divide-line border-y">
              {diff.map((entry) => (
                <li
                  key={entry.label}
                  className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 py-1.5 text-2xs"
                >
                  <span className="text-muted-foreground">{entry.label}</span>
                  <span className="whitespace-pre-wrap break-all text-fg">
                    <span className="text-muted-foreground">{entry.from}</span>
                    <span className="mx-1 text-muted-foreground" aria-hidden="true">
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

export function CreateAgentDialog({
  onClose,
  onCreated,
  finalFocus,
  initialRole = '通用助手',
}: {
  onClose: () => void;
  onCreated: (agent: Agent) => void;
  finalFocus: ComponentProps<typeof DialogShell>['finalFocus'];
  initialRole?: AgentInput['role'];
}) {
  const create = useCreateAgent();
  const [initial] = useState<AgentInput>(() => ({
    ...emptyInput,
    role: initialRole,
    name: initialRole === '数字分身' ? '我的分身' : '',
  }));
  const [form, setForm] = useState<AgentInput>(initial);
  const isTwin = form.role === '数字分身';
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [created, setCreated] = useState<Agent | null>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const blocker = useFormBlocker(!created && dirty, !created && create.isPending);
  useEffect(() => {
    if (created) onCreated(created);
  }, [created, onCreated]);
  const close = (): void => {
    if (create.isPending) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const submit = (): void => {
    if (create.isPending) return;
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
        setCreated(agent);
      },
      onError: (error) => toastError(error),
    });
  };

  const newModelOptions = modelOptions(form.model);

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (create.isPending) {
          details.cancel();
          return;
        }
        if (!next) close();
      }}
    >
      <DialogShell
        title={isTwin ? '创建数字分身' : '新建专家'}
        description="连接器与运行限制可在创建后配置。"
        closeDisabled={create.isPending}
        finalFocus={finalFocus}
      >
        <form
          className="flex flex-col gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <FieldGroup className="grid gap-3 sm:grid-cols-2">
            <Field
              data-disabled={create.isPending}
              className="gap-1.5 sm:col-span-2"
              data-invalid={Boolean(errors.slug)}
            >
              <FieldLabel htmlFor="new-agent-slug">
                Slug
                <RequiredMark />
              </FieldLabel>
              <Input
                disabled={create.isPending}
                id="new-agent-slug"
                value={form.slug}
                placeholder="support-bot"
                // Keep monospace for the technical slug instead of the base sans-serif input.
                className="font-mono"
                aria-required="true"
                aria-invalid={Boolean(errors.slug)}
                aria-describedby={errors.slug ? 'new-agent-slug-error' : 'new-agent-slug-hint'}
                onChange={(event) => setForm({ ...form, slug: event.target.value })}
              />
              {errors.slug ? (
                <FieldError id="new-agent-slug-error">{errors.slug}</FieldError>
              ) : (
                <FieldDescription id="new-agent-slug-hint">
                  小写字母、数字、- 和 _；创建后不可修改。
                </FieldDescription>
              )}
            </Field>
            <Field
              data-disabled={create.isPending}
              className={cn(
                'gap-1.5',
                isTwin &&
                  'order-first grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 sm:col-span-2',
              )}
              data-invalid={Boolean(errors.name)}
            >
              {isTwin ? (
                <img
                  src={digitalTwinPortrait}
                  alt=""
                  className="row-span-3 size-16 rounded-full object-cover"
                />
              ) : null}
              <FieldLabel htmlFor="new-agent-name">名称</FieldLabel>
              <Input
                disabled={create.isPending}
                id="new-agent-name"
                value={form.name}
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'new-agent-name-error' : undefined}
                placeholder="客服助手"
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
              <FieldError id="new-agent-name-error">{errors.name}</FieldError>
            </Field>
            {isTwin ? (
              <div className="sm:col-span-2">
                <StatusBadge>数字分身</StatusBadge>
              </div>
            ) : (
              <Field
                data-disabled={create.isPending}
                className="gap-1.5"
                data-invalid={Boolean(errors.role)}
              >
                <FieldLabel htmlFor="new-agent-role">角色</FieldLabel>
                <Select
                  disabled={create.isPending}
                  value={form.role}
                  items={roleOptions}
                  onValueChange={(role) => {
                    if (role !== null)
                      setForm({
                        ...form,
                        role,
                        name: role === '数字分身' ? form.name || '我的分身' : form.name,
                      });
                  }}
                >
                  <SelectTrigger
                    id="new-agent-role"
                    className="w-full min-w-0"
                    aria-invalid={Boolean(errors.role)}
                    aria-describedby={errors.role ? 'new-agent-role-error' : undefined}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {roleOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldError id="new-agent-role-error">{errors.role}</FieldError>
              </Field>
            )}
          </FieldGroup>
          <Field data-disabled={create.isPending} className="gap-1.5">
            <FieldLabel htmlFor="new-agent-model">模型</FieldLabel>
            <Select
              disabled={create.isPending}
              value={form.model}
              onValueChange={(model) => {
                if (model !== null) {
                  setForm({ ...form, model });
                }
              }}
              items={newModelOptions}
            >
              <SelectTrigger id="new-agent-model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {newModelOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field data-disabled={create.isPending} className="gap-1.5">
            <FieldLabel htmlFor="new-agent-prompt">
              {isTwin ? '工作背景与表达方式' : '系统提示词'}
            </FieldLabel>
            <Textarea
              disabled={create.isPending}
              id="new-agent-prompt"
              rows={5}
              // Keep compact monospace code text instead of the base prose typography.
              className="font-mono text-xs"
              value={form.systemPrompt}
              onChange={(event) => setForm({ ...form, systemPrompt: event.target.value })}
            />
          </Field>
          <div className="flex justify-end gap-2 border-t pt-3">
            <Button variant="outline" size="sm" onClick={close} disabled={create.isPending}>
              取消
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={create.isPending}
              aria-busy={create.isPending}
            >
              {create.isPending ? '创建中…' : '创建'}
            </Button>
          </div>
        </form>
        <ConfirmDialog
          open={confirmDiscard}
          onClose={() => setConfirmDiscard(false)}
          title="放弃未保存的更改？"
          description="关闭后新专家的配置会丢失。"
          confirmLabel="放弃并关闭"
          confirmDisabled={create.isPending}
          onConfirm={async () => {
            if (!create.isPending) onClose();
          }}
        />
        <ConfirmDialog
          open={blocker.status === 'blocked'}
          onClose={() => blocker.reset?.()}
          title="放弃未保存的更改？"
          description={
            create.isPending ? '正在保存，请等待请求完成。' : '离开后新专家的配置会丢失。'
          }
          confirmLabel="放弃并离开"
          confirmDisabled={create.isPending}
          onConfirm={async () => blocker.proceed()}
        />
      </DialogShell>
    </Dialog>
  );
}
