import { existsSync } from 'node:fs';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import {
  assertUsableImage,
  describeKnowledgeImage,
  IMAGE_LIMIT_BYTES,
  type KnowledgeImageProcessing,
} from '../src/knowledge/image-processing.js';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** 3x2 的真实 JPEG/GIF/WebP：magic 之后的校验会真的解码。 */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDgKKKK+eP2E//Z',
  'base64',
);
const TINY_GIF = Buffer.from(
  'R0lGODdhAwACAIEAAMwAAMwzMwAAAAAAACwAAAAAAwACAAAICAADAAggMEBAADs=',
  'base64',
);
const TINY_WEBP = Buffer.from(
  'UklGRjoAAABXRUJQVlA4IC4AAACwAQCdASoDAAIAAUAmJaACdLoABDAAAP7x3I/4DdfFtMv/vYL/3YL/3YL/WwAA',
  'base64',
);

const settings = (patch: Partial<KnowledgeImageProcessing> = {}): KnowledgeImageProcessing => ({
  enabled: true,
  model: 'vision-test-model',
  ocrEnabled: true,
  captionEnabled: true,
  descriptionLanguage: 'zh-CN',
  customInstructions: '',
  imageVectorEnabled: false,
  imageVectorMinScore: 0.3,
  ...patch,
});

type Captured = {
  prompt: SDKUserMessage[];
  options: Options;
};

/** 每次 query 记下真实 prompt/options，并按调用顺序给出结果或抛错。 */
function fakeQuery(
  outcome: Array<{ text?: string; error?: string }>,
  captured: Captured[],
): (params: { prompt: unknown; options: Options }) => AsyncGenerator<SDKMessage, void> {
  return (params) => {
    const entry: Captured = { prompt: [], options: params.options };
    captured.push(entry);
    async function* run(): AsyncGenerator<SDKMessage, void> {
      for await (const message of params.prompt as AsyncIterable<SDKUserMessage>) {
        entry.prompt.push(message);
      }
      const step = outcome[captured.length - 1] ?? {};
      if (step.error) throw new Error(step.error);
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        structured_output: { text: step.text ?? '' },
      } as SDKMessage;
    }
    return run();
  };
}

describe('assertUsableImage', () => {
  it('accepts all four supported formats that really decode', async () => {
    for (const image of [
      { mimeType: 'image/png', data: TINY_PNG },
      { mimeType: 'image/jpeg', data: TINY_JPEG },
      { mimeType: 'image/gif', data: TINY_GIF },
      { mimeType: 'image/webp', data: TINY_WEBP },
    ]) {
      await expect(assertUsableImage(image)).resolves.toBeUndefined();
    }
  });

  it('rejects MIME outside the SDK native set even when the bytes look fine', async () => {
    await expect(assertUsableImage({ mimeType: 'image/bmp', data: TINY_PNG })).rejects.toThrow(
      /不支持的图片 MIME/,
    );
  });
});

describe('describeKnowledgeImage', () => {
  it('sends one query per enabled action with native text+base64 image and isolated options', async () => {
    const captured: Captured[] = [];
    const result = await describeKnowledgeImage(
      {
        image: { mimeType: 'image/png', data: new Uint8Array(TINY_PNG) },
        settings: settings(),
        signal: new AbortController().signal,
      },
      { queryFn: fakeQuery([{ text: '发票号码 123' }, { text: '一张发票照片' }], captured) },
    );

    expect(result).toEqual({
      ocr: '发票号码 123',
      caption: '一张发票照片',
      warnings: [],
    });
    expect(captured).toHaveLength(2);
    for (const call of captured) {
      expect(call.options).toMatchObject({
        model: 'vision-test-model',
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        settingSources: [],
        permissionMode: 'dontAsk',
        maxTurns: 2,
        maxBudgetUsd: 0.5,
        persistSession: false,
        outputFormat: {
          type: 'json_schema',
          schema: { type: 'object', properties: { text: { type: 'string' } } },
        },
      });
      expect(call.options.settings).toMatchObject({ autoMemoryEnabled: false });
      expect(call.options.cwd).toBe(call.options.env?.HOME);
      expect(call.options.cwd).toBe(call.options.env?.CLAUDE_CONFIG_DIR);
    }
    // 原生 image content：text 指令 + base64 图块，不是自拼的聊天消息文本。
    const content = captured[0]?.prompt[0]?.message.content;
    if (!Array.isArray(content)) throw new Error('prompt is not a content block array');
    expect(content[0]).toMatchObject({ type: 'text' });
    expect(content[1]).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: TINY_PNG.toString('base64'),
      },
    });
    // 临时 cwd 已清理，不留会话目录。
    expect(existsSync(captured[0]?.options.cwd ?? '')).toBe(false);
  });

  it('keeps the successful action and warns when the other one fails', async () => {
    const result = await describeKnowledgeImage(
      {
        image: { mimeType: 'image/jpeg', data: new Uint8Array(TINY_JPEG) },
        settings: settings(),
        signal: new AbortController().signal,
      },
      {
        queryFn: fakeQuery([{ error: 'overloaded' }, { text: '一只猫坐在窗台上' }], []),
      },
    );
    expect(result.ocr).toBeNull();
    expect(result.caption).toBe('一只猫坐在窗台上');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('ocr');
  });

  it('returns no text and both warnings when every enabled action fails', async () => {
    const result = await describeKnowledgeImage(
      {
        image: { mimeType: 'image/png', data: new Uint8Array(TINY_PNG) },
        settings: settings(),
        signal: new AbortController().signal,
      },
      { queryFn: fakeQuery([{ error: 'boom' }, { error: 'boom' }], []) },
    );
    expect(result.ocr).toBeNull();
    expect(result.caption).toBeNull();
    expect(result.warnings).toHaveLength(2);
  });

  it('treats blank structured output as a failure, never as content', async () => {
    const result = await describeKnowledgeImage(
      {
        image: { mimeType: 'image/webp', data: new Uint8Array(TINY_WEBP) },
        settings: settings({ ocrEnabled: true, captionEnabled: false }),
        signal: new AbortController().signal,
      },
      { queryFn: fakeQuery([{ text: '   ' }], []) },
    );
    expect(result.ocr).toBeNull();
    expect(result.warnings).toEqual([expect.stringContaining('ocr')]);
  });

  it('does not query a disabled action', async () => {
    const captured: Captured[] = [];
    const result = await describeKnowledgeImage(
      {
        image: { mimeType: 'image/png', data: new Uint8Array(TINY_PNG) },
        settings: settings({ ocrEnabled: false }),
        signal: new AbortController().signal,
      },
      { queryFn: fakeQuery([{ text: '描述' }], captured) },
    );
    expect(captured).toHaveLength(1);
    expect(result).toEqual({ ocr: null, caption: '描述', warnings: [] });
  });

  it('rejects an unsupported MIME instead of sending raw bytes', async () => {
    await expect(
      describeKnowledgeImage(
        {
          image: { mimeType: 'image/bmp', data: new Uint8Array([0x42, 0x4d]) },
          settings: settings(),
          signal: new AbortController().signal,
        },
        { queryFn: fakeQuery([], []) },
      ),
    ).rejects.toThrow(/不支持的图片/);
  });

  it('rejects a truncated PNG and a truncated JPEG before any paid vision call', async () => {
    const captured: Captured[] = [];
    for (const image of [
      { mimeType: 'image/png', data: TINY_PNG.subarray(0, TINY_PNG.length - 6) },
      { mimeType: 'image/jpeg', data: TINY_JPEG.subarray(0, TINY_JPEG.length - 4) },
    ]) {
      await expect(
        describeKnowledgeImage(
          { image, settings: settings(), signal: new AbortController().signal },
          { queryFn: fakeQuery([], captured) },
        ),
      ).rejects.toThrow(/无法解码/);
    }
    expect(captured).toHaveLength(0);
  });

  it('rejects an image over the 5MiB vision limit before any paid vision call', async () => {
    const captured: Captured[] = [];
    const oversized = new Uint8Array(IMAGE_LIMIT_BYTES + 1);
    oversized.set(TINY_JPEG);
    await expect(
      describeKnowledgeImage(
        {
          image: { mimeType: 'image/jpeg', data: oversized },
          settings: settings(),
          signal: new AbortController().signal,
        },
        { queryFn: fakeQuery([], captured) },
      ),
    ).rejects.toThrow(/5MiB/);
    expect(captured).toHaveLength(0);
  });

  it('propagates cancellation and still runs SDK cleanup', async () => {
    const controller = new AbortController();
    let returned = false;
    const queryFn = (params: { options: Options }) => {
      async function* run(): AsyncGenerator<SDKMessage, void> {
        try {
          yield await new Promise<SDKMessage>((_resolve, reject) => {
            // 连接的是 runAction 建在 query 上的 abortController，和真实 SDK 一致。
            const signal = params.options.abortController?.signal;
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        } finally {
          returned = true;
        }
      }
      return run();
    };

    const pending = describeKnowledgeImage(
      {
        image: { mimeType: 'image/png', data: new Uint8Array(TINY_PNG) },
        settings: settings({ captionEnabled: false }),
        signal: controller.signal,
      },
      { queryFn },
    );
    // 等 query 真正开始（signal 已挂上监听）再取消。
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(pending).rejects.toThrow(/取消/);
    expect(returned).toBe(true);
  });
});
