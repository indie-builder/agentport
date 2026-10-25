import { type ConversationMessage, chatEventSchema } from '@agentport/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type ChatAccepted,
  type ConversationDetail,
  errorMessage,
  type RunDetail,
  type RunStep,
} from './api.js';
import {
  applyEvent,
  type ChatItem,
  type HistorySnapshot,
  historyToItems,
  snapshotHistory,
} from './chat-state.js';
import { useChatStore } from './chat-store.js';
import { toastError } from './toast.js';

/** 运行详情里的步骤已经是合并后的形态；转成历史消息再复用 historyToItems 的合并规则。 */
function runStepsToItems(runId: string, steps: RunStep[]): ChatItem[] {
  const messages: ConversationMessage[] = steps.map((step, index) => {
    const id = `${runId}:${index}`;
    const base = { id, conversationId: '', runId, createdAt: step.at };
    if (step.kind === 'user') return { ...base, role: 'user', content: step.text };
    if (step.kind === 'assistant') {
      return { ...base, role: 'assistant', content: { type: 'text', text: step.text } };
    }
    const toolUseId = step.toolUseId ?? id;
    return {
      ...base,
      role: 'tool',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: step.name ?? '未知工具',
          input: step.content,
          ...(step.parentToolUseId === null ? {} : { parentToolUseId: step.parentToolUseId }),
        },
        ...(step.result === undefined
          ? []
          : [
              {
                type: 'tool_result',
                toolUseId,
                content:
                  typeof step.result === 'string' ? step.result : JSON.stringify(step.result),
              },
            ]),
      ],
    };
  });
  return historyToItems(messages);
}

/**
 * 一次发送的完整生命周期：提交 → 打开事件流 → 断线重连 → 收尾。
 *
 * refs 只承载生命周期对象（EventSource / 重试计时器 / 回放基准）；
 * 会话状态全部放在 store 里，切换会话时一起被清掉。
 */
export function useChatStream({
  agentId,
  onAccepted,
  history,
}: {
  agentId: string | null;
  onAccepted: (accepted: ChatAccepted, text: string) => void;
  history?: Pick<
    UseQueryResult<ConversationDetail>,
    'data' | 'isFetching' | 'isFetchedAfterMount' | 'isError'
  >;
}) {
  const client = useQueryClient();
  const conversationId = useChatStore((state) => state.conversationId);
  const historyRequestRef = useRef<string | null>(null);
  // 服务端重连时从头回放事件流；保留发起前的消息（含用户气泡），避免文本重复或丢失。
  const baseItemsRef = useRef<ChatItem[]>([]);
  const sourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  // 切换会话时才从服务端回填历史；否则流式结束瞬间的重新查询会覆盖刚收到的回答。
  const hydratedRef = useRef<string | null>(null);
  // 回放被截断后重连可能不再收到该事件，只能在本轮内记住；下一次发送才重置。
  const replayTruncatedRef = useRef(false);
  const [historyPrefix, setHistoryPrefix] = useState<HistorySnapshot | null>(null);

  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);
  const recoveryRef = useRef<number | null>(null);
  const captureRequest = () => {
    const request = ++requestRef.current;
    const generation = generationRef.current;
    return () =>
      mountedRef.current && generationRef.current === generation && requestRef.current === request;
  };
  const closeSource = useCallback((): void => {
    if (retryRef.current !== null) {
      window.clearTimeout(retryRef.current);
      retryRef.current = null;
    }
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  const closeStream = useCallback(() => {
    generationRef.current += 1;
    recoveryRef.current = null;
    historyRequestRef.current = null;
    closeSource();
  }, [closeSource]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: changing agents revokes ownership of pending HTTP and SSE work.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      closeStream();
    };
  }, [agentId, closeStream]);

  /** 截断后的异步补全：只在本轮仍是当前会话、没有新运行、也没切走时才落地。 */
  const recoverPersisted = useCallback(async (accepted: ChatAccepted): Promise<void> => {
    // closeStream 已在 run_finished 时递增 generation，晚到的响应自然作废。
    const generation = generationRef.current;
    try {
      const detail = await api.run(accepted.runId);
      if (generation !== generationRef.current) return;
      const store = useChatStore.getState();
      if (store.conversationId !== accepted.conversationId) return;
      if (store.run !== null || store.lastRunId !== accepted.runId) return;
      // 已加载的历史（含分页）保持不动；base 的最后一项永远是本轮用户气泡。
      const prompt = baseItemsRef.current.at(-1);
      if (!prompt) return;
      const promptIndex = store.items.indexOf(prompt);
      if (promptIndex < 0) return;
      if (!detail.steps.some((step) => step.kind !== 'user')) {
        store.setItems((previous) => [
          ...previous,
          {
            kind: 'notice',
            tone: 'muted',
            text: '运行已结束，未找到已保存结果，请查看运行详情。',
          },
        ]);
        return;
      }
      const tail = runStepsToItems(accepted.runId, detail.steps);
      store.setItems([...store.items.slice(0, promptIndex), ...tail]);
    } catch {
      if (generation !== generationRef.current) return;
      const store = useChatStore.getState();
      if (store.conversationId !== accepted.conversationId) return;
      if (store.run !== null || store.lastRunId !== accepted.runId) return;
      // 保留已经收到的部分输出，只追加一条明确的失败说明。
      store.setItems((previous) => [
        ...previous,
        { kind: 'notice', tone: 'error', text: '无法读取已保存结果，请刷新后重试。' },
      ]);
    }
  }, []);

  const openStream = useCallback(
    (accepted: ChatAccepted, generation: number, attempt = 0): void => {
      if (!mountedRef.current || generationRef.current !== generation) return;
      const store = useChatStore.getState();
      closeSource();
      if (attempt > 0) store.setItems(baseItemsRef.current);
      const source = new EventSource(`/api/chat/${accepted.runId}/events`);
      sourceRef.current = source;
      const ownsStream = () =>
        mountedRef.current && generationRef.current === generation && sourceRef.current === source;
      let finished = false;
      // 服务端收到 error 事件后会主动断流；此时 run 可能还在跑，不能重连也不能清状态。
      let errored = false;

      source.onopen = () => {
        if (!ownsStream()) return;
        store.setRun((current) =>
          current?.runId === accepted.runId ? { ...current, status: 'streaming' } : current,
        );
      };

      source.onmessage = (message) => {
        if (!ownsStream()) return;
        let raw: unknown;
        try {
          raw = JSON.parse(message.data);
        } catch {
          return;
        }
        const parsed = chatEventSchema.safeParse(raw);
        if (!parsed.success) return;
        const event = parsed.data;
        if (event.type === 'replay_truncated') replayTruncatedRef.current = true;
        store.setItems((previous) => applyEvent(previous, event));
        if (event.type === 'error') {
          errored = true;
          return;
        }
        if (event.type === 'run_unavailable') {
          // 运行记录已被清理：服务端不会再补事件，也没有可回读的结果或读数。
          finished = true;
          closeStream();
          store.setRun(null);
          store.setLastRunId(null);
          void client.invalidateQueries({
            queryKey: ['conversation', accepted.conversationId],
          });
          void client.invalidateQueries({ queryKey: ['conversations'] });
          return;
        }
        if (event.type === 'run_finished') {
          finished = true;
          closeStream();
          store.setRun(null);
          // 本轮回复落库后都带同一个 run_id；补到流式项上，下一轮开始后它也能按 id 取读数。
          store.setItems((previous) => {
            const userIndex = previous.findLastIndex((item) => item.kind === 'user');
            // 没有用户项时无从判断本轮起点，宁可什么都不补，也不能给整段历史打上本轮 id。
            if (userIndex < 0) return previous;
            return previous.map((item, index) =>
              index > userIndex &&
              (item.kind === 'text' || item.kind === 'tool') &&
              item.runId === undefined
                ? { ...item, runId: accepted.runId }
                : item,
            );
          });
          store.setLastRun({
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
          void client.invalidateQueries({
            queryKey: ['conversation', accepted.conversationId],
          });
          void client.invalidateQueries({ queryKey: ['conversations'] });
          // 截断后流里只有部分事件：用落库的完整步骤替换本轮尾部。
          if (replayTruncatedRef.current) {
            void recoverPersisted(accepted);
          }
        }
        // error 只是事件流里的一条通知：服务端 run 可能仍在运行，不在这里收尾。
      };

      source.onerror = () => {
        // 服务端在 run_finished 后主动结束流；此后重连没有意义。
        if (finished || !ownsStream()) return;
        source.close();
        sourceRef.current = null;
        if (errored && attempt === 0) {
          // 服务端已明确报错并断流：保留 run，只标记事件流丢失，停止仍可用。
          store.setRun((current) =>
            current?.runId === accepted.runId ? { ...current, status: 'detached' } : current,
          );
          return;
        }
        if (attempt < 3) {
          store.setRun({ ...accepted, status: 'reconnecting', startedAt: startedAtRef.current });
          retryRef.current = window.setTimeout(
            () => openStream(accepted, generation, attempt + 1),
            1500,
          );
          return;
        }
        store.setRun({ ...accepted, status: 'detached', startedAt: startedAtRef.current });
        store.setItems((previous) => [
          ...previous,
          { kind: 'notice', tone: 'error', text: '事件流多次中断，已停止重连。' },
        ]);
      };
    },
    [closeSource, closeStream, client, recoverPersisted],
  );

  useEffect(() => {
    const data = history?.data;
    if (
      !conversationId ||
      !data ||
      data.conversation.id !== conversationId ||
      history.isFetching ||
      !history.isFetchedAfterMount ||
      history.isError ||
      hydratedRef.current === conversationId ||
      historyRequestRef.current === conversationId
    )
      return;
    const generation = generationRef.current;
    historyRequestRef.current = conversationId;
    const ownsHistory = () =>
      mountedRef.current &&
      generationRef.current === generation &&
      useChatStore.getState().conversationId === conversationId;
    void (async () => {
      const store = useChatStore.getState();
      const latestRunId = data.messages.findLast((message) => message.runId !== null)?.runId;
      if (latestRunId) {
        // SSE 从头回放；保留本轮用户消息，将已有助手内容交给回放替换。
        const first = data.messages.findIndex((message) => message.runId === latestRunId);
        const beforeReply = first + (data.messages[first]?.role === 'user' ? 1 : 0);
        baseItemsRef.current = historyToItems(data.messages.slice(0, beforeReply));
      }
      try {
        const detail = latestRunId ? await api.run(latestRunId) : null;
        if (!ownsHistory()) return;
        if (
          detail &&
          (detail.run.id !== latestRunId || detail.run.conversationId !== conversationId)
        ) {
          throw new Error('运行记录与会话不匹配，请重新打开会话');
        }
        hydratedRef.current = conversationId;
        store.setLastRunId(latestRunId ?? null);
        const items = historyToItems(data.messages);
        setHistoryPrefix(snapshotHistory(data, items));
        store.setItems(items);
        if (detail) {
          if (detail.run.status === 'queued' || detail.run.status === 'running') {
            startedAtRef.current = detail.run.startedAt
              ? Date.parse(detail.run.startedAt)
              : Date.now();
            const accepted = { runId: detail.run.id, conversationId };
            store.setRun({ ...accepted, status: 'reconnecting', startedAt: startedAtRef.current });
            const first = data.messages.findIndex((message) => message.runId === latestRunId);
            const beforeReply = first + (data.messages[first]?.role === 'user' ? 1 : 0);
            const messages = data.messages.slice(0, beforeReply);
            setHistoryPrefix(snapshotHistory({ ...data, messages }, baseItemsRef.current));
            replayTruncatedRef.current = false;
            openStream(accepted, generation, 1);
          } else {
            store.setLastRun({
              runId: detail.run.id,
              status: detail.run.status,
              ...(detail.run.latencyMs === null ? {} : { durationMs: detail.run.latencyMs }),
              ...(detail.run.turns === null ? {} : { turns: detail.run.turns }),
              ...(detail.run.inputTokens === null && detail.run.outputTokens === null
                ? {}
                : { tokens: (detail.run.inputTokens ?? 0) + (detail.run.outputTokens ?? 0) }),
              ...(detail.run.costUsd === null ? {} : { costUsd: Number(detail.run.costUsd) }),
              ...(detail.run.error === null ? {} : { error: detail.run.error }),
            });
          }
        }
      } catch (error) {
        if (!ownsHistory()) return;
        toastError(error);
        hydratedRef.current = conversationId;
        const items = historyToItems(data.messages);
        setHistoryPrefix(snapshotHistory(data, items));
        store.setItems(items);
        if (latestRunId) {
          startedAtRef.current = Date.now();
          store.setLastRunId(latestRunId);
          store.setRun({
            runId: latestRunId,
            conversationId,
            status: 'detached',
            startedAt: startedAtRef.current,
          });
        }
      } finally {
        if (ownsHistory()) historyRequestRef.current = null;
      }
    })();
  }, [
    conversationId,
    history?.data,
    history?.isFetching,
    history?.isFetchedAfterMount,
    history?.isError,
    openStream,
  ]);

  const send = async (): Promise<void> => {
    const store = useChatStore.getState();
    const { input, items, run, conversationId } = store;
    const text = input.trim();
    if (!mountedRef.current || !text || !agentId || run) return;
    if (conversationId !== null && hydratedRef.current !== conversationId) return;
    const generation = ++generationRef.current;
    const ownsRequest = () => mountedRef.current && generationRef.current === generation;
    replayTruncatedRef.current = false;
    store.setInput('');
    store.setLastRun(null);
    store.setLastRunId(null);
    // base 必须包含刚追加的用户气泡：重连会整体回放事件，不能把它丢掉。
    const nextItems: ChatItem[] = [...items, { kind: 'user', text }];
    baseItemsRef.current = nextItems;
    store.setItems(nextItems);
    startedAtRef.current = Date.now();
    store.setRun({
      runId: '',
      conversationId: conversationId ?? '',
      status: 'queued',
      startedAt: startedAtRef.current,
    });
    try {
      const accepted = await api.sendChat({
        agentId,
        message: text,
        ...(conversationId ? { conversationId } : {}),
      });
      if (!ownsRequest()) return;
      store.setConversationId(accepted.conversationId);
      store.setLastRunId(accepted.runId);
      hydratedRef.current = accepted.conversationId;
      store.setRun({ ...accepted, status: 'streaming', startedAt: startedAtRef.current });
      onAccepted(accepted, text);
      void client.invalidateQueries({ queryKey: ['conversations', agentId] });
      openStream(accepted, generation);
    } catch (error) {
      if (!ownsRequest()) return;
      store.setRun(null);
      store.setInput(text);
      // 没有 run 产生任何回答：撤回本地用户气泡，只留一条错误通知。
      store.setItems([...items, { kind: 'notice', tone: 'error', text: errorMessage(error) }]);
      toastError(error);
    }
  };

  const reconcileRun = useCallback(
    async (detail: RunDetail['run']) => {
      const store = useChatStore.getState();
      const current = store.run;
      if (!mountedRef.current || !current || current.runId !== detail.id) return;
      if (detail.status === 'queued' || detail.status === 'running') return;
      // A healthy stream can still have buffered text when the database becomes terminal.
      if (current.status === 'streaming' && detail.status !== 'cancelled') return;
      if (recoveryRef.current !== null) return;
      closeStream();
      const generation = generationRef.current;
      recoveryRef.current = generation;
      const ownsRecovery = () =>
        mountedRef.current &&
        generationRef.current === generation &&
        useChatStore.getState().conversationId === current.conversationId &&
        useChatStore.getState().run?.runId === current.runId;
      try {
        const history = await api.conversation(current.conversationId);
        if (!ownsRecovery()) return;
        if (history.conversation.id !== current.conversationId) {
          throw new Error('会话历史不匹配，请重新打开会话');
        }
        const items = historyToItems(history.messages);
        setHistoryPrefix(snapshotHistory(history, items));
        store.setItems(items);
      } catch (error) {
        if (!ownsRecovery()) return;
        toastError(new Error(`未能恢复完整会话，请重新打开会话重试：${errorMessage(error)}`));
      }
      if (!ownsRecovery()) return;
      recoveryRef.current = null;
      hydratedRef.current = current.conversationId;
      const finished = { type: 'run_finished', status: detail.status } as const;
      store.setItems((items) => applyEvent(items, finished));
      store.setRun(null);
      store.setLastRun({
        runId: detail.id,
        status: detail.status,
        durationMs: detail.latencyMs ?? Date.now() - current.startedAt,
        ...(detail.turns === null ? {} : { turns: detail.turns }),
        ...(detail.inputTokens === null && detail.outputTokens === null
          ? {}
          : {
              tokens: (detail.inputTokens ?? 0) + (detail.outputTokens ?? 0),
            }),
        ...(detail.costUsd === null ? {} : { costUsd: Number(detail.costUsd) }),
        ...(detail.error === null ? {} : { error: detail.error }),
      });
      void client.invalidateQueries({ queryKey: ['conversations', agentId] });
    },
    [closeStream, client, agentId],
  );

  const retryStream = () => {
    const run = useChatStore.getState().run;
    if (
      !run?.runId ||
      run.status !== 'detached' ||
      !mountedRef.current ||
      recoveryRef.current !== null
    )
      return;
    useChatStore.getState().setItems(baseItemsRef.current);
    useChatStore.getState().setRun({ ...run, status: 'reconnecting' });
    openStream(run, generationRef.current);
  };

  return {
    send,
    closeStream,
    captureRequest,
    hydratedRef,
    reconcileRun,
    retryStream,
    historyPrefix,
    setHistoryPrefix,
  };
}
