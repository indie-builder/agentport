import { fail } from '@agentport/core';
import { repo } from '@agentport/db';
import { idParams, slugSchema } from '@agentport/shared';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { actorOf } from '../../http/access.js';
import type { AppContext, HttpEnv } from '../../http/context.js';
import { requestContext } from '../../http/context.js';
import { isPgCode } from '../../http/errors.js';
import { access } from '../../http/middleware.js';
import { writeAudit } from '../../plugins/audit.js';
import {
  decodePackageEntries,
  encodePackageEntries,
  type PackageEntry,
} from '../agents/package-zip.js';
import { requireTrustedOrigin } from '../auth/origin.js';
import { toApi, toPluginWrite } from './api.js';
import { parsePluginFiles } from './parse.js';

const importQuerySchema = z.object({ slug: slugSchema }).strict();

export function registerPluginsHttp(app: Hono<HttpEnv>, _deps: AppContext): void {
  app.post(
    '/api/plugins/import',
    access({ kind: 'permission', permissionId: 'plugins.import' }),
    bodyLimit({
      maxSize: 4_194_304,
      onError: () => fail('PAYLOAD_TOO_LARGE', '请求体超出大小限制，请减少内容后重试'),
    }),
    async (c) => {
      const context = requestContext(c);
      requireTrustedOrigin(context);
      if (c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/zip')
        fail('UNSUPPORTED_MEDIA_TYPE', '不支持的 Content-Type，请使用 application/zip');
      const query = importQuerySchema.parse(c.req.query());
      let entries: Map<string, PackageEntry>;
      try {
        entries = decodePackageEntries(Buffer.from(await c.req.arrayBuffer()));
      } catch (error) {
        fail('INVALID_INPUT', error instanceof Error ? error.message : '插件包无法解析');
      }
      const parsed = parsePluginFiles({
        files: [...entries.entries()].map(([path, file]) => ({
          path,
          content: file.content,
          executable: file.executable,
        })),
        slug: query.slug,
      });
      const { files, ...input } = parsed.input;
      try {
        const row = await repo.plugins.createPluginWithFiles(
          context.db,
          toPluginWrite(input),
          files,
        );
        await writeAudit(context.db, context.log, {
          actor: actorOf(context),
          action: 'plugin.imported',
          target: row.id,
          input: { slug: row.slug, files: files.length },
          status: 'ok',
          requestId: context.requestId,
        });
        return c.json({ plugin: toApi(row, files), warnings: parsed.warnings }, 201);
      } catch (error) {
        if (isPgCode(error, '23505'))
          fail('CONFLICT', '已有同名插件，请换一个 slug 或先删除原插件');
        throw error;
      }
    },
  );

  app.get(
    '/api/plugins/:id/export',
    access({ kind: 'permission', permissionId: 'plugins.export' }),
    async (c) => {
      const context = requestContext(c);
      const { id } = idParams.parse(c.req.param());
      const row = await repo.plugins.getPlugin(context.db, id);
      if (!row) fail('NOT_FOUND', '插件不存在，可能已被删除；请刷新后重试');
      const files = await repo.plugins.listPluginFiles(context.db, row.id);
      return c.body(new Uint8Array(encodePackageEntries(files)), 200, {
        'content-disposition': `attachment; filename="${row.slug}.zip"`,
        'cache-control': 'no-store',
        'content-type': 'application/zip',
      });
    },
  );
}
