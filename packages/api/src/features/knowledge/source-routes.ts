import { decryptSecrets, encryptSecrets } from '@agentport/core';
import { repo, schema } from '@agentport/db';
import {
  cronSchema,
  knowledgeSourceInputSchema,
  knowledgeSourceRangeExternalIdMax,
  knowledgeSourceRangeInputSchema,
} from '@agentport/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { INVALID_CRON_MESSAGE, isSchedulableCron } from '../../lib/cron.js';
import { AppError, isAppError, isPgCode, reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import { authorizeObject } from '../access.js';
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
  syncCron: cronSchema.nullable().optional(),
  // 空数组绝不解释成「全量范围」，与创建一致直接 400。
  ranges: z.array(knowledgeSourceRangeInputSchema).min(1).optional(),
});

type SourcePatch = z.infer<typeof sourcePatchSchema>;
const sourcePatchBodySchema = sourcePatchSchema.refine(
  (value) =>
    value.syncCron === undefined || value.syncCron === null || isSchedulableCron(value.syncCron),
  { message: INVALID_CRON_MESSAGE, path: ['syncCron'] },
);

const sourceBodySchema = knowledgeSourceInputSchema.refine(
  (value) => value.syncCron === null || isSchedulableCron(value.syncCron),
  { message: INVALID_CRON_MESSAGE, path: ['syncCron'] },
);

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

/** 新增九类来源各自允许的范围类型；Lark 复用飞书的 range kind。 */
const SOURCE_RANGE_KINDS: Partial<Record<SourceRow['type'], readonly string[]>> = {
  lark_wiki: ['wiki_space', 'wiki_node'],
  lark_drive: ['drive_folder'],
  notion: ['notion_page', 'notion_database', 'notion_data_source'],
  confluence: ['confluence_space', 'confluence_page'],
  yuque: ['yuque_repo'],
  dingtalk: ['dingtalk_workspace', 'dingtalk_node'],
  ima: ['ima_kb'],
  seafile: ['seafile_repo'],
  nextcloud: ['nextcloud_path'],
};

/** 连接身份字段创建后不可 PATCH 更换；凭证仍可轮换。 */
const SOURCE_IDENTITY_FIELDS: Partial<Record<SourceRow['type'], readonly string[]>> = {
  lark_wiki: ['appId'],
  lark_drive: ['appId'],
  confluence: ['authMode', 'baseUrl', 'email', 'cloudId'],
  dingtalk: ['clientId', 'operatorUnionId'],
  ima: ['clientId'],
  seafile: ['baseUrl'],
  nextcloud: ['baseUrl', 'username'],
};

const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/;
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const POSITIVE_ID = /^[1-9][0-9]*$/;
/** 拒绝字面/单次或多次百分号编码的斜杠与控制字符。 */
const ENCODED_PATH_BREAK = /%(25)*(2f|5c|00)/i;

/** 库内相对路径：保留大小写与 Unicode，拒绝越界与路径分隔符混淆。 */
function safeRelativePath(value: string): boolean {
  if (value.length === 0 || value.startsWith('/') || value.endsWith('/')) return false;
  if (/[\\\0?#]/.test(value) || ENCODED_PATH_BREAK.test(value)) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** 可配置站点只接受站点/应用根，不能塞入凭证、查询串或片段。 */
function siteUrlIssue(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '缺少 config.baseUrl';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'config.baseUrl 不是合法 URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'config.baseUrl 只支持 http/https';
  }
  if (url.username || url.password) return 'config.baseUrl 不能包含账号密码';
  if (url.search || url.hash) return 'config.baseUrl 不能包含查询串或片段';
  return null;
}

function identityIssues(
  type: SourceRow['type'],
  stored: Record<string, unknown>,
  submitted: Record<string, unknown>,
): string[] {
  const fields = SOURCE_IDENTITY_FIELDS[type];
  if (!fields) return [];
  const normalized = (value: unknown): unknown =>
    typeof value === 'string' ? value.trim() : (value ?? null);
  return fields
    .filter((field) => normalized(stored[field]) !== normalized(submitted[field]))
    .map((field) => `连接身份字段 config.${field} 创建后不可修改，请新建来源`);
}

type ConfigIssueRange = Pick<RangeRow, 'kind' | 'externalId' | 'ref' | 'paths' | 'enabled'>;

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

  const allowedKinds = SOURCE_RANGE_KINDS[type];
  if (allowedKinds) {
    const maxExternalId = (
      knowledgeSourceRangeExternalIdMax as Partial<Record<SourceRow['type'], number>>
    )[type];
    for (const range of ranges) {
      // 入口上限保证 worker 组合出的 `<connectionId>:<leaf externalId>` 不超 ZIP 的 500 字符。
      if (maxExternalId !== undefined && range.externalId.length > maxExternalId) {
        issues.push(`范围 ${range.externalId.slice(0, 40)} 的 ID 超过 ${maxExternalId} 字符`);
      }
      // ref/paths 是范围结构，即使停用也不接受新类型上的误填。
      if (range.ref !== null) issues.push(`范围 ${range.externalId} 不应填写 ref`);
      if (type === 'seafile') {
        if (new Set(range.paths).size !== range.paths.length) {
          issues.push(`范围 ${range.externalId} 的目录不能重复`);
        }
        for (const path of range.paths) {
          if (!safeRelativePath(path)) {
            issues.push(`范围 ${range.externalId} 的目录 ${path} 必须是库内相对路径`);
          }
        }
      } else if (range.paths.length > 0) {
        issues.push(`范围 ${range.externalId} 不支持 paths`);
      }
      if (!range.enabled) continue;
      if (!allowedKinds.includes(range.kind)) {
        issues.push(
          `范围 ${range.externalId} 的类型必须属于 ${allowedKinds.join('、')}（当前 ${range.kind}）`,
        );
      }
    }
  }

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
  if (type === 'lark_wiki' || type === 'lark_drive') {
    if (!text('appId')) issues.push('缺少 config.appId');
    if (!secrets?.appSecret) issues.push('缺少凭证 appSecret');
    for (const range of ranges) {
      if (!range.enabled) continue;
      if (!SAFE_TOKEN.test(range.externalId)) {
        issues.push(`范围 ${range.externalId} 不是合法的 Lark token`);
      }
    }
  }
  if (type === 'notion') {
    if (!secrets?.apiKey) issues.push('缺少凭证 apiKey');
    for (const range of ranges) {
      if (range.enabled && !UUID.test(range.externalId)) {
        issues.push(`范围 ${range.externalId} 不是合法的 Notion UUID`);
      }
    }
  }
  if (type === 'confluence') {
    const authMode = text('authMode');
    if (authMode !== 'cloud_basic' && authMode !== 'cloud_scoped' && authMode !== 'dc_pat') {
      issues.push('config.authMode 必须是 cloud_basic、cloud_scoped 或 dc_pat');
    }
    const urlIssue = siteUrlIssue(config.baseUrl);
    if (urlIssue) issues.push(urlIssue);
    if (authMode === 'cloud_basic' || authMode === 'cloud_scoped') {
      if (!text('email')) issues.push('缺少 config.email');
      if (!secrets?.apiToken) issues.push('缺少凭证 apiToken');
      if (secrets?.pat) issues.push('凭证 pat 仅用于 dc_pat 模式');
      if (authMode === 'cloud_scoped' && !text('cloudId')) issues.push('缺少 config.cloudId');
    }
    if (authMode === 'dc_pat') {
      if (!secrets?.pat) issues.push('缺少凭证 pat');
      if (secrets?.apiToken) issues.push('凭证 apiToken 仅用于 Cloud 模式');
    }
    for (const range of ranges) {
      if (range.enabled && !POSITIVE_ID.test(range.externalId)) {
        issues.push(`范围 ${range.externalId} 必须是 Confluence 数字 ID`);
      }
    }
  }
  if (type === 'yuque') {
    if (!secrets?.apiToken) issues.push('缺少凭证 apiToken');
    for (const range of ranges) {
      if (!range.enabled) continue;
      if (!POSITIVE_ID.test(range.externalId) || !Number.isSafeInteger(Number(range.externalId))) {
        issues.push(`范围 ${range.externalId} 必须是正整数知识库 ID`);
      }
    }
  }
  if (type === 'dingtalk') {
    if (!text('clientId')) issues.push('缺少 config.clientId');
    if (!text('operatorUnionId')) issues.push('缺少 config.operatorUnionId');
    if (!secrets?.clientSecret) issues.push('缺少凭证 clientSecret');
  }
  if (type === 'ima') {
    if (!text('clientId')) issues.push('缺少 config.clientId');
    if (!secrets?.apiKey) issues.push('缺少凭证 apiKey');
  }
  if (type === 'seafile') {
    const urlIssue = siteUrlIssue(config.baseUrl);
    if (urlIssue) issues.push(urlIssue);
    if (!secrets?.apiToken) issues.push('缺少凭证 apiToken');
    for (const range of ranges) {
      if (range.enabled && !UUID.test(range.externalId)) {
        issues.push(`范围 ${range.externalId} 必须是 Seafile 库 UUID`);
      }
    }
  }
  if (type === 'nextcloud') {
    const urlIssue = siteUrlIssue(config.baseUrl);
    if (urlIssue) issues.push(urlIssue);
    if (!text('username')) issues.push('缺少 config.username');
    if (!secrets?.appPassword) issues.push('缺少凭证 appPassword');
    for (const range of ranges) {
      if (!range.enabled) continue;
      const path = range.externalId;
      const valid = path === '/' || (path.startsWith('/') && safeRelativePath(path.slice(1)));
      if (!valid) issues.push(`范围 ${path} 必须是账号根目录下的绝对路径`);
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

  /**
   * 外壳只声明可编辑字段；配置默认值与凭证缺省依赖来源当前类型和已存行，
   * 因此在组合成完整输入后、这一处复用创建 schema 校验。
   */
  const parsePatchInput = (source: SourceRow, ranges: RangeRow[], body: SourcePatch) => {
    if (body.config === undefined && body.secrets === undefined && body.ranges === undefined) {
      return null;
    }
    const storedSecrets = source.secretsEncrypted
      ? (() => {
          try {
            return decryptSecrets(source.secretsEncrypted, secretKey());
          } catch {
            return null;
          }
        })()
      : null;
    const result = knowledgeSourceInputSchema.safeParse({
      type: source.type,
      name: body.name ?? source.name,
      syncCron: body.syncCron === undefined ? source.syncCron : body.syncCron,
      config: body.config ?? source.config,
      secrets: body.secrets ?? storedSecrets ?? {},
      ranges: body.ranges ?? ranges,
    });
    if (!result.success) {
      const issue = result.error.issues[0];
      const path = issue?.path.join('.');
      throw new AppError('INVALID_INPUT', issue?.message ?? '配置不合法', {
        ...(path ? { path } : {}),
      });
    }
    return result.data;
  };

  app.get(
    '/api/knowledge/bases/:id/sources',
    {
      config: { access: { kind: 'permission', permissionId: 'knowledge.read' } },
      schema: { params: baseParams, querystring: pageQuery },
    },
    async (request, reply) => {
      if (!(await repo.knowledge.getBase(app.db, request.params.id))) {
        return reject(reply, 'NOT_FOUND', '知识库不存在，可能已被删除');
      }
      await authorizeObject(
        app,
        request,
        'knowledge.read',
        { objectId: request.params.id },
        '对象不存在',
      );
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
    {
      config: { access: { kind: 'permission', permissionId: 'knowledge.sources.manage' } },
      schema: { params: baseParams, body: sourceBodySchema },
    },
    async (request, reply) => {
      const base = await repo.knowledge.getBase(app.db, request.params.id);
      if (!base) return reject(reply, 'NOT_FOUND', '知识库不存在，可能已被删除');
      await authorizeObject(
        app,
        request,
        'knowledge.sources.manage',
        { objectId: base.id },
        '对象不存在',
      );
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
    {
      config: { access: { kind: 'permission', permissionId: 'knowledge.sources.manage' } },
      schema: { params: sourceParams, body: sourcePatchBodySchema },
    },
    async (request, reply) => {
      const found = await loadSource(request.params.sourceId);
      if (!found) return reject(reply, 'NOT_FOUND', '来源不存在，可能已被删除');
      const { source, ranges } = found;
      await authorizeObject(
        app,
        request,
        'knowledge.sources.manage',
        { objectId: source.id },
        '对象不存在',
      );
      const body = request.body;

      // 身份字段只对新增九类固定；既有来源仍保留原有可编辑 config 行为。
      if (body.config !== undefined) {
        const issues = identityIssues(source.type, source.config, body.config);
        if (issues.length > 0) return reject(reply, 'INVALID_INPUT', issues.join('；'));
      }

      const parsed = parsePatchInput(source, ranges, body);
      if (parsed !== null) {
        const issues = configIssues(source.type, parsed.config, parsed.secrets, parsed.ranges);
        if (issues.length > 0) return reject(reply, 'INVALID_INPUT', issues.join('；'));
      }

      const nextConfig = parsed !== null && body.config !== undefined ? parsed.config : undefined;
      const nextSecrets =
        parsed !== null && body.secrets !== undefined
          ? (parsed.secrets as Record<string, string>)
          : undefined;
      const nextRanges = parsed !== null && body.ranges !== undefined ? parsed.ranges : undefined;
      const encrypted = encryptIfAny(nextSecrets);
      try {
        // 配置、范围与启停在同一个事务内生效：范围收缩立即撤权，不等下一次同步。
        const result = await repo.knowledge.replaceSourceScope(app.db, source.id, {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(nextConfig === undefined ? {} : { config: nextConfig }),
          ...(encrypted === undefined ? {} : { secretsEncrypted: encrypted }),
          ...(body.status === undefined ? {} : { status: body.status }),
          ...(body.syncCron === undefined ? {} : { syncCron: body.syncCron }),
          ...(nextRanges === undefined ? {} : { ranges: nextRanges }),
        });
        return {
          ...toSource(result.source, result.ranges),
          disabledDocumentIds: result.disabledDocumentIds,
        };
      } catch (err) {
        if (isPgCode(err, '23505')) return reject(reply, 'CONFLICT', '存在重复的来源范围');
        if (isAppError(err)) return reject(reply, err.code, err.message);
        throw err;
      }
    },
  );

  app.delete(
    '/api/knowledge/sources/:sourceId',
    {
      config: { access: { kind: 'permission', permissionId: 'knowledge.sources.manage' } },
      schema: { params: sourceParams, querystring: deleteQuery },
    },
    async (request, reply) => {
      const source = await repo.knowledge.getSource(app.db, request.params.sourceId);
      if (!source) return reject(reply, 'NOT_FOUND', '来源不存在，可能已被删除');
      await authorizeObject(
        app,
        request,
        'knowledge.sources.manage',
        { objectId: source.id },
        '对象不存在',
      );

      let affected: number;
      if (request.query.documents === 'keep') {
        // 契约 §3：默认保留历史引用，全部置 disabled，不物理删除；来源 ID 留在行上但已无授权。
        // 人工停用原因不被来源删除覆盖。
        const disabled = await repo.knowledge.disableDocumentsBySource(app.db, source.id);
        for (const document of disabled) {
          await repo.knowledge.markWikiStaleByDocument(app.db, document.id);
        }
        affected = disabled.length;
      } else {
        const rows = await app.db
          .select({ id: schema.knowledgeDocuments.id })
          .from(schema.knowledgeDocuments)
          .where(eq(schema.knowledgeDocuments.sourceConnectionId, source.id));
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

  // 本地配置错误在入口直接 400；其余进入既有队列做最小只读远程探针，不导入、不推进游标。
  app.post(
    '/api/knowledge/sources/:sourceId/test',
    {
      config: { access: { kind: 'permission', permissionId: 'knowledge.sources.manage' } },
      schema: { params: sourceParams },
    },
    async (request, reply) => {
      const found = await loadSource(request.params.sourceId);
      if (!found) return reject(reply, 'NOT_FOUND', '来源不存在，可能已被删除');
      const { source, ranges } = found;
      await authorizeObject(
        app,
        request,
        'knowledge.sources.manage',
        { objectId: source.id },
        '对象不存在',
      );
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
      if (issues.length > 0) return reject(reply, 'INVALID_INPUT', issues.join('；'));

      const job = await createJob(app.db, {
        baseId: source.baseId,
        documentId: null,
        sourceId: source.id,
        payload: { type: 'source_probe', sourceId: source.id },
      });
      try {
        await enqueueKnowledgeJob(job);
      } catch (err) {
        await app.db.delete(schema.knowledgeJobs).where(eq(schema.knowledgeJobs.id, job.id));
        if (isAppError(err)) return reject(reply, err.code, err.message);
        return reject(reply, 'SERVICE_UNAVAILABLE', '测试任务未能提交，请稍后重试');
      }
      return reply.status(202).send({ jobId: job.id });
    },
  );

  app.post(
    '/api/knowledge/sources/:sourceId/sync',
    {
      config: { access: { kind: 'permission', permissionId: 'knowledge.execute' } },
      schema: { params: sourceParams },
    },
    async (request, reply) => {
      const created = await repo.knowledge.createSyncJob(app.db, request.params.sourceId);
      if (created.status === 'not_found') {
        return reject(reply, 'NOT_FOUND', '来源不存在，可能已被删除');
      }
      if (created.status === 'not_active') {
        return reject(reply, 'CONFLICT', '来源未启用，无法同步');
      }
      if (created.status === 'in_progress') {
        return reject(reply, 'CONFLICT', '该来源已有同步任务在进行中');
      }
      // 入队失败时 queued pair 已完整落库，由既有 knowledge reconciler 补投。
      await enqueueKnowledgeJob(created.job);
      return reply.status(202).send({ jobId: created.job.id, syncRunId: created.run.id });
    },
  );

  app.get(
    '/api/knowledge/sources/:sourceId/runs',
    {
      config: { access: { kind: 'permission', permissionId: 'knowledge.read' } },
      schema: { params: sourceParams, querystring: pageQuery },
    },
    async (request, reply) => {
      if (!(await repo.knowledge.getSource(app.db, request.params.sourceId))) {
        return reject(reply, 'NOT_FOUND', '来源不存在，可能已被删除');
      }
      await authorizeObject(
        app,
        request,
        'knowledge.read',
        { objectId: request.params.sourceId },
        '对象不存在',
      );
      const page = await repo.knowledge.listSyncRuns(
        app.db,
        request.params.sourceId,
        pageOptions(request.query),
      );
      return { items: page.items.map(toRun), nextCursor: page.nextCursor };
    },
  );

  app.get(
    '/api/knowledge/sources/:sourceId/runs/:syncRunId/items',
    {
      config: { access: { kind: 'permission', permissionId: 'knowledge.read' } },
      schema: {
        params: z.object({
          sourceId: z.string().min(1),
          syncRunId: z.string().min(1),
        }),
        querystring: pageQuery.extend({ status: z.enum(['failed', 'skipped']).optional() }),
      },
    },
    async (request, reply) => {
      const source = await repo.knowledge.getSource(app.db, request.params.sourceId);
      if (!source) return reject(reply, 'NOT_FOUND', '来源不存在，可能已被删除');
      await authorizeObject(app, request, 'knowledge.read', { objectId: source.id }, '对象不存在');
      const [run] = await app.db
        .select({ id: schema.knowledgeSyncRuns.id })
        .from(schema.knowledgeSyncRuns)
        .where(
          and(
            eq(schema.knowledgeSyncRuns.id, request.params.syncRunId),
            eq(schema.knowledgeSyncRuns.sourceId, source.id),
          ),
        )
        .limit(1);
      if (!run) return reject(reply, 'NOT_FOUND', '同步记录不存在或不属于该来源');
      const page = await repo.knowledge.listSyncItems(app.db, run.id, {
        ...pageOptions(request.query),
        ...(request.query.status === undefined ? {} : { status: request.query.status }),
      });
      return {
        items: page.items.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })),
        nextCursor: page.nextCursor,
      };
    },
  );
}
