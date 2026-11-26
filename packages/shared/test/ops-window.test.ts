import { describe, expect, it } from 'bun:test';
import { utcWindowStart } from '../src/ops.js';

describe('UTC 统计窗口', () => {
  it('跨月时窗口是 30 个 UTC 自然日，起点为 29 天前的零点', () => {
    const now = new Date('2026-03-02T12:34:56.789Z');
    expect(utcWindowStart(30, now).toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('闰年二月窗口起点跨越 2 月 29 日', () => {
    expect(utcWindowStart(30, new Date('2024-03-01T00:00:00Z')).toISOString()).toBe(
      '2024-02-01T00:00:00.000Z',
    );
  });

  it('单日窗口是今天 UTC 零点', () => {
    const now = new Date('2026-12-31T23:59:59Z');
    expect(utcWindowStart(30, now).toISOString()).toBe('2026-12-02T00:00:00.000Z');
    expect(utcWindowStart(1, now).toISOString()).toBe('2026-12-31T00:00:00.000Z');
  });
});
