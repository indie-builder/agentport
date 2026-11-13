import type { AgentSummary, ConversationSearchItem, OutputRef } from '@agentport/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Bot } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels';
import {
  ConversationOutputs,
  type OutputSelection,
} from '../../components/chat/conversation-outputs.js';
import { ConversationSearch } from '../../components/chat/conversation-search.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { Page, PageHeader } from '../../components/page.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/states.js';
import { Button } from '../../components/ui/button.js';
import { Sheet, SheetContent, SheetTitle } from '../../components/ui/sheet.js';
import { type ApprovalRequest, api } from '../../lib/api.js';
import { mergeOlderHistory, titleFromDetail } from '../../lib/chat-state.js';
import { isActivePhase, useChatStore } from '../../lib/chat-store.js';
import { useFormBlocker } from '../../lib/form.js';
import {
  chatKeys,
  useAgents,
  useConversation,
  useConversations,
  useRunApprovals,
  useRunQuestions,
} from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useChatStream } from '../../lib/use-chat-stream.js';
import { useMediaQuery } from '../../lib/use-media-query.js';
import { ChatColumn } from './chat-column.js';
import { ChatTopBar } from './chat-top-bar.js';
import { HistoryHeader } from './history-header.js';
import { type HistoryEntry, HistoryPanel } from './history-panel.js';
import { RenameDialog, useRenameBlocker } from './rename-dialog.js';

const EMPTY_AGENTS: AgentSummary[] = [];

export function ChatPage() {
  const search = useSearch({ from: '/_shell/chat' });
  const navigate = useNavigate();
  const agents = useAgents();
  const conversationId = search.conversation ?? null;
  const detail = useConversation(conversationId);

  // 已打开会话时，服务端记录才是真相；URL 只是它的镜像。
  const serverAgentId = detail.data?.conversation.agentId ?? null;
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

  // URL 指向的 agent 不存在：不静默改成第一个，免得把消息发给别的 agent。
  if (
    !conversationId &&
    search.agent &&
    agents.isSuccess &&
    !agents.data.some((item) => item.id === search.agent)
  ) {
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
      agents={agents.data ?? EMPTY_AGENTS}
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
            ...(activeAgentId &&
            agents.data?.some((item) => item.id === activeAgentId && !item.isDefault)
              ? { agent: activeAgentId }
              : {}),
            ...(id ? { conversation: id } : {}),
          }),
          replace,
        });
      }}
      onAgentChange={(id) => {
        void navigate({ to: '/chat', search: id === null ? {} : { agent: id } });
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
  onAgentChange: (agentId: string | null) => void;
  onSelectSearchResult: (item: ConversationSearchItem) => void;
}) {
  const agent = agents.find((item) => item.id === agentId) ?? null;
  const defaultAgentId = agents.find((item) => item.isDefault)?.id ?? null;
  const historyAgentId = agentId ?? defaultAgentId;
  const agentOptions = agents
    .filter((item) => item.enabled && !item.isDefault)
    .map((item) => ({
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

  const conversations = useConversations(historyAgentId);
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
    if (!running && items.length === 0) composerRef.current?.focus();
  }, [running, items.length]);

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

  const switchAgent = (id: string | null): void => {
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
      pending={historyAgentId !== null && conversations.isPending}
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
      agentId={agentId}
      conversationId={conversationId}
      detail={detail}
      agentsError={agentsError}
      onRetryAgents={onRetryAgents}
      historyReady={
        conversationId === null || (agentId !== null && hydrated.current === conversationId)
      }
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
