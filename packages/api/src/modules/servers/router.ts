import { serversContract } from '@agentport/contract/servers';
import { fail, isAppError, parseMcpJson } from '@agentport/core';
import { repo as dbRepo } from '@agentport/db';
import type { ApiToolPatch } from '@agentport/db/repo/servers.js';
import {
  connectorCatalogSchema,
  maskSecret,
  type ServerTestResult,
  serverTestResultSchema,
} from '@agentport/shared';
import { implement } from '@orpc/server';
import { z } from 'zod';
import { actorOf } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { isPgCode } from '../../http/errors.js';
import { connectorCatalog } from './connector-catalog-data.js';
import * as repo from './repo.js';
import { getMcpToken, getServerWithSecrets } from './repo.js';
import { testStdioInSandbox } from './sandbox-probe.js';
import { assertSafeUrl } from './ssrf.js';
import { testConnection } from './test-connection.js';

const writeAudit = dbRepo.audit.writeAudit;
const IMPORT_WARNINGS = ['仅导入连接配置；未测试连接或执行命令，请检查后再使用。'];

function notFound(what: 'server' | 'tool'): never {
  fail(
    'NOT_FOUND',
    what === 'server'
      ? 'MCP Server 不存在，可能已被删除；请刷新后重试'
      : '该工具不存在，可能已被删除；请刷新后重试',
  );
}

function rethrowConflict(err: unknown): never {
  if (isPgCode(err, '23505')) fail('CONFLICT', '该名称已被其他 MCP Server 占用，请换一个');
  throw err;
}

const os = implement(serversContract).$context<RequestContext>();

export const serversRouter = os.router({
  list: os.list.handler(({ context }) =>
    repo.listServers(context.db, context.config.APP_SECRET_KEY),
  ),
  catalog: os.catalog.handler(() => connectorCatalogSchema.parse(connectorCatalog)),
  create: os.create.handler(async ({ input: { body: input }, context }) => {
    try {
      if (input.kind === 'http') {
        await assertSafeUrl(input.url, context.config.NODE_ENV);
      } else if (input.kind === 'generated') {
        await assertSafeUrl(input.baseUrl, context.config.NODE_ENV);
      }
      const created = await repo.createServer(context.db, input, context.config.APP_SECRET_KEY);
      await writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'server.created',
        target: created.id,
        input,
        status: 'ok',
        requestId: context.requestId,
      });
      return created;
    } catch (err) {
      rethrowConflict(err);
    }
  }),
  importFile: os.importFile.handler(async ({ input, context }) => {
    let inputs: ReturnType<typeof parseMcpJson>;
    try {
      inputs = parseMcpJson(input.body.mcpJson);
    } catch (err) {
      if (!isAppError(err)) throw err;
      throw new z.ZodError([{ code: 'custom', path: ['mcpJson'], message: err.message }]);
    }
    for (const input of inputs) {
      if (input.kind === 'http') await assertSafeUrl(input.url, context.config.NODE_ENV);
    }
    try {
      const servers = await repo.createServers(context.db, inputs, context.config.APP_SECRET_KEY);
      await writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'server.imported',
        input: { count: servers.length, names: servers.map((server) => server.name) },
        status: 'ok',
        requestId: context.requestId,
      });
      return { servers, warnings: IMPORT_WARNINGS };
    } catch (err) {
      rethrowConflict(err);
    }
  }),
  get: os.get.handler(async ({ input, context }) => {
    const server = await repo.getServer(context.db, input.params.id, context.config.APP_SECRET_KEY);
    return server ?? notFound('server');
  }),
  token: os.token.handler(async ({ input, context }) => {
    const row = await repo.getServerRow(context.db, input.params.id);
    if (!row) return notFound('server');
    if (row.kind !== 'generated') {
      return fail(
        'INVALID_INPUT',
        '只有平台生成的 Server 才有访问 token；其他类型请在连接配置里填写上游凭据',
      );
    }
    const token = await getMcpToken(context.db, row.id);
    return {
      maskedToken: maskSecret(token),
      endpoint: `${context.config.SELF_URL}/mcp/${row.id}`,
    };
  }),
  rotateToken: os.rotateToken.handler(async ({ input, context }) => {
    const row = await repo.getServerRow(context.db, input.params.id);
    if (!row) return notFound('server');
    if (row.kind !== 'generated') {
      return fail(
        'INVALID_INPUT',
        '只有平台生成的 Server 才能轮换 token；其他类型请在连接配置里更新上游凭据',
      );
    }
    const token = await repo.rotateMcpToken(context.db, row.id);
    if (!token) return notFound('server');
    await writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'server.token.rotated',
      target: row.id,
      status: 'ok',
      requestId: context.requestId,
    });
    return { token, endpoint: `${context.config.SELF_URL}/mcp/${row.id}` };
  }),
  update: os.update.handler(async ({ input, context }) => {
    const { id } = input.params;
    const body = input.body;
    try {
      const row = await repo.getServerRow(context.db, id);
      if (!row) return notFound('server');
      if (row.kind === 'knowledge') {
        return fail('FORBIDDEN', '知识库连接由知识库设置管理');
      }
      if (row.kind === 'http' && body.url !== undefined) {
        await assertSafeUrl(body.url, context.config.NODE_ENV);
      } else if (row.kind === 'generated' && body.baseUrl !== undefined) {
        await assertSafeUrl(body.baseUrl, context.config.NODE_ENV);
      }
      const updated = await repo.updateServer(
        context.db,
        id,
        body,
        context.config.APP_SECRET_KEY,
        body.expectedUpdatedAt,
      );
      if (!updated) return notFound('server');
      await writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'server.updated',
        target: updated.id,
        input: body,
        status: 'ok',
        requestId: context.requestId,
      });
      return updated;
    } catch (err) {
      rethrowConflict(err);
    }
  }),
  delete: os.delete.handler(async ({ input, context }) => {
    const row = await repo.getServerRow(context.db, input.params.id);
    if (row?.kind === 'knowledge') {
      return fail('FORBIDDEN', '知识库连接由知识库设置管理');
    }
    const ok = await repo.deleteServer(context.db, input.params.id);
    if (!ok) return notFound('server');
    await writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'server.deleted',
      target: input.params.id,
      status: 'ok',
      requestId: context.requestId,
    });
    return;
  }),
  test: os.test.handler(async ({ input, context }) => {
    const server = await getServerWithSecrets(
      context.db,
      input.params.id,
      context.config.APP_SECRET_KEY,
    );
    if (!server) return notFound('server');
    const runtimeEnvironmentId = input.body?.runtimeEnvironmentId;
    if (runtimeEnvironmentId != null && server.kind !== 'stdio') {
      return fail(
        'INVALID_INPUT',
        '从平台侧发起的连接不使用运行环境；运行环境仅用于 stdio 连接测试',
      );
    }
    const result: ServerTestResult & { stderr?: string } =
      server.kind === 'stdio'
        ? await testStdioInSandbox(server.id, context.log, {
            ...(runtimeEnvironmentId == null ? {} : { runtimeEnvironmentId }),
          })
        : await testConnection(
            server,
            context.config.NODE_ENV,
            server.kind === 'generated'
              ? {
                  baseUrl: context.config.SELF_URL,
                  token: (await getMcpToken(context.db, server.id)) ?? '',
                }
              : undefined,
            context.log,
          );
    await writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'mcp.server.tested',
      target: server.id,
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
      requestId: context.requestId,
    });
    await repo.recordTestResult(
      context.db,
      server.id,
      result.ok,
      result.ok ? result.tools.length : null,
      result.runtimeEnvironment ?? null,
    );
    if (result.ok && server.kind === 'http') {
      await dbRepo.openui.cacheServerToolCatalog(context.db, server.id, result.tools);
    }
    return serverTestResultSchema.parse(result);
  }),
  tools: {
    list: os.tools.list.handler(async ({ input, context }) => {
      if (!(await dbRepo.servers.serverExists(context.db, input.params.id))) {
        return notFound('server');
      }
      return repo.listTools(context.db, input.params.id);
    }),
    create: os.tools.create.handler(async ({ input, context }) => {
      const row = await repo.getServerRow(context.db, input.params.id);
      if (!row) return notFound('server');
      if (row.kind !== 'generated') {
        return fail(
          'INVALID_INPUT',
          '只有平台生成的 Server 才能添加 HTTP 工具；其他类型请直接连接上游 MCP 端点',
        );
      }
      try {
        const tool = await repo.createTool(context.db, input.params.id, input.body);
        await writeAudit(context.db, context.log, {
          actor: actorOf(context),
          action: 'server.tool.created',
          target: input.params.id,
          input: { name: input.body.name, method: input.body.method },
          status: 'ok',
          requestId: context.requestId,
        });
        return tool;
      } catch (err) {
        rethrowConflict(err);
      }
    }),
    update: os.tools.update.handler(async ({ input, context }) => {
      const { id, toolId } = input.params;
      const body = input.body;
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
        tool = await repo.updateTool(context.db, id, toolId, patch);
      } catch (err) {
        if (isPgCode(err, '23505'))
          return fail('CONFLICT', '该工具名已被同一连接器下的其他工具占用，请换一个');
        throw err;
      }
      if (!tool) return notFound('tool');
      await writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'server.tool.updated',
        target: id,
        input: { toolId, name: tool.name, ...patch },
        status: 'ok',
        requestId: context.requestId,
      });
      return tool;
    }),
    delete: os.tools.delete.handler(async ({ input, context }) => {
      const { id, toolId } = input.params;
      const ok = await repo.deleteTool(context.db, id, toolId);
      if (!ok) return notFound('tool');
      await writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'server.tool.deleted',
        target: id,
        input: { toolId },
        status: 'ok',
        requestId: context.requestId,
      });
      return;
    }),
  },
});
