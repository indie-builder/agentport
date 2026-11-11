import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { newId } from '@agentport/db';
import {
  AGENT_HOOK_CONTENT_MAX,
  AGENT_PACKAGE_PATHS,
  type Agent,
  type AgentHookFile,
  type AgentHooks,
  type WorkspaceFiles,
} from '@agentport/shared';
import { hashPassword } from 'better-auth/crypto';
import { zipSync } from 'fflate';
import { decodePackageEntries } from '../src/modules/agents/package-zip.js';
import { AUTH_COOKIE } from '../src/modules/auth/types.js';
import {
  cleanup,
  expectProblem,
  infraReady,
  loginCookie,
  request,
  requestZip,
  startApp,
  type TestApp,
  unique,
} from './helpers.js';
import { packageZip } from './package-fixtures.js';

const ready = await infraReady;
const PASSWORD = 'agentport-hooks-test';

/** 用 fflate 的文件级 os/attrs 写真实 Unix mode。 */
function zipWithModes(
  files: Array<{ path: string; content: string; executable: boolean }>,
): Buffer {
  const encoder = new TextEncoder();
  const entries: Record<string, [Uint8Array, { os: number; attrs: number }]> = {};
  for (const file of files) {
    entries[file.path] = [
      encoder.encode(file.content),
      { os: 3, attrs: ((file.executable ? 0o100755 : 0o100644) << 16) >>> 0 },
    ];
  }
  return Buffer.from(zipSync(entries));
}

const hooksConfig = {
  PreToolUse: [
    {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'bash .claude/hooks/guard.sh' }],
    },
  ],
};

describe.skipIf(!ready)('agent file hooks', () => {
  let app: TestApp;
  let cookie: string;
  const agentSlugs: string[] = [];
  const agentIds: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    if (agentIds.length > 0) {
      await app.client.unsafe('delete from audit_log where target = any($1::text[])', [
        app.client.array(agentIds, 'TEXT'),
      ]);
    }
    for (const businessId of seededBusinessIds) {
      await app.client.unsafe('delete from user_roles where business_id = $1', [businessId]);
      await app.client.unsafe('delete from "user" where business_id = $1', [businessId]);
    }
    for (const roleId of roleIds) {
      await app.client.unsafe('delete from roles where id = $1', [roleId]);
    }
    await cleanup(app, { agentSlugs });
    await app.close();
  });

  const auth = () => ({ cookie });

  const roleIds: string[] = [];
  const seededBusinessIds: string[] = [];

  const createRole = async (
    grants: Array<{ permissionId: string; scope: string }>,
  ): Promise<string> => {
    const id = newId('role');
    await app.client.unsafe(
      'insert into roles (id, name, system_key, created_at, updated_at) values ($1, $2, null, now(), now())',
      [id, unique('hooks-role')],
    );
    for (const grant of grants) {
      await app.client.unsafe(
        'insert into role_permissions (role_id, permission_id, scope) values ($1, $2, $3)',
        [id, grant.permissionId, grant.scope],
      );
    }
    roleIds.push(id);
    return id;
  };

  const createUser = async (roleId: string): Promise<{ cookie: string; businessId: string }> => {
    const businessId = `biz-hooks-${randomUUID().slice(0, 8)}`;
    const username = unique('hooks-user');
    const authUserId = randomUUID();
    await app.client.unsafe(
      `insert into "user" (id, name, email, email_verified, username, business_id, disabled, created_at, updated_at)
       values ($1, $2, $3, true, $4, $5, false, now(), now())`,
      [authUserId, username, `${username}@agentport.invalid`, username, businessId],
    );
    await app.client.unsafe(
      `insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at)
       values ($1, $2, 'credential', $3, $4, now(), now())`,
      [randomUUID(), authUserId, authUserId, await hashPassword(PASSWORD)],
    );
    await app.client.unsafe('insert into user_roles (business_id, role_id) values ($1, $2)', [
      businessId,
      roleId,
    ]);
    seededBusinessIds.push(businessId);
    const res = await request(app, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { username, password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(200);
    const session = res.cookies.find((entry) => entry.name === AUTH_COOKIE);
    if (!session) throw new Error('login did not set the auth cookie');
    return { cookie: `${session.name}=${session.value}`, businessId };
  };

  const create = async (): Promise<Agent> => {
    const slug = unique('hooks');
    agentSlugs.push(slug);
    const res = await request(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: { slug, name: `Agent ${slug}` },
    });
    expect(res.statusCode, res.body).toBe(201);
    const agent = res.json<Agent>();
    agentIds.push(agent.id);
    return agent;
  };

  const readHooks = async (id: string): Promise<AgentHooks> => {
    const res = await request(app, {
      method: 'GET',
      url: `/api/agents/${id}/hooks`,
      headers: auth(),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<AgentHooks>();
  };

  const preview = async (id: string): Promise<WorkspaceFiles> => {
    const res = await request(app, {
      method: 'GET',
      url: `/api/agents/${id}/files`,
      headers: auth(),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<WorkspaceFiles>();
  };

  it('defaults to disabled and renders nothing', async () => {
    const agent = await create();
    expect(await readHooks(agent.id)).toEqual({ enabled: false, config: null, files: [] });
    const files = await preview(agent.id);
    expect(files.hookFiles).toEqual([]);
    expect(JSON.parse(files.settingsJson)).not.toHaveProperty('hooks');
  });

  it('renders settings and scripts only while enabled', async () => {
    const agent = await create();
    const saveSettings = await request(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/hooks/settings`,
      headers: auth(),
      payload: { enabled: true, config: hooksConfig },
    });
    expect(saveSettings.statusCode, saveSettings.body).toBe(200);

    const saveFile = await request(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/hooks/files`,
      headers: auth(),
      payload: { path: 'guard.sh', content: '#!/bin/sh\n', executable: true },
    });
    expect(saveFile.statusCode, saveFile.body).toBe(200);
    expect(saveFile.json<AgentHookFile>()).toMatchObject({ path: 'guard.sh', executable: true });

    const files = await preview(agent.id);
    expect(JSON.parse(files.settingsJson).hooks).toEqual(hooksConfig);
    expect(files.hookFiles).toEqual([
      { path: 'guard.sh', content: '#!/bin/sh\n', executable: true },
    ]);

    const disable = await request(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/hooks/settings`,
      headers: auth(),
      payload: { enabled: false, config: hooksConfig },
    });
    expect(disable.statusCode, disable.body).toBe(200);
    const disabledFiles = await preview(agent.id);
    expect(disabledFiles.hookFiles).toEqual([]);
    expect(JSON.parse(disabledFiles.settingsJson)).not.toHaveProperty('hooks');
    expect((await readHooks(agent.id)).files).toHaveLength(1);
  });

  it('rejects unsafe script paths', async () => {
    const agent = await create();
    for (const path of ['../escape.sh', '/abs.sh', 'a/../../b.sh']) {
      const res = await request(app, {
        method: 'PUT',
        url: `/api/agents/${agent.id}/hooks/files`,
        headers: auth(),
        payload: { path, content: 'x', executable: false },
      });
      expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    }
  });

  it('imports hooks files and config without enabling them', async () => {
    const slug = unique('hooks-import');
    agentSlugs.push(slug);
    const zip = packageZip({
      agent: { slug, name: `Imported ${slug}` },
      extraFiles: {
        [AGENT_PACKAGE_PATHS.settings]: JSON.stringify({ hooks: hooksConfig }),
        [`${AGENT_PACKAGE_PATHS.hooksDir}guard.sh`]: '#!/bin/sh\n',
      },
    });
    const res = await requestZip(app, 'POST', '/api/import/agents', cookie, zip);
    expect(res.statusCode, res.body).toBe(201);
    const imported = res.json<{ agent: Agent }>().agent;
    agentIds.push(imported.id);
    const hooks = await readHooks(imported.id);
    expect(hooks.enabled).toBe(false);
    expect(hooks.config).toEqual(hooksConfig);
    expect(hooks.files.map((file) => file.path)).toEqual(['guard.sh']);
    const files = await preview(imported.id);
    expect(files.hookFiles).toEqual([]);
    expect(JSON.parse(files.settingsJson)).not.toHaveProperty('hooks');
  });

  it('requires hooks.read for preview and export', async () => {
    const limited = await createUser(
      await createRole([
        { permissionId: 'agents.files.read', scope: 'platform' },
        { permissionId: 'agents.export', scope: 'platform' },
        { permissionId: 'agents.config.read', scope: 'platform' },
        { permissionId: 'agents.rules.read', scope: 'platform' },
        { permissionId: 'agents.styles.read', scope: 'platform' },
        { permissionId: 'agents.workflows.read', scope: 'platform' },
        { permissionId: 'agents.memory.read', scope: 'platform' },
        { permissionId: 'agents.import', scope: 'own_data' },
        { permissionId: 'agents.create', scope: 'own_data' },
      ]),
    );

    const withHooks = await create();
    await request(app, {
      method: 'PUT',
      url: `/api/agents/${withHooks.id}/hooks/settings`,
      headers: auth(),
      payload: { enabled: true, config: hooksConfig },
    });
    await request(app, {
      method: 'PUT',
      url: `/api/agents/${withHooks.id}/hooks/files`,
      headers: auth(),
      payload: { path: 'guard.sh', content: '#!/bin/sh\n', executable: true },
    });

    const deniedPreview = await request(app, {
      method: 'GET',
      url: `/api/agents/${withHooks.id}/files`,
      headers: { cookie: limited.cookie },
    });
    expectProblem(deniedPreview, 'NOT_FOUND');
    const deniedExport = await requestZip(
      app,
      'GET',
      `/api/export/agents/${withHooks.id}`,
      limited.cookie,
    );
    expectProblem(deniedExport, 'NOT_FOUND');

    const plain = await create();
    const allowedPreview = await request(app, {
      method: 'GET',
      url: `/api/agents/${plain.id}/files`,
      headers: { cookie: limited.cookie },
    });
    expect(allowedPreview.statusCode, allowedPreview.body).toBe(200);

    const importSlug = unique('hooks-limited-import');
    agentSlugs.push(importSlug);
    const hooksImport = await requestZip(
      app,
      'POST',
      '/api/import/agents',
      limited.cookie,
      packageZip({
        agent: { slug: importSlug, name: `Imported ${importSlug}` },
        extraFiles: {
          [AGENT_PACKAGE_PATHS.settings]: JSON.stringify({ hooks: hooksConfig }),
          [`${AGENT_PACKAGE_PATHS.hooksDir}guard.sh`]: '#!/bin/sh\n',
        },
      }),
    );
    expect(hooksImport.statusCode, hooksImport.body).toBe(201);
    const hooksImported = hooksImport.json<{ agent: Agent }>().agent;
    agentIds.push(hooksImported.id);
    agentSlugs.push(hooksImported.slug);
    const importedRows = await app.client.unsafe<{ hooks_enabled: boolean }[]>(
      'select hooks_enabled from agents where id = $1',
      [hooksImported.id],
    );
    expect(importedRows[0]?.hooks_enabled).toBe(false);

    const plainSlug = unique('hooks-limited-plain');
    agentSlugs.push(plainSlug);
    const plainImport = await requestZip(
      app,
      'POST',
      '/api/import/agents',
      limited.cookie,
      packageZip({ agent: { slug: plainSlug, name: `Imported ${plainSlug}` } }),
    );
    expect(plainImport.statusCode, plainImport.body).toBe(201);
    agentSlugs.push(plainImport.json<{ agent: Agent }>().agent.slug);
  });

  it('imports hooks for an owned-agent reader without hooks.write', async () => {
    const scoped = await createUser(
      await createRole([
        { permissionId: 'agents.import', scope: 'own_data' },
        { permissionId: 'agents.create', scope: 'own_data' },
        { permissionId: 'agents.hooks.read', scope: 'owned_agents' },
      ]),
    );

    const slug = unique('hooks-owned-import');
    agentSlugs.push(slug);
    const res = await requestZip(
      app,
      'POST',
      '/api/import/agents',
      scoped.cookie,
      packageZip({
        agent: { slug, name: `Imported ${slug}` },
        extraFiles: {
          [AGENT_PACKAGE_PATHS.settings]: JSON.stringify({ hooks: hooksConfig }),
          [`${AGENT_PACKAGE_PATHS.hooksDir}guard.sh`]: '#!/bin/sh\n',
        },
      }),
    );
    expect(res.statusCode, res.body).toBe(201);
    const imported = res.json<{ agent: Agent }>().agent;
    agentIds.push(imported.id);
    const rows = await app.client.unsafe<{ hooks_enabled: boolean }[]>(
      'select hooks_enabled from agents where id = $1',
      [imported.id],
    );
    expect(rows[0]?.hooks_enabled).toBe(false);

    const hooks = await request(app, {
      method: 'GET',
      url: `/api/agents/${imported.id}/hooks`,
      headers: { cookie: scoped.cookie },
    });
    expect(hooks.statusCode, hooks.body).toBe(200);
    expect(hooks.json<AgentHooks>()).toMatchObject({
      enabled: false,
      config: hooksConfig,
      files: [{ path: 'guard.sh' }],
    });
  });

  it('preserves hook executable bits across export and re-import', async () => {
    const slug = unique('hooks-exec');
    agentSlugs.push(slug);
    const base = packageZip({
      agent: { slug, name: `Imported ${slug}` },
      extraFiles: {
        [AGENT_PACKAGE_PATHS.settings]: JSON.stringify({ hooks: hooksConfig }),
        [`${AGENT_PACKAGE_PATHS.hooksDir}run`]: '#!/bin/sh\n',
        [`${AGENT_PACKAGE_PATHS.hooksDir}share.sh`]: 'echo shared\n',
      },
    });
    const files = [...decodePackageEntries(base)].map(([path, entry]) => ({
      path,
      content: entry.content,
      executable: path === `${AGENT_PACKAGE_PATHS.hooksDir}run`,
    }));
    const imported = await requestZip(
      app,
      'POST',
      '/api/import/agents',
      cookie,
      zipWithModes(files),
    );
    expect(imported.statusCode, imported.body).toBe(201);
    const agent = imported.json<{ agent: Agent }>().agent;
    agentIds.push(agent.id);

    const hooks = await readHooks(agent.id);
    expect(hooks.files.map((file) => [file.path, file.executable])).toEqual([
      ['run', true],
      ['share.sh', false],
    ]);

    const exported = await requestZip(app, 'GET', `/api/export/agents/${agent.id}`, cookie);
    expect(exported.statusCode, exported.body).toBe(200);
    const exportedEntries = decodePackageEntries(exported.rawPayload);
    expect(exportedEntries.get(`${AGENT_PACKAGE_PATHS.hooksDir}run`)?.executable).toBe(true);
    expect(exportedEntries.get(`${AGENT_PACKAGE_PATHS.hooksDir}share.sh`)?.executable).toBe(false);

    const reimported = await requestZip(
      app,
      'POST',
      '/api/import/agents',
      cookie,
      exported.rawPayload,
    );
    expect(reimported.statusCode, reimported.body).toBe(201);
    const roundTrip = reimported.json<{ agent: Agent }>().agent;
    agentIds.push(roundTrip.id);
    agentSlugs.push(roundTrip.slug);
    const roundTripHooks = await readHooks(roundTrip.id);
    expect(roundTripHooks.files.map((file) => [file.path, file.executable])).toEqual([
      ['run', true],
      ['share.sh', false],
    ]);
  });

  it('rejects imported hook scripts over the content limit without writing', async () => {
    const slug = unique('hooks-too-large');
    agentSlugs.push(slug);
    const res = await requestZip(
      app,
      'POST',
      '/api/import/agents',
      cookie,
      packageZip({
        agent: { slug, name: `Imported ${slug}` },
        extraFiles: {
          [`${AGENT_PACKAGE_PATHS.hooksDir}big.sh`]: 'x'.repeat(AGENT_HOOK_CONTENT_MAX + 1),
        },
      }),
    );
    expectProblem(res, 'INVALID_INPUT');
    const rows = await app.client.unsafe<{ count: number }[]>(
      'select count(*)::int as count from agents where slug = $1',
      [slug],
    );
    expect(rows[0]?.count).toBe(0);
  });
});
