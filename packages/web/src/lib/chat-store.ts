import type { OutputRef } from '@agentport/shared';
import { create } from 'zustand';
import type { ChatItem } from './chat-state.js';

export type RunOutcome = 'succeeded' | 'failed' | 'cancelled' | 'timeout';

export interface RunState {
  runId: string;
  conversationId: string;
  /** queued：已提交、还没拿到 runId；此时没有可停止的对象。 */
  status: 'queued' | 'streaming' | 'reconnecting' | 'detached';
  startedAt: number;
}

export interface RunMetrics {
  runId: string;
  status: RunOutcome;
  turns?: number;
  durationMs?: number;
  tokens?: number;
  costUsd?: number;
  error?: string;
  /** 结束时刻（历史轮次才有）；用作读数行的完整时间提示。 */
  endedAt?: string;
}

/** 未发送草稿按会话分槽；新会话用空字符串当键。 */
const DRAFTS_KEY = 'pace.chat.drafts';
const draftKey = (conversationId: string | null): string => conversationId ?? '';

function readDrafts(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(DRAFTS_KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

function readDraft(conversationId: string | null): string {
  return readDrafts()[draftKey(conversationId)] ?? '';
}

function writeDraft(conversationId: string | null, input: string): void {
  const drafts = readDrafts();
  const key = draftKey(conversationId);
  if (input) drafts[key] = input;
  else delete drafts[key];
  try {
    if (Object.keys(drafts).length === 0) sessionStorage.removeItem(DRAFTS_KEY);
    else sessionStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // 存储不可写时草稿只在当前页面生效。
  }
}

interface ChatWorkspaceState {
  conversationId: string | null;
  items: ChatItem[];
  input: string;
  run: RunState | null;
  lastRun: RunMetrics | null;
  /** 审批针对产生错误的 run；run_finished 后 run 会被清空，所以单独保留 id。 */
  lastRunId: string | null;
  /** 「基于此版本修改」选中的成果；随下次发送一次性带走，切会话不保留。 */
  outputRef: OutputRef | null;
  /** 待发送资料；只在内存里，随本次发送消费，切会话/专家不串带。 */
  pendingAttachments: File[];
  historyOpen: boolean;
  setConversationId: (conversationId: string | null) => void;
  setItems: (items: ChatItem[] | ((previous: ChatItem[]) => ChatItem[])) => void;
  setInput: (input: string, persist?: boolean) => void;
  /**
   * 发送被接受时清掉原槽：只有槽里仍是这次发出的原文才清，
   * 等待期间写的新稿不能被误清。只动存储，不碰 Zustand 状态。
   */
  clearDraft: (conversationId: string | null, expectedInput: string) => void;
  setRun: (run: RunState | null | ((previous: RunState | null) => RunState | null)) => void;
  setLastRun: (run: RunMetrics | null) => void;
  setLastRunId: (runId: string | null) => void;
  setOutputRef: (ref: OutputRef | null) => void;
  setPendingAttachments: (files: File[]) => void;
  setHistoryOpen: (open: boolean) => void;
  /**
   * 切换会话：清空消息与本轮运行结果，并载入目标会话自己的草稿。
   * carryInput 用于切换专家：把当前草稿带到新会话的空槽。
   */
  resetConversation: (conversationId: string | null, carryInput?: boolean) => void;
  reset: () => void;
}

const initial = {
  conversationId: null,
  items: [] as ChatItem[],
  run: null,
  lastRun: null,
  lastRunId: null,
  outputRef: null,
  pendingAttachments: [] as File[],
  historyOpen: false,
};

export const useChatStore = create<ChatWorkspaceState>()((set) => ({
  ...initial,
  // 新会话的草稿在模块初始化时恢复；已有会话由 resetConversation 按 URL 载入。
  input: readDraft(null),
  setConversationId: (conversationId) =>
    set((state) => {
      // 发送被接受前用户又写了新草稿：把它从空槽挪到刚创建的会话。
      if (state.conversationId === null && conversationId !== null) {
        const pending = readDraft(null);
        if (pending) {
          writeDraft(conversationId, pending);
          writeDraft(null, '');
        }
      }
      return {
        conversationId,
        // 换到另一个已有会话才清空未发送资料；新会话首次落 URL 是接受发送的结果，交给发送方按身份清理。
        ...(state.conversationId !== null && state.conversationId !== conversationId
          ? { pendingAttachments: [] }
          : {}),
      };
    }),
  setItems: (items) =>
    set((state) => ({
      items: typeof items === 'function' ? items(state.items) : items,
    })),
  setInput: (input, persist = true) =>
    set((state) => {
      if (persist) writeDraft(state.conversationId, input);
      return { input };
    }),
  clearDraft: (conversationId, expectedInput) => {
    if (readDraft(conversationId) === expectedInput) writeDraft(conversationId, '');
  },
  setRun: (run) =>
    set((state) => ({
      run: typeof run === 'function' ? run(state.run) : run,
    })),
  setLastRun: (lastRun) => set({ lastRun }),
  setLastRunId: (lastRunId) => set({ lastRunId }),
  setOutputRef: (outputRef) => set({ outputRef }),
  setPendingAttachments: (pendingAttachments) => set({ pendingAttachments }),
  setHistoryOpen: (historyOpen) => set({ historyOpen }),
  resetConversation: (conversationId, carryInput = false) =>
    set((state) => {
      // 同槽切换（新会话间换专家）时槽里可能是等待被接受的原稿，不能被清空的输入框覆盖。
      if (carryInput && state.conversationId !== conversationId) {
        writeDraft(conversationId, state.input);
      }
      return {
        conversationId,
        input: readDraft(conversationId),
        items: [],
        run: null,
        lastRun: null,
        lastRunId: null,
        outputRef: null,
        pendingAttachments: [],
      };
    }),
  reset: () => {
    try {
      sessionStorage.removeItem(DRAFTS_KEY);
    } catch {
      // 存储不可写时没有草稿需要清理。
    }
    set({ ...initial, input: '' });
  },
}));
