import { describe, expect, it } from 'vitest';
import { knowledgeShouldPoll } from '../src/lib/queries.js';

describe('knowledge document polling', () => {
  it('continues polling a freshly pending uploaded document', () => {
    expect(knowledgeShouldPoll([{ status: 'pending', createdAt: new Date().toISOString() }])).toBe(
      true,
    );
  });

  it('stops polling a completed document', () => {
    expect(knowledgeShouldPoll([{ status: 'ready', createdAt: new Date().toISOString() }])).toBe(
      false,
    );
  });
});
