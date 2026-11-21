import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, newId, repo, schema } from '@agentport/db';
import { and, eq } from 'drizzle-orm';
import { type ChunkDraft, type KnowledgeDeps, runIngest } from '../src/knowledge/ingestion.js';

const dbHandle = createDb(process.env.DATABASE_URL ?? '');
const { db } = dbHandle;

const quiet = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => quiet,
} as unknown as KnowledgeDeps['logger'];

const chunkStub = (markdown: string): ChunkDraft[] =>
  markdown
    .split(/\n{2,}/)
    .map((content) => content.trim())
    .filter(Boolean)
    .map((content) => ({
      kind: 'text' as const,
      heading: null,
      content,
      pageFrom: null,
      pageTo: null,
    }));

let fixture: Server;
let fixtureUrl = '';
let knowledgeDir = '';
const baseIds: string[] = [];

beforeAll(async () => {
  fixture = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (req.url !== '/embeddings') {
        res.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(raw) as { input: string[] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: parsed.input.map((_, index) => ({
            index,
            embedding: Array.from({ length: 1024 }, (_, i) => (i === 0 ? index + 1 : 0)),
          })),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind');
  fixtureUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  await dbHandle.client.close();
});

beforeEach(async () => {
  knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-auto-summary-'));
});
afterEach(async () => {
  if (baseIds.length > 0) {
    await dbHandle.client.unsafe('delete from knowledge_bases where id = any($1::text[])', [
      dbHandle.client.array(baseIds, 'TEXT'),
    ]);
    baseIds.length = 0;
  }
  await rm(knowledgeDir, { recursive: true, force: true });
});

const suffix = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

interface Fixture {
  baseId: string;
  deps: KnowledgeDeps;
  notified: Array<{ baseId: string; jobIds: string[] }>;
}

async function makeBase(
  settings: { autoSummary?: boolean | undefined },
  options: { summaryModel?: string | undefined } = { summaryModel: 'test-summary-model' },
): Promise<Fixture> {
  const id = suffix();
  const serverId = newId('server');
  await db
    .insert(schema.servers)
    .values({ id: serverId, name: `kb-auto-summary-${id}`, kind: 'knowledge', config: {} });
  const profileId = newId('knowledgeModelProfile');
  await db.insert(schema.knowledgeModelProfiles).values({
    id: profileId,
    kind: 'embedding',
    name: `emb-auto-summary-${id}`,
    endpointUrl: fixtureUrl,
    model: 'test',
    dimensions: 1024,
    enabled: true,
  });
  const base = await repo.knowledge.createBase(db, {
    slug: `kb-auto-summary-${id}`,
    name: `kb auto summary ${id}`,
    description: '',
    serverId,
    embeddingProfileId: profileId,
    rerankProfileId: null,
    settings: { chunkTokens: 400, chunkOverlap: 40, wikiAutoUpdate: false, ...settings },
  });
  const notified: Fixture['notified'] = [];
  baseIds.push(base.id);
  return {
    baseId: base.id,
    notified,
    deps: {
      db,
      logger: quiet,
      knowledgeDir,
      parse: async ({ data }) => ({ markdown: data.toString('utf8'), images: [], pageMap: [] }),
      chunkMarkdown: chunkStub,
      connectors: {},
      decrypt: () => ({}),
      summaryModel: options.summaryModel,
      onSummaryJobs: async (input) => {
        notified.push(input);
      },
    },
  };
}

async function writeBlob(data: Buffer): Promise<string> {
  const sha = createHash('sha256').update(data).digest('hex');
  await mkdir(join(knowledgeDir, 'blobs', sha.slice(0, 2)), { recursive: true });
  await writeFile(join(knowledgeDir, 'blobs', sha.slice(0, 2), sha), data);
  return sha;
}

async function startIngestForNewDocument(
  baseId: string,
  body: string,
): Promise<{ jobId: string; documentId: string; job: Parameters<typeof runIngest>[1] }> {
  const data = Buffer.from(body, 'utf8');
  const sha = await writeBlob(data);
  const document = await repo.knowledge.createDocument(db, {
    baseId,
    folderId: null,
    title: 'doc.md',
    sourceType: 'upload',
    sourceId: null,
    sourceUrl: null,
    sourcePath: null,
    mimeType: 'text/markdown',
    sizeBytes: data.length,
    metadata: { originalFilename: 'doc.md' },
  });
  await repo.knowledge.updateDocument(db, document.id, { contentHash: sha });
  const job = await repo.knowledge.createJob(db, {
    type: 'ingest',
    baseId,
    documentId: document.id,
    sourceId: null,
    payload: { type: 'ingest', documentId: document.id },
  });
  const claimed = await repo.knowledge.claimJob(db, job.id);
  if (!claimed) throw new Error('job not claimed');
  return { jobId: job.id, documentId: document.id, job: claimed };
}

async function summaryJobs(baseId: string) {
  return db
    .select()
    .from(schema.knowledgeJobs)
    .where(and(eq(schema.knowledgeJobs.baseId, baseId), eq(schema.knowledgeJobs.type, 'summary')));
}

describe('ingestion → auto summary', () => {
  it('enqueues one summary job for the published version when autoSummary is on', async () => {
    const fixtureBase = await makeBase({ autoSummary: true });
    const ingest = await startIngestForNewDocument(
      fixtureBase.baseId,
      '# 认证\n\n令牌有效期为 7 天。',
    );

    await runIngest(fixtureBase.deps, ingest.job, new AbortController().signal);

    const document = await repo.knowledge.getDocument(db, ingest.documentId);
    expect(document?.status).toBe('ready');
    const jobs = await summaryJobs(fixtureBase.baseId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({
      type: 'summary',
      baseId: fixtureBase.baseId,
      documentId: ingest.documentId,
      versionId: document?.currentVersionId,
    });
    expect(jobs[0]?.payload.versionId).toBeString();
    expect(fixtureBase.notified).toEqual([{ baseId: fixtureBase.baseId, jobIds: [jobs[0]?.id] }]);
  });

  it('does not enqueue when autoSummary is off', async () => {
    const fixtureBase = await makeBase({ autoSummary: false });
    const ingest = await startIngestForNewDocument(fixtureBase.baseId, '# 认证\n\n正文。');

    await runIngest(fixtureBase.deps, ingest.job, new AbortController().signal);

    expect(await summaryJobs(fixtureBase.baseId)).toHaveLength(0);
    expect(fixtureBase.notified).toHaveLength(0);
  });

  it('does not enqueue when no summary model is configured', async () => {
    const fixtureBase = await makeBase({ autoSummary: true }, { summaryModel: undefined });
    const ingest = await startIngestForNewDocument(fixtureBase.baseId, '# 认证\n\n正文。');

    await runIngest(fixtureBase.deps, ingest.job, new AbortController().signal);

    expect(await summaryJobs(fixtureBase.baseId)).toHaveLength(0);
    expect(fixtureBase.notified).toHaveLength(0);
  });
});
