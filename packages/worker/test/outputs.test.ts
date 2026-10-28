import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, newId, repo, schema } from '@agentport/db';
import { inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { persistRunMessages } from '../src/messages.js';
import {
  lastMessageIdOfRun,
  OUTPUTS_CONTAINER_DIR,
  outputPublishProblem,
  outputsMount,
  prepareRunOutputs,
  promptWithSelectedOutput,
  publishRunOutputsIfSettled,
  type RunOutputsIdentity,
  recordOutputSandboxSettlement,
  selectedOutput,
} from '../src/outputs.js';

const { db, pool } = createDb(process.env.DATABASE_URL ?? '');
const dbReady = await pool.query('select 1').then(
  () => true,
  () => false,
);
const agentIds: string[] = [];

afterAll(async () => {
  if (dbReady) await db.delete(schema.agents).where(inArray(schema.agents.id, agentIds));
  await pool.end();
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
  // 宿主挂载根是同一棵树在 docker daemon 侧的真实路径（两个目录不再是同一字符串）。
  await mkdir(hostRoot, { recursive: true });
  await symlink(hostRoot, identity.workspacesDir);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const conversationDir = () =>
  join(identity.workspacesDir, identity.slug, 'conversation-outputs', identity.conversationId);

/** 上一轮已发布快照：直接按 core 的目录约定落盘。 */
async function publishedSnapshot(runId: string, files: Record<string, string>): Promise<void> {
  const dir = join(conversationDir(), 'runs', runId);
  await mkdir(join(dir, 'files'), { recursive: true });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      runId,
      createdAt: new Date().toISOString(),
      status: 'succeeded',
      userMessageId: 'message-user',
      afterMessageId: 'message-after',
      files: Object.entries(files).map(([path, content]) => ({
        path,
        size: Buffer.byteLength(content),
        sha256: createHash('sha256').update(content).digest('hex'),
        mediaType: 'text/markdown',
        changed: true,
      })),
    }),
  );
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(dir, 'files', path), content);
  }
}

describe('run outputs mount and identity', () => {
  it('maps the draft dir from workspacesDir to the host path at the same relative location', async () => {
    const prepared = await prepareRunOutputs(identity);
    const relative = prepared.hostPath.slice(hostRoot.length);
    expect(prepared.hostPath.startsWith(hostRoot)).toBe(true);
    expect(join(identity.workspacesDir, relative)).toBe(
      join(conversationDir(), 'drafts', identity.runId),
    );
    // 草稿目录真实存在：docker 挂载不会因为缺目录创建成 root 属主的空目录。
    await expect(readFile(join(prepared.hostPath, 'missing'), 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('mounts outputs read-write at the contract container path', () => {
    expect(outputsMount('/tmp/draft')).toEqual({
      hostPath: '/tmp/draft',
      containerPath: OUTPUTS_CONTAINER_DIR,
      readonly: false,
    });
    expect(OUTPUTS_CONTAINER_DIR).toBe('/mnt/outputs');
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
    await publishRunOutputsIfSettled(identity, {
      status: 'failed',
      userMessageId: 'u',
      afterMessageId: 'a',
      retrying: true,
      cleanupError: 'stop failed',
    });
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
    await recordOutputSandboxSettlement(identity, { sandboxId: '' });
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
    await recordOutputSandboxSettlement(identity, { sandboxId: 'new-container' });
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
      const transaction = vi.fn(async () => {
        if (reason === 'database write failed') throw new Error(reason);
        return { written: false, messages: [] };
      });
      let written = false;
      let messageSaveError = reason;
      try {
        const saved = await persistRunMessages(
          { transaction } as unknown as Parameters<typeof persistRunMessages>[0],
          {
            agentId: 'agent',
            conversationId: identity.conversationId,
            runId: identity.runId,
            events: [],
          },
        );
        written = saved.written;
      } catch (error) {
        messageSaveError = error instanceof Error ? error.message : String(error);
      }
      expect(transaction).toHaveBeenCalledOnce();
      let boundaryCalls = 0;
      const result = await publishRunOutputsIfSettled(identity, {
        status: 'succeeded',
        userMessageId: 'u',
        retrying: false,
        messagesWritten: written,
        messageSaveError,
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

    // 重试成功后发布一次；再次调用不会新增版本，也不会清掉已发布内容。
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

  it('keeps the same-run snapshot untouched after the draft is gone', async () => {
    await publishedSnapshot('run-1', { 'note.md': '# 旧版' });
    // 草稿准备复制上一版后，本轮发布冲突：已存在同 run 快照时保留原快照。
    const { hostPath } = await prepareRunOutputs({ ...identity, runId: 'run-2' });
    await writeFile(join(hostPath, 'note.md'), '# 新版');
    await publishRunOutputsIfSettled(
      { ...identity, runId: 'run-2' },
      {
        status: 'succeeded',
        userMessageId: 'message-user',
        afterMessageId: 'message-after',
        retrying: false,
      },
    );
    expect(
      await readFile(join(conversationDir(), 'runs', 'run-1', 'manifest.json'), 'utf8'),
    ).toContain('"runId":"run-1"');
  });

  it('keeps the latest snapshot as baseline and overlays only the selected file', async () => {
    await publishedSnapshot('run-1', { 'a.md': 'a1', 'b.md': 'b1', 'c.md': 'c1' });
    await publishedSnapshot('run-2', { 'a.md': 'a2', 'b.md': 'b2', 'c.md': 'c2' });

    // 用户选择 v1 的 b.md：只有 b 回到 v1，a 仍是最新版。
    const { hostPath } = await prepareRunOutputs({
      ...identity,
      runId: 'run-3',
      sourceRunId: 'run-1',
      sourcePath: 'b.md',
    });
    expect(await readFile(join(hostPath, 'a.md'), 'utf8')).toBe('a2');
    expect(await readFile(join(hostPath, 'b.md'), 'utf8')).toBe('b1');

    await writeFile(join(hostPath, 'a.md'), 'a3');
    await publishRunOutputsIfSettled(
      { ...identity, runId: 'run-3' },
      {
        status: 'succeeded',
        userMessageId: 'message-user',
        afterMessageId: 'message-after',
        retrying: false,
      },
    );

    const manifest = JSON.parse(
      await readFile(join(conversationDir(), 'runs', 'run-3', 'manifest.json'), 'utf8'),
    ) as { files: Array<{ path: string; changed: boolean }> };
    expect(manifest.files.filter((file) => file.changed).map((file) => file.path)).toEqual([
      'a.md',
      'b.md',
    ]);
    expect(await readFile(join(conversationDir(), 'runs', 'run-3', 'files', 'c.md'), 'utf8')).toBe(
      'c2',
    );
    expect(await readFile(join(conversationDir(), 'runs', 'run-3', 'files', 'b.md'), 'utf8')).toBe(
      'b1',
    );
    expect(await readFile(join(conversationDir(), 'runs', 'run-1', 'files', 'b.md'), 'utf8')).toBe(
      'b1',
    );
  });

  it('keeps files written in cancelled, timed-out and failed runs', async () => {
    // 每轮都是完整快照：本轮文件必须在内，上一轮的文件作为基线继续存在。
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
      // 只有本轮写下的那个文件是 changed，列表据此只展示新产出。
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

describe('output publish gate', () => {
  it('explains why a publish is skipped, in order of severity', () => {
    expect(outputPublishProblem({ cleanupError: 'rm failed', retrying: true })).toContain(
      '容器未能确认停止',
    );
    expect(outputPublishProblem({ retrying: true })).toContain('重试');
    expect(outputPublishProblem({ retrying: false })).toBeUndefined();
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
      });
      await repo.chat.createConversation(db, { id: conversationId, agentId, title: 'outputs' });
      await repo.chat.createRun(db, { id: runId, conversationId, agentId });
      const userMessageId = newId('message');
      await repo.chat.appendMessage(db, {
        id: userMessageId,
        conversationId,
        role: 'user',
        content: { type: 'text', text: '生成报告' },
        runId,
      });
      const toolMessageId = newId('message');
      await repo.chat.appendMessage(db, {
        id: toolMessageId,
        conversationId,
        role: 'tool',
        content: { type: 'tool_result', toolUseId: 'toolu_1', name: 'Write', content: 'ok' },
        runId,
      });

      // 只有工具消息的轮次没有任何助手文本；边界仍必须是真实消息 id，不能回落到用户消息。
      expect(await lastMessageIdOfRun(db, runId)).toBe(toolMessageId);
    },
  );
});
