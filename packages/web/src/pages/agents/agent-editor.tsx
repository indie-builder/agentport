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
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Button as ButtonPrimitive } from '@ui-sdk/react/button';
import {
  Bot,
  Check,
  Copy,
  Download,
  EllipsisVertical,
  FileCode,
  FileText,
  History,
  LibraryBig,
  Play,
  Plug,
  PowerOff,
  Puzzle,
  Rocket,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { type Control, type Path, type PathValue, useController, useWatch } from 'react-hook-form';
import { AgentOverview } from '../../components/agent/agent-overview.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { DialogShell } from '../../components/dialog-shell.js';
import { MemoryPanel } from '../../components/memory/memory-panel.js';
import { PageBody, PageTopbar } from '../../components/page.js';
import { RequiredMark } from '../../components/required-mark.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button, buttonVariants } from '../../components/ui/button.js';
import { Checkbox } from '../../components/ui/checkbox.js';
import {
  Combobox,
  ComboboxChip,
  ComboboxChipRemove,
  ComboboxChips,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '../../components/ui/combobox.js';
import { Dialog } from '../../components/ui/dialog.js';
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
  NumberInput,
  NumberInputControl,
  NumberInputDecrement,
  NumberInputGroup,
  NumberInputIncrement,
} from '../../components/ui/number-input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
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
import { ApiError, api, errorMessage } from '../../lib/api.js';
import { downloadBlob } from '../../lib/browser-files.js';
import { cn } from '../../lib/cn.js';
import {
  type AgentInstruction,
  type MemoryView,
  agentSections as sectionItems,
  agentTabs as tabItems,
} from '../../lib/detail-tabs.js';
import { applyProblemToForm, useFormBlocker } from '../../lib/form.js';
import { runtimeEnvironmentOptions } from '../../lib/format.js';
import {
  agentDetailQuery,
  meQuery,
  toolsQuery,
  useAgentFiles,
  useAgentOptions,
  useDrainPages,
  useExperts,
  useKnowledgeBases,
  useOfflineAgent,
  usePlugins,
  usePublishAgent,
  useRuntimeEnvironments,
  useServers,
  useSkills,
  useTrialAgent,
  useUpdateAgent,
} from '../../lib/queries.js';
import { toast, toastError, toastSuccess } from '../../lib/toast.js';
import { useOptimisticValue } from '../../lib/use-optimistic-value.js';
import { useZodForm } from '../../lib/use-zod-form.js';
import { AgentInstructions } from './agent-instructions.js';
import { DuplicateAgentDialog } from './create-agent-dialog.js';
import { DraftPreview } from './draft-preview.js';
import { FilesPreview } from './files-preview.js';
import {
  type AgentDraft,
  activeAgentTab,
  activeInstruction,
  agentDefaults,
  agentFormSchema,
  asInstruction,
  baseFileEntries,
  bindingKeys,
  canOpenTab,
  configKeys,
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
  const canPublish = allow('agents.publish');
  const canBindings = allow('agents.bindings.manage');
  const canMemoryWrite = allow('agents.memory.write');
  const canVersionsRead = allow('agents.versions.read');
  const canVersionsRestore = allow('agents.versions.restore');
  const canUse = allow('agents.use');
  const canEvaluate = allow('eval.execute');
  const canClone = allow('agents.clone');
  const canExport = allow('agents.export');
  const canDelete = allow('agents.delete');
  const availableTabs = tabItems.filter((item) => canOpenTab(item.id, permissions));
  const availableTabOptions = availableTabs.map((item) => ({ value: item.id, label: item.label }));
  const update = useUpdateAgent();
  const publish = usePublishAgent();
  const offline = useOfflineAgent();
  const trial = useTrialAgent();
  const me = useQuery(meQuery);
  const canServers = can(me.data, 'servers.read');
  const canSkills = can(me.data, 'skills.read');
  const canPlugins = can(me.data, 'plugins.read');
  const canKnowledge = can(me.data, 'knowledge.read');
  const canRuntimeEnvironments = can(me.data, 'runtime_environments.read');
  const options = useAgentOptions(canBindings);
  const servers = useServers(canServers);
  const knowledgeBases = useKnowledgeBases(canKnowledge);
  const skills = useSkills({ enabled: canSkills });
  const plugins = usePlugins({ enabled: canPlugins });
  useDrainPages(skills);
  useDrainPages(plugins);
  const agents = useExperts();
  const runtimeEnvironments = useRuntimeEnvironments(canRuntimeEnvironments);
  useDrainPages(servers);
  useDrainPages(runtimeEnvironments);
  const optionServers = options.data?.servers ?? [];
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
        ? (skills.data ?? [])
            .filter((skill) => skill.status === 'published')
            .map((skill) => ({
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
  const serversState = canServers ? servers : options;
  const skillsState = canSkills ? skills : options;
  const pluginsState = canPlugins ? plugins : options;
  const knowledgeState = canKnowledge ? knowledgeBases : options;
  const runtimeState = canRuntimeEnvironments ? runtimeEnvironments : options;
  const pluginCapabilities = new Map(
    (plugins.data ?? []).map((plugin) => [plugin.id, plugin.capabilities]),
  );
  const navigate = useNavigate({ from: '/agents/$agentId' });
  const search = useSearch({ from: '/_shell/agents/$agentId' });
  const [serverAnchor, setServerAnchor] = useState<HTMLDivElement | null>(null);
  const [knowledgeAnchor, setKnowledgeAnchor] = useState<HTMLDivElement | null>(null);
  const [skillAnchor, setSkillAnchor] = useState<HTMLDivElement | null>(null);
  const [pluginAnchor, setPluginAnchor] = useState<HTMLDivElement | null>(null);
  const [subAgentAnchor, setSubAgentAnchor] = useState<HTMLDivElement | null>(null);
  const [baseline, setBaseline] = useState(agent);
  const [conflict, setConflict] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const pending =
    update.isPending ||
    reloading ||
    rollingBack ||
    deletePending ||
    publish.isPending ||
    offline.isPending;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishNote, setPublishNote] = useState('');
  const [offlineOpen, setOfflineOpen] = useState(false);
  const [trialOpen, setTrialOpen] = useState(false);
  const [trialPrompt, setTrialPrompt] = useState('');
  const [trialResult, setTrialResult] = useState<{ runId: string; conversationId: string } | null>(
    null,
  );
  const duplicateTriggerRef = useRef<HTMLButtonElement>(null);
  const sectionFromUrl = search.section ?? 'identity';
  const tab = activeAgentTab(search.tab, permissions);
  const instruction = activeInstruction(
    asInstruction(search.tab) ?? search.instruction,
    permissions,
    agent.parentId !== null,
  );
  const [activeSection, setActiveSectionState] = useState<SectionId>(sectionFromUrl);
  const activeFile = search.file ?? '.mcp.json';
  useEffect(() => setActiveSectionState(sectionFromUrl), [sectionFromUrl]);
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
  const navigateSearch = (next: {
    tab?: TabId | undefined;
    instruction?: AgentInstruction | undefined;
    section?: SectionId | undefined;
    view?: MemoryView | undefined;
    file?: string | undefined;
    usageDays?: 7 | 30 | 90 | undefined;
  }): Promise<void> =>
    navigate({
      to: '/agents/$agentId',
      params: { agentId: agent.id },
      search: (current) => ({ ...current, ...next }),
      replace: true,
    });
  const [optimisticTab, commitTab, resetTab] = useOptimisticValue(tab);
  const setTab = (next: TabId): void => commitTab(next, () => navigateSearch({ tab: next }));
  const setActiveSection = (next: SectionId): void => {
    setActiveSectionState(next);
    void navigateSearch({ section: next });
  };
  const files = useAgentFiles(agent.id, tab === 'files');
  const fileEntries = files.data ? listWorkspaceFiles(files.data) : baseFileEntries;
  const resolvedEntry = fileEntries.find((entry) => entry.id === activeFile) ?? fileEntries[0];
  const resolvedId = resolvedEntry?.id;
  const [optimisticFileId, commitFileId] = useOptimisticValue(resolvedId ?? null);
  const setActiveFile = (next: string): void =>
    commitFileId(next, () => navigateSearch({ file: next }));
  const fileGroups = [...new Set(fileEntries.map((entry) => entry.group))];
  const [exporting, setExporting] = useState(false);
  const rhf = useZodForm(agentFormSchema, { defaultValues: draftFromInput(toInput(agent)) });
  const control = rhf.control as unknown as Control<AgentDraft, unknown, AgentDraft>;
  const errors = rhf.formState.errors;
  const allowedInvalid = Boolean(errors.allowedTools);
  const roleField = useController({ control, name: 'role' }).field;
  const visibilityField = useController({ control, name: 'visibility' }).field;
  const tagsField = useController({ control, name: 'tags' }).field;
  const effortField = useController({ control, name: 'effort' }).field;
  const serverIdsField = useController({ control, name: 'serverIds' }).field;
  const skillIdsField = useController({ control, name: 'skillIds' }).field;
  const subAgentIdsField = useController({ control, name: 'subAgentIds' }).field;
  const pluginBindingsField = useController({ control, name: 'pluginBindings' }).field;
  const permissionModeField = useController({ control, name: 'permissionMode' }).field;
  const uiFormatField = useController({ control, name: 'uiFormat' }).field;
  const maxTurnsField = useController({ control, name: 'maxTurns' }).field;
  const maxBudgetUsdField = useController({ control, name: 'maxBudgetUsd' }).field;
  const monthlyBudgetUsdField = useController({ control, name: 'monthlyBudgetUsd' }).field;
  const budgetAlertRatioField = useController({ control, name: 'budgetAlertRatio' }).field;
  const timeoutMsField = useController({ control, name: 'timeoutMs' }).field;
  const enabledField = useController({ control, name: 'enabled' }).field;
  const runtimeEnvironmentField = useController({ control, name: 'runtimeEnvironmentId' }).field;
  const defaultEnvironment = runtimeCatalog.find((environment) => environment.isDefault);
  const runtimeEnvironmentValue =
    runtimeEnvironmentField.value === null ||
    runtimeEnvironmentField.value === defaultEnvironment?.id
      ? 'default'
      : runtimeEnvironmentField.value;
  const runtimeEnvironmentItems = runtimeEnvironmentOptions(runtimeCatalog);
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
      setReloadError(null);
    } finally {
      setReloading(false);
    }
  };
  const dirty = rhf.formState.isDirty;

  const [childDirty, setChildDirty] = useState(false);
  const [childPending, setChildPending] = useState(false);
  const guarded = dirty || childDirty;
  const locked = pending || childPending;
  const confirmedChildSwitch = useRef<{
    instruction: AgentInstruction | undefined;
    view: MemoryView | undefined;
  } | null>(null);
  const configDisabled = pending || !canUpdateConfig;
  const bindingsDisabled = pending || !canBindings;

  const blocker = useFormBlocker(guarded, locked, {
    allowNavigation: ({ current, next }) => {
      if (current.pathname !== next.pathname) return false;
      const currentTab = 'tab' in current.search ? (current.search.tab ?? 'config') : 'config';
      const nextTab = 'tab' in next.search ? (next.search.tab ?? 'config') : 'config';
      if (currentTab === nextTab) {
        const ci = 'instruction' in current.search ? current.search.instruction : undefined;
        const ni = 'instruction' in next.search ? next.search.instruction : undefined;
        const cv = 'view' in current.search ? current.search.view : undefined;
        const nv = 'view' in next.search ? next.search.view : undefined;
        if (ci === ni && cv === nv) return true;
        const confirmed = confirmedChildSwitch.current;
        if (confirmed && confirmed.instruction === ni && confirmed.view === nv) return true;
      }
      return !(childDirty || locked);
    },
  });
  useEffect(() => {
    confirmedChildSwitch.current = null;
  }, [instruction, search.view]);
  const proceedLeave = (): void => {
    blocker.proceed();
  };
  const blockedTabSwitch =
    blocker.status === 'blocked' && blocker.current?.pathname === blocker.next?.pathname;
  useEffect(() => {
    if (blocker.status === 'blocked') resetTab();
  }, [blocker.status, resetTab]);

  useEffect(() => {
    onDirtyChange?.(guarded || locked);
  }, [guarded, locked, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  useEffect(() => {
    onPendingChange(locked);
    return () => onPendingChange(false);
  }, [locked, onPendingChange]);

  const changeTab = (next: TabId, details?: { cancel: () => void }): void => {
    if (next === optimisticTab || locked) {
      details?.cancel();
      return;
    }
    setTab(next);
  };

  useEffect(() => {
    if (tab !== 'files') return;
    const el = document.getElementById('agent-files-detail');
    el?.scrollIntoView({ block: 'start' });
  }, [tab]);

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
            model: detail?.model ?? agentDefaults.model,
            systemPrompt: detail?.systemPrompt ?? '',
            maxTurns: detail?.maxTurns ?? agentDefaults.maxTurns,
            timeoutMs: detail?.timeoutMs ?? agentDefaults.timeoutMs,
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

  const subAgentOptions = (agents.data ?? [])
    .filter(
      (item) => item.id !== agent.id && (item.parentId === null || item.parentId === agent.id),
    )
    .map((item) => ({ id: item.id, label: item.name, hint: item.slug }));

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

  const toolDraft = {
    subAgentIds: subAgentIdsField.value,
    allowedTools: allowedToolsDraft,
    disallowedTools: disallowedToolsDraft,
  };
  const hasSubAgents = toolDraft.subAgentIds.length > 0;
  const builtinEnabled = (
    draft: Pick<AgentDraft, 'subAgentIds' | 'allowedTools' | 'disallowedTools'>,
    tool: string,
  ): boolean => {
    if ((tool === 'Agent' || tool === 'TaskStop') && draft.subAgentIds.length > 0) return true;
    if (draft.disallowedTools.includes(tool)) return false;
    return !DEFAULT_DISALLOWED_TOOLS.includes(tool) || toolLines(draft.allowedTools).includes(tool);
  };

  const toggleBuiltin = (tool: string): void => {
    if (tool === 'Agent' || tool === 'TaskStop') return;
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

  const invalidField = allowedInvalid ? ('permissions' as const) : null;
  const saveHint = invalidField === 'permissions' ? '「权限」里的自定义工具格式无效' : null;

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

  const dirtyKeys = Object.keys(rhf.formState.dirtyFields) as Array<keyof AgentDraft>;
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
      const input: AgentPatch = {};
      for (const key of dirtyKeys) {
        if (key === 'effort') input.effort = full.effort ?? null;
        else (input as Record<keyof AgentPatch, unknown>)[key] = full[key];
      }
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
            if (saved.kind === 'detail') loadDraft(saved.agent);
            toastSuccess('草稿已保存');
          },
          onError: (error) => {
            applyProblemToForm(rhf, error);
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
      const section = (Object.keys(invalid) as Array<keyof AgentInput>)
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
            onClick={() => {
              setConfirmReload(true);
              setReloadError(null);
            }}
          >
            加载最新配置
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmReload}
        onClose={() => {
          if (!pending) {
            setConfirmReload(false);
            setReloadError(null);
          }
        }}
        title="放弃草稿并加载最新配置？"
        description="当前未保存的更改会丢失。加载失败时会保留当前草稿。"
        confirmLabel="放弃并加载"
        confirmDisabled={pending}
        onConfirm={async () => {
          if (!pending) await reload();
        }}
        onError={(error) => setReloadError(errorMessage(error))}
      >
        {reloadError ? <FieldError>{reloadError}</FieldError> : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmCancel}
        onClose={() => {
          if (!pending) setConfirmCancel(false);
        }}
        title="放弃未保存的修改？"
        description="当前未保存的更改会丢失，配置将恢复到上次保存的状态。"
        confirmLabel="放弃修改"
        confirmDisabled={pending}
        onConfirm={async () => {
          if (!pending) loadDraft(baseline);
        }}
      />
      <PageTopbar>
        <div className="flex min-w-0 flex-wrap items-center gap-3 border-b pb-3">
          <Tabs
            value={optimisticTab}
            onValueChange={(next, details) => changeTab(next as TabId, details)}
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
            value={optimisticTab}
            disabled={locked}
            items={availableTabOptions}
            onValueChange={(next, details) => {
              if (next === null) {
                details.cancel();
                return;
              }
              changeTab(next as TabId, details);
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
                className="-ml-1 inline-flex items-center gap-2 rounded-item p-1 text-sm text-muted-foreground transition-colors duration-150 ease-out-soft hover:bg-hover hover:text-fg"
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
              <div className="flex min-w-0 flex-wrap items-center gap-2 [&>:last-child[data-variant=ghost][data-size=icon]]:-mr-2">
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
                {dirty ? (
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => setConfirmCancel(true)}
                  >
                    取消
                  </Button>
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
                    '保存草稿'
                  ) : (
                    <>
                      <Check data-icon="inline-start" /> 已保存
                    </>
                  )}
                </Button>
                {canUpdateConfig && canUse ? (
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => {
                      setTrialResult(null);
                      setTrialOpen(true);
                    }}
                  >
                    <Play /> 试跑
                  </Button>
                ) : null}
                {canPublish ? (
                  <Button
                    disabled={pending || guarded}
                    title={guarded ? '先保存草稿再发布' : undefined}
                    onClick={() => {
                      setPublishNote('');
                      setPublishOpen(true);
                    }}
                  >
                    <Rocket /> 发布
                  </Button>
                ) : null}
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
                        <EllipsisVertical />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end" sideOffset={4} className="w-40">
                    <DropdownMenuGroup>
                      {canClone ? (
                        <DropdownMenuItem
                          disabled={pending || dirty}
                          onSelect={() => setDuplicateOpen(true)}
                        >
                          <Copy className="size-4" /> 克隆专家
                        </DropdownMenuItem>
                      ) : null}
                      {canExport ? (
                        <DropdownMenuItem disabled={exporting} onSelect={() => void download()}>
                          <Download className="size-4" /> {exporting ? '导出中…' : '导出 ZIP'}
                        </DropdownMenuItem>
                      ) : null}
                      {canEnable && agent.enabled ? (
                        <DropdownMenuItem
                          disabled={pending || guarded}
                          onSelect={() => setOfflineOpen(true)}
                        >
                          <PowerOff className="size-4" /> 下线专家
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuGroup>
                    {canDelete ? (
                      <DropdownMenuItem
                        variant="destructive"
                        disabled={pending}
                        onSelect={onDeleteRequest}
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
      <PageBody className="-mx-4 gap-5 px-4 pt-2">
        {tab === 'overview' ? (
          <AgentOverview
            agentId={agent.id}
            agent={agent}
            config={agent}
            permissions={permissions}
            canReadKnowledge={canKnowledge}
            canViewRuns={canViewRuns}
            usageDays={search.usageDays ?? 30}
            onNavigate={navigateSearch}
          />
        ) : null}
        {tab === 'config' ? (
          <div className="grid items-start gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
            <nav aria-label="配置分区" className="min-w-0">
              <ul className="flex flex-wrap gap-1 md:-mx-2 md:flex-col md:flex-nowrap md:gap-0.5">
                {sectionItems.map((item) => (
                  <li key={item.id} className="min-w-0">
                    <ButtonPrimitive
                      aria-current={activeSection === item.id ? 'true' : undefined}
                      onClick={() => focusSection(item.id)}
                      className={sectionButtonClass(activeSection === item.id)}
                    >
                      {item.label}
                    </ButtonPrimitive>
                  </li>
                ))}
              </ul>
            </nav>

            <div className="min-w-0">
              <form
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
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
                            placeholder="一句话说明它擅长什么"
                          />
                          <FieldError id="agent-desc-error">
                            {errors.description?.message}
                          </FieldError>
                        </Field>
                        <Field data-disabled={configDisabled} className="gap-1.5">
                          <FieldLabel htmlFor="agent-visibility">可见范围</FieldLabel>
                          <Select
                            disabled={configDisabled}
                            value={visibilityField.value}
                            items={[
                              { value: 'private', label: '私有' },
                              { value: 'organization', label: '组织可见' },
                            ]}
                            onValueChange={(next) => {
                              if (next === 'private' || next === 'organization')
                                visibilityField.onChange(next);
                            }}
                          >
                            <SelectTrigger id="agent-visibility" className="w-full min-w-0">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                <SelectItem value="private">私有</SelectItem>
                                <SelectItem value="organization">组织可见</SelectItem>
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                          <FieldDescription>组织可见需发布后对其他成员开放。</FieldDescription>
                        </Field>
                        <Field
                          data-disabled={configDisabled}
                          className="gap-1.5"
                          data-invalid={Boolean(errors.tags)}
                        >
                          <FieldLabel htmlFor="agent-tags">标签</FieldLabel>
                          <Input
                            disabled={configDisabled}
                            id="agent-tags"
                            value={tagsField.value}
                            placeholder="客服、写作"
                            aria-invalid={Boolean(errors.tags)}
                            onChange={(event) => tagsField.onChange(event.target.value)}
                          />
                          {errors.tags ? (
                            <FieldError id="agent-tags-error">{errors.tags.message}</FieldError>
                          ) : (
                            <FieldDescription id="agent-tags-hint">
                              用逗号分隔，最多 10 个。
                            </FieldDescription>
                          )}
                        </Field>
                        <Field className="gap-1.5 sm:col-span-2" data-disabled="true">
                          <FieldLabel htmlFor="agent-slug">Slug</FieldLabel>
                          <Input
                            id="agent-slug"
                            value={agent.slug}
                            className="font-mono"
                            disabled
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
                            <EmptyState
                              variant="idle"
                              scale="inline"
                              icon={<Plug className="size-4" aria-hidden="true" />}
                              title="尚无可绑定的连接器"
                              action={
                                <Link
                                  to="/servers"
                                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                                >
                                  去连接器创建
                                </Link>
                              }
                            />
                          ) : null}
                          {serverOptions.length > 0 ? (
                            <Combobox
                              disabled={pending || !canBindings}
                              multiple
                              value={serverIdsField.value.filter((id) =>
                                serverOptions.some((option) => option.id === id),
                              )}
                              onValueChange={(picked) => {
                                serverIdsField.onChange([
                                  ...serverIdsField.value.filter(
                                    (id) => !serverOptions.some((option) => option.id === id),
                                  ),
                                  ...picked,
                                ]);
                              }}
                            >
                              <ComboboxChips
                                aria-label="已选连接器"
                                data-disabled={bindingsDisabled}
                                ref={setServerAnchor}
                              >
                                {serverIdsField.value
                                  .map((id) => serverOptions.find((option) => option.id === id))
                                  .filter((option) => option !== undefined)
                                  .map((option) => (
                                    <ComboboxChip
                                      key={option.id}
                                      value={option.id}
                                      aria-label={option.label}
                                    >
                                      {option.label}
                                      <ComboboxChipRemove aria-label={`移除 ${option.label}`} />
                                    </ComboboxChip>
                                  ))}
                                <ComboboxInput
                                  aria-label="MCP Server"
                                  placeholder="搜索并选择 server…"
                                />
                              </ComboboxChips>
                              <ComboboxContent anchor={serverAnchor}>
                                <ComboboxEmpty>没有匹配的 server</ComboboxEmpty>
                                <ComboboxList>
                                  {serverOptions.map((option) => (
                                    <ComboboxItem
                                      key={option.id}
                                      value={option.id}
                                      label={option.label}
                                      keywords={[option.hint]}
                                    >
                                      <span className="min-w-0 flex-1 truncate">
                                        {option.label}
                                      </span>
                                      <StatusBadge tone="mono">{option.tag}</StatusBadge>
                                    </ComboboxItem>
                                  ))}
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
                            <EmptyState
                              variant="idle"
                              scale="inline"
                              icon={<LibraryBig className="size-4" aria-hidden="true" />}
                              title="尚无可绑定的知识库"
                              action={
                                <Link
                                  to="/knowledge"
                                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                                >
                                  去知识库创建
                                </Link>
                              }
                            />
                          ) : null}
                          {knowledgeOptions.length > 0 ? (
                            <Combobox
                              disabled={pending || !canBindings}
                              multiple
                              value={serverIdsField.value.filter((id) => knowledgeIds.has(id))}
                              onValueChange={setKnowledgeIds}
                            >
                              <ComboboxChips
                                aria-label="已选知识库"
                                data-disabled={bindingsDisabled}
                                ref={setKnowledgeAnchor}
                              >
                                {serverIdsField.value
                                  .map((id) => knowledgeOptions.find((option) => option.id === id))
                                  .filter((option) => option !== undefined)
                                  .map((option) => (
                                    <ComboboxChip
                                      key={option.id}
                                      value={option.id}
                                      aria-label={option.label}
                                    >
                                      {option.label}
                                      <ComboboxChipRemove aria-label={`移除 ${option.label}`} />
                                    </ComboboxChip>
                                  ))}
                                <ComboboxInput
                                  aria-label="知识库"
                                  placeholder="搜索并选择知识库…"
                                />
                              </ComboboxChips>
                              <ComboboxContent anchor={knowledgeAnchor}>
                                <ComboboxEmpty>没有匹配的知识库</ComboboxEmpty>
                                <ComboboxList>
                                  {knowledgeOptions.map((option) => (
                                    <ComboboxItem
                                      key={option.id}
                                      value={option.id}
                                      label={option.label}
                                      keywords={[option.slug]}
                                      disabled={
                                        option.disabled && !serverIdsField.value.includes(option.id)
                                      }
                                    >
                                      <span className="min-w-0 flex-1 truncate">
                                        {option.label}
                                      </span>
                                      {option.disabled ? <StatusBadge>已停用</StatusBadge> : null}
                                    </ComboboxItem>
                                  ))}
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
                            <EmptyState
                              variant="idle"
                              scale="inline"
                              icon={<Sparkles className="size-4" aria-hidden="true" />}
                              title="尚无可绑定的技能"
                              action={
                                <Link
                                  to="/skills"
                                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                                >
                                  去技能页创建或安装
                                </Link>
                              }
                            />
                          ) : null}
                          {skillOptions.length > 0 ? (
                            <Combobox
                              disabled={pending || !canBindings}
                              multiple
                              value={skillIdsField.value}
                              onValueChange={skillIdsField.onChange}
                            >
                              <ComboboxChips
                                aria-label="已选技能"
                                data-disabled={bindingsDisabled}
                                ref={setSkillAnchor}
                              >
                                {skillIdsField.value
                                  .map((id) => skillOptions.find((option) => option.id === id))
                                  .filter((option) => option !== undefined)
                                  .map((option) => (
                                    <ComboboxChip
                                      key={option.id}
                                      value={option.id}
                                      aria-label={option.label}
                                    >
                                      {option.label}
                                      <ComboboxChipRemove aria-label={`移除 ${option.label}`} />
                                    </ComboboxChip>
                                  ))}
                                <ComboboxInput aria-label="技能" placeholder="搜索并选择技能…" />
                              </ComboboxChips>
                              <ComboboxContent anchor={skillAnchor}>
                                <ComboboxEmpty>没有匹配的技能</ComboboxEmpty>
                                <ComboboxList>
                                  {skillOptions.map((option) => (
                                    <ComboboxItem
                                      key={option.id}
                                      value={option.id}
                                      label={option.label}
                                      keywords={[option.hint]}
                                    >
                                      <span className="min-w-0 flex-1">
                                        <span className="block truncate">{option.label}</span>
                                        {option.hint ? (
                                          <span className="block truncate text-xs text-muted-foreground">
                                            {option.hint}
                                          </span>
                                        ) : null}
                                      </span>
                                    </ComboboxItem>
                                  ))}
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
                            <EmptyState
                              variant="idle"
                              scale="inline"
                              icon={<Puzzle className="size-4" aria-hidden="true" />}
                              title="尚无可绑定的插件"
                              action={
                                <Link
                                  to="/plugins"
                                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                                >
                                  导入插件
                                </Link>
                              }
                            />
                          ) : (
                            <>
                              <Combobox
                                disabled={pending || !canBindings}
                                multiple
                                value={pluginBindingsField.value.map((binding) => binding.pluginId)}
                                onValueChange={setPluginSelection}
                              >
                                <ComboboxChips
                                  aria-label="已启用插件"
                                  data-disabled={bindingsDisabled}
                                  ref={setPluginAnchor}
                                >
                                  {pluginBindingsField.value
                                    .map((binding) =>
                                      pluginOptions.find(
                                        (option) => option.id === binding.pluginId,
                                      ),
                                    )
                                    .filter((option) => option !== undefined)
                                    .map((option) => (
                                      <ComboboxChip
                                        key={option.id}
                                        value={option.id}
                                        aria-label={option.label}
                                      >
                                        {option.label}
                                        <ComboboxChipRemove aria-label={`移除 ${option.label}`} />
                                      </ComboboxChip>
                                    ))}
                                  <ComboboxInput aria-label="插件" placeholder="搜索并选择插件…" />
                                </ComboboxChips>
                                <ComboboxContent anchor={pluginAnchor}>
                                  <ComboboxEmpty>没有匹配的插件</ComboboxEmpty>
                                  <ComboboxList>
                                    {pluginOptions.map((option) => (
                                      <ComboboxItem
                                        key={option.id}
                                        value={option.id}
                                        label={option.label}
                                        keywords={[option.hint]}
                                      >
                                        <span className="min-w-0 flex-1">
                                          <span className="block truncate">{option.label}</span>
                                          <span className="block truncate text-xs text-muted-foreground">
                                            {option.hint}
                                          </span>
                                        </span>
                                      </ComboboxItem>
                                    ))}
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
                              <EmptyState
                                variant="idle"
                                scale="inline"
                                icon={<Bot className="size-4" aria-hidden="true" />}
                                title="尚无可委派的专家"
                                action={
                                  <Link
                                    to="/agents"
                                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                                  >
                                    新建专家
                                  </Link>
                                }
                              />
                            ) : (
                              <EmptyState
                                variant="idle"
                                scale="inline"
                                icon={<Bot className="size-4" aria-hidden="true" />}
                                title="没有可选的主智能体"
                                description="只有未设父级的智能体才能被委派。"
                              />
                            )
                          ) : (
                            <Combobox
                              disabled={bindingsDisabled}
                              multiple
                              value={subAgentIdsField.value}
                              onValueChange={subAgentIdsField.onChange}
                            >
                              <ComboboxChips
                                aria-label="已选子智能体"
                                data-disabled={bindingsDisabled}
                                ref={setSubAgentAnchor}
                              >
                                {subAgentIdsField.value
                                  .map((id) => subAgentOptions.find((option) => option.id === id))
                                  .filter((option) => option !== undefined)
                                  .map((option) => (
                                    <ComboboxChip
                                      key={option.id}
                                      value={option.id}
                                      aria-label={option.label}
                                    >
                                      {option.label}
                                      <ComboboxChipRemove aria-label={`移除 ${option.label}`} />
                                    </ComboboxChip>
                                  ))}
                                <ComboboxInput
                                  aria-label="子智能体"
                                  placeholder="搜索并选择子智能体…"
                                />
                              </ComboboxChips>
                              <ComboboxContent anchor={subAgentAnchor}>
                                <ComboboxEmpty>没有匹配的智能体</ComboboxEmpty>
                                <ComboboxList>
                                  {subAgentOptions.map((option) => (
                                    <ComboboxItem
                                      key={option.id}
                                      value={option.id}
                                      label={option.label}
                                      keywords={option.hint ? [option.hint] : []}
                                    >
                                      <span className="min-w-0 flex-1">
                                        <span className="block truncate">{option.label}</span>
                                        <span className="block truncate text-xs text-muted-foreground">
                                          {option.hint}
                                        </span>
                                      </span>
                                    </ComboboxItem>
                                  ))}
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
                                  href={api.subAgentFileUrl(agent.id, child.id)}
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
                          平台将绑定连接器的全部工具加入 SDK allowedTools
                          预批准；工具若将审批策略设为「需要审批」，仍须通过服务端审批，可挂起等待批准。请仅绑定可信连接器。
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
                            <SelectTrigger id="agent-perm" className="w-64">
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
                            className="font-mono leading-relaxed"
                            placeholder={'mcp__jsonplaceholder__get_user\nmcp__crm__*'}
                            aria-invalid={allowedInvalid}
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
                              items={runtimeEnvironmentItems}
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
                                  {runtimeEnvironmentItems.map((option) => (
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
                          <NumberInput
                            name={maxTurnsField.name}
                            value={
                              Number.isFinite(maxTurnsField.value) ? maxTurnsField.value : null
                            }
                            onValueChange={(next, details) => {
                              if (details?.reason === 'input-commit') {
                                details.cancel();
                                return;
                              }
                              maxTurnsField.onChange(next ?? Number.NaN);
                            }}
                            step={1}
                            disabled={configDisabled}
                            className="w-40"
                          >
                            <NumberInputGroup>
                              <NumberInputDecrement />
                              <NumberInputControl
                                ref={maxTurnsField.ref}
                                id="agent-turns"
                                inputMode="numeric"
                                onBlur={maxTurnsField.onBlur}
                                aria-invalid={Boolean(errors.maxTurns)}
                              />
                              <NumberInputIncrement />
                            </NumberInputGroup>
                          </NumberInput>
                        </Field>
                        <Field
                          data-disabled={configDisabled}
                          orientation="horizontal"
                          className="gap-3"
                          data-invalid={Boolean(errors.maxBudgetUsd)}
                        >
                          <FieldContent>
                            <FieldLabel htmlFor="agent-budget">单次运行预算上限 (USD)</FieldLabel>
                            <FieldError id="agent-budget-error">
                              {errors.maxBudgetUsd?.message}
                            </FieldError>
                          </FieldContent>
                          <NumberInput
                            name={maxBudgetUsdField.name}
                            value={
                              Number.isFinite(maxBudgetUsdField.value)
                                ? maxBudgetUsdField.value
                                : null
                            }
                            onValueChange={(next, details) => {
                              if (details?.reason === 'input-commit') {
                                details.cancel();
                                return;
                              }
                              maxBudgetUsdField.onChange(next ?? Number.NaN);
                            }}
                            step={0.01}
                            disabled={configDisabled}
                            className="w-40"
                          >
                            <NumberInputGroup>
                              <NumberInputDecrement />
                              <NumberInputControl
                                ref={maxBudgetUsdField.ref}
                                id="agent-budget"
                                inputMode="decimal"
                                onBlur={maxBudgetUsdField.onBlur}
                                aria-invalid={Boolean(errors.maxBudgetUsd)}
                              />
                              <NumberInputIncrement />
                            </NumberInputGroup>
                          </NumberInput>
                        </Field>
                        {agent.parentId === null ? (
                          <>
                            <Field
                              data-disabled={configDisabled}
                              orientation="horizontal"
                              className="gap-3"
                              data-invalid={Boolean(errors.monthlyBudgetUsd)}
                            >
                              <FieldContent>
                                <FieldLabel htmlFor="agent-monthly-budget">
                                  月度预算上限 (USD)
                                </FieldLabel>
                                <FieldDescription id="agent-monthly-budget-hint">
                                  留空表示不限。
                                </FieldDescription>
                                <FieldError id="agent-monthly-budget-error">
                                  {errors.monthlyBudgetUsd?.message}
                                </FieldError>
                              </FieldContent>
                              <NumberInput
                                name={monthlyBudgetUsdField.name}
                                value={
                                  monthlyBudgetUsdField.value !== null &&
                                  Number.isFinite(monthlyBudgetUsdField.value)
                                    ? monthlyBudgetUsdField.value
                                    : null
                                }
                                onValueChange={(next, details) => {
                                  if (details?.reason === 'input-commit') {
                                    details.cancel();
                                    return;
                                  }
                                  monthlyBudgetUsdField.onChange(next);
                                }}
                                step={0.01}
                                disabled={configDisabled}
                                className="w-40"
                              >
                                <NumberInputGroup>
                                  <NumberInputDecrement />
                                  <NumberInputControl
                                    ref={monthlyBudgetUsdField.ref}
                                    id="agent-monthly-budget"
                                    inputMode="decimal"
                                    onBlur={monthlyBudgetUsdField.onBlur}
                                    aria-invalid={Boolean(errors.monthlyBudgetUsd)}
                                  />
                                  <NumberInputIncrement />
                                </NumberInputGroup>
                              </NumberInput>
                            </Field>
                            <Field
                              data-disabled={configDisabled}
                              orientation="horizontal"
                              className="gap-3"
                              data-invalid={Boolean(errors.budgetAlertRatio)}
                            >
                              <FieldContent>
                                <FieldLabel htmlFor="agent-budget-alert">
                                  预算告警阈值 (%)
                                </FieldLabel>
                                <FieldDescription id="agent-budget-alert-hint">
                                  达到上限的该百分比时提醒（0.1–100）。
                                </FieldDescription>
                                <FieldError id="agent-budget-alert-error">
                                  {errors.budgetAlertRatio?.message}
                                </FieldError>
                              </FieldContent>
                              <NumberInput
                                name={budgetAlertRatioField.name}
                                value={
                                  Number.isFinite(budgetAlertRatioField.value)
                                    ? Number((budgetAlertRatioField.value * 100).toPrecision(12))
                                    : null
                                }
                                onValueChange={(next, details) => {
                                  if (details?.reason === 'input-commit') {
                                    details.cancel();
                                    return;
                                  }
                                  budgetAlertRatioField.onChange(
                                    next === null ? Number.NaN : next / 100,
                                  );
                                }}
                                step={0.1}
                                disabled={configDisabled}
                                className="w-40"
                              >
                                <NumberInputGroup>
                                  <NumberInputDecrement />
                                  <NumberInputControl
                                    ref={budgetAlertRatioField.ref}
                                    id="agent-budget-alert"
                                    inputMode="decimal"
                                    onBlur={budgetAlertRatioField.onBlur}
                                    aria-invalid={Boolean(errors.budgetAlertRatio)}
                                  />
                                  <NumberInputIncrement />
                                </NumberInputGroup>
                              </NumberInput>
                            </Field>
                          </>
                        ) : null}
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
                          <NumberInput
                            name={timeoutMsField.name}
                            value={
                              Number.isFinite(timeoutMsField.value) ? timeoutMsField.value : null
                            }
                            onValueChange={(next, details) => {
                              if (details?.reason === 'input-commit') {
                                details.cancel();
                                return;
                              }
                              timeoutMsField.onChange(next ?? Number.NaN);
                            }}
                            step={1000}
                            disabled={configDisabled}
                            className="w-40"
                          >
                            <NumberInputGroup>
                              <NumberInputDecrement />
                              <NumberInputControl
                                ref={timeoutMsField.ref}
                                id="agent-timeout"
                                inputMode="numeric"
                                onBlur={timeoutMsField.onBlur}
                                aria-invalid={Boolean(errors.timeoutMs)}
                              />
                              <NumberInputIncrement />
                            </NumberInputGroup>
                          </NumberInput>
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
              <nav aria-label="工作区文件" className="-mx-2 hidden min-w-0 md:block">
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
                            <ButtonPrimitive
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
                            </ButtonPrimitive>
                          </li>
                        ))}
                    </Fragment>
                  ))}
                </ul>
              </nav>
              <div className="flex min-w-0 flex-col gap-3 md:hidden">
                <Select
                  value={optimisticFileId}
                  items={fileEntries.map((entry) => ({ value: entry.id, label: entry.path }))}
                  onValueChange={(next, details) => {
                    if (next === null) {
                      details.cancel();
                      return;
                    }
                    setActiveFile(next);
                  }}
                >
                  <SelectTrigger className="w-full min-w-0" aria-label="当前文件">
                    <SelectValue className="truncate" placeholder="选择文件" />
                  </SelectTrigger>
                  <SelectContent>
                    {fileGroups.map((group) => (
                      <SelectGroup key={group}>
                        <SelectGroupLabel>{group}</SelectGroupLabel>
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
              onViewChange={(view) => {
                confirmedChildSwitch.current = { instruction: search.instruction, view };
                navigateSearch({ view });
              }}
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
            onInstructionChange={(next) => {
              confirmedChildSwitch.current = { instruction: next, view: search.view };
              navigateSearch({ instruction: next });
            }}
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

      <ConfirmDialog
        open={publishOpen}
        onClose={() => {
          if (!publish.isPending) setPublishOpen(false);
        }}
        title={`发布专家「${agent.name}」`}
        description={
          agent.hasDraft
            ? '当前草稿会生成新的线上版本并启用该专家；已保存的配置会原样发布。'
            : '当前配置会生成新的线上版本并启用该专家。'
        }
        confirmLabel="发布"
        tone="default"
        confirmDisabled={publish.isPending}
        onConfirm={async () => {
          if (publish.isPending) return;
          const saved = await publish.mutateAsync({
            id: agent.id,
            ...(publishNote.trim() === '' ? {} : { note: publishNote.trim() }),
          });
          if (saved.kind === 'detail') loadDraft(saved.agent);
          const publishedVersion = saved.kind === 'detail' ? saved.agent.publishedVersion : null;
          toastSuccess(publishedVersion ? `已发布 v${publishedVersion}` : '已发布');
        }}
      >
        <Field className="gap-1.5" data-disabled={pending || publish.isPending}>
          <FieldLabel htmlFor="agent-publish-note">发布说明（可选）</FieldLabel>
          <Input
            id="agent-publish-note"
            disabled={pending || publish.isPending}
            value={publishNote}
            maxLength={200}
            onChange={(event) => setPublishNote(event.target.value)}
            placeholder="例如：调整系统提示词、绑定新技能"
          />
        </Field>
      </ConfirmDialog>
      <ConfirmDialog
        open={offlineOpen}
        onClose={() => {
          if (!offline.isPending) setOfflineOpen(false);
        }}
        title={`下线专家「${agent.name}」`}
        description="下线后线上不再接受新的对话、频道与定时任务；已发布版本会保留，再次发布即可恢复。"
        confirmLabel="下线"
        tone="default"
        confirmDisabled={offline.isPending}
        onConfirm={async () => {
          if (offline.isPending) return;
          const saved = await offline.mutateAsync(agent.id);
          if (saved.kind === 'detail') loadDraft(saved.agent);
          toastSuccess('专家已下线，再次发布即可恢复');
        }}
      />

      <Dialog
        open={trialOpen}
        onOpenChange={(open) => {
          if (open || trial.isPending) return;
          setTrialOpen(false);
          setTrialPrompt('');
          setTrialResult(null);
        }}
      >
        <DialogShell
          title="试跑当前草稿"
          description="试跑使用当前草稿（不含未保存的表单修改），不影响线上；记忆改动只以提案记录。"
          closeDisabled={trial.isPending}
          footer={
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={trial.isPending}
                onClick={() => {
                  setTrialOpen(false);
                  setTrialPrompt('');
                  setTrialResult(null);
                }}
              >
                关闭
              </Button>
              <Button
                type="submit"
                form="agent-trial-form"
                disabled={trial.isPending || trialPrompt.trim() === ''}
                aria-busy={trial.isPending}
              >
                {trial.isPending ? '启动中…' : '开始试跑'}
              </Button>
            </div>
          }
        >
          <form
            id="agent-trial-form"
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const prompt = trialPrompt.trim();
              if (prompt === '' || trial.isPending) return;
              trial.mutate(
                { id: agent.id, prompt },
                {
                  onSuccess: (result) => {
                    setTrialResult(result);
                    toastSuccess('试跑已开始');
                  },
                  onError: toastError,
                },
              );
            }}
          >
            <Field className="gap-1.5" data-disabled={pending || trial.isPending}>
              <FieldLabel htmlFor="agent-trial-prompt">输入</FieldLabel>
              <Textarea
                id="agent-trial-prompt"
                rows={5}
                value={trialPrompt}
                maxLength={20_000}
                disabled={pending || trial.isPending}
                onChange={(event) => setTrialPrompt(event.target.value)}
                placeholder="例如：用一段话介绍你能帮团队完成什么"
              />
            </Field>
            {trialResult ? (
              <div className="flex flex-col gap-2 rounded-item bg-sunken px-3 py-2.5 text-sm">
                <p>试跑已开始，运行完成后可查看详细过程与产出。</p>
                <div className="flex flex-wrap gap-3">
                  <Link
                    to="/runs/$runId"
                    params={{ runId: trialResult.runId }}
                    className="text-fg underline underline-offset-4"
                  >
                    查看运行
                  </Link>
                  <Link
                    to="/chat"
                    search={{ conversation: trialResult.conversationId }}
                    className="text-fg underline underline-offset-4"
                  >
                    打开会话
                  </Link>
                </div>
              </div>
            ) : null}
          </form>
        </DialogShell>
      </Dialog>

      <Sheet
        side="right"
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
          showCloseButton={false}
          aria-describedby={undefined}
          className="w-full max-w-120! gap-0 p-0 shadow-overlay sm:max-w-120!"
        >
          <div className="flex items-start justify-between gap-4 border-b px-5 py-3.5">
            <div className="min-w-0">
              <SheetTitle className="text-md font-semibold">版本历史</SheetTitle>
              <SheetDescription className="mt-1 text-sm">
                每次保存生成一份快照。回滚会恢复完整定义、生成新版本并设为线上。
              </SheetDescription>
            </div>
            <SheetClose
              disabled={pending}
              render={
                <Button variant="ghost" size="icon-sm" aria-label="关闭" className="-mr-2 -mt-1" />
              }
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
              canRestore={canVersionsRestore && canPublish}
              canEvaluate={canEvaluate}
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
