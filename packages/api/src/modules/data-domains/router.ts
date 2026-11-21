import { dataDomainsContract } from '@agentport/contract/data-domains';
import { decryptSecrets, encryptSecrets, fail, validateWrenProjectFiles } from '@agentport/core';
import { repo } from '@agentport/db';
import type { DataDomainQueryApprovalStatus, PermissionId } from '@agentport/shared';
import { implement } from '@orpc/server';
import {
  actorOf,
  authorize,
  authorizeResourceAccess,
  resourceAccessFilter,
} from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { cursorOption, requireCursorPage } from '../../http/pagination.js';
import {
  deleteDataDomainServer,
  enqueueDataDomainBuild,
  enqueueDataDomainEnrichment,
  ensureDataDomainServer,
  generateDataDomainMdl,
  testDataDomainConnection,
} from './use-cases.js';

const os = implement(dataDomainsContract).$context<RequestContext>();
const domains = repo.dataDomains;

type DataDomainRow = NonNullable<Awaited<ReturnType<typeof domains.getDataDomain>>>;
type DataDomainVersionRow = NonNullable<Awaited<ReturnType<typeof domains.getDataDomainVersion>>>;
type EnrichmentProposalRow = NonNullable<
  Awaited<ReturnType<typeof domains.getDataDomainEnrichmentProposal>>
>;

const notFoundMessage = '数据域不存在，可能已被删除；请刷新后重试';

function toDataDomain(row: DataDomainRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    datasource: row.datasource,
    onlineVersionId: row.onlineVersionId,
    queryApprovalMode: row.queryApprovalMode,
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

function toVersionDetail(row: DataDomainVersionRow) {
  return {
    id: row.id,
    dataDomainId: row.dataDomainId,
    status: row.status,
    logTail: row.logTail,
    logTruncated: row.logTruncated,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toIdentity(row: {
  businessId: string;
  properties: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    businessId: row.businessId,
    properties: row.properties,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toQueryLog(row: {
  id: string;
  dataDomainId: string;
  versionId: string | null;
  serverId: string;
  runId: string;
  actorBusinessId: string | null;
  sqlSummary: string;
  rowCount: number | null;
  status: 'ok' | 'error';
  durationMs: number;
  createdAt: Date;
}) {
  return {
    id: row.id,
    dataDomainId: row.dataDomainId,
    versionId: row.versionId,
    serverId: row.serverId,
    runId: row.runId,
    actorBusinessId: row.actorBusinessId,
    sqlSummary: row.sqlSummary,
    rowCount: row.rowCount,
    status: row.status,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
  };
}

function toApproval(row: {
  id: string;
  dataDomainId: string;
  serverId: string;
  runId: string;
  actorBusinessId: string | null;
  sqlText: string;
  sqlHash: string;
  status: DataDomainQueryApprovalStatus;
  decisionNote: string;
  requestedAt: Date;
  decidedAt: Date | null;
  decidedByBusinessId: string | null;
}) {
  return {
    id: row.id,
    dataDomainId: row.dataDomainId,
    serverId: row.serverId,
    runId: row.runId,
    actorBusinessId: row.actorBusinessId,
    sqlText: row.sqlText,
    sqlHash: row.sqlHash,
    status: row.status,
    decisionNote: row.decisionNote,
    requestedAt: row.requestedAt.toISOString(),
    decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
    decidedByBusinessId: row.decidedByBusinessId,
  };
}

function toEnrichmentProposal(row: EnrichmentProposalRow) {
  return {
    id: row.id,
    dataDomainId: row.dataDomainId,
    sourceVersionId: row.sourceVersionId,
    status: row.status,
    instruction: row.instruction,
    summary: row.summary,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedByBusinessId: row.decidedByBusinessId,
  };
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
  level: 'read' | 'manage',
): Promise<void> {
  await authorizeResourceAccess(
    context,
    permissionId,
    {
      kind: 'data_domain',
      resourceId: row.id,
      ownerBusinessId: row.ownerBusinessId,
      level,
    },
    notFoundMessage,
  );
}

export const dataDomainsRouter = os.router({
  list: os.list.handler(async ({ input, context }) => {
    const access = await resourceAccessFilter(context, 'data_domains.read', 'data_domain', 'read');
    const { cursor, limit } = input.query;
    const page = requireCursorPage(
      await domains.listDataDomainPage(context.db, { access, limit, cursor }),
    );
    return {
      items: page.items.map(toDataDomain),
      nextCursor: page.nextCursor,
    };
  }),

  create: os.create.handler(async ({ input, context }) => {
    await authorize(context, 'data_domains.create');
    const { connection, ...rest } = input.body;
    const ownerBusinessId = actorOf(context);
    const row = await context.db.transaction(async (tx) => {
      const created = await domains.createDataDomain(tx, {
        ...rest,
        connectionEncrypted: encryptSecrets(connection, context.config.APP_SECRET_KEY),
        createdBy: ownerBusinessId,
        ownerBusinessId,
      });
      await ensureDataDomainServer(tx, {
        id: created.id,
        slug: created.slug,
        ownerBusinessId: created.ownerBusinessId,
      });
      return created;
    });
    return toDataDomain(row);
  }),

  testConnection: os.testConnection.handler(async ({ input, context }) => {
    await authorize(context, 'data_domains.create');
    return testDataDomainConnection(
      context.config.WREN_RUNTIME_URL,
      input.body.datasource,
      input.body.connection,
    );
  }),

  detail: os.detail.handler(async ({ input, context }) => {
    const row = await loadDomain(context, input.params.id);
    await authorizeDomain(context, 'data_domains.read', row, 'read');
    return toDataDomain(row);
  }),

  update: os.update.handler(async ({ input, context }) => {
    const existing = await loadDomain(context, input.params.id);
    await authorizeDomain(context, 'data_domains.update', existing, 'manage');
    const { connection, name, slug, description, datasource, queryApprovalMode } = input.body;
    const row = await context.db.transaction(async (tx) => {
      const updated = await domains.updateDataDomain(tx, input.params.id, {
        ...(name === undefined ? {} : { name }),
        ...(slug === undefined ? {} : { slug }),
        ...(description === undefined ? {} : { description }),
        ...(datasource === undefined ? {} : { datasource }),
        ...(queryApprovalMode === undefined ? {} : { queryApprovalMode }),
        ...(connection === undefined
          ? {}
          : { connectionEncrypted: encryptSecrets(connection, context.config.APP_SECRET_KEY) }),
      });
      if (!updated) return null;
      await ensureDataDomainServer(tx, {
        id: updated.id,
        slug: updated.slug,
        ownerBusinessId: updated.ownerBusinessId,
      });
      return updated;
    });
    if (!row) fail('NOT_FOUND', notFoundMessage);
    return toDataDomain(row);
  }),

  remove: os.remove.handler(async ({ input, context }) => {
    const existing = await loadDomain(context, input.params.id);
    await authorizeDomain(context, 'data_domains.delete', existing, 'manage');
    const ok = await context.db.transaction(async (tx) => {
      if (!(await domains.deleteDataDomain(tx, input.params.id))) return false;
      await deleteDataDomainServer(tx, existing.id);
      return true;
    });
    if (!ok) fail('NOT_FOUND', notFoundMessage);
    return undefined;
  }),

  versions: os.versions.handler(async ({ input, context }) => {
    const row = await loadDomain(context, input.params.id);
    await authorizeDomain(context, 'data_domains.read', row, 'read');
    const rows = await domains.listDataDomainVersions(context.db, input.params.id);
    return rows.map(toVersion);
  }),

  versionDetail: os.versionDetail.handler(async ({ input, context }) => {
    const row = await loadDomain(context, input.params.id);
    await authorizeDomain(context, 'data_domains.read', row, 'read');
    const version = await domains.getDataDomainVersion(context.db, input.params.versionId);
    if (!version || version.dataDomainId !== input.params.id) fail('NOT_FOUND', '版本不存在');
    return toVersionDetail(version);
  }),

  createVersion: os.createVersion.handler(async ({ input, context }) => {
    const row = await loadDomain(context, input.params.id);
    await authorizeDomain(context, 'data_domains.build', row, 'manage');
    const project = validateWrenProjectFiles(input.body.projectFiles);
    if (!project.ok) fail('INVALID_INPUT', project.error);
    const version = await domains.createDataDomainVersion(
      context.db,
      input.params.id,
      input.body.projectFiles,
    );
    if (!version) fail('NOT_FOUND', notFoundMessage);
    await enqueueDataDomainBuild(context.db, context.log, version.dataDomainId, version.id);
    return toVersion(version);
  }),

  generateMdl: os.generateMdl.handler(async ({ input, context }) => {
    const row = await loadDomain(context, input.params.id);
    await authorizeDomain(context, 'data_domains.build', row, 'manage');
    const connection = decryptSecrets(row.connectionEncrypted, context.config.APP_SECRET_KEY);
    const result = await generateDataDomainMdl(
      context.config.WREN_RUNTIME_URL,
      row.datasource,
      connection,
    );
    if (!result.ok) fail('INVALID_INPUT', result.error);
    const version = await domains.createDataDomainVersion(
      context.db,
      input.params.id,
      result.projectFiles,
    );
    if (!version) fail('NOT_FOUND', notFoundMessage);
    await enqueueDataDomainBuild(context.db, context.log, version.dataDomainId, version.id);
    return toVersion(version);
  }),

  publish: os.publish.handler(async ({ input, context }) => {
    const row = await loadDomain(context, input.params.id);
    await authorizeDomain(context, 'data_domains.publish', row, 'manage');
    const published = await domains.publishDataDomainVersion(
      context.db,
      input.params.id,
      input.body.versionId,
    );
    if (!published) fail('NOT_FOUND', notFoundMessage);
    return toDataDomain(published);
  }),

  identities: os.identities.handler(async ({ input, context }) => {
    const row = await loadDomain(context, input.params.id);
    await authorizeDomain(context, 'data_domains.read', row, 'read');
    const rows = await domains.listDataDomainIdentities(context.db, input.params.id);
    return rows.map(toIdentity);
  }),

  queryLogs: os.queryLogs.handler(async ({ input, context }) => {
    const row = await loadDomain(context, input.params.id);
    await authorizeDomain(context, 'data_domains.read', row, 'read');
    const { cursor, limit, status, runId } = input.query;
    const page = requireCursorPage(
      await domains.listDataDomainQueryLogs(context.db, {
        dataDomainId: input.params.id,
        limit,
        ...cursorOption(cursor),
        ...(status === undefined ? {} : { status }),
        ...(runId === undefined ? {} : { runId }),
      }),
    );
    return { items: page.items.map(toQueryLog), nextCursor: page.nextCursor };
  }),

  approvals: os.approvals.handler(async ({ input, context }) => {
    const row = await loadDomain(context, input.params.id);
    await authorizeDomain(context, 'data_domains.read', row, 'read');
    const { cursor, limit, status } = input.query;
    const page = requireCursorPage(
      await domains.listDataDomainQueryApprovals(context.db, {
        dataDomainId: input.params.id,
        limit,
        ...cursorOption(cursor),
        ...(status === undefined ? {} : { status }),
      }),
    );
    return { items: page.items.map(toApproval), nextCursor: page.nextCursor };
  }),

  decideApproval: os.decideApproval.handler(async ({ input, context }) => {
    const row = await loadDomain(context, input.params.id);
    await authorizeDomain(context, 'data_domains.update', row, 'manage');
    const status = input.body.decision === 'approve' ? 'approved' : 'rejected';
    const updated = await domains.decideDataDomainQueryApproval(context.db, {
      dataDomainId: input.params.id,
      approvalId: input.params.approvalId,
      status,
      decidedByBusinessId: actorOf(context),
      note: input.body.note,
    });
    if (!updated) fail('CONFLICT', '审批不存在或已处理');
    await repo.audit.writeAudit(
      context.db,
      {
        warn: () =>
          context.log.warn(
            { approvalId: input.params.approvalId },
            'data domain approval audit write failed',
          ),
      },
      {
        actor: actorOf(context),
        actorKind: 'user',
        action: 'data_domain.query.approval_decided',
        target: updated.id,
        status: 'ok',
        durationMs: 0,
        input: { dataDomainId: input.params.id, status, note: input.body.note.slice(0, 200) },
      },
    );
    return toApproval(updated);
  }),

  upsertIdentity: os.upsertIdentity.handler(async ({ input, context }) => {
    const row = await loadDomain(context, input.params.id);
    await authorizeDomain(context, 'data_domains.update', row, 'manage');
    const identity = await domains.upsertDataDomainIdentity(
      context.db,
      input.params.id,
      input.params.businessId,
      input.body.properties,
    );
    return toIdentity(identity);
  }),

  removeIdentity: os.removeIdentity.handler(async ({ input, context }) => {
    const row = await loadDomain(context, input.params.id);
    await authorizeDomain(context, 'data_domains.update', row, 'manage');
    const ok = await domains.deleteDataDomainIdentity(
      context.db,
      input.params.id,
      input.params.businessId,
    );
    if (!ok) fail('NOT_FOUND', '身份策略不存在');
    return undefined;
  }),

  enrich: os.enrich.handler(async ({ input, context }) => {
    const row = await loadDomain(context, input.params.id);
    await authorizeDomain(context, 'data_domains.build', row, 'manage');
    const source = await domains.getDataDomainVersion(context.db, input.body.sourceVersionId);
    if (!source || source.dataDomainId !== input.params.id) fail('NOT_FOUND', '源版本不存在');
    if (source.status !== 'ready') {
      fail('INVALID_INPUT', '只能基于已就绪的版本生成 enrich 提案');
    }
    const proposal = await domains.createDataDomainEnrichmentProposal(context.db, {
      dataDomainId: input.params.id,
      sourceVersionId: source.id,
      instruction: input.body.instruction,
      createdBy: actorOf(context),
    });
    if (!proposal) fail('NOT_FOUND', notFoundMessage);
    const queued = await enqueueDataDomainEnrichment(
      context.db,
      context.log,
      input.params.id,
      proposal.id,
    );
    if (!queued) fail('SERVICE_UNAVAILABLE', '生成任务入队失败，请稍后重试');
    return toEnrichmentProposal(proposal);
  }),

  proposals: os.proposals.handler(async ({ input, context }) => {
    const row = await loadDomain(context, input.params.id);
    await authorizeDomain(context, 'data_domains.read', row, 'read');
    const rows = await domains.listDataDomainEnrichmentProposals(context.db, input.params.id);
    return rows.map(toEnrichmentProposal);
  }),

  proposalDetail: os.proposalDetail.handler(async ({ input, context }) => {
    const row = await loadDomain(context, input.params.id);
    await authorizeDomain(context, 'data_domains.read', row, 'read');
    const proposal = await domains.getDataDomainEnrichmentProposal(
      context.db,
      input.params.proposalId,
    );
    if (!proposal || proposal.dataDomainId !== input.params.id) fail('NOT_FOUND', '提案不存在');
    const source = await domains.getDataDomainVersion(context.db, proposal.sourceVersionId);
    const sourceFiles = source?.projectFiles ?? {};
    const candidateFiles = proposal.projectFiles;
    const changedFiles =
      candidateFiles === null
        ? []
        : [
            ...Object.keys(candidateFiles)
              .filter((path) => !(path in sourceFiles))
              .map((path) => ({ path, status: 'added' as const })),
            ...Object.keys(sourceFiles)
              .filter((path) => !(path in candidateFiles))
              .map((path) => ({ path, status: 'removed' as const })),
            ...Object.keys(candidateFiles)
              .filter((path) => path in sourceFiles && candidateFiles[path] !== sourceFiles[path])
              .map((path) => ({ path, status: 'modified' as const })),
          ];
    return {
      ...toEnrichmentProposal(proposal),
      projectFiles: candidateFiles ?? {},
      changedFiles,
    };
  }),

  decideProposal: os.decideProposal.handler(async ({ input, context }) => {
    const row = await loadDomain(context, input.params.id);
    await authorizeDomain(context, 'data_domains.build', row, 'manage');
    const proposal = await domains.getDataDomainEnrichmentProposal(
      context.db,
      input.params.proposalId,
    );
    if (!proposal || proposal.dataDomainId !== input.params.id) fail('NOT_FOUND', '提案不存在');
    if (proposal.status !== 'ready') fail('CONFLICT', '提案当前状态不可决策');
    const decidedBy = actorOf(context);

    if (input.body.decision === 'reject') {
      const updated = await domains.decideDataDomainEnrichmentProposal(context.db, {
        id: proposal.id,
        dataDomainId: input.params.id,
        status: 'rejected',
        decidedBy,
      });
      if (!updated) fail('CONFLICT', '提案状态已变化，请刷新重试');
      return { proposal: toEnrichmentProposal(updated), version: null };
    }

    const files = proposal.projectFiles ?? {};
    const valid = validateWrenProjectFiles(files);
    if (!valid.ok) fail('INVALID_INPUT', valid.error);
    const applied = await context.db.transaction(async (tx) => {
      const decided = await domains.decideDataDomainEnrichmentProposal(tx, {
        id: proposal.id,
        dataDomainId: input.params.id,
        status: 'approved',
        decidedBy,
      });
      if (!decided) return null;
      const version = await domains.insertDataDomainVersion(tx, input.params.id, files);
      return { decided, version };
    });
    if (applied === null) fail('CONFLICT', '提案状态已变化，请刷新重试');
    await enqueueDataDomainBuild(context.db, context.log, input.params.id, applied.version.id);
    return {
      proposal: toEnrichmentProposal(applied.decided),
      version: toVersion(applied.version),
    };
  }),
});
