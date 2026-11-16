import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { infraReady, loginCookie, request, startApp, type TestApp, unique } from './helpers.js';

const ready = await infraReady;

const VALID_PROJECT = {
  'wren_project.yml':
    'schema_version: 5\nname: t\nversion: "1.0"\ncatalog: wren\nschema: public\ndata_source: duckdb\n',
  'models/t/metadata.yml': 'name: t\ncolumns:\n  - name: id\n    type: INTEGER\n',
};

describe.skipIf(!ready)('data domains routes', () => {
  let app: TestApp;
  let cookie = '';
  const domainIds: string[] = [];
  const serverNames: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterEach(async () => {
    if (domainIds.length > 0) {
      await app.client.unsafe(
        'delete from data_domain_versions where data_domain_id = any($1::text[])',
        [app.client.array(domainIds, 'TEXT')],
      );
      await app.client.unsafe('delete from data_domains where id = any($1::text[])', [
        app.client.array(domainIds, 'TEXT'),
      ]);
      domainIds.length = 0;
    }
    if (serverNames.length > 0) {
      await app.client.unsafe('delete from servers where name = any($1::text[])', [
        app.client.array(serverNames, 'TEXT'),
      ]);
      serverNames.length = 0;
    }
  });

  afterAll(async () => {
    await app.close();
  });

  async function createDomain(): Promise<string> {
    const slug = unique('dd');
    const res = await request(app, {
      method: 'POST',
      url: '/api/data-domains',
      headers: { cookie },
      payload: {
        name: unique('dd'),
        slug,
        description: '',
        datasource: 'duckdb',
        connection: { url: '/tmp' },
        queryApprovalMode: 'off',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ id: string }>().id;
    domainIds.push(id);
    serverNames.push(`dd-${slug}`);
    return id;
  }

  async function versionCount(id: string): Promise<number> {
    const [row] = await app.client.unsafe<{ count: string }[]>(
      'select count(*)::text as count from data_domain_versions where data_domain_id = $1',
      [id],
    );
    return Number(row?.count ?? '0');
  }

  it('accepts a valid project and creates a queued version', async () => {
    const id = await createDomain();
    const res = await request(app, {
      method: 'POST',
      url: `/api/data-domains/${id}/versions`,
      headers: { cookie },
      payload: { projectFiles: VALID_PROJECT },
    });
    expect(res.statusCode, res.body).toBe(202);
    const versionId = res.json<{ id: string }>().id;

    const list = await request(app, {
      method: 'GET',
      url: `/api/data-domains/${id}/versions`,
      headers: { cookie },
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json<{ id: string }[]>().some((version) => version.id === versionId)).toBe(true);
  });

  it('rejects a project without wren_project.yml', async () => {
    const id = await createDomain();
    const res = await request(app, {
      method: 'POST',
      url: `/api/data-domains/${id}/versions`,
      headers: { cookie },
      payload: {
        projectFiles: { 'models/t/metadata.yml': VALID_PROJECT['models/t/metadata.yml'] },
      },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ message: string }>().message).toContain('缺少必需文件');
    expect(await versionCount(id)).toBe(0);
  });

  it('rejects invalid YAML in a model file', async () => {
    const id = await createDomain();
    const res = await request(app, {
      method: 'POST',
      url: `/api/data-domains/${id}/versions`,
      headers: { cookie },
      payload: {
        projectFiles: {
          'wren_project.yml': VALID_PROJECT['wren_project.yml'],
          'models/t/metadata.yml': 'name: [unclosed',
        },
      },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ message: string }>().message).toContain('不是合法 YAML');
    expect(await versionCount(id)).toBe(0);
  });

  it('rejects unsafe project paths', async () => {
    const id = await createDomain();
    const res = await request(app, {
      method: 'POST',
      url: `/api/data-domains/${id}/versions`,
      headers: { cookie },
      payload: { projectFiles: { ...VALID_PROJECT, '../evil.yml': 'a: 1\n' } },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ message: string }>().message).toContain('路径不合法');
    expect(await versionCount(id)).toBe(0);
  });

  it('rejects invalid YAML hidden behind a trailing-slash path', async () => {
    const id = await createDomain();
    const res = await request(app, {
      method: 'POST',
      url: `/api/data-domains/${id}/versions`,
      headers: { cookie },
      payload: {
        projectFiles: {
          'wren_project.yml': VALID_PROJECT['wren_project.yml'],
          'models/x/metadata.yml': VALID_PROJECT['models/t/metadata.yml'],
          'models/t/metadata.yml/': 'name: [unclosed',
        },
      },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ message: string }>().message).toContain('不是合法 YAML');
    expect(await versionCount(id)).toBe(0);
  });

  it('rejects two paths that normalize to the same target', async () => {
    const id = await createDomain();
    const res = await request(app, {
      method: 'POST',
      url: `/api/data-domains/${id}/versions`,
      headers: { cookie },
      payload: {
        projectFiles: {
          'wren_project.yml': VALID_PROJECT['wren_project.yml'],
          'models/t/metadata.yml': VALID_PROJECT['models/t/metadata.yml'],
          'models/t/metadata.yml/': VALID_PROJECT['models/t/metadata.yml'],
        },
      },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ message: string }>().message).toContain('路径冲突');
    expect(await versionCount(id)).toBe(0);
  });

  it('rejects invalid JSON files', async () => {
    const id = await createDomain();
    const res = await request(app, {
      method: 'POST',
      url: `/api/data-domains/${id}/versions`,
      headers: { cookie },
      payload: { projectFiles: { ...VALID_PROJECT, 'x.json': '{bad' } },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ message: string }>().message).toContain('不是合法 JSON');
    expect(await versionCount(id)).toBe(0);
  });

  it('rejects unresolved YAML aliases', async () => {
    const id = await createDomain();
    const res = await request(app, {
      method: 'POST',
      url: `/api/data-domains/${id}/versions`,
      headers: { cookie },
      payload: {
        projectFiles: {
          'wren_project.yml': VALID_PROJECT['wren_project.yml'],
          'models/t/metadata.yml': 'name: *missing\n',
        },
      },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ message: string }>().message).toContain('不是合法 YAML');
    expect(await versionCount(id)).toBe(0);
  });
});
