import { describe, expect, it } from 'vitest';
import { recentUtcDays, utcWindowStart } from '../src/ops.js';

describe('UTC 统计窗口', () => {
  it('跨月时窗口是 30 个 UTC 自然日，起点为 29 天前的零点', () => {
    const now = new Date('2026-03-02T12:34:56.789Z');

    expect(utcWindowStart(30, now).toISOString()).toBe('2026-02-01T00:00:00.000Z');
    const days = recentUtcDays(30, now);
    expect(days).toHaveLength(30);
    expect(days[0]).toBe('2026-02-01');
    expect(days.at(-1)).toBe('2026-03-02');
  });

  it('闰年二月包含 2 月 29 日且仍然恰好 30 天', () => {
    const days = recentUtcDays(30, new Date('2024-03-01T00:00:00Z'));

    expect(days).toHaveLength(30);
    expect(days[0]).toBe('2024-02-01');
    expect(days).toContain('2024-02-29');
    expect(days.at(-1)).toBe('2024-03-01');
  });

  it('窗口起点与首日一致，单日窗口是今天 UTC 零点', () => {
    const now = new Date('2026-12-31T23:59:59Z');
    expect(utcWindowStart(30, now).toISOString()).toBe('2026-12-02T00:00:00.000Z');
    expect(new Date(`${recentUtcDays(30, now)[0]}T00:00:00Z`).getTime()).toBe(
      utcWindowStart(30, now).getTime(),
    );
    expect(recentUtcDays(1, now)).toEqual(['2026-12-31']);
  });
});
