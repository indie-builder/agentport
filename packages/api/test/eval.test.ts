import { describe, expect, it } from 'bun:test';
import { judge } from '@agentport/shared';

describe('judge', () => {
  it('passes when expectation is empty and output has text', () => {
    expect(judge('anything', '')).toBe(true);
    expect(judge('   ', '')).toBe(false);
  });

  it('matches expectation case-insensitively as a substring', () => {
    expect(judge('The answer is OK.', 'answer is ok')).toBe(true);
    expect(judge('nope', 'answer')).toBe(false);
  });

  it('trims expectation before matching', () => {
    expect(judge('some text', '  text  ')).toBe(true);
  });
});
