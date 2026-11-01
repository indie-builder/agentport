import {
  type ChannelMessage,
  type ChatEvent,
  channelEventSchema,
  chatEventSchema,
} from '@agentport/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { mergeChannelMessages } from './channel-state.js';
import { applyEvent, type ChatItem } from './chat-state.js';
import {
  channelApprovalsQuery,
  channelMessagesQuery,
  channelRunsQuery,
  useChannelMessages,
  useChannelRuns,
} from './queries.js';

export interface ChannelRunStream {
  runId: string;
  agentId: string;
  status: 'running' | 'done';
  /** 本 run 的流式块；落库回复到达后整条流被移除。 */
  items: ChatItem[];
}

const OUTCOME_TEXT: Record<'succeeded' | 'failed' | 'cancelled' | 'timeout', string> = {
  succeeded: '',
  failed: '运行失败，未产生回复。',
  cancelled: '运行已停止。',
  timeout: '运行超时，未产生回复。',
};

function runErrorMessage(event: Extract<ChatEvent, { type: 'run_finished' }>): string {
  if (event.status === 'failed' && event.error) return event.error;
  return OUTCOME_TEXT[event.status];
}

/**
 * 频道工作区的事件层：频道级 SSE 只补消息与生命周期，单条 run 的 SSE 负责流式 token。
 * 消息写进 Query 缓存；流式块留在本地状态，落库回复到达后丢弃，避免两套正文并存。
 */
export function useChannelStream(channelId: string) {
  const client = useQueryClient();
  const messages = useChannelMessages(channelId);
  const runs = useChannelRuns(channelId);
  const [streams, setStreams] = useState<Record<string, ChannelRunStream>>({});
  const cursorRef = useRef<{ channelId: string; after: number }>({ channelId: '', after: -1 });
  const runSources = useRef(new Map<string, EventSource>());

  // 切频道立即丢掉上一条频道的流与游标，别让晚到事件写进新频道。
  // biome-ignore lint/correctness/useExhaustiveDependencies: channelId 只作为重置触发器。
  useEffect(() => {
    setStreams({});
    for (const source of runSources.current.values()) source.close();
    runSources.current.clear();
    cursorRef.current = { channelId: '', after: -1 };
  }, [channelId]);

  const dropStream = (runId: string): void => {
    setStreams((previous) => {
      if (previous[runId] === undefined) return previous;
      const next = { ...previous };
      delete next[runId];
      return next;
    });
  };

  // 频道流：先等首屏消息落地，再从已加载尾部订阅。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在首屏成功后开流；后续消息由 SSE 自己写入缓存，重跑会反复重连。
  useEffect(() => {
    if (!messages.isSuccess) return;
    if (cursorRef.current.channelId === channelId) return;
    cursorRef.current = { channelId, after: messages.data?.at(-1)?.seq ?? 0 };
    const source = new EventSource(
      `/api/channels/${encodeURIComponent(channelId)}/events?after=${cursorRef.current.after}`,
    );
    const refreshLifecycle = (): void => {
      void client.invalidateQueries({ queryKey: channelRunsQuery(channelId).queryKey });
      void client.invalidateQueries({ queryKey: channelApprovalsQuery(channelId).queryKey });
    };
    source.onopen = refreshLifecycle;
    source.onmessage = (message) => {
      let raw: unknown;
      try {
        raw = JSON.parse(message.data);
      } catch {
        return;
      }
      const parsed = channelEventSchema.safeParse(raw);
      if (!parsed.success) return;
      const event = parsed.data;
      if (event.type === 'message.created') {
        cursorRef.current.after = Math.max(cursorRef.current.after, event.seq);
        client.setQueryData<ChannelMessage[]>(
          channelMessagesQuery(channelId).queryKey,
          (previous) => mergeChannelMessages(previous ?? [], [event.message]),
        );
        // 智能体回复已落库：流式正文让位给持久消息。
        if (event.message.kind === 'agent' && event.message.runId) {
          dropStream(event.message.runId);
        }
        void client.invalidateQueries({ queryKey: ['channels'] });
        return;
      }
      if (event.type === 'run.finished') {
        setStreams((previous) => {
          const current = previous[event.runId];
          if (current === undefined) return previous;
          return {
            ...previous,
            [event.runId]: { ...current, status: 'done' },
          };
        });
        refreshLifecycle();
        return;
      }
      if (event.type === 'run.started' || event.type === 'approval.requested') {
        refreshLifecycle();
        return;
      }
      if (event.type === 'error' && event.message.includes('无权')) {
        // 撤权后重连只会不断 404；停止重试，页面继续显示已加载的消息。
        source.close();
      }
    };
    return () => source.close();
  }, [channelId, client, messages.isSuccess]);

  // 单 run 流：活动 run 出现即订阅；服务端会从 Redis 回放本 run 已发生的事件。
  useEffect(() => {
    const active = runs.data ?? [];
    const live = new Set(active.map((run) => run.runId));
    for (const [runId, source] of runSources.current) {
      if (live.has(runId)) continue;
      source.close();
      runSources.current.delete(runId);
    }
    for (const run of active) {
      if (runSources.current.has(run.runId)) continue;
      setStreams((previous) =>
        previous[run.runId] === undefined
          ? {
              ...previous,
              [run.runId]: {
                runId: run.runId,
                agentId: run.agentId,
                status: 'running',
                items: [],
              },
            }
          : previous,
      );
      const source = new EventSource(
        `/api/channels/${encodeURIComponent(channelId)}/runs/${encodeURIComponent(run.runId)}/events`,
      );
      runSources.current.set(run.runId, source);
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
        setStreams((previous) => {
          const current = previous[run.runId];
          if (current === undefined) return previous;
          let items = applyEvent(current.items, event);
          if (event.type === 'run_finished') {
            const text = runErrorMessage(event);
            if (text) items = [...items, { kind: 'notice', tone: 'muted', text }];
            return {
              ...previous,
              [run.runId]: {
                ...current,
                items,
                status: 'done',
              },
            };
          }
          return { ...previous, [run.runId]: { ...current, items } };
        });
        if (event.type === 'run_finished') {
          source.close();
          runSources.current.delete(run.runId);
          void client.invalidateQueries({ queryKey: channelRunsQuery(channelId).queryKey });
          void client.invalidateQueries({ queryKey: channelApprovalsQuery(channelId).queryKey });
        }
      };
    }
  }, [channelId, client, runs.data]);

  useEffect(
    () => () => {
      for (const source of runSources.current.values()) source.close();
      runSources.current.clear();
    },
    [],
  );

  const lastSeq = messages.data?.at(-1)?.seq ?? 0;
  return {
    messages: messages.data ?? [],
    messagesQuery: messages,
    activeRuns: runs.data ?? [],
    streams,
    lastSeq,
  };
}
