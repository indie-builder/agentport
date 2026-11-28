import { describe, expect, it } from 'bun:test';
import { evaluateContentPolicy } from '../src/content-policy.js';

function secretPolicy(action: 'redact' | 'block' = 'redact') {
  return {
    id: 'pol_secret',
    name: 'Secret Policy',
    version: 1,
    direction: 'outbound' as const,
    action,
    matchType: 'secret' as const,
    pattern: '',
    caseSensitive: false,
    agentId: null,
    priority: 100,
    enabled: true,
  };
}

describe('evaluateContentPolicy', () => {
  it('enforces unified secret thresholds across Bearer, sk- and ghp_', () => {
    const policies = [secretPolicy('redact')];

    expect(
      evaluateContentPolicy({
        text: 'Authorization: Bearer abcdefgh',
        policies,
        direction: 'outbound',
      }),
    ).toMatchObject({ action: 'redact', text: 'Authorization: Bearer ***' });

    expect(
      evaluateContentPolicy({
        text: 'Authorization: Bearer abcdefg',
        policies,
        direction: 'outbound',
      }),
    ).toMatchObject({ action: 'allow', text: 'Authorization: Bearer abcdefg' });

    expect(
      evaluateContentPolicy({
        text: 'Bearer Bearer abcdefgh',
        policies,
        direction: 'outbound',
      }),
    ).toMatchObject({ action: 'redact', text: 'Bearer Bearer ***' });

    expect(
      evaluateContentPolicy({
        text: 'Bearer Bearer abcdefg',
        policies,
        direction: 'outbound',
      }),
    ).toMatchObject({ action: 'allow', text: 'Bearer Bearer abcdefg' });

    expect(
      evaluateContentPolicy({
        text: 'token sk-1234567890 and sk-123456789',
        policies,
        direction: 'outbound',
      }),
    ).toMatchObject({ action: 'redact', text: 'token [REDACTED] and sk-123456789' });

    expect(
      evaluateContentPolicy({
        text: 'token ghp_1234567890123456 and ghp_123456789012345',
        policies,
        direction: 'outbound',
      }),
    ).toMatchObject({ action: 'redact', text: 'token [REDACTED] and ghp_123456789012345' });
  });

  it('prefers provider key [REDACTED] priority over Bearer *** when overlapping', () => {
    const decision = evaluateContentPolicy({
      text: 'Authorization: Bearer sk-1234567890',
      policies: [secretPolicy('redact')],
      direction: 'outbound',
    });
    expect(decision.action).toBe('redact');
    expect(decision.text).toBe('Authorization: [REDACTED]');
  });

  it('escapes regex metacharacters for keyword policies', () => {
    const decision = evaluateContentPolicy({
      text: 'match a.b[c](d)+?^{}$|\\ literally, not axb[c](d)',
      policies: [
        {
          ...secretPolicy('redact'),
          id: 'pol_kw',
          matchType: 'keyword',
          pattern: 'a.b[c](d)+?^{}$|\\',
        },
      ],
      direction: 'outbound',
    });
    expect(decision.action).toBe('redact');
    expect(decision.text).toBe('match [REDACTED] literally, not axb[c](d)');
  });
});
