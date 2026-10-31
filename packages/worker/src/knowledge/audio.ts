/** 音频转录：段级时码 → 唯一 markdown 与带时间的解析块。 */
import { type AsrProfile, transcribeAudio } from '@agentport/core';
import type { KnowledgeAudioMetadata } from '@agentport/shared';
import { KnowledgeParseError, type ParsedBlock, type ParsedDocument } from './parsing.js';

export type ParsedAudioDocument = ParsedDocument & { audio: KnowledgeAudioMetadata };

function cancelled(): KnowledgeParseError {
  return new KnowledgeParseError('aborted', '音频转录已取消');
}

/**
 * 只做转录结果到解析块的转换；格式/字节识别由入口 helper 完成后传入 canonical MIME。
 * profileName 是执行时快照，不含 endpoint/key。
 */
export async function parseKnowledgeAudio(input: {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  asr: AsrProfile;
  asrProfileName: string;
  signal?: AbortSignal;
}): Promise<ParsedAudioDocument> {
  if (input.signal?.aborted) throw cancelled();

  let transcript: Awaited<ReturnType<typeof transcribeAudio>>;
  try {
    transcript = await transcribeAudio(
      input.asr,
      { data: input.bytes, filename: input.filename, mimeType: input.mimeType },
      input.signal,
    );
  } catch (err) {
    if (input.signal?.aborted) throw cancelled();
    throw err;
  }
  if (input.signal?.aborted) throw cancelled();

  // 空白段不产块；ref 保留上游下标，跳过空白段也不改段号。
  const segments = transcript.segments
    .map((segment, index) => ({ ...segment, index, text: segment.text.trim() }))
    .filter((segment) => segment.text !== '');

  if (segments.length > 0) {
    const blocks: ParsedBlock[] = [];
    const audioSegments: KnowledgeAudioMetadata['segments'] = [];
    let markdown = '';
    let offset = 0;
    for (const segment of segments) {
      // 偏移在拼接时累加 UTF-16 长度；重复句不能靠 indexOf 反查。
      if (markdown !== '') {
        markdown += '\n\n';
        offset += 2;
      }
      const startOffset = offset;
      markdown += segment.text;
      offset += segment.text.length;
      const endOffset = offset;
      blocks.push({
        content: segment.text,
        heading: '',
        locator: {
          startOffset,
          endOffset,
          timeFromMs: segment.timeFromMs,
          timeToMs: segment.timeToMs,
          ref: `asr:segment:${segment.index}`,
        },
      });
      audioSegments.push({
        startOffset,
        endOffset,
        timeFromMs: segment.timeFromMs,
        timeToMs: segment.timeToMs,
      });
    }
    return {
      markdown,
      images: [],
      pageMap: [],
      blocks,
      audio: {
        protocol: 'openai_transcriptions',
        profileName: input.asrProfileName,
        model: input.asr.model,
        durationMs: transcript.durationMs,
        segments: audioSegments,
      },
    };
  }

  // 没有段级时码时只给字符区间，不凭顶层 text 或 duration 造时间。
  const text = transcript.text.trim();
  if (text === '') {
    throw new KnowledgeParseError('invalid_input', '音频没有可索引的语音文本');
  }
  return {
    markdown: text,
    images: [],
    pageMap: [],
    blocks: [{ content: text, heading: '', locator: { startOffset: 0, endOffset: text.length } }],
    audio: {
      protocol: 'openai_transcriptions',
      profileName: input.asrProfileName,
      model: input.asr.model,
      durationMs: transcript.durationMs,
      segments: [],
    },
  };
}
