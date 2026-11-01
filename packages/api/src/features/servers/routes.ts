import { fail, isAppError, parseMcpJson } from '@agentport/core';
import { repo as dbRepo } from '@agentport/db';
import type { ApiToolPatch } from '@agentport/db/repo/servers.js';
import {
  apiToolInputSchema,
  connectorCatalogSchema,
  httpUrlSchema,
  idParams,
  maskSecret,
  type ServerTestResult,
  serverInputSchema,
  serverTestResultSchema,
  slugSchema,
} from '@agentport/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { isPgCode, reject } from '../../plugins/errors.js';
import { serverTestRateLimit } from '../../plugins/security.js';
import { typed } from '../../types.js';
import { actorOf } from '../access.js';
import { connectorCatalog } from './connector-catalog-data.js';
import * as repo from './repo.js';
import { getMcpToken, getServerWithSecrets } from './repo.js';
import { testStdioInSandbox } from './sandbox-probe.js';
import { assertSafeUrl } from './ssrf.js';
import { testConnection } from './test-connection.js';

const toolParams = idParams.extend({ toolId: z.string().min(1) });

// kind 不可变，其余字段按 kind 取用；未知字段忽略。
const serverPatchSchema = z.object({
  kind: z.enum(['stdio', 'http', 'generated']).optional(),
  name: slugSchema.optional(),
  description: z.string().max(500).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: httpUrlSchema.optional(),
  baseUrl: httpUrlSchema.optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** 乐观锁：首次加载时的 updatedAt。 */
  expectedUpdatedAt: z.coerce.date().optional(),
});

/**
 * 工具的可编辑字段。与 apiToolInputSchema 同名同义，但全部可选且**不带默认值**：
 * `.partial()` 只把字段设为可选，`default()` 仍会为空对象填上默认值，
 * 于是「至少改一项」的校验永远不会触发。所以这里显式重写，而不是 partial()。
 */
const toolPatchSchema = z
  .object({
    name: slugSchema.optional(),
    description: z.string().max(1000).optional(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
    pathTemplate: z.string().min(1).optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    paramsIn: z.enum(['query', 'body']).optional(),
    requiresApproval: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: '至少需要修改一项',
  });

function notFound(reply: FastifyReply, what: 'server' | 'tool') {
  return reject(
    reply,
    'NOT_FOUND',
    what === 'server'
      ? 'MCP Server 不存在，可能已被删除；请刷新后重试'
      : '该工具不存在，可能已被删除；请刷新后重试',
  );
}

/**
 * `.mcp.json` 的原文先过字节上限，再交给 core 的白名单解析器。
 * 解析失败统一变成字段级 INVALID_INPUT，handler 里不再 safeParse。
 */
const importFileSchema = z
  .object({ mcpJson: z.string().max(1_048_576) })
  .transform(({ mcpJson }, ctx) => {
    try {
      return parseMcpJson(mcpJson);
    } catch (err) {
      if (!isAppError(err)) throw err;
      ctx.addIssue({ code: 'custom', path: ['mcpJson'], message: err.message });
      return z.NEVER;
    }
  });

const IMPORT_WARNINGS = ['仅导入连接配置；未测试连接或执行命令，请检查后再使用。'];

/**
 * 试连只对 stdio 有意义：http/generated 从平台侧直连，不经过运行环境。
 * 可选项保持可选，老调用方不带 body 时仍使用平台默认环境。
 */
const serverTestBodySchema = z
  .object({
    /** null/缺省表示平台默认环境；只影响这次 stdio 试连使用的容器镜像。 */
    runtimeEnvironmentId: z.string().min(1).nullable().optional(),
  })
  .strict()
  .nullish();

/** server 名有唯一索引（23505）→ 409。 */
function rethrowConflict(err: unknown): never {
  if (isPgCode(err, '23505')) fail('CONFLICT', '该名称已被其他 MCP Server 占用，请换一个');
  throw err;
}

/** schema 声明即校验与类型来源；handler 里不再 safeParse。 */
export function registerServerRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const key = (): string => app.config.APP_SECRET_KEY;

  app.get(
    '/api/servers',
    { config: { access: { kind: 'permission', permissionId: 'servers.read' } } },
    async () => repo.listServers(app.db, key()),
  );

  // 连接器目录（策划清单）：只读，用于浏览并预填创建表单，绝不执行任何命令。
  app.get(
    '/api/connector-catalog',
    { config: { access: { kind: 'permission', permissionId: 'servers.read' } } },
    async () => connectorCatalogSchema.parse(connectorCatalog),
  );

  app.post(
    '/api/servers',
    {
      config: { access: { kind: 'permission', permissionId: 'servers.create' } },
      schema: { body: serverInputSchema },
    },
    async (request, reply) => {
      const input = request.body;
      try {
        // 登记与导入走同一个 SSRF 检查；失败由统一错误处理返回 400 INVALID_URL。
        if (input.kind === 'http') {
          await assertSafeUrl(input.url, app.config.NODE_ENV);
        } else if (input.kind === 'generated') {
          await assertSafeUrl(input.baseUrl, app.config.NODE_ENV);
        }
        const created = await repo.createServer(app.db, input, key());
        await writeAudit(app.db, request.log, {
          actor: actorOf(request),
          action: 'server.created',
          target: created.id,
          input,
          status: 'ok',
          requestId: request.id,
        });
        return reply.status(201).send(created);
      } catch (err) {
        rethrowConflict(err);
      }
    },
  );

  /**
   * 原生 `.mcp.json` 批量导入：先整批校验（含 SSRF），再在一个事务里全部写入。
   * bodyLimit 放宽到 8 MiB，因为 1 MiB 的 JSON 文本被转义成字符串后可能接近 4 倍；
   * 真正的上限由 schema 的 mcpJson 字节数约束。
   */
  app.post(
    '/api/servers/import-file',
    {
      config: { access: { kind: 'permission', permissionId: 'servers.import' } },
      bodyLimit: 8 * 1024 * 1024,
      schema: { body: importFileSchema },
    },
    async (request, reply) => {
      const inputs = request.body;
      // http 地址在写库前逐条检查；stdio 不执行、不联网。
      for (const input of inputs) {
        if (input.kind === 'http') await assertSafeUrl(input.url, app.config.NODE_ENV);
      }
      try {
        const servers = await repo.createServers(app.db, inputs, key());
        await writeAudit(app.db, request.log, {
          actor: actorOf(request),
          action: 'server.imported',
          // 批次没有单一目标；审计只存摘要，配置与密钥原文都不入库。
          input: { count: servers.length, names: servers.map((server) => server.name) },
          status: 'ok',
          requestId: request.id,
        });
        return reply.status(201).send({ servers, warnings: IMPORT_WARNINGS });
      } catch (err) {
        rethrowConflict(err);
      }
    },
  );

  app.get(
    '/api/servers/:id',
    {
      config: { access: { kind: 'permission', permissionId: 'servers.read' } },
      schema: { params: idParams },
    },
    async (request, reply) => {
      const server = await repo.getServer(app.db, request.params.id, key());
      return server ?? notFound(reply, 'server');
    },
  );

  /** 只返回掩码与端点；明文只由 rotate 返回一次。 */
  app.get(
    '/api/servers/:id/token',
    {
      config: { access: { kind: 'permission', permissionId: 'servers.tokens.read' } },
      schema: { params: idParams },
    },
    async (request, reply) => {
      const row = await repo.getServerRow(app.db, request.params.id);
      if (!row) return notFound(reply, 'server');
      if (row.kind !== 'generated') {
        return reject(
          reply,
          'INVALID_INPUT',
          '只有平台生成的 Server 才有访问 token；其他类型请在连接配置里填写上游凭据',
        );
      }
      const token = await getMcpToken(app.db, row.id);
      return {
        // 与 rotate-token 的明文 `token` 区分：这里永远只有掩码。
        maskedToken: maskSecret(token),
        endpoint: `${app.config.SELF_URL}/mcp/${row.id}`,
      };
    },
  );

  app.post(
    '/api/servers/:id/rotate-token',
    {
      config: { access: { kind: 'permission', permissionId: 'servers.tokens.rotate' } },
      schema: { params: idParams },
    },
    async (request, reply) => {
      const row = await repo.getServerRow(app.db, request.params.id);
      if (!row) return notFound(reply, 'server');
      if (row.kind !== 'generated') {
        return reject(
          reply,
          'INVALID_INPUT',
          '只有平台生成的 Server 才能轮换 token；其他类型请在连接配置里更新上游凭据',
        );
      }
      const token = await repo.rotateMcpToken(app.db, row.id);
      if (!token) return notFound(reply, 'server');
      await writeAudit(app.db, request.log, {
        actor: actorOf(request),
        action: 'server.token.rotated',
        target: row.id,
        status: 'ok',
        requestId: request.id,
      });
      return { token, endpoint: `${app.config.SELF_URL}/mcp/${row.id}` };
    },
  );

  app.patch(
    '/api/servers/:id',
    {
      config: { access: { kind: 'permission', permissionId: 'servers.update' } },
      schema: { params: idParams, body: serverPatchSchema },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      try {
        const row = await repo.getServerRow(app.db, id);
        if (!row) return notFound(reply, 'server');
        // 知识库连接由知识库生命周期管理，普通连接器接口不能改。
        if (row.kind === 'knowledge') {
          return reject(reply, 'FORBIDDEN', '知识库连接由知识库设置管理');
        }
        // 地址按库里实际的 kind 校验；只改描述不会复查既有地址。
        if (row.kind === 'http' && body.url !== undefined) {
          await assertSafeUrl(body.url, app.config.NODE_ENV);
        } else if (row.kind === 'generated' && body.baseUrl !== undefined) {
          await assertSafeUrl(body.baseUrl, app.config.NODE_ENV);
        }
        const updated = await repo.updateServer(app.db, id, body, key(), body.expectedUpdatedAt);
        if (!updated) return notFound(reply, 'server');
        await writeAudit(app.db, request.log, {
          actor: actorOf(request),
          action: 'server.updated',
          target: updated.id,
          input: body,
          status: 'ok',
          requestId: request.id,
        });
        return updated;
      } catch (err) {
        rethrowConflict(err);
      }
    },
  );

  app.delete(
    '/api/servers/:id',
    {
      config: { access: { kind: 'permission', permissionId: 'servers.delete' } },
      schema: { params: idParams },
    },
    async (request, reply) => {
      // 知识库连接随知识库删除，不能从这里单独删掉。
      const row = await repo.getServerRow(app.db, request.params.id);
      if (row?.kind === 'knowledge') {
        return reject(reply, 'FORBIDDEN', '知识库连接由知识库设置管理');
      }
      const ok = await repo.deleteServer(app.db, request.params.id);
      if (!ok) return notFound(reply, 'server');
      await writeAudit(app.db, request.log, {
        actor: actorOf(request),
        action: 'server.deleted',
        target: request.params.id,
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );

  app.post(
    '/api/servers/:id/test',
    {
      ...serverTestRateLimit,
      config: {
        ...serverTestRateLimit.config,
        access: { kind: 'permission', permissionId: 'servers.test' },
      },
      schema: { params: idParams, body: serverTestBodySchema },
    },
    async (request, reply) => {
      const server = await getServerWithSecrets(app.db, request.params.id, key());
      if (!server) return notFound(reply, 'server');
      const runtimeEnvironmentId = request.body?.runtimeEnvironmentId;
      // 运行环境是沙盒概念：http/generated 由平台侧直连，不能假装在某个环境里测试。
      if (runtimeEnvironmentId != null && server.kind !== 'stdio') {
        return reject(
          reply,
          'INVALID_INPUT',
          '从平台侧发起的连接不使用运行环境；运行环境仅用于 stdio 连接测试',
        );
      }
      // stdio 命令由用户提供：只在 worker 的沙盒镜像里执行；http/generated 仍在 API 内直连。
      // worker 结果带脱敏 stderr，序列化时由 serverTestResultSchema 剥掉。
      const result: ServerTestResult & { stderr?: string } =
        server.kind === 'stdio'
          ? await testStdioInSandbox(server.id, request.log, {
              ...(runtimeEnvironmentId == null ? {} : { runtimeEnvironmentId }),
            })
          : await testConnection(
              server,
              app.config.NODE_ENV,
              server.kind === 'generated'
                ? {
                    baseUrl: app.config.SELF_URL,
                    token: (await getMcpToken(app.db, server.id)) ?? '',
                  }
                : undefined,
              request.log,
            );
      await writeAudit(app.db, request.log, {
        actor: actorOf(request),
        action: 'mcp.server.tested',
        target: server.id,
        // 失败原因（含脱敏后的 stderr 摘要）进 digest：审计表没有 detail 列，
        // 原文只有日志里有；这里保证「同一原因同一条审计」可被检索比对。
        input: {
          kind: server.kind,
          name: server.name,
          ...(result.ok
            ? { tools: result.tools.length }
            : {
                error: result.error ?? 'connection failed',
                ...('stderr' in result && result.stderr ? { stderr: result.stderr } : {}),
              }),
        },
        status: result.ok ? 'ok' : 'error',
        durationMs: result.durationMs,
        requestId: request.id,
      });
      await repo.recordTestResult(
        app.db,
        server.id,
        result.ok,
        result.ok ? result.tools.length : null,
        // 成功只对本次实际环境成立；http/generated 没有环境身份，记 null。
        result.runtimeEnvironment ?? null,
      );
      // http 工具目录落到 servers.config：worker 渲染生成式 UI 提示词时无法连 MCP，
      // 与执行桥共用这份快照。stdio 用不到（不进 UI 目录），失败也不覆盖旧目录。
      if (result.ok && server.kind === 'http') {
        await dbRepo.openui.cacheServerToolCatalog(app.db, server.id, result.tools);
      }
      return serverTestResultSchema.parse(result);
    },
  );

  app.get(
    '/api/servers/:id/tools',
    {
      config: { access: { kind: 'permission', permissionId: 'servers.read' } },
      schema: { params: idParams },
    },
    async (request, reply) => {
      if (!(await dbRepo.servers.serverExists(app.db, request.params.id))) {
        return notFound(reply, 'server');
      }
      return repo.listTools(app.db, request.params.id);
    },
  );

  app.post(
    '/api/servers/:id/tools',
    {
      config: { access: { kind: 'permission', permissionId: 'servers.tools.manage' } },
      schema: { params: idParams, body: apiToolInputSchema },
    },
    async (request, reply) => {
      const row = await repo.getServerRow(app.db, request.params.id);
      if (!row) return notFound(reply, 'server');
      if (row.kind !== 'generated') {
        return reject(
          reply,
          'INVALID_INPUT',
          '只有平台生成的 Server 才能添加 HTTP 工具；其他类型请直接连接上游 MCP 端点',
        );
      }
      try {
        const tool = await repo.createTool(app.db, request.params.id, request.body);
        await writeAudit(app.db, request.log, {
          actor: actorOf(request),
          action: 'server.tool.created',
          target: request.params.id,
          input: { name: request.body.name, method: request.body.method },
          status: 'ok',
          requestId: request.id,
        });
        return reply.status(201).send(tool);
      } catch (err) {
        rethrowConflict(err);
      }
    },
  );

  app.patch(
    '/api/servers/:id/tools/:toolId',
    {
      config: { access: { kind: 'permission', permissionId: 'servers.tools.manage' } },
      schema: { params: toolParams, body: toolPatchSchema },
    },
    async (request, reply) => {
      const { id, toolId } = request.params;
      const body = request.body;
      // 去掉 undefined：exactOptionalPropertyTypes 下「没有该键」与「值为 undefined」不同。
      const patch: ApiToolPatch = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.description !== undefined) patch.description = body.description;
      if (body.method !== undefined) patch.method = body.method;
      if (body.pathTemplate !== undefined) patch.pathTemplate = body.pathTemplate;
      if (body.inputSchema !== undefined) patch.inputSchema = body.inputSchema;
      if (body.paramsIn !== undefined) patch.paramsIn = body.paramsIn;
      if (body.requiresApproval !== undefined) patch.requiresApproval = body.requiresApproval;
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      let tool: Awaited<ReturnType<typeof repo.updateTool>>;
      try {
        tool = await repo.updateTool(app.db, id, toolId, patch);
      } catch (err) {
        if (isPgCode(err, '23505'))
          return reject(reply, 'CONFLICT', '该工具名已被同一连接器下的其他工具占用，请换一个');
        throw err;
      }
      if (!tool) return notFound(reply, 'tool');
      await writeAudit(app.db, request.log, {
        actor: actorOf(request),
        action: 'server.tool.updated',
        target: id,
        input: { toolId, name: tool.name, ...patch },
        status: 'ok',
        requestId: request.id,
      });
      return tool;
    },
  );

  app.delete(
    '/api/servers/:id/tools/:toolId',
    {
      config: { access: { kind: 'permission', permissionId: 'servers.tools.manage' } },
      schema: { params: toolParams },
    },
    async (request, reply) => {
      const { id, toolId } = request.params;
      const ok = await repo.deleteTool(app.db, id, toolId);
      if (!ok) return notFound(reply, 'tool');
      await writeAudit(app.db, request.log, {
        actor: actorOf(request),
        action: 'server.tool.deleted',
        target: id,
        input: { toolId },
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );
}
