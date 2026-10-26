import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type EmbeddingProfile,
  embedImages,
  embedTexts,
  KnowledgeModelError,
  type RerankProfile,
  rerankDocuments,
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
