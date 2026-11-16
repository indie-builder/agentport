import { dataDomainsContract } from '@agentport/contract/data-domains';
import { encryptSecrets, fail } from '@agentport/core';
import { repo } from '@agentport/db';
import type { PermissionId } from '@agentport/shared';
import { implement } from '@orpc/server';
import { actorOf, authorize, authorizeObject } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { enqueueDataDomainBuild } from './use-cases.js';

const os = implement(dataDomainsContract).$context<RequestContext>();
const domains = repo.dataDomains;

type DataDomainRow = NonNullable<Awaited<ReturnType<typeof domains.getDataDomain>>>;
type DataDomainVersionRow = NonNullable<Awaited<ReturnType<typeof domains.getDataDomainVersion>>>;

const notFoundMessage = '数据域不存在，可能已被删除；请刷新后重试';

function toDataDomain(row: DataDomainRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    datasource: row.datasource,
    onlineVersionId: row.onlineVersionId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toVersion(row: DataDomainVersionRow) {
  return {
    id: row.id,
    dataDomainId: row.dataDomainId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function encodeCursor(row: DataDomainRow): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');
}

function decodeCursor(value: string): { createdAt: string; id: string } {
  const [raw, id, ...rest] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  if (raw === undefined || id === undefined || rest.length > 0 || Number.isNaN(Date.parse(raw))) {
    fail('INVALID_INPUT', '游标无效，请刷新后重试');
  }
  return { createdAt: new Date(raw).toISOString(), id };
}

async function loadDomain(context: RequestContext, id: string): Promise<DataDomainRow> {
  const row = await domains.getDataDomain(context.db, id);
  if (!row) fail('NOT_FOUND', notFoundMessage);
  return row;
}

async function authorizeDomain(
  context: RequestContext,
  permissionId: PermissionId,
  row: DataDomainRow,
): Promise<void> {
  await authorizeObject(
    context,
    permissionId,
    { objectId: row.id, createdBy: row.createdBy },
    notFoundMessage,
  );
}

export const dataDomainsRouter = os.router({
  list: os.list.handler(async ({ input, context }) => {
    await authorize(context, 'data_domains.read');
    const { cursor, limit } = input.query;
    const after = cursor === undefined ? null : decodeCursor(cursor);
    const rows = await domains.listDataDomains(context.db);
    const remaining =
      after === null
        ? rows
        : rows.filter((row) => {
            const createdAt = row.createdAt.toISOString();
            return (
              createdAt > after.createdAt || (createdAt === after.createdAt && row.id > after.id)
            );
          });
    const page = remaining.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toDataDomain),
      nextCursor: remaining.length > limit && last !== undefined ? encodeCursor(last) : null,
    };
  }),

  create: os.create.handler(async ({ input, context }) => {
    await authorize(context, 'data_domains.create');
    const { connection, ...rest } = input.body;
    const row = await domains.createDataDomain(context.db, {
      ...rest,
      connectionEncrypted: encryptSecrets(connection, context.config.APP_SECRET_KEY),
      createdBy: actorOf(context),
    });
    return toDataDomain(row);
  }),

  detail: os.detail.handler(async ({ input, context }) => {
    const row = await loadDomain(context, input.params.id);
    await authorizeDomain(context, 'data_domains.read', row);
    return toDataDomain(row);
  }),

  update: os.update.handler(async ({ input, context }) => {
    const existing = await loadDomain(context, input.params.id);
    await authorizeDomain(context, 'data_domains.update', existing);
    const { connection, name, slug, description, datasource } = input.body;
    const row = await domains.updateDataDomain(context.db, input.params.id, {
      ...(name === undefined ? {} : { name }),
      ...(slug === undefined ? {} : { slug }),
      ...(description === undefined ? {} : { description }),
      ...(datasource === undefined ? {} : { datasource }),
      ...(connection === undefined
        ? {}
        : { connectionEncrypted: encryptSecrets(connection, context.config.APP_SECRET_KEY) }),
    });
    if (!row) fail('NOT_FOUND', notFoundMessage);
    return toDataDomain(row);
  }),

  remove: os.remove.handler(async ({ input, context }) => {
    const existing = await loadDomain(context, input.params.id);
    await authorizeDomain(context, 'data_domains.delete', existing);
    const ok = await domains.deleteDataDomain(context.db, input.params.id);
    if (!ok) fail('NOT_FOUND', notFoundMessage);
    return undefined;
  }),

  versions: os.versions.handler(async ({ input, context }) => {
    const row = await loadDomain(context, input.params.id);
    await authorizeDomain(context, 'data_domains.read', row);
    const rows = await domains.listDataDomainVersions(context.db, input.params.id);
    return rows.map(toVersion);
  }),

  createVersion: os.createVersion.handler(async ({ input, context }) => {
    const row = await loadDomain(context, input.params.id);
    await authorizeDomain(context, 'data_domains.build', row);
    const version = await domains.createDataDomainVersion(
      context.db,
      input.params.id,
      input.body.projectFiles,
    );
    if (!version) fail('NOT_FOUND', notFoundMessage);
    await enqueueDataDomainBuild(context.db, context.log, version.dataDomainId, version.id);
    return toVersion(version);
  }),

  publish: os.publish.handler(async ({ input, context }) => {
    const row = await loadDomain(context, input.params.id);
    await authorizeDomain(context, 'data_domains.publish', row);
    const published = await domains.publishDataDomainVersion(
      context.db,
      input.params.id,
      input.body.versionId,
    );
    if (!published) fail('NOT_FOUND', notFoundMessage);
    return toDataDomain(published);
  }),
});
