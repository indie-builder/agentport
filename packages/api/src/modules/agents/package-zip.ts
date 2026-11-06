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
/** version made by 的高字节：3 = Unix，只有这类条目带可信的文件 mode。 */
const UNIX_HOST = 3;
const UNIX_SYMLINK = 0o120000;
const UNIX_REGULAR_FILE = 0o100644;
const UNIX_EXECUTABLE_FILE = 0o100755;

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
  executable: boolean;
}

interface CentralDirectory {
  entries: CentralEntry[];
  /** 数据区上限：本地文件头与压缩数据都必须落在中央目录之前。 */
  centralOffset: number;
}

interface LocalEntryLayout {
  dataStart: number;
  dataEnd: number;
}

/**
 * 中央目录决定限额，解压器却可能按本地头取名字和压缩数据；两侧必须指向同一条目。
 * 只比较影响归属与数据的字段，extra/comment 允许不同。
 */
function assertLocalEntry(
  data: Buffer,
  entry: {
    name: string;
    nameBytes: Buffer;
    flags: number;
    compression: number;
    compressedSize: number;
    originalSize: number;
    localOffset: number;
  },
  centralOffset: number,
): LocalEntryLayout {
  const { name, localOffset } = entry;
  if (localOffset + 30 > centralOffset || u32(data, localOffset) !== SIGNATURE_LOCAL) {
    invalid(`ZIP 条目「${name}」的本地文件头损坏`, name);
  }
  const nameStart = localOffset + 30;
  const nameEnd = nameStart + u16(data, localOffset + 26);
  const dataStart = nameEnd + u16(data, localOffset + 28);
  if (nameEnd > centralOffset || dataStart > centralOffset) {
    invalid(`ZIP 条目「${name}」的本地文件头损坏`, name);
  }
  if (!entry.nameBytes.equals(data.subarray(nameStart, nameEnd))) {
    invalid(`ZIP 条目「${name}」的本地文件名与中央目录不一致`, name);
  }
  if (u16(data, localOffset + 6) !== entry.flags) {
    invalid(`ZIP 条目「${name}」的本地文件头标志与中央目录不一致`, name);
  }
  if (u16(data, localOffset + 8) !== entry.compression) {
    invalid(`ZIP 条目「${name}」的本地文件头压缩方式与中央目录不一致`, name);
  }
  // bit 3 表示大小写在数据描述符里，本地头的 0 是合法值；其余必须与中央目录一致。
  const usesDescriptor = (entry.flags & 0x8) !== 0;
  const localCompressedSize = u32(data, localOffset + 18);
  const localOriginalSize = u32(data, localOffset + 22);
  if (
    (localCompressedSize !== entry.compressedSize &&
      !(usesDescriptor && localCompressedSize === 0)) ||
    (localOriginalSize !== entry.originalSize && !(usesDescriptor && localOriginalSize === 0))
  ) {
    invalid(`ZIP 条目「${name}」的本地文件头大小与中央目录不一致`, name);
  }
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > centralOffset) {
    invalid(`ZIP 条目「${name}」的压缩数据越界`, name);
  }
  return { dataStart, dataEnd };
}

/** 目录条目不能藏文件数据：原大小必须为 0，deflate 的压缩流也必须解出空内容。 */
function assertEmptyDirectory(
  data: Buffer,
  entry: { name: string; originalSize: number; compressedSize: number; compression: number },
  layout: LocalEntryLayout,
): void {
  if (entry.originalSize !== 0) {
    invalid(`ZIP 目录「${entry.name}」不能包含文件数据`, entry.name);
  }
  if (entry.compression === 0) {
    if (entry.compressedSize !== 0) {
      invalid(`ZIP 目录「${entry.name}」不能包含文件数据`, entry.name);
    }
    return;
  }
  let empty = false;
  try {
    // 上限 1 字节：真实空目录（fflate 会写 2 字节的 deflate 空流）解出 0 字节，带内容则失败。
    empty =
      inflateRawSync(data.subarray(layout.dataStart, layout.dataEnd), {
        maxOutputLength: 1,
      }).length === 0;
  } catch {
    // 解压失败或输出超过 0 字节，都说明目录里带了文件数据。
  }
  if (!empty) invalid(`ZIP 目录「${entry.name}」不能包含文件数据`, entry.name);
}

/** 中央目录校验上限；调用方按自己的包类型传入同一组约束。 */
export interface ZipReadLimits {
  maxEntries: number;
  maxUncompressedBytes: number;
  /** 单条 max(original, compressed) 上限；缺省不额外限制。 */
  maxEntryBytes?: number;
}

const AGENT_PACKAGE_LIMITS: ZipReadLimits = {
  maxEntries: AGENT_PACKAGE_MAX_ENTRIES,
  maxUncompressedBytes: AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES,
};

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
function readCentralDirectory(
  data: Buffer,
  limits: ZipReadLimits = AGENT_PACKAGE_LIMITS,
): CentralDirectory {
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
  if (entries > limits.maxEntries) {
    invalid(`ZIP 包内文件数超过 ${limits.maxEntries} 个`);
  }
  const directoryEnd = offset + size;
  if (directoryEnd > eocd) invalid('ZIP 中央目录越界，包可能被截断');

  const result: CentralEntry[] = [];
  const parsed: Array<{
    name: string;
    nameBytes: Buffer;
    flags: number;
    compression: number;
    compressedSize: number;
    originalSize: number;
    localOffset: number;
    directory: boolean;
  }> = [];
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
    // 非 Unix 条目没有可信 mode，按不可执行处理；symlink 的文件类型位是 0o120000。
    const unixMode = madeBy >> 8 === UNIX_HOST ? externalAttributes >>> 16 : 0;
    if ((unixMode & 0o170000) === UNIX_SYMLINK) {
      invalid('ZIP 包不能包含符号链接', name);
    }
    const directory = name.endsWith('/');
    parsed.push({
      name,
      nameBytes,
      flags,
      compression,
      compressedSize,
      originalSize,
      localOffset,
      directory,
    });
    if (directory) continue;
    result.push({
      name,
      originalSize,
      compressedSize,
      compression,
      localOffset,
      executable: (unixMode & 0o111) !== 0,
    });
  }
  if (cursor !== directoryEnd) invalid('ZIP 中央目录大小与条目不一致');

  const names = new Set<string>();
  let total = 0;
  for (const entry of result) {
    if (names.has(entry.name)) invalid(`ZIP 包内文件「${entry.name}」重复`, entry.name);
    names.add(entry.name);
    // 声明为 0 但实际有压缩数据时按压缩后大小估算，避免用 0 绕过上限。
    const declared = Math.max(entry.originalSize, entry.compressedSize);
    if (limits.maxEntryBytes !== undefined && declared > limits.maxEntryBytes) {
      invalid(`ZIP 条目「${entry.name}」超过 ${limits.maxEntryBytes} 字节`, entry.name);
    }
    total += declared;
    if (total > limits.maxUncompressedBytes) {
      invalid(`ZIP 解压后总大小超过 ${limits.maxUncompressedBytes} 字节`);
    }
  }

  // 中央目录限额通过后才校验本地头：声明超限时保留容量错误，避免被本地字段抢先。
  const ranges: Array<{ start: number; end: number; name: string }> = [];
  for (const entry of parsed) {
    const layout = assertLocalEntry(data, entry, offset);
    ranges.push({ start: entry.localOffset, end: layout.dataEnd, name: entry.name });
    if (entry.directory) assertEmptyDirectory(data, entry, layout);
  }
  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (previous !== undefined && current !== undefined && current.start < previous.end) {
      invalid(`ZIP 条目「${current.name}」与「${previous.name}」的数据区域重叠`, current.name);
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

/** 解出的单个文本条目；executable 来自 ZIP 的 Unix external attributes。 */
export interface PackageEntry {
  content: string;
  executable: boolean;
}

export interface PackageFile extends PackageEntry {
  path: string;
}

/** Unix 文件 mode 写进 external attributes 的高 16 位，并声明来源为 Unix。 */
function unixAttributes(executable: boolean): { os: number; attrs: number } {
  return {
    os: UNIX_HOST,
    attrs: ((executable ? UNIX_EXECUTABLE_FILE : UNIX_REGULAR_FILE) << 16) >>> 0,
  };
}

/** 打包文本条目，并把可执行位写成 Unix external attributes；路径在写包前同样校验。 */
export function encodePackageEntries(files: readonly PackageFile[]): Buffer {
  const entries: Record<string, [Uint8Array, { os: number; attrs: number }]> = {};
  const encoder = new TextEncoder();
  for (const file of files) {
    assertPackagePath(file.path);
    entries[file.path] = [encoder.encode(file.content), unixAttributes(file.executable)];
  }
  return Buffer.from(zipSync(entries, { level: 6 }));
}

/** 打包：所有条目都是普通文本资源。 */
export function encodePackage(files: Record<string, string>): Buffer {
  return encodePackageEntries(
    Object.entries(files).map(([path, content]) => ({ path, content, executable: false })),
  );
}

/** 只读中央目录得到的条目信息，不分配解压后的内容。 */
export interface ZipEntryInfo {
  name: string;
  originalSize: number;
  compressedSize: number;
  executable: boolean;
}

/** 不写死包类型：知识包等调用方传入自己的条目数/容量上限。 */
export function inspectZipEntries(
  data: Buffer,
  limits: ZipReadLimits = AGENT_PACKAGE_LIMITS,
): ZipEntryInfo[] {
  return readCentralDirectory(data, limits).entries.map(
    ({ name, originalSize, compressedSize, executable }) => ({
      name,
      originalSize,
      compressedSize,
      executable,
    }),
  );
}

export interface ZipFileEntry {
  data: Buffer;
  executable: boolean;
}

/** 先按中央目录校验，再解压；返回原始字节，文本调用方自行解码。 */
export function decodeZipEntries(
  data: Buffer,
  limits: ZipReadLimits = AGENT_PACKAGE_LIMITS,
): Map<string, ZipFileEntry> {
  const { entries, centralOffset } = readCentralDirectory(data, limits);
  const files = new Map<string, ZipFileEntry>();
  let total = 0;
  for (const entry of entries) {
    const bytes = readEntryData(data, entry, centralOffset);
    if (bytes.length !== entry.originalSize) {
      invalid(`ZIP 条目「${entry.name}」实际大小与中央目录不符`, entry.name);
    }
    total += bytes.length;
    if (total > limits.maxUncompressedBytes) {
      invalid(`ZIP 解压后总大小超过 ${limits.maxUncompressedBytes} 字节`);
    }
    files.set(entry.name, { data: Buffer.from(bytes), executable: entry.executable });
  }
  return files;
}

/** 先按中央目录校验，再解压；内容必须能按严格 UTF-8 解码。 */
export function decodePackageEntries(data: Buffer): Map<string, PackageEntry> {
  const files = new Map<string, PackageEntry>();
  for (const [path, entry] of decodeZipEntries(data)) {
    try {
      files.set(path, { content: strictUtf8.decode(entry.data), executable: entry.executable });
    } catch {
      invalid(`「${path}」不是 UTF-8 文本；包内只支持文本资源`, path);
    }
  }
  return files;
}

/** 只关心正文的调用方沿用这个入口；可执行位走 decodePackageEntries。 */
export function decodePackage(data: Buffer): Map<string, string> {
  return new Map([...decodePackageEntries(data)].map(([path, entry]) => [path, entry.content]));
}
