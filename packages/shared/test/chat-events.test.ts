import { describe, expect, it } from 'vitest';
import { chatEventSchema } from '../src/chat.js';

const parse = (event: unknown) => chatEventSchema.parse(event);

describe('assistant block boundaries', () => {
  it('accepts block start and stop with an index', () => {
    expect(parse({ type: 'assistant_block_start', blockIndex: 2, kind: 'text' })).toEqual({
      type: 'assistant_block_start',
      blockIndex: 2,
      kind: 'text',
    });
    expect(
      parse({
        type: 'assistant_block_start',
        blockIndex: 0,
        kind: 'tool_use',
        sdkUuid: 'u1',
        parentToolUseId: 'parent',
      }),
    ).toMatchObject({ kind: 'tool_use', sdkUuid: 'u1', parentToolUseId: 'parent' });
    expect(parse({ type: 'assistant_block_stop', blockIndex: 2 })).toEqual({
      type: 'assistant_block_stop',
      blockIndex: 2,
    });
  });

  it('rejects a negative or fractional block index', () => {
    expect(
      chatEventSchema.safeParse({ type: 'assistant_block_start', blockIndex: -1, kind: 'text' })
        .success,
    ).toBe(false);
    expect(
      chatEventSchema.safeParse({ type: 'assistant_block_stop', blockIndex: 1.5 }).success,
    ).toBe(false);
  });

  it('carries block attribution on text deltas', () => {
    expect(
      parse({
        type: 'text_delta',
        text: 'hi',
        blockIndex: 1,
        sdkUuid: 'u1',
        parentToolUseId: 'parent',
      }),
    ).toMatchObject({ blockIndex: 1, sdkUuid: 'u1', parentToolUseId: 'parent' });
  });

  it('still parses legacy events without block fields', () => {
    expect(parse({ type: 'text_delta', text: 'hi' })).toEqual({ type: 'text_delta', text: 'hi' });
    expect(parse({ type: 'assistant_text', text: 'hi' })).toEqual({
      type: 'assistant_text',
      text: 'hi',
    });
  });

  it('marks a truncated completed block', () => {
    expect(
      parse({ type: 'assistant_text', text: 'cut', blockIndex: 0, truncated: true }),
    ).toMatchObject({ blockIndex: 0, truncated: true });
  });
});
