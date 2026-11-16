import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { newId } from '@agentport/db';
import { infraReady, loginCookie, request, startApp, type TestApp, unique } from './helpers.js';

const ready = await infraReady;

const SOURCE = {
  'wren_project.yml':
    'schema_version: 5\nname: shop\nversion: "1.0"\ncatalog: wren\nschema: public\ndata_source: duckdb\n',
  'models/orders/metadata.yml': 'name: orders\ncolumns:\n  - name: id\n    type: INTEGER\n',
  'models/legacy/metadata.yml': 'name: legacy\ncolumns:\n  - name: id\n    type: INTEGER\n',
};

const CANDIDATE = {
  'wren_project.yml': SOURCE['wren_project.yml'],
  'models/orders/metadata.yml':
    'name: orders\ncolumns:\n  - name: id\n    type: INTEGER\n  - name: amount\n    type: DECIMAL\n',
  'models/customers/metadata.yml': 'name: customers\ncolumns:\n  - name: id\n    type: INTEGER\n',
};

describe.skipIf(!ready)('data domain enrichment routes', () => {
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
        'delete from data_domain_enrichment_proposals where data_domain_id = any($1::text[])',
        [app.client.array(domainIds, 'TEXT')],
      );
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

  async function createReadyVersion(
    domainId: string,
    files: Record<string, string> = SOURCE,
  ): Promise<string> {
    const versionId = newId('dataDomainVersion');
    await app.client.unsafe(
      `insert into data_domain_versions (id, data_domain_id, status, project_files, mdl_manifest)
       values ($1, $2, 'ready', $3::jsonb, '{}')`,
      [versionId, domainId, JSON.stringify(files)],
    );
    return versionId;
  }

  async function createProposal(domainId: string, versionId: string): Promise<string> {
    const res = await request(app, {
      method: 'POST',
      url: `/api/data-domains/${domainId}/enrich`,
      headers: { cookie },
      payload: { sourceVersionId: versionId, instruction: '补充订单表的业务含义' },
    });
    expect(res.statusCode, res.body).toBe(202);
    return res.json<{ id: string }>().id;
  }

  async function completeProposal(proposalId: string, files: Record<string, string>) {
    await app.client.unsafe(
      `update data_domain_enrichment_proposals
       set status = 'ready', summary = '补充订单语义', project_files = $2::jsonb
       where id = $1`,
      [proposalId, JSON.stringify(files)],
    );
  }

  async function versionCount(domainId: string): Promise<number> {
    const [row] = await app.client.unsafe<{ count: string }[]>(
      'select count(*)::text as count from data_domain_versions where data_domain_id = $1',
      [domainId],
    );
    return Number(row?.count ?? '0');
  }

  it('creates a generating proposal for a ready source version', async () => {
    const domainId = await createDomain();
    const versionId = await createReadyVersion(domainId);

    const res = await request(app, {
      method: 'POST',
      url: `/api/data-domains/${domainId}/enrich`,
      headers: { cookie },
      payload: { sourceVersionId: versionId, instruction: '补充订单表的业务含义' },
    });

    expect(res.statusCode, res.body).toBe(202);
    const body = res.json<{ id: string; status: string; sourceVersionId: string }>();
    expect(body.status).toBe('generating');
    expect(body.sourceVersionId).toBe(versionId);
    const [row] = await app.client.unsafe<{ status: string }[]>(
      'select status from data_domain_enrichment_proposals where id = $1',
      [body.id],
    );
    expect(row?.status).toBe('generating');
  });

  it('rejects enrichment from a source version that is not ready', async () => {
    const domainId = await createDomain();
    const versionId = newId('dataDomainVersion');
    await app.client.unsafe(
      `insert into data_domain_versions (id, data_domain_id, status, project_files)
       values ($1, $2, 'queued', $3::jsonb)`,
      [versionId, domainId, JSON.stringify(SOURCE)],
    );

    const res = await request(app, {
      method: 'POST',
      url: `/api/data-domains/${domainId}/enrich`,
      headers: { cookie },
      payload: { sourceVersionId: versionId, instruction: '补充业务含义' },
    });

    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ message: string }>().message).toContain('只能基于已就绪的版本');
  });

  it('reports added, removed and modified files in the proposal detail', async () => {
    const domainId = await createDomain();
    const versionId = await createReadyVersion(domainId);
    const proposalId = await createProposal(domainId, versionId);
    await completeProposal(proposalId, CANDIDATE);

    const res = await request(app, {
      method: 'GET',
      url: `/api/data-domains/${domainId}/proposals/${proposalId}`,
      headers: { cookie },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{
      status: string;
      projectFiles: Record<string, string>;
      changedFiles: Array<{ path: string; status: string }>;
    }>();
    expect(body.status).toBe('ready');
    expect(body.projectFiles).toEqual(CANDIDATE);
    expect(body.changedFiles).toEqual(
      expect.arrayContaining([
        { path: 'models/customers/metadata.yml', status: 'added' },
        { path: 'models/legacy/metadata.yml', status: 'removed' },
        { path: 'models/orders/metadata.yml', status: 'modified' },
      ]),
    );
    expect(body.changedFiles).toHaveLength(3);
  });

  it('reports no changed files before the candidate is generated', async () => {
    const domainId = await createDomain();
    const versionId = await createReadyVersion(domainId);
    const proposalId = await createProposal(domainId, versionId);

    const res = await request(app, {
      method: 'GET',
      url: `/api/data-domains/${domainId}/proposals/${proposalId}`,
      headers: { cookie },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{
      status: string;
      projectFiles: Record<string, string>;
      changedFiles: Array<{ path: string; status: string }>;
    }>();
    expect(body.status).toBe('generating');
    expect(body.projectFiles).toEqual({});
    expect(body.changedFiles).toEqual([]);
  });

  it('rejecting a ready proposal leaves the version history untouched', async () => {
    const domainId = await createDomain();
    const versionId = await createReadyVersion(domainId);
    const proposalId = await createProposal(domainId, versionId);
    await completeProposal(proposalId, CANDIDATE);
    const before = await versionCount(domainId);

    const res = await request(app, {
      method: 'POST',
      url: `/api/data-domains/${domainId}/proposals/${proposalId}/decision`,
      headers: { cookie },
      payload: { decision: 'reject' },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ proposal: { status: string }; version: unknown }>();
    expect(body.proposal.status).toBe('rejected');
    expect(body.version).toBeNull();
    expect(await versionCount(domainId)).toBe(before);
  });

  it('approving a ready proposal creates a new version', async () => {
    const domainId = await createDomain();
    const versionId = await createReadyVersion(domainId);
    const proposalId = await createProposal(domainId, versionId);
    await completeProposal(proposalId, CANDIDATE);

    const res = await request(app, {
      method: 'POST',
      url: `/api/data-domains/${domainId}/proposals/${proposalId}/decision`,
      headers: { cookie },
      payload: { decision: 'approve' },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{
      proposal: { status: string };
      version: { id: string; dataDomainId: string; status: string };
    }>();
    expect(body.proposal.status).toBe('approved');
    expect(body.version.dataDomainId).toBe(domainId);
    expect(body.version.status).toBe('queued');

    const list = await request(app, {
      method: 'GET',
      url: `/api/data-domains/${domainId}/versions`,
      headers: { cookie },
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json<{ id: string }[]>().some((version) => version.id === body.version.id)).toBe(
      true,
    );
    const [stored] = await app.client.unsafe<{ project_files: Record<string, string> }[]>(
      'select project_files from data_domain_versions where id = $1',
      [body.version.id],
    );
    expect(stored?.project_files).toEqual(CANDIDATE);
  });

  it('returns 404 for a proposal owned by another data domain', async () => {
    const domainId = await createDomain();
    const otherDomainId = await createDomain();
    const versionId = await createReadyVersion(domainId);
    const proposalId = await createProposal(domainId, versionId);
    await completeProposal(proposalId, CANDIDATE);

    const detail = await request(app, {
      method: 'GET',
      url: `/api/data-domains/${otherDomainId}/proposals/${proposalId}`,
      headers: { cookie },
    });
    expect(detail.statusCode, detail.body).toBe(404);

    const decision = await request(app, {
      method: 'POST',
      url: `/api/data-domains/${otherDomainId}/proposals/${proposalId}/decision`,
      headers: { cookie },
      payload: { decision: 'approve' },
    });
    expect(decision.statusCode, decision.body).toBe(404);
  });
});
