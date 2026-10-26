import { AppError } from '@agentport/core';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { decodePackage } from '../src/features/agent-package-zip.js';

/**
 * ZIP 结构专项：EOCD 的本盘/总条目数必须一致，注释里的伪签名不能影响 EOCD 定位，
 * 解压后的大小必须与中央目录完全一致。
 */

const SIGNATURE_EOCD = 0x06054b50;

/** fflate 打包不带注释，EOCD 固定在最后 22 字节。 */
const eocdOffset = (archive: Buffer): number => {
  const offset = archive.length - 22;
  if (archive.readUInt32LE(offset) !== SIGNATURE_EOCD) {
    throw new Error('fixture is not a ZIP without comment');
  }
  return offset;
};

const centralOffset = (archive: Buffer): number => archive.readUInt32LE(eocdOffset(archive) + 16);

/** 默认 level 0 让压缩后大小等于内容长度，便于手改中央目录字段。 */
const makeZip = (files: Record<string, string>, level: 0 | 6 = 0): Buffer => {
  const encoder = new TextEncoder();
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) entries[name] = encoder.encode(content);
  return Buffer.from(zipSync(entries, { level }));
};

/** 中央目录里的原大小字段。 */
const centralOriginalSize = (archive: Buffer): number => centralOffset(archive) + 24;
/** 中央目录里的本地文件头偏移。 */
const localOffset = (archive: Buffer): number => archive.readUInt32LE(centralOffset(archive) + 42);

const rejectionOf = (archive: Buffer): AppError => {
  try {
    decodePackage(archive);
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('decodePackage accepted a malformed ZIP');
};

describe('agent package ZIP structure', () => {
  it('rejects an archive whose per-disk entry count is higher than the total', () => {
    const archive = makeZip({ 'CLAUDE.md': 'root', 'extra.txt': 'not checked' });
    const eocd = eocdOffset(archive);
    archive.writeUInt16LE(2, eocd + 8);
    archive.writeUInt16LE(1, eocd + 10);

    const error = rejectionOf(archive);
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('条目数');
  });

  it('rejects an archive whose per-disk entry count is lower than the total', () => {
    const archive = makeZip({ 'CLAUDE.md': 'root', 'extra.txt': 'never extracted' });
    const eocd = eocdOffset(archive);
    archive.writeUInt16LE(1, eocd + 8);
    archive.writeUInt16LE(2, eocd + 10);

    const error = rejectionOf(archive);
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('条目数');
  });

  it('rejects a central directory size that does not cover its entries', () => {
    const archive = makeZip({ 'CLAUDE.md': 'root', 'extra.txt': 'outside' });
    const eocd = eocdOffset(archive);
    const declared = archive.readUInt32LE(eocd + 12);
    archive.writeUInt32LE(declared - 10, eocd + 12);

    const error = rejectionOf(archive);
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('中央目录');
  });

  it('rejects a central directory that runs past the EOCD', () => {
    const archive = makeZip({ 'CLAUDE.md': 'root' });
    const eocd = eocdOffset(archive);
    archive.writeUInt32LE(archive.length - centralOffset(archive), eocd + 12);

    const error = rejectionOf(archive);
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('中央目录');
  });

  it('rejects multi-disk archives', () => {
    for (const [label, field] of [
      ['disk number', 4],
      ['central directory disk', 6],
    ] as const) {
      const archive = makeZip({ 'CLAUDE.md': 'root' });
      archive.writeUInt16LE(1, eocdOffset(archive) + field);

      const error = rejectionOf(archive);
      expect(error.code, label).toBe('INVALID_INPUT');
      expect(error.message, label).toContain('分卷');
    }
  });

  it('rejects a ZIP64 locator even when the EOCD fields look normal', () => {
    const base = makeZip({ 'CLAUDE.md': 'root' });
    const eocd = eocdOffset(base);
    const archive = Buffer.concat([base.subarray(0, eocd), Buffer.alloc(20), base.subarray(eocd)]);
    // ZIP64 EOCD locator 紧邻 EOCD；fflate 见到它就会改读 ZIP64 的条目数/偏移。
    archive.writeUInt32LE(0x07064b50, eocd);

    const error = rejectionOf(archive);
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('ZIP64');
  });

  it('rejects an entry whose decompressed size differs from the central directory', () => {
    const archive = makeZip({ 'CLAUDE.md': 'hello' });
    // 中央目录写 3 字节，实际 store 数据是 5 字节；fflate 按压缩后大小读取。
    archive.writeUInt32LE(3, centralOffset(archive) + 24);

    const error = rejectionOf(archive);
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('大小');
  });

  it('rejects a deflate entry whose decompressed size is understated', () => {
    // fflate 用中央目录的原大小分配输出缓冲；低报时它会静默截断，事后比对长度无法发现。
    const cases = [
      { label: '5 MiB', content: 'x'.repeat(5 * 1024 * 1024), declared: 1 },
      { label: '1000 bytes', content: 'hello'.repeat(200), declared: 3 },
    ];
    for (const { label, content, declared } of cases) {
      const archive = makeZip({ 'CLAUDE.md': content }, 6);
      archive.writeUInt32LE(declared, centralOriginalSize(archive));

      const error = rejectionOf(archive);
      expect(error.code, label).toBe('INVALID_INPUT');
      expect(error.message, label).toContain('大小');
    }
  });

  it('decodes a bit-11-clear entry name as Latin-1 instead of losing its data', () => {
    const archive = makeZip({ x: 'hello' });
    const central = centralOffset(archive);
    const local = localOffset(archive);
    archive.writeUInt16LE(archive.readUInt16LE(central + 8) & ~0x800, central + 8);
    archive.writeUInt16LE(archive.readUInt16LE(local + 6) & ~0x800, local + 6);
    // 0xe9 在 Latin-1 中是「é」；按 UTF-8 解码会变成替换字符，与解压器看到的键不一致。
    archive[central + 46] = 0xe9;
    archive[local + 30] = 0xe9;

    expect([...decodePackage(archive)]).toEqual([['é', 'hello']]);
  });

  it('decodes a bit-11 UTF-8 name and rejects invalid UTF-8 bytes', () => {
    const archive = makeZip({ '中文.md': '内容' });
    const central = centralOffset(archive);
    const local = localOffset(archive);
    archive.writeUInt16LE(archive.readUInt16LE(central + 8) | 0x800, central + 8);
    archive.writeUInt16LE(archive.readUInt16LE(local + 6) | 0x800, local + 6);
    expect(decodePackage(archive).get('中文.md')).toBe('内容');

    const invalid = Buffer.from(archive);
    invalid[central + 46] = 0xff;
    const error = rejectionOf(invalid);
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('UTF-8');
  });

  it('finds the real EOCD when a valid comment starts with a false signature', () => {
    const base = makeZip({ 'CLAUDE.md': 'hello' });
    const eocd = eocdOffset(base);
    const comment = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(20)]);
    base.writeUInt16LE(comment.length, eocd + 20);

    const files = decodePackage(Buffer.concat([base, comment]));
    expect(files.get('CLAUDE.md')).toBe('hello');
  });

  it('finds the real EOCD when the comment is exactly a false signature', () => {
    const base = makeZip({ 'CLAUDE.md': 'hello' });
    const eocd = eocdOffset(base);
    // 22 字节注释正好放下一整个伪 EOCD，其注释长度字段为 0，倒搜第一站就是它。
    const comment = Buffer.alloc(22);
    comment.writeUInt32LE(SIGNATURE_EOCD, 0);
    base.writeUInt16LE(comment.length, eocd + 20);

    const files = decodePackage(Buffer.concat([base, comment]));
    expect(files.get('CLAUDE.md')).toBe('hello');
  });

  it('finds the real EOCD when a false candidate declares entries with a bogus directory', () => {
    const base = makeZip({ 'CLAUDE.md': 'hello' });
    const eocd = eocdOffset(base);
    // 伪 EOCD 在注释末尾：声明 1 个条目，但目录偏移指向本地文件头。
    const comment = Buffer.alloc(30);
    const fake = comment.length - 22;
    comment.writeUInt32LE(SIGNATURE_EOCD, fake);
    comment.writeUInt16LE(1, fake + 8);
    comment.writeUInt16LE(1, fake + 10);
    comment.writeUInt32LE(46, fake + 12);
    comment.writeUInt32LE(0, fake + 16);
    base.writeUInt16LE(comment.length, eocd + 20);

    const files = decodePackage(Buffer.concat([base, comment]));
    expect(files.get('CLAUDE.md')).toBe('hello');
  });
});
