import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, newId, repo, schema } from '@agentport/db';
import { inArray } from 'drizzle-orm';
import {
  lastMessageIdOfRun,
  prepareRunOutputs,
  promptWithSelectedOutput,
  publishRunOutputsIfSettled,
  type RunOutputsIdentity,
  recordOutputSandboxSettlement,
  selectedOutput,
} from '../src/runs/outputs.js';
import { testAccess } from './fixtures/access.js';

const { agentOwnership, TEST_BUSINESS_ID, userSubject } = testAccess(import.meta.url);

const { db, client } = createDb(process.env.DATABASE_URL ?? '');
const dbReady = await client.unsafe('select 1').then(
  () => true,
  () => false,
);
const agentIds: string[] = [];

afterAll(async () => {
  if (dbReady) await db.delete(schema.agents).where(inArray(schema.agents.id, agentIds));
  await client.close();
});

let root: string;
let hostRoot: string;
let identity: RunOutputsIdentity;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'run-outputs-')));
  hostRoot = join(root, 'host');
  identity = {
    workspacesDir: join(root, 'work'),
    hostWorkspacesDir: hostRoot,
    slug: 'demo',
    conversationId: 'conversation-1',
    runId: 'run-1',
  };
  await mkdir(hostRoot, { recursive: true });
  await symlink(hostRoot, identity.workspacesDir);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const conversationDir = () =>
  join(identity.workspacesDir, identity.slug, 'conversation-outputs', identity.conversationId);

describe('run outputs mount and identity', () => {
  it('maps the draft dir from workspacesDir to the host path at the same relative location', async () => {
    const prepared = await prepareRunOutputs(identity);
    const relative = prepared.hostPath.slice(hostRoot.length);
    expect(prepared.hostPath.startsWith(hostRoot)).toBe(true);
    expect(join(identity.workspacesDir, relative)).toBe(
      join(conversationDir(), 'drafts', identity.runId),
    );
    expect(prepared.dir).toBe(join(conversationDir(), 'drafts', identity.runId));
    expect((await stat(prepared.dir)).isDirectory()).toBe(true);
    // 草稿目录真实存在：docker 挂载不会因为缺目录创建成 root 属主的空目录。
    await expect(readFile(join(prepared.hostPath, 'missing'), 'utf8')).rejects.toThrow(/ENOENT/);
  });
});

describe('selected output in the user message', () => {
  it('reads the ref from a persisted text message or a parts array', () => {
    const ref = { runId: 'run-old', path: 'report/final.md' };
    expect(selectedOutput({ type: 'text', text: '改一下', output: ref })).toEqual(ref);
    expect(
      selectedOutput([
        { type: 'text', text: '改一下' },
        { type: 'openui_action', output: ref },
      ]),
    ).toEqual(ref);
  });

  it.each([
    ['missing', { type: 'text', text: 'x' }],
    ['malformed', { output: { runId: 'run-1' } }],
    ['empty ids', { output: { runId: '', path: '' } }],
    ['non-object', null],
  ])('ignores %s content', (_label, content) => {
    expect(selectedOutput(content)).toBeNull();
  });

  it('appends the draft path to the prompt only when a file was selected', () => {
    expect(promptWithSelectedOutput('hi', null)).toBe('hi');
    const prompt = promptWithSelectedOutput('hi', { runId: 'run-old', path: 'report/final.md' });
    expect(prompt).toContain('/mnt/outputs/report/final.md');
    expect(prompt.startsWith('hi')).toBe(true);
  });
});

describe('publishing run outputs', () => {
  it('publishes the draft as an immutable snapshot after the container stopped', async () => {
    const { hostPath } = await prepareRunOutputs(identity);
    await writeFile(join(hostPath, 'note.md'), '# 交付');

    await expect(
      publishRunOutputsIfSettled(identity, {
        status: 'succeeded',
        userMessageId: 'message-user',
        afterMessageId: 'message-after',
        retrying: false,
      }),
    ).resolves.toEqual({ published: true });

    const manifest = JSON.parse(
      await readFile(join(conversationDir(), 'runs', identity.runId, 'manifest.json'), 'utf8'),
    );
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(['note.md']);
    await expect(readFile(join(hostPath, 'note.md'), 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('keeps the draft and publishes nothing when cleanup failed', async () => {
    const { hostPath } = await prepareRunOutputs(identity);
    await writeFile(join(hostPath, 'note.md'), '# 还在写');

    const result = await publishRunOutputsIfSettled(identity, {
      status: 'succeeded',
      userMessageId: 'message-user',
      afterMessageId: 'message-after',
      retrying: false,
      cleanupError: 'docker rm -f failed',
    });

    expect(result.published).toBe(false);
    expect(result.problem).toContain('容器未能确认停止');
    await expect(
      readFile(join(conversationDir(), 'runs', identity.runId, 'manifest.json'), 'utf8'),
    ).rejects.toThrow(/ENOENT/);
    expect(await readFile(join(hostPath, 'note.md'), 'utf8')).toBe('# 还在写');
  });

  it('keeps an earlier cleanup failure blocked across attempts with no new cleanup error', async () => {
    const { hostPath } = await prepareRunOutputs(identity);
    await writeFile(join(hostPath, 'note.md'), 'pending');
    const first = await publishRunOutputsIfSettled(identity, {
      status: 'failed',
      userMessageId: 'u',
      afterMessageId: 'a',
      retrying: true,
      cleanupError: 'stop failed',
    });
    expect(first.published).toBe(false);
    expect(first.problem).toContain('容器未能确认停止');
    expect(
      await readFile(join(conversationDir(), 'drafts', `${identity.runId}.blocked`), 'utf8'),
    ).toContain('stop failed');
    const next = await publishRunOutputsIfSettled(identity, {
      status: 'failed',
      userMessageId: 'u',
      afterMessageId: 'a',
      retrying: false,
    });
    expect(next.published).toBe(false);
    expect(next.problem).toContain('容器未能确认停止');
    expect(await readFile(join(hostPath, 'note.md'), 'utf8')).toBe('pending');
    await expect(
      readFile(join(conversationDir(), 'runs', identity.runId, 'manifest.json')),
    ).rejects.toThrow(/ENOENT/);
    await recordOutputSandboxSettlement(identity, {
      settlement: { state: 'unconfirmed', error: 'no stop ACK' },
    });
    expect(
      (
        await publishRunOutputsIfSettled(identity, {
          status: 'failed',
          userMessageId: 'u',
          afterMessageId: 'a',
          retrying: false,
        })
      ).published,
    ).toBe(false);
    await recordOutputSandboxSettlement(identity, {
      settlement: { state: 'stopped', code: 0, signal: null },
    });
    expect(
      (
        await publishRunOutputsIfSettled(identity, {
          status: 'succeeded',
          userMessageId: 'u',
          afterMessageId: 'a',
          retrying: false,
        })
      ).published,
    ).toBe(true);
    await expect(
      readFile(join(conversationDir(), 'drafts', `${identity.runId}.blocked`)),
    ).rejects.toThrow(/ENOENT/);
  });

  it.each(['external terminal state', 'database write failed'])(
    'does not resolve a boundary or publish after message save rejection: %s',
    async (reason) => {
      const { hostPath } = await prepareRunOutputs(identity);
      await writeFile(join(hostPath, 'note.md'), 'pending');
      let boundaryCalls = 0;
      const result = await publishRunOutputsIfSettled(identity, {
        status: 'succeeded',
        userMessageId: 'u',
        retrying: false,
        messagesWritten: false,
        messageSaveError: reason,
        afterMessageId: async () => {
          boundaryCalls += 1;
          return 'a';
        },
      });
      expect(result.published).toBe(false);
      expect(result.problem).toContain(reason);
      expect(boundaryCalls).toBe(0);
      expect(await readFile(join(hostPath, 'note.md'), 'utf8')).toBe('pending');
      await expect(
        readFile(join(conversationDir(), 'runs', identity.runId, 'manifest.json')),
      ).rejects.toThrow(/ENOENT/);
    },
  );

  it('keeps drafts for a run that will be retried and never overwrites it later twice', async () => {
    const { hostPath } = await prepareRunOutputs(identity);
    await writeFile(join(hostPath, 'note.md'), '# 半成品');

    const retrying = await publishRunOutputsIfSettled(identity, {
      status: 'failed',
      userMessageId: 'message-user',
      afterMessageId: 'message-after',
      retrying: true,
    });
    expect(retrying.published).toBe(false);
    expect(retrying.problem).toContain('重试');

    await writeFile(join(hostPath, 'note.md'), '# 完成');
    await publishRunOutputsIfSettled(identity, {
      status: 'succeeded',
      userMessageId: 'message-user',
      afterMessageId: 'message-after',
      retrying: false,
    });
    const first = await readFile(
      join(conversationDir(), 'runs', identity.runId, 'manifest.json'),
      'utf8',
    );
    await publishRunOutputsIfSettled(identity, {
      status: 'failed',
      userMessageId: 'message-user',
      afterMessageId: 'message-after',
      retrying: false,
    });
    expect(
      await readFile(join(conversationDir(), 'runs', identity.runId, 'manifest.json'), 'utf8'),
    ).toBe(first);
  });

  it('keeps files written in cancelled, timed-out and failed runs', async () => {
    const seen: string[] = [];
    for (const status of ['cancelled', 'timeout', 'failed'] as const) {
      const runIdentity = { ...identity, runId: `run-${status}` };
      const { hostPath } = await prepareRunOutputs(runIdentity);
      await writeFile(join(hostPath, `${status}.md`), status);
      await publishRunOutputsIfSettled(runIdentity, {
        status,
        userMessageId: 'message-user',
        afterMessageId: 'message-after',
        retrying: false,
      });
      seen.push(`${status}.md`);
      const manifest = JSON.parse(
        await readFile(join(conversationDir(), 'runs', runIdentity.runId, 'manifest.json'), 'utf8'),
      );
      expect(manifest.status).toBe(status);
      const files = manifest.files as Array<{ path: string; changed: boolean }>;
      expect(files.map((file) => file.path).sort()).toEqual([...seen].sort());
      expect(files.filter((file) => file.changed).map((file) => file.path)).toEqual([
        `${status}.md`,
      ]);
      const content = await readFile(
        join(conversationDir(), 'runs', runIdentity.runId, 'files', `${status}.md`),
        'utf8',
      );
      expect(content).toBe(status);
    }
  });
});

describe('run message boundary', () => {
  it.skipIf(!dbReady)(
    'uses the last real message even when the turn only produced tool rows',
    async () => {
      const agentId = newId('agent');
      const conversationId = newId('conversation');
      const runId = newId('run');
      agentIds.push(agentId);
      await db.insert(schema.agents).values({
        id: agentId,
        slug: `outputs-${agentId.slice(4)}`,
        name: 'outputs',
        model: 'test',
        ...agentOwnership,
      });
      await repo.chat.createConversation(db, {
        id: conversationId,
        agentId,
        title: 'outputs',
        subject: userSubject,
      });
      await repo.chat.createRun(db, {
        id: runId,
        conversationId,
        agentId,
        subject: userSubject,
      });
      const userMessageId = newId('message');
      await repo.chat.appendMessage(db, {
        id: userMessageId,
        conversationId,
        role: 'user',
        content: { type: 'text', text: '生成报告' },
        runId,
        senderBusinessId: TEST_BUSINESS_ID,
      });
      const toolMessageId = newId('message');
      await repo.chat.appendMessage(db, {
        id: toolMessageId,
        conversationId,
        role: 'tool',
        content: { type: 'tool_result', toolUseId: 'toolu_1', name: 'Write', content: 'ok' },
        runId,
      });

      expect(await lastMessageIdOfRun(db, runId)).toBe(toolMessageId);
    },
  );
});
