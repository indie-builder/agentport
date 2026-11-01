import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repo } from '@agentport/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';

/**
 * 图片名必须是 `images/` 下的单段文件名：拒绝 `/`、`\`、`.`/`..` 与控制字符，
 * 与知识包导入的白名单一致；磁盘路径只由库内 versions.images 拼出，绝不按 URL 原文读取。
 */
const imageNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (name) =>
      name !== '.' &&
      name !== '..' &&
      !name.includes('/') &&
      !name.includes('\\') &&
      ![...name].some((character) => (character.codePointAt(0) ?? 0) < 0x20),
    '图片名不合法',
  );

const imageParams = z.object({ versionId: z.string().min(1), name: imageNameSchema });
const versionParams = z.object({ versionId: z.string().min(1) });

/** 白名单里的 mimeType 直接进响应头，先挡掉换行与非常规值。 */
function safeImageMime(mimeType: string): string {
  return /^image\/[a-z0-9][a-z0-9.+-]*$/i.test(mimeType) ? mimeType : 'application/octet-stream';
}

export function registerKnowledgeImageRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);

  app.get(
    '/api/knowledge/versions/:versionId/images/:name',
    {
      config: { access: { kind: 'permission', permissionId: 'knowledge.read' } },
      schema: { params: imageParams },
    },
    async (request, reply) => {
      const version = await repo.knowledge.getVersion(app.db, request.params.versionId);
      if (!version) return reject(reply, 'NOT_FOUND', '版本不存在，可能已被删除');
      const image = version.images.find((entry) => entry.name === request.params.name);
      if (!image) return reject(reply, 'NOT_FOUND', '图片不存在或不属于该版本');
      const data = await readFile(
        join(
          app.config.KNOWLEDGE_DIR,
          'docs',
          version.documentId,
          version.id,
          'images',
          image.name,
        ),
      ).catch(() => null);
      if (!data) return reject(reply, 'NOT_FOUND', '图片文件缺失，请重新解析该版本');
      return reply
        .header('Content-Type', safeImageMime(image.mimeType))
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private')
        .send(data);
    },
  );

  // 版本详情只返回 UI 展示所需的安全元数据，不含 blob 地址与磁盘路径。
  app.get(
    '/api/knowledge/versions/:versionId/details',
    {
      config: { access: { kind: 'permission', permissionId: 'knowledge.read' } },
      schema: { params: versionParams },
    },
    async (request, reply) => {
      const version = await repo.knowledge.getVersion(app.db, request.params.versionId);
      if (!version) return reject(reply, 'NOT_FOUND', '版本不存在，可能已被删除');
      return {
        id: version.id,
        documentId: version.documentId,
        version: version.version,
        originalFilename: version.originalFilename,
        mimeType: version.mimeType,
        sizeBytes: version.sizeBytes,
        sourceRevision: version.sourceRevision,
        parseStatus: version.parseStatus,
        pageMap: version.pageMap,
        images: version.images,
        createdAt: version.createdAt.toISOString(),
      };
    },
  );
}
