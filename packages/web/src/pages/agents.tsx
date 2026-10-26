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
  agentDuplicateInputSchema,
  agentInputSchema,
  BUILTIN_TOOLS,
  knowledgeMcpEntry,
  type Server,
} from '@agentport/shared';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  useBlocker,
  useLocation,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  Copy,
  Download,
  Ellipsis,
  FileCode,
  FileText,
  History,
  LibraryBig,
  Plug,
  Plus,
  Puzzle,
  RotateCcw,
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
import { type Control, type Path, type PathValue, useController, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
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
import { Checkbox } from '../components/ui/checkbox.js';
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
  SelectLabel,
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
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { Textarea } from '../components/ui/textarea.js';
import { Toggle } from '../components/ui/toggle.js';
import type { AgentFiles, AgentVersionSummary } from '../lib/api.js';
import { ApiError, api } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { useFormBlocker } from '../lib/form.js';
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
  useDuplicateAgent,
  useKnowledgeBases,
  usePlugins,
  useRollbackAgent,
  useServers,
  useSkills,
  useUpdateAgent,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { useZodForm } from '../lib/use-zod-form.js';
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
  pluginBindings: [],
  subAgentIds: [],
  allowedTools: [],
  disallowedTools: [],
  permissionMode: 'dontAsk',
  uiFormat: 'markdown',
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
    pluginBindings: agent.pluginBindings,
    subAgentIds: agent.subAgentIds,
    allowedTools: agent.allowedTools,
    disallowedTools: agent.disallowedTools,
    permissionMode: agent.permissionMode,
    uiFormat: agent.uiFormat,
    maxTurns: agent.maxTurns,
    maxBudgetUsd: agent.maxBudgetUsd,
    timeoutMs: agent.timeoutMs,
    enabled: agent.enabled,
    // 显式保留 undefined 键：RHF 的 defaultValues 必须覆盖每个受控字段，
    // 否则 reset 后 useController 写回的 undefined 会让表单再次判定为 dirty。
    effort: agent.effort,
    ...(agent.maxThinkingTokens === undefined
      ? {}
      : { maxThinkingTokens: agent.maxThinkingTokens }),
  };
}

const positiveIntMessage = '必须大于 0，请调整后再保存';
const invalidNumberMessage = '请填写有效内容';
const thinkingMessage = '请输入大于 0 的整数，或留空表示不设置。';

/** 每行一个工具名；空白行忽略，中间空白行不会把未完成的草稿规范化掉。 */
function toolLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * 表单里保留原始文本：工具列表和思考上限在输入过程中可能还不合法，
 * 但 RHF 必须能存住这份中间草稿，提交时才解析成 AgentInput。
 */
type AgentDraft = Omit<AgentInput, 'allowedTools' | 'maxThinkingTokens'> & {
  allowedTools: string;
  maxThinkingTokens: string;
};

function draftFromInput(input: AgentInput): AgentDraft {
  return {
    ...input,
    allowedTools: input.allowedTools.join('\n'),
    maxThinkingTokens: input.maxThinkingTokens === undefined ? '' : String(input.maxThinkingTokens),
  };
}

function inputFromDraft(draft: AgentDraft): AgentInput {
  const thinking = draft.maxThinkingTokens.trim();
  return {
    ...draft,
    allowedTools: toolLines(draft.allowedTools),
    maxThinkingTokens: thinking === '' ? undefined : Number(thinking),
  };
}

const agentFormSchema = agentInputSchema
  .omit({ allowedTools: true, maxThinkingTokens: true })
  .extend({
    name: z.string().min(1, '不能为空，请填写后再保存').max(128, '最多 128 个字符，请精简后再保存'),
    description: z.string().max(300, '最多 300 个字符，请精简后再保存').default(''),
    allowedTools: z.string().default(''),
    maxThinkingTokens: z.string().default(''),
    maxTurns: z
      .number({ error: invalidNumberMessage })
      .int(invalidNumberMessage)
      .positive(positiveIntMessage)
      .default(20),
    maxBudgetUsd: z.number({ error: invalidNumberMessage }).positive(positiveIntMessage).default(2),
    timeoutMs: z
      .number({ error: invalidNumberMessage })
      .int(invalidNumberMessage)
      .positive(positiveIntMessage)
      .default(600_000),
  })
  .superRefine((value, ctx) => {
    if (!toolLines(value.allowedTools).every((tool) => !/\s/.test(tool))) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedTools'],
        message: '每行只能有一个工具名或模式，不能包含空格。',
      });
    }
    const thinking = value.maxThinkingTokens.trim();
    const number = Number(thinking);
    if (thinking !== '' && !(Number.isInteger(number) && number > 0)) {
      ctx.addIssue({ code: 'custom', path: ['maxThinkingTokens'], message: thinkingMessage });
    }
  });

/** 新建时名称可以留空，提交时回退到 slug；编辑时名称必须非空。 */
const agentCreateFormSchema = agentFormSchema.safeExtend({
  name: z.string().max(128, '最多 128 个字符，请精简后再保存'),
});

const duplicateFormSchema = agentDuplicateInputSchema.extend({
  slug: z
    .string()
    .min(1, '不能为空，请填写后再保存')
    .max(64, '最多 64 个字符，请精简后再保存')
    .regex(/^[a-z0-9][a-z0-9-_]*$/, '格式不正确，请检查后重新填写'),
  name: z
    .string()
    .trim()
    .min(1, '不能为空，请填写后再保存')
    .max(128, '最多 128 个字符，请精简后再保存'),
});

export function AgentsPage() {
  const agents = useAgents();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ from: '/_shell/agents/' });
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
      const result = isMarkdown
        ? await api.importAgentFile(await file.text())
        : await api.importAgent(file);
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
            accept="application/zip,.zip,text/markdown,.md"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importFile(file);
            }}
          />
          <Button
            variant="outline"
            title="导入专家 ZIP 或 agent.md"
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
  const params = useParams({ from: '/_shell/agents/$agentId' });
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
          <PageHeader title="专家" />
          <LoadingState rows={6} />
        </Page>
      );
    }
    if (agent.isError) {
      return (
        <Page>
          <PageHeader title="专家" />
          <ErrorState error={agent.error} onRetry={() => void agent.refetch()} />
        </Page>
      );
    }
    return (
      <Page>
        <PageHeader title="专家" />
        <PageNote
          icon={<Bot />}
          title="专家不存在"
          description="它可能已被删除，返回列表重新选择。"
          action={
            <Button variant="outline" onClick={backToList}>
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
      <div className="flex min-w-0 flex-col gap-2">
        <PageHeader
          leading={<AgentAvatar agent={current} className="size-11" />}
          title={current.name}
          eyebrow={
            <StatusBadge className="max-w-full whitespace-normal break-words">
              {current.role?.trim() || '通用助手'}
            </StatusBadge>
          }
          actions={
            <Button variant="outline" onClick={backToList} disabled={pending}>
              <ArrowLeft data-icon="inline-start" /> 返回列表
            </Button>
          }
        />
        {current.description ? (
          <p className="max-w-[70ch] break-words text-sm text-muted-foreground">
            {current.description}
          </p>
        ) : null}
      </div>
      <AgentEditor
        key={current.id}
        agent={current}
        onDirtyChange={() => {}}
        onPendingChange={setPending}
        onDeleteRequest={() => setDeleting(true)}
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
type TabId = 'config' | 'memory' | 'rules' | 'styles' | 'files' | 'stats';

const sectionItems: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: 'identity', label: '身份' },
  { id: 'behavior', label: '行为' },
  { id: 'capability', label: '能力' },
  { id: 'permissions', label: '权限' },
  { id: 'limits', label: '运行限制' },
];

const tabItems: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'config', label: '配置' },
  { id: 'memory', label: '长期记忆' },
  { id: 'rules', label: '项目规则' },
  { id: 'styles', label: '输出风格' },
  { id: 'files', label: '完整文件' },
  { id: 'stats', label: '运行统计' },
];

const tabOptions = tabItems.map((item) => ({ value: item.id, label: item.label }));

/** 普通连接器与知识库共用一个 serverIds：只替换知识库那部分，其余绑定原样保留。 */
function mergeKnowledgeIds(current: string[], knowledgeIds: Set<string>, next: string[]): string[] {
  return [...current.filter((id) => !knowledgeIds.has(id)), ...next];
}

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
  uiFormat: 'limits',
  maxTurns: 'limits',
  maxBudgetUsd: 'limits',
  timeoutMs: 'limits',
  maxThinkingTokens: 'limits',
};

export function AgentEditor({
  agent,
  onDirtyChange,
  onPendingChange,
  onDeleteRequest,
}: {
  agent: Agent;
  onDirtyChange: (dirty: boolean) => void;
  onPendingChange: (pending: boolean) => void;
  onDeleteRequest: () => void;
}) {
  const update = useUpdateAgent();
  const servers = useServers();
  const knowledgeBases = useKnowledgeBases();
  const skills = useSkills();
  const plugins = usePlugins();
  const agents = useAgents();
  // 绑定来源路由后，navigate 的 current 只含本路由 search，不会被其他路由的联合类型污染。
  const navigate = useNavigate({ from: '/agents/$agentId' });
  const search = useSearch({ from: '/_shell/agents/$agentId' });
  const serverAnchor = useComboboxAnchor();
  const knowledgeAnchor = useComboboxAnchor();
  const skillAnchor = useComboboxAnchor();
  const pluginAnchor = useComboboxAnchor();
  const subAgentAnchor = useComboboxAnchor();
  const [baseline, setBaseline] = useState(agent);
  const [conflict, setConflict] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const pending = update.isPending || reloading || rollingBack;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const duplicateTriggerRef = useRef<HTMLButtonElement>(null);
  const tabFromUrl = search.tab ?? 'config';
  const sectionFromUrl = search.section ?? 'identity';
  // 本地状态负责即时渲染，URL 负责刷新与分享；浏览器前进后退时再同步回来。
  const [tab, setTabState] = useState<TabId>(tabFromUrl);
  const [activeSection, setActiveSectionState] = useState<SectionId>(sectionFromUrl);
  const activeFile = search.file ?? '.mcp.json';
  useEffect(() => setTabState(tabFromUrl), [tabFromUrl]);
  useEffect(() => setActiveSectionState(sectionFromUrl), [sectionFromUrl]);
  // 任务、分区与文件都进 URL：刷新或分享后回到同一视图。
  const navigateSearch = (next: { tab?: TabId; section?: SectionId; file?: string }): void => {
    void navigate({
      to: '/agents/$agentId',
      params: { agentId: agent.id },
      // 以 router 最新 search 为基底，连续两次更新不会互相覆盖。
      search: (current) => ({ ...current, ...next }),
      replace: true,
    });
  };
  const setTab = (next: TabId): void => {
    setTabState(next);
    navigateSearch({ tab: next });
  };
  const setActiveSection = (next: SectionId): void => {
    setActiveSectionState(next);
    navigateSearch({ section: next });
  };
  const setActiveFile = (next: string): void => navigateSearch({ file: next });
  const files = useAgentFiles(agent.id);
  const fileEntries = files.data ? listWorkspaceFiles(files.data) : baseFileEntries;
  const resolvedEntry = fileEntries.find((entry) => entry.id === activeFile) ?? fileEntries[0];
  const resolvedId = resolvedEntry?.id;
  const fileGroups = [...new Set(fileEntries.map((entry) => entry.group))];
  const [exporting, setExporting] = useState(false);
  // RHF 是唯一数据源：多行工具与思考上限保留原始文本，提交时才解析。
  const rhf = useZodForm(agentFormSchema, { defaultValues: draftFromInput(toInput(agent)) });
  // defaultValues 覆盖全部字段；把 schema 输入的可选类型收敛回完整草稿。
  const control = rhf.control as unknown as Control<AgentDraft, unknown, AgentDraft>;
  const errors = rhf.formState.errors;
  const allowedInvalid = Boolean(errors.allowedTools);
  const thinkingInvalid = Boolean(errors.maxThinkingTokens);
  const roleField = useController({ control, name: 'role' }).field;
  const effortField = useController({ control, name: 'effort' }).field;
  const serverIdsField = useController({ control, name: 'serverIds' }).field;
  const skillIdsField = useController({ control, name: 'skillIds' }).field;
  const subAgentIdsField = useController({ control, name: 'subAgentIds' }).field;
  const pluginBindingsField = useController({ control, name: 'pluginBindings' }).field;
  const permissionModeField = useController({ control, name: 'permissionMode' }).field;
  const uiFormatField = useController({ control, name: 'uiFormat' }).field;
  const enabledField = useController({ control, name: 'enabled' }).field;
  // 只有工具文本参与派生状态；其余输入走非受控 register 或各自控件，不再整表订阅。
  const allowedToolsDraft = useWatch({ control, name: 'allowedTools' });
  const disallowedToolsDraft = useWatch({ control, name: 'disallowedTools' });

  const set = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]): void => {
    rhf.setValue(key as Path<AgentDraft>, value as PathValue<AgentDraft, Path<AgentDraft>>, {
      shouldDirty: true,
    });
    rhf.clearErrors(key);
  };

  const download = async (): Promise<void> => {
    setExporting(true);
    try {
      // 导出就是官方 `.claude/` 目录的 ZIP，浏览器直接落盘。
      const url = URL.createObjectURL(
        await api.exportAgent(agent.id, undefined, (warnings) => {
          for (const warning of warnings) toast.warning(warning);
        }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `${agent.slug}.zip`;
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

  const loadDraft = (next: Agent): void => {
    setBaseline(next);
    rhf.reset(draftFromInput(toInput(next)));
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
  const dirty = rhf.formState.isDirty;

  // 子面板（记忆 / 规则 / 输出风格）的草稿也要算进离开和任务切换保护。
  const [childDirty, setChildDirty] = useState(false);
  const [childPending, setChildPending] = useState(false);
  const [pendingTabState, setPendingTabState] = useState<TabId | null>(null);
  const guarded = dirty || childDirty;
  const locked = pending || childPending;

  const blocker = useBlocker({
    // 任务切换只改同页 search，由 changeTab 单独处理；这里只拦真正离开页面。
    shouldBlockFn: (args) => {
      if (args && args.current.pathname === args.next.pathname) return false;
      return guarded || locked;
    },
    withResolver: true,
    enableBeforeUnload: guarded || locked,
  });
  // 保存或子面板请求在途时，已打开的离开确认也不能继续。
  const proceedLeave = (): void => {
    if (!locked) blocker.proceed?.();
  };

  useEffect(() => {
    onDirtyChange(guarded || locked);
  }, [guarded, locked, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  useEffect(() => {
    onPendingChange(locked);
    return () => onPendingChange(false);
  }, [locked, onPendingChange]);

  /**
   * 主配置随 AgentEditor 常驻，切任务不丢草稿；子面板卸载会丢，有草稿时先确认。
   * 保存中不允许切走。
   */
  const changeTab = (next: TabId): void => {
    if (next === tab || locked) return;
    if (childDirty) {
      setPendingTabState(next);
      return;
    }
    setTab(next);
  };

  // 进入「完整文件」时滚回该栏顶部，避免停在上一份长文件的中段。
  useEffect(() => {
    if (tab !== 'files') return;
    const el = document.getElementById('agent-files-detail');
    el?.scrollIntoView({ block: 'start' });
  }, [tab]);

  /**
   * 知识库的 server 不出现在通用连接器列表（生命周期由知识库页管理），
   * 这里按知识库自带的 serverId 反向补齐，才能在这里完成绑定/解绑。
   * 已停用的库不可新增绑定，但既有绑定仍显示、仍随保存原样提交。
   */
  const knowledgeOptions = useMemo(
    () =>
      (knowledgeBases.data ?? []).map((base) => ({
        id: base.serverId,
        baseId: base.id,
        label: base.name,
        slug: base.slug,
        disabled: base.status !== 'active',
        updatedAt: base.updatedAt,
      })),
    [knowledgeBases.data],
  );

  // 知识库连接的运行条目与真实 server 行同形，草稿预览才与落盘/运行时一致。
  const knowledgeServers = useMemo<Server[]>(
    () =>
      knowledgeOptions
        .filter((item) => serverIdsField.value.includes(item.id))
        .map((item) => ({
          id: item.id,
          name: `kb-${item.slug}`,
          description: '',
          kind: 'knowledge',
          config: { knowledgeBaseId: item.baseId },
          createdAt: item.updatedAt,
          updatedAt: item.updatedAt,
        })),
    [knowledgeOptions, serverIdsField.value],
  );

  const knowledgeIds = useMemo(
    () => new Set(knowledgeOptions.map((item) => item.id)),
    [knowledgeOptions],
  );
  const setKnowledgeIds = (ids: string[]): void => {
    serverIdsField.onChange(mergeKnowledgeIds(serverIdsField.value, knowledgeIds, ids));
  };

  const boundServers = useMemo(
    () =>
      [...(servers.data ?? []), ...knowledgeServers].filter((server) =>
        serverIdsField.value.includes(server.id),
      ),
    [servers.data, knowledgeServers, serverIdsField.value],
  );
  const boundSkills = useMemo(
    () => (skills.data ?? []).filter((skill) => skillIdsField.value.includes(skill.id)),
    [skills.data, skillIdsField.value],
  );
  const boundSubAgents = useMemo(
    () =>
      (agents.data ?? [])
        .filter((item) => item.enabled && subAgentIdsField.value.includes(item.id))
        .map((item) => ({
          ...item,
          effort: item.effort ?? null,
          skills: (skills.data ?? []).filter((skill) => item.skillIds.includes(skill.id)),
        })),
    [agents.data, subAgentIdsField.value, skills.data],
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

  const pluginOptions = (plugins.data ?? []).map((plugin) => ({
    id: plugin.id,
    label: plugin.name,
    hint: plugin.runtimeName,
  }));

  /** 勾选插件即绑定；hooks / MCP 仍取该插件上次的授权状态（新的默认关闭）。 */
  const setPluginSelection = (pickedIds: string[]): void => {
    const previous = new Map(
      pluginBindingsField.value.map((binding) => [binding.pluginId, binding]),
    );
    set(
      'pluginBindings',
      pickedIds.map(
        (pluginId) => previous.get(pluginId) ?? { pluginId, allowHooks: false, allowMcp: false },
      ),
    );
  };

  const setPluginPermission = (
    pluginId: string,
    key: 'allowHooks' | 'allowMcp',
    value: boolean,
  ): void => {
    set(
      'pluginBindings',
      pluginBindingsField.value.map((binding) =>
        binding.pluginId === pluginId ? { ...binding, [key]: value } : binding,
      ),
    );
  };

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
    serverIdsField.value.length === 0
      ? '将获得 0 个工具'
      : toolCountUnknown
        ? '工具数量未知'
        : toolCountPending
          ? '工具数量加载中…'
          : `将获得 ${toolCount} 个工具${
              unknownServerCount > 0 ? ` · 另 ${unknownServerCount} 个 server 连接后确定` : ''
            }`;

  const hasSubAgents = subAgentIdsField.value.length > 0;
  const allowedTools = toolLines(allowedToolsDraft);
  /** 实际生效的内置工具状态：默认禁用 + 显式禁用，allowedTools 显式放行。 */
  const builtinEnabled = (tool: string): boolean => {
    // runner 只要 allowSubAgents 为真就放行 Agent/TaskStop，显式禁用拦不住。
    if ((tool === 'Agent' || tool === 'TaskStop') && hasSubAgents) return true;
    if (disallowedToolsDraft.includes(tool)) return false;
    return !DEFAULT_DISALLOWED_TOOLS.includes(tool) || allowedTools.includes(tool);
  };

  const toggleBuiltin = (tool: string): void => {
    // Agent/TaskStop 由子智能体绑定决定，开关不生效，避免写出误导性的 disallowedTools。
    if (tool === 'Agent' || tool === 'TaskStop') return;
    const enabled = builtinEnabled(tool);
    const nextTools = enabled
      ? allowedTools.filter((item) => item !== tool)
      : [...allowedTools, tool];
    set('allowedTools', nextTools.join('\n'));
    set(
      'disallowedTools',
      enabled
        ? [...new Set([...disallowedToolsDraft, tool])]
        : disallowedToolsDraft.filter((item) => item !== tool),
    );
  };

  // 这两项也由 zod 校验；保存被拦下时，按钮上的提示要指向所在分区。
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

  /** 错误字段所在分区可能不是当前选中项：先切过去，下一帧再聚焦真正出错的控件。 */
  const revealInvalidField = (): void => {
    const [section, id] =
      invalidField === 'limits'
        ? (['limits', 'agent-thinking'] as const)
        : (['permissions', 'agent-allowed-tools'] as const);
    focusSection(section, id);
  };

  const focusFirstInvalid = (section: SectionId): void => {
    if (tab !== 'config') setTab('config');
    if (activeSection !== section) setActiveSection(section);
    requestAnimationFrame(() => {
      const panel = document.getElementById(`agent-${section}`);
      const target = panel?.querySelector<HTMLElement>('[aria-invalid="true"]');
      target?.scrollIntoView({ block: 'center' });
      target?.focus();
    });
  };

  const save = rhf.handleSubmit(
    (draft) => {
      if (pending) return;
      const input = inputFromDraft(draft);
      update.mutate(
        {
          id: baseline.id,
          // 全量表单保存时显式发 null，才能清空已设为「默认」的字段。
          input: {
            ...input,
            effort: input.effort ?? null,
            maxThinkingTokens: input.maxThinkingTokens ?? null,
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
    },
    (invalid) => {
      // 错误可能不在当前分区：切到第一个出错的分区，下一帧聚焦该字段。
      const section = Object.keys(invalid)
        .map((key) => errorSections[key])
        .find((item): item is SectionId => item !== undefined);
      if (section) focusFirstInvalid(section);
    },
  );

  const sectionButtonClass = (active: boolean): string =>
    cn(
      'flex w-full items-center rounded-icon px-2 py-1.5 text-sm transition-colors md:text-left',
      active ? 'bg-selected font-medium text-fg' : 'text-muted-foreground hover:bg-hover',
    );

  /** 分区详情只挂载当前选中项：出错时先切分区，下一帧再聚焦字段。 */
  const focusSection = (section: SectionId, fieldId?: string): void => {
    if (tab !== 'config') setTab('config');
    if (activeSection !== section) setActiveSection(section);
    requestAnimationFrame(() => {
      const target = document.getElementById(fieldId ?? `agent-${section}`);
      target?.scrollIntoView({ block: fieldId ? 'center' : 'start' });
      if (fieldId) (target as HTMLElement | null)?.focus();
    });
  };

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
  const uiFormatOptions = [
    { value: 'markdown', label: 'Markdown' },
    { value: 'openui', label: '生成式 UI' },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-5">
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
      <div className="flex min-w-0 flex-wrap items-center gap-3 border-b pb-3">
        <Tabs
          value={tab}
          onValueChange={(next) => changeTab(next as TabId)}
          className="hidden min-w-0 md:flex"
        >
          <TabsList variant="line" aria-label="配置任务">
            {tabItems.map((item) => (
              <TabsTrigger key={item.id} value={item.id} disabled={locked}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Select
          value={tab}
          disabled={locked}
          items={tabOptions}
          onValueChange={(next) => {
            if (next !== null) changeTab(next as TabId);
          }}
        >
          <SelectTrigger className="w-full md:hidden" aria-label="配置任务">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {tabItems.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {tab === 'config' ? (
          <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
            <label
              data-disabled={pending}
              htmlFor="agent-enabled"
              className="inline-flex items-center gap-2 rounded-item p-1 text-xs text-muted-foreground transition-colors hover:bg-hover hover:text-fg"
            >
              <Switch
                disabled={pending}
                id="agent-enabled"
                checked={enabledField.value}
                onCheckedChange={(enabled) => enabledField.onChange(enabled)}
                aria-label="启用专家"
                title={enabledField.value ? '已启用，点击停用' : '已停用，点击启用'}
              />
              {enabledField.value ? '已启用' : '已停用'}
            </label>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
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
                  <Button type="button" variant="link" size="xs" onClick={revealInvalidField}>
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
                    <Check data-icon="inline-start" /> 已保存
                  </>
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="版本历史"
                title="配置版本历史"
                disabled={pending}
                onClick={() => setHistoryOpen(true)}
              >
                <History />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      ref={duplicateTriggerRef}
                      variant="ghost"
                      size="icon"
                      aria-label="更多操作"
                      disabled={pending}
                    >
                      <Ellipsis />
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
                    <DropdownMenuItem
                      disabled={pending || dirty}
                      onClick={() => setDuplicateOpen(true)}
                    >
                      <Copy className="size-4" /> 克隆专家
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={exporting} onClick={() => void download()}>
                      <Download className="size-4" /> {exporting ? '导出中…' : '导出 ZIP'}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={pending}
                    onClick={onDeleteRequest}
                  >
                    <Trash2 className="size-4" /> 删除专家
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        ) : null}
      </div>

      {tab === 'config' ? (
        <div className="grid items-start gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
          <nav aria-label="配置分区" className="min-w-0">
            <ul className="flex flex-wrap gap-1 md:flex-col md:flex-nowrap md:gap-0.5">
              {sectionItems.map((item) => (
                <li key={item.id} className="min-w-0">
                  <button
                    type="button"
                    aria-current={activeSection === item.id ? 'true' : undefined}
                    onClick={() => focusSection(item.id)}
                    className={sectionButtonClass(activeSection === item.id)}
                  >
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <div className="min-w-0">
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                // 返回 promise 让调用方（含测试）能等这次校验与保存走完。
                if (dirty && !pending) return save();
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
                          {...rhf.register('name')}
                          disabled={pending}
                          id="agent-name"
                          aria-required="true"
                          aria-invalid={Boolean(errors.name)}
                          aria-describedby={errors.name ? 'agent-name-error' : undefined}
                        />
                        <FieldError id="agent-name-error">{errors.name?.message}</FieldError>
                      </Field>
                      <Field
                        data-disabled={pending}
                        className="gap-1.5"
                        data-invalid={Boolean(errors.role)}
                      >
                        <FieldLabel htmlFor="agent-role">角色</FieldLabel>
                        <Select
                          disabled={pending}
                          value={roleField.value}
                          items={
                            roleOptions.some((option) => option.value === roleField.value)
                              ? roleOptions
                              : [{ value: roleField.value, label: roleField.value }, ...roleOptions]
                          }
                          onValueChange={(role) => {
                            if (role !== null) roleField.onChange(role);
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
                              {!roleOptions.some((option) => option.value === roleField.value) ? (
                                <SelectItem value={roleField.value} disabled>
                                  {roleField.value}
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
                        <FieldError id="agent-role-error">{errors.role?.message}</FieldError>
                      </Field>
                      <Field
                        data-disabled={pending}
                        className="gap-1.5 sm:col-span-2"
                        data-invalid={Boolean(errors.description)}
                      >
                        <FieldLabel htmlFor="agent-desc">描述</FieldLabel>
                        <Input
                          {...rhf.register('description')}
                          disabled={pending}
                          id="agent-desc"
                          aria-invalid={Boolean(errors.description)}
                          aria-describedby={errors.description ? 'agent-desc-error' : undefined}
                          placeholder="一句话说明它擅长什么"
                        />
                        <FieldError id="agent-desc-error">{errors.description?.message}</FieldError>
                      </Field>
                      <Field className="gap-1.5 sm:col-span-2" data-disabled="true">
                        <FieldLabel htmlFor="agent-slug">Slug</FieldLabel>
                        <Input
                          id="agent-slug"
                          value={agent.slug}
                          // Keep monospace technical identifiers instead of the base sans-serif input.
                          className="font-mono"
                          disabled
                          aria-describedby="agent-slug-hint"
                        />
                        <FieldDescription id="agent-slug-hint">创建后不可修改</FieldDescription>
                      </Field>
                    </FieldGroup>
                  </Section>
                ) : null}

                {activeSection === 'behavior' ? (
                  <Section id="behavior" title="行为">
                    <FieldGroup className="grid gap-5 sm:grid-cols-2">
                      <Field data-disabled={pending} className="gap-1.5">
                        <FieldLabel htmlFor="agent-model">模型</FieldLabel>
                        <Input
                          {...rhf.register('model')}
                          disabled={pending}
                          id="agent-model"
                          list="agent-models"
                          // Keep monospace technical identifiers instead of the base sans-serif input.
                          className="font-mono"
                        />
                        <datalist id="agent-models">
                          {models.map((model) => (
                            <option key={model} value={model} />
                          ))}
                        </datalist>
                      </Field>
                      <Field data-disabled={pending} className="gap-1.5">
                        <FieldLabel htmlFor="agent-effort">推理强度</FieldLabel>
                        <Select
                          disabled={pending}
                          value={effortField.value ?? ''}
                          onValueChange={(value) => {
                            if (value !== null) {
                              effortField.onChange(
                                value === '' ? undefined : (value as AgentInput['effort']),
                              );
                            }
                          }}
                          items={effortOptions}
                        >
                          <SelectTrigger id="agent-effort" className="w-full min-w-0">
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

                    <Field data-disabled={pending} className="gap-1.5">
                      <FieldLabel htmlFor="agent-prompt">
                        {roleField.value === '数字分身' ? '工作背景与表达方式' : '系统提示词'}
                      </FieldLabel>
                      <Textarea
                        {...rhf.register('systemPrompt')}
                        disabled={pending}
                        id="agent-prompt"
                        rows={16}
                        // Keep monospace code text instead of the base prose typography.
                        className="font-mono leading-relaxed"
                        placeholder="描述角色、边界与工作方式"
                      />
                    </Field>

                    <DraftPreview
                      title="CLAUDE.md 草稿"
                      view="claude"
                      control={control}
                      servers={boundServers}
                      skills={boundSkills}
                      subAgents={boundSubAgents}
                    />
                  </Section>
                ) : null}

                {activeSection === 'capability' ? (
                  <Section id="capability" title="能力">
                    <div className="flex flex-col gap-4">
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
                              serverIdsField.value.includes(option.id),
                            )}
                            onValueChange={(picked) => {
                              serverIdsField.onChange([
                                ...serverIdsField.value.filter(
                                  (id) => !serverOptions.some((option) => option.id === id),
                                ),
                                ...picked.map((option) => option.id),
                              ]);
                            }}
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
                                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
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
                            <LibraryBig
                              className="size-4 text-muted-foreground"
                              aria-hidden="true"
                            />
                            知识库
                          </h3>
                          <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                            已选 {serverIdsField.value.filter((id) => knowledgeIds.has(id)).length}
                          </span>
                        </div>
                        {knowledgeBases.isPending ? <LoadingState rows={1} /> : null}
                        {knowledgeBases.isError ? (
                          <ErrorState
                            error={knowledgeBases.error}
                            onRetry={() => void knowledgeBases.refetch()}
                          />
                        ) : null}
                        {knowledgeBases.data && knowledgeOptions.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            前往知识库页面创建，创建后即可在这里绑定。
                          </p>
                        ) : null}
                        {knowledgeOptions.length > 0 ? (
                          <Combobox
                            disabled={pending}
                            multiple
                            items={knowledgeOptions}
                            value={knowledgeOptions.filter((option) =>
                              serverIdsField.value.includes(option.id),
                            )}
                            onValueChange={(picked) => {
                              setKnowledgeIds(picked.map((option) => option.id));
                            }}
                            itemToStringLabel={(option) => option.label}
                            itemToStringValue={(option) => option.id}
                            isItemEqualToValue={(a, b) => a.id === b.id}
                            filter={(option, query) =>
                              `${option.label} ${option.slug}`
                                .toLowerCase()
                                .includes(query.trim().toLowerCase())
                            }
                          >
                            <ComboboxChips
                              aria-label="已选知识库"
                              data-disabled={pending}
                              ref={knowledgeAnchor}
                            >
                              <ComboboxValue>
                                {(selected: typeof knowledgeOptions) =>
                                  selected.map((option) => (
                                    <ComboboxChip key={option.id} aria-label={option.label}>
                                      {option.label}
                                    </ComboboxChip>
                                  ))
                                }
                              </ComboboxValue>
                              <ComboboxChipsInput
                                aria-label="知识库"
                                placeholder="搜索并选择知识库…"
                              />
                            </ComboboxChips>
                            <ComboboxContent anchor={knowledgeAnchor}>
                              <ComboboxEmpty>没有匹配的知识库</ComboboxEmpty>
                              <ComboboxList>
                                {(option: (typeof knowledgeOptions)[number]) => (
                                  <ComboboxItem
                                    key={option.id}
                                    value={option}
                                    // 已停用的库不能再新绑；已绑定的仍可保留或解绑。
                                    disabled={
                                      option.disabled && !serverIdsField.value.includes(option.id)
                                    }
                                  >
                                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                                    {option.disabled ? <StatusBadge>已停用</StatusBadge> : null}
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
                            已选 {skillIdsField.value.length}
                          </span>
                        </div>
                        {skills.isPending ? <LoadingState rows={1} /> : null}
                        {skills.isError ? (
                          <ErrorState error={skills.error} onRetry={() => void skills.refetch()} />
                        ) : null}
                        {skills.data && skills.data.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            前往技能页创建或安装技能。
                          </p>
                        ) : null}
                        {skills.data && skills.data.length > 0 ? (
                          <Combobox
                            disabled={pending}
                            multiple
                            items={skillOptions}
                            value={skillOptions.filter((option) =>
                              skillIdsField.value.includes(option.id),
                            )}
                            onValueChange={(picked) => {
                              skillIdsField.onChange(picked.map((option) => option.id));
                            }}
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
                            <Puzzle className="size-4 text-muted-foreground" aria-hidden="true" />
                            插件
                          </h3>
                          <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                            {pluginBindingsField.value.length > 0
                              ? `${pluginBindingsField.value.length} 个已启用`
                              : '未启用'}
                          </span>
                        </div>
                        {agent.parentId !== null ? (
                          <p className="text-xs text-muted-foreground">
                            插件在会话级加载，子智能体不能单独绑定。
                          </p>
                        ) : plugins.isPending ? (
                          <LoadingState rows={1} />
                        ) : plugins.isError ? (
                          <ErrorState
                            error={plugins.error}
                            onRetry={() => void plugins.refetch()}
                          />
                        ) : pluginOptions.length === 0 ? (
                          <Button
                            variant="outline"
                            size="sm"
                            nativeButton={false}
                            render={<Link to="/plugins" />}
                          >
                            导入插件
                          </Button>
                        ) : (
                          <>
                            <Combobox
                              disabled={pending}
                              multiple
                              items={pluginOptions}
                              value={pluginOptions.filter((option) =>
                                pluginBindingsField.value.some((b) => b.pluginId === option.id),
                              )}
                              onValueChange={(picked) =>
                                setPluginSelection(picked.map((option) => option.id))
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
                                aria-label="已启用插件"
                                data-disabled={pending}
                                ref={pluginAnchor}
                              >
                                <ComboboxValue>
                                  {(selected: typeof pluginOptions) =>
                                    selected.map((option) => (
                                      <ComboboxChip key={option.id} aria-label={option.label}>
                                        {option.label}
                                      </ComboboxChip>
                                    ))
                                  }
                                </ComboboxValue>
                                <ComboboxChipsInput
                                  aria-label="插件"
                                  placeholder="搜索并选择插件…"
                                />
                              </ComboboxChips>
                              <ComboboxContent anchor={pluginAnchor}>
                                <ComboboxEmpty>没有匹配的插件</ComboboxEmpty>
                                <ComboboxList>
                                  {(option: (typeof pluginOptions)[number]) => (
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
                            {pluginBindingsField.value.length > 0 ? (
                              <ul className="mt-2 flex flex-col gap-1.5">
                                {pluginBindingsField.value.map((binding) => {
                                  const plugin = (plugins.data ?? []).find(
                                    (item) => item.id === binding.pluginId,
                                  );
                                  if (!plugin) return null;
                                  return (
                                    <li
                                      key={binding.pluginId}
                                      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
                                    >
                                      <span className="font-medium text-fg">{plugin.name}</span>
                                      {plugin.capabilities.hasHooks ? (
                                        <span className="flex items-center gap-1.5">
                                          <Checkbox
                                            id={`plugin-${binding.pluginId}-hooks`}
                                            checked={binding.allowHooks}
                                            disabled={pending}
                                            onCheckedChange={(checked) =>
                                              setPluginPermission(
                                                binding.pluginId,
                                                'allowHooks',
                                                checked === true,
                                              )
                                            }
                                          />
                                          <label htmlFor={`plugin-${binding.pluginId}-hooks`}>
                                            允许 hooks
                                          </label>
                                        </span>
                                      ) : null}
                                      {plugin.capabilities.mcpServers.length > 0 ? (
                                        <span className="flex items-center gap-1.5">
                                          <Checkbox
                                            id={`plugin-${binding.pluginId}-mcp`}
                                            checked={binding.allowMcp}
                                            disabled={pending}
                                            onCheckedChange={(checked) =>
                                              setPluginPermission(
                                                binding.pluginId,
                                                'allowMcp',
                                                checked === true,
                                              )
                                            }
                                          />
                                          <label htmlFor={`plugin-${binding.pluginId}-mcp`}>
                                            允许 MCP
                                          </label>
                                        </span>
                                      ) : null}
                                    </li>
                                  );
                                })}
                              </ul>
                            ) : null}
                            <p className="mt-1.5 text-xs text-muted-foreground">
                              hooks 与 MCP
                              默认关闭：插件启动的进程以沙盒内用户权限运行，不经过平台的审批与审计。
                            </p>
                          </>
                        )}
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
                              subAgentIdsField.value.includes(option.id),
                            )}
                            onValueChange={(picked) => {
                              subAgentIdsField.onChange(picked.map((option) => option.id));
                            }}
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
                            <FileText className="size-4 text-muted-foreground" aria-hidden="true" />{' '}
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
                            技能文件与 MCP 连接配置需来自同一工作区。
                          </p>
                          {subAgentIdsField.value.length !== agent.subAgentIds.length ||
                          subAgentIdsField.value.some((id) => !agent.subAgentIds.includes(id)) ? (
                            <p className="text-xs text-muted-foreground">
                              绑定未保存 · 下载的是已保存版本。
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>

                    <DraftPreview
                      title=".mcp.json 与 frontmatter 草稿"
                      view="files"
                      control={control}
                      servers={boundServers}
                      skills={boundSkills}
                      subAgents={boundSubAgents}
                    />
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
                          value={permissionModeField.value}
                          onValueChange={(next) => {
                            if (next !== null) {
                              permissionModeField.onChange(next as AgentInput['permissionMode']);
                            }
                          }}
                          items={permissionOptions}
                        >
                          <SelectTrigger id="agent-perm" className="w-full min-w-0">
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
                          {...rhf.register('allowedTools')}
                          disabled={pending}
                          id="agent-allowed-tools"
                          rows={3}
                          // Keep monospace code text instead of the base prose typography.
                          className="font-mono leading-relaxed"
                          placeholder={'mcp__jsonplaceholder__get_user\nmcp__crm__*'}
                          aria-invalid={allowedInvalid}
                          aria-describedby={
                            allowedInvalid
                              ? 'agent-allowed-tools-error'
                              : 'agent-allowed-tools-hint'
                          }
                        />
                        {allowedInvalid ? (
                          <FieldError id="agent-allowed-tools-error">
                            {errors.allowedTools?.message}
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
                      <div className="flex flex-wrap gap-2">
                        {BUILTIN_TOOLS.map((tool) => {
                          const enabled = builtinEnabled(tool);
                          const fixed = tool === 'Agent' || tool === 'TaskStop';
                          return (
                            <Toggle
                              key={tool}
                              variant="outline"
                              size="sm"
                              pressed={enabled}
                              onPressedChange={() => toggleBuiltin(tool)}
                              disabled={fixed || pending}
                              title={
                                fixed
                                  ? enabled
                                    ? '由子智能体绑定放行；解绑子智能体后自动禁用'
                                    : '绑定子智能体后自动放行'
                                  : enabled
                                    ? '已放行：点击禁用'
                                    : '已禁用：点击放行'
                              }
                              className="font-mono"
                            >
                              {tool}
                              <span className="sr-only">
                                {enabled ? '：已启用' : '：已禁用'}
                                {fixed ? '，由子智能体绑定决定' : ''}
                              </span>
                            </Toggle>
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
                          {...rhf.register('maxTurns', { valueAsNumber: true })}
                          disabled={pending}
                          id="agent-turns"
                          type="number"
                          min={1}
                          inputMode="numeric"
                          aria-invalid={Boolean(errors.maxTurns)}
                          aria-describedby={errors.maxTurns ? 'agent-turns-error' : undefined}
                        />
                        <FieldError id="agent-turns-error">{errors.maxTurns?.message}</FieldError>
                      </Field>
                      <Field
                        data-disabled={pending}
                        className="gap-1.5"
                        data-invalid={Boolean(errors.maxBudgetUsd)}
                      >
                        <FieldLabel htmlFor="agent-budget">预算上限 (USD)</FieldLabel>
                        <Input
                          {...rhf.register('maxBudgetUsd', { valueAsNumber: true })}
                          disabled={pending}
                          id="agent-budget"
                          type="number"
                          min={0.01}
                          step={0.01}
                          inputMode="decimal"
                          aria-invalid={Boolean(errors.maxBudgetUsd)}
                          aria-describedby={errors.maxBudgetUsd ? 'agent-budget-error' : undefined}
                        />
                        <FieldError id="agent-budget-error">
                          {errors.maxBudgetUsd?.message}
                        </FieldError>
                      </Field>
                      <Field
                        data-disabled={pending}
                        className="gap-1.5"
                        data-invalid={Boolean(errors.timeoutMs)}
                      >
                        <FieldLabel htmlFor="agent-timeout">超时 (毫秒)</FieldLabel>
                        <Input
                          {...rhf.register('timeoutMs', { valueAsNumber: true })}
                          disabled={pending}
                          id="agent-timeout"
                          type="number"
                          min={1000}
                          step={1000}
                          inputMode="numeric"
                          aria-invalid={Boolean(errors.timeoutMs)}
                          aria-describedby={errors.timeoutMs ? 'agent-timeout-error' : undefined}
                        />
                        <FieldError id="agent-timeout-error">
                          {errors.timeoutMs?.message}
                        </FieldError>
                      </Field>
                      <Field
                        data-disabled={pending}
                        className="gap-1.5"
                        data-invalid={thinkingInvalid}
                      >
                        <FieldLabel htmlFor="agent-thinking">最大思考 tokens</FieldLabel>
                        <Input
                          {...rhf.register('maxThinkingTokens')}
                          disabled={pending}
                          id="agent-thinking"
                          type="number"
                          min={1}
                          step={1}
                          inputMode="numeric"
                          placeholder="不设置"
                          aria-invalid={thinkingInvalid}
                          aria-describedby={
                            thinkingInvalid ? 'agent-thinking-error' : 'agent-thinking-hint'
                          }
                        />
                        {thinkingInvalid ? (
                          <FieldError id="agent-thinking-error">
                            {errors.maxThinkingTokens?.message}
                          </FieldError>
                        ) : (
                          <FieldDescription id="agent-thinking-hint">
                            留空表示不设置。
                          </FieldDescription>
                        )}
                      </Field>
                      <Field data-disabled={pending} className="gap-1.5">
                        <FieldLabel htmlFor="agent-ui-format">回复格式</FieldLabel>
                        <Select
                          disabled={pending}
                          value={uiFormatField.value}
                          onValueChange={(value) => {
                            if (value !== null) {
                              uiFormatField.onChange(value as AgentInput['uiFormat']);
                            }
                          }}
                          items={uiFormatOptions}
                        >
                          <SelectTrigger id="agent-ui-format" className="w-full min-w-0">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {uiFormatOptions.map((option) => (
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
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {tab === 'files' ? (
        <div className="grid items-start gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
          <nav aria-label="工作区文件" className="hidden min-w-0 md:block">
            <ul className="flex flex-col gap-0.5">
              {fileGroups.map((group) => (
                <Fragment key={group}>
                  <li className="min-w-0">
                    <p className="px-2 pt-1 pb-0.5 text-2xs text-muted-foreground">{group}</p>
                  </li>
                  {fileEntries
                    .filter((entry) => entry.group === group)
                    .map((entry) => (
                      <li key={entry.id} className="min-w-0">
                        <button
                          type="button"
                          aria-current={resolvedId === entry.id ? 'true' : undefined}
                          onClick={() => setActiveFile(entry.id)}
                          className={sectionButtonClass(resolvedId === entry.id)}
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
            </ul>
          </nav>
          <div className="flex min-w-0 flex-col gap-3 md:hidden">
            <Select
              value={resolvedId}
              items={fileEntries.map((entry) => ({ value: entry.id, label: entry.path }))}
              onValueChange={(next) => {
                if (next !== null) setActiveFile(next);
              }}
            >
              <SelectTrigger className="w-full min-w-0" aria-label="当前文件">
                <SelectValue className="truncate" placeholder="选择文件" />
              </SelectTrigger>
              <SelectContent>
                {fileGroups.map((group) => (
                  <SelectGroup key={group}>
                    <SelectLabel>{group}</SelectLabel>
                    {fileEntries
                      .filter((entry) => entry.group === group)
                      .map((entry) => (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.path}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div
            id="agent-files-detail"
            className="min-w-0 scroll-mt-4 rounded-card bg-surface px-6 py-5 ring-1 ring-line"
          >
            <FilesPreview entry={resolvedEntry} dirty={dirty} files={files} />
          </div>
        </div>
      ) : null}

      {tab === 'memory' ? (
        <div className="min-w-0 rounded-card bg-surface px-6 py-5 ring-1 ring-line">
          <MemoryPanel
            agentId={agent.id}
            onDirtyChange={setChildDirty}
            onPendingChange={setChildPending}
          />
        </div>
      ) : null}

      {tab === 'rules' ? (
        <div className="min-w-0 rounded-card bg-surface px-6 py-5 ring-1 ring-line">
          <RulesPanel
            agentId={agent.id}
            onDirtyChange={setChildDirty}
            onPendingChange={setChildPending}
          />
        </div>
      ) : null}

      {tab === 'styles' ? (
        <div className="min-w-0 rounded-card bg-surface px-6 py-5 ring-1 ring-line">
          <OutputStylesPanel
            agentId={agent.id}
            onDirtyChange={setChildDirty}
            onPendingChange={setChildPending}
          />
        </div>
      ) : null}

      {tab === 'stats' ? <AgentStatsPanel agentId={agent.id} /> : null}

      <ConfirmDialog
        open={pendingTabState !== null}
        onClose={() => setPendingTabState(null)}
        title="放弃未保存的修改并切换？"
        description="当前记忆、规则或输出风格还有未保存的内容，切换任务后会丢失。配置草稿会保留。"
        confirmLabel="放弃并切换"
        confirmDisabled={locked}
        onConfirm={async () => {
          if (pendingTabState) setTab(pendingTabState);
          setPendingTabState(null);
        }}
      />

      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onClose={() => blocker.reset?.()}
        title="放弃未保存的更改？"
        description={`「${agent.name}」还有未保存的修改，离开后会丢失。可以先取消、保存后再离开。`}
        confirmLabel="放弃并离开"
        confirmDisabled={locked}
        onConfirm={async () => {
          proceedLeave();
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

      {duplicateOpen ? (
        <DuplicateAgentDialog
          agent={agent}
          onClose={() => setDuplicateOpen(false)}
          getReturnFocus={() =>
            duplicateTriggerRef.current?.isConnected ? duplicateTriggerRef.current : null
          }
        />
      ) : null}
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
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

type PreviewSkill = { slug: string; name: string; description: string; body: string };
type PreviewSubAgent = {
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
  skills?: PreviewSkill[];
};
type DraftPreviewInput = Pick<
  AgentInput,
  | 'slug'
  | 'name'
  | 'description'
  | 'model'
  | 'systemPrompt'
  | 'maxTurns'
  | 'permissionMode'
  | 'effort'
  | 'allowedTools'
  | 'disallowedTools'
>;

const previewFieldNames = [
  'slug',
  'name',
  'description',
  'model',
  'systemPrompt',
  'maxTurns',
  'permissionMode',
  'effort',
  'allowedTools',
  'disallowedTools',
] as const;

/** 草稿预览：折叠在表单里；展开后才挂载渲染，内容随表单实时变化。 */
function DraftPreview({
  title,
  view,
  control,
  servers,
  skills,
  subAgents,
}: {
  title: string;
  view: 'claude' | 'files';
  control: Control<AgentDraft, unknown, AgentDraft>;
  servers: Server[];
  skills: PreviewSkill[];
  subAgents: PreviewSubAgent[];
}) {
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
                <DraftPreviewBody
                  view={view}
                  control={control}
                  servers={servers}
                  skills={skills}
                  subAgents={subAgents}
                />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 预览正文只在展开时存在：局部订阅草稿字段，避免每次按键重算整页。 */
function DraftPreviewBody({
  view,
  control,
  servers,
  skills,
  subAgents,
}: {
  view: 'claude' | 'files';
  control: Control<AgentDraft, unknown, AgentDraft>;
  servers: Server[];
  skills: PreviewSkill[];
  subAgents: PreviewSubAgent[];
}) {
  const [
    slug,
    name,
    description,
    model,
    systemPrompt,
    maxTurns,
    permissionMode,
    effort,
    allowedTools,
    disallowedTools,
  ] = useWatch({ control, name: previewFieldNames });
  const draft = draftFiles(
    {
      slug,
      name,
      description,
      model,
      systemPrompt,
      maxTurns,
      permissionMode,
      effort,
      allowedTools: toolLines(allowedTools),
      disallowedTools,
    },
    servers,
    skills,
    subAgents,
  );
  return (
    <CodeBlock
      code={view === 'claude' ? draft.claudeMd : previewFileDraft(draft, slug)}
      maxHeight="22rem"
    />
  );
}

function previewFileDraft(draft: WorkspaceFiles, slug: string): string {
  return [
    '// .mcp.json',
    draft.mcpJson,
    `// .claude/agents/${slug || '<slug>'}.md（主智能体，仅预览）`,
    draft.agentMd,
    ...(draft.subAgents.length > 0
      ? [
          '// 子智能体文件（各用自己的配置）',
          ...draft.subAgents.map((sub) => `// .claude/agents/${sub.slug}.md`),
        ]
      : []),
  ].join('\n');
}

/**
 * 草稿预览直接调用 core 的渲染函数——不复制实现。
 *
 * 之前这里有一份「同构」副本，结果 core 新增「等待规则」与子智能体表格后
 * 副本没有跟上，预览与真实落盘内容出现差异，正好违背「配置即契约」。
 * core/workspace.ts 是纯函数、无 Node 依赖，浏览器可直接用。
 */
function draftFiles(
  draft: DraftPreviewInput,
  servers: Server[],
  skills: PreviewSkill[],
  subAgents: PreviewSubAgent[],
): WorkspaceFiles {
  return renderWorkspace({
    agent: {
      slug: draft.slug,
      name: draft.name,
      description: draft.description,
      model: draft.model,
      systemPrompt: draft.systemPrompt,
      maxTurns: draft.maxTurns,
      permissionMode: draft.permissionMode,
      effort: draft.effort ?? null,
      allowedTools: draft.allowedTools,
      disallowedTools: draft.disallowedTools,
    },
    // 预览只给键名：真实密钥永不出现在这里。
    servers: servers.map((server) => ({
      name: server.name,
      entry: previewEntry(server),
    })),
    skills,
    subAgents,
    ...(draft.allowedTools.length > 0 ? { toolsAllow: draft.allowedTools } : {}),
    ...(draft.disallowedTools.length > 0 ? { toolsDeny: draft.disallowedTools } : {}),
  });
}

/** `.mcp.json` 预览条目：密钥替换为占位符。 */
function previewEntry(server: Server): McpJsonEntry {
  if (server.kind === 'knowledge') {
    // 与运行时同一构造器：地址由平台拼，凭证按 run 注入，草稿里只留占位。
    return knowledgeMcpEntry({
      apiUrl: '<平台>',
      serverId: server.id,
      runId: '<run-id>',
      runToken: '<run-token>',
    });
  }
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
    ...(files.plugins ?? []).flatMap((plugin) =>
      plugin.files.map((file) => ({
        id: `.claude/plugins/${plugin.slug}/${file.path}`,
        path: `plugins/${plugin.slug}/${file.path}`,
        group: '插件',
        content: file.content,
      })),
    ),
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
      {entry?.id === '.mcp.json' ? (
        <p className="rounded-item bg-chip px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          密钥在运行时注入，此处显示为占位符。
        </p>
      ) : null}
      {dirty ? (
        <p className="rounded-item bg-chip px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          显示上次保存的文件；未保存内容见配置草稿。
        </p>
      ) : null}
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
  const rhf = useZodForm(agentCreateFormSchema, {
    defaultValues: draftFromInput({
      ...emptyInput,
      role: initialRole,
      name: initialRole === '数字分身' ? '我的分身' : '',
    }),
  });
  // defaultValues 覆盖全部字段；把 schema 输入的可选类型收敛回完整草稿。
  const control = rhf.control as unknown as Control<AgentDraft, unknown, AgentDraft>;
  const errors = rhf.formState.errors;
  const roleField = useController({ control, name: 'role' }).field;
  const modelField = useController({ control, name: 'model' }).field;
  const isTwin = roleField.value === '数字分身';
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [created, setCreated] = useState<Agent | null>(null);
  const dirty = rhf.formState.isDirty;
  const blocker = useFormBlocker(!created && dirty, !created && create.isPending);
  useEffect(() => {
    if (created) onCreated(created);
  }, [created, onCreated]);
  const close = (): void => {
    if (create.isPending) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const submit = rhf.handleSubmit((draft) => {
    if (create.isPending) return;
    // 名称留空时回退到 slug：schema 只要求 name 非空，这里补上用户没填时的可读名称。
    const input = inputFromDraft({ ...draft, name: draft.name.trim() || draft.slug });
    create.mutate(input, {
      onSuccess: (agent) => {
        toastSuccess('智能体已创建');
        setCreated(agent);
      },
      onError: (error) => toastError(error),
    });
  });

  const newModelOptions = modelOptions(modelField.value);

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
            return submit();
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
                {...rhf.register('slug')}
                disabled={create.isPending}
                id="new-agent-slug"
                placeholder="support-bot"
                // Keep monospace for the technical slug instead of the base sans-serif input.
                className="font-mono"
                aria-required="true"
                aria-invalid={Boolean(errors.slug)}
                aria-describedby={errors.slug ? 'new-agent-slug-error' : 'new-agent-slug-hint'}
              />
              {errors.slug ? (
                <FieldError id="new-agent-slug-error">{errors.slug?.message}</FieldError>
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
                {...rhf.register('name')}
                disabled={create.isPending}
                id="new-agent-name"
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'new-agent-name-error' : undefined}
                placeholder="客服助手"
              />
              <FieldError id="new-agent-name-error">{errors.name?.message}</FieldError>
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
                  value={roleField.value}
                  items={roleOptions}
                  onValueChange={(role) => {
                    if (role === null) return;
                    roleField.onChange(role);
                    if (role === '数字分身') {
                      rhf.setValue('name', rhf.getValues('name') || '我的分身', {
                        shouldDirty: true,
                      });
                    }
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
                <FieldError id="new-agent-role-error">{errors.role?.message}</FieldError>
              </Field>
            )}
          </FieldGroup>
          <Field data-disabled={create.isPending} className="gap-1.5">
            <FieldLabel htmlFor="new-agent-model">模型</FieldLabel>
            <Select
              disabled={create.isPending}
              value={modelField.value}
              onValueChange={(model) => {
                if (model !== null) modelField.onChange(model);
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
              {...rhf.register('systemPrompt')}
              disabled={create.isPending}
              id="new-agent-prompt"
              rows={5}
              // Keep compact monospace code text instead of the base prose typography.
              className="font-mono text-xs"
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

export function DuplicateAgentDialog({
  agent,
  onClose,
  getReturnFocus,
}: {
  agent: Agent;
  onClose: () => void;
  getReturnFocus: () => HTMLElement | null;
}) {
  const navigate = useNavigate();
  const duplicate = useDuplicateAgent();
  const [initial] = useState(() => ({
    name: `${agent.name} 副本`.slice(0, 128),
    slug: `${agent.slug}-copy`.slice(0, 64),
  }));
  const rhf = useZodForm(duplicateFormSchema, { defaultValues: initial });
  const errors = rhf.formState.errors;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [created, setCreated] = useState<Agent | null>(null);
  const dirty = rhf.formState.isDirty;
  const blocker = useFormBlocker(!created && dirty, !created && duplicate.isPending);
  // 先落成功状态再离开：blocker 下一次渲染才释放，直接 navigate 会被拦下。
  useEffect(() => {
    if (!created) return;
    onClose();
    void navigate({ to: '/agents/$agentId', params: { agentId: created.id } });
  }, [created, navigate, onClose]);
  const close = (): void => {
    if (duplicate.isPending) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const submit = rhf.handleSubmit((values) => {
    if (duplicate.isPending) return;
    duplicate.mutate(
      { id: agent.id, ...values },
      {
        onSuccess: (createdAgent) => {
          toastSuccess('已克隆专家');
          setCreated(createdAgent);
        },
        onError: (error) => {
          if (
            error instanceof ApiError &&
            error.status === 409 &&
            error.code === 'CONFLICT' &&
            !error.retryable
          ) {
            rhf.setError('slug', { type: 'server', message: '该 slug 已被占用' });
            return;
          }
          toastError(error);
        },
      },
    );
  });

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (duplicate.isPending) {
          details.cancel();
          return;
        }
        if (!next) close();
      }}
    >
      <DialogShell
        title="克隆专家"
        description="不包含子专家、记忆与历史记录。"
        closeDisabled={duplicate.isPending}
        finalFocus={getReturnFocus}
      >
        <form
          className="flex flex-col gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            return submit();
          }}
        >
          <FieldGroup className="grid gap-3 sm:grid-cols-2">
            <Field
              data-disabled={duplicate.isPending}
              className="gap-1.5 sm:col-span-2"
              data-invalid={Boolean(errors.name)}
            >
              <FieldLabel htmlFor="duplicate-agent-name">
                名称
                <RequiredMark />
              </FieldLabel>
              <Input
                {...rhf.register('name')}
                disabled={duplicate.isPending}
                id="duplicate-agent-name"
                aria-required="true"
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'duplicate-agent-name-error' : undefined}
              />
              <FieldError id="duplicate-agent-name-error">{errors.name?.message}</FieldError>
            </Field>
            <Field
              data-disabled={duplicate.isPending}
              className="gap-1.5 sm:col-span-2"
              data-invalid={Boolean(errors.slug)}
            >
              <FieldLabel htmlFor="duplicate-agent-slug">
                Slug
                <RequiredMark />
              </FieldLabel>
              <Input
                {...rhf.register('slug')}
                disabled={duplicate.isPending}
                id="duplicate-agent-slug"
                className="font-mono"
                aria-required="true"
                aria-invalid={Boolean(errors.slug)}
                aria-describedby={errors.slug ? 'duplicate-agent-slug-error' : undefined}
              />
              <FieldError id="duplicate-agent-slug-error">{errors.slug?.message}</FieldError>
            </Field>
          </FieldGroup>
          <div className="flex justify-end gap-2 border-t pt-3">
            <Button variant="outline" size="sm" onClick={close} disabled={duplicate.isPending}>
              取消
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={duplicate.isPending}
              aria-busy={duplicate.isPending}
            >
              {duplicate.isPending ? '克隆中…' : '克隆'}
            </Button>
          </div>
        </form>
        <ConfirmDialog
          open={confirmDiscard}
          onClose={() => setConfirmDiscard(false)}
          title="放弃未保存的更改？"
          description="关闭后克隆信息会丢失。"
          confirmLabel="放弃并关闭"
          confirmDisabled={duplicate.isPending}
          onConfirm={async () => {
            if (!duplicate.isPending) onClose();
          }}
        />
        <ConfirmDialog
          open={blocker.status === 'blocked'}
          onClose={() => blocker.reset?.()}
          title="放弃未保存的更改？"
          description="离开后克隆信息会丢失。"
          confirmLabel="放弃并离开"
          confirmDisabled={duplicate.isPending}
          onConfirm={async () => blocker.proceed()}
        />
      </DialogShell>
    </Dialog>
  );
}
