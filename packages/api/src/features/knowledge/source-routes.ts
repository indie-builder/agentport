import { decryptSecrets, encryptSecrets } from '@agentport/core';
import { newId, repo, schema } from '@agentport/db';
import { knowledgeSourceInputSchema, knowledgeSourceRangeInputSchema } from '@agentport/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isPgCode, reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import { createJob, enqueueKnowledgeJob } from './service.js';

const baseParams = z.object({ id: z.string().min(1) });
const sourceParams = z.object({ sourceId: z.string().min(1) });

const pageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const deleteQuery = z.object({ documents: z.enum(['keep', 'delete']).default('keep') });

const sourcePatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.string()).optional(),
  status: z.enum(['active', 'paused', 'disabled']).optional(),
  syncCron: z
    .string()
    .regex(/^\S+ \S+ \S+ \S+ \S+$/, '需为 5 段 cron（分 时 日 月 周），UTC')
    .nullable()
    .optional(),
  // 空数组绝不解释成「全量范围」，与创建一致直接 400。
  ranges: z.array(knowledgeSourceRangeInputSchema).min(1).optional(),
});

type SourceRow = typeof schema.knowledgeSources.$inferSelect;
type RangeRow = typeof schema.knowledgeSourceRanges.$inferSelect;
type SyncRunRow = typeof schema.knowledgeSyncRuns.$inferSelect;

const SENSITIVE_KEY = /(token|secret|password|apikey|credential)/i;

/** config 里的凭证类字段永远不出现在响应里；hasSecret 才是对外信号。 */
function publicConfig(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([key]) => !SENSITIVE_KEY.test(key)));
}

function toSource(row: SourceRow, ranges: RangeRow[]) {
  return {
    id: row.id,
    baseId: row.baseId,
    type: row.type,
    name: row.name,
    config: publicConfig(row.config),
    hasSecret: row.secretsEncrypted !== null,
    status: row.status,
    syncCron: row.syncCron,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastSyncStatus: row.lastSyncStatus,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ranges: ranges.map((range) => ({
      id: range.id,
      kind: range.kind,
      externalId: range.externalId,
      ref: range.ref,
      paths: range.paths,
      enabled: range.enabled,
    })),
  };
}

function toRun(row: SyncRunRow) {
  return {
    id: row.id,
    sourceId: row.sourceId,
    status: row.status,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    cursorBefore: row.cursorBefore,
    cursorAfter: row.cursorAfter,
    stats: row.stats,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

const GITHUB_OWNER = /^[A-Za-z0-9-]+$/;
const GITHUB_REPO = /^[A-Za-z0-9._-]+$/;

/** 仓库范围必须是 owner/repo；. 与 .. 不是合法仓库名。 */
function githubRepoIssue(externalId: string): string | null {
  const [owner, repo, ...rest] = externalId.split('/');
  if (
    rest.length > 0 ||
    !owner ||
    !repo ||
    !GITHUB_OWNER.test(owner) ||
    !GITHUB_REPO.test(repo) ||
    repo === '.' ||
    repo === '..'
  ) {
    return `范围 ${externalId} 需为 owner/repo（owner 仅字母、数字、连字符，repo 不能是 . 或 ..）`;
  }
  return null;
}

type ConfigIssueRange = Pick<RangeRow, 'kind' | 'externalId' | 'enabled'>;

/**
 * 只校验配置形状与凭证存在性，不发外网请求；真实连通性由 sync run 结果体现。
 * 创建/PATCH/test 共用同一规则，避免三处漂移。
 */
function configIssues(
  type: SourceRow['type'],
  config: Record<string, unknown>,
  secrets: Record<string, string> | null,
  ranges: ConfigIssueRange[],
): string[] {
  const issues: string[] = [];
  const text = (key: string): string =>
    typeof config[key] === 'string' ? (config[key] as string).trim() : '';
  const validUrl = (key: string): boolean => {
    try {
      new URL(text(key));
      return true;
    } catch {
      return false;
    }
  };

  if (ranges.length === 0) issues.push('来源至少需要一个范围');
  else if (!ranges.some((range) => range.enabled)) issues.push('至少需要一个启用的范围');

  if (type === 'feishu_wiki' || type === 'feishu_drive') {
    if (!text('appId')) issues.push('缺少 config.appId');
    if (!secrets?.appSecret) issues.push('缺少凭证 appSecret');
    if (text('baseUrl') && !validUrl('baseUrl')) issues.push('config.baseUrl 不是合法 URL');
  }
  if (type === 'gitlab') {
    if (!validUrl('baseUrl')) issues.push('config.baseUrl 不是合法 URL');
    if (!text('projectId')) issues.push('缺少 config.projectId');
    if (!text('ref')) issues.push('缺少 config.ref');
    if (!secrets?.token) issues.push('缺少凭证 token');
  }
  if (type === 'github') {
    if (text('baseUrl') && !validUrl('baseUrl')) issues.push('config.baseUrl 不是合法 URL');
    if (!text('projectId')) issues.push('缺少 config.projectId');
    // ref 可空：worker 回落到仓库 default_branch。
    if (!secrets?.token) issues.push('缺少凭证 token');
    for (const range of ranges) {
      if (!range.enabled) continue;
      if (range.kind !== 'github_repo') {
        issues.push(`范围 ${range.externalId} 的类型必须是仓库（github_repo）`);
        continue;
      }
      const issue = githubRepoIssue(range.externalId);
      if (issue) issues.push(issue);
    }
  }
  return issues;
}

function pageOptions(query: { cursor?: string | undefined; limit?: number | undefined }): {
  cursor?: string;
  limit?: number;
} {
  return {
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  };
}

export function registerSourceRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };
  const secretKey = (): string => app.config.APP_SECRET_KEY;

  const encryptIfAny = (secrets: Record<string, string> | undefined): string | null | undefined => {
    if (secrets === undefined) return undefined;
    return Object.keys(secrets).length > 0 ? encryptSecrets(secrets, secretKey()) : null;
  };

  const loadSource = async (sourceId: string) => {
    const source = await repo.knowledge.getSource(app.db, sourceId);
    if (!source) return null;
    return { source, ranges: await repo.knowledge.listRanges(app.db, source.id) };
  };

  app.get(
    '/api/knowledge/bases/:id/sources',
    { ...auth, schema: { params: baseParams, querystring: pageQuery } },
    async (request, reply) => {
      if (!(await repo.knowledge.getBase(app.db, request.params.id))) {
        return reject(reply, 'NOT_FOUND', '知识库不存在，可能已被删除');
      }
      const page = await repo.knowledge.listSources(
        app.db,
        request.params.id,
        pageOptions(request.query),
      );
      const items = await Promise.all(
        page.items.map(async (row) =>
          toSource(row, await repo.knowledge.listRanges(app.db, row.id)),
        ),
      );
      return { items, nextCursor: page.nextCursor };
    },
  );

  app.post(
    '/api/knowledge/bases/:id/sources',
    { ...auth, schema: { params: baseParams, body: knowledgeSourceInputSchema } },
    async (request, reply) => {
      const base = await repo.knowledge.getBase(app.db, request.params.id);
      if (!base) return reject(reply, 'NOT_FOUND', '知识库不存在，可能已被删除');
      const input = request.body;
      // ranges 已由 shared schema 的 min(1) 保证非空。
      const issues = configIssues(input.type, input.config, input.secrets, input.ranges);
      if (issues.length > 0) return reject(reply, 'INVALID_INPUT', issues.join('；'));
      const source = await repo.knowledge.createSource(app.db, {
        baseId: base.id,
        type: input.type,
        name: input.name,
        config: input.config,
        secretsEncrypted: encryptIfAny(input.secrets) ?? null,
        syncCron: input.syncCron,
      });
      try {
        const ranges = await repo.knowledge.replaceRanges(app.db, source.id, input.ranges);
        return reply.status(201).send(toSource(source, ranges));
      } catch (err) {
        // 重复范围命中唯一索引：不留半建好的来源。
        await repo.knowledge.deleteSource(app.db, source.id);
        if (isPgCode(err, '23505')) return reject(reply, 'CONFLICT', '存在重复的来源范围');
        throw err;
      }
    },
  );

  app.patch(
    '/api/knowledge/sources/:sourceId',
    { ...auth, schema: { params: sourceParams, body: sourcePatchSchema } },
    async (request, reply) => {
      const found = await loadSource(request.params.sourceId);
      if (!found) return reject(reply, 'NOT_FOUND', '来源不存在，可能已被删除');
      const { source, ranges } = found;
      const body = request.body;

      if (body.config !== undefined || body.secrets !== undefined || body.ranges !== undefined) {
        const stored = source.secretsEncrypted
          ? (() => {
              try {
                return decryptSecrets(source.secretsEncrypted, secretKey());
              } catch {
                return null;
              }
            })()
          : null;
        const issues = configIssues(
          source.type,
          body.config ?? source.config,
          body.secrets ?? stored,
          body.ranges ?? ranges,
        );
        if (issues.length > 0) return reject(reply, 'INVALID_INPUT', issues.join('；'));
      }

      const encrypted = encryptIfAny(body.secrets);
      const updated = await repo.knowledge.updateSource(app.db, source.id, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.config === undefined ? {} : { config: body.config }),
        ...(encrypted === undefined ? {} : { secretsEncrypted: encrypted }),
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.syncCron === undefined ? {} : { syncCron: body.syncCron }),
      });
      if (!updated) return reject(reply, 'NOT_FOUND', '来源不存在，可能已被删除');
      // 禁用来源等于撤销其文档的读取权：文档停用并让引用它们的 Wiki 页显式 stale。
      if (body.status === 'disabled' && source.status !== 'disabled') {
        const disabled = await repo.knowledge.disableDocumentsBySource(app.db, source.id);
        for (const document of disabled) {
          await repo.knowledge.markWikiStaleByDocument(app.db, document.id);
        }
      }
      if (body.ranges === undefined) return toSource(updated, ranges);
      try {
        const nextRanges = await repo.knowledge.replaceRanges(app.db, source.id, body.ranges);
        return toSource(updated, nextRanges);
      } catch (err) {
        if (isPgCode(err, '23505')) return reject(reply, 'CONFLICT', '存在重复的来源范围');
        throw err;
      }
    },
  );

  app.delete(
    '/api/knowledge/sources/:sourceId',
    { ...auth, schema: { params: sourceParams, querystring: deleteQuery } },
    async (request, reply) => {
      const source = await repo.knowledge.getSource(app.db, request.params.sourceId);
      if (!source) return reject(reply, 'NOT_FOUND', '来源不存在，可能已被删除');

      let affected: number;
      if (request.query.documents === 'keep') {
        // 契约 §3：默认保留历史引用，全部置 disabled，不物理删除。
        const disabled = await app.db
          .update(schema.knowledgeDocuments)
          .set({ status: 'disabled', updatedAt: new Date() })
          .where(
            and(
              eq(schema.knowledgeDocuments.baseId, source.baseId),
              sql`${schema.knowledgeDocuments.metadata}->>'knowledgeSourceId' = ${source.id}`,
            ),
          )
          .returning({ id: schema.knowledgeDocuments.id });
        for (const document of disabled) {
          await repo.knowledge.markWikiStaleByDocument(app.db, document.id);
        }
        affected = disabled.length;
      } else {
        // 文档表没有指向来源的外键：归属记在 metadata.knowledgeSourceId。
        const rows = await app.db
          .select({ id: schema.knowledgeDocuments.id })
          .from(schema.knowledgeDocuments)
          .where(
            and(
              eq(schema.knowledgeDocuments.baseId, source.baseId),
              sql`${schema.knowledgeDocuments.metadata}->>'knowledgeSourceId' = ${source.id}`,
            ),
          );
        for (const row of rows) {
          await repo.knowledge.markWikiStaleByDocument(app.db, row.id);
          await repo.knowledge.deleteDocument(app.db, row.id);
        }
        affected = rows.length;
      }
      await repo.knowledge.deleteSource(app.db, source.id);
      return { documents: request.query.documents, affected };
    },
  );

  // 只查本地配置与凭证；真实连通性由 sync run 的结果体现。
  app.post(
    '/api/knowledge/sources/:sourceId/test',
    { ...auth, schema: { params: sourceParams } },
    async (request, reply) => {
      const found = await loadSource(request.params.sourceId);
      if (!found) return reject(reply, 'NOT_FOUND', '来源不存在，可能已被删除');
      const { source, ranges } = found;
      const issues: string[] = [];
      let secrets: Record<string, string> | null = null;
      if (source.secretsEncrypted) {
        try {
          secrets = decryptSecrets(source.secretsEncrypted, secretKey());
        } catch {
          issues.push('已保存的凭证无法解密，请重新填写');
        }
      }
      issues.push(...configIssues(source.type, source.config, secrets, ranges));
      return { ok: issues.length === 0, issues };
    },
  );

  app.post(
    '/api/knowledge/sources/:sourceId/sync',
    { ...auth, schema: { params: sourceParams } },
    async (request, reply) => {
      const source = await repo.knowledge.getSource(app.db, request.params.sourceId);
      if (!source) return reject(reply, 'NOT_FOUND', '来源不存在，可能已被删除');
      if (source.status !== 'active') {
        return reject(reply, 'CONFLICT', '来源未启用，无法同步');
      }
      // shortcut: 非事务检查，与定时触发并发时仍可能各建一条；要严格串行再复用 scheduler 的 advisory lock。
      const [activeJob] = await app.db
        .select({ id: schema.knowledgeJobs.id })
        .from(schema.knowledgeJobs)
        .where(
          and(
            eq(schema.knowledgeJobs.sourceId, source.id),
            inArray(schema.knowledgeJobs.status, ['queued', 'running']),
          ),
        )
        .limit(1);
      if (activeJob) return reject(reply, 'CONFLICT', '该来源已有同步任务在进行中');
      // 先落 run 再落 job：worker 认领时 run 必须已存在，检查点才有行可写。
      const [run] = await app.db
        .insert(schema.knowledgeSyncRuns)
        .values({
          id: newId('knowledgeSyncRun'),
          sourceId: source.id,
          status: 'queued',
          cursorBefore: source.cursor,
        })
        .returning();
      if (!run) throw new Error('knowledge sync run insert returned no row');
      const job = await createJob(app.db, {
        baseId: source.baseId,
        documentId: null,
        sourceId: source.id,
        payload: { type: 'sync', sourceId: source.id, syncRunId: run.id },
      });
      await enqueueKnowledgeJob(job);
      return reply.status(202).send({ jobId: job.id, syncRunId: run.id });
    },
  );

  app.get(
    '/api/knowledge/sources/:sourceId/runs',
    { ...auth, schema: { params: sourceParams, querystring: pageQuery } },
    async (request, reply) => {
      if (!(await repo.knowledge.getSource(app.db, request.params.sourceId))) {
        return reject(reply, 'NOT_FOUND', '来源不存在，可能已被删除');
      }
      const page = await repo.knowledge.listSyncRuns(
        app.db,
        request.params.sourceId,
        pageOptions(request.query),
      );
      return { items: page.items.map(toRun), nextCursor: page.nextCursor };
    },
  );
}
