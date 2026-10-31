import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decryptSecrets, prepareOutputDraft, publishOutputSnapshot } from '@agentport/core';
import { newId, repo } from '@agentport/db';
import { type OutputShare, outputShareSchema, problemSchema } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIsolatedDatabase } from '../../worker/test/isolated-db.js';
import { buildApp } from '../src/app.js';
import { registerOutputShareRoutes } from '../src/features/output-shares/routes.js';
import {
  ADMIN_BUSINESS_ID,
  cleanup,
  createAgent,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  testConfig,
  unique,
} from './helpers.js';
import { FakeSessionCloser, startSessionCleanupResponder } from './session-cleanup-responder.js';

const ready = await infraReady;
// 删除会持有共享库的绑定锁；独享库避免与同轮其它删除套件的长等待互相超时。
const isolated = ready ? await createIsolatedDatabase('output_shares') : null;

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

describe.skipIf(!ready || isolated === null)('output shares', () => {
  let app: FastifyInstance;
  let cookie: string;
  let sessions: Awaited<ReturnType<typeof startSessionCleanupResponder>>;
  const agentSlugs: string[] = [];
  const conversationIds: string[] = [];

  beforeAll(async () => {
    if (!isolated) throw new Error('isolated database missing');
    app = await buildApp(testConfig({ DATABASE_URL: isolated.url }));
    // 路由并入 registerRoutes 之前由测试显式挂载；集成后 hasRoute 命中，不会重复注册。
    if (!app.hasRoute({ method: 'GET', url: '/api/public/output-shares/:id' })) {
      registerOutputShareRoutes(app);
    }
    await app.ready();
    sessions = await startSessionCleanupResponder(app, new FakeSessionCloser());
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await sessions.close();
    await cleanup(app, { agentSlugs });
    await app.pool.query('delete from conversations where id = any($1::text[])', [conversationIds]);
    for (const slug of agentSlugs) {
      await rm(join(app.config.WORKSPACES_DIR, slug, 'conversation-outputs'), {
        recursive: true,
        force: true,
      });
    }
    await app.close();
    await isolated?.close();
  });

  const auth = () => ({ cookie });

  const newAgent = async (): Promise<{ id: string; slug: string }> => {
    const slug = unique('share-agent');
    const res = await createAgent(app, cookie, { slug, track: agentSlugs });
    return res.json<{ id: string; slug: string }>();
  };

  const newConversation = async (agentId: string): Promise<string> => {
    const id = newId('conversation');
    await repo.chat.createConversation(app.db, {
      id,
      agentId,
      title: '分享',
      subject: { kind: 'user', businessId: ADMIN_BUSINESS_ID },
    });
    conversationIds.push(id);
    return id;
  };

  const publish = async (
    slug: string,
    conversationId: string,
    runId: string,
    files: Record<string, string | Buffer>,
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

  const createShare = (conversationId: string, runId: string, path: string) =>
    inject(app, {
      method: 'POST',
      url: `/api/conversations/${conversationId}/output-shares`,
      headers: auth(),
      payload: { runId, path },
    });

  const listShares = (conversationId: string, runId: string, path: string) =>
    inject(app, {
      method: 'GET',
      url: `/api/conversations/${conversationId}/output-shares?runId=${encodeURIComponent(runId)}&path=${encodeURIComponent(path)}`,
      headers: auth(),
    });

  const revoke = (id: string) =>
    inject(app, { method: 'DELETE', url: `/api/output-shares/${id}`, headers: auth() });

  const publicGet = (url: string, token?: string) =>
    inject(app, {
      method: 'GET',
      url,
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });

  const parseShare = (res: { json: <T>() => T }): OutputShare =>
    outputShareSchema.parse(res.json<unknown>());
  const tokenOf = (share: OutputShare): string => share.urlPath.split('#')[1] ?? '';
  const idOf = (share: OutputShare): string => share.id;

  it('requires auth for create, list and revoke; public links 404 without a token', async () => {
    expectProblem(
      await inject(app, {
        method: 'POST',
        url: '/api/conversations/conv_missing/output-shares',
        payload: { runId: 'run_x', path: 'a.md' },
      }),
      'UNAUTHORIZED',
    );
    expectProblem(
      await inject(app, {
        method: 'GET',
        url: '/api/conversations/conv_missing/output-shares?runId=run_x&path=a.md',
      }),
      'UNAUTHORIZED',
    );
    expectProblem(
      await inject(app, { method: 'DELETE', url: '/api/output-shares/osh_missing' }),
      'UNAUTHORIZED',
    );
    expectProblem(await publicGet('/api/public/output-shares/osh_missing'), 'NOT_FOUND');
  });

  it('stores only the token hash and ciphertext, lists by triple and revokes idempotently', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    const body = '# v1\n';
    await publish(agent.slug, id, 'run_share', { 'report.md': body });

    const created = await createShare(id, 'run_share', 'report.md');
    expect(created.statusCode, created.body).toBe(201);
    const share = parseShare(created);
    const token = tokenOf(share);
    expect(token.length).toBeGreaterThan(20);
    expect(share.urlPath).toBe(`/s/${share.id}#${token}`);
    expect(share.sha256).toBe(sha256(body));
    expect(share.revokedAt).toBeNull();

    const rows = await app.pool.query<{
      token_hash: string;
      token_encrypted: string;
      sha256: string;
    }>('select token_hash, token_encrypted, sha256 from output_shares where id = $1', [share.id]);
    const row = rows.rows[0];
    expect(row).toBeDefined();
    expect(row?.token_hash).toBe(sha256(token));
    expect(row?.token_hash).not.toBe(token);
    expect(row?.token_encrypted).not.toContain(token);
    expect(decryptSecrets(row?.token_encrypted ?? '', app.config.APP_SECRET_KEY)).toEqual({
      token,
    });

    const repeated = await createShare(id, 'run_share', 'report.md');
    expect(repeated.statusCode, repeated.body).toBe(201);
    expect(parseShare(repeated).urlPath).toBe(share.urlPath);
    expect(
      (
        await app.pool.query<{ count: number }>(
          'select count(*)::int as count from output_shares where conversation_id = $1',
          [id],
        )
      ).rows[0]?.count,
    ).toBe(1);

    const listed = await listShares(id, 'run_share', 'report.md');
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<{ items: OutputShare[] }>().items.map((item) => item.urlPath)).toEqual([
      share.urlPath,
    ]);

    expect((await revoke(idOf(share))).statusCode).toBe(204);
    expect((await revoke(idOf(share))).statusCode).toBe(204);

    const after = await listShares(id, 'run_share', 'report.md');
    const revoked = after.json<{ items: OutputShare[] }>().items[0];
    expect(revoked?.revokedAt).not.toBeNull();
    expectProblem(await publicGet(`/api/public/output-shares/${idOf(share)}`, token), 'NOT_FOUND');
  });

  it('serves public metadata, preview and download with no chat or agent details', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    const body = '# 标题\n\n正文 ✨\n';
    await publish(agent.slug, id, 'run_public', { 'report.md': body });

    const share = parseShare(await createShare(id, 'run_public', 'report.md'));
    const token = tokenOf(share);

    const meta = await publicGet(`/api/public/output-shares/${idOf(share)}`, token);
    expect(meta.statusCode, meta.body).toBe(200);
    expect(meta.headers['cache-control']).toBe('no-store');
    const file = meta.json<{ file: Record<string, unknown> }>().file;
    expect(file).toMatchObject({
      name: 'report.md',
      size: Buffer.byteLength(body),
      mediaType: 'text/markdown',
      sha256: sha256(body),
    });
    expect(Object.keys(file).sort()).toEqual(['createdAt', 'mediaType', 'name', 'sha256', 'size']);
    for (const leak of [id, 'run_public', agent.slug, agent.id]) {
      expect(meta.body).not.toContain(leak);
    }

    const content = await publicGet(`/api/public/output-shares/${idOf(share)}/content`, token);
    expect(content.statusCode, content.body).toBe(200);
    expect(content.headers['cache-control']).toBe('no-store');
    expect(content.json<{ content: string }>().content).toBe(body);
    expect(content.json<{ file: { name: string; runId?: string } }>().file.name).toBe('report.md');
    for (const leak of [id, 'run_public', agent.slug]) {
      expect(content.body).not.toContain(leak);
    }

    const download = await publicGet(`/api/public/output-shares/${idOf(share)}/download`, token);
    expect(download.statusCode, download.body).toBe(200);
    expect(sha256(download.rawPayload)).toBe(share.sha256);
    expect(download.headers['content-type']).toBe('text/markdown');
    expect(String(download.headers['content-disposition'])).toMatch(/^attachment;/);
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(download.headers['cache-control']).toBe('no-store');
  });

  it('serves published PDF bytes to a bearer token and keeps public 404s', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
    );
    await publish(agent.slug, id, 'run_pdf', { 'report.pdf': pdf });
    const share = parseShare(await createShare(id, 'run_pdf', 'report.pdf'));
    const token = tokenOf(share);
    const url = `/api/public/output-shares/${idOf(share)}/download`;

    expectProblem(await publicGet(url), 'NOT_FOUND');

    const download = await publicGet(url, token);
    expect(download.statusCode, download.body).toBe(200);
    expect(download.rawPayload.equals(pdf)).toBe(true);
    expect(download.headers['content-type']).toBe('application/pdf');
    expect(String(download.headers['content-disposition'])).toMatch(/^attachment;/);
    expect(download.headers['cache-control']).toBe('no-store');
    expect(download.headers['x-content-type-options']).toBe('nosniff');

    expect((await revoke(idOf(share))).statusCode).toBe(204);
    expectProblem(await publicGet(url, token), 'NOT_FOUND');
  });

  it('treats bad tokens, sibling files and deleted conversations as plain 404s', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    await publish(agent.slug, id, 'run_iso', {
      'report.md': '# 分享\n',
      'secret.md': '# 兄弟文件\n',
    });
    const share = parseShare(await createShare(id, 'run_iso', 'report.md'));
    const token = tokenOf(share);
    const base = `/api/public/output-shares/${idOf(share)}`;

    const wrongToken = randomBytes(32).toString('base64url');
    expectProblem(await publicGet(base, wrongToken), 'NOT_FOUND');
    expectProblem(await publicGet(`${base}/content`, wrongToken), 'NOT_FOUND');
    expectProblem(await publicGet(`${base}/download`, wrongToken), 'NOT_FOUND');
    expectProblem(
      await inject(app, {
        method: 'GET',
        url: base,
        headers: { authorization: `Basic ${token}` },
      }),
      'NOT_FOUND',
    );

    // 公开入口只认库内记录的三元组，额外 path 参数不能改变读取目标。
    const sibling = await publicGet(`${base}/content?path=secret.md`, token);
    expect(sibling.statusCode, sibling.body).toBe(200);
    expect(sibling.json<{ content: string }>().content).toBe('# 分享\n');
    const siblingDownload = await publicGet(`${base}/download?path=secret.md`, token);
    expect(siblingDownload.rawPayload.equals(Buffer.from('# 分享\n'))).toBe(true);

    // 三元组被改成兄弟文件或另一运行时，sha256 不再匹配创建值，公开访问一律 404。
    await app.pool.query("update output_shares set path = 'secret.md' where id = $1", [
      idOf(share),
    ]);
    expectProblem(await publicGet(base, token), 'NOT_FOUND');
    expectProblem(await publicGet(`${base}/content`, token), 'NOT_FOUND');
    await app.pool.query(
      "update output_shares set path = 'report.md', run_id = 'run_missing' where id = $1",
      [idOf(share)],
    );
    expectProblem(await publicGet(`${base}/download`, token), 'NOT_FOUND');
    await app.pool.query("update output_shares set run_id = 'run_iso' where id = $1", [
      idOf(share),
    ]);

    expectProblem(await createShare(id, 'run_iso', '../escape.md'), 'INVALID_INPUT');
    expectProblem(await createShare(id, 'run_iso', 'missing.md'), 'INVALID_INPUT');
    expectProblem(await createShare(id, 'run_missing', 'report.md'), 'INVALID_INPUT');

    const other = await newAgent();
    const otherId = await newConversation(other.id);
    await publish(other.slug, otherId, 'run_foreign', { 'report.md': '# 别人\n' });
    expectProblem(await createShare(id, 'run_foreign', 'report.md'), 'INVALID_INPUT');

    const removed = await inject(app, {
      method: 'DELETE',
      url: `/api/conversations/${id}`,
      headers: auth(),
    });
    expect(removed.statusCode, removed.body).toBe(204);
    expectProblem(await publicGet(base, token), 'NOT_FOUND');
    expectProblem(await publicGet(`${base}/content`, token), 'NOT_FOUND');
  });

  it('keeps a published share on its original version after the same path is republished', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    await publish(agent.slug, id, 'run_v1', { 'report.md': '# old\n' });
    const oldShare = parseShare(await createShare(id, 'run_v1', 'report.md'));

    await publish(agent.slug, id, 'run_v2', { 'report.md': '# new\n' });

    const download = await publicGet(
      `/api/public/output-shares/${idOf(oldShare)}/download`,
      tokenOf(oldShare),
    );
    expect(download.statusCode, download.body).toBe(200);
    expect(download.rawPayload.toString('utf8')).toBe('# old\n');
    expect(sha256(download.rawPayload)).toBe(oldShare.sha256);

    const meta = await publicGet(`/api/public/output-shares/${idOf(oldShare)}`, tokenOf(oldShare));
    expect(meta.json<{ file: { sha256: string } }>().file.sha256).toBe(oldShare.sha256);

    const newShare = parseShare(await createShare(id, 'run_v2', 'report.md'));
    expect(newShare.sha256).not.toBe(oldShare.sha256);
    const fresh = await publicGet(
      `/api/public/output-shares/${idOf(newShare)}/content`,
      tokenOf(newShare),
    );
    expect(fresh.json<{ content: string }>().content).toBe('# new\n');
  });

  it('rejects snapshot bytes that no longer match the manifest on create and on every public route', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    await publish(agent.slug, id, 'run_tamper', { 'report.md': '# 原始内容\n' });
    const share = parseShare(await createShare(id, 'run_tamper', 'report.md'));
    const token = tokenOf(share);
    const base = `/api/public/output-shares/${idOf(share)}`;

    // 只覆盖快照文件、不动 manifest：记录的 sha256 仍指向旧字节。
    const snapshot = join(
      app.config.WORKSPACES_DIR,
      agent.slug,
      'conversation-outputs',
      id,
      'runs',
      'run_tamper',
      'files',
      'report.md',
    );
    await writeFile(snapshot, '# 被替换的内容\n');

    expectProblem(await publicGet(base, token), 'NOT_FOUND');
    expectProblem(await publicGet(`${base}/content`, token), 'NOT_FOUND');
    expectProblem(await publicGet(`${base}/download`, token), 'NOT_FOUND');
    expectProblem(await createShare(id, 'run_tamper', 'report.md'), 'CONFLICT');
  });

  it('keeps every failure response inside the Problem contract', async () => {
    const res = await createShare('conv_missing', 'run_x', 'a.md');
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(problemSchema.parse(res.json())).toMatchObject({ status: res.statusCode });
  });
});
