import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.js';
import { useChatStore } from '../src/lib/chat-store.js';
import * as queries from '../src/lib/queries.js';

vi.mock('../src/lib/api.js', async (original) => {
  const actual = await original<typeof import('../src/lib/api.js')>();
  return { ...actual, api: { ...actual.api, me: vi.fn(), logout: vi.fn() } };
});

const DRAFTS_KEY = 'pace.chat.drafts';

function authenticated(businessId: string, username = businessId) {
  return {
    authenticated: true as const,
    user: { businessId, username, name: username },
    roles: [],
    grants: [],
  };
}

function savedDrafts(): Record<string, string> {
  return JSON.parse(sessionStorage.getItem(DRAFTS_KEY) ?? '{}') as Record<string, string>;
}

async function confirmIdentity(businessId: string) {
  vi.mocked(api.me).mockResolvedValueOnce(authenticated(businessId));
  await queries.queryClient.fetchQuery({ ...queries.meQuery, staleTime: 0 });
}

function seedChatState() {
  sessionStorage.setItem(
    DRAFTS_KEY,
    JSON.stringify({ '': 'A welcome', 'conversation-a': 'A existing' }),
  );
  useChatStore.setState({
    conversationId: 'conversation-a',
    input: 'A existing',
    items: [{ kind: 'user', text: 'A message' }],
    run: {
      runId: 'run-a',
      conversationId: 'conversation-a',
      status: 'detached',
      startedAt: 1,
    },
    lastRun: { runId: 'run-a', status: 'failed', durationMs: 1 },
    lastRunId: 'run-a',
    outputRef: { runId: 'run-a', path: 'report.md' },
    pendingAttachments: [new File(['data'], 'a.txt')],
    historyOpen: true,
  });
  sessionStorage.setItem('unrelated', 'keep');
}

beforeEach(() => {
  vi.restoreAllMocks();
  queries.queryClient.setDefaultOptions({
    queries: { retry: false, refetchOnWindowFocus: false },
  });
  queries.queryClient.clear();
  useChatStore.getState().reset();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  queries.queryClient.clear();
  useChatStore.getState().reset();
  sessionStorage.clear();
});

describe('chat account ownership', () => {
  it('clears an unowned legacy draft when a confirmed identity binds', async () => {
    useChatStore.getState().setInput('legacy draft');
    sessionStorage.setItem('unrelated', 'keep');

    await confirmIdentity('business-a');

    expect(savedDrafts()).toEqual({});
    expect(useChatStore.getState().input).toBe('');
    expect(sessionStorage.getItem('unrelated')).toBe('keep');
  });

  it('clears every previous account draft and chat state only after the next identity is confirmed', async () => {
    await confirmIdentity('business-a');
    seedChatState();

    // 身份尚未确认：不能提前删除 A 的稿子。
    expect(savedDrafts()).toEqual({ '': 'A welcome', 'conversation-a': 'A existing' });

    await confirmIdentity('business-b');

    expect(savedDrafts()).toEqual({});
    expect(useChatStore.getState()).toMatchObject({
      conversationId: null,
      input: '',
      items: [],
      run: null,
      lastRun: null,
      lastRunId: null,
      outputRef: null,
      pendingAttachments: [],
      historyOpen: false,
    });
    expect(sessionStorage.getItem('unrelated')).toBe('keep');
  });

  it('keeps the same account draft across repeated /me refreshes', async () => {
    await confirmIdentity('business-a');
    seedChatState();

    await confirmIdentity('business-a');
    await confirmIdentity('business-a');

    expect(savedDrafts()).toEqual({ '': 'A welcome', 'conversation-a': 'A existing' });
    expect(useChatStore.getState().input).toBe('A existing');
  });

  it('keeps the same account draft across a fresh module load', async () => {
    await confirmIdentity('business-a');
    useChatStore.getState().setInput('A reload draft');

    vi.resetModules();
    const freshStore = await import('../src/lib/chat-store.js');
    const freshQueries = await import('../src/lib/queries.js');
    vi.mocked(api.me).mockResolvedValueOnce(authenticated('business-a'));
    await freshQueries.queryClient.fetchQuery({
      ...freshQueries.meQuery,
      staleTime: 0,
    });

    expect(freshStore.useChatStore.getState().input).toBe('A reload draft');
    expect(savedDrafts()).toEqual({ '': 'A reload draft' });
  });

  it('keeps the same account draft after the password-change query clear', async () => {
    await confirmIdentity('business-a');
    seedChatState();

    queries.clearSessionQueries();
    await confirmIdentity('business-a');

    expect(savedDrafts()).toEqual({ '': 'A welcome', 'conversation-a': 'A existing' });
    expect(useChatStore.getState().input).toBe('A existing');
  });

  it('does not delete or bind drafts while /me is unauthenticated', async () => {
    useChatStore.getState().setInput('unconfirmed draft');
    sessionStorage.setItem('unrelated', 'keep');
    vi.mocked(api.me).mockResolvedValueOnce({ authenticated: false });

    await queries.queryClient.fetchQuery({ ...queries.meQuery, staleTime: 0 });

    expect(savedDrafts()).toEqual({ '': 'unconfirmed draft' });
    expect(useChatStore.getState().input).toBe('unconfirmed draft');
    expect(sessionStorage.getItem('unrelated')).toBe('keep');
  });

  it('does not delete drafts when /me fails', async () => {
    useChatStore.getState().setInput('offline draft');
    vi.mocked(api.me).mockRejectedValueOnce(new Error('offline'));

    await expect(
      queries.queryClient.fetchQuery({ ...queries.meQuery, staleTime: 0 }),
    ).rejects.toThrow('offline');

    expect(savedDrafts()).toEqual({ '': 'offline draft' });
    expect(useChatStore.getState().input).toBe('offline draft');
  });

  it('explicit sign-out clears queries, drafts and chat state but no unrelated storage', async () => {
    const logoutAccount = (queries as { logoutAccount?: () => Promise<void> }).logoutAccount;
    expect(logoutAccount).toBeTypeOf('function');
    queries.queryClient.setQueryData(queries.meQuery.queryKey, authenticated('business-a'));
    seedChatState();
    vi.mocked(api.logout).mockResolvedValue({ ok: true });

    await logoutAccount?.();

    expect(api.logout).toHaveBeenCalledOnce();
    expect(queries.queryClient.getQueryData(queries.meQuery.queryKey)).toBeUndefined();
    expect(savedDrafts()).toEqual({});
    expect(useChatStore.getState()).toMatchObject({
      conversationId: null,
      input: '',
      items: [],
      run: null,
      lastRun: null,
      lastRunId: null,
      outputRef: null,
      pendingAttachments: [],
      historyOpen: false,
    });
    expect(sessionStorage.getItem('unrelated')).toBe('keep');
  });

  it('keeps process-local ownership when sessionStorage is unavailable', async () => {
    vi.resetModules();
    const fresh = (await import('../src/lib/chat-store.js')) as {
      bindChatIdentity?: (businessId: string) => void;
      useChatStore: typeof useChatStore;
    };
    expect(fresh.bindChatIdentity).toBeTypeOf('function');
    fresh.useChatStore.getState().reset();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    fresh.bindChatIdentity?.('business-a');
    fresh.useChatStore.getState().setInput('A draft');
    fresh.bindChatIdentity?.('business-a');
    expect(fresh.useChatStore.getState().input).toBe('A draft');

    fresh.bindChatIdentity?.('business-b');
    expect(fresh.useChatStore.getState().input).toBe('');
  });
});
