import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Agent } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  testConfig,
  unique,
} from './helpers.js';
import { FakeSessionCloser, startSessionCleanupResponder } from './session-cleanup-responder.js';

// 有 worker 消费时 queued run 会被真实执行，准入/清理断言失去意义。
const ready = (await infraReady) && (await queueIdle);

const attachment = (filename: string, content = 'hello attachment') => ({
  filename,
  dataBase64: Buffer.from(content).toString('base64'),
});

const inputsDir = (slug: string, conversationId: string): string =>
  join(testConfig().WORKSPACES_DIR, slug, 'conversation-inputs', conversationId);

const filesIn = async (dir: string): Promise<string[]> => readdir(dir).catch(() => [] as string[]);

describe.skipIf(!ready)('chat attachments', () => {
  let app: FastifyInstance;
  let cookie: string;
  let sessions: Awaited<ReturnType<typeof startSessionCleanupResponder>>;
  const agentSlugs: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
    sessions = await startSessionCleanupResponder(app, new FakeSessionCloser());
  });

  afterAll(async () => {
    await sessions.close();
    for (const runId of runIds) {
      await getQueue()
        .getJob(runId)
        .then((job) => job?.remove())
        .catch(() => undefined);
    }
    for (const slug of agentSlugs) {
      await rm(join(testConfig().WORKSPACES_DIR, slug), { recursive: true, force: true });
    }
    await cleanup(app, { agentSlugs, runIds });
    await app.close();
  });

  const newAgent = async (): Promise<Agent> =>
    (
      await createAgent(app, cookie, { slug: unique('attach-agent'), track: agentSlugs })
    ).json<Agent>();

  const post = (payload: Record<string, unknown>) =>
    inject(app, { method: 'POST', url: '/api/chat', headers: { cookie }, payload });

  const detail = async (conversationId: string) => {
    const res = await inject(app, {
      method: 'GET',
      url: `/api/conversations/${conversationId}`,
      headers: { cookie },
    });
    if (res.statusCode !== 200) {
      throw new Error(`conversation detail failed: ${res.statusCode} ${res.body}`);
    }
    return res.json<{
      conversation: { id: string; title: string };
      messages: Array<{ role: string; content: Record<string, unknown> }>;
    }>();
  };

  const finishRun = async (runId: string): Promise<void> => {
    await app.pool.query(
      "update agent_runs set status = 'succeeded', ended_at = now() where id = $1",
      [runId],
    );
  };

  it('persists attachment metadata and files without putting bytes in the queue', async () => {
    const agent = await newAgent();
    const payload = attachment('notes.md', '# 资料');
    const res = await post({ agentId: agent.id, message: '分析一下', attachments: [payload] });
    expect(res.statusCode, res.body).toBe(202);
    const { runId, conversationId, attachments } = res.json<{
      runId: string;
      conversationId: string;
      attachments: Array<Record<string, unknown>>;
    }>();
    runIds.push(runId);

    // 202 直接带回刚发送消息的附件元数据；只有展示所需字段，绝不含字节或宿主路径。
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      filename: 'notes.md',
      mimeType: 'text/markdown',
      size: Buffer.byteLength('# 资料'),
    });
    expect(attachments[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(attachments)).not.toContain(payload.dataBase64);
    expect(JSON.stringify(attachments)).not.toContain(testConfig().WORKSPACES_DIR);

    const job = await getQueue().getJob(runId);
    expect(job?.data).toEqual({
      runId,
      agentId: agent.id,
      conversationId,
      prompt: '分析一下',
    });

    const saved = await detail(conversationId);
    const user = saved.messages.find((message) => message.role === 'user');
    const metadata = (user?.content.attachments ?? []) as Array<Record<string, unknown>>;
    expect(metadata).toHaveLength(1);
    expect(metadata[0]).toMatchObject({
      filename: 'notes.md',
      mimeType: 'text/markdown',
      size: Buffer.byteLength('# 资料'),
    });
    expect(JSON.stringify(user?.content)).not.toContain(payload.dataBase64);

    const files = await filesIn(inputsDir(agent.slug, conversationId));
    expect(files).toEqual([`${String(metadata[0]?.id)}.md`]);
    const filePath = join(inputsDir(agent.slug, conversationId), files[0] ?? '');
    expect((await stat(filePath)).size).toBe(Buffer.byteLength('# 资料'));
  });

  it('omits attachments from the 202 response for an explicit empty list', async () => {
    const agent = await newAgent();
    const res = await post({ agentId: agent.id, message: '只要正文', attachments: [] });
    expect(res.statusCode, res.body).toBe(202);
    const accepted = res.json<Record<string, unknown>>();
    runIds.push(String(accepted.runId));
    expect(accepted).not.toHaveProperty('attachments');
  });

  it('accepts an attachment-only message and titles the conversation from the filename', async () => {
    const agent = await newAgent();
    const res = await post({
      agentId: agent.id,
      message: null,
      attachments: [attachment('需求说明.md', 'spec')],
    });
    expect(res.statusCode, res.body).toBe(202);
    const { runId, conversationId } = res.json<{ runId: string; conversationId: string }>();
    runIds.push(runId);

    const saved = await detail(conversationId);
    expect(saved.conversation.title).toBe('需求说明.md');
    const user = saved.messages.find((message) => message.role === 'user');
    expect(user?.content.text).toBe('');
    expect(user?.content.attachments).toHaveLength(1);
  });

  it('titles from a sanitized filename and never stores control characters', async () => {
    const agent = await newAgent();
    const res = await post({
      agentId: agent.id,
      message: null,
      attachments: [attachment('notes\u0000.txt', 'valid content')],
    });
    expect(res.statusCode, res.body).toBe(202);
    const { runId, conversationId, attachments } = res.json<{
      runId: string;
      conversationId: string;
      attachments: Array<Record<string, unknown>>;
    }>();
    runIds.push(runId);
    expect(attachments[0]).toMatchObject({ filename: 'notes.txt', mimeType: 'text/plain' });

    const saved = await detail(conversationId);
    expect(saved.conversation.title).toBe('notes.txt');
    expect(
      Array.from(saved.conversation.title).some((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
      }),
    ).toBe(false);
    const user = saved.messages.find((message) => message.role === 'user');
    const metadata = (user?.content.attachments ?? []) as Array<Record<string, unknown>>;
    expect(metadata[0]).toMatchObject({ filename: 'notes.txt', mimeType: 'text/plain' });
  });

  it.each([
    ['unsupported type', () => [attachment('report.docx')]],
    ['fake png signature', () => [attachment('photo.png', 'not a png')]],
    ['invalid base64', () => [{ filename: 'a.txt', dataBase64: '!!!not-base64!!!' }]],
    ['oversized text', () => [attachment('big.txt', 'a'.repeat(1024 * 1024 + 1))]],
    ['too many files', () => Array.from({ length: 6 }, (_, index) => attachment(`f${index}.txt`))],
  ])('rejects %s at the entry', async (_name, build) => {
    const agent = await newAgent();
    const res = await post({ agentId: agent.id, message: 'hi', attachments: build() });
    expectProblem(res, 'INVALID_INPUT');
    const conversations = await app.pool.query(
      'select count(*)::int as count from conversations where agent_id = $1',
      [agent.id],
    );
    expect(conversations.rows[0]?.count).toBe(0);
  });

  it('rejects attachments combined with an OpenUI action', async () => {
    const agent = await newAgent();
    const res = await post({
      agentId: agent.id,
      message: 'hi',
      attachments: [attachment('a.txt')],
      openuiAction: { type: 'continue_conversation', params: {}, message: 'hi' },
    });
    expectProblem(res, 'INVALID_INPUT');
  });

  it('removes only this request files when admission fails on an existing conversation', async () => {
    const agent = await newAgent();
    const first = await post({
      agentId: agent.id,
      message: 'first',
      attachments: [attachment('first.txt', 'first')],
    });
    const { runId, conversationId } = first.json<{ runId: string; conversationId: string }>();
    runIds.push(runId);
    const before = await filesIn(inputsDir(agent.slug, conversationId));
    expect(before).toHaveLength(1);

    // queued run 让下一次准入返回 CONFLICT；文件在此之前已经写入。
    const blocked = await post({
      agentId: agent.id,
      conversationId,
      message: 'second',
      attachments: [attachment('second.txt', 'second')],
    });
    expectProblem(blocked, 'CONFLICT');

    expect(await filesIn(inputsDir(agent.slug, conversationId))).toEqual(before);
    const saved = await detail(conversationId);
    expect(saved.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    const runs = await app.pool.query(
      'select count(*)::int as count from agent_runs where conversation_id = $1',
      [conversationId],
    );
    expect(runs.rows[0]?.count).toBe(1);
  });

  it('deletes the new conversation and files when admission fails', async () => {
    const agent = await newAgent();
    // 只对本用例的消息失败：messages 表是全库共享的，不能影响并行文件。
    const marker = unique('attach-admission-fail');
    await app.pool.query(`
      create or replace function messages_attachment_admission_probe() returns trigger
      language plpgsql as $$
      begin
        if new.content->>'text' = '${marker}' then
          raise exception 'injected attachment admission failure';
        end if;
        return new;
      end $$
    `);
    await app.pool.query(`
      create trigger messages_attachment_admission_probe
      before insert on messages
      for each row execute function messages_attachment_admission_probe()
    `);

    let res: Awaited<ReturnType<typeof post>>;
    try {
      res = await post({
        agentId: agent.id,
        message: marker,
        attachments: [attachment('boom.txt')],
      });
    } finally {
      await app.pool.query(
        'drop trigger if exists messages_attachment_admission_probe on messages',
      );
      await app.pool.query('drop function if exists messages_attachment_admission_probe()');
    }

    expectProblem(res, 'INTERNAL_ERROR');
    const conversations = await app.pool.query(
      'select count(*)::int as count from conversations where agent_id = $1',
      [agent.id],
    );
    expect(conversations.rows[0]?.count).toBe(0);
    const dirs = await filesIn(
      join(testConfig().WORKSPACES_DIR, agent.slug, 'conversation-inputs'),
    );
    const remaining = (
      await Promise.all(
        dirs.map((dir) =>
          filesIn(join(testConfig().WORKSPACES_DIR, agent.slug, 'conversation-inputs', dir)),
        ),
      )
    ).flat();
    expect(remaining).toEqual([]);
  });

  it('keeps messages and files when enqueue fails', async () => {
    const agent = await newAgent();
    const queue = getQueue();
    const add = vi.spyOn(queue, 'add').mockRejectedValueOnce(new Error('redis down'));
    let res: Awaited<ReturnType<typeof post>>;
    try {
      res = await post({
        agentId: agent.id,
        message: 'keep me',
        attachments: [attachment('keep.txt', 'keep')],
      });
    } finally {
      add.mockRestore();
    }
    expectProblem(res, 'SERVICE_UNAVAILABLE');

    const runs = await app.pool.query<{
      id: string;
      conversation_id: string;
      status: string;
    }>('select id, conversation_id, status from agent_runs where agent_id = $1', [agent.id]);
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0]?.status).toBe('failed');
    const conversationId = runs.rows[0]?.conversation_id ?? '';

    const saved = await detail(conversationId);
    const user = saved.messages.find((message) => message.role === 'user');
    const metadata = (user?.content.attachments ?? []) as Array<Record<string, unknown>>;
    expect(metadata).toHaveLength(1);
    expect(await filesIn(inputsDir(agent.slug, conversationId))).toEqual([
      `${String(metadata[0]?.id)}.txt`,
    ]);
  });

  it('downloads attachments with auth and never across conversations', async () => {
    const agent = await newAgent();
    const content = 'download me 附件';
    const created = await post({
      agentId: agent.id,
      message: 'download',
      attachments: [attachment('下载说明.txt', content)],
    });
    const { runId, conversationId } = created.json<{ runId: string; conversationId: string }>();
    runIds.push(runId);

    const saved = await detail(conversationId);
    const metadata = (saved.messages.find((message) => message.role === 'user')?.content
      .attachments ?? []) as Array<{ id: string }>;
    const attachmentId = metadata[0]?.id ?? '';
    const url = `/api/conversations/${conversationId}/attachments/${attachmentId}/download`;

    const res = await inject(app, { method: 'GET', url, headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.rawPayload.toString()).toBe(content);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''");
    expect(res.headers['content-disposition']).not.toContain(testConfig().WORKSPACES_DIR);

    const anonymous = await inject(app, { method: 'GET', url });
    expect(anonymous.statusCode).toBe(401);

    const other = await post({ agentId: agent.id, message: 'other conversation' });
    const otherId = other.json<{ runId: string; conversationId: string }>().conversationId;
    runIds.push(other.json<{ runId: string }>().runId);
    const cross = await inject(app, {
      method: 'GET',
      url: `/api/conversations/${otherId}/attachments/${attachmentId}/download`,
      headers: { cookie },
    });
    expect(cross.statusCode).toBe(404);
    expect(cross.body).not.toContain(testConfig().WORKSPACES_DIR);

    const unknown = await inject(app, {
      method: 'GET',
      url: `/api/conversations/${conversationId}/attachments/00000000-0000-4000-8000-000000000000/download`,
      headers: { cookie },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('copies attachments on branch and keeps them after the source conversation is deleted', async () => {
    const agent = await newAgent();
    const created = await post({
      agentId: agent.id,
      message: 'branch me',
      attachments: [attachment('branch.txt', 'branch bytes')],
    });
    const { runId, conversationId } = created.json<{ runId: string; conversationId: string }>();
    runIds.push(runId);
    await finishRun(runId);
    await app.pool.query('update conversations set sdk_session_id = $1 where id = $2', [
      '66666666-7777-4888-8999-000000000000',
      conversationId,
    ]);
    // branch 先复制 transcript 目录；空目录即可满足这次分支的运行路径。
    await mkdir(join(testConfig().WORKSPACES_DIR, agent.slug, 'sdk-sessions', conversationId), {
      recursive: true,
    });

    const branched = await inject(app, {
      method: 'POST',
      url: `/api/conversations/${conversationId}/branch`,
      headers: { cookie },
      payload: {},
    });
    expect(branched.statusCode, branched.body).toBe(201);
    const branchId = branched.json<{ id: string }>().id;

    const original = await detail(conversationId);
    const branch = await detail(branchId);
    const originalAttachments = (original.messages.find((message) => message.role === 'user')
      ?.content.attachments ?? []) as Array<{ id: string }>;
    const branchAttachments = (branch.messages.find((message) => message.role === 'user')?.content
      .attachments ?? []) as Array<{ id: string }>;
    expect(branchAttachments.map(({ id }) => id)).toEqual(originalAttachments.map(({ id }) => id));
    expect(await filesIn(inputsDir(agent.slug, branchId))).toEqual(
      await filesIn(inputsDir(agent.slug, conversationId)),
    );

    const deleted = await inject(app, {
      method: 'DELETE',
      url: `/api/conversations/${conversationId}`,
      headers: { cookie },
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect(await filesIn(inputsDir(agent.slug, conversationId))).toEqual([]);

    const download = await inject(app, {
      method: 'GET',
      url: `/api/conversations/${branchId}/attachments/${branchAttachments[0]?.id}/download`,
      headers: { cookie },
    });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.rawPayload.toString()).toBe('branch bytes');
  });

  it('rolls back the branch when a referenced attachment file is missing', async () => {
    const agent = await newAgent();
    const created = await post({
      agentId: agent.id,
      message: 'broken branch',
      attachments: [attachment('gone.txt', 'gone')],
    });
    const { runId, conversationId } = created.json<{ runId: string; conversationId: string }>();
    runIds.push(runId);
    await finishRun(runId);
    await app.pool.query('update conversations set sdk_session_id = $1 where id = $2', [
      '77777777-8888-4999-8aaa-bbbbbbbbbbbb',
      conversationId,
    ]);
    // transcript 目录存在时 cp 才可能成功，让失败点落在附件复制。
    await mkdir(join(testConfig().WORKSPACES_DIR, agent.slug, 'sdk-sessions', conversationId), {
      recursive: true,
    });
    await rm(inputsDir(agent.slug, conversationId), { recursive: true, force: true });

    const branched = await inject(app, {
      method: 'POST',
      url: `/api/conversations/${conversationId}/branch`,
      headers: { cookie },
      payload: {},
    });
    expectProblem(branched, 'CONFLICT');
    const leftovers = await app.pool.query(
      'select count(*)::int as count from conversations where parent_id = $1',
      [conversationId],
    );
    expect(leftovers.rows[0]?.count).toBe(0);
  });

  it('keeps attachment messages queryable and downloadable after their run is pruned', async () => {
    const agent = await newAgent();
    const created = await post({
      agentId: agent.id,
      message: 'prune my run',
      attachments: [attachment('kept.txt', 'kept bytes')],
    });
    const { runId, conversationId } = created.json<{ runId: string; conversationId: string }>();
    runIds.push(runId);
    await finishRun(runId);
    // pruneRuns 会删除 run；messages.run_id 由外键置空，消息与附件必须保留。
    await app.pool.query('delete from agent_runs where id = $1', [runId]);

    const saved = await detail(conversationId);
    const metadata = (saved.messages.find((message) => message.role === 'user')?.content
      .attachments ?? []) as Array<{ id: string }>;
    expect(metadata).toHaveLength(1);

    const download = await inject(app, {
      method: 'GET',
      url: `/api/conversations/${conversationId}/attachments/${metadata[0]?.id}/download`,
      headers: { cookie },
    });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.rawPayload.toString()).toBe('kept bytes');
  });

  it('removes conversation inputs when the conversation is deleted', async () => {
    const agent = await newAgent();
    const created = await post({
      agentId: agent.id,
      message: 'delete me',
      attachments: [attachment('delete.txt')],
    });
    const { runId, conversationId } = created.json<{ runId: string; conversationId: string }>();
    runIds.push(runId);
    await finishRun(runId);
    expect(await filesIn(inputsDir(agent.slug, conversationId))).toHaveLength(1);

    const deleted = await inject(app, {
      method: 'DELETE',
      url: `/api/conversations/${conversationId}`,
      headers: { cookie },
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect(await filesIn(inputsDir(agent.slug, conversationId))).toEqual([]);
  });

  it('removes conversation inputs when the agent is deleted', async () => {
    const agent = await newAgent();
    const created = await post({
      agentId: agent.id,
      message: 'delete agent',
      attachments: [attachment('agent.txt')],
    });
    const { runId, conversationId } = created.json<{ runId: string; conversationId: string }>();
    runIds.push(runId);
    await finishRun(runId);
    expect(await filesIn(inputsDir(agent.slug, conversationId))).toHaveLength(1);

    const deleted = await inject(app, {
      method: 'DELETE',
      url: `/api/agents/${agent.id}`,
      headers: { cookie },
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect(await filesIn(inputsDir(agent.slug, conversationId))).toEqual([]);
  });
});
