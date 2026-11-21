import { fail } from '@agentport/core';
import type { MarketSkill, MarketView } from '@agentport/shared';
import { LRUCache } from 'lru-cache';
import { parse } from 'node-html-parser';
import { readCappedText } from './fetch-body.js';

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

// shortcut: 绑定 skills.sh 榜单 HTML；站点改版会取不到行，届时改用官方 v1（需 Vercel OIDC）。
export function parseLeaderboard(html: string): MarketSkill[] {
  const seen = new Set<string>();
  const rows: MarketSkill[] = [];
  for (const link of parse(html).querySelectorAll('a')) {
    const match = /^\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(link.getAttribute('href') ?? '');
    if (!match) continue;
    const [, owner, repo, skill] = match;
    if (!owner || !repo || !skill) continue;
    const h3 = link.querySelector('h3');
    const installsSpan = link.querySelectorAll('span.font-mono.text-sm.text-foreground').at(-1);
    if (!h3 || !installsSpan) continue;
    const name = h3.text.trim();
    if (!name) continue;
    const installs = parseInstalls(installsSpan.text);
    if (installs === null) continue;
    const id = `${owner}/${repo}/${skill}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, source: `${owner}/${repo}`, slug: skill, name, installs });
    if (rows.length === MAX_ROWS) break;
  }
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
    const data = parseLeaderboard(await readCappedText(response, '技能市场榜单响应超过大小限制'));
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
