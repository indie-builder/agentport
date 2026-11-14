import {
  CHANNEL_MAX_WAKE_AGENTS,
  type ChannelDetail,
  type ChannelMember,
  type ChannelMessage,
  type ChannelRole,
} from '@agentport/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ArrowLeft,
  CircleStop,
  Hash,
  Megaphone,
  MessageSquare,
  ShieldAlert,
  SquareArrowOutUpRight,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentAvatar, type AgentDisplay } from '../../components/agent/agent-avatar.js';
import { ChannelRunSheet } from '../../components/channel/channel-run-sheet.js';
import { ChannelSettingsButton } from '../../components/channel/channel-settings.js';
import { Composer, MessagePane } from '../../components/chat/chat-thread.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { Page, PageBody, PageHeader, PageNote, PageTopbar } from '../../components/page.js';
import { RunQuestionCard } from '../../components/run/run-question.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/states.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { MentionList, useMentionList } from '../../components/ui/mention-list.js';
import { authenticated, can } from '../../lib/access.js';
import { api, type ChannelApproval } from '../../lib/api.js';
import {
  applyMention,
  mentionQueryAt,
  mergeChannelMessages,
  pruneMentions,
  visibleReadSeq,
} from '../../lib/channel-state.js';
import type { ChatItem } from '../../lib/chat-state.js';
import type { RunMetrics } from '../../lib/chat-store.js';
import { cn } from '../../lib/cn.js';
import { shortId } from '../../lib/format.js';
import {
  CHANNEL_MESSAGES_PAGE_SIZE,
  channelMessagesQuery,
  meQuery,
  useAgents,
  useApproveChannelApproval,
  useChannel,
  useChannelApprovals,
  useChannelRunQuestions,
  useChannels,
  useMarkChannelRead,
  useRespondToChannelQuestion,
  useStopChannelRun,
} from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useChannelStream } from '../../lib/use-channel-stream.js';

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
  detailRunId?: string;
}

export function ChannelPage({ channelId }: { channelId: string }) {
  const detail = useChannel(channelId);
  if (detail.isPending) {
    return (
      <Page className="h-full min-h-0 px-6 pb-6">
        <PageTopbar>
          <PageHeader title="频道" />
        </PageTopbar>
        <PageBody>
          <LoadingState rows={4} />
        </PageBody>
      </Page>
    );
  }
  if (detail.isError && detail.data === undefined) {
    return (
      <Page className="h-full min-h-0 px-6 pb-6">
        <PageTopbar>
          <PageHeader title="频道" />
        </PageTopbar>
        <PageBody>
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
        </PageBody>
      </Page>
    );
  }
  return (
    <ChannelWorkspace
      key={detail.data.id}
      channel={detail.data}
      refreshFailed={detail.isError}
      onRetryRefresh={() => void detail.refetch()}
    />
  );
}

function ChannelWorkspace({
  channel,
  refreshFailed,
  onRetryRefresh,
}: {
  channel: ChannelDetail;
  refreshFailed: boolean;
  onRetryRefresh: () => void;
}) {
  const me = useQuery(meQuery);
  const agents = useAgents();
  const stream = useChannelStream(channel.id);
  const approvals = useChannelApprovals(channel.id);
  const stop = useStopChannelRun(channel.id);
  const approve = useApproveChannelApproval(channel.id);
  const { mutate: markRead } = useMarkChannelRead(channel.id);
  const client = useQueryClient();
  const user = authenticated(me.data);
  const businessId = user?.user.businessId ?? null;
  // 频道角色只在本频道的成员行里；平台管理员非成员时为 null。
  const selfMember = channel.members.find((item) => item.businessId === businessId);
  const channelRole = selfMember?.role ?? null;
  const canPost =
    channel.archivedAt === null &&
    // 发言权以频道角色为准；me 未加载时按不可发处理，避免只读成员闪出输入框。
    (channelRole !== null
      ? channelRole !== 'viewer'
      : me.isSuccess && can(me.data, 'conversations.create'));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastReadRef = useRef(0);
  const inputRef = useRef('');
  const pendingSend = useRef<{
    clientMessageId: string;
    body: string;
    mentionIds: string[];
    notifyAll: boolean;
  } | null>(null);
  const [input, setInput] = useState('');
  const [caret, setCaret] = useState(0);
  const [mentions, setMentions] = useState<MentionTarget[]>([]);
  const [notifyAll, setNotifyAll] = useState(false);
  const [confirmingNotifyAll, setConfirmingNotifyAll] = useState(false);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [olderExhausted, setOlderExhausted] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [runSheetId, setRunSheetId] = useState<string | null>(null);

  const agentById = useMemo(
    () => new Map((agents.data ?? []).map((agent) => [agent.id, agent])),
    [agents.data],
  );
  const memberById = useMemo(
    () => new Map(channel.members.map((member) => [member.businessId, member])),
    [channel.members],
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
  const autoWakeAgents = useMemo(
    () =>
      channel.agentBindings.flatMap((binding) => {
        const agent = agentById.get(binding.agentId);
        return binding.status === 'active' && agent?.enabled !== false && binding.autoWakeOnAll
          ? [{ agentId: binding.agentId, name: agent?.name ?? shortId(binding.agentId) }]
          : [];
      }),
    [agentById, channel.agentBindings],
  );
  const wakeLimitExceeded = autoWakeAgents.length > CHANNEL_MAX_WAKE_AGENTS;
  const notifyTargets = useMemo(() => {
    const names = new Map<string, string>();
    for (const agent of autoWakeAgents) names.set(agent.agentId, agent.name);
    for (const target of mentions) names.set(target.agentId, target.name);
    return [...names.values()];
  }, [autoWakeAgents, mentions]);
  const notifyLimitExceeded = notifyAll && notifyTargets.length > CHANNEL_MAX_WAKE_AGENTS;

  useEffect(() => {
    if (notifyAll && (autoWakeAgents.length === 0 || wakeLimitExceeded)) setNotifyAll(false);
  }, [autoWakeAgents.length, notifyAll, wakeLimitExceeded]);

  const runAgent = useMemo(() => {
    const map = new Map<string, string>();
    for (const run of stream.activeRuns) map.set(run.runId, run.agentId);
    for (const item of Object.values(stream.streams)) {
      if (!map.has(item.runId)) map.set(item.runId, item.agentId);
    }
    return map;
  }, [stream.activeRuns, stream.streams]);
  const runInitiator = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const run of stream.activeRuns) map.set(run.runId, run.initiatedBy);
    for (const item of Object.values(stream.streams)) {
      if (!map.has(item.runId)) map.set(item.runId, item.initiatedBy);
    }
    return map;
  }, [stream.activeRuns, stream.streams]);
  const canAnswerFor = useCallback(
    (runId: string): boolean =>
      channel.archivedAt === null &&
      (channelRole === 'owner' ||
        channelRole === 'admin' ||
        (channelRole === 'member' && runInitiator.get(runId) === businessId)),
    [businessId, channel.archivedAt, channelRole, runInitiator],
  );
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
        items.push({
          kind: 'user',
          id: message.id,
          text: message.body,
          ...(message.authorBusinessId === null
            ? {}
            : { authorBusinessId: message.authorBusinessId }),
          self: message.authorBusinessId === businessId,
        });
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
        const entry: TimelineEntry = {};
        if (message.agentId !== null) entry.headerAgentId = message.agentId;
        if (message.runId !== null) entry.detailRunId = message.runId;
        if (entry.headerAgentId !== undefined || entry.detailRunId !== undefined)
          meta.set(item, entry);
        continue;
      }
      const notice: ChatItem = {
        kind: 'notice',
        id: message.id,
        text: message.body,
        tone: 'muted',
      };
      items.push(notice);
      if (message.runId !== null) {
        const entry: TimelineEntry = { detailRunId: message.runId };
        if (message.agentId !== null) entry.headerAgentId = message.agentId;
        meta.set(notice, entry);
      }
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
        detailRunId: item.runId,
      });
      item.items.forEach((part, index) => {
        items.push({ ...part, id: `${item.runId}:${index}` } as ChatItem);
      });
    }
    return { items, meta };
  }, [businessId, stream.messages, stream.streams]);

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

  const persistedCount = stream.messages.filter(
    (message) => !message.id.startsWith('local-'),
  ).length;
  const hasOlder = !olderExhausted && persistedCount >= CHANNEL_MESSAGES_PAGE_SIZE;

  const loadOlder = useCallback(async (): Promise<void> => {
    if (loadingOlder) return;
    const first = stream.messages.find((message) => !message.id.startsWith('local-'));
    if (first === undefined) return;
    setLoadingOlder(true);
    try {
      const page = await api.channelMessages(channel.id, {
        before: first.seq,
        limit: CHANNEL_MESSAGES_PAGE_SIZE,
      });
      client.setQueryData<ChannelMessage[]>(channelMessagesQuery(channel.id).queryKey, (previous) =>
        mergeChannelMessages(previous ?? [], page),
      );
      if (page.length < CHANNEL_MESSAGES_PAGE_SIZE) setOlderExhausted(true);
    } catch (error) {
      toastError(error);
    } finally {
      setLoadingOlder(false);
    }
  }, [channel.id, client, loadingOlder, stream.messages]);

  const sendMessage = async (mentionAll: boolean): Promise<void> => {
    const body = input.trim();
    const mentionIds = pruneMentions(input, mentions);
    const pending = pendingSend.current;
    const clientMessageId =
      pending !== null &&
      pending.body === body &&
      pending.notifyAll === mentionAll &&
      pending.mentionIds.length === mentionIds.length &&
      pending.mentionIds.every((id, index) => id === mentionIds[index])
        ? pending.clientMessageId
        : crypto.randomUUID();
    const sentMentions = mentions;
    pendingSend.current = { clientMessageId, body, mentionIds, notifyAll: mentionAll };
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
    inputRef.current = '';
    setMentions([]);
    setMention(null);
    setNotifyAll(false);
    try {
      const saved = await api.postChannelMessage(channel.id, {
        body,
        clientMessageId,
        ...(mentionIds.length === 0 ? {} : { mentions: mentionIds }),
        ...(mentionAll ? { mentionAll: true } : {}),
      });
      if (pendingSend.current?.clientMessageId === clientMessageId) pendingSend.current = null;
      setMessages((previous) => mergeChannelMessages(previous, [saved]));
      void client.invalidateQueries({ queryKey: ['channels'] });
    } catch (error) {
      setMessages((previous) => previous.filter((item) => item.id !== optimistic.id));
      if (inputRef.current === '') {
        setInput(body);
        inputRef.current = body;
        setMentions(sentMentions);
        setNotifyAll(mentionAll);
      }
      toastError(error);
    }
  };

  const send = async (): Promise<void> => {
    if (!input.trim() || !canPost) return;
    if (notifyAll) {
      if (notifyLimitExceeded) {
        toastError(
          new Error(`一次最多唤醒 ${CHANNEL_MAX_WAKE_AGENTS} 个智能体，请减少 @ 或关闭通知全部。`),
        );
        return;
      }
      setConfirmingNotifyAll(true);
      return;
    }
    await sendMessage(false);
  };

  const mentionOptions = useMemo(() => {
    if (mention === null) return [];
    const query = mention.query.toLowerCase();
    return boundAgents.filter((agent) => agent.name.toLowerCase().includes(query));
  }, [boundAgents, mention]);

  const changeInput = (next: string, position: number | null): void => {
    const at = position ?? next.length;
    inputRef.current = next;
    setInput(next);
    setCaret(at);
    setMention(mentionQueryAt(next, at));
    const kept = pruneMentions(next, mentions);
    if (kept.length !== mentions.length) {
      setMentions((previous) => previous.filter((item) => kept.includes(item.agentId)));
    }
  };

  const pickMention = (target: MentionTarget): void => {
    const result = applyMention(input, caret, target.name);
    inputRef.current = result.text;
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

  const mentionMenu = useMentionList(
    {
      open: mention !== null && mentionOptions.length > 0,
      onSelect: (agentId) => {
        const target = mentionOptions.find((option) => option.agentId === agentId);
        if (target !== undefined) pickMention(target);
      },
      onClose: () => setMention(null),
    },
    textareaRef,
  );

  const renderItemHeader = useCallback(
    (item: ChatItem) => {
      if (item.kind === 'user') {
        if (item.self !== false) return null;
        const member =
          item.authorBusinessId === undefined ? undefined : memberById.get(item.authorBusinessId);
        return <ChannelMemberHeader member={member} authorBusinessId={item.authorBusinessId} />;
      }
      const agentId = timeline.meta.get(item)?.headerAgentId;
      if (agentId === undefined) return null;
      return <ChannelAgentHeader agent={agentById.get(agentId)} agentId={agentId} />;
    },
    [agentById, memberById, timeline],
  );

  const renderItemFooter = useCallback(
    (item: ChatItem) => {
      const entry = timeline.meta.get(item);
      if (entry === undefined) return null;
      const runId = entry.detailRunId ?? entry.control?.runId;
      if (runId === undefined) return null;
      const active = entry.control?.active ?? false;
      const canAnswer = canAnswerFor(runId);
      return (
        <RunControls
          channelId={channel.id}
          runId={runId}
          active={active}
          canStop={canAnswer}
          canApprove={canAnswer}
          canAnswer={canAnswer}
          approvals={entry.control === undefined ? [] : pendingApprovals}
          stop={stop}
          approve={approve}
          onOpenRun={setRunSheetId}
        />
      );
    },
    [approve, canAnswerFor, channel.id, pendingApprovals, stop, timeline],
  );

  return (
    <div className="flex h-full min-h-0">
      <ChannelSidebar channelId={channel.id} />

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-6 py-2">
          <Link
            to="/channels"
            aria-label="返回频道列表"
            title="返回频道列表"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-icon)] text-muted-foreground transition-colors duration-150 ease-out-soft hover:bg-hover hover:text-fg lg:hidden"
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
          <span className="text-xs text-muted-foreground xl:hidden">
            {channel.members.length} 成员 · {channel.agentBindings.length} 智能体
          </span>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 xl:hidden">
            <MemberAvatars members={channel.members} />
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
                      <span
                        className={cn('size-1.5 rounded-full', status.dot)}
                        aria-hidden="true"
                      />
                      {status.label}
                    </span>
                  </span>
                );
              })}
              {channel.agentBindings.length === 0 ? (
                <span className="text-xs text-muted-foreground">尚未绑定智能体</span>
              ) : null}
            </div>
            <span className="text-xs text-muted-foreground">频道内不会写入专家记忆。</span>
          </div>
          <div className="ml-auto flex shrink-0 items-center">
            <ChannelSettingsButton
              channel={channel}
              businessId={businessId}
              role={channelRole}
              agents={(agents.data ?? []).filter((agent) => !agent.isDefault)}
            />
          </div>
          {channel.description ? (
            <p
              title={channel.description}
              className="w-full min-w-0 truncate text-sm text-muted-foreground"
            >
              {channel.description}
            </p>
          ) : null}
        </header>

        {refreshFailed ? (
          <div className="shrink-0 px-6 pt-2">
            <PageNote
              tone="danger"
              title="刷新失败，已保留加载的内容"
              description="以下为上次成功加载的内容。"
              action={
                <Button variant="outline" size="sm" onClick={onRetryRefresh}>
                  重试
                </Button>
              }
            />
          </div>
        ) : null}

        <MessagePane
          items={timeline.items}
          loading={stream.messagesQuery.isPending}
          error={stream.messagesQuery.isError ? stream.messagesQuery.error : null}
          onRetry={() => void stream.messagesQuery.refetch()}
          onLoadOlder={loadOlder}
          hasOlder={hasOlder}
          loadingOlder={loadingOlder}
          olderDisabled={loadingOlder}
          welcome={
            <EmptyState icon={<MessageSquare className="size-5" />} title="从第一条消息开始" />
          }
          approvalItems={[]}
          liveRunId={null}
          lastRun={null}
          historyMetrics={NO_METRICS}
          currentRunId={null}
          branchingMessageId={null}
          running={hasRunning}
          openUi={false}
          streaming={hasRunning}
          renderItemHeader={renderItemHeader}
          renderItemFooter={renderItemFooter}
          onVisibleMessageIdsChange={markVisibleRead}
          scrollPreviousItemPeek={0}
        />
        {mention !== null && mentionOptions.length > 0 ? (
          <MentionList
            handle={mentionMenu}
            options={mentionOptions}
            activeAgentIds={activeAgentIds}
          />
        ) : null}
        {channel.archivedAt ? (
          <p className="mx-auto w-full max-w-220 px-6 pb-2 text-sm text-muted-foreground">
            频道已关闭，历史消息仍可查看。
          </p>
        ) : null}
        {canPost && autoWakeAgents.length > 0 ? (
          <div className="mx-auto flex w-full max-w-220 shrink-0 flex-wrap items-center gap-2 px-6">
            <Button
              variant={notifyAll ? 'secondary' : 'outline'}
              size="sm"
              aria-pressed={notifyAll}
              disabled={wakeLimitExceeded}
              onClick={() => setNotifyAll((value) => !value)}
            >
              <Megaphone aria-hidden="true" />
              通知全部（{autoWakeAgents.length}）
            </Button>
            {wakeLimitExceeded ? (
              <span className="text-xs text-warning">
                超过单次上限 {CHANNEL_MAX_WAKE_AGENTS} 个，请在频道设置中调整
              </span>
            ) : notifyAll && notifyLimitExceeded ? (
              <span className="text-xs text-warning">
                将唤醒 {notifyTargets.length} 个，超过单次上限 {CHANNEL_MAX_WAKE_AGENTS} 个
              </span>
            ) : notifyAll ? (
              <span className="text-xs text-muted-foreground">
                将唤醒 {notifyTargets.length} 个智能体
              </span>
            ) : null}
          </div>
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
          onKeyDown={(event) => mentionMenu.api.keydown(event.nativeEvent)}
          placeholder={canPost ? '输入消息，@ 智能体…' : '频道只读'}
        />
        <ConfirmDialog
          open={confirmingNotifyAll}
          onClose={() => setConfirmingNotifyAll(false)}
          title="发送通知全部？"
          description={`将唤醒 ${notifyTargets.length} 个智能体：${notifyTargets.join('、')}。`}
          confirmLabel="发送"
          tone="default"
          onConfirm={() => sendMessage(true)}
        />
      </section>

      <ChannelSidebarDetail
        channel={channel}
        agents={agents.data ?? []}
        activeAgentIds={activeAgentIds}
        waitingAgentIds={waitingAgentIds}
      />
      <ChannelRunSheet
        channelId={channel.id}
        runId={runSheetId}
        canAnswer={runSheetId !== null && canAnswerFor(runSheetId)}
        onClose={() => setRunSheetId(null)}
      />
    </div>
  );
}

function ChannelAgentHeader({
  agent,
  agentId,
}: {
  agent: AgentDisplay | undefined;
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

function ChannelMemberHeader({
  member,
  authorBusinessId,
}: {
  member: ChannelMember | undefined;
  authorBusinessId: string | undefined;
}) {
  const removed = member === undefined && authorBusinessId !== undefined;
  const label = member !== undefined ? memberLabel(member) : removed ? '已移除的成员' : '成员';
  const initial = member !== undefined ? memberInitial(member) : removed ? '—' : '成员';
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      {member?.image ? (
        <img src={member.image} alt="" className="size-5 shrink-0 rounded-full object-cover" />
      ) : (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-sunken text-2xs font-medium text-muted-foreground">
          {initial}
        </span>
      )}
      <span className="min-w-0 truncate font-medium text-fg">{label}</span>
    </div>
  );
}

function MemberAvatars({ members }: { members: readonly ChannelMember[] }) {
  const visible = members.slice(0, 5);
  const hidden = members.length - visible.length;
  return (
    <div className="flex items-center">
      <span className="sr-only">{members.length} 位成员</span>
      <div className="flex -space-x-1">
        {visible.map((item) => (
          <span
            key={item.businessId}
            title={`${memberLabel(item)} · ${ROLE_LABEL[item.role]}`}
            className="flex size-6 items-center justify-center rounded-full border border-line bg-sunken text-2xs font-medium text-muted-foreground"
          >
            {memberInitial(item)}
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
                  'flex h-8 min-w-0 items-center gap-2 rounded-item px-2.5 text-sm transition-colors duration-150 ease-out-soft',
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
  activeAgentIds,
  waitingAgentIds,
}: {
  channel: ChannelDetail;
  agents: { id: string; name: string; description: string; enabled: boolean }[];
  activeAgentIds: ReadonlySet<string>;
  waitingAgentIds: ReadonlySet<string>;
}) {
  const agentName = new Map(agents.map((agent) => [agent.id, agent.name]));
  return (
    <aside className="hidden w-72 shrink-0 flex-col gap-5 overflow-y-auto border-l border-line px-4 py-4 xl:flex">
      <section className="flex flex-col gap-2">
        <h2 className="text-base font-medium text-fg">
          成员 <span className="font-normal text-muted-foreground">{channel.members.length}</span>
        </h2>
        <ul className="flex flex-col gap-1.5">
          {channel.members.map((item) => (
            <li key={item.businessId} className="flex min-w-0 items-center gap-2 text-sm">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sunken text-2xs font-medium text-muted-foreground">
                {memberInitial(item)}
              </span>
              <span className="min-w-0 truncate text-fg">{memberLabel(item)}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {ROLE_LABEL[item.role]}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2 border-t border-line pt-4">
        <h2 className="text-base font-medium text-fg">
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
        <p className="text-xs text-muted-foreground">频道内不会写入专家记忆。</p>
      </section>
    </aside>
  );
}

function RunControls({
  channelId,
  runId,
  active,
  canStop,
  canApprove,
  canAnswer,
  approvals,
  stop,
  approve,
  onOpenRun,
}: {
  channelId: string;
  runId: string;
  active: boolean;
  canStop: boolean;
  canApprove: boolean;
  canAnswer: boolean;
  approvals: readonly ChannelApproval[];
  stop: ReturnType<typeof useStopChannelRun>;
  approve: ReturnType<typeof useApproveChannelApproval>;
  onOpenRun: (runId: string) => void;
}) {
  const pendingApprovals = approvals.filter((approval) => approval.runId === runId);
  const showStop = active && canStop;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          aria-label={`查看运行 ${shortId(runId)}`}
          onClick={() => onOpenRun(runId)}
        >
          <SquareArrowOutUpRight aria-hidden="true" />
          查看运行
        </Button>
        {showStop ? (
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
        {pendingApprovals.map((approval) => {
          const isPending = active && approval.approvedAt === null;
          const argumentEntries = approval.argumentsSummary
            ? Object.entries(approval.argumentsSummary)
            : [];
          return (
            <div
              key={approval.id}
              className="cds-card-surface flex min-w-0 flex-wrap items-center gap-2 rounded-card bg-surface px-3 py-2 text-sm"
            >
              <ShieldAlert className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
              {isPending ? (
                <span className="shrink-0 rounded-full bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning">
                  等待授权
                </span>
              ) : null}
              <span className="min-w-0 break-words text-fg">
                需要批准：{approval.serverName ?? approval.serverId} · {approval.toolName}
              </span>
              {canApprove ? (
                <Button
                  size="sm"
                  variant="default"
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
              ) : null}
              {argumentEntries.length > 0 ? (
                <>
                  <p className="w-full text-xs text-muted-foreground">
                    本轮调用参数；批准后该工具的全部调用均放行
                  </p>
                  <dl
                    aria-label="工具调用参数"
                    className="grid min-w-0 basis-full grid-cols-[96px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-sm"
                  >
                    {argumentEntries.map(([key, value]) => (
                      <div key={key} className="contents">
                        <dt className="min-w-0 break-words text-muted-foreground">{key}</dt>
                        <dd className="min-w-0 break-words font-mono text-xs text-fg [overflow-wrap:anywhere]">
                          {formatArgumentValue(value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </>
              ) : null}
            </div>
          );
        })}
      </div>
      <ChannelRunQuestions
        channelId={channelId}
        runId={runId}
        active={active}
        canAnswer={canAnswer}
      />
    </div>
  );
}

function ChannelRunQuestions({
  channelId,
  runId,
  active,
  canAnswer,
}: {
  channelId: string;
  runId: string;
  active: boolean;
  canAnswer: boolean;
}) {
  if (!active) return null;
  return (
    <ActiveChannelRunQuestions
      channelId={channelId}
      runId={runId}
      active={active}
      canAnswer={canAnswer}
    />
  );
}

function ActiveChannelRunQuestions({
  channelId,
  runId,
  active,
  canAnswer,
}: {
  channelId: string;
  runId: string;
  active: boolean;
  canAnswer: boolean;
}) {
  const questions = useChannelRunQuestions(channelId, runId, active);
  const respond = useRespondToChannelQuestion(channelId);
  if (questions.isError && questions.data === undefined) {
    return (
      <p role="alert" className="text-xs text-danger">
        提问状态没有加载出来。
      </p>
    );
  }
  const pending = (questions.data?.items ?? []).filter((question) => question.status === 'pending');
  if (pending.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {pending.map((question) => (
        <RunQuestionCard
          key={question.requestId}
          question={question}
          live={canAnswer}
          respond={respond}
          readOnlyNote="由运行发起者或频道管理员回答。"
        />
      ))}
    </div>
  );
}

function bindingStatus(
  status: 'active' | 'disconnected',
  active: boolean,
  waiting: boolean,
): { label: string; dot: string } {
  if (status === 'disconnected') return { label: '已断开', dot: 'bg-subtle' };
  if (waiting) return { label: '等待审批', dot: 'bg-warning' };
  if (active) return { label: '运行中', dot: 'bg-fg' };
  return { label: '空闲', dot: 'bg-subtle' };
}

function memberLabel(member: ChannelMember): string {
  return member.name ?? shortId(member.businessId);
}

function memberInitial(member: ChannelMember): string {
  return member.name
    ? member.name.slice(0, 1).toUpperCase()
    : shortId(member.businessId).slice(0, 2).toUpperCase();
}

function formatArgumentValue(value: unknown): string {
  if (typeof value === 'string') return value === '' ? '""' : value;
  if (value === null || typeof value !== 'object') return String(value);
  return JSON.stringify(value);
}
