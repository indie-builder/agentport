import type { OpenUiAction, OutputFile, PublicRunQuestion } from '@agentport/shared';
import { ArrowDown, GitBranch, LoaderCircle } from 'lucide-react';
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

/** 可见消息 id 变化时通知外部；频道用它推进已读游标。 */
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
    onApprove: (item: ApprovalRequest) => void;
  };
  approvalItems: ApprovalRequest[];
  /** 当前运行的提问快照，按 toolUseId 对齐到工具位；历史快照仍用 item.question。 */
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
  running: boolean;
  /** 当前智能体的回复格式；旧消息自身带格式时以消息为准。 */
  openUi: boolean;
  /** 当前这一轮是否仍在流式输出：解析器按此自动闭合未完成的语句。 */
  streaming: boolean;
  onAction?: ((action: OpenUiAction) => void) | undefined;
  /** 生成式 UI 的状态写回、工具桥与会话级审批；按段闭包来源。 */
  openUiSnapshot?: OpenUiSnapshot;
  /** 频道用：在消息内容前后插入作者标识与运行控制，聊天不传。 */
  renderItemHeader?: (item: ChatItem) => ReactNode;
  renderItemFooter?: (item: ChatItem) => ReactNode;
  /** 可见消息 id 变化时回调；频道用它推进已读游标。 */
  onVisibleMessageIdsChange?: (ids: string[]) => void;
  /** 顶部预留高度；频道传 0，贴顶的短消息才会计入可见。 */
  scrollPreviousItemPeek?: number;
}) {
  const reduce = useReducedMotion();
  const turns = useMemo(
    () => messageTurns(items, Boolean(lastRun) || running || approvalItems.length > 0),
    [items, lastRun, running, approvalItems],
  );
  // 上一次的工具子集：文本增量不改工具对象，复用它就不会惊动下游 memo。
  const prevTools = useRef<ToolItem[]>([]);

  // 文本增量只换最后一项，其余对象共享，但 items 数组身份每次都变。
  // 工具子集逐项比对后复用；结构只依赖工具子集，于是增量不改变任何 ToolGroup 的入参。
  const tools = useMemo(() => stableTools(items, prevTools.current), [items]);
  prevTools.current = tools;
  const structure = useMemo(() => buildStructure(tools), [tools]);

  // 审批只落到当前轮唯一匹配的工具位；历史同名成功调用仍留在各自的执行过程里。
  const latestTurn = turns.at(-1);
  const approvalHosts = useMemo(() => {
    if (!latestTurn || latestTurn.user) return new Map<string, ApprovalRequest>();
    return assignApprovals(latestTurn.items.filter(isTool), approvals ? approvalItems : []);
  }, [latestTurn, approvalItems, approvals]);

  const placed = useMemo(() => {
    const ids = new Set<string>();
    for (const approval of approvalHosts.values()) ids.add(approval.id);
    return ids;
  }, [approvalHosts]);

  // 发送是明确动作：新的一轮用户消息出现就把视图拉回最新，即使此前往上翻过。
  // 认「末尾那个用户项」而不是轮次 id：补旧会重建历史项对象，id 才是同一消息。
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
                    <CopyButton
                      value={assistantText}
                      label="复制回复"
                      variant="ghost"
                      className="shrink-0 opacity-0 transition-opacity duration-150 ease-out-soft group-hover/turn:opacity-100 group-focus-within/turn:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none"
                    />
                  ) : null;
                  // 历史轮次按消息上的 run_id 取读数；读数默认藏起来，指到这一轮才浮出。
                  // 没有助手输出的轮次（下一条仍是用户消息）由用户消息自己的 run_id 承载。
                  const turnRunId = turn.items
                    .map((item) => (item.kind === 'notice' ? undefined : item.runId))
                    .find((runId) => runId !== undefined);
                  const noReply = turn.user && turns[turnIndex + 1]?.user === true;
                  // 最新一轮可能还没有助手文本，run 由当前运行或最近一次运行补上。
                  // 失败/取消/超时的轮可能只有用户消息：没有助手行时由这条用户消息的 run_id 承载成果。
                  const userOnlyRunId =
                    turn.user && (noReply || turnIndex === turns.length - 1)
                      ? turnRunId
                      : undefined;
                  const outputRunId = turn.user
                    ? userOnlyRunId
                    : (turnRunId ?? (latest ? (currentRunId ?? undefined) : undefined));
                  // run_id 被维护清空或分支重写后，退回本轮边界消息的锚点；用户轮只在
                  // 没有助手回复时就地显示，避免与助手轮重复。
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
                  // 失败与超时的原因常驻；其余历史读数仍按悬停/聚焦显影。
                  const persistentRun =
                    historyRun !== undefined &&
                    (historyRun.status === 'failed' ||
                      historyRun.status === 'timeout' ||
                      Boolean(historyRun.error));
                  // 清单是这一轮的最后一份顶层确认快照；子智能体与空快照都不显示。
                  const turnTodos = turn.user ? undefined : latestTopLevelTodos(turn.items);
                  // 正常工具集中到本轮唯一的执行过程；待批/提问/失败/缺失结果留在折叠外。
                  const foldableRoots = turn.user
                    ? ([] as ToolItem[])
                    : foldableToolRoots(turn.items, structure, approvalHosts, questionsByToolUseId);
                  const foldableIds = new Set(foldableRoots.map((tool) => tool.toolUseId));
                  let tracePlaced = false;
                  return (
                    <MessageScrollerItem key={turn.id} messageId={turn.id}>
                      {/* 一轮一组：只靠拉开间距划出轮次边界，不加横线。 */}
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
                                // 有归属的子调用由父行渲染，不在顶层重复出现。
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
                                        onApprove={approvals?.onApprove}
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
                                      onApprove={approvals?.onApprove}
                                      questionsByToolUseId={questionsByToolUseId}
                                      liveRunId={liveRunId ?? null}
                                    />
                                  );
                                }
                                const header = renderItemHeader?.(item);
                                const footer = renderItemFooter?.(item);
                                if (!header && !footer) {
                                  return (
                                    <MessagePart
                                      // biome-ignore lint/suspicious/noArrayIndexKey: 只追加的流式日志，索引即顺序
                                      key={`${index}-${item.kind}`}
                                      item={item}
                                      openUi={openUi}
                                      streaming={latest && streaming}
                                      onAction={onAction}
                                      {...(openUiSnapshot ? { openUiSnapshot } : {})}
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
                                      streaming={latest && streaming}
                                      onAction={onAction}
                                      {...(openUiSnapshot ? { openUiSnapshot } : {})}
                                    />
                                    {footer}
                                  </div>
                                );
                              })}
                            </MessageGroup>
                            {turnTodos ? <TodoProgress todos={turnTodos} /> : null}
                            {!turn.user && latest ? (
                              <>
                                {runFooter || lastRun || copyReply ? (
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
                                  </div>
                                ) : null}
                                {approvals
                                  ? approvalItems
                                      .filter((item) => !placed.has(item.id))
                                      .map((item) => (
                                        <ApprovalCard
                                          key={item.id}
                                          item={item}
                                          pending={approvals?.pending ?? null}
                                          onApprove={approvals?.onApprove}
                                        />
                                      ))
                                  : null}
                              </>
                            ) : null}
                          </MessageContent>
                        </Message>
                        {/* 历史读数常驻占位、默认透明：指到或聚焦这一轮才显影。
                            只用 opacity 隐藏——「查看详情」始终留在可访问树与 Tab 序里，
                            键盘聚焦到它时本轮 group-focus-within 显影，链接不会突然消失。 */}
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
                                variant="ghost"
                                size="sm"
                                disabled={runOutputs.loadingMore}
                                onClick={runOutputs.onLoadMore}
                                className="h-7 px-1.5 text-sm text-muted-foreground"
                              >
                                {runOutputs.loadingMore ? '正在加载…' : '加载更多成果'}
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                        {onBranchMessage && messageId ? (
                          <div className="mt-1 flex justify-end">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label="从这条消息分支"
                              disabled={branchingMessageId !== null || running}
                              onClick={() => onBranchMessage(messageId)}
                            >
                              {branchingMessageId === messageId ? (
                                <LoaderCircle className="animate-spin" aria-hidden="true" />
                              ) : (
                                <GitBranch aria-hidden="true" />
                              )}
                            </Button>
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

/** 历史项有持久 id：补旧重建对象时仍认同一消息。新发送的用户项没有 id，只能按对象身份。 */
function sameUserItem(previous: UserChatItem | null, next: UserChatItem): boolean {
  if (previous === next) return true;
  const previousId = previous?.id ?? previous?.messageId;
  const nextId = next.id ?? next.messageId;
  return previousId !== undefined && nextId !== undefined && previousId === nextId;
}

/**
 * 新用户轮出现时回到底部；必须挂在 Provider 内才能拿到滚动控制。
 * 补旧消息会重建历史项对象，比较持久 id 才不会误判成新的一轮。
 */
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

/** 分支需要原始消息 id；新发/流式消息没有，按不可分支处理。 */
function userMessageId(items: ChatItem[]): string | undefined {
  for (const item of items) {
    if (item.kind === 'user' && item.messageId) return item.messageId;
  }
  return undefined;
}

/** 历史项 id 形如 `<messageId>:<blockIndex>`；运行详情重建的合成 id 不会命中真实锚点。 */
function itemMessageId(item: ChatItem): string | undefined {
  if (item.kind === 'notice') return undefined;
  if (item.kind !== 'tool' && item.messageId !== undefined) return item.messageId;
  return item.id?.split(':')[0];
}

/** 本轮边界消息命中 manifest 锚点时返回成果；同一 run 的同一路径只出现一次。 */
function anchoredOutputs(
  items: ChatItem[],
  byAnchor: ReadonlyMap<string, OutputFile[]> | undefined,
): OutputFile[] {
  if (byAnchor === undefined) return [];
  const seen = new Set<string>();
  const files: OutputFile[] = [];
  for (const item of items) {
    // 工具轮的结果消息与调用 id 都可能是 manifest 锚点：run_id 被清空后只能靠它们定位。
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

function messageTurns(items: ChatItem[], hasFooter: boolean) {
  const turns: { id: string; user: boolean; items: ChatItem[] }[] = [];
  for (const [index, item] of items.entries()) {
    const previous = turns.at(-1);
    if (item.kind !== 'user' && previous && !previous.user) {
      previous.items.push(item);
    } else {
      // 历史项自带稳定 id：补旧消息时前面整段不会换 key 重新挂载。
      turns.push({ id: item.id ?? `turn-${index}`, user: item.kind === 'user', items: [item] });
    }
  }
  if (hasFooter && turns.at(-1)?.user) {
    turns.push({ id: `turn-${items.length}`, user: false, items: [] });
  }
  return turns;
}
