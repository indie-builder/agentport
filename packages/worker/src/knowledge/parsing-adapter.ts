import { type AsrProfile, inspectKnowledgeAudio } from '@agentport/core';
import type { KnowledgeLocator } from '@agentport/shared';
import { parseKnowledgeAudio } from './audio.js';
import type { ChunkDraft, ParsedDocument } from './ingestion.js';
import {
  chunkDocument,
  isAtomicBlock,
  isFenceStart,
  isTableBlock,
  isTableDelimiterLine,
  KnowledgeParseError,
  markdownBlocks,
  type ParsedBlock,
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
    /** 仅 runtime 注入；音频分支优先于 Docling，普通文档忽略。 */
    asr?: AsrProfile;
    asrProfileName?: string;
  }) => Promise<ParsedDocument>;
  chunkMarkdown: (
    markdown: string,
    pageMap: ParsedDocument['pageMap'],
    options: { chunkTokens: number; overlap: number },
    blocks?: ParsedDocument['blocks'],
  ) => ChunkDraft[];
} {
  return {
    parse: async (input) => {
      const bytes = new Uint8Array(input.data);
      // 二进制信任入口统一识别一次；实际音频优先走 ASR，绝不落到文本或 Docling。
      const audio = await inspectKnowledgeAudio({
        data: bytes,
        filename: input.filename,
        mimeType: input.mimeType,
      });
      if (audio) {
        if (!input.asr || !input.asrProfileName) {
          throw new KnowledgeParseError('invalid_input', '知识库没有可用的音频转录模型');
        }
        return parseKnowledgeAudio({
          bytes,
          filename: input.filename,
          mimeType: audio.mimeType,
          asr: input.asr,
          asrProfileName: input.asrProfileName,
          ...(input.signal ? { signal: input.signal } : {}),
        });
      }
      const doc = await parseDocument({
        bytes,
        filename: input.filename,
        mimeType: input.mimeType,
        ...(options.parserUrl ? { parserUrl: options.parserUrl } : {}),
        ...(options.parserKey ? { parserKey: options.parserKey } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return {
        markdown: doc.markdown,
        images: doc.images,
        pageMap: doc.pageMap,
        blocks: doc.blocks,
      };
    },
    chunkMarkdown: chunkForIngestion,
  };
}

type Block = { content: string; heading: string; locator: Record<string, unknown> };

/** 行拆分的表格/代码块不是原文连续片段：保留整表 ref/bbox，但不保留块级文本区间。 */
function withoutTextRange(block: Block): Block {
  const locator = { ...block.locator };
  delete locator.startOffset;
  delete locator.endOffset;
  delete locator.line;
  delete locator.charStart;
  delete locator.charEnd;
  return { ...block, locator };
}

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
    parts.push(withoutTextRange({ ...block, content: [...head, ...current].join('\n') }));
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
    parts.push(withoutTextRange({ ...block, content: [opener, ...current, closer].join('\n') }));
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

/** 解析器的通用 locator → 固定结构；只搬真实存在的坐标，不补默认值。 */
function toKnowledgeLocator(locator: Record<string, unknown>, heading: string): KnowledgeLocator {
  const isNumber = (value: unknown): value is number => typeof value === 'number';
  const result: KnowledgeLocator = {};
  if (isNumber(locator.page)) {
    result.pageFrom = locator.page;
  }
  if (isNumber(locator.pageTo)) result.pageTo = locator.pageTo;
  if (isNumber(locator.line)) result.lineFrom = locator.line;
  if (isNumber(locator.startOffset)) result.startOffset = locator.startOffset;
  if (isNumber(locator.endOffset)) result.endOffset = locator.endOffset;
  // 时码必须成对搬运；audio 块本身保证成对，这里不补默认值。
  if (isNumber(locator.timeFromMs) && isNumber(locator.timeToMs)) {
    result.timeFromMs = locator.timeFromMs;
    result.timeToMs = locator.timeToMs;
  }
  if (typeof locator.ref === 'string') result.parserRef = locator.ref;
  const bbox = locator.bbox;
  if (bbox && typeof bbox === 'object') {
    const box = bbox as { l?: unknown; t?: unknown; r?: unknown; b?: unknown };
    if (isNumber(box.l) && isNumber(box.t) && isNumber(box.r) && isNumber(box.b)) {
      result.bbox = { left: box.l, top: box.t, right: box.r, bottom: box.b };
    }
  }
  if (heading !== '') result.headingPath = heading.split(' > ').filter(Boolean);
  return result;
}

/**
 * chunkTokens 是**字符**预算（1 token ≈ 1 字符的保守上界，中文实际更省）。
 * 不按 4 字符/1 token 放大，否则中文块会超过 embedding 模型窗口。
 */
function chunkForIngestion(
  markdown: string,
  pageMap: ParsedDocument['pageMap'],
  options: { chunkTokens: number; overlap: number },
  parsedBlocks?: ParsedDocument['blocks'],
): ChunkDraft[] {
  const maxChars = Math.max(200, options.chunkTokens);
  const overlap = Math.max(0, Math.min(options.overlap, maxChars - 1));
  // 有解析器真实块时直接沿用其 page/bbox/ref/offset；只在缺失时回退到 Markdown 重算。
  const blocks: ParsedBlock[] =
    parsedBlocks !== undefined && parsedBlocks.length > 0
      ? parsedBlocks
      : markdownBlocks(markdown, (line, offset = 0, endOffset) => {
          const range = pageMap.find(
            (entry) => offset >= entry.startOffset && offset < entry.endOffset,
          );
          return {
            line,
            startOffset: offset,
            ...(endOffset === undefined ? {} : { endOffset }),
            ...(range ? { page: range.page } : {}),
          };
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
  return chunks.map((chunk) => {
    const locator = toKnowledgeLocator(chunk.locator, chunk.heading);
    return {
      kind: isTableBlock(chunk.content) ? ('table' as const) : ('text' as const),
      heading: chunk.heading || null,
      content: chunk.content,
      pageFrom: locator.pageFrom ?? null,
      pageTo: locator.pageTo ?? null,
      locator,
    };
  });
}
