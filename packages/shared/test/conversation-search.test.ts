import { describe, expect, it } from 'vitest';
import {
  conversationSearchItemSchema,
  conversationSearchQuerySchema,
  conversationSearchResponseSchema,
} from '../src/chat.js';

describe('conversation search query', () => {
  it('defaults to an empty query and 20 items', () => {
    expect(conversationSearchQuerySchema.parse({})).toEqual({ q: '', limit: 20 });
  });

  it('trims q and accepts a single Chinese character', () => {
    expect(conversationSearchQuerySchema.parse({ q: '  进  ' }).q).toBe('进');
  });

  it('rejects q longer than 200 characters after trimming', () => {
    expect(conversationSearchQuerySchema.safeParse({ q: ` ${'a'.repeat(200)} ` }).success).toBe(
      true,
    );
    expect(conversationSearchQuerySchema.safeParse({ q: 'a'.repeat(201) }).success).toBe(false);
  });

  it('coerces limit and enforces the 1..50 boundary', () => {
    expect(conversationSearchQuerySchema.parse({ limit: '1' }).limit).toBe(1);
    expect(conversationSearchQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    for (const limit of ['0', '51', '2.5', 'nope']) {
      expect(conversationSearchQuerySchema.safeParse({ limit }).success).toBe(false);
    }
  });

  it('keeps agentId and the opaque before cursor optional', () => {
    expect(
      conversationSearchQuerySchema.parse({ agentId: 'agt_1', before: 'cursor' }),
    ).toMatchObject({ agentId: 'agt_1', before: 'cursor' });
    expect(conversationSearchQuerySchema.safeParse({ agentId: '' }).success).toBe(false);
    expect(conversationSearchQuerySchema.safeParse({ before: '' }).success).toBe(false);
  });
});

describe('conversation search response', () => {
  const item = {
    id: 'conv_1',
    agentId: 'agt_1',
    agentName: '研究员',
    title: '标题',
    updatedAt: '2026-10-29T00:00:00.000Z',
    match: { kind: 'message' as const, excerpt: '正文' },
  };

  it('parses every match kind and a null match', () => {
    for (const kind of ['id', 'title', 'message'] as const) {
      expect(
        conversationSearchItemSchema.parse({ ...item, match: { kind, excerpt: null } }).match,
      ).toEqual({ kind, excerpt: null });
    }
    expect(conversationSearchItemSchema.parse({ ...item, match: null }).match).toBeNull();
    expect(
      conversationSearchResponseSchema.parse({ items: [item], nextBefore: null }),
    ).toMatchObject({ nextBefore: null });
  });

  it('rejects an unknown match kind', () => {
    expect(
      conversationSearchItemSchema.safeParse({ ...item, match: { kind: 'body', excerpt: null } })
        .success,
    ).toBe(false);
  });
});
