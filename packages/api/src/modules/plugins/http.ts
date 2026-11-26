import { fail, NOT_FOUND_MESSAGES } from '@agentport/core';
import { repo } from '@agentport/db';
import { idParams } from '@agentport/shared';
import type { Hono } from 'hono';
import { actorOf, authorizeResourceAccess, requireUser } from '../../http/access.js';
import { attachmentResponse } from '../../http/attachment.js';
import { requestBodyLimit } from '../../http/body-limit.js';
import type { HttpEnv } from '../../http/context.js';
import { requestContext } from '../../http/context.js';
import { isPgCode } from '../../http/errors.js';
import { access } from '../../http/middleware.js';
import { PLUGIN_ZIP_MAX_BYTES, pluginImportQuerySchema } from '../../http/native-schemas.js';
import { encodePackageEntries, readZipUpload } from '../../lib/package-zip.js';
import { toApi, toPluginWrite } from './api.js';
import { parsePluginFiles } from './parse.js';

export function registerPluginsHttp(app: Hono<HttpEnv>): void {
  app.post(
    '/api/plugins/import',
    access({ kind: 'permission', permissionId: 'plugins.import' }),
    requestBodyLimit(PLUGIN_ZIP_MAX_BYTES),
    async (c) => {
      const context = requestContext(c);
      const entries = await readZipUpload(c.req.raw, '插件包无法解析');
      const query = pluginImportQuerySchema.parse(c.req.query());
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
          toPluginWrite(input, undefined, requireUser(context).businessId),
          files,
        );
        await repo.audit.writeAudit(context.db, context.log, {
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
      if (!row) fail('NOT_FOUND', NOT_FOUND_MESSAGES.plugin);
      await authorizeResourceAccess(
        context,
        'plugins.export',
        { kind: 'plugin', resourceId: row.id, ownerBusinessId: row.ownerBusinessId, level: 'read' },
        NOT_FOUND_MESSAGES.plugin,
      );
      const files = await repo.plugins.listPluginFiles(context.db, row.id);
      return attachmentResponse(
        new Uint8Array(encodePackageEntries(files)),
        `${row.slug}.zip`,
        'application/zip',
      );
    },
  );
}
