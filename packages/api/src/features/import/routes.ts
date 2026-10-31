import { AGENT_PACKAGE_MAX_BYTES, slugSchema } from '@agentport/shared';
import { schema } from '@agentport/db';
import { inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { typed } from '../../types.js';
import { actorOf, userPrincipal } from '../access.js';
import { importAgentPackage, parseAgentPackage } from '../agent-package.js';
import { decodePackage } from '../agent-package-zip.js';

/** 不带 sidecar 的官方目录用请求参数补 slug/name；显式目标环境按 id 映射。 */
const importQuerySchema = z
  .object({
    slug: slugSchema.optional(),
    name: z.string().min(1).max(128).optional(),
    /** 显式映射到本机运行环境；缺省按包内名称匹配，包内无引用则为默认环境。 */
    runtimeEnvironmentId: z.string().min(1).optional(),
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
      config: { access: { kind: 'permission', permissionId: 'agents.import' } },
      bodyLimit: AGENT_PACKAGE_MAX_BYTES,
      schema: { querystring: importQuerySchema, body: importBodySchema },
    },
    async (request, reply) => {
      const parsed = parseAgentPackage(request.body, {
        ...(request.query.slug === undefined ? {} : { slug: request.query.slug }),
        ...(request.query.name === undefined ? {} : { name: request.query.name }),
      });
      const principal = userPrincipal(request);
      // 导入总是新建专家：O/P 的创建范围必不可少。
      await app.authorize(request, 'agents.create', {
        createdBy: principal.businessId,
      });
      // 包内新增全局资源需要对应创建叶；复用已有资源只需现有绑定能力。
      const serverNames = [...new Set(parsed.servers.map((entry) => entry.name))];
      if (serverNames.length > 0) {
        const existing = await app.db
          .select({ name: schema.servers.name })
          .from(schema.servers)
          .where(inArray(schema.servers.name, serverNames));
        if (existing.length < serverNames.length) await app.authorize(request, 'servers.create');
      }
      const skillSlugs = [...new Set(parsed.skills.map((entry) => entry.slug))];
      if (skillSlugs.length > 0) {
        const existing = await app.db
          .select({ slug: schema.skills.slug })
          .from(schema.skills)
          .where(inArray(schema.skills.slug, skillSlugs));
        if (existing.length < skillSlugs.length) await app.authorize(request, 'skills.create');
      }
      if (request.query.runtimeEnvironmentId !== undefined) {
        await app.authorize(request, 'runtime_environments.read');
      }
      const result = await importAgentPackage(app.db, parsed, {
        nodeEnv: app.config.NODE_ENV,
        selfUrl: app.config.SELF_URL,
        businessId: principal.businessId,
        ...(request.query.runtimeEnvironmentId === undefined
          ? {}
          : { runtimeEnvironmentId: request.query.runtimeEnvironmentId }),
      });
      await writeAudit(app.db, request.log, {
        actor: actorOf(request),
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
