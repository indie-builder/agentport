import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@agentport/db';
import type { PermissionGrant } from '@agentport/shared';
import { hashPassword } from 'better-auth/crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIsolatedDatabase } from '../../worker/test/isolated-db.js';
import { AUTH_COOKIE } from '../src/features/auth/types.js';
import {
  cleanup,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';
import { FakeSessionCloser, startSessionCleanupResponder } from './session-cleanup-responder.js';

const ready = await infraReady;
// 删除会持有共享库的绑定锁；独享库避免与同轮其它删除套件的长等待互相超时。
const isolated = ready ? await createIsolatedDatabase('agents_access') : null;
const PASSWORD = 'agent-pass-123';

type SeededAccount = {
  businessId: string;
  username: string;
  cookie: string;
};

async function hash(password: string): Promise<string> {
  return hashPassword(password);
}

describe.skipIf(!ready || isolated === null)('agents access control', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let adminBusinessId: string;
  const roleIds: Record<string, string> = {};
  const seeded: string[] = [];
  const customRoles: string[] = [];
  const agentSlugs: string[] = [];
  let workspaces: string;
  let sessions: Awaited<ReturnType<typeof startSessionCleanupResponder>>;

  const seedAccount = async (input: {
    label: string;
    roles: string[];
    disabled?: boolean;
  }): Promise<SeededAccount> => {
    const businessId = `biz-${input.label}-${randomUUID().slice(0, 8)}`;
    const username = `user-${input.label}-${randomUUID().slice(0, 8)}`;
    const authUserId = randomUUID();
    await app.pool.query(
      `insert into "user" (id, name, email, email_verified, username, business_id, disabled, created_at, updated_at)
       values ($1, $2, $3, true, $4, $5, $6, now(), now())`,
      [
        authUserId,
        `${input.label} 名称`,
        `${authUserId}@agentport.invalid`,
        username,
        businessId,
        input.disabled ?? false,
      ],
    );
    await app.pool.query(
      `insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at)
       values ($1, $2, 'credential', $3, $4, now(), now())`,
      [randomUUID(), authUserId, authUserId, await hash(PASSWORD)],
    );
    for (const roleId of input.roles) {
      await app.pool.query('insert into user_roles (business_id, role_id) values ($1, $2)', [
        businessId,
        roleId,
      ]);
    }
    seeded.push(businessId);
    return { businessId, username, cookie: '' };
  };

  const loginAs = async (account: SeededAccount): Promise<string> => {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: account.username, password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(200);
    const cookie = res.cookies.find((entry) => entry.name === AUTH_COOKIE);
    if (!cookie) throw new Error('login did not set the auth cookie');
    return `${cookie.name}=${cookie.value}`;
  };

  const createRole = async (name: string, grants: PermissionGrant[]): Promise<string> => {
    const id = newId('role');
    await app.pool.query(
      'insert into roles (id, name, system_key, created_at, updated_at) values ($1, $2, null, now(), now())',
      [id, name],
    );
    for (const grant of grants) {
      await app.pool.query(
        'insert into role_permissions (role_id, permission_id, scope) values ($1, $2, $3)',
        [id, grant.permissionId, grant.scope],
      );
    }
    customRoles.push(id);
    return id;
  };

  const createAs = (cookie: string, payload: Record<string, unknown> = {}) => {
    const slug = (payload.slug as string | undefined) ?? unique('agent');
    agentSlugs.push(slug);
    return inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: { cookie },
      payload: { slug, name: `Agent ${slug}`, ...payload },
    });
  };

  const createAgentFor = async (cookie: string, payload: Record<string, unknown> = {}) => {
    const res = await createAs(cookie, payload);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string; slug: string }>();
  };

  let owner1: SeededAccount;
  let owner2: SeededAccount;
  let viewer: SeededAccount;
  let maintainer: SeededAccount;

  beforeAll(async () => {
    if (!isolated) throw new Error('isolated database missing');
    // macOS 的 tmpdir 是符号链接；记忆文件写入会拒绝符号链接路径。
    workspaces = await mkdtemp(join(await realpath(tmpdir()), 'agents-access-'));
    app = await startApp({ WORKSPACES_DIR: workspaces, DATABASE_URL: isolated.url });
    sessions = await startSessionCleanupResponder(app, new FakeSessionCloser());
    // 首次登录触发 bootstrap，播种四个默认角色。
    adminCookie = await loginCookie(app);
    adminBusinessId = (
      await app.pool.query<{ business_id: string }>(
        'select business_id from "user" where username = $1',
        ['admin'],
      )
    ).rows[0]?.business_id as string;
    expect(adminBusinessId).toBeTruthy();

    const roles = await app.pool.query<{ id: string; system_key: string }>(
      'select id, system_key from roles where system_key is not null',
    );
    for (const row of roles.rows) roleIds[row.system_key] = row.id;

    owner1 = await seedAccount({ label: 'owner1', roles: [roleIds.owner as string] });
    owner2 = await seedAccount({ label: 'owner2', roles: [roleIds.owner as string] });
    viewer = await seedAccount({ label: 'viewer', roles: [roleIds.user as string] });
    maintainer = await seedAccount({
      label: 'maint',
      roles: [roleIds.maintainer as string],
    });
    owner1.cookie = await loginAs(owner1);
    owner2.cookie = await loginAs(owner2);
    viewer.cookie = await loginAs(viewer);
    maintainer.cookie = await loginAs(maintainer);
  });

  afterAll(async () => {
    await sessions.close();
    await cleanup(app, { agentSlugs });
    for (const businessId of seeded) {
      await app.pool.query('delete from user_roles where business_id = $1', [businessId]);
      await app.pool.query('delete from "user" where business_id = $1', [businessId]);
    }
    for (const roleId of customRoles) {
      await app.pool.query('delete from roles where id = $1', [roleId]);
    }
    await app.pool.query('delete from audit_log where actor = any($1::text[])', [seeded]);
    await app.close();
    await isolated?.close();
    await rm(workspaces, { recursive: true, force: true });
  });

  it('lists only readable summaries and keeps prompts and bindings out of the list', async () => {
    const created = await createAs(owner1.cookie, { systemPrompt: 'TOP-SECRET-PROMPT' });
    expect(created.statusCode, created.body).toBe(201);
    const agent = created.json<{ id: string }>();

    const own = await inject(app, {
      method: 'GET',
      url: '/api/agents',
      headers: { cookie: owner1.cookie },
    });
    expect(own.statusCode, own.body).toBe(200);
    const item = own.json<Array<Record<string, unknown>>>().find((entry) => entry.id === agent.id);
    expect(item).toBeTruthy();
    expect(Object.keys(item ?? {}).sort()).toEqual([
      'createdAt',
      'createdBy',
      'description',
      'enabled',
      'id',
      'model',
      'name',
      'ownerBusinessId',
      'parentId',
      'role',
      'slug',
      'uiFormat',
    ]);
    for (const key of [
      'systemPrompt',
      'serverIds',
      'skillIds',
      'subAgentIds',
      'pluginBindings',
      'allowedTools',
      'disallowedTools',
      'runtimeEnvironmentId',
      'maxBudgetUsd',
      'timeoutMs',
    ]) {
      expect(item).not.toHaveProperty(key);
    }
    expect(own.body).not.toContain('TOP-SECRET-PROMPT');

    const detail = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}`,
      headers: { cookie: owner1.cookie },
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json<{ systemPrompt: string }>().systemPrompt).toBe('TOP-SECRET-PROMPT');

    // 无关用户列表里看不到；没有配置读取叶的用户连详情入口都不可用。
    const strangerList = await inject(app, {
      method: 'GET',
      url: '/api/agents',
      headers: { cookie: viewer.cookie },
    });
    expect(strangerList.statusCode, strangerList.body).toBe(200);
    expect(strangerList.json<Array<{ id: string }>>().some((entry) => entry.id === agent.id)).toBe(
      false,
    );

    const strangerDetail = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}`,
      headers: { cookie: viewer.cookie },
    });
    expectProblem(strangerDetail, 'FORBIDDEN');

    const adminDetail = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}`,
      headers: { cookie: adminCookie },
    });
    expect(adminDetail.statusCode, adminDetail.body).toBe(200);
  });

  it('writes createdBy and ownerBusinessId on the server and rejects forged values', async () => {
    const forgedSlug = unique('forged');
    const forged = await createAs(owner1.cookie, {
      slug: forgedSlug,
      createdBy: 'mallory',
      ownerBusinessId: 'mallory',
    });
    expectProblem(forged, 'INVALID_INPUT');

    const agent = await createAgentFor(owner1.cookie);
    const row = await app.pool.query<{ created_by: string; owner_business_id: string }>(
      'select created_by, owner_business_id from agents where id = $1',
      [agent.id],
    );
    expect(row.rows[0]).toEqual({
      created_by: owner1.businessId,
      owner_business_id: owner1.businessId,
    });
  });

  it('lets a maintainer edit content but not members, transfer or delete', async () => {
    const agent = await createAgentFor(owner1.cookie);

    const grant = await inject(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/members/${maintainer.businessId}`,
      headers: { cookie: owner1.cookie },
      payload: { canUse: true, canMaintain: true },
    });
    expect(grant.statusCode, grant.body).toBe(200);
    expect(grant.json()).toMatchObject({
      businessId: maintainer.businessId,
      canUse: true,
      canMaintain: true,
    });

    const config = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: { cookie: maintainer.cookie },
      payload: { description: 'maintained by member' },
    });
    expect(config.statusCode, config.body).toBe(200);

    for (const [method, url, payload] of [
      ['GET', `/api/agents/${agent.id}/members`, undefined],
      ['DELETE', `/api/agents/${agent.id}`, undefined],
      ['POST', `/api/agents/${agent.id}/transfer`, { ownerBusinessId: maintainer.businessId }],
    ] as const) {
      const denied = await inject(app, {
        method,
        url,
        headers: { cookie: maintainer.cookie },
        ...(payload === undefined ? {} : { payload }),
      });
      expect(denied.statusCode, `${method} ${url}: ${denied.body}`).toBe(403);
      expect(denied.json<{ code: string }>().code).toBe('FORBIDDEN');
    }

    // 维护范围可以读取配置、规则、记忆、版本和完整文件。
    for (const url of [
      `/api/agents/${agent.id}`,
      `/api/agents/${agent.id}/rules`,
      `/api/agents/${agent.id}/output-styles`,
      `/api/agents/${agent.id}/memory`,
      `/api/agents/${agent.id}/versions`,
      `/api/agents/${agent.id}/files`,
    ]) {
      const read = await inject(app, {
        method: 'GET',
        url,
        headers: { cookie: maintainer.cookie },
      });
      expect(read.statusCode, `${url}: ${read.body}`).toBe(200);
    }
  });

  it('requires management scope on both sides of a sub-agent binding', async () => {
    const parent = await createAgentFor(owner1.cookie);
    const ownChild = await createAgentFor(owner1.cookie);
    const foreignChild = await createAgentFor(owner2.cookie);

    const ownBind = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${parent.id}`,
      headers: { cookie: owner1.cookie },
      payload: { subAgentIds: [ownChild.id] },
    });
    expect(ownBind.statusCode, ownBind.body).toBe(200);

    const foreignBind = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${parent.id}`,
      headers: { cookie: owner1.cookie },
      payload: { subAgentIds: [foreignChild.id] },
    });
    expect(foreignBind.statusCode, foreignBind.body).toBe(404);

    const stillBound = await app.pool.query<{ parent_id: string | null }>(
      'select parent_id from agents where id = $1',
      [foreignChild.id],
    );
    expect(stillBound.rows[0]?.parent_id).toBeNull();
  });

  it('hides other owners objects once the scope does not match', async () => {
    const agent = await createAgentFor(owner1.cookie);

    for (const [method, url, payload] of [
      ['GET', `/api/agents/${agent.id}`, undefined],
      ['GET', `/api/agents/${agent.id}/rules`, undefined],
      ['PATCH', `/api/agents/${agent.id}`, { description: 'hijack' }],
      ['DELETE', `/api/agents/${agent.id}`, undefined],
      ['POST', `/api/agents/${agent.id}/transfer`, { ownerBusinessId: owner2.businessId }],
    ] as const) {
      const denied = await inject(app, {
        method,
        url,
        headers: { cookie: owner2.cookie },
        ...(payload === undefined ? {} : { payload }),
      });
      expect(denied.statusCode, `${method} ${url}: ${denied.body}`).toBe(404);
    }

    const stillThere = await app.pool.query('select id from agents where id = $1', [agent.id]);
    expect(stillThere.rows).toHaveLength(1);
  });

  it('does not merge write and read scopes from different roles on one object', async () => {
    const agent = await createAgentFor(owner1.cookie);
    const makeMaintainer = async (label: string, roleId: string) => {
      const account = await seedAccount({ label, roles: [roleId] });
      account.cookie = await loginAs(account);
      await app.pool.query(
        'insert into agent_members (agent_id, business_id, can_use, can_maintain, created_at) values ($1, $2, false, true, now())',
        [agent.id, account.businessId],
      );
      return account;
    };

    // 维护关系能写，但读取叶只给被授权专家范围，两条不同范围的 grant 不能拼接。
    const cantRead = await makeMaintainer(
      'cant-read',
      await createRole(`cant-read-${randomUUID().slice(0, 6)}`, [
        { permissionId: 'agents.read', scope: 'maintained_agents' },
        { permissionId: 'agents.config.update', scope: 'maintained_agents' },
        { permissionId: 'agents.config.read', scope: 'authorized_agents' },
      ]),
    );
    const readDenied = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: { cookie: cantRead.cookie },
      payload: { description: 'read mismatch' },
    });
    expect(readDenied.statusCode, readDenied.body).toBe(404);

    // 读取与依赖都满足，但写叶只给被授权专家范围，维护关系不能写。
    const cantWrite = await makeMaintainer(
      'cant-write',
      await createRole(`cant-write-${randomUUID().slice(0, 6)}`, [
        { permissionId: 'agents.read', scope: 'maintained_agents' },
        { permissionId: 'agents.config.read', scope: 'maintained_agents' },
        { permissionId: 'agents.config.update', scope: 'authorized_agents' },
      ]),
    );
    const writeDenied = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: { cookie: cantWrite.cookie },
      payload: { description: 'write mismatch' },
    });
    expect(writeDenied.statusCode, writeDenied.body).toBe(404);

    const matched = await makeMaintainer(
      'matched',
      await createRole(`matched-${randomUUID().slice(0, 6)}`, [
        { permissionId: 'agents.read', scope: 'maintained_agents' },
        { permissionId: 'agents.config.read', scope: 'maintained_agents' },
        { permissionId: 'agents.config.update', scope: 'maintained_agents' },
      ]),
    );
    const allowed = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: { cookie: matched.cookie },
      payload: { description: 'same scope' },
    });
    expect(allowed.statusCode, allowed.body).toBe(200);

    const stored = await app.pool.query<{ description: string }>(
      'select description from agents where id = $1',
      [agent.id],
    );
    expect(stored.rows[0]?.description).toBe('same scope');
  });

  it('requires both the declared leaf and the binding leaf on a combined patch', async () => {
    const updateRole = await createRole(`update-only-${randomUUID().slice(0, 6)}`, [
      { permissionId: 'agents.read', scope: 'maintained_agents' },
      { permissionId: 'agents.config.read', scope: 'maintained_agents' },
      { permissionId: 'agents.config.update', scope: 'maintained_agents' },
    ]);
    const comboSingle = await seedAccount({ label: 'update-only', roles: [updateRole] });
    comboSingle.cookie = await loginAs(comboSingle);
    const agent = await createAgentFor(owner1.cookie, { description: 'initial' });
    await app.pool.query(
      'insert into agent_members (agent_id, business_id, can_use, can_maintain, created_at) values ($1, $2, true, true, now())',
      [agent.id, comboSingle.businessId],
    );

    // 同一请求同时带配置与绑定字段：配置叶通过，但缺少绑定叶，整体拒绝且不写部分字段。
    const denied = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: { cookie: comboSingle.cookie },
      payload: { description: 'config plus binding', serverIds: [] },
    });
    expect(denied.statusCode, denied.body).toBe(403);

    const description = await app.pool.query<{ description: string }>(
      'select description from agents where id = $1',
      [agent.id],
    );
    expect(description.rows[0]?.description).toBe('initial');
  });

  it('manages members, transfers ownership and keeps createdBy unchanged', async () => {
    const agent = await createAgentFor(owner1.cookie);

    const members = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}/members`,
      headers: { cookie: owner1.cookie },
    });
    expect(members.statusCode, members.body).toBe(200);
    expect(members.json()).toEqual({ ownerBusinessId: owner1.businessId, members: [] });

    const unregistered = await inject(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/members/never-registered`,
      headers: { cookie: owner1.cookie },
      payload: { canUse: true, canMaintain: false },
    });
    expectProblem(unregistered, 'INVALID_INPUT');

    const invalidMember = await inject(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/members/${maintainer.businessId}`,
      headers: { cookie: owner1.cookie },
      payload: { canUse: false, canMaintain: false },
    });
    expectProblem(invalidMember, 'INVALID_INPUT');

    const added = await inject(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/members/${maintainer.businessId}`,
      headers: { cookie: owner1.cookie },
      payload: { canUse: true, canMaintain: false },
    });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json()).toMatchObject({ businessId: maintainer.businessId, canUse: true });

    const removed = await inject(app, {
      method: 'DELETE',
      url: `/api/agents/${agent.id}/members/${maintainer.businessId}`,
      headers: { cookie: owner1.cookie },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json()).toEqual({ ok: true });

    // 无创建权限的账户不能接任负责人。
    const toViewer = await inject(app, {
      method: 'POST',
      url: `/api/agents/${agent.id}/transfer`,
      headers: { cookie: owner1.cookie },
      payload: { ownerBusinessId: viewer.businessId },
    });
    expectProblem(toViewer, 'INVALID_INPUT');

    const disabledOwner = await seedAccount({
      label: 'disabled-owner',
      roles: [roleIds.owner as string],
      disabled: true,
    });
    const toDisabled = await inject(app, {
      method: 'POST',
      url: `/api/agents/${agent.id}/transfer`,
      headers: { cookie: owner1.cookie },
      payload: { ownerBusinessId: disabledOwner.businessId },
    });
    expectProblem(toDisabled, 'INVALID_INPUT');

    const transferred = await inject(app, {
      method: 'POST',
      url: `/api/agents/${agent.id}/transfer`,
      headers: { cookie: owner1.cookie },
      payload: { ownerBusinessId: owner2.businessId },
    });
    expect(transferred.statusCode, transferred.body).toBe(200);

    const row = await app.pool.query<{ created_by: string; owner_business_id: string }>(
      'select created_by, owner_business_id from agents where id = $1',
      [agent.id],
    );
    expect(row.rows[0]).toEqual({
      created_by: owner1.businessId,
      owner_business_id: owner2.businessId,
    });

    // 原负责人失去管理权；新负责人可继续配置。
    const oldOwner = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: { cookie: owner1.cookie },
      payload: { description: 'old owner' },
    });
    expect(oldOwner.statusCode, oldOwner.body).toBe(404);

    const newOwner = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: { cookie: owner2.cookie },
      payload: { description: 'new owner' },
    });
    expect(newOwner.statusCode, newOwner.body).toBe(200);
  });

  it('serves evaluated permissions per object and restricts identity search to the owner', async () => {
    const agent = await createAgentFor(owner1.cookie);
    await inject(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/members/${maintainer.businessId}`,
      headers: { cookie: owner1.cookie },
      payload: { canUse: true, canMaintain: true },
    });

    const ownerAccess = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}/access`,
      headers: { cookie: owner1.cookie },
    });
    expect(ownerAccess.statusCode, ownerAccess.body).toBe(200);
    expect(ownerAccess.json<{ permissionIds: string[] }>().permissionIds).toEqual(
      expect.arrayContaining([
        'agents.read',
        'agents.config.read',
        'agents.config.update',
        'agents.members.manage',
        'agents.transfer',
        'agents.delete',
      ]),
    );

    const maintainerAccess = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}/access`,
      headers: { cookie: maintainer.cookie },
    });
    expect(maintainerAccess.statusCode, maintainerAccess.body).toBe(200);
    const maintainerPermissions = maintainerAccess.json<{ permissionIds: string[] }>()
      .permissionIds;
    expect(maintainerPermissions).toEqual(
      expect.arrayContaining(['agents.config.update', 'agents.rules.write', 'agents.memory.write']),
    );
    for (const forbidden of [
      'agents.members.manage',
      'agents.transfer',
      'agents.delete',
      'agents.create',
    ]) {
      expect(maintainerPermissions).not.toContain(forbidden);
    }

    const strangerAccess = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}/access`,
      headers: { cookie: owner2.cookie },
    });
    expect(strangerAccess.statusCode, strangerAccess.body).toBe(404);

    const identities = await inject(app, {
      method: 'GET',
      url: `/api/identities?agentId=${encodeURIComponent(agent.id)}&q=`,
      headers: { cookie: owner1.cookie },
    });
    expect(identities.statusCode, identities.body).toBe(200);
    const items = identities.json<{
      items: Array<{ businessId: string; name: string; accountActive: boolean }>;
    }>().items;
    expect(items.some((entry) => entry.businessId === maintainer.businessId)).toBe(true);
    // 停用账户仍可作为历史身份出现，但明确标记为不可用。
    const disabledOwner = seeded.find((businessId) => businessId.startsWith('biz-disabled-owner-'));
    if (disabledOwner !== undefined) {
      expect(items.find((entry) => entry.businessId === disabledOwner)).toMatchObject({
        accountActive: false,
      });
    }

    const maintainerSearch = await inject(app, {
      method: 'GET',
      url: `/api/identities?agentId=${encodeURIComponent(agent.id)}`,
      headers: { cookie: maintainer.cookie },
    });
    expectProblem(maintainerSearch, 'FORBIDDEN');

    const foreignSearch = await inject(app, {
      method: 'GET',
      url: `/api/identities?agentId=${encodeURIComponent(agent.id)}`,
      headers: { cookie: owner2.cookie },
    });
    expect(foreignSearch.statusCode, foreignSearch.body).toBe(404);
  });

  it('deletes only when the owner holds the delete leaf', async () => {
    const agent = await createAgentFor(owner1.cookie);

    const maintainerDelete = await inject(app, {
      method: 'DELETE',
      url: `/api/agents/${agent.id}`,
      headers: { cookie: maintainer.cookie },
    });
    expectProblem(maintainerDelete, 'FORBIDDEN');

    const ownerDelete = await inject(app, {
      method: 'DELETE',
      url: `/api/agents/${agent.id}`,
      headers: { cookie: owner1.cookie },
    });
    expect(ownerDelete.statusCode, ownerDelete.body).toBe(204);

    const gone = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}`,
      headers: { cookie: owner1.cookie },
    });
    expect(gone.statusCode, gone.body).toBe(404);
  });

  it('allows admins to manage any agent and audits with the business id', async () => {
    const agent = await createAgentFor(owner1.cookie);
    const patched = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: { cookie: adminCookie },
      payload: { description: 'admin edit' },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const audit = await app.pool.query<{ actor: string }>(
      'select actor from audit_log where target = $1 and action = $2 order by created_at desc limit 1',
      [agent.id, 'agent.updated'],
    );
    expect(audit.rows[0]?.actor).toBe(adminBusinessId);
  });
});
