import { chatEventSchema } from '@agentport/shared';
import { Link } from '@tanstack/react-router';
import {
  Activity,
  ArrowDown,
  Bot,
  ChevronDown,
  CircleAlert,
  CircleStop,
  GitBranch,
  LoaderCircle,
  MessageSquare,
  MessagesSquare,
  Plus,
  RefreshCw,
  Send,
  Wrench,
  X,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { JsonBlock } from '../components/code-block.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Badge } from '../components/ui/badge.js';
import { Button, buttonVariants } from '../components/ui/button.js';
import { Textarea } from '../components/ui/textarea.js';
import { api, type ChatAccepted, errorMessage } from '../lib/api.js';
import {
  applyEvent,
  type ChatItem,
  historyToItems,
  type LocalConversation,
  loadLocalConversations,
  localConversation,
  titleFromDetail,
  upsertLocalConversation,
} from '../lib/chat-state.js';
import { cn } from '../lib/cn.js';
import { formatRelative } from '../lib/format.js';
import { useAgents, useConversation, useConversations } from '../lib/queries.js';
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
            <Link to="/agents" className="text-xs text-accent hover:underline">
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

interface RunState {
  runId: string;
  conversationId: string;
  status: 'queued' | 'streaming' | 'reconnecting';
}

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
  const [local, setLocal] = useState<LocalConversation[]>(() => loadLocalConversations());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [branching, setBranching] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // 审批针对产生错误的 run；run_finished 后 run 会被清空，所以单独保留 id。
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [approved, setApproved] = useState<string[]>([]);
  const [approving, setApproving] = useState<string | null>(null);
  // 服务端重连时从头回放事件流；保留发起前的消息，避免文本重复。
  const baseItemsRef = useRef<ChatItem[]>([]);
  const sourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef<number | null>(null);
  // 切换会话时才从服务端回填历史；否则流式结束瞬间的重新查询会覆盖刚收到的回答。
  const hydratedRef = useRef<string | null>(null);

  const conversations = useConversations(agentId);
  const detail = useConversation(conversationId);

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

  const openStream = useCallback(
    (accepted: ChatAccepted, attempt = 0): void => {
      closeStream();
      if (attempt > 0) setItems(baseItemsRef.current);
      const source = new EventSource(`/api/chat/${accepted.runId}/events`);
      sourceRef.current = source;
      let finished = false;

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
        if (event.type === 'run_finished' || event.type === 'error') {
          finished = true;
          closeStream();
          setRun(null);
        }
      };

      source.onerror = () => {
        // 服务端在 run_finished 后主动结束流；此后重连没有意义。
        if (finished || sourceRef.current !== source) return;
        source.close();
        sourceRef.current = null;
        if (attempt < 3) {
          setRun({ ...accepted, status: 'reconnecting' });
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
    baseItemsRef.current = items;
    setItems((previous) => [...previous, { kind: 'user', text }]);
    setRun({ runId: '', conversationId: conversationId ?? '', status: 'queued' });
    try {
      const accepted = await api.sendChat({
        agentId: agent.id,
        message: text,
        ...(conversationId ? { conversationId } : {}),
      });
      setConversationId(accepted.conversationId);
      setLastRunId(accepted.runId);
      hydratedRef.current = accepted.conversationId;
      setRun({ ...accepted, status: 'streaming' });
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
      toastError(error);
      setItems((previous) => [
        ...previous,
        { kind: 'notice', tone: 'error', text: errorMessage(error) },
      ]);
    }
  };

  const cancel = (): void => {
    if (!run?.runId || cancelling) return;
    setCancelling(true);
    api
      .cancelRun(run.runId)
      .catch((error) => toastError(error))
      .finally(() => setCancelling(false));
  };

  /** 只记录批准；重试由用户重新发送消息完成，不做自动重试。 */
  const approve = (toolName: string): void => {
    const runId = run?.runId || lastRunId;
    if (!runId || approving) return;
    setApproving(toolName);
    api
      .approveRun(runId, toolName)
      .then(({ approvals }) => {
        setApproved(approvals);
        toastSuccess(`已批准 ${toolName}，重新发送消息即可继续`);
      })
      .catch((error) => toastError(error))
      .finally(() => setApproving(null));
  };

  const openConversation = (id: string): void => {
    closeStream();
    setRun(null);
    setLastRunId(null);
    setApproved([]);
    hydratedRef.current = null;
    setConversationId(id);
    setItems([]);
    setHistoryOpen(false);
  };

  const newConversation = (): void => {
    closeStream();
    setRun(null);
    setLastRunId(null);
    setApproved([]);
    hydratedRef.current = null;
    setConversationId(null);
    setItems([]);
    setHistoryOpen(false);
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
    setLastRunId(null);
    setApproved([]);
    hydratedRef.current = null;
    setConversationId(null);
    setItems([]);
    onAgentChange(id);
  };

  const showWelcome = items.length === 0 && !detail.isPending && !run;

  return (
    <div className="relative flex h-full min-h-0 gap-4">
      <h1 className="sr-only">对话</h1>
      <aside
        className={cn(
          'flex w-64 shrink-0 flex-col overflow-hidden rounded-[10px] border border-line bg-surface',
          historyOpen ? 'absolute inset-y-4 left-4 z-20 shadow-2xl' : 'hidden lg:flex',
        )}
        aria-label="会话历史"
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <span className="text-[13px] font-semibold text-fg">会话</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="新建会话"
            className="ml-auto"
            onClick={newConversation}
          >
            <Plus className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="关闭会话列表"
            className="lg:hidden"
            onClick={() => setHistoryOpen(false)}
          >
            <X className="size-3.5" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {conversations.isPending ? <LoadingState rows={4} /> : null}
          {conversations.isError ? (
            <ErrorState error={conversations.error} onRetry={() => void conversations.refetch()} />
          ) : null}
          {history.length === 0 && !conversations.isPending ? (
            <p className="px-2 py-6 text-center text-[11px] leading-relaxed text-subtle">
              还没有会话。
              <br />
              发送第一条消息即可开始。
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
                    'w-full rounded-md px-2 py-1.5 pr-8 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
                    conversation.id === conversationId
                      ? 'bg-accent-soft text-fg'
                      : 'text-muted hover:bg-surface-2/60 hover:text-fg',
                  )}
                >
                  <span className="block truncate text-xs">{conversation.title}</span>
                  <span className="mt-0.5 block text-[10px] text-subtle">
                    {formatRelative(conversation.updatedAt)}
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`从「${conversation.title}」分支`}
                  title="分支"
                  disabled={branching !== null}
                  className="absolute top-1 right-1 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={() => void branch(conversation.id)}
                >
                  {branching === conversation.id ? (
                    <LoaderCircle className="size-3 animate-spin" />
                  ) : (
                    <GitBranch className="size-3" />
                  )}
                </Button>
              </li>
            ))}
          </ul>
        </div>
        {!conversations.data?.supported && history.length > 0 ? (
          <p className="border-t border-line px-3 py-2 text-[10px] leading-relaxed text-subtle">
            历史列表来自本浏览器；服务端列表接口上线后会自动切换。
          </p>
        ) : null}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-surface">
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="打开会话列表"
            className="lg:hidden"
            onClick={() => setHistoryOpen(true)}
          >
            <MessageSquare className="size-4" />
          </Button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-[13px] font-medium text-fg">
                {agent?.name ?? '选择智能体'}
              </span>
              {run ? (
                <Badge variant="warn">
                  <LoaderCircle className="size-2.5 animate-spin" />
                  {run.status === 'reconnecting' ? '重连中' : '运行中'}
                </Badge>
              ) : null}
            </div>
            {agent?.description ? (
              <p className="truncate text-[11px] text-subtle">{agent.description}</p>
            ) : null}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <label className="sr-only" htmlFor="chat-agent">
              选择智能体
            </label>
            <select
              id="chat-agent"
              value={agentId ?? ''}
              onChange={(event) => switchAgent(event.target.value)}
              className="h-7 max-w-40 cursor-pointer rounded-md border border-line bg-surface-2 px-2 text-xs text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              {agents.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
        </header>

        <MessagePane
          items={items}
          loading={detail.isPending && conversationId !== null}
          error={detail.isError ? detail.error : null}
          onRetry={() => void detail.refetch()}
          approvals={{
            approved,
            pending: approving,
            ...(run?.runId ? { runId: run.runId } : lastRunId ? { runId: lastRunId } : {}),
            onApprove: approve,
          }}
          welcome={
            showWelcome ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <div className="flex size-10 items-center justify-center rounded-full bg-surface-2 text-subtle">
                  <MessagesSquare className="size-5" />
                </div>
                <div className="text-sm font-medium text-fg">{agent?.name}</div>
                <p className="max-w-md text-xs leading-relaxed text-subtle">
                  {agent?.systemPrompt
                    ? agent.systemPrompt.slice(0, 240)
                    : '该智能体没有系统提示词。发送一条消息开始。'}
                </p>
              </div>
            ) : null
          }
        />

        {run?.status === 'reconnecting' ? (
          <div
            role="status"
            className="flex items-center gap-2 border-t border-warning/30 bg-warning/5 px-3 py-1.5 text-[11px] text-warning"
          >
            <RefreshCw className="size-3 animate-spin" />
            事件流断开，正在重连…已收到的内容不会丢失。
          </div>
        ) : null}

        <form
          className="shrink-0 border-t border-line p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <div className="flex items-end gap-2">
            <Textarea
              aria-label="消息"
              rows={2}
              placeholder={run ? '运行中，可继续输入，完成后发送' : 'Enter 发送，Shift+Enter 换行'}
              disabled={!agent}
              value={input}
              className="min-h-[44px] flex-1 resize-none py-2.5 text-[13px]"
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (!run) void send();
                }
              }}
            />
            {run ? (
              <Button
                variant="outline"
                onClick={cancel}
                aria-label="停止运行"
                disabled={cancelling}
                aria-busy={cancelling}
              >
                <CircleStop className="size-4" /> {cancelling ? '停止中…' : '停止'}
              </Button>
            ) : lastRunId ? (
              <Link
                to="/runs/$runId"
                params={{ runId: lastRunId }}
                className={cn(buttonVariants({ variant: 'outline', size: 'default' }), 'h-[44px]')}
              >
                <Activity className="size-4" /> 查看本次运行
              </Link>
            ) : (
              <Button
                type="submit"
                disabled={!agent || !input.trim()}
                aria-label="发送消息"
                className="h-[44px]"
              >
                <Send className="size-4" />
                发送
              </Button>
            )}
          </div>
        </form>
      </section>
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
}: {
  items: ChatItem[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  welcome: ReactNode;
  approvals: {
    approved: string[];
    pending: string | null;
    runId?: string;
    onApprove: (toolName: string) => void;
  };
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
    if (element) element.scrollTop = element.scrollHeight;
  }, [pinned]);

  const scrollToBottom = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollTo({ top: element.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
    setPinned(true);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} className="h-full overflow-y-auto px-4 py-4" aria-live="polite">
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
            {items.map((item, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 消息是只追加的流式日志，顺序即身份
              <ItemView key={index} item={item} />
            ))}
          </div>
        ) : null}
        <ApprovalCards items={items} approvals={approvals} />
      </div>
      {!pinned && items.length > 0 ? (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 py-1.5 text-[11px] text-muted shadow-lg transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <ArrowDown className="size-3" /> 回到底部
        </button>
      ) : null}
    </div>
  );
}

function ItemView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-xl rounded-br-sm bg-accent/15 px-3.5 py-2 text-[13px] leading-relaxed text-fg">
            {item.text}
          </div>
        </div>
      );
    case 'text':
      return (
        <div className="whitespace-pre-wrap break-words text-[13px] leading-[1.7] text-fg/90">
          {item.text}
        </div>
      );
    case 'tool':
      return <ToolCard item={item} />;
    case 'notice':
      return (
        <div
          className={cn(
            'flex items-center gap-1.5 text-[11px]',
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

/** 平台 MCP 端点未批准时返回的固定文案；其余错误正常显示在工具卡片里。 */
const APPROVAL_PATTERN = /^需要批准：(.+?)。请在运行详情页批准后重试。$/;

function pendingApprovals(items: ChatItem[], approved: string[]): string[] {
  const names = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'tool' || item.result === undefined) continue;
    const match = APPROVAL_PATTERN.exec(item.result.trim());
    if (match?.[1] && !approved.includes(match[1])) names.add(match[1]);
  }
  return [...names];
}

/** 一次 run 内同一工具只批准一次；批准后由用户重新发消息，不自动重试。 */
function ApprovalCards({
  items,
  approvals,
}: {
  items: ChatItem[];
  approvals: {
    approved: string[];
    pending: string | null;
    runId?: string;
    onApprove: (toolName: string) => void;
  };
}) {
  const names = pendingApprovals(items, approvals.approved);
  if (names.length === 0 || !approvals.runId) return null;
  return (
    <div className="mx-auto mt-4 max-w-3xl space-y-2">
      {names.map((name) => {
        const busy = approvals.pending === name;
        return (
          <div
            key={name}
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning/5 px-3.5 py-2.5"
          >
            <CircleAlert className="size-4 shrink-0 text-warning" />
            <div className="min-w-0 flex-1 text-xs leading-relaxed text-fg/90">
              工具 <code className="font-mono text-[11.5px] text-fg">{name}</code>{' '}
              需要批准后才能调用。批准后请重新发送消息。
            </div>
            <Button
              size="sm"
              disabled={busy}
              aria-busy={busy}
              onClick={() => approvals.onApprove(name)}
            >
              {busy ? '批准中…' : '批准并重试'}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function ToolCard({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const done = item.result !== undefined;
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-canvas/60">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-2/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
      >
        <Wrench className={cn('size-3.5', done ? 'text-muted' : 'text-warning')} />
        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg">{item.name}</code>
        <Badge variant={done ? 'default' : 'warn'}>
          {done ? (
            '完成'
          ) : (
            <>
              <LoaderCircle className="size-2.5 animate-spin" /> 运行中
            </>
          )}
        </Badge>
        <ChevronDown
          className={cn('size-3.5 text-subtle transition-transform', open && 'rotate-180')}
        />
      </button>
      {open ? (
        <div className="space-y-2 border-t border-line p-2">
          <div>
            <div className="mb-1 px-1 text-[10px] uppercase tracking-wider text-subtle">参数</div>
            {item.input !== undefined ? (
              <JsonBlock value={item.input} maxHeight="16rem" />
            ) : (
              <p className="px-1 text-[11px] text-subtle">等待参数…</p>
            )}
          </div>
          <div>
            <div className="mb-1 px-1 text-[10px] uppercase tracking-wider text-subtle">结果</div>
            {item.result !== undefined ? (
              <JsonBlock value={item.result} maxHeight="20rem" />
            ) : (
              <p className="px-1 text-[11px] text-subtle">等待结果…</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
