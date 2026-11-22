import {
  attachmentMimeForFilename,
  type ChatEvent,
  type ChatRequest,
  type ConversationMessage,
  type ConversationRunMetrics,
  chatEventSchema,
  parseJsonAs,
} from '@agentport/shared';
import type { InfiniteData, QueryClient, UseQueryResult } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  api,
  type ChatAccepted,
  type ChatAttachmentInput,
  type ConversationDetail,
  errorMessage,
  type RunDetail,
} from './api.js';
import { readFileBase64 } from './browser-files.js';
import {
  applyEvent,
  attachmentDownloadUrl,
  type ChatItem,
  type HistorySnapshot,
  historyToItems,
  snapshotHistory,
} from './chat-state.js';
import {
  advancePhase,
  type ChatPhaseEvent,
  isActivePhase,
  type RunMetrics,
  useChatStore,
} from './chat-store.js';
import {
  chatKeys,
  type RunQuestionList,
  runQuery,
  runQuestionsQueryKey,
  withRunQuestion,
} from './queries.js';
import { toastError } from './toast.js';

type PersistedBlock = NonNullable<
  Extract<ChatEvent, { type: 'run_finished' }>['messageIds']
>[number];

type RegenerateSnapshot = {
  generation: number;
  runId?: string;
  items: ChatItem[];
  lastRun: RunMetrics | null;
  lastRunId: string | null;
  historyPrefix: HistorySnapshot | null;
};

const RECOVERY_PAGE_SIZE = 100;
const RECOVERY_MAX_PAGES = 10;

function dispatchPhase(event: ChatPhaseEvent): void {
  const store = useChatStore.getState();
  store.setPhase(advancePhase(store.phase, event));
}

async function loadRunMessages(
  conversationId: string,
  runId: string,
): Promise<{ messages: ConversationMessage[]; prefix: ConversationMessage[] }> {
  let cursor: string | undefined;
  let all: ConversationMessage[] = [];
  for (let page = 0; page < RECOVERY_MAX_PAGES; page += 1) {
    const detail = await api.conversation(conversationId, {
      limit: RECOVERY_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (detail.conversation.id !== conversationId) {
      throw new Error('会话历史不匹配，请重新打开会话');
    }
    all = [...detail.messages, ...all];
    const oldest = detail.messages[0];
    const complete = oldest === undefined || oldest.runId !== runId || oldest.role === 'user';
    if (!complete && detail.nextCursor != null) {
      cursor = detail.nextCursor;
      continue;
    }
    const start = all.findIndex((message) => message.runId === runId);
    return {
      messages: start < 0 ? [] : all.slice(start).filter((message) => message.runId === runId),
      prefix: start < 0 ? all : all.slice(0, start),
    };
  }
  throw new Error('本轮输出超出可恢复范围，请刷新后查看会话历史');
}

function uniqueMessages(messages: ConversationMessage[]): ConversationMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

function replaceLastUser(items: ChatItem[], prompt: ChatItem): ChatItem[] {
  const index = items.findLastIndex((item) => item.kind === 'user');
  return index < 0 ? items : items.with(index, prompt);
}

function trimHistoryPrefix(snapshot: HistorySnapshot): HistorySnapshot | null {
  const promptIndex = snapshot.messages.findLastIndex((message) => message.role === 'user');
  if (promptIndex < 0) return null;
  const kept = snapshot.messages.slice(0, promptIndex);
  if (kept.length === 0) return null;
  return {
    conversationId: snapshot.conversationId,
    boundaryId: kept.at(-1)?.id ?? null,
    messages: kept,
    count: historyToItems(kept).length,
  };
}

function cacheRunMetrics(
  client: QueryClient,
  conversationId: string,
  metric: ConversationRunMetrics,
): void {
  client.setQueryData<InfiniteData<ConversationDetail>>(
    chatKeys.conversation(conversationId),
    (previous) => {
      const first = previous?.pages[0];
      if (!previous || !first) return previous;
      return {
        ...previous,
        pages: [
          {
            ...first,
            runMetrics: [
              ...(first.runMetrics ?? []).filter((run) => run.runId !== metric.runId),
              metric,
            ],
          },
          ...previous.pages.slice(1),
        ],
      };
    },
  );
}

function matchPersistedBlocks(
  items: ChatItem[],
  startIndex: number,
  blocks: PersistedBlock[],
): Map<number, PersistedBlock> {
  const used = new Set<number>();
  const matched = new Map<number, PersistedBlock>();
  for (const [index, item] of items.entries()) {
    if (index <= startIndex || item.kind !== 'text' || item.streamBlockId === undefined) continue;
    const found = blocks.findIndex(
      (block, blockIndex) =>
        !used.has(blockIndex) &&
        block.streamBlockId === item.streamBlockId &&
        block.parentToolUseId === item.parentToolUseId,
    );
    if (found < 0) continue;
    used.add(found);
    matched.set(index, blocks[found] as PersistedBlock);
  }
  const queues = new Map<string, Array<{ block: PersistedBlock; index: number }>>();
  const live = new Map<string, number[]>();
  for (const [index, block] of blocks.entries()) {
    if (used.has(index) || block.streamBlockId !== undefined) continue;
    const key = `${block.blockIndex}|${block.parentToolUseId ?? ''}`;
    const queue = queues.get(key);
    if (queue) queue.push({ block, index });
    else queues.set(key, [{ block, index }]);
  }
  for (const [index, item] of items.entries()) {
    if (index <= startIndex || item.kind !== 'text') continue;
    if (item.streamBlockId !== undefined || matched.has(index)) continue;
    const key = `${item.blockIndex ?? 0}|${item.parentToolUseId ?? ''}`;
    const list = live.get(key);
    if (list) list.push(index);
    else live.set(key, [index]);
  }
  for (const [key, indexes] of live) {
    const queue = queues.get(key);
    if (queue === undefined || queue.length !== indexes.length) continue;
    indexes.forEach((index, position) => {
      const entry = queue[position] as { block: PersistedBlock; index: number };
      matched.set(index, entry.block);
    });
  }
  return matched;
}

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
  const baseItemsRef = useRef<ChatItem[]>([]);
  const sourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const hydratedRef = useRef<string | null>(null);
  const replayTruncatedRef = useRef(false);
  const [historyPrefix, setHistoryPrefix] = useState<HistorySnapshot | null>(null);
  const regenerateSnapshotRef = useRef<RegenerateSnapshot | null>(null);
  const [regenerating, setRegenerating] = useState(false);

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
    regenerateSnapshotRef.current = null;
    setRegenerating(false);
    closeSource();
  }, [closeSource]);

  const resetWorkspace = useCallback(
    (nextConversationId: string | null, carryDraft = false): void => {
      closeStream();
      hydratedRef.current = null;
      useChatStore.getState().resetConversation(nextConversationId, carryDraft);
    },
    [closeStream],
  );

  const restoreRegenerate = useCallback((snapshot: RegenerateSnapshot): void => {
    const store = useChatStore.getState();
    store.setItems(snapshot.items);
    store.setLastRun(snapshot.lastRun);
    store.setLastRunId(snapshot.lastRunId);
    baseItemsRef.current = snapshot.items;
    setHistoryPrefix(snapshot.historyPrefix);
    dispatchPhase({ type: 'finish' });
  }, []);

  useEffect(
    () =>
      useChatStore.subscribe((state, previous) => {
        if (state.accountEpoch !== previous.accountEpoch) closeStream();
      }),
    [closeStream],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      closeStream();
    };
  }, [closeStream]);

  const previousAgentId = useRef(agentId);
  useEffect(() => {
    if (previousAgentId.current === agentId) return;
    const authoritativeFill =
      previousAgentId.current === null &&
      agentId !== null &&
      conversationId !== null &&
      hydratedRef.current === conversationId &&
      history?.data?.conversation.id === conversationId &&
      history.data.conversation.agentId === agentId;
    previousAgentId.current = agentId;
    if (!authoritativeFill) closeStream();
  }, [agentId, conversationId, history?.data, closeStream]);

  const recoverPersisted = useCallback(
    async (accepted: ChatAccepted, generation: number): Promise<void> => {
      const ownsRecovery = () => {
        if (!mountedRef.current || generationRef.current !== generation) return false;
        const current = useChatStore.getState();
        const currentRunId = isActivePhase(current.phase) ? current.phase.runId : null;
        return (
          current.conversationId === accepted.conversationId &&
          (current.phase.kind === 'idle' || currentRunId === accepted.runId) &&
          current.lastRunId === accepted.runId
        );
      };
      try {
        const { messages } = await loadRunMessages(accepted.conversationId, accepted.runId);
        if (!ownsRecovery()) return;
        const store = useChatStore.getState();
        if (!messages.some((message) => message.role !== 'user')) {
          store.setItems((previous) => [
            ...previous,
            {
              kind: 'notice',
              tone: 'muted',
              text: '运行已结束，未找到已保存结果，请查看运行详情。',
            },
          ]);
        } else {
          const tail = historyToItems(messages);
          const prompt = baseItemsRef.current.at(-1);
          const shared = prompt === undefined ? -1 : store.items.indexOf(prompt);
          const promptIndex =
            shared >= 0
              ? shared
              : store.items.findLastIndex(
                  (item) => item.kind === 'user' && item.runId === accepted.runId,
                );
          store.setItems(promptIndex < 0 ? tail : [...store.items.slice(0, promptIndex), ...tail]);
        }
      } catch {
        if (!ownsRecovery()) return;
        useChatStore
          .getState()
          .setItems((previous) => [
            ...previous,
            { kind: 'notice', tone: 'error', text: '无法读取已保存结果，请刷新后重试。' },
          ]);
      }
      if (!ownsRecovery()) return;
      dispatchPhase({ type: 'finish' });
      recoveryRef.current = null;
    },
    [],
  );

  const openStream = useCallback(
    (accepted: ChatAccepted, generation: number, attempt = 0): void => {
      if (!mountedRef.current || generationRef.current !== generation) return;
      const store = useChatStore.getState();
      closeSource();
      let replayPending = attempt > 0;
      const source = new EventSource(`/api/chat/${accepted.runId}/events`);
      sourceRef.current = source;
      const ownsStream = () =>
        mountedRef.current && generationRef.current === generation && sourceRef.current === source;
      let finished = false;
      let errored = false;

      source.onopen = () => {
        if (!ownsStream()) return;
        dispatchPhase({ type: 'open' });
      };

      source.onmessage = (message) => {
        if (!ownsStream()) return;
        const event = parseJsonAs(message.data, chatEventSchema);
        if (event === null) return;
        if (replayPending) {
          replayPending = false;
          store.setItems(baseItemsRef.current);
        }
        if (event.type === 'replay_truncated') replayTruncatedRef.current = true;
        store.setItems((previous) => applyEvent(previous, event));
        if (event.type === 'question_updated') {
          client.setQueryData<RunQuestionList>(
            runQuestionsQueryKey(event.question.runId),
            (previous) => ({ items: withRunQuestion(previous?.items, event.question) }),
          );
          return;
        }
        if (event.type === 'error') {
          errored = true;
          dispatchPhase({ type: 'error' });
          return;
        }
        if (event.type === 'run_unavailable') {
          finished = true;
          closeStream();
          dispatchPhase({ type: 'finish' });
          store.setLastRunId(null);
          void client.invalidateQueries({
            queryKey: chatKeys.conversation(accepted.conversationId),
          });
          void client.invalidateQueries({
            queryKey: chatKeys.outputs(accepted.conversationId),
          });
          void client.invalidateQueries({ queryKey: chatKeys.conversations() });
          return;
        }
        if (event.type === 'run_finished') {
          finished = true;
          const regenerate = regenerateSnapshotRef.current;
          closeStream();
          if (
            regenerate !== null &&
            regenerate.generation === generation &&
            regenerate.runId === accepted.runId &&
            event.status !== 'succeeded' &&
            (event.messageIds ?? []).length === 0
          ) {
            restoreRegenerate(regenerate);
            void client.invalidateQueries({
              queryKey: chatKeys.conversation(accepted.conversationId),
            });
            return;
          }
          const recoveryGeneration = generationRef.current;
          const needsRecovery = replayTruncatedRef.current;
          if (needsRecovery) {
            recoveryRef.current = recoveryGeneration;
            dispatchPhase({ type: 'recoveryStart' });
          } else {
            dispatchPhase({ type: 'finish' });
          }
          store.setItems((previous) => {
            const userIndex = previous.findLastIndex((item) => item.kind === 'user');
            if (userIndex < 0) return previous;
            const matched = matchPersistedBlocks(previous, userIndex, event.messageIds ?? []);
            const questions = new Map(
              (
                client.getQueryData<RunQuestionList>(runQuestionsQueryKey(accepted.runId))?.items ??
                []
              ).map((question) => [question.toolUseId, question]),
            );
            return previous.map((item, index) => {
              if (index <= userIndex) return item;
              if (item.kind !== 'text' && item.kind !== 'tool') return item;
              const block = matched.get(index);
              if (item.runId !== undefined && block === undefined) return item;
              const question =
                item.kind === 'tool' && item.question === undefined
                  ? questions.get(item.toolUseId)
                  : undefined;
              return {
                ...item,
                ...(item.runId === undefined ? { runId: accepted.runId } : {}),
                ...(question === undefined ? {} : { question }),
                ...(block === undefined
                  ? {}
                  : {
                      id: block.id,
                      messageId: block.id,
                      ...(block.uiFormat === undefined ? {} : { uiFormat: block.uiFormat }),
                      ...(block.uiProgram == null ? {} : { uiProgram: block.uiProgram }),
                      ...(block.uiState === undefined ? {} : { uiState: block.uiState }),
                    }),
              };
            });
          });
          const durationMs = Date.now() - startedAtRef.current;
          const tokens =
            event.inputTokens === undefined && event.outputTokens === undefined
              ? null
              : (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
          store.setLastRun({
            runId: accepted.runId,
            status: event.status,
            durationMs,
            ...(event.turns === undefined ? {} : { turns: event.turns }),
            ...(tokens === null ? {} : { tokens }),
            ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
            ...(event.error === undefined ? {} : { error: event.error }),
            endedAt: new Date().toISOString(),
          });
          cacheRunMetrics(client, accepted.conversationId, {
            runId: accepted.runId,
            status: event.status,
            turns: event.turns ?? null,
            durationMs,
            tokens,
            costUsd: event.costUsd ?? null,
            error: event.error ?? null,
            endedAt: null,
          });
          void client.invalidateQueries({
            queryKey: chatKeys.conversation(accepted.conversationId),
          });
          void client.invalidateQueries({
            queryKey: chatKeys.outputs(accepted.conversationId),
          });
          void client.invalidateQueries({ queryKey: chatKeys.conversations() });
          if (needsRecovery) {
            void recoverPersisted(accepted, recoveryGeneration);
          }
        }
      };

      source.onerror = () => {
        if (finished || !ownsStream()) return;
        source.close();
        sourceRef.current = null;
        if (errored && attempt === 0) {
          dispatchPhase({ type: 'error' });
          return;
        }
        if (attempt < 3) {
          dispatchPhase({
            type: 'retry',
            runId: accepted.runId,
            attempt: attempt + 1,
            startedAt: startedAtRef.current,
          });
          retryRef.current = window.setTimeout(
            () => openStream(accepted, generation, attempt + 1),
            1500,
          );
          return;
        }
        dispatchPhase({
          type: 'detached',
          runId: accepted.runId,
          reason: 'retries',
          startedAt: startedAtRef.current,
        });
        store.setItems((previous) => [
          ...previous,
          { kind: 'notice', tone: 'error', text: '事件流多次中断，已停止重连。' },
        ]);
      };
    },
    [closeSource, closeStream, client, recoverPersisted, restoreRegenerate],
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
      const runStart = latestRunId
        ? data.messages.findIndex((message) => message.runId === latestRunId)
        : -1;
      const loadedItems = historyToItems(data.messages);
      try {
        const detail = latestRunId
          ? await client.query({ ...runQuery(latestRunId), staleTime: 0 })
          : null;
        if (!ownsHistory()) return;
        if (
          detail &&
          (detail.run.id !== latestRunId || detail.run.conversationId !== conversationId)
        ) {
          throw new Error('运行记录与会话不匹配，请重新打开会话');
        }
        if (detail && (detail.run.status === 'queued' || detail.run.status === 'running')) {
          const userLoaded = runStart >= 0 && data.messages[runStart]?.role === 'user';
          const paged = userLoaded
            ? { messages: [] as ConversationMessage[], prefix: [] as ConversationMessage[] }
            : await loadRunMessages(conversationId, latestRunId as string);
          if (!ownsHistory()) return;

          const prefixMessages = userLoaded ? data.messages.slice(0, runStart) : paged.prefix;
          const prefixItems = historyToItems(prefixMessages);
          const promptMessage = userLoaded
            ? data.messages[runStart]
            : paged.messages.find((message) => message.role === 'user');
          let promptItem: ChatItem | undefined;
          if (promptMessage) {
            const promptId = `${promptMessage.id}:0`;
            promptItem =
              loadedItems.find((item) => item.id === promptId) ??
              historyToItems([promptMessage])[0];
          }
          const items = userLoaded
            ? loadedItems
            : [...prefixItems, ...(promptItem ? [promptItem] : []), ...loadedItems];
          const base = [...prefixItems, ...(promptItem ? [promptItem] : [])];
          baseItemsRef.current = base;
          const baseMessages =
            promptMessage === undefined ? prefixMessages : [...prefixMessages, promptMessage];

          hydratedRef.current = conversationId;
          store.setLastRunId(latestRunId ?? null);
          setHistoryPrefix(snapshotHistory({ ...data, messages: baseMessages }, base));
          store.setItems(items);
          startedAtRef.current = detail.run.startedAt
            ? Date.parse(detail.run.startedAt)
            : Date.now();
          const accepted = { runId: detail.run.id, conversationId };
          dispatchPhase({
            type: 'accept',
            runId: accepted.runId,
            startedAt: startedAtRef.current,
            attempt: 1,
          });
          replayTruncatedRef.current = false;
          openStream(accepted, generation, 1);
          return;
        }

        let canonicalMessages = data.messages;
        if (detail) {
          try {
            const paged = await loadRunMessages(conversationId, latestRunId as string);
            if (!ownsHistory()) return;
            const dataPrefix = runStart < 0 ? data.messages : data.messages.slice(0, runStart);
            const prefix = runStart === 0 ? paged.prefix : dataPrefix;
            canonicalMessages = uniqueMessages([...prefix, ...paged.messages]);
          } catch (error) {
            if (!ownsHistory()) return;
            toastError(error);
          }
        }
        hydratedRef.current = conversationId;
        store.setLastRunId(latestRunId ?? null);
        const items = historyToItems(canonicalMessages);
        setHistoryPrefix(snapshotHistory({ ...data, messages: canonicalMessages }, items));
        store.setItems(items);
        if (detail && detail.run.status !== 'queued' && detail.run.status !== 'running') {
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
      } catch (error) {
        if (!ownsHistory()) return;
        hydratedRef.current = conversationId;
        const items = historyToItems(data.messages);
        setHistoryPrefix(snapshotHistory(data, items));
        store.setItems(items);
        if (latestRunId && !(error instanceof ApiError && error.status === 404)) {
          toastError(error);
          startedAtRef.current = Date.now();
          store.setLastRunId(latestRunId);
          dispatchPhase({
            type: 'detached',
            runId: latestRunId,
            reason: 'history',
            startedAt: startedAtRef.current,
          });
          if (runStart >= 0) {
            const beforeReply = runStart + (data.messages[runStart]?.role === 'user' ? 1 : 0);
            baseItemsRef.current = historyToItems(data.messages.slice(0, beforeReply));
          }
        } else if (latestRunId) {
          store.setLastRunId(null);
          dispatchPhase({ type: 'finish' });
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
    client,
  ]);

  const send = async (text?: string, action?: ChatRequest['openuiAction']): Promise<void> => {
    const store = useChatStore.getState();
    const { input, items, phase, conversationId } = store;
    const outputRef = text === undefined ? store.outputRef : null;
    const attachments = text === undefined ? store.pendingAttachments : [];
    const body = (text ?? input).trim();
    if (!mountedRef.current || (!body && attachments.length === 0) || phase.kind !== 'idle') return;
    if (conversationId !== null && (hydratedRef.current !== conversationId || agentId === null))
      return;
    regenerateSnapshotRef.current = null;
    setRegenerating(false);
    const generation = ++generationRef.current;
    const ownsRequest = () => mountedRef.current && generationRef.current === generation;
    replayTruncatedRef.current = false;
    if (text === undefined) store.setInput('', false);
    store.setLastRun(null);
    store.setLastRunId(null);
    const optimistic = attachments.map((file) => ({
      filename: file.name,
      mimeType: file.type || attachmentMimeForFilename(file.name) || 'application/octet-stream',
      size: file.size,
    }));
    const nextItems: ChatItem[] = [
      ...items,
      { kind: 'user', text: body, ...(optimistic.length > 0 ? { attachments: optimistic } : {}) },
    ];
    baseItemsRef.current = nextItems;
    store.setItems(nextItems);
    startedAtRef.current = Date.now();
    dispatchPhase({ type: 'submit', startedAt: startedAtRef.current });
    try {
      const payload: ChatAttachmentInput[] =
        attachments.length > 0
          ? await Promise.all(
              attachments.map(async (file) => ({
                filename: file.name,
                dataBase64: await readFileBase64(file),
              })),
            )
          : [];
      if (!ownsRequest()) return;
      const accepted = await api.sendChat({
        ...(agentId === null ? {} : { agentId }),
        message: body,
        ...(conversationId ? { conversationId } : {}),
        ...(action ? { openuiAction: action } : {}),
        ...(payload.length > 0 ? { attachments: payload } : {}),
        ...(outputRef ? { output: outputRef } : {}),
      });
      if (!ownsRequest()) return;
      if (text === undefined && useChatStore.getState().input === '') {
        store.clearDraft(conversationId, input);
      }
      store.setConversationId(accepted.conversationId);
      const baseIndex = baseItemsRef.current.findLastIndex((item) => item.kind === 'user');
      const basePrompt = baseIndex < 0 ? undefined : baseItemsRef.current[baseIndex];
      if (basePrompt?.kind === 'user') {
        const serverAttachments = accepted.attachments?.map(({ id, filename, mimeType, size }) => ({
          id,
          filename,
          mimeType,
          size,
          downloadUrl: attachmentDownloadUrl(accepted.conversationId, id),
        }));
        const prompt: ChatItem = {
          ...basePrompt,
          runId: accepted.runId,
          ...(serverAttachments === undefined ? {} : { attachments: serverAttachments }),
        };
        baseItemsRef.current = replaceLastUser(baseItemsRef.current, prompt);
        useChatStore.getState().setItems((previous) => replaceLastUser(previous, prompt));
      }
      store.setLastRunId(accepted.runId);
      if (outputRef && useChatStore.getState().outputRef === outputRef) store.setOutputRef(null);
      if (attachments.length > 0 && useChatStore.getState().pendingAttachments === attachments) {
        store.setPendingAttachments([]);
      }
      hydratedRef.current = accepted.conversationId;
      dispatchPhase({
        type: 'accept',
        runId: accepted.runId,
        startedAt: startedAtRef.current,
      });
      onAccepted(accepted, body);
      void client.invalidateQueries({ queryKey: chatKeys.conversations() });
      openStream(accepted, generation);
    } catch (error) {
      if (!ownsRequest()) return;
      const latest = useChatStore.getState();
      dispatchPhase({ type: 'finish' });
      if (text === undefined && latest.input === '') latest.setInput(input);
      store.setItems([...items, { kind: 'notice', tone: 'error', text: errorMessage(error) }]);
      toastError(error);
    }
  };

  const regenerate = async (): Promise<void> => {
    const store = useChatStore.getState();
    const { items, phase, conversationId } = store;
    if (
      !mountedRef.current ||
      conversationId === null ||
      phase.kind !== 'idle' ||
      hydratedRef.current !== conversationId ||
      agentId === null
    )
      return;
    const lastUserIndex = items.findLastIndex((item) => item.kind === 'user');
    if (lastUserIndex < 0) return;
    const generation = ++generationRef.current;
    const ownsRequest = () => mountedRef.current && generationRef.current === generation;
    replayTruncatedRef.current = false;
    const previousLastRun = store.lastRun;
    const previousLastRunId = store.lastRunId;
    const snapshot: RegenerateSnapshot = {
      generation,
      items,
      lastRun: previousLastRun,
      lastRunId: previousLastRunId,
      historyPrefix,
    };
    regenerateSnapshotRef.current = snapshot;
    setRegenerating(true);
    store.setLastRun(null);
    store.setLastRunId(null);
    const trimmed = items.slice(0, lastUserIndex + 1);
    baseItemsRef.current = trimmed;
    store.setItems(trimmed);
    if (
      historyPrefix !== null &&
      historyPrefix.conversationId === conversationId &&
      historyPrefix.count > lastUserIndex
    ) {
      setHistoryPrefix(trimHistoryPrefix(historyPrefix));
    }
    startedAtRef.current = Date.now();
    dispatchPhase({ type: 'submit', startedAt: startedAtRef.current });
    try {
      const accepted = await api.regenerate(conversationId);
      if (!ownsRequest()) return;
      regenerateSnapshotRef.current = { ...snapshot, runId: accepted.runId };
      const promptIndex = baseItemsRef.current.findLastIndex((item) => item.kind === 'user');
      const basePrompt = promptIndex < 0 ? undefined : baseItemsRef.current[promptIndex];
      if (basePrompt?.kind === 'user') {
        const prompt: ChatItem = { ...basePrompt, runId: accepted.runId };
        baseItemsRef.current = replaceLastUser(baseItemsRef.current, prompt);
        useChatStore.getState().setItems((previous) => replaceLastUser(previous, prompt));
      }
      store.setLastRunId(accepted.runId);
      hydratedRef.current = accepted.conversationId;
      dispatchPhase({ type: 'accept', runId: accepted.runId, startedAt: startedAtRef.current });
      void client.invalidateQueries({ queryKey: chatKeys.conversations() });
      openStream(accepted, generation);
    } catch (error) {
      if (!ownsRequest()) return;
      regenerateSnapshotRef.current = null;
      setRegenerating(false);
      restoreRegenerate(snapshot);
      void client.invalidateQueries({ queryKey: chatKeys.conversation(conversationId) });
      toastError(error);
    }
  };

  const reconcileRun = useCallback(
    async (detail: RunDetail['run']) => {
      const store = useChatStore.getState();
      const current = store.phase;
      if (!mountedRef.current || !isActivePhase(current) || current.runId !== detail.id) return;
      if (detail.status === 'queued' || detail.status === 'running') return;
      if (current.kind === 'streaming' && detail.status !== 'cancelled') return;
      if (recoveryRef.current !== null) return;
      const regenerateSnapshot = regenerateSnapshotRef.current;
      closeStream();
      const generation = generationRef.current;
      recoveryRef.current = generation;
      const ownsRecovery = () => {
        const phase = useChatStore.getState().phase;
        return (
          mountedRef.current &&
          generationRef.current === generation &&
          useChatStore.getState().conversationId === detail.conversationId &&
          isActivePhase(phase) &&
          phase.runId === current.runId
        );
      };
      try {
        const { messages } = await loadRunMessages(detail.conversationId, current.runId);
        if (!ownsRecovery()) return;
        if (
          regenerateSnapshot !== null &&
          regenerateSnapshot.runId === current.runId &&
          messages.length === 0
        ) {
          restoreRegenerate(regenerateSnapshot);
          recoveryRef.current = null;
          hydratedRef.current = detail.conversationId;
          void client.invalidateQueries({
            queryKey: chatKeys.conversation(detail.conversationId),
          });
          return;
        }
        const loaded = useChatStore.getState().items;
        const promptIndex = loaded.findLastIndex(
          (item) => item.kind === 'user' && item.runId === current.runId,
        );
        const prefix = promptIndex < 0 ? [] : loaded.slice(0, promptIndex);
        const items = [...prefix, ...historyToItems(messages)];
        useChatStore.getState().setItems(items);
        setHistoryPrefix((previous) => {
          if (previous !== null && previous.conversationId !== detail.conversationId)
            return previous;
          const covered =
            previous === null
              ? promptIndex === 0
              : promptIndex === previous.count - 1 || promptIndex === previous.count;
          if (!covered) return previous;
          const merged = uniqueMessages([
            ...(previous?.messages.filter((message) => message.runId !== current.runId) ?? []),
            ...messages,
          ]);
          return {
            conversationId: detail.conversationId,
            boundaryId: merged.at(-1)?.id ?? null,
            messages: merged,
            count: items.length,
          };
        });
      } catch (error) {
        if (!ownsRecovery()) return;
        toastError(new Error(`未能恢复完整会话，请重新打开会话重试：${errorMessage(error)}`));
      }
      if (!ownsRecovery()) return;
      recoveryRef.current = null;
      hydratedRef.current = detail.conversationId;
      const finished = { type: 'run_finished', status: detail.status } as const;
      store.setItems((items) => applyEvent(items, finished));
      dispatchPhase({ type: 'finish' });
      const durationMs = detail.latencyMs ?? Date.now() - current.startedAt;
      const tokens =
        detail.inputTokens === null && detail.outputTokens === null
          ? null
          : (detail.inputTokens ?? 0) + (detail.outputTokens ?? 0);
      const costUsd = detail.costUsd === null ? null : Number(detail.costUsd);
      store.setLastRun({
        runId: detail.id,
        status: detail.status,
        durationMs,
        ...(detail.turns === null ? {} : { turns: detail.turns }),
        ...(tokens === null ? {} : { tokens }),
        ...(costUsd === null ? {} : { costUsd }),
        ...(detail.error === null ? {} : { error: detail.error }),
      });
      cacheRunMetrics(client, detail.conversationId, {
        runId: detail.id,
        status: detail.status,
        turns: detail.turns,
        durationMs,
        tokens,
        costUsd,
        error: detail.error,
        endedAt: detail.endedAt,
      });
      void client.invalidateQueries({ queryKey: chatKeys.conversations() });
      void client.invalidateQueries({
        queryKey: chatKeys.outputs(detail.conversationId),
      });
    },
    [closeStream, client, restoreRegenerate],
  );

  const retryStream = () => {
    const { phase, conversationId } = useChatStore.getState();
    if (
      !conversationId ||
      !isActivePhase(phase) ||
      phase.kind !== 'detached' ||
      !mountedRef.current ||
      recoveryRef.current !== null
    )
      return;
    useChatStore.getState().setItems(baseItemsRef.current);
    dispatchPhase({
      type: 'retry',
      runId: phase.runId,
      attempt: 1,
      startedAt: phase.startedAt,
    });
    openStream({ runId: phase.runId, conversationId }, generationRef.current, 1);
  };

  return {
    send,
    regenerate,
    regenerating,
    closeStream,
    resetWorkspace,
    captureRequest,
    hydratedRef,
    reconcileRun,
    retryStream,
    historyPrefix,
    setHistoryPrefix,
  };
}
