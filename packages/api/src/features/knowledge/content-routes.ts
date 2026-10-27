import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { fail, isAppError } from '@agentport/core';
import { repo } from '@agentport/db';
import { httpUrlSchema } from '@agentport/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import { assertSafeUrl } from '../servers/ssrf.js';
import { createJob, enqueueKnowledgeJob } from './service.js';

/** 手写正文上限与参考实现一致；再大应走文件上传。 */
const MAX_MANUAL_CHARS = 200_000;
const MANUAL_BODY_LIMIT = 2 * 1024 * 1024;

const URL_FETCH_TIMEOUT_MS = 20_000;
const MAX_URL_BYTES = 32 * 1024 * 1024;
/** 只接受 worker 解析链能直接处理的类型；其余在入口就拒绝，避免入队后才失败。 */
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

const baseParams = z.object({ id: z.string().min(1) });
const folderIdSchema = z.string().min(1).nullable().default(null);

const manualSchema = z.object({
  title: z.string().trim().min(1).max(300),
  content: z
    .string()
    .max(MAX_MANUAL_CHARS)
    .refine((value) => value.trim().length > 0, '正文不能为空'),
  folderId: folderIdSchema,
  tags: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
});

const urlSchema = z.object({
  url: httpUrlSchema,
  title: z.string().trim().min(1).max(300).optional(),
  folderId: folderIdSchema,
});

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 与 worker 同一布局：`blobs/<sha 前2位>/<sha>`，先写临时文件再原子 rename。 */
async function storeBlob(knowledgeDir: string, data: Buffer): Promise<string> {
  const sha = sha256(data);
  const target = join(knowledgeDir, 'blobs', sha.slice(0, 2), sha);
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, data);
  await rename(temp, target);
  return sha;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function titleFromFilename(filename: string): string {
  const withoutExtension = filename.replace(/\.[^.]+$/, '');
  return (withoutExtension.length > 0 ? withoutExtension : filename).slice(0, 300);
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

export function registerKnowledgeContentRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };

  const enqueue = async (documentId: string, baseId: string) => {
    const job = await createJob(app.db, {
      baseId,
      documentId,
      payload: { type: 'ingest', documentId },
    });
    await enqueueKnowledgeJob(job);
    return job;
  };

  const loadActiveBase = async (id: string, reply: FastifyReply) => {
    const base = await repo.knowledge.getBase(app.db, id);
    if (!base) {
      reject(reply, 'NOT_FOUND', '知识库不存在，可能已被删除');
      return null;
    }
    if (base.status !== 'active') {
      reject(reply, 'CONFLICT', '知识库已禁用，启用后再导入');
      return null;
    }
    return base;
  };

  const folderIssue = async (baseId: string, folderId: string | null): Promise<boolean> => {
    if (!folderId) return false;
    const folder = await repo.knowledge.getFolder(app.db, folderId);
    return !folder || folder.baseId !== baseId;
  };

  /** 建行、写 hash、打标签、入队任一步失败都不留半成品，也不返回 202。 */
  const importDocument = async (input: {
    baseId: string;
    folderId: string | null;
    title: string;
    sourceType: 'manual' | 'url';
    sourceUrl: string | null;
    mimeType: string;
    originalFilename: string;
    data: Buffer;
    tags: string[];
    requestId: string;
    log: FastifyInstance['log'];
  }) => {
    const sha = await storeBlob(app.config.KNOWLEDGE_DIR, input.data);
    const document = await repo.knowledge.createDocument(app.db, {
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
      await repo.knowledge.updateDocument(app.db, document.id, { contentHash: sha });
      if (input.tags.length > 0) {
        const rows = await repo.knowledge.upsertTags(app.db, input.baseId, input.tags);
        await repo.knowledge.setDocumentTags(
          app.db,
          document.id,
          rows.map((tag) => tag.id),
        );
      }
      const job = await enqueue(document.id, input.baseId);
      await writeAudit(app.db, input.log, {
        actor: 'admin',
        action: `knowledge.document.${input.sourceType}_imported`,
        target: document.id,
        input: {
          sourceType: input.sourceType,
          sourceUrl: input.sourceUrl,
          sizeBytes: input.data.length,
        },
        status: 'ok',
        requestId: input.requestId,
      });
      return { documentId: document.id, jobId: job.id };
    } catch (err) {
      await repo.knowledge.deleteDocument(app.db, document.id).catch(() => undefined);
      if (isAppError(err)) throw err;
      fail('SERVICE_UNAVAILABLE', '导入任务未能提交，请稍后重试', { cause: err, retryable: true });
    }
  };

  app.post(
    '/api/knowledge/bases/:id/documents/manual',
    { ...auth, bodyLimit: MANUAL_BODY_LIMIT, schema: { params: baseParams, body: manualSchema } },
    async (request, reply) => {
      const base = await loadActiveBase(request.params.id, reply);
      if (!base) return;
      if (await folderIssue(base.id, request.body.folderId)) {
        return reject(reply, 'INVALID_INPUT', '文件夹不存在或属于其他知识库');
      }
      const result = await importDocument({
        baseId: base.id,
        folderId: request.body.folderId,
        title: request.body.title,
        sourceType: 'manual',
        sourceUrl: null,
        mimeType: 'text/markdown',
        originalFilename: `${request.body.title.replace(/[/\\]/g, '-')}.md`,
        data: Buffer.from(request.body.content, 'utf8'),
        tags: request.body.tags,
        requestId: request.id,
        log: request.log,
      });
      return reply.status(202).send(result);
    },
  );

  app.post(
    '/api/knowledge/bases/:id/documents/url',
    { ...auth, schema: { params: baseParams, body: urlSchema } },
    async (request, reply) => {
      const base = await loadActiveBase(request.params.id, reply);
      if (!base) return;
      if (await folderIssue(base.id, request.body.folderId)) {
        return reject(reply, 'INVALID_INPUT', '文件夹不存在或属于其他知识库');
      }
      const sourceUrl = new URL(request.body.url).href;
      // DNS 在 fetch 时会重新解析；公网部署仍需网络层出站 allowlist 兜底重绑定。
      await assertSafeUrl(sourceUrl, app.config.NODE_ENV);
      const fetched = await fetchSource(sourceUrl);
      const result = await importDocument({
        baseId: base.id,
        folderId: request.body.folderId,
        title: request.body.title ?? titleFromFilename(fetched.filename),
        sourceType: 'url',
        sourceUrl,
        mimeType: fetched.mimeType,
        originalFilename: fetched.filename,
        data: fetched.data,
        tags: [],
        requestId: request.id,
        log: request.log,
      });
      return reply.status(202).send(result);
    },
  );
}
