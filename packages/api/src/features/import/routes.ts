import { AGENT_PACKAGE_MAX_BYTES, slugSchema } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { typed } from '../../types.js';
import { importAgentPackage, parseAgentPackage } from '../agent-package.js';
import { decodePackage } from '../agent-package-zip.js';

/** 不带 sidecar 的官方目录用请求参数补 slug/name。 */
const importQuerySchema = z
  .object({
    slug: slugSchema.optional(),
    name: z.string().min(1).max(128).optional(),
  })
  .strict();

export function registerImportRoutes(rawApp: FastifyInstance): void {
  // ZIP 是二进制：先按原始字节收下，再在 schema 里解码成文件 map。
  rawApp.addContentTypeParser(
    'application/zip',
    { parseAs: 'buffer', bodyLimit: AGENT_PACKAGE_MAX_BYTES },
    (_request, body, done) => done(null, body),
  );

  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };

  // 校验放在 schema：解码/解析错误统一成为 400 INVALID_INPUT。
  const importBodySchema = z.instanceof(Buffer).transform((buffer, ctx) => {
    try {
      return decodePackage(buffer);
    } catch (err) {
      const message = err instanceof Error ? err.message : '专家包无法解析';
      ctx.addIssue({ code: 'custom', path: [], message });
      return z.NEVER;
    }
  });

  app.post(
    '/api/import/agents',
    {
      ...auth,
      bodyLimit: AGENT_PACKAGE_MAX_BYTES,
      schema: { querystring: importQuerySchema, body: importBodySchema },
    },
    async (request, reply) => {
      const parsed = parseAgentPackage(request.body, {
        ...(request.query.slug === undefined ? {} : { slug: request.query.slug }),
        ...(request.query.name === undefined ? {} : { name: request.query.name }),
      });
      const result = await importAgentPackage(app.db, parsed, {
        nodeEnv: app.config.NODE_ENV,
      });
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'agent.imported',
        target: result.agent.id,
        input: {
          slug: result.agent.slug,
          servers: { created: result.createdServers.length, reused: result.reusedServers.length },
          skills: result.createdSkills.length,
          files: result.counts.files,
          rules: result.counts.rules,
          outputStyles: result.counts.outputStyles,
          subAgents: result.createdSubAgents.length,
        },
        status: 'ok',
        requestId: request.id,
      });
      const { counts: _counts, ...response } = result;
      return reply.status(201).send(response);
    },
  );
}
