import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteMemoryFile,
  listMemoryFiles,
  readMemoryFile,
  writeMemoryFile,
} from '../src/features/agents/memory-files.js';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rename: vi.fn(fs.rename),
    readdir: vi.fn(fs.readdir),
    open: vi.fn(fs.open),
    unlink: vi.fn(fs.unlink),
  };
});

let root: string;
const slug = 'test-agent';
const operations = ['list', 'read', 'write', 'delete'] as const;
function operate(operation: (typeof operations)[number], name = 'MEMORY.md') {
  switch (operation) {
    case 'list':
      return listMemoryFiles(root, slug);
    case 'read':
      return readMemoryFile(root, slug, name);
    case 'write':
      return writeMemoryFile(root, slug, name, 'replacement');
    case 'delete':
      return deleteMemoryFile(root, slug, name);
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'memory-files-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('memory files', () => {
  it('returns empty results only for missing paths', async () => {
    await expect(listMemoryFiles(root, slug)).resolves.toEqual({ files: [], initialized: false });
    await expect(readMemoryFile(root, slug, 'MEMORY.md')).resolves.toBeNull();
    await expect(deleteMemoryFile(root, slug, 'MEMORY.md')).resolves.toBe(false);
  });

  it('saves flat Markdown files privately and lists the index first', async () => {
    await writeMemoryFile(root, slug, 'topic.md', 'topic');
    await writeMemoryFile(root, slug, 'MEMORY.md', 'index');
    const dir = join(root, slug, 'agent-memory');
    expect((await fs.stat(join(dir, 'MEMORY.md'))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    expect((await listMemoryFiles(root, slug)).files.map((file) => file.name)).toEqual([
      'MEMORY.md',
      'topic.md',
    ]);
    await expect(readMemoryFile(root, slug, 'MEMORY.md')).resolves.toMatchObject({
      content: 'index',
    });
    await expect(deleteMemoryFile(root, slug, 'topic.md')).resolves.toBe(true);
  });

  it.each([
    '../outside.md',
    '.hidden.md',
    'topic.txt',
    'a/b.md',
    'a\\b.md',
    `${'a'.repeat(81)}.md`,
  ])('rejects invalid name %s consistently', async (name) => {
    for (const operation of ['read', 'write', 'delete'] as const) {
      await expect(operate(operation, name)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        status: 400,
      });
    }
  });

  it.each(operations)('rejects a linked Markdown file during %s', async (operation) => {
    const outside = join(root, 'private.md');
    await fs.writeFile(outside, 'private');
    const dir = join(root, slug, 'agent-memory');
    await fs.mkdir(dir, { recursive: true });
    await fs.symlink(outside, join(dir, 'MEMORY.md'));
    await expect(operate(operation)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await fs.readFile(outside, 'utf8')).toBe('private');
  });

  it.each(
    operations.flatMap((operation) =>
      ['root', 'slug', 'memory'].map((level) => ({ operation, level })),
    ),
  )('rejects linked $level directory during $operation', async ({ operation, level }) => {
    const outside = join(root, 'outside');
    await fs.mkdir(join(outside, 'agent-memory'), { recursive: true });
    if (level === 'root') {
      const linkedRoot = join(root, 'linked');
      await fs.symlink(outside, linkedRoot);
      root = linkedRoot;
    } else if (level === 'slug') {
      await fs.symlink(outside, join(root, slug));
    } else {
      await fs.mkdir(join(root, slug));
      await fs.symlink(outside, join(root, slug, 'agent-memory'));
    }
    const actualRoot = level === 'root' ? join(root, '..') : root;
    try {
      await expect(operate(operation)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    } finally {
      root = actualRoot;
    }
  });

  it('rejects a slug that escapes the workspace', async () => {
    await expect(writeMemoryFile(root, '../escape', 'MEMORY.md', 'x')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('enforces UTF-8 byte size when writing and preserves existing contents', async () => {
    await writeMemoryFile(root, slug, 'MEMORY.md', 'old');
    await expect(
      writeMemoryFile(root, slug, 'MEMORY.md', '界'.repeat(66_667)),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE', status: 413 });
    expect((await readMemoryFile(root, slug, 'MEMORY.md'))?.content).toBe('old');
    await writeMemoryFile(root, slug, 'MEMORY.md', 'é'.repeat(100_000));
    expect((await fs.stat(join(root, slug, 'agent-memory', 'MEMORY.md'))).size).toBe(200_000);
  });

  it('rejects oversized files on bounded read', async () => {
    await fs.mkdir(join(root, slug, 'agent-memory'), { recursive: true });
    await fs.writeFile(join(root, slug, 'agent-memory', 'MEMORY.md'), '界'.repeat(66_667));
    await expect(readMemoryFile(root, slug, 'MEMORY.md')).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      status: 413,
    });
  });

  it('does not treat permission errors as uninitialized memory', async () => {
    await fs.mkdir(join(root, slug, 'agent-memory'), { recursive: true });
    vi.mocked(fs.readdir).mockRejectedValueOnce(
      Object.assign(new Error('private path'), { code: 'EACCES' }),
    );
    await expect(listMemoryFiles(root, slug)).rejects.toMatchObject({ code: 'EACCES' });
  });

  it.each(['read', 'delete'] as const)('propagates IO failures during %s', async (operation) => {
    await writeMemoryFile(root, slug, 'MEMORY.md', 'old');
    const error = Object.assign(new Error('private IO details'), { code: 'EIO' });
    const original = await vi.importActual<typeof fs>('node:fs/promises');
    if (operation === 'read') {
      vi.mocked(fs.open).mockImplementation(async (...args) => {
        if (String(args[0]).endsWith('/MEMORY.md')) throw error;
        return original.open(...args);
      });
    } else {
      vi.mocked(fs.unlink).mockRejectedValueOnce(error);
    }
    await expect(operate(operation)).rejects.toBe(error);
    expect(await fs.readFile(join(root, slug, 'agent-memory', 'MEMORY.md'), 'utf8')).toBe('old');
  });

  it('does not follow an ancestor replaced by a link after directory validation', async () => {
    await writeMemoryFile(root, slug, 'MEMORY.md', 'safe');
    await fs.mkdir(join(root, 'outside', 'agent-memory'), { recursive: true });
    await fs.writeFile(join(root, 'outside', 'agent-memory', 'MEMORY.md'), 'private');
    const original = await vi.importActual<typeof fs>('node:fs/promises');
    let swapped = false;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (!swapped && String(args[0]).endsWith('/MEMORY.md')) {
        swapped = true;
        await original.rename(join(root, slug), join(root, 'moved'));
        await fs.symlink(join(root, 'outside'), join(root, slug));
      }
      return original.open(...args);
    });
    await expect(readMemoryFile(root, slug, 'MEMORY.md')).resolves.toMatchObject({
      content: 'safe',
    });
  });

  it('bounds actual bytes read even when the file grows after stat', async () => {
    await writeMemoryFile(root, slug, 'MEMORY.md', 'old');
    const target = join(root, slug, 'agent-memory', 'MEMORY.md');
    const original = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await original.open(...args);
      if (String(args[0]).endsWith('/MEMORY.md')) {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, 'stat').mockImplementation(async () => {
          const info = await stat();
          await fs.appendFile(target, 'x'.repeat(200_001));
          return info;
        });
      }
      return handle;
    });
    await expect(readMemoryFile(root, slug, 'MEMORY.md')).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });
  });

  it('preserves the old file and cleans temporary files if atomic replacement fails', async () => {
    await writeMemoryFile(root, slug, 'MEMORY.md', 'old');
    vi.mocked(fs.rename).mockRejectedValueOnce(
      Object.assign(new Error('disk failure'), { code: 'EIO' }),
    );
    await expect(writeMemoryFile(root, slug, 'MEMORY.md', 'new')).rejects.toMatchObject({
      code: 'EIO',
    });
    expect(await fs.readFile(join(root, slug, 'agent-memory', 'MEMORY.md'), 'utf8')).toBe('old');
    expect(await fs.readdir(join(root, slug, 'agent-memory'))).toEqual(['MEMORY.md']);
  });

  it.each(['read', 'write', 'delete'] as const)(
    'rejects non-regular Markdown entries during %s',
    async (operation) => {
      await fs.mkdir(join(root, slug, 'agent-memory', 'MEMORY.md'), { recursive: true });
      await expect(operate(operation)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    },
  );
});
