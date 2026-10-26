import { fail } from '@agentport/core';
import type { MarketSkill } from '@agentport/shared';

// shortcut: CLI 在用的公开搜索接口；官方 /api/v1 需 Vercel OIDC，上游收紧时再切。
const SEARCH_URL = 'https://skills.sh/api/search';
const TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, { at: number; data: MarketSkill[] }>();

function toSkill(row: unknown): MarketSkill | null {
  const value = row as {
    id?: unknown;
    source?: unknown;
    skillId?: unknown;
    name?: unknown;
    installs?: unknown;
  };
  if (typeof value.id !== 'string' || typeof value.source !== 'string') return null;
  if (typeof value.skillId !== 'string' || typeof value.name !== 'string') return null;
  const installs = Number(value.installs);
  if (!Number.isFinite(installs) || installs < 0) return null;
  return {
    id: value.id,
    source: value.source,
    slug: value.skillId,
    name: value.name,
    installs: Math.trunc(installs),
  };
}

export async function searchMarket(q: string): Promise<MarketSkill[]> {
  const cached = cache.get(q);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  try {
    const url = `${SEARCH_URL}?q=${encodeURIComponent(q)}&limit=50`;
    const response = await fetch(url, {
      headers: { 'user-agent': 'agentport-market/1.0', accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`skills.sh responded ${response.status}`);
    }
    const body = (await response.json()) as { skills?: unknown };
    if (!Array.isArray(body.skills)) throw new Error('unexpected search response');
    const data = body.skills.map(toSkill).filter((skill): skill is MarketSkill => skill !== null);
    cache.set(q, { at: Date.now(), data });
    return data;
  } catch (err) {
    if (cached) return cached.data;
    fail('UPSTREAM_FAILED', '暂时无法搜索技能市场，请稍后重试', { cause: err, retryable: true });
  }
}
