import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { escalateKill } from '../src/runner-client.js';

class FakeChild extends EventEmitter {
  readonly signals: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('escalateKill', () => {
  it('sends SIGTERM first and SIGKILL only after the grace period', () => {
    vi.useFakeTimers();
    const child = new FakeChild();

    escalateKill(child, 5_000);
    expect(child.signals).toEqual(['SIGTERM']);

    vi.advanceTimersByTime(4_999);
    expect(child.signals).toEqual(['SIGTERM']);

    vi.advanceTimersByTime(1);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
