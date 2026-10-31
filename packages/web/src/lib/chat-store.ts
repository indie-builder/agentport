import type { OutputRef } from '@agentport/shared';
import { create } from 'zustand';
import type { ChatItem } from './chat-state.js';

export type RunOutcome = 'succeeded' | 'failed' | 'cancelled' | 'timeout';

export interface RunState {
  runId: string;
  conversationId: string;
  /**
   * queued：已提交、还没拿到 runId；此时没有可停止的对象。
   * reconnecting：已拿到 runId，但事件流尚未打开或中断后正在重试，仍需轮询回读。
   * streaming：EventSource 已 onopen 且没有已知协议错误；只表示连接当前健康。
   * detached：服务端明确报错或重试耗尽，保留 runId 供停止/重连，继续轮询回读终态。
   */
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
/** 草稿归属的业务人员；只在身份确认后写入，用于阻止换账户后串稿。 */
const OWNER_KEY = `${DRAFTS_KEY}.owner`;
const draftKey = (conversationId: string | null): string => conversationId ?? '';

// sessionStorage 不可用时仍能在本次页面生命周期内判断草稿归属。
let memoryOwner: string | null = null;

function readOwner(): string | null {
  try {
    return sessionStorage.getItem(OWNER_KEY) ?? memoryOwner;
  } catch {
    return memoryOwner;
  }
}

function writeOwner(businessId: string): void {
  memoryOwner = businessId;
  try {
    sessionStorage.setItem(OWNER_KEY, businessId);
  } catch {
    // 存储不可写时保留进程内归属，刷新后不猜测属于谁。
  }
}

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
  /**
   * 账户级 reset 的同步信号。聊天页在身份切换/显式退出时可能仍挂载，
   * 事件流据此立即关闭旧 EventSource 与重试计时器。
   */
  accountEpoch: number;
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
  accountEpoch: 0,
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
    memoryOwner = null;
    try {
      sessionStorage.removeItem(DRAFTS_KEY);
      sessionStorage.removeItem(OWNER_KEY);
    } catch {
      // 存储不可写时没有草稿需要清理。
    }
    set((state) => ({ ...initial, input: '', accountEpoch: state.accountEpoch + 1 }));
  },
}));

/**
 * 把聊天状态绑定到刚确认的业务身份。同一个人重复确认不清稿；
 * 换人或身份缺失时先清掉内存与草稿，再记录新归属。
 */
export function bindChatIdentity(businessId: string): void {
  if (readOwner() === businessId) return;
  useChatStore.getState().reset();
  writeOwner(businessId);
}
