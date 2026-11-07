import type { AgentSummary } from '@agentport/shared';

import {
  ATTACHMENT_LIMITS,
  attachmentMimeForFilename,
  type OpenUiAction,
  type OpenUiToolResult,
  type OutputFile,
  type ProgressTodo,
  type PublicRunQuestion,
} from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from '@tanstack/react-router';
import {
  ArrowDown,
  ArrowUp,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleStop,
  Download,
  GitBranch,
  ListChecks,
  LoaderCircle,
  Paperclip,
  RefreshCw,
  Wrench,
  X,
} from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { can } from '../lib/access.js';
import type { ApprovalRequest } from '../lib/api.js';
import { type ChatItem, latestTopLevelTodos, toolFailed } from '../lib/chat-state.js';
import {
  type RunMetrics,
  type RunOutcome,
  type RunState,
  useChatStore,
} from '../lib/chat-store.js';
import { cn } from '../lib/cn.js';
import {
  formatBytes,
  formatCost,
  formatDateTime,
  formatDuration,
  formatTokens,
  shortId,
} from '../lib/format.js';
import { meQuery, useRun } from '../lib/queries.js';
import type { useChatStream } from '../lib/use-chat-stream.js';
import type {
  OpenUiApprovalInput,
  OpenUiStateSaveInput,
  OpenUiToolCallInput,
} from '../openui/renderer.js';
import { CollapsibleText, JsonBlock, LARGE_CONTENT_CHARS } from './code-block.js';
import type { OutputSelection } from './conversation-outputs.js';
import { CopyButton } from './copy-button.js';
import { KnowledgeCitations, knowledgeHitsFromTool } from './knowledge-citations.js';
import { AssistantText } from './openui-message.js';
import { RunOutputs } from './run-outputs.js';
import { RunQuestionCard } from './run-question.js';
import { ErrorState, LoadingState } from './states.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from './ui/input-group.js';
import { Message, MessageContent, MessageGroup } from './ui/message.js';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerVisibility,
} from './ui/message-scroller.js';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from './ui/trace.js';

function filenameExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : '';
}

function middleTruncate(name: string, max = 24): string {
  if (name.length <= max) return name;
  const extension = filenameExtension(name);
  const suffix = extension ? `.${extension}` : '';
  const stem = suffix ? name.slice(0, -suffix.length) : name;
  const available = Math.max(1, max - suffix.length - 1);
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${stem.slice(0, head)}…${tail ? stem.slice(-tail) : ''}${suffix}`;
}

const outcomeLabel: Record<RunOutcome, string> = {
  succeeded: '完成',
  failed: '失败',
  cancelled: '已停止',
  timeout: '超时',
};

/** 设计规范 §9：只有展开折叠这类状态切换，150ms、ease-out、不加位移。 */
const EXPAND = { duration: 0.15, ease: 'easeOut' } as const;
const STILL = { duration: 0 } as const;
const ATTACHMENT_ACCEPT = [
  'txt',
  'md',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'pdf',
]
  .filter((extension) => attachmentMimeForFilename(`file.${extension}`) !== null)
  .map((extension) => `.${extension}`)
  .join(',');

/** 单文件上限按规范类型取，类型本身由 shared 扩展名映射决定。 */
function attachmentLimitFor(filename: string): number | null {
  const mime = attachmentMimeForFilename(filename);
  if (mime === null) return null;
  if (mime === 'application/pdf') return ATTACHMENT_LIMITS.pdfBytes;
  return mime.startsWith('image/') ? ATTACHMENT_LIMITS.imageBytes : ATTACHMENT_LIMITS.textBytes;
}

/** 输入与底部操作共用 InputGroup 的一层焦点边框。 */
export function Composer({
  agent,
  send,
  textareaRef,
  lastRunId,
  welcome,
  historyReady = true,
  cancelling = false,
  onCancel,
  value,
  onValueChange,
  onKeyDown,
  enabled,
  locked: lockedProp,
  canAttach = true,
  canSend: canSendProp,
  sendDenied = '当前账户没有新建会话的权限，不能发送消息。',
  placeholder = '描述你想完成的事…',
}: {
  agent: AgentSummary | null;
  send: ReturnType<typeof useChatStream>['send'];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  lastRunId: string | null;
  welcome: boolean;
  historyReady?: boolean;
  cancelling?: boolean;
  onCancel?: () => void;
  /** 受控输入：频道页用本地状态，缺省仍读写聊天草稿。 */
  value?: string;
  onValueChange?: (value: string, caret: number | null) => void;
  /** 返回 true 表示已消费按键（如 @ 补全），不再触发发送。 */
  onKeyDown?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** 不依赖聊天专家也能输入；频道没有单一 agent。 */
  enabled?: boolean;
  /** 覆盖聊天运行锁：频道允许多条 run 并行时继续发送。 */
  locked?: boolean;
  canAttach?: boolean;
  /** 覆盖平台发送权限：频道按成员角色判定。 */
  canSend?: boolean;
  /** 不能发送时的原因，频道用于区分只读与已关闭。 */
  sendDenied?: string;
  placeholder?: string;
}) {
  // 只订阅输入内容：打字不会重渲染消息列表所在的 ChatColumn。
  const me = useQuery(meQuery);
  const location = useLocation();
  const canSend = canSendProp ?? can(me.data, 'conversations.create');
  const canCancelRun = can(me.data, 'runs.cancel');
  const storeInput = useChatStore((state) => state.input);
  const setInput = useChatStore((state) => state.setInput);
  const run = useChatStore((state) => state.run);
  const outputRef = useChatStore((state) => state.outputRef);
  const setOutputRef = useChatStore((state) => state.setOutputRef);
  const pendingAttachments = useChatStore((state) => state.pendingAttachments);
  const setPendingAttachments = useChatStore((state) => state.setPendingAttachments);
  const input = value ?? storeInput;
  const enabledValue = enabled ?? agent !== null;
  const locked = lockedProp ?? Boolean(run);
  const attachments = canAttach ? pendingAttachments : [];
  const hasContent = Boolean(input.trim()) || attachments.length > 0;
  const attachmentsLocked = !enabledValue || !historyReady || locked;
  const change = (next: string, caret: number | null): void => {
    if (onValueChange) onValueChange(next, caret);
    else setInput(next);
  };

  // Enter 与发送按钮共用同一条发送路径；输入框在欢迎与会话之间保持同一个节点。
  const submit = (): void => {
    if (!historyReady || locked || !canSend) return;
    void send();
  };
  return (
    <form
      className={cn('mx-auto w-full max-w-220 shrink-0 px-6 pb-6', welcome ? 'pt-0' : 'pt-3')}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="w-full">
        <InputGroup className="h-auto rounded-[var(--radius-composer)] bg-surface">
          {outputRef ? (
            <div className="flex min-w-0 items-center gap-2 px-4 pt-3">
              <Badge variant="outline" className="min-w-0 max-w-full">
                <Paperclip aria-hidden="true" />
                <span className="truncate">{outputRef.path}</span>
              </Badge>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="取消引用"
                title="取消引用"
                onClick={() => setOutputRef(null)}
                className="text-muted-foreground"
              >
                <X />
              </Button>
            </div>
          ) : null}
          {attachments.length > 0 ? (
            <ul
              aria-label="待发送资料"
              className="flex w-full min-w-0 flex-wrap items-center gap-2 px-4 pt-3"
            >
              {attachments.map((file, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 同名文件可重复选择，位置即身份
                <li key={`${file.name}-${index}`} className="flex min-w-0 items-center gap-1">
                  <Badge variant="outline" className="min-w-0 max-w-full">
                    <span aria-hidden="true" className="shrink-0 font-mono text-2xs">
                      {filenameExtension(file.name).toUpperCase() || 'FILE'}
                    </span>
                    <span title={file.name} className="min-w-0 truncate">
                      {middleTruncate(file.name)}
                    </span>
                    <span className="shrink-0 text-2xs text-muted-foreground">
                      {formatBytes(file.size)}
                    </span>
                  </Badge>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`移除 ${file.name}`}
                    title="移除资料"
                    disabled={locked}
                    onClick={() =>
                      setPendingAttachments(
                        pendingAttachments.filter((_, position) => position !== index),
                      )
                    }
                    className="text-muted-foreground"
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <InputGroupTextarea
            ref={textareaRef}
            aria-label="消息"
            aria-describedby={canSend ? undefined : 'composer-send-denied'}
            rows={2}
            placeholder={placeholder}
            title={locked ? '本轮结束后才能发送；现在可以先把下一条写好' : undefined}
            disabled={!enabledValue || !historyReady}
            value={input}
            className={cn(
              'max-h-40 min-w-0 px-4 pb-2 pt-4 text-base md:text-base',
              welcome ? 'min-h-20' : 'min-h-14',
            )}
            onChange={(event) => change(event.target.value, event.target.selectionStart)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (onKeyDown?.(event)) {
                event.preventDefault();
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <InputGroupAddon align="block-end" className="justify-between gap-3 px-4 pb-3 pt-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs font-normal text-muted-foreground">
              {canAttach ? <AttachmentPicker disabled={attachmentsLocked} /> : null}
              <span>Enter 发送 · Shift+Enter 换行</span>
              {lastRunId ? (
                <Link
                  to="/runs/$runId"
                  params={{ runId: lastRunId }}
                  search={{ backTo: location.href }}
                  className="inline-flex items-center text-link underline underline-offset-2 hover:text-link/80"
                >
                  查看本次运行
                </Link>
              ) : null}
            </div>
            {run?.runId && onCancel ? (
              // 运行中发送位换成停止：动作在用户正在打字的地方，不用到消息流里找。
              canCancelRun ? (
                <InputGroupButton
                  variant="outline"
                  size="icon-sm"
                  onClick={onCancel}
                  disabled={cancelling}
                  aria-busy={cancelling}
                  aria-label="停止运行"
                  title="停止本轮运行"
                  className="ml-auto"
                >
                  {cancelling ? <LoaderCircle className="animate-spin" /> : <CircleStop />}
                </InputGroupButton>
              ) : null
            ) : (
              <InputGroupButton
                type="submit"
                variant="solid"
                size="icon-sm"
                disabled={!enabledValue || locked || !hasContent || !historyReady || !canSend}
                aria-label="发送消息"
                aria-describedby={canSend ? undefined : 'composer-send-denied'}
                title={
                  !canSend ? '当前账户没有新建会话的权限' : locked ? '本轮结束后可发送' : undefined
                }
                className="ml-auto"
              >
                <ArrowUp />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
        {!canSend ? (
          <p id="composer-send-denied" className="mt-2 px-1 text-sm text-muted-foreground">
            {sendDenied}
          </p>
        ) : null}
      </div>
    </form>
  );
}

/**
 * 资料选择：本地错误与文件框只在真正渲染时用 React 状态。
 * Composer 保持可直接调用（键盘单测），因此不在这里以外新增 hook。
 */
function AttachmentPicker({ disabled }: { disabled: boolean }) {
  const pendingAttachments = useChatStore((state) => state.pendingAttachments);
  const setPendingAttachments = useChatStore((state) => state.setPendingAttachments);
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = (files: FileList | null): void => {
    if (!files || files.length === 0) return;
    const selected = [...files];
    if (pendingAttachments.length + selected.length > ATTACHMENT_LIMITS.count) {
      setError(`最多添加 ${ATTACHMENT_LIMITS.count} 个资料`);
      return;
    }
    let total = pendingAttachments.reduce((sum, file) => sum + file.size, 0);
    for (const file of selected) {
      const limit = attachmentLimitFor(file.name);
      if (limit === null) {
        setError(`不支持「${file.name}」的文件类型`);
        return;
      }
      if (file.size > limit) {
        setError(`「${file.name}」超过 ${formatBytes(limit)}`);
        return;
      }
      total += file.size;
    }
    if (total > ATTACHMENT_LIMITS.totalBytes) {
      setError(`资料合计不能超过 ${formatBytes(ATTACHMENT_LIMITS.totalBytes)}`);
      return;
    }
    setPendingAttachments([...pendingAttachments, ...selected]);
    setError(null);
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        className="hidden"
        tabIndex={-1}
        aria-label="选择资料文件"
        disabled={disabled}
        onChange={(event) => {
          pick(event.target.files);
          event.target.value = '';
        }}
      />
      <InputGroupButton
        size="icon-sm"
        aria-label="添加资料"
        title="添加资料（文本、图片、PDF）"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="shrink-0"
      >
        <Paperclip />
      </InputGroupButton>
      {error ? (
        <span role="alert" className="min-w-0 text-danger [overflow-wrap:anywhere]">
          {error}
        </span>
      ) : null}
    </>
  );
}

/** 本轮起点：最后一条用户消息之后才算，历史轮次不参与轮数与状态判断。 */
function currentRunItems(items: ChatItem[]): ChatItem[] {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.kind === 'user') return items.slice(index + 1);
  }
  return items;
}

function runningTool(items: ChatItem[]): Extract<ChatItem, { kind: 'tool' }> | undefined {
  const current = currentRunItems(items);
  for (let index = current.length - 1; index >= 0; index -= 1) {
    const item = current[index];
    if (item?.kind === 'tool' && item.result === undefined) return item;
  }
  return undefined;
}

function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function RunReconciliation({
  run,
  reconcileRun,
}: {
  run: RunState;
  reconcileRun: ReturnType<typeof useChatStream>['reconcileRun'];
}) {
  // 健康事件流会自己补终态；只在连接未开/断开时靠详情回读，恢复后自动停。
  const runQuery = useRun(run.runId, run.status !== 'streaming');
  useEffect(() => {
    if (runQuery.data && (run.status !== 'streaming' || runQuery.data.run.status === 'cancelled')) {
      reconcileRun(runQuery.data.run);
    }
  }, [runQuery.data, run.status, reconcileRun]);
  return runQuery.isError ? (
    <ErrorState error={runQuery.error} onRetry={() => void runQuery.refetch()} />
  ) : null;
}

/** 运行中的临时读数：跟着本轮回复走，与完成后的读数行同一位置、同一行高。 */
export function RunFooter({
  run,
  items,
  onRetry,
}: {
  run: RunState;
  items: ChatItem[];
  onRetry: () => void;
}) {
  // 计时只在运行期间刷新；每秒一次，状态行以外的消息不跟着重渲染。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!run.runId) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run]);

  const broken = run.status === 'reconnecting' || run.status === 'detached';

  return (
    <div className="flex flex-wrap items-center gap-x-1.5 font-mono text-xs tabular-nums text-muted-foreground">
      <span
        className="status-dot shrink-0"
        data-kind={run.status === 'detached' ? 'error' : 'running'}
        aria-hidden="true"
      />
      <span className="min-w-0 break-words text-fg">{runStatusText(run, items)}</span>
      <span aria-hidden="true">·</span>
      <span>{elapsed(now - run.startedAt)}</span>
      {broken ? (
        <RefreshCw
          className={cn('size-3', run.status === 'reconnecting' && 'animate-spin')}
          aria-hidden="true"
        />
      ) : null}
      {run.status === 'detached' ? (
        <Button variant="link" size="xs" className="h-auto p-0" onClick={onRetry}>
          重连
        </Button>
      ) : null}
    </div>
  );
}

export function runStatusText(run: RunState, items: ChatItem[]): string {
  if (run.status === 'queued') return '任务已提交，正在准备';
  if (run.status === 'reconnecting') return '连接已中断，正在重连';
  if (run.status === 'detached') return '连接已中断 · 运行状态未知';
  const tool = runningTool(items);
  if (tool?.name === 'AskUserQuestion') return '等待你的回答';
  return tool ? `正在调用 ${tool.name}` : '等待回复';
}

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
                        <Message align={turn.user ? 'end' : 'start'} className="text-base">
                          <MessageContent
                            className={cn(
                              'min-w-0 max-w-full gap-4 [overflow-wrap:anywhere]',
                              turn.user &&
                                'w-fit max-w-[85%] rounded-[var(--radius-bubble)] bg-selected px-4 py-3 text-fg',
                            )}
                          >
                            <span className="sr-only">{turn.user ? '用户' : '助手'}</span>
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

function toolRunning(item: ToolItem): boolean {
  return item.result === undefined && item.startedAt !== undefined && item.endedAt === undefined;
}

/** 待批、原生提问、失败与缺失结果不能藏进执行过程；有这类子调用时整个父组留在折叠外。 */
function toolNeedsAttention(
  item: ToolItem,
  kids: ToolItem[],
  approvalHosts: ReadonlyMap<string, ApprovalRequest>,
  questionsByToolUseId: ReadonlyMap<string, PublicRunQuestion> | undefined,
): boolean {
  if (approvalHosts.has(item.toolUseId)) return true;
  if ((questionsByToolUseId?.get(item.toolUseId) ?? item.question) !== undefined) return true;
  if (item.result === undefined ? !toolRunning(item) : toolFailed(item.result)) return true;
  return kids.some((kid) => toolNeedsAttention(kid, NO_KIDS, approvalHosts, questionsByToolUseId));
}

/** 本轮可收进「执行过程」的顶层调用：自身与全部子调用都不需要用户处理。 */
function foldableToolRoots(
  items: ChatItem[],
  structure: ReturnType<typeof buildStructure>,
  approvalHosts: ReadonlyMap<string, ApprovalRequest>,
  questionsByToolUseId: ReadonlyMap<string, PublicRunQuestion> | undefined,
): ToolItem[] {
  return items.filter(
    (item): item is ToolItem =>
      item.kind === 'tool' &&
      !structure.root.has(item.toolUseId) &&
      !toolNeedsAttention(
        item,
        structure.kids.get(item.toolUseId) ?? NO_KIDS,
        approvalHosts,
        questionsByToolUseId,
      ),
  );
}

/** 本轮唯一的「执行过程」：运行中自动展开，结束后收起，用户仍可手动开合。 */
const TurnTrace = memo(function TurnTrace({
  roots,
  kids,
  approvalHosts,
  pending,
  onApprove,
  questionsByToolUseId,
  liveRunId,
  live,
}: {
  roots: ToolItem[];
  kids: ReadonlyMap<string, ToolItem[]>;
  approvalHosts: ReadonlyMap<string, ApprovalRequest>;
  pending: string | null;
  onApprove: ((item: ApprovalRequest) => void) | undefined;
  questionsByToolUseId?: ReadonlyMap<string, PublicRunQuestion> | undefined;
  liveRunId: string | null;
  live: boolean;
}) {
  const anyRunning = roots.some(
    (root) => toolRunning(root) || (kids.get(root.toolUseId) ?? NO_KIDS).some(toolRunning),
  );
  const [open, setOpen] = useState(live || anyRunning);
  // 整轮运行期间保持展开，避免两个工具之间短暂无运行项时反复开合；结束后收起。
  useEffect(() => setOpen(live || anyRunning), [live, anyRunning]);
  return (
    <Trace>
      <TraceCollapsible open={open} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine status={anyRunning ? 'running' : undefined}>
            <TraceIcon>
              {anyRunning ? (
                <span className="quiet-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              ) : (
                <ListChecks />
              )}
            </TraceIcon>
            <TraceTitle>执行过程</TraceTitle>
            <TraceDescription>{anyRunning ? '运行中' : '已完成'}</TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <div className="flex flex-col gap-1">
            {roots.map((root) => (
              <ToolGroup
                key={root.toolUseId}
                tool={root}
                kids={kids.get(root.toolUseId) ?? NO_KIDS}
                approvalHosts={approvalHosts}
                pending={pending}
                onApprove={onApprove}
                questionsByToolUseId={questionsByToolUseId}
                liveRunId={liveRunId}
              />
            ))}
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
});

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

/**
 * 一行顶层调用：父行 + 子调用 + 审批。memo 的入参全部在流式期间保持身份：
 * tool/kids 来自按 tools 缓存的树，approvalItems 在 ChatColumn 里按 query 数据缓存，
 * onApprove 由 useCallback 固定。文本增量因此不会渲染任何工具行。
 */
const ToolGroup = memo(function ToolGroup({
  tool,
  kids,
  approvalHosts,
  pending,
  onApprove,
  questionsByToolUseId,
  liveRunId,
}: {
  tool: ToolItem;
  kids: ToolItem[];
  approvalHosts: ReadonlyMap<string, ApprovalRequest>;
  pending: string | null;
  onApprove: ((item: ApprovalRequest) => void) | undefined;
  questionsByToolUseId?: ReadonlyMap<string, PublicRunQuestion> | undefined;
  liveRunId: string | null;
}) {
  const approval = approvalHosts.get(tool.toolUseId);
  const question = questionsByToolUseId?.get(tool.toolUseId) ?? tool.question;
  return (
    <>
      <div className="flex flex-col gap-1.5">
        {question ? (
          <RunQuestionCard
            key={question.requestId}
            question={question}
            live={liveRunId !== null && question.runId === liveRunId}
          />
        ) : (
          <ToolRow
            item={tool}
            nested={tool.parentToolUseId !== undefined}
            childCount={kids.length}
          />
        )}
        {approval && onApprove ? (
          <ApprovalCard item={approval} pending={pending} onApprove={onApprove} />
        ) : null}
      </div>
      {kids.map((child) => {
        const childApproval = approvalHosts.get(child.toolUseId);
        const childQuestion = questionsByToolUseId?.get(child.toolUseId) ?? child.question;
        return (
          <div key={`${child.toolUseId}-child`} className="flex flex-col gap-1.5">
            {childQuestion ? (
              <RunQuestionCard
                key={childQuestion.requestId}
                question={childQuestion}
                live={liveRunId !== null && childQuestion.runId === liveRunId}
              />
            ) : (
              <ToolRow item={child} nested={true} childCount={0} />
            )}
            {childApproval && onApprove ? (
              <ApprovalCard item={childApproval} pending={pending} onApprove={onApprove} />
            ) : null}
          </div>
        );
      })}
    </>
  );
});

/** 审批与工具调用是否同名同 server；放置、折叠和兜底共用这一条匹配规则。 */
function approvalMatchesTool(item: ToolItem, approval: ApprovalRequest): boolean {
  return approval.serverName
    ? item.name === `mcp__${approval.serverName}__${approval.toolName}`
    : item.name === approval.toolName || item.name.endsWith(`__${approval.toolName}`);
}

/**
 * 每个审批只落到一个工具位：唯一候选直接用；多个同名时只认唯一未结束的调用。
 * 无法唯一匹配就不放置，交给末尾兜底卡，避免历史成功调用把同一审批复制到每一行。
 */
function assignApprovals(
  turnTools: ToolItem[],
  approvalItems: ApprovalRequest[],
): Map<string, ApprovalRequest> {
  const hosts = new Map<string, ApprovalRequest>();
  for (const approval of approvalItems) {
    const candidates = turnTools.filter((tool) => approvalMatchesTool(tool, approval));
    const awaiting = candidates.filter((tool) => tool.result === undefined);
    const host =
      candidates.length === 1 ? candidates[0] : awaiting.length === 1 ? awaiting[0] : undefined;
    if (host) hosts.set(host.toolUseId, approval);
  }
  return hosts;
}

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;
const NO_KIDS: ToolItem[] = [];

function isTool(item: ChatItem): item is ToolItem {
  return item.kind === 'tool';
}

/** 文本增量不改工具对象；整表逐项比对后可复用旧数组，保住下游 memo。 */
function stableTools(items: ChatItem[], previous: ToolItem[]): ToolItem[] {
  const tools = items.filter(isTool);
  if (tools.length !== previous.length) return tools;
  for (let index = 0; index < tools.length; index += 1) {
    if (tools[index] !== previous[index]) return tools;
  }
  return previous;
}

/**
 * 子调用挂到最上层父 Agent 下；只保留一层，grandchildren 平铺到同一层。
 * 只依赖 tools：文本增量不改它，树与各行的 children 数组因此保持身份。
 */
function buildStructure(tools: ToolItem[]): {
  root: Map<string, string>;
  kids: Map<string, ToolItem[]>;
} {
  const toolById = new Map<string, ToolItem>();
  for (const item of tools) toolById.set(item.toolUseId, item);
  const rootOf = (item: ToolItem): string | null => {
    let node = item.parentToolUseId ? toolById.get(item.parentToolUseId) : undefined;
    let depth = 0;
    while (node?.parentToolUseId && depth < 8) {
      const up = toolById.get(node.parentToolUseId);
      if (!up) break;
      node = up;
      depth += 1;
    }
    return node?.toolUseId ?? null;
  };
  const root = new Map<string, string>();
  const kids = new Map<string, ToolItem[]>();
  for (const item of tools) {
    if (item.parentToolUseId === undefined) continue;
    const top = rootOf(item);
    if (top === null) continue;
    root.set(item.toolUseId, top);
    const list = kids.get(top) ?? [];
    list.push(item);
    kids.set(top, list);
  }
  return { root, kids };
}

function FoldingMessageBody({ text }: { text: string }) {
  const bodyRef = useRef<HTMLParagraphElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => setOverflowing(body.scrollHeight > 300);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [text]);

  const collapsed = overflowing && !expanded;
  const maskImage = collapsed
    ? 'linear-gradient(to bottom, black calc(100% - 3rem), transparent)'
    : undefined;

  return (
    <>
      <p
        ref={bodyRef}
        className={cn('whitespace-pre-wrap break-words', collapsed && 'max-h-75 overflow-hidden')}
        style={{ WebkitMaskImage: maskImage, maskImage }}
      >
        {text}
      </p>
      {overflowing ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          aria-expanded={expanded}
          aria-label={expanded ? '收起消息' : '展开完整消息'}
          onClick={() => setExpanded((value) => !value)}
          className="self-start text-sm"
        >
          {expanded ? '收起' : '展开'}
        </Button>
      ) : null}
    </>
  );
}

/** 文本增量只更新对应片段，工具行继续使用独立的 memo。 */
const MessagePart = memo(function MessagePart({
  item,
  openUi,
  streaming,
  onAction,
  openUiSnapshot,
}: {
  item: Exclude<ChatItem, { kind: 'tool' }>;
  openUi: boolean;
  streaming: boolean;
  openUiSnapshot?: OpenUiSnapshot;
  onAction?: ((action: OpenUiAction) => void) | undefined;
}) {
  // 历史消息自带格式快照：切回 markdown 后，已存的 UI 仍按 UI 渲染。
  // 子智能体的文本（带 parentToolUseId）永远不当主线程 UI 渲染：
  // 它的围栏属于子任务输出，混进主界面会让人误以为那是本轮回答。
  const subAgentText = item.kind === 'text' && item.parentToolUseId !== undefined;
  const messageOpenUi = subAgentText
    ? false
    : item.kind === 'text' && item.uiFormat
      ? item.uiFormat === 'openui'
      : openUi;
  switch (item.kind) {
    case 'user':
      // 不覆盖行高：气泡与助手正文共用 base 14/22。附图消息可以没有正文。
      return (
        <div className="flex min-w-0 flex-col gap-2">
          {item.text ? <FoldingMessageBody text={item.text} /> : null}
          {item.attachments && item.attachments.length > 0 ? (
            <ul aria-label="附件" className="flex min-w-0 flex-wrap gap-2">
              {item.attachments.map((attachment, index) => (
                <li
                  key={attachment.id ?? `${attachment.filename}-${index}`}
                  className="flex min-w-0"
                >
                  {/* 历史项才有下载地址：整枚标签就是链接，键盘与读屏都能直接触发。 */}
                  <Badge
                    variant="outline"
                    render={
                      attachment.downloadUrl ? (
                        // biome-ignore lint/a11y/useAnchorContent: 名称由 aria-label 提供，可见内容由 Badge 子节点注入
                        <a
                          href={attachment.downloadUrl}
                          aria-label={`下载 ${attachment.filename}（${formatBytes(attachment.size)}）`}
                        />
                      ) : undefined
                    }
                    className="min-w-0 max-w-full"
                  >
                    <span aria-hidden="true" className="shrink-0 font-mono text-2xs">
                      {filenameExtension(attachment.filename).toUpperCase() || 'FILE'}
                    </span>
                    <span title={attachment.filename} className="min-w-0 truncate">
                      {middleTruncate(attachment.filename)}
                    </span>
                    <span className="shrink-0 text-2xs text-muted-foreground">
                      {formatBytes(attachment.size)}
                    </span>
                    {attachment.downloadUrl ? (
                      <Download aria-hidden="true" className="shrink-0" />
                    ) : null}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      );
    case 'text':
      return (
        <div className="min-w-0">
          {renderAssistantText(item.text, messageOpenUi, streaming, onAction, {
            // 优先用回填的持久化 id；历史项的 id 形如 `msg_x:0`，需要去掉块后缀。
            ...(item.messageId !== undefined
              ? { messageId: item.messageId }
              : item.id === undefined
                ? {}
                : { messageId: item.id.split(':')[0] }),
            ...(item.uiProgram == null ? {} : { uiProgram: item.uiProgram }),
            ...(item.uiState == null ? {} : { uiState: item.uiState }),
            ...(openUiSnapshot ?? {}),
          })}
          {item.truncated ? (
            <p className="text-sm text-muted-foreground">
              该段内容超过单块上限，只显示了前一部分。
            </p>
          ) : null}
        </div>
      );
    case 'notice':
      return (
        <div
          className={cn(
            'flex min-w-0 items-center gap-1.5 text-sm [overflow-wrap:anywhere]',
            item.tone === 'ok'
              ? 'text-success'
              : item.tone === 'error'
                ? 'text-danger'
                : 'text-muted-foreground',
          )}
        >
          <span
            className={cn(
              'size-1 rounded-full',
              item.tone === 'ok' ? 'bg-success' : item.tone === 'error' ? 'bg-danger' : 'bg-subtle',
            )}
            aria-hidden="true"
          />
          {item.text}
        </div>
      );
  }
});

/** 消息级的渲染快照：渲染器提供的回调身份固定，来源由每段自己闭包。 */
interface OpenUiSnapshot {
  conversationId?: string;
  messageId?: string;
  /** 落库后的完整混合文本（Markdown + 完整围栏）；稳定态优先于原文。 */
  uiProgram?: string;
  /** `{ version, blocks }` 信封；渲染器按段取自己的快照。 */
  uiState?: unknown;
  onToolCall?: (input: OpenUiToolCallInput) => Promise<OpenUiToolResult>;
  onSaveState?: (input: OpenUiStateSaveInput) => Promise<unknown>;
  onApprove?: (input: OpenUiApprovalInput) => Promise<unknown>;
}

function renderAssistantText(
  text: string,
  openUi: boolean,
  streaming: boolean,
  onAction: ((action: OpenUiAction) => void) | undefined,
  snapshot?: OpenUiSnapshot,
) {
  if (text.length > LARGE_CONTENT_CHARS) {
    return (
      <CollapsibleText
        text={text}
        // Keep readable message typography when large text is forwarded to the unstyled Collapsible.
        className="whitespace-pre-wrap break-words text-base text-fg"
      />
    );
  }
  return (
    <AssistantText
      text={text}
      openUi={openUi}
      streaming={streaming}
      onAction={onAction}
      {...(snapshot?.messageId === undefined ? {} : { messageId: snapshot.messageId })}
      {...(snapshot?.conversationId === undefined
        ? {}
        : { conversationId: snapshot.conversationId })}
      {...(snapshot?.uiProgram === undefined ? {} : { uiProgram: snapshot.uiProgram })}
      {...(snapshot?.uiState === undefined ? {} : { uiState: snapshot.uiState })}
      {...(snapshot?.onToolCall === undefined ? {} : { onToolCall: snapshot.onToolCall })}
      {...(snapshot?.onSaveState === undefined ? {} : { onSaveState: snapshot.onSaveState })}
      {...(snapshot?.onApprove === undefined ? {} : { onApprove: snapshot.onApprove })}
    />
  );
}

/** 一行读数：完成 · 轮次 · 耗时 · token · 成本 · 查看详情。 */
function RunMetricsLine({ run, title }: { run: RunMetrics; title?: string }) {
  const location = useLocation();
  const tone =
    run.status === 'succeeded'
      ? 'text-success'
      : run.status === 'cancelled'
        ? 'text-muted-foreground'
        : 'text-danger';
  return (
    <div className="flex flex-col gap-1" title={title}>
      <div className="flex flex-wrap items-center gap-x-1.5 font-mono text-xs tabular-nums text-muted-foreground">
        <span className={tone}>{outcomeLabel[run.status]}</span>
        {run.turns !== undefined ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{run.turns} 轮</span>
          </>
        ) : null}
        {run.durationMs !== undefined ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{formatDuration(run.durationMs)}</span>
          </>
        ) : null}
        {run.tokens !== undefined ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{formatTokens(run.tokens)} tokens</span>
          </>
        ) : null}
        {run.costUsd !== undefined ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{formatCost(run.costUsd)}</span>
          </>
        ) : null}
        <span aria-hidden="true">·</span>
        <Link
          to="/runs/$runId"
          params={{ runId: run.runId }}
          search={{ backTo: location.href }}
          aria-label={`查看详情：运行 ${shortId(run.runId)}`}
          className="text-link underline underline-offset-2 hover:text-link/80"
        >
          查看详情
        </Link>
      </div>
      {run.error ? <p className="break-words text-sm text-danger">{run.error}</p> : null}
    </div>
  );
}

/** 等待中的调用可继续，已结束的调用仅记录后续许可。 */
export const ApprovalCard = memo(function ApprovalCard({
  item,
  pending,
  onApprove,
}: {
  item: ApprovalRequest;
  pending: string | null;
  onApprove: (item: ApprovalRequest) => void;
}) {
  const busy = pending === item.id;
  const isPending = item.waiting && item.approvedAt === null;
  const reduce = useReducedMotion();
  return (
    <motion.div
      role="alert"
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={reduce ? STILL : EXPAND}
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-card border bg-surface px-3 py-2',
        isPending && 'border-line',
      )}
    >
      <CircleAlert className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
      {isPending ? (
        <span className="shrink-0 rounded-full bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning">
          等待授权
        </span>
      ) : null}
      <div className="min-w-0 flex-1 basis-48 text-sm text-fg [overflow-wrap:anywhere]">
        工具 <code className="font-mono text-xs">{item.toolName}</code>
        <span className="text-muted-foreground"> @ {item.serverName ?? item.serverId}</span>{' '}
        {item.waiting
          ? '调用仍在等待，批准后可继续本次调用，无需重发'
          : '本次调用已结束等待，批准仅对后续调用生效，不会恢复已结束的调用。'}{' '}
        <span className="text-muted-foreground">批准在本会话内有效，8 小时后需重新批准。</span>
      </div>
      <Button
        size="sm"
        className="h-auto min-h-7 max-w-full whitespace-normal py-1"
        disabled={pending !== null}
        aria-busy={busy}
        aria-label={`批准 ${item.serverName ?? item.serverId} / ${item.toolName}`}
        onClick={() => onApprove(item)}
      >
        {busy ? '批准中…' : item.waiting ? '批准本次调用' : '批准后续调用'}
      </Button>
    </motion.div>
  );
});

/** 本轮任务清单：只呈现最后一次确认的快照，停止/失败/成功都不改写步骤状态。 */
const TodoProgress = memo(function TodoProgress({ todos }: { todos: ProgressTodo[] }) {
  const completed = todos.filter((todo) => todo.status === 'completed').length;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <ListChecks className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="font-mono text-xs tabular-nums text-fg" aria-hidden="true">
          {completed}/{todos.length}
        </span>
        <span className="sr-only">
          已完成 {completed} 项，共 {todos.length} 项
        </span>
      </div>
      <ul aria-label="任务清单" className="flex flex-col gap-1">
        {todos.map((todo, index) => {
          const status =
            todo.status === 'completed'
              ? '已完成'
              : todo.status === 'in_progress'
                ? '进行中'
                : '待处理';
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: 清单没有稳定 id，位置即身份
              key={index}
              className="flex items-start gap-1.5 text-base"
            >
              {todo.status === 'completed' ? (
                <CircleCheck className="mt-1 size-4 shrink-0 text-success" aria-hidden="true" />
              ) : todo.status === 'in_progress' ? (
                <LoaderCircle
                  className="mt-1 size-4 shrink-0 animate-spin text-fg"
                  aria-hidden="true"
                />
              ) : (
                <Circle className="mt-1 size-4 shrink-0 text-subtle" aria-hidden="true" />
              )}
              <span
                className={cn(
                  'min-w-0 [overflow-wrap:anywhere]',
                  todo.status === 'in_progress' ? 'text-fg' : 'text-muted-foreground',
                )}
              >
                <span className="sr-only">{status}：</span>
                {todo.status === 'in_progress' ? todo.activeForm : todo.content}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
});

const ToolRow = memo(function ToolRow({
  item,
  nested,
  childCount,
}: {
  item: Extract<ChatItem, { kind: 'tool' }>;
  nested: boolean;
  childCount: number;
}) {
  const running =
    item.result === undefined && item.startedAt !== undefined && item.endedAt === undefined;
  const missing = !running && item.result === undefined;
  const failed = toolFailed(item.result);
  // 有结构化引用时在收起状态也提示来源数量，否则用户不会知道要展开 trace。
  const cited = knowledgeHitsFromTool(item.name, item.result)?.length ?? 0;
  const status = running ? '运行中' : missing ? '未收到结果' : failed ? '失败' : '完成';
  const lineStatus = running ? 'running' : missing ? 'pending' : failed ? 'error' : undefined;
  const [open, setOpen] = useState(running);

  // 跑着的自动展开，结束后收起；用户仍可手动再展开。
  useEffect(() => {
    setOpen(running);
  }, [running]);

  const duration =
    item.startedAt !== undefined && item.endedAt !== undefined
      ? item.endedAt - item.startedAt
      : undefined;

  return (
    <TraceCollapsible
      open={open}
      onOpenChange={setOpen}
      className={cn('min-w-0', nested && 'ml-4')}
    >
      <TraceCollapsibleTrigger>
        <TraceLine status={lineStatus}>
          <TraceIcon>
            {running ? (
              <LoaderCircle className="animate-spin" />
            ) : missing || failed ? (
              <CircleAlert />
            ) : (
              <Wrench />
            )}
          </TraceIcon>
          <TraceTitle className="font-mono text-xs text-fg">{item.name}</TraceTitle>
          <TraceDescription>
            {status}
            {duration === undefined ? '' : ` · ${formatDuration(duration)}`}
            {cited > 0 ? ` · ${cited} 来源` : ''}
          </TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex flex-col gap-2">
        {childCount > 0 ? (
          <p className="text-xs text-muted-foreground">子智能体 · {childCount} 次调用</p>
        ) : null}
        <div className="min-w-0">
          <div className="mb-1 text-2xs uppercase tracking-[0.06em] text-muted-foreground">
            参数
          </div>
          {item.input !== undefined ? (
            <JsonBlock value={item.input} maxHeight="16rem" />
          ) : (
            <p className="text-2xs text-muted-foreground">{running ? '等待参数…' : '未收到参数'}</p>
          )}
        </div>
        <div className="min-w-0">
          <div className="mb-1 text-2xs uppercase tracking-[0.06em] text-muted-foreground">
            结果
          </div>
          {item.result !== undefined ? (
            <>
              <JsonBlock value={item.result} maxHeight="20rem" />
              {/* 知识库检索结果另给可点开的来源；原文在查看器里读，不执行来源页脚本。 */}
              <div className="mt-2">
                <KnowledgeCitations name={item.name} result={item.result} />
              </div>
            </>
          ) : (
            <p className="text-2xs text-muted-foreground">{running ? '等待结果…' : '未收到结果'}</p>
          )}
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
});
