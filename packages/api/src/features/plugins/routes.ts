import { repo as pluginRepo } from '@agentport/db';
import {
  idParams,
  type NativeInstalledPlugin,
  nativePluginImportInputSchema,
  nativePluginInstallInputSchema,
  type Plugin,
  type PluginFileInput,
  type PluginInput,
  type PluginWithAgentCount,
  pluginInputSchema,
  slugSchema,
} from '@agentport/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { zipSync } from 'fflate';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { isPgCode, reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import { decodePackage } from '../agent-package-zip.js';
import { runNativePluginAction } from './native.js';
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
  sourceId?: string,
): Parameters<typeof repo.createPluginWithFiles>[1] {
  return {
    slug: input.slug,
    runtimeName: input.runtimeName ?? input.slug,
    name: input.name,
    description: input.description,
    version: input.version,
    manifest: input.capabilities,
    ...(sourceId === undefined ? {} : { sourceId }),
  };
}

function toApi(
  row: Awaited<ReturnType<typeof repo.getPlugin>> extends infer R ? NonNullable<R> : never,
  files: PluginFileInput[],
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
    sourceId: row.sourceId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type Db = Parameters<typeof repo.listPluginFiles>[0];
type PluginRow = NonNullable<Awaited<ReturnType<typeof repo.getPlugin>>>;

async function pluginFiles(db: Db, pluginId: string): Promise<PluginFileInput[]> {
  const files = await repo.listPluginFiles(db, pluginId);
  return files.map((file) => ({
    path: file.path,
    content: file.content,
    executable: file.executable,
  }));
}

async function sendReused(
  app: { db: Db },
  reply: FastifyReply,
  row: PluginRow,
  warnings: string[] = [],
) {
  return reply
    .status(200)
    .send({ plugin: toApi(row, await pluginFiles(app.db, row.id)), warnings, reused: true });
}

/**
 * worker 的失败文本是当前唯一分类信号：沙盒/缓存/镜像起不来按 503，
 * 其余（市场找不到、安装命令失败、不支持的插件）按输入错误 400。
 * shortcut: worker 输出加入结构化原因后改为读字段，不再匹配文案。
 */
function sendNativeFailure(reply: FastifyReply, error: string) {
  const unavailable = /无法启动|沙盒|安装缓存|docker|Docker|镜像|worker/i.test(error);
  return reject(reply, unavailable ? 'SERVICE_UNAVAILABLE' : 'INVALID_INPUT', error);
}

/**
 * 把 worker 交回的文本快照纳入插件库。同一 sourceId 已入库（含并发抢先）返回原对象；
 * runtimeName 撞上别的插件则是 409，不冒用。失败不留半条定义。
 */
async function adoptNativePlugin(
  app: { db: Db },
  request: FastifyRequest,
  reply: FastifyReply,
  params: { slug: string; pluginId: string; files: PluginFileInput[]; action: string },
): Promise<unknown> {
  const existing = await repo.getPluginBySourceId(app.db, params.pluginId);
  if (existing) return sendReused(app, reply, existing);

  const parsed = parsePluginFiles({ files: params.files, slug: params.slug });
  const { files: parsedFiles, ...input } = parsed.input;
  try {
    const row = await repo.createPluginWithFiles(
      app.db,
      toPluginWrite(input, params.pluginId),
      parsedFiles,
    );
    await writeAudit(app.db, request.log, {
      actor: 'admin',
      action: params.action,
      target: row.id,
      input: { slug: row.slug, sourceId: params.pluginId, files: parsedFiles.length },
      status: 'ok',
      requestId: request.id,
    });
    return reply
      .status(201)
      .send({ plugin: toApi(row, parsedFiles), warnings: parsed.warnings, reused: false });
  } catch (err) {
    if (!isPgCode(err, '23505')) throw err;
    const raced = await repo.getPluginBySourceId(app.db, params.pluginId);
    if (raced) return sendReused(app, reply, raced);
    return reject(reply, 'CONFLICT', '已有同名插件占用该 slug 或名称，请先删除或换一个 slug');
  }
}

/** `name@marketplace` 的本地名部分，作为未指定 slug 时的默认目录名。 */
function nameOfPluginId(pluginId: string): string {
  return pluginId.split('@')[0] ?? pluginId;
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

  // 官方缓存里已安装的插件 + 是否已纳入平台库；不向浏览器暴露宿主路径。
  app.get('/api/plugins/native', auth, async (request, reply) => {
    const output = await runNativePluginAction(app.config.REDIS_URL, request.log, {
      action: 'list',
    });
    if (!output.ok) return sendNativeFailure(reply, output.error);
    if (!('installed' in output)) {
      return reject(reply, 'UPSTREAM_FAILED', '安装器没有返回已安装列表，请稍后重试');
    }
    const installed: Array<NativeInstalledPlugin & { imported: boolean }> = await Promise.all(
      output.installed.map(async (plugin) => ({
        ...plugin,
        imported: (await repo.getPluginBySourceId(app.db, plugin.pluginId)) !== null,
      })),
    );
    return { installed };
  });

  // 从市场安装：官方 CLI 在 worker 沙盒里下载并安装，再把文本快照纳入插件库。
  app.post(
    '/api/plugins/install',
    { ...auth, schema: { body: nativePluginInstallInputSchema } },
    async (request, reply) => {
      const { marketplace, plugin, slug } = request.body;
      // 市场身份由官方 CLI 注册时决定，不能凭 owner/repo 拼；每次安装都让 CLI 解析，
      // 拿到真实 pluginId 后再按 sourceId 复用库里已有记录（install 本身可离线）。
      const output = await runNativePluginAction(app.config.REDIS_URL, request.log, {
        action: 'install',
        marketplace,
        plugin,
      });
      if (!output.ok) return sendNativeFailure(reply, output.error);
      if (!('files' in output)) {
        return reject(reply, 'UPSTREAM_FAILED', '安装器没有返回插件文件，请稍后重试');
      }
      return adoptNativePlugin(rawApp, request, reply, {
        slug: slug ?? nameOfPluginId(output.plugin.pluginId),
        pluginId: output.plugin.pluginId,
        files: output.files,
        action: 'plugin.installed',
      });
    },
  );

  // 选用已安装插件：只读缓存快照，不触发下载。
  app.post(
    '/api/plugins/native/import',
    { ...auth, schema: { body: nativePluginImportInputSchema } },
    async (request, reply) => {
      const { pluginId, slug } = request.body;
      const existing = await repo.getPluginBySourceId(app.db, pluginId);
      if (existing) return sendReused(rawApp, reply, existing);

      const output = await runNativePluginAction(app.config.REDIS_URL, request.log, {
        action: 'read',
        pluginId,
      });
      if (!output.ok) return sendNativeFailure(reply, output.error);
      if (!('files' in output)) {
        return reject(reply, 'UPSTREAM_FAILED', '读取器没有返回插件文件，请稍后重试');
      }
      return adoptNativePlugin(rawApp, request, reply, {
        slug: slug ?? nameOfPluginId(output.plugin.pluginId),
        pluginId: output.plugin.pluginId,
        files: output.files,
        action: 'plugin.adopted',
      });
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
