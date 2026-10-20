import { chatEventSchema } from '@agentport/shared';
import { Link } from '@tanstack/react-router';
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  CircleStop,
  GitBranch,
  LoaderCircle,
  MessageSquare,
  Plus,
  RefreshCw,
  Wrench,
  X,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CodeBlock, CollapsibleText, JsonBlock } from '../components/code-block.js';
import { RunStatusBadge } from '../components/run-status-badge.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Button } from '../components/ui/button.js';
import { Textarea } from '../components/ui/textarea.js';
import {
  type ApprovalRequest,
  api,
  type ChatAccepted,
  errorMessage,
  type RecentRun,
} from '../lib/api.js';
import {
  applyEvent,
  type ChatItem,
  historyToItems,
  type LocalConversation,
  loadLocalConversations,
  localConversation,
  titleFromDetail,
  toolFailed,
  upsertLocalConversation,
} from '../lib/chat-state.js';
import { cn } from '../lib/cn.js';
import { formatBytes, formatCost, formatDuration, formatRelative } from '../lib/format.js';
import {
  useAgents,
  useConversation,
  useConversations,
  useRunApprovals,
  useRuns,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';

export function ChatPage() {
  const agents = useAgents();
  const [agentId, setAgentId] = useState<string | null>(null);
  const activeAgentId = agentId ?? agents.data?.[0]?.id ?? null;

  if (agents.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <h1 className="sr-only">对话</h1>
        <LoadingState rows={3} />
      </div>
    );
  }

  if (agents.isError) {
    return (
      <div>
        <h1 className="sr-only">对话</h1>
        <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
      </div>
    );
  }

  if (agents.data && agents.data.length === 0) {
    return (
      <div>
        <h1 className="sr-only">对话</h1>
        <EmptyState
          icon={<Bot className="size-5" />}
          title="还没有智能体"
          description="先在「智能体」页面创建一个 agent，并给它绑定 MCP Server。"
          action={
            <Link to="/agents" className="text-xs text-signal-text hover:underline">
              前往创建
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <ChatWorkspace
      agents={agents.data ?? []}
      agentId={activeAgentId}
      onAgentChange={(id) => setAgentId(id)}
    />
  );
}

type RunOutcome = 'succeeded' | 'failed' | 'cancelled' | 'timeout';

interface RunState {
  runId: string;
  conversationId: string;
  /** queued：已提交、还没拿到 runId；此时没有可停止的对象。 */
  status: 'queued' | 'streaming' | 'reconnecting' | 'detached';
  startedAt: number;
}

interface RunMetrics {
  runId: string;
  status: RunOutcome;
  turns?: number;
  durationMs: number;
  tokens?: number;
  costUsd?: number;
  error?: string;
}

const outcomeLabel: Record<RunOutcome, string> = {
  succeeded: '完成',
  failed: '失败',
  cancelled: '已停止',
  timeout: '超时',
};

function ChatWorkspace({
  agents,
  agentId,
  onAgentChange,
}: {
  agents: NonNullable<ReturnType<typeof useAgents>['data']>;
  agentId: string | null;
  onAgentChange: (id: string) => void;
}) {
  const agent = agents.find((item) => item.id === agentId) ?? null;
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [run, setRun] = useState<RunState | null>(null);
  const [lastRun, setLastRun] = useState<RunMetrics | null>(null);
  const [local, setLocal] = useState<LocalConversation[]>(() => loadLocalConversations());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [branching, setBranching] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // 审批针对产生错误的 run；run_finished 后 run 会被清空，所以单独保留 id。
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [approving, setApproving] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // 服务端重连时从头回放事件流；保留发起前的消息（含用户气泡），避免文本重复或丢失。
  const baseItemsRef = useRef<ChatItem[]>([]);
  const sourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // 切换会话时才从服务端回填历史；否则流式结束瞬间的重新查询会覆盖刚收到的回答。
  const hydratedRef = useRef<string | null>(null);

  const conversations = useConversations(agentId);
  const detail = useConversation(conversationId);
  const runApprovals = useRunApprovals(run?.runId || lastRunId);
  const recentRuns = useRuns({ ...(agentId ? { agentId } : {}), limit: 1 });

  const history = useMemo(() => {
    if (conversations.data?.supported) {
      return conversations.data.items.map((conversation) => ({
        id: conversation.id,
        agentId: conversation.agentId,
        title: conversation.title || '未命名会话',
        updatedAt: conversation.updatedAt || conversation.createdAt,
      }));
    }
    // 后端没有列表接口：用本地索引，只保留当前 agent 的会话。
    return local.filter((conversation) => conversation.agentId === agentId);
  }, [conversations.data, local, agentId]);

  const closeStream = useCallback((): void => {
    if (retryRef.current !== null) {
      window.clearTimeout(retryRef.current);
      retryRef.current = null;
    }
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  useEffect(() => closeStream, [closeStream]);

  // 状态条计时：只有存在 runId 时才需要每秒刷新。
  useEffect(() => {
    if (!run?.runId) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run?.runId]);

  // 空态或运行结束后把焦点交还输入框，键盘用户不用再找一次。
  useEffect(() => {
    if (!run && items.length === 0) composerRef.current?.focus();
  }, [run, items.length]);

  const openStream = useCallback(
    (accepted: ChatAccepted, attempt = 0): void => {
      closeStream();
      if (attempt > 0) setItems(baseItemsRef.current);
      const source = new EventSource(`/api/chat/${accepted.runId}/events`);
      sourceRef.current = source;
      let finished = false;
      // 服务端收到 error 事件后会主动断流；此时 run 可能还在跑，不能重连也不能清状态。
      let errored = false;

      source.onopen = () => {
        if (sourceRef.current !== source) return;
        setRun((current) =>
          current?.runId === accepted.runId ? { ...current, status: 'streaming' } : current,
        );
      };

      source.onmessage = (message) => {
        let raw: unknown;
        try {
          raw = JSON.parse(message.data);
        } catch {
          return;
        }
        const parsed = chatEventSchema.safeParse(raw);
        if (!parsed.success) return;
        const event = parsed.data;
        setItems((previous) => applyEvent(previous, event));
        if (event.type === 'error') {
          errored = true;
          return;
        }
        if (event.type === 'run_finished') {
          finished = true;
          closeStream();
          setRun(null);
          setNow(Date.now());
          setLastRun({
            runId: accepted.runId,
            status: event.status,
            durationMs: Date.now() - startedAtRef.current,
            ...(event.turns === undefined ? {} : { turns: event.turns }),
            ...(event.inputTokens === undefined && event.outputTokens === undefined
              ? {}
              : { tokens: (event.inputTokens ?? 0) + (event.outputTokens ?? 0) }),
            ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
            ...(event.error === undefined ? {} : { error: event.error }),
          });
        }
        // error 只是事件流里的一条通知：服务端 run 可能仍在运行，不在这里收尾。
      };

      source.onerror = () => {
        // 服务端在 run_finished 后主动结束流；此后重连没有意义。
        if (finished || sourceRef.current !== source) return;
        source.close();
        sourceRef.current = null;
        if (errored && attempt === 0) {
          // 服务端已明确报错并断流：保留 run，只标记事件流丢失，停止仍可用。
          setRun((current) =>
            current?.runId === accepted.runId ? { ...current, status: 'detached' } : current,
          );
          return;
        }
        if (attempt < 3) {
          setRun({ ...accepted, status: 'reconnecting', startedAt: startedAtRef.current });
          retryRef.current = window.setTimeout(() => openStream(accepted, attempt + 1), 1500);
          return;
        }
        setRun(null);
        setItems((previous) => [
          ...previous,
          { kind: 'notice', tone: 'error', text: '事件流多次中断，已停止重连。' },
        ]);
      };
    },
    [closeStream],
  );

  const send = async (): Promise<void> => {
    const text = input.trim();
    if (!text || !agent || run) return;
    setInput('');
    setLastRun(null);
    // base 必须包含刚追加的用户气泡：重连会整体回放事件，不能把它丢掉。
    const nextItems: ChatItem[] = [...items, { kind: 'user', text }];
    baseItemsRef.current = nextItems;
    setItems(nextItems);
    startedAtRef.current = Date.now();
    setNow(startedAtRef.current);
    setRun({
      runId: '',
      conversationId: conversationId ?? '',
      status: 'queued',
      startedAt: startedAtRef.current,
    });
    try {
      const accepted = await api.sendChat({
        agentId: agent.id,
        message: text,
        ...(conversationId ? { conversationId } : {}),
      });
      setConversationId(accepted.conversationId);
      setLastRunId(accepted.runId);
      hydratedRef.current = accepted.conversationId;
      setRun({ ...accepted, status: 'streaming', startedAt: startedAtRef.current });
      upsertLocalConversation({
        id: accepted.conversationId,
        agentId: agent.id,
        title: text.slice(0, 80),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      setLocal(loadLocalConversations());
      openStream(accepted);
    } catch (error) {
      setRun(null);
      setInput(text);
      toastError(error);
      // 没有 run 产生任何回答：撤回本地用户气泡，只留一条错误通知。
      setItems([...items, { kind: 'notice', tone: 'error', text: errorMessage(error) }]);
    }
  };

  const cancel = (): void => {
    // 没有 runId 时后端还没有可取消的 run；按钮也不会显示。
    if (!run?.runId || cancelling) return;
    setCancelling(true);
    api
      .cancelRun(run.runId)
      .catch((error) => toastError(error))
      .finally(() => setCancelling(false));
  };

  /** 只记录批准；继续需要用户重新发送消息，也就是新一次运行。 */
  const approve = (item: ApprovalRequest): void => {
    const runId = run?.runId || lastRunId;
    if (!runId || approving) return;
    setApproving(item.id);
    api
      .approveRun(runId, item.serverId, item.toolName)
      .then(() => {
        toastSuccess(`已批准 ${item.toolName}；继续请在输入框重新发送消息`);
        void runApprovals.refetch();
      })
      .catch((error) => toastError(error))
      .finally(() => setApproving(null));
  };

  const openConversation = (id: string): void => {
    closeStream();
    setRun(null);
    setLastRun(null);
    setLastRunId(null);
    hydratedRef.current = null;
    setConversationId(id);
    setItems([]);
    setHistoryOpen(false);
  };

  const newConversation = (): void => {
    closeStream();
    setRun(null);
    setLastRun(null);
    setLastRunId(null);
    hydratedRef.current = null;
    setConversationId(null);
    setItems([]);
    setHistoryOpen(false);
    composerRef.current?.focus();
  };

  // 分支：服务端复制消息，前端切到新会话；列表由 query 失效后刷新。
  const branch = async (id: string): Promise<void> => {
    if (branching) return;
    setBranching(id);
    try {
      const conversation = await api.branchConversation(id);
      await conversations.refetch();
      openConversation(conversation.id);
    } catch (error) {
      toastError(error);
    } finally {
      setBranching(null);
    }
  };

  // 载入历史：每个会话只回填一次，之后由流式事件维护。
  useEffect(() => {
    const data = detail.data;
    if (!data || run) return;
    if (hydratedRef.current === data.conversation.id) return;
    hydratedRef.current = data.conversation.id;
    setItems(historyToItems(data.messages));
  }, [detail.data, run]);

  useEffect(() => {
    if (!detail.data) return;
    const existing = loadLocalConversations().find(
      (conversation) => conversation.id === detail.data?.conversation.id,
    );
    if (existing) return;
    const next = localConversation(
      {
        id: detail.data.conversation.id,
        agentId: detail.data.conversation.agentId,
        title: detail.data.conversation.title,
        createdAt: detail.data.conversation.createdAt,
      },
      titleFromDetail(detail.data),
    );
    upsertLocalConversation(next);
    setLocal(loadLocalConversations());
  }, [detail.data]);

  const switchAgent = (id: string): void => {
    closeStream();
    setRun(null);
    setLastRun(null);
    setLastRunId(null);
    hydratedRef.current = null;
    setConversationId(null);
    setItems([]);
    onAgentChange(id);
  };

  const showWelcome = items.length === 0 && !run && (conversationId === null || !detail.isPending);
  const lastAgentRun = recentRuns.data?.items.find((item) => item.agentId === agentId) ?? null;

  return (
    <div className="flex h-full min-h-0">
      <h1 className="sr-only">对话</h1>

      {/* 会话列表：参考页的侧栏形态——白底、行高 36、圆角 9、悬停浅灰。 */}
      <aside
        className={cn(
          'flex w-[280px] shrink-0 flex-col overflow-hidden border-r border-line bg-surface',
          historyOpen ? 'absolute inset-y-0 left-0 z-20 shadow-overlay' : 'hidden lg:flex',
        )}
        aria-label="会话历史"
      >
        <div className="flex h-14 items-center gap-2 px-3">
          <span className="text-sm font-medium text-fg">会话</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="新建会话"
            className="ml-auto"
            onClick={newConversation}
          >
            <Plus className="size-4" strokeWidth={1.75} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="关闭会话列表"
            className="lg:hidden"
            onClick={() => setHistoryOpen(false)}
          >
            <X className="size-4" strokeWidth={1.75} />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {conversations.isPending ? <LoadingState rows={4} /> : null}
          {conversations.isError ? (
            <ErrorState error={conversations.error} onRetry={() => void conversations.refetch()} />
          ) : null}
          {history.length === 0 && !conversations.isPending ? (
            <p className="px-2 py-6 text-xs leading-relaxed text-subtle">
              还没有会话。发送第一条消息即可开始。
            </p>
          ) : null}
          <ul className="space-y-0.5">
            {history.map((conversation) => (
              <li key={conversation.id} className="group relative">
                <button
                  type="button"
                  aria-current={conversation.id === conversationId ? 'true' : undefined}
                  onClick={() => openConversation(conversation.id)}
                  className={cn(
                    'w-full rounded-[9px] px-2.5 py-2 pr-8 text-left transition-colors focus-visible:outline-none',
                    conversation.id === conversationId
                      ? 'bg-hover text-fg'
                      : 'text-muted hover:bg-hover hover:text-fg',
                  )}
                >
                  <span className="block truncate text-sm">{conversation.title}</span>
                  <span className="mt-0.5 block text-xs text-subtle">
                    {formatRelative(conversation.updatedAt)}
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`从「${conversation.title}」分支`}
                  title="分支"
                  disabled={branching !== null}
                  className="absolute right-1 top-2.5 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={() => void branch(conversation.id)}
                >
                  {branching === conversation.id ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <GitBranch className="size-3.5" strokeWidth={1.75} />
                  )}
                </Button>
              </li>
            ))}
          </ul>
        </div>
        {!conversations.data?.supported && history.length > 0 ? (
          <p className="border-t border-line px-3 py-2 text-xs leading-relaxed text-subtle">
            历史列表来自本浏览器；服务端列表接口上线后会自动切换。
          </p>
        ) : null}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* 顶部一行：移动端菜单 + 智能体选择器。没有标题、没有描述。 */}
        <header className="flex h-14 shrink-0 items-center gap-2 px-4 sm:px-6">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="打开会话列表"
            className="lg:hidden"
            onClick={() => setHistoryOpen(true)}
          >
            <MessageSquare className="size-4" strokeWidth={1.75} />
          </Button>
          <label className="sr-only" htmlFor="chat-agent">
            选择智能体
          </label>
          <div className="relative">
            <select
              id="chat-agent"
              value={agentId ?? ''}
              onChange={(event) => switchAgent(event.target.value)}
              className="h-8 max-w-56 cursor-pointer appearance-none rounded-full bg-hover pl-3.5 pr-9 text-sm text-fg hover:bg-chip focus-visible:outline-none"
            >
              {agents.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <ChevronDown
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted"
              strokeWidth={1.75}
            />
          </div>
        </header>

        <MessagePane
          items={items}
          loading={detail.isPending && conversationId !== null && !run}
          error={detail.isError ? detail.error : null}
          onRetry={() => void detail.refetch()}
          approvals={{
            pending: approving,
            onApprove: approve,
          }}
          approvalItems={(runApprovals.data?.items ?? []).filter(
            (item) => item.approvedAt === null,
          )}
          lastRun={lastRun}
          welcome={
            showWelcome ? (
              <WelcomeState
                agent={agent}
                lastRun={lastAgentRun}
                onPick={(text) => setInput(text)}
              />
            ) : null
          }
        />

        <div aria-live="polite" role="status" className="sr-only">
          {run
            ? run.status === 'queued'
              ? '已提交，等待沙盒'
              : run.status === 'reconnecting'
                ? '事件流断开，正在重连'
                : run.status === 'detached'
                  ? '事件流已中断，运行状态未知'
                  : `第 ${currentTurn(items)} 轮，${runningTool(items) ? `正在调用 ${runningTool(items)?.name}` : '等待模型响应'}`
            : ''}
        </div>
        <RunStatusBar run={run} items={items} now={now} cancelling={cancelling} onCancel={cancel} />

        {/* 输入胶囊：白底、28px 圆角、唯一带阴影的元素；发送是 32px 圆形黑底。 */}
        <form
          className="shrink-0 px-4 pb-5 pt-2 sm:px-6"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <div className="mx-auto w-full max-w-[728px]">
            <div className="flex items-end gap-2 rounded-[28px] bg-surface px-3 py-2.5 shadow-composer">
              <Textarea
                ref={composerRef}
                aria-label="消息"
                rows={1}
                placeholder={
                  run
                    ? run.runId
                      ? '运行中 · 结束后可继续输入'
                      : '已提交，等待沙盒…'
                    : 'Ask anything…'
                }
                title={run ? '本轮流式输出结束后即可继续输入，不会丢失当前内容' : undefined}
                disabled={!agent || Boolean(run)}
                value={input}
                className="min-h-[36px] flex-1 resize-none border-0 bg-transparent px-2 py-1.5 text-md shadow-none focus-visible:ring-0"
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    if (!run) void send();
                  }
                }}
              />
              {run ? (
                <span
                  className="mb-0.5 flex size-8 items-center justify-center rounded-full bg-sunken text-subtle"
                  title="运行中，结束后可发送"
                >
                  <ArrowUp className="size-4" strokeWidth={2} />
                </span>
              ) : (
                <Button
                  type="submit"
                  disabled={!agent || !input.trim()}
                  aria-label="发送消息"
                  className="mb-0.5 size-8 rounded-full bg-ink p-0 text-white hover:bg-ink-hover disabled:bg-sunken disabled:text-subtle"
                >
                  <ArrowUp className="size-4" strokeWidth={2} />
                </Button>
              )}
            </div>
            <div className="mt-2 flex items-center justify-center gap-3 text-xs text-subtle">
              <span>Enter 发送 · Shift+Enter 换行</span>
              {lastRunId ? (
                <Link
                  to="/runs/$runId"
                  params={{ runId: lastRunId }}
                  className="underline-offset-2 hover:text-fg hover:underline"
                >
                  查看本次运行
                </Link>
              ) : null}
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}

/** 本轮起点：最后一条用户消息之后才算，历史轮次不参与轮数与状态判断。 */
function currentRunItems(items: ChatItem[]): ChatItem[] {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.kind === 'user') return items.slice(index + 1);
  }
  return items;
}

function currentTurn(items: ChatItem[]): number {
  return Math.max(1, currentRunItems(items).filter((item) => item.kind === 'text').length);
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

function RunStatusBar({
  run,
  items,
  now,
  cancelling,
  onCancel,
}: {
  run: RunState | null;
  items: ChatItem[];
  now: number;
  cancelling: boolean;
  onCancel: () => void;
}) {
  if (!run) return null;
  const tool = runningTool(items);
  const turn = currentTurn(items);
  const text =
    run.status === 'queued'
      ? '已提交，等待沙盒'
      : run.status === 'reconnecting'
        ? '事件流断开，正在重连'
        : run.status === 'detached'
          ? '事件流已中断 · 运行状态未知'
          : `第 ${turn} 轮 · ${tool ? `正在调用 ${tool.name}` : '等待模型响应'}`;

  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-line bg-surface px-3 py-1.5">
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full bg-signal',
          run.status !== 'reconnecting' && run.status !== 'detached' && 'live-dot',
        )}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate text-2xs text-signal-text">{text}</span>
      {run.status === 'reconnecting' || run.status === 'detached' ? (
        <RefreshCw
          className={cn('size-3 text-signal-text', run.status === 'reconnecting' && 'animate-spin')}
          aria-hidden="true"
        />
      ) : null}
      <span className="shrink-0 font-mono text-2xs tabular-nums text-signal-text">
        {elapsed(now - run.startedAt)}
      </span>
      {run.runId ? (
        <Button
          variant="outline"
          size="sm"
          onClick={onCancel}
          disabled={cancelling}
          aria-busy={cancelling}
          aria-label="停止运行"
        >
          <CircleStop className="size-3" /> {cancelling ? '停止中…' : '停止'}
        </Button>
      ) : null}
    </div>
  );
}

function MessagePane({
  items,
  loading,
  error,
  onRetry,
  welcome,
  approvals,
  approvalItems,
  lastRun,
}: {
  items: ChatItem[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  welcome: ReactNode;
  approvals: {
    pending: string | null;
    onApprove: (item: ApprovalRequest) => void;
  };
  approvalItems: ApprovalRequest[];
  lastRun: RunMetrics | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  // 用户上滚后暂停自动滚动；只有贴底时才跟随新内容。
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = (): void => {
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
      setPinned(distance < 80);
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!pinned) return;
    const element = scrollRef.current;
    if (!element) return;
    // items 本身也要依赖：文本增量不改变长度，只改最后一个元素的内容。
    if (items.length === 0) return;
    element.scrollTop = element.scrollHeight;
  }, [pinned, items]);

  const scrollToBottom = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollTo({ top: element.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
    setPinned(true);
  };

  // 子调用挂到最上层父 Agent 下；只保留一层， grandchildren 平铺到同一层。
  const toolById = new Map<string, Extract<ChatItem, { kind: 'tool' }>>();
  for (const item of items) {
    if (item.kind === 'tool') toolById.set(item.toolUseId, item);
  }
  const rootOf = (item: Extract<ChatItem, { kind: 'tool' }>): string | null => {
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
  const children = new Map<string, Extract<ChatItem, { kind: 'tool' }>[]>();
  const topLevel: ChatItem[] = [];
  for (const item of items) {
    if (item.kind !== 'tool' || item.parentToolUseId === undefined) {
      topLevel.push(item);
      continue;
    }
    const root = rootOf(item);
    if (root === null) {
      topLevel.push(item);
      continue;
    }
    const list = children.get(root) ?? [];
    list.push(item);
    children.set(root, list);
  }

  // 审批卡放在被拒工具的原位置；匹配不上的兜底放在末尾，不能吞掉。
  const placed = new Set<string>();
  const approvalFor = (item: Extract<ChatItem, { kind: 'tool' }>): ApprovalRequest | undefined => {
    const match = approvalItems.find(
      (approval) =>
        (approval.serverName
          ? item.name === `mcp__${approval.serverName}__${approval.toolName}`
          : false) || item.name.endsWith(`__${approval.toolName}`),
    );
    if (match) placed.add(match.id);
    return match;
  };
  const renderTool = (
    item: Extract<ChatItem, { kind: 'tool' }>,
    nested: boolean,
    childCount: number,
  ): ReactNode => {
    const approval = approvalFor(item);
    return (
      <div key={`${item.toolUseId}-${nested ? 'child' : 'root'}`} className="space-y-1.5">
        <ToolRow item={item} nested={nested} childCount={childCount} />
        {approval ? (
          <ApprovalCard
            item={approval}
            pending={approvals.pending}
            onApprove={approvals.onApprove}
          />
        ) : null}
      </div>
    );
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} className="h-full overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="mx-auto max-w-3xl">
            <LoadingState rows={4} />
          </div>
        ) : null}
        {error ? (
          <div className="mx-auto max-w-3xl">
            <ErrorState error={error} onRetry={onRetry} />
          </div>
        ) : null}
        {!loading && !error && items.length === 0 ? welcome : null}
        {!loading && !error && items.length > 0 ? (
          <div className="mx-auto max-w-3xl space-y-4">
            {topLevel.map((item, index) => {
              if (item.kind === 'tool') {
                const kids = children.get(item.toolUseId) ?? [];
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 只追加的流式日志，索引即顺序
                  <div key={`${index}-${item.toolUseId}`} className="space-y-1">
                    {renderTool(item, item.parentToolUseId !== undefined, kids.length)}
                    {kids.map((child) => renderTool(child, true, 0))}
                  </div>
                );
              }
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: 只追加的流式日志，索引即顺序
                <ItemView key={`${index}-${item.kind}`} item={item} />
              );
            })}
            {lastRun ? <RunMetricsLine run={lastRun} /> : null}
            {approvalItems
              .filter((item) => !placed.has(item.id))
              .map((item) => (
                <ApprovalCard
                  key={item.id}
                  item={item}
                  pending={approvals.pending}
                  onApprove={approvals.onApprove}
                />
              ))}
          </div>
        ) : null}
      </div>
      {!pinned && items.length > 0 ? (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-[2px] border border-line bg-surface px-3 py-1.5 text-2xs text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
        >
          <ArrowDown className="size-3" /> 回到底部
        </button>
      ) : null}
    </div>
  );
}

/**
 * 空态：参考页的核心构图——两行 24px 问候语，输入框在中间，建议卡在下方。
 *
 * 与上一版的差别：不再把「绑定 server / 权限 / 最近运行」堆在中间，
 * 那些是配置信息，不属于发起任务的现场。
 */
function WelcomeState({
  agent,
  lastRun,
  onPick,
}: {
  agent: AgentView | null;
  lastRun: RecentRun | null;
  onPick: (text: string) => void;
}) {
  const suggestions = agent
    ? [
        `用 ${agent.name} 总结一下最近的运行`,
        `检查 ${agent.name} 绑定的工具是否可用`,
        '帮我把一个 HTTP API 转成 MCP 工具',
        '解释一次失败运行的错误',
      ]
    : [];

  return (
    <div className="mx-auto flex w-full max-w-[728px] flex-1 flex-col justify-center px-4 pb-8">
      <h2 className="text-center text-lg font-medium leading-[30px] text-fg">你好</h2>
      <p className="mt-1 text-center text-lg font-medium leading-[26px] text-muted">
        今天想做什么？
      </p>

      {suggestions.length > 0 ? (
        <div className="mt-8 flex flex-wrap justify-center gap-2">
          {suggestions.map((text) => (
            <button
              key={text}
              type="button"
              onClick={() => onPick(text)}
              className="h-[72px] w-[136px] overflow-hidden rounded-[16px] bg-chip p-4 text-left text-sm leading-[18px] text-muted transition-colors hover:bg-hover focus-visible:outline-none"
            >
              <span className="line-clamp-2">{text}</span>
            </button>
          ))}
        </div>
      ) : null}

      {lastRun ? (
        <p className="mt-6 text-center text-xs text-subtle">
          上次运行 <RunStatusBadge status={lastRun.status} />{' '}
          <span className="font-mono tabular-nums">
            {formatDuration(lastRun.latencyMs)} · {formatCost(lastRun.costUsd)}
          </span>
        </p>
      ) : null}
    </div>
  );
}

/** 只为展示取字段，避免把 Agent 类型一路传进展示组件。 */
type AgentView = NonNullable<ReturnType<typeof useAgents>['data']>[number];

function ItemView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[2px] border border-line bg-panel px-3 py-2 text-base leading-relaxed text-fg">
            {item.text}
          </div>
        </div>
      );
    case 'text':
      return <AssistantText text={item.text} />;
    case 'tool':
      return <ToolRow item={item} nested={false} childCount={0} />;
    case 'notice':
      return (
        <div
          className={cn(
            'flex items-center gap-1.5 text-2xs',
            item.tone === 'ok'
              ? 'text-success'
              : item.tone === 'error'
                ? 'text-danger'
                : 'text-subtle',
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
}

/** 助手文本不用气泡；围栏代码交给 CodeBlock，其余保留换行与空白。 */
function AssistantText({ text }: { text: string }) {
  if (!text.includes('```')) {
    return (
      <CollapsibleText
        text={text}
        className="whitespace-pre-wrap break-words text-base leading-[1.7] text-fg"
      />
    );
  }
  const parts: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(/```([^\n]*)\n?([\s\S]*?)```/g)) {
    const start = match.index;
    const prose = text.slice(last, start);
    if (prose) {
      parts.push(
        <div
          key={index++}
          className="whitespace-pre-wrap break-words text-base leading-[1.7] text-fg"
        >
          {prose}
        </div>,
      );
    }
    const language = match[1]?.trim() ?? '';
    const code = (match[2] ?? '').replace(/\n$/, '');
    parts.push(
      <CodeBlock
        key={index++}
        code={code}
        className="my-2"
        {...(language ? { copyLabel: `复制 ${language}` } : {})}
      />,
    );
    last = start + match[0].length;
  }
  const tail = text.slice(last);
  if (tail) {
    parts.push(
      <div
        key={index++}
        className="whitespace-pre-wrap break-words text-base leading-[1.7] text-fg"
      >
        {tail}
      </div>,
    );
  }
  return <div className="space-y-1">{parts}</div>;
}

/** 一行读数：完成 · 轮次 · 耗时 · token · 成本 · 查看详情。 */
function RunMetricsLine({ run }: { run: RunMetrics }) {
  const tone =
    run.status === 'succeeded'
      ? 'text-success'
      : run.status === 'cancelled'
        ? 'text-subtle'
        : 'text-danger';
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-1.5 font-mono text-2xs tabular-nums text-subtle">
        <span className={tone}>{outcomeLabel[run.status]}</span>
        {run.turns !== undefined ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{run.turns} 轮</span>
          </>
        ) : null}
        <span aria-hidden="true">·</span>
        <span>{(run.durationMs / 1000).toFixed(1)}s</span>
        {run.tokens !== undefined ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{run.tokens.toLocaleString('en-US')} tok</span>
          </>
        ) : null}
        {run.costUsd !== undefined ? (
          <>
            <span aria-hidden="true">·</span>
            <span>${run.costUsd.toFixed(3)}</span>
          </>
        ) : null}
        <span aria-hidden="true">·</span>
        <Link
          to="/runs/$runId"
          params={{ runId: run.runId }}
          className="text-fg underline decoration-line-strong underline-offset-2 hover:text-signal-text"
        >
          查看详情
        </Link>
      </div>
      {run.error ? <p className="break-words text-2xs text-danger">{run.error}</p> : null}
    </div>
  );
}

/** 审批只记录，不重试；文案必须和真实行为一致。 */
function ApprovalCard({
  item,
  pending,
  onApprove,
}: {
  item: ApprovalRequest;
  pending: string | null;
  onApprove: (item: ApprovalRequest) => void;
}) {
  const busy = pending === item.id;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 rounded-[2px] border border-warning-line bg-warning-soft px-3 py-2"
    >
      <CircleAlert className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-xs leading-relaxed text-fg">
        工具 <code className="font-mono text-xs">{item.toolName}</code>
        {item.serverName ? <span className="text-muted"> @ {item.serverName}</span> : null}{' '}
        需要批准。批准只记录到该 server；继续请在输入框重新发送消息（新一次运行）。
      </div>
      <Button size="sm" disabled={busy} aria-busy={busy} onClick={() => onApprove(item)}>
        {busy ? '批准中…' : '批准并继续（新一次运行）'}
      </Button>
    </div>
  );
}

function inputPreview(input: string | undefined): string {
  if (!input) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return oneLine(input);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return oneLine(typeof parsed === 'string' ? parsed : (JSON.stringify(parsed) ?? ''));
  }
  return Object.entries(parsed)
    .slice(0, 3)
    .map(
      ([key, value]) =>
        `${key}=${oneLine(typeof value === 'string' ? value : (JSON.stringify(value) ?? ''))}`,
    )
    .join(' · ');
}

function oneLine(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > 48 ? `${flat.slice(0, 48)}…` : flat;
}

function ToolRow({
  item,
  nested,
  childCount,
}: {
  item: Extract<ChatItem, { kind: 'tool' }>;
  nested: boolean;
  childCount: number;
}) {
  const running = item.result === undefined;
  const failed = toolFailed(item.result);
  const [open, setOpen] = useState(running);

  // 跑着的自动展开，结束后收起；用户仍可手动再展开。
  useEffect(() => {
    setOpen(running);
  }, [running]);

  const duration =
    item.startedAt !== undefined && item.endedAt !== undefined
      ? item.endedAt - item.startedAt
      : undefined;
  const size = useMemo(
    () => (item.result === undefined ? undefined : new TextEncoder().encode(item.result).length),
    [item.result],
  );
  const preview = inputPreview(item.input);

  return (
    <div
      className={cn(
        'overflow-hidden border border-line bg-surface',
        nested && 'border-l-2 border-l-signal-line',
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-signal"
      >
        {nested ? (
          <span className="shrink-0 font-mono text-2xs text-subtle" aria-hidden="true">
            ↳
          </span>
        ) : (
          <Wrench className="size-3 shrink-0 text-subtle" aria-hidden="true" />
        )}
        <span className="sr-only">{running ? '运行中' : failed ? '失败' : '完成'}</span>
        {running ? (
          <LoaderCircle
            className="size-3 shrink-0 animate-spin text-signal-text"
            aria-hidden="true"
          />
        ) : failed ? (
          <CircleAlert className="size-3 shrink-0 text-danger" aria-hidden="true" />
        ) : (
          <Check className="size-3 shrink-0 text-success" aria-hidden="true" />
        )}
        <code className="max-w-[38%] shrink-0 truncate font-mono text-2xs text-fg">
          {item.name}
        </code>
        {childCount > 0 ? (
          <span className="shrink-0 text-2xs text-signal-text">子智能体 · {childCount} 次调用</span>
        ) : null}
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-subtle">
          {preview || (running ? '等待参数…' : '')}
        </span>
        {duration !== undefined ? (
          <span className="shrink-0 font-mono text-2xs tabular-nums text-subtle">
            {formatDuration(duration)}
          </span>
        ) : null}
        {size !== undefined ? (
          <span className="shrink-0 font-mono text-2xs tabular-nums text-subtle">
            {formatBytes(size)}
          </span>
        ) : null}
        <ChevronDown
          className={cn('size-3 shrink-0 text-subtle transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div className="grid gap-2 border-t border-line p-2 md:grid-cols-2">
          <div className="min-w-0">
            <div className="mb-1 px-1 text-2xs uppercase tracking-[0.06em] text-subtle">参数</div>
            {item.input !== undefined ? (
              <JsonBlock value={item.input} maxHeight="16rem" />
            ) : (
              <p className="px-1 text-2xs text-subtle">等待参数…</p>
            )}
          </div>
          <div className="min-w-0">
            <div className="mb-1 px-1 text-2xs uppercase tracking-[0.06em] text-subtle">结果</div>
            {item.result !== undefined ? (
              <JsonBlock value={item.result} maxHeight="20rem" />
            ) : (
              <p className="px-1 text-2xs text-subtle">等待结果…</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
