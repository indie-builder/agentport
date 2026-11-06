import { fail } from '@agentport/core';
import { repo, schema } from '@agentport/db';
import {
  AGENT_PACKAGE_MAX_BYTES,
  AGENT_PACKAGE_MAX_ENTRIES,
  AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES,
  idParams,
  slugSchema,
} from '@agentport/shared';
import { inArray } from 'drizzle-orm';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { authorize, authorizeObject, requireUser } from '../../http/access.js';
import type { HttpEnv } from '../../http/context.js';
import { requestContext } from '../../http/context.js';
import { access } from '../../http/middleware.js';
import { requireTrustedOrigin } from '../auth/origin.js';
import { withMemoryTargetLock } from '../memory/changes.js';
import { authorizeAgent, authorizedAgent } from './access.js';
import { listMemoryFiles, readMemoryFile } from './memory-files.js';
import { buildAgentPackage, packAgentPackage, parseAgentPackage } from './package.js';
import { decodePackage, encodePackage } from './package-zip.js';
import { importAgent } from './use-cases.js';
import { renderAgentWorkspace } from './workspace.js';

const importQuerySchema = z
  .object({
    slug: slugSchema.optional(),
    name: z.string().min(1).max(128).optional(),
    runtimeEnvironmentId: z.string().min(1).optional(),
  })
  .strict();
const subAgentFileParams = z.object({ id: z.string().min(1), childId: z.string().min(1) });
export function registerAgentsHttp(app: Hono<HttpEnv>): void {
  app.post(
    '/api/import/agents',
    access({ kind: 'permission', permissionId: 'agents.import' }),
    bodyLimit({
      maxSize: AGENT_PACKAGE_MAX_BYTES,
      onError: () => fail('PAYLOAD_TOO_LARGE', '请求体超出大小限制，请减少内容后重试'),
    }),
    async (c) => {
      const context = requestContext(c);
      requireTrustedOrigin(context);
      if (c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/zip')
        fail('UNSUPPORTED_MEDIA_TYPE', '不支持的 Content-Type，请使用 application/zip');
      const query = importQuerySchema.parse(c.req.query());
      let files: Map<string, string>;
      try {
        files = decodePackage(Buffer.from(await c.req.arrayBuffer()));
      } catch (error) {
        fail('INVALID_INPUT', error instanceof Error ? error.message : '专家包无法解析');
      }
      const parsed = parseAgentPackage(files, {
        ...(query.slug === undefined ? {} : { slug: query.slug }),
        ...(query.name === undefined ? {} : { name: query.name }),
      });
      const principal = requireUser(context);
      await authorize(context, 'agents.create', { createdBy: principal.businessId });
      const serverNames = [...new Set(parsed.servers.map((entry) => entry.name))];
      if (serverNames.length > 0) {
        const existing = await context.db
          .select({ name: schema.servers.name })
          .from(schema.servers)
          .where(inArray(schema.servers.name, serverNames));
        if (existing.length < serverNames.length) await authorize(context, 'servers.create');
      }
      const skillSlugs = [...new Set(parsed.skills.map((entry) => entry.slug))];
      if (skillSlugs.length > 0) {
        const existing = await context.db
          .select({ slug: schema.skills.slug })
          .from(schema.skills)
          .where(inArray(schema.skills.slug, skillSlugs));
        if (existing.length < skillSlugs.length) await authorize(context, 'skills.create');
      }
      if (query.runtimeEnvironmentId !== undefined)
        await authorize(context, 'runtime_environments.read');
      const response = await importAgent(
        {
          db: context.db,
          log: context.log,
          actor: principal.businessId,
          requestId: context.requestId,
        },
        parsed,
        {
          nodeEnv: context.config.NODE_ENV,
          selfUrl: context.config.SELF_URL,
          businessId: principal.businessId,
          ...(query.runtimeEnvironmentId === undefined
            ? {}
            : { runtimeEnvironmentId: query.runtimeEnvironmentId }),
        },
      );
      return c.json(response, 201);
    },
  );
  app.get(
    '/api/export/agents/:id',
    access({ kind: 'permission', permissionId: 'agents.export' }),
    async (c) => {
      const context = requestContext(c);
      const { id } = idParams.parse(c.req.param());
      const row = await repo.agents.getAgent(context.db, id);
      if (!row) fail('AGENT_NOT_FOUND', '智能体不存在，可能已被删除；请刷新后重试');
      for (const permissionId of [
        'agents.export',
        'agents.files.read',
        'agents.config.read',
        'agents.rules.read',
        'agents.styles.read',
        'agents.memory.read',
      ] as const) {
        await authorizeObject(
          context,
          permissionId,
          { agentId: row.id },
          '智能体不存在，可能已被删除；请刷新后重试',
        );
      }
      const pkg = await buildAgentPackage(
        context.db,
        context.config.APP_SECRET_KEY,
        context.config.SELF_URL,
        row,
      );
      return c.body(new Uint8Array(packAgentPackage(pkg)), 200, {
        'content-disposition': `attachment; filename="${pkg.slug}.zip"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-package-warnings': encodeURIComponent(JSON.stringify(pkg.warnings)),
        'content-type': 'application/zip',
      });
    },
  );
  app.get(
    '/api/agents/:id/subagents/:childId/file',
    access({ kind: 'permission', permissionId: 'agents.files.read' }),
    async (c) => {
      const context = requestContext(c);
      const params = subAgentFileParams.parse(c.req.param());
      const [parent, child] = await Promise.all([
        repo.agents.getAgent(context.db, params.id),
        repo.agents.getAgent(context.db, params.childId),
      ]);
      if (!parent || !child || child.parentId !== parent.id || child.id === parent.id)
        fail('AGENT_NOT_FOUND', '智能体不存在，可能已被删除；请返回列表刷新后重试');
      await authorizeAgent(context, parent, ['agents.files.read', 'agents.config.read']);
      const files = await renderAgentWorkspace(context, parent.id);
      const rendered = files?.subAgents.find((subAgent) => subAgent.slug === child.slug);
      if (!rendered) fail('AGENT_NOT_FOUND', '智能体不存在，可能已被删除；请返回列表刷新后重试');
      return c.body(rendered.content, 200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="${child.slug}.md"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
    },
  );
  app.get(
    '/api/agents/:id/memory/download',
    access({ kind: 'permission', permissionId: 'agents.memory.read' }),
    async (c) => {
      const context = requestContext(c);
      const { id } = idParams.parse(c.req.param());
      const row = await authorizedAgent(context, id, 'agents.memory.read');
      const archive = await withMemoryTargetLock(
        context.client,
        { kind: 'agent_memory', agentId: row.id, name: 'MEMORY.md' },
        requireUser(context).businessId,
        async () => {
          const listed = await listMemoryFiles(context.config.WORKSPACES_DIR, row.slug);
          if (listed.files.length === 0) fail('NOT_FOUND', '该专家还没有可下载的记忆文件');
          if (listed.files.length > AGENT_PACKAGE_MAX_ENTRIES)
            fail('CONFLICT', `记忆文件数超过 ${AGENT_PACKAGE_MAX_ENTRIES} 个，无法打包下载`);
          const files: Record<string, string> = {};
          let total = 0;
          for (const file of listed.files) {
            const content = await readMemoryFile(
              context.config.WORKSPACES_DIR,
              row.slug,
              file.name,
            );
            if (!content) fail('NOT_FOUND', '记忆文件在下载过程中被删除');
            total += Buffer.byteLength(content.content, 'utf8');
            if (total > AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES)
              fail(
                'CONFLICT',
                `记忆目录解压后超过 ${AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES} 字节，无法打包下载`,
              );
            files[file.name] = content.content;
          }
          const body = encodePackage(files);
          if (body.byteLength > AGENT_PACKAGE_MAX_BYTES)
            fail('CONFLICT', `记忆目录压缩后超过 ${AGENT_PACKAGE_MAX_BYTES} 字节，无法打包下载`);
          return body;
        },
      );
      return c.body(new Uint8Array(archive), 200, {
        'content-disposition': `attachment; filename="${row.slug}-memory.zip"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-type': 'application/zip',
      });
    },
  );
}
