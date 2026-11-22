import { fail, NOT_FOUND_MESSAGES, notFound } from '@agentport/core';
import { repo, schema } from '@agentport/db';
import {
  AGENT_PACKAGE_MAX_BYTES,
  AGENT_PACKAGE_MAX_ENTRIES,
  AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES,
  displayNameSchema,
  INDEX_FILE_NAME,
  idParams,
  slugSchema,
} from '@agentport/shared';
import { inArray } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  authorize,
  authorizeObject,
  authorizeResourceAccess,
  requireUser,
} from '../../http/access.js';
import { attachmentResponse } from '../../http/attachment.js';
import { requestBodyLimit } from '../../http/body-limit.js';
import type { HttpEnv, RequestContext } from '../../http/context.js';
import { requestContext } from '../../http/context.js';
import { access } from '../../http/middleware.js';
import { requireTrustedOrigin } from '../auth/origin.js';
import { withMemoryTargetLock } from '../memory/changes.js';
import { authorizeAgent, authorizedAgent } from './access.js';
import { listMemoryFiles, readMemoryFile } from './memory-files.js';
import {
  buildAgentPackage,
  type PackageResourceAuthorization,
  packAgentPackage,
  parseAgentPackage,
} from './package.js';
import { decodePackageEntries, encodePackage, type PackageEntry } from './package-zip.js';
import { importAgent } from './use-cases.js';
import { renderAgentWorkspace } from './workspace.js';

export const agentImportQuerySchema = z
  .object({
    slug: slugSchema.optional(),
    name: displayNameSchema.optional(),
    runtimeEnvironmentId: z.string().min(1).optional(),
  })
  .strict();
const subAgentFileParams = z.object({ id: z.string().min(1), childId: z.string().min(1) });
const packageResourcePermissions = {
  server: 'servers.read',
  skill: 'skills.read',
  plugin: 'plugins.read',
  runtime_environment: 'runtime_environments.read',
} as const;
async function authorizePackageResource(
  context: RequestContext,
  resource: PackageResourceAuthorization,
): Promise<void> {
  const permissionId = packageResourcePermissions[resource.kind];
  await authorizeResourceAccess(
    context,
    permissionId,
    { ...resource, level: 'read' },
    '专家包引用的资源不存在或无权访问',
  );
}
export function registerAgentsHttp(app: Hono<HttpEnv>): void {
  app.post(
    '/api/import/agents',
    access({ kind: 'permission', permissionId: 'agents.import' }),
    requestBodyLimit(AGENT_PACKAGE_MAX_BYTES),
    async (c) => {
      const context = requestContext(c);
      requireTrustedOrigin(context);
      if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/zip')
        fail('UNSUPPORTED_MEDIA_TYPE', '不支持的 Content-Type，请使用 application/zip');
      const query = agentImportQuerySchema.parse(c.req.query());
      let entries: Map<string, PackageEntry>;
      try {
        entries = decodePackageEntries(Buffer.from(await c.req.arrayBuffer()));
      } catch (error) {
        fail('INVALID_INPUT', error instanceof Error ? error.message : '专家包无法解析');
      }
      const parsed = parseAgentPackage(
        new Map([...entries].map(([path, entry]) => [path, entry.content])),
        {
          ...(query.slug === undefined ? {} : { slug: query.slug }),
          ...(query.name === undefined ? {} : { name: query.name }),
          executables: new Map([...entries].map(([path, entry]) => [path, entry.executable])),
        },
      );
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
          privateHostAllowlist: context.config.GENERATED_PRIVATE_HOST_ALLOWLIST,
          ...(query.runtimeEnvironmentId === undefined
            ? {}
            : { runtimeEnvironmentId: query.runtimeEnvironmentId }),
        },
        {
          authorizeResource: (resource) => authorizePackageResource(context, resource),
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
      if (!row) notFound('agent');
      for (const permissionId of [
        'agents.export',
        'agents.files.read',
        'agents.config.read',
        'agents.rules.read',
        'agents.styles.read',
        'agents.workflows.read',
        'agents.memory.read',
      ] as const) {
        await authorizeObject(context, permissionId, { agentId: row.id }, NOT_FOUND_MESSAGES.agent);
      }
      if (row.hooksEnabled || (await repo.hooks.listHookFiles(context.db, row.id)).length > 0) {
        await authorizeObject(
          context,
          'agents.hooks.read',
          { agentId: row.id },
          NOT_FOUND_MESSAGES.agent,
        );
      }
      const pkg = await buildAgentPackage(
        context.db,
        context.config.APP_SECRET_KEY,
        context.config.SELF_URL,
        row,
        {
          authorizeResource: (resource) => authorizePackageResource(context, resource),
        },
      );
      const response = attachmentResponse(
        new Uint8Array(packAgentPackage(pkg)),
        `${pkg.slug}.zip`,
        'application/zip',
      );
      response.headers.set('x-package-warnings', encodeURIComponent(JSON.stringify(pkg.warnings)));
      return response;
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
        notFound('agent');
      await authorizeAgent(context, parent, ['agents.files.read', 'agents.config.read']);
      const files = await renderAgentWorkspace(context, parent.id);
      const rendered = files?.subAgents.find((subAgent) => subAgent.slug === child.slug);
      if (!rendered) notFound('agent');
      return attachmentResponse(
        rendered.content,
        `${child.slug}.md`,
        'text/markdown; charset=utf-8',
      );
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
        { kind: 'agent_memory', agentId: row.id, name: INDEX_FILE_NAME },
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
      return attachmentResponse(
        new Uint8Array(archive),
        `${row.slug}-memory.zip`,
        'application/zip',
      );
    },
  );
}
