import { describe, expect, it } from 'vitest';
import { knowledgeJobErrorText } from '../src/lib/knowledge-errors.js';

describe('knowledge job error text', () => {
  it('returns an unknown error unchanged', () => {
    expect(knowledgeJobErrorText('parse_pdf: 文件解析失败')).toBe('parse_pdf: 文件解析失败');
  });

  it('treats a missing or blank error as absent', () => {
    expect(knowledgeJobErrorText(null)).toBeNull();
    expect(knowledgeJobErrorText(undefined)).toBeNull();
    expect(knowledgeJobErrorText('  ')).toBeNull();
  });
});
