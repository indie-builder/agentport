import { describe, expect, it } from 'vitest';
import { parseLeaderboard } from '../src/features/market/leaderboard.js';

const row = (rank: number, owner: string, repo: string, skill: string, installs: string) => `
  <a class="group grid" href="/${owner}/${repo}/${skill}">
    <div class="min-w-7"><span class="text-sm font-mono">${rank}</span></div>
    <div class="lg:col-span-11">
      <h3 class="font-semibold text-foreground truncate whitespace-nowrap">${skill}</h3>
      <p class="text-xs font-mono truncate">${owner}/${repo}</p>
    </div>
    <div class="lg:col-span-2 text-right">
      <span class="font-mono text-sm text-foreground">${installs}</span>
    </div>
  </a>`;

const fixture = `<!doctype html><html><body>
  <nav><a href="/docs">Docs</a></nav>
  <main>
    ${row(1, 'vercel-labs', 'skills', 'find-skills', '4.0M')}
    ${row(2, 'mattpocock', 'skills', 'grill-me', '60.7K')}
    <a href="/broken/repo/skill"><h3>broken</h3><span class="font-mono text-sm text-foreground">n/a</span></a>
  </main>
</body></html>`;

describe('parseLeaderboard', () => {
  it('extracts skills in page order with parsed install counts', () => {
    expect(parseLeaderboard(fixture)).toEqual([
      {
        id: 'vercel-labs/skills/find-skills',
        source: 'vercel-labs/skills',
        slug: 'find-skills',
        name: 'find-skills',
        installs: 4_000_000,
      },
      {
        id: 'mattpocock/skills/grill-me',
        source: 'mattpocock/skills',
        slug: 'grill-me',
        name: 'grill-me',
        installs: 60_700,
      },
    ]);
  });

  it('drops duplicate ids and rows without a parseable install count', () => {
    const html = `${row(1, 'a', 'b', 'c', '1,234')}${row(2, 'a', 'b', 'c', '99')}${row(3, 'x', 'y', 'z', '?')}`;
    expect(parseLeaderboard(html)).toEqual([
      { id: 'a/b/c', source: 'a/b', slug: 'c', name: 'c', installs: 1_234 },
    ]);
  });
});
