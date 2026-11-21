import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sdkSessionDir } from '@agentport/core';
import { newId, repo } from '@agentport/db';
import type { Agent } from '@agentport/shared';
import { startRedisContainer, stopRedisContainer } from '../../worker/test/global-setup.js';
import { getQueue } from '../src/queue/producer.js';
import {
  ADMIN_BUSINESS_ID,
  cleanup,
  createAgent,
  expectProblem,
  infraReady,
  loginCookie,
  request,
  startApp,
  type TestApp,
  unique,
} from './helpers.js';
import { FakeSessionCloser, startSessionCleanupResponder } from './session-cleanup-responder.js';

const ready = await infraReady;
/**
 * 关闭确认走 Redis Pub/Sub，信道不按库隔离；本文件独占实例才能确定故障注入的 ACK 归属。
 * 与 delete-lifecycle 同一做法。
 */
const isolated = ready ? await startRedisContainer() : null;
const REDIS_URL = isolated?.url ?? 'redis://127.0.0.1:1/9';

class ProbeCloser extends FakeSessionCloser {
  probe: ((conversationId: string) => Promise<void>) | null = null;
  reject = false;

  override async closeIdle(conversationId: string, sandboxIds: readonly string[]): Promise<void> {
    await this.probe?.(conversationId);
    await super.closeIdle(conversationId, sandboxIds);
    if (this.reject) throw new Error('sandbox still busy');
  }
}

describe.skipIf(!isolated)('branch rollback cleanup', () => {
  let app: TestApp;
  let cookie: string;
  let responder: Awaited<ReturnType<typeof startSessionCleanupResponder>>;
  let closer: ProbeCloser;
  const agentSlugs: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    app = await startApp({ REDIS_URL });
    cookie = await loginCookie(app);
    closer = new ProbeCloser();
    responder = await startSessionCleanupResponder(app, closer);
  });

  afterEach(() => {
    closer.probe = null;
    closer.reject = false;
    closer.calls.length = 0;
  });

  afterAll(async () => {
    await responder.close();
    for (const runId of runIds) {
      await getQueue()
        .getJob(runId)
        .then((job) => job?.remove())
        .catch(() => undefined);
    }
    await cleanup(app, { agentSlugs });
    for (const slug of agentSlugs) {
      await rm(join(app.config.WORKSPACES_DIR, slug), { recursive: true, force: true });
    }
    await app.close();
    await stopRedisContainer(isolated);
  });

  const newAgent = async (): Promise<Agent> =>
    (
      await createAgent(app, cookie, { slug: unique('branch-cleanup'), track: agentSlugs })
    ).json<Agent>();

  const post = (payload: Record<string, unknown>) =>
    request(app, { method: 'POST', url: '/api/chat', headers: { cookie }, payload });

  const attachment = (filename: string, content: string) => ({
    filename,
    dataBase64: Buffer.from(content).toString('base64'),
  });

  const branchDirs = (slug: string, conversationId: string) => ({
    transcript: join(app.config.WORKSPACES_DIR, slug, 'sdk-sessions', conversationId),
    outputs: join(app.config.WORKSPACES_DIR, slug, 'conversation-outputs', conversationId),
    inputs: join(app.config.WORKSPACES_DIR, slug, 'conversation-inputs', conversationId),
  });

  const exists = (path: string) =>
    stat(path)
      .then(() => true)
      .catch(() => false);

  const seedBranchFiles = async (slug: string, conversationId: string): Promise<void> => {
    const dirs = branchDirs(slug, conversationId);
    await mkdir(dirs.transcript, { recursive: true });
    await writeFile(join(dirs.transcript, 'session.jsonl'), '{}\n');
    await mkdir(dirs.outputs, { recursive: true });
    await writeFile(join(dirs.outputs, 'manifest.json'), '{}\n');
    await mkdir(dirs.inputs, { recursive: true });
    await writeFile(join(dirs.inputs, 'attachment.txt'), 'x');
  };

  const brokenSource = async (): Promise<{ agent: Agent; conversationId: string }> => {
    const agent = await newAgent();
    const created = await post({
      agentId: agent.id,
      message: 'branch me',
      attachments: [attachment('branch.txt', 'branch bytes')],
    });
    expect(created.statusCode, created.body).toBe(202);
    const { runId, conversationId } = created.json<{ runId: string; conversationId: string }>();
    runIds.push(runId);
    await app.client.unsafe(
      "update agent_runs set status = 'succeeded', ended_at = now() where id = $1",
      [runId],
    );
    await app.client.unsafe('update conversations set sdk_session_id = $1 where id = $2', [
      '88888888-9999-4aaa-8bbb-cccccccccccc',
      conversationId,
    ]);
    await mkdir(sdkSessionDir(app.config.WORKSPACES_DIR, agent.slug, conversationId), {
      recursive: true,
    });
    await rm(join(app.config.WORKSPACES_DIR, agent.slug, 'conversation-inputs', conversationId), {
      recursive: true,
      force: true,
    });
    return { agent, conversationId };
  };

  const branch = (conversationId: string) =>
    request(app, {
      method: 'POST',
      url: `/api/conversations/${conversationId}/branch`,
      headers: { cookie },
      payload: {},
    });

  const branchesOf = async (conversationId: string): Promise<number> => {
    const rows = await app.client.unsafe<{ count: number }[]>(
      'select count(*)::int as count from conversations where parent_id = $1',
      [conversationId],
    );
    return rows[0]?.count ?? 0;
  };

  it('keeps the branch row and runtime files when the close acknowledgement fails', async () => {
    const { agent, conversationId } = await brokenSource();
    let branchId: string | undefined;
    closer.reject = true;
    closer.probe = async (id) => {
      branchId = id;
      await seedBranchFiles(agent.slug, id);
    };

    expectProblem(await branch(conversationId), 'CONFLICT');

    expect(branchId).toBeDefined();
    expect(await branchesOf(conversationId)).toBe(1);
    for (const dir of Object.values(branchDirs(agent.slug, branchId ?? ''))) {
      expect(await exists(dir), dir).toBe(true);
    }
  });

  it('keeps the branch row and runtime files when a queued run appears before tx B', async () => {
    const { agent, conversationId } = await brokenSource();
    let branchId: string | undefined;
    closer.probe = async (id) => {
      branchId = id;
      await seedBranchFiles(agent.slug, id);
      await repo.chat.createRun(app.db, {
        id: newId('run'),
        conversationId: id,
        agentId: agent.id,
        subject: { kind: 'user', businessId: ADMIN_BUSINESS_ID },
      });
    };

    expectProblem(await branch(conversationId), 'CONFLICT');

    expect(branchId).toBeDefined();
    expect(await branchesOf(conversationId)).toBe(1);
    for (const dir of Object.values(branchDirs(agent.slug, branchId ?? ''))) {
      expect(await exists(dir), dir).toBe(true);
    }
  });

  it('removes the branch row and runtime files when compensation succeeds', async () => {
    const { agent, conversationId } = await brokenSource();
    let branchId: string | undefined;
    closer.probe = async (id) => {
      branchId = id;
      await seedBranchFiles(agent.slug, id);
    };

    expectProblem(await branch(conversationId), 'CONFLICT');

    expect(branchId).toBeDefined();
    expect(await branchesOf(conversationId)).toBe(0);
    for (const dir of Object.values(branchDirs(agent.slug, branchId ?? ''))) {
      expect(await exists(dir), dir).toBe(false);
    }
  });
});
