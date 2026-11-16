import { createHash } from 'node:crypto';
import { decryptSecrets } from '@agentport/core';
import { type Database, repo } from '@agentport/db';
import type {
  CallToolResult,
  McpHttpHandler,
  StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { Effect } from 'effect';
import type { Logger } from 'pino';
import { z } from 'zod';

export interface DataDomainServerInput {
  db: Database;
  dataDomainId: string;
  serverId: string;
  runId: string;
  secretKey: string;
  wrenRuntimeUrl: string;
  log: Logger;
  signal?: AbortSignal | undefined;
}

const runSqlInputSchema = z.strictObject({
  sql: z.string().trim().min(1).describe('Read-only SQL against the bound data domain models.'),
  maxRows: z.number().int().min(1).max(10_000).default(500),
});

const queryResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    columns: z.array(z.string()).max(200),
    rows: z.array(z.array(z.json())).max(10_000),
    rowCount: z.number().int().min(0).max(10_000),
    truncated: z.boolean(),
  }),
  z.object({ ok: z.literal(false) }),
]);

function toolError(code: string, message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: `${code}: ${message}` }] };
}

export function buildDataDomainServer(input: DataDomainServerInput): McpHttpHandler {
  const loadOnline = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const domain = await repo.dataDomains.getDataDomain(input.db, input.dataDomainId);
    signal.throwIfAborted();
    if (!domain?.onlineVersionId) return null;
    const version = await repo.dataDomains.getDataDomainVersion(input.db, domain.onlineVersionId);
    signal.throwIfAborted();
    if (
      !version ||
      version.dataDomainId !== input.dataDomainId ||
      version.status !== 'ready' ||
      !version.mdlManifest?.trim()
    ) {
      return null;
    }
    return { domain, version, mdlManifest: version.mdlManifest };
  };

  const auditQuery = async (
    sql: string,
    versionId: string | null,
    rowCount: number | null,
    succeeded: boolean,
    durationMs: number,
  ) =>
    repo.audit.writeAudit(
      input.db,
      {
        warn: () =>
          input.log.warn(
            { dataDomainId: input.dataDomainId, serverId: input.serverId, runId: input.runId },
            'data domain query audit write failed',
          ),
      },
      {
        actor: input.runId,
        actorKind: 'agent',
        action: 'data_domain.query',
        target: input.serverId,
        status: succeeded ? 'ok' : 'error',
        durationMs,
        input: {
          dataDomainId: input.dataDomainId,
          versionId,
          sql: sql.slice(0, 500),
          rowCount,
          status: succeeded ? 'success' : 'failed',
        },
      },
    );

  const recordQuery = async (entry: {
    sql: string;
    versionId: string | null;
    rowCount: number | null;
    succeeded: boolean;
    durationMs: number;
    actorBusinessId: string | null;
  }) => {
    await auditQuery(entry.sql, entry.versionId, entry.rowCount, entry.succeeded, entry.durationMs);
    await repo.dataDomains
      .writeDataDomainQueryLog(input.db, {
        dataDomainId: input.dataDomainId,
        versionId: entry.versionId,
        serverId: input.serverId,
        runId: input.runId,
        actorBusinessId: entry.actorBusinessId,
        sqlSummary: entry.sql.slice(0, 500),
        rowCount: entry.rowCount,
        status: entry.succeeded ? 'ok' : 'error',
        durationMs: entry.durationMs,
      })
      .catch(() =>
        input.log.warn(
          { dataDomainId: input.dataDomainId, runId: input.runId },
          'data domain query log write failed',
        ),
      );
  };

  return createMcpHandler(() => {
    const server = new McpServer({ name: `data-domain-${input.dataDomainId}`, version: '1.0.0' });

    const auditedInputSchema: StandardSchemaWithJSON<
      z.input<typeof runSqlInputSchema>,
      z.output<typeof runSqlInputSchema>
    > = {
      '~standard': {
        version: 1,
        vendor: 'zod',
        jsonSchema: runSqlInputSchema['~standard'].jsonSchema,
        validate: async (value) => {
          const parsed = runSqlInputSchema.safeParse(value);
          if (parsed.success) return { value: parsed.data };
          const sql = z.object({ sql: z.string().catch('') }).safeParse(value);
          const businessId = await repo.runs
            .getRunInitiator(input.db, input.runId)
            .catch(() => null);
          await recordQuery({
            sql: sql.success ? sql.data.sql : '',
            versionId: null,
            rowCount: null,
            succeeded: false,
            durationMs: 0,
            actorBusinessId: businessId,
          });
          return { issues: [{ message: 'INVALID_INPUT: 仅允许 sql 和 maxRows 查询参数' }] };
        },
      },
    };

    server.registerTool(
      'run_sql',
      {
        description:
          'Run read-only SQL against the published models of this bound data domain. Use get_mdl to discover models and columns first. Identity and row access are resolved by the server from the current run; do not pass session properties. Returns columns, rows, rowCount and truncated.',
        inputSchema: auditedInputSchema,
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      async (args, ctx) => {
        const startedAt = Date.now();
        let versionId: string | null = null;
        let rowCount: number | null = null;
        const actorBusinessId = await repo.runs
          .getRunInitiator(input.db, input.runId)
          .catch(() => null);
        const domainForApproval = await repo.dataDomains.getDataDomain(
          input.db,
          input.dataDomainId,
        );
        if (domainForApproval?.queryApprovalMode === 'all') {
          const sqlHash = createHash('sha256').update(args.sql.trim()).digest('hex');
          const latest = await repo.dataDomains.getLatestDataDomainQueryApproval(input.db, {
            dataDomainId: input.dataDomainId,
            runId: input.runId,
            sqlHash,
          });
          const pendingResult = (approvalId: string, message: string): CallToolResult => ({
            content: [
              {
                type: 'text',
                text: JSON.stringify({ status: 'pending_approval', approvalId, message }),
              },
            ],
          });
          if (latest?.status !== 'approved') {
            let result: CallToolResult;
            if (latest?.status === 'pending') {
              result = pendingResult(latest.id, '查询待审批，请审批通过后重试相同 SQL');
            } else if (latest?.status === 'rejected') {
              result = toolError(
                'QUERY_REJECTED',
                `查询已被审批拒绝${latest.decisionNote ? `：${latest.decisionNote}` : ''}`,
              );
            } else {
              const created = await repo.dataDomains.requestDataDomainQueryApproval(input.db, {
                dataDomainId: input.dataDomainId,
                serverId: input.serverId,
                runId: input.runId,
                actorBusinessId,
                sqlText: args.sql,
                sqlHash,
              });
              await repo.audit.writeAudit(
                input.db,
                {
                  warn: () =>
                    input.log.warn(
                      { dataDomainId: input.dataDomainId, runId: input.runId },
                      'data domain approval audit write failed',
                    ),
                },
                {
                  actor: input.runId,
                  actorKind: 'agent',
                  action: 'data_domain.query.approval_requested',
                  target: created.id,
                  status: 'ok',
                  durationMs: 0,
                  input: {
                    dataDomainId: input.dataDomainId,
                    serverId: input.serverId,
                    sqlHash,
                    sqlSummary: args.sql.slice(0, 500),
                  },
                },
              );
              result = pendingResult(created.id, '查询已提交审批，请审批通过后重试相同 SQL');
            }
            await recordQuery({
              sql: args.sql,
              versionId: null,
              rowCount: null,
              succeeded: false,
              durationMs: Date.now() - startedAt,
              actorBusinessId,
            });
            return result;
          }
        }
        const exit = await Effect.runPromiseExit(
          Effect.tryPromise({
            try: async (signal) => {
              const online = await loadOnline(signal);
              if (!online) {
                return toolError('no_online_version', '数据域没有可用的线上版本');
              }
              versionId = online.version.id;
              if (!input.wrenRuntimeUrl) {
                return toolError('QUERY_UNAVAILABLE', '数据查询服务未配置');
              }
              signal.throwIfAborted();
              const properties = actorBusinessId
                ? ((await repo.dataDomains.resolveDataDomainSessionProperties(
                    input.db,
                    input.dataDomainId,
                    actorBusinessId,
                  )) ?? {})
                : {};
              signal.throwIfAborted();
              const connection = decryptSecrets(online.domain.connectionEncrypted, input.secretKey);
              const response = await fetch(`${input.wrenRuntimeUrl.replace(/\/+$/, '')}/query`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  mdlManifest: online.mdlManifest,
                  datasource: online.domain.datasource,
                  connection,
                  sql: args.sql,
                  maxRows: args.maxRows,
                  properties,
                }),
                signal,
              });
              if (!response.ok) return toolError('QUERY_FAILED', '数据查询服务请求失败');
              const result = queryResponseSchema.parse(await response.json());
              signal.throwIfAborted();
              if (!result.ok)
                return toolError('QUERY_FAILED', '查询失败，请检查 SQL 或联系数据域管理员');
              const { columns, rows, truncated } = result;
              if (
                result.rowCount !== rows.length ||
                rows.length > args.maxRows ||
                rows.some((row) => row.length !== columns.length)
              ) {
                return toolError('QUERY_FAILED', '数据查询服务响应异常');
              }
              rowCount = result.rowCount;
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({ columns, rows, rowCount, truncated }),
                  },
                ],
              };
            },
            catch: () => 'QUERY_FAILED',
          }).pipe(Effect.timeout(30_000)),
          {
            signal: input.signal
              ? AbortSignal.any([input.signal, ctx.mcpReq.signal])
              : ctx.mcpReq.signal,
          },
        );
        const result =
          exit._tag === 'Success'
            ? exit.value
            : toolError('QUERY_FAILED', '数据查询失败、超时或已取消，请稍后重试');
        const succeeded = result.isError !== true;
        const durationMs = Date.now() - startedAt;
        await recordQuery({
          sql: args.sql,
          versionId,
          rowCount,
          succeeded,
          durationMs,
          actorBusinessId,
        });
        return result;
      },
    );

    server.registerTool(
      'get_mdl',
      {
        description:
          'Read the current published MDL manifest of this bound data domain to discover semantic models, columns and relationships before writing SQL.',
        inputSchema: z.strictObject({}),
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      async (_args, ctx) => {
        const exit = await Effect.runPromiseExit(
          Effect.tryPromise({
            try: async (signal) => {
              const online = await loadOnline(signal);
              if (!online) return toolError('no_online_version', '数据域没有可用的线上版本');
              return {
                content: [{ type: 'text' as const, text: online.mdlManifest }],
              };
            },
            catch: () => 'MDL_UNAVAILABLE',
          }).pipe(Effect.timeout(30_000)),
          {
            signal: input.signal
              ? AbortSignal.any([input.signal, ctx.mcpReq.signal])
              : ctx.mcpReq.signal,
          },
        );
        return exit._tag === 'Success'
          ? exit.value
          : toolError('MDL_UNAVAILABLE', '数据模型读取失败、超时或已取消，请稍后重试');
      },
    );

    return server;
  });
}
