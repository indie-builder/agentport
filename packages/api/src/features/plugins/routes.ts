import { repo as pluginRepo } from '@agentport/db';
import {
  idParams,
  type Plugin,
  type PluginInput,
  type PluginWithAgentCount,
  pluginInputSchema,
  slugSchema,
} from '@agentport/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { zipSync } from 'fflate';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { isPgCode, reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import { decodePackage } from '../agent-package-zip.js';
import { type PluginImportFile, parsePluginFiles } from './parse.js';

const repo = pluginRepo.plugins;

const patchSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(500).optional(),
  version: z.string().max(64).optional(),
  expectedUpdatedAt: z.iso.datetime().optional(),
});

function notFound(reply: FastifyReply) {
  return reject(reply, 'NOT_FOUND', '插件不存在，可能已被删除；请刷新后重试');
}

/** 共享契约的 capabilities 展开成平铺字段；仓储只认这些列。 */
function toPluginWrite(
  input: Omit<PluginInput, 'files'>,
): Parameters<typeof repo.createPluginWithFiles>[1] {
  return {
    slug: input.slug,
    runtimeName: input.runtimeName ?? input.slug,
    name: input.name,
    description: input.description,
    version: input.version,
    manifest: input.capabilities,
  };
}

function toApi(
  row: Awaited<ReturnType<typeof repo.getPlugin>> extends infer R ? NonNullable<R> : never,
  files: PluginImportFile[],
): Plugin {
  return {
    id: row.id,
    slug: row.slug,
    runtimeName: row.runtimeName,
    name: row.name,
    description: row.description,
    version: row.version,
    capabilities: pluginInputSchema.shape.capabilities.parse(row.manifest),
    files,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function registerPluginRoutes(rawApp: FastifyInstance): void {
  // ZIP 解析器由 import 路由统一注册（同一类型只能注册一次）；这里只复用。
  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };

  app.get('/api/plugins', auth, async () => {
    const rows = await repo.listPlugins(app.db);
    return rows.map(
      (row): PluginWithAgentCount => ({
        ...toApi(row, []),
        agentCount: row.agentCount,
      }),
    );
  });

  // 插件内容只经 ZIP 导入：单独「新建空插件」会造出永远不生效的记录，
  // 且会绕过导入阶段的组件白名单与 manifest 校验。
  // ZIP 导入：只解析与落库，不执行插件内的任何内容。
  app.post(
    '/api/plugins/import',
    {
      ...auth,
      // 解析器由 import 路由注册（上限 1 MiB），这里的 bodyLimit 决定单次请求能收多大。
      bodyLimit: 4_194_304,
      schema: {
        body: z.instanceof(Buffer).transform((buffer, ctx) => {
          try {
            return decodePackage(buffer);
          } catch (err) {
            const message = err instanceof Error ? err.message : '插件包无法解析';
            ctx.addIssue({ code: 'custom', path: [], message });
            return z.NEVER;
          }
        }),
        querystring: z.object({ slug: slugSchema }).strict(),
      },
    },
    async (request, reply) => {
      const files: PluginImportFile[] = [...request.body.entries()].map(([path, content]) => ({
        path,
        content,
        // shortcut: decodePackage 丢掉了 ZIP 的可执行位，这里按脚本扩展名推断；
        // 需要精确保留 mode 时改为从中央目录读外部属性。
        executable: /\.(sh|bash|py|js|mjs|cjs)$/.test(path),
      }));
      const parsed = parsePluginFiles({
        files,
        slug: request.query.slug,
      });
      const { files: parsedFiles, ...input } = parsed.input;
      try {
        const row = await repo.createPluginWithFiles(app.db, toPluginWrite(input), parsedFiles);
        await writeAudit(app.db, request.log, {
          actor: 'admin',
          action: 'plugin.imported',
          target: row.id,
          input: { slug: row.slug, files: parsedFiles.length },
          status: 'ok',
          requestId: request.id,
        });
        return reply
          .status(201)
          .send({ plugin: toApi(row, parsedFiles), warnings: parsed.warnings });
      } catch (err) {
        // slug / runtime_name 唯一索引冲突（23505）应当是 409，而不是 500。
        if (isPgCode(err, '23505')) {
          return reject(reply, 'CONFLICT', '已有同名插件，请换一个 slug 或先删除原插件');
        }
        throw err;
      }
    },
  );

  app.get('/api/plugins/:id', { ...auth, schema: { params: idParams } }, async (request, reply) => {
    const row = await repo.getPlugin(app.db, request.params.id);
    if (!row) return notFound(reply);
    const files = await repo.listPluginFiles(app.db, row.id);
    return toApi(
      row,
      files.map((file) => ({
        path: file.path,
        content: file.content,
        executable: file.executable,
      })),
    );
  });

  app.patch(
    '/api/plugins/:id',
    { ...auth, schema: { params: idParams, body: patchSchema } },
    async (request, reply) => {
      const { expectedUpdatedAt, ...patch } = request.body;
      try {
        const row = await repo.updatePluginMeta(
          app.db,
          request.params.id,
          {
            ...(patch.name === undefined ? {} : { name: patch.name }),
            ...(patch.description === undefined ? {} : { description: patch.description }),
            ...(patch.version === undefined ? {} : { version: patch.version }),
          },
          expectedUpdatedAt === undefined ? undefined : new Date(expectedUpdatedAt),
        );
        if (row === null) return notFound(reply);
        await writeAudit(app.db, request.log, {
          actor: 'admin',
          action: 'plugin.updated',
          target: row.id,
          input: patch,
          status: 'ok',
          requestId: request.id,
        });
        const files = await repo.listPluginFiles(app.db, row.id);
        return toApi(
          row,
          files.map((file) => ({
            path: file.path,
            content: file.content,
            executable: file.executable,
          })),
        );
      } catch (err) {
        // 唯一索引冲突（改 name/version 撞上别的行）应当是 409。
        if (isPgCode(err, '23505')) {
          return reject(reply, 'CONFLICT', '插件名或版本与已有插件冲突');
        }
        throw err;
      }
    },
  );

  app.delete(
    '/api/plugins/:id',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      const deleted = await repo.deletePlugin(app.db, request.params.id);
      if (!deleted) return notFound(reply);
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'plugin.deleted',
        target: request.params.id,
        input: {},
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );

  app.get(
    '/api/plugins/:id/export',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      const row = await repo.getPlugin(app.db, request.params.id);
      if (!row) return notFound(reply);
      const files = await repo.listPluginFiles(app.db, row.id);
      const archive = zipSync(
        Object.fromEntries(
          files.map((file) => [file.path, new TextEncoder().encode(file.content)]),
        ),
      );
      return reply
        .header('content-disposition', `attachment; filename="${row.slug}.zip"`)
        .header('cache-control', 'no-store')
        .type('application/zip')
        .send(Buffer.from(archive));
    },
  );
}
