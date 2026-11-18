import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  errorText,
  KNOWLEDGE_IMAGE_MAX_BYTES,
  type KnowledgeImageProcessing,
} from '@agentport/shared';
import {
  type Options,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import sharp from 'sharp';
import { z } from 'zod';
import { hermeticQueryOptions, runOneShotSdkQuery } from '../one-shot-sdk.js';

type ImageDescription = {
  ocr: string | null;
  caption: string | null;
  warnings: string[];
};

const SDK_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** IEND 块固定为 12 字节：长度 0（前 4 字节）+ 名称 + 固定 CRC；只看尾部 8 字节。 */
const PNG_IEND_TAIL = 'IEND\xaeB\x60\x82';

/**
 * 视觉调用前的实际校验：SDK 只按 MIME 收图，坏图到这里才失败最贵。
 * sharp 是项目里唯一成熟的四格式解码器（PNG/JPEG/GIF/WebP 全量解到 raw），
 * 截断文件在这里抛错；尺寸上限由 sharp 的 limitInputPixels 兜底。
 */
export async function assertUsableImage(input: {
  mimeType: string;
  data: Uint8Array;
}): Promise<void> {
  if (!SDK_IMAGE_MIME.has(input.mimeType)) {
    throw new Error(`不支持的图片 MIME: ${input.mimeType}`);
  }
  if (input.data.length > KNOWLEDGE_IMAGE_MAX_BYTES) {
    throw new Error('图片超过 5MiB，不能供视觉模型直接读取');
  }
  try {
    // raw() 才会真正解码像素；metadata() 只读文件头，截断图能蒙混过关。
    await sharp(input.data, { limitInputPixels: 268402689 }).raw().toBuffer();
  } catch (err) {
    const message = errorText(err);
    throw new Error(`图片无法解码：${message}`);
  }
  // libvips 在像素完整时容忍缺失的 PNG IEND；尾部被截断的文件仍要拒绝。
  if (
    input.mimeType === 'image/png' &&
    Buffer.from(input.data.subarray(-8)).toString('latin1') !== PNG_IEND_TAIL
  ) {
    throw new Error('图片无法解码：PNG 数据被截断');
  }
}

const outputSchema = z.object({ text: z.string() });

type ImageQueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncGenerator<SDKMessage, void>;

export type { ImageQueryFn };

/**
 * 一次 query 只做一个动作：text + base64 图 → structured_output {text}。
 * 单动作失败只记 warning 并返回 null，由调用方决定整图是否可发布。
 */
async function runAction(input: {
  action: 'ocr' | 'caption';
  instruction: string;
  mimeType: string;
  dataBase64: string;
  model: string;
  signal: AbortSignal;
  queryFn: ImageQueryFn;
}): Promise<{ text: string | null; warning: string | null }> {
  if (input.signal.aborted) throw new Error('图片描述已取消');
  const cwd = await mkdtemp(join(tmpdir(), 'pace-knowledge-image-'));

  const prompt = async function* (): AsyncGenerator<SDKUserMessage, void> {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: input.instruction },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: input.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
              data: input.dataBase64,
            },
          },
        ],
      },
      parent_tool_use_id: null,
    };
  };

  let value: string | null = null;
  try {
    const outcome = await runOneShotSdkQuery({
      signal: input.signal,
      cwd,
      create: (controller) => {
        const options = hermeticQueryOptions({
          model: input.model,
          cwd,
          abortController: controller,
          maxTurns: 2,
          maxBudgetUsd: 0.5,
          outputFormat: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
              additionalProperties: false,
            },
          },
        });
        return input.queryFn({ prompt: prompt(), options });
      },
      onSuccessFrame: (message) => {
        const parsed = outputSchema.safeParse(message.structured_output);
        const text = parsed.success ? parsed.data.text.trim() : '';
        if (text !== '') value = text;
      },
    });
    if (outcome.status === 'aborted') throw new Error('图片描述已取消');
    if (outcome.status === 'no_result') {
      return { text: null, warning: `${input.action}: SDK 没有返回结果` };
    }
    if (outcome.status === 'failure') {
      return { text: null, warning: `${input.action}: ${outcome.message}` };
    }
    if (value === null) return { text: null, warning: `${input.action}: 输出为空` };
    return { text: value, warning: null };
  } catch (err) {
    if (input.signal.aborted) throw new Error('图片描述已取消');
    const message = errorText(err);
    return { text: null, warning: `${input.action}: ${message}`.slice(0, 300) };
  }
}

function instruction(action: 'ocr' | 'caption', settings: KnowledgeImageProcessing): string {
  const shared =
    settings.customInstructions.trim() === ''
      ? ''
      : `\n补充要求：${settings.customInstructions.trim()}`;
  if (action === 'ocr') {
    return `识别图片中的全部文字，按阅读顺序输出纯文本；没有文字时 text 返回空字符串。只返回 JSON。${shared}`;
  }
  return `描述这张图片的内容、结构与关键信息，使用${settings.descriptionLanguage}。只返回 JSON。${shared}`;
}

export async function describeKnowledgeImage(
  input: {
    image: { mimeType: string; data: Uint8Array };
    settings: KnowledgeImageProcessing;
    signal: AbortSignal;
  },
  deps: { queryFn?: ImageQueryFn } = {},
): Promise<ImageDescription> {
  const { settings, signal } = input;
  if (signal.aborted) throw new Error('图片描述已取消');
  await assertUsableImage(input.image);
  if (!settings.enabled) throw new Error('图片处理未启用');
  if (!settings.model) throw new Error('图片处理缺少视觉模型');

  const queryFn = deps.queryFn ?? query;
  const dataBase64 = Buffer.from(input.image.data).toString('base64');
  const result: ImageDescription = { ocr: null, caption: null, warnings: [] };
  for (const action of ['ocr', 'caption'] as const) {
    const enabled = action === 'ocr' ? settings.ocrEnabled : settings.captionEnabled;
    if (!enabled) continue;
    if (signal.aborted) throw new Error('图片描述已取消');
    const output = await runAction({
      action,
      instruction: instruction(action, settings),
      mimeType: input.image.mimeType,
      dataBase64,
      model: settings.model,
      signal,
      queryFn,
    });
    result[action] = output.text;
    if (output.warning) result.warnings.push(output.warning);
  }
  return result;
}
