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
  type AgentPatch,
  type AgentSummary,
  agentDuplicateInputSchema,
  agentInputSchema,
  BUILTIN_TOOLS,
  knowledgeMcpEntry,
  type PermissionId,
  type Server,
} from '@agentport/shared';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
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
  IdCard,
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
  type RefObject,
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
import { Page, PageHeader, PageNote, PageToolbar } from '../components/page.js';
import { RequiredMark } from '../components/required-mark.js';
import { SearchInput } from '../components/search-input.js';
import { ErrorState, InlineEmpty, LoadingState } from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { Button, buttonVariants } from '../components/ui/button.js';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
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
  FieldContent,
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
import { can, hasAnyGrant } from '../lib/access.js';
import type { AgentFiles, AgentVersionSummary } from '../lib/api.js';
import { ApiError, api } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { useFormBlocker } from '../lib/form.js';
import { formatDateTime } from '../lib/format.js';
import {
  agentDetailQuery,
  meQuery,
  toolsQuery,
  useAgentAccess,
  useAgentDetail,
  useAgentFiles,
  useAgentMembers,
  useAgentOptions,
  useAgentSummary,
  useAgents,
  useAgentVersion,
  useAgentVersions,
  useCreateAgent,
  useDeleteAgent,
  useDeleteAgentMember,
  useDuplicateAgent,
  useIdentities,
  useKnowledgeBases,
  usePlugins,
  useRollbackAgent,
  useRuntimeEnvironments,
  useServers,
  useSetAgentMember,
  useSkills,
  useTransferAgent,
  useUpdateAgent,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { useDebouncedValue } from '../lib/use-debounced-value.js';
import { useZodForm } from '../lib/use-zod-form.js';
import { MemoryPanel, OutputStylesPanel, RulesPanel } from './memory-panel.js';

/**
 * 模型名由部署的网关决定，不是平台常量：直连 Anthropic 时是 claude-*，
 * 用自建网关时是网关 /v1/models 里的 id。这里给的是当前部署的默认值，
 * 创建后仍可手改，所以不要把它当成白名单。
 */
const models = ['group/flash', 'auto/deepseek-v4.1-flash', 'workbuddy/kimi-k3-2'];

const roleOptions = AGENT_ROLES.map((role) => ({ value: role, label: role }));

const badgeTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});

/** 工牌只展示真实的创建时间；缺失或无法解析时明确写「未记录」。 */
function badgeCreatedAt(value: string | undefined): { label: string; iso: string | null } {
  if (!value) return { label: '未记录', iso: null };
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? { label: '未记录', iso: null }
    : { label: badgeTimeFormatter.format(date), iso: value };
}

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
  permissionMode: 'default',
  uiFormat: 'markdown',
  maxTurns: 20,
  maxBudgetUsd: 2,
  timeoutMs: 600_000,
  enabled: true,
  runtimeEnvironmentId: null,
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
    runtimeEnvironmentId: agent.runtimeEnvironmentId,
    // 显式保留 undefined 键：RHF 的 defaultValues 必须覆盖每个受控字段，
    // 否则 reset 后 useController 写回的 undefined 会让表单再次判定为 dirty。
    effort: agent.effort,
  };
}

const positiveIntMessage = '必须大于 0，请调整后再保存';
const invalidNumberMessage = '请填写有效内容';

/** 原生文件工具：父按平台路径范围使用，子仅能访问自身记忆目录；两者都可显式关闭。 */
const FILE_TOOLS = ['Read', 'Write', 'Edit'] as const;

function isFileTool(tool: string): tool is (typeof FILE_TOOLS)[number] {
  return FILE_TOOLS.includes(tool as (typeof FILE_TOOLS)[number]);
}

/** 每行一个工具名；空白行忽略，中间空白行不会把未完成的草稿规范化掉。 */
function toolLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * 表单里保留原始文本：工具列表在输入过程中可能还不合法，
 * 但 RHF 必须能存住这份中间草稿，提交时才解析成 AgentInput。
 */
type AgentDraft = Omit<AgentInput, 'allowedTools'> & {
  allowedTools: string;
};

function draftFromInput(input: AgentInput): AgentDraft {
  return {
    ...input,
    allowedTools: input.allowedTools.join('\n'),
  };
}

function inputFromDraft(draft: AgentDraft): AgentInput {
  return {
    ...draft,
    allowedTools: toolLines(draft.allowedTools),
  };
}

const agentFormSchema = agentInputSchema
  .omit({ allowedTools: true })
  .extend({
    name: z.string().min(1, '不能为空，请填写后再保存').max(128, '最多 128 个字符，请精简后再保存'),
    description: z.string().max(300, '最多 300 个字符，请精简后再保存').default(''),
    allowedTools: z.string().default(''),
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
  });

const agentCreateFormSchema = agentFormSchema.safeExtend({
  name: z
    .string()
    .trim()
    .min(1, '不能为空，请填写后再保存')
    .max(128, '最多 128 个字符，请精简后再保存'),
  slug: z
    .string()
    .trim()
    .pipe(z.union([z.literal(''), agentInputSchema.shape.slug])),
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
  const me = useQuery(meQuery);
  const canCreate = can(me.data, 'agents.create');
  const canUse = can(me.data, 'agents.use');
  const canDeleteAny = can(me.data, 'agents.delete');
  const currentBusinessId = me.data?.authenticated ? me.data.user.businessId : '';
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ from: '/_shell/agents/' });
  const query = search.q ?? '';
  const sort = search.sort ?? 'newest';
  // 默认只发现已启用的专家；「全部」需要显式写进 URL，不另造页面状态。
  const status = search.status ?? 'enabled';
  const role = search.role ?? '';
  const [creating, setCreating] = useState(false);
  const [createRole, setCreateRole] = useState<AgentInput['role'] | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [pendingImport, setPendingImport] = useState<File | null>(null);
  const [badgeId, setBadgeId] = useState<string | null>(null);
  const badgeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const editorTriggerRef = useRef<HTMLButtonElement | null>(null);
  const remove = useDeleteAgent();
  const runtimeEnvironments = useRuntimeEnvironments();
  const hasRoleData = (agents.data ?? []).some((agent) => agent.role !== undefined);

  const importFile = async (file: File, runtimeEnvironmentId?: string): Promise<void> => {
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
        : await api.importAgent(file, undefined, runtimeEnvironmentId);
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
    const hasRoleData = (agents.data ?? []).some((agent) => agent.role !== undefined);
    return (agents.data ?? [])
      .filter(
        (agent) =>
          (status === 'all' || agent.enabled === (status === 'enabled')) &&
          (!hasRoleData || !role || (agent.role?.trim() || '通用助手') === role) &&
          [agent.name, agent.slug, agent.description, agent.role?.trim() || '通用助手']
            .join(' ')
            .toLowerCase()
            .includes(needle),
      )
      .sort((a, b) =>
        sort === 'name'
          ? a.name.localeCompare(b.name, 'zh-CN')
          : Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? ''),
      );
  }, [agents.data, query, sort, status, role]);

  const openAgent = (id: string): void => {
    void navigate({ to: '/agents/$agentId', params: { agentId: id } });
  };

  // 工牌从当前列表缓存派生，切换专家后不会停留在旧资料上。
  const badgeAgent = badgeId
    ? ((agents.data ?? []).find((agent) => agent.id === badgeId) ?? null)
    : null;

  return (
    <Page>
      <PageHeader
        title="找专家"
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
                if (!file) return;
                // agent.md 沿用原语义直接导入；ZIP 先确认环境映射，取消不执行。
                if (file.name.toLowerCase().endsWith('.md')) void importFile(file);
                else setPendingImport(file);
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
              className={canCreate ? undefined : 'hidden'}
            >
              <Upload data-icon="inline-start" /> {importing ? '导入中…' : '导入'}
            </Button>
            <Button
              ref={createButtonRef}
              disabled={importing}
              className={canCreate ? undefined : 'hidden'}
              onClick={(event) => {
                editorTriggerRef.current = event.currentTarget;
                setCreateRole(role || '通用助手');
                setCreating(true);
              }}
            >
              <Plus data-icon="inline-start" /> 新建专家
            </Button>
          </>
        }
      />
      <PageToolbar>
        <SearchInput
          label="搜索专家"
          inputId="agents-search"
          placeholder="搜索专家…"
          value={query}
          onChange={(next) =>
            void navigate({
              to: '/agents',
              search: { ...search, q: next || undefined },
              replace: true,
            })
          }
          className="min-w-40 flex-1 sm:w-56 sm:flex-none"
        />
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          <FilterSelect
            value={status}
            onValueChange={(next) => {
              if (next !== 'all' && next !== 'enabled' && next !== 'disabled') return;
              void navigate({
                to: '/agents',
                search: { ...search, status: next === 'enabled' ? undefined : next },
              });
            }}
            options={[
              { value: 'enabled', label: '已启用' },
              { value: 'all', label: '全部' },
              { value: 'disabled', label: '已停用' },
            ]}
            label="按启用状态筛选"
            className="w-32"
          />
          {hasRoleData ? (
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
          ) : null}
          <FilterSelect
            value={sort}
            onValueChange={(next) => {
              if (next !== 'newest' && next !== 'name') return;
              void navigate({
                to: '/agents',
                search: { ...search, sort: next === 'newest' ? undefined : next },
              });
            }}
            options={[
              { value: 'newest', label: '最新创建' },
              { value: 'name', label: '名称排序' },
            ]}
            label="专家排序"
            className="w-32"
          />
        </div>
      </PageToolbar>
      {agents.isPending ? <LoadingState rows={4} layout="cards" /> : null}
      {agents.isError ? (
        <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
      ) : null}
      {agents.data && agents.data.length === 0 ? (
        me.isPending ? (
          <LoadingState rows={4} layout="cards" />
        ) : me.isError ? (
          <ErrorState error={me.error} onRetry={() => void me.refetch()} />
        ) : canCreate ? null : (
          <PageNote
            icon={<Bot />}
            title="暂无可用专家"
            description="当前账户尚未分配可用专家，请联系管理员。"
          />
        )
      ) : null}
      {agents.data && agents.data.length > 0 && filtered.length === 0 ? (
        <PageNote
          title="没有匹配的专家"
          action={
            <div className="flex flex-wrap items-center gap-2">
              {canCreate ? (
                <Button
                  disabled={importing}
                  onClick={(event) => {
                    editorTriggerRef.current = event.currentTarget;
                    setCreateRole(role || '通用助手');
                    setCreating(true);
                  }}
                >
                  新建专家
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void navigate({
                    to: '/agents',
                    // 默认隐式按「已启用」筛选；清除必须显式回到全部，否则只剩停用专家时仍是空列表。
                    search: { ...search, q: undefined, role: undefined, status: 'all' },
                  })
                }
              >
                清除筛选
              </Button>
            </div>
          }
        />
      ) : null}

      {agents.data && (canCreate || filtered.length > 0) ? (
        <ul
          aria-label="专家列表"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
        >
          {canCreate ? (
            <>
              <li className="min-w-0">
                <button
                  type="button"
                  aria-label="新建专家"
                  disabled={importing}
                  onClick={(event) => {
                    editorTriggerRef.current = event.currentTarget as HTMLButtonElement;
                    setCreateRole('通用助手');
                    setCreating(true);
                  }}
                  className="agent-create-fan h-52 w-full disabled:pointer-events-none disabled:opacity-60"
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
              <li className="min-w-0">
                <Card className="h-52">
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
                        setCreateRole('数字分身');
                        setCreating(true);
                      }}
                    >
                      <Plus data-icon="inline-start" /> 创建数字分身
                    </Button>
                  </CardContent>
                </Card>
              </li>
            </>
          ) : null}
          {filtered.map((agent) => {
            const agentRole = agent.role?.trim() || '通用助手';
            const canDelete =
              canDeleteAny &&
              (agent.ownerBusinessId === currentBusinessId || can(me.data, 'agents.transfer'));
            return (
              <li key={agent.id} className="min-w-0">
                <Card className="h-52">
                  <CardHeader className="grid-cols-[auto_minmax(0,1fr)_auto]!">
                    <AgentAvatar agent={agent} className="row-span-2 self-center" />
                    <CardTitle className="col-start-2 row-start-1 min-w-0">
                      <h2 className="min-w-0">
                        <Link
                          to="/agents/$agentId"
                          params={{ agentId: agent.id }}
                          title={agent.name}
                          disabled={importing}
                          className="block min-w-0 truncate rounded-item text-base font-medium text-fg transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {agent.name}
                        </Link>
                      </h2>
                    </CardTitle>
                    <CardAction className="col-start-3 row-span-1 row-start-1 flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`查看 ${agent.name} 工牌`}
                        title="数字员工工牌"
                        onClick={(event) => {
                          badgeTriggerRef.current = event.currentTarget;
                          setBadgeId(agent.id);
                        }}
                      >
                        <IdCard />
                      </Button>
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
                            <DropdownMenuItem
                              disabled={importing}
                              onClick={() => openAgent(agent.id)}
                            >
                              配置
                            </DropdownMenuItem>
                            {canDelete ? (
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => setDeleting(agent)}
                              >
                                删除
                              </DropdownMenuItem>
                            ) : null}
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </CardAction>
                    <div className="col-start-2 row-start-2 min-w-0">
                      <StatusBadge className="max-w-full min-w-0">
                        <span className="block truncate" title={agentRole}>
                          {agentRole}
                        </span>
                      </StatusBadge>
                    </div>
                    <div className="col-span-2 col-start-2 row-start-3 flex min-w-0 flex-col gap-2">
                      {agent.description.trim() ? (
                        <CardDescription className="line-clamp-2 break-words">
                          {agent.description}
                        </CardDescription>
                      ) : null}
                      <div className="flex flex-wrap items-center gap-2">
                        {agent.enabled && canUse ? (
                          <Link
                            to="/chat"
                            search={{ agent: agent.id }}
                            disabled={importing}
                            aria-label={`与 ${agent.name} 开始对话`}
                            className={buttonVariants()}
                          >
                            开始对话
                          </Link>
                        ) : (
                          <>
                            <Button
                              variant="outline"
                              disabled
                              aria-label={`与 ${agent.name} 开始对话`}
                              aria-describedby={
                                agent.enabled ? `agent-use-denied-${agent.id}` : undefined
                              }
                              title={
                                agent.enabled
                                  ? '当前账户没有使用该专家的权限'
                                  : '专家已停用，启用后才能开始对话'
                              }
                            >
                              开始对话
                            </Button>
                            {!agent.enabled ? <StatusBadge>已停用</StatusBadge> : null}
                            {agent.enabled && !canUse ? (
                              <p
                                id={`agent-use-denied-${agent.id}`}
                                className="basis-full text-xs text-muted-foreground"
                              >
                                当前账户没有使用该专家的权限，无法开始对话。
                              </p>
                            ) : null}
                          </>
                        )}
                      </div>
                    </div>
                  </CardHeader>
                </Card>
              </li>
            );
          })}
        </ul>
      ) : null}

      <Dialog
        open={badgeAgent !== null}
        onOpenChange={(open) => {
          if (!open) setBadgeId(null);
        }}
      >
        <DialogShell
          title={badgeAgent ? `${badgeAgent.name} 的工牌` : '数字员工工牌'}
          finalFocus={() =>
            badgeTriggerRef.current?.isConnected
              ? badgeTriggerRef.current
              : document.getElementById('agents-search')
          }
        >
          {badgeAgent ? <AgentEmployeeBadge agent={badgeAgent} /> : null}
        </DialogShell>
      </Dialog>

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
          initialRole={createRole ?? '通用助手'}
          finalFocus={() =>
            editorTriggerRef.current?.isConnected
              ? editorTriggerRef.current
              : createButtonRef.current
          }
          onClose={() => {
            setCreating(false);
            setCreateRole(null);
          }}
          onCreated={(agent) => {
            setCreating(false);
            openAgent(agent.id);
          }}
        />
      ) : null}

      {pendingImport ? (
        <ImportAgentDialog
          file={pendingImport}
          environments={runtimeEnvironments.data ?? []}
          environmentsError={runtimeEnvironments.isError}
          finalFocus={() =>
            editorTriggerRef.current?.isConnected
              ? editorTriggerRef.current
              : createButtonRef.current
          }
          onClose={() => setPendingImport(null)}
          onImport={(runtimeEnvironmentId) => {
            const file = pendingImport;
            setPendingImport(null);
            void importFile(file, runtimeEnvironmentId);
          }}
        />
      ) : null}
    </Page>
  );
}

function ImportAgentDialog({
  file,
  environments,
  environmentsError,
  finalFocus,
  onClose,
  onImport,
}: {
  file: File;
  environments: Array<{ id: string; name: string }>;
  environmentsError: boolean;
  finalFocus: () => HTMLElement | null;
  onClose: () => void;
  onImport: (runtimeEnvironmentId: string | undefined) => void;
}) {
  const [environmentId, setEnvironmentId] = useState('match');
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogShell
        title="导入专家包"
        description={file.name}
        finalFocus={finalFocus}
        className="max-w-md sm:max-w-md"
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="agent-import-environment">目标运行环境</FieldLabel>
            <Select
              value={environmentId}
              items={[
                { value: 'match', label: '按包中名称匹配' },
                ...environments.map((environment) => ({
                  value: environment.id,
                  label: environment.name,
                })),
              ]}
              onValueChange={(next) => {
                if (next !== null) setEnvironmentId(next);
              }}
            >
              <SelectTrigger id="agent-import-environment" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="match">按包中名称匹配</SelectItem>
                  {environments.map((environment) => (
                    <SelectItem key={environment.id} value={environment.id}>
                      {environment.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {environmentsError ? (
              <FieldError>运行环境列表没有加载出来，只能按包中名称匹配。</FieldError>
            ) : null}
          </Field>
        </FieldGroup>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            onClick={() => onImport(environmentId === 'match' ? undefined : environmentId)}
          >
            导入
          </Button>
        </div>
      </DialogShell>
    </Dialog>
  );
}

/** 工牌只读取列表摘要里已授权的字段，不拉详情、提示词或成员资料。 */
function AgentEmployeeBadge({ agent }: { agent: AgentSummary }) {
  const role = agent.role?.trim() || '通用助手';
  const createdAt = badgeCreatedAt(agent.createdAt);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <AgentAvatar
          agent={{
            name: agent.name,
            description: agent.description,
            role: agent.role ?? null,
            slug: agent.slug ?? null,
          }}
        />
        <div className="min-w-0">
          <div className="text-base font-medium break-words [overflow-wrap:anywhere]">
            {agent.name}
          </div>
          <div className="text-sm text-muted-foreground">数字员工</div>
        </div>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
        <dt className="text-muted-foreground">角色</dt>
        <dd className="break-words [overflow-wrap:anywhere]">{role}</dd>
        <dt className="text-muted-foreground">状态</dt>
        <dd>{agent.enabled ? '已启用' : '已停用'}</dd>
        <dt className="text-muted-foreground">介绍</dt>
        <dd className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {agent.description.trim() ? agent.description : '未填写介绍'}
        </dd>
        <dt className="text-muted-foreground">员工编号</dt>
        <dd className="font-mono text-xs break-all">{agent.id}</dd>
        <dt className="text-muted-foreground">上岗时间（创建时间）</dt>
        <dd>
          {createdAt.iso ? (
            <time dateTime={createdAt.iso} title={createdAt.iso}>
              {createdAt.label}
            </time>
          ) : (
            createdAt.label
          )}
        </dd>
      </dl>
    </div>
  );
}

/** 专家页只认 /access 的已求值权限；摘要与配置分别取，普通使用者不拉配置正文。 */
export function AgentDetailPage() {
  const params = useParams({ from: '/_shell/agents/$agentId' });
  const navigate = useNavigate();
  const me = useQuery(meQuery);
  const summary = useAgentSummary(params.agentId);
  const access = useAgentAccess(params.agentId);
  const permissions = access.data?.permissionIds ?? [];
  const canReadConfig = hasAnyGrant(permissions, 'agents.config.read');
  const detail = useAgentDetail(params.agentId, canReadConfig);
  const remove = useDeleteAgent();
  const toggleEnable = useUpdateAgent();
  const location = useLocation();
  const [editorPending, setEditorPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // 删除成功会卸载受限页签；父层保存子层最新 blocker reset，先结算被拦下的离开再返回列表。
  const settleBlockedNavigation = useRef<(() => void) | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  // 删除请求在途时编辑、离开与刷新都要先等它结束；失败则保留草稿供重试。
  const pending = editorPending || remove.isPending || toggleEnable.isPending;
  // 导入后随导航状态带过来的一次性提示；展示关闭后从本地状态清空。
  const [warnings, setWarnings] = useState<string[]>(() => {
    const state = location.state as { importWarnings?: string[] } | undefined;
    return state?.importWarnings ?? [];
  });

  const backToList = (): void => {
    void navigate({ to: '/agents' });
  };

  // 列表只给摘要；配置正文只能来自单独的详情请求，不能把摘要当完整 Agent 用。
  const full = canReadConfig ? (detail.data ?? null) : null;
  const current = full ?? summary.data;
  const loading = summary.isPending || access.isPending || (canReadConfig && detail.isPending);
  const failed = summary.isError || access.isError || (canReadConfig && detail.isError);

  // 删除成功后先结算删除期间被拦下的离开，再卸载编辑器与确认框并返回列表；
  // 否则子层卸载后旧 blocker 的导航 Promise 永久挂起。
  useEffect(() => {
    if (!remove.isSuccess) return;
    settleBlockedNavigation.current?.();
    void navigate({ to: '/agents' });
  }, [remove.isSuccess, navigate]);

  if (remove.isSuccess) {
    return (
      <Page>
        <PageHeader title="专家" />
        <LoadingState rows={6} />
      </Page>
    );
  }

  // access 未返回前先保持加载态，避免把管理员短暂当成只能使用的普通用户。
  if (!current || access.isPending) {
    if (loading) {
      return (
        <Page>
          <PageHeader title="专家" />
          <LoadingState rows={6} />
        </Page>
      );
    }
    if (failed) {
      return (
        <Page>
          <PageHeader title="专家" />
          <ErrorState
            error={summary.error ?? access.error ?? detail.error}
            onRetry={() => {
              void summary.refetch();
              void access.refetch();
              if (canReadConfig) void detail.refetch();
            }}
          />
        </Page>
      );
    }
    return (
      <Page>
        <PageHeader title="专家" />
        <PageNote
          icon={<Bot />}
          title="专家不存在"
          description="它可能已被删除，或当前账户没有访问权限。返回列表重新选择。"
          action={
            <Button variant="outline" onClick={backToList}>
              <ArrowLeft data-icon="inline-start" /> 返回列表
            </Button>
          }
        />
      </Page>
    );
  }

  const agentId = params.agentId;
  const canUse = hasAnyGrant(permissions, 'agents.use');
  const canEnable = hasAnyGrant(permissions, 'agents.enable');
  const canManageMembers = hasAnyGrant(permissions, 'agents.members.manage');
  const canTransfer = hasAnyGrant(permissions, 'agents.transfer');
  const canDelete = hasAnyGrant(permissions, 'agents.delete');
  const canViewRuns = can(me.data, 'runs.read');
  const roleLabel = current.role?.trim() || '通用助手';
  const readableTabs = new Set(
    tabItems.map((item) => item.id).filter((id) => hasAnyGrant(permissions, TAB_PERMISSIONS[id])),
  );
  const hasReadableTab = readableTabs.size > 0;

  return (
    <Page>
      <div className="flex min-w-0 flex-col gap-2">
        <PageHeader
          leading={<AgentAvatar agent={current} className="size-11" />}
          title={current.name}
          eyebrow={
            roleLabel ? (
              <StatusBadge className="max-w-full whitespace-normal break-words">
                {roleLabel}
              </StatusBadge>
            ) : undefined
          }
          actions={
            <>
              <Button variant="outline" onClick={backToList} disabled={pending}>
                <ArrowLeft data-icon="inline-start" /> 返回列表
              </Button>
              {canViewRuns ? (
                <Link
                  to="/runs"
                  search={{ agent: agentId }}
                  className={buttonVariants({ variant: 'outline' })}
                >
                  查看运行
                </Link>
              ) : null}
              {canManageMembers || canTransfer || canDelete ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="专家管理操作"
                        disabled={pending}
                      >
                        <Ellipsis />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end">
                    <DropdownMenuGroup>
                      {canManageMembers ? (
                        <DropdownMenuItem onClick={() => setMembersOpen(true)}>
                          管理成员
                        </DropdownMenuItem>
                      ) : null}
                      {canTransfer ? (
                        <DropdownMenuItem onClick={() => setTransferOpen(true)}>
                          转交负责人
                        </DropdownMenuItem>
                      ) : null}
                      {canDelete ? (
                        <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
                          <Trash2 className="size-4" /> 删除专家
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              {/* 没有配置读取权时也要能独立启停：不渲染配置表单，只发 enabled 字段。 */}
              {canEnable && !canReadConfig ? (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    toggleEnable.mutate(
                      { id: agentId, input: { enabled: !current.enabled } },
                      {
                        onSuccess: () => {
                          toastSuccess(current.enabled ? '专家已停用' : '专家已启用');
                          void summary.refetch();
                          void access.refetch();
                        },
                        onError: toastError,
                      },
                    )
                  }
                >
                  {current.enabled ? '停用专家' : '启用专家'}
                </Button>
              ) : null}
              {canUse && current.enabled ? (
                <Link
                  to="/chat"
                  search={{ agent: agentId }}
                  className={buttonVariants()}
                  disabled={pending}
                >
                  开始对话
                </Link>
              ) : (
                <Button
                  variant="outline"
                  disabled
                  aria-describedby={current.enabled ? 'agent-use-denied' : undefined}
                  title={
                    current.enabled
                      ? '当前账户没有使用该专家的权限'
                      : '专家已停用，启用后才能开始对话'
                  }
                >
                  开始对话
                </Button>
              )}
            </>
          }
        />
        {current.enabled && !canUse ? (
          <p id="agent-use-denied" className="text-xs text-muted-foreground">
            当前账户没有使用该专家的权限，无法开始对话。
          </p>
        ) : null}
        {current.description ? (
          <p className="max-w-[70ch] break-words text-sm text-muted-foreground">
            {current.description}
          </p>
        ) : null}
      </div>
      {!hasReadableTab ? (
        <PageNote
          title="当前账户只能使用这个专家。"
          description="查看或修改配置需要对应的维护权限。"
        />
      ) : full ? (
        <AgentEditor
          key={agentId}
          agent={full}
          permissions={permissions}
          deletePending={remove.isPending}
          onDirtyChange={() => {}}
          onPendingChange={setEditorPending}
          onDeleteRequest={() => setDeleting(true)}
        />
      ) : (
        <RestrictedAgentTabs
          key={agentId}
          agentId={agentId}
          permissions={permissions}
          onPendingChange={setEditorPending}
          externalPending={remove.isPending || toggleEnable.isPending}
          settleNavigationRef={settleBlockedNavigation}
        />
      )}
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`删除专家「${current.name}」`}
        description="它的会话、消息与绑定关系会一并删除，正在运行的任务不会被自动停止。此操作不可撤销。"
        confirmDisabled={pending}
        onConfirm={async () => {
          if (pending) return;
          await remove.mutateAsync(agentId);
        }}
      />
      {membersOpen ? (
        <AgentMembersDialog
          agentId={agentId}
          agentName={current.name}
          onClose={() => setMembersOpen(false)}
        />
      ) : null}
      {transferOpen ? (
        <TransferAgentDialog
          agentId={agentId}
          agentName={current.name}
          currentOwner={summary.data?.ownerBusinessId ?? ''}
          onClose={() => setTransferOpen(false)}
        />
      ) : null}
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
type TabId = 'config' | 'memory' | 'rules' | 'styles' | 'files';

function RestrictedAgentTabs({
  agentId,
  permissions,
  onPendingChange,
  externalPending = false,
  settleNavigationRef,
}: {
  agentId: string;
  permissions: readonly PermissionId[];
  onPendingChange: (pending: boolean) => void;
  externalPending?: boolean;
  settleNavigationRef: RefObject<(() => void) | null>;
}) {
  const available = tabItems.filter(
    (item) => item.id !== 'config' && hasAnyGrant(permissions, TAB_PERMISSIONS[item.id]),
  );
  const navigate = useNavigate({ from: '/agents/$agentId' });
  const search = useSearch({ from: '/_shell/agents/$agentId' });
  const [childDirty, setChildDirty] = useState(false);
  const [childPending, setChildPending] = useState(false);
  const pending = childPending || externalPending;
  // 只把子面板的真实在途状态回报给页头；父级操作锁不会回传，避免自锁。
  useEffect(() => {
    onPendingChange(childPending);
    return () => onPendingChange(false);
  }, [childPending, onPendingChange]);

  const permittedTab = (value: unknown): TabId =>
    available.some((item) => item.id === value) ? (value as TabId) : (available[0]?.id ?? 'memory');
  const tab = permittedTab(search.tab);

  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => {
      if (current.pathname === next.pathname) {
        const currentTab = permittedTab('tab' in current.search ? current.search.tab : undefined);
        const nextTab = permittedTab('tab' in next.search ? next.search.tab : undefined);
        // 文件选择不卸载子面板；任务切换与跨页才可能丢草稿或打断请求。
        if (currentTab === nextTab) return false;
        return childDirty || pending;
      }
      return childDirty || pending;
    },
    withResolver: true,
    enableBeforeUnload: childDirty || pending,
  });
  // 父层拥有卸载权：登记最新 reset，卸载后仍能结算被拦下的导航，不依赖卸载清理。
  useEffect(() => {
    settleNavigationRef.current = () => blocker.reset?.();
  }, [blocker, settleNavigationRef]);

  if (available.length === 0) return null;

  const navigateSearch = (next: { tab?: TabId; file?: string }): void => {
    void navigate({
      to: '/agents/$agentId',
      params: { agentId },
      search: (current) => ({ ...current, ...next }),
      replace: true,
    });
  };
  const changeTab = (next: TabId): void => {
    if (next === tab || pending) return;
    navigateSearch({ tab: next });
  };
  const proceedLeave = (): void => {
    if (!pending) blocker.proceed?.();
  };
  const blockedTabSwitch =
    blocker.status === 'blocked' && blocker.current?.pathname === blocker.next?.pathname;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Tabs value={tab} onValueChange={(next) => changeTab(next as TabId)}>
        <TabsList variant="line" aria-label="专家任务">
          {available.map((item) => (
            <TabsTrigger key={item.id} value={item.id}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {tab === 'memory' ? (
        <div className="min-w-0 rounded-card bg-surface px-6 py-5 ring-1 ring-line">
          <MemoryPanel
            agentId={agentId}
            canWrite={hasAnyGrant(permissions, 'agents.memory.write')}
            onDirtyChange={setChildDirty}
            onPendingChange={setChildPending}
          />
        </div>
      ) : null}
      {tab === 'rules' ? (
        <div className="min-w-0 rounded-card bg-surface px-6 py-5 ring-1 ring-line">
          <RulesPanel
            agentId={agentId}
            canWrite={hasAnyGrant(permissions, 'agents.rules.write')}
            onDirtyChange={setChildDirty}
            onPendingChange={setChildPending}
          />
        </div>
      ) : null}
      {tab === 'styles' ? (
        <div className="min-w-0 rounded-card bg-surface px-6 py-5 ring-1 ring-line">
          <OutputStylesPanel
            agentId={agentId}
            canWrite={hasAnyGrant(permissions, 'agents.styles.write')}
            onDirtyChange={setChildDirty}
            onPendingChange={setChildPending}
          />
        </div>
      ) : null}
      {tab === 'files' ? (
        <ReadonlyAgentFiles
          agentId={agentId}
          file={search.file}
          onFileChange={(file) => navigateSearch({ file })}
        />
      ) : null}
      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onClose={() => blocker.reset?.()}
        title={
          pending
            ? '当前操作尚未完成'
            : blockedTabSwitch
              ? childDirty
                ? '放弃未保存的修改并切换？'
                : '当前操作尚未完成'
              : '放弃未保存的更改？'
        }
        description={
          pending
            ? blockedTabSwitch
              ? '当前请求还在进行，请等待完成后再切换任务。'
              : '当前请求还在进行，请等待完成后再离开。'
            : blockedTabSwitch
              ? '当前记忆、规则或输出风格还有未保存的内容，切换任务后会丢失。'
              : '当前专家的记忆、规则或输出风格还有未保存的修改，离开后会丢失。'
        }
        confirmLabel={blockedTabSwitch && childDirty ? '放弃并切换' : '放弃并离开'}
        confirmDisabled={pending}
        onConfirm={async () => {
          proceedLeave();
        }}
      />
    </div>
  );
}

function ReadonlyAgentFiles({
  agentId,
  file,
  onFileChange,
}: {
  agentId: string;
  file?: string | undefined;
  onFileChange: (file: string) => void;
}) {
  const files = useAgentFiles(agentId, true);
  const entries = files.data ? listWorkspaceFiles(files.data) : baseFileEntries;
  const current = entries.find((entry) => entry.id === file) ?? entries[0];
  if (files.isPending) return <LoadingState rows={4} />;
  if (files.isError) {
    return <ErrorState error={files.error} onRetry={() => void files.refetch()} />;
  }
  return (
    <div className="grid min-w-0 items-start gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
      <nav aria-label="完整文件" className="min-w-0">
        {[...new Set(entries.map((entry) => entry.group))].map((group) => (
          <div key={group} className="mb-3 flex flex-col gap-0.5">
            <div className="px-2 py-1 text-xs text-muted-foreground">{group}</div>
            {entries
              .filter((entry) => entry.group === group)
              .map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  aria-current={entry.id === current?.id ? 'true' : undefined}
                  onClick={() => onFileChange(entry.id)}
                  className={cn(
                    'flex h-8 items-center truncate rounded-item px-2 text-left text-sm transition-colors',
                    entry.id === current?.id
                      ? 'bg-selected font-medium text-selected-foreground'
                      : 'text-fg hover:bg-hover',
                  )}
                >
                  {entry.path}
                </button>
              ))}
          </div>
        ))}
      </nav>
      <div className="min-w-0 rounded-card bg-surface px-6 py-5 ring-1 ring-line">
        {current ? <CodeBlock code={current.content} lineNumbers /> : null}
      </div>
    </div>
  );
}

function AgentMembersDialog({
  agentId,
  agentName,
  onClose,
}: {
  agentId: string;
  agentName: string;
  onClose: () => void;
}) {
  const members = useAgentMembers(agentId);
  const [query, setQuery] = useState('');
  const settled = useDebouncedValue(query.trim(), 300);
  const identities = useIdentities(agentId, { q: settled, limit: 20 });
  const setMember = useSetAgentMember();
  const removeMember = useDeleteAgentMember();
  const existing = new Set((members.data?.members ?? []).map((member) => member.businessId));

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogShell
        title={`管理「${agentName}」的成员`}
        description="成员可使用或维护该专家；范围仍由成员所属角色的授权决定。"
        className="max-w-xl sm:max-w-xl"
      >
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">负责人</span>
            <span className="font-mono text-xs">{members.data?.ownerBusinessId ?? '—'}</span>
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">成员</h3>
            {members.isPending ? <LoadingState rows={2} /> : null}
            {members.isError ? (
              <ErrorState error={members.error} onRetry={() => void members.refetch()} />
            ) : null}
            {members.data && members.data.members.length === 0 ? (
              <p className="text-sm text-muted-foreground">还没有成员。</p>
            ) : null}
            {(members.data?.members ?? []).map((member) => (
              <div
                key={member.businessId}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y py-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate">{member.name || member.businessId}</div>
                  <div className="truncate font-mono text-2xs text-muted-foreground">
                    {member.businessId}
                    {member.accountActive ? '' : ' · 离线'}
                  </div>
                </div>
                <label
                  htmlFor={`agent-member-${member.businessId}-use`}
                  className="flex items-center gap-1.5"
                >
                  <Checkbox
                    id={`agent-member-${member.businessId}-use`}
                    checked={member.canUse}
                    disabled={setMember.isPending}
                    onCheckedChange={(checked) =>
                      setMember.mutate(
                        {
                          agentId,
                          businessId: member.businessId,
                          canUse: Boolean(checked),
                          canMaintain: member.canMaintain,
                        },
                        { onError: toastError },
                      )
                    }
                  />
                  可使用
                </label>
                <label
                  htmlFor={`agent-member-${member.businessId}-maintain`}
                  className="flex items-center gap-1.5"
                >
                  <Checkbox
                    id={`agent-member-${member.businessId}-maintain`}
                    checked={member.canMaintain}
                    disabled={setMember.isPending}
                    onCheckedChange={(checked) =>
                      setMember.mutate(
                        {
                          agentId,
                          businessId: member.businessId,
                          canUse: member.canUse,
                          canMaintain: Boolean(checked),
                        },
                        { onError: toastError },
                      )
                    }
                  />
                  可维护
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger"
                  disabled={removeMember.isPending}
                  aria-label={`移除成员 ${member.name || member.businessId}`}
                  onClick={() =>
                    removeMember.mutate(
                      { agentId, businessId: member.businessId },
                      { onError: toastError },
                    )
                  }
                >
                  移除
                </Button>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2 border-t pt-4">
            <h3 className="text-sm font-medium">添加成员</h3>
            <SearchInput
              label="搜索可添加的人员"
              placeholder="搜索业务 ID 或姓名…"
              value={query}
              onChange={setQuery}
            />
            {identities.isPending && settled.length > 0 ? <LoadingState rows={2} /> : null}
            {identities.isError ? (
              <ErrorState error={identities.error} onRetry={() => void identities.refetch()} />
            ) : null}
            {(identities.data?.items ?? []).map((candidate) => (
              <div
                key={candidate.businessId}
                className="flex flex-wrap items-center gap-2 border-y py-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate">{candidate.name || candidate.businessId}</div>
                  <div className="truncate font-mono text-2xs text-muted-foreground">
                    {candidate.businessId}
                    {candidate.accountActive ? '' : ' · 离线'}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={existing.has(candidate.businessId) || setMember.isPending}
                  onClick={() =>
                    setMember.mutate(
                      {
                        agentId,
                        businessId: candidate.businessId,
                        canUse: true,
                        canMaintain: false,
                      },
                      {
                        onSuccess: () => toastSuccess(`已添加 ${candidate.name}`),
                        onError: toastError,
                      },
                    )
                  }
                >
                  {existing.has(candidate.businessId) ? '已是成员' : '添加'}
                </Button>
              </div>
            ))}
          </div>
        </div>
      </DialogShell>
    </Dialog>
  );
}

function TransferAgentDialog({
  agentId,
  agentName,
  currentOwner,
  onClose,
}: {
  agentId: string;
  agentName: string;
  currentOwner: string;
  onClose: () => void;
}) {
  const transfer = useTransferAgent();
  const [query, setQuery] = useState('');
  const settled = useDebouncedValue(query.trim(), 300);
  const identities = useIdentities(agentId, { q: settled, limit: 20 });
  const [target, setTarget] = useState<string | null>(null);

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogShell
        title={`转交「${agentName}」`}
        description="新负责人必须是活跃账户并具备创建专家的权限；原负责人不会自动保留成员权限。"
        className="max-w-lg sm:max-w-lg"
        closeDisabled={transfer.isPending}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">当前负责人</span>
            <span className="font-mono text-xs">{currentOwner || '—'}</span>
          </div>
          <SearchInput
            label="搜索新负责人"
            placeholder="搜索业务 ID 或姓名…"
            value={query}
            onChange={setQuery}
          />
          {identities.isPending && settled.length > 0 ? <LoadingState rows={2} /> : null}
          {identities.isError ? (
            <ErrorState error={identities.error} onRetry={() => void identities.refetch()} />
          ) : null}
          {(identities.data?.items ?? []).map((candidate) => (
            <label
              key={candidate.businessId}
              htmlFor={`agent-transfer-target-${candidate.businessId}`}
              className="flex items-center gap-2 border-y py-2 text-sm"
            >
              <Checkbox
                id={`agent-transfer-target-${candidate.businessId}`}
                checked={target === candidate.businessId}
                onCheckedChange={() => setTarget(candidate.businessId)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{candidate.name || candidate.businessId}</span>
                <span className="block truncate font-mono text-2xs text-muted-foreground">
                  {candidate.businessId}
                  {candidate.accountActive ? '' : ' · 离线'}
                </span>
              </span>
            </label>
          ))}
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" disabled={transfer.isPending} onClick={onClose}>
              取消
            </Button>
            <Button
              disabled={target === null || target === currentOwner || transfer.isPending}
              aria-busy={transfer.isPending}
              onClick={() => {
                if (!target) return;
                transfer.mutate(
                  { agentId, ownerBusinessId: target },
                  {
                    onSuccess: () => {
                      toastSuccess('负责人已转交');
                      onClose();
                    },
                    onError: toastError,
                  },
                );
              }}
            >
              {transfer.isPending ? '正在转交…' : '转交'}
            </Button>
          </div>
        </div>
      </DialogShell>
    </Dialog>
  );
}

const sectionItems: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: 'identity', label: '身份' },
  { id: 'behavior', label: '行为' },
  { id: 'capability', label: '能力' },
  { id: 'permissions', label: '权限' },
  { id: 'limits', label: '运行限制' },
];

const tabItems: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'config', label: '配置' },
  { id: 'memory', label: '专家记忆' },
  { id: 'rules', label: '项目规则' },
  { id: 'styles', label: '输出风格' },
  { id: 'files', label: '完整文件' },
];

const TAB_PERMISSIONS: Record<TabId, PermissionId> = {
  config: 'agents.config.read',
  memory: 'agents.memory.read',
  rules: 'agents.rules.read',
  styles: 'agents.styles.read',
  files: 'agents.files.read',
};

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
};

export function AgentEditor({
  agent,
  permissions,
  deletePending = false,
  onDirtyChange,
  onPendingChange,
  onDeleteRequest,
}: {
  agent: Agent;
  permissions: readonly PermissionId[];
  deletePending?: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onPendingChange: (pending: boolean) => void;
  onDeleteRequest: () => void;
}) {
  const allow = (id: PermissionId): boolean => hasAnyGrant(permissions, id);
  const canUpdateConfig = allow('agents.config.update');
  const canEnable = allow('agents.enable');
  const canBindings = allow('agents.bindings.manage');
  const canRulesWrite = allow('agents.rules.write');
  const canStylesWrite = allow('agents.styles.write');
  const canMemoryWrite = allow('agents.memory.write');
  const canVersionsRead = allow('agents.versions.read');
  const canVersionsRestore = allow('agents.versions.restore');
  const canClone = allow('agents.clone');
  const canExport = allow('agents.export');
  const canDelete = allow('agents.delete');
  const availableTabs = tabItems.filter((item) => allow(TAB_PERMISSIONS[item.id]));
  const availableTabOptions = availableTabs.map((item) => ({ value: item.id, label: item.label }));
  const update = useUpdateAgent();
  const me = useQuery(meQuery);
  // 资源目录是全局能力：没有对应读取叶的人不发这些请求，改用 /agents/options 摘要。
  const canServers = can(me.data, 'servers.read');
  const canSkills = can(me.data, 'skills.read');
  const canPlugins = can(me.data, 'plugins.read');
  const canKnowledge = can(me.data, 'knowledge.read');
  const canRuntimeEnvironments = can(me.data, 'runtime_environments.read');
  // options 自身要求 bindings.manage；没有该叶时保存也不会提交绑定字段。
  const options = useAgentOptions(canBindings);
  const servers = useServers(canServers);
  const knowledgeBases = useKnowledgeBases(canKnowledge);
  const skills = useSkills(canSkills);
  const plugins = usePlugins(canPlugins);
  const agents = useAgents();
  const runtimeEnvironments = useRuntimeEnvironments(canRuntimeEnvironments);
  const optionServers = options.data?.servers ?? [];
  // 连接器目录只取摘要；完整 Server（含密钥/命令）仍只来自全局 servers 查询。
  const connectorCatalog = useMemo(
    () =>
      canServers
        ? (servers.data ?? []).map((server) => ({
            id: server.id,
            name: server.name,
            kind: server.kind as string,
          }))
        : optionServers.filter((server) => server.kind !== 'knowledge'),
    [canServers, servers.data, optionServers],
  );
  const skillCatalog = useMemo(
    () =>
      canSkills
        ? (skills.data ?? []).map((skill) => ({
            id: skill.id,
            slug: skill.slug,
            name: skill.name,
            description: skill.description,
            body: skill.body,
          }))
        : (options.data?.skills ?? []).map((skill) => ({
            id: skill.id,
            slug: skill.slug,
            name: skill.name,
            description: skill.description,
            body: '',
          })),
    [canSkills, skills.data, options.data],
  );
  const pluginCatalog = useMemo(
    () =>
      canPlugins
        ? (plugins.data ?? []).map((plugin) => ({
            id: plugin.id,
            name: plugin.name,
            hint: plugin.runtimeName,
          }))
        : (options.data?.plugins ?? []).map((plugin) => ({
            id: plugin.id,
            name: plugin.name,
            hint: plugin.slug,
          })),
    [canPlugins, plugins.data, options.data],
  );
  const runtimeCatalog = useMemo(
    () =>
      canRuntimeEnvironments
        ? (runtimeEnvironments.data ?? []).map((environment) => ({
            id: environment.id,
            name: environment.name,
            isDefault: environment.isDefault,
          }))
        : (options.data?.runtimeEnvironments ?? []).map((environment) => ({
            id: environment.id,
            name: environment.name,
            isDefault: false,
          })),
    [canRuntimeEnvironments, runtimeEnvironments.data, options.data],
  );
  // 回退到 options 时，进度与错误也跟 options 走；被禁用的全局查询不应显示加载中。
  const serversState = canServers ? servers : options;
  const skillsState = canSkills ? skills : options;
  const pluginsState = canPlugins ? plugins : options;
  const knowledgeState = canKnowledge ? knowledgeBases : options;
  const runtimeState = canRuntimeEnvironments ? runtimeEnvironments : options;
  // 插件能力（hooks / MCP）只在拿到全局插件目录时可见；摘要目录不猜测能力。
  const pluginCapabilities = new Map(
    (plugins.data ?? []).map((plugin) => [plugin.id, plugin.capabilities]),
  );
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
  const pending = update.isPending || reloading || rollingBack || deletePending;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const duplicateTriggerRef = useRef<HTMLButtonElement>(null);
  const sectionFromUrl = search.section ?? 'identity';
  // 任务只认 URL：确认放行后才换 URL，子面板才会卸载，草稿不会提前丢。
  const requestedTab: TabId = search.tab ?? availableTabs[0]?.id ?? 'config';
  const tab: TabId = availableTabs.some((item) => item.id === requestedTab)
    ? requestedTab
    : (availableTabs[0]?.id ?? 'config');
  const [activeSection, setActiveSectionState] = useState<SectionId>(sectionFromUrl);
  const activeFile = search.file ?? '.mcp.json';
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
  const setTab = (next: TabId): void => navigateSearch({ tab: next });
  const setActiveSection = (next: SectionId): void => {
    setActiveSectionState(next);
    navigateSearch({ section: next });
  };
  const setActiveFile = (next: string): void => navigateSearch({ file: next });
  const files = useAgentFiles(agent.id, tab === 'files');
  const fileEntries = files.data ? listWorkspaceFiles(files.data) : baseFileEntries;
  const resolvedEntry = fileEntries.find((entry) => entry.id === activeFile) ?? fileEntries[0];
  const resolvedId = resolvedEntry?.id;
  const fileGroups = [...new Set(fileEntries.map((entry) => entry.group))];
  const [exporting, setExporting] = useState(false);
  // RHF 是唯一数据源：多行工具保留原始文本，提交时才解析。
  const rhf = useZodForm(agentFormSchema, { defaultValues: draftFromInput(toInput(agent)) });
  // defaultValues 覆盖全部字段；把 schema 输入的可选类型收敛回完整草稿。
  const control = rhf.control as unknown as Control<AgentDraft, unknown, AgentDraft>;
  const errors = rhf.formState.errors;
  const allowedInvalid = Boolean(errors.allowedTools);
  const roleField = useController({ control, name: 'role' }).field;
  const effortField = useController({ control, name: 'effort' }).field;
  const serverIdsField = useController({ control, name: 'serverIds' }).field;
  const skillIdsField = useController({ control, name: 'skillIds' }).field;
  const subAgentIdsField = useController({ control, name: 'subAgentIds' }).field;
  const pluginBindingsField = useController({ control, name: 'pluginBindings' }).field;
  const permissionModeField = useController({ control, name: 'permissionMode' }).field;
  const uiFormatField = useController({ control, name: 'uiFormat' }).field;
  const enabledField = useController({ control, name: 'enabled' }).field;
  const runtimeEnvironmentField = useController({ control, name: 'runtimeEnvironmentId' }).field;
  const defaultEnvironment = runtimeCatalog.find((environment) => environment.isDefault);
  // null 与真实默认环境的 ID 都显示为同一项；保存时保留原始绑定，不把显式 ID 静默改成 null。
  const runtimeEnvironmentValue =
    runtimeEnvironmentField.value === null ||
    runtimeEnvironmentField.value === defaultEnvironment?.id
      ? 'default'
      : runtimeEnvironmentField.value;
  const runtimeEnvironmentOptions = [
    { value: 'default', label: defaultEnvironment?.name ?? '平台默认环境' },
    ...runtimeCatalog
      .filter((environment) => !environment.isDefault)
      .map((environment) => ({ value: environment.id, label: environment.name })),
  ];
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
      const latest = await api.agent(baseline.id);
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
  const guarded = dirty || childDirty;
  const locked = pending || childPending;
  // 配置字段按 config.update 锁定；绑定与启停各自按叶锁定，互不连坐。
  const configDisabled = pending || !canUpdateConfig;
  const bindingsDisabled = pending || !canBindings;

  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => {
      if (current.pathname === next.pathname) {
        const currentTab = 'tab' in current.search ? (current.search.tab ?? 'config') : 'config';
        const nextTab = 'tab' in next.search ? (next.search.tab ?? 'config') : 'config';
        // 分区与文件变化不卸载任务，直接放行。
        if (currentTab === nextTab) return false;
        // 主配置草稿随编辑器常驻；只有子面板草稿或在途请求会因切任务丢失。
        return childDirty || locked;
      }
      return guarded || locked;
    },
    withResolver: true,
    enableBeforeUnload: guarded || locked,
  });
  // 保存、删除或子面板请求在途时，已打开的离开确认也不能继续。
  const proceedLeave = (): void => {
    if (!locked) blocker.proceed?.();
  };
  const blockedTabSwitch =
    blocker.status === 'blocked' && blocker.current?.pathname === blocker.next?.pathname;

  useEffect(() => {
    onDirtyChange(guarded || locked);
  }, [guarded, locked, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  useEffect(() => {
    onPendingChange(locked);
    return () => onPendingChange(false);
  }, [locked, onPendingChange]);

  /**
   * 主配置随 AgentEditor 常驻，切任务不丢草稿；子面板卸载会丢，有草稿时统一交给
   * 路由 blocker 确认（含浏览器前进后退），确认前不换 URL，面板不会提前卸载。
   */
  const changeTab = (next: TabId): void => {
    if (next === tab || locked) return;
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
  const knowledgeOptions = useMemo(() => {
    if (canKnowledge) {
      return (knowledgeBases.data ?? []).map((base) => ({
        id: base.serverId,
        baseId: base.id,
        label: base.name,
        slug: base.slug,
        disabled: base.status !== 'active',
        updatedAt: base.updatedAt,
      }));
    }
    // 没有 knowledge.read 时只用 /agents/options 里的知识 server 摘要；
    // 拿不到停用状态，已有绑定仍按原值显示并原样提交。
    return optionServers
      .filter((server) => server.kind === 'knowledge')
      .map((server) => ({
        id: server.id,
        baseId: '',
        label: server.name,
        slug: server.name,
        disabled: false,
        updatedAt: '',
      }));
  }, [canKnowledge, knowledgeBases.data, optionServers]);

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
      [...(canServers ? (servers.data ?? []) : []), ...knowledgeServers].filter((server) =>
        serverIdsField.value.includes(server.id),
      ),
    [canServers, servers.data, knowledgeServers, serverIdsField.value],
  );
  const boundSkills = useMemo(
    () => skillCatalog.filter((skill) => skillIdsField.value.includes(skill.id)),
    [skillCatalog, skillIdsField.value],
  );
  const subAgentDetails = useQueries({
    queries: subAgentIdsField.value.map((id) => agentDetailQuery(id, true)),
  });
  const subAgentById = new Map(
    subAgentDetails.flatMap((query) => (query.data ? [[query.data.id, query.data] as const] : [])),
  );
  const boundSubAgents = useMemo(
    () =>
      (agents.data ?? [])
        .filter((item) => item.enabled && subAgentIdsField.value.includes(item.id))
        .map((item) => {
          const detail = subAgentById.get(item.id);
          return {
            slug: detail?.slug ?? item.slug ?? item.id,
            name: detail?.name ?? item.name,
            description: detail?.description ?? item.description,
            model: detail?.model ?? 'claude-sonnet-5-5',
            systemPrompt: detail?.systemPrompt ?? '',
            maxTurns: detail?.maxTurns ?? 20,
            timeoutMs: detail?.timeoutMs ?? 600_000,
            permissionMode: detail?.permissionMode ?? 'default',
            effort: detail?.effort ?? null,
            allowedTools: detail?.allowedTools ?? [],
            disallowedTools: detail?.disallowedTools ?? [],
            skills: skillCatalog.filter((skill) =>
              (detail?.skillIds ?? item.skillIds ?? []).includes(skill.id),
            ),
          };
        }),
    [agents.data, subAgentIdsField.value, skillCatalog, subAgentById],
  );
  // 下载入口只能指向已落盘的配置，不能跟着未保存的草稿走。
  const savedSubAgents = useMemo(
    () => (agents.data ?? []).filter((item) => item.enabled && agent.subAgentIds.includes(item.id)),
    [agents.data, agent.subAgentIds],
  );

  const serverOptions = connectorCatalog.map((server) => ({
    id: server.id,
    label: server.name,
    hint: server.kind,
    tag: server.kind,
  }));

  const skillOptions = skillCatalog.map((skill) => ({
    id: skill.id,
    label: skill.name,
    hint: skill.description,
  }));

  const pluginOptions = pluginCatalog.map((plugin) => ({
    id: plugin.id,
    label: plugin.name,
    hint: plugin.hint,
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
  const toolCountPending = serversState.isPending || toolQueries.some((query) => query.isPending);
  const toolCountUnknown = serversState.isError || toolQueries.some((query) => query.isError);
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

  // 只订阅参与工具状态推导的字段，供渲染与点击时的快照共用同一形状。
  const toolDraft = {
    subAgentIds: subAgentIdsField.value,
    allowedTools: allowedToolsDraft,
    disallowedTools: disallowedToolsDraft,
  };
  const hasSubAgents = toolDraft.subAgentIds.length > 0;
  /** 实际生效的内置工具状态：默认状态由 DEFAULT_DISALLOWED_TOOLS 决定，显式禁用优先，allowedTools 显式放行。 */
  const builtinEnabled = (
    draft: Pick<AgentDraft, 'subAgentIds' | 'allowedTools' | 'disallowedTools'>,
    tool: string,
  ): boolean => {
    // runner 只要 allowSubAgents 为真就放行 Agent/TaskStop，显式禁用拦不住。
    if ((tool === 'Agent' || tool === 'TaskStop') && draft.subAgentIds.length > 0) return true;
    if (draft.disallowedTools.includes(tool)) return false;
    return !DEFAULT_DISALLOWED_TOOLS.includes(tool) || toolLines(draft.allowedTools).includes(tool);
  };

  const toggleBuiltin = (tool: string): void => {
    // Agent/TaskStop 由子智能体绑定决定，开关不生效，避免写出误导性的 disallowedTools。
    if (tool === 'Agent' || tool === 'TaskStop') return;
    // 点击时用完整快照推导，不依赖上一次渲染的值。
    const current = rhf.getValues() as AgentDraft;
    const enabled = builtinEnabled(current, tool);
    const currentTools = toolLines(current.allowedTools);
    set(
      'allowedTools',
      (enabled ? currentTools.filter((item) => item !== tool) : [...currentTools, tool]).join('\n'),
    );
    set(
      'disallowedTools',
      enabled
        ? [...new Set([...current.disallowedTools, tool])]
        : current.disallowedTools.filter((item) => item !== tool),
    );
  };

  /**
   * 原生文件工具默认启用：关闭只加裸 deny，恢复只删裸 allow/deny，回到平台默认范围；
   * 父子和路径规则共用同一逻辑，其它工具的规则一律保留。
   */
  const toggleFileTool = (tool: string): void => {
    const current = rhf.getValues() as AgentDraft;
    const enabled = !current.disallowedTools.includes(tool);
    set(
      'allowedTools',
      toolLines(current.allowedTools)
        .filter((rule) => rule !== tool)
        .join('\n'),
    );
    set(
      'disallowedTools',
      enabled
        ? [...new Set([...current.disallowedTools, tool])]
        : current.disallowedTools.filter((rule) => rule !== tool),
    );
  };

  // 自定义工具格式也由 zod 校验；保存被拦下时，按钮上的提示要指向所在分区。
  const invalidField = allowedInvalid ? ('permissions' as const) : null;
  const saveHint = invalidField === 'permissions' ? '「权限」里的自定义工具格式无效' : null;

  /** 错误字段所在分区可能不是当前选中项：先切过去，下一帧再聚焦真正出错的控件。 */
  const revealInvalidField = (): void => {
    focusSection('permissions', 'agent-allowed-tools');
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

  // 配置、绑定与启停各自独立授权：保存只提交当前用户有权的字段。
  const dirtyKeys = Object.keys(rhf.formState.dirtyFields) as Array<keyof AgentDraft>;
  const configKeys: Array<keyof AgentDraft> = [
    'slug',
    'name',
    'role',
    'description',
    'model',
    'systemPrompt',
    'allowedTools',
    'disallowedTools',
    'permissionMode',
    'uiFormat',
    'effort',
    'maxTurns',
    'maxBudgetUsd',
    'timeoutMs',
    'runtimeEnvironmentId',
  ];
  const bindingKeys: Array<keyof AgentDraft> = [
    'serverIds',
    'skillIds',
    'pluginBindings',
    'subAgentIds',
  ];
  const dirtyConfig = dirtyKeys.some((key) => configKeys.includes(key));
  const dirtyBindings = dirtyKeys.some((key) => bindingKeys.includes(key));
  const dirtyEnabled = dirtyKeys.includes('enabled');
  const unauthorizedDirty =
    (dirtyConfig && !canUpdateConfig) ||
    (dirtyBindings && !canBindings) ||
    (dirtyEnabled && !canEnable);
  const canSave = (canUpdateConfig || canEnable || canBindings) && !unauthorizedDirty;

  const save = rhf.handleSubmit(
    (draft) => {
      if (pending || !canSave) return;
      const full = inputFromDraft(draft);
      // 只提交真正改过的字段：未变字段保留服务端原值，避免整表 PATCH 覆盖他人并发修改。
      const input: AgentPatch = {};
      for (const key of dirtyKeys) {
        if (key === 'effort') input.effort = full.effort ?? null;
        else (input as Record<keyof AgentPatch, unknown>)[key] = full[key];
      }
      // 组合 PATCH 不夹带未授权字段：配置、绑定、启停各按自己的叶裁剪。
      if (!canUpdateConfig) {
        for (const key of configKeys) delete input[key as keyof AgentPatch];
      }
      if (!canBindings) {
        for (const key of bindingKeys) delete input[key as keyof AgentPatch];
      }
      if (!canEnable) delete input.enabled;
      update.mutate(
        {
          id: baseline.id,
          input,
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
      active
        ? 'bg-selected font-medium text-selected-foreground'
        : 'text-muted-foreground hover:bg-hover',
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
  const timeoutHintId = agent.parentId !== null ? 'agent-timeout-hint' : undefined;

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
            {availableTabs.map((item) => (
              <TabsTrigger key={item.id} value={item.id} disabled={locked}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Select
          value={tab}
          disabled={locked}
          items={availableTabOptions}
          onValueChange={(next) => {
            if (next !== null) changeTab(next as TabId);
          }}
        >
          <SelectTrigger className="w-full md:hidden" aria-label="配置任务">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {availableTabs.map((item) => (
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
                disabled={pending || !canEnable}
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
                disabled={!dirty || pending || invalidField !== null || !canSave}
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
              {canVersionsRead ? (
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
              ) : null}
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
                    {canClone ? (
                      <DropdownMenuItem
                        disabled={pending || dirty}
                        onClick={() => setDuplicateOpen(true)}
                      >
                        <Copy className="size-4" /> 克隆专家
                      </DropdownMenuItem>
                    ) : null}
                    {canExport ? (
                      <DropdownMenuItem disabled={exporting} onClick={() => void download()}>
                        <Download className="size-4" /> {exporting ? '导出中…' : '导出 ZIP'}
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuGroup>
                  {canDelete ? (
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={pending}
                      onClick={onDeleteRequest}
                    >
                      <Trash2 className="size-4" /> 删除专家
                    </DropdownMenuItem>
                  ) : null}
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
                        data-disabled={configDisabled}
                        className="gap-1.5"
                        data-invalid={Boolean(errors.name)}
                      >
                        <FieldLabel htmlFor="agent-name">
                          名称
                          <RequiredMark />
                        </FieldLabel>
                        <Input
                          {...rhf.register('name')}
                          disabled={configDisabled}
                          id="agent-name"
                          aria-required="true"
                          aria-invalid={Boolean(errors.name)}
                          aria-describedby={errors.name ? 'agent-name-error' : undefined}
                        />
                        <FieldError id="agent-name-error">{errors.name?.message}</FieldError>
                      </Field>
                      <Field
                        data-disabled={configDisabled}
                        className="gap-1.5"
                        data-invalid={Boolean(errors.role)}
                      >
                        <FieldLabel htmlFor="agent-role">角色</FieldLabel>
                        <Select
                          disabled={configDisabled}
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
                        data-disabled={configDisabled}
                        className="gap-1.5 sm:col-span-2"
                        data-invalid={Boolean(errors.description)}
                      >
                        <FieldLabel htmlFor="agent-desc">描述</FieldLabel>
                        <Input
                          {...rhf.register('description')}
                          disabled={configDisabled}
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
                    <FieldGroup className="gap-5">
                      <Field
                        data-disabled={configDisabled}
                        orientation="horizontal"
                        className="gap-3"
                      >
                        <FieldLabel htmlFor="agent-model">模型</FieldLabel>
                        <Input
                          {...rhf.register('model')}
                          disabled={configDisabled}
                          id="agent-model"
                          list="agent-models"
                          // Keep monospace technical identifiers instead of the base sans-serif input.
                          className="w-64 font-mono"
                        />
                        <datalist id="agent-models">
                          {models.map((model) => (
                            <option key={model} value={model} />
                          ))}
                        </datalist>
                      </Field>
                      <Field
                        data-disabled={configDisabled}
                        orientation="horizontal"
                        className="gap-3"
                      >
                        <FieldLabel htmlFor="agent-effort">推理强度</FieldLabel>
                        <Select
                          disabled={configDisabled}
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
                          <SelectTrigger id="agent-effort" className="w-40">
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

                    <Field data-disabled={configDisabled} className="gap-1.5">
                      <FieldLabel htmlFor="agent-prompt">
                        {roleField.value === '数字分身' ? '工作背景与表达方式' : '系统提示词'}
                      </FieldLabel>
                      <Textarea
                        {...rhf.register('systemPrompt')}
                        disabled={configDisabled}
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
                        {serversState.isPending ? <LoadingState rows={1} /> : null}
                        {serversState.isError ? (
                          <ErrorState
                            error={serversState.error}
                            onRetry={() => void serversState.refetch()}
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
                        {!serversState.isPending && serverOptions.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            还没有可绑定的 server，先去 MCP Servers 页面创建。
                          </p>
                        ) : null}
                        {serverOptions.length > 0 ? (
                          <Combobox
                            disabled={pending || !canBindings}
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
                              data-disabled={bindingsDisabled}
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
                        {knowledgeState.isPending ? <LoadingState rows={1} /> : null}
                        {knowledgeState.isError ? (
                          <ErrorState
                            error={knowledgeState.error}
                            onRetry={() => void knowledgeState.refetch()}
                          />
                        ) : null}
                        {!knowledgeState.isPending && knowledgeOptions.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            前往知识库页面创建，创建后即可在这里绑定。
                          </p>
                        ) : null}
                        {knowledgeOptions.length > 0 ? (
                          <Combobox
                            disabled={pending || !canBindings}
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
                              data-disabled={bindingsDisabled}
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
                        {skillsState.isPending ? <LoadingState rows={1} /> : null}
                        {skillsState.isError ? (
                          <ErrorState
                            error={skillsState.error}
                            onRetry={() => void skillsState.refetch()}
                          />
                        ) : null}
                        {!skillsState.isPending && skillOptions.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            前往技能页创建或安装技能。
                          </p>
                        ) : null}
                        {skillOptions.length > 0 ? (
                          <Combobox
                            disabled={pending || !canBindings}
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
                              data-disabled={bindingsDisabled}
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
                        ) : pluginsState.isPending ? (
                          <LoadingState rows={1} />
                        ) : pluginsState.isError ? (
                          <ErrorState
                            error={pluginsState.error}
                            onRetry={() => void pluginsState.refetch()}
                          />
                        ) : pluginOptions.length === 0 ? (
                          <Link
                            to="/plugins"
                            className={buttonVariants({ variant: 'outline', size: 'sm' })}
                          >
                            导入插件
                          </Link>
                        ) : (
                          <>
                            <Combobox
                              disabled={pending || !canBindings}
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
                                data-disabled={bindingsDisabled}
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
                                  const plugin = pluginCatalog.find(
                                    (item) => item.id === binding.pluginId,
                                  );
                                  const capabilities = canPlugins
                                    ? pluginCapabilities.get(binding.pluginId)
                                    : undefined;
                                  if (!plugin) return null;
                                  return (
                                    <li
                                      key={binding.pluginId}
                                      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
                                    >
                                      <span className="font-medium text-fg">{plugin.name}</span>
                                      {capabilities?.hasHooks ? (
                                        <span className="flex items-center gap-1.5">
                                          <Checkbox
                                            id={`plugin-${binding.pluginId}-hooks`}
                                            checked={binding.allowHooks}
                                            disabled={pending || !canBindings}
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
                                      {capabilities && capabilities.mcpServers.length > 0 ? (
                                        <span className="flex items-center gap-1.5">
                                          <Checkbox
                                            id={`plugin-${binding.pluginId}-mcp`}
                                            checked={binding.allowMcp}
                                            disabled={pending || !canBindings}
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
                        ) : agents.isPending ? (
                          <LoadingState rows={1} />
                        ) : agents.isError ? (
                          <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
                        ) : subAgentOptions.length === 0 ? (
                          agents.data?.length === 0 ? (
                            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                              <span>还没有可委派的专家。</span>
                              <Link
                                to="/agents"
                                className={buttonVariants({ variant: 'outline', size: 'sm' })}
                              >
                                新建专家
                              </Link>
                            </div>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              没有可选的主智能体。只有「没有父级」的智能体才能被委派。
                            </p>
                          )
                        ) : (
                          <Combobox
                            disabled={bindingsDisabled}
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
                              data-disabled={bindingsDisabled}
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
                              <a
                                key={child.id}
                                href={`/api/agents/${agent.id}/subagents/${child.id}/file`}
                                className={buttonVariants({ variant: 'outline', size: 'sm' })}
                              >
                                <Download />
                                {child.slug}.md
                              </a>
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
                    <div className="flex flex-col gap-2 rounded-item bg-warning-soft px-3 py-2 text-xs leading-relaxed text-warning">
                      <p>
                        内置工具在会话容器内运行；原生文件工具受细粒度边界限制，Bash
                        默认启用、可执行任意命令，但同样无法越过 Docker 挂载边界写入只读目录（如
                        /workspace）。启用内置工具会扩大攻击面。
                      </p>
                      <p>
                        平台将绑定连接器的全部工具加入 SDK allowedTools 预批准；工具若设置
                        requiresApproval，仍须通过服务端审批，可挂起等待批准。请仅绑定可信连接器。
                      </p>
                    </div>
                    <FieldGroup className="gap-5">
                      <Field
                        data-disabled={configDisabled}
                        orientation="horizontal"
                        className="gap-3"
                      >
                        <FieldContent>
                          <FieldLabel htmlFor="agent-perm">权限模式</FieldLabel>
                          <FieldDescription id="agent-perm-hint">
                            default 支持原生澄清问答，dontAsk
                            拒绝原生提问；其他未预批准的工具请求会被拒绝。
                            连接器工具仍可能触发服务端审批。
                          </FieldDescription>
                        </FieldContent>
                        <Select
                          disabled={configDisabled}
                          value={permissionModeField.value}
                          onValueChange={(next) => {
                            if (next !== null) {
                              permissionModeField.onChange(next as AgentInput['permissionMode']);
                            }
                          }}
                          items={permissionOptions}
                        >
                          <SelectTrigger
                            id="agent-perm"
                            className="w-64"
                            aria-describedby="agent-perm-hint"
                          >
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
                        data-disabled={configDisabled}
                        className="gap-1.5"
                        data-invalid={allowedInvalid}
                      >
                        <FieldLabel htmlFor="agent-allowed-tools">自定义允许的工具</FieldLabel>
                        <Textarea
                          {...rhf.register('allowedTools')}
                          disabled={configDisabled}
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
                            每行一个额外允许的工具名或模式，如
                            mcp__crm__*；不会限制已绑定连接器的工具。
                          </FieldDescription>
                        )}
                      </Field>
                    </FieldGroup>

                    <div>
                      <h3 className="mb-2 text-sm font-medium text-fg">内置工具</h3>
                      <p className="mb-2 max-w-[70ch] text-xs leading-relaxed text-muted-foreground">
                        {agent.parentId === null
                          ? '主会话可用原生文件工具读写记忆 Markdown 与本轮成果，并只读附件与技能参考；关闭某个工具不等于 Bash 无法读写文件，Bash 仍受 Docker 挂载边界约束。恢复保留已有规则；文件工具的自定义允许项不扩大平台范围，路径禁用规则由 SDK 判断；平台文件边界始终保留。'
                          : '子智能体默认读写自身记忆目录内的 Markdown；关闭工具不会关闭 MEMORY.md 自动加载。自定义允许项不扩大文件范围，其他禁用规则仍生效；Bash 可访问同一容器的可写挂载。子级禁用规则带路径时也会禁用整个工具。'}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {BUILTIN_TOOLS.map((tool) => {
                          const fileTool = isFileTool(tool);
                          const childFileTool = fileTool && agent.parentId !== null;
                          const fileToolLabels = childFileTool
                            ? {
                                on: '默认启用（仅自身记忆）',
                                off: '已显式禁用',
                                restore: '默认记忆范围',
                              }
                            : {
                                on: '已启用（受路径限制）',
                                off: '已禁用',
                                restore: '默认文件范围',
                              };
                          const enabled = fileTool
                            ? !toolDraft.disallowedTools.includes(tool)
                            : builtinEnabled(toolDraft, tool);
                          const fixed = tool === 'Agent' || tool === 'TaskStop';
                          return (
                            <Toggle
                              key={tool}
                              variant="outline"
                              size="sm"
                              pressed={enabled}
                              onPressedChange={() =>
                                fileTool ? toggleFileTool(tool) : toggleBuiltin(tool)
                              }
                              disabled={fixed || configDisabled}
                              title={
                                fixed
                                  ? enabled
                                    ? '由子智能体绑定放行；解绑子智能体后自动禁用'
                                    : '绑定子智能体后自动放行'
                                  : fileTool
                                    ? `${enabled ? fileToolLabels.on : fileToolLabels.off}：点击${
                                        enabled ? '禁用' : `恢复${fileToolLabels.restore}`
                                      }`
                                    : enabled
                                      ? '已放行：点击禁用'
                                      : '已禁用：点击放行'
                              }
                              className="font-mono"
                            >
                              {tool}
                              <span className="sr-only">
                                {fileTool
                                  ? `：${enabled ? fileToolLabels.on : fileToolLabels.off}`
                                  : enabled
                                    ? '：已启用'
                                    : '：已禁用'}
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
                    <FieldGroup className="gap-5">
                      {agent.parentId === null ? (
                        <Field data-disabled={pending} orientation="horizontal" className="gap-3">
                          <FieldContent>
                            <FieldLabel htmlFor="agent-runtime-environment">运行环境</FieldLabel>
                          </FieldContent>
                          <Select
                            disabled={
                              pending ||
                              !canUpdateConfig ||
                              runtimeState.isPending ||
                              runtimeState.isError
                            }
                            value={runtimeEnvironmentValue}
                            items={runtimeEnvironmentOptions}
                            onValueChange={(next) => {
                              if (next === null || next === runtimeEnvironmentValue) return;
                              runtimeEnvironmentField.onChange(next === 'default' ? null : next);
                            }}
                          >
                            <SelectTrigger id="agent-runtime-environment" className="w-64">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {runtimeEnvironmentOptions.map((option) => (
                                  <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </Field>
                      ) : null}
                      {agent.parentId === null && runtimeState.isError ? (
                        <ErrorState
                          error={runtimeState.error}
                          onRetry={() => void runtimeState.refetch()}
                        />
                      ) : null}
                      <Field
                        data-disabled={configDisabled}
                        orientation="horizontal"
                        className="gap-3"
                        data-invalid={Boolean(errors.maxTurns)}
                      >
                        <FieldContent>
                          <FieldLabel htmlFor="agent-turns">最大轮次</FieldLabel>
                          <FieldError id="agent-turns-error">{errors.maxTurns?.message}</FieldError>
                        </FieldContent>
                        <Input
                          {...rhf.register('maxTurns', { valueAsNumber: true })}
                          disabled={configDisabled}
                          id="agent-turns"
                          type="number"
                          min={1}
                          inputMode="numeric"
                          aria-invalid={Boolean(errors.maxTurns)}
                          aria-describedby={errors.maxTurns ? 'agent-turns-error' : undefined}
                          className="w-40"
                        />
                      </Field>
                      <Field
                        data-disabled={configDisabled}
                        orientation="horizontal"
                        className="gap-3"
                        data-invalid={Boolean(errors.maxBudgetUsd)}
                      >
                        <FieldContent>
                          <FieldLabel htmlFor="agent-budget">预算上限 (USD)</FieldLabel>
                          <FieldError id="agent-budget-error">
                            {errors.maxBudgetUsd?.message}
                          </FieldError>
                        </FieldContent>
                        <Input
                          {...rhf.register('maxBudgetUsd', { valueAsNumber: true })}
                          disabled={configDisabled}
                          id="agent-budget"
                          type="number"
                          min={0.01}
                          step={0.01}
                          inputMode="decimal"
                          aria-invalid={Boolean(errors.maxBudgetUsd)}
                          aria-describedby={errors.maxBudgetUsd ? 'agent-budget-error' : undefined}
                          className="w-40"
                        />
                      </Field>
                      <Field
                        data-disabled={configDisabled}
                        orientation="horizontal"
                        className="gap-3"
                        data-invalid={Boolean(errors.timeoutMs)}
                      >
                        <FieldContent>
                          <FieldLabel htmlFor="agent-timeout">独立运行超时 (毫秒)</FieldLabel>
                          {timeoutHintId ? (
                            <FieldDescription id={timeoutHintId}>
                              被委派时使用主运行总超时。
                            </FieldDescription>
                          ) : null}
                          <FieldError id="agent-timeout-error">
                            {errors.timeoutMs?.message}
                          </FieldError>
                        </FieldContent>
                        <Input
                          {...rhf.register('timeoutMs', { valueAsNumber: true })}
                          disabled={configDisabled}
                          id="agent-timeout"
                          type="number"
                          min={1000}
                          step={1000}
                          inputMode="numeric"
                          aria-invalid={Boolean(errors.timeoutMs)}
                          aria-describedby={
                            [errors.timeoutMs ? 'agent-timeout-error' : null, timeoutHintId]
                              .filter(Boolean)
                              .join(' ') || undefined
                          }
                          className="w-40"
                        />
                      </Field>
                      <Field
                        data-disabled={configDisabled}
                        orientation="horizontal"
                        className="gap-3"
                      >
                        <FieldLabel htmlFor="agent-ui-format">回复格式</FieldLabel>
                        <Select
                          disabled={configDisabled}
                          value={uiFormatField.value}
                          onValueChange={(value) => {
                            if (value !== null) {
                              uiFormatField.onChange(value as AgentInput['uiFormat']);
                            }
                          }}
                          items={uiFormatOptions}
                        >
                          <SelectTrigger id="agent-ui-format" className="w-48">
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
            canWrite={canMemoryWrite}
            onDirtyChange={setChildDirty}
            onPendingChange={setChildPending}
          />
        </div>
      ) : null}

      {tab === 'rules' ? (
        <div className="min-w-0 rounded-card bg-surface px-6 py-5 ring-1 ring-line">
          <RulesPanel
            agentId={agent.id}
            canWrite={canRulesWrite}
            onDirtyChange={setChildDirty}
            onPendingChange={setChildPending}
          />
        </div>
      ) : null}

      {tab === 'styles' ? (
        <div className="min-w-0 rounded-card bg-surface px-6 py-5 ring-1 ring-line">
          <OutputStylesPanel
            agentId={agent.id}
            canWrite={canStylesWrite}
            onDirtyChange={setChildDirty}
            onPendingChange={setChildPending}
          />
        </div>
      ) : null}

      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onClose={() => blocker.reset?.()}
        title={
          blockedTabSwitch
            ? childDirty
              ? '放弃未保存的修改并切换？'
              : '当前操作尚未完成'
            : '放弃未保存的更改？'
        }
        description={
          blockedTabSwitch
            ? childDirty
              ? '当前记忆、规则或输出风格还有未保存的内容，切换任务后会丢失。配置草稿会保留。'
              : '当前请求还在进行，请等待完成后再切换任务。'
            : `「${agent.name}」还有未保存的修改，离开后会丢失。可以先取消、保存后再离开。`
        }
        confirmLabel={blockedTabSwitch && childDirty ? '放弃并切换' : '放弃并离开'}
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
              canRestore={canVersionsRestore}
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
  ['uiFormat', '回复格式'],
  ['serverIds', 'MCP Servers'],
  ['skillIds', '技能'],
  ['subAgentIds', '子智能体'],
  ['pluginBindings', '插件绑定'],
  ['allowedTools', '允许的工具'],
  ['disallowedTools', '禁用的工具'],
  ['permissionMode', '权限模式'],
  ['maxTurns', '最大轮次'],
  ['maxBudgetUsd', '预算上限'],
  ['timeoutMs', '独立运行超时'],
  ['runtimeEnvironmentId', '运行环境'],
  ['effort', '推理强度'],
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
  canRestore = true,
  onPendingChange,
  onRolledBack,
}: {
  agentId: string;
  current: Agent;
  active: boolean;
  saving: boolean;
  dirty?: boolean;
  canRestore?: boolean;
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
              canRestore={canRestore}
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
  canRestore,
  onRollback,
}: {
  agentId: string;
  item: AgentVersionSummary;
  current: Agent;
  rollbackDisabled: boolean;
  canRestore: boolean;
  onRollback: () => void;
}) {
  const [open, setOpen] = useState(false);
  const detail = useAgentVersion(agentId, item.version, open);
  const diff = detail.data ? diffAgent(current, detail.data.snapshot) : null;

  return (
    <li className="py-2.5">
      <Collapsible open={open} onOpenChange={setOpen}>
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
            <CollapsibleTrigger
              render={
                <Button variant="ghost" size="sm">
                  <ChevronRight
                    className={cn('size-4 transition-transform', open && 'rotate-90')}
                    aria-hidden="true"
                  />
                  {open ? '收起差异' : '查看差异'}
                </Button>
              }
            />
            {canRestore ? (
              <Button variant="outline" size="sm" disabled={rollbackDisabled} onClick={onRollback}>
                <RotateCcw className="size-4" /> 回滚
              </Button>
            ) : null}
          </div>
        </div>
        <CollapsibleContent animated>
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
        </CollapsibleContent>
      </Collapsible>
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
  const isTwin = roleField.value === '数字分身';
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
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

  const submit = rhf.handleSubmit(
    (draft) => {
      if (create.isPending) return;
      const generatedSlug = draft.name
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^[-_]+|[-_]+$/g, '')
        .slice(0, 64);
      const input = inputFromDraft({
        ...draft,
        slug: draft.slug || generatedSlug || `agent-${crypto.randomUUID().slice(0, 8)}`,
      });
      create.mutate(input, {
        onSuccess: (agent) => {
          toastSuccess('专家已创建');
          setCreated(agent);
        },
        onError: (error) => toastError(error),
      });
    },
    (invalid) => {
      // 标识或模型出错时展开高级设置，错误字段才看得见。
      if (invalid.model || invalid.slug) setAdvancedOpen(true);
    },
  );

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
              className={cn(
                'gap-1.5',
                isTwin && 'grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 sm:col-span-2',
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
              <FieldLabel htmlFor="new-agent-name">
                名称
                <RequiredMark />
              </FieldLabel>
              <Input
                {...rhf.register('name')}
                disabled={create.isPending}
                id="new-agent-name"
                aria-required="true"
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'new-agent-name-error' : undefined}
                placeholder="客服助手"
              />
              <FieldError id="new-agent-name-error">{errors.name?.message}</FieldError>
            </Field>
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
          </FieldGroup>
          <Field data-disabled={create.isPending} className="gap-1.5">
            <FieldLabel htmlFor="new-agent-prompt">
              {isTwin ? '工作背景与表达方式' : '职责与工作方式'}
            </FieldLabel>
            <Textarea
              {...rhf.register('systemPrompt')}
              disabled={create.isPending}
              id="new-agent-prompt"
              rows={6}
              // Keep compact monospace code text instead of the base prose typography.
              className="font-mono text-xs"
            />
          </Field>
          <Collapsible
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
            className="rounded-item border"
          >
            <CollapsibleTrigger
              type="button"
              className="flex w-full cursor-pointer items-center gap-1.5 rounded-item px-3 py-2.5 text-xs text-muted-foreground transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronRight
                className={cn(
                  'size-3.5 shrink-0 transition-transform',
                  advancedOpen && 'rotate-90',
                )}
                aria-hidden="true"
              />
              高级设置
            </CollapsibleTrigger>
            <CollapsibleContent keepMounted animated>
              <div className="flex flex-col gap-3 border-t p-3">
                <Field data-disabled={create.isPending} className="gap-1.5">
                  <FieldLabel htmlFor="new-agent-model">模型</FieldLabel>
                  {/* 网关模型名不是白名单：输入任意 ID，建议值只做补全。 */}
                  <Input
                    {...rhf.register('model')}
                    disabled={create.isPending}
                    id="new-agent-model"
                    list="new-agent-models"
                    className="font-mono"
                  />
                  <datalist id="new-agent-models">
                    {models.map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>
                </Field>
                <Field
                  data-disabled={create.isPending}
                  className="gap-1.5"
                  data-invalid={Boolean(errors.slug)}
                >
                  <FieldLabel htmlFor="new-agent-slug">标识（可选）</FieldLabel>
                  <Input
                    {...rhf.register('slug')}
                    disabled={create.isPending}
                    id="new-agent-slug"
                    placeholder="support-bot"
                    // Keep monospace for the technical slug instead of the base sans-serif input.
                    className="font-mono"
                    aria-invalid={Boolean(errors.slug)}
                    aria-describedby={errors.slug ? 'new-agent-slug-error' : 'new-agent-slug-hint'}
                  />
                  {errors.slug ? (
                    <FieldError id="new-agent-slug-error">{errors.slug?.message}</FieldError>
                  ) : (
                    <FieldDescription id="new-agent-slug-hint">
                      留空时由名称自动生成；仅支持小写字母、数字、- 和 _，创建后不可修改。
                    </FieldDescription>
                  )}
                </Field>
              </div>
            </CollapsibleContent>
          </Collapsible>
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
