import { createHash } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareOutputDraft, publishOutputSnapshot } from '@agentport/core';
import { newId, repo } from '@agentport/db';
import { type OutputFile, problemSchema } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getQueue } from '../src/queue/producer.js';
import {
  cleanup,
  createAgent,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  queueIdle,
  startApp,
  unique,
} from './helpers.js';

// POST /api/chat 会入队；没有 worker 消费才能断言用户消息的持久化内容。
const ready = (await infraReady) && (await queueIdle);

const MAX_PREVIEW = 1024 * 1024;

describe.skipIf(!ready)('conversation outputs', () => {
  let app: FastifyInstance;
  let cookie: string;
  const agentSlugs: string[] = [];
  const conversationIds: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    for (const runId of runIds) {
      await getQueue()
        .getJob(runId)
        .then((job) => job?.remove())
        .catch(() => undefined);
    }
    await cleanup(app, { agentSlugs, runIds });
    await app.pool.query('delete from conversations where id = any($1::text[])', [conversationIds]);
    for (const slug of agentSlugs) {
      await rm(join(app.config.WORKSPACES_DIR, slug, 'conversation-outputs'), {
        recursive: true,
        force: true,
      });
    }
    await app.close();
  });

  const auth = () => ({ cookie });

  const newAgent = async (): Promise<{ id: string; slug: string }> => {
    const slug = unique('output-agent');
    const res = await createAgent(app, cookie, { slug, track: agentSlugs });
    return res.json<{ id: string; slug: string }>();
  };

  const newConversation = async (agentId: string): Promise<string> => {
    const id = newId('conversation');
    await repo.chat.createConversation(app.db, { id, agentId, title: '成果' });
    conversationIds.push(id);
    return id;
  };

  /** 用真实存储接口发布一版快照，测试只验证 HTTP 层。 */
  const publish = async (
    slug: string,
    conversationId: string,
    runId: string,
    files: Record<string, string | Buffer>,
    anchors: { userMessageId?: string; afterMessageId?: string; status?: string } = {},
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
      status: (anchors.status ?? 'succeeded') as 'succeeded',
      userMessageId: anchors.userMessageId ?? newId('message'),
      afterMessageId: anchors.afterMessageId ?? newId('message'),
    });
  };

  const get = (url: string, headers: Record<string, string> = auth()) =>
    inject(app, { method: 'GET', url, headers });

  const outputsDir = (slug: string) =>
    join(app.config.WORKSPACES_DIR, slug, 'conversation-outputs');

  it('requires auth and 404s an unknown conversation', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);

    expectProblem(await get(`/api/conversations/${id}/outputs`, {}), 'UNAUTHORIZED');
    expectProblem(
      await get(`/api/conversations/${id}/outputs/run_x?path=a.md`, {}),
      'UNAUTHORIZED',
    );
    expectProblem(
      await get(`/api/conversations/${id}/outputs/run_x/content?path=a.md`, {}),
      'UNAUTHORIZED',
    );
    expectProblem(
      await get(`/api/conversations/${id}/outputs/run_x/download?path=a.md`, {}),
      'UNAUTHORIZED',
    );
    expectProblem(await get('/api/conversations/conv_missing/outputs'), 'CONVERSATION_NOT_FOUND');
    expectProblem(
      await get('/api/conversations/conv_missing/outputs/run_x?path=a.md'),
      'CONVERSATION_NOT_FOUND',
    );
    expectProblem(
      await get('/api/conversations/conv_missing/outputs/run_x/content?path=a.md'),
      'CONVERSATION_NOT_FOUND',
    );
  });

  it('lists published files newest first and pages with the returned cursor', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    await publish(agent.slug, id, 'run_1', { 'report.md': '# 报告\n', 'data.csv': 'a,b\n1,2\n' });
    await publish(agent.slug, id, 'run_2', { 'report.md': '# 新报告\n' });

    const first = await get(`/api/conversations/${id}/outputs?limit=2`);
    expect(first.statusCode, first.body).toBe(200);
    const page = first.json<{
      items: Array<{ runId: string; path: string; mediaType: string; status: string }>;
      nextBefore: string | null;
    }>();
    expect(page.items.map((item) => `${item.runId}:${item.path}`)).toEqual([
      'run_2:report.md',
      'run_1:data.csv',
    ]);
    expect(page.items[0]?.mediaType).toBe('text/markdown');
    expect(page.items.every((item) => item.status === 'succeeded')).toBe(true);
    expect(page.nextBefore).not.toBeNull();

    const second = await get(
      `/api/conversations/${id}/outputs?limit=2&before=${encodeURIComponent(page.nextBefore ?? '')}`,
    );
    expect(second.statusCode, second.body).toBe(200);
    expect(
      second
        .json<{ items: Array<{ runId: string; path: string }> }>()
        .items.map((item) => `${item.runId}:${item.path}`),
    ).toEqual(['run_1:report.md']);

    expectProblem(await get(`/api/conversations/${id}/outputs?limit=0`), 'INVALID_INPUT');
    expectProblem(await get(`/api/conversations/${id}/outputs?limit=101`), 'INVALID_INPUT');
    expectProblem(
      await get(`/api/conversations/${id}/outputs?before=${encodeURIComponent('not-a-cursor')}`),
      'INVALID_INPUT',
    );
  });

  it('returns exact version metadata without content, even outside the list page', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    const first = {
      userMessageId: newId('message'),
      afterMessageId: newId('message'),
    };
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    await publish(agent.slug, id, 'run_meta_1', { 'report.md': '# v1\n', 'chart.png': png }, first);
    await publish(agent.slug, id, 'run_meta_2', { 'report.md': '# v2\n' });
    await publish(agent.slug, id, 'run_meta_3', { 'report.md': '# v3\n' });

    const page = await get(`/api/conversations/${id}/outputs?limit=1`);
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json<{ items: Array<{ runId: string }> }>().items[0]?.runId).toBe('run_meta_3');

    const exact = await get(`/api/conversations/${id}/outputs/run_meta_1?path=report.md`);
    expect(exact.statusCode, exact.body).toBe(200);
    const body = exact.json<{ file: OutputFile; content?: string }>();
    expect(Object.keys(body)).toEqual(['file']);
    expect(body.file).toEqual({
      runId: 'run_meta_1',
      path: 'report.md',
      size: Buffer.byteLength('# v1\n'),
      sha256: createHash('sha256').update('# v1\n').digest('hex'),
      mediaType: 'text/markdown',
      createdAt: expect.any(String),
      status: 'succeeded',
      userMessageId: first.userMessageId,
      afterMessageId: first.afterMessageId,
    });
    expect(body).not.toHaveProperty('content');

    const image = await get(`/api/conversations/${id}/outputs/run_meta_1?path=chart.png`);
    expect(image.statusCode, image.body).toBe(200);
    expect(image.json<{ file: OutputFile }>().file).toMatchObject({
      runId: 'run_meta_1',
      path: 'chart.png',
      mediaType: 'image/png',
      size: png.length,
      sha256: createHash('sha256').update(png).digest('hex'),
    });
  });

  it('scopes metadata to the conversation and rejects unknown versions or members', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    const otherId = await newConversation(agent.id);
    await publish(agent.slug, id, 'run_scope', { 'report.md': '# scope\n' });
    await publish(agent.slug, otherId, 'run_elsewhere', { 'report.md': '# elsewhere\n' });

    expectProblem(
      await get(`/api/conversations/${id}/outputs/run_elsewhere?path=report.md`),
      'INVALID_INPUT',
    );
    expectProblem(
      await get(`/api/conversations/${id}/outputs/run_missing?path=report.md`),
      'INVALID_INPUT',
    );
    expectProblem(
      await get(`/api/conversations/${id}/outputs/run_scope?path=missing.md`),
      'INVALID_INPUT',
    );
    expectProblem(
      await get(
        `/api/conversations/${id}/outputs/run_scope?path=${encodeURIComponent('../escape.md')}`,
      ),
      'INVALID_INPUT',
    );
    expectProblem(
      await get('/api/conversations/conv_missing/outputs/run_scope?path=report.md'),
      'CONVERSATION_NOT_FOUND',
    );
  });

  it('returns complete UTF-8 text and refuses binary or oversized previews', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    const big = 'x'.repeat(MAX_PREVIEW + 1);
    const invalid = Buffer.from([0xff, 0xfe, 0x00]);
    await publish(agent.slug, id, 'run_text', {
      'note.md': '# 标题\n\n正文 ✨\n',
      'page.html': '<script>alert(1)</script>',
      'chart.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
      'large.txt': big,
      'broken.txt': invalid,
    });

    const text = await get(`/api/conversations/${id}/outputs/run_text/content?path=note.md`);
    expect(text.statusCode, text.body).toBe(200);
    expect(text.json()).toMatchObject({
      content: '# 标题\n\n正文 ✨\n',
      file: { runId: 'run_text', path: 'note.md', mediaType: 'text/markdown' },
    });

    expectProblem(
      await get(`/api/conversations/${id}/outputs/run_text/content?path=chart.png`),
      'UNSUPPORTED_MEDIA_TYPE',
    );
    expectProblem(
      await get(`/api/conversations/${id}/outputs/run_text/content?path=large.txt`),
      'PAYLOAD_TOO_LARGE',
    );
    expectProblem(
      await get(`/api/conversations/${id}/outputs/run_text/content?path=broken.txt`),
      'UNSUPPORTED_MEDIA_TYPE',
    );
    expectProblem(
      await get(`/api/conversations/${id}/outputs/run_text/content?path=missing.md`),
      'NOT_FOUND',
    );
    expectProblem(
      await get(
        `/api/conversations/${id}/outputs/run_text/content?path=${encodeURIComponent('../escape.md')}`,
      ),
      'INVALID_INPUT',
    );

    const html = await get(`/api/conversations/${id}/outputs/run_text/content?path=page.html`);
    expect(html.statusCode, html.body).toBe(200);
    expect(html.json<{ content: string }>().content).toBe('<script>alert(1)</script>');
  });

  it('downloads raw bytes as an attachment that cannot execute in this origin', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    const big = 'x'.repeat(MAX_PREVIEW + 1);
    const report = Buffer.from('# 报告\n', 'utf8');
    await publish(agent.slug, id, 'run_dl', {
      'chart.png': png,
      'page.html': '<script>alert(1)</script>',
      'large.txt': big,
      '报告 最终.md': report,
      '报告(最终)*v2.md': report,
    });

    const image = await get(`/api/conversations/${id}/outputs/run_dl/download?path=chart.png`);
    expect(image.statusCode, image.body).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.rawPayload.equals(png)).toBe(true);

    const html = await get(`/api/conversations/${id}/outputs/run_dl/download?path=page.html`);
    expect(html.statusCode, html.body).toBe(200);
    expect(String(html.headers['content-disposition'])).toMatch(/^attachment;/);
    expect(String(html.headers['content-disposition'])).toContain("filename*=UTF-8''");
    expect(html.headers['x-content-type-options']).toBe('nosniff');
    expect(html.headers['cache-control']).toBe('no-store');

    const large = await get(`/api/conversations/${id}/outputs/run_dl/download?path=large.txt`);
    expect(large.statusCode, large.body).toBe(200);
    expect(large.rawPayload.length).toBe(MAX_PREVIEW + 1);

    const unicode = await get(
      `/api/conversations/${id}/outputs/run_dl/download?path=${encodeURIComponent('报告 最终.md')}`,
    );
    expect(unicode.statusCode, unicode.body).toBe(200);
    expect(unicode.rawPayload.equals(report)).toBe(true);

    const special = await get(
      `/api/conversations/${id}/outputs/run_dl/download?path=${encodeURIComponent('报告(最终)*v2.md')}`,
    );
    expect(special.statusCode, special.body).toBe(200);
    expect(special.rawPayload.equals(report)).toBe(true);
    const disposition = String(special.headers['content-disposition']);
    expect(disposition.split("filename*=UTF-8''")[1]).not.toMatch(/[()*]/);
    expect(disposition).toBe(
      'attachment; filename="__(__)*v2.md"; filename*=UTF-8\'\'%E6%8A%A5%E5%91%8A%28%E6%9C%80%E7%BB%88%29%2Av2.md',
    );
  });

  it('persists the selected output on the user message without changing OpenUI fields', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    await publish(agent.slug, id, 'run_pub', { 'report.md': '# v1\n' });

    const res = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: {
        agentId: agent.id,
        conversationId: id,
        message: '基于这版继续改',
        output: { runId: 'run_pub', path: 'report.md' },
      },
    });
    expect(res.statusCode, res.body).toBe(202);
    runIds.push(res.json<{ runId: string }>().runId);

    const rows = await app.pool.query<{ content: unknown }>(
      "select content from messages where conversation_id = $1 and role = 'user' order by created_at desc, id desc limit 1",
      [id],
    );
    expect(rows.rows[0]?.content).toEqual({
      type: 'text',
      text: '基于这版继续改',
      output: { runId: 'run_pub', path: 'report.md' },
    });

    // 同一轮既选成果又回传生成式 UI 动作：文本段保留动作字段，并追加所选成果。
    const actionConversation = await newConversation(agent.id);
    await publish(agent.slug, actionConversation, 'run_action', { 'form.md': '# 表单\n' });
    const withAction = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: {
        agentId: agent.id,
        conversationId: actionConversation,
        message: '按这个表单改',
        output: { runId: 'run_action', path: 'form.md' },
        openuiAction: {
          type: 'continue_conversation',
          message: '按这个表单改',
          params: { tab: 'b' },
          formState: { budget: 2500 },
        },
      },
    });
    expect(withAction.statusCode, withAction.body).toBe(202);
    runIds.push(withAction.json<{ runId: string }>().runId);

    const actionRows = await app.pool.query<{ content: unknown }>(
      "select content from messages where conversation_id = $1 and role = 'user'",
      [actionConversation],
    );
    expect(actionRows.rows[0]?.content).toEqual([
      {
        type: 'text',
        text: '按这个表单改',
        output: { runId: 'run_action', path: 'form.md' },
      },
      {
        type: 'openui_action',
        params: { tab: 'b' },
        formState: { budget: 2500 },
      },
    ]);
  });

  it('rejects a selected output that needs a conversation or belongs elsewhere', async () => {
    const agent = await newAgent();
    const other = await newAgent();
    const id = await newConversation(agent.id);
    const otherId = await newConversation(other.id);
    await publish(other.slug, otherId, 'run_other', { 'report.md': '# other\n' });

    const noConversation = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: {
        agentId: agent.id,
        message: '改一下',
        output: { runId: 'run_other', path: 'report.md' },
      },
    });
    expectProblem(noConversation, 'INVALID_INPUT');

    const foreignConversation = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: {
        agentId: agent.id,
        conversationId: otherId,
        message: '改一下',
        output: { runId: 'run_other', path: 'report.md' },
      },
    });
    expectProblem(foreignConversation, 'CONVERSATION_NOT_FOUND');

    const unknownFile = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: {
        agentId: agent.id,
        conversationId: id,
        message: '改一下',
        output: { runId: 'run_other', path: 'report.md' },
      },
    });
    expectProblem(unknownFile, 'INVALID_INPUT');

    expect(await repo.chat.listMessages(app.db, id)).toHaveLength(0);
  });

  it('copies snapshots inside the fork boundary and keeps message ids out of the response', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    const conversation = await repo.chat.getConversation(app.db, id);
    if (!conversation) throw new Error('conversation missing');
    await app.pool.query('update conversations set sdk_session_id = $2 where id = $1', [
      id,
      '66666666-7777-4888-8999-000000000000',
    ]);
    const boundary = await repo.chat.appendMessage(app.db, {
      id: newId('message'),
      conversationId: id,
      role: 'user',
      content: { type: 'text', text: '界内' },
      sdkMessageUuid: '11111111-2222-4333-8444-555555555555',
    });
    const future = await repo.chat.appendMessage(app.db, {
      id: newId('message'),
      conversationId: id,
      role: 'assistant',
      content: { type: 'text', text: '界外' },
      sdkMessageUuid: '22222222-3333-4444-8555-666666666666',
    });
    await publish(
      agent.slug,
      id,
      'run_inside',
      { 'v1.md': '# v1\n' },
      {
        userMessageId: boundary.id,
        afterMessageId: boundary.id,
      },
    );
    await publish(
      agent.slug,
      id,
      'run_future',
      { 'v2.md': '# v2\n' },
      {
        userMessageId: future.id,
        afterMessageId: future.id,
      },
    );
    // 分支会复制来源 transcript 目录；必须存在，否则首轮无从 fork。
    const sessionsDir = join(
      app.config.WORKSPACES_DIR,
      agent.slug,
      'sdk-sessions',
      id,
      'projects',
      'workspace',
    );
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, '66666666-7777-4888-8999-000000000000.jsonl'), '');

    const res = await inject(app, {
      method: 'POST',
      url: `/api/conversations/${id}/branch`,
      headers: auth(),
      payload: { fromMessageId: boundary.id },
    });
    expect(res.statusCode, res.body).toBe(201);
    const branch = res.json<Record<string, unknown>>();
    expect(branch).not.toHaveProperty('messageIds');
    conversationIds.push(String(branch.id));

    const list = await get(`/api/conversations/${String(branch.id)}/outputs`);
    expect(list.statusCode, list.body).toBe(200);
    expect(
      list
        .json<{ items: Array<{ runId: string; path: string }> }>()
        .items.map((item) => `${item.runId}:${item.path}`),
    ).toEqual(['run_inside:v1.md']);

    const read = await get(
      `/api/conversations/${String(branch.id)}/outputs/run_inside/content?path=v1.md`,
    );
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json<{ content: string }>().content).toBe('# v1\n');
  });

  it('removes outputs with the conversation and with the agent', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    await publish(agent.slug, id, 'run_del', { 'a.md': 'a' });

    const removed = await inject(app, {
      method: 'DELETE',
      url: `/api/conversations/${id}`,
      headers: auth(),
    });
    expect(removed.statusCode, removed.body).toBe(204);
    await expect(stat(join(outputsDir(agent.slug), id))).rejects.toThrow();

    const secondAgent = await newAgent();
    const secondId = await newConversation(secondAgent.id);
    await publish(secondAgent.slug, secondId, 'run_del2', { 'b.md': 'b' });
    const removedAgent = await inject(app, {
      method: 'DELETE',
      url: `/api/agents/${secondAgent.id}`,
      headers: auth(),
    });
    expect(removedAgent.statusCode, removedAgent.body).toBe(204);
    await expect(stat(join(outputsDir(secondAgent.slug)))).rejects.toThrow();
  });

  it('keeps every failure response inside the existing Problem contract', async () => {
    const agent = await newAgent();
    const id = await newConversation(agent.id);
    await publish(agent.slug, id, 'run_err', { 'a.md': 'a' });
    const res = await get(`/api/conversations/${id}/outputs/run_err/content?path=missing.md`);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(problemSchema.parse(res.json())).toMatchObject({ status: res.statusCode });
  });
});
