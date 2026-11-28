import { fail, readCappedText } from '@agentport/core';
import type { MarketSkill, MarketView } from '@agentport/shared';
import { LRUCache } from 'lru-cache';

const BASE_URL = 'https://www.skills.sh';
const TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_ROWS = 50;

const PATHS: Record<MarketView, string> = {
  'all-time': '/',
  trending: '/trending',
  hot: '/hot',
};

const cache = new LRUCache<MarketView, MarketSkill[]>({
  max: 10,
  ttl: CACHE_TTL_MS,
  ttlResolution: 0,
  perf: { now: () => Date.now() },
});

function parseInstalls(raw: string): number | null {
  const match = /^([\d.,]+)\s*([kmb])?$/i.exec(raw.trim());
  if (!match?.[1]) return null;
  const value = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  const suffix = match[2]?.toLowerCase() ?? '';
  const scale = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : suffix === 'b' ? 1e9 : 1;
  return Math.round(value * scale);
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (raw, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1]?.toLowerCase() === 'x'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : raw;
    }
    return ENTITIES[body.toLowerCase()] ?? raw;
  });
}

// shortcut: 绑定 skills.sh 榜单 HTML；站点改版会取不到行，届时改用官方 v1（需 Vercel OIDC）。
async function parseLeaderboard(html: string): Promise<MarketSkill[]> {
  const seen = new Set<string>();
  const rows: MarketSkill[] = [];
  type Row = { owner: string; repo: string; skill: string; name: string; installs: string };
  let cur: Row | null = null;

  const settle = () => {
    if (!cur) return;
    const { owner, repo, skill } = cur;
    const name = decodeEntities(cur.name).trim();
    const installs = parseInstalls(cur.installs);
    cur = null;
    if (!name || installs === null) return;
    const id = `${owner}/${repo}/${skill}`;
    if (seen.has(id) || rows.length >= MAX_ROWS) return;
    seen.add(id);
    rows.push({ id, source: `${owner}/${repo}`, slug: skill, name, installs });
  };

  await new HTMLRewriter()
    .on('a', {
      element(el) {
        const match = /^\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(el.getAttribute('href') ?? '');
        const [, owner, repo, skill] = match ?? [];
        if (!owner || !repo || !skill) return;
        cur = { owner, repo, skill, name: '', installs: '' };
        el.onEndTag(settle);
      },
    })
    .on('a h3', {
      element() {
        if (cur) cur.name = '';
      },
      text(chunk) {
        if (cur) cur.name += chunk.text;
      },
    })
    .on('a span.font-mono.text-sm.text-foreground', {
      element() {
        if (cur) cur.installs = '';
      },
      text(chunk) {
        if (cur) cur.installs += chunk.text;
      },
    })
    .transform(new Response(html))
    .text();

  return rows;
}

export async function fetchLeaderboard(view: MarketView): Promise<MarketSkill[]> {
  const cached = cache.peek(view, { allowStale: true });
  if (cached && cache.getRemainingTTL(view) > 0) return cached;

  try {
    const response = await fetch(`${BASE_URL}${PATHS[view]}`, {
      headers: { 'user-agent': 'agentport-market/1.0', accept: 'text/html' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`skills.sh responded ${response.status}`);
    }
    const data = await parseLeaderboard(
      await readCappedText(response, 20 * 1024 * 1024, 'market', {
        onExceeded: () => fail('INVALID_INPUT', '技能市场榜单响应超过大小限制'),
        checkContentLength: false,
      }),
    );
    cache.set(view, data);
    return data;
  } catch (err) {
    if (cached) return cached;
    fail('UPSTREAM_FAILED', '暂时无法获取技能市场榜单，请稍后重试', {
      cause: err,
      retryable: true,
    });
  }
}
