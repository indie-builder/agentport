import { createHash } from 'node:crypto';
import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ATTACHMENT_LIMITS,
  type ChatAttachmentInput,
  type MessageAttachment,
} from '@agentport/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  conversationInputsDir,
  copyConversationInputs,
  decodeAttachmentInput,
  displayAttachmentFilename,
  readConversationAttachment,
  removeConversationInputs,
  writeConversationAttachments,
} from '../src/attachments.js';
import { AppError } from '../src/errors.js';

const MiB = 1024 * 1024;
const slug = 'agent-a';
const conversationId = 'conv_1';

let root = '';

function input(filename: string, data: Buffer | string): ChatAttachmentInput {
  return { filename, dataBase64: Buffer.from(data).toString('base64') };
}

function expectInvalid(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INVALID_INPUT');
    return;
  }
  throw new Error('expected INVALID_INPUT');
}

const png = (body = 'x'): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(body)]);
const jpeg = (body = 'x'): Buffer =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(body)]);
const gif = (body = 'x'): Buffer => Buffer.from(`GIF89a${body}`);
const webp = (body = 'x'): Buffer =>
  Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from(body)]);
const pdf = (size = 32): Buffer =>
  Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(Math.max(0, size - 9), 0x20)]);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'attachments-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('decodeAttachmentInput', () => {
  it('decodes a valid text attachment and derives the canonical type', () => {
    const text = '# 说明';
    const decoded = decodeAttachmentInput(input('Notes.MD', text));
    expect(decoded).toMatchObject({
      filename: 'Notes.MD',
      mimeType: 'text/markdown',
      size: Buffer.byteLength(text),
      extension: '.md',
    });
    expect(decoded.data.toString('utf8')).toBe(text);
    expect(decoded.sha256).toBe(createHash('sha256').update(text).digest('hex'));
    expect(decoded.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('accepts canonical base64 with or without padding', () => {
    const padded = Buffer.from('hello').toString('base64');
    const unpadded = padded.replace(/=+$/, '');
    expect(decodeAttachmentInput({ filename: 'a.txt', dataBase64: padded }).data.toString()).toBe(
      'hello',
    );
    expect(decodeAttachmentInput({ filename: 'a.txt', dataBase64: unpadded }).data.toString()).toBe(
      'hello',
    );
  });

  it('rejects non-canonical base64 and empty content', () => {
    expectInvalid(() => decodeAttachmentInput({ filename: 'a.txt', dataBase64: 'aGVsbG8*' }));
    expectInvalid(() => decodeAttachmentInput({ filename: 'a.txt', dataBase64: 'aGVs bG8=' }));
    expectInvalid(() => decodeAttachmentInput({ filename: 'a.txt', dataBase64: 'a' }));
    expectInvalid(() => decodeAttachmentInput({ filename: 'a.txt', dataBase64: '' }));
  });

  it('rejects unsupported extensions', () => {
    expectInvalid(() => decodeAttachmentInput(input('report.docx', 'x')));
    expectInvalid(() => decodeAttachmentInput(input('report.txt.exe', 'x')));
    expectInvalid(() => decodeAttachmentInput(input('README', 'x')));
  });

  it('accepts content whose signature matches the extension', () => {
    expect(decodeAttachmentInput(input('photo.png', png())).mimeType).toBe('image/png');
    expect(decodeAttachmentInput(input('photo.jpeg', jpeg())).mimeType).toBe('image/jpeg');
    expect(decodeAttachmentInput(input('anim.gif', gif())).mimeType).toBe('image/gif');
    expect(decodeAttachmentInput(input('photo.webp', webp())).mimeType).toBe('image/webp');
    expect(decodeAttachmentInput(input('doc.pdf', pdf())).mimeType).toBe('application/pdf');
  });

  it('rejects content whose signature does not match the extension', () => {
    for (const [filename, data] of [
      ['photo.png', Buffer.from('not a png')],
      ['photo.jpg', png()],
      ['anim.gif', Buffer.from('not a gif')],
      ['photo.webp', gif()],
      ['doc.pdf', Buffer.from('not a pdf')],
    ] as const) {
      expectInvalid(() => decodeAttachmentInput(input(filename, data)));
    }
  });

  it('requires text to be valid UTF-8 without NUL bytes', () => {
    expectInvalid(() => decodeAttachmentInput(input('bad.txt', Buffer.from([0xc3, 0x28]))));
    expectInvalid(() => decodeAttachmentInput(input('bin.csv', Buffer.from('a\0b'))));
    expect(decodeAttachmentInput(input('ok.json', '{"ok":true}')).mimeType).toBe(
      'application/json',
    );
  });

  it('enforces per-type size limits', () => {
    expect(
      decodeAttachmentInput(input('max.txt', Buffer.alloc(ATTACHMENT_LIMITS.textBytes, 0x61))).size,
    ).toBe(ATTACHMENT_LIMITS.textBytes);
    expectInvalid(() =>
      decodeAttachmentInput(input('over.txt', Buffer.alloc(ATTACHMENT_LIMITS.textBytes + 1, 0x61))),
    );

    const maxImage = Buffer.concat([
      png().subarray(0, 8),
      Buffer.alloc(ATTACHMENT_LIMITS.imageBytes - 8, 0x20),
    ]);
    expect(decodeAttachmentInput(input('max.png', maxImage)).size).toBe(
      ATTACHMENT_LIMITS.imageBytes,
    );
    expectInvalid(() =>
      decodeAttachmentInput(
        input('over.png', Buffer.alloc(ATTACHMENT_LIMITS.imageBytes + 1, 0x20)),
      ),
    );

    expect(decodeAttachmentInput(input('max.pdf', pdf(ATTACHMENT_LIMITS.pdfBytes))).size).toBe(
      ATTACHMENT_LIMITS.pdfBytes,
    );
    expectInvalid(() =>
      decodeAttachmentInput(input('over.pdf', pdf(ATTACHMENT_LIMITS.pdfBytes + 1))),
    );
  });

  it('cleans the display filename while keeping Unicode', () => {
    expect(decodeAttachmentInput(input('  ../报告\u0000/说明.md  ', '# x')).filename).toBe(
      '..报告说明.md',
    );
    expect(decodeAttachmentInput(input('资料/说明.txt', 'x')).filename).toBe('资料说明.txt');
    expect(decodeAttachmentInput(input('📄 说明.md', 'x')).filename).toBe('📄 说明.md');
    const long = decodeAttachmentInput(input(`${'a'.repeat(130)}.txt`, 'x')).filename;
    expect(Array.from(long)).toHaveLength(ATTACHMENT_LIMITS.filenameChars);
  });

  it('rejects names that clean down to nothing', () => {
    expectInvalid(() => decodeAttachmentInput(input('///\\\\', 'x')));
    expectInvalid(() => decodeAttachmentInput(input('\u0000\u0001', 'x')));
  });
});

describe('displayAttachmentFilename', () => {
  it('cleans and truncates display names for titles without requiring a usable name', () => {
    expect(displayAttachmentFilename('  ../报告\u0000/说明.md  ')).toBe('..报告说明.md');
    expect(displayAttachmentFilename('📄 说明.md')).toBe('📄 说明.md');
    expect(Array.from(displayAttachmentFilename(`${'a'.repeat(130)}.txt`))).toHaveLength(
      ATTACHMENT_LIMITS.filenameChars,
    );
    expect(displayAttachmentFilename('\u0000\u0001')).toBe('');
  });
});

describe('writeConversationAttachments / readConversationAttachment', () => {
  it('creates a missing workspace root on first write and never on read', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'attachments-root-'));
    const missingRoot = join(parent, 'nested', 'workspaces');
    try {
      const text = '# 首次写入';
      const [meta] = await writeConversationAttachments({
        root: missingRoot,
        slug,
        conversationId,
        inputs: [input('first.md', text)],
      });
      if (meta === undefined) throw new Error('missing metadata');
      expect((await stat(missingRoot)).isDirectory()).toBe(true);

      const read = await readConversationAttachment({
        root: missingRoot,
        slug,
        conversationId,
        attachment: meta,
      });
      expect(read.data.toString('utf8')).toBe(text);
      expect(createHash('sha256').update(read.data).digest('hex')).toBe(meta.sha256);

      await rm(missingRoot, { recursive: true, force: true });
      await expect(
        readConversationAttachment({ root: missingRoot, slug, conversationId, attachment: meta }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(access(missingRoot)).rejects.toThrow();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('writes server-named files and reads the same bytes back', async () => {
    const text = '# 报告\n内容';
    const image = png('image-bytes');
    const metadata = await writeConversationAttachments({
      root,
      slug,
      conversationId,
      inputs: [input('报告.md', text), input('photo.png', image)],
    });

    expect(metadata).toHaveLength(2);
    const md = metadata[0] as MessageAttachment;
    const pngMeta = metadata[1] as MessageAttachment;
    expect(md).toMatchObject({
      filename: '报告.md',
      mimeType: 'text/markdown',
      size: Buffer.byteLength(text),
    });
    expect(md).not.toHaveProperty('data');
    expect(pngMeta.mimeType).toBe('image/png');

    const dir = conversationInputsDir({ root, slug, conversationId });
    expect((await readdir(dir)).sort()).toEqual([`${md.id}.md`, `${pngMeta.id}.png`].sort());
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, `${md.id}.md`))).mode & 0o777).toBe(0o600);

    const read = await readConversationAttachment({ root, slug, conversationId, attachment: md });
    expect(read.filename).toBe('报告.md');
    expect(read.mimeType).toBe('text/markdown');
    expect(read.data.toString('utf8')).toBe(text);
    expect(createHash('sha256').update(read.data).digest('hex')).toBe(md.sha256);
  });

  it('returns nothing for an empty selection', async () => {
    expect(await writeConversationAttachments({ root, slug, conversationId, inputs: [] })).toEqual(
      [],
    );
  });

  it('rejects more than five attachments', async () => {
    await expect(
      writeConversationAttachments({
        root,
        slug,
        conversationId,
        inputs: Array.from({ length: 6 }, (_, index) => input(`note-${index}.txt`, 'x')),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects the combined 10 MiB limit', async () => {
    await expect(
      writeConversationAttachments({
        root,
        slug,
        conversationId,
        inputs: [input('a.pdf', pdf(6 * MiB)), input('b.pdf', pdf(6 * MiB))],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(access(conversationInputsDir({ root, slug, conversationId }))).rejects.toThrow();
  });

  it('refuses a symlinked conversation-inputs directory', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'attachments-outside-'));
    try {
      await mkdir(join(root, slug), { recursive: true });
      await symlink(outside, join(root, slug, 'conversation-inputs'));
      await expect(
        writeConversationAttachments({
          root,
          slug,
          conversationId,
          inputs: [input('note.txt', 'x')],
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses symlinks, hardlinks and non-regular files when reading', async () => {
    const [meta] = await writeConversationAttachments({
      root,
      slug,
      conversationId,
      inputs: [input('note.txt', 'x')],
    });
    if (meta === undefined) throw new Error('missing metadata');
    const dir = conversationInputsDir({ root, slug, conversationId });
    const file = join(dir, `${meta.id}.txt`);
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'elsewhere');

    await rm(file);
    await symlink(outside, file);
    await expect(
      readConversationAttachment({ root, slug, conversationId, attachment: meta }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    await rm(file);
    await link(outside, file);
    await expect(
      readConversationAttachment({ root, slug, conversationId, attachment: meta }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    await rm(file);
    await mkdir(file);
    await expect(
      readConversationAttachment({ root, slug, conversationId, attachment: meta }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    await rm(file, { recursive: true });
    await expect(
      readConversationAttachment({ root, slug, conversationId, attachment: meta }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects forged metadata ids', async () => {
    await expect(
      readConversationAttachment({
        root,
        slug,
        conversationId,
        attachment: {
          id: '../outside',
          filename: 'x.txt',
          mimeType: 'text/plain',
          size: 1,
          sha256: 'a'.repeat(64),
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('copyConversationInputs', () => {
  it('copies the requested ids as independent bytes', async () => {
    const metadata = await writeConversationAttachments({
      root,
      slug,
      conversationId,
      inputs: [input('a.txt', 'alpha'), input('b.png', png('beta'))],
    });
    const [first, second] = metadata as [MessageAttachment, MessageAttachment];
    await copyConversationInputs({
      root,
      slug,
      sourceConversationId: conversationId,
      targetConversationId: 'conv_2',
      attachmentIds: [first.id, second.id],
    });

    const targetDir = conversationInputsDir({ root, slug, conversationId: 'conv_2' });
    expect((await stat(targetDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(targetDir, `${first.id}.txt`))).mode & 0o777).toBe(0o600);
    const read = await readConversationAttachment({
      root,
      slug,
      conversationId: 'conv_2',
      attachment: first,
    });
    expect(read.data.toString()).toBe('alpha');

    const sourceInfo = await lstat(
      join(conversationInputsDir({ root, slug, conversationId }), `${first.id}.txt`),
    );
    const targetInfo = await lstat(join(targetDir, `${first.id}.txt`));
    expect(targetInfo.ino).not.toBe(sourceInfo.ino);
  });

  it('fails before creating the target when an id is missing', async () => {
    await writeConversationAttachments({
      root,
      slug,
      conversationId,
      inputs: [input('a.txt', 'alpha')],
    });
    await expect(
      copyConversationInputs({
        root,
        slug,
        sourceConversationId: conversationId,
        targetConversationId: 'conv_2',
        attachmentIds: ['00000000-0000-4000-8000-000000000000'],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      access(conversationInputsDir({ root, slug, conversationId: 'conv_2' })),
    ).rejects.toThrow();
  });
});

describe('removeConversationInputs', () => {
  it('removes only the selected conversation and is idempotent', async () => {
    for (const id of [conversationId, 'conv_2']) {
      await writeConversationAttachments({
        root,
        slug,
        conversationId: id,
        inputs: [input('a.txt', 'alpha')],
      });
    }
    await removeConversationInputs({ root, slug, conversationId });
    await expect(access(conversationInputsDir({ root, slug, conversationId }))).rejects.toThrow();
    expect(
      await readdir(conversationInputsDir({ root, slug, conversationId: 'conv_2' })),
    ).toHaveLength(1);

    await removeConversationInputs({ root, slug, conversationId });
    expect(
      await readdir(conversationInputsDir({ root, slug, conversationId: 'conv_2' })),
    ).toHaveLength(1);
  });

  it('does not follow a symlinked inputs directory', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'attachments-outside-'));
    try {
      await writeFile(join(outside, 'keep.txt'), 'keep');
      await mkdir(join(root, slug), { recursive: true });
      await symlink(outside, join(root, slug, 'conversation-inputs'));
      await removeConversationInputs({ root, slug, conversationId });
      expect(await readdir(outside)).toEqual(['keep.txt']);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
