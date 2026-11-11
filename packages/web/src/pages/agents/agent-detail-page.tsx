import type { Agent, AgentSummary, PermissionId } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useBlocker,
  useLocation,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { ArrowLeft, Bot, Ellipsis, Trash2 } from 'lucide-react';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { AgentAvatar } from '../../components/agent-avatar.js';
import { AgentOverview } from '../../components/agent-overview.js';
import { CodeBlock } from '../../components/code-block.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { DialogShell } from '../../components/dialog-shell.js';
import { MemoryPanel } from '../../components/memory-panel.js';
import { Page, PageBody, PageHeader, PageNote, PageTopbar } from '../../components/page.js';
import { ErrorState, LoadingState } from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button, buttonVariants } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import { Tabs, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { can, hasAnyGrant } from '../../lib/access.js';
import { cn } from '../../lib/cn.js';
import {
  type AgentInstruction,
  type MemoryView,
  agentTabs as tabItems,
} from '../../lib/detail-tabs.js';
import {
  meQuery,
  useAgentAccess,
  useAgentDetail,
  useAgentFiles,
  useAgentSummary,
  useDeleteAgent,
  useUpdateAgent,
} from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { AgentEditor } from './agent-editor.js';
import { AgentInstructions } from './agent-instructions.js';
import { AgentMembersDialog, TransferAgentDialog } from './agent-member-dialogs.js';
import {
  activeAgentTab,
  activeInstruction,
  asInstruction,
  baseFileEntries,
  canOpenTab,
  listWorkspaceFiles,
  normalizeTab,
  type TabId,
} from './shared.js';

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
  const search = useSearch({ from: '/_shell/agents/$agentId' });
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
        <PageTopbar>
          <PageHeader title="专家" />
        </PageTopbar>
        <PageBody>
          <LoadingState rows={6} />
        </PageBody>
      </Page>
    );
  }

  // access 未返回前先保持加载态，避免把管理员短暂当成只能使用的普通用户。
  if (!current || access.isPending) {
    if (loading) {
      return (
        <Page>
          <PageTopbar>
            <PageHeader title="专家" />
          </PageTopbar>
          <PageBody>
            <LoadingState rows={6} />
          </PageBody>
        </Page>
      );
    }
    if (failed) {
      return (
        <Page>
          <PageTopbar>
            <PageHeader title="专家" />
          </PageTopbar>
          <PageBody>
            <ErrorState
              error={summary.error ?? access.error ?? detail.error}
              onRetry={() => {
                void summary.refetch();
                void access.refetch();
                if (canReadConfig) void detail.refetch();
              }}
            />
          </PageBody>
        </Page>
      );
    }
    return (
      <Page>
        <PageTopbar>
          <PageHeader title="专家" />
        </PageTopbar>
        <PageBody>
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
        </PageBody>
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
  // 配置任务已由工具栏承载删除；页头只在工具栏确实渲染（详情已就绪）时让出入口。
  const configTabActive =
    full !== null && canReadConfig && activeAgentTab(search.tab, permissions) === 'config';
  const deleteInHeader = canDelete && !configTabActive;

  return (
    <Page>
      <PageTopbar>
        <PageHeader
          leading={<AgentAvatar agent={current} className="size-11" />}
          title={current.name}
          eyebrow={
            roleLabel ? (
              <StatusBadge className="max-w-full whitespace-normal break-words bg-chip">
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
              {canManageMembers || canTransfer || deleteInHeader ? (
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
                      {deleteInHeader ? (
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
          <p id="agent-use-denied" className="text-sm text-muted-foreground">
            当前账户没有使用该专家的权限，无法开始对话。
          </p>
        ) : null}
      </PageTopbar>
      {full ? (
        <AgentEditor
          key={agentId}
          agent={full}
          permissions={permissions}
          canViewRuns={canViewRuns}
          deletePending={remove.isPending}
          onPendingChange={setEditorPending}
          onDeleteRequest={() => setDeleting(true)}
        />
      ) : (
        <RestrictedAgentTabs
          key={agentId}
          agentId={agentId}
          agent={current}
          canViewRuns={canViewRuns}
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

function RestrictedAgentTabs({
  agentId,
  agent,
  canViewRuns,
  permissions,
  onPendingChange,
  externalPending = false,
  settleNavigationRef,
}: {
  agentId: string;
  agent: Agent | AgentSummary;
  canViewRuns: boolean;
  permissions: readonly PermissionId[];
  onPendingChange: (pending: boolean) => void;
  externalPending?: boolean;
  settleNavigationRef: RefObject<(() => void) | null>;
}) {
  const available = tabItems.filter(
    (item) => item.id !== 'config' && canOpenTab(item.id, permissions),
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

  const permittedTab = (value: unknown): TabId => {
    const requested = normalizeTab(value);
    return available.some((item) => item.id === requested)
      ? (requested as TabId)
      : (available[0]?.id ?? 'overview');
  };
  const tab = permittedTab(search.tab);
  const instruction = activeInstruction(
    asInstruction(search.tab) ?? search.instruction,
    permissions,
  );
  // 旧书签 tab=rules|styles 改写为 instructions + instruction，replace 不堆历史。
  useEffect(() => {
    const legacy = asInstruction(search.tab);
    if (!legacy) return;
    void navigate({
      to: '/agents/$agentId',
      params: { agentId },
      search: (current) => ({ ...current, tab: 'instructions', instruction: legacy }),
      replace: true,
    });
  }, [search.tab, navigate, agentId]);

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

  const navigateSearch = (next: {
    tab?: TabId | undefined;
    instruction?: AgentInstruction | undefined;
    view?: MemoryView | undefined;
    file?: string | undefined;
  }): void => {
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5">
      <PageTopbar>
        <Tabs value={tab} onValueChange={(next) => changeTab(next as TabId)}>
          <TabsList variant="line" aria-label="专家任务">
            {available.map((item) => (
              <TabsTrigger key={item.id} value={item.id}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </PageTopbar>
      <PageBody className="gap-5 p-2">
        {tab === 'overview' ? (
          <AgentOverview
            agentId={agentId}
            agent={agent}
            config={null}
            permissions={permissions}
            canViewRuns={canViewRuns}
            onNavigate={navigateSearch}
          />
        ) : null}
        {tab === 'memory' ? (
          <div className="min-w-0 cds-card-surface rounded-card bg-surface px-6 py-5">
            <MemoryPanel
              agentId={agentId}
              canWrite={hasAnyGrant(permissions, 'agents.memory.write')}
              view={search.view ?? 'overview'}
              onViewChange={(view) => navigateSearch({ view })}
              onDirtyChange={setChildDirty}
              onPendingChange={setChildPending}
            />
          </div>
        ) : null}
        {tab === 'instructions' && instruction ? (
          <AgentInstructions
            agentId={agentId}
            permissions={permissions}
            instruction={instruction}
            onInstructionChange={(next) => navigateSearch({ instruction: next })}
            onDirtyChange={setChildDirty}
            onPendingChange={setChildPending}
          />
        ) : null}
        {tab === 'files' ? (
          <div className="flex min-w-0 flex-col gap-3">
            <p className="max-w-[70ch] text-sm text-muted-foreground">
              这里展示只读投影，编辑请到配置、专家记忆或指令。
            </p>
            <ReadonlyAgentFiles
              agentId={agentId}
              file={search.file}
              onFileChange={(file) => navigateSearch({ file })}
            />
          </div>
        ) : null}
      </PageBody>
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
      <nav aria-label="文件与版本" className="min-w-0">
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
                    'flex h-8 items-center truncate rounded-item px-2 text-left text-sm transition-colors duration-150 ease-out-soft',
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
      <div className="min-w-0 cds-card-surface rounded-card bg-surface px-6 py-5">
        {current ? <CodeBlock code={current.content} lineNumbers /> : null}
      </div>
    </div>
  );
}
