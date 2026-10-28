import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import {
  type OutputFile,
  type OutputList,
  type OutputManifest,
  type OutputStatus,
  outputManifestSchema,
  outputOwnerIdSchema,
  outputPathSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { fail } from './errors.js';

/**
 * 会话运行产出的单一存储实现。
 *
 * `WORKSPACES_DIR/<slug>/conversation-outputs/<conversationId>/`
 *   `drafts/<runId>/`  本轮可写草稿（沙盒唯一可写挂载）
 *   `runs/<runId>/`    已发布不可变快照：`manifest.json` + `files/**`
 *
 * 草稿旁的 `drafts/<runId>.base` 记录本轮从哪一版复制而来：publish 用它判断
 * changed 与「无变化不重复发布」。放在挂载目录之外，沙盒无法改写。
 */

const CONVERSATION_OUTPUTS = 'conversation-outputs';
const DRAFTS = 'drafts';
const RUNS = 'runs';
const FILES = 'files';
const MANIFEST = 'manifest.json';

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

const slugPattern = /^[a-z0-9][a-z0-9_-]*$/;

function ownerId(value: string, field: string): string {
  if (!outputOwnerIdSchema.safeParse(value).success) {
    fail('INVALID_INPUT', `${field} 不能用作产出目录名`, { path: `/${field}` });
  }
  return value;
}

function conversationSegments(input: { slug: string; conversationId: string }): string[] {
  if (!slugPattern.test(input.slug)) fail('INVALID_INPUT', '智能体目录名非法', { path: '/slug' });
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

/**
 * 逻辑路径是配置根下的同一组相对段（worker 据此换算挂载路径）；
 * 校验以配置根的物理路径为信任起点：访问路径上每个已存在组件都不能是符号链接，
 * 且 realpath 仍在根内。只检查最终文件挡不住中间目录软链到外部。
 * 缺失的尾部组件由调用方创建，更深的组件此时不可能存在。
 */
async function trustedPath(
  identity: ConversationIdentity,
  segments: string[],
  label: string,
): Promise<string> {
  const logicalRoot = resolve(identity.root);
  const physicalRoot = await realpath(logicalRoot).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT'))
      return fail('NOT_FOUND', '产出根目录不存在', { path: `/${label}` });
    throw error;
  });
  let physical = physicalRoot;
  for (const segment of segments) {
    physical = join(physical, segment);
    const info = await lstat(physical).catch((error: unknown) => {
      if (hasCode(error, 'ENOENT')) return null;
      throw error;
    });
    if (info === null) break;
    if (info.isSymbolicLink()) {
      fail('INVALID_INPUT', '产出路径不能经过符号链接', { path: `/${label}` });
    }
    const actual = await realpath(physical);
    if (actual !== physicalRoot && !actual.startsWith(`${physicalRoot}${sep}`)) {
      fail('INVALID_INPUT', '产出路径不能经过符号链接', { path: `/${label}` });
    }
  }
  return join(logicalRoot, ...segments);
}

function baseFileOf(conversationRoot: string, runId: string): string {
  return join(conversationRoot, DRAFTS, `${runId}.base`);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * 排序与游标必须用同一种比较：`localeCompare` 与代码单元比较对数字/大小写/非 ASCII 的
 * 结果不同，混用会让翻页漏项或重复。这里统一按代码单元。
 */
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
  };
}

/**
 * 快照文件只按 manifest 解析；损坏或手改的 manifest 一律拒绝，不猜内容。
 * 这是平台自己写出的索引，损坏属于服务端状态问题，不用 INVALID_INPUT 冒充调用方输入错误。
 */
async function loadManifest(
  identity: ConversationIdentity,
  runId: string,
): Promise<OutputManifest | null> {
  const full = await trustedPath(
    identity,
    [...conversationSegments(identity), RUNS, runIdOf(runId), MANIFEST],
    MANIFEST,
  );
  const info = await lstat(full).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  });
  if (info === null) return null;
  const raw = (await readRegularFile(identity, full, MANIFEST)).toString('utf8');
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

/** 已发布版本，最新在前：createdAt 相同（同毫秒）时用 runId 稳定排序。 */
async function publishedVersions(
  identity: ConversationIdentity,
): Promise<Array<{ runId: string; manifest: OutputManifest }>> {
  const runsDir = await trustedPath(identity, [...conversationSegments(identity), RUNS], RUNS);
  const entries = await readdir(runsDir, { withFileTypes: true }).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT')) return [];
    throw error;
  });
  const versions: Array<{ runId: string; manifest: OutputManifest }> = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) {
      fail('INVALID_INPUT', '产出路径不能经过符号链接', { path: `/${entry.name}` });
    }
    if (!entry.isDirectory()) continue;
    const manifest = await loadManifest(identity, entry.name);
    if (manifest !== null) versions.push({ runId: entry.name, manifest });
  }
  versions.sort(
    (a, b) =>
      compareText(b.manifest.createdAt, a.manifest.createdAt) || compareText(b.runId, a.runId),
  );
  return versions;
}

async function latestVersion(identity: ConversationIdentity): Promise<OutputManifest | null> {
  return (await publishedVersions(identity))[0]?.manifest ?? null;
}

/** 读一个普通文件；软/硬链接一律拒绝。 */
async function readRegularFile(
  identity: ConversationIdentity,
  full: string,
  path: string,
): Promise<Buffer> {
  await trustedPath(identity, relative(resolve(identity.root), full).split(sep), path);
  const info = await lstat(full).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT')) fail('NOT_FOUND', '产出文件不存在', { path: `/${path}` });
    throw error;
  });
  if (info.isSymbolicLink() || !info.isFile()) {
    fail('INVALID_INPUT', '产出文件不是普通文件', { path: `/${path}` });
  }
  if (info.nlink !== 1) fail('INVALID_INPUT', '产出文件不允许硬链接', { path: `/${path}` });
  return readFile(full);
}

/** 列出草稿中的全部文件，路径按字典序，便于稳定 manifest。 */
async function draftEntries(
  identity: ConversationIdentity,
  dir: string,
  prefix = '',
): Promise<Array<{ path: string; data: Buffer }>> {
  await trustedPath(identity, relative(resolve(identity.root), dir).split(sep), 'draft');
  const entries = await readdir(dir, { withFileTypes: true });
  const files: Array<{ path: string; data: Buffer }> = [];
  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await draftEntries(identity, full, path)));
      continue;
    }
    const safe = safePath(path);
    files.push({ path: safe, data: await readRegularFile(identity, full, safe) });
  }
  return files.sort((a, b) => compareText(a.path, b.path));
}

/** 复制快照内容，只按 manifest 成员读取，快照目录里多出来的东西不进入草稿。 */
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

/** 草稿与它的基线记录一起丢弃；重复调用无副作用。 */
async function discardDraft(conversationRoot: string, runId: string): Promise<void> {
  await removeQuietly(join(conversationRoot, DRAFTS, runId));
  await removeQuietly(baseFileOf(conversationRoot, runId));
}

export interface OutputDraftIdentity extends ConversationIdentity {
  runId: string;
}

/** 标记放在挂载目录之外，BullMQ 重试复用草稿时仍能看到未停稳状态。 */
export async function setOutputDraftBlocked(
  input: OutputDraftIdentity,
  problem: string | null,
): Promise<void> {
  const path = await trustedPath(
    input,
    [...conversationSegments(input), DRAFTS, `${runIdOf(input.runId)}.blocked`],
    'runId',
  );
  if (problem === null) {
    await rm(path, { force: true });
  } else {
    await mkdir(dirname(path), { recursive: true });
    const existing = await lstat(path).catch((error: unknown) => {
      if (hasCode(error, 'ENOENT')) return null;
      throw error;
    });
    if (existing !== null) await readRegularFile(input, path, 'blocked');
    await writeFile(path, problem);
  }
}

export async function outputDraftBlockedReason(input: OutputDraftIdentity): Promise<string | null> {
  const path = await trustedPath(
    input,
    [...conversationSegments(input), DRAFTS, `${runIdOf(input.runId)}.blocked`],
    'runId',
  );
  return readRegularFile(input, path, 'blocked')
    .then((data) => data.toString('utf8'))
    .catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'NOT_FOUND') return null;
      throw error;
    });
}

export interface PrepareOutputDraftInput {
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
    if (hasCode(error, 'ENOENT')) return null;
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

  // 先写临时目录再改名：半途失败的复制不会留下一个看起来可用的草稿。
  // 基线记录先落盘，避免出现「草稿在、基线丢」而被当成首版全量变化。
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
    // 只回收自己写的临时目录与基线标记，不动可能由别处建出的草稿。
    await removeQuietly(staging);
    await removeQuietly(baseFileOf(conversationRoot, runId));
    throw error;
  }
  return draftDir;
}

export interface PublishOutputSnapshotInput {
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
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  });
  // 本轮没有可写挂载或草稿已被处理：没有产出可发布。
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
    if (hasCode(error, 'ENOENT')) return null;
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
  const files = await draftEntries(input, draftDir);
  if (files.length === 0 && (base === null || base.files.length === 0)) {
    await discardDraft(conversationRoot, runId);
    return;
  }
  // 当前模型没有删除工具，不支持多文件中的单文件删除；空快照仍保存已清空的状态。
  const baseFiles = new Map(base?.files.map((file) => [file.path, file]) ?? []);
  const manifestFiles = files.map((file) => {
    const previous = baseFiles.get(file.path);
    const digest = sha256(file.data);
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

export interface ListOutputFilesInput {
  root: string;
  slug: string;
  conversationId: string;
  limit: number;
  /** 上一页返回的 `nextBefore`。 */
  before?: string;
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
  fail('INVALID_INPUT', '分页游标无效', { path: '/before' });
}

/** 游标之后（更旧）的项；同毫秒版本再按 runId、路径排序，不遗漏也不重复。 */
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

  const items: OutputFile[] = [];
  for (const { manifest } of await publishedVersions(input)) {
    const changed = manifest.files
      .filter((file) => file.changed)
      .map((file) => fileOf(manifest, file))
      .sort((a, b) => compareText(a.path, b.path));
    for (const item of changed) {
      if (cursor !== null && !afterCursor(item, cursor)) continue;
      items.push(item);
    }
  }

  const page = items.slice(0, input.limit);
  const last = page.at(-1);
  const nextBefore = last !== undefined && items.length > page.length ? encodeCursor(last) : null;
  return { items: page, nextBefore };
}

export interface ReadOutputFileInput {
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

export interface CopyConversationOutputsInput {
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
      if (hasCode(error, 'ENOENT')) return null;
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

export interface RemoveConversationOutputsInput {
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
