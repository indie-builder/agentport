import { randomUUID } from 'node:crypto';
import {
  type AccessScope,
  businessIdSchema,
  DEFAULT_ROLES,
  PERMISSIONS,
  scopeCovers,
  validateGrants,
} from '@agentport/shared';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIsolatedDatabase } from '../../worker/test/isolated-db.js';
import { createDb } from '../src/client.js';
import { newId } from '../src/id.js';
import type { Tx } from '../src/repo/access.js';
import * as access from '../src/repo/access.js';
import * as accounts from '../src/repo/accounts.js';
import * as agentRepo from '../src/repo/agents.js';
import {
  agentMembers,
  agentRuns,
  agents,
  authAccounts,
  authSessions,
  authUsers,
  conversations,
  memoryChanges,
  memoryReviews,
  messages,
  rolePermissions,
  roles,
  userPreferences,
  userRoles,
} from '../src/schema.js';

// 默认角色名称与 systemKey 全局唯一：与其它套件共用库会互相撞种子，必须独享一个库。
const isolated = await createIsolatedDatabase('db_access', process.env.DATABASE_URL ?? '');
const url =
  isolated?.url ?? process.env.DATABASE_URL ?? 'postgres://unreachable@127.0.0.1:1/unavailable';
const { db, pool } = createDb(url);
const ready =
  isolated !== null &&
  (await pool.query('select 1').then(
    () => true,
    () => false,
  ));
if (!ready) await pool.end();

const suffix = randomUUID().slice(0, 8);
const bid = (label: string) => `rbac-${suffix}-${label}`;
const createdBusinessIds: string[] = [];

const roleIdByKey = new Map<string, string>();

function first<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) throw new Error('expected at least one row');
  return row;
}

function roleId(key: string): string {
  const id = roleIdByKey.get(key);
  if (!id) throw new Error(`missing role ${key}`);
  return id;
}

async function seedDefaultRoles() {
  for (const role of DEFAULT_ROLES) {
    const id = newId('role');
    roleIdByKey.set(role.systemKey, id);
    await db.insert(roles).values({ id, name: role.name, systemKey: role.systemKey });
    await db.insert(rolePermissions).values(
      role.grants.map((grant) => ({
        roleId: id,
        permissionId: grant.permissionId,
        scope: grant.scope,
      })),
    );
  }
}

async function createAccount(businessId: string, password = 'correct horse 42') {
  createdBusinessIds.push(businessId);
  return accounts.createAccount(db, {
    businessId,
    username: `user-${businessId}`,
    name: `姓名 ${businessId}`,
    passwordHash: await hashPassword(password),
    restore: false,
  });
}

async function createAgent(businessId: string) {
  const id = newId('agent');
  await db.insert(agents).values({
    id,
    slug: `access-${id.slice(4)}`,
    name: 'access agent',
    model: 'test',
    createdBy: businessId,
    ownerBusinessId: businessId,
  });
  return id;
}

async function createAdmin(label: string) {
  const businessId = bid(label);
  await createAccount(businessId);
  await access.setUserRoles(db, businessId, [roleId('admin')]);
  return businessId;
}

async function activeAdminIds(): Promise<string[]> {
  const rows = await db
    .select({ businessId: userRoles.businessId })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .innerJoin(authUsers, eq(authUsers.businessId, userRoles.businessId))
    .where(and(eq(roles.systemKey, 'admin'), eq(authUsers.disabled, false)));
  return rows.map((row) => row.businessId).sort();
}

/**
 * 第一条变更在事务里拿锁后挂起，第二条从另一连接尝试；此时第一条尚未提交。
 * 没有共享锁时第二条会读到旧状态并同时成功，因此该用例能稳定暴露竞态。
 */
async function overlapAdminMutations(
  first: (tx: Tx) => Promise<unknown>,
  second: () => Promise<unknown>,
): Promise<{ first: boolean; second: boolean }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acquired!: () => void;
  const acquiredGate = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const firstPromise = db
    .transaction(async (tx) => {
      const result = await first(tx);
      acquired();
      await gate;
      return result;
    })
    .then(
      () => true,
      () => false,
    );
  await acquiredGate;
  const secondPromise = second().then(
    () => true,
    () => false,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  return { first: await firstPromise, second: await secondPromise };
}

async function createConversationWithRun(businessId: string, agentId: string) {
  const conversationId = newId('conversation');
  const runId = newId('run');
  await db.insert(conversations).values({
    id: conversationId,
    agentId,
    title: 'private',
    createdBy: businessId,
  });
  await db.insert(agentRuns).values({
    id: runId,
    conversationId,
    agentId,
    subjectKind: 'user',
    initiatedBy: businessId,
  });
  await db.insert(messages).values({
    id: newId('message'),
    conversationId,
    role: 'user',
    senderBusinessId: businessId,
    content: { type: 'text', text: 'secret' },
  });
  await db.insert(memoryReviews).values({
    runId,
    businessId,
    requestKey: `req-${runId}`,
    requestHash: 'hash',
    modelAgentId: agentId,
    target: { kind: 'personal' },
    sources: [{ conversationId }],
    before: { content: null, globs: null },
  });
  await db.insert(memoryChanges).values({
    id: newId('memoryChange'),
    businessId,
    target: { kind: 'personal' },
    before: { content: null, globs: null },
    after: { content: 'remember', globs: null },
  });
  return { conversationId, runId };
}

describe('businessId boundary schema', () => {
  it('accepts unicode business ids up to 160 characters', () => {
    expect(businessIdSchema.safeParse('张三-01').success).toBe(true);
    expect(businessIdSchema.safeParse('a'.repeat(160)).success).toBe(true);
  });

  it('rejects blank, whitespace, control characters and overlong ids', () => {
    for (const value of [
      '',
      'a b',
      ' a',
      'a ',
      'a\nb',
      `a${String.fromCharCode(1)}b`,
      'a'.repeat(161),
    ]) {
      expect(businessIdSchema.safeParse(value).success, value).toBe(false);
    }
  });
});

describe('permission catalog', () => {
  it('ships four default roles with the exact maintenance scopes', () => {
    expect(DEFAULT_ROLES.map((role) => role.systemKey)).toEqual([
      'admin',
      'user',
      'owner',
      'maintainer',
    ]);
    expect(DEFAULT_ROLES[0]?.grants).toHaveLength(PERMISSIONS.length);
    expect(DEFAULT_ROLES[0]?.grants.every((grant) => grant.scope === 'platform')).toBe(true);
    const byKey = new Map(DEFAULT_ROLES.map((role) => [role.systemKey, role]));
    const has = (key: string, permissionId: string, scope: string) =>
      byKey
        .get(key)
        ?.grants.some((grant) => grant.permissionId === permissionId && grant.scope === scope) ??
      false;
    expect(has('user', 'agents.read', 'authorized_agents')).toBe(true);
    expect(has('user', 'agents.config.read', 'maintained_agents')).toBe(false);
    expect(has('owner', 'agents.create', 'own_data')).toBe(true);
    expect(has('owner', 'agents.transfer', 'owned_agents')).toBe(true);
    expect(has('owner', 'agents.transfer', 'maintained_agents')).toBe(false);
    expect(has('maintainer', 'agents.create', 'own_data')).toBe(false);
    expect(has('maintainer', 'eval.execute', 'maintained_agents')).toBe(true);
  });

  it('rejects write grants without their read leaf', () => {
    expect(
      validateGrants([{ permissionId: 'agents.config.update', scope: 'owned_agents' }]),
    ).toContain('agents.config.read');
    expect(validateGrants([{ permissionId: 'accounts.manage', scope: 'platform' }])).toContain(
      'accounts.read',
    );
    expect(
      validateGrants([
        { permissionId: 'agents.config.update', scope: 'owned_agents' },
        { permissionId: 'agents.config.read', scope: 'owned_agents' },
      ]),
    ).toBeNull();
  });

  it('requires read grants to cover the write object scope', () => {
    // 读 W 只覆盖负责人，不覆盖维护范围。
    expect(
      validateGrants([
        { permissionId: 'agents.config.update', scope: 'maintained_agents' },
        { permissionId: 'agents.config.read', scope: 'owned_agents' },
      ]),
    ).toContain('agents.config.read');
    // 维护范围包含负责人范围，读 M 可以覆盖写 W。
    expect(
      validateGrants([
        { permissionId: 'agents.config.update', scope: 'owned_agents' },
        { permissionId: 'agents.config.read', scope: 'maintained_agents' },
      ]),
    ).toBeNull();
    // 负责人同时被授权，读 A 同样覆盖写 W（默认负责人角色正是这样通过校验）。
    expect(
      validateGrants([
        { permissionId: 'agents.bindings.manage', scope: 'owned_agents' },
        { permissionId: 'agents.read', scope: 'authorized_agents' },
      ]),
    ).toBeNull();
    expect(
      validateGrants([
        { permissionId: 'agents.config.update', scope: 'owned_agents' },
        { permissionId: 'agents.config.read', scope: 'platform' },
      ]),
    ).toBeNull();
    // 更窄的读范围不能放大全平台写范围。
    expect(
      validateGrants([
        { permissionId: 'agents.config.update', scope: 'platform' },
        { permissionId: 'agents.config.read', scope: 'owned_agents' },
      ]),
    ).toContain('agents.config.read');
    for (const role of DEFAULT_ROLES) {
      expect(validateGrants(role.grants), role.systemKey).toBeNull();
    }
  });

  it('covers exactly the documented scope matrix', () => {
    const all: AccessScope[] = [
      'own_data',
      'authorized_agents',
      'maintained_agents',
      'owned_agents',
      'platform',
    ];
    const expected: Record<AccessScope, AccessScope[]> = {
      own_data: ['own_data'],
      authorized_agents: ['authorized_agents', 'owned_agents'],
      maintained_agents: ['maintained_agents', 'owned_agents'],
      owned_agents: ['owned_agents'],
      platform: all,
    };
    for (const candidate of all) {
      for (const required of all) {
        expect(scopeCovers(candidate, required), `${candidate} -> ${required}`).toBe(
          expected[candidate].includes(required),
        );
      }
    }
  });
});

describe.skipIf(!ready)('account lifecycle and RBAC repositories', () => {
  beforeAll(async () => {
    await seedDefaultRoles();
  });

  afterAll(async () => {
    // 隔离库每轮重建：先断连接，再删本套件创建的库。
    try {
      await pool.end();
    } finally {
      await isolated?.close();
    }
  });

  it('deletes only credentials, keeps business rows, and restores roles on rebuild', async () => {
    const businessId = bid('rebuild');
    const account = await createAccount(businessId);
    const firstUserId = first(
      await db
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(eq(authUsers.businessId, businessId)),
    ).id;
    expect(firstUserId).not.toBe(businessId);
    expect(account.roles.map((role) => role.systemKey)).toContain('user');

    const agentId = await createAgent(businessId);
    const { conversationId, runId } = await createConversationWithRun(businessId, agentId);
    await db.insert(agentMembers).values({
      agentId,
      businessId,
      canUse: true,
      canMaintain: false,
    });
    await db.insert(userPreferences).values({ businessId, content: 'private memory', revision: 1 });
    const sessionId = randomUUID();
    await db.insert(authSessions).values({
      id: sessionId,
      token: `token-${sessionId}`,
      expiresAt: new Date(Date.now() + 60_000),
      userId: firstUserId,
    });

    const rolesBefore = await db
      .select({ roleId: userRoles.roleId })
      .from(userRoles)
      .where(eq(userRoles.businessId, businessId));

    expect(await accounts.deleteAccount(db, businessId)).toBe(true);
    expect(
      await db.select().from(authUsers).where(eq(authUsers.businessId, businessId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(authAccounts).where(eq(authAccounts.userId, firstUserId)),
    ).toHaveLength(0);
    expect(await db.select().from(authSessions).where(eq(authSessions.id, sessionId))).toHaveLength(
      0,
    );

    // 业务记录和离线身份授权不随认证资料删除。
    expect(await db.select().from(agents).where(eq(agents.id, agentId))).toHaveLength(1);
    expect(
      await db.select().from(conversations).where(eq(conversations.id, conversationId)),
    ).toHaveLength(1);
    expect(await db.select().from(agentRuns).where(eq(agentRuns.id, runId))).toHaveLength(1);
    expect(
      await db.select().from(userPreferences).where(eq(userPreferences.businessId, businessId)),
    ).toHaveLength(1);
    expect(
      await db.select().from(memoryReviews).where(eq(memoryReviews.businessId, businessId)),
    ).toHaveLength(1);
    expect(
      await db.select().from(memoryChanges).where(eq(memoryChanges.businessId, businessId)),
    ).toHaveLength(1);
    expect(
      await db
        .select({ roleId: userRoles.roleId })
        .from(userRoles)
        .where(eq(userRoles.businessId, businessId)),
    ).toEqual(rolesBefore);

    // 有历史但不声明恢复：拒绝，不能悄悄当新人员。
    await expect(
      accounts.createAccount(db, {
        businessId,
        username: `again-${businessId}`,
        name: 'again',
        passwordHash: await hashPassword('correct horse 42'),
        restore: false,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const rebuilt = await accounts.createAccount(db, {
      businessId,
      username: `rebuilt-${businessId}`,
      name: '重建',
      passwordHash: await hashPassword('correct horse 42'),
      restore: true,
    });
    const rebuiltUserId = first(
      await db
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(eq(authUsers.businessId, businessId)),
    ).id;
    expect(rebuiltUserId).not.toBe(firstUserId);
    expect(rebuilt.roles).toEqual(account.roles);

    const identity = await accounts.getIdentity(db, businessId);
    expect(identity).toEqual({ businessId, name: '重建', accountActive: true });

    // restore:true 但没有任何历史：409，不创建空身份。
    await expect(
      accounts.createAccount(db, {
        businessId: bid('missing-history'),
        username: `missing-${suffix}`,
        name: 'missing',
        passwordHash: await hashPassword('correct horse 42'),
        restore: true,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // 旧技术 ID 永不复用：删除后重建的 user/account ID 都是新的随机值。
    expect(rebuiltUserId).not.toBe(firstUserId);
  });

  it('disables accounts, revokes sessions and changes own password through Better Auth hashes', async () => {
    const businessId = bid('password');
    await createAccount(businessId, 'old password 42');
    const user = first(
      await db
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(eq(authUsers.businessId, businessId)),
    );
    const sessionId = randomUUID();
    await db.insert(authSessions).values({
      id: sessionId,
      token: `token-${sessionId}`,
      expiresAt: new Date(Date.now() + 60_000),
      userId: user.id,
    });

    expect(
      await accounts.changeOwnPassword(db, user.id, {
        currentPassword: 'wrong password 42',
        newPassword: 'new password 42',
      }),
    ).toBe(false);
    expect(
      await accounts.changeOwnPassword(db, user.id, {
        currentPassword: 'old password 42',
        newPassword: 'new password 42',
      }),
    ).toBe(true);
    expect(await db.select().from(authSessions).where(eq(authSessions.id, sessionId))).toHaveLength(
      0,
    );
    const credential = first(
      await db
        .select({ hash: authAccounts.password })
        .from(authAccounts)
        .where(eq(authAccounts.userId, user.id)),
    );
    expect(
      await verifyPassword({
        hash: credential.hash ?? '',
        password: 'new password 42',
      }),
    ).toBe(true);

    const disabled = await accounts.setAccountStatus(db, businessId, 'disabled');
    expect(disabled?.status).toBe('disabled');
    // 列表包含停用账户，不能只剩 active。
    const listedWhileDisabled = await accounts.listAccounts(db, {
      q: businessId,
      limit: 10,
      offset: 0,
    });
    expect(listedWhileDisabled.total).toBe(1);
    expect(listedWhileDisabled.items[0]?.status).toBe('disabled');
    // 无搜索词时同样包含停用账户。
    const unfiltered = await accounts.listAccounts(db, { limit: 100, offset: 0 });
    expect(unfiltered.items.some((item) => item.businessId === businessId)).toBe(true);
    expect(
      await db.select().from(authSessions).where(eq(authSessions.userId, user.id)),
    ).toHaveLength(0);
    expect((await accounts.getIdentity(db, businessId))?.accountActive).toBe(false);
    const enabled = await accounts.setAccountStatus(db, businessId, 'active');
    expect(enabled?.status).toBe('active');

    expect(
      await accounts.resetPassword(db, businessId, await hashPassword('reset password 42')),
    ).toBe(true);
    const resetCredential = first(
      await db
        .select({ hash: authAccounts.password })
        .from(authAccounts)
        .where(eq(authAccounts.userId, user.id)),
    );
    expect(
      await verifyPassword({
        hash: resetCredential.hash ?? '',
        password: 'reset password 42',
      }),
    ).toBe(true);
  });

  it('filters experts by the same grant that supplied each scope', async () => {
    const ownerId = bid('owner');
    const maintainerId = bid('maintainer');
    const strangerId = bid('stranger');
    await createAccount(ownerId);
    await createAccount(maintainerId);
    await createAccount(strangerId);
    await access.setUserRoles(db, ownerId, [roleId('owner')]);
    await access.setUserRoles(db, maintainerId, [roleId('maintainer')]);

    const agentId = await createAgent(ownerId);
    expect((await access.getAgentRelation(db, agentId, ownerId)).canUse).toBe(true);
    expect((await access.getAgentRelation(db, agentId, ownerId)).canMaintain).toBe(true);
    expect((await access.getAgentRelation(db, agentId, maintainerId)).canMaintain).toBe(false);

    await access.setAgentMember(db, agentId, {
      businessId: maintainerId,
      canUse: true,
      canMaintain: true,
    });
    expect((await access.getAgentRelation(db, agentId, maintainerId)).canMaintain).toBe(true);

    const ownerRows = await agentRepo.listAgents(db, {
      businessId: ownerId,
      scopes: ['owned_agents'],
    });
    expect(ownerRows.map((row) => row.id)).toContain(agentId);
    const maintainerRows = await agentRepo.listAgents(db, {
      businessId: maintainerId,
      scopes: ['maintained_agents'],
    });
    expect(maintainerRows.map((row) => row.id)).toContain(agentId);
    // maintainer 没有 W 范围，不能因为维护关系拿到负责人级别。
    expect(
      await agentRepo.listAgents(db, { businessId: maintainerId, scopes: ['owned_agents'] }),
    ).toEqual([]);
    expect(
      await agentRepo.listAgents(db, { businessId: strangerId, scopes: ['authorized_agents'] }),
    ).toEqual([]);

    const maintainerGrants = (await access.getUserAccess(db, maintainerId)).grants;
    expect(
      maintainerGrants.some(
        (grant) =>
          grant.permissionId === 'agents.transfer' ||
          grant.permissionId === 'agents.delete' ||
          (grant.permissionId === 'agents.read' && grant.scope === 'owned_agents'),
      ),
    ).toBe(false);
    const ownerGrants = (await access.getUserAccess(db, ownerId)).grants;
    expect(
      ownerGrants.some(
        (grant) => grant.permissionId === 'agents.transfer' && grant.scope === 'owned_agents',
      ),
    ).toBe(true);
  });

  it('saves the role matrix atomically against one revision and protects admin', async () => {
    const adminBusinessId = bid('admin');
    await createAccount(adminBusinessId);
    await access.setUserRoles(db, adminBusinessId, [roleId('admin')]);

    const before = await access.getRoleMatrix(db);
    expect(before.revision).toBeGreaterThanOrEqual(0);
    const adminRole = before.roles.find((role) => role.systemKey === 'admin');
    expect(adminRole).toBeDefined();

    const input = before.roles.map((role) => ({
      id: role.id,
      name: role.name,
      grants: role.grants,
    }));

    const saved = await access.replaceRoleMatrix(db, {
      expectedRevision: before.revision,
      roles: [
        ...input,
        {
          name: `自定义-${suffix}`,
          grants: [{ permissionId: 'overview.read', scope: 'own_data' }],
        },
      ],
    });
    expect(saved.revision).toBe(before.revision + 1);
    expect(saved.roles.some((role) => role.name === `自定义-${suffix}`)).toBe(true);

    // 旧 revision 再保存：409，且不产生半写入。
    await expect(
      access.replaceRoleMatrix(db, { expectedRevision: before.revision, roles: input }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // 省略自定义角色即删除；admin 被省略也保留且矩阵不被改写。
    const current = await access.getRoleMatrix(db);
    const withoutCustom = current.roles
      .filter((role) => role.name !== `自定义-${suffix}`)
      .filter((role) => role.systemKey !== 'admin')
      .map((role) => ({ id: role.id, name: role.name, grants: role.grants }));
    const next = await access.replaceRoleMatrix(db, {
      expectedRevision: current.revision,
      roles: withoutCustom,
    });
    expect(next.roles.some((role) => role.name === `自定义-${suffix}`)).toBe(false);
    const keptAdmin = next.roles.find((role) => role.systemKey === 'admin');
    expect(keptAdmin?.grants).toHaveLength(PERMISSIONS.length);

    // 最后管理员：移除角色、停用、删除都在同一事务守卫内被拒绝。
    await expect(access.setUserRoles(db, adminBusinessId, [])).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(accounts.setAccountStatus(db, adminBusinessId, 'disabled')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(accounts.deleteAccount(db, adminBusinessId)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('keeps at least one active admin when concurrent mutations would remove all', async () => {
    const a = await createAdmin('race-a');
    const b = await createAdmin('race-b');
    // 前面的用例可能留下其它管理员；只保留 A、B，计数才有判别力。
    for (const other of (await activeAdminIds()).filter((id) => id !== a && id !== b)) {
      await access.setUserRoles(db, other, []);
    }
    expect(await activeAdminIds()).toEqual([a, b].sort());
    const secondConnection = createDb(isolated?.url ?? url);
    try {
      // 停用 A 与删除 B 同时进行：先拿锁的事务提交后，另一条必须看到结果并拒绝。
      const firstRound = await overlapAdminMutations(
        (tx) => accounts.setAccountStatus(tx, a, 'disabled'),
        () => accounts.deleteAccount(secondConnection.db, b),
      );
      expect([firstRound.first, firstRound.second].filter(Boolean)).toHaveLength(1);
      const survivors = await activeAdminIds();
      expect(survivors).toHaveLength(1);
      const survivor = survivors[0];
      if (!survivor) throw new Error('expected one active admin');

      // 撤掉 C 的管理员角色与停用现存管理员交错，同样只能成功一项。
      const c = await createAdmin('race-c');
      const secondRound = await overlapAdminMutations(
        (tx) => access.setUserRoles(tx, c, [roleId('user')]),
        () => accounts.setAccountStatus(secondConnection.db, survivor, 'disabled'),
      );
      expect([secondRound.first, secondRound.second].filter(Boolean)).toHaveLength(1);
      expect(await activeAdminIds()).toHaveLength(1);
    } finally {
      await secondConnection.pool.end();
    }
  });

  it('swaps role names through temporary names without violating uniqueness', async () => {
    const before = await access.getRoleMatrix(db);
    const created = await access.replaceRoleMatrix(db, {
      expectedRevision: before.revision,
      roles: [
        ...before.roles.map((role) => ({ id: role.id, name: role.name, grants: role.grants })),
        {
          name: `swap-a-${suffix}`,
          grants: [{ permissionId: 'overview.read', scope: 'own_data' }],
        },
        {
          name: `swap-b-${suffix}`,
          grants: [{ permissionId: 'overview.read', scope: 'own_data' }],
        },
      ],
    });
    const a = created.roles.find((role) => role.name === `swap-a-${suffix}`);
    const b = created.roles.find((role) => role.name === `swap-b-${suffix}`);
    if (!a || !b) throw new Error('expected both swap roles');

    const swapped = await access.replaceRoleMatrix(db, {
      expectedRevision: created.revision,
      roles: created.roles.map((role) => ({
        id: role.id,
        name:
          role.id === a.id ? `swap-b-${suffix}` : role.id === b.id ? `swap-a-${suffix}` : role.name,
        grants: role.grants,
      })),
    });
    expect(swapped.roles.find((role) => role.id === a.id)?.name).toBe(`swap-b-${suffix}`);
    expect(swapped.roles.find((role) => role.id === b.id)?.name).toBe(`swap-a-${suffix}`);
  });

  it('renames around a user-occupied pending name instead of colliding', async () => {
    const before = await access.getRoleMatrix(db);
    const created = await access.replaceRoleMatrix(db, {
      expectedRevision: before.revision,
      roles: [
        ...before.roles.map((role) => ({ id: role.id, name: role.name, grants: role.grants })),
        {
          name: `occupied-a-${suffix}`,
          grants: [{ permissionId: 'overview.read', scope: 'own_data' }],
        },
      ],
    });
    const a = created.roles.find((role) => role.name === `occupied-a-${suffix}`);
    if (!a) throw new Error('expected occupied-a role');

    // 用户合法占用 A 的临时名位置。
    const occupiedName = `__pending_${a.id}`;
    const withOccupied = await access.replaceRoleMatrix(db, {
      expectedRevision: created.revision,
      roles: [
        ...created.roles.map((role) => ({ id: role.id, name: role.name, grants: role.grants })),
        { name: occupiedName, grants: [{ permissionId: 'overview.read', scope: 'own_data' }] },
      ],
    });
    const occupied = withOccupied.roles.find((role) => role.name === occupiedName);
    if (!occupied) throw new Error('expected occupied pending role');

    const renamed = await access.replaceRoleMatrix(db, {
      expectedRevision: withOccupied.revision,
      roles: withOccupied.roles.map((role) => ({
        id: role.id,
        name: role.id === a.id ? `occupied-a-renamed-${suffix}` : role.name,
        grants: role.grants,
      })),
    });
    expect(renamed.roles.find((role) => role.id === a.id)?.name).toBe(
      `occupied-a-renamed-${suffix}`,
    );
    expect(renamed.roles.find((role) => role.id === occupied.id)?.name).toBe(occupiedName);
  });
});
