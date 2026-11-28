import { describe, expect, it } from 'bun:test';
import { runCancelKey, runStreamKey } from '@agentport/shared';

describe('producer shared stream contract', () => {
  it('keeps the Redis wire format and exports the worker budgets', () => {
    expect(runStreamKey('run-1')).toBe('run:run-1:events');
    expect(runCancelKey('run-1')).toBe('run:run-1:cancel');
  });
});
