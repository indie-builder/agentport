import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { AppError, fail, isAppError } from '@agentport/core';
import { repo, schema } from '@agentport/db';
import { eq } from 'drizzle-orm';
import { assertSafeUrl } from '../../servers/ssrf.js';
import { createJob, documentWire, enqueueKnowledgeJob, storeBlob } from '../service.js';
import {
  type KnowledgeDeps,
  notFound,
  type DocumentRow,
  assertBodyBytes,
  enqueue,
  folderIssue,
  fileTitle,
} from './shared.js';

const URL_FETCH_TIMEOUT_MS = 20_000;

const MAX_URL_BYTES = 32 * 1024 * 1024;

const MANUAL_BODY_LIMIT = 2 * 1024 * 1024;

const ACCEPTED_TYPES: Record<string, string> = {
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/x-markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
};

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function fetchSource(rawUrl: string): Promise<{
  data: Buffer;
  mimeType: string;
  filename: string;
}> {
  let response: Response;
  try {
    response = await fetch(rawUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
      headers: {
        'user-agent': 'agentport-knowledge-url/1.0',
        accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5',
      },
    });
  } catch (err) {
    return fail('UPSTREAM_FAILED', '抓取目标地址失败，请确认地址可访问后重试', {
      cause: err,
      retryable: true,
    });
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    fail('INVALID_URL', '目标地址返回重定向；请直接填写最终地址');
  }
  if (!response.ok) {
    await response.body?.cancel();
    fail('UPSTREAM_FAILED', `目标地址返回 HTTP ${response.status}`, {
      retryable: response.status >= 500,
    });
  }
  const mimeType =
    (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const extension = ACCEPTED_TYPES[mimeType];
  if (extension === undefined) {
    await response.body?.cancel();
    fail(
      'UNSUPPORTED_MEDIA_TYPE',
      `不支持的类型 ${mimeType || '(未声明)'}；仅支持网页、PDF 与纯文本类文件`,
    );
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_URL_BYTES) {
    await response.body?.cancel();
    fail('PAYLOAD_TOO_LARGE', '目标文件超过 32MiB 上限');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > MAX_URL_BYTES) {
        fail('PAYLOAD_TOO_LARGE', '目标文件超过 32MiB 上限');
      }
      chunks.push(Buffer.from(chunk));
    }
  }
  const data = Buffer.concat(chunks);
  if (data.length === 0) fail('UPSTREAM_FAILED', '目标地址返回空内容');
  const path = new URL(rawUrl).pathname;
  const rawName = basename(path);
  const name = rawName.length > 0 && rawName !== '/' ? safeDecode(rawName) : 'index';
  const filename = extname(name) === '' ? `${name}.${extension}` : name;
  return { data, mimeType, filename };
}

// ---- manual documents -----------------------------------------------------

async function manualDocument(deps: KnowledgeDeps, documentId: string) {
  const document = await repo.knowledge.getDocument(deps.db, documentId);
  if (!document) notFound('文档');
  if (document.sourceType !== 'manual' || document.contentKind !== 'document') {
    throw new AppError('INVALID_INPUT', '只有手写文档可以编辑正文');
  }
  return document;
}

async function readVersionContent(
  deps: KnowledgeDeps,
  documentId: string,
  versionId: string,
): Promise<string | null> {
  return readFile(
    join(deps.config.KNOWLEDGE_DIR, 'docs', documentId, versionId, 'markdown.md'),
    'utf8',
  ).catch(() => null);
}

function pendingDraftVersion(
  document: DocumentRow,
  versions: Awaited<ReturnType<typeof repo.knowledge.listDocumentVersions>>['items'],
) {
  return (
    versions.find(
      (row) => row.metadata.publication === 'draft' && row.id !== document.currentVersionId,
    ) ?? null
  );
}

export async function getManualDocument(deps: KnowledgeDeps, documentId: string) {
  const document = await manualDocument(deps, documentId);
  const versions = await repo.knowledge.listDocumentVersions(deps.db, document.id, { limit: 200 });
  const draft = pendingDraftVersion(document, versions.items);
  if (draft) {
    const content = await readVersionContent(deps, document.id, draft.id);
    if (content === null) throw new AppError('NOT_FOUND', '草稿正文缺失，请重新保存');
    return { content, versionId: draft.id, status: 'draft' as const };
  }
  if (!document.currentVersionId) {
    throw new AppError('CONFLICT', '文档还没有可编辑的正文');
  }
  const content = await readVersionContent(deps, document.id, document.currentVersionId);
  if (content === null) throw new AppError('NOT_FOUND', '正文文件缺失，请重新解析该版本');
  return { content, versionId: document.currentVersionId, status: 'published' as const };
}

export async function saveManualDraft(
  deps: KnowledgeDeps,
  documentId: string,
  body: { content: string; expectedVersionId: string },
) {
  const document = await manualDocument(deps, documentId);
  const base = await repo.knowledge.getBase(deps.db, document.baseId);
  if (!base) notFound('知识库');
  assertBodyBytes(body.content, MANUAL_BODY_LIMIT);
  const versions = await repo.knowledge.listDocumentVersions(deps.db, document.id, { limit: 200 });
  const draft = pendingDraftVersion(document, versions.items);
  const editableVersionId = draft?.id ?? document.currentVersionId;
  if (!editableVersionId || body.expectedVersionId !== editableVersionId) {
    throw new AppError('CONFLICT_STALE', '正文已被修改，请刷新后重试');
  }
  const sha = await storeBlob(deps.config.KNOWLEDGE_DIR, Buffer.from(body.content, 'utf8'));
  const filename =
    typeof document.metadata.originalFilename === 'string'
      ? document.metadata.originalFilename
      : `${document.title}.md`;
  const job = await deps.db.transaction((tx) =>
    createJob(tx, {
      baseId: base.id,
      documentId: document.id,
      payload: {
        type: 'ingest',
        documentId: document.id,
        publish: 'draft',
        input: {
          blobSha256: sha,
          filename,
          mimeType: document.mimeType,
          expectedCurrentVersionId: document.currentVersionId,
        },
      },
    }),
  );
  try {
    await enqueueKnowledgeJob(job);
    await repo.audit.writeAudit(deps.db, deps.log, {
      actor: deps.actor,
      action: 'knowledge.document.manual_draft_saved',
      target: document.id,
      input: { versionId: body.expectedVersionId },
      status: 'ok',
      requestId: deps.requestId,
    });
    return { documentId: document.id, jobId: job.id };
  } catch (err) {
    await deps.db.delete(schema.knowledgeJobs).where(eq(schema.knowledgeJobs.id, job.id));
    if (isAppError(err)) throw err;
    fail('SERVICE_UNAVAILABLE', '草案任务未能提交，请稍后重试', {
      cause: err,
      retryable: true,
    });
  }
}

async function tagNames(deps: KnowledgeDeps, documentId: string): Promise<string[]> {
  return (await repo.knowledge.getDocumentTagNames(deps.db, [documentId])).get(documentId) ?? [];
}

export async function publishManualDocument(
  deps: KnowledgeDeps,
  documentId: string,
  body: { versionId: string; expectedVersionId: string | null },
) {
  const document = await manualDocument(deps, documentId);
  const version = await repo.knowledge.getVersion(deps.db, body.versionId);
  if (!version || version.documentId !== document.id) {
    throw new AppError('NOT_FOUND', '版本不存在或不属于该文档');
  }
  const row = await repo.knowledge.activateDocumentVersion(deps.db, {
    documentId: document.id,
    versionId: version.id,
    expectedVersionId: body.expectedVersionId,
  });
  const published =
    row.status === 'ready' && row.disabledReason === null
      ? row
      : await repo.knowledge.updateDocument(deps.db, row.id, {
          status: 'ready',
          disabledReason: null,
        });
  return documentWire(published ?? row, await tagNames(deps, published?.id ?? row.id));
}

async function importDocument(
  deps: KnowledgeDeps,
  input: {
    baseId: string;
    folderId: string | null;
    title: string;
    sourceType: 'manual' | 'url';
    sourceUrl: string | null;
    mimeType: string;
    originalFilename: string;
    data: Buffer;
    tags: string[];
    publish?: 'draft' | 'automatic' | undefined;
  },
) {
  const sha = await storeBlob(deps.config.KNOWLEDGE_DIR, input.data);
  const document = await repo.knowledge.createDocument(deps.db, {
    baseId: input.baseId,
    folderId: input.folderId,
    title: input.title,
    sourceType: input.sourceType,
    sourceId: null,
    sourceUrl: input.sourceUrl,
    sourcePath: null,
    mimeType: input.mimeType,
    sizeBytes: input.data.length,
    metadata: { originalFilename: input.originalFilename },
  });
  try {
    await repo.knowledge.updateDocument(deps.db, document.id, { contentHash: sha });
    if (input.tags.length > 0) {
      const rows = await repo.knowledge.upsertTags(deps.db, input.baseId, input.tags);
      await repo.knowledge.setDocumentTags(
        deps.db,
        document.id,
        rows.map((tag) => tag.id),
      );
    }
    const job = await enqueue(
      deps,
      {
        type: 'ingest',
        documentId: document.id,
        publish: input.publish ?? 'automatic',
        input: {
          blobSha256: sha,
          filename: input.originalFilename,
          mimeType: input.mimeType,
          expectedCurrentVersionId: null,
        },
      },
      { baseId: input.baseId, documentId: document.id },
    );
    await repo.audit.writeAudit(deps.db, deps.log, {
      actor: deps.actor,
      action: `knowledge.document.${input.sourceType}_imported`,
      target: document.id,
      input: {
        sourceType: input.sourceType,
        sourceUrl: input.sourceUrl,
        sizeBytes: input.data.length,
      },
      status: 'ok',
      requestId: deps.requestId,
    });
    return { documentId: document.id, jobId: job.id };
  } catch (err) {
    await repo.knowledge.deleteDocument(deps.db, document.id).catch(() => undefined);
    if (isAppError(err)) throw err;
    fail('SERVICE_UNAVAILABLE', '导入任务未能提交，请稍后重试', { cause: err, retryable: true });
  }
}

async function loadActiveBase(deps: KnowledgeDeps, id: string) {
  const base = await repo.knowledge.getBase(deps.db, id);
  if (!base) notFound('知识库');
  if (base.status !== 'active') throw new AppError('CONFLICT', '知识库已禁用，启用后再导入');
  return base;
}

export async function createManualDocument(
  deps: KnowledgeDeps,
  id: string,
  body: {
    title: string;
    content: string;
    folderId: string | null;
    tags: string[];
  },
) {
  const base = await loadActiveBase(deps, id);
  if (await folderIssue(deps, base.id, body.folderId)) {
    throw new AppError('INVALID_INPUT', '文件夹不存在或属于其他知识库');
  }
  assertBodyBytes(body.content, MANUAL_BODY_LIMIT);
  return importDocument(deps, {
    baseId: base.id,
    folderId: body.folderId,
    title: body.title,
    sourceType: 'manual',
    sourceUrl: null,
    mimeType: 'text/markdown',
    originalFilename: `${body.title.replace(/[/\\]/g, '-')}.md`,
    data: Buffer.from(body.content, 'utf8'),
    tags: body.tags,
    publish: 'draft',
  });
}

export async function createUrlDocument(
  deps: KnowledgeDeps,
  id: string,
  body: { url: string; title?: string | undefined; folderId: string | null },
) {
  const base = await loadActiveBase(deps, id);
  if (await folderIssue(deps, base.id, body.folderId)) {
    throw new AppError('INVALID_INPUT', '文件夹不存在或属于其他知识库');
  }
  const sourceUrl = new URL(body.url).href;
  await assertSafeUrl(sourceUrl, deps.config.NODE_ENV);
  const fetched = await fetchSource(sourceUrl);
  return importDocument(deps, {
    baseId: base.id,
    folderId: body.folderId,
    title: body.title ?? fileTitle(fetched.filename),
    sourceType: 'url',
    sourceUrl,
    mimeType: fetched.mimeType,
    originalFilename: fetched.filename,
    data: fetched.data,
    tags: [],
  });
}
