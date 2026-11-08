import { type AsrProfile, chunkBlocks, inspectKnowledgeAudio } from '@agentport/core';
import type { KnowledgeLocator } from '@agentport/shared';
import { parseKnowledgeAudio } from './audio.js';
import type { ChunkDraft } from './ingestion.js';
import {
  isTableBlock,
  KnowledgeParseError,
  markdownBlocks,
  type ParsedDocument,
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
      return doc;
    },
    chunkMarkdown: chunkForIngestion,
  };
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
 * clamp 与原子分组都在 core 的 chunkBlocks 里，预览走同一个函数，块数与内容不会漂。
 */
function chunkForIngestion(
  markdown: string,
  pageMap: ParsedDocument['pageMap'],
  options: { chunkTokens: number; overlap: number },
  parsedBlocks?: ParsedDocument['blocks'],
): ChunkDraft[] {
  // 有解析器真实块时直接沿用其 page/bbox/ref/offset；只在缺失时回退到 Markdown 重算。
  const blocks =
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
  const chunks = chunkBlocks(blocks, markdown, {
    chunkSize: options.chunkTokens,
    chunkOverlap: options.overlap,
  });
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
