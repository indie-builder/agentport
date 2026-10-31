/** 知识库 embedding/rerank/ASR 客户端；失败分类是任务重试策略的唯一依据。 */
import { z } from 'zod';
import { fail } from './errors.js';
import { type KnowledgeAudioFormat, knowledgeAudioFromMime } from './knowledge-audio.js';

export type EmbeddingProtocol = 'openai' | 'cohere_v2';

export interface EmbeddingProfile {
  endpointUrl: string;
  model: string;
  apiKey?: string;
  dimensions: 1024;
  /** 缺省按现有 OpenAI 兼容协议，不影响旧调用方。 */
  embeddingProtocol?: EmbeddingProtocol;
  /** 仅 cohere_v2 + embed-v4.0 可开启；普通文本向量不受影响。 */
  imageInputEnabled?: boolean;
}

export interface RerankProfile {
  endpointUrl: string;
  model: string;
  apiKey?: string;
}

/** endpointUrl 是完整最终 URL，不做 vendored `/v1` 或路径拼接。 */
export interface AsrProfile {
  endpointUrl: string;
  model: string;
  apiKey?: string;
}

export interface AudioSegment {
  text: string;
  timeFromMs: number;
  timeToMs: number;
}

export interface AudioTranscript {
  text: string;
  durationMs: number | null;
  /** 上游没有段级时码时为空数组。 */
  segments: AudioSegment[];
}

export type KnowledgeModelFailureKind =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'bad_response'
  | 'unavailable';

export class KnowledgeModelError extends Error {
  constructor(
    readonly kind: KnowledgeModelFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'KnowledgeModelError';
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
/** 与 WeKnora 默认一致；只用于转录，不放长 embedding/rerank 的全局超时。 */
const ASR_TIMEOUT_MS = 300_000;

function classifyStatus(status: number): KnowledgeModelFailureKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 408 || status >= 500) return 'unavailable';
  return 'bad_response';
}

/** 响应体只用于定位，最多留 200 字符，绝不把整段响应写进日志。 */
function excerpt(body: string): string {
  return body.slice(0, 200).replace(/\s+/g, ' ');
}

function classifyFetchFailure(
  err: unknown,
  url: string,
  timeout: AbortSignal,
  signal: AbortSignal | undefined,
): never {
  // 调用方取消是控制流，不是模型故障；必须优先于请求超时判断。
  if (signal?.aborted) throw err;
  if (timeout.aborted) throw new KnowledgeModelError('timeout', `请求超时: ${url}`);
  if (
    err instanceof Error &&
    /unexpected redirect/.test(err.cause instanceof Error ? err.cause.message : err.message)
  ) {
    throw new KnowledgeModelError('bad_response', `端点返回重定向: ${url}`);
  }
  throw new KnowledgeModelError('unavailable', `无法连接模型端点: ${url}`);
}

async function readJsonResponse(
  response: Response,
  url: string,
  timeout: AbortSignal,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  if (!response.ok) {
    throw new KnowledgeModelError(
      classifyStatus(response.status),
      `HTTP ${response.status}: ${excerpt(await response.text().catch(() => ''))}`,
    );
  }
  let body: string;
  try {
    // 先读完 body 再解析：读失败是传输故障，不能和完整 JSON 的语法错误混为一类。
    body = await response.text();
  } catch (err) {
    classifyFetchFailure(err, url, timeout, signal);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new KnowledgeModelError('bad_response', '响应不是合法 JSON');
  }
}

async function postJson(
  url: string,
  body: unknown,
  profile: { apiKey?: string },
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      // 凭证随请求头走；重定向到另一个 origin 会把凭证暴露给不可信主机。
      redirect: 'error',
      signal: combined,
    });
  } catch (err) {
    classifyFetchFailure(err, url, timeout, signal);
  }
  return readJsonResponse(response, url, timeout, signal);
}

/** 响应是信任边界：index 必须唯一、在输入范围内，分数/向量值必须是有限数。 */
function badResponse(message: string): KnowledgeModelError {
  return new KnowledgeModelError('bad_response', message);
}

function indexGuard(count: number): (index: number) => void {
  const seen = new Set<number>();
  return (index) => {
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw badResponse(`响应 index ${index} 超出输入范围 0..${count - 1}`);
    }
    if (seen.has(index)) throw badResponse(`响应 index ${index} 重复`);
    seen.add(index);
  };
}

const embeddingResponseSchema = z.object({
  data: z.array(
    z.object({
      // 兼容省略 index 的实现：缺失时按数组位置恢复顺序。
      index: z.number().finite().optional(),
      embedding: z.array(z.number().finite()),
    }),
  ),
});

const rerankResponseSchema = z.object({
  results: z.array(
    z.object({
      index: z.number().finite(),
      relevance_score: z.number().finite().optional(),
      score: z.number().finite().optional(),
    }),
  ),
});

const cohereEmbeddingResponseSchema = z.object({
  embeddings: z.object({
    float: z.array(z.array(z.number().finite())),
  }),
});

/** 一次请求的向量集合：条数、有限值与维度都在入口之外校验，不静默截断。 */
function checkVectors(
  vectors: number[][],
  expected: { count: number; dimensions: number },
  label: string,
): number[][] {
  if (vectors.length !== expected.count) {
    throw badResponse(`${label} 返回 ${vectors.length} 条，期望 ${expected.count}`);
  }
  for (const [index, vector] of vectors.entries()) {
    if (vector.length !== expected.dimensions) {
      throw badResponse(`${label}[${index}] 维度 ${vector.length}，期望 ${expected.dimensions}`);
    }
  }
  return vectors;
}

function isCohere(profile: EmbeddingProfile): boolean {
  return profile.embeddingProtocol === 'cohere_v2';
}

/** Cohere v2 Embed：endpointUrl 是含 `/v2` 的 API 根。 */
async function cohereEmbed(
  profile: EmbeddingProfile,
  body: Record<string, unknown>,
  count: number,
  signal: AbortSignal | undefined,
): Promise<number[][]> {
  const payload = await postJson(
    `${profile.endpointUrl.replace(/\/$/, '')}/embed`,
    { model: profile.model, embedding_types: ['float'], output_dimension: 1024, ...body },
    profile,
    signal,
  );
  const parsed = cohereEmbeddingResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw badResponse(`embed 响应不合法: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  return checkVectors(
    parsed.data.embeddings.float,
    { count, dimensions: profile.dimensions },
    'embed',
  );
}

/** OpenAI 兼容 `/embeddings`；维度不符标 bad_response，不静默截断。 */
export async function embedTexts(
  profile: EmbeddingProfile,
  texts: string[],
  signal?: AbortSignal,
  inputType: 'search_document' | 'search_query' = 'search_document',
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (isCohere(profile)) {
    return cohereEmbed(profile, { texts, input_type: inputType }, texts.length, signal);
  }
  const payload = await postJson(
    `${profile.endpointUrl.replace(/\/$/, '')}/embeddings`,
    { model: profile.model, input: texts },
    profile,
    signal,
  );
  const parsed = embeddingResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw badResponse(`embeddings 响应不合法: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  const { data } = parsed.data;
  if (data.length !== texts.length) {
    throw badResponse(`embeddings 返回 ${data.length} 条，期望 ${texts.length}`);
  }
  const checkIndex = indexGuard(texts.length);
  const vectors: number[][] = Array.from({ length: texts.length });
  for (const [position, entry] of data.entries()) {
    const index = entry.index ?? position;
    checkIndex(index);
    if (entry.embedding.length !== profile.dimensions) {
      throw badResponse(
        `embeddings[${index}] 维度 ${entry.embedding.length}，期望 ${profile.dimensions}`,
      );
    }
    vectors[index] = entry.embedding;
  }
  return vectors;
}

/** 同空间图片向量：只有 cohere_v2 且显式开启图片输入的 profile 才能调用。 */
export async function embedImages(
  profile: EmbeddingProfile,
  images: { mimeType: string; dataBase64: string }[],
  signal?: AbortSignal,
): Promise<number[][]> {
  if (images.length === 0) return [];
  if (!isCohere(profile) || !profile.imageInputEnabled) {
    throw badResponse('当前 embedding profile 不支持图片向量（需要 cohere_v2 且开启图片输入）');
  }
  return cohereEmbed(
    profile,
    {
      images: images.map((image) => `data:${image.mimeType};base64,${image.dataBase64}`),
      input_type: 'image',
    },
    images.length,
    signal,
  );
}

/** 兼容 `{results:[{index,relevance_score}]}` 与 `{results:[{index,score}]}` 两种常见形状。 */
export async function rerankDocuments(
  profile: RerankProfile,
  query: string,
  documents: string[],
  signal?: AbortSignal,
): Promise<Array<{ index: number; score: number }>> {
  if (documents.length === 0) return [];
  const payload = await postJson(
    `${profile.endpointUrl.replace(/\/$/, '')}/rerank`,
    { model: profile.model, query, documents },
    profile,
    signal,
  );
  const parsed = rerankResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw badResponse(`rerank 响应不合法: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  // 部分结果也是坏响应：调用方无法判断未返回的候选该排第几，只能整体退回 RRF。
  if (parsed.data.results.length !== documents.length) {
    throw badResponse(`rerank 返回 ${parsed.data.results.length} 条，期望 ${documents.length}`);
  }
  const checkIndex = indexGuard(documents.length);
  return parsed.data.results.map((entry) => {
    checkIndex(entry.index);
    const score = entry.relevance_score ?? entry.score;
    if (score === undefined) throw badResponse(`rerank 结果缺少 index ${entry.index} 的分数`);
    return { index: entry.index, score };
  });
}

/** 上游 verbose_json：text 必填；duration/segments 可缺省，给了就必须是真实时码。 */
const transcriptResponseSchema = z.object({
  text: z.string(),
  duration: z.number().finite().nonnegative().optional(),
  segments: z
    .array(
      z.object({
        start: z.number().finite().nonnegative(),
        end: z.number().finite().nonnegative(),
        text: z.string(),
      }),
    )
    .optional(),
});

function toMilliseconds(seconds: number, label: string): number {
  const milliseconds = Math.round(seconds * 1000);
  if (!Number.isSafeInteger(milliseconds)) {
    throw badResponse(`${label} 超出可安全表示的毫秒范围`);
  }
  return milliseconds;
}

/** multipart 文件名必须是单段、无控制字符，并使用真实格式后缀。 */
function multipartFilename(filename: string, format: KnowledgeAudioFormat): string {
  const base = [...(filename.split(/[\\/]/).pop() ?? '')]
    .filter((char) => char >= ' ' && char !== '\x7f' && char !== '"')
    .join('')
    .trim();
  const stem = base.replace(/\.[^.]*$/, '') || 'audio';
  return `${stem}.${format}`;
}

/** 原生 FormData 自带 boundary；不手写 content-type，也不补 endpoint 路径。 */
async function postMultipart(
  url: string,
  form: FormData,
  profile: { apiKey?: string },
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(ASR_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {},
      body: form,
      redirect: 'error',
      signal: combined,
    });
  } catch (err) {
    classifyFetchFailure(err, url, timeout, signal);
  }
  return readJsonResponse(response, url, timeout, signal);
}

/** 只实现 OpenAI Transcriptions multipart + verbose_json 段级时间协议。 */
export async function transcribeAudio(
  profile: AsrProfile,
  input: { data: Uint8Array; filename: string; mimeType: string },
  signal?: AbortSignal,
): Promise<AudioTranscript> {
  const audio = knowledgeAudioFromMime(input.mimeType);
  if (!audio) fail('UNSUPPORTED_MEDIA_TYPE', `不支持的音频 MIME: ${input.mimeType}`);

  const form = new FormData();
  form.append(
    'file',
    new Blob([input.data], { type: audio.mimeType }),
    multipartFilename(input.filename, audio.format),
  );
  form.append('model', profile.model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');

  const payload = await postMultipart(profile.endpointUrl, form, profile, signal);
  const parsed = transcriptResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw badResponse(`转录响应不合法: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }

  const segments: AudioSegment[] = [];
  let previousStart: number | undefined;
  for (const [index, segment] of (parsed.data.segments ?? []).entries()) {
    if (segment.end < segment.start) {
      throw badResponse(`segments[${index}] 的 end 小于 start`);
    }
    if (previousStart !== undefined && segment.start < previousStart) {
      throw badResponse(`segments[${index}] 的 start 早于前一段`);
    }
    previousStart = segment.start;
    segments.push({
      text: segment.text,
      timeFromMs: toMilliseconds(segment.start, `segments[${index}].start`),
      timeToMs: toMilliseconds(segment.end, `segments[${index}].end`),
    });
  }

  return {
    text: parsed.data.text,
    durationMs:
      parsed.data.duration === undefined ? null : toMilliseconds(parsed.data.duration, 'duration'),
    segments,
  };
}

/** 中文用词粒度分词；Postgres `simple` 词典直接消费空格拼接结果。 */
export function segmentForSearch(text: string): string {
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
  const words: string[] = [];
  for (const segment of segmenter.segment(text)) {
    if (segment.isWordLike) words.push(segment.segment);
  }
  return words.join(' ');
}
