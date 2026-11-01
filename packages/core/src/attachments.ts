import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  ATTACHMENT_LIMITS,
  type AttachmentMimeType,
  attachmentExtension,
  attachmentMimeForFilename,
  type ChatAttachmentInput,
  hasErrorCode,
  type MessageAttachment,
  messageAttachmentSchema,
  slugSchema,
} from '@agentport/shared';
import { fail } from './errors.js';

/**
 * 会话输入的单一存储实现。
 *
 * `WORKSPACES_DIR/<slug>/conversation-inputs/<conversationId>/<attachmentId><ext>`
 *
 * 目录只由配置根、slug、conversationId 与服务端 uuid 组成；用户文件名只作显示。
 * 客户端提供的 base64、扩展名与字节都不可信，入口一次校验完再落盘。
 */

const INPUTS_DIR = 'conversation-inputs';
const segmentPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MiB = 1024 * 1024;

export interface ConversationInputsIdentity {
  root: string;
  slug: string;
  conversationId: string;
}

/** worker 换算容器内挂载路径用；只拼逻辑路径，不做存在性/软链校验。 */
export function conversationInputsDir(input: ConversationInputsIdentity): string {
  return join(resolve(input.root), input.slug, INPUTS_DIR, input.conversationId);
}

export interface DecodedConversationAttachment {
  id: string;
  filename: string;
  mimeType: AttachmentMimeType;
  size: number;
  sha256: string;
  extension: string;
  data: Buffer;
}

function conversationSegments(input: ConversationInputsIdentity): string[] {
  if (!slugSchema.safeParse(input.slug).success) {
    fail('INVALID_INPUT', '智能体目录名非法', { path: '/slug' });
  }
  if (!segmentPattern.test(input.conversationId)) {
    fail('INVALID_INPUT', '会话 id 不能用作目录名', { path: '/conversationId' });
  }
  return [input.slug, INPUTS_DIR, input.conversationId];
}

function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/** 显示名去控制字符与路径分隔符、去首尾空白；保留 Unicode。 */
function cleanFilename(raw: string): string {
  const kept = Array.from(raw).filter((ch) => {
    if (ch === '/' || ch === '\\') return false;
    return !isControl(ch.codePointAt(0) ?? 0);
  });
  return kept.join('').trim();
}

function sanitizeFilename(raw: string): string {
  const trimmed = cleanFilename(raw);
  if (trimmed.length === 0) {
    fail('INVALID_INPUT', '文件名不能为空；请重新选择文件', { path: '/filename' });
  }
  return trimmed;
}

/** 按码点截到 120；在映射扩展名之后截，长文件名仍能识别类型。 */
function truncateFilename(value: string): string {
  return Array.from(value).slice(0, ATTACHMENT_LIMITS.filenameChars).join('');
}

/** 标题等展示场景的宽松清理：清不出可用名字时返回空串，由调用方兜底。 */
export function displayAttachmentFilename(raw: string): string {
  return truncateFilename(cleanFilename(raw));
}

function limitForMime(mimeType: AttachmentMimeType): number {
  if (mimeType.startsWith('image/')) return ATTACHMENT_LIMITS.imageBytes;
  if (mimeType === 'application/pdf') return ATTACHMENT_LIMITS.pdfBytes;
  return ATTACHMENT_LIMITS.textBytes;
}

function mimeLabel(mimeType: AttachmentMimeType): string {
  if (mimeType.startsWith('image/')) return '图片';
  if (mimeType === 'application/pdf') return 'PDF';
  return '文本文件';
}

function hasPrefix(data: Buffer, signature: readonly number[]): boolean {
  return data.length >= signature.length && signature.every((byte, index) => data[index] === byte);
}

/** 扩展名声明什么类型，字节就必须是什么类型；文本另要求合法 UTF-8 且无 NUL。 */
function contentProblem(mimeType: AttachmentMimeType, data: Buffer): string | null {
  switch (mimeType) {
    case 'image/png':
      return hasPrefix(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        ? null
        : '不是有效的 PNG 图片，请确认文件未损坏';
    case 'image/jpeg':
      return hasPrefix(data, [0xff, 0xd8, 0xff]) ? null : '不是有效的 JPEG 图片，请确认文件未损坏';
    case 'image/gif': {
      const header = data.subarray(0, 6).toString('latin1');
      return header === 'GIF87a' || header === 'GIF89a'
        ? null
        : '不是有效的 GIF 图片，请确认文件未损坏';
    }
    case 'image/webp':
      return data.length >= 12 &&
        data.subarray(0, 4).toString('latin1') === 'RIFF' &&
        data.subarray(8, 12).toString('latin1') === 'WEBP'
        ? null
        : '不是有效的 WebP 图片，请确认文件未损坏';
    case 'application/pdf':
      return data.subarray(0, 5).toString('latin1') === '%PDF-'
        ? null
        : '不是有效的 PDF 文件，请确认文件未损坏';
    default: {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(data);
      } catch {
        return '不是有效的 UTF-8 文本，请另存为 UTF-8 后重试';
      }
      return data.includes(0) ? '含二进制内容，不能用作文本附件' : null;
    }
  }
}

function decodeBase64(value: string, filename: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    fail('INVALID_INPUT', `${filename} 的内容不是规范 base64，请重新选择文件`, {
      path: '/dataBase64',
    });
  }
  const data = Buffer.from(value, 'base64');
  // 解码再编码能挡掉 Buffer 默认的宽松解析（缺位、掺字符都会在这里不一致）。
  if (data.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    fail('INVALID_INPUT', `${filename} 的内容不是规范 base64，请重新选择文件`, {
      path: '/dataBase64',
    });
  }
  if (data.length === 0) {
    fail('INVALID_INPUT', `${filename} 内容为空，请重新选择文件`, { path: '/dataBase64' });
  }
  return data;
}

/** 单个附件入口校验：显示名、规范类型、base64、真实大小与文件签名。 */
export function decodeAttachmentInput(input: ChatAttachmentInput): DecodedConversationAttachment {
  const safeFilename = sanitizeFilename(input.filename);
  const filename = truncateFilename(safeFilename);
  const mimeType = attachmentMimeForFilename(safeFilename);
  if (mimeType === null) {
    fail(
      'INVALID_INPUT',
      `${filename} 的文件类型不支持；请改用知识库，或上传 txt/md/csv/tsv/json/jsonl、图片或 PDF`,
      { path: '/filename' },
    );
  }
  const data = decodeBase64(input.dataBase64, filename);
  const limit = limitForMime(mimeType);
  if (data.length > limit) {
    fail(
      'INVALID_INPUT',
      `${filename} 超过${mimeLabel(mimeType)} ${limit / MiB} MiB 上限，请压缩后重试或改用知识库`,
      { path: '/dataBase64' },
    );
  }
  const problem = contentProblem(mimeType, data);
  if (problem !== null) {
    fail('INVALID_INPUT', `${filename} ${problem}`, { path: '/dataBase64' });
  }
  return {
    id: randomUUID(),
    filename,
    mimeType,
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    extension: attachmentExtension(mimeType),
    data,
  };
}

/**
 * 逻辑路径是配置根下的同一组相对段；以根的物理路径为信任起点，
 * 访问路径上每个已存在组件都不能是符号链接，且 realpath 仍在根内。
 */
async function trustedPath(
  input: ConversationInputsIdentity,
  segments: string[],
  label: string,
): Promise<string> {
  const logicalRoot = resolve(input.root);
  const physicalRoot = await realpath(logicalRoot).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) {
      return fail('NOT_FOUND', '工作区根目录不存在', { path: `/${label}` });
    }
    throw error;
  });
  let physical = physicalRoot;
  for (const segment of segments) {
    physical = join(physical, segment);
    const info = await lstat(physical).catch((error: unknown) => {
      if (hasErrorCode(error, 'ENOENT')) return null;
      throw error;
    });
    if (info === null) break;
    if (info.isSymbolicLink()) {
      fail('INVALID_INPUT', '附件路径不能经过符号链接', { path: `/${label}` });
    }
    const actual = await realpath(physical);
    if (actual !== physicalRoot && !actual.startsWith(`${physicalRoot}${sep}`)) {
      fail('INVALID_INPUT', '附件路径越界', { path: `/${label}` });
    }
  }
  return join(logicalRoot, ...segments);
}

async function existingDirectory(
  input: ConversationInputsIdentity,
  segments: string[],
): Promise<string | null> {
  const logicalRoot = resolve(input.root);
  const physicalRoot = await realpath(logicalRoot).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return null;
    throw error;
  });
  if (physicalRoot === null) return null;
  let physical = physicalRoot;
  for (const segment of segments) {
    physical = join(physical, segment);
    const info = await lstat(physical).catch((error: unknown) => {
      if (hasErrorCode(error, 'ENOENT')) return null;
      throw error;
    });
    if (info === null || info.isSymbolicLink() || !info.isDirectory()) return null;
    const actual = await realpath(physical).catch((error: unknown) => {
      if (hasErrorCode(error, 'ENOENT')) return null;
      throw error;
    });
    if (actual === null) return null;
    if (actual !== physicalRoot && !actual.startsWith(`${physicalRoot}${sep}`)) return null;
  }
  return join(logicalRoot, ...segments);
}

async function prepareDirectory(input: ConversationInputsIdentity, label: string): Promise<string> {
  const segments = conversationSegments(input);
  // 首次写入时根可能还不存在；只有写入路径创建根，读取路径保持不隐式创建。
  await mkdir(resolve(input.root), { recursive: true, mode: 0o700 });
  await trustedPath(input, segments, label);
  const dir = conversationInputsDir(input);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(join(resolve(input.root), input.slug, INPUTS_DIR), 0o700);
  await chmod(dir, 0o700);
  // mkdir 之后复查一次：已存在的中间目录若是软链，这时候必须拒绝。
  await trustedPath(input, segments, label);
  return dir;
}

async function writeFiles(
  dir: string,
  files: ReadonlyArray<{ name: string; data: Buffer }>,
): Promise<void> {
  const written: string[] = [];
  const temps: string[] = [];
  try {
    for (const file of files) {
      const destination = join(dir, file.name);
      const temp = join(dir, `.tmp-${randomUUID()}`);
      temps.push(temp);
      await writeFile(temp, file.data, { flag: 'wx', mode: 0o600 });
      await rename(temp, destination);
      written.push(destination);
      await chmod(destination, 0o600);
    }
  } catch (error) {
    for (const temp of temps) await rm(temp, { force: true });
    for (const destination of written) await rm(destination, { force: true });
    throw error;
  }
}

export interface WriteConversationAttachmentsInput extends ConversationInputsIdentity {
  inputs: readonly ChatAttachmentInput[];
}

/** 全部先校验再落盘；失败清理本次写入的文件，不留半套附件。 */
export async function writeConversationAttachments(
  input: WriteConversationAttachmentsInput,
): Promise<MessageAttachment[]> {
  if (input.inputs.length === 0) return [];
  if (input.inputs.length > ATTACHMENT_LIMITS.count) {
    fail('INVALID_INPUT', `每条消息最多 ${ATTACHMENT_LIMITS.count} 个附件`, {
      path: '/attachments',
    });
  }
  const decoded = input.inputs.map(decodeAttachmentInput);
  const totalBytes = decoded.reduce((sum, attachment) => sum + attachment.size, 0);
  if (totalBytes > ATTACHMENT_LIMITS.totalBytes) {
    fail(
      'INVALID_INPUT',
      `附件合计超过 ${ATTACHMENT_LIMITS.totalBytes / MiB} MiB 上限，请减少文件或压缩后重试`,
      { path: '/attachments' },
    );
  }
  const dir = await prepareDirectory(input, 'conversationId');
  await writeFiles(
    dir,
    decoded.map((attachment) => ({
      name: `${attachment.id}${attachment.extension}`,
      data: attachment.data,
    })),
  );
  return decoded.map(({ id, filename, mimeType, size, sha256 }) => ({
    id,
    filename,
    mimeType,
    size,
    sha256,
  }));
}

export interface ReadConversationAttachmentInput extends ConversationInputsIdentity {
  attachment: MessageAttachment;
}

/** 只按元数据 uuid + 规范扩展名读取；软链、硬链与非普通文件一律拒绝。 */
export async function readConversationAttachment(
  input: ReadConversationAttachmentInput,
): Promise<{ data: Buffer; filename: string; mimeType: AttachmentMimeType }> {
  const parsed = messageAttachmentSchema.safeParse(input.attachment);
  if (!parsed.success) {
    fail('INVALID_INPUT', '附件元数据非法', { path: '/attachment' });
  }
  const { id, filename, mimeType } = parsed.data;
  const full = await trustedPath(
    input,
    [...conversationSegments(input), `${id}${attachmentExtension(mimeType)}`],
    'attachmentId',
  );
  const info = await lstat(full).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) {
      fail('NOT_FOUND', '附件不存在，可能已被删除', { path: '/attachmentId' });
    }
    throw error;
  });
  if (info.isSymbolicLink() || !info.isFile()) {
    fail('INVALID_INPUT', '附件文件不是普通文件', { path: '/attachmentId' });
  }
  if (info.nlink !== 1) {
    fail('INVALID_INPUT', '附件文件不允许硬链接', { path: '/attachmentId' });
  }
  return { data: await readFile(full), filename, mimeType };
}

export interface CopyConversationInputsInput {
  root: string;
  slug: string;
  sourceConversationId: string;
  targetConversationId: string;
  attachmentIds: readonly string[];
}

/** 分支时按消息引用的 id 复制字节（不用硬链接）；缺任一 id 直接失败。 */
export async function copyConversationInputs(input: CopyConversationInputsInput): Promise<void> {
  const ids = [...new Set(input.attachmentIds)];
  if (ids.length === 0) return;
  for (const id of ids) {
    if (!uuidPattern.test(id)) {
      fail('INVALID_INPUT', '附件 id 非法', { path: '/attachmentIds' });
    }
  }
  if (input.sourceConversationId === input.targetConversationId) return;

  const source: ConversationInputsIdentity = {
    root: input.root,
    slug: input.slug,
    conversationId: input.sourceConversationId,
  };
  const sourceDir = await trustedPath(source, conversationSegments(source), 'sourceConversationId');
  const entries = await readdir(sourceDir, { withFileTypes: true }).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) {
      fail('NOT_FOUND', '源会话没有可复制的附件', { path: '/sourceConversationId' });
    }
    throw error;
  });
  const byId = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const dot = entry.name.indexOf('.');
    if (dot > 0) byId.set(entry.name.slice(0, dot), entry.name);
  }

  // 先把源文件全部读齐；任何缺失都在创建目标目录前失败。
  const files: Array<{ name: string; data: Buffer }> = [];
  for (const id of ids) {
    const name = byId.get(id);
    if (name === undefined) {
      fail('NOT_FOUND', `源会话缺少附件 ${id}，无法创建分支`, { path: '/attachmentIds' });
    }
    const full = join(sourceDir, name);
    const info = await lstat(full);
    if (info.isSymbolicLink() || !info.isFile()) {
      fail('INVALID_INPUT', '附件文件不是普通文件', { path: '/attachmentIds' });
    }
    if (info.nlink !== 1) {
      fail('INVALID_INPUT', '附件文件不允许硬链接', { path: '/attachmentIds' });
    }
    files.push({ name, data: await readFile(full) });
  }

  const target: ConversationInputsIdentity = {
    root: input.root,
    slug: input.slug,
    conversationId: input.targetConversationId,
  };
  const dir = await prepareDirectory(target, 'targetConversationId');
  await writeFiles(dir, files);
}

/** 删除且只删除该会话的输入目录；重复调用或目录不存在都无副作用。 */
export async function removeConversationInputs(input: ConversationInputsIdentity): Promise<void> {
  if (!slugSchema.safeParse(input.slug).success || !segmentPattern.test(input.conversationId))
    return;
  const dir = await existingDirectory(input, [input.slug, INPUTS_DIR, input.conversationId]);
  if (dir === null) return;
  await rm(dir, { recursive: true, force: true });
}
