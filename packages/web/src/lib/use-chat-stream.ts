import {
  attachmentMimeForFilename,
  type ChatEvent,
  type ChatRequest,
  type ConversationMessage,
  type ConversationRunMetrics,
  chatEventSchema,
} from '@agentport/shared';
import type { InfiniteData, QueryClient, UseQueryResult } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type ChatAccepted,
  type ChatAttachmentInput,
  type ConversationDetail,
  errorMessage,
  type RunDetail,
} from './api.js';
import {
  applyEvent,
  attachmentDownloadUrl,
  type ChatItem,
  type HistorySnapshot,
  historyToItems,
  snapshotHistory,
} from './chat-state.js';
import { useChatStore } from './chat-store.js';
import {
  type RunQuestionList,
  runQuery,
  runQuestionsQueryKey,
  withRunQuestion,
} from './queries.js';
import { toastError } from './toast.js';

/** 终态事件里的落库块：按运行内稳定 id 对齐实时文本。 */
type PersistedBlock = NonNullable<
  Extract<ChatEvent, { type: 'run_finished' }>['messageIds']
>[number];

/** 已保存消息的分页上限；一个 run 的输出再多也不无限拉历史。 */
const RECOVERY_PAGE_SIZE = 100;
const RECOVERY_MAX_PAGES = 10;

/** FileReader 给出 data URL；请求体只收裸 base64，不把 data: 前缀发给服务端。 */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error(`无法读取「${file.name}」`));
        return;
      }
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取「${file.name}」`));
    reader.readAsDataURL(file);
  });
}

/**
 * 按 `runId` 翻到本 run 的第一条消息。消息按时间正序、同一 run 连续，
 * 所以遇到别的 run（或没有更早页）就说明本 run 已完整。
 */
async function loadRunMessages(
  conversationId: string,
  runId: string,
): Promise<ConversationMessage[]> {
  let before: string | undefined;
  let messages: ConversationMessage[] = [];
  for (let page = 0; page < RECOVERY_MAX_PAGES; page += 1) {
    const detail = await api.conversation(conversationId, {
      limit: RECOVERY_PAGE_SIZE,
      ...(before === undefined ? {} : { before }),
    });
    if (detail.conversation.id !== conversationId) {
      throw new Error('会话历史不匹配，请重新打开会话');
    }
    messages = [...detail.messages.filter((message) => message.runId === runId), ...messages];
    const oldest = detail.messages[0];
    // 本 run 从它自己的用户消息开始；遇到别的 run 或用户消息即已完整。
    const complete = oldest === undefined || oldest.runId !== runId || oldest.role === 'user';
    if (complete || detail.nextBefore == null) return messages;
    before = detail.nextBefore;
  }
  throw new Error('本轮输出超出可恢复范围，请刷新后查看会话历史');
}

/**
 * 终态读数并进会话详情缓存：下一次发送会清空 lastRun，
 * 旧轮只能靠这份既有缓存按 runId 继续显示结果与失败原因。
 */
function cacheRunMetrics(
  client: QueryClient,
  conversationId: string,
  metric: ConversationRunMetrics,
): void {
  client.setQueryData<InfiniteData<ConversationDetail>>(
    ['conversation', conversationId],
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

/**
 * 把落库块回填到实时文本：优先按运行内稳定 `streamBlockId` 精确对齐，
 * 不能只用 `blockIndex`（同一条 SDK 消息的后续消息会重用它）。
 * 旧版事件没有稳定 id 时退回 `blockIndex + parent` 的队列，按输出顺序配对。
 */
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
  // 没有稳定 id 的旧事件：同块序号、同父调用的落库块与实时项数量一致时，
  // 才按各自输出顺序一一配对；数量对不上说明中间还有没看到的块，不猜测。
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

  // 账户级 reset 发生时聊天页可能还挂着：同步关流并作废旧 generation，
  // 晚到的发送/恢复/事件回调就不能再写回新账户的状态。
  useEffect(
    () =>
      useChatStore.subscribe((state, previous) => {
        if (state.accountEpoch !== previous.accountEpoch) closeStream();
      }),
    [closeStream],
  );

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
      // 用真实会话消息取 id 与 canonical：运行详情的步骤是合成 id，也没有块与 UI 快照。
      const messages = await loadRunMessages(accepted.conversationId, accepted.runId);
      if (generation !== generationRef.current) return;
      const store = useChatStore.getState();
      if (store.conversationId !== accepted.conversationId) return;
      if (store.run !== null || store.lastRunId !== accepted.runId) return;
      // 已加载的历史（含分页）保持不动；base 的最后一项永远是本轮用户气泡。
      const prompt = baseItemsRef.current.at(-1);
      if (!prompt) return;
      const promptIndex = store.items.indexOf(prompt);
      if (promptIndex < 0) return;
      if (!messages.some((message) => message.role !== 'user')) {
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
      const tail = historyToItems(messages);
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
        if (event.type === 'question_updated') {
          // 回答状态只进 Query 缓存：卡片按 run+requestId 读它，SSE 迟到也不会写进别的会话。
          client.setQueryData<RunQuestionList>(
            runQuestionsQueryKey(event.question.runId),
            (previous) => ({ items: withRunQuestion(previous?.items, event.question) }),
          );
          return;
        }
        if (event.type === 'error') {
          errored = true;
          // 协议 error 立即失去健康资格，回读轮询接替；连接清理仍交给 onerror。
          store.setRun((current) =>
            current?.runId === accepted.runId ? { ...current, status: 'detached' } : current,
          );
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
          void client.invalidateQueries({
            queryKey: ['conversation-outputs', accepted.conversationId],
          });
          void client.invalidateQueries({ queryKey: ['conversations'] });
          return;
        }
        if (event.type === 'run_finished') {
          finished = true;
          closeStream();
          store.setRun(null);
          // 本轮回复落库后都带同一个 run_id；补到流式项上，下一轮开始后它也能按 id 取读数。
          // 按稳定块身份回填消息 id 与 canonical 快照：表单状态与 Query/Mutation 都要用它定位消息。
          store.setItems((previous) => {
            const userIndex = previous.findLastIndex((item) => item.kind === 'user');
            // 没有用户项时无从判断本轮起点，宁可什么都不补，也不能给整段历史打上本轮 id。
            if (userIndex < 0) return previous;
            const matched = matchPersistedBlocks(previous, userIndex, event.messageIds ?? []);
            // 下一轮开始后 Query 只跟新 run：把本轮提问终态落到工具项，历史卡片仍显示已回答/已关闭。
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
              // 普通消息仍补本轮 runId；没有匹配块时保持原有行为，只补 runId。
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
            queryKey: ['conversation', accepted.conversationId],
          });
          void client.invalidateQueries({
            queryKey: ['conversation-outputs', accepted.conversationId],
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
        // 与 useRun 共用 ['run', id] 缓存；恢复时必须读最新状态，不能拿旧缓存判定运行已结束。
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
    client,
  ]);

  /**
   * `text` 是显式正文（组件动作由按钮文案给出）；省略时才读输入框。
   * 动作发送不能先 `setInput` 再发送：那样会覆盖用户没发出的草稿。
   */
  const send = async (text?: string, action?: ChatRequest['openuiAction']): Promise<void> => {
    const store = useChatStore.getState();
    const { input, items, run, conversationId } = store;
    const outputRef = text === undefined ? store.outputRef : null;
    // 附件只随用户编辑的那次发送消费；组件动作不带走输入框里未发送的资料。
    const attachments = text === undefined ? store.pendingAttachments : [];
    const body = (text ?? input).trim();
    if (!mountedRef.current || (!body && attachments.length === 0) || !agentId || run) return;
    if (conversationId !== null && hydratedRef.current !== conversationId) return;
    const generation = ++generationRef.current;
    const ownsRequest = () => mountedRef.current && generationRef.current === generation;
    replayTruncatedRef.current = false;
    // 只有显式读输入框的那一次才清空；动作发送不碰草稿。
    // 原槽先留着这次发送的原文，等请求被接受再清，等待期间切走/刷新都不丢稿。
    if (text === undefined) store.setInput('', false);
    store.setLastRun(null);
    store.setLastRunId(null);
    // base 必须包含刚追加的用户气泡：重连会整体回放事件，不能把它丢掉。
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
    store.setRun({
      runId: '',
      conversationId: conversationId ?? '',
      status: 'queued',
      startedAt: startedAtRef.current,
    });
    try {
      // 读数在提交前完成：请求体只带 base64，不带 File 对象或 data: 前缀。
      // 没有附件时不插队等微任务，保持普通文本发送仍在当前 tick 内提交。
      const payload: ChatAttachmentInput[] =
        attachments.length > 0
          ? await Promise.all(
              attachments.map(async (file) => ({
                filename: file.name,
                dataBase64: await readBase64(file),
              })),
            )
          : [];
      // 读取期间切会话/专家/新建已让本轮失效：不再上传，也不发起旧请求。
      if (!ownsRequest()) return;
      const accepted = await api.sendChat({
        agentId,
        message: body,
        ...(conversationId ? { conversationId } : {}),
        ...(action ? { openuiAction: action } : {}),
        ...(payload.length > 0 ? { attachments: payload } : {}),
        // 引用只跟随用户自己发送的正文；组件动作不带走未发出的引用。
        ...(outputRef ? { output: outputRef } : {}),
      });
      if (!ownsRequest()) return;
      if (text === undefined && useChatStore.getState().input === '') {
        store.clearDraft(conversationId, input);
      }
      store.setConversationId(accepted.conversationId);
      // base 与 store 必须共用同一个用户项：截断恢复按引用从 store 里定位本轮起点。
      const baseIndex = baseItemsRef.current.findLastIndex((item) => item.kind === 'user');
      const basePrompt = baseIndex < 0 ? undefined : baseItemsRef.current[baseIndex];
      if (basePrompt?.kind === 'user') {
        // 用服务端落库的元数据替换乐观项附件，只补 id 与下载地址，不重建消息。
        const serverAttachments = accepted.attachments?.map(({ id, filename, mimeType, size }) => ({
          id,
          filename,
          mimeType,
          size,
          downloadUrl: attachmentDownloadUrl(accepted.conversationId, id),
        }));
        // 用户气泡从接受起就归属本轮：没有助手输出时，终态读数由它承载。
        const prompt: ChatItem = {
          ...basePrompt,
          runId: accepted.runId,
          ...(serverAttachments === undefined ? {} : { attachments: serverAttachments }),
        };
        const replacePrompt = (list: ChatItem[]): ChatItem[] => {
          const index = list.findLastIndex((item) => item.kind === 'user');
          return index < 0
            ? list
            : list.map((item, position) => (position === index ? prompt : item));
        };
        baseItemsRef.current = replacePrompt(baseItemsRef.current);
        useChatStore.getState().setItems(replacePrompt);
      }
      store.setLastRunId(accepted.runId);
      // 只消费本次发送的引用；等待期间重新挂的引用留给下一次，失败时也保留。
      if (outputRef && useChatStore.getState().outputRef === outputRef) store.setOutputRef(null);
      // 只清本次选中的资料；等待期间改选的新数组必须保留。
      if (attachments.length > 0 && useChatStore.getState().pendingAttachments === attachments) {
        store.setPendingAttachments([]);
      }
      hydratedRef.current = accepted.conversationId;
      // 事件流尚未 onopen；先按重连状态继续回读，onopen 才标记健康。
      store.setRun({ ...accepted, status: 'reconnecting', startedAt: startedAtRef.current });
      onAccepted(accepted, body);
      void client.invalidateQueries({ queryKey: ['conversations', agentId] });
      openStream(accepted, generation);
    } catch (error) {
      if (!ownsRequest()) return;
      // 等待期间可能已经输入了新草稿；读最新 store，只有输入框仍为空才回填原消息。
      const latest = useChatStore.getState();
      latest.setRun(null);
      // 动作发送没有动过草稿，失败时也不回填按钮文案；恢复原文而不带 trim。
      if (text === undefined && latest.input === '') latest.setInput(input);
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
      // 恢复同样把终态读数并进缓存：下一次发送清空 lastRun 后，旧轮仍保留结果。
      cacheRunMetrics(client, current.conversationId, {
        runId: detail.id,
        status: detail.status,
        turns: detail.turns,
        durationMs,
        tokens,
        costUsd,
        error: detail.error,
        endedAt: detail.endedAt,
      });
      void client.invalidateQueries({ queryKey: ['conversations', agentId] });
      void client.invalidateQueries({
        queryKey: ['conversation-outputs', current.conversationId],
      });
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
