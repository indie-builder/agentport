import { newId } from '@agentport/db';
import { type Agent, DEFAULT_RUNTIME_DOCKERFILE } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  createAgent,
  createServer,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

interface WorkspaceFiles {
  mcpJson: string;
  claudeMd: string;
  agentMd: string;
  subAgents: Array<{ slug: string; content: string }>;
}

/**
 * RBAC 下每次 PATCH 必须先读目标对象做对象范围判定，这属于必需的授权读取；
 * 这里只验证行为，不再把「普通字段不预读」当作契约。
 */
describe.skipIf(!ready)('agents', () => {
  let app: FastifyInstance;
  let cookie: string;
  const createdAgents: string[] = [];
  const createdServers: string[] = [];
  const createdEnvironments: string[] = [];

  const createEnvironment = async (): Promise<{ id: string; name: string }> => {
    const id = newId('runtimeEnvironment');
    const name = unique('env');
    const versionId = newId('runtimeEnvironmentVersion');
    createdEnvironments.push(id);
    await app.pool.query(
      'insert into runtime_environments (id, name, dockerfile) values ($1, $2, $3)',
      [id, name, DEFAULT_RUNTIME_DOCKERFILE],
    );
    await app.pool.query(
      `insert into runtime_environment_versions
         (id, environment_id, dockerfile, base_image_id, status, image_tag, image_id, finished_at)
       values ($1, $2, $3, $4, 'ready', $4, $5, now())`,
      [versionId, id, DEFAULT_RUNTIME_DOCKERFILE, name, `sha256:${'a'.repeat(64)}`],
    );
    await app.pool.query('update runtime_environments set online_version_id = $2 where id = $1', [
      id,
      versionId,
    ]);
    return { id, name };
  };

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs: createdAgents, serverNames: createdServers });
    for (const id of createdEnvironments) {
      // 先断开线上指针，复合外键才允许删除版本。
      await app.pool.query(
        'update runtime_environments set online_version_id = null where id = $1',
        [id],
      );
      await app.pool.query('delete from runtime_environment_versions where environment_id = $1', [
        id,
      ]);
      await app.pool.query('delete from runtime_environments where id = $1', [id]);
    }
    await app.close();
  });

  const auth = () => ({ cookie });
  const newAgent = (
    slug: string,
    serverIds: string[] = [],
    expectStatus = 201,
  ): ReturnType<typeof createAgent> =>
    createAgent(app, cookie, { slug, serverIds, track: createdAgents, expectStatus });

  it('creates an agent with defaults', async () => {
    const res = await newAgent(unique('agent'));
    expect(res.statusCode).toBe(201);
    const body = res.json<Agent>();
    expect(body).toMatchObject({
      model: 'claude-sonnet-5-5',
      maxTurns: 20,
      maxBudgetUsd: 2,
      timeoutMs: 600_000,
      serverIds: [],
      uiFormat: 'markdown',
    });
    expect(body.id.startsWith('agt_')).toBe(true);
  });

  it('preserves canonical roles through list, partial updates, versions and rollback', async () => {
    const slug = unique('role');
    createdAgents.push(slug);
    const created = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: { slug, name: 'Role agent', role: '前端工程师' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const agent = created.json<Agent>();
    expect(agent.role).toBe('前端工程师');

    // 列表摘要只含业务字段；岗位等配置必须在详情里读。
    const list = await inject(app, { method: 'GET', url: '/api/agents', headers: auth() });
    expect(list.statusCode, list.body).toBe(200);
    const summary = list
      .json<Array<Record<string, unknown>>>()
      .find((item) => item.id === agent.id);
    expect(summary).toMatchObject({
      id: agent.id,
      name: 'Role agent',
      enabled: true,
      slug,
      role: '前端工程师',
      model: 'claude-sonnet-5-5',
      uiFormat: 'markdown',
      parentId: null,
    });
    expect(new Date(String(summary.createdAt)).toISOString()).toBe(summary.createdAt);
    expect(summary).not.toHaveProperty('systemPrompt');

    const changed = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { role: '数据分析师' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json<Agent>().role).toBe('数据分析师');

    const renamed = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { name: 'Renamed role agent' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json<Agent>()).toMatchObject({
      name: 'Renamed role agent',
      role: '数据分析师',
    });

    const version = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}/versions/3`,
      headers: auth(),
    });
    expect(version.statusCode, version.body).toBe(200);
    expect(version.json<{ snapshot: Agent }>().snapshot).toMatchObject({
      name: 'Renamed role agent',
      role: '数据分析师',
    });

    const rolledBack = await inject(app, {
      method: 'POST',
      url: `/api/agents/${agent.id}/rollback`,
      headers: auth(),
      payload: { version: 1 },
    });
    expect(rolledBack.statusCode, rolledBack.body).toBe(200);
    expect(rolledBack.json<Agent>()).toMatchObject({ name: 'Role agent', role: '前端工程师' });
  });

  it.each(['POST', 'PATCH'] as const)(
    'rejects an unknown role on %s with a role path',
    async (method) => {
      const slug = unique('invalid-role');
      createdAgents.push(slug);
      const agent = method === 'PATCH' ? (await newAgent(slug)).json<Agent>() : undefined;
      const res = await inject(app, {
        method,
        url: agent ? `/api/agents/${agent.id}` : '/api/agents',
        headers: auth(),
        payload: agent
          ? { role: '随意输入的岗位' }
          : { slug, name: 'Invalid role', role: '随意输入的岗位' },
      });
      expect(expectProblem(res, 'INVALID_INPUT').path).toBe('/role');
    },
  );

  it.each([
    { label: 'missing', role: undefined },
    { label: 'unsupported', role: '历史自定义岗位' },
  ])('keeps the current role when rolling back a $label snapshot role', async ({ role }) => {
    const agent = (await newAgent(unique('historical-role'))).json<Agent>();
    const changed = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { name: 'Current name', role: '数据分析师' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const updated = await app.pool.query(
      "update agent_versions set snapshot = (snapshot - 'role') || $2::jsonb where agent_id = $1 and version = 1",
      [agent.id, JSON.stringify(role === undefined ? {} : { role })],
    );
    expect(updated.rowCount).toBe(1);

    const rolledBack = await inject(app, {
      method: 'POST',
      url: `/api/agents/${agent.id}/rollback`,
      headers: auth(),
      payload: { version: 1 },
    });
    expect(rolledBack.statusCode, rolledBack.body).toBe(200);
    expect(rolledBack.json<Agent>()).toMatchObject({ name: agent.name, role: '数据分析师' });
  });

  it('restores the runtime environment recorded in a snapshot', async () => {
    const environment = await createEnvironment();
    const slug = unique('rollback-env');
    createdAgents.push(slug);
    const created = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: {
        slug,
        name: 'Rollback environment',
        systemPrompt: 'prompt',
        runtimeEnvironmentId: environment.id,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const agent = created.json<Agent>();
    expect(agent.runtimeEnvironmentId).toBe(environment.id);

    const patched = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { runtimeEnvironmentId: null },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json<Agent>().runtimeEnvironmentId).toBeNull();

    const rolledBack = await inject(app, {
      method: 'POST',
      url: `/api/agents/${agent.id}/rollback`,
      headers: auth(),
      payload: { version: 1 },
    });
    expect(rolledBack.statusCode, rolledBack.body).toBe(200);
    expect(rolledBack.json<Agent>().runtimeEnvironmentId).toBe(environment.id);
  });

  it('refuses to roll back to a snapshot whose runtime environment was deleted', async () => {
    const environment = await createEnvironment();
    const slug = unique('rollback-missing-env');
    createdAgents.push(slug);
    const created = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: {
        slug,
        name: 'Rollback missing environment',
        systemPrompt: 'prompt',
        runtimeEnvironmentId: environment.id,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const agent = created.json<Agent>();

    const patched = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { runtimeEnvironmentId: null },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    await app.pool.query('update runtime_environments set online_version_id = null where id = $1', [
      environment.id,
    ]);
    await app.pool.query('delete from runtime_environment_versions where environment_id = $1', [
      environment.id,
    ]);
    await app.pool.query('delete from runtime_environments where id = $1', [environment.id]);

    const rolledBack = await inject(app, {
      method: 'POST',
      url: `/api/agents/${agent.id}/rollback`,
      headers: auth(),
      payload: { version: 1 },
    });
    expect(expectProblem(rolledBack, 'INVALID_INPUT').message).toContain('运行环境');

    // 不能悄悄回落默认环境：拒绝后当前绑定保持不变。
    const detail = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
    });
    expect(detail.json<Agent>().runtimeEnvironmentId).toBeNull();
  });

  it('preserves a legacy freeform role on get and name-only PATCH', async () => {
    const slug = unique('legacy-role');
    const id = unique('agt-legacy');
    const role = '  历史自由岗位：研究 / 交付  ';
    createdAgents.push(slug);
    await app.pool.query(
      `insert into agents (id, slug, name, model, role, created_by, owner_business_id)
       values ($1, $2, $3, $4, $5,
         (select business_id from "user" where username = 'admin'),
         (select business_id from "user" where username = 'admin'))`,
      [id, slug, 'Legacy role agent', 'claude-sonnet-5-5', role],
    );

    const detail = await inject(app, {
      method: 'GET',
      url: `/api/agents/${id}`,
      headers: auth(),
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json<Agent>().role).toBe(role);

    const list = await inject(app, { method: 'GET', url: '/api/agents', headers: auth() });
    expect(list.statusCode, list.body).toBe(200);
    // 摘要与详情都带岗位文本；历史值原样保留。
    const summary = list.json<Array<Record<string, unknown>>>().find((item) => item.id === id);
    expect(summary).toMatchObject({ id, name: 'Legacy role agent', role, parentId: null });

    const renamed = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${id}`,
      headers: auth(),
      payload: { name: 'Renamed legacy agent' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json<Agent>()).toMatchObject({ name: 'Renamed legacy agent', role });
    const stored = await app.pool.query<{ role: string }>('select role from agents where id = $1', [
      id,
    ]);
    expect(stored.rows[0]?.role).toBe(role);
  });

  it('rejects a duplicate slug with 409', async () => {
    const slug = unique('dup');
    expect((await newAgent(slug)).statusCode).toBe(201);
    expectProblem(await newAgent(slug, [], 409), 'CONFLICT');
  });

  it('PATCH toggles uiFormat and rejects unknown formats', async () => {
    const agent = (await newAgent(unique('ui-format'))).json<Agent>();

    const enabled = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { uiFormat: 'openui' },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json<Agent>().uiFormat).toBe('openui');

    const invalid = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { uiFormat: 'html' },
    });
    expect(expectProblem(invalid, 'INVALID_INPUT').path).toBe('/uiFormat');
  });

  it('PATCH updates fields and forbids slug changes', async () => {
    const slug = unique('patch');
    const agent = (await newAgent(slug)).json<Agent>();

    const res = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { name: 'Renamed', systemPrompt: 'new prompt', maxTurns: 7 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Agent>()).toMatchObject({
      name: 'Renamed',
      systemPrompt: 'new prompt',
      maxTurns: 7,
    });

    const slugChange = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { slug: unique('other') },
    });
    expect(slugChange.statusCode).toBe(400);
  });

  it('rejects permissionMode auto but accepts default', async () => {
    // auto 依赖模型分类器，平台无法审计；default 可直接透传（D-20）。
    const rejected = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: { slug: unique('perms'), name: 'Perms', permissionMode: 'auto' },
    });
    expect(rejected.statusCode).toBe(400);
    expectProblem(rejected, 'INVALID_INPUT');

    const slug = unique('perms-ok');
    const accepted = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: { slug, name: 'Perms OK', permissionMode: 'default' },
    });
    expect(accepted.statusCode).toBe(201);
    createdAgents.push(slug);
  });

  it('rejects a reference to a missing server as INVALID_REFERENCE, not 500', async () => {
    // agent_servers.server_id 的外键失败（23503）由 isPgCode 沿 drizzle 的 cause 链识别。
    const slug = unique('bad-ref');
    createdAgents.push(slug);
    const res = await newAgent(slug, ['srv_missing'], 400);
    expectProblem(res, 'INVALID_REFERENCE');
  });

  it('PATCH rejects a stale expectedUpdatedAt with 409', async () => {
    const agent = (await newAgent(unique('stale-agent'))).json<Agent>();

    const ok = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { name: 'First', expectedUpdatedAt: agent.updatedAt },
    });
    expect(ok.statusCode).toBe(200);

    const stale = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { name: 'Second', expectedUpdatedAt: agent.updatedAt },
    });
    expectProblem(stale, 'CONFLICT_STALE');
  });

  it('PATCHes ordinary fields without reading the agent row first', async () => {
    const slug = unique('patch-plain');
    createdAgents.push(slug);
    const created = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: { slug, name: 'Plain agent', effort: 'high' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const agent = created.json<Agent>();

    const changed = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { name: 'Renamed plain', description: 'plain description', enabled: false },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json<Agent>()).toMatchObject({
      name: 'Renamed plain',
      description: 'plain description',
      enabled: false,
    });

    const empty = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: {},
    });
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json<Agent>().name).toBe('Renamed plain');

    // null 是合法的「清除回未配置」，与 undefined（不动）语义不同。
    const cleared = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { effort: null },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json<Agent>().effort).toBeUndefined();

    const stored = await app.pool.query<{ effort: string | null }>(
      'select effort from agents where id = $1',
      [agent.id],
    );
    expect(stored.rows[0]).toEqual({ effort: null });
  });

  it('PATCH returns 404 for a missing agent even with a stale expectedUpdatedAt', async () => {
    const res = await inject(app, {
      method: 'PATCH',
      url: '/api/agents/agt_missing_stale_patch',
      headers: auth(),
      payload: { name: 'x', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' },
    });
    expectProblem(res, 'AGENT_NOT_FOUND');
  });

  it('PATCH validates slug and binding fields, including empty arrays', async () => {
    const agent = (await newAgent(unique('patch-special'))).json<Agent>();
    const missingId = 'agt_missing_special_patch';

    const subAgents = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { subAgentIds: [] },
    });
    expect(subAgents.statusCode, subAgents.body).toBe(200);

    const plugins = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { pluginBindings: [] },
    });
    expect(plugins.statusCode, plugins.body).toBe(200);

    const slugChange = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { slug: unique('other') },
    });
    expectProblem(slugChange, 'INVALID_INPUT');

    // 旧行不存在时特殊字段也直接 404；slug 冲突校验不能抢先。
    for (const payload of [
      { slug: unique('missing-slug') },
      { subAgentIds: [] },
      { pluginBindings: [] },
    ]) {
      const missing = await inject(app, {
        method: 'PATCH',
        url: `/api/agents/${missingId}`,
        headers: auth(),
        payload,
      });
      expectProblem(missing, 'AGENT_NOT_FOUND');
    }
  });

  it('renders three workspace files with mcp tool wildcards', async () => {
    const server = await createServer(app, cookie, {
      name: unique('files-srv'),
      track: createdServers,
    });
    const res = await newAgent(unique('files'), [server.id]);
    const agent = res.json<Agent>();

    const files = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}/files`,
      headers: auth(),
    });
    expect(files.statusCode).toBe(200);
    const body = files.json<WorkspaceFiles>();

    const mcp = JSON.parse(body.mcpJson) as {
      mcpServers: Record<
        string,
        { type: string; url: string; headers: Record<string, string>; _note?: string }
      >;
    };
    expect(Object.keys(mcp.mcpServers)).toEqual([server.name]);
    expect(mcp.mcpServers[server.name]?.type).toBe('http');
    expect(mcp.mcpServers[server.name]?.url).toContain(`/mcp/${server.id}`);
    // 预览不返回明文 mcpToken：Authorization 省略，并注明运行时注入。
    expect(mcp.mcpServers[server.name]?.headers.Authorization).toBeUndefined();
    expect(mcp.mcpServers[server.name]?._note).toContain('运行时注入');

    // reveal=1 也不返回明文，只要求响应不被缓存。
    const reveal = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}/files?reveal=1`,
      headers: auth(),
    });
    expect(reveal.statusCode).toBe(200);
    expect(reveal.headers['cache-control']).toBe('no-store');
    expect(reveal.body).not.toContain('Bearer ');
    expect(reveal.body).not.toContain('mcpToken');

    expect(body.claudeMd).toContain('You are helpful.');
    expect(body.claudeMd).toContain(`mcp__${server.name}__`);
    expect(body.agentMd).toContain(`name: "${agent.slug}"`);
    expect(body.agentMd).toContain(`"mcp__${server.name}__*"`);
    expect(body.agentMd).toContain('tools: ["Bash"');
    expect(body.agentMd).not.toMatch(/disallowedTools: \[[^\]]*"Bash"/);
  });

  it('accepts Bash and Bash(...) in allowedTools and keeps an explicit deny', async () => {
    const slug = unique('bash');
    createdAgents.push(slug);
    const created = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: {
        slug,
        name: 'Bash agent',
        allowedTools: ['Bash', 'Bash(git:*)'],
        disallowedTools: ['Bash(rm:*)'],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const agent = created.json<Agent>();
    expect(agent.allowedTools).toEqual(['Bash', 'Bash(git:*)']);
    expect(agent.disallowedTools).toEqual(['Bash(rm:*)']);

    const patched = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { allowedTools: ['Bash(npm:*)'], disallowedTools: ['Bash'] },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json<Agent>()).toMatchObject({
      allowedTools: ['Bash(npm:*)'],
      disallowedTools: ['Bash'],
    });

    const files = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}/files`,
      headers: auth(),
    });
    expect(files.statusCode, files.body).toBe(200);
    expect(files.json<WorkspaceFiles>().agentMd).toMatch(/disallowedTools: \[[^\]]*"Bash"/);
  });

  it('renders the OpenUI tool catalog from the currently bound servers only', async () => {
    const first = await createServer(app, cookie, {
      name: unique('openui-srv-a'),
      track: createdServers,
    });
    const second = await createServer(app, cookie, {
      name: unique('openui-srv-b'),
      track: createdServers,
    });
    const createTool = async (serverId: string, name: string) => {
      const res = await inject(app, {
        method: 'POST',
        url: `/api/servers/${serverId}/tools`,
        headers: auth(),
        payload: { name, pathTemplate: `/${name}` },
      });
      expect(res.statusCode, res.body).toBe(201);
    };
    await createTool(first.id, unique('tool-a'));
    await createTool(second.id, unique('tool-b'));
    const toolsOf = async (serverId: string) =>
      (
        await inject(app, {
          method: 'GET',
          url: `/api/servers/${serverId}/tools`,
          headers: auth(),
        })
      ).json<Array<{ name: string }>>();

    const agent = (await newAgent(unique('openui-bind'), [first.id])).json<Agent>();
    const enable = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { uiFormat: 'openui' },
    });
    expect(enable.statusCode, enable.body).toBe(200);

    const preview = async () =>
      (
        await inject(app, {
          method: 'GET',
          url: `/api/agents/${agent.id}/files`,
          headers: auth(),
        })
      ).json<WorkspaceFiles>();
    const firstTool = (await toolsOf(first.id))[0]?.name ?? '';
    const secondTool = (await toolsOf(second.id))[0]?.name ?? '';

    const before = await preview();
    expect(before.claudeMd).toContain(`mcp__${first.name}__${firstTool}`);
    expect(before.claudeMd).not.toContain(`mcp__${second.name}__`);
    expect(before.claudeMd.split('## 生成式 UI')).toHaveLength(2);

    // 换绑后预览必须立即反映新 server：旧名字消失、新名字出现，生成段仍是 1 份。
    const rebind = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { serverIds: [second.id] },
    });
    expect(rebind.statusCode, rebind.body).toBe(200);
    const after = await preview();
    expect(after.claudeMd).toContain(`mcp__${second.name}__${secondTool}`);
    expect(after.claudeMd).not.toContain(`mcp__${first.name}__`);
    expect(after.claudeMd.split('## 生成式 UI')).toHaveLength(2);
    expect(after.claudeMd.split('## 工具使用')).toHaveLength(2);
  });

  it('returns 404 for unknown ids on get/patch/delete/files', async () => {
    const missing = 'agt_missing';
    const get = await inject(app, {
      method: 'GET',
      url: `/api/agents/${missing}`,
      headers: auth(),
    });
    expect(get.statusCode).toBe(404);
    const patch = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${missing}`,
      headers: auth(),
      payload: { name: 'x' },
    });
    expect(patch.statusCode).toBe(404);
    const files = await inject(app, {
      method: 'GET',
      url: `/api/agents/${missing}/files`,
      headers: auth(),
    });
    expect(files.statusCode).toBe(404);
    const del = await inject(app, {
      method: 'DELETE',
      url: `/api/agents/${missing}`,
      headers: auth(),
    });
    expect(del.statusCode).toBe(404);
  });

  it('DELETE removes the agent', async () => {
    const slug = unique('delete');
    const agent = (await newAgent(slug)).json<Agent>();
    const del = await inject(app, {
      method: 'DELETE',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
    });
    expect(del.statusCode).toBe(204);
    const get = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
    });
    expect(get.statusCode).toBe(404);
  });

  it('delegates to sub-agents and renders them as agent files', async () => {
    const parentSlug = unique('parent');
    const childSlug = unique('child');
    const child = (await newAgent(childSlug)).json<Agent>();
    const listSummary = async (): Promise<Array<Record<string, unknown>>> => {
      const list = await inject(app, { method: 'GET', url: '/api/agents', headers: auth() });
      expect(list.statusCode, list.body).toBe(200);
      return list.json<Array<Record<string, unknown>>>();
    };
    expect((await listSummary()).find((entry) => entry.id === child.id)).toMatchObject({
      parentId: null,
    });
    const res = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: {
        slug: parentSlug,
        name: `Agent ${parentSlug}`,
        systemPrompt: 'You are the lead.',
        subAgentIds: [child.id],
      },
    });
    createdAgents.push(parentSlug);
    expect(res.statusCode).toBe(201);
    const parent = res.json<Agent>();
    expect(parent.subAgentIds).toEqual([child.id]);

    const childGet = await inject(app, {
      method: 'GET',
      url: `/api/agents/${child.id}`,
      headers: auth(),
    });
    expect(childGet.json<Agent>().parentId).toBe(parent.id);

    const summaries = await listSummary();
    expect(summaries.find((entry) => entry.id === parent.id)).toMatchObject({ parentId: null });
    expect(summaries.find((entry) => entry.id === child.id)).toMatchObject({
      parentId: parent.id,
    });

    const files = await inject(app, {
      method: 'GET',
      url: `/api/agents/${parent.id}/files`,
      headers: auth(),
    });
    const body = files.json<WorkspaceFiles>();
    expect(body.subAgents.map((sub) => sub.slug)).toEqual([childSlug]);
    expect(body.claudeMd).toContain(childSlug);
    expect(body.agentMd).toContain('Agent');
    // 子智能体文件不放行 Agent（只有一层），也不写 tools（否则 SDK 派生时 MCP 工具解析为空）。
    expect(body.subAgents[0]?.content).toContain('"Agent"');
    expect(body.subAgents[0]?.content).not.toContain('tools: [');
  });

  it('rejects self-delegation and two-level delegation', async () => {
    const a = (await newAgent(unique('cycle-a'))).json<Agent>();
    const b = (await newAgent(unique('cycle-b'))).json<Agent>();

    const self = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${a.id}`,
      headers: auth(),
      payload: { subAgentIds: [a.id] },
    });
    expect(self.statusCode).toBe(400);

    const first = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${a.id}`,
      headers: auth(),
      payload: { subAgentIds: [b.id] },
    });
    expect(first.statusCode).toBe(200);

    // b 已经是 a 的子智能体，不能再被 c 委派，也不能自己再委派。
    const c = (await newAgent(unique('cycle-c'))).json<Agent>();
    const second = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${c.id}`,
      headers: auth(),
      payload: { subAgentIds: [b.id] },
    });
    expect(second.statusCode).toBe(400);

    const nested = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${b.id}`,
      headers: auth(),
      payload: { subAgentIds: [c.id] },
    });
    expect(nested.statusCode).toBe(400);
  });

  it('duplicates an agent with its bindings, rules and output styles', async () => {
    const server = await createServer(app, cookie, {
      name: unique('dup-srv'),
      track: createdServers,
    });
    const source = (await newAgent(unique('dup-src'), [server.id])).json<Agent>();

    const rule = await inject(app, {
      method: 'PUT',
      url: `/api/agents/${source.id}/rules/deploy`,
      headers: auth(),
      payload: { content: 'Deploy carefully.', globs: 'src/**' },
    });
    expect(rule.statusCode, rule.body).toBe(200);
    const style = await inject(app, {
      method: 'PUT',
      url: `/api/agents/${source.id}/output-styles/concise`,
      headers: auth(),
      payload: { description: 'Short answers', keepCodingInstructions: true, body: 'Be brief.' },
    });
    expect(style.statusCode, style.body).toBe(200);

    // 非默认配置也要被克隆，避免默认值相等掩盖漏拷。
    const configured = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${source.id}`,
      headers: auth(),
      payload: { model: 'group/flash', maxTurns: 7 },
    });
    expect(configured.statusCode, configured.body).toBe(200);

    const getRules = async (id: string) =>
      (await inject(app, { method: 'GET', url: `/api/agents/${id}/rules`, headers: auth() })).json<
        Array<{ slug: string; content: string; globs: string }>
      >();
    const getStyles = async (id: string) =>
      (
        await inject(app, {
          method: 'GET',
          url: `/api/agents/${id}/output-styles`,
          headers: auth(),
        })
      ).json<
        Array<{ id: string; slug: string; description: string; body: string; isSelected: boolean }>
      >();

    const sourceRulesBefore = await getRules(source.id);
    const sourceStylesBefore = await getStyles(source.id);

    const slug = unique('dup-copy');
    createdAgents.push(slug);
    const res = await inject(app, {
      method: 'POST',
      url: `/api/agents/${source.id}/duplicate`,
      headers: auth(),
      payload: { slug, name: 'Cloned agent' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const copy = res.json<Agent>();
    expect(copy.id).not.toBe(source.id);
    expect(copy).toMatchObject({
      slug,
      name: 'Cloned agent',
      role: source.role,
      systemPrompt: source.systemPrompt,
      model: 'group/flash',
      maxTurns: 7,
      serverIds: [server.id],
      skillIds: [],
      subAgentIds: [],
      parentId: null,
    });

    const copyRules = await getRules(copy.id);
    const copyStyles = await getStyles(copy.id);
    expect(copyRules).toEqual([
      expect.objectContaining({ slug: 'deploy', content: 'Deploy carefully.', globs: 'src/**' }),
    ]);
    expect(copyStyles).toEqual([
      expect.objectContaining({
        slug: 'concise',
        description: 'Short answers',
        body: 'Be brief.',
        isSelected: true,
      }),
    ]);
    expect(copyStyles[0]?.id).not.toBe(sourceStylesBefore[0]?.id);
    // 源智能体的规则与风格不能被改动。
    expect(await getRules(source.id)).toEqual(sourceRulesBefore);
    expect(await getStyles(source.id)).toEqual(sourceStylesBefore);

    const versions = await inject(app, {
      method: 'GET',
      url: `/api/agents/${copy.id}/versions`,
      headers: auth(),
    });
    expect(versions.statusCode, versions.body).toBe(200);
    expect(versions.json<Array<{ version: number }>>().map((v) => v.version)).toEqual([1]);
  });

  it('rejects duplicating into an existing slug with 409', async () => {
    const source = (await newAgent(unique('dup-conflict-src'))).json<Agent>();
    const taken = unique('dup-taken');
    await newAgent(taken);
    const res = await inject(app, {
      method: 'POST',
      url: `/api/agents/${source.id}/duplicate`,
      headers: auth(),
      payload: { slug: taken, name: 'Taken slug' },
    });
    expectProblem(res, 'CONFLICT');
  });

  it('returns 404 when duplicating a missing agent', async () => {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/agents/agt_missing/duplicate',
      headers: auth(),
      payload: { slug: unique('dup-missing'), name: 'Missing source' },
    });
    expect(res.statusCode).toBe(404);
    expectProblem(res, 'AGENT_NOT_FOUND');
  });

  it('validates rule slugs at the route boundary and keeps database failures as 500s', async () => {
    const agent = (await newAgent(unique('rule-errors'))).json<Agent>();

    const invalid = await inject(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/rules/Bad.Slug`,
      headers: auth(),
      payload: { content: 'x' },
    });
    expect(invalid.statusCode).toBe(400);
    expectProblem(invalid, 'INVALID_INPUT');

    // PostgreSQL rejects NUL bytes in text parameters: a real DB failure must
    // surface as INTERNAL_ERROR, not as an invalid-slug message.
    const dbError = await inject(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/rules/deploy`,
      headers: auth(),
      payload: { content: 'before\u0000after' },
    });
    expect(dbError.statusCode).toBe(500);
    expect(dbError.json<{ code: string }>().code).toBe('INTERNAL_ERROR');
    expect(dbError.body).not.toContain('规则 slug 非法');
  });
});
