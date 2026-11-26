import { fileTypeFromBuffer } from 'file-type';
import { fail } from './errors.js';

export type KnowledgeAudioFormat = 'mp3' | 'wav' | 'm4a' | 'flac' | 'ogg';

interface KnowledgeAudioInspection {
  format: KnowledgeAudioFormat;
  mimeType: string;
}

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
    if (declaredAudio) fail('INVALID_INPUT', '音频文件为空');
    return null;
  }
  if (overLimit && declaredAudio) {
    fail('PAYLOAD_TOO_LARGE', `音频文件超过 ${MAX_BYTES} 字节上限`);
  }

  const recognized = await fileTypeFromBuffer(data);
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
