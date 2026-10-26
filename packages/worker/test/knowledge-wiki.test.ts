import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, newId, repo, schema } from '@agentport/db';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeCancelled } from '../src/knowledge/ingestion.js';
import {
  runWikiGenerate,
  WIKI_ALLOWED_TOOLS,
  type WikiGenerateDeps,
  type WikiQueryFn,
} from '../src/knowledge/wiki.js';

const dbHandle = createDb(process.env.DATABASE_URL ?? '');
const { db } = dbHandle;

let knowledgeDir = '';

interface Fixture {
  baseId: string;
}

const suffix = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function makeBase(): Promise<Fixture> {
  const id = suffix();
  const serverId = newId('server');
  await db
    .insert(schema.servers)
    .values({ id: serverId, name: `kb-wiki-${id}`, kind: 'knowledge', config: {} });
  const profileId = newId('knowledgeModelProfile');
  await db.insert(schema.knowledgeModelProfiles).values({
    id: profileId,
    kind: 'embedding',
    name: `emb-wiki-${id}`,
    endpointUrl: 'http://127.0.0.1:1/embeddings',
    model: 'test',
    dimensions: 1024,
    enabled: true,
  });
  const base = await repo.knowledge.createBase(db, {
    slug: `kb-wiki-${id}`,
    name: `kb wiki ${id}`,
    description: '',
    serverId,
    embeddingProfileId: profileId,
    rerankProfileId: null,
    settings: { chunkTokens: 400, chunkOverlap: 40, wikiAutoUpdate: false },
  });
  return { baseId: base.id };
}

async function makeJob(
  baseId: string,
  payload: { pageId?: string; title?: string; sourceDocumentIds?: string[] } = {},
): Promise<string> {
  const job = await repo.knowledge.createJob(db, {
    type: 'wiki_generate',
    baseId,
    documentId: null,
    sourceId: null,
    payload: { type: 'wiki_generate', baseId, ...payload },
  });
  const claimed = await repo.knowledge.claimJob(db, job.id);
  if (!claimed) throw new Error('job not claimed');
  return job.id;
}

async function mustGetJob(id: string) {
  const job = await repo.knowledge.getJob(db, id);
  if (!job) throw new Error(`job ${id} missing`);
  return job;
}

const deps = (overrides: Partial<WikiGenerateDeps> = {}): WikiGenerateDeps => ({
  db,
  config: { KNOWLEDGE_DIR: knowledgeDir, KNOWLEDGE_WIKI_MODEL: 'wiki-test-model' },
  signal: new AbortController().signal,
  ...overrides,
});

type ToolHandler = (
  args: unknown,
) => Promise<{ isError?: boolean; content?: Array<{ text: string }> }>;

/** 从 SDK 实际注册的 in-process server 里取工具；只调用真实 handler，不复制逻辑。 */
function toolsOf(options: Options): Record<string, ToolHandler> {
  const server = options.mcpServers?.knowledge as unknown as {
    instance: {
      _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => unknown }>;
    };
  };
  return Object.fromEntries(
    Object.entries(server.instance._registeredTools).map(([name, tool]) => [
      name,
      (args: unknown) => tool.handler(args, {}) as ReturnType<ToolHandler>,
    ]),
  );
}

function mustTool(tools: Record<string, ToolHandler>, name: string): ToolHandler {
  const handler = tools[name];
  if (!handler) throw new Error(`tool ${name} not registered`);
  return handler;
}

/** 假 query：拿到真实注册的工具后按脚本调用，最后给一条成功 result。 */
function fakeQuery(
  script: (tools: Record<string, ToolHandler>, options: Options) => Promise<void>,
): WikiQueryFn {
  return (params) => {
    const tools = toolsOf(params.options);
    async function* run(): AsyncGenerator<SDKMessage> {
      await script(tools, params.options);
      yield { type: 'result', subtype: 'success', is_error: false } as SDKMessage;
    }
    return run();
  };
}

async function seedChunk(baseId: string, markdown: string, enabled = true) {
  const documentId = newId('knowledgeDocument');
  await db.insert(schema.knowledgeDocuments).values({
    id: documentId,
    baseId,
    title: 'doc.md',
    sourceType: 'upload',
    mimeType: 'text/markdown',
    status: 'ready',
  });
  const version = await repo.knowledge.createVersion(db, {
    documentId,
    blobSha256: 'a'.repeat(64),
    markdownSha256: 'b'.repeat(64),
    originalFilename: 'doc.md',
    mimeType: 'text/markdown',
    sizeBytes: markdown.length,
    sourceRevision: null,
    parseStatus: 'parsed',
    pageMap: [],
    images: [],
    embeddingProfileId: (await repo.knowledge.getBase(db, baseId))?.embeddingProfileId ?? '',
  });
  await repo.knowledge.setCurrentVersion(db, documentId, version.id);
  const chunks = await repo.knowledge.insertChunks(db, {
    baseId,
    documentId,
    versionId: version.id,
    folderId: null,
    chunks: [
      {
        ordinal: 0,
        kind: 'text',
        heading: null,
        content: markdown,
        searchText: markdown,
        embedding: null,
        pageFrom: null,
        pageTo: null,
        tokenCount: 10,
      },
    ],
  });
  const chunk = chunks[0];
  if (!chunk) throw new Error('chunk missing');
  if (!enabled) await repo.knowledge.patchChunk(db, chunk.id, { enabled: false });
  return { documentId, versionId: version.id, chunkId: chunk.id };
}

beforeAll(async () => {
  knowledgeDir = await mkdtemp(join(tmpdir(), 'wiki-worker-'));
});

afterAll(async () => {
  if (knowledgeDir) await rm(knowledgeDir, { recursive: true, force: true });
  await dbHandle.pool.end();
});

describe('runWikiGenerate', () => {
  const baseIds: string[] = [];

  beforeEach(async () => {
    if (baseIds.length > 0) {
      await dbHandle.pool.query('delete from knowledge_bases where id = any($1::text[])', [
        baseIds,
      ]);
      baseIds.length = 0;
    }
  });

  async function fixture() {
    const created = await makeBase();
    baseIds.push(created.baseId);
    return created;
  }

  it('registers the three tools and isolates the SDK session from host config', async () => {
    const { baseId } = await fixture();
    const page = await repo.knowledge.createWikiPage(db, { baseId, slug: 'auth', title: '认证' });
    const jobId = await makeJob(baseId, { pageId: page.id });

    let seen: Options | undefined;
    const queryFn: WikiQueryFn = (params) => {
      seen = params.options;
      async function* run(): AsyncGenerator<SDKMessage> {
        const tools = toolsOf(params.options);
        await mustTool(tools, 'wiki_save_draft')({ markdown: '# 草稿', sourceChunkIds: [] });
        yield { type: 'result', subtype: 'success', is_error: false } as SDKMessage;
      }
      return run();
    };
    await runWikiGenerate(await mustGetJob(jobId), deps({ queryFn }));

    expect(WIKI_ALLOWED_TOOLS).toEqual([
      'mcp__knowledge__wiki_search',
      'mcp__knowledge__wiki_read',
      'mcp__knowledge__wiki_save_draft',
    ]);
    const server = seen?.mcpServers?.knowledge as unknown as { name: string };
    expect(server.name).toBe('knowledge');
    expect(seen).toMatchObject({
      model: 'wiki-test-model',
      tools: [],
      strictMcpConfig: true,
      allowedTools: WIKI_ALLOWED_TOOLS,
      settingSources: [],
      permissionMode: 'dontAsk',
      maxTurns: 12,
      maxBudgetUsd: 0.5,
      // 临时会话不落盘：CLI 退出慢于 rm 时也没有会话文件可重建。
      persistSession: false,
    });
    expect(seen?.settings).toMatchObject({ autoMemoryEnabled: false });
    // cwd/HOME 都在知识目录下：不读 worker 项目文件，也不写宿主私有目录。
    expect(seen?.cwd?.startsWith(join(knowledgeDir, 'wiki-sdk'))).toBe(true);
    expect(seen?.env?.HOME).toBe(seen?.cwd);
    expect(seen?.env?.CLAUDE_CONFIG_DIR).toBe(seen?.cwd);
    // 主密钥与数据库串绝不能进入子进程 env。
    expect(seen?.env).not.toHaveProperty('DATABASE_URL');
    expect(seen?.env).not.toHaveProperty('APP_SECRET_KEY');
    expect(seen?.env).not.toHaveProperty('REDIS_URL');

    const job = await mustGetJob(jobId);
    // 终态由队列统一写入：生成器只负责执行与保存。
    expect(job.status).toBe('running');
    const after = await repo.knowledge.getWikiPage(db, page.id);
    expect(after?.status).toBe('draft');
    expect(after?.currentVersionId).not.toBeNull();
    // 会话目录按 job 隔离且不残留。
    const cwd = seen?.cwd ?? '';
    expect(await stat(cwd).catch(() => null)).toBeNull();
  });

  it('adds a draft version without replacing a published page', async () => {
    const { baseId } = await fixture();
    const page = await repo.knowledge.createWikiPage(db, { baseId, slug: 'auth', title: '认证' });
    const published = await repo.knowledge.saveWikiVersion(db, page.id, {
      markdown: '# 已发布',
      sourceChunkIds: [],
      model: 'manual',
      generatedBy: 'manual',
    });
    const before = await repo.knowledge.getWikiPage(db, page.id);
    expect(before?.status).toBe('published');

    const jobId = await makeJob(baseId, { pageId: page.id });
    await runWikiGenerate(
      await mustGetJob(jobId),
      deps({
        queryFn: fakeQuery(async (tools) => {
          await mustTool(tools, 'wiki_save_draft')({ markdown: '# 草稿', sourceChunkIds: [] });
        }),
      }),
    );

    const after = await repo.knowledge.getWikiPage(db, page.id);
    expect(after?.status).toBe('published');
    expect(after?.currentVersionId).toBe(published?.id);
    const versions = await repo.knowledge.listWikiVersions(db, page.id);
    expect(versions.items).toHaveLength(2);
    expect(versions.items.find((row) => row.id === published?.id)?.markdown).toBe('# 已发布');
    const draft = versions.items.find((row) => row.id !== published?.id);
    expect(draft).toMatchObject({
      markdown: '# 草稿',
      generatedBy: 'sdk',
      model: 'wiki-test-model',
    });
  });

  it('only accepts source chunks that are enabled, current and in scope', async () => {
    const { baseId } = await fixture();
    const inScope = await seedChunk(baseId, '认证 使用 会话');
    const outOfScope = await seedChunk(baseId, '计费 使用 发票');
    const disabled = await seedChunk(baseId, '认证 旧内容', false);
    const page = await repo.knowledge.createWikiPage(db, { baseId, slug: 'auth', title: '认证' });
    const jobId = await makeJob(baseId, {
      pageId: page.id,
      sourceDocumentIds: [inScope.documentId],
    });

    let searchHits: unknown[] = [];
    await runWikiGenerate(
      await mustGetJob(jobId),
      deps({
        queryFn: fakeQuery(async (tools) => {
          const search = await mustTool(tools, 'wiki_search')({ q: '认证' });
          searchHits = JSON.parse(search.content?.[0]?.text ?? '{}').hits;
          const readOut = await mustTool(
            tools,
            'wiki_read',
          )({
            documentId: outOfScope.documentId,
          });
          expect(readOut.isError).toBe(true);

          const badChunk = await mustTool(
            tools,
            'wiki_save_draft',
          )({
            markdown: '# 草稿',
            sourceChunkIds: [outOfScope.chunkId],
          });
          expect(badChunk.isError).toBe(true);
          const disabledChunk = await mustTool(
            tools,
            'wiki_save_draft',
          )({
            markdown: '# 草稿',
            sourceChunkIds: [disabled.chunkId],
          });
          expect(disabledChunk.isError).toBe(true);

          const ok = await mustTool(
            tools,
            'wiki_save_draft',
          )({
            markdown: '# 草稿',
            sourceChunkIds: [inScope.chunkId],
          });
          expect(ok.isError).toBeUndefined();
        }),
      }),
    );

    // 范围约束对检索同样生效，而不只是 prompt 措辞。
    expect((searchHits as Array<{ documentId: string }>).map((hit) => hit.documentId)).toEqual([
      inScope.documentId,
    ]);
    const versions = await repo.knowledge.listWikiVersions(db, page.id);
    expect(versions.items).toHaveLength(1);
    expect(versions.items[0]?.sourceChunkIds).toEqual([inScope.chunkId]);
    const sources = await db
      .select()
      .from(schema.knowledgeWikiSources)
      .where(eq(schema.knowledgeWikiSources.pageId, page.id));
    expect(sources).toHaveLength(1);
    expect(sources[0]?.chunkId).toBe(inScope.chunkId);
  });

  it('throws instead of reporting success when the model never saves a draft', async () => {
    const { baseId } = await fixture();
    const page = await repo.knowledge.createWikiPage(db, { baseId, slug: 'auth', title: '认证' });
    const jobId = await makeJob(baseId, { pageId: page.id });

    const queryFn: WikiQueryFn = () => {
      async function* run(): AsyncGenerator<SDKMessage> {
        yield { type: 'result', subtype: 'success', is_error: false } as SDKMessage;
      }
      return run();
    };
    await expect(runWikiGenerate(await mustGetJob(jobId), deps({ queryFn }))).rejects.toThrow(
      '模型没有保存任何草稿',
    );
    const versions = await repo.knowledge.listWikiVersions(db, page.id);
    expect(versions.items).toHaveLength(0);
  });

  it('throws KnowledgeCancelled when the job signal fires and keeps the old version', async () => {
    const { baseId } = await fixture();
    const page = await repo.knowledge.createWikiPage(db, { baseId, slug: 'auth', title: '认证' });
    const published = await repo.knowledge.saveWikiVersion(db, page.id, {
      markdown: '# 已发布',
      sourceChunkIds: [],
      model: 'manual',
      generatedBy: 'manual',
    });
    const jobId = await makeJob(baseId, { pageId: page.id });
    const controller = new AbortController();
    let cwd = '';
    let cleanupFinished = false;

    // 按真实 Query 语义：迭代只在 abort 时抛错；CLI 退出落盘发生在 return() 的收尾里。
    const queryFn: WikiQueryFn = (params) => {
      cwd = params.options.cwd ?? '';
      const signal = params.options.abortController?.signal;
      const aborted = new Promise<never>((_, reject) => {
        const fail = () => reject(new Error('Claude Code process aborted by user'));
        if (signal?.aborted) fail();
        else signal?.addEventListener('abort', fail, { once: true });
      });
      async function* iteration(): AsyncGenerator<SDKMessage> {
        yield await aborted;
      }
      const messages = iteration();
      const cleanup = async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await mkdir(join(cwd, 'projects'), { recursive: true });
        await writeFile(join(cwd, 'projects', 'session.jsonl'), '{}');
        cleanupFinished = true;
      };
      return {
        next: (...args: [] | [undefined]) => messages.next(...args),
        return: async (value: void | PromiseLike<void>) => {
          expect(signal?.aborted).toBe(true);
          await cleanup();
          return messages.return(value);
        },
        throw: (err: unknown) => messages.throw(err),
        [Symbol.asyncIterator]() {
          return this;
        },
        [Symbol.asyncDispose]: async () => {
          await cleanup();
        },
      };
    };
    const run = runWikiGenerate(
      await mustGetJob(jobId),
      deps({ queryFn, signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 10);
    await expect(run).rejects.toBeInstanceOf(KnowledgeCancelled);

    const after = await repo.knowledge.getWikiPage(db, page.id);
    expect(after?.currentVersionId).toBe(published?.id);
    expect(after?.status).toBe('published');
    // 收尾被 await 过，且退出时写出的会话文件在收尾之后才被删除。
    expect(cleanupFinished).toBe(true);
    expect(await stat(cwd).catch(() => null)).toBeNull();
  });

  it('rejects a save once the job is no longer running', async () => {
    const { baseId } = await fixture();
    const page = await repo.knowledge.createWikiPage(db, { baseId, slug: 'auth', title: '认证' });
    const published = await repo.knowledge.saveWikiVersion(db, page.id, {
      markdown: '# 已发布',
      sourceChunkIds: [],
      model: 'manual',
      generatedBy: 'manual',
    });
    const jobId = await makeJob(baseId, { pageId: page.id });

    await expect(
      runWikiGenerate(
        await mustGetJob(jobId),
        deps({
          queryFn: fakeQuery(async (tools) => {
            await repo.knowledge.finishJob(db, jobId, { status: 'cancelled' });
            const result = await mustTool(
              tools,
              'wiki_save_draft',
            )({
              markdown: '# 迟到草稿',
              sourceChunkIds: [],
            });
            expect(result.isError).toBe(true);
          }),
        }),
      ),
    ).rejects.toThrow('模型没有保存任何草稿');

    const versions = await repo.knowledge.listWikiVersions(db, page.id);
    expect(versions.items).toHaveLength(1);
    expect(versions.items[0]?.id).toBe(published?.id);
  });

  it('fails on a model error result and keeps the previous published version', async () => {
    const { baseId } = await fixture();
    const page = await repo.knowledge.createWikiPage(db, { baseId, slug: 'auth', title: '认证' });
    const published = await repo.knowledge.saveWikiVersion(db, page.id, {
      markdown: '# 已发布',
      sourceChunkIds: [],
      model: 'manual',
      generatedBy: 'manual',
    });
    const jobId = await makeJob(baseId, { pageId: page.id });

    let cwd = '';
    const queryFn: WikiQueryFn = (params) => {
      cwd = params.options.cwd ?? '';
      async function* run(): AsyncGenerator<SDKMessage> {
        yield {
          type: 'result',
          subtype: 'error_max_budget_usd',
          is_error: true,
          errors: ['budget'],
        } as unknown as SDKMessage;
      }
      return run();
    };
    await expect(runWikiGenerate(await mustGetJob(jobId), deps({ queryFn }))).rejects.toThrow(
      'error_max_budget_usd',
    );

    const after = await repo.knowledge.getWikiPage(db, page.id);
    expect(after?.currentVersionId).toBe(published?.id);
    expect(after?.status).toBe('published');
    expect(await stat(cwd).catch(() => null)).toBeNull();
  });

  it('fails fast when KNOWLEDGE_WIKI_MODEL is missing', async () => {
    const { baseId } = await fixture();
    const page = await repo.knowledge.createWikiPage(db, { baseId, slug: 'auth', title: '认证' });
    const jobId = await makeJob(baseId, { pageId: page.id });

    await expect(
      runWikiGenerate(
        await mustGetJob(jobId),
        deps({
          config: { KNOWLEDGE_DIR: knowledgeDir },
          queryFn: fakeQuery(async () => undefined),
        }),
      ),
    ).rejects.toThrow('KNOWLEDGE_WIKI_MODEL');
  });
});
