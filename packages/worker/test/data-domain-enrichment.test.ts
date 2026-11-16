import { afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createDb, newId, repo, schema } from '@agentport/db';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { type EnrichQueryFn, runDataDomainEnrichment } from '../src/data-domains/enrich.js';
import { createIsolatedDatabase } from './isolated-db.js';

const logger = pino({ level: 'silent' });

const SOURCE = {
  'wren_project.yml':
    'schema_version: 5\nname: shop\nversion: "1.0"\ncatalog: wren\nschema: public\ndata_source: duckdb\n',
  'models/orders/metadata.yml': 'name: orders\ncolumns:\n  - name: id\n    type: INTEGER\n',
  'models/legacy/metadata.yml': 'name: legacy\ncolumns:\n  - name: id\n    type: INTEGER\n',
};

const isolated = await createIsolatedDatabase('worker_data_domain_enrich');
const dbHandle = createDb(isolated?.url ?? '');
const { db } = dbHandle;

async function probeDatabase(): Promise<boolean> {
  try {
    await dbHandle.client.unsafe('select 1');
    return true;
  } catch {
    return false;
  }
}

const ready = isolated !== null && (await probeDatabase());
const domainIds: string[] = [];

async function seedProposal(sourceFiles: Record<string, string> = SOURCE) {
  const slug = `dd-${randomUUID().slice(0, 8)}`;
  const domain = await repo.dataDomains.createDataDomain(db, {
    name: slug,
    slug,
    description: '',
    datasource: 'duckdb',
    connectionEncrypted: 'test',
    queryApprovalMode: 'off',
    createdBy: 'enrich-test',
  });
  domainIds.push(domain.id);
  const versionId = newId('dataDomainVersion');
  await db.insert(schema.dataDomainVersions).values({
    id: versionId,
    dataDomainId: domain.id,
    status: 'ready',
    projectFiles: sourceFiles,
    mdlManifest: '{}',
  });
  const proposal = await repo.dataDomains.createDataDomainEnrichmentProposal(db, {
    dataDomainId: domain.id,
    sourceVersionId: versionId,
    instruction: '补充订单表的业务含义与指标',
    createdBy: 'enrich-test',
  });
  if (!proposal) throw new Error('proposal not created');
  return { dataDomainId: domain.id, proposalId: proposal.id, versionId };
}

function resultMessage(structuredOutput: unknown): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    structured_output: structuredOutput,
  } as unknown as SDKMessage;
}

function reply(
  messages: SDKMessage[],
  captured: Array<{ prompt: string; options: Options }>,
): EnrichQueryFn {
  return ({ prompt, options }) => {
    captured.push({ prompt, options });
    return (async function* () {
      for (const message of messages) yield message;
    })();
  };
}

async function proposalOf(id: string) {
  return repo.dataDomains.getDataDomainEnrichmentProposal(db, id);
}

afterAll(async () => {
  if (ready) {
    for (const id of domainIds) {
      await db.delete(schema.dataDomains).where(eq(schema.dataDomains.id, id));
    }
  }
  await dbHandle.client.close().catch(() => undefined);
  await isolated?.close();
});

describe.skipIf(!ready)('runDataDomainEnrichment', () => {
  it('merges updated files and applies removed paths', async () => {
    const seeded = await seedProposal();
    const captured: Array<{ prompt: string; options: Options }> = [];
    await runDataDomainEnrichment(
      {
        db,
        logger,
        enrichModel: 'enrich-model',
        signal: new AbortController().signal,
        queryFn: reply(
          [
            resultMessage({
              summary: '补充订单语义与客户维表',
              updatedFiles: {
                'models/orders/metadata.yml':
                  'name: orders\ncolumns:\n  - name: id\n    type: INTEGER\n  - name: amount\n    type: DECIMAL\n',
                'models/customers/metadata.yml':
                  'name: customers\ncolumns:\n  - name: id\n    type: INTEGER\n',
              },
              removedPaths: ['models/legacy/metadata.yml'],
            }),
          ],
          captured,
        ),
      },
      seeded,
    );

    const options = captured[0]?.options;
    expect(options).toMatchObject({
      model: 'enrich-model',
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      settings: { autoMemoryEnabled: false },
      permissionMode: 'dontAsk',
      persistSession: false,
      maxTurns: 6,
      maxBudgetUsd: 0.5,
      outputFormat: { type: 'json_schema' },
    });
    expect(options?.env).toMatchObject({
      HOME: options?.cwd,
      CLAUDE_CONFIG_DIR: options?.cwd,
    });
    expect(captured[0]?.prompt).toContain('补充订单表的业务含义与指标');
    expect(captured[0]?.prompt).toContain('models/orders/metadata.yml');

    const proposal = await proposalOf(seeded.proposalId);
    expect(proposal?.status).toBe('ready');
    expect(proposal?.summary).toBe('补充订单语义与客户维表');
    expect(Object.keys(proposal?.projectFiles ?? {}).sort()).toEqual([
      'models/customers/metadata.yml',
      'models/orders/metadata.yml',
      'wren_project.yml',
    ]);
    expect(proposal?.projectFiles?.['models/orders/metadata.yml']).toContain('amount');
    expect(existsSync(options?.cwd ?? '')).toBe(false);
  });

  it('fails the proposal when the model returns malformed output', async () => {
    const seeded = await seedProposal();
    await runDataDomainEnrichment(
      {
        db,
        logger,
        enrichModel: 'enrich-model',
        signal: new AbortController().signal,
        queryFn: reply([resultMessage({ summary: '', updatedFiles: 'nope' })], []),
      },
      seeded,
    );

    const proposal = await proposalOf(seeded.proposalId);
    expect(proposal?.status).toBe('failed');
    expect(proposal?.error).toContain('不符合结构');
  });

  it('fails the proposal when the merged project is invalid', async () => {
    const seeded = await seedProposal();
    await runDataDomainEnrichment(
      {
        db,
        logger,
        enrichModel: 'enrich-model',
        signal: new AbortController().signal,
        queryFn: reply(
          [
            resultMessage({
              summary: '破坏项目文件',
              updatedFiles: { 'wren_project.yml': 'name: [unclosed' },
              removedPaths: [],
            }),
          ],
          [],
        ),
      },
      seeded,
    );

    const proposal = await proposalOf(seeded.proposalId);
    expect(proposal?.status).toBe('failed');
    expect(proposal?.error).toContain('不是合法 YAML');
  });

  it('fails the proposal when no enrich model is configured', async () => {
    const seeded = await seedProposal();
    let called = false;
    await runDataDomainEnrichment(
      {
        db,
        logger,
        enrichModel: undefined,
        signal: new AbortController().signal,
        queryFn: () => {
          called = true;
          return (async function* () {})();
        },
      },
      seeded,
    );

    const proposal = await proposalOf(seeded.proposalId);
    expect(proposal?.status).toBe('failed');
    expect(proposal?.error).toContain('DATA_DOMAIN_ENRICH_MODEL 未配置');
    expect(called).toBe(false);
  });
});
