import type { ChunkDraft, ParsedDocument } from './ingestion.js';
import {
  chunkDocument,
  isAtomicBlock,
  isFenceStart,
  isTableBlock,
  isTableDelimiterLine,
  markdownBlocks,
  parseDocument,
} from './parsing.js';

/**
 * 运行配置（Docling 端点/密钥）只从适配器工厂注入，绝不从上传文档的输入里取；
 * ingestion 只认 `{ parse, chunkMarkdown }` 这两个固定接口。
 */
export function createParsingAdapter(
  options: { parserUrl?: string | undefined; parserKey?: string | undefined } = {},
): {
  parse: (input: {
    filename: string;
    mimeType: string;
    data: Buffer;
    signal?: AbortSignal;
  }) => Promise<ParsedDocument>;
  chunkMarkdown: (
    markdown: string,
    pageMap: ParsedDocument['pageMap'],
    options: { chunkTokens: number; overlap: number },
  ) => ChunkDraft[];
} {
  return {
    parse: async (input) => {
      const doc = await parseDocument({
        bytes: new Uint8Array(input.data),
        filename: input.filename,
        mimeType: input.mimeType,
        ...(options.parserUrl ? { parserUrl: options.parserUrl } : {}),
        ...(options.parserKey ? { parserKey: options.parserKey } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return { markdown: doc.markdown, images: doc.images, pageMap: doc.pageMap };
    },
    chunkMarkdown: chunkForIngestion,
  };
}

type Block = { content: string; heading: string; locator: Record<string, unknown> };

/**
 * 表格按行拆分时保留列语义，按 maxChars 预算切块并重复表头。
 * shortcut: 单行超过预算时不拆行，那个 chunk 会超预算；模型窗口真的卡住时再按单元格拆。
 */
function splitTable(block: Block, maxChars: number): Block[] {
  const lines = block.content.split('\n');
  const separator = lines[1] !== undefined && isTableDelimiterLine(lines[1]) ? lines[1] : null;
  const header = separator ? [lines[0] ?? '', separator] : [];
  const head = header.length > 0 ? lines.slice(0, 2) : [lines[0] ?? ''];
  const rows = lines.slice(head.length);
  const parts: Block[] = [];
  let current: string[] = [];
  let size = head.join('\n').length;
  const flush = () => {
    if (current.length === 0) return;
    parts.push({ ...block, content: [...head, ...current].join('\n') });
    current = [];
    size = head.join('\n').length;
  };
  for (const row of rows) {
    if (current.length > 0 && size + row.length + 1 > maxChars) flush();
    current.push(row);
    size += row.length + 1;
  }
  flush();
  return parts;
}

/** 代码块按行拆分时每段都自带完整 fence，保证切块后仍是有效 Markdown。 */
function splitFence(block: Block, maxChars: number): Block[] {
  const lines = block.content.split('\n');
  const opener = lines[0] ?? '';
  const closer = lines.at(-1) ?? '';
  const body = lines.slice(1, -1);
  const overhead = opener.length + closer.length + 1;
  const parts: Block[] = [];
  let current: string[] = [];
  let size = overhead;
  const flush = () => {
    if (current.length === 0) return;
    parts.push({ ...block, content: [opener, ...current, closer].join('\n') });
    current = [];
    size = overhead;
  };
  for (const line of body) {
    if (current.length > 0 && size + line.length + 1 > maxChars) flush();
    current.push(line);
    size += line.length + 1;
  }
  flush();
  return parts;
}

function clampChunk(block: Block, maxChars: number): Block[] {
  if (block.content.length <= maxChars) return [block];
  if (isTableBlock(block.content)) return splitTable(block, maxChars);
  if (isFenceStart(block.content)) return splitFence(block, maxChars);
  return [block];
}

/**
 * chunkTokens 是**字符**预算（1 token ≈ 1 字符的保守上界，中文实际更省）。
 * 不按 4 字符/1 token 放大，否则中文块会超过 embedding 模型窗口。
 */
function chunkForIngestion(
  markdown: string,
  pageMap: ParsedDocument['pageMap'],
  options: { chunkTokens: number; overlap: number },
): ChunkDraft[] {
  const maxChars = Math.max(200, options.chunkTokens);
  const overlap = Math.max(0, Math.min(options.overlap, maxChars - 1));
  // markdownBlocks 直接给出原文偏移，与 pageMap 同为 UTF-16 下标，无需再整篇算前缀。
  const blocks = markdownBlocks(markdown, (_line, offset = 0) => {
    const range = pageMap.find((entry) => offset >= entry.startOffset && offset < entry.endOffset);
    return range ? { page: range.page } : {};
  });
  const rows = blocks.flatMap((block) => clampChunk(block, maxChars));

  // 表格/代码块必须整块独立成 chunk，不能再被跨块合并；连续散文才交给结构感知合并。
  const groups: Block[][] = [];
  let atomicGroup = false;
  for (const block of rows) {
    const atomic = isAtomicBlock(block.content);
    const last = groups.at(-1);
    if (!atomic && last && !atomicGroup) {
      last.push(block);
      continue;
    }
    groups.push([block]);
    atomicGroup = atomic;
  }

  const chunks = groups.flatMap((group) =>
    chunkDocument(
      { markdown, blocks: group, images: [], pageMap },
      {
        chunkSize: maxChars,
        chunkOverlap: overlap,
      },
    ),
  );
  return chunks.map((chunk) => ({
    kind: isTableBlock(chunk.content) ? ('table' as const) : ('text' as const),
    heading: chunk.heading || null,
    content: chunk.content,
    pageFrom: typeof chunk.locator.page === 'number' ? chunk.locator.page : null,
    pageTo: typeof chunk.locator.pageTo === 'number' ? chunk.locator.pageTo : null,
  }));
}
