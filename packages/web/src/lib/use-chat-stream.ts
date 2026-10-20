import { chatEventSchema } from '@agentport/shared';
import { useCallback, useEffect, useRef } from 'react';
import { api, type ChatAccepted, errorMessage } from './api.js';
import { applyEvent, type ChatItem } from './chat-state.js';
import { useChatStore } from './chat-store.js';
import { toastError } from './toast.js';

/**
 * 一次发送的完整生命周期：提交 → 打开事件流 → 断线重连 → 收尾。
 *
 * refs 只承载生命周期对象（EventSource / 重试计时器 / 回放基准）；
 * 会话状态全部放在 store 里，切换会话时一起被清掉。
 */
export function useChatStream({
  agentId,
  onAccepted,
}: {
  agentId: string | null;
  onAccepted: (accepted: ChatAccepted, text: string) => void;
}) {
  // 服务端重连时从头回放事件流；保留发起前的消息（含用户气泡），避免文本重复或丢失。
  const baseItemsRef = useRef<ChatItem[]>([]);
  const sourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  // 切换会话时才从服务端回填历史；否则流式结束瞬间的重新查询会覆盖刚收到的回答。
  const hydratedRef = useRef<string | null>(null);

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
      const store = useChatStore.getState();
      closeStream();
      if (attempt > 0) store.setItems(baseItemsRef.current);
      const source = new EventSource(`/api/chat/${accepted.runId}/events`);
      sourceRef.current = source;
      let finished = false;
      // 服务端收到 error 事件后会主动断流；此时 run 可能还在跑，不能重连也不能清状态。
      let errored = false;

      source.onopen = () => {
        if (sourceRef.current !== source) return;
        store.setRun((current) =>
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
        store.setItems((previous) => applyEvent(previous, event));
        if (event.type === 'error') {
          errored = true;
          return;
        }
        if (event.type === 'run_finished') {
          finished = true;
          closeStream();
          store.setRun(null);
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
          store.setRun((current) =>
            current?.runId === accepted.runId ? { ...current, status: 'detached' } : current,
          );
          return;
        }
        if (attempt < 3) {
          store.setRun({ ...accepted, status: 'reconnecting', startedAt: startedAtRef.current });
          retryRef.current = window.setTimeout(() => openStream(accepted, attempt + 1), 1500);
          return;
        }
        store.setRun(null);
        store.setItems((previous) => [
          ...previous,
          { kind: 'notice', tone: 'error', text: '事件流多次中断，已停止重连。' },
        ]);
      };
    },
    [closeStream],
  );

  const send = async (): Promise<void> => {
    const store = useChatStore.getState();
    const { input, items, run, conversationId } = store;
    const text = input.trim();
    if (!text || !agentId || run) return;
    store.setInput('');
    store.setLastRun(null);
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
      store.setConversationId(accepted.conversationId);
      store.setLastRunId(accepted.runId);
      hydratedRef.current = accepted.conversationId;
      store.setRun({ ...accepted, status: 'streaming', startedAt: startedAtRef.current });
      onAccepted(accepted, text);
      openStream(accepted);
    } catch (error) {
      store.setRun(null);
      store.setInput(text);
      // 没有 run 产生任何回答：撤回本地用户气泡，只留一条错误通知。
      store.setItems([...items, { kind: 'notice', tone: 'error', text: errorMessage(error) }]);
      toastError(error);
    }
  };

  return { send, closeStream, hydratedRef };
}
