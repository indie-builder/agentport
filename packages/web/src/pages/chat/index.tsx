import type { AgentSummary, ConversationSearchItem, OutputRef } from '@agentport/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  createResizableController,
  Resizable,
  ResizableHandle,
  ResizablePanel,
  type ResizableSize,
} from '@ui-sdk/react/resizable';
import { Bot } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  useApproveRun,
  useCancelRun,
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

  const serverAgentId = detail.data?.conversation.agentId ?? null;
  const activeAgentId = serverAgentId ?? search.agent ?? null;

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

  if (
    !conversationId &&
    search.agent &&
    agents.isSuccess &&
    !agents.data.some((item) => item.id === search.agent)
  ) {
    return (
      <Page className="mx-auto h-full min-h-0 w-full max-w-220 overflow-y-auto p-6">
        <PageHeader title="对话" className="sr-only" />
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
const HISTORY_WIDTH_KEY = 'agentport:chat-history-width';

function storedHistorySize(): ResizableSize {
  try {
    const stored = Number(localStorage.getItem(HISTORY_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 && stored <= 100 ? `${stored}%` : '240px';
  } catch {
    return '240px';
  }
}

function saveHistorySize(width: number): void {
  try {
    localStorage.setItem(HISTORY_WIDTH_KEY, String(width));
  } catch {
    return;
  }
}

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
  const [deletedConversation, setDeletedConversation] = useState<string | null>(null);
  const desktop = useMediaQuery(DESKTOP);
  const wide = useMediaQuery(WIDE);

  const conversations = useConversations(historyAgentId);
  const detail = useConversation(conversationId);
  const runApprovals = useRunApprovals(runId || lastRunId, runId !== null);
  const runQuestions = useRunQuestions(runId || lastRunId, runId !== null);
  const questionsByToolUseId = useMemo(
    () => new Map((runQuestions.data?.items ?? []).map((item) => [item.toolUseId, item])),
    [runQuestions.data],
  );
  const [historyPanels] = useState(createResizableController);
  const [historyCollapsed, setHistoryCollapsed] = useState(true);
  const [initialHistorySize] = useState(storedHistorySize);
  const lastHistorySize = useRef<ResizableSize>(initialHistorySize);
  useEffect(() => {
    if (!desktop || historyCollapsed) return;
    // Resizable 重新挂载后的首轮布局在微任务里初始化，等它完成再恢复宽度。
    queueMicrotask(() => historyPanels.resize('history', lastHistorySize.current));
  }, [desktop, historyCollapsed, historyPanels]);
  const [workspaceOpen, setWorkspaceOpen] = useState(output !== null);
  const [search, setSearch] = useState<{ trigger: HTMLElement; inSheet: boolean } | null>(null);
  const workspaceFeedbackRef = useRef(false);
  const reduce = useReducedMotion();

  const approvalData = useMemo(() => runApprovals.data?.items ?? [], [runApprovals.data]);

  const stream = useChatStream({
    agentId,
    history: detail,
    onAccepted: (accepted) => {
      onConversationChange(accepted.conversationId, true);
    },
  });

  useEffect(
    () => () => {
      const store = useChatStore.getState();
      store.resetConversation(null);
      store.setHistoryOpen(false);
    },
    [],
  );

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

  const cancelMutation = useCancelRun();

  const approvalInFlight = useRef(false);
  const approveMutation = useApproveRun();

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
    },
    onError: (error) => toastError(error),
  });

  const renameDirty = renaming ? renaming.draft.trim() !== renaming.entry.title : false;
  const renameBlocker = useRenameBlocker(renameDirty, renameMutation.isPending);
  useEffect(() => {
    if (renaming || renameMutation.isPending || renameBlocker.status !== 'blocked') return;
    renameBlocker.proceed?.();
  }, [renaming, renameMutation.isPending, renameBlocker]);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteConversation(id),
    onSuccess: (_data, id) => {
      void client.invalidateQueries({ queryKey: chatKeys.conversations() });
      void client.invalidateQueries({ queryKey: chatKeys.conversation(id) });
      void client.invalidateQueries({ queryKey: ['runs'] });
      void client.invalidateQueries({ queryKey: ['overview'] });
      if (id === conversationId) setDeletedConversation(id);
      toastSuccess('会话已删除');
    },
  });
  const deleteBlocker = useFormBlocker(false, deleteMutation.isPending);

  const cancel = (): void => {
    if (!runId) return;
    cancelMutation.mutate(runId, { onError: (error) => toastError(error) });
  };

  const attachOutputRef = useCallback((ref: OutputRef): void => {
    useChatStore.getState().setOutputRef(ref);
    composerRef.current?.focus();
  }, []);

  const approve = useCallback(
    (item: ApprovalRequest): void => {
      const activeRunId = runId || lastRunId;
      if (!activeRunId || approvalInFlight.current) return;
      approvalInFlight.current = true;
      approveMutation.mutate(
        { runId: activeRunId, serverId: item.serverId, toolName: item.toolName },
        {
          onSettled: () => {
            approvalInFlight.current = false;
          },
          onSuccess: (data) =>
            toastSuccess(
              data.waiting
                ? `已批准 ${item.toolName}；仍在等待的调用可继续，无需重发消息`
                : '已记录后续调用许可；本次调用不会恢复。',
            ),
          onError: (error) => toastError(error),
        },
      );
    },
    [runId, lastRunId, approveMutation.mutate],
  );

  const openConversation = (id: string): void => {
    if (id !== conversationId) onConversationChange(id);
    setHistoryOpen(false);
  };

  const newConversation = useCallback(
    (carryDraft = false): void => {
      stream.resetWorkspace(null, carryDraft);
      onConversationChange(null);
      setHistoryOpen(false);
      composerRef.current?.focus();
    },
    [stream.resetWorkspace, onConversationChange, setHistoryOpen],
  );

  useEffect(() => {
    if (!deletedConversation || deleteMutation.isPending) return;
    setDeletedConversation(null);
    if (deleteBlocker.status === 'blocked') deleteBlocker.reset?.();
    newConversation(true);
  }, [deletedConversation, deleteMutation.isPending, deleteBlocker, newConversation]);

  const branch = (id: string, fromMessageId?: string): void =>
    branchMutation.mutate({
      id,
      ...(fromMessageId === undefined ? {} : { fromMessageId }),
      ownsRequest: stream.captureRequest(),
    });

  useEffect(() => {
    if (useChatStore.getState().conversationId === conversationId) return;
    stream.resetWorkspace(conversationId);
  }, [conversationId, stream.resetWorkspace]);

  const hydrated = stream.hydratedRef;
  const { historyPrefix, setHistoryPrefix } = stream;

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
    stream.resetWorkspace(null, true);
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
          if (historyCollapsed) historyPanels.resize('history', lastHistorySize.current);
          else historyPanels.collapse('history');
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
      approving={
        approveMutation.isPending
          ? (approvalData.find(
              (item) =>
                item.serverId === approveMutation.variables?.serverId &&
                item.toolName === approveMutation.variables?.toolName,
            )?.id ?? null)
          : null
      }
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
      onRegenerate={() => void stream.regenerate()}
      regenerating={stream.regenerating}
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
      onRename={(title) => renameMutation.mutateAsync({ id: renaming.entry.id, title })}
      // 菜单项随菜单卸载；触发器还在就回到它，否则交给 ui-sdk 的默认落点。
      finalFocus={() => (renaming.trigger.isConnected ? renaming.trigger : null)}
    />
  ) : null;

  const deleteDialog = deleteTarget ? (
    <ConfirmDialog
      open
      onClose={() => setDeleteTarget(null)}
      title="删除会话？"
      description={`「${deleteTarget.title}」及其消息、运行记录会被永久删除，无法恢复。`}
      confirmLabel="删除会话"
      onConfirm={() => deleteMutation.mutateAsync(deleteTarget.id)}
      finalFocus={() =>
        deleteTarget.trigger.isConnected && !deleteTarget.trigger.matches(':disabled')
          ? deleteTarget.trigger
          : composerRef.current
      }
    />
  ) : null;

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

  if (conversationId && detail.isError && items.length === 0 && !running) {
    return (
      <Page className="mx-auto h-full min-h-0 w-full max-w-220 overflow-y-auto p-6">
        <PageHeader title="对话" className="sr-only" />
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

  if (conversationId && !running && items.length === 0 && hydrated.current !== conversationId) {
    return (
      <Page className="mx-auto h-full min-h-0 w-full max-w-220 overflow-y-auto p-6">
        <PageHeader title="对话" className="sr-only" />
        <LoadingState rows={4} />
      </Page>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0">
      {/* 窄屏抽屉由 ui-sdk 管理焦点、Escape 与滚动锁。 */}
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
          {desktop ? null : renameDialog}
          {search?.inSheet ? searchDialog : null}
        </SheetContent>
      </Sheet>

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
          <Resizable
            orientation="horizontal"
            controller={historyPanels}
            className="min-h-0 w-full"
            onLayoutCommit={(next, details) => {
              if (details.reason !== 'drag' && details.reason !== 'step-key') return;
              const width = next[0];
              if (width !== undefined && width > 0) saveHistorySize(width);
            }}
            onLayoutChange={(next) => {
              const width = next[0];
              if (width !== undefined && width > 0) lastHistorySize.current = `${width}%`;
              setHistoryCollapsed(width === 0);
            }}
          >
            <ResizablePanel
              id="history"
              defaultSize={historyCollapsed ? 0 : lastHistorySize.current}
              minSize="200px"
              maxSize="360px"
              collapsible
            >
              {historyCollapsed ? null : (
                <aside
                  id="chat-history"
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
            </ResizablePanel>
            <ResizableHandle
              disabled={historyCollapsed}
              className={historyCollapsed ? 'hidden' : 'w-px border-r'}
              aria-label="调整会话列表宽度"
            />
            <ResizablePanel id="chat" minSize={wide && workspaceOpen ? '800px' : '400px'}>
              <div className="flex h-full min-h-0">
                <div className="relative min-w-0 flex-1">{column}</div>
                {wide ? (
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
            </ResizablePanel>
          </Resizable>
          {renameDialog}
          {deleteDialog}
          {deleteLeaveDialog}
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {column}
          {historyOpen ? null : renameDialog}
          {deleteDialog}
          {deleteLeaveDialog}
        </div>
      )}
      {search && !search.inSheet ? searchDialog : null}
    </div>
  );
}
