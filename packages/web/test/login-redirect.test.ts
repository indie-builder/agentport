import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loginPath, resolveReturnTo, safeReturnTo } from '../src/lib/auth-redirect.js';
import { LoginPage } from '../src/pages/login.js';

const PLUGIN_TARGET = '/plugins/plugin_1?tab=content&file=skills%2Fdemo%2FSKILL.md&mode=source#top';
const KNOWLEDGE_TARGET = '/knowledge/kb_1?panel=wiki&page=guide&folder=docs';

describe('safeReturnTo', () => {
  it.each([PLUGIN_TARGET, KNOWLEDGE_TARGET, '/agents/agent_1?tab=files#memory'])(
    'keeps the in-app path %s with search and hash',
    (target) => {
      expect(safeReturnTo(target)).toBe(target);
      expect(resolveReturnTo(target)).toBe(target);
    },
  );

  it.each([
    '//evil.example/steal',
    'https://evil.example/steal',
    'http://evil.example',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '/\\evil.example/steal',
    '/\\[',
    '/\\evil:bad',
    'evil.example/steal',
    '/login',
    '/login/',
    '/login?returnTo=%2Fagents',
    '/login/#top',
    '',
  ])('rejects the untrusted target %s', (target) => {
    expect(safeReturnTo(target)).toBeUndefined();
    expect(resolveReturnTo(target)).toBe('/');
  });

  it('rejects non-string values', () => {
    expect(safeReturnTo(undefined)).toBeUndefined();
    expect(safeReturnTo(null)).toBeUndefined();
    expect(safeReturnTo(['/agents'])).toBeUndefined();
  });
});

describe('loginPath', () => {
  it('keeps pathname, search and hash and marks an expired session once', () => {
    const path = loginPath(PLUGIN_TARGET, 'expired');
    expect(path.startsWith('/login?')).toBe(true);
    const url = new URL(path, 'http://app.local');
    expect(url.searchParams.get('returnTo')).toBe(PLUGIN_TARGET);
    expect(url.searchParams.get('reason')).toBe('expired');
  });

  it('drops the expired reason on a first login and falls back home for untrusted targets', () => {
    expect(new URL(loginPath(undefined), 'http://app.local').searchParams.get('reason')).toBeNull();
    expect(
      new URL(loginPath('https://evil.example'), 'http://app.local').searchParams.get('returnTo'),
    ).toBe('/');
  });
});

const state = vi.hoisted(() => ({
  search: {} as { returnTo?: string; reason?: string },
  query: {
    isFetchedAfterMount: true,
    isSuccess: true,
    data: { authenticated: false },
  },
  navigate: vi.fn(),
  refetch: vi.fn(),
  mutation: null as { onSuccess: () => Promise<void> } | null,
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => state.navigate,
  useSearch: () => state.search,
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => state.query,
  useMutation: (options: { onSuccess: () => Promise<void> }) => {
    state.mutation = options;
    return { isPending: false, mutate: vi.fn() };
  },
}));
vi.mock('../src/lib/queries.js', () => ({
  meQuery: { queryKey: ['me'] },
  queryClient: { refetchQueries: (...args: unknown[]) => state.refetch(...args) },
}));

async function renderLogin() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(LoginPage)));
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

beforeEach(() => {
  state.search = {};
  state.query = {
    isFetchedAfterMount: true,
    isSuccess: true,
    data: { authenticated: false },
  };
  state.navigate.mockClear();
  state.refetch.mockClear();
  state.mutation = null;
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('login page return target', () => {
  it('explains an expired session once and strips the reason from the address', async () => {
    state.search = { returnTo: KNOWLEDGE_TARGET, reason: 'expired' };
    const page = await renderLogin();
    try {
      expect(page.container.textContent).toContain('登录已过期，请重新登录');
      expect(state.navigate).toHaveBeenCalledWith({
        to: '/login',
        search: { returnTo: KNOWLEDGE_TARGET },
        replace: true,
      });
    } finally {
      await page.cleanup();
    }
  });

  it('does not show the expired notice on a first login', async () => {
    state.search = { returnTo: KNOWLEDGE_TARGET };
    const page = await renderLogin();
    try {
      expect(page.container.textContent).not.toContain('登录已过期');
      expect(page.container.textContent).not.toContain('失效');
    } finally {
      await page.cleanup();
    }
  });

  it('keeps the form until this mount has confirmed the session', async () => {
    state.search = { returnTo: PLUGIN_TARGET };
    state.query = {
      isFetchedAfterMount: false,
      isSuccess: true,
      data: { authenticated: true },
    };
    const page = await renderLogin();
    try {
      expect(page.container.querySelector('form[aria-label="登录"]')).not.toBeNull();
      expect(state.navigate).not.toHaveBeenCalled();
    } finally {
      await page.cleanup();
    }
  });

  it('returns to the target only after a fresh authenticated check', async () => {
    state.search = { returnTo: PLUGIN_TARGET };
    state.query = {
      isFetchedAfterMount: true,
      isSuccess: true,
      data: { authenticated: true },
    };
    const page = await renderLogin();
    try {
      expect(state.navigate).toHaveBeenCalledWith({ href: PLUGIN_TARGET, replace: true });
    } finally {
      await page.cleanup();
    }
  });

  it('keeps the form when the fresh check fails despite a stale authenticated result', async () => {
    state.search = { returnTo: PLUGIN_TARGET };
    state.query = {
      isFetchedAfterMount: true,
      isSuccess: false,
      data: { authenticated: true },
    };
    const page = await renderLogin();
    try {
      expect(page.container.querySelector('form[aria-label="登录"]')).not.toBeNull();
      expect(state.navigate).not.toHaveBeenCalled();
    } finally {
      await page.cleanup();
    }
  });

  it('returns to the deep-linked plugin view after login', async () => {
    state.search = { returnTo: PLUGIN_TARGET };
    const page = await renderLogin();
    try {
      await act(async () => state.mutation?.onSuccess());
      expect(state.refetch).toHaveBeenCalled();
      expect(state.navigate).toHaveBeenCalledWith({ href: PLUGIN_TARGET, replace: true });
    } finally {
      await page.cleanup();
    }
  });

  it.each(['https://evil.example/steal', '/\\evil:bad', '/login/'])(
    'returns home after login when the target %s is untrusted',
    async (returnTo) => {
      state.search = { returnTo };
      const page = await renderLogin();
      try {
        await act(async () => state.mutation?.onSuccess());
        expect(state.navigate).toHaveBeenCalledWith({ href: '/', replace: true });
      } finally {
        await page.cleanup();
      }
    },
  );
});
