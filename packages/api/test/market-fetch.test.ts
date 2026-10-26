import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SEARCH_TTL_MS = 5 * 60 * 1000;
const LEADERBOARD_TTL_MS = 10 * 60 * 1000;
const SEARCH_SKILL = {
  id: 'owner/repo/skill',
  source: 'owner/repo',
  skillId: 'skill',
  name: 'Skill',
  installs: 1_234,
};
const LEADERBOARD_HTML =
  '<a href="/owner/repo/skill"><h3>Skill</h3><span class="font-mono text-sm text-foreground">1.2K</span></a>';

let server: Server;
let baseUrl: string;
let mode: 'fail' | 'ok';
let state: { requests: number; closed: number };

beforeEach(async () => {
  mode = 'fail';
  state = { requests: 0, closed: 0 };
  const current = state;
  server = createServer((req, res) => {
    current.requests++;
    if (mode === 'fail') {
      res.writeHead(503, { 'content-type': 'text/plain' });
      // 不结束响应体：只有客户端消费或取消 body 才会释放连接。
      res.write('upstream unavailable');
      res.on('close', () => current.closed++);
      return;
    }
    if (req.url?.startsWith('/api/search')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ skills: [SEARCH_SKILL] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(LEADERBOARD_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  const nativeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    return nativeFetch(new URL(`${url.pathname}${url.search}`, baseUrl), init);
  }) satisfies typeof fetch);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function loadMarket() {
  vi.resetModules();
  const search = await import('../src/features/market/search.js');
  const leaderboard = await import('../src/features/market/leaderboard.js');
  return { ...search, ...leaderboard };
}

describe('market fetch failure handling', () => {
  it('fails search without cache and releases the 503 connection', async () => {
    const { searchMarket } = await loadMarket();

    const error = await searchMarket('offline').catch((err: unknown) => err);

    expect(error).toMatchObject({ code: 'UPSTREAM_FAILED', retryable: true });
    await vi.waitFor(() => expect(state.closed).toBe(1));
  });

  it('fails leaderboard without cache and releases the 503 connection', async () => {
    const { fetchLeaderboard } = await loadMarket();

    const error = await fetchLeaderboard('hot').catch((err: unknown) => err);

    expect(error).toMatchObject({ code: 'UPSTREAM_FAILED', retryable: true });
    await vi.waitFor(() => expect(state.closed).toBe(1));
  });

  it('keeps stale search data and releases the 503 connection', async () => {
    const { searchMarket } = await loadMarket();
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    mode = 'ok';
    const first = await searchMarket('stale');
    mode = 'fail';
    now.mockReturnValue(start + SEARCH_TTL_MS);

    const second = await searchMarket('stale');

    expect(second).toEqual(first);
    expect(state.requests).toBe(2);
    await vi.waitFor(() => expect(state.closed).toBe(1));
  });

  it('keeps stale leaderboard data and releases the 503 connection', async () => {
    const { fetchLeaderboard } = await loadMarket();
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    mode = 'ok';
    const first = await fetchLeaderboard('trending');
    mode = 'fail';
    now.mockReturnValue(start + LEADERBOARD_TTL_MS);

    const second = await fetchLeaderboard('trending');

    expect(second).toEqual(first);
    expect(state.requests).toBe(2);
    await vi.waitFor(() => expect(state.closed).toBe(1));
  });
});

describe('market fetch success caching', () => {
  it('returns search results and serves a fresh cache without fetching again', async () => {
    const { searchMarket } = await loadMarket();
    mode = 'ok';

    const first = await searchMarket('fresh');
    const second = await searchMarket('fresh');

    expect(first).toEqual([
      {
        id: SEARCH_SKILL.id,
        source: SEARCH_SKILL.source,
        slug: SEARCH_SKILL.skillId,
        name: SEARCH_SKILL.name,
        installs: SEARCH_SKILL.installs,
      },
    ]);
    expect(second).toEqual(first);
    expect(state.requests).toBe(1);
  });

  it('returns leaderboard rows and serves a fresh cache without fetching again', async () => {
    const { fetchLeaderboard } = await loadMarket();
    mode = 'ok';

    const first = await fetchLeaderboard('all-time');
    const second = await fetchLeaderboard('all-time');

    expect(first).toEqual([
      {
        id: 'owner/repo/skill',
        source: 'owner/repo',
        slug: 'skill',
        name: 'Skill',
        installs: 1_200,
      },
    ]);
    expect(second).toEqual(first);
    expect(state.requests).toBe(1);
  });
});
