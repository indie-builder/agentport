import { serversContract } from '@agentport/contract/servers';
import { fail, isAppError, parseMcpJson, parseOpenApiDocument } from '@agentport/core';
import { repo as dbRepo } from '@agentport/db';
import {
  type ApiToolInput,
  apiToolInputSchema,
  connectorCatalogSchema,
  maskSecret,
  type ServerTestResult,
  serverTestResultSchema,
} from '@agentport/shared';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { implement } from '@orpc/server';
import { z } from 'zod';
import { actorOf } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { isPgCode } from '../../http/errors.js';
import { connectorCatalog } from './connector-catalog-data.js';
import { buildGeneratedServer } from './generated.js';
import * as repo from './repo.js';
import { getMcpToken, getServerWithSecrets } from './repo.js';
import { testStdioInSandbox } from './sandbox-probe.js';
import { assertSafeUrl, assertServerEndpoint } from './ssrf.js';
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
        await assertServerEndpoint(input.baseUrl, {
          nodeEnv: context.config.NODE_ENV,
          allowlist: context.config.GENERATED_PRIVATE_HOST_ALLOWLIST,
        });
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
    previewOpenApi: os.tools.previewOpenApi.handler(async ({ input, context }) => {
      const row = await repo.getServerRow(context.db, input.params.id);
      if (!row) return notFound('server');
      if (row.kind !== 'generated') {
        return fail('INVALID_INPUT', '仅 generated 连接器支持 OpenAPI 导入');
      }
      const { tools, warnings } = parseOpenApiDocument(input.body.spec);
      return { tools, warnings, total: tools.length };
    }),
    importOpenApi: os.tools.importOpenApi.handler(async ({ input, context }) => {
      const { id } = input.params;
      const row = await repo.getServerRow(context.db, id);
      if (!row) return notFound('server');
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
      const row = await repo.getServerRow(context.db, id);
      if (!row) return notFound('server');
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
      const server = await getServerWithSecrets(context.db, id, context.config.APP_SECRET_KEY);
      if (!server) return notFound('server');
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
        approvals: [tool.name],
        nodeEnv: context.config.NODE_ENV,
        privateHostAllowlist: context.config.GENERATED_PRIVATE_HOST_ALLOWLIST,
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
        // 只记录结果摘要：参数、解密头与响应体可能含敏感数据，不进审计。
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
