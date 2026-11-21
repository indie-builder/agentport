import type { OutputRef, TerminalRunStatus } from '@agentport/shared';
import { create } from 'zustand';
import type { ChatItem } from './chat-state.js';

export type RunOutcome = TerminalRunStatus;

export type ChatPhase =
  | { kind: 'idle' }
  | { kind: 'submitting'; startedAt: number }
  | { kind: 'connecting'; runId: string; attempt: number; startedAt: number }
  | { kind: 'streaming'; runId: string; startedAt: number }
  | { kind: 'recovering'; runId: string; startedAt: number }
  | {
      kind: 'detached';
      runId: string;
      reason: 'protocol' | 'retries' | 'history';
      startedAt: number;
    };

export type ActiveChatPhase = Exclude<ChatPhase, { kind: 'idle' } | { kind: 'submitting' }>;

export type LiveChatPhase = Exclude<ChatPhase, { kind: 'idle' }>;

export function isActivePhase(phase: ChatPhase): phase is ActiveChatPhase {
  return phase.kind !== 'idle' && phase.kind !== 'submitting';
}

export type ChatPhaseEvent =
  | { type: 'submit'; startedAt: number }
  | { type: 'accept'; runId: string; startedAt: number; attempt?: number }
  | { type: 'open' }
  | { type: 'error' }
  | { type: 'retry'; runId: string; attempt: number; startedAt: number }
  | { type: 'recoveryStart' }
  | {
      type: 'detached';
      runId: string;
      reason: 'protocol' | 'retries' | 'history';
      startedAt: number;
    }
  | { type: 'finish' };

export function advancePhase(phase: ChatPhase, event: ChatPhaseEvent): ChatPhase {
  switch (event.type) {
    case 'submit':
      return { kind: 'submitting', startedAt: event.startedAt };
    case 'accept':
      return {
        kind: 'connecting',
        runId: event.runId,
        attempt: event.attempt ?? 0,
        startedAt: event.startedAt,
      };
    case 'open':
      return phase.kind === 'connecting'
        ? { kind: 'streaming', runId: phase.runId, startedAt: phase.startedAt }
        : phase;
    case 'error':
      return isActivePhase(phase)
        ? { kind: 'detached', runId: phase.runId, reason: 'protocol', startedAt: phase.startedAt }
        : phase;
    case 'retry':
      return isActivePhase(phase)
        ? {
            kind: 'connecting',
            runId: event.runId,
            attempt: event.attempt,
            startedAt: event.startedAt,
          }
        : phase;
    case 'recoveryStart':
      return isActivePhase(phase)
        ? { kind: 'recovering', runId: phase.runId, startedAt: phase.startedAt }
        : phase;
    case 'detached':
      return {
        kind: 'detached',
        runId: event.runId,
        reason: event.reason,
        startedAt: event.startedAt,
      };
    case 'finish':
      return { kind: 'idle' };
  }
}

export interface RunMetrics {
  runId: string;
  status: RunOutcome;
  turns?: number;
  durationMs?: number;
  tokens?: number;
  costUsd?: number;
  error?: string;
  endedAt?: string;
}

const DRAFTS_KEY = 'pace.chat.drafts';
const OWNER_KEY = `${DRAFTS_KEY}.owner`;
const draftKey = (conversationId: string | null): string => conversationId ?? '';

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
  } catch {}
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
  } catch {}
}

interface ChatWorkspaceState {
  conversationId: string | null;
  items: ChatItem[];
  input: string;
  phase: ChatPhase;
  lastRun: RunMetrics | null;
  lastRunId: string | null;
  outputRef: OutputRef | null;
  pendingAttachments: File[];
  historyOpen: boolean;
  accountEpoch: number;
  setConversationId: (conversationId: string | null) => void;
  setItems: (items: ChatItem[] | ((previous: ChatItem[]) => ChatItem[])) => void;
  setInput: (input: string, persist?: boolean) => void;
  clearDraft: (conversationId: string | null, expectedInput: string) => void;
  setPhase: (phase: ChatPhase) => void;
  setLastRun: (run: RunMetrics | null) => void;
  setLastRunId: (runId: string | null) => void;
  setOutputRef: (ref: OutputRef | null) => void;
  setPendingAttachments: (files: File[]) => void;
  setHistoryOpen: (open: boolean) => void;
  resetConversation: (conversationId: string | null, carryInput?: boolean) => void;
  reset: () => void;
}

const initial = {
  conversationId: null,
  items: [] as ChatItem[],
  phase: { kind: 'idle' } as ChatPhase,
  lastRun: null,
  lastRunId: null,
  outputRef: null,
  pendingAttachments: [] as File[],
  historyOpen: false,
};

export const useChatStore = create<ChatWorkspaceState>()((set) => ({
  ...initial,
  accountEpoch: 0,
  input: readDraft(null),
  setConversationId: (conversationId) =>
    set((state) => {
      if (state.conversationId === null && conversationId !== null) {
        const pending = readDraft(null);
        if (pending) {
          writeDraft(conversationId, pending);
          writeDraft(null, '');
        }
      }
      return {
        conversationId,
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
  setPhase: (phase) => set({ phase }),
  setLastRun: (lastRun) => set({ lastRun }),
  setLastRunId: (lastRunId) => set({ lastRunId }),
  setOutputRef: (outputRef) => set({ outputRef }),
  setPendingAttachments: (pendingAttachments) => set({ pendingAttachments }),
  setHistoryOpen: (historyOpen) => set({ historyOpen }),
  resetConversation: (conversationId, carryInput = false) =>
    set((state) => {
      if (carryInput && state.conversationId !== conversationId) {
        writeDraft(conversationId, state.input);
      }
      return {
        conversationId,
        input: readDraft(conversationId),
        items: [],
        phase: { kind: 'idle' },
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
    } catch {}
    set((state) => ({ ...initial, input: '', accountEpoch: state.accountEpoch + 1 }));
  },
}));

export function bindChatIdentity(businessId: string): void {
  if (readOwner() === businessId) return;
  useChatStore.getState().reset();
  writeOwner(businessId);
}
