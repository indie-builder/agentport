import {
  AGENT_PACKAGE_MAX_BYTES,
  AGENT_ROLES,
  type AgentInput,
  type AgentSummary,
} from '@agentport/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Ellipsis, IdCard, Plus, Upload } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import digitalTwinPortrait from '../../assets/agents/digital-twin.png';
import { AgentAvatar, createShowcaseAvatars } from '../../components/agent/agent-avatar.js';
import { BusinessIllustration } from '../../components/business-illustration.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { DialogShell } from '../../components/dialog-shell.js';
import { FilterSelect } from '../../components/filter-select.js';
import {
  Page,
  PageBody,
  PageHeader,
  PageNote,
  PageToolbar,
  PageTopbar,
} from '../../components/page.js';
import { SearchInput } from '../../components/search-input.js';
import { ErrorState, LoadingState } from '../../components/states.js';
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
import { meQuery, useAgents, useDeleteAgent, useRuntimeEnvironments } from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { CreateAgentDialog } from './create-agent-dialog.js';
import { badgeCreatedAt } from './shared.js';

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
            className="w-56 min-w-0"
          />
          <div className="flex min-w-0 flex-wrap items-center gap-2">
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
              className="w-36"
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
      </PageTopbar>
      <PageBody>
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
              icon={<BusinessIllustration name="agents" size="compact" />}
              title="暂无可用专家"
              description="请联系管理员分配。"
            />
          )
        ) : null}
        {agents.data && agents.data.length > 0 && filtered.length === 0 ? (
          <PageNote
            icon={<BusinessIllustration name="search" size="compact" />}
            title="没有匹配的专家"
            action={
              <div className="flex flex-wrap items-center gap-2">
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
            className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,256px),1fr))] gap-4 p-2"
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
                  <Card className="h-full min-h-44">
                    <CardContent className="flex flex-1 flex-col items-center justify-center gap-4">
                      <img
                        src={digitalTwinPortrait}
                        alt=""
                        className="size-16 rounded-full object-cover"
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
                  <Card className="h-full min-h-44 gap-3">
                    <CardHeader className="flex flex-row items-start gap-3">
                      <AgentAvatar agent={agent} />
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <CardTitle>
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
                        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                          <span className="min-w-0 truncate" title={agentRole}>
                            {agentRole}
                          </span>
                          {!agent.enabled ? (
                            <StatusBadge className="shrink-0">已停用</StatusBadge>
                          ) : null}
                        </div>
                      </div>
                      <CardAction>
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
                    </CardHeader>
                    <CardContent className="flex flex-1 flex-col justify-center gap-2">
                      {agent.description.trim() ? (
                        <CardDescription className="line-clamp-2 break-words">
                          {agent.description}
                        </CardDescription>
                      ) : null}
                      {agent.enabled && !canUse ? (
                        <p
                          id={`agent-use-denied-${agent.id}`}
                          className="text-xs text-muted-foreground"
                        >
                          当前账户没有使用该专家的权限，无法开始对话。
                        </p>
                      ) : null}
                    </CardContent>
                    <CardContent className="flex items-center justify-between gap-2">
                      {agent.enabled && canUse ? (
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
          className="flex max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] max-w-[392px] flex-col gap-0 overflow-hidden rounded-none bg-transparent p-0 text-fg shadow-none! ring-0 sm:max-w-[392px]"
        >
          <DialogTitle className="sr-only">
            {badgeAgent ? `${badgeAgent.name} 的工牌` : '数字员工工牌'}
          </DialogTitle>
          {/* 关闭固定在滚动区外，长介绍也不会把它带出视口。 */}
          <div className="flex shrink-0 justify-end px-3 pt-3">
            <DialogClose render={<Button variant="outline" size="sm" />}>关闭</DialogClose>
          </div>
          {/* 滚动区可聚焦，键盘用户才能滚动超出一屏的工牌。 */}
          <section
            // biome-ignore lint/a11y/noNoninteractiveTabindex: 滚动容器必须进入键盘序列才能滚动
            tabIndex={0}
            aria-label="工牌内容"
            className="min-h-0 overflow-y-auto overscroll-contain pb-4"
          >
            {badgeAgent ? <AgentEmployeeBadge agent={badgeAgent} /> : null}
          </section>
        </DialogContent>
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
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => onImport(environmentId === 'match' ? undefined : environmentId)}>
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
    <div className="mx-auto flex w-full max-w-[360px] flex-col items-center">
      {/* 挂绳与扣环是纯装饰插画，信息全部由下方 DOM 文本承担。 */}
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 360 96"
        fill="none"
        className="pointer-events-none relative z-10 block h-24 w-full text-line-strong"
      >
        <path d="M104 -8 L170 62" stroke="currentColor" strokeWidth="10" strokeLinecap="round" />
        <path d="M256 -8 L190 62" stroke="currentColor" strokeWidth="10" strokeLinecap="round" />
        <path
          d="M104 -8 L170 62"
          stroke="var(--color-line)"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M256 -8 L190 62"
          stroke="var(--color-line)"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="180" cy="68" r="10" stroke="currentColor" strokeWidth="5" />
        <rect
          x="164"
          y="76"
          width="32"
          height="20"
          rx="6"
          fill="var(--color-surface)"
          stroke="currentColor"
          strokeWidth="3"
        />
        <path d="M172 84 H188" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      <div className="relative z-0 -mt-1 flex min-h-[480px] w-full flex-col gap-5 rounded-card border border-line bg-surface p-6">
        {/* 卡套插槽，与上方金属夹相接。 */}
        <div
          aria-hidden="true"
          className="absolute -top-1.5 left-1/2 h-3 w-24 -translate-x-1/2 rounded-full border border-line bg-sunken"
        />
        <div className="flex items-center justify-between gap-3 border-b border-line pb-3">
          <span className="font-mono text-xs font-semibold tracking-[0.18em] text-fg">PACE</span>
          <span className="text-xs text-muted-foreground">数字员工</span>
        </div>
        <AgentAvatar
          agent={agent}
          className="size-24 self-center rounded-xl bg-sunken object-cover ring-1 ring-line"
        />
        <div className="flex flex-col items-center gap-1.5 text-center">
          <div className="text-2xl font-medium break-words text-fg [overflow-wrap:anywhere]">
            {agent.name}
          </div>
          <p className="text-sm">
            <span className="sr-only">角色：</span>
            <span className="text-muted-foreground">{role}</span>
            <span aria-hidden="true" className="mx-2 text-line-strong">
              /
            </span>
            <span className="sr-only">状态：</span>
            <span
              className={cn(
                'inline-flex items-center gap-1.5',
                agent.enabled ? 'text-success' : 'text-muted-foreground',
              )}
            >
              <span
                aria-hidden="true"
                className={cn('size-1.5 rounded-full', agent.enabled ? 'bg-success' : 'bg-subtle')}
              />
              {agent.enabled ? '已启用' : '已停用'}
            </span>
          </p>
        </div>
        <p className="text-sm break-words whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
          <span className="sr-only">介绍：</span>
          {agent.description.trim() ? agent.description : '未填写介绍'}
        </p>
        <dl className="mt-auto flex flex-col gap-3 rounded-lg bg-sunken p-4 text-xs">
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground">员工编号</dt>
            <dd className="font-mono break-all text-fg">{agent.id}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground">上岗时间（创建时间）</dt>
            <dd className="text-fg">
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
      </div>
    </div>
  );
}
