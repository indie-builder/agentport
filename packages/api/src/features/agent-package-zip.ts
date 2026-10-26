import { inflateRawSync } from 'node:zlib';
import { fail } from '@agentport/core';
import { AGENT_PACKAGE_MAX_ENTRIES, AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES } from '@agentport/shared';
import { zipSync } from 'fflate';

/**
 * 专家包 ZIP 的读写。中央目录先于解压逐条检查：条目数、解压后总字节、路径形状、
 * 重复项与符号链接，全部通过后才按中央目录的本地头偏移解压，避免先解压再判断的 zip bomb。
 */

const SIGNATURE_EOCD = 0x06054b50;
const SIGNATURE_CENTRAL = 0x02014b50;
const SIGNATURE_LOCAL = 0x04034b50;
const SIGNATURE_ZIP64_LOCATOR = 0x07064b50;
const UTF8_NAME_FLAG = 0x800;
const MAX_PATH_LENGTH = 512;
const UNIX_SYMLINK = 0o120000;

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

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
  compression: number;
  localOffset: number;
}

interface CentralDirectory {
  entries: CentralEntry[];
  /** 数据区上限：本地文件头与压缩数据都必须落在中央目录之前。 */
  centralOffset: number;
}

/**
 * 候选 EOCD 必须与中央目录严丝合缝：条目从 offset 连续排到 offset+size，终点正好是本记录。
 * 注释里的伪记录（空记录或伪造条目数/偏移）因此被跳过，结构错误仍由后面的正式校验报出。
 */
function isEocdCandidate(data: Buffer, offset: number): boolean {
  const entriesOnDisk = u16(data, offset + 8);
  const entries = u16(data, offset + 10);
  const start = u32(data, offset + 16);
  const directoryEnd = start + u32(data, offset + 12);
  if (entries === 0 || entries !== entriesOnDisk || directoryEnd !== offset) return false;
  let cursor = start;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > directoryEnd || u32(data, cursor) !== SIGNATURE_CENTRAL) return false;
    cursor += 46 + u16(data, cursor + 28) + u16(data, cursor + 30) + u16(data, cursor + 32);
  }
  return cursor === directoryEnd;
}

/** 读取中央目录；只返回文件条目，不做任何解压。 */
function readCentralDirectory(data: Buffer): CentralDirectory {
  if (data.length < 22) invalid('不是有效的 ZIP 包');

  let eocd = -1;
  let fallback = -1;
  const floor = Math.max(0, data.length - 65_557);
  for (let offset = data.length - 22; offset >= floor; offset -= 1) {
    // 注释里可能出现伪 EOCD 签名；注释长度覆盖到包尾只是入场券，还要能对上中央目录。
    if (
      u32(data, offset) !== SIGNATURE_EOCD ||
      u16(data, offset + 20) !== data.length - offset - 22
    ) {
      continue;
    }
    fallback = offset;
    if (isEocdCandidate(data, offset)) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1) {
    // 没有候选能对上目录时，用最靠前的匹配位置走正式校验，保留真实的损坏原因。
    if (fallback === -1) invalid('不是有效的 ZIP 包（缺少中央目录）');
    eocd = fallback;
  }

  const disk = u16(data, eocd + 4);
  const directoryDisk = u16(data, eocd + 6);
  // 本盘条目数与总条目数必须一致，否则按任一字段迭代都会漏检或多检。
  const entriesOnDisk = u16(data, eocd + 8);
  const entries = u16(data, eocd + 10);
  const size = u32(data, eocd + 12);
  const offset = u32(data, eocd + 16);
  // ZIP64 的条目数/偏移会写成 0xffff/0xffffffff；本次不引入额外解析，明确拒绝。
  if (
    entries === 0xffff ||
    entriesOnDisk === 0xffff ||
    size === 0xffffffff ||
    offset === 0xffffffff ||
    (eocd >= 20 && u32(data, eocd - 20) === SIGNATURE_ZIP64_LOCATOR)
  ) {
    invalid('不支持 ZIP64 格式，请用普通 ZIP 重新打包');
  }
  if (disk !== 0 || directoryDisk !== 0) {
    invalid('不支持分卷 ZIP，请用普通 ZIP 重新打包');
  }
  if (entriesOnDisk !== entries) {
    invalid('ZIP 条目数不一致，包可能被截断或损坏');
  }
  if (entries === 0) invalid('ZIP 包是空的');
  if (entries > AGENT_PACKAGE_MAX_ENTRIES) {
    invalid(`ZIP 包内文件数超过 ${AGENT_PACKAGE_MAX_ENTRIES} 个`);
  }
  const directoryEnd = offset + size;
  if (directoryEnd > eocd) invalid('ZIP 中央目录越界，包可能被截断');

  const result: CentralEntry[] = [];
  let cursor = offset;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > directoryEnd || u32(data, cursor) !== SIGNATURE_CENTRAL) {
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
    const localOffset = u32(data, cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > directoryEnd) invalid('ZIP 中央目录条目越界');
    const nameBytes = data.subarray(cursor + 46, cursor + 46 + nameLength);
    cursor = next;

    let name: string;
    if ((flags & UTF8_NAME_FLAG) !== 0) {
      try {
        name = strictUtf8.decode(nameBytes);
      } catch {
        invalid('ZIP 条目名不是有效的 UTF-8');
      }
    } else {
      // bit 11 未设置时 fflate 按 Latin-1 解码；这里必须用同一套规则，否则路径对不上。
      name = nameBytes.toString('latin1');
    }
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
    result.push({ name, originalSize, compressedSize, compression, localOffset });
  }
  if (cursor !== directoryEnd) invalid('ZIP 中央目录大小与条目不一致');

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
  return { entries: result, centralOffset: offset };
}

/** 按中央目录给出的本地头偏移取压缩数据。 */
function readEntryData(data: Buffer, entry: CentralEntry, centralOffset: number): Uint8Array {
  const { localOffset } = entry;
  if (localOffset + 30 > centralOffset || u32(data, localOffset) !== SIGNATURE_LOCAL) {
    invalid(`ZIP 条目「${entry.name}」的本地文件头损坏`, entry.name);
  }
  const start = localOffset + 30 + u16(data, localOffset + 26) + u16(data, localOffset + 28);
  const end = start + entry.compressedSize;
  if (end > centralOffset) {
    invalid(`ZIP 条目「${entry.name}」的压缩数据越界`, entry.name);
  }
  const compressed = data.subarray(start, end);
  if (entry.compression === 0) return compressed;
  try {
    // 声明值同时作为输出上限：低报会抛 ERR_BUFFER_TOO_LARGE，而不是静默截断。
    return inflateRawSync(compressed, { maxOutputLength: Math.max(entry.originalSize, 1) });
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      invalid(`ZIP 条目「${entry.name}」实际大小与中央目录不符`, entry.name);
    }
    invalid('ZIP 内容损坏，无法解压');
  }
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
  const { entries, centralOffset } = readCentralDirectory(data);
  const files = new Map<string, string>();
  let total = 0;
  for (const entry of entries) {
    const bytes = readEntryData(data, entry, centralOffset);
    if (bytes.length !== entry.originalSize) {
      invalid(`ZIP 条目「${entry.name}」实际大小与中央目录不符`, entry.name);
    }
    total += bytes.length;
    if (total > AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES) {
      invalid(`ZIP 解压后总大小超过 ${AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES} 字节`);
    }
    try {
      files.set(entry.name, strictUtf8.decode(bytes));
    } catch {
      invalid(`「${entry.name}」不是 UTF-8 文本；包内只支持文本资源`, entry.name);
    }
  }
  return files;
}
