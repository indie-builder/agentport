import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareOutputDraft, publishOutputSnapshot, readOutputFile } from '@agentport/core';
import { newId, repo } from '@agentport/db';
import { type OutputShare, outputShareSchema } from '@agentport/shared';
import { createIsolatedDatabase } from '../../worker/test/isolated-db.js';
import {
  ADMIN_BUSINESS_ID,
  createAgent,
  createTestAccount,
  expectProblem,
  infraReady,
  loginCookie,
  request,
  startApp,
  type TestApp,
  unique,
} from './helpers.js';

const ready = await infraReady;
const isolated = ready ? await createIsolatedDatabase('output_shares_data_domain') : null;

describe.skipIf(!ready || isolated === null)('data-domain output share guard', () => {
  let app: TestApp;
  let cookie: string;
  let workspaces: string;

  beforeAll(async () => {
    if (!isolated) throw new Error('isolated database missing');
    workspaces = await mkdtemp(join(tmpdir(), 'output-share-dd-'));
    app = await startApp({ DATABASE_URL: isolated.url, WORKSPACES_DIR: workspaces });
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await app.close();
    await isolated?.close();
    await rm(workspaces, { recursive: true, force: true });
  });

  const newAgent = async (): Promise<{ id: string; slug: string }> => {
    const slug = unique('share-dd-agent');
    const res = await createAgent(app, cookie, { slug });
    return res.json<{ id: string; slug: string }>();
  };

  const newConversation = async (agentId: string): Promise<string> => {
    const id = newId('conversation');
    await repo.chat.createConversation(app.db, {
      id,
      agentId,
      title: '数据域分享',
      subject: { kind: 'user', businessId: ADMIN_BUSINESS_ID },
    });
    return id;
  };

  const publish = async (
    slug: string,
    conversationId: string,
    runId: string,
    files: Record<string, string>,
  ): Promise<void> => {
    const draft = await prepareOutputDraft({
      root: app.config.WORKSPACES_DIR,
      slug,
      conversationId,
      runId,
    });
    for (const [path, content] of Object.entries(files)) {
      const target = join(draft, ...path.split('/'));
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, content);
    }
    await publishOutputSnapshot({
      root: app.config.WORKSPACES_DIR,
      slug,
      conversationId,
      runId,
      status: 'succeeded',
      userMessageId: newId('message'),
      afterMessageId: newId('message'),
    });
  };

  const markRestricted = (conversationId: string) =>
    app.client.unsafe('update conversations set data_domain_restricted = true where id = $1', [
      conversationId,
    ]);

  const isRestricted = async (conversationId: string): Promise<boolean> => {
    const [row] = await app.client.unsafe<{ restricted: boolean }[]>(
      'select data_domain_restricted as restricted from conversations where id = $1',
      [conversationId],
    );
    return row?.restricted ?? false;
  };

  const shareCount = async (conversationId: string): Promise<number> => {
    const [row] = await app.client.unsafe<{ count: number }[]>(
      'select count(*)::int as count from output_shares where conversation_id = $1',
      [conversationId],
    );
    return row?.count ?? 0;
  };

  const createShare = (conversationId: string, runId: string, path: string) =>
    request(app, {
      method: 'POST',
      url: `/api/conversations/${conversationId}/output-shares`,
      headers: { cookie },
      payload: { runId, path },
    });

  const publicGet = (url: string, token: string) =>
    request(app, { url, headers: { authorization: `Bearer ${token}` } });

  it('rejects public sharing for a restricted conversation', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    await publish(agent.slug, id, 'run_restricted', { 'report.md': '# 内部数据\n' });
    await markRestricted(id);

    expectProblem(await createShare(id, 'run_restricted', 'report.md'), 'FORBIDDEN');
    expect(await shareCount(id)).toBe(0);
  });

  it('rejects outputs inherited by a later run of the restricted conversation', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    const inherited = '# 数据域结果\n\nAlice HR 90000\n';
    await publish(agent.slug, id, 'run_dd', { 'dd-report.md': inherited });
    await markRestricted(id);
    await publish(agent.slug, id, 'run_followup', { 'followup.md': '# 后续\n' });

    const copied = await readOutputFile({
      root: app.config.WORKSPACES_DIR,
      slug: agent.slug,
      conversationId: id,
      runId: 'run_followup',
      path: 'dd-report.md',
    });
    expect(copied.data.toString('utf8')).toBe(inherited);

    expectProblem(await createShare(id, 'run_followup', 'dd-report.md'), 'FORBIDDEN');
    expect(await shareCount(id)).toBe(0);
  });

  it('invalidates existing public tokens when the conversation becomes restricted', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    const body = '# 先公开后受限\n';
    await publish(agent.slug, id, 'run_before', { 'report.md': body });

    const created = await createShare(id, 'run_before', 'report.md');
    expect(created.statusCode, created.body).toBe(201);
    const share: OutputShare = outputShareSchema.parse(created.json<unknown>());
    const token = share.urlPath.split('#')[1] ?? '';

    const metaUrl = `/api/public/output-shares/${share.id}`;
    const contentUrl = `${metaUrl}/content`;
    const downloadUrl = `${metaUrl}/download`;
    expect((await publicGet(metaUrl, token)).statusCode).toBe(200);
    expect((await publicGet(contentUrl, token)).statusCode).toBe(200);
    expect((await publicGet(downloadUrl, token)).statusCode).toBe(200);

    await markRestricted(id);

    const meta = await publicGet(metaUrl, token);
    expect(meta.statusCode, meta.body).toBe(404);
    expect((await publicGet(contentUrl, token)).statusCode).toBe(404);
    expect((await publicGet(downloadUrl, token)).statusCode).toBe(404);
  });

  it('keeps public sharing for conversations without data-domain reads', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    const body = '# 普通成果\n';
    await publish(agent.slug, id, 'run_plain', { 'report.md': body });

    const created = await createShare(id, 'run_plain', 'report.md');
    expect(created.statusCode, created.body).toBe(201);
    const share: OutputShare = outputShareSchema.parse(created.json<unknown>());
    const token = share.urlPath.split('#')[1] ?? '';

    const meta = await publicGet(`/api/public/output-shares/${share.id}`, token);
    expect(meta.statusCode, meta.body).toBe(200);
    expect(meta.json<{ file: { name: string } }>().file.name).toBe('report.md');

    const content = await publicGet(`/api/public/output-shares/${share.id}/content`, token);
    expect(content.statusCode, content.body).toBe(200);
    expect(content.json<{ content: string }>().content).toBe(body);
  });

  it('hides another user’s conversation outputs', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    await publish(agent.slug, id, 'run_private', { 'report.md': '# 私有\n' });

    const other = await createTestAccount(app, cookie);
    expectProblem(
      await request(app, {
        url: `/api/conversations/${id}/outputs`,
        headers: { cookie: other.cookie },
      }),
      'NOT_FOUND',
    );
  });

  it('keeps the restriction after the data domain and its query logs are deleted', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    await publish(agent.slug, id, 'run_deleted_domain', { 'report.md': '# 数据域结果\n' });

    const domainId = newId('dataDomain');
    await app.client.unsafe(
      `insert into data_domains (id, name, slug, datasource, connection_encrypted, created_by)
       values ($1, $2, $3, 'duckdb', 'sealed', $4)`,
      [domainId, unique('dd'), unique('dd-slug'), ADMIN_BUSINESS_ID],
    );
    await app.client.unsafe(
      `insert into data_domain_query_logs
         (id, data_domain_id, server_id, run_id, status, duration_ms)
       values ($1, $2, $3, 'run_deleted_domain', 'ok', 5)`,
      [newId('dataDomainQueryLog'), domainId, unique('dd-server')],
    );
    await markRestricted(id);
    await app.client.unsafe('delete from data_domains where id = $1', [domainId]);

    const [logs] = await app.client.unsafe<{ count: number }[]>(
      'select count(*)::int as count from data_domain_query_logs where data_domain_id = $1',
      [domainId],
    );
    expect(logs?.count).toBe(0);
    expect(await isRestricted(id)).toBe(true);
    expectProblem(await createShare(id, 'run_deleted_domain', 'report.md'), 'FORBIDDEN');
  });

  it('inherits the restriction when branching a restricted conversation', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    await publish(agent.slug, id, 'run_branch', { 'dd-report.md': '# 数据域结果\n' });
    await app.client.unsafe(
      "update conversations set sdk_session_id = 'sess-branch' where id = $1",
      [id],
    );
    await app.client.unsafe(
      `insert into messages (id, conversation_id, role, content, sdk_message_uuid)
       values ($1, $2, 'assistant', $3::jsonb, 'uuid-branch')`,
      [newId('message'), id, JSON.stringify({ text: '数据域结果' })],
    );
    await markRestricted(id);

    const branchId = newId('conversation');
    const branch = await repo.chat.branchConversation(app.db, {
      id: branchId,
      conversationId: id,
      subject: { kind: 'user', businessId: ADMIN_BUSINESS_ID },
    });
    expect(branch).not.toBeNull();
    expect(branch?.conversation.dataDomainRestricted).toBe(true);
    expect(await isRestricted(branchId)).toBe(true);
  });
});
