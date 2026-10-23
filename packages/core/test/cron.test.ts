import { describe, expect, it } from 'vitest';
import { nextCronRun, parseCron } from '../src/cron.js';

const at = (iso: string) => new Date(iso);

describe('parseCron', () => {
  it('parses wildcards and step/list/range fields', () => {
    const cron = parseCron('*/15 9-17 1,15 * 1-5');
    expect([...cron.minutes].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect([...cron.hours].sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...cron.days].sort((a, b) => a - b)).toEqual([1, 15]);
    expect([...cron.weekdays].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('normalizes day-of-week 7 to 0 (Sunday)', () => {
    const cron = parseCron('0 0 * * 7');
    expect(cron.weekdays.has(0)).toBe(true);
    expect(cron.weekdays.has(7)).toBe(false);
  });

  it('rejects malformed expressions', () => {
    expect(() => parseCron('0 0 * *')).toThrow();
    expect(() => parseCron('60 0 * * *')).toThrow();
    expect(() => parseCron('0 0 * * 9')).toThrow();
    expect(() => parseCron('*/0 * * * *')).toThrow();
  });
});

describe('nextCronRun', () => {
  it('returns the next matching minute strictly after the cursor', () => {
    const next = nextCronRun('0 9 * * *', at('2026-10-23T08:30:00Z'));
    expect(next.toISOString()).toBe('2026-10-23T09:00:00.000Z');
  });

  it('rolls to the next day when today has passed', () => {
    const next = nextCronRun('0 9 * * *', at('2026-10-23T09:00:00Z'));
    expect(next.toISOString()).toBe('2026-10-24T09:00:00.000Z');
  });

  it('handles weekday-restricted schedules', () => {
    // 2026-10-23 is a Friday; next weekday 09:00 is Monday 2026-10-26.
    const next = nextCronRun('0 9 * * 1-5', at('2026-10-23T09:30:00Z'));
    expect(next.toISOString()).toBe('2026-10-26T09:00:00.000Z');
  });

  it('handles step minutes across an hour boundary', () => {
    const next = nextCronRun('*/15 * * * *', at('2026-10-23T10:07:00Z'));
    expect(next.toISOString()).toBe('2026-10-23T10:15:00.000Z');
  });
});
