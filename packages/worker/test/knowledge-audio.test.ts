import type { AsrProfile, AudioTranscript } from '@agentport/core';
import { KnowledgeModelError, transcribeAudio } from '@agentport/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseKnowledgeAudio } from '../src/knowledge/audio.js';

vi.mock('@agentport/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentport/core')>();
  return { ...actual, transcribeAudio: vi.fn() };
});

const transcribe = vi.mocked(transcribeAudio);

const ASR: AsrProfile = {
  endpointUrl: 'https://asr.example/v1/audio/transcriptions',
  model: 'whisper-test',
  apiKey: 'secret',
};

const BYTES = new Uint8Array([0x49, 0x44, 0x33]);

function input(patch: Partial<Parameters<typeof parseKnowledgeAudio>[0]> = {}) {
  return {
    bytes: BYTES,
    filename: 'talk.mp3',
    mimeType: 'audio/mpeg',
    asr: ASR,
    asrProfileName: '默认 ASR',
    ...patch,
  };
}

function transcript(patch: Partial<AudioTranscript> = {}): AudioTranscript {
  return { text: '', durationMs: null, segments: [], ...patch };
}

beforeEach(() => {
  transcribe.mockReset();
});

describe('parseKnowledgeAudio', () => {
  it('拼接非空段、累加真实 UTF-16 偏移并保留下标时码', async () => {
    transcribe.mockResolvedValue(
      transcript({
        text: '这是上游全文，不应重复',
        durationMs: 4000,
        segments: [
          { text: '  第一段。\n换行保留。  ', timeFromMs: 0, timeToMs: 1200 },
          { text: '重复句', timeFromMs: 1200, timeToMs: 2400 },
          { text: '   ', timeFromMs: 2400, timeToMs: 2600 },
          { text: '重复句 😀', timeFromMs: 2600, timeToMs: 4000 },
        ],
      }),
    );

    const parsed = await parseKnowledgeAudio(input());

    expect(transcribe).toHaveBeenCalledWith(
      ASR,
      { data: BYTES, filename: 'talk.mp3', mimeType: 'audio/mpeg' },
      undefined,
    );
    expect(parsed.markdown).toBe('第一段。\n换行保留。\n\n重复句\n\n重复句 😀');
    expect(parsed.images).toEqual([]);
    expect(parsed.pageMap).toEqual([]);
    // 重复句各自按拼接位置独立计偏移；空白段不产块且不改变上游下标。
    expect(parsed.blocks).toEqual([
      {
        content: '第一段。\n换行保留。',
        heading: '',
        locator: {
          startOffset: 0,
          endOffset: 10,
          timeFromMs: 0,
          timeToMs: 1200,
          ref: 'asr:segment:0',
        },
      },
      {
        content: '重复句',
        heading: '',
        locator: {
          startOffset: 12,
          endOffset: 15,
          timeFromMs: 1200,
          timeToMs: 2400,
          ref: 'asr:segment:1',
        },
      },
      {
        content: '重复句 😀',
        heading: '',
        locator: {
          startOffset: 17,
          endOffset: 23,
          timeFromMs: 2600,
          timeToMs: 4000,
          ref: 'asr:segment:3',
        },
      },
    ]);
    expect(parsed.audio).toEqual({
      protocol: 'openai_transcriptions',
      profileName: '默认 ASR',
      model: 'whisper-test',
      durationMs: 4000,
      segments: [
        { startOffset: 0, endOffset: 10, timeFromMs: 0, timeToMs: 1200 },
        { startOffset: 12, endOffset: 15, timeFromMs: 1200, timeToMs: 2400 },
        { startOffset: 17, endOffset: 23, timeFromMs: 2600, timeToMs: 4000 },
      ],
    });
  });

  it('无段级时码时只用顶层文本，不造时间', async () => {
    transcribe.mockResolvedValue(
      transcript({ text: ' 只有正文 \n第二行 ', durationMs: 5000, segments: [] }),
    );

    const parsed = await parseKnowledgeAudio(input());

    expect(parsed.markdown).toBe('只有正文 \n第二行');
    expect(parsed.blocks).toEqual([
      { content: '只有正文 \n第二行', heading: '', locator: { startOffset: 0, endOffset: 9 } },
    ]);
    expect(parsed.audio).toEqual({
      protocol: 'openai_transcriptions',
      profileName: '默认 ASR',
      model: 'whisper-test',
      durationMs: 5000,
      segments: [],
    });
  });

  it('segments 缺省或全是空白但有顶层文本时按 text-only 处理', async () => {
    transcribe.mockResolvedValue(transcript({ text: '  实际正文  ' }));

    const absent = await parseKnowledgeAudio(input());
    expect(absent.markdown).toBe('实际正文');
    expect(absent.audio.segments).toEqual([]);
    expect(absent.blocks[0]?.locator).toEqual({ startOffset: 0, endOffset: 4 });

    transcribe.mockResolvedValue(
      transcript({
        text: '  实际正文  ',
        segments: [{ text: '  ', timeFromMs: 0, timeToMs: 100 }],
      }),
    );
    const blank = await parseKnowledgeAudio(input());
    expect(blank.markdown).toBe('实际正文');
    expect(blank.blocks).toHaveLength(1);
    expect(blank.blocks[0]?.locator).toEqual({ startOffset: 0, endOffset: 4 });
    expect(blank.audio.segments).toEqual([]);
  });

  it('顶层与段文本都为空时抛不可重试的 invalid_input', async () => {
    transcribe.mockResolvedValue(
      transcript({
        text: '   ',
        segments: [{ text: ' ', timeFromMs: 0, timeToMs: 100 }],
      }),
    );

    await expect(parseKnowledgeAudio(input())).rejects.toMatchObject({
      name: 'KnowledgeParseError',
      code: 'invalid_input',
      message: '音频没有可索引的语音文本',
    });
  });

  it('调用前已取消时不再请求转录', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(parseKnowledgeAudio(input({ signal: controller.signal }))).rejects.toMatchObject({
      name: 'KnowledgeParseError',
      code: 'aborted',
    });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('转录中调用方取消时归为 aborted，而不是模型故障', async () => {
    const controller = new AbortController();
    transcribe.mockImplementation(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });

    await expect(parseKnowledgeAudio(input({ signal: controller.signal }))).rejects.toMatchObject({
      name: 'KnowledgeParseError',
      code: 'aborted',
    });
  });

  it('非取消的模型错误原样透传，交给既有重试分类', async () => {
    const error = new KnowledgeModelError('bad_response', '转录响应不合法');
    transcribe.mockRejectedValue(error);

    await expect(parseKnowledgeAudio(input())).rejects.toBe(error);
  });
});
