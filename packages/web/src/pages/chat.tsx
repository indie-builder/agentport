import type { AgentSummary } from '@agentport/shared';
import {
  type ConversationSearchItem,
  conversationRenameSchema,
  type OpenUiAction,
  type OutputFile,
  type OutputRef,
  type PublicRunQuestion,
} from '@agentport/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useBlocker, useNavigate, useSearch } from '@tanstack/react-router';
import {
  Bot,
  Check,
  GitBranch,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  PanelLeftDashed,
  PanelRightDashed,
  Pencil,
  Plus,
  Search,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import {
  type ComponentProps,
  type FormEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels';
import { AgentPicker } from '../components/agent/agent-picker.js';
import { BusinessIllustration } from '../components/business-illustration.js';
import {
  Composer,
  MessagePane,
  RunFooter,
  RunReconciliation,
  runStatusText,
} from '../components/chat/chat-thread.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { ConversationOutputs, type OutputSelection } from '../components/chat/conversation-outputs.js';
import { ConversationSearch } from '../components/chat/conversation-search.js';
import { DialogShell } from '../components/dialog-shell.js';
import { Page, PageHeader } from '../components/page.js';
import { RequiredMark } from '../components/required-mark.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Button, buttonVariants } from '../components/ui/button.js';
import { Dialog } from '../components/ui/dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu.js';
import { Field, FieldError, FieldLabel } from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import { Sheet, SheetContent, SheetTitle } from '../components/ui/sheet.js';
import { can } from '../lib/access.js';
import { type ApprovalRequest, api } from '../lib/api.js';
import { type ChatItem, mergeOlderHistory, titleFromDetail } from '../lib/chat-state.js';
import { type ChatPhase, isActivePhase, type RunMetrics, useChatStore } from '../lib/chat-store.js';
import { cn } from '../lib/cn.js';
import { fieldErrors, useFormBlocker } from '../lib/form.js';
import { formatRelative } from '../lib/format.js';
import {
  chatKeys,
  meQuery,
  useAgents,
  useConversation,
  useConversationOutputs,
  useConversations,
  useRunApprovals,
  useRunQuestions,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { useChatStream } from '../lib/use-chat-stream.js';
import { useMediaQuery } from '../lib/use-media-query.js';
import type {
  OpenUiApprovalInput,
  OpenUiStateSaveInput,
  OpenUiToolCallInput,
} from '../openui/renderer.js';

export function ChatPage() {
  const search = useSearch({ from: '/_shell/chat' });
  const navigate = useNavigate();
  const agents = useAgents();
  const me = useQuery(meQuery);
  const canCreate = can(me.data, 'agents.create');
  const canReadAgents = can(me.data, 'agents.read');
  const conversationId = search.conversation ?? null;
  const detail = useConversation(conversationId);

  // 已打开会话时，服务端记录才是真相；URL 只是它的镜像。
  const serverAgentId = detail.data?.conversation.agentId ?? null;
  // 裸 /chat 不替用户挑第一位专家；必须由 URL 或已有会话明确归属。
  const activeAgentId = serverAgentId ?? search.agent ?? null;

  // URL 里的 agent 与会话不一致时，用会话的真实归属校正 URL（replace，不进历史）。
  useEffect(() => {
    if (!serverAgentId || serverAgentId === search.agent) return;
    void navigate({
      to: '/chat',
      search: (previous) => ({ ...previous, agent: serverAgentId }),
      replace: true,
    });
  }, [serverAgentId, search.agent, navigate]);

  const clearSelection = (): void => {
    void navigate({ to: '/chat', search: {}, replace: true });
  };

  // 只有还没有缓存数据时才整页替换。已有专家缓存但后台刷新失败时继续渲染工作区，
  // 否则 cleanup 会清掉未发送附件、草稿与当前会话，错误改由工作区内提示并可重试。
  if (!agents.data || agents.data.length === 0) {
    return (
      <Page className="mx-auto h-full min-h-0 w-full max-w-220 overflow-y-auto px-6 pb-6">
        <PageHeader title="对话" className="shrink-0 [&_h1]:sr-only" />
        {agents.isPending ? (
          <LoadingState rows={3} />
        ) : agents.isError ? (
          <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
        ) : me.isPending ? (
          <LoadingState rows={3} />
        ) : me.isError ? (
          <ErrorState error={me.error} onRetry={() => void me.refetch()} />
        ) : canCreate ? (
          <EmptyState
            illustration={<BusinessIllustration name="agents" />}
            title="先创建一位专家"
            description="创建后即可在这里开始对话。"
            action={
              <Link to="/agents" className={buttonVariants({ variant: 'outline' })}>
                前往专家
              </Link>
            }
          />
        ) : (
          <EmptyState
            illustration={<BusinessIllustration name="agents" />}
            title="暂无可用专家"
            description="请联系管理员分配。"
            action={
              canReadAgents ? (
                <Link to="/agents" className={buttonVariants({ variant: 'outline' })}>
                  前往专家
                </Link>
              ) : undefined
            }
          />
        )}
      </Page>
    );
  }

  // URL 指向的 agent 不存在：不静默改成第一个，免得把消息发给别的 agent。
  if (!conversationId && search.agent && !agents.data.some((item) => item.id === search.agent)) {
    return (
      <Page className="mx-auto h-full min-h-0 w-full max-w-220 overflow-y-auto px-6 pb-6">
        <PageHeader title="对话" className="shrink-0 [&_h1]:sr-only" />
        <EmptyState
          icon={<Bot className="size-5" />}
          title="找不到这位专家"
          description="链接里的智能体可能已被删除，或不属于当前工作区。"
          action={
            <Button variant="outline" onClick={clearSelection}>
              开始新对话
            </Button>
          }
        />
      </Page>
    );
  }

  // 深链会话的加载 / 失败状态在 ChatWorkspace 内处理：那里能区分「正在发送的本轮」，
  // 不会因为新会话的数据刚到就卸载整个工作区、掐断事件流。
  return (
    <ChatWorkspace
      agents={agents.data}
      agentId={activeAgentId}
      conversationId={conversationId}
      agentsError={agents.isError ? agents.error : null}
      onRetryAgents={() => void agents.refetch()}
      output={
        search.outputRun && search.outputPath
          ? {
              runId: search.outputRun,
              path: search.outputPath,
              mode: search.outputMode ?? 'read',
            }
          : null
      }
      onSelectOutput={(selection) => {
        void navigate({
          to: '/chat',
          search: (previous) => ({
            ...previous,
            outputRun: selection.runId,
            outputPath: selection.path,
            outputMode: selection.mode,
          }),
          replace: true,
        });
      }}
      // 会话切换走 push：后退能回到上一条会话。新会话首次落 URL 用 replace。
      onConversationChange={(id, replace = false) => {
        void navigate({
          to: '/chat',
          search: (previous) => ({
            ...(id !== null && id === previous.conversation
              ? {
                  outputRun: previous.outputRun,
                  outputPath: previous.outputPath,
                  outputMode: previous.outputMode,
                }
              : {}),
            ...(activeAgentId && agents.data.some((item) => item.id === activeAgentId)
              ? { agent: activeAgentId }
              : {}),
            ...(id ? { conversation: id } : {}),
          }),
          replace,
        });
      }}
      onAgentChange={(id) => {
        void navigate({ to: '/chat', search: { agent: id } });
      }}
      // 搜索结果一次导航同时写入专家与会话；不能走 switchAgent，那会清空目标会话。
      onSelectSearchResult={(item) => {
        void navigate({
          to: '/chat',
          search: { agent: item.agentId, conversation: item.id },
        });
      }}
    />
  );
}

const WORKSPACE = {
  duration: 0.16,
  ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
};

/** 与 Tailwind 的 lg 断点一致：只有这一侧需要可拖拽分栏。 */
const DESKTOP = '(min-width: 64rem)';
/** 与 Tailwind 的 xl 断点一致：更窄时右侧工作区改走抽屉，不挤压对话。 */
const WIDE = '(min-width: 80rem)';

function ChatWorkspace({
  agents,
  agentId,
  conversationId,
  agentsError,
  onRetryAgents,
  output,
  onSelectOutput,
  onConversationChange,
  onAgentChange,
  onSelectSearchResult,
}: {
  agents: NonNullable<ReturnType<typeof useAgents>['data']>;
  agentId: string | null;
  conversationId: string | null;
  agentsError: unknown | null;
  onRetryAgents: () => void;
  output: OutputSelection | null;
  onSelectOutput: (selection: OutputSelection) => void;
  onConversationChange: (conversationId: string | null, replace?: boolean) => void;
  onAgentChange: (agentId: string) => void;
  onSelectSearchResult: (item: ConversationSearchItem) => void;
}) {
  const agent = agents.find((item) => item.id === agentId) ?? null;
  const agentOptions = agents.map((item) => ({
    value: item.id,
    label: item.name,
    agent: item,
  }));
  const items = useChatStore((state) => state.items);
  const phase = useChatStore((state) => state.phase);
  const runId = isActivePhase(phase) ? phase.runId : null;
  const running = phase.kind !== 'idle';
  const lastRun = useChatStore((state) => state.lastRun);
  const lastRunId = useChatStore((state) => state.lastRunId);
  const historyOpen = useChatStore((state) => state.historyOpen);
  const setInput = useChatStore((state) => state.setInput);
  const setHistoryOpen = useChatStore((state) => state.setHistoryOpen);
  const client = useQueryClient();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const workspaceToggleRef = useRef<HTMLButtonElement>(null);
  // 记下真正发起操作的菜单触发器：菜单与对话框卸载后，焦点要回到它。
  const [renaming, setRenaming] = useState<{
    entry: HistoryEntry;
    trigger: HTMLElement;
    draft: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    title: string;
    trigger: HTMLElement;
  } | null>(null);
  // 删除成功后要等 mutation 结算成非 pending，再切到新会话，避免被删除中的离开保护拦住。
  const [deletedConversation, setDeletedConversation] = useState<string | null>(null);
  const desktop = useMediaQuery(DESKTOP);
  const wide = useMediaQuery(WIDE);

  const conversations = useConversations(agentId);
  const detail = useConversation(conversationId);
  const runApprovals = useRunApprovals(runId || lastRunId, runId !== null);
  // 提问状态来自 Query：SSE 快照和回答结果都写这里，不在 Zustand 里再存一份。
  const runQuestions = useRunQuestions(runId || lastRunId, runId !== null);
  const questionsByToolUseId = useMemo(
    () => new Map((runQuestions.data?.items ?? []).map((item) => [item.toolUseId, item])),
    [runQuestions.data],
  );
  const historyLayout = useDefaultLayout({ id: 'chat-history-v2' });
  const historyPanelRef = usePanelRef();
  // 历史默认隐藏：每次进入都从折叠态开始。
  const [historyCollapsed, setHistoryCollapsed] = useState(true);
  // 零宽面板没有「上次宽度」可恢复，自己记住最后一个正宽度。
  // 存储里是百分比（随分组宽度自适应），首次进入没有存储时按设计规范的 240px。
  const storedHistoryPct = historyLayout.defaultLayout?.history ?? 0;
  const lastHistorySize = useRef(
    storedHistoryPct > 0 ? (`${storedHistoryPct}%` as const) : ('240px' as const),
  );
  // 右侧工作区展示会话成果，与历史列表互相独立。深链带选中成果时直接展开。
  const [workspaceOpen, setWorkspaceOpen] = useState(output !== null);
  // 两个入口共用同一个搜索浮层；记下来源，以便关闭后焦点回到触发按钮。
  const [search, setSearch] = useState<{ trigger: HTMLElement; inSheet: boolean } | null>(null);
  const workspaceFeedbackRef = useRef(false);
  const reduce = useReducedMotion();

  // 空数组也要稳定：否则轮询之外的重渲染会给工具行换一个新身份。
  const approvalData = useMemo(() => runApprovals.data?.items ?? [], [runApprovals.data]);

  const stream = useChatStream({
    agentId,
    history: detail,
    onAccepted: (accepted) => {
      // 第一次发送才拿到会话 id：URL 镜像它，但这是同一次操作，用 replace 不留历史。
      onConversationChange(accepted.conversationId, true);
    },
  });

  // 清空工作区，但保留尚未发送的输入。
  useEffect(
    () => () => {
      const store = useChatStore.getState();
      store.resetConversation(null);
      store.setHistoryOpen(false);
    },
    [],
  );

  // 空态或运行结束后把焦点交还输入框，键盘用户不用再找一次。
  useEffect(() => {
    if (agentId && !running && items.length === 0) composerRef.current?.focus();
  }, [agentId, running, items.length]);

  const history = useMemo(
    () =>
      (conversations.data ?? []).map((conversation) => ({
        id: conversation.id,
        agentId: conversation.agentId,
        title: conversation.title || '未命名会话',
        updatedAt: conversation.updatedAt || conversation.createdAt,
      })),
    [conversations.data],
  );

  // 三个写操作都用 mutation：pending 与失效刷新交给 TanStack Query。
  const cancelMutation = useMutation({
    mutationFn: (runId: string) => api.cancelRun(runId),
    onError: (error) => toastError(error),
    onSettled: (_data, _error, runId) => client.invalidateQueries({ queryKey: ['run', runId] }),
  });

  const approvalInFlight = useRef(false);
  const approveMutation = useMutation({
    mutationFn: (item: ApprovalRequest & { runId: string }) =>
      api.approveRun(item.runId, item.serverId, item.toolName),
    onSettled: () => {
      approvalInFlight.current = false;
    },
    onSuccess: (data, item) => {
      toastSuccess(
        data.waiting
          ? `已批准 ${item.toolName}；仍在等待的调用可继续，无需重发消息`
          : '已记录后续调用许可；本次调用不会恢复。',
      );
      void client.invalidateQueries({ queryKey: ['run-approvals'] });
    },
    onError: (error) => toastError(error),
  });

  const branchMutation = useMutation({
    mutationFn: ({
      id,
      fromMessageId,
    }: {
      id: string;
      fromMessageId?: string;
      ownsRequest: () => boolean;
    }) => api.branchConversation(id, fromMessageId),
    onSuccess: (conversation, { ownsRequest }) => {
      if (ownsRequest()) openConversation(conversation.id);
      void client.invalidateQueries({ queryKey: chatKeys.conversations() });
    },
    onError: (error, { ownsRequest }) => {
      if (ownsRequest()) toastError(error);
    },
  });

  const renameMutation = useMutation({
    mutationFn: (input: { id: string; title: string }) =>
      api.renameConversation(input.id, input.title),
    onSuccess: (_conversation, input) => {
      void client.invalidateQueries({ queryKey: chatKeys.conversations() });
      void client.invalidateQueries({ queryKey: chatKeys.conversation(input.id) });
      setRenaming(null);
    },
    onError: (error) => toastError(error),
  });

  const renameDirty = renaming ? renaming.draft.trim() !== renaming.entry.title : false;
  const renameBlocker = useRenameBlocker(renameDirty, renameMutation.isPending);
  // 保存成功后对话框已卸载；把保存期间挂起的离开导航结算掉，否则路由会一直停在 blocked。
  useEffect(() => {
    if (renaming || renameMutation.isPending || renameBlocker.status !== 'blocked') return;
    renameBlocker.proceed?.();
  }, [renaming, renameMutation.isPending, renameBlocker]);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteConversation(id),
    onSuccess: (_data, id) => {
      void client.invalidateQueries({ queryKey: chatKeys.conversations() });
      void client.invalidateQueries({ queryKey: chatKeys.conversation(id) });
      // 级联删除了该会话的运行记录，运行列表与概况跟着刷新。
      void client.invalidateQueries({ queryKey: ['runs'] });
      void client.invalidateQueries({ queryKey: ['overview'] });
      // 等请求结算后再换会话：删除中的离开保护会拦住它自己的导航。
      if (id === conversationId) setDeletedConversation(id);
      toastSuccess('会话已删除');
    },
    // 失败交给 ConfirmDialog 统一提示：保留当前会话与草稿，对话框可重试。
  });
  const deleteBlocker = useFormBlocker(false, deleteMutation.isPending);

  const cancel = (): void => {
    // 没有 runId 时后端还没有可取消的 run；按钮也不会显示。
    if (!runId) return;
    cancelMutation.mutate(runId);
  };

  // 引用只挂在输入框上，不自动发送：用户仍可改写文案或取消引用再发。
  const attachOutputRef = useCallback((ref: OutputRef): void => {
    useChatStore.getState().setOutputRef(ref);
    composerRef.current?.focus();
  }, []);

  // 固定身份：工具行的 memo 依赖这个回调，每次渲染都换新函数会让整列重渲染。
  const approve = useCallback(
    (item: ApprovalRequest): void => {
      const activeRunId = runId || lastRunId;
      if (!activeRunId || approvalInFlight.current) return;
      approvalInFlight.current = true;
      approveMutation.mutate({ ...item, runId: activeRunId });
    },
    [runId, lastRunId, approveMutation.mutate],
  );

  // URL 是选中的会话：历史、新建、切换 agent 都只改 URL，store 由下面的同步 effect 收敛。
  const openConversation = (id: string): void => {
    if (id !== conversationId) onConversationChange(id);
    setHistoryOpen(false);
  };

  // 删除当前会话时没有可返回的会话，未发送输入跟到新会话，避免随删除丢失。
  const newConversation = useCallback(
    (carryDraft = false): void => {
      stream.closeStream();
      stream.hydratedRef.current = null;
      useChatStore.getState().resetConversation(null, carryDraft);
      onConversationChange(null);
      setHistoryOpen(false);
      composerRef.current?.focus();
    },
    [stream.closeStream, stream.hydratedRef, onConversationChange, setHistoryOpen],
  );

  // 删除已结算：先作废删除期间挂起的离开导航，再切到新会话，避免路由残留。
  useEffect(() => {
    if (!deletedConversation || deleteMutation.isPending) return;
    setDeletedConversation(null);
    if (deleteBlocker.status === 'blocked') deleteBlocker.reset?.();
    newConversation(true);
  }, [deletedConversation, deleteMutation.isPending, deleteBlocker, newConversation]);

  // 分支：服务端复制消息，前端切到新会话；列表由 query 失效后刷新。
  const branch = (id: string, fromMessageId?: string): void =>
    branchMutation.mutate({
      id,
      ...(fromMessageId === undefined ? {} : { fromMessageId }),
      ownsRequest: stream.captureRequest(),
    });

  // URL → store：只清掉属于别的会话的本地状态；自己发送时 store 已先于 URL 写入，这里不动。
  useEffect(() => {
    const store = useChatStore.getState();
    if (store.conversationId === conversationId) return;
    stream.closeStream();
    stream.hydratedRef.current = null;
    store.resetConversation(conversationId);
  }, [conversationId, stream.closeStream, stream.hydratedRef]);

  const hydrated = stream.hydratedRef;
  const { historyPrefix, setHistoryPrefix } = stream;

  // 更早的页面只会在历史前缀前插入：整段前缀重新解析（跨页工具调用合并），尾部原样保留。
  // 加载期间开始新一轮时先等它结束，避免合并打断流式基准。
  useEffect(() => {
    const data = detail.data;
    if (!data || running || !historyPrefix) return;
    const items = useChatStore.getState().items;
    const merged = mergeOlderHistory(historyPrefix, data, items);
    if (!merged) return;
    setHistoryPrefix(merged.snapshot);
    useChatStore.getState().setItems(merged.items);
  }, [detail.data, running, historyPrefix, setHistoryPrefix]);

  const loadOlder = useCallback((): void => {
    if (!detail.hasNextPage || detail.isFetching || running) return;
    // fetchNextPage 默认吞掉错误（结果里带 isFetchNextPageError），重试按钮保持可见。
    void detail.fetchNextPage().then((result) => {
      if (result.isFetchNextPageError) toastError(result.error);
    });
  }, [detail.hasNextPage, detail.isFetching, detail.fetchNextPage, running]);

  const switchAgent = (id: string): void => {
    if (id === agentId) return;
    stream.closeStream();
    stream.hydratedRef.current = null;
    // 切换专家进入该专家的新会话，但没发出的输入要跟过去。
    useChatStore.getState().resetConversation(null, true);
    onAgentChange(id);
  };

  const showWelcome =
    items.length === 0 &&
    !running &&
    !detail.isError &&
    (conversationId === null || !detail.isPending);

  // inSheet 决定浮层挂在哪棵子树：抽屉会把外部 portal 当作外部节点隐藏。
  const renderHistoryPanel = (inSheet: boolean) => (
    <HistoryPanel
      history={history}
      // 未选专家时 query 是 disabled，isPending 会一直是 true；这里据此显示真实空态。
      pending={agentId !== null && conversations.isPending}
      hasAgent={agentId !== null}
      error={conversations.isError ? conversations.error : null}
      onRetry={() => void conversations.refetch()}
      conversationId={conversationId}
      branching={branchMutation.isPending ? (branchMutation.variables?.id ?? null) : null}
      onOpen={openConversation}
      onBranch={branch}
      onOpenSearch={(trigger) => setSearch({ trigger, inSheet })}
      onRename={(conversation, trigger) =>
        setRenaming({ entry: conversation, trigger, draft: conversation.title })
      }
    />
  );

  const searchDialog = search ? (
    <ConversationSearch
      open
      onOpenChange={(open) => {
        if (!open) setSearch(null);
      }}
      finalFocus={() => (search.trigger.isConnected ? search.trigger : null)}
      onSelect={(item) => {
        setSearch(null);
        setHistoryOpen(false);
        onSelectSearchResult(item);
      }}
    />
  ) : null;

  const title = conversationId && detail.data ? titleFromDetail(detail.data) : '未命名会话';

  // 唯一的 56px 头部随消息列渲染，历史／消息／成果三栏从工作区顶部并排开始。
  // 专家选择随历史开合在头部与历史头部之间切换；展开时搜索只在历史面板保留一处。
  const header = (
    <ChatTopBar
      title={title}
      conversationId={conversationId}
      deleting={deleteMutation.isPending}
      agent={agent}
      agentOptions={agentOptions}
      showAgentPicker={desktop ? historyCollapsed : !historyOpen}
      onSwitchAgent={switchAgent}
      historyVisible={desktop ? !historyCollapsed : historyOpen}
      historyPanelId="chat-history"
      onToggleHistory={() => {
        if (desktop) {
          if (historyCollapsed) historyPanelRef.current?.resize(lastHistorySize.current);
          else historyPanelRef.current?.collapse();
          setHistoryCollapsed(!historyCollapsed);
        } else {
          setHistoryOpen(!historyOpen);
        }
      }}
      onOpenSearch={(trigger) => setSearch({ trigger, inSheet: false })}
      workspaceOpen={workspaceOpen}
      workspacePanelId="chat-workspace"
      onToggleWorkspace={() => {
        if (workspaceOpen) workspaceToggleRef.current?.focus();
        setWorkspaceOpen(!workspaceOpen);
      }}
      workspaceToggleRef={workspaceToggleRef}
      onRename={(trigger) => {
        if (conversationId)
          setRenaming({
            entry: { id: conversationId, title, updatedAt: '' },
            trigger,
            draft: title,
          });
      }}
      onFork={() => {
        if (conversationId) branch(conversationId);
      }}
      onDelete={(trigger) => {
        if (conversationId) setDeleteTarget({ id: conversationId, title, trigger });
      }}
    />
  );

  const column = (
    <ChatColumn
      header={header}
      agent={agent}
      conversationId={conversationId}
      detail={detail}
      agentsError={agentsError}
      onRetryAgents={onRetryAgents}
      historyReady={conversationId === null || hydrated.current === conversationId}
      runApprovals={runApprovals}
      onRetryStream={stream.retryStream}
      reconcileRun={stream.reconcileRun}
      items={items}
      phase={phase}
      lastRun={lastRun}
      lastRunId={lastRunId}
      approving={approveMutation.isPending ? (approveMutation.variables?.id ?? null) : null}
      cancelling={cancelMutation.isPending}
      approvalItems={approvalData}
      questionsByToolUseId={questionsByToolUseId}
      questionsError={runQuestions.isError ? runQuestions.error : null}
      onRetryQuestions={() => void runQuestions.refetch()}
      liveRunId={runId}
      onApprove={approve}
      onCancel={cancel}
      onPickSuggestion={(text) => {
        setInput(text);
        composerRef.current?.focus();
      }}
      onBranchMessage={branch}
      // 从某一轮点开成果时直接展开工作区；宽屏是旁栏，窄屏是抽屉，选择本身仍交给外层。
      onSelectOutput={(selection) => {
        setWorkspaceOpen(true);
        onSelectOutput(selection);
      }}
      branchingMessageId={
        branchMutation.isPending ? (branchMutation.variables?.fromMessageId ?? null) : null
      }
      onLoadOlder={loadOlder}
      hasOlder={Boolean(historyPrefix?.conversationId === conversationId && detail.hasNextPage)}
      loadingOlder={detail.isFetchingNextPage}
      showWelcome={showWelcome}
      send={stream.send}
      composerRef={composerRef}
    />
  );

  const renameDialog = renaming ? (
    <RenameDialog
      title={renaming.draft}
      dirty={renameDirty}
      pending={renameMutation.isPending}
      blocker={renameBlocker}
      onTitleChange={(draft) => setRenaming({ ...renaming, draft })}
      onClose={() => setRenaming(null)}
      onRename={(title) => renameMutation.mutate({ id: renaming.entry.id, title })}
      // 菜单项随菜单卸载；触发器还在就回到它，否则交给 Base UI 的默认落点。
      finalFocus={() => (renaming.trigger.isConnected ? renaming.trigger : null)}
    />
  ) : null;

  // ConfirmDialog 自己处理 pending 与失败提示；成功后关闭对话框。
  const deleteDialog = deleteTarget ? (
    <ConfirmDialog
      open
      onClose={() => setDeleteTarget(null)}
      title="删除会话？"
      description={`「${deleteTarget.title}」及其消息、运行记录会被永久删除，无法恢复。`}
      confirmLabel="删除会话"
      onConfirm={() => deleteMutation.mutateAsync(deleteTarget.id)}
      // 删除成功后会话已切换，触发器随之禁用：焦点交给输入框，其余情况回菜单按钮。
      finalFocus={() =>
        deleteTarget.trigger.isConnected && !deleteTarget.trigger.matches(':disabled')
          ? deleteTarget.trigger
          : composerRef.current
      }
    />
  ) : null;

  // 删除请求在途时离开一律拦下：确认按钮禁用，只能等请求完成。
  const deleteLeaveDialog = (
    <ConfirmDialog
      open={deleteBlocker.status === 'blocked'}
      onClose={() => deleteBlocker.reset?.()}
      title="会话正在删除"
      description="正在删除会话，请等待请求完成。"
      confirmLabel="放弃并离开"
      confirmDisabled={deleteMutation.isPending}
      onConfirm={async () => deleteBlocker.proceed()}
    />
  );

  // 只有「静默的」深链失败才整页报错；正在跑的这一轮不能被卸载，否则事件流会被掐断。
  if (conversationId && detail.isError && items.length === 0 && !running) {
    return (
      <Page className="mx-auto h-full min-h-0 w-full max-w-220 overflow-y-auto px-6 pb-6">
        <PageHeader title="对话" className="shrink-0 [&_h1]:sr-only" />
        <div className="flex flex-col gap-3">
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => onConversationChange(null)}
          >
            开始新对话
          </Button>
        </div>
      </Page>
    );
  }

  // 深链会话还没回填历史时不给输入框：此时还不知道会话属于哪个 agent。
  // 自己发送时 store 已有本轮消息，不会闪这一屏。
  if (conversationId && !running && items.length === 0 && hydrated.current !== conversationId) {
    return (
      <Page className="mx-auto h-full min-h-0 w-full max-w-220 overflow-y-auto px-6 pb-6">
        <PageHeader title="对话" className="shrink-0 [&_h1]:sr-only" />
        <LoadingState rows={4} />
      </Page>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0">
      {/* 窄屏抽屉由 Base UI 管理焦点、Escape 与滚动锁。 */}
      <Sheet open={historyOpen && !desktop} onOpenChange={setHistoryOpen}>
        <SheetContent
          side="left"
          showCloseButton={false}
          aria-describedby={undefined}
          className="w-73.5! max-w-full! gap-5 p-0"
        >
          <SheetTitle className="sr-only">会话历史</SheetTitle>
          <HistoryHeader
            onNew={newConversation}
            onClose={() => setHistoryOpen(false)}
            agent={agent}
            agentId={agentId}
            agentOptions={agentOptions}
            onSwitchAgent={switchAgent}
          />
          {renderHistoryPanel(true)}
          {/* 必须挂在抽屉的 React 子树里：否则抽屉会把重命名对话框的 portal 当成外部节点隐藏。 */}
          {desktop ? null : renameDialog}
          {search?.inSheet ? searchDialog : null}
        </SheetContent>
      </Sheet>

      {/* 右工作区：宽屏内联旁栏，窄屏走抽屉；与历史互不影响。 */}
      <Sheet
        open={workspaceOpen && !wide}
        onOpenChange={(open) => {
          workspaceFeedbackRef.current = false;
          // 关闭时立刻把焦点交回开关，不等退场动画（finalFocus 在动画后才生效）。
          if (!open) workspaceToggleRef.current?.focus();
          setWorkspaceOpen(open);
        }}
      >
        <SheetContent
          side="right"
          aria-describedby={undefined}
          finalFocus={() =>
            workspaceFeedbackRef.current ? composerRef.current : workspaceToggleRef.current
          }
          className="w-100! max-w-full! gap-0 p-0"
        >
          <SheetTitle className="sr-only">会话成果</SheetTitle>
          <ConversationOutputs
            conversationId={conversationId}
            selection={output}
            onSelect={onSelectOutput}
            onFeedback={(ref) => {
              useChatStore.getState().setOutputRef(ref);
              workspaceFeedbackRef.current = true;
              setWorkspaceOpen(false);
            }}
          />
        </SheetContent>
      </Sheet>

      {desktop ? (
        <div className="flex min-h-0 w-full">
          <Group
            orientation="horizontal"
            defaultLayout={{ ...historyLayout.defaultLayout, history: 0, chat: 100 }}
            // 折叠/展开是程序化改尺寸，写回存储只会把宽度记成 0；只持久化用户拖拽的结果。
            onLayoutChanged={(layout, meta) => {
              if (meta.isUserInteraction) historyLayout.onLayoutChanged(layout, meta);
            }}
          >
            <Panel
              id="history"
              defaultSize={0}
              minSize={200}
              maxSize={360}
              collapsible
              collapsedSize={0}
              panelRef={historyPanelRef}
              onResize={(size) => {
                if (size.asPercentage > 0 && !historyCollapsed) {
                  lastHistorySize.current = `${size.asPercentage}%`;
                }
                setHistoryCollapsed(size.inPixels === 0);
              }}
            >
              {/* 隐藏时整块不渲染：零宽面板不该留下可聚焦内容，也避免出现第二个 h1。 */}
              {historyCollapsed ? null : (
                <aside
                  id="chat-history"
                  // 与对话内容同属一个工作区：纸白底，只用分隔线区分，不做成独立面板。
                  className="flex h-full min-w-0 flex-col gap-3 overflow-hidden bg-surface"
                  aria-label="会话历史"
                >
                  <HistoryHeader
                    onNew={newConversation}
                    agent={agent}
                    agentId={agentId}
                    agentOptions={agentOptions}
                    onSwitchAgent={switchAgent}
                  />
                  {renderHistoryPanel(false)}
                </aside>
              )}
            </Panel>
            <Separator
              disabled={historyCollapsed}
              className={historyCollapsed ? 'hidden' : 'w-px border-r'}
              aria-label="调整会话列表宽度"
            />
            {/* 成果打开时消息列至少 400，给内联成果留出 400：历史再拖也不能挤掉正文。 */}
            <Panel id="chat" minSize={wide && workspaceOpen ? 800 : 400}>
              <div className="flex h-full min-h-0">
                <div className="relative min-w-0 flex-1">{column}</div>
                {wide ? (
                  // 宽度开合保留成果子树：收起后仍不可聚焦，也不会丢输入或流式上下文。
                  <motion.div
                    initial={false}
                    animate={{ width: workspaceOpen ? 400 : 0 }}
                    transition={reduce ? { duration: 0 } : WORKSPACE}
                    inert={!workspaceOpen}
                    aria-hidden={!workspaceOpen}
                    className="h-full shrink-0 overflow-hidden"
                  >
                    <ConversationOutputs
                      inline
                      conversationId={conversationId}
                      selection={output}
                      onSelect={onSelectOutput}
                      onFeedback={attachOutputRef}
                    />
                  </motion.div>
                ) : null}
              </div>
            </Panel>
          </Group>
          {renameDialog}
          {deleteDialog}
          {deleteLeaveDialog}
        </div>
      ) : (
        // 窄屏没有分栏：头部仍在消息列内，历史与成果由抽屉承担。
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {column}
          {/* 抽屉打开时重命名由抽屉子树渲染，避免门户被遮挡；这里补上头部触发的对话框。 */}
          {historyOpen ? null : renameDialog}
          {deleteDialog}
          {deleteLeaveDialog}
        </div>
      )}
      {search && !search.inSheet ? searchDialog : null}
    </div>
  );
}

/**
 * 唯一 56px 消息列头部：历史／消息／成果三栏从工作区顶部并排。
 * 历史展开时搜索与专家选择交给历史面板，收起后回到这里；成果只切换自己的面板。
 */
function ChatTopBar({
  title,
  conversationId,
  deleting,
  agent,
  agentOptions,
  showAgentPicker,
  onSwitchAgent,
  historyVisible,
  historyPanelId,
  onToggleHistory,
  onOpenSearch,
  workspaceOpen,
  workspacePanelId,
  onToggleWorkspace,
  workspaceToggleRef,
  onRename,
  onFork,
  onDelete,
}: {
  title: string;
  conversationId: string | null;
  deleting: boolean;
  agent: AgentSummary | null;
  agentOptions: Array<{ value: string; label: string; agent?: AgentSummary }>;
  /** 桌面历史展开或窄屏抽屉打开时，专家选择交给历史头部。 */
  showAgentPicker: boolean;
  onSwitchAgent: (id: string) => void;
  historyVisible: boolean;
  historyPanelId: string;
  onToggleHistory: () => void;
  onOpenSearch: (trigger: HTMLElement) => void;
  workspaceOpen: boolean;
  workspacePanelId: string;
  onToggleWorkspace: () => void;
  workspaceToggleRef: RefObject<HTMLButtonElement | null>;
  onRename: (trigger: HTMLElement) => void;
  onFork: () => void;
  onDelete: (trigger: HTMLElement) => void;
}) {
  const headerTriggerRef = useRef<HTMLElement | null>(null);
  const me = useQuery(meQuery);
  const canUpdate = can(me.data, 'conversations.update');
  const canDelete = can(me.data, 'conversations.delete');
  const canCreate = can(me.data, 'conversations.create');
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 px-6">
      {/* 会话内的面板开关比导航折叠更轻：虚线面板图标，保持 32px 点击区与同一中心线。 */}
      <Button
        variant="ghost"
        size="icon"
        aria-label={historyVisible ? '隐藏会话历史' : '显示会话历史'}
        title={historyVisible ? '隐藏会话历史' : '显示会话历史'}
        aria-expanded={historyVisible}
        aria-controls={historyPanelId}
        onClick={onToggleHistory}
        className="shrink-0 text-muted-foreground hover:text-fg"
      >
        <PanelLeftDashed />
      </Button>
      {/* 历史展开时搜索入口只在历史面板里，头部不再保留第二个触发器。 */}
      {historyVisible ? null : (
        <Button
          variant="ghost"
          size="icon"
          aria-label="搜索会话"
          title="搜索会话"
          onClick={(event) => onOpenSearch(event.currentTarget)}
          className="shrink-0 text-muted-foreground hover:text-fg"
        >
          <Search />
        </Button>
      )}
      {showAgentPicker ? (
        <div className="min-w-0 shrink basis-44">
          <AgentPicker
            agent={agent}
            agentId={agent?.id ?? null}
            agentOptions={agentOptions}
            onSwitchAgent={onSwitchAgent}
          />
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <h1
          title={title}
          className="min-w-0 truncate text-base font-medium tracking-[-0.01em] text-fg"
        >
          {title}
        </h1>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="会话操作"
                title={conversationId ? '会话操作' : '先发送消息，保存会话后可操作'}
                disabled={!conversationId || deleting}
                // 菜单在 mousedown 打开；键盘打开时也要记下触发器以便对话框关闭后回焦。
                onMouseDown={(event) => {
                  headerTriggerRef.current = event.currentTarget;
                }}
                onKeyDown={(event) => {
                  headerTriggerRef.current = event.currentTarget;
                }}
                className="shrink-0 text-muted-foreground hover:text-fg"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="start" sideOffset={4} className="w-40">
            <DropdownMenuGroup>
              {canUpdate ? (
                <DropdownMenuItem
                  disabled={deleting}
                  onClick={() => {
                    const trigger = headerTriggerRef.current;
                    if (trigger) onRename(trigger);
                  }}
                >
                  <Pencil /> 重命名
                </DropdownMenuItem>
              ) : null}
              {canCreate ? (
                <DropdownMenuItem disabled={deleting} onClick={onFork}>
                  <GitBranch /> Fork 会话
                </DropdownMenuItem>
              ) : null}
              {canDelete ? (
                <DropdownMenuItem
                  variant="destructive"
                  disabled={deleting}
                  onClick={() => {
                    const trigger = headerTriggerRef.current;
                    if (trigger) onDelete(trigger);
                  }}
                >
                  <Trash2 /> 删除会话
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Button
        ref={workspaceToggleRef}
        variant="ghost"
        size="icon"
        aria-label={workspaceOpen ? '隐藏会话成果' : '打开会话成果'}
        title={workspaceOpen ? '隐藏会话成果' : '打开会话成果'}
        aria-expanded={workspaceOpen}
        aria-controls={workspacePanelId}
        onClick={onToggleWorkspace}
        className="shrink-0 gap-1.5 text-muted-foreground hover:text-fg lg:w-auto lg:px-2"
      >
        <PanelRightDashed />
        <span className="hidden text-sm lg:inline">会话成果</span>
      </Button>
    </div>
  );
}

/**
 * 重命名草稿的离开保护。同页只换成果（agent/conversation 不变）不会卸载对话框，
 * 其余换会话、换专家、跨页与刷新一律拦下；保存中也不放行。
 */
function useRenameBlocker(dirty: boolean, pending: boolean) {
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => {
      // 只改成果选择不算离开：对话框与草稿都还在。
      const sameSession =
        current.pathname === next.pathname &&
        'agent' in current.search &&
        'agent' in next.search &&
        current.search.agent === next.search.agent &&
        'conversation' in current.search &&
        'conversation' in next.search &&
        current.search.conversation === next.search.conversation;
      if (sameSession) return false;
      return dirty || pending;
    },
    withResolver: true,
    enableBeforeUnload: dirty || pending,
  });
  return {
    ...blocker,
    // 保存中不提供离开确认，等请求结算后再放行。
    proceed: () => {
      if (!pending) blocker.proceed?.();
    },
  };
}

function RenameDialog({
  title,
  dirty,
  pending,
  blocker,
  onTitleChange,
  onClose,
  onRename,
  finalFocus,
}: {
  title: string;
  dirty: boolean;
  pending: boolean;
  blocker: ReturnType<typeof useRenameBlocker>;
  onTitleChange: (title: string) => void;
  onClose: () => void;
  onRename: (title: string) => void;
  finalFocus: ComponentProps<typeof DialogShell>['finalFocus'];
}) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // 保存按钮在无效时禁用，所以错误要随输入即时给出，而不是只在提交后出现。
  const parsed = conversationRenameSchema.safeParse({ title });
  const error = parsed.success
    ? null
    : (fieldErrors(parsed.error.issues).title ?? '请检查标题后重试');
  const saveDisabled = !parsed.success || !dirty || pending;
  // 未改动、无效或请求中都不能提交；脏时关闭先确认，请求中一律不关。
  const close = (): void => {
    if (pending) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (saveDisabled || !parsed.success) return;
    onRename(parsed.data.title);
  };

  const leaving = blocker.status === 'blocked';
  const discardOpen = confirmDiscard || leaving;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogShell title="重命名会话" closeDisabled={pending} finalFocus={finalFocus}>
        <form noValidate onSubmit={submit} className="flex flex-col gap-4">
          <Field className="gap-1.5" data-invalid={Boolean(error)}>
            <FieldLabel htmlFor="conversation-title">
              标题 <RequiredMark />
            </FieldLabel>
            <Input
              id="conversation-title"
              value={title}
              disabled={pending}
              aria-required="true"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'conversation-title-error' : undefined}
              onChange={(event) => onTitleChange(event.target.value)}
            />
            <FieldError id="conversation-title-error">{error}</FieldError>
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" disabled={saveDisabled} aria-busy={pending}>
              {pending ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
        <ConfirmDialog
          open={discardOpen}
          onClose={() => {
            if (leaving) blocker.reset?.();
            setConfirmDiscard(false);
          }}
          title="放弃未保存的更改？"
          description={
            pending
              ? '正在保存，请等待请求完成。'
              : leaving
                ? '离开后这次修改的标题会丢失。'
                : '关闭后这次修改的标题会丢失。'
          }
          confirmLabel={leaving ? '放弃并离开' : '放弃并关闭'}
          confirmDisabled={pending}
          onConfirm={async () => {
            if (pending) return;
            if (leaving) {
              // 同页换会话不会卸载工作区：放弃后先收起对话框，再放行导航。
              blocker.proceed();
              onClose();
            } else onClose();
          }}
        />
      </DialogShell>
    </Dialog>
  );
}

function HistoryHeader({
  onNew,
  onClose,
  agent,
  agentId,
  agentOptions,
  onSwitchAgent,
}: {
  onNew: () => void;
  onClose?: () => void;
  agent?: AgentSummary | null;
  agentId?: string | null;
  agentOptions?: Array<{ value: string; label: string; agent?: AgentSummary }>;
  onSwitchAgent?: (id: string) => void;
}) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-1 px-3">
      {agentOptions && onSwitchAgent ? (
        <div className="min-w-0 flex-1">
          <AgentPicker
            agent={agent ?? null}
            agentId={agentId ?? null}
            agentOptions={agentOptions}
            onSwitchAgent={onSwitchAgent}
          />
        </div>
      ) : (
        <div className="flex-1" />
      )}
      <Button
        variant="ghost"
        size="icon"
        aria-label="新建会话"
        title="新建会话"
        onClick={() => onNew()}
      >
        <Plus />
      </Button>
      {onClose ? (
        <Button variant="ghost" size="icon" aria-label="关闭会话列表" onClick={onClose}>
          <X className="size-3" />
        </Button>
      ) : null}
    </div>
  );
}

interface HistoryEntry {
  id: string;
  title: string;
  updatedAt: string;
}

function HistoryPanel({
  history,
  pending,
  hasAgent,
  error,
  onRetry,
  conversationId,
  branching,
  onOpen,
  onBranch,
  onOpenSearch,
  onRename,
}: {
  history: HistoryEntry[];
  pending: boolean;
  hasAgent: boolean;
  error: unknown;
  onRetry: () => void;
  conversationId: string | null;
  branching: string | null;
  onOpen: (id: string) => void;
  onBranch: (id: string) => void;
  onOpenSearch: (trigger: HTMLElement) => void;
  onRename: (conversation: HistoryEntry, trigger: HTMLElement) => void;
}) {
  // 同一时刻只开一个菜单：触发器的 DOM 身份在点击时记下，菜单项卸载后仍能把焦点交还。
  const menuTriggerRef = useRef<HTMLElement | null>(null);
  return (
    <>
      <div className="shrink-0 px-3">
        <Button
          variant="outline"
          onClick={(event) => onOpenSearch(event.currentTarget)}
          className="h-8 w-full justify-start gap-2 px-2.5 font-normal text-muted-foreground"
        >
          <Search aria-hidden="true" className="size-4" />
          <span className="min-w-0 flex-1 truncate text-left text-sm">搜索全部会话</span>
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {pending ? <LoadingState rows={4} /> : null}
        {error ? <ErrorState error={error} onRetry={onRetry} /> : null}
        {history.length === 0 && !pending && !error ? (
          <p className="px-2 py-5 text-sm text-muted-foreground">
            {hasAgent ? '开始对话后，记录会出现在这里。' : '先选择专家。'}
          </p>
        ) : null}
        <ul className="flex flex-col gap-0.5">
          {history.map((conversation) => (
            <li key={conversation.id} className="group relative">
              <Button
                variant="ghost"
                aria-current={conversation.id === conversationId ? 'true' : undefined}
                onClick={() => onOpen(conversation.id)}
                // Keep normal-weight history text, muted inactive labels, and the translucent row hover.
                className={cn(
                  'h-auto w-full min-w-0 flex-col items-start gap-0 whitespace-normal px-2.5 py-2 pr-8 text-left font-normal',
                  conversation.id === conversationId
                    ? 'bg-selected text-selected-foreground hover:bg-selected hover:text-selected-foreground'
                    : 'text-muted-foreground hover:bg-hover',
                )}
              >
                <span className="block w-full truncate text-sm">{conversation.title}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {formatRelative(conversation.updatedAt)}
                </span>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`操作「${conversation.title}」`}
                      disabled={branching !== null}
                      className="absolute right-1 top-2.5 [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:transition-opacity [@media(hover:hover)_and_(pointer:fine)]:duration-150 ease-out-soft focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 data-popup-open:opacity-100"
                      onClick={(event) => {
                        menuTriggerRef.current = event.currentTarget;
                      }}
                    >
                      {branching === conversation.id ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                      ) : (
                        <MoreHorizontal className="size-3.5" />
                      )}
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" sideOffset={4} className="w-40">
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      onClick={() => {
                        if (menuTriggerRef.current) {
                          onRename(conversation, menuTriggerRef.current);
                        }
                      }}
                    >
                      <Pencil /> 重命名
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      aria-label={`从「${conversation.title}」分支`}
                      disabled={branching !== null}
                      onClick={() => onBranch(conversation.id)}
                    >
                      {branching === conversation.id ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        <GitBranch />
                      )}
                      分支
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function ChatColumn({
  header,
  agent,
  conversationId,
  detail,
  agentsError,
  onRetryAgents,
  historyReady,
  runApprovals,
  onRetryStream,
  reconcileRun,
  items,
  phase,
  lastRun,
  lastRunId,
  approving,
  cancelling,
  approvalItems,
  questionsByToolUseId,
  questionsError,
  onRetryQuestions,
  liveRunId,
  onApprove,
  onCancel,
  onPickSuggestion,
  onBranchMessage,
  onSelectOutput,
  branchingMessageId,
  onLoadOlder,
  hasOlder,
  loadingOlder,
  showWelcome,
  send,
  composerRef,
}: {
  /** 消息列专属头部，在消息页内、消息流之前渲染。 */
  header: ReactNode;
  agent: AgentSummary | null;
  conversationId: string | null;
  detail: ReturnType<typeof useConversation>;
  agentsError: unknown | null;
  onRetryAgents: () => void;
  historyReady: boolean;
  runApprovals: ReturnType<typeof useRunApprovals>;
  onRetryStream: () => void;
  reconcileRun: ReturnType<typeof useChatStream>['reconcileRun'];
  items: ChatItem[];
  phase: ChatPhase;
  lastRun: RunMetrics | null;
  lastRunId: string | null;
  approving: string | null;
  cancelling: boolean;
  approvalItems: ApprovalRequest[];
  questionsByToolUseId: ReadonlyMap<string, PublicRunQuestion>;
  questionsError: unknown | null;
  onRetryQuestions: () => void;
  liveRunId: string | null;
  onApprove: (item: ApprovalRequest) => void;
  onCancel: () => void;
  onPickSuggestion: (text: string) => void;
  onBranchMessage: (conversationId: string, messageId: string) => void;
  onSelectOutput: (selection: OutputSelection) => void;
  branchingMessageId: string | null;
  onLoadOlder: () => void;
  hasOlder: boolean;
  loadingOlder: boolean;
  showWelcome: boolean;
  send: ReturnType<typeof useChatStream>['send'];
  composerRef: RefObject<HTMLTextAreaElement | null>;
}) {
  // 组件动作走同一条发送路径；send 每次渲染都是新函数，用 ref 保住 MessagePart 的 memo。
  const sendRef = useRef(send);
  sendRef.current = send;
  // 动作本身就是一条完整的下一轮输入：正文用按钮说明，params/context/表单值原样带走。
  // 不走输入框（不 setInput），因此用户没发出的草稿不会被覆盖。
  const openUiAction = useCallback((action: OpenUiAction) => {
    void sendRef.current(action.message, action);
  }, []);
  /**
   * Query/Mutation 走服务端工具桥。来源由渲染层按段闭包提供：
   * 历史 UI、多条消息、同一消息的多个段都不会归错。
   */
  const openUiToolCall = useCallback(
    (input: OpenUiToolCallInput) =>
      api.callOpenUiTool(input.conversationId, input.toolName, {
        args: input.args,
        messageId: input.messageId,
        blockKey: input.blockKey,
      }),
    [],
  );
  const openUiSaveState = useCallback(
    (input: OpenUiStateSaveInput) =>
      api.saveOpenUiState(input.conversationId, input.messageId, {
        blockKey: input.blockKey,
        state: input.state,
      }),
    [],
  );
  const openUiApprove = useCallback(
    (input: OpenUiApprovalInput) => api.approveOpenUiTool(input.conversationId, input.approvalId),
    [],
  );
  // 回调身份固定：每段渲染器都靠 ref 读取它们，重新渲染不会重新挂载生成内容。
  const openUiSnapshot = useMemo(
    () => ({
      ...(conversationId === null ? {} : { conversationId }),
      onToolCall: openUiToolCall,
      onSaveState: openUiSaveState,
      onApprove: openUiApprove,
    }),
    [conversationId, openUiToolCall, openUiSaveState, openUiApprove],
  );
  const composer = (
    <Composer
      agent={agent}
      send={send}
      textareaRef={composerRef}
      lastRunId={lastRunId}
      welcome={showWelcome}
      historyReady={historyReady}
      cancelling={cancelling}
      onCancel={onCancel}
    />
  );

  // 两个入参直接来自 query 数据；缓存住身份，流式期间 WebSocket 增量不会让工具行的 memo 失效。
  // 运行进入终态后仍需展示未批准的兜底审批，供用户批准后续调用，因此不按 run 过滤。
  const pendingApprovals = useMemo(
    () => approvalItems.filter((item) => item.approvedAt === null && item.deniedAt === null),
    [approvalItems],
  );
  const approvals = useMemo(() => ({ pending: approving, onApprove }), [approving, onApprove]);
  const runFooter =
    phase.kind !== 'idle' ? (
      <RunFooter phase={phase} items={items} onRetry={onRetryStream} />
    ) : null;
  // 历史轮次的读数由会话详情一次带回；运行中的 run 交给 runFooter，不在这里显示。
  const historyMetrics = useMemo(() => {
    const map = new Map<string, RunMetrics>();
    for (const run of detail.data?.runMetrics ?? []) {
      if (run.status === 'queued' || run.status === 'running') continue;
      map.set(run.runId, {
        runId: run.runId,
        status: run.status,
        ...(run.turns === null ? {} : { turns: run.turns }),
        ...(run.durationMs === null ? {} : { durationMs: run.durationMs }),
        ...(run.tokens === null ? {} : { tokens: run.tokens }),
        ...(run.costUsd === null ? {} : { costUsd: run.costUsd }),
        ...(run.error === null ? {} : { error: run.error }),
        ...(run.endedAt === null ? {} : { endedAt: run.endedAt }),
      });
    }
    return map;
  }, [detail.data]);
  // 成果按 run 归属；同一路径的旧版仍留在产生它的那一轮，不并到最新路径。
  const outputs = useConversationOutputs(conversationId);
  const outputsByRun = useMemo(() => {
    const map = new Map<string, OutputFile[]>();
    for (const file of outputs.data?.items ?? []) {
      const files = map.get(file.runId);
      if (files) files.push(file);
      else map.set(file.runId, [file]);
    }
    for (const files of map.values()) files.sort((a, b) => a.path.localeCompare(b.path));
    return map;
  }, [outputs.data]);
  // 维护与分支会清空消息上的 run_id；manifest 锚点仍指向保留/重写后的边界消息。
  const outputsByAnchor = useMemo(() => {
    const map = new Map<string, OutputFile[]>();
    for (const file of outputs.data?.items ?? []) {
      for (const anchor of new Set([file.userMessageId, file.afterMessageId])) {
        const files = map.get(anchor);
        if (files) files.push(file);
        else map.set(anchor, [file]);
      }
    }
    for (const files of map.values()) files.sort((a, b) => a.path.localeCompare(b.path));
    return map;
  }, [outputs.data]);

  return (
    <Page className="h-full min-h-0 flex-1 gap-0 overflow-hidden bg-surface">
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <MessagePane
          items={items}
          loading={detail.isPending && conversationId !== null && phase.kind === 'idle'}
          error={detail.isError ? detail.error : null}
          onRetry={() => void detail.refetch()}
          hasOlder={hasOlder}
          loadingOlder={loadingOlder}
          onLoadOlder={onLoadOlder}
          olderDisabled={detail.isFetching || phase.kind !== 'idle'}
          approvals={approvals}
          approvalItems={pendingApprovals}
          questionsByToolUseId={questionsByToolUseId}
          liveRunId={liveRunId}
          lastRun={lastRun}
          historyMetrics={historyMetrics}
          runFooter={runFooter}
          currentRunId={isActivePhase(phase) ? phase.runId : lastRunId}
          runOutputs={{
            byRun: outputsByRun,
            byAnchor: outputsByAnchor,
            hasNextPage: outputs.hasNextPage,
            loadingMore: outputs.isFetchingNextPage,
            onLoadMore: () => void outputs.fetchNextPage(),
          }}
          onSelectOutput={onSelectOutput}
          onBranchMessage={(messageId) => {
            if (conversationId) onBranchMessage(conversationId, messageId);
          }}
          branchingMessageId={branchingMessageId}
          running={phase.kind !== 'idle'}
          openUi={agent?.uiFormat === 'openui'}
          streaming={phase.kind !== 'idle'}
          onAction={openUiAction}
          openUiSnapshot={openUiSnapshot}
          welcome={showWelcome ? <WelcomeState /> : null}
        />

        {/* 运行状态跟着最后一轮走，不再单独占一条横栏；对屏幕阅读器仍播报同一句。 */}
        <div aria-live="polite" role="status" className="sr-only">
          {phase.kind !== 'idle' ? runStatusText(phase, items) : ''}
        </div>
        {isActivePhase(phase) ? (
          <RunReconciliation phase={phase} reconcileRun={reconcileRun} />
        ) : null}
        {agentsError ? (
          <ErrorState
            error={agentsError}
            onRetry={onRetryAgents}
            title="专家列表刷新失败，保留当前会话"
          />
        ) : null}
        {runApprovals.isError ? (
          <ErrorState error={runApprovals.error} onRetry={() => void runApprovals.refetch()} />
        ) : null}
        {questionsError ? (
          <ErrorState
            title="提问状态没有加载出来"
            error={questionsError}
            onRetry={onRetryQuestions}
          />
        ) : null}

        {/* 建议入口在输入框上方 8px，只有欢迎且已选专家时出现；点击只填草稿。 */}
        {showWelcome && agent ? (
          <div className="mx-auto flex w-full max-w-220 shrink-0 flex-wrap gap-2 px-6 pb-2">
            {welcomeSuggestions.map(({ label, icon: Icon, prompt }) => (
              <Button
                key={label}
                variant="outline"
                size="sm"
                type="button"
                onClick={() => onPickSuggestion(prompt)}
              >
                <Icon data-icon="inline-start" />
                {label}
              </Button>
            ))}
          </div>
        ) : null}
        {composer}
      </div>
    </Page>
  );
}

/** 与 shared 扩展名映射保持一致：映射不接受的写法不会进入选择器。 */
const welcomeSuggestions = [
  {
    label: '梳理思路',
    icon: MessageSquare,
    prompt: '帮我梳理一个想法，先通过提问了解我的目标，再整理出重点。',
  },
  {
    label: '制定计划',
    icon: Check,
    prompt: '帮我把一个目标拆成可执行的步骤，先询问我需要完成什么。',
  },
  {
    label: '整理内容',
    icon: Pencil,
    prompt: '帮我整理一段内容，先询问我需要整理的材料和期望的输出。',
  },
  { label: '分析问题', icon: Wrench, prompt: '帮我分析一个问题，先了解背景、现象和已有尝试。' },
] as const;

function WelcomeState() {
  return (
    <div className="flex w-full flex-col gap-6 py-10 sm:py-12">
      <div className="flex flex-wrap items-center gap-4 sm:gap-5">
        <img
          src="/brand/pace-chat-woodworker.svg"
          alt=""
          aria-hidden="true"
          width={916}
          height={637}
          className="h-auto w-24 shrink-0 object-contain"
        />
        <h2 className="min-w-0 flex-1 text-2xl font-medium tracking-[-0.02em] text-fg">
          今天想完成什么？
        </h2>
      </div>
    </div>
  );
}
