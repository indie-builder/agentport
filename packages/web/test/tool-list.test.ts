import { describe, expect, it } from 'vitest';
import { parseToolList } from '../src/pages/eval/case-dialog.js';

describe('parseToolList', () => {
  it('splits on newlines and commas, trims each entry and drops blanks', () => {
    expect(parseToolList(' mcp__knowledge__search , Read\n\n Bash , ')).toEqual([
      'mcp__knowledge__search',
      'Read',
      'Bash',
    ]);
  });

  it('keeps the first occurrence of a duplicated tool name', () => {
    expect(parseToolList('Read, Bash\nRead')).toEqual(['Read', 'Bash']);
  });

  it('returns an empty list for blank input', () => {
    expect(parseToolList('')).toEqual([]);
    expect(parseToolList(' \n, ')).toEqual([]);
  });
});
