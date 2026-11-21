import { describe, expect, it } from 'bun:test';
import {
  type ApprovalContext,
  type ApprovalRuleSelector,
  evaluateToolApproval,
} from '../src/tool-approval-policy.js';

function rule(patch: Partial<ApprovalRuleSelector> = {}): ApprovalRuleSelector {
  return {
    id: 'tap_a',
    version: 1,
    approvalMode: 'ask',
    agentId: null,
    serverId: null,
    toolId: null,
    role: null,
    httpMethod: null,
    pathTemplate: null,
    enabled: true,
    ...patch,
  };
}

const ctx: ApprovalContext = {
  agentId: 'agt_1',
  serverId: 'srv_1',
  toolId: 'tool_1',
  method: 'GET',
  pathTemplate: '/users/{id}',
  roles: ['agent:owner', 'platform:role_admin'],
};

describe('evaluateToolApproval', () => {
  it('escalates monotonically from allow to ask to deny', () => {
    const allow = evaluateToolApproval(
      'allow',
      [rule({ id: 'tap_a', approvalMode: 'allow' })],
      ctx,
    );
    expect(allow.effectiveMode).toBe('allow');

    const ask = evaluateToolApproval(
      'allow',
      [rule({ id: 'tap_a', approvalMode: 'allow' }), rule({ id: 'tap_b', approvalMode: 'ask' })],
      ctx,
    );
    expect(ask.effectiveMode).toBe('ask');

    const deny = evaluateToolApproval(
      'allow',
      [rule({ id: 'tap_b', approvalMode: 'ask' }), rule({ id: 'tap_c', approvalMode: 'deny' })],
      ctx,
    );
    expect(deny.effectiveMode).toBe('deny');
  });

  it('does not let an allow rule relax an ask baseline', () => {
    const decision = evaluateToolApproval('ask', [rule({ approvalMode: 'allow' })], ctx);
    expect(decision.effectiveMode).toBe('ask');
  });

  it('is deterministic regardless of rule order', () => {
    const rules = [
      rule({ id: 'tap_b', approvalMode: 'ask' }),
      rule({ id: 'tap_a', approvalMode: 'deny' }),
      rule({ id: 'tap_c', approvalMode: 'allow' }),
    ];
    const forward = evaluateToolApproval('allow', rules, ctx);
    const reversed = evaluateToolApproval('allow', [...rules].reverse(), ctx);
    expect(reversed).toEqual(forward);
    expect(forward.matchedRules.map((entry) => entry.id)).toEqual(['tap_a', 'tap_b', 'tap_c']);
  });

  it('keeps the baseline when nothing matches', () => {
    const decision = evaluateToolApproval('ask', [rule({ serverId: 'srv_other' })], ctx);
    expect(decision.effectiveMode).toBe('ask');
    expect(decision.matchedRules).toEqual([]);
    expect(decision.baseline).toBe('ask');
  });

  it('ignores disabled rules', () => {
    const decision = evaluateToolApproval(
      'allow',
      [rule({ approvalMode: 'deny', enabled: false })],
      ctx,
    );
    expect(decision.effectiveMode).toBe('allow');
    expect(decision.matchedRules).toEqual([]);
  });

  it('matches method and path template exactly', () => {
    const hit = evaluateToolApproval(
      'allow',
      [rule({ id: 'tap_m', httpMethod: 'GET', pathTemplate: '/users/{id}' })],
      ctx,
    );
    expect(hit.matchedRules).toHaveLength(1);

    for (const selector of [{ httpMethod: 'POST' }, { pathTemplate: '/users' }] satisfies Array<
      Partial<ApprovalRuleSelector>
    >) {
      const miss = evaluateToolApproval('allow', [rule(selector)], ctx);
      expect(miss.matchedRules).toEqual([]);
    }
  });

  it('matches roles only when the context carries the role', () => {
    const hit = evaluateToolApproval('allow', [rule({ role: 'agent:owner' })], ctx);
    expect(hit.effectiveMode).toBe('ask');

    const miss = evaluateToolApproval('allow', [rule({ role: 'channel:viewer' })], ctx);
    expect(miss.effectiveMode).toBe('allow');
  });

  it('changes the hash with version, roles and effective mode', () => {
    const base = evaluateToolApproval('allow', [rule({ version: 1 })], ctx);
    const versioned = evaluateToolApproval('allow', [rule({ version: 2 })], ctx);
    const roleChange = evaluateToolApproval('allow', [rule({ version: 1 })], {
      ...ctx,
      roles: [...ctx.roles, 'channel:member'],
    });
    const modeChange = evaluateToolApproval(
      'allow',
      [rule({ version: 1, approvalMode: 'deny' })],
      ctx,
    );

    expect(
      new Set([
        base.decisionHash,
        versioned.decisionHash,
        roleChange.decisionHash,
        modeChange.decisionHash,
      ]).size,
    ).toBe(4);
  });

  it('returns the baseline with a stable hash for an empty rule set', () => {
    const first = evaluateToolApproval('ask', [], ctx);
    const second = evaluateToolApproval('ask', [], ctx);
    expect(first.effectiveMode).toBe('ask');
    expect(first.matchedRules).toEqual([]);
    expect(first.decisionHash).toBe(second.decisionHash);
    expect(first.decisionHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
