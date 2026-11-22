import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import {
  hasErrorCode,
  type OutputFile,
  type OutputList,
  type OutputManifest,
  type OutputStatus,
  outputManifestSchema,
  outputOwnerIdSchema,
  outputPathSchema,
  slugSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { fail, INVALID_CURSOR_MESSAGE } from './errors.js';
import { pathSegmentsProblem } from './path-segments.js';

const CONVERSATION_OUTPUTS = 'conversation-outputs';
const DRAFTS = 'drafts';
const RUNS = 'runs';
const FILES = 'files';
const MANIFEST = 'manifest.json';

const CAPTURE_MAX_FILES = 2_000;
const CAPTURE_MAX_ENTRIES = 20_000;
const CAPTURE_MAX_FILE_BYTES = 32 * 1024 * 1024;
const CAPTURE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const CAPTURE_MAX_DEPTH = 16;
const READ_CHUNK_BYTES = 64 * 1024;

const mediaTypes = new Map<string, string>([
  ['md', 'text/markdown'],
  ['markdown', 'text/markdown'],
  ['txt', 'text/plain'],
  ['log', 'text/plain'],
  ['csv', 'text/csv'],
  ['tsv', 'text/tab-separated-values'],
  ['json', 'application/json'],
  ['jsonl', 'application/x-ndjson'],
  ['html', 'text/html'],
  ['htm', 'text/html'],
  ['svg', 'image/svg+xml'],
  ['xml', 'application/xml'],
  ['yaml', 'application/yaml'],
  ['yml', 'application/yaml'],
  ['pdf', 'application/pdf'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif'],
  ['bmp', 'image/bmp'],
  ['tif', 'image/tiff'],
  ['tiff', 'image/tiff'],
  ['doc', 'application/msword'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xls', 'application/vnd.ms-excel'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['ppt', 'application/vnd.ms-powerpoint'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['odt', 'application/vnd.oasis.opendocument.text'],
  ['ods', 'application/vnd.oasis.opendocument.spreadsheet'],
  ['odp', 'application/vnd.oasis.opendocument.presentation'],
  ['zip', 'application/zip'],
]);

function mediaTypeOf(path: string): string {
  const extension = extname(path).slice(1).toLowerCase();
  return mediaTypes.get(extension) ?? 'application/octet-stream';
}

function ownerId(value: string, field: string): string {
  if (!outputOwnerIdSchema.safeParse(value).success) {
    fail('INVALID_INPUT', `${field} 不能用作产出目录名`, { path: `/${field}` });
  }
  return value;
}

function conversationSegments(input: { slug: string; conversationId: string }): string[] {
  if (!slugSchema.safeParse(input.slug).success) {
    fail('INVALID_INPUT', '智能体目录名非法', { path: '/slug' });
  }
  ownerId(input.conversationId, 'conversationId');
  return [input.slug, CONVERSATION_OUTPUTS, input.conversationId];
}

function conversationDir(input: { root: string; slug: string; conversationId: string }): string {
  return join(resolve(input.root), ...conversationSegments(input));
}

function runIdOf(value: string): string {
  return ownerId(value, 'runId');
}

function safePath(value: string): string {
  const parsed = outputPathSchema.safeParse(value);
  if (!parsed.success)
    fail('INVALID_INPUT', '产出路径必须是不逃逸的安全相对路径', { path: '/path' });
  return parsed.data;
}

interface ConversationIdentity {
  root: string;
  slug: string;
  conversationId: string;
}

async function rootPhysicalPath(identity: ConversationIdentity, label: string): Promise<string> {
  return realpath(resolve(identity.root)).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT'))
      return fail('NOT_FOUND', '产出根目录不存在', { path: `/${label}` });
    throw error;
  });
}

async function trustedPath(
  identity: ConversationIdentity,
  segments: string[],
  label: string,
  physicalRoot?: string,
): Promise<string> {
  const logicalRoot = resolve(identity.root);
  const root = physicalRoot ?? (await rootPhysicalPath(identity, label));
  if ((await pathSegmentsProblem(root, segments)) !== null) {
    fail('INVALID_INPUT', '产出路径不能经过符号链接', { path: `/${label}` });
  }
  return join(physicalRoot ?? logicalRoot, ...segments);
}

function baseFileOf(conversationRoot: string, runId: string): string {
  return join(conversationRoot, DRAFTS, `${runId}.base`);
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function fileOf(manifest: OutputManifest, file: OutputManifest['files'][number]): OutputFile {
  return {
    runId: manifest.runId,
    path: file.path,
    size: file.size,
    sha256: file.sha256,
    mediaType: file.mediaType,
    createdAt: manifest.createdAt,
    status: manifest.status,
    userMessageId: manifest.userMessageId,
    afterMessageId: manifest.afterMessageId,
  };
}

async function loadManifest(
  identity: ConversationIdentity,
  runId: string,
  physicalRoot?: string,
): Promise<OutputManifest | null> {
  const full = await trustedPath(
    identity,
    [...conversationSegments(identity), RUNS, runIdOf(runId), MANIFEST],
    MANIFEST,
    physicalRoot,
  );
  const info = await lstat(full).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return null;
    throw error;
  });
  if (info === null) return null;
  if (info.isSymbolicLink() || !info.isFile()) {
    fail('INVALID_INPUT', '产出文件不是普通文件', { path: `/${MANIFEST}` });
  }
  if (info.nlink !== 1) fail('INVALID_INPUT', '产出文件不允许硬链接', { path: `/${MANIFEST}` });
  const raw = (
    await readFile(full).catch((error: unknown) => {
      if (hasErrorCode(error, 'ENOENT'))
        fail('NOT_FOUND', '产出文件不存在', { path: `/${MANIFEST}` });
      throw error;
    })
  ).toString('utf8');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    fail('INTERNAL_ERROR', '产出快照索引损坏，拒绝读取', { path: `/${runId}/${MANIFEST}` });
  }
  const parsed = outputManifestSchema.safeParse(json);
  if (!parsed.success || parsed.data.runId !== runId) {
    fail('INTERNAL_ERROR', '产出快照索引损坏，拒绝读取', { path: `/${runId}/${MANIFEST}` });
  }
  return parsed.data;
}

async function publishedVersions(
  identity: ConversationIdentity,
): Promise<Array<{ runId: string; manifest: OutputManifest }>> {
  const segments = [...conversationSegments(identity), RUNS];
  const physicalRoot = await rootPhysicalPath(identity, RUNS);
  const runsDir = await trustedPath(identity, segments, RUNS, physicalRoot);
  const entries = await readdir(runsDir, { withFileTypes: true }).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return [];
    throw error;
  });
  const versions: Array<{ runId: string; manifest: OutputManifest }> = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) {
      fail('INVALID_INPUT', '产出路径不能经过符号链接', { path: `/${entry.name}` });
    }
    if (!entry.isDirectory()) continue;
    const manifest = await loadManifest(identity, entry.name, physicalRoot);
    if (manifest !== null) versions.push({ runId: entry.name, manifest });
  }
  versions.sort(
    (a, b) =>
      compareText(b.manifest.createdAt, a.manifest.createdAt) || compareText(b.runId, a.runId),
  );
  return versions;
}

/** 维护删消息前读取：包含空快照的两个锚点；沿用发布版本校验，读取失败必须中止清理。 */
export async function outputMessageAnchors(identity: ConversationIdentity): Promise<string[]> {
  const ids = new Set<string>();
  for (const { manifest } of await publishedVersions(identity)) {
    ids.add(manifest.userMessageId);
    ids.add(manifest.afterMessageId);
  }
  return [...ids];
}

async function latestVersion(identity: ConversationIdentity): Promise<OutputManifest | null> {
  return (await publishedVersions(identity))[0]?.manifest ?? null;
}

async function readRegularFile(
  identity: ConversationIdentity,
  full: string,
  path: string,
  maxBytes?: number,
): Promise<Buffer> {
  await trustedPath(identity, relative(resolve(identity.root), full).split(sep), path);
  const info = await lstat(full).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) fail('NOT_FOUND', '产出文件不存在', { path: `/${path}` });
    throw error;
  });
  if (info.isSymbolicLink() || !info.isFile()) {
    fail('INVALID_INPUT', '产出文件不是普通文件', { path: `/${path}` });
  }
  if (info.nlink !== 1) fail('INVALID_INPUT', '产出文件不允许硬链接', { path: `/${path}` });
  if (maxBytes !== undefined && info.size > maxBytes)
    fail('INVALID_INPUT', '产出文件超过单文件上限', { path: `/${path}` });
  if (maxBytes === undefined) return readFile(full);
  const handle = await open(full, 'r');
  try {
    const opened = await handle.stat();
    if (opened.size > maxBytes)
      fail('INVALID_INPUT', '产出文件超过单文件上限', { path: `/${path}` });
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - offset));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (offset > maxBytes) fail('INVALID_INPUT', '产出文件超过单文件上限', { path: `/${path}` });
    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}

interface CaptureBudget {
  files: number;
  entries: number;
  bytes: number;
}

async function draftEntries(
  identity: ConversationIdentity,
  dir: string,
  budget: CaptureBudget,
  prefix = '',
  depth = 0,
): Promise<Array<{ path: string; data: Buffer }>> {
  if (depth > CAPTURE_MAX_DEPTH) fail('INVALID_INPUT', '产出目录层级过深', { path: `/${prefix}` });
  await trustedPath(identity, relative(resolve(identity.root), dir).split(sep), 'draft');
  const reader = await opendir(dir);
  const files: Array<{ path: string; data: Buffer }> = [];
  try {
    for await (const entry of reader) {
      budget.entries += 1;
      if (budget.entries > CAPTURE_MAX_ENTRIES)
        fail('INVALID_INPUT', '产出目录项超过上限', { path: `/${prefix}` });
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await draftEntries(identity, full, budget, path, depth + 1)));
        continue;
      }
      const safe = safePath(path);
      budget.files += 1;
      if (budget.files > CAPTURE_MAX_FILES)
        fail('INVALID_INPUT', '产出文件数超过上限', { path: `/${safe}` });
      const remaining = CAPTURE_MAX_TOTAL_BYTES - budget.bytes;
      const data = await readRegularFile(
        identity,
        full,
        safe,
        Math.min(CAPTURE_MAX_FILE_BYTES, remaining),
      );
      budget.bytes += data.length;
      if (budget.bytes > CAPTURE_MAX_TOTAL_BYTES)
        fail('INVALID_INPUT', '产出总字节超过上限', { path: `/${safe}` });
      files.push({ path: safe, data });
    }
  } finally {
    await reader.close().catch((error: unknown) => {
      if (!hasErrorCode(error, 'ERR_DIR_CLOSED')) throw error;
    });
  }
  return files.sort((a, b) => compareText(a.path, b.path));
}

async function copySnapshot(
  identity: ConversationIdentity,
  manifest: OutputManifest,
  target: string,
): Promise<void> {
  for (const file of manifest.files) {
    const source = join(
      conversationDir(identity),
      RUNS,
      manifest.runId,
      FILES,
      ...file.path.split('/'),
    );
    const data = await readRegularFile(identity, source, file.path);
    const destination = await trustedPath(
      identity,
      [...relative(resolve(identity.root), target).split(sep), ...file.path.split('/')],
      file.path,
    );
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, data);
  }
}

async function removeQuietly(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

async function discardDraft(conversationRoot: string, runId: string): Promise<void> {
  await removeQuietly(join(conversationRoot, DRAFTS, runId));
  await removeQuietly(baseFileOf(conversationRoot, runId));
}

interface OutputDraftIdentity extends ConversationIdentity {
  runId: string;
}

async function blockedDraftPath(input: OutputDraftIdentity): Promise<string> {
  return trustedPath(
    input,
    [...conversationSegments(input), DRAFTS, `${runIdOf(input.runId)}.blocked`],
    'runId',
  );
}

export async function setOutputDraftBlocked(
  input: OutputDraftIdentity,
  problem: string | null,
): Promise<void> {
  const path = await blockedDraftPath(input);
  if (problem === null) {
    await rm(path, { force: true });
  } else {
    await mkdir(dirname(path), { recursive: true });
    const existing = await lstat(path).catch((error: unknown) => {
      if (hasErrorCode(error, 'ENOENT')) return null;
      throw error;
    });
    if (existing !== null) await readRegularFile(input, path, 'blocked');
    await writeFile(path, problem);
  }
}

export async function outputDraftBlockedReason(input: OutputDraftIdentity): Promise<string | null> {
  const path = await blockedDraftPath(input);
  return readRegularFile(input, path, 'blocked')
    .then((data) => data.toString('utf8'))
    .catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'NOT_FOUND') return null;
      throw error;
    });
}

interface PrepareOutputDraftInput {
  root: string;
  slug: string;
  conversationId: string;
  runId: string;
  /** 用户选定的历史版本；缺省复制当前最新版。 */
  sourceRunId?: string;
  sourcePath?: string;
}

/**
 * 为本轮准备可写草稿，返回草稿的宿主绝对路径（worker 据此挂载）。
 * 已有草稿直接复用：重试不重放、不覆盖已写文件。
 */
export async function prepareOutputDraft(input: PrepareOutputDraftInput): Promise<string> {
  if (input.sourcePath !== undefined && input.sourceRunId === undefined) {
    fail('INVALID_INPUT', '选择产出文件必须提供 sourceRunId', { path: '/sourceRunId' });
  }
  const sourcePath = input.sourcePath === undefined ? undefined : safePath(input.sourcePath);
  if (input.sourceRunId !== undefined) runIdOf(input.sourceRunId);
  const conversationRoot = await trustedPath(input, conversationSegments(input), 'conversationId');
  const runId = runIdOf(input.runId);
  const draftDir = await trustedPath(input, [...conversationSegments(input), DRAFTS, runId], runId);
  const existing = await lstat(draftDir).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return null;
    throw error;
  });
  if (existing !== null) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      fail('INVALID_INPUT', '产出草稿目录非法', { path: `/${runId}` });
    }
    return draftDir;
  }

  const latest = await latestVersion(input);
  const source =
    input.sourceRunId === undefined
      ? latest
      : await loadManifest(input, runIdOf(input.sourceRunId));
  const baseline = latest ?? source;
  const initial = input.sourceRunId !== undefined && sourcePath === undefined ? source : baseline;
  if (input.sourceRunId !== undefined && source === null) {
    fail('NOT_FOUND', '所选产出快照不存在', { path: `/${input.sourceRunId}` });
  }

  const staging = join(conversationRoot, DRAFTS, `.tmp-${runId}-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  try {
    if (initial !== null) await copySnapshot(input, initial, staging);
    if (sourcePath !== undefined && source !== null) {
      const selected = await readOutputFile({ ...input, runId: source.runId, path: sourcePath });
      const destination = join(staging, ...sourcePath.split('/'));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, selected.data);
    }
    const baseFile = await trustedPath(
      input,
      [...conversationSegments(input), DRAFTS, `${runId}.base`],
      runId,
    );
    await writeFile(baseFile, baseline?.runId ?? '');
    await rename(staging, draftDir);
  } catch (error) {
    await removeQuietly(staging);
    await removeQuietly(baseFileOf(conversationRoot, runId));
    throw error;
  }
  return draftDir;
}

/**
 * 把已停止写入的稳定 outputs 挂载目录捕获回本轮草稿。
 *
 * 复用容器时 `/mnt/outputs` 不再按 run 挂载，发布后也不能删除这个稳定目录；
 * 这里只复制内容，源目录、`drafts/<runId>.base`、`.blocked` 与已发布快照都保持原样。
 * 先完整读取到 staging（逐文件沿用草稿的路径/普通文件/软硬链接校验），
 * 成功后才替换未挂载的草稿；任何失败都保留原草稿。
 */
export async function captureOutputDraft(input: {
  root: string;
  slug: string;
  conversationId: string;
  runId: string;
  /** 内部配置的稳定挂载目录（须位于 root 内）；目录可信，内容仍按沙盒可写数据校验。 */
  sourceDir: string;
}): Promise<void> {
  const conversationRoot = await trustedPath(input, conversationSegments(input), 'conversationId');
  const runId = runIdOf(input.runId);
  const draftDir = await trustedPath(input, [...conversationSegments(input), DRAFTS, runId], runId);
  const sourceDir = await trustedPath(
    input,
    relative(resolve(input.root), resolve(input.sourceDir)).split(sep),
    'sourceDir',
  );
  const sourceInfo = await lstat(sourceDir).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT'))
      fail('NOT_FOUND', '产出挂载目录不存在', { path: '/sourceDir' });
    throw error;
  });
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
    fail('INVALID_INPUT', '产出挂载目录非法', { path: '/sourceDir' });
  }

  const files = await draftEntries(input, sourceDir, { files: 0, entries: 0, bytes: 0 });

  const staging = join(conversationRoot, DRAFTS, `.tmp-${runId}-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  let previous: string | null = null;
  try {
    for (const file of files) {
      const destination = join(staging, ...file.path.split('/'));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.data);
    }

    const existing = await lstat(draftDir).catch((error: unknown) => {
      if (hasErrorCode(error, 'ENOENT')) return null;
      throw error;
    });
    if (existing !== null) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        fail('INVALID_INPUT', '产出草稿目录非法', { path: `/${runId}` });
      }
      previous = join(conversationRoot, DRAFTS, `.tmp-${runId}-${randomUUID()}`);
      await rename(draftDir, previous);
    }
    try {
      await rename(staging, draftDir);
    } catch (error) {
      if (previous !== null) await rename(previous, draftDir);
      throw error;
    }
  } catch (error) {
    await removeQuietly(staging);
    throw error;
  }
  if (previous !== null) await removeQuietly(previous);
}

interface PublishOutputSnapshotInput {
  root: string;
  slug: string;
  conversationId: string;
  runId: string;
  status: OutputStatus;
  userMessageId: string;
  afterMessageId: string;
}

/**
 * 把本轮草稿发布为完整不可变快照。
 * 无基线且没写文件、或与基线逐字节一致时不新增版本；发布成功清草稿，失败保留。
 */
export async function publishOutputSnapshot(input: PublishOutputSnapshotInput): Promise<void> {
  const conversationRoot = await trustedPath(input, conversationSegments(input), 'conversationId');
  const runId = runIdOf(input.runId);
  const draftDir = await trustedPath(input, [...conversationSegments(input), DRAFTS, runId], runId);
  const draftInfo = await lstat(draftDir).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return null;
    throw error;
  });
  if (draftInfo === null) return;
  if (draftInfo.isSymbolicLink() || !draftInfo.isDirectory()) {
    fail('INVALID_INPUT', '产出草稿目录非法', { path: `/${runId}` });
  }

  const snapshotDir = await trustedPath(
    input,
    [...conversationSegments(input), RUNS, runId],
    runId,
  );
  const already = await lstat(snapshotDir).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return null;
    throw error;
  });
  if (already !== null) {
    await discardDraft(conversationRoot, runId);
    return;
  }

  const basePath = await trustedPath(
    input,
    [...conversationSegments(input), DRAFTS, `${runId}.base`],
    runId,
  );
  const baseRunId = (
    await readRegularFile(input, basePath, `${runId}.base`).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'NOT_FOUND')
        return Buffer.from('');
      throw error;
    })
  )
    .toString('utf8')
    .trim();
  const base = baseRunId === '' ? null : await loadManifest(input, baseRunId);
  const files = await draftEntries(input, draftDir, { files: 0, entries: 0, bytes: 0 });
  if (files.length === 0 && (base === null || base.files.length === 0)) {
    await discardDraft(conversationRoot, runId);
    return;
  }
  const baseFiles = new Map(base?.files.map((file) => [file.path, file]) ?? []);
  const manifestFiles = files.map((file) => {
    const previous = baseFiles.get(file.path);
    const digest = sha256Hex(file.data);
    return {
      path: file.path,
      size: file.data.length,
      sha256: digest,
      mediaType: mediaTypeOf(file.path),
      changed:
        previous === undefined || previous.sha256 !== digest || previous.size !== file.data.length,
    };
  });
  const unchanged =
    base !== null &&
    base.files.length === manifestFiles.length &&
    manifestFiles.every((file) => {
      const previous = baseFiles.get(file.path);
      return previous !== undefined && previous.sha256 === file.sha256;
    });
  if (unchanged) {
    await discardDraft(conversationRoot, runId);
    return;
  }

  const manifest = outputManifestSchema.parse({
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    status: input.status,
    userMessageId: input.userMessageId,
    afterMessageId: input.afterMessageId,
    files: manifestFiles,
  });

  await mkdir(join(conversationRoot, RUNS), { recursive: true });
  const staging = join(conversationRoot, RUNS, `.tmp-${runId}-${randomUUID()}`);
  try {
    await mkdir(join(staging, FILES), { recursive: true });
    for (const file of files) {
      const destination = join(staging, FILES, ...file.path.split('/'));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.data);
    }
    await writeFile(join(staging, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(staging, snapshotDir);
  } catch (error) {
    await removeQuietly(staging);
    throw error;
  }
  await discardDraft(conversationRoot, runId);
}

interface ListOutputFilesInput {
  root: string;
  slug: string;
  conversationId: string;
  limit: number;
  before?: string;
  runId?: string;
}

const cursorSchema = z.object({
  createdAt: z.string().min(1),
  runId: z.string().min(1),
  path: outputPathSchema,
});

type Cursor = z.infer<typeof cursorSchema>;

function encodeCursor(item: OutputFile): string {
  return Buffer.from(
    JSON.stringify({ createdAt: item.createdAt, runId: item.runId, path: item.path }),
  ).toString('base64url');
}

function decodeCursor(value: string): Cursor {
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    if (parsed.success) return parsed.data;
  } catch {
    // 落到统一的游标错误。
  }
  fail('INVALID_INPUT', INVALID_CURSOR_MESSAGE, { path: '/cursor' });
}

function afterCursor(item: OutputFile, cursor: Cursor): boolean {
  if (item.createdAt !== cursor.createdAt) return compareText(item.createdAt, cursor.createdAt) < 0;
  if (item.runId !== cursor.runId) return compareText(item.runId, cursor.runId) < 0;
  return compareText(item.path, cursor.path) > 0;
}

/**
 * 倒序列出各版本本轮变化的文件（manifest 的 changed 项）。
 * 版本按 createdAt/runId 倒序，版本内按路径升序；游标包含版本与路径。
 */
export async function listOutputFiles(input: ListOutputFilesInput): Promise<OutputList> {
  if (!Number.isInteger(input.limit) || input.limit < 1) {
    fail('INVALID_INPUT', 'limit 必须是正整数', { path: '/limit' });
  }
  const cursor = input.before === undefined ? null : decodeCursor(input.before);
  let cursorFound = cursor === null;

  const items: OutputFile[] = [];
  for (const { manifest } of await publishedVersions(input)) {
    if (input.runId !== undefined && manifest.runId !== input.runId) continue;
    const changed = manifest.files
      .filter((file) => file.changed)
      .map((file) => fileOf(manifest, file))
      .sort((a, b) => compareText(a.path, b.path));
    for (const item of changed) {
      if (cursor !== null) {
        if (
          item.createdAt === cursor.createdAt &&
          item.runId === cursor.runId &&
          item.path === cursor.path
        ) {
          cursorFound = true;
          continue;
        }
        if (!afterCursor(item, cursor)) continue;
      }
      items.push(item);
    }
  }
  if (!cursorFound) {
    fail('INVALID_INPUT', INVALID_CURSOR_MESSAGE, { path: '/cursor' });
  }

  const page = items.slice(0, input.limit);
  const last = page.at(-1);
  const nextCursor = last !== undefined && items.length > page.length ? encodeCursor(last) : null;
  return { items: page, nextCursor };
}

interface ReadOutputFileInput {
  root: string;
  slug: string;
  conversationId: string;
  runId: string;
  path: string;
}

/** 只读 manifest 成员；返回原始字节，二进制与文本共用同一路径。 */
export async function readOutputFile(
  input: ReadOutputFileInput,
): Promise<{ file: OutputFile; data: Buffer }> {
  const conversationRoot = await trustedPath(input, conversationSegments(input), 'conversationId');
  const runId = runIdOf(input.runId);
  const path = safePath(input.path);
  const manifest = await loadManifest(input, runId);
  if (manifest === null) fail('NOT_FOUND', '产出快照不存在', { path: `/${runId}` });
  const entry = manifest.files.find((file) => file.path === path);
  if (entry === undefined) fail('NOT_FOUND', '产出文件不存在', { path: `/${path}` });

  const full = join(conversationRoot, RUNS, runId, FILES, ...path.split('/'));
  return { file: fileOf(manifest, entry), data: await readRegularFile(input, full, path) };
}

interface CopyConversationOutputsInput {
  root: string;
  slug: string;
  sourceConversationId: string;
  targetConversationId: string;
  /** 旧消息 id → 分支消息 id；两个锚点都在其中才属于 fork 历史边界。 */
  messageIds: Record<string, string>;
}

/**
 * fork 时复制历史边界内的快照：两个锚点都被映射的版本才复制，
 * 并重写为分支的消息 id；runId 原样保留作为来源记录。
 */
export async function copyConversationOutputs(input: CopyConversationOutputsInput): Promise<void> {
  const sourceIdentity = {
    root: input.root,
    slug: input.slug,
    conversationId: input.sourceConversationId,
  };
  const targetIdentity = {
    root: input.root,
    slug: input.slug,
    conversationId: input.targetConversationId,
  };
  const sourceRoot = await trustedPath(
    sourceIdentity,
    conversationSegments(sourceIdentity),
    'sourceConversationId',
  );
  const targetRoot = await trustedPath(
    targetIdentity,
    conversationSegments(targetIdentity),
    'targetConversationId',
  );
  if (sourceRoot === targetRoot) return;

  for (const { runId, manifest } of await publishedVersions(sourceIdentity)) {
    const userMessageId = input.messageIds[manifest.userMessageId];
    const afterMessageId = input.messageIds[manifest.afterMessageId];
    if (userMessageId === undefined || afterMessageId === undefined) continue;

    const targetRun = await trustedPath(
      targetIdentity,
      [...conversationSegments(targetIdentity), RUNS, runId],
      runId,
    );
    const exists = await lstat(targetRun).catch((error: unknown) => {
      if (hasErrorCode(error, 'ENOENT')) return null;
      throw error;
    });
    if (exists !== null) continue;

    const remapped = outputManifestSchema.parse({
      ...manifest,
      userMessageId,
      afterMessageId,
    });
    await mkdir(join(targetRoot, RUNS), { recursive: true });
    const staging = join(targetRoot, RUNS, `.tmp-${runId}-${randomUUID()}`);
    try {
      await mkdir(join(staging, FILES), { recursive: true });
      await copySnapshot(sourceIdentity, manifest, join(staging, FILES));
      await writeFile(join(staging, MANIFEST), `${JSON.stringify(remapped, null, 2)}\n`);
      await rename(staging, targetRun);
    } catch (error) {
      await removeQuietly(staging);
      throw error;
    }
  }
}

interface RemoveConversationOutputsInput {
  root: string;
  slug: string;
  conversationId: string;
}

/** 会话/专家删除时清理全部草稿与快照；重复调用无副作用。 */
export async function removeConversationOutputs(
  input: RemoveConversationOutputsInput,
): Promise<void> {
  await removeQuietly(await trustedPath(input, conversationSegments(input), 'conversationId'));
}
