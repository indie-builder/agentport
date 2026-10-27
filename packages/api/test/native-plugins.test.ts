import type { NativePluginAction, NativePluginOutput } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

const calls: NativePluginAction[] = [];
let result: NativePluginOutput = { ok: false, error: 'not configured' };

vi.mock('../src/features/plugins/native.js', () => ({
  runNativePluginAction: async (_url: string, _logger: unknown, action: NativePluginAction) => {
    calls.push(action);
    return result;
  },
}));

const ready = await infraReady;

const manifest = (name: string) => JSON.stringify({ name, description: 'from native marketplace' });

function installOutput(pluginId: string): NativePluginOutput {
  return {
    ok: true,
    plugin: { pluginId, version: '1.2.3' },
    files: [
      {
        path: '.claude-plugin/plugin.json',
        content: manifest(pluginId.split('@')[0] ?? ''),
        executable: false,
      },
      { path: 'skills/review/SKILL.md', content: '# review', executable: false },
      { path: 'LICENSE', content: 'MIT', executable: false },
    ],
  };
}

describe.skipIf(!ready)('native plugin routes', () => {
  let app: FastifyInstance;
  let cookie: string;
  const pluginIds: string[] = [];

  const auth = () => ({ cookie });

  /** 真实 pool.query 直通 spy：只收集发往 plugins 的 SELECT，用于验证查询次数与投影。 */
  async function capturePluginQueries<T>(
    run: () => Promise<T>,
  ): Promise<{ value: T; queries: string[] }> {
    const spy = vi.spyOn(app.pool, 'query');
    try {
      const value = await run();
      return {
        value,
        queries: spy.mock.calls
          .map(([query]) => (typeof query === 'string' ? query : query.text))
          .filter((text) => /^select .*from "plugins"/i.test(text)),
      };
    } finally {
      spy.mockRestore();
    }
  }

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  beforeEach(() => {
    calls.length = 0;
  });

  it('requires auth and never queues unauthenticated requests', async () => {
    for (const [url, payload] of [
      ['/api/plugins/native', undefined],
      ['/api/plugins/install', { marketplace: 'owner/repo', plugin: 'demo' }],
      ['/api/plugins/native/import', { pluginId: 'demo@repo' }],
    ] as const) {
      const res = await inject(app, {
        method: payload === undefined ? 'GET' : 'POST',
        url,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(res.statusCode, url).toBe(401);
    }
    expect(calls).toEqual([]);
  });

  afterAll(async () => {
    if (pluginIds.length > 0) {
      await app.pool.query('delete from plugins where id = any($1::text[])', [pluginIds]);
    }
    await cleanup(app, {});
    await app.close();
  });

  it('installs once and reuses the stored plugin after the CLI resolves the same id', async () => {
    const local = unique('native');
    const sourceId = `${local}@repo`;
    result = installOutput(sourceId);

    const first = await inject(app, {
      method: 'POST',
      url: '/api/plugins/install',
      headers: auth(),
      payload: { marketplace: 'owner/repo', plugin: local },
    });
    expect(first.statusCode, first.body).toBe(201);
    const created = first.json<{
      plugin: { id: string; sourceId: string | null; files: Array<{ path: string }> };
      warnings: string[];
      reused: boolean;
    }>();
    pluginIds.push(created.plugin.id);
    expect(created.reused).toBe(false);
    expect(created.plugin.sourceId).toBe(sourceId);
    // 普通支持文件保留，而非只留白名单组件。
    expect(created.plugin.files.map((file) => file.path)).toContain('LICENSE');
    expect(calls).toEqual([{ action: 'install', marketplace: 'owner/repo', plugin: local }]);

    calls.length = 0;
    // 第二次：仍由官方 CLI 安装（命中缓存，不需重新下载），拿回同一 pluginId 后复用库记录。
    result = installOutput(sourceId);
    const second = await inject(app, {
      method: 'POST',
      url: '/api/plugins/install',
      headers: auth(),
      payload: { marketplace: 'owner/repo', plugin: local },
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toMatchObject({ reused: true, plugin: { id: created.plugin.id } });
    expect(calls).toEqual([{ action: 'install', marketplace: 'owner/repo', plugin: local }]);
  });

  it('does not reuse a same-tail plugin from another marketplace', async () => {
    const local = unique('tail');
    result = installOutput(`${local}@owner-a-repo`);
    const first = await inject(app, {
      method: 'POST',
      url: '/api/plugins/install',
      headers: auth(),
      payload: { marketplace: 'owner-a/repo', plugin: local },
    });
    expect(first.statusCode, first.body).toBe(201);
    const existing = first.json<{ plugin: { id: string; sourceId: string } }>();
    pluginIds.push(existing.plugin.id);

    calls.length = 0;
    // 市场身份只能由 CLI 决定：同名不同 owner 必须走 install；CLI 解析出不同 pluginId，
    // 不能直接复用旧记录；运行时命名空间相同，落库按冲突拒绝。
    const otherId = `${local}@owner-b-repo`;
    result = installOutput(otherId);
    const second = await inject(app, {
      method: 'POST',
      url: '/api/plugins/install',
      headers: auth(),
      payload: { marketplace: 'owner-b/repo', plugin: local },
    });
    expectProblem(second, 'CONFLICT');
    expect(calls).toEqual([{ action: 'install', marketplace: 'owner-b/repo', plugin: local }]);
    const rows = await app.pool.query('select id from plugins where source_id = $1', [otherId]);
    expect(rows.rowCount).toBe(0);
    const kept = await app.pool.query('select source_id from plugins where id = $1', [
      existing.plugin.id,
    ]);
    expect(kept.rows[0]?.source_id).toBe(existing.plugin.sourceId);
  });

  it('lists cached plugins with whether they are already imported', async () => {
    const local = unique('listed');
    const cachedOnly = unique('other');
    result = installOutput(`${local}@repo`);
    const installed = await inject(app, {
      method: 'POST',
      url: '/api/plugins/native/import',
      headers: auth(),
      payload: { pluginId: `${local}@repo` },
    });
    expect(installed.statusCode, installed.body).toBe(201);
    pluginIds.push(installed.json<{ plugin: { id: string } }>().plugin.id);

    result = {
      ok: true,
      installed: [
        { pluginId: `${local}@repo`, version: '1.2.3' },
        { pluginId: `${cachedOnly}@repo`, version: '0.1.0' },
      ],
    };
    const list = await inject(app, { method: 'GET', url: '/api/plugins/native', headers: auth() });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toEqual({
      installed: [
        { pluginId: `${local}@repo`, version: '1.2.3', imported: true },
        { pluginId: `${cachedOnly}@repo`, version: '0.1.0', imported: false },
      ],
    });
    expect(calls).toEqual([{ action: 'read', pluginId: `${local}@repo` }, { action: 'list' }]);
  });

  it('matches the full pluginId, keeps duplicate rows in order and reads plugins once', async () => {
    const local = unique('market');
    const importedId = `${local}@owner-a-repo`;
    result = installOutput(importedId);
    const seed = await inject(app, {
      method: 'POST',
      url: '/api/plugins/native/import',
      headers: auth(),
      payload: { pluginId: importedId },
    });
    expect(seed.statusCode, seed.body).toBe(201);
    pluginIds.push(seed.json<{ plugin: { id: string } }>().plugin.id);

    result = {
      ok: true,
      installed: [
        { pluginId: importedId, version: '2.0.0' },
        { pluginId: `${local}@owner-b-repo`, version: '2.0.0' },
        { pluginId: importedId, version: '1.0.0' },
      ],
    };
    const { value: list, queries } = await capturePluginQueries(() =>
      inject(app, { method: 'GET', url: '/api/plugins/native', headers: auth() }),
    );
    expect(list.statusCode, list.body).toBe(200);
    // 同名不同市场是不同来源；同 ID 的不同版本重复项保持原序，命中按完整 ID 判定。
    expect(list.json()).toEqual({
      installed: [
        { pluginId: importedId, version: '2.0.0', imported: true },
        { pluginId: `${local}@owner-b-repo`, version: '2.0.0', imported: false },
        { pluginId: importedId, version: '1.0.0', imported: true },
      ],
    });
    // N 条已安装项只查一次库，且只投影 source_id，不读整行插件定义。
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^select\s+"source_id"\s+from\s+"plugins"/i);
    expect(queries[0]).not.toMatch(/select\s+"plugins"\."id"/i);
    expect(calls).toEqual([{ action: 'read', pluginId: importedId }, { action: 'list' }]);
  });

  it('returns an empty list without querying plugins', async () => {
    result = { ok: true, installed: [] };
    const { value: list, queries } = await capturePluginQueries(() =>
      inject(app, { method: 'GET', url: '/api/plugins/native', headers: auth() }),
    );
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toEqual({ installed: [] });
    expect(queries).toEqual([]);
    expect(calls).toEqual([{ action: 'list' }]);
  });

  it('adopts an already cached plugin by reading files without installing', async () => {
    const local = unique('cached');
    const sourceId = `${local}@repo`;
    result = installOutput(sourceId);

    const res = await inject(app, {
      method: 'POST',
      url: '/api/plugins/native/import',
      headers: auth(),
      payload: { pluginId: sourceId, slug: local },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{ plugin: { id: string; slug: string; sourceId: string } }>();
    pluginIds.push(body.plugin.id);
    expect(body.plugin).toMatchObject({ slug: local, sourceId });
    expect(calls).toEqual([{ action: 'read', pluginId: sourceId }]);

    calls.length = 0;
    const again = await inject(app, {
      method: 'POST',
      url: '/api/plugins/native/import',
      headers: auth(),
      payload: { pluginId: sourceId },
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ reused: true, plugin: { id: body.plugin.id } });
    expect(calls).toEqual([]);
  });

  it('returns 400 for unsupported plugins and leaves no database row', async () => {
    const local = unique('unsupported');
    result = {
      ok: true,
      plugin: { pluginId: `${local}@repo`, version: '1.0.0' },
      files: [
        { path: '.claude-plugin/plugin.json', content: manifest(local), executable: false },
        { path: 'bin/tool', content: 'binary', executable: true },
      ],
    };

    const res = await inject(app, {
      method: 'POST',
      url: '/api/plugins/install',
      headers: auth(),
      payload: { marketplace: 'owner/repo', plugin: local },
    });
    expectProblem(res, 'INVALID_INPUT');

    const rows = await app.pool.query('select id from plugins where source_id like $1', [
      `${local}@%`,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it('returns 503 when the worker reports the sandbox unavailable and leaves no row', async () => {
    const local = unique('unavailable');
    result = { ok: false, error: '无法启动沙盒：Docker 不可达' };

    const res = await inject(app, {
      method: 'POST',
      url: '/api/plugins/native/import',
      headers: auth(),
      payload: { pluginId: `${local}@repo` },
    });
    expectProblem(res, 'SERVICE_UNAVAILABLE');

    const rows = await app.pool.query('select id from plugins where source_id like $1', [
      `${local}@%`,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it('does not reuse a different source whose runtime name collides', async () => {
    const local = unique('collision');
    // 占住 runtime name，模拟 ZIP 导入或其他市场已有同名插件。
    const existing = await inject(app, {
      method: 'POST',
      url: `/api/plugins/import?slug=${encodeURIComponent(local)}`,
      headers: { ...auth(), 'content-type': 'application/zip' },
      payload: Buffer.from(
        zipSync({
          '.claude-plugin/plugin.json': new TextEncoder().encode(manifest(local)),
          'skills/review/SKILL.md': new TextEncoder().encode('# review'),
        }),
      ),
    });
    expect(existing.statusCode, existing.body).toBe(201);
    pluginIds.push(existing.json<{ plugin: { id: string } }>().plugin.id);

    result = installOutput(`${local}@other-market`);
    const res = await inject(app, {
      method: 'POST',
      url: '/api/plugins/install',
      headers: auth(),
      payload: { marketplace: 'owner/other-market', plugin: local },
    });
    expectProblem(res, 'CONFLICT');
    const rows = await app.pool.query('select id from plugins where source_id = $1', [
      `${local}@other-market`,
    ]);
    expect(rows.rowCount).toBe(0);
  });
});
