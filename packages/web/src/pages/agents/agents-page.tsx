import {
  AGENT_PACKAGE_MAX_BYTES,
  AGENT_ROLES,
  type AgentInput,
  type AgentSummary,
  MARKDOWN_FILE_MAX_BYTES,
} from '@agentport/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import {
  Archive,
  ArchiveRestore,
  Calendar,
  EllipsisVertical,
  IdCard,
  Plus,
  SlidersHorizontal,
  Star,
  Trash2,
  Upload,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import digitalTwinPortrait from '../../assets/agents/digital-twin.png';
import { AgentAvatar, createShowcaseAvatars } from '../../components/agent/agent-avatar.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { DialogShell } from '../../components/dialog-shell.js';
import { FilterPopover } from '../../components/filter-popover.js';
import { FilterSelect } from '../../components/filter-select.js';
import { Page, PageBody, PageHeader, PageToolbar, PageTopbar } from '../../components/page.js';
import { SearchInput } from '../../components/search-input.js';
import {
  type EmptyFilterChip,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button, buttonVariants } from '../../components/ui/button.js';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/card.js';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../../components/ui/dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import { Field, FieldError, FieldGroup, FieldLabel } from '../../components/ui/field.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { can } from '../../lib/access.js';
import { api } from '../../lib/api.js';
import { cn } from '../../lib/cn.js';
import { useDialogClose } from '../../lib/dialog-guard.js';
import {
  AGENTS_QUERY_KEY,
  meQuery,
  OVERVIEW_QUERY_KEY,
  SERVERS_QUERY_KEY,
  SKILLS_QUERY_KEY,
  useAgentsBrowse,
  useAgentTags,
  useArchiveAgent,
  useDeleteAgent,
  useDrainPages,
  useRestoreAgent,
  useRuntimeEnvironments,
  useSetAgentFavorite,
} from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { CreateAgentDialog } from './create-agent-dialog.js';
import { badgeCreatedAt } from './shared.js';

export function AgentsPage() {
  const me = useQuery(meQuery);
  const canCreate = can(me.data, 'agents.create');
  const canImport = can(me.data, 'agents.import');
  const canUse = can(me.data, 'agents.use');
  const canDeleteAny = can(me.data, 'agents.delete');
  const currentBusinessId = me.data?.authenticated ? me.data.user.businessId : '';
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const search = useSearch({ from: '/_shell/agents/' });
  const query = search.q ?? '';
  const sort = search.order === 'recent' ? 'recent' : (search.sort ?? 'newest');
  const status = search.status ?? 'enabled';
  const role = search.role ?? '';
  const lifecycle = search.lifecycle ?? 'active';
  const tag = search.tag ?? '';
  const favoriteOnly = search.favorite === '1';
  const agents = useAgentsBrowse({
    status: lifecycle,
    ...(query.trim() === '' ? {} : { q: query.trim() }),
    ...(tag === '' ? {} : { tag }),
    ...(favoriteOnly ? { favorite: 'true' as const } : {}),
    ...(sort === 'name' || sort === 'recent' ? { sort } : {}),
  });
  const agentTags = useAgentTags();
  const favorite = useSetAgentFavorite();
  const archive = useArchiveAgent();
  const restore = useRestoreAgent();
  const [creating, setCreating] = useState(false);
  const [createRole, setCreateRole] = useState<AgentInput['role'] | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [pendingImport, setPendingImport] = useState<File | null>(null);
  const [pendingFavoriteIds, setPendingFavoriteIds] = useState<Set<string>>(() => new Set());
  const [badgeId, setBadgeId] = useState<string | null>(null);
  const badgeTriggerRef = useRef<HTMLElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const editorTriggerRef = useRef<HTMLElement | null>(null);
  const remove = useDeleteAgent();
  const runtimeEnvironments = useRuntimeEnvironments();
  useDrainPages(runtimeEnvironments);
  const hasRoleData = (agents.data ?? []).some((agent) => agent.role !== undefined);
  const activeFilterCount =
    (lifecycle === 'active' ? 0 : 1) +
    (status === 'enabled' ? 0 : 1) +
    (role === '' ? 0 : 1) +
    (tag === '' ? 0 : 1);

  const importFile = async (file: File, runtimeEnvironmentId?: string): Promise<void> => {
    setImporting(true);
    try {
      const isMarkdown = file.name.toLowerCase().endsWith('.md');
      if (file.size > (isMarkdown ? MARKDOWN_FILE_MAX_BYTES : AGENT_PACKAGE_MAX_BYTES)) {
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
        [AGENTS_QUERY_KEY[0], SERVERS_QUERY_KEY[0], SKILLS_QUERY_KEY[0], OVERVIEW_QUERY_KEY[0]].map(
          (key) => queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      );
      const suffix = result.warnings.length > 0 ? `，${result.warnings.length} 条提示` : '';
      toastSuccess(`已导入「${result.agent.name}」${suffix}`);
      void navigate({
        to: '/agents/$agentId',
        params: { agentId: result.agent.id },
        search: { backTo: location.href },
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
    return (agents.data ?? []).filter(
      (agent) =>
        (lifecycle !== 'active' || status === 'all' || agent.enabled === (status === 'enabled')) &&
        (!hasRoleData || !role || (agent.role?.trim() || '通用助手') === role) &&
        (needle === '' ||
          [agent.name, agent.slug, agent.description, agent.role?.trim() || '通用助手']
            .join(' ')
            .toLowerCase()
            .includes(needle)),
    );
  }, [agents.data, lifecycle, status, role, hasRoleData, query]);

  const openAgent = (id: string): void => {
    void navigate({
      to: '/agents/$agentId',
      params: { agentId: id },
      search: { backTo: location.href },
    });
  };

  const badgeAgent = badgeId
    ? ((agents.data ?? []).find((agent) => agent.id === badgeId) ?? null)
    : null;

  const activeFilters: EmptyFilterChip[] = [
    ...(query.trim()
      ? [
          {
            key: 'q',
            label: '关键词',
            value: query.trim(),
            onRemove: () =>
              void navigate({ to: '/agents', search: { ...search, q: undefined }, replace: true }),
          },
        ]
      : []),
    ...(lifecycle !== 'active'
      ? [
          {
            key: 'lifecycle',
            label: '生命周期',
            value: lifecycle === 'archived' ? '已归档' : '已删除',
            onRemove: () =>
              void navigate({ to: '/agents', search: { ...search, lifecycle: undefined } }),
          },
        ]
      : []),
    ...(lifecycle === 'active' && status !== 'enabled'
      ? [
          {
            key: 'status',
            label: '状态',
            value: status === 'all' ? '全部' : '已停用',
            onRemove: () =>
              void navigate({ to: '/agents', search: { ...search, status: undefined } }),
          },
        ]
      : []),
    ...(role
      ? [
          {
            key: 'role',
            label: '角色',
            value: role,
            onRemove: () =>
              void navigate({ to: '/agents', search: { ...search, role: undefined } }),
          },
        ]
      : []),
    ...(tag
      ? [
          {
            key: 'tag',
            label: '标签',
            value: tag,
            onRemove: () => void navigate({ to: '/agents', search: { ...search, tag: undefined } }),
          },
        ]
      : []),
    ...(favoriteOnly
      ? [
          {
            key: 'favorite',
            label: '收藏',
            value: '仅看收藏',
            onRemove: () =>
              void navigate({ to: '/agents', search: { ...search, favorite: undefined } }),
          },
        ]
      : []),
  ];

  return (
    <Page>
      <PageTopbar>
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
                  if (file.name.toLowerCase().endsWith('.md')) void importFile(file);
                  else setPendingImport(file);
                }}
              />
              <Button
                ref={createButtonRef}
                disabled={importing}
                {...(canCreate ? {} : { className: 'hidden' })}
                onClick={(event) => {
                  editorTriggerRef.current = event.currentTarget;
                  setCreateRole(role || '通用助手');
                  setCreating(true);
                }}
              >
                <Plus data-icon="inline-start" /> 新建专家
              </Button>
              {canCreate && canImport ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        ref={moreTriggerRef}
                        variant="ghost"
                        size="icon"
                        aria-label="更多操作"
                        title="更多操作"
                        disabled={importing}
                        aria-busy={importing}
                      >
                        <EllipsisVertical aria-hidden="true" />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end" sideOffset={4}>
                    <DropdownMenuGroup>
                      <DropdownMenuItem
                        title="导入专家 ZIP 或 agent.md"
                        disabled={importing}
                        onSelect={() => {
                          editorTriggerRef.current = moreTriggerRef.current;
                          fileInput.current?.click();
                        }}
                      >
                        <Upload className="size-4" aria-hidden="true" />
                        {importing ? '导入中…' : '导入专家'}
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
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
            className="w-56 min-w-0"
          />
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <FilterPopover activeCount={activeFilterCount}>
              <FilterSelect
                value={lifecycle}
                onValueChange={(next) => {
                  if (next !== 'active' && next !== 'archived' && next !== 'deleted') return;
                  void navigate({
                    to: '/agents',
                    search: { ...search, lifecycle: next === 'active' ? undefined : next },
                  });
                }}
                options={[
                  { value: 'active', label: '进行中' },
                  { value: 'archived', label: '已归档' },
                  { value: 'deleted', label: '已删除' },
                ]}
                label="按生命周期筛选"
                className="w-full"
              />
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
                className="w-full"
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
                  className="w-full"
                />
              ) : null}
              <FilterSelect
                value={tag}
                onValueChange={(next) =>
                  void navigate({
                    to: '/agents',
                    search: { ...search, tag: next === '' ? undefined : next },
                  })
                }
                options={[
                  { value: '', label: '全部标签' },
                  ...(agentTags.data?.items ?? []).map((item) => ({ value: item, label: item })),
                ]}
                label="按标签筛选"
                className="w-full"
              />
            </FilterPopover>
            <Button
              variant={favoriteOnly ? 'secondary' : 'outline'}
              aria-pressed={favoriteOnly}
              onClick={() =>
                void navigate({
                  to: '/agents',
                  search: { ...search, favorite: favoriteOnly ? undefined : '1' },
                })
              }
            >
              <Star
                data-icon="inline-start"
                className={favoriteOnly ? 'fill-current' : undefined}
              />
              收藏
            </Button>
            <FilterSelect
              value={sort}
              onValueChange={(next) => {
                if (next !== 'newest' && next !== 'name' && next !== 'recent') return;
                void navigate({
                  to: '/agents',
                  search:
                    next === 'recent'
                      ? { ...search, sort: undefined, order: 'recent' }
                      : { ...search, order: undefined, sort: next === 'newest' ? undefined : next },
                });
              }}
              options={[
                { value: 'newest', label: '最新创建' },
                { value: 'recent', label: '最近使用' },
                { value: 'name', label: '名称排序' },
              ]}
              label="专家排序"
              className="w-32"
            />
          </div>
        </PageToolbar>
      </PageTopbar>
      <PageBody>
        {agents.isPending ? <LoadingState rows={4} layout="cards" /> : null}
        {agents.isError && !agents.isFetchNextPageError ? (
          <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
        ) : null}
        {agents.data &&
        !agents.hasNextPage &&
        agents.data.length === 0 &&
        !query.trim() &&
        !tag &&
        !favoriteOnly ? (
          me.isPending ? (
            <LoadingState rows={4} layout="cards" />
          ) : me.isError ? (
            <ErrorState error={me.error} onRetry={() => void me.refetch()} />
          ) : canCreate && lifecycle === 'active' ? null : lifecycle === 'active' ? (
            <EmptyState
              variant="permission"
              scale="page"
              title="还没有可用的专家"
              description="管理员为你分配专家或开启创建权限后，会显示在这里。"
              secondaryAction={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void queryClient.invalidateQueries({ queryKey: meQuery.queryKey })}
                >
                  刷新权限
                </Button>
              }
            />
          ) : (
            <EmptyState
              variant="clear"
              scale="section"
              icon={
                lifecycle === 'archived' ? (
                  <Archive className="size-5" aria-hidden="true" />
                ) : (
                  <Trash2 className="size-5" aria-hidden="true" />
                )
              }
              title={lifecycle === 'archived' ? '没有已归档的专家' : '回收站为空'}
              secondaryAction={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void navigate({ to: '/agents', search: { ...search, lifecycle: undefined } })
                  }
                >
                  返回使用中的专家
                </Button>
              }
            />
          )
        ) : null}
        {agents.data &&
        !agents.hasNextPage &&
        filtered.length === 0 &&
        (agents.data.length > 0 || query.trim() || tag || favoriteOnly) ? (
          <EmptyState
            variant="filter"
            scale="section"
            title="没有匹配的专家"
            activeFilters={activeFilters}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void navigate({
                    to: '/agents',
                    search: {
                      ...search,
                      q: undefined,
                      role: undefined,
                      tag: undefined,
                      favorite: undefined,
                      lifecycle: undefined,
                      order: undefined,
                      status: undefined,
                    },
                  })
                }
              >
                清除全部筛选
              </Button>
            }
          />
        ) : null}

        {agents.data && ((canCreate && lifecycle === 'active') || filtered.length > 0) ? (
          <ul
            aria-label="专家列表"
            className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,256px),1fr))] gap-4 pt-2"
          >
            {canCreate && lifecycle === 'active' ? (
              <>
                <li className="min-w-0">
                  <button
                    type="button"
                    aria-label="新建专家"
                    disabled={importing}
                    onClick={(event) => {
                      editorTriggerRef.current = event.currentTarget;
                      setCreateRole('通用助手');
                      setCreating(true);
                    }}
                    className="agent-create-fan h-full min-h-44 w-full disabled:pointer-events-none disabled:opacity-60"
                  >
                    <span className="agent-create-fan__art scale-90" aria-hidden="true">
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
                  <button
                    type="button"
                    aria-label="创建数字分身"
                    disabled={importing}
                    onClick={(event) => {
                      editorTriggerRef.current = event.currentTarget;
                      setCreateRole('数字分身');
                      setCreating(true);
                    }}
                    className="agent-create-fan h-full min-h-44 w-full disabled:pointer-events-none disabled:opacity-60"
                  >
                    <span
                      className="agent-create-fan__art flex items-center justify-center"
                      aria-hidden="true"
                    >
                      <img
                        src={digitalTwinPortrait}
                        alt=""
                        className="agent-create-fan__portrait size-16 rounded-full object-cover"
                      />
                    </span>
                    <span className="agent-create-fan__label">
                      <Plus aria-hidden="true" />
                      <span>创建数字分身</span>
                    </span>
                  </button>
                </li>
              </>
            ) : null}
            {filtered.map((agent) => {
              const agentRole = agent.role?.trim() || '通用助手';
              const canDelete =
                canDeleteAny &&
                (agent.ownerBusinessId === currentBusinessId || can(me.data, 'agents.transfer'));
              const isArchived = agent.archivedAt != null;
              const isDeleted = agent.deletedAt != null;
              const tags = agent.tags ?? [];
              const visibleTags = tags.slice(0, 3);
              const overflowTags = tags.slice(3);
              const lastUsedAt = formatLastUsed(agent.lastUsedAt);
              const unavailableTitle = isDeleted
                ? '专家已删除，恢复后才能开始对话'
                : isArchived
                  ? '专家已归档，恢复后才能开始对话'
                  : agent.enabled
                    ? '当前账户没有使用该专家的权限'
                    : '专家已停用，启用后才能开始对话';
              return (
                <li key={agent.id} className="min-w-0">
                  <Card className="h-full min-h-44 gap-3">
                    <CardHeader className="flex flex-row items-start gap-3">
                      <AgentAvatar agent={agent} />
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <CardTitle>
                          <h2 className="min-w-0">
                            {isArchived || isDeleted ? (
                              <span className="block min-w-0 truncate text-base font-medium text-fg">
                                {agent.name}
                              </span>
                            ) : (
                              <Link
                                to="/agents/$agentId"
                                params={{ agentId: agent.id }}
                                search={{ backTo: location.href }}
                                title={agent.name}
                                disabled={importing}
                                className="block min-w-0 truncate rounded-item text-base font-medium text-fg transition-colors hover:text-primary hover:underline hover:underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                {agent.name}
                              </Link>
                            )}
                          </h2>
                        </CardTitle>
                        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                          <span className="min-w-0 truncate" title={agentRole}>
                            {agentRole}
                          </span>
                          {!agent.enabled && !isArchived && !isDeleted ? (
                            <StatusBadge className="shrink-0">已停用</StatusBadge>
                          ) : null}
                          {isArchived ? (
                            <StatusBadge className="shrink-0">已归档</StatusBadge>
                          ) : null}
                          {isDeleted ? (
                            <StatusBadge className="shrink-0">已删除</StatusBadge>
                          ) : null}
                        </div>
                        {visibleTags.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {visibleTags.map((item) => (
                              <span
                                key={item}
                                className="rounded-tag bg-chip px-1.5 py-0.5 text-2xs text-muted-foreground"
                              >
                                {item}
                              </span>
                            ))}
                            {overflowTags.length > 0 ? (
                              <span
                                title={overflowTags.join('、')}
                                className="rounded-tag bg-chip px-1.5 py-0.5 text-2xs text-muted-foreground"
                              >
                                +{overflowTags.length}
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      <CardAction className="flex items-center gap-1 self-start">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={
                            agent.isFavorite ? `取消收藏 ${agent.name}` : `收藏 ${agent.name}`
                          }
                          aria-pressed={agent.isFavorite}
                          disabled={pendingFavoriteIds.has(agent.id) || isArchived || isDeleted}
                          onClick={() => {
                            if (pendingFavoriteIds.has(agent.id)) return;
                            setPendingFavoriteIds((prev) => {
                              const next = new Set(prev);
                              next.add(agent.id);
                              return next;
                            });
                            void favorite
                              .mutateAsync({ id: agent.id, favorite: !agent.isFavorite })
                              .catch(toastError)
                              .finally(() => {
                                setPendingFavoriteIds((prev) => {
                                  const next = new Set(prev);
                                  next.delete(agent.id);
                                  return next;
                                });
                              });
                          }}
                        >
                          <Star className={agent.isFavorite ? 'fill-current' : undefined} />
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`操作 ${agent.name}`}
                                onFocus={(event) => {
                                  editorTriggerRef.current = event.currentTarget;
                                }}
                                onClick={(event) => {
                                  editorTriggerRef.current = event.currentTarget;
                                }}
                              >
                                <EllipsisVertical />
                              </Button>
                            }
                          />
                          <DropdownMenuContent align="end">
                            <DropdownMenuGroup>
                              {!isArchived && !isDeleted ? (
                                <DropdownMenuItem
                                  disabled={importing}
                                  onSelect={() =>
                                    void navigate({
                                      to: '/agents/$agentId',
                                      params: { agentId: agent.id },
                                      search: { tab: 'config', backTo: location.href },
                                    })
                                  }
                                >
                                  <SlidersHorizontal className="size-4" /> 配置
                                </DropdownMenuItem>
                              ) : null}
                              {canDelete && (isArchived || isDeleted) ? (
                                <DropdownMenuItem
                                  disabled={restore.isPending}
                                  onSelect={() =>
                                    restore.mutate(agent.id, {
                                      onSuccess: () => toastSuccess('已恢复专家'),
                                      onError: toastError,
                                    })
                                  }
                                >
                                  <ArchiveRestore className="size-4" /> 恢复
                                </DropdownMenuItem>
                              ) : null}
                              {canDelete && !isArchived && !isDeleted ? (
                                <DropdownMenuItem
                                  disabled={archive.isPending}
                                  onSelect={() =>
                                    archive.mutate(agent.id, {
                                      onSuccess: () => toastSuccess('已归档专家'),
                                      onError: toastError,
                                    })
                                  }
                                >
                                  <Archive className="size-4" /> 归档
                                </DropdownMenuItem>
                              ) : null}
                              {canDelete && !isDeleted ? (
                                <DropdownMenuItem
                                  variant="destructive"
                                  onSelect={() => setDeleting(agent)}
                                >
                                  <Trash2 className="size-4" /> 删除
                                </DropdownMenuItem>
                              ) : null}
                            </DropdownMenuGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </CardAction>
                    </CardHeader>
                    <CardContent className="flex flex-1 flex-col justify-center gap-2">
                      {agent.description.trim() ? (
                        <CardDescription className="line-clamp-2 break-words">
                          {agent.description}
                        </CardDescription>
                      ) : null}
                      {agent.enabled && !canUse && lifecycle === 'active' ? (
                        <p
                          id={`agent-use-denied-${agent.id}`}
                          className="text-xs text-muted-foreground"
                        >
                          当前账户没有使用该专家的权限，无法开始对话。
                        </p>
                      ) : null}
                      {lastUsedAt ? (
                        <p className="text-xs text-muted-foreground">最近使用 {lastUsedAt}</p>
                      ) : null}
                    </CardContent>
                    <CardContent className="flex items-center justify-between gap-2 [&>:last-child[data-variant=ghost]]:-mr-2.5">
                      {lifecycle === 'active' && agent.enabled && canUse ? (
                        <Link
                          to="/chat"
                          search={{ agent: agent.id }}
                          disabled={importing}
                          aria-label={`与 ${agent.name} 开始对话`}
                          className={buttonVariants({ variant: 'secondary' })}
                        >
                          开始对话
                        </Link>
                      ) : (
                        <Button
                          variant="outline"
                          disabled
                          aria-label={`与 ${agent.name} 开始对话`}
                          aria-describedby={
                            lifecycle === 'active' && agent.enabled
                              ? `agent-use-denied-${agent.id}`
                              : undefined
                          }
                          title={unavailableTitle}
                        >
                          开始对话
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        aria-label={`查看 ${agent.name} 工牌`}
                        title="数字员工工牌"
                        onClick={(event) => {
                          badgeTriggerRef.current = event.currentTarget;
                          setBadgeId(agent.id);
                        }}
                      >
                        <IdCard data-icon="inline-start" />
                        工牌
                      </Button>
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
        ) : null}
        {agents.isFetchNextPageError ? (
          <div className="flex justify-center">
            <ErrorState
              error={agents.error}
              title="列表没有加载完"
              onRetry={() => void agents.fetchNextPage()}
            />
          </div>
        ) : agents.hasNextPage ? (
          <div className="flex justify-center">
            <Button
              variant="outline"
              size="sm"
              disabled={agents.isFetchingNextPage}
              onClick={() => void agents.fetchNextPage()}
            >
              {agents.isFetchingNextPage ? '加载中…' : '加载更多'}
            </Button>
          </div>
        ) : null}
      </PageBody>
      <Dialog
        open={badgeAgent !== null}
        onOpenChange={(open) => {
          if (!open) setBadgeId(null);
        }}
      >
        <DialogContent
          showCloseButton={false}
          finalFocus={() =>
            badgeTriggerRef.current?.isConnected
              ? badgeTriggerRef.current
              : document.getElementById('agents-search')
          }
          className="pointer-events-none top-0 left-1/2 flex h-[100dvh] max-h-none w-[calc(100vw-32px)] max-w-[520px] origin-top -translate-x-1/2 translate-y-0 flex-col gap-0 overflow-hidden rounded-none bg-transparent p-0 text-fg shadow-none! ring-0 sm:max-w-[520px]"
        >
          <DialogTitle className="sr-only">
            {badgeAgent ? `${badgeAgent.name} 的工牌` : '数字员工工牌'}
          </DialogTitle>
          <DialogClose
            render={
              <Button
                variant="outline"
                size="sm"
                className="pointer-events-auto absolute right-4 top-4 z-20 bg-surface"
              />
            }
          >
            关闭
          </DialogClose>
          <div className="pointer-events-none flex min-h-0 w-full flex-1 flex-col items-center overscroll-contain">
            {badgeAgent ? <AgentEmployeeBadge agent={badgeAgent} /> : null}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`删除专家「${deleting?.name ?? ''}」`}
        description="专家会移入「已删除」并停止被发现，会话、消息与绑定关系都会保留，可随时恢复。"
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
  onClose: onClosed,
  onImport,
}: {
  file: File;
  environments: Array<{ id: string; name: string }>;
  environmentsError: boolean;
  finalFocus: () => HTMLElement | null;
  onClose: () => void;
  onImport: (runtimeEnvironmentId: string | undefined) => void;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const [environmentId, setEnvironmentId] = useState('match');
  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={(next) => (next ? undefined : onClose())}
    >
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
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            onClick={() =>
              dialog.finish(() => onImport(environmentId === 'match' ? undefined : environmentId))
            }
          >
            导入
          </Button>
        </div>
      </DialogShell>
    </Dialog>
  );
}

const lastUsedFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function formatLastUsed(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : lastUsedFormatter.format(date);
}

function AgentEmployeeBadge({ agent }: { agent: AgentSummary }) {
  const role = agent.role?.trim() || '通用助手';
  const createdAt = badgeCreatedAt(agent.createdAt);
  return (
    <div className="badge-swing pointer-events-none flex h-full w-full flex-col items-center">
      <div aria-hidden="true" className="flex shrink-0 flex-col items-center">
        <div className="flex h-[22vh] min-h-24 w-24 flex-col items-center rounded-b-xl bg-badge-accent pt-4">
          <span className="text-xs font-semibold tracking-[0.22em] text-white/95 [writing-mode:vertical-rl]">
            PACE
          </span>
        </div>
        <svg
          viewBox="0 0 64 44"
          className="relative z-10 -mt-1 h-11 w-16 text-line-strong"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="32" cy="12" r="9" stroke="currentColor" strokeWidth="5" />
          <rect
            x="18"
            y="20"
            width="28"
            height="16"
            rx="5"
            fill="var(--color-surface)"
            stroke="currentColor"
            strokeWidth="3"
          />
          <path d="M25 28 H39" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      </div>
      <section
        // biome-ignore lint/a11y/noNoninteractiveTabindex: 滚动容器必须进入键盘序列才能滚动
        tabIndex={0}
        aria-label="工牌内容"
        className="pointer-events-auto flex min-h-0 w-full flex-1 items-start justify-center overflow-y-auto overscroll-contain px-6 pt-1.5 pb-8"
      >
        <div className="relative z-0 flex min-h-[480px] w-full max-w-[360px] flex-col gap-5 rounded-[24px] border border-line bg-surface p-6 shadow-sm">
          <div
            aria-hidden="true"
            className="absolute -top-1.5 left-1/2 h-3 w-24 -translate-x-1/2 rounded-full border border-line bg-sunken"
          />
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-fg">
              <img src="/brand/pace-mark.svg" alt="" aria-hidden="true" className="size-6" />
              <span className="text-sm font-semibold tracking-[0.16em]">PACE</span>
            </div>
            <div className="flex items-center gap-3">
              <div aria-hidden="true" className="grid grid-cols-3 gap-1.5">
                <span className="size-1 rounded-full bg-badge-accent/35" />
                <span className="size-1 rounded-full bg-badge-accent/35" />
                <span className="size-1 rounded-full bg-badge-accent/35" />
                <span className="size-1 rounded-full bg-badge-accent/35" />
                <span className="size-1 rounded-full bg-badge-accent/35" />
                <span className="size-1 rounded-full bg-badge-accent/35" />
                <span className="size-1 rounded-full bg-badge-accent/35" />
                <span className="size-1 rounded-full bg-badge-accent/35" />
                <span className="size-1 rounded-full bg-badge-accent/35" />
              </div>
              <span className="text-xs text-muted-foreground">数字员工</span>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>工号</span>
              <span className="min-w-0 font-mono break-all text-fg">{agent.id}</span>
              <span aria-hidden="true" className="text-line-strong">
                ·
              </span>
              <span className="sr-only">状态：</span>
              <span
                className={cn(
                  'inline-flex items-center gap-1.5',
                  agent.enabled ? 'text-badge-accent' : 'text-muted-foreground',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'size-1.5 rounded-full',
                    agent.enabled ? 'bg-badge-accent' : 'bg-subtle',
                  )}
                />
                {agent.enabled ? '在职' : '已停用'}
              </span>
            </div>
            <div aria-hidden="true" className="h-0.5 w-8 rounded-full bg-badge-accent" />
          </div>
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="text-3xl font-semibold tracking-tight break-words text-fg [overflow-wrap:anywhere]">
                {agent.name}
              </div>
              <p className="text-base break-words text-muted-foreground [overflow-wrap:anywhere]">
                <span className="sr-only">角色：</span>
                {role}
              </p>
            </div>
            <AgentAvatar
              agent={agent}
              className="size-24 rounded-[18px] bg-badge-accent-soft object-cover"
            />
          </div>
          <div className="rounded-dialog bg-badge-accent-soft p-4">
            <div className="text-sm font-medium text-badge-accent">职责简介</div>
            <p className="mt-1.5 text-base break-words whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
              <span className="sr-only">介绍：</span>
              {agent.description.trim() || '未填写介绍'}
            </p>
          </div>
          <dl className="flex flex-col text-base">
            <div className="flex items-center justify-between gap-4 border-t border-line py-3">
              <dt className="inline-flex items-center gap-2 text-muted-foreground">
                <Calendar aria-hidden="true" className="text-badge-accent" />
                入职日期
              </dt>
              <dd className="min-w-0 text-right break-words text-fg">
                {createdAt.iso ? (
                  <time dateTime={createdAt.iso} title={createdAt.iso}>
                    {createdAt.label}
                  </time>
                ) : (
                  createdAt.label
                )}
              </dd>
            </div>
          </dl>
          <div className="mt-auto flex flex-col gap-1 border-t border-line pt-4">
            <p className="text-xs text-muted-foreground">
              本工牌信息同步自智能体定义，随身份信息更新。
            </p>
            <span className="font-mono text-2xs break-all text-muted-foreground">{agent.id}</span>
          </div>
        </div>
      </section>
    </div>
  );
}
