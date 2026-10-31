/** 知识库音频入口：只认五种格式，格式识别不等于完整解码。 */
import { fileTypeFromBuffer } from 'file-type';
import { fail } from './errors.js';

export type KnowledgeAudioFormat = 'mp3' | 'wav' | 'm4a' | 'flac' | 'ogg';

export interface KnowledgeAudioInspection {
  format: KnowledgeAudioFormat;
  mimeType: string;
}

/** 与 WeKnora 知识文件入口一致；上限取十进制 25 MB，不按 base64 或压缩长度判断。 */
const MAX_BYTES = 25_000_000;

const FORMATS: Record<
  KnowledgeAudioFormat,
  { mimeType: string; declaredMimes: readonly string[]; suffix: string }
> = {
  mp3: { mimeType: 'audio/mpeg', declaredMimes: ['audio/mpeg', 'audio/mp3'], suffix: 'mp3' },
  wav: {
    mimeType: 'audio/wav',
    declaredMimes: ['audio/wav', 'audio/x-wav', 'audio/wave'],
    suffix: 'wav',
  },
  m4a: {
    mimeType: 'audio/mp4',
    declaredMimes: ['audio/mp4', 'audio/x-m4a', 'audio/m4a'],
    suffix: 'm4a',
  },
  flac: { mimeType: 'audio/flac', declaredMimes: ['audio/flac', 'audio/x-flac'], suffix: 'flac' },
  ogg: { mimeType: 'audio/ogg', declaredMimes: ['audio/ogg', 'application/ogg'], suffix: 'ogg' },
};

const DECLARED_MIME_FORMAT = new Map<string, KnowledgeAudioFormat>(
  Object.entries(FORMATS).flatMap(([format, entry]) =>
    entry.declaredMimes.map((mime) => [mime, format as KnowledgeAudioFormat] as const),
  ),
);

/** 只有这五种后缀能入库；其余音频后缀仍算“声称是音频”，用于拒绝未知内容。 */
const SUPPORTED_SUFFIX = new Map<string, KnowledgeAudioFormat>(
  Object.entries(FORMATS).map(([format, entry]) => [entry.suffix, format as KnowledgeAudioFormat]),
);

const AUDIO_SUFFIX = new Set([
  ...SUPPORTED_SUFFIX.keys(),
  'oga',
  'opus',
  'spx',
  'aac',
  'm4b',
  'wma',
  'amr',
  'weba',
  'aiff',
  'aif',
  'mp2',
  'mpga',
  'mka',
]);

/** file-type 22.3.0 只检查 FORM 魔数；AIFF/AIFC 还要求 IFF 类型字段成立。 */
function hasAiffTypeField(data: Uint8Array): boolean {
  if (data.length < 12) return false;
  const type = String.fromCharCode(...data.subarray(8, 12));
  return type === 'AIFF' || type === 'AIFC';
}

function normalizeMime(mimeType: string): string {
  return mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
}

function filenameSuffix(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** 识别结果只映射到知识入口允许的五种格式；Ogg 音频族共用 audio/ogg。 */
function detectedFormat(detected: { ext: string; mime: string }): KnowledgeAudioFormat | null {
  if (detected.ext === 'mp3') return 'mp3';
  if (detected.ext === 'wav') return 'wav';
  if (detected.ext === 'm4a') return 'm4a';
  if (detected.ext === 'flac') return 'flac';
  if (
    ['ogg', 'oga', 'opus', 'spx'].includes(detected.ext) &&
    detected.mime.startsWith('audio/ogg')
  ) {
    return 'ogg';
  }
  return null;
}

export function knowledgeAudioFromMime(mimeType: string): KnowledgeAudioInspection | null {
  const format = DECLARED_MIME_FORMAT.get(normalizeMime(mimeType));
  if (!format) return null;
  return { format, mimeType: FORMATS[format].mimeType };
}

/**
 * 普通非音频返回 null；声称是音频但字节不成立、或声明与实际格式冲突则抛 AppError。
 * 通过识别只证明容器头成立，截断/损坏的负载仍可能被转录端拒绝。
 */
export async function inspectKnowledgeAudio(input: {
  data: Uint8Array;
  filename: string;
  mimeType: string;
}): Promise<KnowledgeAudioInspection | null> {
  const { data, filename } = input;
  const declaredMime = normalizeMime(input.mimeType);
  const suffix = filenameSuffix(filename);
  const declaredAudio =
    declaredMime.startsWith('audio/') ||
    declaredMime === 'application/ogg' ||
    AUDIO_SUFFIX.has(suffix);
  const overLimit = data.length > MAX_BYTES;

  if (data.length === 0) {
    // 空字节没有魔数可判；只有声明为音频时才是音频入口错误，普通空文件沿用既有解析。
    if (declaredAudio) fail('INVALID_INPUT', '音频文件为空');
    return null;
  }
  // 声称是音频时先卡住 25 MB；非音频仍走现有 32 MiB 上传限额。
  if (overLimit && declaredAudio) {
    fail('PAYLOAD_TOO_LARGE', `音频文件超过 ${MAX_BYTES} 字节上限`);
  }

  const recognized = await fileTypeFromBuffer(data);
  // 普通文本也可能以 FORM 开头，不能被 file-type 的宽松 IFF 识别误判成音频。
  const detected = recognized?.ext === 'aif' && !hasAiffTypeField(data) ? null : recognized;
  if (!detected) {
    if (declaredAudio) fail('UNSUPPORTED_MEDIA_TYPE', '内容不是可识别的音频格式');
    return null;
  }

  const format = detectedFormat(detected);
  if (!format) {
    if (detected.mime.startsWith('audio/') || detected.mime === 'application/ogg') {
      if (overLimit) fail('PAYLOAD_TOO_LARGE', `音频文件超过 ${MAX_BYTES} 字节上限`);
      fail('UNSUPPORTED_MEDIA_TYPE', `不支持的音频格式: ${detected.ext}`);
    }
    if (declaredAudio) {
      fail('INVALID_INPUT', `声明为音频，实际识别为 ${detected.mime}`);
    }
    return null;
  }
  if (overLimit) fail('PAYLOAD_TOO_LARGE', `音频文件超过 ${MAX_BYTES} 字节上限`);

  const canonical = FORMATS[format];
  if (declaredMime && declaredMime !== 'application/octet-stream') {
    const declaredFormat = DECLARED_MIME_FORMAT.get(declaredMime);
    if (declaredFormat !== format) {
      fail('INVALID_INPUT', `MIME ${declaredMime} 与实际音频格式 ${format} 不一致`);
    }
  }
  if (suffix) {
    if (SUPPORTED_SUFFIX.get(suffix) !== format) {
      fail('INVALID_INPUT', `后缀 .${suffix} 与实际音频格式 ${format} 不一致`);
    }
  }

  return { format, mimeType: canonical.mimeType };
}
