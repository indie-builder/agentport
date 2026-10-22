import { type ConversationMessage, chatEventSchema } from '@agentport/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { api, type ChatAccepted, errorMessage, type RunStep } from './api.js';
import { applyEvent, type ChatItem, historyToItems } from './chat-state.js';
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
  // 每次关闭流都作废尚未返回的 send 与旧流的迟到事件。
  const generationRef = useRef(0);
  // 回放被截断后重连可能不再收到该事件，只能在本轮内记住；下一次发送才重置。
  const replayTruncatedRef = useRef(false);
  const queryClient = useQueryClient();

  const closeStream = useCallback((): void => {
    generationRef.current += 1;
    if (retryRef.current !== null) {
      window.clearTimeout(retryRef.current);
      retryRef.current = null;
    }
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  useEffect(() => closeStream, [closeStream]);

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
        // 已关闭的旧流仍可能派发事件；先确认它还是当前流，再写 store。
        if (sourceRef.current !== source) return;
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
          void queryClient.invalidateQueries({
            queryKey: ['conversation', accepted.conversationId],
          });
          void queryClient.invalidateQueries({ queryKey: ['conversations'] });
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
          void queryClient.invalidateQueries({
            queryKey: ['conversation', accepted.conversationId],
          });
          void queryClient.invalidateQueries({ queryKey: ['conversations'] });
          // 截断后流里只有部分事件：用落库的完整步骤替换本轮尾部。
          if (replayTruncatedRef.current) {
            void recoverPersisted(accepted);
          }
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
    [closeStream, queryClient, recoverPersisted],
  );

  const send = async (): Promise<void> => {
    const store = useChatStore.getState();
    const { input, items, run, conversationId } = store;
    const text = input.trim();
    if (!text || !agentId || run) return;
    replayTruncatedRef.current = false;
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
    const generation = generationRef.current;
    try {
      const accepted = await api.sendChat({
        agentId,
        message: text,
        ...(conversationId ? { conversationId } : {}),
      });
      // 等待期间用户切换了会话：本次运行归旧会话，结果直接丢弃。
      if (generation !== generationRef.current) return;
      store.setConversationId(accepted.conversationId);
      store.setLastRunId(accepted.runId);
      hydratedRef.current = accepted.conversationId;
      store.setRun({ ...accepted, status: 'streaming', startedAt: startedAtRef.current });
      onAccepted(accepted, text);
      openStream(accepted);
    } catch (error) {
      if (generation !== generationRef.current) return;
      store.setRun(null);
      store.setInput(text);
      // 没有 run 产生任何回答：撤回本地用户气泡，只留一条错误通知。
      store.setItems([...items, { kind: 'notice', tone: 'error', text: errorMessage(error) }]);
      toastError(error);
    }
  };

  return { send, closeStream, hydratedRef };
}
