import { serversContract } from '@agentport/contract/servers';
import {
  fail,
  isAppError,
  NOT_FOUND_MESSAGES,
  parseMcpJson,
  parseOpenApiDocument,
} from '@agentport/core';
import { assertSafeUrl, assertServerEndpoint } from '@agentport/core/net-guard';
import { repo as dbRepo } from '@agentport/db';
import {
  type AccessFilter,
  type ApiToolInput,
  apiToolInputSchema,
  connectorCatalogSchema,
  maskSecret,
  mcpEndpointPath,
  type PermissionId,
  type ResourceAccessLevel,
  type ServerTestResult,
  serverTestResultSchema,
} from '@agentport/shared';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { implement } from '@orpc/server';
import { z } from 'zod';
import {
  actorOf,
  authorizeResourceAccess,
  requirePermission,
  requireUser,
  resourceAccessFilter,
} from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { isPgCode, rethrowConflict } from '../../http/errors.js';
import { cursorOption, requireCursorPage } from '../../http/pagination.js';
import { checkOutboundToolArgs } from '../security/outbound-policy.js';
import { connectorCatalog } from './connector-catalog-data.js';
import { buildGeneratedServer } from './generated.js';
import * as repo from './repo.js';
import { getMcpToken, toApiServer } from './repo.js';
import { testStdioInSandbox } from './sandbox-probe.js';
import { maskServer } from './secrets.js';
import { testConnection } from './test-connection.js';

const writeAudit = dbRepo.audit.writeAudit;
const IMPORT_WARNINGS = ['仅导入连接配置；未测试连接或执行命令，请检查后再使用。'];

const serverNameConflictMessage = '该名称已被其他 MCP Server 占用，请换一个';

function notFound(what: 'server' | 'tool'): never {
  fail('NOT_FOUND', NOT_FOUND_MESSAGES[what]);
}

async function authorizedServer(
  context: RequestContext,
  id: string,
  permissionId: PermissionId,
  level: ResourceAccessLevel,
): Promise<dbRepo.servers.ServerRow> {
  const row = await dbRepo.servers.getServer(context.db, id);
  if (!row) return notFound('server');
  await authorizeResourceAccess(
    context,
    permissionId,
    {
      kind: 'server',
      resourceId: row.id,
      ownerBusinessId: row.ownerBusinessId,
      level,
    },
    NOT_FOUND_MESSAGES.server,
  );
  return row;
}

const os = implement(serversContract).$context<RequestContext>();

export const serversRouter = os.router({
  list: os.list.handler(async ({ input, context }) => {
    const access = await resourceAccessFilter(context, 'servers.read', 'server', 'read');
    return requireCursorPage(
      await repo.listServerPage(context.db, context.config.APP_SECRET_KEY, {
        access,
        ...cursorOption(input.query.cursor),
        limit: input.query.limit,
      }),
    );
  }),
  catalog: os.catalog.handler(() => connectorCatalogSchema.parse(connectorCatalog)),
  create: os.create.handler(async ({ input: { body: input }, context }) => {
    try {
      requirePermission(context, 'servers.create');
      if (input.kind === 'http') {
        await assertSafeUrl(input.url, context.config.NODE_ENV);
      } else if (input.kind === 'generated') {
        await assertServerEndpoint(input.baseUrl, {
          nodeEnv: context.config.NODE_ENV,
          allowlist: context.config.GENERATED_PRIVATE_HOST_ALLOWLIST,
        });
      }
      const created = await repo.createServer(
        context.db,
        input,
        context.config.APP_SECRET_KEY,
        requireUser(context).businessId,
      );
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
      rethrowConflict(err, serverNameConflictMessage);
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
      requirePermission(context, 'servers.import');
      const servers = await repo.createServers(
        context.db,
        inputs,
        context.config.APP_SECRET_KEY,
        requireUser(context).businessId,
      );
      await writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'server.imported',
        input: { count: servers.length, names: servers.map((server) => server.name) },
        status: 'ok',
        requestId: context.requestId,
      });
      return { servers, warnings: IMPORT_WARNINGS };
    } catch (err) {
      rethrowConflict(err, serverNameConflictMessage);
    }
  }),
  get: os.get.handler(async ({ input, context }) => {
    const row = await authorizedServer(context, input.params.id, 'servers.read', 'read');
    return maskServer(toApiServer(row, context.config.APP_SECRET_KEY));
  }),
  token: os.token.handler(async ({ input, context }) => {
    const row = await authorizedServer(context, input.params.id, 'servers.tokens.read', 'manage');
    if (row.kind !== 'generated') {
      return fail(
        'INVALID_INPUT',
        '只有平台生成的 Server 才有访问 token；其他类型请在连接配置里填写上游凭据',
      );
    }
    const token = await getMcpToken(context.db, row.id);
    return {
      maskedToken: maskSecret(token),
      endpoint: `${context.config.SELF_URL}${mcpEndpointPath(row.id)}`,
    };
  }),
  rotateToken: os.rotateToken.handler(async ({ input, context }) => {
    const row = await authorizedServer(context, input.params.id, 'servers.tokens.rotate', 'manage');
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
    return { token, endpoint: `${context.config.SELF_URL}${mcpEndpointPath(row.id)}` };
  }),
  update: os.update.handler(async ({ input, context }) => {
    const { id } = input.params;
    const body = input.body;
    try {
      const row = await authorizedServer(context, id, 'servers.update', 'manage');
      if (row.kind === 'knowledge' || row.kind === 'data_domain') {
        return fail(
          'FORBIDDEN',
          row.kind === 'knowledge' ? '知识库连接由知识库设置管理' : '数据域连接由数据域设置管理',
        );
      }
      if (row.kind === 'http' && body.url !== undefined) {
        await assertSafeUrl(body.url, context.config.NODE_ENV);
      } else if (row.kind === 'generated' && body.baseUrl !== undefined) {
        await assertServerEndpoint(body.baseUrl, {
          nodeEnv: context.config.NODE_ENV,
          allowlist: context.config.GENERATED_PRIVATE_HOST_ALLOWLIST,
        });
      }
      const updated = await repo.updateServer(
        context.db,
        id,
        body,
        context.config.APP_SECRET_KEY,
        body.expectedUpdatedAt === undefined ? undefined : new Date(body.expectedUpdatedAt),
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
      rethrowConflict(err, serverNameConflictMessage);
    }
  }),
  delete: os.delete.handler(async ({ input, context }) => {
    const row = await authorizedServer(context, input.params.id, 'servers.delete', 'manage');
    if (row.kind === 'knowledge' || row.kind === 'data_domain') {
      return fail(
        'FORBIDDEN',
        row.kind === 'knowledge' ? '知识库连接由知识库设置管理' : '数据域连接由数据域设置管理',
      );
    }
    const ok = await dbRepo.servers.deleteServer(context.db, input.params.id);
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
  impact: os.impact.handler(async ({ input, context }) => {
    const row = await authorizedServer(context, input.params.id, 'servers.delete', 'manage');
    const principal = requireUser(context);
    const agentReadAccess: AccessFilter = {
      businessId: principal.businessId,
      scopes: principal.grants
        .filter((grant) => grant.permissionId === 'agents.read')
        .map((grant) => grant.scope),
    };
    const [bound, toolCount] = await Promise.all([
      dbRepo.agents.listServerBoundAgents(context.db, row.id, agentReadAccess),
      dbRepo.servers.countApiTools(context.db, row.id),
    ]);
    return { ...bound, toolCount };
  }),
  test: os.test.handler(async ({ input, context }) => {
    const row = await authorizedServer(context, input.params.id, 'servers.test', 'read');
    const server = toApiServer(row, context.config.APP_SECRET_KEY);
    if (server.kind === 'data_domain') {
      return fail('FORBIDDEN', '数据域连接由数据域设置管理，不能直接测试连接');
    }
    const runtimeEnvironmentId = input.body?.runtimeEnvironmentId;
    if (runtimeEnvironmentId != null && server.kind !== 'stdio') {
      return fail(
        'INVALID_INPUT',
        '从平台侧发起的连接不使用运行环境；运行环境仅用于 stdio 连接测试',
      );
    }
    if (runtimeEnvironmentId != null && server.kind === 'stdio') {
      const env = await dbRepo.runtimeEnvironments.getRuntimeEnvironmentRow(
        context.db,
        runtimeEnvironmentId,
      );
      if (!env) return fail('NOT_FOUND', NOT_FOUND_MESSAGES.runtimeEnvironment);
      await authorizeResourceAccess(
        context,
        'runtime_environments.read',
        {
          kind: 'runtime_environment',
          resourceId: env.id,
          ownerBusinessId: env.ownerBusinessId,
          level: 'read',
        },
        NOT_FOUND_MESSAGES.runtimeEnvironment,
      );
    }
    const result: ServerTestResult & { stderr?: string } =
      server.kind === 'stdio'
        ? await testStdioInSandbox(server.id, context.log, {
            redisUrl: context.config.REDIS_URL,
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
            context.config.GENERATED_PRIVATE_HOST_ALLOWLIST,
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
    await dbRepo.servers.recordTestResult(
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
      const row = await dbRepo.servers.getServerAccessRow(context.db, input.params.id);
      if (!row) return notFound('server');
      await authorizeResourceAccess(
        context,
        'servers.read',
        {
          kind: 'server',
          resourceId: row.id,
          ownerBusinessId: row.ownerBusinessId,
          level: 'read',
        },
        NOT_FOUND_MESSAGES.server,
      );
      return repo.listTools(context.db, input.params.id);
    }),
    create: os.tools.create.handler(async ({ input, context }) => {
      const row = await authorizedServer(
        context,
        input.params.id,
        'servers.tools.manage',
        'manage',
      );
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
        rethrowConflict(err, serverNameConflictMessage);
      }
    }),
    previewOpenApi: os.tools.previewOpenApi.handler(async ({ input, context }) => {
      const row = await authorizedServer(
        context,
        input.params.id,
        'servers.tools.manage',
        'manage',
      );
      if (row.kind !== 'generated') {
        return fail('INVALID_INPUT', '仅 generated 连接器支持 OpenAPI 导入');
      }
      const { tools, warnings } = parseOpenApiDocument(input.body.spec);
      return { tools, warnings, total: tools.length };
    }),
    importOpenApi: os.tools.importOpenApi.handler(async ({ input, context }) => {
      const { id } = input.params;
      const row = await authorizedServer(context, id, 'servers.tools.manage', 'manage');
      if (row.kind !== 'generated') {
        return fail('INVALID_INPUT', '仅 generated 连接器支持 OpenAPI 导入');
      }
      const { tools, warnings } = parseOpenApiDocument(input.body.spec);
      const selectedNames = input.body.selectedNames
        ? new Set(input.body.selectedNames)
        : undefined;
      const inputs: ApiToolInput[] = [];
      for (const tool of tools) {
        if (selectedNames && !selectedNames.has(tool.name)) continue;
        const parsed = apiToolInputSchema.safeParse(tool);
        if (!parsed.success) {
          return fail(
            'INVALID_INPUT',
            `工具「${tool.name}」的 OpenAPI 定义无效：${parsed.error.issues[0]?.message ?? '校验失败'}`,
          );
        }
        inputs.push(parsed.data);
      }
      try {
        const created = await repo.createTools(context.db, id, inputs);
        await writeAudit(context.db, context.log, {
          actor: actorOf(context),
          action: 'server.tools.imported',
          target: id,
          input: { count: created.length },
          status: 'ok',
          requestId: context.requestId,
        });
        return { created, warnings };
      } catch (err) {
        if (isPgCode(err, '23505')) {
          return fail('CONFLICT', '工具名已被同一连接器占用，请先删除同名工具再导入');
        }
        throw err;
      }
    }),
    batchSetEnabled: os.tools.batchSetEnabled.handler(async ({ input, context }) => {
      const { id } = input.params;
      const { toolIds, enabled } = input.body;
      const row = await authorizedServer(context, id, 'servers.tools.manage', 'manage');
      if (row.kind !== 'generated') {
        return fail('INVALID_INPUT', '仅 generated 连接器支持工具管理');
      }
      let updated = 0;
      for (const toolId of toolIds) {
        const tool = await repo.updateTool(context.db, id, toolId, { enabled });
        if (tool) updated += 1;
      }
      await writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'server.tools.batch-enabled',
        target: id,
        input: { updated, enabled },
        status: 'ok',
        requestId: context.requestId,
      });
      return { updated };
    }),
    testInvoke: os.tools.testInvoke.handler(async ({ input, context }) => {
      const { id, toolId } = input.params;
      const row = await authorizedServer(context, id, 'servers.tools.manage', 'manage');
      const server = toApiServer(row, context.config.APP_SECRET_KEY);
      if (server.kind !== 'generated') {
        return fail('INVALID_INPUT', '仅 generated 连接器支持工具测试');
      }
      const tool = (await repo.listTools(context.db, id)).find((entry) => entry.id === toolId);
      if (!tool) return notFound('tool');
      const built = buildGeneratedServer({
        name: server.name,
        baseUrl: server.baseUrl,
        headers: server.headers,
        tools: [
          { ...tool, enabled: true, approvalMode: tool.approvalMode === 'deny' ? 'deny' : 'allow' },
        ],
        nodeEnv: context.config.NODE_ENV,
        privateHostAllowlist: context.config.GENERATED_PRIVATE_HOST_ALLOWLIST,
        checkOutbound: (toolName, args) =>
          checkOutboundToolArgs({
            db: context.db,
            agentId: null,
            runId: null,
            sourceId: `${id}/${toolName}`,
            args,
          }),
      });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await built.connect(serverSide);
      const client = new Client({ name: 'agentport-tools-test', version: '0.1.0' });
      const startedAt = Date.now();
      let ok = false;
      try {
        await client.connect(clientSide);
        const result = await client.callTool(
          { name: tool.name, arguments: input.body.args },
          { timeout: 35_000 },
        );
        const text = result.content
          ?.filter((item) => item.type === 'text')
          .map((item) => item.text ?? '')[0];
        ok = result.isError !== true;
        return {
          ok,
          ...(text === undefined ? {} : { text }),
          isError: result.isError === true,
          durationMs: Date.now() - startedAt,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : '工具调用失败',
          durationMs: Date.now() - startedAt,
        };
      } finally {
        await writeAudit(context.db, context.log, {
          actor: actorOf(context),
          action: 'server.tools.test-invoked',
          target: `${id}/${toolId}`,
          input: { ok, durationMs: Date.now() - startedAt },
          status: ok ? 'ok' : 'error',
          requestId: context.requestId,
        });
        await client.close().catch(() => undefined);
        await built.close().catch(() => undefined);
      }
    }),
    update: os.tools.update.handler(async ({ input, context }) => {
      const { id, toolId } = input.params;
      const row = await authorizedServer(context, id, 'servers.tools.manage', 'manage');
      if (row.kind === 'data_domain') {
        return fail('FORBIDDEN', '数据域连接不支持工具管理');
      }
      const body = input.body;
      const patch: dbRepo.servers.ApiToolPatch = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.description !== undefined) patch.description = body.description;
      if (body.method !== undefined) patch.method = body.method;
      if (body.pathTemplate !== undefined) patch.pathTemplate = body.pathTemplate;
      if (body.inputSchema !== undefined) patch.inputSchema = body.inputSchema;
      if ('outputSchema' in body) patch.outputSchema = body.outputSchema ?? null;
      if (body.paramsIn !== undefined) patch.paramsIn = body.paramsIn;
      if (body.approvalMode !== undefined) patch.approvalMode = body.approvalMode;
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      const before = (await repo.listTools(context.db, id)).find((t) => t.id === toolId);
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
      if (
        body.approvalMode !== undefined &&
        before !== undefined &&
        before.approvalMode !== tool.approvalMode
      ) {
        await writeAudit(context.db, context.log, {
          actor: actorOf(context),
          action: 'server.tool.approval_mode.changed',
          target: id,
          input: { toolId, toolName: tool.name },
          detail: {
            toolId,
            toolName: tool.name,
            from: before.approvalMode,
            to: tool.approvalMode,
          },
          status: 'ok',
          requestId: context.requestId,
        });
      }
      return tool;
    }),
    delete: os.tools.delete.handler(async ({ input, context }) => {
      const { id, toolId } = input.params;
      const row = await authorizedServer(context, id, 'servers.tools.manage', 'manage');
      if (row.kind === 'data_domain') {
        return fail('FORBIDDEN', '数据域连接不支持工具管理');
      }
      const ok = await dbRepo.servers.deleteApiTool(context.db, id, toolId);
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
