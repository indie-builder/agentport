import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { segmentForSearch } from '@agentport/core';
import { type Database, repo, schema } from '@agentport/db';
import type { KnowledgeJobPayload } from '@agentport/shared';
import { knowledgeJobPayloadSchema } from '@agentport/shared';
import {
  createSdkMcpServer,
  type Options,
  query,
  type SDKMessage,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { KnowledgeCancelled } from './ingestion.js';

type WikiPageRow = typeof schema.knowledgeWikiPages.$inferSelect;
type JobRow = typeof schema.knowledgeJobs.$inferSelect;
type WikiGeneratePayload = Extract<KnowledgeJobPayload, { type: 'wiki_generate' }>;

/** 与契约 §6.6 固定：进程内工具名与 allowedTools 一一对应。 */
export const WIKI_TOOL_NAMES = ['wiki_search', 'wiki_read', 'wiki_save_draft'] as const;
export const WIKI_ALLOWED_TOOLS = WIKI_TOOL_NAMES.map((name) => `mcp__knowledge__${name}`);

const READ_LIMIT = 20_000;
const QUOTE_LIMIT = 1200;
const SEARCH_LIMIT = 10;

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/**
 * SDK 边界：测试可替换 query 实现，真实运行时直接使用官方 query。
 * 返回 AsyncGenerator 而非 AsyncIterable：收尾要 await return()，
 * 官方 Query.return() 才会等 cleanup（含子进程退出）完成。
 */
export type WikiQueryFn = (params: {
  prompt: string;
  options: Options;
}) => AsyncGenerator<SDKMessage, void>;

export interface WikiGenerateDeps {
  db: Database;
  config: { KNOWLEDGE_DIR: string; KNOWLEDGE_WIKI_MODEL?: string | undefined };
  signal: AbortSignal;
  /** 替换真实 SDK query；测试注入假实现，不 mock 模块。 */
  queryFn?: WikiQueryFn;
}

function text(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function toolError(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length > 0 ? slug : 'page';
}

async function resolvePage(db: Database, payload: WikiGeneratePayload): Promise<WikiPageRow> {
  if (payload.pageId) {
    const page = await repo.knowledge.getWikiPage(db, payload.pageId);
    if (!page || page.baseId !== payload.baseId) throw new Error('Wiki 页面不存在或不属于该知识库');
    return page;
  }
  const title = payload.title?.trim() || '未命名页面';
  const [existing] = await db
    .select({ id: schema.knowledgeWikiPages.id })
    .from(schema.knowledgeWikiPages)
    .where(
      sql`${schema.knowledgeWikiPages.baseId} = ${payload.baseId}
        and ${schema.knowledgeWikiPages.slug} = ${slugify(title)}`,
    )
    .limit(1);
  const slug = existing ? `${slugify(title)}-${Date.now().toString(36).slice(-5)}` : slugify(title);
  return repo.knowledge.createWikiPage(db, { baseId: payload.baseId, slug, title });
}

interface SearchRow extends Record<string, unknown> {
  chunk_id: string;
  document_id: string;
  version_id: string;
  heading: string | null;
  content: string;
  page_from: number | null;
  page_to: number | null;
  title: string;
  source_url: string | null;
  rank: number;
}

/**
 * shortcut: 关键词单路检索（无向量/rerank）；Wiki 草稿的取证够用，
 * 需要与聊天检索完全同分时改为调用 API 侧 searchKnowledge。
 */
async function searchBase(
  db: Database,
  baseId: string,
  q: string,
  limit: number,
  allowedDocumentIds: string[],
) {
  const segmented = segmentForSearch(q);
  if (segmented.length === 0) return [];
  const documentFilter =
    allowedDocumentIds.length > 0
      ? sql`and c.document_id in (${sql.join(
          allowedDocumentIds.map((id) => sql`${id}`),
          sql`, `,
        )})`
      : sql``;
  const result = await db.execute<SearchRow>(sql`
    select c.id as chunk_id, c.document_id, c.version_id, c.heading, c.content,
      c.page_from, c.page_to, d.title, d.source_url,
      ts_rank_cd(c.search_vector, plainto_tsquery('simple', ${segmented})) as rank
    from knowledge_chunks c
    join knowledge_documents d on d.id = c.document_id
    where c.base_id = ${baseId}
      and c.enabled
      and d.current_version_id = c.version_id
      and ${repo.knowledge.readableDocumentSql('d')}
      and d.content_kind <> 'wiki'
      and c.search_vector @@ plainto_tsquery('simple', ${segmented})
      ${documentFilter}
    order by rank desc, c.id
    limit ${limit}
  `);
  return result.rows.map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    versionId: row.version_id,
    title: row.title,
    heading: row.heading,
    quote: row.content.slice(0, QUOTE_LIMIT),
    pageFrom: row.page_from,
    pageTo: row.page_to,
    sourceUrl: row.source_url,
    score: Number(row.rank),
  }));
}

async function readDocument(
  db: Database,
  knowledgeDir: string,
  baseId: string,
  documentId: string,
) {
  // 与检索/读取共用来源授权判定：撤权、范围失效或人工停用后不能再被 Wiki 消费。
  const document = await repo.knowledge.getReadableDocument(db, baseId, documentId);
  if (!document?.currentVersionId) return null;
  const markdown = await readFile(
    join(knowledgeDir, 'docs', document.id, document.currentVersionId, 'markdown.md'),
    'utf8',
  ).catch(() => null);
  if (markdown === null) return null;
  const truncated = markdown.length > READ_LIMIT;
  return {
    documentId: document.id,
    versionId: document.currentVersionId,
    title: document.title,
    sourceUrl: document.sourceUrl,
    markdown: truncated ? markdown.slice(0, READ_LIMIT) : markdown,
    truncated,
  };
}

/**
 * 引用必须落在此库当前版本、启用且 ready 的 chunk 上；范围外的 id 直接拒绝。
 * Wiki 内部索引不是授权来源：引用它会让撤权后的派生内容再被当证据。
 */
async function validateSourceChunks(
  db: Database,
  baseId: string,
  sourceChunkIds: string[],
  allowedDocumentIds: string[],
): Promise<Array<{ id: string; documentId: string; versionId: string }>> {
  if (sourceChunkIds.length === 0) return [];
  const rows = await db
    .select({
      id: schema.knowledgeChunks.id,
      documentId: schema.knowledgeChunks.documentId,
      versionId: schema.knowledgeChunks.versionId,
    })
    .from(schema.knowledgeChunks)
    .innerJoin(
      schema.knowledgeDocuments,
      eq(schema.knowledgeDocuments.id, schema.knowledgeChunks.documentId),
    )
    .where(
      and(
        inArray(schema.knowledgeChunks.id, sourceChunkIds),
        eq(schema.knowledgeChunks.baseId, baseId),
        eq(schema.knowledgeChunks.enabled, true),
        sql`${schema.knowledgeChunks.versionId} = ${schema.knowledgeDocuments.currentVersionId}`,
        sql`${schema.knowledgeDocuments.contentKind} <> 'wiki'`,
        repo.knowledge.readableDocumentSql('knowledge_documents'),
        ...(allowedDocumentIds.length > 0
          ? [inArray(schema.knowledgeChunks.documentId, allowedDocumentIds)]
          : []),
      ),
    );
  if (rows.length !== new Set(sourceChunkIds).size) {
    const found = new Set(rows.map((row) => row.id));
    const invalid = sourceChunkIds.filter((id) => !found.has(id));
    throw new Error(`无效引用 chunkId: ${invalid.join(', ')}`);
  }
  return rows;
}

function buildPrompt(input: {
  baseName: string;
  pageTitle: string;
  instruction?: string | undefined;
  sourceDocumentIds?: string[] | undefined;
}): string {
  const lines = [
    `你是知识库《${input.baseName}》的 Wiki 编辑。请为页面「${input.pageTitle}」撰写 Markdown 草稿。`,
    '步骤：先用 wiki_search 检索证据，必要时用 wiki_read 阅读原文，最后用 wiki_save_draft 提交完整草稿。',
    '草稿必须基于检索到的内容，不得编造；sourceChunkIds 必须列出至少一个实际引用到的 chunkId。',
    '只提交一次草稿，提交后不要再修改。',
  ];
  if (input.instruction) lines.push(`补充要求：${input.instruction}`);
  if (input.sourceDocumentIds && input.sourceDocumentIds.length > 0) {
    lines.push(`只允许使用这些文档：${input.sourceDocumentIds.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Worker 直接调用 SDK 时只给 MCP 工具：不给内置工具、不加载用户/项目设置、
 * 不放行 .mcp.json/插件、关闭 auto-memory，cwd 与 HOME 指向独立临时目录。
 * env 只保留 CLI 运行与模型凭证，避免 DATABASE_URL/APP_SECRET_KEY 进入子进程。
 */
function sdkOptions(input: {
  model: string;
  server: ReturnType<typeof createSdkMcpServer>;
  cwd: string;
  controller: AbortController;
}): Options {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: input.cwd,
    CLAUDE_CONFIG_DIR: input.cwd,
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'] as const) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return {
    model: input.model,
    cwd: input.cwd,
    env,
    mcpServers: { knowledge: input.server },
    strictMcpConfig: true,
    tools: [],
    allowedTools: WIKI_ALLOWED_TOOLS,
    settingSources: [],
    settings: { autoMemoryEnabled: false },
    permissionMode: 'dontAsk',
    maxTurns: 12,
    maxBudgetUsd: 0.5,
    abortController: input.controller,
    // 临时会话不落盘：退出慢于 rm 时 CLI 也没有会话文件可重建。
    persistSession: false,
  };
}

/**
 * Wiki 生成：独立 knowledge_jobs 行，不建 agent_runs、不写工作区。
 * 这里只负责生成与保存草稿；终态（succeeded/failed/cancelled）由队列统一写入。
 */
export async function runWikiGenerate(job: JobRow, deps: WikiGenerateDeps): Promise<void> {
  const { db, signal } = deps;
  if (signal.aborted) throw new KnowledgeCancelled();
  const payload = knowledgeJobPayloadSchema.parse(job.payload);
  if (payload.type !== 'wiki_generate') throw new Error('只有 wiki_generate 任务可以生成 Wiki');

  const base = await repo.knowledge.getBase(db, payload.baseId);
  if (!base) throw new Error('知识库不存在，可能已被删除');
  const model = deps.config.KNOWLEDGE_WIKI_MODEL;
  if (!model) throw new Error('KNOWLEDGE_WIKI_MODEL 未配置，无法生成 Wiki');

  const page = await resolvePage(db, payload);
  const knowledgeDir = deps.config.KNOWLEDGE_DIR;
  const allowedDocumentIds = payload.sourceDocumentIds ?? [];
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  // 每次生成一个独立 cwd（同时是 HOME/CLAUDE_CONFIG_DIR）；任务结束即删除，不留会话文件。
  const cwd = join(knowledgeDir, 'wiki-sdk', job.id);
  let messages: AsyncGenerator<SDKMessage, void> | undefined;

  try {
    const savedVersions: string[] = [];
    const save = async (input: { markdown: string; sourceChunkIds: string[] }) => {
      if (signal.aborted) throw new KnowledgeCancelled();
      // 模型草稿必须带可撤权来源：空来源一旦发布就再也追不回授权。
      if (input.sourceChunkIds.length === 0) {
        throw new Error('MODEL_SOURCE_REQUIRED: 模型草稿必须引用至少一个来源 chunk');
      }
      // 取消后 API 可能已把行改成终态；不再写入草稿。
      const current = await repo.knowledge.getJob(db, job.id);
      if (current?.status !== 'running') throw new Error('任务已结束，拒绝写入草稿');
      const chunks = await validateSourceChunks(
        db,
        payload.baseId,
        input.sourceChunkIds,
        allowedDocumentIds,
      );
      const version = await repo.knowledge.saveWikiDraft(db, page.id, {
        markdown: input.markdown,
        sourceChunkIds: chunks.map((chunk) => chunk.id),
        model,
        generatedBy: 'sdk',
      });
      if (!version) throw new Error('Wiki 页面不存在，可能已被删除');
      savedVersions.push(version.id);
      return version.id;
    };

    const server = createSdkMcpServer({
      name: 'knowledge',
      version: '1.0.0',
      tools: [
        tool(
          'wiki_search',
          'Search the bound knowledge base; returns chunks with ids you can cite.',
          { q: z.string().min(1).max(500), limit: z.number().int().min(1).max(20).optional() },
          async (args) => {
            const hits = await searchBase(
              db,
              payload.baseId,
              args.q,
              args.limit ?? SEARCH_LIMIT,
              allowedDocumentIds,
            );
            return text({ hits });
          },
        ),
        tool(
          'wiki_read',
          'Read the current version of one document as markdown.',
          { documentId: z.string().min(1) },
          async (args) => {
            if (allowedDocumentIds.length > 0 && !allowedDocumentIds.includes(args.documentId)) {
              return toolError('DOCUMENT_NOT_IN_SCOPE: 该文档不在本次生成范围内');
            }
            const result = await readDocument(db, knowledgeDir, payload.baseId, args.documentId);
            return result ? text(result) : toolError('DOCUMENT_NOT_FOUND: 文档不存在或尚未就绪');
          },
        ),
        tool(
          'wiki_save_draft',
          'Save the full markdown draft for the bound page. Does not publish it.',
          {
            markdown: z.string().min(1),
            sourceChunkIds: z.array(z.string().min(1)).min(1),
          },
          async (args) => {
            try {
              const versionId = await save({
                markdown: args.markdown,
                sourceChunkIds: args.sourceChunkIds ?? [],
              });
              return text({ pageId: page.id, versionId, saved: true });
            } catch (err) {
              return toolError(err instanceof Error ? err.message : String(err));
            }
          },
        ),
      ],
    });

    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const queryFn = deps.queryFn ?? query;
    messages = queryFn({
      prompt: buildPrompt({
        baseName: base.name,
        pageTitle: page.title,
        instruction: payload.instruction,
        sourceDocumentIds: payload.sourceDocumentIds,
      }),
      options: sdkOptions({ model, server, cwd, controller }),
    });

    let failure: string | null = null;
    let sawResult = false;
    for await (const message of messages) {
      if (message.type !== 'result') continue;
      sawResult = true;
      if (message.subtype !== 'success') {
        failure = [message.subtype, ...message.errors].filter(Boolean).join(': ');
      } else if (message.is_error) {
        failure = `success: ${message.result}`;
      }
    }
    if (signal.aborted || controller.signal.aborted) throw new KnowledgeCancelled();
    if (!sawResult) throw new Error('SDK 没有返回结果');
    if (failure !== null) throw new Error(failure);
    // SDK 成功但没有草稿不能算成功：否则页面状态与用户预期不符。
    if (savedVersions.length === 0) throw new Error('模型没有保存任何草稿');
  } catch (err) {
    if (signal.aborted || controller.signal.aborted || err instanceof KnowledgeCancelled) {
      throw new KnowledgeCancelled();
    }
    throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
    // 先停 CLI 再删目录：只 abort 时 CLI 退出较慢，会在删除后重建 projects/*.jsonl。
    // 官方 Query.return() 才会 await cleanup（关 transport、等子进程退出）；close() 是同步不等。
    controller.abort();
    await messages?.return(undefined).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}
