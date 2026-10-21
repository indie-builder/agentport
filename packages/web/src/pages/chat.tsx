import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { CodeBlock, CollapsibleText, JsonBlock } from '../components/code-block.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Button } from '../components/ui/button.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../components/ui/collapsible.js';
import { Message, MessageContent, MessageGroup } from '../components/ui/message.js';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '../components/ui/message-scroller.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import { Sheet, SheetContent, SheetTitle } from '../components/ui/sheet.js';
import { Textarea } from '../components/ui/textarea.js';
import { type ApprovalRequest, api } from '../lib/api.js';
import {
  type ChatItem,
  historyToItems,
  type LocalConversation,
  loadLocalConversations,
  localConversation,
  titleFromDetail,
  toolFailed,
  upsertLocalConversation,
} from '../lib/chat-state.js';
import {
  type RunMetrics,
  type RunOutcome,
  type RunState,
  useChatStore,
} from '../lib/chat-store.js';
import { cn } from '../lib/cn.js';
import { formatDuration, formatRelative } from '../lib/format.js';
import { useAgents, useConversation, useConversations, useRunApprovals } from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { useChatStream } from '../lib/use-chat-stream.js';

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
            <Link to="/agents" className="text-xs text-fg hover:underline">
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

const outcomeLabel: Record<RunOutcome, string> = {
  succeeded: '完成',
  failed: '失败',
  cancelled: '已停止',
  timeout: '超时',
};

/** 设计规范 §9：只有展开折叠这类状态切换，150ms、ease-out、不加位移。 */
const EXPAND = { duration: 0.15, ease: 'easeOut' } as const;
const STILL = { duration: 0 } as const;

/** 与 Tailwind 的 lg 断点一致：只有这一侧需要可拖拽分栏。 */
const DESKTOP = '(min-width: 64rem)';

function useDesktop(): boolean {
  const [desktop, setDesktop] = useState(() => window.matchMedia(DESKTOP).matches);
  useEffect(() => {
    const query = window.matchMedia(DESKTOP);
    const onChange = (): void => setDesktop(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return desktop;
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
  const conversationId = useChatStore((state) => state.conversationId);
  const items = useChatStore((state) => state.items);
  const run = useChatStore((state) => state.run);
  const lastRun = useChatStore((state) => state.lastRun);
  const lastRunId = useChatStore((state) => state.lastRunId);
  const historyOpen = useChatStore((state) => state.historyOpen);
  const setInput = useChatStore((state) => state.setInput);
  const setHistoryOpen = useChatStore((state) => state.setHistoryOpen);
  const client = useQueryClient();
  const [local, setLocal] = useState<LocalConversation[]>(() => loadLocalConversations());
  // 本地索引只有两条写路径（新会话被接收、历史会话被打开），统一走这里刷新。
  const refreshLocal = useCallback(() => setLocal(loadLocalConversations()), []);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const desktop = useDesktop();

  const conversations = useConversations(agentId);
  const detail = useConversation(conversationId);
  const runApprovals = useRunApprovals(run?.runId || lastRunId);
  const historyLayout = useDefaultLayout({ id: 'chat-history' });

  // 空数组也要稳定：否则轮询之外的重渲染会给工具行换一个新身份。
  const approvalData = useMemo(() => runApprovals.data?.items ?? [], [runApprovals.data]);

  const stream = useChatStream({
    agentId,
    onAccepted: (accepted, text) => {
      upsertLocalConversation({
        id: accepted.conversationId,
        agentId: agent?.id ?? agentId ?? '',
        title: text.slice(0, 80),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      refreshLocal();
    },
  });

  // store 是模块级的：离开对话页时恢复到首次挂载的状态，避免下次进来看到上一次的会话。
  useEffect(() => () => useChatStore.getState().reset(), []);

  // 空态或运行结束后把焦点交还输入框，键盘用户不用再找一次。
  useEffect(() => {
    if (!run && items.length === 0) composerRef.current?.focus();
  }, [run, items.length]);

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

  // 三个写操作都用 mutation：pending 与失效刷新交给 TanStack Query。
  const cancelMutation = useMutation({
    mutationFn: (runId: string) => api.cancelRun(runId),
    onError: (error) => toastError(error),
    onSettled: (_data, _error, runId) => client.invalidateQueries({ queryKey: ['run', runId] }),
  });

  const approveMutation = useMutation({
    mutationFn: (item: ApprovalRequest & { runId: string }) =>
      api.approveRun(item.runId, item.serverId, item.toolName),
    onSuccess: (_data, item) => {
      toastSuccess(`已批准 ${item.toolName}；继续请在输入框重新发送消息`);
      void client.invalidateQueries({ queryKey: ['run-approvals'] });
    },
    onError: (error) => toastError(error),
  });

  const branchMutation = useMutation({
    mutationFn: (id: string) => api.branchConversation(id),
    onSuccess: (conversation) => {
      // 先切到新会话再失效列表：openConversation 会关闭流并清空当前消息。
      openConversation(conversation.id);
      void client.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: (error) => toastError(error),
  });

  const cancel = (): void => {
    // 没有 runId 时后端还没有可取消的 run；按钮也不会显示。
    if (!run?.runId) return;
    cancelMutation.mutate(run.runId);
  };

  /** 只记录批准；继续需要用户重新发送消息，也就是新一次运行。 */
  // 固定身份：工具行的 memo 依赖这个回调，每次渲染都换新函数会让整列重渲染。
  const approve = useCallback(
    (item: ApprovalRequest): void => {
      const runId = run?.runId || lastRunId;
      if (!runId) return;
      approveMutation.mutate({ ...item, runId });
    },
    [run?.runId, lastRunId, approveMutation.mutate],
  );

  const openConversation = (id: string): void => {
    stream.closeStream();
    stream.hydratedRef.current = null;
    useChatStore.getState().resetConversation(id);
    setHistoryOpen(false);
  };

  const newConversation = (): void => {
    stream.closeStream();
    stream.hydratedRef.current = null;
    useChatStore.getState().resetConversation(null);
    setHistoryOpen(false);
    composerRef.current?.focus();
  };

  // 分支：服务端复制消息，前端切到新会话；列表由 query 失效后刷新。
  const branch = (id: string): void => branchMutation.mutate(id);

  // 载入历史：每个会话只回填一次，之后由流式事件维护。
  const hydrated = stream.hydratedRef;
  useEffect(() => {
    const data = detail.data;
    if (!data || run) return;
    if (hydrated.current === data.conversation.id) return;
    hydrated.current = data.conversation.id;
    useChatStore.getState().setItems(historyToItems(data.messages));
  }, [detail.data, run, hydrated]);

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
    refreshLocal();
  }, [detail.data, refreshLocal]);

  const switchAgent = (id: string): void => {
    stream.closeStream();
    stream.hydratedRef.current = null;
    useChatStore.getState().resetConversation(null);
    onAgentChange(id);
  };

  const showWelcome =
    items.length === 0 && !run && !detail.isError && (conversationId === null || !detail.isPending);

  const historyPanel = (
    <HistoryPanel
      history={history}
      pending={conversations.isPending}
      error={conversations.isError ? conversations.error : null}
      onRetry={() => void conversations.refetch()}
      supported={conversations.data?.supported === true}
      conversationId={conversationId}
      branching={branchMutation.isPending ? branchMutation.variables : null}
      onOpen={openConversation}
      onBranch={branch}
    />
  );

  const column = (
    <ChatColumn
      agent={agent}
      agentId={agentId}
      agents={agents}
      onSwitchAgent={switchAgent}
      conversationId={conversationId}
      detail={detail}
      items={items}
      run={run}
      lastRun={lastRun}
      lastRunId={lastRunId}
      approving={approveMutation.isPending ? (approveMutation.variables?.id ?? null) : null}
      cancelling={cancelMutation.isPending}
      approvalItems={approvalData}
      onApprove={approve}
      onCancel={cancel}
      onOpenHistory={() => setHistoryOpen(true)}
      onPickSuggestion={setInput}
      showWelcome={showWelcome}
      send={stream.send}
      composerRef={composerRef}
    />
  );

  return (
    <div className="flex h-full min-h-0">
      <h1 className="sr-only">对话</h1>

      {/* 窄屏抽屉：Radix 负责焦点陷阱、Escape 与滚动锁；桌面分栏常驻，不挂这层。 */}
      <Sheet open={historyOpen && !desktop} onOpenChange={setHistoryOpen}>
        <SheetContent
          side="left"
          showCloseButton={false}
          aria-describedby={undefined}
          className="w-[294px]! max-w-none! gap-0 border-r border-line bg-surface p-0"
        >
          <SheetTitle className="sr-only">会话历史</SheetTitle>
          <HistoryHeader onNew={newConversation} onClose={() => setHistoryOpen(false)} />
          {historyPanel}
        </SheetContent>
      </Sheet>

      {desktop ? (
        <div className="flex min-h-0 w-full">
          <Group
            orientation="horizontal"
            defaultLayout={historyLayout.defaultLayout}
            onLayoutChanged={historyLayout.onLayoutChanged}
          >
            <Panel id="history" defaultSize={272} minSize={220} maxSize={420}>
              <aside
                className="flex h-full flex-col overflow-hidden bg-surface"
                aria-label="会话历史"
              >
                <HistoryHeader onNew={newConversation} />
                {historyPanel}
              </aside>
            </Panel>
            <Separator className="w-px border-r border-line" aria-label="调整会话列表宽度" />
            <Panel id="chat">{column}</Panel>
          </Group>
        </div>
      ) : (
        // 窄屏没有分栏：主列直接占满整行。
        <div className="flex min-h-0 min-w-0 flex-1">{column}</div>
      )}
    </div>
  );
}

function HistoryHeader({ onNew, onClose }: { onNew: () => void; onClose?: () => void }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 px-3 pt-3">
      <span className="text-sm font-medium text-fg">会话</span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="新建会话"
        className="ml-auto"
        onClick={onNew}
      >
        <Plus className="size-4" />
      </Button>
      {onClose ? (
        <Button variant="ghost" size="icon-sm" aria-label="关闭会话列表" onClick={onClose}>
          <X className="size-4" />
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
  error,
  onRetry,
  supported,
  conversationId,
  branching,
  onOpen,
  onBranch,
}: {
  history: HistoryEntry[];
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  supported: boolean;
  conversationId: string | null;
  branching: string | null;
  onOpen: (id: string) => void;
  onBranch: (id: string) => void;
}) {
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {pending ? <LoadingState rows={4} /> : null}
        {error ? <ErrorState error={error} onRetry={onRetry} /> : null}
        {history.length === 0 && !pending ? (
          <p className="px-2 py-6 text-xs leading-relaxed text-subtle">
            还没有会话。发送第一条消息即可开始。
          </p>
        ) : null}
        <ul className="space-y-0.5">
          {history.map((conversation) => (
            <li key={conversation.id} className="group relative">
              <Button
                variant="ghost"
                aria-current={conversation.id === conversationId ? 'true' : undefined}
                onClick={() => onOpen(conversation.id)}
                className={cn(
                  'h-auto w-full min-w-0 flex-col items-start gap-0 whitespace-normal rounded-item px-2.5 py-2 pr-8 text-left font-normal',
                  conversation.id === conversationId
                    ? 'bg-hover text-fg'
                    : 'text-muted-foreground hover:bg-hover hover:text-fg',
                )}
              >
                <span className="block w-full truncate text-sm">{conversation.title}</span>
                <span className="mt-0.5 block text-xs text-subtle">
                  {formatRelative(conversation.updatedAt)}
                </span>
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`从「${conversation.title}」分支`}
                title="分支"
                disabled={branching !== null}
                className="absolute right-1 top-2.5 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                onClick={() => onBranch(conversation.id)}
              >
                {branching === conversation.id ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <GitBranch className="size-3.5" />
                )}
              </Button>
            </li>
          ))}
        </ul>
      </div>
      {!supported && history.length > 0 ? (
        <p className="border-t border-line px-3 py-2 text-xs leading-relaxed text-subtle">
          历史列表来自本浏览器；服务端列表接口上线后会自动切换。
        </p>
      ) : null}
    </>
  );
}

function ChatColumn({
  agent,
  agentId,
  agents,
  onSwitchAgent,
  conversationId,
  detail,
  items,
  run,
  lastRun,
  lastRunId,
  approving,
  cancelling,
  approvalItems,
  onApprove,
  onCancel,
  onOpenHistory,
  onPickSuggestion,
  showWelcome,
  send,
  composerRef,
}: {
  agent: AgentView | null;
  agentId: string | null;
  agents: NonNullable<ReturnType<typeof useAgents>['data']>;
  onSwitchAgent: (id: string) => void;
  conversationId: string | null;
  detail: ReturnType<typeof useConversation>;
  items: ChatItem[];
  run: RunState | null;
  lastRun: RunMetrics | null;
  lastRunId: string | null;
  approving: string | null;
  cancelling: boolean;
  approvalItems: ApprovalRequest[];
  onApprove: (item: ApprovalRequest) => void;
  onCancel: () => void;
  onOpenHistory: () => void;
  onPickSuggestion: (text: string) => void;
  showWelcome: boolean;
  send: () => Promise<void>;
  composerRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const composer = (
    <Composer
      agent={agent}
      send={send}
      textareaRef={composerRef}
      lastRunId={lastRunId}
      welcome={showWelcome}
    />
  );

  // 两个入参直接来自 query 数据；缓存住身份，流式期间 WebSocket 增量不会让工具行的 memo 失效。
  const pendingApprovals = useMemo(
    () => approvalItems.filter((item) => item.approvedAt === null),
    [approvalItems],
  );
  const approvals = useMemo(() => ({ pending: approving, onApprove }), [approving, onApprove]);

  const agentOptions = agents.map((item) => ({ value: item.id, label: item.name }));

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-shell bg-surface outline outline-1 outline-shell-line">
      {/* 顶部一行：移动端菜单 + 智能体选择器。没有标题、没有描述。 */}
      <header className="flex h-11 shrink-0 items-center gap-2 px-3 pt-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="打开会话列表"
          className="lg:hidden"
          onClick={onOpenHistory}
        >
          <MessageSquare className="size-4" />
        </Button>
        <label className="sr-only" htmlFor="chat-agent">
          选择智能体
        </label>
        <Select
          value={agentId ?? ''}
          onValueChange={(next) => {
            if (next !== null) onSwitchAgent(next);
          }}
          items={agentOptions}
        >
          <SelectTrigger
            id="chat-agent"
            className="w-auto max-w-56 gap-1.5 rounded-pill border-0 bg-hover px-3 text-xs leading-3 tracking-[-0.12px] [&>span:first-child]:truncate [&_svg]:size-4"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {agentOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </header>

      <MessagePane
        items={items}
        loading={detail.isPending && conversationId !== null && !run}
        error={detail.isError ? detail.error : null}
        onRetry={() => void detail.refetch()}
        approvals={approvals}
        approvalItems={pendingApprovals}
        lastRun={lastRun}
        welcome={
          showWelcome ? (
            <WelcomeState agent={agent} onPick={onPickSuggestion}>
              {composer}
            </WelcomeState>
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
      <RunStatusBar run={run} items={items} cancelling={cancelling} onCancel={onCancel} />

      {showWelcome ? null : composer}
    </section>
  );
}

/** 输入胶囊：白底、28px 圆角、唯一带阴影的元素；发送是 32px 圆形黑底。 */
function Composer({
  agent,
  send,
  textareaRef,
  lastRunId,
  welcome,
}: {
  agent: AgentView | null;
  send: () => Promise<void>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  lastRunId: string | null;
  welcome: boolean;
}) {
  // 只订阅输入内容：打字不会重渲染消息列表所在的 ChatColumn。
  const input = useChatStore((state) => state.input);
  const setInput = useChatStore((state) => state.setInput);
  const run = useChatStore((state) => state.run);
  return (
    <form
      className={cn('w-full shrink-0', !welcome && 'mx-auto max-w-[760px] px-4 pb-5 pt-2')}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="mx-auto w-full max-w-[728px]">
        <div className="flex h-14 items-center gap-3 rounded-[28px] border border-transparent bg-surface py-[11px] pl-6 pr-3 shadow-composer">
          <Textarea
            ref={textareaRef}
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
            className="h-8 min-h-8 min-w-0 flex-1 resize-none rounded-none border-0 bg-transparent px-0 py-1.5 text-md leading-5 tracking-[-0.15px] shadow-none placeholder:text-muted-foreground focus-visible:ring-0"
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
              type="button"
              disabled
              aria-label="发送消息"
              title="运行中，结束后可发送"
              className="size-8 shrink-0 rounded-pill p-0 disabled:bg-hover"
            >
              <ArrowUp className="size-4" />
            </Button>
          ) : (
            <Button
              type="submit"
              disabled={!agent || !input.trim()}
              aria-label="发送消息"
              className="size-8 shrink-0 rounded-pill bg-fg p-0 text-surface hover:bg-fg/90 disabled:bg-hover disabled:text-subtle"
            >
              <ArrowUp className="size-4" />
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
  cancelling,
  onCancel,
}: {
  run: RunState | null;
  items: ChatItem[];
  cancelling: boolean;
  onCancel: () => void;
}) {
  // 计时只在存在 run 时刷新；每秒一次，状态条以外的行不跟着重渲染。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!run) return;
    setNow(Date.now());
    if (!run.runId) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run]);

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
      <span className="size-1.5 shrink-0 rounded-full bg-ink" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-2xs text-fg">{text}</span>
      {run.status === 'reconnecting' || run.status === 'detached' ? (
        <RefreshCw
          className={cn('size-3 text-fg', run.status === 'reconnecting' && 'animate-spin')}
          aria-hidden="true"
        />
      ) : null}
      <span className="shrink-0 font-mono text-2xs tabular-nums text-fg">
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
  const reduce = useReducedMotion();
  const turns = useMemo(
    () => messageTurns(items, Boolean(lastRun) || approvalItems.length > 0),
    [items, lastRun, approvalItems],
  );
  // 上一次的工具子集：文本增量不改工具对象，复用它就不会惊动下游 memo。
  const prevTools = useRef<ToolItem[]>([]);

  // 文本增量只换最后一项，其余对象共享，但 items 数组身份每次都变。
  // 工具子集逐项比对后复用；结构只依赖工具子集，于是增量不改变任何 ToolGroup 的入参。
  const tools = useMemo(() => stableTools(items, prevTools.current), [items]);
  prevTools.current = tools;
  const structure = useMemo(() => buildStructure(tools), [tools]);

  // 审批匹配表只在工具或审批变化时重算（依赖不变时 useMemo 返回同一个 Map）。
  const matches = useMemo(() => {
    const map = new Map<string, ApprovalRequest | undefined>();
    for (const tool of tools) map.set(tool.toolUseId, findApproval(tool, approvalItems));
    return map;
  }, [tools, approvalItems]);

  // 已放置的审批：兜底卡不能重复出现。
  const placed = useMemo(() => {
    const ids = new Set<string>();
    for (const approval of matches.values()) if (approval) ids.add(approval.id);
    return ids;
  }, [matches]);

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end" scrollEdgeThreshold={80}>
      <MessageScroller className="h-auto flex-1">
        <MessageScrollerViewport aria-label="对话消息">
          <MessageScrollerContent
            className={cn('mx-auto w-full max-w-[760px] gap-4', !welcome && 'p-4')}
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
            {!loading && !error && items.length > 0
              ? turns.map((turn, turnIndex) => (
                  <MessageScrollerItem key={turn.id} messageId={turn.id}>
                    <Message align={turn.user ? 'end' : 'start'} className="text-md text-fg">
                      <MessageContent
                        className={cn(
                          'gap-4',
                          turn.user && 'w-fit max-w-[85%] rounded-pill bg-hover px-4 py-2',
                        )}
                      >
                        <MessageGroup className="gap-4">
                          {turn.items.map((item, index) => {
                            // 有归属的子调用由父行渲染，不在顶层重复出现。
                            if (item.kind === 'tool') {
                              if (structure.root.has(item.toolUseId)) return null;
                              return (
                                <ToolGroup
                                  key={item.toolUseId}
                                  tool={item}
                                  kids={structure.kids.get(item.toolUseId) ?? NO_KIDS}
                                  approvalItems={approvalItems}
                                  pending={approvals.pending}
                                  onApprove={approvals.onApprove}
                                />
                              );
                            }
                            return (
                              // biome-ignore lint/suspicious/noArrayIndexKey: 只追加的流式日志，索引即顺序
                              <MessagePart key={`${index}-${item.kind}`} item={item} />
                            );
                          })}
                        </MessageGroup>
                        {!turn.user && turnIndex === turns.length - 1 ? (
                          <>
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
                          </>
                        ) : null}
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                ))
              : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        {items.length > 0 ? (
          <MessageScrollerButton
            variant="outline"
            size="xs"
            behavior={reduce ? 'instant' : 'smooth'}
            className="border-line bg-surface text-fg hover:bg-hover hover:text-fg motion-reduce:transition-none"
          >
            <ArrowDown className="size-3" /> 回到底部
          </MessageScrollerButton>
        ) : null}
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

function messageTurns(items: ChatItem[], hasFooter: boolean) {
  const turns: { id: string; user: boolean; items: ChatItem[] }[] = [];
  for (const [index, item] of items.entries()) {
    const previous = turns.at(-1);
    if (item.kind !== 'user' && previous && !previous.user) {
      previous.items.push(item);
    } else {
      turns.push({ id: `turn-${index}`, user: item.kind === 'user', items: [item] });
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
  approvalItems,
  pending,
  onApprove,
}: {
  tool: ToolItem;
  kids: ToolItem[];
  approvalItems: ApprovalRequest[];
  pending: string | null;
  onApprove: (item: ApprovalRequest) => void;
}) {
  const approval = findApproval(tool, approvalItems);
  return (
    <>
      <div className="space-y-1.5">
        <ToolRow item={tool} nested={tool.parentToolUseId !== undefined} childCount={kids.length} />
        {approval ? <ApprovalCard item={approval} pending={pending} onApprove={onApprove} /> : null}
      </div>
      {kids.map((child) => {
        const childApproval = findApproval(child, approvalItems);
        return (
          <div key={`${child.toolUseId}-child`} className="space-y-1.5">
            <ToolRow item={child} nested={true} childCount={0} />
            {childApproval ? (
              <ApprovalCard item={childApproval} pending={pending} onApprove={onApprove} />
            ) : null}
          </div>
        );
      })}
    </>
  );
});

/** 审批卡放在被拒工具的原位置；匹配不上的兜底放在末尾，不能吞掉。 */
function findApproval(
  item: ToolItem,
  approvalItems: ApprovalRequest[],
): ApprovalRequest | undefined {
  return approvalItems.find(
    (approval) =>
      (approval.serverName
        ? item.name === `mcp__${approval.serverName}__${approval.toolName}`
        : false) || item.name.endsWith(`__${approval.toolName}`),
  );
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

/** 空态共用 728px 轴线：两行问候语、输入胶囊、建议卡。 */
function WelcomeState({
  agent,
  onPick,
  children,
}: {
  agent: AgentView | null;
  onPick: (text: string) => void;
  children: ReactNode;
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
    <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col justify-center gap-8 px-4 pb-32 pt-3">
      <div className="flex flex-col items-center gap-1 text-center tracking-[-0.24px]">
        <h2 className="text-lg font-normal leading-[30px] text-fg">你好</h2>
        <p className="text-lg font-medium leading-[26.4px] text-muted-foreground">今天想做什么？</p>
      </div>

      {children}

      {suggestions.length > 0 ? (
        <div className="flex flex-wrap justify-center gap-3">
          {suggestions.map((text) => (
            <button
              key={text}
              type="button"
              onClick={() => onPick(text)}
              className="h-[72px] w-[136px] overflow-hidden rounded-card bg-chip p-4 text-left text-base leading-5 text-muted-foreground transition-[background-color] duration-150 hover:bg-hover focus-visible:ring-2 focus-visible:ring-fg"
            >
              <span className="line-clamp-2">{text}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 只为展示取字段，避免把 Agent 类型一路传进展示组件。 */
type AgentView = NonNullable<ReturnType<typeof useAgents>['data']>[number];

/** 文本增量只更新对应片段，工具行继续使用独立的 memo。 */
const MessagePart = memo(function MessagePart({
  item,
}: {
  item: Exclude<ChatItem, { kind: 'tool' }>;
}) {
  switch (item.kind) {
    case 'user':
      return <p className="whitespace-pre-wrap break-words leading-relaxed">{item.text}</p>;
    case 'text':
      return renderAssistantText(item.text);
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
});

/** 助手文本不用气泡；围栏代码交给 CodeBlock，其余保留换行与空白。 */
function renderAssistantText(text: string) {
  if (!text.includes('```')) {
    return (
      <CollapsibleText
        text={text}
        className="whitespace-pre-wrap break-words text-md leading-[1.7] text-fg"
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
          className="whitespace-pre-wrap break-words text-md leading-[1.7] text-fg"
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
      <div key={index++} className="whitespace-pre-wrap break-words text-md leading-[1.7] text-fg">
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
          className="text-fg underline decoration-line-strong underline-offset-2 hover:text-fg"
        >
          查看详情
        </Link>
      </div>
      {run.error ? <p className="break-words text-2xs text-danger">{run.error}</p> : null}
    </div>
  );
}

/** 审批只记录，不重试；文案必须和真实行为一致。 */
const ApprovalCard = memo(function ApprovalCard({
  item,
  pending,
  onApprove,
}: {
  item: ApprovalRequest;
  pending: string | null;
  onApprove: (item: ApprovalRequest) => void;
}) {
  const busy = pending === item.id;
  const reduce = useReducedMotion();
  return (
    <motion.div
      role="alert"
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={reduce ? STILL : EXPAND}
      className="flex flex-wrap items-center gap-2 rounded-card border border-line bg-chip px-3 py-2"
    >
      <CircleAlert className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-xs leading-relaxed text-fg">
        工具 <code className="font-mono text-xs">{item.toolName}</code>
        {item.serverName ? (
          <span className="text-muted-foreground"> @ {item.serverName}</span>
        ) : null}{' '}
        需要批准。批准只记录到该 server；继续请在输入框重新发送消息（新一次运行）。
      </div>
      <Button size="sm" disabled={busy} aria-busy={busy} onClick={() => onApprove(item)}>
        {busy ? '批准中…' : '批准并继续（新一次运行）'}
      </Button>
    </motion.div>
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
  const running = item.result === undefined;
  const failed = toolFailed(item.result);
  const [open, setOpen] = useState(running);
  const reduce = useReducedMotion();

  // 跑着的自动展开，结束后收起；用户仍可手动再展开。
  useEffect(() => {
    setOpen(running);
  }, [running]);

  const duration =
    item.startedAt !== undefined && item.endedAt !== undefined
      ? item.endedAt - item.startedAt
      : undefined;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn('overflow-hidden rounded-item bg-surface', nested && 'ml-4')}
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors duration-150 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-fg">
        <Wrench className="size-4 shrink-0 text-subtle" aria-hidden="true" />
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{item.name}</code>
        <span className="sr-only">{running ? '运行中' : failed ? '失败' : '完成'}</span>
        {running ? (
          <LoaderCircle className="size-3 shrink-0 animate-spin text-fg" aria-hidden="true" />
        ) : failed ? (
          <CircleAlert className="size-3 shrink-0 text-danger" aria-hidden="true" />
        ) : (
          <Check className="size-3 shrink-0 text-success" aria-hidden="true" />
        )}
        <span className="shrink-0 text-xs text-muted-foreground" aria-hidden="true">
          {running ? '运行中' : failed ? '失败' : '完成'}
        </span>
        {duration !== undefined ? (
          <span className="shrink-0 font-mono text-2xs tabular-nums text-subtle">
            {formatDuration(duration)}
          </span>
        ) : null}
        <ChevronDown
          className={cn('size-3 shrink-0 text-subtle transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      {/* keepMounted：保留面板，inert 隔离收起内容，Motion 完成高度退出动画。 */}
      <CollapsibleContent keepMounted>
        <AnimatePresence initial={false}>
          {open ? (
            <motion.div
              key="body"
              initial={{ height: 0 }}
              animate={{ height: 'auto' }}
              exit={{ height: 0 }}
              transition={reduce ? STILL : EXPAND}
              className="overflow-hidden"
            >
              {childCount > 0 ? (
                <p className="px-3 pt-2 text-xs text-muted-foreground">
                  子智能体 · {childCount} 次调用
                </p>
              ) : null}
              <div className="grid gap-2 border-t border-line p-2 md:grid-cols-2">
                <div className="min-w-0">
                  <div className="mb-1 px-1 text-2xs uppercase tracking-[0.06em] text-subtle">
                    参数
                  </div>
                  {item.input !== undefined ? (
                    <JsonBlock value={item.input} maxHeight="16rem" />
                  ) : (
                    <p className="px-1 text-2xs text-subtle">等待参数…</p>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="mb-1 px-1 text-2xs uppercase tracking-[0.06em] text-subtle">
                    结果
                  </div>
                  {item.result !== undefined ? (
                    <JsonBlock value={item.result} maxHeight="20rem" />
                  ) : (
                    <p className="px-1 text-2xs text-subtle">等待结果…</p>
                  )}
                </div>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </CollapsibleContent>
    </Collapsible>
  );
});
