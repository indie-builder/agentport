import type { ChannelDetail, ChannelMember, ChannelMessage, ChannelRole } from '@agentport/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, CircleStop, Hash, MessageSquare, Plus, ShieldAlert } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AgentAvatar } from '../components/agent-avatar.js';
import { Page, PageHeader } from '../components/page.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import { authenticated, can } from '../lib/access.js';
import { api, type ChannelApproval } from '../lib/api.js';
import {
  applyMention,
  mentionQueryAt,
  mergeChannelMessages,
  pruneMentions,
  visibleReadSeq,
} from '../lib/channel-state.js';
import type { ChatItem } from '../lib/chat-state.js';
import type { RunMetrics } from '../lib/chat-store.js';
import { cn } from '../lib/cn.js';
import { shortId } from '../lib/format.js';
import {
  channelMessagesQuery,
  meQuery,
  useAgents,
  useApproveChannelApproval,
  useBindChannelAgent,
  useChannel,
  useChannelApprovals,
  useChannels,
  useMarkChannelRead,
  useStopChannelRun,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { useChannelStream } from '../lib/use-channel-stream.js';
import { Composer, MessagePane } from './chat.js';

const ROLE_LABEL: Record<ChannelRole, string> = {
  owner: '所有者',
  admin: '管理员',
  member: '成员',
  viewer: '只读',
};

const NO_METRICS: ReadonlyMap<string, RunMetrics> = new Map();

interface MentionTarget {
  agentId: string;
  name: string;
}

interface TimelineEntry {
  headerAgentId?: string;
  control?: { runId: string; active: boolean };
}

export function ChannelPage({ channelId }: { channelId: string }) {
  const detail = useChannel(channelId);
  if (detail.isPending) {
    return (
      <Page className="h-full min-h-0 px-6 py-4">
        <PageHeader title="频道" />
        <LoadingState rows={4} />
      </Page>
    );
  }
  if (detail.isError) {
    return (
      <Page className="h-full min-h-0 px-6 py-4">
        <PageHeader title="频道" />
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      </Page>
    );
  }
  return <ChannelWorkspace key={detail.data.id} channel={detail.data} />;
}

function ChannelWorkspace({ channel }: { channel: ChannelDetail }) {
  const me = useQuery(meQuery);
  const agents = useAgents();
  const stream = useChannelStream(channel.id);
  const approvals = useChannelApprovals(channel.id);
  const bind = useBindChannelAgent(channel.id);
  const stop = useStopChannelRun(channel.id);
  const approve = useApproveChannelApproval(channel.id);
  const { mutate: markRead } = useMarkChannelRead(channel.id);
  const client = useQueryClient();
  const user = authenticated(me.data);
  const businessId = user?.user.businessId ?? null;
  // 频道角色只在本频道的成员行里；平台管理员非成员时为 null。
  const selfMember = channel.members.find((item) => item.businessId === businessId);
  const channelRole = selfMember?.role ?? null;
  const canManage = channelRole === 'owner' || channelRole === 'admin';
  const canPost =
    channel.archivedAt === null &&
    // 发言权以频道角色为准；me 未加载时按不可发处理，避免只读成员闪出输入框。
    (channelRole !== null
      ? channelRole !== 'viewer'
      : me.isSuccess && can(me.data, 'conversations.create'));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastReadRef = useRef(0);
  const [input, setInput] = useState('');
  const [caret, setCaret] = useState(0);
  const [mentions, setMentions] = useState<MentionTarget[]>([]);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [agentToBind, setAgentToBind] = useState<string | null>(null);

  const agentById = useMemo(
    () => new Map((agents.data ?? []).map((agent) => [agent.id, agent])),
    [agents.data],
  );
  const boundAgents = useMemo(
    () =>
      channel.agentBindings.flatMap((binding) => {
        const agent = agentById.get(binding.agentId);
        return binding.status === 'active' && agent?.enabled !== false
          ? [{ agentId: binding.agentId, name: agent?.name ?? shortId(binding.agentId) }]
          : [];
      }),
    [agentById, channel.agentBindings],
  );

  const runAgent = useMemo(() => {
    const map = new Map<string, string>();
    for (const run of stream.activeRuns) map.set(run.runId, run.agentId);
    for (const item of Object.values(stream.streams)) {
      if (!map.has(item.runId)) map.set(item.runId, item.agentId);
    }
    return map;
  }, [stream.activeRuns, stream.streams]);
  const activeAgentIds = useMemo(
    () => new Set(stream.activeRuns.map((run) => run.agentId)),
    [stream.activeRuns],
  );
  const pendingApprovals = approvals.data ?? [];
  const waitingAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of pendingApprovals) {
      const agentId = runAgent.get(item.runId);
      if (agentId !== undefined) ids.add(agentId);
    }
    return ids;
  }, [pendingApprovals, runAgent]);

  const timeline = useMemo(() => {
    const items: ChatItem[] = [];
    const meta = new Map<ChatItem, TimelineEntry>();
    const persistedRuns = new Set<string>();
    for (const message of stream.messages) {
      if (message.kind === 'human') {
        items.push({ kind: 'user', id: message.id, text: message.body });
        continue;
      }
      if (message.kind === 'agent') {
        if (message.runId !== null) persistedRuns.add(message.runId);
        const item: ChatItem = {
          kind: 'text',
          id: message.id,
          text: message.body,
          ...(message.runId === null ? {} : { runId: message.runId }),
        };
        items.push(item);
        if (message.agentId !== null) meta.set(item, { headerAgentId: message.agentId });
        continue;
      }
      items.push({ kind: 'notice', id: message.id, text: message.body, tone: 'muted' });
    }
    // 落库回复优先：同一 run 的流式正文不再重复显示。
    for (const item of Object.values(stream.streams)) {
      if (persistedRuns.has(item.runId)) continue;
      const anchor: ChatItem =
        item.items.length === 0
          ? {
              kind: 'notice',
              id: `${item.runId}:anchor`,
              tone: 'muted',
              text: item.status === 'running' ? '等待回复…' : '运行已结束',
            }
          : { kind: 'text', id: `${item.runId}:anchor`, text: '', runId: item.runId };
      items.push(anchor);
      meta.set(anchor, {
        headerAgentId: item.agentId,
        control: { runId: item.runId, active: item.status === 'running' },
      });
      item.items.forEach((part, index) => {
        items.push({ ...part, id: `${item.runId}:${index}` } as ChatItem);
      });
    }
    return { items, meta };
  }, [stream.messages, stream.streams]);

  const hasRunning =
    stream.activeRuns.length > 0 ||
    Object.values(stream.streams).some((item) => item.status === 'running');
  useEffect(() => {
    lastReadRef.current = Math.max(lastReadRef.current, selfMember?.lastReadSeq ?? 0);
  }, [selfMember?.lastReadSeq]);

  const markVisibleRead = useCallback(
    (visibleIds: string[]) => {
      // 只认已落库消息；乐观项与流式临时项没有真实 seq。
      const seqById = new Map(
        stream.messages
          .filter((message) => !message.id.startsWith('local-'))
          .map((message) => [message.id, message.seq]),
      );
      const seq = visibleReadSeq(timeline.items, visibleIds, seqById);
      const known = Math.max(lastReadRef.current, selfMember?.lastReadSeq ?? 0);
      if (seq <= known) return;
      lastReadRef.current = seq;
      markRead(seq, {
        onError: () => {
          lastReadRef.current = known;
        },
      });
    },
    [markRead, selfMember?.lastReadSeq, stream.messages, timeline.items],
  );

  const setMessages = (update: (previous: readonly ChannelMessage[]) => ChannelMessage[]): void => {
    client.setQueryData<ChannelMessage[]>(channelMessagesQuery(channel.id).queryKey, (previous) =>
      update(previous ?? []),
    );
  };

  const send = async (): Promise<void> => {
    const body = input.trim();
    if (!body || !canPost) return;
    const mentionIds = pruneMentions(input, mentions);
    const clientMessageId = crypto.randomUUID();
    const optimistic: ChannelMessage = {
      id: `local-${clientMessageId}`,
      channelId: channel.id,
      seq: Number.MAX_SAFE_INTEGER,
      kind: 'human',
      authorBusinessId: businessId,
      agentId: null,
      runId: null,
      body,
      clientMessageId,
      sourceMessageId: null,
      createdAt: new Date().toISOString(),
    };
    setMessages((previous) => mergeChannelMessages(previous, [optimistic]));
    setInput('');
    setMentions([]);
    setMention(null);
    try {
      const saved = await api.postChannelMessage(channel.id, {
        body,
        clientMessageId,
        ...(mentionIds.length === 0 ? {} : { mentions: mentionIds }),
      });
      setMessages((previous) => mergeChannelMessages(previous, [saved]));
      void client.invalidateQueries({ queryKey: ['channels'] });
    } catch (error) {
      setMessages((previous) => previous.filter((item) => item.id !== optimistic.id));
      setInput((current) => current || body);
      toastError(error);
    }
  };

  const mentionOptions = useMemo(() => {
    if (mention === null) return [];
    const query = mention.query.toLowerCase();
    return boundAgents.filter((agent) => agent.name.toLowerCase().includes(query));
  }, [boundAgents, mention]);

  const changeInput = (next: string, position: number | null): void => {
    const at = position ?? next.length;
    setInput(next);
    setCaret(at);
    setMention(mentionQueryAt(next, at));
    setMentionIndex(0);
    const kept = pruneMentions(next, mentions);
    if (kept.length !== mentions.length) {
      setMentions((previous) => previous.filter((item) => kept.includes(item.agentId)));
    }
  };

  const pickMention = (target: MentionTarget): void => {
    const result = applyMention(input, caret, target.name);
    setInput(result.text);
    setCaret(result.caret);
    setMentions((previous) =>
      previous.some((item) => item.agentId === target.agentId)
        ? previous
        : [...previous, { agentId: target.agentId, name: target.name }],
    );
    setMention(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(result.caret, result.caret);
    });
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (mention === null || mentionOptions.length === 0) return false;
    if (event.key === 'ArrowDown') {
      setMentionIndex((index) => (index + 1) % mentionOptions.length);
      return true;
    }
    if (event.key === 'ArrowUp') {
      setMentionIndex((index) => (index - 1 + mentionOptions.length) % mentionOptions.length);
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      const target = mentionOptions[mentionIndex] ?? mentionOptions[0];
      if (target) pickMention(target);
      return true;
    }
    if (event.key === 'Escape') {
      setMention(null);
      return true;
    }
    return false;
  };

  const renderItemHeader = useCallback(
    (item: ChatItem) => {
      const agentId = timeline.meta.get(item)?.headerAgentId;
      if (agentId === undefined) return null;
      return <ChannelAgentHeader agent={agentById.get(agentId)} agentId={agentId} />;
    },
    [agentById, timeline],
  );

  const renderItemFooter = useCallback(
    (item: ChatItem) => {
      const control = timeline.meta.get(item)?.control;
      if (control === undefined) return null;
      return (
        <RunControls
          runId={control.runId}
          active={control.active}
          approvals={pendingApprovals}
          stop={stop}
          approve={approve}
        />
      );
    },
    [approve, pendingApprovals, stop, timeline],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-6 py-2">
        <Link
          to="/channels"
          aria-label="返回频道列表"
          title="返回频道列表"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-icon)] text-muted-foreground hover:bg-hover hover:text-fg lg:hidden"
        >
          <ArrowLeft aria-hidden="true" />
        </Link>
        <h1
          title={channel.name}
          className="min-w-0 max-w-[14em] truncate text-lg font-medium tracking-[-0.01em] text-fg"
        >
          {channel.name}
        </h1>
        {channelRole ? <Badge variant="outline">{ROLE_LABEL[channelRole]}</Badge> : null}
        {channel.archivedAt ? <Badge>已关闭</Badge> : null}
        <MemberAvatars members={channel.members} businessId={businessId} name={user?.user.name} />
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {channel.agentBindings.map((binding) => {
            const agent = agentById.get(binding.agentId);
            const status = bindingStatus(
              binding.status,
              activeAgentIds.has(binding.agentId),
              waitingAgentIds.has(binding.agentId),
            );
            return (
              <span
                key={binding.agentId}
                className="flex min-w-0 items-center gap-1.5 rounded-pill bg-sunken px-2 py-1 text-xs text-muted-foreground"
              >
                <AgentAvatar
                  agent={agent ?? { name: shortId(binding.agentId), description: '' }}
                  className="size-4"
                />
                <span className="max-w-28 truncate text-fg">
                  {agent?.name ?? shortId(binding.agentId)}
                </span>
                <span className="flex items-center gap-1">
                  <span className={cn('size-1.5 rounded-full', status.dot)} aria-hidden="true" />
                  {status.label}
                </span>
              </span>
            );
          })}
          {channel.agentBindings.length === 0 ? (
            <span className="text-xs text-muted-foreground">尚未绑定智能体</span>
          ) : null}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <ChannelSidebar channelId={channel.id} />

        <section className="flex min-w-0 flex-1 flex-col">
          <MessagePane
            items={timeline.items}
            loading={stream.messagesQuery.isPending}
            error={stream.messagesQuery.isError ? stream.messagesQuery.error : null}
            onRetry={() => void stream.messagesQuery.refetch()}
            hasOlder={false}
            loadingOlder={false}
            onLoadOlder={() => undefined}
            olderDisabled={true}
            welcome={
              <EmptyState
                icon={<MessageSquare className="size-5" />}
                title="从第一条消息开始"
                description="在下方输入消息；输入 @ 可以点名频道里的智能体。"
              />
            }
            approvals={{ pending: null, onApprove: () => undefined }}
            approvalItems={[]}
            liveRunId={null}
            lastRun={null}
            historyMetrics={NO_METRICS}
            currentRunId={null}
            onSelectOutput={() => undefined}
            onBranchMessage={() => undefined}
            branchingMessageId={null}
            running={hasRunning}
            openUi={false}
            streaming={hasRunning}
            onAction={() => undefined}
            renderItemHeader={renderItemHeader}
            renderItemFooter={renderItemFooter}
            onVisibleMessageIdsChange={markVisibleRead}
            scrollPreviousItemPeek={0}
          />
          {mention !== null && mentionOptions.length > 0 ? (
            <MentionMenu
              options={mentionOptions}
              selected={mentionIndex}
              activeAgentIds={activeAgentIds}
              onPick={pickMention}
            />
          ) : null}
          {channel.archivedAt ? (
            <p className="mx-auto w-full max-w-[880px] px-6 pb-2 text-xs text-muted-foreground">
              频道已关闭，历史消息仍可查看。
            </p>
          ) : null}
          <Composer
            agent={null}
            send={send}
            textareaRef={textareaRef}
            lastRunId={null}
            welcome={false}
            historyReady={!stream.messagesQuery.isPending}
            enabled={canPost}
            locked={false}
            canAttach={false}
            canSend={canPost}
            sendDenied={
              channel.archivedAt !== null
                ? '频道已关闭，不能再发送消息。'
                : channelRole === 'viewer'
                  ? '你在该频道是只读成员，不能发送消息。'
                  : '当前账户没有发送消息的权限。'
            }
            value={input}
            onValueChange={changeInput}
            onKeyDown={handleKeyDown}
            placeholder={canPost ? '输入消息，@ 智能体…' : '频道只读'}
          />
        </section>

        <ChannelSidebarDetail
          channel={channel}
          agents={agents.data ?? []}
          businessId={businessId}
          name={user?.user.name}
          activeAgentIds={activeAgentIds}
          waitingAgentIds={waitingAgentIds}
          canManage={canManage}
          bind={bind}
          agentToBind={agentToBind}
          onAgentToBind={setAgentToBind}
        />
      </div>
    </div>
  );
}

function ChannelAgentHeader({
  agent,
  agentId,
}: {
  agent:
    | { name: string; description: string; role?: string | null; slug?: string | null }
    | undefined;
  agentId: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <AgentAvatar
        agent={agent ?? { name: shortId(agentId), description: '' }}
        className="size-5"
      />
      <span className="min-w-0 truncate font-medium text-fg">
        {agent?.name ?? shortId(agentId)}
      </span>
    </div>
  );
}

function MemberAvatars({
  members,
  businessId,
  name,
}: {
  members: readonly ChannelMember[];
  businessId: string | null;
  name: string | undefined;
}) {
  const visible = members.slice(0, 5);
  const hidden = members.length - visible.length;
  return (
    <div className="flex items-center">
      <span className="sr-only">{members.length} 位成员</span>
      <div className="flex -space-x-1">
        {visible.map((item) => (
          <span
            key={item.businessId}
            title={`${memberLabel(item.businessId, businessId, name)} · ${ROLE_LABEL[item.role]}`}
            className="flex size-6 items-center justify-center rounded-full border border-line bg-sunken text-2xs font-medium text-muted-foreground"
          >
            {memberInitial(item.businessId, businessId, name)}
          </span>
        ))}
      </div>
      {hidden > 0 ? <span className="ml-1 text-xs text-muted-foreground">+{hidden}</span> : null}
    </div>
  );
}

function ChannelSidebar({ channelId }: { channelId: string }) {
  const channels = useChannels();
  const list = channels.data ?? [];
  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r border-line lg:flex">
      <div className="flex h-14 shrink-0 items-center justify-between px-3">
        <span className="text-sm font-medium text-fg">频道</span>
        <Link
          to="/channels"
          className="text-xs text-muted-foreground underline-offset-2 hover:text-fg hover:underline"
        >
          全部
        </Link>
      </div>
      <nav aria-label="频道列表" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <ul className="flex flex-col gap-0.5">
          {list.map((channel) => (
            <li key={channel.id}>
              <Link
                to="/channels/$channelId"
                params={{ channelId: channel.id }}
                aria-current={channel.id === channelId ? 'page' : undefined}
                className={cn(
                  'flex h-8 min-w-0 items-center gap-2 rounded-item px-2.5 text-sm',
                  channel.id === channelId
                    ? 'bg-selected text-selected-foreground'
                    : 'text-muted-foreground hover:bg-hover hover:text-fg',
                )}
              >
                <Hash aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">{channel.name}</span>
                {channel.unreadCount > 0 && channel.id !== channelId ? (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {channel.unreadCount}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}

function ChannelSidebarDetail({
  channel,
  agents,
  businessId,
  name,
  activeAgentIds,
  waitingAgentIds,
  canManage,
  bind,
  agentToBind,
  onAgentToBind,
}: {
  channel: ChannelDetail;
  agents: { id: string; name: string; description: string; enabled: boolean }[];
  businessId: string | null;
  name: string | undefined;
  activeAgentIds: ReadonlySet<string>;
  waitingAgentIds: ReadonlySet<string>;
  canManage: boolean;
  bind: ReturnType<typeof useBindChannelAgent>;
  agentToBind: string | null;
  onAgentToBind: (value: string | null) => void;
}) {
  const bound = new Set(channel.agentBindings.map((binding) => binding.agentId));
  const bindable = agents.filter((agent) => !bound.has(agent.id));
  const agentName = new Map(agents.map((agent) => [agent.id, agent.name]));
  return (
    <aside className="hidden w-72 shrink-0 flex-col gap-5 overflow-y-auto border-l border-line px-4 py-4 xl:flex">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-fg">
          成员 <span className="font-normal text-muted-foreground">{channel.members.length}</span>
        </h2>
        <ul className="flex flex-col gap-1.5">
          {channel.members.map((item) => (
            <li key={item.businessId} className="flex min-w-0 items-center gap-2 text-sm">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sunken text-2xs font-medium text-muted-foreground">
                {memberInitial(item.businessId, businessId, name)}
              </span>
              <span className="min-w-0 truncate text-fg">
                {memberLabel(item.businessId, businessId, name)}
              </span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {ROLE_LABEL[item.role]}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2 border-t border-line pt-4">
        <h2 className="text-sm font-medium text-fg">
          智能体{' '}
          <span className="font-normal text-muted-foreground">{channel.agentBindings.length}</span>
        </h2>
        <ul className="flex flex-col gap-1.5">
          {channel.agentBindings.map((binding) => {
            const status = bindingStatus(
              binding.status,
              activeAgentIds.has(binding.agentId),
              waitingAgentIds.has(binding.agentId),
            );
            return (
              <li key={binding.agentId} className="flex min-w-0 items-center gap-2 text-sm">
                <span className="min-w-0 truncate text-fg">
                  {agentName.get(binding.agentId) ?? shortId(binding.agentId)}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  <span className={cn('size-1.5 rounded-full', status.dot)} aria-hidden="true" />
                  {status.label}
                </span>
              </li>
            );
          })}
        </ul>
        {canManage && bindable.length > 0 ? (
          <div className="flex flex-col gap-2">
            <Select
              value={agentToBind}
              onValueChange={(value) => {
                if (value !== null) onAgentToBind(value);
              }}
              items={bindable.map((agent) => ({ value: agent.id, label: agent.name }))}
            >
              <SelectTrigger aria-label="选择要绑定的智能体" className="w-full">
                <SelectValue placeholder="选择智能体" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {bindable.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={agentToBind === null || bind.isPending}
              aria-busy={bind.isPending}
              onClick={() => {
                if (agentToBind === null) return;
                bind.mutate(
                  { agentId: agentToBind },
                  {
                    onSuccess: () => {
                      onAgentToBind(null);
                      toastSuccess('智能体已加入频道');
                    },
                    onError: (error) => toastError(error),
                  },
                );
              }}
            >
              <Plus aria-hidden="true" />
              绑定智能体
            </Button>
          </div>
        ) : null}
      </section>
    </aside>
  );
}

function RunControls({
  runId,
  active,
  approvals,
  stop,
  approve,
}: {
  runId: string;
  active: boolean;
  approvals: readonly ChannelApproval[];
  stop: ReturnType<typeof useStopChannelRun>;
  approve: ReturnType<typeof useApproveChannelApproval>;
}) {
  const pendingApprovals = approvals.filter((approval) => approval.runId === runId);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {active ? (
        <Button
          variant="outline"
          size="sm"
          disabled={stop.isPending && stop.variables === runId}
          aria-busy={stop.isPending && stop.variables === runId}
          onClick={() => stop.mutate(runId, { onError: (error) => toastError(error) })}
        >
          <CircleStop aria-hidden="true" />
          停止
        </Button>
      ) : null}
      {pendingApprovals.map((approval) => (
        <div
          key={approval.id}
          className="flex min-w-0 flex-wrap items-center gap-2 rounded-item border border-line bg-surface px-3 py-2 text-xs"
        >
          <ShieldAlert className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
          <span className="min-w-0 break-words text-fg">
            需要批准：{approval.serverName ?? approval.serverId} · {approval.toolName}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={approve.isPending && approve.variables === approval.id}
            aria-busy={approve.isPending && approve.variables === approval.id}
            onClick={() =>
              approve.mutate(approval.id, {
                onSuccess: () => toastSuccess('已批准'),
                onError: (error) => toastError(error),
              })
            }
          >
            批准
          </Button>
        </div>
      ))}
    </div>
  );
}

function MentionMenu({
  options,
  selected,
  activeAgentIds,
  onPick,
}: {
  options: readonly MentionTarget[];
  selected: number;
  activeAgentIds: ReadonlySet<string>;
  onPick: (target: MentionTarget) => void;
}) {
  return (
    <div className="mx-auto w-full max-w-[880px] shrink-0 px-6">
      <div
        role="listbox"
        aria-label="提及智能体"
        className="mb-2 max-h-56 overflow-y-auto rounded-item border border-line bg-surface py-1"
      >
        {options.map((option, index) => (
          <button
            key={option.agentId}
            type="button"
            role="option"
            aria-selected={index === selected}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(option)}
            className={cn(
              'flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-sm',
              index === selected ? 'bg-accent text-accent-foreground' : 'text-fg hover:bg-hover',
            )}
          >
            <span className="min-w-0 flex-1 truncate">{option.name}</span>
            {activeAgentIds.has(option.agentId) ? (
              <span className="shrink-0 text-xs text-muted-foreground">运行中</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function bindingStatus(
  status: 'active' | 'paused' | 'disconnected',
  active: boolean,
  waiting: boolean,
): { label: string; dot: string } {
  if (status === 'disconnected') return { label: '已断开', dot: 'bg-subtle' };
  if (status === 'paused') return { label: '已暂停', dot: 'bg-subtle' };
  if (waiting) return { label: '等待审批', dot: 'bg-warning' };
  if (active) return { label: '运行中', dot: 'bg-fg' };
  return { label: '空闲', dot: 'bg-subtle' };
}

function memberLabel(
  businessId: string,
  ownId: string | null,
  ownName: string | undefined,
): string {
  if (businessId === ownId && ownName) return ownName;
  return shortId(businessId);
}

function memberInitial(
  businessId: string,
  ownId: string | null,
  ownName: string | undefined,
): string {
  if (businessId === ownId && ownName) return ownName.slice(0, 1).toUpperCase();
  return shortId(businessId).slice(0, 2).toUpperCase();
}
