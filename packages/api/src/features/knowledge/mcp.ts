import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Database, repo } from '@agentport/db';
import type {
  KnowledgeListResult,
  KnowledgeReadResult,
  KnowledgeSearchResult,
} from '@agentport/shared';
import { knowledgeReadImageInputSchema, knowledgeSearchQuerySchema } from '@agentport/shared';
import type { CallToolResult, McpHttpHandler } from '@modelcontextprotocol/server';
import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { KnowledgeReadImageError, readKnowledgeImage } from './read-image.js';
import { searchKnowledge } from './retrieval.js';

/** read 只读当前版本正文；超出部分截断并标记，避免一次塞满模型上下文。 */
const READ_LIMIT = 20_000;

export interface KnowledgeServerInput {
  db: Database;
  /** server.config.knowledgeBaseId：工具只能看这一库。 */
  baseId: string;
  serverId: string;
  runId: string;
  secretKey: string;
  /** 与 worker 共享的解析产物根目录。 */
  knowledgeDir: string;
  signal?: AbortSignal | undefined;
}

const baseIdArg = z.object({ baseId: z.string().optional() });

const readArgsSchema = z.object({ documentId: z.string().min(1) });
const listArgsSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

/** 工具结果统一走 §5 wire：JSON 文本，前端与对话引用共用同一解析器。 */
function jsonResult(value: KnowledgeSearchResult | KnowledgeReadResult | KnowledgeListResult): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function toolError(code: string, message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: `${code}: ${message}` }] };
}

export function buildKnowledgeServer(input: KnowledgeServerInput): McpHttpHandler {
  return createMcpHandler(async () => {
    const server = new McpServer({ name: `kb-${input.baseId}`, version: '1.0.0' });
    const base = await repo.knowledge.getBase(input.db, input.baseId);
    // 每次连接只读一次状态：handler 是每请求重建的，禁用后下一次调用即生效。
    const baseActive = base?.status === 'active';
    // 图片处理关闭时不暴露读图工具；普通检索/读取不受影响。
    const imageProcessingEnabled = base?.settings.imageProcessing?.enabled === true;

    const guard = (args: unknown): CallToolResult | null => {
      if (!baseActive) return toolError('BASE_DISABLED', '知识库已禁用');
      const parsed = baseIdArg.safeParse(args);
      const requested = parsed.success ? parsed.data.baseId : undefined;
      // 显式换库是越权意图，不能静默改回绑定库。
      if (requested !== undefined && requested !== input.baseId) {
        return toolError('BASE_MISMATCH', '只能访问当前绑定的知识库');
      }
      return null;
    };

    server.registerTool(
      'knowledge_search',
      {
        description: 'Search the bound knowledge base and return cited chunks.',
        inputSchema: fromJsonSchema<Record<string, unknown>>({
          type: 'object',
          properties: {
            q: { type: 'string', minLength: 1, maxLength: 500 },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
            folders: { type: 'array', items: { type: 'string' } },
            tags: { type: 'array', items: { type: 'string' } },
            rerank: { type: 'boolean' },
            baseId: { type: 'string' },
          },
          required: ['q'],
        } as Parameters<typeof fromJsonSchema>[0]),
      },
      async (args, ctx) => {
        const denied = guard(args);
        if (denied) return denied;
        // wire schema 自带默认值，也自然丢弃 baseId 等未知字段。
        const parsed = knowledgeSearchQuerySchema.safeParse(args);
        if (!parsed.success) return toolError('INVALID_INPUT', '检索参数不合法');
        const result = await searchKnowledge(input.db, input.baseId, parsed.data, {
          secretKey: input.secretKey,
          signal: input.signal ?? ctx.mcpReq.signal,
        });
        return jsonResult({ hits: result.hits });
      },
    );

    server.registerTool(
      'knowledge_read',
      {
        description: 'Read the current version of one document as markdown.',
        inputSchema: fromJsonSchema<Record<string, unknown>>({
          type: 'object',
          properties: { documentId: { type: 'string' }, baseId: { type: 'string' } },
          required: ['documentId'],
        } as Parameters<typeof fromJsonSchema>[0]),
      },
      async (args) => {
        const denied = guard(args);
        if (denied) return denied;
        const parsed = readArgsSchema.safeParse(args);
        if (!parsed.success) return toolError('INVALID_INPUT', '文档参数不合法');
        const document = await repo.knowledge.getDocument(input.db, parsed.data.documentId);
        // 不属于绑定库、未就绪或没有当前版本一律按不存在处理，不泄露其他库的文档。
        if (
          !document ||
          document.baseId !== input.baseId ||
          document.status !== 'ready' ||
          !document.currentVersionId
        ) {
          return toolError('DOCUMENT_NOT_FOUND', '文档不存在或尚未就绪');
        }
        const versionId = document.currentVersionId;
        const markdown = await readFile(
          join(input.knowledgeDir, 'docs', document.id, versionId, 'markdown.md'),
          'utf8',
        ).catch(() => null);
        if (markdown === null) return toolError('DOCUMENT_NOT_FOUND', '解析正文不存在');
        const truncated = markdown.length > READ_LIMIT;
        return jsonResult({
          documentId: document.id,
          versionId,
          title: document.title,
          sourceUrl: document.sourceUrl,
          markdown: truncated ? markdown.slice(0, READ_LIMIT) : markdown,
          truncated,
        });
      },
    );

    server.registerTool(
      'knowledge_list',
      {
        description: 'List documents in the bound knowledge base, newest first.',
        inputSchema: fromJsonSchema<Record<string, unknown>>({
          type: 'object',
          properties: {
            cursor: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
            baseId: { type: 'string' },
          },
        } as Parameters<typeof fromJsonSchema>[0]),
      },
      async (args) => {
        const denied = guard(args);
        if (denied) return denied;
        const parsed = listArgsSchema.safeParse(args);
        if (!parsed.success) return toolError('INVALID_INPUT', '列表参数不合法');
        const page = await repo.knowledge.listDocuments(input.db, {
          baseId: input.baseId,
          ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
          ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
        });
        const tags = await repo.knowledge.getDocumentTagNames(
          input.db,
          page.items.map((row) => row.id),
        );
        return jsonResult({
          items: page.items.map((row) => ({
            documentId: row.id,
            title: row.title,
            folderId: row.folderId,
            tags: tags.get(row.id) ?? [],
            sourceType: row.sourceType,
            updatedAt: row.updatedAt.toISOString(),
          })),
          nextCursor: page.nextCursor,
        });
      },
    );

    if (imageProcessingEnabled) {
      server.registerTool(
        'knowledge_read_image',
        {
          description:
            'Read one image hit from knowledge_search. format=description (default) returns the OCR/caption text; format=image returns the original image for vision models.',
          inputSchema: fromJsonSchema<Record<string, unknown>>({
            type: 'object',
            properties: {
              chunkId: { type: 'string' },
              format: { type: 'string' },
              baseId: { type: 'string' },
            },
            required: ['chunkId'],
          } as Parameters<typeof fromJsonSchema>[0]),
        },
        async (args, ctx) => {
          const denied = guard(args);
          if (denied) return denied;
          const parsed = knowledgeReadImageInputSchema.safeParse(args);
          if (!parsed.success) return toolError('INVALID_INPUT', '图片参数不合法');
          try {
            const { result, image } = await readKnowledgeImage(
              { ...input, signal: input.signal ?? ctx.mcpReq.signal },
              parsed.data,
            );
            // 每次保留 JSON text：历史 trace 与 Web 引用按同一 wire 解析；图片作为额外块追加。
            const content: CallToolResult['content'] = [
              { type: 'text', text: JSON.stringify(result) },
              ...(image
                ? [{ type: 'image' as const, data: image.data, mimeType: image.mimeType }]
                : []),
            ];
            return { content };
          } catch (err) {
            if (err instanceof KnowledgeReadImageError) return toolError(err.code, err.message);
            throw err;
          }
        },
      );
    }

    return server;
  });
}
