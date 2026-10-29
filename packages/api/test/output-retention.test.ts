import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  outputMessageAnchors,
  prepareOutputDraft,
  publishOutputSnapshot,
  writeConversationAttachments,
} from '@agentport/core';
import { newId, repo } from '@agentport/db';
import { outputShareSchema } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMaintenance } from '../../worker/src/maintenance.js';
import { createIsolatedDatabase } from '../../worker/test/isolated-db.js';
import { createAgent, infraReady, inject, loginCookie, startApp } from './helpers.js';

// 维护会删除全库旧记录，必须与其它 API 套件分库。
const isolated = (await infraReady)
  ? await createIsolatedDatabase('output_retention', process.env.DATABASE_URL)
  : null;

describe.skipIf(!isolated)('output retention through maintenance and HTTP fork', () => {
  let app: FastifyInstance;
  let cookie: string;
  let root: string;

  beforeAll(async () => {
    if (!isolated) throw new Error('isolated database missing');
    root = await mkdtemp(join(tmpdir(), 'output-retention-'));
    app = await startApp({ DATABASE_URL: isolated.url, WORKSPACES_DIR: root });
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await isolated?.close();
      if (root) await rm(root, { recursive: true, force: true });
    }
  });

  async function seed() {
    const agent = (await createAgent(app, cookie)).json<{ id: string; slug: string }>();
    const conversationId = newId('conversation');
    const runId = newId('run');
    const userMessageId = newId('message');
    const afterMessageId = newId('message');
    const boundaryId = newId('message');
    const attachmentId = newId('message');
    const old = new Date(Date.now() - 10 * 86_400_000);
    await repo.chat.createConversation(app.db, {
      id: conversationId,
      agentId: agent.id,
      title: '成果保留',
    });
    await repo.chat.createRun(app.db, { id: runId, conversationId, agentId: agent.id });
    await repo.chat.updateRun(app.db, runId, { status: 'succeeded', startedAt: old, endedAt: old });
    const attachments = await writeConversationAttachments({
      root,
      slug: agent.slug,
      conversationId,
      inputs: [{ filename: 'a.txt', dataBase64: Buffer.from('a').toString('base64') }],
    });
    await repo.chat.insertMessages(app.db, [
      ...[userMessageId, afterMessageId, newId('message')].map((id, index) => ({
        id,
        conversationId,
        runId,
        role: index === 0 ? ('user' as const) : ('assistant' as const),
        content: { type: 'text', text: `旧消息 ${index}` },
        createdAt: new Date(old.getTime() + index),
        sdkMessageUuid: randomUUID(),
      })),
      {
        id: attachmentId,
        conversationId,
        runId,
        role: 'user',
        createdAt: old,
        content: { type: 'text', text: '附件仍保留', attachments },
        sdkMessageUuid: randomUUID(),
      },
      {
        id: newId('message'),
        conversationId,
        role: 'assistant',
        createdAt: old,
        content: { type: 'text', text: '无引用孤儿' },
        sdkMessageUuid: randomUUID(),
      },
      {
        id: boundaryId,
        conversationId,
        role: 'user',
        content: { type: 'text', text: '较新续聊' },
        sdkMessageUuid: randomUUID(),
      },
    ]);
    const sessionId = randomUUID();
    await app.pool.query('update conversations set sdk_session_id = $2 where id = $1', [
      conversationId,
      sessionId,
    ]);
    const sessions = join(
      root,
      agent.slug,
      'sdk-sessions',
      conversationId,
      'projects',
      'workspace',
    );
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, `${sessionId}.jsonl`), '');
    const draft = await prepareOutputDraft({ root, slug: agent.slug, conversationId, runId });
    const bytes = Buffer.from([0, 255, 10, 13, 128, 65]);
    await writeFile(join(draft, 'original.bin'), bytes);
    await publishOutputSnapshot({
      root,
      slug: agent.slug,
      conversationId,
      runId,
      status: 'succeeded',
      userMessageId,
      afterMessageId,
    });
    return {
      ...agent,
      conversationId,
      runId,
      userMessageId,
      afterMessageId,
      boundaryId,
      attachmentId,
      bytes,
    };
  }

  it.each([
    { runDays: 1, messageDays: 2 },
    { runDays: 2, messageDays: 1 },
  ])(
    'retains published anchors across runDays=$runDays/messageDays=$messageDays and source deletion',
    async (days) => {
      const source = await seed();
      expect(
        (
          await outputMessageAnchors({
            root,
            slug: source.slug,
            conversationId: source.conversationId,
          })
        ).sort(),
      ).toEqual([source.userMessageId, source.afterMessageId].sort());
      const summary = await runMaintenance(app.db, app.log, { ...days, agentVersions: 1 }, root);
      // 用真实 HTTP fork，不能用手造 messageIds 掩盖数据库锚点消失。
      const attachment = await app.pool.query('select run_id from messages where id = $1', [
        source.attachmentId,
      ]);
      expect(attachment.rows).toEqual([{ run_id: null }]);
      const anchors = await app.pool.query(
        'select id, run_id, content from messages where id = any($1::text[]) order by id',
        [[source.userMessageId, source.afterMessageId]],
      );
      expect(anchors.rows).toHaveLength(2);
      expect(anchors.rows.every((row) => row.run_id === null)).toBe(true);
      const fork = await inject(app, {
        method: 'POST',
        url: `/api/conversations/${source.conversationId}/branch`,
        headers: { cookie },
        payload: { fromMessageId: source.boundaryId },
      });
      expect(fork.statusCode, fork.body).toBe(201);
      const branchId = fork.json<{ id: string }>().id;
      const removed = await inject(app, {
        method: 'DELETE',
        url: `/api/conversations/${source.conversationId}`,
        headers: { cookie },
      });
      expect(removed.statusCode, removed.body).toBe(204);
      await expect(
        stat(join(root, source.slug, 'conversation-outputs', source.conversationId)),
      ).rejects.toThrow();
      const downloaded = await inject(app, {
        method: 'GET',
        url: `/api/conversations/${branchId}/outputs/${source.runId}/download?path=original.bin`,
        headers: { cookie },
      });
      expect(downloaded.statusCode, downloaded.body).toBe(200);
      expect(downloaded.rawPayload).toEqual(source.bytes);
      expect(summary).toMatchObject({
        runsDeleted: 1,
        runMessagesDeleted: 1,
        orphanMessagesDeleted: 1,
      });
      expect(
        (await app.pool.query('select id from agent_runs where id = $1', [source.runId])).rowCount,
      ).toBe(0);
      const copied = await repo.chat.listMessages(app.db, branchId);
      expect(copied).toHaveLength(4);
      expect(copied.every((message) => message.runId === null)).toBe(true);
      const retained = copied.filter((message) =>
        ['旧消息 0', '旧消息 1'].includes((message.content as { text: string }).text),
      );
      expect(retained).toHaveLength(2);
    },
  );

  it('serves a share and keeps output anchors branchable after the old run is pruned', async () => {
    const source = await seed();
    const shared = await inject(app, {
      method: 'POST',
      url: `/api/conversations/${source.conversationId}/output-shares`,
      headers: { cookie },
      payload: { runId: source.runId, path: 'original.bin' },
    });
    expect(shared.statusCode, shared.body).toBe(201);
    const share = outputShareSchema.parse(shared.json<unknown>());
    const token = share.urlPath.split('#')[1] ?? '';

    const summary = await runMaintenance(
      app.db,
      app.log,
      { runDays: 1, messageDays: 1, agentVersions: 1 },
      root,
    );
    expect(summary.runsDeleted).toBe(1);
    expect(
      (await app.pool.query('select id from agent_runs where id = $1', [source.runId])).rowCount,
    ).toBe(0);

    // 分享锚定已发布快照而不是 run 行：run 被清掉后公开下载仍返回原始字节。
    const download = await inject(app, {
      method: 'GET',
      url: `/api/public/output-shares/${share.id}/download`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.rawPayload).toEqual(source.bytes);

    // 成果锚点消息在清理后仍能分支，分支侧也能按同一 runId/path 读到成果。
    const fork = await inject(app, {
      method: 'POST',
      url: `/api/conversations/${source.conversationId}/branch`,
      headers: { cookie },
      payload: { fromMessageId: source.boundaryId },
    });
    expect(fork.statusCode, fork.body).toBe(201);
    const branchId = fork.json<{ id: string }>().id;
    const branchDownload = await inject(app, {
      method: 'GET',
      url: `/api/conversations/${branchId}/outputs/${source.runId}/download?path=original.bin`,
      headers: { cookie },
    });
    expect(branchDownload.statusCode, branchDownload.body).toBe(200);
    expect(branchDownload.rawPayload).toEqual(source.bytes);
  });

  it('fails before pruning messages if a published manifest cannot be read safely', async () => {
    const source = await seed();
    const manifest = join(
      root,
      source.slug,
      'conversation-outputs',
      source.conversationId,
      'runs',
      source.runId,
      'manifest.json',
    );
    await writeFile(manifest, '{broken');
    await expect(
      runMaintenance(app.db, app.log, { runDays: 1, messageDays: 1, agentVersions: 1 }, root),
    ).rejects.toThrow();
    expect(await repo.chat.listMessages(app.db, source.conversationId)).toHaveLength(6);
    expect(
      (await app.pool.query('select id from agent_runs where id = $1', [source.runId])).rowCount,
    ).toBe(1);
  });
});
