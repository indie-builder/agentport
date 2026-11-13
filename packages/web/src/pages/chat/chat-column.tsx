import type { AgentSummary, OpenUiAction, OutputFile, PublicRunQuestion } from '@agentport/shared';
import { Check, MessageSquare, Pencil, Wrench } from 'lucide-react';
import { type ReactNode, type RefObject, useCallback, useMemo, useRef } from 'react';
import {
  Composer,
  MessagePane,
  RunFooter,
  RunReconciliation,
  runStatusText,
} from '../../components/chat/chat-thread.js';
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
import type { useChatStream } from '../../lib/use-chat-stream.js';
import type {
  OpenUiApprovalInput,
  OpenUiStateSaveInput,
  OpenUiToolCallInput,
} from '../../openui/renderer.js';
import { WelcomeState } from './welcome-state.js';

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
      enabled={agentId === null || agent !== null}
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

        {showWelcome && (agentId === null || agent !== null) ? (
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
