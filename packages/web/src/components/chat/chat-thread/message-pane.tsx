import {
  type OpenUiAction,
  type OutputFile,
  type PublicRunQuestion,
  segmentOpenUi,
} from '@agentport/shared';
import { ArrowDown, GitBranch, LoaderCircle, RotateCcw } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import type { ApprovalRequest } from '../../../lib/api.js';
import { type ChatItem, latestTopLevelTodos } from '../../../lib/chat-state.js';
import type { RunMetrics } from '../../../lib/chat-store.js';
import { cn } from '../../../lib/cn.js';
import { formatDateTime } from '../../../lib/format.js';
import { CopyButton } from '../../copy-button.js';
import { RunOutputs } from '../../run/run-outputs.js';
import { ErrorState, LoadingState } from '../../states.js';
import { Button } from '../../ui/button.js';
import { Message, MessageContent, MessageGroup } from '../../ui/message.js';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerVisibility,
} from '../../ui/message-scroller.js';
import type { OutputSelection } from '../conversation-outputs.js';
import { ApprovalCard } from './approval.js';
import { MessagePart, type OpenUiSnapshot } from './message-part.js';
import { RunMetricsLine } from './run-metrics.js';
import { TodoProgress } from './todo-progress.js';
import {
  assignApprovals,
  buildStructure,
  foldableToolRoots,
  isTool,
  NO_KIDS,
  stableTools,
  ToolGroup,
  type ToolItem,
  TurnTrace,
} from './trace.js';

function VisibleMessageIdsTracker({ onChange }: { onChange: (ids: string[]) => void }) {
  const { visibleMessageIds } = useMessageScrollerVisibility();
  useEffect(() => {
    onChange(visibleMessageIds);
  }, [visibleMessageIds, onChange]);
  return null;
}

export function MessagePane({
  items,
  loading,
  error,
  onRetry,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  olderDisabled,
  welcome,
  approvals,
  approvalItems,
  questionsByToolUseId,
  liveRunId,
  lastRun,
  historyMetrics,
  runFooter,
  currentRunId,
  runOutputs,
  onSelectOutput,
  onBranchMessage,
  branchingMessageId,
  onRegenerate,
  regenerating,
  running,
  openUi,
  streaming,
  onAction,
  openUiSnapshot,
  renderItemHeader,
  renderItemFooter,
  onVisibleMessageIdsChange,
  scrollPreviousItemPeek,
}: {
  items: ChatItem[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder?: () => void;
  olderDisabled: boolean;
  welcome: ReactNode;
  approvals?: {
    pending: string | null;
    denying?: string | null;
    onApprove: (item: ApprovalRequest) => void;
    onDeny?: (item: ApprovalRequest) => void;
  };
  approvalItems: ApprovalRequest[];
  questionsByToolUseId?: ReadonlyMap<string, PublicRunQuestion>;
  liveRunId?: string | null;
  lastRun: RunMetrics | null;
  historyMetrics: ReadonlyMap<string, RunMetrics>;
  runFooter?: ReactNode;
  currentRunId: string | null;
  runOutputs?: {
    byRun: ReadonlyMap<string, OutputFile[]>;
    byAnchor: ReadonlyMap<string, OutputFile[]>;
    hasNextPage: boolean;
    loadingMore: boolean;
    onLoadMore: () => void;
  };
  onSelectOutput?: (selection: OutputSelection) => void;
  onBranchMessage?: (messageId: string) => void;
  branchingMessageId: string | null;
  onRegenerate?: () => void;
  regenerating?: boolean;
  running: boolean;
  openUi: boolean;
  streaming: boolean;
  onAction?: ((action: OpenUiAction) => void) | undefined;
  openUiSnapshot?: OpenUiSnapshot;
  renderItemHeader?: (item: ChatItem) => ReactNode;
  renderItemFooter?: (item: ChatItem) => ReactNode;
  onVisibleMessageIdsChange?: (ids: string[]) => void;
  scrollPreviousItemPeek?: number;
}) {
  const reduce = useReducedMotion();
  const turns = useMemo(
    () => messageTurns(items, Boolean(lastRun) || running || approvalItems.length > 0),
    [items, lastRun, running, approvalItems],
  );
  const prevTools = useRef<ToolItem[]>([]);

  const tools = useMemo(() => stableTools(items, prevTools.current), [items]);
  prevTools.current = tools;
  const structure = useMemo(() => buildStructure(tools), [tools]);

  const latestTurn = turns.at(-1);
  const previousUiProgram = useMemo(() => {
    if (!streaming) return undefined;
    for (let turnIndex = turns.length - 2; turnIndex >= 0; turnIndex -= 1) {
      const turn = turns[turnIndex];
      if (!turn || turn.user) continue;
      for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
        const item = turn.items[itemIndex];
        if (item?.kind === 'text' && item.parentToolUseId === undefined && item.uiProgram) {
          return item.uiProgram;
        }
      }
    }
    return undefined;
  }, [turns, streaming]);
  const latestOpenUiSnapshot = useMemo(
    () =>
      previousUiProgram === undefined ? openUiSnapshot : { ...openUiSnapshot, previousUiProgram },
    [openUiSnapshot, previousUiProgram],
  );
  const approvalHosts = useMemo(() => {
    if (!latestTurn || latestTurn.user) return new Map<string, ApprovalRequest>();
    return assignApprovals(latestTurn.items.filter(isTool), approvals ? approvalItems : []);
  }, [latestTurn, approvalItems, approvals]);

  const placed = useMemo(() => {
    const ids = new Set<string>();
    for (const approval of approvalHosts.values()) ids.add(approval.id);
    return ids;
  }, [approvalHosts]);

  const tailItem = items.at(-1);
  const appendedUser = tailItem?.kind === 'user' ? tailItem : null;

  return (
    <MessageScrollerProvider
      autoScroll
      defaultScrollPosition="end"
      scrollEdgeThreshold={80}
      {...(scrollPreviousItemPeek === undefined ? {} : { scrollPreviousItemPeek })}
    >
      {onVisibleMessageIdsChange ? (
        <VisibleMessageIdsTracker onChange={onVisibleMessageIdsChange} />
      ) : null}
      <MessageScroller className="h-auto flex-1">
        <MessageScrollerViewport aria-label="对话消息">
          {/* 入口留在视口顶部的正常流里，但不进 Content：原语靠 Content 旧首子项后移识别 prepend。 */}
          {onLoadOlder && (hasOlder || loadingOlder) ? (
            <div className="mx-auto flex w-full max-w-220 justify-center px-6 pt-4">
              <Button
                variant="outline"
                size="sm"
                disabled={loadingOlder || olderDisabled}
                aria-busy={loadingOlder}
                onClick={onLoadOlder}
              >
                {loadingOlder ? '加载中…' : '加载更早消息'}
              </Button>
            </div>
          ) : null}
          <MessageScrollerContent
            className={cn('mx-auto w-full max-w-220 gap-4 px-6', !welcome && 'py-4')}
          >
            {loading ? (
              <MessageScrollerItem messageId="loading">
                <LoadingState rows={4} />
              </MessageScrollerItem>
            ) : null}
            {error ? (
              <MessageScrollerItem messageId="error">
                <ErrorState error={error} onRetry={onRetry} />
              </MessageScrollerItem>
            ) : null}
            {!loading && !error && items.length === 0 && welcome ? (
              <MessageScrollerItem messageId="welcome" className="flex flex-1 flex-col">
                {welcome}
              </MessageScrollerItem>
            ) : null}
            {!loading && items.length > 0
              ? turns.map((turn, turnIndex) => {
                  const messageId = turn.user ? userMessageId(turn.items) : undefined;
                  const firstUser = turn.items.find((item) => item.kind === 'user');
                  const turnSelf = firstUser?.kind === 'user' ? firstUser.self !== false : true;
                  const latest = turnIndex === turns.length - 1;
                  const assistantText = turn.items
                    .flatMap((item) => (item.kind === 'text' ? [item.text] : []))
                    .join('\n\n');
                  const copyReply = assistantText.trim() ? (
                    <span className="inline-flex shrink-0 opacity-0 transition-opacity duration-150 ease-out-soft group-hover/turn:opacity-100 group-focus-within/turn:opacity-100 has-focus-visible:opacity-100 motion-reduce:transition-none">
                      <CopyButton value={assistantText} label="复制回复" variant="ghost" />
                    </span>
                  ) : null;
                  const regenerateAction =
                    onRegenerate && latest ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="重新生成回复"
                        title="重新生成回复"
                        disabled={running || Boolean(regenerating)}
                        onClick={() => onRegenerate()}
                        className="shrink-0"
                      >
                        {regenerating ? (
                          <LoaderCircle className="animate-spin" aria-hidden="true" />
                        ) : (
                          <RotateCcw aria-hidden="true" />
                        )}
                      </Button>
                    ) : null;
                  const turnRunId = turn.items
                    .map((item) => (item.kind === 'notice' ? undefined : item.runId))
                    .find((runId) => runId !== undefined);
                  const noReply = turn.user && turns[turnIndex + 1]?.user === true;
                  const userOnlyRunId =
                    turn.user && (noReply || turnIndex === turns.length - 1)
                      ? turnRunId
                      : undefined;
                  const outputRunId = turn.user
                    ? userOnlyRunId
                    : (turnRunId ?? (latest ? (currentRunId ?? undefined) : undefined));
                  const anchorVisible = !turn.user || noReply || turnIndex === turns.length - 1;
                  const runFiles = outputRunId
                    ? (runOutputs?.byRun.get(outputRunId) ?? [])
                    : anchorVisible
                      ? anchoredOutputs(turn.items, runOutputs?.byAnchor)
                      : [];
                  const historyRun =
                    latest || (turn.user && !noReply) || turnRunId === undefined
                      ? undefined
                      : historyMetrics.get(turnRunId);
                  const persistentRun =
                    historyRun !== undefined &&
                    (historyRun.status === 'failed' ||
                      historyRun.status === 'timeout' ||
                      Boolean(historyRun.error));
                  const turnTodos = turn.user ? undefined : latestTopLevelTodos(turn.items);
                  const foldableRoots = turn.user
                    ? ([] as ToolItem[])
                    : foldableToolRoots(turn.items, structure, approvalHosts, questionsByToolUseId);
                  const foldableIds = new Set(foldableRoots.map((tool) => tool.toolUseId));
                  let tracePlaced = false;
                  let runningPreviousUiProgram =
                    latest && streaming ? previousUiProgram : undefined;
                  return (
                    <MessageScrollerItem key={turn.id} messageId={turn.id}>
                      <div className={cn('group/turn message-fade-up', turnIndex > 0 && 'pt-2')}>
                        <Message
                          align={turn.user ? (turnSelf ? 'end' : 'start') : 'start'}
                          className="text-base"
                        >
                          <MessageContent className="min-w-0 max-w-full gap-4 [overflow-wrap:anywhere]">
                            <span className="sr-only">
                              {turn.user ? (turnSelf ? '我' : '成员') : '助手'}
                            </span>
                            <MessageGroup className="min-w-0 gap-4">
                              {turn.items.map((item, index) => {
                                if (item.kind === 'tool') {
                                  if (structure.root.has(item.toolUseId)) return null;
                                  if (foldableIds.has(item.toolUseId)) {
                                    if (tracePlaced) return null;
                                    tracePlaced = true;
                                    return (
                                      <TurnTrace
                                        key={`trace-${turn.id}`}
                                        roots={foldableRoots}
                                        kids={structure.kids}
                                        approvalHosts={approvalHosts}
                                        pending={approvals?.pending ?? null}
                                        denying={approvals?.denying ?? null}
                                        onApprove={approvals?.onApprove}
                                        onDeny={approvals?.onDeny}
                                        questionsByToolUseId={questionsByToolUseId}
                                        liveRunId={liveRunId ?? null}
                                        live={latest && running}
                                      />
                                    );
                                  }
                                  return (
                                    <ToolGroup
                                      key={item.toolUseId}
                                      tool={item}
                                      kids={structure.kids.get(item.toolUseId) ?? NO_KIDS}
                                      approvalHosts={approvalHosts}
                                      pending={approvals?.pending ?? null}
                                      denying={approvals?.denying ?? null}
                                      onApprove={approvals?.onApprove}
                                      onDeny={approvals?.onDeny}
                                      questionsByToolUseId={questionsByToolUseId}
                                      liveRunId={liveRunId ?? null}
                                    />
                                  );
                                }
                                const header = renderItemHeader?.(item);
                                const footer = renderItemFooter?.(item);
                                const textUiState =
                                  latest &&
                                  streaming &&
                                  item.kind === 'text' &&
                                  item.parentToolUseId === undefined
                                    ? openUiSegmentsState(item.text)
                                    : 'none';
                                const unresolvedPatch =
                                  item.kind === 'text' &&
                                  item.uiProgram === undefined &&
                                  textUiState === 'patch';
                                const itemStreaming =
                                  latest &&
                                  streaming &&
                                  (!(item.kind === 'text' && item.closed === true) ||
                                    unresolvedPatch);
                                const turnOpenUiSnapshot = itemStreaming
                                  ? runningPreviousUiProgram === previousUiProgram
                                    ? latestOpenUiSnapshot
                                    : runningPreviousUiProgram === undefined
                                      ? openUiSnapshot
                                      : {
                                          ...openUiSnapshot,
                                          previousUiProgram: runningPreviousUiProgram,
                                        }
                                  : openUiSnapshot;
                                if (
                                  latest &&
                                  streaming &&
                                  item.kind === 'text' &&
                                  item.parentToolUseId === undefined
                                ) {
                                  const candidate =
                                    item.uiProgram ??
                                    (textUiState === 'complete' ? item.text : null);
                                  if (candidate) runningPreviousUiProgram = candidate;
                                }
                                if (!header && !footer) {
                                  return (
                                    <MessagePart
                                      // biome-ignore lint/suspicious/noArrayIndexKey: 只追加的流式日志，索引即顺序
                                      key={`${index}-${item.kind}`}
                                      item={item}
                                      openUi={openUi}
                                      streaming={itemStreaming}
                                      onAction={onAction}
                                      {...(turnOpenUiSnapshot
                                        ? { openUiSnapshot: turnOpenUiSnapshot }
                                        : {})}
                                    />
                                  );
                                }
                                return (
                                  <div
                                    // biome-ignore lint/suspicious/noArrayIndexKey: 只追加的流式日志，索引即顺序
                                    key={`${index}-${item.kind}`}
                                    className="flex min-w-0 flex-col gap-1.5"
                                  >
                                    {header}
                                    <MessagePart
                                      item={item}
                                      openUi={openUi}
                                      streaming={itemStreaming}
                                      onAction={onAction}
                                      {...(turnOpenUiSnapshot
                                        ? { openUiSnapshot: turnOpenUiSnapshot }
                                        : {})}
                                    />
                                    {footer}
                                  </div>
                                );
                              })}
                            </MessageGroup>
                            {turnTodos ? <TodoProgress todos={turnTodos} /> : null}
                            {!turn.user && latest ? (
                              <>
                                {runFooter || lastRun || copyReply || regenerateAction ? (
                                  <div className="flex min-w-0 items-start gap-1.5">
                                    <div className="min-w-0 flex-1">
                                      {runFooter}
                                      {lastRun ? (
                                        <RunMetricsLine
                                          run={lastRun}
                                          {...(lastRun.endedAt
                                            ? {
                                                title: `完成于 ${formatDateTime(lastRun.endedAt)}`,
                                              }
                                            : {})}
                                        />
                                      ) : null}
                                    </div>
                                    {copyReply}
                                    {regenerateAction}
                                  </div>
                                ) : null}
                                {approvals
                                  ? approvalItems
                                      .filter((item) => !placed.has(item.id))
                                      .map((item) => (
                                        <ApprovalCard
                                          key={item.id}
                                          item={item}
                                          pending={approvals.pending}
                                          denying={approvals.denying ?? null}
                                          onApprove={approvals.onApprove}
                                          {...(approvals.onDeny
                                            ? { onDeny: approvals.onDeny }
                                            : {})}
                                        />
                                      ))
                                  : null}
                              </>
                            ) : null}
                          </MessageContent>
                        </Message>
                        {historyRun ? (
                          <div
                            className={cn(
                              'mt-1 flex min-w-0 items-start gap-1.5 transition-opacity duration-150 ease-out-soft motion-reduce:transition-none',
                              persistentRun
                                ? 'opacity-100'
                                : 'opacity-0 group-focus-within/turn:opacity-100 group-hover/turn:opacity-100 pointer-coarse:opacity-100',
                            )}
                          >
                            <div className="min-w-0 flex-1">
                              <RunMetricsLine
                                run={historyRun}
                                {...(historyRun.endedAt
                                  ? { title: `完成于 ${formatDateTime(historyRun.endedAt)}` }
                                  : {})}
                              />
                            </div>
                            {copyReply}
                          </div>
                        ) : !latest && copyReply ? (
                          <div className="mt-1 flex items-center">{copyReply}</div>
                        ) : null}
                        {onSelectOutput && runFiles.length > 0 ? (
                          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
                            <RunOutputs files={runFiles} onSelect={onSelectOutput} />
                            {latest && runOutputs?.hasNextPage ? (
                              <Button
                                variant="muted"
                                size="sm"
                                disabled={runOutputs.loadingMore}
                                onClick={runOutputs.onLoadMore}
                                className="px-1.5"
                              >
                                {runOutputs.loadingMore ? '正在加载…' : '加载更多成果'}
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                        {onBranchMessage && messageId ? (
                          <div className="mt-1 flex justify-end">
                            <span
                              className={cn(
                                'inline-flex opacity-0 transition-opacity duration-150 ease-out-soft group-hover/turn:opacity-100 group-focus-within/turn:opacity-100 has-focus-visible:opacity-100 motion-reduce:transition-none',
                                branchingMessageId === messageId && 'opacity-100',
                              )}
                            >
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label="从这条消息分支"
                                title="从这条消息分支"
                                disabled={branchingMessageId !== null || running}
                                onClick={() => onBranchMessage(messageId)}
                              >
                                {branchingMessageId === messageId ? (
                                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                                ) : (
                                  <GitBranch aria-hidden="true" />
                                )}
                              </Button>
                            </span>
                          </div>
                        ) : null}
                      </div>
                    </MessageScrollerItem>
                  );
                })
              : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        {items.length > 0 ? (
          <MessageScrollerButton
            variant="outline"
            size="sm"
            behavior={reduce ? 'instant' : 'smooth'}
            className="hover:bg-hover motion-reduce:transition-none"
          >
            <ArrowDown className="size-3.5" /> 回到底部
          </MessageScrollerButton>
        ) : null}
        <ScrollToLatest userItem={appendedUser} />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

type UserChatItem = Extract<ChatItem, { kind: 'user' }>;

function sameUserItem(previous: UserChatItem | null, next: UserChatItem): boolean {
  if (previous === next) return true;
  const previousId = previous?.id ?? previous?.messageId;
  const nextId = next.id ?? next.messageId;
  return previousId !== undefined && nextId !== undefined && previousId === nextId;
}

function ScrollToLatest({ userItem }: { userItem: UserChatItem | null }) {
  const { scrollToEnd } = useMessageScroller();
  const seen = useRef(userItem);
  useEffect(() => {
    if (userItem === null || sameUserItem(seen.current, userItem)) return;
    seen.current = userItem;
    if (userItem.self === false) return;
    scrollToEnd();
  }, [userItem, scrollToEnd]);
  return null;
}

function userMessageId(items: ChatItem[]): string | undefined {
  for (const item of items) {
    if (item.kind === 'user' && item.messageId) return item.messageId;
  }
  return undefined;
}

function itemMessageId(item: ChatItem): string | undefined {
  if (item.kind === 'notice') return undefined;
  if (item.kind !== 'tool' && item.messageId !== undefined) return item.messageId;
  return item.id?.split(':')[0];
}

function anchoredOutputs(
  items: ChatItem[],
  byAnchor: ReadonlyMap<string, OutputFile[]> | undefined,
): OutputFile[] {
  if (byAnchor === undefined) return [];
  const seen = new Set<string>();
  const files: OutputFile[] = [];
  for (const item of items) {
    const ids =
      item.kind === 'tool'
        ? [itemMessageId(item), item.toolUseId, item.resultMessageId]
        : [itemMessageId(item)];
    for (const id of ids) {
      if (id === undefined) continue;
      for (const file of byAnchor.get(id) ?? []) {
        const key = `${file.runId}:${file.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        files.push(file);
      }
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

const HAS_ROOT = /^\s*root\s*=/m;

function openUiSegmentsState(text: string): 'none' | 'complete' | 'patch' {
  const openUiSegments = segmentOpenUi(text).filter((segment) => segment.kind === 'openui');
  if (openUiSegments.length === 0) return 'none';
  return openUiSegments.every((segment) => HAS_ROOT.test(segment.text)) ? 'complete' : 'patch';
}

function messageTurns(items: ChatItem[], hasFooter: boolean) {
  const turns: { id: string; user: boolean; items: ChatItem[] }[] = [];
  for (const [index, item] of items.entries()) {
    const previous = turns.at(-1);
    if (item.kind !== 'user' && previous && !previous.user) {
      previous.items.push(item);
    } else {
      turns.push({ id: item.id ?? `turn-${index}`, user: item.kind === 'user', items: [item] });
    }
  }
  if (hasFooter && turns.at(-1)?.user) {
    turns.push({ id: `turn-${items.length}`, user: false, items: [] });
  }
  return turns;
}
