import { createHash } from 'node:crypto';
import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/errors.js';
import {
  captureOutputDraft,
  copyConversationOutputs,
  listOutputFiles,
  outputDraftBlockedReason,
  outputMessageAnchors,
  prepareOutputDraft,
  publishOutputSnapshot,
  readOutputFile,
  removeConversationOutputs,
  setOutputDraftBlocked,
  sha256Hex,
} from '../src/outputs.js';

/** 只在用例显式打开时注入一次 rename 失败；其余测试走真实实现。 */
const renameFault = vi.hoisted(() => ({
  match: null as null | ((from: string, to: string) => boolean),
  injected: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (
      from: Parameters<typeof actual.rename>[0],
      to: Parameters<typeof actual.rename>[1],
    ) => {
      if (renameFault.match?.(String(from), String(to))) {
        renameFault.match = null;
        renameFault.injected += 1;
        throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
      }
      await actual.rename(from, to);
    },
  };
});

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
  renameFault.match = null;
  renameFault.injected = 0;
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

async function writeFiles(dir: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

/** 复用容器时 /mnt/outputs 的稳定宿主目录；这里放在产出根内，与 worker 配置一致。 */
function sessionOutputsDir(conversation = conversationId): string {
  return join(root, slug, 'session-outputs', conversation);
}

async function publish(
  runId: string,
  files: Record<string, string | Buffer>,
  anchors = { userMessageId: `msg-${runId}`, afterMessageId: `msg-after-${runId}` },
): Promise<void> {
  const draft = await prepareOutputDraft({ root, slug, conversationId, runId });
  await writeFiles(draft, files);
  await publishOutputSnapshot({
    root,
    slug,
    conversationId,
    runId,
    status: 'succeeded',
    ...anchors,
  });
}

describe('published message anchors', () => {
  it('returns only deduped published anchors, including an empty snapshot', async () => {
    const identity = { root, slug, conversationId };
    expect(await outputMessageAnchors(identity)).toEqual([]);
    await publish(
      'run_1',
      { 'a.txt': 'a' },
      { userMessageId: 'user-1', afterMessageId: 'after-1' },
    );
    const draft = await prepareOutputDraft({ ...identity, runId: 'run_2' });
    await rm(join(draft, 'a.txt'));
    await publishOutputSnapshot({
      ...identity,
      runId: 'run_2',
      status: 'succeeded',
      userMessageId: 'user-1',
      afterMessageId: 'after-2',
    });
    await prepareOutputDraft({ ...identity, runId: 'run_unpublished' });
    expect((await outputMessageAnchors(identity)).sort()).toEqual(['after-1', 'after-2', 'user-1']);
  });

  it('rejects corrupted and linked manifests instead of returning an incomplete set', async () => {
    const identity = { root, slug, conversationId };
    await publish('run_1', { 'a.txt': 'a' });
    const manifest = join(
      root,
      slug,
      'conversation-outputs',
      conversationId,
      'runs',
      'run_1',
      'manifest.json',
    );
    const original = await readFile(manifest);
    await writeFile(manifest, '{broken');
    await expect(outputMessageAnchors(identity)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    const outside = join(root, 'linked-manifest.json');
    await writeFile(outside, original);
    await rm(manifest);
    await symlink(outside, manifest);
    await expect(outputMessageAnchors(identity)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

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
    expect(items[0]).toMatchObject({
      runId: 'run_1',
      size: binary.length,
      status: 'succeeded',
      userMessageId: 'msg-run_1',
      afterMessageId: 'msg-after-run_1',
    });
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
      userMessageId: 'msg-run_1',
      afterMessageId: 'msg-after-run_1',
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

describe('capture settled outputs mount', () => {
  it('captures the stopped mount into the draft and keeps the mount, base and blocked marker', async () => {
    await publish('run_1', { 'a.md': 'first', 'keep.md': 'keep' });
    const draft = await prepareOutputDraft({ root, slug, conversationId, runId: 'run_2' });
    const source = sessionOutputsDir();
    await writeFiles(source, { 'a.md': 'second', 'keep.md': 'keep', 'nested/b.md': 'new' });
    const storage = { root, slug, conversationId, runId: 'run_2' };
    await setOutputDraftBlocked(storage, 'still settling');

    await captureOutputDraft({ ...storage, sourceDir: source });

    expect(await readFile(join(draft, 'a.md'), 'utf8')).toBe('second');
    expect(await readFile(join(draft, 'nested/b.md'), 'utf8')).toBe('new');
    expect(await readFile(`${draft}.base`, 'utf8')).toBe('run_1');
    expect(await outputDraftBlockedReason(storage)).toBe('still settling');
    // 稳定挂载目录本身仍在：捕获只复制，不搬走或删除源目录。
    expect(await readFile(join(source, 'nested/b.md'), 'utf8')).toBe('new');
  });

  it('publishes a cancelled run from the captured draft with changes against the inherited base', async () => {
    await publish('run_1', { 'a.md': 'first', 'keep.md': 'keep' });
    await prepareOutputDraft({ root, slug, conversationId, runId: 'run_2' });
    const source = sessionOutputsDir();
    await writeFiles(source, { 'a.md': 'second', 'keep.md': 'keep', 'new.md': 'new' });
    await captureOutputDraft({ root, slug, conversationId, runId: 'run_2', sourceDir: source });

    await publishOutputSnapshot({
      root,
      slug,
      conversationId,
      runId: 'run_2',
      status: 'cancelled',
      userMessageId: 'msg-u2',
      afterMessageId: 'msg-a2',
    });

    const { items } = await listOutputFiles({ root, slug, conversationId, limit: 50 });
    expect(items.filter((item) => item.runId === 'run_2').map((item) => item.path)).toEqual([
      'a.md',
      'new.md',
    ]);
    expect(items.find((item) => item.runId === 'run_2' && item.path === 'a.md')?.status).toBe(
      'cancelled',
    );
    // 已发布旧快照与捕获到的内容各自独立。
    const old = await readOutputFile({ root, slug, conversationId, runId: 'run_1', path: 'a.md' });
    expect(old.data.toString()).toBe('first');
    const captured = await readOutputFile({
      root,
      slug,
      conversationId,
      runId: 'run_2',
      path: 'a.md',
    });
    expect(captured.data.toString()).toBe('second');
  });

  it.each(['symbolic', 'hard', 'invalid-path'] as const)(
    'rejects a %s source file and keeps the previous draft',
    async (kind) => {
      await publish('run_1', { 'a.md': 'baseline' });
      const draft = await prepareOutputDraft({ root, slug, conversationId, runId: 'run_2' });
      const source = sessionOutputsDir();
      await writeFiles(source, { 'a.md': 'from-mount' });
      const outside = join(root, `outside-${kind}.txt`);
      await writeFile(outside, 'secret');
      if (kind === 'symbolic') await symlink(outside, join(source, 'link.md'));
      else if (kind === 'hard') await link(outside, join(source, 'hard.md'));
      else await writeFiles(source, { 'bad\\name.md': 'x' });

      await expect(
        captureOutputDraft({ root, slug, conversationId, runId: 'run_2', sourceDir: source }),
      ).rejects.toBeInstanceOf(AppError);

      expect(await readFile(join(draft, 'a.md'), 'utf8')).toBe('baseline');
      expect(await readFile(`${draft}.base`, 'utf8')).toBe('run_1');
      await expect(
        readFile(
          join(
            root,
            slug,
            'conversation-outputs',
            conversationId,
            'runs',
            'run_2',
            'manifest.json',
          ),
          'utf8',
        ),
      ).rejects.toThrow(/ENOENT/);
    },
  );

  it('restores the previous draft when swapping the captured staging directory fails', async () => {
    await publish('run_1', { 'a.md': 'baseline' });
    const draft = await prepareOutputDraft({ root, slug, conversationId, runId: 'run_2' });
    const source = sessionOutputsDir();
    await writeFiles(source, { 'a.md': 'from-mount', 'nested/b.md': 'new' });
    const storage = { root, slug, conversationId, runId: 'run_2' };
    await setOutputDraftBlocked(storage, 'still settling');
    const draftsDir = join(root, slug, 'conversation-outputs', conversationId, 'drafts');

    // 只让首次「staging → 草稿」改名失败；备份改名与随后的恢复改名都走真实实现。
    renameFault.match = (from, to) => to === draft && basename(from).startsWith('.tmp-run_2-');
    await expect(captureOutputDraft({ ...storage, sourceDir: source })).rejects.toThrow(
      'injected rename failure',
    );
    expect(renameFault.injected).toBe(1);

    // 原草稿、基线标记、blocked 标记都还在，源挂载也没有被搬走。
    expect(await readFile(join(draft, 'a.md'), 'utf8')).toBe('baseline');
    expect(await readFile(`${draft}.base`, 'utf8')).toBe('run_1');
    expect(await outputDraftBlockedReason(storage)).toBe('still settling');
    expect(await readFile(join(source, 'a.md'), 'utf8')).toBe('from-mount');
    expect(await readFile(join(source, 'nested/b.md'), 'utf8')).toBe('new');
    // 失败的 staging 与恢复后的备份目录都不残留。
    expect((await readdir(draftsDir)).sort()).toEqual(['run_2', 'run_2.base', 'run_2.blocked']);
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
    expect(copied.items[0]).toMatchObject({
      userMessageId: 'msg-u1-new',
      afterMessageId: 'msg-a1-new',
    });

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

describe('slug validation', () => {
  const longSlug = 'a'.repeat(65);
  const slugError = {
    code: 'INVALID_INPUT',
    status: 400,
    retryable: false,
    path: '/slug',
    message: '智能体目录名非法',
  };

  it('accepts 64-character and mixed separator slugs for write and read', async () => {
    for (const validSlug of ['a'.repeat(64), 'a-b_c0']) {
      const draft = await prepareOutputDraft({
        root,
        slug: validSlug,
        conversationId,
        runId: 'run_1',
      });
      await writeFiles(draft, { 'a.md': validSlug });
      await publishOutputSnapshot({
        root,
        slug: validSlug,
        conversationId,
        runId: 'run_1',
        status: 'succeeded',
        userMessageId: 'msg-u1',
        afterMessageId: 'msg-a1',
      });
      const read = await readOutputFile({
        root,
        slug: validSlug,
        conversationId,
        runId: 'run_1',
        path: 'a.md',
      });
      expect(read.data.toString()).toBe(validSlug);
    }
  });

  it('rejects a 65-character slug when preparing a draft and creates nothing', async () => {
    await expect(
      prepareOutputDraft({ root, slug: longSlug, conversationId, runId: 'run_1' }),
    ).rejects.toMatchObject(slugError);
    await expect(access(join(root, longSlug))).rejects.toThrow();
  });

  it('rejects a 65-character slug when reading an existing snapshot', async () => {
    await publish('run_1', { 'a.md': 'a' });
    await mkdir(join(root, longSlug), { recursive: true });
    await rename(
      join(root, slug, 'conversation-outputs'),
      join(root, longSlug, 'conversation-outputs'),
    );
    await expect(
      readOutputFile({ root, slug: longSlug, conversationId, runId: 'run_1', path: 'a.md' }),
    ).rejects.toMatchObject(slugError);
  });

  it('rejects a 65-character slug when removing and keeps the directory', async () => {
    const conversationDir = join(root, longSlug, 'conversation-outputs', conversationId);
    await mkdir(conversationDir, { recursive: true });
    await writeFile(join(conversationDir, 'sentinel.txt'), 'keep');
    await expect(
      removeConversationOutputs({ root, slug: longSlug, conversationId }),
    ).rejects.toMatchObject(slugError);
    expect(await readFile(join(conversationDir, 'sentinel.txt'), 'utf8')).toBe('keep');
  });

  it('rejects invalid slug characters with the exact error fields', async () => {
    for (const invalid of ['', 'Agent-A', '中文', 'a b', 'a.b', '-agent', '_agent', 'a/b', '..']) {
      await expect(
        prepareOutputDraft({ root, slug: invalid, conversationId, runId: 'run_1' }),
      ).rejects.toMatchObject(slugError);
    }
  });

  it('removes a valid slug directory', async () => {
    await publish('run_1', { 'a.md': 'a' });
    await removeConversationOutputs({ root, slug, conversationId });
    await expect(
      access(join(root, slug, 'conversation-outputs', conversationId)),
    ).rejects.toThrow();
  });
});

describe('sha256Hex', () => {
  it('hashes a string with the standard SHA-256 hex digest', () => {
    expect(sha256Hex('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('hashes raw bytes the same way', () => {
    expect(sha256Hex(Buffer.from([0, 1, 2, 255]))).toBe(
      '3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56',
    );
  });
});
