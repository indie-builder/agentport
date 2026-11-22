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
  attachmentByteLimit,
  attachmentExtension,
  attachmentMimeForFilename,
  type ChatAttachmentInput,
  hasErrorCode,
  type MessageAttachment,
  messageAttachmentSchema,
  segmentIdPattern,
  slugSchema,
} from '@agentport/shared';
import * as Bun from 'bun';
import { AGENT_DIR_SLUG_INVALID_MESSAGE, fail } from './errors.js';
import { pathSegmentsProblem } from './path-segments.js';

const INPUTS_DIR = 'conversation-inputs';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MiB = 1024 * 1024;

interface ConversationInputsIdentity {
  root: string;
  slug: string;
  conversationId: string;
}

export function conversationInputsDir(input: ConversationInputsIdentity): string {
  return join(resolve(input.root), input.slug, INPUTS_DIR, input.conversationId);
}

interface DecodedConversationAttachment {
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
    fail('INVALID_INPUT', AGENT_DIR_SLUG_INVALID_MESSAGE, { path: '/slug' });
  }
  if (!segmentIdPattern.test(input.conversationId)) {
    fail('INVALID_INPUT', '会话 id 不能用作目录名', { path: '/conversationId' });
  }
  return [input.slug, INPUTS_DIR, input.conversationId];
}

function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

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

function truncateFilename(value: string): string {
  return Array.from(value).slice(0, ATTACHMENT_LIMITS.filenameChars).join('');
}

export function displayAttachmentFilename(raw: string): string {
  return truncateFilename(cleanFilename(raw));
}

function mimeLabel(mimeType: AttachmentMimeType): string {
  if (mimeType.startsWith('image/')) return '图片';
  if (mimeType === 'application/pdf') return 'PDF';
  return '文本文件';
}

function hasPrefix(data: Buffer, signature: readonly number[]): boolean {
  return data.length >= signature.length && signature.every((byte, index) => data[index] === byte);
}

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
  const limit = attachmentByteLimit(mimeType);
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
    id: crypto.randomUUID(),
    filename,
    mimeType,
    size: data.length,
    sha256: new Bun.CryptoHasher('sha256').update(data).digest('hex'),
    extension: attachmentExtension(mimeType),
    data,
  };
}

async function trustedPath(
  input: { root: string },
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
  const problem = await pathSegmentsProblem(physicalRoot, segments);
  if (problem === 'link') {
    fail('INVALID_INPUT', '附件路径不能经过符号链接', { path: `/${label}` });
  }
  if (problem === 'outside') {
    fail('INVALID_INPUT', '附件路径越界', { path: `/${label}` });
  }
  return join(logicalRoot, ...segments);
}

async function existingDirectory(
  input: { root: string },
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

async function preparePath(root: string, segments: string[], label: string): Promise<string> {
  await mkdir(resolve(root), { recursive: true, mode: 0o700 });
  await trustedPath({ root }, segments, label);
  const dir = join(resolve(root), ...segments);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(join(resolve(root), ...segments.slice(0, -1)), 0o700);
  await chmod(dir, 0o700);
  await trustedPath({ root }, segments, label);
  return dir;
}

async function prepareDirectory(input: ConversationInputsIdentity, label: string): Promise<string> {
  return preparePath(input.root, conversationSegments(input), label);
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
      const temp = join(dir, `.tmp-${crypto.randomUUID()}`);
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

async function writeAttachmentSet(input: {
  root: string;
  segments: string[];
  label: string;
  attachments: readonly DecodedConversationAttachment[];
}): Promise<MessageAttachment[]> {
  const decoded = input.attachments;
  if (decoded.length === 0) return [];
  if (decoded.length > ATTACHMENT_LIMITS.count) {
    fail('INVALID_INPUT', `每条消息最多 ${ATTACHMENT_LIMITS.count} 个附件`, {
      path: '/attachments',
    });
  }
  const totalBytes = decoded.reduce((sum, attachment) => sum + attachment.size, 0);
  if (totalBytes > ATTACHMENT_LIMITS.totalBytes) {
    fail(
      'INVALID_INPUT',
      `附件合计超过 ${ATTACHMENT_LIMITS.totalBytes / MiB} MiB 上限，请减少文件或压缩后重试`,
      { path: '/attachments' },
    );
  }
  const dir = await preparePath(input.root, input.segments, input.label);
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

type WriteConversationAttachmentsInput = ConversationInputsIdentity &
  (
    | { inputs: readonly ChatAttachmentInput[] }
    | { attachments: readonly DecodedConversationAttachment[] }
  );

export async function writeConversationAttachments(
  input: WriteConversationAttachmentsInput,
): Promise<MessageAttachment[]> {
  return writeAttachmentSet({
    root: input.root,
    segments: conversationSegments(input),
    label: 'conversationId',
    attachments: 'inputs' in input ? input.inputs.map(decodeAttachmentInput) : input.attachments,
  });
}

async function readAttachmentAt(
  root: string,
  segments: string[],
  attachment: MessageAttachment,
): Promise<{ data: Buffer; filename: string; mimeType: AttachmentMimeType }> {
  const parsed = messageAttachmentSchema.safeParse(attachment);
  if (!parsed.success) {
    fail('INVALID_INPUT', '附件元数据非法', { path: '/attachment' });
  }
  const { id, filename, mimeType } = parsed.data;
  const full = await trustedPath(
    { root },
    [...segments, `${id}${attachmentExtension(mimeType)}`],
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

interface ReadConversationAttachmentInput extends ConversationInputsIdentity {
  attachment: MessageAttachment;
}

export async function readConversationAttachment(
  input: ReadConversationAttachmentInput,
): Promise<{ data: Buffer; filename: string; mimeType: AttachmentMimeType }> {
  return readAttachmentAt(input.root, conversationSegments(input), input.attachment);
}

interface CopyConversationInputsInput {
  root: string;
  slug: string;
  sourceConversationId: string;
  targetConversationId: string;
  attachmentIds: readonly string[];
}

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

export async function removeConversationInputs(input: ConversationInputsIdentity): Promise<void> {
  if (!slugSchema.safeParse(input.slug).success || !segmentIdPattern.test(input.conversationId))
    return;
  const dir = await existingDirectory(input, [input.slug, INPUTS_DIR, input.conversationId]);
  if (dir === null) return;
  await rm(dir, { recursive: true, force: true });
}

const CHANNEL_INPUTS_DIR = '_channel-inputs';

interface ChannelInputsIdentity {
  root: string;
  channelId: string;
  messageId: string;
}

function channelSegments(input: ChannelInputsIdentity): string[] {
  if (!segmentIdPattern.test(input.channelId)) {
    fail('INVALID_INPUT', '频道 id 不能用作目录名', { path: '/channelId' });
  }
  if (!segmentIdPattern.test(input.messageId)) {
    fail('INVALID_INPUT', '消息 id 不能用作目录名', { path: '/messageId' });
  }
  return [CHANNEL_INPUTS_DIR, input.channelId, input.messageId];
}

export async function writeChannelAttachments(
  input: ChannelInputsIdentity & { inputs: readonly ChatAttachmentInput[] },
): Promise<MessageAttachment[]> {
  return writeAttachmentSet({
    root: input.root,
    segments: channelSegments(input),
    label: 'messageId',
    attachments: input.inputs.map(decodeAttachmentInput),
  });
}

export async function readChannelAttachment(
  input: ChannelInputsIdentity & { attachment: MessageAttachment },
): Promise<{ data: Buffer; filename: string; mimeType: AttachmentMimeType }> {
  return readAttachmentAt(input.root, channelSegments(input), input.attachment);
}

export async function copyChannelAttachmentsToConversation(
  input: ChannelInputsIdentity & {
    slug: string;
    conversationId: string;
    attachments: readonly MessageAttachment[];
  },
): Promise<void> {
  if (input.attachments.length === 0) return;
  const segments = channelSegments(input);
  const files: Array<{ name: string; data: Buffer }> = [];
  for (const attachment of input.attachments) {
    const file = await readAttachmentAt(input.root, segments, attachment);
    files.push({
      name: `${attachment.id}${attachmentExtension(attachment.mimeType)}`,
      data: file.data,
    });
  }
  const dir = await prepareDirectory(
    { root: input.root, slug: input.slug, conversationId: input.conversationId },
    'conversationId',
  );
  await writeFiles(dir, files);
}

export async function removeChannelInputs(input: ChannelInputsIdentity): Promise<void> {
  if (!segmentIdPattern.test(input.channelId) || !segmentIdPattern.test(input.messageId)) return;
  const dir = await existingDirectory({ root: input.root }, channelSegments(input));
  if (dir === null) return;
  await rm(dir, { recursive: true, force: true });
}
