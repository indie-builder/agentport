import { describe, expect, it } from 'vitest';
import { agentAvatar } from '../src/components/agent-avatar.js';

const pick = (name: string, description = '', slug = name) =>
  agentAvatar({ name, slug, description });

describe('agent avatar', () => {
  it('maps distinct roles to distinct illustrations', () => {
    const sources = ['前端工程师', '后端工程师', '测试工程师', 'UI 设计师', '数据分析师'].map((n) =>
      pick(n),
    );
    expect(new Set(sources).size).toBe(sources.length);
  });

  it('matches role keywords in either Chinese or English', () => {
    expect(pick('前端工程师')).toBe(pick('Frontend Engineer'));
    expect(pick('测试工程师')).toBe(pick('QA Engineer'));
    expect(pick('前端工程师')).not.toBe(pick('测试工程师'));
  });

  it('uses the explicit occupation even when the name suggests a different job', () => {
    const selected = agentAvatar({
      name: '前端测试',
      slug: 'frontend-test',
      description: 'React UI',
      role: '数据分析师',
    });
    expect(selected).toBe(pick('数据分析师'));
    expect(selected).not.toBe(pick('前端工程师'));
  });

  it('gives digital twins their own portrait instead of a random occupation', () => {
    expect(
      agentAvatar({ name: '我的分身', slug: 'my-twin', description: '', role: '数字分身' }),
    ).toContain('digital-twin.png');
  });

  it('falls back deterministically by slug when no role keyword matches', () => {
    expect(pick('Zeta', '', 'agent-alpha')).toBe(pick('Omega', 'no role here', 'agent-alpha'));
  });
});
