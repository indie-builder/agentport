import type { AgentSummary, OpenUiAction, OutputFile, PublicRunQuestion } from '@agentport/shared';
import { type ReactNode, type RefObject, useCallback, useMemo, useRef } from 'react';
import { Composer } from '../../components/chat/chat-thread/composer.js';
import { MessagePane } from '../../components/chat/chat-thread/message-pane.js';
import {
  RunFooter,
  RunReconciliation,
  runStatusText,
} from '../../components/chat/chat-thread/run-footer.js';
import type { OutputSelection } from '../../components/chat/conversation-outputs.js';
import { Page } from '../../components/page.js';
import { ErrorState } from '../../components/states.js';
import { Button } from '../../components/ui/button.js';
import { type ApprovalRequest, api } from '../../lib/api.js';
import type { ChatItem } from '../../lib/chat-state.js';
import { type ChatPhase, isActivePhase, type RunMetrics } from '../../lib/chat-store.js';
import {
  type useConversation,
  useConversationOutputs,
  type useRunApprovals,
} from '../../lib/queries.js';
import { toast } from '../../lib/toast.js';
import type { useChatStream } from '../../lib/use-chat-stream.js';
import type {
  OpenUiApprovalInput,
  OpenUiStateSaveInput,
  OpenUiToolCallInput,
} from '../../openui/renderer.js';
import { WelcomeState, welcomeSuggestionsFor } from './welcome-state.js';

export function ChatColumn({
  header,
  agent,
  agentId,
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
  denying,
  cancelling,
  approvalItems,
  questionsByToolUseId,
  questionsError,
  onRetryQuestions,
  liveRunId,
  onApprove,
  onDeny,
  onCancel,
  onPickSuggestion,
  onBranchMessage,
  onSelectOutput,
  branchingMessageId,
  onRegenerate,
  regenerating,
  onLoadOlder,
  hasOlder,
  loadingOlder,
  showWelcome,
  send,
  composerRef,
}: {
  header: ReactNode;
  agent: AgentSummary | null;
  agentId: string | null;
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
  denying: string | null;
  cancelling: boolean;
  approvalItems: ApprovalRequest[];
  questionsByToolUseId: ReadonlyMap<string, PublicRunQuestion>;
  questionsError: unknown | null;
  onRetryQuestions: () => void;
  liveRunId: string | null;
  onApprove: (item: ApprovalRequest) => void;
  onDeny: (item: ApprovalRequest) => void;
  onCancel: () => void;
  onPickSuggestion: (text: string) => void;
  onBranchMessage: (conversationId: string, messageId: string) => void;
  onSelectOutput: (selection: OutputSelection) => void;
  branchingMessageId: string | null;
  onRegenerate: () => void;
  regenerating: boolean;
  onLoadOlder: () => void;
  hasOlder: boolean;
  loadingOlder: boolean;
  showWelcome: boolean;
  send: ReturnType<typeof useChatStream>['send'];
  composerRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const sendRef = useRef(send);
  sendRef.current = send;
  const phaseKindRef = useRef(phase.kind);
  phaseKindRef.current = phase.kind;
  const openUiAction = useCallback((action: OpenUiAction) => {
    if (phaseKindRef.current !== 'idle') {
      toast.info('当前回复正在生成，请完成后再操作');
      return;
    }
    void sendRef.current(action.message, action);
  }, []);
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
      enabled={agentId === null || agent !== null}
      send={send}
      textareaRef={composerRef}
      welcome={showWelcome}
      historyReady={historyReady}
      cancelling={cancelling}
      onCancel={onCancel}
    />
  );

  const pendingApprovals = useMemo(
    () => approvalItems.filter((item) => item.approvedAt === null && item.deniedAt === null),
    [approvalItems],
  );
  const approvals = useMemo(
    () => ({ pending: approving, denying, onApprove, onDeny }),
    [approving, denying, onApprove, onDeny],
  );
  const runFooter =
    phase.kind !== 'idle' ? (
      <RunFooter phase={phase} items={items} onRetry={onRetryStream} />
    ) : null;
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
          onRegenerate={onRegenerate}
          regenerating={regenerating}
          running={phase.kind !== 'idle'}
          openUi={agent?.uiFormat === 'openui'}
          streaming={phase.kind !== 'idle'}
          onAction={openUiAction}
          openUiSnapshot={openUiSnapshot}
          welcome={
            showWelcome && (agentId === null || agent !== null) ? (
              <WelcomeState agent={agent} />
            ) : null
          }
        />

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

        {showWelcome && (agentId === null || agent !== null) ? (
          <div className="mx-auto flex w-full max-w-220 shrink-0 flex-wrap gap-2 px-6 pb-2">
            {welcomeSuggestionsFor(agent).map(({ label, icon: Icon, prompt }) => (
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
