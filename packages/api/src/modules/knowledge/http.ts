import { AppError } from '@agentport/core';
import { repo } from '@agentport/db';
import { zipSync } from 'fflate';
import type { Hono } from 'hono';
import { z } from 'zod';
import { attachmentResponse } from '../../http/attachment.js';
import { requestBodyLimit } from '../../http/body-limit.js';
import type { HttpContext, HttpEnv } from '../../http/context.js';
import { requestContext } from '../../http/context.js';
import { access } from '../../http/middleware.js';
import { requireTrustedOrigin } from '../auth/origin.js';
import { authorizeBase, authorizeVersion } from './access.js';
import { FAQ_MAX_BYTES } from './faq.js';
import { KNOWLEDGE_PACKAGE_MAX_BYTES } from './package.js';
import * as useCases from './use-cases.js';
import { depsOf, KNOWLEDGE_UPLOAD_BODY_LIMIT } from './use-cases.js';

const BATCH_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
const WINDOWS_RESERVED_ZIP_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const batchDownloadBodySchema = z.object({
  documentIds: z
    .array(z.string().min(1).max(128))
    .min(1)
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length, 'documentIds 不能重复'),
});

function safeZipName(filename: string): string {
  const cleaned = [...filename]
    .map((character) =>
      character === '/' || character === '\\' || (character.codePointAt(0) ?? 0) < 0x20
        ? '_'
        : character,
    )
    .join('')
    .trim();
  const name = cleaned.length > 0 ? cleaned : 'document';
  if (name === '.' || name === '..') return 'document';
  if (name === '__proto__') return '___proto__';
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return WINDOWS_RESERVED_ZIP_NAME.test(stem) ? `_${name}` : name;
}

function uniqueZipName(filename: string, usedLower: Set<string>): string {
  const name = safeZipName(filename);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  for (let index = 1; usedLower.has(candidate.toLowerCase()); index += 1) {
    candidate = `${stem} (${index})${extension}`;
  }
  usedLower.add(candidate.toLowerCase());
  return candidate;
}

function param(c: HttpContext, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || value.length === 0) {
    throw new AppError('INVALID_INPUT', '缺少路径参数');
  }
  return value;
}

export function registerKnowledgeHttp(app: Hono<HttpEnv>): void {
  app.on(
    'PUT',
    '/api/knowledge/bases/:id/documents/upload',
    requestBodyLimit(KNOWLEDGE_UPLOAD_BODY_LIMIT),
  );
  app.on(
    'POST',
    '/api/knowledge/bases/:id/faqs/import',
    requestBodyLimit(FAQ_MAX_BYTES * 8 + 1024),
  );
  app.on('POST', '/api/knowledge/bases/import', requestBodyLimit(KNOWLEDGE_PACKAGE_MAX_BYTES));
  app.on('POST', '/api/knowledge/bases/:id/documents/download', requestBodyLimit(64 * 1024));
  app.get(
    '/api/knowledge/versions/:versionId/images/:name',
    access({ kind: 'permission', permissionId: 'knowledge.read' }),
    async (c) => {
      const context = requestContext(c);
      const versionId = param(c, 'versionId');
      await authorizeVersion(context, versionId, 'knowledge.read', 'read');
      const name = param(c, 'name');
      const image = await useCases.getVersionImage(depsOf(context), versionId, name);
      const response = attachmentResponse(new Uint8Array(image.data), name, image.mimeType);
      response.headers.set('cache-control', 'private');
      return response;
    },
  );

  app.get(
    '/api/knowledge/versions/:versionId/content',
    access({ kind: 'permission', permissionId: 'knowledge.read' }),
    async (c) => {
      const context = requestContext(c);
      const versionId = param(c, 'versionId');
      await authorizeVersion(context, versionId, 'knowledge.read', 'read');
      const content = await useCases.getVersionContent(depsOf(context), versionId);
      return attachmentResponse(new Uint8Array(content.data), content.filename, content.mimeType);
    },
  );

  app.get(
    '/api/knowledge/versions/:versionId/markdown',
    access({ kind: 'permission', permissionId: 'knowledge.read' }),
    async (c) => {
      const context = requestContext(c);
      const versionId = param(c, 'versionId');
      await authorizeVersion(context, versionId, 'knowledge.read', 'read');
      const markdown = await useCases.getVersionMarkdown(depsOf(context), versionId);
      return new Response(markdown.markdown, {
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'x-knowledge-document-status': markdown.status,
        },
      });
    },
  );

  app.get(
    '/api/knowledge/bases/:id/export',
    access({ kind: 'permission', permissionId: 'knowledge.export' }),
    async (c) => {
      const context = requestContext(c);
      const id = param(c, 'id');
      await authorizeBase(context, id, 'knowledge.export', 'read');

      const pkg = await useCases.exportPackage(depsOf(context), id);
      return attachmentResponse(new Uint8Array(pkg.body), pkg.filename, 'application/zip');
    },
  );

  app.post(
    '/api/knowledge/bases/:id/documents/download',
    access({ kind: 'permission', permissionId: 'knowledge.read' }),
    async (c) => {
      const context = requestContext(c);
      requireTrustedOrigin(context);
      const id = param(c, 'id');
      await authorizeBase(context, id, 'knowledge.read', 'read');

      const parsed = batchDownloadBodySchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new AppError('INVALID_INPUT', 'documentIds 需包含 1-200 个不重复的文档 ID');
      }
      const base = await repo.knowledge.getBase(context.db, id);
      if (!base) throw new AppError('NOT_FOUND', '知识库不存在，可能已被删除；请刷新后重试');

      const downloadable: Array<{ versionId: string }> = [];
      let declaredBytes = 0;
      for (const documentId of parsed.data.documentIds) {
        const document = await repo.knowledge.getDocument(context.db, documentId);
        if (!document || document.baseId !== id) {
          throw new AppError('NOT_FOUND', '文档不存在或不属于该知识库');
        }
        if (!document.currentVersionId) continue;
        if (document.status === 'disabled' || document.disabledReason !== null) continue;
        const version = await repo.knowledge.getVersion(context.db, document.currentVersionId);
        if (!version) continue;
        declaredBytes += version.sizeBytes;
        downloadable.push({ versionId: document.currentVersionId });
      }
      if (downloadable.length === 0) {
        throw new AppError('INVALID_INPUT', '所选文档没有可下载的原件');
      }
      if (declaredBytes > BATCH_DOWNLOAD_MAX_BYTES) {
        throw new AppError('PAYLOAD_TOO_LARGE', '所选文档原件合计超过 64MiB 上限');
      }

      // shortcut: ZIP 仍同步在内存中构建（与知识库包导出一致）；单批体积增长时改用流式。
      const deps = depsOf(context);
      const entries: Record<string, Uint8Array> = Object.create(null);
      const usedLower = new Set<string>();
      let actualBytes = 0;
      for (const item of downloadable) {
        const content = await useCases.getVersionContent(deps, item.versionId);
        actualBytes += content.data.length;
        if (actualBytes > BATCH_DOWNLOAD_MAX_BYTES) {
          throw new AppError('PAYLOAD_TOO_LARGE', '所选文档原件合计超过 64MiB 上限');
        }
        entries[uniqueZipName(content.filename, usedLower)] = new Uint8Array(content.data);
      }
      return attachmentResponse(
        zipSync(entries, { level: 6 }),
        `${base.slug}-documents.zip`,
        'application/zip',
      );
    },
  );

  app.post(
    '/api/knowledge/bases/import',
    access({ kind: 'permission', permissionId: 'knowledge.import' }),
    async (c) => {
      const context = requestContext(c);
      requireTrustedOrigin(context);
      const body = Buffer.from(await c.req.arrayBuffer());
      const result = await useCases.importPackage(depsOf(context), body);
      return new Response(JSON.stringify(result), {
        status: 201,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  );

  app.get(
    '/api/knowledge/bases/:id/faqs/export',
    access({ kind: 'permission', permissionId: 'knowledge.export' }),
    async (c) => {
      const context = requestContext(c);
      const id = param(c, 'id');
      await authorizeBase(context, id, 'knowledge.export', 'read');

      const format = c.req.query('format') === 'csv' ? 'csv' : 'json';
      const version = c.req.query('version') === 'draft' ? 'draft' : 'published';
      const exported = await useCases.exportFaqs(depsOf(context), id, {
        format,
        version,
      });
      return attachmentResponse(exported.content, exported.filename, exported.contentType);
    },
  );
}
