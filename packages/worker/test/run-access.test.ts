import { describe, expect, it } from 'vitest';
import {
  type AgentRelation,
  agentPermissionAllows,
  runExecutionSubject,
} from '../src/run-access.js';

const owner: AgentRelation = {
  exists: true,
  ownerBusinessId: 'owner-a',
  canUse: true,
  canMaintain: true,
};
const member: AgentRelation = {
  exists: true,
  ownerBusinessId: 'owner-a',
  canUse: true,
  canMaintain: false,
};
const outsider: AgentRelation = {
  exists: true,
  ownerBusinessId: 'owner-a',
  canUse: false,
  canMaintain: false,
};
const missing: AgentRelation = {
  exists: false,
  ownerBusinessId: null,
  canUse: false,
  canMaintain: false,
};

describe('runExecutionSubject', () => {
  it('reads only the matching user or service fields', () => {
    expect(
      runExecutionSubject({ subjectKind: 'user', initiatedBy: 'user-a', serviceId: null }),
    ).toEqual({ kind: 'user', businessId: 'user-a' });
    expect(
      runExecutionSubject({ subjectKind: 'service', initiatedBy: null, serviceId: 'mcp' }),
    ).toEqual({ kind: 'service', serviceId: 'mcp' });
  });

  it('rejects mixed or incomplete subject rows instead of guessing', () => {
    expect(runExecutionSubject({ subjectKind: 'user', initiatedBy: null, serviceId: null })).toBe(
      null,
    );
    expect(
      runExecutionSubject({ subjectKind: 'service', initiatedBy: 'user-a', serviceId: 'mcp' }),
    ).toBe(null);
    expect(
      runExecutionSubject({ subjectKind: 'service', initiatedBy: null, serviceId: null }),
    ).toBe(null);
    expect(
      runExecutionSubject({ subjectKind: 'unknown', initiatedBy: 'user-a', serviceId: null }),
    ).toBe(null);
  });
});

describe('agentPermissionAllows', () => {
  it('requires the same grant to match the permission leaf and object scope', () => {
    expect(
      agentPermissionAllows(
        [{ permissionId: 'agents.use', scope: 'authorized_agents' }],
        'agents.use',
        member,
        'member-a',
      ),
    ).toBe(true);
    expect(
      agentPermissionAllows(
        [{ permissionId: 'agents.use', scope: 'authorized_agents' }],
        'agents.use',
        outsider,
        'outsider-a',
      ),
    ).toBe(false);
    // 另一个叶的授权不能拼成这个叶的权限。
    expect(
      agentPermissionAllows(
        [{ permissionId: 'schedules.manage', scope: 'owned_agents' }],
        'agents.use',
        owner,
        'owner-a',
      ),
    ).toBe(false);
  });

  it('maps each scope to its real object relation', () => {
    const grants = (
      scope: 'authorized_agents' | 'maintained_agents' | 'owned_agents' | 'platform',
    ) => [{ permissionId: 'schedules.manage' as const, scope }];
    expect(
      agentPermissionAllows(grants('authorized_agents'), 'schedules.manage', member, 'member-a'),
    ).toBe(true);
    expect(
      agentPermissionAllows(
        grants('authorized_agents'),
        'schedules.manage',
        outsider,
        'outsider-a',
      ),
    ).toBe(false);
    expect(
      agentPermissionAllows(grants('maintained_agents'), 'schedules.manage', member, 'member-a'),
    ).toBe(false);
    expect(
      agentPermissionAllows(grants('owned_agents'), 'schedules.manage', owner, 'owner-a'),
    ).toBe(true);
    expect(
      agentPermissionAllows(grants('owned_agents'), 'schedules.manage', member, 'member-a'),
    ).toBe(false);
    expect(
      agentPermissionAllows(grants('platform'), 'schedules.manage', outsider, 'outsider-a'),
    ).toBe(true);
  });

  it('never allows a missing agent even with a platform grant', () => {
    expect(
      agentPermissionAllows(
        [{ permissionId: 'agents.use', scope: 'platform' }],
        'agents.use',
        missing,
        'admin-a',
      ),
    ).toBe(false);
  });
});
