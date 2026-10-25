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

interface ChatWorkspaceState {
  conversationId: string | null;
  items: ChatItem[];
  input: string;
  run: RunState | null;
  lastRun: RunMetrics | null;
  /** 审批针对产生错误的 run；run_finished 后 run 会被清空，所以单独保留 id。 */
  lastRunId: string | null;
  historyOpen: boolean;
  setConversationId: (conversationId: string | null) => void;
  setItems: (items: ChatItem[] | ((previous: ChatItem[]) => ChatItem[])) => void;
  setInput: (input: string) => void;
  setRun: (run: RunState | null | ((previous: RunState | null) => RunState | null)) => void;
  setLastRun: (run: RunMetrics | null) => void;
  setLastRunId: (runId: string | null) => void;
  setHistoryOpen: (open: boolean) => void;
  /** 切换会话：清空消息与本轮运行结果。输入框内容保留。 */
  resetConversation: (conversationId: string | null) => void;
  reset: () => void;
}

const initial = {
  conversationId: null,
  items: [] as ChatItem[],
  input: '',
  run: null,
  lastRun: null,
  lastRunId: null,
  historyOpen: false,
};

export const useChatStore = create<ChatWorkspaceState>()((set) => ({
  ...initial,
  setConversationId: (conversationId) => set({ conversationId }),
  setItems: (items) =>
    set((state) => ({
      items: typeof items === 'function' ? items(state.items) : items,
    })),
  setInput: (input) => set({ input }),
  setRun: (run) =>
    set((state) => ({
      run: typeof run === 'function' ? run(state.run) : run,
    })),
  setLastRun: (lastRun) => set({ lastRun }),
  setLastRunId: (lastRunId) => set({ lastRunId }),
  setHistoryOpen: (historyOpen) => set({ historyOpen }),
  resetConversation: (conversationId) =>
    set({ conversationId, items: [], run: null, lastRun: null, lastRunId: null }),
  reset: () => set(initial),
}));
