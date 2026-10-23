import { describe, expect, it } from 'vitest';
import { buildSkillDraft, slugify } from '../src/skill-draft.js';

describe('slugify', () => {
  it('produces a valid slug', () => {
    expect(slugify('Drill Agent · 抓取用户', 'fallback')).toMatch(/^[a-z0-9][a-z0-9-_]*$/);
    expect(slugify('Drill Agent', 'x').length).toBeLessThanOrEqual(64);
  });
  it('falls back when nothing usable', () => {
    expect(slugify('中文', 'run-abc12345')).toMatch(/^[a-z0-9][a-z0-9-_]*$/);
  });
});

describe('buildSkillDraft', () => {
  it('captures the task, tools and reference answer', () => {
    const draft = buildSkillDraft({
      agentName: 'Drill Agent',
      runId: 'run_01abc',
      steps: [
        { kind: 'user', text: '抓取用户 1 并总结' },
        { kind: 'tool', name: 'mcp__crm__get_user' },
        { kind: 'tool', name: 'mcp__crm__get_user' },
        { kind: 'assistant', text: '用户 1 是 Leanne Graham。' },
      ],
    });
    expect(draft.slug).toMatch(/^[a-z0-9][a-z0-9-_]*$/);
    expect(draft.name).toContain('Drill Agent');
    expect(draft.description).toContain('抓取用户');
    expect(draft.body).toContain('## 适用场景');
    expect(draft.body).toContain('## 使用到的工具');
    expect(draft.body).toContain('mcp__crm__get_user');
    // duplicate tool names are de-duplicated
    expect(draft.body.match(/mcp__crm__get_user/g)?.length).toBe(1);
    expect(draft.body).toContain('## 参考做法');
    expect(draft.body).toContain('Leanne Graham');
  });

  it('tolerates a run with no user/assistant text', () => {
    const draft = buildSkillDraft({ agentName: 'A', runId: 'run_zzzzzzzz', steps: [] });
    expect(draft.body).toContain('## 适用场景');
    expect(draft.slug).toMatch(/^[a-z0-9][a-z0-9-_]*$/);
  });
});
