import {
  type ChannelMessage,
  type ChatEvent,
  channelEventSchema,
  chatEventSchema,
  parseJsonAs,
  type TerminalRunStatus,
} from '@agentport/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { mergeChannelMessages } from './channel-state.js';
import { applyEvent, type ChatItem } from './chat-state.js';
import { channelKeys, useChannelMessages, useChannelRuns } from './queries.js';

interface ChannelRunStream {
  runId: string;
  agentId: string;
  initiatedBy: string | null;
  status: 'running' | 'done';
  items: ChatItem[];
}

const OUTCOME_TEXT: Record<TerminalRunStatus, string> = {
  succeeded: '',
  failed: '运行失败，未产生回复。',
  cancelled: '运行已停止。',
  timeout: '运行超时，未产生回复。',
};

function runErrorMessage(event: Extract<ChatEvent, { type: 'run_finished' }>): string {
  if (event.status === 'failed' && event.error) return event.error;
  return OUTCOME_TEXT[event.status];
}

export function useChannelStream(channelId: string) {
  const client = useQueryClient();
  const messages = useChannelMessages(channelId);
  const runs = useChannelRuns(channelId);
  const [streams, setStreams] = useState<Record<string, ChannelRunStream>>({});
  const cursorRef = useRef<{ channelId: string; after: number }>({ channelId: '', after: -1 });
  const runSources = useRef(new Map<string, EventSource>());

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在首屏成功后开流；后续消息由 SSE 自己写入缓存，重跑会反复重连。
  useEffect(() => {
    if (!messages.isSuccess) return;
    if (cursorRef.current.channelId !== channelId) {
      cursorRef.current = {
        channelId,
        after: messages.data?.findLast((message) => !message.id.startsWith('local-'))?.seq ?? 0,
      };
    }
    const source = new EventSource(
      `/api/channels/${encodeURIComponent(channelId)}/events?after=${cursorRef.current.after}`,
    );
    const refreshLifecycle = (): void => {
      void client.invalidateQueries({ queryKey: channelKeys.runs(channelId) });
      void client.invalidateQueries({ queryKey: channelKeys.approvals(channelId) });
    };
    source.onopen = refreshLifecycle;
    source.onmessage = (message) => {
      const event = parseJsonAs(message.data, channelEventSchema);
      if (event === null) return;
      if (event.type === 'message.created') {
        cursorRef.current.after = Math.max(cursorRef.current.after, event.seq);
        client.setQueryData<ChannelMessage[]>(channelKeys.messages(channelId), (previous) =>
          mergeChannelMessages(previous ?? [], [event.message]),
        );
        if (event.message.runId) {
          dropStream(event.message.runId);
        }
        void client.invalidateQueries({ queryKey: channelKeys.all });
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
      if (event.type === 'error' && event.code === 'FORBIDDEN') {
        source.close();
      }
    };
    return () => source.close();
  }, [channelId, client, messages.isSuccess]);

  useEffect(() => {
    const active = runs.data ?? [];
    const live = new Set(active.map((run) => run.runId));
    setStreams((previous) => {
      let next: Record<string, ChannelRunStream> | null = null;
      for (const [runId, item] of Object.entries(previous)) {
        if (item.status !== 'running' || live.has(runId)) continue;
        next ??= { ...previous };
        next[runId] = { ...item, status: 'done' };
      }
      return next ?? previous;
    });
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
                initiatedBy: run.initiatedBy,
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
        const event = parseJsonAs(message.data, chatEventSchema);
        if (event === null) return;
        if (
          event.type === 'question_requested' ||
          event.type === 'question_updated' ||
          event.type === 'question_closed'
        ) {
          void client.invalidateQueries({
            queryKey: channelKeys.runQuestions(channelId, run.runId),
          });
          return;
        }
        if (event.type === 'run_started') {
          setStreams((previous) => {
            const current = previous[run.runId];
            if (current === undefined) return previous;
            return {
              ...previous,
              [run.runId]: { ...current, status: 'running', items: [] },
            };
          });
          return;
        }
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
          void client.invalidateQueries({ queryKey: channelKeys.runs(channelId) });
          void client.invalidateQueries({ queryKey: channelKeys.approvals(channelId) });
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

  const lastSeq = messages.data?.findLast((message) => !message.id.startsWith('local-'))?.seq ?? 0;
  return {
    messages: messages.data ?? [],
    messagesQuery: messages,
    activeRuns: runs.data ?? [],
    streams,
    lastSeq,
  };
}
