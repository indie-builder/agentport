import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AsrProfile,
  type EmbeddingProfile,
  embedImages,
  embedTexts,
  KnowledgeModelError,
  type RerankProfile,
  rerankDocuments,
  transcribeAudio,
} from '../src/knowledge-models.js';

let server: Server;
let baseUrl = '';
let embeddingBody: unknown = {};
let rerankBody: unknown = {};
let redirectHits = 0;
let lastEmbedRequest: { url?: string; body: unknown } | null = null;

const embeddingProfile = (): EmbeddingProfile => ({
  endpointUrl: baseUrl,
  model: 'test',
  dimensions: 1024,
});

const rerankProfile = (): RerankProfile => ({ endpointUrl: baseUrl, model: 'test' });

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      lastEmbedRequest = { url: req.url, body };
      if (req.url === '/redirect/embeddings' || req.url === '/redirect/rerank') {
        redirectHits += 1;
        res.writeHead(302, { location: '/embeddings' });
        res.end();
        return;
      }
      if (req.url === '/embeddings' || req.url === '/v2/embed') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(embeddingBody));
        return;
      }
      if (req.url === '/rerank') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rerankBody));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  embeddingBody = {};
  rerankBody = {};
  redirectHits = 0;
  lastEmbedRequest = null;
});

const vector = (seed: number): number[] =>
  Array.from({ length: 1024 }, (_, index) => (index === 0 ? seed : 0));

describe('embedTexts', () => {
  it('restores caller order from the response index instead of trusting array order', async () => {
    embeddingBody = {
      data: [
        { index: 2, embedding: vector(3) },
        { index: 0, embedding: vector(1) },
        { index: 1, embedding: vector(2) },
      ],
    };

    const result = await embedTexts(embeddingProfile(), ['a', 'b', 'c']);

    expect(result.map((entry) => entry[0])).toEqual([1, 2, 3]);
  });

  it('rejects string or non-finite vector values at the response boundary', async () => {
    embeddingBody = { data: [{ index: 0, embedding: ['1', ...vector(0).slice(1)] }] };
    await expect(embedTexts(embeddingProfile(), ['a'])).rejects.toMatchObject({
      kind: 'bad_response',
    });

    embeddingBody = { data: [{ index: 0, embedding: [Number.NaN, ...vector(0).slice(1)] }] };
    await expect(embedTexts(embeddingProfile(), ['a'])).rejects.toMatchObject({
      kind: 'bad_response',
    });

    embeddingBody = {
      data: [{ index: 0, embedding: [Number.POSITIVE_INFINITY, ...vector(0).slice(1)] }],
    };
    await expect(embedTexts(embeddingProfile(), ['a'])).rejects.toMatchObject({
      kind: 'bad_response',
    });
  });

  it('rejects duplicate, missing or out-of-range indices', async () => {
    embeddingBody = {
      data: [
        { index: 0, embedding: vector(1) },
        { index: 0, embedding: vector(2) },
      ],
    };
    await expect(embedTexts(embeddingProfile(), ['a', 'b'])).rejects.toMatchObject({
      kind: 'bad_response',
    });

    embeddingBody = { data: [{ index: 0, embedding: vector(1) }] };
    await expect(embedTexts(embeddingProfile(), ['a', 'b'])).rejects.toMatchObject({
      kind: 'bad_response',
    });

    embeddingBody = {
      data: [
        { index: 0, embedding: vector(1) },
        { index: 5, embedding: vector(2) },
      ],
    };
    await expect(embedTexts(embeddingProfile(), ['a', 'b'])).rejects.toMatchObject({
      kind: 'bad_response',
    });
  });

  it('still rejects a dimension mismatch', async () => {
    embeddingBody = { data: [{ index: 0, embedding: [1, 2, 3] }] };
    await expect(embedTexts(embeddingProfile(), ['a'])).rejects.toMatchObject({
      kind: 'bad_response',
    });
  });

  it('does not follow redirects with credentials attached', async () => {
    const profile = { ...embeddingProfile(), apiKey: 'secret' };
    profile.endpointUrl = `${baseUrl}/redirect`;
    await expect(embedTexts(profile, ['a'])).rejects.toBeInstanceOf(KnowledgeModelError);
    expect(redirectHits).toBe(1);
  });

  it('classifies a success body interrupted in transit as unavailable', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":'));
            queueMicrotask(() => controller.error(new TypeError('terminated')));
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    try {
      await expect(embedTexts(embeddingProfile(), ['a'])).rejects.toMatchObject({
        kind: 'unavailable',
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

const cohereProfile = (): EmbeddingProfile => ({
  endpointUrl: `${baseUrl}/v2`,
  model: 'embed-v4.0',
  dimensions: 1024,
  embeddingProtocol: 'cohere_v2',
  imageInputEnabled: true,
});

const cohereResponse = (vectors: number[][]) => ({
  id: 'embed-1',
  embeddings: { float: vectors },
});

describe('embedTexts with cohere_v2', () => {
  it('posts texts to /embed with search_document, float output and 1024 dimensions', async () => {
    embeddingBody = cohereResponse([vector(1), vector(2)]);

    await embedTexts(cohereProfile(), ['a', 'b']);

    expect(lastEmbedRequest?.url).toBe('/v2/embed');
    expect(lastEmbedRequest?.body).toEqual({
      model: 'embed-v4.0',
      texts: ['a', 'b'],
      input_type: 'search_document',
      embedding_types: ['float'],
      output_dimension: 1024,
    });
  });

  it('uses inputType search_query for queries and rejects other values', async () => {
    embeddingBody = cohereResponse([vector(1)]);
    await embedTexts(cohereProfile(), ['q'], undefined, 'search_query');
    expect(((lastEmbedRequest?.body ?? {}) as { input_type?: string }).input_type).toBe(
      'search_query',
    );
  });

  it('leaves the OpenAI request unchanged', async () => {
    const openai = {
      endpointUrl: baseUrl,
      model: 'text-embedding-3-small',
      dimensions: 1024 as const,
    };
    embeddingBody = { data: [{ index: 0, embedding: vector(1) }] };

    await embedTexts(openai, ['a'], undefined, 'search_query');

    expect(lastEmbedRequest?.url).toBe('/embeddings');
    // 旧请求体没有 input_type/output_dimension 等 Cohere 字段。
    expect(lastEmbedRequest?.body).toEqual({ model: 'text-embedding-3-small', input: ['a'] });
  });

  it('validates the cohere response count, finiteness and dimensions', async () => {
    embeddingBody = cohereResponse([vector(1), vector(2)]);
    await expect(embedTexts(cohereProfile(), ['a'])).rejects.toMatchObject({
      kind: 'bad_response',
    });

    embeddingBody = cohereResponse([[Number.NaN, ...vector(0).slice(1)]]);
    await expect(embedTexts(cohereProfile(), ['a'])).rejects.toMatchObject({
      kind: 'bad_response',
    });

    embeddingBody = cohereResponse([[1, 2, 3]]);
    await expect(embedTexts(cohereProfile(), ['a'])).rejects.toMatchObject({
      kind: 'bad_response',
    });

    embeddingBody = { embeddings: {} };
    await expect(embedTexts(cohereProfile(), ['a'])).rejects.toMatchObject({
      kind: 'bad_response',
    });
  });
});

describe('embedImages', () => {
  it('posts data URIs to /embed with the image protocol fields', async () => {
    embeddingBody = cohereResponse([vector(1)]);

    const result = await embedImages(cohereProfile(), [
      { mimeType: 'image/png', dataBase64: 'AAAA' },
    ]);

    expect(result[0]?.[0]).toBe(1);
    expect(lastEmbedRequest?.url).toBe('/v2/embed');
    expect(lastEmbedRequest?.body).toEqual({
      model: 'embed-v4.0',
      images: ['data:image/png;base64,AAAA'],
      input_type: 'image',
      embedding_types: ['float'],
      output_dimension: 1024,
    });
  });

  it('refuses profiles without the cohere image protocol', async () => {
    const openai = { endpointUrl: baseUrl, model: 'embed-v4.0', dimensions: 1024 as const };
    await expect(
      embedImages(openai, [{ mimeType: 'image/png', dataBase64: 'AAAA' }]),
    ).rejects.toMatchObject({ kind: 'bad_response' });
    expect(lastEmbedRequest).toBeNull();
  });

  it('refuses a cohere profile without imageInputEnabled', async () => {
    await expect(
      embedImages({ ...cohereProfile(), imageInputEnabled: false }, [
        { mimeType: 'image/png', dataBase64: 'AAAA' },
      ]),
    ).rejects.toMatchObject({ kind: 'bad_response' });
  });

  it('maps HTTP failures to the existing error kinds', async () => {
    await expect(
      embedImages({ ...cohereProfile(), endpointUrl: `${baseUrl}/missing` }, [
        { mimeType: 'image/png', dataBase64: 'AAAA' },
      ]),
    ).rejects.toMatchObject({ kind: 'bad_response' });
  });
});

describe('rerankDocuments', () => {
  it('accepts relevance_score and score and validates indices', async () => {
    rerankBody = {
      results: [
        { index: 1, relevance_score: 0.9 },
        { index: 0, score: 0.2 },
      ],
    };
    await expect(rerankDocuments(rerankProfile(), 'q', ['a', 'b'])).resolves.toEqual([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.2 },
    ]);
  });

  it('rejects an index outside the document range', async () => {
    rerankBody = { results: [{ index: 2, score: 0.5 }] };
    await expect(rerankDocuments(rerankProfile(), 'q', ['a', 'b'])).rejects.toMatchObject({
      kind: 'bad_response',
    });
  });

  it('rejects partial results instead of silently dropping candidates', async () => {
    rerankBody = { results: [{ index: 0, score: 0.5 }] };
    await expect(rerankDocuments(rerankProfile(), 'q', ['a', 'b'])).rejects.toMatchObject({
      kind: 'bad_response',
    });
  });

  it('rejects duplicate indices, non-finite scores and missing scores', async () => {
    rerankBody = {
      results: [
        { index: 0, score: 0.5 },
        { index: 0, score: 0.6 },
      ],
    };
    await expect(rerankDocuments(rerankProfile(), 'q', ['a', 'b'])).rejects.toMatchObject({
      kind: 'bad_response',
    });

    rerankBody = { results: [{ index: 0, score: Number.NaN }] };
    await expect(rerankDocuments(rerankProfile(), 'q', ['a'])).rejects.toMatchObject({
      kind: 'bad_response',
    });

    rerankBody = { results: [{ index: 0 }] };
    await expect(rerankDocuments(rerankProfile(), 'q', ['a'])).rejects.toMatchObject({
      kind: 'bad_response',
    });
  });

  it('does not follow redirects with credentials attached', async () => {
    const profile = { ...rerankProfile(), apiKey: 'secret' };
    profile.endpointUrl = `${baseUrl}/redirect`;
    await expect(rerankDocuments(profile, 'q', ['a'])).rejects.toBeInstanceOf(KnowledgeModelError);
    expect(redirectHits).toBe(1);
  });
});

interface CapturedAsrRequest {
  url: string | undefined;
  authorization: string | undefined;
  contentType: string;
  file: { name: string; type: string; bytes: number[] } | null;
  model: string | null;
  responseFormat: string | null;
  granularities: string[];
  keys: string[];
}

describe('transcribeAudio', () => {
  let asrServer: Server;
  let asrBaseUrl = '';
  let asrResponse = { status: 200, body: '{"text":"ok"}', contentType: 'application/json' };
  let asrRedirectHits = 0;
  let hangReached: (() => void) | undefined;
  let lastRequest: CapturedAsrRequest | null = null;
  let audio: Uint8Array;

  const input = () => ({
    data: audio,
    filename: '../../Meeting/纪要 01.MP3',
    mimeType: 'audio/mpeg',
  });
  const profile = (): AsrProfile => ({
    endpointUrl: `${asrBaseUrl}/v1/audio/transcriptions`,
    model: 'whisper-1',
    apiKey: 'secret',
  });
  const stringEntry = (value: FormDataEntryValue | null): string | null =>
    typeof value === 'string' ? value : null;

  beforeAll(async () => {
    audio = new Uint8Array(await readFile(new URL('./fixtures/audio/tone.mp3', import.meta.url)));
    asrServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        void (async () => {
          try {
            if (req.url === '/hang') {
              hangReached?.();
              return;
            }
            if (req.url === '/redirect') {
              asrRedirectHits += 1;
              res.writeHead(302, { location: '/v1/audio/transcriptions' });
              res.end();
              return;
            }
            const contentType = req.headers['content-type'] ?? '';
            const form = await new Request('http://fixture', {
              method: 'POST',
              headers: { 'content-type': contentType },
              body: Buffer.concat(chunks),
            }).formData();
            const file = form.get('file');
            lastRequest = {
              url: req.url,
              authorization: req.headers.authorization,
              contentType,
              file:
                file instanceof File
                  ? {
                      name: file.name,
                      type: file.type,
                      bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
                    }
                  : null,
              model: stringEntry(form.get('model')),
              responseFormat: stringEntry(form.get('response_format')),
              granularities: form
                .getAll('timestamp_granularities[]')
                .filter((value): value is string => typeof value === 'string'),
              keys: [...form.keys()],
            };
            res.writeHead(asrResponse.status, { 'content-type': asrResponse.contentType });
            res.end(asrResponse.body);
          } catch (error) {
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end(String(error));
          }
        })();
      });
    });
    await new Promise<void>((resolve) => asrServer.listen(0, '127.0.0.1', resolve));
    const address = asrServer.address();
    if (!address || typeof address === 'string') throw new Error('ASR fixture did not bind');
    asrBaseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    asrServer.closeAllConnections();
    await new Promise<void>((resolve) => asrServer.close(() => resolve()));
  });

  beforeEach(() => {
    asrResponse = { status: 200, body: '{"text":"ok"}', contentType: 'application/json' };
    asrRedirectHits = 0;
    hangReached = undefined;
    lastRequest = null;
  });

  const transcribeWithBody = async (body: string, contentType = 'application/json') => {
    asrResponse = { status: 200, body, contentType };
    return transcribeAudio(profile(), input());
  };

  it('posts multipart fields, bytes and auth without appending to the endpoint', async () => {
    asrResponse = {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        text: '你好世界',
        duration: 1.234,
        segments: [
          { start: 0, end: 0.5, text: '你好' },
          { start: 0.5, end: 1.234, text: '世界' },
        ],
      }),
    };

    const transcript = await transcribeAudio(profile(), input());

    expect(transcript).toEqual({
      text: '你好世界',
      durationMs: 1234,
      segments: [
        { text: '你好', timeFromMs: 0, timeToMs: 500 },
        { text: '世界', timeFromMs: 500, timeToMs: 1234 },
      ],
    });
    expect(lastRequest?.url).toBe('/v1/audio/transcriptions');
    expect(lastRequest?.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(lastRequest?.authorization).toBe('Bearer secret');
    expect(lastRequest?.keys).toEqual([
      'file',
      'model',
      'response_format',
      'timestamp_granularities[]',
    ]);
    expect(lastRequest?.file).toEqual({
      name: '纪要 01.mp3',
      type: 'audio/mpeg',
      bytes: Array.from(audio),
    });
    expect(lastRequest?.model).toBe('whisper-1');
    expect(lastRequest?.responseFormat).toBe('verbose_json');
    expect(lastRequest?.granularities).toEqual(['segment']);
  });

  it('omits authorization when no api key is configured', async () => {
    await transcribeAudio({ endpointUrl: profile().endpointUrl, model: 'whisper-1' }, input());
    expect(lastRequest?.authorization).toBeUndefined();
  });

  it('returns a text-only transcript without inventing timing', async () => {
    await expect(transcribeWithBody(JSON.stringify({ text: '只有文本' }))).resolves.toEqual({
      text: '只有文本',
      durationMs: null,
      segments: [],
    });
  });

  it('accepts zero and overlapping times and rounds seconds to milliseconds', async () => {
    const transcript = await transcribeWithBody(
      JSON.stringify({
        text: 'x',
        duration: 0,
        segments: [
          { start: 0, end: 0.0004, text: 'a' },
          { start: 0, end: 0.0006, text: 'b' },
          { start: 0.0006, end: 1.5, text: 'c' },
        ],
      }),
    );

    expect(transcript.durationMs).toBe(0);
    expect(transcript.segments).toEqual([
      { text: 'a', timeFromMs: 0, timeToMs: 0 },
      { text: 'b', timeFromMs: 0, timeToMs: 1 },
      { text: 'c', timeFromMs: 1, timeToMs: 1500 },
    ]);
  });

  it.each([
    ['missing text', '{}'],
    ['non-string text', '{"text":null}'],
    ['negative duration', '{"text":"x","duration":-1}'],
    ['string duration', '{"text":"x","duration":"1"}'],
    ['non-finite duration', '{"text":"x","duration":1e999}'],
    ['unsafe duration milliseconds', '{"text":"x","duration":1e13}'],
    ['non-array segments', '{"text":"x","segments":{}}'],
    ['null segments', '{"text":"x","segments":null}'],
    ['missing start', '{"text":"x","segments":[{"end":1,"text":"a"}]}'],
    ['missing end', '{"text":"x","segments":[{"start":0,"text":"a"}]}'],
    ['string start', '{"text":"x","segments":[{"start":"0","end":1,"text":"a"}]}'],
    ['negative start', '{"text":"x","segments":[{"start":-0.1,"end":1,"text":"a"}]}'],
    ['reversed segment', '{"text":"x","segments":[{"start":1,"end":0.5,"text":"a"}]}'],
    [
      'decreasing starts',
      '{"text":"x","segments":[{"start":1,"end":2,"text":"a"},{"start":0.5,"end":2,"text":"b"}]}',
    ],
    ['non-finite segment time', '{"text":"x","segments":[{"start":1e999,"end":1e999,"text":"a"}]}'],
    ['unsafe segment milliseconds', '{"text":"x","segments":[{"start":0,"end":1e13,"text":"a"}]}'],
    ['non-string segment text', '{"text":"x","segments":[{"start":0,"end":1,"text":1}]}'],
    ['missing segment text', '{"text":"x","segments":[{"start":0,"end":1}]}'],
    ['non-object payload', '[]'],
  ])('maps %s to a non-retryable bad response', async (_label, body) => {
    await expect(transcribeWithBody(body)).rejects.toMatchObject({ kind: 'bad_response' });
  });

  it('maps a non-json success body to bad_response', async () => {
    await expect(transcribeWithBody('not json', 'text/plain')).rejects.toMatchObject({
      kind: 'bad_response',
    });
  });

  it('classifies a success body interrupted in transit as unavailable', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"text":"'));
            queueMicrotask(() => controller.error(new TypeError('terminated')));
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    try {
      await expect(transcribeAudio(profile(), input())).rejects.toMatchObject({
        kind: 'unavailable',
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('keeps a timeout while reading the success body retryable', async () => {
    const deadline = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"text":"'));
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
            queueMicrotask(() => deadline.abort(new DOMException('timed out', 'TimeoutError')));
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    try {
      await expect(transcribeAudio(profile(), input())).rejects.toMatchObject({ kind: 'timeout' });
    } finally {
      fetchSpy.mockRestore();
      timeoutSpy.mockRestore();
    }
  });

  it('propagates caller cancellation while reading the success body', async () => {
    const caller = new AbortController();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"text":"'));
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
            queueMicrotask(() => caller.abort());
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    try {
      let error: unknown;
      try {
        await transcribeAudio(profile(), input(), caller.signal);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ name: 'AbortError' });
      expect(error).not.toBeInstanceOf(KnowledgeModelError);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('keeps a success body cut off by a real socket close retryable', async () => {
    let headersSeen!: () => void;
    const sawHeaders = new Promise<void>((resolve) => {
      headersSeen = resolve;
    });
    let drop: (() => void) | undefined;
    const cutoffServer = createServer((request, response) => {
      request.resume();
      drop = () => response.destroy();
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
      response.write('{"text":"partial');
    });
    await new Promise<void>((resolve) => cutoffServer.listen(0, '127.0.0.1', resolve));
    const realFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
      const response = await realFetch(...args);
      headersSeen();
      return response;
    });
    try {
      const address = cutoffServer.address();
      if (!address || typeof address === 'string') throw new Error('cutoff fixture did not bind');
      const pending = transcribeAudio(
        { endpointUrl: `http://127.0.0.1:${address.port}/cutoff`, model: 'whisper-1' },
        input(),
      );
      const assertion = expect(pending).rejects.toMatchObject({ kind: 'unavailable' });
      await sawHeaders;
      drop?.();
      await assertion;
    } finally {
      fetchSpy.mockRestore();
      cutoffServer.closeAllConnections();
      await new Promise<void>((resolve) => cutoffServer.close(() => resolve()));
    }
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limit'],
    [408, 'unavailable'],
    [500, 'unavailable'],
    [502, 'unavailable'],
    [400, 'bad_response'],
    [415, 'bad_response'],
  ])('classifies HTTP %i as %s', async (status, kind) => {
    asrResponse = { status, body: '{}', contentType: 'application/json' };
    await expect(transcribeAudio(profile(), input())).rejects.toMatchObject({ kind });
  });

  it('does not follow redirects with credentials attached', async () => {
    await expect(
      transcribeAudio({ ...profile(), endpointUrl: `${asrBaseUrl}/redirect` }, input()),
    ).rejects.toMatchObject({ kind: 'bad_response' });
    expect(asrRedirectHits).toBe(1);
  });

  it('rejects an unsupported audio mime before making any request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(
        transcribeAudio(profile(), { ...input(), mimeType: 'audio/x-caf' }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('propagates caller cancellation instead of classifying it as timeout', async () => {
    const controller = new AbortController();
    const pending = transcribeAudio(
      { endpointUrl: `${asrBaseUrl}/hang`, model: 'whisper-1' },
      input(),
      controller.signal,
    );
    await new Promise<void>((resolve) => {
      hangReached = resolve;
    });
    controller.abort();

    let error: unknown;
    try {
      await pending;
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(error).not.toBeInstanceOf(KnowledgeModelError);
  });

  it('uses the 300 second ASR timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new DOMException('timed out', 'AbortError'));
    try {
      await expect(
        transcribeAudio({ endpointUrl: 'https://example.invalid', model: 'm' }, input()),
      ).rejects.toMatchObject({ kind: 'timeout' });
      expect(timeoutSpy).toHaveBeenCalledWith(300_000);
    } finally {
      fetchSpy.mockRestore();
      timeoutSpy.mockRestore();
    }
  });

  it('lets caller abort win when both caller and timeout are aborted', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new DOMException('caller cancelled', 'AbortError'));
    try {
      let error: unknown;
      try {
        await transcribeAudio(
          { endpointUrl: 'https://example.invalid', model: 'm' },
          input(),
          AbortSignal.abort(),
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ name: 'AbortError' });
      expect(error).not.toBeInstanceOf(KnowledgeModelError);
    } finally {
      fetchSpy.mockRestore();
      timeoutSpy.mockRestore();
    }
  });
});
