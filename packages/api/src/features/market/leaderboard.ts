import { fail } from '@agentport/core';
import type { MarketSkill, MarketView } from '@agentport/shared';

const BASE_URL = 'https://www.skills.sh';
const TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_ROWS = 50;

const PATHS: Record<MarketView, string> = {
  'all-time': '/',
  trending: '/trending',
  hot: '/hot',
};

const cache = new Map<MarketView, { at: number; data: MarketSkill[] }>();

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function fromCode(code: number, fallback: string): string {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : fallback;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return fromCode(Number.parseInt(entity.slice(2), 16), match);
    }
    if (entity.startsWith('#')) return fromCode(Number.parseInt(entity.slice(1), 10), match);
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).trim();
}

/** 4.0M / 60.7K / 1,234 → 整数；解析不出返回 null。 */
function parseInstalls(raw: string): number | null {
  const match = /^([\d.,]+)\s*([kmb])?$/i.exec(decodeEntities(raw).trim());
  if (!match?.[1]) return null;
  const value = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  const suffix = match[2]?.toLowerCase() ?? '';
  const scale = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : suffix === 'b' ? 1e9 : 1;
  return Math.round(value * scale);
}

/** 从榜单 HTML 提取行；顺序即页面顺序，重复 id 只保留首次出现。 */
// shortcut: 绑定 skills.sh 榜单 HTML；站点改版会取不到行，届时改用官方 v1（需 Vercel OIDC）。
export function parseLeaderboard(html: string): MarketSkill[] {
  const rowPattern = /<a\b[^>]*href="\/([^"/]+)\/([^"/]+)\/([^"/]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const namePattern = /<h3[^>]*>([\s\S]*?)<\/h3>/i;
  const installsPattern =
    /<span\b[^>]*class="[^"]*font-mono text-sm text-foreground[^"]*"[^>]*>([\s\S]*?)<\/span>/g;

  const seen = new Set<string>();
  const rows: MarketSkill[] = [];
  for (const match of html.matchAll(rowPattern)) {
    const [, owner, repo, skill, body = ''] = match;
    if (!owner || !repo || !skill) continue;
    const h3 = namePattern.exec(body);
    const span = [...body.matchAll(installsPattern)].at(-1);
    if (!h3?.[1] || !span?.[1]) continue;
    const installs = parseInstalls(span[1]);
    if (installs === null) continue;
    const id = `${owner}/${repo}/${skill}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, source: `${owner}/${repo}`, slug: skill, name: textOf(h3[1]), installs });
    if (rows.length === MAX_ROWS) break;
  }
  return rows;
}

export async function fetchLeaderboard(view: MarketView): Promise<MarketSkill[]> {
  const cached = cache.get(view);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  try {
    const response = await fetch(`${BASE_URL}${PATHS[view]}`, {
      headers: { 'user-agent': 'agentport-market/1.0', accept: 'text/html' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`skills.sh responded ${response.status}`);
    }
    const data = parseLeaderboard(await response.text());
    cache.set(view, { at: Date.now(), data });
    return data;
  } catch (err) {
    if (cached) return cached.data;
    fail('UPSTREAM_FAILED', '暂时无法获取技能市场榜单，请稍后重试', {
      cause: err,
      retryable: true,
    });
  }
}
