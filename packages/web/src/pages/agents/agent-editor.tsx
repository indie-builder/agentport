import {
  type Agent,
  type AgentInput,
  type AgentPatch,
  BUILTIN_TOOLS,
  DEFAULT_DISALLOWED_TOOLS,
  effortSchema,
  type PermissionId,
  permissionModeSchema,
  type Server,
} from '@agentport/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link, useBlocker, useNavigate, useSearch } from '@tanstack/react-router';
import {
  Bot,
  Check,
  Copy,
  Download,
  Ellipsis,
  FileCode,
  FileText,
  History,
  LibraryBig,
  Plug,
  Puzzle,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { type Control, type Path, type PathValue, useController, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { AgentOverview } from '../../components/agent/agent-overview.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { MemoryPanel } from '../../components/memory/memory-panel.js';
import { PageBody, PageTopbar } from '../../components/page.js';
import { RequiredMark } from '../../components/required-mark.js';
import { ErrorState, LoadingState } from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button, buttonVariants } from '../../components/ui/button.js';
import { Checkbox } from '../../components/ui/checkbox.js';
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
} from '../../components/ui/combobox.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../../components/ui/field.js';
import { Input } from '../../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '../../components/ui/sheet.js';
import { Switch } from '../../components/ui/switch.js';
import { Tabs, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Toggle } from '../../components/ui/toggle.js';
import { can, hasAnyGrant } from '../../lib/access.js';
import { ApiError, api } from '../../lib/api.js';
import { downloadBlob } from '../../lib/browser-files.js';
import { cn } from '../../lib/cn.js';
import {
  type AgentInstruction,
  type MemoryView,
  agentSections as sectionItems,
  agentTabs as tabItems,
} from '../../lib/detail-tabs.js';
import {
  agentDetailQuery,
  meQuery,
  toolsQuery,
  useAgentFiles,
  useAgentOptions,
  useExperts,
  useKnowledgeBases,
  usePlugins,
  useRuntimeEnvironments,
  useServers,
  useSkills,
  useUpdateAgent,
} from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';
import { AgentInstructions } from './agent-instructions.js';
import { DuplicateAgentDialog } from './create-agent-dialog.js';
import { DraftPreview } from './draft-preview.js';
import { FilesPreview } from './files-preview.js';
import {
  type AgentDraft,
  activeAgentTab,
  activeInstruction,
  agentFormSchema,
  asInstruction,
  baseFileEntries,
  canOpenTab,
  draftFromInput,
  errorSections,
  inputFromDraft,
  isFileTool,
  listWorkspaceFiles,
  mergeKnowledgeIds,
  models,
  roleOptions,
  type SectionId,
  type TabId,
  toInput,
  toolLines,
} from './shared.js';
import { VersionHistory } from './version-history.js';

export function AgentEditor({
  agent,
  permissions,
  canViewRuns = false,
  deletePending = false,
  onDirtyChange,
  onPendingChange,
  onDeleteRequest,
}: {
  agent: Agent;
  permissions: readonly PermissionId[];
  canViewRuns?: boolean;
  deletePending?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onPendingChange: (pending: boolean) => void;
  onDeleteRequest: () => void;
}) {
  const allow = (id: PermissionId): boolean => hasAnyGrant(permissions, id);
  const canUpdateConfig = allow('agents.config.update');
  const canEnable = allow('agents.enable');
  const canBindings = allow('agents.bindings.manage');
  const canMemoryWrite = allow('agents.memory.write');
  const canVersionsRead = allow('agents.versions.read');
  const canVersionsRestore = allow('agents.versions.restore');
  const canClone = allow('agents.clone');
  const canExport = allow('agents.export');
  const canDelete = allow('agents.delete');
  const availableTabs = tabItems.filter((item) => canOpenTab(item.id, permissions));
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
  const agents = useExperts();
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
  const tab = activeAgentTab(search.tab, permissions);
  const instruction = activeInstruction(
    asInstruction(search.tab) ?? search.instruction,
    permissions,
    agent.parentId !== null,
  );
  const [activeSection, setActiveSectionState] = useState<SectionId>(sectionFromUrl);
  const activeFile = search.file ?? '.mcp.json';
  useEffect(() => setActiveSectionState(sectionFromUrl), [sectionFromUrl]);
  // 旧书签 tab=rules|styles 改写为 instructions + instruction，replace 不堆历史。
  useEffect(() => {
    const legacy = asInstruction(search.tab);
    if (!legacy) return;
    void navigate({
      to: '/agents/$agentId',
      params: { agentId: agent.id },
      search: (current) => ({ ...current, tab: 'instructions', instruction: legacy }),
      replace: true,
    });
  }, [search.tab, navigate, agent.id]);
  // 任务、分区、指令分段与文件都进 URL：刷新或分享后回到同一视图。
  const navigateSearch = (next: {
    tab?: TabId | undefined;
    instruction?: AgentInstruction | undefined;
    section?: SectionId | undefined;
    view?: MemoryView | undefined;
    file?: string | undefined;
  }): void => {
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
      downloadBlob(
        await api.exportAgent(agent.id, undefined, (warnings) => {
          for (const warning of warnings) toast.warning(warning);
        }),
        `${agent.slug}.zip`,
      );
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
    onDirtyChange?.(guarded || locked);
  }, [guarded, locked, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

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

  // 进入「文件与版本」时滚回该栏顶部，避免停在上一份长文件的中段。
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
            if ('systemPrompt' in saved) loadDraft(saved);
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
      'flex w-full items-center rounded-icon px-2 py-1.5 text-sm transition-colors duration-150 ease-out-soft md:text-left',
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
    ...effortSchema.options.map((value) => ({ value, label: value })),
  ];
  const permissionLabels: Record<(typeof permissionModeSchema.options)[number], string> = {
    dontAsk: 'dontAsk — 拒绝未预批准',
    plan: 'plan — 只规划不执行',
    default: 'default — 标准权限',
    acceptEdits: 'acceptEdits — 自动接受编辑',
  };
  const permissionOrder = Object.keys(permissionLabels);
  const permissionOptions = permissionModeSchema.options
    .toSorted((a, b) => permissionOrder.indexOf(a) - permissionOrder.indexOf(b))
    .map((value) => ({ value, label: permissionLabels[value] }));
  const uiFormatOptions = [
    { value: 'markdown', label: 'Markdown' },
    { value: 'openui', label: '生成式 UI' },
  ];
  const timeoutHintId = agent.parentId !== null ? 'agent-timeout-hint' : undefined;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5">
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
      <PageTopbar>
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
                className="inline-flex items-center gap-2 rounded-item p-1 text-sm text-muted-foreground transition-colors duration-150 ease-out-soft hover:bg-hover hover:text-fg"
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
                  <span className="mr-1 inline-flex items-center gap-1.5 text-xs text-warning">
                    <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />
                    未保存
                  </span>
                ) : null}
                {saveHint ? (
                  <span className="mr-1 flex items-center gap-1.5 text-sm text-danger">
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
                  <DropdownMenuContent align="end" sideOffset={4} className="w-40">
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
      </PageTopbar>
      <PageBody className="gap-5 p-2">
        {tab === 'overview' ? (
          <AgentOverview
            agentId={agent.id}
            agent={agent}
            config={agent}
            permissions={permissions}
            canReadKnowledge={canKnowledge}
            canViewRuns={canViewRuns}
            onNavigate={navigateSearch}
          />
        ) : null}
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
                <div className="cds-card-surface rounded-card bg-surface px-6 py-5">
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
                                : [
                                    { value: roleField.value, label: roleField.value },
                                    ...roleOptions,
                                  ]
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
                          <FieldError id="agent-desc-error">
                            {errors.description?.message}
                          </FieldError>
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
                            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                              <span>还没有可绑定的连接器。</span>
                              <Link
                                to="/servers"
                                className={buttonVariants({ variant: 'outline', size: 'sm' })}
                              >
                                去连接器创建
                              </Link>
                            </div>
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
                                      <span className="min-w-0 flex-1 truncate">
                                        {option.label}
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
                              <LibraryBig
                                className="size-4 text-muted-foreground"
                                aria-hidden="true"
                              />
                              知识库
                            </h3>
                            <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                              已选{' '}
                              {serverIdsField.value.filter((id) => knowledgeIds.has(id)).length}
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
                            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                              <span>还没有可绑定的知识库。</span>
                              <Link
                                to="/knowledge"
                                className={buttonVariants({ variant: 'outline', size: 'sm' })}
                              >
                                去知识库创建
                              </Link>
                            </div>
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
                                      <span className="min-w-0 flex-1 truncate">
                                        {option.label}
                                      </span>
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
                              <Sparkles
                                className="size-4 text-muted-foreground"
                                aria-hidden="true"
                              />
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
                            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                              <span>还没有可绑定的技能。</span>
                              <Link
                                to="/skills"
                                className={buttonVariants({ variant: 'outline', size: 'sm' })}
                              >
                                去技能页创建或安装
                              </Link>
                            </div>
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
                                <ComboboxChipsInput
                                  aria-label="技能"
                                  placeholder="搜索并选择技能…"
                                />
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
                            <p className="text-sm text-muted-foreground">
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
                              <p className="mt-1.5 text-sm text-muted-foreground">
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
                            <p className="text-sm text-muted-foreground">
                              它本身已经是子智能体，不能再委派。子智能体只支持一层。
                            </p>
                          ) : agents.isPending ? (
                            <LoadingState rows={1} />
                          ) : agents.isError ? (
                            <ErrorState
                              error={agents.error}
                              onRetry={() => void agents.refetch()}
                            />
                          ) : subAgentOptions.length === 0 ? (
                            agents.data?.length === 0 ? (
                              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                                <span>还没有可委派的专家。</span>
                                <Link
                                  to="/agents"
                                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                                >
                                  新建专家
                                </Link>
                              </div>
                            ) : (
                              <p className="text-sm text-muted-foreground">
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
                              <FileText
                                className="size-4 text-muted-foreground"
                                aria-hidden="true"
                              />{' '}
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
                            <p className="text-sm text-muted-foreground">
                              技能文件与 MCP 连接配置需来自同一工作区。
                            </p>
                            {subAgentIdsField.value.length !== agent.subAgentIds.length ||
                            subAgentIdsField.value.some((id) => !agent.subAgentIds.includes(id)) ? (
                              <p className="text-sm text-muted-foreground">
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
                      <div className="flex flex-col gap-2 rounded-item bg-warning-soft px-3 py-2 text-sm text-warning">
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
                        <p className="mb-2 max-w-[70ch] text-sm text-muted-foreground">
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
                            <FieldError id="agent-turns-error">
                              {errors.maxTurns?.message}
                            </FieldError>
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
                            aria-describedby={
                              errors.maxBudgetUsd ? 'agent-budget-error' : undefined
                            }
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
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-[70ch] text-sm text-muted-foreground">
                这里展示只读投影，编辑请到配置、专家记忆或指令。
              </p>
              {canVersionsRead ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => setHistoryOpen(true)}
                >
                  <History data-icon="inline-start" /> 版本历史
                </Button>
              ) : null}
            </div>
            <div className="grid items-start gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
              <nav aria-label="工作区文件" className="hidden min-w-0 md:block">
                <ul className="flex flex-col gap-0.5">
                  {fileGroups.map((group) => (
                    <Fragment key={group}>
                      <li className="min-w-0">
                        <p className="px-2 pt-1 pb-0.5 text-xs text-muted-foreground">{group}</p>
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
                className="min-w-0 scroll-mt-4 cds-card-surface rounded-card bg-surface px-6 py-5"
              >
                <FilesPreview entry={resolvedEntry} dirty={dirty} files={files} />
              </div>
            </div>
          </div>
        ) : null}

        {tab === 'memory' ? (
          <div className="min-w-0 cds-card-surface rounded-card bg-surface px-6 py-5">
            <MemoryPanel
              agentId={agent.id}
              canWrite={canMemoryWrite}
              view={search.view ?? 'overview'}
              onViewChange={(view) => navigateSearch({ view })}
              onDirtyChange={setChildDirty}
              onPendingChange={setChildPending}
            />
          </div>
        ) : null}

        {tab === 'instructions' && instruction ? (
          <AgentInstructions
            agentId={agent.id}
            permissions={permissions}
            instruction={instruction}
            isSubAgent={agent.parentId !== null}
            onInstructionChange={(next) => navigateSearch({ instruction: next })}
            onDirtyChange={setChildDirty}
            onPendingChange={setChildPending}
          />
        ) : null}
      </PageBody>
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
          className="w-full max-w-120! gap-0 p-0 shadow-overlay sm:max-w-120!"
        >
          <div className="flex items-start justify-between gap-4 border-b px-5 py-3.5">
            <div className="min-w-0">
              {/* Keep the larger, heavier history title instead of the base title typography. */}
              <SheetTitle className="text-md font-semibold">版本历史</SheetTitle>
              <SheetDescription className="mt-1 text-sm">
                每次保存生成一份快照。回滚会覆盖当前配置并生成新版本。
              </SheetDescription>
            </div>
            <SheetClose
              disabled={pending}
              render={<Button variant="ghost" size="icon-sm" aria-label="关闭" className="-mr-1" />}
            >
              <X className="size-3" aria-hidden="true" />
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
