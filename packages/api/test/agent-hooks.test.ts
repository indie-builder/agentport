import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Agent, AgentHookFile, AgentHooks, WorkspaceFiles } from '@agentport/shared';
import { AGENT_PACKAGE_PATHS } from '@agentport/shared';
import {
  cleanup,
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
    await cleanup(app, { agentSlugs });
    await app.close();
  });

  const auth = () => ({ cookie });

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
});
