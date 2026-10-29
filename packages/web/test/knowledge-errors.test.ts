import { describe, expect, it } from 'vitest';
import { knowledgeJobErrorText } from '../src/lib/knowledge-errors.js';

describe('knowledge job error text', () => {
  it('explains a lost worker job in Chinese', () => {
    expect(knowledgeJobErrorText('knowledge worker lost track of this job')).toBe(
      '后台任务中断，本次未完成；重试会重新执行',
    );
  });

  it('returns an unknown error unchanged', () => {
    expect(knowledgeJobErrorText('parse_pdf: 文件解析失败')).toBe('parse_pdf: 文件解析失败');
  });

  it('returns prototype property names unchanged instead of resolving them', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(knowledgeJobErrorText(name)).toBe(name);
    }
  });

  it('treats a missing or blank error as absent', () => {
    expect(knowledgeJobErrorText(null)).toBeNull();
    expect(knowledgeJobErrorText(undefined)).toBeNull();
    expect(knowledgeJobErrorText('  ')).toBeNull();
  });
});
