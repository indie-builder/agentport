import { AppError, decryptSecrets, encryptSecrets } from '@agentport/core';
import { type Database, repo, schema } from '@agentport/db';
import type { KnowledgeSourceInput, KnowledgeSourceStatus } from '@agentport/shared';
import { knowledgeSourceInputSchema, knowledgeSourceRangeExternalIdMax } from '@agentport/shared';
import { and, eq } from 'drizzle-orm';
import { isPgCode } from '../../../http/errors.js';
import { type PageQuery, pageOptions, requireCursorPage } from '../../../http/pagination.js';
import { INVALID_CRON_MESSAGE, isSchedulableCron } from '../../../lib/cron.js';
import { createJob, enqueueKnowledgeJobAfterCommit } from '../service.js';
import { enqueueSourceSync, type KnowledgeDeps, notFound } from './shared.js';

type RangeInput = KnowledgeSourceInput['ranges'][number];

type SourcePatch = {
  name?: string | undefined;
  config?: Record<string, unknown> | undefined;
  secrets?: Record<string, string> | undefined;
  status?: Exclude<KnowledgeSourceStatus, 'auth_error'> | undefined;
  syncCron?: string | null | undefined;
  ranges?: RangeInput[] | undefined;
};

export type KnowledgeSourceRow = typeof schema.knowledgeSources.$inferSelect;

type RangeRow = typeof schema.knowledgeSourceRanges.$inferSelect;

type SyncRunRow = typeof schema.knowledgeSyncRuns.$inferSelect;

async function sourceRow(db: Database, sourceId: string) {
  const source = await repo.knowledge.getSource(db, sourceId);
  if (!source) return null;
  return { source, ranges: await repo.knowledge.listRanges(db, source.id) };
}

const SENSITIVE_KEY = /(token|secret|password|apikey|credential)/i;

function publicConfig(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([key]) => !SENSITIVE_KEY.test(key)));
}

function toSource(row: KnowledgeSourceRow, ranges: RangeRow[]) {
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

const SOURCE_RANGE_KINDS: Partial<Record<KnowledgeSourceRow['type'], readonly string[]>> = {
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

const SOURCE_IDENTITY_FIELDS: Partial<Record<KnowledgeSourceRow['type'], readonly string[]>> = {
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

const BASE_URL_INVALID_MESSAGE = 'config.baseUrl 不是合法 URL';

const POSITIVE_ID = /^[1-9][0-9]*$/;

const ENCODED_PATH_BREAK = /%(25)*(2f|5c|00)/i;

function missingCredential(key: string): string {
  return `缺少凭证 ${key}`;
}

function missingConfig(key: string): string {
  return `缺少 config.${key}`;
}

function safeRelativePath(value: string): boolean {
  if (value.length === 0 || value.startsWith('/') || value.endsWith('/')) return false;
  if (/[\\\0?#]/.test(value) || ENCODED_PATH_BREAK.test(value)) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function siteUrlIssue(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return missingConfig('baseUrl');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return BASE_URL_INVALID_MESSAGE;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'config.baseUrl 只支持 http/https';
  }
  if (url.username || url.password) return 'config.baseUrl 不能包含账号密码';
  if (url.search || url.hash) return 'config.baseUrl 不能包含查询串或片段';
  return null;
}

function identityIssues(
  type: KnowledgeSourceRow['type'],
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

type ConfigIssueRange = {
  kind: string;
  externalId: string;
  ref: string | null;
  paths: string[];
  enabled: boolean;
};

function configIssues(
  type: KnowledgeSourceRow['type'],
  config: Record<string, unknown>,
  secrets: Record<string, string> | null,
  ranges: ConfigIssueRange[],
): string[] {
  const issues: string[] = [];
  const text = (key: string): string => {
    const value = config[key];
    return typeof value === 'string' ? value.trim() : '';
  };
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
      knowledgeSourceRangeExternalIdMax as Partial<Record<KnowledgeSourceRow['type'], number>>
    )[type];
    for (const range of ranges) {
      if (maxExternalId !== undefined && range.externalId.length > maxExternalId) {
        issues.push(`范围 ${range.externalId.slice(0, 40)} 的 ID 超过 ${maxExternalId} 字符`);
      }
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
    if (!text('appId')) issues.push(missingConfig('appId'));
    if (!secrets?.appSecret) issues.push(missingCredential('appSecret'));
    if (text('baseUrl') && !validUrl('baseUrl')) issues.push(BASE_URL_INVALID_MESSAGE);
  }
  if (type === 'gitlab') {
    if (!validUrl('baseUrl')) issues.push(BASE_URL_INVALID_MESSAGE);
    if (!text('projectId')) issues.push(missingConfig('projectId'));
    if (!text('ref')) issues.push(missingConfig('ref'));
    if (!secrets?.token) issues.push(missingCredential('token'));
  }
  if (type === 'github') {
    if (text('baseUrl') && !validUrl('baseUrl')) issues.push(BASE_URL_INVALID_MESSAGE);
    if (!text('projectId')) issues.push(missingConfig('projectId'));
    if (!secrets?.token) issues.push(missingCredential('token'));
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
    if (!text('appId')) issues.push(missingConfig('appId'));
    if (!secrets?.appSecret) issues.push(missingCredential('appSecret'));
    for (const range of ranges) {
      if (!range.enabled) continue;
      if (!SAFE_TOKEN.test(range.externalId)) {
        issues.push(`范围 ${range.externalId} 不是合法的 Lark token`);
      }
    }
  }
  if (type === 'notion') {
    if (!secrets?.apiKey) issues.push(missingCredential('apiKey'));
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
      if (!text('email')) issues.push(missingConfig('email'));
      if (!secrets?.apiToken) issues.push(missingCredential('apiToken'));
      if (secrets?.pat) issues.push('凭证 pat 仅用于 dc_pat 模式');
      if (authMode === 'cloud_scoped' && !text('cloudId')) issues.push(missingConfig('cloudId'));
    }
    if (authMode === 'dc_pat') {
      if (!secrets?.pat) issues.push(missingCredential('pat'));
      if (secrets?.apiToken) issues.push('凭证 apiToken 仅用于 Cloud 模式');
    }
    for (const range of ranges) {
      if (range.enabled && !POSITIVE_ID.test(range.externalId)) {
        issues.push(`范围 ${range.externalId} 必须是 Confluence 数字 ID`);
      }
    }
  }
  if (type === 'yuque') {
    if (!secrets?.apiToken) issues.push(missingCredential('apiToken'));
    for (const range of ranges) {
      if (!range.enabled) continue;
      if (!POSITIVE_ID.test(range.externalId) || !Number.isSafeInteger(Number(range.externalId))) {
        issues.push(`范围 ${range.externalId} 必须是正整数知识库 ID`);
      }
    }
  }
  if (type === 'dingtalk') {
    if (!text('clientId')) issues.push(missingConfig('clientId'));
    if (!text('operatorUnionId')) issues.push(missingConfig('operatorUnionId'));
    if (!secrets?.clientSecret) issues.push(missingCredential('clientSecret'));
  }
  if (type === 'ima') {
    if (!text('clientId')) issues.push(missingConfig('clientId'));
    if (!secrets?.apiKey) issues.push(missingCredential('apiKey'));
  }
  if (type === 'seafile') {
    const urlIssue = siteUrlIssue(config.baseUrl);
    if (urlIssue) issues.push(urlIssue);
    if (!secrets?.apiToken) issues.push(missingCredential('apiToken'));
    for (const range of ranges) {
      if (range.enabled && !UUID.test(range.externalId)) {
        issues.push(`范围 ${range.externalId} 必须是 Seafile 库 UUID`);
      }
    }
  }
  if (type === 'nextcloud') {
    const urlIssue = siteUrlIssue(config.baseUrl);
    if (urlIssue) issues.push(urlIssue);
    if (!text('username')) issues.push(missingConfig('username'));
    if (!secrets?.appPassword) issues.push(missingCredential('appPassword'));
    for (const range of ranges) {
      if (!range.enabled) continue;
      const path = range.externalId;
      const valid = path === '/' || (path.startsWith('/') && safeRelativePath(path.slice(1)));
      if (!valid) issues.push(`范围 ${path} 必须是账号根目录下的绝对路径`);
    }
  }
  return issues;
}

export async function listSources(deps: KnowledgeDeps, id: string, query: PageQuery) {
  if (!(await repo.knowledge.getBase(deps.db, id))) notFound('知识库');
  const page = requireCursorPage(await repo.knowledge.listSources(deps.db, id, pageOptions(query)));
  const rangesBySource = await repo.knowledge.listRangesBySourceIds(
    deps.db,
    page.items.map((row) => row.id),
  );
  const items = page.items.map((row) => toSource(row, rangesBySource.get(row.id) ?? []));
  return { items, nextCursor: page.nextCursor };
}

function encryptIfAny(
  deps: KnowledgeDeps,
  secrets: Record<string, string> | undefined,
): string | null | undefined {
  if (secrets === undefined) return undefined;
  return Object.keys(secrets).length > 0
    ? encryptSecrets(secrets, deps.config.APP_SECRET_KEY)
    : null;
}

export async function createSource(
  deps: KnowledgeDeps,
  id: string,
  input: {
    type: KnowledgeSourceRow['type'];
    name: string;
    config: Record<string, unknown>;
    secrets: Record<string, string>;
    syncCron: string | null;
    ranges: RangeInput[];
  },
) {
  const base = await repo.knowledge.getBase(deps.db, id);
  if (!base) notFound('知识库');
  if (input.syncCron !== null && !isSchedulableCron(input.syncCron, 'UTC')) {
    throw new AppError('INVALID_INPUT', INVALID_CRON_MESSAGE, { path: '/syncCron' });
  }
  const issues = configIssues(input.type, input.config, input.secrets, input.ranges);
  if (issues.length > 0) throw new AppError('INVALID_INPUT', issues.join('；'));
  const { source, ranges } = await repo.knowledge.createSource(deps.db, {
    baseId: base.id,
    type: input.type,
    name: input.name,
    config: input.config,
    secretsEncrypted: encryptIfAny(deps, input.secrets) ?? null,
    syncCron: input.syncCron,
    ranges: input.ranges,
  });
  return toSource(source, ranges);
}

function parsePatchInput(
  deps: KnowledgeDeps,
  source: KnowledgeSourceRow,
  ranges: RangeRow[],
  body: SourcePatch,
) {
  if (body.config === undefined && body.secrets === undefined && body.ranges === undefined) {
    return null;
  }
  const storedSecrets = source.secretsEncrypted
    ? (() => {
        try {
          return decryptSecrets(source.secretsEncrypted, deps.config.APP_SECRET_KEY);
        } catch {
          return null;
        }
      })()
    : null;
  const parsed = knowledgeSourceInputSchema.safeParse({
    type: source.type,
    name: body.name ?? source.name,
    syncCron: body.syncCron === undefined ? source.syncCron : body.syncCron,
    config: body.config ?? source.config,
    secrets: body.secrets ?? storedSecrets ?? {},
    ranges: body.ranges ?? ranges,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.');
    throw new AppError('INVALID_INPUT', issue?.message ?? '配置不合法', {
      ...(path ? { path } : {}),
    });
  }
  return parsed.data;
}

export async function updateSource(deps: KnowledgeDeps, sourceId: string, body: SourcePatch) {
  const found = await sourceRow(deps.db, sourceId);
  if (!found) notFound('来源');
  if (
    body.syncCron !== undefined &&
    body.syncCron !== null &&
    !isSchedulableCron(body.syncCron, 'UTC')
  ) {
    throw new AppError('INVALID_INPUT', INVALID_CRON_MESSAGE, { path: '/syncCron' });
  }
  const { source, ranges } = found;
  if (body.config !== undefined) {
    const issues = identityIssues(source.type, source.config, body.config);
    if (issues.length > 0) throw new AppError('INVALID_INPUT', issues.join('；'));
  }
  const parsed = parsePatchInput(deps, source, ranges, body);
  if (parsed !== null) {
    const issues = configIssues(source.type, parsed.config, parsed.secrets, parsed.ranges);
    if (issues.length > 0) throw new AppError('INVALID_INPUT', issues.join('；'));
  }
  const nextConfig = parsed !== null && body.config !== undefined ? parsed.config : undefined;
  const nextSecrets =
    parsed !== null && body.secrets !== undefined
      ? (parsed.secrets as Record<string, string>)
      : undefined;
  const nextRanges = parsed !== null && body.ranges !== undefined ? parsed.ranges : undefined;
  const encrypted = encryptIfAny(deps, nextSecrets);
  try {
    const result = await repo.knowledge.replaceSourceScope(deps.db, source.id, {
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
    if (isPgCode(err, '23505')) throw new AppError('CONFLICT', '存在重复的来源范围');
    throw err;
  }
}

export async function deleteSource(
  deps: KnowledgeDeps,
  sourceId: string,
  documents: 'keep' | 'delete',
) {
  const result = await repo.knowledge.deleteSource(deps.db, sourceId, documents);
  if (!result) notFound('来源');
  return result;
}

export async function testSource(deps: KnowledgeDeps, sourceId: string) {
  const found = await sourceRow(deps.db, sourceId);
  if (!found) notFound('来源');
  const { source, ranges } = found;
  const issues: string[] = [];
  let secrets: Record<string, string> | null = null;
  if (source.secretsEncrypted) {
    try {
      secrets = decryptSecrets(source.secretsEncrypted, deps.config.APP_SECRET_KEY);
    } catch {
      issues.push('已保存的凭证无法解密，请重新填写');
    }
  }
  issues.push(...configIssues(source.type, source.config, secrets, ranges));
  if (issues.length > 0) throw new AppError('INVALID_INPUT', issues.join('；'));
  const job = await createJob(deps.db, {
    baseId: source.baseId,
    documentId: null,
    sourceId: source.id,
    payload: { type: 'source_probe', sourceId: source.id },
  });
  await enqueueKnowledgeJobAfterCommit(deps.log, job);
  return { jobId: job.id };
}

export async function syncSource(deps: KnowledgeDeps, sourceId: string) {
  const created = await enqueueSourceSync(deps, sourceId);
  return { jobId: created.job.id, syncRunId: created.run.id };
}

export async function listSourceRuns(deps: KnowledgeDeps, sourceId: string, query: PageQuery) {
  if (!(await repo.knowledge.getSource(deps.db, sourceId))) notFound('来源');
  const page = requireCursorPage(
    await repo.knowledge.listSyncRuns(deps.db, sourceId, pageOptions(query)),
  );
  return { items: page.items.map(toRun), nextCursor: page.nextCursor };
}

export async function listSourceRunItems(
  deps: KnowledgeDeps,
  sourceId: string,
  syncRunId: string,
  query: PageQuery & { status?: 'failed' | 'skipped' | undefined },
) {
  const source = await repo.knowledge.getSource(deps.db, sourceId);
  if (!source) notFound('来源');
  const [run] = await deps.db
    .select({ id: schema.knowledgeSyncRuns.id })
    .from(schema.knowledgeSyncRuns)
    .where(
      and(
        eq(schema.knowledgeSyncRuns.id, syncRunId),
        eq(schema.knowledgeSyncRuns.sourceId, source.id),
      ),
    )
    .limit(1);
  if (!run) throw new AppError('NOT_FOUND', '同步记录不存在或不属于该来源');
  const page = requireCursorPage(
    await repo.knowledge.listSyncItems(deps.db, run.id, {
      ...pageOptions(query),
      ...(query.status === undefined ? {} : { status: query.status }),
    }),
  );
  return {
    items: page.items.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })),
    nextCursor: page.nextCursor,
  };
}
