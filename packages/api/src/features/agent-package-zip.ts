import { fail } from '@agentport/core';
import { AGENT_PACKAGE_MAX_ENTRIES, AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES } from '@agentport/shared';
import { unzipSync, zipSync } from 'fflate';

/**
 * 专家包 ZIP 的读写。中央目录先于解压逐条检查：条目数、解压后总字节、路径形状、
 * 重复项与符号链接，全部通过后才调用 unzipSync，避免先解压再判断的 zip bomb。
 */

const SIGNATURE_EOCD = 0x06054b50;
const SIGNATURE_CENTRAL = 0x02014b50;
const MAX_PATH_LENGTH = 512;
const UNIX_SYMLINK = 0o120000;

function byteAt(data: Buffer, offset: number): number {
  return data.readUInt8(offset);
}

function u16(data: Buffer, offset: number): number {
  return byteAt(data, offset) | (byteAt(data, offset + 1) << 8);
}

function u32(data: Buffer, offset: number): number {
  return (
    (byteAt(data, offset) |
      (byteAt(data, offset + 1) << 8) |
      (byteAt(data, offset + 2) << 16) |
      (byteAt(data, offset + 3) << 24)) >>>
    0
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => (character.codePointAt(0) ?? 0) < 0x20);
}

function invalid(message: string, path?: string): never {
  fail('INVALID_INPUT', message, path === undefined ? undefined : { path });
}

/** 包内路径必须是规范的相对 POSIX 路径；反斜杠、绝对路径与 .. 一律拒绝。 */
function assertPackagePath(path: string): void {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) {
    invalid(`包内路径长度必须在 1-${MAX_PATH_LENGTH} 之间`, path);
  }
  if (path.includes('\\')) invalid('包内路径不能包含反斜杠', path);
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) invalid('包内路径必须是相对路径', path);
  if (hasControlCharacter(path)) invalid('包内路径不能包含控制字符', path);
  const segments = path.replace(/\/$/, '').split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    invalid('包内路径不能包含空段、. 或 ..', path);
  }
}

interface CentralEntry {
  name: string;
  originalSize: number;
  compressedSize: number;
}

/** 读取中央目录；只返回文件条目，不做任何解压。 */
function readCentralDirectory(data: Buffer): CentralEntry[] {
  if (data.length < 22) invalid('不是有效的 ZIP 包');

  let eocd = -1;
  const floor = Math.max(0, data.length - 65_557);
  for (let offset = data.length - 22; offset >= floor; offset -= 1) {
    if (u32(data, offset) === SIGNATURE_EOCD) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1) invalid('不是有效的 ZIP 包（缺少中央目录）');

  const entries = u16(data, eocd + 10);
  const size = u32(data, eocd + 12);
  const offset = u32(data, eocd + 16);
  // ZIP64 的条目数/偏移会写成 0xffff/0xffffffff；本次不引入额外解析，明确拒绝。
  if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    invalid('不支持 ZIP64 格式，请用普通 ZIP 重新打包');
  }
  if (entries === 0) invalid('ZIP 包是空的');
  if (entries > AGENT_PACKAGE_MAX_ENTRIES) {
    invalid(`ZIP 包内文件数超过 ${AGENT_PACKAGE_MAX_ENTRIES} 个`);
  }
  if (offset + size > data.length) invalid('ZIP 中央目录越界，包可能被截断');

  const result: CentralEntry[] = [];
  let cursor = offset;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > data.length || u32(data, cursor) !== SIGNATURE_CENTRAL) {
      invalid('ZIP 中央目录损坏，无法读取条目');
    }
    const madeBy = u16(data, cursor + 4);
    const flags = u16(data, cursor + 8);
    const compression = u16(data, cursor + 10);
    const compressedSize = u32(data, cursor + 20);
    const originalSize = u32(data, cursor + 24);
    const nameLength = u16(data, cursor + 28);
    const extraLength = u16(data, cursor + 30);
    const commentLength = u16(data, cursor + 32);
    const externalAttributes = u32(data, cursor + 38);
    if (cursor + 46 + nameLength > data.length) invalid('ZIP 中央目录条目越界');
    const name = data.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;

    if ((flags & 0x1) !== 0) invalid('不支持加密的 ZIP 条目', name);
    if (compression !== 0 && compression !== 8) {
      invalid('只支持 store / deflate 压缩的 ZIP 条目', name);
    }
    assertPackagePath(name);
    // version made by 高字节 3 = Unix；symlink 的文件类型位是 0o120000。
    if (madeBy >> 8 === 3 && ((externalAttributes >>> 16) & 0o170000) === UNIX_SYMLINK) {
      invalid('ZIP 包不能包含符号链接', name);
    }
    if (name.endsWith('/')) continue;
    result.push({ name, originalSize, compressedSize });
  }

  const names = new Set<string>();
  let total = 0;
  for (const entry of result) {
    if (names.has(entry.name)) invalid(`ZIP 包内文件「${entry.name}」重复`, entry.name);
    names.add(entry.name);
    // 声明为 0 但实际有压缩数据时按压缩后大小估算，避免用 0 绕过上限。
    total += Math.max(entry.originalSize, entry.compressedSize);
    if (total > AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES) {
      invalid(`ZIP 解压后总大小超过 ${AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES} 字节`);
    }
  }
  return result;
}

/** 打包：所有条目都是文本资源；路径在写包前同样校验。 */
export function encodePackage(files: Record<string, string>): Buffer {
  const entries: Record<string, Uint8Array> = {};
  const encoder = new TextEncoder();
  for (const [path, content] of Object.entries(files)) {
    assertPackagePath(path);
    entries[path] = encoder.encode(content);
  }
  return Buffer.from(zipSync(entries, { level: 6 }));
}

/** 先按中央目录校验，再解压；内容必须能按严格 UTF-8 解码。 */
export function decodePackage(data: Buffer): Map<string, string> {
  const entries = readCentralDirectory(data);
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(new Uint8Array(data));
  } catch {
    invalid('ZIP 内容损坏，无法解压');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const files = new Map<string, string>();
  for (const entry of entries) {
    const bytes = raw[entry.name];
    if (!bytes) invalid(`ZIP 条目「${entry.name}」缺少数据，包可能被截断`, entry.name);
    try {
      files.set(entry.name, decoder.decode(bytes));
    } catch {
      invalid(`「${entry.name}」不是 UTF-8 文本；包内只支持文本资源`, entry.name);
    }
  }
  return files;
}
