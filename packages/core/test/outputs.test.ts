import { createHash } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/errors.js';
import {
  copyConversationOutputs,
  listOutputFiles,
  prepareOutputDraft,
  publishOutputSnapshot,
  readOutputFile,
  removeConversationOutputs,
} from '../src/outputs.js';

const slug = 'agent-a';
const conversationId = 'conv_1';

let root = '';

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'outputs-test-'));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-28T00:00:00.000Z'));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

async function publish(
  runId: string,
  files: Record<string, string | Buffer>,
  anchors = { userMessageId: `msg-${runId}`, afterMessageId: `msg-after-${runId}` },
): Promise<void> {
  const draft = await prepareOutputDraft({ root, slug, conversationId, runId });
  for (const [path, content] of Object.entries(files)) {
    const target = join(draft, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await publishOutputSnapshot({
    root,
    slug,
    conversationId,
    runId,
    status: 'succeeded',
    ...anchors,
  });
}

describe('publish, list and read', () => {
  it('publishes an immutable snapshot with hashes, sizes and media types', async () => {
    const binary = Buffer.from([0, 255, 1, 2, 3]);
    await publish('run_1', {
      'report.md': '# 报告\n',
      'data/table.csv': 'a,b\n1,2\n',
      'chart.png': binary,
      noext: 'x',
    });

    const { items, nextBefore } = await listOutputFiles({
      root,
      slug,
      conversationId,
      limit: 50,
    });
    expect(nextBefore).toBeNull();
    expect(items.map((item) => item.path)).toEqual([
      'chart.png',
      'data/table.csv',
      'noext',
      'report.md',
    ]);
    expect(items.map((item) => item.mediaType)).toEqual([
      'image/png',
      'text/csv',
      'application/octet-stream',
      'text/markdown',
    ]);
    expect(items[0]).toMatchObject({ runId: 'run_1', size: binary.length, status: 'succeeded' });
    expect(items[0]?.sha256).toBe(sha256(binary));
    expect(items[3]?.sha256).toBe(sha256('# 报告\n'));

    const text = await readOutputFile({
      root,
      slug,
      conversationId,
      runId: 'run_1',
      path: 'report.md',
    });
    expect(text.file).toMatchObject({
      runId: 'run_1',
      path: 'report.md',
      mediaType: 'text/markdown',
    });
    expect(text.data.equals(Buffer.from('# 报告\n'))).toBe(true);

    const image = await readOutputFile({
      root,
      slug,
      conversationId,
      runId: 'run_1',
      path: 'chart.png',
    });
    expect(Buffer.isBuffer(image.data)).toBe(true);
    expect(image.data.equals(binary)).toBe(true);
  });

  it('clears the draft after a successful publish', async () => {
    await publish('run_1', { 'a.md': 'a' });
    const conversationRoot = join(root, slug, 'conversation-outputs', conversationId);
    await expect(lstat(join(conversationRoot, 'drafts', 'run_1'))).rejects.toThrow();
    await expect(lstat(join(conversationRoot, 'drafts', 'run_1.base'))).rejects.toThrow();
  });
});

describe('draft lineage', () => {
  it('copies the source snapshot instead of linking it', async () => {
    await publish('run_1', { 'a.md': 'first', 'b.md': 'keep' });
    const draft = await prepareOutputDraft({
      root,
      slug,
      conversationId,
      runId: 'run_2',
      sourceRunId: 'run_1',
    });
    expect(await readFile(join(draft, 'a.md'), 'utf8')).toBe('first');
    await writeFile(join(draft, 'a.md'), 'second');
    await writeFile(join(draft, 'c.md'), 'new');
    await publishOutputSnapshot({
      root,
      slug,
      conversationId,
      runId: 'run_2',
      status: 'failed',
      userMessageId: 'msg-u2',
      afterMessageId: 'msg-a2',
    });

    // 旧版不可写：草稿改动只进新版本。
    const old = await readOutputFile({
      root,
      slug,
      conversationId,
      runId: 'run_1',
      path: 'a.md',
    });
    expect(old.data.toString()).toBe('first');

    const { items } = await listOutputFiles({ root, slug, conversationId, limit: 50 });
    expect(items.filter((item) => item.runId === 'run_2').map((item) => item.path)).toEqual([
      'a.md',
      'c.md',
    ]);
    expect(items.find((item) => item.runId === 'run_2' && item.path === 'a.md')?.status).toBe(
      'failed',
    );
  });

  it('does not publish a version when the copy has no changes', async () => {
    await publish('run_1', { 'a.md': 'a' });
    const draft = await prepareOutputDraft({ root, slug, conversationId, runId: 'run_2' });
    expect(await readFile(join(draft, 'a.md'), 'utf8')).toBe('a');
    await publishOutputSnapshot({
      root,
      slug,
      conversationId,
      runId: 'run_2',
      status: 'succeeded',
      userMessageId: 'msg-u2',
      afterMessageId: 'msg-a2',
    });
    const { items } = await listOutputFiles({ root, slug, conversationId, limit: 50 });
    expect(items.map((item) => `${item.runId}:${item.path}`)).toEqual(['run_1:a.md']);
  });

  it('overlays only the selected file onto the latest snapshot', async () => {
    await publish('run_1', { 'a.md': 'a1', 'b.md': 'b1', 'c.md': 'c1' });
    await publish('run_2', { 'a.md': 'a2', 'b.md': 'b2', 'c.md': 'c2' });

    const draft = await prepareOutputDraft({
      root,
      slug,
      conversationId,
      runId: 'run_3',
      sourceRunId: 'run_1',
      sourcePath: 'b.md',
    });
    // 未选中的文件保持最新版，只有 b 回到所选版本。
    expect(await readFile(join(draft, 'a.md'), 'utf8')).toBe('a2');
    expect(await readFile(join(draft, 'b.md'), 'utf8')).toBe('b1');
    expect(await readFile(`${draft}.base`, 'utf8')).toBe('run_2');
    expect(await readFile(join(draft, 'c.md'), 'utf8')).toBe('c2');

    await writeFile(join(draft, 'a.md'), 'a3');
    await publishOutputSnapshot({
      root,
      slug,
      conversationId,
      runId: 'run_3',
      status: 'succeeded',
      userMessageId: 'msg-u3',
      afterMessageId: 'msg-a3',
    });

    const v3 = await readOutputFile({ root, slug, conversationId, runId: 'run_3', path: 'b.md' });
    expect(v3.data.toString()).toBe('b1');
    // changed 相对最新基线（run_2），a 的编辑和 b 的旧版覆盖都是真实变化。
    const { items } = await listOutputFiles({ root, slug, conversationId, limit: 50 });
    expect(items.filter((item) => item.runId === 'run_3').map((item) => item.path)).toEqual([
      'a.md',
      'b.md',
    ]);
    expect(
      (
        await readOutputFile({ root, slug, conversationId, runId: 'run_3', path: 'c.md' })
      ).data.toString(),
    ).toBe('c2');
    const old = await readOutputFile({ root, slug, conversationId, runId: 'run_1', path: 'b.md' });
    expect(old.data.toString()).toBe('b1');
  });

  it('requires sourceRunId when a source file is selected', async () => {
    await expect(
      prepareOutputDraft({ root, slug, conversationId, runId: 'run_1', sourcePath: 'a.md' }),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe('trust boundary', () => {
  it('rejects symbolic and hard links in the draft and keeps the draft', async () => {
    const draft = await prepareOutputDraft({ root, slug, conversationId, runId: 'run_1' });
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'secret');
    await symlink(outside, join(draft, 'link.md'));
    await expect(
      publishOutputSnapshot({
        root,
        slug,
        conversationId,
        runId: 'run_1',
        status: 'succeeded',
        userMessageId: 'msg-u1',
        afterMessageId: 'msg-a1',
      }),
    ).rejects.toBeInstanceOf(AppError);
    expect(await readFile(join(draft, 'link.md'), 'utf8')).toBe('secret');

    await rm(join(draft, 'link.md'));
    await writeFile(join(draft, 'hard.md'), 'hard');
    await link(join(draft, 'hard.md'), join(root, 'hard-outside.md'));
    await expect(
      publishOutputSnapshot({
        root,
        slug,
        conversationId,
        runId: 'run_1',
        status: 'succeeded',
        userMessageId: 'msg-u1',
        afterMessageId: 'msg-a1',
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('reads only manifest members and rejects tampered paths', async () => {
    await publish('run_1', { 'a.md': 'a' });
    await expect(
      readOutputFile({ root, slug, conversationId, runId: 'run_1', path: 'missing.md' }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      readOutputFile({ root, slug, conversationId, runId: 'run_1', path: '../outside.md' }),
    ).rejects.toBeInstanceOf(AppError);

    const manifestPath = join(
      root,
      slug,
      'conversation-outputs',
      conversationId,
      'runs',
      'run_1',
      'manifest.json',
    );
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      files: Array<{ path: string }>;
    };
    manifest.files.push({ ...manifest.files[0], path: '../outside.md' });
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(listOutputFiles({ root, slug, conversationId, limit: 50 })).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it.each(['symbolic', 'hard'])('rejects a %s linked manifest', async (kind) => {
    await publish('run_1', { 'a.md': 'a' });
    const manifest = join(
      root,
      slug,
      'conversation-outputs',
      conversationId,
      'runs',
      'run_1',
      'manifest.json',
    );
    const saved = join(root, 'saved-manifest');
    await writeFile(saved, await readFile(manifest));
    await rm(manifest);
    if (kind === 'symbolic') await symlink(saved, manifest);
    else await link(saved, manifest);
    await expect(listOutputFiles({ root, slug, conversationId, limit: 50 })).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it('refuses to read a snapshot file swapped for a hard link', async () => {
    await publish('run_1', { 'a.md': 'a' });
    const snapshot = join(
      root,
      slug,
      'conversation-outputs',
      conversationId,
      'runs',
      'run_1',
      'files',
      'a.md',
    );
    await rm(snapshot);
    await writeFile(join(root, 'outside.md'), 'secret');
    await link(join(root, 'outside.md'), snapshot);
    await expect(
      readOutputFile({ root, slug, conversationId, runId: 'run_1', path: 'a.md' }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('refuses an intermediate directory that is a symlink out of the root', async () => {
    await publish('run_1', { 'dir/a.md': 'inside' });
    const snapshotDir = join(
      root,
      slug,
      'conversation-outputs',
      conversationId,
      'runs',
      'run_1',
      'files',
    );
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'a.md'), 'secret');
    await rm(join(snapshotDir, 'dir'), { recursive: true });
    await symlink(outside, join(snapshotDir, 'dir'));

    await expect(
      readOutputFile({ root, slug, conversationId, runId: 'run_1', path: 'dir/a.md' }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('refuses a symlinked intermediate directory in the draft', async () => {
    await publish('run_1', { 'dir/a.md': 'inside' });
    const draft = await prepareOutputDraft({ root, slug, conversationId, runId: 'run_2' });
    expect(await readFile(join(draft, 'dir/a.md'), 'utf8')).toBe('inside');

    const outside = join(root, 'outside-draft');
    await mkdir(outside);
    await writeFile(join(outside, 'a.md'), 'secret');
    await rm(join(draft, 'dir'), { recursive: true });
    await symlink(outside, join(draft, 'dir'));

    await expect(
      publishOutputSnapshot({
        root,
        slug,
        conversationId,
        runId: 'run_2',
        status: 'succeeded',
        userMessageId: 'msg-u2',
        afterMessageId: 'msg-a2',
      }),
    ).rejects.toBeInstanceOf(AppError);
    // 失败时草稿保留，外部内容没有被当成自己的字节发布。
    expect(await readFile(join(draft, 'dir/a.md'), 'utf8')).toBe('secret');
    await expect(
      readFile(
        join(root, slug, 'conversation-outputs', conversationId, 'runs', 'run_2', 'manifest.json'),
        'utf8',
      ),
    ).rejects.toThrow(/ENOENT/);
  });

  it('refuses a symlinked snapshot directory when copying a draft baseline', async () => {
    await publish('run_1', { 'a.md': 'a' });
    const runsDir = join(root, slug, 'conversation-outputs', conversationId, 'runs');
    const outside = join(root, 'outside-run');
    await mkdir(join(outside, 'files'), { recursive: true });
    await writeFile(join(outside, 'a.md_hidden'), 'x');
    await writeFile(join(outside, 'files', 'a.md'), 'secret');
    await writeFile(
      join(outside, 'manifest.json'),
      JSON.stringify({
        version: 1,
        runId: 'run_2',
        createdAt: '2026-10-27T00:00:00.000Z',
        status: 'succeeded',
        userMessageId: 'msg-u2',
        afterMessageId: 'msg-a2',
        files: [
          {
            path: 'a.md',
            size: 6,
            sha256: sha256('secret'),
            mediaType: 'text/markdown',
            changed: true,
          },
        ],
      }),
    );
    await symlink(outside, join(runsDir, 'run_2'));

    await expect(
      prepareOutputDraft({ root, slug, conversationId, runId: 'run_3' }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('refuses to copy ordinary snapshot files through a symlinked intermediate directory', async () => {
    await publish('run_1', { 'dir/a.md': 'inside' });
    const files = join(
      root,
      slug,
      'conversation-outputs',
      conversationId,
      'runs',
      'run_1',
      'files',
    );
    const outside = join(root, 'copy-outside');
    await mkdir(outside);
    await writeFile(join(outside, 'a.md'), 'secret');
    await rm(join(files, 'dir'), { recursive: true });
    await symlink(outside, join(files, 'dir'));
    await expect(
      prepareOutputDraft({ root, slug, conversationId, runId: 'run_2' }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      copyConversationOutputs({
        root,
        slug,
        sourceConversationId: conversationId,
        targetConversationId: 'branch',
        messageIds: { 'msg-run_1': 'u', 'msg-after-run_1': 'a' },
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('rejects path escapes in identifiers', async () => {
    await expect(
      prepareOutputDraft({ root, slug: '../escape', conversationId, runId: 'run_1' }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      prepareOutputDraft({ root, slug, conversationId: '../escape', runId: 'run_1' }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      prepareOutputDraft({ root, slug, conversationId, runId: '../../etc' }),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe('empty baseline and empty draft', () => {
  it('publishes an empty snapshot when a non-empty baseline is cleared', async () => {
    await publish('run_1', { 'a.md': 'a', 'b.md': 'b' });
    const draft = await prepareOutputDraft({ root, slug, conversationId, runId: 'run_2' });
    await rm(join(draft, 'a.md'));
    await rm(join(draft, 'b.md'));
    await publishOutputSnapshot({
      root,
      slug,
      conversationId,
      runId: 'run_2',
      status: 'succeeded',
      userMessageId: 'msg-u2',
      afterMessageId: 'msg-a2',
    });

    // 空快照本身可读：files 为空、没有复活任何旧文件。
    const manifest = JSON.parse(
      await readFile(
        join(root, slug, 'conversation-outputs', conversationId, 'runs', 'run_2', 'manifest.json'),
        'utf8',
      ),
    ) as { files: unknown[] };
    expect(manifest.files).toEqual([]);

    // 下一轮以空快照为基线，旧文件不会复活。
    const next = await prepareOutputDraft({ root, slug, conversationId, runId: 'run_3' });
    expect(await readdir(next)).toEqual([]);
  });

  it('skips publishing when there is no baseline and no files', async () => {
    const draft = await prepareOutputDraft({ root, slug, conversationId, runId: 'run_1' });
    expect(await readdir(draft)).toEqual([]);
    await publishOutputSnapshot({
      root,
      slug,
      conversationId,
      runId: 'run_1',
      status: 'succeeded',
      userMessageId: 'msg-u1',
      afterMessageId: 'msg-a1',
    });
    expect((await listOutputFiles({ root, slug, conversationId, limit: 50 })).items).toEqual([]);
    await expect(
      readFile(
        join(root, slug, 'conversation-outputs', conversationId, 'runs', 'run_1', 'manifest.json'),
        'utf8',
      ),
    ).rejects.toThrow(/ENOENT/);
  });

  it('skips publishing when an empty baseline is still empty', async () => {
    await publish('run_1', { 'a.md': 'a' });
    const draft = await prepareOutputDraft({ root, slug, conversationId, runId: 'run_2' });
    await rm(join(draft, 'a.md'));
    await publishOutputSnapshot({
      root,
      slug,
      conversationId,
      runId: 'run_2',
      status: 'succeeded',
      userMessageId: 'msg-u2',
      afterMessageId: 'msg-a2',
    });
    await prepareOutputDraft({ root, slug, conversationId, runId: 'run_3' });
    await publishOutputSnapshot({
      root,
      slug,
      conversationId,
      runId: 'run_3',
      status: 'succeeded',
      userMessageId: 'msg-u3',
      afterMessageId: 'msg-a3',
    });
    await expect(
      readFile(
        join(root, slug, 'conversation-outputs', conversationId, 'runs', 'run_3', 'manifest.json'),
        'utf8',
      ),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe('pagination', () => {
  it('pages versions newest first without dropping same-millisecond entries', async () => {
    await publish('run_a', { 'a.md': 'a', 'b.md': 'b' });
    await publish('run_b', { 'b.md': 'b2', 'c.md': 'c' });
    await publish('run_c', { 'd.md': 'd' });

    const all = await listOutputFiles({ root, slug, conversationId, limit: 50 });
    expect(all.items).toHaveLength(5);
    expect(all.items.map((item) => `${item.runId}:${item.path}`)).toEqual([
      'run_c:d.md',
      'run_b:b.md',
      'run_b:c.md',
      'run_a:a.md',
      'run_a:b.md',
    ]);

    const seen: string[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await listOutputFiles({
        root,
        slug,
        conversationId,
        limit: 1,
        ...(before === undefined ? {} : { before }),
      });
      expect(page.items).toHaveLength(1);
      const [item] = page.items;
      if (!item) throw new Error('expected item');
      seen.push(`${item.runId}:${item.path}`);
      if (page.nextBefore === null) break;
      before = page.nextBefore;
    }
    expect(seen).toEqual(all.items.map((item) => `${item.runId}:${item.path}`));

    await expect(
      listOutputFiles({ root, slug, conversationId, limit: 1, before: 'not-a-cursor' }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('keeps page order for paths where locale order and code-unit order differ', async () => {
    await publish('run_1', { 'a.md': 'a', 'B.md': 'b', '10.md': 'n', '2.md': 'm' });

    const all = await listOutputFiles({ root, slug, conversationId, limit: 50 });
    const expected = ['10.md', '2.md', 'B.md', 'a.md'];
    expect(all.items.map((item) => item.path)).toEqual(expected);

    const seen: string[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await listOutputFiles({
        root,
        slug,
        conversationId,
        limit: 1,
        ...(before === undefined ? {} : { before }),
      });
      for (const item of page.items) seen.push(item.path);
      if (page.nextBefore === null) break;
      before = page.nextBefore;
    }
    expect(seen).toEqual(expected);
  });
});

describe('fork copy and removal', () => {
  it('copies only snapshots inside the fork boundary and remaps anchors', async () => {
    await publish('run_1', { 'a.md': 'a' }, { userMessageId: 'msg-u1', afterMessageId: 'msg-a1' });
    await publish('run_2', { 'b.md': 'b' }, { userMessageId: 'msg-u2', afterMessageId: 'msg-a2' });

    await copyConversationOutputs({
      root,
      slug,
      sourceConversationId: conversationId,
      targetConversationId: 'conv_branch',
      messageIds: { 'msg-u1': 'msg-u1-new', 'msg-a1': 'msg-a1-new' },
    });

    const copied = await listOutputFiles({
      root,
      slug,
      conversationId: 'conv_branch',
      limit: 50,
    });
    expect(copied.items.map((item) => `${item.runId}:${item.path}`)).toEqual(['run_1:a.md']);

    const manifest = JSON.parse(
      await readFile(
        join(root, slug, 'conversation-outputs', 'conv_branch', 'runs', 'run_1', 'manifest.json'),
        'utf8',
      ),
    ) as { runId: string; userMessageId: string; afterMessageId: string };
    expect(manifest.runId).toBe('run_1');
    expect(manifest.userMessageId).toBe('msg-u1-new');
    expect(manifest.afterMessageId).toBe('msg-a1-new');

    // 源删除后分支独立可读。
    await removeConversationOutputs({ root, slug, conversationId });
    const branch = await readOutputFile({
      root,
      slug,
      conversationId: 'conv_branch',
      runId: 'run_1',
      path: 'a.md',
    });
    expect(branch.data.toString()).toBe('a');
  });

  it('can remove the same conversation twice', async () => {
    await publish('run_1', { 'a.md': 'a' });
    await removeConversationOutputs({ root, slug, conversationId });
    await removeConversationOutputs({ root, slug, conversationId });
    expect((await listOutputFiles({ root, slug, conversationId, limit: 50 })).items).toEqual([]);
  });
});
