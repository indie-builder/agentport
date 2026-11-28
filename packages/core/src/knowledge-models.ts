import {
  type KNOWLEDGE_EMBEDDING_DIMENSIONS,
  type KnowledgeEmbeddingProtocol,
  knowledgeEmbeddingProtocolSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { fail } from './errors.js';
import { type KnowledgeAudioFormat, knowledgeAudioFromMime } from './knowledge-audio.js';

export interface EmbeddingProfile {
  endpointUrl: string;
  model: string;
  apiKey?: string;
  dimensions: typeof KNOWLEDGE_EMBEDDING_DIMENSIONS;
  embeddingProtocol?: KnowledgeEmbeddingProtocol;
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

interface AudioSegment {
  text: string;
  timeFromMs: number;
  timeToMs: number;
}

export interface AudioTranscript {
  text: string;
  durationMs: number | null;
  segments: AudioSegment[];
}

type KnowledgeModelFailureKind = 'auth' | 'rate_limit' | 'timeout' | 'bad_response' | 'unavailable';

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
const ASR_TIMEOUT_MS = 300_000;

function classifyStatus(status: number): KnowledgeModelFailureKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 408 || status >= 500) return 'unavailable';
  return 'bad_response';
}

function excerpt(body: string): string {
  return body.slice(0, 200).replace(/\s+/g, ' ');
}

function classifyFetchFailure(
  err: unknown,
  url: string,
  timeout: AbortSignal,
  signal: AbortSignal | undefined,
): never {
  if (signal?.aborted) throw err;
  if (timeout.aborted) throw new KnowledgeModelError('timeout', `请求超时: ${url}`);
  if (err instanceof Error && (err as Error & { code?: unknown }).code === 'UnexpectedRedirect') {
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

async function postWithTimeout(
  url: string,
  init: { headers: Record<string, string>; body: NonNullable<RequestInit['body']> },
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: init.headers,
      body: init.body,
      signal: combined,
    });
  } catch (err) {
    classifyFetchFailure(err, url, timeout, signal);
  }
  return readJsonResponse(response, url, timeout, signal);
}

async function postJson(
  url: string,
  body: unknown,
  profile: { apiKey?: string },
  signal: AbortSignal | undefined,
): Promise<unknown> {
  return postWithTimeout(
    url,
    {
      headers: {
        'content-type': 'application/json',
        ...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    },
    REQUEST_TIMEOUT_MS,
    signal,
  );
}

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
  return profile.embeddingProtocol === knowledgeEmbeddingProtocolSchema.enum.cohere_v2;
}

async function cohereEmbed(
  profile: EmbeddingProfile,
  body: Record<string, unknown>,
  count: number,
  signal: AbortSignal | undefined,
): Promise<number[][]> {
  const payload = await postJson(
    `${profile.endpointUrl.replace(/\/$/, '')}/embed`,
    {
      model: profile.model,
      embedding_types: ['float'],
      output_dimension: profile.dimensions,
      ...body,
    },
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

function multipartFilename(filename: string, format: KnowledgeAudioFormat): string {
  const base = [...(filename.split(/[\\/]/).pop() ?? '')]
    .filter((char) => char >= ' ' && char !== '\x7f' && char !== '"')
    .join('')
    .trim();
  const stem = base.replace(/\.[^.]*$/, '') || 'audio';
  return `${stem}.${format}`;
}

async function postMultipart(
  url: string,
  form: FormData,
  profile: { apiKey?: string },
  signal: AbortSignal | undefined,
): Promise<unknown> {
  return postWithTimeout(
    url,
    { headers: profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}, body: form },
    ASR_TIMEOUT_MS,
    signal,
  );
}

export async function transcribeAudio(
  profile: AsrProfile,
  input: { data: Uint8Array; filename: string; mimeType: string },
  signal?: AbortSignal,
): Promise<AudioTranscript> {
  const audio = knowledgeAudioFromMime(input.mimeType);
  if (!audio) fail('UNSUPPORTED_MEDIA_TYPE', `不支持的音频 MIME: ${input.mimeType}`);

  const audioBytes =
    input.data.buffer instanceof ArrayBuffer
      ? new Uint8Array(input.data.buffer, input.data.byteOffset, input.data.byteLength)
      : new Uint8Array(input.data);
  const form = new FormData();
  form.append(
    'file',
    new Blob([audioBytes], { type: audio.mimeType }),
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
